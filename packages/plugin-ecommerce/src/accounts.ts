import { and, eq, gt, isNull } from 'drizzle-orm';
import { createDbClient, type TalismanEnv } from 'talisman-cms/client';
import { customerAccounts, customerSessions, orders } from './schema';

export const CUSTOMER_SESSION_COOKIE = 'talisman-customer';
export const CUSTOMER_SESSION_MAX_AGE = 60 * 60 * 24 * 30;

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

/** Basket possession never proves ownership of the checkout email. */
export async function activateNewCustomer(_env: TalismanEnv, _orderId: string, _basketToken: string) {
  return null;
}

/** The caller must deliver the link to the account's email address. */
export async function requestCustomerEmailSignIn(env: TalismanEnv, email: string,
  linkForToken: (token: string) => string,
  sendLink: (to: string, link: string) => Promise<void>) {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Valid email required');
  }
  const db = createDbClient(env);
  const account = await db.select().from(customerAccounts)
    .where(eq(customerAccounts.emailNormalized, normalized)).get();
  if (!account) return;
  const now = Math.floor(Date.now() / 1000);
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_customer_sessions
    WHERE account_id = ? AND purpose = 'email_challenge' AND created_at > ?`)
    .bind(account.id, now - 600).all<{ count: number }>();
  if ((recent.results?.[0]?.count ?? 0) >= 3) return;
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
  const sessionToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(`UPDATE _ecommerce_customer_accounts
      SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?`)
      .bind(now, now, account.id),
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
