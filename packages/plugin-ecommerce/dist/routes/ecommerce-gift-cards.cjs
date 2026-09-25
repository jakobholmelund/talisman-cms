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

// src/routes/ecommerce-gift-cards.ts
var ecommerce_gift_cards_exports = {};
__export(ecommerce_gift_cards_exports, {
  POST: () => POST
});
module.exports = __toCommonJS(ecommerce_gift_cards_exports);

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

// src/gift-cards.ts
var import_drizzle_orm3 = require("drizzle-orm");
var import_zod = require("zod");
var import_client = require("talisman-cms/client");

// src/schema.ts
var import_drizzle_orm = require("drizzle-orm");
var import_sqlite_core = require("drizzle-orm/sqlite-core");
var import_drizzle_orm2 = require("drizzle-orm");
var carts = (0, import_sqlite_core.sqliteTable)("_ecommerce_carts", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  // Usually mapped to a session generic ID
  sessionToken: (0, import_sqlite_core.text)("session_token").unique(),
  // For guest checkout
  userId: (0, import_sqlite_core.text)("user_id"),
  // Optional, references standard 'users' if logged in
  checkoutSessionId: (0, import_sqlite_core.text)("checkout_session_id").unique(),
  version: (0, import_sqlite_core.integer)("version").notNull().default(0),
  items: (0, import_sqlite_core.text)("items", { mode: "json" }).$type().notNull().default([]),
  closed: (0, import_sqlite_core.integer)("closed", { mode: "boolean" }).notNull().default(false),
  closedAt: (0, import_sqlite_core.integer)("closed_at", { mode: "timestamp" }),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var orders = (0, import_sqlite_core.sqliteTable)("_ecommerce_orders", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  cartId: (0, import_sqlite_core.text)("cart_id").references(() => carts.id).unique(),
  userId: (0, import_sqlite_core.text)("user_id"),
  // Optional, references standard 'users' if logged in
  checkoutSessionId: (0, import_sqlite_core.text)("checkout_session_id"),
  // e.g. Stripe Checkout Session ID
  paymentIntentId: (0, import_sqlite_core.text)("payment_intent_id").unique(),
  providerRefundedCents: (0, import_sqlite_core.integer)("provider_refunded_cents").notNull().default(0),
  paymentProvider: (0, import_sqlite_core.text)("payment_provider"),
  // e.g. stripe or admin_test
  referralCode: (0, import_sqlite_core.text)("referral_code"),
  referralRewardCents: (0, import_sqlite_core.integer)("referral_reward_cents").notNull().default(0),
  discountCode: (0, import_sqlite_core.text)("discount_code"),
  discountAmount: (0, import_sqlite_core.integer)("discount_amount").notNull().default(0),
  giftCardId: (0, import_sqlite_core.text)("gift_card_id"),
  giftCardApplied: (0, import_sqlite_core.integer)("gift_card_applied").notNull().default(0),
  giftCardRefundedCents: (0, import_sqlite_core.integer)("gift_card_refunded_cents").notNull().default(0),
  creditApplied: (0, import_sqlite_core.integer)("credit_applied").notNull().default(0),
  subtotalAmount: (0, import_sqlite_core.integer)("subtotal_amount").notNull().default(0),
  status: (0, import_sqlite_core.text)("status").notNull().default("draft"),
  // draft, pending, paid, fulfilled, cancelled
  items: (0, import_sqlite_core.text)("items", { mode: "json" }).$type().notNull().default([]),
  totalAmount: (0, import_sqlite_core.integer)("total_amount").notNull(),
  currency: (0, import_sqlite_core.text)("currency").notNull().default("usd"),
  customerEmail: (0, import_sqlite_core.text)("customer_email"),
  shippingAddress: (0, import_sqlite_core.text)("shipping_address", { mode: "json" }).$type(),
  billingAddress: (0, import_sqlite_core.text)("billing_address", { mode: "json" }).$type(),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var payments = (0, import_sqlite_core.sqliteTable)("_ecommerce_payments", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  orderId: (0, import_sqlite_core.text)("order_id").notNull().references(() => orders.id),
  provider: (0, import_sqlite_core.text)("provider").notNull(),
  // 'stripe', 'paypal'
  providerId: (0, import_sqlite_core.text)("provider_id").notNull(),
  // pi_12345
  status: (0, import_sqlite_core.text)("status").notNull(),
  amount: (0, import_sqlite_core.integer)("amount").notNull(),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull()
}, (table) => [(0, import_sqlite_core.uniqueIndex)("_ecommerce_payments_provider_id_unique").on(table.provider, table.providerId)]);
var products = (0, import_sqlite_core.sqliteTable)("_ecommerce_products", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  name: (0, import_sqlite_core.text)("name").notNull(),
  slug: (0, import_sqlite_core.text)("slug").notNull().unique(),
  sku: (0, import_sqlite_core.text)("sku"),
  description: (0, import_sqlite_core.text)("description"),
  images: (0, import_sqlite_core.text)("images", { mode: "json" }).$type().notNull().default([]),
  categoryIds: (0, import_sqlite_core.text)("category_ids", { mode: "json" }).$type().notNull().default([]),
  tagIds: (0, import_sqlite_core.text)("tag_ids", { mode: "json" }).$type().notNull().default([]),
  basePrice: (0, import_sqlite_core.integer)("base_price").notNull().default(0),
  // In smallest currency unit (cents)
  isPhysical: (0, import_sqlite_core.integer)("is_physical", { mode: "boolean" }).notNull().default(true),
  inventoryQuantity: (0, import_sqlite_core.integer)("inventory_quantity").notNull().default(0),
  type: (0, import_sqlite_core.text)("type").notNull().default("standard"),
  // standard, digital, subscription
  status: (0, import_sqlite_core.text)("status").notNull().default("draft"),
  // draft, active, archived
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var variants = (0, import_sqlite_core.sqliteTable)("_ecommerce_variants", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  name: (0, import_sqlite_core.text)("name").notNull().unique(),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var productVariants = (0, import_sqlite_core.sqliteTable)("_ecommerce_product_variants", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  productId: (0, import_sqlite_core.text)("product_id").notNull().references(() => products.id),
  variantId: (0, import_sqlite_core.text)("variant_id").references(() => variants.id),
  name: (0, import_sqlite_core.text)("name").notNull(),
  // e.g., 'Large / Blue'
  sku: (0, import_sqlite_core.text)("sku").unique(),
  priceOverride: (0, import_sqlite_core.integer)("price_override"),
  // Overrides basePrice if set
  inventoryQuantity: (0, import_sqlite_core.integer)("inventory_quantity").notNull().default(0),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var productVariantValues = (0, import_sqlite_core.sqliteTable)("_ecommerce_product_variant_values", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  productVariantId: (0, import_sqlite_core.text)("product_variant_id").notNull().references(() => productVariants.id),
  value: (0, import_sqlite_core.text)("value").notNull(),
  sku: (0, import_sqlite_core.text)("sku").unique(),
  image: (0, import_sqlite_core.text)("image"),
  priceOverride: (0, import_sqlite_core.integer)("price_override"),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var stocks = (0, import_sqlite_core.sqliteTable)("_ecommerce_stocks", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  productVariantValueId: (0, import_sqlite_core.text)("product_variant_value_id").notNull().references(() => productVariantValues.id).unique(),
  quantity: (0, import_sqlite_core.integer)("quantity").notNull().default(0),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var components = (0, import_sqlite_core.sqliteTable)("_ecommerce_components", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  sku: (0, import_sqlite_core.text)("sku").notNull().unique(),
  name: (0, import_sqlite_core.text)("name").notNull(),
  quantity: (0, import_sqlite_core.integer)("quantity").notNull().default(0),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
}, (table) => [(0, import_sqlite_core.check)("component_quantity_nonnegative", import_drizzle_orm2.sql`${table.quantity} >= 0`)]);
var variantComponents = (0, import_sqlite_core.sqliteTable)("_ecommerce_variant_components", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  productVariantValueId: (0, import_sqlite_core.text)("product_variant_value_id").notNull().references(() => productVariantValues.id),
  componentId: (0, import_sqlite_core.text)("component_id").notNull().references(() => components.id),
  quantity: (0, import_sqlite_core.integer)("quantity").notNull().default(1),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
}, (table) => [
  (0, import_sqlite_core.uniqueIndex)("variant_component_unique").on(table.productVariantValueId, table.componentId),
  (0, import_sqlite_core.check)("variant_component_quantity_positive", import_drizzle_orm2.sql`${table.quantity} > 0`)
]);
var componentReservations = (0, import_sqlite_core.sqliteTable)("_ecommerce_component_reservations", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  orderId: (0, import_sqlite_core.text)("order_id").notNull().references(() => orders.id),
  componentId: (0, import_sqlite_core.text)("component_id").notNull().references(() => components.id),
  quantity: (0, import_sqlite_core.integer)("quantity").notNull(),
  releasedAt: (0, import_sqlite_core.integer)("released_at", { mode: "timestamp" })
}, (table) => [
  (0, import_sqlite_core.uniqueIndex)("component_reservation_unique").on(table.orderId, table.componentId),
  (0, import_sqlite_core.check)("component_reservation_quantity_positive", import_drizzle_orm2.sql`${table.quantity} > 0`)
]);
var inventoryReservations = (0, import_sqlite_core.sqliteTable)("_ecommerce_inventory_reservations", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  orderId: (0, import_sqlite_core.text)("order_id").notNull().references(() => orders.id),
  targetType: (0, import_sqlite_core.text)("target_type").$type().notNull(),
  targetId: (0, import_sqlite_core.text)("target_id").notNull(),
  quantity: (0, import_sqlite_core.integer)("quantity").notNull(),
  releasedAt: (0, import_sqlite_core.integer)("released_at", { mode: "timestamp" })
}, (table) => [
  (0, import_sqlite_core.uniqueIndex)("inventory_reservation_unique").on(table.orderId, table.targetType, table.targetId),
  (0, import_sqlite_core.check)("inventory_reservation_quantity_positive", import_drizzle_orm2.sql`${table.quantity} > 0`)
]);
var categories = (0, import_sqlite_core.sqliteTable)("_ecommerce_categories", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  name: (0, import_sqlite_core.text)("name").notNull(),
  slug: (0, import_sqlite_core.text)("slug").notNull().unique(),
  description: (0, import_sqlite_core.text)("description"),
  image: (0, import_sqlite_core.text)("image"),
  parentId: (0, import_sqlite_core.text)("parent_id").references(() => categories.id),
  // Self-referencing for hierarchy
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var productCategories = (0, import_sqlite_core.sqliteTable)("_ecommerce_product_categories", {
  productId: (0, import_sqlite_core.text)("product_id").notNull().references(() => products.id),
  categoryId: (0, import_sqlite_core.text)("category_id").notNull().references(() => categories.id)
}, (table) => ({
  pk: (0, import_sqlite_core.primaryKey)({ columns: [table.productId, table.categoryId] })
}));
var tags = (0, import_sqlite_core.sqliteTable)("_ecommerce_tags", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  name: (0, import_sqlite_core.text)("name").notNull().unique(),
  color: (0, import_sqlite_core.text)("color").notNull().default("blue"),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var productTags = (0, import_sqlite_core.sqliteTable)("_ecommerce_product_tags", {
  productId: (0, import_sqlite_core.text)("product_id").notNull().references(() => products.id),
  tagId: (0, import_sqlite_core.text)("tag_id").notNull().references(() => tags.id)
}, (table) => ({
  pk: (0, import_sqlite_core.primaryKey)({ columns: [table.productId, table.tagId] })
}));
var customers = (0, import_sqlite_core.sqliteTable)("_ecommerce_customers", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  // A generic stripe-ready customer ID
  name: (0, import_sqlite_core.text)("name"),
  email: (0, import_sqlite_core.text)("email"),
  stripeCustomerId: (0, import_sqlite_core.text)("stripe_customer_id").unique(),
  userId: (0, import_sqlite_core.text)("user_id"),
  // Optional, references standard 'users' if logged in
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var customerAccounts = (0, import_sqlite_core.sqliteTable)("_ecommerce_customer_accounts", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  cmsUserId: (0, import_sqlite_core.text)("cms_user_id").unique(),
  email: (0, import_sqlite_core.text)("email").notNull(),
  emailNormalized: (0, import_sqlite_core.text)("email_normalized").notNull().unique(),
  emailVerifiedAt: (0, import_sqlite_core.integer)("email_verified_at", { mode: "timestamp" }),
  name: (0, import_sqlite_core.text)("name"),
  creditBalance: (0, import_sqlite_core.integer)("credit_balance").notNull().default(0),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var customerSessions = (0, import_sqlite_core.sqliteTable)("_ecommerce_customer_sessions", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  accountId: (0, import_sqlite_core.text)("account_id").notNull().references(() => customerAccounts.id, { onDelete: "cascade" }),
  orderId: (0, import_sqlite_core.text)("order_id").unique(),
  tokenHash: (0, import_sqlite_core.text)("token_hash").notNull().unique(),
  expiresAt: (0, import_sqlite_core.integer)("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  revokedAt: (0, import_sqlite_core.integer)("revoked_at", { mode: "timestamp" }),
  purpose: (0, import_sqlite_core.text)("purpose").$type().notNull().default("session")
});
var fulfillments = (0, import_sqlite_core.sqliteTable)("_ecommerce_fulfillments", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  orderId: (0, import_sqlite_core.text)("order_id").notNull().references(() => orders.id).unique(),
  adminActor: (0, import_sqlite_core.text)("admin_actor").notNull(),
  carrier: (0, import_sqlite_core.text)("carrier"),
  trackingNumber: (0, import_sqlite_core.text)("tracking_number"),
  note: (0, import_sqlite_core.text)("note").notNull(),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull()
});
var referralCodes = (0, import_sqlite_core.sqliteTable)("_ecommerce_referral_codes", {
  code: (0, import_sqlite_core.text)("code").primaryKey(),
  accountId: (0, import_sqlite_core.text)("account_id").notNull().references(() => customerAccounts.id, { onDelete: "cascade" }).unique(),
  active: (0, import_sqlite_core.integer)("active", { mode: "boolean" }).notNull().default(true),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull()
});
var referrals = (0, import_sqlite_core.sqliteTable)("_ecommerce_referrals", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  code: (0, import_sqlite_core.text)("code").notNull().references(() => referralCodes.code),
  referrerAccountId: (0, import_sqlite_core.text)("referrer_account_id").notNull().references(() => customerAccounts.id),
  referredAccountId: (0, import_sqlite_core.text)("referred_account_id").notNull().references(() => customerAccounts.id).unique(),
  orderId: (0, import_sqlite_core.text)("order_id").notNull().references(() => orders.id).unique(),
  rewardCents: (0, import_sqlite_core.integer)("reward_cents").notNull(),
  currency: (0, import_sqlite_core.text)("currency").notNull().default("usd"),
  status: (0, import_sqlite_core.text)("status").$type().notNull().default("approved"),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
}, (table) => [(0, import_sqlite_core.check)("referral_reward_nonnegative", import_drizzle_orm2.sql`${table.rewardCents} >= 0`)]);
var creditLedger = (0, import_sqlite_core.sqliteTable)("_ecommerce_credit_ledger", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  accountId: (0, import_sqlite_core.text)("account_id").notNull().references(() => customerAccounts.id),
  orderId: (0, import_sqlite_core.text)("order_id").notNull().references(() => orders.id),
  kind: (0, import_sqlite_core.text)("kind").$type().notNull(),
  amountCents: (0, import_sqlite_core.integer)("amount_cents").notNull(),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull()
}, (table) => [(0, import_sqlite_core.uniqueIndex)("credit_ledger_order_kind_unique").on(table.orderId, table.kind)]);
var referralSettings = (0, import_sqlite_core.sqliteTable)("_ecommerce_referral_settings", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  enabled: (0, import_sqlite_core.integer)("enabled", { mode: "boolean" }).notNull().default(true),
  rewardCents: (0, import_sqlite_core.integer)("reward_cents").notNull().default(1e3),
  minOrderCents: (0, import_sqlite_core.integer)("min_order_cents").notNull().default(5e3),
  attributionDays: (0, import_sqlite_core.integer)("attribution_days").notNull().default(30),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var discountCodes = (0, import_sqlite_core.sqliteTable)("_ecommerce_discount_codes", {
  code: (0, import_sqlite_core.text)("code").primaryKey(),
  description: (0, import_sqlite_core.text)("description"),
  type: (0, import_sqlite_core.text)("type").$type().notNull(),
  value: (0, import_sqlite_core.integer)("value").notNull(),
  // USD cents for credit/amount, basis points for percent.
  remainingCents: (0, import_sqlite_core.integer)("remaining_cents"),
  maxDiscountCents: (0, import_sqlite_core.integer)("max_discount_cents"),
  minOrderCents: (0, import_sqlite_core.integer)("min_order_cents").notNull().default(0),
  eligibleProductIds: (0, import_sqlite_core.text)("eligible_product_ids", { mode: "json" }).$type().notNull().default([]),
  maxUses: (0, import_sqlite_core.integer)("max_uses"),
  maxUsesPerCustomer: (0, import_sqlite_core.integer)("max_uses_per_customer"),
  firstOrderOnly: (0, import_sqlite_core.integer)("first_order_only", { mode: "boolean" }).notNull().default(false),
  startsAt: (0, import_sqlite_core.integer)("starts_at", { mode: "timestamp" }),
  expiresAt: (0, import_sqlite_core.integer)("expires_at", { mode: "timestamp" }),
  active: (0, import_sqlite_core.integer)("active", { mode: "boolean" }).notNull().default(true),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var discountRedemptions = (0, import_sqlite_core.sqliteTable)("_ecommerce_discount_redemptions", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  code: (0, import_sqlite_core.text)("code").notNull().references(() => discountCodes.code),
  orderId: (0, import_sqlite_core.text)("order_id").notNull().references(() => orders.id).unique(),
  accountId: (0, import_sqlite_core.text)("account_id").references(() => customerAccounts.id),
  emailNormalized: (0, import_sqlite_core.text)("email_normalized").notNull(),
  amountCents: (0, import_sqlite_core.integer)("amount_cents").notNull(),
  status: (0, import_sqlite_core.text)("status").$type().notNull().default("reserved"),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var giftCardPurchases = (0, import_sqlite_core.sqliteTable)("_ecommerce_gift_card_purchases", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  buyerEmail: (0, import_sqlite_core.text)("buyer_email").notNull(),
  amountCents: (0, import_sqlite_core.integer)("amount_cents").notNull(),
  currency: (0, import_sqlite_core.text)("currency").notNull().default("usd"),
  status: (0, import_sqlite_core.text)("status").$type().notNull().default("pending"),
  providerSessionId: (0, import_sqlite_core.text)("provider_session_id").unique(),
  paymentIntentId: (0, import_sqlite_core.text)("payment_intent_id").unique(),
  providerRefundedCents: (0, import_sqlite_core.integer)("provider_refunded_cents").notNull().default(0),
  accessTokenHash: (0, import_sqlite_core.text)("access_token_hash").notNull(),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var giftCards = (0, import_sqlite_core.sqliteTable)("_ecommerce_gift_cards", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  codeHash: (0, import_sqlite_core.text)("code_hash").notNull().unique(),
  codeSuffix: (0, import_sqlite_core.text)("code_suffix").notNull(),
  encryptedCode: (0, import_sqlite_core.text)("encrypted_code").notNull(),
  source: (0, import_sqlite_core.text)("source").$type().notNull(),
  purchaseId: (0, import_sqlite_core.text)("purchase_id").references(() => giftCardPurchases.id).unique(),
  adminActor: (0, import_sqlite_core.text)("admin_actor"),
  adminReason: (0, import_sqlite_core.text)("admin_reason"),
  initialCents: (0, import_sqlite_core.integer)("initial_cents").notNull(),
  balanceCents: (0, import_sqlite_core.integer)("balance_cents").notNull().default(0),
  currency: (0, import_sqlite_core.text)("currency").notNull().default("usd"),
  status: (0, import_sqlite_core.text)("status").$type().notNull().default("active"),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var giftCardLedger = (0, import_sqlite_core.sqliteTable)("_ecommerce_gift_card_ledger", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  cardId: (0, import_sqlite_core.text)("card_id").notNull().references(() => giftCards.id),
  orderId: (0, import_sqlite_core.text)("order_id").references(() => orders.id),
  purchaseId: (0, import_sqlite_core.text)("purchase_id").references(() => giftCardPurchases.id),
  kind: (0, import_sqlite_core.text)("kind").$type().notNull(),
  amountCents: (0, import_sqlite_core.integer)("amount_cents").notNull(),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull()
});
var giftCardRedemptions = (0, import_sqlite_core.sqliteTable)("_ecommerce_gift_card_redemptions", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  cardId: (0, import_sqlite_core.text)("card_id").notNull().references(() => giftCards.id),
  orderId: (0, import_sqlite_core.text)("order_id").notNull().references(() => orders.id).unique(),
  amountCents: (0, import_sqlite_core.integer)("amount_cents").notNull(),
  status: (0, import_sqlite_core.text)("status").$type().notNull().default("reserved"),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: (0, import_sqlite_core.integer)("updated_at", { mode: "timestamp" }).notNull()
});
var giftCardRefunds = (0, import_sqlite_core.sqliteTable)("_ecommerce_gift_card_refunds", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  cardId: (0, import_sqlite_core.text)("card_id").notNull().references(() => giftCards.id),
  orderId: (0, import_sqlite_core.text)("order_id").notNull().references(() => orders.id),
  amountCents: (0, import_sqlite_core.integer)("amount_cents").notNull(),
  adminActor: (0, import_sqlite_core.text)("admin_actor").notNull(),
  reason: (0, import_sqlite_core.text)("reason").notNull(),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull()
});
var giftCardOrderRefunds = (0, import_sqlite_core.sqliteTable)("_ecommerce_gift_card_order_refunds", {
  orderId: (0, import_sqlite_core.text)("order_id").primaryKey().references(() => orders.id),
  adminActor: (0, import_sqlite_core.text)("admin_actor").notNull(),
  reason: (0, import_sqlite_core.text)("reason").notNull(),
  createdAt: (0, import_sqlite_core.integer)("created_at", { mode: "timestamp" }).notNull()
});
var cartsRelations = (0, import_drizzle_orm.relations)(carts, ({ many }) => ({
  orders: many(orders)
}));
var ordersRelations = (0, import_drizzle_orm.relations)(orders, ({ one, many }) => ({
  cart: one(carts, {
    fields: [orders.cartId],
    references: [carts.id]
  }),
  payments: many(payments)
}));
var paymentsRelations = (0, import_drizzle_orm.relations)(payments, ({ one }) => ({
  order: one(orders, {
    fields: [payments.orderId],
    references: [orders.id]
  })
}));
var productsRelations = (0, import_drizzle_orm.relations)(products, ({ many }) => ({
  variants: many(productVariants),
  categories: many(productCategories),
  tags: many(productTags)
}));
var variantsRelations = (0, import_drizzle_orm.relations)(variants, ({ many }) => ({
  productVariants: many(productVariants)
}));
var productVariantsRelations = (0, import_drizzle_orm.relations)(productVariants, ({ one, many }) => ({
  product: one(products, {
    fields: [productVariants.productId],
    references: [products.id]
  }),
  variant: one(variants, {
    fields: [productVariants.variantId],
    references: [variants.id]
  }),
  values: many(productVariantValues)
}));
var productVariantValuesRelations = (0, import_drizzle_orm.relations)(productVariantValues, ({ one }) => ({
  productVariant: one(productVariants, {
    fields: [productVariantValues.productVariantId],
    references: [productVariants.id]
  }),
  stock: one(stocks, {
    fields: [productVariantValues.id],
    references: [stocks.productVariantValueId]
  })
}));
var stocksRelations = (0, import_drizzle_orm.relations)(stocks, ({ one }) => ({
  productVariantValue: one(productVariantValues, {
    fields: [stocks.productVariantValueId],
    references: [productVariantValues.id]
  })
}));
var tagsRelations = (0, import_drizzle_orm.relations)(tags, ({ many }) => ({
  products: many(productTags)
}));
var productTagsRelations = (0, import_drizzle_orm.relations)(productTags, ({ one }) => ({
  product: one(products, {
    fields: [productTags.productId],
    references: [products.id]
  }),
  tag: one(tags, {
    fields: [productTags.tagId],
    references: [tags.id]
  })
}));
var categoriesRelations = (0, import_drizzle_orm.relations)(categories, ({ one, many }) => ({
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
    relationName: "category_hierarchy"
  }),
  children: many(categories, {
    relationName: "category_hierarchy"
  }),
  products: many(productCategories)
}));
var productCategoriesRelations = (0, import_drizzle_orm.relations)(productCategories, ({ one }) => ({
  product: one(products, {
    fields: [productCategories.productId],
    references: [products.id]
  }),
  category: one(categories, {
    fields: [productCategories.categoryId],
    references: [categories.id]
  })
}));

// src/gift-cards.ts
var amountSchema = import_zod.z.number().int().min(500).max(1e5);
var purchaseSchema = import_zod.z.object({
  amountCents: amountSchema,
  buyerEmail: import_zod.z.string().trim().email().max(254)
}).strict();
var adminIssueSchema = import_zod.z.object({
  amountCents: amountSchema,
  reason: import_zod.z.string().trim().min(8).max(500)
}).strict();
var hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
var unhex = (value) => new Uint8Array(value.match(/.{2}/g)?.map((byte) => parseInt(byte, 16)) ?? []);
var randomHex = (bytes) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
var keyString = (env) => env.GALAXY_COMMERCE_GIFT_CARD_KEY;
async function encryptionKey(env) {
  const value = keyString(env);
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error("Gift card encryption key is not configured");
  }
  return crypto.subtle.importKey("raw", unhex(value), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function hashGiftCardSecret(value) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
async function getGiftCardBalance(env, code) {
  const normalized = code.trim().toUpperCase();
  if (!/^GIFT-[A-F0-9]{32}$/.test(normalized)) throw new Error("Invalid gift card code");
  const db = (0, import_client.createDbClient)(env);
  const card = await db.select({
    balanceCents: giftCards.balanceCents,
    currency: giftCards.currency,
    status: giftCards.status
  }).from(giftCards).where((0, import_drizzle_orm3.eq)(giftCards.codeHash, await hashGiftCardSecret(normalized))).get();
  if (!card) throw new Error("Gift card not found");
  return card;
}
async function startGiftCardPurchase(env, adapter, input, urls) {
  if (adapter.providerId !== "stripe") throw new Error("Gift card purchases require Stripe");
  await encryptionKey(env);
  const values = purchaseSchema.parse(input);
  const id = `gp_${crypto.randomUUID()}`;
  const accessToken = randomHex(32);
  const timestamp = Math.floor(Date.now() / 1e3);
  await env.DB.prepare(`INSERT INTO _ecommerce_gift_card_purchases
    (id,buyer_email,amount_cents,currency,status,access_token_hash,created_at,updated_at)
    VALUES (?,?,?,'usd','pending',?,?,?)`).bind(id, values.buyerEmail, values.amountCents, await hashGiftCardSecret(accessToken), timestamp, timestamp).run();
  let providerSessionId;
  try {
    const session = await adapter.createCheckoutSession({
      orderId: id,
      items: [{ name: "Talisman digital gift card", priceCents: values.amountCents, quantity: 1 }],
      customerEmail: values.buyerEmail,
      metadata: { giftCardPurchaseId: id },
      successUrl: urls.successUrl.replace("{PURCHASE_ID}", id),
      cancelUrl: urls.cancelUrl
    });
    providerSessionId = session.providerSessionId;
    await env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET provider_session_id = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`).bind(session.providerSessionId, timestamp, id).run();
    return { id, accessToken, paymentUrl: session.url };
  } catch (error) {
    if (providerSessionId) {
      try {
        await adapter.expireCheckoutSession?.(providerSessionId);
      } catch {
        await env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET provider_session_id = ?
          WHERE id = ? AND status = 'pending'`).bind(providerSessionId, id).run();
        throw error;
      }
    }
    await env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status = 'pending'`).bind(Math.floor(Date.now() / 1e3), id).run();
    throw error;
  }
}
var refundSchema = import_zod.z.object({
  orderId: import_zod.z.string().regex(/^ord_[0-9a-f-]{36}$/),
  reason: import_zod.z.string().trim().min(8).max(500),
  amountCents: import_zod.z.number().int().positive().optional()
}).strict();

// src/routes/ecommerce-gift-cards.ts
var POST = async ({ request, cookies }) => {
  const headers = { "Cache-Control": "no-store" };
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Same-origin request required" }, { status: 403, headers });
  }
  try {
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env;
    const body = await request.json();
    if (body && typeof body === "object" && body.action === "balance" && typeof body.code === "string") {
      return Response.json(await getGiftCardBalance(runtimeEnv, body.code), { headers });
    }
    if (runtimeEnv.GALAXY_COMMERCE_CHECKOUT_ENABLED !== "true" || runtimeEnv.GALAXY_COMMERCE_GIFT_CARDS_ENABLED !== "true") {
      return Response.json({ error: "Gift card purchases are unavailable" }, { status: 503, headers });
    }
    const adapter = runtimePaymentAdapters(runtimeEnv).find((provider) => provider.providerId === "stripe");
    if (!adapter) return Response.json({ error: "Stripe is not configured" }, { status: 503, headers });
    const origin = new URL(request.url).origin;
    const purchase = await startGiftCardPurchase(runtimeEnv, adapter, body, {
      successUrl: `${origin}/gift-cards/success?purchase={PURCHASE_ID}`,
      cancelUrl: `${origin}/gift-cards?cancelled=1`
    });
    cookies.set(`talisman-gift-${purchase.id}`, purchase.accessToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(request.url).protocol === "https:",
      path: "/gift-cards",
      maxAge: 7 * 24 * 60 * 60
    });
    return Response.json({ purchaseId: purchase.id, redirectUrl: purchase.paymentUrl }, { headers });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not start gift card purchase" },
      { status: 400, headers }
    );
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  POST
});
