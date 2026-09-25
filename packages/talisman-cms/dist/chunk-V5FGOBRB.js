import {
  DEFAULT_PUBLISHING_WORKFLOW_BINDING,
  createDraftEntry,
  invalidateEntryCache,
  normalizeEntryDataForRead,
  saveDraftEntry,
  triggerPublishingWorkflow
} from "./chunk-M47S7VHS.js";
import {
  and,
  drizzle,
  eq
} from "./chunk-ACDUZVLI.js";
import {
  collections,
  entries,
  globals,
  schema_exports
} from "./chunk-MR6IJMXT.js";
import {
  buildZodSchemaForFields,
  generateFieldsFromDrizzle,
  getRelationTargets,
  isInlineComponentValue,
  isPolymorphicRelationField,
  isRelationReference,
  prepareNativeWritePayload
} from "./chunk-JCYUX5UW.js";

// src/db/client.ts
var _nativeSchemas = null;
var _nativeSchemaConfig = null;
var _configGlobals = null;
var _configCollections = null;
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
        data: "{}",
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
      data: "{}",
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
async function resolveRelationships(entriesToResolve, collection, db, depth = 1, versionMode = "published") {
  if (depth <= 0 || !entriesToResolve || entriesToResolve.length === 0 || !collection.fields) return entriesToResolve;
  const fieldsConfig = typeof collection.fields === "string" ? JSON.parse(collection.fields) : collection.fields;
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
    let targetCollection;
    try {
      targetCollection = await ensureCollection(db, relationSlug);
    } catch (error) {
      if (error instanceof Error && error.message === `Collection ${relationSlug} not found`) continue;
      throw error;
    }
    if (idsToFetch.size === 0) continue;
    let relatedDocs = await db.query.entries.findMany({
      where: (e, operators) => versionMode === "published" ? operators.and(operators.inArray(e.id, Array.from(idsToFetch)), operators.eq(e.status, "published")) : operators.inArray(e.id, Array.from(idsToFetch))
    });
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
function getClient(env) {
  const db = createDbClient(env);
  return {
    collections: {
      async findMany(opts) {
        const cacheKey = "talisman:collections:all";
        if (opts?.cache !== false && env.KV) {
          const cached = await env.KV.get(cacheKey, "json");
          if (cached) return cached;
        }
        for (const config of await getConfiguredCollections()) {
          await ensureCollection(db, config.slug);
        }
        const data = await db.query.collections.findMany();
        if (opts?.cache !== false && env.KV) {
          await env.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 3600 });
        }
        return data;
      }
    },
    globals: {
      async findMany(opts) {
        const cacheKey = "talisman:globals:all";
        if (opts?.cache !== false && env.KV) {
          const cached = await env.KV.get(cacheKey, "json");
          if (cached) return cached;
        }
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
          await env.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 3600 });
        }
        return data;
      },
      async find(slug, opts) {
        const cacheKey = `talisman:globals:${slug}`;
        if (opts?.cache !== false && env.KV) {
          const cached = await env.KV.get(cacheKey, "json");
          if (cached) return cached;
        }
        const { globalRecord: data } = await resolveGlobalContext(db, slug);
        if (opts?.cache !== false && env.KV && data) {
          await env.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 3600 });
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
        const now = /* @__PURE__ */ new Date();
        const created = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          name: input.name?.trim() || slug,
          slug,
          description: input.description?.trim() || null,
          data: JSON.stringify(input.data && typeof input.data === "object" ? input.data : {}),
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
          data: JSON.stringify(data),
          createdAt: existing?.createdAt || now,
          updatedAt: now
        }).onConflictDoUpdate({
          target: globals.slug,
          set: {
            name: globalConfig?.name || existing?.name || slug,
            description: globalConfig?.description || existing?.description || null,
            data: JSON.stringify(data),
            updatedAt: now
          }
        });
        if (env.KV) {
          await env.KV.delete("talisman:globals:all");
          await env.KV.delete(`talisman:globals:${slug}`);
        }
        return await db.query.globals.findFirst({
          // @ts-ignore
          where: (g, { eq: eq2 }) => eq2(g.slug, slug)
        });
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
          const cached = await env.KV.get(cacheKey, "json");
          if (cached) return cached;
        }
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
          await env.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 3600 });
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
            where: (e, operators) => versionMode === "published" ? operators.and(operators.eq(e.collectionId, collection.id), operators.eq(e.status, "published"), operators.eq(e.slug, slug)) : operators.and(operators.eq(e.collectionId, collection.id), operators.eq(e.slug, slug)),
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
          const cached = await env.KV.get(cacheKey, "json");
          if (cached) return cached;
        }
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
          await env.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 3600 });
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
          const insertPayload = prepareNativeWritePayload(collection, data || {}, "create");
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
            }, DEFAULT_PUBLISHING_WORKFLOW_BINDING);
          }
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
            const updatePayload = prepareNativeWritePayload(collection, data, "update");
            await db.update(nativeTable).set(updatePayload).where(eq(nativeTable[nativeIdCol], id));
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
            }, DEFAULT_PUBLISHING_WORKFLOW_BINDING);
          }
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
    },
    tasks: {
      async enqueueImageProcessing(mediaId) {
        if (!env.QUEUE) {
          console.warn("Queues are not bound. Skiping background image processing.");
          return false;
        }
        await env.QUEUE.send({ type: "process-image", mediaId });
        return true;
      }
    }
  };
}

export {
  createDbClient,
  getClient
};
