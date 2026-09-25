import { and, eq, gt, isNull } from 'drizzle-orm';
import { createDbClient, type TalismanEnv } from 'talisman-cms/client';
import { ensureVerifiedEmailIdentity } from 'talisman-cms/auth/identity';
import { readSetting } from 'talisman-cms/env';
import { customerAccounts, customerSessions, orders } from './schema';

export const CUSTOMER_SESSION_COOKIE = 'talisman-customer';
export const CUSTOMER_SESSION_MAX_AGE = 60 * 60 * 24 * 30;
/** Store-wide sign-in emails per 24 hours unless `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT` sets another positive whole number. */
export const CUSTOMER_EMAIL_DAILY_LIMIT = 200;

/** The store-wide daily sign-in email limit is used up; the request sent nothing. */
export class CustomerEmailLimitError extends Error {
  override readonly name = 'CustomerEmailLimitError';

  constructor() {
    super('Too many sign-in emails were requested today');
  }
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function findCustomerSession(env: TalismanEnv, token?: string | null) {
  if (!token || token.length > 128) return null;
  const db = createDbClient(env);
  const session = await db.select().from(customerSessions)
    .where(and(eq(customerSessions.tokenHash, await hashToken(token)), gt(customerSessions.expiresAt, new Date()),
      isNull(customerSessions.revokedAt), eq(customerSessions.purpose, 'session'))).get();
  if (!session) return null;
  return await db.select().from(customerAccounts).where(eq(customerAccounts.id, session.accountId)).get() ?? null;
}

/** Counts one request for `key` in a fixed window that starts with the first request, and returns the new count. */
async function countRequest(env: TalismanEnv, key: string, now: number, windowSeconds: number) {
  const limit = await env.DB.prepare(`INSERT INTO galaxy_auth_rate_limit (id, key, count, last_request)
    VALUES (?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN last_request <= ? THEN 1 ELSE count + 1 END,
      last_request = CASE WHEN last_request <= ? THEN ? ELSE last_request END
    RETURNING count`)
    .bind(`rate_${crypto.randomUUID()}`, key, now, now - windowSeconds, now - windowSeconds, now)
    .first<{ count: number }>();
  return limit?.count;
}

/** An IPv6 client can usually use any address in its /64, so IPv6 addresses are limited per /64 prefix. */
function rateLimitSource(ip: string) {
  const value = ip.trim().toLowerCase();
  if (!value.includes(':')) return value;
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  const halves = value.split('::');
  if (halves.length > 2) return value;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  // An embedded IPv4 address fills the last two groups.
  const width = [...left, ...right].reduce((count, group) => count + (group.includes('.') ? 2 : 1), 0);
  if (halves.length === 1 ? width !== 8 : width > 7) return value;
  const groups = [...left, ...Array<string>(8 - width).fill('0'), ...right].slice(0, 4);
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return value;
  return `${groups.map((group) => parseInt(group, 16).toString(16)).join(':')}::/64`;
}

function customerEmailDailyLimit(env: TalismanEnv) {
  const configured = Number(readSetting(env, 'COMMERCE_EMAIL_DAILY_LIMIT'));
  return Number.isSafeInteger(configured) && configured > 0 ? configured : CUSTOMER_EMAIL_DAILY_LIMIT;
}

/** Basket possession never proves ownership of the checkout email. */
export async function activateNewCustomer(_env: TalismanEnv, _orderId: string, _basketToken: string) {
  return null;
}

/**
 * The caller must deliver the link to the account's email address. A rate-limited request returns
 * without sending, so callers can answer it like any other. Throws `CustomerEmailLimitError` once
 * the store has sent its daily number of sign-in emails.
 */
export async function requestCustomerEmailSignIn(env: TalismanEnv, email: string,
  linkForToken: (token: string) => string,
  sendLink: (to: string, link: string) => Promise<void>, sourceIp?: string | null) {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Valid email required');
  }
  const db = createDbClient(env);
  const now = Math.floor(Date.now() / 1000);
  if (sourceIp && sourceIp.length <= 64) {
    const count = await countRequest(env, `shopper-email:${await hashToken(rateLimitSource(sourceIp))}`, now, 3600);
    if ((count ?? 21) > 20) return;
  }
  let account = await db.select().from(customerAccounts)
    .where(eq(customerAccounts.emailNormalized, normalized)).get();
  if (!account) {
    await db.insert(customerAccounts).values({ id: `acct_${crypto.randomUUID()}`, email: normalized,
      emailNormalized: normalized, createdAt: new Date(now * 1000), updatedAt: new Date(now * 1000) })
      .onConflictDoNothing({ target: customerAccounts.emailNormalized });
    account = await db.select().from(customerAccounts)
      .where(eq(customerAccounts.emailNormalized, normalized)).get();
    if (!account) throw new Error('Shopper account could not be created');
  }
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_customer_sessions
    WHERE account_id = ? AND purpose = 'email_challenge' AND created_at > ?`)
    .bind(account.id, now - 600).all<{ count: number }>();
  if ((recent.results?.[0]?.count ?? 0) >= 3) return;
  // Caps what a flood of requests from many addresses can send before the provider's own quota runs out.
  const dailyLimit = customerEmailDailyLimit(env);
  if ((await countRequest(env, 'shopper-email:daily', now, 24 * 60 * 60) ?? dailyLimit + 1) > dailyLimit) {
    throw new CustomerEmailLimitError();
  }
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const challengeId = `csess_${crypto.randomUUID()}`;
  await db.insert(customerSessions).values({
    id: challengeId, accountId: account.id, tokenHash: await hashToken(token),
    purpose: 'email_challenge', expiresAt: new Date((now + 15 * 60) * 1000),
    createdAt: new Date(now * 1000)
  });
  try {
    await sendLink(account.email, linkForToken(token));
  } catch (error) {
    await env.DB.prepare(`UPDATE _ecommerce_customer_sessions SET revoked_at = ? WHERE id = ?`)
      .bind(Math.floor(Date.now() / 1000), challengeId).run();
    throw error;
  }
}

export async function consumeCustomerEmailSignIn(env: TalismanEnv, token: string) {
  if (!/^[0-9a-f-]{72}$/.test(token)) return null;
  const hash = await hashToken(token);
  const now = Math.floor(Date.now() / 1000);
  const claimed = await env.DB.prepare(`UPDATE _ecommerce_customer_sessions SET revoked_at = ?
    WHERE token_hash = ? AND purpose = 'email_challenge' AND revoked_at IS NULL
      AND expires_at > ? RETURNING account_id`)
    .bind(now, hash, now).all<{ account_id: string }>();
  const accountId = claimed.results?.[0]?.account_id;
  if (!accountId) return null;
  const db = createDbClient(env);
  const account = await db.select().from(customerAccounts)
    .where(eq(customerAccounts.id, accountId)).get();
  if (!account) return null;
  const cmsUserId = await ensureVerifiedEmailIdentity(env, account.emailNormalized, account.name);
  const sessionToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(`UPDATE _ecommerce_customer_accounts
      SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ?, cms_user_id = ?
      WHERE id = ?`)
      .bind(now, now, cmsUserId, account.id),
    env.DB.prepare(`INSERT INTO _ecommerce_customer_sessions
      (id, account_id, token_hash, expires_at, created_at, purpose)
      VALUES (?, ?, ?, ?, ?, 'session')`)
      .bind(`csess_${crypto.randomUUID()}`, account.id, await hashToken(sessionToken),
        now + CUSTOMER_SESSION_MAX_AGE, now)
  ]);
  return { account, token: sessionToken };
}

export async function revokeCustomerSession(env: TalismanEnv, token?: string | null) {
  if (!token || token.length > 128) return;
  const db = createDbClient(env);
  await db.update(customerSessions).set({ revokedAt: new Date() })
    .where(eq(customerSessions.tokenHash, await hashToken(token)));
}

export async function listCustomerOrders(env: TalismanEnv, accountId: string) {
  const db = createDbClient(env);
  return db.select({
    id: orders.id,
    status: orders.status,
    totalAmount: orders.totalAmount,
    subtotalAmount: orders.subtotalAmount,
    creditApplied: orders.creditApplied,
    currency: orders.currency,
    createdAt: orders.createdAt,
  }).from(orders).where(eq(orders.userId, accountId));
}
