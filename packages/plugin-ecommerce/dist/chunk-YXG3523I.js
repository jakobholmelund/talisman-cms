// src/adapters/stripe.ts
import Stripe from "stripe";
function checkoutCouponId(orderId) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(orderId)) throw new Error("Order id cannot name a checkout coupon");
  return `${orderId}_discount`;
}
var StripePaymentAdapter = class {
  providerId = "stripe";
  stripe;
  config;
  constructor(config) {
    this.config = config;
    this.stripe = new Stripe(config.secretKey, {
      apiVersion: "2026-08-26.dahlia",
      timeout: 15e3,
      maxNetworkRetries: 1,
      appInfo: {
        name: "Talisman CMS E-Commerce Plugin",
        version: "0.0.1"
      }
    });
  }
  async createCheckoutSession(params) {
    const lineItems = params.items.map((item) => ({
      price_data: {
        currency: "usd",
        product_data: {
          name: item.name,
          description: item.description
        },
        unit_amount: item.priceCents
      },
      quantity: item.quantity
    }));
    const totalDiscount = (params.creditApplied ?? 0) + (params.discountApplied ?? 0) + (params.giftCardApplied ?? 0);
    const expiresAt = Math.floor(Date.now() / 1e3) + 31 * 60;
    const coupon = totalDiscount ? await this.stripe.coupons.create({
      id: checkoutCouponId(params.orderId),
      amount_off: totalDiscount,
      currency: "usd",
      duration: "once",
      max_redemptions: 1,
      redeem_by: expiresAt,
      name: params.giftCardApplied ? "Gift card and checkout adjustments" : "Promotion and store credit"
    }, { idempotencyKey: `${params.orderId}:discount` }) : null;
    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      expires_at: expiresAt,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      customer_email: params.customerEmail,
      discounts: coupon ? [{ coupon: coupon.id }] : void 0,
      client_reference_id: params.orderId,
      metadata: {
        orderId: params.orderId,
        ...params.metadata
      }
    }, { idempotencyKey: params.orderId });
    if (!session.url) {
      throw new Error("Failed to create Stripe checkout session URL");
    }
    return {
      url: session.url,
      providerSessionId: session.id
    };
  }
  async validateWebhook(payload, signature, secret) {
    const webhookSecret = secret || this.config.webhookSecret;
    if (!webhookSecret) {
      throw new Error("Stripe webhook secret is not configured.");
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
        rawEvent: event
      };
    } catch (err) {
      throw new Error(`Webhook Error: ${err.message}`);
    }
  }
  async expireCheckoutSession(sessionId) {
    await this.stripe.checkout.sessions.expire(sessionId);
  }
  async discardCheckoutDiscount(orderId) {
    try {
      await this.stripe.coupons.del(checkoutCouponId(orderId));
    } catch (error) {
      if (error?.code === "resource_missing" || error?.statusCode === 404) return;
      throw error;
    }
  }
  async getCheckoutSession(sessionId) {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);
    return {
      status: session.status,
      url: session.url,
      paymentStatus: session.payment_status,
      amountTotal: session.amount_total,
      currency: session.currency,
      paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
      customerEmail: session.customer_details?.email ?? session.customer_email
    };
  }
  async getDisputeStatus(paymentIntentId) {
    const disputes = await this.stripe.disputes.list({ payment_intent: paymentIntentId, limit: 10 });
    if (disputes.data.some((dispute) => dispute.status === "lost")) return "lost";
    const settled = /* @__PURE__ */ new Set(["won", "prevented", "warning_closed"]);
    return disputes.data.some((dispute) => !settled.has(dispute.status)) ? "open" : "none";
  }
};

export {
  checkoutCouponId,
  StripePaymentAdapter
};
