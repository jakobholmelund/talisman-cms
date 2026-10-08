import {
  authorizeCmsRequest
} from "../chunk-2VH4YUXN.js";
import "../chunk-RI3U7J5G.js";
import {
  privateRoute
} from "../chunk-7H7KCEZW.js";
import {
  AccessDeniedError,
  ConflictError,
  HookError,
  InvalidInputError,
  MAX_PAGE_SIZE,
  NATIVE_PUBLISHING_MESSAGE,
  NATIVE_REVISIONS_MESSAGE,
  NotFoundError,
  ServiceError,
  ValidationError,
  actorRole,
  assertAllowed,
  assertCollectionAccess,
  canRead,
  configFromModules,
  configuredCollectionFields,
  constraintErrorFrom,
  createDbClient,
  createService,
  isDatabaseError,
  syncCollectionDefinitions,
  userActor
} from "../chunk-HEG7DNCN.js";
import {
  canAccessCollection
} from "../chunk-7VUPBVR5.js";
import {
  isEntryNotFound,
  isRevisionConflict,
  isSlugConflict
} from "../chunk-O4C7JAHB.js";
import {
  collections,
  entries,
  entryRevisions,
  globals,
  media
} from "../chunk-SHMAAJ4S.js";
import "../chunk-72N3XJ7X.js";
import "../chunk-GAOPNFAO.js";
import {
  columnKind,
  formatValidationIssues,
  getNativeIdColumn,
  isGlobalData
} from "../chunk-LQQ27M3S.js";
import "../chunk-MLKGABMK.js";

// src/api/handler.ts
import { count, sql as sql2 } from "drizzle-orm";
import * as configModule from "virtual:talisman-cms/config";
import * as uiLibrariesModule from "virtual:talisman-cms/ui-libraries";
import * as nativeSchemasModule from "virtual:talisman-cms/native-schemas";
import * as collectionHooksModule from "virtual:talisman-cms/collection-hooks";

// src/api/http-errors.ts
var CODES = { 403: "forbidden", 404: "not_found", 405: "unsupported", 409: "conflict", 413: "payload_too_large", 428: "precondition_required" };
var HttpError = class extends ServiceError {
  constructor(status, message) {
    super(CODES[status] ?? "invalid_input", status, message);
    this.name = "HttpError";
  }
};
var INTERNAL_ERROR_MESSAGE = "The request could not be completed. Check the server logs for details.";
function toErrorResponse(error, context) {
  if (error instanceof ValidationError) {
    return Response.json({ ...formatValidationIssues(error.issues), ...error.details }, { status: 400 });
  }
  if (error instanceof ConflictError && error.code === "stale_record") {
    return Response.json({ error: error.message, code: error.code, version: error.version ?? null }, { status: error.status });
  }
  if (error instanceof ServiceError && !(error instanceof HookError)) {
    return Response.json({ error: error.message, ...error.status === 409 ? { code: error.code } : {} }, { status: error.status });
  }
  if (isRevisionConflict(error) || isSlugConflict(error)) {
    return Response.json({ error: error.message, code: isRevisionConflict(error) ? "revision_conflict" : "slug_conflict" }, { status: 409 });
  }
  if (isEntryNotFound(error)) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  const constraint = constraintErrorFrom(error);
  if (constraint) {
    return Response.json({ error: constraint.message, ...constraint.status === 409 ? { code: constraint.code } : {} }, { status: constraint.status });
  }
  console.error(`[talisman-cms] ${context}:`, error);
  const message = error instanceof HookError && !isDatabaseError(error) ? error.message : INTERNAL_ERROR_MESSAGE;
  return Response.json({ status: "error", error: message, message }, { status: 500 });
}

// src/api/list-query.ts
function parseListQuery(url) {
  const where = {};
  let hasWhere = false;
  for (const [key, value] of url.searchParams) {
    const match = key.match(/^where\[([^\]]+)\](?:\[([^\]]+)\])?$/);
    if (!match) continue;
    hasWhere = true;
    const [, field, operator] = match;
    if (!operator) {
      where[field] = value;
      continue;
    }
    const current = where[field];
    const operators = current !== null && typeof current === "object" ? current : current === void 0 ? {} : { eq: current };
    if (operator === "in") {
      const previous = Array.isArray(operators.in) ? operators.in : [];
      operators.in = [...previous, ...value.split(",")];
    } else if (operator === "isNull") {
      operators.isNull = value === "true" || value === "1" || value === "";
    } else {
      operators[operator] = value;
    }
    where[field] = operators;
  }
  const query = {};
  if (hasWhere) query.where = where;
  const sort = url.searchParams.get("sort");
  if (sort) query.sort = sort;
  const offset = url.searchParams.get("offset");
  if (offset !== null) {
    if (!/^\d+$/.test(offset)) throw new HttpError(400, "offset must be a whole number.");
    query.offset = Number(offset);
  }
  return query;
}

// src/service/media-usage.ts
import { getTableColumns, sql } from "drizzle-orm";
var PAGE_SIZE = 50;
var SOURCES_PER_REQUEST = 10;
function references(data, id, urls) {
  return sql`EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(${data}) THEN ${data} ELSE '{}' END) AS media_ref
    WHERE media_ref.type = 'text' AND (media_ref.value = ${id} OR
      ${sql.join(urls.map((url) => sql`(media_ref.value = ${url} OR
        substr(media_ref.value, 1, length(${url}) + 1) IN (${url + "?"}, ${url + "#"}))`), sql` OR `)}))`;
}
async function mediaUsage(ctx, id, origin, cursor) {
  if (actorRole(ctx.actor) !== "admin") throw new AccessDeniedError("Admin access required");
  const mediaCollection = ctx.config.collections.find((collection) => collection.slug === "media");
  if (!mediaCollection) throw new NotFoundError("Media collection not found");
  assertAllowed(ctx.actor, mediaCollection, "read");
  const media2 = await ctx.db.select().from(media).where(sql`${media.id} = ${id}`).get();
  if (!media2) throw new NotFoundError("Media not found");
  const urls = /* @__PURE__ */ new Set([media2.url]);
  try {
    const url = new URL(media2.url, origin);
    urls.add(url.href);
    urls.add(url.pathname);
  } catch {
  }
  const sources = [];
  const excludedCollections = [];
  for (const collection of ctx.config.collections) {
    if (collection.slug === "media") continue;
    if (!canRead(ctx.actor, collection)) {
      excludedCollections.push(collection.slug);
      continue;
    }
    if (collection.nativeSchemaMapping) {
      const table = ctx.config.nativeSchemas[collection.slug];
      if (!table) {
        excludedCollections.push(collection.slug);
        continue;
      }
      const columns = getTableColumns(table);
      const fields = configuredCollectionFields(collection, ctx.config.nativeSchemas);
      if (fields.length > 40) {
        excludedCollections.push(collection.slug);
        continue;
      }
      const values = fields.flatMap((field) => {
        const column = columns[field.name];
        if (!column) return [];
        const kind = columnKind(column);
        if (kind !== "string" && kind !== "json") return [];
        const value = kind === "json" ? sql`json(CASE WHEN json_valid(${column}) THEN ${column} ELSE 'null' END)` : sql`${column}`;
        return [sql`${field.name}`, value];
      });
      if (!values.length) continue;
      const key = columns[getNativeIdColumn(collection)];
      if (!key) {
        excludedCollections.push(collection.slug);
        continue;
      }
      const title = ["title", "name", "label", "filename"].find((name) => fields.some((field) => field.name === name) && columns[name]);
      sources.push({ collection: collection.slug, kind: "native", query: (take, offset2) => sql`
        SELECT CAST(${key} AS TEXT) AS id, substr(CAST(${title ? columns[title] : key} AS TEXT), 1, 200) AS title
        FROM ${table} WHERE ${references(sql`json_object(${sql.join(values, sql`, `)})`, id, [...urls])}
        ORDER BY ${key} LIMIT ${take} OFFSET ${offset2}` });
      continue;
    }
    for (const kind of ["draft", "published"]) {
      const data = kind === "draft" ? entries.data : entries.publishedData;
      sources.push({ collection: collection.slug, kind, query: (take, offset2) => sql`
        SELECT ${entries.id} AS id, substr(COALESCE(json_extract(${data}, '$.title'), ${entries.slug}), 1, 200) AS title
        FROM ${entries} INNER JOIN ${collections} ON ${entries.collectionId} = ${collections.id}
        WHERE ${collections.slug} = ${collection.slug} AND ${references(sql`${data}`, id, [...urls])}
        ORDER BY ${entries.id} LIMIT ${take} OFFSET ${offset2}` });
    }
    sources.push({ collection: collection.slug, kind: "revision", query: (take, offset2) => sql`
      SELECT ${entryRevisions.id} AS id, ${entryRevisions.entryId} AS entryId,
        substr(COALESCE(json_extract(${entryRevisions.data}, '$.title'), ${entries.slug}), 1, 200) AS title
      FROM ${entryRevisions} INNER JOIN ${entries} ON ${entryRevisions.entryId} = ${entries.id}
      INNER JOIN ${collections} ON ${entryRevisions.collectionId} = ${collections.id}
      WHERE ${collections.slug} = ${collection.slug} AND ${references(sql`${entryRevisions.data}`, id, [...urls])}
      ORDER BY ${entryRevisions.id} LIMIT ${take} OFFSET ${offset2}` });
  }
  sources.push({ collection: null, kind: "global", query: (take, offset2) => sql`
    SELECT ${globals.slug} AS id, ${globals.name} AS title FROM ${globals}
    WHERE ${references(sql`${globals.data}`, id, [...urls])}
    ORDER BY ${globals.slug} LIMIT ${take} OFFSET ${offset2}` });
  let source = 0, offset = 0;
  if (cursor) {
    try {
      const value = JSON.parse(cursor);
      if (!value || value.id !== id || !Number.isSafeInteger(value.source) || value.source < 0 || value.source >= sources.length || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 1e6) throw new Error();
      source = value.source;
      offset = value.offset;
    } catch {
      throw new InvalidInputError("Invalid media usage cursor");
    }
  }
  const usages = [];
  let queried = 0;
  while (source < sources.length && queried++ < SOURCES_PER_REQUEST && usages.length < PAGE_SIZE) {
    const item = sources[source];
    const take = PAGE_SIZE - usages.length;
    const rows = await ctx.db.all(item.query(take + 1, offset));
    usages.push(...rows.slice(0, take).map((row) => ({ ...row, id: String(row.id), title: String(row.title || row.id), collection: item.collection, kind: item.kind })));
    if (rows.length > take) {
      offset += take;
      break;
    }
    source++;
    offset = 0;
  }
  return {
    usages,
    nextCursor: source < sources.length ? JSON.stringify({ id, source, offset }) : null,
    excludedCollections,
    scope: "CMS drafts, published snapshots, saved revisions, globals and configured native fields. Code, external sites and references embedded in HTML strings are not scanned."
  };
}

// src/api/handler.ts
var serviceConfig = configFromModules({
  config: configModule,
  uiLibraries: uiLibrariesModule,
  nativeSchemas: nativeSchemasModule,
  collectionHooks: collectionHooksModule
});
var { collections: configCollections, nativeSchemas } = serviceConfig;
var MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
async function readJsonBody(request) {
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BODY_BYTES) {
    throw new HttpError(413, "The request body is too large.");
  }
  const text = await request.text();
  if (text.length > MAX_REQUEST_BODY_BYTES) {
    throw new HttpError(413, "The request body is too large.");
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
}
async function readJsonObject(request) {
  const body = await readJsonBody(request);
  if (!isGlobalData(body)) throw new HttpError(400, "The request body must be a JSON object.");
  return body;
}
function readIfMatchVersion(request) {
  const header = request.headers.get("if-match");
  if (header === null) return null;
  const value = header.trim();
  if (value === "*") return null;
  const match = value.match(/^(\d{1,15})$|^"(\d{1,15})"$/);
  if (!match) throw new HttpError(400, "If-Match must be the version the global was loaded with, as a whole number, bare or in quotes.");
  return Number(match[1] ?? match[2]);
}
function globalResponse(global, status = 200) {
  const headers = { "Content-Type": "application/json" };
  if (typeof global.version === "number") headers.ETag = `"${global.version}"`;
  return new Response(JSON.stringify(global), { status, headers });
}
function decodePathSegment(segment) {
  let value;
  try {
    value = decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "The entry id in the path is not valid.");
  }
  if (value.length > 512) throw new HttpError(400, "The entry id in the path is too long.");
  return value;
}
function readPageRequest(url) {
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  if (limitParam === null) {
    if (cursor !== null) throw new HttpError(400, "cursor needs a limit.");
    return null;
  }
  const limit = Number(limitParam);
  if (!/^\d+$/.test(limitParam) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new HttpError(400, `limit must be a whole number from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return { limit, cursor: cursor || null };
}
function configuredCollectionFields2(collectionConfig) {
  return configuredCollectionFields(collectionConfig, nativeSchemas);
}
function syncCollectionDefinitions2(db, env) {
  return syncCollectionDefinitions(db, env, serviceConfig);
}
async function countNativeRows(db, collections2) {
  const counts = /* @__PURE__ */ new Map();
  const counted = collections2.filter((collection) => collection.nativeSchemaMapping && nativeSchemas[collection.slug]);
  if (counted.length === 0) return counts;
  try {
    const row = await db.get(sql2`SELECT ${sql2.join(counted.map((collection, index) => sql2`(SELECT count(*) FROM ${nativeSchemas[collection.slug]}) AS ${sql2.identifier(`c${index}`)}`), sql2`, `)}`);
    counted.forEach((collection, index) => counts.set(collection.slug, Number(row?.[`c${index}`] ?? 0)));
  } catch (error) {
    console.error("[talisman-cms] Could not count native collection rows:", error);
  }
  return counts;
}
async function resolveConfigured(service, slug) {
  const collection = await service.entries.resolve(slug);
  if (!collection.configured) throw new NotFoundError(`Collection ${slug} not found`);
  return collection;
}
var ALL = privateRoute(async ({ request, locals }) => {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.endsWith("/api/health")) {
    try {
      const { env } = await import("cloudflare:workers");
      const db = createDbClient(env);
      await db.run("SELECT 1");
      return new Response(JSON.stringify({ status: "ok", d1: "connected" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (e) {
      console.error("[talisman-cms] Health check failed:", e);
      return new Response(JSON.stringify({ status: "error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
  const adminOnly = request.method === "DELETE" || request.method === "POST" && /\/api\/collections\/[^/]+\/entries\/[^/]+\/(publish|archive)$/.test(path) || request.method === "POST" && /\/api\/collections\/[^/]+\/entries\/[^/]+\/revisions\/[^/]+\/restore$/.test(path) || request.method === "POST" && path.endsWith("/api/globals");
  const authorization = await authorizeCmsRequest(request, adminOnly ? "admin" : void 0);
  if (authorization.response) return authorization.response;
  const user = authorization.user;
  const actor = userActor(user, request);
  const mediaUsageMatch = path.match(/\/api\/media\/([^/]+)\/usage$/);
  if (mediaUsageMatch) {
    if (user.role !== "admin") return Response.json({ error: "Admin access required" }, { status: 403 });
    if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
    try {
      const { env } = await import("cloudflare:workers");
      return Response.json(await mediaUsage(
        { env, db: createDbClient(env), config: serviceConfig, actor },
        decodePathSegment(mediaUsageMatch[1]),
        url.origin,
        url.searchParams.get("cursor")
      ));
    } catch (error) {
      return toErrorResponse(error, "Error checking media usage");
    }
  }
  if (path.endsWith("/api/collections")) {
    try {
      const { env } = await import("cloudflare:workers");
      const db = createDbClient(env);
      await syncCollectionDefinitions2(db, env);
      const visibleCollections = configCollections.filter((col) => canAccessCollection(col, user, "read"));
      const persistedCollections = await db.select({
        id: collections.id,
        slug: collections.slug,
        createdAt: collections.createdAt
      }).from(collections);
      const persistedBySlug = new Map(persistedCollections.map((collection) => [collection.slug, collection]));
      const entryCounts = await db.select({
        collectionId: entries.collectionId,
        total: count()
      }).from(entries).groupBy(entries.collectionId);
      const entryCountById = new Map(entryCounts.map((row) => [row.collectionId, row.total]));
      const nativeCountBySlug = await countNativeRows(db, visibleCollections);
      const augmentedCollections = visibleCollections.map((c) => {
        const persisted = persistedBySlug.get(c.slug);
        const itemCount = c.nativeSchemaMapping ? nativeCountBySlug.get(c.slug) ?? null : persisted ? entryCountById.get(persisted.id) ?? 0 : 0;
        if ((!c.fields || c.fields.length === 0) && c.nativeSchemaMapping && nativeSchemas[c.slug]) {
          return { ...c, id: persisted?.id, createdAt: persisted?.createdAt, itemCount, fields: configuredCollectionFields2(c) };
        }
        return { ...c, id: persisted?.id, createdAt: persisted?.createdAt, itemCount };
      });
      return new Response(JSON.stringify(augmentedCollections), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (e) {
      return toErrorResponse(e, "Error in /api/collections");
    }
  }
  const globalsMatch = path.match(/\/api\/globals(?:\/([^/]+))?$/);
  if (globalsMatch) {
    const slug = globalsMatch[1];
    try {
      const { env } = await import("cloudflare:workers");
      const service = createService(env, { config: serviceConfig, actor });
      if (request.method === "GET") {
        if (!slug) {
          return new Response(JSON.stringify(await service.globals.list()), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        const global = await service.globals.get(slug);
        if (!global) return new Response(JSON.stringify({ error: "Global not found" }), { status: 404 });
        return globalResponse(global);
      }
      if (request.method === "POST") {
        if (!slug) {
          const body = await readJsonObject(request);
          const created = await service.globals.create({ slug: body.slug, name: body.name, description: body.description, data: body.data });
          return globalResponse(created, 201);
        }
        const expectedVersion = readIfMatchVersion(request);
        const updated = await service.globals.save(slug, await readJsonBody(request), { expectedVersion });
        return globalResponse(updated);
      }
    } catch (e) {
      return toErrorResponse(e, "Error in /api/globals");
    }
  }
  const revisionsMatch = path.match(/\/api\/collections\/([^/]+)\/entries\/([^/]+)\/revisions(?:\/([^/]+)(\/restore)?)?$/);
  if (revisionsMatch) {
    const slug = revisionsMatch[1];
    const isRestore = Boolean(revisionsMatch[4]);
    try {
      const entryId = decodePathSegment(revisionsMatch[2]);
      const revisionId = revisionsMatch[3] ? decodePathSegment(revisionsMatch[3]) : void 0;
      const { env } = await import("cloudflare:workers");
      const service = createService(env, { config: serviceConfig, actor });
      const collection = await resolveConfigured(service, slug);
      assertCollectionAccess(actor, collection.config, request.method === "GET" ? "read" : "update", "Collection access denied");
      if (collection.nativeTable) {
        return new Response(JSON.stringify({ error: NATIVE_REVISIONS_MESSAGE }), { status: 400 });
      }
      if (request.method === "GET" && !revisionId) {
        const includeData = ["1", "true"].includes(url.searchParams.get("includeData") ?? "");
        const page = readPageRequest(url);
        if (page?.cursor) throw new HttpError(400, "Revision lists take a limit but no cursor.");
        const revisions = await service.revisions.list(slug, entryId, { includeData, limit: page?.limit });
        return new Response(JSON.stringify(revisions), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (request.method === "GET" && revisionId && !isRestore) {
        const revision = await service.revisions.get(slug, entryId, revisionId);
        return new Response(JSON.stringify(revision), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (request.method === "POST" && revisionId && isRestore) {
        const body = await request.json().catch(() => ({}));
        const restored = await service.revisions.restore(slug, entryId, revisionId, { expectedRevisionId: body.expectedRevisionId });
        return new Response(JSON.stringify(restored), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    } catch (e) {
      return toErrorResponse(e, "Error in the revisions API");
    }
  }
  const transitionMatch = path.match(/\/api\/collections\/([^/]+)\/entries\/([^/]+)\/(publish|archive)$/);
  if (transitionMatch) {
    const slug = transitionMatch[1];
    const action = transitionMatch[3];
    try {
      const entryId = decodePathSegment(transitionMatch[2]);
      const { env } = await import("cloudflare:workers");
      const service = createService(env, { config: serviceConfig, actor });
      const collection = await resolveConfigured(service, slug);
      assertCollectionAccess(actor, collection.config, "update", "Collection access denied");
      if (collection.nativeTable) {
        return new Response(JSON.stringify({ error: NATIVE_PUBLISHING_MESSAGE }), { status: 400 });
      }
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
      }
      const body = await request.json().catch(() => ({}));
      const updated = await service.entries[action](slug, entryId, { expect: { revisionId: body.expectedRevisionId } });
      if (updated.workflow?.status === "pending") {
        return Response.json({
          ...updated,
          message: `The ${action} is still running. Reload the entry in a moment to see the result.`
        }, { status: 202 });
      }
      return new Response(JSON.stringify(updated), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return toErrorResponse(e, `Error in the ${action} API`);
    }
  }
  const entriesMatch = path.match(/\/api\/collections\/([^/]+)\/entries(?:\/([^/]+))?$/);
  if (entriesMatch) {
    const slug = entriesMatch[1];
    try {
      const entryId = entriesMatch[2] === void 0 ? void 0 : decodePathSegment(entriesMatch[2]);
      const { env } = await import("cloudflare:workers");
      const service = createService(env, { config: serviceConfig, actor });
      const collection = await resolveConfigured(service, slug);
      const operation = request.method === "GET" ? "read" : request.method === "POST" ? "create" : request.method === "PUT" ? "update" : "delete";
      assertAllowed(actor, collection.config, operation);
      if (request.method === "GET") {
        if (!entryId) {
          const query = parseListQuery(url);
          const page = readPageRequest(url);
          if (!page) {
            return new Response(JSON.stringify(await service.entries.list(slug, query)), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          return Response.json(await service.entries.page(slug, { ...page, ...query }));
        }
        const doc = await service.entries.get(slug, entryId);
        if (!doc) return new Response(JSON.stringify({ error: "Entry not found" }), { status: 404 });
        return new Response(JSON.stringify(doc), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (request.method === "POST") {
        const payload = await readJsonObject(request);
        const created = await service.entries.create(slug, { data: payload.data, id: payload.id, slug: payload.slug });
        return new Response(JSON.stringify(created), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (request.method === "PUT") {
        if (!entryId) return new Response(JSON.stringify({ error: "Entry ID required for PUT" }), { status: 400 });
        const payload = await readJsonObject(request);
        const updated = await service.entries.update(slug, entryId, {
          data: payload.data,
          slug: payload.slug,
          expect: { revisionId: payload.expectedRevisionId, updatedAt: payload.expectedUpdatedAt }
        });
        return new Response(JSON.stringify(updated), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (request.method === "DELETE") {
        if (!entryId) return new Response(JSON.stringify({ error: "Entry ID required for DELETE" }), { status: 400 });
        await service.entries.remove(slug, entryId, { origin: url.origin });
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    } catch (e) {
      return toErrorResponse(e, "Error in the entries API");
    }
  }
  return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
});

// src/routes/api.ts
var ALL2 = ALL;
export {
  ALL2 as ALL
};
