import { eq, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb, runStatements } from './db';
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
function recordStatement(dispute: ProviderDispute, record: DisputedRecord, times: { closedAt: number | null; now: number }): SQL {
  const { column, table, statusBefore } = RECORDS[record.kind];
  return sql`INSERT INTO _ecommerce_disputes
    (id, provider, ${sql.raw(column)}, amount_cents, currency, reason, status, status_before, created_at, updated_at, closed_at)
    SELECT ${dispute.id}, 'stripe', r.id, ${dispute.amountCents}, ${dispute.currency ?? record.currency}, ${dispute.reason}, ${dispute.status},
      ${sql.raw(statusBefore)}, ${dispute.createdAt}, ${times.now}, ${times.closedAt}
    FROM ${sql.raw(table)} r WHERE r.id = ${record.id}
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, amount_cents = excluded.amount_cents,
      currency = excluded.currency, reason = COALESCE(excluded.reason, _ecommerce_disputes.reason),
      updated_at = excluded.updated_at, closed_at = COALESCE(_ecommerce_disputes.closed_at, excluded.closed_at)
    WHERE excluded.closed_at IS NOT NULL AND _ecommerce_disputes.status <> 'lost'`;
}

async function referralStatements(env: TalismanEnv, order: { id: string; referralCode: string | null },
  now: number, disputeLost = false) {
  if (!order.referralCode) return [];
  const policy = await getReferralPolicy(env);
  return referralReversalStatements(order.id, { minOrderCents: policy.minOrderCents, now, disputeLost });
}

type DisputedOrder = { id: string; currency: string; referralCode: string | null };

/** Runs an order's dispute statements in one batch and returns the order's status after them. */
async function orderBatch(env: TalismanEnv, orderId: string, statements: SQL[]) {
  const db = commerceDb(env);
  const items: BatchItem<'sqlite'>[] = [...statements.map((statement) => db.run(statement)),
    db.get<{ status: string }>(sql`SELECT status FROM _ecommerce_orders WHERE id = ${orderId}`)];
  const results = await db.batch(items as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  return (results[results.length - 1] as { status: string } | undefined)?.status ?? null;
}

/** A dispute holds a paid order as 'disputed', which the fulfillment guard refuses, until it closes. */
async function openOrderDispute(env: TalismanEnv, order: DisputedOrder, dispute: ProviderDispute, now: number) {
  return orderBatch(env, order.id, [
    recordStatement(dispute, { kind: 'order', id: order.id, currency: order.currency }, { closedAt: null, now }),
    sql`UPDATE _ecommerce_orders SET status = 'disputed', updated_at = ${now}
      WHERE id = ${order.id} AND status IN ('paid', 'fulfilled', 'partially_refunded')
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ${dispute.id} AND order_id = ${order.id} AND closed_at IS NULL)`,
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
async function settleLostOrderDispute(env: TalismanEnv, order: DisputedOrder, record: SQL,
  disputeId: string, now: number) {
  return orderBatch(env, order.id, [
    record,
    sql`UPDATE _ecommerce_orders SET status = 'refunded', updated_at = ${now}
      WHERE id = ${order.id} AND status IN ('paid', 'fulfilled', 'partially_refunded', 'disputed')
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ${disputeId} AND order_id = ${order.id} AND status = 'lost')`,
    sql`UPDATE _ecommerce_payments SET status = 'refunded'
      WHERE order_id = ${order.id} AND provider = 'stripe'
        AND EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ${order.id} AND status = 'refunded')`,
    ...fullRefundStatements(order.id, now),
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
  const record = recordStatement(dispute, { kind: 'order', id: order.id, currency: order.currency }, { closedAt, now });
  if (dispute.status === 'lost') return settleLostOrderDispute(env, order, record, dispute.id, now);
  return orderBatch(env, order.id, [
    record,
    sql`UPDATE _ecommerce_orders SET status = CASE
        WHEN total_amount > 0 AND provider_refunded_cents >= total_amount THEN 'refunded'
        WHEN provider_refunded_cents > 0 THEN 'partially_refunded'
        ELSE (SELECT status_before FROM _ecommerce_disputes WHERE id = ${dispute.id}) END,
      updated_at = ${now}
      WHERE id = ${order.id} AND status = 'disputed'
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ${dispute.id} AND order_id = ${order.id} AND status <> 'lost')
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE order_id = ${order.id} AND closed_at IS NULL)`,
    // The previous release copies the order's status onto its payment when it sees a refund, so a
    // rollback during the dispute can leave the payment 'disputed', which reports leave out.
    sql`UPDATE _ecommerce_payments SET status = CASE o.status
        WHEN 'refunded' THEN 'refunded' WHEN 'partially_refunded' THEN 'partially_refunded' ELSE 'success' END
      FROM _ecommerce_orders o
      WHERE _ecommerce_payments.order_id = o.id AND o.id = ${order.id} AND o.status <> 'disputed'
        AND _ecommerce_payments.provider = 'stripe' AND _ecommerce_payments.status = 'disputed'`,
    ...fullRefundStatements(order.id, now),
    ...await referralStatements(env, order, now),
  ]);
}

type DisputedPurchase = { id: string; currency: string };

/**
 * A dispute holds a gift card purchase for review, which suspends every card it funds, replacements
 * included, so their value cannot be spent while the dispute is open.
 */
async function openPurchaseDispute(env: TalismanEnv, purchase: DisputedPurchase, dispute: ProviderDispute, now: number) {
  await runStatements(commerceDb(env), [
    recordStatement(dispute, { kind: 'purchase', id: purchase.id, currency: purchase.currency }, { closedAt: null, now }),
    sql`UPDATE _ecommerce_gift_card_purchases SET status = 'review', updated_at = ${now}
      WHERE id = ${purchase.id} AND status IN ('paid', 'partially_refunded', 'refunded')
        AND EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE id = ${dispute.id} AND gift_card_purchase_id = ${purchase.id} AND closed_at IS NULL)`,
    ...giftCardPurchaseHoldStatements(purchase.id, now),
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
  const db = commerceDb(env);
  const record = recordStatement(dispute, { kind: 'purchase', id: purchase.id, currency: purchase.currency }, { closedAt, now });
  if (dispute.status === 'lost') {
    await runStatements(db, [
      record,
      // Held first, so nothing more is spent from the cards while a checkout in progress delays the void.
      sql`UPDATE _ecommerce_gift_card_purchases SET status = 'review', updated_at = ${now}
        WHERE id = ${purchase.id} AND status IN ('paid', 'partially_refunded', 'refunded')`,
      ...giftCardPurchaseHoldStatements(purchase.id, now),
      ...giftCardPurchaseChargebackStatements(purchase.id, now),
    ]);
    const current = await db.select({ status: giftCardPurchases.status }).from(giftCardPurchases)
      .where(eq(giftCardPurchases.id, purchase.id)).get();
    if (current?.status === 'review') {
      throw new WebhookRetryLaterError('A checkout in progress holds value on the disputed purchase\'s card; '
        + 'the lost dispute is applied once it completes or expires');
    }
    return;
  }
  await runStatements(db, [
    record,
    sql`UPDATE _ecommerce_gift_card_purchases SET status = CASE
        WHEN provider_refunded_cents > refund_adjusted_cents THEN 'review'
        WHEN d.status_before IN ('paid', 'partially_refunded', 'refunded') THEN d.status_before
        WHEN provider_refunded_cents >= amount_cents THEN 'refunded'
        WHEN provider_refunded_cents > 0 THEN 'partially_refunded'
        ELSE 'paid' END,
      updated_at = ${now}
      FROM (SELECT status_before FROM _ecommerce_disputes WHERE id = ${dispute.id} AND status <> 'lost') AS d
      WHERE id = ${purchase.id} AND status = 'review'
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_disputes WHERE gift_card_purchase_id = ${purchase.id} AND closed_at IS NULL)`,
    ...giftCardPurchaseReleaseStatements(purchase.id, now),
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
