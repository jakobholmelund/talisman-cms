import * as astro_actions from 'astro:actions';
import { z } from 'astro/zod';

declare const ecommerceActions: {
    getCart: ((input?: any) => Promise<astro_actions.SafeResult<never, {
        success: boolean;
        cart: {
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
        } | null;
    }>>) & {
        orThrow: (input?: any) => Promise<{
            success: boolean;
            cart: {
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
            } | null;
        }>;
    } & string;
    addToCart: ((input: {
        productId: string;
        quantity?: number | undefined;
        variantId?: string | undefined;
    }) => Promise<astro_actions.SafeResult<{
        productId: string;
        quantity?: number | undefined;
        variantId?: string | undefined;
    }, {
        success: boolean;
        cart: {
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
        } | undefined;
    }>>) & {
        queryString: string;
        orThrow: (input: {
            productId: string;
            quantity?: number | undefined;
            variantId?: string | undefined;
        }) => Promise<{
            success: boolean;
            cart: {
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
            } | undefined;
        }>;
    } & {
        __internalInfer: z.ZodObject<{
            productId: z.ZodString;
            quantity: z.ZodDefault<z.ZodNumber>;
            variantId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    } & string;
    clearCart: ((input?: any) => Promise<astro_actions.SafeResult<never, {
        success: boolean;
        cart: {
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
        } | undefined;
    } | {
        success: boolean;
        cart: null;
    }>>) & {
        orThrow: (input?: any) => Promise<{
            success: boolean;
            cart: {
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
            } | undefined;
        } | {
            success: boolean;
            cart: null;
        }>;
    } & string;
    checkout: ((input: {
        customerEmail: string;
        discountCode?: string | undefined;
        giftCardCode?: string | undefined;
        shippingAddress?: {
            name?: string | undefined;
            line1?: string | undefined;
            line2?: string | undefined;
            city?: string | undefined;
            state?: string | undefined;
            postalCode?: string | undefined;
            country?: string | undefined;
        } | undefined;
        billingAddress?: {
            name?: string | undefined;
            line1?: string | undefined;
            line2?: string | undefined;
            city?: string | undefined;
            state?: string | undefined;
            postalCode?: string | undefined;
            country?: string | undefined;
        } | undefined;
        shippingRateId?: string | undefined;
    }) => Promise<astro_actions.SafeResult<{
        customerEmail: string;
        discountCode?: string | undefined;
        giftCardCode?: string | undefined;
        shippingAddress?: {
            name?: string | undefined;
            line1?: string | undefined;
            line2?: string | undefined;
            city?: string | undefined;
            state?: string | undefined;
            postalCode?: string | undefined;
            country?: string | undefined;
        } | undefined;
        billingAddress?: {
            name?: string | undefined;
            line1?: string | undefined;
            line2?: string | undefined;
            city?: string | undefined;
            state?: string | undefined;
            postalCode?: string | undefined;
            country?: string | undefined;
        } | undefined;
        shippingRateId?: string | undefined;
    }, {
        success: boolean;
        redirectUrl: string;
        mode: string;
        orderId: string;
    }>>) & {
        queryString: string;
        orThrow: (input: {
            customerEmail: string;
            discountCode?: string | undefined;
            giftCardCode?: string | undefined;
            shippingAddress?: {
                name?: string | undefined;
                line1?: string | undefined;
                line2?: string | undefined;
                city?: string | undefined;
                state?: string | undefined;
                postalCode?: string | undefined;
                country?: string | undefined;
            } | undefined;
            billingAddress?: {
                name?: string | undefined;
                line1?: string | undefined;
                line2?: string | undefined;
                city?: string | undefined;
                state?: string | undefined;
                postalCode?: string | undefined;
                country?: string | undefined;
            } | undefined;
            shippingRateId?: string | undefined;
        }) => Promise<{
            success: boolean;
            redirectUrl: string;
            mode: string;
            orderId: string;
        }>;
    } & {
        __internalInfer: z.ZodPipe<z.ZodCustom<{
            customerEmail: string;
            discountCode?: string | undefined;
            giftCardCode?: string | undefined;
            shippingAddress?: {
                name?: string | undefined;
                line1?: string | undefined;
                line2?: string | undefined;
                city?: string | undefined;
                state?: string | undefined;
                postalCode?: string | undefined;
                country?: string | undefined;
            } | undefined;
            billingAddress?: {
                name?: string | undefined;
                line1?: string | undefined;
                line2?: string | undefined;
                city?: string | undefined;
                state?: string | undefined;
                postalCode?: string | undefined;
                country?: string | undefined;
            } | undefined;
            shippingRateId?: string | undefined;
        }, {
            customerEmail: string;
            discountCode?: string | undefined;
            giftCardCode?: string | undefined;
            shippingAddress?: {
                name?: string | undefined;
                line1?: string | undefined;
                line2?: string | undefined;
                city?: string | undefined;
                state?: string | undefined;
                postalCode?: string | undefined;
                country?: string | undefined;
            } | undefined;
            billingAddress?: {
                name?: string | undefined;
                line1?: string | undefined;
                line2?: string | undefined;
                city?: string | undefined;
                state?: string | undefined;
                postalCode?: string | undefined;
                country?: string | undefined;
            } | undefined;
            shippingRateId?: string | undefined;
        }>, z.ZodTransform<{
            customerEmail: string;
            discountCode?: string | undefined;
            giftCardCode?: string | undefined;
            shippingAddress?: {
                name?: string | undefined;
                line1?: string | undefined;
                line2?: string | undefined;
                city?: string | undefined;
                state?: string | undefined;
                postalCode?: string | undefined;
                country?: string | undefined;
            } | undefined;
            billingAddress?: {
                name?: string | undefined;
                line1?: string | undefined;
                line2?: string | undefined;
                city?: string | undefined;
                state?: string | undefined;
                postalCode?: string | undefined;
                country?: string | undefined;
            } | undefined;
            shippingRateId?: string | undefined;
        }, {
            customerEmail: string;
            discountCode?: string | undefined;
            giftCardCode?: string | undefined;
            shippingAddress?: {
                name?: string | undefined;
                line1?: string | undefined;
                line2?: string | undefined;
                city?: string | undefined;
                state?: string | undefined;
                postalCode?: string | undefined;
                country?: string | undefined;
            } | undefined;
            billingAddress?: {
                name?: string | undefined;
                line1?: string | undefined;
                line2?: string | undefined;
                city?: string | undefined;
                state?: string | undefined;
                postalCode?: string | undefined;
                country?: string | undefined;
            } | undefined;
            shippingRateId?: string | undefined;
        }>>;
    } & string;
};

export { ecommerceActions };
