import { TalismanEnv } from 'talisman-cms/client';

declare const REFERRAL_COOKIE = "talisman-referral";
declare const REFERRAL_COOKIE_MAX_AGE: number;
declare const REFERRAL_REWARD_CENTS = 1000;
declare const REFERRAL_MIN_ORDER_CENTS = 5000;
/** A site can set both values as Worker vars; invalid values fall back to defaults. */
declare function referralPolicy(env: TalismanEnv): {
    enabled: boolean;
    rewardCents: number;
    minOrderCents: number;
    attributionDays: number;
};
declare function getReferralPolicy(env: TalismanEnv): Promise<{
    enabled: boolean;
    rewardCents: number;
    minOrderCents: number;
    attributionDays: number;
}>;
declare function validReferralCode(code: unknown): code is string;
declare function findReferralCode(env: TalismanEnv, code: unknown): Promise<{
    code: string;
    accountId: string;
    emailNormalized: string;
} | null>;
declare function getOrCreateReferralCode(env: TalismanEnv, accountId: string): Promise<string>;
declare function getReferralDashboard(env: TalismanEnv, accountId: string): Promise<{
    code: string;
    codeActive: boolean;
    creditBalance: number;
    earned: {
        id: string;
        orderId: string;
        rewardCents: number;
        currency: string;
        status: "approved" | "void";
        createdAt: Date;
    }[];
    activity: {
        id: string;
        orderId: string;
        kind: "referral_award" | "welcome_award" | "checkout_reserve" | "checkout_release" | "purchase_credit_refund" | "referral_reversal" | "welcome_reversal";
        amountCents: number;
        createdAt: Date;
    }[];
}>;

export { REFERRAL_COOKIE, REFERRAL_COOKIE_MAX_AGE, REFERRAL_MIN_ORDER_CENTS, REFERRAL_REWARD_CENTS, findReferralCode, getOrCreateReferralCode, getReferralDashboard, getReferralPolicy, referralPolicy, validReferralCode };
