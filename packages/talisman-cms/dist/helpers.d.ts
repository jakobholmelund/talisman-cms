import { R as RelationReference, B as BlockDefinition } from './types-DZZq-VQM.js';

interface CollectionRepeaterBlockOptions {
    slug: string;
    name: string;
    relationTo: string | string[];
    category?: string;
    description?: string;
    itemLabel?: string;
    layouts?: string[];
    defaultLayout?: string;
    ctaLabelDefault?: string;
    ctaHrefDefault?: string;
    emptyMessageDefault?: string;
}
interface LayoutBlockOptions {
    slug?: string;
    name?: string;
    category?: string;
    description?: string;
    componentsFromPlugins?: boolean | string[];
    componentsFromLibraries?: string[];
    allowInline?: boolean;
    allowReferences?: boolean;
}
interface CollectionRepeaterItem {
    id: string;
    slug?: string;
    collectionId?: string;
    status?: string;
    data?: Record<string, any> | string | null;
}
interface CollectionRepeaterBlockValue<TItem = CollectionRepeaterItem> {
    eyebrow?: string;
    title?: string;
    description?: string;
    items?: Array<TItem | RelationReference | string>;
    layout?: string;
    emptyMessage?: string;
    ctaLabel?: string;
    ctaHref?: string;
    _settings?: Record<string, any>;
}
declare function edit(collectionSlug: string, entryId: string, fieldPath?: string): {
    'data-talisman-path'?: string | undefined;
    'data-talisman-collection': string;
    'data-talisman-entry': string;
};
/** Responsive variants are generated when the Worker has an IMAGES binding. */
declare function getMediaImageSrcSet(src: string, widths?: readonly number[]): string | undefined;
declare function createCollectionRepeaterBlock(options: CollectionRepeaterBlockOptions): BlockDefinition;
declare function createSectionLayoutBlock(options?: LayoutBlockOptions): BlockDefinition;
declare function createTwoColumnLayoutBlock(options?: LayoutBlockOptions): BlockDefinition;
declare function createThreeColumnLayoutBlock(options?: LayoutBlockOptions): BlockDefinition;
declare function getCollectionRepeaterItems<TItem extends CollectionRepeaterItem = CollectionRepeaterItem>(block: CollectionRepeaterBlockValue<TItem> | null | undefined): TItem[];
declare function getCollectionRepeaterViewModel<TItem extends CollectionRepeaterItem = CollectionRepeaterItem>(block: CollectionRepeaterBlockValue<TItem> | null | undefined): {
    eyebrow: string;
    title: string;
    description: string;
    layout: string;
    items: TItem[];
    emptyMessage: string;
    cta: {
        label: string;
        href: string;
    } | null;
    settings: Record<string, any>;
};

export { type CollectionRepeaterBlockOptions, type CollectionRepeaterBlockValue, type CollectionRepeaterItem, type LayoutBlockOptions, createCollectionRepeaterBlock, createSectionLayoutBlock, createThreeColumnLayoutBlock, createTwoColumnLayoutBlock, edit, getCollectionRepeaterItems, getCollectionRepeaterViewModel, getMediaImageSrcSet };
