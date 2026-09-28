// src/schema.ts
import { defineRelations, sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user as cmsUsers } from "talisman-cms/auth/local-schema";
var money = (column, rule) => rule === "positive" ? sql`${column} > 0` : sql`${column} >= 0`;
var literals = (values) => sql.raw(values.map((value) => `'${value}'`).join(", "));
var oneOf = (column, values) => sql`${column} IN (${literals(values)})`;
var nullOrOneOf = (column, values) => sql`${column} IS NULL OR ${column} IN (${literals(values)})`;
var flag = (column) => sql`${column} IN (0, 1)`;
var trimmed = (column, minLength) => sql`length(trim(${column})) >= ${sql.raw(String(minLength))}`;
var filled = (column) => sql`length(trim(${column})) > 0`;
var reconcileColumns = () => ({
  reconcileAttempts: integer("reconcile_attempts").notNull().default(0),
  reconcileLastAt: integer("reconcile_last_at", { mode: "timestamp" }),
  reconcileLastError: text("reconcile_last_error"),
  reconcileReviewAt: integer("reconcile_review_at", { mode: "timestamp" })
});
var reconcileChecks = (table, columns) => [
  check(`${table}_reconcile_attempts_nonnegative`, money(columns.reconcileAttempts, "nonnegative"))
];
var taxSyncColumns = () => ({
  taxSyncAttempts: integer("tax_sync_attempts").notNull().default(0),
  taxSyncLastAt: integer("tax_sync_last_at", { mode: "timestamp" }),
  taxSyncLastError: text("tax_sync_last_error")
});
var taxSyncChecks = (table, columns) => [
  check(`${table}_tax_sync_attempts_nonnegative`, money(columns.taxSyncAttempts, "nonnegative"))
];
var carts = sqliteTable("_ecommerce_carts", {
  id: text("id").primaryKey(),
  // Usually mapped to a session generic ID
  sessionToken: text("session_token").unique(),
  // For guest checkout
  userId: text("user_id"),
  // Optional, references standard 'users' if logged in
  checkoutSessionId: text("checkout_session_id"),
  version: integer("version").notNull().default(0),
  items: text("items", { mode: "json" }).$type().notNull().default([]),
  closed: integer("closed", { mode: "boolean" }).notNull().default(false),
  closedAt: integer("closed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
}, (table) => [
  // Named, because the checkout resume and the stale-checkout sweep read this index by name in their query plans.
  uniqueIndex("_ecommerce_carts_checkout_session_id_unique").on(table.checkoutSessionId),
  // One open cart per signed-in shopper.
  uniqueIndex("_ecommerce_carts_user_open_unique").on(table.userId).where(sql`${table.closed} = 0 AND ${table.userId} IS NOT NULL`)
]);
var FULFILLMENT_STATUSES = ["unfulfilled", "partially_fulfilled", "fulfilled"];
var orders = sqliteTable("_ecommerce_orders", {
  id: text("id").primaryKey(),
  cartId: text("cart_id").references(() => carts.id).unique(),
  userId: text("user_id"),
  // Optional, references standard 'users' if logged in
  checkoutSessionId: text("checkout_session_id"),
  // e.g. Stripe Checkout Session ID
  paymentIntentId: text("payment_intent_id").unique(),
  providerRefundedCents: integer("provider_refunded_cents").notNull().default(0),
  paymentProvider: text("payment_provider"),
  // e.g. stripe or admin_test
  referralCode: text("referral_code"),
  referralRewardCents: integer("referral_reward_cents").notNull().default(0),
  discountCode: text("discount_code"),
  discountAmount: integer("discount_amount").notNull().default(0),
  giftCardId: text("gift_card_id"),
  giftCardApplied: integer("gift_card_applied").notNull().default(0),
  giftCardRefundedCents: integer("gift_card_refunded_cents").notNull().default(0),
  creditApplied: integer("credit_applied").notNull().default(0),
  subtotalAmount: integer("subtotal_amount").notNull().default(0),
  shippingAmount: integer("shipping_amount").notNull().default(0),
  shippingRateId: text("shipping_rate_id"),
  shippingLabel: text("shipping_label"),
  taxAmount: integer("tax_amount").notNull().default(0),
  /** `exclusive` tax is added to the amount due; `inclusive` tax is already inside the amounts and only recorded. */
  taxBehavior: text("tax_behavior").$type(),
  taxCalculationId: text("tax_calculation_id"),
  taxTransactionId: text("tax_transaction_id"),
  // Payment: draft, pending, paid, partially_refunded, refunded, disputed or cancelled. The legacy
  // 'fulfilled' is still read as paid.
  status: text("status").notNull().default("draft"),
  /** Shipping, kept apart from payment so that a refund never hides a shipment. */
  fulfillmentStatus: text("fulfillment_status").$type().notNull().default("unfulfilled"),
  items: text("items", { mode: "json" }).$type().notNull().default([]),
  totalAmount: integer("total_amount").notNull(),
  currency: text("currency").notNull().default("usd"),
  customerEmail: text("customer_email"),
  shippingAddress: text("shipping_address", { mode: "json" }).$type(),
  billingAddress: text("billing_address", { mode: "json" }).$type(),
  ...reconcileColumns(),
  ...taxSyncColumns(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
}, (table) => [
  index("_ecommerce_orders_user_idx").on(table.userId),
  index("_ecommerce_orders_checkout_session_idx").on(table.checkoutSessionId),
  // Order emails are looked up in lower case.
  index("_ecommerce_orders_customer_email_idx").on(sql`lower(${table.customerEmail})`),
  // Checkout reconciliation reads pending orders by age.
  index("_ecommerce_orders_pending_idx").on(table.createdAt).where(sql`${table.status} = 'pending'`),
  // The admin orders queue: real orders that can still ship, and real orders past checkout.
  index("_ecommerce_orders_awaiting_idx").on(table.createdAt, table.id).where(sql`${table.status} IN ('paid', 'partially_refunded') AND ${table.fulfillmentStatus} <> 'fulfilled' AND COALESCE(${table.paymentProvider}, 'stripe') <> 'admin_test'`),
  index("_ecommerce_orders_recent_idx").on(table.createdAt, table.id).where(sql`${table.status} NOT IN ('pending', 'cancelled', 'draft') AND COALESCE(${table.paymentProvider}, 'stripe') <> 'admin_test'`),
  // The tax passes: refunded orders with a tax transaction to reverse, and paid orders whose transaction is missing.
  index("_ecommerce_orders_tax_refunded_idx").on(table.createdAt).where(sql`${table.status} IN ('partially_refunded', 'refunded') AND ${table.taxTransactionId} IS NOT NULL`),
  index("_ecommerce_orders_tax_transaction_missing_idx").on(table.status, table.createdAt).where(sql`${table.taxCalculationId} IS NOT NULL AND ${table.taxTransactionId} IS NULL`),
  check("orders_referral_reward_nonnegative", money(table.referralRewardCents, "nonnegative")),
  check("orders_credit_applied_nonnegative", money(table.creditApplied, "nonnegative")),
  check("orders_subtotal_nonnegative", money(table.subtotalAmount, "nonnegative")),
  check("orders_provider_refunded_nonnegative", money(table.providerRefundedCents, "nonnegative")),
  check("orders_discount_nonnegative", money(table.discountAmount, "nonnegative")),
  check("orders_gift_card_applied_nonnegative", money(table.giftCardApplied, "nonnegative")),
  check("orders_gift_card_refunded_within_applied", sql`${table.giftCardRefundedCents} >= 0 AND ${table.giftCardRefundedCents} <= ${table.giftCardApplied}`),
  check("orders_shipping_nonnegative", money(table.shippingAmount, "nonnegative")),
  check("orders_tax_nonnegative", money(table.taxAmount, "nonnegative")),
  check("orders_tax_behavior", nullOrOneOf(table.taxBehavior, ["inclusive", "exclusive"])),
  check("orders_fulfillment_status", oneOf(table.fulfillmentStatus, FULFILLMENT_STATUSES)),
  ...reconcileChecks("orders", table),
  ...taxSyncChecks("orders", table)
]);
var payments = sqliteTable("_ecommerce_payments", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  provider: text("provider").notNull(),
  // 'stripe', 'paypal'
  providerId: text("provider_id").notNull(),
  // pi_12345
  status: text("status").notNull(),
  amount: integer("amount").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
}, (table) => [
  uniqueIndex("_ecommerce_payments_provider_id_unique").on(table.provider, table.providerId),
  index("_ecommerce_payments_order_idx").on(table.orderId)
]);
var providerRefunds = sqliteTable("_ecommerce_provider_refunds", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  provider: text("provider").notNull(),
  /** The provider's id for the refund, when the event names it. */
  providerRefundId: text("provider_refund_id"),
  amountCents: integer("amount_cents").notNull(),
  /** When the provider issued the refund; null when unknown. */
  createdAt: integer("created_at", { mode: "timestamp" })
}, (table) => [
  index("_ecommerce_provider_refunds_order_idx").on(table.orderId),
  check("provider_refund_amount_positive", money(table.amountCents, "positive"))
]);
var products = sqliteTable("_ecommerce_products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  sku: text("sku"),
  description: text("description"),
  images: text("images", { mode: "json" }).$type().notNull().default([]),
  categoryIds: text("category_ids", { mode: "json" }).$type().notNull().default([]),
  tagIds: text("tag_ids", { mode: "json" }).$type().notNull().default([]),
  basePrice: integer("base_price").notNull().default(0),
  // In smallest currency unit (cents)
  isPhysical: integer("is_physical", { mode: "boolean" }).notNull().default(true),
  inventoryQuantity: integer("inventory_quantity").notNull().default(0),
  type: text("type").notNull().default("standard"),
  // standard, digital, subscription
  status: text("status").notNull().default("draft"),
  // draft, active, archived
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});
var variants = sqliteTable("_ecommerce_variants", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});
var productVariants = sqliteTable("_ecommerce_product_variants", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => products.id),
  variantId: text("variant_id").references(() => variants.id),
  name: text("name").notNull(),
  // e.g., 'Large / Blue'
  sku: text("sku").unique(),
  priceOverride: integer("price_override"),
  // Overrides basePrice if set
  inventoryQuantity: integer("inventory_quantity").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});
var productVariantValues = sqliteTable("_ecommerce_product_variant_values", {
  id: text("id").primaryKey(),
  productVariantId: text("product_variant_id").notNull().references(() => productVariants.id),
  value: text("value").notNull(),
  sku: text("sku").unique(),
  image: text("image"),
  priceOverride: integer("price_override"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});
var stocks = sqliteTable("_ecommerce_stocks", {
  id: text("id").primaryKey(),
  productVariantValueId: text("product_variant_value_id").notNull().references(() => productVariantValues.id).unique(),
  quantity: integer("quantity").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});
var components = sqliteTable("_ecommerce_components", {
  id: text("id").primaryKey(),
  sku: text("sku").notNull().unique(),
  name: text("name").notNull(),
  quantity: integer("quantity").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
}, (table) => [check("component_quantity_nonnegative", money(table.quantity, "nonnegative"))]);
var variantComponents = sqliteTable("_ecommerce_variant_components", {
  id: text("id").primaryKey(),
  productVariantValueId: text("product_variant_value_id").notNull().references(() => productVariantValues.id),
  componentId: text("component_id").notNull().references(() => components.id),
  quantity: integer("quantity").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
}, (table) => [
  uniqueIndex("variant_component_unique").on(table.productVariantValueId, table.componentId),
  check("variant_component_quantity_positive", money(table.quantity, "positive"))
]);
var componentReservations = sqliteTable("_ecommerce_component_reservations", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  componentId: text("component_id").notNull().references(() => components.id),
  quantity: integer("quantity").notNull(),
  releasedAt: integer("released_at", { mode: "timestamp" })
}, (table) => [
  uniqueIndex("component_reservation_unique").on(table.orderId, table.componentId),
  check("component_reservation_quantity_positive", money(table.quantity, "positive"))
]);
var inventoryReservations = sqliteTable("_ecommerce_inventory_reservations", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  targetType: text("target_type").$type().notNull(),
  targetId: text("target_id").notNull(),
  quantity: integer("quantity").notNull(),
  releasedAt: integer("released_at", { mode: "timestamp" })
}, (table) => [
  uniqueIndex("inventory_reservation_unique").on(table.orderId, table.targetType, table.targetId),
  check("inventory_reservation_target_type", oneOf(table.targetType, ["product", "variant", "stock"])),
  check("inventory_reservation_quantity_positive", money(table.quantity, "positive"))
]);
var categories = sqliteTable("_ecommerce_categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  image: text("image"),
  parentId: text("parent_id").references(() => categories.id),
  // Self-referencing for hierarchy
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});
var productCategories = sqliteTable("_ecommerce_product_categories", {
  productId: text("product_id").notNull().references(() => products.id),
  categoryId: text("category_id").notNull().references(() => categories.id)
}, (table) => [primaryKey({ columns: [table.productId, table.categoryId] })]);
var tags = sqliteTable("_ecommerce_tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("blue"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});
var productTags = sqliteTable("_ecommerce_product_tags", {
  productId: text("product_id").notNull().references(() => products.id),
  tagId: text("tag_id").notNull().references(() => tags.id)
}, (table) => [primaryKey({ columns: [table.productId, table.tagId] })]);
var customers = sqliteTable("_ecommerce_customers", {
  id: text("id").primaryKey(),
  // A generic stripe-ready customer ID
  name: text("name"),
  email: text("email"),
  stripeCustomerId: text("stripe_customer_id").unique(),
  userId: text("user_id"),
  // Optional, references standard 'users' if logged in
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});
var customerAccounts = sqliteTable("_ecommerce_customer_accounts", {
  id: text("id").primaryKey(),
  cmsUserId: text("cms_user_id").references(() => cmsUsers.id, { onDelete: "set null" }),
  email: text("email").notNull(),
  emailNormalized: text("email_normalized").notNull().unique(),
  emailVerifiedAt: integer("email_verified_at", { mode: "timestamp" }),
  name: text("name"),
  creditBalance: integer("credit_balance").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
}, (table) => [
  uniqueIndex("_ecommerce_customer_accounts_cms_user_idx").on(table.cmsUserId).where(sql`${table.cmsUserId} IS NOT NULL`)
]);
var customerSessions = sqliteTable("_ecommerce_customer_sessions", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => customerAccounts.id, { onDelete: "cascade" }),
  orderId: text("order_id").unique(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
  /** `email_challenge` rows came from the sign-in links of earlier releases; links use `signInTokens`. */
  purpose: text("purpose").$type().notNull().default("session")
}, (table) => [
  index("_ecommerce_customer_sessions_account_idx").on(table.accountId),
  index("_ecommerce_customer_sessions_challenge_idx").on(table.accountId, table.purpose, table.createdAt),
  check("customer_session_purpose", oneOf(table.purpose, ["session", "email_challenge"]))
]);
var signInTokens = sqliteTable("_ecommerce_sign_in_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  emailNormalized: text("email_normalized").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp" })
}, (table) => [index("_ecommerce_sign_in_tokens_email_idx").on(table.emailNormalized, table.createdAt)]);
var rateLimits = sqliteTable("_ecommerce_rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStart: integer("window_start").notNull()
});
var fulfillments = sqliteTable("_ecommerce_fulfillments", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  adminActor: text("admin_actor").notNull(),
  carrier: text("carrier"),
  trackingNumber: text("tracking_number"),
  /** The shipment note, or the reason for a correction. */
  note: text("note").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  kind: text("kind").$type().notNull().default("shipment"),
  /** The shipment a correction restates; null for a shipment. */
  correctsId: text("corrects_id").references(() => fulfillments.id),
  /** Whether a shipment completes its order; false for one parcel of a split shipment. */
  completesOrder: integer("completes_order", { mode: "boolean" }).notNull().default(true)
}, (table) => [
  index("_ecommerce_fulfillments_order_idx").on(table.orderId, table.createdAt),
  check("fulfillment_kind", oneOf(table.kind, ["shipment", "correction"])),
  check("fulfillment_completes_order_flag", flag(table.completesOrder)),
  check("fulfillment_correction_names_shipment", sql`(${table.kind} = 'shipment') = (${table.correctsId} IS NULL)`),
  check("fulfillment_only_shipment_completes", sql`${table.kind} = 'shipment' OR ${table.completesOrder} = 0`)
]);
var referralCodes = sqliteTable("_ecommerce_referral_codes", {
  code: text("code").primaryKey(),
  accountId: text("account_id").notNull().references(() => customerAccounts.id, { onDelete: "cascade" }).unique(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
});
var referrals = sqliteTable("_ecommerce_referrals", {
  id: text("id").primaryKey(),
  code: text("code").notNull().references(() => referralCodes.code),
  referrerAccountId: text("referrer_account_id").notNull().references(() => customerAccounts.id),
  referredAccountId: text("referred_account_id").notNull().references(() => customerAccounts.id).unique(),
  orderId: text("order_id").notNull().references(() => orders.id).unique(),
  rewardCents: integer("reward_cents").notNull(),
  currency: text("currency").notNull().default("usd"),
  status: text("status").$type().notNull().default("approved"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
}, (table) => [
  index("_ecommerce_referrals_referrer_idx").on(table.referrerAccountId, table.createdAt),
  check("referral_reward_nonnegative", money(table.rewardCents, "nonnegative")),
  check("referral_status", oneOf(table.status, ["approved", "void"]))
]);
var CREDIT_LEDGER_KINDS = ["referral_award", "welcome_award", "checkout_reserve", "checkout_release", "purchase_credit_refund", "referral_reversal", "welcome_reversal"];
var creditLedger = sqliteTable("_ecommerce_credit_ledger", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => customerAccounts.id),
  orderId: text("order_id").notNull().references(() => orders.id),
  kind: text("kind").$type().notNull(),
  amountCents: integer("amount_cents").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
}, (table) => [
  uniqueIndex("credit_ledger_order_kind_unique").on(table.orderId, table.kind),
  index("_ecommerce_credit_ledger_account_idx").on(table.accountId, table.createdAt),
  check("credit_ledger_kind", oneOf(table.kind, CREDIT_LEDGER_KINDS)),
  check("credit_ledger_amount_nonzero", sql`${table.amountCents} != 0`)
]);
var referralSettings = sqliteTable("_ecommerce_referral_settings", {
  id: text("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  rewardCents: integer("reward_cents").notNull().default(1e3),
  minOrderCents: integer("min_order_cents").notNull().default(5e3),
  attributionDays: integer("attribution_days").notNull().default(30),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
}, (table) => [
  check("referral_settings_singleton", sql`${table.id} = 'default'`),
  check("referral_settings_enabled_flag", flag(table.enabled)),
  check("referral_settings_reward_range", sql`${table.rewardCents} BETWEEN 1 AND 100000`),
  check("referral_settings_min_order_range", sql`${table.minOrderCents} BETWEEN 1 AND 10000000`),
  check("referral_settings_attribution_range", sql`${table.attributionDays} BETWEEN 1 AND 90`)
]);
var discountCodes = sqliteTable("_ecommerce_discount_codes", {
  code: text("code").primaryKey(),
  description: text("description"),
  type: text("type").$type().notNull(),
  value: integer("value").notNull(),
  // Store currency minor units for credit/amount, basis points for percent.
  remainingCents: integer("remaining_cents"),
  maxDiscountCents: integer("max_discount_cents"),
  minOrderCents: integer("min_order_cents").notNull().default(0),
  eligibleProductIds: text("eligible_product_ids", { mode: "json" }).$type().notNull().default([]),
  maxUses: integer("max_uses"),
  maxUsesPerCustomer: integer("max_uses_per_customer"),
  firstOrderOnly: integer("first_order_only", { mode: "boolean" }).notNull().default(false),
  startsAt: integer("starts_at", { mode: "timestamp" }),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
}, (table) => [
  check("discount_code_type", oneOf(table.type, ["credit", "amount", "percent"])),
  check("discount_code_value_positive", money(table.value, "positive")),
  check("discount_code_remaining_nonnegative", money(table.remainingCents, "nonnegative")),
  check("discount_code_max_discount_positive", money(table.maxDiscountCents, "positive")),
  check("discount_code_min_order_nonnegative", money(table.minOrderCents, "nonnegative")),
  check("discount_code_max_uses_positive", money(table.maxUses, "positive")),
  check("discount_code_max_uses_per_customer_positive", money(table.maxUsesPerCustomer, "positive")),
  check("discount_code_first_order_only_flag", flag(table.firstOrderOnly)),
  check("discount_code_active_flag", flag(table.active)),
  // A credit voucher has a balance and no cap; an amount code has neither; a percent code is in basis points.
  check("discount_code_type_shape", sql`(${table.type} = 'credit' AND ${table.remainingCents} IS NOT NULL AND ${table.remainingCents} <= ${table.value} AND ${table.maxDiscountCents} IS NULL)
    OR (${table.type} = 'amount' AND ${table.remainingCents} IS NULL AND ${table.maxDiscountCents} IS NULL)
    OR (${table.type} = 'percent' AND ${table.value} BETWEEN 1 AND 10000 AND ${table.remainingCents} IS NULL)`)
]);
var REDEMPTION_STATUSES = ["reserved", "confirmed", "cancelled", "refunded"];
var discountRedemptions = sqliteTable("_ecommerce_discount_redemptions", {
  id: text("id").primaryKey(),
  code: text("code").notNull().references(() => discountCodes.code),
  orderId: text("order_id").notNull().references(() => orders.id).unique(),
  accountId: text("account_id").references(() => customerAccounts.id),
  emailNormalized: text("email_normalized").notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").$type().notNull().default("reserved"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
}, (table) => [
  index("_ecommerce_discount_redemptions_code_status_idx").on(table.code, table.status),
  index("_ecommerce_discount_redemptions_email_idx").on(table.code, table.emailNormalized, table.status),
  check("discount_redemption_amount_positive", money(table.amountCents, "positive")),
  check("discount_redemption_status", oneOf(table.status, REDEMPTION_STATUSES))
]);
var GIFT_CARD_PURCHASE_STATUSES = ["pending", "paid", "cancelled", "partially_refunded", "refunded", "review"];
var giftCardPurchases = sqliteTable("_ecommerce_gift_card_purchases", {
  id: text("id").primaryKey(),
  buyerEmail: text("buyer_email").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("usd"),
  status: text("status").$type().notNull().default("pending"),
  providerSessionId: text("provider_session_id").unique(),
  paymentIntentId: text("payment_intent_id").unique(),
  providerRefundedCents: integer("provider_refunded_cents").notNull().default(0),
  /** The part of providerRefundedCents already settled on the purchase's cards: taken off a reinstated card, or cancelled with void ones. */
  refundAdjustedCents: integer("refund_adjusted_cents").notNull().default(0),
  accessTokenHash: text("access_token_hash").notNull(),
  ...reconcileColumns(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
}, (table) => [
  index("_ecommerce_gift_card_purchases_status_created_idx").on(table.status, table.createdAt),
  check("gift_card_purchase_amount_range", sql`${table.amountCents} BETWEEN 500 AND 100000`),
  check("gift_card_purchase_currency_usd", sql`${table.currency} = 'usd'`),
  check("gift_card_purchase_status", oneOf(table.status, GIFT_CARD_PURCHASE_STATUSES)),
  check("gift_card_purchase_provider_refunded_nonnegative", money(table.providerRefundedCents, "nonnegative")),
  check("gift_card_purchase_refund_adjusted_within_refunded", sql`${table.refundAdjustedCents} >= 0 AND ${table.refundAdjustedCents} <= ${table.providerRefundedCents}`),
  ...reconcileChecks("gift_card_purchase", table)
]);
var giftCards = sqliteTable("_ecommerce_gift_cards", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull().unique(),
  codeSuffix: text("code_suffix").notNull(),
  encryptedCode: text("encrypted_code").notNull(),
  source: text("source").$type().notNull(),
  purchaseId: text("purchase_id").references(() => giftCardPurchases.id).unique(),
  /** Set on an administrator-issued card that took over a purchase's value; a refund of that purchase holds it too. */
  replacesPurchaseId: text("replaces_purchase_id").references(() => giftCardPurchases.id),
  /** Suspended by its purchase's review hold while it was active, so reinstating the purchase reactivates it. */
  heldForReview: integer("held_for_review", { mode: "boolean" }).notNull().default(false),
  adminActor: text("admin_actor"),
  adminReason: text("admin_reason"),
  initialCents: integer("initial_cents").notNull(),
  balanceCents: integer("balance_cents").notNull().default(0),
  currency: text("currency").notNull().default("usd"),
  status: text("status").$type().notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
}, (table) => [
  index("_ecommerce_gift_cards_replaces_purchase_idx").on(table.replacesPurchaseId).where(sql`${table.replacesPurchaseId} IS NOT NULL`),
  check("gift_card_source", oneOf(table.source, ["purchase", "admin"])),
  check("gift_card_initial_range", sql`${table.initialCents} BETWEEN 500 AND 100000`),
  check("gift_card_balance_within_initial", sql`${table.balanceCents} BETWEEN 0 AND ${table.initialCents}`),
  check("gift_card_currency_usd", sql`${table.currency} = 'usd'`),
  check("gift_card_status", oneOf(table.status, ["active", "suspended", "void"])),
  check("gift_card_replacement_by_admin", sql`${table.replacesPurchaseId} IS NULL OR ${table.source} = 'admin'`),
  check("gift_card_held_for_review_flag", flag(table.heldForReview)),
  // A purchased card names its purchase; an administrator's card names who issued it and why.
  check("gift_card_source_shape", sql`(${table.source} = 'purchase' AND ${table.purchaseId} IS NOT NULL AND ${table.adminActor} IS NULL)
    OR (${table.source} = 'admin' AND ${table.purchaseId} IS NULL AND ${table.adminActor} IS NOT NULL AND ${table.adminReason} IS NOT NULL)`)
]);
var GIFT_CARD_LEDGER_KINDS = ["issue", "reserve", "release", "refund_restore", "purchase_reversal"];
var giftCardLedger = sqliteTable("_ecommerce_gift_card_ledger", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull().references(() => giftCards.id),
  orderId: text("order_id").references(() => orders.id),
  purchaseId: text("purchase_id").references(() => giftCardPurchases.id),
  kind: text("kind").$type().notNull(),
  amountCents: integer("amount_cents").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
}, (table) => [
  index("_ecommerce_gift_card_ledger_card_idx").on(table.cardId, table.createdAt),
  check("gift_card_ledger_kind", oneOf(table.kind, GIFT_CARD_LEDGER_KINDS)),
  check("gift_card_ledger_amount_nonzero", sql`${table.amountCents} != 0`),
  // Funding and returns add to the balance; reservations and reversals take from it.
  check("gift_card_ledger_amount_sign", sql`(${table.kind} IN ('issue', 'release', 'refund_restore') AND ${table.amountCents} > 0)
    OR (${table.kind} IN ('reserve', 'purchase_reversal') AND ${table.amountCents} < 0)`)
]);
var giftCardRedemptions = sqliteTable("_ecommerce_gift_card_redemptions", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull().references(() => giftCards.id),
  orderId: text("order_id").notNull().references(() => orders.id).unique(),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").$type().notNull().default("reserved"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
}, (table) => [
  index("_ecommerce_gift_card_redemptions_card_idx").on(table.cardId, table.status),
  check("gift_card_redemption_amount_positive", money(table.amountCents, "positive")),
  check("gift_card_redemption_status", oneOf(table.status, REDEMPTION_STATUSES))
]);
var giftCardRefunds = sqliteTable("_ecommerce_gift_card_refunds", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull().references(() => giftCards.id),
  orderId: text("order_id").notNull().references(() => orders.id),
  amountCents: integer("amount_cents").notNull(),
  adminActor: text("admin_actor").notNull(),
  reason: text("reason").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
}, (table) => [
  index("_ecommerce_gift_card_refunds_order_idx").on(table.orderId),
  check("gift_card_refund_amount_positive", money(table.amountCents, "positive"))
]);
var giftCardReviews = sqliteTable("_ecommerce_gift_card_reviews", {
  id: text("id").primaryKey(),
  purchaseId: text("purchase_id").notNull().references(() => giftCardPurchases.id),
  cardId: text("card_id").notNull().references(() => giftCards.id),
  // The card that held the purchase's value.
  outcome: text("outcome").$type().notNull(),
  refundedCents: integer("refunded_cents").notNull(),
  // The provider refund total the decision covered.
  adjustmentCents: integer("adjustment_cents").notNull(),
  // Taken off the purchase's cards.
  adminActor: text("admin_actor").notNull(),
  reason: text("reason").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
}, (table) => [
  index("_ecommerce_gift_card_reviews_purchase_idx").on(table.purchaseId, table.createdAt),
  check("gift_card_review_outcome", oneOf(table.outcome, ["reinstate", "void"])),
  check("gift_card_review_refunded_positive", money(table.refundedCents, "positive")),
  check("gift_card_review_adjustment_nonnegative", money(table.adjustmentCents, "nonnegative")),
  check("gift_card_review_admin_actor_filled", filled(table.adminActor)),
  check("gift_card_review_reason_length", trimmed(table.reason, 8))
]);
var giftCardOrderRefunds = sqliteTable("_ecommerce_gift_card_order_refunds", {
  orderId: text("order_id").primaryKey().references(() => orders.id),
  adminActor: text("admin_actor").notNull(),
  reason: text("reason").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
});
var taxReversals = sqliteTable("_ecommerce_tax_reversals", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  reference: text("reference").notNull().unique(),
  amount: integer("amount").notNull(),
  // Positive, in the order currency's minor units.
  providerReversalId: text("provider_reversal_id").notNull(),
  ...taxSyncColumns(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
}, (table) => [
  index("_ecommerce_tax_reversals_order_idx").on(table.orderId),
  // Reversals recorded but not sent to the provider yet.
  index("_ecommerce_tax_reversals_unsent_idx").on(table.createdAt).where(sql`${table.providerReversalId} = ''`),
  check("tax_reversal_amount_positive", money(table.amount, "positive")),
  ...taxSyncChecks("tax_reversal", table)
]);
var disputes = sqliteTable("_ecommerce_disputes", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  orderId: text("order_id").references(() => orders.id),
  giftCardPurchaseId: text("gift_card_purchase_id").references(() => giftCardPurchases.id),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull(),
  reason: text("reason"),
  /** The provider's status, such as needs_response, won or lost. */
  status: text("status").notNull(),
  /** The order's or purchase's status before the dispute, which a won dispute restores. */
  statusBefore: text("status_before").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  /** Null while the dispute is open. */
  closedAt: integer("closed_at", { mode: "timestamp" })
}, (table) => [
  index("_ecommerce_disputes_order_idx").on(table.orderId).where(sql`${table.orderId} IS NOT NULL`),
  index("_ecommerce_disputes_purchase_idx").on(table.giftCardPurchaseId).where(sql`${table.giftCardPurchaseId} IS NOT NULL`),
  check("dispute_amount_nonnegative", money(table.amountCents, "nonnegative")),
  check("dispute_names_one_subject", sql`(${table.orderId} IS NULL) <> (${table.giftCardPurchaseId} IS NULL)`)
]);
var restocks = sqliteTable("_ecommerce_restocks", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  reservationType: text("reservation_type").$type().notNull(),
  reservationId: text("reservation_id").notNull(),
  targetType: text("target_type").$type().notNull(),
  targetId: text("target_id").notNull(),
  quantity: integer("quantity").notNull(),
  adminActor: text("admin_actor").notNull(),
  reason: text("reason").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
}, (table) => [
  uniqueIndex("_ecommerce_restocks_reservation_unique").on(table.reservationType, table.reservationId),
  index("_ecommerce_restocks_order_idx").on(table.orderId, table.createdAt),
  check("restock_reservation_type", oneOf(table.reservationType, ["inventory", "component"])),
  check("restock_target_type", oneOf(table.targetType, ["product", "variant", "stock", "component"])),
  check("restock_quantity_positive", money(table.quantity, "positive")),
  check("restock_admin_actor_filled", filled(table.adminActor)),
  check("restock_reason_length", trimmed(table.reason, 8))
]);
var reconcileDecisions = sqliteTable("_ecommerce_reconcile_decisions", {
  id: text("id").primaryKey(),
  orderId: text("order_id").references(() => orders.id),
  purchaseId: text("purchase_id").references(() => giftCardPurchases.id),
  action: text("action").$type().notNull(),
  failure: text("failure"),
  // The failure code the record was parked with.
  // How a released completed checkout's payment was shown to be returned; null for any other decision.
  paymentReturned: text("payment_returned").$type(),
  adminActor: text("admin_actor").notNull(),
  reason: text("reason").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
}, (table) => [
  index("_ecommerce_reconcile_decisions_order_idx").on(table.orderId, table.createdAt),
  index("_ecommerce_reconcile_decisions_purchase_idx").on(table.purchaseId, table.createdAt),
  check("reconcile_decision_action", oneOf(table.action, ["retry", "release"])),
  check("reconcile_decision_payment_returned", nullOrOneOf(table.paymentReturned, ["refunded", "dispute_lost", "confirmed"])),
  check("reconcile_decision_admin_actor_filled", filled(table.adminActor)),
  check("reconcile_decision_reason_length", trimmed(table.reason, 8)),
  check("reconcile_decision_names_one_subject", sql`(${table.orderId} IS NULL) <> (${table.purchaseId} IS NULL)`),
  check("reconcile_decision_release_returns", sql`${table.paymentReturned} IS NULL OR ${table.action} = 'release'`)
]);
var EMAIL_KINDS = ["order_confirmation", "shipment", "shipment_update", "gift_card_claim"];
var EMAIL_STATUSES = ["pending", "sent", "failed", "cancelled"];
var emailDeliveries = sqliteTable("_ecommerce_email_deliveries", {
  id: text("id").primaryKey(),
  kind: text("kind").$type().notNull(),
  /** The order, the shipment or correction (fulfillment id), or the gift card purchase. */
  subjectId: text("subject_id").notNull(),
  status: text("status").$type().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp" }).notNull(),
  claimedAt: integer("claimed_at", { mode: "timestamp" }),
  sentAt: integer("sent_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
}, (table) => [
  uniqueIndex("_ecommerce_email_deliveries_kind_subject_unique").on(table.kind, table.subjectId),
  // The sender reads due emails; only pending ones are ever due.
  index("_ecommerce_email_deliveries_due_idx").on(table.nextAttemptAt).where(sql`${table.status} = 'pending'`),
  check("email_delivery_kind", oneOf(table.kind, EMAIL_KINDS)),
  check("email_delivery_status", oneOf(table.status, EMAIL_STATUSES)),
  check("email_delivery_attempts_nonnegative", money(table.attempts, "nonnegative")),
  check("email_delivery_sent_has_time", sql`(${table.status} = 'sent') = (${table.sentAt} IS NOT NULL)`)
]);
var giftCardClaims = sqliteTable("_ecommerce_gift_card_claims", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  purchaseId: text("purchase_id").notNull().references(() => giftCardPurchases.id),
  /** The card whose code the link shows. */
  cardId: text("card_id").notNull().references(() => giftCards.id),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp" }),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  /** The administrator who resent the link, with the reason; null for the link sent after payment. */
  createdBy: text("created_by"),
  reason: text("reason")
}, (table) => [
  index("_ecommerce_gift_card_claims_purchase_idx").on(table.purchaseId, table.createdAt),
  check("gift_card_claim_expires_after_creation", sql`${table.expiresAt} > ${table.createdAt}`),
  // Spelled out for NULL: a CHECK that evaluates to NULL passes. A resend names who and why, or neither.
  check("gift_card_claim_resend_shape", sql`(${table.createdBy} IS NULL AND ${table.reason} IS NULL)
    OR (${table.createdBy} IS NOT NULL AND ${table.reason} IS NOT NULL AND length(trim(${table.createdBy})) > 0 AND length(trim(${table.reason})) >= 8)`)
]);
var tables = {
  carts,
  orders,
  payments,
  providerRefunds,
  products,
  variants,
  productVariants,
  productVariantValues,
  stocks,
  components,
  variantComponents,
  componentReservations,
  inventoryReservations,
  categories,
  productCategories,
  tags,
  productTags,
  customers,
  customerAccounts,
  customerSessions,
  signInTokens,
  rateLimits,
  fulfillments,
  referralCodes,
  referrals,
  creditLedger,
  referralSettings,
  discountCodes,
  discountRedemptions,
  giftCardPurchases,
  giftCards,
  giftCardLedger,
  giftCardRedemptions,
  giftCardRefunds,
  giftCardReviews,
  giftCardOrderRefunds,
  taxReversals,
  disputes,
  restocks,
  reconcileDecisions,
  emailDeliveries,
  giftCardClaims
};
var relations = defineRelations(tables, (r) => ({
  carts: { orders: r.many.orders() },
  orders: {
    cart: r.one.carts({ from: r.orders.cartId, to: r.carts.id }),
    payments: r.many.payments()
  },
  payments: { order: r.one.orders({ from: r.payments.orderId, to: r.orders.id, optional: false }) },
  products: {
    variants: r.many.productVariants(),
    categories: r.many.productCategories(),
    tags: r.many.productTags()
  },
  variants: { productVariants: r.many.productVariants() },
  productVariants: {
    product: r.one.products({ from: r.productVariants.productId, to: r.products.id, optional: false }),
    variant: r.one.variants({ from: r.productVariants.variantId, to: r.variants.id }),
    values: r.many.productVariantValues()
  },
  productVariantValues: {
    productVariant: r.one.productVariants({ from: r.productVariantValues.productVariantId, to: r.productVariants.id, optional: false }),
    stock: r.one.stocks({ from: r.productVariantValues.id, to: r.stocks.productVariantValueId })
  },
  stocks: {
    productVariantValue: r.one.productVariantValues({ from: r.stocks.productVariantValueId, to: r.productVariantValues.id, optional: false })
  },
  tags: { products: r.many.productTags() },
  productTags: {
    product: r.one.products({ from: r.productTags.productId, to: r.products.id, optional: false }),
    tag: r.one.tags({ from: r.productTags.tagId, to: r.tags.id, optional: false })
  },
  categories: {
    parent: r.one.categories({ from: r.categories.parentId, to: r.categories.id, alias: "category_hierarchy" }),
    children: r.many.categories({ alias: "category_hierarchy" }),
    products: r.many.productCategories()
  },
  productCategories: {
    product: r.one.products({ from: r.productCategories.productId, to: r.products.id, optional: false }),
    category: r.one.categories({ from: r.productCategories.categoryId, to: r.categories.id, optional: false })
  }
}));

export {
  carts,
  FULFILLMENT_STATUSES,
  orders,
  payments,
  providerRefunds,
  products,
  variants,
  productVariants,
  productVariantValues,
  stocks,
  components,
  variantComponents,
  componentReservations,
  inventoryReservations,
  categories,
  productCategories,
  tags,
  productTags,
  customers,
  customerAccounts,
  customerSessions,
  signInTokens,
  rateLimits,
  fulfillments,
  referralCodes,
  referrals,
  CREDIT_LEDGER_KINDS,
  creditLedger,
  referralSettings,
  discountCodes,
  REDEMPTION_STATUSES,
  discountRedemptions,
  GIFT_CARD_PURCHASE_STATUSES,
  giftCardPurchases,
  giftCards,
  GIFT_CARD_LEDGER_KINDS,
  giftCardLedger,
  giftCardRedemptions,
  giftCardRefunds,
  giftCardReviews,
  giftCardOrderRefunds,
  taxReversals,
  disputes,
  restocks,
  reconcileDecisions,
  EMAIL_KINDS,
  EMAIL_STATUSES,
  emailDeliveries,
  giftCardClaims,
  relations
};
