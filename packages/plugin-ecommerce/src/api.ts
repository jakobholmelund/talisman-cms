import { TalismanEnv, createDbClient } from 'talisman-cms/client';
import * as schema from './schema';
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import type { PaymentProviderAdapter, PaymentReferences, ValidatedWebhookEvent } from './payments';
import { findReferralCode, getReferralPolicy, referralReversalStatements, releaseReferralAwards } from './referrals';
import { PURCHASED_ORDER_STATUSES, hasPurchaseHistory } from './accounts';
import { canonicalEmail, canonicalEmailSql, canonicalEmails, canonicalPurchaseParams, canonicalPurchaseSql,
  hasCanonicalPurchase } from './email-identity';
import { evaluateDiscountCode } from './promotions';
import { ProviderCheckLimitedError, mayAskPaymentProvider } from './provider-checks';
export { PROVIDER_CHECK_RETRY_MESSAGE, ProviderCheckLimitedError } from './provider-checks';
import { fulfillCommerceOrder } from './fulfillment';
import { evaluateGiftCard, confirmGiftCardPurchase, expireGiftCardPurchase,
  recordGiftCardPurchaseRefund, reconcileGiftCardPurchase } from './gift-cards';
import { readStoreSettings } from './store-settings';
import { minimumChargeAmount } from './money';
import { UNDELIVERABLE_COUNTRY, withCountryCode } from './checkout-input';
import { chooseShippingRate, deliveryEstimate, shippingCharge } from './shipping';
import { calculateOrderTax, recordConfirmedOrderTax, recordMissingTaxTransactions, resendPendingTaxReversals,
  reverseRefundedOrderTax, reverseUnreversedTax, taxAddressFor, taxableLines } from './tax';
export { TaxCalculationError } from './tax';
import { INVENTORY_COLUMNS } from './inventory';
import { fullRefundStatements } from './order-adjustments';
import { applyStripeDispute, parseStripeDispute } from './disputes';
import { WebhookMismatchError, WebhookRetryLaterError, WebhookSignatureError } from './webhook-errors';
export { WebhookMismatchError, WebhookRetryLaterError, WebhookSignatureError } from './webhook-errors';
import { RECONCILE_DUE, RECONCILE_ORDER, ReconcileFailure, assertStoreStripeMode, completedCheckoutReturn,
  decisionInsert, isMissingSessionError, isOtherStripeModeSession, reconcileAttempt, reconcileFailure,
  sessionLookupFailure, uncheckedSessionRefusal, type PaymentReturn, type ReconcileDecision, type ReconcileResult } from './reconcile';
export { ReconcileFailure, type ReconcileFailureCode, type ReconcileResult } from './reconcile';

/** The answer to a shopper who asks about, or tries to release, a checkout parked for review. */
export const PARKED_CHECKOUT_MESSAGE = 'The store is reviewing the payment for this checkout. Contact the store to release it.';
import { deliverCommerceEmail, deliverPendingCommerceEmails } from './commerce-emails';
import { commerceEmailStatement } from './email-deliveries';
export { deliverPendingCommerceEmails } from './commerce-emails';

export interface CommerceApiOptions {
  env: TalismanEnv;
  paymentAdapters?: PaymentProviderAdapter[];
}

type RequiredComponent = { id: string; name: string; quantity: number; available: number };
type InventoryTarget = { type: 'product' | 'variant' | 'stock'; id: string; quantity: number };
export type CartItemInput = { productId: string; variantId?: string; quantity: number };

/** The rows of a JSON list of reservations bound as the statement's last parameter. */
const RESERVATION_ROWS = `SELECT json_extract(value, '$.target') AS target, json_extract(value, '$.amount') AS amount
  FROM json_each(?)`;

/** Most ids bound in one statement: D1 refuses a statement with more than 100 parameters. */
const QUERY_ID_CHUNK = 90;

/** A time in Unix seconds as the schema's timestamp columns take it. */
const at = (seconds: number) => new Date(seconds * 1000);

type CatalogProduct = {
  id: string; name: string; status: string; type: string;
  basePrice: number; inventoryQuantity: number; isPhysical: boolean;
};
type CatalogGroup = {
  id: string; productId: string; name: string; definitionName: string | null;
  priceOverride: number | null; inventoryQuantity: number;
};
type CatalogValue = {
  id: string; groupId: string; value: string; priceOverride: number | null;
  stock: { id: string; quantity: number } | null;
};
type CatalogRequirement = { componentId: string; quantity: number; component: { id: string; name: string; quantity: number } | null };

/** The catalog rows a basket's lines refer to, keyed by id (see loadBasketCatalog). */
type BasketCatalog = {
  products: Map<string, CatalogProduct>;
  /** Every variant group of the basket's products. */
  groups: Map<string, CatalogGroup>;
  productsWithGroups: Set<string>;
  /** The groups, among the lines' variant ids, that have values. */
  groupsWithValues: Set<string>;
  values: Map<string, CatalogValue>;
  /** Each value's bill of materials, in component id order. */
  requirements: Map<string, CatalogRequirement[]>;
};

function chunked<T>(values: T[], size = QUERY_ID_CHUNK) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

/** Most distinct lines one basket can hold. */
export const CART_MAX_LINES = 50;
/** Most units of one line. Checkout still checks stock. */
export const CART_MAX_LINE_QUANTITY = 99;
const CART_ID_MAX_LENGTH = 128;

const cartItemKey = (item: { productId: string; variantId?: string | null }) => `${item.productId}\0${item.variantId || ''}`;

/** Reject a malformed or oversized item list before the catalog is read. */
function assertCartItems(items: unknown): asserts items is CartItemInput[] {
  if (!Array.isArray(items)) throw new Error('Cart items must be an array');
  if (items.length > CART_MAX_LINES) throw new Error(`Cart items must not exceed ${CART_MAX_LINES} lines`);
  if (items.some((item) =>
    !item || typeof item.productId !== 'string' || !item.productId.trim() || item.productId.length > CART_ID_MAX_LENGTH ||
    !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > CART_MAX_LINE_QUANTITY ||
    (item.variantId !== undefined && (typeof item.variantId !== 'string' || item.variantId.length > CART_ID_MAX_LENGTH))
  )) {
    throw new Error(`Cart items must have a product and a whole-number quantity from 1 to ${CART_MAX_LINE_QUANTITY}`);
  }
  const itemKeys = items.map(cartItemKey);
  if (new Set(itemKeys).size !== itemKeys.length) {
    throw new Error('Duplicate cart items are not allowed');
  }
}

export function aggregateComponentDemand(items: Array<{ quantity: number; components: RequiredComponent[] }>) {
  const demand = new Map<string, { name: string; quantity: number; available: number }>();
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

export function bindCommerceApi(options: CommerceApiOptions) {
  const { env, paymentAdapters = [] } = options;
  const db = createDbClient(env);

  // Best effort: the provider's discount is single-use and expires with its checkout, so a
  // failed delete is logged and never blocks releasing the order.
  async function discardCheckoutDiscount(adapter: PaymentProviderAdapter | undefined, orderId: string) {
    if (!adapter?.discardCheckoutDiscount) return;
    try {
      await adapter.discardCheckoutDiscount(orderId);
    } catch (error) {
      console.warn('[commerce] Checkout discount could not be discarded', {
        provider: adapter.providerId,
        name: error instanceof Error ? error.name : typeof error,
        code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined,
      });
    }
  }

  /**
   * Load every catalog row a basket's lines refer to in one D1 batch: a fixed number of statements
   * whatever the number of lines, so quoting and checkout do not slow down or run into D1's query
   * limits as the basket grows. The lines are then checked in memory against this snapshot.
   */
  async function loadBasketCatalog(items: Array<{ productId: string; variantId?: string | null }>): Promise<BasketCatalog> {
    const productIds = [...new Set(items.map((item) => String(item.productId)))];
    const variantIds = [...new Set(items.flatMap((item) => item.variantId ? [String(item.variantId)] : []))];
    const slots = (ids: string[]) => ids.map(() => '?').join(', ');
    const queries: Array<{ kind: 'products' | 'groups' | 'values' | 'requirements' | 'groupsWithValues'; statement: D1PreparedStatement }> = [];
    for (const ids of chunked(productIds)) {
      queries.push({ kind: 'products', statement: env.DB.prepare(`SELECT id, name, status, type, base_price,
        inventory_quantity, is_physical FROM _ecommerce_products WHERE id IN (${slots(ids)})`).bind(...ids) });
      queries.push({ kind: 'groups', statement: env.DB.prepare(`SELECT g.id, g.product_id, g.name, g.price_override,
        g.inventory_quantity, d.name AS definition_name
        FROM _ecommerce_product_variants g LEFT JOIN _ecommerce_variants d ON d.id = g.variant_id
        WHERE g.product_id IN (${slots(ids)})`).bind(...ids) });
    }
    for (const ids of chunked(variantIds)) {
      queries.push({ kind: 'values', statement: env.DB.prepare(`SELECT v.id, v.product_variant_id, v.value,
        v.price_override, s.id AS stock_id, s.quantity AS stock_quantity
        FROM _ecommerce_product_variant_values v LEFT JOIN _ecommerce_stocks s ON s.product_variant_value_id = v.id
        WHERE v.id IN (${slots(ids)})`).bind(...ids) });
      queries.push({ kind: 'requirements', statement: env.DB.prepare(`SELECT r.product_variant_value_id, r.component_id,
        r.quantity, c.id AS found_component_id, c.name AS component_name, c.quantity AS component_quantity
        FROM _ecommerce_variant_components r LEFT JOIN _ecommerce_components c ON c.id = r.component_id
        WHERE r.product_variant_value_id IN (${slots(ids)})
        ORDER BY r.product_variant_value_id, r.component_id`).bind(...ids) });
      // A line's variant id may name a legacy group instead of a value; such a group must have no values.
      queries.push({ kind: 'groupsWithValues', statement: env.DB.prepare(`SELECT DISTINCT product_variant_id
        FROM _ecommerce_product_variant_values WHERE product_variant_id IN (${slots(ids)})`).bind(...ids) });
    }
    const catalog: BasketCatalog = { products: new Map(), groups: new Map(), productsWithGroups: new Set(),
      groupsWithValues: new Set(), values: new Map(), requirements: new Map() };
    if (!queries.length) return catalog;
    const results = await env.DB.batch<Record<string, any>>(queries.map((query) => query.statement));
    queries.forEach(({ kind }, index) => {
      for (const row of results[index]?.results ?? []) {
        if (kind === 'products') {
          catalog.products.set(row.id, { id: row.id, name: row.name, status: row.status, type: row.type,
            basePrice: row.base_price, inventoryQuantity: row.inventory_quantity, isPhysical: Number(row.is_physical) === 1 });
        } else if (kind === 'groups') {
          catalog.groups.set(row.id, { id: row.id, productId: row.product_id, name: row.name,
            definitionName: row.definition_name ?? null, priceOverride: row.price_override ?? null,
            inventoryQuantity: row.inventory_quantity });
          catalog.productsWithGroups.add(row.product_id);
        } else if (kind === 'values') {
          catalog.values.set(row.id, { id: row.id, groupId: row.product_variant_id, value: row.value,
            priceOverride: row.price_override ?? null,
            stock: row.stock_id === null || row.stock_id === undefined ? null : { id: row.stock_id, quantity: row.stock_quantity } });
        } else if (kind === 'requirements') {
          const list = catalog.requirements.get(row.product_variant_value_id) ?? [];
          list.push({ componentId: row.component_id, quantity: row.quantity,
            component: row.found_component_id === null || row.found_component_id === undefined ? null
              : { id: row.found_component_id, name: row.component_name, quantity: row.component_quantity } });
          catalog.requirements.set(row.product_variant_value_id, list);
        } else {
          catalog.groupsWithValues.add(row.product_variant_id);
        }
      }
    });
    return catalog;
  }

  function resolveSelectedVariant(catalog: BasketCatalog, product: CatalogProduct, variantId: string) {
    const variantValue = catalog.values.get(String(variantId));
    if (variantValue) {
      const productVariant = catalog.groups.get(variantValue.groupId);
      if (!productVariant || productVariant.productId !== product.id) {
        throw new Error(`Variant value not found or mismatch: ${variantId}`);
      }

      const stock = variantValue.stock;
      const components: RequiredComponent[] = [];
      for (const requirement of catalog.requirements.get(variantValue.id) ?? []) {
        const component = requirement.component;
        if (!component) throw new Error(`Component not found: ${requirement.componentId}`);
        components.push({
          id: component.id,
          name: component.name,
          quantity: requirement.quantity,
          available: component.quantity
        });
      }

      return {
        price: variantValue.priceOverride ?? productVariant.priceOverride ?? product.basePrice,
        name: `${product.name} - ${productVariant.definitionName ?? productVariant.name}: ${variantValue.value}`,
        availableQuantity: components.length
          ? Math.min(...components.map((component) => Math.floor(component.available / component.quantity)))
          : stock?.quantity ?? productVariant.inventoryQuantity,
        inventoryTarget: components.length ? null : stock
          ? { type: 'stock' as const, id: stock.id }
          : { type: 'variant' as const, id: productVariant.id },
        components,
      };
    }

    // Groups are loaded by product, so a group of another product is not found either.
    const legacyVariant = catalog.groups.get(String(variantId));
    if (!legacyVariant || legacyVariant.productId !== product.id) {
      throw new Error(`Variant not found or mismatch: ${variantId}`);
    }
    // Only a group without values is a legacy variant. A group with values is the choice itself, so
    // its own price and stock never sell a unit that skips the values' components.
    if (catalog.groupsWithValues.has(legacyVariant.id)) throw new Error(`Select an option for ${product.name}`);

    return {
      price: legacyVariant.priceOverride ?? product.basePrice,
      name: `${product.name} - ${legacyVariant.name}`,
      availableQuantity: legacyVariant.inventoryQuantity,
      inventoryTarget: { type: 'variant' as const, id: legacyVariant.id },
      components: [] as RequiredComponent[],
    };
  }

  /** A product with variant groups is sold only as one of its variants, never at its base price and stock. */
  function requireVariantChoice(catalog: BasketCatalog, product: { id: string; name: string }, variantId?: string | null) {
    if (variantId) return;
    if (catalog.productsWithGroups.has(product.id)) throw new Error(`Select an option for ${product.name}`);
  }

  /**
   * Check the lines a request adds against the catalog; lines already in the basket were checked when
   * they were added. Draft products are accepted so a concept basket works; archived ones are not.
   * A product with variant groups needs a variant, and a group with values is not one. Stores only the
   * known fields.
   */
  async function checkCartItems(items: unknown, current: Array<{ productId: string; variantId?: string | null }> = []) {
    assertCartItems(items);
    const currentKeys = new Set(current.map(cartItemKey));
    const added = items.filter((item) => !currentKeys.has(cartItemKey(item)));
    const productIds = [...new Set(added.map((item) => item.productId))];
    const available = new Set(productIds.length ? (await db.select({ id: schema.products.id, status: schema.products.status })
      .from(schema.products).where(inArray(schema.products.id, productIds)))
      .filter((product) => product.status !== 'archived').map((product) => product.id) : []);
    const unknownProduct = added.find((item) => !available.has(item.productId));
    if (unknownProduct) throw new Error(`Cart items must be catalog products; ${unknownProduct.productId} is not available`);

    const variantIds = [...new Set(added.flatMap((item) => item.variantId ? [item.variantId] : []))];
    if (variantIds.length) {
      // Like checkout: a purchasable value of one of the product's variant groups, or a legacy variant
      // group, which has no values. Naming a group that has values leaves the choice unmade.
      const groups = await db.select({ id: schema.productVariants.id, productId: schema.productVariants.productId })
        .from(schema.productVariants).where(inArray(schema.productVariants.id, variantIds));
      const groupsWithValues = new Set(groups.length ? (await db.selectDistinct({ id: schema.productVariantValues.productVariantId })
        .from(schema.productVariantValues)
        .where(inArray(schema.productVariantValues.productVariantId, groups.map((group) => group.id))))
        .map((value) => value.id) : []);
      const owners = new Map(groups.filter((group) => !groupsWithValues.has(group.id))
        .map((group) => [group.id, group.productId]));
      const choices = new Map(groups.filter((group) => groupsWithValues.has(group.id))
        .map((group) => [group.id, group.productId]));
      for (const value of await db.select({ id: schema.productVariantValues.id, productId: schema.productVariants.productId })
        .from(schema.productVariantValues)
        .innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.productVariantValues.productVariantId))
        .where(inArray(schema.productVariantValues.id, variantIds))) {
        owners.set(value.id, value.productId);
      }
      const unchosenGroup = added.find((item) => item.variantId && choices.get(item.variantId) === item.productId);
      if (unchosenGroup) throw new Error(`Cart items must choose one of the variants of ${unchosenGroup.productId}`);
      const unknownVariant = added.find((item) => item.variantId && owners.get(item.variantId) !== item.productId);
      if (unknownVariant) throw new Error(`Cart items must use a variant of their product; ${unknownVariant.variantId} is not available`);
    }
    const withoutVariant = [...new Set(added.flatMap((item) => item.variantId ? [] : [item.productId]))];
    if (withoutVariant.length) {
      const withGroups = new Set((await db.selectDistinct({ productId: schema.productVariants.productId })
        .from(schema.productVariants).where(inArray(schema.productVariants.productId, withoutVariant)))
        .map((variant) => variant.productId));
      const unchosen = added.find((item) => !item.variantId && withGroups.has(item.productId));
      if (unchosen) throw new Error(`Cart items must choose one of the variants of ${unchosen.productId}`);
    }
    return items.map(({ productId, variantId, quantity }) => variantId ? { productId, variantId, quantity } : { productId, quantity });
  }

  async function finalizeOrderPayment(params: {
    orderId: string;
    provider: string;
    providerId: string;
    paymentIntentId?: string;
    paymentStatus?: string;
    amount?: number;
    currency?: string;
    customerEmail?: string;
  }) {
    const order = await db.select().from(schema.orders).where(eq(schema.orders.id, params.orderId)).get();
    if (!order) {
      throw new Error(`Order not found: ${params.orderId}`);
    }
    if (params.paymentStatus !== 'success') {
      throw new Error('Payment has not succeeded');
    }
    if (order.checkoutSessionId !== params.providerId ||
      (order.paymentProvider ?? 'stripe') !== params.provider) {
      throw new WebhookMismatchError('session_mismatch', 'Payment provider or session does not match order');
    }
    if (params.amount !== undefined && params.amount !== order.totalAmount) {
      throw new WebhookMismatchError('amount_mismatch', 'Payment amount does not match order total');
    }
    if (params.currency && params.currency.toLowerCase() !== order.currency.toLowerCase()) {
      throw new WebhookMismatchError('currency_mismatch', 'Payment currency does not match order');
    }
    if ((PURCHASED_ORDER_STATUSES as readonly string[]).includes(order.status)) {
      return { success: true, orderId: params.orderId, status: order.status, duplicate: true };
    }
    if (order.status === 'cancelled') {
      // Paid after its checkout was released. No retry changes that; an administrator refunds it in Stripe.
      throw new WebhookMismatchError('order_cancelled', 'Cancelled order cannot be paid');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const providerEmail = params.customerEmail?.trim() ?? '';
    const email = emailPattern.test(providerEmail) ? providerEmail : (order.customerEmail || '').trim();
    const normalizedEmail = email.toLowerCase();
    const newAccountId = !order.userId && params.provider !== 'admin_test' &&
      emailPattern.test(normalizedEmail) ? `acct_${order.id}` : null;
    const accountName = typeof order.shippingAddress?.name === 'string'
      ? order.shippingAddress.name.trim().slice(0, 160) : null;
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(`UPDATE _ecommerce_orders SET status = 'paid', updated_at = ?, customer_email = ?, payment_intent_id = ?
        WHERE id = ? AND status = 'pending' AND checkout_session_id = ? AND total_amount = ?`)
        .bind(timestamp, email, params.paymentIntentId ?? null, params.orderId, params.providerId, order.totalAmount),
    ];
    if (newAccountId) {
      statements.push(env.DB.prepare(`INSERT INTO _ecommerce_customer_accounts
        (id, email, email_normalized, name, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ? FROM _ecommerce_orders
        WHERE id = ? AND status = 'paid' AND checkout_session_id = ?
        ON CONFLICT(email_normalized) DO NOTHING`)
        .bind(newAccountId, email, normalizedEmail, accountName, timestamp, timestamp, params.orderId, params.providerId));
      statements.push(env.DB.prepare(`UPDATE _ecommerce_orders
        SET user_id = (SELECT id FROM _ecommerce_customer_accounts WHERE email_normalized = ?)
        WHERE id = ? AND status = 'paid' AND user_id IS NULL`)
        .bind(normalizedEmail, params.orderId));
    }
    if (order.referralCode && order.referralRewardCents > 0 && params.provider !== 'admin_test') {
      // The referral is recorded for the buyer's first purchase only: the order's account (new, signed up
      // earlier or signed in) has no other paid order under that account or any of its addresses, is not
      // the referrer, and none of its addresses matches the referrer's, exactly or in canonical form.
      // Each referrer has at most maxPerPeriod referrals within periodDays, counted across the accounts
      // whose addresses share the referrer's canonical form. The awards stay pending
      // until releaseReferralAwards releases them after the hold.
      const policy = await getReferralPolicy(env);
      const referrer = await db.select({ emailNormalized: schema.customerAccounts.emailNormalized })
        .from(schema.referralCodes)
        .innerJoin(schema.customerAccounts, eq(schema.customerAccounts.id, schema.referralCodes.accountId))
        .where(eq(schema.referralCodes.code, order.referralCode)).get();
      const buyerAccount = order.userId ? await db.select({ emailNormalized: schema.customerAccounts.emailNormalized })
        .from(schema.customerAccounts).where(eq(schema.customerAccounts.id, order.userId)).get() : undefined;
      const checkoutEmail = (order.customerEmail || '').trim().toLowerCase();
      const buyerCanonicals = canonicalEmails([checkoutEmail, normalizedEmail, buyerAccount?.emailNormalized]);
      const referrerCanonical = canonicalEmail(referrer?.emailNormalized);
      if (referrerCanonical && buyerCanonicals.length && !buyerCanonicals.includes(referrerCanonical)) {
        const purchased = PURCHASED_ORDER_STATUSES.map((status) => `'${status}'`).join(', ');
        statements.push(env.DB.prepare(`INSERT INTO _ecommerce_referrals
          (id, code, referrer_account_id, referred_account_id, order_id, reward_cents, currency, status, created_at, updated_at)
          SELECT ?, rc.code, rc.account_id, o.user_id, o.id, ?, o.currency, 'approved', ?, ?
          FROM _ecommerce_orders o
          JOIN _ecommerce_referral_codes rc ON rc.code = o.referral_code
          JOIN _ecommerce_customer_accounts referrer ON referrer.id = rc.account_id
          JOIN _ecommerce_customer_accounts buyer ON buyer.id = o.user_id
          WHERE o.id = ? AND o.status = 'paid' AND rc.account_id <> o.user_id
            AND referrer.email_normalized NOT IN (?, ?, buyer.email_normalized)
            AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders prior
              WHERE prior.id <> o.id AND prior.status IN (${purchased})
                AND COALESCE(prior.payment_provider, 'stripe') <> 'admin_test'
                AND (prior.user_id = o.user_id OR lower(prior.customer_email) IN (?, ?, buyer.email_normalized)
                  OR prior.user_id IN (SELECT id FROM _ecommerce_customer_accounts WHERE email_normalized IN (?, ?))))
            AND NOT ${canonicalPurchaseSql(buyerCanonicals.length)}
            AND (SELECT COUNT(*) FROM _ecommerce_referrals recent
              JOIN _ecommerce_customer_accounts recent_referrer ON recent_referrer.id = recent.referrer_account_id
              WHERE recent.status = 'approved' AND recent.created_at > ?
                AND (recent.referrer_account_id = rc.account_id
                  OR ${canonicalEmailSql('recent_referrer.email_normalized')} = ?)) < ?
          ON CONFLICT DO NOTHING`)
          .bind(`ref_${order.id}`, order.referralRewardCents, timestamp, timestamp, params.orderId,
            normalizedEmail, checkoutEmail, normalizedEmail, checkoutEmail, normalizedEmail, checkoutEmail,
            ...canonicalPurchaseParams(buyerCanonicals, params.orderId),
            timestamp - policy.periodDays * 24 * 60 * 60, referrerCanonical, policy.maxPerPeriod));
      }
    }
    statements.push(
      env.DB.prepare(`UPDATE _ecommerce_discount_redemptions SET status = 'confirmed', updated_at = ?
        WHERE order_id = ? AND status = 'reserved'
          AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'paid')`)
        .bind(timestamp, params.orderId, params.orderId),
      env.DB.prepare(`UPDATE _ecommerce_gift_card_redemptions SET status = 'confirmed', updated_at = ?
        WHERE order_id = ? AND status = 'reserved'
          AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'paid')`)
        .bind(timestamp, params.orderId, params.orderId),
      env.DB.prepare(`UPDATE _ecommerce_carts SET closed = 1, closed_at = ?, updated_at = ?,
        user_id = COALESCE(user_id, (SELECT user_id FROM _ecommerce_orders WHERE id = ?))
        WHERE id = ? AND EXISTS (SELECT 1 FROM _ecommerce_orders
          WHERE id = ? AND status = 'paid' AND checkout_session_id = ?)`)
        .bind(timestamp, timestamp, params.orderId, order.cartId, params.orderId, params.providerId),
      env.DB.prepare(`INSERT INTO _ecommerce_payments
        (id, order_id, provider, provider_id, status, amount, created_at)
        SELECT ?, id, ?, ?, 'success', total_amount, ? FROM _ecommerce_orders
        WHERE id = ? AND status = 'paid' AND checkout_session_id = ?
        ON CONFLICT(provider, provider_id) DO NOTHING`)
        .bind(`pay_${crypto.randomUUID()}`, params.provider, params.providerId, timestamp, params.orderId, params.providerId)
    );
    // One confirmation per paid real order, whichever path confirms the payment and however often.
    const confirms = params.provider !== 'admin_test';
    if (confirms) {
      statements.push(commerceEmailStatement(env, 'order_confirmation', params.orderId, timestamp, {
        sql: `EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'paid' AND checkout_session_id = ?
          AND COALESCE(payment_provider, 'stripe') <> 'admin_test')`,
        params: [params.orderId, params.providerId] }));
    }
    await env.DB.batch(statements);
    const current = await db.select().from(schema.orders).where(eq(schema.orders.id, params.orderId)).get();
    if (current?.status !== 'paid') throw new Error('Order is no longer pending');
    // The tax is recorded only once the payment is in. A failure never undoes the confirmation: it
    // is logged, and reconcileCommerce records the transaction later.
    if (current.taxCalculationId && !current.taxTransactionId) {
      await recordConfirmedOrderTax(env, paymentAdapters, params.orderId);
    }
    // A failed send never fails the payment; the scheduled job retries it.
    if (confirms) await deliverCommerceEmail(env, 'order_confirmation', params.orderId);

    return { success: true, orderId: params.orderId, status: 'paid' };
  }

  /**
   * Records the refund total of the order paid with `paymentIntentId`, or returns null when no order
   * was. Each rise in the total adds a _ecommerce_provider_refunds row dated `refundedAt`, when the
   * provider issued the refund. A disputed order records the refund and stays disputed.
   */
  async function recordProviderRefund(params: {
    paymentIntentId: string; amount: number; amountRefunded: number; currency: string;
    /** When the provider issued the refund, in unix seconds; the time it is recorded when unknown. */
    refundedAt?: number;
    /** The provider's id for the refund, when the event names it. */
    providerRefundId?: string | null;
  }) {
    const order = await db.select().from(schema.orders)
      .where(eq(schema.orders.paymentIntentId, params.paymentIntentId)).get();
    if (!order) return null;
    if (order.paymentProvider !== 'stripe' || order.totalAmount !== params.amount ||
      order.currency.toLowerCase() !== String(params.currency).toLowerCase() ||
      !Number.isSafeInteger(params.amountRefunded) || params.amountRefunded < 0 ||
      params.amountRefunded > order.totalAmount) {
      throw new WebhookMismatchError('refund_mismatch', 'Refund does not match order payment');
    }
    if (params.amountRefunded <= order.providerRefundedCents) {
      return { success: true, orderId: order.id, duplicate: true };
    }
    const now = Math.floor(Date.now() / 1000);
    const full = params.amountRefunded === order.totalAmount;
    const referralPolicy = order.referralCode ? await getReferralPolicy(env) : null;
    const refundable = `id = ? AND payment_intent_id = ? AND provider_refunded_cents < ?
      AND status IN ('paid', 'fulfilled', 'partially_refunded', 'disputed')`;
    const statements: D1PreparedStatement[] = [
      // First the part of the total that this event adds, read from the stored total under the guard
      // of the update below: a retried or out-of-order event adds no row, and the rows add up to the total.
      env.DB.prepare(`INSERT INTO _ecommerce_provider_refunds
        (id, order_id, provider, provider_refund_id, amount_cents, created_at)
        SELECT ?, id, 'stripe', ?, ? - provider_refunded_cents, ?
        FROM _ecommerce_orders WHERE ${refundable}
        ON CONFLICT(id) DO NOTHING`)
        .bind(`prf_${order.id}_${params.amountRefunded}`, params.providerRefundId ?? null, params.amountRefunded,
          params.refundedAt ?? now, order.id, params.paymentIntentId, params.amountRefunded),
      // A dispute keeps the order disputed; closing it applies the refund status.
      env.DB.prepare(`UPDATE _ecommerce_orders
        SET provider_refunded_cents = ?, status = CASE WHEN status = 'disputed' THEN status ELSE ? END, updated_at = ?
        WHERE ${refundable}`)
        .bind(params.amountRefunded, full ? 'refunded' : 'partially_refunded', now,
          order.id, params.paymentIntentId, params.amountRefunded),
      // The payment shows the refund, taken from the amounts while the order is disputed.
      env.DB.prepare(`UPDATE _ecommerce_payments
        SET status = COALESCE((SELECT CASE WHEN o.status IN ('partially_refunded', 'refunded') THEN o.status
            WHEN o.provider_refunded_cents >= o.total_amount THEN 'refunded'
            WHEN o.provider_refunded_cents > 0 THEN 'partially_refunded' END
          FROM _ecommerce_orders o WHERE o.id = ?), status)
        WHERE order_id = ? AND provider = 'stripe'`)
        .bind(order.id, order.id),
    ];
    if (full) statements.push(...fullRefundStatements(env, order.id, now));
    // A full refund, or a partial one that leaves less than the minimum paid, voids the referral and
    // reverses released awards.
    if (referralPolicy) {
      statements.push(...referralReversalStatements(env, order.id,
        { minOrderCents: referralPolicy.minOrderCents, now }));
    }
    await env.DB.batch(statements);
    return { success: true, orderId: order.id,
      status: order.status === 'disputed' ? 'disputed' : full ? 'refunded' : 'partially_refunded' };
  }
  
  function ignoredEvent(event: ValidatedWebhookEvent) {
    console.info('[commerce] Stripe event ignored', { type: event.type, id: event.id });
    return { success: true, event: event.type, ignored: true };
  }

  /**
   * For an event whose payment matches no recorded payment: it is retried while the order or gift card
   * purchase its references name still waits for its payment, and ignored when they name nothing of
   * this store's or a released checkout. A record that was paid through another payment is a mismatch.
   */
  async function assertNoAwaitedPayment(references: PaymentReferences | null | undefined) {
    const purchaseId = references?.giftCardPurchaseId || null;
    const orderId = purchaseId ? null : references?.orderId || null;
    const record = purchaseId
      ? await db.select({ status: schema.giftCardPurchases.status }).from(schema.giftCardPurchases)
        .where(eq(schema.giftCardPurchases.id, purchaseId)).get()
      : orderId ? await db.select({ status: schema.orders.status }).from(schema.orders)
        .where(eq(schema.orders.id, orderId)).get() : undefined;
    if (!record || record.status === 'cancelled' || record.status === 'draft') return;
    if (record.status === 'pending') {
      throw new WebhookRetryLaterError(`The ${purchaseId ? 'gift card purchase' : 'order'} this payment is for has no recorded payment yet`);
    }
    throw new WebhookMismatchError('payment_not_recorded', 'The payment is not the one recorded for the store record it names');
  }

  async function applyStripeEvent(event: ValidatedWebhookEvent, stripeAdapter: PaymentProviderAdapter) {
    const text = (value: unknown) => typeof value === 'string' && value ? value : null;
    const at = Number.isSafeInteger(event.created) && event.created! > 0 ? event.created! : Math.floor(Date.now() / 1000);

    if (event.type === 'checkout.session.completed') {
      const session = event.data as any; // Stripe.Checkout.Session
      if (session.payment_status !== 'paid') return ignoredEvent(event);
      const purchaseId = text(session.metadata?.giftCardPurchaseId);
      if (purchaseId) {
        const purchase = await db.select({ id: schema.giftCardPurchases.id }).from(schema.giftCardPurchases)
          .where(eq(schema.giftCardPurchases.id, purchaseId)).get();
        return purchase ? confirmGiftCardPurchase(env, session) : ignoredEvent(event);
      }
      const orderId = text(session.metadata?.orderId) ?? text(session.client_reference_id);
      const order = orderId ? await db.select({ id: schema.orders.id }).from(schema.orders)
        .where(eq(schema.orders.id, orderId)).get() : undefined;
      if (!order) return ignoredEvent(event);
      return finalizeOrderPayment({
        orderId: order.id,
        provider: 'stripe',
        providerId: session.id,
        paymentStatus: 'success',
        amount: session.amount_total || 0,
        currency: session.currency,
        paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : undefined,
        customerEmail: session.customer_details?.email || session.customer_email
      });
    }

    if (event.type === 'checkout.session.expired') {
      const session = event.data as any;
      const purchaseId = text(session.metadata?.giftCardPurchaseId);
      if (purchaseId) {
        const purchase = await db.select({ id: schema.giftCardPurchases.id }).from(schema.giftCardPurchases)
          .where(eq(schema.giftCardPurchases.id, purchaseId)).get();
        if (!purchase) return ignoredEvent(event);
        await expireGiftCardPurchase(env, purchaseId, session.id);
        return { success: true, event: event.type };
      }
      const orderId = text(session.metadata?.orderId) ?? text(session.client_reference_id);
      if (orderId) {
        const order = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
        if (order?.checkoutSessionId === session.id) {
          const cancelled = await bindCommerceApi(options).orders.cancel(orderId, { sessionExpired: true });
          return { success: true, event: event.type, cancelled: cancelled?.status === 'cancelled' };
        }
        if (!order && orderId === text(session.metadata?.orderId) && orderId.startsWith('ord_')) {
          // The checkout stopped before its order was recorded; its coupon, if any, is deleted.
          await discardCheckoutDiscount(stripeAdapter, orderId);
          return { success: true, event: event.type, cancelled: false };
        }
      }
      return ignoredEvent(event);
    }

    if (event.type === 'charge.refunded') {
      const charge = event.data as any; // Stripe.Charge
      if (typeof charge.payment_intent !== 'string') return ignoredEvent(event);
      const refund = { paymentIntentId: charge.payment_intent, amount: charge.amount,
        amountRefunded: charge.amount_refunded, currency: charge.currency };
      const giftPurchaseRefund = await recordGiftCardPurchaseRefund(env, refund);
      if (giftPurchaseRefund) return giftPurchaseRefund;
      // Stripe API versions before 2022-11-15 list the charge's refunds in the event; later ones do not.
      const listed = Array.isArray(charge.refunds?.data) ? charge.refunds.data as Array<{ id?: unknown; created?: unknown }> : [];
      const latest = listed.filter((item) => typeof item?.id === 'string')
        .sort((a, b) => Number(b.created ?? 0) - Number(a.created ?? 0))[0];
      const recorded = await recordProviderRefund({ ...refund, refundedAt: at,
        providerRefundId: typeof latest?.id === 'string' ? latest.id : null });
      if (recorded) {
        // The refund is mirrored in the order's tax. A failure is logged, and reconcileCommerce
        // reverses the tax later; the refund itself stays recorded.
        await reverseRefundedOrderTax(env, paymentAdapters, recorded.orderId);
        return recorded;
      }
      await assertNoAwaitedPayment({ orderId: text(charge.metadata?.orderId),
        giftCardPurchaseId: text(charge.metadata?.giftCardPurchaseId) });
      return ignoredEvent(event);
    }

    if (event.type === 'charge.dispute.created' || event.type === 'charge.dispute.closed') {
      const dispute = parseStripeDispute(event.data, at);
      if (!dispute) return ignoredEvent(event);
      const applied = await applyStripeDispute(env, dispute, { closed: event.type === 'charge.dispute.closed', at });
      // A lost dispute leaves its order 'refunded' without a provider refund, so its tax is reversed
      // here as after recordProviderRefund above; a failure is logged and reconcileCommerce retries it.
      if (applied && 'orderId' in applied && applied.status === 'refunded') {
        await reverseRefundedOrderTax(env, paymentAdapters, applied.orderId);
      }
      if (applied) return { success: true, event: event.type, ...applied };
      // A dispute names only the payment; its references tell a payment not recorded yet from a foreign one.
      await assertNoAwaitedPayment(await stripeAdapter.getPaymentReferences?.(dispute.paymentIntentId));
      return ignoredEvent(event);
    }

    return ignoredEvent(event);
  }

  return {
    carts: {
      async quote(cartId: string) {
        const { currency } = readStoreSettings(env);
        const cart = await db.select().from(schema.carts).where(eq(schema.carts.id, cartId)).get();
        if (!cart) throw new Error('Cart not found');
        const catalog = await loadBasketCatalog(cart.items);
        const lines = [];
        let totalAmount = 0;
        let requiresShipping = false;
        const componentItems: Array<{ quantity: number; components: RequiredComponent[] }> = [];
        for (const item of cart.items) {
          const product = catalog.products.get(String(item.productId));
          if (!product || product.status !== 'active') throw new Error(`Product is not available: ${item.productId}`);
          requireVariantChoice(catalog, product, item.variantId);
          const variant = item.variantId ? resolveSelectedVariant(catalog, product, item.variantId) : null;
          const unitAmount = variant?.price ?? product.basePrice;
          const name = variant?.name ?? product.name;
          if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0) {
            throw new Error(`A positive price is required for ${name}`);
          }
          if (product.type === 'standard' && (variant?.availableQuantity ?? product.inventoryQuantity) < item.quantity) {
            throw new Error(`Insufficient stock for ${name}`);
          }
          if (product.type === 'standard' && variant?.components.length) {
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
        if (!Number.isSafeInteger(totalAmount)) throw new Error('Order total is too large');
        return { lines, totalAmount, currency, requiresShipping, locked: Boolean(cart.checkoutSessionId) };
      },

      async find(sessionToken: string | undefined, userId?: string) {
        if (!sessionToken && !userId) return null;

        const conditions = [eq(schema.carts.closed, false)];

        if (userId) {
          conditions.push(eq(schema.carts.userId, userId));
        } else if (sessionToken) {
          conditions.push(eq(schema.carts.sessionToken, sessionToken));
          conditions.push(isNull(schema.carts.userId));
        }

        return await db.select().from(schema.carts).where(and(...conditions)).get();
      },

      /** Attach the current browser basket to an authenticated shopper account. */
      async claim(sessionToken: string, userId: string, choice?: 'browser' | 'account') {
        const account = await db.select({ id: schema.customerAccounts.id }).from(schema.customerAccounts)
          .where(eq(schema.customerAccounts.id, userId)).get();
        if (!account) throw new Error('Customer account not found');

        const guest = await db.select().from(schema.carts)
          .where(and(eq(schema.carts.sessionToken, sessionToken), eq(schema.carts.closed, false))).get();
        const owned = await db.select().from(schema.carts)
          .where(and(eq(schema.carts.userId, userId), eq(schema.carts.closed, false))).get();
        if (guest?.userId === userId) return guest;
        if (guest?.userId) throw new Error('Basket belongs to another account');
        if (guest?.checkoutSessionId) throw new Error('Checkout already started for this cart');

        if (guest && owned && guest.id !== owned.id) {
          if (guest.items.length && owned.items.length) {
            if (!choice) throw new Error('Both baskets have items; choose which basket to keep before linking this session');
          }
          if (owned.checkoutSessionId) throw new Error('Checkout already started for this cart');
          if (guest.items.length && choice !== 'account') {
            const released = await db.update(schema.carts).set({ userId: null, updatedAt: new Date() })
              .where(and(eq(schema.carts.id, owned.id), eq(schema.carts.userId, userId),
                eq(schema.carts.version, owned.version), eq(schema.carts.closed, false)))
              .returning({ id: schema.carts.id });
            if (!released.length) throw new Error('Basket changed during account upgrade; reload and try again');
          } else {
            const released = await db.update(schema.carts).set({ sessionToken: null, updatedAt: new Date() })
              .where(and(eq(schema.carts.id, guest.id), eq(schema.carts.sessionToken, sessionToken),
                eq(schema.carts.version, guest.version), eq(schema.carts.closed, false)))
              .returning({ id: schema.carts.id });
            if (!released.length) throw new Error('Basket changed during account upgrade; reload and try again');
          }
        }

        const target = choice === 'account' && owned ? owned : guest?.items.length ? guest : owned ?? guest;
        if (target) {
          if (!guest) {
            await db.update(schema.carts).set({ sessionToken: null })
              .where(and(eq(schema.carts.sessionToken, sessionToken), eq(schema.carts.closed, true)));
          }
          const updated = await db.update(schema.carts)
            .set({ userId, sessionToken, updatedAt: new Date(), version: sql`${schema.carts.version} + 1` })
            .where(and(eq(schema.carts.id, target.id), eq(schema.carts.closed, false),
              isNull(schema.carts.checkoutSessionId), eq(schema.carts.version, target.version)))
            .returning({ id: schema.carts.id });
          if (!updated.length) throw new Error('Basket changed during account upgrade; reload and try again');
          return await db.select().from(schema.carts).where(eq(schema.carts.id, target.id)).get();
        }
        return null;
      },
      
      async getOrCreate(sessionToken: string, userId?: string) {
        if (userId) {
          const claimed = await this.claim(sessionToken, userId);
          if (claimed) return claimed;
        }
        let cart = await this.find(sessionToken, userId);
        
        if (!cart) {
           if (!userId) {
             // A browser token outlives a shopper session after expiry or sign-out.
             // Keep the account basket, but stop treating that token as guest access.
             await db.update(schema.carts).set({ sessionToken: null })
               .where(and(eq(schema.carts.sessionToken, sessionToken), eq(schema.carts.closed, false),
                 isNotNull(schema.carts.userId)));
           }
           await db.update(schema.carts).set({ sessionToken: null })
             .where(and(eq(schema.carts.sessionToken, sessionToken), eq(schema.carts.closed, true)));
           const cartId = `cart_${crypto.randomUUID()}`;
           const now = new Date();
           await db.insert(schema.carts).values({
             id: cartId,
             sessionToken,
             userId,
             checkoutSessionId: null,
             items: [],
             closed: false,
             closedAt: null,
             createdAt: now,
             updatedAt: now,
           });
           cart = await this.find(sessionToken, userId);
        }
        
        return cart;
      },
      
      /**
       * Check an item list against the basket limits and the catalog without writing, for example
       * before creating a basket for it. Returns the list with only the stored fields.
       */
      async validateItems(items: unknown, current: Array<{ productId: string; variantId?: string | null }> = []) {
        return checkCartItems(items, current);
      },

      async updateItems(cartId: string, items: CartItemInput[]) {
        assertCartItems(items);

        const cart = await db.select().from(schema.carts).where(eq(schema.carts.id, cartId)).get();
        if (!cart) {
          throw new Error('Cart not found');
        }
        if (cart.closed) {
          throw new Error('Cart is closed');
        }
        if (cart.checkoutSessionId) {
          throw new Error('Checkout already started for this cart');
        }
        const checked = await checkCartItems(items, cart.items);

        const updated = await db.update(schema.carts)
          .set({ items: checked, updatedAt: new Date(), version: sql`${schema.carts.version} + 1` })
          .where(and(eq(schema.carts.id, cartId), eq(schema.carts.closed, false),
            isNull(schema.carts.checkoutSessionId), eq(schema.carts.version, cart.version)))
          .returning({ id: schema.carts.id });
        if (!updated.length) throw new Error('Basket changed or checkout already started; reload and try again');
          
        return await db.select().from(schema.carts).where(eq(schema.carts.id, cartId)).get();
      }
    },

    orders: {
      /**
       * The pending checkout that locks a basket: its payment URL while the provider session is open,
       * or null once the lock is gone. Public routes pass `limitProviderChecks`, so the provider is asked
       * only when the order's provider-check slot is free (see provider-checks.ts); otherwise the order is
       * returned as stored, with `providerCheckLimited` and no payment URL. An order parked for review, or
       * one whose check failed in a way no retry fixes, is returned with `review` and no payment URL; the
       * provider is not asked about a parked one.
       */
      async resumeFromCart(cartId: string, options: { limitProviderChecks?: boolean } = {}) {
        const cart = await db.select().from(schema.carts).where(eq(schema.carts.id, cartId)).get();
        if (!cart?.checkoutSessionId) return null;
        if (cart.checkoutSessionId.startsWith('preparing:')) {
          // Stripe sessions created by this plugin expire after 31 minutes. A Worker can
          // stop between locking the basket and persisting the provider session; only
          // release that orphaned lock after the possible session has expired.
          const cutoff = Math.floor(Date.now() / 1000) - 35 * 60;
          await env.DB.prepare(`UPDATE _ecommerce_carts SET checkout_session_id = NULL,
            updated_at = ?, version = version + 1 WHERE id = ? AND checkout_session_id = ?
            AND updated_at < ? AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders
              WHERE cart_id = _ecommerce_carts.id AND status = 'pending')`)
            .bind(Math.floor(Date.now() / 1000), cartId, cart.checkoutSessionId, cutoff).run();
          return null;
        }
        const order = await db.select().from(schema.orders)
          .where(eq(schema.orders.checkoutSessionId, cart.checkoutSessionId)).get();
        if (!order || order.status !== 'pending') return null;
        if (order.paymentProvider === 'gift_card' && order.totalAmount === 0) {
          await finalizeOrderPayment({ orderId: order.id, provider: 'gift_card',
            providerId: order.checkoutSessionId!, paymentStatus: 'success', amount: 0,
            customerEmail: order.customerEmail ?? undefined });
          return { order: (await this.find(order.id))!, paymentUrl: `/checkout/success?order=${encodeURIComponent(order.id)}` };
        }
        // A parked checkout keeps its basket locked until an administrator retries or releases it.
        if (order.reconcileReviewAt) return { order, paymentUrl: null, review: true };
        if (options.limitProviderChecks && !await mayAskPaymentProvider(env, order, paymentAdapters)) {
          return { order, paymentUrl: null, providerCheckLimited: true };
        }
        let reconciled;
        try {
          reconciled = await this.reconcilePending(order.id);
        } catch (error) {
          // No retry fixes this one: scheduled reconciliation parks it and reports it once.
          if (reconcileFailure(error).permanent) return { order, paymentUrl: null, review: true };
          throw error;
        }
        if (reconciled?.status === 'paid') {
          return { order: (await this.find(order.id))!, paymentUrl: `/checkout/success?order=${encodeURIComponent(order.id)}` };
        }
        if (reconciled?.status === 'cancelled') return null;
        return { order, paymentUrl: reconciled?.paymentUrl ?? null };
      },

      async reconcilePending(id: string) {
        const order = await this.find(id);
        if (!order || order.status !== 'pending' || !order.checkoutSessionId) return null;
        if (order.paymentProvider === 'gift_card') {
          await finalizeOrderPayment({ orderId: order.id, provider: 'gift_card',
            providerId: order.checkoutSessionId, paymentStatus: 'success', amount: 0,
            customerEmail: order.customerEmail ?? undefined });
          return { status: 'paid', paymentUrl: null };
        }
        if (order.paymentProvider === 'admin_test') {
          // Only the admin test route registers the simulated provider; public status checks never settle it.
          // The owner can cancel it, and reconcileCommerce releases it once stale.
          if (!paymentAdapters.some((candidate) => candidate.providerId === 'admin_test')) {
            return { status: 'pending', paymentUrl: null };
          }
          await finalizeOrderPayment({ orderId: order.id, provider: 'admin_test',
            providerId: order.checkoutSessionId, paymentStatus: 'success',
            amount: order.totalAmount, currency: order.currency });
          return { status: 'paid', paymentUrl: null };
        }
        // A parked order waits for an administrator's retry or release; nothing asks the provider about it.
        if (order.reconcileReviewAt) return { status: 'pending', paymentUrl: null, review: true };
        // Failures that another attempt cannot change throw a permanent ReconcileFailure, which
        // reconcileCommerce parks; the provider's own errors are classified there.
        const provider = order.paymentProvider ?? 'stripe';
        const adapter = paymentAdapters.find((candidate) => candidate.providerId === provider);
        if (!adapter?.getCheckoutSession) {
          throw new ReconcileFailure('provider_not_configured', 'Payment provider cannot reconcile checkout');
        }
        // Checked once Stripe is configured: its key then matches the mode setting, so a session of the
        // other mode is a leftover. Without Stripe, a missing mode setting would make every session look
        // like one, and the order waits like any other missing configuration.
        if (provider === 'stripe') assertStoreStripeMode(env, order.checkoutSessionId);
        const session = await adapter.getCheckoutSession(order.checkoutSessionId)
          .catch((error: unknown) => { throw sessionLookupFailure(error); });
        if (session.status === 'expired') {
          await this.cancel(id, { sessionExpired: true });
          return { status: 'cancelled', paymentUrl: null };
        }
        if (session.status === 'complete' && session.paymentStatus === 'paid') {
          // What the provider charged must equal the order's total, which includes shipping and exclusive
          // tax; a mismatch stays a permanent failure.
          if (session.amountTotal !== order.totalAmount ||
            session.currency?.toLowerCase() !== order.currency.toLowerCase() ||
            (provider === 'stripe' && !session.paymentIntentId)) {
            throw new ReconcileFailure('payment_mismatch', 'Completed payment does not match pending order');
          }
          await finalizeOrderPayment({ orderId: id, provider: order.paymentProvider ?? 'stripe',
            providerId: order.checkoutSessionId, paymentStatus: 'success',
            amount: session.amountTotal, currency: session.currency,
            paymentIntentId: session.paymentIntentId ?? undefined,
            customerEmail: session.customerEmail ?? undefined });
          return { status: 'paid', paymentUrl: null };
        }
        return { status: 'pending', paymentUrl: session.status === 'open' ? session.url : null };
      },

      async createFromCart(cartId: string, options: { 
        customerEmail: string; 
        providerId?: string;
        shippingAddress?: any; 
        billingAddress?: any;
        /** One of the store's shipping rates. Without it, the first rate that serves the country. */
        shippingRateId?: string;
        successUrl: string;
        cancelUrl: string;
        referralCode?: string;
        discountCode?: string;
        giftCardCode?: string;
      }) {
         // Read before the basket is locked, so invalid store settings stop checkout without writes.
         const settings = readStoreSettings(env);
         const { currency, deliveryCountries } = settings;
         const cart = await db.select().from(schema.carts).where(eq(schema.carts.id, cartId)).get();
         if (!cart || cart.items.length === 0) {
           throw new Error('Cart is empty or not found');
         }
         if (cart.closed) {
           throw new Error('Cart is closed');
         }
         if (cart.checkoutSessionId) {
           throw new Error('Checkout already started for this cart');
         }
         // The simulated admin_test provider is used only when a caller names it.
         const defaultAdapter = options.providerId
           ? paymentAdapters.find((adapter) => adapter.providerId === options.providerId)
           : paymentAdapters.length === 1 && paymentAdapters[0].providerId !== 'admin_test' ? paymentAdapters[0] : undefined;
         if (!defaultAdapter) throw new Error('A payment provider must be selected and configured before checkout');

         let requiresShipping = false;
         let totalAmount = 0;
         const orderItems: Array<{ productId: string; variantId?: string; quantity: number; priceAtPurchase: number; name: string; usesComponents?: boolean }> = [];
         const componentItems: Array<{ quantity: number; components: RequiredComponent[] }> = [];
         const inventoryDemand = new Map<string, InventoryTarget>();

         // Fetch real product details from the database
         const catalog = await loadBasketCatalog(cart.items);
         for (const item of cart.items) {
            const product = catalog.products.get(String(item.productId));
            if (!product) {
               throw new Error(`Product not found: ${item.productId}`);
            }
            if (product.status !== 'active') {
               throw new Error(`Product is not available: ${item.productId}`);
            }
            // A line saved before its product had variants must be changed to one of them first.
            requireVariantChoice(catalog, product, item.variantId);

            let price = product.basePrice;
            let finalName = product.name;
            let availableQuantity = product.inventoryQuantity;
            let requiredComponents: RequiredComponent[] = [];
            let inventoryTarget: { type: InventoryTarget['type']; id: string } | null =
              { type: 'product', id: product.id };

            if (item.variantId) {
               const selectedVariant = resolveSelectedVariant(catalog, product, item.variantId);
               price = selectedVariant.price;
               finalName = selectedVariant.name;
               availableQuantity = selectedVariant.availableQuantity;
               requiredComponents = selectedVariant.components;
               inventoryTarget = selectedVariant.inventoryTarget;
            }

            if (product.isPhysical) {
               requiresShipping = true;
            }

            const tracksInventory = product.type === 'standard';
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
            if (!Number.isSafeInteger(totalAmount)) throw new Error('Order total is too large');

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

         if (requiresShipping && (!options.shippingAddress ||
           !['name', 'line1', 'city', 'postalCode', 'country'].every((key) =>
             typeof options.shippingAddress[key] === 'string' && options.shippingAddress[key].trim()))) {
            throw new Error('Shipping address is required for physical products');
         }
         // The same rule for every provider, the simulated one too. The billing country must be a
         // country code but is not restricted, and a basket with nothing to ship is not held to the list.
         const shippingAddress = withCountryCode(options.shippingAddress);
         const billingAddress = withCountryCode(options.billingAddress);
         if (requiresShipping && deliveryCountries && !deliveryCountries.includes(shippingAddress.country)) {
           throw new Error(UNDELIVERABLE_COUNTRY);
         }
         // With shipping rates, an order that ships goes only where a rate serves, at the one the
         // shopper chose or else the first. Without rates, or with nothing to ship, shipping is free.
         const shippingRate = requiresShipping && settings.shippingRates.length
           ? chooseShippingRate(settings, shippingAddress.country, options.shippingRateId) : null;
         // With a Stripe tax mode every order is taxed but the simulated ones, for where it ships, or
         // for the billing address when nothing ships.
         const taxBehavior = settings.tax.mode === 'none' || defaultAdapter.providerId === 'admin_test' ? null
           : settings.tax.mode === 'stripe-inclusive' ? 'inclusive' : 'exclusive';
         const taxAddress = taxBehavior ? taxAddressFor(requiresShipping, shippingAddress, billingAddress) : null;

         const orderId = `ord_${crypto.randomUUID()}`;
         const referralsPolicy = await getReferralPolicy(env);
         const subtotalAmount = totalAmount;
         const discount = options.discountCode && defaultAdapter.providerId === 'stripe'
           ? await evaluateDiscountCode(env, {
             code: options.discountCode, customerEmail: options.customerEmail,
             accountId: cart.userId, lines: orderItems, subtotal: subtotalAmount
           }) : null;
         const discountAmount = discount?.amount ?? 0;
         const merchandise = subtotalAmount - discountAmount;
         const shippingAmount = shippingRate ? shippingCharge(shippingRate, merchandise) : 0;
         let creditApplied = 0;
         const owner = cart.userId ? await db.select({ creditBalance: schema.customerAccounts.creditBalance,
           emailNormalized: schema.customerAccounts.emailNormalized })
           .from(schema.customerAccounts).where(eq(schema.customerAccounts.id, cart.userId)).get() : undefined;
         if (owner && defaultAdapter.providerId === 'stripe') {
           // Credit pays for items only, and leaves at least Stripe's minimum charge for the currency on
           // the card. It is never offered to a guest basket.
           creditApplied = Math.min(Math.max(0, owner.creditBalance), merchandise,
             Math.max(0, merchandise + shippingAmount - minimumChargeAmount(currency)));
         }
         // Tax is calculated on the items after the discount and credit, and on the shipping. A gift
         // card is a means of payment, so it never lowers the taxed amounts.
         const tax = taxBehavior && taxAddress ? await calculateOrderTax(defaultAdapter, {
           cartId, currency, behavior: taxBehavior, settings: settings.tax, shippingAmount, ...taxAddress,
           lines: taxableLines(orderItems, { amount: discountAmount, productIds: discount?.eligibleProductIds ?? [] },
             creditApplied),
         }) : null;
         // Exclusive tax is added to what the shopper pays; inclusive tax is already in the prices.
         const exclusiveTax = tax?.behavior === 'exclusive' ? tax.amount : 0;
         const amountDue = merchandise - creditApplied + shippingAmount + exclusiveTax;
         if (!Number.isSafeInteger(amountDue)) throw new Error('Order total is too large');
         // A gift card is a means of payment: it can pay for shipping too.
         const giftCard = options.giftCardCode && defaultAdapter.providerId === 'stripe'
           ? await evaluateGiftCard(env, options.giftCardCode, amountDue) : null;
         const giftCardApplied = giftCard?.amount ?? 0;
         totalAmount = amountDue - giftCardApplied;
         const internallyPaid = Boolean(giftCard && totalAmount === 0);
         let referralCode: string | null = null;
         if (referralsPolicy.enabled && options.referralCode && defaultAdapter.providerId === 'stripe' &&
             !internallyPaid && subtotalAmount - discountAmount >= referralsPolicy.minOrderCents) {
           // A referral is for a first purchase. A shopper who signed up first still qualifies;
           // only past paid orders under the account or either email rule it out. Addresses are
           // compared exactly and in canonical form, for the referrer and for earlier buyers.
           const referral = await findReferralCode(env, options.referralCode);
           const buyerEmails = [options.customerEmail.trim().toLowerCase(), owner?.emailNormalized];
           const referrerCanonical = canonicalEmail(referral?.emailNormalized);
           if (referral && referrerCanonical && referral.accountId !== cart.userId &&
               !buyerEmails.includes(referral.emailNormalized) &&
               !canonicalEmails(buyerEmails).includes(referrerCanonical) &&
               !await hasPurchaseHistory(env, { emails: buyerEmails, accountIds: [cart.userId] }) &&
               !await hasCanonicalPurchase(env, buyerEmails)) {
             referralCode = referral.code;
           }
         }
         if (!defaultAdapter.expireCheckoutSession) {
           throw new Error('Payment provider must support checkout session expiry');
         }
         const successUrl = options.successUrl.replaceAll('{ORDER_ID}', orderId);
         const cancelUrl = options.cancelUrl.replaceAll('{ORDER_ID}', orderId);
         const now = new Date();
         const timestamp = Math.floor(now.getTime() / 1000);
         const preparationLock = `preparing:${orderId}`;
         // The lines are compared as stored, so a basket changed since it was read is not locked.
         const lock = await db.update(schema.carts)
           .set({ checkoutSessionId: preparationLock, updatedAt: now, version: sql`${schema.carts.version} + 1` })
           .where(and(eq(schema.carts.id, cartId), eq(schema.carts.closed, false), isNull(schema.carts.checkoutSessionId),
             eq(schema.carts.items, cart.items), eq(schema.carts.version, cart.version)))
           .returning({ id: schema.carts.id });
         if (!lock.length) throw new Error('Checkout already started for this cart');

         let session: Awaited<ReturnType<typeof defaultAdapter.createCheckoutSession>> | undefined;
         let committed = false;
         // The provider may have created a discount for this checkout once it was asked for a session.
         let providerDiscount = false;
         try {
         providerDiscount = !internallyPaid && creditApplied + discountAmount + giftCardApplied > 0;
         session = internallyPaid ? { providerSessionId: `internal:${orderId}`, url: successUrl }
           : await defaultAdapter.createCheckoutSession({
            orderId,
            currency,
            items: orderItems.map(i => ({
               name: i.name,
               priceCents: i.priceAtPurchase,
               quantity: i.quantity
            })),
            customerEmail: options.customerEmail,
            creditApplied,
            discountApplied: discountAmount,
            giftCardApplied,
            shipping: shippingRate ? { label: shippingRate.label, amount: shippingAmount,
              description: deliveryEstimate(shippingRate) ?? undefined } : undefined,
            tax: exclusiveTax > 0 ? { amount: exclusiveTax } : undefined,
            metadata: { giftCardApplied: String(giftCardApplied),
              storeCreditApplied: String(creditApplied), promotionDiscount: String(discountAmount) },
            successUrl,
            cancelUrl
         });
         if (!session.providerSessionId || !session.url) throw new Error('Payment provider did not return a checkout session');
         const checkoutSessionId = session.providerSessionId;
         const statements: D1PreparedStatement[] = [
           env.DB.prepare(`INSERT INTO _ecommerce_orders
             (id, cart_id, user_id, checkout_session_id, payment_provider, status, items, total_amount, subtotal_amount, credit_applied, discount_code, discount_amount, gift_card_id, gift_card_applied, referral_code, referral_reward_cents, currency,
              shipping_amount, shipping_rate_id, shipping_label, tax_amount, tax_behavior, tax_calculation_id,
              customer_email, shipping_address, billing_address, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) `)
             .bind(orderId, cartId, cart.userId, checkoutSessionId, internallyPaid ? 'gift_card' : defaultAdapter.providerId,
               JSON.stringify(orderItems.map(({ name, ...rest }) => rest)), totalAmount,
               subtotalAmount, creditApplied, discount?.code ?? null, discountAmount,
               giftCard?.id ?? null, giftCardApplied,
               referralCode, referralCode ? referralsPolicy.rewardCents : 0, currency,
               shippingAmount, shippingRate?.id ?? null, shippingRate?.label ?? null,
               tax?.amount ?? 0, tax?.behavior ?? null, tax?.calculationId ?? null,
               options.customerEmail, shippingAddress ? JSON.stringify(shippingAddress) : null,
               billingAddress ? JSON.stringify(billingAddress) : null,
               timestamp, timestamp)
         ];
         if (discount) {
           statements.push(env.DB.prepare(`INSERT INTO _ecommerce_discount_redemptions
             (id, code, order_id, account_id, email_normalized, amount_cents, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`)
             .bind(`dred_${orderId}`, discount.code, orderId, cart.userId,
               discount.emailNormalized, discount.amount, timestamp, timestamp));
         }
         if (giftCard) {
           statements.push(env.DB.prepare(`INSERT INTO _ecommerce_gift_card_redemptions
             (id,card_id,order_id,amount_cents,status,created_at,updated_at)
             VALUES (?,?,?,?,'reserved',?,?)`)
             .bind(`gcr_${orderId}`, giftCard.id, orderId, giftCardApplied, timestamp, timestamp));
         }
         if (creditApplied && cart.userId) {
           statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
             (id, account_id, order_id, kind, amount_cents, created_at)
             VALUES (?, ?, ?, 'checkout_reserve', ?, ?)`)
             .bind(`credit_hold_${orderId}`, cart.userId, orderId, -creditApplied, timestamp));
         }
         // One statement per table whatever the size of the basket: each reads its rows from a JSON list.
         // Stock writes move updated_at by at least a second, so an admin save of stock loaded before
         // this reservation is refused as stale instead of overwriting it.
         const reserves = defaultAdapter.reservesInventory !== false;
         const componentReservations = reserves ? [...componentDemand].map(([target, demand]) =>
           ({ id: crypto.randomUUID(), target, amount: demand.quantity })) : [];
         if (componentReservations.length) {
           const list = JSON.stringify(componentReservations);
           statements.push(env.DB.prepare(`UPDATE _ecommerce_components
             SET quantity = quantity - demand.amount, updated_at = MAX(updated_at + 1, ?)
             FROM (${RESERVATION_ROWS}) AS demand WHERE _ecommerce_components.id = demand.target`)
             .bind(timestamp, list));
           statements.push(env.DB.prepare(`INSERT INTO _ecommerce_component_reservations
             (id, order_id, component_id, quantity)
             SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.target'), json_extract(value, '$.amount')
             FROM json_each(?)`)
             .bind(orderId, list));
         }
         const inventoryReservations = reserves ? [...inventoryDemand.values()].map((demand) =>
           ({ id: crypto.randomUUID(), type: demand.type, target: demand.id, amount: demand.quantity })) : [];
         for (const [type, [table, column]] of Object.entries(INVENTORY_COLUMNS)) {
           const list = inventoryReservations.filter((reservation) => reservation.type === type);
           if (!list.length) continue;
           statements.push(env.DB.prepare(`UPDATE ${table}
             SET ${column} = ${column} - demand.amount, updated_at = MAX(updated_at + 1, ?)
             FROM (${RESERVATION_ROWS}) AS demand WHERE ${table}.id = demand.target`)
             .bind(timestamp, JSON.stringify(list)));
         }
         if (inventoryReservations.length) {
           statements.push(env.DB.prepare(`INSERT INTO _ecommerce_inventory_reservations
             (id, order_id, target_type, target_id, quantity)
             SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.type'), json_extract(value, '$.target'),
               json_extract(value, '$.amount')
             FROM json_each(?)`)
             .bind(orderId, JSON.stringify(inventoryReservations)));
         }
         statements.push(env.DB.prepare(`UPDATE _ecommerce_carts SET checkout_session_id = ?, updated_at = ?
           WHERE id = ? AND checkout_session_id = ?`)
           .bind(checkoutSessionId, timestamp, cartId, preparationLock));
         // D1 batches are atomic; nonnegative constraints reject competing reservations.
         try {
           await env.DB.batch(statements);
           committed = true;
         } catch (cause) {
           if (cause instanceof Error && cause.message.includes('Discount code is no longer available')) {
             throw new Error('Discount code is no longer available', { cause });
           }
           if (cause instanceof Error && cause.message.includes('Insufficient store credit')) {
             throw new Error('Store credit changed during checkout; please try again', { cause });
           }
           if (cause instanceof Error && cause.message.includes('Gift card is no longer available')) {
             throw new Error('Gift card is no longer available', { cause });
           }
           throw new Error('Insufficient stock or checkout already started', { cause });
         }

         const order = await this.find(orderId);
         if (!order) throw new Error('Checkout was created but the order could not be loaded');
         if (internallyPaid) {
           await finalizeOrderPayment({ orderId, provider: 'gift_card',
             providerId: checkoutSessionId, paymentStatus: 'success', amount: 0,
             customerEmail: options.customerEmail });
           return { order: (await this.find(orderId))!, paymentUrl: session.url };
         }
         return { order, paymentUrl: session.url };
         } catch (error) {
           if (committed) throw error;
           try {
             if (session?.providerSessionId && !internallyPaid) {
               // Never unlock the basket while a provider session may still accept payment.
               await defaultAdapter.expireCheckoutSession(session.providerSessionId);
             }
           } finally {
             if (providerDiscount) await discardCheckoutDiscount(defaultAdapter, orderId);
           }
           await db.update(schema.carts).set({ checkoutSessionId: null })
             .where(and(eq(schema.carts.id, cartId), eq(schema.carts.checkoutSessionId, preparationLock)));
           throw error;
         }
      },

      async create(data: {
        id?: string;
        cartId?: string;
        userId?: string;
        checkoutSessionId?: string;
        status?: string;
        totalAmount: number;
        currency?: string;
        customerEmail?: string;
        items: Array<{ productId: string; variantId?: string; quantity: number; priceAtPurchase: number; }>;
        shippingAddress?: { name?: string; line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string };
        billingAddress?: { name?: string; line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string };
      }) {
        const orderId = data.id || `ord_${Date.now()}`;
        const now = new Date();
        
        // 1. Insert order with JSON items array
        await db.insert(schema.orders).values({
          id: orderId,
          cartId: data.cartId,
          userId: data.userId,
          checkoutSessionId: data.checkoutSessionId,
          paymentProvider: null,
          status: data.status || 'draft',
          totalAmount: data.totalAmount,
          currency: data.currency || readStoreSettings(env).currency,
          customerEmail: data.customerEmail,
          items: data.items,
          shippingAddress: data.shippingAddress,
          billingAddress: data.billingAddress,
          createdAt: now,
          updatedAt: now,
        });

        return await this.find(orderId);
      },
      
      async find(id: string) {
        // Items are now stored natively as JSON on the order row
        const order = await db.select().from(schema.orders).where(eq(schema.orders.id, id)).get();
        if (!order) return null;
        
        return order;
      },

      async findForSession(id: string, sessionToken: string | undefined, customerId?: string) {
        const order = await this.find(id);
        if (!order?.cartId) return null;
        if (customerId && order.userId === customerId) return order;
        if (!sessionToken) return null;
        const cart = await db.select().from(schema.carts).where(eq(schema.carts.id, order.cartId)).get();
        return cart?.sessionToken === sessionToken ? order : null;
      },
      
      /**
       * 'fulfilled' records a shipment that completes the order: it sets `fulfillmentStatus` and leaves
       * the payment `status` as it is. Payment statuses change only through payment and cancellation.
       */
      async updateStatus(id: string, status: string, fulfillment?: {
        actor: string; carrier: string | null; trackingNumber: string | null; note: string;
      }) {
        if (status !== 'fulfilled') throw new Error('Use the payment or cancellation workflow to change order status');
        const order = await this.find(id);
        if (order?.paymentProvider === 'admin_test') throw new Error('Admin test orders cannot be fulfilled');
        if (!fulfillment) throw new Error('Audited fulfillment details are required');
        await fulfillCommerceOrder(env, fulfillment.actor, { orderId: id,
          carrier: fulfillment.carrier, trackingNumber: fulfillment.trackingNumber,
          note: fulfillment.note });
        return await this.find(id);
      },

      async finalizePayment(id: string, options: {
        provider: string;
        providerId: string;
        paymentIntentId?: string;
        paymentStatus?: string;
        amount?: number;
        currency?: string;
        customerEmail?: string;
      }) {
        return finalizeOrderPayment({
          orderId: id,
          provider: options.provider,
          providerId: options.providerId,
          paymentIntentId: options.paymentIntentId,
          paymentStatus: options.paymentStatus,
          amount: options.amount,
          currency: options.currency,
          customerEmail: options.customerEmail
        });
      },

      /**
       * Release a pending order, its reservations and its basket lock. The public release route passes
       * `limitProviderChecks`, so the provider is asked only when the order's provider-check slot is free;
       * otherwise it throws ProviderCheckLimitedError and changes nothing. An order parked for review is
       * released only with `reviewRelease`, an administrator's decision, or once its session expired. A
       * Stripe session of the other mode is never asked about, since this Worker's key cannot read it.
       */
      async cancel(id: string, options: {
        sessionExpired?: boolean; limitProviderChecks?: boolean;
        /**
         * An administrator's release of a parked order, whose `decision` is recorded in the batch that
         * cancels it. A Stripe session of the other mode is not looked up, and a session the provider no
         * longer has counts as closed. Any other session is asked about as usual; a completed one is
         * released only once its payment went back to the shopper (see completedCheckoutReturn), which
         * `confirmPaymentReturned` confirms only where the provider names no payment to check.
         */
        reviewRelease?: { decision: ReconcileDecision; confirmPaymentReturned?: boolean };
      } = {}) {
        const order = await db.select().from(schema.orders).where(eq(schema.orders.id, id)).get();
        if (!order) return null;
        // A paid order, refunded or disputed since included, keeps its stock and its status.
        if ((PURCHASED_ORDER_STATUSES as readonly string[]).includes(order.status)) return order;

        const timestamp = Math.floor(Date.now() / 1000);
        if (order.status === 'cancelled') return order;
        if (order.reconcileReviewAt && !options.sessionExpired && !options.reviewRelease) {
          throw new Error(PARKED_CHECKOUT_MESSAGE);
        }
        const reservations = await db.select().from(schema.componentReservations)
          .where(eq(schema.componentReservations.orderId, id));
        const inventoryReservations = await db.select().from(schema.inventoryReservations)
          .where(eq(schema.inventoryReservations.orderId, id));
        const otherModeSession = (order.paymentProvider ?? 'stripe') === 'stripe' &&
          isOtherStripeModeSession(env, order.checkoutSessionId);
        let paymentReturned: PaymentReturn | null = null;
        // A simulated admin_test checkout has no external session, so it can be released without its provider.
        if (order.checkoutSessionId && !options.sessionExpired && order.paymentProvider !== 'admin_test') {
          const adapter = paymentAdapters.find((candidate) => candidate.providerId === (order.paymentProvider ?? 'stripe'));
          if (!adapter?.expireCheckoutSession) {
            throw new Error('Payment provider must expire the checkout session before stock can be released');
          }
          // With Stripe configured, its key matches the mode setting, so a session of the other mode is a
          // leftover this key cannot read. Scheduled reconciliation parks its order for the store's review;
          // only an administrator releases it, after checking the session in that mode's dashboard.
          if (otherModeSession && !options.reviewRelease) throw new Error(PARKED_CHECKOUT_MESSAGE);
          // A session this key cannot read or expire may still be paid; the release waits until it has expired.
          const refuseUnchecked = () => {
            const refusal = uncheckedSessionRefusal(Math.floor(order.createdAt.getTime() / 1000));
            if (refusal) throw refusal;
          };
          if (otherModeSession) refuseUnchecked();
          if (!otherModeSession) {
            if (options.limitProviderChecks && !await mayAskPaymentProvider(env, order, paymentAdapters)) {
              throw new ProviderCheckLimitedError();
            }
            let session: Awaited<ReturnType<NonNullable<typeof adapter.getCheckoutSession>>> | undefined;
            let missing = false;
            try {
              session = await adapter.getCheckoutSession?.(order.checkoutSessionId);
            } catch (error) {
              if (!options.reviewRelease || !isMissingSessionError(error)) throw error;
              missing = true;
              refuseUnchecked();
            }
            if (session?.status === 'complete') {
              if (!options.reviewRelease) {
                throw new Error('Payment has completed; wait for confirmation before changing the basket');
              }
              // A refund leaves the session complete and paid, so the payment itself is asked about.
              paymentReturned = await completedCheckoutReturn(adapter, session, options.reviewRelease.confirmPaymentReturned);
            } else if (!missing && session?.status !== 'expired') {
              await adapter.expireCheckoutSession(order.checkoutSessionId);
            }
          }
        }
        const statements: D1PreparedStatement[] = [
          env.DB.prepare(`UPDATE _ecommerce_orders SET status = 'cancelled', updated_at = ?
            WHERE id = ? AND status NOT IN (${PURCHASED_ORDER_STATUSES.map((status) => `'${status}'`).join(', ')})`)
            .bind(timestamp, id)
        ];
        statements.push(env.DB.prepare(`UPDATE _ecommerce_discount_redemptions
          SET status = 'cancelled', updated_at = ?
          WHERE order_id = ? AND status = 'reserved'
            AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`)
          .bind(timestamp, id, id));
        statements.push(env.DB.prepare(`UPDATE _ecommerce_gift_card_redemptions
          SET status = 'cancelled', updated_at = ?
          WHERE order_id = ? AND status = 'reserved'
            AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`)
          .bind(timestamp, id, id));
        if (order.creditApplied > 0) {
          statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
            (id, account_id, order_id, kind, amount_cents, created_at)
            SELECT ?, user_id, id, 'checkout_release', credit_applied, ?
            FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled' AND user_id IS NOT NULL
            ON CONFLICT(order_id, kind) DO NOTHING`)
            .bind(`credit_release_${id}`, timestamp, id));
        }
        // Like reservations, releases move the stock rows' updated_at, so a stale admin save is refused.
        for (const reservation of reservations) {
          statements.push(env.DB.prepare(`UPDATE _ecommerce_components
            SET quantity = quantity + (SELECT quantity FROM _ecommerce_component_reservations
              WHERE id = ? AND released_at IS NULL), updated_at = MAX(updated_at + 1, ?)
            WHERE id = ? AND EXISTS (SELECT 1 FROM _ecommerce_component_reservations
              WHERE id = ? AND released_at IS NULL)
              AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`)
            .bind(reservation.id, timestamp, reservation.componentId, reservation.id, id));
          statements.push(env.DB.prepare(`UPDATE _ecommerce_component_reservations SET released_at = ?
            WHERE id = ? AND released_at IS NULL
              AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`)
            .bind(timestamp, reservation.id, id));
        }
        for (const reservation of inventoryReservations) {
          const [table, column] = INVENTORY_COLUMNS[reservation.targetType];
          statements.push(env.DB.prepare(`UPDATE ${table}
            SET ${column} = ${column} + (SELECT quantity FROM _ecommerce_inventory_reservations
              WHERE id = ? AND released_at IS NULL), updated_at = MAX(updated_at + 1, ?)
            WHERE id = ? AND EXISTS (SELECT 1 FROM _ecommerce_inventory_reservations
              WHERE id = ? AND released_at IS NULL)
              AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`)
            .bind(reservation.id, timestamp, reservation.targetId, reservation.id, id));
          statements.push(env.DB.prepare(`UPDATE _ecommerce_inventory_reservations SET released_at = ?
            WHERE id = ? AND released_at IS NULL
              AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`)
            .bind(timestamp, reservation.id, id));
        }
        if (order.cartId) {
          statements.push(env.DB.prepare(`UPDATE _ecommerce_carts
            SET checkout_session_id = NULL, updated_at = ?
            WHERE id = ? AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'cancelled')`)
            .bind(timestamp, order.cartId, id));
          statements.push(env.DB.prepare(`UPDATE _ecommerce_orders SET cart_id = NULL
            WHERE id = ? AND status = 'cancelled'`).bind(id));
        }
        if (options.reviewRelease) {
          // The administrator's decision is kept with the release: this batch records it whenever it leaves
          // the order cancelled, and a failed record rolls the whole release back.
          const { decision } = options.reviewRelease;
          statements.push(env.DB.prepare(decisionInsert('order', 'release', `status = 'cancelled'`))
            .bind(decision.id, paymentReturned, decision.actor, decision.reason, timestamp, id));
        }
        await env.DB.batch(statements);

        const cancelled = await this.find(id);
        // A cancelled checkout's single-use discount is deleted, whichever path cancelled it. A session of
        // the other Stripe mode has its discount in that mode, out of this key's reach; it expires with
        // the session.
        if (cancelled?.status === 'cancelled' && !otherModeSession &&
            order.creditApplied + order.discountAmount + order.giftCardApplied > 0) {
          await discardCheckoutDiscount(
            paymentAdapters.find((candidate) => candidate.providerId === (order.paymentProvider ?? 'stripe')), id);
        }
        return cancelled;
      }
    },
    
    webhooks: {
      /**
       * Verifies a Stripe webhook event and applies it. An event that names none of this store's orders
       * or gift card purchases is answered `{ ignored: true }` and changes nothing. One that names a
       * record it cannot be applied to, and that no retry would fix, is logged and answered the same
       * way with a `reason`. Throws WebhookSignatureError when the signature or payload is refused, and
       * WebhookRetryLaterError for an event about a record whose payment is not recorded yet.
       */
      async handleStripe(payload: string, signature: string, secret?: string) {
        const stripeAdapter = paymentAdapters.find(a => a.providerId === 'stripe');
        if (!stripeAdapter?.validateWebhook) {
          throw new Error('Stripe adapter not configured options.paymentAdapters');
        }

        let event: ValidatedWebhookEvent;
        try {
          event = await stripeAdapter.validateWebhook(payload, signature, secret || '');
        } catch (cause) {
          throw new WebhookSignatureError(cause instanceof Error ? cause.message : 'Webhook Error', { cause });
        }
        try {
          return await applyStripeEvent(event, stripeAdapter);
        } catch (error) {
          if (!(error instanceof WebhookMismatchError)) throw error;
          console.error('[commerce] Stripe event does not match the store records',
            { type: event.type, id: event.id, reason: error.reason });
          return { success: true, event: event.type, ignored: true, reason: error.reason };
        }
      }
    }
  }
}

/**
 * Run from a protected admin request or a scheduled Worker to repair missed webhooks. Each row is
 * attempted on its own: a failure is reported in its result and never stops the others.
 *
 * Pending orders and gift card purchases are taken in turn, rows never tried first, each once its
 * backoff since the last attempt has passed (2^attempts minutes, at most six hours), so a row that keeps
 * failing never holds back newer ones. Every attempt is recorded. A permanent failure (a session the
 * provider no longer has, a session of the other Stripe mode, a completed payment that does not match)
 * parks the row for an administrator: that attempt reports `error` with `parked: true`, and a parked row
 * is not selected again, so only new or transient failures are reported.
 *
 * Tax records and reversals back off the same way on counts of their own, and a success clears the
 * count. They are not parked: one that keeps failing is reported each time it is tried again.
 */
export async function reconcileCommerce(options: CommerceApiOptions, limit = 10) {
  const count = Math.max(1, Math.min(20, Math.floor(limit)));
  const { env } = options;
  const api = bindCommerceApi(options);
  const now = Math.floor(Date.now() / 1000);
  const db = createDbClient(env);
  // The queue selections below stay raw SQL: the tests pin their text and query plans, and the order
  // queries need their status literal for the partial index of migration 0029. ';' follows ':', so the
  // range holds exactly the ids that start with 'preparing:', read from the unique index on
  // checkout_session_id. LIKE cannot use that index: it ignores case.
  const preparations = await env.DB.prepare(`SELECT id FROM _ecommerce_carts
    WHERE checkout_session_id >= 'preparing:' AND checkout_session_id < 'preparing;' AND updated_at < ?
    ORDER BY updated_at LIMIT ?`).bind(now - 35 * 60, count).all<{ id: string }>();
  // Without the simulated provider a stale admin_test order cannot be settled. It is released instead,
  // so it never keeps the admin's basket locked or crowds real orders out of this batch.
  const settlesAdminTest = options.paymentAdapters?.some(adapter => adapter.providerId === 'admin_test') ?? false;
  // Both order queries state `status = 'pending'` as a literal, which lets them use the partial index
  // of migration 0029.
  const pending = await env.DB.prepare(`SELECT id FROM _ecommerce_orders
    WHERE status = 'pending' AND created_at < ? AND reconcile_review_at IS NULL AND ${RECONCILE_DUE}
      AND (? = 1 OR COALESCE(payment_provider, 'stripe') <> 'admin_test')
    ORDER BY ${RECONCILE_ORDER} LIMIT ?`)
    .bind(now - 15 * 60, now, settlesAdminTest ? 1 : 0, count).all<{ id: string }>();
  const abandonedTests = settlesAdminTest ? { results: [] } : await env.DB.prepare(`SELECT id FROM _ecommerce_orders
    WHERE status = 'pending' AND payment_provider = 'admin_test' AND created_at < ?
    ORDER BY created_at LIMIT ?`)
    .bind(now - 15 * 60, count).all<{ id: string }>();
  const giftPurchases = await env.DB.prepare(`SELECT id FROM _ecommerce_gift_card_purchases
    WHERE status = 'pending' AND provider_session_id IS NOT NULL AND created_at < ?
      AND reconcile_review_at IS NULL AND ${RECONCILE_DUE}
    ORDER BY ${RECONCILE_ORDER} LIMIT ?`)
    .bind(now - 15 * 60, now, count).all<{ id: string }>();
  const results: ReconcileResult[] = [];
  for (const row of preparations.results ?? []) {
    try {
      await api.orders.resumeFromCart(row.id);
      results.push({ id: row.id, status: 'preparation_checked' });
    } catch (error) {
      results.push({ id: row.id, status: 'error', error: error instanceof Error ? error.message : 'Recovery failed' });
    }
  }
  for (const row of pending.results ?? []) {
    results.push(await reconcileAttempt(env, 'order', row.id, now, () => api.orders.reconcilePending(row.id)));
  }
  for (const row of abandonedTests.results ?? []) {
    try {
      const cancelled = await api.orders.cancel(row.id);
      results.push({ id: row.id, status: cancelled?.status ?? 'unchanged' });
    } catch (error) {
      results.push({ id: row.id, status: 'error', error: error instanceof Error ? error.message : 'Recovery failed' });
    }
  }
  const stripe = options.paymentAdapters?.find(adapter => adapter.providerId === 'stripe');
  for (const row of giftPurchases.results ?? []) {
    results.push(await reconcileAttempt(env, 'gift_card_purchase', row.id, now,
      () => reconcileGiftCardPurchase(env, stripe, row.id)));
  }
  // Tax transactions that were not recorded when their orders were paid, reversals whose request
  // failed, and then refunds not yet mirrored in the tax: gift card tender refunds, refunds of
  // gift-card-only orders and any reversal not recorded at refund time. Each pass backs off failing
  // rows on counts of their own, apart from the payment ones above (see tax.ts), and a pass that fails
  // as a whole is reported under its name without stopping the others.
  const adapters = options.paymentAdapters ?? [];
  const taxPasses = [['tax_transactions', recordMissingTaxTransactions],
    ['tax_reversal_resends', resendPendingTaxReversals], ['tax_reversals', reverseUnreversedTax]] as const;
  for (const [name, pass] of taxPasses) {
    try {
      results.push(...await pass(env, adapters, now, count));
    } catch (error) {
      const failure = reconcileFailure(error);
      results.push({ id: name, status: 'error', error: failure.message, code: failure.code });
    }
  }
  // Pending referral awards whose hold has passed. Held and voided awards are outcomes, not failures.
  try {
    results.push(...await releaseReferralAwards(options, { limit: count }));
  } catch (error) {
    results.push({ id: 'referral_awards', status: 'error',
      error: error instanceof Error ? error.message : 'Referral release failed' });
  }
  // Order, shipment and gift card emails that could not be sent at once. Results carry ids and codes only.
  // A retry takes about five queries and a send, so a run retries at most five and a backlog clears over
  // the following runs. This bounds the retries only: an order or purchase that a pass above confirms
  // sends its email as part of that pass.
  try {
    results.push(...await deliverPendingCommerceEmails({ env }, { limit: Math.min(count, 5) }));
  } catch (error) {
    results.push({ id: 'commerce_emails', status: 'error',
      error: error instanceof Error ? error.message : 'Email delivery failed' });
  }
  await db.delete(schema.customerSessions).where(or(
    and(eq(schema.customerSessions.purpose, 'email_challenge'), lt(schema.customerSessions.expiresAt, at(now - 24 * 60 * 60))),
    and(eq(schema.customerSessions.purpose, 'session'), lt(schema.customerSessions.expiresAt, at(now - 30 * 24 * 60 * 60)))));
  return results;
}

export interface CommercePurgeOptions {
  env: TalismanEnv;
  now?: Date;
  /** Rows deleted per statement. */
  batchSize?: number;
}

/** Statements per table and run; a larger backlog is finished by later runs. */
const PURGE_MAX_BATCHES = 20;

/**
 * Delete shopper and sign-in data past its retention period. Run it from the scheduled
 * Worker next to reconcileCommerce; deletes are batched to stay inside D1 and Worker limits.
 * Every table is attempted, and the run throws afterwards if any of them failed.
 */
export async function purgeStaleCommerceData(options: CommercePurgeOptions) {
  const { env } = options;
  const batchSize = Math.max(1, Math.min(1000, Math.floor(options.batchSize ?? 500)));
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const day = 24 * 60 * 60;
  const deleted = { carts: 0, customerSessions: 0, signInTokens: 0, unverifiedAccounts: 0, rateLimits: 0,
    authSessions: 0, authRateLimits: 0 };
  const steps: Array<[keyof typeof deleted, string, number[]]> = [
    // Guest baskets untouched for 30 days. Account, checked-out and locked baskets stay.
    ['carts', `DELETE FROM _ecommerce_carts WHERE id IN (SELECT id FROM _ecommerce_carts
      WHERE user_id IS NULL AND closed = 0 AND checkout_session_id IS NULL AND updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders WHERE cart_id = _ecommerce_carts.id)
      LIMIT ?)`, [now - 30 * day]],
    // Shopper sessions, and sign-in links sent before migration 0024, a day after they expired, were used or signed out.
    ['customerSessions', `DELETE FROM _ecommerce_customer_sessions WHERE id IN (SELECT id
      FROM _ecommerce_customer_sessions WHERE expires_at < ? OR revoked_at < ? LIMIT ?)`, [now - day, now - day]],
    // Sign-in links, with the address they were sent to, a day after they expired or were used.
    ['signInTokens', `DELETE FROM _ecommerce_sign_in_tokens WHERE token_hash IN (SELECT token_hash
      FROM _ecommerce_sign_in_tokens WHERE expires_at < ? OR revoked_at < ? LIMIT ?)`, [now - day, now - day]],
    // Accounts that asking for a sign-in link used to create: never verified, a day old, and with no
    // orders, sessions, basket, credit, referral or discount use. Anything else keeps the account.
    ['unverifiedAccounts', `DELETE FROM _ecommerce_customer_accounts WHERE id IN (SELECT a.id
      FROM _ecommerce_customer_accounts a
      WHERE a.email_verified_at IS NULL AND a.cms_user_id IS NULL AND a.credit_balance = 0 AND a.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders WHERE user_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_customer_sessions WHERE account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_carts WHERE user_id = a.id AND closed = 0)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_credit_ledger WHERE account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_referral_codes WHERE account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_referrals WHERE referrer_account_id = a.id OR referred_account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_discount_redemptions WHERE account_id = a.id)
      LIMIT ?)`, [now - day]],
    // Shopper request counters. Every window is at most a day long.
    ['rateLimits', `DELETE FROM _ecommerce_rate_limits WHERE key IN (SELECT key FROM _ecommerce_rate_limits
      WHERE window_start < ? LIMIT ?)`, [now - day]],
    ['authSessions', `DELETE FROM galaxy_auth_session WHERE id IN (SELECT id FROM galaxy_auth_session
      WHERE expires_at < ? LIMIT ?)`, [now]],
    // better-auth records milliseconds. Shopper counters written in seconds before migration 0024 may remain.
    ['authRateLimits', `DELETE FROM galaxy_auth_rate_limit WHERE id IN (SELECT id FROM galaxy_auth_rate_limit
      WHERE CASE WHEN last_request >= 100000000000 THEN last_request / 1000 ELSE last_request END < ?
      LIMIT ?)`, [now - day]],
  ];
  const failures: string[] = [];
  for (const [table, query, params] of steps) {
    try {
      for (let batch = 0; batch < PURGE_MAX_BATCHES; batch++) {
        const result = await env.DB.prepare(query).bind(...params, batchSize).run();
        const changes = Number(result.meta?.changes ?? 0);
        deleted[table] += changes;
        if (changes < batchSize) break;
      }
    } catch (error) {
      failures.push(`${table}: ${error instanceof Error ? error.message : 'cleanup failed'}`);
    }
  }
  if (failures.length) throw new Error(`Commerce data cleanup failed (${failures.join('; ')})`);
  return deleted;
}
