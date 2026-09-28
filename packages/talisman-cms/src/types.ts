import { z } from 'zod';
import { columnKind } from './db/column-kind';
import type { Actor } from './service/actor';
import type { TalismanAuthAdapter } from './auth/types';
import type { EmailRuntimeDescriptor } from './email/types';

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

/**
 * The admin area a collection is listed in: `collections` is built in, and a plugin registers others
 * with `Plugin.adminSections`. A collection whose section is not registered is listed under Collections.
 */
export type AdminSection = string;

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
  /**
   * The admin editor sends this field of a native record only when the user changed it. For a value
   * that server code changes in place, such as a stock count that checkout reserves and releases, a
   * save that re-sent the value loaded at page open would undo those changes.
   */
  saveOnlyIfChanged?: boolean;
}

export interface CollectionHookArgs<T = any> {
  data: Partial<T>;
  operation: 'create' | 'update' | 'delete';
  originalDoc?: T;
  /** Who is writing: the admin API's signed-in user, or trusted server code such as the SDK. */
  actor: Actor;
  /** The HTTP request, set only when the write came through the admin API. */
  req?: Request;
  /** The collection being written. */
  collection: { slug: string; native: boolean };
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

/**
 * An admin section a plugin adds next to Collections: a sidebar entry, the routes `/<id>`,
 * `/<id>/<slug>` and `/<id>/<slug>/<entryId>`, and the collections whose `adminSection` names it.
 */
export interface AdminSectionDefinition {
  /** The URL segment and the value of `CollectionConfig.adminSection`: a lowercase slug. */
  id: string;
  label: string;
  description?: string;
  /** One of `shopping-cart`, `store`, `package`, `chart` or `layout-grid` (the default). */
  icon?: string;
  /**
   * The workspace and the extensions it links need the admin role. Editors get the section's
   * collections they may read under Collections instead.
   */
  adminOnly?: boolean;
  /**
   * A module whose default export renders the section's index page with `AdminSectionWorkspaceProps`
   * (from `talisman-cms/ui/lib/admin-sections`). Without one the generic collection table is shown.
   */
  componentPath?: string;
  /** Shown by the generic collection table when the section has no collections. */
  emptyState?: { title: string; body: string };
}

/**
 * A panel the entry editor renders for matching collections. The module's default export takes
 * `AdminEditorPanelProps` (from `talisman-cms/ui/components/editor/panels`) and loads when the editor
 * first shows it.
 */
export interface AdminEditorPanelDefinition {
  id: string;
  componentPath: string;
  /** `before-fields`: in the form card above the fields; `after-form`: below the form and its actions. */
  placement: 'before-fields' | 'after-form';
  /** Collections in one of these sections get the panel. */
  sections?: string[];
  /** Collections with one of these slugs get the panel. With neither list, every collection does. */
  slugs?: string[];
}

/**
 * A module that labels records. It exports `describeEntry(slug, entry, entriesBySlug, ctx)`, which
 * returns `{ title, subtitle, details }` for a record it knows and null for any other, and
 * `supportCollections(slug, relationTargets)`, the slugs of the extra collections the editor of
 * `slug` loads so the labels can name related records. Both are optional. See
 * `EntryDescriberModule` in `talisman-cms/ui/lib/entry-labels`.
 */
export interface AdminEntryDescriberDefinition {
  modulePath: string;
}

export interface TalismanCmsOptions {
  /**
   * The base path where the CMS admin dashboard will be served.
   * @default '/admin'
   */
  adminPath?: string;

  /**
   * The authentication provider used to protect the CMS routes.
   * Required for production.
   */
  auth?: TalismanAuthAdapter;

  /**
   * Schemas defining the data collections managed by Talisman CMS.
   */
  collections?: CollectionConfig[];

  /**
   * Schemas defining singleton global documents managed by Talisman CMS.
   */
  globals?: GlobalConfig[];

  /**
   * Plugins to extend Talisman CMS functionality
   */
  plugins?: Plugin[];

  /**
   * A custom email provider, loaded in the Worker from `customEmail({ moduleId, exportName, args })`
   * (`talisman-cms/email`). It is used when `TALISMAN_EMAIL_PROVIDER` is unset or `custom`.
   * Without it, email goes through the `[[send_email]]` binding named `EMAIL`.
   */
  email?: EmailRuntimeDescriptor;

  /**
   * The folder, relative to the project root, into which the core's and every plugin's D1 migrations
   * are copied on each config setup. Point the `DB` binding's `migrations_dir` at it.
   * @default 'node_modules/.talisman-cms/migrations'
   */
  migrationsDir?: string;

  /**
   * Optional Cloudflare Workflow binding used for publish/archive transitions.
   */
  publishing?: {
    /**
     * Workflow binding available on the Worker environment.
     * @default 'TALISMAN_PUBLISH_WORKFLOW'
     */
    workflowBinding?: string;
  };
}

/**
 * The site's options as a plugin's `onInit` sees them: `collections`, `globals` and `plugins` are
 * always arrays, and `adminPath` is normalized (`/admin` by default, `/` for a root admin, otherwise
 * a leading slash and no trailing one).
 */
export interface PluginConfig extends Omit<TalismanCmsOptions, 'adminPath' | 'collections' | 'globals' | 'plugins'> {
  adminPath: string;
  collections: CollectionConfig[];
  globals: GlobalConfig[];
  plugins: Plugin[];
}

export interface Plugin {
  name: string;
  /**
   * Runs once, in registration order, when `talismanCms()` is called. A plugin adds or changes
   * collections, globals and runtime hooks here, and may read what the plugins before it registered.
   * Mutate `config` and return nothing, or return a new config.
   */
  onInit?: (config: PluginConfig) => PluginConfig | void;
  /**
   * Task-oriented links shown in the matching admin workspace. An `href` without a leading slash is
   * relative to the admin path (`extensions/orders` is `/admin/extensions/orders` under the default
   * admin path); one with a leading slash is used as given. Anything that is not a path on the site,
   * such as a URL with a scheme or host, fails the build.
   */
  adminLinks?: { section: AdminSection; label: string; description: string; href: string }[];
  endpoints?: { path: string; entrypoint: string; public?: boolean }[];
  /**
   * Pages the plugin adds. A `path` without a leading slash is relative to the admin path; one with a
   * leading slash is used as given. Pages under the admin path need a CMS session unless `public` is
   * true; pages elsewhere are always public. An admin-path page that needs a session cannot be
   * prerendered.
   */
  routes?: { path: string; entrypoint: string; prerender?: boolean; public?: boolean }[];
  adminUi?: { path: string; label: string; componentPath: string; section?: AdminSection }[];
  /** Admin sections next to Collections. Ids must be unique across plugins and not a built-in route. */
  adminSections?: AdminSectionDefinition[];
  /** Panels the entry editor shows for matching collections. */
  adminEditorPanels?: AdminEditorPanelDefinition[];
  /** Modules that label records in relation pickers and summaries. */
  adminEntryDescribers?: AdminEntryDescriberDefinition[];
  /**
   * Names of `TALISMAN_*` settings, without the prefix, whose values the admin page exposes to the
   * browser as `<meta name="talisman-setting-<name in kebab case>">`. The page is served before
   * sign-in, so the values are visible to anyone who can load it: name display settings only, never
   * allowlists or credentials. Names that look like secrets are refused at config time, and a value
   * that reads like a key or signing secret is left out at request time.
   */
  adminSettings?: string[];
  /**
   * Absolute directories of admin screens that use Tailwind utility classes. Tailwind scans them for
   * the admin stylesheet, so classes used only there are generated too.
   */
  adminStyleSources?: string[];
  blocks?: BlockDefinition[];
  components?: ComponentDefinition[];
  uiLibraries?: UiLibraryDefinition[];
  vite?: any;
  /**
   * D1 migrations the plugin ships: an absolute path to the folder drizzle-kit writes them to, one
   * `<timestamp>_<name>` folder per migration with a `migration.sql` inside (plain `<number>_<name>.sql`
   * files are accepted too). The integration copies them, with the core's, as flat `.sql` files into the
   * one folder a site's `migrations_dir` points at, ordered by the number before the first `_`; a file
   * name never changes once a database has applied it.
   */
  migrations?: { dir: string };
  /**
   * A job the Worker's scheduled handler runs on every cron tick. `moduleId` names a server module and
   * `exportName` the export that holds the job, a `ScheduledJob` from `talisman-cms/worker`;
   * `exportName` defaults to `scheduled`. It is a module reference rather than a function for the same
   * reason as `runtimeHooks`: the plugin object lives in `astro.config` and does not survive the server
   * build. The site exports `scheduled` from `talisman-cms/worker` in its Worker entry and sets a cron
   * trigger in its wrangler config.
   */
  scheduled?: { moduleId: string; exportName?: string };
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
      // a one-field row (for example, a list of image URLs).
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

const FREE_TEXT_FIELD_TYPES = new Set<FieldType>(['text', 'textarea', 'color']);

/**
 * The admin form sends '' for an optional field left blank; in a native table that means "no value".
 * A nullable column is set to NULL, so a blank number is not a type error and a blank value in a
 * UNIQUE or foreign-key column cannot collide with another row. A NOT NULL column keeps '' for free
 * text (a valid value there) and is otherwise left out, so it keeps its database default on create
 * and its stored value on update. Required and server-managed fields are left to validation.
 */
export function normalizeBlankNativeValues(
  collectionConfig: Pick<CollectionConfig, 'nativeSchemaMapping'>,
  fields: Pick<FieldDefinition, 'name' | 'type' | 'required'>[],
  table: Record<string, any> | null | undefined,
  data: Record<string, any>
) {
  const normalized: Record<string, any> = { ...data };
  for (const [key, value] of Object.entries(data)) {
    const column = table?.[key];
    if (value !== '' || !column || typeof column !== 'object' || !('dataType' in column)) continue;
    const field = fields.find((candidate) => candidate.name === key || candidate.name === column.name);
    if (!field || field.required || isSystemManagedNativeField(key, collectionConfig)) continue;

    if (!column.notNull) {
      normalized[key] = null;
    } else if (!FREE_TEXT_FIELD_TYPES.has(field.type)) {
      delete normalized[key];
    }
  }
  return normalized;
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

// Writes that each add a second, such as checkouts reserving stock, can run a row's updatedAt minutes
// or hours ahead of the clock, but not this far.
const MAX_NATIVE_UPDATED_AT_LEAD_MS = 365 * 24 * 60 * 60_000;

/**
 * The updatedAt a native update stores: now, or one second past the stored value when that is not
 * earlier. Native timestamps hold whole seconds, and an editor's save is checked against the
 * updatedAt it loaded, so each write must change the value even within the same second, and must
 * never move it back to a value an editor may still hold. Only a stored value more than a year ahead
 * (a seed that wrote milliseconds, for example) is replaced by now.
 */
export function nextNativeUpdatedAt(stored: unknown, now = new Date()) {
  if (!(stored instanceof Date) || Number.isNaN(stored.getTime())) return now;
  const next = stored.getTime() + 1000;
  return next > now.getTime() && next - now.getTime() <= MAX_NATIVE_UPDATED_AT_LEAD_MS ? new Date(next) : now;
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

/**
 * A number or a select with options cannot hold '', which the admin form sends for a field left
 * blank, so it counts as no value: null for an optional field, "Required" for a required one.
 */
const blankAsNull = (schema: z.ZodTypeAny) => z.preprocess((value) => (value === '' ? null : value), schema);

export function buildZodSchemaForFields(fields: FieldDefinition[]): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};

  if (!fields) return z.object({});

  for (const field of fields) {
    let fieldSchema: z.ZodTypeAny;
    let blankIsEmpty = false;

    switch (field.type) {
      case 'number':
        fieldSchema = z.number();
        blankIsEmpty = true;
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
        blankIsEmpty = Boolean(field.options?.length) && !field.options!.includes('');
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

    shape[field.name] = blankIsEmpty ? blankAsNull(fieldSchema) : fieldSchema;
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

/** A column to expose as a field: its property name, or an override whose own keys win over what the column says. */
export type NativeFieldPick = string | (Partial<Omit<FieldDefinition, 'name'>> & { name: string });

/** "Order ID", "Code Suffix" or "Product Variant Value ID" from a column's property name. */
function labelFromProperty(property: string) {
  return property.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().split(/\s+/)
    .map((word) => word.toLowerCase() === 'id' ? 'ID' : word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

const isColumn = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && 'dataType' in value;

/**
 * The field a Drizzle column stands for on its own. The type follows the column's kind, and an enum
 * column is a `select` with the column's values; a JSON column is `richtext`, which passes any value,
 * until an override says how it is edited (an `array` or `group` with fields, a relation). `required`
 * is NOT NULL without a database default, and a primitive default is the field's `defaultValue`. A
 * nullable number or UNIQUE column starts at null rather than '': a blank number is not a value, and
 * two blank unique values would collide.
 */
function fieldFromColumn(property: string, column: Record<string, any>): FieldDefinition {
  const kind = columnKind(column);
  const options = Array.isArray(column.enumValues) && column.enumValues.length > 0 ? [...column.enumValues] : undefined;
  const type: FieldType = kind === 'number' ? 'number' : kind === 'boolean' ? 'boolean' : kind === 'date' ? 'date'
    : kind === 'json' ? 'richtext' : options ? 'select' : 'text';
  const field: FieldDefinition = { name: property, label: labelFromProperty(property), type };
  if (options) field.options = options;
  if (column.notNull === true && column.hasDefault !== true) field.required = true;
  if (column.hasDefault === true && ['string', 'number', 'boolean'].includes(typeof column.default)) {
    field.defaultValue = column.default;
  } else if (column.notNull !== true && column.hasDefault !== true && (kind === 'number' || column.isUnique === true)) {
    field.defaultValue = null;
  }
  return field;
}

/**
 * Field definitions for a collection mapped to a Drizzle table, read from its columns, so the
 * schema says what each field is and the collection says only what the column cannot: the label
 * where the property name is not one, the widget (a relation, a media array), `saveOnlyIfChanged`.
 * `picks` names the columns to expose, in order, each as a property name or as an override whose
 * own keys win; a pick that names no column throws at config time, so a renamed column is found
 * before the admin loads. Without `picks`, every column is a field, as the service does for a
 * native collection configured without fields.
 */
export function nativeFields(table: any, picks?: NativeFieldPick[]): FieldDefinition[] {
  const columns = Object.entries(table ?? {}).filter((entry): entry is [string, Record<string, any>] => isColumn(entry[1]));
  if (!picks) return columns.map(([property, column]) => fieldFromColumn(property, column));
  return picks.map((pick) => {
    const override = typeof pick === 'string' ? { name: pick } : pick;
    const match = columns.find(([property, column]) => property === override.name || column.name === override.name);
    if (!match) throw new Error(`nativeFields: "${override.name}" is not a column of the table`);
    return { ...fieldFromColumn(override.name, match[1]), ...override };
  });
}
