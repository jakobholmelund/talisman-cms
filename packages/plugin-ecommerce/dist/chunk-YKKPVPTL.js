import {
  INVENTORY_COLUMNS,
  fullRefundStatements
} from "./chunk-BVMDOVSS.js";
import {
  runtimePaymentAdapters
} from "./chunk-AVWDMCNG.js";
import {
  TaxAddressError
} from "./chunk-IN4CG7W7.js";
import {
  CommerceOperationsConflict,
  adminActorNames,
  deliverCommerceEmail,
  describeOrderItems,
  fulfillCommerceOrder,
  readOrderWarehouse,
  warehouseFingerprint
} from "./chunk-GFXT6MBK.js";
import {
  ReconcileFailure,
  ShopperError,
  WebhookMismatchError,
  backoff,
  commerceEmailStatement,
  completedCheckoutReturn,
  decisionInsert,
  isCountryCode,
  isMissingSessionError,
  isOtherStripeModeSession,
  readStoreCurrency,
  readStoreSettings,
  reconcileFailure,
  uncheckedSessionRefusal
} from "./chunk-MBWSY2KP.js";
import {
  canonicalEmail,
  canonicalEmails,
  canonicalPurchase,
  getReferralPolicy,
  referralReversalStatements
} from "./chunk-IC3XDWQU.js";
import {
  PURCHASED_ORDER_STATUSES,
  claimInterval
} from "./chunk-PMYARYOQ.js";
import {
  batchGroups,
  chunked,
  commerceDb,
  commitBatch,
  errorText
} from "./chunk-SXQHVX4E.js";
import {
  RECOVERY_KINDS,
  RESTOCK_TARGET_TYPES,
  RETURN_REASON_CODES,
  carts,
  componentReservations,
  customerAccounts,
  discountRedemptions,
  giftCardRedemptions,
  inventoryReservations,
  orders,
  productVariantValues,
  productVariants,
  products,
  recoveryCases,
  recoveryEvents,
  recoveryPaymentEvents,
  recoveryPayments,
  recoveryShipments,
  referralCodes,
  replenishmentDeliveries,
  replenishmentDeliveryEvents,
  replenishmentPolicies,
  returnExchangePreferences,
  returnRequestEvents,
  returnRequestReasons,
  returnRequests,
  stockMovements,
  taxReversals,
  taxSyncDecisions
} from "./chunk-PLAJXKV3.js";
import {
  hashOrderAccess
} from "./chunk-NQUBOBQT.js";

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
import { z } from "zod/v4";
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
  if (code === null || code && !isCountryCode(code)) throw new ShopperError("invalid_country", INVALID_COUNTRY, 400);
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
}).strict();
var checkoutSchema = z.object({
  customerEmail: z.string().trim().email().max(254),
  discountCode: z.string().trim().max(32).optional(),
  giftCardCode: z.string().trim().max(37).optional(),
  shippingAddress: addressSchema.optional(),
  billingAddress: addressSchema.optional(),
  // A rate id from the store's shipping rates. Left out or blank, checkout uses the first rate that
  // serves the country.
  shippingRateId: z.string().trim().max(40).optional()
}).strict();
function checkoutInputError(error) {
  return error.issues.some((issue) => issue.path.at(-1) === "country") ? INVALID_COUNTRY : "Invalid checkout details";
}

// src/tax.ts
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z as z2 } from "zod";
var SHIPPING_TAX_CODE = "txcd_92010001";
var TaxCalculationError = class extends Error {
  constructor(options) {
    super(TAX_UNAVAILABLE, options);
    this.name = "TaxCalculationError";
  }
};
var describe = (error) => error instanceof Error ? error.message : String(error);
var at = (seconds) => new Date(seconds * 1e3);
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
  const totals = lines.map((line2) => line2.priceAtPurchase * line2.quantity);
  const discounts = allocateProportionally(discount.amount, totals.map((total, index) => !discount.productIds.length || discount.productIds.includes(lines[index].productId) ? total : 0));
  const afterDiscount = totals.map((total, index) => total - discounts[index]);
  const credits = allocateProportionally(creditApplied, afterDiscount);
  return lines.map((line2, index) => ({
    // Unique within the order, and names the product in the provider's tax reports.
    reference: `L${index + 1}:${line2.productId}${line2.variantId ? `:${line2.variantId}` : ""}`,
    amount: afterDiscount[index] - credits[index],
    quantity: line2.quantity
  }));
}
function taxAddressFor(requiresShipping, shippingAddress, billingAddress) {
  const given = requiresShipping ? shippingAddress : billingAddress;
  if (!given || typeof given.country !== "string" || !given.country) throw new ShopperError("checkout_details", TAX_ADDRESS_REQUIRED, 400);
  const address = { country: given.country };
  for (const key2 of ["line1", "line2", "city", "state", "postalCode"]) {
    const value = given[key2];
    if (typeof value === "string" && value.trim()) address[key2] = value.trim();
  }
  return { address, addressSource: requiresShipping ? "shipping" : "billing" };
}
async function calculateOrderTax(adapter, input) {
  const charged = input.lines.filter((line2) => line2.amount > 0);
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
  const failed = (reason3, cause) => {
    console.error(`[Commerce] Tax could not be calculated for basket ${input.cartId}: ${reason3}`);
    return new TaxCalculationError(cause === void 0 ? void 0 : { cause });
  };
  if (!adapter.calculateTax || !adapter.recordTaxTransaction || !adapter.reverseTaxTransaction) {
    throw failed(`payment provider ${adapter.providerId} cannot calculate, record and reverse tax`);
  }
  let calculation;
  try {
    calculation = await adapter.calculateTax(params);
  } catch (cause) {
    if (cause instanceof TaxAddressError) throw new ShopperError("checkout_details", TAX_ADDRESS_UNUSABLE, 400, { cause });
    throw failed(describe(cause), cause);
  }
  const exclusive = input.behavior === "exclusive";
  const amount = exclusive ? calculation.taxAmountExclusive : calculation.taxAmountInclusive;
  const other = exclusive ? calculation.taxAmountInclusive : calculation.taxAmountExclusive;
  const base = params.lines.reduce((sum, line2) => sum + line2.amount, 0) + params.shippingAmount;
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
var TAX_SYNC_CLEARED = { taxSyncAttempts: 0, taxSyncLastAt: null, taxSyncLastError: null, taxSyncReviewAt: null };
var orderTaxBackoff = (now) => backoff({
  attempts: orders.taxSyncAttempts,
  lastAt: orders.taxSyncLastAt,
  createdAt: orders.createdAt,
  id: orders.id
}, now);
var reversalBackoff = (now) => backoff({
  attempts: taxReversals.taxSyncAttempts,
  lastAt: taxReversals.taxSyncLastAt,
  createdAt: taxReversals.createdAt,
  id: taxReversals.id
}, now);
var unixNow = () => Math.floor(Date.now() / 1e3);
async function countTaxFailure(db, table, where, error, now) {
  try {
    const provider = error;
    const permanent = error instanceof ReconcileFailure && error.permanent || provider.code === "resource_missing" || provider.code === "tax_calculation_expired" || provider.statusCode === 400 && ["reference", "calculation", "original_transaction"].includes(provider.param ?? "");
    await db.update(table).set({
      taxSyncReviewAt: permanent ? at(now) : null,
      taxSyncAttempts: sql`${table.taxSyncAttempts} + 1`,
      taxSyncLastAt: at(now),
      taxSyncLastError: permanent ? "tax_permanent" : reconcileFailure(error).code
    }).where(where);
  } catch {
  }
}
async function recordOrderTax(env, adapters, orderId, now = unixNow()) {
  const db = commerceDb(env);
  const order = await db.select({
    id: orders.id,
    status: orders.status,
    paymentProvider: orders.paymentProvider,
    taxCalculationId: orders.taxCalculationId,
    taxTransactionId: orders.taxTransactionId,
    taxSyncReviewAt: orders.taxSyncReviewAt,
    // When the order was paid, in Unix seconds: its first payment row. The subquery names the order's
    // column as text, because the builder writes column objects in a select's fields unqualified.
    paidAt: sql`(SELECT MIN(created_at) FROM _ecommerce_payments WHERE order_id = _ecommerce_orders.id)`
  }).from(orders).where(eq(orders.id, orderId)).get();
  if (!order?.taxCalculationId || order.taxSyncReviewAt || order.taxTransactionId || !PAID_STATUSES.includes(order.status)) return false;
  try {
    const adapter = taxProvider(adapters, order.paymentProvider);
    if (!adapter?.recordTaxTransaction) {
      throw new ReconcileFailure("provider_not_configured", "Payment provider cannot record tax");
    }
    const late = order.paidAt !== null && order.paidAt < Math.floor(Date.now() / 1e3) - 300;
    const { transactionId } = await adapter.recordTaxTransaction({
      orderId: order.id,
      calculationId: order.taxCalculationId,
      ...late ? { postedAt: order.paidAt } : {}
    });
    const stored = await db.update(orders).set({ taxTransactionId: transactionId, ...TAX_SYNC_CLEARED }).where(and(eq(orders.id, order.id), isNull(orders.taxTransactionId))).run();
    return Number(stored.meta?.changes ?? 0) > 0;
  } catch (error) {
    await countTaxFailure(db, orders, and(eq(orders.id, order.id), isNull(orders.taxTransactionId)), error, now);
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
var reversalTarget = sql`CASE WHEN ${orders.status} = 'refunded' THEN ${orders.giftCardApplied} + ${orders.totalAmount}
  ELSE MIN(${orders.giftCardApplied} + ${orders.totalAmount}, ${orders.providerRefundedCents} + ${orders.giftCardRefundedCents}) END`;
var reversed = sql`(SELECT COALESCE(SUM(amount), 0) FROM _ecommerce_tax_reversals WHERE order_id = _ecommerce_orders.id)`;
async function recordTaxReversal(db, adapters, orderId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const order = await db.select({
      id: orders.id,
      paymentProvider: orders.paymentProvider,
      taxTransactionId: orders.taxTransactionId,
      target: reversalTarget,
      reversed
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order?.taxTransactionId || order.target <= order.reversed) return null;
    const adapter = taxProvider(adapters, order.paymentProvider);
    if (!adapter?.reverseTaxTransaction) {
      throw new ReconcileFailure("provider_not_configured", "Payment provider cannot reverse tax");
    }
    const reversal = {
      orderId: order.id,
      transactionId: order.taxTransactionId,
      reference: `${order.id}:reversal:${order.target}`,
      amount: order.target - order.reversed
    };
    const recorded = await db.run(sql`INSERT INTO _ecommerce_tax_reversals
      (id, order_id, reference, amount, provider_reversal_id, created_at)
      SELECT ${`taxrev_${crypto.randomUUID()}`}, ${order.id}, ${reversal.reference}, ${reversal.amount}, '', ${unixNow()}
      WHERE (SELECT COALESCE(SUM(amount), 0) FROM _ecommerce_tax_reversals WHERE order_id = ${order.id}) = ${order.reversed}
      ON CONFLICT(reference) DO NOTHING`);
    if (Number(recorded.meta?.changes ?? 0) > 0) return { adapter, reversal };
  }
  return null;
}
async function reverseOrderTax(env, adapters, orderId, now = unixNow()) {
  const db = commerceDb(env);
  let recorded;
  try {
    recorded = await recordTaxReversal(db, adapters, orderId);
  } catch (error) {
    await countTaxFailure(db, orders, eq(orders.id, orderId), error, now);
    throw error;
  }
  if (!recorded) return null;
  try {
    await db.update(orders).set(TAX_SYNC_CLEARED).where(and(eq(orders.id, orderId), isNotNull(orders.taxSyncLastAt)));
  } catch {
  }
  await sendTaxReversal(db, recorded.adapter, recorded.reversal, now);
  return { reference: recorded.reversal.reference, amount: recorded.reversal.amount };
}
async function sendTaxReversal(db, adapter, reversal, now) {
  const unsent = and(eq(taxReversals.reference, reversal.reference), eq(taxReversals.providerReversalId, ""));
  try {
    if (!adapter?.reverseTaxTransaction) {
      throw new ReconcileFailure("provider_not_configured", "Payment provider cannot reverse tax");
    }
    const { reversalId } = await adapter.reverseTaxTransaction(reversal);
    await db.update(taxReversals).set({ providerReversalId: reversalId, ...TAX_SYNC_CLEARED }).where(unsent);
  } catch (error) {
    await countTaxFailure(db, taxReversals, unsent, error, now);
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
  const wait = orderTaxBackoff(now);
  const rows = await commerceDb(env).select({ id: orders.id }).from(orders).where(and(inArray(orders.status, PAID_STATUSES), isNotNull(orders.taxCalculationId), isNull(orders.taxTransactionId), isNull(orders.taxSyncReviewAt), wait.due)).orderBy(...wait.order).limit(limit);
  return attemptEach(
    rows,
    (row) => row.id,
    async (row) => await recordOrderTax(env, adapters, row.id, now) ? "tax_recorded" : "unchanged"
  );
}
var REVERSAL_IN_FLIGHT_SECONDS = 5 * 60;
async function resendPendingTaxReversals(env, adapters, now, limit) {
  const db = commerceDb(env);
  const wait = reversalBackoff(now);
  const pending = await db.select({
    orderId: taxReversals.orderId,
    reference: taxReversals.reference,
    amount: taxReversals.amount,
    paymentProvider: orders.paymentProvider,
    taxTransactionId: orders.taxTransactionId
  }).from(taxReversals).innerJoin(orders, eq(orders.id, taxReversals.orderId)).where(and(sql`${taxReversals.providerReversalId} = ''`, lt(taxReversals.createdAt, at(now - REVERSAL_IN_FLIGHT_SECONDS)), isNull(taxReversals.taxSyncReviewAt), wait.due)).orderBy(...wait.order).limit(limit);
  return attemptEach(pending, (row) => row.orderId, async (row) => {
    if (!row.taxTransactionId) throw new ReconcileFailure("failed", "The order has no tax transaction to reverse");
    await sendTaxReversal(db, taxProvider(adapters, row.paymentProvider), {
      orderId: row.orderId,
      transactionId: row.taxTransactionId,
      reference: row.reference,
      amount: row.amount
    }, now);
    return "tax_reversed";
  });
}
async function reverseUnreversedTax(env, adapters, now, limit) {
  const wait = orderTaxBackoff(now);
  const rows = await commerceDb(env).select({ id: orders.id }).from(orders).where(and(
    sql`${orders.status} IN ('partially_refunded', 'refunded')`,
    isNotNull(orders.taxTransactionId),
    sql`${reversalTarget} > ${reversed}`,
    isNull(orders.taxSyncReviewAt),
    wait.due
  )).orderBy(...wait.order).limit(limit);
  return attemptEach(
    rows,
    (row) => row.id,
    async (row) => await reverseOrderTax(env, adapters, row.id, now) ? "tax_reversed" : "unchanged"
  );
}
async function listTaxSyncReview(env) {
  const db = commerceDb(env);
  const [transactions, reversals] = await db.batch([
    db.select({
      id: orders.id,
      reviewAt: orders.taxSyncReviewAt,
      code: orders.taxSyncLastError,
      attempts: orders.taxSyncAttempts
    }).from(orders).where(isNotNull(orders.taxSyncReviewAt)).limit(100),
    db.select({
      id: taxReversals.id,
      orderId: taxReversals.orderId,
      reviewAt: taxReversals.taxSyncReviewAt,
      code: taxReversals.taxSyncLastError,
      attempts: taxReversals.taxSyncAttempts
    }).from(taxReversals).where(isNotNull(taxReversals.taxSyncReviewAt)).limit(100)
  ]);
  return [
    ...transactions.map((row) => ({ ...row, orderId: row.id, kind: "transaction" })),
    ...reversals.map((row) => ({ ...row, kind: "reversal" }))
  ];
}
var taxRecoverySchema = z2.object({
  orderId: z2.string().min(1).max(128),
  reversalId: z2.string().min(1).max(128).optional(),
  outcome: z2.enum(["retry", "attach"]),
  providerId: z2.string().regex(/^tax_[a-zA-Z0-9_]+$/).optional(),
  reason: z2.string().trim().min(8).max(500)
}).strict();
async function recoverTaxSync(env, adapters, actor, input) {
  const values = taxRecoverySchema.parse(input);
  if (!actor.trim()) throw new Error("Administrator identity is required");
  const db = commerceDb(env);
  const order = await db.select().from(orders).where(eq(orders.id, values.orderId)).get();
  if (!order) throw new Error("Order not found");
  const reversal = values.reversalId ? await db.select().from(taxReversals).where(and(eq(taxReversals.id, values.reversalId), eq(taxReversals.orderId, order.id))).get() : void 0;
  if (values.reversalId && !reversal) throw new Error("Tax reversal not found");
  if (!(reversal ? reversal.taxSyncReviewAt : order.taxSyncReviewAt)) throw new Error("Tax sync is not parked for review");
  if (values.outcome === "attach") {
    if (!values.providerId) throw new Error("An existing Stripe Tax record id is required");
    const adapter = taxProvider(adapters, order.paymentProvider);
    if (!adapter?.getTaxRecord) throw new Error("The provider cannot verify the tax record");
    const record = await adapter.getTaxRecord(values.providerId);
    const matches = record.currency === order.currency && record.reference === (reversal?.reference ?? order.id) && record.type === (reversal ? "reversal" : "transaction") && record.amountTotal === (reversal ? -reversal.amount : order.totalAmount + order.giftCardApplied) && (reversal ? record.originalTransaction === order.taxTransactionId : record.amountTax === order.taxAmount);
    if (!matches) throw new Error("The provider tax record does not match this order/reversal");
  } else if (values.providerId) throw new Error("A retry must not attach a provider id");
  const guard = reversal ? and(eq(taxReversals.id, reversal.id), eq(taxReversals.providerReversalId, ""), isNotNull(taxReversals.taxSyncReviewAt)) : and(eq(orders.id, order.id), isNotNull(orders.taxSyncReviewAt), values.outcome === "attach" ? isNull(orders.taxTransactionId) : void 0);
  const auditId = `taxd_${crypto.randomUUID()}`;
  const table = reversal ? taxReversals : orders;
  await db.batch([
    db.run(sql`INSERT INTO _ecommerce_tax_sync_decisions (id,order_id,reversal_id,action,provider_id,actor,reason,created_at)
      SELECT ${auditId},${order.id},${reversal?.id ?? null},${values.outcome},${values.providerId ?? null},${actor},${values.reason},${unixNow()}
      FROM ${table} WHERE ${guard}`),
    reversal ? db.update(taxReversals).set({
      ...TAX_SYNC_CLEARED,
      ...values.outcome === "attach" ? { providerReversalId: values.providerId } : {}
    }).where(guard) : db.update(orders).set({
      ...TAX_SYNC_CLEARED,
      ...values.outcome === "attach" ? { taxTransactionId: values.providerId } : {}
    }).where(guard)
  ]);
  const recorded = await db.select({ id: taxSyncDecisions.id }).from(taxSyncDecisions).where(eq(taxSyncDecisions.id, auditId)).get();
  if (!recorded) throw new Error("Tax sync changed; reload and review it again");
  return { orderId: order.id, outcome: values.outcome };
}

// src/orders.ts
import { and as and2, eq as eq2, exists, isNull as isNull2, notInArray, sql as sql2 } from "drizzle-orm";
var at2 = (seconds) => new Date(seconds * 1e3);
var orderIn = (db, id5, status) => exists(db.select({ one: sql2`1` }).from(orders).where(and2(eq2(orders.id, id5), eq2(orders.status, status))));
var PARKED_CHECKOUT_MESSAGE = "The store is reviewing the payment for this checkout. Contact the store to release it.";
async function discardCheckoutDiscount(adapter, orderId) {
  if (!adapter?.discardCheckoutDiscount) return false;
  try {
    await adapter.discardCheckoutDiscount(orderId);
    return true;
  } catch (error) {
    console.warn("[commerce] Checkout discount could not be discarded", {
      provider: adapter.providerId,
      name: error instanceof Error ? error.name : typeof error,
      code: typeof error?.code === "string" ? error.code : void 0
    });
    return false;
  }
}
async function findOrder(ctx, id5) {
  const { db } = ctx;
  const order = await db.select().from(orders).where(eq2(orders.id, id5)).get();
  if (!order) return null;
  return order;
}
async function findOrderForSession(ctx, id5, sessionToken, customerId, orderAccessToken) {
  const { db } = ctx;
  const order = await findOrder(ctx, id5);
  if (!order) return null;
  if (customerId && order.userId === customerId) return order;
  if (orderAccessToken && order.guestAccessTokenHash === await hashOrderAccess(orderAccessToken)) return order;
  if (sessionToken && order.guestBasketTokenHash === await hashOrderAccess(sessionToken)) return order;
  if (!sessionToken || !order.cartId) return null;
  const cart = await db.select().from(carts).where(eq2(carts.id, order.cartId)).get();
  return cart?.sessionToken === sessionToken ? order : null;
}
async function createOrder(ctx, data) {
  const { env, db } = ctx;
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
    subtotalAmount: data.totalAmount,
    currency: data.currency || readStoreSettings(env).currency,
    customerEmail: data.customerEmail,
    items: data.items,
    shippingAddress: data.shippingAddress,
    billingAddress: data.billingAddress,
    createdAt: now,
    updatedAt: now
  });
  return await findOrder(ctx, orderId);
}
async function updateOrderStatus(ctx, id5, status, fulfillment) {
  const { env } = ctx;
  if (status !== "fulfilled") throw new Error("Use the payment or cancellation workflow to change order status");
  const order = await findOrder(ctx, id5);
  if (order?.paymentProvider === "admin_test") throw new Error("Admin test orders cannot be fulfilled");
  if (!fulfillment) throw new Error("Audited fulfillment details are required");
  await fulfillCommerceOrder(env, fulfillment.actor, {
    orderId: id5,
    carrier: fulfillment.carrier,
    trackingNumber: fulfillment.trackingNumber,
    note: fulfillment.note
  });
  return await findOrder(ctx, id5);
}
async function finalizeOrderPayment(ctx, params) {
  const { env, db, adapters: paymentAdapters } = ctx;
  const order = await db.select().from(orders).where(eq2(orders.id, params.orderId)).get();
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
  const timestamp2 = Math.floor(Date.now() / 1e3);
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const providerEmail = params.customerEmail?.trim() ?? "";
  const email = emailPattern.test(providerEmail) ? providerEmail : (order.customerEmail || "").trim();
  const normalizedEmail = email.toLowerCase();
  const newAccountId = !order.userId && params.provider !== "admin_test" && emailPattern.test(normalizedEmail) ? `acct_${order.id}` : null;
  const accountName = typeof order.shippingAddress?.name === "string" ? order.shippingAddress.name.trim().slice(0, 160) : null;
  const paid = orderIn(db, params.orderId, "paid");
  const paidBySession = exists(db.select({ one: sql2`1` }).from(orders).where(and2(
    eq2(orders.id, params.orderId),
    eq2(orders.status, "paid"),
    eq2(orders.checkoutSessionId, params.providerId)
  )));
  const statements = [
    db.update(orders).set({ status: "paid", updatedAt: at2(timestamp2), customerEmail: email, paymentIntentId: params.paymentIntentId ?? null }).where(and2(
      eq2(orders.id, params.orderId),
      eq2(orders.status, "pending"),
      eq2(orders.checkoutSessionId, params.providerId),
      eq2(orders.totalAmount, order.totalAmount)
    ))
  ];
  if (newAccountId) {
    statements.push(db.run(sql2`INSERT INTO _ecommerce_customer_accounts
      (id, email, email_normalized, name, created_at, updated_at)
      SELECT ${newAccountId}, ${email}, ${normalizedEmail}, ${accountName}, ${timestamp2}, ${timestamp2} FROM _ecommerce_orders
      WHERE id = ${params.orderId} AND status = 'paid' AND checkout_session_id = ${params.providerId}
      ON CONFLICT(email_normalized) DO NOTHING`));
    const accountId = db.select({ id: customerAccounts.id }).from(customerAccounts).where(eq2(customerAccounts.emailNormalized, normalizedEmail));
    statements.push(db.update(orders).set({ userId: sql2`(${accountId})` }).where(and2(eq2(orders.id, params.orderId), eq2(orders.status, "paid"), isNull2(orders.userId))));
  }
  if (order.referralCode && order.referralRewardCents > 0 && params.provider !== "admin_test") {
    const policy = order.referralTerms ?? await getReferralPolicy(env);
    const referrer = await db.select({ emailNormalized: customerAccounts.emailNormalized }).from(referralCodes).innerJoin(customerAccounts, eq2(customerAccounts.id, referralCodes.accountId)).where(eq2(referralCodes.code, order.referralCode)).get();
    const buyerAccount = order.userId ? await db.select({ emailNormalized: customerAccounts.emailNormalized }).from(customerAccounts).where(eq2(customerAccounts.id, order.userId)).get() : void 0;
    const checkoutEmail = (order.customerEmail || "").trim().toLowerCase();
    const buyerCanonicals = canonicalEmails([checkoutEmail, normalizedEmail, buyerAccount?.emailNormalized]);
    const referrerCanonical = canonicalEmail(referrer?.emailNormalized);
    if (referrerCanonical && buyerCanonicals.length && !buyerCanonicals.includes(referrerCanonical)) {
      const purchased = sql2.raw(PURCHASED_ORDER_STATUSES.map((status) => `'${status}'`).join(", "));
      statements.push(db.run(sql2`INSERT INTO _ecommerce_referrals
        (id, code, referrer_account_id, referred_account_id, order_id, reward_cents, currency, status, created_at, updated_at)
        SELECT ${`ref_${order.id}`}, rc.code, rc.account_id, o.user_id, o.id, ${order.referralRewardCents}, o.currency, 'approved', ${timestamp2}, ${timestamp2}
        FROM _ecommerce_orders o
        JOIN _ecommerce_referral_codes rc ON rc.code = o.referral_code
        JOIN _ecommerce_customer_accounts referrer ON referrer.id = rc.account_id
        JOIN _ecommerce_customer_accounts buyer ON buyer.id = o.user_id
        WHERE o.id = ${params.orderId} AND o.status = 'paid' AND rc.account_id <> o.user_id
          AND referrer.email_normalized NOT IN (${normalizedEmail}, ${checkoutEmail}, buyer.email_normalized)
          AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders prior
            WHERE prior.id <> o.id AND prior.status IN (${purchased})
              AND COALESCE(prior.payment_provider, 'stripe') <> 'admin_test'
              AND (prior.user_id = o.user_id OR lower(prior.customer_email) IN (${normalizedEmail}, ${checkoutEmail}, buyer.email_normalized)
                OR prior.user_id IN (SELECT id FROM _ecommerce_customer_accounts WHERE email_normalized IN (${normalizedEmail}, ${checkoutEmail}))))
          AND NOT ${canonicalPurchase(buyerCanonicals, params.orderId)}
          AND (SELECT COUNT(*) FROM _ecommerce_referrals recent
            JOIN _ecommerce_customer_accounts recent_referrer ON recent_referrer.id = recent.referrer_account_id
            WHERE recent.status = 'approved' AND recent.created_at > ${timestamp2 - policy.periodDays * 24 * 60 * 60}
              AND (recent.referrer_account_id = rc.account_id
                OR ${sql2.raw("recent_referrer.email_canonical")} = ${referrerCanonical})) < ${policy.maxPerPeriod}
        ON CONFLICT DO NOTHING`));
    }
  }
  statements.push(
    db.update(discountRedemptions).set({ status: "confirmed", updatedAt: at2(timestamp2) }).where(and2(eq2(discountRedemptions.orderId, params.orderId), eq2(discountRedemptions.status, "reserved"), paid)),
    db.update(giftCardRedemptions).set({ status: "confirmed", updatedAt: at2(timestamp2) }).where(and2(eq2(giftCardRedemptions.orderId, params.orderId), eq2(giftCardRedemptions.status, "reserved"), paid)),
    db.run(sql2`INSERT INTO _ecommerce_payments
      (id, order_id, provider, provider_id, status, amount, created_at)
      SELECT ${`pay_${crypto.randomUUID()}`}, id, ${params.provider}, ${params.providerId}, 'success', total_amount, ${timestamp2} FROM _ecommerce_orders
      WHERE id = ${params.orderId} AND status = 'paid' AND checkout_session_id = ${params.providerId}
      ON CONFLICT(provider, provider_id) DO NOTHING`)
  );
  if (order.cartId) {
    const buyer = db.select({ userId: orders.userId }).from(orders).where(eq2(orders.id, params.orderId));
    statements.push(db.update(carts).set({ closed: true, closedAt: at2(timestamp2), updatedAt: at2(timestamp2), userId: sql2`COALESCE(${carts.userId}, (${buyer}))` }).where(and2(eq2(carts.id, order.cartId), paidBySession)));
  }
  const confirms = params.provider !== "admin_test";
  if (confirms) {
    statements.push(db.run(commerceEmailStatement(
      "order_confirmation",
      params.orderId,
      timestamp2,
      sql2`EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ${params.orderId} AND status = 'paid' AND checkout_session_id = ${params.providerId}
        AND COALESCE(payment_provider, 'stripe') <> 'admin_test')`
    )));
  }
  await commitBatch(db, statements);
  const current = await db.select().from(orders).where(eq2(orders.id, params.orderId)).get();
  if (current?.status !== "paid") throw new Error("Order is no longer pending");
  if (current.taxCalculationId && !current.taxTransactionId) {
    await recordConfirmedOrderTax(env, paymentAdapters, params.orderId);
  }
  if (confirms) await deliverCommerceEmail(env, "order_confirmation", params.orderId);
  return { success: true, orderId: params.orderId, status: "paid" };
}
async function recordProviderRefund(ctx, params) {
  const { env, db } = ctx;
  const order = await db.select().from(orders).where(eq2(orders.paymentIntentId, params.paymentIntentId)).get();
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
  const refundable = sql2`id = ${order.id} AND payment_intent_id = ${params.paymentIntentId} AND provider_refunded_cents < ${params.amountRefunded}
    AND status IN ('paid', 'fulfilled', 'partially_refunded', 'disputed')`;
  const statements = [
    // First the part of the total that this event adds, read from the stored total under the guard
    // of the update below: a retried or out-of-order event adds no row, and the rows add up to the total.
    db.run(sql2`INSERT INTO _ecommerce_provider_refunds
      (id, order_id, provider, provider_refund_id, amount_cents, created_at)
      SELECT ${`prf_${order.id}_${params.amountRefunded}`}, id, 'stripe', ${params.providerRefundId ?? null}, ${params.amountRefunded} - provider_refunded_cents, ${params.refundedAt ?? now}
      FROM _ecommerce_orders WHERE ${refundable}
      ON CONFLICT(id) DO NOTHING`),
    // A dispute keeps the order disputed; closing it applies the refund status.
    db.update(orders).set({
      providerRefundedCents: params.amountRefunded,
      updatedAt: at2(now),
      status: sql2`CASE WHEN ${orders.status} = 'disputed' THEN ${orders.status} ELSE ${full ? "refunded" : "partially_refunded"} END`
    }).where(refundable),
    // The payment shows the refund, taken from the amounts while the order is disputed.
    db.run(sql2`UPDATE _ecommerce_payments
      SET status = COALESCE((SELECT CASE WHEN o.status IN ('partially_refunded', 'refunded') THEN o.status
          WHEN o.provider_refunded_cents >= o.total_amount THEN 'refunded'
          WHEN o.provider_refunded_cents > 0 THEN 'partially_refunded' END
        FROM _ecommerce_orders o WHERE o.id = ${order.id}), status)
      WHERE order_id = ${order.id} AND provider = 'stripe'`)
  ];
  if (full) statements.push(...fullRefundStatements(order.id, now).map((statement) => db.run(statement)));
  if (referralPolicy) {
    statements.push(...referralReversalStatements(order.id, { minOrderCents: referralPolicy.minOrderCents, now }).map((statement) => db.run(statement)));
  }
  await commitBatch(db, statements);
  return {
    success: true,
    orderId: order.id,
    status: order.status === "disputed" ? "disputed" : full ? "refunded" : "partially_refunded"
  };
}
async function cancelOrder(ctx, id5, options = {}) {
  const { env, db, adapters: paymentAdapters } = ctx;
  const order = await db.select().from(orders).where(eq2(orders.id, id5)).get();
  if (!order) return null;
  if (PURCHASED_ORDER_STATUSES.includes(order.status)) return order;
  const timestamp2 = Math.floor(Date.now() / 1e3);
  if (order.status === "cancelled") return order;
  if (order.reconcileReviewAt && !options.sessionExpired && !options.reviewRelease) {
    throw new Error(PARKED_CHECKOUT_MESSAGE);
  }
  const reservations = await db.select().from(componentReservations).where(eq2(componentReservations.orderId, id5));
  const inventoryReservations2 = await db.select().from(inventoryReservations).where(eq2(inventoryReservations.orderId, id5));
  const otherModeSession = (order.paymentProvider ?? "stripe") === "stripe" && isOtherStripeModeSession(env, order.checkoutSessionId);
  let paymentReturned = null;
  if (order.checkoutSessionId && !options.sessionExpired && order.paymentProvider !== "admin_test") {
    const adapter = paymentAdapters.find((candidate) => candidate.providerId === (order.paymentProvider ?? "stripe"));
    if (!adapter?.expireCheckoutSession) {
      throw new Error("Payment provider must expire the checkout session before stock can be released");
    }
    if (otherModeSession && !options.reviewRelease) throw new Error(PARKED_CHECKOUT_MESSAGE);
    const refuseUnchecked = () => {
      const refusal = uncheckedSessionRefusal(Math.floor(order.createdAt.getTime() / 1e3));
      if (refusal) throw refusal;
    };
    if (otherModeSession) refuseUnchecked();
    if (!otherModeSession) {
      if (options.limitProviderChecks && !await mayAskPaymentProvider(env, order, paymentAdapters)) {
        throw new ProviderCheckLimitedError();
      }
      let session;
      let missing = false;
      try {
        session = await adapter.getCheckoutSession?.(order.checkoutSessionId);
      } catch (error) {
        if (!options.reviewRelease || !isMissingSessionError(error)) throw error;
        missing = true;
        refuseUnchecked();
      }
      if (session?.status === "complete") {
        if (!options.reviewRelease) {
          throw new Error("Payment has completed; wait for confirmation before changing the basket");
        }
        paymentReturned = await completedCheckoutReturn(adapter, session, options.reviewRelease.confirmPaymentReturned);
      } else if (!missing && session?.status !== "expired") {
        await adapter.expireCheckoutSession(order.checkoutSessionId);
      }
    }
  }
  const released = orderIn(db, id5, "cancelled");
  const statements = [
    db.update(orders).set({
      status: "cancelled",
      updatedAt: at2(timestamp2),
      discountCleanupPending: order.creditApplied + order.discountAmount + order.giftCardApplied > 0 && (order.paymentProvider ?? "stripe") === "stripe"
    }).where(and2(eq2(orders.id, id5), notInArray(orders.status, [...PURCHASED_ORDER_STATUSES]))),
    db.update(discountRedemptions).set({ status: "cancelled", updatedAt: at2(timestamp2) }).where(and2(eq2(discountRedemptions.orderId, id5), eq2(discountRedemptions.status, "reserved"), released)),
    db.update(giftCardRedemptions).set({ status: "cancelled", updatedAt: at2(timestamp2) }).where(and2(eq2(giftCardRedemptions.orderId, id5), eq2(giftCardRedemptions.status, "reserved"), released))
  ];
  if (order.creditApplied > 0) {
    statements.push(db.run(sql2`INSERT INTO _ecommerce_credit_ledger
      (id, account_id, order_id, kind, amount_cents, created_at)
      SELECT ${`credit_release_${id5}`}, user_id, id, 'checkout_release', credit_applied, ${timestamp2}
      FROM _ecommerce_orders WHERE id = ${id5} AND status = 'cancelled' AND user_id IS NOT NULL
      ON CONFLICT(order_id, kind) DO NOTHING`));
  }
  for (const reservation of reservations) {
    statements.push(db.run(sql2`UPDATE _ecommerce_components
      SET quantity = quantity + (SELECT quantity FROM _ecommerce_component_reservations
        WHERE id = ${reservation.id} AND released_at IS NULL), updated_at = MAX(updated_at + 1, ${timestamp2})
      WHERE id = ${reservation.componentId} AND EXISTS (SELECT 1 FROM _ecommerce_component_reservations
        WHERE id = ${reservation.id} AND released_at IS NULL)
        AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ${id5} AND status = 'cancelled')`));
    statements.push(db.update(componentReservations).set({ releasedAt: at2(timestamp2) }).where(and2(eq2(componentReservations.id, reservation.id), isNull2(componentReservations.releasedAt), released)));
  }
  for (const reservation of inventoryReservations2) {
    const { table, quantity: quantity2 } = INVENTORY_COLUMNS[reservation.targetType];
    statements.push(db.run(sql2`UPDATE ${table}
      SET ${sql2.identifier(quantity2.name)} = ${sql2.identifier(quantity2.name)} + (SELECT quantity FROM _ecommerce_inventory_reservations
        WHERE id = ${reservation.id} AND released_at IS NULL), updated_at = MAX(updated_at + 1, ${timestamp2})
      WHERE id = ${reservation.targetId} AND EXISTS (SELECT 1 FROM _ecommerce_inventory_reservations
        WHERE id = ${reservation.id} AND released_at IS NULL)
        AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ${id5} AND status = 'cancelled')`));
    statements.push(db.update(inventoryReservations).set({ releasedAt: at2(timestamp2) }).where(and2(eq2(inventoryReservations.id, reservation.id), isNull2(inventoryReservations.releasedAt), released)));
  }
  if (order.cartId) {
    statements.push(db.update(carts).set({ checkoutSessionId: null, updatedAt: at2(timestamp2) }).where(and2(eq2(carts.id, order.cartId), released)));
    statements.push(db.update(orders).set({ cartId: null }).where(and2(eq2(orders.id, id5), eq2(orders.status, "cancelled"))));
  }
  if (options.reviewRelease) {
    const { decision } = options.reviewRelease;
    statements.push(db.run(decisionInsert(
      "order",
      "release",
      sql2`status = 'cancelled'`,
      { id: decision.id, paymentReturned, actor: decision.actor, reason: decision.reason, at: timestamp2, recordId: id5 }
    )));
  }
  await commitBatch(db, statements);
  const cancelled = await findOrder(ctx, id5);
  if (cancelled?.status === "cancelled" && !otherModeSession && order.creditApplied + order.discountAmount + order.giftCardApplied > 0) {
    const removed = await discardCheckoutDiscount(
      paymentAdapters.find((candidate) => candidate.providerId === (order.paymentProvider ?? "stripe")),
      id5
    );
    if (removed) await db.update(orders).set({ discountCleanupPending: false }).where(eq2(orders.id, id5));
  }
  return cancelled;
}

// src/order-tracking.ts
async function readOrderTracking(ctx, orderId, sessionToken, customerId, orderAccessToken) {
  const authorized = await findOrderForSession(ctx, orderId, sessionToken, customerId, orderAccessToken);
  if (!authorized || authorized.paymentProvider === "admin_test") return null;
  const order = await ctx.db.query.orders.findFirst({ where: { id: orderId }, columns: { id: true, items: true }, with: {
    fulfillments: { columns: { id: true, kind: true, correctsId: true, carrier: true, trackingNumber: true, createdAt: true }, orderBy: (_t, { sql: sql9 }) => sql9`rowid`, with: { contents: { columns: { items: true } } } },
    recoveryCases: { columns: { id: true, kind: true, lineIndex: true, quantity: true, target: true, createdAt: true }, with: { payments: { columns: { amountMinor: true }, orderBy: (_t, { sql: sql9 }) => sql9`rowid DESC`, limit: 1, with: { events: { columns: { kind: true }, orderBy: (_t, { sql: sql9 }) => sql9`rowid` } } }, receipt: { with: { refundDecisions: { columns: { status: true, amountMinor: true }, orderBy: (_t, { sql: sql9 }) => sql9`rowid DESC`, limit: 1 } } }, shipments: { columns: { id: true, quantity: true, carrier: true, trackingNumber: true, createdAt: true }, with: { receipts: { columns: { quantity: true }, with: { inspections: { columns: { quantity: true, disposition: true, restock: true } } } } }, orderBy: (_t, { sql: sql9 }) => sql9`rowid` }, events: { columns: { kind: true, status: true, shipmentId: true, carrier: true, trackingNumber: true }, orderBy: (_t, { sql: sql9 }) => sql9`rowid` } } },
    returnReceipts: { columns: { id: true, items: true, createdAt: true }, with: { inspections: { columns: { items: true } } } }
  } });
  if (!order) return null;
  const descriptions = await describeOrderItems(ctx.env, order.items);
  const label = (lineIndex) => {
    const line2 = descriptions[lineIndex];
    return { lineIndex, name: [line2?.productName || "Ordered item", line2?.variantLabel].filter(Boolean).join(" / "), sku: line2?.sku ?? null };
  };
  const parcels = order.fulfillments.filter((f) => f.kind === "shipment").map((f) => {
    const correction = order.fulfillments.filter((c) => c.kind === "correction" && c.correctsId === f.id).at(-1);
    return {
      id: f.id,
      shippedAt: f.createdAt.toISOString(),
      carrier: correction ? correction.carrier : f.carrier,
      trackingNumber: correction ? correction.trackingNumber : f.trackingNumber,
      items: f.contents ? f.contents.items.map((i) => ({ ...label(i.lineIndex), quantity: i.quantity })) : null
    };
  });
  const unknown = parcels.some((p) => p.items === null);
  const received = (lineIndex) => order.returnReceipts.reduce((n, r) => n + (r.items.find((i) => i.lineIndex === lineIndex)?.quantity ?? 0), 0);
  const returns = order.returnReceipts.map((r) => ({ receivedAt: r.createdAt.toISOString(), items: r.items.map((i) => {
    const reviewed = i.condition === "inspection" ? r.inspections.reduce((n, d) => n + (d.items.find((j) => j.lineIndex === i.lineIndex)?.quantity ?? 0), 0) : i.quantity;
    return { ...label(i.lineIndex), quantity: i.quantity, awaitingInspection: Math.max(0, i.quantity - reviewed) };
  }) }));
  return { orderId, lines: descriptions.map((line2, lineIndex) => {
    const shipped = parcels.reduce((n, p) => n + (p.items?.find((i) => i.lineIndex === lineIndex)?.quantity ?? 0), 0);
    return { ...label(lineIndex), ordered: line2.quantity, shipped, remaining: unknown ? null : Math.max(0, line2.quantity - shipped), received: received(lineIndex) };
  }), parcels, returns, recoveries: order.recoveryCases.map((c) => ({
    id: c.id,
    kind: c.kind,
    quantity: c.quantity,
    name: c.target.name,
    sku: c.target.sku,
    adjustment: { amountMinor: c.kind === "exchange" ? c.target.adjustmentMinor ?? 0 : 0, currency: authorized.currency, status: c.kind !== "exchange" || !c.target.adjustmentMinor ? "not_needed" : c.target.adjustmentMinor > 0 ? c.payments[0] && !c.payments[0].events.some((e) => ["refunded", "lost"].includes(e.kind)) && c.payments[0].events.filter((e) => ["disputed", "won"].includes(e.kind)).at(-1)?.kind !== "disputed" ? "paid" : "payment_needed" : c.receipt?.refundDecisions[0]?.status === "settled" ? "refunded" : "refund_needed" },
    status: c.events.at(-1)?.status ?? "open",
    shipments: c.shipments.map((s) => {
      const corrected = c.events.filter((e) => e.kind === "tracking" && e.shipmentId === s.id).at(-1);
      return { id: s.id, quantity: s.quantity, returned: s.receipts.reduce((n, r) => n + r.quantity, 0), awaitingInspection: s.receipts.reduce((n, r) => n + r.quantity - r.inspections.reduce((n2, i) => n2 + i.quantity, 0), 0), shippedAt: s.createdAt.toISOString(), carrier: corrected ? corrected.carrier : s.carrier, trackingNumber: corrected ? corrected.trackingNumber : s.trackingNumber };
    })
  })) };
}

// src/replenishment.ts
import { eq as eq3, sql as sql3 } from "drizzle-orm";
import { z as z3 } from "zod";
var id = z3.string().trim().min(1).max(128);
var reason = z3.string().trim().min(8).max(500);
var quantity = z3.number().int().min(0).max(1e6);
var target = { targetType: z3.enum(RESTOCK_TARGET_TYPES), targetId: id };
var physicalStockLocations = sql3`SELECT 'product' AS type,id,name,sku,inventory_quantity AS quantity,updated_at AS updated FROM _ecommerce_products WHERE type='standard'
 UNION ALL SELECT 'variant',v.id,p.name||' / '||v.name,v.sku,v.inventory_quantity,v.updated_at FROM _ecommerce_product_variants v JOIN _ecommerce_products p ON p.id=v.product_id WHERE p.type='standard'
 UNION ALL SELECT 'stock',s.id,p.name||' / '||v.name||' / '||x.value,x.sku,s.quantity,s.updated_at FROM _ecommerce_stocks s JOIN _ecommerce_product_variant_values x ON x.id=s.product_variant_value_id JOIN _ecommerce_product_variants v ON v.id=x.product_variant_id JOIN _ecommerce_products p ON p.id=v.product_id
 UNION ALL SELECT 'component',id,name,sku,quantity,updated_at FROM _ecommerce_components`;
var cte = sql3`WITH physical AS (${physicalStockLocations}), locations AS (SELECT *,1 AS available FROM physical UNION ALL SELECT d.target_type,d.target_id,'Unavailable stock · '||d.target_id,NULL,0,0,0 FROM _ecommerce_replenishment_deliveries d WHERE NOT EXISTS(SELECT 1 FROM physical p WHERE p.type=d.target_type AND p.id=d.target_id) GROUP BY d.target_type,d.target_id), planned AS (SELECT l.*,
 (SELECT id FROM _ecommerce_replenishment_policies p WHERE p.target_type=l.type AND p.target_id=l.id ORDER BY rowid DESC LIMIT 1) AS policyVersion,
 COALESCE((SELECT sum(MAX(0,d.quantity-COALESCE((SELECT sum(m.delta) FROM _ecommerce_replenishment_delivery_events e JOIN _ecommerce_stock_movements m ON m.id=e.movement_id WHERE e.delivery_id=d.id),0))) FROM _ecommerce_replenishment_deliveries d WHERE d.target_type=l.type AND d.target_id=l.id AND NOT EXISTS(SELECT 1 FROM _ecommerce_replenishment_delivery_events e WHERE e.delivery_id=d.id AND e.kind='cancelled')),0) AS incoming FROM locations l),
 plans AS (SELECT l.*,p.minimum_quantity AS minimumQuantity,p.target_quantity AS targetQuantity,COALESCE(p.enabled,0) AS enabled,
 CASE WHEN p.enabled=1 AND l.quantity<=p.minimum_quantity THEN MAX(0,p.target_quantity-l.quantity-l.incoming) ELSE 0 END AS suggested FROM planned l LEFT JOIN _ecommerce_replenishment_policies p ON p.id=l.policyVersion)`;
var effectiveDeliveryDate = sql3`COALESCE((SELECT e.expected_date FROM _ecommerce_purchase_order_lines l JOIN _ecommerce_purchase_order_events e ON e.purchase_order_id=l.purchase_order_id WHERE l.delivery_id=d.id ORDER BY e.rowid DESC LIMIT 1),d.expected_date)`;
var location = (r) => ({ type: r.type, id: r.id, name: r.name, sku: r.sku, quantity: r.quantity, updatedAt: new Date(r.updated * 1e3).toISOString(), minimumQuantity: r.minimumQuantity, targetQuantity: r.targetQuantity, enabled: !!r.enabled, incoming: r.incoming, suggested: r.suggested, policyVersion: r.policyVersion });
async function listReplenishment(env, input = {}) {
  const v = z3.object({ offset: z3.coerce.number().int().min(0).max(1e6).default(0), search: z3.string().trim().max(100).default(""), filter: z3.enum(["suggested", "configured", "incoming", "all"]).default("suggested") }).strict().parse(input), db = commerceDb(env);
  const pattern = `%${v.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, where = sql3`(name LIKE ${pattern} ESCAPE '\\' OR COALESCE(sku,'') LIKE ${pattern} ESCAPE '\\') AND (${v.filter}='all' OR (${v.filter}='incoming' AND incoming>0) OR (${v.filter}='configured' AND policyVersion IS NOT NULL) OR (${v.filter}='suggested' AND suggested>0))`;
  const [rows, count] = await db.batch([db.all(sql3`${cte} SELECT * FROM plans WHERE ${where} ORDER BY suggested DESC,name,type,id LIMIT 50 OFFSET ${v.offset}`), db.all(sql3`${cte} SELECT count(*) n FROM plans WHERE ${where}`)]);
  return { ...v, total: count[0]?.n ?? 0, rows: rows.map(location) };
}
async function readReplenishment(env, input) {
  const v = z3.object({ ...target, deliveryOffset: z3.coerce.number().int().min(0).max(1e6).default(0) }).strict().parse(input), db = commerceDb(env);
  const [row, policies, deliveries, deliveryCount] = await Promise.all([db.get(sql3`${cte} SELECT * FROM plans WHERE type=${v.targetType} AND id=${v.targetId}`), db.query.replenishmentPolicies.findMany({ where: { targetType: v.targetType, targetId: v.targetId }, orderBy: (_t, { sql: sql9 }) => sql9`rowid DESC`, limit: 50 }), db.query.replenishmentDeliveries.findMany({ where: { targetType: v.targetType, targetId: v.targetId }, orderBy: { createdAt: "desc", id: "desc" }, limit: 50, offset: v.deliveryOffset, with: { events: { orderBy: (_t, { sql: sql9 }) => sql9`rowid`, with: { movement: { columns: { delta: true } } } } } }), db.select({ n: sql3`count(*)`.mapWith(Number) }).from(replenishmentDeliveries).where(sql3`${replenishmentDeliveries.targetType}=${v.targetType} AND ${replenishmentDeliveries.targetId}=${v.targetId}`).get()]);
  const dates = await db.all(sql3`SELECT d.id,${effectiveDeliveryDate} AS expectedDate FROM _ecommerce_replenishment_deliveries d WHERE d.target_type=${v.targetType} AND d.target_id=${v.targetId} ORDER BY d.created_at DESC,d.id DESC LIMIT 50 OFFSET ${v.deliveryOffset}`);
  const effectiveDates = new Map(dates.map((d) => [d.id, d.expectedDate]));
  const names = await adminActorNames(env, [...policies.map((p) => p.actor), ...deliveries.flatMap((d) => [d.actor, ...d.events.map((e) => e.actor)])]);
  return { ...v, deliveryTotal: deliveryCount?.n ?? 0, location: row?.available ? location(row) : null, policies: policies.map(({ fingerprint: fingerprint2, ...p }) => ({ ...p, createdAt: p.createdAt.toISOString(), actorName: names.get(p.actor) ?? p.actor })), deliveries: deliveries.map(({ fingerprint: fingerprint2, events, ...d }) => {
    const received = events.reduce((n, e) => n + (e.movement?.delta ?? 0), 0), cancelled = events.some((e) => e.kind === "cancelled");
    return { ...d, expectedDate: effectiveDates.get(d.id) ?? d.expectedDate, createdAt: d.createdAt.toISOString(), actorName: names.get(d.actor) ?? d.actor, received, remaining: cancelled ? 0 : d.quantity - received, cancelled, version: events.at(-1)?.id ?? d.id, events: events.map((e) => ({ id: e.id, kind: e.kind, quantity: e.movement?.delta ?? 0, actorName: names.get(e.actor) ?? e.actor, reason: e.reason, createdAt: e.createdAt.toISOString() })) };
  }) };
}
var policySchema = z3.object({ ...target, requestKey: id.min(8), expectedVersion: id.nullable(), minimumQuantity: quantity, targetQuantity: quantity, enabled: z3.boolean(), reason }).strict().refine((v) => v.targetQuantity >= v.minimumQuantity);
var planSchema = z3.object({ ...target, requestKey: id.min(8), quantity: quantity.min(1), supplier: z3.string().trim().min(1).max(200), reference: z3.string().trim().max(200), expectedDate: z3.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && (/* @__PURE__ */ new Date(`${v}T00:00:00Z`)).toISOString().slice(0, 10) === v), reason }).strict();
var eventSchema = z3.object({ deliveryId: id, requestKey: id.min(8), expectedVersion: id, kind: z3.enum(["received", "cancelled"]), quantity: quantity.optional(), expectedQuantity: z3.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), expectedUpdatedAt: z3.string().datetime({ offset: true }).optional(), reason }).strict().refine((v) => v.kind === "cancelled" ? v.quantity === void 0 && v.expectedQuantity === void 0 && v.expectedUpdatedAt === void 0 : !!v.quantity && v.expectedQuantity !== void 0 && !!v.expectedUpdatedAt);
async function identity(input, actor, prefix) {
  if (!actor.trim()) throw new CommerceOperationsConflict("An authenticated staff member is required.");
  const v = input;
  return { id: `${prefix}_${await hashOrderAccess(v.requestKey)}`, fingerprint: await hashOrderAccess(JSON.stringify({ input, actor })) };
}
async function saveReplenishmentPolicy(env, input, actor) {
  const v = policySchema.parse(input), db = commerceDb(env), ident = await identity(v, actor, "rpl");
  const replay = async () => {
    const row = await db.select().from(replenishmentPolicies).where(eq3(replenishmentPolicies.id, ident.id)).get();
    if (!row) return null;
    if (row.fingerprint !== ident.fingerprint) throw new CommerceOperationsConflict("This planning key was used with other details.");
    return { policyId: row.id, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  try {
    const { requestKey, ...fields } = v;
    await db.insert(replenishmentPolicies).values({ ...fields, ...ident, actor, createdAt: /* @__PURE__ */ new Date() });
  } catch (error) {
    const previous2 = await replay();
    if (previous2) return previous2;
    if (!errorText(error).includes("Replenishment")) throw error;
    throw new CommerceOperationsConflict("Stock target or policy changed. Refresh before saving.");
  }
  return { policyId: ident.id };
}
async function planReplenishmentDelivery(env, input, actor) {
  const v = planSchema.parse(input), db = commerceDb(env), ident = await identity(v, actor, "rpd");
  const replay = async () => {
    const row = await db.select().from(replenishmentDeliveries).where(eq3(replenishmentDeliveries.id, ident.id)).get();
    if (!row) return null;
    if (row.fingerprint !== ident.fingerprint) throw new CommerceOperationsConflict("This delivery key was used with other details.");
    return { deliveryId: row.id, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  try {
    const { requestKey, ...fields } = v;
    await db.insert(replenishmentDeliveries).values({ ...fields, ...ident, actor, createdAt: /* @__PURE__ */ new Date() });
  } catch (error) {
    const previous2 = await replay();
    if (previous2) return previous2;
    if (!errorText(error).includes("Replenishment")) throw error;
    throw new CommerceOperationsConflict("This stock target is unavailable. Refresh before planning.");
  }
  return { deliveryId: ident.id };
}
async function recordReplenishmentDelivery(env, input, actor) {
  const v = eventSchema.parse(input), db = commerceDb(env), ident = await identity(v, actor, "rpe");
  const replay = async () => {
    const row = await db.select().from(replenishmentDeliveryEvents).where(eq3(replenishmentDeliveryEvents.id, ident.id)).get();
    if (!row) return null;
    if (row.fingerprint !== ident.fingerprint) throw new CommerceOperationsConflict("This delivery receipt key was used with other details.");
    return { eventId: row.id, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const delivery = await db.select().from(replenishmentDeliveries).where(eq3(replenishmentDeliveries.id, v.deliveryId)).get();
  if (!delivery) throw new CommerceOperationsConflict("Delivery plan not found.");
  const movementId = v.kind === "received" ? `mov_${ident.id}` : null, now = /* @__PURE__ */ new Date();
  if (v.kind === "received" && !Number.isSafeInteger(v.expectedQuantity + v.quantity)) throw new CommerceOperationsConflict("Stock quantity would be invalid.");
  try {
    await commitBatch(db, [
      ...movementId ? [db.insert(stockMovements).values({ id: movementId, targetType: delivery.targetType, targetId: delivery.targetId, kind: "receipt", delta: v.quantity, beforeQuantity: v.expectedQuantity, afterQuantity: v.expectedQuantity + v.quantity, expectedUpdatedAt: new Date(v.expectedUpdatedAt), actor, reason: v.reason, fingerprint: ident.fingerprint, createdAt: now })] : [],
      db.insert(replenishmentDeliveryEvents).values({ ...ident, deliveryId: v.deliveryId, kind: v.kind, movementId, expectedVersion: v.expectedVersion, actor, reason: v.reason, createdAt: now })
    ]);
  } catch (error) {
    const previous2 = await replay();
    if (previous2) return previous2;
    if (!/Stock|stock|Replenishment/.test(errorText(error))) throw error;
    throw new CommerceOperationsConflict("Delivery or stock changed. Reload current quantities before receiving or cancelling.");
  }
  return { eventId: ident.id };
}

// src/recovery-payments.ts
import { eq as eq4, sql as sql4 } from "drizzle-orm";
import { z as z4 } from "zod";
var id2 = z4.string().trim().min(1).max(128);
var recoveryPaymentHeld = sql4`EXISTS(SELECT 1 FROM _ecommerce_recovery_payment_events e WHERE e.payment_id=p.id AND e.kind IN ('refunded','lost')) OR COALESCE((SELECT kind FROM _ecommerce_recovery_payment_events e WHERE e.payment_id=p.id AND e.kind IN ('disputed','won') ORDER BY rowid DESC LIMIT 1),'won')='disputed'`;
async function verify(env, caseId, paymentId, amountMinor, currency, adapters) {
  const adapter = (adapters ?? runtimePaymentAdapters(env)).find((a) => a.providerId === "stripe");
  if (!adapter?.getExchangePayment) throw new CommerceOperationsConflict("The payment provider is unavailable. No exchange stock was changed.");
  const payment = await adapter.getExchangePayment(paymentId);
  if (!payment || payment.caseId !== caseId || payment.status !== "succeeded" || payment.amountMinor !== amountMinor || payment.currency !== currency || payment.refundedMinor !== 0 || payment.disputed)
    throw new CommerceOperationsConflict("This payment does not confirm the exact exchange amount, or it has been refunded or disputed.");
  return adapter;
}
async function verifyExchangeCharge(env, input, actor, adapters) {
  const v = z4.object({ caseId: id2, expectedVersion: id2, paymentId: z4.string().regex(/^pi_[A-Za-z0-9_]+$/).max(128), reason: z4.string().trim().min(8).max(500), requestKey: id2.min(8) }).strict().parse(input);
  if (!actor.trim()) throw new CommerceOperationsConflict("An authenticated staff member is required.");
  const db = commerceDb(env), decisionId = `rcp_${await hashOrderAccess(`${v.caseId}:${v.requestKey}`)}`, fingerprint2 = await warehouseFingerprint(v, actor);
  const replay = async () => {
    const old = await db.select().from(recoveryPayments).where(eq4(recoveryPayments.id, decisionId)).get();
    if (!old) return null;
    if (old.fingerprint !== fingerprint2) throw new CommerceOperationsConflict("This payment verification key was used with different details.");
    return { decisionId, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const c = await db.query.recoveryCases.findFirst({ where: { id: v.caseId }, with: { order: { columns: { currency: true } } } }), amountMinor = c?.target.adjustmentMinor ?? 0;
  if (!c || c.kind !== "exchange" || amountMinor <= 0) throw new CommerceOperationsConflict("This case does not need an upgrade payment.");
  await verify(env, c.id, v.paymentId, amountMinor, c.order.currency, adapters);
  try {
    await db.insert(recoveryPayments).values({ id: decisionId, caseId: c.id, expectedVersion: v.expectedVersion, provider: "stripe", paymentId: v.paymentId, amountMinor, currency: c.order.currency, actor, reason: v.reason, fingerprint: fingerprint2, createdAt: /* @__PURE__ */ new Date() });
  } catch (e) {
    const old = await replay();
    if (old) return old;
    if (!/Recovery|UNIQUE constraint/.test(errorText(e))) throw e;
    throw new CommerceOperationsConflict("The case or payment allocation changed. Refresh before continuing.");
  }
  return { decisionId };
}
async function checkExchangeCharge(env, caseId, adapters) {
  const db = commerceDb(env), c = await db.query.recoveryCases.findFirst({ where: { id: caseId }, with: { order: { columns: { currency: true } }, payments: { orderBy: (_t, { sql: sql9 }) => sql9`rowid DESC`, limit: 1 } } });
  if (!c || c.kind !== "exchange" || (c.target.adjustmentMinor ?? 0) <= 0) return;
  const p = c.payments[0];
  if (!p || p.redactedAt) throw new CommerceOperationsConflict("Verify the upgrade payment before shipping.");
  await verify(env, c.id, p.paymentId, p.amountMinor, c.order.currency, adapters);
}
async function recordRecoveryPaymentEvent(env, paymentIntentId, eventId, kind, createdAt) {
  const db = commerceDb(env), p = await db.select({ id: recoveryPayments.id }).from(recoveryPayments).where(eq4(recoveryPayments.paymentId, paymentIntentId)).get();
  if (!p) return null;
  await db.insert(recoveryPaymentEvents).values({ id: eventId, paymentId: p.id, kind, createdAt: new Date(createdAt * 1e3) }).onConflictDoNothing();
  return { success: true, recoveryPayment: true };
}

// src/commerce-context.ts
function commerceContext(options) {
  return { env: options.env, db: commerceDb(options.env), adapters: options.paymentAdapters ?? [] };
}

// src/basket.ts
import { and as and3, eq as eq5, inArray as inArray2, isNotNull as isNotNull2, isNull as isNull3, sql as sql5 } from "drizzle-orm";
var CART_MAX_LINES = 50;
var CART_MAX_LINE_QUANTITY = 99;
var CART_ID_MAX_LENGTH = 128;
var cartItemKey = (item) => `${item.productId}\0${item.variantId || ""}`;
function assertCartItems(items2) {
  if (!Array.isArray(items2)) throw new ShopperError("basket_conflict", "Cart items must be an array", 409);
  if (items2.length > CART_MAX_LINES) throw new ShopperError("basket_conflict", `Cart items must not exceed ${CART_MAX_LINES} lines`, 409);
  if (items2.some(
    (item) => !item || typeof item.productId !== "string" || !item.productId.trim() || item.productId.length > CART_ID_MAX_LENGTH || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > CART_MAX_LINE_QUANTITY || item.variantId !== void 0 && (typeof item.variantId !== "string" || item.variantId.length > CART_ID_MAX_LENGTH)
  )) {
    throw new ShopperError("basket_conflict", `Cart items must have a product and a whole-number quantity from 1 to ${CART_MAX_LINE_QUANTITY}`, 409);
  }
  const itemKeys = items2.map(cartItemKey);
  if (new Set(itemKeys).size !== itemKeys.length) {
    throw new ShopperError("basket_conflict", "Duplicate cart items are not allowed", 409);
  }
}
function aggregateComponentDemand(items2) {
  const demand = /* @__PURE__ */ new Map();
  for (const item of items2) {
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
async function loadBasketCatalog(ctx, items2) {
  const { db } = ctx;
  const productIds = [...new Set(items2.map((item) => String(item.productId)))];
  const variantIds = [...new Set(items2.flatMap((item) => item.variantId ? [String(item.variantId)] : []))];
  const rows = await batchGroups(db, {
    // Each product with its variant groups, and each group with the name of its definition.
    products: chunked(productIds).map((ids) => db.query.products.findMany({
      columns: { id: true, name: true, status: true, type: true, basePrice: true, inventoryQuantity: true, isPhysical: true },
      where: { id: { in: ids } },
      with: { variants: {
        columns: { id: true, productId: true, name: true, priceOverride: true, inventoryQuantity: true },
        with: { variant: { columns: { name: true } } }
      } }
    })),
    // Each value with its stock row and its bill of materials, in component id order.
    values: chunked(variantIds).map((ids) => db.query.productVariantValues.findMany({
      columns: { id: true, productVariantId: true, value: true, priceOverride: true },
      where: { id: { in: ids } },
      with: {
        stock: { columns: { id: true, quantity: true } },
        requirements: {
          columns: { componentId: true, quantity: true },
          orderBy: { componentId: "asc" },
          with: { component: { columns: { id: true, name: true, quantity: true } } }
        }
      }
    })),
    // A line's variant id may name a legacy group instead of a value; such a group must have no values.
    groupsWithValues: chunked(variantIds).map((ids) => db.query.productVariants.findMany({
      columns: { id: true },
      where: { id: { in: ids }, values: true }
    }))
  });
  const catalog = {
    products: /* @__PURE__ */ new Map(),
    groups: /* @__PURE__ */ new Map(),
    productsWithGroups: /* @__PURE__ */ new Set(),
    groupsWithValues: /* @__PURE__ */ new Set(),
    values: /* @__PURE__ */ new Map(),
    requirements: /* @__PURE__ */ new Map()
  };
  for (const product of rows.products) {
    catalog.products.set(product.id, {
      id: product.id,
      name: product.name,
      status: product.status,
      type: product.type,
      basePrice: product.basePrice,
      inventoryQuantity: product.inventoryQuantity,
      isPhysical: product.isPhysical
    });
    for (const group of product.variants) {
      catalog.groups.set(group.id, {
        id: group.id,
        productId: group.productId,
        name: group.name,
        definitionName: group.variant?.name ?? null,
        priceOverride: group.priceOverride,
        inventoryQuantity: group.inventoryQuantity
      });
      catalog.productsWithGroups.add(group.productId);
    }
  }
  for (const value of rows.values) {
    catalog.values.set(value.id, {
      id: value.id,
      groupId: value.productVariantId,
      value: value.value,
      priceOverride: value.priceOverride,
      stock: value.stock && { id: value.stock.id, quantity: value.stock.quantity }
    });
    catalog.requirements.set(value.id, value.requirements.map((requirement) => ({
      componentId: requirement.componentId,
      quantity: requirement.quantity,
      component: requirement.component
    })));
  }
  for (const group of rows.groupsWithValues) catalog.groupsWithValues.add(group.id);
  return catalog;
}
function resolveSelectedVariant(catalog, product, variantId) {
  const variantValue = catalog.values.get(String(variantId));
  if (variantValue) {
    const productVariant = catalog.groups.get(variantValue.groupId);
    if (!productVariant || productVariant.productId !== product.id) {
      throw new ShopperError("basket_conflict", `Variant value not found or mismatch: ${variantId}`, 409);
    }
    const stock = variantValue.stock;
    const components = [];
    for (const requirement of catalog.requirements.get(variantValue.id) ?? []) {
      const component = requirement.component;
      if (!component) throw new ShopperError("basket_conflict", `Component not found: ${requirement.componentId}`, 409);
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
    throw new ShopperError("basket_conflict", `Variant not found or mismatch: ${variantId}`, 409);
  }
  if (catalog.groupsWithValues.has(legacyVariant.id)) throw new ShopperError("basket_conflict", `Select an option for ${product.name}`, 409);
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
  if (catalog.productsWithGroups.has(product.id)) throw new ShopperError("basket_conflict", `Select an option for ${product.name}`, 409);
}
async function checkCartItems(ctx, items2, current = []) {
  const { db } = ctx;
  assertCartItems(items2);
  const currentKeys = new Set(current.map(cartItemKey));
  const added = items2.filter((item) => !currentKeys.has(cartItemKey(item)));
  const productIds = [...new Set(added.map((item) => item.productId))];
  const available = new Set(productIds.length ? (await db.select({ id: products.id, status: products.status }).from(products).where(inArray2(products.id, productIds))).filter((product) => product.status !== "archived").map((product) => product.id) : []);
  const unknownProduct = added.find((item) => !available.has(item.productId));
  if (unknownProduct) throw new ShopperError("basket_conflict", `Cart items must be catalog products; ${unknownProduct.productId} is not available`, 409);
  const variantIds = [...new Set(added.flatMap((item) => item.variantId ? [item.variantId] : []))];
  if (variantIds.length) {
    const groups = await db.select({ id: productVariants.id, productId: productVariants.productId }).from(productVariants).where(inArray2(productVariants.id, variantIds));
    const groupsWithValues = new Set(groups.length ? (await db.selectDistinct({ id: productVariantValues.productVariantId }).from(productVariantValues).where(inArray2(productVariantValues.productVariantId, groups.map((group) => group.id)))).map((value) => value.id) : []);
    const owners = new Map(groups.filter((group) => !groupsWithValues.has(group.id)).map((group) => [group.id, group.productId]));
    const choices = new Map(groups.filter((group) => groupsWithValues.has(group.id)).map((group) => [group.id, group.productId]));
    for (const value of await db.select({ id: productVariantValues.id, productId: productVariants.productId }).from(productVariantValues).innerJoin(productVariants, eq5(productVariants.id, productVariantValues.productVariantId)).where(inArray2(productVariantValues.id, variantIds))) {
      owners.set(value.id, value.productId);
    }
    const unchosenGroup = added.find((item) => item.variantId && choices.get(item.variantId) === item.productId);
    if (unchosenGroup) throw new ShopperError("basket_conflict", `Cart items must choose one of the variants of ${unchosenGroup.productId}`, 409);
    const unknownVariant = added.find((item) => item.variantId && owners.get(item.variantId) !== item.productId);
    if (unknownVariant) throw new ShopperError("basket_conflict", `Cart items must use a variant of their product; ${unknownVariant.variantId} is not available`, 409);
  }
  const withoutVariant = [...new Set(added.flatMap((item) => item.variantId ? [] : [item.productId]))];
  if (withoutVariant.length) {
    const withGroups = new Set((await db.selectDistinct({ productId: productVariants.productId }).from(productVariants).where(inArray2(productVariants.productId, withoutVariant))).map((variant) => variant.productId));
    const unchosen = added.find((item) => !item.variantId && withGroups.has(item.productId));
    if (unchosen) throw new ShopperError("basket_conflict", `Cart items must choose one of the variants of ${unchosen.productId}`, 409);
  }
  return items2.map(({ productId, variantId, quantity: quantity2 }) => variantId ? { productId, variantId, quantity: quantity2 } : { productId, quantity: quantity2 });
}
async function quoteCart(ctx, cartId) {
  const { env, db } = ctx;
  const { currency } = readStoreSettings(env);
  const cart = await db.select().from(carts).where(eq5(carts.id, cartId)).get();
  if (!cart) throw new ShopperError("basket_conflict", "Cart not found", 409);
  const catalog = await loadBasketCatalog(ctx, cart.items);
  const lines = [];
  let totalAmount = 0;
  let requiresShipping = false;
  const componentItems = [];
  for (const item of cart.items) {
    const product = catalog.products.get(String(item.productId));
    if (!product || product.status !== "active") throw new ShopperError("basket_conflict", `Product is not available: ${item.productId}`, 409);
    requireVariantChoice(catalog, product, item.variantId);
    const variant = item.variantId ? resolveSelectedVariant(catalog, product, item.variantId) : null;
    const unitAmount = variant?.price ?? product.basePrice;
    const name = variant?.name ?? product.name;
    if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0) {
      throw new ShopperError("basket_conflict", `A positive price is required for ${name}`, 409);
    }
    if (product.type === "standard" && (variant?.availableQuantity ?? product.inventoryQuantity) < item.quantity) {
      throw new ShopperError("basket_conflict", `Insufficient stock for ${name}`, 409);
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
    if (demand.available < demand.quantity) throw new ShopperError("basket_conflict", `Insufficient stock for component ${demand.name}`, 409);
  }
  if (!Number.isSafeInteger(totalAmount)) throw new ShopperError("basket_conflict", "Order total is too large", 409);
  return { lines, totalAmount, currency, requiresShipping, locked: Boolean(cart.checkoutSessionId) };
}
async function findCart(ctx, sessionToken, userId) {
  const { db } = ctx;
  if (!sessionToken && !userId) return null;
  const conditions = [eq5(carts.closed, false)];
  if (userId) {
    conditions.push(eq5(carts.userId, userId));
  } else if (sessionToken) {
    conditions.push(eq5(carts.sessionToken, sessionToken));
    conditions.push(isNull3(carts.userId));
  }
  return await db.select().from(carts).where(and3(...conditions)).get();
}
async function claimCart(ctx, sessionToken, userId, choice) {
  const { db } = ctx;
  const account = await db.select({ id: customerAccounts.id }).from(customerAccounts).where(eq5(customerAccounts.id, userId)).get();
  if (!account) throw new ShopperError("basket_conflict", "Customer account not found", 409);
  let guest = await db.select().from(carts).where(and3(eq5(carts.sessionToken, sessionToken), eq5(carts.closed, false))).get();
  const owned2 = await db.select().from(carts).where(and3(eq5(carts.userId, userId), eq5(carts.closed, false))).get();
  if (guest?.userId === userId) return guest;
  if (guest?.userId) {
    const released = await db.update(carts).set({ sessionToken: null, version: sql5`${carts.version} + 1` }).where(and3(
      eq5(carts.id, guest.id),
      eq5(carts.version, guest.version),
      eq5(carts.sessionToken, sessionToken)
    )).returning({ id: carts.id });
    if (!released.length) throw new ShopperError("basket_changed", "Basket changed; reload and try again", 409);
    guest = void 0;
  }
  if (guest?.checkoutSessionId) throw new ShopperError("basket_conflict", "Checkout already started for this cart", 409);
  if (guest && owned2 && guest.id !== owned2.id) {
    if (guest.items.length && owned2.items.length) {
      if (!choice) throw new ShopperError("basket_conflict", "Both baskets have items; choose which basket to keep before linking this session", 409);
    }
    if (owned2.checkoutSessionId) throw new ShopperError("basket_conflict", "Checkout already started for this cart", 409);
    if (guest.items.length && choice !== "account") {
      const released = await db.update(carts).set({ userId: null, updatedAt: /* @__PURE__ */ new Date() }).where(and3(
        eq5(carts.id, owned2.id),
        eq5(carts.userId, userId),
        eq5(carts.version, owned2.version),
        eq5(carts.closed, false)
      )).returning({ id: carts.id });
      if (!released.length) throw new ShopperError("basket_conflict", "Basket changed during account upgrade; reload and try again", 409);
    } else {
      const released = await db.update(carts).set({ sessionToken: null, updatedAt: /* @__PURE__ */ new Date() }).where(and3(
        eq5(carts.id, guest.id),
        eq5(carts.sessionToken, sessionToken),
        eq5(carts.version, guest.version),
        eq5(carts.closed, false)
      )).returning({ id: carts.id });
      if (!released.length) throw new ShopperError("basket_conflict", "Basket changed during account upgrade; reload and try again", 409);
    }
  }
  const target2 = choice === "account" && owned2 ? owned2 : guest?.items.length ? guest : owned2 ?? guest;
  if (target2) {
    if (!guest) {
      await db.update(carts).set({ sessionToken: null }).where(and3(eq5(carts.sessionToken, sessionToken), eq5(carts.closed, true)));
    }
    const updated = await db.update(carts).set({ userId, sessionToken, updatedAt: /* @__PURE__ */ new Date(), version: sql5`${carts.version} + 1` }).where(and3(
      eq5(carts.id, target2.id),
      eq5(carts.closed, false),
      isNull3(carts.checkoutSessionId),
      eq5(carts.version, target2.version)
    )).returning({ id: carts.id });
    if (!updated.length) throw new ShopperError("basket_conflict", "Basket changed during account upgrade; reload and try again", 409);
    return await db.select().from(carts).where(eq5(carts.id, target2.id)).get();
  }
  return null;
}
async function getOrCreateCart(ctx, sessionToken, userId) {
  const { db } = ctx;
  if (userId) {
    const claimed = await claimCart(ctx, sessionToken, userId);
    if (claimed) return claimed;
  }
  let cart = await findCart(ctx, sessionToken, userId);
  if (!cart) {
    if (!userId) {
      await db.update(carts).set({ sessionToken: null }).where(and3(
        eq5(carts.sessionToken, sessionToken),
        eq5(carts.closed, false),
        isNotNull2(carts.userId)
      ));
    }
    await db.update(carts).set({ sessionToken: null }).where(and3(eq5(carts.sessionToken, sessionToken), eq5(carts.closed, true)));
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
    cart = await findCart(ctx, sessionToken, userId);
  }
  return cart;
}
async function updateCartItems(ctx, cartId, items2) {
  const { db } = ctx;
  assertCartItems(items2);
  const cart = await db.select().from(carts).where(eq5(carts.id, cartId)).get();
  if (!cart) {
    throw new ShopperError("basket_conflict", "Cart not found", 409);
  }
  if (cart.closed) {
    throw new ShopperError("basket_conflict", "Cart is closed", 409);
  }
  if (cart.checkoutSessionId) {
    throw new ShopperError("basket_conflict", "Checkout already started for this cart", 409);
  }
  const checked = await checkCartItems(ctx, items2, cart.items);
  const updated = await db.update(carts).set({ items: checked, updatedAt: /* @__PURE__ */ new Date(), version: sql5`${carts.version} + 1` }).where(and3(
    eq5(carts.id, cartId),
    eq5(carts.closed, false),
    isNull3(carts.checkoutSessionId),
    eq5(carts.version, cart.version)
  )).returning({ id: carts.id });
  if (!updated.length) throw new ShopperError("basket_conflict", "Basket changed or checkout already started; reload and try again", 409);
  return await db.select().from(carts).where(eq5(carts.id, cartId)).get();
}

// src/recovery-progress.ts
import { sql as sql6 } from "drizzle-orm";
var RECOVERY_NEXT_ACTIONS = ["inspection", "review", "refund", "payment", "stock", "dispatch", "follow_up", "complete"];
var recoveryActionLabels = {
  inspection: "Inspect returned replacement goods",
  review: "Review the case",
  refund: "Review or confirm the refund",
  payment: "Confirm upgrade payment",
  stock: "Replenish replacement stock",
  dispatch: "Pack and dispatch",
  follow_up: "Confirm the agreed outcome",
  complete: "Resolved"
};
var recoveryProgressQuery = sql6`WITH physical AS (${physicalStockLocations}), facts AS (
 SELECT c.id,c.order_id AS orderId,c.receipt_id AS receiptId,c.line_index AS lineIndex,c.kind,c.quantity,c.created_at AS createdAt,json_extract(c.target,'$.name') AS name,
 COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),'open') AS status,
 (COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=c.id AND actor='payment_provider'),0)>COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=c.id AND kind='resolve'),0)) AS awaitingPaymentReview,
 EXISTS(SELECT 1 FROM _ecommerce_recovery_receipts r JOIN _ecommerce_recovery_shipments s ON s.id=r.shipment_id WHERE s.case_id=c.id AND r.quantity>COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_inspections WHERE receipt_id=r.id),0)) AS awaitingInspection,
 COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_shipments WHERE case_id=c.id),0) AS shipped,
 COALESCE(json_extract(c.target,'$.adjustmentMinor'),0) AS adjustment,
 COALESCE((SELECT status FROM _ecommerce_return_refund_decisions WHERE receipt_id=c.receipt_id ORDER BY rowid DESC LIMIT 1),'review') AS refundStatus,
 COALESCE((SELECT amount_minor FROM _ecommerce_return_refund_decisions WHERE receipt_id=c.receipt_id ORDER BY rowid DESC LIMIT 1),0) AS refundAmount,
 EXISTS(SELECT 1 FROM _ecommerce_recovery_payments p WHERE p.case_id=c.id AND p.rowid=(SELECT max(rowid) FROM _ecommerce_recovery_payments WHERE case_id=c.id)
 AND NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_payment_events e WHERE e.payment_id=p.id AND e.kind IN ('refunded','lost'))
 AND COALESCE((SELECT kind FROM _ecommerce_recovery_payment_events e WHERE e.payment_id=p.id AND e.kind IN ('disputed','won') ORDER BY rowid DESC LIMIT 1),'won')<>'disputed') AS paid,
 EXISTS(SELECT 1 FROM json_each(c.target,'$.stockTargets') t WHERE NOT EXISTS(SELECT 1 FROM physical p WHERE p.type=json_extract(t.value,'$.type') AND p.id=json_extract(t.value,'$.id') AND p.quantity>=json_extract(t.value,'$.units'))) AS stockShort,
 o.status AS paymentStatus,o.shipping_address AS address,c.redacted_at AS redacted
 FROM _ecommerce_recovery_cases c JOIN _ecommerce_orders o ON o.id=c.order_id
 ), cases AS (SELECT *,CASE
 WHEN awaitingInspection=1 THEN 'inspection'
 WHEN awaitingPaymentReview=1 OR redacted IS NOT NULL THEN 'review'
 WHEN status='resolved' THEN 'complete'
 WHEN paymentStatus NOT IN ('paid','partially_refunded') OR (paymentStatus='partially_refunded' AND (kind<>'exchange' OR adjustment>=0)) THEN 'review'
 WHEN shipped>=quantity THEN 'follow_up'
 WHEN kind='exchange' AND ((adjustment<0 AND (refundStatus<>'settled' OR refundAmount<>-adjustment)) OR (adjustment>=0 AND refundStatus<>'not_needed')) THEN 'refund'
 WHEN kind='exchange' AND adjustment>0 AND paid=0 THEN 'payment'
 WHEN address IS NULL THEN 'review'
 WHEN stockShort=1 THEN 'stock'
 ELSE 'dispatch' END AS nextAction FROM facts)`;

// src/recoveries.ts
import { eq as eq6, sql as sql7 } from "drizzle-orm";
import { z as z5 } from "zod";
var id3 = z5.string().trim().min(1).max(128);
var reason2 = z5.string().trim().min(8).max(500);
var units = z5.number().int().min(1).max(1e6);
var line = z5.number().int().min(0).max(199);
var timestamp = z5.string().refine((s) => Number.isSafeInteger(Date.parse(s)) && Date.parse(s) % 1e3 === 0, "Reload the stock version");
var report = z5.object({
  orderId: id3,
  kind: z5.enum(RECOVERY_KINDS),
  fulfillmentId: id3.nullable().default(null),
  sourceShipmentId: id3.nullable().default(null),
  receiptId: id3.nullable().default(null),
  lineIndex: line,
  quantity: units,
  expectedUnitPrice: z5.number().int().min(1).max(1e9).optional(),
  allowPriceDifference: z5.boolean().default(false),
  productId: id3.optional(),
  variantId: id3.nullable().optional(),
  requestKey: id3.min(8),
  reason: reason2
}).strict();
var openRecoveryCase = sql7`COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),'open')='open' OR (COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=c.id AND actor='payment_provider'),0)>COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=c.id AND kind='resolve'),0)) OR EXISTS(SELECT 1 FROM _ecommerce_recovery_receipts r JOIN _ecommerce_recovery_shipments s ON s.id=r.shipment_id WHERE s.case_id=c.id AND r.quantity>COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_inspections WHERE receipt_id=r.id),0))`;
var actorRequired = (actor) => {
  if (!actor.trim()) throw new CommerceOperationsConflict("An authenticated staff member is required.");
};
function targets(target2) {
  const totals = /* @__PURE__ */ new Map();
  for (const t of target2.stockTargets) {
    if (!RESTOCK_TARGET_TYPES.includes(t.type) || !t.id || !Number.isSafeInteger(t.units) || t.units <= 0) throw new CommerceOperationsConflict("The frozen stock mapping is unavailable.");
    const key2 = `${t.type}:${t.id}`, old = totals.get(key2);
    totals.set(key2, { ...t, units: t.units + (old?.units ?? 0) });
  }
  if (!Number.isSafeInteger(target2.adjustmentMinor ?? 0) || Math.abs(target2.adjustmentMinor ?? 0) > 1e9) throw new CommerceOperationsConflict("This exchange amount is too large.");
  if (totals.size > 50) throw new CommerceOperationsConflict("This replacement needs more than 50 stock pools.");
  return { ...target2, stockTargets: [...totals.values()].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)) };
}
async function write(fn, replay) {
  try {
    await fn();
  } catch (e) {
    const old = await replay();
    if (old) return old;
    if (!/Recovery|Stock |stock_movement|UNIQUE constraint|Refund follow-up/.test(errorText(e))) throw e;
    throw new CommerceOperationsConflict("The case, payment, returned quantities or stock changed. Refresh before continuing.");
  }
  return null;
}
async function createRecoveryCase(env, input, actor) {
  const v = report.parse(input);
  actorRequired(actor);
  const db = commerceDb(env), caseId = `rec_${await hashOrderAccess(`${v.orderId}:${v.requestKey}`)}`, fingerprint2 = await warehouseFingerprint(v.allowPriceDifference ? v : (({ allowPriceDifference, ...old }) => old)(v), actor);
  const replay = async () => {
    const old = await db.select().from(recoveryCases).where(eq6(recoveryCases.id, caseId)).get();
    if (!old) return null;
    if (old.fingerprint !== fingerprint2) throw new CommerceOperationsConflict("This recovery key was used with different details.");
    return { caseId, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const order = await db.query.orders.findFirst({ where: { id: v.orderId } });
  const original = order?.items[v.lineIndex];
  if (!order || !original || order.paymentProvider === "admin_test" || !["paid", "partially_refunded"].includes(order.status)) throw new CommerceOperationsConflict("Only paid real orders with an affected item can create replacements or exchanges.");
  let target2;
  if (v.kind === "exchange") {
    if (!v.receiptId || v.fulfillmentId || v.sourceShipmentId || !v.productId) throw new CommerceOperationsConflict("Choose a received return and an equal-price replacement.");
    if (order.currency !== readStoreCurrency(env)) throw new CommerceOperationsConflict("This order uses a different currency from the current catalog.");
    const catalog = await loadBasketCatalog(commerceContext({ env }), [{ productId: v.productId, variantId: v.variantId }]), product = catalog.products.get(v.productId);
    if (!product || product.status !== "active" || !product.isPhysical || product.type !== "standard") throw new CommerceOperationsConflict("Choose an active physical stock item.");
    requireVariantChoice(catalog, product, v.variantId ?? void 0);
    const selected = v.variantId ? resolveSelectedVariant(catalog, product, v.variantId) : null;
    const price = selected?.price ?? product.basePrice;
    if (v.expectedUnitPrice !== void 0 && price !== v.expectedUnitPrice) throw new CommerceOperationsConflict("The replacement price changed. Refresh the choice and agree the adjustment before continuing.");
    if (!v.allowPriceDifference && price !== original.priceAtPurchase) throw new CommerceOperationsConflict("The replacement must match the original unit price.");
    const described = (await describeOrderItems(env, [{ productId: product.id, variantId: v.variantId }]))[0];
    target2 = {
      adjustmentMinor: (price - original.priceAtPurchase) * v.quantity,
      productId: product.id,
      variantId: v.variantId ?? null,
      name: selected?.name ?? product.name,
      sku: described.sku,
      priceAtPurchase: price,
      stockTargets: selected?.components.length ? selected.components.map((t) => ({ type: "component", id: t.id, units: t.quantity })) : selected?.inventoryTarget ? [{ ...selected.inventoryTarget, units: 1 }] : [{ type: "product", id: product.id, units: 1 }]
    };
    if (order.status !== "paid" && price >= original.priceAtPurchase) throw new CommerceOperationsConflict("Only a cheaper exchange with a recorded refund may use a partially refunded order.");
  } else {
    if (order.status !== "paid" || v.allowPriceDifference || v.expectedUnitPrice !== void 0) throw new CommerceOperationsConflict("Parcel replacements require a paid order.");
    if (v.receiptId || v.productId !== void 0 || v.variantId !== void 0 || !!v.fulfillmentId === !!v.sourceShipmentId) throw new CommerceOperationsConflict("Choose one recorded original or replacement parcel.");
    if (v.sourceShipmentId) {
      const source = await db.query.recoveryShipments.findFirst({ where: { id: v.sourceShipmentId }, with: { case: true } });
      if (!source || source.case.orderId !== v.orderId || source.case.lineIndex !== v.lineIndex) throw new CommerceOperationsConflict("Replacement parcel not found.");
      target2 = source.case.target;
    } else {
      if (!Array.isArray(original.stockTargets)) throw new CommerceOperationsConflict("This older order has no frozen stock mapping for a safe replacement.");
      const d = (await describeOrderItems(env, [original]))[0];
      target2 = { productId: original.productId, variantId: original.variantId ?? null, name: [d.productName || "Ordered item", d.variantLabel].filter(Boolean).join(" / "), sku: d.sku, priceAtPurchase: original.priceAtPurchase, stockTargets: original.stockTargets };
    }
  }
  const result = await write(() => db.insert(recoveryCases).values({ id: caseId, orderId: v.orderId, kind: v.kind, fulfillmentId: v.fulfillmentId, sourceShipmentId: v.sourceShipmentId, receiptId: v.receiptId, lineIndex: v.lineIndex, quantity: v.quantity, target: targets(target2), actor, reason: v.reason, fingerprint: fingerprint2, createdAt: /* @__PURE__ */ new Date() }), replay);
  return result ?? { caseId };
}
var action = z5.object({ caseId: id3, expectedVersion: id3, kind: z5.enum(["note", "resolve", "reopen", "tracking"]), shipmentId: id3.optional(), carrier: z5.string().trim().max(100).nullable().optional(), trackingNumber: z5.string().trim().max(150).nullable().optional(), reason: reason2, requestKey: id3.min(8) }).strict();
async function recordRecoveryEvent(env, input, actor) {
  const v = action.parse(input);
  actorRequired(actor);
  const db = commerceDb(env), eventId = `rce_${await hashOrderAccess(`${v.caseId}:${v.requestKey}`)}`, fingerprint2 = await warehouseFingerprint(v, actor);
  const replay = async () => {
    const old = await db.select().from(recoveryEvents).where(eq6(recoveryEvents.id, eventId)).get();
    if (!old) return null;
    if (old.fingerprint !== fingerprint2) throw new CommerceOperationsConflict("This follow-up key was used with other details.");
    return { eventId, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const latest = await db.query.recoveryCases.findFirst({ where: { id: v.caseId }, with: { events: { orderBy: (_t, { sql: sql9 }) => sql9`rowid DESC`, limit: 1 } } });
  if (!latest || latest.redactedAt) throw new CommerceOperationsConflict("Recovery case unavailable.");
  const status = v.kind === "resolve" ? "resolved" : v.kind === "reopen" ? "open" : latest.events[0]?.status ?? "open";
  if (v.kind === "tracking" ? !v.shipmentId : v.shipmentId !== void 0 || v.carrier !== void 0 || v.trackingNumber !== void 0) throw new CommerceOperationsConflict("Choose a replacement parcel only for a tracking correction.");
  const result = await write(() => db.insert(recoveryEvents).values({ id: eventId, caseId: v.caseId, expectedVersion: v.expectedVersion, kind: v.kind, status, shipmentId: v.shipmentId ?? null, carrier: v.carrier || null, trackingNumber: v.trackingNumber || null, actor, reason: v.reason, fingerprint: fingerprint2, createdAt: /* @__PURE__ */ new Date() }), replay);
  return result ?? { eventId };
}
var ship = z5.object({
  caseId: id3,
  expectedVersion: id3,
  quantity: units,
  requestKey: id3.min(8),
  reason: reason2,
  carrier: z5.string().trim().max(100).nullable().default(null),
  trackingNumber: z5.string().trim().max(150).nullable().default(null),
  stock: z5.array(z5.object({ targetType: z5.enum(RESTOCK_TARGET_TYPES), targetId: id3, expectedQuantity: z5.number().int().min(0).max(Number.MAX_SAFE_INTEGER), expectedUpdatedAt: timestamp }).strict()).max(50)
}).strict();
async function shipRecoveryCase(env, input, actor, adapters) {
  const v = ship.parse(input);
  actorRequired(actor);
  const db = commerceDb(env), shipmentId = `rcs_${await hashOrderAccess(`${v.caseId}:${v.requestKey}`)}`, fingerprint2 = await warehouseFingerprint(v, actor);
  const replay = async () => {
    const old = await db.select().from(recoveryShipments).where(eq6(recoveryShipments.id, shipmentId)).get();
    if (!old) return null;
    if (old.fingerprint !== fingerprint2) throw new CommerceOperationsConflict("This replacement shipment key was used with other details.");
    return { shipmentId, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const c = await db.query.recoveryCases.findFirst({ where: { id: v.caseId } });
  if (!c) throw new CommerceOperationsConflict("Recovery case unavailable.");
  if (v.stock.length !== c.target.stockTargets.length || new Set(v.stock.map((t) => `${t.targetType}:${t.targetId}`)).size !== v.stock.length) throw new CommerceOperationsConflict("Reload every stock pool for this replacement.");
  await checkExchangeCharge(env, c.id, adapters);
  const stock = v.stock.map((t) => {
    const target2 = c.target.stockTargets.find((s) => s.type === t.targetType && s.id === t.targetId);
    if (!target2) throw new CommerceOperationsConflict("The replacement stock mapping changed.");
    const required = target2.units * v.quantity;
    if (!Number.isSafeInteger(required) || required > 1e6) throw new CommerceOperationsConflict("This stock deduction is too large.");
    return { ...t, units: required, expectedUpdatedSeconds: Date.parse(t.expectedUpdatedAt) / 1e3 };
  }).map(({ expectedUpdatedAt, ...t }) => t);
  const result = await write(() => db.insert(recoveryShipments).values({ id: shipmentId, caseId: c.id, expectedVersion: v.expectedVersion, quantity: v.quantity, stock, carrier: v.carrier || null, trackingNumber: v.trackingNumber || null, actor, reason: v.reason, fingerprint: fingerprint2, createdAt: /* @__PURE__ */ new Date() }), replay);
  return result ?? { shipmentId };
}
async function listRecoveryCases(env, input = {}) {
  const v = z5.object({ filter: z5.enum(["open", "resolved", "all"]).default("open"), kind: z5.enum(["all", ...RECOVERY_KINDS]).default("all"), nextAction: z5.enum(["all", ...RECOVERY_NEXT_ACTIONS]).default("all"), offset: z5.coerce.number().int().min(0).max(1e6).default(0), orderId: z5.string().trim().max(128).default("") }).strict().parse(input), db = commerceDb(env);
  const where = sql7`(${v.filter}='all' OR (${v.filter}='open' AND (status='open' OR awaitingInspection=1 OR awaitingPaymentReview=1)) OR (${v.filter}='resolved' AND status='resolved' AND awaitingInspection=0 AND awaitingPaymentReview=0)) AND (${v.kind}='all' OR kind=${v.kind}) AND (${v.orderId}='' OR orderId=${v.orderId}) AND (${v.nextAction}='all' OR nextAction=${v.nextAction})`;
  const [rows, count] = await db.batch([db.all(sql7`${recoveryProgressQuery} SELECT id,orderId,receiptId,lineIndex,kind,quantity,shipped,awaitingInspection,awaitingPaymentReview,name,status,createdAt,nextAction FROM cases WHERE ${where} ORDER BY createdAt,id LIMIT 50 OFFSET ${v.offset}`), db.all(sql7`${recoveryProgressQuery} SELECT count(*) n FROM cases WHERE ${where}`)]);
  return { ...v, total: count[0]?.n ?? 0, rows: rows.map((r) => ({ ...r, nextActionLabel: recoveryActionLabels[r.nextAction], createdAt: new Date(r.createdAt * 1e3).toISOString() })) };
}
async function readRecoveryCase(env, input) {
  const { caseId } = z5.object({ caseId: id3 }).strict().parse(input), db = commerceDb(env);
  const c = await db.query.recoveryCases.findFirst({ where: { id: caseId }, with: { payments: { orderBy: (_t, { sql: sql9 }) => sql9`rowid DESC`, limit: 1, with: { events: { orderBy: (_t, { sql: sql9 }) => sql9`rowid` } } }, events: { orderBy: (_t, { sql: sql9 }) => sql9`rowid DESC`, limit: 200 }, shipments: { orderBy: (_t, { sql: sql9 }) => sql9`rowid DESC`, limit: 100, with: { receipts: { with: { inspections: true } } } }, order: { columns: { status: true, currency: true, shippingAddress: true } } } });
  if (!c) throw new CommerceOperationsConflict("Recovery case unavailable.");
  const refund = c.receiptId ? await db.query.returnRefundDecisions.findFirst({ where: { receiptId: c.receiptId }, columns: { status: true, amountMinor: true }, orderBy: (_t, { sql: sql9 }) => sql9`rowid DESC` }) : null;
  const payment = c.payments[0], held = !!payment && (payment.events.some((e) => ["refunded", "lost"].includes(e.kind)) || payment.events.filter((e) => ["disputed", "won"].includes(e.kind)).at(-1)?.kind === "disputed");
  const adjustmentMinor = c.kind === "exchange" ? c.target.adjustmentMinor ?? 0 : 0;
  const adjustment = { amountMinor: adjustmentMinor, status: adjustmentMinor > 0 ? payment && !held ? "paid" : "payment_needed" : adjustmentMinor < 0 ? refund?.status === "settled" && refund.amountMinor === -adjustmentMinor ? "refunded" : "refund_needed" : "not_needed", paymentId: payment?.paymentId ?? null };
  const priceReview = await db.get(sql7`SELECT COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=${caseId} AND actor='payment_provider'),0)>COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=${caseId} AND kind='resolve'),0) n`);
  const shipped = await db.get(sql7`SELECT COALESCE(sum(quantity),0) n FROM _ecommerce_recovery_shipments WHERE case_id=${caseId}`), latest = c.events[0];
  const stock = await Promise.all(c.target.stockTargets.map(async (t) => {
    const row = await db.get(sql7`WITH physical AS (${physicalStockLocations}) SELECT name,sku,quantity,updated FROM physical WHERE type=${t.type} AND id=${t.id}`);
    return { ...t, name: row?.name ?? "Unavailable stock pool", sku: row?.sku ?? null, quantity: row?.quantity ?? null, updatedAt: row ? new Date(row.updated * 1e3).toISOString() : null };
  }));
  const names = await adminActorNames(env, [c.actor, ...c.events.map((e) => e.actor)]);
  const corrections = await db.query.recoveryEvents.findMany({ where: { caseId, kind: "tracking" }, columns: { id: true, shipmentId: true, carrier: true, trackingNumber: true }, orderBy: (_t, { sql: sql9 }) => sql9`rowid` });
  return {
    adjustment,
    awaitingPaymentReview: !!priceReview?.n,
    id: c.id,
    orderId: c.orderId,
    kind: c.kind,
    lineIndex: c.lineIndex,
    quantity: c.quantity,
    target: { name: c.target.name, sku: c.target.sku, productId: c.target.productId, variantId: c.target.variantId },
    sourceId: c.fulfillmentId ?? c.sourceShipmentId ?? c.receiptId,
    version: latest?.id ?? c.id,
    status: latest?.status ?? "open",
    remaining: Math.max(0, c.quantity - (shipped?.n ?? 0)),
    shipped: shipped?.n ?? 0,
    reason: c.reason,
    actorName: names.get(c.actor) ?? c.actor,
    createdAt: c.createdAt.toISOString(),
    redacted: !!c.redactedAt,
    paymentStatus: c.order.status,
    currency: c.order.currency,
    shippingAddress: c.order.shippingAddress,
    stock,
    historyTruncated: c.events.length === 200,
    shipmentsTruncated: c.shipments.length === 100,
    history: [...c.events].reverse().map((e) => ({ id: e.id, kind: e.kind, status: e.status, reason: e.reason, actorName: e.actor === "payment_provider" ? "Payment provider" : names.get(e.actor) ?? e.actor, createdAt: e.createdAt.toISOString() })),
    shipments: [...c.shipments].reverse().map((s) => {
      const correction = corrections.filter((e) => e.shipmentId === s.id).at(-1);
      return { id: s.id, quantity: s.quantity, returned: s.receipts.reduce((n, r) => n + r.quantity, 0), receipts: s.receipts.map((r) => ({ id: r.id, quantity: r.quantity, remaining: r.quantity - r.inspections.reduce((n, i) => n + i.quantity, 0), createdAt: r.createdAt.toISOString(), inspections: r.inspections.map((i) => ({ id: i.id, quantity: i.quantity, disposition: i.disposition, restock: i.restock, createdAt: i.createdAt.toISOString() })) })), carrier: correction ? correction.carrier : s.carrier, trackingNumber: correction ? correction.trackingNumber : s.trackingNumber, createdAt: s.createdAt.toISOString() };
    })
  };
}
async function readRecoveryOrder(env, input) {
  const v = z5.object({ orderId: id3 }).strict().parse(input), db = commerceDb(env), warehouse = await readOrderWarehouse(env, v);
  const cases = await db.query.recoveryCases.findMany({ where: { orderId: v.orderId }, columns: { id: true, lineIndex: true, quantity: true, receiptId: true, fulfillmentId: true, sourceShipmentId: true, kind: true, target: true }, with: { shipments: { columns: { id: true, quantity: true, createdAt: true } } } });
  const o = await db.query.orders.findFirst({ where: { id: v.orderId }, columns: { items: true, currency: true } });
  return {
    ...warehouse,
    currency: o.currency,
    lines: warehouse.lines.map((l) => ({ ...l, priceAtPurchase: o.items[l.lineIndex].priceAtPurchase })),
    canCreate: ["paid", "partially_refunded"].includes(warehouse.status),
    replacements: cases.flatMap((c) => c.shipments.map((s) => ({ id: s.id, lineIndex: c.lineIndex, quantity: s.quantity, name: c.target.name, createdAt: s.createdAt.toISOString() }))),
    cases: cases.map(({ target: target2, shipments, ...c }) => c)
  };
}
async function listExchangeChoices(env, input) {
  const v = z5.object({ orderId: id3, lineIndex: line, search: z5.string().trim().max(100).default(""), allowPriceDifference: z5.boolean().default(false), offset: z5.coerce.number().int().min(0).max(1e6).default(0) }).strict().parse(input), db = commerceDb(env);
  const o = await db.query.orders.findFirst({ where: { id: v.orderId }, columns: { items: true, currency: true, status: true, paymentProvider: true } }), item = o?.items[v.lineIndex];
  if (!item || o?.paymentProvider === "admin_test" || !["paid", "partially_refunded"].includes(o?.status ?? "") || o.currency !== readStoreCurrency(env)) throw new CommerceOperationsConflict("Equal-price choices are unavailable for this order.");
  const cte2 = sql7`WITH choices AS (
 SELECT p.id AS productId,NULL AS variantId,p.name,p.sku,p.base_price AS price FROM _ecommerce_products p WHERE p.status='active' AND p.is_physical=1 AND p.type='standard' AND NOT EXISTS(SELECT 1 FROM _ecommerce_product_variants g WHERE g.product_id=p.id)
 UNION ALL SELECT p.id,g.id,p.name||' / '||g.name,COALESCE(g.sku,p.sku),COALESCE(g.price_override,p.base_price) FROM _ecommerce_product_variants g JOIN _ecommerce_products p ON p.id=g.product_id WHERE p.status='active' AND p.is_physical=1 AND p.type='standard' AND NOT EXISTS(SELECT 1 FROM _ecommerce_product_variant_values v WHERE v.product_variant_id=g.id)
 UNION ALL SELECT p.id,v.id,p.name||' / '||g.name||': '||v.value,COALESCE(v.sku,g.sku,p.sku),COALESCE(v.price_override,g.price_override,p.base_price) FROM _ecommerce_product_variant_values v JOIN _ecommerce_product_variants g ON g.id=v.product_variant_id JOIN _ecommerce_products p ON p.id=g.product_id WHERE p.status='active' AND p.is_physical=1 AND p.type='standard')`;
  const pattern = `%${v.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, where = sql7`price>0 AND (${v.allowPriceDifference ? 1 : 0}=1 OR price=${item.priceAtPurchase}) AND name LIKE ${pattern} ESCAPE '\\'`;
  const [rows, count] = await db.batch([db.all(sql7`${cte2} SELECT * FROM choices WHERE ${where} ORDER BY name,productId,variantId LIMIT 50 OFFSET ${v.offset}`), db.all(sql7`${cte2} SELECT count(*) n FROM choices WHERE ${where}`)]);
  return { ...v, currency: o.currency, price: item.priceAtPurchase, total: count[0]?.n ?? 0, rows };
}
async function readExchangeHandoff(env, input) {
  const { requestId } = z5.object({ requestId: id3 }).strict().parse(input), db = commerceDb(env);
  const r = await db.query.returnRequests.findFirst({ where: { id: requestId }, with: { exchangePreference: true, events: { orderBy: (_t, { sql: sql9 }) => sql9`rowid DESC`, limit: 1 }, order: { columns: { items: true, currency: true, status: true, paymentProvider: true, shippingAddress: true } }, receipts: { with: { receipt: { with: { inspections: true, refundDecisions: { columns: { status: true }, orderBy: (_t, { sql: sql9 }) => sql9`rowid DESC`, limit: 1 }, recoveryCases: { columns: { id: true, lineIndex: true, quantity: true } } } } } } } });
  if (!r || r.redactedAt || !r.exchangePreference || r.order.paymentProvider === "admin_test") throw new CommerceOperationsConflict("This exchange request is unavailable.");
  const preference = r.exchangePreference, lineIndex = preference.lineIndex, status = r.events[0]?.status ?? "pending";
  let choice = null;
  if (r.order.currency === readStoreCurrency(env)) {
    const catalog = await loadBasketCatalog(commerceContext({ env }), [preference.target]), p = catalog.products.get(preference.target.productId);
    if (p?.status === "active" && p.type === "standard" && p.isPhysical) {
      let variant = null, valid = true;
      try {
        requireVariantChoice(catalog, p, preference.target.variantId ?? void 0);
        variant = preference.target.variantId ? resolveSelectedVariant(catalog, p, preference.target.variantId) : null;
      } catch {
        valid = false;
      }
      const price = variant?.price ?? p.basePrice;
      if (valid && Number.isSafeInteger(price) && price > 0 && price <= 1e9) {
        const d = (await describeOrderItems(env, [preference.target]))[0];
        choice = { productId: p.id, variantId: preference.target.variantId, name: variant?.name ?? p.name, sku: d.sku, price };
      }
    }
  }
  const claimed = await db.get(sql7`SELECT COALESCE(sum(quantity),0) n FROM _ecommerce_recovery_cases WHERE order_id=${r.orderId} AND line_index=${lineIndex} AND source_shipment_id IS NULL`);
  const remaining = Math.max(0, (r.order.items[lineIndex]?.quantity ?? 0) - (claimed?.n ?? 0));
  return {
    requestId,
    orderId: r.orderId,
    lineIndex,
    status,
    preference: preference.target,
    choice,
    currency: r.order.currency,
    canArrange: ["approved", "closed"].includes(status) && ["paid", "partially_refunded"].includes(r.order.status) && !!r.order.shippingAddress,
    blockedReason: !["approved", "closed"].includes(status) ? "Approve the request and receive its goods before arranging an exchange." : !r.order.shippingAddress ? "The order needs a shipping address before an exchange can be recorded." : !["paid", "partially_refunded"].includes(r.order.status) ? "Review the order payment before arranging an exchange." : null,
    receipts: r.receipts.map((l) => {
      const item = l.receipt.items.find((i) => i.lineIndex === lineIndex), received = item?.quantity ?? 0, inspected = item?.condition === "inspection" ? l.receipt.inspections.reduce((n, d) => n + (d.items.find((i) => i.lineIndex === lineIndex)?.quantity ?? 0), 0) : received;
      const cases = l.receipt.recoveryCases.filter((c) => c.lineIndex === lineIndex), used = cases.reduce((n, c) => n + c.quantity, 0);
      return { receiptId: l.receiptId, received, refundStatus: l.receipt.refundDecisions[0]?.status ?? "review", awaitingInspection: Math.max(0, received - inspected), available: Math.min(remaining, Math.max(0, inspected - used)), caseIds: cases.map((c) => c.id) };
    })
  };
}

// src/return-requests.ts
import { eq as eq7, sql as sql8 } from "drizzle-orm";
import { z as z6 } from "zod";
var id4 = z6.string().trim().min(1).max(128);
var key = id4.min(8);
var items = z6.array(z6.object({ lineIndex: z6.number().int().min(0).max(199), quantity: z6.number().int().min(1).max(1e6) }).strict()).min(1).max(50).refine((rows) => new Set(rows.map((r) => r.lineIndex)).size === rows.length, "Choose each line once");
var createSchema = z6.object({ orderId: id4, requestKey: key, reason: z6.string().trim().min(8).max(1e3), reasonCode: z6.enum(RETURN_REASON_CODES).default("unspecified"), items, exchange: z6.object({ productId: id4, variantId: id4.nullable().default(null) }).strict().optional() }).strict().refine((v) => !v.exchange || v.items.length === 1, "Request one original item per exchange");
var decisionSchema = z6.object({
  requestId: id4,
  requestKey: key,
  expectedVersion: id4,
  status: z6.enum(["approved", "declined", "closed"]),
  reason: z6.string().trim().min(8).max(500),
  customerMessage: z6.string().trim().min(8).max(1e3)
}).strict();
var cancelSchema = z6.object({ orderId: id4, requestId: id4, requestKey: key, expectedVersion: id4 }).strict();
var fingerprint = (input, actor) => hashOrderAccess(JSON.stringify({ input, actor }));
var statusOf = (events) => events.at(-1)?.status ?? "pending";
async function owned(ctx, orderId, owner) {
  const order = await findOrderForSession(ctx, orderId, owner.sessionToken, owner.customerId, owner.orderAccessToken);
  if (!order || order.paymentProvider === "admin_test") return null;
  return order;
}
async function requestsForOrder(env, orderId) {
  return commerceDb(env).query.returnRequests.findMany({ where: { orderId }, orderBy: { createdAt: "asc" }, with: {
    exchangePreference: true,
    reasonCategory: true,
    events: { orderBy: (_t, { sql: sql9 }) => sql9`rowid` },
    receipts: { with: { receipt: { columns: { items: true, createdAt: true }, with: { inspections: true } } } }
  } });
}
async function readCustomerReturns(ctx, orderId, owner = {}) {
  if (!await owned(ctx, orderId, owner)) return null;
  const order = await ctx.db.query.orders.findFirst({ where: { id: orderId }, with: { parcelContents: true, fulfillments: { columns: { id: true, kind: true } }, returnReceipts: { with: { refundDecisions: { orderBy: (_t, { sql: sql9 }) => sql9`rowid DESC`, limit: 1 } } } } });
  if (!order) return null;
  const progress = await ctx.db.all(sql8`${recoveryProgressQuery} SELECT id,receiptId,lineIndex,nextAction FROM cases WHERE orderId=${orderId} AND kind='exchange'`);
  const tracking = progress.length ? await readOrderTracking(ctx, orderId, owner.sessionToken, owner.customerId, owner.orderAccessToken) : null;
  const requests = await requestsForOrder(ctx.env, orderId), described = await describeOrderItems(ctx.env, order.items);
  const unknown = order.fulfillments.some((f) => f.kind === "shipment" && !order.parcelContents.some((p) => p.fulfillmentId === f.id));
  const confirmed = ["paid", "partially_refunded", "refunded", "disputed"].includes(order.status);
  const receiptQuantity = (r, lineIndex) => r.receipts.reduce((n, l) => n + (l.receipt.items.find((i) => i.lineIndex === lineIndex)?.quantity ?? 0), 0);
  const lines = described.map((l, lineIndex) => {
    const shipped = order.parcelContents.reduce((n, p) => n + (p.items.find((i) => i.lineIndex === lineIndex)?.quantity ?? 0), 0);
    const received = order.returnReceipts.reduce((n, r) => n + (r.items.find((i) => i.lineIndex === lineIndex)?.quantity ?? 0), 0);
    const held = requests.filter((r) => ["pending", "approved"].includes(statusOf(r.events))).reduce((n, r) => n + Math.max(0, (r.items.find((i) => i.lineIndex === lineIndex)?.quantity ?? 0) - receiptQuantity(r, lineIndex)), 0);
    return { lineIndex, name: [l.productName || "Ordered item", l.variantLabel].filter(Boolean).join(" / "), sku: l.sku, available: confirmed && !unknown ? Math.max(0, shipped - received - held) : 0 };
  });
  return { orderId, unknownParcelContents: unknown, lines, refunds: order.returnReceipts.map((r) => {
    const d = r.refundDecisions[0], sums = /* @__PURE__ */ new Map();
    if (d?.status === "settled") for (const a of d.allocations) sums.set(a.kind, (sums.get(a.kind) ?? 0) + a.amountMinor);
    return { receiptId: r.id, receivedAt: r.createdAt.toISOString(), status: d?.status ?? "review", amountMinor: d?.amountMinor ?? 0, currency: order.currency, updatedAt: (d?.createdAt ?? r.createdAt).toISOString(), tenders: [...sums].map(([kind, amountMinor]) => ({ kind, amountMinor })) };
  }), requests: requests.map((r) => ({
    exchangeProgress: (() => {
      const linked = progress.filter((c) => r.receipts.some((l) => l.receiptId === c.receiptId)), cases = linked.flatMap((c) => {
        const t = tracking?.recoveries.find((t2) => t2.id === c.id);
        return t ? [{ id: t.id, name: t.name, quantity: t.quantity, shipped: t.shipments.reduce((n, s) => n + s.quantity, 0), ...customerRecoveryAction(c.nextAction), parcels: t.shipments.map((s) => ({ quantity: s.quantity, returned: s.returned, awaitingInspection: s.awaitingInspection, carrier: s.carrier, trackingNumber: s.trackingNumber, createdAt: s.shippedAt })) }] : [];
      });
      if (!r.exchangePreference && !cases.length) return null;
      const lineIndices = new Set(r.exchangePreference ? [r.exchangePreference.lineIndex] : linked.map((c) => c.lineIndex));
      const requested = r.items.reduce((n, i) => n + (lineIndices.has(i.lineIndex) ? i.quantity : 0), 0), received = [...lineIndices].reduce((n, i) => n + receiptQuantity(r, i), 0);
      const inspected = r.receipts.reduce((n, l) => n + l.receipt.items.filter((i) => lineIndices.has(i.lineIndex)).reduce((n2, i) => n2 + (i.condition === "inspection" ? l.receipt.inspections.reduce((n3, d) => n3 + (d.items.find((j) => j.lineIndex === i.lineIndex)?.quantity ?? 0), 0) : i.quantity), 0), 0);
      const stages = [], status = statusOf(r.events);
      if (status === "pending") stages.push({ label: "Awaiting exchange review", quantity: requested, nextAction: "Wait for the store\u2019s approval and return instructions." });
      if (["declined", "cancelled"].includes(status)) stages.push({ label: status === "declined" ? "Exchange request declined" : "Exchange request cancelled", quantity: requested, nextAction: "Contact the store if you need help with this decision." });
      if (status === "approved" && requested > received) stages.push({ label: "Waiting for your returned goods", quantity: requested - received, nextAction: "Follow the store\u2019s return instructions below." });
      if (received > inspected) stages.push({ label: "Returned goods awaiting inspection", quantity: received - inspected, nextAction: "The store will inspect these goods. No action is needed from you." });
      const arranged = cases.reduce((n, c) => n + c.quantity, 0);
      if (inspected > arranged) stages.push({ label: "Exchange being arranged", quantity: inspected - arranged, nextAction: "The store will confirm replacement goods and any price adjustment with you." });
      const add = (label, quantity2, nextAction) => {
        if (!quantity2) return;
        const found = stages.find((s) => s.label === label);
        if (found) found.quantity += quantity2;
        else stages.push({ label, quantity: quantity2, nextAction });
      };
      for (const c of cases) {
        const stage = linked.find((l) => l.id === c.id).nextAction;
        const quantity2 = stage === "inspection" ? c.parcels.reduce((n, p) => n + p.awaitingInspection, 0) : stage === "complete" || stage === "review" ? c.quantity : stage === "follow_up" ? c.shipped : Math.max(0, c.quantity - c.shipped);
        add(c.label, quantity2, c.nextAction);
        if (c.shipped && stage !== "follow_up" && stage !== "complete") add("Replacement dispatched", c.shipped, "Use the parcel details below. Contact the store if there is a delivery problem.");
      }
      if (!stages.length) stages.push({ label: "Request closed", quantity: received, nextAction: "Contact the store if you need further help." });
      return { stages, cases };
    })(),
    exchangePreference: r.exchangePreference ? { lineIndex: r.exchangePreference.lineIndex, ...r.exchangePreference.target } : null,
    id: r.id,
    reasonCode: r.reasonCategory?.code ?? "unspecified",
    status: statusOf(r.events),
    version: r.events.at(-1)?.id ?? r.id,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    items: r.items.map((i) => ({ ...i, name: lines[i.lineIndex]?.name ?? "Ordered item", received: receiptQuantity(r, i.lineIndex) })),
    canCancel: ["pending", "approved"].includes(statusOf(r.events)) && !r.receipts.length,
    updates: r.events.map((e) => ({ status: e.status, message: e.customerMessage, createdAt: e.createdAt.toISOString() }))
  })) };
}
async function createCustomerReturn(ctx, input, owner = {}) {
  const v = createSchema.parse(input);
  const order = await owned(ctx, v.orderId, owner);
  if (!order) return null;
  const values = { ...v, items: [...v.items].sort((a, b) => a.lineIndex - b.lineIndex) };
  const requestId = `rma_${await hashOrderAccess(`${v.orderId}:${v.requestKey}`)}`, hash = await fingerprint(values, "customer");
  const replay = async () => {
    const r = await ctx.db.select().from(returnRequests).where(eq7(returnRequests.id, requestId)).get();
    if (!r) return null;
    if (r.fingerprint !== hash) throw new CommerceOperationsConflict("This return request key was used with different details.");
    return { requestId, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  let preference;
  if (v.exchange) {
    if (!["paid", "partially_refunded"].includes(order.status) || order.currency !== readStoreCurrency(ctx.env)) throw new CommerceOperationsConflict("Exchange requests require a confirmed purchase in the current store currency.");
    const catalog = await loadBasketCatalog(ctx, [v.exchange]), product = catalog.products.get(v.exchange.productId);
    if (!product || product.status !== "active" || product.type !== "standard" || !product.isPhysical) throw new CommerceOperationsConflict("Choose an active physical replacement item.");
    requireVariantChoice(catalog, product, v.exchange.variantId ?? void 0);
    const selected = v.exchange.variantId ? resolveSelectedVariant(catalog, product, v.exchange.variantId) : null, description = (await describeOrderItems(ctx.env, [v.exchange]))[0];
    preference = { productId: product.id, variantId: v.exchange.variantId, name: selected?.name ?? product.name, sku: description.sku, priceMinor: selected?.price ?? product.basePrice, currency: order.currency };
    if (!Number.isSafeInteger(preference.priceMinor) || preference.priceMinor < 1 || preference.priceMinor > 1e9) throw new CommerceOperationsConflict("Choose a replacement with a valid current price.");
  }
  const now = /* @__PURE__ */ new Date();
  try {
    await ctx.db.batch([ctx.db.insert(returnRequests).values({ id: requestId, orderId: v.orderId, items: values.items, reason: v.reason, fingerprint: hash, createdAt: now }), ctx.db.insert(returnRequestReasons).values({ requestId, code: v.reasonCode }), ...preference ? [ctx.db.insert(returnExchangePreferences).values({ requestId, lineIndex: v.items[0].lineIndex, target: preference })] : []]);
  } catch (error) {
    const previous2 = await replay();
    if (previous2) return previous2;
    if (!/Return request exceeds available shipped goods|Exchange preference changed/.test(errorText(error))) throw error;
    throw new CommerceOperationsConflict("Return quantities changed or parcel details are unavailable. Refresh before requesting a return.");
  }
  return { requestId };
}
async function appendDecision(env, v, actor, actorKind) {
  const db = commerceDb(env), eventId = `rme_${await hashOrderAccess(`${v.requestId}:${v.requestKey}`)}`, hash = await fingerprint(v, `${actorKind}:${actor}`);
  const replay = async () => {
    const e = await db.select().from(returnRequestEvents).where(eq7(returnRequestEvents.id, eventId)).get();
    if (!e) return null;
    if (e.fingerprint !== hash) throw new CommerceOperationsConflict("This decision key was used with different details.");
    return { eventId, requestId: e.requestId, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  try {
    await db.batch([db.insert(returnRequestEvents).values({ id: eventId, requestId: v.requestId, status: v.status, expectedVersion: v.expectedVersion, actor, actorKind, reason: v.reason, customerMessage: v.customerMessage, fingerprint: hash, createdAt: /* @__PURE__ */ new Date() }), ...actorKind === "staff" ? [db.run(commerceEmailStatement("return_decision", eventId, Math.floor(Date.now() / 1e3)))] : []]);
  } catch (error) {
    const previous2 = await replay();
    if (previous2) return previous2;
    if (!/Return request decision is stale or unavailable|Requested goods were already received/.test(errorText(error))) throw error;
    throw new CommerceOperationsConflict("This return request changed or cannot take that decision. Refresh before continuing.");
  }
  return { eventId, requestId: v.requestId };
}
async function decideReturnRequest(env, input, actor) {
  if (!actor.trim()) throw new CommerceOperationsConflict("An authenticated staff member is required.");
  return appendDecision(env, decisionSchema.parse(input), actor, "staff");
}
async function cancelCustomerReturn(ctx, input, owner = {}) {
  const v = cancelSchema.parse(input);
  if (!await owned(ctx, v.orderId, owner)) return null;
  const request = await ctx.db.select({ orderId: returnRequests.orderId }).from(returnRequests).where(eq7(returnRequests.id, v.requestId)).get();
  if (request?.orderId !== v.orderId) return null;
  return appendDecision(ctx.env, { ...v, status: "cancelled", reason: "Customer cancelled the return request", customerMessage: "You cancelled this return request." }, "customer", "customer");
}
async function readReturnRequestAdmin(env, input) {
  const v = z6.object({ requestId: id4 }).strict().parse(input), db = commerceDb(env);
  const request = await db.query.returnRequests.findFirst({ where: { id: v.requestId }, with: { exchangePreference: true, order: { columns: { id: true, items: true, status: true } }, events: { orderBy: (_t, { sql: sql9 }) => sql9`rowid` }, receipts: { with: { receipt: { with: { inspections: true } } } } } });
  if (!request) throw new CommerceOperationsConflict("Return request not found.");
  const names = await adminActorNames(env, request.events.filter((e) => e.actorKind === "staff").map((e) => e.actor));
  const described = await describeOrderItems(env, request.order.items);
  return {
    exchangePreference: request.exchangePreference ? { lineIndex: request.exchangePreference.lineIndex, ...request.exchangePreference.target } : null,
    id: request.id,
    orderId: request.orderId,
    reason: request.reason,
    status: statusOf(request.events),
    version: request.events.at(-1)?.id ?? request.id,
    createdAt: request.createdAt.toISOString(),
    items: request.items.map((i) => ({
      ...i,
      name: [described[i.lineIndex]?.productName || "Ordered item", described[i.lineIndex]?.variantLabel].filter(Boolean).join(" / "),
      restockMapped: !!request.order.items[i.lineIndex]?.stockTargets?.length,
      received: request.receipts.reduce((n, l) => n + (l.receipt.items.find((j) => j.lineIndex === i.lineIndex)?.quantity ?? 0), 0)
    })),
    events: request.events.map((e) => ({ id: e.id, status: e.status, reason: e.reason, actorKind: e.actorKind, actor: e.actor, customerMessage: e.customerMessage, actorName: e.actorKind === "customer" ? "Customer" : names.get(e.actor) ?? e.actor, createdAt: e.createdAt.toISOString() })),
    receipts: request.receipts.map((l) => ({ receiptId: l.receiptId, createdAt: l.receipt.createdAt.toISOString() }))
  };
}
async function listReturnsQueue(env, input = {}) {
  const v = z6.object({ filter: z6.enum(["active", "pending", "approved", "inspection", "waiting_goods", "arrange_exchange", "all"]).default("active"), orderId: z6.string().trim().max(128).default(""), offset: z6.coerce.number().int().min(0).max(1e6).default(0) }).strict().parse(input);
  const queue = sql8`WITH requests AS (
    SELECT 'request' AS kind,r.id,r.order_id AS orderId,COALESCE((SELECT status FROM _ecommerce_return_request_events e WHERE e.request_id=r.id ORDER BY rowid DESC LIMIT 1),'pending') AS status,r.created_at AS createdAt,r.reason,
    MAX(0,(SELECT sum(json_extract(value,'$.quantity')) FROM json_each(r.items))-COALESCE((SELECT sum(json_extract(i.value,'$.quantity')) FROM _ecommerce_return_request_receipts l JOIN _ecommerce_return_receipts x ON x.id=l.receipt_id,json_each(x.items) i WHERE l.request_id=r.id),0)) AS pendingUnits
    ,EXISTS(SELECT 1 FROM _ecommerce_return_exchange_preferences p JOIN _ecommerce_return_request_receipts l ON l.request_id=p.request_id JOIN _ecommerce_return_receipts x ON x.id=l.receipt_id,json_each(x.items) i
      WHERE p.request_id=r.id AND json_extract(i.value,'$.lineIndex')=p.line_index AND
      (CASE WHEN json_extract(i.value,'$.condition')='inspection' THEN COALESCE((SELECT sum(json_extract(j.value,'$.quantity')) FROM _ecommerce_return_inspections d,json_each(d.items) j WHERE d.receipt_id=x.id AND json_extract(j.value,'$.lineIndex')=p.line_index),0) ELSE json_extract(i.value,'$.quantity') END)>
      COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_cases c WHERE c.receipt_id=x.id AND c.line_index=p.line_index),0)) AS arrangeExchange
    FROM _ecommerce_return_requests r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
  ), inspections AS (
    SELECT 'inspection' AS kind,r.id,r.order_id AS orderId,'inspection' AS status,r.created_at AS createdAt,r.reason,
    (SELECT COALESCE(sum(json_extract(value,'$.quantity')),0) FROM json_each(r.items) WHERE json_extract(value,'$.condition')='inspection')-
    COALESCE((SELECT sum(json_extract(i.value,'$.quantity')) FROM _ecommerce_return_inspections d,json_each(d.items) i WHERE d.receipt_id=r.id),0) AS pendingUnits
    ,0 AS arrangeExchange
    FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
  ), queue AS (SELECT * FROM requests UNION ALL SELECT * FROM inspections WHERE pendingUnits>0)`;
  const filter = v.filter === "waiting_goods" ? sql8`kind='request' AND status='approved' AND pendingUnits>0` : v.filter === "arrange_exchange" ? sql8`kind='request' AND status IN ('approved','closed') AND arrangeExchange=1` : v.filter === "all" ? sql8`1=1` : v.filter === "active" ? sql8`(status='pending' OR status='approved' OR kind='inspection')` : sql8`status=${v.filter}`;
  const where = sql8`${filter} AND (${v.orderId}='' OR orderId=${v.orderId})`, db = commerceDb(env);
  const [rows, total] = await db.batch([db.all(sql8`${queue} SELECT * FROM queue WHERE ${where} ORDER BY createdAt,id LIMIT 50 OFFSET ${v.offset}`), db.all(sql8`${queue} SELECT count(*) n FROM queue WHERE ${where}`)]);
  return { ...v, total: total[0]?.n ?? 0, rows: rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt * 1e3).toISOString() })) };
}
async function readCustomerExchangeChoices(ctx, input, owner = {}) {
  const v = z6.object({ orderId: id4, lineIndex: z6.number().int().min(0).max(199), search: z6.string().trim().max(100).default(""), offset: z6.number().int().min(0).max(1e6).default(0) }).strict().parse(input);
  const returns = await readCustomerReturns(ctx, v.orderId, owner);
  if (!returns) return null;
  if (!returns.lines.some((l) => l.lineIndex === v.lineIndex && l.available > 0)) throw new CommerceOperationsConflict("No received quantities are available for this exchange request.");
  const choices = await listExchangeChoices(ctx.env, { ...v, allowPriceDifference: true });
  return { rows: choices.rows, total: choices.total, offset: choices.offset, currency: choices.currency, originalUnitPrice: choices.price };
}
function customerRecoveryAction(stage) {
  const labels = { inspection: "Returned replacement awaiting inspection", review: "Exchange needs store review", refund: "Exchange refund being reviewed", payment: "Upgrade payment to confirm", stock: "Waiting for replacement stock", dispatch: "Replacement ready to pack", follow_up: "Replacement dispatched \u2014 follow-up open", complete: "Exchange case resolved" };
  const actions = { payment: "Contact the store to agree and confirm the price difference. This page does not collect payment.", follow_up: "Use the parcel details below. Contact the store if there is a delivery problem.", complete: "The store recorded the agreed outcome. This does not confirm delivery." };
  return { label: labels[stage], nextAction: actions[stage] ?? "The store is handling this stage. No action is needed from you unless they contact you." };
}

export {
  PROVIDER_CHECK_MIN_ORDER_AGE_SECONDS,
  PROVIDER_CHECK_RETRY_MESSAGE,
  ProviderCheckLimitedError,
  providerCheckLimitResponse,
  mayAskPaymentProvider,
  UNDELIVERABLE_COUNTRY,
  SHIPPING_OPTION_UNAVAILABLE,
  isCheckoutDetailsError,
  withCountryCode,
  checkoutSchema,
  checkoutInputError,
  TaxCalculationError,
  taxableLines,
  taxAddressFor,
  calculateOrderTax,
  reverseRefundedOrderTax,
  recordMissingTaxTransactions,
  resendPendingTaxReversals,
  reverseUnreversedTax,
  listTaxSyncReview,
  recoverTaxSync,
  PARKED_CHECKOUT_MESSAGE,
  discardCheckoutDiscount,
  findOrder,
  findOrderForSession,
  createOrder,
  updateOrderStatus,
  finalizeOrderPayment,
  recordProviderRefund,
  cancelOrder,
  readOrderTracking,
  physicalStockLocations,
  effectiveDeliveryDate,
  listReplenishment,
  readReplenishment,
  saveReplenishmentPolicy,
  planReplenishmentDelivery,
  recordReplenishmentDelivery,
  verifyExchangeCharge,
  recordRecoveryPaymentEvent,
  commerceContext,
  CART_MAX_LINES,
  CART_MAX_LINE_QUANTITY,
  aggregateComponentDemand,
  loadBasketCatalog,
  resolveSelectedVariant,
  requireVariantChoice,
  checkCartItems,
  quoteCart,
  findCart,
  claimCart,
  getOrCreateCart,
  updateCartItems,
  openRecoveryCase,
  createRecoveryCase,
  recordRecoveryEvent,
  shipRecoveryCase,
  listRecoveryCases,
  readRecoveryCase,
  readRecoveryOrder,
  listExchangeChoices,
  readExchangeHandoff,
  readCustomerReturns,
  createCustomerReturn,
  decideReturnRequest,
  cancelCustomerReturn,
  readReturnRequestAdmin,
  listReturnsQueue,
  readCustomerExchangeChoices
};
