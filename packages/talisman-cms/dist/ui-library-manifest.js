import "./chunk-MLKGABMK.js";

// src/ui-library-manifest.ts
function buildUiLibraryPresets(components) {
  return (components || []).flatMap((component) => component.presets || []);
}
function buildUiLibraryDefinition(library, blocks, components) {
  return {
    ...library,
    blocks,
    components,
    presets: buildUiLibraryPresets(components)
  };
}
function buildUiLibraryPlugin(pluginName, library) {
  return {
    name: pluginName,
    onInit: (config) => config,
    uiLibraries: [library]
  };
}
function buildUiLibrarySourceReference(pluginName, libraryId, upstreamItemId) {
  return {
    plugin: pluginName,
    library: libraryId,
    item: upstreamItemId
  };
}
function buildUiLibraryBlockDefinition(pluginName, libraryId, item, adapter, componentSlots) {
  return {
    slug: adapter.slug,
    name: adapter.name,
    description: adapter.description,
    category: adapter.category || item.category,
    fields: adapter.fields,
    componentSlots,
    source: buildUiLibrarySourceReference(pluginName, libraryId, item.upstreamItemId),
    tags: adapter.tags
  };
}
function buildUiLibraryComponentDefinition(pluginName, libraryId, item, adapter) {
  return {
    slug: adapter.slug,
    name: adapter.name,
    description: adapter.description,
    category: adapter.category || item.category,
    fields: adapter.fields,
    advanced: adapter.advanced,
    source: buildUiLibrarySourceReference(pluginName, libraryId, item.upstreamItemId)
  };
}
export {
  buildUiLibraryBlockDefinition,
  buildUiLibraryComponentDefinition,
  buildUiLibraryDefinition,
  buildUiLibraryPlugin,
  buildUiLibraryPresets,
  buildUiLibrarySourceReference
};
