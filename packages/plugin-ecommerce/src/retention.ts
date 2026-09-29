import { sql, type SQL } from 'drizzle-orm';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb } from './db';

// Data retention: the scheduled purge of shopper and sign-in data past its period.

export interface CommercePurgeOptions {
  env: TalismanEnv;
  now?: Date;
  /** Rows deleted per statement. */
  batchSize?: number;
}

/** Statements per table and run; a larger backlog is finished by later runs. */
const PURGE_MAX_BATCHES = 20;

/**
 * Delete shopper and sign-in data past its retention period. Run it from the scheduled
 * Worker next to reconcileCommerce; deletes are batched to stay inside D1 and Worker limits.
 * Every table is attempted, and the run throws afterwards if any of them failed.
 */
export async function purgeStaleCommerceData(options: CommercePurgeOptions) {
  const { env } = options;
  const batchSize = Math.max(1, Math.min(1000, Math.floor(options.batchSize ?? 500)));
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const day = 24 * 60 * 60;
  const deleted = { carts: 0, customerSessions: 0, signInTokens: 0, unverifiedAccounts: 0, rateLimits: 0,
    authSessions: 0, authRateLimits: 0 };
  const steps: Array<[keyof typeof deleted, (limit: number) => SQL]> = [
    // Guest baskets untouched for 30 days. Account, checked-out and locked baskets stay.
    ['carts', (limit) => sql`DELETE FROM _ecommerce_carts WHERE id IN (SELECT id FROM _ecommerce_carts
      WHERE user_id IS NULL AND closed = 0 AND checkout_session_id IS NULL AND updated_at < ${now - 30 * day}
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders WHERE cart_id = _ecommerce_carts.id)
      LIMIT ${limit})`],
    // Shopper sessions, and the `email_challenge` rows of earlier releases, a day after they expired, were used or signed out.
    ['customerSessions', (limit) => sql`DELETE FROM _ecommerce_customer_sessions WHERE id IN (SELECT id
      FROM _ecommerce_customer_sessions WHERE expires_at < ${now - day} OR revoked_at < ${now - day} LIMIT ${limit})`],
    // Sign-in links, with the address they were sent to, a day after they expired or were used.
    ['signInTokens', (limit) => sql`DELETE FROM _ecommerce_sign_in_tokens WHERE token_hash IN (SELECT token_hash
      FROM _ecommerce_sign_in_tokens WHERE expires_at < ${now - day} OR revoked_at < ${now - day} LIMIT ${limit})`],
    // Accounts that asking for a sign-in link used to create: never verified, a day old, and with no
    // orders, sessions, basket, credit, referral or discount use. Anything else keeps the account.
    ['unverifiedAccounts', (limit) => sql`DELETE FROM _ecommerce_customer_accounts WHERE id IN (SELECT a.id
      FROM _ecommerce_customer_accounts a
      WHERE a.email_verified_at IS NULL AND a.cms_user_id IS NULL AND a.credit_balance = 0 AND a.created_at < ${now - day}
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders WHERE user_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_customer_sessions WHERE account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_carts WHERE user_id = a.id AND closed = 0)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_credit_ledger WHERE account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_referral_codes WHERE account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_referrals WHERE referrer_account_id = a.id OR referred_account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_discount_redemptions WHERE account_id = a.id)
      LIMIT ${limit})`],
    // Shopper request counters. Every window is at most a day long.
    ['rateLimits', (limit) => sql`DELETE FROM _ecommerce_rate_limits WHERE key IN (SELECT key FROM _ecommerce_rate_limits
      WHERE window_start < ${now - day} LIMIT ${limit})`],
    ['authSessions', (limit) => sql`DELETE FROM galaxy_auth_session WHERE id IN (SELECT id FROM galaxy_auth_session
      WHERE expires_at < ${now} LIMIT ${limit})`],
    // better-auth records milliseconds. Shopper counters written in seconds by earlier releases may remain.
    ['authRateLimits', (limit) => sql`DELETE FROM galaxy_auth_rate_limit WHERE id IN (SELECT id FROM galaxy_auth_rate_limit
      WHERE CASE WHEN last_request >= 100000000000 THEN last_request / 1000 ELSE last_request END < ${now - day}
      LIMIT ${limit})`],
  ];
  const db = commerceDb(env);
  const failures: string[] = [];
  for (const [table, statement] of steps) {
    try {
      for (let batch = 0; batch < PURGE_MAX_BATCHES; batch++) {
        const result = await db.run(statement(batchSize));
        const changes = Number(result.meta?.changes ?? 0);
        deleted[table] += changes;
        if (changes < batchSize) break;
      }
    } catch (error) {
      failures.push(`${table}: ${error instanceof Error ? error.message : 'cleanup failed'}`);
    }
  }
  if (failures.length) throw new Error(`Commerce data cleanup failed (${failures.join('; ')})`);
  return deleted;
}
