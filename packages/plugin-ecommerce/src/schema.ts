import { canonicalEmailSql } from './email-canonical';
import { defineRelations, sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { user as cmsUsers } from 'talisman-cms/auth/local-schema';

// This file is the source of truth for the commerce tables: drizzle-kit generates the plugin's
// migrations from it (`pnpm --filter @talisman-cms/plugin-ecommerce db:generate`). Every column,
// index, unique rule, foreign key and CHECK the database enforces is declared here; only the
// triggers live in a custom migration, because drizzle-kit does not model them. Partial indexes
// name their literals in full, so the queries that repeat those literals can use them.

// CHECK expressions are written as literals: a migration carries no bound parameters.
const money = (column: AnySQLiteColumn, rule: 'nonnegative' | 'positive') =>
  rule === 'positive' ? sql`${column} > 0` : sql`${column} >= 0`;
const literals = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '));
const oneOf = (column: AnySQLiteColumn, values: readonly string[]) => sql`${column} IN (${literals(values)})`;
const nullOrOneOf = (column: AnySQLiteColumn, values: readonly string[]) => sql`${column} IS NULL OR ${column} IN (${literals(values)})`;
const flag = (column: AnySQLiteColumn) => sql`${column} IN (0, 1)`;
const trimmed = (column: AnySQLiteColumn, minLength: number) => sql`length(trim(${column})) >= ${sql.raw(String(minLength))}`;
const filled = (column: AnySQLiteColumn) => sql`length(trim(${column})) > 0`;

/**
 * Reconciliation of a pending order or gift card purchase: the attempts so far, when the last one
 * ran and its failure code, and when a permanent failure parked the row for an administrator.
 * Codes are listed in reconcile.ts.
 */
const reconcileColumns = () => ({
  reconcileAttempts: integer('reconcile_attempts').notNull().default(0),
  reconcileLastAt: integer('reconcile_last_at', { mode: 'timestamp' }),
  reconcileLastError: text('reconcile_last_error'),
  reconcileReviewAt: integer('reconcile_review_at', { mode: 'timestamp' }),
});
const reconcileChecks = (table: string, columns: { reconcileAttempts: AnySQLiteColumn }) => [
  check(`${table}_reconcile_attempts_nonnegative`, money(columns.reconcileAttempts, 'nonnegative')),
];

/**
 * The tax passes of reconcileCommerce: the failed attempts at an order's tax record or reversal, or
 * at sending a reversal, when the last one ran and its failure code (codes are listed in
 * reconcile.ts). A success clears them.
 */
const taxSyncColumns = () => ({
  taxSyncAttempts: integer('tax_sync_attempts').notNull().default(0),
  taxSyncLastAt: integer('tax_sync_last_at', { mode: 'timestamp' }),
  taxSyncLastError: text('tax_sync_last_error'),
  taxSyncReviewAt: integer('tax_sync_review_at', { mode: 'timestamp' }),
});
const taxSyncChecks = (table: string, columns: { taxSyncAttempts: AnySQLiteColumn }) => [
  check(`${table}_tax_sync_attempts_nonnegative`, money(columns.taxSyncAttempts, 'nonnegative')),
];

export const carts = sqliteTable('_ecommerce_carts', {
  id: text('id').primaryKey(), // Usually mapped to a session generic ID
  sessionToken: text('session_token').unique(), // For guest checkout
  userId: text('user_id'), // Optional, references standard 'users' if logged in
  checkoutSessionId: text('checkout_session_id'),
  version: integer('version').notNull().default(0),
  items: text('items', { mode: 'json' }).$type<Array<{ productId: string, variantId?: string, quantity: number }>>().notNull().default([]),
  closed: integer('closed', { mode: 'boolean' }).notNull().default(false),
  closedAt: integer('closed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
}, (table) => [
  // Named, because the checkout resume and the stale-checkout sweep read this index by name in their query plans.
  uniqueIndex('_ecommerce_carts_checkout_session_id_unique').on(table.checkoutSessionId),
  // One open cart per signed-in shopper.
  uniqueIndex('_ecommerce_carts_user_open_unique').on(table.userId).where(sql`${table.closed} = 0 AND ${table.userId} IS NOT NULL`),
]);

export const FULFILLMENT_STATUSES = ['unfulfilled', 'partially_fulfilled', 'fulfilled'] as const;
export const TAX_BEHAVIORS = ['inclusive', 'exclusive'] as const;

export const orders = sqliteTable('_ecommerce_orders', {
  id: text('id').primaryKey(),
  cartId: text('cart_id').references(() => carts.id).unique(),
  guestAccessTokenHash: text('guest_access_token_hash'),
  /** Immutable compatibility credential of a guest basket, independent of later basket ownership. */
  guestBasketTokenHash: text('guest_basket_token_hash'),
  userId: text('user_id'), // Optional, references standard 'users' if logged in
  checkoutSessionId: text('checkout_session_id'), // e.g. Stripe Checkout Session ID
  paymentIntentId: text('payment_intent_id').unique(),
  providerRefundedCents: integer('provider_refunded_cents').notNull().default(0),
  paymentProvider: text('payment_provider'), // e.g. stripe or admin_test
  referralCode: text('referral_code'),
  referralRewardCents: integer('referral_reward_cents').notNull().default(0),
  /** Qualification and hold/cap terms in force at checkout; null only on earlier orders. */
  referralTerms: text('referral_terms', { mode: 'json' }).$type<{ minOrderCents: number; holdDays: number; maxPerPeriod: number; periodDays: number }>(),
  discountCleanupPending: integer('discount_cleanup_pending', { mode: 'boolean' }).notNull().default(false),
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
  taxBehavior: text('tax_behavior', { enum: TAX_BEHAVIORS }),
  taxCalculationId: text('tax_calculation_id'),
  taxTransactionId: text('tax_transaction_id'),
  // Payment: draft, pending, paid, partially_refunded, refunded, disputed or cancelled. The legacy
  // 'fulfilled' is still read as paid.
  status: text('status').notNull().default('draft'),
  /** Shipping, kept apart from payment so that a refund never hides a shipment. */
  fulfillmentStatus: text('fulfillment_status', { enum: FULFILLMENT_STATUSES }).notNull().default('unfulfilled'),
  items: text('items', { mode: 'json' }).$type<Array<{ productId: string, variantId?: string, quantity: number, priceAtPurchase: number, usesComponents?: boolean, stockTargets?: Array<{ type: "product" | "variant" | "stock" | "component", id: string, units: number }> }>>().notNull().default([]),
  totalAmount: integer('total_amount').notNull(),
  currency: text('currency').notNull().default('usd'),
  customerEmail: text('customer_email'),
  customerEmailCanonical: text('customer_email_canonical').generatedAlwaysAs(sql.raw(canonicalEmailSql('customer_email'))),
  shippingAddress: text('shipping_address', { mode: 'json' }).$type<{ name?: string, line1?: string, line2?: string, city?: string, state?: string, postalCode?: string, country?: string }>(),
  billingAddress: text('billing_address', { mode: 'json' }).$type<{ name?: string, line1?: string, line2?: string, city?: string, state?: string, postalCode?: string, country?: string }>(),
  ...reconcileColumns(),
  ...taxSyncColumns(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
}, (table) => [
  index('_ecommerce_orders_user_idx').on(table.userId),
  index('_ecommerce_orders_checkout_session_idx').on(table.checkoutSessionId),
  // Order emails are looked up in lower case.
  index('_ecommerce_orders_canonical_email_idx').on(table.customerEmailCanonical),
  index('_ecommerce_orders_discount_cleanup_idx').on(table.updatedAt).where(sql`${table.discountCleanupPending} = 1`),
  index('_ecommerce_orders_customer_email_idx').on(sql`lower(${table.customerEmail})`),
  // Checkout reconciliation reads pending orders by age.
  index('_ecommerce_orders_created_idx').on(table.createdAt),
  index('_ecommerce_orders_pending_idx').on(table.createdAt).where(sql`${table.status} = 'pending'`),
  // The admin orders queue: real orders that can still ship, and real orders past checkout.
  index('_ecommerce_orders_awaiting_idx').on(table.createdAt, table.id)
    .where(sql`${table.status} IN ('paid', 'partially_refunded') AND ${table.fulfillmentStatus} <> 'fulfilled' AND COALESCE(${table.paymentProvider}, 'stripe') <> 'admin_test'`),
  index('_ecommerce_orders_recent_idx').on(table.createdAt, table.id)
    .where(sql`${table.status} NOT IN ('pending', 'cancelled', 'draft') AND COALESCE(${table.paymentProvider}, 'stripe') <> 'admin_test'`),
  // The tax passes: refunded orders with a tax transaction to reverse, and paid orders whose transaction is missing.
  index('_ecommerce_orders_tax_refunded_idx').on(table.createdAt)
    .where(sql`${table.status} IN ('partially_refunded', 'refunded') AND ${table.taxTransactionId} IS NOT NULL`),
  index('_ecommerce_orders_tax_transaction_missing_idx').on(table.status, table.createdAt)
    .where(sql`${table.taxCalculationId} IS NOT NULL AND ${table.taxTransactionId} IS NULL`),
  check('orders_total_nonnegative', money(table.totalAmount, 'nonnegative')),
  check('orders_provider_refund_capped', sql`${table.providerRefundedCents} <= ${table.totalAmount}`),
  check('orders_totals_balanced', sql`${table.subtotalAmount} + ${table.shippingAmount} + CASE WHEN ${table.taxBehavior} = 'exclusive' THEN ${table.taxAmount} ELSE 0 END = ${table.totalAmount} + ${table.discountAmount} + ${table.creditApplied} + ${table.giftCardApplied}`),
  check('orders_referral_reward_nonnegative', money(table.referralRewardCents, 'nonnegative')),
  check('orders_credit_applied_nonnegative', money(table.creditApplied, 'nonnegative')),
  check('orders_subtotal_nonnegative', money(table.subtotalAmount, 'nonnegative')),
  check('orders_provider_refunded_nonnegative', money(table.providerRefundedCents, 'nonnegative')),
  check('orders_discount_nonnegative', money(table.discountAmount, 'nonnegative')),
  check('orders_gift_card_applied_nonnegative', money(table.giftCardApplied, 'nonnegative')),
  check('orders_gift_card_refunded_within_applied', sql`${table.giftCardRefundedCents} >= 0 AND ${table.giftCardRefundedCents} <= ${table.giftCardApplied}`),
  check('orders_shipping_nonnegative', money(table.shippingAmount, 'nonnegative')),
  check('orders_tax_nonnegative', money(table.taxAmount, 'nonnegative')),
  check('orders_tax_behavior', nullOrOneOf(table.taxBehavior, TAX_BEHAVIORS)),
  check('orders_fulfillment_status', oneOf(table.fulfillmentStatus, FULFILLMENT_STATUSES)),
  ...reconcileChecks('orders', table),
  ...taxSyncChecks('orders', table),
]);

export const payments = sqliteTable('_ecommerce_payments', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id),
  provider: text('provider').notNull(), // 'stripe', 'paypal'
  providerId: text('provider_id').notNull(), // pi_12345
  status: text('status').notNull(),
  amount: integer('amount').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
}, (table) => [
  uniqueIndex('_ecommerce_payments_provider_id_unique').on(table.provider, table.providerId),
  index('_ecommerce_payments_order_idx').on(table.orderId),
]);

/**
 * Payment provider refunds with the time they were issued: one row for each rise in an order's
 * providerRefundedCents, so an order's rows add up to it. Gift card tender refunds are in giftCardRefunds.
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
}, (table) => [
  index('_ecommerce_provider_refunds_order_idx').on(table.orderId),
  check('provider_refund_amount_positive', money(table.amountCents, 'positive')),
]);

export const PRODUCT_TYPES = ['standard', 'digital', 'subscription'] as const;
export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;

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
  type: text('type', { enum: PRODUCT_TYPES }).notNull().default('standard'),
  status: text('status', { enum: PRODUCT_STATUSES }).notNull().default('draft'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
}, (table) => [
  check('products_stock_nonnegative', money(table.inventoryQuantity, 'nonnegative')),
  check('products_price_nonnegative', money(table.basePrice, 'nonnegative')),
  check('products_type', oneOf(table.type, PRODUCT_TYPES)),
  check('products_status', oneOf(table.status, PRODUCT_STATUSES))
]);

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
}, (table) => [
  check('variants_stock_nonnegative', money(table.inventoryQuantity, 'nonnegative')),
  check('variants_price_nonnegative', money(table.priceOverride, 'nonnegative'))
]);

export const productVariantValues = sqliteTable('_ecommerce_product_variant_values', {
  id: text('id').primaryKey(),
  productVariantId: text('product_variant_id').notNull().references(() => productVariants.id),
  value: text('value').notNull(),
  sku: text('sku').unique(),
  image: text('image'),
  priceOverride: integer('price_override'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
}, (table) => [
  check('variant_values_price_nonnegative', money(table.priceOverride, 'nonnegative'))
]);

export const stocks = sqliteTable('_ecommerce_stocks', {
  id: text('id').primaryKey(),
  productVariantValueId: text('product_variant_value_id').notNull().references(() => productVariantValues.id).unique(),
  quantity: integer('quantity').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
}, (table) => [
  check('stocks_quantity_nonnegative', money(table.quantity, 'nonnegative'))
]);

/** Physical parts that can be shared by several purchasable variant values. */
export const components = sqliteTable('_ecommerce_components', {
  id: text('id').primaryKey(),
  sku: text('sku').notNull().unique(),
  name: text('name').notNull(),
  quantity: integer('quantity').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
}, (table) => [check('component_quantity_nonnegative', money(table.quantity, 'nonnegative'))]);

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
  check('variant_component_quantity_positive', money(table.quantity, 'positive'))
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
  index('_ecommerce_component_reservations_released_idx').on(table.releasedAt),
  index('_ecommerce_component_reservations_target_idx').on(table.componentId),
  check('component_reservation_quantity_positive', money(table.quantity, 'positive'))
]);

export const RESERVATION_TARGET_TYPES = ['product', 'variant', 'stock'] as const;

/** Ordinary product, variant, and variant-value stock held during checkout. */
export const inventoryReservations = sqliteTable('_ecommerce_inventory_reservations', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id),
  targetType: text('target_type', { enum: RESERVATION_TARGET_TYPES }).notNull(),
  targetId: text('target_id').notNull(),
  quantity: integer('quantity').notNull(),
  releasedAt: integer('released_at', { mode: 'timestamp' })
}, (table) => [
  uniqueIndex('inventory_reservation_unique').on(table.orderId, table.targetType, table.targetId),
  index('_ecommerce_inventory_reservations_released_idx').on(table.releasedAt),
  index('_ecommerce_inventory_reservations_target_idx').on(table.targetType, table.targetId),
  check('inventory_reservation_target_type', oneOf(table.targetType, RESERVATION_TARGET_TYPES)),
  check('inventory_reservation_quantity_positive', money(table.quantity, 'positive'))
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
}, (table) => [primaryKey({ columns: [table.productId, table.categoryId] })]);

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
}, (table) => [primaryKey({ columns: [table.productId, table.tagId] })]);

export const customers = sqliteTable('_ecommerce_customers', {
  id: text('id').primaryKey(), // A generic stripe-ready customer ID
  name: text('name'),
  email: text('email'),
  stripeCustomerId: text('stripe_customer_id').unique(),
  userId: text('user_id'), // Optional, references standard 'users' if logged in
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
});

/**
 * Shopper profile and order owner. A verified email links it to the shared CMS user identity; the
 * link is cleared when that user is deleted.
 */
export const customerAccounts = sqliteTable('_ecommerce_customer_accounts', {
  id: text('id').primaryKey(),
  cmsUserId: text('cms_user_id').references(() => cmsUsers.id, { onDelete: 'set null' }),
  email: text('email').notNull(),
  emailNormalized: text('email_normalized').notNull().unique(),
  emailCanonical: text('email_canonical').generatedAlwaysAs(sql.raw(canonicalEmailSql('email_normalized'))),
  emailVerifiedAt: integer('email_verified_at', { mode: 'timestamp' }),
  anonymizedAt: integer('anonymized_at', { mode: 'timestamp' }),
  sessionVersion: integer('session_version').notNull().default(0),
  name: text('name'),
  creditBalance: integer('credit_balance').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  index('_ecommerce_accounts_canonical_email_idx').on(table.emailCanonical),
  uniqueIndex('_ecommerce_customer_accounts_cms_user_idx').on(table.cmsUserId).where(sql`${table.cmsUserId} IS NOT NULL`),
]);

export const CUSTOMER_SESSION_PURPOSES = ['session', 'email_challenge'] as const;

export const customerSessions = sqliteTable('_ecommerce_customer_sessions', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => customerAccounts.id, { onDelete: 'cascade' }),
  orderId: text('order_id').unique(),
  tokenHash: text('token_hash').notNull().unique(),
  sessionVersion: integer('session_version').notNull().default(0),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  /** `email_challenge` rows came from the sign-in links of earlier releases; links use `signInTokens`. */
  purpose: text('purpose', { enum: CUSTOMER_SESSION_PURPOSES }).notNull().default('session'),
}, (table) => [
  index('_ecommerce_customer_sessions_account_idx').on(table.accountId),
  index('_ecommerce_customer_sessions_challenge_idx').on(table.accountId, table.purpose, table.createdAt),
  check('customer_session_purpose', oneOf(table.purpose, CUSTOMER_SESSION_PURPOSES)),
]);

/** One-time sign-in links. The account for the address is created or linked only when a link is used. */
export const signInTokens = sqliteTable('_ecommerce_sign_in_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  emailNormalized: text('email_normalized').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
}, (table) => [index('_ecommerce_sign_in_tokens_email_idx').on(table.emailNormalized, table.createdAt)]);

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
export const FULFILLMENT_KINDS = ['shipment', 'correction', 'reopen', 'complete'] as const;

export const fulfillments = sqliteTable('_ecommerce_fulfillments', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id),
  adminActor: text('admin_actor').notNull(),
  carrier: text('carrier'),
  trackingNumber: text('tracking_number'),
  /** The shipment note, or the reason for a correction. */
  note: text('note').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  kind: text('kind', { enum: FULFILLMENT_KINDS }).notNull().default('shipment'),
  /** Stable client request identity; retries must carry the same payload. */
  requestKey: text('request_key'),
  /** The shipment a correction restates; null for a shipment. */
  correctsId: text('corrects_id').references((): AnySQLiteColumn => fulfillments.id),
  /** Whether a shipment completes its order; false for one parcel of a split shipment. */
  completesOrder: integer('completes_order', { mode: 'boolean' }).notNull().default(true),
}, (table) => [
  uniqueIndex('_ecommerce_fulfillments_request_unique').on(table.orderId, table.requestKey),
  check('fulfillment_actor_filled', filled(table.adminActor)),
  check('fulfillment_note_length', trimmed(table.note, 8)),
  index('_ecommerce_fulfillments_order_idx').on(table.orderId, table.createdAt),
  check('fulfillment_kind', oneOf(table.kind, FULFILLMENT_KINDS)),
  check('fulfillment_completes_order_flag', flag(table.completesOrder)),
  check('fulfillment_correction_names_shipment', sql`(${table.kind} = 'correction') = (${table.correctsId} IS NOT NULL)`),
  check('fulfillment_only_shipment_completes', sql`${table.kind} = 'shipment' OR ${table.completesOrder} = 0`),
]);

/** One shareable code per shopper. Codes are generated by the server. */
export const referralCodes = sqliteTable('_ecommerce_referral_codes', {
  code: text('code').primaryKey(),
  accountId: text('account_id').notNull().references(() => customerAccounts.id, { onDelete: 'cascade' }).unique(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const REFERRAL_STATUSES = ['approved', 'void'] as const;

/** A qualified first purchase is recorded once, regardless of webhook retries. */
export const referrals = sqliteTable('_ecommerce_referrals', {
  id: text('id').primaryKey(),
  code: text('code').notNull().references(() => referralCodes.code),
  referrerAccountId: text('referrer_account_id').notNull().references(() => customerAccounts.id),
  referredAccountId: text('referred_account_id').notNull().references(() => customerAccounts.id).unique(),
  orderId: text('order_id').notNull().references(() => orders.id).unique(),
  rewardCents: integer('reward_cents').notNull(),
  currency: text('currency').notNull().default('usd'),
  status: text('status', { enum: REFERRAL_STATUSES }).notNull().default('approved'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  index('_ecommerce_referrals_referrer_idx').on(table.referrerAccountId, table.createdAt),
  check('referral_reward_nonnegative', money(table.rewardCents, 'nonnegative')),
  check('referral_status', oneOf(table.status, REFERRAL_STATUSES)),
]);

export const CREDIT_LEDGER_KINDS = ['referral_award', 'welcome_award', 'checkout_reserve', 'checkout_release', 'purchase_credit_refund', 'referral_reversal', 'welcome_reversal'] as const;

/** Immutable entries make awards, spending, and reversals auditable. */
export const creditLedger = sqliteTable('_ecommerce_credit_ledger', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => customerAccounts.id),
  orderId: text('order_id').notNull().references(() => orders.id),
  kind: text('kind', { enum: CREDIT_LEDGER_KINDS }).notNull(),
  amountCents: integer('amount_cents').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  uniqueIndex('credit_ledger_order_kind_unique').on(table.orderId, table.kind),
  index('_ecommerce_credit_ledger_account_idx').on(table.accountId, table.createdAt),
  check('credit_ledger_kind', oneOf(table.kind, CREDIT_LEDGER_KINDS)),
  check('credit_ledger_amount_nonzero', sql`${table.amountCents} != 0`),
]);

/** The singleton admin policy overrides Worker defaults when present. */
export const referralSettings = sqliteTable('_ecommerce_referral_settings', {
  id: text('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  rewardCents: integer('reward_cents').notNull().default(1000),
  minOrderCents: integer('min_order_cents').notNull().default(5000),
  attributionDays: integer('attribution_days').notNull().default(30),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  check('referral_settings_singleton', sql`${table.id} = 'default'`),
  check('referral_settings_enabled_flag', flag(table.enabled)),
  check('referral_settings_reward_range', sql`${table.rewardCents} BETWEEN 1 AND 100000`),
  check('referral_settings_min_order_range', sql`${table.minOrderCents} BETWEEN 1 AND 10000000`),
  check('referral_settings_attribution_range', sql`${table.attributionDays} BETWEEN 1 AND 90`),
]);

export const DISCOUNT_CODE_TYPES = ['credit', 'amount', 'percent'] as const;

/** Credit vouchers carry a dwindling balance; amount and percent codes are reusable offers. */
export const discountCodes = sqliteTable('_ecommerce_discount_codes', {
  code: text('code').primaryKey(),
  description: text('description'),
  type: text('type', { enum: DISCOUNT_CODE_TYPES }).notNull(),
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
}, (table) => [
  check('discount_code_type', oneOf(table.type, DISCOUNT_CODE_TYPES)),
  check('discount_code_value_positive', money(table.value, 'positive')),
  check('discount_code_remaining_nonnegative', money(table.remainingCents, 'nonnegative')),
  check('discount_code_max_discount_positive', money(table.maxDiscountCents, 'positive')),
  check('discount_code_min_order_nonnegative', money(table.minOrderCents, 'nonnegative')),
  check('discount_code_max_uses_positive', money(table.maxUses, 'positive')),
  check('discount_code_max_uses_per_customer_positive', money(table.maxUsesPerCustomer, 'positive')),
  check('discount_code_first_order_only_flag', flag(table.firstOrderOnly)),
  check('discount_code_active_flag', flag(table.active)),
  // A credit voucher has a balance and no cap; an amount code has neither; a percent code is in basis points.
  check('discount_code_type_shape', sql`(${table.type} = 'credit' AND ${table.remainingCents} IS NOT NULL AND ${table.remainingCents} <= ${table.value} AND ${table.maxDiscountCents} IS NULL)
    OR (${table.type} = 'amount' AND ${table.remainingCents} IS NULL AND ${table.maxDiscountCents} IS NULL)
    OR (${table.type} = 'percent' AND ${table.value} BETWEEN 1 AND 10000 AND ${table.remainingCents} IS NULL)`),
]);

/** A private creation key records the original payload; replay never resets a code's current balance or terms. */
export const discountCodeCreations = sqliteTable('_ecommerce_discount_code_creations', {
  id: text('id').primaryKey(), // Domain-separated hash of the private request key.
  code: text('code').notNull().references(() => discountCodes.code).unique(),
  fingerprint: text('fingerprint').notNull(),
  actor: text('actor').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  check('discount_code_creation_id', sql`length(${table.id}) = 64 AND ${table.id} NOT GLOB '*[^0-9a-f]*'`),
  check('discount_code_creation_fingerprint', sql`length(${table.fingerprint}) = 64 AND ${table.fingerprint} NOT GLOB '*[^0-9a-f]*'`),
  check('discount_code_creation_actor', sql`length(trim(${table.actor})) BETWEEN 1 AND 128`),
]);

export const REDEMPTION_STATUSES = ['reserved', 'confirmed', 'cancelled', 'refunded'] as const;

/** Pending orders reserve a use and, for credit vouchers, part of the balance. */
export const discountRedemptions = sqliteTable('_ecommerce_discount_redemptions', {
  id: text('id').primaryKey(),
  code: text('code').notNull().references(() => discountCodes.code),
  orderId: text('order_id').notNull().references(() => orders.id).unique(),
  accountId: text('account_id').references(() => customerAccounts.id),
  emailNormalized: text('email_normalized').notNull(),
  amountCents: integer('amount_cents').notNull(),
  status: text('status', { enum: REDEMPTION_STATUSES }).notNull().default('reserved'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  index('_ecommerce_discount_redemptions_code_status_idx').on(table.code, table.status),
  index('_ecommerce_discount_redemptions_email_idx').on(table.code, table.emailNormalized, table.status),
  check('discount_redemption_amount_positive', money(table.amountCents, 'positive')),
  check('discount_redemption_status', oneOf(table.status, REDEMPTION_STATUSES)),
]);

export const GIFT_CARD_PURCHASE_STATUSES = ['pending', 'paid', 'cancelled', 'partially_refunded', 'refunded', 'review'] as const;

/** Purchased cards become spendable only after a verified provider payment. Gift cards are USD only. */
export const giftCardPurchases = sqliteTable('_ecommerce_gift_card_purchases', {
  id: text('id').primaryKey(),
  buyerEmail: text('buyer_email').notNull(),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('usd'),
  status: text('status', { enum: GIFT_CARD_PURCHASE_STATUSES }).notNull().default('pending'),
  providerSessionId: text('provider_session_id').unique(),
  paymentIntentId: text('payment_intent_id').unique(),
  providerRefundedCents: integer('provider_refunded_cents').notNull().default(0),
  /** The part of providerRefundedCents already settled on the purchase's cards: taken off a reinstated card, or cancelled with void ones. */
  refundAdjustedCents: integer('refund_adjusted_cents').notNull().default(0),
  accessTokenHash: text('access_token_hash').notNull(),
  ...reconcileColumns(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  index('_ecommerce_gift_card_purchases_status_created_idx').on(table.status, table.createdAt),
  check('gift_card_purchase_amount_range', sql`${table.amountCents} BETWEEN 500 AND 100000`),
  check('gift_card_purchase_currency_usd', sql`${table.currency} = 'usd'`),
  check('gift_card_purchase_status', oneOf(table.status, GIFT_CARD_PURCHASE_STATUSES)),
  check('gift_card_purchase_provider_refunded_nonnegative', money(table.providerRefundedCents, 'nonnegative')),
  check('gift_card_purchase_refund_adjusted_within_refunded', sql`${table.refundAdjustedCents} >= 0 AND ${table.refundAdjustedCents} <= ${table.providerRefundedCents}`),
  ...reconcileChecks('gift_card_purchase', table),
]);

export const GIFT_CARD_SOURCES = ['purchase', 'admin'] as const;
export const GIFT_CARD_STATUSES = ['active', 'suspended', 'void'] as const;

/** Gift card codes are bearer secrets; only hashes and encrypted copies are stored. */
export const giftCards = sqliteTable('_ecommerce_gift_cards', {
  id: text('id').primaryKey(),
  codeHash: text('code_hash').notNull().unique(),
  codeSuffix: text('code_suffix').notNull(),
  encryptedCode: text('encrypted_code').notNull(),
  source: text('source', { enum: GIFT_CARD_SOURCES }).notNull(),
  purchaseId: text('purchase_id').references(() => giftCardPurchases.id).unique(),
  /** Set on an administrator-issued card that took over a purchase's value; a refund of that purchase holds it too. */
  replacesPurchaseId: text('replaces_purchase_id').references(() => giftCardPurchases.id),
  /** Suspended by its purchase's review hold while it was active, so reinstating the purchase reactivates it. */
  heldForReview: integer('held_for_review', { mode: 'boolean' }).notNull().default(false),
  adminActor: text('admin_actor'),
  adminReason: text('admin_reason'),
  initialCents: integer('initial_cents').notNull(),
  balanceCents: integer('balance_cents').notNull().default(0),
  /** Value refunded to a replacement card after its original issue. */
  restoredCents: integer('restored_cents').notNull().default(0),
  currency: text('currency').notNull().default('usd'),
  status: text('status', { enum: GIFT_CARD_STATUSES }).notNull().default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  index('_ecommerce_gift_cards_replaces_purchase_idx').on(table.replacesPurchaseId).where(sql`${table.replacesPurchaseId} IS NOT NULL`),
  check('gift_card_source', oneOf(table.source, GIFT_CARD_SOURCES)),
  check('gift_card_initial_range', sql`${table.initialCents} BETWEEN 500 AND 100000`),
  check('gift_card_balance_within_initial', sql`${table.restoredCents} >= 0 AND ${table.balanceCents} BETWEEN 0 AND ${table.initialCents} + ${table.restoredCents}`),
  check('gift_card_currency_usd', sql`${table.currency} = 'usd'`),
  check('gift_card_status', oneOf(table.status, GIFT_CARD_STATUSES)),
  check('gift_card_replacement_by_admin', sql`${table.replacesPurchaseId} IS NULL OR ${table.source} = 'admin'`),
  check('gift_card_held_for_review_flag', flag(table.heldForReview)),
  // A purchased card names its purchase; an administrator's card names who issued it and why.
  check('gift_card_source_shape', sql`(${table.source} = 'purchase' AND ${table.purchaseId} IS NOT NULL AND ${table.adminActor} IS NULL)
    OR (${table.source} = 'admin' AND ${table.purchaseId} IS NULL AND ${table.adminActor} IS NOT NULL AND ${table.adminReason} IS NOT NULL)`),
]);

export const GIFT_CARD_LEDGER_KINDS = ['issue', 'reserve', 'release', 'refund_restore', 'purchase_reversal'] as const;

/** Code replacement changes access to a staff-issued card, never its funding or order identity. */
export const giftCardCodeReplacements = sqliteTable('_ecommerce_gift_card_code_replacements', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull().references(() => giftCards.id),
  previousReplacementId: text('previous_replacement_id').references((): AnySQLiteColumn => giftCardCodeReplacements.id),
  previousCodeHash: text('previous_code_hash').notNull(),
  newCodeHash: text('new_code_hash').notNull().unique(),
  previousCodeSuffix: text('previous_code_suffix').notNull(),
  newCodeSuffix: text('new_code_suffix').notNull(),
  balanceCents: integer('balance_cents').notNull(),
  actor: text('actor').notNull(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  uniqueIndex('_ecommerce_gift_card_code_replacements_previous_idx').on(table.cardId, table.previousCodeHash),
  index('_ecommerce_gift_card_code_replacements_card_idx').on(table.cardId, table.createdAt),
  check('gift_card_code_replacement_hashes', sql`length(${table.previousCodeHash}) = 64 AND length(${table.newCodeHash}) = 64 AND ${table.previousCodeHash} <> ${table.newCodeHash}`),
  check('gift_card_code_replacement_suffixes', sql`length(${table.previousCodeSuffix}) = 4 AND length(${table.newCodeSuffix}) = 4`),
  check('gift_card_code_replacement_balance', money(table.balanceCents, 'nonnegative')),
  check('gift_card_code_replacement_actor', filled(table.actor)),
  check('gift_card_code_replacement_reason', sql`length(trim(${table.reason})) BETWEEN 8 AND 500`),
]);

export const giftCardLedger = sqliteTable('_ecommerce_gift_card_ledger', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull().references(() => giftCards.id),
  orderId: text('order_id').references(() => orders.id),
  purchaseId: text('purchase_id').references(() => giftCardPurchases.id),
  kind: text('kind', { enum: GIFT_CARD_LEDGER_KINDS }).notNull(),
  amountCents: integer('amount_cents').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  index('_ecommerce_gift_card_ledger_card_idx').on(table.cardId, table.createdAt),
  index('_ecommerce_gift_card_ledger_order_idx').on(table.orderId, table.createdAt),
  check('gift_card_ledger_kind', oneOf(table.kind, GIFT_CARD_LEDGER_KINDS)),
  check('gift_card_ledger_amount_nonzero', sql`${table.amountCents} != 0`),
  // Funding and returns add to the balance; reservations and reversals take from it.
  check('gift_card_ledger_amount_sign', sql`(${table.kind} IN ('issue', 'release', 'refund_restore') AND ${table.amountCents} > 0)
    OR (${table.kind} IN ('reserve', 'purchase_reversal') AND ${table.amountCents} < 0)`),
]);

export const giftCardRedemptions = sqliteTable('_ecommerce_gift_card_redemptions', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull().references(() => giftCards.id),
  orderId: text('order_id').notNull().references(() => orders.id).unique(),
  amountCents: integer('amount_cents').notNull(),
  status: text('status', { enum: REDEMPTION_STATUSES }).notNull().default('reserved'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  index('_ecommerce_gift_card_redemptions_card_idx').on(table.cardId, table.status),
  check('gift_card_redemption_amount_positive', money(table.amountCents, 'positive')),
  check('gift_card_redemption_status', oneOf(table.status, REDEMPTION_STATUSES)),
]);

export const giftCardRefunds = sqliteTable('_ecommerce_gift_card_refunds', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull().references(() => giftCards.id),
  orderId: text('order_id').notNull().references(() => orders.id),
  amountCents: integer('amount_cents').notNull(),
  adminActor: text('admin_actor').notNull(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  index('_ecommerce_gift_card_refunds_order_idx').on(table.orderId),
  check('gift_card_refund_amount_positive', money(table.amountCents, 'positive')),
]);

export const GIFT_CARD_REVIEW_OUTCOMES = ['reinstate', 'void'] as const;

/** Administrator decisions on purchases held for review after a provider refund. */
export const giftCardReviews = sqliteTable('_ecommerce_gift_card_reviews', {
  id: text('id').primaryKey(),
  purchaseId: text('purchase_id').notNull().references(() => giftCardPurchases.id),
  cardId: text('card_id').notNull().references(() => giftCards.id), // The card that held the purchase's value.
  outcome: text('outcome', { enum: GIFT_CARD_REVIEW_OUTCOMES }).notNull(),
  refundedCents: integer('refunded_cents').notNull(), // The provider refund total the decision covered.
  adjustmentCents: integer('adjustment_cents').notNull(), // Taken off the purchase's cards.
  adminActor: text('admin_actor').notNull(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  index('_ecommerce_gift_card_reviews_purchase_idx').on(table.purchaseId, table.createdAt),
  check('gift_card_review_outcome', oneOf(table.outcome, GIFT_CARD_REVIEW_OUTCOMES)),
  check('gift_card_review_refunded_positive', money(table.refundedCents, 'positive')),
  check('gift_card_review_adjustment_nonnegative', money(table.adjustmentCents, 'nonnegative')),
  check('gift_card_review_admin_actor_filled', filled(table.adminActor)),
  check('gift_card_review_reason_length', trimmed(table.reason, 8)),
]);

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
}, (table) => [
  index('_ecommerce_tax_reversals_order_idx').on(table.orderId),
  // Reversals recorded but not sent to the provider yet.
  index('_ecommerce_tax_reversals_unsent_idx').on(table.createdAt).where(sql`${table.providerReversalId} = ''`),
  check('tax_reversal_amount_positive', money(table.amount, 'positive')),
  ...taxSyncChecks('tax_reversal', table),
]);

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
}, (table) => [
  index('_ecommerce_disputes_order_idx').on(table.orderId).where(sql`${table.orderId} IS NOT NULL`),
  index('_ecommerce_disputes_purchase_idx').on(table.giftCardPurchaseId).where(sql`${table.giftCardPurchaseId} IS NOT NULL`),
  check('dispute_amount_nonnegative', money(table.amountCents, 'nonnegative')),
  check('dispute_names_one_subject', sql`(${table.orderId} IS NULL) <> (${table.giftCardPurchaseId} IS NULL)`),
]);

export const RESTOCK_RESERVATION_TYPES = ['inventory', 'component'] as const;
export const RESTOCK_TARGET_TYPES = ['product', 'variant', 'stock', 'component'] as const;

/** Reservation rows of refunded orders that an administrator returned to stock, each once, with the reason. */
export const restocks = sqliteTable('_ecommerce_restocks', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id),
  reservationType: text('reservation_type', { enum: RESTOCK_RESERVATION_TYPES }).notNull(),
  reservationId: text('reservation_id').notNull(),
  targetType: text('target_type', { enum: RESTOCK_TARGET_TYPES }).notNull(),
  targetId: text('target_id').notNull(),
  quantity: integer('quantity').notNull(),
  adminActor: text('admin_actor').notNull(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  uniqueIndex('_ecommerce_restocks_reservation_unique').on(table.reservationType, table.reservationId),
  index('_ecommerce_restocks_created_idx').on(table.createdAt),
  index('_ecommerce_restocks_order_idx').on(table.orderId, table.createdAt),
  index('_ecommerce_restocks_target_idx').on(table.targetType, table.targetId, table.createdAt),
  check('restock_reservation_type', oneOf(table.reservationType, RESTOCK_RESERVATION_TYPES)),
  check('restock_target_type', oneOf(table.targetType, RESTOCK_TARGET_TYPES)),
  check('restock_quantity_positive', money(table.quantity, 'positive')),
  check('restock_admin_actor_filled', filled(table.adminActor)),
  check('restock_reason_length', trimmed(table.reason, 8)),
]);

/**
 * Administrator decisions on orders and gift card purchases parked for review, each recorded with the
 * retry or release it carried out. Exactly one of orderId and purchaseId is set.
 */
export const RECONCILE_DECISION_ACTIONS = ['retry', 'release', 'attach_session'] as const;
export const PAYMENT_RETURNED_KINDS = ['refunded', 'dispute_lost', 'confirmed'] as const;

export const reconcileDecisions = sqliteTable('_ecommerce_reconcile_decisions', {
  id: text('id').primaryKey(),
  orderId: text('order_id').references(() => orders.id),
  purchaseId: text('purchase_id').references(() => giftCardPurchases.id),
  action: text('action', { enum: RECONCILE_DECISION_ACTIONS }).notNull(),
  failure: text('failure'), // The failure code the record was parked with.
  // How a released completed checkout's payment was shown to be returned; null for any other decision.
  paymentReturned: text('payment_returned', { enum: PAYMENT_RETURNED_KINDS }),
  adminActor: text('admin_actor').notNull(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  index('_ecommerce_reconcile_decisions_order_idx').on(table.orderId, table.createdAt),
  index('_ecommerce_reconcile_decisions_recent_idx').on(table.createdAt, table.id),
  index('_ecommerce_reconcile_decisions_purchase_idx').on(table.purchaseId, table.createdAt),
  check('reconcile_decision_action', oneOf(table.action, RECONCILE_DECISION_ACTIONS)),
  check('reconcile_decision_payment_returned', nullOrOneOf(table.paymentReturned, PAYMENT_RETURNED_KINDS)),
  check('reconcile_decision_admin_actor_filled', filled(table.adminActor)),
  check('reconcile_decision_reason_length', trimmed(table.reason, 8)),
  check('reconcile_decision_names_one_subject', sql`(${table.orderId} IS NULL) <> (${table.purchaseId} IS NULL)`),
  check('reconcile_decision_release_returns', sql`${table.paymentReturned} IS NULL OR ${table.action} = 'release'`),
]);

export const EMAIL_KINDS = ['order_confirmation', 'shipment', 'shipment_update', 'gift_card_claim', 'return_decision', 'return_received', 'return_refund'] as const;
export const EMAIL_STATUSES = ['pending', 'sent', 'failed', 'cancelled'] as const;

/**
 * Order confirmations, shipment notices and gift card claim emails: one row per email, written with the
 * change that calls for it. No addresses; `lastError` is an error code.
 */
export const emailDeliveries = sqliteTable('_ecommerce_email_deliveries', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: EMAIL_KINDS }).notNull(),
  /** The order, the shipment or correction (fulfillment id), or the gift card purchase. */
  subjectId: text('subject_id').notNull(),
  status: text('status', { enum: EMAIL_STATUSES }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp' }).notNull(),
  claimedAt: integer('claimed_at', { mode: 'timestamp' }),
  sentAt: integer('sent_at', { mode: 'timestamp' }),
  /** A staff retry starts a fresh delivery window without changing the original creation time. */
  retryRequestedAt: integer('retry_requested_at', { mode: 'timestamp' }),
  retryRequestId: text('retry_request_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  uniqueIndex('_ecommerce_email_deliveries_kind_subject_unique').on(table.kind, table.subjectId),
  index('_ecommerce_email_deliveries_attention_idx').on(table.createdAt, table.id)
    .where(sql`${table.status} = 'failed' OR (${table.status} = 'pending' AND ${table.lastError} IS NOT NULL)`),
  // The sender reads due emails; only pending ones are ever due.
  index('_ecommerce_email_deliveries_due_idx').on(table.nextAttemptAt).where(sql`${table.status} = 'pending'`),
  check('email_delivery_kind', oneOf(table.kind, EMAIL_KINDS)),
  check('email_delivery_status', oneOf(table.status, EMAIL_STATUSES)),
  check('email_delivery_attempts_nonnegative', money(table.attempts, 'nonnegative')),
  check('email_delivery_sent_has_time', sql`(${table.status} = 'sent') = (${table.sentAt} IS NOT NULL)`),
]);

/** Append-only staff requests to retry an email. The id hashes the client's retry key. */
export const emailRecoveryDecisions = sqliteTable('_ecommerce_email_recovery_decisions', {
  id: text('id').primaryKey(),
  emailId: text('email_id').notNull().references(() => emailDeliveries.id),
  fingerprint: text('fingerprint').notNull(),
  actor: text('actor').notNull(),
  reason: text('reason').notNull(),
  priorAttempts: integer('prior_attempts').notNull(),
  priorError: text('prior_error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  index('_ecommerce_email_recovery_recent_idx').on(table.createdAt, table.id),
  index('_ecommerce_email_recovery_email_idx').on(table.emailId, table.createdAt),
  check('email_recovery_actor', filled(table.actor)),
  check('email_recovery_reason', trimmed(table.reason, 8)),
  check('email_recovery_attempts', money(table.priorAttempts, 'nonnegative')),
]);

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
}, (table) => [
  index('_ecommerce_gift_card_claims_purchase_idx').on(table.purchaseId, table.createdAt),
  check('gift_card_claim_expires_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
  // Spelled out for NULL: a CHECK that evaluates to NULL passes. A resend names who and why, or neither.
  check('gift_card_claim_resend_shape', sql`(${table.createdBy} IS NULL AND ${table.reason} IS NULL)
    OR (${table.createdBy} IS NOT NULL AND ${table.reason} IS NOT NULL AND length(trim(${table.createdBy})) > 0 AND length(trim(${table.reason})) >= 8)`),
]);

export const SHOPPER_AUDIT_ACTIONS = ['export', 'revoke', 'anonymize'] as const;
export const shopperAudits = sqliteTable('_ecommerce_shopper_audits', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => customerAccounts.id),
  action: text('action', { enum: SHOPPER_AUDIT_ACTIONS }).notNull(),
  actor: text('actor').notNull(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  check('shopper_audit_action', oneOf(table.action, SHOPPER_AUDIT_ACTIONS)),
  check('shopper_audit_actor', filled(table.actor)),
  check('shopper_audit_reason', trimmed(table.reason, 8)),
]);

export const TAX_SYNC_ACTIONS = ['retry', 'attach'] as const;
export const taxSyncDecisions = sqliteTable('_ecommerce_tax_sync_decisions', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id),
  reversalId: text('reversal_id').references(() => taxReversals.id),
  action: text('action', { enum: TAX_SYNC_ACTIONS }).notNull(),
  providerId: text('provider_id'),
  actor: text('actor').notNull(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  index('_ecommerce_tax_sync_decisions_recent_idx').on(table.createdAt, table.id),
  check('tax_sync_action', oneOf(table.action, TAX_SYNC_ACTIONS)),
  check('tax_sync_actor', filled(table.actor)),
  check('tax_sync_reason', trimmed(table.reason, 8)),
  check('tax_sync_attach_id', sql`(${table.action} = 'attach') = (${table.providerId} IS NOT NULL)`),
]);

/** Immutable item allocations. lineIndex addresses the order's frozen items array. */
export type ParcelItem = { lineIndex: number; quantity: number };
export const PARCEL_CONTENT_SOURCES = ['shipment', 'backfill'] as const;
export const parcelContents = sqliteTable('_ecommerce_parcel_contents', {
  id: text('id').primaryKey(),
  fulfillmentId: text('fulfillment_id').notNull().references(() => fulfillments.id),
  orderId: text('order_id').notNull().references(() => orders.id),
  items: text('items', { mode: 'json' }).$type<ParcelItem[]>().notNull(),
  source: text('source', { enum: PARCEL_CONTENT_SOURCES }).notNull(),
  actor: text('actor').notNull(), reason: text('reason').notNull(), fingerprint: text('fingerprint').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => [uniqueIndex('_ecommerce_parcel_contents_shipment_unique').on(t.fulfillmentId),
  index('_ecommerce_parcel_contents_order_idx').on(t.orderId),
  check('parcel_items_array', sql`json_valid(${t.items}) AND json_type(${t.items}) = 'array' AND json_array_length(${t.items}) > 0`),
  check('parcel_source', oneOf(t.source, PARCEL_CONTENT_SOURCES)),
  check('parcel_actor', filled(t.actor)), check('parcel_reason', trimmed(t.reason, 8))]);
export const RETURN_CONDITIONS = ['sellable', 'damaged', 'inspection'] as const;
export type ReturnedItem = ParcelItem & { condition: typeof RETURN_CONDITIONS[number]; restock: boolean };
export const returnReceipts = sqliteTable('_ecommerce_return_receipts', {
  id: text('id').primaryKey(), orderId: text('order_id').notNull().references(() => orders.id),
  items: text('items', { mode: 'json' }).$type<ReturnedItem[]>().notNull(),
  actor: text('actor').notNull(), reason: text('reason').notNull(), fingerprint: text('fingerprint').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => [index('_ecommerce_return_receipts_created_idx').on(t.createdAt), index('_ecommerce_return_receipts_order_idx').on(t.orderId, t.createdAt),
  check('return_items_array', sql`json_valid(${t.items}) AND json_type(${t.items}) = 'array' AND json_array_length(${t.items}) > 0`),
  check('return_actor', filled(t.actor)), check('return_reason', trimmed(t.reason, 8))]);
/** A customer's requested quantities. Only an audited privacy redaction may replace its text. */
export const RETURN_REQUEST_STATUSES = ['pending', 'approved', 'declined', 'cancelled', 'closed'] as const;
export const RETURN_REQUEST_ACTORS = ['staff', 'customer'] as const;
export const returnRequests = sqliteTable('_ecommerce_return_requests', {
  id: text('id').primaryKey(), orderId: text('order_id').notNull().references(() => orders.id),
  items: text('items', { mode: 'json' }).$type<ParcelItem[]>().notNull(),
  reason: text('reason').notNull(), fingerprint: text('fingerprint').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(), redactedAt: integer('redacted_at', { mode: 'timestamp' }),
}, t => [index('_ecommerce_return_requests_order_idx').on(t.orderId), index('_ecommerce_return_requests_created_idx').on(t.createdAt),
  check('return_request_items', sql`json_valid(${t.items}) AND json_type(${t.items}) = 'array' AND json_array_length(${t.items}) BETWEEN 1 AND 50`),
  check('return_request_reason', trimmed(t.reason, 8))]);
/** Decisions append to the request; the last written event supplies its status and version. */
export const returnRequestEvents = sqliteTable('_ecommerce_return_request_events', {
  id: text('id').primaryKey(), requestId: text('request_id').notNull().references(() => returnRequests.id),
  status: text('status', { enum: RETURN_REQUEST_STATUSES }).notNull(), expectedVersion: text('expected_version').notNull(),
  actorKind: text('actor_kind', { enum: RETURN_REQUEST_ACTORS }).notNull(), actor: text('actor').notNull(),
  reason: text('reason').notNull(), customerMessage: text('customer_message').notNull(), fingerprint: text('fingerprint').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(), redactedAt: integer('redacted_at', { mode: 'timestamp' }),
}, t => [index('_ecommerce_return_request_events_request_idx').on(t.requestId),
  check('return_request_event_status', oneOf(t.status, RETURN_REQUEST_STATUSES)), check('return_request_event_actor_kind', oneOf(t.actorKind, RETURN_REQUEST_ACTORS)),
  check('return_request_event_actor', filled(t.actor)), check('return_request_event_reason', trimmed(t.reason, 8))]);
/** An intake can be linked to one approved request, in the same atomic intake transaction. */
export const returnRequestReceipts = sqliteTable('_ecommerce_return_request_receipts', {
  receiptId: text('receipt_id').primaryKey().references(() => returnReceipts.id),
  requestId: text('request_id').notNull().references(() => returnRequests.id),
}, t => [index('_ecommerce_return_request_receipts_request_idx').on(t.requestId)]);

/** Stock returned by an intake receipt, bounded by the original checkout reservation. */
export const returnStock = sqliteTable('_ecommerce_return_stock', {
  id: text('id').primaryKey(), receiptId: text('receipt_id').notNull().references(() => returnReceipts.id),
  orderId: text('order_id').notNull().references(() => orders.id),
  reservationType: text('reservation_type', { enum: RESTOCK_RESERVATION_TYPES }).notNull(), reservationId: text('reservation_id').notNull(),
  targetType: text('target_type', { enum: RESTOCK_TARGET_TYPES }).notNull(), targetId: text('target_id').notNull(),
  quantity: integer('quantity').notNull(),
}, t => [uniqueIndex('_ecommerce_return_stock_receipt_unique').on(t.receiptId, t.reservationType, t.reservationId),
  index('_ecommerce_return_stock_reservation_idx').on(t.reservationType, t.reservationId),
  index('_ecommerce_return_stock_order_idx').on(t.orderId),
  index('_ecommerce_return_stock_target_idx').on(t.targetType, t.targetId),
  check('return_stock_reservation_type', oneOf(t.reservationType, RESTOCK_RESERVATION_TYPES)),
  check('return_stock_target_type', oneOf(t.targetType, RESTOCK_TARGET_TYPES)), check('return_stock_quantity', money(t.quantity, 'positive'))]);
/** Inspection decisions never amend or receive the original goods again. */
export const INSPECTION_DISPOSITIONS = ['sellable', 'quarantine', 'damaged'] as const;
export type InspectedItem = ParcelItem & { disposition: typeof INSPECTION_DISPOSITIONS[number]; restock: boolean };
export const returnInspections = sqliteTable('_ecommerce_return_inspections', {
  id: text('id').primaryKey(), receiptId: text('receipt_id').notNull().references(() => returnReceipts.id),
  orderId: text('order_id').notNull().references(() => orders.id),
  items: text('items', { mode: 'json' }).$type<InspectedItem[]>().notNull(),
  actor: text('actor').notNull(), reason: text('reason').notNull(), fingerprint: text('fingerprint').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => [index('_ecommerce_return_inspections_created_idx').on(t.createdAt), index('_ecommerce_return_inspections_receipt_idx').on(t.receiptId), index('_ecommerce_return_inspections_order_idx').on(t.orderId),
  check('inspection_items_array', sql`json_valid(${t.items}) AND json_type(${t.items}) = 'array' AND json_array_length(${t.items}) > 0`),
  check('inspection_actor', filled(t.actor)), check('inspection_reason', trimmed(t.reason, 8))]);
/** Restored stock from inspected goods shares the same reservation budget as immediate intake. */
export const inspectionStock = sqliteTable('_ecommerce_inspection_stock', {
  id: text('id').primaryKey(), inspectionId: text('inspection_id').notNull().references(() => returnInspections.id),
  orderId: text('order_id').notNull().references(() => orders.id),
  reservationType: text('reservation_type', { enum: RESTOCK_RESERVATION_TYPES }).notNull(), reservationId: text('reservation_id').notNull(),
  targetType: text('target_type', { enum: RESTOCK_TARGET_TYPES }).notNull(), targetId: text('target_id').notNull(), quantity: integer('quantity').notNull(),
}, t => [uniqueIndex('_ecommerce_inspection_stock_decision_unique').on(t.inspectionId, t.reservationType, t.reservationId),
  index('_ecommerce_inspection_stock_reservation_idx').on(t.reservationType, t.reservationId), index('_ecommerce_inspection_stock_order_idx').on(t.orderId),
  index('_ecommerce_inspection_stock_target_idx').on(t.targetType, t.targetId),
  check('inspection_stock_reservation', oneOf(t.reservationType, RESTOCK_RESERVATION_TYPES)), check('inspection_stock_target', oneOf(t.targetType, RESTOCK_TARGET_TYPES)),
  check('inspection_stock_quantity', money(t.quantity, 'positive'))]);
export type StocktakeLine = { expectedUpdatedSeconds?: number; name?: string; sku?: string | null; targetType: typeof RESTOCK_TARGET_TYPES[number]; targetId: string; expectedQuantity: number; expectedUpdatedAt: string; countedQuantity: number };
/** All counted rows, including unchanged counts, are retained in one immutable stocktake receipt. */
export const stocktakes = sqliteTable('_ecommerce_stocktakes', {
  id: text('id').primaryKey(), lines: text('lines', { mode: 'json' }).$type<StocktakeLine[]>().notNull(),
  actor: text('actor').notNull(), reason: text('reason').notNull(), fingerprint: text('fingerprint').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => [index('_ecommerce_stocktakes_created_idx').on(t.createdAt),
  check('stocktake_lines_array', sql`json_valid(${t.lines}) AND json_type(${t.lines}) = 'array' AND json_array_length(${t.lines}) BETWEEN 1 AND 50`),
  check('stocktake_actor', filled(t.actor)), check('stocktake_reason', trimmed(t.reason, 8))]);
export const STOCK_MOVEMENT_KINDS = ['receipt', 'correction'] as const;
export const stockMovements = sqliteTable('_ecommerce_stock_movements', {
  id: text('id').primaryKey(), targetType: text('target_type', { enum: RESTOCK_TARGET_TYPES }).notNull(), targetId: text('target_id').notNull(),
  kind: text('kind', { enum: STOCK_MOVEMENT_KINDS }).notNull(), delta: integer('delta').notNull(),
  beforeQuantity: integer('before_quantity').notNull(), afterQuantity: integer('after_quantity').notNull(),
  expectedUpdatedAt: integer('expected_updated_at', { mode: 'timestamp' }).notNull(),
  actor: text('actor').notNull(), reason: text('reason').notNull(), fingerprint: text('fingerprint').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => [index('_ecommerce_stock_movements_created_idx').on(t.createdAt), index('_ecommerce_stock_movements_target_idx').on(t.targetType, t.targetId, t.createdAt),
  check('stock_movement_target', oneOf(t.targetType, RESTOCK_TARGET_TYPES)), check('stock_movement_kind', oneOf(t.kind, STOCK_MOVEMENT_KINDS)),
  check('stock_movement_delta', sql`${t.delta} <> 0 AND (${t.kind} <> 'receipt' OR ${t.delta} > 0)`),
  check('stock_movement_before', money(t.beforeQuantity, 'nonnegative')), check('stock_movement_after', money(t.afterQuantity, 'nonnegative')),
  check('stock_movement_balance', sql`${t.afterQuantity} = ${t.beforeQuantity} + ${t.delta}`),
  check('stock_movement_actor', filled(t.actor)), check('stock_movement_reason', trimmed(t.reason, 8))]);


export const RETURN_REFUND_STATUSES = ['needed', 'not_needed', 'settled'] as const;
export const REFUND_SOURCE_KINDS = ['provider', 'gift_card', 'store_credit'] as const;
export type RefundAllocation = { kind: typeof REFUND_SOURCE_KINDS[number]; sourceId: string; amountMinor: number };
/** Staff follow-up only. Allocations point to existing money ledgers; this table never refunds money. */
export const returnRefundDecisions = sqliteTable('_ecommerce_return_refund_decisions', {
  id: text('id').primaryKey(), receiptId: text('receipt_id').notNull().references(() => returnReceipts.id),
  expectedVersion: text('expected_version').notNull(), status: text('status', { enum: RETURN_REFUND_STATUSES }).notNull(),
  amountMinor: integer('amount_minor').notNull(), allocations: text('allocations', { mode: 'json' }).$type<RefundAllocation[]>().notNull(),
  actor: text('actor').notNull(), reason: text('reason').notNull(), fingerprint: text('fingerprint').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(), redactedAt: integer('redacted_at', { mode: 'timestamp' }),
}, t => [index('_ecommerce_return_refunds_receipt_idx').on(t.receiptId),
  check('return_refund_status', oneOf(t.status, RETURN_REFUND_STATUSES)),
  check('return_refund_amount', sql`${t.amountMinor} BETWEEN 0 AND 9007199254740991 AND ((${t.status} = 'not_needed' AND ${t.amountMinor} = 0) OR (${t.status} <> 'not_needed' AND ${t.amountMinor} > 0))`),
  check('return_refund_allocations', sql`json_valid(${t.allocations}) AND json_type(${t.allocations}) = 'array' AND json_array_length(${t.allocations}) <= 20 AND (${t.status} = 'settled' OR json_array_length(${t.allocations}) = 0)`),
  check('return_refund_actor', filled(t.actor)), check('return_refund_reason', trimmed(t.reason, 8))]);

export const replenishmentPolicies = sqliteTable('_ecommerce_replenishment_policies', {
  id: text('id').primaryKey(), targetType: text('target_type', { enum: RESTOCK_TARGET_TYPES }).notNull(), targetId: text('target_id').notNull(),
  minimumQuantity: integer('minimum_quantity').notNull(), targetQuantity: integer('target_quantity').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(), expectedVersion: text('expected_version'),
  actor: text('actor').notNull(), reason: text('reason').notNull(), fingerprint: text('fingerprint').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => [index('_ecommerce_replenishment_policy_target_idx').on(t.targetType, t.targetId),
  check('replenishment_policy_target', oneOf(t.targetType, RESTOCK_TARGET_TYPES)), check('replenishment_policy_enabled', flag(t.enabled)),
  check('replenishment_policy_quantities', sql`${t.minimumQuantity} BETWEEN 0 AND 1000000 AND ${t.targetQuantity} BETWEEN ${t.minimumQuantity} AND 1000000`),
  check('replenishment_policy_actor', filled(t.actor)), check('replenishment_policy_reason', trimmed(t.reason, 8))]);
export const replenishmentDeliveries = sqliteTable('_ecommerce_replenishment_deliveries', {
  id: text('id').primaryKey(), targetType: text('target_type', { enum: RESTOCK_TARGET_TYPES }).notNull(), targetId: text('target_id').notNull(),
  quantity: integer('quantity').notNull(), supplier: text('supplier').notNull(), reference: text('reference').notNull(), expectedDate: text('expected_date').notNull(),
  actor: text('actor').notNull(), reason: text('reason').notNull(), fingerprint: text('fingerprint').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => [index('_ecommerce_replenishment_delivery_target_idx').on(t.targetType, t.targetId), index('_ecommerce_replenishment_delivery_date_idx').on(t.expectedDate),
  check('replenishment_delivery_target', oneOf(t.targetType, RESTOCK_TARGET_TYPES)), check('replenishment_delivery_quantity', sql`${t.quantity} BETWEEN 1 AND 1000000`),
  check('replenishment_delivery_date', sql`length(${t.expectedDate}) = 10 AND date(${t.expectedDate}, '+0 days') IS NOT NULL AND date(${t.expectedDate}, '+0 days') = ${t.expectedDate}`),
  check('replenishment_delivery_supplier', filled(t.supplier)), check('replenishment_delivery_actor', filled(t.actor)), check('replenishment_delivery_reason', trimmed(t.reason, 8))]);
export const REPLENISHMENT_EVENT_KINDS = ['received', 'cancelled'] as const;
export const replenishmentDeliveryEvents = sqliteTable('_ecommerce_replenishment_delivery_events', {
  id: text('id').primaryKey(), deliveryId: text('delivery_id').notNull().references(() => replenishmentDeliveries.id),
  kind: text('kind', { enum: REPLENISHMENT_EVENT_KINDS }).notNull(), movementId: text('movement_id').references(() => stockMovements.id),
  expectedVersion: text('expected_version').notNull(), actor: text('actor').notNull(), reason: text('reason').notNull(), fingerprint: text('fingerprint').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => [index('_ecommerce_replenishment_event_delivery_idx').on(t.deliveryId), uniqueIndex('_ecommerce_replenishment_event_movement_unique').on(t.movementId),
  check('replenishment_event_kind', oneOf(t.kind, REPLENISHMENT_EVENT_KINDS)),
  check('replenishment_event_movement', sql`(${t.kind} = 'received') = (${t.movementId} IS NOT NULL)`),
  check('replenishment_event_actor', filled(t.actor)), check('replenishment_event_reason', trimmed(t.reason, 8))]);


export const RETURN_REASON_CODES = ['size_fit', 'damaged', 'wrong_item', 'changed_mind', 'other', 'unspecified'] as const;
/** A structured category; shoppers' free-text explanations never enter aggregate reports. */
export const returnRequestReasons = sqliteTable('_ecommerce_return_request_reasons', {
  requestId: text('request_id').primaryKey().references(() => returnRequests.id),
  code: text('code', { enum: RETURN_REASON_CODES }).notNull(),
}, t => [check('return_reason_code', oneOf(t.code, RETURN_REASON_CODES))]);

export const suppliers = sqliteTable('_ecommerce_suppliers', {
  id: text('id').primaryKey(), createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
export const supplierRevisions = sqliteTable('_ecommerce_supplier_revisions', {
  id: text('id').primaryKey(), supplierId: text('supplier_id').notNull().references(() => suppliers.id),
  expectedVersion: text('expected_version'), name: text('name').notNull(), contact: text('contact').notNull(), address: text('address').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(), actor: text('actor').notNull(), reason: text('reason').notNull(),
  fingerprint: text('fingerprint').notNull(), createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => [index('_ecommerce_supplier_revision_supplier_idx').on(t.supplierId), check('supplier_name', trimmed(t.name, 1)),
  check('supplier_name_length', sql`length(${t.name}) <= 200`), check('supplier_contact', sql`length(${t.contact}) <= 500`), check('supplier_address', sql`length(${t.address}) <= 1000`),
  check('supplier_active', flag(t.active)), check('supplier_actor', filled(t.actor)), check('supplier_reason', trimmed(t.reason, 8))]);
export const PURCHASE_ORDER_STATUSES = ['draft', 'ordered', 'cancelled'] as const;
export type PurchaseLine = { targetType: typeof RESTOCK_TARGET_TYPES[number]; targetId: string; quantity: number; name: string; sku: string | null };
export type SupplierSnapshot = { version: string; name: string; contact: string; address: string };
export const purchaseOrders = sqliteTable('_ecommerce_purchase_orders', {
  id: text('id').primaryKey(), supplierId: text('supplier_id').notNull().references(() => suppliers.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => [index('_ecommerce_purchase_order_supplier_idx').on(t.supplierId)]);
export const purchaseOrderEvents = sqliteTable('_ecommerce_purchase_order_events', {
  id: text('id').primaryKey(), purchaseOrderId: text('purchase_order_id').notNull().references(() => purchaseOrders.id),
  expectedVersion: text('expected_version'), status: text('status', { enum: PURCHASE_ORDER_STATUSES }).notNull(),
  reference: text('reference').notNull(), expectedDate: text('expected_date').notNull(),
  lines: text('lines', { mode: 'json' }).$type<PurchaseLine[]>().notNull(),
  supplier: text('supplier', { mode: 'json' }).$type<SupplierSnapshot>().notNull(),
  actor: text('actor').notNull(), reason: text('reason').notNull(), fingerprint: text('fingerprint').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => [index('_ecommerce_purchase_order_event_order_idx').on(t.purchaseOrderId), check('purchase_order_status', oneOf(t.status, PURCHASE_ORDER_STATUSES)),
  check('purchase_order_reference', trimmed(t.reference, 1)),
  check('purchase_order_reference_length', sql`length(${t.reference}) <= 200`), check('purchase_order_date', sql`length(${t.expectedDate})=10 AND date(${t.expectedDate}, '+0 days') IS NOT NULL AND date(${t.expectedDate}, '+0 days')=${t.expectedDate}`),
  check('purchase_order_lines', sql`json_valid(${t.lines}) AND json_type(${t.lines})='array' AND json_array_length(${t.lines}) BETWEEN 1 AND 20`),
  check('purchase_order_supplier', sql`json_valid(${t.supplier}) AND json_type(${t.supplier})='object'`),
  check('purchase_order_actor', filled(t.actor)), check('purchase_order_reason', trimmed(t.reason, 8))]);
/** Each confirmed line uses the existing delivery and stock receipt history exactly once. */
export const purchaseOrderLines = sqliteTable('_ecommerce_purchase_order_lines', {
  id: text('id').primaryKey(), purchaseOrderId: text('purchase_order_id').notNull().references(() => purchaseOrders.id),
  lineIndex: integer('line_index').notNull(), deliveryId: text('delivery_id').notNull().references(() => replenishmentDeliveries.id),
}, t => [uniqueIndex('_ecommerce_purchase_order_line_unique').on(t.purchaseOrderId, t.lineIndex),
  uniqueIndex('_ecommerce_purchase_order_delivery_unique').on(t.deliveryId), check('purchase_order_line_index', sql`${t.lineIndex} BETWEEN 0 AND 19`)]);

// --- Relations, for the relational query builder ---

const tables = {
  suppliers, supplierRevisions, purchaseOrders, purchaseOrderEvents, purchaseOrderLines, returnRequestReasons,
  returnRefundDecisions, replenishmentPolicies, replenishmentDeliveries, replenishmentDeliveryEvents,
  returnRequests, returnRequestEvents, returnRequestReceipts, parcelContents, returnReceipts, returnStock, returnInspections, inspectionStock, stocktakes, stockMovements, carts, orders, payments, providerRefunds, products, variants, productVariants, productVariantValues, stocks, components,
  variantComponents, componentReservations, inventoryReservations, categories, productCategories, tags, productTags,
  customers, customerAccounts, customerSessions, signInTokens, rateLimits, fulfillments, referralCodes, referrals,
  creditLedger, referralSettings, discountCodes, discountCodeCreations, discountRedemptions, giftCardPurchases, giftCards, giftCardLedger,
  giftCardRedemptions, giftCardRefunds, giftCardReviews, giftCardOrderRefunds, taxReversals, disputes, restocks,
  reconcileDecisions, emailDeliveries, emailRecoveryDecisions, giftCardClaims, giftCardCodeReplacements, shopperAudits, taxSyncDecisions, cmsUsers,
};

/**
 * Every commerce table with a relation for each of its foreign keys, in both directions, and for the
 * links the schema keeps without a key: an order's shopper account and gift card, a customer session's
 * order, a reservation's stock record and restock. The catalog junctions are `.through()` relations,
 * so `products.categories` and `products.tags` are categories and tags, not junction rows. The
 * plugin reads through them (`commerceDb(env).query.<table>`), and `createDbClient(env, relations)`
 * gives a site's own code the same `db.query`. `test/relations.test.mjs` checks that no key is missed.
 */
export const relations = defineRelations(tables, (r) => ({
  suppliers: { revisions: r.many.supplierRevisions(), purchaseOrders: r.many.purchaseOrders() },
  supplierRevisions: { supplier: r.one.suppliers({ from: r.supplierRevisions.supplierId, to: r.suppliers.id, optional: false }) },
  purchaseOrders: { supplier: r.one.suppliers({ from: r.purchaseOrders.supplierId, to: r.suppliers.id, optional: false }), events: r.many.purchaseOrderEvents(), lines: r.many.purchaseOrderLines() },
  purchaseOrderEvents: { purchaseOrder: r.one.purchaseOrders({ from: r.purchaseOrderEvents.purchaseOrderId, to: r.purchaseOrders.id, optional: false }) },
  purchaseOrderLines: { purchaseOrder: r.one.purchaseOrders({ from: r.purchaseOrderLines.purchaseOrderId, to: r.purchaseOrders.id, optional: false }), delivery: r.one.replenishmentDeliveries({ from: r.purchaseOrderLines.deliveryId, to: r.replenishmentDeliveries.id, optional: false }) },
  returnRequestReasons: { request: r.one.returnRequests({ from: r.returnRequestReasons.requestId, to: r.returnRequests.id, optional: false }) },
  returnRefundDecisions: { receipt: r.one.returnReceipts({ from: r.returnRefundDecisions.receiptId, to: r.returnReceipts.id, optional: false }) },
  stockMovements: { deliveries: r.many.replenishmentDeliveryEvents() },
  replenishmentDeliveries: {
    purchaseLine: r.one.purchaseOrderLines({ from: r.replenishmentDeliveries.id, to: r.purchaseOrderLines.deliveryId }), events: r.many.replenishmentDeliveryEvents() },
  replenishmentDeliveryEvents: {
    delivery: r.one.replenishmentDeliveries({ from: r.replenishmentDeliveryEvents.deliveryId, to: r.replenishmentDeliveries.id, optional: false }),
    movement: r.one.stockMovements({ from: r.replenishmentDeliveryEvents.movementId, to: r.stockMovements.id }),
  },
  carts: {
    /** The order a checkout placed from the cart; a cart is checked out once. */
    order: r.one.orders({ from: r.carts.id, to: r.orders.cartId }),
  },
  orders: {
    cart: r.one.carts({ from: r.orders.cartId, to: r.carts.id }),
    /** The shopper account that placed the order (`userId`); null for a guest order. */
    account: r.one.customerAccounts({ from: r.orders.userId, to: r.customerAccounts.id }),
    /** The gift card the order spent (`giftCardId`). */
    giftCard: r.one.giftCards({ from: r.orders.giftCardId, to: r.giftCards.id }),
    payments: r.many.payments(),
    providerRefunds: r.many.providerRefunds(),
    componentReservations: r.many.componentReservations(),
    inventoryReservations: r.many.inventoryReservations(),
    fulfillments: r.many.fulfillments(),
    returnRequests: r.many.returnRequests(), parcelContents: r.many.parcelContents(), returnReceipts: r.many.returnReceipts(), returnStock: r.many.returnStock(), returnInspections: r.many.returnInspections(), inspectionStock: r.many.inspectionStock(),
    referral: r.one.referrals({ from: r.orders.id, to: r.referrals.orderId }),
    creditLedger: r.many.creditLedger(),
    discountRedemption: r.one.discountRedemptions({ from: r.orders.id, to: r.discountRedemptions.orderId }),
    giftCardRedemption: r.one.giftCardRedemptions({ from: r.orders.id, to: r.giftCardRedemptions.orderId }),
    giftCardLedger: r.many.giftCardLedger(),
    giftCardRefunds: r.many.giftCardRefunds(),
    giftCardOrderRefund: r.one.giftCardOrderRefunds({ from: r.orders.id, to: r.giftCardOrderRefunds.orderId }),
    taxReversals: r.many.taxReversals(),
    disputes: r.many.disputes(),
    restocks: r.many.restocks(),
    reconcileDecisions: r.many.reconcileDecisions(),
    /** The order-status sessions opened for the order. */
    customerSessions: r.many.customerSessions(),
    taxSyncDecisions: r.many.taxSyncDecisions(),
  },
  payments: { order: r.one.orders({ from: r.payments.orderId, to: r.orders.id, optional: false }) },
  providerRefunds: { order: r.one.orders({ from: r.providerRefunds.orderId, to: r.orders.id, optional: false }) },
  products: {
    /** The product's variant groups. */
    variants: r.many.productVariants(),
    categories: r.many.categories({
      from: r.products.id.through(r.productCategories.productId),
      to: r.categories.id.through(r.productCategories.categoryId),
    }),
    tags: r.many.tags({
      from: r.products.id.through(r.productTags.productId),
      to: r.tags.id.through(r.productTags.tagId),
    }),
    /** Checkout holds on the product's own stock. */
    inventoryReservations: r.many.inventoryReservations({
      from: r.products.id, to: r.inventoryReservations.targetId, where: { targetType: 'product' },
    }),
  },
  variants: { productVariants: r.many.productVariants() },
  productVariants: {
    product: r.one.products({ from: r.productVariants.productId, to: r.products.id, optional: false }),
    /** The variant definition the group is an instance of; null for a group named on its own. */
    variant: r.one.variants({ from: r.productVariants.variantId, to: r.variants.id }),
    values: r.many.productVariantValues(),
    /** Checkout holds on the group's own stock (a group sold without values). */
    inventoryReservations: r.many.inventoryReservations({
      from: r.productVariants.id, to: r.inventoryReservations.targetId, where: { targetType: 'variant' },
    }),
  },
  productVariantValues: {
    productVariant: r.one.productVariants({ from: r.productVariantValues.productVariantId, to: r.productVariants.id, optional: false }),
    stock: r.one.stocks({ from: r.productVariantValues.id, to: r.stocks.productVariantValueId }),
    /** The value's bill of materials: each component with the quantity one unit needs. */
    requirements: r.many.variantComponents(),
  },
  stocks: {
    productVariantValue: r.one.productVariantValues({ from: r.stocks.productVariantValueId, to: r.productVariantValues.id, optional: false }),
    inventoryReservations: r.many.inventoryReservations({
      from: r.stocks.id, to: r.inventoryReservations.targetId, where: { targetType: 'stock' },
    }),
  },
  components: {
    /** The variant values whose bill of materials names the component. */
    requirements: r.many.variantComponents(),
    reservations: r.many.componentReservations(),
  },
  variantComponents: {
    productVariantValue: r.one.productVariantValues({ from: r.variantComponents.productVariantValueId, to: r.productVariantValues.id, optional: false }),
    component: r.one.components({ from: r.variantComponents.componentId, to: r.components.id, optional: false }),
  },
  componentReservations: {
    order: r.one.orders({ from: r.componentReservations.orderId, to: r.orders.id, optional: false }),
    component: r.one.components({ from: r.componentReservations.componentId, to: r.components.id, optional: false }),
    /** The restock that returned the reservation's stock, if one did. */
    restock: r.one.restocks({ from: r.componentReservations.id, to: r.restocks.reservationId, where: { reservationType: 'component' } }),
  },
  inventoryReservations: {
    order: r.one.orders({ from: r.inventoryReservations.orderId, to: r.orders.id, optional: false }),
    // The target is one of three tables by targetType; ids never repeat across them, so each is
    // joined by id alone and the reader picks the one the type names.
    product: r.one.products({ from: r.inventoryReservations.targetId, to: r.products.id }),
    productVariant: r.one.productVariants({ from: r.inventoryReservations.targetId, to: r.productVariants.id }),
    stock: r.one.stocks({ from: r.inventoryReservations.targetId, to: r.stocks.id }),
    restock: r.one.restocks({ from: r.inventoryReservations.id, to: r.restocks.reservationId, where: { reservationType: 'inventory' } }),
  },
  categories: {
    parent: r.one.categories({ from: r.categories.parentId, to: r.categories.id, alias: 'category_hierarchy' }),
    children: r.many.categories({ alias: 'category_hierarchy' }),
    products: r.many.products(),
  },
  productCategories: {
    product: r.one.products({ from: r.productCategories.productId, to: r.products.id, optional: false }),
    category: r.one.categories({ from: r.productCategories.categoryId, to: r.categories.id, optional: false }),
  },
  tags: { products: r.many.products() },
  productTags: {
    product: r.one.products({ from: r.productTags.productId, to: r.products.id, optional: false }),
    tag: r.one.tags({ from: r.productTags.tagId, to: r.tags.id, optional: false }),
  },
  customerAccounts: {
    audits: r.many.shopperAudits(),
    /** The shared CMS user the shopper's verified email links to. */
    cmsUser: r.one.cmsUsers({ from: r.customerAccounts.cmsUserId, to: r.cmsUsers.id }),
    orders: r.many.orders({ from: r.customerAccounts.id, to: r.orders.userId }),
    sessions: r.many.customerSessions(),
    referralCode: r.one.referralCodes({ from: r.customerAccounts.id, to: r.referralCodes.accountId }),
    /** The referrals the account's code earned. */
    referralsMade: r.many.referrals({ from: r.customerAccounts.id, to: r.referrals.referrerAccountId }),
    /** The referral that brought the account in, if one did. */
    referredBy: r.one.referrals({ from: r.customerAccounts.id, to: r.referrals.referredAccountId }),
    creditLedger: r.many.creditLedger(),
    discountRedemptions: r.many.discountRedemptions(),
  },
  customerSessions: {
    account: r.one.customerAccounts({ from: r.customerSessions.accountId, to: r.customerAccounts.id, optional: false }),
    /** The order an order-status session shows; null for an account session. */
    order: r.one.orders({ from: r.customerSessions.orderId, to: r.orders.id }),
  },
  parcelContents: { order: r.one.orders({ from: r.parcelContents.orderId, to: r.orders.id, optional: false }),
    fulfillment: r.one.fulfillments({ from: r.parcelContents.fulfillmentId, to: r.fulfillments.id, optional: false }) },
  returnRequests: {
    reasonCategory: r.one.returnRequestReasons({ from: r.returnRequests.id, to: r.returnRequestReasons.requestId }), order: r.one.orders({ from: r.returnRequests.orderId, to: r.orders.id, optional: false }), events: r.many.returnRequestEvents(), receipts: r.many.returnRequestReceipts() },
  returnRequestEvents: { request: r.one.returnRequests({ from: r.returnRequestEvents.requestId, to: r.returnRequests.id, optional: false }) },
  returnRequestReceipts: { request: r.one.returnRequests({ from: r.returnRequestReceipts.requestId, to: r.returnRequests.id, optional: false }), receipt: r.one.returnReceipts({ from: r.returnRequestReceipts.receiptId, to: r.returnReceipts.id, optional: false }) },
  returnReceipts: { refundDecisions: r.many.returnRefundDecisions(), requestLinks: r.many.returnRequestReceipts(), order: r.one.orders({ from: r.returnReceipts.orderId, to: r.orders.id, optional: false }), stock: r.many.returnStock(), inspections: r.many.returnInspections() },
  returnInspections: { receipt: r.one.returnReceipts({ from: r.returnInspections.receiptId, to: r.returnReceipts.id, optional: false }),
    order: r.one.orders({ from: r.returnInspections.orderId, to: r.orders.id, optional: false }), stock: r.many.inspectionStock() },
  inspectionStock: { inspection: r.one.returnInspections({ from: r.inspectionStock.inspectionId, to: r.returnInspections.id, optional: false }),
    order: r.one.orders({ from: r.inspectionStock.orderId, to: r.orders.id, optional: false }) },
  returnStock: { receipt: r.one.returnReceipts({ from: r.returnStock.receiptId, to: r.returnReceipts.id, optional: false }),
    order: r.one.orders({ from: r.returnStock.orderId, to: r.orders.id, optional: false }) },
  fulfillments: {
    contents: r.one.parcelContents(),
    order: r.one.orders({ from: r.fulfillments.orderId, to: r.orders.id, optional: false }),
    /** The shipment a correction restates. */
    corrects: r.one.fulfillments({ from: r.fulfillments.correctsId, to: r.fulfillments.id, alias: 'fulfillment_corrections' }),
    corrections: r.many.fulfillments({ alias: 'fulfillment_corrections' }),
  },
  referralCodes: {
    account: r.one.customerAccounts({ from: r.referralCodes.accountId, to: r.customerAccounts.id, optional: false }),
    referrals: r.many.referrals(),
  },
  referrals: {
    referralCode: r.one.referralCodes({ from: r.referrals.code, to: r.referralCodes.code, optional: false }),
    referrer: r.one.customerAccounts({ from: r.referrals.referrerAccountId, to: r.customerAccounts.id, optional: false }),
    referred: r.one.customerAccounts({ from: r.referrals.referredAccountId, to: r.customerAccounts.id, optional: false }),
    order: r.one.orders({ from: r.referrals.orderId, to: r.orders.id, optional: false }),
  },
  creditLedger: {
    account: r.one.customerAccounts({ from: r.creditLedger.accountId, to: r.customerAccounts.id, optional: false }),
    order: r.one.orders({ from: r.creditLedger.orderId, to: r.orders.id, optional: false }),
  },
  discountCodes: { redemptions: r.many.discountRedemptions(), creation: r.one.discountCodeCreations() },
  discountCodeCreations: {
    discountCode: r.one.discountCodes({ from: r.discountCodeCreations.code, to: r.discountCodes.code, optional: false }),
  },
  discountRedemptions: {
    discountCode: r.one.discountCodes({ from: r.discountRedemptions.code, to: r.discountCodes.code, optional: false }),
    order: r.one.orders({ from: r.discountRedemptions.orderId, to: r.orders.id, optional: false }),
    account: r.one.customerAccounts({ from: r.discountRedemptions.accountId, to: r.customerAccounts.id }),
  },
  giftCardPurchases: {
    /** The card the purchase issued. */
    card: r.one.giftCards({ from: r.giftCardPurchases.id, to: r.giftCards.purchaseId }),
    /** Administrator-issued cards that took over the purchase's value. */
    replacementCards: r.many.giftCards({ from: r.giftCardPurchases.id, to: r.giftCards.replacesPurchaseId }),
    ledger: r.many.giftCardLedger(),
    reviews: r.many.giftCardReviews(),
    claims: r.many.giftCardClaims(),
    disputes: r.many.disputes(),
    reconcileDecisions: r.many.reconcileDecisions(),
  },
  giftCards: {
    purchase: r.one.giftCardPurchases({ from: r.giftCards.purchaseId, to: r.giftCardPurchases.id }),
    replacesPurchase: r.one.giftCardPurchases({ from: r.giftCards.replacesPurchaseId, to: r.giftCardPurchases.id }),
    ledger: r.many.giftCardLedger(),
    redemptions: r.many.giftCardRedemptions(),
    refunds: r.many.giftCardRefunds(),
    reviews: r.many.giftCardReviews(),
    claims: r.many.giftCardClaims(),
    codeReplacements: r.many.giftCardCodeReplacements(),
    orders: r.many.orders(),
  },
  giftCardCodeReplacements: {
    card: r.one.giftCards({ from: r.giftCardCodeReplacements.cardId, to: r.giftCards.id, optional: false }),
    previousReplacement: r.one.giftCardCodeReplacements({ from: r.giftCardCodeReplacements.previousReplacementId, to: r.giftCardCodeReplacements.id }),
    subsequentReplacements: r.many.giftCardCodeReplacements({ from: r.giftCardCodeReplacements.id, to: r.giftCardCodeReplacements.previousReplacementId }),
  },
  giftCardLedger: {
    card: r.one.giftCards({ from: r.giftCardLedger.cardId, to: r.giftCards.id, optional: false }),
    order: r.one.orders({ from: r.giftCardLedger.orderId, to: r.orders.id }),
    purchase: r.one.giftCardPurchases({ from: r.giftCardLedger.purchaseId, to: r.giftCardPurchases.id }),
  },
  giftCardRedemptions: {
    card: r.one.giftCards({ from: r.giftCardRedemptions.cardId, to: r.giftCards.id, optional: false }),
    order: r.one.orders({ from: r.giftCardRedemptions.orderId, to: r.orders.id, optional: false }),
  },
  giftCardRefunds: {
    card: r.one.giftCards({ from: r.giftCardRefunds.cardId, to: r.giftCards.id, optional: false }),
    order: r.one.orders({ from: r.giftCardRefunds.orderId, to: r.orders.id, optional: false }),
  },
  giftCardReviews: {
    purchase: r.one.giftCardPurchases({ from: r.giftCardReviews.purchaseId, to: r.giftCardPurchases.id, optional: false }),
    card: r.one.giftCards({ from: r.giftCardReviews.cardId, to: r.giftCards.id, optional: false }),
  },
  giftCardOrderRefunds: { order: r.one.orders({ from: r.giftCardOrderRefunds.orderId, to: r.orders.id, optional: false }) },
  taxReversals: { order: r.one.orders({ from: r.taxReversals.orderId, to: r.orders.id, optional: false }),
    decisions: r.many.taxSyncDecisions() },
  disputes: {
    order: r.one.orders({ from: r.disputes.orderId, to: r.orders.id }),
    giftCardPurchase: r.one.giftCardPurchases({ from: r.disputes.giftCardPurchaseId, to: r.giftCardPurchases.id }),
  },
  restocks: { order: r.one.orders({ from: r.restocks.orderId, to: r.orders.id, optional: false }) },
  reconcileDecisions: {
    order: r.one.orders({ from: r.reconcileDecisions.orderId, to: r.orders.id }),
    purchase: r.one.giftCardPurchases({ from: r.reconcileDecisions.purchaseId, to: r.giftCardPurchases.id }),
  },
  giftCardClaims: {
    purchase: r.one.giftCardPurchases({ from: r.giftCardClaims.purchaseId, to: r.giftCardPurchases.id, optional: false }),
    card: r.one.giftCards({ from: r.giftCardClaims.cardId, to: r.giftCards.id, optional: false }),
  },
  emailDeliveries: { recoveryDecisions: r.many.emailRecoveryDecisions() },
  emailRecoveryDecisions: { email: r.one.emailDeliveries({ from: r.emailRecoveryDecisions.emailId,
    to: r.emailDeliveries.id, optional: false }) },
  shopperAudits: { account: r.one.customerAccounts({ from: r.shopperAudits.accountId, to: r.customerAccounts.id, optional: false }) },
  taxSyncDecisions: { order: r.one.orders({ from: r.taxSyncDecisions.orderId, to: r.orders.id, optional: false }),
    reversal: r.one.taxReversals({ from: r.taxSyncDecisions.reversalId, to: r.taxReversals.id }) },
  cmsUsers: { customerAccount: r.one.customerAccounts({ from: r.cmsUsers.id, to: r.customerAccounts.cmsUserId }) },
}));
