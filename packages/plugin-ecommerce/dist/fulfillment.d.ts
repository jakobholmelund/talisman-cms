import { TalismanEnv } from 'talisman-cms/client';

declare function listCommerceOrdersAdmin(env: TalismanEnv): Promise<{
    orders: {
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
    }[];
    fulfillments: {
        id: string;
        orderId: string;
        adminActor: string;
        carrier: string | null;
        trackingNumber: string | null;
        note: string;
        createdAt: Date;
    }[];
}>;
declare function fulfillCommerceOrder(env: TalismanEnv, actor: string, input: unknown): Promise<{
    fulfillmentId: string;
    orderId: string;
    status: string | undefined;
}>;

export { fulfillCommerceOrder, listCommerceOrdersAdmin };
