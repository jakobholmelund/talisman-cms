import { TalismanEnv } from 'talisman-cms/client';
import { P as PaymentProviderAdapter } from './payments-B8lp8sbe.js';
import { orders } from './schema.js';
import 'drizzle-orm';
import 'drizzle-orm/sqlite-core';

/**
 * The address that identifies one mailbox when shoppers are compared, or null when `email` has no
 * local part and domain. Lowercased and trimmed; a `+suffix` on the local part is dropped for every
 * domain; for gmail.com and googlemail.com dots in the local part are dropped too and the domain
 * becomes gmail.com. Only for comparisons: mail is always sent to the address the shopper gave.
 */
declare function canonicalEmail(email: string | null | undefined): string | null;

declare const REFERRAL_COOKIE = "talisman-referral";
declare const REFERRAL_COOKIE_MAX_AGE: number;
declare const REFERRAL_REWARD_CENTS = 1000;
declare const REFERRAL_MIN_ORDER_CENTS = 5000;
/** Days an award stays pending after payment, so returns and disputes can still reverse it. */
declare const REFERRAL_HOLD_DAYS = 30;
/** Referrals one referrer can have recorded within REFERRAL_PERIOD_DAYS. */
declare const REFERRAL_MAX_PER_PERIOD = 10;
declare const REFERRAL_PERIOD_DAYS = 30;
type ReferralPolicy = {
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
/** The reward is at most half the minimum order, so an award is always worth less than the order that earns it. */
declare function referralTermsError(terms: {
    rewardCents: number;
    minOrderCents: number;
}): "The reward must be at most half the minimum first order" | null;
/**
 * The policy from Worker settings alone. Referrals are off unless `TALISMAN_COMMERCE_REFERRALS_ENABLED`
 * is `true`. Invalid or blank numbers fall back to the defaults.
 */
declare function referralPolicy(env: TalismanEnv): ReferralPolicy;
/** Saved admin settings win over the Worker settings, in both directions; the limits always come from the Worker. */
declare function getReferralPolicy(env: TalismanEnv): Promise<ReferralPolicy>;
type QualifyingOrder = Pick<typeof orders.$inferSelect, 'status' | 'subtotalAmount' | 'discountAmount' | 'providerRefundedCents' | 'giftCardRefundedCents'>;
/**
 * What the shopper paid for the goods after promotions and refunds: the subtotal less the promotion
 * discount, provider refunds and gift card refunds. Store credit and gift card tender count as paid.
 */
declare function referralNetAmount(order: Omit<QualifyingOrder, 'status'>): number;
/**
 * An order keeps its referral while it is paid, not fully refunded, and its net amount reaches the
 * minimum and at least twice the award's reward. The reward is fixed at checkout, so terms lowered
 * later never let an award exceed half of what the order kept. The minimum counts up to what the
 * order qualified with at checkout (its subtotal less the discount), so a minimum raised later
 * never voids an award by itself; only a refund or a lost dispute does.
 */
declare function referralOrderQualifies(order: QualifyingOrder, minOrderCents: number, rewardCents?: number): boolean;
/**
 * Statements that void the order's referral and reverse any released awards, once for each award,
 * when the order no longer qualifies at `minOrderCents` and the award's reward, or a dispute was lost. Idempotent; they read
 * the order as it is when they run, so add them after the statements that change it.
 */
declare function referralReversalStatements(env: TalismanEnv, orderId: string, options: {
    minOrderCents: number;
    now: number;
    disputeLost?: boolean;
}): D1PreparedStatement[];
/** Void the order's referral and reverse released awards when it no longer qualifies or a dispute was lost. */
declare function reverseReferralForOrder(env: TalismanEnv, orderId: string, options?: {
    now?: Date;
    disputeLost?: boolean;
}): Promise<void>;
type ReferralReleaseResult = {
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
declare function releaseReferralAwards(options: {
    env: TalismanEnv;
    paymentAdapters?: PaymentProviderAdapter[];
}, run?: {
    now?: Date;
    limit?: number;
}): Promise<ReferralReleaseResult[]>;
declare function validReferralCode(code: unknown): code is string;
declare function findReferralCode(env: TalismanEnv, code: unknown): Promise<{
    code: string;
    accountId: string;
    emailNormalized: string;
} | null>;
declare function getOrCreateReferralCode(env: TalismanEnv, accountId: string): Promise<string>;
type ReferralDashboard = {
    /** The shopper's code; null while referrals are off and the shopper has none yet. */
    code: string | null;
    codeActive: boolean;
    /** Spendable ledger credit; pending awards are not included. */
    creditBalance: number;
    earned: Array<{
        id: string;
        orderId: string;
        rewardCents: number;
        currency: string;
        status: 'approved' | 'void';
        state: 'pending' | 'released' | 'void';
        createdAt: Date;
        /** When a pending award can be released at the earliest; null once released or void. */
        releasesAt: Date | null;
    }>;
    activity: Array<{
        id: string;
        orderId: string;
        kind: string;
        amountCents: number;
        createdAt: Date;
    }>;
};
declare function getReferralDashboard(env: TalismanEnv, accountId: string): Promise<ReferralDashboard>;

export { REFERRAL_COOKIE, REFERRAL_COOKIE_MAX_AGE, REFERRAL_HOLD_DAYS, REFERRAL_MAX_PER_PERIOD, REFERRAL_MIN_ORDER_CENTS, REFERRAL_PERIOD_DAYS, REFERRAL_REWARD_CENTS, type ReferralDashboard, type ReferralPolicy, type ReferralReleaseResult, canonicalEmail, findReferralCode, getOrCreateReferralCode, getReferralDashboard, getReferralPolicy, referralNetAmount, referralOrderQualifies, referralPolicy, referralReversalStatements, referralTermsError, releaseReferralAwards, reverseReferralForOrder, validReferralCode };
