import { ReferralPolicy } from './referrals.js';
import { TalismanEnv } from 'talisman-cms/client';
import { z } from 'zod';
import { discountCodes } from './schema.js';
import './payments-TQo6Ws_B.js';
import 'drizzle-orm';
import 'drizzle-orm/sqlite-core';

declare const discountCodeSchema: z.ZodEffects<z.ZodObject<{
    code: z.ZodString;
    description: z.ZodNullable<z.ZodString>;
    type: z.ZodEnum<["credit", "amount", "percent"]>;
    value: z.ZodNumber;
    maxDiscountCents: z.ZodNullable<z.ZodNumber>;
    minOrderCents: z.ZodNumber;
    eligibleProductIds: z.ZodArray<z.ZodString, "many">;
    maxUses: z.ZodNullable<z.ZodNumber>;
    maxUsesPerCustomer: z.ZodNullable<z.ZodNumber>;
    firstOrderOnly: z.ZodBoolean;
    startsAt: z.ZodNullable<z.ZodNumber>;
    expiresAt: z.ZodNullable<z.ZodNumber>;
    active: z.ZodBoolean;
}, "strict", z.ZodTypeAny, {
    description: string | null;
    type: "credit" | "amount" | "percent";
    value: number;
    code: string;
    maxDiscountCents: number | null;
    minOrderCents: number;
    eligibleProductIds: string[];
    maxUses: number | null;
    maxUsesPerCustomer: number | null;
    firstOrderOnly: boolean;
    startsAt: number | null;
    expiresAt: number | null;
    active: boolean;
}, {
    description: string | null;
    type: "credit" | "amount" | "percent";
    value: number;
    code: string;
    maxDiscountCents: number | null;
    minOrderCents: number;
    eligibleProductIds: string[];
    maxUses: number | null;
    maxUsesPerCustomer: number | null;
    firstOrderOnly: boolean;
    startsAt: number | null;
    expiresAt: number | null;
    active: boolean;
}>, {
    description: string | null;
    type: "credit" | "amount" | "percent";
    value: number;
    code: string;
    maxDiscountCents: number | null;
    minOrderCents: number;
    eligibleProductIds: string[];
    maxUses: number | null;
    maxUsesPerCustomer: number | null;
    firstOrderOnly: boolean;
    startsAt: number | null;
    expiresAt: number | null;
    active: boolean;
}, {
    description: string | null;
    type: "credit" | "amount" | "percent";
    value: number;
    code: string;
    maxDiscountCents: number | null;
    minOrderCents: number;
    eligibleProductIds: string[];
    maxUses: number | null;
    maxUsesPerCustomer: number | null;
    firstOrderOnly: boolean;
    startsAt: number | null;
    expiresAt: number | null;
    active: boolean;
}>;
type DiscountCodeInput = z.infer<typeof discountCodeSchema>;
declare const referralSettingsSchema: z.ZodEffects<z.ZodObject<{
    enabled: z.ZodBoolean;
    rewardCents: z.ZodNumber;
    minOrderCents: z.ZodNumber;
    attributionDays: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    minOrderCents: number;
    rewardCents: number;
    enabled: boolean;
    attributionDays: number;
}, {
    minOrderCents: number;
    rewardCents: number;
    enabled: boolean;
    attributionDays: number;
}>, {
    minOrderCents: number;
    rewardCents: number;
    enabled: boolean;
    attributionDays: number;
}, {
    minOrderCents: number;
    rewardCents: number;
    enabled: boolean;
    attributionDays: number;
}>;
declare function discountAmountForLines(code: Pick<typeof discountCodes.$inferSelect, 'type' | 'value' | 'remainingCents' | 'maxDiscountCents' | 'minOrderCents' | 'eligibleProductIds'>, lines: Array<{
    productId: string;
    quantity: number;
    priceAtPurchase: number;
}>, subtotal: number, currency: string): number;
/** Why a discount code was refused. The reason is for server-side use; shoppers see one message. */
type DiscountRefusalReason = 'format' | 'unknown' | 'inactive' | 'dates' | 'email_required' | 'first_order' | 'use_limit' | 'customer_limit' | 'not_applicable';
/** A discount code refused for this order. `message` is the detailed reason for admin tools and logs. */
declare class DiscountCodeRefusal extends Error {
    readonly reason: DiscountRefusalReason;
    constructor(reason: DiscountRefusalReason, message: string);
}
/** The one answer a shopper gets when an entered discount or gift card code is refused. */
declare const CODE_REFUSAL_MESSAGE = "This code is not valid for this order.";
/**
 * The shopper-facing body for an error that refuses an entered code, or null for any other error.
 * Every reason gets the same message, so the answer does not tell codes apart; the reason stays on
 * the error. A code used up between evaluation and reservation at checkout counts as refused too.
 */
declare function codeRefusalBody(error: unknown): {
    error: string;
    field: 'code' | 'giftCardCode';
} | null;
/**
 * Checks a discount code against a basket and returns the discount, or throws a DiscountCodeRefusal.
 * The shopper rules that need order history (first-order codes and per-customer limits) are checked
 * against the account when `accountId` is given, otherwise against `customerEmail`. With
 * `checkShopperHistory: false` they are skipped, for a guest preview that has no verified address;
 * checkout always checks them.
 */
declare function evaluateDiscountCode(env: TalismanEnv, input: {
    code: string;
    customerEmail: string;
    accountId?: string | null;
    lines: Array<{
        productId: string;
        quantity: number;
        priceAtPurchase: number;
    }>;
    subtotal: number;
    checkShopperHistory?: boolean;
}): Promise<{
    code: string;
    type: "credit" | "amount" | "percent";
    amount: number;
    emailNormalized: string;
    eligibleProductIds: string[];
}>;
declare function getPromotionsAdmin(env: TalismanEnv): Promise<{
    referral: ReferralPolicy;
    referralLinks: {
        code: string;
        active: boolean;
        email: string;
    }[];
    codes: {
        code: string;
        description: string | null;
        type: "credit" | "amount" | "percent";
        value: number;
        remainingCents: number | null;
        maxDiscountCents: number | null;
        minOrderCents: number;
        eligibleProductIds: string[];
        maxUses: number | null;
        maxUsesPerCustomer: number | null;
        firstOrderOnly: boolean;
        startsAt: Date | null;
        expiresAt: Date | null;
        active: boolean;
        createdAt: Date;
        updatedAt: Date;
    }[];
    usage: {
        code: string;
        status: "cancelled" | "refunded" | "reserved" | "confirmed";
        uses: number;
    }[];
}>;
declare function setReferralCodeActive(env: TalismanEnv, code: string, active: boolean): Promise<{
    code: string;
    active: boolean;
}>;
declare function saveReferralSettings(env: TalismanEnv, input: unknown): Promise<ReferralPolicy>;
declare function createDiscountCode(env: TalismanEnv, input: unknown): Promise<{
    code: string;
    description: string | null;
    type: "credit" | "amount" | "percent";
    value: number;
    remainingCents: number | null;
    maxDiscountCents: number | null;
    minOrderCents: number;
    eligibleProductIds: string[];
    maxUses: number | null;
    maxUsesPerCustomer: number | null;
    firstOrderOnly: boolean;
    startsAt: Date | null;
    expiresAt: Date | null;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
} | undefined>;
declare function updateDiscountCode(env: TalismanEnv, code: string, input: unknown): Promise<{
    code: string;
    description: string | null;
    type: "credit" | "amount" | "percent";
    value: number;
    remainingCents: number | null;
    maxDiscountCents: number | null;
    minOrderCents: number;
    eligibleProductIds: string[];
    maxUses: number | null;
    maxUsesPerCustomer: number | null;
    firstOrderOnly: boolean;
    startsAt: Date | null;
    expiresAt: Date | null;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
} | undefined>;

export { CODE_REFUSAL_MESSAGE, type DiscountCodeInput, DiscountCodeRefusal, type DiscountRefusalReason, codeRefusalBody, createDiscountCode, discountAmountForLines, discountCodeSchema, evaluateDiscountCode, getPromotionsAdmin, referralSettingsSchema, saveReferralSettings, setReferralCodeActive, updateDiscountCode };
