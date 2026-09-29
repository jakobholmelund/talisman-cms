import {
  getReferralPolicy,
  referralReversalStatements
} from "./chunk-NTFJG6BA.js";
import {
  runtimeStripeMode,
  stripeSessionMode
} from "./chunk-GNU6N22K.js";
import {
  commerceDb,
  commitBatch
} from "./chunk-ZI5IJOR6.js";
import {
  creditLedger,
  discountRedemptions,
  emailDeliveries,
  giftCardClaims,
  giftCardOrderRefunds,
  giftCardPurchases,
  giftCardRedemptions,
  giftCardRefunds,
  giftCards,
  orders,
  payments
} from "./chunk-NKJTK7MK.js";
import {
  emailLink,
  giftCardClaimEmail
} from "./chunk-NMGICNSV.js";
import {
  SUPPORTED_CURRENCIES,
  isSupportedCurrency,
  minimumChargeAmount
} from "./chunk-2UYSCNNW.js";

// src/gift-cards.ts
import { and as and3, count, eq as eq3, exists, gt, inArray, isNull as isNull3, lt, ne, not, or as or2, sql as sql3 } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z as z2 } from "zod";
import { readSetting as readSetting2 } from "talisman-cms/env";

// src/store-settings.ts
import { z } from "zod";
import { readBinding } from "talisman-cms/env";

// src/countries.ts
var COUNTRY_CODES = Object.freeze([
  "AD",
  "AE",
  "AF",
  "AG",
  "AI",
  "AL",
  "AM",
  "AO",
  "AQ",
  "AR",
  "AS",
  "AT",
  "AU",
  "AW",
  "AX",
  "AZ",
  "BA",
  "BB",
  "BD",
  "BE",
  "BF",
  "BG",
  "BH",
  "BI",
  "BJ",
  "BL",
  "BM",
  "BN",
  "BO",
  "BQ",
  "BR",
  "BS",
  "BT",
  "BV",
  "BW",
  "BY",
  "BZ",
  "CA",
  "CC",
  "CD",
  "CF",
  "CG",
  "CH",
  "CI",
  "CK",
  "CL",
  "CM",
  "CN",
  "CO",
  "CR",
  "CU",
  "CV",
  "CW",
  "CX",
  "CY",
  "CZ",
  "DE",
  "DJ",
  "DK",
  "DM",
  "DO",
  "DZ",
  "EC",
  "EE",
  "EG",
  "EH",
  "ER",
  "ES",
  "ET",
  "FI",
  "FJ",
  "FK",
  "FM",
  "FO",
  "FR",
  "GA",
  "GB",
  "GD",
  "GE",
  "GF",
  "GG",
  "GH",
  "GI",
  "GL",
  "GM",
  "GN",
  "GP",
  "GQ",
  "GR",
  "GS",
  "GT",
  "GU",
  "GW",
  "GY",
  "HK",
  "HM",
  "HN",
  "HR",
  "HT",
  "HU",
  "ID",
  "IE",
  "IL",
  "IM",
  "IN",
  "IO",
  "IQ",
  "IR",
  "IS",
  "IT",
  "JE",
  "JM",
  "JO",
  "JP",
  "KE",
  "KG",
  "KH",
  "KI",
  "KM",
  "KN",
  "KP",
  "KR",
  "KW",
  "KY",
  "KZ",
  "LA",
  "LB",
  "LC",
  "LI",
  "LK",
  "LR",
  "LS",
  "LT",
  "LU",
  "LV",
  "LY",
  "MA",
  "MC",
  "MD",
  "ME",
  "MF",
  "MG",
  "MH",
  "MK",
  "ML",
  "MM",
  "MN",
  "MO",
  "MP",
  "MQ",
  "MR",
  "MS",
  "MT",
  "MU",
  "MV",
  "MW",
  "MX",
  "MY",
  "MZ",
  "NA",
  "NC",
  "NE",
  "NF",
  "NG",
  "NI",
  "NL",
  "NO",
  "NP",
  "NR",
  "NU",
  "NZ",
  "OM",
  "PA",
  "PE",
  "PF",
  "PG",
  "PH",
  "PK",
  "PL",
  "PM",
  "PN",
  "PR",
  "PS",
  "PT",
  "PW",
  "PY",
  "QA",
  "RE",
  "RO",
  "RS",
  "RU",
  "RW",
  "SA",
  "SB",
  "SC",
  "SD",
  "SE",
  "SG",
  "SH",
  "SI",
  "SJ",
  "SK",
  "SL",
  "SM",
  "SN",
  "SO",
  "SR",
  "SS",
  "ST",
  "SV",
  "SX",
  "SY",
  "SZ",
  "TC",
  "TD",
  "TF",
  "TG",
  "TH",
  "TJ",
  "TK",
  "TL",
  "TM",
  "TN",
  "TO",
  "TR",
  "TT",
  "TV",
  "TW",
  "TZ",
  "UA",
  "UG",
  "UM",
  "US",
  "UY",
  "UZ",
  "VA",
  "VC",
  "VE",
  "VG",
  "VI",
  "VN",
  "VU",
  "WF",
  "WS",
  "YE",
  "YT",
  "ZA",
  "ZM",
  "ZW"
]);
var assigned = new Set(COUNTRY_CODES);
function isCountryCode(code) {
  return assigned.has(code);
}

// src/store-settings.ts
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
var deliveryDays = z.number().int().min(1).max(365);
var minorUnits = z.number().int().max(Number.MAX_SAFE_INTEGER);
var shippingRateSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/, "must be 1 to 40 characters from a-z, 0-9, _ and -"),
  label: z.string().trim().min(1).max(100),
  amount: minorUnits.min(0),
  countries: z.array(z.string()).nullish().superRefine((entries, context) => {
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
var shippingRatesSchema = z.array(shippingRateSchema).superRefine((rates, context) => {
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
  const parsed = shippingRatesSchema.safeParse(list);
  if (!parsed.success) {
    throw new StoreSettingsError(parsed.error.issues.map((issue) => `${name}${issue.path.map((key) => typeof key === "number" ? `[${key}]` : `.${key}`).join("")}: ${issue.message}`).join("; "));
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

// src/webhook-errors.ts
var WebhookSignatureError = class extends Error {
  name = "WebhookSignatureError";
};
var WebhookRetryLaterError = class extends Error {
  name = "WebhookRetryLaterError";
};
var WebhookMismatchError = class extends Error {
  name = "WebhookMismatchError";
  reason;
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
};

// src/reconcile.ts
import { and, eq, isNull, sql } from "drizzle-orm";
var at = (seconds) => new Date(seconds * 1e3);
var PERMANENT_FAILURES = /* @__PURE__ */ new Set(["session_missing", "session_mode_mismatch", "payment_mismatch"]);
var RECONCILE_FAILURE_MESSAGES = {
  session_missing: "The payment provider has no checkout session with this id",
  session_mode_mismatch: "The checkout session belongs to the other Stripe mode",
  payment_mismatch: "The completed payment does not match the amount, currency or payment recorded for it",
  provider_not_configured: "No configured payment provider can check this checkout session",
  provider_unavailable: "The payment provider could not be reached; the check is retried later",
  provider_refused: "The payment provider refused the store's credentials; check the payment settings",
  failed: "Reconciliation failed"
};
var ReconcileFailure = class extends Error {
  name = "ReconcileFailure";
  code;
  constructor(code, message = RECONCILE_FAILURE_MESSAGES[code], options) {
    super(message, options);
    this.code = code;
  }
  get permanent() {
    return PERMANENT_FAILURES.has(this.code);
  }
};
function isMissingSessionError(error) {
  const details = error;
  return details?.code === "resource_missing" || details?.statusCode === 404;
}
function sessionLookupFailure(error) {
  return isMissingSessionError(error) ? new ReconcileFailure("session_missing", void 0, { cause: error }) : error;
}
function isProviderError(error) {
  const details = error;
  return typeof details?.type === "string" && details.type.startsWith("Stripe") || typeof details?.statusCode === "number";
}
function failureMessage(error) {
  if (!(error instanceof Error) || !error.message) return void 0;
  if (typeof error.query === "string" && "params" in error) {
    return error.cause instanceof Error && error.cause.message ? error.cause.message : "A database query failed";
  }
  return error.message;
}
function reconcileFailure(error) {
  if (error instanceof ReconcileFailure) return error;
  const details = error;
  const status = typeof details?.statusCode === "number" ? details.statusCode : 0;
  const type = typeof details?.type === "string" ? details.type : "";
  if (status === 401 || status === 403 || type === "StripeAuthenticationError" || type === "StripePermissionError") {
    return new ReconcileFailure("provider_refused", void 0, { cause: error });
  }
  if (status === 429 || status >= 500 || type === "StripeConnectionError" || type === "StripeAPIError" || type === "StripeRateLimitError") {
    return new ReconcileFailure("provider_unavailable", void 0, { cause: error });
  }
  if (isProviderError(error)) return new ReconcileFailure("failed", "The payment provider returned an error", { cause: error });
  return new ReconcileFailure("failed", failureMessage(error), { cause: error });
}
function isOtherStripeModeSession(env, sessionId) {
  const mode = stripeSessionMode(sessionId);
  return mode !== null && mode !== runtimeStripeMode(env);
}
function assertStoreStripeMode(env, sessionId) {
  if (!isOtherStripeModeSession(env, sessionId)) return;
  throw new ReconcileFailure("session_mode_mismatch", `The checkout session is from Stripe ${stripeSessionMode(sessionId)} mode, and the store runs in ${runtimeStripeMode(env)} mode`);
}
var RECONCILE_TABLES = {
  order: orders,
  gift_card_purchase: giftCardPurchases
};
var PAID_SESSION_REFUSAL = "Stripe reports this checkout session as paid, and its payment as neither refunded in full nor lost to a dispute, so nothing was released. Refund the payment in full in Stripe first, or retry once the cause of the mismatch is fixed.";
var UNCHECKED_PAYMENT_REFUSAL = "Stripe reports this checkout session as complete but names no payment the store can check for a refund, so nothing was released. If the payment was returned to the shopper, confirm that and release it again.";
async function completedCheckoutReturn(adapter, session, confirmed = false) {
  const paymentIntentId = session.paymentIntentId;
  if (paymentIntentId && adapter.getRefundStatus) {
    if (await adapter.getRefundStatus(paymentIntentId) === "full") return "refunded";
    if (await adapter.getDisputeStatus?.(paymentIntentId) === "lost") return "dispute_lost";
    throw new Error(PAID_SESSION_REFUSAL);
  }
  if (confirmed) return "confirmed";
  throw new Error(UNCHECKED_PAYMENT_REFUSAL);
}
function decisionInsert(kind, action, condition, decision) {
  const [orderId, purchaseId] = kind === "order" ? ["id", "NULL"] : ["NULL", "id"];
  return sql`INSERT INTO _ecommerce_reconcile_decisions
      (id, order_id, purchase_id, action, failure, payment_returned, admin_actor, reason, created_at)
    SELECT ${decision.id}, ${sql.raw(orderId)}, ${sql.raw(purchaseId)}, ${action}, reconcile_last_error, ${decision.paymentReturned},
      ${decision.actor}, ${decision.reason}, ${decision.at}
    FROM ${RECONCILE_TABLES[kind]} WHERE id = ${decision.recordId} AND ${condition}`;
}
var RECONCILE_MAX_BACKOFF_SECONDS = 6 * 60 * 60;
function uncheckedSessionRefusal(checkoutStartedAt, now = Math.floor(Date.now() / 1e3)) {
  const releasable = checkoutStartedAt + 35 * 60;
  if (now >= releasable) return null;
  return new Error(`Stripe cannot be asked about this checkout session, which may still be paid until it expires. Release it after ${new Date(releasable * 1e3).toISOString()}, 35 minutes after the checkout started.`);
}
function backoff(columns, now) {
  return {
    due: sql`(${columns.lastAt} IS NULL
      OR ${columns.lastAt} <= ${now} - MIN(${sql.raw(String(RECONCILE_MAX_BACKOFF_SECONDS))}, 60 << MIN(${columns.attempts}, 9)))`,
    order: [sql`COALESCE(${columns.lastAt}, 0)`, columns.createdAt, columns.id]
  };
}
var reconcileBackoff = (table, now) => backoff({
  attempts: table.reconcileAttempts,
  lastAt: table.reconcileLastAt,
  createdAt: table.createdAt,
  id: table.id
}, now);
async function recordAttempt(db, kind, id, now, failure) {
  const table = RECONCILE_TABLES[kind];
  const attempt = {
    reconcileAttempts: sql`${table.reconcileAttempts} + 1`,
    reconcileLastAt: at(now),
    reconcileLastError: failure?.code ?? null
  };
  if (failure?.permanent) {
    const parked = await db.update(table).set({ ...attempt, reconcileReviewAt: at(now) }).where(and(eq(table.id, id), eq(table.status, "pending"), isNull(table.reconcileReviewAt))).returning({ id: table.id });
    return parked.length ? "parked" : "skipped";
  }
  const recorded = await db.update(table).set(attempt).where(and(eq(table.id, id), isNull(table.reconcileReviewAt))).returning({ id: table.id });
  return recorded.length ? "recorded" : "skipped";
}
async function reconcileAttempt(env, kind, id, now, attempt) {
  let result;
  let failure = null;
  try {
    result = { id, status: (await attempt())?.status ?? "unchanged" };
  } catch (error) {
    failure = reconcileFailure(error);
    result = { id, status: "error", error: failure.message, code: failure.code };
  }
  try {
    const db = commerceDb(env);
    const recorded = await recordAttempt(db, kind, id, now, failure);
    if (recorded === "parked") result.parked = true;
    if (recorded === "skipped" && failure) {
      const table = RECONCILE_TABLES[kind];
      const row = await db.select({ status: table.status }).from(table).where(eq(table.id, id)).get();
      return { id, status: row?.status ?? "unchanged" };
    }
  } catch {
    return { id, status: "error", error: "The reconciliation attempt could not be recorded", code: failure?.code ?? "failed" };
  }
  return result;
}

// src/email-deliveries.ts
import { and as and2, eq as eq2, isNull as isNull2, lte, or, sql as sql2 } from "drizzle-orm";
import { isEmailDeliveryError, parseAddress, resolveEmailProvider, sendEmail } from "talisman-cms/email";
import { readSetting } from "talisman-cms/env";
var COMMERCE_EMAIL_MAX_ATTEMPTS = 10;
var COMMERCE_EMAIL_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
var COMMERCE_EMAIL_LEASE_SECONDS = 5 * 60;
var FIRST_RETRY_SECONDS = 10 * 60;
var LONGEST_RETRY_SECONDS = 12 * 60 * 60;
function commerceEmailRetryDelay(attempts) {
  return Math.min(FIRST_RETRY_SECONDS * 2 ** Math.max(0, attempts - 1), LONGEST_RETRY_SECONDS);
}
var KIND_HEADERS = {
  order_confirmation: "order-confirmation",
  shipment: "order-shipment",
  shipment_update: "order-shipment-update",
  gift_card_claim: "gift-card-claim"
};
var KIND_LABELS = {
  order_confirmation: "Order confirmation email",
  shipment: "Shipment email",
  shipment_update: "Shipment update email",
  gift_card_claim: "Gift card claim email"
};
var CONFIGURATION_ERRORS = /* @__PURE__ */ new Set(["not_configured", "sender_rejected", "invalid_message"]);
var nowSeconds = () => Math.floor(Date.now() / 1e3);
var at2 = (seconds) => new Date(seconds * 1e3);
var pendingEmail = (kind, subjectId) => and2(
  eq2(emailDeliveries.kind, kind),
  eq2(emailDeliveries.subjectId, subjectId),
  eq2(emailDeliveries.status, "pending")
);
var unclaimedAt = (now) => or(
  isNull2(emailDeliveries.claimedAt),
  lte(emailDeliveries.claimedAt, at2(now - COMMERCE_EMAIL_LEASE_SECONDS))
);
function originOf(value) {
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
}
var warned = /* @__PURE__ */ new Set();
function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[commerce] ${message}`);
}
function storeLink(env, name, origin) {
  const value = readSetting(env, name);
  if (!value) return null;
  let link = null;
  try {
    link = emailLink(new URL(value, origin ?? void 0).href);
  } catch {
    link = null;
  }
  if (!link) warnOnce(`TALISMAN_${name} must be an https URL or a path on the public origin; emails leave it out`);
  return link;
}
function bareEmailAddress(value) {
  if (typeof value !== "string") return null;
  return parseAddress({ email: value.trim() })?.email ?? null;
}
var emailRuntime;
var storeTemplates;
async function configuredEmailProvider(env) {
  emailRuntime ??= import("talisman-cms/email/runtime").catch(() => null);
  const runtime = await emailRuntime;
  return runtime ? runtime.getEmailProvider(env) : resolveEmailProvider(env);
}
function configuredTemplates() {
  storeTemplates ??= import("virtual:talisman-cms/ecommerce-emails").then((module) => module.emailTemplates ?? null).catch((error) => {
    const code = error?.code;
    if (code !== "ERR_UNSUPPORTED_ESM_URL_SCHEME" && code !== "ERR_MODULE_NOT_FOUND") {
      console.error(
        "[commerce] Store email templates could not be loaded; the default templates are used",
        { name: error instanceof Error ? error.name : typeof error }
      );
    }
    return null;
  });
  return storeTemplates;
}
async function commerceEmailSetup(env) {
  const settings = env;
  const from = readSetting(settings, "COMMERCE_EMAIL_FROM") ?? readSetting(settings, "EMAIL_FROM") ?? null;
  const origin = originOf(readSetting(settings, "COMMERCE_PUBLIC_ORIGIN") ?? readSetting(settings, "PUBLIC_ORIGIN"));
  const supportSetting = readSetting(settings, "COMMERCE_SUPPORT_EMAIL");
  const support = bareEmailAddress(supportSetting);
  if (supportSetting && !support) warnOnce("TALISMAN_COMMERCE_SUPPORT_EMAIL must be a bare email address; emails leave it out");
  const replyTo = parseAddress(readSetting(settings, "EMAIL_REPLY_TO") ?? "")?.email ?? null;
  let provider = null;
  try {
    provider = await configuredEmailProvider(settings);
  } catch (error) {
    console.error("[commerce] The email provider could not be created", { name: error instanceof Error ? error.name : typeof error });
  }
  return {
    provider,
    from,
    replyTo: support,
    store: {
      name: readSetting(settings, "COMMERCE_STORE_NAME") ?? (from ? parseAddress(from)?.name : void 0) ?? (origin ? new URL(origin).host : "Our store"),
      legalName: readSetting(settings, "COMMERCE_STORE_LEGAL_NAME") ?? null,
      address: (readSetting(settings, "COMMERCE_STORE_ADDRESS") ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      supportEmail: support ?? replyTo,
      termsUrl: storeLink(settings, "COMMERCE_TERMS_URL", origin),
      returnsUrl: storeLink(settings, "COMMERCE_RETURNS_URL", origin),
      warrantyUrl: storeLink(settings, "COMMERCE_WARRANTY_URL", origin),
      origin
    },
    templates: await configuredTemplates()
  };
}
function missingEmailSettings(setup, kind) {
  return [
    ...setup.provider ? [] : ["an email provider"],
    ...setup.from && parseAddress(setup.from) ? [] : ["a sender (TALISMAN_EMAIL_FROM)"],
    // A claim link points at the storefront, and a link in an email must be https (http only on
    // localhost); without one the email would go out without the link it exists for.
    ...kind !== "gift_card_claim" || setup.store.origin && emailLink(setup.store.origin) ? [] : ["an https public origin (TALISMAN_PUBLIC_ORIGIN)"]
  ];
}
function waitingEmailsResult(kinds, missing, waiting, limit) {
  const what = kinds === "all" ? "Email needs" : `${kinds.map((kind) => `${KIND_LABELS[kind]}s`).join(" and ")} need`;
  const count2 = `${waiting}${waiting === limit ? " or more" : ""} email${waiting === 1 ? " is" : "s are"} waiting`;
  return { id: "commerce_emails", status: "error", error: `${what} ${missing.join(", ")}; ${count2}` };
}
var CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
function validMessage(value) {
  const message = value;
  return Boolean(message) && typeof message.subject === "string" && Boolean(message.subject.trim()) && message.subject.length <= 998 && !CONTROL_CHARACTERS.test(message.subject) && typeof message.text === "string" && Boolean(message.text.trim()) && (message.html === void 0 || typeof message.html === "string");
}
async function applyEmailTemplate(setup, name, email, defaults) {
  const template = setup.templates?.[name];
  if (typeof template !== "function") return defaults;
  try {
    const message = await template(email, defaults);
    if (validMessage(message)) {
      return { subject: message.subject, text: message.text, ...message.html === void 0 ? {} : { html: message.html } };
    }
    console.error("[commerce] A store email template returned no valid message; the default is sent", { template: name });
  } catch (error) {
    console.error(
      "[commerce] A store email template failed; the default is sent",
      { template: name, name: error instanceof Error ? error.name : typeof error }
    );
  }
  return defaults;
}
function commerceEmailStatement(kind, subjectId, now, condition) {
  return sql2`INSERT INTO _ecommerce_email_deliveries (id, kind, subject_id, next_attempt_at, created_at)
    SELECT ${`mail_${crypto.randomUUID()}`}, ${kind}, ${subjectId}, ${now}, ${now} WHERE ${condition ?? sql2`1`}
    ON CONFLICT (kind, subject_id) DO NOTHING`;
}
function commerceEmailHeld(kind, subjectId, stamp) {
  return sql2`EXISTS (SELECT 1 FROM _ecommerce_email_deliveries
    WHERE kind = ${kind} AND subject_id = ${subjectId} AND status = 'pending' AND claimed_at = ${stamp})`;
}
async function holdCommerceEmail(env, kind, subjectId, now) {
  const db = commerceDb(env);
  const [held] = await db.update(emailDeliveries).set({ claimedAt: at2(now) }).where(and2(pendingEmail(kind, subjectId), unclaimedAt(now))).returning({ id: emailDeliveries.id });
  if (held) return now;
  const pending = await db.select({ id: emailDeliveries.id }).from(emailDeliveries).where(pendingEmail(kind, subjectId)).get();
  return pending ? "busy" : null;
}
var heldBy = (kind, subjectId, stamp) => and2(pendingEmail(kind, subjectId), eq2(emailDeliveries.claimedAt, at2(stamp)));
function releaseCommerceEmailStatement(db, kind, subjectId, stamp) {
  return db.update(emailDeliveries).set({ claimedAt: null }).where(heldBy(kind, subjectId, stamp));
}
function supersedeCommerceEmailStatement(db, kind, subjectId, stamp) {
  return db.update(emailDeliveries).set({ status: "cancelled", lastError: "superseded", claimedAt: null }).where(heldBy(kind, subjectId, stamp));
}
function sendCommerceMessage(env, setup, kind, to, message) {
  return sendEmail(env, {
    to: { email: to },
    from: setup.from ?? void 0,
    ...setup.replyTo ? { replyTo: setup.replyTo } : {},
    subject: message.subject,
    text: message.text,
    ...message.html === void 0 ? {} : { html: message.html },
    kind: KIND_HEADERS[kind]
  }, setup.provider);
}
function emailErrorCode(error) {
  return isEmailDeliveryError(error) ? error.code : "unknown";
}
async function runCommerceEmailDelivery(env, kind, subjectId, compose, options = {}) {
  const id = `${kind}:${subjectId}`;
  const label = KIND_LABELS[kind];
  try {
    const now = options.now ?? nowSeconds();
    const setup = options.setup ?? await commerceEmailSetup(env);
    const missing = missingEmailSettings(setup, kind);
    const db = commerceDb(env);
    if (missing.length) {
      await db.update(emailDeliveries).set({ lastError: "not_configured" }).where(pendingEmail(kind, subjectId));
      return { id, status: "error", error: `${label} waits: email needs ${missing.join(", ")}` };
    }
    const [claimed] = await db.update(emailDeliveries).set({ claimedAt: at2(now), attempts: sql2`${emailDeliveries.attempts} + 1` }).where(and2(pendingEmail(kind, subjectId), lte(emailDeliveries.nextAttemptAt, at2(now)), unclaimedAt(now))).returning({ id: emailDeliveries.id, attempts: emailDeliveries.attempts });
    if (!claimed) return null;
    const settle = async (outcome) => {
      const { meta } = await db.update(emailDeliveries).set({ ...outcome, claimedAt: null }).where(and2(eq2(emailDeliveries.id, claimed.id), eq2(emailDeliveries.claimedAt, at2(now)))).run();
      return Number(meta?.changes ?? 0) > 0;
    };
    const recordFailure = async (code) => {
      if (code === "recipient_suppressed") {
        return await settle({ status: "failed", lastError: code }) ? { id, status: "email_undeliverable", error: code } : null;
      }
      if (claimed.attempts >= COMMERCE_EMAIL_MAX_ATTEMPTS) {
        return await settle({ status: "failed", lastError: code }) ? { id, status: "error", error: `${label} was given up after ${claimed.attempts} attempts (${code})` } : null;
      }
      if (!await settle({ lastError: code, nextAttemptAt: at2(now + commerceEmailRetryDelay(claimed.attempts)) })) return null;
      return CONFIGURATION_ERRORS.has(code) ? { id, status: "error", error: `${label} could not be sent (${code}); it is retried` } : { id, status: "email_retry", error: code };
    };
    let composed;
    try {
      composed = await compose(env, subjectId, setup, now);
    } catch (error) {
      console.error("[commerce] An email could not be built", { kind, name: error instanceof Error ? error.name : typeof error });
      return await recordFailure("compose_failed");
    }
    if ("cancel" in composed) {
      return await settle({ status: "cancelled", lastError: composed.cancel }) ? { id, status: "email_cancelled", error: composed.cancel } : null;
    }
    if ("fail" in composed) {
      return await settle({ status: "failed", lastError: composed.fail }) ? { id, status: "email_undeliverable", error: composed.fail } : null;
    }
    try {
      await sendCommerceMessage(env, setup, kind, composed.to, composed.message);
    } catch (error) {
      await composed.onFailure?.().catch(() => void 0);
      return await recordFailure(emailErrorCode(error));
    }
    await settle({ status: "sent", sentAt: at2(now), lastError: null });
    return { id, status: "email_sent" };
  } catch (error) {
    return { id, status: "error", error: `${label} could not be recorded (${error instanceof Error ? error.name : "error"})` };
  }
}
async function sendCommerceEmailNow(env, kind, subjectId, compose) {
  const result = await runCommerceEmailDelivery(env, kind, subjectId, compose);
  if (!result || result.status === "email_sent") return result;
  const details = { kind, subject: subjectId, status: result.status, error: result.error };
  if (result.status === "error") console.error("[commerce] Email not sent", details);
  else console.warn("[commerce] Email not sent", details);
  return result;
}

// src/gift-cards.ts
var MIN_CARD_CENTS = 500;
var amountSchema = z2.number().int().min(MIN_CARD_CENTS).max(1e5);
var purchaseIdSchema = z2.string().regex(/^gp_[0-9a-f-]{36}$/);
var purchaseSchema = z2.object({
  amountCents: amountSchema,
  buyerEmail: z2.string().trim().email().max(254)
}).strict();
var adminIssueSchema = z2.object({
  amountCents: amountSchema,
  reason: z2.string().trim().min(8).max(500),
  // A card support issues in place of a purchased one takes over the value left on the purchase's card.
  replacesPurchaseId: purchaseIdSchema.optional()
}).strict();
var hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
var unhex = (value) => new Uint8Array(value.match(/.{2}/g)?.map((byte) => parseInt(byte, 16)) ?? []);
var randomHex = (bytes) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
var utf8 = new TextEncoder();
var at3 = (seconds) => new Date(seconds * 1e3);
var KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
var VERSIONED_SECRET = /^v2:([0-9a-f]{16}):([0-9a-f]{24}):((?:[0-9a-f]{2}){17,})$/;
var UNVERSIONED_SECRET = /^([0-9a-fA-F]{24}):((?:[0-9a-fA-F]{2}){17,})$/;
async function importGiftCardKey(value) {
  const raw = unhex(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  return {
    id: hex(digest).slice(0, 16),
    key: await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"])
  };
}
async function currentGiftCardKey(env) {
  const value = readSetting2(env, "COMMERCE_GIFT_CARD_KEY");
  if (!value || !KEY_PATTERN.test(value)) throw new Error("Gift card encryption key is not configured");
  return importGiftCardKey(value);
}
async function giftCardKeyring(env) {
  const keys = [await currentGiftCardKey(env)];
  const previous = (readSetting2(env, "COMMERCE_GIFT_CARD_PREVIOUS_KEYS") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (previous.some((value) => !KEY_PATTERN.test(value))) {
    throw new Error("Each previous gift card key must be 64 hex characters");
  }
  for (const value of previous) {
    const key = await importGiftCardKey(value);
    if (!keys.some((known) => known.id === key.id)) keys.push(key);
  }
  return keys;
}
async function hashGiftCardSecret(value) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
async function encryptCardSecret(key, cardId, code) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8.encode(cardId) },
    key.key,
    utf8.encode(code)
  );
  return `v2:${key.id}:${hex(iv)}:${hex(new Uint8Array(ciphertext))}`;
}
async function openCardSecret(key, iv, ciphertext, cardId) {
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: unhex(iv),
      ...cardId === void 0 ? {} : { additionalData: utf8.encode(cardId) }
    }, key.key, unhex(ciphertext)));
  } catch {
    return null;
  }
}
async function decryptCardSecret(keys, card) {
  let code = null;
  const versioned = VERSIONED_SECRET.exec(card.encryptedCode);
  if (versioned) {
    const key = keys.find((known) => known.id === versioned[1]);
    if (!key) throw new Error(`Gift card code uses key ${versioned[1]}, which is not configured`);
    code = await openCardSecret(key, versioned[2], versioned[3], card.id);
  } else {
    const unversioned = UNVERSIONED_SECRET.exec(card.encryptedCode);
    if (!unversioned) throw new Error("Gift card secret is invalid");
    for (const key of keys) {
      code = await openCardSecret(key, unversioned[1], unversioned[2]);
      if (code !== null) break;
    }
  }
  if (code === null || await hashGiftCardSecret(code) !== card.codeHash) {
    throw new Error("Gift card code cannot be decrypted with the configured keys");
  }
  return code;
}
async function newCardSecret(env, cardId) {
  const code = `GIFT-${randomHex(16).toUpperCase()}`;
  return {
    code,
    codeHash: await hashGiftCardSecret(code),
    codeSuffix: code.slice(-4),
    encryptedCode: await encryptCardSecret(await currentGiftCardKey(env), cardId, code)
  };
}
var reencryptSchema = z2.object({
  after: z2.string().max(100).optional(),
  // Each update is a D1 query, and a Worker invocation on the Free plan may run only 50.
  limit: z2.number().int().min(1).max(40).optional()
}).strict();
async function reencryptGiftCardCodes(env, input = {}) {
  const { after = "", limit = 25 } = reencryptSchema.parse(input ?? {});
  const keys = await giftCardKeyring(env);
  const current = keys[0];
  const prefix = `v2:${current.id}:`;
  const db = commerceDb(env);
  const rows = await db.select({ id: giftCards.id, codeHash: giftCards.codeHash, encryptedCode: giftCards.encryptedCode }).from(giftCards).where(and3(sql3`substr(${giftCards.encryptedCode}, 1, ${prefix.length}) <> ${prefix}`, gt(giftCards.id, after))).orderBy(giftCards.id).limit(limit);
  const reencrypt = (row, encryptedCode) => db.update(giftCards).set({ encryptedCode }).where(and3(eq3(giftCards.id, row.id), eq3(giftCards.encryptedCode, row.encryptedCode))).returning({ id: giftCards.id });
  const statements = [];
  const failed = [];
  for (const row of rows) {
    try {
      const code = await decryptCardSecret(keys, row);
      statements.push(reencrypt(row, await encryptCardSecret(current, row.id, code)));
    } catch {
      failed.push(row.id);
    }
  }
  const results = statements.length ? await db.batch(statements) : [];
  return {
    keyId: current.id,
    reencrypted: results.reduce((sum, updated) => sum + updated.length, 0),
    failed,
    next: rows.length === limit ? rows[rows.length - 1].id : null
  };
}
async function getGiftCardKeyStatus(env) {
  let current;
  try {
    current = await currentGiftCardKey(env);
  } catch {
    return null;
  }
  const prefix = `v2:${current.id}:`;
  const row = await commerceDb(env).select({
    previousKeyCodes: sql3`COALESCE(SUM(substr(${giftCards.encryptedCode},1,3) = 'v2:'
      AND substr(${giftCards.encryptedCode},1,${prefix.length}) <> ${prefix}),0)`,
    legacyCodes: sql3`COALESCE(SUM(substr(${giftCards.encryptedCode},1,3) <> 'v2:'),0)`
  }).from(giftCards).get();
  return { keyId: current.id, previousKeyCodes: row?.previousKeyCodes ?? 0, legacyCodes: row?.legacyCodes ?? 0 };
}
var p = alias(giftCardPurchases, "p");
var c = alias(giftCards, "c");
var P_ID = sql3.raw("p.id");
var settledPurchase = (purchase) => sql3`(${purchase.status} = 'paid' OR (${purchase.status} IN ('partially_refunded','refunded')
  AND ${purchase.refundAdjustedCents} = ${purchase.providerRefundedCents}))`;
var currentCard = (purchase) => sql3`(SELECT k.id FROM _ecommerce_gift_cards k
  WHERE (k.purchase_id = ${purchase} OR k.replaces_purchase_id = ${purchase}) AND k.status <> 'void'
  ORDER BY k.source = 'admin' DESC,k.created_at DESC,k.id DESC LIMIT 1)`;
var pendingCheckout = (purchase) => sql3`EXISTS (SELECT 1 FROM _ecommerce_gift_card_redemptions r
  JOIN _ecommerce_gift_cards f ON f.id = r.card_id
  WHERE (f.purchase_id = ${purchase} OR f.replaces_purchase_id = ${purchase}) AND r.status = 'reserved')`;
var cardValue = (purchase) => sql3`(SELECT COALESCE(SUM(f.balance_cents),0) FROM _ecommerce_gift_cards f
  WHERE (f.purchase_id = ${purchase} OR f.replaces_purchase_id = ${purchase}) AND f.status <> 'void')`;
var units = (cents, currency) => `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
async function assertReplaceable(db, purchaseId, amountCents) {
  const purchase = await db.select({
    status: p.status,
    currency: p.currency,
    settled: settledPurchase(p),
    value: cardValue(P_ID),
    pending: pendingCheckout(P_ID)
  }).from(p).where(eq3(p.id, purchaseId)).get();
  if (!purchase?.settled || !["paid", "partially_refunded"].includes(purchase.status)) {
    throw new Error("Only the card of a paid purchase that is not held for review can be replaced");
  }
  if (purchase.pending) {
    throw new Error("A checkout in progress holds value on this purchase's card; replace it once that checkout completes or expires");
  }
  if (purchase.value < MIN_CARD_CENTS) {
    throw new Error(`Only ${units(purchase.value, purchase.currency)} is left on the purchase's card, too little for a replacement`);
  }
  if (purchase.value !== amountCents) {
    throw new Error(`A replacement carries exactly what is left on the purchase's card: ${units(purchase.value, purchase.currency)}`);
  }
}
function giftCardCurrency(env) {
  const { currency } = readStoreSettings(env);
  if (currency !== "usd") throw new GiftCardRefusal("currency", "Gift cards are available only in stores that use USD");
  return currency;
}
async function issueAdminGiftCard(env, actor, input) {
  const currency = giftCardCurrency(env);
  const { amountCents, reason, replacesPurchaseId } = adminIssueSchema.parse(input);
  if (!actor.trim()) throw new Error("Administrator identity is required");
  const replaces = replacesPurchaseId ?? null;
  const db = commerceDb(env);
  if (replaces) await assertReplaceable(db, replaces, amountCents);
  const id = `gift_${crypto.randomUUID()}`;
  const secret = await newCardSecret(env, id);
  const timestamp = Math.floor(Date.now() / 1e3);
  const replacementIssued = sql3`EXISTS (SELECT 1 FROM _ecommerce_gift_cards n WHERE n.id = ${id})`;
  const [inserted] = await db.batch([
    db.all(sql3`INSERT INTO _ecommerce_gift_cards
      (id,code_hash,code_suffix,encrypted_code,source,admin_actor,admin_reason,replaces_purchase_id,initial_cents,balance_cents,currency,status,created_at,updated_at)
      SELECT ${id},${secret.codeHash},${secret.codeSuffix},${secret.encryptedCode},'admin',${actor},${reason},${replaces},${amountCents},0,${currency},'active',${timestamp},${timestamp}
      WHERE ${replaces} IS NULL OR EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p
        WHERE p.id = ${replaces} AND p.currency = ${currency} AND p.status IN ('paid','partially_refunded') AND ${settledPurchase(p)}
          AND NOT ${pendingCheckout(p.id)} AND ${cardValue(p.id)} = ${amountCents})
      RETURNING id`),
    db.run(sql3`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT ${`gcl_issue_${id}`},id,replaces_purchase_id,'issue',initial_cents,${timestamp} FROM _ecommerce_gift_cards WHERE id = ${id}`),
    ...replaces ? [
      db.run(sql3`INSERT INTO _ecommerce_gift_card_ledger
        (id,card_id,purchase_id,kind,amount_cents,created_at)
        SELECT 'gcl_replaced_' || c.id,c.id,${replaces},'purchase_reversal',-c.balance_cents,${timestamp}
        FROM _ecommerce_gift_cards c WHERE (c.purchase_id = ${replaces} OR c.replaces_purchase_id = ${replaces}) AND c.id <> ${id}
          AND c.status <> 'void' AND c.balance_cents > 0 AND ${replacementIssued}`),
      db.update(giftCards).set({ status: "void", heldForReview: false, updatedAt: at3(timestamp) }).where(and3(
        or2(eq3(giftCards.purchaseId, replaces), eq3(giftCards.replacesPurchaseId, replaces)),
        ne(giftCards.id, id),
        ne(giftCards.status, "void"),
        replacementIssued
      ))
    ] : []
  ]);
  if (!inserted.length) throw new Error("The purchase changed while its card was being replaced; reload and try again");
  return { id, code: secret.code, amountCents, currency, replacesPurchaseId: replaces };
}
var isoSeconds = (seconds) => typeof seconds === "number" ? new Date(seconds * 1e3).toISOString() : null;
function claimLinkView(value) {
  if (typeof value !== "string") return null;
  const link = JSON.parse(value);
  return {
    createdAt: isoSeconds(link.createdAt),
    expiresAt: isoSeconds(link.expiresAt),
    usedAt: isoSeconds(link.usedAt),
    revokedAt: isoSeconds(link.revokedAt),
    resent: link.resent === 1
  };
}
function claimEmailView(value) {
  if (typeof value !== "string") return null;
  const email = JSON.parse(value);
  return { status: email.status, lastError: email.lastError, attempts: email.attempts };
}
async function getGiftCardsAdmin(env) {
  const db = commerceDb(env);
  return db.select({
    id: giftCards.id,
    codeSuffix: giftCards.codeSuffix,
    source: giftCards.source,
    purchaseId: giftCards.purchaseId,
    replacesPurchaseId: giftCards.replacesPurchaseId,
    // The buyer of the purchase the card belongs to or replaces; the claim link resend goes there. The
    // subqueries name the card's columns with their table, because drizzle leaves them unqualified.
    buyerEmail: sql3`(SELECT p.buyer_email FROM _ecommerce_gift_card_purchases p
      WHERE p.id = COALESCE(_ecommerce_gift_cards.purchase_id, _ecommerce_gift_cards.replaces_purchase_id))`,
    adminActor: giftCards.adminActor,
    adminReason: giftCards.adminReason,
    initialCents: giftCards.initialCents,
    balanceCents: giftCards.balanceCents,
    currency: giftCards.currency,
    status: giftCards.status,
    // While its purchase is held for review, the card cannot be reactivated.
    inReview: sql3`EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p
      WHERE p.id IN (${giftCards.purchaseId}, ${giftCards.replacesPurchaseId}) AND p.status = 'review')`.mapWith(Boolean),
    // Read through the purchase index: a card's links all belong to its purchase, or to the one it replaces.
    claimLink: sql3`(SELECT json_object('createdAt', l.created_at, 'expiresAt', l.expires_at, 'usedAt', l.used_at,
        'revokedAt', l.revoked_at, 'resent', l.created_by IS NOT NULL)
      FROM _ecommerce_gift_card_claims l
      WHERE l.purchase_id = COALESCE(_ecommerce_gift_cards.purchase_id, _ecommerce_gift_cards.replaces_purchase_id)
        AND l.card_id = _ecommerce_gift_cards.id
      -- A link the buyer can still use comes first, so a resend that failed never hides a working link.
      ORDER BY (l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > CAST(strftime('%s', 'now') AS INTEGER)) DESC,
        l.created_at DESC, l.rowid DESC LIMIT 1)`.mapWith(claimLinkView),
    claimEmail: sql3`(SELECT json_object('status', d.status, 'lastError', d.last_error, 'attempts', d.attempts)
      FROM _ecommerce_email_deliveries d WHERE d.kind = 'gift_card_claim' AND d.subject_id = _ecommerce_gift_cards.purchase_id)`.mapWith(claimEmailView),
    createdAt: giftCards.createdAt
  }).from(giftCards).orderBy(giftCards.createdAt);
}
var reviewQuery = (db) => db.select({
  purchaseId: p.id,
  status: p.status,
  amountCents: p.amountCents,
  currency: p.currency,
  refundedCents: p.providerRefundedCents,
  adjustedCents: p.refundAdjustedCents,
  cardId: c.id,
  codeSuffix: c.codeSuffix,
  cardStatus: c.status,
  cardHeld: c.heldForReview,
  cardReplacement: sql3`${c.replacesPurchaseId} IS NOT NULL`.mapWith(Boolean),
  balanceCents: c.balanceCents,
  spentCents: sql3`(SELECT -COALESCE(SUM(l.amount_cents),0) FROM _ecommerce_gift_card_ledger l
    JOIN _ecommerce_gift_cards f ON f.id = l.card_id
    WHERE (f.purchase_id = ${P_ID} OR f.replaces_purchase_id = ${P_ID})
      AND l.kind IN ('reserve','release','refund_restore'))`,
  pendingCents: sql3`(SELECT COALESCE(SUM(r.amount_cents),0) FROM _ecommerce_gift_card_redemptions r
    JOIN _ecommerce_gift_cards f ON f.id = r.card_id
    WHERE (f.purchase_id = ${P_ID} OR f.replaces_purchase_id = ${P_ID}) AND r.status = 'reserved')`,
  replacementCount: sql3`(SELECT COUNT(*) FROM _ecommerce_gift_cards f WHERE f.replaces_purchase_id = ${P_ID})`
}).from(p).leftJoin(c, eq3(c.id, currentCard(p.id)));
var reviewView = (row) => ({ ...row, cardHeld: row.cardHeld === true });
var openDispute = (purchase) => sql3`EXISTS (SELECT 1 FROM _ecommerce_disputes d
  WHERE d.gift_card_purchase_id = ${purchase} AND d.closed_at IS NULL)`;
async function getGiftCardReviewsAdmin(env) {
  const db = commerceDb(env);
  const held = and3(eq3(p.status, "review"), not(openDispute(p.id)));
  const rows = await reviewQuery(db).where(held).orderBy(p.updatedAt, p.id).limit(100);
  const total = await db.select({ count: count() }).from(p).where(held).get();
  return { reviews: rows.map(reviewView), reviewCount: total?.count ?? 0 };
}
async function setGiftCardActive(env, id, active) {
  if (!/^gift_[0-9a-f-]{36}$/.test(id) || typeof active !== "boolean") throw new Error("Invalid gift card");
  const db = commerceDb(env);
  const card = await db.select().from(giftCards).where(eq3(giftCards.id, id)).get();
  if (!card || card.status === "void") throw new Error("Gift card is unavailable");
  const timestamp = Math.floor(Date.now() / 1e3);
  const settled = (purchaseId) => exists(db.select({ one: sql3`1` }).from(giftCardPurchases).where(and3(eq3(giftCardPurchases.id, purchaseId), settledPurchase(giftCardPurchases))));
  const reactivatable = and3(
    or2(isNull3(giftCards.purchaseId), settled(giftCards.purchaseId)),
    or2(isNull3(giftCards.replacesPurchaseId), settled(giftCards.replacesPurchaseId))
  );
  const result = await db.update(giftCards).set({ status: active ? "active" : "suspended", heldForReview: false, updatedAt: at3(timestamp) }).where(and3(eq3(giftCards.id, id), ne(giftCards.status, "void"), active ? reactivatable : void 0)).returning({ id: giftCards.id });
  if (!result.length) throw new Error("Gift card purchase requires review");
  return { id, status: active ? "active" : "suspended" };
}
var GiftCardRefusal = class extends Error {
  reason;
  constructor(reason, message) {
    super(message);
    this.name = "GiftCardRefusal";
    this.reason = reason;
  }
};
async function evaluateGiftCard(env, code, amountDue) {
  const currency = giftCardCurrency(env);
  const normalized = code.trim().toUpperCase();
  if (!/^GIFT-[A-F0-9]{32}$/.test(normalized)) throw new GiftCardRefusal("format", "Invalid gift card code");
  const db = commerceDb(env);
  const card = await db.select().from(giftCards).where(eq3(giftCards.codeHash, await hashGiftCardSecret(normalized))).get();
  if (!card || card.status !== "active" || card.currency !== currency || card.balanceCents <= 0) {
    throw new GiftCardRefusal("unavailable", "Gift card is unavailable");
  }
  if (!Number.isSafeInteger(amountDue) || amountDue <= 0) throw new GiftCardRefusal("nothing_due", "No balance remains to pay");
  const amount = card.balanceCents >= amountDue ? amountDue : Math.min(card.balanceCents, Math.max(0, amountDue - minimumChargeAmount(currency)));
  if (amount <= 0) throw new GiftCardRefusal("cannot_cover", "Gift card cannot cover this order or a valid split payment");
  return { id: card.id, codeSuffix: card.codeSuffix, amount, remainingCents: card.balanceCents };
}
async function getGiftCardBalance(env, code) {
  const normalized = code.trim().toUpperCase();
  if (!/^GIFT-[A-F0-9]{32}$/.test(normalized)) throw new Error("Invalid gift card code");
  const db = commerceDb(env);
  const card = await db.select({
    balanceCents: giftCards.balanceCents,
    currency: giftCards.currency,
    status: giftCards.status
  }).from(giftCards).where(eq3(giftCards.codeHash, await hashGiftCardSecret(normalized))).get();
  if (!card) throw new Error("Gift card not found");
  return card;
}
async function startGiftCardPurchase(env, adapter, input, urls) {
  if (adapter.providerId !== "stripe") throw new Error("Gift card purchases require Stripe");
  const currency = giftCardCurrency(env);
  await giftCardKeyring(env);
  const values = purchaseSchema.parse(input);
  const id = `gp_${crypto.randomUUID()}`;
  const accessToken = randomHex(32);
  const timestamp = Math.floor(Date.now() / 1e3);
  const db = commerceDb(env);
  const pending = and3(eq3(giftCardPurchases.id, id), eq3(giftCardPurchases.status, "pending"));
  await db.insert(giftCardPurchases).values({
    id,
    buyerEmail: values.buyerEmail,
    amountCents: values.amountCents,
    currency,
    status: "pending",
    accessTokenHash: await hashGiftCardSecret(accessToken),
    createdAt: at3(timestamp),
    updatedAt: at3(timestamp)
  });
  let providerSessionId;
  try {
    const session = await adapter.createCheckoutSession({
      orderId: id,
      currency,
      items: [{ name: "Talisman digital gift card", priceCents: values.amountCents, quantity: 1 }],
      customerEmail: values.buyerEmail,
      metadata: { giftCardPurchaseId: id },
      successUrl: urls.successUrl.replace("{PURCHASE_ID}", id),
      cancelUrl: urls.cancelUrl
    });
    providerSessionId = session.providerSessionId;
    await db.update(giftCardPurchases).set({ providerSessionId: session.providerSessionId, updatedAt: at3(timestamp) }).where(pending);
    return { id, accessToken, paymentUrl: session.url };
  } catch (error) {
    if (providerSessionId) {
      try {
        await adapter.expireCheckoutSession?.(providerSessionId);
      } catch {
        await db.update(giftCardPurchases).set({ providerSessionId }).where(pending);
        throw error;
      }
    }
    await db.update(giftCardPurchases).set({ status: "cancelled", updatedAt: /* @__PURE__ */ new Date() }).where(pending);
    throw error;
  }
}
async function confirmGiftCardPurchase(env, session) {
  const id = session.metadata?.giftCardPurchaseId;
  if (!id) throw new Error("Gift card purchase ID is missing");
  const db = commerceDb(env);
  const purchase = await db.select().from(giftCardPurchases).where(eq3(giftCardPurchases.id, id)).get();
  if (!purchase || purchase.providerSessionId !== session.id || purchase.amountCents !== session.amount_total || session.currency?.toLowerCase() !== purchase.currency.toLowerCase() || session.payment_status !== "paid" || typeof session.payment_intent !== "string") {
    throw new WebhookMismatchError("purchase_mismatch", "Gift card payment does not match purchase");
  }
  if (purchase.status === "paid") return { success: true, purchaseId: id, duplicate: true };
  if (["partially_refunded", "refunded", "review"].includes(purchase.status) && purchase.paymentIntentId === session.payment_intent) return { success: true, purchaseId: id, duplicate: true };
  if (purchase.status !== "pending") {
    throw new WebhookMismatchError("purchase_not_pending", "Gift card purchase is no longer pending");
  }
  const cardId = `gift_${crypto.randomUUID()}`;
  const secret = await newCardSecret(env, cardId);
  const timestamp = Math.floor(Date.now() / 1e3);
  await commitBatch(db, [
    db.update(giftCardPurchases).set({ status: "paid", paymentIntentId: session.payment_intent, updatedAt: at3(timestamp) }).where(and3(eq3(giftCardPurchases.id, id), eq3(giftCardPurchases.status, "pending"), eq3(giftCardPurchases.providerSessionId, session.id))),
    db.run(sql3`INSERT INTO _ecommerce_gift_cards
      (id,code_hash,code_suffix,encrypted_code,source,purchase_id,initial_cents,balance_cents,currency,status,created_at,updated_at)
      SELECT ${cardId},${secret.codeHash},${secret.codeSuffix},${secret.encryptedCode},'purchase',id,amount_cents,0,currency,'active',${timestamp},${timestamp}
      FROM _ecommerce_gift_card_purchases WHERE id = ${id} AND status = 'paid'
      ON CONFLICT(purchase_id) DO NOTHING`),
    db.run(sql3`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_issue_' || id,id,purchase_id,'issue',initial_cents,${timestamp}
      FROM _ecommerce_gift_cards WHERE purchase_id = ${id} ON CONFLICT(id) DO NOTHING`),
    // The buyer gets a claim link once, however often the payment is confirmed.
    db.run(commerceEmailStatement(
      "gift_card_claim",
      id,
      timestamp,
      sql3`EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases WHERE id = ${id} AND status = 'paid' AND provider_session_id = ${session.id})`
    ))
  ]);
  await sendCommerceEmailNow(env, "gift_card_claim", id, composeGiftCardClaimEmail);
  return { success: true, purchaseId: id };
}
var GIFT_CARD_CLAIM_SECONDS = 7 * 24 * 60 * 60;
var GIFT_CARD_CLAIMS_PER_NETWORK_PER_HOUR = 20;
var CLAIM_TOKEN = /^[0-9a-f]{64}$/;
var claimUrl = (origin, token) => `${origin}/gift-cards/claim#token=${token}`;
function claimTarget(db, purchaseId) {
  return db.select({
    id: giftCardPurchases.id,
    buyerEmail: giftCardPurchases.buyerEmail,
    amountCents: giftCardPurchases.amountCents,
    currency: giftCardPurchases.currency,
    cardId: giftCards.id,
    cardStatus: giftCards.status
  }).from(giftCardPurchases).leftJoin(giftCards, eq3(giftCards.id, currentCard(giftCardPurchases.id))).where(eq3(giftCardPurchases.id, purchaseId)).get();
}
async function newClaimLink(target, now, { resend, condition } = {}) {
  const token = randomHex(32);
  const id = `gclaim_${crypto.randomUUID()}`;
  const expiresAt = now + GIFT_CARD_CLAIM_SECONDS;
  return { id, token, expiresAt, statement: sql3`INSERT INTO _ecommerce_gift_card_claims
      (id,token_hash,purchase_id,card_id,expires_at,created_at,created_by,reason)
      SELECT ${id},${await hashGiftCardSecret(token)},${target.id},${target.cardId},${expiresAt},${now},
        ${resend?.actor ?? null},${resend?.reason ?? null} WHERE ${condition ?? sql3`1`} RETURNING id` };
}
var revokeClaimLinkStatement = (db, id) => db.update(giftCardClaims).set({ revokedAt: /* @__PURE__ */ new Date() }).where(and3(eq3(giftCardClaims.id, id), isNull3(giftCardClaims.revokedAt)));
function claimEmail(setup, target, link) {
  const email = {
    store: setup.store,
    purchase: { id: target.id, amountCents: target.amountCents, currency: target.currency },
    claim: { url: claimUrl(setup.store.origin, link.token), expiresAt: new Date(link.expiresAt * 1e3) }
  };
  return applyEmailTemplate(setup, "giftCardClaim", email, giftCardClaimEmail(email));
}
var composeGiftCardClaimEmail = async (env, purchaseId, setup, now) => {
  const db = commerceDb(env);
  const target = await claimTarget(db, purchaseId);
  if (!target) return { cancel: "not_found" };
  if (!target.cardId || target.cardStatus !== "active") return { cancel: "not_claimable" };
  const to = bareEmailAddress(target.buyerEmail);
  if (!to) return { fail: "invalid_recipient" };
  const link = await newClaimLink(
    { ...target, cardId: target.cardId },
    now,
    { condition: commerceEmailHeld("gift_card_claim", purchaseId, now) }
  );
  if (!await db.get(link.statement)) return { cancel: "superseded" };
  return { to, message: await claimEmail(setup, target, link), onFailure: () => revokeClaimLinkStatement(db, link.id).run() };
};
async function claimGiftCardCode(env, token) {
  if (typeof token !== "string" || !CLAIM_TOKEN.test(token)) return null;
  const now = Math.floor(Date.now() / 1e3);
  const db = commerceDb(env);
  const claim = await db.select({
    id: giftCardClaims.id,
    cardId: giftCardClaims.cardId,
    codeHash: giftCards.codeHash,
    encryptedCode: giftCards.encryptedCode,
    balanceCents: giftCards.balanceCents,
    currency: giftCards.currency
  }).from(giftCardClaims).innerJoin(giftCards, eq3(giftCards.id, giftCardClaims.cardId)).where(and3(
    eq3(giftCardClaims.tokenHash, await hashGiftCardSecret(token)),
    isNull3(giftCardClaims.usedAt),
    isNull3(giftCardClaims.revokedAt),
    gt(giftCardClaims.expiresAt, at3(now)),
    eq3(giftCards.status, "active")
  )).get();
  if (!claim) return null;
  const code = await decryptCardSecret(
    await giftCardKeyring(env),
    { id: claim.cardId, codeHash: claim.codeHash, encryptedCode: claim.encryptedCode }
  );
  const used = await db.update(giftCardClaims).set({ usedAt: at3(now) }).where(and3(
    eq3(giftCardClaims.id, claim.id),
    isNull3(giftCardClaims.usedAt),
    isNull3(giftCardClaims.revokedAt),
    gt(giftCardClaims.expiresAt, at3(now)),
    exists(db.select({ one: sql3`1` }).from(giftCards).where(and3(eq3(giftCards.id, claim.cardId), eq3(giftCards.status, "active"))))
  )).returning({ id: giftCardClaims.id });
  if (!used.length) return null;
  return { code, balanceCents: claim.balanceCents, currency: claim.currency };
}
var resendSchema = z2.object({
  purchaseId: purchaseIdSchema,
  reason: z2.string().trim().min(8).max(500)
}).strict();
async function resendGiftCardClaimLink(env, actor, input) {
  const values = resendSchema.parse(input);
  if (!actor.trim()) throw new Error("Administrator identity is required");
  const setup = await commerceEmailSetup(env);
  const missing = missingEmailSettings(setup, "gift_card_claim");
  if (missing.length) throw new Error(`Email needs ${missing.join(", ")} before a claim link can be sent`);
  const db = commerceDb(env);
  const target = await claimTarget(db, values.purchaseId);
  if (!target) throw new Error("Gift card purchase not found");
  if (!target.cardId || target.cardStatus !== "active") {
    throw new Error("A claim link can be sent only while the card that holds the purchase's value is active");
  }
  const to = bareEmailAddress(target.buyerEmail);
  if (!to) throw new Error("The purchase has no valid buyer address");
  const now = Math.floor(Date.now() / 1e3);
  const hold = await holdCommerceEmail(env, "gift_card_claim", values.purchaseId, now);
  if (hold === "busy") {
    throw new Error("The claim email is being sent right now; reload in a few minutes and resend it only if it was not sent");
  }
  const release = hold === null ? [] : [releaseCommerceEmailStatement(db, "gift_card_claim", values.purchaseId, hold)];
  const link = await newClaimLink({ ...target, cardId: target.cardId }, now, { resend: { actor, reason: values.reason } });
  try {
    await db.get(link.statement);
  } catch (cause) {
    await commitBatch(db, release);
    throw new Error("The purchase's card changed while the link was being made; reload and try again", { cause });
  }
  try {
    await sendCommerceMessage(env, setup, "gift_card_claim", to, await claimEmail(setup, target, link));
  } catch (error) {
    await commitBatch(db, [revokeClaimLinkStatement(db, link.id), ...release]).catch(() => void 0);
    const code = emailErrorCode(error);
    console.warn("[commerce] Gift card claim link not sent", { purchase: values.purchaseId, code });
    throw new Error(`The claim email could not be sent (${code}); earlier links still work. Try again later`);
  }
  try {
    await commitBatch(db, [
      db.update(giftCardClaims).set({ revokedAt: at3(now) }).where(and3(
        eq3(giftCardClaims.purchaseId, values.purchaseId),
        isNull3(giftCardClaims.usedAt),
        isNull3(giftCardClaims.revokedAt),
        lt(sql3`rowid`, db.select({ rowid: sql3`rowid` }).from(giftCardClaims).where(eq3(giftCardClaims.id, link.id)))
      )),
      ...hold === null ? [] : [supersedeCommerceEmailStatement(db, "gift_card_claim", values.purchaseId, hold)]
    ]);
  } catch (cause) {
    throw new Error("The claim email was sent, but earlier links still work; resend it again to stop them", { cause });
  }
  return { purchaseId: values.purchaseId, claimId: link.id, expiresAt: new Date(link.expiresAt * 1e3).toISOString() };
}
async function expireGiftCardPurchase(env, id, sessionId) {
  await commerceDb(env).update(giftCardPurchases).set({ status: "cancelled", updatedAt: /* @__PURE__ */ new Date() }).where(and3(
    eq3(giftCardPurchases.id, id),
    eq3(giftCardPurchases.providerSessionId, sessionId),
    eq3(giftCardPurchases.status, "pending")
  ));
}
async function reconcileGiftCardPurchase(env, adapter, id) {
  const db = commerceDb(env);
  const purchase = await db.select().from(giftCardPurchases).where(eq3(giftCardPurchases.id, id)).get();
  if (!purchase || purchase.status !== "pending" || !purchase.providerSessionId) return null;
  if (purchase.reconcileReviewAt) return { status: "pending", review: true };
  if (adapter?.providerId !== "stripe" || !adapter.getCheckoutSession) {
    throw new ReconcileFailure("provider_not_configured", "Stripe session lookup is required for gift card reconciliation");
  }
  assertStoreStripeMode(env, purchase.providerSessionId);
  const session = await adapter.getCheckoutSession(purchase.providerSessionId).catch((error) => {
    throw sessionLookupFailure(error);
  });
  if (session.status === "expired") {
    await expireGiftCardPurchase(env, id, purchase.providerSessionId);
    return { status: "cancelled" };
  }
  if (session.status === "complete" && session.paymentStatus === "paid") {
    if (session.amountTotal !== purchase.amountCents || session.currency?.toLowerCase() !== purchase.currency.toLowerCase() || !session.paymentIntentId) {
      throw new ReconcileFailure("payment_mismatch", "Gift card payment does not match purchase");
    }
    await confirmGiftCardPurchase(env, {
      id: purchase.providerSessionId,
      metadata: { giftCardPurchaseId: id },
      amount_total: session.amountTotal ?? void 0,
      currency: session.currency ?? void 0,
      payment_status: session.paymentStatus,
      payment_intent: session.paymentIntentId ?? void 0
    });
    return { status: "paid" };
  }
  return { status: "pending" };
}
async function getPurchasedGiftCard(env, id, accessToken) {
  if (!/^gp_[0-9a-f-]{36}$/.test(id) || !accessToken) return null;
  const db = commerceDb(env);
  const purchase = await db.select().from(giftCardPurchases).where(eq3(giftCardPurchases.id, id)).get();
  if (!purchase || purchase.accessTokenHash !== await hashGiftCardSecret(accessToken)) return null;
  const card = await db.select().from(giftCards).where(eq3(giftCards.purchaseId, id)).get();
  return {
    status: purchase.status,
    amountCents: purchase.amountCents,
    // A card whose value moved to a replacement is void, and its code no longer shown.
    code: card && purchase.status === "paid" && card.status !== "void" ? await decryptCardSecret(await giftCardKeyring(env), card) : null,
    balanceCents: card?.balanceCents ?? null,
    // A pending purchase whose payment check is parked stays pending until an administrator decides.
    paymentUnderReview: purchase.status === "pending" && purchase.reconcileReviewAt !== null
  };
}
function giftCardPurchaseHoldStatements(purchaseId, timestamp) {
  const unspentFullRefund = sql3`EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p
    WHERE p.id = ${purchaseId} AND p.status = 'review' AND p.provider_refunded_cents >= p.amount_cents
      AND NOT ${pendingCheckout(p.id)}
      AND (SELECT COALESCE(SUM(l.amount_cents),0) FROM _ecommerce_gift_card_ledger l
        JOIN _ecommerce_gift_cards f ON f.id = l.card_id
        WHERE (f.purchase_id = p.id OR f.replaces_purchase_id = p.id)
          AND l.kind IN ('reserve','release','refund_restore')) = 0)`;
  return [
    sql3`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_purchase_reversal_' || c.id,c.id,${purchaseId},'purchase_reversal',-c.balance_cents,${timestamp}
      FROM _ecommerce_gift_cards c WHERE (c.purchase_id = ${purchaseId} OR c.replaces_purchase_id = ${purchaseId})
        AND c.status <> 'void' AND c.balance_cents > 0 AND ${unspentFullRefund}
      ON CONFLICT(id) DO NOTHING`,
    sql3`UPDATE _ecommerce_gift_cards SET status = 'void',held_for_review = 0,updated_at = ${timestamp}
      WHERE (purchase_id = ${purchaseId} OR replaces_purchase_id = ${purchaseId}) AND status <> 'void' AND ${unspentFullRefund}`,
    sql3`UPDATE _ecommerce_gift_card_purchases
      SET status = CASE WHEN provider_refunded_cents >= amount_cents THEN 'refunded' ELSE 'partially_refunded' END,
        refund_adjusted_cents = provider_refunded_cents,updated_at = ${timestamp}
      WHERE id = ${purchaseId} AND status = 'review' AND NOT EXISTS (SELECT 1 FROM _ecommerce_gift_cards c
        WHERE (c.purchase_id = ${purchaseId} OR c.replaces_purchase_id = ${purchaseId}) AND c.status <> 'void')`,
    sql3`UPDATE _ecommerce_gift_cards SET status = 'suspended',held_for_review = 1,updated_at = ${timestamp}
      WHERE (purchase_id = ${purchaseId} OR replaces_purchase_id = ${purchaseId}) AND status = 'active'
        AND EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p WHERE p.id = ${purchaseId} AND p.status = 'review')`
  ];
}
function giftCardPurchaseReleaseStatements(purchaseId, timestamp) {
  return [
    sql3`UPDATE _ecommerce_gift_cards SET status = 'active',held_for_review = 0,updated_at = ${timestamp}
      WHERE (purchase_id = ${purchaseId} OR replaces_purchase_id = ${purchaseId}) AND status = 'suspended' AND held_for_review = 1
        AND EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p WHERE p.id = ${purchaseId} AND ${settledPurchase(p)})`
  ];
}
function giftCardPurchaseChargebackStatements(purchaseId, timestamp) {
  const clear = sql3`NOT EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p WHERE p.id = ${purchaseId} AND ${pendingCheckout(p.id)})`;
  return [
    sql3`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_chargeback_' || c.id,c.id,${purchaseId},'purchase_reversal',-c.balance_cents,${timestamp}
      FROM _ecommerce_gift_cards c WHERE (c.purchase_id = ${purchaseId} OR c.replaces_purchase_id = ${purchaseId})
        AND c.status <> 'void' AND c.balance_cents > 0 AND ${clear}
      ON CONFLICT(id) DO NOTHING`,
    sql3`UPDATE _ecommerce_gift_cards SET status = 'void',held_for_review = 0,updated_at = ${timestamp}
      WHERE (purchase_id = ${purchaseId} OR replaces_purchase_id = ${purchaseId}) AND status <> 'void' AND ${clear}`,
    sql3`UPDATE _ecommerce_gift_card_purchases
      SET status = 'refunded',refund_adjusted_cents = provider_refunded_cents,updated_at = ${timestamp}
      WHERE id = ${purchaseId} AND status IN ('paid','partially_refunded','refunded','review')
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_gift_cards c
          WHERE (c.purchase_id = ${purchaseId} OR c.replaces_purchase_id = ${purchaseId}) AND c.status <> 'void')`
  ];
}
async function recordGiftCardPurchaseRefund(env, params) {
  const db = commerceDb(env);
  const purchase = await db.select().from(giftCardPurchases).where(eq3(giftCardPurchases.paymentIntentId, params.paymentIntentId)).get();
  if (!purchase) return null;
  if (purchase.amountCents !== params.amount || params.currency.toLowerCase() !== purchase.currency.toLowerCase() || !Number.isSafeInteger(params.amountRefunded) || params.amountRefunded < 0 || params.amountRefunded > purchase.amountCents) {
    throw new WebhookMismatchError("refund_mismatch", "Gift card refund does not match purchase");
  }
  if (params.amountRefunded <= purchase.providerRefundedCents) return { success: true, duplicate: true };
  const timestamp = Math.floor(Date.now() / 1e3);
  await commitBatch(db, [
    db.update(giftCardPurchases).set({ status: "review", providerRefundedCents: params.amountRefunded, updatedAt: at3(timestamp) }).where(and3(eq3(giftCardPurchases.id, purchase.id), lt(giftCardPurchases.providerRefundedCents, params.amountRefunded))),
    ...giftCardPurchaseHoldStatements(purchase.id, timestamp).map((statement) => db.run(statement))
  ]);
  const current = await db.select({ status: giftCardPurchases.status }).from(giftCardPurchases).where(eq3(giftCardPurchases.id, purchase.id)).get();
  return { success: true, purchaseId: purchase.id, status: current?.status ?? "review" };
}
var reviewSchema = z2.object({
  purchaseId: purchaseIdSchema,
  outcome: z2.enum(["reinstate", "void"]),
  reason: z2.string().trim().min(8).max(500),
  // The refund total the administrator decided on; a refund recorded since then stops the action.
  refundedCents: z2.number().int().positive()
}).strict();
async function resolveGiftCardReview(env, actor, input) {
  const values = reviewSchema.parse(input);
  if (!actor.trim()) throw new Error("Administrator identity is required");
  const db = commerceDb(env);
  const purchase = await reviewQuery(db).where(eq3(p.id, values.purchaseId)).get();
  if (purchase?.status !== "review") throw new Error("Gift card purchase is not held for review");
  const disputed = await db.select({ open: openDispute(P_ID) }).from(p).where(eq3(p.id, values.purchaseId)).get();
  if (disputed?.open) throw new Error("A payment dispute is open for this purchase; its cards stay held until the dispute closes");
  if (purchase.refundedCents !== values.refundedCents) {
    throw new Error("Another refund was recorded for this purchase; reload and review it again");
  }
  if (values.outcome === "reinstate" && !purchase.cardId) {
    throw new Error("Every card of this purchase is void, so it cannot be reinstated");
  }
  if (values.outcome === "reinstate" && (purchase.balanceCents ?? 0) < purchase.refundedCents - purchase.adjustedCents) {
    throw new Error("The card balance does not cover the refund; void the card instead");
  }
  if (values.outcome === "void" && purchase.pendingCents > 0) {
    throw new Error("A checkout in progress holds value on this purchase's card; void it once that checkout completes or expires");
  }
  const reviewId = `gcrev_${crypto.randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1e3);
  const held = sql3`EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases
    WHERE id = ${values.purchaseId} AND status = 'review' AND provider_refunded_cents = ${values.refundedCents})`;
  const recorded = sql3`EXISTS (SELECT 1 FROM _ecommerce_gift_card_reviews WHERE id = ${reviewId})`;
  const funded = or2(eq3(giftCards.purchaseId, values.purchaseId), eq3(giftCards.replacesPurchaseId, values.purchaseId));
  const review = values.outcome === "reinstate" ? db.all(sql3`INSERT INTO _ecommerce_gift_card_reviews
      (id,purchase_id,card_id,outcome,refunded_cents,adjustment_cents,admin_actor,reason,created_at)
      SELECT ${reviewId},p.id,c.id,'reinstate',p.provider_refunded_cents,p.provider_refunded_cents - p.refund_adjusted_cents,${actor},${values.reason},${timestamp}
      FROM _ecommerce_gift_card_purchases p JOIN _ecommerce_gift_cards c ON c.id = ${currentCard(p.id)}
      WHERE p.id = ${values.purchaseId} AND p.status = 'review' AND p.provider_refunded_cents = ${values.refundedCents}
        AND c.balance_cents >= p.provider_refunded_cents - p.refund_adjusted_cents AND NOT ${openDispute(p.id)}
      RETURNING adjustment_cents`) : db.all(sql3`INSERT INTO _ecommerce_gift_card_reviews
      (id,purchase_id,card_id,outcome,refunded_cents,adjustment_cents,admin_actor,reason,created_at)
      SELECT ${reviewId},p.id,COALESCE(${currentCard(p.id)},
          (SELECT o.id FROM _ecommerce_gift_cards o WHERE o.purchase_id = p.id)),
        'void',p.provider_refunded_cents,${cardValue(p.id)},${actor},${values.reason},${timestamp}
      FROM _ecommerce_gift_card_purchases p
      WHERE p.id = ${values.purchaseId} AND p.status = 'review' AND p.provider_refunded_cents = ${values.refundedCents}
        AND NOT ${pendingCheckout(p.id)} AND NOT ${openDispute(p.id)}
      RETURNING adjustment_cents`);
  const effects = values.outcome === "reinstate" ? [
    db.run(sql3`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_' || r.id,r.card_id,r.purchase_id,'purchase_reversal',-r.adjustment_cents,r.created_at
      FROM _ecommerce_gift_card_reviews r WHERE r.id = ${reviewId} AND r.adjustment_cents > 0 AND ${held}`),
    db.update(giftCards).set({ status: "active", heldForReview: false, updatedAt: at3(timestamp) }).where(and3(funded, eq3(giftCards.status, "suspended"), eq3(giftCards.heldForReview, true), held, recorded))
  ] : [
    db.run(sql3`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT ${`gcl_${reviewId}`} || '_' || id,id,${values.purchaseId},'purchase_reversal',-balance_cents,${timestamp}
      FROM _ecommerce_gift_cards WHERE (purchase_id = ${values.purchaseId} OR replaces_purchase_id = ${values.purchaseId})
        AND status <> 'void' AND balance_cents > 0 AND ${held} AND ${recorded}`),
    db.update(giftCards).set({ status: "void", heldForReview: false, updatedAt: at3(timestamp) }).where(and3(funded, ne(giftCards.status, "void"), held, recorded))
  ];
  const settled = db.update(giftCardPurchases).set({
    status: sql3`CASE WHEN ${giftCardPurchases.providerRefundedCents} >= ${giftCardPurchases.amountCents} THEN 'refunded' ELSE 'partially_refunded' END`,
    refundAdjustedCents: giftCardPurchases.providerRefundedCents,
    updatedAt: at3(timestamp)
  }).where(and3(
    eq3(giftCardPurchases.id, values.purchaseId),
    eq3(giftCardPurchases.status, "review"),
    eq3(giftCardPurchases.providerRefundedCents, values.refundedCents),
    recorded
  ));
  const [[adjustment]] = await db.batch([review, ...effects, settled]);
  if (!adjustment) throw new Error("The purchase changed while it was being resolved; reload and review it again");
  return {
    id: reviewId,
    purchaseId: values.purchaseId,
    outcome: values.outcome,
    adjustmentCents: adjustment.adjustment_cents,
    status: values.refundedCents >= purchase.amountCents ? "refunded" : "partially_refunded"
  };
}
var refundSchema = z2.object({
  orderId: z2.string().regex(/^ord_[0-9a-f-]{36}$/),
  reason: z2.string().trim().min(8).max(500),
  amountCents: z2.number().int().positive().optional()
}).strict();
async function refundGiftCardTender(env, actor, input) {
  const values = refundSchema.parse(input);
  if (!actor.trim()) throw new Error("Administrator identity is required");
  const db = commerceDb(env);
  const current = await db.select({
    giftCardId: orders.giftCardId,
    giftCardApplied: orders.giftCardApplied,
    giftCardRefundedCents: orders.giftCardRefundedCents,
    status: orders.status,
    referralCode: orders.referralCode
  }).from(orders).where(eq3(orders.id, values.orderId)).get();
  if (!current?.giftCardId || !["paid", "fulfilled", "partially_refunded"].includes(current.status)) {
    throw new Error("Order is unavailable for a gift card refund");
  }
  const remaining = current.giftCardApplied - current.giftCardRefundedCents;
  if (!values.amountCents || values.amountCents > remaining) throw new Error("Refund exceeds gift card payment");
  const id = `gfr_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1e3);
  const statements = [db.insert(giftCardRefunds).values({
    id,
    cardId: current.giftCardId,
    orderId: values.orderId,
    amountCents: values.amountCents,
    adminActor: actor,
    reason: values.reason,
    createdAt: at3(now)
  })];
  if (current.referralCode) {
    const policy = await getReferralPolicy(env);
    statements.push(...referralReversalStatements(values.orderId, { minOrderCents: policy.minOrderCents, now }).map((statement) => db.run(statement)));
  }
  await commitBatch(db, statements);
  return { id, orderId: values.orderId, amountCents: values.amountCents };
}
async function refundGiftCardOnlyOrder(env, actor, input) {
  const values = refundSchema.parse(input);
  if (!actor.trim() || values.amountCents !== void 0) throw new Error("Invalid full refund request");
  const db = commerceDb(env);
  const order = await db.select({
    id: orders.id,
    giftCardId: orders.giftCardId,
    giftCardApplied: orders.giftCardApplied,
    giftCardRefundedCents: orders.giftCardRefundedCents,
    creditApplied: orders.creditApplied,
    paymentProvider: orders.paymentProvider,
    totalAmount: orders.totalAmount,
    status: orders.status,
    userId: orders.userId
  }).from(orders).where(eq3(orders.id, values.orderId)).get();
  if (!order?.giftCardId || order.paymentProvider !== "gift_card" || order.totalAmount !== 0 || !["paid", "partially_refunded", "fulfilled"].includes(order.status)) {
    throw new Error("Only paid gift-card-only orders can be refunded here");
  }
  const now = Math.floor(Date.now() / 1e3);
  const remaining = order.giftCardApplied - order.giftCardRefundedCents;
  const confirmed = (redemptions) => and3(eq3(redemptions.orderId, order.id), eq3(redemptions.status, "confirmed"));
  await commitBatch(db, [
    db.insert(giftCardOrderRefunds).values({ orderId: order.id, adminActor: actor, reason: values.reason, createdAt: at3(now) }),
    ...remaining > 0 ? [db.insert(giftCardRefunds).values({
      id: `gfr_full_${order.id}`,
      cardId: order.giftCardId,
      orderId: order.id,
      amountCents: remaining,
      adminActor: actor,
      reason: values.reason,
      createdAt: at3(now)
    })] : [],
    db.update(orders).set({ status: "refunded", updatedAt: at3(now) }).where(and3(
      eq3(orders.id, order.id),
      eq3(orders.paymentProvider, "gift_card"),
      eq3(orders.totalAmount, 0),
      inArray(orders.status, ["paid", "fulfilled", "partially_refunded"])
    )),
    db.update(giftCardRedemptions).set({ status: "refunded", updatedAt: at3(now) }).where(confirmed(giftCardRedemptions)),
    db.update(discountRedemptions).set({ status: "refunded", updatedAt: at3(now) }).where(confirmed(discountRedemptions)),
    ...order.creditApplied > 0 && order.userId ? [db.insert(creditLedger).values({
      id: `credit_refund_${order.id}`,
      accountId: order.userId,
      orderId: order.id,
      kind: "purchase_credit_refund",
      amountCents: order.creditApplied,
      createdAt: at3(now)
    }).onConflictDoNothing({ target: [creditLedger.orderId, creditLedger.kind] })] : [],
    db.update(payments).set({ status: "refunded" }).where(eq3(payments.orderId, order.id))
  ]);
  return { orderId: order.id, status: "refunded" };
}

export {
  COUNTRY_CODES,
  isCountryCode,
  StoreSettingsError,
  readStoreSettings,
  readStoreCurrency,
  reportStoreSettingsError,
  WebhookSignatureError,
  WebhookRetryLaterError,
  WebhookMismatchError,
  RECONCILE_FAILURE_MESSAGES,
  ReconcileFailure,
  isMissingSessionError,
  sessionLookupFailure,
  isProviderError,
  reconcileFailure,
  isOtherStripeModeSession,
  assertStoreStripeMode,
  RECONCILE_TABLES,
  completedCheckoutReturn,
  decisionInsert,
  uncheckedSessionRefusal,
  backoff,
  reconcileBackoff,
  reconcileAttempt,
  COMMERCE_EMAIL_MAX_AGE_SECONDS,
  COMMERCE_EMAIL_LEASE_SECONDS,
  unclaimedAt,
  bareEmailAddress,
  commerceEmailSetup,
  missingEmailSettings,
  waitingEmailsResult,
  applyEmailTemplate,
  commerceEmailStatement,
  runCommerceEmailDelivery,
  sendCommerceEmailNow,
  hashGiftCardSecret,
  reencryptGiftCardCodes,
  getGiftCardKeyStatus,
  issueAdminGiftCard,
  getGiftCardsAdmin,
  getGiftCardReviewsAdmin,
  setGiftCardActive,
  GiftCardRefusal,
  evaluateGiftCard,
  getGiftCardBalance,
  startGiftCardPurchase,
  confirmGiftCardPurchase,
  GIFT_CARD_CLAIM_SECONDS,
  GIFT_CARD_CLAIMS_PER_NETWORK_PER_HOUR,
  composeGiftCardClaimEmail,
  claimGiftCardCode,
  resendGiftCardClaimLink,
  expireGiftCardPurchase,
  reconcileGiftCardPurchase,
  getPurchasedGiftCard,
  giftCardPurchaseHoldStatements,
  giftCardPurchaseReleaseStatements,
  giftCardPurchaseChargebackStatements,
  recordGiftCardPurchaseRefund,
  resolveGiftCardReview,
  refundGiftCardTender,
  refundGiftCardOnlyOrder
};
