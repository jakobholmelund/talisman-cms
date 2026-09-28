import { and, desc, eq } from 'drizzle-orm';
import { createDbClient, type TalismanEnv } from 'talisman-cms/client';
import { readSetting } from 'talisman-cms/env';
import type { PaymentProviderAdapter } from './payments';
import { creditLedger, customerAccounts, orders, referralCodes, referrals, referralSettings } from './schema';

export { canonicalEmail } from './email-identity';

export const REFERRAL_COOKIE = 'talisman-referral';
export const REFERRAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
export const REFERRAL_REWARD_CENTS = 1000;
export const REFERRAL_MIN_ORDER_CENTS = 5000;
/** Days an award stays pending after payment, so returns and disputes can still reverse it. */
export const REFERRAL_HOLD_DAYS = 30;
/** Referrals one referrer can have recorded within REFERRAL_PERIOD_DAYS. */
export const REFERRAL_MAX_PER_PERIOD = 10;
export const REFERRAL_PERIOD_DAYS = 30;

const DAY_SECONDS = 24 * 60 * 60;
/**
 * Order statuses in which a paid order can still earn or keep its referral award. A disputed order
 * keeps it until the dispute closes, but its award is not released meanwhile.
 */
const QUALIFYING_STATUSES = ['paid', 'fulfilled', 'partially_refunded', 'disputed'] as const;

export type ReferralPolicy = {
  /** New referrals are attributed: the switch is on and the terms are valid. */
  enabled: boolean;
  /** The switch as an admin saved it, or as the Worker setting gives it when nothing is saved. */
  switchedOn: boolean;
  /** Why valid terms are missing, in which case nothing new is attributed; null when the terms are valid. */
  termsError: string | null;
  source: 'saved' | 'settings';
  rewardCents: number;
  minOrderCents: number;
  attributionDays: number;
  /** Worker settings, read-only in the admin. */
  holdDays: number;
  maxPerPeriod: number;
  periodDays: number;
};

const readWhole = (value: unknown, fallback: number, max: number) => {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
};

/** The reward is at most half the minimum order, so an award is always worth less than the order that earns it. */
export function referralTermsError(terms: { rewardCents: number; minOrderCents: number }) {
  return terms.rewardCents * 2 > terms.minOrderCents
    ? 'The reward must be at most half the minimum first order' : null;
}

function referralLimits(env: TalismanEnv) {
  return {
    holdDays: readWhole(readSetting(env, 'COMMERCE_REFERRAL_HOLD_DAYS'), REFERRAL_HOLD_DAYS, 365),
    maxPerPeriod: readWhole(readSetting(env, 'COMMERCE_REFERRAL_MAX_PER_PERIOD'), REFERRAL_MAX_PER_PERIOD, 10_000),
    periodDays: readWhole(readSetting(env, 'COMMERCE_REFERRAL_PERIOD_DAYS'), REFERRAL_PERIOD_DAYS, 365),
  };
}

function withTerms(terms: Omit<ReferralPolicy, 'enabled' | 'termsError'>): ReferralPolicy {
  const termsError = referralTermsError(terms);
  return { ...terms, enabled: terms.switchedOn && !termsError, termsError };
}

/**
 * The policy from Worker settings alone. Referrals are off unless `TALISMAN_COMMERCE_REFERRALS_ENABLED`
 * is `true`. Invalid or blank numbers fall back to the defaults.
 */
export function referralPolicy(env: TalismanEnv): ReferralPolicy {
  return withTerms({
    switchedOn: readSetting(env, 'COMMERCE_REFERRALS_ENABLED') === 'true',
    source: 'settings',
    rewardCents: readWhole(readSetting(env, 'COMMERCE_REFERRAL_REWARD_CENTS'), REFERRAL_REWARD_CENTS, 100_000),
    minOrderCents: readWhole(readSetting(env, 'COMMERCE_REFERRAL_MIN_ORDER_CENTS'), REFERRAL_MIN_ORDER_CENTS, 100_000),
    attributionDays: 30,
    ...referralLimits(env),
  });
}

/** Saved admin settings win over the Worker settings, in both directions; the limits always come from the Worker. */
export async function getReferralPolicy(env: TalismanEnv): Promise<ReferralPolicy> {
  const db = createDbClient(env);
  const saved = await db.select().from(referralSettings)
    .where(eq(referralSettings.id, 'default')).get();
  if (!saved) return referralPolicy(env);
  return withTerms({ switchedOn: saved.enabled, source: 'saved', rewardCents: saved.rewardCents,
    minOrderCents: saved.minOrderCents, attributionDays: saved.attributionDays, ...referralLimits(env) });
}

type QualifyingOrder = Pick<typeof orders.$inferSelect, 'status' | 'subtotalAmount' | 'discountAmount'
  | 'providerRefundedCents' | 'giftCardRefundedCents'>;

/**
 * What the shopper paid for the goods after promotions and refunds: the subtotal less the promotion
 * discount, provider refunds and gift card refunds. Store credit and gift card tender count as paid.
 * Shipping and tax added to the price are not part of the goods, and a refund counts in full against
 * them even when it returned shipping or tax, so this never exceeds what the order kept for its goods.
 */
export function referralNetAmount(order: Omit<QualifyingOrder, 'status'>) {
  return order.subtotalAmount - order.discountAmount - order.providerRefundedCents - order.giftCardRefundedCents;
}

/**
 * An order keeps its referral while it is paid (or disputed), not fully refunded, and its net amount
 * reaches the minimum and at least twice the award's reward. The reward is fixed at checkout, so
 * terms lowered later never let an award exceed half of what the order kept. The minimum counts up
 * to what the order qualified with at checkout (its subtotal less the discount), so a minimum raised
 * later never voids an award by itself; only a refund or a lost dispute does.
 */
export function referralOrderQualifies(order: QualifyingOrder, minOrderCents: number, rewardCents = 0) {
  const minimum = Math.min(minOrderCents, order.subtotalAmount - order.discountAmount);
  return (QUALIFYING_STATUSES as readonly string[]).includes(order.status)
    && referralNetAmount(order) >= Math.max(minimum, 2 * rewardCents);
}

/**
 * SQL for `referralOrderQualifies` on the order `alias`, with the reward from the SQL expression
 * `reward`; binds the minimum order once.
 */
function qualifyingOrderSql(alias: string, reward: string) {
  return `(${alias}.status IN (${QUALIFYING_STATUSES.map((status) => `'${status}'`).join(', ')})
    AND ${alias}.subtotal_amount - ${alias}.discount_amount - ${alias}.provider_refunded_cents
      - ${alias}.gift_card_refunded_cents
      >= MAX(MIN(?, ${alias}.subtotal_amount - ${alias}.discount_amount), 2 * ${reward}))`;
}

/**
 * Statements that void the order's referral and reverse any released awards, once for each award,
 * when the order no longer qualifies at `minOrderCents` and the award's reward, or a dispute was lost. Idempotent; they read
 * the order as it is when they run, so add them after the statements that change it.
 */
export function referralReversalStatements(env: TalismanEnv, orderId: string,
  options: { minOrderCents: number; now: number; disputeLost?: boolean }) {
  const lost = options.disputeLost ? 1 : 0;
  const statements: D1PreparedStatement[] = [];
  for (const [awardKind, reversalKind] of [
    ['referral_award', 'referral_reversal'], ['welcome_award', 'welcome_reversal']
  ]) {
    statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
      (id, account_id, order_id, kind, amount_cents, created_at)
      SELECT ?, l.account_id, l.order_id, ?, -l.amount_cents, ?
      FROM _ecommerce_credit_ledger l
      JOIN _ecommerce_orders o ON o.id = l.order_id
      WHERE l.order_id = ? AND l.kind = ? AND (? = 1 OR NOT ${qualifyingOrderSql('o', 'l.amount_cents')})
      ON CONFLICT DO NOTHING`)
      .bind(`credit_${reversalKind}_${orderId}`, reversalKind, options.now, orderId, awardKind,
        lost, options.minOrderCents));
  }
  statements.push(env.DB.prepare(`UPDATE _ecommerce_referrals SET status = 'void', updated_at = ?
    WHERE order_id = ? AND status = 'approved'
      AND (? = 1 OR EXISTS (SELECT 1 FROM _ecommerce_orders o
        WHERE o.id = ? AND NOT ${qualifyingOrderSql('o', '_ecommerce_referrals.reward_cents')}))`)
    .bind(options.now, orderId, lost, orderId, options.minOrderCents));
  return statements;
}

/** Void the order's referral and reverse released awards when it no longer qualifies or a dispute was lost. */
export async function reverseReferralForOrder(env: TalismanEnv, orderId: string,
  options: { now?: Date; disputeLost?: boolean } = {}) {
  const policy = await getReferralPolicy(env);
  await env.DB.batch(referralReversalStatements(env, orderId, { minOrderCents: policy.minOrderCents,
    now: Math.floor((options.now ?? new Date()).getTime() / 1000), disputeLost: options.disputeLost }));
}

export type ReferralReleaseResult = {
  id: string;
  status: 'referral_released' | 'referral_void' | 'referral_held' | 'unchanged' | 'error';
  error?: string;
};

/**
 * Release pending referral awards whose hold has passed, at most `limit` per run; run it from the
 * scheduled Worker. An award is voided when its order no longer qualifies or its dispute was lost,
 * and stays pending while a dispute is open or, for a Stripe order, while no adapter can report
 * disputes. Otherwise the referrer and the referred shopper each receive the reward once, whether
 * or not new referrals are enabled.
 */
export async function releaseReferralAwards(options: { env: TalismanEnv; paymentAdapters?: PaymentProviderAdapter[] },
  run: { now?: Date; limit?: number } = {}) {
  const { env, paymentAdapters = [] } = options;
  const db = createDbClient(env);
  const now = Math.floor((run.now ?? new Date()).getTime() / 1000);
  const limit = Math.max(1, Math.min(50, Math.floor(run.limit ?? 10)));
  const policy = await getReferralPolicy(env);
  // Held awards are touched, so the oldest untouched ones come first and a held one never blocks the rest.
  const due = await env.DB.prepare(`SELECT r.id, r.order_id AS orderId, r.reward_cents AS rewardCents
    FROM _ecommerce_referrals r
    WHERE r.status = 'approved' AND r.created_at <= ?
      AND NOT EXISTS (SELECT 1 FROM _ecommerce_credit_ledger l
        WHERE l.order_id = r.order_id AND l.kind = 'referral_award')
    ORDER BY r.updated_at, r.created_at LIMIT ?`)
    .bind(now - policy.holdDays * DAY_SECONDS, limit).all<{ id: string; orderId: string; rewardCents: number }>();
  const results: ReferralReleaseResult[] = [];
  for (const row of due.results ?? []) {
    try {
      const order = await db.select().from(orders).where(eq(orders.id, row.orderId)).get();
      if (!order || !referralOrderQualifies(order, policy.minOrderCents, row.rewardCents)) {
        await env.DB.batch(referralReversalStatements(env, row.orderId, { minOrderCents: policy.minOrderCents, now }));
        results.push({ id: row.id, status: 'referral_void' });
        continue;
      }
      const provider = order.paymentProvider ?? 'stripe';
      const adapter = paymentAdapters.find((candidate) => candidate.providerId === provider);
      // A dispute recorded on the order holds the award without asking the provider.
      const dispute = order.status === 'disputed' ? 'open'
        : adapter?.getDisputeStatus && order.paymentIntentId ? await adapter.getDisputeStatus(order.paymentIntentId)
        : provider === 'stripe' ? 'unknown' : 'none';
      if (dispute === 'lost') {
        await env.DB.batch(referralReversalStatements(env, row.orderId,
          { minOrderCents: policy.minOrderCents, now, disputeLost: true }));
        results.push({ id: row.id, status: 'referral_void' });
        continue;
      }
      if (dispute !== 'none') {
        await db.update(referrals).set({ updatedAt: new Date(now * 1000) })
          .where(and(eq(referrals.id, row.id), eq(referrals.status, 'approved')));
        results.push({ id: row.id, status: 'referral_held' });
        continue;
      }
      // Each insert is guarded, so a referral voided or an order refunded in the meantime gets nothing
      // and a rerun adds nothing.
      await env.DB.batch([
        ['referral_award', 'referrer_account_id', `credit_ref_${row.orderId}`],
        ['welcome_award', 'referred_account_id', `credit_welcome_${row.orderId}`],
      ].map(([kind, account, id]) => env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
        (id, account_id, order_id, kind, amount_cents, created_at)
        SELECT ?, r.${account}, r.order_id, ?, r.reward_cents, ?
        FROM _ecommerce_referrals r JOIN _ecommerce_orders o ON o.id = r.order_id
        WHERE r.id = ? AND r.status = 'approved' AND r.reward_cents > 0 AND ${qualifyingOrderSql('o', 'r.reward_cents')}
          AND o.status <> 'disputed'
        ON CONFLICT DO NOTHING`)
        .bind(id, kind, now, row.id, policy.minOrderCents)));
      const released = await db.select({ id: creditLedger.id }).from(creditLedger)
        .where(and(eq(creditLedger.orderId, row.orderId), eq(creditLedger.kind, 'referral_award'))).get();
      const current = await db.select({ status: referrals.status }).from(referrals).where(eq(referrals.id, row.id)).get();
      results.push({ id: row.id, status: released ? 'referral_released'
        : current?.status === 'void' ? 'referral_void' : 'unchanged' });
    } catch (error) {
      results.push({ id: row.id, status: 'error', error: error instanceof Error ? error.message : 'Referral release failed' });
      // Retried after the others, so one failing lookup never holds up the rest.
      await db.update(referrals).set({ updatedAt: new Date(now * 1000) }).where(eq(referrals.id, row.id))
        .catch(() => undefined);
    }
  }
  return results;
}

export function validReferralCode(code: unknown): code is string {
  return typeof code === 'string' && /^REF-[A-F0-9]{20}$/.test(code);
}

export async function findReferralCode(env: TalismanEnv, code: unknown) {
  if (!validReferralCode(code)) return null;
  const db = createDbClient(env);
  const row = await db.select({ code: referralCodes.code, accountId: referralCodes.accountId,
    emailNormalized: customerAccounts.emailNormalized })
    .from(referralCodes).innerJoin(customerAccounts, eq(referralCodes.accountId, customerAccounts.id))
    .where(and(eq(referralCodes.code, code), eq(referralCodes.active, true))).get();
  return row ?? null;
}

export async function getOrCreateReferralCode(env: TalismanEnv, accountId: string) {
  const db = createDbClient(env);
  let existing = await db.select({ code: referralCodes.code }).from(referralCodes)
    .where(eq(referralCodes.accountId, accountId)).get();
  if (existing) return existing.code;
  const code = `REF-${Array.from(crypto.getRandomValues(new Uint8Array(10)),
    byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  await db.insert(referralCodes).values({ code, accountId, createdAt: new Date() })
    .onConflictDoNothing({ target: referralCodes.accountId });
  existing = await db.select({ code: referralCodes.code }).from(referralCodes)
    .where(eq(referralCodes.accountId, accountId)).get();
  if (!existing) throw new Error('Referral code could not be created');
  return existing.code;
}

export type ReferralDashboard = {
  /** The shopper's code; null while referrals are off and the shopper has none yet. */
  code: string | null;
  codeActive: boolean;
  /** Spendable ledger credit; pending awards are not included. */
  creditBalance: number;
  earned: Array<{ id: string; orderId: string; rewardCents: number; currency: string;
    status: 'approved' | 'void'; state: 'pending' | 'released' | 'void'; createdAt: Date;
    /** When a pending award can be released at the earliest; null once released or void. */
    releasesAt: Date | null }>;
  activity: Array<{ id: string; orderId: string; kind: string; amountCents: number; createdAt: Date }>;
};

export async function getReferralDashboard(env: TalismanEnv, accountId: string): Promise<ReferralDashboard> {
  const db = createDbClient(env);
  const account = await db.select({ creditBalance: customerAccounts.creditBalance }).from(customerAccounts)
    .where(eq(customerAccounts.id, accountId)).get();
  if (!account) throw new Error('Shopper account not found');
  const policy = await getReferralPolicy(env);
  // A code is only issued while referrals are on; an existing one is still shown.
  const codeRow = await db.select({ code: referralCodes.code, active: referralCodes.active }).from(referralCodes)
    .where(eq(referralCodes.accountId, accountId)).get();
  const code = codeRow?.code ?? (policy.enabled ? await getOrCreateReferralCode(env, accountId) : null);
  const codeActive = codeRow?.active ?? (code !== null);
  const rows = await db.select({ id: referrals.id, orderId: referrals.orderId,
    rewardCents: referrals.rewardCents, currency: referrals.currency, status: referrals.status,
    createdAt: referrals.createdAt, awardId: creditLedger.id }).from(referrals)
    .leftJoin(creditLedger, and(eq(creditLedger.orderId, referrals.orderId), eq(creditLedger.kind, 'referral_award')))
    .where(eq(referrals.referrerAccountId, accountId)).orderBy(desc(referrals.createdAt));
  const earned = rows.map(({ awardId, ...row }) => {
    const state = row.status === 'void' ? 'void' as const : awardId ? 'released' as const : 'pending' as const;
    return { ...row, state, releasesAt: state === 'pending'
      ? new Date(row.createdAt.getTime() + policy.holdDays * DAY_SECONDS * 1000) : null };
  });
  const activity = await db.select({ id: creditLedger.id, orderId: creditLedger.orderId,
    kind: creditLedger.kind, amountCents: creditLedger.amountCents,
    createdAt: creditLedger.createdAt }).from(creditLedger)
    .where(eq(creditLedger.accountId, accountId)).orderBy(desc(creditLedger.createdAt)).limit(50);
  return { code, codeActive, creditBalance: account.creditBalance, earned, activity };
}
