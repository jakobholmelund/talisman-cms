import { z } from 'zod';

export type FieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'textarea'
  | 'richtext'
  | 'relationship'
  | 'array'
  | 'blocks'
  | 'select'
  | 'relation'
  | 'group'
  | 'color'
  | 'media';

export type AdminSection = 'collections' | 'commerce';

export interface BlockSettingsConfig {
  name?: string;
  label?: string;
  fields: FieldDefinition[];
}

export interface ComponentSourceDefinition {
  plugin: string;
  library: string;
  item: string;
}

export interface RendererDefinition {
  modulePath: string;
  exportName?: string;
}

export interface ComponentRendererDefinition extends RendererDefinition {
  mode?: 'default' | 'named';
}

export interface AdvancedAdapterDefinition {
  editorModulePath?: string;
  serializerModulePath?: string;
  renderer?: ComponentRendererDefinition;
}

export interface ComponentDefinition {
  slug: string;
  name?: string;
  description?: string;
  category?: string;
  fields: FieldDefinition[];
  source?: ComponentSourceDefinition;
  advanced?: AdvancedAdapterDefinition;
}

export interface ComponentSlotDefinition {
  name: string;
  label: string;
  description?: string;
  hasMany?: boolean;
  components?: ComponentDefinition[];
  componentsFromPlugins?: boolean | string[];
  componentsFromLibraries?: string[];
  allowInline?: boolean;
  allowReferences?: boolean;
}

export interface BlockDefinition {
  slug: string;
  name?: string;
  description?: string;
  category?: string;
  fields: FieldDefinition[];
  componentSlots?: ComponentSlotDefinition[];
  source?: ComponentSourceDefinition;
  tags?: string[];
}

export interface RelationReference {
  relationTo: string;
  value: string;
}

export interface ComponentPresetReference {
  mode: 'preset';
  presetId: string;
}

export interface InlineComponentValue {
  mode: 'inline';
  componentType: string;
  [key: string]: any;
}

export type ComponentSlotValue = ComponentPresetReference | InlineComponentValue;

export interface FieldDefinition {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  defaultValue?: any;
  relationTo?: string | string[];
  hasMany?: boolean;
  fields?: FieldDefinition[];
  blocks?: BlockDefinition[];
  options?: string[];
  blocksFromPlugins?: boolean | string[];
  blockSettings?: BlockSettingsConfig;
}

export interface CollectionHookArgs<T = any> {
  data: Partial<T>;
  req: Request;
  operation: 'create' | 'update' | 'delete';
  originalDoc?: T;
}

export interface CollectionHooks<T = any> {
  beforeValidate?: ((args: CollectionHookArgs<T>) => Promise<Partial<T>> | Partial<T>)[];
  beforeChange?: ((args: CollectionHookArgs<T>) => Promise<Partial<T>> | Partial<T>)[];
  afterChange?: ((args: CollectionHookArgs<T> & { doc: T }) => Promise<void> | void)[];
  beforeDelete?: ((args: Omit<CollectionHookArgs<T>, 'data'>) => Promise<void> | void)[];
  afterDelete?: ((args: Omit<CollectionHookArgs<T>, 'data'> & { doc: T }) => Promise<void> | void)[];
}

/** A server module that exports hooks, or a synchronous factory returning hooks. */
export interface RuntimeCollectionHooks {
  moduleId: string;
  exportName: string;
  factory?: boolean;
  args?: unknown;
}

export interface CollectionConfig {
  name: string;
  slug: string;
  description?: string;
  fields?: FieldDefinition[];
  adminSection?: AdminSection;
  /** Show records in admin while preventing generic CMS edits. */
  readOnly?: boolean;
  /** Minimum role for generic CMS collection operations. Defaults to editor. */
  access?: Partial<Record<'read' | 'create' | 'update' | 'delete', 'admin' | 'editor'>>;
  /** @deprecated Inline hooks cannot be bundled into the Worker. Use runtimeHooks. */
  hooks?: CollectionHooks;
  /** Use runtimeHooks so hook functions survive the server build. */
  runtimeHooks?: RuntimeCollectionHooks[];
  nativeSchemaMapping?: {
    schemaPath: string;
    exportName: string;
    idColumn?: string;
  };
}

export interface GlobalConfig {
  name: string;
  slug: string;
  description?: string;
  fields?: FieldDefinition[];
}

export interface UiLibraryRequirement {
  kind: 'package' | 'css' | 'tailwind' | 'theme';
  label: string;
  value: string;
  optional?: boolean;
}

export interface UiComponentPresetDefinition {
  id: string;
  componentSlug: string;
  libraryId: string;
  label: string;
  variant?: string;
  props?: Record<string, any>;
}

export interface UiLibraryBlockAdapter {
  block: BlockDefinition;
  renderer?: RendererDefinition;
}

export interface UiLibraryComponentAdapter {
  component: ComponentDefinition;
  renderer?: RendererDefinition;
  presets?: UiComponentPresetDefinition[];
}

export interface UiLibraryDefinition {
  id: string;
  name: string;
  requirements?: UiLibraryRequirement[];
  blocks?: UiLibraryBlockAdapter[];
  components?: UiLibraryComponentAdapter[];
  presets?: UiComponentPresetDefinition[];
}

export interface Plugin {
  name: string;
  onInit: (config: any) => any;
  /** Task-oriented links shown in the matching admin workspace. */
  adminLinks?: { section: AdminSection; label: string; description: string; href: string }[];
  endpoints?: { path: string; entrypoint: string; public?: boolean }[];
  routes?: { path: string; entrypoint: string; prerender?: boolean }[];
  adminUi?: { path: string; label: string; componentPath: string; section?: AdminSection }[];
  blocks?: BlockDefinition[];
  components?: ComponentDefinition[];
  uiLibraries?: UiLibraryDefinition[];
  vite?: any;
}

const DEFAULT_BLOCK_SETTINGS_FIELD_NAME = '_settings';
const DEFAULT_BLOCK_SETTINGS_FIELD_LABEL = 'Block Settings';

const relationReferenceSchema = z.object({
  relationTo: z.string(),
  value: z.string(),
});

const componentPresetReferenceSchema = z.object({
  mode: z.literal('preset'),
  presetId: z.string(),
});

export function getRelationTargets(field?: Pick<FieldDefinition, 'relationTo'> | null) {
  if (!field?.relationTo) return [];
  return Array.isArray(field.relationTo) ? field.relationTo : [field.relationTo];
}

export function isPolymorphicRelationField(field?: Pick<FieldDefinition, 'relationTo'> | null) {
  return getRelationTargets(field).length > 1;
}

export function getRelationOptionKey(field?: Pick<FieldDefinition, 'name' | 'relationTo'> | null) {
  const targets = getRelationTargets(field).sort();
  return `${field?.name || 'relation'}:${targets.join('|')}`;
}

export function isRelationReference(value: unknown): value is RelationReference {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'relationTo' in value &&
      'value' in value &&
      typeof (value as RelationReference).relationTo === 'string' &&
      typeof (value as RelationReference).value === 'string'
  );
}

export function isPresetReference(value: unknown): value is ComponentPresetReference {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'mode' in value &&
      (value as ComponentPresetReference).mode === 'preset' &&
      'presetId' in value &&
      typeof (value as ComponentPresetReference).presetId === 'string'
  );
}

export function isInlineComponentValue(value: unknown): value is InlineComponentValue {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'mode' in value &&
      (value as InlineComponentValue).mode === 'inline' &&
      'componentType' in value &&
      typeof (value as InlineComponentValue).componentType === 'string'
  );
}

export function normalizeComponentSlotItem(slot: ComponentSlotDefinition, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, any>;
  let normalized: Record<string, any> = { ...record };

  if (typeof normalized.mode !== 'string') {
    if (typeof normalized.presetId === 'string') {
      normalized.mode = 'preset';
    } else if (typeof normalized.componentType === 'string') {
      normalized.mode = 'inline';
    } else if (slot.allowInline !== false && (slot.components?.length || 0) === 1) {
      normalized.mode = 'inline';
      normalized.componentType = slot.components?.[0]?.slug;
    }
  }

  if (normalized.mode === 'inline' && typeof normalized.componentType === 'string') {
    const component = (slot.components || []).find((candidate) => candidate.slug === normalized.componentType);
    if (component) {
      normalized = normalizeDataForFields(component.fields, normalized);
    }
  }

  return normalized;
}

export function normalizeComponentSlotValue(slot: ComponentSlotDefinition, value: unknown) {
  if (slot.hasMany) {
    if (value === undefined || value === null || value === '') {
      return [];
    }

    const values = Array.isArray(value) ? value : [value];
    return values
      .map((item) => normalizeComponentSlotItem(slot, item))
      .filter((item) => item !== undefined && item !== null && item !== '');
  }

  if (Array.isArray(value)) {
    return normalizeComponentSlotItem(slot, value[0] ?? null);
  }

  return normalizeComponentSlotItem(slot, value);
}

export function normalizeBlockValue(block: BlockDefinition, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const normalized = normalizeDataForFields(block.fields, value as Record<string, any>);

  for (const slot of block.componentSlots || []) {
    normalized[slot.name] = normalizeComponentSlotValue(slot, normalized[slot.name]);
  }

  return normalized;
}

export function normalizeDataForFields(fields: FieldDefinition[] | undefined, value: unknown): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const normalized: Record<string, any> = { ...(value as Record<string, any>) };

  for (const field of fields || []) {
    const fieldValue = normalized[field.name];

    if (field.type === 'group' && field.fields) {
      normalized[field.name] = normalizeDataForFields(field.fields, fieldValue);
      continue;
    }

    if (field.type === 'array' && field.fields && Array.isArray(fieldValue)) {
      // A native JSON column may store a list of strings while the editor uses
      // a one-field row (for example, Commerce product image URLs).
      const stringField = field.fields.length === 1 && field.fields[0].name === 'url';
      normalized[field.name] = fieldValue.map((item) => normalizeDataForFields(
        field.fields,
        stringField && typeof item === 'string' ? { url: item } : item
      ));
      continue;
    }

    if (field.type === 'blocks' && Array.isArray(fieldValue)) {
      normalized[field.name] = fieldValue.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return item;
        }

        const block = (field.blocks || []).find((candidate) => candidate.slug === (item as Record<string, any>).blockType);
        return block ? normalizeBlockValue(block, item) : item;
      });
    }
  }

  return normalized;
}

function cloneFieldDefinition(field: FieldDefinition): FieldDefinition {
  return {
    ...field,
    fields: field.fields ? field.fields.map(cloneFieldDefinition) : undefined,
    blocks: field.blocks ? field.blocks.map(cloneBlockDefinition) : undefined,
    blockSettings: field.blockSettings
      ? {
          ...field.blockSettings,
          fields: field.blockSettings.fields.map(cloneFieldDefinition),
        }
      : undefined,
  };
}

function cloneComponentDefinition(component: ComponentDefinition): ComponentDefinition {
  return {
    ...component,
    fields: component.fields.map(cloneFieldDefinition),
  };
}

function cloneComponentSlotDefinition(slot: ComponentSlotDefinition): ComponentSlotDefinition {
  return {
    ...slot,
    components: slot.components ? slot.components.map(cloneComponentDefinition) : undefined,
  };
}

function cloneBlockDefinition(block: BlockDefinition): BlockDefinition {
  return {
    ...block,
    fields: block.fields.map(cloneFieldDefinition),
    componentSlots: block.componentSlots ? block.componentSlots.map(cloneComponentSlotDefinition) : undefined,
  };
}

function createBlockSettingsField(blockSettings: BlockSettingsConfig): FieldDefinition {
  return {
    name: blockSettings.name || DEFAULT_BLOCK_SETTINGS_FIELD_NAME,
    label: blockSettings.label || DEFAULT_BLOCK_SETTINGS_FIELD_LABEL,
    type: 'group',
    fields: blockSettings.fields.map(cloneFieldDefinition),
  };
}

function getPluginBlockDefinitions(plugins: Plugin[]): BlockDefinition[] {
  const legacy = plugins.flatMap((plugin) => plugin.blocks || []).map(cloneBlockDefinition);
  const library = plugins
    .flatMap((plugin) =>
      (plugin.uiLibraries || []).flatMap((library) =>
        (library.blocks || []).map((adapter) => {
          const block = cloneBlockDefinition(adapter.block);
          if (!block.source) {
            block.source = {
              plugin: plugin.name,
              library: library.id,
              item: block.slug,
            };
          }
          return block;
        })
      )
    );

  return [...legacy, ...library];
}

function getPluginComponentDefinitions(plugins: Plugin[]): ComponentDefinition[] {
  const legacy = plugins.flatMap((plugin) => plugin.components || []).map(cloneComponentDefinition);
  const library = plugins
    .flatMap((plugin) =>
      (plugin.uiLibraries || []).flatMap((library) =>
        (library.components || []).map((adapter) => {
          const component = cloneComponentDefinition(adapter.component);
          if (!component.source) {
            component.source = {
              plugin: plugin.name,
              library: library.id,
              item: component.slug,
            };
          }
          return component;
        })
      )
    );

  return [...legacy, ...library];
}

function getRequestedPluginBlocks(
  blocksFromPlugins: FieldDefinition['blocksFromPlugins'],
  plugins: Plugin[],
): BlockDefinition[] {
  const pluginBlocks = getPluginBlockDefinitions(plugins);

  if (!blocksFromPlugins) return [];
  if (blocksFromPlugins === true) return pluginBlocks;

  const requested = new Set(blocksFromPlugins);
  return pluginBlocks.filter((block) => requested.has(block.slug));
}

function getRequestedPluginComponents(
  componentsFromPlugins: ComponentSlotDefinition['componentsFromPlugins'],
  plugins: Plugin[],
): ComponentDefinition[] {
  const pluginComponents = getPluginComponentDefinitions(plugins);

  if (!componentsFromPlugins) return [];
  if (componentsFromPlugins === true) return pluginComponents;

  const requested = new Set(componentsFromPlugins);
  return pluginComponents.filter((component) => requested.has(component.slug));
}

function getRequestedLibraryComponents(
  componentsFromLibraries: ComponentSlotDefinition['componentsFromLibraries'],
  plugins: Plugin[],
): ComponentDefinition[] {
  const pluginComponents = getPluginComponentDefinitions(plugins);

  if (!componentsFromLibraries || componentsFromLibraries.length === 0) return [];

  const requestedLibraries = new Set(componentsFromLibraries);
  return pluginComponents.filter((component) => component.source?.library && requestedLibraries.has(component.source.library));
}

function withBlockSettings(block: BlockDefinition, blockSettings?: BlockSettingsConfig, plugins: Plugin[] = []): BlockDefinition {
  const normalizedFields = resolveFieldDefinitions(block.fields, plugins);
  const normalizedSlots = resolveComponentSlotDefinitions(block.componentSlots, plugins);

  if (!blockSettings) {
    return {
      ...block,
      fields: normalizedFields,
      componentSlots: normalizedSlots,
    };
  }

  const settingsField = createBlockSettingsField(blockSettings);
  const hasSettingsField = normalizedFields.some((field) => field.name === settingsField.name);

  return {
    ...block,
    fields: hasSettingsField ? normalizedFields : [...normalizedFields, settingsField],
    componentSlots: normalizedSlots,
  };
}

function withResolvedComponent(component: ComponentDefinition, plugins: Plugin[] = []): ComponentDefinition {
  return {
    ...component,
    fields: resolveFieldDefinitions(component.fields, plugins),
  };
}

export function resolveComponentSlotDefinitions(
  slots: ComponentSlotDefinition[] | undefined,
  plugins: Plugin[] = [],
): ComponentSlotDefinition[] {
  if (!slots) return [];

  return slots.map((slot) => {
    const pluginComponents = getRequestedPluginComponents(slot.componentsFromPlugins, plugins).map((component) =>
      withResolvedComponent(component, plugins)
    );
    const libraryComponents = getRequestedLibraryComponents(slot.componentsFromLibraries, plugins).map((component) =>
      withResolvedComponent(component, plugins)
    );
    const inlineComponents = (slot.components || []).map((component) => withResolvedComponent(component, plugins));
    const componentsBySlug = new Map<string, ComponentDefinition>();

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
      components: Array.from(componentsBySlug.values()),
    };
  });
}

export function resolveFieldDefinitions(fields: FieldDefinition[] | undefined, plugins: Plugin[] = []): FieldDefinition[] {
  if (!fields) return [];

  return fields.map((field) => {
    const normalizedField: FieldDefinition = {
      ...field,
      fields: field.fields ? resolveFieldDefinitions(field.fields, plugins) : undefined,
    };

    if (field.type !== 'blocks') {
      return normalizedField;
    }

    const pluginBlocks = getRequestedPluginBlocks(field.blocksFromPlugins, plugins).map((block) =>
      withBlockSettings(block, field.blockSettings, plugins)
    );
    const inlineBlocks = (field.blocks || []).map((block) => withBlockSettings(block, field.blockSettings, plugins));
    const blocksBySlug = new Map<string, BlockDefinition>();

    for (const block of pluginBlocks) {
      blocksBySlug.set(block.slug, block);
    }

    for (const block of inlineBlocks) {
      blocksBySlug.set(block.slug, block);
    }

    return {
      ...normalizedField,
      blocks: Array.from(blocksBySlug.values()),
    };
  });
}

export function getNativeIdColumn(collectionConfig?: Pick<CollectionConfig, 'nativeSchemaMapping'> | null) {
  return collectionConfig?.nativeSchemaMapping?.idColumn || 'id';
}

export function isNativeCollectionConfig(collectionConfig?: Pick<CollectionConfig, 'nativeSchemaMapping'> | null) {
  return Boolean(collectionConfig?.nativeSchemaMapping);
}

export function isSystemManagedNativeField(
  fieldName: string,
  collectionConfig?: Pick<CollectionConfig, 'nativeSchemaMapping'> | null
) {
  if (!isNativeCollectionConfig(collectionConfig)) return false;

  return fieldName === getNativeIdColumn(collectionConfig) || fieldName === 'createdAt' || fieldName === 'updatedAt';
}

function normalizeFieldsForValidation(collectionConfig: CollectionConfig) {
  if (!collectionConfig.nativeSchemaMapping) {
    return resolveFieldDefinitions(collectionConfig.fields || []);
  }

  return resolveFieldDefinitions(collectionConfig.fields || []).map((field) =>
    isSystemManagedNativeField(field.name, collectionConfig)
      ? { ...field, required: false }
      : field
  );
}

/**
 * A native collection's fields are the allowlist for what an API client may write: keys that do
 * not name a configured field (by property or column name) are dropped, so a table column left
 * out of `fields` cannot be set through the CMS. Collections without `fields` expose every column.
 */
export function pickConfiguredNativeFields(
  fields: Pick<FieldDefinition, 'name'>[],
  table: Record<string, any> | null | undefined,
  data: Record<string, any>
) {
  const writable = new Set(fields.map((field) => field.name));
  for (const [property, column] of Object.entries(table || {})) {
    if (column && typeof column === 'object' && 'dataType' in column && writable.has(column.name)) {
      writable.add(property);
    }
  }

  return Object.fromEntries(Object.entries(data).filter(([key]) => writable.has(key)));
}

/**
 * Table columns a client tried to set although they are not configured fields, so a mismatch
 * between a client and a collection's `fields` is refused instead of losing the value. `stored` is
 * the row an update changes: the admin editor sends every column it loaded, so a column that still
 * holds its stored value is not a write. Without `stored` (a create), any value but an empty one is.
 */
export function findUnwritableNativeColumns(
  fields: Pick<FieldDefinition, 'name'>[],
  table: Record<string, any> | null | undefined,
  data: Record<string, any>,
  options: { ignore?: string[]; stored?: Record<string, any> } = {}
) {
  const writable = pickConfiguredNativeFields(fields, table, data);
  return Object.keys(data).filter((key) => {
    const column = table?.[key];
    if (Object.hasOwn(writable, key) || options.ignore?.includes(key) || !column || typeof column !== 'object' || !('dataType' in column)) {
      return false;
    }
    const value = data[key];
    if (options.stored) return JSON.stringify(value ?? null) !== JSON.stringify(options.stored[key] ?? null);
    return value !== undefined && value !== null && value !== '';
  });
}

const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const ENTRY_SLUG_SEGMENT_PATTERN = /^[\p{L}\p{N}_.~:-]+$/u;
// `new` is the admin's create route and `all` the key of cached entry lists.
const RESERVED_ENTRY_IDS = new Set(['new', 'all']);
export const MAX_ENTRY_ID_LENGTH = 128;
export const MAX_ENTRY_SLUG_LENGTH = 200;

/** Why an entry id chosen by a client cannot be used, or null when it can. */
export function describeInvalidEntryId(value: unknown): string | null {
  if (typeof value !== 'string') return 'Entry id must be a string';
  if (value.length === 0 || value.length > MAX_ENTRY_ID_LENGTH) {
    return `Entry id must be 1 to ${MAX_ENTRY_ID_LENGTH} characters`;
  }
  if (!ENTRY_ID_PATTERN.test(value)) {
    return 'Entry id may only use letters, numbers, ".", "_", ":" and "-", and must start with a letter or number';
  }
  if (RESERVED_ENTRY_IDS.has(value)) return `Entry id "${value}" is reserved`;
  return null;
}

/** Why a slug cannot be used, or null when it can. Slugs are URL paths: segments joined by "/". */
export function describeInvalidEntrySlug(value: unknown): string | null {
  if (typeof value !== 'string') return 'Slug must be a string';
  if (value.length === 0 || value.length > MAX_ENTRY_SLUG_LENGTH) {
    return `Slug must be 1 to ${MAX_ENTRY_SLUG_LENGTH} characters`;
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || !ENTRY_SLUG_SEGMENT_PATTERN.test(segment))) {
    return 'Slug may only use letters, numbers, "-", "_", ".", "~" and ":", with single "/" between path segments';
  }
  return null;
}

export function prepareNativeWritePayload(
  collectionConfig: CollectionConfig,
  data: Record<string, any>,
  mode: 'create' | 'update',
  now = new Date()
) {
  if (!collectionConfig.nativeSchemaMapping) {
    return { ...data };
  }

  const payload: Record<string, any> = { ...data };
  const idColumn = getNativeIdColumn(collectionConfig);
  const idField = collectionConfig.fields?.find((field) => field.name === idColumn);

  for (const field of collectionConfig.fields || []) {
    if (field.type === 'array' && field.fields?.length === 1 && field.fields[0].name === 'url' &&
        Array.isArray(payload[field.name])) {
      payload[field.name] = payload[field.name].map((item: unknown) =>
        item && typeof item === 'object' && 'url' in item ? (item as { url: unknown }).url : item
      );
    }
  }

  for (const fieldName of [idColumn, 'createdAt', 'updatedAt']) {
    if (payload[fieldName] === '') {
      delete payload[fieldName];
    }
  }

  if (mode === 'update') {
    delete payload[idColumn];
    delete payload.createdAt;
    payload.updatedAt = now;
    return payload;
  }

  if (payload[idColumn] === undefined || payload[idColumn] === null) {
    if (idField?.type !== 'number') {
      payload[idColumn] = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  payload.createdAt = now;
  payload.updatedAt = now;

  return payload;
}

function buildComponentSlotSchema(slot: ComponentSlotDefinition): z.ZodTypeAny {
  const inlineSchemas =
    slot.allowInline !== false && slot.components && slot.components.length > 0
      ? slot.components.map((component) =>
          buildZodSchemaForFields(component.fields).extend({
            mode: z.literal('inline'),
            componentType: z.literal(component.slug),
          })
        )
      : [];

  let itemSchema: z.ZodTypeAny;
  if (inlineSchemas.length === 0 && !slot.allowReferences) {
    itemSchema = z.any();
  } else if (inlineSchemas.length === 0) {
    itemSchema = componentPresetReferenceSchema;
  } else if (!slot.allowReferences) {
    itemSchema = inlineSchemas.length === 1
      ? inlineSchemas[0]
      : z.discriminatedUnion('componentType', inlineSchemas as any);
  } else if (inlineSchemas.length === 1) {
    itemSchema = z.discriminatedUnion('mode', [inlineSchemas[0], componentPresetReferenceSchema] as any);
  } else {
    itemSchema = z.union(([
      ...inlineSchemas,
      componentPresetReferenceSchema,
    ] as unknown) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  if (slot.hasMany) {
    return z.preprocess((value) => normalizeComponentSlotValue(slot, value), z.array(itemSchema));
  }

  return z.preprocess((value) => normalizeComponentSlotValue(slot, value), itemSchema.nullable().optional());
}

function extendBlockSchemaWithComponentSlots(block: BlockDefinition, baseSchema: z.ZodObject<any>) {
  const slotShape: Record<string, z.ZodTypeAny> = {};

  for (const slot of block.componentSlots || []) {
    slotShape[slot.name] = buildComponentSlotSchema(slot);
  }

  return Object.keys(slotShape).length === 0 ? baseSchema : baseSchema.extend(slotShape);
}

// Structural TipTap nodes: they count as content only through the text or media they contain.
const RICH_TEXT_WRAPPER_NODES = new Set([
  'doc', 'paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'codeBlock', 'hardBreak', 'text',
]);

/** True for a rich text value with nothing to show: a blank string or a TipTap document without text or media. */
export function isEmptyRichText(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim() === '';
  if (typeof value !== 'object' || Array.isArray(value) || (value as { type?: unknown }).type !== 'doc') return false;

  const hasContent = (node: any): boolean => {
    if (!node || typeof node !== 'object') return false;
    if (typeof node.text === 'string' && node.text.trim()) return true;
    if (typeof node.type === 'string' && !RICH_TEXT_WRAPPER_NODES.has(node.type)) return true;
    return Array.isArray(node.content) && node.content.some(hasContent);
  };
  return !hasContent(value);
}

const REQUIRED_MESSAGE = 'Required';
const isBlankString = (value: unknown) => typeof value === 'string' && value.trim() === '';

/** A required scalar also rejects blank text; missing and null values already fail its type check. */
function requireValue(field: FieldDefinition, schema: z.ZodTypeAny): z.ZodTypeAny {
  if (field.type === 'richtext') {
    return schema.refine((value) => !isEmptyRichText(value), { message: REQUIRED_MESSAGE });
  }

  if (['group', 'array', 'blocks', 'number', 'boolean'].includes(field.type) ||
      (isRelationshipFieldType(field.type) && (field.hasMany || isPolymorphicRelationField(field)))) {
    return schema;
  }

  return schema.refine((value) => !isBlankString(value), { message: REQUIRED_MESSAGE });
}

function isRelationshipFieldType(type: FieldType) {
  return type === 'relationship' || type === 'relation';
}

export interface FieldValidationIssue {
  path: PropertyKey[];
  message: string;
  code?: string;
  received?: unknown;
}

/**
 * The 400 body for invalid entry or global data: a summary plus messages keyed by field name
 * (a dotted path for nested fields), next to the raw `issues`.
 */
export function formatValidationIssues(issues: FieldValidationIssue[]) {
  const fieldErrors: Record<string, string[]> = {};

  for (const issue of issues) {
    const path = issue.path.map(String).join('.');
    if (!path) continue;
    // Zod reports a null required value as a type mismatch; editors see both as a missing value.
    const message = issue.code === 'invalid_type' && (issue.received === 'undefined' || issue.received === 'null')
      ? REQUIRED_MESSAGE
      : issue.message;
    const messages = fieldErrors[path] ??= [];
    if (!messages.includes(message)) messages.push(message);
  }

  const names = Object.keys(fieldErrors);
  return {
    error: names.length > 0
      ? `Some fields are invalid: ${names.join(', ')}`
      : issues[0]?.message || 'Validation failed',
    fieldErrors,
    issues,
  };
}

export function buildZodSchemaForFields(fields: FieldDefinition[]): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};

  if (!fields) return z.object({});

  for (const field of fields) {
    let fieldSchema: z.ZodTypeAny;

    switch (field.type) {
      case 'number':
        fieldSchema = z.number();
        break;
      case 'boolean':
        fieldSchema = z.boolean();
        break;
      case 'date':
        fieldSchema = z.union([z.string().datetime(), z.date(), z.string()]);
        break;
      case 'richtext':
        fieldSchema = z.any();
        break;
      case 'relationship':
      case 'relation':
        if (isPolymorphicRelationField(field)) {
          fieldSchema = field.hasMany ? z.array(relationReferenceSchema) : relationReferenceSchema;
        } else if (field.hasMany) {
          fieldSchema = z.array(z.string());
        } else {
          fieldSchema = z.string();
        }
        break;
      case 'select':
        fieldSchema = field.options && field.options.length > 0
          ? z.enum(field.options as [string, ...string[]])
          : z.string();
        break;
      case 'group':
        fieldSchema = field.fields ? buildZodSchemaForFields(field.fields) : z.any();
        break;
      case 'array':
        fieldSchema = field.fields ? z.array(buildZodSchemaForFields(field.fields)) : z.array(z.any());
        break;
      case 'blocks':
        if (field.blocks && field.blocks.length > 0) {
          const blockSchemas = field.blocks.map((block) =>
            extendBlockSchemaWithComponentSlots(
              block,
              buildZodSchemaForFields(block.fields).extend({
                blockType: z.literal(block.slug),
              }),
            )
          );
          fieldSchema = blockSchemas.length > 1
            ? z.array(z.discriminatedUnion('blockType', blockSchemas as any))
            : z.array(blockSchemas[0]);
        } else {
          fieldSchema = z.array(z.any());
        }
        break;
      case 'text':
      case 'textarea':
      case 'color':
      default:
        fieldSchema = z.string();
        break;
    }

    fieldSchema = field.required
      ? requireValue(field, fieldSchema)
      : fieldSchema.optional().nullable();

    shape[field.name] = fieldSchema;
  }

  return z.object(shape).passthrough();
}

/** Global data is a JSON object (not an array or scalar). */
export function isGlobalData(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Global data is stored as one JSON object. Older rows hold that JSON as text inside a JSON
 * string (it was encoded twice), so string values are decoded until the object appears.
 */
export function decodeGlobalData(value: unknown): Record<string, any> {
  let data = value;
  for (let depth = 0; typeof data === 'string' && depth < 3; depth += 1) {
    try {
      data = JSON.parse(data);
    } catch {
      return {};
    }
  }
  return isGlobalData(data) ? data : {};
}

export function buildZodSchemaForCollection(collectionConfig: CollectionConfig) {
  return buildZodSchemaForFields(normalizeFieldsForValidation(collectionConfig));
}

export function getPluginUiLibraries(plugins: Plugin[] = []): UiLibraryDefinition[] {
  return plugins.flatMap((plugin) => plugin.uiLibraries || []);
}

export function getPluginUiLibraryMetadata(plugins: Plugin[] = []) {
  return getPluginUiLibraries(plugins).map((library) => ({
    id: library.id,
    name: library.name,
    requirements: library.requirements || [],
    presets: library.presets || [],
    blockSlugs: (library.blocks || []).map((adapter) => adapter.block.slug),
    componentSlugs: (library.components || []).map((adapter) => adapter.component.slug),
  }));
}

export function generateFieldsFromDrizzle(table: any): FieldDefinition[] {
  if (!table) return [];
  const fields: FieldDefinition[] = [];

  for (const [key, column] of Object.entries(table)) {
    if (typeof column !== 'object' || column === null || !('dataType' in column)) continue;

    const colName = (column as any).name || key;
    const dataType = (column as any).dataType;

    let type: FieldType = 'text';
    if (dataType === 'number' || dataType === 'integer' || dataType === 'real') type = 'number';
    if (dataType === 'boolean') type = 'boolean';
    if (dataType === 'date' || dataType === 'timestamp') type = 'date';
    if (dataType === 'json') type = 'richtext';

    fields.push({
      name: colName,
      label: key.charAt(0).toUpperCase() + key.slice(1),
      type,
      // A NOT NULL column with a database default can be left out; the default fills it.
      required: (column as any).notNull === true && (column as any).hasDefault !== true,
    });
  }

  return fields;
}
