import { TalismanEnv } from 'talisman-cms/client';
import { P as PaymentProviderAdapter } from './payments-TQo6Ws_B.js';
import { C as CommerceEmailComposer } from './email-deliveries-CyzibTug.js';
import 'talisman-cms/email';
import './emails.js';

declare function hashGiftCardSecret(value: string): Promise<string>;
/**
 * Re-encrypts, with the current key, codes stored under a previous key or before key ids were
 * recorded, one page of up to `limit` cards per call. Pass the returned `next` as `after` until it is
 * null; when a fresh run finds nothing left, the previous keys can be removed. A code that no
 * configured key decrypts is listed in `failed` and left as it is. A Worker from a release before key
 * ids cannot show a code once it is re-encrypted.
 */
declare function reencryptGiftCardCodes(env: TalismanEnv, input?: unknown): Promise<{
    keyId: string;
    reencrypted: number;
    failed: string[];
    next: string | null;
}>;
/**
 * The current key's id; how many stored codes carry the id of another key; and how many are in the
 * format of releases before key ids, which the current key or a previous one reads. Null without a key.
 */
declare function getGiftCardKeyStatus(env: TalismanEnv): Promise<{
    keyId: string;
    previousKeyCodes: number;
    legacyCodes: number;
} | null>;
declare function issueAdminGiftCard(env: TalismanEnv, actor: string, input: unknown): Promise<{
    id: string;
    code: string;
    amountCents: number;
    currency: string;
    replacesPurchaseId: string | null;
}>;
declare function getGiftCardsAdmin(env: TalismanEnv): Promise<{
    id: string;
    codeSuffix: string;
    source: "purchase" | "admin";
    purchaseId: string | null;
    replacesPurchaseId: string | null;
    buyerEmail: string | null;
    adminActor: string | null;
    adminReason: string | null;
    initialCents: number;
    balanceCents: number;
    currency: string;
    status: "void" | "active" | "suspended";
    inReview: boolean;
    claimLink: {
        createdAt: string | null;
        expiresAt: string | null;
        usedAt: string | null;
        revokedAt: string | null;
        resent: boolean;
    } | null;
    claimEmail: {
        status: string;
        lastError: string | null;
        attempts: number;
    } | null;
    createdAt: Date;
}[]>;
/**
 * Purchases held for review after a provider refund, oldest first, with what is left on their cards.
 * Purchases held by an open payment dispute wait for its outcome and are left out.
 */
declare function getGiftCardReviewsAdmin(env: TalismanEnv): Promise<{
    reviews: {
        cardHeld: boolean;
        cardReplacement: boolean;
        purchaseId: string;
        status: string;
        amountCents: number;
        currency: string;
        refundedCents: number;
        adjustedCents: number;
        cardId: string | null;
        codeSuffix: string | null;
        cardStatus: "active" | "suspended" | null;
        balanceCents: number | null;
        spentCents: number;
        pendingCents: number;
        replacementCount: number;
    }[];
    reviewCount: number;
}>;
declare function setGiftCardActive(env: TalismanEnv, id: string, active: boolean): Promise<{
    id: string;
    status: string;
}>;
/** Why a gift card was refused. The reason is for server-side use; shoppers see one message. */
type GiftCardRefusalReason = 'format' | 'unavailable' | 'nothing_due' | 'cannot_cover' | 'currency';
/**
 * A gift card refused for this order, or in a store whose currency gift cards do not support.
 * `message` is the detailed reason for admin tools and logs.
 */
declare class GiftCardRefusal extends Error {
    readonly reason: GiftCardRefusalReason;
    constructor(reason: GiftCardRefusalReason, message: string);
}
/** Checks a gift card against the amount still due and returns what it pays, or throws a GiftCardRefusal. */
declare function evaluateGiftCard(env: TalismanEnv, code: string, amountDue: number): Promise<{
    id: string;
    codeSuffix: string;
    amount: number;
    remainingCents: number;
}>;
declare function getGiftCardBalance(env: TalismanEnv, code: string): Promise<{
    balanceCents: number;
    currency: string;
    status: "void" | "active" | "suspended";
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
/** A claim link works once, for 7 days. */
declare const GIFT_CARD_CLAIM_SECONDS: number;
/** Claim requests one client network (an IPv4 address or an IPv6 /64) may make per hour. */
declare const GIFT_CARD_CLAIMS_PER_NETWORK_PER_HOUR = 20;
/**
 * The email sent after a purchase is paid: a new one-time link, never the code. The link is made when
 * the email is sent and revoked if the send fails, so a retry sends a new one. A purchase whose card
 * is no longer active gets no link.
 */
declare const composeGiftCardClaimEmail: CommerceEmailComposer;
/**
 * Shows the code of the card a claim link was made for, once. The link must be unused, not revoked and
 * not expired, and its card active: a replacement voids the card it replaces, so links made before it
 * stop working. Of concurrent requests with one link, only one gets the code. Returns null for every
 * link that cannot be used.
 */
declare function claimGiftCardCode(env: TalismanEnv, token: unknown): Promise<{
    code: string;
    balanceCents: number;
    currency: string;
} | null>;
/**
 * Emails the buyer of a purchase a new claim link for the card that holds its value now, for example
 * after the first email was lost or a replacement card was issued. The new link records the
 * administrator and the reason. While the email is sent, the purchase's automatic claim email is held
 * with the lease a sending Worker takes, so the two are never sent at once; a resend is refused while
 * the automatic email is being sent. Only after the new email is sent do the links made before it stop
 * working and a claim email that was still waiting get cancelled. When the send fails, only the new
 * link is revoked: earlier links keep working, the automatic email keeps its retries, and the action
 * can be repeated.
 */
declare function resendGiftCardClaimLink(env: TalismanEnv, actor: string, input: unknown): Promise<{
    purchaseId: string;
    claimId: string;
    expiresAt: string;
}>;
declare function expireGiftCardPurchase(env: TalismanEnv, id: string, sessionId: string): Promise<void>;
/**
 * Repair a paid or expired purchase when its signed webhook did not arrive. A purchase parked for
 * review is returned as pending without asking Stripe. Failures that another attempt cannot change (a
 * session Stripe does not have, a session of the other Stripe mode, a completed payment that does not
 * match) throw a permanent ReconcileFailure, which reconcileCommerce parks.
 */
declare function reconcileGiftCardPurchase(env: TalismanEnv, adapter: PaymentProviderAdapter | undefined, id: string): Promise<{
    status: string;
    review: boolean;
} | {
    status: string;
    review?: undefined;
} | null>;
declare function getPurchasedGiftCard(env: TalismanEnv, id: string, accessToken: string | undefined): Promise<{
    status: "paid" | "pending" | "cancelled" | "review" | "partially_refunded" | "refunded";
    amountCents: number;
    code: string | null;
    balanceCents: number | null;
    paymentUnderReview: boolean;
} | null>;
/**
 * Statements that apply a purchase's review hold to every card it funds: the purchased card and the
 * replacements that took over its value. While the purchase is held for review, none of them can be
 * spent; the hold marks the cards it suspends, so reinstating the purchase reactivates only those. A
 * fully refunded purchase whose cards were never spent on an order is settled at once: what is left on
 * them is reversed and they are voided. A purchase with no card left to hold leaves review as refunded
 * or partially refunded. Add them to the batch that moves the purchase to 'review'.
 */
declare function giftCardPurchaseHoldStatements(env: TalismanEnv, purchaseId: string, timestamp: number): D1PreparedStatement[];
/**
 * Statements that lift a purchase's hold once it needs no decision: the cards the hold suspended become
 * active again, and a card an administrator suspended stays so. Add them after the statement that moves
 * the purchase out of review; while it is still held they change nothing.
 */
declare function giftCardPurchaseReleaseStatements(env: TalismanEnv, purchaseId: string, timestamp: number): D1PreparedStatement[];
/**
 * Statements for a purchase whose payment a lost dispute took back: every card it funds is voided and
 * what is left on them is reversed, and the purchase becomes refunded. Value already spent on orders
 * stays spent. While a checkout in progress holds value on the cards, nothing changes, like the review
 * 'void' outcome; add the hold statements first, so nothing more is spent meanwhile.
 */
declare function giftCardPurchaseChargebackStatements(env: TalismanEnv, purchaseId: string, timestamp: number): D1PreparedStatement[];
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
    status: "paid" | "pending" | "cancelled" | "review" | "partially_refunded" | "refunded";
    duplicate?: undefined;
} | null>;
/**
 * Resolves a purchase held for review after a provider refund. 'reinstate' takes the part of the
 * refund not yet taken off the purchase's cards off the card that holds its value, and lifts the hold:
 * the cards the hold suspended become active again, and a card an administrator suspended stays so.
 * 'void' voids the purchase's cards and reverses what is left on them; it waits while a checkout in
 * progress holds value on them. Either way the purchase becomes partially refunded or refunded by its
 * refund total, and _ecommerce_gift_card_reviews records who decided, why and the amounts.
 */
declare function resolveGiftCardReview(env: TalismanEnv, actor: string, input: unknown): Promise<{
    id: string;
    purchaseId: string;
    outcome: "void" | "reinstate";
    adjustmentCents: number;
    status: string;
}>;
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

export { GIFT_CARD_CLAIMS_PER_NETWORK_PER_HOUR, GIFT_CARD_CLAIM_SECONDS, GiftCardRefusal, type GiftCardRefusalReason, claimGiftCardCode, composeGiftCardClaimEmail, confirmGiftCardPurchase, evaluateGiftCard, expireGiftCardPurchase, getGiftCardBalance, getGiftCardKeyStatus, getGiftCardReviewsAdmin, getGiftCardsAdmin, getPurchasedGiftCard, giftCardPurchaseChargebackStatements, giftCardPurchaseHoldStatements, giftCardPurchaseReleaseStatements, hashGiftCardSecret, issueAdminGiftCard, reconcileGiftCardPurchase, recordGiftCardPurchaseRefund, reencryptGiftCardCodes, refundGiftCardOnlyOrder, refundGiftCardTender, resendGiftCardClaimLink, resolveGiftCardReview, setGiftCardActive, startGiftCardPurchase };
