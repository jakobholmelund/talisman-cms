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
var __copyProps = (to, from, except, desc2) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc2 = __getOwnPropDesc(from, key)) || desc2.enumerable });
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

// src/routes/ecommerce-admin-promotions.ts
var ecommerce_admin_promotions_exports = {};
__export(ecommerce_admin_promotions_exports, {
  ALL: () => ALL
});
module.exports = __toCommonJS(ecommerce_admin_promotions_exports);
var import_guard = require("talisman-cms/auth/guard");

// src/promotions.ts
var import_drizzle_orm4 = require("drizzle-orm");
var import_client2 = require("talisman-cms/client");
var import_zod = require("zod");

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

// src/referrals.ts
var import_drizzle_orm3 = require("drizzle-orm");
var import_client = require("talisman-cms/client");
var REFERRAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
var REFERRAL_REWARD_CENTS = 1e3;
var REFERRAL_MIN_ORDER_CENTS = 5e3;
function referralPolicy(env) {
  const vars = env;
  const readCents = (value, fallback) => {
    const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1e5 ? parsed : fallback;
  };
  return {
    enabled: true,
    rewardCents: readCents(vars.GALAXY_COMMERCE_REFERRAL_REWARD_CENTS, REFERRAL_REWARD_CENTS),
    minOrderCents: readCents(vars.GALAXY_COMMERCE_REFERRAL_MIN_ORDER_CENTS, REFERRAL_MIN_ORDER_CENTS),
    attributionDays: 30
  };
}
async function getReferralPolicy(env) {
  const db = (0, import_client.createDbClient)(env);
  const saved = await db.select().from(referralSettings).where((0, import_drizzle_orm3.eq)(referralSettings.id, "default")).get();
  return saved ? {
    enabled: saved.enabled,
    rewardCents: saved.rewardCents,
    minOrderCents: saved.minOrderCents,
    attributionDays: saved.attributionDays
  } : referralPolicy(env);
}

// src/promotions.ts
var optionalLimit = import_zod.z.number().int().positive().max(1e6).nullable();
var optionalDate = import_zod.z.number().int().positive().nullable();
var discountCodeSchema = import_zod.z.object({
  code: import_zod.z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{2,31}$/),
  description: import_zod.z.string().trim().max(200).nullable(),
  type: import_zod.z.enum(["credit", "amount", "percent"]),
  value: import_zod.z.number().int().positive().max(1e6),
  maxDiscountCents: optionalLimit,
  minOrderCents: import_zod.z.number().int().min(0).max(1e7),
  eligibleProductIds: import_zod.z.array(import_zod.z.string().trim().min(1).max(128)).max(100),
  maxUses: optionalLimit,
  maxUsesPerCustomer: optionalLimit,
  firstOrderOnly: import_zod.z.boolean(),
  startsAt: optionalDate,
  expiresAt: optionalDate,
  active: import_zod.z.boolean()
}).strict().superRefine((value, ctx) => {
  if (value.type === "percent" && value.value > 1e4) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "Percent must be at most 100%" });
  }
  if (value.type === "credit" && !/^GC-[A-F0-9]{24}$/.test(value.code)) {
    ctx.addIssue({ code: "custom", path: ["code"], message: "Credit voucher codes must be generated securely" });
  }
  if (value.type !== "percent" && value.maxDiscountCents !== null) {
    ctx.addIssue({ code: "custom", path: ["maxDiscountCents"], message: "Only percent codes support a cap" });
  }
  if (value.startsAt && value.expiresAt && value.expiresAt <= value.startsAt) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Expiry must follow the start date" });
  }
  if (new Set(value.eligibleProductIds).size !== value.eligibleProductIds.length) {
    ctx.addIssue({ code: "custom", path: ["eligibleProductIds"], message: "Product IDs must be unique" });
  }
});
var referralSettingsSchema = import_zod.z.object({
  enabled: import_zod.z.boolean(),
  rewardCents: import_zod.z.number().int().min(1).max(1e5),
  minOrderCents: import_zod.z.number().int().min(1).max(1e7),
  attributionDays: import_zod.z.number().int().min(1).max(90)
}).strict();
async function getPromotionsAdmin(env) {
  const db = (0, import_client2.createDbClient)(env);
  const codes = await db.select().from(discountCodes).orderBy(discountCodes.createdAt);
  const usage = await db.select({
    code: discountRedemptions.code,
    status: discountRedemptions.status,
    uses: (0, import_drizzle_orm4.count)()
  }).from(discountRedemptions).groupBy(discountRedemptions.code, discountRedemptions.status);
  const referralLinks = await db.select({
    code: referralCodes.code,
    active: referralCodes.active,
    email: customerAccounts.email
  }).from(referralCodes).innerJoin(customerAccounts, (0, import_drizzle_orm4.eq)(referralCodes.accountId, customerAccounts.id));
  return { referral: await getReferralPolicy(env), referralLinks, codes, usage };
}
async function setReferralCodeActive(env, code, active) {
  if (!/^REF-[A-F0-9]{20}$/.test(code) || typeof active !== "boolean") {
    throw new Error("Invalid referral code status");
  }
  const db = (0, import_client2.createDbClient)(env);
  const changed = await db.update(referralCodes).set({ active }).where((0, import_drizzle_orm4.eq)(referralCodes.code, code)).returning({ code: referralCodes.code });
  if (!changed.length) throw new Error("Referral code not found");
  return { code, active };
}
async function saveReferralSettings(env, input) {
  const values = referralSettingsSchema.parse(input);
  const db = (0, import_client2.createDbClient)(env);
  await db.insert(referralSettings).values({ id: "default", ...values, updatedAt: /* @__PURE__ */ new Date() }).onConflictDoUpdate({ target: referralSettings.id, set: { ...values, updatedAt: /* @__PURE__ */ new Date() } });
  return getReferralPolicy(env);
}
async function createDiscountCode(env, input) {
  const raw = input && typeof input === "object" ? input : {};
  const generatedCode = raw.type === "credit" ? `GC-${Array.from(
    crypto.getRandomValues(new Uint8Array(12)),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("").toUpperCase()}` : raw.code;
  const values = discountCodeSchema.parse({ ...raw, code: generatedCode });
  const now = /* @__PURE__ */ new Date();
  const db = (0, import_client2.createDbClient)(env);
  await db.insert(discountCodes).values({
    ...values,
    remainingCents: values.type === "credit" ? values.value : null,
    startsAt: values.startsAt ? new Date(values.startsAt * 1e3) : null,
    expiresAt: values.expiresAt ? new Date(values.expiresAt * 1e3) : null,
    createdAt: now,
    updatedAt: now
  });
  return db.select().from(discountCodes).where((0, import_drizzle_orm4.eq)(discountCodes.code, values.code)).get();
}
async function updateDiscountCode(env, code, input) {
  const values = discountCodeSchema.parse({ ...input, code });
  const db = (0, import_client2.createDbClient)(env);
  const current = await db.select().from(discountCodes).where((0, import_drizzle_orm4.eq)(discountCodes.code, values.code)).get();
  if (!current) throw new Error("Discount code not found");
  if (current.type !== values.type) throw new Error("Discount code type cannot be changed");
  if (current.type !== values.type || current.value !== values.value || current.minOrderCents !== values.minOrderCents || current.maxDiscountCents !== values.maxDiscountCents || current.firstOrderOnly !== values.firstOrderOnly || JSON.stringify(current.eligibleProductIds) !== JSON.stringify(values.eligibleProductIds)) {
    throw new Error("Financial terms are fixed when a code is created; create a new code for new terms");
  }
  await db.update(discountCodes).set({
    description: values.description,
    type: values.type,
    value: values.value,
    maxDiscountCents: values.maxDiscountCents,
    minOrderCents: values.minOrderCents,
    eligibleProductIds: values.eligibleProductIds,
    maxUses: values.maxUses,
    maxUsesPerCustomer: values.maxUsesPerCustomer,
    firstOrderOnly: values.firstOrderOnly,
    startsAt: values.startsAt ? new Date(values.startsAt * 1e3) : null,
    expiresAt: values.expiresAt ? new Date(values.expiresAt * 1e3) : null,
    active: values.active,
    updatedAt: /* @__PURE__ */ new Date()
  }).where((0, import_drizzle_orm4.eq)(discountCodes.code, values.code));
  return db.select().from(discountCodes).where((0, import_drizzle_orm4.eq)(discountCodes.code, values.code)).get();
}

// src/routes/ecommerce-admin-promotions.ts
var ALL = async ({ request }) => {
  const authorization = await (0, import_guard.authorizeCmsRequest)(request, "admin");
  if (authorization.response) return authorization.response;
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "GET" && request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers });
  }
  if (request.method === "POST" && request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Same-origin request required" }, { status: 403, headers });
  }
  try {
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env;
    if (request.method === "GET") return Response.json(await getPromotionsAdmin(runtimeEnv), { headers });
    const body = await request.json();
    let result;
    if (body.action === "saveReferral") result = await saveReferralSettings(runtimeEnv, body.data);
    else if (body.action === "setReferralCodeActive" && typeof body.code === "string") {
      result = await setReferralCodeActive(
        runtimeEnv,
        body.code,
        body.data?.active
      );
    } else if (body.action === "createCode") result = await createDiscountCode(runtimeEnv, body.data);
    else if (body.action === "updateCode" && typeof body.code === "string") {
      result = await updateDiscountCode(runtimeEnv, body.code, body.data);
    } else return Response.json({ error: "Invalid promotion action" }, { status: 400, headers });
    return Response.json({ result }, { headers });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Promotion could not be saved" },
      { status: 400, headers }
    );
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ALL
});
