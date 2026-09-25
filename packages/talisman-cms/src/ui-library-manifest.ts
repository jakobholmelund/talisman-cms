import type {
  AdvancedAdapterDefinition,
  BlockDefinition,
  ComponentDefinition,
  ComponentSlotDefinition,
  FieldDefinition,
  Plugin,
  UiComponentPresetDefinition,
  UiLibraryBlockAdapter,
  UiLibraryComponentAdapter,
  UiLibraryDefinition,
  UiLibraryRequirement,
} from './types';

export type UiLibraryCatalogItemKind = 'block' | 'component';
export type UiLibraryCoverageStatus = 'complete' | 'partial' | 'unsupported';
export type UiLibraryCatalogOrigin = 'upstream' | 'custom';

export interface UiLibraryUpstreamCatalogItem {
  id: string;
  name: string;
  kind: UiLibraryCatalogItemKind;
  category: string;
  variants: string[];
}

export interface UiLibraryManifestSlotRelationship {
  name: string;
  label: string;
  description?: string;
  hasMany?: boolean;
  componentItemIds?: string[];
  componentAdapterSlugs?: string[];
  allowInline?: boolean;
  allowReferences?: boolean;
}

export interface UiLibraryManifestUsageRelationship {
  itemId: string;
  slotName: string;
}

export interface UiLibraryManifestRelationships {
  slots: UiLibraryManifestSlotRelationship[];
  usedIn: UiLibraryManifestUsageRelationship[];
}

export interface UiLibraryManifestRendererTarget {
  modulePath: string;
  localFilePath?: string;
  exportName?: string;
}

export interface UiLibraryManifestBlockAdapterShape {
  kind: 'block';
  slug: string;
  name: string;
  description?: string;
  category?: string;
  fields: FieldDefinition[];
  tags?: string[];
}

export interface UiLibraryManifestComponentAdapterShape {
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

export type UiLibraryManifestAdapterShape =
  | UiLibraryManifestBlockAdapterShape
  | UiLibraryManifestComponentAdapterShape;

export interface UiLibraryManifestItem {
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

export interface UiLibraryManifestGenerationMetadata {
  generatedFilePath: string;
  importSourcePath?: string;
  rendererStubTemplate?: 'astro-component';
}

export interface UiLibraryManifest {
  pluginName: string;
  library: {
    id: string;
    name: string;
    requirements: Array<UiLibraryRequirement & { id: string }>;
  };
  generation: UiLibraryManifestGenerationMetadata;
  upstreamCatalog: UiLibraryUpstreamCatalogItem[];
  items: UiLibraryManifestItem[];
}

export interface UiLibraryCoverageReport {
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

export function buildUiLibraryPresets(components: UiLibraryComponentAdapter[] | undefined) {
  return (components || []).flatMap((component) => component.presets || []);
}

export function buildUiLibraryDefinition(
  library: Pick<UiLibraryDefinition, 'id' | 'name' | 'requirements'>,
  blocks: UiLibraryBlockAdapter[],
  components: UiLibraryComponentAdapter[],
) {
  return {
    ...library,
    blocks,
    components,
    presets: buildUiLibraryPresets(components),
  } satisfies UiLibraryDefinition;
}

export function buildUiLibraryPlugin(
  pluginName: string,
  library: UiLibraryDefinition,
) {
  return {
    name: pluginName,
    onInit: (config: any) => config,
    uiLibraries: [library],
  } satisfies Plugin;
}

export function buildUiLibrarySourceReference(
  pluginName: string,
  libraryId: string,
  upstreamItemId: string,
) {
  return {
    plugin: pluginName,
    library: libraryId,
    item: upstreamItemId,
  };
}

export function buildUiLibraryBlockDefinition(
  pluginName: string,
  libraryId: string,
  item: UiLibraryManifestItem,
  adapter: UiLibraryManifestBlockAdapterShape,
  componentSlots: ComponentSlotDefinition[],
) {
  return {
    slug: adapter.slug,
    name: adapter.name,
    description: adapter.description,
    category: adapter.category || item.category,
    fields: adapter.fields,
    componentSlots,
    source: buildUiLibrarySourceReference(pluginName, libraryId, item.upstreamItemId),
    tags: adapter.tags,
  } satisfies BlockDefinition;
}

export function buildUiLibraryComponentDefinition(
  pluginName: string,
  libraryId: string,
  item: UiLibraryManifestItem,
  adapter: UiLibraryManifestComponentAdapterShape,
) {
  return {
    slug: adapter.slug,
    name: adapter.name,
    description: adapter.description,
    category: adapter.category || item.category,
    fields: adapter.fields,
    advanced: adapter.advanced,
    source: buildUiLibrarySourceReference(pluginName, libraryId, item.upstreamItemId),
  } satisfies ComponentDefinition;
}
