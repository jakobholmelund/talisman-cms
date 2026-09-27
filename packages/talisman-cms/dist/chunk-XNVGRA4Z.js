import {
  DEFAULT_PUBLISHING_WORKFLOW_BINDING,
  createDraftEntry,
  invalidateEntryCache,
  normalizeEntryDataForRead,
  saveDraftEntry,
  toEditableEntry,
  triggerPublishingWorkflow
} from "./chunk-B33VKPHM.js";
import {
  collections,
  entries,
  globals,
  media,
  schema_exports
} from "./chunk-NSKY6EIU.js";
import {
  canAccessCollection
} from "./chunk-7VUPBVR5.js";
import {
  deleteStoredMedia
} from "./chunk-LWGYD5KW.js";
import {
  buildZodSchemaForFields,
  decodeGlobalData,
  generateFieldsFromDrizzle,
  getRelationTargets,
  isGlobalData,
  isInlineComponentValue,
  isPolymorphicRelationField,
  isRelationReference,
  nextNativeUpdatedAt
} from "./chunk-2NIG35DR.js";

// src/db/client.ts
import { drizzle } from "drizzle-orm/d1";
import { eq, and, gte, lte, count, getTableColumns, getTableName } from "drizzle-orm";
var _nativeSchemas = null;
var _nativeSchemaConfig = null;
var _configGlobals = null;
var _configCollections = null;
var _publishingWorkflowBinding = null;
async function getNativeSchemaModule() {
  if (_nativeSchemas && _nativeSchemaConfig) {
    return {
      nativeSchemas: _nativeSchemas,
      nativeSchemaConfig: _nativeSchemaConfig
    };
  }
  try {
    const mod = await import("virtual:talisman-cms/native-schemas");
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
    const mod = await import("virtual:talisman-cms/config");
    _configGlobals = mod.globals || [];
  } catch (err) {
    _configGlobals = [];
  }
  return _configGlobals;
}
async function getPublishingWorkflowBinding() {
  if (_publishingWorkflowBinding !== null) return _publishingWorkflowBinding;
  try {
    const mod = await import("virtual:talisman-cms/config");
    _publishingWorkflowBinding = mod.publishing?.workflowBinding || DEFAULT_PUBLISHING_WORKFLOW_BINDING;
  } catch {
    _publishingWorkflowBinding = DEFAULT_PUBLISHING_WORKFLOW_BINDING;
  }
  return _publishingWorkflowBinding;
}
async function getConfiguredCollections() {
  if (_configCollections !== null) return _configCollections;
  try {
    const mod = await import("virtual:talisman-cms/config");
    _configCollections = mod.collections || [];
  } catch {
    _configCollections = [];
  }
  return _configCollections;
}
async function ensureCollection(db, slug) {
  let collection = await db.query.collections.findFirst({
    // @ts-ignore
    where: (c, { eq: eq2 }) => eq2(c.slug, slug)
  });
  if (collection) return collection;
  const config = (await getConfiguredCollections()).find((item) => item.slug === slug);
  if (!config) throw new Error(`Collection ${slug} not found`);
  await db.insert(collections).values({
    id: crypto.randomUUID(),
    name: config.name,
    slug,
    fields: config.fields || [],
    createdAt: /* @__PURE__ */ new Date()
  }).onConflictDoNothing({ target: collections.slug });
  collection = await db.query.collections.findFirst({
    // @ts-ignore
    where: (c, { eq: eq2 }) => eq2(c.slug, slug)
  });
  if (!collection) throw new Error(`Collection ${slug} could not be initialized`);
  return collection;
}
function prepareNativeClientWrite(nativeTable, nativeIdCol, data, stored) {
  const payload = { ...data };
  const columns = getTableColumns(nativeTable);
  const fillable = (key) => columns[key]?.dataType === "date" && (payload[key] === void 0 || payload[key] === null || payload[key] === "");
  if (stored) {
    delete payload[nativeIdCol];
    if (fillable("updatedAt")) payload.updatedAt = nextNativeUpdatedAt(stored.updatedAt);
    return payload;
  }
  const now = /* @__PURE__ */ new Date();
  for (const key of ["createdAt", "updatedAt"]) {
    if (fillable(key) && !columns[key].hasDefault) payload[key] = now;
  }
  return payload;
}
function getNativeIdColumn(collectionSlug, nativeSchemaConfig) {
  return nativeSchemaConfig?.[collectionSlug]?.idColumn || "id";
}
function mapNativeEntry(row, collectionId, nativeIdCol) {
  const resolvedId = row?.[nativeIdCol] ?? row?.id ?? "";
  return {
    id: resolvedId,
    collectionId,
    slug: row?.slug || resolvedId || "",
    status: typeof row?.status === "string" ? row.status : "published",
    data: row,
    createdAt: row?.createdAt || /* @__PURE__ */ new Date(),
    updatedAt: row?.updatedAt || /* @__PURE__ */ new Date()
  };
}
async function syncConfiguredGlobals(db) {
  const configuredGlobals = await getConfiguredGlobals();
  for (const globalConfig of configuredGlobals) {
    const existing = await db.query.globals.findFirst({
      // @ts-ignore
      where: (g, { eq: eq2 }) => eq2(g.slug, globalConfig.slug)
    });
    if (!existing) {
      const now = /* @__PURE__ */ new Date();
      await db.insert(globals).values({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        name: globalConfig.name,
        slug: globalConfig.slug,
        description: globalConfig.description || null,
        data: {},
        createdAt: now,
        updatedAt: now
      });
      continue;
    }
    const nextDescription = globalConfig.description || null;
    if (existing.name !== globalConfig.name || (existing.description || null) !== nextDescription) {
      await db.update(globals).set({
        name: globalConfig.name,
        description: nextDescription
      }).where(eq(globals.id, existing.id));
    }
  }
  return configuredGlobals;
}
async function resolveGlobalContext(db, slug) {
  const configuredGlobals = await getConfiguredGlobals();
  const globalConfig = configuredGlobals.find((candidate) => candidate.slug === slug) || null;
  let globalRecord = await db.query.globals.findFirst({
    // @ts-ignore
    where: (g, { eq: eq2 }) => eq2(g.slug, slug)
  });
  if (!globalRecord && globalConfig) {
    const now = /* @__PURE__ */ new Date();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    await db.insert(globals).values({
      id,
      name: globalConfig.name,
      slug: globalConfig.slug,
      description: globalConfig.description || null,
      data: {},
      createdAt: now,
      updatedAt: now
    });
    globalRecord = await db.query.globals.findFirst({
      // @ts-ignore
      where: (g, { eq: eq2 }) => eq2(g.slug, slug)
    });
  } else if (globalRecord && globalConfig) {
    const nextDescription = globalConfig.description || null;
    if (globalRecord.name !== globalConfig.name || (globalRecord.description || null) !== nextDescription) {
      await db.update(globals).set({
        name: globalConfig.name,
        description: nextDescription
      }).where(eq(globals.id, globalRecord.id));
      globalRecord = {
        ...globalRecord,
        name: globalConfig.name,
        description: nextDescription
      };
    }
  }
  return { globalConfig, globalRecord, configuredGlobals };
}
function createDbClient(env) {
  if (!env.DB) {
    throw new Error('Talisman CMS requires a D1 database bound to the "DB" environment variable.');
  }
  return drizzle(env.DB, { schema: schema_exports });
}
var CACHE_TTL_SECONDS = 3600;
var _workerCacheContext = null;
function getWorkerCacheContext() {
  _workerCacheContext ??= import("cloudflare:workers").then(({ waitUntil }) => typeof waitUntil === "function" ? { waitUntil: (promise) => waitUntil(promise) } : null).catch(() => null);
  return _workerCacheContext;
}
async function readCache(kv, key) {
  try {
    return await kv.get(key, "json");
  } catch (error) {
    console.warn(`[Talisman] KV cache read failed for ${key}`, error);
    return null;
  }
}
async function writeCache(kv, key, value, ctx, changedSinceRead) {
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
    }
  }
  await write;
}
var CONCURRENT_WRITE_WINDOW_MS = 5 * 6e4;
function rowsUpdatedSince(db, table, since, where, stillPresent) {
  return async () => {
    const latest = new Date(Date.now() + CONCURRENT_WRITE_WINDOW_MS);
    const rows = await db.select({ id: table.id }).from(table).where(and(gte(table.updatedAt, since), lte(table.updatedAt, latest), where)).limit(1);
    if (rows.length > 0) return true;
    if (!stillPresent) return false;
    const [present] = await db.select({ total: count() }).from(table).where(stillPresent.where);
    return (present?.total ?? 0) !== stillPresent.count;
  };
}
function withDecodedGlobalData(record) {
  return record ? { ...record, data: decodeGlobalData(record.data) } : record;
}
function isRelationshipFieldType(type) {
  return type === "relationship" || type === "relation";
}
function getNormalizedSlotItems(slot, value) {
  if (slot?.hasMany) {
    return Array.isArray(value) ? value : [];
  }
  return value ? [value] : [];
}
function collectComponentSlotRelationshipIds(blockValue, slots, idsByRelation) {
  for (const slot of slots || []) {
    const slotValue = blockValue?.[slot.name];
    const items = getNormalizedSlotItems(slot, slotValue);
    for (const item of items) {
      if (!isInlineComponentValue(item)) continue;
      const componentDef = (slot.components || []).find((component) => component.slug === item.componentType);
      if (componentDef?.fields) {
        collectRelationshipIds(item, componentDef.fields, idsByRelation);
      }
    }
  }
}
function applyResolvedRelationshipsToComponentSlots(blockValue, slots, docsByRelation) {
  for (const slot of slots || []) {
    const slotValue = blockValue?.[slot.name];
    const items = getNormalizedSlotItems(slot, slotValue);
    for (const item of items) {
      if (!isInlineComponentValue(item)) continue;
      const componentDef = (slot.components || []).find((component) => component.slug === item.componentType);
      if (componentDef?.fields) {
        applyResolvedRelationships(item, componentDef.fields, docsByRelation);
      }
    }
  }
}
function collectRelationshipIds(value, fields, idsByRelation) {
  if (!value || !fields) return;
  for (const field of fields) {
    const fieldValue = value?.[field.name];
    if (fieldValue === void 0 || fieldValue === null || fieldValue === "") continue;
    if (isRelationshipFieldType(field.type) && field.relationTo) {
      if (isPolymorphicRelationField(field)) {
        const refs = Array.isArray(fieldValue) ? fieldValue : [fieldValue];
        for (const ref of refs) {
          if (!isRelationReference(ref)) continue;
          const ids = idsByRelation.get(ref.relationTo) || /* @__PURE__ */ new Set();
          ids.add(ref.value);
          idsByRelation.set(ref.relationTo, ids);
        }
      } else {
        const relationSlug = getRelationTargets(field)[0];
        if (!relationSlug) continue;
        const ids = idsByRelation.get(relationSlug) || /* @__PURE__ */ new Set();
        if (Array.isArray(fieldValue)) {
          for (const id of fieldValue) {
            if (typeof id === "string") ids.add(id);
          }
        } else if (typeof fieldValue === "string") {
          ids.add(fieldValue);
        } else if (isRelationReference(fieldValue)) {
          ids.add(fieldValue.value);
        }
        idsByRelation.set(relationSlug, ids);
      }
      continue;
    }
    if (field.type === "array" && field.fields && Array.isArray(fieldValue)) {
      for (const item of fieldValue) {
        if (item && typeof item === "object") {
          collectRelationshipIds(item, field.fields, idsByRelation);
        }
      }
      continue;
    }
    if (field.type === "group" && field.fields && fieldValue && typeof fieldValue === "object") {
      collectRelationshipIds(fieldValue, field.fields, idsByRelation);
      continue;
    }
    if (field.type === "blocks" && field.blocks && Array.isArray(fieldValue)) {
      for (const item of fieldValue) {
        if (!item || typeof item !== "object") continue;
        const blockDef = field.blocks.find((block) => block.slug === item.blockType);
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
function applyResolvedRelationships(value, fields, docsByRelation) {
  if (!value || !fields) return;
  for (const field of fields) {
    const fieldValue = value?.[field.name];
    if (fieldValue === void 0 || fieldValue === null || fieldValue === "") continue;
    if (isRelationshipFieldType(field.type) && field.relationTo) {
      if (isPolymorphicRelationField(field)) {
        const refs = Array.isArray(fieldValue) ? fieldValue : [fieldValue];
        const resolvedRefs = refs.map((ref) => {
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
          value[field.name] = fieldValue.map((id) => {
            if (typeof id === "string") return docsById.get(id) || id;
            if (isRelationReference(id)) return docsById.get(id.value) || id;
            return id;
          });
        } else if (typeof fieldValue === "string") {
          value[field.name] = docsById.get(fieldValue) || fieldValue;
        } else if (isRelationReference(fieldValue)) {
          value[field.name] = docsById.get(fieldValue.value) || fieldValue;
        }
      }
      continue;
    }
    if (field.type === "array" && field.fields && Array.isArray(fieldValue)) {
      for (const item of fieldValue) {
        if (item && typeof item === "object") {
          applyResolvedRelationships(item, field.fields, docsByRelation);
        }
      }
      continue;
    }
    if (field.type === "group" && field.fields && fieldValue && typeof fieldValue === "object") {
      applyResolvedRelationships(fieldValue, field.fields, docsByRelation);
      continue;
    }
    if (field.type === "blocks" && field.blocks && Array.isArray(fieldValue)) {
      for (const item of fieldValue) {
        if (!item || typeof item !== "object") continue;
        const blockDef = field.blocks.find((block) => block.slug === item.blockType);
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
var RELATION_ID_CHUNK_SIZE = 90;
async function getRelationFields(collection) {
  const configured = (await getConfiguredCollections()).find((item) => item.slug === collection.slug);
  if (configured?.fields?.length) return configured.fields;
  return typeof collection.fields === "string" ? JSON.parse(collection.fields) : collection.fields;
}
async function canEmbedRelationTarget(relationSlug) {
  const configured = (await getConfiguredCollections()).find((item) => item.slug === relationSlug);
  return !configured || canAccessCollection(configured, { role: "editor" }, "read");
}
async function findRelatedEntries(db, targetCollectionId, ids, versionMode) {
  const chunks = [];
  for (let index = 0; index < ids.length; index += RELATION_ID_CHUNK_SIZE) {
    chunks.push(ids.slice(index, index + RELATION_ID_CHUNK_SIZE));
  }
  const results = await Promise.all(chunks.map((chunk) => db.query.entries.findMany({
    where: (e, operators) => versionMode === "published" ? operators.and(operators.eq(e.collectionId, targetCollectionId), operators.inArray(e.id, chunk), operators.eq(e.status, "published")) : operators.and(operators.eq(e.collectionId, targetCollectionId), operators.inArray(e.id, chunk))
  })));
  return results.flat();
}
async function resolveRelationships(entriesToResolve, collection, db, depth = 1, versionMode = "published") {
  if (depth <= 0 || !entriesToResolve || entriesToResolve.length === 0) return entriesToResolve;
  const fieldsConfig = await getRelationFields(collection);
  if (!fieldsConfig) return entriesToResolve;
  const resolvedEntries = entriesToResolve.map((entry) => {
    const normalized = normalizeEntryDataForRead(entry, versionMode);
    return { ...normalized, data: typeof normalized.data === "string" ? JSON.parse(normalized.data) : normalized.data };
  });
  const idsByRelation = /* @__PURE__ */ new Map();
  for (const entry of resolvedEntries) {
    collectRelationshipIds(entry.data, fieldsConfig || [], idsByRelation);
  }
  if (idsByRelation.size === 0) return resolvedEntries;
  const docsByRelation = /* @__PURE__ */ new Map();
  for (const [relationSlug, idsToFetch] of idsByRelation.entries()) {
    if (!await canEmbedRelationTarget(relationSlug)) continue;
    let targetCollection;
    try {
      targetCollection = await ensureCollection(db, relationSlug);
    } catch (error) {
      if (error instanceof Error && error.message === `Collection ${relationSlug} not found`) continue;
      throw error;
    }
    if (idsToFetch.size === 0) continue;
    let relatedDocs = await findRelatedEntries(db, targetCollection.id, Array.from(idsToFetch), versionMode);
    relatedDocs = relatedDocs.map((doc) => normalizeEntryDataForRead(doc, versionMode));
    if (depth > 1) {
      relatedDocs = await resolveRelationships(relatedDocs, targetCollection, db, depth - 1, versionMode);
    } else {
      relatedDocs = relatedDocs.map((r) => ({ ...r, data: typeof r.data === "string" ? JSON.parse(r.data) : r.data }));
    }
    docsByRelation.set(relationSlug, new Map(relatedDocs.map((r) => [r.id, r])));
  }
  for (const entry of resolvedEntries) {
    applyResolvedRelationships(entry.data, fieldsConfig || [], docsByRelation);
  }
  return resolvedEntries;
}
function getClient(env, ctx) {
  const db = createDbClient(env);
  return {
    collections: {
      async findMany(opts) {
        const cacheKey = "talisman:collections:all";
        if (opts?.cache !== false && env.KV) {
          const cached = await readCache(env.KV, cacheKey);
          if (cached) return cached;
        }
        for (const config of await getConfiguredCollections()) {
          await ensureCollection(db, config.slug);
        }
        const data = await db.query.collections.findMany();
        if (opts?.cache !== false && env.KV) {
          await writeCache(env.KV, cacheKey, data, ctx);
        }
        return data;
      }
    },
    globals: {
      async findMany(opts) {
        const cacheKey = "talisman:globals:all";
        if (opts?.cache !== false && env.KV) {
          const cached = await readCache(env.KV, cacheKey);
          if (cached) return cached;
        }
        const readStartedAt = /* @__PURE__ */ new Date();
        const configuredGlobals = await syncConfiguredGlobals(db);
        const allGlobals = await db.query.globals.findMany();
        const configuredOrder = new Map(configuredGlobals.map((globalConfig, index) => [globalConfig.slug, index]));
        const data = allGlobals.map((g) => ({ ...g, data: void 0 })).sort((left, right) => {
          const leftOrder = configuredOrder.get(left.slug);
          const rightOrder = configuredOrder.get(right.slug);
          if (leftOrder !== void 0 && rightOrder !== void 0) {
            return leftOrder - rightOrder;
          }
          if (leftOrder !== void 0) return -1;
          if (rightOrder !== void 0) return 1;
          return left.name.localeCompare(right.name);
        });
        if (opts?.cache !== false && env.KV) {
          await writeCache(env.KV, cacheKey, data, ctx, rowsUpdatedSince(db, globals, readStartedAt));
        }
        return data;
      },
      async find(slug, opts) {
        const cacheKey = `talisman:globals:${slug}`;
        if (opts?.cache !== false && env.KV) {
          const cached = await readCache(env.KV, cacheKey);
          if (cached) return withDecodedGlobalData(cached);
        }
        const readStartedAt = /* @__PURE__ */ new Date();
        const { globalRecord } = await resolveGlobalContext(db, slug);
        const data = withDecodedGlobalData(globalRecord);
        if (opts?.cache !== false && env.KV && data) {
          await writeCache(
            env.KV,
            cacheKey,
            data,
            ctx,
            rowsUpdatedSince(db, globals, readStartedAt, eq(globals.slug, slug))
          );
        }
        return data;
      },
      async create(input) {
        const slug = input.slug.trim();
        if (!slug) {
          throw new Error("Slug is required");
        }
        const existing = await db.query.globals.findFirst({
          // @ts-ignore
          where: (g, { eq: eq2 }) => eq2(g.slug, slug)
        });
        if (existing) {
          throw new Error("A global with this slug already exists");
        }
        if (input.data != null && !isGlobalData(input.data)) {
          throw new TypeError("Global data must be a JSON object");
        }
        const now = /* @__PURE__ */ new Date();
        const created = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          name: input.name?.trim() || slug,
          slug,
          description: input.description?.trim() || null,
          data: isGlobalData(input.data) ? input.data : {},
          createdAt: now,
          updatedAt: now
        };
        await db.insert(globals).values(created);
        if (env.KV) {
          await env.KV.delete("talisman:globals:all");
          await env.KV.delete(`talisman:globals:${slug}`);
        }
        return created;
      },
      async update(slug, data) {
        if (!isGlobalData(data)) {
          throw new TypeError("Global data must be a JSON object");
        }
        const { globalConfig, globalRecord: existing } = await resolveGlobalContext(db, slug);
        if (globalConfig?.fields?.length) {
          const parsed = buildZodSchemaForFields(globalConfig.fields).safeParse(data);
          if (!parsed.success) {
            throw new Error(parsed.error.issues.map((issue) => issue.message).join(", "));
          }
          data = parsed.data;
        }
        const id = existing?.id || Date.now().toString() + "-" + Math.random().toString(36).substring(7);
        const now = /* @__PURE__ */ new Date();
        await db.insert(globals).values({
          id,
          name: globalConfig?.name || existing?.name || slug,
          slug,
          description: globalConfig?.description || existing?.description || null,
          data,
          createdAt: existing?.createdAt || now,
          updatedAt: now
        }).onConflictDoUpdate({
          target: globals.slug,
          set: {
            name: globalConfig?.name || existing?.name || slug,
            description: globalConfig?.description || existing?.description || null,
            data,
            updatedAt: now
          }
        });
        if (env.KV) {
          await env.KV.delete("talisman:globals:all");
          await env.KV.delete(`talisman:globals:${slug}`);
        }
        return withDecodedGlobalData(await db.query.globals.findFirst({
          // @ts-ignore
          where: (g, { eq: eq2 }) => eq2(g.slug, slug)
        }));
      }
    },
    entries: {
      async findMany(collectionSlug, opts) {
        const versionMode = opts?.version || "published";
        const cacheKey = `talisman:entries:${collectionSlug}:all:${versionMode}`;
        if (opts?.limit !== void 0 && (!Number.isSafeInteger(opts.limit) || opts.limit < 1)) {
          throw new RangeError("limit must be a positive integer");
        }
        const limit = opts?.limit;
        const useCache = opts?.cache !== false && limit === void 0 && (opts?.depth ?? 1) === 0 && Boolean(env.KV);
        if (useCache && env.KV) {
          const cached = await readCache(env.KV, cacheKey);
          if (cached) return cached;
        }
        const readStartedAt = /* @__PURE__ */ new Date();
        const collection = await ensureCollection(db, collectionSlug);
        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);
        let data;
        if (nativeTable) {
          const query = db.select().from(nativeTable);
          const rows = limit === void 0 ? await query : await query.limit(limit);
          data = rows.map((r) => mapNativeEntry(r, collection.id, nativeIdCol));
        } else {
          data = await db.query.entries.findMany({
            // @ts-ignore
            where: (e, operators) => versionMode === "published" ? operators.and(operators.eq(e.collectionId, collection.id), operators.eq(e.status, "published")) : operators.eq(e.collectionId, collection.id),
            orderBy: (e, { desc: desc2 }) => [desc2(e.createdAt)],
            ...limit === void 0 ? {} : { limit }
          });
          data = data.map((entry) => normalizeEntryDataForRead(entry, versionMode));
        }
        if ((!collection.fields || collection.fields.length === 0) && nativeTable) {
          collection.fields = generateFieldsFromDrizzle(nativeTable);
        }
        data = await resolveRelationships(data, collection, db, opts?.depth ?? 1, versionMode);
        if (useCache && env.KV) {
          const inCollection = eq(entries.collectionId, collection.id);
          await writeCache(
            env.KV,
            cacheKey,
            data,
            ctx,
            nativeTable ? void 0 : rowsUpdatedSince(db, entries, readStartedAt, inCollection, {
              where: versionMode === "published" ? and(inCollection, eq(entries.status, "published")) : inCollection,
              count: data.length
            })
          );
        }
        return data;
      },
      async findBySlug(collectionSlug, slug, opts) {
        const versionMode = opts?.version || "published";
        const collection = await ensureCollection(db, collectionSlug);
        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        let data;
        if (nativeTable) {
          const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);
          const slugColumn = nativeTable.slug || nativeTable[nativeIdCol];
          const rows = await db.select().from(nativeTable).where(eq(slugColumn, slug)).limit(1);
          if (rows[0]) data = mapNativeEntry(rows[0], collection.id, nativeIdCol);
          if ((!collection.fields || collection.fields.length === 0) && nativeTable) {
            collection.fields = generateFieldsFromDrizzle(nativeTable);
          }
        } else {
          data = await db.query.entries.findFirst({
            // @ts-ignore
            where: (e, operators) => versionMode === "published" ? operators.and(operators.eq(e.collectionId, collection.id), operators.eq(e.status, "published"), operators.eq(e.slug, slug)) : operators.and(operators.eq(e.collectionId, collection.id), operators.or(
              operators.eq(e.draftSlug, slug),
              operators.and(operators.isNull(e.draftSlug), operators.eq(e.slug, slug))
            )),
            orderBy: (e, { desc: desc2 }) => [desc2(e.createdAt)]
          });
          if (data) data = normalizeEntryDataForRead(data, versionMode);
        }
        if (!data) return null;
        const resolved = await resolveRelationships([data], collection, db, opts?.depth ?? 1, versionMode);
        return resolved[0];
      },
      async find(collectionSlug, id, opts) {
        const versionMode = opts?.version || "published";
        const cacheKey = `talisman:entries:${collectionSlug}:${id}:${versionMode}`;
        const useCache = opts?.cache !== false && (opts?.depth ?? 1) === 0 && Boolean(env.KV);
        if (useCache && env.KV) {
          const cached = await readCache(env.KV, cacheKey);
          if (cached) return cached;
        }
        const readStartedAt = /* @__PURE__ */ new Date();
        const collection = await ensureCollection(db, collectionSlug);
        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);
        let data;
        if (nativeTable) {
          const rows = await db.select().from(nativeTable).where(eq(nativeTable[nativeIdCol], id));
          if (rows.length > 0) {
            data = mapNativeEntry(rows[0], collection.id, nativeIdCol);
          }
        } else {
          data = await db.query.entries.findFirst({
            // @ts-ignore
            where: (e, operators) => versionMode === "published" ? operators.and(operators.eq(e.collectionId, collection.id), operators.eq(e.id, id), operators.eq(e.status, "published")) : operators.and(operators.eq(e.collectionId, collection.id), operators.eq(e.id, id))
          });
          if (data) {
            data = normalizeEntryDataForRead(data, versionMode);
          }
        }
        if (data) {
          if ((!collection.fields || collection.fields.length === 0) && nativeTable) {
            collection.fields = generateFieldsFromDrizzle(nativeTable);
          }
          const resolved = await resolveRelationships([data], collection, db, opts?.depth ?? 1, versionMode);
          data = resolved[0];
        }
        if (useCache && env.KV && data) {
          await writeCache(
            env.KV,
            cacheKey,
            data,
            ctx,
            nativeTable ? void 0 : rowsUpdatedSince(
              db,
              entries,
              readStartedAt,
              eq(entries.id, id),
              { where: eq(entries.id, id), count: 1 }
            )
          );
        }
        return data;
      },
      async create(collectionSlug, data, opts) {
        const collection = await ensureCollection(db, collectionSlug);
        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);
        let created;
        if (nativeTable) {
          const insertPayload = prepareNativeClientWrite(nativeTable, nativeIdCol, data || {});
          const insertedRows = await db.insert(nativeTable).values(insertPayload).returning();
          const insertedRow = insertedRows[0];
          if (insertedRow) {
            created = mapNativeEntry(insertedRow, collection.id, nativeIdCol);
          } else if (insertPayload[nativeIdCol] !== void 0 && insertPayload[nativeIdCol] !== null) {
            const rows = await db.select().from(nativeTable).where(eq(nativeTable[nativeIdCol], insertPayload[nativeIdCol]));
            if (rows.length > 0) {
              created = mapNativeEntry(rows[0], collection.id, nativeIdCol);
            }
          }
        } else {
          created = await createDraftEntry(db, collection, data, { slug: opts?.slug });
          if (opts?.status === "published" || opts?.status === "archived") {
            created = await triggerPublishingWorkflow(env, {
              collectionSlug,
              entryId: created.id,
              action: opts.status === "archived" ? "archive" : "publish"
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
      async update(collectionSlug, id, data, opts) {
        const collection = await ensureCollection(db, collectionSlug);
        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);
        let updated;
        if (nativeTable) {
          const rows = await db.select().from(nativeTable).where(eq(nativeTable[nativeIdCol], id));
          if (rows.length === 0) throw new Error(`Entry ${id} not found in collection ${collectionSlug}`);
          if (data !== void 0 && data !== null && typeof data === "object" && Object.keys(data).length > 0) {
            const updatePayload = prepareNativeClientWrite(nativeTable, nativeIdCol, data, rows[0]);
            if (Object.keys(updatePayload).length > 0) {
              await db.update(nativeTable).set(updatePayload).where(eq(nativeTable[nativeIdCol], id));
            }
            data = updatePayload;
          }
          const r = { ...rows[0], ...data };
          updated = mapNativeEntry(r, collection.id, nativeIdCol);
        } else {
          updated = await saveDraftEntry(db, collection, id, { data, slug: opts?.slug });
          if (opts?.status === "published" || opts?.status === "archived") {
            updated = await triggerPublishingWorkflow(env, {
              collectionSlug,
              entryId: id,
              action: opts.status === "archived" ? "archive" : "publish"
            }, await getPublishingWorkflowBinding());
          }
          updated = toEditableEntry(updated);
        }
        await invalidateEntryCache(env, collectionSlug, id);
        return updated;
      },
      async delete(collectionSlug, id) {
        const collection = await ensureCollection(db, collectionSlug);
        const { nativeSchemas, nativeSchemaConfig } = await getNativeSchemaModule();
        const nativeTable = nativeSchemas?.[collectionSlug];
        const nativeIdCol = getNativeIdColumn(collectionSlug, nativeSchemaConfig);
        if (nativeTable) {
          if (getTableName(nativeTable) === getTableName(media)) {
            await deleteStoredMedia(env, id);
          }
          await db.delete(nativeTable).where(eq(nativeTable[nativeIdCol], id));
        } else {
          await db.delete(entries).where(
            and(eq(entries.collectionId, collection.id), eq(entries.id, id))
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

export {
  createDbClient,
  getClient
};
