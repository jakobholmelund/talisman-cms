import { and, eq, gt, isNull } from 'drizzle-orm';
import { createDbClient, type TalismanEnv } from 'talisman-cms/client';
import { ensureVerifiedEmailIdentity } from 'talisman-cms/auth/identity';
import { parseAddress } from 'talisman-cms/email';
import { readSetting } from 'talisman-cms/env';
import { customerAccounts, customerSessions, orders } from './schema';

export const CUSTOMER_SESSION_COOKIE = 'talisman-customer';
export const CUSTOMER_SESSION_MAX_AGE = 60 * 60 * 24 * 30;
/** Store-wide sign-in emails per 24 hours unless `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT` sets another positive whole number. */
export const CUSTOMER_EMAIL_DAILY_LIMIT = 200;
/** A sign-in link works once, for this many seconds. */
const SIGN_IN_LINK_SECONDS = 15 * 60;
/** Requests per hour from one IP address (or IPv6 /64), counted separately for sign-in emails and link previews. */
const REQUESTS_PER_SOURCE_PER_HOUR = 20;
/** Order statuses that count as a purchase for first-order promotions and referrals. */
export const PURCHASED_ORDER_STATUSES = ['paid', 'fulfilled', 'partially_refunded', 'refunded'] as const;

/** The store-wide daily sign-in email limit is used up; the request sent nothing. */
export class CustomerEmailLimitError extends Error {
  override readonly name = 'CustomerEmailLimitError';

  constructor() {
    super('Too many sign-in emails were requested today');
  }
}

/** One IP address made too many requests; nothing was read or changed. */
export class CustomerRequestLimitError extends Error {
  override readonly name = 'CustomerRequestLimitError';

  constructor() {
    super('Too many sign-in requests');
  }
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The lowercased address, or null. Only a bare address is accepted, checked with the same rule the
 * email module applies to recipients, so a display name such as `a<victim@example.com>` can never
 * change who receives the link.
 */
function normalizeShopperEmail(email: unknown) {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254) return null;
  return parseAddress({ email: normalized })?.email === normalized ? normalized : null;
}

const isSignInToken = (token: unknown): token is string => typeof token === 'string' && /^[0-9a-f-]{72}$/.test(token);

/** `jakob@example.com` becomes `j•••@example.com`. */
function maskEmailAddress(email: string) {
  const at = email.lastIndexOf('@');
  const [first = ''] = Array.from(email.slice(0, Math.max(0, at)));
  return `${first}•••${email.slice(at)}`;
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

/**
 * Counts one request for `key` in a fixed window that starts with the first request, and returns the
 * new count. The counters live in `_ecommerce_rate_limits`: better-auth prunes its own table by its
 * own clock, which deleted these counters when they were kept there.
 */
async function countRequest(env: TalismanEnv, key: string, now: number, windowSeconds: number) {
  const limit = await env.DB.prepare(`INSERT INTO _ecommerce_rate_limits (key, count, window_start)
    VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
    RETURNING count`)
    .bind(key, now, now - windowSeconds, now - windowSeconds, now)
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

/** Counts a request from `sourceIp` in `bucket` and says whether that source is over its hourly limit. */
async function sourceOverLimit(env: TalismanEnv, bucket: string, sourceIp: string | null | undefined, now: number) {
  if (!sourceIp || sourceIp.length > 64) return false;
  const count = await countRequest(env, `${bucket}:${await hashToken(rateLimitSource(sourceIp))}`, now, 3600);
  return (count ?? REQUESTS_PER_SOURCE_PER_HOUR + 1) > REQUESTS_PER_SOURCE_PER_HOUR;
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
 * Whether a shopper has bought before: a paid, fulfilled or refunded order under one of `accountIds`,
 * placed with one of `emails`, or owned by an account with one of those emails. Admin test orders do
 * not count. First-order promotions and referrals use this, never whether an account row exists.
 */
export async function hasPurchaseHistory(env: TalismanEnv, shopper: { emails?: Array<string | null | undefined>; accountIds?: Array<string | null | undefined> }) {
  const emails = [...new Set((shopper.emails ?? []).flatMap((email) => email?.trim() ? [email.trim().toLowerCase()] : []))];
  const accountIds = [...new Set((shopper.accountIds ?? []).flatMap((id) => id ? [id] : []))];
  const matches: string[] = [];
  if (emails.length) {
    const list = emails.map(() => '?').join(', ');
    matches.push(`lower(customer_email) IN (${list})`,
      `user_id IN (SELECT id FROM _ecommerce_customer_accounts WHERE email_normalized IN (${list}))`);
  }
  if (accountIds.length) matches.push(`user_id IN (${accountIds.map(() => '?').join(', ')})`);
  if (!matches.length) return false;
  const statuses = PURCHASED_ORDER_STATUSES.map((status) => `'${status}'`).join(', ');
  const prior = await env.DB.prepare(`SELECT 1 AS found FROM _ecommerce_orders
    WHERE status IN (${statuses}) AND COALESCE(payment_provider, 'stripe') <> 'admin_test'
      AND (${matches.join(' OR ')}) LIMIT 1`)
    .bind(...emails, ...emails, ...accountIds).first<{ found: number }>();
  return Boolean(prior);
}

/**
 * Sends a one-time link to `email`. The caller must deliver it to the address it is given. Only the
 * token's hash and the address are stored; no shopper account exists until the link is used.
 * A rate-limited request returns without sending, so callers can answer it like any other. Throws
 * `CustomerEmailLimitError` once the store has sent its daily number of sign-in emails.
 */
export async function requestCustomerEmailSignIn(env: TalismanEnv, email: string,
  linkForToken: (token: string) => string,
  sendLink: (to: string, link: string) => Promise<void>, sourceIp?: string | null) {
  const normalized = normalizeShopperEmail(email);
  if (!normalized) throw new Error('Valid email required');
  const now = Math.floor(Date.now() / 1000);
  if (await sourceOverLimit(env, 'shopper-email', sourceIp, now)) return;
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_sign_in_tokens
    WHERE email_normalized = ? AND created_at > ?`)
    .bind(normalized, now - 600).first<{ count: number }>();
  if ((recent?.count ?? 0) >= 3) return;
  // Caps what a flood of requests from many addresses can send before the provider's own quota runs out.
  const dailyLimit = customerEmailDailyLimit(env);
  if ((await countRequest(env, 'shopper-email:daily', now, 24 * 60 * 60) ?? dailyLimit + 1) > dailyLimit) {
    throw new CustomerEmailLimitError();
  }
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const tokenHash = await hashToken(token);
  await env.DB.prepare(`INSERT INTO _ecommerce_sign_in_tokens (token_hash, email_normalized, expires_at, created_at)
    VALUES (?, ?, ?, ?)`)
    .bind(tokenHash, normalized, now + SIGN_IN_LINK_SECONDS, now).run();
  try {
    await sendLink(normalized, linkForToken(token));
  } catch (error) {
    await env.DB.prepare(`UPDATE _ecommerce_sign_in_tokens SET revoked_at = ? WHERE token_hash = ?`)
      .bind(Math.floor(Date.now() / 1000), tokenHash).run();
    throw error;
  }
}

/**
 * The masked address an unused sign-in link was sent to, for example `j•••@example.com`, so a
 * storefront can show which account the link opens before the shopper confirms. The link stays
 * usable. Returns null for an unknown, used or expired link. Throws `CustomerRequestLimitError`
 * when `sourceIp` has asked too often.
 */
export async function previewCustomerEmailSignIn(env: TalismanEnv, token: unknown, sourceIp?: string | null) {
  const now = Math.floor(Date.now() / 1000);
  if (await sourceOverLimit(env, 'shopper-preview', sourceIp, now)) throw new CustomerRequestLimitError();
  if (!isSignInToken(token)) return null;
  const link = await env.DB.prepare(`SELECT email_normalized FROM _ecommerce_sign_in_tokens
    WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`)
    .bind(await hashToken(token), now).first<{ email_normalized: string }>();
  const email = normalizeShopperEmail(link?.email_normalized);
  return email ? maskEmailAddress(email) : null;
}

/**
 * Uses a sign-in link once. Using it proves control of the address, so this is where the shopper
 * account is created (already verified) or linked, and where it joins the shared CMS identity.
 */
export async function consumeCustomerEmailSignIn(env: TalismanEnv, token: string) {
  if (!isSignInToken(token)) return null;
  const now = Math.floor(Date.now() / 1000);
  const claimed = await env.DB.prepare(`UPDATE _ecommerce_sign_in_tokens SET revoked_at = ?
    WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? RETURNING email_normalized`)
    .bind(now, await hashToken(token), now).all<{ email_normalized: string }>();
  const email = normalizeShopperEmail(claimed.results?.[0]?.email_normalized);
  if (!email) return null;
  await env.DB.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(email_normalized) DO NOTHING`)
    .bind(`acct_${crypto.randomUUID()}`, email, email, now, now, now).run();
  const db = createDbClient(env);
  const account = await db.select().from(customerAccounts)
    .where(eq(customerAccounts.emailNormalized, email)).get();
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
