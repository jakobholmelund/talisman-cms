type FieldType = 'text' | 'number' | 'boolean' | 'date' | 'textarea' | 'richtext' | 'relationship' | 'array' | 'blocks' | 'select' | 'relation' | 'group' | 'color' | 'media';
type AdminSection = 'collections' | 'commerce';
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
}
interface CollectionHookArgs<T = any> {
    data: Partial<T>;
    req: Request;
    operation: 'create' | 'update' | 'delete';
    originalDoc?: T;
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
    routes?: {
        path: string;
        entrypoint: string;
        prerender?: boolean;
    }[];
    adminUi?: {
        path: string;
        label: string;
        componentPath: string;
        section?: AdminSection;
    }[];
    blocks?: BlockDefinition[];
    components?: ComponentDefinition[];
    uiLibraries?: UiLibraryDefinition[];
    vite?: any;
}

export type { AdvancedAdapterDefinition as A, BlockDefinition as B, CollectionConfig as C, FieldDefinition as F, GlobalConfig as G, Plugin as P, RelationReference as R, UiComponentPresetDefinition as U, CollectionHookArgs as a, CollectionHooks as b, ComponentDefinition as c, ComponentSlotDefinition as d, FieldType as e, RuntimeCollectionHooks as f, UiLibraryBlockAdapter as g, UiLibraryComponentAdapter as h, UiLibraryDefinition as i, UiLibraryRequirement as j };
