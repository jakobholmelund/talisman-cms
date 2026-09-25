"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/runtime.ts
var runtime_exports = {};
__export(runtime_exports, {
  runtimePaymentAdapters: () => runtimePaymentAdapters,
  runtimeStripeSecrets: () => runtimeStripeSecrets
});
module.exports = __toCommonJS(runtime_exports);

// src/adapters/stripe.ts
var import_stripe = __toESM(require("stripe"), 1);
var StripePaymentAdapter = class {
  providerId = "stripe";
  stripe;
  config;
  constructor(config) {
    this.config = config;
    this.stripe = new import_stripe.default(config.secretKey, {
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
    const coupon = totalDiscount ? await this.stripe.coupons.create({
      amount_off: totalDiscount,
      currency: "usd",
      duration: "once",
      name: params.giftCardApplied ? "Gift card and checkout adjustments" : "Promotion and store credit"
    }, { idempotencyKey: `${params.orderId}:discount` }) : null;
    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      expires_at: Math.floor(Date.now() / 1e3) + 30 * 60,
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
};

// src/adapters/admin-test.ts
var AdminTestPaymentAdapter = class {
  providerId = "admin_test";
  reservesInventory = false;
  async createCheckoutSession(params) {
    return {
      providerSessionId: `admin_test:${params.orderId}`,
      url: params.successUrl
    };
  }
  async expireCheckoutSession() {
  }
  async getCheckoutSession() {
    return { status: "open", url: null };
  }
};

// src/runtime.ts
function runtimeStripeSecrets(env) {
  const mode = env.GALAXY_COMMERCE_STRIPE_MODE === "live" ? "live" : "test";
  const localSecretKey = mode === "test" && typeof env.GALAXY_COMMERCE_LOCAL_STRIPE_SECRET_KEY === "string" ? env.GALAXY_COMMERCE_LOCAL_STRIPE_SECRET_KEY : "";
  const localWebhookSecret = mode === "test" && typeof env.GALAXY_COMMERCE_LOCAL_STRIPE_WEBHOOK_SECRET === "string" ? env.GALAXY_COMMERCE_LOCAL_STRIPE_WEBHOOK_SECRET : "";
  const secretKey = typeof env.STRIPE_SECRET_KEY === "string" && env.STRIPE_SECRET_KEY ? env.STRIPE_SECRET_KEY : localSecretKey;
  const webhookSecret = typeof env.STRIPE_WEBHOOK_SECRET === "string" && env.STRIPE_WEBHOOK_SECRET ? env.STRIPE_WEBHOOK_SECRET : localWebhookSecret;
  return { secretKey, webhookSecret, mode };
}
function runtimePaymentAdapters(env) {
  const { secretKey, webhookSecret, mode } = runtimeStripeSecrets(env);
  const adapters = [new AdminTestPaymentAdapter()];
  if (!secretKey.startsWith(`sk_${mode}_`) || !webhookSecret.startsWith("whsec_") || secretKey === "sk_test_mockkey") return adapters;
  return [new StripePaymentAdapter({ secretKey, webhookSecret }), ...adapters];
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  runtimePaymentAdapters,
  runtimeStripeSecrets
});
