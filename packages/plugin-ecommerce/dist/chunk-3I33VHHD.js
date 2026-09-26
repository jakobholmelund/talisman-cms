import {
  SUPPORTED_CURRENCIES,
  isSupportedCurrency,
  minimumChargeAmount
} from "./chunk-2UYSCNNW.js";
import {
  getReferralPolicy,
  referralReversalStatements
} from "./chunk-6773WH54.js";
import {
  giftCardPurchases,
  giftCards
} from "./chunk-U2UUCKVF.js";

// src/gift-cards.ts
import { eq } from "drizzle-orm";
import { z as z2 } from "zod";
import { createDbClient } from "talisman-cms/client";
import { readSetting } from "talisman-cms/env";

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

// src/gift-cards.ts
var amountSchema = z2.number().int().min(500).max(1e5);
var purchaseSchema = z2.object({
  amountCents: amountSchema,
  buyerEmail: z2.string().trim().email().max(254)
}).strict();
var adminIssueSchema = z2.object({
  amountCents: amountSchema,
  reason: z2.string().trim().min(8).max(500)
}).strict();
var hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
var unhex = (value) => new Uint8Array(value.match(/.{2}/g)?.map((byte) => parseInt(byte, 16)) ?? []);
var randomHex = (bytes) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
var keyString = (env) => readSetting(env, "COMMERCE_GIFT_CARD_KEY");
async function encryptionKey(env) {
  const value = keyString(env);
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error("Gift card encryption key is not configured");
  }
  return crypto.subtle.importKey("raw", unhex(value), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function hashGiftCardSecret(value) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
async function newCardSecret(env) {
  const code = `GIFT-${randomHex(16).toUpperCase()}`;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    new TextEncoder().encode(code)
  );
  return {
    code,
    codeHash: await hashGiftCardSecret(code),
    codeSuffix: code.slice(-4),
    encryptedCode: `${hex(iv)}:${hex(new Uint8Array(ciphertext))}`
  };
}
async function decryptCardSecret(env, encrypted) {
  const [iv, ciphertext] = encrypted.split(":");
  if (!iv || !ciphertext) throw new Error("Gift card secret is invalid");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unhex(iv) },
    await encryptionKey(env),
    unhex(ciphertext)
  );
  return new TextDecoder().decode(plaintext);
}
function giftCardCurrency(env) {
  const { currency } = readStoreSettings(env);
  if (currency !== "usd") throw new GiftCardRefusal("currency", "Gift cards are available only in stores that use USD");
  return currency;
}
async function issueAdminGiftCard(env, actor, input) {
  const currency = giftCardCurrency(env);
  const { amountCents, reason } = adminIssueSchema.parse(input);
  if (!actor.trim()) throw new Error("Administrator identity is required");
  const secret = await newCardSecret(env);
  const id = `gift_${crypto.randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1e3);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO _ecommerce_gift_cards
      (id,code_hash,code_suffix,encrypted_code,source,admin_actor,admin_reason,initial_cents,balance_cents,currency,status,created_at,updated_at)
      VALUES (?,?,?,?, 'admin',?,?,?,0,?,'active',?,?)`).bind(
      id,
      secret.codeHash,
      secret.codeSuffix,
      secret.encryptedCode,
      actor,
      reason,
      amountCents,
      currency,
      timestamp,
      timestamp
    ),
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,kind,amount_cents,created_at) VALUES (?,?,'issue',?,?)`).bind(`gcl_issue_${id}`, id, amountCents, timestamp)
  ]);
  return { id, code: secret.code, amountCents, currency };
}
async function getGiftCardsAdmin(env) {
  const db = createDbClient(env);
  return db.select({
    id: giftCards.id,
    codeSuffix: giftCards.codeSuffix,
    source: giftCards.source,
    purchaseId: giftCards.purchaseId,
    adminActor: giftCards.adminActor,
    adminReason: giftCards.adminReason,
    initialCents: giftCards.initialCents,
    balanceCents: giftCards.balanceCents,
    currency: giftCards.currency,
    status: giftCards.status,
    createdAt: giftCards.createdAt
  }).from(giftCards).orderBy(giftCards.createdAt);
}
async function setGiftCardActive(env, id, active) {
  if (!/^gift_[0-9a-f-]{36}$/.test(id) || typeof active !== "boolean") throw new Error("Invalid gift card");
  const db = createDbClient(env);
  const card = await db.select().from(giftCards).where(eq(giftCards.id, id)).get();
  if (!card || card.status === "void") throw new Error("Gift card is unavailable");
  if (card.purchaseId) {
    const purchase = await db.select().from(giftCardPurchases).where(eq(giftCardPurchases.id, card.purchaseId)).get();
    if (purchase?.status !== "paid") throw new Error("Gift card purchase requires review");
  }
  const timestamp = Math.floor(Date.now() / 1e3);
  const result = await env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = ?,updated_at = ?
    WHERE id = ? AND status <> 'void' AND (source = 'admin' OR EXISTS (
      SELECT 1 FROM _ecommerce_gift_card_purchases p WHERE p.id = purchase_id AND p.status = 'paid'))
    RETURNING id`).bind(active ? "active" : "suspended", timestamp, id).all();
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
  const db = createDbClient(env);
  const card = await db.select().from(giftCards).where(eq(giftCards.codeHash, await hashGiftCardSecret(normalized))).get();
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
  const db = createDbClient(env);
  const card = await db.select({
    balanceCents: giftCards.balanceCents,
    currency: giftCards.currency,
    status: giftCards.status
  }).from(giftCards).where(eq(giftCards.codeHash, await hashGiftCardSecret(normalized))).get();
  if (!card) throw new Error("Gift card not found");
  return card;
}
async function startGiftCardPurchase(env, adapter, input, urls) {
  if (adapter.providerId !== "stripe") throw new Error("Gift card purchases require Stripe");
  const currency = giftCardCurrency(env);
  await encryptionKey(env);
  const values = purchaseSchema.parse(input);
  const id = `gp_${crypto.randomUUID()}`;
  const accessToken = randomHex(32);
  const timestamp = Math.floor(Date.now() / 1e3);
  await env.DB.prepare(`INSERT INTO _ecommerce_gift_card_purchases
    (id,buyer_email,amount_cents,currency,status,access_token_hash,created_at,updated_at)
    VALUES (?,?,?,?,'pending',?,?,?)`).bind(
    id,
    values.buyerEmail,
    values.amountCents,
    currency,
    await hashGiftCardSecret(accessToken),
    timestamp,
    timestamp
  ).run();
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
    await env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET provider_session_id = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`).bind(session.providerSessionId, timestamp, id).run();
    return { id, accessToken, paymentUrl: session.url };
  } catch (error) {
    if (providerSessionId) {
      try {
        await adapter.expireCheckoutSession?.(providerSessionId);
      } catch {
        await env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET provider_session_id = ?
          WHERE id = ? AND status = 'pending'`).bind(providerSessionId, id).run();
        throw error;
      }
    }
    await env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status = 'pending'`).bind(Math.floor(Date.now() / 1e3), id).run();
    throw error;
  }
}
async function confirmGiftCardPurchase(env, session) {
  const id = session.metadata?.giftCardPurchaseId;
  if (!id) throw new Error("Gift card purchase ID is missing");
  const db = createDbClient(env);
  const purchase = await db.select().from(giftCardPurchases).where(eq(giftCardPurchases.id, id)).get();
  if (!purchase || purchase.providerSessionId !== session.id || purchase.amountCents !== session.amount_total || session.currency?.toLowerCase() !== purchase.currency.toLowerCase() || session.payment_status !== "paid" || typeof session.payment_intent !== "string") {
    throw new Error("Gift card payment does not match purchase");
  }
  if (purchase.status === "paid") return { success: true, purchaseId: id, duplicate: true };
  if (purchase.status !== "pending") throw new Error("Gift card purchase is no longer pending");
  const secret = await newCardSecret(env);
  const cardId = `gift_${crypto.randomUUID()}`;
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
      FROM _ecommerce_gift_cards WHERE purchase_id = ? ON CONFLICT(id) DO NOTHING`).bind(timestamp, id)
  ]);
  return { success: true, purchaseId: id };
}
async function expireGiftCardPurchase(env, id, sessionId) {
  await env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = 'cancelled',updated_at = ?
    WHERE id = ? AND provider_session_id = ? AND status = 'pending'`).bind(Math.floor(Date.now() / 1e3), id, sessionId).run();
}
async function reconcileGiftCardPurchase(env, adapter, id) {
  if (adapter.providerId !== "stripe" || !adapter.getCheckoutSession) {
    throw new Error("Stripe session lookup is required for gift card reconciliation");
  }
  const db = createDbClient(env);
  const purchase = await db.select().from(giftCardPurchases).where(eq(giftCardPurchases.id, id)).get();
  if (!purchase || purchase.status !== "pending" || !purchase.providerSessionId) return null;
  const session = await adapter.getCheckoutSession(purchase.providerSessionId);
  if (session.status === "expired") {
    await expireGiftCardPurchase(env, id, purchase.providerSessionId);
    return { status: "cancelled" };
  }
  if (session.status === "complete" && session.paymentStatus === "paid") {
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
  const db = createDbClient(env);
  const purchase = await db.select().from(giftCardPurchases).where(eq(giftCardPurchases.id, id)).get();
  if (!purchase || purchase.accessTokenHash !== await hashGiftCardSecret(accessToken)) return null;
  const card = await db.select().from(giftCards).where(eq(giftCards.purchaseId, id)).get();
  return {
    status: purchase.status,
    amountCents: purchase.amountCents,
    code: card && purchase.status === "paid" ? await decryptCardSecret(env, card.encryptedCode) : null,
    balanceCents: card?.balanceCents ?? null
  };
}
async function recordGiftCardPurchaseRefund(env, params) {
  const db = createDbClient(env);
  const purchase = await db.select().from(giftCardPurchases).where(eq(giftCardPurchases.paymentIntentId, params.paymentIntentId)).get();
  if (!purchase) return null;
  if (purchase.amountCents !== params.amount || params.currency.toLowerCase() !== purchase.currency.toLowerCase() || !Number.isSafeInteger(params.amountRefunded) || params.amountRefunded < 0 || params.amountRefunded > purchase.amountCents) throw new Error("Gift card refund does not match purchase");
  if (params.amountRefunded <= purchase.providerRefundedCents) return { success: true, duplicate: true };
  const card = await db.select().from(giftCards).where(eq(giftCards.purchaseId, purchase.id)).get();
  const full = params.amountRefunded === purchase.amountCents;
  const unspent = card?.balanceCents === card?.initialCents;
  const status = full && unspent ? "refunded" : "review";
  const timestamp = Math.floor(Date.now() / 1e3);
  const statements = [
    env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = ?,provider_refunded_cents = ?,updated_at = ?
      WHERE id = ? AND provider_refunded_cents < ?`).bind(status, params.amountRefunded, timestamp, purchase.id, params.amountRefunded)
  ];
  if (card) {
    statements.push(env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = ?,updated_at = ? WHERE id = ?`).bind(full && unspent ? "void" : "suspended", timestamp, card.id));
    if (full && unspent) statements.push(env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      VALUES (?,?,?,'purchase_reversal',?,?) ON CONFLICT(id) DO NOTHING`).bind(`gcl_purchase_reversal_${card.id}`, card.id, purchase.id, -card.initialCents, timestamp));
  }
  await env.DB.batch(statements);
  return { success: true, purchaseId: purchase.id, status };
}
var refundSchema = z2.object({
  orderId: z2.string().regex(/^ord_[0-9a-f-]{36}$/),
  reason: z2.string().trim().min(8).max(500),
  amountCents: z2.number().int().positive().optional()
}).strict();
async function refundGiftCardTender(env, actor, input) {
  const values = refundSchema.parse(input);
  if (!actor.trim()) throw new Error("Administrator identity is required");
  const row = await env.DB.prepare(`SELECT id,gift_card_id,gift_card_applied,gift_card_refunded_cents,status,referral_code
    FROM _ecommerce_orders WHERE id = ?`).bind(values.orderId).all();
  const current = row.results?.[0];
  if (!current?.gift_card_id || !["paid", "fulfilled", "partially_refunded"].includes(current.status)) {
    throw new Error("Order is unavailable for a gift card refund");
  }
  const remaining = current.gift_card_applied - current.gift_card_refunded_cents;
  if (!values.amountCents || values.amountCents > remaining) throw new Error("Refund exceeds gift card payment");
  const id = `gfr_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1e3);
  const statements = [env.DB.prepare(`INSERT INTO _ecommerce_gift_card_refunds
    (id,card_id,order_id,amount_cents,admin_actor,reason,created_at)
    VALUES (?,?,?,?,?,?,?)`).bind(id, current.gift_card_id, values.orderId, values.amountCents, actor, values.reason, now)];
  if (current.referral_code) {
    const policy = await getReferralPolicy(env);
    statements.push(...referralReversalStatements(env, values.orderId, { minOrderCents: policy.minOrderCents, now }));
  }
  await env.DB.batch(statements);
  return { id, orderId: values.orderId, amountCents: values.amountCents };
}
async function refundGiftCardOnlyOrder(env, actor, input) {
  const values = refundSchema.parse(input);
  if (!actor.trim() || values.amountCents !== void 0) throw new Error("Invalid full refund request");
  const row = await env.DB.prepare(`SELECT id,gift_card_id,gift_card_applied,gift_card_refunded_cents,
    credit_applied,payment_provider,total_amount,status,user_id FROM _ecommerce_orders WHERE id = ?`).bind(values.orderId).all();
  const order = row.results?.[0];
  if (!order || order.payment_provider !== "gift_card" || order.total_amount !== 0 || !["paid", "partially_refunded", "fulfilled"].includes(order.status)) {
    throw new Error("Only paid gift-card-only orders can be refunded here");
  }
  const now = Math.floor(Date.now() / 1e3);
  const remaining = order.gift_card_applied - order.gift_card_refunded_cents;
  const statements = [
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_order_refunds
      (order_id,admin_actor,reason,created_at) VALUES (?,?,?,?)`).bind(order.id, actor, values.reason, now)
  ];
  if (remaining > 0) statements.push(env.DB.prepare(`INSERT INTO _ecommerce_gift_card_refunds
    (id,card_id,order_id,amount_cents,admin_actor,reason,created_at)
    VALUES (?,?,?,?,?,?,?)`).bind(`gfr_full_${order.id}`, order.gift_card_id, order.id, remaining, actor, values.reason, now));
  statements.push(env.DB.prepare(`UPDATE _ecommerce_orders SET status = 'refunded',updated_at = ?
    WHERE id = ? AND payment_provider = 'gift_card' AND total_amount = 0
      AND status IN ('paid','fulfilled','partially_refunded')`).bind(now, order.id));
  statements.push(env.DB.prepare(`UPDATE _ecommerce_gift_card_redemptions SET status = 'refunded',updated_at = ?
    WHERE order_id = ? AND status = 'confirmed'`).bind(now, order.id));
  statements.push(env.DB.prepare(`UPDATE _ecommerce_discount_redemptions SET status = 'refunded',updated_at = ?
    WHERE order_id = ? AND status = 'confirmed'`).bind(now, order.id));
  if (order.credit_applied > 0 && order.user_id) statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
    (id,account_id,order_id,kind,amount_cents,created_at)
    VALUES (?, ?, ?, 'purchase_credit_refund', ?, ?) ON CONFLICT(order_id,kind) DO NOTHING`).bind(`credit_refund_${order.id}`, order.user_id, order.id, order.credit_applied, now));
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
  hashGiftCardSecret,
  issueAdminGiftCard,
  getGiftCardsAdmin,
  setGiftCardActive,
  GiftCardRefusal,
  evaluateGiftCard,
  getGiftCardBalance,
  startGiftCardPurchase,
  confirmGiftCardPurchase,
  expireGiftCardPurchase,
  reconcileGiftCardPurchase,
  getPurchasedGiftCard,
  recordGiftCardPurchaseRefund,
  refundGiftCardTender,
  refundGiftCardOnlyOrder
};
