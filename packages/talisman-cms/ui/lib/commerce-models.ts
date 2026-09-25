const COMMERCE_FLOW_SLUGS = [
  'products',
  '_ecommerce_variants',
  '_ecommerce_product_variants',
  '_ecommerce_product_variant_values',
  '_ecommerce_stocks',
  '_ecommerce_components',
  '_ecommerce_variant_components',
] as const;

export type CommerceEntry = {
  id: string;
  slug?: string;
  data?: Record<string, any> | string | null;
};

export type CommerceSupportEntries = Record<string, CommerceEntry[]>;

export function isCommerceFlowSlug(slug: string) {
  return COMMERCE_FLOW_SLUGS.includes(slug as (typeof COMMERCE_FLOW_SLUGS)[number]);
}

export function getCommerceSupportSlugs(collectionSlug: string, relationTargets: string[] = []) {
  const slugs = new Set<string>(relationTargets);

  if (isCommerceFlowSlug(collectionSlug)) {
    for (const slug of COMMERCE_FLOW_SLUGS) {
      slugs.add(slug);
    }
  }

  return Array.from(slugs);
}

export function getEntryData(entry: CommerceEntry | null | undefined) {
  if (!entry?.data) return {};
  return typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data;
}

function findEntry(entriesBySlug: CommerceSupportEntries, slug: string, id: string | undefined) {
  if (!id) return null;
  return (entriesBySlug[slug] || []).find((entry) => entry.id === id) || null;
}

function formatMoney(cents: number | null | undefined) {
  if (typeof cents !== 'number' || Number.isNaN(cents)) return null;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
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
  const product = findEntry(entriesBySlug, 'products', data.productId);
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

export function describeCommerceEntry(
  collectionSlug: string,
  entry: CommerceEntry | null | undefined,
  entriesBySlug: CommerceSupportEntries
) {
  if (!entry) {
    return {
      title: 'Unknown record',
      subtitle: '',
      details: [] as string[],
    };
  }

  const data = getEntryData(entry);

  switch (collectionSlug) {
    case 'products': {
      const title = data.name || entry.slug || entry.id;
      return {
        title,
        subtitle: compact([
          data.slug ? `/${data.slug}` : null,
          data.sku ? `SKU ${data.sku}` : null,
          typeof data.basePrice === 'number' ? formatMoney(data.basePrice) : null,
        ]).join(' • '),
        details: compact([
          data.type ? `Type: ${data.type}` : null,
          data.status ? `Status: ${data.status}` : null,
        ]),
      };
    }
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
      return {
        title: data.name || compact([context.productName, context.variantDefinitionName]).join(' / ') || entry.id,
        subtitle: compact([
          context.productName ? `Product: ${context.productName}` : null,
          context.variantDefinitionName ? `Option: ${context.variantDefinitionName}` : null,
        ]).join(' • '),
        details: compact([
          data.sku ? `SKU ${data.sku}` : null,
          typeof data.priceOverride === 'number' ? `Group price override ${formatMoney(data.priceOverride)}` : null,
          typeof data.inventoryQuantity === 'number' ? `Legacy inventory ${data.inventoryQuantity}` : null,
        ]),
      };
    }
    case '_ecommerce_product_variant_values': {
      const context = getProductVariantValueContext(entry, entriesBySlug);
      return {
        title: data.value || data.sku || entry.id,
        subtitle: compact([
          context.group ? `Group: ${getEntryData(context.group).name || context.group.id}` : data.productVariantId ? `Group ${data.productVariantId}` : null,
          context.productName ? `Product: ${context.productName}` : null,
          context.variantDefinitionName ? `Option: ${context.variantDefinitionName}` : null,
        ]).join(' • '),
        details: compact([
          data.sku ? `SKU ${data.sku}` : null,
          typeof data.priceOverride === 'number' ? `Price override ${formatMoney(data.priceOverride)}` : null,
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
    default: {
      const title = data.name || data.title || data.slug || entry.id;
      return {
        title,
        subtitle: compact([data.slug ? `/${data.slug}` : null]).join(' • '),
        details: [],
      };
    }
  }
}

export function getRelationOptionLabel(
  relationTo: string,
  entry: CommerceEntry,
  entriesBySlug: CommerceSupportEntries
) {
  const description = describeCommerceEntry(relationTo, entry, entriesBySlug);
  return compact([description.title, description.subtitle]).join(' - ');
}

export function getCommerceModelGuide(collectionSlug: string) {
  switch (collectionSlug) {
    case 'products':
      return {
        title: 'Variant Flow',
        body: 'Products are the root of the catalog. Variant groups attach to a product, values attach to a group, and stock attaches to each value.',
        steps: ['Product', 'Variant group', 'Variant value', 'Stock row'],
      };
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

export function getCommerceFlowSummary(
  collectionSlug: string,
  values: Record<string, any>,
  entriesBySlug: CommerceSupportEntries
) {
  if (!isCommerceFlowSlug(collectionSlug)) return [];

  const product = collectionSlug === 'products'
    ? { id: values.id || 'new', data: values }
    : collectionSlug === '_ecommerce_product_variants'
      ? findEntry(entriesBySlug, 'products', values.productId)
      : collectionSlug === '_ecommerce_product_variant_values'
        ? findEntry(entriesBySlug, 'products', getEntryData(findEntry(entriesBySlug, '_ecommerce_product_variants', values.productVariantId)).productId)
        : collectionSlug === '_ecommerce_stocks'
          ? findEntry(entriesBySlug, 'products', getEntryData(findEntry(entriesBySlug, '_ecommerce_product_variants', getEntryData(findEntry(entriesBySlug, '_ecommerce_product_variant_values', values.productVariantValueId)).productVariantId)).productId)
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
    product ? { label: 'Product', value: describeCommerceEntry('products', product, entriesBySlug).title } : null,
    variantDefinition ? { label: 'Option', value: describeCommerceEntry('_ecommerce_variants', variantDefinition, entriesBySlug).title } : null,
    group ? { label: 'Group', value: describeCommerceEntry('_ecommerce_product_variants', group, entriesBySlug).title } : null,
    value ? { label: 'Value', value: describeCommerceEntry('_ecommerce_product_variant_values', value, entriesBySlug).title } : null,
    collectionSlug === '_ecommerce_stocks' && typeof values.quantity === 'number'
      ? { label: 'Quantity', value: `${values.quantity}` }
      : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item?.value));
}
