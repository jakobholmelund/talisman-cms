// src/types.ts
import { z } from "zod";
var DEFAULT_BLOCK_SETTINGS_FIELD_NAME = "_settings";
var DEFAULT_BLOCK_SETTINGS_FIELD_LABEL = "Block Settings";
var relationReferenceSchema = z.object({
  relationTo: z.string(),
  value: z.string()
});
var componentPresetReferenceSchema = z.object({
  mode: z.literal("preset"),
  presetId: z.string()
});
function getRelationTargets(field) {
  if (!field?.relationTo) return [];
  return Array.isArray(field.relationTo) ? field.relationTo : [field.relationTo];
}
function isPolymorphicRelationField(field) {
  return getRelationTargets(field).length > 1;
}
function isRelationReference(value) {
  return Boolean(
    value && typeof value === "object" && "relationTo" in value && "value" in value && typeof value.relationTo === "string" && typeof value.value === "string"
  );
}
function isInlineComponentValue(value) {
  return Boolean(
    value && typeof value === "object" && "mode" in value && value.mode === "inline" && "componentType" in value && typeof value.componentType === "string"
  );
}
function normalizeComponentSlotItem(slot, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value;
  let normalized = { ...record };
  if (typeof normalized.mode !== "string") {
    if (typeof normalized.presetId === "string") {
      normalized.mode = "preset";
    } else if (typeof normalized.componentType === "string") {
      normalized.mode = "inline";
    } else if (slot.allowInline !== false && (slot.components?.length || 0) === 1) {
      normalized.mode = "inline";
      normalized.componentType = slot.components?.[0]?.slug;
    }
  }
  if (normalized.mode === "inline" && typeof normalized.componentType === "string") {
    const component = (slot.components || []).find((candidate) => candidate.slug === normalized.componentType);
    if (component) {
      normalized = normalizeDataForFields(component.fields, normalized);
    }
  }
  return normalized;
}
function normalizeComponentSlotValue(slot, value) {
  if (slot.hasMany) {
    if (value === void 0 || value === null || value === "") {
      return [];
    }
    const values = Array.isArray(value) ? value : [value];
    return values.map((item) => normalizeComponentSlotItem(slot, item)).filter((item) => item !== void 0 && item !== null && item !== "");
  }
  if (Array.isArray(value)) {
    return normalizeComponentSlotItem(slot, value[0] ?? null);
  }
  return normalizeComponentSlotItem(slot, value);
}
function normalizeBlockValue(block, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const normalized = normalizeDataForFields(block.fields, value);
  for (const slot of block.componentSlots || []) {
    normalized[slot.name] = normalizeComponentSlotValue(slot, normalized[slot.name]);
  }
  return normalized;
}
function normalizeDataForFields(fields, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const normalized = { ...value };
  for (const field of fields || []) {
    const fieldValue = normalized[field.name];
    if (field.type === "group" && field.fields) {
      normalized[field.name] = normalizeDataForFields(field.fields, fieldValue);
      continue;
    }
    if (field.type === "array" && field.fields && Array.isArray(fieldValue)) {
      const stringField = field.fields.length === 1 && field.fields[0].name === "url";
      normalized[field.name] = fieldValue.map((item) => normalizeDataForFields(
        field.fields,
        stringField && typeof item === "string" ? { url: item } : item
      ));
      continue;
    }
    if (field.type === "blocks" && Array.isArray(fieldValue)) {
      normalized[field.name] = fieldValue.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return item;
        }
        const block = (field.blocks || []).find((candidate) => candidate.slug === item.blockType);
        return block ? normalizeBlockValue(block, item) : item;
      });
    }
  }
  return normalized;
}
function cloneFieldDefinition(field) {
  return {
    ...field,
    fields: field.fields ? field.fields.map(cloneFieldDefinition) : void 0,
    blocks: field.blocks ? field.blocks.map(cloneBlockDefinition) : void 0,
    blockSettings: field.blockSettings ? {
      ...field.blockSettings,
      fields: field.blockSettings.fields.map(cloneFieldDefinition)
    } : void 0
  };
}
function cloneComponentDefinition(component) {
  return {
    ...component,
    fields: component.fields.map(cloneFieldDefinition)
  };
}
function cloneComponentSlotDefinition(slot) {
  return {
    ...slot,
    components: slot.components ? slot.components.map(cloneComponentDefinition) : void 0
  };
}
function cloneBlockDefinition(block) {
  return {
    ...block,
    fields: block.fields.map(cloneFieldDefinition),
    componentSlots: block.componentSlots ? block.componentSlots.map(cloneComponentSlotDefinition) : void 0
  };
}
function createBlockSettingsField(blockSettings) {
  return {
    name: blockSettings.name || DEFAULT_BLOCK_SETTINGS_FIELD_NAME,
    label: blockSettings.label || DEFAULT_BLOCK_SETTINGS_FIELD_LABEL,
    type: "group",
    fields: blockSettings.fields.map(cloneFieldDefinition)
  };
}
function getPluginBlockDefinitions(plugins) {
  const legacy = plugins.flatMap((plugin) => plugin.blocks || []).map(cloneBlockDefinition);
  const library = plugins.flatMap(
    (plugin) => (plugin.uiLibraries || []).flatMap(
      (library2) => (library2.blocks || []).map((adapter) => {
        const block = cloneBlockDefinition(adapter.block);
        if (!block.source) {
          block.source = {
            plugin: plugin.name,
            library: library2.id,
            item: block.slug
          };
        }
        return block;
      })
    )
  );
  return [...legacy, ...library];
}
function getPluginComponentDefinitions(plugins) {
  const legacy = plugins.flatMap((plugin) => plugin.components || []).map(cloneComponentDefinition);
  const library = plugins.flatMap(
    (plugin) => (plugin.uiLibraries || []).flatMap(
      (library2) => (library2.components || []).map((adapter) => {
        const component = cloneComponentDefinition(adapter.component);
        if (!component.source) {
          component.source = {
            plugin: plugin.name,
            library: library2.id,
            item: component.slug
          };
        }
        return component;
      })
    )
  );
  return [...legacy, ...library];
}
function getRequestedPluginBlocks(blocksFromPlugins, plugins) {
  const pluginBlocks = getPluginBlockDefinitions(plugins);
  if (!blocksFromPlugins) return [];
  if (blocksFromPlugins === true) return pluginBlocks;
  const requested = new Set(blocksFromPlugins);
  return pluginBlocks.filter((block) => requested.has(block.slug));
}
function getRequestedPluginComponents(componentsFromPlugins, plugins) {
  const pluginComponents = getPluginComponentDefinitions(plugins);
  if (!componentsFromPlugins) return [];
  if (componentsFromPlugins === true) return pluginComponents;
  const requested = new Set(componentsFromPlugins);
  return pluginComponents.filter((component) => requested.has(component.slug));
}
function getRequestedLibraryComponents(componentsFromLibraries, plugins) {
  const pluginComponents = getPluginComponentDefinitions(plugins);
  if (!componentsFromLibraries || componentsFromLibraries.length === 0) return [];
  const requestedLibraries = new Set(componentsFromLibraries);
  return pluginComponents.filter((component) => component.source?.library && requestedLibraries.has(component.source.library));
}
function withBlockSettings(block, blockSettings, plugins = []) {
  const normalizedFields = resolveFieldDefinitions(block.fields, plugins);
  const normalizedSlots = resolveComponentSlotDefinitions(block.componentSlots, plugins);
  if (!blockSettings) {
    return {
      ...block,
      fields: normalizedFields,
      componentSlots: normalizedSlots
    };
  }
  const settingsField = createBlockSettingsField(blockSettings);
  const hasSettingsField = normalizedFields.some((field) => field.name === settingsField.name);
  return {
    ...block,
    fields: hasSettingsField ? normalizedFields : [...normalizedFields, settingsField],
    componentSlots: normalizedSlots
  };
}
function withResolvedComponent(component, plugins = []) {
  return {
    ...component,
    fields: resolveFieldDefinitions(component.fields, plugins)
  };
}
function resolveComponentSlotDefinitions(slots, plugins = []) {
  if (!slots) return [];
  return slots.map((slot) => {
    const pluginComponents = getRequestedPluginComponents(slot.componentsFromPlugins, plugins).map(
      (component) => withResolvedComponent(component, plugins)
    );
    const libraryComponents = getRequestedLibraryComponents(slot.componentsFromLibraries, plugins).map(
      (component) => withResolvedComponent(component, plugins)
    );
    const inlineComponents = (slot.components || []).map((component) => withResolvedComponent(component, plugins));
    const componentsBySlug = /* @__PURE__ */ new Map();
    for (const component of pluginComponents) {
      componentsBySlug.set(component.slug, component);
    }
    for (const component of libraryComponents) {
      componentsBySlug.set(component.slug, component);
    }
    for (const component of inlineComponents) {
      componentsBySlug.set(component.slug, component);
    }
    return {
      ...slot,
      allowInline: slot.allowInline !== false,
      allowReferences: slot.allowReferences === true,
      components: Array.from(componentsBySlug.values())
    };
  });
}
function resolveFieldDefinitions(fields, plugins = []) {
  if (!fields) return [];
  return fields.map((field) => {
    const normalizedField = {
      ...field,
      fields: field.fields ? resolveFieldDefinitions(field.fields, plugins) : void 0
    };
    if (field.type !== "blocks") {
      return normalizedField;
    }
    const pluginBlocks = getRequestedPluginBlocks(field.blocksFromPlugins, plugins).map(
      (block) => withBlockSettings(block, field.blockSettings, plugins)
    );
    const inlineBlocks = (field.blocks || []).map((block) => withBlockSettings(block, field.blockSettings, plugins));
    const blocksBySlug = /* @__PURE__ */ new Map();
    for (const block of pluginBlocks) {
      blocksBySlug.set(block.slug, block);
    }
    for (const block of inlineBlocks) {
      blocksBySlug.set(block.slug, block);
    }
    return {
      ...normalizedField,
      blocks: Array.from(blocksBySlug.values())
    };
  });
}
function getNativeIdColumn(collectionConfig) {
  return collectionConfig?.nativeSchemaMapping?.idColumn || "id";
}
function prepareNativeWritePayload(collectionConfig, data, mode, now = /* @__PURE__ */ new Date()) {
  if (!collectionConfig.nativeSchemaMapping) {
    return { ...data };
  }
  const payload = { ...data };
  const idColumn = getNativeIdColumn(collectionConfig);
  const idField = collectionConfig.fields?.find((field) => field.name === idColumn);
  for (const field of collectionConfig.fields || []) {
    if (field.type === "array" && field.fields?.length === 1 && field.fields[0].name === "url" && Array.isArray(payload[field.name])) {
      payload[field.name] = payload[field.name].map(
        (item) => item && typeof item === "object" && "url" in item ? item.url : item
      );
    }
  }
  for (const fieldName of [idColumn, "createdAt", "updatedAt"]) {
    if (payload[fieldName] === "") {
      delete payload[fieldName];
    }
  }
  if (mode === "update") {
    delete payload[idColumn];
    delete payload.createdAt;
    payload.updatedAt = now;
    return payload;
  }
  if (payload[idColumn] === void 0 || payload[idColumn] === null) {
    if (idField?.type !== "number") {
      payload[idColumn] = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
  }
  payload.createdAt = now;
  payload.updatedAt = now;
  return payload;
}
function buildComponentSlotSchema(slot) {
  const inlineSchemas = slot.allowInline !== false && slot.components && slot.components.length > 0 ? slot.components.map(
    (component) => buildZodSchemaForFields(component.fields).extend({
      mode: z.literal("inline"),
      componentType: z.literal(component.slug)
    })
  ) : [];
  let itemSchema;
  if (inlineSchemas.length === 0 && !slot.allowReferences) {
    itemSchema = z.any();
  } else if (inlineSchemas.length === 0) {
    itemSchema = componentPresetReferenceSchema;
  } else if (!slot.allowReferences) {
    itemSchema = inlineSchemas.length === 1 ? inlineSchemas[0] : z.discriminatedUnion("componentType", inlineSchemas);
  } else if (inlineSchemas.length === 1) {
    itemSchema = z.discriminatedUnion("mode", [inlineSchemas[0], componentPresetReferenceSchema]);
  } else {
    itemSchema = z.union([
      ...inlineSchemas,
      componentPresetReferenceSchema
    ]);
  }
  if (slot.hasMany) {
    return z.preprocess((value) => normalizeComponentSlotValue(slot, value), z.array(itemSchema));
  }
  return z.preprocess((value) => normalizeComponentSlotValue(slot, value), itemSchema.nullable().optional());
}
function extendBlockSchemaWithComponentSlots(block, baseSchema) {
  const slotShape = {};
  for (const slot of block.componentSlots || []) {
    slotShape[slot.name] = buildComponentSlotSchema(slot);
  }
  return Object.keys(slotShape).length === 0 ? baseSchema : baseSchema.extend(slotShape);
}
var RICH_TEXT_WRAPPER_NODES = /* @__PURE__ */ new Set([
  "doc",
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
  "hardBreak",
  "text"
]);
function isEmptyRichText(value) {
  if (value === void 0 || value === null) return true;
  if (typeof value === "string") return value.replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim() === "";
  if (typeof value !== "object" || Array.isArray(value) || value.type !== "doc") return false;
  const hasContent = (node) => {
    if (!node || typeof node !== "object") return false;
    if (typeof node.text === "string" && node.text.trim()) return true;
    if (typeof node.type === "string" && !RICH_TEXT_WRAPPER_NODES.has(node.type)) return true;
    return Array.isArray(node.content) && node.content.some(hasContent);
  };
  return !hasContent(value);
}
var REQUIRED_MESSAGE = "Required";
var isBlankString = (value) => typeof value === "string" && value.trim() === "";
function requireValue(field, schema) {
  if (field.type === "richtext") {
    return schema.refine((value) => !isEmptyRichText(value), { message: REQUIRED_MESSAGE });
  }
  if (["group", "array", "blocks", "number", "boolean"].includes(field.type) || isRelationshipFieldType(field.type) && (field.hasMany || isPolymorphicRelationField(field))) {
    return schema;
  }
  return schema.refine((value) => !isBlankString(value), { message: REQUIRED_MESSAGE });
}
function isRelationshipFieldType(type) {
  return type === "relationship" || type === "relation";
}
function buildZodSchemaForFields(fields) {
  const shape = {};
  if (!fields) return z.object({});
  for (const field of fields) {
    let fieldSchema;
    switch (field.type) {
      case "number":
        fieldSchema = z.number();
        break;
      case "boolean":
        fieldSchema = z.boolean();
        break;
      case "date":
        fieldSchema = z.union([z.string().datetime(), z.date(), z.string()]);
        break;
      case "richtext":
        fieldSchema = z.any();
        break;
      case "relationship":
      case "relation":
        if (isPolymorphicRelationField(field)) {
          fieldSchema = field.hasMany ? z.array(relationReferenceSchema) : relationReferenceSchema;
        } else if (field.hasMany) {
          fieldSchema = z.array(z.string());
        } else {
          fieldSchema = z.string();
        }
        break;
      case "select":
        fieldSchema = field.options && field.options.length > 0 ? z.enum(field.options) : z.string();
        break;
      case "group":
        fieldSchema = field.fields ? buildZodSchemaForFields(field.fields) : z.any();
        break;
      case "array":
        fieldSchema = field.fields ? z.array(buildZodSchemaForFields(field.fields)) : z.array(z.any());
        break;
      case "blocks":
        if (field.blocks && field.blocks.length > 0) {
          const blockSchemas = field.blocks.map(
            (block) => extendBlockSchemaWithComponentSlots(
              block,
              buildZodSchemaForFields(block.fields).extend({
                blockType: z.literal(block.slug)
              })
            )
          );
          fieldSchema = blockSchemas.length > 1 ? z.array(z.discriminatedUnion("blockType", blockSchemas)) : z.array(blockSchemas[0]);
        } else {
          fieldSchema = z.array(z.any());
        }
        break;
      case "text":
      case "textarea":
      case "color":
      default:
        fieldSchema = z.string();
        break;
    }
    fieldSchema = field.required ? requireValue(field, fieldSchema) : fieldSchema.optional().nullable();
    shape[field.name] = fieldSchema;
  }
  return z.object(shape).passthrough();
}
function isGlobalData(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function decodeGlobalData(value) {
  let data = value;
  for (let depth = 0; typeof data === "string" && depth < 3; depth += 1) {
    try {
      data = JSON.parse(data);
    } catch {
      return {};
    }
  }
  return isGlobalData(data) ? data : {};
}
function getPluginUiLibraries(plugins = []) {
  return plugins.flatMap((plugin) => plugin.uiLibraries || []);
}
function getPluginUiLibraryMetadata(plugins = []) {
  return getPluginUiLibraries(plugins).map((library) => ({
    id: library.id,
    name: library.name,
    requirements: library.requirements || [],
    presets: library.presets || [],
    blockSlugs: (library.blocks || []).map((adapter) => adapter.block.slug),
    componentSlugs: (library.components || []).map((adapter) => adapter.component.slug)
  }));
}
function generateFieldsFromDrizzle(table) {
  if (!table) return [];
  const fields = [];
  for (const [key, column] of Object.entries(table)) {
    if (typeof column !== "object" || column === null || !("dataType" in column)) continue;
    const colName = column.name || key;
    const dataType = column.dataType;
    let type = "text";
    if (dataType === "number" || dataType === "integer" || dataType === "real") type = "number";
    if (dataType === "boolean") type = "boolean";
    if (dataType === "date" || dataType === "timestamp") type = "date";
    if (dataType === "json") type = "richtext";
    fields.push({
      name: colName,
      label: key.charAt(0).toUpperCase() + key.slice(1),
      type,
      // A NOT NULL column with a database default can be left out; the default fills it.
      required: column.notNull === true && column.hasDefault !== true
    });
  }
  return fields;
}

export {
  getRelationTargets,
  isPolymorphicRelationField,
  isRelationReference,
  isInlineComponentValue,
  resolveFieldDefinitions,
  prepareNativeWritePayload,
  buildZodSchemaForFields,
  isGlobalData,
  decodeGlobalData,
  getPluginUiLibraryMetadata,
  generateFieldsFromDrizzle
};
