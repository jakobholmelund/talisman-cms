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
  const current = accept(values[`TALISMAN_${name}`]);
  if (current !== void 0) return current;
  const legacy = accept(values[`GALAXY_${name}`]);
  if (legacy !== void 0) warnLegacyName(name);
  return legacy;
}
var settingValue = (value) => typeof value === "string" && value.trim() ? value.trim() : void 0;
var bindingValue = (value) => value === void 0 || value === null || typeof value === "string" && !value.trim() ? void 0 : value;
function readSetting(env, name) {
  return read(env, name, settingValue);
}
function readBinding(env, name) {
  return read(env, name, bindingValue);
}

export {
  readSetting,
  readBinding
};
