import {
  authorizeCmsRequest
} from "./chunk-2VH4YUXN.js";
import "./chunk-RI3U7J5G.js";
import "./chunk-7H7KCEZW.js";
import {
  AccessDeniedError,
  InvalidInputError,
  getClient,
  userActor
} from "./chunk-INO7FN25.js";
import "./chunk-7VUPBVR5.js";
import "./chunk-O4C7JAHB.js";
import "./chunk-SHMAAJ4S.js";
import "./chunk-72N3XJ7X.js";
import "./chunk-GAOPNFAO.js";
import "./chunk-I2M5IE4P.js";
import "./chunk-MLKGABMK.js";

// src/loader.server.ts
var READ_KEYS = ["version", "depth", "request"];
function validateFilter(filter, keys) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    throw new InvalidInputError("The live loader filter must be an object.");
  }
  for (const key of Object.keys(filter)) {
    if (!keys.includes(key)) throw new InvalidInputError(`Unsupported live loader filter: ${key}`);
  }
}
function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new InvalidInputError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}
async function readContext(options, filter) {
  const version = filter.version ?? options.version ?? "published";
  if (version !== "published" && version !== "draft") throw new InvalidInputError("version must be published or draft.");
  const depth = integer(filter.depth ?? options.depth ?? 0, "depth", 0, 5);
  let actor;
  if (version === "draft") {
    if (!(filter.request instanceof Request)) throw new AccessDeniedError("Draft previews require a request with a CMS session.");
    const auth = await authorizeCmsRequest(filter.request);
    if (auth.response || !["admin", "editor"].includes(auth.user.role)) {
      throw new AccessDeniedError("Draft previews require a verified CMS editor or admin session.");
    }
    actor = userActor(auth.user, filter.request);
  }
  const pkg = "cloudflare:workers";
  const { env } = await import(
    /* @vite-ignore */
    pkg
  );
  return {
    client: getClient(env, void 0, { actor }),
    // Draft reads never use the shared site cache, including relationship-free reads.
    read: { version, depth, ...version === "draft" ? { cache: false } : {} }
  };
}
function toLiveEntry(entry) {
  const data = typeof entry.data === "string" ? JSON.parse(entry.data) : entry.data;
  return {
    id: entry.id,
    data: {
      ...data,
      slug: entry.slug,
      status: entry.status,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    }
  };
}
async function fetchLiveEntry(options, filter) {
  validateFilter(filter, [...READ_KEYS, "id", "slug"]);
  const hasId = filter.id !== void 0;
  const key = hasId ? filter.id : filter.slug;
  if (hasId && filter.slug !== void 0 || typeof key !== "string" || !key.trim()) {
    throw new InvalidInputError("Supply exactly one non-empty id or slug.");
  }
  const { client, read } = await readContext(options, filter);
  const entry = hasId ? await client.entries.find(options.collection, key, read) : await client.entries.findBySlug(options.collection, key, read);
  return entry ? toLiveEntry(entry) : void 0;
}
async function fetchLiveCollection(options, filter = {}) {
  validateFilter(filter, [...READ_KEYS, "where", "sort", "offset", "limit"]);
  const limit = integer(filter.limit ?? options.limit ?? 50, "limit", 1, 200);
  const { client, read } = await readContext(options, filter);
  const entries = await client.entries.findMany(options.collection, {
    ...read,
    limit,
    where: filter.where,
    sort: filter.sort,
    offset: filter.offset
  });
  return { entries: entries.map(toLiveEntry) };
}
export {
  fetchLiveCollection,
  fetchLiveEntry
};
