import {
  INVENTORY_COLUMNS,
  fullRefundStatements
} from "./chunk-WVV2IFQ2.js";
import {
  evaluateDiscountCode
} from "./chunk-XAGOV7NN.js";
import {
  TaxAddressError
} from "./chunk-BGDJXEM5.js";
import {
  deliverCommerceEmail,
  deliverPendingCommerceEmails,
  fulfillCommerceOrder
} from "./chunk-YEGM7CMZ.js";
import {
  RECONCILE_DUE,
  RECONCILE_ORDER,
  ReconcileFailure,
  WebhookMismatchError,
  WebhookRetryLaterError,
  WebhookSignatureError,
  assertStoreStripeMode,
  backoffSql,
  commerceEmailStatement,
  completedCheckoutReturn,
  confirmGiftCardPurchase,
  decisionInsert,
  evaluateGiftCard,
  expireGiftCardPurchase,
  giftCardPurchaseChargebackStatements,
  giftCardPurchaseHoldStatements,
  giftCardPurchaseReleaseStatements,
  isCountryCode,
  isMissingSessionError,
  isOtherStripeModeSession,
  readStoreSettings,
  reconcileAttempt,
  reconcileFailure,
  reconcileGiftCardPurchase,
  recordGiftCardPurchaseRefund,
  sessionLookupFailure,
  uncheckedSessionRefusal
} from "./chunk-X4P2D5BU.js";
import {
  canonicalEmail,
  canonicalEmailSql,
  canonicalEmails,
  canonicalPurchaseParams,
  canonicalPurchaseSql,
  findReferralCode,
  getReferralPolicy,
  hasCanonicalPurchase,
  referralReversalStatements,
  releaseReferralAwards
} from "./chunk-CBY7OG6Q.js";
import {
  PURCHASED_ORDER_STATUSES,
  claimInterval,
  hasPurchaseHistory
} from "./chunk-LEMVBDL4.js";
import {
  carts,
  componentReservations,
  customerAccounts,
  customerSessions,
  giftCardPurchases,
  inventoryReservations,
  orders,
  productVariantValues,
  productVariants,
  products,
  referralCodes,
  taxReversals
} from "./chunk-K4FWMXR2.js";
import {
  minimumChargeAmount
} from "./chunk-2UYSCNNW.js";

// src/api.ts
import { createDbClient as createDbClient3 } from "talisman-cms/client";
import { and as and2, eq as eq3, inArray, isNotNull as isNotNull2, isNull as isNull2, lt, or, sql } from "drizzle-orm";

// src/provider-checks.ts
var PROVIDER_CHECK_INTERVAL_SECONDS = 15;
var PROVIDER_CHECK_MIN_ORDER_AGE_SECONDS = 60;
var PROVIDER_CHECK_RETRY_MESSAGE = "The payment session was checked moments ago. Please try again in 15 seconds.";
var ProviderCheckLimitedError = class extends Error {
  name = "ProviderCheckLimitedError";
  constructor() {
    super(PROVIDER_CHECK_RETRY_MESSAGE);
  }
};
function providerCheckLimitResponse() {
  return Response.json({ error: PROVIDER_CHECK_RETRY_MESSAGE }, {
    status: 429,
    headers: { "Retry-After": String(PROVIDER_CHECK_INTERVAL_SECONDS), "Cache-Control": "no-store" }
  });
}
async function mayAskPaymentProvider(env, order, paymentAdapters, { minOrderAgeSeconds = 0, now = Math.floor(Date.now() / 1e3) } = {}) {
  const provider = order.paymentProvider ?? "stripe";
  if (!paymentAdapters.some((adapter) => adapter.providerId === provider)) return true;
  if (now - Math.floor(order.createdAt.getTime() / 1e3) < minOrderAgeSeconds) return false;
  return claimInterval(env, `order-status:${order.id}`, PROVIDER_CHECK_INTERVAL_SECONDS, now);
}

// src/checkout-input.ts
import { z } from "zod";
var INVALID_COUNTRY = "Enter a valid country code";
var UNDELIVERABLE_COUNTRY = "We do not deliver to this country";
var SHIPPING_OPTION_UNAVAILABLE = "This shipping option is not available for your country";
var TAX_ADDRESS_REQUIRED = "A billing address is required to calculate tax";
var TAX_ADDRESS_UNUSABLE = "Tax cannot be calculated for this address. Check it and try again.";
var TAX_UNAVAILABLE = "Tax could not be calculated. Please try again.";
var correctableRefusals = /* @__PURE__ */ new Set([
  INVALID_COUNTRY,
  UNDELIVERABLE_COUNTRY,
  SHIPPING_OPTION_UNAVAILABLE,
  TAX_ADDRESS_REQUIRED,
  TAX_ADDRESS_UNUSABLE
]);
function isCheckoutDetailsError(error) {
  return error instanceof Error && correctableRefusals.has(error.message);
}
function withCountryCode(address) {
  const country = address?.country;
  if (country === void 0 || country === null) return address;
  const code = typeof country === "string" ? country.trim().toUpperCase() : null;
  if (code === null || code && !isCountryCode(code)) throw new Error(INVALID_COUNTRY);
  return { ...address, country: code };
}
var addressSchema = z.object({
  name: z.string().trim().max(200).optional(),
  line1: z.string().trim().max(200).optional(),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(30).optional(),
  // Any case. Only officially assigned codes pass, so a mistyped "UK" is refused rather than stored.
  country: z.string().trim().toUpperCase().refine(isCountryCode, INVALID_COUNTRY).optional()
});
var checkoutSchema = z.object({
  customerEmail: z.string().trim().email().max(254).optional(),
  discountCode: z.string().trim().max(32).optional(),
  giftCardCode: z.string().trim().max(37).optional(),
  shippingAddress: addressSchema.optional(),
  billingAddress: addressSchema.optional(),
  // A rate id from the store's shipping rates. Left out or blank, checkout uses the first rate that
  // serves the country.
  shippingRateId: z.string().trim().max(40).optional()
});
function checkoutInputError(error) {
  return error.issues.some((issue) => issue.path.at(-1) === "country") ? INVALID_COUNTRY : "Invalid checkout details";
}

// src/shipping.ts
function shippingOptionsFor(settings, country, itemsAmount) {
  return ratesServing(settings, country).map((rate) => ({
    id: rate.id,
    label: rate.label,
    amount: shippingCharge(rate, itemsAmount),
    description: deliveryEstimate(rate),
    freeOver: rate.freeOver,
    minDays: rate.minDays,
    maxDays: rate.maxDays
  }));
}
function ratesServing(settings, country) {
  const code = typeof country === "string" ? country.trim().toUpperCase() : "";
  if (!isCountryCode(code) || settings.deliveryCountries && !settings.deliveryCountries.includes(code)) return [];
  return settings.shippingRates.filter((rate) => !rate.countries || rate.countries.includes(code));
}
function chooseShippingRate(settings, country, chosenId) {
  const serving = ratesServing(settings, country);
  if (!serving.length) throw new Error(UNDELIVERABLE_COUNTRY);
  const chosen = chosenId?.trim();
  const rate = chosen ? serving.find((candidate) => candidate.id === chosen) : serving[0];
  if (!rate) throw new Error(SHIPPING_OPTION_UNAVAILABLE);
  return rate;
}
function shippingCharge(rate, itemsAmount) {
  return rate.freeOver !== null && itemsAmount >= rate.freeOver ? 0 : rate.amount;
}
function deliveryEstimate(rate) {
  const days = (count) => `${count} business day${count === 1 ? "" : "s"}`;
  const { minDays, maxDays } = rate;
  if (minDays !== null && maxDays !== null) {
    return `Delivery in ${minDays === maxDays ? days(maxDays) : `${minDays}\u2013${days(maxDays)}`}`;
  }
  if (maxDays !== null) return `Delivery in up to ${days(maxDays)}`;
  if (minDays !== null) return `Delivery in at least ${days(minDays)}`;
  return null;
}

// src/tax.ts
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { createDbClient } from "talisman-cms/client";
var SHIPPING_TAX_CODE = "txcd_92010001";
var TaxCalculationError = class extends Error {
  constructor(options) {
    super(TAX_UNAVAILABLE, options);
    this.name = "TaxCalculationError";
  }
};
var describe = (error) => error instanceof Error ? error.message : String(error);
function allocateProportionally(amount, weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  const parts = weights.map((weight, index) => {
    const product = BigInt(amount) * BigInt(weight);
    return { index, share: Number(product / BigInt(total)), remainder: product % BigInt(total) };
  });
  let left = amount - parts.reduce((sum, part) => sum + part.share, 0);
  const byRemainder = [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const part of byRemainder) {
    if (left <= 0) break;
    part.share += 1;
    left -= 1;
  }
  return parts.map((part) => part.share);
}
function taxableLines(lines, discount, creditApplied) {
  const totals = lines.map((line) => line.priceAtPurchase * line.quantity);
  const discounts = allocateProportionally(discount.amount, totals.map((total, index) => !discount.productIds.length || discount.productIds.includes(lines[index].productId) ? total : 0));
  const afterDiscount = totals.map((total, index) => total - discounts[index]);
  const credits = allocateProportionally(creditApplied, afterDiscount);
  return lines.map((line, index) => ({
    // Unique within the order, and names the product in the provider's tax reports.
    reference: `L${index + 1}:${line.productId}${line.variantId ? `:${line.variantId}` : ""}`,
    amount: afterDiscount[index] - credits[index],
    quantity: line.quantity
  }));
}
function taxAddressFor(requiresShipping, shippingAddress, billingAddress) {
  const given = requiresShipping ? shippingAddress : billingAddress;
  if (!given || typeof given.country !== "string" || !given.country) throw new Error(TAX_ADDRESS_REQUIRED);
  const address = { country: given.country };
  for (const key of ["line1", "line2", "city", "state", "postalCode"]) {
    const value = given[key];
    if (typeof value === "string" && value.trim()) address[key] = value.trim();
  }
  return { address, addressSource: requiresShipping ? "shipping" : "billing" };
}
async function calculateOrderTax(adapter, input) {
  const charged = input.lines.filter((line) => line.amount > 0);
  const shippingOnly = !charged.length && input.shippingAmount > 0;
  const params = {
    currency: input.currency,
    behavior: input.behavior,
    taxCode: input.settings.taxCode,
    lines: shippingOnly ? [{ reference: "shipping", amount: input.shippingAmount, quantity: 1, taxCode: SHIPPING_TAX_CODE }] : charged.length ? charged : input.lines.slice(0, 1),
    shippingAmount: shippingOnly ? 0 : input.shippingAmount,
    address: input.address,
    addressSource: input.addressSource,
    shipFromCountry: input.settings.shipFromCountry
  };
  const failed = (reason, cause) => {
    console.error(`[Commerce] Tax could not be calculated for basket ${input.cartId}: ${reason}`);
    return new TaxCalculationError(cause === void 0 ? void 0 : { cause });
  };
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
  const exclusive = input.behavior === "exclusive";
  const amount = exclusive ? calculation.taxAmountExclusive : calculation.taxAmountInclusive;
  const other = exclusive ? calculation.taxAmountInclusive : calculation.taxAmountExclusive;
  const base = params.lines.reduce((sum, line) => sum + line.amount, 0) + params.shippingAmount;
  if (typeof calculation.id !== "string" || !calculation.id || !Number.isSafeInteger(amount) || amount < 0 || other !== 0 || calculation.amountTotal !== base + (exclusive ? amount : 0) || !exclusive && amount > base) {
    throw failed(`calculation ${calculation.id} totals ${calculation.amountTotal} with ${amount} tax ${input.behavior}, where the order expects ${base}${exclusive ? " plus the tax" : ""}`);
  }
  return { calculationId: calculation.id, amount, behavior: input.behavior };
}
function taxProvider(adapters, paymentProvider) {
  const providerId = paymentProvider === "gift_card" ? "stripe" : paymentProvider ?? "stripe";
  return adapters.find((adapter) => adapter.providerId === providerId);
}
var PAID_STATUSES = ["paid", "fulfilled", "partially_refunded", "refunded", "disputed"];
var TAX_SYNC_CLEARED = { taxSyncAttempts: 0, taxSyncLastAt: null, taxSyncLastError: null };
var ORDER_TAX_BACKOFF = backoffSql("tax_sync");
var unixNow = () => Math.floor(Date.now() / 1e3);
async function countTaxFailure(env, table, where, key, error, now) {
  try {
    await env.DB.prepare(`UPDATE ${table} SET tax_sync_attempts = tax_sync_attempts + 1, tax_sync_last_at = ?,
      tax_sync_last_error = ? WHERE ${where}`).bind(now, reconcileFailure(error).code, key).run();
  } catch {
  }
}
async function recordOrderTax(env, adapters, orderId, now = unixNow()) {
  const order = await env.DB.prepare(`SELECT id, status, payment_provider, tax_calculation_id, tax_transaction_id,
      (SELECT MIN(created_at) FROM _ecommerce_payments WHERE order_id = o.id) AS paid_at
    FROM _ecommerce_orders o WHERE id = ?`).bind(orderId).first();
  if (!order?.tax_calculation_id || order.tax_transaction_id || !PAID_STATUSES.includes(order.status)) return false;
  try {
    const adapter = taxProvider(adapters, order.payment_provider);
    if (!adapter?.recordTaxTransaction) {
      throw new ReconcileFailure("provider_not_configured", "Payment provider cannot record tax");
    }
    const late = order.paid_at !== null && order.paid_at < Math.floor(Date.now() / 1e3) - 300;
    const { transactionId } = await adapter.recordTaxTransaction({
      orderId: order.id,
      calculationId: order.tax_calculation_id,
      ...late ? { postedAt: order.paid_at } : {}
    });
    const stored = await createDbClient(env).update(orders).set({ taxTransactionId: transactionId, ...TAX_SYNC_CLEARED }).where(and(eq(orders.id, order.id), isNull(orders.taxTransactionId))).run();
    return Number(stored.meta?.changes ?? 0) > 0;
  } catch (error) {
    await countTaxFailure(env, "_ecommerce_orders", "id = ? AND tax_transaction_id IS NULL", order.id, error, now);
    throw error;
  }
}
async function recordConfirmedOrderTax(env, adapters, orderId) {
  try {
    await recordOrderTax(env, adapters, orderId);
  } catch (error) {
    console.error(`[Commerce] The tax transaction of order ${orderId} was not recorded: ${describe(error)}`);
  }
}
var REVERSAL_TARGET = `CASE WHEN o.status = 'refunded' THEN o.gift_card_applied + o.total_amount
  ELSE MIN(o.gift_card_applied + o.total_amount, o.provider_refunded_cents + o.gift_card_refunded_cents) END`;
var REVERSED = "(SELECT COALESCE(SUM(r.amount), 0) FROM _ecommerce_tax_reversals r WHERE r.order_id = o.id)";
async function recordTaxReversal(env, adapters, orderId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const order = await env.DB.prepare(`SELECT o.id, o.payment_provider, o.tax_transaction_id,
        ${REVERSAL_TARGET} AS target, ${REVERSED} AS reversed
      FROM _ecommerce_orders o WHERE o.id = ?`).bind(orderId).first();
    if (!order?.tax_transaction_id || order.target <= order.reversed) return null;
    const adapter = taxProvider(adapters, order.payment_provider);
    if (!adapter?.reverseTaxTransaction) {
      throw new ReconcileFailure("provider_not_configured", "Payment provider cannot reverse tax");
    }
    const reversal = {
      orderId: order.id,
      transactionId: order.tax_transaction_id,
      reference: `${order.id}:reversal:${order.target}`,
      amount: order.target - order.reversed
    };
    const recorded = await env.DB.prepare(`INSERT INTO _ecommerce_tax_reversals
      (id, order_id, reference, amount, provider_reversal_id, created_at)
      SELECT ?, ?, ?, ?, '', ? WHERE (SELECT COALESCE(SUM(amount), 0) FROM _ecommerce_tax_reversals
        WHERE order_id = ?) = ?
      ON CONFLICT(reference) DO NOTHING`).bind(
      `taxrev_${crypto.randomUUID()}`,
      order.id,
      reversal.reference,
      reversal.amount,
      Math.floor(Date.now() / 1e3),
      order.id,
      order.reversed
    ).run();
    if (Number(recorded.meta?.changes ?? 0) > 0) return { adapter, reversal };
  }
  return null;
}
async function reverseOrderTax(env, adapters, orderId, now = unixNow()) {
  let recorded;
  try {
    recorded = await recordTaxReversal(env, adapters, orderId);
  } catch (error) {
    await countTaxFailure(env, "_ecommerce_orders", "id = ?", orderId, error, now);
    throw error;
  }
  if (!recorded) return null;
  try {
    await createDbClient(env).update(orders).set(TAX_SYNC_CLEARED).where(and(eq(orders.id, orderId), isNotNull(orders.taxSyncLastAt)));
  } catch {
  }
  await sendTaxReversal(env, recorded.adapter, recorded.reversal, now);
  return { reference: recorded.reversal.reference, amount: recorded.reversal.amount };
}
async function sendTaxReversal(env, adapter, reversal, now) {
  try {
    if (!adapter?.reverseTaxTransaction) {
      throw new ReconcileFailure("provider_not_configured", "Payment provider cannot reverse tax");
    }
    const { reversalId } = await adapter.reverseTaxTransaction(reversal);
    await createDbClient(env).update(taxReversals).set({ providerReversalId: reversalId, ...TAX_SYNC_CLEARED }).where(and(eq(taxReversals.reference, reversal.reference), eq(taxReversals.providerReversalId, "")));
  } catch (error) {
    await countTaxFailure(
      env,
      "_ecommerce_tax_reversals",
      `reference = ? AND provider_reversal_id = ''`,
      reversal.reference,
      error,
      now
    );
    throw error;
  }
}
async function reverseRefundedOrderTax(env, adapters, orderId) {
  try {
    await reverseOrderTax(env, adapters, orderId);
  } catch (error) {
    console.error(`[Commerce] The tax reversal of order ${orderId} was not recorded: ${describe(error)}`);
  }
}
async function attemptEach(rows, orderOf, attempt) {
  const results = [];
  for (const row of rows) {
    try {
      results.push({ id: orderOf(row), status: await attempt(row) });
    } catch (error) {
      const failure = reconcileFailure(error);
      results.push({ id: orderOf(row), status: "error", error: failure.message, code: failure.code });
    }
  }
  return results;
}
async function recordMissingTaxTransactions(env, adapters, now, limit) {
  const rows = await env.DB.prepare(`SELECT id FROM _ecommerce_orders
    WHERE status IN (${PAID_STATUSES.map((status) => `'${status}'`).join(", ")})
      AND tax_calculation_id IS NOT NULL AND tax_transaction_id IS NULL AND ${ORDER_TAX_BACKOFF.due}
    ORDER BY ${ORDER_TAX_BACKOFF.order} LIMIT ?`).bind(now, limit).all();
  return attemptEach(
    rows.results ?? [],
    (row) => row.id,
    async (row) => await recordOrderTax(env, adapters, row.id, now) ? "tax_recorded" : "unchanged"
  );
}
var REVERSAL_IN_FLIGHT_SECONDS = 5 * 60;
var REVERSAL_BACKOFF = backoffSql("tax_sync", "r");
async function resendPendingTaxReversals(env, adapters, now, limit) {
  const pending = await env.DB.prepare(`SELECT r.order_id, r.reference, r.amount, o.payment_provider,
      o.tax_transaction_id FROM _ecommerce_tax_reversals r JOIN _ecommerce_orders o ON o.id = r.order_id
    WHERE r.provider_reversal_id = '' AND r.created_at < ? AND ${REVERSAL_BACKOFF.due}
    ORDER BY ${REVERSAL_BACKOFF.order} LIMIT ?`).bind(now - REVERSAL_IN_FLIGHT_SECONDS, now, limit).all();
  return attemptEach(pending.results ?? [], (row) => row.order_id, async (row) => {
    await sendTaxReversal(env, taxProvider(adapters, row.payment_provider), {
      orderId: row.order_id,
      transactionId: row.tax_transaction_id,
      reference: row.reference,
      amount: row.amount
    }, now);
    return "tax_reversed";
  });
}
var REFUNDED_ORDER_TAX_BACKOFF = backoffSql("tax_sync", "o");
async function reverseUnreversedTax(env, adapters, now, limit) {
  const rows = await env.DB.prepare(`SELECT o.id FROM _ecommerce_orders o
    WHERE o.status IN ('partially_refunded', 'refunded') AND o.tax_transaction_id IS NOT NULL
      AND ${REVERSAL_TARGET} > ${REVERSED} AND ${REFUNDED_ORDER_TAX_BACKOFF.due}
    ORDER BY ${REFUNDED_ORDER_TAX_BACKOFF.order} LIMIT ?`).bind(now, limit).all();
  return attemptEach(
    rows.results ?? [],
    (row) => row.id,
    async (row) => await reverseOrderTax(env, adapters, row.id, now) ? "tax_reversed" : "unchanged"
  );
}

// src/disputes.ts
import { eq as eq2 } from "drizzle-orm";
import { createDbClient as createDbClient2 } from "talisman-cms/client";
function parseStripeDispute(data, eventTime) {
  const paymentIntentId = typeof data?.payment_intent === "string" ? data.payment_intent : data?.payment_intent?.id;
  if (typeof data?.id !== "string" || !data.id || typeof paymentIntentId !== "string" || !paymentIntentId) return null;
  return {
    id: data.id.slice(0, 255),
    paymentIntentId,
    amountCents: Number.isSafeInteger(data.amount) && data.amount >= 0 ? data.amount : 0,
    currency: typeof data.currency === "string" && data.currency ? data.currency.toLowerCase() : null,
    reason: typeof data.reason === "string" && data.reason ? data.reason.slice(0, 100) : null,
    status: typeof data.status === "string" && data.status ? data.status.slice(0, 100) : "unknown",
    createdAt: Number.isSafeInteger(data.created) && data.created > 0 ? data.created : eventTime
  };
}
var openBefore = (column) => `(SELECT d.status_before FROM _ecommerce_disputes d
  WHERE d.${column} = r.id AND d.closed_at IS NULL ORDER BY d.created_at, d.id LIMIT 1)`;
var RECORDS = {
  order: {
    column: "order_id",
    table: "_ecommerce_orders",
    statusBefore: `CASE WHEN r.status = 'disputed' THEN COALESCE(${openBefore("order_id")}, 'paid') ELSE r.status END`
  },
  purchase: {
    column: "gift_card_purchase_id",
    table: "_ecommerce_gift_card_purchases",
    statusBefore: `COALESCE(CASE WHEN r.status = 'review' THEN ${openBefore("gift_card_purchase_id")} END, r.status)`
  }
};
function recordStatement(env, dispute, record, times) {
  const { column, table, statusBefore } = RECORDS[record.kind];
  return env.DB.prepare(`INSERT INTO _ecommerce_disputes
    (id, provider, ${column}, amount_cents, currency, reason, status, status_before, created_at, updated_at, closed_at)
    SELECT ?, 'stripe', r.id, ?, ?, ?, ?, ${statusBefore}, ?, ?, ?
    FROM ${table} r WHERE r.id = ?
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, amount_cents = excluded.amount_cents,
      currency = excluded.currency, reason = COALESCE(excluded.reason, _ecommerce_disputes.reason),
      updated_at = excluded.updated_at, closed_at = COALESCE(_ecommerce_disputes.closed_at, excluded.closed_at)
    WHERE excluded.closed_at IS NOT NULL AND _ecommerce_disputes.status <> 'lost'`).bind(
    dispute.id,
    dispute.amountCents,
    dispute.currency ?? record.currency,
    dispute.reason,
    dispute.status,
    dispute.createdAt,
    times.now,
    times.closedAt,
    record.id
  );
}
async function referralStatements(env, order, now, disputeLost = false) {
  if (!order.referralCode) return [];
  const policy = await getReferralPolicy(env);
  return referralReversalStatements(env, order.id, { minOrderCents: policy.minOrderCents, now, disputeLost });
}
async function orderBatch(env, orderId, statements) {
  const results = await env.DB.batch([
    ...statements,
    env.DB.prepare(`SELECT status FROM _ecommerce_orders WHERE id = ?`).bind(orderId)
  ]);
  return results[results.length - 1]?.results?.[0]?.status ?? null;
}
async function openOrderDispute(env, order, dispute, now) {
  return orderBatch(env, order.id, [
    recordStatement(env, dispute, { kind: "order", id: order.id, currency: order.currency }, { closedAt: null, now }),
    env.DB.prepare(`UPDATE _ecommerce_orders SET status = 'disputed', updated_at = ?
      WHERE id = ? AND status IN ('paid', 'fulfilled', 'partially_refunded')
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ? AND order_id = ? AND closed_at IS NULL)`).bind(now, order.id, dispute.id, order.id)
  ]);
}
async function settleLostOrderDispute(env, order, record, disputeId, now) {
  return orderBatch(env, order.id, [
    record,
    env.DB.prepare(`UPDATE _ecommerce_orders SET status = 'refunded', updated_at = ?
      WHERE id = ? AND status IN ('paid', 'fulfilled', 'partially_refunded', 'disputed')
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ? AND order_id = ? AND status = 'lost')`).bind(now, order.id, disputeId, order.id),
    env.DB.prepare(`UPDATE _ecommerce_payments SET status = 'refunded'
      WHERE order_id = ? AND provider = 'stripe'
        AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'refunded')`).bind(order.id, order.id),
    ...fullRefundStatements(env, order.id, now),
    ...await referralStatements(env, order, now, true)
  ]);
}
async function closeOrderDispute(env, order, dispute, closedAt, now) {
  const record = recordStatement(
    env,
    dispute,
    { kind: "order", id: order.id, currency: order.currency },
    { closedAt, now }
  );
  if (dispute.status === "lost") return settleLostOrderDispute(env, order, record, dispute.id, now);
  return orderBatch(env, order.id, [
    record,
    env.DB.prepare(`UPDATE _ecommerce_orders SET status = CASE
        WHEN total_amount > 0 AND provider_refunded_cents >= total_amount THEN 'refunded'
        WHEN provider_refunded_cents > 0 THEN 'partially_refunded'
        ELSE (SELECT status_before FROM _ecommerce_disputes WHERE id = ?) END,
      updated_at = ?
      WHERE id = ? AND status = 'disputed'
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ? AND order_id = ? AND status <> 'lost')
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE order_id = ? AND closed_at IS NULL)`).bind(dispute.id, now, order.id, dispute.id, order.id, order.id),
    // The previous release copies the order's status onto its payment when it sees a refund, so a
    // rollback during the dispute can leave the payment 'disputed', which reports leave out.
    env.DB.prepare(`UPDATE _ecommerce_payments SET status = CASE o.status
        WHEN 'refunded' THEN 'refunded' WHEN 'partially_refunded' THEN 'partially_refunded' ELSE 'success' END
      FROM _ecommerce_orders o
      WHERE _ecommerce_payments.order_id = o.id AND o.id = ? AND o.status <> 'disputed'
        AND _ecommerce_payments.provider = 'stripe' AND _ecommerce_payments.status = 'disputed'`).bind(order.id),
    ...fullRefundStatements(env, order.id, now),
    ...await referralStatements(env, order, now)
  ]);
}
async function openPurchaseDispute(env, purchase, dispute, now) {
  await env.DB.batch([
    recordStatement(
      env,
      dispute,
      { kind: "purchase", id: purchase.id, currency: purchase.currency },
      { closedAt: null, now }
    ),
    env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = 'review', updated_at = ?
      WHERE id = ? AND status IN ('paid', 'partially_refunded', 'refunded')
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ? AND gift_card_purchase_id = ? AND closed_at IS NULL)`).bind(now, purchase.id, dispute.id, purchase.id),
    ...giftCardPurchaseHoldStatements(env, purchase.id, now)
  ]);
}
async function closePurchaseDispute(env, purchase, dispute, closedAt, now) {
  const record = recordStatement(
    env,
    dispute,
    { kind: "purchase", id: purchase.id, currency: purchase.currency },
    { closedAt, now }
  );
  if (dispute.status === "lost") {
    await env.DB.batch([
      record,
      // Held first, so nothing more is spent from the cards while a checkout in progress delays the void.
      env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = 'review', updated_at = ?
        WHERE id = ? AND status IN ('paid', 'partially_refunded', 'refunded')`).bind(now, purchase.id),
      ...giftCardPurchaseHoldStatements(env, purchase.id, now),
      ...giftCardPurchaseChargebackStatements(env, purchase.id, now)
    ]);
    const current = await createDbClient2(env).select({ status: giftCardPurchases.status }).from(giftCardPurchases).where(eq2(giftCardPurchases.id, purchase.id)).get();
    if (current?.status === "review") {
      throw new WebhookRetryLaterError("A checkout in progress holds value on the disputed purchase's card; the lost dispute is applied once it completes or expires");
    }
    return;
  }
  await env.DB.batch([
    record,
    env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = CASE
        WHEN provider_refunded_cents > refund_adjusted_cents THEN 'review'
        WHEN d.status_before IN ('paid', 'partially_refunded', 'refunded') THEN d.status_before
        WHEN provider_refunded_cents >= amount_cents THEN 'refunded'
        WHEN provider_refunded_cents > 0 THEN 'partially_refunded'
        ELSE 'paid' END,
      updated_at = ?
      FROM (SELECT status_before FROM _ecommerce_disputes WHERE id = ? AND status <> 'lost') AS d
      WHERE id = ? AND status = 'review'
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE gift_card_purchase_id = ? AND closed_at IS NULL)`).bind(now, dispute.id, purchase.id, purchase.id),
    ...giftCardPurchaseReleaseStatements(env, purchase.id, now)
  ]);
}
async function applyStripeDispute(env, dispute, options) {
  const db = createDbClient2(env);
  const now = options.now ?? Math.floor(Date.now() / 1e3);
  const order = await db.select({ id: orders.id, currency: orders.currency, referralCode: orders.referralCode }).from(orders).where(eq2(orders.paymentIntentId, dispute.paymentIntentId)).get();
  if (order) {
    const status = options.closed ? await closeOrderDispute(env, order, dispute, options.at, now) : await openOrderDispute(env, order, dispute, now);
    return { orderId: order.id, status };
  }
  const purchase = await db.select({ id: giftCardPurchases.id, currency: giftCardPurchases.currency }).from(giftCardPurchases).where(eq2(giftCardPurchases.paymentIntentId, dispute.paymentIntentId)).get();
  if (purchase) {
    if (options.closed) await closePurchaseDispute(env, purchase, dispute, options.at, now);
    else await openPurchaseDispute(env, purchase, dispute, now);
    return { purchaseId: purchase.id };
  }
  return null;
}

// src/api.ts
var PARKED_CHECKOUT_MESSAGE = "The store is reviewing the payment for this checkout. Contact the store to release it.";
var RESERVATION_ROWS = `SELECT json_extract(value, '$.target') AS target, json_extract(value, '$.amount') AS amount
  FROM json_each(?)`;
var QUERY_ID_CHUNK = 90;
var at = (seconds) => new Date(seconds * 1e3);
function chunked(values, size = QUERY_ID_CHUNK) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}
var CART_MAX_LINES = 50;
var CART_MAX_LINE_QUANTITY = 99;
var CART_ID_MAX_LENGTH = 128;
var cartItemKey = (item) => `${item.productId}\0${item.variantId || ""}`;
function assertCartItems(items) {
  if (!Array.isArray(items)) throw new Error("Cart items must be an array");
  if (items.length > CART_MAX_LINES) throw new Error(`Cart items must not exceed ${CART_MAX_LINES} lines`);
  if (items.some(
    (item) => !item || typeof item.productId !== "string" || !item.productId.trim() || item.productId.length > CART_ID_MAX_LENGTH || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > CART_MAX_LINE_QUANTITY || item.variantId !== void 0 && (typeof item.variantId !== "string" || item.variantId.length > CART_ID_MAX_LENGTH)
  )) {
    throw new Error(`Cart items must have a product and a whole-number quantity from 1 to ${CART_MAX_LINE_QUANTITY}`);
  }
  const itemKeys = items.map(cartItemKey);
  if (new Set(itemKeys).size !== itemKeys.length) {
    throw new Error("Duplicate cart items are not allowed");
  }
}
function aggregateComponentDemand(items) {
  const demand = /* @__PURE__ */ new Map();
  for (const item of items) {
    for (const component of item.components) {
      const current = demand.get(component.id);
      demand.set(component.id, {
        name: component.name,
        quantity: (current?.quantity ?? 0) + item.quantity * component.quantity,
        available: component.available
      });
    }
  }
  return demand;
}
function bindCommerceApi(options) {
  const { env, paymentAdapters = [] } = options;
  const db = createDbClient3(env);
  async function discardCheckoutDiscount(adapter, orderId) {
    if (!adapter?.discardCheckoutDiscount) return;
    try {
      await adapter.discardCheckoutDiscount(orderId);
    } catch (error) {
      console.warn("[commerce] Checkout discount could not be discarded", {
        provider: adapter.providerId,
        name: error instanceof Error ? error.name : typeof error,
        code: typeof error?.code === "string" ? error.code : void 0
      });
    }
  }
  async function loadBasketCatalog(items) {
    const productIds = [...new Set(items.map((item) => String(item.productId)))];
    const variantIds = [...new Set(items.flatMap((item) => item.variantId ? [String(item.variantId)] : []))];
    const slots = (ids) => ids.map(() => "?").join(", ");
    const queries = [];
    for (const ids of chunked(productIds)) {
      queries.push({ kind: "products", statement: env.DB.prepare(`SELECT id, name, status, type, base_price,
        inventory_quantity, is_physical FROM _ecommerce_products WHERE id IN (${slots(ids)})`).bind(...ids) });
      queries.push({ kind: "groups", statement: env.DB.prepare(`SELECT g.id, g.product_id, g.name, g.price_override,
        g.inventory_quantity, d.name AS definition_name
        FROM _ecommerce_product_variants g LEFT JOIN _ecommerce_variants d ON d.id = g.variant_id
        WHERE g.product_id IN (${slots(ids)})`).bind(...ids) });
    }
    for (const ids of chunked(variantIds)) {
      queries.push({ kind: "values", statement: env.DB.prepare(`SELECT v.id, v.product_variant_id, v.value,
        v.price_override, s.id AS stock_id, s.quantity AS stock_quantity
        FROM _ecommerce_product_variant_values v LEFT JOIN _ecommerce_stocks s ON s.product_variant_value_id = v.id
        WHERE v.id IN (${slots(ids)})`).bind(...ids) });
      queries.push({ kind: "requirements", statement: env.DB.prepare(`SELECT r.product_variant_value_id, r.component_id,
        r.quantity, c.id AS found_component_id, c.name AS component_name, c.quantity AS component_quantity
        FROM _ecommerce_variant_components r LEFT JOIN _ecommerce_components c ON c.id = r.component_id
        WHERE r.product_variant_value_id IN (${slots(ids)})
        ORDER BY r.product_variant_value_id, r.component_id`).bind(...ids) });
      queries.push({ kind: "groupsWithValues", statement: env.DB.prepare(`SELECT DISTINCT product_variant_id
        FROM _ecommerce_product_variant_values WHERE product_variant_id IN (${slots(ids)})`).bind(...ids) });
    }
    const catalog = {
      products: /* @__PURE__ */ new Map(),
      groups: /* @__PURE__ */ new Map(),
      productsWithGroups: /* @__PURE__ */ new Set(),
      groupsWithValues: /* @__PURE__ */ new Set(),
      values: /* @__PURE__ */ new Map(),
      requirements: /* @__PURE__ */ new Map()
    };
    if (!queries.length) return catalog;
    const results = await env.DB.batch(queries.map((query) => query.statement));
    queries.forEach(({ kind }, index) => {
      for (const row of results[index]?.results ?? []) {
        if (kind === "products") {
          catalog.products.set(row.id, {
            id: row.id,
            name: row.name,
            status: row.status,
            type: row.type,
            basePrice: row.base_price,
            inventoryQuantity: row.inventory_quantity,
            isPhysical: Number(row.is_physical) === 1
          });
        } else if (kind === "groups") {
          catalog.groups.set(row.id, {
            id: row.id,
            productId: row.product_id,
            name: row.name,
            definitionName: row.definition_name ?? null,
            priceOverride: row.price_override ?? null,
            inventoryQuantity: row.inventory_quantity
          });
          catalog.productsWithGroups.add(row.product_id);
        } else if (kind === "values") {
          catalog.values.set(row.id, {
            id: row.id,
            groupId: row.product_variant_id,
            value: row.value,
            priceOverride: row.price_override ?? null,
            stock: row.stock_id === null || row.stock_id === void 0 ? null : { id: row.stock_id, quantity: row.stock_quantity }
          });
        } else if (kind === "requirements") {
          const list = catalog.requirements.get(row.product_variant_value_id) ?? [];
          list.push({
            componentId: row.component_id,
            quantity: row.quantity,
            component: row.found_component_id === null || row.found_component_id === void 0 ? null : { id: row.found_component_id, name: row.component_name, quantity: row.component_quantity }
          });
          catalog.requirements.set(row.product_variant_value_id, list);
        } else {
          catalog.groupsWithValues.add(row.product_variant_id);
        }
      }
    });
    return catalog;
  }
  function resolveSelectedVariant(catalog, product, variantId) {
    const variantValue = catalog.values.get(String(variantId));
    if (variantValue) {
      const productVariant = catalog.groups.get(variantValue.groupId);
      if (!productVariant || productVariant.productId !== product.id) {
        throw new Error(`Variant value not found or mismatch: ${variantId}`);
      }
      const stock = variantValue.stock;
      const components = [];
      for (const requirement of catalog.requirements.get(variantValue.id) ?? []) {
        const component = requirement.component;
        if (!component) throw new Error(`Component not found: ${requirement.componentId}`);
        components.push({
          id: component.id,
          name: component.name,
          quantity: requirement.quantity,
          available: component.quantity
        });
      }
      return {
        price: variantValue.priceOverride ?? productVariant.priceOverride ?? product.basePrice,
        name: `${product.name} - ${productVariant.definitionName ?? productVariant.name}: ${variantValue.value}`,
        availableQuantity: components.length ? Math.min(...components.map((component) => Math.floor(component.available / component.quantity))) : stock?.quantity ?? productVariant.inventoryQuantity,
        inventoryTarget: components.length ? null : stock ? { type: "stock", id: stock.id } : { type: "variant", id: productVariant.id },
        components
      };
    }
    const legacyVariant = catalog.groups.get(String(variantId));
    if (!legacyVariant || legacyVariant.productId !== product.id) {
      throw new Error(`Variant not found or mismatch: ${variantId}`);
    }
    if (catalog.groupsWithValues.has(legacyVariant.id)) throw new Error(`Select an option for ${product.name}`);
    return {
      price: legacyVariant.priceOverride ?? product.basePrice,
      name: `${product.name} - ${legacyVariant.name}`,
      availableQuantity: legacyVariant.inventoryQuantity,
      inventoryTarget: { type: "variant", id: legacyVariant.id },
      components: []
    };
  }
  function requireVariantChoice(catalog, product, variantId) {
    if (variantId) return;
    if (catalog.productsWithGroups.has(product.id)) throw new Error(`Select an option for ${product.name}`);
  }
  async function checkCartItems(items, current = []) {
    assertCartItems(items);
    const currentKeys = new Set(current.map(cartItemKey));
    const added = items.filter((item) => !currentKeys.has(cartItemKey(item)));
    const productIds = [...new Set(added.map((item) => item.productId))];
    const available = new Set(productIds.length ? (await db.select({ id: products.id, status: products.status }).from(products).where(inArray(products.id, productIds))).filter((product) => product.status !== "archived").map((product) => product.id) : []);
    const unknownProduct = added.find((item) => !available.has(item.productId));
    if (unknownProduct) throw new Error(`Cart items must be catalog products; ${unknownProduct.productId} is not available`);
    const variantIds = [...new Set(added.flatMap((item) => item.variantId ? [item.variantId] : []))];
    if (variantIds.length) {
      const groups = await db.select({ id: productVariants.id, productId: productVariants.productId }).from(productVariants).where(inArray(productVariants.id, variantIds));
      const groupsWithValues = new Set(groups.length ? (await db.selectDistinct({ id: productVariantValues.productVariantId }).from(productVariantValues).where(inArray(productVariantValues.productVariantId, groups.map((group) => group.id)))).map((value) => value.id) : []);
      const owners = new Map(groups.filter((group) => !groupsWithValues.has(group.id)).map((group) => [group.id, group.productId]));
      const choices = new Map(groups.filter((group) => groupsWithValues.has(group.id)).map((group) => [group.id, group.productId]));
      for (const value of await db.select({ id: productVariantValues.id, productId: productVariants.productId }).from(productVariantValues).innerJoin(productVariants, eq3(productVariants.id, productVariantValues.productVariantId)).where(inArray(productVariantValues.id, variantIds))) {
        owners.set(value.id, value.productId);
      }
      const unchosenGroup = added.find((item) => item.variantId && choices.get(item.variantId) === item.productId);
      if (unchosenGroup) throw new Error(`Cart items must choose one of the variants of ${unchosenGroup.productId}`);
      const unknownVariant = added.find((item) => item.variantId && owners.get(item.variantId) !== item.productId);
      if (unknownVariant) throw new Error(`Cart items must use a variant of their product; ${unknownVariant.variantId} is not available`);
    }
    const withoutVariant = [...new Set(added.flatMap((item) => item.variantId ? [] : [item.productId]))];
    if (withoutVariant.length) {
      const withGroups = new Set((await db.selectDistinct({ productId: productVariants.productId }).from(productVariants).where(inArray(productVariants.productId, withoutVariant))).map((variant) => variant.productId));
      const unchosen = added.find((item) => !item.variantId && withGroups.has(item.productId));
      if (unchosen) throw new Error(`Cart items must choose one of the variants of ${unchosen.productId}`);
    }
    return items.map(({ productId, variantId, quantity }) => variantId ? { productId, variantId, quantity } : { productId, quantity });
  }
  async function finalizeOrderPayment(params) {
    const order = await db.select().from(orders).where(eq3(orders.id, params.orderId)).get();
    if (!order) {
      throw new Error(`Order not found: ${params.orderId}`);
    }
    if (params.paymentStatus !== "success") {
      throw new Error("Payment has not succeeded");
    }
    if (order.checkoutSessionId !== params.providerId || (order.paymentProvider ?? "stripe") !== params.provider) {
      throw new WebhookMismatchError("session_mismatch", "Payment provider or session does not match order");
    }
    if (params.amount !== void 0 && params.amount !== order.totalAmount) {
      throw new WebhookMismatchError("amount_mismatch", "Payment amount does not match order total");
    }
    if (params.currency && params.currency.toLowerCase() !== order.currency.toLowerCase()) {
      throw new WebhookMismatchError("currency_mismatch", "Payment currency does not match order");
    }
    if (PURCHASED_ORDER_STATUSES.includes(order.status)) {
      return { success: true, orderId: params.orderId, status: order.status, duplicate: true };
    }
    if (order.status === "cancelled") {
      throw new WebhookMismatchError("order_cancelled", "Cancelled order cannot be paid");
    }
    const timestamp = Math.floor(Date.now() / 1e3);
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const providerEmail = params.customerEmail?.trim() ?? "";
    const email = emailPattern.test(providerEmail) ? providerEmail : (order.customerEmail || "").trim();
    const normalizedEmail = email.toLowerCase();
    const newAccountId = !order.userId && params.provider !== "admin_test" && emailPattern.test(normalizedEmail) ? `acct_${order.id}` : null;
    const accountName = typeof order.shippingAddress?.name === "string" ? order.shippingAddress.name.trim().slice(0, 160) : null;
    const statements = [
      env.DB.prepare(`UPDATE _ecommerce_orders SET status = 'paid', updated_at = ?, customer_email = ?, payment_intent_id = ?
        WHERE id = ? AND status = 'pending' AND checkout_session_id = ? AND total_amount = ?`).bind(timestamp, email, params.paymentIntentId ?? null, params.orderId, params.providerId, order.totalAmount)
    ];
    if (newAccountId) {
      statements.push(env.DB.prepare(`INSERT INTO _ecommerce_customer_accounts
        (id, email, email_normalized, name, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ? FROM _ecommerce_orders
        WHERE id = ? AND status = 'paid' AND checkout_session_id = ?
        ON CONFLICT(email_normalized) DO NOTHING`).bind(newAccountId, email, normalizedEmail, accountName, timestamp, timestamp, params.orderId, params.providerId));
      statements.push(env.DB.prepare(`UPDATE _ecommerce_orders
        SET user_id = (SELECT id FROM _ecommerce_customer_accounts WHERE email_normalized = ?)
        WHERE id = ? AND status = 'paid' AND user_id IS NULL`).bind(normalizedEmail, params.orderId));
    }
    if (order.referralCode && order.referralRewardCents > 0 && params.provider !== "admin_test") {
      const policy = await getReferralPolicy(env);
      const referrer = await db.select({ emailNormalized: customerAccounts.emailNormalized }).from(referralCodes).innerJoin(customerAccounts, eq3(customerAccounts.id, referralCodes.accountId)).where(eq3(referralCodes.code, order.referralCode)).get();
      const buyerAccount = order.userId ? await db.select({ emailNormalized: customerAccounts.emailNormalized }).from(customerAccounts).where(eq3(customerAccounts.id, order.userId)).get() : void 0;
      const checkoutEmail = (order.customerEmail || "").trim().toLowerCase();
      const buyerCanonicals = canonicalEmails([checkoutEmail, normalizedEmail, buyerAccount?.emailNormalized]);
      const referrerCanonical = canonicalEmail(referrer?.emailNormalized);
      if (referrerCanonical && buyerCanonicals.length && !buyerCanonicals.includes(referrerCanonical)) {
        const purchased = PURCHASED_ORDER_STATUSES.map((status) => `'${status}'`).join(", ");
        statements.push(env.DB.prepare(`INSERT INTO _ecommerce_referrals
          (id, code, referrer_account_id, referred_account_id, order_id, reward_cents, currency, status, created_at, updated_at)
          SELECT ?, rc.code, rc.account_id, o.user_id, o.id, ?, o.currency, 'approved', ?, ?
          FROM _ecommerce_orders o
          JOIN _ecommerce_referral_codes rc ON rc.code = o.referral_code
          JOIN _ecommerce_customer_accounts referrer ON referrer.id = rc.account_id
          JOIN _ecommerce_customer_accounts buyer ON buyer.id = o.user_id
          WHERE o.id = ? AND o.status = 'paid' AND rc.account_id <> o.user_id
            AND referrer.email_normalized NOT IN (?, ?, buyer.email_normalized)
            AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders prior
              WHERE prior.id <> o.id AND prior.status IN (${purchased})
                AND COALESCE(prior.payment_provider, 'stripe') <> 'admin_test'
                AND (prior.user_id = o.user_id OR lower(prior.customer_email) IN (?, ?, buyer.email_normalized)
                  OR prior.user_id IN (SELECT id FROM _ecommerce_customer_accounts WHERE email_normalized IN (?, ?))))
            AND NOT ${canonicalPurchaseSql(buyerCanonicals.length)}
            AND (SELECT COUNT(*) FROM _ecommerce_referrals recent
              JOIN _ecommerce_customer_accounts recent_referrer ON recent_referrer.id = recent.referrer_account_id
              WHERE recent.status = 'approved' AND recent.created_at > ?
                AND (recent.referrer_account_id = rc.account_id
                  OR ${canonicalEmailSql("recent_referrer.email_normalized")} = ?)) < ?
          ON CONFLICT DO NOTHING`).bind(
          `ref_${order.id}`,
          order.referralRewardCents,
          timestamp,
          timestamp,
          params.orderId,
          normalizedEmail,
          checkoutEmail,
          normalizedEmail,
          checkoutEmail,
          normalizedEmail,
          checkoutEmail,
          ...canonicalPurchaseParams(buyerCanonicals, params.orderId),
          timestamp - policy.periodDays * 24 * 60 * 60,
          referrerCanonical,
          policy.maxPerPeriod
        ));
      }
    }
    statements.push(
      env.DB.prepare(`UPDATE _ecommerce_discount_redemptions SET status = 'confirmed', updated_at = ?
        WHERE order_id = ? AND status = 'reserved'
          AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'paid')`).bind(timestamp, params.orderId, params.orderId),
      env.DB.prepare(`UPDATE _ecommerce_gift_card_redemptions SET status = 'confirmed', updated_at = ?
        WHERE order_id = ? AND status = 'reserved'
          AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'paid')`).bind(timestamp, params.orderId, params.orderId),
      env.DB.prepare(`UPDATE _ecommerce_carts SET closed = 1, closed_at = ?, updated_at = ?,
        user_id = COALESCE(user_id, (SELECT user_id FROM _ecommerce_orders WHERE id = ?))
        WHERE id = ? AND EXISTS (SELECT 1 FROM _ecommerce_orders
          WHERE id = ? AND status = 'paid' AND checkout_session_id = ?)`).bind(timestamp, timestamp, params.orderId, order.cartId, params.orderId, params.providerId),
      env.DB.prepare(`INSERT INTO _ecommerce_payments
        (id, order_id, provider, provider_id, status, amount, created_at)
        SELECT ?, id, ?, ?, 'success', total_amount, ? FROM _ecommerce_orders
        WHERE id = ? AND status = 'paid' AND checkout_session_id = ?
        ON CONFLICT(provider, provider_id) DO NOTHING`).bind(`pay_${crypto.randomUUID()}`, params.provider, params.providerId, timestamp, params.orderId, params.providerId)
    );
    const confirms = params.provider !== "admin_test";
    if (confirms) {
      statements.push(commerceEmailStatement(env, "order_confirmation", params.orderId, timestamp, {
        sql: `EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'paid' AND checkout_session_id = ?
          AND COALESCE(payment_provider, 'stripe') <> 'admin_test')`,
        params: [params.orderId, params.providerId]
      }));
    }
    await env.DB.batch(statements);
    const current = await db.select().from(orders).where(eq3(orders.id, params.orderId)).get();
    if (current?.status !== "paid") throw new Error("Order is no longer pending");
    if (current.taxCalculationId && !current.taxTransactionId) {
      await recordConfirmedOrderTax(env, paymentAdapters, params.orderId);
    }
    if (confirms) await deliverCommerceEmail(env, "order_confirmation", params.orderId);
    return { success: true, orderId: params.orderId, status: "paid" };
  }
  async function recordProviderRefund(params) {
    const order = await db.select().from(orders).where(eq3(orders.paymentIntentId, params.paymentIntentId)).get();
    if (!order) return null;
    if (order.paymentProvider !== "stripe" || order.totalAmount !== params.amount || order.currency.toLowerCase() !== String(params.currency).toLowerCase() || !Number.isSafeInteger(params.amountRefunded) || params.amountRefunded < 0 || params.amountRefunded > order.totalAmount) {
      throw new WebhookMismatchError("refund_mismatch", "Refund does not match order payment");
    }
    if (params.amountRefunded <= order.providerRefundedCents) {
      return { success: true, orderId: order.id, duplicate: true };
    }
    const now = Math.floor(Date.now() / 1e3);
    const full = params.amountRefunded === order.totalAmount;
    const referralPolicy = order.referralCode ? await getReferralPolicy(env) : null;
    const refundable = `id = ? AND payment_intent_id = ? AND provider_refunded_cents < ?
      AND status IN ('paid', 'fulfilled', 'partially_refunded', 'disputed')`;
    const statements = [
      // First the part of the total that this event adds, read from the stored total under the guard
      // of the update below: a retried or out-of-order event adds no row, and the rows add up to the total.
      env.DB.prepare(`INSERT INTO _ecommerce_provider_refunds
        (id, order_id, provider, provider_refund_id, amount_cents, created_at)
        SELECT ?, id, 'stripe', ?, ? - provider_refunded_cents, ?
        FROM _ecommerce_orders WHERE ${refundable}
        ON CONFLICT(id) DO NOTHING`).bind(
        `prf_${order.id}_${params.amountRefunded}`,
        params.providerRefundId ?? null,
        params.amountRefunded,
        params.refundedAt ?? now,
        order.id,
        params.paymentIntentId,
        params.amountRefunded
      ),
      // A dispute keeps the order disputed; closing it applies the refund status.
      env.DB.prepare(`UPDATE _ecommerce_orders
        SET provider_refunded_cents = ?, status = CASE WHEN status = 'disputed' THEN status ELSE ? END, updated_at = ?
        WHERE ${refundable}`).bind(
        params.amountRefunded,
        full ? "refunded" : "partially_refunded",
        now,
        order.id,
        params.paymentIntentId,
        params.amountRefunded
      ),
      // The payment shows the refund, taken from the amounts while the order is disputed.
      env.DB.prepare(`UPDATE _ecommerce_payments
        SET status = COALESCE((SELECT CASE WHEN o.status IN ('partially_refunded', 'refunded') THEN o.status
            WHEN o.provider_refunded_cents >= o.total_amount THEN 'refunded'
            WHEN o.provider_refunded_cents > 0 THEN 'partially_refunded' END
          FROM _ecommerce_orders o WHERE o.id = ?), status)
        WHERE order_id = ? AND provider = 'stripe'`).bind(order.id, order.id)
    ];
    if (full) statements.push(...fullRefundStatements(env, order.id, now));
    if (referralPolicy) {
      statements.push(...referralReversalStatements(
        env,
        order.id,
        { minOrderCents: referralPolicy.minOrderCents, now }
      ));
    }
    await env.DB.batch(statements);
    return {
      success: true,
      orderId: order.id,
      status: order.status === "disputed" ? "disputed" : full ? "refunded" : "partially_refunded"
    };
  }
  function ignoredEvent(event) {
    console.info("[commerce] Stripe event ignored", { type: event.type, id: event.id });
    return { success: true, event: event.type, ignored: true };
  }
  async function assertNoAwaitedPayment(references) {
    const purchaseId = references?.giftCardPurchaseId || null;
    const orderId = purchaseId ? null : references?.orderId || null;
    const record = purchaseId ? await db.select({ status: giftCardPurchases.status }).from(giftCardPurchases).where(eq3(giftCardPurchases.id, purchaseId)).get() : orderId ? await db.select({ status: orders.status }).from(orders).where(eq3(orders.id, orderId)).get() : void 0;
    if (!record || record.status === "cancelled" || record.status === "draft") return;
    if (record.status === "pending") {
      throw new WebhookRetryLaterError(`The ${purchaseId ? "gift card purchase" : "order"} this payment is for has no recorded payment yet`);
    }
    throw new WebhookMismatchError("payment_not_recorded", "The payment is not the one recorded for the store record it names");
  }
  async function applyStripeEvent(event, stripeAdapter) {
    const text = (value) => typeof value === "string" && value ? value : null;
    const at2 = Number.isSafeInteger(event.created) && event.created > 0 ? event.created : Math.floor(Date.now() / 1e3);
    if (event.type === "checkout.session.completed") {
      const session = event.data;
      if (session.payment_status !== "paid") return ignoredEvent(event);
      const purchaseId = text(session.metadata?.giftCardPurchaseId);
      if (purchaseId) {
        const purchase = await db.select({ id: giftCardPurchases.id }).from(giftCardPurchases).where(eq3(giftCardPurchases.id, purchaseId)).get();
        return purchase ? confirmGiftCardPurchase(env, session) : ignoredEvent(event);
      }
      const orderId = text(session.metadata?.orderId) ?? text(session.client_reference_id);
      const order = orderId ? await db.select({ id: orders.id }).from(orders).where(eq3(orders.id, orderId)).get() : void 0;
      if (!order) return ignoredEvent(event);
      return finalizeOrderPayment({
        orderId: order.id,
        provider: "stripe",
        providerId: session.id,
        paymentStatus: "success",
        amount: session.amount_total || 0,
        currency: session.currency,
        paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : void 0,
        customerEmail: session.customer_details?.email || session.customer_email
      });
    }
    if (event.type === "checkout.session.expired") {
      const session = event.data;
      const purchaseId = text(session.metadata?.giftCardPurchaseId);
      if (purchaseId) {
        const purchase = await db.select({ id: giftCardPurchases.id }).from(giftCardPurchases).where(eq3(giftCardPurchases.id, purchaseId)).get();
        if (!purchase) return ignoredEvent(event);
        await expireGiftCardPurchase(env, purchaseId, session.id);
        return { success: true, event: event.type };
      }
      const orderId = text(session.metadata?.orderId) ?? text(session.client_reference_id);
      if (orderId) {
        const order = await db.select().from(orders).where(eq3(orders.id, orderId)).get();
        if (order?.checkoutSessionId === session.id) {
          const cancelled = await bindCommerceApi(options).orders.cancel(orderId, { sessionExpired: true });
          return { success: true, event: event.type, cancelled: cancelled?.status === "cancelled" };
        }
        if (!order && orderId === text(session.metadata?.orderId) && orderId.startsWith("ord_")) {
          await discardCheckoutDiscount(stripeAdapter, orderId);
          return { success: true, event: event.type, cancelled: false };
        }
      }
      return ignoredEvent(event);
    }
    if (event.type === "charge.refunded") {
      const charge = event.data;
      if (typeof charge.payment_intent !== "string") return ignoredEvent(event);
      const refund = {
        paymentIntentId: charge.payment_intent,
        amount: charge.amount,
        amountRefunded: charge.amount_refunded,
        currency: charge.currency
      };
      const giftPurchaseRefund = await recordGiftCardPurchaseRefund(env, refund);
      if (giftPurchaseRefund) return giftPurchaseRefund;
      const listed = Array.isArray(charge.refunds?.data) ? charge.refunds.data : [];
      const latest = listed.filter((item) => typeof item?.id === "string").sort((a, b) => Number(b.created ?? 0) - Number(a.created ?? 0))[0];
      const recorded = await recordProviderRefund({
        ...refund,
        refundedAt: at2,
        providerRefundId: typeof latest?.id === "string" ? latest.id : null
      });
      if (recorded) {
        await reverseRefundedOrderTax(env, paymentAdapters, recorded.orderId);
        return recorded;
      }
      await assertNoAwaitedPayment({
        orderId: text(charge.metadata?.orderId),
        giftCardPurchaseId: text(charge.metadata?.giftCardPurchaseId)
      });
      return ignoredEvent(event);
    }
    if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") {
      const dispute = parseStripeDispute(event.data, at2);
      if (!dispute) return ignoredEvent(event);
      const applied = await applyStripeDispute(env, dispute, { closed: event.type === "charge.dispute.closed", at: at2 });
      if (applied && "orderId" in applied && applied.status === "refunded") {
        await reverseRefundedOrderTax(env, paymentAdapters, applied.orderId);
      }
      if (applied) return { success: true, event: event.type, ...applied };
      await assertNoAwaitedPayment(await stripeAdapter.getPaymentReferences?.(dispute.paymentIntentId));
      return ignoredEvent(event);
    }
    return ignoredEvent(event);
  }
  return {
    carts: {
      async quote(cartId) {
        const { currency } = readStoreSettings(env);
        const cart = await db.select().from(carts).where(eq3(carts.id, cartId)).get();
        if (!cart) throw new Error("Cart not found");
        const catalog = await loadBasketCatalog(cart.items);
        const lines = [];
        let totalAmount = 0;
        let requiresShipping = false;
        const componentItems = [];
        for (const item of cart.items) {
          const product = catalog.products.get(String(item.productId));
          if (!product || product.status !== "active") throw new Error(`Product is not available: ${item.productId}`);
          requireVariantChoice(catalog, product, item.variantId);
          const variant = item.variantId ? resolveSelectedVariant(catalog, product, item.variantId) : null;
          const unitAmount = variant?.price ?? product.basePrice;
          const name = variant?.name ?? product.name;
          if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0) {
            throw new Error(`A positive price is required for ${name}`);
          }
          if (product.type === "standard" && (variant?.availableQuantity ?? product.inventoryQuantity) < item.quantity) {
            throw new Error(`Insufficient stock for ${name}`);
          }
          if (product.type === "standard" && variant?.components.length) {
            componentItems.push({ quantity: item.quantity, components: variant.components });
          }
          const lineTotal = unitAmount * item.quantity;
          totalAmount += lineTotal;
          requiresShipping ||= product.isPhysical;
          lines.push({ productId: item.productId, variantId: item.variantId, name, quantity: item.quantity, unitAmount, lineTotal });
        }
        for (const demand of aggregateComponentDemand(componentItems).values()) {
          if (demand.available < demand.quantity) throw new Error(`Insufficient stock for component ${demand.name}`);
        }
        if (!Number.isSafeInteger(totalAmount)) throw new Error("Order total is too large");
        return { lines, totalAmount, currency, requiresShipping, locked: Boolean(cart.checkoutSessionId) };
      },
      async find(sessionToken, userId) {
        if (!sessionToken && !userId) return null;
        const conditions = [eq3(carts.closed, false)];
        if (userId) {
          conditions.push(eq3(carts.userId, userId));
        } else if (sessionToken) {
          conditions.push(eq3(carts.sessionToken, sessionToken));
          conditions.push(isNull2(carts.userId));
        }
        return await db.select().from(carts).where(and2(...conditions)).get();
      },
      /** Attach the current browser basket to an authenticated shopper account. */
      async claim(sessionToken, userId, choice) {
        const account = await db.select({ id: customerAccounts.id }).from(customerAccounts).where(eq3(customerAccounts.id, userId)).get();
        if (!account) throw new Error("Customer account not found");
        const guest = await db.select().from(carts).where(and2(eq3(carts.sessionToken, sessionToken), eq3(carts.closed, false))).get();
        const owned = await db.select().from(carts).where(and2(eq3(carts.userId, userId), eq3(carts.closed, false))).get();
        if (guest?.userId === userId) return guest;
        if (guest?.userId) throw new Error("Basket belongs to another account");
        if (guest?.checkoutSessionId) throw new Error("Checkout already started for this cart");
        if (guest && owned && guest.id !== owned.id) {
          if (guest.items.length && owned.items.length) {
            if (!choice) throw new Error("Both baskets have items; choose which basket to keep before linking this session");
          }
          if (owned.checkoutSessionId) throw new Error("Checkout already started for this cart");
          if (guest.items.length && choice !== "account") {
            const released = await db.update(carts).set({ userId: null, updatedAt: /* @__PURE__ */ new Date() }).where(and2(
              eq3(carts.id, owned.id),
              eq3(carts.userId, userId),
              eq3(carts.version, owned.version),
              eq3(carts.closed, false)
            )).returning({ id: carts.id });
            if (!released.length) throw new Error("Basket changed during account upgrade; reload and try again");
          } else {
            const released = await db.update(carts).set({ sessionToken: null, updatedAt: /* @__PURE__ */ new Date() }).where(and2(
              eq3(carts.id, guest.id),
              eq3(carts.sessionToken, sessionToken),
              eq3(carts.version, guest.version),
              eq3(carts.closed, false)
            )).returning({ id: carts.id });
            if (!released.length) throw new Error("Basket changed during account upgrade; reload and try again");
          }
        }
        const target = choice === "account" && owned ? owned : guest?.items.length ? guest : owned ?? guest;
        if (target) {
          if (!guest) {
            await db.update(carts).set({ sessionToken: null }).where(and2(eq3(carts.sessionToken, sessionToken), eq3(carts.closed, true)));
          }
          const updated = await db.update(carts).set({ userId, sessionToken, updatedAt: /* @__PURE__ */ new Date(), version: sql`${carts.version} + 1` }).where(and2(
            eq3(carts.id, target.id),
            eq3(carts.closed, false),
            isNull2(carts.checkoutSessionId),
            eq3(carts.version, target.version)
          )).returning({ id: carts.id });
          if (!updated.length) throw new Error("Basket changed during account upgrade; reload and try again");
          return await db.select().from(carts).where(eq3(carts.id, target.id)).get();
        }
        return null;
      },
      async getOrCreate(sessionToken, userId) {
        if (userId) {
          const claimed = await this.claim(sessionToken, userId);
          if (claimed) return claimed;
        }
        let cart = await this.find(sessionToken, userId);
        if (!cart) {
          if (!userId) {
            await db.update(carts).set({ sessionToken: null }).where(and2(
              eq3(carts.sessionToken, sessionToken),
              eq3(carts.closed, false),
              isNotNull2(carts.userId)
            ));
          }
          await db.update(carts).set({ sessionToken: null }).where(and2(eq3(carts.sessionToken, sessionToken), eq3(carts.closed, true)));
          const cartId = `cart_${crypto.randomUUID()}`;
          const now = /* @__PURE__ */ new Date();
          await db.insert(carts).values({
            id: cartId,
            sessionToken,
            userId,
            checkoutSessionId: null,
            items: [],
            closed: false,
            closedAt: null,
            createdAt: now,
            updatedAt: now
          });
          cart = await this.find(sessionToken, userId);
        }
        return cart;
      },
      /**
       * Check an item list against the basket limits and the catalog without writing, for example
       * before creating a basket for it. Returns the list with only the stored fields.
       */
      async validateItems(items, current = []) {
        return checkCartItems(items, current);
      },
      async updateItems(cartId, items) {
        assertCartItems(items);
        const cart = await db.select().from(carts).where(eq3(carts.id, cartId)).get();
        if (!cart) {
          throw new Error("Cart not found");
        }
        if (cart.closed) {
          throw new Error("Cart is closed");
        }
        if (cart.checkoutSessionId) {
          throw new Error("Checkout already started for this cart");
        }
        const checked = await checkCartItems(items, cart.items);
        const updated = await db.update(carts).set({ items: checked, updatedAt: /* @__PURE__ */ new Date(), version: sql`${carts.version} + 1` }).where(and2(
          eq3(carts.id, cartId),
          eq3(carts.closed, false),
          isNull2(carts.checkoutSessionId),
          eq3(carts.version, cart.version)
        )).returning({ id: carts.id });
        if (!updated.length) throw new Error("Basket changed or checkout already started; reload and try again");
        return await db.select().from(carts).where(eq3(carts.id, cartId)).get();
      }
    },
    orders: {
      /**
       * The pending checkout that locks a basket: its payment URL while the provider session is open,
       * or null once the lock is gone. Public routes pass `limitProviderChecks`, so the provider is asked
       * only when the order's provider-check slot is free (see provider-checks.ts); otherwise the order is
       * returned as stored, with `providerCheckLimited` and no payment URL. An order parked for review, or
       * one whose check failed in a way no retry fixes, is returned with `review` and no payment URL; the
       * provider is not asked about a parked one.
       */
      async resumeFromCart(cartId, options2 = {}) {
        const cart = await db.select().from(carts).where(eq3(carts.id, cartId)).get();
        if (!cart?.checkoutSessionId) return null;
        if (cart.checkoutSessionId.startsWith("preparing:")) {
          const cutoff = Math.floor(Date.now() / 1e3) - 35 * 60;
          await env.DB.prepare(`UPDATE _ecommerce_carts SET checkout_session_id = NULL,
            updated_at = ?, version = version + 1 WHERE id = ? AND checkout_session_id = ?
            AND updated_at < ? AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders
              WHERE cart_id = _ecommerce_carts.id AND status = 'pending')`).bind(Math.floor(Date.now() / 1e3), cartId, cart.checkoutSessionId, cutoff).run();
          return null;
        }
        const order = await db.select().from(orders).where(eq3(orders.checkoutSessionId, cart.checkoutSessionId)).get();
        if (!order || order.status !== "pending") return null;
        if (order.paymentProvider === "gift_card" && order.totalAmount === 0) {
          await finalizeOrderPayment({
            orderId: order.id,
            provider: "gift_card",
            providerId: order.checkoutSessionId,
            paymentStatus: "success",
            amount: 0,
            customerEmail: order.customerEmail ?? void 0
          });
          return { order: await this.find(order.id), paymentUrl: `/checkout/success?order=${encodeURIComponent(order.id)}` };
        }
        if (order.reconcileReviewAt) return { order, paymentUrl: null, review: true };
        if (options2.limitProviderChecks && !await mayAskPaymentProvider(env, order, paymentAdapters)) {
          return { order, paymentUrl: null, providerCheckLimited: true };
        }
        let reconciled;
        try {
          reconciled = await this.reconcilePending(order.id);
        } catch (error) {
          if (reconcileFailure(error).permanent) return { order, paymentUrl: null, review: true };
          throw error;
        }
        if (reconciled?.status === "paid") {
          return { order: await this.find(order.id), paymentUrl: `/checkout/success?order=${encodeURIComponent(order.id)}` };
        }
        if (reconciled?.status === "cancelled") return null;
        return { order, paymentUrl: reconciled?.paymentUrl ?? null };
      },
      async reconcilePending(id) {
        const order = await this.find(id);
        if (!order || order.status !== "pending" || !order.checkoutSessionId) return null;
        if (order.paymentProvider === "gift_card") {
          await finalizeOrderPayment({
            orderId: order.id,
            provider: "gift_card",
            providerId: order.checkoutSessionId,
            paymentStatus: "success",
            amount: 0,
            customerEmail: order.customerEmail ?? void 0
          });
          return { status: "paid", paymentUrl: null };
        }
        if (order.paymentProvider === "admin_test") {
          if (!paymentAdapters.some((candidate) => candidate.providerId === "admin_test")) {
            return { status: "pending", paymentUrl: null };
          }
          await finalizeOrderPayment({
            orderId: order.id,
            provider: "admin_test",
            providerId: order.checkoutSessionId,
            paymentStatus: "success",
            amount: order.totalAmount,
            currency: order.currency
          });
          return { status: "paid", paymentUrl: null };
        }
        if (order.reconcileReviewAt) return { status: "pending", paymentUrl: null, review: true };
        const provider = order.paymentProvider ?? "stripe";
        const adapter = paymentAdapters.find((candidate) => candidate.providerId === provider);
        if (!adapter?.getCheckoutSession) {
          throw new ReconcileFailure("provider_not_configured", "Payment provider cannot reconcile checkout");
        }
        if (provider === "stripe") assertStoreStripeMode(env, order.checkoutSessionId);
        const session = await adapter.getCheckoutSession(order.checkoutSessionId).catch((error) => {
          throw sessionLookupFailure(error);
        });
        if (session.status === "expired") {
          await this.cancel(id, { sessionExpired: true });
          return { status: "cancelled", paymentUrl: null };
        }
        if (session.status === "complete" && session.paymentStatus === "paid") {
          if (session.amountTotal !== order.totalAmount || session.currency?.toLowerCase() !== order.currency.toLowerCase() || provider === "stripe" && !session.paymentIntentId) {
            throw new ReconcileFailure("payment_mismatch", "Completed payment does not match pending order");
          }
          await finalizeOrderPayment({
            orderId: id,
            provider: order.paymentProvider ?? "stripe",
            providerId: order.checkoutSessionId,
            paymentStatus: "success",
            amount: session.amountTotal,
            currency: session.currency,
            paymentIntentId: session.paymentIntentId ?? void 0,
            customerEmail: session.customerEmail ?? void 0
          });
          return { status: "paid", paymentUrl: null };
        }
        return { status: "pending", paymentUrl: session.status === "open" ? session.url : null };
      },
      async createFromCart(cartId, options2) {
        const settings = readStoreSettings(env);
        const { currency, deliveryCountries } = settings;
        const cart = await db.select().from(carts).where(eq3(carts.id, cartId)).get();
        if (!cart || cart.items.length === 0) {
          throw new Error("Cart is empty or not found");
        }
        if (cart.closed) {
          throw new Error("Cart is closed");
        }
        if (cart.checkoutSessionId) {
          throw new Error("Checkout already started for this cart");
        }
        const defaultAdapter = options2.providerId ? paymentAdapters.find((adapter) => adapter.providerId === options2.providerId) : paymentAdapters.length === 1 && paymentAdapters[0].providerId !== "admin_test" ? paymentAdapters[0] : void 0;
        if (!defaultAdapter) throw new Error("A payment provider must be selected and configured before checkout");
        let requiresShipping = false;
        let totalAmount = 0;
        const orderItems = [];
        const componentItems = [];
        const inventoryDemand = /* @__PURE__ */ new Map();
        const catalog = await loadBasketCatalog(cart.items);
        for (const item of cart.items) {
          const product = catalog.products.get(String(item.productId));
          if (!product) {
            throw new Error(`Product not found: ${item.productId}`);
          }
          if (product.status !== "active") {
            throw new Error(`Product is not available: ${item.productId}`);
          }
          requireVariantChoice(catalog, product, item.variantId);
          let price = product.basePrice;
          let finalName = product.name;
          let availableQuantity = product.inventoryQuantity;
          let requiredComponents = [];
          let inventoryTarget = { type: "product", id: product.id };
          if (item.variantId) {
            const selectedVariant = resolveSelectedVariant(catalog, product, item.variantId);
            price = selectedVariant.price;
            finalName = selectedVariant.name;
            availableQuantity = selectedVariant.availableQuantity;
            requiredComponents = selectedVariant.components;
            inventoryTarget = selectedVariant.inventoryTarget;
          }
          if (product.isPhysical) {
            requiresShipping = true;
          }
          const tracksInventory = product.type === "standard";
          if (tracksInventory && availableQuantity < item.quantity) {
            throw new Error(`Insufficient stock for ${finalName}`);
          }
          if (tracksInventory && requiredComponents.length) {
            componentItems.push({ quantity: item.quantity, components: requiredComponents });
          } else if (tracksInventory && inventoryTarget) {
            const key = `${inventoryTarget.type}:${inventoryTarget.id}`;
            const existing = inventoryDemand.get(key);
            inventoryDemand.set(key, { ...inventoryTarget, quantity: (existing?.quantity ?? 0) + item.quantity });
          }
          if (!Number.isSafeInteger(price) || price <= 0) {
            throw new Error(`A positive price is required for ${finalName}`);
          }
          totalAmount += price * item.quantity;
          if (!Number.isSafeInteger(totalAmount)) throw new Error("Order total is too large");
          orderItems.push({
            ...item,
            priceAtPurchase: price,
            name: finalName,
            usesComponents: tracksInventory && requiredComponents.length > 0
          });
        }
        const componentDemand = aggregateComponentDemand(componentItems);
        for (const component of componentDemand.values()) {
          if (component.available < component.quantity) {
            throw new Error(`Insufficient stock for component ${component.name}`);
          }
        }
        if (requiresShipping && (!options2.shippingAddress || !["name", "line1", "city", "postalCode", "country"].every((key) => typeof options2.shippingAddress[key] === "string" && options2.shippingAddress[key].trim()))) {
          throw new Error("Shipping address is required for physical products");
        }
        const shippingAddress = withCountryCode(options2.shippingAddress);
        const billingAddress = withCountryCode(options2.billingAddress);
        if (requiresShipping && deliveryCountries && !deliveryCountries.includes(shippingAddress.country)) {
          throw new Error(UNDELIVERABLE_COUNTRY);
        }
        const shippingRate = requiresShipping && settings.shippingRates.length ? chooseShippingRate(settings, shippingAddress.country, options2.shippingRateId) : null;
        const taxBehavior = settings.tax.mode === "none" || defaultAdapter.providerId === "admin_test" ? null : settings.tax.mode === "stripe-inclusive" ? "inclusive" : "exclusive";
        const taxAddress = taxBehavior ? taxAddressFor(requiresShipping, shippingAddress, billingAddress) : null;
        const orderId = `ord_${crypto.randomUUID()}`;
        const referralsPolicy = await getReferralPolicy(env);
        const subtotalAmount = totalAmount;
        const discount = options2.discountCode && defaultAdapter.providerId === "stripe" ? await evaluateDiscountCode(env, {
          code: options2.discountCode,
          customerEmail: options2.customerEmail,
          accountId: cart.userId,
          lines: orderItems,
          subtotal: subtotalAmount
        }) : null;
        const discountAmount = discount?.amount ?? 0;
        const merchandise = subtotalAmount - discountAmount;
        const shippingAmount = shippingRate ? shippingCharge(shippingRate, merchandise) : 0;
        let creditApplied = 0;
        const owner = cart.userId ? await db.select({
          creditBalance: customerAccounts.creditBalance,
          emailNormalized: customerAccounts.emailNormalized
        }).from(customerAccounts).where(eq3(customerAccounts.id, cart.userId)).get() : void 0;
        if (owner && defaultAdapter.providerId === "stripe") {
          creditApplied = Math.min(
            Math.max(0, owner.creditBalance),
            merchandise,
            Math.max(0, merchandise + shippingAmount - minimumChargeAmount(currency))
          );
        }
        const tax = taxBehavior && taxAddress ? await calculateOrderTax(defaultAdapter, {
          cartId,
          currency,
          behavior: taxBehavior,
          settings: settings.tax,
          shippingAmount,
          ...taxAddress,
          lines: taxableLines(
            orderItems,
            { amount: discountAmount, productIds: discount?.eligibleProductIds ?? [] },
            creditApplied
          )
        }) : null;
        const exclusiveTax = tax?.behavior === "exclusive" ? tax.amount : 0;
        const amountDue = merchandise - creditApplied + shippingAmount + exclusiveTax;
        if (!Number.isSafeInteger(amountDue)) throw new Error("Order total is too large");
        const giftCard = options2.giftCardCode && defaultAdapter.providerId === "stripe" ? await evaluateGiftCard(env, options2.giftCardCode, amountDue) : null;
        const giftCardApplied = giftCard?.amount ?? 0;
        totalAmount = amountDue - giftCardApplied;
        const internallyPaid = Boolean(giftCard && totalAmount === 0);
        let referralCode = null;
        if (referralsPolicy.enabled && options2.referralCode && defaultAdapter.providerId === "stripe" && !internallyPaid && subtotalAmount - discountAmount >= referralsPolicy.minOrderCents) {
          const referral = await findReferralCode(env, options2.referralCode);
          const buyerEmails = [options2.customerEmail.trim().toLowerCase(), owner?.emailNormalized];
          const referrerCanonical = canonicalEmail(referral?.emailNormalized);
          if (referral && referrerCanonical && referral.accountId !== cart.userId && !buyerEmails.includes(referral.emailNormalized) && !canonicalEmails(buyerEmails).includes(referrerCanonical) && !await hasPurchaseHistory(env, { emails: buyerEmails, accountIds: [cart.userId] }) && !await hasCanonicalPurchase(env, buyerEmails)) {
            referralCode = referral.code;
          }
        }
        if (!defaultAdapter.expireCheckoutSession) {
          throw new Error("Payment provider must support checkout session expiry");
        }
        const successUrl = options2.successUrl.replaceAll("{ORDER_ID}", orderId);
        const cancelUrl = options2.cancelUrl.replaceAll("{ORDER_ID}", orderId);
        const now = /* @__PURE__ */ new Date();
        const timestamp = Math.floor(now.getTime() / 1e3);
        const preparationLock = `preparing:${orderId}`;
        const lock = await db.update(carts).set({ checkoutSessionId: preparationLock, updatedAt: now, version: sql`${carts.version} + 1` }).where(and2(
          eq3(carts.id, cartId),
          eq3(carts.closed, false),
          isNull2(carts.checkoutSessionId),
          eq3(carts.items, cart.items),
          eq3(carts.version, cart.version)
        )).returning({ id: carts.id });
        if (!lock.length) throw new Error("Checkout already started for this cart");
        let session;
        let committed = false;
        let providerDiscount = false;
        try {
          providerDiscount = !internallyPaid && creditApplied + discountAmount + giftCardApplied > 0;
          session = internallyPaid ? { providerSessionId: `internal:${orderId}`, url: successUrl } : await defaultAdapter.createCheckoutSession({
            orderId,
            currency,
            items: orderItems.map((i) => ({
              name: i.name,
              priceCents: i.priceAtPurchase,
              quantity: i.quantity
            })),
            customerEmail: options2.customerEmail,
            creditApplied,
            discountApplied: discountAmount,
            giftCardApplied,
            shipping: shippingRate ? {
              label: shippingRate.label,
              amount: shippingAmount,
              description: deliveryEstimate(shippingRate) ?? void 0
            } : void 0,
            tax: exclusiveTax > 0 ? { amount: exclusiveTax } : void 0,
            metadata: {
              giftCardApplied: String(giftCardApplied),
              storeCreditApplied: String(creditApplied),
              promotionDiscount: String(discountAmount)
            },
            successUrl,
            cancelUrl
          });
          if (!session.providerSessionId || !session.url) throw new Error("Payment provider did not return a checkout session");
          const checkoutSessionId = session.providerSessionId;
          const statements = [
            env.DB.prepare(`INSERT INTO _ecommerce_orders
             (id, cart_id, user_id, checkout_session_id, payment_provider, status, items, total_amount, subtotal_amount, credit_applied, discount_code, discount_amount, gift_card_id, gift_card_applied, referral_code, referral_reward_cents, currency,
              shipping_amount, shipping_rate_id, shipping_label, tax_amount, tax_behavior, tax_calculation_id,
              customer_email, shipping_address, billing_address, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) `).bind(
              orderId,
              cartId,
              cart.userId,
              checkoutSessionId,
              internallyPaid ? "gift_card" : defaultAdapter.providerId,
              JSON.stringify(orderItems.map(({ name, ...rest }) => rest)),
              totalAmount,
              subtotalAmount,
              creditApplied,
              discount?.code ?? null,
              discountAmount,
              giftCard?.id ?? null,
              giftCardApplied,
              referralCode,
              referralCode ? referralsPolicy.rewardCents : 0,
              currency,
              shippingAmount,
              shippingRate?.id ?? null,
              shippingRate?.label ?? null,
              tax?.amount ?? 0,
              tax?.behavior ?? null,
              tax?.calculationId ?? null,
              options2.customerEmail,
              shippingAddress ? JSON.stringify(shippingAddress) : null,
              billingAddress ? JSON.stringify(billingAddress) : null,
              timestamp,
              timestamp
            )
          ];
          if (discount) {
            statements.push(env.DB.prepare(`INSERT INTO _ecommerce_discount_redemptions
             (id, code, order_id, account_id, email_normalized, amount_cents, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`).bind(
              `dred_${orderId}`,
              discount.code,
              orderId,
              cart.userId,
              discount.emailNormalized,
              discount.amount,
              timestamp,
              timestamp
            ));
          }
          if (giftCard) {
            statements.push(env.DB.prepare(`INSERT INTO _ecommerce_gift_card_redemptions
             (id,card_id,order_id,amount_cents,status,created_at,updated_at)
             VALUES (?,?,?,?,'reserved',?,?)`).bind(`gcr_${orderId}`, giftCard.id, orderId, giftCardApplied, timestamp, timestamp));
          }
          if (creditApplied && cart.userId) {
            statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
             (id, account_id, order_id, kind, amount_cents, created_at)
             VALUES (?, ?, ?, 'checkout_reserve', ?, ?)`).bind(`credit_hold_${orderId}`, cart.userId, orderId, -creditApplied, timestamp));
          }
          const reserves = defaultAdapter.reservesInventory !== false;
          const componentReservations2 = reserves ? [...componentDemand].map(([target, demand]) => ({ id: crypto.randomUUID(), target, amount: demand.quantity })) : [];
          if (componentReservations2.length) {
            const list = JSON.stringify(componentReservations2);
            statements.push(env.DB.prepare(`UPDATE _ecommerce_components
             SET quantity = quantity - demand.amount, updated_at = MAX(updated_at + 1, ?)
             FROM (${RESERVATION_ROWS}) AS demand WHERE _ecommerce_components.id = demand.target`).bind(timestamp, list));
            statements.push(env.DB.prepare(`INSERT INTO _ecommerce_component_reservations
             (id, order_id, component_id, quantity)
             SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.target'), json_extract(value, '$.amount')
             FROM json_each(?)`).bind(orderId, list));
          }
          const inventoryReservations2 = reserves ? [...inventoryDemand.values()].map((demand) => ({ id: crypto.randomUUID(), type: demand.type, target: demand.id, amount: demand.quantity })) : [];
          for (const [type, [table, column]] of Object.entries(INVENTORY_COLUMNS)) {
            const list = inventoryReservations2.filter((reservation) => reservation.type === type);
            if (!list.length) continue;
            statements.push(env.DB.prepare(`UPDATE ${table}
             SET ${column} = ${column} - demand.amount, updated_at = MAX(updated_at + 1, ?)
             FROM (${RESERVATION_ROWS}) AS demand WHERE ${table}.id = demand.target`).bind(timestamp, JSON.stringify(list)));
          }
          if (inventoryReservations2.length) {
            statements.push(env.DB.prepare(`INSERT INTO _ecommerce_inventory_reservations
             (id, order_id, target_type, target_id, quantity)
             SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.type'), json_extract(value, '$.target'),
               json_extract(value, '$.amount')
             FROM json_each(?)`).bind(orderId, JSON.stringify(inventoryReservations2)));
          }
          statements.push(env.DB.prepare(`UPDATE _ecommerce_carts SET checkout_session_id = ?, updated_at = ?
           WHERE id = ? AND checkout_session_id = ?`).bind(checkoutSessionId, timestamp, cartId, preparationLock));
          try {
            await env.DB.batch(statements);
            committed = true;
          } catch (cause) {
            if (cause instanceof Error && cause.message.includes("Discount code is no longer available")) {
              throw new Error("Discount code is no longer available", { cause });
            }
            if (cause instanceof Error && cause.message.includes("Insufficient store credit")) {
              throw new Error("Store credit changed during checkout; please try again", { cause });
            }
            if (cause instanceof Error && cause.message.includes("Gift card is no longer available")) {
              throw new Error("Gift card is no longer available", { cause });
            }
            throw new Error("Insufficient stock or checkout already started", { cause });
          }
          const order = await this.find(orderId);
          if (!order) throw new Error("Checkout was created but the order could not be loaded");
          if (internallyPaid) {
            await finalizeOrderPayment({
              orderId,
              provider: "gift_card",
              providerId: checkoutSessionId,
              paymentStatus: "success",
              amount: 0,
              customerEmail: options2.customerEmail
            });
            return { order: await this.find(orderId), paymentUrl: session.url };
          }
          return { order, paymentUrl: session.url };
        } catch (error) {
          if (committed) throw error;
          try {
            if (session?.providerSessionId && !internallyPaid) {
              await defaultAdapter.expireCheckoutSession(session.providerSessionId);
            }
          } finally {
            if (providerDiscount) await discardCheckoutDiscount(defaultAdapter, orderId);
          }
          await db.update(carts).set({ checkoutSessionId: null }).where(and2(eq3(carts.id, cartId), eq3(carts.checkoutSessionId, preparationLock)));
          throw error;
        }
      },
      async create(data) {
        const orderId = data.id || `ord_${Date.now()}`;
        const now = /* @__PURE__ */ new Date();
        await db.insert(orders).values({
          id: orderId,
          cartId: data.cartId,
          userId: data.userId,
          checkoutSessionId: data.checkoutSessionId,
          paymentProvider: null,
          status: data.status || "draft",
          totalAmount: data.totalAmount,
          currency: data.currency || readStoreSettings(env).currency,
          customerEmail: data.customerEmail,
          items: data.items,
          shippingAddress: data.shippingAddress,
          billingAddress: data.billingAddress,
          createdAt: now,
          updatedAt: now
        });
        return await this.find(orderId);
      },
      async find(id) {
        const order = await db.select().from(orders).where(eq3(orders.id, id)).get();
        if (!order) return null;
        return order;
      },
      async findForSession(id, sessionToken, customerId) {
        const order = await this.find(id);
        if (!order?.cartId) return null;
        if (customerId && order.userId === customerId) return order;
        if (!sessionToken) return null;
        const cart = await db.select().from(carts).where(eq3(carts.id, order.cartId)).get();
        return cart?.sessionToken === sessionToken ? order : null;
      },
      /**
       * 'fulfilled' records a shipment that completes the order: it sets `fulfillmentStatus` and leaves
       * the payment `status` as it is. Payment statuses change only through payment and cancellation.
       */
      async updateStatus(id, status, fulfillment) {
        if (status !== "fulfilled") throw new Error("Use the payment or cancellation workflow to change order status");
        const order = await this.find(id);
        if (order?.paymentProvider === "admin_test") throw new Error("Admin test orders cannot be fulfilled");
        if (!fulfillment) throw new Error("Audited fulfillment details are required");
        await fulfillCommerceOrder(env, fulfillment.actor, {
          orderId: id,
          carrier: fulfillment.carrier,
          trackingNumber: fulfillment.trackingNumber,
          note: fulfillment.note
        });
        return await this.find(id);
      },
      async finalizePayment(id, options2) {
        return finalizeOrderPayment({
          orderId: id,
          provider: options2.provider,
          providerId: options2.providerId,
          paymentIntentId: options2.paymentIntentId,
          paymentStatus: options2.paymentStatus,
          amount: options2.amount,
          currency: options2.currency,
          customerEmail: options2.customerEmail
        });
      },
      /**
       * Release a pending order, its reservations and its basket lock. The public release route passes
       * `limitProviderChecks`, so the provider is asked only when the order's provider-check slot is free;
       * otherwise it throws ProviderCheckLimitedError and changes nothing. An order parked for review is
       * released only with `reviewRelease`, an administrator's decision, or once its session expired. A
       * Stripe session of the other mode is never asked about, since this Worker's key cannot read it.
       */
      async cancel(id, options2 = {}) {
        const order = await db.select().from(orders).where(eq3(orders.id, id)).get();
        if (!order) return null;
        if (PURCHASED_ORDER_STATUSES.includes(order.status)) return order;
        const timestamp = Math.floor(Date.now() / 1e3);
        if (order.status === "cancelled") return order;
        if (order.reconcileReviewAt && !options2.sessionExpired && !options2.reviewRelease) {
          throw new Error(PARKED_CHECKOUT_MESSAGE);
        }
        const reservations = await db.select().from(componentReservations).where(eq3(componentReservations.orderId, id));
        const inventoryReservations2 = await db.select().from(inventoryReservations).where(eq3(inventoryReservations.orderId, id));
        const otherModeSession = (order.paymentProvider ?? "stripe") === "stripe" && isOtherStripeModeSession(env, order.checkoutSessionId);
        let paymentReturned = null;
        if (order.checkoutSessionId && !options2.sessionExpired && order.paymentProvider !== "admin_test") {
          const adapter = paymentAdapters.find((candidate) => candidate.providerId === (order.paymentProvider ?? "stripe"));
          if (!adapter?.expireCheckoutSession) {
            throw new Error("Payment provider must expire the checkout session before stock can be released");
          }
          if (otherModeSession && !options2.reviewRelease) throw new Error(PARKED_CHECKOUT_MESSAGE);
          const refuseUnchecked = () => {
            const refusal = uncheckedSessionRefusal(Math.floor(order.createdAt.getTime() / 1e3));
            if (refusal) throw refusal;
          };
          if (otherModeSession) refuseUnchecked();
          if (!otherModeSession) {
            if (options2.limitProviderChecks && !await mayAskPaymentProvider(env, order, paymentAdapters)) {
              throw new ProviderCheckLimitedError();
            }
            let session;
            let missing = false;
            try {
              session = await adapter.getCheckoutSession?.(order.checkoutSessionId);
            } catch (error) {
              if (!options2.reviewRelease || !isMissingSessionError(error)) throw error;
              missing = true;
              refuseUnchecked();
            }
            if (session?.status === "complete") {
              if (!options2.reviewRelease) {
                throw new Error("Payment has completed; wait for confirmation before changing the basket");
              }
              paymentReturned = await completedCheckoutReturn(adapter, session, options2.reviewRelease.confirmPaymentReturned);
            } else if (!missing && session?.status !== "expired") {
              await adapter.expireCheckoutSession(order.checkoutSessionId);
            }
          }
        }
        const statements = [
          env.DB.prepare(`UPDATE _ecommerce_orders SET status = 'cancelled', updated_at = ?
            WHERE id = ? AND status NOT IN (${PURCHASED_ORDER_STATUSES.map((status) => `'${status}'`).join(", ")})`).bind(timestamp, id)
        ];
        statements.push(env.DB.prepare(`UPDATE _ecommerce_discount_redemptions
          SET status = 'cancelled', updated_at = ?
          WHERE order_id = ? AND status = 'reserved'
            AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(timestamp, id, id));
        statements.push(env.DB.prepare(`UPDATE _ecommerce_gift_card_redemptions
          SET status = 'cancelled', updated_at = ?
          WHERE order_id = ? AND status = 'reserved'
            AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(timestamp, id, id));
        if (order.creditApplied > 0) {
          statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
            (id, account_id, order_id, kind, amount_cents, created_at)
            SELECT ?, user_id, id, 'checkout_release', credit_applied, ?
            FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled' AND user_id IS NOT NULL
            ON CONFLICT(order_id, kind) DO NOTHING`).bind(`credit_release_${id}`, timestamp, id));
        }
        for (const reservation of reservations) {
          statements.push(env.DB.prepare(`UPDATE _ecommerce_components
            SET quantity = quantity + (SELECT quantity FROM _ecommerce_component_reservations
              WHERE id = ? AND released_at IS NULL), updated_at = MAX(updated_at + 1, ?)
            WHERE id = ? AND EXISTS (SELECT 1 FROM _ecommerce_component_reservations
              WHERE id = ? AND released_at IS NULL)
              AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(reservation.id, timestamp, reservation.componentId, reservation.id, id));
          statements.push(env.DB.prepare(`UPDATE _ecommerce_component_reservations SET released_at = ?
            WHERE id = ? AND released_at IS NULL
              AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(timestamp, reservation.id, id));
        }
        for (const reservation of inventoryReservations2) {
          const [table, column] = INVENTORY_COLUMNS[reservation.targetType];
          statements.push(env.DB.prepare(`UPDATE ${table}
            SET ${column} = ${column} + (SELECT quantity FROM _ecommerce_inventory_reservations
              WHERE id = ? AND released_at IS NULL), updated_at = MAX(updated_at + 1, ?)
            WHERE id = ? AND EXISTS (SELECT 1 FROM _ecommerce_inventory_reservations
              WHERE id = ? AND released_at IS NULL)
              AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(reservation.id, timestamp, reservation.targetId, reservation.id, id));
          statements.push(env.DB.prepare(`UPDATE _ecommerce_inventory_reservations SET released_at = ?
            WHERE id = ? AND released_at IS NULL
              AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(timestamp, reservation.id, id));
        }
        if (order.cartId) {
          statements.push(env.DB.prepare(`UPDATE _ecommerce_carts
            SET checkout_session_id = NULL, updated_at = ?
            WHERE id = ? AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(timestamp, order.cartId, id));
          statements.push(env.DB.prepare(`UPDATE _ecommerce_orders SET cart_id = NULL
            WHERE id = ? AND status = 'cancelled'`).bind(id));
        }
        if (options2.reviewRelease) {
          const { decision } = options2.reviewRelease;
          statements.push(env.DB.prepare(decisionInsert("order", "release", `status = 'cancelled'`)).bind(decision.id, paymentReturned, decision.actor, decision.reason, timestamp, id));
        }
        await env.DB.batch(statements);
        const cancelled = await this.find(id);
        if (cancelled?.status === "cancelled" && !otherModeSession && order.creditApplied + order.discountAmount + order.giftCardApplied > 0) {
          await discardCheckoutDiscount(
            paymentAdapters.find((candidate) => candidate.providerId === (order.paymentProvider ?? "stripe")),
            id
          );
        }
        return cancelled;
      }
    },
    webhooks: {
      /**
       * Verifies a Stripe webhook event and applies it. An event that names none of this store's orders
       * or gift card purchases is answered `{ ignored: true }` and changes nothing. One that names a
       * record it cannot be applied to, and that no retry would fix, is logged and answered the same
       * way with a `reason`. Throws WebhookSignatureError when the signature or payload is refused, and
       * WebhookRetryLaterError for an event about a record whose payment is not recorded yet.
       */
      async handleStripe(payload, signature, secret) {
        const stripeAdapter = paymentAdapters.find((a) => a.providerId === "stripe");
        if (!stripeAdapter?.validateWebhook) {
          throw new Error("Stripe adapter not configured options.paymentAdapters");
        }
        let event;
        try {
          event = await stripeAdapter.validateWebhook(payload, signature, secret || "");
        } catch (cause) {
          throw new WebhookSignatureError(cause instanceof Error ? cause.message : "Webhook Error", { cause });
        }
        try {
          return await applyStripeEvent(event, stripeAdapter);
        } catch (error) {
          if (!(error instanceof WebhookMismatchError)) throw error;
          console.error(
            "[commerce] Stripe event does not match the store records",
            { type: event.type, id: event.id, reason: error.reason }
          );
          return { success: true, event: event.type, ignored: true, reason: error.reason };
        }
      }
    }
  };
}
async function reconcileCommerce(options, limit = 10) {
  const count = Math.max(1, Math.min(20, Math.floor(limit)));
  const { env } = options;
  const api = bindCommerceApi(options);
  const now = Math.floor(Date.now() / 1e3);
  const db = createDbClient3(env);
  const preparations = await env.DB.prepare(`SELECT id FROM _ecommerce_carts
    WHERE checkout_session_id >= 'preparing:' AND checkout_session_id < 'preparing;' AND updated_at < ?
    ORDER BY updated_at LIMIT ?`).bind(now - 35 * 60, count).all();
  const settlesAdminTest = options.paymentAdapters?.some((adapter) => adapter.providerId === "admin_test") ?? false;
  const pending = await env.DB.prepare(`SELECT id FROM _ecommerce_orders
    WHERE status = 'pending' AND created_at < ? AND reconcile_review_at IS NULL AND ${RECONCILE_DUE}
      AND (? = 1 OR COALESCE(payment_provider, 'stripe') <> 'admin_test')
    ORDER BY ${RECONCILE_ORDER} LIMIT ?`).bind(now - 15 * 60, now, settlesAdminTest ? 1 : 0, count).all();
  const abandonedTests = settlesAdminTest ? { results: [] } : await env.DB.prepare(`SELECT id FROM _ecommerce_orders
    WHERE status = 'pending' AND payment_provider = 'admin_test' AND created_at < ?
    ORDER BY created_at LIMIT ?`).bind(now - 15 * 60, count).all();
  const giftPurchases = await env.DB.prepare(`SELECT id FROM _ecommerce_gift_card_purchases
    WHERE status = 'pending' AND provider_session_id IS NOT NULL AND created_at < ?
      AND reconcile_review_at IS NULL AND ${RECONCILE_DUE}
    ORDER BY ${RECONCILE_ORDER} LIMIT ?`).bind(now - 15 * 60, now, count).all();
  const results = [];
  for (const row of preparations.results ?? []) {
    try {
      await api.orders.resumeFromCart(row.id);
      results.push({ id: row.id, status: "preparation_checked" });
    } catch (error) {
      results.push({ id: row.id, status: "error", error: error instanceof Error ? error.message : "Recovery failed" });
    }
  }
  for (const row of pending.results ?? []) {
    results.push(await reconcileAttempt(env, "order", row.id, now, () => api.orders.reconcilePending(row.id)));
  }
  for (const row of abandonedTests.results ?? []) {
    try {
      const cancelled = await api.orders.cancel(row.id);
      results.push({ id: row.id, status: cancelled?.status ?? "unchanged" });
    } catch (error) {
      results.push({ id: row.id, status: "error", error: error instanceof Error ? error.message : "Recovery failed" });
    }
  }
  const stripe = options.paymentAdapters?.find((adapter) => adapter.providerId === "stripe");
  for (const row of giftPurchases.results ?? []) {
    results.push(await reconcileAttempt(
      env,
      "gift_card_purchase",
      row.id,
      now,
      () => reconcileGiftCardPurchase(env, stripe, row.id)
    ));
  }
  const adapters = options.paymentAdapters ?? [];
  const taxPasses = [
    ["tax_transactions", recordMissingTaxTransactions],
    ["tax_reversal_resends", resendPendingTaxReversals],
    ["tax_reversals", reverseUnreversedTax]
  ];
  for (const [name, pass] of taxPasses) {
    try {
      results.push(...await pass(env, adapters, now, count));
    } catch (error) {
      const failure = reconcileFailure(error);
      results.push({ id: name, status: "error", error: failure.message, code: failure.code });
    }
  }
  try {
    results.push(...await releaseReferralAwards(options, { limit: count }));
  } catch (error) {
    results.push({
      id: "referral_awards",
      status: "error",
      error: error instanceof Error ? error.message : "Referral release failed"
    });
  }
  try {
    results.push(...await deliverPendingCommerceEmails({ env }, { limit: Math.min(count, 5) }));
  } catch (error) {
    results.push({
      id: "commerce_emails",
      status: "error",
      error: error instanceof Error ? error.message : "Email delivery failed"
    });
  }
  await db.delete(customerSessions).where(or(
    and2(eq3(customerSessions.purpose, "email_challenge"), lt(customerSessions.expiresAt, at(now - 24 * 60 * 60))),
    and2(eq3(customerSessions.purpose, "session"), lt(customerSessions.expiresAt, at(now - 30 * 24 * 60 * 60)))
  ));
  return results;
}
var PURGE_MAX_BATCHES = 20;
async function purgeStaleCommerceData(options) {
  const { env } = options;
  const batchSize = Math.max(1, Math.min(1e3, Math.floor(options.batchSize ?? 500)));
  const now = Math.floor((options.now ?? /* @__PURE__ */ new Date()).getTime() / 1e3);
  const day = 24 * 60 * 60;
  const deleted = {
    carts: 0,
    customerSessions: 0,
    signInTokens: 0,
    unverifiedAccounts: 0,
    rateLimits: 0,
    authSessions: 0,
    authRateLimits: 0
  };
  const steps = [
    // Guest baskets untouched for 30 days. Account, checked-out and locked baskets stay.
    ["carts", `DELETE FROM _ecommerce_carts WHERE id IN (SELECT id FROM _ecommerce_carts
      WHERE user_id IS NULL AND closed = 0 AND checkout_session_id IS NULL AND updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders WHERE cart_id = _ecommerce_carts.id)
      LIMIT ?)`, [now - 30 * day]],
    // Shopper sessions, and sign-in links sent before migration 0024, a day after they expired, were used or signed out.
    ["customerSessions", `DELETE FROM _ecommerce_customer_sessions WHERE id IN (SELECT id
      FROM _ecommerce_customer_sessions WHERE expires_at < ? OR revoked_at < ? LIMIT ?)`, [now - day, now - day]],
    // Sign-in links, with the address they were sent to, a day after they expired or were used.
    ["signInTokens", `DELETE FROM _ecommerce_sign_in_tokens WHERE token_hash IN (SELECT token_hash
      FROM _ecommerce_sign_in_tokens WHERE expires_at < ? OR revoked_at < ? LIMIT ?)`, [now - day, now - day]],
    // Accounts that asking for a sign-in link used to create: never verified, a day old, and with no
    // orders, sessions, basket, credit, referral or discount use. Anything else keeps the account.
    ["unverifiedAccounts", `DELETE FROM _ecommerce_customer_accounts WHERE id IN (SELECT a.id
      FROM _ecommerce_customer_accounts a
      WHERE a.email_verified_at IS NULL AND a.cms_user_id IS NULL AND a.credit_balance = 0 AND a.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders WHERE user_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_customer_sessions WHERE account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_carts WHERE user_id = a.id AND closed = 0)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_credit_ledger WHERE account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_referral_codes WHERE account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_referrals WHERE referrer_account_id = a.id OR referred_account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_discount_redemptions WHERE account_id = a.id)
      LIMIT ?)`, [now - day]],
    // Shopper request counters. Every window is at most a day long.
    ["rateLimits", `DELETE FROM _ecommerce_rate_limits WHERE key IN (SELECT key FROM _ecommerce_rate_limits
      WHERE window_start < ? LIMIT ?)`, [now - day]],
    ["authSessions", `DELETE FROM galaxy_auth_session WHERE id IN (SELECT id FROM galaxy_auth_session
      WHERE expires_at < ? LIMIT ?)`, [now]],
    // better-auth records milliseconds. Shopper counters written in seconds before migration 0024 may remain.
    ["authRateLimits", `DELETE FROM galaxy_auth_rate_limit WHERE id IN (SELECT id FROM galaxy_auth_rate_limit
      WHERE CASE WHEN last_request >= 100000000000 THEN last_request / 1000 ELSE last_request END < ?
      LIMIT ?)`, [now - day]]
  ];
  const failures = [];
  for (const [table, query, params] of steps) {
    try {
      for (let batch = 0; batch < PURGE_MAX_BATCHES; batch++) {
        const result = await env.DB.prepare(query).bind(...params, batchSize).run();
        const changes = Number(result.meta?.changes ?? 0);
        deleted[table] += changes;
        if (changes < batchSize) break;
      }
    } catch (error) {
      failures.push(`${table}: ${error instanceof Error ? error.message : "cleanup failed"}`);
    }
  }
  if (failures.length) throw new Error(`Commerce data cleanup failed (${failures.join("; ")})`);
  return deleted;
}

export {
  PROVIDER_CHECK_MIN_ORDER_AGE_SECONDS,
  PROVIDER_CHECK_RETRY_MESSAGE,
  ProviderCheckLimitedError,
  providerCheckLimitResponse,
  mayAskPaymentProvider,
  isCheckoutDetailsError,
  checkoutSchema,
  checkoutInputError,
  shippingOptionsFor,
  TaxCalculationError,
  PARKED_CHECKOUT_MESSAGE,
  CART_MAX_LINES,
  CART_MAX_LINE_QUANTITY,
  aggregateComponentDemand,
  bindCommerceApi,
  reconcileCommerce,
  purgeStaleCommerceData
};
