import { and, eq, lt, or } from 'drizzle-orm';
import { commerceContext, type CommerceApiOptions } from './commerce-context';
import * as schema from './schema';
import { reconcilePendingOrder, resumeCheckout } from './checkout';
import { deliverPendingCommerceEmails } from './commerce-emails';
import { reconcileGiftCardPurchase } from './gift-cards';
import { cancelOrder } from './orders';
import { RECONCILE_DUE, RECONCILE_ORDER, reconcileAttempt, reconcileFailure, type ReconcileResult } from './reconcile';
import { releaseReferralAwards } from './referrals';
import { recordMissingTaxTransactions, resendPendingTaxReversals, reverseUnreversedTax } from './tax';

// The scheduled reconciliation pass over checkouts, gift card purchases, tax records, referral awards
// and emails. The failure model and backoff it uses are in reconcile.ts, the administrator's retry and
// release of a parked record in reconcile-review.ts.

/** A time in Unix seconds as the schema's timestamp columns take it. */
const at = (seconds: number) => new Date(seconds * 1000);

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
  const ctx = commerceContext(options);
  const now = Math.floor(Date.now() / 1000);
  const { db } = ctx;
  // The queue selections below stay raw SQL: the tests pin their text and query plans, and the order
  // queries need their status literal for the partial index `_ecommerce_orders_pending_idx`. ';' follows ':', so the
  // range holds exactly the ids that start with 'preparing:', read from the unique index on
  // checkout_session_id. LIKE cannot use that index: it ignores case.
  const preparations = await env.DB.prepare(`SELECT id FROM _ecommerce_carts
    WHERE checkout_session_id >= 'preparing:' AND checkout_session_id < 'preparing;' AND updated_at < ?
    ORDER BY updated_at LIMIT ?`).bind(now - 35 * 60, count).all<{ id: string }>();
  // Without the simulated provider a stale admin_test order cannot be settled. It is released instead,
  // so it never keeps the admin's basket locked or crowds real orders out of this batch.
  const settlesAdminTest = options.paymentAdapters?.some(adapter => adapter.providerId === 'admin_test') ?? false;
  // Both order queries state `status = 'pending'` as a literal, which lets them use the partial index
  // `_ecommerce_orders_pending_idx`.
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
      await resumeCheckout(ctx, row.id);
      results.push({ id: row.id, status: 'preparation_checked' });
    } catch (error) {
      results.push({ id: row.id, status: 'error', error: error instanceof Error ? error.message : 'Recovery failed' });
    }
  }
  for (const row of pending.results ?? []) {
    results.push(await reconcileAttempt(env, 'order', row.id, now, () => reconcilePendingOrder(ctx, row.id)));
  }
  for (const row of abandonedTests.results ?? []) {
    try {
      const cancelled = await cancelOrder(ctx, row.id);
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
