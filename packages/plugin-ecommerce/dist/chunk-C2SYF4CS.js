import {
  TaxAddressError
} from "./chunk-BGDJXEM5.js";

// src/adapters/stripe.ts
import Stripe from "stripe";
function stripeTaxAddress(address) {
  const result = { country: address.country };
  const parts = {
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    postal_code: address.postalCode
  };
  for (const [key, value] of Object.entries(parts)) {
    if (typeof value === "string" && value.trim()) result[key] = value.trim();
  }
  return result;
}
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
        currency: params.currency,
        product_data: {
          name: item.name,
          description: item.description
        },
        unit_amount: item.priceCents
      },
      quantity: item.quantity
    }));
    if (params.shipping && params.shipping.amount > 0) {
      lineItems.push({
        price_data: {
          currency: params.currency,
          product_data: {
            name: params.shipping.label,
            description: params.shipping.description
          },
          unit_amount: params.shipping.amount
        },
        quantity: 1
      });
    }
    if (params.tax && params.tax.amount > 0) {
      lineItems.push({
        price_data: {
          currency: params.currency,
          product_data: { name: "Tax" },
          unit_amount: params.tax.amount
        },
        quantity: 1
      });
    }
    const totalDiscount = (params.creditApplied ?? 0) + (params.discountApplied ?? 0) + (params.giftCardApplied ?? 0);
    const expiresAt = Math.floor(Date.now() / 1e3) + 31 * 60;
    const coupon = totalDiscount ? await this.stripe.coupons.create({
      id: checkoutCouponId(params.orderId),
      amount_off: totalDiscount,
      currency: params.currency,
      duration: "once",
      max_redemptions: 1,
      redeem_by: expiresAt,
      name: params.giftCardApplied ? "Gift card and checkout adjustments" : "Promotion and store credit"
    }, { idempotencyKey: `${params.orderId}:discount` }) : null;
    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      // Confirmation and refunds compare the amount and currency with the order, so the buyer is
      // never shown another currency (Adaptive Pricing), whatever the account's dashboard setting.
      currency: params.currency,
      adaptive_pricing: { enabled: false },
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
  async calculateTax(params) {
    const input = {
      currency: params.currency,
      line_items: params.lines.map((line) => ({
        amount: line.amount,
        quantity: line.quantity,
        reference: line.reference,
        tax_behavior: params.behavior,
        ...line.taxCode ?? params.taxCode ? { tax_code: line.taxCode ?? params.taxCode ?? void 0 } : {}
      })),
      customer_details: { address: stripeTaxAddress(params.address), address_source: params.addressSource }
    };
    if (params.shippingAmount > 0) {
      input.shipping_cost = { amount: params.shippingAmount, tax_behavior: params.behavior };
    }
    if (params.shipFromCountry) input.ship_from_details = { address: { country: params.shipFromCountry } };
    let calculation;
    try {
      calculation = await this.stripe.tax.calculations.create(input);
    } catch (error) {
      if (error?.code === "customer_tax_location_invalid") {
        throw new TaxAddressError(void 0, { cause: error });
      }
      throw error;
    }
    if (!calculation.id) throw new Error("Stripe Tax returned a calculation without an id");
    return {
      id: calculation.id,
      amountTotal: calculation.amount_total,
      taxAmountExclusive: calculation.tax_amount_exclusive,
      taxAmountInclusive: calculation.tax_amount_inclusive
    };
  }
  async recordTaxTransaction(params) {
    const transaction = await this.stripe.tax.transactions.createFromCalculation({
      calculation: params.calculationId,
      reference: params.orderId,
      ...params.postedAt ? { posted_at: params.postedAt } : {}
    }, { idempotencyKey: `tax-transaction:${params.orderId}` });
    return { transactionId: transaction.id };
  }
  async reverseTaxTransaction(params) {
    const reversal = await this.stripe.tax.transactions.createReversal({
      mode: "partial",
      original_transaction: params.transactionId,
      reference: params.reference,
      flat_amount: -params.amount
    }, { idempotencyKey: params.reference });
    return { reversalId: reversal.id };
  }
};

export {
  checkoutCouponId,
  StripePaymentAdapter
};
