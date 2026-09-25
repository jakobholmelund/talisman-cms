import type { BlockDefinition, RelationReference } from './types';

export interface CollectionRepeaterBlockOptions {
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

export interface LayoutBlockOptions {
  slug?: string;
  name?: string;
  category?: string;
  description?: string;
  componentsFromPlugins?: boolean | string[];
  componentsFromLibraries?: string[];
  allowInline?: boolean;
  allowReferences?: boolean;
}

export interface CollectionRepeaterItem {
  id: string;
  slug?: string;
  collectionId?: string;
  status?: string;
  data?: Record<string, any> | string | null;
}

export interface CollectionRepeaterBlockValue<TItem = CollectionRepeaterItem> {
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

export function edit(collectionSlug: string, entryId: string, fieldPath?: string) {
  return {
    'data-talisman-collection': collectionSlug,
    'data-talisman-entry': entryId,
    ...(fieldPath ? { 'data-talisman-path': fieldPath } : {})
  };
}

const MEDIA_IMAGE_WIDTHS = [320, 640, 960, 1280, 1920] as const;

/** Responsive variants are generated when the Worker has an IMAGES binding. */
export function getMediaImageSrcSet(src: string, widths: readonly number[] = MEDIA_IMAGE_WIDTHS): string | undefined {
  if (!src.startsWith('/api/media/')) return undefined;
  const url = new URL(src, 'https://talisman.invalid');
  if (!/^\/api\/media\/media_[A-Za-z0-9_-]+$/.test(url.pathname)) return undefined;
  const variants = widths.filter((width) => MEDIA_IMAGE_WIDTHS.includes(width as typeof MEDIA_IMAGE_WIDTHS[number]));
  if (variants.length === 0) return undefined;
  return variants.map((width) => {
    const variant = new URL(url);
    variant.searchParams.set('w', String(width));
    return `${variant.pathname}${variant.search} ${width}w`;
  }).join(', ');
}

export function createCollectionRepeaterBlock(options: CollectionRepeaterBlockOptions): BlockDefinition {
  const layouts = options.layouts && options.layouts.length > 0 ? options.layouts : ['grid', 'list'];
  const defaultLayout = options.defaultLayout && layouts.includes(options.defaultLayout)
    ? options.defaultLayout
    : layouts[0];
  const relationTargets = Array.isArray(options.relationTo) ? options.relationTo : [options.relationTo];

  return {
    slug: options.slug,
    name: options.name,
    description: options.description || `Repeat selected entries from the ${relationTargets.join(', ')} collection${relationTargets.length > 1 ? 's' : ''}.`,
    category: options.category || 'Content',
    fields: [
      { name: 'eyebrow', label: 'Eyebrow', type: 'text' },
      { name: 'title', label: 'Section Title', type: 'text', required: true },
      { name: 'description', label: 'Description', type: 'textarea' },
      {
        name: 'items',
        label: options.itemLabel || 'Items',
        type: 'relation',
        relationTo: options.relationTo,
        hasMany: true,
        required: true
      },
      {
        name: 'layout',
        label: 'Layout',
        type: 'select',
        options: layouts,
        defaultValue: defaultLayout,
        required: true
      },
      {
        name: 'emptyMessage',
        label: 'Empty Message',
        type: 'text',
        defaultValue: options.emptyMessageDefault || 'No items selected yet.'
      },
      {
        name: 'ctaLabel',
        label: 'CTA Label',
        type: 'text',
        defaultValue: options.ctaLabelDefault
      },
      {
        name: 'ctaHref',
        label: 'CTA URL',
        type: 'text',
        defaultValue: options.ctaHrefDefault
      }
    ]
  };
}

function createLayoutSlot(
  name: string,
  label: string,
  options: LayoutBlockOptions,
) {
  return {
    name,
    label,
    hasMany: true,
    componentsFromPlugins: options.componentsFromPlugins ?? (options.componentsFromLibraries?.length ? undefined : true),
    componentsFromLibraries: options.componentsFromLibraries,
    allowInline: options.allowInline ?? true,
    allowReferences: options.allowReferences ?? true,
  };
}

function createBaseLayoutFields() {
  return [
    { name: 'eyebrow', label: 'Eyebrow', type: 'text' },
    { name: 'title', label: 'Title', type: 'text' },
    { name: 'description', label: 'Description', type: 'textarea' },
  ] satisfies BlockDefinition['fields'];
}

export function createSectionLayoutBlock(options: LayoutBlockOptions = {}): BlockDefinition {
  return {
    slug: options.slug || 'sectionLayout',
    name: options.name || 'Section Layout',
    category: options.category || 'Layout',
    description: options.description || 'Section shell with intro copy and a flexible content area.',
    fields: createBaseLayoutFields(),
    componentSlots: [
      createLayoutSlot('content', 'Content', options),
    ],
  };
}

export function createTwoColumnLayoutBlock(options: LayoutBlockOptions = {}): BlockDefinition {
  return {
    slug: options.slug || 'twoColumnLayout',
    name: options.name || 'Two Column Layout',
    category: options.category || 'Layout',
    description: options.description || 'Section with intro copy and two component columns.',
    fields: createBaseLayoutFields(),
    componentSlots: [
      createLayoutSlot('left', 'Left Column', options),
      createLayoutSlot('right', 'Right Column', options),
    ],
  };
}

export function createThreeColumnLayoutBlock(options: LayoutBlockOptions = {}): BlockDefinition {
  return {
    slug: options.slug || 'threeColumnLayout',
    name: options.name || 'Three Column Layout',
    category: options.category || 'Layout',
    description: options.description || 'Section with intro copy and three component columns.',
    fields: createBaseLayoutFields(),
    componentSlots: [
      createLayoutSlot('left', 'Left Column', options),
      createLayoutSlot('center', 'Center Column', options),
      createLayoutSlot('right', 'Right Column', options),
    ],
  };
}

export function getCollectionRepeaterItems<TItem extends CollectionRepeaterItem = CollectionRepeaterItem>(
  block: CollectionRepeaterBlockValue<TItem> | null | undefined
) {
  return (block?.items || []).filter(
    (item): item is TItem =>
      Boolean(item) &&
      typeof item === 'object' &&
      'data' in item
  );
}

export function getCollectionRepeaterViewModel<TItem extends CollectionRepeaterItem = CollectionRepeaterItem>(
  block: CollectionRepeaterBlockValue<TItem> | null | undefined
) {
  return {
    eyebrow: block?.eyebrow || '',
    title: block?.title || '',
    description: block?.description || '',
    layout: block?.layout || 'grid',
    items: getCollectionRepeaterItems(block),
    emptyMessage: block?.emptyMessage || 'No items selected yet.',
    cta: block?.ctaLabel && block?.ctaHref
      ? {
          label: block.ctaLabel,
          href: block.ctaHref,
        }
      : null,
    settings: block?._settings || {},
  };
}
