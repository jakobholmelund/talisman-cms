import { eq } from 'drizzle-orm';
import type { CommerceContext } from './commerce-context';
import * as schema from './schema';
import { PURCHASED_ORDER_STATUSES } from './accounts';
import { deliverCommerceEmail } from './commerce-emails';
import { canonicalEmail, canonicalEmailSql, canonicalEmails, canonicalPurchaseParams, canonicalPurchaseSql } from './email-identity';
import { commerceEmailStatement } from './email-deliveries';
import { fulfillCommerceOrder } from './fulfillment';
import { INVENTORY_COLUMNS } from './inventory';
import { fullRefundStatements } from './order-adjustments';
import type { PaymentProviderAdapter } from './payments';
import { ProviderCheckLimitedError, mayAskPaymentProvider } from './provider-checks';
import { completedCheckoutReturn, decisionInsert, isMissingSessionError, isOtherStripeModeSession, uncheckedSessionRefusal,
  type PaymentReturn, type ReconcileDecision } from './reconcile';
import { getReferralPolicy, referralReversalStatements } from './referrals';
import { readStoreSettings } from './store-settings';
import { recordConfirmedOrderTax } from './tax';
import { WebhookMismatchError } from './webhook-errors';

// Orders after checkout: reading them, confirming their payment, recording provider refunds, and
// releasing a pending one with its reservations. Checkout itself is in checkout.ts, and the Stripe
// events that drive payment and refunds in stripe-events.ts.

/** The answer to a shopper who asks about, or tries to release, a checkout parked for review. */
export const PARKED_CHECKOUT_MESSAGE = 'The store is reviewing the payment for this checkout. Contact the store to release it.';

// Best effort: the provider's discount is single-use and expires with its checkout, so a
// failed delete is logged and never blocks releasing the order.
export async function discardCheckoutDiscount(adapter: PaymentProviderAdapter | undefined, orderId: string) {
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

export async function findOrder(ctx: CommerceContext, id: string) {
  const { db } = ctx;
  // Items are now stored natively as JSON on the order row
  const order = await db.select().from(schema.orders).where(eq(schema.orders.id, id)).get();
  if (!order) return null;

  return order;
}

export async function findOrderForSession(ctx: CommerceContext, id: string, sessionToken: string | undefined, customerId?: string) {
  const { db } = ctx;
  const order = await findOrder(ctx, id);
  if (!order?.cartId) return null;
  if (customerId && order.userId === customerId) return order;
  if (!sessionToken) return null;
  const cart = await db.select().from(schema.carts).where(eq(schema.carts.id, order.cartId)).get();
  return cart?.sessionToken === sessionToken ? order : null;
}

export async function createOrder(ctx: CommerceContext, data: {
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
  const { env, db } = ctx;
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

  return await findOrder(ctx, orderId);
}

/**
 * 'fulfilled' records a shipment that completes the order: it sets `fulfillmentStatus` and leaves
 * the payment `status` as it is. Payment statuses change only through payment and cancellation.
 */
export async function updateOrderStatus(ctx: CommerceContext, id: string, status: string, fulfillment?: {
  actor: string; carrier: string | null; trackingNumber: string | null; note: string;
}) {
  const { env } = ctx;
  if (status !== 'fulfilled') throw new Error('Use the payment or cancellation workflow to change order status');
  const order = await findOrder(ctx, id);
  if (order?.paymentProvider === 'admin_test') throw new Error('Admin test orders cannot be fulfilled');
  if (!fulfillment) throw new Error('Audited fulfillment details are required');
  await fulfillCommerceOrder(env, fulfillment.actor, { orderId: id,
    carrier: fulfillment.carrier, trackingNumber: fulfillment.trackingNumber,
    note: fulfillment.note });
  return await findOrder(ctx, id);
}

export async function finalizeOrderPayment(ctx: CommerceContext, params: {
  orderId: string;
  provider: string;
  providerId: string;
  paymentIntentId?: string;
  paymentStatus?: string;
  amount?: number;
  currency?: string;
  customerEmail?: string;
}) {
  const { env, db, adapters: paymentAdapters } = ctx;
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
export async function recordProviderRefund(ctx: CommerceContext, params: {
  paymentIntentId: string; amount: number; amountRefunded: number; currency: string;
  /** When the provider issued the refund, in unix seconds; the time it is recorded when unknown. */
  refundedAt?: number;
  /** The provider's id for the refund, when the event names it. */
  providerRefundId?: string | null;
}) {
  const { env, db } = ctx;
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

/**
 * Release a pending order, its reservations and its basket lock. The public release route passes
 * `limitProviderChecks`, so the provider is asked only when the order's provider-check slot is free;
 * otherwise it throws ProviderCheckLimitedError and changes nothing. An order parked for review is
 * released only with `reviewRelease`, an administrator's decision, or once its session expired. A
 * Stripe session of the other mode is never asked about, since this Worker's key cannot read it.
 */
export async function cancelOrder(ctx: CommerceContext, id: string, options: {
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
  const { env, db, adapters: paymentAdapters } = ctx;
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

  const cancelled = await findOrder(ctx, id);
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
