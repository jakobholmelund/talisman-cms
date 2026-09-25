import "./chunk-MLKGABMK.js";

// src/render.ts
function parsePresetProps(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (value && typeof value === "object") {
    return value;
  }
  return {};
}
function buildPresetMap(presets) {
  const entries = presets || [];
  return Object.fromEntries(entries.map((preset) => [preset.id, preset]));
}
function resolvePresetComponentValue(preset) {
  const data = typeof preset?.data === "string" ? parsePresetProps(preset.data) : preset?.data || {};
  const props = parsePresetProps(data?.propsJson || data?.props || {});
  return {
    componentType: data?.componentSlug || preset?.componentSlug || "",
    props,
    libraryId: data?.libraryId || preset?.libraryId || "",
    variant: data?.variant || preset?.variant || "",
    name: data?.name || preset?.name || ""
  };
}
function mergeRendererRegistries(...registries) {
  return Object.assign({}, ...registries.filter(Boolean));
}
export {
  buildPresetMap,
  mergeRendererRegistries,
  resolvePresetComponentValue
};
