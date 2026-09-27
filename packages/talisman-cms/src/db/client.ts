import { drizzle } from 'drizzle-orm/d1';
import { eq, inArray, and, getTableColumns, getTableName } from 'drizzle-orm';
import * as schema from './schema';
import { deleteStoredMedia } from './media-policy';
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
  nextNativeUpdatedAt
} from '../types';
import { loadServiceConfig } from '../service/config';
import { resolveCollectionRecord, syncCollectionDefinitions } from '../service/collections';
import { NotFoundError } from '../service/errors';
import {
  NATIVE_CACHE_TTL_SECONDS,
  cacheKeys,
  invalidateEntryCache,
  invalidateGlobalCache,
  readCache,
  rowsUpdatedSince,
  writeCache,
  type CacheContext
} from '../service/cache';
import {
  createDraftEntry,
  normalizeEntryDataForRead,
  saveDraftEntry,
  toEditableEntry,
  triggerPublishingWorkflow
} from '../versioning';

type TalismanDb = ReturnType<typeof createDbClient>;

async function getConfiguredCollections() {
  return (await loadServiceConfig()).collections;
}

async function getConfiguredGlobals() {
  return (await loadServiceConfig()).globals;
}

/** The Workflow binding named by the integration's `publishing.workflowBinding` option. */
async function getPublishingWorkflowBinding() {
  return (await loadServiceConfig()).publishingWorkflowBinding;
}

async function getNativeSchemaModule() {
  const config = await loadServiceConfig();
  return {
    nativeSchemas: config.nativeSchemas,
    nativeSchemaConfig: Object.fromEntries(config.collections
      .filter((collection) => collection.nativeSchemaMapping)
      .map((collection) => [collection.slug, { idColumn: collection.nativeSchemaMapping?.idColumn || 'id' }])),
  };
}

/** The collection's stored row, from the isolate's memo after one sync of the configured collections. */
async function ensureCollection(db: TalismanDb, env: Pick<TalismanEnv, 'DB' | 'KV'>, slug: string) {
  return resolveCollectionRecord(db, env, await loadServiceConfig(), slug);
}

/**
 * A native row as getClient writes it: the caller's data as given, so the table's own defaults still
 * apply (an AUTOINCREMENT or `$defaultFn` id, `DEFAULT CURRENT_TIMESTAMP` text timestamps). The only
 * values added are integer timestamps (Drizzle `mode: 'timestamp'` or `'timestamp_ms'`) the caller
 * leaves out: on create a `createdAt`/`updatedAt` column without a default of its own gets the
 * current time, and an update moves `updatedAt` forward like the admin API does (see
 * nextNativeUpdatedAt). An update keeps the row's id: the id column is not written.
 */
function prepareNativeClientWrite(
  nativeTable: any,
  nativeIdCol: string,
  data: Record<string, any>,
  stored?: Record<string, any>
) {
  const payload: Record<string, any> = { ...data };
  const columns = getTableColumns(nativeTable) as Record<string, any>;
  const fillable = (key: string) =>
    columns[key]?.dataType === 'date' && (payload[key] === undefined || payload[key] === null || payload[key] === '');

  if (stored) {
    delete payload[nativeIdCol];
    if (fillable('updatedAt')) payload.updatedAt = nextNativeUpdatedAt(stored.updatedAt);
    return payload;
  }

  const now = new Date();
  for (const key of ['createdAt', 'updatedAt']) {
    if (fillable(key) && !columns[key].hasDefault) payload[key] = now;
  }
  return payload;
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

/**
 * Entries and globals are cached unless the caller opts out. Native tables are cached only when the
 * caller opts in: plugin SQL writes them without clearing anything, so the copy is short-lived.
 */
function cacheWanted(opts: { cache?: boolean } | undefined, native: boolean) {
  return native ? opts?.cache === true : opts?.cache !== false;
}

/** The row with its fields generated from the native table when none are stored; the memoized row itself is left alone. */
function withGeneratedFields(collection: any, nativeTable: any) {
  if (nativeTable && (!collection.fields || (collection.fields as any[]).length === 0)) {
    return { ...collection, fields: generateFieldsFromDrizzle(nativeTable) };
  }
  return collection;
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
  env: Pick<TalismanEnv, 'DB' | 'KV'>,
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
      targetCollection = await ensureCollection(db, env, relationSlug);
    } catch (error) {
      if (error instanceof NotFoundError) continue;
      throw error;
    }
    if (idsToFetch.size === 0) continue;

    let relatedDocs = await findRelatedEntries(db, targetCollection.id, Array.from(idsToFetch), versionMode);

    relatedDocs = relatedDocs.map((doc: any) => normalizeEntryDataForRead(doc, versionMode));

    if (depth > 1) {
      relatedDocs = await resolveRelationships(relatedDocs, targetCollection, db, env, depth - 1, versionMode);
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
        const cacheKey = cacheKeys.collections();
        
        if (opts?.cache !== false && env.KV) {
          const cached = await readCache<Array<any>>(env.KV, cacheKey);
          if (cached) return cached;
        }

        await syncCollectionDefinitions(db, env, await loadServiceConfig());
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
        const cacheKey = cacheKeys.globals();
        
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
          await writeCache(env.KV, cacheKey, data, ctx, { changedSinceRead: rowsUpdatedSince(db, schema.globals, readStartedAt) });
        }
        
        return data;
      },
      async find(slug: string, opts?: { cache?: boolean }) {
        const cacheKey = cacheKeys.global(slug);
        
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
            { changedSinceRead: rowsUpdatedSince(db, schema.globals, readStartedAt, eq(schema.globals.slug, slug)) });
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

        // Like the admin API: global data is a JSON object, and leaving it out starts with {}.
        if (input.data != null && !isGlobalData(input.data)) {
          throw new TypeError('Global data must be a JSON object');
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
        await invalidateGlobalCache(env, slug);

        return created;
      },
      async update(slug: string, data: Record<string, any>) {
        // Every read decodes global data as an object, so any other value would read back as {}.
        if (!isGlobalData(data)) {
          throw new TypeError('Global data must be a JSON object');
        }
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

        await invalidateGlobalCache(env, slug);

        return withDecodedGlobalData(await db.query.globals.findFirst({
          // @ts-ignore
          where: (g, { eq }) => eq(g.slug, slug)
        }));
      }
    },
    entries: {
      async findMany(collectionSlug: string, opts?: { cache?: boolean; depth?: number; version?: 'draft' | 'published'; limit?: number }) {
        const versionMode = opts?.version || 'published';
        const cacheKey = cacheKeys.entries(collectionSlug, versionMode);
        if (opts?.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1)) {
          throw new RangeError('limit must be a positive integer');
        }
        const limit = opts?.limit;
        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);
        const useCache = cacheWanted(opts, Boolean(nativeTable)) && limit === undefined && (opts?.depth ?? 1) === 0 && Boolean(env.KV);
        
        if (useCache && env.KV) {
          const cached = await readCache<Array<any>>(env.KV, cacheKey);
          if (cached) return cached;
        }

        const readStartedAt = new Date();
        const collection = await ensureCollection(db, env, collectionSlug);

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
        
        data = await resolveRelationships(data, withGeneratedFields(collection, nativeTable), db, env, opts?.depth ?? 1, versionMode);
        
        if (useCache && env.KV) {
          const inCollection = eq(schema.entries.collectionId, collection.id);
          await writeCache(env.KV, cacheKey, data, ctx, nativeTable ? { ttl: NATIVE_CACHE_TTL_SECONDS } : {
            changedSinceRead: rowsUpdatedSince(db, schema.entries, readStartedAt, inCollection, {
              where: versionMode === 'published' ? and(inCollection, eq(schema.entries.status, 'published')) : inCollection,
              count: data.length,
            }),
          });
        }
        
        return data;
      },
      async findBySlug(collectionSlug: string, slug: string, opts?: { depth?: number; version?: 'draft' | 'published' }) {
        const versionMode = opts?.version || 'published';
        const collection = await ensureCollection(db, env, collectionSlug);
        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        let data;

        if (nativeTable) {
          const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);
          const slugColumn = nativeTable.slug || nativeTable[nativeIdCol];
          const rows = await db.select().from(nativeTable).where(eq(slugColumn, slug) as any).limit(1);
          if (rows[0]) data = mapNativeEntry(rows[0], collection.id, nativeIdCol);
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
        const resolved = await resolveRelationships([data], withGeneratedFields(collection, nativeTable), db, env, opts?.depth ?? 1, versionMode);
        return resolved[0];
      },
      async find(collectionSlug: string, id: string, opts?: { cache?: boolean; depth?: number; version?: 'draft' | 'published' }) {
        const versionMode = opts?.version || 'published';
        const cacheKey = cacheKeys.entry(collectionSlug, id, versionMode);
        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);
        const useCache = cacheWanted(opts, Boolean(nativeTable)) && (opts?.depth ?? 1) === 0 && Boolean(env.KV);
        
        if (useCache && env.KV) {
          const cached = await readCache<any>(env.KV, cacheKey);
          if (cached) return cached;
        }

        const readStartedAt = new Date();
        const collection = await ensureCollection(db, env, collectionSlug);

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
          const resolved = await resolveRelationships([data], withGeneratedFields(collection, nativeTable), db, env, opts?.depth ?? 1, versionMode);
          data = resolved[0];
        }
        
        if (useCache && env.KV && data) {
          await writeCache(env.KV, cacheKey, data, ctx, nativeTable ? { ttl: NATIVE_CACHE_TTL_SECONDS } : {
            changedSinceRead: rowsUpdatedSince(db, schema.entries, readStartedAt, eq(schema.entries.id, id),
              { where: eq(schema.entries.id, id), count: 1 }),
          });
        }
        
        return data;
      },
      async create(collectionSlug: string, data: any, opts?: { slug?: string, status?: string }) {
        const collection = await ensureCollection(db, env, collectionSlug);

        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);
        
        let created;
        if (nativeTable) {
           const insertPayload = prepareNativeClientWrite(nativeTable, nativeIdCol, data || {});
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
            }, await getPublishingWorkflowBinding());
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
        const collection = await ensureCollection(db, env, collectionSlug);

        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);
        
        let updated;
        if (nativeTable) {
           const rows = await db.select().from(nativeTable).where(eq(nativeTable[nativeIdCol], id) as any);
           if (rows.length === 0) throw new Error(`Entry ${id} not found in collection ${collectionSlug}`);
           
           if (data !== undefined && data !== null && typeof data === 'object' && Object.keys(data).length > 0) {
              const updatePayload = prepareNativeClientWrite(nativeTable, nativeIdCol, data, rows[0]);
              if (Object.keys(updatePayload).length > 0) {
                await db.update(nativeTable).set(updatePayload).where(eq(nativeTable[nativeIdCol], id) as any);
              }
              data = updatePayload;
           }
           
           const r = { ...rows[0], ...data };
           updated = mapNativeEntry(r, collection.id, nativeIdCol);
        } else {
          updated = await saveDraftEntry(db as any, collection as any, id, { data, slug: opts?.slug });

          if (opts?.status === 'published' || opts?.status === 'archived') {
            // A publish still running in its Workflow returns the saved draft with `workflow.status: 'pending'`.
            updated = await triggerPublishingWorkflow(env, {
              collectionSlug,
              entryId: id,
              action: opts.status === 'archived' ? 'archive' : 'publish'
            }, await getPublishingWorkflowBinding());
          }
          // Like the admin API: `slug` is the one just saved, and `publishedSlug` the live one.
          updated = toEditableEntry(updated);
        }

        await invalidateEntryCache(env, collectionSlug, id);

        return updated;
      },
      async delete(collectionSlug: string, id: string) {
        const collection = await ensureCollection(db, env, collectionSlug);

        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);
        
        if (nativeTable) {
           if (getTableName(nativeTable) === getTableName(schema.media)) {
             // media-serve reads R2 directly, so the file goes with its record.
             await deleteStoredMedia(env, id);
           }
           await db.delete(nativeTable).where(eq(nativeTable[nativeIdCol], id) as any);
        } else {
          // @ts-ignore
          await db.delete(schema.entries).where(
            and(eq(schema.entries.collectionId, collection.id), eq(schema.entries.id, id))
          );
        }

        await invalidateEntryCache(env, collectionSlug, id);

        return true;
      }
    }
  };
}
