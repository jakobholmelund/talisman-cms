import { TalismanEnv } from 'talisman-cms/client';
import { z } from 'zod';
import { discountCodes } from './schema.cjs';
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
    active: boolean;
    description: string | null;
    type: "amount" | "credit" | "percent";
    value: number;
    expiresAt: number | null;
    code: string;
    minOrderCents: number;
    maxDiscountCents: number | null;
    eligibleProductIds: string[];
    maxUses: number | null;
    maxUsesPerCustomer: number | null;
    firstOrderOnly: boolean;
    startsAt: number | null;
}, {
    active: boolean;
    description: string | null;
    type: "amount" | "credit" | "percent";
    value: number;
    expiresAt: number | null;
    code: string;
    minOrderCents: number;
    maxDiscountCents: number | null;
    eligibleProductIds: string[];
    maxUses: number | null;
    maxUsesPerCustomer: number | null;
    firstOrderOnly: boolean;
    startsAt: number | null;
}>, {
    active: boolean;
    description: string | null;
    type: "amount" | "credit" | "percent";
    value: number;
    expiresAt: number | null;
    code: string;
    minOrderCents: number;
    maxDiscountCents: number | null;
    eligibleProductIds: string[];
    maxUses: number | null;
    maxUsesPerCustomer: number | null;
    firstOrderOnly: boolean;
    startsAt: number | null;
}, {
    active: boolean;
    description: string | null;
    type: "amount" | "credit" | "percent";
    value: number;
    expiresAt: number | null;
    code: string;
    minOrderCents: number;
    maxDiscountCents: number | null;
    eligibleProductIds: string[];
    maxUses: number | null;
    maxUsesPerCustomer: number | null;
    firstOrderOnly: boolean;
    startsAt: number | null;
}>;
type DiscountCodeInput = z.infer<typeof discountCodeSchema>;
declare const referralSettingsSchema: z.ZodObject<{
    enabled: z.ZodBoolean;
    rewardCents: z.ZodNumber;
    minOrderCents: z.ZodNumber;
    attributionDays: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    rewardCents: number;
    enabled: boolean;
    minOrderCents: number;
    attributionDays: number;
}, {
    rewardCents: number;
    enabled: boolean;
    minOrderCents: number;
    attributionDays: number;
}>;
declare function discountAmountForLines(code: Pick<typeof discountCodes.$inferSelect, 'type' | 'value' | 'remainingCents' | 'maxDiscountCents' | 'minOrderCents' | 'eligibleProductIds'>, lines: Array<{
    productId: string;
    quantity: number;
    priceAtPurchase: number;
}>, subtotal: number): number;
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
}): Promise<{
    code: string;
    type: "amount" | "credit" | "percent";
    amount: number;
    emailNormalized: string;
}>;
declare function getPromotionsAdmin(env: TalismanEnv): Promise<{
    referral: {
        enabled: boolean;
        rewardCents: number;
        minOrderCents: number;
        attributionDays: number;
    };
    referralLinks: {
        code: string;
        active: boolean;
        email: string;
    }[];
    codes: {
        code: string;
        description: string | null;
        type: "amount" | "credit" | "percent";
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
        status: "reserved" | "confirmed" | "cancelled" | "refunded";
        uses: number;
    }[];
}>;
declare function setReferralCodeActive(env: TalismanEnv, code: string, active: boolean): Promise<{
    code: string;
    active: boolean;
}>;
declare function saveReferralSettings(env: TalismanEnv, input: unknown): Promise<{
    enabled: boolean;
    rewardCents: number;
    minOrderCents: number;
    attributionDays: number;
}>;
declare function createDiscountCode(env: TalismanEnv, input: unknown): Promise<{
    code: string;
    description: string | null;
    type: "amount" | "credit" | "percent";
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
    type: "amount" | "credit" | "percent";
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

export { type DiscountCodeInput, createDiscountCode, discountAmountForLines, discountCodeSchema, evaluateDiscountCode, getPromotionsAdmin, referralSettingsSchema, saveReferralSettings, setReferralCodeActive, updateDiscountCode };
