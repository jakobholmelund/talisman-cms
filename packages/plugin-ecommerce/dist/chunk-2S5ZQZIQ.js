import {
  customerAccounts,
  customerSessions,
  orders
} from "./chunk-6RT3KMIV.js";

// src/accounts.ts
import { and, eq, gt, isNull } from "drizzle-orm";
import { createDbClient } from "talisman-cms/client";
import { ensureVerifiedEmailIdentity } from "talisman-cms/auth/identity";
import { readSetting } from "talisman-cms/env";
var CUSTOMER_SESSION_COOKIE = "talisman-customer";
var CUSTOMER_SESSION_MAX_AGE = 60 * 60 * 24 * 30;
var CUSTOMER_EMAIL_DAILY_LIMIT = 200;
var CustomerEmailLimitError = class extends Error {
  name = "CustomerEmailLimitError";
  constructor() {
    super("Too many sign-in emails were requested today");
  }
};
async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const limit = await env.DB.prepare(`INSERT INTO galaxy_auth_rate_limit (id, key, count, last_request)
    VALUES (?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN last_request <= ? THEN 1 ELSE count + 1 END,
      last_request = CASE WHEN last_request <= ? THEN ? ELSE last_request END
    RETURNING count`).bind(`rate_${crypto.randomUUID()}`, key, now, now - windowSeconds, now - windowSeconds, now).first();
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
function customerEmailDailyLimit(env) {
  const configured = Number(readSetting(env, "COMMERCE_EMAIL_DAILY_LIMIT"));
  return Number.isSafeInteger(configured) && configured > 0 ? configured : CUSTOMER_EMAIL_DAILY_LIMIT;
}
async function activateNewCustomer(_env, _orderId, _basketToken) {
  return null;
}
async function requestCustomerEmailSignIn(env, email, linkForToken, sendLink, sourceIp) {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Valid email required");
  }
  const db = createDbClient(env);
  const now = Math.floor(Date.now() / 1e3);
  if (sourceIp && sourceIp.length <= 64) {
    const count = await countRequest(env, `shopper-email:${await hashToken(rateLimitSource(sourceIp))}`, now, 3600);
    if ((count ?? 21) > 20) return;
  }
  let account = await db.select().from(customerAccounts).where(eq(customerAccounts.emailNormalized, normalized)).get();
  if (!account) {
    await db.insert(customerAccounts).values({
      id: `acct_${crypto.randomUUID()}`,
      email: normalized,
      emailNormalized: normalized,
      createdAt: new Date(now * 1e3),
      updatedAt: new Date(now * 1e3)
    }).onConflictDoNothing({ target: customerAccounts.emailNormalized });
    account = await db.select().from(customerAccounts).where(eq(customerAccounts.emailNormalized, normalized)).get();
    if (!account) throw new Error("Shopper account could not be created");
  }
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_customer_sessions
    WHERE account_id = ? AND purpose = 'email_challenge' AND created_at > ?`).bind(account.id, now - 600).all();
  if ((recent.results?.[0]?.count ?? 0) >= 3) return;
  const dailyLimit = customerEmailDailyLimit(env);
  if ((await countRequest(env, "shopper-email:daily", now, 24 * 60 * 60) ?? dailyLimit + 1) > dailyLimit) {
    throw new CustomerEmailLimitError();
  }
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const challengeId = `csess_${crypto.randomUUID()}`;
  await db.insert(customerSessions).values({
    id: challengeId,
    accountId: account.id,
    tokenHash: await hashToken(token),
    purpose: "email_challenge",
    expiresAt: new Date((now + 15 * 60) * 1e3),
    createdAt: new Date(now * 1e3)
  });
  try {
    await sendLink(account.email, linkForToken(token));
  } catch (error) {
    await env.DB.prepare(`UPDATE _ecommerce_customer_sessions SET revoked_at = ? WHERE id = ?`).bind(Math.floor(Date.now() / 1e3), challengeId).run();
    throw error;
  }
}
async function consumeCustomerEmailSignIn(env, token) {
  if (!/^[0-9a-f-]{72}$/.test(token)) return null;
  const hash = await hashToken(token);
  const now = Math.floor(Date.now() / 1e3);
  const claimed = await env.DB.prepare(`UPDATE _ecommerce_customer_sessions SET revoked_at = ?
    WHERE token_hash = ? AND purpose = 'email_challenge' AND revoked_at IS NULL
      AND expires_at > ? RETURNING account_id`).bind(now, hash, now).all();
  const accountId = claimed.results?.[0]?.account_id;
  if (!accountId) return null;
  const db = createDbClient(env);
  const account = await db.select().from(customerAccounts).where(eq(customerAccounts.id, accountId)).get();
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
  CustomerEmailLimitError,
  findCustomerSession,
  activateNewCustomer,
  requestCustomerEmailSignIn,
  consumeCustomerEmailSignIn,
  revokeCustomerSession,
  listCustomerOrders
};
