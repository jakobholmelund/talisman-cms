import type { TalismanEnv } from 'talisman-cms/client';

/** The ids an order item stores. */
export type OrderItemReference = { productId: string; variantId?: string | null };
/** What the catalog says about an order item now; null where the record no longer exists. */
export type OrderItemDescription = { productName: string | null; variantLabel: string | null; sku: string | null };

/** Ids per IN list, below D1's limit of 100 bound parameters per statement. */
const IN_CHUNK = 90;

export function chunked<T>(values: T[], size = IN_CHUNK) {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += size) chunks.push(values.slice(start, start + size));
  return chunks;
}

export const placeholders = (values: unknown[]) => values.map(() => '?').join(', ');

type ProductRow = { id: string; name: string; sku: string | null };
type ValueRow = { id: string; value: string; sku: string | null; group_name: string; group_sku: string | null; definition_name: string | null };
type GroupRow = { id: string; name: string; sku: string | null };

/**
 * Product names, variant labels and SKUs for order items, read from the catalog when called, because
 * an order item stores only ids. A variant value is labelled like the checkout line, with its variant
 * definition (or group) name and the value; a variant group without values by its own name. The SKU
 * is the value's, else the variant group's, else the product's. Items come back in the given order.
 */
export async function describeOrderItems<T extends OrderItemReference>(env: TalismanEnv, items: T[]): Promise<Array<T & OrderItemDescription>> {
  const productIds = [...new Set(items.map((item) => item.productId))];
  const variantIds = [...new Set(items.flatMap((item) => item.variantId ? [item.variantId] : []))];
  const productChunks = chunked(productIds);
  const variantChunks = chunked(variantIds);
  const statements = [
    ...productChunks.map((ids) => env.DB.prepare(`SELECT id, name, sku FROM _ecommerce_products
      WHERE id IN (${placeholders(ids)})`).bind(...ids)),
    ...variantChunks.map((ids) => env.DB.prepare(`SELECT v.id, v.value, v.sku, g.name AS group_name,
        g.sku AS group_sku, d.name AS definition_name
      FROM _ecommerce_product_variant_values v
      JOIN _ecommerce_product_variants g ON g.id = v.product_variant_id
      LEFT JOIN _ecommerce_variants d ON d.id = g.variant_id
      WHERE v.id IN (${placeholders(ids)})`).bind(...ids)),
    // A variant group without values is sold as itself.
    ...variantChunks.map((ids) => env.DB.prepare(`SELECT id, name, sku FROM _ecommerce_product_variants
      WHERE id IN (${placeholders(ids)})`).bind(...ids)),
  ];
  const results = statements.length ? await env.DB.batch(statements) : [];
  const rowsOf = <R>(from: number, count: number) => results.slice(from, from + count).flatMap((result) => (result.results ?? []) as R[]);
  const products = new Map(rowsOf<ProductRow>(0, productChunks.length).map((row) => [row.id, row]));
  const values = new Map(rowsOf<ValueRow>(productChunks.length, variantChunks.length).map((row) => [row.id, row]));
  const groups = new Map(rowsOf<GroupRow>(productChunks.length + variantChunks.length, variantChunks.length)
    .map((row) => [row.id, row]));

  return items.map((item) => {
    const product = products.get(item.productId);
    // Checkout reads a variant id as a value first, as a variant group second.
    const value = item.variantId ? values.get(item.variantId) : undefined;
    const group = item.variantId && !value ? groups.get(item.variantId) : undefined;
    return {
      ...item,
      productName: product?.name ?? null,
      variantLabel: value ? `${value.definition_name ?? value.group_name}: ${value.value}` : group?.name ?? null,
      sku: (value ? value.sku || value.group_sku : group?.sku) || product?.sku || null,
    };
  });
}
