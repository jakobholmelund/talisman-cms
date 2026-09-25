import {
  starwindUiLibrary,
  starwindUiPlugin
} from "./chunk-EPKEURGZ.js";

// src/renderers/sanitize.ts
var SAFE_URL_SCHEMES = /* @__PURE__ */ new Set(["http", "https", "mailto", "tel"]);
function safeHref(value, fallback = "#") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed.replace(/[\u0000- \u007f-\u009f]/g, ""));
  if (!scheme) return trimmed;
  return SAFE_URL_SCHEMES.has(scheme[1].toLowerCase()) ? trimmed : fallback;
}
export {
  safeHref,
  starwindUiLibrary,
  starwindUiPlugin
};
