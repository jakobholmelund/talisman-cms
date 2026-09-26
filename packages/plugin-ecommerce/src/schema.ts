import { relations } from 'drizzle-orm';
import { sqliteTable, text, integer, primaryKey, uniqueIndex, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * Reconciliation of a pending order or gift card purchase (migration 0029): the attempts so far, when
 * the last one ran and its failure code, and when a permanent failure parked the row for an
 * administrator. Codes are listed in reconcile.ts.
 */
const reconcileColumns = () => ({
  reconcileAttempts: integer('reconcile_attempts').notNull().default(0),
  reconcileLastAt: integer('reconcile_last_at', { mode: 'timestamp' }),
  reconcileLastError: text('reconcile_last_error'),
  reconcileReviewAt: integer('reconcile_review_at', { mode: 'timestamp' }),
});

/**
 * The tax passes of reconcileCommerce (migration 0029): the failed attempts at an order's tax record or
 * reversal, or at sending a reversal, when the last one ran and its failure code (codes are listed in
 * reconcile.ts). A success clears them.
 */
const taxSyncColumns = () => ({
  taxSyncAttempts: integer('tax_sync_attempts').notNull().default(0),
  taxSyncLastAt: integer('tax_sync_last_at', { mode: 'timestamp' }),
  taxSyncLastError: text('tax_sync_last_error'),
});

export const carts = sqliteTable('_ecommerce_carts', {
  id: text('id').primaryKey(), // Usually mapped to a session generic ID
  sessionToken: text('session_token').unique(), // For guest checkout
  userId: text('user_id'), // Optional, references standard 'users' if logged in
  checkoutSessionId: text('checkout_session_id').unique(),
  version: integer('version').notNull().default(0),
  items: text('items', { mode: 'json' }).$type<Array<{ productId: string, variantId?: string, quantity: number }>>().notNull().default([]),
  closed: integer('closed', { mode: 'boolean' }).notNull().default(false),
  closedAt: integer('closed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
});

export const orders = sqliteTable('_ecommerce_orders', {
  id: text('id').primaryKey(),
  cartId: text('cart_id').references(() => carts.id).unique(),
  userId: text('user_id'), // Optional, references standard 'users' if logged in
  checkoutSessionId: text('checkout_session_id'), // e.g. Stripe Checkout Session ID
  paymentIntentId: text('payment_intent_id').unique(),
  providerRefundedCents: integer('provider_refunded_cents').notNull().default(0),
  paymentProvider: text('payment_provider'), // e.g. stripe or admin_test
  referralCode: text('referral_code'),
  referralRewardCents: integer('referral_reward_cents').notNull().default(0),
  discountCode: text('discount_code'),
  discountAmount: integer('discount_amount').notNull().default(0),
  giftCardId: text('gift_card_id'),
  giftCardApplied: integer('gift_card_applied').notNull().default(0),
  giftCardRefundedCents: integer('gift_card_refunded_cents').notNull().default(0),
  creditApplied: integer('credit_applied').notNull().default(0),
  subtotalAmount: integer('subtotal_amount').notNull().default(0),
  shippingAmount: integer('shipping_amount').notNull().default(0),
  shippingRateId: text('shipping_rate_id'),
  shippingLabel: text('shipping_label'),
  taxAmount: integer('tax_amount').notNull().default(0),
  /** `exclusive` tax is added to the amount due; `inclusive` tax is already inside the amounts and only recorded. */
  taxBehavior: text('tax_behavior').$type<'inclusive' | 'exclusive'>(),
  taxCalculationId: text('tax_calculation_id'),
  taxTransactionId: text('tax_transaction_id'),
  // Payment: draft, pending, paid, partially_refunded, refunded, disputed or cancelled. Migration 0026
  // moved the legacy 'fulfilled' to fulfillmentStatus; readers still accept it.
  status: text('status').notNull().default('draft'),
  /** Shipping, kept apart from payment so that a refund never hides a shipment. */
  fulfillmentStatus: text('fulfillment_status').$type<'unfulfilled' | 'partially_fulfilled' | 'fulfilled'>().notNull().default('unfulfilled'),
  items: text('items', { mode: 'json' }).$type<Array<{ productId: string, variantId?: string, quantity: number, priceAtPurchase: number, usesComponents?: boolean }>>().notNull().default([]),
  totalAmount: integer('total_amount').notNull(),
  currency: text('currency').notNull().default('usd'),
  customerEmail: text('customer_email'),
  shippingAddress: text('shipping_address', { mode: 'json' }).$type<{ name?: string, line1?: string, line2?: string, city?: string, state?: string, postalCode?: string, country?: string }>(),
  billingAddress: text('billing_address', { mode: 'json' }).$type<{ name?: string, line1?: string, line2?: string, city?: string, state?: string, postalCode?: string, country?: string }>(),
  ...reconcileColumns(),
  ...taxSyncColumns(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
});

export const payments = sqliteTable('_ecommerce_payments', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id),
  provider: text('provider').notNull(), // 'stripe', 'paypal'
  providerId: text('provider_id').notNull(), // pi_12345
  status: text('status').notNull(),
  amount: integer('amount').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
}, (table) => [uniqueIndex('_ecommerce_payments_provider_id_unique').on(table.provider, table.providerId)]);

/**
 * Payment provider refunds with the time they were issued: one row for each rise in an order's
 * providerRefundedCents, so an order's rows add up to it. Refunds recorded before migration 0028 have
 * no row. Gift card tender refunds are in giftCardRefunds.
 */
export const providerRefunds = sqliteTable('_ecommerce_provider_refunds', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id),
  provider: text('provider').notNull(),
  /** The provider's id for the refund, when the event names it. */
  providerRefundId: text('provider_refund_id'),
  amountCents: integer('amount_cents').notNull(),
  /** When the provider issued the refund; null when unknown. */
  createdAt: integer('created_at', { mode: 'timestamp' }),
});

export const products = sqliteTable('_ecommerce_products', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  sku: text('sku'),
  description: text('description'),
  images: text('images', { mode: 'json' }).$type<string[]>().notNull().default([]),
  categoryIds: text('category_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  tagIds: text('tag_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  basePrice: integer('base_price').notNull().default(0), // In smallest currency unit (cents)
  isPhysical: integer('is_physical', { mode: 'boolean' }).notNull().default(true),
  inventoryQuantity: integer('inventory_quantity').notNull().default(0),
  type: text('type').notNull().default('standard'), // standard, digital, subscription
  status: text('status').notNull().default('draft'), // draft, active, archived
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
});

export const variants = sqliteTable('_ecommerce_variants', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
});

export const productVariants = sqliteTable('_ecommerce_product_variants', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull().references(() => products.id),
  variantId: text('variant_id').references(() => variants.id),
  name: text('name').notNull(), // e.g., 'Large / Blue'
  sku: text('sku').unique(),
  priceOverride: integer('price_override'), // Overrides basePrice if set
  inventoryQuantity: integer('inventory_quantity').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
});

export const productVariantValues = sqliteTable('_ecommerce_product_variant_values', {
  id: text('id').primaryKey(),
  productVariantId: text('product_variant_id').notNull().references(() => productVariants.id),
  value: text('value').notNull(),
  sku: text('sku').unique(),
  image: text('image'),
  priceOverride: integer('price_override'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
});

export const stocks = sqliteTable('_ecommerce_stocks', {
  id: text('id').primaryKey(),
  productVariantValueId: text('product_variant_value_id').notNull().references(() => productVariantValues.id).unique(),
  quantity: integer('quantity').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
});

/** Physical parts that can be shared by several purchasable variant values. */
export const components = sqliteTable('_ecommerce_components', {
  id: text('id').primaryKey(),
  sku: text('sku').notNull().unique(),
  name: text('name').notNull(),
  quantity: integer('quantity').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
}, (table) => [check('component_quantity_nonnegative', sql`${table.quantity} >= 0`) ]);

/** A bill of materials for one sellable variant value. */
export const variantComponents = sqliteTable('_ecommerce_variant_components', {
  id: text('id').primaryKey(),
  productVariantValueId: text('product_variant_value_id').notNull().references(() => productVariantValues.id),
  componentId: text('component_id').notNull().references(() => components.id),
  quantity: integer('quantity').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
}, (table) => [
  uniqueIndex('variant_component_unique').on(table.productVariantValueId, table.componentId),
  check('variant_component_quantity_positive', sql`${table.quantity} > 0`)
]);

/** Checkout holds component stock until payment or cancellation. */
export const componentReservations = sqliteTable('_ecommerce_component_reservations', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id),
  componentId: text('component_id').notNull().references(() => components.id),
  quantity: integer('quantity').notNull(),
  releasedAt: integer('released_at', { mode: 'timestamp' })
}, (table) => [
  uniqueIndex('component_reservation_unique').on(table.orderId, table.componentId),
  check('component_reservation_quantity_positive', sql`${table.quantity} > 0`)
]);

/** Ordinary product, variant, and variant-value stock held during checkout. */
export const inventoryReservations = sqliteTable('_ecommerce_inventory_reservations', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id),
  targetType: text('target_type').$type<'product' | 'variant' | 'stock'>().notNull(),
  targetId: text('target_id').notNull(),
  quantity: integer('quantity').notNull(),
  releasedAt: integer('released_at', { mode: 'timestamp' })
}, (table) => [
  uniqueIndex('inventory_reservation_unique').on(table.orderId, table.targetType, table.targetId),
  check('inventory_reservation_quantity_positive', sql`${table.quantity} > 0`)
]);

export const categories = sqliteTable('_ecommerce_categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  image: text('image'),
  parentId: text('parent_id').references((): AnySQLiteColumn => categories.id), // Self-referencing for hierarchy
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
});

export const productCategories = sqliteTable('_ecommerce_product_categories', {
  productId: text('product_id').notNull().references(() => products.id),
  categoryId: text('category_id').notNull().references(() => categories.id)
}, (table) => ({
  pk: primaryKey({ columns: [table.productId, table.categoryId] })
}));

export const tags = sqliteTable('_ecommerce_tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  color: text('color').notNull().default('blue'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
});

export const productTags = sqliteTable('_ecommerce_product_tags', {
  productId: text('product_id').notNull().references(() => products.id),
  tagId: text('tag_id').notNull().references(() => tags.id)
}, (table) => ({
  pk: primaryKey({ columns: [table.productId, table.tagId] })
}));

export const customers = sqliteTable('_ecommerce_customers', {
  id: text('id').primaryKey(), // A generic stripe-ready customer ID
  name: text('name'),
  email: text('email'),
  stripeCustomerId: text('stripe_customer_id').unique(),
  userId: text('user_id'), // Optional, references standard 'users' if logged in
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
});

/** Shopper profile and order owner. Verified email links connect it to the shared user identity. */
export const customerAccounts = sqliteTable('_ecommerce_customer_accounts', {
  id: text('id').primaryKey(),
  cmsUserId: text('cms_user_id').unique(),
  email: text('email').notNull(),
  emailNormalized: text('email_normalized').notNull().unique(),
  emailVerifiedAt: integer('email_verified_at', { mode: 'timestamp' }),
  name: text('name'),
  creditBalance: integer('credit_balance').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const customerSessions = sqliteTable('_ecommerce_customer_sessions', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => customerAccounts.id, { onDelete: 'cascade' }),
  orderId: text('order_id').unique(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  /** `email_challenge` rows come from sign-in links sent before migration 0024; new links use `signInTokens`. */
  purpose: text('purpose').$type<'session' | 'email_challenge'>().notNull().default('session'),
});

/** One-time sign-in links. The account for the address is created or linked only when a link is used. */
export const signInTokens = sqliteTable('_ecommerce_sign_in_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  emailNormalized: text('email_normalized').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
});

/** Fixed-window counters for shopper requests, in seconds. Kept apart from better-auth's table, which prunes by its own clock. */
export const rateLimits = sqliteTable('_ecommerce_rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  windowStart: integer('window_start').notNull(),
});

/**
 * Shipments, several per order when it ships in parcels, and corrections that restate a shipment's
 * carrier and tracking number. Rows are never changed; the latest correction of a shipment is in force.
 */
export const fulfillments = sqliteTable('_ecommerce_fulfillments', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id),
  adminActor: text('admin_actor').notNull(),
  carrier: text('carrier'),
  trackingNumber: text('tracking_number'),
  /** The shipment note, or the reason for a correction. */
  note: text('note').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  kind: text('kind').$type<'shipment' | 'correction'>().notNull().default('shipment'),
  /** The shipment a correction restates; null for a shipment. */
  correctsId: text('corrects_id').references((): AnySQLiteColumn => fulfillments.id),
  /** Whether a shipment completes its order; false for one parcel of a split shipment. */
  completesOrder: integer('completes_order', { mode: 'boolean' }).notNull().default(true),
});

/** One shareable code per shopper. Codes are generated by the server. */
export const referralCodes = sqliteTable('_ecommerce_referral_codes', {
  code: text('code').primaryKey(),
  accountId: text('account_id').notNull().references(() => customerAccounts.id, { onDelete: 'cascade' }).unique(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

/** A qualified first purchase is recorded once, regardless of webhook retries. */
export const referrals = sqliteTable('_ecommerce_referrals', {
  id: text('id').primaryKey(),
  code: text('code').notNull().references(() => referralCodes.code),
  referrerAccountId: text('referrer_account_id').notNull().references(() => customerAccounts.id),
  referredAccountId: text('referred_account_id').notNull().references(() => customerAccounts.id).unique(),
  orderId: text('order_id').notNull().references(() => orders.id).unique(),
  rewardCents: integer('reward_cents').notNull(),
  currency: text('currency').notNull().default('usd'),
  status: text('status').$type<'approved' | 'void'>().notNull().default('approved'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => [check('referral_reward_nonnegative', sql`${table.rewardCents} >= 0`)]);

/** Immutable entries make awards, spending, and reversals auditable. */
export const creditLedger = sqliteTable('_ecommerce_credit_ledger', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => customerAccounts.id),
  orderId: text('order_id').notNull().references(() => orders.id),
  kind: text('kind').$type<'referral_award' | 'welcome_award' | 'checkout_reserve' | 'checkout_release' | 'purchase_credit_refund' | 'referral_reversal' | 'welcome_reversal'>().notNull(),
  amountCents: integer('amount_cents').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [uniqueIndex('credit_ledger_order_kind_unique').on(table.orderId, table.kind)]);

/** The singleton admin policy overrides Worker defaults when present. */
export const referralSettings = sqliteTable('_ecommerce_referral_settings', {
  id: text('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  rewardCents: integer('reward_cents').notNull().default(1000),
  minOrderCents: integer('min_order_cents').notNull().default(5000),
  attributionDays: integer('attribution_days').notNull().default(30),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/** Credit vouchers carry a dwindling balance; amount and percent codes are reusable offers. */
export const discountCodes = sqliteTable('_ecommerce_discount_codes', {
  code: text('code').primaryKey(),
  description: text('description'),
  type: text('type').$type<'credit' | 'amount' | 'percent'>().notNull(),
  value: integer('value').notNull(), // Store currency minor units for credit/amount, basis points for percent.
  remainingCents: integer('remaining_cents'),
  maxDiscountCents: integer('max_discount_cents'),
  minOrderCents: integer('min_order_cents').notNull().default(0),
  eligibleProductIds: text('eligible_product_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  maxUses: integer('max_uses'),
  maxUsesPerCustomer: integer('max_uses_per_customer'),
  firstOrderOnly: integer('first_order_only', { mode: 'boolean' }).notNull().default(false),
  startsAt: integer('starts_at', { mode: 'timestamp' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/** Pending orders reserve a use and, for credit vouchers, part of the balance. */
export const discountRedemptions = sqliteTable('_ecommerce_discount_redemptions', {
  id: text('id').primaryKey(),
  code: text('code').notNull().references(() => discountCodes.code),
  orderId: text('order_id').notNull().references(() => orders.id).unique(),
  accountId: text('account_id').references(() => customerAccounts.id),
  emailNormalized: text('email_normalized').notNull(),
  amountCents: integer('amount_cents').notNull(),
  status: text('status').$type<'reserved' | 'confirmed' | 'cancelled' | 'refunded'>().notNull().default('reserved'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/** Purchased cards become spendable only after a verified provider payment. */
export const giftCardPurchases = sqliteTable('_ecommerce_gift_card_purchases', {
  id: text('id').primaryKey(),
  buyerEmail: text('buyer_email').notNull(),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('usd'),
  status: text('status').$type<'pending' | 'paid' | 'cancelled' | 'partially_refunded' | 'refunded' | 'review'>().notNull().default('pending'),
  providerSessionId: text('provider_session_id').unique(),
  paymentIntentId: text('payment_intent_id').unique(),
  providerRefundedCents: integer('provider_refunded_cents').notNull().default(0),
  /** The part of providerRefundedCents already settled on the purchase's cards: taken off a reinstated card, or cancelled with void ones. */
  refundAdjustedCents: integer('refund_adjusted_cents').notNull().default(0),
  accessTokenHash: text('access_token_hash').notNull(),
  ...reconcileColumns(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/** Gift card codes are bearer secrets; only hashes and encrypted copies are stored. */
export const giftCards = sqliteTable('_ecommerce_gift_cards', {
  id: text('id').primaryKey(),
  codeHash: text('code_hash').notNull().unique(),
  codeSuffix: text('code_suffix').notNull(),
  encryptedCode: text('encrypted_code').notNull(),
  source: text('source').$type<'purchase' | 'admin'>().notNull(),
  purchaseId: text('purchase_id').references(() => giftCardPurchases.id).unique(),
  /** Set on an administrator-issued card that took over a purchase's value; a refund of that purchase holds it too. */
  replacesPurchaseId: text('replaces_purchase_id').references(() => giftCardPurchases.id),
  /** Suspended by its purchase's review hold while it was active, so reinstating the purchase reactivates it. */
  heldForReview: integer('held_for_review', { mode: 'boolean' }).notNull().default(false),
  adminActor: text('admin_actor'),
  adminReason: text('admin_reason'),
  initialCents: integer('initial_cents').notNull(),
  balanceCents: integer('balance_cents').notNull().default(0),
  currency: text('currency').notNull().default('usd'),
  status: text('status').$type<'active' | 'suspended' | 'void'>().notNull().default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const giftCardLedger = sqliteTable('_ecommerce_gift_card_ledger', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull().references(() => giftCards.id),
  orderId: text('order_id').references(() => orders.id),
  purchaseId: text('purchase_id').references(() => giftCardPurchases.id),
  kind: text('kind').$type<'issue' | 'reserve' | 'release' | 'refund_restore' | 'purchase_reversal'>().notNull(),
  amountCents: integer('amount_cents').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const giftCardRedemptions = sqliteTable('_ecommerce_gift_card_redemptions', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull().references(() => giftCards.id),
  orderId: text('order_id').notNull().references(() => orders.id).unique(),
  amountCents: integer('amount_cents').notNull(),
  status: text('status').$type<'reserved' | 'confirmed' | 'cancelled' | 'refunded'>().notNull().default('reserved'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const giftCardRefunds = sqliteTable('_ecommerce_gift_card_refunds', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull().references(() => giftCards.id),
  orderId: text('order_id').notNull().references(() => orders.id),
  amountCents: integer('amount_cents').notNull(),
  adminActor: text('admin_actor').notNull(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

/** Administrator decisions on purchases held for review after a provider refund. */
export const giftCardReviews = sqliteTable('_ecommerce_gift_card_reviews', {
  id: text('id').primaryKey(),
  purchaseId: text('purchase_id').notNull().references(() => giftCardPurchases.id),
  cardId: text('card_id').notNull().references(() => giftCards.id), // The card that held the purchase's value.
  outcome: text('outcome').$type<'reinstate' | 'void'>().notNull(),
  refundedCents: integer('refunded_cents').notNull(), // The provider refund total the decision covered.
  adjustmentCents: integer('adjustment_cents').notNull(), // Taken off the purchase's cards.
  adminActor: text('admin_actor').notNull(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const giftCardOrderRefunds = sqliteTable('_ecommerce_gift_card_order_refunds', {
  orderId: text('order_id').primaryKey().references(() => orders.id),
  adminActor: text('admin_actor').notNull(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

/** Partial reversals that mirror an order's refunds in its tax transaction. The unique reference makes a retry record one row. */
export const taxReversals = sqliteTable('_ecommerce_tax_reversals', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id),
  reference: text('reference').notNull().unique(),
  amount: integer('amount').notNull(), // Positive, in the order currency's minor units.
  providerReversalId: text('provider_reversal_id').notNull(),
  ...taxSyncColumns(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

/** Payment disputes by the provider's dispute id, each on an order or a gift card purchase. */
export const disputes = sqliteTable('_ecommerce_disputes', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  orderId: text('order_id').references(() => orders.id),
  giftCardPurchaseId: text('gift_card_purchase_id').references(() => giftCardPurchases.id),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(),
  reason: text('reason'),
  /** The provider's status, such as needs_response, won or lost. */
  status: text('status').notNull(),
  /** The order's or purchase's status before the dispute, which a won dispute restores. */
  statusBefore: text('status_before').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  /** Null while the dispute is open. */
  closedAt: integer('closed_at', { mode: 'timestamp' }),
});

/** Reservation rows of refunded orders that an administrator returned to stock, each once, with the reason. */
export const restocks = sqliteTable('_ecommerce_restocks', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id),
  reservationType: text('reservation_type').$type<'inventory' | 'component'>().notNull(),
  reservationId: text('reservation_id').notNull(),
  targetType: text('target_type').$type<'product' | 'variant' | 'stock' | 'component'>().notNull(),
  targetId: text('target_id').notNull(),
  quantity: integer('quantity').notNull(),
  adminActor: text('admin_actor').notNull(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [uniqueIndex('_ecommerce_restocks_reservation_unique').on(table.reservationType, table.reservationId)]);

/**
 * Administrator decisions on orders and gift card purchases parked for review (migration 0029), each
 * recorded with the retry or release it carried out. Exactly one of orderId and purchaseId is set.
 */
export const reconcileDecisions = sqliteTable('_ecommerce_reconcile_decisions', {
  id: text('id').primaryKey(),
  orderId: text('order_id').references(() => orders.id),
  purchaseId: text('purchase_id').references(() => giftCardPurchases.id),
  action: text('action').$type<'retry' | 'release'>().notNull(),
  failure: text('failure'), // The failure code the record was parked with.
  // How a released completed checkout's payment was shown to be returned; null for any other decision.
  paymentReturned: text('payment_returned').$type<'refunded' | 'dispute_lost' | 'confirmed'>(),
  adminActor: text('admin_actor').notNull(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

/**
 * Order confirmations, shipment notices and gift card claim emails: one row per email, written with the
 * change that calls for it. No addresses; `lastError` is an error code.
 */
export const emailDeliveries = sqliteTable('_ecommerce_email_deliveries', {
  id: text('id').primaryKey(),
  kind: text('kind').$type<'order_confirmation' | 'shipment' | 'shipment_update' | 'gift_card_claim'>().notNull(),
  /** The order, the shipment or correction (fulfillment id), or the gift card purchase. */
  subjectId: text('subject_id').notNull(),
  status: text('status').$type<'pending' | 'sent' | 'failed' | 'cancelled'>().notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp' }).notNull(),
  claimedAt: integer('claimed_at', { mode: 'timestamp' }),
  sentAt: integer('sent_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [uniqueIndex('_ecommerce_email_deliveries_kind_subject_unique').on(table.kind, table.subjectId)]);

/** One-time links that show a purchased gift card's code; only the token's hash is stored. */
export const giftCardClaims = sqliteTable('_ecommerce_gift_card_claims', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  purchaseId: text('purchase_id').notNull().references(() => giftCardPurchases.id),
  /** The card whose code the link shows. */
  cardId: text('card_id').notNull().references(() => giftCards.id),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  /** The administrator who resent the link, with the reason; null for the link sent after payment. */
  createdBy: text('created_by'),
  reason: text('reason'),
});

// --- Drizzle Relations API ---

export const cartsRelations = relations(carts, ({ many }) => ({
  orders: many(orders)
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  cart: one(carts, {
    fields: [orders.cartId],
    references: [carts.id]
  }),
  payments: many(payments)
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  order: one(orders, {
    fields: [payments.orderId],
    references: [orders.id]
  })
}));

export const productsRelations = relations(products, ({ many }) => ({
  variants: many(productVariants),
  categories: many(productCategories),
  tags: many(productTags)
}));

export const variantsRelations = relations(variants, ({ many }) => ({
  productVariants: many(productVariants)
}));

export const productVariantsRelations = relations(productVariants, ({ one, many }) => ({
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

export const productVariantValuesRelations = relations(productVariantValues, ({ one }) => ({
  productVariant: one(productVariants, {
    fields: [productVariantValues.productVariantId],
    references: [productVariants.id]
  }),
  stock: one(stocks, {
    fields: [productVariantValues.id],
    references: [stocks.productVariantValueId]
  })
}));

export const stocksRelations = relations(stocks, ({ one }) => ({
  productVariantValue: one(productVariantValues, {
    fields: [stocks.productVariantValueId],
    references: [productVariantValues.id]
  })
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  products: many(productTags)
}));

export const productTagsRelations = relations(productTags, ({ one }) => ({
  product: one(products, {
    fields: [productTags.productId],
    references: [products.id]
  }),
  tag: one(tags, {
    fields: [productTags.tagId],
    references: [tags.id]
  })
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
    relationName: 'category_hierarchy'
  }),
  children: many(categories, {
    relationName: 'category_hierarchy'
  }),
  products: many(productCategories)
}));

export const productCategoriesRelations = relations(productCategories, ({ one }) => ({
  product: one(products, {
    fields: [productCategories.productId],
    references: [products.id]
  }),
  category: one(categories, {
    fields: [productCategories.categoryId],
    references: [categories.id]
  })
}));
