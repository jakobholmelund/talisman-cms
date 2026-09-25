import Stripe from 'stripe';
import { P as PaymentProviderAdapter, V as ValidatedWebhookEvent } from '../payments-9Bikdd3h.js';

interface StripeAdapterConfig {
    secretKey: string;
    webhookSecret?: string;
}
declare class StripePaymentAdapter implements PaymentProviderAdapter {
    readonly providerId = "stripe";
    private stripe;
    private config;
    constructor(config: StripeAdapterConfig);
    createCheckoutSession(params: {
        orderId: string;
        items: Array<{
            name: string;
            description?: string;
            priceCents: number;
            quantity: number;
        }>;
        customerEmail?: string;
        successUrl: string;
        cancelUrl: string;
        metadata?: Record<string, string>;
        creditApplied?: number;
        discountApplied?: number;
        giftCardApplied?: number;
    }): Promise<{
        url: string;
        providerSessionId: string;
    }>;
    validateWebhook(payload: string, signature: string, secret?: string): Promise<ValidatedWebhookEvent>;
    expireCheckoutSession(sessionId: string): Promise<void>;
    getCheckoutSession(sessionId: string): Promise<{
        status: Stripe.Checkout.Session.Status | null;
        url: string | null;
        paymentStatus: Stripe.Checkout.Session.PaymentStatus;
        amountTotal: number | null;
        currency: string | null;
        paymentIntentId: string | null;
        customerEmail: string | null;
    }>;
}

export { type StripeAdapterConfig, StripePaymentAdapter };
