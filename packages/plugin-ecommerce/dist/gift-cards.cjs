"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/gift-cards.ts
var gift_cards_exports = {};
__export(gift_cards_exports, {
  confirmGiftCardPurchase: () => confirmGiftCardPurchase,
  evaluateGiftCard: () => evaluateGiftCard,
  expireGiftCardPurchase: () => expireGiftCardPurchase,
  getGiftCardBalance: () => getGiftCardBalance,
  getGiftCardsAdmin: () => getGiftCardsAdmin,
  getPurchasedGiftCard: () => getPurchasedGiftCard,
  hashGiftCardSecret: () => hashGiftCardSecret,
  issueAdminGiftCard: () => issueAdminGiftCard,
  reconcileGiftCardPurchase: () => reconcileGiftCardPurchase,
  recordGiftCardPurchaseRefund: () => recordGiftCardPurchaseRefund,
  refundGiftCardOnlyOrder: () => refundGiftCardOnlyOrder,
  refundGiftCardTender: () => refundGiftCardTender,
  setGiftCardActive: () => setGiftCardActive,
  startGiftCardPurchase: () => startGiftCardPurchase
});
module.exports = __toCommonJS(gift_cards_exports);
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
async function decryptCardSecret(env, encrypted) {
  const [iv, ciphertext] = encrypted.split(":");
  if (!iv || !ciphertext) throw new Error("Gift card secret is invalid");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unhex(iv) },
    await encryptionKey(env),
    unhex(ciphertext)
  );
  return new TextDecoder().decode(plaintext);
}
async function issueAdminGiftCard(env, actor, input) {
  const { amountCents, reason } = adminIssueSchema.parse(input);
  if (!actor.trim()) throw new Error("Administrator identity is required");
  const secret = await newCardSecret(env);
  const id = `gift_${crypto.randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1e3);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO _ecommerce_gift_cards
      (id,code_hash,code_suffix,encrypted_code,source,admin_actor,admin_reason,initial_cents,balance_cents,currency,status,created_at,updated_at)
      VALUES (?,?,?,?, 'admin',?,?,?,0,'usd','active',?,?)`).bind(id, secret.codeHash, secret.codeSuffix, secret.encryptedCode, actor, reason, amountCents, timestamp, timestamp),
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,kind,amount_cents,created_at) VALUES (?,?,'issue',?,?)`).bind(`gcl_issue_${id}`, id, amountCents, timestamp)
  ]);
  return { id, code: secret.code, amountCents, currency: "usd" };
}
async function getGiftCardsAdmin(env) {
  const db = (0, import_client.createDbClient)(env);
  return db.select({
    id: giftCards.id,
    codeSuffix: giftCards.codeSuffix,
    source: giftCards.source,
    purchaseId: giftCards.purchaseId,
    adminActor: giftCards.adminActor,
    adminReason: giftCards.adminReason,
    initialCents: giftCards.initialCents,
    balanceCents: giftCards.balanceCents,
    currency: giftCards.currency,
    status: giftCards.status,
    createdAt: giftCards.createdAt
  }).from(giftCards).orderBy(giftCards.createdAt);
}
async function setGiftCardActive(env, id, active) {
  if (!/^gift_[0-9a-f-]{36}$/.test(id) || typeof active !== "boolean") throw new Error("Invalid gift card");
  const db = (0, import_client.createDbClient)(env);
  const card = await db.select().from(giftCards).where((0, import_drizzle_orm3.eq)(giftCards.id, id)).get();
  if (!card || card.status === "void") throw new Error("Gift card is unavailable");
  if (card.purchaseId) {
    const purchase = await db.select().from(giftCardPurchases).where((0, import_drizzle_orm3.eq)(giftCardPurchases.id, card.purchaseId)).get();
    if (purchase?.status !== "paid") throw new Error("Gift card purchase requires review");
  }
  const timestamp = Math.floor(Date.now() / 1e3);
  const result = await env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = ?,updated_at = ?
    WHERE id = ? AND status <> 'void' AND (source = 'admin' OR EXISTS (
      SELECT 1 FROM _ecommerce_gift_card_purchases p WHERE p.id = purchase_id AND p.status = 'paid'))
    RETURNING id`).bind(active ? "active" : "suspended", timestamp, id).all();
  if (!result.results?.length) throw new Error("Gift card purchase requires review");
  return { id, status: active ? "active" : "suspended" };
}
async function evaluateGiftCard(env, code, amountDue) {
  const normalized = code.trim().toUpperCase();
  if (!/^GIFT-[A-F0-9]{32}$/.test(normalized)) throw new Error("Invalid gift card code");
  const db = (0, import_client.createDbClient)(env);
  const card = await db.select().from(giftCards).where((0, import_drizzle_orm3.eq)(giftCards.codeHash, await hashGiftCardSecret(normalized))).get();
  if (!card || card.status !== "active" || card.currency !== "usd" || card.balanceCents <= 0) {
    throw new Error("Gift card is unavailable");
  }
  if (!Number.isSafeInteger(amountDue) || amountDue <= 0) throw new Error("No balance remains to pay");
  const amount = card.balanceCents >= amountDue ? amountDue : Math.min(card.balanceCents, Math.max(0, amountDue - 50));
  if (amount <= 0) throw new Error("Gift card cannot cover this order or a valid split payment");
  return { id: card.id, codeSuffix: card.codeSuffix, amount, remainingCents: card.balanceCents };
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
async function confirmGiftCardPurchase(env, session) {
  const id = session.metadata?.giftCardPurchaseId;
  if (!id) throw new Error("Gift card purchase ID is missing");
  const db = (0, import_client.createDbClient)(env);
  const purchase = await db.select().from(giftCardPurchases).where((0, import_drizzle_orm3.eq)(giftCardPurchases.id, id)).get();
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
  const db = (0, import_client.createDbClient)(env);
  const purchase = await db.select().from(giftCardPurchases).where((0, import_drizzle_orm3.eq)(giftCardPurchases.id, id)).get();
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
async function getPurchasedGiftCard(env, id, accessToken) {
  if (!/^gp_[0-9a-f-]{36}$/.test(id) || !accessToken) return null;
  const db = (0, import_client.createDbClient)(env);
  const purchase = await db.select().from(giftCardPurchases).where((0, import_drizzle_orm3.eq)(giftCardPurchases.id, id)).get();
  if (!purchase || purchase.accessTokenHash !== await hashGiftCardSecret(accessToken)) return null;
  const card = await db.select().from(giftCards).where((0, import_drizzle_orm3.eq)(giftCards.purchaseId, id)).get();
  return {
    status: purchase.status,
    amountCents: purchase.amountCents,
    code: card && purchase.status === "paid" ? await decryptCardSecret(env, card.encryptedCode) : null,
    balanceCents: card?.balanceCents ?? null
  };
}
async function recordGiftCardPurchaseRefund(env, params) {
  const db = (0, import_client.createDbClient)(env);
  const purchase = await db.select().from(giftCardPurchases).where((0, import_drizzle_orm3.eq)(giftCardPurchases.paymentIntentId, params.paymentIntentId)).get();
  if (!purchase) return null;
  if (purchase.amountCents !== params.amount || params.currency.toLowerCase() !== "usd" || !Number.isSafeInteger(params.amountRefunded) || params.amountRefunded < 0 || params.amountRefunded > purchase.amountCents) throw new Error("Gift card refund does not match purchase");
  if (params.amountRefunded <= purchase.providerRefundedCents) return { success: true, duplicate: true };
  const card = await db.select().from(giftCards).where((0, import_drizzle_orm3.eq)(giftCards.purchaseId, purchase.id)).get();
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
var refundSchema = import_zod.z.object({
  orderId: import_zod.z.string().regex(/^ord_[0-9a-f-]{36}$/),
  reason: import_zod.z.string().trim().min(8).max(500),
  amountCents: import_zod.z.number().int().positive().optional()
}).strict();
async function refundGiftCardTender(env, actor, input) {
  const values = refundSchema.parse(input);
  if (!actor.trim()) throw new Error("Administrator identity is required");
  const row = await env.DB.prepare(`SELECT id,gift_card_id,gift_card_applied,gift_card_refunded_cents,status
    FROM _ecommerce_orders WHERE id = ?`).bind(values.orderId).all();
  const current = row.results?.[0];
  if (!current?.gift_card_id || !["paid", "fulfilled", "partially_refunded"].includes(current.status)) {
    throw new Error("Order is unavailable for a gift card refund");
  }
  const remaining = current.gift_card_applied - current.gift_card_refunded_cents;
  if (!values.amountCents || values.amountCents > remaining) throw new Error("Refund exceeds gift card payment");
  const id = `gfr_${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO _ecommerce_gift_card_refunds
    (id,card_id,order_id,amount_cents,admin_actor,reason,created_at)
    VALUES (?,?,?,?,?,?,?)`).bind(
    id,
    current.gift_card_id,
    values.orderId,
    values.amountCents,
    actor,
    values.reason,
    Math.floor(Date.now() / 1e3)
  ).run();
  return { id, orderId: values.orderId, amountCents: values.amountCents };
}
async function refundGiftCardOnlyOrder(env, actor, input) {
  const values = refundSchema.parse(input);
  if (!actor.trim() || values.amountCents !== void 0) throw new Error("Invalid full refund request");
  const row = await env.DB.prepare(`SELECT id,gift_card_id,gift_card_applied,gift_card_refunded_cents,
    credit_applied,payment_provider,total_amount,status,user_id FROM _ecommerce_orders WHERE id = ?`).bind(values.orderId).all();
  const order = row.results?.[0];
  if (!order || order.payment_provider !== "gift_card" || order.total_amount !== 0 || !["paid", "partially_refunded", "fulfilled"].includes(order.status)) {
    throw new Error("Only paid gift-card-only orders can be refunded here");
  }
  const now = Math.floor(Date.now() / 1e3);
  const remaining = order.gift_card_applied - order.gift_card_refunded_cents;
  const statements = [
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_order_refunds
      (order_id,admin_actor,reason,created_at) VALUES (?,?,?,?)`).bind(order.id, actor, values.reason, now)
  ];
  if (remaining > 0) statements.push(env.DB.prepare(`INSERT INTO _ecommerce_gift_card_refunds
    (id,card_id,order_id,amount_cents,admin_actor,reason,created_at)
    VALUES (?,?,?,?,?,?,?)`).bind(`gfr_full_${order.id}`, order.gift_card_id, order.id, remaining, actor, values.reason, now));
  statements.push(env.DB.prepare(`UPDATE _ecommerce_orders SET status = 'refunded',updated_at = ?
    WHERE id = ? AND payment_provider = 'gift_card' AND total_amount = 0
      AND status IN ('paid','fulfilled','partially_refunded')`).bind(now, order.id));
  statements.push(env.DB.prepare(`UPDATE _ecommerce_gift_card_redemptions SET status = 'refunded',updated_at = ?
    WHERE order_id = ? AND status = 'confirmed'`).bind(now, order.id));
  statements.push(env.DB.prepare(`UPDATE _ecommerce_discount_redemptions SET status = 'refunded',updated_at = ?
    WHERE order_id = ? AND status = 'confirmed'`).bind(now, order.id));
  if (order.credit_applied > 0 && order.user_id) statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
    (id,account_id,order_id,kind,amount_cents,created_at)
    VALUES (?, ?, ?, 'purchase_credit_refund', ?, ?) ON CONFLICT(order_id,kind) DO NOTHING`).bind(`credit_refund_${order.id}`, order.user_id, order.id, order.credit_applied, now));
  statements.push(env.DB.prepare(`UPDATE _ecommerce_payments SET status = 'refunded' WHERE order_id = ?`).bind(order.id));
  await env.DB.batch(statements);
  return { orderId: order.id, status: "refunded" };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  confirmGiftCardPurchase,
  evaluateGiftCard,
  expireGiftCardPurchase,
  getGiftCardBalance,
  getGiftCardsAdmin,
  getPurchasedGiftCard,
  hashGiftCardSecret,
  issueAdminGiftCard,
  reconcileGiftCardPurchase,
  recordGiftCardPurchaseRefund,
  refundGiftCardOnlyOrder,
  refundGiftCardTender,
  setGiftCardActive,
  startGiftCardPurchase
});
