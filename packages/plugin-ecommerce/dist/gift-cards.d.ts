import { TalismanEnv } from 'talisman-cms/client';
import { P as PaymentProviderAdapter } from './payments-9Bikdd3h.js';

declare function hashGiftCardSecret(value: string): Promise<string>;
declare function issueAdminGiftCard(env: TalismanEnv, actor: string, input: unknown): Promise<{
    id: string;
    code: string;
    amountCents: number;
    currency: string;
}>;
declare function getGiftCardsAdmin(env: TalismanEnv): Promise<{
    id: string;
    codeSuffix: string;
    source: "purchase" | "admin";
    purchaseId: string | null;
    adminActor: string | null;
    adminReason: string | null;
    initialCents: number;
    balanceCents: number;
    currency: string;
    status: "active" | "void" | "suspended";
    createdAt: Date;
}[]>;
declare function setGiftCardActive(env: TalismanEnv, id: string, active: boolean): Promise<{
    id: string;
    status: string;
}>;
declare function evaluateGiftCard(env: TalismanEnv, code: string, amountDue: number): Promise<{
    id: string;
    codeSuffix: string;
    amount: number;
    remainingCents: number;
}>;
declare function getGiftCardBalance(env: TalismanEnv, code: string): Promise<{
    balanceCents: number;
    currency: string;
    status: "active" | "void" | "suspended";
}>;
declare function startGiftCardPurchase(env: TalismanEnv, adapter: PaymentProviderAdapter, input: unknown, urls: {
    successUrl: string;
    cancelUrl: string;
}): Promise<{
    id: string;
    accessToken: string;
    paymentUrl: string;
}>;
declare function confirmGiftCardPurchase(env: TalismanEnv, session: {
    id: string;
    metadata?: {
        giftCardPurchaseId?: string;
    };
    client_reference_id?: string;
    amount_total?: number;
    currency?: string;
    payment_status?: string;
    payment_intent?: string;
}): Promise<{
    success: boolean;
    purchaseId: string;
    duplicate: boolean;
} | {
    success: boolean;
    purchaseId: string;
    duplicate?: undefined;
}>;
declare function expireGiftCardPurchase(env: TalismanEnv, id: string, sessionId: string): Promise<void>;
/** Repair a paid or expired purchase when its signed webhook did not arrive. */
declare function reconcileGiftCardPurchase(env: TalismanEnv, adapter: PaymentProviderAdapter, id: string): Promise<{
    status: string;
} | null>;
declare function getPurchasedGiftCard(env: TalismanEnv, id: string, accessToken: string | undefined): Promise<{
    status: "cancelled" | "refunded" | "pending" | "paid" | "partially_refunded" | "review";
    amountCents: number;
    code: string | null;
    balanceCents: number | null;
} | null>;
declare function recordGiftCardPurchaseRefund(env: TalismanEnv, params: {
    paymentIntentId: string;
    amount: number;
    amountRefunded: number;
    currency: string;
}): Promise<{
    success: boolean;
    duplicate: boolean;
    purchaseId?: undefined;
    status?: undefined;
} | {
    success: boolean;
    purchaseId: string;
    status: string;
    duplicate?: undefined;
} | null>;
/** Restore part of the gift-card tender while leaving a split-paid order open. */
declare function refundGiftCardTender(env: TalismanEnv, actor: string, input: unknown): Promise<{
    id: string;
    orderId: string;
    amountCents: number;
}>;
/** Refund a zero-provider gift-card order, including any promotional credit used with it. */
declare function refundGiftCardOnlyOrder(env: TalismanEnv, actor: string, input: unknown): Promise<{
    orderId: string;
    status: string;
}>;

export { confirmGiftCardPurchase, evaluateGiftCard, expireGiftCardPurchase, getGiftCardBalance, getGiftCardsAdmin, getPurchasedGiftCard, hashGiftCardSecret, issueAdminGiftCard, reconcileGiftCardPurchase, recordGiftCardPurchaseRefund, refundGiftCardOnlyOrder, refundGiftCardTender, setGiftCardActive, startGiftCardPurchase };
