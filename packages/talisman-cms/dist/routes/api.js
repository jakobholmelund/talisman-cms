import {
  authorizeCmsRequest
} from "../chunk-2VH4YUXN.js";
import "../chunk-RI3U7J5G.js";
import {
  privateRoute
} from "../chunk-7H7KCEZW.js";
import {
  ConflictError,
  HookError,
  MAX_PAGE_SIZE,
  NATIVE_PUBLISHING_MESSAGE,
  NATIVE_REVISIONS_MESSAGE,
  NotFoundError,
  ServiceError,
  ValidationError,
  assertAllowed,
  assertCollectionAccess,
  configFromModules,
  configuredCollectionFields,
  constraintErrorFrom,
  createDbClient,
  createService,
  isDatabaseError,
  syncCollectionDefinitions,
  userActor
} from "../chunk-ZX2ZZJDF.js";
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
  entries
} from "../chunk-SHMAAJ4S.js";
import "../chunk-72N3XJ7X.js";
import "../chunk-GAOPNFAO.js";
import {
  formatValidationIssues,
  isGlobalData
} from "../chunk-OAGJMNST.js";
import "../chunk-MLKGABMK.js";

// src/api/handler.ts
import { count, sql } from "drizzle-orm";
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
    const row = await db.get(sql`SELECT ${sql.join(counted.map((collection, index) => sql`(SELECT count(*) FROM ${nativeSchemas[collection.slug]}) AS ${sql.identifier(`c${index}`)}`), sql`, `)}`);
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
