// The commerce record describer (Plugin.adminEntryDescribers): how the admin names products, options,
// values, stock and components in relation pickers and summaries, which related tables the editor
// loads for them, and the model guide the editor panel shows. Prices show in the store currency.
import type { EntriesBySlug, EntryDescriberContext, EntryDescription, EntryLike } from 'talisman-cms/ui/lib/entry-labels';
import { productsCollectionSlug } from 'virtual:talisman-cms/ecommerce-admin';
import { normalizeCurrency, storeCurrency } from './currency';

/** The plugin's own tables in the product flow. The products collection comes first, under the slug the site configured. */
export const COMMERCE_FLOW_NATIVE_SLUGS = [
  '_ecommerce_variants',
  '_ecommerce_product_variants',
  '_ecommerce_product_variant_values',
  '_ecommerce_stocks',
  '_ecommerce_components',
  '_ecommerce_variant_components',
] as const;

/** The collections of the product flow, loaded together so each record can name the others. */
export function commerceFlowSlugs(): string[] {
  return [productsCollectionSlug, ...COMMERCE_FLOW_NATIVE_SLUGS];
}

export type CommerceEntry = EntryLike;
export type CommerceSupportEntries = EntriesBySlug;

export function isCommerceFlowSlug(slug: string) {
  return commerceFlowSlugs().includes(slug);
}

/** Describer export: the extra collections the editor of a product-flow record loads. */
export function supportCollections(collectionSlug: string, _relationTargets: string[] = []) {
  return isCommerceFlowSlug(collectionSlug) ? commerceFlowSlugs() : [];
}

export function getEntryData(entry: CommerceEntry | null | undefined): Record<string, any> {
  if (!entry?.data) return {};
  return typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data;
}

function findEntry(entriesBySlug: CommerceSupportEntries, slug: string, id: string | undefined) {
  if (!id) return null;
  return (entriesBySlug[slug] || []).find((entry) => entry.id === id) || null;
}

/**
 * An amount in the currency's minor units as text, such as 1250 as $12.50 in USD or ¥1,250 in JPY,
 * for the browser's locale. Null without an amount or a currency.
 */
export function formatMoney(amount: number | null | undefined, currency: string | undefined) {
  if (typeof amount !== 'number' || Number.isNaN(amount) || !currency) return null;
  const format = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() });
  return format.format(amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
}

function compact(parts: Array<string | null | undefined>) {
  return parts.filter((part): part is string => Boolean(part && part.trim()));
}

function getProductName(entry: CommerceEntry | null | undefined) {
  const data = getEntryData(entry);
  return data.name || entry?.slug || entry?.id || 'Unknown product';
}

function getVariantDefinitionName(entry: CommerceEntry | null | undefined) {
  const data = getEntryData(entry);
  return data.name || entry?.id || 'Unknown option';
}

function getProductVariantContext(entry: CommerceEntry | null | undefined, entriesBySlug: CommerceSupportEntries) {
  const data = getEntryData(entry);
  const product = findEntry(entriesBySlug, productsCollectionSlug, data.productId);
  const variantDefinition = findEntry(entriesBySlug, '_ecommerce_variants', data.variantId);

  return {
    product,
    variantDefinition,
    productName: product ? getProductName(product) : data.productId,
    variantDefinitionName: variantDefinition ? getVariantDefinitionName(variantDefinition) : data.variantId,
  };
}

function getProductVariantValueContext(entry: CommerceEntry | null | undefined, entriesBySlug: CommerceSupportEntries) {
  const data = getEntryData(entry);
  const group = findEntry(entriesBySlug, '_ecommerce_product_variants', data.productVariantId);
  const groupContext = getProductVariantContext(group, entriesBySlug);

  return {
    group,
    ...groupContext,
  };
}

/**
 * Title, subtitle and details for a commerce record, or null for a record of another collection.
 * Prices show in `currency`, the store currency whose minor units they are stored in, and are left
 * out without one.
 */
export function describeCommerceEntry(
  collectionSlug: string,
  entry: CommerceEntry | null | undefined,
  entriesBySlug: CommerceSupportEntries,
  currency?: string
): EntryDescription | null {
  if (!entry) return null;
  const data = getEntryData(entry);

  if (collectionSlug === productsCollectionSlug) {
    return {
      title: data.name || entry.slug || entry.id,
      subtitle: compact([
        data.slug ? `/${data.slug}` : null,
        data.sku ? `SKU ${data.sku}` : null,
        formatMoney(data.basePrice, currency),
      ]).join(' • '),
      details: compact([
        data.type ? `Type: ${data.type}` : null,
        data.status ? `Status: ${data.status}` : null,
      ]),
    };
  }

  switch (collectionSlug) {
    case '_ecommerce_variants': {
      const title = data.name || entry.id;
      return {
        title,
        subtitle: 'Reusable option definition',
        details: [],
      };
    }
    case '_ecommerce_product_variants': {
      const context = getProductVariantContext(entry, entriesBySlug);
      const priceOverride = formatMoney(data.priceOverride, currency);
      return {
        title: data.name || compact([context.productName, context.variantDefinitionName]).join(' / ') || entry.id,
        subtitle: compact([
          context.productName ? `Product: ${context.productName}` : null,
          context.variantDefinitionName ? `Option: ${context.variantDefinitionName}` : null,
        ]).join(' • '),
        details: compact([
          data.sku ? `SKU ${data.sku}` : null,
          priceOverride ? `Group price override ${priceOverride}` : null,
          typeof data.inventoryQuantity === 'number' ? `Legacy inventory ${data.inventoryQuantity}` : null,
        ]),
      };
    }
    case '_ecommerce_product_variant_values': {
      const context = getProductVariantValueContext(entry, entriesBySlug);
      const priceOverride = formatMoney(data.priceOverride, currency);
      return {
        title: data.value || data.sku || entry.id,
        subtitle: compact([
          context.group ? `Group: ${getEntryData(context.group).name || context.group.id}` : data.productVariantId ? `Group ${data.productVariantId}` : null,
          context.productName ? `Product: ${context.productName}` : null,
          context.variantDefinitionName ? `Option: ${context.variantDefinitionName}` : null,
        ]).join(' • '),
        details: compact([
          data.sku ? `SKU ${data.sku}` : null,
          priceOverride ? `Price override ${priceOverride}` : null,
        ]),
      };
    }
    case '_ecommerce_stocks': {
      const value = findEntry(entriesBySlug, '_ecommerce_product_variant_values', data.productVariantValueId);
      const valueContext = getProductVariantValueContext(value, entriesBySlug);
      const valueData = getEntryData(value);

      return {
        title: value ? `Stock for ${valueData.value || value.id}` : `Stock ${entry.id}`,
        subtitle: compact([
          valueContext.productName ? `Product: ${valueContext.productName}` : null,
          valueContext.variantDefinitionName ? `Option: ${valueContext.variantDefinitionName}` : null,
          value ? `Value: ${valueData.value || value.id}` : data.productVariantValueId ? `Value ${data.productVariantValueId}` : null,
        ]).join(' • '),
        details: compact([
          typeof data.quantity === 'number' ? `Quantity ${data.quantity}` : null,
        ]),
      };
    }
    case '_ecommerce_components': {
      return {
        title: data.name || data.sku || entry.id,
        subtitle: compact([data.sku ? `SKU ${data.sku}` : null, typeof data.quantity === 'number' ? `Available ${data.quantity}` : null]).join(' • '),
        details: [],
      };
    }
    case '_ecommerce_variant_components': {
      const value = findEntry(entriesBySlug, '_ecommerce_product_variant_values', data.productVariantValueId);
      const component = findEntry(entriesBySlug, '_ecommerce_components', data.componentId);
      const valueData = getEntryData(value);
      const componentData = getEntryData(component);
      return {
        title: compact([valueData.value || value?.id, componentData.name || component?.id]).join(' / ') || entry.id,
        subtitle: compact([typeof data.quantity === 'number' ? `${data.quantity} per item` : null, componentData.sku ? `SKU ${componentData.sku}` : null]).join(' • '),
        details: [],
      };
    }
    default:
      return null;
  }
}

/** Describer export: the description of a commerce record in the store currency, or null for other records. */
export function describeEntry(
  collectionSlug: string,
  entry: CommerceEntry,
  entriesBySlug: CommerceSupportEntries,
  context?: EntryDescriberContext
) {
  const currency = context ? normalizeCurrency(context.readSetting('COMMERCE_CURRENCY')) : storeCurrency();
  return describeCommerceEntry(collectionSlug, entry, entriesBySlug, currency);
}

export function getRelationOptionLabel(
  relationTo: string,
  entry: CommerceEntry,
  entriesBySlug: CommerceSupportEntries,
  currency?: string
) {
  const description = describeCommerceEntry(relationTo, entry, entriesBySlug, currency);
  return description ? compact([description.title, description.subtitle]).join(' - ') : entry.id;
}

export function getCommerceModelGuide(collectionSlug: string) {
  if (collectionSlug === productsCollectionSlug) {
    return {
      title: 'Variant Flow',
      body: 'Products are the root of the catalog. Variant groups attach to a product, values attach to a group, and stock attaches to each value.',
      steps: ['Product', 'Variant group', 'Variant value', 'Stock row'],
    };
  }
  switch (collectionSlug) {
    case '_ecommerce_variants':
      return {
        title: 'Option Definition',
        body: 'This defines the option family, like Size or Color. Product variant groups point at one of these definitions.',
        steps: ['Definition', 'Group', 'Value'],
      };
    case '_ecommerce_product_variants':
      return {
        title: 'Variant Group',
        body: 'A variant group connects one product to one option family. Values like Small, Medium, or Red sit underneath this group.',
        steps: ['Product', 'Group', 'Value', 'Stock'],
      };
    case '_ecommerce_product_variant_values':
      return {
        title: 'Variant Value',
        body: 'This is the actual shopper-selectable choice, like Small or Blue. It belongs to one group and usually has a dedicated stock row.',
        steps: ['Group', 'Value', 'Stock'],
      };
    case '_ecommerce_stocks':
      return {
        title: 'Stock Row',
        body: 'Each stock row belongs to exactly one variant value. Checkout inventory is taken from this record first.',
        steps: ['Value', 'Available quantity'],
      };
    case '_ecommerce_components':
      return {
        title: 'Shared Component',
        body: 'A physical part with one stock quantity that can supply multiple products and variants.',
        steps: ['Component', 'Variant component', 'Checkout reservation'],
      };
    case '_ecommerce_variant_components':
      return {
        title: 'Variant Bill of Materials',
        body: 'Connect each purchasable variant value to every part it consumes. Its component quantities replace its dedicated stock row.',
        steps: ['Variant value', 'Component', 'Units per item'],
      };
    default:
      return null;
  }
}

const titleOf = (slug: string, entry: CommerceEntry | null, entriesBySlug: CommerceSupportEntries) =>
  entry ? describeCommerceEntry(slug, entry, entriesBySlug)?.title ?? entry.id : null;

export function getCommerceFlowSummary(
  collectionSlug: string,
  values: Record<string, any>,
  entriesBySlug: CommerceSupportEntries
) {
  if (!isCommerceFlowSlug(collectionSlug)) return [];

  const product = collectionSlug === productsCollectionSlug
    ? { id: values.id || 'new', data: values }
    : collectionSlug === '_ecommerce_product_variants'
      ? findEntry(entriesBySlug, productsCollectionSlug, values.productId)
      : collectionSlug === '_ecommerce_product_variant_values'
        ? findEntry(entriesBySlug, productsCollectionSlug, getEntryData(findEntry(entriesBySlug, '_ecommerce_product_variants', values.productVariantId)).productId)
        : collectionSlug === '_ecommerce_stocks'
          ? findEntry(entriesBySlug, productsCollectionSlug, getEntryData(findEntry(entriesBySlug, '_ecommerce_product_variants', getEntryData(findEntry(entriesBySlug, '_ecommerce_product_variant_values', values.productVariantValueId)).productVariantId)).productId)
          : null;

  const variantDefinition = collectionSlug === '_ecommerce_variants'
    ? { id: values.id || 'new', data: values }
    : collectionSlug === '_ecommerce_product_variants'
      ? findEntry(entriesBySlug, '_ecommerce_variants', values.variantId)
      : collectionSlug === '_ecommerce_product_variant_values'
        ? findEntry(entriesBySlug, '_ecommerce_variants', getEntryData(findEntry(entriesBySlug, '_ecommerce_product_variants', values.productVariantId)).variantId)
        : collectionSlug === '_ecommerce_stocks'
          ? findEntry(entriesBySlug, '_ecommerce_variants', getEntryData(findEntry(entriesBySlug, '_ecommerce_product_variants', getEntryData(findEntry(entriesBySlug, '_ecommerce_product_variant_values', values.productVariantValueId)).productVariantId)).variantId)
          : null;

  const group = collectionSlug === '_ecommerce_product_variants'
    ? { id: values.id || 'new', data: values }
    : collectionSlug === '_ecommerce_product_variant_values'
      ? findEntry(entriesBySlug, '_ecommerce_product_variants', values.productVariantId)
      : collectionSlug === '_ecommerce_stocks'
        ? findEntry(entriesBySlug, '_ecommerce_product_variants', getEntryData(findEntry(entriesBySlug, '_ecommerce_product_variant_values', values.productVariantValueId)).productVariantId)
        : null;

  const value = collectionSlug === '_ecommerce_product_variant_values'
    ? { id: values.id || 'new', data: values }
    : collectionSlug === '_ecommerce_stocks'
      ? findEntry(entriesBySlug, '_ecommerce_product_variant_values', values.productVariantValueId)
      : null;

  return [
    product ? { label: 'Product', value: titleOf(productsCollectionSlug, product, entriesBySlug) } : null,
    variantDefinition ? { label: 'Option', value: titleOf('_ecommerce_variants', variantDefinition, entriesBySlug) } : null,
    group ? { label: 'Group', value: titleOf('_ecommerce_product_variants', group, entriesBySlug) } : null,
    value ? { label: 'Value', value: titleOf('_ecommerce_product_variant_values', value, entriesBySlug) } : null,
    collectionSlug === '_ecommerce_stocks' && typeof values.quantity === 'number'
      ? { label: 'Quantity', value: `${values.quantity}` }
      : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item?.value));
}
