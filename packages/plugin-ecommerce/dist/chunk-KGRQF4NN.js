import {
  commerceDb,
  commitBatch
} from "./chunk-FDE2IMK7.js";
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
  referralCodes,
  referrals,
  shopperAudits,
  signInTokens
} from "./chunk-RVXM5XJ4.js";

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
    AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders o WHERE o.user_id = ${account.id}
      AND (o.status IN ('pending','disputed') OR (o.status IN ('paid','partially_refunded') AND o.fulfillment_status <> 'fulfilled'
        AND (o.shipping_address IS NOT NULL OR EXISTS (SELECT 1 FROM json_each(o.items) i JOIN _ecommerce_products p ON p.id = json_extract(i.value, '$.productId') WHERE p.is_physical = 1)))))
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
    throw new ShopperPrivacyError("Resolve open payments, deliveries, gift cards and credit awards before anonymizing this shopper");
  return { accountId: account.id, action: values.action, accountingRetained: true };
}

// src/accounts.ts
import { and as and3, count, eq as eq3, gt as gt2, inArray as inArray2, isNotNull, isNull as isNull2, or as or2, sql as sql3 } from "drizzle-orm";
import { ensureVerifiedEmailIdentity } from "talisman-cms/auth/identity";
import { parseAddress } from "talisman-cms/email";
import { readSetting as readSetting2 } from "talisman-cms/env";

// src/rate-limits.ts
import { and as and2, eq as eq2, gt, lte, sql as sql2 } from "drizzle-orm";
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
  const width = [...left, ...right].reduce((count2, group) => count2 + (group.includes(".") ? 2 : 1), 0);
  if (halves.length === 1 ? width !== 8 : width > 7) return value;
  const groups = [...left, ...Array(8 - width).fill("0"), ...right].slice(0, 4);
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return value;
  return `${groups.map((group) => parseInt(group, 16).toString(16)).join(":")}::/64`;
}
async function countRequest(env, key, now, windowSeconds) {
  if (!(windowSeconds > 0 && windowSeconds <= MAX_RATE_LIMIT_WINDOW_SECONDS)) {
    throw new RangeError("Rate-limit windows must be between 1 second and 24 hours");
  }
  const ended = sql2`${rateLimits.windowStart} <= ${now - windowSeconds}`;
  const [limit] = await commerceDb(env).insert(rateLimits).values({ key, count: 1, windowStart: now }).onConflictDoUpdate({ target: rateLimits.key, set: {
    count: sql2`CASE WHEN ${ended} THEN 1 ELSE ${rateLimits.count} + 1 END`,
    windowStart: sql2`CASE WHEN ${ended} THEN ${now} ELSE ${rateLimits.windowStart} END`
  } }).returning({ count: rateLimits.count });
  return limit?.count;
}
async function peekRequestCount(env, key, now, windowSeconds) {
  const row = await commerceDb(env).select({ count: rateLimits.count }).from(rateLimits).where(and2(eq2(rateLimits.key, key), gt(rateLimits.windowStart, now - windowSeconds))).get();
  return row?.count ?? 0;
}
async function clientOverLimit(env, bucket, sourceIp, { limit, windowSeconds, now = Math.floor(Date.now() / 1e3) }) {
  if (!sourceIp || sourceIp.length > 64) return false;
  const count2 = await countRequest(env, `${bucket}:${await sha256Hex(rateLimitSource(sourceIp))}`, now, windowSeconds);
  return (count2 ?? limit + 1) > limit;
}
async function claimInterval(env, key, intervalSeconds, now = Math.floor(Date.now() / 1e3)) {
  if (!(intervalSeconds > 0 && intervalSeconds <= MAX_RATE_LIMIT_WINDOW_SECONDS)) {
    throw new RangeError("Rate-limit windows must be between 1 second and 24 hours");
  }
  const [claimed] = await commerceDb(env).insert(rateLimits).values({ key, count: 1, windowStart: now }).onConflictDoUpdate({
    target: rateLimits.key,
    set: { count: 1, windowStart: sql2`excluded.window_start` },
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
  const session = await db.select().from(customerSessions).where(and3(
    eq3(customerSessions.tokenHash, await hashToken(token)),
    gt2(customerSessions.expiresAt, /* @__PURE__ */ new Date()),
    isNull2(customerSessions.revokedAt),
    eq3(customerSessions.purpose, "session")
  )).get();
  if (!session) return null;
  return await db.select().from(customerAccounts).where(and3(eq3(customerAccounts.id, session.accountId), eq3(customerAccounts.sessionVersion, session.sessionVersion), isNull2(customerAccounts.anonymizedAt))).get() ?? null;
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
  const verified = await commerceDb(env).select({ id: customerAccounts.id }).from(customerAccounts).where(and3(eq3(customerAccounts.emailNormalized, email), isNotNull(customerAccounts.emailVerifiedAt))).get();
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
      inArray2(sql3`lower(${orders.customerEmail})`, emails),
      inArray2(orders.userId, db.select({ id: customerAccounts.id }).from(customerAccounts).where(inArray2(customerAccounts.emailNormalized, emails)))
    ] : [],
    ...accountIds.length ? [inArray2(orders.userId, accountIds)] : []
  ];
  if (!matches.length) return false;
  const prior = await db.select({ id: orders.id }).from(orders).where(and3(
    inArray2(orders.status, [...PURCHASED_ORDER_STATUSES]),
    sql3`COALESCE(${orders.paymentProvider}, 'stripe') <> 'admin_test'`,
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
  const recent = await commerceDb(env).select({ count: count() }).from(signInTokens).where(and3(eq3(signInTokens.emailNormalized, normalized), gt2(signInTokens.createdAt, at(now - ADDRESS_WINDOW_SECONDS)))).get();
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
    await db.update(signInTokens).set({ revokedAt: /* @__PURE__ */ new Date() }).where(eq3(signInTokens.tokenHash, tokenHash));
    throw error;
  }
}
async function previewCustomerEmailSignIn(env, token, sourceIp) {
  const now = Math.floor(Date.now() / 1e3);
  if (await clientOverLimit(env, "shopper-preview", sourceIp, { limit: REQUESTS_PER_SOURCE_PER_HOUR, windowSeconds: 3600, now })) {
    throw new CustomerRequestLimitError();
  }
  if (!isSignInToken(token)) return null;
  const link = await commerceDb(env).select({ emailNormalized: signInTokens.emailNormalized }).from(signInTokens).where(and3(
    eq3(signInTokens.tokenHash, await hashToken(token)),
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
  const [claimed] = await db.update(signInTokens).set({ revokedAt: at(now) }).where(and3(
    eq3(signInTokens.tokenHash, await hashToken(token)),
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
  const account = await db.select().from(customerAccounts).where(eq3(customerAccounts.emailNormalized, email)).get();
  if (!account) return null;
  const cmsUserId = await ensureVerifiedEmailIdentity(env, account.emailNormalized, account.name);
  const sessionToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  await db.batch([
    db.update(customerAccounts).set({ emailVerifiedAt: sql3`COALESCE(${customerAccounts.emailVerifiedAt}, ${now})`, updatedAt: at(now), cmsUserId }).where(eq3(customerAccounts.id, account.id)),
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
  await db.update(customerSessions).set({ revokedAt: /* @__PURE__ */ new Date() }).where(eq3(customerSessions.tokenHash, await hashToken(token)));
}
async function listCustomerOrders(env, accountId) {
  const db = commerceDb(env);
  return db.select({
    id: orders.id,
    status: orders.status,
    fulfillmentStatus: orders.fulfillmentStatus,
    paymentUnderReview: sql3`(${orders.status} = 'pending' AND ${orders.reconcileReviewAt} IS NOT NULL)`.mapWith(Boolean),
    totalAmount: orders.totalAmount,
    subtotalAmount: orders.subtotalAmount,
    shippingAmount: orders.shippingAmount,
    shippingLabel: orders.shippingLabel,
    taxAmount: orders.taxAmount,
    taxBehavior: orders.taxBehavior,
    creditApplied: orders.creditApplied,
    currency: orders.currency,
    createdAt: orders.createdAt
  }).from(orders).where(eq3(orders.userId, accountId));
}

export {
  ShopperPrivacyError,
  manageShopperData,
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
