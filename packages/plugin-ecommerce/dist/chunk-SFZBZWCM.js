// src/schema.ts
import { relations } from "drizzle-orm";
import { sqliteTable, text, integer, primaryKey, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
var reconcileColumns = () => ({
  reconcileAttempts: integer("reconcile_attempts").notNull().default(0),
  reconcileLastAt: integer("reconcile_last_at", { mode: "timestamp" }),
  reconcileLastError: text("reconcile_last_error"),
  reconcileReviewAt: integer("reconcile_review_at", { mode: "timestamp" })
});
var taxSyncColumns = () => ({
  taxSyncAttempts: integer("tax_sync_attempts").notNull().default(0),
  taxSyncLastAt: integer("tax_sync_last_at", { mode: "timestamp" }),
  taxSyncLastError: text("tax_sync_last_error")
});
var carts = sqliteTable("_ecommerce_carts", {
  id: text("id").primaryKey(),
  // Usually mapped to a session generic ID
  sessionToken: text("session_token").unique(),
  // For guest checkout
  userId: text("user_id"),
  // Optional, references standard 'users' if logged in
  checkoutSessionId: text("checkout_session_id").unique(),
  version: integer("version").notNull().default(0),
  items: text("items", { mode: "json" }).$type().notNull().default([]),
  closed: integer("closed", { mode: "boolean" }).notNull().default(false),
  closedAt: integer("closed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});
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
  // Payment: draft, pending, paid, partially_refunded, refunded, disputed or cancelled. Migration 0026
  // moved the legacy 'fulfilled' to fulfillmentStatus; readers still accept it.
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
});
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
}, (table) => [uniqueIndex("_ecommerce_payments_provider_id_unique").on(table.provider, table.providerId)]);
var providerRefunds = sqliteTable("_ecommerce_provider_refunds", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  provider: text("provider").notNull(),
  /** The provider's id for the refund, when the event names it. */
  providerRefundId: text("provider_refund_id"),
  amountCents: integer("amount_cents").notNull(),
  /** When the provider issued the refund; null when unknown. */
  createdAt: integer("created_at", { mode: "timestamp" })
});
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
}, (table) => [check("component_quantity_nonnegative", sql`${table.quantity} >= 0`)]);
var variantComponents = sqliteTable("_ecommerce_variant_components", {
  id: text("id").primaryKey(),
  productVariantValueId: text("product_variant_value_id").notNull().references(() => productVariantValues.id),
  componentId: text("component_id").notNull().references(() => components.id),
  quantity: integer("quantity").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
}, (table) => [
  uniqueIndex("variant_component_unique").on(table.productVariantValueId, table.componentId),
  check("variant_component_quantity_positive", sql`${table.quantity} > 0`)
]);
var componentReservations = sqliteTable("_ecommerce_component_reservations", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  componentId: text("component_id").notNull().references(() => components.id),
  quantity: integer("quantity").notNull(),
  releasedAt: integer("released_at", { mode: "timestamp" })
}, (table) => [
  uniqueIndex("component_reservation_unique").on(table.orderId, table.componentId),
  check("component_reservation_quantity_positive", sql`${table.quantity} > 0`)
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
  check("inventory_reservation_quantity_positive", sql`${table.quantity} > 0`)
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
}, (table) => ({
  pk: primaryKey({ columns: [table.productId, table.categoryId] })
}));
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
}, (table) => ({
  pk: primaryKey({ columns: [table.productId, table.tagId] })
}));
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
  cmsUserId: text("cms_user_id").unique(),
  email: text("email").notNull(),
  emailNormalized: text("email_normalized").notNull().unique(),
  emailVerifiedAt: integer("email_verified_at", { mode: "timestamp" }),
  name: text("name"),
  creditBalance: integer("credit_balance").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});
var customerSessions = sqliteTable("_ecommerce_customer_sessions", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => customerAccounts.id, { onDelete: "cascade" }),
  orderId: text("order_id").unique(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
  /** `email_challenge` rows come from sign-in links sent before migration 0024; new links use `signInTokens`. */
  purpose: text("purpose").$type().notNull().default("session")
});
var signInTokens = sqliteTable("_ecommerce_sign_in_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  emailNormalized: text("email_normalized").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp" })
});
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
});
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
}, (table) => [check("referral_reward_nonnegative", sql`${table.rewardCents} >= 0`)]);
var creditLedger = sqliteTable("_ecommerce_credit_ledger", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => customerAccounts.id),
  orderId: text("order_id").notNull().references(() => orders.id),
  kind: text("kind").$type().notNull(),
  amountCents: integer("amount_cents").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
}, (table) => [uniqueIndex("credit_ledger_order_kind_unique").on(table.orderId, table.kind)]);
var referralSettings = sqliteTable("_ecommerce_referral_settings", {
  id: text("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  rewardCents: integer("reward_cents").notNull().default(1e3),
  minOrderCents: integer("min_order_cents").notNull().default(5e3),
  attributionDays: integer("attribution_days").notNull().default(30),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});
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
});
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
});
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
});
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
});
var giftCardLedger = sqliteTable("_ecommerce_gift_card_ledger", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull().references(() => giftCards.id),
  orderId: text("order_id").references(() => orders.id),
  purchaseId: text("purchase_id").references(() => giftCardPurchases.id),
  kind: text("kind").$type().notNull(),
  amountCents: integer("amount_cents").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
});
var giftCardRedemptions = sqliteTable("_ecommerce_gift_card_redemptions", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull().references(() => giftCards.id),
  orderId: text("order_id").notNull().references(() => orders.id).unique(),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").$type().notNull().default("reserved"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});
var giftCardRefunds = sqliteTable("_ecommerce_gift_card_refunds", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull().references(() => giftCards.id),
  orderId: text("order_id").notNull().references(() => orders.id),
  amountCents: integer("amount_cents").notNull(),
  adminActor: text("admin_actor").notNull(),
  reason: text("reason").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
});
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
});
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
});
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
});
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
}, (table) => [uniqueIndex("_ecommerce_restocks_reservation_unique").on(table.reservationType, table.reservationId)]);
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
});
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
}, (table) => [uniqueIndex("_ecommerce_email_deliveries_kind_subject_unique").on(table.kind, table.subjectId)]);
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
});
var cartsRelations = relations(carts, ({ many }) => ({
  orders: many(orders)
}));
var ordersRelations = relations(orders, ({ one, many }) => ({
  cart: one(carts, {
    fields: [orders.cartId],
    references: [carts.id]
  }),
  payments: many(payments)
}));
var paymentsRelations = relations(payments, ({ one }) => ({
  order: one(orders, {
    fields: [payments.orderId],
    references: [orders.id]
  })
}));
var productsRelations = relations(products, ({ many }) => ({
  variants: many(productVariants),
  categories: many(productCategories),
  tags: many(productTags)
}));
var variantsRelations = relations(variants, ({ many }) => ({
  productVariants: many(productVariants)
}));
var productVariantsRelations = relations(productVariants, ({ one, many }) => ({
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
var productVariantValuesRelations = relations(productVariantValues, ({ one }) => ({
  productVariant: one(productVariants, {
    fields: [productVariantValues.productVariantId],
    references: [productVariants.id]
  }),
  stock: one(stocks, {
    fields: [productVariantValues.id],
    references: [stocks.productVariantValueId]
  })
}));
var stocksRelations = relations(stocks, ({ one }) => ({
  productVariantValue: one(productVariantValues, {
    fields: [stocks.productVariantValueId],
    references: [productVariantValues.id]
  })
}));
var tagsRelations = relations(tags, ({ many }) => ({
  products: many(productTags)
}));
var productTagsRelations = relations(productTags, ({ one }) => ({
  product: one(products, {
    fields: [productTags.productId],
    references: [products.id]
  }),
  tag: one(tags, {
    fields: [productTags.tagId],
    references: [tags.id]
  })
}));
var categoriesRelations = relations(categories, ({ one, many }) => ({
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
var productCategoriesRelations = relations(productCategories, ({ one }) => ({
  product: one(products, {
    fields: [productCategories.productId],
    references: [products.id]
  }),
  category: one(categories, {
    fields: [productCategories.categoryId],
    references: [categories.id]
  })
}));

export {
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
  giftCardClaims,
  cartsRelations,
  ordersRelations,
  paymentsRelations,
  productsRelations,
  variantsRelations,
  productVariantsRelations,
  productVariantValuesRelations,
  stocksRelations,
  tagsRelations,
  productTagsRelations,
  categoriesRelations,
  productCategoriesRelations
};
