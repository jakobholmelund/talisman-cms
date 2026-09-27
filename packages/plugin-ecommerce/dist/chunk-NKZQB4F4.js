import {
  customerAccounts,
  customerSessions,
  orders
} from "./chunk-SFZBZWCM.js";

// src/accounts.ts
import { and, eq, gt, isNull } from "drizzle-orm";
import { createDbClient } from "talisman-cms/client";
import { ensureVerifiedEmailIdentity } from "talisman-cms/auth/identity";
import { parseAddress } from "talisman-cms/email";
import { readSetting as readSetting2 } from "talisman-cms/env";

// src/rate-limits.ts
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
  const width = [...left, ...right].reduce((count, group) => count + (group.includes(".") ? 2 : 1), 0);
  if (halves.length === 1 ? width !== 8 : width > 7) return value;
  const groups = [...left, ...Array(8 - width).fill("0"), ...right].slice(0, 4);
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return value;
  return `${groups.map((group) => parseInt(group, 16).toString(16)).join(":")}::/64`;
}
async function countRequest(env, key, now, windowSeconds) {
  if (!(windowSeconds > 0 && windowSeconds <= MAX_RATE_LIMIT_WINDOW_SECONDS)) {
    throw new RangeError("Rate-limit windows must be between 1 second and 24 hours");
  }
  const limit = await env.DB.prepare(`INSERT INTO _ecommerce_rate_limits (key, count, window_start)
    VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
    RETURNING count`).bind(key, now, now - windowSeconds, now - windowSeconds, now).first();
  return limit?.count;
}
async function peekRequestCount(env, key, now, windowSeconds) {
  const row = await env.DB.prepare(`SELECT count FROM _ecommerce_rate_limits WHERE key = ? AND window_start > ?`).bind(key, now - windowSeconds).first();
  return row?.count ?? 0;
}
async function clientOverLimit(env, bucket, sourceIp, { limit, windowSeconds, now = Math.floor(Date.now() / 1e3) }) {
  if (!sourceIp || sourceIp.length > 64) return false;
  const count = await countRequest(env, `${bucket}:${await sha256Hex(rateLimitSource(sourceIp))}`, now, windowSeconds);
  return (count ?? limit + 1) > limit;
}
async function claimInterval(env, key, intervalSeconds, now = Math.floor(Date.now() / 1e3)) {
  if (!(intervalSeconds > 0 && intervalSeconds <= MAX_RATE_LIMIT_WINDOW_SECONDS)) {
    throw new RangeError("Rate-limit windows must be between 1 second and 24 hours");
  }
  const claimed = await env.DB.prepare(`INSERT INTO _ecommerce_rate_limits (key, count, window_start)
    VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start
      WHERE _ecommerce_rate_limits.window_start <= ?
    RETURNING window_start`).bind(key, now, now - intervalSeconds).first();
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
function normalizeShopperEmail(email) {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254) return null;
  return parseAddress({ email: normalized })?.email === normalized ? normalized : null;
}
var isSignInToken = (token) => typeof token === "string" && /^[0-9a-f-]{72}$/.test(token);
function maskEmailAddress(email) {
  const at = email.lastIndexOf("@");
  const [first = ""] = Array.from(email.slice(0, Math.max(0, at)));
  return `${first}\u2022\u2022\u2022${email.slice(at)}`;
}
async function findCustomerSession(env, token) {
  if (!token || token.length > 128) return null;
  const db = createDbClient(env);
  const session = await db.select().from(customerSessions).where(and(
    eq(customerSessions.tokenHash, await hashToken(token)),
    gt(customerSessions.expiresAt, /* @__PURE__ */ new Date()),
    isNull(customerSessions.revokedAt),
    eq(customerSessions.purpose, "session")
  )).get();
  if (!session) return null;
  return await db.select().from(customerAccounts).where(eq(customerAccounts.id, session.accountId)).get() ?? null;
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
  const verified = await env.DB.prepare(`SELECT 1 AS found FROM _ecommerce_customer_accounts
    WHERE email_normalized = ? AND email_verified_at IS NOT NULL LIMIT 1`).bind(email).first();
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
  const matches = [];
  if (emails.length) {
    const list = emails.map(() => "?").join(", ");
    matches.push(
      `lower(customer_email) IN (${list})`,
      `user_id IN (SELECT id FROM _ecommerce_customer_accounts WHERE email_normalized IN (${list}))`
    );
  }
  if (accountIds.length) matches.push(`user_id IN (${accountIds.map(() => "?").join(", ")})`);
  if (!matches.length) return false;
  const statuses = PURCHASED_ORDER_STATUSES.map((status) => `'${status}'`).join(", ");
  const prior = await env.DB.prepare(`SELECT 1 AS found FROM _ecommerce_orders
    WHERE status IN (${statuses}) AND COALESCE(payment_provider, 'stripe') <> 'admin_test'
      AND (${matches.join(" OR ")}) LIMIT 1`).bind(...emails, ...emails, ...accountIds).first();
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
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_sign_in_tokens
    WHERE email_normalized = ? AND created_at > ?`).bind(normalized, now - ADDRESS_WINDOW_SECONDS).first();
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
  await env.DB.prepare(`INSERT INTO _ecommerce_sign_in_tokens (token_hash, email_normalized, expires_at, created_at)
    VALUES (?, ?, ?, ?)`).bind(tokenHash, email, now + SIGN_IN_LINK_SECONDS, now).run();
  try {
    await sendLink(email, linkForToken(token));
  } catch (error) {
    await env.DB.prepare(`UPDATE _ecommerce_sign_in_tokens SET revoked_at = ? WHERE token_hash = ?`).bind(Math.floor(Date.now() / 1e3), tokenHash).run();
    throw error;
  }
}
async function previewCustomerEmailSignIn(env, token, sourceIp) {
  const now = Math.floor(Date.now() / 1e3);
  if (await clientOverLimit(env, "shopper-preview", sourceIp, { limit: REQUESTS_PER_SOURCE_PER_HOUR, windowSeconds: 3600, now })) {
    throw new CustomerRequestLimitError();
  }
  if (!isSignInToken(token)) return null;
  const link = await env.DB.prepare(`SELECT email_normalized FROM _ecommerce_sign_in_tokens
    WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`).bind(await hashToken(token), now).first();
  const email = normalizeShopperEmail(link?.email_normalized);
  return email ? maskEmailAddress(email) : null;
}
async function consumeCustomerEmailSignIn(env, token) {
  if (!isSignInToken(token)) return null;
  const now = Math.floor(Date.now() / 1e3);
  const claimed = await env.DB.prepare(`UPDATE _ecommerce_sign_in_tokens SET revoked_at = ?
    WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? RETURNING email_normalized`).bind(now, await hashToken(token), now).all();
  const email = normalizeShopperEmail(claimed.results?.[0]?.email_normalized);
  if (!email) return null;
  await env.DB.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(email_normalized) DO NOTHING`).bind(`acct_${crypto.randomUUID()}`, email, email, now, now, now).run();
  const db = createDbClient(env);
  const account = await db.select().from(customerAccounts).where(eq(customerAccounts.emailNormalized, email)).get();
  if (!account) return null;
  const cmsUserId = await ensureVerifiedEmailIdentity(env, account.emailNormalized, account.name);
  const sessionToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(`UPDATE _ecommerce_customer_accounts
      SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ?, cms_user_id = ?
      WHERE id = ?`).bind(now, now, cmsUserId, account.id),
    env.DB.prepare(`INSERT INTO _ecommerce_customer_sessions
      (id, account_id, token_hash, expires_at, created_at, purpose)
      VALUES (?, ?, ?, ?, ?, 'session')`).bind(
      `csess_${crypto.randomUUID()}`,
      account.id,
      await hashToken(sessionToken),
      now + CUSTOMER_SESSION_MAX_AGE,
      now
    )
  ]);
  return { account, token: sessionToken };
}
async function revokeCustomerSession(env, token) {
  if (!token || token.length > 128) return;
  const db = createDbClient(env);
  await db.update(customerSessions).set({ revokedAt: /* @__PURE__ */ new Date() }).where(eq(customerSessions.tokenHash, await hashToken(token)));
}
async function listCustomerOrders(env, accountId) {
  const db = createDbClient(env);
  return db.select({
    id: orders.id,
    status: orders.status,
    fulfillmentStatus: orders.fulfillmentStatus,
    totalAmount: orders.totalAmount,
    subtotalAmount: orders.subtotalAmount,
    shippingAmount: orders.shippingAmount,
    shippingLabel: orders.shippingLabel,
    taxAmount: orders.taxAmount,
    taxBehavior: orders.taxBehavior,
    creditApplied: orders.creditApplied,
    currency: orders.currency,
    createdAt: orders.createdAt
  }).from(orders).where(eq(orders.userId, accountId));
}

export {
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
