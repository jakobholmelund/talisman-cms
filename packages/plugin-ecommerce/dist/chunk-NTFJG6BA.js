import {
  PURCHASED_ORDER_STATUSES
} from "./chunk-IAWGIRUS.js";
import {
  commerceDb,
  runStatements
} from "./chunk-ZI5IJOR6.js";
import {
  creditLedger,
  customerAccounts,
  orders,
  referralCodes,
  referralSettings,
  referrals
} from "./chunk-NKJTK7MK.js";

// src/referrals.ts
import { and, desc, eq, sql as sql2 } from "drizzle-orm";
import { readSetting } from "talisman-cms/env";

// src/email-identity.ts
import { sql } from "drizzle-orm";
var GMAIL_DOMAINS = /* @__PURE__ */ new Set(["gmail.com", "googlemail.com"]);
function canonicalEmail(email) {
  if (typeof email !== "string") return null;
  const address = email.trim().toLowerCase();
  const at = address.indexOf("@");
  if (at < 1) return null;
  const domain = address.slice(at + 1).replace(/\.+$/, "");
  if (!domain) return null;
  let local = address.slice(0, at);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) return `${local.replaceAll(".", "")}@gmail.com`;
  return `${local}@${domain}`;
}
function canonicalEmails(emails) {
  return [...new Set(emails.map(canonicalEmail).filter((email) => Boolean(email)))];
}
function canonicalEmailSql(address) {
  const email = `lower(trim(${address}))`;
  const at = `instr(${email}, '@')`;
  const local = `substr(${email}, 1, ${at} - 1)`;
  const domain = `rtrim(substr(${email}, ${at} + 1), '.')`;
  const base = `(CASE WHEN instr(${local}, '+') > 1 THEN substr(${local}, 1, instr(${local}, '+') - 1) ELSE ${local} END)`;
  return `(CASE WHEN ${at} < 2 OR ${domain} = '' THEN NULL
    WHEN ${domain} IN ('gmail.com', 'googlemail.com') THEN replace(${base}, '.', '') || '@gmail.com'
    ELSE ${base} || '@' || ${domain} END)`;
}
function canonicalPurchase(canonicals, excludeOrderId) {
  const statuses = sql.raw(PURCHASED_ORDER_STATUSES.map((status) => `'${status}'`).join(", "));
  const purchased = sql`o.status IN (${statuses}) AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test' AND o.id <> ${excludeOrderId ?? ""}`;
  return sql`EXISTS (SELECT 1 FROM (
      SELECT o.customer_email AS address FROM _ecommerce_orders o WHERE ${purchased}
      UNION ALL
      SELECT a.email_normalized FROM _ecommerce_orders o
        JOIN _ecommerce_customer_accounts a ON a.id = o.user_id WHERE ${purchased})
    WHERE ${sql.raw(canonicalEmailSql("address"))} IN (${sql.join(canonicals.map((canonical) => sql`${canonical}`), sql`, `)}))`;
}
async function hasCanonicalPurchase(env, emails, excludeOrderId) {
  const canonicals = canonicalEmails(emails);
  if (!canonicals.length) return false;
  const found = await commerceDb(env).get(sql`SELECT ${canonicalPurchase(canonicals, excludeOrderId)} AS found`);
  return Boolean(found?.found);
}

// src/referrals.ts
var REFERRAL_COOKIE = "talisman-referral";
var REFERRAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
var REFERRAL_REWARD_CENTS = 1e3;
var REFERRAL_MIN_ORDER_CENTS = 5e3;
var REFERRAL_HOLD_DAYS = 30;
var REFERRAL_MAX_PER_PERIOD = 10;
var REFERRAL_PERIOD_DAYS = 30;
var DAY_SECONDS = 24 * 60 * 60;
var QUALIFYING_STATUSES = ["paid", "fulfilled", "partially_refunded", "disputed"];
var readWhole = (value, fallback, max) => {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
};
function referralTermsError(terms) {
  return terms.rewardCents * 2 > terms.minOrderCents ? "The reward must be at most half the minimum first order" : null;
}
function referralLimits(env) {
  return {
    holdDays: readWhole(readSetting(env, "COMMERCE_REFERRAL_HOLD_DAYS"), REFERRAL_HOLD_DAYS, 365),
    maxPerPeriod: readWhole(readSetting(env, "COMMERCE_REFERRAL_MAX_PER_PERIOD"), REFERRAL_MAX_PER_PERIOD, 1e4),
    periodDays: readWhole(readSetting(env, "COMMERCE_REFERRAL_PERIOD_DAYS"), REFERRAL_PERIOD_DAYS, 365)
  };
}
function withTerms(terms) {
  const termsError = referralTermsError(terms);
  return { ...terms, enabled: terms.switchedOn && !termsError, termsError };
}
function referralPolicy(env) {
  return withTerms({
    switchedOn: readSetting(env, "COMMERCE_REFERRALS_ENABLED") === "true",
    source: "settings",
    rewardCents: readWhole(readSetting(env, "COMMERCE_REFERRAL_REWARD_CENTS"), REFERRAL_REWARD_CENTS, 1e5),
    minOrderCents: readWhole(readSetting(env, "COMMERCE_REFERRAL_MIN_ORDER_CENTS"), REFERRAL_MIN_ORDER_CENTS, 1e5),
    attributionDays: 30,
    ...referralLimits(env)
  });
}
async function getReferralPolicy(env) {
  const db = commerceDb(env);
  const saved = await db.select().from(referralSettings).where(eq(referralSettings.id, "default")).get();
  if (!saved) return referralPolicy(env);
  return withTerms({
    switchedOn: saved.enabled,
    source: "saved",
    rewardCents: saved.rewardCents,
    minOrderCents: saved.minOrderCents,
    attributionDays: saved.attributionDays,
    ...referralLimits(env)
  });
}
function referralNetAmount(order) {
  return order.subtotalAmount - order.discountAmount - order.providerRefundedCents - order.giftCardRefundedCents;
}
function referralOrderQualifies(order, minOrderCents, rewardCents = 0) {
  const minimum = Math.min(minOrderCents, order.subtotalAmount - order.discountAmount);
  return QUALIFYING_STATUSES.includes(order.status) && referralNetAmount(order) >= Math.max(minimum, 2 * rewardCents);
}
function qualifyingOrder(alias, reward, minOrderCents) {
  const column = (name) => sql2.raw(`${alias}.${name}`);
  const statuses = sql2.raw(QUALIFYING_STATUSES.map((status) => `'${status}'`).join(", "));
  return sql2`(${column("status")} IN (${statuses})
    AND ${column("subtotal_amount")} - ${column("discount_amount")} - ${column("provider_refunded_cents")}
      - ${column("gift_card_refunded_cents")}
      >= MAX(MIN(${minOrderCents}, ${column("subtotal_amount")} - ${column("discount_amount")}), 2 * ${sql2.raw(reward)}))`;
}
function referralReversalStatements(orderId, options) {
  const lost = options.disputeLost ? 1 : 0;
  const statements = [];
  for (const [awardKind, reversalKind] of [
    ["referral_award", "referral_reversal"],
    ["welcome_award", "welcome_reversal"]
  ]) {
    statements.push(sql2`INSERT INTO _ecommerce_credit_ledger
      (id, account_id, order_id, kind, amount_cents, created_at)
      SELECT ${`credit_${reversalKind}_${orderId}`}, l.account_id, l.order_id, ${reversalKind}, -l.amount_cents, ${options.now}
      FROM _ecommerce_credit_ledger l
      JOIN _ecommerce_orders o ON o.id = l.order_id
      WHERE l.order_id = ${orderId} AND l.kind = ${awardKind} AND (${lost} = 1 OR NOT ${qualifyingOrder("o", "l.amount_cents", options.minOrderCents)})
      ON CONFLICT DO NOTHING`);
  }
  statements.push(sql2`UPDATE _ecommerce_referrals SET status = 'void', updated_at = ${options.now}
    WHERE order_id = ${orderId} AND status = 'approved'
      AND (${lost} = 1 OR EXISTS (SELECT 1 FROM _ecommerce_orders o
        WHERE o.id = ${orderId} AND NOT ${qualifyingOrder("o", "_ecommerce_referrals.reward_cents", options.minOrderCents)}))`);
  return statements;
}
async function reverseReferralForOrder(env, orderId, options = {}) {
  const policy = await getReferralPolicy(env);
  await runStatements(commerceDb(env), referralReversalStatements(orderId, {
    minOrderCents: policy.minOrderCents,
    now: Math.floor((options.now ?? /* @__PURE__ */ new Date()).getTime() / 1e3),
    disputeLost: options.disputeLost
  }));
}
async function releaseReferralAwards(options, run = {}) {
  const { env, paymentAdapters = [] } = options;
  const db = commerceDb(env);
  const now = Math.floor((run.now ?? /* @__PURE__ */ new Date()).getTime() / 1e3);
  const limit = Math.max(1, Math.min(50, Math.floor(run.limit ?? 10)));
  const policy = await getReferralPolicy(env);
  const due = await db.all(sql2`SELECT r.id, r.order_id AS orderId, r.reward_cents AS rewardCents
    FROM _ecommerce_referrals r
    WHERE r.status = 'approved' AND r.created_at <= ${now - policy.holdDays * DAY_SECONDS}
      AND NOT EXISTS (SELECT 1 FROM _ecommerce_credit_ledger l
        WHERE l.order_id = r.order_id AND l.kind = 'referral_award')
    ORDER BY r.updated_at, r.created_at LIMIT ${limit}`);
  const results = [];
  for (const row of due) {
    try {
      const order = await db.select().from(orders).where(eq(orders.id, row.orderId)).get();
      if (!order || !referralOrderQualifies(order, policy.minOrderCents, row.rewardCents)) {
        await runStatements(db, referralReversalStatements(row.orderId, { minOrderCents: policy.minOrderCents, now }));
        results.push({ id: row.id, status: "referral_void" });
        continue;
      }
      const provider = order.paymentProvider ?? "stripe";
      const adapter = paymentAdapters.find((candidate) => candidate.providerId === provider);
      const dispute = order.status === "disputed" ? "open" : adapter?.getDisputeStatus && order.paymentIntentId ? await adapter.getDisputeStatus(order.paymentIntentId) : provider === "stripe" ? "unknown" : "none";
      if (dispute === "lost") {
        await runStatements(db, referralReversalStatements(
          row.orderId,
          { minOrderCents: policy.minOrderCents, now, disputeLost: true }
        ));
        results.push({ id: row.id, status: "referral_void" });
        continue;
      }
      if (dispute !== "none") {
        await db.update(referrals).set({ updatedAt: new Date(now * 1e3) }).where(and(eq(referrals.id, row.id), eq(referrals.status, "approved")));
        results.push({ id: row.id, status: "referral_held" });
        continue;
      }
      await runStatements(db, [
        ["referral_award", "referrer_account_id", `credit_ref_${row.orderId}`],
        ["welcome_award", "referred_account_id", `credit_welcome_${row.orderId}`]
      ].map(([kind, account, id]) => sql2`INSERT INTO _ecommerce_credit_ledger
        (id, account_id, order_id, kind, amount_cents, created_at)
        SELECT ${id}, r.${sql2.raw(account)}, r.order_id, ${kind}, r.reward_cents, ${now}
        FROM _ecommerce_referrals r JOIN _ecommerce_orders o ON o.id = r.order_id
        WHERE r.id = ${row.id} AND r.status = 'approved' AND r.reward_cents > 0 AND ${qualifyingOrder("o", "r.reward_cents", policy.minOrderCents)}
          AND o.status <> 'disputed'
        ON CONFLICT DO NOTHING`));
      const released = await db.select({ id: creditLedger.id }).from(creditLedger).where(and(eq(creditLedger.orderId, row.orderId), eq(creditLedger.kind, "referral_award"))).get();
      const current = await db.select({ status: referrals.status }).from(referrals).where(eq(referrals.id, row.id)).get();
      results.push({ id: row.id, status: released ? "referral_released" : current?.status === "void" ? "referral_void" : "unchanged" });
    } catch (error) {
      results.push({ id: row.id, status: "error", error: error instanceof Error ? error.message : "Referral release failed" });
      await db.update(referrals).set({ updatedAt: new Date(now * 1e3) }).where(eq(referrals.id, row.id)).catch(() => void 0);
    }
  }
  return results;
}
function validReferralCode(code) {
  return typeof code === "string" && /^REF-[A-F0-9]{20}$/.test(code);
}
async function findReferralCode(env, code) {
  if (!validReferralCode(code)) return null;
  const db = commerceDb(env);
  const row = await db.select({
    code: referralCodes.code,
    accountId: referralCodes.accountId,
    emailNormalized: customerAccounts.emailNormalized
  }).from(referralCodes).innerJoin(customerAccounts, eq(referralCodes.accountId, customerAccounts.id)).where(and(eq(referralCodes.code, code), eq(referralCodes.active, true))).get();
  return row ?? null;
}
async function getOrCreateReferralCode(env, accountId) {
  const db = commerceDb(env);
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
  const db = commerceDb(env);
  const account = await db.select({ creditBalance: customerAccounts.creditBalance }).from(customerAccounts).where(eq(customerAccounts.id, accountId)).get();
  if (!account) throw new Error("Shopper account not found");
  const policy = await getReferralPolicy(env);
  const codeRow = await db.select({ code: referralCodes.code, active: referralCodes.active }).from(referralCodes).where(eq(referralCodes.accountId, accountId)).get();
  const code = codeRow?.code ?? (policy.enabled ? await getOrCreateReferralCode(env, accountId) : null);
  const codeActive = codeRow?.active ?? code !== null;
  const rows = await db.select({
    id: referrals.id,
    orderId: referrals.orderId,
    rewardCents: referrals.rewardCents,
    currency: referrals.currency,
    status: referrals.status,
    createdAt: referrals.createdAt,
    awardId: creditLedger.id
  }).from(referrals).leftJoin(creditLedger, and(eq(creditLedger.orderId, referrals.orderId), eq(creditLedger.kind, "referral_award"))).where(eq(referrals.referrerAccountId, accountId)).orderBy(desc(referrals.createdAt));
  const earned = rows.map(({ awardId, ...row }) => {
    const state = row.status === "void" ? "void" : awardId ? "released" : "pending";
    return { ...row, state, releasesAt: state === "pending" ? new Date(row.createdAt.getTime() + policy.holdDays * DAY_SECONDS * 1e3) : null };
  });
  const activity = await db.select({
    id: creditLedger.id,
    orderId: creditLedger.orderId,
    kind: creditLedger.kind,
    amountCents: creditLedger.amountCents,
    createdAt: creditLedger.createdAt
  }).from(creditLedger).where(eq(creditLedger.accountId, accountId)).orderBy(desc(creditLedger.createdAt)).limit(50);
  return { code, codeActive, creditBalance: account.creditBalance, earned, activity };
}

export {
  canonicalEmail,
  canonicalEmails,
  canonicalEmailSql,
  canonicalPurchase,
  hasCanonicalPurchase,
  REFERRAL_COOKIE,
  REFERRAL_COOKIE_MAX_AGE,
  REFERRAL_REWARD_CENTS,
  REFERRAL_MIN_ORDER_CENTS,
  REFERRAL_HOLD_DAYS,
  REFERRAL_MAX_PER_PERIOD,
  REFERRAL_PERIOD_DAYS,
  referralTermsError,
  referralPolicy,
  getReferralPolicy,
  referralNetAmount,
  referralOrderQualifies,
  referralReversalStatements,
  reverseReferralForOrder,
  releaseReferralAwards,
  validReferralCode,
  findReferralCode,
  getOrCreateReferralCode,
  getReferralDashboard
};
