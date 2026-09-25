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
        } | null | undefined;
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
            } | null | undefined;
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
            [x: string]: unknown;
            name?: string | undefined;
            line1?: string | undefined;
            line2?: string | undefined;
            city?: string | undefined;
            state?: string | undefined;
            postalCode?: string | undefined;
            country?: string | undefined;
        } | undefined;
        billingAddress?: {
            [x: string]: unknown;
            name?: string | undefined;
            line1?: string | undefined;
            line2?: string | undefined;
            city?: string | undefined;
            state?: string | undefined;
            postalCode?: string | undefined;
            country?: string | undefined;
        } | undefined;
    }) => Promise<astro_actions.SafeResult<{
        customerEmail: string;
        discountCode?: string | undefined;
        giftCardCode?: string | undefined;
        shippingAddress?: {
            [x: string]: unknown;
            name?: string | undefined;
            line1?: string | undefined;
            line2?: string | undefined;
            city?: string | undefined;
            state?: string | undefined;
            postalCode?: string | undefined;
            country?: string | undefined;
        } | undefined;
        billingAddress?: {
            [x: string]: unknown;
            name?: string | undefined;
            line1?: string | undefined;
            line2?: string | undefined;
            city?: string | undefined;
            state?: string | undefined;
            postalCode?: string | undefined;
            country?: string | undefined;
        } | undefined;
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
                [x: string]: unknown;
                name?: string | undefined;
                line1?: string | undefined;
                line2?: string | undefined;
                city?: string | undefined;
                state?: string | undefined;
                postalCode?: string | undefined;
                country?: string | undefined;
            } | undefined;
            billingAddress?: {
                [x: string]: unknown;
                name?: string | undefined;
                line1?: string | undefined;
                line2?: string | undefined;
                city?: string | undefined;
                state?: string | undefined;
                postalCode?: string | undefined;
                country?: string | undefined;
            } | undefined;
        }) => Promise<{
            success: boolean;
            redirectUrl: string;
            mode: string;
            orderId: string;
        }>;
    } & {
        __internalInfer: z.ZodObject<{
            customerEmail: z.ZodString;
            discountCode: z.ZodOptional<z.ZodString>;
            giftCardCode: z.ZodOptional<z.ZodString>;
            shippingAddress: z.ZodOptional<z.ZodObject<{
                name: z.ZodOptional<z.ZodString>;
                line1: z.ZodOptional<z.ZodString>;
                line2: z.ZodOptional<z.ZodString>;
                city: z.ZodOptional<z.ZodString>;
                state: z.ZodOptional<z.ZodString>;
                postalCode: z.ZodOptional<z.ZodString>;
                country: z.ZodOptional<z.ZodString>;
            }, z.core.$loose>>;
            billingAddress: z.ZodOptional<z.ZodObject<{
                name: z.ZodOptional<z.ZodString>;
                line1: z.ZodOptional<z.ZodString>;
                line2: z.ZodOptional<z.ZodString>;
                city: z.ZodOptional<z.ZodString>;
                state: z.ZodOptional<z.ZodString>;
                postalCode: z.ZodOptional<z.ZodString>;
                country: z.ZodOptional<z.ZodString>;
            }, z.core.$loose>>;
        }, z.core.$strip>;
    } & string;
};

export { ecommerceActions };
