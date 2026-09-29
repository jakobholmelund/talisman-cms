import { TalismanEnv } from 'talisman-cms/client';
import { P as PaymentProviderAdapter } from './payments-TQo6Ws_B.js';
import { a as CommerceEmailResult } from './email-deliveries-CyzibTug.js';
import 'talisman-cms/email';
import './emails.js';

/** Why a reconciliation attempt failed. Only these codes are stored, never provider text or personal data. */
type ReconcileFailureCode = 'session_missing' | 'session_mode_mismatch' | 'payment_mismatch' | 'provider_not_configured' | 'provider_unavailable' | 'provider_refused' | 'failed';
/** A reconciliation attempt that failed for a known reason. A permanent one parks the row. */
declare class ReconcileFailure extends Error {
    readonly name = "ReconcileFailure";
    readonly code: ReconcileFailureCode;
    constructor(code: ReconcileFailureCode, message?: string, options?: ErrorOptions);
    get permanent(): boolean;
}
/**
 * An administrator's retry or release of a parked record: who decided and why. It is kept in
 * _ecommerce_reconcile_decisions, in the batch that carries the decision out, under `id`.
 */
type ReconcileDecision = {
    id: string;
    actor: string;
    reason: string;
};
/** A reconciliation result as the scheduled Worker reads it: only `status: 'error'` is a failure. */
type ReconcileResult = {
    id: string;
    status: string;
    error?: string;
    code?: ReconcileFailureCode;
    /** Set on the one result of the attempt that parked the row for review. */
    parked?: true;
};

interface CommerceApiOptions {
    env: TalismanEnv;
    paymentAdapters?: PaymentProviderAdapter[];
}

type RequiredComponent = {
    id: string;
    name: string;
    quantity: number;
    available: number;
};
type CartItemInput = {
    productId: string;
    variantId?: string;
    quantity: number;
};
/** Most distinct lines one basket can hold. */
declare const CART_MAX_LINES = 50;
/** Most units of one line. Checkout still checks stock. */
declare const CART_MAX_LINE_QUANTITY = 99;
declare function aggregateComponentDemand(items: Array<{
    quantity: number;
    components: RequiredComponent[];
}>): Map<string, {
    name: string;
    quantity: number;
    available: number;
}>;

/** The answer to a shopper who asks about, or tries to release, a checkout parked for review. */
declare const PARKED_CHECKOUT_MESSAGE = "The store is reviewing the payment for this checkout. Contact the store to release it.";

/**
 * Run from a protected admin request or a scheduled Worker to repair missed webhooks. Each row is
 * attempted on its own: a failure is reported in its result and never stops the others.
 *
 * Pending orders and gift card purchases are taken in turn, rows never tried first, each once its
 * backoff since the last attempt has passed (2^attempts minutes, at most six hours), so a row that keeps
 * failing never holds back newer ones. Every attempt is recorded. A permanent failure (a session the
 * provider no longer has, a session of the other Stripe mode, a completed payment that does not match)
 * parks the row for an administrator: that attempt reports `error` with `parked: true`, and a parked row
 * is not selected again, so only new or transient failures are reported.
 *
 * Tax records and reversals back off the same way on counts of their own, and a success clears the
 * count. They are not parked: one that keeps failing is reported each time it is tried again.
 */
declare function reconcileCommerce(options: CommerceApiOptions, limit?: number): Promise<ReconcileResult[]>;

interface CommercePurgeOptions {
    env: TalismanEnv;
    now?: Date;
    /** Rows deleted per statement. */
    batchSize?: number;
}
/**
 * Delete shopper and sign-in data past its retention period. Run it from the scheduled
 * Worker next to reconcileCommerce; deletes are batched to stay inside D1 and Worker limits.
 * Every table is attempted, and the run throws afterwards if any of them failed.
 */
declare function purgeStaleCommerceData(options: CommercePurgeOptions): Promise<{
    carts: number;
    customerSessions: number;
    signInTokens: number;
    unverifiedAccounts: number;
    rateLimits: number;
    authSessions: number;
    authRateLimits: number;
}>;

/**
 * Retries the order confirmations, shipment notices and gift card claim emails that were not sent at
 * once, up to `limit` (default 10, at most 50) per run, oldest due first, and gives up emails that are
 * older than COMMERCE_EMAIL_MAX_AGE_SECONDS. reconcileCommerce runs it, so a site's scheduled Worker
 * retries them. Results carry `<kind>:<subject id>` and error codes, never an address; status 'error'
 * marks what needs an operator: email that is not configured (one result, id `commerce_emails`, for
 * each missing setting), a sender the provider refuses, an email given up after its last attempt or its
 * maximum age. 'email_retry' is retried later, and 'email_undeliverable' (a suppressed or invalid
 * address) and 'email_cancelled' are final.
 */
declare function deliverPendingCommerceEmails(options: {
    env: TalismanEnv;
}, { limit, now: at }?: {
    limit?: number;
    now?: number;
}): Promise<CommerceEmailResult[]>;

/** The answer when an order's slot is taken; it never says anything about the payment itself. */
declare const PROVIDER_CHECK_RETRY_MESSAGE = "The payment session was checked moments ago. Please try again in 15 seconds.";
/** A limited release found the order's slot taken; nothing was asked or changed. */
declare class ProviderCheckLimitedError extends Error {
    readonly name = "ProviderCheckLimitedError";
    constructor();
}

declare class TaxCalculationError extends Error {
    constructor(options?: ErrorOptions);
}

/**
 * How the webhook route answers a payment provider event that it could not apply. An event without
 * this store's references is answered 200 and changes nothing; these errors cover the rest.
 */
/** The event's signature or payload was refused. The webhook route answers 400. */
declare class WebhookSignatureError extends Error {
    readonly name = "WebhookSignatureError";
}
/**
 * The event names one of this store's orders or gift card purchases whose payment is not recorded
 * yet, for example a refund that arrives before the payment is confirmed. The webhook route answers
 * 409, so the provider delivers the event again later.
 */
declare class WebhookRetryLaterError extends Error {
    readonly name = "WebhookRetryLaterError";
}
/**
 * The event names one of this store's records but cannot be applied, and no retry will change that,
 * such as an amount or currency that does not match. The webhook logs it at error level and answers
 * 200 with `reason`, so the provider neither retries it for days nor disables the endpoint.
 */
declare class WebhookMismatchError extends Error {
    readonly name = "WebhookMismatchError";
    readonly reason: string;
    constructor(reason: string, message: string);
}

/**
 * The commerce API for a site's server code and the plugin's own routes, bound to the Worker's
 * bindings and payment adapters. Each method is a function of its module, called with the same
 * context: the basket in basket.ts, checkout in checkout.ts, orders and their payment in orders.ts
 * and the Stripe webhook in stripe-events.ts.
 */
declare function bindCommerceApi(options: CommerceApiOptions): {
    carts: {
        quote: (cartId: string) => Promise<{
            lines: {
                productId: string;
                variantId: string | undefined;
                name: string;
                quantity: number;
                unitAmount: number;
                lineTotal: number;
            }[];
            totalAmount: number;
            currency: string;
            requiresShipping: boolean;
            locked: boolean;
        }>;
        find: (sessionToken: string | undefined, userId?: string) => Promise<{
            id: string;
            sessionToken: string | null;
            userId: string | null;
            checkoutSessionId: string | null;
            version: number;
            items: {
                productId: string;
                variantId?: string;
                quantity: number;
            }[];
            closed: boolean;
            closedAt: Date | null;
            createdAt: Date;
            updatedAt: Date;
        } | null | undefined>;
        /** Attach the current browser basket to an authenticated shopper account. */
        claim: (sessionToken: string, userId: string, choice?: "browser" | "account") => Promise<{
            id: string;
            sessionToken: string | null;
            userId: string | null;
            checkoutSessionId: string | null;
            version: number;
            items: {
                productId: string;
                variantId?: string;
                quantity: number;
            }[];
            closed: boolean;
            closedAt: Date | null;
            createdAt: Date;
            updatedAt: Date;
        } | null | undefined>;
        getOrCreate: (sessionToken: string, userId?: string) => Promise<{
            id: string;
            sessionToken: string | null;
            userId: string | null;
            checkoutSessionId: string | null;
            version: number;
            items: {
                productId: string;
                variantId?: string;
                quantity: number;
            }[];
            closed: boolean;
            closedAt: Date | null;
            createdAt: Date;
            updatedAt: Date;
        } | null | undefined>;
        /**
         * Check an item list against the basket limits and the catalog without writing, for example
         * before creating a basket for it. Returns the list with only the stored fields.
         */
        validateItems: (items: unknown, current?: {
            productId: string;
            variantId?: string | null;
        }[]) => Promise<({
            productId: string;
            variantId: string;
            quantity: number;
        } | {
            productId: string;
            quantity: number;
            variantId?: undefined;
        })[]>;
        updateItems: (cartId: string, items: CartItemInput[]) => Promise<{
            id: string;
            sessionToken: string | null;
            userId: string | null;
            checkoutSessionId: string | null;
            version: number;
            items: {
                productId: string;
                variantId?: string;
                quantity: number;
            }[];
            closed: boolean;
            closedAt: Date | null;
            createdAt: Date;
            updatedAt: Date;
        } | undefined>;
    };
    orders: {
        resumeFromCart: (cartId: string, options?: {
            limitProviderChecks?: boolean;
        }) => Promise<{
            order: {
                createdAt: Date;
                updatedAt: Date;
                taxSyncAttempts: number;
                taxSyncLastAt: Date | null;
                taxSyncLastError: string | null;
                reconcileAttempts: number;
                reconcileLastAt: Date | null;
                reconcileLastError: string | null;
                reconcileReviewAt: Date | null;
                id: string;
                cartId: string | null;
                userId: string | null;
                checkoutSessionId: string | null;
                paymentIntentId: string | null;
                providerRefundedCents: number;
                paymentProvider: string | null;
                referralCode: string | null;
                referralRewardCents: number;
                discountCode: string | null;
                discountAmount: number;
                giftCardId: string | null;
                giftCardApplied: number;
                giftCardRefundedCents: number;
                creditApplied: number;
                subtotalAmount: number;
                shippingAmount: number;
                shippingRateId: string | null;
                shippingLabel: string | null;
                taxAmount: number;
                taxBehavior: "inclusive" | "exclusive" | null;
                taxCalculationId: string | null;
                taxTransactionId: string | null;
                status: string;
                fulfillmentStatus: "unfulfilled" | "partially_fulfilled" | "fulfilled";
                items: {
                    productId: string;
                    variantId?: string;
                    quantity: number;
                    priceAtPurchase: number;
                    usesComponents?: boolean;
                }[];
                totalAmount: number;
                currency: string;
                customerEmail: string | null;
                shippingAddress: {
                    name?: string;
                    line1?: string;
                    line2?: string;
                    city?: string;
                    state?: string;
                    postalCode?: string;
                    country?: string;
                } | null;
                billingAddress: {
                    name?: string;
                    line1?: string;
                    line2?: string;
                    city?: string;
                    state?: string;
                    postalCode?: string;
                    country?: string;
                } | null;
            };
            paymentUrl: null;
            review: boolean;
            providerCheckLimited?: undefined;
        } | {
            order: {
                createdAt: Date;
                updatedAt: Date;
                taxSyncAttempts: number;
                taxSyncLastAt: Date | null;
                taxSyncLastError: string | null;
                reconcileAttempts: number;
                reconcileLastAt: Date | null;
                reconcileLastError: string | null;
                reconcileReviewAt: Date | null;
                id: string;
                cartId: string | null;
                userId: string | null;
                checkoutSessionId: string | null;
                paymentIntentId: string | null;
                providerRefundedCents: number;
                paymentProvider: string | null;
                referralCode: string | null;
                referralRewardCents: number;
                discountCode: string | null;
                discountAmount: number;
                giftCardId: string | null;
                giftCardApplied: number;
                giftCardRefundedCents: number;
                creditApplied: number;
                subtotalAmount: number;
                shippingAmount: number;
                shippingRateId: string | null;
                shippingLabel: string | null;
                taxAmount: number;
                taxBehavior: "inclusive" | "exclusive" | null;
                taxCalculationId: string | null;
                taxTransactionId: string | null;
                status: string;
                fulfillmentStatus: "unfulfilled" | "partially_fulfilled" | "fulfilled";
                items: {
                    productId: string;
                    variantId?: string;
                    quantity: number;
                    priceAtPurchase: number;
                    usesComponents?: boolean;
                }[];
                totalAmount: number;
                currency: string;
                customerEmail: string | null;
                shippingAddress: {
                    name?: string;
                    line1?: string;
                    line2?: string;
                    city?: string;
                    state?: string;
                    postalCode?: string;
                    country?: string;
                } | null;
                billingAddress: {
                    name?: string;
                    line1?: string;
                    line2?: string;
                    city?: string;
                    state?: string;
                    postalCode?: string;
                    country?: string;
                } | null;
            };
            paymentUrl: null;
            providerCheckLimited: boolean;
            review?: undefined;
        } | {
            order: {
                createdAt: Date;
                updatedAt: Date;
                taxSyncAttempts: number;
                taxSyncLastAt: Date | null;
                taxSyncLastError: string | null;
                reconcileAttempts: number;
                reconcileLastAt: Date | null;
                reconcileLastError: string | null;
                reconcileReviewAt: Date | null;
                id: string;
                cartId: string | null;
                userId: string | null;
                checkoutSessionId: string | null;
                paymentIntentId: string | null;
                providerRefundedCents: number;
                paymentProvider: string | null;
                referralCode: string | null;
                referralRewardCents: number;
                discountCode: string | null;
                discountAmount: number;
                giftCardId: string | null;
                giftCardApplied: number;
                giftCardRefundedCents: number;
                creditApplied: number;
                subtotalAmount: number;
                shippingAmount: number;
                shippingRateId: string | null;
                shippingLabel: string | null;
                taxAmount: number;
                taxBehavior: "inclusive" | "exclusive" | null;
                taxCalculationId: string | null;
                taxTransactionId: string | null;
                status: string;
                fulfillmentStatus: "unfulfilled" | "partially_fulfilled" | "fulfilled";
                items: {
                    productId: string;
                    variantId?: string;
                    quantity: number;
                    priceAtPurchase: number;
                    usesComponents?: boolean;
                }[];
                totalAmount: number;
                currency: string;
                customerEmail: string | null;
                shippingAddress: {
                    name?: string;
                    line1?: string;
                    line2?: string;
                    city?: string;
                    state?: string;
                    postalCode?: string;
                    country?: string;
                } | null;
                billingAddress: {
                    name?: string;
                    line1?: string;
                    line2?: string;
                    city?: string;
                    state?: string;
                    postalCode?: string;
                    country?: string;
                } | null;
            };
            paymentUrl: string | null;
            review?: undefined;
            providerCheckLimited?: undefined;
        } | null>;
        reconcilePending: (id: string) => Promise<{
            status: string;
            paymentUrl: null;
            review: boolean;
        } | {
            status: string;
            paymentUrl: string | null;
            review?: undefined;
        } | null>;
        createFromCart: (cartId: string, options: {
            customerEmail: string;
            providerId?: string;
            shippingAddress?: any;
            billingAddress?: any;
            shippingRateId?: string;
            successUrl: string;
            cancelUrl: string;
            referralCode?: string;
            discountCode?: string;
            giftCardCode?: string;
        }) => Promise<{
            order: {
                createdAt: Date;
                updatedAt: Date;
                taxSyncAttempts: number;
                taxSyncLastAt: Date | null;
                taxSyncLastError: string | null;
                reconcileAttempts: number;
                reconcileLastAt: Date | null;
                reconcileLastError: string | null;
                reconcileReviewAt: Date | null;
                id: string;
                cartId: string | null;
                userId: string | null;
                checkoutSessionId: string | null;
                paymentIntentId: string | null;
                providerRefundedCents: number;
                paymentProvider: string | null;
                referralCode: string | null;
                referralRewardCents: number;
                discountCode: string | null;
                discountAmount: number;
                giftCardId: string | null;
                giftCardApplied: number;
                giftCardRefundedCents: number;
                creditApplied: number;
                subtotalAmount: number;
                shippingAmount: number;
                shippingRateId: string | null;
                shippingLabel: string | null;
                taxAmount: number;
                taxBehavior: "inclusive" | "exclusive" | null;
                taxCalculationId: string | null;
                taxTransactionId: string | null;
                status: string;
                fulfillmentStatus: "unfulfilled" | "partially_fulfilled" | "fulfilled";
                items: {
                    productId: string;
                    variantId?: string;
                    quantity: number;
                    priceAtPurchase: number;
                    usesComponents?: boolean;
                }[];
                totalAmount: number;
                currency: string;
                customerEmail: string | null;
                shippingAddress: {
                    name?: string;
                    line1?: string;
                    line2?: string;
                    city?: string;
                    state?: string;
                    postalCode?: string;
                    country?: string;
                } | null;
                billingAddress: {
                    name?: string;
                    line1?: string;
                    line2?: string;
                    city?: string;
                    state?: string;
                    postalCode?: string;
                    country?: string;
                } | null;
            };
            paymentUrl: string;
        }>;
        create: (data: {
            id?: string;
            cartId?: string;
            userId?: string;
            checkoutSessionId?: string;
            status?: string;
            totalAmount: number;
            currency?: string;
            customerEmail?: string;
            items: Array<{
                productId: string;
                variantId?: string;
                quantity: number;
                priceAtPurchase: number;
            }>;
            shippingAddress?: {
                name?: string;
                line1?: string;
                line2?: string;
                city?: string;
                state?: string;
                postalCode?: string;
                country?: string;
            };
            billingAddress?: {
                name?: string;
                line1?: string;
                line2?: string;
                city?: string;
                state?: string;
                postalCode?: string;
                country?: string;
            };
        }) => Promise<{
            createdAt: Date;
            updatedAt: Date;
            taxSyncAttempts: number;
            taxSyncLastAt: Date | null;
            taxSyncLastError: string | null;
            reconcileAttempts: number;
            reconcileLastAt: Date | null;
            reconcileLastError: string | null;
            reconcileReviewAt: Date | null;
            id: string;
            cartId: string | null;
            userId: string | null;
            checkoutSessionId: string | null;
            paymentIntentId: string | null;
            providerRefundedCents: number;
            paymentProvider: string | null;
            referralCode: string | null;
            referralRewardCents: number;
            discountCode: string | null;
            discountAmount: number;
            giftCardId: string | null;
            giftCardApplied: number;
            giftCardRefundedCents: number;
            creditApplied: number;
            subtotalAmount: number;
            shippingAmount: number;
            shippingRateId: string | null;
            shippingLabel: string | null;
            taxAmount: number;
            taxBehavior: "inclusive" | "exclusive" | null;
            taxCalculationId: string | null;
            taxTransactionId: string | null;
            status: string;
            fulfillmentStatus: "unfulfilled" | "partially_fulfilled" | "fulfilled";
            items: {
                productId: string;
                variantId?: string;
                quantity: number;
                priceAtPurchase: number;
                usesComponents?: boolean;
            }[];
            totalAmount: number;
            currency: string;
            customerEmail: string | null;
            shippingAddress: {
                name?: string;
                line1?: string;
                line2?: string;
                city?: string;
                state?: string;
                postalCode?: string;
                country?: string;
            } | null;
            billingAddress: {
                name?: string;
                line1?: string;
                line2?: string;
                city?: string;
                state?: string;
                postalCode?: string;
                country?: string;
            } | null;
        } | null>;
        find: (id: string) => Promise<{
            createdAt: Date;
            updatedAt: Date;
            taxSyncAttempts: number;
            taxSyncLastAt: Date | null;
            taxSyncLastError: string | null;
            reconcileAttempts: number;
            reconcileLastAt: Date | null;
            reconcileLastError: string | null;
            reconcileReviewAt: Date | null;
            id: string;
            cartId: string | null;
            userId: string | null;
            checkoutSessionId: string | null;
            paymentIntentId: string | null;
            providerRefundedCents: number;
            paymentProvider: string | null;
            referralCode: string | null;
            referralRewardCents: number;
            discountCode: string | null;
            discountAmount: number;
            giftCardId: string | null;
            giftCardApplied: number;
            giftCardRefundedCents: number;
            creditApplied: number;
            subtotalAmount: number;
            shippingAmount: number;
            shippingRateId: string | null;
            shippingLabel: string | null;
            taxAmount: number;
            taxBehavior: "inclusive" | "exclusive" | null;
            taxCalculationId: string | null;
            taxTransactionId: string | null;
            status: string;
            fulfillmentStatus: "unfulfilled" | "partially_fulfilled" | "fulfilled";
            items: {
                productId: string;
                variantId?: string;
                quantity: number;
                priceAtPurchase: number;
                usesComponents?: boolean;
            }[];
            totalAmount: number;
            currency: string;
            customerEmail: string | null;
            shippingAddress: {
                name?: string;
                line1?: string;
                line2?: string;
                city?: string;
                state?: string;
                postalCode?: string;
                country?: string;
            } | null;
            billingAddress: {
                name?: string;
                line1?: string;
                line2?: string;
                city?: string;
                state?: string;
                postalCode?: string;
                country?: string;
            } | null;
        } | null>;
        findForSession: (id: string, sessionToken: string | undefined, customerId?: string) => Promise<{
            createdAt: Date;
            updatedAt: Date;
            taxSyncAttempts: number;
            taxSyncLastAt: Date | null;
            taxSyncLastError: string | null;
            reconcileAttempts: number;
            reconcileLastAt: Date | null;
            reconcileLastError: string | null;
            reconcileReviewAt: Date | null;
            id: string;
            cartId: string | null;
            userId: string | null;
            checkoutSessionId: string | null;
            paymentIntentId: string | null;
            providerRefundedCents: number;
            paymentProvider: string | null;
            referralCode: string | null;
            referralRewardCents: number;
            discountCode: string | null;
            discountAmount: number;
            giftCardId: string | null;
            giftCardApplied: number;
            giftCardRefundedCents: number;
            creditApplied: number;
            subtotalAmount: number;
            shippingAmount: number;
            shippingRateId: string | null;
            shippingLabel: string | null;
            taxAmount: number;
            taxBehavior: "inclusive" | "exclusive" | null;
            taxCalculationId: string | null;
            taxTransactionId: string | null;
            status: string;
            fulfillmentStatus: "unfulfilled" | "partially_fulfilled" | "fulfilled";
            items: {
                productId: string;
                variantId?: string;
                quantity: number;
                priceAtPurchase: number;
                usesComponents?: boolean;
            }[];
            totalAmount: number;
            currency: string;
            customerEmail: string | null;
            shippingAddress: {
                name?: string;
                line1?: string;
                line2?: string;
                city?: string;
                state?: string;
                postalCode?: string;
                country?: string;
            } | null;
            billingAddress: {
                name?: string;
                line1?: string;
                line2?: string;
                city?: string;
                state?: string;
                postalCode?: string;
                country?: string;
            } | null;
        } | null>;
        updateStatus: (id: string, status: string, fulfillment?: {
            actor: string;
            carrier: string | null;
            trackingNumber: string | null;
            note: string;
        } | undefined) => Promise<{
            createdAt: Date;
            updatedAt: Date;
            taxSyncAttempts: number;
            taxSyncLastAt: Date | null;
            taxSyncLastError: string | null;
            reconcileAttempts: number;
            reconcileLastAt: Date | null;
            reconcileLastError: string | null;
            reconcileReviewAt: Date | null;
            id: string;
            cartId: string | null;
            userId: string | null;
            checkoutSessionId: string | null;
            paymentIntentId: string | null;
            providerRefundedCents: number;
            paymentProvider: string | null;
            referralCode: string | null;
            referralRewardCents: number;
            discountCode: string | null;
            discountAmount: number;
            giftCardId: string | null;
            giftCardApplied: number;
            giftCardRefundedCents: number;
            creditApplied: number;
            subtotalAmount: number;
            shippingAmount: number;
            shippingRateId: string | null;
            shippingLabel: string | null;
            taxAmount: number;
            taxBehavior: "inclusive" | "exclusive" | null;
            taxCalculationId: string | null;
            taxTransactionId: string | null;
            status: string;
            fulfillmentStatus: "unfulfilled" | "partially_fulfilled" | "fulfilled";
            items: {
                productId: string;
                variantId?: string;
                quantity: number;
                priceAtPurchase: number;
                usesComponents?: boolean;
            }[];
            totalAmount: number;
            currency: string;
            customerEmail: string | null;
            shippingAddress: {
                name?: string;
                line1?: string;
                line2?: string;
                city?: string;
                state?: string;
                postalCode?: string;
                country?: string;
            } | null;
            billingAddress: {
                name?: string;
                line1?: string;
                line2?: string;
                city?: string;
                state?: string;
                postalCode?: string;
                country?: string;
            } | null;
        } | null>;
        finalizePayment: (id: string, options: Omit<{
            orderId: string;
            provider: string;
            providerId: string;
            paymentIntentId?: string;
            paymentStatus?: string;
            amount?: number;
            currency?: string;
            customerEmail?: string;
        }, "orderId">) => Promise<{
            success: boolean;
            orderId: string;
            status: string;
            duplicate: boolean;
        } | {
            success: boolean;
            orderId: string;
            status: string;
            duplicate?: undefined;
        }>;
        cancel: (id: string, options?: {
            sessionExpired?: boolean;
            limitProviderChecks?: boolean;
            reviewRelease?: {
                decision: ReconcileDecision;
                confirmPaymentReturned?: boolean;
            };
        } | undefined) => Promise<{
            createdAt: Date;
            updatedAt: Date;
            taxSyncAttempts: number;
            taxSyncLastAt: Date | null;
            taxSyncLastError: string | null;
            reconcileAttempts: number;
            reconcileLastAt: Date | null;
            reconcileLastError: string | null;
            reconcileReviewAt: Date | null;
            id: string;
            cartId: string | null;
            userId: string | null;
            checkoutSessionId: string | null;
            paymentIntentId: string | null;
            providerRefundedCents: number;
            paymentProvider: string | null;
            referralCode: string | null;
            referralRewardCents: number;
            discountCode: string | null;
            discountAmount: number;
            giftCardId: string | null;
            giftCardApplied: number;
            giftCardRefundedCents: number;
            creditApplied: number;
            subtotalAmount: number;
            shippingAmount: number;
            shippingRateId: string | null;
            shippingLabel: string | null;
            taxAmount: number;
            taxBehavior: "inclusive" | "exclusive" | null;
            taxCalculationId: string | null;
            taxTransactionId: string | null;
            status: string;
            fulfillmentStatus: "unfulfilled" | "partially_fulfilled" | "fulfilled";
            items: {
                productId: string;
                variantId?: string;
                quantity: number;
                priceAtPurchase: number;
                usesComponents?: boolean;
            }[];
            totalAmount: number;
            currency: string;
            customerEmail: string | null;
            shippingAddress: {
                name?: string;
                line1?: string;
                line2?: string;
                city?: string;
                state?: string;
                postalCode?: string;
                country?: string;
            } | null;
            billingAddress: {
                name?: string;
                line1?: string;
                line2?: string;
                city?: string;
                state?: string;
                postalCode?: string;
                country?: string;
            } | null;
        } | null>;
    };
    webhooks: {
        handleStripe: (payload: string, signature: string, secret?: string) => Promise<{
            success: boolean;
            purchaseId: string;
            duplicate: boolean;
        } | {
            success: boolean;
            purchaseId: string;
            duplicate?: undefined;
        } | {
            success: boolean;
            duplicate: boolean;
            purchaseId?: undefined;
            status?: undefined;
        } | {
            success: boolean;
            orderId: string;
            status: string;
            duplicate: boolean;
        } | {
            success: boolean;
            orderId: string;
            status: string;
            duplicate?: undefined;
        } | {
            success: boolean;
            orderId: string;
            duplicate: boolean;
            status?: undefined;
        } | {
            success: boolean;
            event: string;
            ignored: boolean;
        } | {
            success: boolean;
            event: string;
            cancelled?: undefined;
        } | {
            success: boolean;
            event: string;
            cancelled: boolean;
        } | {
            success: boolean;
            event: string;
            ignored: boolean;
            reason: string;
        }>;
    };
};

export { CART_MAX_LINES, CART_MAX_LINE_QUANTITY, type CartItemInput, type CommerceApiOptions, type CommercePurgeOptions, PARKED_CHECKOUT_MESSAGE, PROVIDER_CHECK_RETRY_MESSAGE, ProviderCheckLimitedError, ReconcileFailure, type ReconcileFailureCode, type ReconcileResult, TaxCalculationError, WebhookMismatchError, WebhookRetryLaterError, WebhookSignatureError, aggregateComponentDemand, bindCommerceApi, deliverPendingCommerceEmails, purgeStaleCommerceData, reconcileCommerce };
