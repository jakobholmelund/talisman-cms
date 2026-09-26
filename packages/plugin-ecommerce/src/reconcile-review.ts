import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import { bindCommerceApi, type CommerceApiOptions } from './api';
import { RECONCILE_FAILURE_MESSAGES, RECONCILE_TABLES, completedCheckoutReturn, decisionInsert, isMissingSessionError,
  isOtherStripeModeSession, isProviderError, reconcileFailure, uncheckedSessionRefusal, type PaymentReturn, type ReconcileDecision,
  type ReconcileFailureCode, type ReconcileKind } from './reconcile';
import { runtimeStripeMode, stripeSessionMode } from './stripe-mode';

/** Invalid input to a review action. The admin route answers it with 400. */
export class ReconcileInputError extends Error {
  override readonly name = 'ReconcileInputError';
}

/** Parked rows listed at most; `parkedCount` counts them all. */
const PARKED_LIST_LIMIT = 100;

const PROVIDER_UNREACHABLE = 'Stripe could not be asked about this checkout session, so nothing was released. Try again later.';

/** Both actions name one parked record and give a reason, which is kept with the administrator's id. */
const retrySchema = z.object({
  kind: z.enum(['order', 'gift_card_purchase']),
  id: z.string().trim().min(1).max(128),
  // Counted in characters, as the decision table's CHECK counts them; String.length counts UTF-16 units.
  reason: z.string().trim().refine((reason) => [...reason].length >= 8 && [...reason].length <= 500),
}).strict();

/**
 * A release may also confirm that a completed checkout's payment went back to the shopper. That
 * confirmation counts only where Stripe names no payment to check; otherwise Stripe's answer decides.
 */
const releaseSchema = retrySchema.extend({ confirmPaymentReturned: z.boolean().optional() }).strict();

function parseAction<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ReconcileInputError('Name the parked record (kind order or gift_card_purchase, and its id) '
      + 'and give a reason of 8 to 500 characters');
  }
  return parsed.data;
}

/** A new decision by `actor`, which the batch carrying it out records. */
function newDecision(actor: string, reason: string): ReconcileDecision {
  if (!actor.trim()) throw new Error('Administrator identity is required');
  return { id: `rcd_${crypto.randomUUID()}`, actor, reason };
}

/** SQL: the record is still pending and parked for review. */
const PARKED = `status = 'pending' AND reconcile_review_at IS NOT NULL`;
/** SQL: the decision bound to it was recorded in this batch. */
const RECORDED = 'EXISTS (SELECT 1 FROM _ecommerce_reconcile_decisions WHERE id = ?)';

const notParked = (kind: ReconcileKind) => kind === 'order'
  ? 'This order is not pending and parked for review; reload the list'
  : 'This gift card purchase is not pending and parked for review; reload the list';

const isoTime = (seconds: number) => new Date(seconds * 1000).toISOString();

type ParkedRow = {
  kind: ReconcileKind; id: string; created_at: number; attempts: number; last_at: number | null;
  last_error: string | null; review_at: number; session_id: string | null; provider: string;
  amount_cents: number; currency: string;
};

/**
 * Pending orders and gift card purchases parked for review, longest parked first: when each was
 * created, parked and last tried, its attempts and failure, and the Stripe mode of its checkout session
 * next to the store's. Session ids, email addresses and addresses are not listed; find a record in the
 * Stripe dashboard by its id.
 */
export async function listParkedCommerce(env: TalismanEnv) {
  const [listed, counted] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT 'order' AS kind, id, created_at, reconcile_attempts AS attempts,
        reconcile_last_at AS last_at, reconcile_last_error AS last_error, reconcile_review_at AS review_at,
        checkout_session_id AS session_id, COALESCE(payment_provider, 'stripe') AS provider,
        total_amount AS amount_cents, currency
      FROM _ecommerce_orders WHERE ${PARKED}
      UNION ALL
      SELECT 'gift_card_purchase', id, created_at, reconcile_attempts, reconcile_last_at, reconcile_last_error,
        reconcile_review_at, provider_session_id, 'stripe', amount_cents, currency
      FROM _ecommerce_gift_card_purchases WHERE ${PARKED}
      ORDER BY review_at, id LIMIT ?`).bind(PARKED_LIST_LIMIT),
    env.DB.prepare(`SELECT (SELECT COUNT(*) FROM _ecommerce_orders WHERE ${PARKED})
      + (SELECT COUNT(*) FROM _ecommerce_gift_card_purchases WHERE ${PARKED}) AS count`),
  ]);
  const storeMode = runtimeStripeMode(env);
  const rows = (listed.results ?? []) as ParkedRow[];
  return {
    storeMode,
    parkedCount: Number((counted.results?.[0] as { count?: number } | undefined)?.count ?? 0),
    parked: rows.map((row) => {
      const code = row.last_error && row.last_error in RECONCILE_FAILURE_MESSAGES
        ? row.last_error as ReconcileFailureCode : 'failed';
      const stripe = row.provider === 'stripe';
      return {
        kind: row.kind, id: row.id, createdAt: isoTime(row.created_at), parkedAt: isoTime(row.review_at),
        lastAttemptAt: row.last_at === null ? null : isoTime(row.last_at), attempts: row.attempts,
        lastError: code, problem: RECONCILE_FAILURE_MESSAGES[code], provider: row.provider,
        sessionMode: stripe ? stripeSessionMode(row.session_id) : null,
        otherMode: stripe && isOtherStripeModeSession(env, row.session_id),
        amountCents: row.amount_cents, currency: row.currency,
      };
    }),
  };
}

/**
 * Returns a parked row to reconciliation with its attempts reset: the next run checks it first. A
 * failure that is still permanent parks it again, and is reported again. The administrator's id and
 * reason are recorded in the same batch; neither happens without the other.
 */
export async function retryParkedCommerce(env: TalismanEnv, actor: string, input: unknown) {
  const { kind, id, reason } = parseAction(retrySchema, input);
  const decision = newDecision(actor, reason);
  const timestamp = Math.floor(Date.now() / 1000);
  const [, retried] = await env.DB.batch([
    env.DB.prepare(decisionInsert(kind, 'retry', PARKED))
      .bind(decision.id, null, decision.actor, decision.reason, timestamp, id),
    env.DB.prepare(`UPDATE ${RECONCILE_TABLES[kind]} SET reconcile_review_at = NULL,
        reconcile_attempts = 0, reconcile_last_at = NULL, reconcile_last_error = NULL
      WHERE id = ? AND ${PARKED} AND ${RECORDED} RETURNING id`).bind(id, decision.id),
  ]);
  if (!retried.results?.length) throw new Error(notParked(kind));
  // Who returned what, without personal data: the administrator's user id and the record's id.
  console.info('[commerce] Parked checkout returned to reconciliation', { kind, id, actor });
  return { kind, id, status: 'pending' };
}

/** The refusal an administrator sees when the provider stops a release; never the provider's own text. */
function releaseRefusal(error: unknown) {
  const failure = reconcileFailure(error);
  if (failure.code === 'provider_unavailable' || failure.code === 'provider_refused') {
    return new Error(PROVIDER_UNREACHABLE, { cause: error });
  }
  return isProviderError(error)
    ? new Error('Stripe returned an error about this checkout session, so nothing was released.', { cause: error }) : error;
}

/**
 * Releases a parked row: a pending order is cancelled, which returns its stock, credit, promotion and
 * gift card reservations and unlocks its basket; a gift card purchase is cancelled. The administrator's
 * id and reason are recorded in the batch that releases it.
 *
 * A Stripe session of the other mode is never looked up, since this Worker's key cannot read it: check
 * it in the Stripe dashboard first. Stripe must still be configured, since only a key that matches the
 * mode setting shows that the setting is right. Any other session is asked about: an open one is
 * expired, and one the provider no longer has counts as closed. A completed one is released only once
 * Stripe reports its payment refunded in full or lost to a dispute, or, where Stripe names no payment
 * to check, `confirmPaymentReturned` confirms it; the result names which (`paymentReturned`).
 */
export async function releaseParkedCommerce(options: CommerceApiOptions, actor: string, input: unknown) {
  const { kind, id, reason, confirmPaymentReturned = false } = parseAction(releaseSchema, input);
  const decision = newDecision(actor, reason);
  const { env } = options;
  const row = await env.DB.prepare(`SELECT ${kind === 'order' ? 'checkout_session_id' : 'provider_session_id'} AS session_id,
      created_at FROM ${RECONCILE_TABLES[kind]} WHERE id = ? AND ${PARKED}`).bind(id)
    .first<{ session_id: string | null; created_at: number }>();
  if (!row) throw new Error(notParked(kind));
  const otherMode = isOtherStripeModeSession(env, row.session_id);
  const recorded = () => env.DB.prepare('SELECT payment_returned FROM _ecommerce_reconcile_decisions WHERE id = ?')
    .bind(decision.id).first<{ payment_returned: PaymentReturn | null }>();
  let paymentReturned: PaymentReturn | null = null;
  if (kind === 'order') {
    try {
      await bindCommerceApi(options).orders.cancel(id, { reviewRelease: { decision, confirmPaymentReturned } });
    } catch (error) {
      throw releaseRefusal(error);
    }
    // Recorded only when this release cancelled the order; another outcome (paid, or cancelled by the
    // session's expiry meanwhile) changed it first.
    const decided = await recorded();
    if (!decided) throw new Error('The order changed while it was being released; reload the list');
    paymentReturned = decided.payment_returned;
  } else {
    if (row.session_id) {
      const stripe = options.paymentAdapters?.find((adapter) => adapter.providerId === 'stripe');
      if (!stripe?.getCheckoutSession || !stripe.expireCheckoutSession) {
        throw new Error('Stripe must be configured to check this checkout session before the purchase is released');
      }
      // A session this key cannot read or expire may still be paid; the release waits until it has expired.
      const refuseUnchecked = () => {
        const refusal = uncheckedSessionRefusal(row.created_at);
        if (refusal) throw refusal;
      };
      if (otherMode) refuseUnchecked();
      if (!otherMode) {
        try {
          let session: Awaited<ReturnType<NonNullable<typeof stripe.getCheckoutSession>>> | null = null;
          try {
            session = await stripe.getCheckoutSession(row.session_id);
          } catch (error) {
            if (!isMissingSessionError(error)) throw error;
            refuseUnchecked();
          }
          // A refund leaves the session complete and paid, so the payment itself is asked about.
          if (session?.status === 'complete') paymentReturned = await completedCheckoutReturn(stripe, session, confirmPaymentReturned);
          else if (session && session.status !== 'expired') await stripe.expireCheckoutSession(row.session_id);
        } catch (error) {
          throw releaseRefusal(error);
        }
      }
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const [, released] = await env.DB.batch([
      env.DB.prepare(decisionInsert(kind, 'release', PARKED))
        .bind(decision.id, paymentReturned, decision.actor, decision.reason, timestamp, id),
      env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = 'cancelled', updated_at = ?
        WHERE id = ? AND ${PARKED} AND ${RECORDED} RETURNING id`).bind(timestamp, id, decision.id),
    ]);
    if (!released.results?.length) throw new Error('The purchase changed while it was being released; reload the list');
  }
  // Who released what, without personal data: the administrator's user id and the record's id.
  console.info('[commerce] Parked checkout released', { kind, id, actor, otherMode });
  return { kind, id, status: 'cancelled', otherMode, paymentReturned };
}
