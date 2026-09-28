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
  taxBehavior: text('tax_behavior', { enum: TAX_BEHAVIORS }),
  taxCalculationId: text('tax_calculation_id'),
  taxTransactionId: text('tax_transaction_id'),
  // Payment: draft, pending, paid, partially_refunded, refunded, disputed or cancelled. The legacy
  // 'fulfilled' is still read as paid.
  status: text('status').notNull().default('draft'),
  /** Shipping, kept apart from payment so that a refund never hides a shipment. */
  fulfillmentStatus: text('fulfillment_status', { enum: FULFILLMENT_STATUSES }).notNull().default('unfulfilled'),
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
}, (table) => [
  index('_ecommerce_orders_user_idx').on(table.userId),
  index('_ecommerce_orders_checkout_session_idx').on(table.checkoutSessionId),
  // Order emails are looked up in lower case.
  index('_ecommerce_orders_customer_email_idx').on(sql`lower(${table.customerEmail})`),
  // Checkout reconciliation reads pending orders by age.
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
  emailVerifiedAt: integer('email_verified_at', { mode: 'timestamp' }),
  name: text('name'),
  creditBalance: integer('credit_balance').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  uniqueIndex('_ecommerce_customer_accounts_cms_user_idx').on(table.cmsUserId).where(sql`${table.cmsUserId} IS NOT NULL`),
]);

export const CUSTOMER_SESSION_PURPOSES = ['session', 'email_challenge'] as const;

export const customerSessions = sqliteTable('_ecommerce_customer_sessions', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => customerAccounts.id, { onDelete: 'cascade' }),
  orderId: text('order_id').unique(),
  tokenHash: text('token_hash').notNull().unique(),
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
export const FULFILLMENT_KINDS = ['shipment', 'correction'] as const;

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
  /** The shipment a correction restates; null for a shipment. */
  correctsId: text('corrects_id').references((): AnySQLiteColumn => fulfillments.id),
  /** Whether a shipment completes its order; false for one parcel of a split shipment. */
  completesOrder: integer('completes_order', { mode: 'boolean' }).notNull().default(true),
}, (table) => [
  index('_ecommerce_fulfillments_order_idx').on(table.orderId, table.createdAt),
  check('fulfillment_kind', oneOf(table.kind, FULFILLMENT_KINDS)),
  check('fulfillment_completes_order_flag', flag(table.completesOrder)),
  check('fulfillment_correction_names_shipment', sql`(${table.kind} = 'shipment') = (${table.correctsId} IS NULL)`),
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
  currency: text('currency').notNull().default('usd'),
  status: text('status', { enum: GIFT_CARD_STATUSES }).notNull().default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  index('_ecommerce_gift_cards_replaces_purchase_idx').on(table.replacesPurchaseId).where(sql`${table.replacesPurchaseId} IS NOT NULL`),
  check('gift_card_source', oneOf(table.source, GIFT_CARD_SOURCES)),
  check('gift_card_initial_range', sql`${table.initialCents} BETWEEN 500 AND 100000`),
  check('gift_card_balance_within_initial', sql`${table.balanceCents} BETWEEN 0 AND ${table.initialCents}`),
  check('gift_card_currency_usd', sql`${table.currency} = 'usd'`),
  check('gift_card_status', oneOf(table.status, GIFT_CARD_STATUSES)),
  check('gift_card_replacement_by_admin', sql`${table.replacesPurchaseId} IS NULL OR ${table.source} = 'admin'`),
  check('gift_card_held_for_review_flag', flag(table.heldForReview)),
  // A purchased card names its purchase; an administrator's card names who issued it and why.
  check('gift_card_source_shape', sql`(${table.source} = 'purchase' AND ${table.purchaseId} IS NOT NULL AND ${table.adminActor} IS NULL)
    OR (${table.source} = 'admin' AND ${table.purchaseId} IS NULL AND ${table.adminActor} IS NOT NULL AND ${table.adminReason} IS NOT NULL)`),
]);

export const GIFT_CARD_LEDGER_KINDS = ['issue', 'reserve', 'release', 'refund_restore', 'purchase_reversal'] as const;

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
  index('_ecommerce_restocks_order_idx').on(table.orderId, table.createdAt),
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
export const RECONCILE_DECISION_ACTIONS = ['retry', 'release'] as const;
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
  index('_ecommerce_reconcile_decisions_purchase_idx').on(table.purchaseId, table.createdAt),
  check('reconcile_decision_action', oneOf(table.action, RECONCILE_DECISION_ACTIONS)),
  check('reconcile_decision_payment_returned', nullOrOneOf(table.paymentReturned, PAYMENT_RETURNED_KINDS)),
  check('reconcile_decision_admin_actor_filled', filled(table.adminActor)),
  check('reconcile_decision_reason_length', trimmed(table.reason, 8)),
  check('reconcile_decision_names_one_subject', sql`(${table.orderId} IS NULL) <> (${table.purchaseId} IS NULL)`),
  check('reconcile_decision_release_returns', sql`${table.paymentReturned} IS NULL OR ${table.action} = 'release'`),
]);

export const EMAIL_KINDS = ['order_confirmation', 'shipment', 'shipment_update', 'gift_card_claim'] as const;
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
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  uniqueIndex('_ecommerce_email_deliveries_kind_subject_unique').on(table.kind, table.subjectId),
  // The sender reads due emails; only pending ones are ever due.
  index('_ecommerce_email_deliveries_due_idx').on(table.nextAttemptAt).where(sql`${table.status} = 'pending'`),
  check('email_delivery_kind', oneOf(table.kind, EMAIL_KINDS)),
  check('email_delivery_status', oneOf(table.status, EMAIL_STATUSES)),
  check('email_delivery_attempts_nonnegative', money(table.attempts, 'nonnegative')),
  check('email_delivery_sent_has_time', sql`(${table.status} = 'sent') = (${table.sentAt} IS NOT NULL)`),
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

// --- Relations, for the relational query builder ---

const tables = {
  carts, orders, payments, providerRefunds, products, variants, productVariants, productVariantValues, stocks, components,
  variantComponents, componentReservations, inventoryReservations, categories, productCategories, tags, productTags,
  customers, customerAccounts, customerSessions, signInTokens, rateLimits, fulfillments, referralCodes, referrals,
  creditLedger, referralSettings, discountCodes, discountRedemptions, giftCardPurchases, giftCards, giftCardLedger,
  giftCardRedemptions, giftCardRefunds, giftCardReviews, giftCardOrderRefunds, taxReversals, disputes, restocks,
  reconcileDecisions, emailDeliveries, giftCardClaims, cmsUsers,
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
  fulfillments: {
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
  discountCodes: { redemptions: r.many.discountRedemptions() },
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
    orders: r.many.orders(),
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
  taxReversals: { order: r.one.orders({ from: r.taxReversals.orderId, to: r.orders.id, optional: false }) },
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
  cmsUsers: { customerAccount: r.one.customerAccounts({ from: r.cmsUsers.id, to: r.customerAccounts.cmsUserId }) },
}));
