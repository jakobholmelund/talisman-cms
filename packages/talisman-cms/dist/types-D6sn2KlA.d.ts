import { A as Actor } from './actor-BAnSg_qp.js';

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
interface Plugin {
    name: string;
    onInit: (config: any) => any;
    /** Task-oriented links shown in the matching admin workspace. */
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
     * Pages under the admin path need a CMS session unless `public` is true; pages elsewhere are
     * always public. An admin-path page that needs a session cannot be prerendered.
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
     * D1 migrations the plugin ships: an absolute path to a folder of `NNNN_name.sql` files, with a
     * `meta/_journal.json` like the core's. The integration copies them, with the core's, into the one
     * folder a site's `migrations_dir` points at; the numbers form one sequence across the core and every
     * plugin, and a file name never changes once a database has applied it.
     */
    migrations?: {
        dir: string;
    };
}
interface FieldValidationIssue {
    path: PropertyKey[];
    message: string;
    code?: string;
    received?: unknown;
}

export type { AdminEditorPanelDefinition as A, BlockDefinition as B, CollectionConfig as C, FieldDefinition as F, GlobalConfig as G, Plugin as P, RelationReference as R, UiComponentPresetDefinition as U, AdminEntryDescriberDefinition as a, AdminSection as b, AdminSectionDefinition as c, CollectionHookArgs as d, CollectionHooks as e, ComponentDefinition as f, ComponentSlotDefinition as g, FieldType as h, RuntimeCollectionHooks as i, UiLibraryBlockAdapter as j, UiLibraryComponentAdapter as k, UiLibraryDefinition as l, UiLibraryRequirement as m, AdvancedAdapterDefinition as n, FieldValidationIssue as o };
