import { TalismanEnv } from 'talisman-cms/client';
import { P as PaymentProviderAdapter } from './payments-9Bikdd3h.js';

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
declare function aggregateComponentDemand(items: Array<{
    quantity: number;
    components: RequiredComponent[];
}>): Map<string, {
    name: string;
    quantity: number;
    available: number;
}>;
declare function bindCommerceApi(options: CommerceApiOptions): {
    carts: {
        quote(cartId: string): Promise<{
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
        find(sessionToken: string | undefined, userId?: string): Promise<{
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
        claim(sessionToken: string, userId: string, choice?: "browser" | "account"): Promise<{
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
        getOrCreate(sessionToken: string, userId?: string): Promise<{
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
        updateItems(cartId: string, items: Array<{
            productId: string;
            variantId?: string;
            quantity: number;
        }>): Promise<{
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
        resumeFromCart(cartId: string): Promise<{
            order: {
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
                status: string;
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
                createdAt: Date;
                updatedAt: Date;
            };
            paymentUrl: string | null;
        } | null>;
        reconcilePending(id: string): Promise<{
            status: string;
            paymentUrl: string | null;
        } | null>;
        createFromCart(cartId: string, options: {
            customerEmail: string;
            providerId?: string;
            shippingAddress?: any;
            billingAddress?: any;
            successUrl: string;
            cancelUrl: string;
            referralCode?: string;
            discountCode?: string;
            giftCardCode?: string;
        }): Promise<{
            order: {
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
                status: string;
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
                createdAt: Date;
                updatedAt: Date;
            };
            paymentUrl: string;
        }>;
        create(data: {
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
        }): Promise<{
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
            status: string;
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
            createdAt: Date;
            updatedAt: Date;
        } | null>;
        find(id: string): Promise<{
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
            status: string;
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
            createdAt: Date;
            updatedAt: Date;
        } | null>;
        findForSession(id: string, sessionToken: string | undefined, customerId?: string): Promise<{
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
            status: string;
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
            createdAt: Date;
            updatedAt: Date;
        } | null>;
        updateStatus(id: string, status: string, fulfillment?: {
            actor: string;
            carrier: string | null;
            trackingNumber: string | null;
            note: string;
        }): Promise<{
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
            status: string;
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
            createdAt: Date;
            updatedAt: Date;
        } | null>;
        finalizePayment(id: string, options: {
            provider: string;
            providerId: string;
            paymentIntentId?: string;
            paymentStatus?: string;
            amount?: number;
            currency?: string;
            customerEmail?: string;
        }): Promise<{
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
        cancel(id: string, options?: {
            sessionExpired?: boolean;
        }): Promise<{
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
            status: string;
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
            createdAt: Date;
            updatedAt: Date;
        } | null>;
    };
    webhooks: {
        handleStripe(payload: string, signature: string, secret?: string): Promise<{
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
            cancelled?: undefined;
        } | {
            success: boolean;
            event: string;
            ignored?: undefined;
            cancelled?: undefined;
        } | {
            success: boolean;
            event: string;
            cancelled: boolean;
            ignored?: undefined;
        }>;
    };
    inventory: {
        reserve(productId: string, variantId: string | undefined, quantity: number): Promise<{
            success: boolean;
            reserved: number;
            pessimistic: boolean;
        }>;
    };
};
/** Run from a protected admin request or a scheduled Worker to repair missed webhooks. */
declare function reconcileCommerce(options: CommerceApiOptions, limit?: number): Promise<{
    id: string;
    status: string;
    error?: string;
}[]>;

export { type CommerceApiOptions, aggregateComponentDemand, bindCommerceApi, reconcileCommerce };
