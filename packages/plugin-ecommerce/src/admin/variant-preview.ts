type DraftValue = { localId: string; id: string | null; value: string; sku: string; image: string; priceOverride: string; stockId: string | null; stockQuantity: string };
type DraftGroup = { localId: string; id: string | null; variantId: string; name: string; sku: string; priceOverride: string; inventoryQuantity: string; values: DraftValue[] };
type Row = { id: string; data?: Record<string, any> | string | null };
const data = (row?: Row) => typeof row?.data === 'string' ? JSON.parse(row.data) : row?.data ?? {};
const amount = (value: string, fallback: number) => value.trim() && Number.isFinite(Number(value)) ? Number(value) : fallback;

/** Preview unsaved choices using checkout's price inheritance and physical stock precedence. */
export function buildVariantPreview(product: Record<string, any>, drafts: DraftGroup[], rows: Record<string, Row[]>) {
  const tracksStock = !product.type || product.type === 'standard';
  const groups = drafts.map(group => {
    const definition = rows._ecommerce_variants?.find(row => row.id === group.variantId);
    const groupPrice = amount(group.priceOverride, Number(product.basePrice) || 0);
    const groupQuantity = amount(group.inventoryQuantity, 0);
    const values = group.values.length ? group.values.map(value => {
      const recipe = (rows._ecommerce_variant_components ?? []).map(data).filter(part => part.productVariantValueId === value.id);
      const quantity = recipe.length ? Math.min(...recipe.map(part => {
        const component = rows._ecommerce_components?.find(row => row.id === part.componentId);
        return component && part.quantity > 0 ? Math.floor(Number(data(component).quantity) / part.quantity) : 0;
      })) : value.stockId || !value.id ? amount(value.stockQuantity, 0) : groupQuantity;
      return { id: value.localId, label: value.value || 'Untitled value', sku: value.sku, imageUrl: value.image || null,
        priceCents: amount(value.priceOverride, groupPrice), quantity: tracksStock ? Math.max(0, quantity) : null,
        stockSource: recipe.length ? 'Shared components' : value.stockId || !value.id ? 'Choice stock' : 'Group stock' };
    }) : [{ id: group.localId, label: group.name || 'Untitled group', sku: group.sku, imageUrl: null,
      priceCents: groupPrice, quantity: tracksStock ? Math.max(0, groupQuantity) : null, stockSource: 'Group stock' }];
    return { id: group.localId, label: data(definition).name || group.name || 'Options', values };
  });
  const choices = groups.length ? groups.flatMap(group => group.values) : [{ id: 'product', label: product.name || 'Product', sku: product.sku || '', imageUrl: null,
    priceCents: Number(product.basePrice) || 0, quantity: tracksStock ? Math.max(0, Number(product.inventoryQuantity) || 0) : null, stockSource: 'Product stock' }];
  const available = (choice: typeof choices[number]) => choice.priceCents > 0 && (choice.quantity === null || choice.quantity > 0);
  return { groups, choices, selected: choices.find(available) ?? choices[0], available };
}
