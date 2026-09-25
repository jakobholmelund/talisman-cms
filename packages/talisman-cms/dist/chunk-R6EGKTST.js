// src/env.ts
var LEGACY_WARNING_KEY = "__TALISMAN_CMS_LEGACY_ENV_WARNED__";
function warnLegacyName(name) {
  const runtime = globalThis;
  if (runtime[LEGACY_WARNING_KEY]) return;
  runtime[LEGACY_WARNING_KEY] = true;
  console.warn(`[Talisman CMS] GALAXY_${name} is deprecated; rename it to TALISMAN_${name}. Other GALAXY_* settings and bindings are still read until they are renamed too.`);
}
function read(env, name, accept) {
  if (!env) return void 0;
  const values = env;
  const current = accept(values[`TALISMAN_${name}`], `TALISMAN_${name}`);
  if (current !== void 0) return current;
  const legacy = accept(values[`GALAXY_${name}`], `GALAXY_${name}`);
  if (legacy !== void 0) warnLegacyName(name);
  return legacy;
}
var IGNORED_WARNING_KEY = "__TALISMAN_CMS_IGNORED_SETTINGS_WARNED__";
function warnIgnoredSetting(name) {
  const runtime = globalThis;
  const warned = runtime[IGNORED_WARNING_KEY] ??= /* @__PURE__ */ new Set();
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(`[Talisman CMS] The ${name} setting is not text, a number or true/false, so it is ignored. Set it as a string in wrangler.toml [vars] or the dashboard.`);
}
function settingValue(value, name) {
  if (typeof value === "string") return value.trim() || void 0;
  if (typeof value === "number" && Number.isFinite(value) || typeof value === "boolean") return String(value);
  if (value !== void 0 && value !== null) warnIgnoredSetting(name);
  return void 0;
}
var bindingValue = (value) => value === void 0 || value === null || typeof value === "string" && !value.trim() ? void 0 : value;
function readSetting(env, name) {
  return read(env, name, (value, key) => settingValue(value, key));
}
function readBinding(env, name) {
  return read(env, name, bindingValue);
}

export {
  readSetting,
  readBinding
};
