import {
  INVENTORY_COLUMNS,
  fullRefundStatements
} from "./chunk-BFCTU77S.js";
import {
  TaxAddressError
} from "./chunk-BGDJXEM5.js";
import {
  CommerceOperationsConflict,
  adminActorNames,
  deliverCommerceEmail,
  describeOrderItems,
  fulfillCommerceOrder
} from "./chunk-RLJNYAC6.js";
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
  readStoreSettings,
  reconcileFailure,
  uncheckedSessionRefusal
} from "./chunk-5CEWEWY2.js";
import {
  canonicalEmail,
  canonicalEmails,
  canonicalPurchase,
  getReferralPolicy,
  referralReversalStatements
} from "./chunk-L6PZD3R6.js";
import {
  PURCHASED_ORDER_STATUSES,
  claimInterval
} from "./chunk-DIRLX3FV.js";
import {
  commerceDb,
  commitBatch,
  errorText
} from "./chunk-WUDMFQXC.js";
import {
  carts,
  componentReservations,
  customerAccounts,
  discountRedemptions,
  giftCardRedemptions,
  inventoryReservations,
  orders,
  referralCodes,
  returnRequestEvents,
  returnRequests,
  taxReversals,
  taxSyncDecisions
} from "./chunk-OX54ZSQZ.js";
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
  if (!given || typeof given.country !== "string" || !given.country) throw new ShopperError("checkout_details", TAX_ADDRESS_REQUIRED, 400);
  const address = { country: given.country };
  for (const key2 of ["line1", "line2", "city", "state", "postalCode"]) {
    const value = given[key2];
    if (typeof value === "string" && value.trim()) address[key2] = value.trim();
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
    if (cause instanceof TaxAddressError) throw new ShopperError("checkout_details", TAX_ADDRESS_UNUSABLE, 400, { cause });
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
var orderIn = (db, id2, status) => exists(db.select({ one: sql2`1` }).from(orders).where(and2(eq2(orders.id, id2), eq2(orders.status, status))));
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
async function findOrder(ctx, id2) {
  const { db } = ctx;
  const order = await db.select().from(orders).where(eq2(orders.id, id2)).get();
  if (!order) return null;
  return order;
}
async function findOrderForSession(ctx, id2, sessionToken, customerId, orderAccessToken) {
  const { db } = ctx;
  const order = await findOrder(ctx, id2);
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
async function updateOrderStatus(ctx, id2, status, fulfillment) {
  const { env } = ctx;
  if (status !== "fulfilled") throw new Error("Use the payment or cancellation workflow to change order status");
  const order = await findOrder(ctx, id2);
  if (order?.paymentProvider === "admin_test") throw new Error("Admin test orders cannot be fulfilled");
  if (!fulfillment) throw new Error("Audited fulfillment details are required");
  await fulfillCommerceOrder(env, fulfillment.actor, {
    orderId: id2,
    carrier: fulfillment.carrier,
    trackingNumber: fulfillment.trackingNumber,
    note: fulfillment.note
  });
  return await findOrder(ctx, id2);
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
  const timestamp = Math.floor(Date.now() / 1e3);
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
    db.update(orders).set({ status: "paid", updatedAt: at2(timestamp), customerEmail: email, paymentIntentId: params.paymentIntentId ?? null }).where(and2(
      eq2(orders.id, params.orderId),
      eq2(orders.status, "pending"),
      eq2(orders.checkoutSessionId, params.providerId),
      eq2(orders.totalAmount, order.totalAmount)
    ))
  ];
  if (newAccountId) {
    statements.push(db.run(sql2`INSERT INTO _ecommerce_customer_accounts
      (id, email, email_normalized, name, created_at, updated_at)
      SELECT ${newAccountId}, ${email}, ${normalizedEmail}, ${accountName}, ${timestamp}, ${timestamp} FROM _ecommerce_orders
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
        SELECT ${`ref_${order.id}`}, rc.code, rc.account_id, o.user_id, o.id, ${order.referralRewardCents}, o.currency, 'approved', ${timestamp}, ${timestamp}
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
            WHERE recent.status = 'approved' AND recent.created_at > ${timestamp - policy.periodDays * 24 * 60 * 60}
              AND (recent.referrer_account_id = rc.account_id
                OR ${sql2.raw("recent_referrer.email_canonical")} = ${referrerCanonical})) < ${policy.maxPerPeriod}
        ON CONFLICT DO NOTHING`));
    }
  }
  statements.push(
    db.update(discountRedemptions).set({ status: "confirmed", updatedAt: at2(timestamp) }).where(and2(eq2(discountRedemptions.orderId, params.orderId), eq2(discountRedemptions.status, "reserved"), paid)),
    db.update(giftCardRedemptions).set({ status: "confirmed", updatedAt: at2(timestamp) }).where(and2(eq2(giftCardRedemptions.orderId, params.orderId), eq2(giftCardRedemptions.status, "reserved"), paid)),
    db.run(sql2`INSERT INTO _ecommerce_payments
      (id, order_id, provider, provider_id, status, amount, created_at)
      SELECT ${`pay_${crypto.randomUUID()}`}, id, ${params.provider}, ${params.providerId}, 'success', total_amount, ${timestamp} FROM _ecommerce_orders
      WHERE id = ${params.orderId} AND status = 'paid' AND checkout_session_id = ${params.providerId}
      ON CONFLICT(provider, provider_id) DO NOTHING`)
  );
  if (order.cartId) {
    const buyer = db.select({ userId: orders.userId }).from(orders).where(eq2(orders.id, params.orderId));
    statements.push(db.update(carts).set({ closed: true, closedAt: at2(timestamp), updatedAt: at2(timestamp), userId: sql2`COALESCE(${carts.userId}, (${buyer}))` }).where(and2(eq2(carts.id, order.cartId), paidBySession)));
  }
  const confirms = params.provider !== "admin_test";
  if (confirms) {
    statements.push(db.run(commerceEmailStatement(
      "order_confirmation",
      params.orderId,
      timestamp,
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
async function cancelOrder(ctx, id2, options = {}) {
  const { env, db, adapters: paymentAdapters } = ctx;
  const order = await db.select().from(orders).where(eq2(orders.id, id2)).get();
  if (!order) return null;
  if (PURCHASED_ORDER_STATUSES.includes(order.status)) return order;
  const timestamp = Math.floor(Date.now() / 1e3);
  if (order.status === "cancelled") return order;
  if (order.reconcileReviewAt && !options.sessionExpired && !options.reviewRelease) {
    throw new Error(PARKED_CHECKOUT_MESSAGE);
  }
  const reservations = await db.select().from(componentReservations).where(eq2(componentReservations.orderId, id2));
  const inventoryReservations2 = await db.select().from(inventoryReservations).where(eq2(inventoryReservations.orderId, id2));
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
  const released = orderIn(db, id2, "cancelled");
  const statements = [
    db.update(orders).set({
      status: "cancelled",
      updatedAt: at2(timestamp),
      discountCleanupPending: order.creditApplied + order.discountAmount + order.giftCardApplied > 0 && (order.paymentProvider ?? "stripe") === "stripe"
    }).where(and2(eq2(orders.id, id2), notInArray(orders.status, [...PURCHASED_ORDER_STATUSES]))),
    db.update(discountRedemptions).set({ status: "cancelled", updatedAt: at2(timestamp) }).where(and2(eq2(discountRedemptions.orderId, id2), eq2(discountRedemptions.status, "reserved"), released)),
    db.update(giftCardRedemptions).set({ status: "cancelled", updatedAt: at2(timestamp) }).where(and2(eq2(giftCardRedemptions.orderId, id2), eq2(giftCardRedemptions.status, "reserved"), released))
  ];
  if (order.creditApplied > 0) {
    statements.push(db.run(sql2`INSERT INTO _ecommerce_credit_ledger
      (id, account_id, order_id, kind, amount_cents, created_at)
      SELECT ${`credit_release_${id2}`}, user_id, id, 'checkout_release', credit_applied, ${timestamp}
      FROM _ecommerce_orders WHERE id = ${id2} AND status = 'cancelled' AND user_id IS NOT NULL
      ON CONFLICT(order_id, kind) DO NOTHING`));
  }
  for (const reservation of reservations) {
    statements.push(db.run(sql2`UPDATE _ecommerce_components
      SET quantity = quantity + (SELECT quantity FROM _ecommerce_component_reservations
        WHERE id = ${reservation.id} AND released_at IS NULL), updated_at = MAX(updated_at + 1, ${timestamp})
      WHERE id = ${reservation.componentId} AND EXISTS (SELECT 1 FROM _ecommerce_component_reservations
        WHERE id = ${reservation.id} AND released_at IS NULL)
        AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ${id2} AND status = 'cancelled')`));
    statements.push(db.update(componentReservations).set({ releasedAt: at2(timestamp) }).where(and2(eq2(componentReservations.id, reservation.id), isNull2(componentReservations.releasedAt), released)));
  }
  for (const reservation of inventoryReservations2) {
    const { table, quantity } = INVENTORY_COLUMNS[reservation.targetType];
    statements.push(db.run(sql2`UPDATE ${table}
      SET ${sql2.identifier(quantity.name)} = ${sql2.identifier(quantity.name)} + (SELECT quantity FROM _ecommerce_inventory_reservations
        WHERE id = ${reservation.id} AND released_at IS NULL), updated_at = MAX(updated_at + 1, ${timestamp})
      WHERE id = ${reservation.targetId} AND EXISTS (SELECT 1 FROM _ecommerce_inventory_reservations
        WHERE id = ${reservation.id} AND released_at IS NULL)
        AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ${id2} AND status = 'cancelled')`));
    statements.push(db.update(inventoryReservations).set({ releasedAt: at2(timestamp) }).where(and2(eq2(inventoryReservations.id, reservation.id), isNull2(inventoryReservations.releasedAt), released)));
  }
  if (order.cartId) {
    statements.push(db.update(carts).set({ checkoutSessionId: null, updatedAt: at2(timestamp) }).where(and2(eq2(carts.id, order.cartId), released)));
    statements.push(db.update(orders).set({ cartId: null }).where(and2(eq2(orders.id, id2), eq2(orders.status, "cancelled"))));
  }
  if (options.reviewRelease) {
    const { decision } = options.reviewRelease;
    statements.push(db.run(decisionInsert(
      "order",
      "release",
      sql2`status = 'cancelled'`,
      { id: decision.id, paymentReturned, actor: decision.actor, reason: decision.reason, at: timestamp, recordId: id2 }
    )));
  }
  await commitBatch(db, statements);
  const cancelled = await findOrder(ctx, id2);
  if (cancelled?.status === "cancelled" && !otherModeSession && order.creditApplied + order.discountAmount + order.giftCardApplied > 0) {
    const removed = await discardCheckoutDiscount(
      paymentAdapters.find((candidate) => candidate.providerId === (order.paymentProvider ?? "stripe")),
      id2
    );
    if (removed) await db.update(orders).set({ discountCleanupPending: false }).where(eq2(orders.id, id2));
  }
  return cancelled;
}

// src/return-requests.ts
import { eq as eq3, sql as sql3 } from "drizzle-orm";
import { z as z3 } from "zod";
var id = z3.string().trim().min(1).max(128);
var key = id.min(8);
var items = z3.array(z3.object({ lineIndex: z3.number().int().min(0).max(199), quantity: z3.number().int().min(1).max(1e6) }).strict()).min(1).max(50).refine((rows) => new Set(rows.map((r) => r.lineIndex)).size === rows.length, "Choose each line once");
var createSchema = z3.object({ orderId: id, requestKey: key, reason: z3.string().trim().min(8).max(1e3), items }).strict();
var decisionSchema = z3.object({
  requestId: id,
  requestKey: key,
  expectedVersion: id,
  status: z3.enum(["approved", "declined", "closed"]),
  reason: z3.string().trim().min(8).max(500),
  customerMessage: z3.string().trim().min(8).max(1e3)
}).strict();
var cancelSchema = z3.object({ orderId: id, requestId: id, requestKey: key, expectedVersion: id }).strict();
var fingerprint = (input, actor) => hashOrderAccess(JSON.stringify({ input, actor }));
var statusOf = (events) => events.at(-1)?.status ?? "pending";
async function owned(ctx, orderId, owner) {
  const order = await findOrderForSession(ctx, orderId, owner.sessionToken, owner.customerId, owner.orderAccessToken);
  if (!order || order.paymentProvider === "admin_test") return null;
  return order;
}
async function requestsForOrder(env, orderId) {
  return commerceDb(env).query.returnRequests.findMany({ where: { orderId }, orderBy: { createdAt: "asc" }, with: {
    events: { orderBy: (_t, { sql: sql4 }) => sql4`rowid` },
    receipts: { with: { receipt: { columns: { items: true, createdAt: true } } } }
  } });
}
async function readCustomerReturns(ctx, orderId, owner = {}) {
  if (!await owned(ctx, orderId, owner)) return null;
  const order = await ctx.db.query.orders.findFirst({ where: { id: orderId }, with: { parcelContents: true, fulfillments: { columns: { id: true, kind: true } }, returnReceipts: { columns: { items: true } } } });
  if (!order) return null;
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
  return { orderId, unknownParcelContents: unknown, lines, requests: requests.map((r) => ({
    id: r.id,
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
  if (!await owned(ctx, v.orderId, owner)) return null;
  const values = { ...v, items: [...v.items].sort((a, b) => a.lineIndex - b.lineIndex) };
  const requestId = `rma_${await hashOrderAccess(`${v.orderId}:${v.requestKey}`)}`, hash = await fingerprint(values, "customer");
  const replay = async () => {
    const r = await ctx.db.select().from(returnRequests).where(eq3(returnRequests.id, requestId)).get();
    if (!r) return null;
    if (r.fingerprint !== hash) throw new CommerceOperationsConflict("This return request key was used with different details.");
    return { requestId, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  try {
    await ctx.db.insert(returnRequests).values({ id: requestId, orderId: v.orderId, items: values.items, reason: v.reason, fingerprint: hash, createdAt: /* @__PURE__ */ new Date() });
  } catch (error) {
    const previous2 = await replay();
    if (previous2) return previous2;
    if (!errorText(error).includes("Return request exceeds available shipped goods")) throw error;
    throw new CommerceOperationsConflict("Return quantities changed or parcel details are unavailable. Refresh before requesting a return.");
  }
  return { requestId };
}
async function appendDecision(env, v, actor, actorKind) {
  const db = commerceDb(env), eventId = `rme_${await hashOrderAccess(`${v.requestId}:${v.requestKey}`)}`, hash = await fingerprint(v, `${actorKind}:${actor}`);
  const replay = async () => {
    const e = await db.select().from(returnRequestEvents).where(eq3(returnRequestEvents.id, eventId)).get();
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
  const request = await ctx.db.select({ orderId: returnRequests.orderId }).from(returnRequests).where(eq3(returnRequests.id, v.requestId)).get();
  if (request?.orderId !== v.orderId) return null;
  return appendDecision(ctx.env, { ...v, status: "cancelled", reason: "Customer cancelled the return request", customerMessage: "You cancelled this return request." }, "customer", "customer");
}
async function readReturnRequestAdmin(env, input) {
  const v = z3.object({ requestId: id }).strict().parse(input), db = commerceDb(env);
  const request = await db.query.returnRequests.findFirst({ where: { id: v.requestId }, with: { order: { columns: { id: true, items: true, status: true } }, events: { orderBy: (_t, { sql: sql4 }) => sql4`rowid` }, receipts: { with: { receipt: { with: { inspections: true } } } } } });
  if (!request) throw new CommerceOperationsConflict("Return request not found.");
  const names = await adminActorNames(env, request.events.filter((e) => e.actorKind === "staff").map((e) => e.actor));
  const described = await describeOrderItems(env, request.order.items);
  return {
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
  const v = z3.object({ filter: z3.enum(["active", "pending", "approved", "inspection", "all"]).default("active"), orderId: z3.string().trim().max(128).default(""), offset: z3.coerce.number().int().min(0).max(1e6).default(0) }).strict().parse(input);
  const queue = sql3`WITH requests AS (
    SELECT 'request' AS kind,r.id,r.order_id AS orderId,COALESCE((SELECT status FROM _ecommerce_return_request_events e WHERE e.request_id=r.id ORDER BY rowid DESC LIMIT 1),'pending') AS status,r.created_at AS createdAt,r.reason,
    MAX(0,(SELECT sum(json_extract(value,'$.quantity')) FROM json_each(r.items))-COALESCE((SELECT sum(json_extract(i.value,'$.quantity')) FROM _ecommerce_return_request_receipts l JOIN _ecommerce_return_receipts x ON x.id=l.receipt_id,json_each(x.items) i WHERE l.request_id=r.id),0)) AS pendingUnits
    FROM _ecommerce_return_requests r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
  ), inspections AS (
    SELECT 'inspection' AS kind,r.id,r.order_id AS orderId,'inspection' AS status,r.created_at AS createdAt,r.reason,
    (SELECT COALESCE(sum(json_extract(value,'$.quantity')),0) FROM json_each(r.items) WHERE json_extract(value,'$.condition')='inspection')-
    COALESCE((SELECT sum(json_extract(i.value,'$.quantity')) FROM _ecommerce_return_inspections d,json_each(d.items) i WHERE d.receipt_id=r.id),0) AS pendingUnits
    FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
  ), queue AS (SELECT * FROM requests UNION ALL SELECT * FROM inspections WHERE pendingUnits>0)`;
  const filter = v.filter === "all" ? sql3`1=1` : v.filter === "active" ? sql3`(status='pending' OR status='approved' OR kind='inspection')` : sql3`status=${v.filter}`;
  const where = sql3`${filter} AND (${v.orderId}='' OR orderId=${v.orderId})`, db = commerceDb(env);
  const [rows, total] = await db.batch([db.all(sql3`${queue} SELECT * FROM queue WHERE ${where} ORDER BY createdAt,id LIMIT 50 OFFSET ${v.offset}`), db.all(sql3`${queue} SELECT count(*) n FROM queue WHERE ${where}`)]);
  return { ...v, total: total[0]?.n ?? 0, rows: rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt * 1e3).toISOString() })) };
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
  readCustomerReturns,
  createCustomerReturn,
  decideReturnRequest,
  cancelCustomerReturn,
  readReturnRequestAdmin,
  listReturnsQueue
};
