import "../chunk-MLKGABMK.js";

// src/db/media-policy.ts
var MAX_MEDIA_BYTES = 10 * 1024 * 1024;
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
  rasterImageType,
  secureMediaResponse
};
