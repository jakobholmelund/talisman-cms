import { j as UiLibraryRequirement, F as FieldDefinition, A as AdvancedAdapterDefinition, U as UiComponentPresetDefinition, d as ComponentSlotDefinition, i as UiLibraryDefinition, g as UiLibraryBlockAdapter, h as UiLibraryComponentAdapter } from './types-1wLQqVHz.js';
import './actor-BAnSg_qp.js';
import './types-B9Ys5hZL.js';
import 'astro';

type UiLibraryCatalogItemKind = 'block' | 'component';
type UiLibraryCoverageStatus = 'complete' | 'partial' | 'unsupported';
type UiLibraryCatalogOrigin = 'upstream' | 'custom';
interface UiLibraryUpstreamCatalogItem {
    id: string;
    name: string;
    kind: UiLibraryCatalogItemKind;
    category: string;
    variants: string[];
}
interface UiLibraryManifestSlotRelationship {
    name: string;
    label: string;
    description?: string;
    hasMany?: boolean;
    componentItemIds?: string[];
    componentAdapterSlugs?: string[];
    allowInline?: boolean;
    allowReferences?: boolean;
}
interface UiLibraryManifestUsageRelationship {
    itemId: string;
    slotName: string;
}
interface UiLibraryManifestRelationships {
    slots: UiLibraryManifestSlotRelationship[];
    usedIn: UiLibraryManifestUsageRelationship[];
}
interface UiLibraryManifestRendererTarget {
    modulePath: string;
    localFilePath?: string;
    exportName?: string;
}
interface UiLibraryManifestBlockAdapterShape {
    kind: 'block';
    slug: string;
    name: string;
    description?: string;
    category?: string;
    fields: FieldDefinition[];
    tags?: string[];
}
interface UiLibraryManifestComponentAdapterShape {
    kind: 'component';
    slug: string;
    name: string;
    description?: string;
    category?: string;
    fields: FieldDefinition[];
    advanced?: AdvancedAdapterDefinition;
    presets?: Array<Omit<UiComponentPresetDefinition, 'componentSlug' | 'libraryId'> & {
        componentSlug?: string;
        libraryId?: string;
    }>;
}
type UiLibraryManifestAdapterShape = UiLibraryManifestBlockAdapterShape | UiLibraryManifestComponentAdapterShape;
interface UiLibraryManifestItem {
    catalogOrigin: UiLibraryCatalogOrigin;
    upstreamItemId: string;
    upstreamItemName: string;
    kind: UiLibraryCatalogItemKind;
    category: string;
    variants: string[];
    setupRequirements: string[];
    relationships: UiLibraryManifestRelationships;
    coverageStatus: UiLibraryCoverageStatus;
    notes?: string;
    rendererTarget?: UiLibraryManifestRendererTarget | null;
    adapter?: UiLibraryManifestAdapterShape;
}
interface UiLibraryManifestGenerationMetadata {
    generatedFilePath: string;
    importSourcePath?: string;
    rendererStubTemplate?: 'astro-component';
}
interface UiLibraryManifest {
    pluginName: string;
    library: {
        id: string;
        name: string;
        requirements: Array<UiLibraryRequirement & {
            id: string;
        }>;
    };
    generation: UiLibraryManifestGenerationMetadata;
    upstreamCatalog: UiLibraryUpstreamCatalogItem[];
    items: UiLibraryManifestItem[];
}
interface UiLibraryCoverageReport {
    libraryId: string;
    totalUpstreamItems: number;
    completeCount: number;
    partialCount: number;
    unsupportedCount: number;
    customCount: number;
    missingItemIds: string[];
    unclassifiedItemIds: string[];
    manifestOnlyUpstreamItemIds: string[];
    invalidCompleteItemIds: string[];
    hasErrors: boolean;
}
declare function buildUiLibraryPresets(components: UiLibraryComponentAdapter[] | undefined): UiComponentPresetDefinition[];
declare function buildUiLibraryDefinition(library: Pick<UiLibraryDefinition, 'id' | 'name' | 'requirements'>, blocks: UiLibraryBlockAdapter[], components: UiLibraryComponentAdapter[]): {
    blocks: UiLibraryBlockAdapter[];
    components: UiLibraryComponentAdapter[];
    presets: UiComponentPresetDefinition[];
    name: string;
    id: string;
    requirements?: UiLibraryRequirement[] | undefined;
};
declare function buildUiLibraryPlugin(pluginName: string, library: UiLibraryDefinition): {
    name: string;
    onInit: (config: any) => any;
    uiLibraries: UiLibraryDefinition[];
};
declare function buildUiLibrarySourceReference(pluginName: string, libraryId: string, upstreamItemId: string): {
    plugin: string;
    library: string;
    item: string;
};
declare function buildUiLibraryBlockDefinition(pluginName: string, libraryId: string, item: UiLibraryManifestItem, adapter: UiLibraryManifestBlockAdapterShape, componentSlots: ComponentSlotDefinition[]): {
    slug: string;
    name: string;
    description: string | undefined;
    category: string;
    fields: FieldDefinition[];
    componentSlots: ComponentSlotDefinition[];
    source: {
        plugin: string;
        library: string;
        item: string;
    };
    tags: string[] | undefined;
};
declare function buildUiLibraryComponentDefinition(pluginName: string, libraryId: string, item: UiLibraryManifestItem, adapter: UiLibraryManifestComponentAdapterShape): {
    slug: string;
    name: string;
    description: string | undefined;
    category: string;
    fields: FieldDefinition[];
    advanced: AdvancedAdapterDefinition | undefined;
    source: {
        plugin: string;
        library: string;
        item: string;
    };
};

export { type UiLibraryCatalogItemKind, type UiLibraryCatalogOrigin, type UiLibraryCoverageReport, type UiLibraryCoverageStatus, type UiLibraryManifest, type UiLibraryManifestAdapterShape, type UiLibraryManifestBlockAdapterShape, type UiLibraryManifestComponentAdapterShape, type UiLibraryManifestGenerationMetadata, type UiLibraryManifestItem, type UiLibraryManifestRelationships, type UiLibraryManifestRendererTarget, type UiLibraryManifestSlotRelationship, type UiLibraryManifestUsageRelationship, type UiLibraryUpstreamCatalogItem, buildUiLibraryBlockDefinition, buildUiLibraryComponentDefinition, buildUiLibraryDefinition, buildUiLibraryPlugin, buildUiLibraryPresets, buildUiLibrarySourceReference };
