// src/db/media-policy.ts
var MAX_MEDIA_BYTES = 10 * 1024 * 1024;
var MEDIA_IMAGE_WIDTHS = [320, 640, 960, 1280, 1920];
var MEDIA_CACHE_CONTROL = "public, max-age=3600";
var MEDIA_CACHE_KEY_VERSION = "2";
var MEDIA_SCHEMA_PATH = "talisman-cms/db/media";
function isMediaCollection(collection) {
  return collection.nativeSchemaMapping?.schemaPath === MEDIA_SCHEMA_PATH;
}
function mediaPath(id) {
  return `/api/media/${id}`;
}
function mediaCacheKey(origin, id, width) {
  const url = new URL(mediaPath(id), origin);
  url.searchParams.set("v", MEDIA_CACHE_KEY_VERSION);
  if (width !== void 0) url.searchParams.set("w", String(width));
  return url.toString();
}
async function deleteStoredMedia(env, id, origin) {
  await env.STORAGE?.delete(id);
  if (!origin) return;
  const cache = typeof caches === "undefined" ? void 0 : caches.default;
  if (!cache) return;
  const keys = [void 0, ...MEDIA_IMAGE_WIDTHS].map((width) => mediaCacheKey(origin, id, width));
  await Promise.all(keys.map(async (key) => {
    try {
      await cache.delete(key);
    } catch (error) {
      console.warn(`[talisman-cms] Could not evict ${key} from the edge cache`, error);
    }
  }));
}
function notModifiedResponse(request, response) {
  const etag = response.headers.get("ETag");
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (!etag || !ifNoneMatch || response.status !== 200) return null;
  const opaque = (tag) => tag.trim().replace(/^W\//, "");
  const matches = ifNoneMatch.split(",").some((tag) => tag.trim() === "*" || opaque(tag) === opaque(etag));
  if (!matches) return null;
  const headers = new Headers();
  for (const name of ["ETag", "Cache-Control", "Content-Type", "X-Content-Type-Options", "Content-Security-Policy"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(null, { status: 304, headers });
}
var safeImageTypes = /* @__PURE__ */ new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif"
]);
function rasterImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return "image/png";
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) === "GIF89a") return "image/gif";
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) === "GIF87a") return "image/gif";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp" && ["avif", "avis"].includes(String.fromCharCode(...bytes.slice(8, 12)))) return "image/avif";
  return null;
}
function secureMediaResponse(response) {
  const headers = new Headers(response.headers);
  const type = headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() || "";
  if (safeImageTypes.has(type)) {
    headers.set("Content-Type", type);
    headers.delete("Content-Disposition");
  } else {
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Disposition", "attachment");
  }
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "sandbox");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export {
  MAX_MEDIA_BYTES,
  MEDIA_IMAGE_WIDTHS,
  MEDIA_CACHE_CONTROL,
  MEDIA_SCHEMA_PATH,
  isMediaCollection,
  mediaPath,
  mediaCacheKey,
  deleteStoredMedia,
  notModifiedResponse,
  rasterImageType,
  secureMediaResponse
};
