import type { TalismanEnv } from 'talisman-cms/client';
import { batchGroups, chunked, commerceDb } from './db';
import { orders } from './schema';

/** The ids an order item stores. */
export type OrderItemReference = { productId: string; variantId?: string | null };
/** What the catalog says about an order item now; null where the record no longer exists. */
export type OrderItemDescription = { productName: string | null; variantLabel: string | null; sku: string | null };

/**
 * The order columns `orderAmounts` reads, as fields of a select. Every query that feeds it spreads
 * them into its fields, so an amount added here reaches the admin orders queue and the order
 * confirmation alike.
 */
export const orderAmountColumns = {
  subtotalAmount: orders.subtotalAmount, discountCode: orders.discountCode, discountAmount: orders.discountAmount,
  creditApplied: orders.creditApplied, shippingAmount: orders.shippingAmount, shippingLabel: orders.shippingLabel,
  taxAmount: orders.taxAmount, taxBehavior: orders.taxBehavior, giftCardApplied: orders.giftCardApplied,
  totalAmount: orders.totalAmount, providerRefundedCents: orders.providerRefundedCents,
  giftCardRefundedCents: orders.giftCardRefundedCents,
};

/** The order columns `orderAmounts` reads, as a select returns them. */
export type OrderAmountsRow = Pick<typeof orders.$inferSelect, keyof typeof orderAmountColumns>;
export type OrderAmount = { key: string; label: string; cents: number };

/**
 * Each amount of an order with its label, in the order they are read: the admin orders queue and the
 * order confirmation email show this one list. Deductions are negative.
 */
export function orderAmounts(row: OrderAmountsRow): OrderAmount[] {
  // An order without a stored subtotal had no deductions, so its charged total is its items subtotal.
  const amounts = [{ key: 'itemsSubtotal', label: 'Items subtotal', cents: row.subtotalAmount || row.totalAmount }];
  if (row.discountAmount > 0) {
    amounts.push({ key: 'discount', label: row.discountCode ? `Discount (${row.discountCode})` : 'Discount', cents: -row.discountAmount });
  }
  if (row.creditApplied > 0) amounts.push({ key: 'storeCredit', label: 'Store credit', cents: -row.creditApplied });
  // A free rate still shows, so the admin and the buyer see which one was chosen.
  if (row.shippingAmount > 0 || row.shippingLabel) {
    amounts.push({ key: 'shipping', label: row.shippingLabel ? `Shipping (${row.shippingLabel})` : 'Shipping', cents: row.shippingAmount });
  }
  // Inclusive tax is already inside the prices above, so it is shown but adds nothing.
  if (row.taxAmount > 0) {
    amounts.push(row.taxBehavior === 'inclusive'
      ? { key: 'taxIncluded', label: 'Tax included in the prices', cents: row.taxAmount }
      : { key: 'tax', label: 'Tax', cents: row.taxAmount });
  }
  if (row.giftCardApplied > 0) amounts.push({ key: 'giftCard', label: 'Gift card', cents: -row.giftCardApplied });
  amounts.push({ key: 'charged', label: 'Charged by the payment provider', cents: row.totalAmount });
  if (row.providerRefundedCents > 0) {
    amounts.push({ key: 'providerRefunded', label: 'Refunded by the payment provider', cents: row.providerRefundedCents });
  }
  if (row.giftCardRefundedCents > 0) {
    amounts.push({ key: 'giftCardRefunded', label: 'Refunded to the gift card', cents: row.giftCardRefundedCents });
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
