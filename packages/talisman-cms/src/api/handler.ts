import type { APIRoute } from 'astro';
import { count, sql } from 'drizzle-orm';
import { createDbClient, type TalismanEnv } from '../db/client';
import * as schema from '../db/schema';
import { authorizeCmsRequest } from '../auth/guard';
import { canAccessCollection } from '../auth/collection-access';
import * as configModule from 'virtual:talisman-cms/config';
import * as uiLibrariesModule from 'virtual:talisman-cms/ui-libraries';
import * as nativeSchemasModule from 'virtual:talisman-cms/native-schemas';
import * as collectionHooksModule from 'virtual:talisman-cms/collection-hooks';
import { assertAllowed, assertCollectionAccess, userActor, type ActorOperation } from '../service/actor';
import { configuredCollectionFields as collectionFields, syncCollectionDefinitions as syncCollections } from '../service/collections';
import { configFromModules } from '../service/config';
import { MAX_PAGE_SIZE, NATIVE_PUBLISHING_MESSAGE, NATIVE_REVISIONS_MESSAGE } from '../service/entries';
import { NotFoundError } from '../service/errors';
import { createService } from '../service/index';
import { isGlobalData } from '../types';
import { HttpError, toErrorResponse } from './http-errors';
import { parseListQuery } from './list-query';

// The virtual modules stay static imports, so the Worker bundle carries the site's hook modules and
// a module that fails to load fails the build.
const serviceConfig = configFromModules({
  config: configModule,
  uiLibraries: uiLibrariesModule,
  nativeSchemas: nativeSchemasModule,
  collectionHooks: collectionHooksModule,
});
const { collections: configCollections, nativeSchemas } = serviceConfig;

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

/**
 * The version a global save names in `If-Match`: a bare or quoted whole number, as the ETag of the
 * GET gives it. No header, or `*`, saves unconditionally; anything else is a client mistake.
 */
function readIfMatchVersion(request: Request): number | null {
  const header = request.headers.get('if-match');
  if (header === null) return null;
  const value = header.trim();
  if (value === '*') return null;
  const match = value.match(/^(\d{1,15})$|^"(\d{1,15})"$/);
  if (!match) throw new HttpError(400, 'If-Match must be the version the global was loaded with, as a whole number, bare or in quotes.');
  return Number(match[1] ?? match[2]);
}

/** A global with its version in the body and as the ETag a conditional save sends back. */
function globalResponse(global: { version?: unknown }, status = 200) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (typeof global.version === 'number') headers.ETag = `"${global.version}"`;
  return new Response(JSON.stringify(global), { status, headers });
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

function configuredCollectionFields(collectionConfig: (typeof configCollections)[number]) {
  return collectionFields(collectionConfig, nativeSchemas);
}

function syncCollectionDefinitions(db: ReturnType<typeof createDbClient>, env: TalismanEnv) {
  return syncCollections(db, env, serviceConfig);
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

/** The admin API serves configured collections only; a stored collection without configuration is not found. */
async function resolveConfigured(service: ReturnType<typeof createService>, slug: string) {
  const collection = await service.entries.resolve(slug);
  if (!collection.configured) throw new NotFoundError(`Collection ${slug} not found`);
  return collection;
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
  const actor = userActor(user, request);

  // Get all registered collections
  if (path.endsWith('/api/collections')) {
    try {
      const { env } = await import('cloudflare:workers');
      const db = createDbClient(env as any);

      // A few statements whatever the number of collections: the rows are synced once per isolate,
      // then read in one query, with one count for entries and one for every native table.
      await syncCollectionDefinitions(db, env as any);
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
      return toErrorResponse(e, 'Error in /api/collections');
    }
  }

  // --- Globals API ---
  const globalsMatch = path.match(/\/api\/globals(?:\/([^/]+))?$/);
  if (globalsMatch) {
    const slug = globalsMatch[1];

    try {
      const { env } = await import('cloudflare:workers') as unknown as { env: TalismanEnv };
      const service = createService(env, { config: serviceConfig, actor });

      if (request.method === 'GET') {
        if (!slug) {
          return new Response(JSON.stringify(await service.globals.list()), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        const global = await service.globals.get(slug);
        if (!global) return new Response(JSON.stringify({ error: 'Global not found' }), { status: 404 });
        return globalResponse(global);
      }

      if (request.method === 'POST') {
        if (!slug) {
          const body = await readJsonObject(request);
          const created = await service.globals.create({ slug: body.slug, name: body.name, description: body.description, data: body.data });
          return globalResponse(created, 201);
        }
        // The header is checked before the body is read; a stale version answers 409 with the current one.
        const expectedVersion = readIfMatchVersion(request);
        const updated = await service.globals.save(slug, await readJsonBody(request), { expectedVersion });
        return globalResponse(updated);
      }
    } catch (e: any) {
      return toErrorResponse(e, 'Error in /api/globals');
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
      const service = createService(env, { config: serviceConfig, actor });
      const collection = await resolveConfigured(service, slug);
      // Refused before the body is read; the service checks again when it acts.
      assertCollectionAccess(actor, collection.config, request.method === 'GET' ? 'read' : 'update', 'Collection access denied');

      if (collection.nativeTable) {
        return new Response(JSON.stringify({ error: NATIVE_REVISIONS_MESSAGE }), { status: 400 });
      }

      if (request.method === 'GET' && !revisionId) {
        // The history lists metadata; a revision's data is loaded on its own or with ?includeData=true.
        const includeData = ['1', 'true'].includes(url.searchParams.get('includeData') ?? '');
        const page = readPageRequest(url);
        if (page?.cursor) throw new HttpError(400, 'Revision lists take a limit but no cursor.');
        const revisions = await service.revisions.list(slug, entryId, { includeData, limit: page?.limit });
        return new Response(JSON.stringify(revisions), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (request.method === 'GET' && revisionId && !isRestore) {
        const revision = await service.revisions.get(slug, entryId, revisionId);
        return new Response(JSON.stringify(revision), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (request.method === 'POST' && revisionId && isRestore) {
        const body = await request.json().catch(() => ({})) as { expectedRevisionId?: unknown };
        const restored = await service.revisions.restore(slug, entryId, revisionId, { expectedRevisionId: body.expectedRevisionId });
        return new Response(JSON.stringify(restored), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    } catch (e: any) {
      return toErrorResponse(e, 'Error in the revisions API');
    }
  }

  const transitionMatch = path.match(/\/api\/collections\/([^/]+)\/entries\/([^/]+)\/(publish|archive)$/);
  if (transitionMatch) {
    const slug = transitionMatch[1];
    const action = transitionMatch[3] as 'publish' | 'archive';

    try {
      const entryId = decodePathSegment(transitionMatch[2]);
      const { env } = await import('cloudflare:workers') as unknown as { env: TalismanEnv };
      const service = createService(env, { config: serviceConfig, actor });
      const collection = await resolveConfigured(service, slug);
      assertCollectionAccess(actor, collection.config, 'update', 'Collection access denied');

      if (collection.nativeTable) {
        return new Response(JSON.stringify({ error: NATIVE_PUBLISHING_MESSAGE }), { status: 400 });
      }

      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
      }

      const body = await request.json().catch(() => ({})) as { expectedRevisionId?: unknown };
      const updated = await service.entries[action](slug, entryId, { expect: { revisionId: body.expectedRevisionId } });
      if (updated.workflow?.status === 'pending') {
        // A Workflow instance that outlives the wait keeps running and clears the cache when it
        // finishes. The entry is returned as it is stored now, before the transition.
        return Response.json({
          ...updated,
          message: `The ${action} is still running. Reload the entry in a moment to see the result.`,
        }, { status: 202 });
      }
      return new Response(JSON.stringify(updated), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e: any) {
      return toErrorResponse(e, `Error in the ${action} API`);
    }
  }

  // --- Entries API ---
  const entriesMatch = path.match(/\/api\/collections\/([^/]+)\/entries(?:\/([^/]+))?$/);
  if (entriesMatch) {
    const slug = entriesMatch[1];

    try {
      const entryId = entriesMatch[2] === undefined ? undefined : decodePathSegment(entriesMatch[2]);
      const { env } = await import('cloudflare:workers') as unknown as { env: TalismanEnv };
      const service = createService(env, { config: serviceConfig, actor });
      const collection = await resolveConfigured(service, slug);

      const operation: ActorOperation = request.method === 'GET' ? 'read'
        : request.method === 'POST' ? 'create'
        : request.method === 'PUT' ? 'update' : 'delete';
      // Refused before the body is read; the service checks again when it acts.
      assertAllowed(actor, collection.config, operation);

      if (request.method === 'GET') {
        if (!entryId) {
          // Without `limit` the whole list comes back as an array; with it, one page and the cursor after it.
          // `where`, `sort` and `offset` narrow, order and skip either.
          const query = parseListQuery(url);
          const page = readPageRequest(url);
          if (!page) {
            return new Response(JSON.stringify(await service.entries.list(slug, query)), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return Response.json(await service.entries.page(slug, { ...page, ...query }));
        }
        const doc = await service.entries.get(slug, entryId);
        if (!doc) return new Response(JSON.stringify({ error: 'Entry not found' }), { status: 404 });
        return new Response(JSON.stringify(doc), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (request.method === 'POST') {
        const payload = await readJsonObject(request);
        const created = await service.entries.create(slug, { data: payload.data, id: payload.id, slug: payload.slug });
        return new Response(JSON.stringify(created), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }

      if (request.method === 'PUT') {
        if (!entryId) return new Response(JSON.stringify({ error: 'Entry ID required for PUT' }), { status: 400 });
        const payload = await readJsonObject(request);
        const updated = await service.entries.update(slug, entryId, {
          data: payload.data,
          slug: payload.slug,
          expect: { revisionId: payload.expectedRevisionId, updatedAt: payload.expectedUpdatedAt },
        });
        return new Response(JSON.stringify(updated), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (request.method === 'DELETE') {
        if (!entryId) return new Response(JSON.stringify({ error: 'Entry ID required for DELETE' }), { status: 400 });
        await service.entries.remove(slug, entryId, { origin: url.origin });
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

    } catch (e: any) {
      return toErrorResponse(e, 'Error in the entries API');
    }
  }

  return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
};
