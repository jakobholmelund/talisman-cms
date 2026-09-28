import { and, count, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { createDbClient, type TalismanEnv } from 'talisman-cms/client';
import { ensureVerifiedEmailIdentity } from 'talisman-cms/auth/identity';
import { parseAddress } from 'talisman-cms/email';
import { readSetting } from 'talisman-cms/env';
import { clientOverLimit, countRequest, peekRequestCount, sha256Hex } from './rate-limits';
import { customerAccounts, customerSessions, orders, signInTokens } from './schema';
import { SHOPPER_SIGN_IN_TURNSTILE_ACTION, readTurnstileSettings } from './turnstile';

export const CUSTOMER_SESSION_COOKIE = 'talisman-customer';
export const CUSTOMER_SESSION_MAX_AGE = 60 * 60 * 24 * 30;
/** Store-wide sign-in emails per 24 hours unless `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT` sets another positive whole number. */
export const CUSTOMER_EMAIL_DAILY_LIMIT = 200;
const DAY_SECONDS = 24 * 60 * 60;
/** Daily counters: every address draws on the general pool; the reserved pool is only for existing customers. */
const GENERAL_POOL_KEY = 'shopper-email:daily';
const RESERVED_POOL_KEY = 'shopper-email:reserved';
/** A sign-in link works once, for this many seconds. */
const SIGN_IN_LINK_SECONDS = 15 * 60;
/** Requests per hour from one IP address (or IPv6 /64), counted separately for sign-in emails and link previews. */
const REQUESTS_PER_SOURCE_PER_HOUR = 20;
/** Sign-in requests one address may make in ten minutes. */
const REQUESTS_PER_ADDRESS = 3;
const ADDRESS_WINDOW_SECONDS = 10 * 60;
/** Emails one address may draw from the reserved pool in 24 hours, so no single address can spend it. */
const RESERVED_SENDS_PER_ADDRESS = 2;
/**
 * Order statuses that count as a purchase for first-order promotions and referrals. A disputed order
 * still counts: its payment went through, and a lost dispute leaves it refunded.
 */
export const PURCHASED_ORDER_STATUSES = ['paid', 'fulfilled', 'partially_refunded', 'refunded', 'disputed'] as const;

/**
 * Kept for compatibility: `requestCustomerEmailSignIn` no longer throws it and answers a spent daily
 * budget with `{ limited: true }` instead.
 */
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

const hashToken = sha256Hex;
/** A time in Unix seconds as the schema's timestamp columns take it. */
const at = (seconds: number) => new Date(seconds * 1000);

/**
 * The lowercased address, or null. Only a bare address is accepted, checked with the same rule the
 * email module applies to recipients, so a display name such as `a<victim@example.com>` can never
 * change who receives the link.
 */
export function normalizeShopperEmail(email: unknown) {
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

function customerEmailDailyLimit(env: TalismanEnv) {
  const configured = Number(readSetting(env, 'COMMERCE_EMAIL_DAILY_LIMIT'));
  return Number.isSafeInteger(configured) && configured > 0 ? configured : CUSTOMER_EMAIL_DAILY_LIMIT;
}

/**
 * The part of the daily limit kept for addresses that already have a verified account or a purchase:
 * `TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY` when it is a whole number below the limit, otherwise a
 * quarter of the limit, rounded down.
 */
function customerEmailReservedDaily(env: TalismanEnv, dailyLimit: number) {
  const raw = readSetting(env, 'COMMERCE_EMAIL_RESERVED_DAILY');
  const configured = raw === undefined ? NaN : Number(raw);
  return Number.isSafeInteger(configured) && configured >= 0 && configured < dailyLimit ? configured : Math.floor(dailyLimit / 4);
}

/** An address with a verified shopper account, or with a purchased order placed under it. */
async function isExistingCustomer(env: TalismanEnv, email: string) {
  const verified = await createDbClient(env).select({ id: customerAccounts.id }).from(customerAccounts)
    .where(and(eq(customerAccounts.emailNormalized, email), isNotNull(customerAccounts.emailVerifiedAt))).get();
  return Boolean(verified) || await hasPurchaseHistory(env, { emails: [email] });
}

/**
 * The bot check a storefront should render in its sign-in form, or null when none is configured.
 * It is on when both `TALISMAN_COMMERCE_TURNSTILE_SITE_KEY` and `TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY`
 * are set; the account route then refuses email sign-in requests without a valid `turnstileToken`.
 */
export function shopperSignInBotCheck(env: TalismanEnv): { provider: 'turnstile'; siteKey: string; action: string } | null {
  const { siteKey, secretKey } = readTurnstileSettings(env);
  return siteKey && secretKey ? { provider: 'turnstile', siteKey, action: SHOPPER_SIGN_IN_TURNSTILE_ACTION } : null;
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

export interface CustomerEmailSignInOptions {
  /**
   * Runs work after the response, such as the Worker's `waitUntil`. Once the general daily budget is
   * spent, the customer lookup and any send from the reserved budget run through it, so the answer
   * takes the same time for every address. Without it that work runs before the call returns.
   */
  waitUntil?: (task: Promise<unknown>) => void;
  /**
   * Receives a failed send from the reserved budget. That failure is never thrown, so the answer stays
   * the same for every address. Defaults to logging the error's name.
   */
  onLimitedSendError?: (error: unknown) => void;
}

/**
 * Sends a one-time link to `email`. The caller must deliver it to the address it is given. Only the
 * token's hash and the address are stored; no shopper account exists until the link is used.
 * A rate-limited request returns without sending, so callers can answer it like any other.
 *
 * The store-wide daily limit has two pools. The general pool (the limit minus the reserve) serves any
 * address. Once it is spent the call returns `{ limited: true }` for every address, and sends only to
 * an address with a verified account or a purchase, while the reserved pool lasts and at most
 * twice a day per address. Otherwise it returns `{ limited: false }`. Send failures outside the
 * limited state are thrown.
 */
export async function requestCustomerEmailSignIn(env: TalismanEnv, email: string,
  linkForToken: (token: string) => string,
  sendLink: (to: string, link: string) => Promise<void>, sourceIp?: string | null,
  options: CustomerEmailSignInOptions = {}): Promise<{ limited: boolean }> {
  const normalized = normalizeShopperEmail(email);
  if (!normalized) throw new Error('Valid email required');
  const now = Math.floor(Date.now() / 1000);
  const dailyLimit = customerEmailDailyLimit(env);
  const generalPool = dailyLimit - customerEmailReservedDaily(env, dailyLimit);
  // A request dropped by a per-client or per-address limit still reports the store-wide state, so the
  // answer never depends on the address.
  const dropped = async () => ({ limited: await peekRequestCount(env, GENERAL_POOL_KEY, now, DAY_SECONDS) >= generalPool });
  if (await clientOverLimit(env, 'shopper-email', sourceIp, { limit: REQUESTS_PER_SOURCE_PER_HOUR, windowSeconds: 3600, now })) {
    return dropped();
  }
  const recent = await createDbClient(env).select({ count: count() }).from(signInTokens)
    .where(and(eq(signInTokens.emailNormalized, normalized), gt(signInTokens.createdAt, at(now - ADDRESS_WINDOW_SECONDS))))
    .get();
  if ((recent?.count ?? 0) >= REQUESTS_PER_ADDRESS) return dropped();
  // The link count above only sees links already written; this counter is updated atomically, so
  // parallel requests for one address are held to the same limit. Its key holds the address's hash.
  const addressKey = await sha256Hex(normalized);
  if ((await countRequest(env, `shopper-email:address:${addressKey}`, now, ADDRESS_WINDOW_SECONDS) ?? REQUESTS_PER_ADDRESS + 1)
    > REQUESTS_PER_ADDRESS) return dropped();
  // Caps what a flood of requests from many addresses can send before the provider's own quota runs out.
  if ((await countRequest(env, GENERAL_POOL_KEY, now, DAY_SECONDS) ?? generalPool + 1) <= generalPool) {
    await sendSignInLink(env, normalized, now, linkForToken, sendLink);
    return { limited: false };
  }
  const reserved = (async () => {
    if (!await isExistingCustomer(env, normalized)) return;
    if ((await countRequest(env, `shopper-email:reserved-address:${addressKey}`, now, DAY_SECONDS) ?? RESERVED_SENDS_PER_ADDRESS + 1)
      > RESERVED_SENDS_PER_ADDRESS) return;
    const reservedPool = dailyLimit - generalPool;
    if ((await countRequest(env, RESERVED_POOL_KEY, now, DAY_SECONDS) ?? reservedPool + 1) > reservedPool) return;
    await sendSignInLink(env, normalized, now, linkForToken, sendLink);
  })().catch((error) => {
    if (options.onLimitedSendError) options.onLimitedSendError(error);
    else console.error('[commerce] Sign-in email failed', { name: error instanceof Error ? error.name : typeof error });
  });
  if (options.waitUntil) options.waitUntil(reserved);
  else await reserved;
  return { limited: true };
}

async function sendSignInLink(env: TalismanEnv, email: string, now: number,
  linkForToken: (token: string) => string, sendLink: (to: string, link: string) => Promise<void>) {
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const tokenHash = await hashToken(token);
  const db = createDbClient(env);
  await db.insert(signInTokens)
    .values({ tokenHash, emailNormalized: email, expiresAt: at(now + SIGN_IN_LINK_SECONDS), createdAt: at(now) });
  try {
    await sendLink(email, linkForToken(token));
  } catch (error) {
    await db.update(signInTokens).set({ revokedAt: new Date() }).where(eq(signInTokens.tokenHash, tokenHash));
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
  if (await clientOverLimit(env, 'shopper-preview', sourceIp, { limit: REQUESTS_PER_SOURCE_PER_HOUR, windowSeconds: 3600, now })) {
    throw new CustomerRequestLimitError();
  }
  if (!isSignInToken(token)) return null;
  const link = await createDbClient(env).select({ emailNormalized: signInTokens.emailNormalized }).from(signInTokens)
    .where(and(eq(signInTokens.tokenHash, await hashToken(token)), isNull(signInTokens.revokedAt),
      gt(signInTokens.expiresAt, at(now)))).get();
  const email = normalizeShopperEmail(link?.emailNormalized);
  return email ? maskEmailAddress(email) : null;
}

/**
 * Uses a sign-in link once. Using it proves control of the address, so this is where the shopper
 * account is created (already verified) or linked, and where it joins the shared CMS identity.
 */
export async function consumeCustomerEmailSignIn(env: TalismanEnv, token: string) {
  if (!isSignInToken(token)) return null;
  const now = Math.floor(Date.now() / 1000);
  const db = createDbClient(env);
  const [claimed] = await db.update(signInTokens).set({ revokedAt: at(now) })
    .where(and(eq(signInTokens.tokenHash, await hashToken(token)), isNull(signInTokens.revokedAt),
      gt(signInTokens.expiresAt, at(now))))
    .returning({ emailNormalized: signInTokens.emailNormalized });
  const email = normalizeShopperEmail(claimed?.emailNormalized);
  if (!email) return null;
  await db.insert(customerAccounts)
    .values({ id: `acct_${crypto.randomUUID()}`, email, emailNormalized: email, emailVerifiedAt: at(now),
      createdAt: at(now), updatedAt: at(now) })
    .onConflictDoNothing({ target: customerAccounts.emailNormalized });
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

/** The account's orders. `status` is the payment status; `fulfillmentStatus` says whether they shipped. */
export async function listCustomerOrders(env: TalismanEnv, accountId: string) {
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
    createdAt: orders.createdAt,
  }).from(orders).where(eq(orders.userId, accountId));
}
