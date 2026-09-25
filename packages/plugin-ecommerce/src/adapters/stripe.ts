import Stripe from 'stripe';
import type { PaymentProviderAdapter, ValidatedWebhookEvent } from '../payments';

export interface StripeAdapterConfig {
  secretKey: string;
  webhookSecret?: string;
}

export class StripePaymentAdapter implements PaymentProviderAdapter {
  public readonly providerId = 'stripe';
  private stripe: Stripe;
  private config: StripeAdapterConfig;

  constructor(config: StripeAdapterConfig) {
    this.config = config;
    // Stripe >= v12 uses fetch by default in Edge environments
    this.stripe = new Stripe(config.secretKey, {
      apiVersion: '2026-08-26.dahlia',
      timeout: 15_000,
      maxNetworkRetries: 1,
      appInfo: {
        name: 'Talisman CMS E-Commerce Plugin',
        version: '0.0.1',
      },
    });
  }

  async createCheckoutSession(params: {
    orderId: string;
    items: Array<{ name: string; description?: string; priceCents: number; quantity: number }>;
    customerEmail?: string;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
    creditApplied?: number;
    discountApplied?: number;
    giftCardApplied?: number;
  }): Promise<{ url: string; providerSessionId: string }> {
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = params.items.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          description: item.description,
        },
        unit_amount: item.priceCents,
      },
      quantity: item.quantity,
    }));

    const totalDiscount = (params.creditApplied ?? 0) + (params.discountApplied ?? 0)
      + (params.giftCardApplied ?? 0);
    const coupon = totalDiscount ? await this.stripe.coupons.create({
      amount_off: totalDiscount,
      currency: 'usd',
      duration: 'once',
      name: params.giftCardApplied ? 'Gift card and checkout adjustments' : 'Promotion and store credit',
    }, { idempotencyKey: `${params.orderId}:discount` }) : null;

    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      customer_email: params.customerEmail,
      discounts: coupon ? [{ coupon: coupon.id }] : undefined,
      client_reference_id: params.orderId,
      metadata: {
        orderId: params.orderId,
        ...params.metadata,
      },
    }, { idempotencyKey: params.orderId });

    if (!session.url) {
      throw new Error('Failed to create Stripe checkout session URL');
    }

    return {
      url: session.url,
      providerSessionId: session.id,
    };
  }

  async validateWebhook(payload: string, signature: string, secret?: string): Promise<ValidatedWebhookEvent> {
    const webhookSecret = secret || this.config.webhookSecret;
    if (!webhookSecret) {
      throw new Error('Stripe webhook secret is not configured.');
    }

    try {
      const event = await this.stripe.webhooks.constructEventAsync(
        payload,
        signature,
        webhookSecret
      );

      return {
        type: event.type,
        data: event.data.object,
        rawEvent: event,
      };
    } catch (err: any) {
      throw new Error(`Webhook Error: ${err.message}`);
    }
  }

  async expireCheckoutSession(sessionId: string): Promise<void> {
    await this.stripe.checkout.sessions.expire(sessionId);
  }

  async getCheckoutSession(sessionId: string) {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);
    return {
      status: session.status,
      url: session.url,
      paymentStatus: session.payment_status,
      amountTotal: session.amount_total,
      currency: session.currency,
      paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
      customerEmail: session.customer_details?.email ?? session.customer_email,
    };
  }
}
