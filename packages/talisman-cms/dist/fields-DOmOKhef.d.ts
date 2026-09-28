import { A as Actor } from './actor-Daa_hmny.js';
import { T as TalismanAuthAdapter } from './types-C5a-hx5D.js';
import { E as EmailRuntimeDescriptor } from './types-CqOBvOgc.js';

type FieldType = 'text' | 'number' | 'boolean' | 'date' | 'textarea' | 'richtext' | 'relationship' | 'array' | 'blocks' | 'select' | 'relation' | 'group' | 'color' | 'media';
/**
 * The admin area a collection is listed in: `collections` is built in, and a plugin registers others
 * with `Plugin.adminSections`. A collection whose section is not registered is listed under Collections.
 */
type AdminSection = string;
interface BlockSettingsConfig {
    name?: string;
    label?: string;
    fields: FieldDefinition[];
}
interface ComponentSourceDefinition {
    plugin: string;
    library: string;
    item: string;
}
interface RendererDefinition {
    modulePath: string;
    exportName?: string;
}
interface ComponentRendererDefinition extends RendererDefinition {
    mode?: 'default' | 'named';
}
interface AdvancedAdapterDefinition {
    editorModulePath?: string;
    serializerModulePath?: string;
    renderer?: ComponentRendererDefinition;
}
interface ComponentDefinition {
    slug: string;
    name?: string;
    description?: string;
    category?: string;
    fields: FieldDefinition[];
    source?: ComponentSourceDefinition;
    advanced?: AdvancedAdapterDefinition;
}
interface ComponentSlotDefinition {
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
interface BlockDefinition {
    slug: string;
    name?: string;
    description?: string;
    category?: string;
    fields: FieldDefinition[];
    componentSlots?: ComponentSlotDefinition[];
    source?: ComponentSourceDefinition;
    tags?: string[];
}
interface RelationReference {
    relationTo: string;
    value: string;
}
interface FieldDefinition {
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
interface CollectionHookArgs<T = any> {
    data: Partial<T>;
    operation: 'create' | 'update' | 'delete';
    originalDoc?: T;
    /** Who is writing: the admin API's signed-in user, or trusted server code such as the SDK. */
    actor: Actor;
    /** The HTTP request, set only when the write came through the admin API. */
    req?: Request;
    /** The collection being written. */
    collection: {
        slug: string;
        native: boolean;
    };
}
interface CollectionHooks<T = any> {
    beforeValidate?: ((args: CollectionHookArgs<T>) => Promise<Partial<T>> | Partial<T>)[];
    beforeChange?: ((args: CollectionHookArgs<T>) => Promise<Partial<T>> | Partial<T>)[];
    afterChange?: ((args: CollectionHookArgs<T> & {
        doc: T;
    }) => Promise<void> | void)[];
    beforeDelete?: ((args: Omit<CollectionHookArgs<T>, 'data'>) => Promise<void> | void)[];
    afterDelete?: ((args: Omit<CollectionHookArgs<T>, 'data'> & {
        doc: T;
    }) => Promise<void> | void)[];
}
/** A server module that exports hooks, or a synchronous factory returning hooks. */
interface RuntimeCollectionHooks {
    moduleId: string;
    exportName: string;
    factory?: boolean;
    args?: unknown;
}
interface CollectionConfig {
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
interface GlobalConfig {
    name: string;
    slug: string;
    description?: string;
    fields?: FieldDefinition[];
}
interface UiLibraryRequirement {
    kind: 'package' | 'css' | 'tailwind' | 'theme';
    label: string;
    value: string;
    optional?: boolean;
}
interface UiComponentPresetDefinition {
    id: string;
    componentSlug: string;
    libraryId: string;
    label: string;
    variant?: string;
    props?: Record<string, any>;
}
interface UiLibraryBlockAdapter {
    block: BlockDefinition;
    renderer?: RendererDefinition;
}
interface UiLibraryComponentAdapter {
    component: ComponentDefinition;
    renderer?: RendererDefinition;
    presets?: UiComponentPresetDefinition[];
}
interface UiLibraryDefinition {
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
interface AdminSectionDefinition {
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
    emptyState?: {
        title: string;
        body: string;
    };
}
/**
 * A panel the entry editor renders for matching collections. The module's default export takes
 * `AdminEditorPanelProps` (from `talisman-cms/ui/components/editor/panels`) and loads when the editor
 * first shows it.
 */
interface AdminEditorPanelDefinition {
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
interface AdminEntryDescriberDefinition {
    modulePath: string;
}
interface TalismanCmsOptions {
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
interface PluginConfig extends Omit<TalismanCmsOptions, 'adminPath' | 'collections' | 'globals' | 'plugins'> {
    adminPath: string;
    collections: CollectionConfig[];
    globals: GlobalConfig[];
    plugins: Plugin[];
}
interface Plugin {
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
    adminLinks?: {
        section: AdminSection;
        label: string;
        description: string;
        href: string;
    }[];
    endpoints?: {
        path: string;
        entrypoint: string;
        public?: boolean;
    }[];
    /**
     * Pages the plugin adds. A `path` without a leading slash is relative to the admin path; one with a
     * leading slash is used as given. Pages under the admin path need a CMS session unless `public` is
     * true; pages elsewhere are always public. An admin-path page that needs a session cannot be
     * prerendered.
     */
    routes?: {
        path: string;
        entrypoint: string;
        prerender?: boolean;
        public?: boolean;
    }[];
    adminUi?: {
        path: string;
        label: string;
        componentPath: string;
        section?: AdminSection;
    }[];
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
    migrations?: {
        dir: string;
    };
    /**
     * A job the Worker's scheduled handler runs on every cron tick. `moduleId` names a server module and
     * `exportName` the export that holds the job, a `ScheduledJob` from `talisman-cms/worker`;
     * `exportName` defaults to `scheduled`. It is a module reference rather than a function for the same
     * reason as `runtimeHooks`: the plugin object lives in `astro.config` and does not survive the server
     * build. The site exports `scheduled` from `talisman-cms/worker` in its Worker entry and sets a cron
     * trigger in its wrangler config.
     */
    scheduled?: {
        moduleId: string;
        exportName?: string;
    };
}
interface FieldValidationIssue {
    path: PropertyKey[];
    message: string;
    code?: string;
    received?: unknown;
}
/** A column to expose as a field: its property name, or an override whose own keys win over what the column says. */
type NativeFieldPick = string | (Partial<Omit<FieldDefinition, 'name'>> & {
    name: string;
});
/**
 * Field definitions for a collection mapped to a Drizzle table, read from its columns, so the
 * schema says what each field is and the collection says only what the column cannot: the label
 * where the property name is not one, the widget (a relation, a media array), `saveOnlyIfChanged`.
 * `picks` names the columns to expose, in order, each as a property name or as an override whose
 * own keys win; a pick that names no column throws at config time, so a renamed column is found
 * before the admin loads. Without `picks`, every column is a field, as the service does for a
 * native collection configured without fields.
 */
declare function nativeFields(table: any, picks?: NativeFieldPick[]): FieldDefinition[];

export { type AdminEditorPanelDefinition as A, type BlockDefinition as B, type CollectionConfig as C, type FieldDefinition as F, type GlobalConfig as G, type NativeFieldPick as N, type Plugin as P, type RelationReference as R, type TalismanCmsOptions as T, type UiComponentPresetDefinition as U, type AdminEntryDescriberDefinition as a, type AdminSection as b, type AdminSectionDefinition as c, type CollectionHookArgs as d, type CollectionHooks as e, type ComponentDefinition as f, type ComponentSlotDefinition as g, type FieldType as h, type PluginConfig as i, type RuntimeCollectionHooks as j, type UiLibraryBlockAdapter as k, type UiLibraryComponentAdapter as l, type UiLibraryDefinition as m, type UiLibraryRequirement as n, type AdvancedAdapterDefinition as o, type FieldValidationIssue as p, nativeFields as q };
