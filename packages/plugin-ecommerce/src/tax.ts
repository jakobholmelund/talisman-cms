import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { createDbClient, type TalismanEnv } from 'talisman-cms/client';
import { TaxAddressError, type PaymentProviderAdapter, type TaxCalculationParams } from './payments';
import { orders, taxReversals } from './schema';
import type { TaxSettings } from './store-settings';
import { TAX_ADDRESS_REQUIRED, TAX_ADDRESS_UNUSABLE, TAX_UNAVAILABLE } from './checkout-input';
import { ReconcileFailure, backoffSql, reconcileFailure, type ReconcileResult } from './reconcile';

/**
 * Tax could not be calculated, so checkout stopped before the basket was locked. The routes answer
 * 503 with this message; the cause is in the Worker log.
 */
/** Stripe's product tax code for shipping charges. */
const SHIPPING_TAX_CODE = 'txcd_92010001';

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
  // Store credit can pay for every item while shipping is still charged. Stripe takes no line at 0,
  // so the shipping is then the only line, under Stripe's tax code for shipping.
  const shippingOnly = !charged.length && input.shippingAmount > 0;
  const params: TaxCalculationParams = {
    currency: input.currency, behavior: input.behavior, taxCode: input.settings.taxCode,
    lines: shippingOnly ? [{ reference: 'shipping', amount: input.shippingAmount, quantity: 1, taxCode: SHIPPING_TAX_CODE }]
      : charged.length ? charged : input.lines.slice(0, 1),
    shippingAmount: shippingOnly ? 0 : input.shippingAmount,
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

// A dispute does not undo the sale, so a disputed order's tax transaction is still recorded.
const PAID_STATUSES = ['paid', 'fulfilled', 'partially_refunded', 'refunded', 'disputed'];

// Tax attempts back off as payment reconciliation does, on counts of their own (backoffSql in
// reconcile.ts): each failure adds an attempt with its time and a code, never the provider's text; the
// next attempt waits 2^attempts minutes, at most six hours; a success clears the count. An order's
// tax_sync_* columns cover recording its transaction and, once it is refunded, recording the reversals
// of its refunds; a reversal's own cover sending it to the provider. Failures at payment and refund
// time count too, so that reconcileCommerce retries them after the same wait.
const TAX_SYNC_CLEARED = { taxSyncAttempts: 0, taxSyncLastAt: null, taxSyncLastError: null } as const;
const ORDER_TAX_BACKOFF = backoffSql('tax_sync');

const unixNow = () => Math.floor(Date.now() / 1000);

/** Counts a failed tax attempt at `now` on the order or reversal that `where` names by the bound `key`. */
async function countTaxFailure(env: TalismanEnv, table: '_ecommerce_orders' | '_ecommerce_tax_reversals',
  where: string, key: string, error: unknown, now: number) {
  try {
    await env.DB.prepare(`UPDATE ${table} SET tax_sync_attempts = tax_sync_attempts + 1, tax_sync_last_at = ?,
      tax_sync_last_error = ? WHERE ${where}`).bind(now, reconcileFailure(error).code, key).run();
  } catch {
    // Best effort: an attempt whose failure is not counted is only retried sooner.
  }
}

/**
 * Records a paid order's tax from its calculation, once: the provider knows the transaction by the
 * order id, and only an order without a transaction takes one. Returns whether this call stored it.
 * Storing it clears the order's failed attempts; a failure is counted at `now` and thrown.
 */
export async function recordOrderTax(env: TalismanEnv, adapters: PaymentProviderAdapter[], orderId: string,
  now = unixNow()) {
  const order = await env.DB.prepare(`SELECT id, status, payment_provider, tax_calculation_id, tax_transaction_id,
      (SELECT MIN(created_at) FROM _ecommerce_payments WHERE order_id = o.id) AS paid_at
    FROM _ecommerce_orders o WHERE id = ?`).bind(orderId).first<{ id: string; status: string;
    payment_provider: string | null; tax_calculation_id: string | null; tax_transaction_id: string | null;
    paid_at: number | null }>();
  if (!order?.tax_calculation_id || order.tax_transaction_id || !PAID_STATUSES.includes(order.status)) return false;
  try {
    const adapter = taxProvider(adapters, order.payment_provider);
    if (!adapter?.recordTaxTransaction) {
      throw new ReconcileFailure('provider_not_configured', 'Payment provider cannot record tax');
    }
    // A record made well after the payment, by reconcileCommerce, is dated at the payment so its tax
    // falls in that period. A prompt one leaves the date to the provider, whose clock may run behind.
    const late = order.paid_at !== null && order.paid_at < Math.floor(Date.now() / 1000) - 300;
    const { transactionId } = await adapter.recordTaxTransaction({ orderId: order.id,
      calculationId: order.tax_calculation_id, ...(late ? { postedAt: order.paid_at! } : {}) });
    const stored = await createDbClient(env).update(orders).set({ taxTransactionId: transactionId, ...TAX_SYNC_CLEARED })
      .where(and(eq(orders.id, order.id), isNull(orders.taxTransactionId))).run();
    return Number(stored.meta?.changes ?? 0) > 0;
  } catch (error) {
    // Only while the transaction is missing: a failure that an overlapping run's record overtook is not kept.
    await countTaxFailure(env, '_ecommerce_orders', 'id = ? AND tax_transaction_id IS NULL', order.id, error, now);
    throw error;
  }
}

/**
 * Records the tax of an order whose payment was just confirmed. A failure is logged and counted, so
 * reconcileCommerce retries it after the same wait as its own failures.
 */
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
 * Records the partial reversal that brings an order's reversed tax up to what has been refunded (see
 * reverseOrderTax), and returns it with the provider that sends it, or null when nothing is left.
 */
async function recordTaxReversal(env: TalismanEnv, adapters: PaymentProviderAdapter[], orderId: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const order = await env.DB.prepare(`SELECT o.id, o.payment_provider, o.tax_transaction_id,
        ${REVERSAL_TARGET} AS target, ${REVERSED} AS reversed
      FROM _ecommerce_orders o WHERE o.id = ?`).bind(orderId).first<{ id: string; payment_provider: string | null;
      tax_transaction_id: string | null; target: number; reversed: number }>();
    if (!order?.tax_transaction_id || order.target <= order.reversed) return null;
    const adapter = taxProvider(adapters, order.payment_provider);
    if (!adapter?.reverseTaxTransaction) {
      throw new ReconcileFailure('provider_not_configured', 'Payment provider cannot reverse tax');
    }
    const reversal = { orderId: order.id, transactionId: order.tax_transaction_id,
      reference: `${order.id}:reversal:${order.target}`, amount: order.target - order.reversed };
    const recorded = await env.DB.prepare(`INSERT INTO _ecommerce_tax_reversals
      (id, order_id, reference, amount, provider_reversal_id, created_at)
      SELECT ?, ?, ?, ?, '', ? WHERE (SELECT COALESCE(SUM(amount), 0) FROM _ecommerce_tax_reversals
        WHERE order_id = ?) = ?
      ON CONFLICT(reference) DO NOTHING`)
      .bind(`taxrev_${crypto.randomUUID()}`, order.id, reversal.reference, reversal.amount,
        Math.floor(Date.now() / 1000), order.id, order.reversed).run();
    if (Number(recorded.meta?.changes ?? 0) > 0) return { adapter, reversal };
  }
  return null;
}

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
 *
 * A failure before the reversal is recorded is counted on the order, and one after it on the
 * reversal, at `now`; either is thrown. Recording the reversal clears the order's count.
 */
export async function reverseOrderTax(env: TalismanEnv, adapters: PaymentProviderAdapter[], orderId: string,
  now = unixNow()) {
  let recorded: Awaited<ReturnType<typeof recordTaxReversal>>;
  try {
    recorded = await recordTaxReversal(env, adapters, orderId);
  } catch (error) {
    await countTaxFailure(env, '_ecommerce_orders', 'id = ?', orderId, error, now);
    throw error;
  }
  if (!recorded) return null;
  try {
    await createDbClient(env).update(orders).set(TAX_SYNC_CLEARED)
      .where(and(eq(orders.id, orderId), isNotNull(orders.taxSyncLastAt)));
  } catch {
    // Best effort: a count left behind only delays the order's next reversal, never this one.
  }
  await sendTaxReversal(env, recorded.adapter, recorded.reversal, now);
  return { reference: recorded.reversal.reference, amount: recorded.reversal.amount };
}

/**
 * Sends a recorded reversal and stores the provider's id for it, which clears its failed attempts. A
 * failure is counted on the reversal at `now`, so that its resend backs off, and thrown.
 */
async function sendTaxReversal(env: TalismanEnv, adapter: PaymentProviderAdapter | undefined,
  reversal: { orderId: string; transactionId: string; reference: string; amount: number }, now: number) {
  try {
    if (!adapter?.reverseTaxTransaction) {
      throw new ReconcileFailure('provider_not_configured', 'Payment provider cannot reverse tax');
    }
    const { reversalId } = await adapter.reverseTaxTransaction(reversal);
    await createDbClient(env).update(taxReversals).set({ providerReversalId: reversalId, ...TAX_SYNC_CLEARED })
      .where(and(eq(taxReversals.reference, reversal.reference), eq(taxReversals.providerReversalId, '')));
  } catch (error) {
    await countTaxFailure(env, '_ecommerce_tax_reversals', `reference = ? AND provider_reversal_id = ''`,
      reversal.reference, error, now);
    throw error;
  }
}

/**
 * Mirrors an order's latest refunds in its tax. A failure is logged and counted, so reconcileCommerce
 * retries it after the same wait as its own failures.
 */
export async function reverseRefundedOrderTax(env: TalismanEnv, adapters: PaymentProviderAdapter[], orderId: string) {
  try {
    await reverseOrderTax(env, adapters, orderId);
  } catch (error) {
    console.error(`[Commerce] The tax reversal of order ${orderId} was not recorded: ${describe(error)}`);
  }
}

/**
 * Runs one tax attempt per row for reconcileCommerce, each on its own. A failure is reported under the
 * row's order with the admin-safe message and code of reconcileFailure, never the provider's text.
 */
async function attemptEach<Row>(rows: Row[], orderOf: (row: Row) => string,
  attempt: (row: Row) => Promise<string>): Promise<ReconcileResult[]> {
  const results: ReconcileResult[] = [];
  for (const row of rows) {
    try {
      results.push({ id: orderOf(row), status: await attempt(row) });
    } catch (error) {
      const failure = reconcileFailure(error);
      results.push({ id: orderOf(row), status: 'error', error: failure.message, code: failure.code });
    }
  }
  return results;
}

/**
 * Records the tax transactions that were not recorded when their orders were paid: up to `limit`
 * orders whose wait has passed, never tried first, then those tried longest ago, then the oldest, so
 * orders that keep failing never hold back newer ones.
 */
export async function recordMissingTaxTransactions(env: TalismanEnv, adapters: PaymentProviderAdapter[],
  now: number, limit: number) {
  // Repeats the partial index's conditions, so SQLite looks the orders up in it.
  const rows = await env.DB.prepare(`SELECT id FROM _ecommerce_orders
    WHERE status IN (${PAID_STATUSES.map((status) => `'${status}'`).join(', ')})
      AND tax_calculation_id IS NOT NULL AND tax_transaction_id IS NULL AND ${ORDER_TAX_BACKOFF.due}
    ORDER BY ${ORDER_TAX_BACKOFF.order} LIMIT ?`).bind(now, limit).all<{ id: string }>();
  return attemptEach(rows.results ?? [], (row) => row.id,
    async (row) => await recordOrderTax(env, adapters, row.id, now) ? 'tax_recorded' : 'unchanged');
}

/** Reversals recorded this recently may still be in flight, so they are not sent again yet. */
const REVERSAL_IN_FLIGHT_SECONDS = 5 * 60;
const REVERSAL_BACKOFF = backoffSql('tax_sync', 'r');

/**
 * Sends again the recorded reversals whose request failed or never finished, those recorded in the
 * last five minutes aside: up to `limit` whose wait has passed, in the order recordMissingTaxTransactions
 * takes orders.
 */
export async function resendPendingTaxReversals(env: TalismanEnv, adapters: PaymentProviderAdapter[],
  now: number, limit: number) {
  // States `provider_reversal_id = ''` word for word, so SQLite reads only unsent reversals, from their partial index.
  const pending = await env.DB.prepare(`SELECT r.order_id, r.reference, r.amount, o.payment_provider,
      o.tax_transaction_id FROM _ecommerce_tax_reversals r JOIN _ecommerce_orders o ON o.id = r.order_id
    WHERE r.provider_reversal_id = '' AND r.created_at < ? AND ${REVERSAL_BACKOFF.due}
    ORDER BY ${REVERSAL_BACKOFF.order} LIMIT ?`).bind(now - REVERSAL_IN_FLIGHT_SECONDS, now, limit)
    .all<{ order_id: string; reference: string; amount: number; payment_provider: string | null;
      tax_transaction_id: string }>();
  return attemptEach(pending.results ?? [], (row) => row.order_id, async (row) => {
    await sendTaxReversal(env, taxProvider(adapters, row.payment_provider), { orderId: row.order_id,
      transactionId: row.tax_transaction_id, reference: row.reference, amount: row.amount }, now);
    return 'tax_reversed';
  });
}

const REFUNDED_ORDER_TAX_BACKOFF = backoffSql('tax_sync', 'o');

/**
 * Reverses the refunds not yet mirrored in their orders' tax: up to `limit` refunded orders whose wait
 * has passed, in the order recordMissingTaxTransactions takes orders.
 */
export async function reverseUnreversedTax(env: TalismanEnv, adapters: PaymentProviderAdapter[],
  now: number, limit: number) {
  // Repeats the conditions of the partial index of migration 0029, so SQLite reads only refunded orders
  // with a tax transaction.
  const rows = await env.DB.prepare(`SELECT o.id FROM _ecommerce_orders o
    WHERE o.status IN ('partially_refunded', 'refunded') AND o.tax_transaction_id IS NOT NULL
      AND ${REVERSAL_TARGET} > ${REVERSED} AND ${REFUNDED_ORDER_TAX_BACKOFF.due}
    ORDER BY ${REFUNDED_ORDER_TAX_BACKOFF.order} LIMIT ?`).bind(now, limit).all<{ id: string }>();
  return attemptEach(rows.results ?? [], (row) => row.id,
    async (row) => await reverseOrderTax(env, adapters, row.id, now) ? 'tax_reversed' : 'unchanged');
}
