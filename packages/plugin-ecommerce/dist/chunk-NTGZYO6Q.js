import {
  customerAccounts,
  customerSessions,
  orders
} from "./chunk-CLEUXV3O.js";

// src/accounts.ts
import { and, eq, gt, isNull } from "drizzle-orm";
import { createDbClient } from "talisman-cms/client";
import { ensureVerifiedEmailIdentity } from "talisman-cms/auth/identity";
import { parseAddress } from "talisman-cms/email";
import { readSetting } from "talisman-cms/env";
var CUSTOMER_SESSION_COOKIE = "talisman-customer";
var CUSTOMER_SESSION_MAX_AGE = 60 * 60 * 24 * 30;
var CUSTOMER_EMAIL_DAILY_LIMIT = 200;
var SIGN_IN_LINK_SECONDS = 15 * 60;
var REQUESTS_PER_SOURCE_PER_HOUR = 20;
var PURCHASED_ORDER_STATUSES = ["paid", "fulfilled", "partially_refunded", "refunded"];
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
async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
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
async function countRequest(env, key, now, windowSeconds) {
  const limit = await env.DB.prepare(`INSERT INTO _ecommerce_rate_limits (key, count, window_start)
    VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
    RETURNING count`).bind(key, now, now - windowSeconds, now - windowSeconds, now).first();
  return limit?.count;
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
async function sourceOverLimit(env, bucket, sourceIp, now) {
  if (!sourceIp || sourceIp.length > 64) return false;
  const count = await countRequest(env, `${bucket}:${await hashToken(rateLimitSource(sourceIp))}`, now, 3600);
  return (count ?? REQUESTS_PER_SOURCE_PER_HOUR + 1) > REQUESTS_PER_SOURCE_PER_HOUR;
}
function customerEmailDailyLimit(env) {
  const configured = Number(readSetting(env, "COMMERCE_EMAIL_DAILY_LIMIT"));
  return Number.isSafeInteger(configured) && configured > 0 ? configured : CUSTOMER_EMAIL_DAILY_LIMIT;
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
async function requestCustomerEmailSignIn(env, email, linkForToken, sendLink, sourceIp) {
  const normalized = normalizeShopperEmail(email);
  if (!normalized) throw new Error("Valid email required");
  const now = Math.floor(Date.now() / 1e3);
  if (await sourceOverLimit(env, "shopper-email", sourceIp, now)) return;
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_sign_in_tokens
    WHERE email_normalized = ? AND created_at > ?`).bind(normalized, now - 600).first();
  if ((recent?.count ?? 0) >= 3) return;
  const dailyLimit = customerEmailDailyLimit(env);
  if ((await countRequest(env, "shopper-email:daily", now, 24 * 60 * 60) ?? dailyLimit + 1) > dailyLimit) {
    throw new CustomerEmailLimitError();
  }
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const tokenHash = await hashToken(token);
  await env.DB.prepare(`INSERT INTO _ecommerce_sign_in_tokens (token_hash, email_normalized, expires_at, created_at)
    VALUES (?, ?, ?, ?)`).bind(tokenHash, normalized, now + SIGN_IN_LINK_SECONDS, now).run();
  try {
    await sendLink(normalized, linkForToken(token));
  } catch (error) {
    await env.DB.prepare(`UPDATE _ecommerce_sign_in_tokens SET revoked_at = ? WHERE token_hash = ?`).bind(Math.floor(Date.now() / 1e3), tokenHash).run();
    throw error;
  }
}
async function previewCustomerEmailSignIn(env, token, sourceIp) {
  const now = Math.floor(Date.now() / 1e3);
  if (await sourceOverLimit(env, "shopper-preview", sourceIp, now)) throw new CustomerRequestLimitError();
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
    totalAmount: orders.totalAmount,
    subtotalAmount: orders.subtotalAmount,
    creditApplied: orders.creditApplied,
    currency: orders.currency,
    createdAt: orders.createdAt
  }).from(orders).where(eq(orders.userId, accountId));
}

export {
  CUSTOMER_SESSION_COOKIE,
  CUSTOMER_SESSION_MAX_AGE,
  CUSTOMER_EMAIL_DAILY_LIMIT,
  PURCHASED_ORDER_STATUSES,
  CustomerEmailLimitError,
  CustomerRequestLimitError,
  findCustomerSession,
  activateNewCustomer,
  hasPurchaseHistory,
  requestCustomerEmailSignIn,
  previewCustomerEmailSignIn,
  consumeCustomerEmailSignIn,
  revokeCustomerSession,
  listCustomerOrders
};
