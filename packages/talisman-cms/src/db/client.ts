import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, inArray, and, gte, lte, count, type SQL } from 'drizzle-orm';
import * as schema from './schema';
import { canAccessCollection } from '../auth/collection-access';
import {
  buildZodSchemaForFields,
  decodeGlobalData,
  generateFieldsFromDrizzle,
  getRelationTargets,
  isGlobalData,
  isInlineComponentValue,
  isPolymorphicRelationField,
  isPresetReference,
  isRelationReference,
  prepareNativeWritePayload
} from '../types';
import {
  DEFAULT_PUBLISHING_WORKFLOW_BINDING,
  createDraftEntry,
  invalidateEntryCache,
  normalizeEntryDataForRead,
  saveDraftEntry,
  toEditableEntry,
  triggerPublishingWorkflow
} from '../versioning';

let _nativeSchemas: Record<string, any> | null = null;
let _nativeSchemaConfig: Record<string, { idColumn: string }> | null = null;
let _configGlobals: any[] | null = null;
let _configCollections: any[] | null = null;
type TalismanDb = ReturnType<typeof createDbClient>;

async function getNativeSchemaModule() {
  if (_nativeSchemas && _nativeSchemaConfig) {
    return {
      nativeSchemas: _nativeSchemas,
      nativeSchemaConfig: _nativeSchemaConfig
    };
  }

  try {
    const mod = await import('virtual:talisman-cms/native-schemas');
    _nativeSchemas = mod.nativeSchemas || {};
    _nativeSchemaConfig = mod.nativeSchemaConfig || {};
  } catch (err) {
    _nativeSchemas = {};
    _nativeSchemaConfig = {};
  }

  return {
    nativeSchemas: _nativeSchemas,
    nativeSchemaConfig: _nativeSchemaConfig
  };
}

async function getConfiguredGlobals() {
  if (_configGlobals) {
    return _configGlobals;
  }

  try {
    const mod = await import('virtual:talisman-cms/config');
    _configGlobals = mod.globals || [];
  } catch (err) {
    _configGlobals = [];
  }

  return _configGlobals;
}

async function getConfiguredCollections() {
  if (_configCollections !== null) return _configCollections;
  try {
    const mod = await import('virtual:talisman-cms/config');
    _configCollections = mod.collections || [];
  } catch {
    _configCollections = [];
  }
  return _configCollections;
}

async function ensureCollection(db: TalismanDb, slug: string) {
  let collection = await db.query.collections.findFirst({
    // @ts-ignore
    where: (c, { eq }) => eq(c.slug, slug)
  });
  if (collection) return collection;

  const config = (await getConfiguredCollections()).find((item) => item.slug === slug);
  if (!config) throw new Error(`Collection ${slug} not found`);

  await db.insert(schema.collections).values({
    id: crypto.randomUUID(),
    name: config.name,
    slug,
    fields: config.fields || [],
    createdAt: new Date(),
  }).onConflictDoNothing({ target: schema.collections.slug });

  collection = await db.query.collections.findFirst({
    // @ts-ignore
    where: (c, { eq }) => eq(c.slug, slug)
  });
  if (!collection) throw new Error(`Collection ${slug} could not be initialized`);
  return collection;
}

function getNativeIdColumn(
  collectionSlug: string,
  nativeSchemaConfig: Record<string, { idColumn: string }> | null | undefined
) {
  return nativeSchemaConfig?.[collectionSlug]?.idColumn || 'id';
}

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

async function syncConfiguredGlobals(db: TalismanDb) {
  const configuredGlobals = await getConfiguredGlobals();

  for (const globalConfig of configuredGlobals) {
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

  return configuredGlobals;
}

async function resolveGlobalContext(db: TalismanDb, slug: string) {
  const configuredGlobals = await getConfiguredGlobals();
  const globalConfig = configuredGlobals.find((candidate) => candidate.slug === slug) || null;

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

  return { globalConfig, globalRecord, configuredGlobals };
}
export type TalismanEnv = {
  DB: D1Database;
  STORAGE?: R2Bucket;
  IMAGES?: ImagesBinding;
  KV?: KVNamespace;
  [key: string]: unknown;
};

export function createDbClient(env: TalismanEnv) {
  if (!env.DB) {
    throw new Error('Talisman CMS requires a D1 database bound to the "DB" environment variable.');
  }
  return drizzle(env.DB, { schema });
}

type CacheContext = Pick<ExecutionContext, 'waitUntil'>;

const CACHE_TTL_SECONDS = 3600;
let _workerCacheContext: Promise<CacheContext | null> | null = null;

// Workers expose waitUntil on `cloudflare:workers`, so cache fills can finish after the
// response even when the caller did not pass its execution context.
function getWorkerCacheContext() {
  _workerCacheContext ??= import('cloudflare:workers')
    .then(({ waitUntil }) => typeof waitUntil === 'function'
      ? { waitUntil: (promise: Promise<unknown>) => waitUntil(promise) }
      : null)
    .catch(() => null);
  return _workerCacheContext;
}

/** KV is only a cache: a failed read is treated as a miss so the request falls through to D1. */
async function readCache<T>(kv: KVNamespace, key: string): Promise<T | null> {
  try {
    return await kv.get<T>(key, 'json');
  } catch (error) {
    console.warn(`[Talisman] KV cache read failed for ${key}`, error);
    return null;
  }
}

/**
 * Best-effort cache fill that never fails the read, deferred with waitUntil when available.
 * A save or publish can delete the key while this read is in flight, and a put landing after
 * that delete would serve the old value for the whole TTL. `changedSinceRead` re-checks D1 once
 * the put settles and drops the key if the source rows changed after the read began.
 */
async function writeCache(
  kv: KVNamespace,
  key: string,
  value: unknown,
  ctx: CacheContext | undefined,
  changedSinceRead?: () => Promise<boolean>
) {
  const write = (async () => {
    try {
      await kv.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS });
      if (changedSinceRead && await changedSinceRead()) {
        await kv.delete(key);
      }
    } catch (error) {
      console.warn(`[Talisman] KV cache write failed for ${key}`, error);
    }
  })();

  const context = ctx ?? await getWorkerCacheContext();
  if (context) {
    try {
      context.waitUntil(write);
      return;
    } catch {
      // No request to extend (e.g. prerendering): finish the write inline instead.
    }
  }
  await write;
}

// A concurrent save stamps roughly "now", so the recheck ignores rows stamped further ahead
// (e.g. millisecond values in a seconds column) that would otherwise drop every cache fill.
const CONCURRENT_WRITE_WINDOW_MS = 5 * 60_000;

function rowsUpdatedSince(
  db: TalismanDb,
  table: typeof schema.entries | typeof schema.globals,
  since: Date,
  where?: SQL,
  stillPresent?: { where?: SQL; count: number }
) {
  return async () => {
    const latest = new Date(Date.now() + CONCURRENT_WRITE_WINDOW_MS);
    const rows = await db.select({ id: table.id }).from(table)
      .where(and(gte(table.updatedAt, since), lte(table.updatedAt, latest), where)).limit(1);
    if (rows.length > 0) return true;
    if (!stillPresent) return false;
    // A hard delete leaves no updated row behind, so a read whose rows are no longer all there is stale too.
    const [present] = await db.select({ total: count() }).from(table).where(stillPresent.where);
    return (present?.total ?? 0) !== stillPresent.count;
  };
}

function withDecodedGlobalData<T extends { data?: unknown } | null | undefined>(record: T): T {
  return record ? { ...record, data: decodeGlobalData(record.data) } : record;
}

function isRelationshipFieldType(type: string | undefined) {
  return type === 'relationship' || type === 'relation';
}

function getNormalizedSlotItems(slot: any, value: any) {
  if (slot?.hasMany) {
    return Array.isArray(value) ? value : [];
  }

  return value ? [value] : [];
}

function collectComponentSlotRelationshipIds(
  blockValue: any,
  slots: any[] | undefined,
  idsByRelation: Map<string, Set<string>>
) {
  for (const slot of slots || []) {
    const slotValue = blockValue?.[slot.name];
    const items = getNormalizedSlotItems(slot, slotValue);

    for (const item of items) {
      if (!isInlineComponentValue(item)) continue;
      const componentDef = (slot.components || []).find((component: any) => component.slug === item.componentType);
      if (componentDef?.fields) {
        collectRelationshipIds(item, componentDef.fields, idsByRelation);
      }
    }
  }
}

function applyResolvedRelationshipsToComponentSlots(
  blockValue: any,
  slots: any[] | undefined,
  docsByRelation: Map<string, Map<string, any>>
) {
  for (const slot of slots || []) {
    const slotValue = blockValue?.[slot.name];
    const items = getNormalizedSlotItems(slot, slotValue);

    for (const item of items) {
      if (!isInlineComponentValue(item)) continue;
      const componentDef = (slot.components || []).find((component: any) => component.slug === item.componentType);
      if (componentDef?.fields) {
        applyResolvedRelationships(item, componentDef.fields, docsByRelation);
      }
    }
  }
}

function collectRelationshipIds(
  value: any,
  fields: any[] | undefined,
  idsByRelation: Map<string, Set<string>>
) {
  if (!value || !fields) return;

  for (const field of fields) {
    const fieldValue = value?.[field.name];
    if (fieldValue === undefined || fieldValue === null || fieldValue === '') continue;

    if (isRelationshipFieldType(field.type) && field.relationTo) {
      if (isPolymorphicRelationField(field)) {
        const refs = Array.isArray(fieldValue) ? fieldValue : [fieldValue];

        for (const ref of refs) {
          if (!isRelationReference(ref)) continue;
          const ids = idsByRelation.get(ref.relationTo) || new Set<string>();
          ids.add(ref.value);
          idsByRelation.set(ref.relationTo, ids);
        }
      } else {
        const relationSlug = getRelationTargets(field)[0];
        if (!relationSlug) continue;

        const ids = idsByRelation.get(relationSlug) || new Set<string>();

        if (Array.isArray(fieldValue)) {
          for (const id of fieldValue) {
            if (typeof id === 'string') ids.add(id);
          }
        } else if (typeof fieldValue === 'string') {
          ids.add(fieldValue);
        } else if (isRelationReference(fieldValue)) {
          ids.add(fieldValue.value);
        }

        idsByRelation.set(relationSlug, ids);
      }
      continue;
    }

    if (field.type === 'array' && field.fields && Array.isArray(fieldValue)) {
      for (const item of fieldValue) {
        if (item && typeof item === 'object') {
          collectRelationshipIds(item, field.fields, idsByRelation);
        }
      }
      continue;
    }

    if (field.type === 'group' && field.fields && fieldValue && typeof fieldValue === 'object') {
      collectRelationshipIds(fieldValue, field.fields, idsByRelation);
      continue;
    }

    if (field.type === 'blocks' && field.blocks && Array.isArray(fieldValue)) {
      for (const item of fieldValue) {
        if (!item || typeof item !== 'object') continue;

        const blockDef = field.blocks.find((block: any) => block.slug === item.blockType);
        if (blockDef?.fields) {
          collectRelationshipIds(item, blockDef.fields, idsByRelation);
        }
        if (blockDef?.componentSlots) {
          collectComponentSlotRelationshipIds(item, blockDef.componentSlots, idsByRelation);
        }
      }
    }
  }
}

function applyResolvedRelationships(
  value: any,
  fields: any[] | undefined,
  docsByRelation: Map<string, Map<string, any>>
) {
  if (!value || !fields) return;

  for (const field of fields) {
    const fieldValue = value?.[field.name];
    if (fieldValue === undefined || fieldValue === null || fieldValue === '') continue;

    if (isRelationshipFieldType(field.type) && field.relationTo) {
      if (isPolymorphicRelationField(field)) {
        const refs = Array.isArray(fieldValue) ? fieldValue : [fieldValue];
        const resolvedRefs = refs.map((ref: any) => {
          if (!isRelationReference(ref)) return ref;
          const docsById = docsByRelation.get(ref.relationTo);
          return docsById?.get(ref.value) || ref;
        });

        value[field.name] = Array.isArray(fieldValue) ? resolvedRefs : resolvedRefs[0];
      } else {
        const relationSlug = getRelationTargets(field)[0];
        const docsById = relationSlug ? docsByRelation.get(relationSlug) : null;
        if (!docsById) continue;

        if (Array.isArray(fieldValue)) {
          value[field.name] = fieldValue.map((id: any) => {
            if (typeof id === 'string') return docsById.get(id) || id;
            if (isRelationReference(id)) return docsById.get(id.value) || id;
            return id;
          });
        } else if (typeof fieldValue === 'string') {
          value[field.name] = docsById.get(fieldValue) || fieldValue;
        } else if (isRelationReference(fieldValue)) {
          value[field.name] = docsById.get(fieldValue.value) || fieldValue;
        }
      }
      continue;
    }

    if (field.type === 'array' && field.fields && Array.isArray(fieldValue)) {
      for (const item of fieldValue) {
        if (item && typeof item === 'object') {
          applyResolvedRelationships(item, field.fields, docsByRelation);
        }
      }
      continue;
    }

    if (field.type === 'group' && field.fields && fieldValue && typeof fieldValue === 'object') {
      applyResolvedRelationships(fieldValue, field.fields, docsByRelation);
      continue;
    }

    if (field.type === 'blocks' && field.blocks && Array.isArray(fieldValue)) {
      for (const item of fieldValue) {
        if (!item || typeof item !== 'object') continue;

        const blockDef = field.blocks.find((block: any) => block.slug === item.blockType);
        if (blockDef?.fields) {
          applyResolvedRelationships(item, blockDef.fields, docsByRelation);
        }
        if (blockDef?.componentSlots) {
          applyResolvedRelationshipsToComponentSlots(item, blockDef.componentSlots, docsByRelation);
        }
      }
    }
  }
}

// D1 binds at most 100 parameters per statement; the collection and status filters take two.
const RELATION_ID_CHUNK_SIZE = 90;

/** Fields from the deployed config, so a new relation resolves before the stored copy is synced. */
async function getRelationFields(collection: any) {
  const configured = (await getConfiguredCollections()).find((item) => item.slug === collection.slug);
  if (configured?.fields?.length) return configured.fields;
  return typeof collection.fields === 'string' ? JSON.parse(collection.fields) : collection.fields;
}

/**
 * Relations are embedded in site reads, which have no CMS user, so a target collection that only
 * administrators may read is left as ids.
 */
async function canEmbedRelationTarget(relationSlug: string) {
  const configured = (await getConfiguredCollections()).find((item) => item.slug === relationSlug);
  return !configured || canAccessCollection(configured, { role: 'editor' }, 'read');
}

async function findRelatedEntries(
  db: any,
  targetCollectionId: string,
  ids: string[],
  versionMode: 'draft' | 'published'
) {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += RELATION_ID_CHUNK_SIZE) {
    chunks.push(ids.slice(index, index + RELATION_ID_CHUNK_SIZE));
  }

  const results = await Promise.all(chunks.map((chunk) => db.query.entries.findMany({
    where: (e: any, operators: any) => versionMode === 'published'
      ? operators.and(operators.eq(e.collectionId, targetCollectionId), operators.inArray(e.id, chunk), operators.eq(e.status, 'published'))
      : operators.and(operators.eq(e.collectionId, targetCollectionId), operators.inArray(e.id, chunk))
  })));
  return results.flat();
}

async function resolveRelationships(
  entriesToResolve: any[],
  collection: any,
  db: any,
  depth = 1,
  versionMode: 'draft' | 'published' = 'published'
): Promise<any[]> {
  if (depth <= 0 || !entriesToResolve || entriesToResolve.length === 0) return entriesToResolve;

  const fieldsConfig = await getRelationFields(collection);
  if (!fieldsConfig) return entriesToResolve;
  const resolvedEntries = entriesToResolve.map((entry) => {
    const normalized = normalizeEntryDataForRead(entry, versionMode);
    return { ...normalized, data: typeof normalized.data === 'string' ? JSON.parse(normalized.data) : normalized.data };
  });

  const idsByRelation = new Map<string, Set<string>>();
  for (const entry of resolvedEntries) {
    collectRelationshipIds(entry.data, fieldsConfig || [], idsByRelation);
  }

  if (idsByRelation.size === 0) return resolvedEntries;

  const docsByRelation = new Map<string, Map<string, any>>();

  for (const [relationSlug, idsToFetch] of idsByRelation.entries()) {
    if (!(await canEmbedRelationTarget(relationSlug))) continue;

    let targetCollection;
    try {
      targetCollection = await ensureCollection(db, relationSlug);
    } catch (error) {
      if (error instanceof Error && error.message === `Collection ${relationSlug} not found`) continue;
      throw error;
    }
    if (idsToFetch.size === 0) continue;

    let relatedDocs = await findRelatedEntries(db, targetCollection.id, Array.from(idsToFetch), versionMode);

    relatedDocs = relatedDocs.map((doc: any) => normalizeEntryDataForRead(doc, versionMode));

    if (depth > 1) {
      relatedDocs = await resolveRelationships(relatedDocs, targetCollection, db, depth - 1, versionMode);
    } else {
      relatedDocs = relatedDocs.map((r: any) => ({ ...r, data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data }));
    }

    docsByRelation.set(relationSlug, new Map(relatedDocs.map((r: any) => [r.id, r])));
  }

  for (const entry of resolvedEntries) {
    applyResolvedRelationships(entry.data, fieldsConfig || [], docsByRelation);
  }
  
  return resolvedEntries;
}

/**
 * Pass the request's execution context (Workers `ctx`, Astro `locals.cfContext`) so KV cache
 * fills run after the response; inside Workers it is otherwise taken from `cloudflare:workers`.
 */
export function getClient(env: TalismanEnv, ctx?: CacheContext) {
  const db = createDbClient(env);
  
  return {
    collections: {
      async findMany(opts?: { cache?: boolean }) {
        const cacheKey = 'talisman:collections:all';
        
        if (opts?.cache !== false && env.KV) {
          const cached = await readCache<Array<any>>(env.KV, cacheKey);
          if (cached) return cached;
        }

        for (const config of await getConfiguredCollections()) {
          await ensureCollection(db, config.slug);
        }
        const data = await db.query.collections.findMany();
        
        if (opts?.cache !== false && env.KV) {
          // Cache for 1 hour by default
          await writeCache(env.KV, cacheKey, data, ctx);
        }
        
        return data;
      }
    },
    globals: {
      async findMany(opts?: { cache?: boolean }) {
        const cacheKey = 'talisman:globals:all';
        
        if (opts?.cache !== false && env.KV) {
          const cached = await readCache<Array<any>>(env.KV, cacheKey);
          if (cached) return cached;
        }

        const readStartedAt = new Date();
        const configuredGlobals = await syncConfiguredGlobals(db);
        const allGlobals = await db.query.globals.findMany();
        const configuredOrder = new Map(configuredGlobals.map((globalConfig, index) => [globalConfig.slug, index]));
        const data = allGlobals
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
        
        if (opts?.cache !== false && env.KV) {
          await writeCache(env.KV, cacheKey, data, ctx, rowsUpdatedSince(db, schema.globals, readStartedAt));
        }
        
        return data;
      },
      async find(slug: string, opts?: { cache?: boolean }) {
        const cacheKey = `talisman:globals:${slug}`;
        
        if (opts?.cache !== false && env.KV) {
          // A value cached before globals were stored as objects can still hold encoded data.
          const cached = await readCache<any>(env.KV, cacheKey);
          if (cached) return withDecodedGlobalData(cached);
        }

        const readStartedAt = new Date();
        const { globalRecord } = await resolveGlobalContext(db, slug);
        const data = withDecodedGlobalData(globalRecord);
        
        if (opts?.cache !== false && env.KV && data) {
          await writeCache(env.KV, cacheKey, data, ctx,
            rowsUpdatedSince(db, schema.globals, readStartedAt, eq(schema.globals.slug, slug)));
        }
        
        return data;
      },
      async create(input: { slug: string; name?: string; description?: string | null; data?: any }) {
        const slug = input.slug.trim();
        if (!slug) {
          throw new Error('Slug is required');
        }

        const existing = await db.query.globals.findFirst({
          // @ts-ignore
          where: (g, { eq }) => eq(g.slug, slug)
        });

        if (existing) {
          throw new Error('A global with this slug already exists');
        }

        const now = new Date();
        const created = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          name: input.name?.trim() || slug,
          slug,
          description: input.description?.trim() || null,
          data: isGlobalData(input.data) ? input.data : {},
          createdAt: now,
          updatedAt: now,
        };

        await db.insert(schema.globals).values(created);

        if (env.KV) {
          await env.KV.delete('talisman:globals:all');
          await env.KV.delete(`talisman:globals:${slug}`);
        }

        return created;
      },
      async update(slug: string, data: any) {
        const { globalConfig, globalRecord: existing } = await resolveGlobalContext(db, slug);

        if (globalConfig?.fields?.length) {
          const parsed = buildZodSchemaForFields(globalConfig.fields).safeParse(data);
          if (!parsed.success) {
            throw new Error(parsed.error.issues.map((issue) => issue.message).join(', '));
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

        if (env.KV) {
          await env.KV.delete('talisman:globals:all');
          await env.KV.delete(`talisman:globals:${slug}`);
        }

        return withDecodedGlobalData(await db.query.globals.findFirst({
          // @ts-ignore
          where: (g, { eq }) => eq(g.slug, slug)
        }));
      }
    },
    entries: {
      async findMany(collectionSlug: string, opts?: { cache?: boolean; depth?: number; version?: 'draft' | 'published'; limit?: number }) {
        const versionMode = opts?.version || 'published';
        const cacheKey = `talisman:entries:${collectionSlug}:all:${versionMode}`;
        if (opts?.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1)) {
          throw new RangeError('limit must be a positive integer');
        }
        const limit = opts?.limit;
        const useCache = opts?.cache !== false && limit === undefined && (opts?.depth ?? 1) === 0 && Boolean(env.KV);
        
        if (useCache && env.KV) {
          const cached = await readCache<Array<any>>(env.KV, cacheKey);
          if (cached) return cached;
        }

        const readStartedAt = new Date();
        const collection = await ensureCollection(db, collectionSlug);
        
        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);

        let data;
        if (nativeTable) {
           const query = db.select().from(nativeTable);
           const rows = limit === undefined ? await query : await query.limit(limit);
           data = rows.map((r: any) => mapNativeEntry(r, collection.id, nativeIdCol));
        } else {
           data = await db.query.entries.findMany({
             // @ts-ignore
             where: (e, operators) =>
               versionMode === 'published'
                 ? operators.and(operators.eq(e.collectionId, collection.id), operators.eq(e.status, 'published'))
                 : operators.eq(e.collectionId, collection.id),
             orderBy: (e: any, { desc }: any) => [desc(e.createdAt)],
             ...(limit === undefined ? {} : { limit })
           });
           data = data.map((entry: any) => normalizeEntryDataForRead(entry, versionMode));
        }
        
        // Dynamically inject generated fields if missing, so resolver works
        if ((!collection.fields || (collection.fields as any[]).length === 0) && nativeTable) {
          collection.fields = generateFieldsFromDrizzle(nativeTable);
        }
        
        data = await resolveRelationships(data, collection, db, opts?.depth ?? 1, versionMode);
        
        if (useCache && env.KV) {
          const inCollection = eq(schema.entries.collectionId, collection.id);
          await writeCache(env.KV, cacheKey, data, ctx,
            nativeTable ? undefined : rowsUpdatedSince(db, schema.entries, readStartedAt, inCollection, {
              where: versionMode === 'published' ? and(inCollection, eq(schema.entries.status, 'published')) : inCollection,
              count: data.length,
            }));
        }
        
        return data;
      },
      async findBySlug(collectionSlug: string, slug: string, opts?: { depth?: number; version?: 'draft' | 'published' }) {
        const versionMode = opts?.version || 'published';
        const collection = await ensureCollection(db, collectionSlug);
        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        let data;

        if (nativeTable) {
          const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);
          const slugColumn = nativeTable.slug || nativeTable[nativeIdCol];
          const rows = await db.select().from(nativeTable).where(eq(slugColumn, slug) as any).limit(1);
          if (rows[0]) data = mapNativeEntry(rows[0], collection.id, nativeIdCol);
          if ((!collection.fields || (collection.fields as any[]).length === 0) && nativeTable) {
            collection.fields = generateFieldsFromDrizzle(nativeTable);
          }
        } else {
          // `slug` is the live slug of a published entry; a draft read looks for the slug the
          // entry will have after its next publish.
          data = await db.query.entries.findFirst({
            // @ts-ignore
            where: (e, operators) => versionMode === 'published'
              ? operators.and(operators.eq(e.collectionId, collection.id), operators.eq(e.status, 'published'), operators.eq(e.slug, slug))
              : operators.and(operators.eq(e.collectionId, collection.id), operators.or(
                operators.eq(e.draftSlug, slug),
                operators.and(operators.isNull(e.draftSlug), operators.eq(e.slug, slug))
              )),
            orderBy: (e: any, { desc }: any) => [desc(e.createdAt)]
          });
          if (data) data = normalizeEntryDataForRead(data, versionMode);
        }

        if (!data) return null;
        const resolved = await resolveRelationships([data], collection, db, opts?.depth ?? 1, versionMode);
        return resolved[0];
      },
      async find(collectionSlug: string, id: string, opts?: { cache?: boolean; depth?: number; version?: 'draft' | 'published' }) {
        const versionMode = opts?.version || 'published';
        const cacheKey = `talisman:entries:${collectionSlug}:${id}:${versionMode}`;
        const useCache = opts?.cache !== false && (opts?.depth ?? 1) === 0 && Boolean(env.KV);
        
        if (useCache && env.KV) {
          const cached = await readCache<any>(env.KV, cacheKey);
          if (cached) return cached;
        }

        const readStartedAt = new Date();
        const collection = await ensureCollection(db, collectionSlug);

        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);

        let data;
        if (nativeTable) {
          const rows = await db.select().from(nativeTable).where(eq(nativeTable[nativeIdCol], id) as any);
          if (rows.length > 0) {
            data = mapNativeEntry(rows[0], collection.id, nativeIdCol);
          }
        } else {
          data = await db.query.entries.findFirst({
            // @ts-ignore
            where: (e, operators) =>
              versionMode === 'published'
                ? operators.and(operators.eq(e.collectionId, collection.id), operators.eq(e.id, id), operators.eq(e.status, 'published'))
                : operators.and(operators.eq(e.collectionId, collection.id), operators.eq(e.id, id))
          });
          if (data) {
            data = normalizeEntryDataForRead(data, versionMode);
          }
        }
        
        if (data) {
          if ((!collection.fields || (collection.fields as any[]).length === 0) && nativeTable) {
            collection.fields = generateFieldsFromDrizzle(nativeTable);
          }
          const resolved = await resolveRelationships([data], collection, db, opts?.depth ?? 1, versionMode);
          data = resolved[0];
        }
        
        if (useCache && env.KV && data) {
          await writeCache(env.KV, cacheKey, data, ctx,
            nativeTable ? undefined : rowsUpdatedSince(db, schema.entries, readStartedAt, eq(schema.entries.id, id),
              { where: eq(schema.entries.id, id), count: 1 }));
        }
        
        return data;
      },
      async create(collectionSlug: string, data: any, opts?: { slug?: string, status?: string }) {
        const collection = await ensureCollection(db, collectionSlug);

        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);
        
        let created;
        if (nativeTable) {
           const insertPayload = prepareNativeWritePayload(collection as any, data || {}, 'create');
           const insertedRows = await (db.insert(nativeTable).values(insertPayload).returning() as Promise<any[]>);
           const insertedRow = insertedRows[0];

           if (insertedRow) {
             created = mapNativeEntry(insertedRow, collection.id, nativeIdCol);
           } else if (insertPayload[nativeIdCol] !== undefined && insertPayload[nativeIdCol] !== null) {
             const rows = await db.select().from(nativeTable).where(eq(nativeTable[nativeIdCol], insertPayload[nativeIdCol]) as any);
             if (rows.length > 0) {
               created = mapNativeEntry(rows[0], collection.id, nativeIdCol);
             }
           }
        } else {
          created = await createDraftEntry(db as any, collection as any, data, { slug: opts?.slug });

          if (opts?.status === 'published' || opts?.status === 'archived') {
            created = await triggerPublishingWorkflow(env, {
              collectionSlug,
              entryId: created.id,
              action: opts.status === 'archived' ? 'archive' : 'publish'
            }, DEFAULT_PUBLISHING_WORKFLOW_BINDING);
          }
          created = toEditableEntry(created);
        }

        await invalidateEntryCache(env, collectionSlug);

        if (nativeTable && !created) {
          throw new Error(`Failed to load created entry for collection ${collectionSlug}`);
        }

        return created;
      },
      async update(collectionSlug: string, id: string, data?: any, opts?: { slug?: string, status?: string }) {
        const collection = await ensureCollection(db, collectionSlug);

        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);
        
        let updated;
        if (nativeTable) {
           const rows = await db.select().from(nativeTable).where(eq(nativeTable[nativeIdCol], id) as any);
           if (rows.length === 0) throw new Error(`Entry ${id} not found in collection ${collectionSlug}`);
           
           if (data !== undefined && data !== null && typeof data === 'object' && Object.keys(data).length > 0) {
              const updatePayload = prepareNativeWritePayload(collection as any, data, 'update');
              await db.update(nativeTable).set(updatePayload).where(eq(nativeTable[nativeIdCol], id) as any);
              data = updatePayload;
           }
           
           const r = { ...rows[0], ...data };
           updated = mapNativeEntry(r, collection.id, nativeIdCol);
        } else {
          updated = await saveDraftEntry(db as any, collection as any, id, { data, slug: opts?.slug });

          if (opts?.status === 'published' || opts?.status === 'archived') {
            updated = await triggerPublishingWorkflow(env, {
              collectionSlug,
              entryId: id,
              action: opts.status === 'archived' ? 'archive' : 'publish'
            }, DEFAULT_PUBLISHING_WORKFLOW_BINDING);
          }
          // Like the admin API: `slug` is the one just saved, and `publishedSlug` the live one.
          updated = toEditableEntry(updated);
        }

        await invalidateEntryCache(env, collectionSlug, id);

        return updated;
      },
      async delete(collectionSlug: string, id: string) {
        const collection = await ensureCollection(db, collectionSlug);

        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);
        
        if (nativeTable) {
           await db.delete(nativeTable).where(eq(nativeTable[nativeIdCol], id) as any);
        } else {
          // @ts-ignore
          await db.delete(schema.entries).where(
            and(eq(schema.entries.collectionId, collection.id), eq(schema.entries.id, id))
          );
        }

        if (env.KV) {
          await env.KV.delete(`talisman:entries:${collectionSlug}:all`);
          await env.KV.delete(`talisman:entries:${collectionSlug}:all:draft`);
          await env.KV.delete(`talisman:entries:${collectionSlug}:all:published`);
          await env.KV.delete(`talisman:entries:${collectionSlug}:${id}`);
          await env.KV.delete(`talisman:entries:${collectionSlug}:${id}:draft`);
          await env.KV.delete(`talisman:entries:${collectionSlug}:${id}:published`);
        }

        return true;
      }
    }
  };
}
