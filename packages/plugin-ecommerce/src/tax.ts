import type { TalismanEnv } from 'talisman-cms/client';
import { TaxAddressError, type PaymentProviderAdapter, type TaxCalculationParams } from './payments';
import type { TaxSettings } from './store-settings';
import { TAX_ADDRESS_REQUIRED, TAX_ADDRESS_UNUSABLE, TAX_UNAVAILABLE } from './checkout-input';

/**
 * Tax could not be calculated, so checkout stopped before the basket was locked. The routes answer
 * 503 with this message; the cause is in the Worker log.
 */
export class TaxCalculationError extends Error {
  constructor(options?: ErrorOptions) {
    super(TAX_UNAVAILABLE, options);
    this.name = 'TaxCalculationError';
  }
}

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * `amount` split over `weights` in proportion, in whole minor units: each share is rounded down, and
 * the units left over go to the largest remainders, the earlier weight first on a tie. The shares add
 * up to `amount`, and while `amount` is at most the sum of the weights, no share exceeds its weight.
 */
export function allocateProportionally(amount: number, weights: number[]) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  // BigInt keeps amount × weight exact beyond 2^53.
  const parts = weights.map((weight, index) => {
    const product = BigInt(amount) * BigInt(weight);
    return { index, share: Number(product / BigInt(total)), remainder: product % BigInt(total) };
  });
  let left = amount - parts.reduce((sum, part) => sum + part.share, 0);
  const byRemainder = [...parts].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const part of byRemainder) {
    if (left <= 0) break;
    part.share += 1;
    left -= 1;
  }
  return parts.map((part) => part.share);
}

/**
 * The product lines as tax sees them: each line's total less its share of the discount, which is
 * spread over the lines the code applies to, and then less its share of the store credit, spread
 * over what the discount left. Both are split in proportion to the lines' totals. A gift card is a
 * means of payment, not a price reduction, so it is never taken off.
 */
export function taxableLines(
  lines: Array<{ productId: string; variantId?: string; quantity: number; priceAtPurchase: number }>,
  discount: { amount: number; productIds: string[] }, creditApplied: number,
): TaxCalculationParams['lines'] {
  const totals = lines.map((line) => line.priceAtPurchase * line.quantity);
  const discounts = allocateProportionally(discount.amount, totals.map((total, index) =>
    !discount.productIds.length || discount.productIds.includes(lines[index].productId) ? total : 0));
  const afterDiscount = totals.map((total, index) => total - discounts[index]);
  const credits = allocateProportionally(creditApplied, afterDiscount);
  return lines.map((line, index) => ({
    // Unique within the order, and names the product in the provider's tax reports.
    reference: `L${index + 1}:${line.productId}${line.variantId ? `:${line.variantId}` : ''}`,
    amount: afterDiscount[index] - credits[index],
    quantity: line.quantity,
  }));
}

type CheckoutAddress = { line1?: unknown; line2?: unknown; city?: unknown; state?: unknown;
  postalCode?: unknown; country?: unknown } | null | undefined;

/**
 * The address tax is calculated for: where the order ships, or the billing address when nothing
 * ships. Refuses an order without one. Only the address fields are passed on, never the name.
 */
export function taxAddressFor(requiresShipping: boolean, shippingAddress: CheckoutAddress,
  billingAddress: CheckoutAddress) {
  const given = requiresShipping ? shippingAddress : billingAddress;
  if (!given || typeof given.country !== 'string' || !given.country) throw new Error(TAX_ADDRESS_REQUIRED);
  const address: TaxCalculationParams['address'] = { country: given.country };
  for (const key of ['line1', 'line2', 'city', 'state', 'postalCode'] as const) {
    const value = given[key];
    if (typeof value === 'string' && value.trim()) address[key] = value.trim();
  }
  return { address, addressSource: requiresShipping ? 'shipping' as const : 'billing' as const };
}

/**
 * Calculates the tax on an order before its payment session exists, through the provider that takes
 * the payment. Lines at 0 are left out, unless no other line is left: the calculation needs one, and
 * the shipping may still be taxed. The result must add up to the order's own amounts. An address the
 * provider cannot place is refused as the shopper's to correct; any other failure is logged and
 * becomes a TaxCalculationError.
 */
export async function calculateOrderTax(adapter: PaymentProviderAdapter, input: {
  cartId: string;
  currency: string;
  behavior: 'inclusive' | 'exclusive';
  settings: Pick<TaxSettings, 'taxCode' | 'shipFromCountry'>;
  lines: TaxCalculationParams['lines'];
  shippingAmount: number;
  address: TaxCalculationParams['address'];
  addressSource: TaxCalculationParams['addressSource'];
}) {
  const charged = input.lines.filter((line) => line.amount > 0);
  const params: TaxCalculationParams = {
    currency: input.currency, behavior: input.behavior, taxCode: input.settings.taxCode,
    lines: charged.length ? charged : input.lines.slice(0, 1), shippingAmount: input.shippingAmount,
    address: input.address, addressSource: input.addressSource, shipFromCountry: input.settings.shipFromCountry,
  };
  const failed = (reason: string, cause?: unknown) => {
    console.error(`[Commerce] Tax could not be calculated for basket ${input.cartId}: ${reason}`);
    return new TaxCalculationError(cause === undefined ? undefined : { cause });
  };
  // Tax that is calculated must be recorded and reversed too, so the provider needs all three.
  if (!adapter.calculateTax || !adapter.recordTaxTransaction || !adapter.reverseTaxTransaction) {
    throw failed(`payment provider ${adapter.providerId} cannot calculate, record and reverse tax`);
  }
  let calculation;
  try {
    calculation = await adapter.calculateTax(params);
  } catch (cause) {
    if (cause instanceof TaxAddressError) throw new Error(TAX_ADDRESS_UNUSABLE, { cause });
    throw failed(describe(cause), cause);
  }
  const exclusive = input.behavior === 'exclusive';
  const amount = exclusive ? calculation.taxAmountExclusive : calculation.taxAmountInclusive;
  const other = exclusive ? calculation.taxAmountInclusive : calculation.taxAmountExclusive;
  const base = params.lines.reduce((sum, line) => sum + line.amount, 0) + params.shippingAmount;
  if (typeof calculation.id !== 'string' || !calculation.id || !Number.isSafeInteger(amount) || amount < 0
    || other !== 0 || calculation.amountTotal !== base + (exclusive ? amount : 0) || (!exclusive && amount > base)) {
    throw failed(`calculation ${calculation.id} totals ${calculation.amountTotal} with ${amount} tax `
      + `${input.behavior}, where the order expects ${base}${exclusive ? ' plus the tax' : ''}`);
  }
  return { calculationId: calculation.id, amount, behavior: input.behavior };
}

/** The provider that calculated an order's tax: Stripe for an order a gift card paid in full. */
function taxProvider(adapters: PaymentProviderAdapter[], paymentProvider: string | null) {
  const providerId = paymentProvider === 'gift_card' ? 'stripe' : paymentProvider ?? 'stripe';
  return adapters.find((adapter) => adapter.providerId === providerId);
}

const PAID_STATUSES = ['paid', 'fulfilled', 'partially_refunded', 'refunded'];

/**
 * Records a paid order's tax from its calculation, once: the provider knows the transaction by the
 * order id, and only an order without a transaction takes one. Returns whether this call stored it.
 */
export async function recordOrderTax(env: TalismanEnv, adapters: PaymentProviderAdapter[], orderId: string) {
  const order = await env.DB.prepare(`SELECT id, status, payment_provider, tax_calculation_id, tax_transaction_id
    FROM _ecommerce_orders WHERE id = ?`).bind(orderId).first<{ id: string; status: string;
    payment_provider: string | null; tax_calculation_id: string | null; tax_transaction_id: string | null }>();
  if (!order?.tax_calculation_id || order.tax_transaction_id || !PAID_STATUSES.includes(order.status)) return false;
  const adapter = taxProvider(adapters, order.payment_provider);
  if (!adapter?.recordTaxTransaction) throw new Error('Payment provider cannot record tax');
  const { transactionId } = await adapter.recordTaxTransaction({ orderId: order.id,
    calculationId: order.tax_calculation_id });
  const stored = await env.DB.prepare(`UPDATE _ecommerce_orders SET tax_transaction_id = ?
    WHERE id = ? AND tax_transaction_id IS NULL`).bind(transactionId, order.id).run();
  return Number(stored.meta?.changes ?? 0) > 0;
}

/** Records the tax of an order whose payment was just confirmed. A failure is logged for reconcileCommerce to retry. */
export async function recordConfirmedOrderTax(env: TalismanEnv, adapters: PaymentProviderAdapter[], orderId: string) {
  try {
    await recordOrderTax(env, adapters, orderId);
  } catch (error) {
    console.error(`[Commerce] The tax transaction of order ${orderId} was not recorded: ${describe(error)}`);
  }
}

/**
 * How much of an order's taxed amount (gift card and provider charge together, tax included) has
 * been refunded, and so should be reversed: all of it once the order is refunded, else the provider
 * and gift card refunds so far.
 */
const REVERSAL_TARGET = `CASE WHEN o.status = 'refunded' THEN o.gift_card_applied + o.total_amount
  ELSE MIN(o.gift_card_applied + o.total_amount, o.provider_refunded_cents + o.gift_card_refunded_cents) END`;
const REVERSED = '(SELECT COALESCE(SUM(r.amount), 0) FROM _ecommerce_tax_reversals r WHERE r.order_id = o.id)';

/**
 * Brings the reversed total of an order's tax transaction up to what has been refunded, with one
 * partial reversal for the difference. Its reference names the order and the total it brings the
 * reversals to, and is also the provider's idempotency key.
 *
 * The reversal is recorded before the provider is asked, with an empty provider_reversal_id, and
 * only while the order's reversals still add up to what this call read. A concurrent call for a later
 * refund then records nothing and reads again, so a refund is never reversed twice. A recorded
 * reversal whose request failed stays pending, counts as reversed, and is sent again, unchanged, by
 * resendPendingTaxReversals. Returns the reversal this call sent, or null.
 */
export async function reverseOrderTax(env: TalismanEnv, adapters: PaymentProviderAdapter[], orderId: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const order = await env.DB.prepare(`SELECT o.id, o.payment_provider, o.tax_transaction_id,
        ${REVERSAL_TARGET} AS target, ${REVERSED} AS reversed
      FROM _ecommerce_orders o WHERE o.id = ?`).bind(orderId).first<{ id: string; payment_provider: string | null;
      tax_transaction_id: string | null; target: number; reversed: number }>();
    if (!order?.tax_transaction_id || order.target <= order.reversed) return null;
    const adapter = taxProvider(adapters, order.payment_provider);
    if (!adapter?.reverseTaxTransaction) throw new Error('Payment provider cannot reverse tax');
    const reversal = { orderId: order.id, transactionId: order.tax_transaction_id,
      reference: `${order.id}:reversal:${order.target}`, amount: order.target - order.reversed };
    const recorded = await env.DB.prepare(`INSERT INTO _ecommerce_tax_reversals
      (id, order_id, reference, amount, provider_reversal_id, created_at)
      SELECT ?, ?, ?, ?, '', ? WHERE (SELECT COALESCE(SUM(amount), 0) FROM _ecommerce_tax_reversals
        WHERE order_id = ?) = ?
      ON CONFLICT(reference) DO NOTHING`)
      .bind(`taxrev_${crypto.randomUUID()}`, order.id, reversal.reference, reversal.amount,
        Math.floor(Date.now() / 1000), order.id, order.reversed).run();
    if (Number(recorded.meta?.changes ?? 0) > 0) {
      await sendTaxReversal(env, adapter, reversal);
      return { reference: reversal.reference, amount: reversal.amount };
    }
  }
  return null;
}

async function sendTaxReversal(env: TalismanEnv, adapter: PaymentProviderAdapter,
  reversal: { orderId: string; transactionId: string; reference: string; amount: number }) {
  if (!adapter.reverseTaxTransaction) throw new Error('Payment provider cannot reverse tax');
  const { reversalId } = await adapter.reverseTaxTransaction(reversal);
  await env.DB.prepare(`UPDATE _ecommerce_tax_reversals SET provider_reversal_id = ?
    WHERE reference = ? AND provider_reversal_id = ''`).bind(reversalId, reversal.reference).run();
}

/** Mirrors an order's latest refunds in its tax. A failure is logged for reconcileCommerce to retry. */
export async function reverseRefundedOrderTax(env: TalismanEnv, adapters: PaymentProviderAdapter[], orderId: string) {
  try {
    await reverseOrderTax(env, adapters, orderId);
  } catch (error) {
    console.error(`[Commerce] The tax reversal of order ${orderId} was not recorded: ${describe(error)}`);
  }
}

/** Paid orders whose tax transaction is not recorded yet, oldest first, for reconcileCommerce. */
export async function ordersMissingTaxTransaction(env: TalismanEnv, limit: number) {
  // Repeats the partial index's conditions, so SQLite looks the orders up in it.
  const rows = await env.DB.prepare(`SELECT id FROM _ecommerce_orders
    WHERE status IN (${PAID_STATUSES.map((status) => `'${status}'`).join(', ')})
      AND tax_calculation_id IS NOT NULL AND tax_transaction_id IS NULL
    ORDER BY created_at LIMIT ?`).bind(limit).all<{ id: string }>();
  return rows.results ?? [];
}

/** Refunded orders whose tax is not reversed as far as their refunds, oldest first, for reconcileCommerce. */
export async function ordersWithUnreversedTax(env: TalismanEnv, limit: number) {
  const rows = await env.DB.prepare(`SELECT o.id FROM _ecommerce_orders o
    WHERE o.status IN ('partially_refunded', 'refunded') AND o.tax_transaction_id IS NOT NULL
      AND ${REVERSAL_TARGET} > ${REVERSED}
    ORDER BY o.created_at LIMIT ?`).bind(limit).all<{ id: string }>();
  return rows.results ?? [];
}

/**
 * Sends recorded reversals again whose request failed or never finished, oldest first. Those recorded
 * after `recordedBefore` (Unix seconds) may still be in flight and are left alone.
 */
export async function resendPendingTaxReversals(env: TalismanEnv, adapters: PaymentProviderAdapter[],
  recordedBefore: number, limit: number) {
  const pending = await env.DB.prepare(`SELECT r.order_id, r.reference, r.amount, o.payment_provider,
      o.tax_transaction_id FROM _ecommerce_tax_reversals r JOIN _ecommerce_orders o ON o.id = r.order_id
    WHERE r.provider_reversal_id = '' AND r.created_at < ?
    ORDER BY r.created_at LIMIT ?`).bind(recordedBefore, limit).all<{ order_id: string; reference: string;
    amount: number; payment_provider: string | null; tax_transaction_id: string }>();
  const results: Array<{ id: string; status: string; error?: string }> = [];
  for (const row of pending.results ?? []) {
    try {
      const adapter = taxProvider(adapters, row.payment_provider);
      if (!adapter) throw new Error('Payment provider cannot reverse tax');
      await sendTaxReversal(env, adapter, { orderId: row.order_id, transactionId: row.tax_transaction_id,
        reference: row.reference, amount: row.amount });
      results.push({ id: row.order_id, status: 'tax_reversed' });
    } catch (error) {
      results.push({ id: row.order_id, status: 'error', error: describe(error) });
    }
  }
  return results;
}
