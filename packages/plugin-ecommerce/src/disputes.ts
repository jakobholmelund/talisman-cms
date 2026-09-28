import { eq } from 'drizzle-orm';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb } from './db';
import { giftCardPurchaseChargebackStatements, giftCardPurchaseHoldStatements,
  giftCardPurchaseReleaseStatements } from './gift-cards';
import { fullRefundStatements } from './order-adjustments';
import { getReferralPolicy, referralReversalStatements } from './referrals';
import { giftCardPurchases, orders } from './schema';
import { WebhookRetryLaterError } from './webhook-errors';

/** What the store records of a provider's dispute. Times are unix seconds. */
export type ProviderDispute = {
  id: string; paymentIntentId: string; amountCents: number; currency: string | null;
  reason: string | null; status: string; createdAt: number;
};

/**
 * The dispute in a Stripe `charge.dispute.*` event, or null when it names no dispute and payment.
 * `eventTime` stands in for a creation time the payload does not carry.
 */
export function parseStripeDispute(data: any, eventTime: number): ProviderDispute | null {
  const paymentIntentId = typeof data?.payment_intent === 'string' ? data.payment_intent : data?.payment_intent?.id;
  if (typeof data?.id !== 'string' || !data.id || typeof paymentIntentId !== 'string' || !paymentIntentId) return null;
  return {
    id: data.id.slice(0, 255),
    paymentIntentId,
    amountCents: Number.isSafeInteger(data.amount) && data.amount >= 0 ? data.amount : 0,
    currency: typeof data.currency === 'string' && data.currency ? data.currency.toLowerCase() : null,
    reason: typeof data.reason === 'string' && data.reason ? data.reason.slice(0, 100) : null,
    status: typeof data.status === 'string' && data.status ? data.status.slice(0, 100) : 'unknown',
    createdAt: Number.isSafeInteger(data.created) && data.created > 0 ? data.created : eventTime,
  };
}

/** An order or a gift card purchase, as its dispute records it. */
type DisputedRecord = { kind: 'order' | 'purchase'; id: string; currency: string };

// The status a dispute remembers: the record's own, or, while another dispute holds it, the one that
// dispute remembered, so a won dispute never restores the hold. An order is held as 'disputed'; a
// purchase as 'review', which a refund also uses, so a purchase in review without an open dispute
// remembers 'review'.
const openBefore = (column: string) => `(SELECT d.status_before FROM _ecommerce_disputes d
  WHERE d.${column} = r.id AND d.closed_at IS NULL ORDER BY d.created_at, d.id LIMIT 1)`;
const RECORDS = {
  order: { column: 'order_id', table: '_ecommerce_orders',
    statusBefore: `CASE WHEN r.status = 'disputed' THEN COALESCE(${openBefore('order_id')}, 'paid') ELSE r.status END` },
  purchase: { column: 'gift_card_purchase_id', table: '_ecommerce_gift_card_purchases',
    statusBefore: `COALESCE(CASE WHEN r.status = 'review' THEN ${openBefore('gift_card_purchase_id')} END, r.status)` },
} as const;

/**
 * Records a dispute, or the outcome of a closed one. An open event never changes a recorded dispute,
 * so one delivered after the close does not reopen it, and a lost dispute stays lost.
 */
function recordStatement(env: TalismanEnv, dispute: ProviderDispute, record: DisputedRecord,
  times: { closedAt: number | null; now: number }) {
  const { column, table, statusBefore } = RECORDS[record.kind];
  return env.DB.prepare(`INSERT INTO _ecommerce_disputes
    (id, provider, ${column}, amount_cents, currency, reason, status, status_before, created_at, updated_at, closed_at)
    SELECT ?, 'stripe', r.id, ?, ?, ?, ?, ${statusBefore}, ?, ?, ?
    FROM ${table} r WHERE r.id = ?
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, amount_cents = excluded.amount_cents,
      currency = excluded.currency, reason = COALESCE(excluded.reason, _ecommerce_disputes.reason),
      updated_at = excluded.updated_at, closed_at = COALESCE(_ecommerce_disputes.closed_at, excluded.closed_at)
    WHERE excluded.closed_at IS NOT NULL AND _ecommerce_disputes.status <> 'lost'`)
    .bind(dispute.id, dispute.amountCents, dispute.currency ?? record.currency, dispute.reason, dispute.status,
      dispute.createdAt, times.now, times.closedAt, record.id);
}

async function referralStatements(env: TalismanEnv, order: { id: string; referralCode: string | null },
  now: number, disputeLost = false) {
  if (!order.referralCode) return [];
  const policy = await getReferralPolicy(env);
  return referralReversalStatements(env, order.id, { minOrderCents: policy.minOrderCents, now, disputeLost });
}

type DisputedOrder = { id: string; currency: string; referralCode: string | null };

/** Runs an order's dispute statements in one batch and returns the order's status after them. */
async function orderBatch(env: TalismanEnv, orderId: string, statements: D1PreparedStatement[]) {
  const results = await env.DB.batch<{ status: string }>([...statements,
    env.DB.prepare(`SELECT status FROM _ecommerce_orders WHERE id = ?`).bind(orderId)]);
  return results[results.length - 1]?.results?.[0]?.status ?? null;
}

/** A dispute holds a paid order as 'disputed', which the fulfillment guard refuses, until it closes. */
async function openOrderDispute(env: TalismanEnv, order: DisputedOrder, dispute: ProviderDispute, now: number) {
  return orderBatch(env, order.id, [
    recordStatement(env, dispute, { kind: 'order', id: order.id, currency: order.currency }, { closedAt: null, now }),
    env.DB.prepare(`UPDATE _ecommerce_orders SET status = 'disputed', updated_at = ?
      WHERE id = ? AND status IN ('paid', 'fulfilled', 'partially_refunded')
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ? AND order_id = ? AND closed_at IS NULL)`)
      .bind(now, order.id, dispute.id, order.id),
  ]);
}

/**
 * Applies a lost dispute to its order. The payment was taken back, so the order is treated like a full
 * refund: it becomes 'refunded', its redemptions are refunded, the store credit it used goes back and
 * its referral is voided, with released awards reversed. A lost dispute is no provider refund, so
 * provider_refunded_cents and _ecommerce_provider_refunds stay as they are; reports count a refunded
 * order's whole sale as refunded. This is the only place a dispute refunds an order. It returns the
 * order's status, then 'refunded'; whatever else a refund triggers, such as a tax reversal, runs in
 * applyStripeEvent (api.ts), which holds the payment adapter and answers with that status.
 */
async function settleLostOrderDispute(env: TalismanEnv, order: DisputedOrder, record: D1PreparedStatement,
  disputeId: string, now: number) {
  return orderBatch(env, order.id, [
    record,
    env.DB.prepare(`UPDATE _ecommerce_orders SET status = 'refunded', updated_at = ?
      WHERE id = ? AND status IN ('paid', 'fulfilled', 'partially_refunded', 'disputed')
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ? AND order_id = ? AND status = 'lost')`)
      .bind(now, order.id, disputeId, order.id),
    env.DB.prepare(`UPDATE _ecommerce_payments SET status = 'refunded'
      WHERE order_id = ? AND provider = 'stripe'
        AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'refunded')`)
      .bind(order.id, order.id),
    ...fullRefundStatements(env, order.id, now),
    ...await referralStatements(env, order, now, true),
  ]);
}

/**
 * Closes an order's dispute and returns the order's status after it. Lost: see settleLostOrderDispute.
 * Any other outcome (won, an inquiry closed, a dispute prevented) gives the order back the status it
 * had before the dispute once no other dispute of it is open, unless refunds recorded during the
 * dispute changed that: then it is partially refunded, or refunded with a full refund's effects.
 */
async function closeOrderDispute(env: TalismanEnv, order: DisputedOrder, dispute: ProviderDispute,
  closedAt: number, now: number) {
  const record = recordStatement(env, dispute, { kind: 'order', id: order.id, currency: order.currency },
    { closedAt, now });
  if (dispute.status === 'lost') return settleLostOrderDispute(env, order, record, dispute.id, now);
  return orderBatch(env, order.id, [
    record,
    env.DB.prepare(`UPDATE _ecommerce_orders SET status = CASE
        WHEN total_amount > 0 AND provider_refunded_cents >= total_amount THEN 'refunded'
        WHEN provider_refunded_cents > 0 THEN 'partially_refunded'
        ELSE (SELECT status_before FROM _ecommerce_disputes WHERE id = ?) END,
      updated_at = ?
      WHERE id = ? AND status = 'disputed'
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ? AND order_id = ? AND status <> 'lost')
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE order_id = ? AND closed_at IS NULL)`)
      .bind(dispute.id, now, order.id, dispute.id, order.id, order.id),
    // The previous release copies the order's status onto its payment when it sees a refund, so a
    // rollback during the dispute can leave the payment 'disputed', which reports leave out.
    env.DB.prepare(`UPDATE _ecommerce_payments SET status = CASE o.status
        WHEN 'refunded' THEN 'refunded' WHEN 'partially_refunded' THEN 'partially_refunded' ELSE 'success' END
      FROM _ecommerce_orders o
      WHERE _ecommerce_payments.order_id = o.id AND o.id = ? AND o.status <> 'disputed'
        AND _ecommerce_payments.provider = 'stripe' AND _ecommerce_payments.status = 'disputed'`)
      .bind(order.id),
    ...fullRefundStatements(env, order.id, now),
    ...await referralStatements(env, order, now),
  ]);
}

type DisputedPurchase = { id: string; currency: string };

/**
 * A dispute holds a gift card purchase for review, which suspends every card it funds, replacements
 * included, so their value cannot be spent while the dispute is open.
 */
async function openPurchaseDispute(env: TalismanEnv, purchase: DisputedPurchase, dispute: ProviderDispute, now: number) {
  await env.DB.batch([
    recordStatement(env, dispute, { kind: 'purchase', id: purchase.id, currency: purchase.currency },
      { closedAt: null, now }),
    env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = 'review', updated_at = ?
      WHERE id = ? AND status IN ('paid', 'partially_refunded', 'refunded')
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ? AND gift_card_purchase_id = ? AND closed_at IS NULL)`)
      .bind(now, purchase.id, dispute.id, purchase.id),
    ...giftCardPurchaseHoldStatements(env, purchase.id, now),
  ]);
}

/**
 * Closes a gift card purchase's dispute. Any outcome but lost ends the hold once no other dispute of it
 * is open: the purchase gets its status back and the cards the hold suspended become active again,
 * unless a refund recorded during the dispute still waits for an administrator's review. A lost
 * dispute took the payment back, so the purchase's cards are voided and what is left on them reversed,
 * and the purchase counts as refunded. Value already spent on orders stays spent. Voiding waits while a
 * checkout in progress holds value on the cards (the event is retried), like the review 'void' outcome.
 */
async function closePurchaseDispute(env: TalismanEnv, purchase: DisputedPurchase, dispute: ProviderDispute,
  closedAt: number, now: number) {
  const record = recordStatement(env, dispute, { kind: 'purchase', id: purchase.id, currency: purchase.currency },
    { closedAt, now });
  if (dispute.status === 'lost') {
    await env.DB.batch([
      record,
      // Held first, so nothing more is spent from the cards while a checkout in progress delays the void.
      env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = 'review', updated_at = ?
        WHERE id = ? AND status IN ('paid', 'partially_refunded', 'refunded')`)
        .bind(now, purchase.id),
      ...giftCardPurchaseHoldStatements(env, purchase.id, now),
      ...giftCardPurchaseChargebackStatements(env, purchase.id, now),
    ]);
    const current = await commerceDb(env).select({ status: giftCardPurchases.status }).from(giftCardPurchases)
      .where(eq(giftCardPurchases.id, purchase.id)).get();
    if (current?.status === 'review') {
      throw new WebhookRetryLaterError('A checkout in progress holds value on the disputed purchase\'s card; '
        + 'the lost dispute is applied once it completes or expires');
    }
    return;
  }
  await env.DB.batch([
    record,
    env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = CASE
        WHEN provider_refunded_cents > refund_adjusted_cents THEN 'review'
        WHEN d.status_before IN ('paid', 'partially_refunded', 'refunded') THEN d.status_before
        WHEN provider_refunded_cents >= amount_cents THEN 'refunded'
        WHEN provider_refunded_cents > 0 THEN 'partially_refunded'
        ELSE 'paid' END,
      updated_at = ?
      FROM (SELECT status_before FROM _ecommerce_disputes WHERE id = ? AND status <> 'lost') AS d
      WHERE id = ? AND status = 'review'
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE gift_card_purchase_id = ? AND closed_at IS NULL)`)
      .bind(now, dispute.id, purchase.id, purchase.id),
    ...giftCardPurchaseReleaseStatements(env, purchase.id, now),
  ]);
}

/**
 * Applies a Stripe `charge.dispute.created` (`closed: false`) or `charge.dispute.closed` event to the
 * order or gift card purchase paid with the disputed payment. Returns which one, with an order's
 * status after the event, or null when no recorded payment matches. `at` is the event's time.
 */
export async function applyStripeDispute(env: TalismanEnv, dispute: ProviderDispute,
  options: { closed: boolean; at: number; now?: number }) {
  const db = commerceDb(env);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const order = await db.select({ id: orders.id, currency: orders.currency, referralCode: orders.referralCode })
    .from(orders).where(eq(orders.paymentIntentId, dispute.paymentIntentId)).get();
  if (order) {
    const status = options.closed ? await closeOrderDispute(env, order, dispute, options.at, now)
      : await openOrderDispute(env, order, dispute, now);
    return { orderId: order.id, status };
  }
  const purchase = await db.select({ id: giftCardPurchases.id, currency: giftCardPurchases.currency })
    .from(giftCardPurchases).where(eq(giftCardPurchases.paymentIntentId, dispute.paymentIntentId)).get();
  if (purchase) {
    if (options.closed) await closePurchaseDispute(env, purchase, dispute, options.at, now);
    else await openPurchaseDispute(env, purchase, dispute, now);
    return { purchaseId: purchase.id };
  }
  return null;
}
