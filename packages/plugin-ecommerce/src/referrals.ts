import { and, desc, eq } from 'drizzle-orm';
import { createDbClient, type TalismanEnv } from 'talisman-cms/client';
import { readSetting } from 'talisman-cms/env';
import { creditLedger, customerAccounts, referralCodes, referrals, referralSettings } from './schema';

export const REFERRAL_COOKIE = 'talisman-referral';
export const REFERRAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
export const REFERRAL_REWARD_CENTS = 1000;
export const REFERRAL_MIN_ORDER_CENTS = 5000;

/** A site can set both values as Worker vars; invalid values fall back to defaults. */
export function referralPolicy(env: TalismanEnv) {
  const readCents = (value: unknown, fallback: number) => {
    const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 100_000 ? parsed : fallback;
  };
  return {
    enabled: true,
    rewardCents: readCents(readSetting(env, 'COMMERCE_REFERRAL_REWARD_CENTS'), REFERRAL_REWARD_CENTS),
    minOrderCents: readCents(readSetting(env, 'COMMERCE_REFERRAL_MIN_ORDER_CENTS'), REFERRAL_MIN_ORDER_CENTS),
    attributionDays: 30,
  };
}

export async function getReferralPolicy(env: TalismanEnv) {
  const db = createDbClient(env);
  const saved = await db.select().from(referralSettings)
    .where(eq(referralSettings.id, 'default')).get();
  return saved ? { enabled: saved.enabled, rewardCents: saved.rewardCents,
    minOrderCents: saved.minOrderCents, attributionDays: saved.attributionDays } : referralPolicy(env);
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

export async function getReferralDashboard(env: TalismanEnv, accountId: string) {
  const db = createDbClient(env);
  const account = await db.select({ creditBalance: customerAccounts.creditBalance }).from(customerAccounts)
    .where(eq(customerAccounts.id, accountId)).get();
  if (!account) throw new Error('Shopper account not found');
  const code = await getOrCreateReferralCode(env, accountId);
  const codeRow = await db.select({ active: referralCodes.active }).from(referralCodes)
    .where(eq(referralCodes.accountId, accountId)).get();
  const earned = await db.select({ id: referrals.id, orderId: referrals.orderId,
    rewardCents: referrals.rewardCents, currency: referrals.currency, status: referrals.status,
    createdAt: referrals.createdAt }).from(referrals)
    .where(eq(referrals.referrerAccountId, accountId)).orderBy(desc(referrals.createdAt));
  const activity = await db.select({ id: creditLedger.id, orderId: creditLedger.orderId,
    kind: creditLedger.kind, amountCents: creditLedger.amountCents,
    createdAt: creditLedger.createdAt }).from(creditLedger)
    .where(eq(creditLedger.accountId, accountId)).orderBy(desc(creditLedger.createdAt)).limit(50);
  return { code, codeActive: codeRow?.active ?? false,
    creditBalance: account.creditBalance, earned, activity };
}
