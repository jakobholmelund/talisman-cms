import {
  canAccessCollection
} from "./chunk-7VUPBVR5.js";
import {
  DEFAULT_PUBLISHING_WORKFLOW_BINDING,
  NATIVE_CACHE_TTL_SECONDS,
  cacheKeys,
  createDraftEntry,
  getEntryRevision,
  getLatestRevision,
  invalidateCollectionCache,
  invalidateEntryCache,
  invalidateGlobalCache,
  listEntryRevisions,
  normalizeEntryDataForRead,
  readCache,
  restoreEntryRevision,
  rowsUpdatedSince,
  saveDraftEntry,
  toEditableEntry,
  triggerPublishingWorkflow,
  writeCache
} from "./chunk-O5JSH6E5.js";
import {
  collections,
  entries,
  globals,
  schema_exports
} from "./chunk-VOL6BL52.js";
import {
  deleteStoredMedia,
  isMediaCollection
} from "./chunk-WO46ICPJ.js";
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
  getRelationTargets,
  isGlobalData,
  isInlineComponentValue,
  isPolymorphicRelationField,
  isRelationReference,
  nextNativeUpdatedAt,
  normalizeBlankNativeValues,
  pickConfiguredNativeFields
} from "./chunk-6DE4JXMX.js";

// src/service/config.ts
function configFromModules(modules) {
  return {
    collections: modules.config?.collections ?? [],
    globals: modules.config?.globals ?? [],
    uiLibraries: modules.uiLibraries?.uiLibraries ?? [],
    nativeSchemas: modules.nativeSchemas?.nativeSchemas ?? {},
    collectionHooks: modules.collectionHooks?.collectionHooks ?? {},
    publishingWorkflowBinding: modules.config?.publishing?.workflowBinding || DEFAULT_PUBLISHING_WORKFLOW_BINDING
  };
}
async function optionalModule(load) {
  try {
    return await load();
  } catch {
    return null;
  }
}
var loaded = null;
function loadServiceConfig() {
  loaded ??= (async () => configFromModules({
    config: await optionalModule(() => import("virtual:talisman-cms/config")),
    uiLibraries: await optionalModule(() => import("virtual:talisman-cms/ui-libraries")),
    nativeSchemas: await optionalModule(() => import("virtual:talisman-cms/native-schemas")),
    collectionHooks: await optionalModule(() => import("virtual:talisman-cms/collection-hooks"))
  }))();
  return loaded;
}

// src/service/errors.ts
var ServiceError = class extends Error {
  code;
  status;
  constructor(code, status, message, options) {
    super(message, options);
    this.name = "ServiceError";
    this.code = code;
    this.status = status;
  }
};
var ValidationError = class extends ServiceError {
  issues;
  /** Extra members of the admin API's error body, such as zod's `flatten()` output for globals. */
  details;
  constructor(issues, details, message = formatValidationIssues(issues).error) {
    super("invalid_input", 400, message);
    this.name = "ValidationError";
    this.issues = issues;
    this.details = details;
  }
};
var InvalidInputError = class extends ServiceError {
  constructor(message) {
    super("invalid_input", 400, message);
    this.name = "InvalidInputError";
  }
};
var AccessDeniedError = class extends ServiceError {
  constructor(message = "Collection access denied") {
    super("forbidden", 403, message);
    this.name = "AccessDeniedError";
  }
};
var NotFoundError = class extends ServiceError {
  constructor(message) {
    super("not_found", 404, message);
    this.name = "NotFoundError";
  }
};
var PayloadTooLargeError = class extends ServiceError {
  constructor(message = "The request body is too large.") {
    super("payload_too_large", 413, message);
    this.name = "PayloadTooLargeError";
  }
};
var ConflictError = class extends ServiceError {
  version;
  constructor(message, options = {}) {
    super(options.code ?? "conflict", 409, message);
    this.name = "ConflictError";
    if (options.code === "stale_record") this.version = options.version ?? null;
  }
};
var PreconditionRequiredError = class extends ServiceError {
  constructor(message = "expectedRevisionId is required") {
    super("precondition_required", 428, message);
    this.name = "PreconditionRequiredError";
  }
};
var NATIVE_RECORD_CONFLICT_MESSAGE = "This record changed since it was opened. Reload it before saving.";
var NativeRecordConflictError = class extends ServiceError {
  constructor() {
    super("conflict", 409, NATIVE_RECORD_CONFLICT_MESSAGE);
    this.name = "NativeRecordConflictError";
  }
};
var UnsupportedOperationError = class extends ServiceError {
  constructor(message) {
    super("unsupported", 400, message);
    this.name = "UnsupportedOperationError";
  }
};
var ConstraintError = class extends ServiceError {
  constructor(status, message, options) {
    super(status === 409 ? "conflict" : status === 413 ? "payload_too_large" : "invalid_input", status, message, options);
    this.name = "ConstraintError";
  }
};
var HookError = class extends ServiceError {
  phase;
  committed;
  constructor(cause, phase) {
    super("hook_failed", 500, cause instanceof Error ? cause.message : "A collection hook failed", { cause });
    this.name = "HookError";
    this.phase = phase;
    this.committed = phase === "afterChange" || phase === "afterDelete";
  }
};
function isServiceError(error) {
  return error instanceof ServiceError;
}

// src/service/actor.ts
var systemActor = (label) => ({ kind: "system", label });
var userActor = (user, request) => ({ kind: "user", user, request });
function assertAllowed(actor, collection, operation) {
  if (actor.kind !== "user") return;
  const { user } = actor;
  const transition = operation === "publish" || operation === "archive" || operation === "restore";
  if ((operation === "delete" || transition) && user.role !== "admin") {
    throw new AccessDeniedError("Admin access required");
  }
  if (!canAccessCollection(collection, user, transition ? "update" : operation)) {
    throw new AccessDeniedError("Collection access denied");
  }
  if (operation !== "read" && collection.readOnly) {
    throw new AccessDeniedError(transition ? "Collection access denied" : "This collection is read-only");
  }
  if (operation === "create" && isMediaCollection(collection)) {
    throw new AccessDeniedError("Media records are created by uploading a file to the media library.");
  }
}
function canRead(actor, collection) {
  return canAccessCollection(collection, actor.kind === "user" ? actor.user : { role: "editor" }, "read");
}

// src/db/client.ts
import { drizzle } from "drizzle-orm/d1";
function createDbClient(env) {
  if (!env.DB) {
    throw new Error('Talisman CMS requires a D1 database bound to the "DB" environment variable.');
  }
  return drizzle(env.DB, { schema: schema_exports });
}
var statusTarget = (status) => status === "published" || status === "archived" ? status : void 0;
function getClient(env, ctx, options = {}) {
  const service = async () => createService(env, { config: await loadServiceConfig(), ctx, actor: options.actor });
  return {
    collections: {
      findMany: async (opts) => (await service()).collections.list({ cache: opts?.cache })
    },
    globals: {
      findMany: async (opts) => (await service()).globals.list({ cache: opts?.cache }),
      find: async (slug, opts) => (await service()).globals.get(slug, { cache: opts?.cache }),
      create: async (input) => (await service()).globals.create(input),
      /**
       * Saves a global's data. `expectedVersion`, the `version` a read returned, makes the save fail
       * with a `stale_record` ConflictError when another save came first; without it the save wins.
       */
      save: async (slug, data, opts) => (await service()).globals.save(slug, data, opts),
      /** The same as `save`, under the name earlier releases used. */
      update: async (slug, data, opts) => (await service()).globals.save(slug, data, opts)
    },
    entries: {
      findMany: async (collectionSlug, opts) => (await service()).entries.findMany(collectionSlug, opts),
      findBySlug: async (collectionSlug, slug, opts) => (await service()).entries.findBySlug(collectionSlug, slug, opts),
      find: async (collectionSlug, id, opts) => await (await service()).entries.find(collectionSlug, String(id), opts) ?? void 0,
      create: async (collectionSlug, data, opts) => (await service()).entries.create(collectionSlug, { data, slug: opts?.slug, status: statusTarget(opts?.status) }),
      update: async (collectionSlug, id, data, opts) => (await service()).entries.update(collectionSlug, String(id), {
        data,
        slug: opts?.slug,
        status: statusTarget(opts?.status),
        expect: { revisionId: opts?.expectedRevisionId, updatedAt: opts?.expectedUpdatedAt }
      }),
      delete: async (collectionSlug, id) => {
        await (await service()).entries.remove(collectionSlug, String(id));
        return true;
      }
    }
  };
}

// src/service/collections.ts
import { eq } from "drizzle-orm";
function oncePerDatabase(runs, binding, run) {
  const key = binding && typeof binding === "object" ? binding : null;
  if (!key) return run();
  let pending = runs.get(key);
  if (!pending) {
    pending = run();
    runs.set(key, pending);
    pending.catch(() => runs.delete(key));
  }
  return pending;
}
var syncs = /* @__PURE__ */ new WeakMap();
var memos = /* @__PURE__ */ new WeakMap();
function memoFor(binding) {
  if (!binding || typeof binding !== "object") return null;
  let memo = memos.get(binding);
  if (!memo) {
    memo = /* @__PURE__ */ new Map();
    memos.set(binding, memo);
  }
  return memo;
}
function configuredCollectionFields(collectionConfig, nativeSchemas) {
  const fields = collectionConfig.fields || [];
  if (fields.length === 0 && collectionConfig.nativeSchemaMapping && nativeSchemas[collectionConfig.slug]) {
    return generateFieldsFromDrizzle(nativeSchemas[collectionConfig.slug]);
  }
  return fields;
}
function syncCollectionDefinitions(db, env, config) {
  const binding = env.DB;
  return oncePerDatabase(syncs, binding, async () => {
    const memo = memoFor(binding);
    const stored = await db.select().from(collections);
    const storedBySlug = new Map(stored.map((row) => [row.slug, row]));
    for (const row of stored) memo?.set(row.slug, row);
    const now = /* @__PURE__ */ new Date();
    const missing = [];
    const writes = [];
    for (const collectionConfig of config.collections) {
      const fields = configuredCollectionFields(collectionConfig, config.nativeSchemas);
      const row = storedBySlug.get(collectionConfig.slug);
      if (!row) {
        missing.push({ id: crypto.randomUUID(), name: collectionConfig.name, slug: collectionConfig.slug, fields, createdAt: now });
      } else if (row.name !== collectionConfig.name || JSON.stringify(row.fields) !== JSON.stringify(fields)) {
        writes.push(db.update(collections).set({ name: collectionConfig.name, fields }).where(eq(collections.id, row.id)));
        memo?.set(row.slug, { ...row, name: collectionConfig.name, fields });
      }
    }
    for (let index = 0; index < missing.length; index += 10) {
      writes.push(db.insert(collections).values(missing.slice(index, index + 10)).onConflictDoNothing({ target: collections.slug }));
    }
    if (writes.length > 0) {
      await db.batch(writes);
      await invalidateCollectionCache(env);
    }
    if (missing.length > 0) {
      for (const row of await db.select().from(collections)) memo?.set(row.slug, row);
    }
  });
}
async function resolveCollectionRecord(db, env, config, slug) {
  await syncCollectionDefinitions(db, env, config);
  const memo = memoFor(env.DB);
  const known = memo?.get(slug);
  if (known) return known;
  const lookup = () => db.select().from(collections).where(eq(collections.slug, slug)).limit(1).then((rows) => rows[0]);
  let row = await lookup();
  if (!row) {
    const collectionConfig = config.collections.find((candidate) => candidate.slug === slug);
    if (!collectionConfig) throw new NotFoundError(`Collection ${slug} not found`);
    await db.insert(collections).values({
      id: crypto.randomUUID(),
      name: collectionConfig.name,
      slug,
      fields: configuredCollectionFields(collectionConfig, config.nativeSchemas),
      createdAt: /* @__PURE__ */ new Date()
    }).onConflictDoNothing({ target: collections.slug });
    await invalidateCollectionCache(env);
    row = await lookup();
    if (!row) throw new Error(`Collection ${slug} could not be initialized`);
  }
  memo?.set(slug, row);
  return row;
}
async function resolveCollection(ctx, slug) {
  const { config } = ctx;
  const collectionConfig = config.collections.find((candidate) => candidate.slug === slug);
  const record = await resolveCollectionRecord(ctx.db, ctx.env, config, slug);
  if (!collectionConfig) {
    const storedFields = Array.isArray(record.fields) ? record.fields : [];
    return {
      slug,
      config: { name: record.name, slug, fields: storedFields },
      record,
      activeFields: storedFields,
      nativeTable: null,
      nativeIdCol: "id",
      configured: false
    };
  }
  const nativeTable = collectionConfig.nativeSchemaMapping && config.nativeSchemas[slug] ? config.nativeSchemas[slug] : null;
  return {
    slug,
    config: collectionConfig,
    record,
    activeFields: configuredCollectionFields(collectionConfig, config.nativeSchemas),
    nativeTable,
    nativeIdCol: getNativeIdColumn(collectionConfig),
    hooks: config.collectionHooks[slug],
    configured: true
  };
}
function collectionsService(ctx) {
  return {
    /** The stored collection rows after the configured ones are synced; cached for server code unless it opts out. */
    async list(options = {}) {
      const { env, db } = ctx;
      const useCache = (options.cache ?? ctx.actor.kind !== "user") && Boolean(env.KV);
      if (useCache) {
        const hit = await readCache(env.KV, cacheKeys.collections());
        if (hit) return hit;
      }
      await syncCollectionDefinitions(db, env, ctx.config);
      const rows = await db.query.collections.findMany();
      if (useCache) await writeCache(env.KV, cacheKeys.collections(), rows, ctx.ctx);
      return rows;
    }
  };
}

// src/service/entries.ts
import { and as and2, desc as desc2, eq as eq3, getTableColumns as getTableColumns2, isNull as isNull2, lt as lt2, or, sql as sql2 } from "drizzle-orm";

// src/service/hooks.ts
async function runHooks(hooks, phase, args, options = {}) {
  const list = hooks?.[phase] ?? [];
  const merges = phase === "beforeValidate" || phase === "beforeChange";
  let data = args.data;
  for (const hook of list) {
    options.log?.push({
      hook: phase,
      operation: args.operation,
      collection: args.collection.slug,
      actorKind: args.actor.kind,
      dataKeys: data && typeof data === "object" ? Object.keys(data).sort() : []
    });
    let result;
    try {
      result = await hook(merges ? { ...args, data } : args);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new HookError(error, phase);
    }
    if (merges && result) data = { ...data, ...result };
  }
  return merges ? data : void 0;
}

// src/service/query.ts
import { and, asc, desc, eq as eq2, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm";
var MAX_WHERE_CLAUSES = 8;
var MAX_SORT_KEYS = 2;
var MAX_OFFSET = 1e4;
var MAX_BOUND_PARAMETERS = 90;
var OPERATORS = /* @__PURE__ */ new Set(["eq", "ne", "in", "lt", "lte", "gt", "gte", "contains", "isNull"]);
var ORDERED_TYPES = /* @__PURE__ */ new Set(["number", "date", "timestamp"]);
var ENTRY_SYSTEM_FIELDS = {
  id: { type: "text", column: "id" },
  slug: { type: "text", column: "slug" },
  status: { type: "text", column: "status" },
  createdAt: { type: "timestamp", column: "createdAt" },
  updatedAt: { type: "timestamp", column: "updatedAt" },
  publishedAt: { type: "timestamp", column: "publishedAt" }
};
function entryDataExpression(view) {
  const entries2 = entries;
  return view === "published" ? sql`CASE WHEN ${entries2.status} = 'published' AND ${entries2.publishedData} IS NOT NULL THEN ${entries2.publishedData} ELSE ${entries2.data} END` : sql`${entries2.data}`;
}
function refuse(name, message) {
  throw new ValidationError([{ path: [name], message }]);
}
var isColumn = (value) => Boolean(value) && typeof value === "object" && "dataType" in value;
function resolveField(target, name) {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return refuse(String(name), "Not a field of this collection");
  if (target.kind === "entries") {
    const system = ENTRY_SYSTEM_FIELDS[name];
    if (system) return { name, type: system.type, json: false, list: false, expression: entries[system.column], parameters: 0 };
    const field2 = target.fields.find((candidate) => candidate.name === name);
    if (!field2) return refuse(name, "Not a field of this collection");
    const list = field2.type === "array" || Boolean(field2.hasMany);
    return { name, type: field2.type, json: true, list, expression: sql`json_extract(${target.data}, ${"$." + name})`, parameters: 1 };
  }
  const columns = target.table;
  const property = isColumn(columns[name]) ? name : Object.keys(columns).find((key) => isColumn(columns[key]) && columns[key].name === name);
  if (!property) return refuse(name, "Not a field of this collection");
  const column = columns[property];
  const field = target.fields.find((candidate) => candidate.name === property || candidate.name === column.name);
  const type = field?.type ?? (column.dataType === "date" ? "timestamp" : column.dataType === "number" ? "number" : column.dataType === "boolean" ? "boolean" : "text");
  return { name, type, json: false, list: false, expression: column, parameters: 0 };
}
function castValue(field, value) {
  if (value === null) return null;
  switch (field.type) {
    case "number": {
      const number = typeof value === "number" ? value : Number(value);
      if (typeof value === "boolean" || Number.isNaN(number)) refuse(field.name, `"${value}" is not a number`);
      return number;
    }
    case "boolean": {
      const bool = value === true || value === "true" ? true : value === false || value === "false" ? false : null;
      if (bool === null) refuse(field.name, `"${value}" is not true or false`);
      return field.json ? bool ? 1 : 0 : bool;
    }
    case "timestamp": {
      const date = typeof value === "number" ? new Date(value) : new Date(String(value));
      if (Number.isNaN(date.getTime())) refuse(field.name, `"${value}" is not a date`);
      return date;
    }
    default:
      return typeof value === "boolean" ? String(value) : value;
  }
}
function compileQuery(target, query) {
  let parameters = 0;
  const clauses = [];
  const entries2 = Object.entries(query.where ?? {});
  if (entries2.length > MAX_WHERE_CLAUSES) throw new InvalidInputError(`where takes at most ${MAX_WHERE_CLAUSES} fields.`);
  for (const [name, condition] of entries2) {
    const field = resolveField(target, name);
    const operators = condition !== null && typeof condition === "object" && !Array.isArray(condition) ? condition : { eq: condition };
    for (const [operator, raw] of Object.entries(operators)) {
      if (!OPERATORS.has(operator)) refuse(name, `"${operator}" is not a comparison`);
      parameters += field.parameters;
      switch (operator) {
        case "eq":
        case "ne": {
          const value = castValue(field, raw);
          if (value === null) {
            clauses.push(operator === "eq" ? isNull(field.expression) : isNotNull(field.expression));
          } else {
            parameters += 1;
            clauses.push(operator === "eq" ? eq2(field.expression, value) : ne(field.expression, value));
          }
          break;
        }
        case "in": {
          const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [raw];
          if (list.length === 0) refuse(name, "in needs at least one value");
          const values = list.map((value) => castValue(field, value));
          if (values.some((value) => value === null)) refuse(name, "in does not take null; use isNull");
          parameters += values.length;
          clauses.push(inArray(field.expression, values));
          break;
        }
        case "lt":
        case "lte":
        case "gt":
        case "gte": {
          if (!ORDERED_TYPES.has(field.type)) refuse(name, `${operator} needs a number or date field`);
          const value = castValue(field, raw);
          if (value === null) refuse(name, `${operator} does not take null`);
          parameters += 1;
          const compare = { lt, lte, gt, gte }[operator];
          clauses.push(compare(field.expression, value));
          break;
        }
        case "contains": {
          if (!field.json || !field.list) refuse(name, "contains needs a relationship with hasMany or an array field");
          const value = castValue(field, raw);
          if (value === null) refuse(name, "contains does not take null");
          parameters += 1;
          clauses.push(sql`EXISTS (SELECT 1 FROM json_each(${field.expression}) WHERE json_each.value = ${value})`);
          break;
        }
        case "isNull": {
          if (raw !== true && raw !== false && raw !== "true" && raw !== "false") refuse(name, "isNull takes true or false");
          clauses.push(raw === true || raw === "true" ? isNull(field.expression) : isNotNull(field.expression));
          break;
        }
      }
    }
  }
  if (parameters > MAX_BOUND_PARAMETERS) throw new InvalidInputError(`The query binds too many values (at most ${MAX_BOUND_PARAMETERS}).`);
  const sortKeys = (typeof query.sort === "string" ? query.sort.split(",") : query.sort ?? []).map((key) => key.trim()).filter(Boolean);
  if (sortKeys.length > MAX_SORT_KEYS) throw new InvalidInputError(`sort takes at most ${MAX_SORT_KEYS} fields.`);
  const orderBy = sortKeys.map((key) => {
    const descending = key.startsWith("-");
    const field = resolveField(target, descending ? key.slice(1) : key);
    return descending ? desc(field.expression) : asc(field.expression);
  });
  if (query.offset !== void 0 && (!Number.isSafeInteger(query.offset) || query.offset < 0 || query.offset > MAX_OFFSET)) {
    throw new InvalidInputError(`offset must be a whole number from 0 to ${MAX_OFFSET}.`);
  }
  return {
    where: clauses.length > 0 ? and(...clauses) : void 0,
    orderBy,
    offset: query.offset,
    /** Whether the query narrows, orders or skips, in which case its result is never cached. */
    custom: clauses.length > 0 || orderBy.length > 0 || Boolean(query.offset)
  };
}

// src/service/relations.ts
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
function relationFields(collection) {
  if (collection.activeFields.length > 0) return collection.activeFields;
  const stored = collection.record.fields;
  return typeof stored === "string" ? JSON.parse(stored) : stored;
}
async function findRelatedEntries(ctx, targetCollectionId, ids, versionMode) {
  const chunks = [];
  for (let index = 0; index < ids.length; index += RELATION_ID_CHUNK_SIZE) {
    chunks.push(ids.slice(index, index + RELATION_ID_CHUNK_SIZE));
  }
  const results = await Promise.all(chunks.map((chunk) => ctx.db.query.entries.findMany({
    where: (e, operators) => versionMode === "published" ? operators.and(operators.eq(e.collectionId, targetCollectionId), operators.inArray(e.id, chunk), operators.eq(e.status, "published")) : operators.and(operators.eq(e.collectionId, targetCollectionId), operators.inArray(e.id, chunk))
  })));
  return results.flat();
}
async function resolveRelationships(ctx, entriesToResolve, collection, depth = 1, versionMode = "published") {
  if (depth <= 0 || !entriesToResolve || entriesToResolve.length === 0) return entriesToResolve;
  const fieldsConfig = relationFields(collection);
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
    const targetConfig = ctx.config.collections.find((candidate) => candidate.slug === relationSlug);
    if (targetConfig && !canRead(ctx.actor, targetConfig)) continue;
    let targetCollection;
    try {
      targetCollection = await resolveCollection(ctx, relationSlug);
    } catch (error) {
      if (error instanceof NotFoundError) continue;
      throw error;
    }
    if (idsToFetch.size === 0) continue;
    let relatedDocs = await findRelatedEntries(ctx, targetCollection.record.id, Array.from(idsToFetch), versionMode);
    relatedDocs = relatedDocs.map((doc) => normalizeEntryDataForRead(doc, versionMode));
    if (depth > 1) {
      relatedDocs = await resolveRelationships(ctx, relatedDocs, targetCollection, depth - 1, versionMode);
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

// src/service/validation.ts
import { getTableColumns } from "drizzle-orm";

// src/presets.ts
function getUiLibraryComponentDefinition(libraries, libraryId, componentSlug) {
  if (!libraries || !libraryId || !componentSlug) return null;
  return libraries.find((library) => library.id === libraryId)?.components?.find((componentAdapter) => componentAdapter.component.slug === componentSlug)?.component || null;
}
function parsePresetPropsJson(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return { success: true, data: {} };
  }
  try {
    return {
      success: true,
      data: JSON.parse(value)
    };
  } catch (error) {
    return {
      success: false,
      error: error?.message || "Invalid JSON"
    };
  }
}
function validatePresetPayload(libraries, data) {
  const component = getUiLibraryComponentDefinition(libraries, data.libraryId, data.componentSlug);
  if (!component) {
    return {
      success: false,
      issues: [
        {
          path: ["componentSlug"],
          message: "Selected component is not registered for the chosen library."
        }
      ]
    };
  }
  const parsedProps = parsePresetPropsJson(data.propsJson);
  if (!parsedProps.success) {
    return {
      success: false,
      issues: [
        {
          path: ["propsJson"],
          message: `Preset props must be valid JSON: ${parsedProps.error}`
        }
      ]
    };
  }
  const propsSchema = buildZodSchemaForFields(component.fields);
  const validatedProps = propsSchema.safeParse(parsedProps.data);
  if (!validatedProps.success) {
    return {
      success: false,
      issues: validatedProps.error.issues.map((issue) => ({
        path: ["presetProps", ...issue.path],
        message: issue.message
      }))
    };
  }
  return {
    success: true,
    component,
    props: validatedProps.data,
    normalizedData: {
      ...data,
      propsJson: JSON.stringify(validatedProps.data)
    }
  };
}

// src/service/validation.ts
var UPLOAD_MANAGED_MEDIA_FIELDS = ["url", "mimeType"];
var PRESETS_COLLECTION = "_ui_component_presets";
var isBlank = (value) => value === void 0 || value === null || value === "";
function readEntryData(data) {
  let value = data;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new InvalidInputError("Entry data is not valid JSON.");
    }
  }
  if (!isGlobalData(value)) throw new InvalidInputError("Entry data must be a JSON object.");
  return value;
}
function describeInvalidNativeId(value) {
  if (isBlank(value)) return null;
  if (typeof value === "number") return Number.isSafeInteger(value) ? null : "Record id must be a whole number or text";
  return describeInvalidEntryId(value);
}
function nativeSystemColumns(collection) {
  return [collection.nativeIdCol, "createdAt", "updatedAt"];
}
function invalid(message, path = []) {
  throw new ValidationError([{ path, message }]);
}
function writableColumns(actor, requested) {
  return actor.kind === "user" ? "configured" : requested ?? "any";
}
function prepareNativeWrite(collection, data, options) {
  const payload = { ...data };
  const columns = getTableColumns(collection.nativeTable);
  const idColumn = collection.nativeIdCol;
  for (const field of collection.activeFields) {
    if (field.type === "array" && field.fields?.length === 1 && field.fields[0].name === "url" && Array.isArray(payload[field.name])) {
      payload[field.name] = payload[field.name].map(
        (item) => item && typeof item === "object" && "url" in item ? item.url : item
      );
    }
  }
  for (const key of nativeSystemColumns(collection)) {
    if (payload[key] === "") delete payload[key];
  }
  const dateColumn = (key) => columns[key]?.dataType === "date";
  const blank = (key) => payload[key] === void 0 || payload[key] === null;
  if (options.mode === "update") {
    delete payload[idColumn];
    if (!options.trusted) delete payload.createdAt;
    if (dateColumn("updatedAt") && (!options.trusted || blank("updatedAt"))) {
      payload.updatedAt = nextNativeUpdatedAt(options.stored?.updatedAt);
    }
    return payload;
  }
  const idField = collection.activeFields.find((field) => field.name === idColumn);
  const column = columns[idColumn];
  if (blank(idColumn) && idField?.type !== "number" && column?.dataType !== "number" && !(column?.hasDefault || column?.defaultFn)) {
    payload[idColumn] = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
  const now = /* @__PURE__ */ new Date();
  for (const key of ["createdAt", "updatedAt"]) {
    if (dateColumn(key) && (!options.trusted || blank(key) && !columns[key].hasDefault)) payload[key] = now;
  }
  return payload;
}
async function prepareWrite(input) {
  const { collection, operation, actor } = input;
  const { config, activeFields, nativeTable, nativeIdCol } = collection;
  const columns = writableColumns(actor, input.columns);
  const hookArgs = { actor, req: input.req, collection: { slug: collection.slug, native: Boolean(nativeTable) }, operation, originalDoc: input.originalDoc };
  const hookOptions = { log: input.log };
  let slug;
  if (!nativeTable) {
    if (operation === "create") {
      const idProblem = isBlank(input.id) ? null : describeInvalidEntryId(input.id);
      if (idProblem) invalid(idProblem);
      const slugProblem = isBlank(input.slug) ? null : describeInvalidEntrySlug(input.slug);
      if (slugProblem) invalid(slugProblem);
    } else {
      const current = input.stored?.draftSlug || input.stored?.slug;
      const renamed = !isBlank(input.slug) && input.slug !== current;
      const slugProblem = renamed ? describeInvalidEntrySlug(input.slug) : null;
      if (slugProblem) invalid(slugProblem);
    }
    slug = isBlank(input.slug) ? void 0 : String(input.slug);
  }
  const id = operation === "create" && !isBlank(input.id) ? input.id : void 0;
  if (input.data === void 0) {
    if (operation === "create") return prepareWrite({ ...input, data: {} });
    return { slug };
  }
  let data = readEntryData(input.data);
  if (nativeTable) {
    if (columns === "configured") {
      const unwritable = findUnwritableNativeColumns(activeFields, nativeTable, data, {
        ignore: nativeSystemColumns(collection),
        stored: operation === "update" ? input.stored : void 0
      });
      if (unwritable.length > 0) {
        throw new ValidationError(unwritable.map((column) => ({
          path: [column],
          message: "Not a field of this collection, so it cannot be saved here"
        })));
      }
      let submitted = pickConfiguredNativeFields(activeFields, nativeTable, data);
      if (operation === "update" && isMediaCollection(config)) {
        const changed = UPLOAD_MANAGED_MEDIA_FIELDS.filter((field) => field in submitted && submitted[field] !== input.stored?.[field]);
        if (changed.length > 0) {
          throw new ValidationError(changed.map((field) => ({ path: [field], message: "Set by the upload and cannot be changed" })));
        }
        submitted = { ...submitted };
        for (const field of UPLOAD_MANAGED_MEDIA_FIELDS) delete submitted[field];
      }
      data = submitted;
    }
    data = normalizeBlankNativeValues(config, activeFields, nativeTable, data);
    if (operation === "create") {
      for (const [value, path] of [[id, []], [data[nativeIdCol], [nativeIdCol]]]) {
        const problem = describeInvalidNativeId(value);
        if (problem) invalid(problem, [...path]);
      }
    }
  }
  data = await runHooks(input.hooks, "beforeValidate", { ...hookArgs, data }, hookOptions);
  const schema = buildZodSchemaForCollection({ ...config, fields: activeFields });
  const parsed = (nativeTable && operation === "update" ? schema.partial() : schema).safeParse(data);
  if (!parsed.success) throw new ValidationError(parsed.error.issues);
  data = parsed.data;
  if (collection.slug === PRESETS_COLLECTION) {
    const result = validatePresetPayload(input.uiLibraries, data);
    if (!result.success) throw new ValidationError(result.issues);
    data = result.normalizedData;
  }
  data = await runHooks(input.hooks, "beforeChange", { ...hookArgs, data }, hookOptions);
  const prepared = { data, slug, id: id === void 0 ? void 0 : String(id) };
  if (nativeTable) {
    prepared.nativePayload = prepareNativeWrite(collection, {
      ...data,
      ...operation === "create" && nativeTable[nativeIdCol] && id !== void 0 ? { [nativeIdCol]: id } : {}
    }, { mode: operation, stored: input.stored, trusted: columns === "any" });
  }
  return prepared;
}

// src/service/entries.ts
var MAX_PAGE_SIZE = 200;
function siteCacheWanted(options, native) {
  return native ? options.cache === true : options.cache !== false;
}
var NATIVE_PUBLISHING_MESSAGE = "Publishing workflows are not available for native collections";
var NATIVE_REVISIONS_MESSAGE = "Revision history is not available for native collections";
function queryTarget(collection, view) {
  return collection.nativeTable ? { kind: "native", fields: collection.activeFields, table: collection.nativeTable } : { kind: "entries", fields: collection.activeFields, data: entryDataExpression(view) };
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
function timestampKey(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value))) return Date.parse(value);
  return value ?? null;
}
function encodeCursor(position) {
  const bytes = new TextEncoder().encode(JSON.stringify(position));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeCursor(cursor) {
  try {
    const binary = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const position = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
    if (Array.isArray(position)) return position;
  } catch {
  }
  throw new InvalidInputError("The cursor is not valid.");
}
async function resolveExpectedRevision(ctx, entryId, value) {
  if (typeof value === "string" && value) return value;
  if (value === null) return null;
  if (ctx.actor.kind !== "user") return void 0;
  if (await getLatestRevision(ctx.db, entryId)) throw new PreconditionRequiredError();
  return null;
}
async function latestRevisionId(ctx, entryId) {
  return (await getLatestRevision(ctx.db, entryId))?.id ?? null;
}
async function withRevision(ctx, entry) {
  return { ...toEditableEntry(entry), latestRevisionId: await latestRevisionId(ctx, entry.id) };
}
function configuredFor(ctx, slug) {
  const config = ctx.config.collections.find((candidate) => candidate.slug === slug);
  if (!config) return null;
  const nativeTable = config.nativeSchemaMapping && ctx.config.nativeSchemas[slug] ? ctx.config.nativeSchemas[slug] : null;
  return { config, nativeTable };
}
function hookContext(ctx, collection) {
  return {
    actor: ctx.actor,
    req: ctx.actor.request,
    collection: { slug: collection.slug, native: Boolean(collection.nativeTable) }
  };
}
function writeInput(ctx, collection) {
  return {
    collection,
    actor: ctx.actor,
    req: ctx.actor.request,
    uiLibraries: ctx.config.uiLibraries,
    hooks: collection.hooks,
    log: ctx.log
  };
}
async function nativeRow(ctx, collection, id) {
  const { nativeTable, nativeIdCol } = collection;
  const rows = await ctx.db.select().from(nativeTable).where(eq3(nativeTable[nativeIdCol], id));
  return rows[0];
}
async function entryRow(ctx, collection, id) {
  return ctx.db.query.entries.findFirst({
    // @ts-ignore
    where: (e, { eq: eq5, and: and4 }) => and4(eq5(e.collectionId, collection.record.id), eq5(e.id, id))
  });
}
function assertPublishable(collection, entry) {
  const draftData = typeof entry.data === "string" ? JSON.parse(entry.data) : entry.data;
  const parsed = buildZodSchemaForCollection({ ...collection.config, fields: collection.activeFields }).safeParse(draftData ?? {});
  if (!parsed.success) throw new ValidationError(parsed.error.issues);
}
function entriesService(ctx) {
  const { db, env } = ctx;
  async function transition(collection, entryId, action, expect) {
    if (collection.nativeTable) throw new UnsupportedOperationError(NATIVE_PUBLISHING_MESSAGE);
    const entry = await entryRow(ctx, collection, entryId);
    if (!entry) throw new NotFoundError("Entry not found");
    const expectedRevisionId = await resolveExpectedRevision(ctx, entryId, expect?.revisionId);
    if (action === "publish") assertPublishable(collection, entry);
    const updated = await triggerPublishingWorkflow(env, {
      collectionSlug: collection.slug,
      entryId,
      action,
      expectedRevisionId
    }, ctx.config.publishingWorkflowBinding);
    await invalidateEntryCache(env, collection.slug, entryId);
    return { ...await withRevision(ctx, updated), workflow: updated.workflow };
  }
  return {
    /** The collection an operation addresses, with its row, fields, native table and hooks. */
    resolve: (slug) => resolveCollection(ctx, slug),
    /** Every record of the collection as the admin edits it: all statuses, draft data, newest first unless sorted. */
    async list(slug, query = {}) {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, "read");
      if (query.offset !== void 0) throw new InvalidInputError("offset needs a limit.");
      const compiled = compileQuery(queryTarget(collection, "draft"), query);
      if (collection.nativeTable) {
        const rows2 = await db.select().from(collection.nativeTable).where(compiled.where).orderBy(...compiled.orderBy);
        return rows2.map((row) => mapNativeEntry(row, collection.record.id, collection.nativeIdCol));
      }
      const entries2 = entries;
      const rows = await db.select().from(entries2).where(and2(eq3(entries2.collectionId, collection.record.id), compiled.where)).orderBy(...compiled.orderBy.length > 0 ? compiled.orderBy : [desc2(entries2.createdAt)]);
      return rows.map(toEditableEntry);
    },
    /**
     * One page of the collection, newest first; `nextCursor` continues after it. A `where` narrows
     * the pages. A `sort` or `offset` pages by offset instead, since the cursor encodes the default
     * order, and comes back without a cursor.
     */
    async page(slug, options) {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, "read");
      const limit = options.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
        throw new InvalidInputError(`limit must be a whole number from 1 to ${MAX_PAGE_SIZE}.`);
      }
      const cursor = options.cursor || null;
      const compiled = compileQuery(queryTarget(collection, "draft"), options);
      const offsetPaging = compiled.orderBy.length > 0 || compiled.offset !== void 0;
      if (cursor !== null && offsetPaging) throw new InvalidInputError("cursor works with the default sort and no offset; page with offset instead.");
      const offset = compiled.offset ?? 0;
      if (collection.nativeTable) {
        const nativeTable = collection.nativeTable;
        const rowid = sql2`rowid`;
        const after2 = cursor === null ? void 0 : decodeCursor(cursor)[0];
        if (after2 !== void 0 && !Number.isSafeInteger(after2)) throw new InvalidInputError("The cursor is not valid.");
        const rows2 = await db.select({ ...getTableColumns2(nativeTable), __rowid: rowid }).from(nativeTable).where(and2(after2 === void 0 ? void 0 : lt2(rowid, after2), compiled.where)).orderBy(...compiled.orderBy.length > 0 ? compiled.orderBy : [desc2(rowid)]).limit(limit + 1).offset(offset);
        const pageRows2 = rows2.slice(0, limit);
        const nextCursor2 = rows2.length > limit && !offsetPaging ? encodeCursor([pageRows2[pageRows2.length - 1].__rowid]) : null;
        return { docs: pageRows2.map(({ __rowid, ...row }) => mapNativeEntry(row, collection.record.id, collection.nativeIdCol)), nextCursor: nextCursor2 };
      }
      const entries2 = entries;
      let after;
      if (cursor !== null) {
        const [createdAtMs, afterId] = decodeCursor(cursor);
        if (typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs) || typeof afterId !== "string") {
          throw new InvalidInputError("The cursor is not valid.");
        }
        const createdAt = new Date(createdAtMs);
        after = or(lt2(entries2.createdAt, createdAt), and2(eq3(entries2.createdAt, createdAt), lt2(entries2.id, afterId)));
      }
      const rows = await db.select().from(entries2).where(and2(eq3(entries2.collectionId, collection.record.id), after, compiled.where)).orderBy(...compiled.orderBy.length > 0 ? [...compiled.orderBy, desc2(entries2.id)] : [desc2(entries2.createdAt), desc2(entries2.id)]).limit(limit + 1).offset(offset);
      const pageRows = rows.slice(0, limit);
      const last = pageRows[pageRows.length - 1];
      const nextCursor = rows.length > limit && !offsetPaging ? encodeCursor([last.createdAt.getTime(), last.id]) : null;
      return { docs: pageRows.map(toEditableEntry), nextCursor };
    },
    /** One record as the admin edits it, with the latest revision an entry must be saved against; null when missing. */
    async get(slug, id) {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, "read");
      if (collection.nativeTable) {
        const row = await nativeRow(ctx, collection, id);
        return row ? mapNativeEntry(row, collection.record.id, collection.nativeIdCol) : null;
      }
      const entry = await entryRow(ctx, collection, id);
      return entry ? withRevision(ctx, entry) : null;
    },
    async create(slug, input = {}) {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, "create");
      const hooks = hookContext(ctx, collection);
      const prepared = await prepareWrite({ ...writeInput(ctx, collection), operation: "create", data: input.data, id: input.id, slug: input.slug, columns: input.columns });
      const validatedData = prepared.data;
      if (collection.nativeTable) {
        const nativeTable = collection.nativeTable;
        const { nativeIdCol } = collection;
        const insertPayload = prepared.nativePayload;
        const insertedRows = await db.insert(nativeTable).values(insertPayload).returning();
        const insertedRow = (Array.isArray(insertedRows) ? insertedRows[0] : null) || (insertPayload[nativeIdCol] !== void 0 && insertPayload[nativeIdCol] !== null ? await nativeRow(ctx, collection, insertPayload[nativeIdCol]) : null);
        await invalidateEntryCache(env, slug);
        if (!insertedRow) throw new Error(`Failed to load the created record of collection ${slug}`);
        const doc = mapNativeEntry(insertedRow, collection.record.id, nativeIdCol);
        await runHooks(collection.hooks, "afterChange", { ...hooks, data: validatedData, operation: "create", doc }, { log: ctx.log });
        return doc;
      }
      const created = await createDraftEntry(db, collection.record, validatedData, { id: prepared.id, slug: prepared.slug });
      await invalidateEntryCache(env, slug);
      await runHooks(collection.hooks, "afterChange", { ...hooks, data: validatedData, operation: "create", doc: created }, { log: ctx.log });
      if (input.status) {
        return transition(collection, created.id, input.status === "archived" ? "archive" : "publish", { revisionId: await latestRevisionId(ctx, created.id) });
      }
      return withRevision(ctx, created);
    },
    async update(slug, id, input = {}) {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, "update");
      const hooks = hookContext(ctx, collection);
      if (collection.nativeTable) {
        const nativeTable = collection.nativeTable;
        const { nativeIdCol } = collection;
        const stored2 = await nativeRow(ctx, collection, id);
        if (!stored2) throw new NotFoundError("Entry not found");
        const originalDoc = mapNativeEntry(stored2, collection.record.id, nativeIdCol);
        const checksUpdatedAt = input.expect?.updatedAt !== void 0 && Boolean(nativeTable.updatedAt);
        if (checksUpdatedAt && timestampKey(stored2.updatedAt) !== timestampKey(input.expect?.updatedAt)) {
          throw new NativeRecordConflictError();
        }
        const prepared2 = await prepareWrite({ ...writeInput(ctx, collection), operation: "update", data: input.data, stored: stored2, originalDoc, columns: input.columns });
        const updatePayload = prepared2.nativePayload ?? {};
        let storedRow = stored2;
        if (Object.keys(updatePayload).length > 0) {
          const unchanged = !checksUpdatedAt ? void 0 : stored2.updatedAt == null ? isNull2(nativeTable.updatedAt) : eq3(nativeTable.updatedAt, stored2.updatedAt);
          const updatedRows = await db.update(nativeTable).set(updatePayload).where(and2(eq3(nativeTable[nativeIdCol], id), unchanged)).returning();
          const updatedRow = updatedRows[0];
          if (!updatedRow && checksUpdatedAt) throw new NativeRecordConflictError();
          storedRow = updatedRow ?? { ...stored2, ...updatePayload };
        }
        await invalidateEntryCache(env, slug, id);
        const doc = {
          ...mapNativeEntry(storedRow, collection.record.id, nativeIdCol),
          slug: typeof input.slug === "string" && input.slug || stored2.slug || id
        };
        await runHooks(collection.hooks, "afterChange", { ...hooks, data: prepared2.data || {}, operation: "update", originalDoc, doc }, { log: ctx.log });
        return doc;
      }
      const stored = await entryRow(ctx, collection, id);
      if (!stored) throw new NotFoundError("Entry not found");
      const expectedRevisionId = await resolveExpectedRevision(ctx, id, input.expect?.revisionId);
      const prepared = await prepareWrite({ ...writeInput(ctx, collection), operation: "update", data: input.data, slug: input.slug, stored, originalDoc: stored, columns: input.columns });
      const updated = await saveDraftEntry(db, collection.record, id, {
        data: prepared.data,
        slug: prepared.slug,
        expectedRevisionId
      });
      await invalidateEntryCache(env, slug, id);
      await runHooks(collection.hooks, "afterChange", { ...hooks, data: prepared.data ?? {}, operation: "update", originalDoc: stored, doc: updated }, { log: ctx.log });
      if (input.status) {
        return transition(collection, id, input.status === "archived" ? "archive" : "publish", { revisionId: await latestRevisionId(ctx, id) });
      }
      return withRevision(ctx, updated);
    },
    /** Removes a record; the media collection's file goes first, since media-serve reads R2 without checking the record. */
    async remove(slug, id, options = {}) {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, "delete");
      const hooks = hookContext(ctx, collection);
      let originalDoc;
      if (collection.nativeTable) {
        const stored = await nativeRow(ctx, collection, id);
        if (!stored) throw new NotFoundError("Entry not found");
        originalDoc = mapNativeEntry(stored, collection.record.id, collection.nativeIdCol);
      } else {
        originalDoc = await entryRow(ctx, collection, id);
        if (!originalDoc) throw new NotFoundError("Entry not found");
      }
      await runHooks(collection.hooks, "beforeDelete", { ...hooks, operation: "delete", originalDoc }, { log: ctx.log });
      if (collection.nativeTable) {
        if (isMediaCollection(collection.config)) await deleteStoredMedia(env, id, options.origin);
        await db.delete(collection.nativeTable).where(eq3(collection.nativeTable[collection.nativeIdCol], id));
      } else {
        await db.delete(entries).where(and2(eq3(entries.collectionId, collection.record.id), eq3(entries.id, id)));
      }
      await invalidateEntryCache(env, slug, id);
      await runHooks(collection.hooks, "afterDelete", { ...hooks, operation: "delete", originalDoc, doc: originalDoc }, { log: ctx.log });
    },
    /**
     * The site's view of a collection: published snapshots or drafts, relations embedded, cached
     * for depth 0. A `where`, `sort` or `offset` narrows, orders or skips (on the published data
     * in the published view), and such a read is never cached.
     */
    async findMany(slug, options = {}) {
      const configured = configuredFor(ctx, slug);
      if (configured) assertAllowed(ctx.actor, configured.config, "read");
      const versionMode = options.version || "published";
      if (options.limit !== void 0 && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
        throw new InvalidInputError("limit must be a positive integer");
      }
      if (options.offset !== void 0 && options.limit === void 0) throw new InvalidInputError("offset needs a limit.");
      const limit = options.limit;
      const depth = options.depth ?? 1;
      const native = Boolean(configured?.nativeTable);
      const custom = Boolean(options.where && Object.keys(options.where).length > 0) || Boolean(options.sort && options.sort.length > 0) || options.offset !== void 0;
      const cacheKey = cacheKeys.entries(slug, versionMode);
      const useCache = siteCacheWanted(options, native) && limit === void 0 && depth === 0 && !custom && Boolean(env.KV);
      if (useCache) {
        const hit = await readCache(env.KV, cacheKey);
        if (hit) return hit;
      }
      const collection = await resolveCollection(ctx, slug);
      if (!configured) assertAllowed(ctx.actor, collection.config, "read");
      const compiled = compileQuery(queryTarget(collection, versionMode), options);
      const readStartedAt = /* @__PURE__ */ new Date();
      let data;
      if (collection.nativeTable) {
        let query = db.select().from(collection.nativeTable).where(compiled.where).orderBy(...compiled.orderBy).$dynamic();
        if (limit !== void 0) query = query.limit(limit).offset(compiled.offset ?? 0);
        data = (await query).map((row) => mapNativeEntry(row, collection.record.id, collection.nativeIdCol));
      } else {
        const entries2 = entries;
        let query = db.select().from(entries2).where(and2(eq3(entries2.collectionId, collection.record.id), versionMode === "published" ? eq3(entries2.status, "published") : void 0, compiled.where)).orderBy(...compiled.orderBy.length > 0 ? [...compiled.orderBy, desc2(entries2.id)] : [desc2(entries2.createdAt)]).$dynamic();
        if (limit !== void 0) query = query.limit(limit).offset(compiled.offset ?? 0);
        data = (await query).map((entry) => normalizeEntryDataForRead(entry, versionMode));
      }
      data = await resolveRelationships(ctx, data, collection, depth, versionMode);
      if (useCache) {
        const inCollection = eq3(entries.collectionId, collection.record.id);
        await writeCache(env.KV, cacheKey, data, ctx.ctx, native ? { ttl: NATIVE_CACHE_TTL_SECONDS } : {
          changedSinceRead: rowsUpdatedSince(db, entries, readStartedAt, inCollection, {
            where: versionMode === "published" ? and2(inCollection, eq3(entries.status, "published")) : inCollection,
            count: data.length
          })
        });
      }
      return data;
    },
    /** One entry as the site reads it, or null. */
    async find(slug, id, options = {}) {
      const configured = configuredFor(ctx, slug);
      if (configured) assertAllowed(ctx.actor, configured.config, "read");
      const versionMode = options.version || "published";
      const depth = options.depth ?? 1;
      const native = Boolean(configured?.nativeTable);
      const cacheKey = cacheKeys.entry(slug, id, versionMode);
      const useCache = siteCacheWanted(options, native) && depth === 0 && Boolean(env.KV);
      if (useCache) {
        const hit = await readCache(env.KV, cacheKey);
        if (hit) return hit;
      }
      const collection = await resolveCollection(ctx, slug);
      if (!configured) assertAllowed(ctx.actor, collection.config, "read");
      const readStartedAt = /* @__PURE__ */ new Date();
      let data = null;
      if (collection.nativeTable) {
        const row = await nativeRow(ctx, collection, id);
        if (row) data = mapNativeEntry(row, collection.record.id, collection.nativeIdCol);
      } else {
        const entry = await db.query.entries.findFirst({
          // @ts-ignore
          where: (e, operators) => versionMode === "published" ? operators.and(operators.eq(e.collectionId, collection.record.id), operators.eq(e.id, id), operators.eq(e.status, "published")) : operators.and(operators.eq(e.collectionId, collection.record.id), operators.eq(e.id, id))
        });
        if (entry) data = normalizeEntryDataForRead(entry, versionMode);
      }
      if (!data) return null;
      [data] = await resolveRelationships(ctx, [data], collection, depth, versionMode);
      if (useCache) {
        await writeCache(env.KV, cacheKey, data, ctx.ctx, native ? { ttl: NATIVE_CACHE_TTL_SECONDS } : {
          changedSinceRead: rowsUpdatedSince(db, entries, readStartedAt, eq3(entries.id, id), { where: eq3(entries.id, id), count: 1 })
        });
      }
      return data;
    },
    /**
     * One entry by its slug, or null. `slug` is the live slug of a published entry; a draft read
     * looks for the slug the entry will have after its next publish. Native rows match their
     * `slug` column, or their id column without one.
     */
    async findBySlug(slug, entrySlug, options = {}) {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, "read");
      const versionMode = options.version || "published";
      let data = null;
      if (collection.nativeTable) {
        const nativeTable = collection.nativeTable;
        const slugColumn = nativeTable.slug || nativeTable[collection.nativeIdCol];
        const rows = await db.select().from(nativeTable).where(eq3(slugColumn, entrySlug)).limit(1);
        if (rows[0]) data = mapNativeEntry(rows[0], collection.record.id, collection.nativeIdCol);
      } else {
        const entry = await db.query.entries.findFirst({
          // @ts-ignore
          where: (e, operators) => versionMode === "published" ? operators.and(operators.eq(e.collectionId, collection.record.id), operators.eq(e.status, "published"), operators.eq(e.slug, entrySlug)) : operators.and(operators.eq(e.collectionId, collection.record.id), operators.or(
            operators.eq(e.draftSlug, entrySlug),
            operators.and(operators.isNull(e.draftSlug), operators.eq(e.slug, entrySlug))
          )),
          orderBy: (e, { desc: desc3 }) => [desc3(e.createdAt)]
        });
        if (entry) data = normalizeEntryDataForRead(entry, versionMode);
      }
      if (!data) return null;
      const [resolved] = await resolveRelationships(ctx, [data], collection, options.depth ?? 1, versionMode);
      return resolved;
    },
    async publish(slug, id, options = {}) {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, "publish");
      return transition(collection, id, "publish", options.expect);
    },
    async archive(slug, id, options = {}) {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, "archive");
      return transition(collection, id, "archive", options.expect);
    }
  };
}

// src/service/globals.ts
import { and as and3, eq as eq4, sql as sql3 } from "drizzle-orm";
var DATA_MESSAGE = "Global data must be a JSON object";
var STALE_GLOBAL_MESSAGE = "This global changed since it was opened. Load the latest version before saving.";
var globalSyncs = /* @__PURE__ */ new WeakMap();
var newGlobalId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
var trimmed = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
function readExpectedVersion(value) {
  if (value === void 0 || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new InvalidInputError("expectedVersion must be a positive whole number");
  }
  return value;
}
function withDecodedData(record) {
  return record ? { ...record, data: decodeGlobalData(record.data) } : record;
}
async function findGlobal(ctx, slug) {
  return ctx.db.query.globals.findFirst({
    // @ts-ignore
    where: (g, { eq: eq5 }) => eq5(g.slug, slug)
  });
}
async function writeConfiguredGlobals(ctx) {
  for (const globalConfig of ctx.config.globals) {
    const existing = await findGlobal(ctx, globalConfig.slug);
    if (!existing) {
      const now = /* @__PURE__ */ new Date();
      await ctx.db.insert(globals).values({
        id: newGlobalId(),
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
      await ctx.db.update(globals).set({ name: globalConfig.name, description: nextDescription }).where(eq4(globals.id, existing.id));
    }
  }
}
function syncConfiguredGlobals(ctx) {
  return oncePerDatabase(globalSyncs, ctx.env.DB, () => writeConfiguredGlobals(ctx));
}
async function resolveGlobal(ctx, slug) {
  const globalConfig = ctx.config.globals.find((candidate) => candidate.slug === slug) || null;
  let record = await findGlobal(ctx, slug) ?? null;
  if (!record && globalConfig) {
    const now = /* @__PURE__ */ new Date();
    await ctx.db.insert(globals).values({
      id: newGlobalId(),
      name: globalConfig.name,
      slug: globalConfig.slug,
      description: globalConfig.description || null,
      data: {},
      createdAt: now,
      updatedAt: now
    });
    record = await findGlobal(ctx, slug) ?? null;
  } else if (record && globalConfig) {
    const nextDescription = globalConfig.description || null;
    if (record.name !== globalConfig.name || (record.description || null) !== nextDescription) {
      await ctx.db.update(globals).set({ name: globalConfig.name, description: nextDescription }).where(eq4(globals.id, record.id));
      record = { ...record, name: globalConfig.name, description: nextDescription };
    }
  }
  return { config: globalConfig, record };
}
function ordered(configured, rows) {
  const configuredOrder = new Map(configured.map((globalConfig, index) => [globalConfig.slug, index]));
  return rows.map((row) => ({ ...row, data: void 0 })).sort((left, right) => {
    const leftOrder = configuredOrder.get(left.slug);
    const rightOrder = configuredOrder.get(right.slug);
    if (leftOrder !== void 0 && rightOrder !== void 0) return leftOrder - rightOrder;
    if (leftOrder !== void 0) return -1;
    if (rightOrder !== void 0) return 1;
    return left.name.localeCompare(right.name);
  });
}
function globalsService(ctx) {
  const { db, env, config, actor } = ctx;
  const cached = (options) => (options.cache ?? actor.kind !== "user") && Boolean(env.KV);
  return {
    /** Every global without its data, configured ones first. */
    async list(options = {}) {
      const useCache = cached(options);
      if (useCache) {
        const hit = await readCache(env.KV, cacheKeys.globals());
        if (hit) return hit;
      }
      const readStartedAt = /* @__PURE__ */ new Date();
      await syncConfiguredGlobals(ctx);
      const list = ordered(config.globals, await db.query.globals.findMany());
      if (useCache) {
        await writeCache(env.KV, cacheKeys.globals(), list, ctx.ctx, { changedSinceRead: rowsUpdatedSince(db, globals, readStartedAt) });
      }
      return list;
    },
    /** One global with its data, or null; a configured global exists from its first read. */
    async get(slug, options = {}) {
      const useCache = cached(options);
      if (useCache) {
        const hit = await readCache(env.KV, cacheKeys.global(slug));
        if (hit) return withDecodedData(hit);
      }
      const readStartedAt = /* @__PURE__ */ new Date();
      const { record } = await resolveGlobal(ctx, slug);
      const data = withDecodedData(record);
      if (useCache && data) {
        await writeCache(
          env.KV,
          cacheKeys.global(slug),
          data,
          ctx.ctx,
          { changedSinceRead: rowsUpdatedSince(db, globals, readStartedAt, eq4(globals.slug, slug)) }
        );
      }
      return data;
    },
    /** A new global outside the configuration; administrators only. */
    async create(input) {
      if (actor.kind === "user" && actor.user.role !== "admin") throw new AccessDeniedError("Admin access required");
      const slug = trimmed(input.slug);
      if (!slug) throw new InvalidInputError("Slug is required");
      if (input.data != null && !isGlobalData(input.data)) throw new ValidationError([{ path: [], message: DATA_MESSAGE }], void 0, DATA_MESSAGE);
      if (await findGlobal(ctx, slug)) throw new ConflictError("A global with this slug already exists");
      const now = /* @__PURE__ */ new Date();
      const created = {
        id: newGlobalId(),
        name: trimmed(input.name) || slug,
        slug,
        description: trimmed(input.description),
        data: isGlobalData(input.data) ? input.data : {},
        createdAt: now,
        updatedAt: now,
        version: 1
      };
      await db.insert(globals).values(created);
      await invalidateGlobalCache(env, slug);
      return created;
    },
    /**
     * Saves a global's data, creating a configured global's row as needed. Saving to a slug that is
     * neither configured nor stored would create a global, which is kept to administrators. Every
     * save adds one to the row's `version`; a caller that passes the version it loaded is refused
     * with a `stale_record` conflict when another save came first.
     */
    async save(slug, data, options = {}) {
      if (!isGlobalData(data)) throw new ValidationError([{ path: [], message: DATA_MESSAGE }], void 0, DATA_MESSAGE);
      const expectedVersion = readExpectedVersion(options.expectedVersion);
      const { config: globalConfig, record: existing } = await resolveGlobal(ctx, slug);
      if (!globalConfig && !existing && actor.kind === "user" && actor.user.role !== "admin") {
        throw new AccessDeniedError("Only administrators can create globals");
      }
      let saved = data;
      if (globalConfig?.fields?.length) {
        const parsed = buildZodSchemaForFields(globalConfig.fields).safeParse(data);
        if (!parsed.success) {
          throw new ValidationError(parsed.error.issues, { details: parsed.error.flatten() }, parsed.error.issues.map((issue) => issue.message).join(", "));
        }
        saved = parsed.data;
      }
      const now = /* @__PURE__ */ new Date();
      const name = globalConfig?.name || existing?.name || slug;
      const description = globalConfig?.description || existing?.description || null;
      const nextVersion = sql3`${globals.version} + 1`;
      let updated;
      if (existing) {
        const stillLoaded = expectedVersion === null ? void 0 : eq4(globals.version, expectedVersion);
        [updated] = await db.update(globals).set({ name, description, data: saved, updatedAt: now, version: nextVersion }).where(and3(eq4(globals.id, existing.id), stillLoaded)).returning();
      }
      if (!updated) {
        if (expectedVersion !== null) {
          const current = await findGlobal(ctx, slug);
          throw new ConflictError(STALE_GLOBAL_MESSAGE, { code: "stale_record", version: current?.version ?? null });
        }
        await db.insert(globals).values({
          id: newGlobalId(),
          name,
          slug,
          description,
          data: saved,
          createdAt: now,
          updatedAt: now,
          version: 1
        }).onConflictDoUpdate({
          target: globals.slug,
          set: { name, description, data: saved, updatedAt: now, version: nextVersion }
        });
        updated = await findGlobal(ctx, slug);
      }
      if (!updated) throw new Error(`Global "${slug}" could not be read back after saving`);
      await invalidateGlobalCache(env, slug);
      return withDecodedData(updated);
    }
  };
}

// src/service/transitions.ts
function revisionsService(ctx) {
  const { db, env } = ctx;
  async function versioned(slug, operation) {
    const collection = await resolveCollection(ctx, slug);
    assertAllowed(ctx.actor, collection.config, operation);
    if (collection.nativeTable) throw new UnsupportedOperationError(NATIVE_REVISIONS_MESSAGE);
    return collection;
  }
  return {
    /** Newest first. Without `includeData` the history lists metadata only; a revision's data loads on its own. */
    async list(slug, entryId, options = {}) {
      const collection = await versioned(slug, "read");
      return listEntryRevisions(db, collection.record.id, entryId, { includeData: options.includeData ?? false, limit: options.limit });
    },
    async get(slug, entryId, revisionId) {
      const collection = await versioned(slug, "read");
      return getEntryRevision(db, collection.record.id, entryId, revisionId);
    },
    /** Restores a revision's data as a new revision; the caller names the latest revision it loaded. */
    async restore(slug, entryId, revisionId, options = {}) {
      const collection = await versioned(slug, "restore");
      if (typeof options.expectedRevisionId !== "string" || !options.expectedRevisionId) throw new PreconditionRequiredError();
      const restored = await restoreEntryRevision(db, collection.record, entryId, revisionId, options.expectedRevisionId);
      await invalidateEntryCache(env, slug, entryId);
      return { ...toEditableEntry(restored), latestRevisionId: (await getLatestRevision(db, entryId))?.id ?? null };
    }
  };
}

// src/service/index.ts
function createService(env, options) {
  const context = {
    env,
    db: createDbClient(env),
    config: options.config,
    actor: options.actor ?? systemActor(),
    ctx: options.ctx,
    log: options.log
  };
  return {
    actor: context.actor,
    collections: collectionsService(context),
    entries: entriesService(context),
    globals: globalsService(context),
    revisions: revisionsService(context)
  };
}

export {
  loadServiceConfig,
  ServiceError,
  ValidationError,
  InvalidInputError,
  AccessDeniedError,
  NotFoundError,
  PayloadTooLargeError,
  ConflictError,
  PreconditionRequiredError,
  NativeRecordConflictError,
  UnsupportedOperationError,
  ConstraintError,
  HookError,
  isServiceError,
  systemActor,
  userActor,
  createService,
  createDbClient,
  getClient
};
