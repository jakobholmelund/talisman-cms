import {
  isCountryCode
} from "./chunk-USNNZXV4.js";
import {
  batchGroups,
  chunked,
  commerceDb,
  commitBatch
} from "./chunk-SXQHVX4E.js";
import {
  carts,
  creditLedger,
  customerAccounts,
  customerSessions,
  customers,
  discountRedemptions,
  giftCardClaims,
  giftCardPurchases,
  orders,
  rateLimits,
  recoveryCases,
  recoveryEvents,
  recoveryInspections,
  recoveryPayments,
  recoveryReceipts,
  recoveryShipments,
  referralCodes,
  referrals,
  returnReceipts,
  returnRefundDecisions,
  returnRequestEvents,
  returnRequests,
  shopperAudits,
  signInTokens
} from "./chunk-PLAJXKV3.js";
import {
  SUPPORTED_CURRENCIES,
  isSupportedCurrency
} from "./chunk-HNDRZISR.js";
import {
  orderReference
} from "./chunk-C66AEOTN.js";

// src/shopper-privacy.ts
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
var requestSchema = z.object({
  accountId: z.string().min(1).max(128),
  action: z.enum(["export", "revoke", "anonymize"]),
  reason: z.string().trim().min(8).max(500)
}).strict();
var ShopperPrivacyError = class extends Error {
};
async function manageShopperData(env, actor, input) {
  const values = requestSchema.parse(input);
  if (!actor.trim()) throw new ShopperPrivacyError("An authenticated actor is required");
  const db = commerceDb(env);
  const account = await db.select().from(customerAccounts).where(eq(customerAccounts.id, values.accountId)).get();
  if (!account || account.anonymizedAt) throw new ShopperPrivacyError("Shopper account is unavailable");
  const now = /* @__PURE__ */ new Date();
  const auditId = `spa_${crypto.randomUUID()}`;
  const available = and(eq(customerAccounts.id, account.id), isNull(customerAccounts.anonymizedAt));
  const noObligations = sql`credit_balance = 0
    AND NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_cases c JOIN _ecommerce_orders o ON o.id=c.order_id WHERE o.user_id=${account.id} AND (COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=c.id AND actor='payment_provider'),0)>COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=c.id AND kind='resolve'),0)))
    AND NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_receipts r JOIN _ecommerce_recovery_shipments s ON s.id=r.shipment_id JOIN _ecommerce_recovery_cases c ON c.id=s.case_id JOIN _ecommerce_orders o ON o.id=c.order_id WHERE o.user_id=${account.id} AND r.quantity>COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_inspections WHERE receipt_id=r.id),0))
    AND NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_cases c JOIN _ecommerce_orders o ON o.id=c.order_id WHERE o.user_id=${account.id} AND COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),'open')='open')
    AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders o WHERE o.user_id = ${account.id}
      AND (o.status IN ('pending','disputed') OR (o.status IN ('paid','partially_refunded') AND o.fulfillment_status <> 'fulfilled'
        AND (o.shipping_address IS NOT NULL OR EXISTS (SELECT 1 FROM json_each(o.items) i JOIN _ecommerce_products p ON p.id = json_extract(i.value, '$.productId') WHERE p.is_physical = 1)))))
    AND NOT EXISTS (SELECT 1 FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE o.user_id=${account.id} AND COALESCE((SELECT status FROM _ecommerce_return_refund_decisions d WHERE d.receipt_id=r.id ORDER BY rowid DESC LIMIT 1),'review') IN ('review','needed'))
    AND NOT EXISTS (SELECT 1 FROM _ecommerce_return_requests r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE o.user_id=${account.id}
      AND COALESCE((SELECT status FROM _ecommerce_return_request_events e WHERE e.request_id=r.id ORDER BY rowid DESC LIMIT 1),'pending') IN ('pending','approved'))
    AND NOT EXISTS (SELECT 1 FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id,json_each(r.items) i WHERE o.user_id=${account.id} AND json_extract(i.value,'$.condition')='inspection'
      AND json_extract(i.value,'$.quantity')>COALESCE((SELECT sum(json_extract(j.value,'$.quantity')) FROM _ecommerce_return_inspections d,json_each(d.items) j WHERE d.receipt_id=r.id AND json_extract(j.value,'$.lineIndex')=json_extract(i.value,'$.lineIndex')),0))
    AND NOT EXISTS (SELECT 1 FROM _ecommerce_referrals r WHERE (r.referrer_account_id = ${account.id} OR r.referred_account_id = ${account.id})
      AND r.status = 'approved' AND NOT EXISTS (SELECT 1 FROM _ecommerce_credit_ledger l WHERE l.order_id = r.order_id
        AND l.account_id = ${account.id} AND l.kind IN ('welcome_award','referral_award')))
    AND NOT EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p WHERE lower(p.buyer_email) = ${account.emailNormalized}
      AND (p.status IN ('pending','review') OR EXISTS (SELECT 1 FROM _ecommerce_gift_cards c WHERE
        (c.purchase_id = p.id OR c.replaces_purchase_id = p.id) AND c.status <> 'void' AND c.balance_cents > 0)))`;
  const guard = values.action === "anonymize" ? and(available, noObligations) : available;
  const audit = db.run(sql`INSERT INTO _ecommerce_shopper_audits (id,account_id,action,actor,reason,created_at)
    SELECT ${auditId},id,${values.action},${actor},${values.reason},${Math.floor(now.getTime() / 1e3)}
    FROM _ecommerce_customer_accounts WHERE ${guard}`);
  const recorded = sql`EXISTS (SELECT 1 FROM _ecommerce_shopper_audits WHERE id = ${auditId})`;
  if (values.action === "export") {
    const [orders2, credit, referrals2, purchases, discounts] = await db.batch([
      db.select().from(orders).where(eq(orders.userId, account.id)),
      db.select().from(creditLedger).where(eq(creditLedger.accountId, account.id)),
      db.select().from(referrals).where(or(eq(referrals.referrerAccountId, account.id), eq(referrals.referredAccountId, account.id))),
      db.select({
        id: giftCardPurchases.id,
        amountCents: giftCardPurchases.amountCents,
        status: giftCardPurchases.status,
        currency: giftCardPurchases.currency,
        providerRefundedCents: giftCardPurchases.providerRefundedCents,
        createdAt: giftCardPurchases.createdAt
      }).from(giftCardPurchases).where(eq(sql`lower(${giftCardPurchases.buyerEmail})`, account.emailNormalized)),
      db.select().from(discountRedemptions).where(eq(discountRedemptions.accountId, account.id))
    ]);
    const orderIds = orders2.map((order) => order.id);
    const details = orderIds.length ? await db.query.orders.findMany({
      where: { userId: account.id },
      columns: { id: true },
      with: {
        returnRequests: { columns: { id: true, items: true, reason: true, createdAt: true }, with: { exchangePreference: { columns: { lineIndex: true, target: true } }, reasonCategory: { columns: { code: true } }, events: { columns: { status: true, customerMessage: true, createdAt: true } } } },
        returnReceipts: { columns: { id: true, items: true, createdAt: true }, with: { refundDecisions: { columns: { status: true, amountMinor: true, createdAt: true } } } },
        recoveryCases: { columns: { id: true, kind: true, lineIndex: true, quantity: true, createdAt: true }, with: { payments: { columns: { amountMinor: true, currency: true, createdAt: true } }, shipments: { columns: { quantity: true, carrier: true, trackingNumber: true, createdAt: true }, with: { receipts: { columns: { quantity: true, createdAt: true }, with: { inspections: { columns: { quantity: true, disposition: true, restock: true, createdAt: true } } } } } }, events: { columns: { kind: true, status: true, carrier: true, trackingNumber: true, createdAt: true } } } },
        providerRefunds: { columns: { amountCents: true, createdAt: true } },
        giftCardRefunds: { columns: { amountCents: true, createdAt: true } },
        fulfillments: { columns: { kind: true, carrier: true, trackingNumber: true, createdAt: true } }
      }
    }) : [];
    await audit;
    return {
      version: 1,
      exportedAt: now.toISOString(),
      account: {
        id: account.id,
        email: account.email,
        name: account.name,
        creditBalance: account.creditBalance,
        createdAt: account.createdAt
      },
      orders: orders2.map((order) => ({
        id: order.id,
        status: order.status,
        fulfillmentStatus: order.fulfillmentStatus,
        items: order.items,
        totalAmount: order.totalAmount,
        subtotalAmount: order.subtotalAmount,
        shippingAmount: order.shippingAmount,
        taxAmount: order.taxAmount,
        creditApplied: order.creditApplied,
        discountAmount: order.discountAmount,
        giftCardApplied: order.giftCardApplied,
        currency: order.currency,
        customerEmail: order.customerEmail,
        shippingAddress: order.shippingAddress,
        billingAddress: order.billingAddress,
        providerRefundedCents: order.providerRefundedCents,
        giftCardRefundedCents: order.giftCardRefundedCents,
        createdAt: order.createdAt,
        operations: details.find((detail) => detail.id === order.id)
      })),
      credit: credit.map(({ kind, amountCents, orderId, createdAt }) => ({ kind, amountCents, orderId, createdAt })),
      referrals: referrals2.map(({ orderId, rewardCents, currency, status, createdAt }) => ({ orderId, rewardCents, currency, status, createdAt })),
      giftCardPurchases: purchases,
      discounts: discounts.map(({ code, orderId, amountCents, status, createdAt }) => ({ code, orderId, amountCents, status, createdAt }))
    };
  }
  const ownedPurchases = db.select({ id: giftCardPurchases.id }).from(giftCardPurchases).where(eq(sql`lower(${giftCardPurchases.buyerEmail})`, account.emailNormalized));
  const statements = [
    audit,
    db.update(customerAccounts).set({ sessionVersion: sql`${customerAccounts.sessionVersion} + 1` }).where(and(available, recorded)),
    db.update(customerSessions).set({ revokedAt: now }).where(and(eq(customerSessions.accountId, account.id), recorded)),
    db.update(signInTokens).set({ revokedAt: now }).where(and(eq(signInTokens.emailNormalized, account.emailNormalized), recorded)),
    db.update(carts).set({ sessionToken: null, version: sql`${carts.version} + 1` }).where(and(or(eq(carts.userId, account.id), inArray(
      carts.id,
      db.select({ id: orders.cartId }).from(orders).where(eq(orders.userId, account.id))
    )), recorded)),
    db.update(orders).set({ guestAccessTokenHash: null, guestBasketTokenHash: null }).where(and(eq(orders.userId, account.id), recorded)),
    db.update(giftCardClaims).set({ revokedAt: now }).where(and(inArray(giftCardClaims.purchaseId, ownedPurchases), recorded)),
    db.update(giftCardPurchases).set({ accessTokenHash: `revoked_${auditId}` }).where(and(inArray(giftCardPurchases.id, ownedPurchases), recorded))
  ];
  if (values.action === "anonymize") {
    const anonymousEmail = `${account.id}@anonymized.invalid`;
    statements.push(
      db.update(recoveryPayments).set({ reason: "[redacted]", redactedAt: now }).where(and(isNull(recoveryPayments.redactedAt), inArray(recoveryPayments.caseId, db.select({ id: recoveryCases.id }).from(recoveryCases).where(inArray(recoveryCases.orderId, db.select({ id: orders.id }).from(orders).where(eq(orders.userId, account.id))))), recorded)),
      db.update(recoveryReceipts).set({ reason: "[redacted]", redactedAt: now }).where(and(isNull(recoveryReceipts.redactedAt), sql`${recoveryReceipts.shipmentId} IN (SELECT s.id FROM _ecommerce_recovery_shipments s JOIN _ecommerce_recovery_cases c ON c.id=s.case_id JOIN _ecommerce_orders o ON o.id=c.order_id WHERE o.user_id=${account.id})`, recorded)),
      db.update(recoveryInspections).set({ reason: "[redacted]", redactedAt: now }).where(and(isNull(recoveryInspections.redactedAt), sql`${recoveryInspections.receiptId} IN (SELECT r.id FROM _ecommerce_recovery_receipts r JOIN _ecommerce_recovery_shipments s ON s.id=r.shipment_id JOIN _ecommerce_recovery_cases c ON c.id=s.case_id JOIN _ecommerce_orders o ON o.id=c.order_id WHERE o.user_id=${account.id})`, recorded)),
      db.update(recoveryCases).set({ reason: "[redacted]", redactedAt: now }).where(and(isNull(recoveryCases.redactedAt), inArray(recoveryCases.orderId, db.select({ id: orders.id }).from(orders).where(eq(orders.userId, account.id))), recorded)),
      db.update(recoveryEvents).set({ reason: "[redacted]", redactedAt: now }).where(and(isNull(recoveryEvents.redactedAt), inArray(recoveryEvents.caseId, db.select({ id: recoveryCases.id }).from(recoveryCases).where(inArray(recoveryCases.orderId, db.select({ id: orders.id }).from(orders).where(eq(orders.userId, account.id))))), recorded)),
      db.update(recoveryShipments).set({ reason: "[redacted]", redactedAt: now }).where(and(isNull(recoveryShipments.redactedAt), inArray(recoveryShipments.caseId, db.select({ id: recoveryCases.id }).from(recoveryCases).where(inArray(recoveryCases.orderId, db.select({ id: orders.id }).from(orders).where(eq(orders.userId, account.id))))), recorded)),
      db.update(returnRefundDecisions).set({ reason: "[redacted]", redactedAt: now }).where(and(isNull(returnRefundDecisions.redactedAt), inArray(returnRefundDecisions.receiptId, db.select({ id: returnReceipts.id }).from(returnReceipts).where(inArray(returnReceipts.orderId, db.select({ id: orders.id }).from(orders).where(eq(orders.userId, account.id))))), recorded)),
      db.update(returnRequests).set({ reason: "[redacted]", redactedAt: now }).where(and(isNull(returnRequests.redactedAt), inArray(returnRequests.orderId, db.select({ id: orders.id }).from(orders).where(eq(orders.userId, account.id))), recorded)),
      db.update(returnRequestEvents).set({ reason: "[redacted]", customerMessage: "", redactedAt: now }).where(and(isNull(returnRequestEvents.redactedAt), inArray(returnRequestEvents.requestId, db.select({ id: returnRequests.id }).from(returnRequests).where(inArray(returnRequests.orderId, db.select({ id: orders.id }).from(orders).where(eq(orders.userId, account.id))))), recorded)),
      db.update(orders).set({ customerEmail: null, shippingAddress: null, billingAddress: null }).where(and(eq(orders.userId, account.id), recorded)),
      db.update(discountRedemptions).set({ emailNormalized: anonymousEmail }).where(and(eq(discountRedemptions.accountId, account.id), recorded)),
      db.update(giftCardPurchases).set({ buyerEmail: anonymousEmail }).where(and(inArray(giftCardPurchases.id, ownedPurchases), recorded)),
      db.update(customers).set({ email: null, name: null, stripeCustomerId: null }).where(and(or(eq(customers.userId, account.id), eq(sql`lower(${customers.email})`, account.emailNormalized)), recorded)),
      db.update(signInTokens).set({ emailNormalized: anonymousEmail }).where(and(eq(signInTokens.emailNormalized, account.emailNormalized), recorded)),
      db.update(referralCodes).set({ active: false }).where(and(eq(referralCodes.accountId, account.id), recorded)),
      db.update(customerAccounts).set({
        email: anonymousEmail,
        emailNormalized: anonymousEmail,
        name: null,
        cmsUserId: null,
        emailVerifiedAt: null,
        anonymizedAt: now,
        updatedAt: now
      }).where(and(available, recorded))
    );
  }
  await commitBatch(db, statements);
  if (!await db.select({ id: shopperAudits.id }).from(shopperAudits).where(eq(shopperAudits.id, auditId)).get())
    throw new ShopperPrivacyError("Resolve open payments, deliveries, gift cards, open returns and credit awards before anonymizing this shopper");
  return { accountId: account.id, action: values.action, accountingRetained: true };
}

// src/customer-hub.ts
import { and as and2, count, desc, eq as eq2, sql as sql2 } from "drizzle-orm";

// src/store-settings.ts
import { z as z2 } from "zod";
import { readBinding } from "talisman-cms/env";
var StoreSettingsError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "StoreSettingsError";
  }
};
function readStoreSettings(env) {
  const currency = readCurrency(env);
  const deliveryCountries = readDeliveryCountries(env);
  const shippingRates = readShippingRates(env, deliveryCountries);
  return { currency, deliveryCountries, shippingRates, tax: readTax(env) };
}
function readStoreCurrency(env) {
  return readCurrency(env);
}
function reportStoreSettingsError(error) {
  console.error(`[Commerce] Store settings are invalid: ${error.message}`);
  return "Checkout is temporarily unavailable.";
}
function readText(env, name) {
  const value = readBinding(env, name);
  if (value === void 0) return void 0;
  if (typeof value !== "string") throw new StoreSettingsError(`TALISMAN_${name} must be text`);
  return value.trim();
}
function readCurrency(env) {
  const value = readText(env, "COMMERCE_CURRENCY");
  if (value === void 0) return "usd";
  const currency = value.toLowerCase();
  if (!isSupportedCurrency(currency)) {
    throw new StoreSettingsError(`TALISMAN_COMMERCE_CURRENCY must be one of the supported ISO 4217 codes (${SUPPORTED_CURRENCIES.join(", ")}), not ${JSON.stringify(value)}`);
  }
  return currency;
}
function readDeliveryCountries(env) {
  const name = "TALISMAN_COMMERCE_DELIVERY_COUNTRIES";
  const value = readBinding(env, "COMMERCE_DELIVERY_COUNTRIES");
  if (value === void 0) return null;
  const entries = typeof value === "string" ? value.split(/[\s,]+/) : Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
  if (!entries) throw new StoreSettingsError(`${name} must be text or a list of text`);
  const given = [...new Set(entries.map((entry) => entry.trim()).filter(Boolean))];
  const invalid = given.filter((entry) => !isCountryCode(entry.toUpperCase()));
  if (invalid.length) {
    throw new StoreSettingsError(`${name} must list officially assigned ISO 3166-1 alpha-2 codes such as "US", not ${invalid.map((entry) => JSON.stringify(entry)).join(", ")}`);
  }
  if (!given.length) {
    throw new StoreSettingsError(`${name} lists no countries; leave it unset to deliver to any country`);
  }
  return [...new Set(given.map((entry) => entry.toUpperCase()))];
}
var MAX_SHIPPING_RATES = 10;
var deliveryDays = z2.number().int().min(1).max(365);
var minorUnits = z2.number().int().max(Number.MAX_SAFE_INTEGER);
var shippingRateSchema = z2.object({
  id: z2.string().regex(/^[a-z0-9_-]{1,40}$/, "must be 1 to 40 characters from a-z, 0-9, _ and -"),
  label: z2.string().trim().min(1).max(100),
  amount: minorUnits.min(0),
  countries: z2.array(z2.string()).nullish().superRefine((entries, context) => {
    if (!entries) return;
    const invalid = entries.filter((entry) => !isCountryCode(entry.trim().toUpperCase()));
    if (invalid.length) {
      context.addIssue({ code: "custom", message: `must list officially assigned ISO 3166-1 alpha-2 codes such as "US", not ${invalid.map((entry) => JSON.stringify(entry)).join(", ")}` });
    } else if (!entries.length) {
      context.addIssue({ code: "custom", message: "lists no countries; leave it out to serve every delivery country" });
    }
  }),
  freeOver: minorUnits.positive().nullish(),
  minDays: deliveryDays.nullish(),
  maxDays: deliveryDays.nullish()
}).strict().refine(
  (rate) => rate.minDays == null || rate.maxDays == null || rate.minDays <= rate.maxDays,
  { message: "must not be more than maxDays", path: ["minDays"] }
);
var shippingRatesSchema = z2.array(shippingRateSchema).superRefine((rates, context) => {
  const seen = /* @__PURE__ */ new Set();
  rates.forEach((rate, index) => {
    if (seen.has(rate.id)) {
      context.addIssue({
        code: "custom",
        path: [index, "id"],
        message: `${JSON.stringify(rate.id)} is used by another rate`
      });
    }
    seen.add(rate.id);
  });
});
function readShippingRates(env, deliveryCountries) {
  const name = "TALISMAN_COMMERCE_SHIPPING_RATES";
  const value = readBinding(env, "COMMERCE_SHIPPING_RATES");
  if (value === void 0) return [];
  let list = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch (error) {
      throw new StoreSettingsError(`${name} must be valid JSON: ${error instanceof Error ? error.message : "parse error"}`);
    }
  }
  if (!Array.isArray(list)) throw new StoreSettingsError(`${name} must be a JSON list of shipping rates`);
  if (!list.length) throw new StoreSettingsError(`${name} lists no rates; leave it unset to charge no shipping`);
  if (list.length > MAX_SHIPPING_RATES) {
    throw new StoreSettingsError(`${name} must list at most ${MAX_SHIPPING_RATES} rates, not ${list.length}`);
  }
  const parsed = shippingRatesSchema.safeParse(list, {
    error: (issue) => issue.code === "invalid_type" && issue.input === void 0 ? "Required" : void 0
  });
  if (!parsed.success) {
    throw new StoreSettingsError(parsed.error.issues.map((issue) => `${name}${issue.path.map((key) => typeof key === "number" ? `[${key}]` : `.${String(key)}`).join("")}: ${issue.message}`).join("; "));
  }
  return parsed.data.map((rate, index) => {
    const countries = rate.countries ? [...new Set(rate.countries.map((entry) => entry.trim().toUpperCase()))] : null;
    const outside = countries && deliveryCountries ? countries.filter((code) => !deliveryCountries.includes(code)) : [];
    if (outside.length) {
      throw new StoreSettingsError(`${name}[${index}].countries: must be among TALISMAN_COMMERCE_DELIVERY_COUNTRIES, not ${outside.map((code) => JSON.stringify(code)).join(", ")}`);
    }
    return {
      id: rate.id,
      label: rate.label,
      amount: rate.amount,
      countries,
      freeOver: rate.freeOver ?? null,
      minDays: rate.minDays ?? null,
      maxDays: rate.maxDays ?? null
    };
  });
}
var TAX_MODES = ["none", "stripe-inclusive", "stripe-exclusive"];
function readTax(env) {
  const modeText = readText(env, "COMMERCE_TAX");
  const mode = TAX_MODES.find((candidate) => candidate === modeText?.toLowerCase());
  if (modeText !== void 0 && !mode) {
    throw new StoreSettingsError(`TALISMAN_COMMERCE_TAX must be "none", "stripe-inclusive" or "stripe-exclusive", not ${JSON.stringify(modeText)}`);
  }
  const taxCode = readText(env, "COMMERCE_TAX_CODE");
  if (taxCode !== void 0 && !/^txcd_[0-9]{8}$/.test(taxCode)) {
    throw new StoreSettingsError(`TALISMAN_COMMERCE_TAX_CODE must be a Stripe tax code such as "txcd_99999999", not ${JSON.stringify(taxCode)}`);
  }
  const shipFrom = readText(env, "COMMERCE_SHIP_FROM_COUNTRY");
  if (shipFrom !== void 0 && !isCountryCode(shipFrom.toUpperCase())) {
    throw new StoreSettingsError(`TALISMAN_COMMERCE_SHIP_FROM_COUNTRY must be an officially assigned ISO 3166-1 alpha-2 code such as "US", not ${JSON.stringify(shipFrom)}`);
  }
  return { mode: mode ?? "none", taxCode: taxCode ?? null, shipFromCountry: shipFrom?.toUpperCase() ?? null };
}

// src/order-items.ts
var orderAmountColumns = {
  subtotalAmount: orders.subtotalAmount,
  discountCode: orders.discountCode,
  discountAmount: orders.discountAmount,
  creditApplied: orders.creditApplied,
  shippingAmount: orders.shippingAmount,
  shippingLabel: orders.shippingLabel,
  taxAmount: orders.taxAmount,
  taxBehavior: orders.taxBehavior,
  giftCardApplied: orders.giftCardApplied,
  totalAmount: orders.totalAmount,
  providerRefundedCents: orders.providerRefundedCents,
  giftCardRefundedCents: orders.giftCardRefundedCents
};
function orderAmounts(row) {
  const amounts = [{ key: "itemsSubtotal", label: "Items subtotal", cents: row.subtotalAmount || row.totalAmount }];
  if (row.discountAmount > 0) {
    amounts.push({ key: "discount", label: row.discountCode ? `Discount (${row.discountCode})` : "Discount", cents: -row.discountAmount });
  }
  if (row.creditApplied > 0) amounts.push({ key: "storeCredit", label: "Store credit", cents: -row.creditApplied });
  if (row.shippingAmount > 0 || row.shippingLabel) {
    amounts.push({ key: "shipping", label: row.shippingLabel ? `Shipping (${row.shippingLabel})` : "Shipping", cents: row.shippingAmount });
  }
  if (row.taxAmount > 0) {
    amounts.push(row.taxBehavior === "inclusive" ? { key: "taxIncluded", label: "Tax included in the prices", cents: row.taxAmount } : { key: "tax", label: "Tax", cents: row.taxAmount });
  }
  if (row.giftCardApplied > 0) amounts.push({ key: "giftCard", label: "Gift card", cents: -row.giftCardApplied });
  amounts.push({ key: "charged", label: "Charged by the payment provider", cents: row.totalAmount });
  if (row.providerRefundedCents > 0) {
    amounts.push({ key: "providerRefunded", label: "Refunded by the payment provider", cents: row.providerRefundedCents });
  }
  if (row.giftCardRefundedCents > 0) {
    amounts.push({ key: "giftCardRefunded", label: "Refunded to the gift card", cents: row.giftCardRefundedCents });
  }
  return amounts;
}
async function describeOrderItems(env, items) {
  const db = commerceDb(env);
  const productIds = [...new Set(items.map((item) => item.productId))];
  const variantIds = [...new Set(items.flatMap((item) => item.variantId ? [item.variantId] : []))];
  const rows = await batchGroups(db, {
    products: chunked(productIds).map((ids) => db.query.products.findMany({
      columns: { id: true, name: true, sku: true },
      where: { id: { in: ids } }
    })),
    values: chunked(variantIds).map((ids) => db.query.productVariantValues.findMany({
      columns: { id: true, value: true, sku: true },
      where: { id: { in: ids } },
      with: { productVariant: { columns: { name: true, sku: true }, with: { variant: { columns: { name: true } } } } }
    })),
    // A variant group without values is sold as itself.
    groups: chunked(variantIds).map((ids) => db.query.productVariants.findMany({
      columns: { id: true, name: true, sku: true },
      where: { id: { in: ids } }
    }))
  });
  const products = new Map(rows.products.map((row) => [row.id, row]));
  const values = new Map(rows.values.map((row) => [row.id, row]));
  const groups = new Map(rows.groups.map((row) => [row.id, row]));
  return items.map((item) => {
    const product = products.get(item.productId);
    const value = item.variantId ? values.get(item.variantId) : void 0;
    const group = item.variantId && !value ? groups.get(item.variantId) : void 0;
    return {
      ...item,
      productName: product?.name ?? null,
      variantLabel: value ? `${value.productVariant.variant?.name ?? value.productVariant.name}: ${value.value}` : group?.name ?? null,
      sku: (value ? value.sku || value.productVariant.sku : group?.sku) || product?.sku || null
    };
  });
}

// src/customer-hub.ts
async function readCustomerHub(env, sessionToken, requestedPage = 1) {
  const account = await findCustomerSession(env, sessionToken);
  if (!account) return null;
  const db = commerceDb(env);
  const owned = and2(eq2(orders.userId, account.id), sql2`COALESCE(${orders.paymentProvider}, 'stripe') <> 'admin_test'`);
  const totals = await db.select({ count: count() }).from(orders).where(owned).get();
  const total = totals?.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / 12));
  const page = Math.min(pages, Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
  const rows = await db.select({
    id: orders.id,
    status: orders.status,
    fulfillmentStatus: orders.fulfillmentStatus,
    createdAt: orders.createdAt,
    currency: orders.currency,
    items: orders.items,
    totalAmount: orders.totalAmount,
    giftCardApplied: orders.giftCardApplied,
    creditApplied: orders.creditApplied,
    providerRefundedCents: orders.providerRefundedCents,
    giftCardRefundedCents: orders.giftCardRefundedCents,
    paymentUnderReview: sql2`(${orders.status} = 'pending' AND ${orders.reconcileReviewAt} IS NOT NULL)`.mapWith(Boolean),
    openReturns: sql2`(SELECT count(*) FROM _ecommerce_return_requests r WHERE r.order_id = ${orders.id} AND r.redacted_at IS NULL
      AND COALESCE((SELECT e.status FROM _ecommerce_return_request_events e WHERE e.request_id = r.id ORDER BY e.rowid DESC LIMIT 1), 'pending') IN ('pending', 'approved'))`.mapWith(Number)
  }).from(orders).where(owned).orderBy(desc(orders.createdAt), desc(orders.id)).limit(12).offset((page - 1) * 12);
  const descriptions = await describeOrderItems(env, rows.flatMap((order) => order.items));
  let offset = 0;
  return {
    account: { email: account.email, name: account.name, creditBalance: account.creditBalance, currency: readStoreCurrency(env) },
    total,
    page,
    pages,
    orders: rows.map((order) => {
      const items = descriptions.slice(offset, offset += order.items.length).map((item) => ({
        productId: item.productId,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        productName: item.productName,
        variantLabel: item.variantLabel,
        sku: item.sku
      }));
      return { ...order, items, reference: orderReference(order.id), orderTotal: order.totalAmount + order.giftCardApplied + order.creditApplied };
    })
  };
}

// src/accounts.ts
import { and as and4, count as count2, eq as eq4, gt as gt2, inArray as inArray2, isNotNull, isNull as isNull2, or as or2, sql as sql4 } from "drizzle-orm";
import { ensureVerifiedEmailIdentity } from "talisman-cms/auth/identity";
import { parseAddress } from "talisman-cms/email";
import { readSetting as readSetting2 } from "talisman-cms/env";

// src/rate-limits.ts
import { and as and3, eq as eq3, gt, lte, sql as sql3 } from "drizzle-orm";
var MAX_RATE_LIMIT_WINDOW_SECONDS = 24 * 60 * 60;
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function rateLimitSource(ip) {
  const value = ip.trim().toLowerCase();
  if (!value.includes(":")) return value;
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  const halves = value.split("::");
  if (halves.length > 2) return value;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const width = [...left, ...right].reduce((count3, group) => count3 + (group.includes(".") ? 2 : 1), 0);
  if (halves.length === 1 ? width !== 8 : width > 7) return value;
  const groups = [...left, ...Array(8 - width).fill("0"), ...right].slice(0, 4);
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return value;
  return `${groups.map((group) => parseInt(group, 16).toString(16)).join(":")}::/64`;
}
async function countRequest(env, key, now, windowSeconds) {
  if (!(windowSeconds > 0 && windowSeconds <= MAX_RATE_LIMIT_WINDOW_SECONDS)) {
    throw new RangeError("Rate-limit windows must be between 1 second and 24 hours");
  }
  const ended = sql3`${rateLimits.windowStart} <= ${now - windowSeconds}`;
  const [limit] = await commerceDb(env).insert(rateLimits).values({ key, count: 1, windowStart: now }).onConflictDoUpdate({ target: rateLimits.key, set: {
    count: sql3`CASE WHEN ${ended} THEN 1 ELSE ${rateLimits.count} + 1 END`,
    windowStart: sql3`CASE WHEN ${ended} THEN ${now} ELSE ${rateLimits.windowStart} END`
  } }).returning({ count: rateLimits.count });
  return limit?.count;
}
async function peekRequestCount(env, key, now, windowSeconds) {
  const row = await commerceDb(env).select({ count: rateLimits.count }).from(rateLimits).where(and3(eq3(rateLimits.key, key), gt(rateLimits.windowStart, now - windowSeconds))).get();
  return row?.count ?? 0;
}
async function clientOverLimit(env, bucket, sourceIp, { limit, windowSeconds, now = Math.floor(Date.now() / 1e3) }) {
  if (!sourceIp || sourceIp.length > 64) return false;
  const count3 = await countRequest(env, `${bucket}:${await sha256Hex(rateLimitSource(sourceIp))}`, now, windowSeconds);
  return (count3 ?? limit + 1) > limit;
}
async function claimInterval(env, key, intervalSeconds, now = Math.floor(Date.now() / 1e3)) {
  if (!(intervalSeconds > 0 && intervalSeconds <= MAX_RATE_LIMIT_WINDOW_SECONDS)) {
    throw new RangeError("Rate-limit windows must be between 1 second and 24 hours");
  }
  const [claimed] = await commerceDb(env).insert(rateLimits).values({ key, count: 1, windowStart: now }).onConflictDoUpdate({
    target: rateLimits.key,
    set: { count: 1, windowStart: sql3`excluded.window_start` },
    setWhere: lte(rateLimits.windowStart, now - intervalSeconds)
  }).returning({ windowStart: rateLimits.windowStart });
  return Boolean(claimed);
}

// src/turnstile.ts
import { readSetting } from "talisman-cms/env";
var SHOPPER_SIGN_IN_TURNSTILE_ACTION = "shopper-sign-in";
var SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
var SITEVERIFY_TIMEOUT_MS = 5e3;
var MAX_TOKEN_LENGTH = 2048;
var TEST_SECRET_KEY = /^[123]x0{31}AA$/;
function isLocalDevelopmentHost(hostname) {
  const host = hostname.toLowerCase();
  return ["localhost", "127.0.0.1", "[::1]"].includes(host) || host.endsWith(".localhost") || host.endsWith(".test");
}
function readTurnstileSettings(env) {
  return {
    siteKey: readSetting(env, "COMMERCE_TURNSTILE_SITE_KEY") ?? null,
    secretKey: readSetting(env, "COMMERCE_TURNSTILE_SECRET_KEY") ?? null
  };
}
async function verifyTurnstileToken(secretKey, token, {
  remoteIp,
  expectedHostname,
  expectedAction
}) {
  const testKey = TEST_SECRET_KEY.test(secretKey);
  if (testKey && !isLocalDevelopmentHost(expectedHostname)) return { refusal: "test_key", errorCodes: [] };
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH) return { refusal: "missing_token", errorCodes: [] };
  let answer;
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: secretKey, response: token, ...remoteIp && remoteIp.length <= 64 ? { remoteip: remoteIp } : {} }),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS)
    });
    if (!response.ok) return { refusal: "unavailable", errorCodes: [`http_${response.status}`] };
    answer = await response.json();
    if (!answer || typeof answer !== "object") return { refusal: "unavailable", errorCodes: [] };
  } catch {
    return { refusal: "unavailable", errorCodes: [] };
  }
  const errorCodes = Array.isArray(answer["error-codes"]) ? answer["error-codes"].filter((code) => typeof code === "string" && /^[a-z0-9-]{1,64}$/.test(code)).slice(0, 5) : [];
  if (answer.success !== true) return { refusal: "rejected", errorCodes };
  if (!testKey) {
    if (typeof answer.hostname === "string" && answer.hostname && answer.hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
      return { refusal: "hostname_mismatch", errorCodes };
    }
    if (typeof answer.action === "string" && answer.action !== expectedAction) return { refusal: "action_mismatch", errorCodes };
  }
  return { refusal: null, errorCodes };
}

// src/accounts.ts
var CUSTOMER_SESSION_COOKIE = "talisman-customer";
var CUSTOMER_SESSION_MAX_AGE = 60 * 60 * 24 * 30;
var CUSTOMER_EMAIL_DAILY_LIMIT = 200;
var DAY_SECONDS = 24 * 60 * 60;
var GENERAL_POOL_KEY = "shopper-email:daily";
var RESERVED_POOL_KEY = "shopper-email:reserved";
var SIGN_IN_LINK_SECONDS = 15 * 60;
var REQUESTS_PER_SOURCE_PER_HOUR = 20;
var REQUESTS_PER_ADDRESS = 3;
var ADDRESS_WINDOW_SECONDS = 10 * 60;
var RESERVED_SENDS_PER_ADDRESS = 2;
var PURCHASED_ORDER_STATUSES = ["paid", "fulfilled", "partially_refunded", "refunded", "disputed"];
var CustomerEmailLimitError = class extends Error {
  name = "CustomerEmailLimitError";
  constructor() {
    super("Too many sign-in emails were requested today");
  }
};
var CustomerRequestLimitError = class extends Error {
  name = "CustomerRequestLimitError";
  constructor() {
    super("Too many sign-in requests");
  }
};
var hashToken = sha256Hex;
var at = (seconds) => new Date(seconds * 1e3);
function normalizeShopperEmail(email) {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254) return null;
  return parseAddress({ email: normalized })?.email === normalized ? normalized : null;
}
var isSignInToken = (token) => typeof token === "string" && /^[0-9a-f-]{72}$/.test(token);
function maskEmailAddress(email) {
  const at2 = email.lastIndexOf("@");
  const [first = ""] = Array.from(email.slice(0, Math.max(0, at2)));
  return `${first}\u2022\u2022\u2022${email.slice(at2)}`;
}
async function findCustomerSession(env, token) {
  if (!token || token.length > 128) return null;
  const db = commerceDb(env);
  const session = await db.select().from(customerSessions).where(and4(
    eq4(customerSessions.tokenHash, await hashToken(token)),
    gt2(customerSessions.expiresAt, /* @__PURE__ */ new Date()),
    isNull2(customerSessions.revokedAt),
    eq4(customerSessions.purpose, "session")
  )).get();
  if (!session) return null;
  return await db.select().from(customerAccounts).where(and4(eq4(customerAccounts.id, session.accountId), eq4(customerAccounts.sessionVersion, session.sessionVersion), isNull2(customerAccounts.anonymizedAt))).get() ?? null;
}
function customerEmailDailyLimit(env) {
  const configured = Number(readSetting2(env, "COMMERCE_EMAIL_DAILY_LIMIT"));
  return Number.isSafeInteger(configured) && configured > 0 ? configured : CUSTOMER_EMAIL_DAILY_LIMIT;
}
function customerEmailReservedDaily(env, dailyLimit) {
  const raw = readSetting2(env, "COMMERCE_EMAIL_RESERVED_DAILY");
  const configured = raw === void 0 ? NaN : Number(raw);
  return Number.isSafeInteger(configured) && configured >= 0 && configured < dailyLimit ? configured : Math.floor(dailyLimit / 4);
}
async function isExistingCustomer(env, email) {
  const verified = await commerceDb(env).select({ id: customerAccounts.id }).from(customerAccounts).where(and4(eq4(customerAccounts.emailNormalized, email), isNotNull(customerAccounts.emailVerifiedAt))).get();
  return Boolean(verified) || await hasPurchaseHistory(env, { emails: [email] });
}
function shopperSignInBotCheck(env) {
  const { siteKey, secretKey } = readTurnstileSettings(env);
  return siteKey && secretKey ? { provider: "turnstile", siteKey, action: SHOPPER_SIGN_IN_TURNSTILE_ACTION } : null;
}
async function activateNewCustomer(_env, _orderId, _basketToken) {
  return null;
}
async function hasPurchaseHistory(env, shopper) {
  const emails = [...new Set((shopper.emails ?? []).flatMap((email) => email?.trim() ? [email.trim().toLowerCase()] : []))];
  const accountIds = [...new Set((shopper.accountIds ?? []).flatMap((id) => id ? [id] : []))];
  const db = commerceDb(env);
  const matches = [
    // Order emails have an index on lower(customer_email), `_ecommerce_orders_customer_email_idx`.
    ...emails.length ? [
      inArray2(sql4`lower(${orders.customerEmail})`, emails),
      inArray2(orders.userId, db.select({ id: customerAccounts.id }).from(customerAccounts).where(inArray2(customerAccounts.emailNormalized, emails)))
    ] : [],
    ...accountIds.length ? [inArray2(orders.userId, accountIds)] : []
  ];
  if (!matches.length) return false;
  const prior = await db.select({ id: orders.id }).from(orders).where(and4(
    inArray2(orders.status, [...PURCHASED_ORDER_STATUSES]),
    sql4`COALESCE(${orders.paymentProvider}, 'stripe') <> 'admin_test'`,
    or2(...matches)
  )).limit(1).get();
  return Boolean(prior);
}
async function requestCustomerEmailSignIn(env, email, linkForToken, sendLink, sourceIp, options = {}) {
  const normalized = normalizeShopperEmail(email);
  if (!normalized) throw new Error("Valid email required");
  const now = Math.floor(Date.now() / 1e3);
  const dailyLimit = customerEmailDailyLimit(env);
  const generalPool = dailyLimit - customerEmailReservedDaily(env, dailyLimit);
  const dropped = async () => ({ limited: await peekRequestCount(env, GENERAL_POOL_KEY, now, DAY_SECONDS) >= generalPool });
  if (await clientOverLimit(env, "shopper-email", sourceIp, { limit: REQUESTS_PER_SOURCE_PER_HOUR, windowSeconds: 3600, now })) {
    return dropped();
  }
  const recent = await commerceDb(env).select({ count: count2() }).from(signInTokens).where(and4(eq4(signInTokens.emailNormalized, normalized), gt2(signInTokens.createdAt, at(now - ADDRESS_WINDOW_SECONDS)))).get();
  if ((recent?.count ?? 0) >= REQUESTS_PER_ADDRESS) return dropped();
  const addressKey = await sha256Hex(normalized);
  if ((await countRequest(env, `shopper-email:address:${addressKey}`, now, ADDRESS_WINDOW_SECONDS) ?? REQUESTS_PER_ADDRESS + 1) > REQUESTS_PER_ADDRESS) return dropped();
  if ((await countRequest(env, GENERAL_POOL_KEY, now, DAY_SECONDS) ?? generalPool + 1) <= generalPool) {
    await sendSignInLink(env, normalized, now, linkForToken, sendLink);
    return { limited: false };
  }
  const reserved = (async () => {
    if (!await isExistingCustomer(env, normalized)) return;
    if ((await countRequest(env, `shopper-email:reserved-address:${addressKey}`, now, DAY_SECONDS) ?? RESERVED_SENDS_PER_ADDRESS + 1) > RESERVED_SENDS_PER_ADDRESS) return;
    const reservedPool = dailyLimit - generalPool;
    if ((await countRequest(env, RESERVED_POOL_KEY, now, DAY_SECONDS) ?? reservedPool + 1) > reservedPool) return;
    await sendSignInLink(env, normalized, now, linkForToken, sendLink);
  })().catch((error) => {
    if (options.onLimitedSendError) options.onLimitedSendError(error);
    else console.error("[commerce] Sign-in email failed", { name: error instanceof Error ? error.name : typeof error });
  });
  if (options.waitUntil) options.waitUntil(reserved);
  else await reserved;
  return { limited: true };
}
async function sendSignInLink(env, email, now, linkForToken, sendLink) {
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const tokenHash = await hashToken(token);
  const db = commerceDb(env);
  await db.insert(signInTokens).values({ tokenHash, emailNormalized: email, expiresAt: at(now + SIGN_IN_LINK_SECONDS), createdAt: at(now) });
  try {
    await sendLink(email, linkForToken(token));
  } catch (error) {
    await db.update(signInTokens).set({ revokedAt: /* @__PURE__ */ new Date() }).where(eq4(signInTokens.tokenHash, tokenHash));
    throw error;
  }
}
async function previewCustomerEmailSignIn(env, token, sourceIp) {
  const now = Math.floor(Date.now() / 1e3);
  if (await clientOverLimit(env, "shopper-preview", sourceIp, { limit: REQUESTS_PER_SOURCE_PER_HOUR, windowSeconds: 3600, now })) {
    throw new CustomerRequestLimitError();
  }
  if (!isSignInToken(token)) return null;
  const link = await commerceDb(env).select({ emailNormalized: signInTokens.emailNormalized }).from(signInTokens).where(and4(
    eq4(signInTokens.tokenHash, await hashToken(token)),
    isNull2(signInTokens.revokedAt),
    gt2(signInTokens.expiresAt, at(now))
  )).get();
  const email = normalizeShopperEmail(link?.emailNormalized);
  return email ? maskEmailAddress(email) : null;
}
async function consumeCustomerEmailSignIn(env, token) {
  if (!isSignInToken(token)) return null;
  const now = Math.floor(Date.now() / 1e3);
  const db = commerceDb(env);
  const [claimed] = await db.update(signInTokens).set({ revokedAt: at(now) }).where(and4(
    eq4(signInTokens.tokenHash, await hashToken(token)),
    isNull2(signInTokens.revokedAt),
    gt2(signInTokens.expiresAt, at(now))
  )).returning({ emailNormalized: signInTokens.emailNormalized });
  const email = normalizeShopperEmail(claimed?.emailNormalized);
  if (!email) return null;
  await db.insert(customerAccounts).values({
    id: `acct_${crypto.randomUUID()}`,
    email,
    emailNormalized: email,
    emailVerifiedAt: at(now),
    createdAt: at(now),
    updatedAt: at(now)
  }).onConflictDoNothing({ target: customerAccounts.emailNormalized });
  const account = await db.select().from(customerAccounts).where(eq4(customerAccounts.emailNormalized, email)).get();
  if (!account) return null;
  const cmsUserId = await ensureVerifiedEmailIdentity(env, account.emailNormalized, account.name);
  const sessionToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  await db.batch([
    db.update(customerAccounts).set({ emailVerifiedAt: sql4`COALESCE(${customerAccounts.emailVerifiedAt}, ${now})`, updatedAt: at(now), cmsUserId }).where(eq4(customerAccounts.id, account.id)),
    db.insert(customerSessions).values({
      id: `csess_${crypto.randomUUID()}`,
      accountId: account.id,
      sessionVersion: account.sessionVersion,
      tokenHash: await hashToken(sessionToken),
      expiresAt: at(now + CUSTOMER_SESSION_MAX_AGE),
      createdAt: at(now),
      purpose: "session"
    })
  ]);
  return { account, token: sessionToken };
}
async function revokeCustomerSession(env, token) {
  if (!token || token.length > 128) return;
  const db = commerceDb(env);
  await db.update(customerSessions).set({ revokedAt: /* @__PURE__ */ new Date() }).where(eq4(customerSessions.tokenHash, await hashToken(token)));
}
async function listCustomerOrders(env, accountId) {
  const db = commerceDb(env);
  return db.select({
    id: orders.id,
    status: orders.status,
    fulfillmentStatus: orders.fulfillmentStatus,
    paymentUnderReview: sql4`(${orders.status} = 'pending' AND ${orders.reconcileReviewAt} IS NOT NULL)`.mapWith(Boolean),
    totalAmount: orders.totalAmount,
    subtotalAmount: orders.subtotalAmount,
    shippingAmount: orders.shippingAmount,
    shippingLabel: orders.shippingLabel,
    taxAmount: orders.taxAmount,
    taxBehavior: orders.taxBehavior,
    creditApplied: orders.creditApplied,
    currency: orders.currency,
    createdAt: orders.createdAt
  }).from(orders).where(eq4(orders.userId, accountId));
}

export {
  ShopperPrivacyError,
  manageShopperData,
  StoreSettingsError,
  readStoreSettings,
  readStoreCurrency,
  reportStoreSettingsError,
  orderAmountColumns,
  orderAmounts,
  describeOrderItems,
  readCustomerHub,
  countRequest,
  clientOverLimit,
  claimInterval,
  SHOPPER_SIGN_IN_TURNSTILE_ACTION,
  readTurnstileSettings,
  verifyTurnstileToken,
  CUSTOMER_SESSION_COOKIE,
  CUSTOMER_SESSION_MAX_AGE,
  CUSTOMER_EMAIL_DAILY_LIMIT,
  PURCHASED_ORDER_STATUSES,
  CustomerEmailLimitError,
  CustomerRequestLimitError,
  normalizeShopperEmail,
  findCustomerSession,
  shopperSignInBotCheck,
  activateNewCustomer,
  hasPurchaseHistory,
  requestCustomerEmailSignIn,
  previewCustomerEmailSignIn,
  consumeCustomerEmailSignIn,
  revokeCustomerSession,
  listCustomerOrders
};
