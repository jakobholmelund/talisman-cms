import {
  creditLedger,
  customerAccounts,
  referralCodes,
  referralSettings,
  referrals
} from "./chunk-CLEUXV3O.js";

// src/referrals.ts
import { and, desc, eq } from "drizzle-orm";
import { createDbClient } from "talisman-cms/client";
import { readSetting } from "talisman-cms/env";
var REFERRAL_COOKIE = "talisman-referral";
var REFERRAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
var REFERRAL_REWARD_CENTS = 1e3;
var REFERRAL_MIN_ORDER_CENTS = 5e3;
function referralPolicy(env) {
  const readCents = (value, fallback) => {
    const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1e5 ? parsed : fallback;
  };
  return {
    enabled: true,
    rewardCents: readCents(readSetting(env, "COMMERCE_REFERRAL_REWARD_CENTS"), REFERRAL_REWARD_CENTS),
    minOrderCents: readCents(readSetting(env, "COMMERCE_REFERRAL_MIN_ORDER_CENTS"), REFERRAL_MIN_ORDER_CENTS),
    attributionDays: 30
  };
}
async function getReferralPolicy(env) {
  const db = createDbClient(env);
  const saved = await db.select().from(referralSettings).where(eq(referralSettings.id, "default")).get();
  return saved ? {
    enabled: saved.enabled,
    rewardCents: saved.rewardCents,
    minOrderCents: saved.minOrderCents,
    attributionDays: saved.attributionDays
  } : referralPolicy(env);
}
function validReferralCode(code) {
  return typeof code === "string" && /^REF-[A-F0-9]{20}$/.test(code);
}
async function findReferralCode(env, code) {
  if (!validReferralCode(code)) return null;
  const db = createDbClient(env);
  const row = await db.select({
    code: referralCodes.code,
    accountId: referralCodes.accountId,
    emailNormalized: customerAccounts.emailNormalized
  }).from(referralCodes).innerJoin(customerAccounts, eq(referralCodes.accountId, customerAccounts.id)).where(and(eq(referralCodes.code, code), eq(referralCodes.active, true))).get();
  return row ?? null;
}
async function getOrCreateReferralCode(env, accountId) {
  const db = createDbClient(env);
  let existing = await db.select({ code: referralCodes.code }).from(referralCodes).where(eq(referralCodes.accountId, accountId)).get();
  if (existing) return existing.code;
  const code = `REF-${Array.from(
    crypto.getRandomValues(new Uint8Array(10)),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("").toUpperCase()}`;
  await db.insert(referralCodes).values({ code, accountId, createdAt: /* @__PURE__ */ new Date() }).onConflictDoNothing({ target: referralCodes.accountId });
  existing = await db.select({ code: referralCodes.code }).from(referralCodes).where(eq(referralCodes.accountId, accountId)).get();
  if (!existing) throw new Error("Referral code could not be created");
  return existing.code;
}
async function getReferralDashboard(env, accountId) {
  const db = createDbClient(env);
  const account = await db.select({ creditBalance: customerAccounts.creditBalance }).from(customerAccounts).where(eq(customerAccounts.id, accountId)).get();
  if (!account) throw new Error("Shopper account not found");
  const code = await getOrCreateReferralCode(env, accountId);
  const codeRow = await db.select({ active: referralCodes.active }).from(referralCodes).where(eq(referralCodes.accountId, accountId)).get();
  const earned = await db.select({
    id: referrals.id,
    orderId: referrals.orderId,
    rewardCents: referrals.rewardCents,
    currency: referrals.currency,
    status: referrals.status,
    createdAt: referrals.createdAt
  }).from(referrals).where(eq(referrals.referrerAccountId, accountId)).orderBy(desc(referrals.createdAt));
  const activity = await db.select({
    id: creditLedger.id,
    orderId: creditLedger.orderId,
    kind: creditLedger.kind,
    amountCents: creditLedger.amountCents,
    createdAt: creditLedger.createdAt
  }).from(creditLedger).where(eq(creditLedger.accountId, accountId)).orderBy(desc(creditLedger.createdAt)).limit(50);
  return {
    code,
    codeActive: codeRow?.active ?? false,
    creditBalance: account.creditBalance,
    earned,
    activity
  };
}

export {
  REFERRAL_COOKIE,
  REFERRAL_COOKIE_MAX_AGE,
  REFERRAL_REWARD_CENTS,
  REFERRAL_MIN_ORDER_CENTS,
  referralPolicy,
  getReferralPolicy,
  validReferralCode,
  findReferralCode,
  getOrCreateReferralCode,
  getReferralDashboard
};
