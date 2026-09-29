import { and, eq, exists, isNull, notInArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { CommerceContext } from './commerce-context';
import { commitBatch } from './db';
import * as schema from './schema';
import { PURCHASED_ORDER_STATUSES } from './accounts';
import { deliverCommerceEmail } from './commerce-emails';
import { canonicalEmail, canonicalEmailSql, canonicalEmails, canonicalPurchase } from './email-identity';
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

/** A time in Unix seconds as the schema's timestamp columns take it. */
const at = (seconds: number) => new Date(seconds * 1000);

/** SQL: the order `id` has the status `status`. */
const orderIn = (db: CommerceContext['db'], id: string, status: string) =>
  exists(db.select({ one: sql`1` }).from(schema.orders).where(and(eq(schema.orders.id, id), eq(schema.orders.status, status))));

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
  const paid = orderIn(db, params.orderId, 'paid');
  const paidBySession = exists(db.select({ one: sql`1` }).from(schema.orders).where(and(eq(schema.orders.id, params.orderId),
    eq(schema.orders.status, 'paid'), eq(schema.orders.checkoutSessionId, params.providerId))));
  const statements: BatchItem<'sqlite'>[] = [
    db.update(schema.orders).set({ status: 'paid', updatedAt: at(timestamp), customerEmail: email, paymentIntentId: params.paymentIntentId ?? null })
      .where(and(eq(schema.orders.id, params.orderId), eq(schema.orders.status, 'pending'),
        eq(schema.orders.checkoutSessionId, params.providerId), eq(schema.orders.totalAmount, order.totalAmount))),
  ];
  if (newAccountId) {
    statements.push(db.run(sql`INSERT INTO _ecommerce_customer_accounts
      (id, email, email_normalized, name, created_at, updated_at)
      SELECT ${newAccountId}, ${email}, ${normalizedEmail}, ${accountName}, ${timestamp}, ${timestamp} FROM _ecommerce_orders
      WHERE id = ${params.orderId} AND status = 'paid' AND checkout_session_id = ${params.providerId}
      ON CONFLICT(email_normalized) DO NOTHING`));
    const accountId = db.select({ id: schema.customerAccounts.id }).from(schema.customerAccounts)
      .where(eq(schema.customerAccounts.emailNormalized, normalizedEmail));
    statements.push(db.update(schema.orders).set({ userId: sql`(${accountId})` })
      .where(and(eq(schema.orders.id, params.orderId), eq(schema.orders.status, 'paid'), isNull(schema.orders.userId))));
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
      const purchased = sql.raw(PURCHASED_ORDER_STATUSES.map((status) => `'${status}'`).join(', '));
      statements.push(db.run(sql`INSERT INTO _ecommerce_referrals
        (id, code, referrer_account_id, referred_account_id, order_id, reward_cents, currency, status, created_at, updated_at)
        SELECT ${`ref_${order.id}`}, rc.code, rc.account_id, o.user_id, o.id, ${order.referralRewardCents}, o.currency, 'approved', ${timestamp}, ${timestamp}
        FROM _ecommerce_orders o
        JOIN _ecommerce_referral_codes rc ON rc.code = o.referral_code
        JOIN _ecommerce_customer_accounts referrer ON referrer.id = rc.account_id
        JOIN _ecommerce_customer_accounts buyer ON buyer.id = o.user_id
        WHERE o.id = ${params.orderId} AND o.status = 'paid' AND rc.account_id <> o.user_id
          AND referrer.email_normalized NOT IN (${normalizedEmail}, ${checkoutEmail}, buyer.email_normalized)
          AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders prior
            WHERE prior.id <> o.id AND prior.status IN (${purchased})
              AND COALESCE(prior.payment_provider, 'stripe') <> 'admin_test'
              AND (prior.user_id = o.user_id OR lower(prior.customer_email) IN (${normalizedEmail}, ${checkoutEmail}, buyer.email_normalized)
                OR prior.user_id IN (SELECT id FROM _ecommerce_customer_accounts WHERE email_normalized IN (${normalizedEmail}, ${checkoutEmail}))))
          AND NOT ${canonicalPurchase(buyerCanonicals, params.orderId)}
          AND (SELECT COUNT(*) FROM _ecommerce_referrals recent
            JOIN _ecommerce_customer_accounts recent_referrer ON recent_referrer.id = recent.referrer_account_id
            WHERE recent.status = 'approved' AND recent.created_at > ${timestamp - policy.periodDays * 24 * 60 * 60}
              AND (recent.referrer_account_id = rc.account_id
                OR ${sql.raw(canonicalEmailSql('recent_referrer.email_normalized'))} = ${referrerCanonical})) < ${policy.maxPerPeriod}
        ON CONFLICT DO NOTHING`));
    }
  }
  statements.push(
    db.update(schema.discountRedemptions).set({ status: 'confirmed', updatedAt: at(timestamp) })
      .where(and(eq(schema.discountRedemptions.orderId, params.orderId), eq(schema.discountRedemptions.status, 'reserved'), paid)),
    db.update(schema.giftCardRedemptions).set({ status: 'confirmed', updatedAt: at(timestamp) })
      .where(and(eq(schema.giftCardRedemptions.orderId, params.orderId), eq(schema.giftCardRedemptions.status, 'reserved'), paid)),
    db.run(sql`INSERT INTO _ecommerce_payments
      (id, order_id, provider, provider_id, status, amount, created_at)
      SELECT ${`pay_${crypto.randomUUID()}`}, id, ${params.provider}, ${params.providerId}, 'success', total_amount, ${timestamp} FROM _ecommerce_orders
      WHERE id = ${params.orderId} AND status = 'paid' AND checkout_session_id = ${params.providerId}
      ON CONFLICT(provider, provider_id) DO NOTHING`)
  );
  if (order.cartId) {
    // The basket closes with the payment and, for a guest checkout, takes the buyer's new account.
    const buyer = db.select({ userId: schema.orders.userId }).from(schema.orders).where(eq(schema.orders.id, params.orderId));
    statements.push(db.update(schema.carts)
      .set({ closed: true, closedAt: at(timestamp), updatedAt: at(timestamp), userId: sql`COALESCE(${schema.carts.userId}, (${buyer}))` })
      .where(and(eq(schema.carts.id, order.cartId), paidBySession)));
  }
  // One confirmation per paid real order, whichever path confirms the payment and however often.
  const confirms = params.provider !== 'admin_test';
  if (confirms) {
    statements.push(db.run(commerceEmailStatement('order_confirmation', params.orderId, timestamp,
      sql`EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ${params.orderId} AND status = 'paid' AND checkout_session_id = ${params.providerId}
        AND COALESCE(payment_provider, 'stripe') <> 'admin_test')`)));
  }
  await commitBatch(db, statements);
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
  const refundable = sql`id = ${order.id} AND payment_intent_id = ${params.paymentIntentId} AND provider_refunded_cents < ${params.amountRefunded}
    AND status IN ('paid', 'fulfilled', 'partially_refunded', 'disputed')`;
  const statements: BatchItem<'sqlite'>[] = [
    // First the part of the total that this event adds, read from the stored total under the guard
    // of the update below: a retried or out-of-order event adds no row, and the rows add up to the total.
    db.run(sql`INSERT INTO _ecommerce_provider_refunds
      (id, order_id, provider, provider_refund_id, amount_cents, created_at)
      SELECT ${`prf_${order.id}_${params.amountRefunded}`}, id, 'stripe', ${params.providerRefundId ?? null}, ${params.amountRefunded} - provider_refunded_cents, ${params.refundedAt ?? now}
      FROM _ecommerce_orders WHERE ${refundable}
      ON CONFLICT(id) DO NOTHING`),
    // A dispute keeps the order disputed; closing it applies the refund status.
    db.update(schema.orders).set({ providerRefundedCents: params.amountRefunded, updatedAt: at(now),
      status: sql`CASE WHEN ${schema.orders.status} = 'disputed' THEN ${schema.orders.status} ELSE ${full ? 'refunded' : 'partially_refunded'} END` })
      .where(refundable),
    // The payment shows the refund, taken from the amounts while the order is disputed.
    db.run(sql`UPDATE _ecommerce_payments
      SET status = COALESCE((SELECT CASE WHEN o.status IN ('partially_refunded', 'refunded') THEN o.status
          WHEN o.provider_refunded_cents >= o.total_amount THEN 'refunded'
          WHEN o.provider_refunded_cents > 0 THEN 'partially_refunded' END
        FROM _ecommerce_orders o WHERE o.id = ${order.id}), status)
      WHERE order_id = ${order.id} AND provider = 'stripe'`),
  ];
  if (full) statements.push(...fullRefundStatements(order.id, now).map((statement) => db.run(statement)));
  // A full refund, or a partial one that leaves less than the minimum paid, voids the referral and
  // reverses released awards.
  if (referralPolicy) {
    statements.push(...referralReversalStatements(order.id, { minOrderCents: referralPolicy.minOrderCents, now })
      .map((statement) => db.run(statement)));
  }
  await commitBatch(db, statements);
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
  const released = orderIn(db, id, 'cancelled');
  const statements: BatchItem<'sqlite'>[] = [
    db.update(schema.orders).set({ status: 'cancelled', updatedAt: at(timestamp) })
      .where(and(eq(schema.orders.id, id), notInArray(schema.orders.status, [...PURCHASED_ORDER_STATUSES]))),
    db.update(schema.discountRedemptions).set({ status: 'cancelled', updatedAt: at(timestamp) })
      .where(and(eq(schema.discountRedemptions.orderId, id), eq(schema.discountRedemptions.status, 'reserved'), released)),
    db.update(schema.giftCardRedemptions).set({ status: 'cancelled', updatedAt: at(timestamp) })
      .where(and(eq(schema.giftCardRedemptions.orderId, id), eq(schema.giftCardRedemptions.status, 'reserved'), released)),
  ];
  if (order.creditApplied > 0) {
    statements.push(db.run(sql`INSERT INTO _ecommerce_credit_ledger
      (id, account_id, order_id, kind, amount_cents, created_at)
      SELECT ${`credit_release_${id}`}, user_id, id, 'checkout_release', credit_applied, ${timestamp}
      FROM _ecommerce_orders WHERE id = ${id} AND status = 'cancelled' AND user_id IS NOT NULL
      ON CONFLICT(order_id, kind) DO NOTHING`));
  }
  // Like reservations, releases move the stock rows' updated_at, so a stale admin save is refused.
  for (const reservation of reservations) {
    statements.push(db.run(sql`UPDATE _ecommerce_components
      SET quantity = quantity + (SELECT quantity FROM _ecommerce_component_reservations
        WHERE id = ${reservation.id} AND released_at IS NULL), updated_at = MAX(updated_at + 1, ${timestamp})
      WHERE id = ${reservation.componentId} AND EXISTS (SELECT 1 FROM _ecommerce_component_reservations
        WHERE id = ${reservation.id} AND released_at IS NULL)
        AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ${id} AND status = 'cancelled')`));
    statements.push(db.update(schema.componentReservations).set({ releasedAt: at(timestamp) })
      .where(and(eq(schema.componentReservations.id, reservation.id), isNull(schema.componentReservations.releasedAt), released)));
  }
  for (const reservation of inventoryReservations) {
    const { table, quantity } = INVENTORY_COLUMNS[reservation.targetType];
    statements.push(db.run(sql`UPDATE ${table}
      SET ${sql.identifier(quantity.name)} = ${sql.identifier(quantity.name)} + (SELECT quantity FROM _ecommerce_inventory_reservations
        WHERE id = ${reservation.id} AND released_at IS NULL), updated_at = MAX(updated_at + 1, ${timestamp})
      WHERE id = ${reservation.targetId} AND EXISTS (SELECT 1 FROM _ecommerce_inventory_reservations
        WHERE id = ${reservation.id} AND released_at IS NULL)
        AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ${id} AND status = 'cancelled')`));
    statements.push(db.update(schema.inventoryReservations).set({ releasedAt: at(timestamp) })
      .where(and(eq(schema.inventoryReservations.id, reservation.id), isNull(schema.inventoryReservations.releasedAt), released)));
  }
  if (order.cartId) {
    statements.push(db.update(schema.carts).set({ checkoutSessionId: null, updatedAt: at(timestamp) })
      .where(and(eq(schema.carts.id, order.cartId), released)));
    statements.push(db.update(schema.orders).set({ cartId: null })
      .where(and(eq(schema.orders.id, id), eq(schema.orders.status, 'cancelled'))));
  }
  if (options.reviewRelease) {
    // The administrator's decision is kept with the release: this batch records it whenever it leaves
    // the order cancelled, and a failed record rolls the whole release back.
    const { decision } = options.reviewRelease;
    statements.push(db.run(decisionInsert('order', 'release', sql`status = 'cancelled'`,
      { id: decision.id, paymentReturned, actor: decision.actor, reason: decision.reason, at: timestamp, recordId: id })));
  }
  await commitBatch(db, statements);

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
