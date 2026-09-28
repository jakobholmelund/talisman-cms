import {
  getReferralPolicy,
  referralReversalStatements
} from "./chunk-2XVZABM5.js";
import {
  runtimeStripeMode,
  stripeSessionMode
} from "./chunk-GNU6N22K.js";
import {
  commerceDb
} from "./chunk-DUYAQ7V4.js";
import {
  emailDeliveries,
  giftCardClaims,
  giftCardPurchases,
  giftCards,
  orders
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
import { and as and2, eq as eq2, gt, isNull as isNull2, sql as sql2 } from "drizzle-orm";
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
  order: "_ecommerce_orders",
  gift_card_purchase: "_ecommerce_gift_card_purchases"
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
function decisionInsert(kind, action, condition) {
  const [orderId, purchaseId] = kind === "order" ? ["id", "NULL"] : ["NULL", "id"];
  return `INSERT INTO _ecommerce_reconcile_decisions
      (id, order_id, purchase_id, action, failure, payment_returned, admin_actor, reason, created_at)
    SELECT ?, ${orderId}, ${purchaseId}, '${action}', reconcile_last_error, ?, ?, ?, ?
    FROM ${RECONCILE_TABLES[kind]} WHERE id = ? AND ${condition}`;
}
var RECONCILE_MAX_BACKOFF_SECONDS = 6 * 60 * 60;
function uncheckedSessionRefusal(checkoutStartedAt, now = Math.floor(Date.now() / 1e3)) {
  const releasable = checkoutStartedAt + 35 * 60;
  if (now >= releasable) return null;
  return new Error(`Stripe cannot be asked about this checkout session, which may still be paid until it expires. Release it after ${new Date(releasable * 1e3).toISOString()}, 35 minutes after the checkout started.`);
}
function backoffSql(columns, alias) {
  const column = (name) => alias ? `${alias}.${name}` : name;
  const lastAt = column(`${columns}_last_at`);
  return {
    due: `(${lastAt} IS NULL
  OR ${lastAt} <= ? - MIN(${RECONCILE_MAX_BACKOFF_SECONDS}, 60 << MIN(${column(`${columns}_attempts`)}, 9)))`,
    order: `COALESCE(${lastAt}, 0), ${column("created_at")}, ${column("id")}`
  };
}
var RECONCILE_BACKOFF = backoffSql("reconcile");
var RECONCILE_DUE = RECONCILE_BACKOFF.due;
var RECONCILE_ORDER = RECONCILE_BACKOFF.order;
async function recordAttempt(env, kind, id, now, failure) {
  const table = RECONCILE_TABLES[kind];
  if (failure?.permanent) {
    const parked = await env.DB.prepare(`UPDATE ${table} SET reconcile_attempts = reconcile_attempts + 1,
        reconcile_last_at = ?, reconcile_last_error = ?, reconcile_review_at = ?
      WHERE id = ? AND status = 'pending' AND reconcile_review_at IS NULL RETURNING id`).bind(now, failure.code, now, id).all();
    return parked.results?.length ? "parked" : "skipped";
  }
  const recorded = await env.DB.prepare(`UPDATE ${table} SET reconcile_attempts = reconcile_attempts + 1,
      reconcile_last_at = ?, reconcile_last_error = ?
    WHERE id = ? AND reconcile_review_at IS NULL RETURNING id`).bind(now, failure?.code ?? null, id).all();
  return recorded.results?.length ? "recorded" : "skipped";
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
    const recorded = await recordAttempt(env, kind, id, now, failure);
    if (recorded === "parked") result.parked = true;
    if (recorded === "skipped" && failure) {
      const row = await env.DB.prepare(`SELECT status FROM ${RECONCILE_TABLES[kind]} WHERE id = ?`).bind(id).first();
      return { id, status: row?.status ?? "unchanged" };
    }
  } catch {
    return { id, status: "error", error: "The reconciliation attempt could not be recorded", code: failure?.code ?? "failed" };
  }
  return result;
}

// src/email-deliveries.ts
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
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
var at = (seconds) => new Date(seconds * 1e3);
var pendingEmail = (kind, subjectId) => and(
  eq(emailDeliveries.kind, kind),
  eq(emailDeliveries.subjectId, subjectId),
  eq(emailDeliveries.status, "pending")
);
var unclaimedAt = (now) => or(
  isNull(emailDeliveries.claimedAt),
  lte(emailDeliveries.claimedAt, at(now - COMMERCE_EMAIL_LEASE_SECONDS))
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
  const count = `${waiting}${waiting === limit ? " or more" : ""} email${waiting === 1 ? " is" : "s are"} waiting`;
  return { id: "commerce_emails", status: "error", error: `${what} ${missing.join(", ")}; ${count}` };
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
function commerceEmailStatement(env, kind, subjectId, now, condition) {
  return env.DB.prepare(`INSERT INTO _ecommerce_email_deliveries (id, kind, subject_id, next_attempt_at, created_at)
    SELECT ?, ?, ?, ?, ? WHERE ${condition?.sql ?? "1"}
    ON CONFLICT (kind, subject_id) DO NOTHING`).bind(`mail_${crypto.randomUUID()}`, kind, subjectId, now, now, ...condition?.params ?? []);
}
function commerceEmailHeld(kind, subjectId, stamp) {
  return { sql: `EXISTS (SELECT 1 FROM _ecommerce_email_deliveries
    WHERE kind = ? AND subject_id = ? AND status = 'pending' AND claimed_at = ?)`, params: [kind, subjectId, stamp] };
}
async function holdCommerceEmail(env, kind, subjectId, now) {
  const db = commerceDb(env);
  const [held] = await db.update(emailDeliveries).set({ claimedAt: at(now) }).where(and(pendingEmail(kind, subjectId), unclaimedAt(now))).returning({ id: emailDeliveries.id });
  if (held) return now;
  const pending = await db.select({ id: emailDeliveries.id }).from(emailDeliveries).where(pendingEmail(kind, subjectId)).get();
  return pending ? "busy" : null;
}
function releaseCommerceEmailStatement(env, kind, subjectId, stamp) {
  return env.DB.prepare(`UPDATE _ecommerce_email_deliveries SET claimed_at = NULL
    WHERE kind = ? AND subject_id = ? AND status = 'pending' AND claimed_at = ?`).bind(kind, subjectId, stamp);
}
function supersedeCommerceEmailStatement(env, kind, subjectId, stamp) {
  return env.DB.prepare(`UPDATE _ecommerce_email_deliveries SET status = 'cancelled', last_error = 'superseded',
      claimed_at = NULL
    WHERE kind = ? AND subject_id = ? AND status = 'pending' AND claimed_at = ?`).bind(kind, subjectId, stamp);
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
    const [claimed] = await db.update(emailDeliveries).set({ claimedAt: at(now), attempts: sql`${emailDeliveries.attempts} + 1` }).where(and(pendingEmail(kind, subjectId), lte(emailDeliveries.nextAttemptAt, at(now)), unclaimedAt(now))).returning({ id: emailDeliveries.id, attempts: emailDeliveries.attempts });
    if (!claimed) return null;
    const settle = async (outcome) => {
      const { meta } = await db.update(emailDeliveries).set({ ...outcome, claimedAt: null }).where(and(eq(emailDeliveries.id, claimed.id), eq(emailDeliveries.claimedAt, at(now)))).run();
      return Number(meta?.changes ?? 0) > 0;
    };
    const recordFailure = async (code) => {
      if (code === "recipient_suppressed") {
        return await settle({ status: "failed", lastError: code }) ? { id, status: "email_undeliverable", error: code } : null;
      }
      if (claimed.attempts >= COMMERCE_EMAIL_MAX_ATTEMPTS) {
        return await settle({ status: "failed", lastError: code }) ? { id, status: "error", error: `${label} was given up after ${claimed.attempts} attempts (${code})` } : null;
      }
      if (!await settle({ lastError: code, nextAttemptAt: at(now + commerceEmailRetryDelay(claimed.attempts)) })) return null;
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
    await settle({ status: "sent", sentAt: at(now), lastError: null });
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
var at2 = (seconds) => new Date(seconds * 1e3);
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
  const rows = await db.select({ id: giftCards.id, codeHash: giftCards.codeHash, encryptedCode: giftCards.encryptedCode }).from(giftCards).where(and2(sql2`substr(${giftCards.encryptedCode}, 1, ${prefix.length}) <> ${prefix}`, gt(giftCards.id, after))).orderBy(giftCards.id).limit(limit);
  const reencrypt = (row, encryptedCode) => db.update(giftCards).set({ encryptedCode }).where(and2(eq2(giftCards.id, row.id), eq2(giftCards.encryptedCode, row.encryptedCode))).returning({ id: giftCards.id });
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
  const row = await env.DB.prepare(`SELECT
      COALESCE(SUM(substr(encrypted_code,1,3) = 'v2:' AND substr(encrypted_code,1,?) <> ?),0) AS previousKeyCodes,
      COALESCE(SUM(substr(encrypted_code,1,3) <> 'v2:'),0) AS legacyCodes
    FROM _ecommerce_gift_cards`).bind(prefix.length, prefix).first();
  return { keyId: current.id, previousKeyCodes: row?.previousKeyCodes ?? 0, legacyCodes: row?.legacyCodes ?? 0 };
}
var settledPurchase = `(p.status = 'paid' OR (p.status IN ('partially_refunded','refunded')
  AND p.refund_adjusted_cents = p.provider_refunded_cents))`;
var currentCard = (purchase) => `SELECT k.id FROM _ecommerce_gift_cards k
  WHERE (k.purchase_id = ${purchase} OR k.replaces_purchase_id = ${purchase}) AND k.status <> 'void'
  ORDER BY k.source = 'admin' DESC,k.created_at DESC,k.id DESC LIMIT 1`;
var pendingCheckout = (purchase) => `EXISTS (SELECT 1 FROM _ecommerce_gift_card_redemptions r
  JOIN _ecommerce_gift_cards f ON f.id = r.card_id
  WHERE (f.purchase_id = ${purchase} OR f.replaces_purchase_id = ${purchase}) AND r.status = 'reserved')`;
var cardValue = (purchase) => `(SELECT COALESCE(SUM(f.balance_cents),0) FROM _ecommerce_gift_cards f
  WHERE (f.purchase_id = ${purchase} OR f.replaces_purchase_id = ${purchase}) AND f.status <> 'void')`;
var units = (cents, currency) => `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
async function assertReplaceable(env, purchaseId, amountCents) {
  const purchase = await env.DB.prepare(`SELECT p.status,p.currency,${settledPurchase} AS settled,
      ${cardValue("p.id")} AS value,${pendingCheckout("p.id")} AS pending
    FROM _ecommerce_gift_card_purchases p WHERE p.id = ?`).bind(purchaseId).first();
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
  if (replaces) await assertReplaceable(env, replaces, amountCents);
  const id = `gift_${crypto.randomUUID()}`;
  const secret = await newCardSecret(env, id);
  const timestamp = Math.floor(Date.now() / 1e3);
  const statements = [
    env.DB.prepare(`INSERT INTO _ecommerce_gift_cards
      (id,code_hash,code_suffix,encrypted_code,source,admin_actor,admin_reason,replaces_purchase_id,initial_cents,balance_cents,currency,status,created_at,updated_at)
      SELECT ?,?,?,?,'admin',?,?,?,?,0,?,'active',?,?
      WHERE ? IS NULL OR EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p
        WHERE p.id = ? AND p.currency = ? AND p.status IN ('paid','partially_refunded') AND ${settledPurchase}
          AND NOT ${pendingCheckout("p.id")} AND ${cardValue("p.id")} = ?)
      RETURNING id`).bind(
      id,
      secret.codeHash,
      secret.codeSuffix,
      secret.encryptedCode,
      actor,
      reason,
      replaces,
      amountCents,
      currency,
      timestamp,
      timestamp,
      replaces,
      replaces,
      currency,
      amountCents
    ),
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT ?,id,replaces_purchase_id,'issue',initial_cents,? FROM _ecommerce_gift_cards WHERE id = ?`).bind(`gcl_issue_${id}`, timestamp, id)
  ];
  if (replaces) {
    const replacementIssued = `EXISTS (SELECT 1 FROM _ecommerce_gift_cards n WHERE n.id = ?)`;
    statements.push(
      env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
        (id,card_id,purchase_id,kind,amount_cents,created_at)
        SELECT 'gcl_replaced_' || c.id,c.id,?,'purchase_reversal',-c.balance_cents,?
        FROM _ecommerce_gift_cards c WHERE (c.purchase_id = ? OR c.replaces_purchase_id = ?) AND c.id <> ?
          AND c.status <> 'void' AND c.balance_cents > 0 AND ${replacementIssued}`).bind(replaces, timestamp, replaces, replaces, id, id),
      env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = 'void',held_for_review = 0,updated_at = ?
        WHERE (purchase_id = ? OR replaces_purchase_id = ?) AND id <> ? AND status <> 'void' AND ${replacementIssued}`).bind(timestamp, replaces, replaces, id, id)
    );
  }
  const [inserted] = await env.DB.batch(statements);
  if (!inserted.results?.length) throw new Error("The purchase changed while its card was being replaced; reload and try again");
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
    buyerEmail: sql2`(SELECT p.buyer_email FROM _ecommerce_gift_card_purchases p
      WHERE p.id = COALESCE(_ecommerce_gift_cards.purchase_id, _ecommerce_gift_cards.replaces_purchase_id))`,
    adminActor: giftCards.adminActor,
    adminReason: giftCards.adminReason,
    initialCents: giftCards.initialCents,
    balanceCents: giftCards.balanceCents,
    currency: giftCards.currency,
    status: giftCards.status,
    // While its purchase is held for review, the card cannot be reactivated.
    inReview: sql2`EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p
      WHERE p.id IN (${giftCards.purchaseId}, ${giftCards.replacesPurchaseId}) AND p.status = 'review')`.mapWith(Boolean),
    // Read through the purchase index: a card's links all belong to its purchase, or to the one it replaces.
    claimLink: sql2`(SELECT json_object('createdAt', l.created_at, 'expiresAt', l.expires_at, 'usedAt', l.used_at,
        'revokedAt', l.revoked_at, 'resent', l.created_by IS NOT NULL)
      FROM _ecommerce_gift_card_claims l
      WHERE l.purchase_id = COALESCE(_ecommerce_gift_cards.purchase_id, _ecommerce_gift_cards.replaces_purchase_id)
        AND l.card_id = _ecommerce_gift_cards.id
      -- A link the buyer can still use comes first, so a resend that failed never hides a working link.
      ORDER BY (l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > CAST(strftime('%s', 'now') AS INTEGER)) DESC,
        l.created_at DESC, l.rowid DESC LIMIT 1)`.mapWith(claimLinkView),
    claimEmail: sql2`(SELECT json_object('status', d.status, 'lastError', d.last_error, 'attempts', d.attempts)
      FROM _ecommerce_email_deliveries d WHERE d.kind = 'gift_card_claim' AND d.subject_id = _ecommerce_gift_cards.purchase_id)`.mapWith(claimEmailView),
    createdAt: giftCards.createdAt
  }).from(giftCards).orderBy(giftCards.createdAt);
}
var reviewSelect = `SELECT p.id AS purchaseId,p.status,p.amount_cents AS amountCents,p.currency,
    p.provider_refunded_cents AS refundedCents,p.refund_adjusted_cents AS adjustedCents,
    c.id AS cardId,c.code_suffix AS codeSuffix,c.status AS cardStatus,c.held_for_review AS cardHeld,
    c.replaces_purchase_id IS NOT NULL AS cardReplacement,c.balance_cents AS balanceCents,
    (SELECT -COALESCE(SUM(l.amount_cents),0) FROM _ecommerce_gift_card_ledger l
      JOIN _ecommerce_gift_cards f ON f.id = l.card_id
      WHERE (f.purchase_id = p.id OR f.replaces_purchase_id = p.id)
        AND l.kind IN ('reserve','release','refund_restore')) AS spentCents,
    (SELECT COALESCE(SUM(r.amount_cents),0) FROM _ecommerce_gift_card_redemptions r
      JOIN _ecommerce_gift_cards f ON f.id = r.card_id
      WHERE (f.purchase_id = p.id OR f.replaces_purchase_id = p.id) AND r.status = 'reserved') AS pendingCents,
    (SELECT COUNT(*) FROM _ecommerce_gift_cards f WHERE f.replaces_purchase_id = p.id) AS replacementCount
  FROM _ecommerce_gift_card_purchases p LEFT JOIN _ecommerce_gift_cards c ON c.id = (${currentCard("p.id")})`;
var reviewView = (row) => ({ ...row, cardHeld: row.cardHeld === 1, cardReplacement: row.cardReplacement === 1 });
var openDispute = (purchase) => `EXISTS (SELECT 1 FROM _ecommerce_disputes d
  WHERE d.gift_card_purchase_id = ${purchase} AND d.closed_at IS NULL)`;
async function getGiftCardReviewsAdmin(env) {
  const rows = await env.DB.prepare(`${reviewSelect}
    WHERE p.status = 'review' AND NOT ${openDispute("p.id")} ORDER BY p.updated_at,p.id LIMIT 100`).all();
  const total = await env.DB.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_gift_card_purchases p
    WHERE p.status = 'review' AND NOT ${openDispute("p.id")}`).first();
  return { reviews: (rows.results ?? []).map(reviewView), reviewCount: total?.count ?? 0 };
}
async function setGiftCardActive(env, id, active) {
  if (!/^gift_[0-9a-f-]{36}$/.test(id) || typeof active !== "boolean") throw new Error("Invalid gift card");
  const db = commerceDb(env);
  const card = await db.select().from(giftCards).where(eq2(giftCards.id, id)).get();
  if (!card || card.status === "void") throw new Error("Gift card is unavailable");
  const timestamp = Math.floor(Date.now() / 1e3);
  const result = await env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = ?,held_for_review = 0,updated_at = ?
    WHERE id = ? AND status <> 'void' AND (? = 0 OR (
      (purchase_id IS NULL OR EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p
        WHERE p.id = _ecommerce_gift_cards.purchase_id AND ${settledPurchase}))
      AND (replaces_purchase_id IS NULL OR EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p
        WHERE p.id = _ecommerce_gift_cards.replaces_purchase_id AND ${settledPurchase}))))
    RETURNING id`).bind(active ? "active" : "suspended", timestamp, id, active ? 1 : 0).all();
  if (!result.results?.length) throw new Error("Gift card purchase requires review");
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
  const card = await db.select().from(giftCards).where(eq2(giftCards.codeHash, await hashGiftCardSecret(normalized))).get();
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
  }).from(giftCards).where(eq2(giftCards.codeHash, await hashGiftCardSecret(normalized))).get();
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
  const pending = and2(eq2(giftCardPurchases.id, id), eq2(giftCardPurchases.status, "pending"));
  await db.insert(giftCardPurchases).values({
    id,
    buyerEmail: values.buyerEmail,
    amountCents: values.amountCents,
    currency,
    status: "pending",
    accessTokenHash: await hashGiftCardSecret(accessToken),
    createdAt: at2(timestamp),
    updatedAt: at2(timestamp)
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
    await db.update(giftCardPurchases).set({ providerSessionId: session.providerSessionId, updatedAt: at2(timestamp) }).where(pending);
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
  const purchase = await db.select().from(giftCardPurchases).where(eq2(giftCardPurchases.id, id)).get();
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
  await env.DB.batch([
    env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases
      SET status = 'paid',payment_intent_id = ?,updated_at = ?
      WHERE id = ? AND status = 'pending' AND provider_session_id = ?`).bind(session.payment_intent, timestamp, id, session.id),
    env.DB.prepare(`INSERT INTO _ecommerce_gift_cards
      (id,code_hash,code_suffix,encrypted_code,source,purchase_id,initial_cents,balance_cents,currency,status,created_at,updated_at)
      SELECT ?,?,?,?,'purchase',id,amount_cents,0,currency,'active',?,?
      FROM _ecommerce_gift_card_purchases WHERE id = ? AND status = 'paid'
      ON CONFLICT(purchase_id) DO NOTHING`).bind(cardId, secret.codeHash, secret.codeSuffix, secret.encryptedCode, timestamp, timestamp, id),
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_issue_' || id,id,purchase_id,'issue',initial_cents,?
      FROM _ecommerce_gift_cards WHERE purchase_id = ? ON CONFLICT(id) DO NOTHING`).bind(timestamp, id),
    // The buyer gets a claim link once, however often the payment is confirmed.
    commerceEmailStatement(env, "gift_card_claim", id, timestamp, {
      sql: `EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases WHERE id = ? AND status = 'paid' AND provider_session_id = ?)`,
      params: [id, session.id]
    })
  ]);
  await sendCommerceEmailNow(env, "gift_card_claim", id, composeGiftCardClaimEmail);
  return { success: true, purchaseId: id };
}
var GIFT_CARD_CLAIM_SECONDS = 7 * 24 * 60 * 60;
var GIFT_CARD_CLAIMS_PER_NETWORK_PER_HOUR = 20;
var CLAIM_TOKEN = /^[0-9a-f]{64}$/;
var claimUrl = (origin, token) => `${origin}/gift-cards/claim#token=${token}`;
function claimTarget(env, purchaseId) {
  return env.DB.prepare(`SELECT p.id,p.buyer_email,p.amount_cents,p.currency,c.id AS card_id,c.status AS card_status
    FROM _ecommerce_gift_card_purchases p LEFT JOIN _ecommerce_gift_cards c ON c.id = (${currentCard("p.id")})
    WHERE p.id = ?`).bind(purchaseId).first();
}
async function newClaimLink(env, target, now, { resend, condition } = {}) {
  const token = randomHex(32);
  const id = `gclaim_${crypto.randomUUID()}`;
  const expiresAt = now + GIFT_CARD_CLAIM_SECONDS;
  return { id, token, expiresAt, statement: env.DB.prepare(`INSERT INTO _ecommerce_gift_card_claims
      (id,token_hash,purchase_id,card_id,expires_at,created_at,created_by,reason)
      SELECT ?,?,?,?,?,?,?,? WHERE ${condition?.sql ?? "1"} RETURNING id`).bind(
    id,
    await hashGiftCardSecret(token),
    target.id,
    target.card_id,
    expiresAt,
    now,
    resend?.actor ?? null,
    resend?.reason ?? null,
    ...condition?.params ?? []
  ) };
}
var revokeClaimLinkStatement = (env, id) => env.DB.prepare(`UPDATE _ecommerce_gift_card_claims
  SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(Math.floor(Date.now() / 1e3), id);
var revokeClaimLink = (env, id) => revokeClaimLinkStatement(env, id).run();
function claimEmail(setup, target, link) {
  const email = {
    store: setup.store,
    purchase: { id: target.id, amountCents: target.amount_cents, currency: target.currency },
    claim: { url: claimUrl(setup.store.origin, link.token), expiresAt: new Date(link.expiresAt * 1e3) }
  };
  return applyEmailTemplate(setup, "giftCardClaim", email, giftCardClaimEmail(email));
}
var composeGiftCardClaimEmail = async (env, purchaseId, setup, now) => {
  const target = await claimTarget(env, purchaseId);
  if (!target) return { cancel: "not_found" };
  if (!target.card_id || target.card_status !== "active") return { cancel: "not_claimable" };
  const to = bareEmailAddress(target.buyer_email);
  if (!to) return { fail: "invalid_recipient" };
  const link = await newClaimLink(
    env,
    { ...target, card_id: target.card_id },
    now,
    { condition: commerceEmailHeld("gift_card_claim", purchaseId, now) }
  );
  if (!await link.statement.first()) return { cancel: "superseded" };
  return { to, message: await claimEmail(setup, target, link), onFailure: () => revokeClaimLink(env, link.id) };
};
async function claimGiftCardCode(env, token) {
  if (typeof token !== "string" || !CLAIM_TOKEN.test(token)) return null;
  const now = Math.floor(Date.now() / 1e3);
  const claim = await commerceDb(env).select({
    id: giftCardClaims.id,
    cardId: giftCardClaims.cardId,
    codeHash: giftCards.codeHash,
    encryptedCode: giftCards.encryptedCode,
    balanceCents: giftCards.balanceCents,
    currency: giftCards.currency
  }).from(giftCardClaims).innerJoin(giftCards, eq2(giftCards.id, giftCardClaims.cardId)).where(and2(
    eq2(giftCardClaims.tokenHash, await hashGiftCardSecret(token)),
    isNull2(giftCardClaims.usedAt),
    isNull2(giftCardClaims.revokedAt),
    gt(giftCardClaims.expiresAt, at2(now)),
    eq2(giftCards.status, "active")
  )).get();
  if (!claim) return null;
  const code = await decryptCardSecret(
    await giftCardKeyring(env),
    { id: claim.cardId, codeHash: claim.codeHash, encryptedCode: claim.encryptedCode }
  );
  const used = await env.DB.prepare(`UPDATE _ecommerce_gift_card_claims SET used_at = ?
    WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      AND EXISTS (SELECT 1 FROM _ecommerce_gift_cards WHERE id = ? AND status = 'active')
    RETURNING id`).bind(now, claim.id, now, claim.cardId).all();
  if (!used.results?.length) return null;
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
  const target = await claimTarget(env, values.purchaseId);
  if (!target) throw new Error("Gift card purchase not found");
  if (!target.card_id || target.card_status !== "active") {
    throw new Error("A claim link can be sent only while the card that holds the purchase's value is active");
  }
  const to = bareEmailAddress(target.buyer_email);
  if (!to) throw new Error("The purchase has no valid buyer address");
  const now = Math.floor(Date.now() / 1e3);
  const hold = await holdCommerceEmail(env, "gift_card_claim", values.purchaseId, now);
  if (hold === "busy") {
    throw new Error("The claim email is being sent right now; reload in a few minutes and resend it only if it was not sent");
  }
  const release = hold === null ? [] : [releaseCommerceEmailStatement(env, "gift_card_claim", values.purchaseId, hold)];
  const link = await newClaimLink(env, { ...target, card_id: target.card_id }, now, { resend: { actor, reason: values.reason } });
  try {
    await link.statement.first();
  } catch (cause) {
    if (release.length) await env.DB.batch(release);
    throw new Error("The purchase's card changed while the link was being made; reload and try again", { cause });
  }
  try {
    await sendCommerceMessage(env, setup, "gift_card_claim", to, await claimEmail(setup, target, link));
  } catch (error) {
    await env.DB.batch([revokeClaimLinkStatement(env, link.id), ...release]).catch(() => void 0);
    const code = emailErrorCode(error);
    console.warn("[commerce] Gift card claim link not sent", { purchase: values.purchaseId, code });
    throw new Error(`The claim email could not be sent (${code}); earlier links still work. Try again later`);
  }
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE _ecommerce_gift_card_claims SET revoked_at = ?
        WHERE purchase_id = ? AND used_at IS NULL AND revoked_at IS NULL
          AND rowid < (SELECT rowid FROM _ecommerce_gift_card_claims WHERE id = ?)`).bind(now, values.purchaseId, link.id),
      ...hold === null ? [] : [supersedeCommerceEmailStatement(env, "gift_card_claim", values.purchaseId, hold)]
    ]);
  } catch (cause) {
    throw new Error("The claim email was sent, but earlier links still work; resend it again to stop them", { cause });
  }
  return { purchaseId: values.purchaseId, claimId: link.id, expiresAt: new Date(link.expiresAt * 1e3).toISOString() };
}
async function expireGiftCardPurchase(env, id, sessionId) {
  await commerceDb(env).update(giftCardPurchases).set({ status: "cancelled", updatedAt: /* @__PURE__ */ new Date() }).where(and2(
    eq2(giftCardPurchases.id, id),
    eq2(giftCardPurchases.providerSessionId, sessionId),
    eq2(giftCardPurchases.status, "pending")
  ));
}
async function reconcileGiftCardPurchase(env, adapter, id) {
  const db = commerceDb(env);
  const purchase = await db.select().from(giftCardPurchases).where(eq2(giftCardPurchases.id, id)).get();
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
  const purchase = await db.select().from(giftCardPurchases).where(eq2(giftCardPurchases.id, id)).get();
  if (!purchase || purchase.accessTokenHash !== await hashGiftCardSecret(accessToken)) return null;
  const card = await db.select().from(giftCards).where(eq2(giftCards.purchaseId, id)).get();
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
function giftCardPurchaseHoldStatements(env, purchaseId, timestamp) {
  const unspentFullRefund = `EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p
    WHERE p.id = ? AND p.status = 'review' AND p.provider_refunded_cents >= p.amount_cents
      AND NOT ${pendingCheckout("p.id")}
      AND (SELECT COALESCE(SUM(l.amount_cents),0) FROM _ecommerce_gift_card_ledger l
        JOIN _ecommerce_gift_cards f ON f.id = l.card_id
        WHERE (f.purchase_id = p.id OR f.replaces_purchase_id = p.id)
          AND l.kind IN ('reserve','release','refund_restore')) = 0)`;
  return [
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_purchase_reversal_' || c.id,c.id,?,'purchase_reversal',-c.balance_cents,?
      FROM _ecommerce_gift_cards c WHERE (c.purchase_id = ? OR c.replaces_purchase_id = ?)
        AND c.status <> 'void' AND c.balance_cents > 0 AND ${unspentFullRefund}
      ON CONFLICT(id) DO NOTHING`).bind(purchaseId, timestamp, purchaseId, purchaseId, purchaseId),
    env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = 'void',held_for_review = 0,updated_at = ?
      WHERE (purchase_id = ? OR replaces_purchase_id = ?) AND status <> 'void' AND ${unspentFullRefund}`).bind(timestamp, purchaseId, purchaseId, purchaseId),
    env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases
      SET status = CASE WHEN provider_refunded_cents >= amount_cents THEN 'refunded' ELSE 'partially_refunded' END,
        refund_adjusted_cents = provider_refunded_cents,updated_at = ?
      WHERE id = ? AND status = 'review' AND NOT EXISTS (SELECT 1 FROM _ecommerce_gift_cards c
        WHERE (c.purchase_id = ? OR c.replaces_purchase_id = ?) AND c.status <> 'void')`).bind(timestamp, purchaseId, purchaseId, purchaseId),
    env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = 'suspended',held_for_review = 1,updated_at = ?
      WHERE (purchase_id = ? OR replaces_purchase_id = ?) AND status = 'active'
        AND EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p WHERE p.id = ? AND p.status = 'review')`).bind(timestamp, purchaseId, purchaseId, purchaseId)
  ];
}
function giftCardPurchaseReleaseStatements(env, purchaseId, timestamp) {
  return [
    env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = 'active',held_for_review = 0,updated_at = ?
      WHERE (purchase_id = ? OR replaces_purchase_id = ?) AND status = 'suspended' AND held_for_review = 1
        AND EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p WHERE p.id = ? AND ${settledPurchase})`).bind(timestamp, purchaseId, purchaseId, purchaseId)
  ];
}
function giftCardPurchaseChargebackStatements(env, purchaseId, timestamp) {
  const clear = `NOT EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p WHERE p.id = ? AND ${pendingCheckout("p.id")})`;
  return [
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_chargeback_' || c.id,c.id,?,'purchase_reversal',-c.balance_cents,?
      FROM _ecommerce_gift_cards c WHERE (c.purchase_id = ? OR c.replaces_purchase_id = ?)
        AND c.status <> 'void' AND c.balance_cents > 0 AND ${clear}
      ON CONFLICT(id) DO NOTHING`).bind(purchaseId, timestamp, purchaseId, purchaseId, purchaseId),
    env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = 'void',held_for_review = 0,updated_at = ?
      WHERE (purchase_id = ? OR replaces_purchase_id = ?) AND status <> 'void' AND ${clear}`).bind(timestamp, purchaseId, purchaseId, purchaseId),
    env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases
      SET status = 'refunded',refund_adjusted_cents = provider_refunded_cents,updated_at = ?
      WHERE id = ? AND status IN ('paid','partially_refunded','refunded','review')
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_gift_cards c
          WHERE (c.purchase_id = ? OR c.replaces_purchase_id = ?) AND c.status <> 'void')`).bind(timestamp, purchaseId, purchaseId, purchaseId)
  ];
}
async function recordGiftCardPurchaseRefund(env, params) {
  const db = commerceDb(env);
  const purchase = await db.select().from(giftCardPurchases).where(eq2(giftCardPurchases.paymentIntentId, params.paymentIntentId)).get();
  if (!purchase) return null;
  if (purchase.amountCents !== params.amount || params.currency.toLowerCase() !== purchase.currency.toLowerCase() || !Number.isSafeInteger(params.amountRefunded) || params.amountRefunded < 0 || params.amountRefunded > purchase.amountCents) {
    throw new WebhookMismatchError("refund_mismatch", "Gift card refund does not match purchase");
  }
  if (params.amountRefunded <= purchase.providerRefundedCents) return { success: true, duplicate: true };
  const timestamp = Math.floor(Date.now() / 1e3);
  await env.DB.batch([
    env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = 'review',provider_refunded_cents = ?,updated_at = ?
      WHERE id = ? AND provider_refunded_cents < ?`).bind(params.amountRefunded, timestamp, purchase.id, params.amountRefunded),
    ...giftCardPurchaseHoldStatements(env, purchase.id, timestamp)
  ]);
  const current = await db.select({ status: giftCardPurchases.status }).from(giftCardPurchases).where(eq2(giftCardPurchases.id, purchase.id)).get();
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
  const purchase = await env.DB.prepare(`${reviewSelect} WHERE p.id = ?`).bind(values.purchaseId).first();
  if (purchase?.status !== "review") throw new Error("Gift card purchase is not held for review");
  const disputed = await env.DB.prepare(`SELECT ${openDispute("?")} AS open`).bind(values.purchaseId).first();
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
  const held = `EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases
    WHERE id = ? AND status = 'review' AND provider_refunded_cents = ?)`;
  const recorded = `EXISTS (SELECT 1 FROM _ecommerce_gift_card_reviews WHERE id = ?)`;
  const guard = [values.purchaseId, values.refundedCents, reviewId];
  const funded = [values.purchaseId, values.purchaseId];
  const statements = values.outcome === "reinstate" ? [
    // Recorded only while the card that holds the purchase's value covers the refund not yet taken off.
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_reviews
      (id,purchase_id,card_id,outcome,refunded_cents,adjustment_cents,admin_actor,reason,created_at)
      SELECT ?,p.id,c.id,'reinstate',p.provider_refunded_cents,p.provider_refunded_cents - p.refund_adjusted_cents,?,?,?
      FROM _ecommerce_gift_card_purchases p JOIN _ecommerce_gift_cards c ON c.id = (${currentCard("p.id")})
      WHERE p.id = ? AND p.status = 'review' AND p.provider_refunded_cents = ?
        AND c.balance_cents >= p.provider_refunded_cents - p.refund_adjusted_cents AND NOT ${openDispute("p.id")}
      RETURNING adjustment_cents`).bind(reviewId, actor, values.reason, timestamp, values.purchaseId, values.refundedCents),
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_' || r.id,r.card_id,r.purchase_id,'purchase_reversal',-r.adjustment_cents,r.created_at
      FROM _ecommerce_gift_card_reviews r WHERE r.id = ? AND r.adjustment_cents > 0 AND ${held}`).bind(reviewId, values.purchaseId, values.refundedCents),
    env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = 'active',held_for_review = 0,updated_at = ?
      WHERE (purchase_id = ? OR replaces_purchase_id = ?) AND status = 'suspended' AND held_for_review = 1
        AND ${held} AND ${recorded}`).bind(timestamp, ...funded, ...guard)
  ] : [
    // Recorded only while no checkout in progress holds value on the purchase's cards, so nothing is
    // released onto them once they are void.
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_reviews
      (id,purchase_id,card_id,outcome,refunded_cents,adjustment_cents,admin_actor,reason,created_at)
      SELECT ?,p.id,COALESCE((${currentCard("p.id")}),
          (SELECT o.id FROM _ecommerce_gift_cards o WHERE o.purchase_id = p.id)),
        'void',p.provider_refunded_cents,${cardValue("p.id")},?,?,?
      FROM _ecommerce_gift_card_purchases p
      WHERE p.id = ? AND p.status = 'review' AND p.provider_refunded_cents = ? AND NOT ${pendingCheckout("p.id")}
        AND NOT ${openDispute("p.id")}
      RETURNING adjustment_cents`).bind(reviewId, actor, values.reason, timestamp, values.purchaseId, values.refundedCents),
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT ? || '_' || id,id,?,'purchase_reversal',-balance_cents,?
      FROM _ecommerce_gift_cards WHERE (purchase_id = ? OR replaces_purchase_id = ?) AND status <> 'void'
        AND balance_cents > 0 AND ${held} AND ${recorded}`).bind(`gcl_${reviewId}`, values.purchaseId, timestamp, ...funded, ...guard),
    env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = 'void',held_for_review = 0,updated_at = ?
      WHERE (purchase_id = ? OR replaces_purchase_id = ?) AND status <> 'void' AND ${held} AND ${recorded}`).bind(timestamp, ...funded, ...guard)
  ];
  statements.push(env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases
    SET status = CASE WHEN provider_refunded_cents >= amount_cents THEN 'refunded' ELSE 'partially_refunded' END,
      refund_adjusted_cents = provider_refunded_cents,updated_at = ?
    WHERE id = ? AND status = 'review' AND provider_refunded_cents = ? AND ${recorded}`).bind(timestamp, values.purchaseId, values.refundedCents, reviewId));
  const [review] = await env.DB.batch(statements);
  const adjustment = review.results?.[0];
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
  const current = await commerceDb(env).select({
    giftCardId: orders.giftCardId,
    giftCardApplied: orders.giftCardApplied,
    giftCardRefundedCents: orders.giftCardRefundedCents,
    status: orders.status,
    referralCode: orders.referralCode
  }).from(orders).where(eq2(orders.id, values.orderId)).get();
  if (!current?.giftCardId || !["paid", "fulfilled", "partially_refunded"].includes(current.status)) {
    throw new Error("Order is unavailable for a gift card refund");
  }
  const remaining = current.giftCardApplied - current.giftCardRefundedCents;
  if (!values.amountCents || values.amountCents > remaining) throw new Error("Refund exceeds gift card payment");
  const id = `gfr_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1e3);
  const statements = [env.DB.prepare(`INSERT INTO _ecommerce_gift_card_refunds
    (id,card_id,order_id,amount_cents,admin_actor,reason,created_at)
    VALUES (?,?,?,?,?,?,?)`).bind(id, current.giftCardId, values.orderId, values.amountCents, actor, values.reason, now)];
  if (current.referralCode) {
    const policy = await getReferralPolicy(env);
    statements.push(...referralReversalStatements(env, values.orderId, { minOrderCents: policy.minOrderCents, now }));
  }
  await env.DB.batch(statements);
  return { id, orderId: values.orderId, amountCents: values.amountCents };
}
async function refundGiftCardOnlyOrder(env, actor, input) {
  const values = refundSchema.parse(input);
  if (!actor.trim() || values.amountCents !== void 0) throw new Error("Invalid full refund request");
  const order = await commerceDb(env).select({
    id: orders.id,
    giftCardId: orders.giftCardId,
    giftCardApplied: orders.giftCardApplied,
    giftCardRefundedCents: orders.giftCardRefundedCents,
    creditApplied: orders.creditApplied,
    paymentProvider: orders.paymentProvider,
    totalAmount: orders.totalAmount,
    status: orders.status,
    userId: orders.userId
  }).from(orders).where(eq2(orders.id, values.orderId)).get();
  if (!order || order.paymentProvider !== "gift_card" || order.totalAmount !== 0 || !["paid", "partially_refunded", "fulfilled"].includes(order.status)) {
    throw new Error("Only paid gift-card-only orders can be refunded here");
  }
  const now = Math.floor(Date.now() / 1e3);
  const remaining = order.giftCardApplied - order.giftCardRefundedCents;
  const statements = [
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_order_refunds
      (order_id,admin_actor,reason,created_at) VALUES (?,?,?,?)`).bind(order.id, actor, values.reason, now)
  ];
  if (remaining > 0) statements.push(env.DB.prepare(`INSERT INTO _ecommerce_gift_card_refunds
    (id,card_id,order_id,amount_cents,admin_actor,reason,created_at)
    VALUES (?,?,?,?,?,?,?)`).bind(`gfr_full_${order.id}`, order.giftCardId, order.id, remaining, actor, values.reason, now));
  statements.push(env.DB.prepare(`UPDATE _ecommerce_orders SET status = 'refunded',updated_at = ?
    WHERE id = ? AND payment_provider = 'gift_card' AND total_amount = 0
      AND status IN ('paid','fulfilled','partially_refunded')`).bind(now, order.id));
  statements.push(env.DB.prepare(`UPDATE _ecommerce_gift_card_redemptions SET status = 'refunded',updated_at = ?
    WHERE order_id = ? AND status = 'confirmed'`).bind(now, order.id));
  statements.push(env.DB.prepare(`UPDATE _ecommerce_discount_redemptions SET status = 'refunded',updated_at = ?
    WHERE order_id = ? AND status = 'confirmed'`).bind(now, order.id));
  if (order.creditApplied > 0 && order.userId) statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
    (id,account_id,order_id,kind,amount_cents,created_at)
    VALUES (?, ?, ?, 'purchase_credit_refund', ?, ?) ON CONFLICT(order_id,kind) DO NOTHING`).bind(`credit_refund_${order.id}`, order.userId, order.id, order.creditApplied, now));
  statements.push(env.DB.prepare(`UPDATE _ecommerce_payments SET status = 'refunded' WHERE order_id = ?`).bind(order.id));
  await env.DB.batch(statements);
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
  backoffSql,
  RECONCILE_DUE,
  RECONCILE_ORDER,
  reconcileAttempt,
  COMMERCE_EMAIL_MAX_AGE_SECONDS,
  COMMERCE_EMAIL_LEASE_SECONDS,
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
