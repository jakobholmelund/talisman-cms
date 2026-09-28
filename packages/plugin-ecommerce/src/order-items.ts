import type { TalismanEnv } from 'talisman-cms/client';
import { batchGroups, chunked, commerceDb } from './db';

/** The ids an order item stores. */
export type OrderItemReference = { productId: string; variantId?: string | null };
/** What the catalog says about an order item now; null where the record no longer exists. */
export type OrderItemDescription = { productName: string | null; variantLabel: string | null; sku: string | null };

/**
 * The order columns `orderAmounts` reads. Every query that feeds it selects this list, so an amount
 * added here reaches the admin orders queue and the order confirmation alike.
 */
export const ORDER_AMOUNT_COLUMNS = `subtotal_amount, discount_code, discount_amount, credit_applied, shipping_amount,
  shipping_label, tax_amount, tax_behavior, gift_card_applied, total_amount, provider_refunded_cents, gift_card_refunded_cents`;

/** The order columns `orderAmounts` reads, as D1 returns them. */
export type OrderAmountsRow = {
  subtotal_amount: number; total_amount: number; discount_code: string | null; discount_amount: number;
  credit_applied: number; shipping_amount: number; shipping_label: string | null; tax_amount: number;
  tax_behavior: 'inclusive' | 'exclusive' | null; gift_card_applied: number; provider_refunded_cents: number;
  gift_card_refunded_cents: number;
};
export type OrderAmount = { key: string; label: string; cents: number };

/**
 * Each amount of an order with its label, in the order they are read: the admin orders queue and the
 * order confirmation email show this one list. Deductions are negative.
 */
export function orderAmounts(row: OrderAmountsRow): OrderAmount[] {
  // An order without a stored subtotal had no deductions, so its charged total is its items subtotal.
  const amounts = [{ key: 'itemsSubtotal', label: 'Items subtotal', cents: row.subtotal_amount || row.total_amount }];
  if (row.discount_amount > 0) {
    amounts.push({ key: 'discount', label: row.discount_code ? `Discount (${row.discount_code})` : 'Discount', cents: -row.discount_amount });
  }
  if (row.credit_applied > 0) amounts.push({ key: 'storeCredit', label: 'Store credit', cents: -row.credit_applied });
  // A free rate still shows, so the admin and the buyer see which one was chosen.
  if (row.shipping_amount > 0 || row.shipping_label) {
    amounts.push({ key: 'shipping', label: row.shipping_label ? `Shipping (${row.shipping_label})` : 'Shipping', cents: row.shipping_amount });
  }
  // Inclusive tax is already inside the prices above, so it is shown but adds nothing.
  if (row.tax_amount > 0) {
    amounts.push(row.tax_behavior === 'inclusive'
      ? { key: 'taxIncluded', label: 'Tax included in the prices', cents: row.tax_amount }
      : { key: 'tax', label: 'Tax', cents: row.tax_amount });
  }
  if (row.gift_card_applied > 0) amounts.push({ key: 'giftCard', label: 'Gift card', cents: -row.gift_card_applied });
  amounts.push({ key: 'charged', label: 'Charged by the payment provider', cents: row.total_amount });
  if (row.provider_refunded_cents > 0) {
    amounts.push({ key: 'providerRefunded', label: 'Refunded by the payment provider', cents: row.provider_refunded_cents });
  }
  if (row.gift_card_refunded_cents > 0) {
    amounts.push({ key: 'giftCardRefunded', label: 'Refunded to the gift card', cents: row.gift_card_refunded_cents });
  }
  return amounts;
}

/**
 * Product names, variant labels and SKUs for order items, read from the catalog when called, because
 * an order item stores only ids. A variant value is labelled like the checkout line, with its variant
 * definition (or group) name and the value; a variant group without values by its own name. The SKU
 * is the value's, else the variant group's, else the product's. Items come back in the given order.
 */
export async function describeOrderItems<T extends OrderItemReference>(env: TalismanEnv, items: T[]): Promise<Array<T & OrderItemDescription>> {
  const db = commerceDb(env);
  const productIds = [...new Set(items.map((item) => item.productId))];
  const variantIds = [...new Set(items.flatMap((item) => item.variantId ? [item.variantId] : []))];
  const rows = await batchGroups(db, {
    products: chunked(productIds).map((ids) => db.query.products.findMany({
      columns: { id: true, name: true, sku: true }, where: { id: { in: ids } },
    })),
    values: chunked(variantIds).map((ids) => db.query.productVariantValues.findMany({
      columns: { id: true, value: true, sku: true }, where: { id: { in: ids } },
      with: { productVariant: { columns: { name: true, sku: true }, with: { variant: { columns: { name: true } } } } },
    })),
    // A variant group without values is sold as itself.
    groups: chunked(variantIds).map((ids) => db.query.productVariants.findMany({
      columns: { id: true, name: true, sku: true }, where: { id: { in: ids } },
    })),
  });
  const products = new Map(rows.products.map((row) => [row.id, row]));
  const values = new Map(rows.values.map((row) => [row.id, row]));
  const groups = new Map(rows.groups.map((row) => [row.id, row]));

  return items.map((item) => {
    const product = products.get(item.productId);
    // Checkout reads a variant id as a value first, as a variant group second.
    const value = item.variantId ? values.get(item.variantId) : undefined;
    const group = item.variantId && !value ? groups.get(item.variantId) : undefined;
    return {
      ...item,
      productName: product?.name ?? null,
      variantLabel: value ? `${value.productVariant.variant?.name ?? value.productVariant.name}: ${value.value}` : group?.name ?? null,
      sku: (value ? value.sku || value.productVariant.sku : group?.sku) || product?.sku || null,
    };
  });
}
