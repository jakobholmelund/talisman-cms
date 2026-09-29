import { eq } from 'drizzle-orm';
import type { CommerceContext } from './commerce-context';
import * as schema from './schema';
import { applyStripeDispute, parseStripeDispute } from './disputes';
import { confirmGiftCardPurchase, expireGiftCardPurchase, recordGiftCardPurchaseRefund } from './gift-cards';
import { cancelOrder, discardCheckoutDiscount, finalizeOrderPayment, recordProviderRefund } from './orders';
import type { PaymentProviderAdapter, PaymentReferences, ValidatedWebhookEvent } from './payments';
import { reverseRefundedOrderTax } from './tax';
import { WebhookMismatchError, WebhookRetryLaterError, WebhookSignatureError } from './webhook-errors';

// Stripe webhooks: the verified events that confirm a checkout, expire it, record a refund or a
// dispute, applied to the store's orders and gift card purchases.

function ignoredEvent(event: ValidatedWebhookEvent) {
  console.info('[commerce] Stripe event ignored', { type: event.type, id: event.id });
  return { success: true, event: event.type, ignored: true };
}

/**
 * For an event whose payment matches no recorded payment: it is retried while the order or gift card
 * purchase its references name still waits for its payment, and ignored when they name nothing of
 * this store's or a released checkout. A record that was paid through another payment is a mismatch.
 */
async function assertNoAwaitedPayment(ctx: CommerceContext, references: PaymentReferences | null | undefined) {
  const { db } = ctx;
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

export async function applyStripeEvent(ctx: CommerceContext, event: ValidatedWebhookEvent, stripeAdapter: PaymentProviderAdapter) {
  const { env, db, adapters: paymentAdapters } = ctx;
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
    return finalizeOrderPayment(ctx, {
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
        const cancelled = await cancelOrder(ctx, orderId, { sessionExpired: true });
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
    const recorded = await recordProviderRefund(ctx, { ...refund, refundedAt: at,
      providerRefundId: typeof latest?.id === 'string' ? latest.id : null });
    if (recorded) {
      // The refund is mirrored in the order's tax. A failure is logged, and reconcileCommerce
      // reverses the tax later; the refund itself stays recorded.
      await reverseRefundedOrderTax(env, paymentAdapters, recorded.orderId);
      return recorded;
    }
    await assertNoAwaitedPayment(ctx, { orderId: text(charge.metadata?.orderId),
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
    await assertNoAwaitedPayment(ctx, await stripeAdapter.getPaymentReferences?.(dispute.paymentIntentId));
    return ignoredEvent(event);
  }

  return ignoredEvent(event);
}

/**
 * Verifies a Stripe webhook event and applies it. An event that names none of this store's orders
 * or gift card purchases is answered `{ ignored: true }` and changes nothing. One that names a
 * record it cannot be applied to, and that no retry would fix, is logged and answered the same
 * way with a `reason`. Throws WebhookSignatureError when the signature or payload is refused, and
 * WebhookRetryLaterError for an event about a record whose payment is not recorded yet.
 */
export async function handleStripeWebhook(ctx: CommerceContext, payload: string, signature: string, secret?: string) {
  const { adapters: paymentAdapters } = ctx;
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
    return await applyStripeEvent(ctx, event, stripeAdapter);
  } catch (error) {
    if (!(error instanceof WebhookMismatchError)) throw error;
    console.error('[commerce] Stripe event does not match the store records',
      { type: event.type, id: event.id, reason: error.reason });
    return { success: true, event: event.type, ignored: true, reason: error.reason };
  }
}
