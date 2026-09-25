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
var __copyProps = (to, from, except, desc3) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc3 = __getOwnPropDesc(from, key)) || desc3.enumerable });
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

// src/routes/ecommerce-admin-reconcile.ts
var ecommerce_admin_reconcile_exports = {};
__export(ecommerce_admin_reconcile_exports, {
  POST: () => POST
});
module.exports = __toCommonJS(ecommerce_admin_reconcile_exports);
var import_guard = require("talisman-cms/auth/guard");

// src/api.ts
var import_client5 = require("talisman-cms/client");

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

// src/api.ts
var import_drizzle_orm7 = require("drizzle-orm");

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
function validReferralCode(code) {
  return typeof code === "string" && /^REF-[A-F0-9]{20}$/.test(code);
}
async function findReferralCode(env, code) {
  if (!validReferralCode(code)) return null;
  const db = (0, import_client.createDbClient)(env);
  const row = await db.select({
    code: referralCodes.code,
    accountId: referralCodes.accountId,
    emailNormalized: customerAccounts.emailNormalized
  }).from(referralCodes).innerJoin(customerAccounts, (0, import_drizzle_orm3.eq)(referralCodes.accountId, customerAccounts.id)).where((0, import_drizzle_orm3.and)((0, import_drizzle_orm3.eq)(referralCodes.code, code), (0, import_drizzle_orm3.eq)(referralCodes.active, true))).get();
  return row ?? null;
}

// src/promotions.ts
var import_drizzle_orm4 = require("drizzle-orm");
var import_client2 = require("talisman-cms/client");
var import_zod = require("zod");
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
function discountAmountForLines(code, lines, subtotal) {
  if (!Number.isSafeInteger(subtotal) || subtotal < code.minOrderCents) return 0;
  const eligible = code.eligibleProductIds.length ? lines.filter((line) => code.eligibleProductIds.includes(line.productId)) : lines;
  const eligibleSubtotal = eligible.reduce((sum, line) => sum + line.priceAtPurchase * line.quantity, 0);
  if (!Number.isSafeInteger(eligibleSubtotal) || eligibleSubtotal <= 0) return 0;
  const raw = code.type === "percent" ? Number(BigInt(eligibleSubtotal) * BigInt(code.value) / 10000n) : code.type === "credit" ? Math.min(code.remainingCents ?? 0, eligibleSubtotal) : Math.min(code.value, eligibleSubtotal);
  const capped = code.type === "percent" && code.maxDiscountCents !== null ? Math.min(raw, code.maxDiscountCents) : raw;
  return Math.max(0, Math.min(capped, subtotal - 50));
}
async function evaluateDiscountCode(env, input) {
  const normalizedCode = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(normalizedCode)) throw new Error("Invalid discount code");
  const db = (0, import_client2.createDbClient)(env);
  const code = await db.select().from(discountCodes).where((0, import_drizzle_orm4.eq)(discountCodes.code, normalizedCode)).get();
  if (!code || !code.active) throw new Error("Discount code is unavailable");
  const now = Date.now();
  if (code.startsAt && code.startsAt.getTime() > now || code.expiresAt && code.expiresAt.getTime() <= now) {
    throw new Error("Discount code is outside its active dates");
  }
  const account = input.accountId ? await db.select().from(customerAccounts).where((0, import_drizzle_orm4.eq)(customerAccounts.id, input.accountId)).get() : null;
  const emailNormalized = account?.emailNormalized ?? input.customerEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalized)) throw new Error("Valid email required for a discount");
  if (code.firstOrderOnly) {
    const known = account ?? await db.select({ id: customerAccounts.id }).from(customerAccounts).where((0, import_drizzle_orm4.eq)(customerAccounts.emailNormalized, emailNormalized)).get();
    if (known) throw new Error("Discount is for a first purchase only");
  }
  if (code.maxUses !== null) {
    const [{ uses }] = await db.select({ uses: (0, import_drizzle_orm4.count)() }).from(discountRedemptions).where((0, import_drizzle_orm4.and)(
      (0, import_drizzle_orm4.eq)(discountRedemptions.code, code.code),
      (0, import_drizzle_orm4.inArray)(discountRedemptions.status, ["reserved", "confirmed"])
    ));
    if (uses >= code.maxUses) throw new Error("Discount code has reached its use limit");
  }
  if (code.maxUsesPerCustomer !== null) {
    const [{ uses }] = await db.select({ uses: (0, import_drizzle_orm4.count)() }).from(discountRedemptions).where((0, import_drizzle_orm4.and)(
      (0, import_drizzle_orm4.eq)(discountRedemptions.code, code.code),
      (0, import_drizzle_orm4.eq)(discountRedemptions.emailNormalized, emailNormalized),
      (0, import_drizzle_orm4.inArray)(discountRedemptions.status, ["reserved", "confirmed"])
    ));
    if (uses >= code.maxUsesPerCustomer) throw new Error("Discount code was already used by this shopper");
  }
  const amount = discountAmountForLines(code, input.lines, input.subtotal);
  if (!amount) throw new Error("Discount code does not apply to this basket");
  return { code: code.code, type: code.type, amount, emailNormalized };
}

// src/fulfillment.ts
var import_drizzle_orm5 = require("drizzle-orm");
var import_zod2 = require("zod");
var import_client3 = require("talisman-cms/client");
var fulfillmentSchema = import_zod2.z.object({
  orderId: import_zod2.z.string().regex(/^ord_[0-9a-f-]{36}$/),
  carrier: import_zod2.z.string().trim().max(100).nullable(),
  trackingNumber: import_zod2.z.string().trim().max(150).nullable(),
  note: import_zod2.z.string().trim().min(8).max(500)
}).strict();
async function fulfillCommerceOrder(env, actor, input) {
  const values = fulfillmentSchema.parse(input);
  if (!actor.trim()) throw new Error("Administrator identity is required");
  const id = `ful_${crypto.randomUUID()}`;
  const db = (0, import_client3.createDbClient)(env);
  await db.insert(fulfillments).values({
    id,
    orderId: values.orderId,
    adminActor: actor,
    carrier: values.carrier,
    trackingNumber: values.trackingNumber,
    note: values.note,
    createdAt: /* @__PURE__ */ new Date()
  });
  const order = await db.select().from(orders).where((0, import_drizzle_orm5.eq)(orders.id, values.orderId)).get();
  return { fulfillmentId: id, orderId: values.orderId, status: order?.status };
}

// src/gift-cards.ts
var import_drizzle_orm6 = require("drizzle-orm");
var import_zod3 = require("zod");
var import_client4 = require("talisman-cms/client");
var amountSchema = import_zod3.z.number().int().min(500).max(1e5);
var purchaseSchema = import_zod3.z.object({
  amountCents: amountSchema,
  buyerEmail: import_zod3.z.string().trim().email().max(254)
}).strict();
var adminIssueSchema = import_zod3.z.object({
  amountCents: amountSchema,
  reason: import_zod3.z.string().trim().min(8).max(500)
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
async function newCardSecret(env) {
  const code = `GIFT-${randomHex(16).toUpperCase()}`;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    new TextEncoder().encode(code)
  );
  return {
    code,
    codeHash: await hashGiftCardSecret(code),
    codeSuffix: code.slice(-4),
    encryptedCode: `${hex(iv)}:${hex(new Uint8Array(ciphertext))}`
  };
}
async function evaluateGiftCard(env, code, amountDue) {
  const normalized = code.trim().toUpperCase();
  if (!/^GIFT-[A-F0-9]{32}$/.test(normalized)) throw new Error("Invalid gift card code");
  const db = (0, import_client4.createDbClient)(env);
  const card = await db.select().from(giftCards).where((0, import_drizzle_orm6.eq)(giftCards.codeHash, await hashGiftCardSecret(normalized))).get();
  if (!card || card.status !== "active" || card.currency !== "usd" || card.balanceCents <= 0) {
    throw new Error("Gift card is unavailable");
  }
  if (!Number.isSafeInteger(amountDue) || amountDue <= 0) throw new Error("No balance remains to pay");
  const amount = card.balanceCents >= amountDue ? amountDue : Math.min(card.balanceCents, Math.max(0, amountDue - 50));
  if (amount <= 0) throw new Error("Gift card cannot cover this order or a valid split payment");
  return { id: card.id, codeSuffix: card.codeSuffix, amount, remainingCents: card.balanceCents };
}
async function confirmGiftCardPurchase(env, session) {
  const id = session.metadata?.giftCardPurchaseId;
  if (!id) throw new Error("Gift card purchase ID is missing");
  const db = (0, import_client4.createDbClient)(env);
  const purchase = await db.select().from(giftCardPurchases).where((0, import_drizzle_orm6.eq)(giftCardPurchases.id, id)).get();
  if (!purchase || purchase.providerSessionId !== session.id || purchase.amountCents !== session.amount_total || session.currency?.toLowerCase() !== "usd" || session.payment_status !== "paid" || typeof session.payment_intent !== "string") {
    throw new Error("Gift card payment does not match purchase");
  }
  if (purchase.status === "paid") return { success: true, purchaseId: id, duplicate: true };
  if (purchase.status !== "pending") throw new Error("Gift card purchase is no longer pending");
  const secret = await newCardSecret(env);
  const cardId = `gift_${crypto.randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1e3);
  await env.DB.batch([
    env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases
      SET status = 'paid',payment_intent_id = ?,updated_at = ?
      WHERE id = ? AND status = 'pending' AND provider_session_id = ?`).bind(session.payment_intent, timestamp, id, session.id),
    env.DB.prepare(`INSERT INTO _ecommerce_gift_cards
      (id,code_hash,code_suffix,encrypted_code,source,purchase_id,initial_cents,balance_cents,currency,status,created_at,updated_at)
      SELECT ?,?,?,?,'purchase',id,amount_cents,0,'usd','active',?,?
      FROM _ecommerce_gift_card_purchases WHERE id = ? AND status = 'paid'
      ON CONFLICT(purchase_id) DO NOTHING`).bind(cardId, secret.codeHash, secret.codeSuffix, secret.encryptedCode, timestamp, timestamp, id),
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_issue_' || id,id,purchase_id,'issue',initial_cents,?
      FROM _ecommerce_gift_cards WHERE purchase_id = ? ON CONFLICT(id) DO NOTHING`).bind(timestamp, id)
  ]);
  return { success: true, purchaseId: id };
}
async function expireGiftCardPurchase(env, id, sessionId) {
  await env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = 'cancelled',updated_at = ?
    WHERE id = ? AND provider_session_id = ? AND status = 'pending'`).bind(Math.floor(Date.now() / 1e3), id, sessionId).run();
}
async function reconcileGiftCardPurchase(env, adapter, id) {
  if (adapter.providerId !== "stripe" || !adapter.getCheckoutSession) {
    throw new Error("Stripe session lookup is required for gift card reconciliation");
  }
  const db = (0, import_client4.createDbClient)(env);
  const purchase = await db.select().from(giftCardPurchases).where((0, import_drizzle_orm6.eq)(giftCardPurchases.id, id)).get();
  if (!purchase || purchase.status !== "pending" || !purchase.providerSessionId) return null;
  const session = await adapter.getCheckoutSession(purchase.providerSessionId);
  if (session.status === "expired") {
    await expireGiftCardPurchase(env, id, purchase.providerSessionId);
    return { status: "cancelled" };
  }
  if (session.status === "complete" && session.paymentStatus === "paid") {
    await confirmGiftCardPurchase(env, {
      id: purchase.providerSessionId,
      metadata: { giftCardPurchaseId: id },
      amount_total: session.amountTotal ?? void 0,
      currency: session.currency ?? void 0,
      payment_status: session.paymentStatus,
      payment_intent: session.paymentIntentId ?? void 0
    });
    return { status: "paid" };
  }
  return { status: "pending" };
}
async function recordGiftCardPurchaseRefund(env, params) {
  const db = (0, import_client4.createDbClient)(env);
  const purchase = await db.select().from(giftCardPurchases).where((0, import_drizzle_orm6.eq)(giftCardPurchases.paymentIntentId, params.paymentIntentId)).get();
  if (!purchase) return null;
  if (purchase.amountCents !== params.amount || params.currency.toLowerCase() !== "usd" || !Number.isSafeInteger(params.amountRefunded) || params.amountRefunded < 0 || params.amountRefunded > purchase.amountCents) throw new Error("Gift card refund does not match purchase");
  if (params.amountRefunded <= purchase.providerRefundedCents) return { success: true, duplicate: true };
  const card = await db.select().from(giftCards).where((0, import_drizzle_orm6.eq)(giftCards.purchaseId, purchase.id)).get();
  const full = params.amountRefunded === purchase.amountCents;
  const unspent = card?.balanceCents === card?.initialCents;
  const status = full && unspent ? "refunded" : "review";
  const timestamp = Math.floor(Date.now() / 1e3);
  const statements = [
    env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = ?,provider_refunded_cents = ?,updated_at = ?
      WHERE id = ? AND provider_refunded_cents < ?`).bind(status, params.amountRefunded, timestamp, purchase.id, params.amountRefunded)
  ];
  if (card) {
    statements.push(env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = ?,updated_at = ? WHERE id = ?`).bind(full && unspent ? "void" : "suspended", timestamp, card.id));
    if (full && unspent) statements.push(env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      VALUES (?,?,?,'purchase_reversal',?,?) ON CONFLICT(id) DO NOTHING`).bind(`gcl_purchase_reversal_${card.id}`, card.id, purchase.id, -card.initialCents, timestamp));
  }
  await env.DB.batch(statements);
  return { success: true, purchaseId: purchase.id, status };
}
var refundSchema = import_zod3.z.object({
  orderId: import_zod3.z.string().regex(/^ord_[0-9a-f-]{36}$/),
  reason: import_zod3.z.string().trim().min(8).max(500),
  amountCents: import_zod3.z.number().int().positive().optional()
}).strict();

// src/api.ts
function aggregateComponentDemand(items) {
  const demand = /* @__PURE__ */ new Map();
  for (const item of items) {
    for (const component of item.components) {
      const current = demand.get(component.id);
      demand.set(component.id, {
        name: component.name,
        quantity: (current?.quantity ?? 0) + item.quantity * component.quantity,
        available: component.available
      });
    }
  }
  return demand;
}
function bindCommerceApi(options) {
  const { env, paymentAdapters = [] } = options;
  const db = (0, import_client5.createDbClient)(env);
  async function resolveSelectedVariant(product, variantId) {
    const variantValue = await db.select().from(productVariantValues).where((0, import_drizzle_orm7.eq)(productVariantValues.id, variantId)).get();
    if (variantValue) {
      const productVariant = await db.select().from(productVariants).where((0, import_drizzle_orm7.eq)(productVariants.id, variantValue.productVariantId)).get();
      if (!productVariant || productVariant.productId !== product.id) {
        throw new Error(`Variant value not found or mismatch: ${variantId}`);
      }
      const stock = await db.select().from(stocks).where((0, import_drizzle_orm7.eq)(stocks.productVariantValueId, variantValue.id)).get();
      const variantDefinition = productVariant.variantId ? await db.select().from(variants).where((0, import_drizzle_orm7.eq)(variants.id, productVariant.variantId)).get() : null;
      const requirements = await db.select().from(variantComponents).where((0, import_drizzle_orm7.eq)(variantComponents.productVariantValueId, variantValue.id));
      const components2 = [];
      for (const requirement of requirements) {
        const component = await db.select().from(components).where((0, import_drizzle_orm7.eq)(components.id, requirement.componentId)).get();
        if (!component) throw new Error(`Component not found: ${requirement.componentId}`);
        components2.push({
          id: component.id,
          name: component.name,
          quantity: requirement.quantity,
          available: component.quantity
        });
      }
      return {
        price: variantValue.priceOverride ?? productVariant.priceOverride ?? product.basePrice,
        name: `${product.name} - ${variantDefinition?.name ?? productVariant.name}: ${variantValue.value}`,
        availableQuantity: components2.length ? Math.min(...components2.map((component) => Math.floor(component.available / component.quantity))) : stock?.quantity ?? productVariant.inventoryQuantity,
        stockRecordId: stock?.id,
        inventoryTarget: components2.length ? null : stock ? { type: "stock", id: stock.id } : { type: "variant", id: productVariant.id },
        components: components2
      };
    }
    const legacyVariant = await db.select().from(productVariants).where((0, import_drizzle_orm7.eq)(productVariants.id, variantId)).get();
    if (!legacyVariant || legacyVariant.productId !== product.id) {
      throw new Error(`Variant not found or mismatch: ${variantId}`);
    }
    return {
      price: legacyVariant.priceOverride ?? product.basePrice,
      name: `${product.name} - ${legacyVariant.name}`,
      availableQuantity: legacyVariant.inventoryQuantity,
      stockRecordId: null,
      inventoryTarget: { type: "variant", id: legacyVariant.id },
      components: []
    };
  }
  async function finalizeOrderPayment(params) {
    const order = await db.select().from(orders).where((0, import_drizzle_orm7.eq)(orders.id, params.orderId)).get();
    if (!order) {
      throw new Error(`Order not found: ${params.orderId}`);
    }
    if (params.paymentStatus !== "success") {
      throw new Error("Payment has not succeeded");
    }
    if (order.checkoutSessionId !== params.providerId || (order.paymentProvider ?? "stripe") !== params.provider) {
      throw new Error("Payment provider or session does not match order");
    }
    if (params.amount !== void 0 && params.amount !== order.totalAmount) {
      throw new Error("Payment amount does not match order total");
    }
    if (params.currency && params.currency.toLowerCase() !== order.currency.toLowerCase()) {
      throw new Error("Payment currency does not match order");
    }
    if (["paid", "fulfilled", "partially_refunded", "refunded"].includes(order.status)) {
      return { success: true, orderId: params.orderId, status: order.status, duplicate: true };
    }
    if (order.status === "cancelled") {
      throw new Error("Cancelled order cannot be paid");
    }
    const timestamp = Math.floor(Date.now() / 1e3);
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const providerEmail = params.customerEmail?.trim() ?? "";
    const email = emailPattern.test(providerEmail) ? providerEmail : (order.customerEmail || "").trim();
    const normalizedEmail = email.toLowerCase();
    const newAccountId = !order.userId && params.provider !== "admin_test" && emailPattern.test(normalizedEmail) ? `acct_${order.id}` : null;
    const accountName = typeof order.shippingAddress?.name === "string" ? order.shippingAddress.name.trim().slice(0, 160) : null;
    const statements = [
      env.DB.prepare(`UPDATE _ecommerce_orders SET status = 'paid', updated_at = ?, customer_email = ?, payment_intent_id = ?
        WHERE id = ? AND status = 'pending' AND checkout_session_id = ? AND total_amount = ?`).bind(timestamp, email, params.paymentIntentId ?? null, params.orderId, params.providerId, order.totalAmount)
    ];
    if (newAccountId) {
      statements.push(env.DB.prepare(`INSERT INTO _ecommerce_customer_accounts
        (id, email, email_normalized, name, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ? FROM _ecommerce_orders
        WHERE id = ? AND status = 'paid' AND checkout_session_id = ?
        ON CONFLICT(email_normalized) DO NOTHING`).bind(newAccountId, email, normalizedEmail, accountName, timestamp, timestamp, params.orderId, params.providerId));
      statements.push(env.DB.prepare(`UPDATE _ecommerce_orders
        SET user_id = (SELECT id FROM _ecommerce_customer_accounts WHERE email_normalized = ?)
        WHERE id = ? AND status = 'paid' AND user_id IS NULL`).bind(normalizedEmail, params.orderId));
      if (order.referralCode && order.referralRewardCents > 0 && params.provider !== "admin_test") {
        statements.push(env.DB.prepare(`INSERT INTO _ecommerce_referrals
          (id, code, referrer_account_id, referred_account_id, order_id, reward_cents, currency, status, created_at, updated_at)
          SELECT ?, rc.code, rc.account_id, o.user_id, o.id, ?, o.currency, 'approved', ?, ?
          FROM _ecommerce_orders o
          JOIN _ecommerce_referral_codes rc ON rc.code = o.referral_code
          JOIN _ecommerce_customer_accounts referrer ON referrer.id = rc.account_id
          WHERE o.id = ? AND o.status = 'paid' AND o.user_id = ?
            AND referrer.email_normalized <> ? AND rc.account_id <> o.user_id
          ON CONFLICT DO NOTHING`).bind(
          `ref_${order.id}`,
          order.referralRewardCents,
          timestamp,
          timestamp,
          params.orderId,
          newAccountId,
          normalizedEmail
        ));
        statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
          (id, account_id, order_id, kind, amount_cents, created_at)
          SELECT ?, referrer_account_id, order_id, 'referral_award', reward_cents, ?
          FROM _ecommerce_referrals WHERE order_id = ? AND status = 'approved'
          ON CONFLICT(order_id, kind) DO NOTHING`).bind(`credit_ref_${order.id}`, timestamp, params.orderId));
        statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
          (id, account_id, order_id, kind, amount_cents, created_at)
          SELECT ?, referred_account_id, order_id, 'welcome_award', reward_cents, ?
          FROM _ecommerce_referrals WHERE order_id = ? AND status = 'approved'
          ON CONFLICT(order_id, kind) DO NOTHING`).bind(`credit_welcome_${order.id}`, timestamp, params.orderId));
      }
    }
    statements.push(
      env.DB.prepare(`UPDATE _ecommerce_discount_redemptions SET status = 'confirmed', updated_at = ?
        WHERE order_id = ? AND status = 'reserved'
          AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'paid')`).bind(timestamp, params.orderId, params.orderId),
      env.DB.prepare(`UPDATE _ecommerce_gift_card_redemptions SET status = 'confirmed', updated_at = ?
        WHERE order_id = ? AND status = 'reserved'
          AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'paid')`).bind(timestamp, params.orderId, params.orderId),
      env.DB.prepare(`UPDATE _ecommerce_carts SET closed = 1, closed_at = ?, updated_at = ?,
        user_id = COALESCE(user_id, (SELECT user_id FROM _ecommerce_orders WHERE id = ?))
        WHERE id = ? AND EXISTS (SELECT 1 FROM _ecommerce_orders
          WHERE id = ? AND status = 'paid' AND checkout_session_id = ?)`).bind(timestamp, timestamp, params.orderId, order.cartId, params.orderId, params.providerId),
      env.DB.prepare(`INSERT INTO _ecommerce_payments
        (id, order_id, provider, provider_id, status, amount, created_at)
        SELECT ?, id, ?, ?, 'success', total_amount, ? FROM _ecommerce_orders
        WHERE id = ? AND status = 'paid' AND checkout_session_id = ?
        ON CONFLICT(provider, provider_id) DO NOTHING`).bind(`pay_${crypto.randomUUID()}`, params.provider, params.providerId, timestamp, params.orderId, params.providerId)
    );
    await env.DB.batch(statements);
    const current = await db.select().from(orders).where((0, import_drizzle_orm7.eq)(orders.id, params.orderId)).get();
    if (current?.status !== "paid") throw new Error("Order is no longer pending");
    return { success: true, orderId: params.orderId, status: "paid" };
  }
  async function recordProviderRefund(params) {
    const order = await db.select().from(orders).where((0, import_drizzle_orm7.eq)(orders.paymentIntentId, params.paymentIntentId)).get();
    if (!order) throw new Error("Refund payment is not linked to a confirmed order");
    if (order.paymentProvider !== "stripe" || order.totalAmount !== params.amount || order.currency.toLowerCase() !== params.currency.toLowerCase() || !Number.isSafeInteger(params.amountRefunded) || params.amountRefunded < 0 || params.amountRefunded > order.totalAmount) {
      throw new Error("Refund does not match order payment");
    }
    if (params.amountRefunded <= order.providerRefundedCents) {
      return { success: true, orderId: order.id, duplicate: true };
    }
    const now = Math.floor(Date.now() / 1e3);
    const full = params.amountRefunded === order.totalAmount;
    const statements = [
      env.DB.prepare(`UPDATE _ecommerce_orders
        SET provider_refunded_cents = ?, status = ?, updated_at = ?
        WHERE id = ? AND payment_intent_id = ? AND provider_refunded_cents < ?
          AND status IN ('paid', 'fulfilled', 'partially_refunded')`).bind(
        params.amountRefunded,
        full ? "refunded" : "partially_refunded",
        now,
        order.id,
        params.paymentIntentId,
        params.amountRefunded
      ),
      env.DB.prepare(`UPDATE _ecommerce_payments
        SET status = (SELECT status FROM _ecommerce_orders WHERE id = ?)
        WHERE order_id = ? AND provider = 'stripe'`).bind(order.id, order.id)
    ];
    if (full) {
      statements.push(env.DB.prepare(`UPDATE _ecommerce_discount_redemptions
        SET status = 'refunded', updated_at = ?
        WHERE order_id = ? AND status = 'confirmed'
          AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'refunded')`).bind(now, order.id, order.id));
      statements.push(env.DB.prepare(`UPDATE _ecommerce_gift_card_redemptions
        SET status = 'refunded', updated_at = ?
        WHERE order_id = ? AND status = 'confirmed'
          AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'refunded')`).bind(now, order.id, order.id));
      statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
        (id, account_id, order_id, kind, amount_cents, created_at)
        SELECT ?, user_id, id, 'purchase_credit_refund', credit_applied, ?
        FROM _ecommerce_orders WHERE id = ? AND status = 'refunded'
          AND credit_applied > 0 AND user_id IS NOT NULL
        ON CONFLICT(order_id, kind) DO NOTHING`).bind(`credit_refund_${order.id}`, now, order.id));
      for (const [awardKind, reversalKind] of [
        ["referral_award", "referral_reversal"],
        ["welcome_award", "welcome_reversal"]
      ]) {
        statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
          (id, account_id, order_id, kind, amount_cents, created_at)
          SELECT ?, l.account_id, l.order_id, ?, -l.amount_cents, ?
          FROM _ecommerce_credit_ledger l
          JOIN _ecommerce_orders o ON o.id = l.order_id AND o.status = 'refunded'
          WHERE l.order_id = ? AND l.kind = ?
          ON CONFLICT(order_id, kind) DO NOTHING`).bind(`credit_${reversalKind}_${order.id}`, reversalKind, now, order.id, awardKind));
      }
      statements.push(env.DB.prepare(`UPDATE _ecommerce_referrals SET status = 'void', updated_at = ?
        WHERE order_id = ? AND EXISTS
          (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'refunded')`).bind(now, order.id, order.id));
    }
    await env.DB.batch(statements);
    return { success: true, orderId: order.id, status: full ? "refunded" : "partially_refunded" };
  }
  return {
    carts: {
      async quote(cartId) {
        const cart = await db.select().from(carts).where((0, import_drizzle_orm7.eq)(carts.id, cartId)).get();
        if (!cart) throw new Error("Cart not found");
        const lines = [];
        let totalAmount = 0;
        let requiresShipping = false;
        const componentItems = [];
        for (const item of cart.items) {
          const product = await db.select().from(products).where((0, import_drizzle_orm7.eq)(products.id, item.productId)).get();
          if (!product || product.status !== "active") throw new Error(`Product is not available: ${item.productId}`);
          const variant = item.variantId ? await resolveSelectedVariant(product, item.variantId) : null;
          const unitAmount = variant?.price ?? product.basePrice;
          const name = variant?.name ?? product.name;
          if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0) {
            throw new Error(`A positive price is required for ${name}`);
          }
          if (product.type === "standard" && (variant?.availableQuantity ?? product.inventoryQuantity) < item.quantity) {
            throw new Error(`Insufficient stock for ${name}`);
          }
          if (product.type === "standard" && variant?.components.length) {
            componentItems.push({ quantity: item.quantity, components: variant.components });
          }
          const lineTotal = unitAmount * item.quantity;
          totalAmount += lineTotal;
          requiresShipping ||= product.isPhysical;
          lines.push({ productId: item.productId, variantId: item.variantId, name, quantity: item.quantity, unitAmount, lineTotal });
        }
        for (const demand of aggregateComponentDemand(componentItems).values()) {
          if (demand.available < demand.quantity) throw new Error(`Insufficient stock for component ${demand.name}`);
        }
        if (!Number.isSafeInteger(totalAmount)) throw new Error("Order total is too large");
        return { lines, totalAmount, currency: "usd", requiresShipping, locked: Boolean(cart.checkoutSessionId) };
      },
      async find(sessionToken, userId) {
        if (!sessionToken && !userId) return null;
        const conditions = [(0, import_drizzle_orm7.eq)(carts.closed, false)];
        if (userId) {
          conditions.push((0, import_drizzle_orm7.eq)(carts.userId, userId));
        } else if (sessionToken) {
          conditions.push((0, import_drizzle_orm7.eq)(carts.sessionToken, sessionToken));
          conditions.push((0, import_drizzle_orm7.isNull)(carts.userId));
        }
        return await db.select().from(carts).where((0, import_drizzle_orm7.and)(...conditions)).get();
      },
      /** Attach the current browser basket to an authenticated shopper account. */
      async claim(sessionToken, userId, choice) {
        const account = await db.select({ id: customerAccounts.id }).from(customerAccounts).where((0, import_drizzle_orm7.eq)(customerAccounts.id, userId)).get();
        if (!account) throw new Error("Customer account not found");
        const guest = await db.select().from(carts).where((0, import_drizzle_orm7.and)((0, import_drizzle_orm7.eq)(carts.sessionToken, sessionToken), (0, import_drizzle_orm7.eq)(carts.closed, false))).get();
        const owned = await db.select().from(carts).where((0, import_drizzle_orm7.and)((0, import_drizzle_orm7.eq)(carts.userId, userId), (0, import_drizzle_orm7.eq)(carts.closed, false))).get();
        if (guest?.userId === userId) return guest;
        if (guest?.userId) throw new Error("Basket belongs to another account");
        if (guest?.checkoutSessionId) throw new Error("Checkout already started for this cart");
        if (guest && owned && guest.id !== owned.id) {
          if (guest.items.length && owned.items.length) {
            if (!choice) throw new Error("Both baskets have items; choose which basket to keep before linking this session");
          }
          if (owned.checkoutSessionId) throw new Error("Checkout already started for this cart");
          if (guest.items.length && choice !== "account") {
            const released = await db.update(carts).set({ userId: null, updatedAt: /* @__PURE__ */ new Date() }).where((0, import_drizzle_orm7.and)(
              (0, import_drizzle_orm7.eq)(carts.id, owned.id),
              (0, import_drizzle_orm7.eq)(carts.userId, userId),
              (0, import_drizzle_orm7.eq)(carts.version, owned.version),
              (0, import_drizzle_orm7.eq)(carts.closed, false)
            )).returning({ id: carts.id });
            if (!released.length) throw new Error("Basket changed during account upgrade; reload and try again");
          } else {
            const released = await db.update(carts).set({ sessionToken: null, updatedAt: /* @__PURE__ */ new Date() }).where((0, import_drizzle_orm7.and)(
              (0, import_drizzle_orm7.eq)(carts.id, guest.id),
              (0, import_drizzle_orm7.eq)(carts.sessionToken, sessionToken),
              (0, import_drizzle_orm7.eq)(carts.version, guest.version),
              (0, import_drizzle_orm7.eq)(carts.closed, false)
            )).returning({ id: carts.id });
            if (!released.length) throw new Error("Basket changed during account upgrade; reload and try again");
          }
        }
        const target = choice === "account" && owned ? owned : guest?.items.length ? guest : owned ?? guest;
        if (target) {
          if (!guest) {
            await env.DB.prepare(`UPDATE _ecommerce_carts SET session_token = NULL
              WHERE session_token = ? AND closed = 1`).bind(sessionToken).run();
          }
          const updated = await db.update(carts).set({ userId, sessionToken, updatedAt: /* @__PURE__ */ new Date(), version: import_drizzle_orm7.sql`${carts.version} + 1` }).where((0, import_drizzle_orm7.and)(
            (0, import_drizzle_orm7.eq)(carts.id, target.id),
            (0, import_drizzle_orm7.eq)(carts.closed, false),
            (0, import_drizzle_orm7.isNull)(carts.checkoutSessionId),
            (0, import_drizzle_orm7.eq)(carts.version, target.version)
          )).returning({ id: carts.id });
          if (!updated.length) throw new Error("Basket changed during account upgrade; reload and try again");
          return await db.select().from(carts).where((0, import_drizzle_orm7.eq)(carts.id, target.id)).get();
        }
        return null;
      },
      async getOrCreate(sessionToken, userId) {
        if (userId) {
          const claimed = await this.claim(sessionToken, userId);
          if (claimed) return claimed;
        }
        let cart = await this.find(sessionToken, userId);
        if (!cart) {
          if (!userId) {
            await env.DB.prepare(`UPDATE _ecommerce_carts SET session_token = NULL
               WHERE session_token = ? AND closed = 0 AND user_id IS NOT NULL`).bind(sessionToken).run();
          }
          await env.DB.prepare(`UPDATE _ecommerce_carts SET session_token = NULL
             WHERE session_token = ? AND closed = 1`).bind(sessionToken).run();
          const cartId = `cart_${crypto.randomUUID()}`;
          const now = /* @__PURE__ */ new Date();
          await db.insert(carts).values({
            id: cartId,
            sessionToken,
            userId,
            checkoutSessionId: null,
            items: [],
            closed: false,
            closedAt: null,
            createdAt: now,
            updatedAt: now
          });
          cart = await this.find(sessionToken, userId);
        }
        return cart;
      },
      async updateItems(cartId, items) {
        if (!Array.isArray(items) || items.length > 100 || items.some(
          (item) => !item || typeof item.productId !== "string" || !item.productId.trim() || item.productId.length > 128 || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > 99 || item.variantId !== void 0 && (typeof item.variantId !== "string" || item.variantId.length > 128)
        )) {
          throw new Error("Cart items must have a product and a positive integer quantity");
        }
        const itemKeys = items.map((item) => `${item.productId}\0${item.variantId || ""}`);
        if (new Set(itemKeys).size !== itemKeys.length) {
          throw new Error("Duplicate cart items are not allowed");
        }
        const cart = await db.select().from(carts).where((0, import_drizzle_orm7.eq)(carts.id, cartId)).get();
        if (!cart) {
          throw new Error("Cart not found");
        }
        if (cart.closed) {
          throw new Error("Cart is closed");
        }
        if (cart.checkoutSessionId) {
          throw new Error("Checkout already started for this cart");
        }
        const updated = await db.update(carts).set({ items, updatedAt: /* @__PURE__ */ new Date(), version: import_drizzle_orm7.sql`${carts.version} + 1` }).where((0, import_drizzle_orm7.and)(
          (0, import_drizzle_orm7.eq)(carts.id, cartId),
          (0, import_drizzle_orm7.eq)(carts.closed, false),
          (0, import_drizzle_orm7.isNull)(carts.checkoutSessionId),
          (0, import_drizzle_orm7.eq)(carts.version, cart.version)
        )).returning({ id: carts.id });
        if (!updated.length) throw new Error("Basket changed or checkout already started; reload and try again");
        return await db.select().from(carts).where((0, import_drizzle_orm7.eq)(carts.id, cartId)).get();
      }
    },
    orders: {
      async resumeFromCart(cartId) {
        const cart = await db.select().from(carts).where((0, import_drizzle_orm7.eq)(carts.id, cartId)).get();
        if (!cart?.checkoutSessionId) return null;
        if (cart.checkoutSessionId.startsWith("preparing:")) {
          const cutoff = Math.floor(Date.now() / 1e3) - 35 * 60;
          await env.DB.prepare(`UPDATE _ecommerce_carts SET checkout_session_id = NULL,
            updated_at = ?, version = version + 1 WHERE id = ? AND checkout_session_id = ?
            AND updated_at < ? AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders
              WHERE cart_id = _ecommerce_carts.id AND status = 'pending')`).bind(Math.floor(Date.now() / 1e3), cartId, cart.checkoutSessionId, cutoff).run();
          return null;
        }
        const order = await db.select().from(orders).where((0, import_drizzle_orm7.eq)(orders.checkoutSessionId, cart.checkoutSessionId)).get();
        if (!order || order.status !== "pending") return null;
        if (order.paymentProvider === "gift_card" && order.totalAmount === 0) {
          await finalizeOrderPayment({
            orderId: order.id,
            provider: "gift_card",
            providerId: order.checkoutSessionId,
            paymentStatus: "success",
            amount: 0,
            customerEmail: order.customerEmail ?? void 0
          });
          return { order: await this.find(order.id), paymentUrl: `/checkout/success?order=${encodeURIComponent(order.id)}` };
        }
        const reconciled = await this.reconcilePending(order.id);
        if (reconciled?.status === "paid") {
          return { order: await this.find(order.id), paymentUrl: `/checkout/success?order=${encodeURIComponent(order.id)}` };
        }
        if (reconciled?.status === "cancelled") return null;
        return { order, paymentUrl: reconciled?.paymentUrl ?? null };
      },
      async reconcilePending(id) {
        const order = await this.find(id);
        if (!order || order.status !== "pending" || !order.checkoutSessionId) return null;
        if (order.paymentProvider === "gift_card") {
          await finalizeOrderPayment({
            orderId: order.id,
            provider: "gift_card",
            providerId: order.checkoutSessionId,
            paymentStatus: "success",
            amount: 0,
            customerEmail: order.customerEmail ?? void 0
          });
          return { status: "paid", paymentUrl: null };
        }
        if (order.paymentProvider === "admin_test") {
          await finalizeOrderPayment({
            orderId: order.id,
            provider: "admin_test",
            providerId: order.checkoutSessionId,
            paymentStatus: "success",
            amount: order.totalAmount,
            currency: order.currency
          });
          return { status: "paid", paymentUrl: null };
        }
        const adapter = paymentAdapters.find((candidate) => candidate.providerId === (order.paymentProvider ?? "stripe"));
        if (!adapter?.getCheckoutSession) throw new Error("Payment provider cannot reconcile checkout");
        const session = await adapter.getCheckoutSession(order.checkoutSessionId);
        if (session.status === "expired") {
          await this.cancel(id, { sessionExpired: true });
          return { status: "cancelled", paymentUrl: null };
        }
        if (session.status === "complete" && session.paymentStatus === "paid") {
          if (session.amountTotal !== order.totalAmount || session.currency?.toLowerCase() !== order.currency.toLowerCase() || (order.paymentProvider ?? "stripe") === "stripe" && !session.paymentIntentId) {
            throw new Error("Completed payment does not match pending order");
          }
          await finalizeOrderPayment({
            orderId: id,
            provider: order.paymentProvider ?? "stripe",
            providerId: order.checkoutSessionId,
            paymentStatus: "success",
            amount: session.amountTotal,
            currency: session.currency,
            paymentIntentId: session.paymentIntentId ?? void 0,
            customerEmail: session.customerEmail ?? void 0
          });
          return { status: "paid", paymentUrl: null };
        }
        return { status: "pending", paymentUrl: session.status === "open" ? session.url : null };
      },
      async createFromCart(cartId, options2) {
        const cart = await db.select().from(carts).where((0, import_drizzle_orm7.eq)(carts.id, cartId)).get();
        if (!cart || cart.items.length === 0) {
          throw new Error("Cart is empty or not found");
        }
        if (cart.closed) {
          throw new Error("Cart is closed");
        }
        if (cart.checkoutSessionId) {
          throw new Error("Checkout already started for this cart");
        }
        const defaultAdapter = options2.providerId ? paymentAdapters.find((adapter) => adapter.providerId === options2.providerId) : paymentAdapters.length === 1 ? paymentAdapters[0] : void 0;
        if (!defaultAdapter) throw new Error("A payment provider must be selected and configured before checkout");
        let requiresShipping = false;
        let totalAmount = 0;
        const orderItems = [];
        const componentItems = [];
        const inventoryDemand = /* @__PURE__ */ new Map();
        for (const item of cart.items) {
          const product = await db.select().from(products).where((0, import_drizzle_orm7.eq)(products.id, item.productId)).get();
          if (!product) {
            throw new Error(`Product not found: ${item.productId}`);
          }
          if (product.status !== "active") {
            throw new Error(`Product is not available: ${item.productId}`);
          }
          let price = product.basePrice;
          let finalName = product.name;
          let availableQuantity = product.inventoryQuantity;
          let requiredComponents = [];
          let inventoryTarget = { type: "product", id: product.id };
          if (item.variantId) {
            const selectedVariant = await resolveSelectedVariant(product, item.variantId);
            price = selectedVariant.price;
            finalName = selectedVariant.name;
            availableQuantity = selectedVariant.availableQuantity;
            requiredComponents = selectedVariant.components;
            inventoryTarget = selectedVariant.inventoryTarget;
          }
          if (product.isPhysical) {
            requiresShipping = true;
          }
          const tracksInventory = product.type === "standard";
          if (tracksInventory && availableQuantity < item.quantity) {
            throw new Error(`Insufficient stock for ${finalName}`);
          }
          if (tracksInventory && requiredComponents.length) {
            componentItems.push({ quantity: item.quantity, components: requiredComponents });
          } else if (tracksInventory && inventoryTarget) {
            const key = `${inventoryTarget.type}:${inventoryTarget.id}`;
            const existing = inventoryDemand.get(key);
            inventoryDemand.set(key, { ...inventoryTarget, quantity: (existing?.quantity ?? 0) + item.quantity });
          }
          if (!Number.isSafeInteger(price) || price <= 0) {
            throw new Error(`A positive price is required for ${finalName}`);
          }
          totalAmount += price * item.quantity;
          if (!Number.isSafeInteger(totalAmount)) throw new Error("Order total is too large");
          orderItems.push({
            ...item,
            priceAtPurchase: price,
            name: finalName,
            usesComponents: tracksInventory && requiredComponents.length > 0
          });
        }
        const componentDemand = aggregateComponentDemand(componentItems);
        for (const component of componentDemand.values()) {
          if (component.available < component.quantity) {
            throw new Error(`Insufficient stock for component ${component.name}`);
          }
        }
        if (requiresShipping && (!options2.shippingAddress || !["name", "line1", "city", "postalCode", "country"].every((key) => typeof options2.shippingAddress[key] === "string" && options2.shippingAddress[key].trim()))) {
          throw new Error("Shipping address is required for physical products");
        }
        const orderId = `ord_${crypto.randomUUID()}`;
        const referralsPolicy = await getReferralPolicy(env);
        const subtotalAmount = totalAmount;
        const discount = options2.discountCode && defaultAdapter.providerId === "stripe" ? await evaluateDiscountCode(env, {
          code: options2.discountCode,
          customerEmail: options2.customerEmail,
          accountId: cart.userId,
          lines: orderItems,
          subtotal: subtotalAmount
        }) : null;
        const discountAmount = discount?.amount ?? 0;
        let creditApplied = 0;
        if (cart.userId && defaultAdapter.providerId === "stripe") {
          const owner = await db.select({ creditBalance: customerAccounts.creditBalance }).from(customerAccounts).where((0, import_drizzle_orm7.eq)(customerAccounts.id, cart.userId)).get();
          creditApplied = Math.min(
            Math.max(0, owner?.creditBalance ?? 0),
            Math.max(0, subtotalAmount - discountAmount - 50)
          );
        }
        totalAmount = subtotalAmount - discountAmount - creditApplied;
        const giftCard = options2.giftCardCode && defaultAdapter.providerId === "stripe" ? await evaluateGiftCard(env, options2.giftCardCode, totalAmount) : null;
        const giftCardApplied = giftCard?.amount ?? 0;
        totalAmount -= giftCardApplied;
        const internallyPaid = Boolean(giftCard && totalAmount === 0);
        let referralCode = null;
        if (referralsPolicy.enabled && !cart.userId && options2.referralCode && defaultAdapter.providerId === "stripe" && !internallyPaid) {
          const referral = await findReferralCode(env, options2.referralCode);
          if (referral && subtotalAmount >= referralsPolicy.minOrderCents && referral.emailNormalized !== options2.customerEmail.trim().toLowerCase()) {
            referralCode = referral.code;
          }
        }
        if (!defaultAdapter.expireCheckoutSession) {
          throw new Error("Payment provider must support checkout session expiry");
        }
        const successUrl = options2.successUrl.replaceAll("{ORDER_ID}", orderId);
        const cancelUrl = options2.cancelUrl.replaceAll("{ORDER_ID}", orderId);
        const now = /* @__PURE__ */ new Date();
        const timestamp = Math.floor(now.getTime() / 1e3);
        const preparationLock = `preparing:${orderId}`;
        const snapshot = JSON.stringify(cart.items);
        const lock = await env.DB.prepare(`UPDATE _ecommerce_carts
           SET checkout_session_id = ?, updated_at = ?, version = version + 1
           WHERE id = ? AND closed = 0 AND checkout_session_id IS NULL AND items = ? AND version = ? RETURNING id`).bind(preparationLock, timestamp, cartId, snapshot, cart.version).all();
        if (!lock.results?.length) throw new Error("Checkout already started for this cart");
        let session;
        let committed = false;
        try {
          session = internallyPaid ? { providerSessionId: `internal:${orderId}`, url: successUrl } : await defaultAdapter.createCheckoutSession({
            orderId,
            items: orderItems.map((i) => ({
              name: i.name,
              priceCents: i.priceAtPurchase,
              quantity: i.quantity
            })),
            customerEmail: options2.customerEmail,
            creditApplied,
            discountApplied: discountAmount,
            giftCardApplied,
            metadata: {
              giftCardApplied: String(giftCardApplied),
              storeCreditApplied: String(creditApplied),
              promotionDiscount: String(discountAmount)
            },
            successUrl,
            cancelUrl
          });
          if (!session.providerSessionId || !session.url) throw new Error("Payment provider did not return a checkout session");
          const checkoutSessionId = session.providerSessionId;
          const statements = [
            env.DB.prepare(`INSERT INTO _ecommerce_orders
             (id, cart_id, user_id, checkout_session_id, payment_provider, status, items, total_amount, subtotal_amount, credit_applied, discount_code, discount_amount, gift_card_id, gift_card_applied, referral_code, referral_reward_cents, currency,
              customer_email, shipping_address, billing_address, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'usd', ?, ?, ?, ?, ?) `).bind(
              orderId,
              cartId,
              cart.userId,
              checkoutSessionId,
              internallyPaid ? "gift_card" : defaultAdapter.providerId,
              JSON.stringify(orderItems.map(({ name, ...rest }) => rest)),
              totalAmount,
              subtotalAmount,
              creditApplied,
              discount?.code ?? null,
              discountAmount,
              giftCard?.id ?? null,
              giftCardApplied,
              referralCode,
              referralCode ? referralsPolicy.rewardCents : 0,
              options2.customerEmail,
              options2.shippingAddress ? JSON.stringify(options2.shippingAddress) : null,
              options2.billingAddress ? JSON.stringify(options2.billingAddress) : null,
              timestamp,
              timestamp
            )
          ];
          if (discount) {
            statements.push(env.DB.prepare(`INSERT INTO _ecommerce_discount_redemptions
             (id, code, order_id, account_id, email_normalized, amount_cents, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`).bind(
              `dred_${orderId}`,
              discount.code,
              orderId,
              cart.userId,
              discount.emailNormalized,
              discount.amount,
              timestamp,
              timestamp
            ));
          }
          if (giftCard) {
            statements.push(env.DB.prepare(`INSERT INTO _ecommerce_gift_card_redemptions
             (id,card_id,order_id,amount_cents,status,created_at,updated_at)
             VALUES (?,?,?,?,'reserved',?,?)`).bind(`gcr_${orderId}`, giftCard.id, orderId, giftCardApplied, timestamp, timestamp));
          }
          if (creditApplied && cart.userId) {
            statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
             (id, account_id, order_id, kind, amount_cents, created_at)
             VALUES (?, ?, ?, 'checkout_reserve', ?, ?)`).bind(`credit_hold_${orderId}`, cart.userId, orderId, -creditApplied, timestamp));
          }
          for (const [componentId, demand] of defaultAdapter.reservesInventory === false ? [] : componentDemand) {
            statements.push(env.DB.prepare(`UPDATE _ecommerce_components
             SET quantity = quantity - ?, updated_at = ? WHERE id = ?`).bind(demand.quantity, timestamp, componentId));
            statements.push(env.DB.prepare(`INSERT INTO _ecommerce_component_reservations
             (id, order_id, component_id, quantity) VALUES (?, ?, ?, ?)`).bind(crypto.randomUUID(), orderId, componentId, demand.quantity));
          }
          for (const demand of defaultAdapter.reservesInventory === false ? [] : inventoryDemand.values()) {
            const table = demand.type === "product" ? "_ecommerce_products" : demand.type === "variant" ? "_ecommerce_product_variants" : "_ecommerce_stocks";
            const column = demand.type === "stock" ? "quantity" : "inventory_quantity";
            statements.push(env.DB.prepare(`UPDATE ${table} SET ${column} = ${column} - ?, updated_at = ? WHERE id = ?`).bind(demand.quantity, timestamp, demand.id));
            statements.push(env.DB.prepare(`INSERT INTO _ecommerce_inventory_reservations
             (id, order_id, target_type, target_id, quantity) VALUES (?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), orderId, demand.type, demand.id, demand.quantity));
          }
          statements.push(env.DB.prepare(`UPDATE _ecommerce_carts SET checkout_session_id = ?, updated_at = ?
           WHERE id = ? AND checkout_session_id = ?`).bind(checkoutSessionId, timestamp, cartId, preparationLock));
          try {
            await env.DB.batch(statements);
            committed = true;
          } catch (cause) {
            if (cause instanceof Error && cause.message.includes("Discount code is no longer available")) {
              throw new Error("Discount code is no longer available", { cause });
            }
            if (cause instanceof Error && cause.message.includes("Insufficient store credit")) {
              throw new Error("Store credit changed during checkout; please try again", { cause });
            }
            if (cause instanceof Error && cause.message.includes("Gift card is no longer available")) {
              throw new Error("Gift card is no longer available", { cause });
            }
            throw new Error("Insufficient stock or checkout already started", { cause });
          }
          const order = await this.find(orderId);
          if (!order) throw new Error("Checkout was created but the order could not be loaded");
          if (internallyPaid) {
            await finalizeOrderPayment({
              orderId,
              provider: "gift_card",
              providerId: checkoutSessionId,
              paymentStatus: "success",
              amount: 0,
              customerEmail: options2.customerEmail
            });
            return { order: await this.find(orderId), paymentUrl: session.url };
          }
          return { order, paymentUrl: session.url };
        } catch (error) {
          if (committed) throw error;
          if (session?.providerSessionId && !internallyPaid) {
            await defaultAdapter.expireCheckoutSession(session.providerSessionId);
          }
          await env.DB.prepare(`UPDATE _ecommerce_carts SET checkout_session_id = NULL
             WHERE id = ? AND checkout_session_id = ?`).bind(cartId, preparationLock).run();
          throw error;
        }
      },
      async create(data) {
        const orderId = data.id || `ord_${Date.now()}`;
        const now = /* @__PURE__ */ new Date();
        await db.insert(orders).values({
          id: orderId,
          cartId: data.cartId,
          userId: data.userId,
          checkoutSessionId: data.checkoutSessionId,
          paymentProvider: null,
          status: data.status || "draft",
          totalAmount: data.totalAmount,
          currency: data.currency || "usd",
          customerEmail: data.customerEmail,
          items: data.items,
          shippingAddress: data.shippingAddress,
          billingAddress: data.billingAddress,
          createdAt: now,
          updatedAt: now
        });
        return await this.find(orderId);
      },
      async find(id) {
        const order = await db.select().from(orders).where((0, import_drizzle_orm7.eq)(orders.id, id)).get();
        if (!order) return null;
        return order;
      },
      async findForSession(id, sessionToken, customerId) {
        const order = await this.find(id);
        if (!order?.cartId) return null;
        if (customerId && order.userId === customerId) return order;
        if (!sessionToken) return null;
        const cart = await db.select().from(carts).where((0, import_drizzle_orm7.eq)(carts.id, order.cartId)).get();
        return cart?.sessionToken === sessionToken ? order : null;
      },
      async updateStatus(id, status, fulfillment) {
        if (status !== "fulfilled") throw new Error("Use the payment or cancellation workflow to change order status");
        const order = await this.find(id);
        if (order?.paymentProvider === "admin_test") throw new Error("Admin test orders cannot be fulfilled");
        if (!fulfillment) throw new Error("Audited fulfillment details are required");
        await fulfillCommerceOrder(env, fulfillment.actor, {
          orderId: id,
          carrier: fulfillment.carrier,
          trackingNumber: fulfillment.trackingNumber,
          note: fulfillment.note
        });
        return await this.find(id);
      },
      async finalizePayment(id, options2) {
        return finalizeOrderPayment({
          orderId: id,
          provider: options2.provider,
          providerId: options2.providerId,
          paymentIntentId: options2.paymentIntentId,
          paymentStatus: options2.paymentStatus,
          amount: options2.amount,
          currency: options2.currency,
          customerEmail: options2.customerEmail
        });
      },
      async cancel(id, options2 = {}) {
        const order = await db.select().from(orders).where((0, import_drizzle_orm7.eq)(orders.id, id)).get();
        if (!order) return null;
        if (["paid", "fulfilled", "partially_refunded", "refunded"].includes(order.status)) return order;
        const timestamp = Math.floor(Date.now() / 1e3);
        if (order.status === "cancelled") return order;
        const reservations = await db.select().from(componentReservations).where((0, import_drizzle_orm7.eq)(componentReservations.orderId, id));
        const inventoryReservations2 = await db.select().from(inventoryReservations).where((0, import_drizzle_orm7.eq)(inventoryReservations.orderId, id));
        if (order.checkoutSessionId && !options2.sessionExpired) {
          const adapter = paymentAdapters.find((candidate) => candidate.providerId === (order.paymentProvider ?? "stripe"));
          if (!adapter?.expireCheckoutSession) {
            throw new Error("Payment provider must expire the checkout session before stock can be released");
          }
          const session = await adapter.getCheckoutSession?.(order.checkoutSessionId);
          if (session?.status === "complete") {
            throw new Error("Payment has completed; wait for confirmation before changing the basket");
          }
          if (session?.status !== "expired") {
            await adapter.expireCheckoutSession(order.checkoutSessionId);
          }
        }
        const statements = [
          env.DB.prepare(`UPDATE _ecommerce_orders SET status = 'cancelled', updated_at = ?
            WHERE id = ? AND status NOT IN ('paid', 'fulfilled')`).bind(timestamp, id)
        ];
        statements.push(env.DB.prepare(`UPDATE _ecommerce_discount_redemptions
          SET status = 'cancelled', updated_at = ?
          WHERE order_id = ? AND status = 'reserved'
            AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(timestamp, id, id));
        statements.push(env.DB.prepare(`UPDATE _ecommerce_gift_card_redemptions
          SET status = 'cancelled', updated_at = ?
          WHERE order_id = ? AND status = 'reserved'
            AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(timestamp, id, id));
        if (order.creditApplied > 0) {
          statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
            (id, account_id, order_id, kind, amount_cents, created_at)
            SELECT ?, user_id, id, 'checkout_release', credit_applied, ?
            FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled' AND user_id IS NOT NULL
            ON CONFLICT(order_id, kind) DO NOTHING`).bind(`credit_release_${id}`, timestamp, id));
        }
        for (const reservation of reservations) {
          statements.push(env.DB.prepare(`UPDATE _ecommerce_components
            SET quantity = quantity + (SELECT quantity FROM _ecommerce_component_reservations
              WHERE id = ? AND released_at IS NULL), updated_at = ?
            WHERE id = ? AND EXISTS (SELECT 1 FROM _ecommerce_component_reservations
              WHERE id = ? AND released_at IS NULL)
              AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(reservation.id, timestamp, reservation.componentId, reservation.id, id));
          statements.push(env.DB.prepare(`UPDATE _ecommerce_component_reservations SET released_at = ?
            WHERE id = ? AND released_at IS NULL
              AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(timestamp, reservation.id, id));
        }
        for (const reservation of inventoryReservations2) {
          const table = reservation.targetType === "product" ? "_ecommerce_products" : reservation.targetType === "variant" ? "_ecommerce_product_variants" : "_ecommerce_stocks";
          const column = reservation.targetType === "stock" ? "quantity" : "inventory_quantity";
          statements.push(env.DB.prepare(`UPDATE ${table}
            SET ${column} = ${column} + (SELECT quantity FROM _ecommerce_inventory_reservations
              WHERE id = ? AND released_at IS NULL), updated_at = ?
            WHERE id = ? AND EXISTS (SELECT 1 FROM _ecommerce_inventory_reservations
              WHERE id = ? AND released_at IS NULL)
              AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(reservation.id, timestamp, reservation.targetId, reservation.id, id));
          statements.push(env.DB.prepare(`UPDATE _ecommerce_inventory_reservations SET released_at = ?
            WHERE id = ? AND released_at IS NULL
              AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(timestamp, reservation.id, id));
        }
        if (order.cartId) {
          statements.push(env.DB.prepare(`UPDATE _ecommerce_carts
            SET checkout_session_id = NULL, updated_at = ?
            WHERE id = ? AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`).bind(timestamp, order.cartId, id));
          statements.push(env.DB.prepare(`UPDATE _ecommerce_orders SET cart_id = NULL
            WHERE id = ? AND status = 'cancelled'`).bind(id));
        }
        await env.DB.batch(statements);
        return await this.find(id);
      }
    },
    webhooks: {
      async handleStripe(payload, signature, secret) {
        const stripeAdapter = paymentAdapters.find((a) => a.providerId === "stripe");
        if (!stripeAdapter?.validateWebhook) {
          throw new Error("Stripe adapter not configured options.paymentAdapters");
        }
        const event = await stripeAdapter.validateWebhook(payload, signature, secret || "");
        if (event.type === "checkout.session.completed") {
          const session = event.data;
          if (session.metadata?.giftCardPurchaseId) {
            return confirmGiftCardPurchase(env, session);
          }
          const orderId = session.metadata?.orderId || session.client_reference_id;
          if (session.payment_status !== "paid") {
            return { success: true, event: event.type, ignored: true };
          }
          if (orderId) {
            return finalizeOrderPayment({
              orderId,
              provider: "stripe",
              providerId: session.id,
              paymentStatus: session.payment_status === "paid" ? "success" : "pending",
              amount: session.amount_total || 0,
              currency: session.currency,
              paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : void 0,
              customerEmail: session.customer_details?.email || session.customer_email
            });
          }
        }
        if (event.type === "checkout.session.expired") {
          const session = event.data;
          if (session.metadata?.giftCardPurchaseId) {
            await expireGiftCardPurchase(env, session.metadata.giftCardPurchaseId, session.id);
            return { success: true, event: event.type };
          }
          const orderId = session.metadata?.orderId || session.client_reference_id;
          if (orderId) {
            const order = await db.select().from(orders).where((0, import_drizzle_orm7.eq)(orders.id, orderId)).get();
            if (order?.checkoutSessionId === session.id) {
              const cancelled = await bindCommerceApi(options).orders.cancel(orderId, { sessionExpired: true });
              return { success: true, event: event.type, cancelled: cancelled?.status === "cancelled" };
            }
          }
        }
        if (event.type === "charge.refunded") {
          const charge = event.data;
          if (typeof charge.payment_intent !== "string") {
            return { success: true, event: event.type, ignored: true };
          }
          const giftPurchaseRefund = await recordGiftCardPurchaseRefund(env, {
            paymentIntentId: charge.payment_intent,
            amount: charge.amount,
            amountRefunded: charge.amount_refunded,
            currency: charge.currency
          });
          if (giftPurchaseRefund) return giftPurchaseRefund;
          return recordProviderRefund({
            paymentIntentId: charge.payment_intent,
            amount: charge.amount,
            amountRefunded: charge.amount_refunded,
            currency: charge.currency
          });
        }
        return { success: true, event: event.type, ignored: true };
      }
    },
    // Stub for DO binding
    inventory: {
      async reserve(productId, variantId, quantity) {
        if (!env["INVENTORY_DO"]) {
          console.warn("[Talisman Commerce] INVENTORY_DO binding not found. Falling back to optimistic reservation.");
          return { success: true, reserved: quantity, pessimistic: false };
        }
        return { success: true, reserved: quantity, pessimistic: true };
      }
    }
  };
}
async function reconcileCommerce(options, limit = 10) {
  const count2 = Math.max(1, Math.min(20, Math.floor(limit)));
  const { env } = options;
  const api = bindCommerceApi(options);
  const now = Math.floor(Date.now() / 1e3);
  const preparations = await env.DB.prepare(`SELECT id FROM _ecommerce_carts
    WHERE checkout_session_id LIKE 'preparing:%' AND updated_at < ?
    ORDER BY updated_at LIMIT ?`).bind(now - 35 * 60, count2).all();
  const pending = await env.DB.prepare(`SELECT id FROM _ecommerce_orders
    WHERE status = 'pending' AND created_at < ? ORDER BY created_at LIMIT ?`).bind(now - 15 * 60, count2).all();
  const giftPurchases = await env.DB.prepare(`SELECT id FROM _ecommerce_gift_card_purchases
    WHERE status = 'pending' AND provider_session_id IS NOT NULL AND created_at < ?
    ORDER BY created_at LIMIT ?`).bind(now - 15 * 60, count2).all();
  const results = [];
  for (const row of preparations.results ?? []) {
    try {
      await api.orders.resumeFromCart(row.id);
      results.push({ id: row.id, status: "preparation_checked" });
    } catch (error) {
      results.push({ id: row.id, status: "error", error: error instanceof Error ? error.message : "Recovery failed" });
    }
  }
  for (const row of pending.results ?? []) {
    try {
      const result = await api.orders.reconcilePending(row.id);
      results.push({ id: row.id, status: result?.status ?? "unchanged" });
    } catch (error) {
      results.push({ id: row.id, status: "error", error: error instanceof Error ? error.message : "Recovery failed" });
    }
  }
  const stripe = options.paymentAdapters?.find((adapter) => adapter.providerId === "stripe");
  for (const row of giftPurchases.results ?? []) {
    try {
      if (!stripe) throw new Error("Stripe adapter is unavailable");
      const result = await reconcileGiftCardPurchase(env, stripe, row.id);
      results.push({ id: row.id, status: result?.status ?? "unchanged" });
    } catch (error) {
      results.push({ id: row.id, status: "error", error: error instanceof Error ? error.message : "Recovery failed" });
    }
  }
  await env.DB.prepare(`DELETE FROM _ecommerce_customer_sessions
    WHERE (purpose = 'email_challenge' AND expires_at < ?)
      OR (purpose = 'session' AND expires_at < ?)`).bind(now - 24 * 60 * 60, now - 30 * 24 * 60 * 60).run();
  return results;
}

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

// src/routes/ecommerce-admin-reconcile.ts
var POST = async ({ request }) => {
  const authorization = await (0, import_guard.authorizeCmsRequest)(request, "admin");
  if (authorization.response) return authorization.response;
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Same-origin request required" }, { status: 403 });
  }
  try {
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env;
    const results = await reconcileCommerce({
      env: runtimeEnv,
      paymentAdapters: runtimePaymentAdapters(runtimeEnv)
    });
    return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Reconciliation failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  POST
});
