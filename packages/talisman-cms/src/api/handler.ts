import type { APIRoute } from 'astro';
import { createDbClient, type TalismanEnv } from '../db/client';
import * as schema from '../db/schema';
import { authorizeCmsRequest } from '../auth/guard';
import { canAccessCollection, type CollectionOperation } from '../auth/collection-access';
import { collections as configCollections, globals as configGlobals, publishing } from 'virtual:talisman-cms/config';
import { uiLibraries as configuredUiLibraries } from 'virtual:talisman-cms/ui-libraries';
import { nativeSchemas } from 'virtual:talisman-cms/native-schemas';
import { collectionHooks } from 'virtual:talisman-cms/collection-hooks';
import {
  buildZodSchemaForCollection,
  buildZodSchemaForFields,
  decodeGlobalData,
  describeInvalidEntryId,
  describeInvalidEntrySlug,
  findUnwritableNativeColumns,
  formatValidationIssues,
  generateFieldsFromDrizzle,
  getNativeIdColumn,
  isGlobalData,
  pickConfiguredNativeFields,
  prepareNativeWritePayload,
  type CollectionHooks,
  type FieldValidationIssue
} from '../types';
import { validatePresetPayload } from '../presets';
import { eq, desc, and, or, lt, count, isNull, sql, getTableColumns } from 'drizzle-orm';
import {
  assertPublishableSlug,
  createDraftEntry,
  getEntryRevision,
  getLatestRevision,
  invalidateEntryCache,
  isEntryNotFound,
  isRevisionConflict,
  isSlugConflict,
  listEntryRevisions,
  restoreEntryRevision,
  saveDraftEntry,
  toEditableEntry,
  triggerPublishingWorkflow
} from '../versioning';

function mapNativeEntry(row: any, collectionId: string, nativeIdCol: string) {
  const resolvedId = row?.[nativeIdCol] ?? row?.id ?? '';

  return {
    id: resolvedId,
    collectionId,
    slug: row?.slug || resolvedId || '',
    status: typeof row?.status === 'string' ? row.status : 'published',
    data: row,
    createdAt: row?.createdAt || new Date(),
    updatedAt: row?.updatedAt || new Date()
  };
}

const NATIVE_RECORD_CONFLICT_MESSAGE = 'This record changed since it was opened. Reload it before saving.';

function validationErrorResponse(issues: FieldValidationIssue[], extra?: Record<string, unknown>) {
  return Response.json({ ...formatValidationIssues(issues), ...extra }, { status: 400 });
}

function withDecodedGlobalData<T extends { data?: unknown }>(record: T) {
  return { ...record, data: decodeGlobalData(record.data) };
}

/** Compares an updatedAt read from D1 with the JSON value an editor loaded (an ISO string for dates). */
function timestampKey(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Date.parse(value))) return Date.parse(value);
  return value ?? null;
}

/** A client error with its status; anything else becomes a generic 500 (see errorResponse). */
class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Wraps an error thrown by a collection hook, whose message is written for editors. */
class HookError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'A collection hook failed', { cause });
    this.name = 'HookError';
  }
}

const INTERNAL_ERROR_MESSAGE = 'The request could not be completed. Check the server logs for details.';

/** Drizzle reports a failed statement as "Failed query: <sql> params: <values>"; D1 adds its own prefix. */
function isDatabaseError(error: unknown): boolean {
  for (let current: any = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    const message = typeof current.message === 'string' ? current.message : '';
    if (current.name === 'DrizzleQueryError' || message.startsWith('Failed query:') || /D1_ERROR|SQLITE_/.test(message)) {
      return true;
    }
  }
  return false;
}

/** Turns a SQLite constraint failure into a message without the statement or its values. */
function describeConstraintError(error: unknown): { status: number; error: string } | null {
  for (let current: any = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    const message = typeof current.message === 'string' ? current.message : '';
    // The statement text of a DrizzleQueryError holds the submitted values, so only its cause is read.
    if (message.startsWith('Failed query:')) continue;
    const columns = message.match(/constraint failed: ([\w.]+(?:, [\w.]+)*)/)?.[1]
      ?.split(', ').map((column: string) => column.split('.').pop()).join(', ');
    if (/UNIQUE constraint failed/i.test(message)) {
      return { status: 409, error: columns ? `Another record already uses this ${columns}.` : 'Another record already uses this value.' };
    }
    if (/NOT NULL constraint failed/i.test(message)) {
      return { status: 400, error: columns ? `A value is required for ${columns}.` : 'A required value is missing.' };
    }
    if (/FOREIGN KEY constraint failed/i.test(message)) {
      return { status: 409, error: 'This change conflicts with a related record.' };
    }
    if (/CHECK constraint failed/i.test(message)) {
      return { status: 400, error: 'A value is not allowed.' };
    }
    if (/SQLITE_TOOBIG|string or blob too big/i.test(message)) {
      return { status: 413, error: 'This content is too large to store.' };
    }
  }
  return null;
}

/**
 * Client mistakes get a 4xx with a message for editors. Other failures are logged and answered
 * with a generic 500, since database errors carry the SQL statement and the submitted values.
 */
function errorResponse(error: unknown, context: string) {
  if (error instanceof HttpError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (isRevisionConflict(error) || isSlugConflict(error)) {
    return Response.json({ error: (error as Error).message }, { status: 409 });
  }
  if (isEntryNotFound(error)) {
    return Response.json({ error: (error as Error).message }, { status: 404 });
  }

  const constraint = describeConstraintError(error);
  if (constraint) {
    return Response.json({ error: constraint.error }, { status: constraint.status });
  }

  console.error(`[talisman-cms] ${context}:`, error);
  const message = error instanceof HookError && !isDatabaseError(error) ? error.message : INTERNAL_ERROR_MESSAGE;
  return Response.json({ status: 'error', error: message, message }, { status: 500 });
}

function wrapCollectionHooks(hooks: CollectionHooks | undefined): CollectionHooks | undefined {
  if (!hooks) return hooks;
  const wrap = (list: ((args: any) => any)[] | undefined) => list?.map((hook) => async (args: any) => {
    try {
      return await hook(args);
    } catch (error) {
      throw new HookError(error);
    }
  });

  return {
    beforeValidate: wrap(hooks.beforeValidate),
    beforeChange: wrap(hooks.beforeChange),
    afterChange: wrap(hooks.afterChange),
    beforeDelete: wrap(hooks.beforeDelete),
    afterDelete: wrap(hooks.afterDelete),
  };
}

// D1 rows are capped near 2 MB and every save also stores a revision copy of the data.
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

async function readJsonBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > MAX_REQUEST_BODY_BYTES) {
    throw new HttpError(413, 'The request body is too large.');
  }
  const text = await request.text();
  if (text.length > MAX_REQUEST_BODY_BYTES) {
    throw new HttpError(413, 'The request body is too large.');
  }
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

async function readJsonObject(request: Request) {
  const body = await readJsonBody(request);
  if (!isGlobalData(body)) throw new HttpError(400, 'The request body must be a JSON object.');
  return body;
}

/** Entry data may also arrive as JSON text; either way it must be an object. */
function readEntryData(data: unknown): Record<string, any> {
  let value = data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new HttpError(400, 'Entry data is not valid JSON.');
    }
  }
  if (!isGlobalData(value)) throw new HttpError(400, 'Entry data must be a JSON object.');
  return value;
}

/** Path segments arrive percent-encoded; lookups use the decoded id. */
function decodePathSegment(segment: string) {
  let value: string;
  try {
    value = decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'The entry id in the path is not valid.');
  }
  if (value.length > 512) throw new HttpError(400, 'The entry id in the path is too long.');
  return value;
}

function invalidInput(message: string, path: PropertyKey[] = []) {
  return validationErrorResponse([{ path, message }]);
}

const isBlank = (value: unknown) => value === undefined || value === null || value === '';

/** Columns the server sets itself; a client may send them back, and they are dropped. */
function nativeSystemColumns(collectionConfig: (typeof configCollections)[number]) {
  return [getNativeIdColumn(collectionConfig), 'createdAt', 'updatedAt'];
}

function unwritableColumnsResponse(columns: string[]) {
  return validationErrorResponse(columns.map((column) => ({
    path: [column],
    message: 'Not a field of this collection, so it cannot be saved here'
  })));
}

/** A native id may be a whole number (integer keys) or text in the entry id format. */
function describeInvalidNativeId(value: unknown) {
  if (isBlank(value)) return null;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? null : 'Record id must be a whole number or text';
  return describeInvalidEntryId(value);
}

const MAX_PAGE_SIZE = 200;

/** `limit` (1-200) asks for one page and `cursor` continues after the previous one. Null means the whole list. */
function readPageRequest(url: URL) {
  const limitParam = url.searchParams.get('limit');
  const cursor = url.searchParams.get('cursor');
  if (limitParam === null) {
    if (cursor !== null) throw new HttpError(400, 'cursor needs a limit.');
    return null;
  }

  const limit = Number(limitParam);
  if (!/^\d+$/.test(limitParam) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new HttpError(400, `limit must be a whole number from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return { limit, cursor: cursor || null };
}

function encodeCursor(position: unknown[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(position));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string): unknown[] {
  try {
    const binary = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const position = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
    if (Array.isArray(position)) return position;
  } catch {
    // Reported below.
  }
  throw new HttpError(400, 'The cursor is not valid.');
}

const MEDIA_SCHEMA_PATH = 'talisman-cms/db/media';
// Set by the upload from the stored file; changing them would repoint or relabel the asset.
const UPLOAD_MANAGED_MEDIA_FIELDS = ['url', 'mimeType'];

function isSystemMediaCollection(collectionConfig: { nativeSchemaMapping?: { schemaPath?: string } }) {
  return collectionConfig.nativeSchemaMapping?.schemaPath === MEDIA_SCHEMA_PATH;
}

/** Work that should run once per isolate and D1 database, keyed by the binding. */
function oncePerDatabase(runs: WeakMap<object, Promise<void>>, binding: unknown, run: () => Promise<void>) {
  const key = binding && typeof binding === 'object' ? binding : null;
  if (!key) return run();

  let pending = runs.get(key);
  if (!pending) {
    pending = run();
    runs.set(key, pending);
    // A failed run is retried by the next request.
    pending.catch(() => runs.delete(key));
  }
  return pending;
}

function configuredCollectionFields(collectionConfig: (typeof configCollections)[number]) {
  const fields = collectionConfig.fields || [];
  if (fields.length === 0 && collectionConfig.nativeSchemaMapping && nativeSchemas[collectionConfig.slug]) {
    return generateFieldsFromDrizzle(nativeSchemas[collectionConfig.slug]);
  }
  return fields;
}

const collectionSyncs = new WeakMap<object, Promise<void>>();

/**
 * Entries reference a galaxy_collections row per configured collection, which also mirrors its
 * name and fields. The sync reads every row once per isolate and writes only rows that are
 * missing or changed, in one batch, so admin reads do not rewrite the table.
 */
function syncCollectionDefinitions(db: ReturnType<typeof createDbClient>, binding: unknown) {
  return oncePerDatabase(collectionSyncs, binding, async () => {
    const stored = await db.select({
      id: schema.collections.id,
      slug: schema.collections.slug,
      name: schema.collections.name,
      fields: schema.collections.fields,
    }).from(schema.collections);
    const storedBySlug = new Map(stored.map((row) => [row.slug, row]));
    const now = new Date();
    const missing: (typeof schema.collections.$inferInsert)[] = [];
    const writes: any[] = [];

    for (const collectionConfig of configCollections) {
      const fields = configuredCollectionFields(collectionConfig);
      const row = storedBySlug.get(collectionConfig.slug);
      if (!row) {
        missing.push({ id: crypto.randomUUID(), name: collectionConfig.name, slug: collectionConfig.slug, fields, createdAt: now });
      } else if (row.name !== collectionConfig.name || JSON.stringify(row.fields) !== JSON.stringify(fields)) {
        writes.push(db.update(schema.collections).set({ name: collectionConfig.name, fields }).where(eq(schema.collections.id, row.id)));
      }
    }

    // Ten rows of five values stay under D1's 100 bound parameters per statement.
    for (let index = 0; index < missing.length; index += 10) {
      writes.push(db.insert(schema.collections).values(missing.slice(index, index + 10))
        .onConflictDoNothing({ target: schema.collections.slug }));
    }

    if (writes.length > 0) await db.batch(writes as [any, ...any[]]);
  });
}

/** Row counts for native tables in one statement, since D1 limits the queries per request. */
async function countNativeRows(db: ReturnType<typeof createDbClient>, collections: typeof configCollections) {
  const counts = new Map<string, number>();
  const counted = collections.filter((collection) => collection.nativeSchemaMapping && nativeSchemas[collection.slug]);
  if (counted.length === 0) return counts;

  try {
    const row = await db.get<Record<string, unknown>>(sql`SELECT ${sql.join(counted.map((collection, index) =>
      sql`(SELECT count(*) FROM ${nativeSchemas[collection.slug]}) AS ${sql.identifier(`c${index}`)}`), sql`, `)}`);
    counted.forEach((collection, index) => counts.set(collection.slug, Number(row?.[`c${index}`] ?? 0)));
  } catch (error) {
    console.error('[talisman-cms] Could not count native collection rows:', error);
  }
  return counts;
}

/**
 * An entry with revisions must name the latest one it was loaded with; without one the result is
 * undefined (answer 428). An entry loaded without revisions (seeded straight into D1) may send null
 * or nothing: its first versioned write records a baseline revision.
 */
async function resolveExpectedRevisionId(db: ReturnType<typeof createDbClient>, entryId: string, value: unknown) {
  if (typeof value === 'string' && value) return value;
  if (value === null) return null;
  return await getLatestRevision(db as any, entryId) ? undefined : null;
}

function validateCollectionPayload(slug: string, data: Record<string, any>) {
  if (slug !== '_ui_component_presets') {
    return {
      success: true as const,
      data,
    };
  }

  const result = validatePresetPayload(configuredUiLibraries as any, data);
  if (!result.success) {
    return result;
  }

  return {
    success: true as const,
    data: result.normalizedData,
  };
}

async function resolveCollectionContext(db: ReturnType<typeof createDbClient>, slug: string, binding: unknown) {
  const configuredCollection = configCollections.find(c => c.slug === slug);
  const collectionConfig = configuredCollection
    ? { ...configuredCollection, hooks: wrapCollectionHooks(collectionHooks[slug]) }
    : undefined;
  if (!collectionConfig) {
    throw new HttpError(404, `Collection ${slug} not found`);
  }

  await syncCollectionDefinitions(db, binding);
  let collection = await db.query.collections.findFirst({
    // @ts-ignore
    where: (c, { eq }) => eq(c.slug, slug)
  });

  const activeFields = configuredCollectionFields(collectionConfig);

  if (!collection) {
    const id = Date.now().toString() + '-' + Math.random().toString(36).substring(7);
    const createdAt = new Date();

    await db.insert(schema.collections).values({
      id,
      name: collectionConfig.name,
      slug: collectionConfig.slug,
      fields: activeFields,
      createdAt
    }).onConflictDoNothing({ target: schema.collections.slug });

    collection = await db.query.collections.findFirst({
      // @ts-ignore
      where: (c, { eq }) => eq(c.slug, slug)
    });
    if (!collection) throw new Error(`Collection ${slug} could not be initialized`);
  }

  const nativeTable = collectionConfig.nativeSchemaMapping && nativeSchemas[slug] ? nativeSchemas[slug] : null;
  const nativeIdCol = collectionConfig.nativeSchemaMapping?.idColumn || 'id';

  return {
    collection,
    collectionConfig,
    activeFields,
    nativeTable,
    nativeIdCol,
  };
}

const globalSyncs = new WeakMap<object, Promise<void>>();

/** Creates the configured globals' rows and mirrors their names, once per isolate. */
function syncConfiguredGlobals(db: ReturnType<typeof createDbClient>, binding: unknown) {
  return oncePerDatabase(globalSyncs, binding, () => writeConfiguredGlobals(db));
}

async function writeConfiguredGlobals(db: ReturnType<typeof createDbClient>) {
  for (const globalConfig of configGlobals) {
    const existing = await db.query.globals.findFirst({
      // @ts-ignore
      where: (g, { eq }) => eq(g.slug, globalConfig.slug)
    });

    if (!existing) {
      const now = new Date();
      await db.insert(schema.globals).values({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        name: globalConfig.name,
        slug: globalConfig.slug,
        description: globalConfig.description || null,
        data: {},
        createdAt: now,
        updatedAt: now,
      });
      continue;
    }

    const nextDescription = globalConfig.description || null;
    if (existing.name !== globalConfig.name || (existing.description || null) !== nextDescription) {
      await db.update(schema.globals).set({
        name: globalConfig.name,
        description: nextDescription,
      }).where(eq(schema.globals.id, existing.id));
    }
  }
}

async function resolveGlobalContext(db: ReturnType<typeof createDbClient>, slug: string) {
  const globalConfig = configGlobals.find((candidate) => candidate.slug === slug) || null;

  let globalRecord = await db.query.globals.findFirst({
    // @ts-ignore
    where: (g, { eq }) => eq(g.slug, slug)
  });

  if (!globalRecord && globalConfig) {
    const now = new Date();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    await db.insert(schema.globals).values({
      id,
      name: globalConfig.name,
      slug: globalConfig.slug,
      description: globalConfig.description || null,
      data: {},
      createdAt: now,
      updatedAt: now,
    });

    globalRecord = await db.query.globals.findFirst({
      // @ts-ignore
      where: (g, { eq }) => eq(g.slug, slug)
    });
  } else if (globalRecord && globalConfig) {
    const nextDescription = globalConfig.description || null;
    if (globalRecord.name !== globalConfig.name || (globalRecord.description || null) !== nextDescription) {
      await db.update(schema.globals).set({
        name: globalConfig.name,
        description: nextDescription,
      }).where(eq(schema.globals.id, globalRecord.id));

      globalRecord = {
        ...globalRecord,
        name: globalConfig.name,
        description: nextDescription,
      };
    }
  }

  return {
    globalConfig,
    globalRecord,
  };
}

export const ALL: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // Basic health check to verify routing and data connection
  if (path.endsWith('/api/health')) {
    try {
      // In Astro 6, bindings are accessed via `cloudflare:workers`
      const { env } = await import('cloudflare:workers');
      const db = createDbClient(env as any);
      
      // Test the connection
      await db.run('SELECT 1');
      return new Response(JSON.stringify({ status: 'ok', d1: 'connected' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e: any) {
      // This route answers before authentication, so binding and driver errors stay in the logs.
      console.error('[talisman-cms] Health check failed:', e);
      return new Response(JSON.stringify({ status: 'error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // --- Auth Guard ---
  // Ensure an adapter is registered and the request is authenticated
  const adminOnly = request.method === 'DELETE' ||
    (request.method === 'POST' && /\/api\/collections\/[^/]+\/entries\/[^/]+\/(publish|archive)$/.test(path)) ||
    (request.method === 'POST' && /\/api\/collections\/[^/]+\/entries\/[^/]+\/revisions\/[^/]+\/restore$/.test(path)) ||
    (request.method === 'POST' && path.endsWith('/api/globals'));
  const authorization = await authorizeCmsRequest(request, adminOnly ? 'admin' : undefined);
  if (authorization.response) return authorization.response;
  const user = authorization.user;

  // Get all registered collections
  if (path.endsWith('/api/collections')) {
    try {
      const { env } = await import('cloudflare:workers');
      const db = createDbClient(env as any);

      // A few statements whatever the number of collections: the rows are synced once per isolate,
      // then read in one query, with one count for entries and one for every native table.
      await syncCollectionDefinitions(db, (env as any).DB);
      const visibleCollections = configCollections.filter(col => canAccessCollection(col, user, 'read'));
      const persistedCollections = await db.select({
        id: schema.collections.id,
        slug: schema.collections.slug,
        createdAt: schema.collections.createdAt,
      }).from(schema.collections);
      const persistedBySlug = new Map(persistedCollections.map(collection => [collection.slug, collection]));

      const entryCounts = await db.select({
        collectionId: schema.entries.collectionId,
        total: count()
      }).from(schema.entries).groupBy(schema.entries.collectionId);
      const entryCountById = new Map(entryCounts.map(row => [row.collectionId, row.total]));
      const nativeCountBySlug = await countNativeRows(db, visibleCollections);

      // Return the config collections augmented with persisted metadata and generated fields.
      const augmentedCollections = visibleCollections.map(c => {
        const persisted = persistedBySlug.get(c.slug);
        const itemCount = c.nativeSchemaMapping
          ? nativeCountBySlug.get(c.slug) ?? null
          : persisted ? entryCountById.get(persisted.id) ?? 0 : 0;
        if ((!c.fields || c.fields.length === 0) && c.nativeSchemaMapping && nativeSchemas[c.slug]) {
          return { ...c, id: persisted?.id, createdAt: persisted?.createdAt, itemCount, fields: configuredCollectionFields(c) };
        }
        return { ...c, id: persisted?.id, createdAt: persisted?.createdAt, itemCount };
      });
      
      return new Response(JSON.stringify(augmentedCollections), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e: any) {
      return errorResponse(e, 'Error in /api/collections');
    }
  }

  // --- Globals API ---
  const globalsMatch = path.match(/\/api\/globals(?:\/([^/]+))?$/);
  if (globalsMatch) {
    const slug = globalsMatch[1];
    
    try {
      const { env } = await import('cloudflare:workers') as unknown as { env: TalismanEnv };
      // @ts-ignore - Drizzle ORM types can be strict with the D1 env wrapper
      const db = createDbClient(env as any);

      if (request.method === 'GET') {
        if (!slug) {
          await syncConfiguredGlobals(db, env.DB);
          const allGlobals = await db.query.globals.findMany();
          const configuredOrder = new Map(configGlobals.map((globalConfig, index) => [globalConfig.slug, index]));
          const list = allGlobals
            .map(g => ({ ...g, data: undefined }))
            .sort((left, right) => {
              const leftOrder = configuredOrder.get(left.slug);
              const rightOrder = configuredOrder.get(right.slug);

              if (leftOrder !== undefined && rightOrder !== undefined) {
                return leftOrder - rightOrder;
              }

              if (leftOrder !== undefined) return -1;
              if (rightOrder !== undefined) return 1;

              return left.name.localeCompare(right.name);
            });

          return new Response(JSON.stringify(list), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        } else {
          const { globalRecord: globalObj } = await resolveGlobalContext(db, slug);
          if (!globalObj) return new Response(JSON.stringify({ error: 'Global not found' }), { status: 404 });
          return new Response(JSON.stringify(withDecodedGlobalData(globalObj)), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      } 
      
      if (request.method === 'POST') {
        if (!slug) {
          const body = await readJsonObject(request);
          const requestedSlug = typeof body.slug === 'string' ? body.slug.trim() : '';
          const requestedName = typeof body.name === 'string' ? body.name.trim() : '';

          if (!requestedSlug) {
            return new Response(JSON.stringify({ error: 'Slug is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
          }

          const existing = await db.query.globals.findFirst({
            // @ts-ignore
            where: (g, { eq }) => eq(g.slug, requestedSlug)
          });

          if (existing) {
            return new Response(JSON.stringify({ error: 'A global with this slug already exists' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
          }

          const now = new Date();
          const created = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            name: requestedName || requestedSlug,
            slug: requestedSlug,
            description: typeof body.description === 'string' && body.description.trim().length > 0 ? body.description.trim() : null,
            data: isGlobalData(body.data) ? body.data : {},
            createdAt: now,
            updatedAt: now,
          };

          await db.insert(schema.globals).values(created);

          if (env.KV) {
            await env.KV.delete('talisman:globals:all');
            await env.KV.delete(`talisman:globals:${requestedSlug}`);
          }

          return new Response(JSON.stringify(created), { status: 201, headers: { 'Content-Type': 'application/json' } });
        }
        
        let data = await readJsonBody(request);
        if (!isGlobalData(data)) {
          return Response.json({ error: 'Global data must be a JSON object', fieldErrors: {} }, { status: 400 });
        }
        const { globalConfig, globalRecord: existing } = await resolveGlobalContext(db, slug);
        // Saving to a slug that is neither configured nor stored would create a global, which
        // POST /api/globals keeps to administrators.
        if (!globalConfig && !existing && user.role !== 'admin') {
          return Response.json({ error: 'Only administrators can create globals' }, { status: 403 });
        }

        if (globalConfig?.fields?.length) {
          const parsed = buildZodSchemaForFields(globalConfig.fields).safeParse(data);
          if (!parsed.success) {
            return validationErrorResponse(parsed.error.issues, { details: parsed.error.flatten() });
          }

          data = parsed.data;
        }
        
        const id = existing?.id || (Date.now().toString() + '-' + Math.random().toString(36).substring(7));
        const now = new Date();

        await db.insert(schema.globals).values({
          id,
          name: globalConfig?.name || existing?.name || slug,
          slug,
          description: globalConfig?.description || existing?.description || null,
          data,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: schema.globals.slug,
          set: {
            name: globalConfig?.name || existing?.name || slug,
            description: globalConfig?.description || existing?.description || null,
            data,
            updatedAt: now
          }
        });

        const updated = await db.query.globals.findFirst({
          // @ts-ignore
          where: (g: any, { eq }: any) => eq(g.slug, slug)
        });

        if (env.KV) {
          await env.KV.delete('talisman:globals:all');
          await env.KV.delete(`talisman:globals:${slug}`);
        }

        return new Response(JSON.stringify(updated && withDecodedGlobalData(updated)), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    } catch (e: any) {
      return errorResponse(e, 'Error in /api/globals');
    }
  }

  const revisionsMatch = path.match(/\/api\/collections\/([^/]+)\/entries\/([^/]+)\/revisions(?:\/([^/]+)(\/restore)?)?$/);
  if (revisionsMatch) {
    const slug = revisionsMatch[1];
    const isRestore = Boolean(revisionsMatch[4]);

    try {
      const entryId = decodePathSegment(revisionsMatch[2]);
      const revisionId = revisionsMatch[3] ? decodePathSegment(revisionsMatch[3]) : undefined;
      const { env } = await import('cloudflare:workers') as unknown as { env: TalismanEnv };
      // @ts-ignore
      const db = createDbClient(env as any);
      const { collection, collectionConfig, nativeTable } = await resolveCollectionContext(db, slug, env.DB);

      if (!canAccessCollection(collectionConfig, user, request.method === 'GET' ? 'read' : 'update') ||
        (request.method !== 'GET' && collectionConfig.readOnly)) {
        return Response.json({ error: 'Collection access denied' }, { status: 403 });
      }

      if (nativeTable) {
        return new Response(JSON.stringify({ error: 'Revision history is not available for native collections' }), { status: 400 });
      }

      if (request.method === 'GET' && !revisionId) {
        // The history lists metadata; a revision's data is loaded on its own or with ?includeData=true.
        const includeData = ['1', 'true'].includes(url.searchParams.get('includeData') ?? '');
        const page = readPageRequest(url);
        if (page?.cursor) throw new HttpError(400, 'Revision lists take a limit but no cursor.');
        const revisions = await listEntryRevisions(db as any, collection!.id, entryId, { includeData, limit: page?.limit });
        return new Response(JSON.stringify(revisions), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (request.method === 'GET' && revisionId && !isRestore) {
        const revision = await getEntryRevision(db as any, collection!.id, entryId, revisionId);
        return new Response(JSON.stringify(revision), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (request.method === 'POST' && revisionId && isRestore) {
        const body = await request.json().catch(() => ({})) as { expectedRevisionId?: unknown };
        if (typeof body.expectedRevisionId !== 'string' || !body.expectedRevisionId) {
          return Response.json({ error: 'expectedRevisionId is required' }, { status: 428 });
        }
        const restored = await restoreEntryRevision(db as any, collection as any, entryId, revisionId, body.expectedRevisionId);
        await invalidateEntryCache(env, slug, entryId);
        return new Response(JSON.stringify(toEditableEntry(restored)), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    } catch (e: any) {
      return errorResponse(e, 'Error in the revisions API');
    }
  }

  const transitionMatch = path.match(/\/api\/collections\/([^/]+)\/entries\/([^/]+)\/(publish|archive)$/);
  if (transitionMatch) {
    const slug = transitionMatch[1];
    const action = transitionMatch[3] as 'publish' | 'archive';

    try {
      const entryId = decodePathSegment(transitionMatch[2]);
      const { env } = await import('cloudflare:workers') as unknown as { env: TalismanEnv };
      // @ts-ignore
      const db = createDbClient(env as any);
      const { collection, collectionConfig, activeFields, nativeTable } = await resolveCollectionContext(db, slug, env.DB);

      if (!canAccessCollection(collectionConfig, user, 'update') || collectionConfig.readOnly) {
        return Response.json({ error: 'Collection access denied' }, { status: 403 });
      }

      if (nativeTable) {
        return new Response(JSON.stringify({ error: 'Publishing workflows are not available for native collections' }), { status: 400 });
      }

      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
      }

      const body = await request.json().catch(() => ({})) as { expectedRevisionId?: unknown };
      const entry = await db.query.entries.findFirst({
        // @ts-ignore
        where: (e: any, { eq, and }: any) => and(eq(e.collectionId, collection!.id), eq(e.id, entryId))
      });
      if (!entry) return Response.json({ error: 'Entry not found' }, { status: 404 });

      const expectedRevisionId = await resolveExpectedRevisionId(db, entryId, body.expectedRevisionId);
      if (expectedRevisionId === undefined) {
        return Response.json({ error: 'expectedRevisionId is required' }, { status: 428 });
      }

      if (action === 'publish') {
        // Drafts may be incomplete, but required fields must be filled before they go live.
        const draftData = typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data;
        const parsed = buildZodSchemaForCollection({ ...collectionConfig, fields: activeFields }).safeParse(draftData ?? {});
        if (!parsed.success) return validationErrorResponse(parsed.error.issues);
        // Checked here too so a publish run by a Workflow fails fast with 409.
        await assertPublishableSlug(db as any, entry);
      }

      const updated = await triggerPublishingWorkflow(env, {
        collectionSlug: slug,
        entryId,
        action,
        expectedRevisionId,
      }, publishing.workflowBinding);

      await invalidateEntryCache(env, slug, entryId);
      return new Response(JSON.stringify(toEditableEntry(updated)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e: any) {
      return errorResponse(e, `Error in the ${action} API`);
    }
  }

  // --- Entries API ---
  const entriesMatch = path.match(/\/api\/collections\/([^/]+)\/entries(?:\/([^/]+))?$/);
  if (entriesMatch) {
    const slug = entriesMatch[1];
    
    try {
      const entryId = entriesMatch[2] === undefined ? undefined : decodePathSegment(entriesMatch[2]);
      const { env } = await import('cloudflare:workers') as unknown as { env: TalismanEnv };
      // @ts-ignore
      const db = createDbClient(env as any);

      const {
        collection,
        collectionConfig,
        activeFields,
        nativeTable,
        nativeIdCol
      } = await resolveCollectionContext(db, slug, env.DB);

      const operation: CollectionOperation = request.method === 'GET' ? 'read'
        : request.method === 'POST' ? 'create'
        : request.method === 'PUT' ? 'update' : 'delete';
      if (!canAccessCollection(collectionConfig, user, operation)) {
        return Response.json({ error: 'Collection access denied' }, { status: 403 });
      }

      if (request.method === 'GET') {
        if (!entryId) {
          // Without `limit` the whole list comes back as an array; with it, one page and the cursor after it.
          const page = readPageRequest(url);
          if (nativeTable && !page) {
             const rows = await db.select().from(nativeTable);
             // Wrap in CMS envelope payload
             const mapped = rows.map((r: any) => mapNativeEntry(r, collection!.id, nativeIdCol));
             return new Response(JSON.stringify(mapped), { status: 200, headers: { 'Content-Type': 'application/json' } });
          } else if (nativeTable && page) {
            // Native tables differ in their id and timestamp columns, so pages run newest first by rowid.
            const rowid = sql<number>`rowid`;
            const after = page.cursor === null ? undefined : decodeCursor(page.cursor)[0];
            if (after !== undefined && !Number.isSafeInteger(after)) throw new HttpError(400, 'The cursor is not valid.');
            const rows: any[] = await db.select({ ...getTableColumns(nativeTable), __rowid: rowid }).from(nativeTable)
              .where(after === undefined ? undefined : lt(rowid, after as number))
              .orderBy(desc(rowid))
              .limit(page.limit + 1);
            const pageRows = rows.slice(0, page.limit);
            const nextCursor = rows.length > page.limit ? encodeCursor([pageRows[pageRows.length - 1].__rowid]) : null;
            const docs = pageRows.map(({ __rowid, ...row }) => mapNativeEntry(row, collection!.id, nativeIdCol));
            return Response.json({ docs, nextCursor });
          } else if (!page) {
            const allEntries = await db.query.entries.findMany({
              // @ts-ignore
              where: (e: any, { eq }: any) => eq(e.collectionId, collection!.id),
              // @ts-ignore
              orderBy: (e: any, { desc }: any) => [desc(e.createdAt)]
            });
            return new Response(JSON.stringify(allEntries.map(toEditableEntry)), { status: 200, headers: { 'Content-Type': 'application/json' } });
          } else {
            const entries = schema.entries;
            let after;
            if (page.cursor !== null) {
              const [createdAtMs, afterId] = decodeCursor(page.cursor);
              if (typeof createdAtMs !== 'number' || !Number.isFinite(createdAtMs) || typeof afterId !== 'string') {
                throw new HttpError(400, 'The cursor is not valid.');
              }
              const createdAt = new Date(createdAtMs);
              after = or(lt(entries.createdAt, createdAt), and(eq(entries.createdAt, createdAt), lt(entries.id, afterId)));
            }
            const rows = await db.select().from(entries)
              .where(and(eq(entries.collectionId, collection!.id), after))
              .orderBy(desc(entries.createdAt), desc(entries.id))
              .limit(page.limit + 1);
            const pageRows = rows.slice(0, page.limit);
            const last = pageRows[pageRows.length - 1];
            const nextCursor = rows.length > page.limit ? encodeCursor([last.createdAt.getTime(), last.id]) : null;
            return Response.json({ docs: pageRows.map(toEditableEntry), nextCursor });
          }
        } else {
          // Get specific entry
          if (nativeTable) {
             const rows = await db.select().from(nativeTable).where(eq(nativeTable[nativeIdCol], entryId) as any);
             if (rows.length === 0) return new Response(JSON.stringify({ error: 'Entry not found' }), { status: 404 });
             const mapped = mapNativeEntry(rows[0], collection!.id, nativeIdCol);
             return new Response(JSON.stringify(mapped), { status: 200, headers: { 'Content-Type': 'application/json' } });
          } else {
            const entry = await db.query.entries.findFirst({
              // @ts-ignore
              where: (e, { eq, and }) => and(eq(e.collectionId, collection!.id), eq(e.id, entryId))
            });
            
            if (!entry) return new Response(JSON.stringify({ error: 'Entry not found' }), { status: 404 });
            const latestRevision = await getLatestRevision(db as any, entryId);
            return new Response(JSON.stringify({ ...toEditableEntry(entry), latestRevisionId: latestRevision?.id ?? null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
        }
      }

      if (collectionConfig.readOnly && ['POST', 'PUT', 'DELETE'].includes(request.method)) {
        return Response.json({ error: 'This collection is read-only' }, { status: 403 });
      }

      if (request.method === 'POST') {
        if (isSystemMediaCollection(collectionConfig)) {
          return Response.json({ error: 'Media records are created by uploading a file to the media library.' }, { status: 403 });
        }

        const payload = await readJsonObject(request);
        const { id: userProvidedId, slug: entrySlug } = payload;
        let data: Record<string, any> = payload.data === undefined ? {} : readEntryData(payload.data);

        if (nativeTable) {
          // The configured fields are the columns a client may write; hooks can still set others.
          const unwritable = findUnwritableNativeColumns(activeFields, nativeTable, data, {
            ignore: nativeSystemColumns(collectionConfig)
          });
          if (unwritable.length > 0) return unwritableColumnsResponse(unwritable);
          data = pickConfiguredNativeFields(activeFields, nativeTable, data);
          for (const [value, path] of [[userProvidedId, []], [data[nativeIdCol], [nativeIdCol]]] as const) {
            const problem = describeInvalidNativeId(value);
            if (problem) return invalidInput(problem, [...path]);
          }
        } else {
          const idProblem = isBlank(userProvidedId) ? null : describeInvalidEntryId(userProvidedId);
          if (idProblem) return invalidInput(idProblem);
          const slugProblem = isBlank(entrySlug) ? null : describeInvalidEntrySlug(entrySlug);
          if (slugProblem) return invalidInput(slugProblem);
        }

        if (collectionConfig.hooks?.beforeValidate) {
          for (const hook of collectionConfig.hooks.beforeValidate) {
            const hData = await hook({ data, req: request, operation: 'create' });
            if (hData) data = { ...data, ...hData };
          }
        }

        // Perform schema validation using activeFields
        const dynamicSchema = buildZodSchemaForCollection({ ...collectionConfig, fields: activeFields });
        const parsedDataResult = dynamicSchema.safeParse(data);
        if (!parsedDataResult.success) {
           return validationErrorResponse(parsedDataResult.error.issues);
        }
        const validatedPayload = validateCollectionPayload(slug, parsedDataResult.data);
        if (!validatedPayload.success) {
          return validationErrorResponse(validatedPayload.issues);
        }
        let validatedData = validatedPayload.data;

        if (collectionConfig.hooks?.beforeChange) {
           for (const hook of collectionConfig.hooks.beforeChange) {
             const hData = await hook({ data: validatedData, req: request, operation: 'create' });
             if (hData) validatedData = { ...validatedData, ...hData };
           }
        }

        if (nativeTable) {
           // Insert directly to native table
           const insertPayload = prepareNativeWritePayload(
             collectionConfig,
             {
               ...validatedData,
               ...(nativeTable[nativeIdCol] && userProvidedId ? { [nativeIdCol]: userProvidedId } : {})
             },
             'create'
           );
           
           const insertedRows = await db.insert(nativeTable).values(insertPayload).returning();
           const insertedRow = (Array.isArray(insertedRows) ? insertedRows[0] : null) || (
             insertPayload[nativeIdCol] !== undefined && insertPayload[nativeIdCol] !== null
               ? (await db.select().from(nativeTable).where(eq(nativeTable[nativeIdCol], insertPayload[nativeIdCol]) as any))[0]
               : null
           );
           
           await invalidateEntryCache(env, slug);

           if (!insertedRow) {
             return new Response(JSON.stringify({ error: 'Failed to load created native entry' }), {
               status: 500,
               headers: { 'Content-Type': 'application/json' }
             });
           }
           
           const doc = mapNativeEntry(insertedRow, collection!.id, nativeIdCol);
           if (collectionConfig.hooks?.afterChange) {
             for (const hook of collectionConfig.hooks.afterChange) {
               await hook({ data: validatedData, req: request, operation: 'create', doc });
             }
           }

           return new Response(JSON.stringify(doc), {
             status: 201,
             headers: { 'Content-Type': 'application/json' }
           });
        } else {
          const created = await createDraftEntry(db as any, collection as any, validatedData, {
            id: isBlank(userProvidedId) ? undefined : userProvidedId,
            slug: isBlank(entrySlug) ? undefined : entrySlug
          });
          await invalidateEntryCache(env, slug);

          if (collectionConfig.hooks?.afterChange) {
             for (const hook of collectionConfig.hooks.afterChange) {
               await hook({ data: validatedData, req: request, operation: 'create', doc: created });
             }
          }

          return new Response(JSON.stringify(toEditableEntry(created)), { status: 201, headers: { 'Content-Type': 'application/json' } });
        }
      }

      if (request.method === 'PUT') {
        if (!entryId) return new Response(JSON.stringify({ error: 'Entry ID required for PUT' }), { status: 400 });
        
        const payload = await readJsonObject(request);
        const { slug: entrySlug } = payload;
        let data: Record<string, any> | undefined = payload.data === undefined ? undefined : readEntryData(payload.data);
        
        if (nativeTable) {
           // Update native table
           const rows = await db.select().from(nativeTable).where(eq(nativeTable[nativeIdCol], entryId) as any);
           if (rows.length === 0) return new Response(JSON.stringify({ error: 'Entry not found' }), { status: 404 });
           const originalDoc = mapNativeEntry(rows[0], collection!.id, nativeIdCol);

           // Native records have no revisions: an editor sends the updatedAt it loaded instead.
           const checksUpdatedAt = payload.expectedUpdatedAt !== undefined && Boolean(nativeTable.updatedAt);
           if (checksUpdatedAt && timestampKey(rows[0].updatedAt) !== timestampKey(payload.expectedUpdatedAt)) {
             return Response.json({ error: NATIVE_RECORD_CONFLICT_MESSAGE }, { status: 409 });
           }

           if (data !== undefined) {
             // The configured fields are the columns a client may write; hooks can still set others.
             const unwritable = findUnwritableNativeColumns(activeFields, nativeTable, data, {
               ignore: nativeSystemColumns(collectionConfig),
               stored: rows[0]
             });
             if (unwritable.length > 0) return unwritableColumnsResponse(unwritable);
             const submitted = pickConfiguredNativeFields(activeFields, nativeTable, data);
             if (isSystemMediaCollection(collectionConfig)) {
               const changed = UPLOAD_MANAGED_MEDIA_FIELDS.filter((field) => field in submitted && submitted[field] !== rows[0][field]);
               if (changed.length > 0) {
                 return validationErrorResponse(changed.map((field) => ({ path: [field], message: 'Set by the upload and cannot be changed' })));
               }
               for (const field of UPLOAD_MANAGED_MEDIA_FIELDS) delete submitted[field];
             }
             data = submitted;
           }
           
           if (data !== undefined && collectionConfig.hooks?.beforeValidate) {
             for (const hook of collectionConfig.hooks.beforeValidate) {
               const hData: Record<string, any> | void = await hook({ data, req: request, operation: 'update', originalDoc });
               if (hData) data = { ...data, ...hData };
             }
           }

           let updatePayload = {};
           if (data !== undefined) {
             const rawDataToValidate = data;
             // A native update writes only the columns it sends (an editor leaves out stock it did not
             // change), so an omitted required column keeps its stored value.
             const dynamicSchema = buildZodSchemaForCollection({ ...collectionConfig, fields: activeFields }).partial();
             const parsedDataResult = dynamicSchema.safeParse(rawDataToValidate);
             
             if (!parsedDataResult.success) {
               return validationErrorResponse(parsedDataResult.error.issues);
             }
             const validatedPayload = validateCollectionPayload(slug, parsedDataResult.data);
             if (!validatedPayload.success) {
               return validationErrorResponse(validatedPayload.issues);
             }
             let validatedData = validatedPayload.data;
             if (collectionConfig.hooks?.beforeChange) {
                for (const hook of collectionConfig.hooks.beforeChange) {
                   const hData = await hook({ data: validatedData, req: request, operation: 'update', originalDoc });
                   if (hData) validatedData = { ...validatedData, ...hData };
                }
             }

             updatePayload = prepareNativeWritePayload(collectionConfig, validatedData, 'update');
           }
           
           let storedRow = rows[0];
           if (Object.keys(updatePayload).length > 0) {
              // Re-check updatedAt in the write itself, so a save that lands after the check still loses.
              const unchanged = !checksUpdatedAt ? undefined
                : rows[0].updatedAt == null ? isNull(nativeTable.updatedAt) : eq(nativeTable.updatedAt, rows[0].updatedAt);
              const updatedRows: any[] = await db.update(nativeTable).set(updatePayload)
                .where(and(eq(nativeTable[nativeIdCol], entryId), unchanged) as any).returning() as any[];
              const updatedRow = updatedRows[0];
              if (!updatedRow && checksUpdatedAt) {
                return Response.json({ error: NATIVE_RECORD_CONFLICT_MESSAGE }, { status: 409 });
              }
              // The stored row carries updatedAt at the column's precision, ready for the next stale check.
              storedRow = updatedRow ?? { ...rows[0], ...updatePayload };
           }
           
           await invalidateEntryCache(env, slug, entryId);
           
           const doc = {
              ...mapNativeEntry(storedRow, collection!.id, nativeIdCol),
              slug: entrySlug || rows[0].slug || entryId,
           };

           if (collectionConfig.hooks?.afterChange) {
             for (const hook of collectionConfig.hooks.afterChange) {
               await hook({ data: data || {}, req: request, operation: 'update', originalDoc, doc });
             }
           }

           return new Response(JSON.stringify(doc), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } else {
           const origRow = await db.query.entries.findFirst({
             // @ts-ignore
             where: (e: any, { eq, and }: any) => and(eq(e.collectionId, collection!.id), eq(e.id, entryId))
           });
           if (!origRow) return new Response(JSON.stringify({ error: 'Entry not found' }), { status: 404 });
           const originalDoc = origRow;

           const expectedRevisionId = await resolveExpectedRevisionId(db, entryId, payload.expectedRevisionId);
           if (expectedRevisionId === undefined) {
             return Response.json({ error: 'expectedRevisionId is required' }, { status: 428 });
           }

           // A blank slug keeps the current one; a published entry's rename waits for its next publish.
           // Only a new slug is checked, so an entry whose slug predates the format rules can still be
           // saved (the editor always sends the slug back).
           const renamed = !isBlank(entrySlug) && entrySlug !== (origRow.draftSlug || origRow.slug);
           const slugProblem = renamed ? describeInvalidEntrySlug(entrySlug) : null;
           if (slugProblem) return invalidInput(slugProblem);
           const draftSlug = isBlank(entrySlug) ? undefined : entrySlug as string;

           if (data !== undefined && collectionConfig.hooks?.beforeValidate) {
             for (const hook of collectionConfig.hooks.beforeValidate) {
               const hData: Record<string, any> | void = await hook({ data, req: request, operation: 'update', originalDoc });
               if (hData) data = { ...data, ...hData };
             }
           }

           if (data !== undefined) {
             const rawDataToValidate = data;
             const dynamicSchema = buildZodSchemaForCollection({ ...collectionConfig, fields: activeFields });
             const parsedDataResult = dynamicSchema.safeParse(rawDataToValidate);
             
             if (!parsedDataResult.success) {
               return validationErrorResponse(parsedDataResult.error.issues);
             }

             const validatedPayload = validateCollectionPayload(slug, parsedDataResult.data);
             if (!validatedPayload.success) {
               return validationErrorResponse(validatedPayload.issues);
             }
             
             let validatedData = validatedPayload.data;
             if (collectionConfig.hooks?.beforeChange) {
                for (const hook of collectionConfig.hooks.beforeChange) {
                   const hData = await hook({ data: validatedData, req: request, operation: 'update', originalDoc });
                   if (hData) validatedData = { ...validatedData, ...hData };
                }
             }

             const updated = await saveDraftEntry(db as any, collection as any, entryId, {
               data: validatedData,
               slug: draftSlug,
               expectedRevisionId
             });

             await invalidateEntryCache(env, slug, entryId);
             
             if (collectionConfig.hooks?.afterChange) {
               for (const hook of collectionConfig.hooks.afterChange) {
                 await hook({ data: validatedData, req: request, operation: 'update', originalDoc, doc: updated });
               }
             }
             
             return new Response(JSON.stringify(toEditableEntry(updated)), { status: 200, headers: { 'Content-Type': 'application/json' } });
           }

           const updated = await saveDraftEntry(db as any, collection as any, entryId, {
             slug: draftSlug,
             expectedRevisionId
           });
           await invalidateEntryCache(env, slug, entryId);

           if (collectionConfig.hooks?.afterChange) {
             for (const hook of collectionConfig.hooks.afterChange) {
               await hook({ data: {}, req: request, operation: 'update', originalDoc, doc: updated });
             }
           }

           return new Response(JSON.stringify(toEditableEntry(updated)), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }

      if (request.method === 'DELETE') {
        if (!entryId) return new Response(JSON.stringify({ error: 'Entry ID required for DELETE' }), { status: 400 });

        let originalDoc: any = undefined;
        if (nativeTable) {
           const rows = await db.select().from(nativeTable).where(eq(nativeTable[nativeIdCol], entryId) as any);
           if (rows.length === 0) return new Response(JSON.stringify({ error: 'Entry not found' }), { status: 404 });
           originalDoc = mapNativeEntry(rows[0], collection!.id, nativeIdCol);
        } else {
           const origRow = await db.query.entries.findFirst({
             // @ts-ignore
             where: (e: any, { eq, and }: any) => and(eq(e.collectionId, collection!.id), eq(e.id, entryId))
           });
           if (!origRow) return new Response(JSON.stringify({ error: 'Entry not found' }), { status: 404 });
           originalDoc = origRow;
        }

        if (collectionConfig.hooks?.beforeDelete) {
          for (const hook of collectionConfig.hooks.beforeDelete) {
             await hook({ req: request, operation: 'delete', originalDoc });
          }
        }

        if (nativeTable) {
           await db.delete(nativeTable).where(eq(nativeTable[nativeIdCol], entryId) as any);
        } else {
           await db.delete(schema.entries).where(
             and(eq(schema.entries.collectionId, collection!.id), eq(schema.entries.id, entryId))
           );
        }

        await invalidateEntryCache(env, slug, entryId);

        if (collectionConfig.hooks?.afterDelete) {
          for (const hook of collectionConfig.hooks.afterDelete) {
             await hook({ req: request, operation: 'delete', originalDoc, doc: originalDoc });
          }
        }

        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

    } catch (e: any) {
      return errorResponse(e, 'Error in the entries API');
    }
  }

  return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
};
