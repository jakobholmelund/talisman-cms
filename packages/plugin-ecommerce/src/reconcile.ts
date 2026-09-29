import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb, type CommerceDb } from './db';
import type { PaymentProviderAdapter } from './payments';
import { giftCardPurchases, orders } from './schema';
import { runtimeStripeMode, stripeSessionMode } from './stripe-mode';

/** A time in Unix seconds as the schema's timestamp columns take it. */
const at = (seconds: number) => new Date(seconds * 1000);

/** Why a reconciliation attempt failed. Only these codes are stored, never provider text or personal data. */
export type ReconcileFailureCode = 'session_missing' | 'session_mode_mismatch' | 'payment_mismatch'
  | 'provider_not_configured' | 'provider_unavailable' | 'provider_refused' | 'failed';

/** Failures that another attempt cannot change. They park the row for an administrator instead. */
const PERMANENT_FAILURES: ReadonlySet<ReconcileFailureCode> =
  new Set(['session_missing', 'session_mode_mismatch', 'payment_mismatch']);

/** An admin-safe explanation of each code, for results and the review list. */
export const RECONCILE_FAILURE_MESSAGES: Record<ReconcileFailureCode, string> = {
  session_missing: 'The payment provider has no checkout session with this id',
  session_mode_mismatch: 'The checkout session belongs to the other Stripe mode',
  payment_mismatch: 'The completed payment does not match the amount, currency or payment recorded for it',
  provider_not_configured: 'No configured payment provider can check this checkout session',
  provider_unavailable: 'The payment provider could not be reached; the check is retried later',
  provider_refused: "The payment provider refused the store's credentials; check the payment settings",
  failed: 'Reconciliation failed',
};

/** A reconciliation attempt that failed for a known reason. A permanent one parks the row. */
export class ReconcileFailure extends Error {
  override readonly name = 'ReconcileFailure';
  readonly code: ReconcileFailureCode;

  constructor(code: ReconcileFailureCode, message = RECONCILE_FAILURE_MESSAGES[code], options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }

  get permanent() {
    return PERMANENT_FAILURES.has(this.code);
  }
}

/** A payment provider error, read by its shape so that this module never loads the Stripe SDK. */
type ProviderError = { type?: unknown; code?: unknown; statusCode?: unknown } | null | undefined;

/**
 * Whether the payment provider answered that it has no such object for the store's key. Only the answer
 * to a checkout session lookup means the session is missing.
 */
export function isMissingSessionError(error: unknown) {
  const details = error as ProviderError;
  return details?.code === 'resource_missing' || details?.statusCode === 404;
}

/**
 * The failure of a checkout session lookup: a session the provider does not have is permanent, and any
 * other error is classified by reconcileFailure. Only the lookup's own error comes through here, so a
 * 404 from a later provider call in the same attempt backs off instead of parking the row.
 */
export function sessionLookupFailure(error: unknown) {
  return isMissingSessionError(error) ? new ReconcileFailure('session_missing', undefined, { cause: error }) : error;
}

/** Whether an error came from the payment provider's API. Its text is never put in results. */
export function isProviderError(error: unknown) {
  const details = error as ProviderError;
  return (typeof details?.type === 'string' && details.type.startsWith('Stripe')) || typeof details?.statusCode === 'number';
}

/**
 * The message of a failure that is not the provider's, for results. A failed Drizzle query puts its
 * parameters, which can hold personal data, in its message, so its cause's message is used instead.
 */
function failureMessage(error: unknown) {
  if (!(error instanceof Error) || !error.message) return undefined;
  if (typeof (error as { query?: unknown }).query === 'string' && 'params' in error) {
    return error.cause instanceof Error && error.cause.message ? error.cause.message : 'A database query failed';
  }
  return error.message;
}

/**
 * Classifies a failed attempt. Permanent failures arrive as a ReconcileFailure already (a missing session
 * through sessionLookupFailure). Network errors, provider outages, rate limits and refused credentials
 * are transient, and so is anything else. The provider's own text is never reported; the message of any
 * other error is kept for the result without query parameters, and only the code is stored.
 */
export function reconcileFailure(error: unknown): ReconcileFailure {
  if (error instanceof ReconcileFailure) return error;
  const details = error as ProviderError;
  const status = typeof details?.statusCode === 'number' ? details.statusCode : 0;
  const type = typeof details?.type === 'string' ? details.type : '';
  if (status === 401 || status === 403 || type === 'StripeAuthenticationError' || type === 'StripePermissionError') {
    return new ReconcileFailure('provider_refused', undefined, { cause: error });
  }
  if (status === 429 || status >= 500 || type === 'StripeConnectionError' || type === 'StripeAPIError' ||
      type === 'StripeRateLimitError') {
    return new ReconcileFailure('provider_unavailable', undefined, { cause: error });
  }
  if (isProviderError(error)) return new ReconcileFailure('failed', 'The payment provider returned an error', { cause: error });
  return new ReconcileFailure('failed', failureMessage(error), { cause: error });
}

/** Whether a Stripe checkout session belongs to the other mode than the store's, whose key cannot read it. */
export function isOtherStripeModeSession(env: object, sessionId: string | null | undefined) {
  const mode = stripeSessionMode(sessionId);
  return mode !== null && mode !== runtimeStripeMode(env);
}

/** Refuses a Stripe checkout session of the other mode before the provider is asked about it. */
export function assertStoreStripeMode(env: object, sessionId: string | null | undefined) {
  if (!isOtherStripeModeSession(env, sessionId)) return;
  throw new ReconcileFailure('session_mode_mismatch', `The checkout session is from Stripe ${stripeSessionMode(sessionId)} mode, `
    + `and the store runs in ${runtimeStripeMode(env)} mode`);
}

export type ReconcileKind = 'order' | 'gift_card_purchase';

/** The two tables reconciliation works on. Both carry the `reconcile_*` columns of the schema's `reconcileColumns()`. */
export type ReconcileTable = typeof orders | typeof giftCardPurchases;

export const RECONCILE_TABLES: Record<ReconcileKind, ReconcileTable> = {
  order: orders,
  gift_card_purchase: giftCardPurchases,
};

/**
 * An administrator's retry or release of a parked record: who decided and why. It is kept in
 * _ecommerce_reconcile_decisions, in the batch that carries the decision out, under `id`.
 */
export type ReconcileDecision = { id: string; actor: string; reason: string };

/**
 * How an administrator's release of a completed checkout established that its payment went back to the
 * shopper: Stripe reported it refunded in full, or lost to a dispute, or, where Stripe named no payment
 * to check, the administrator confirmed it.
 */
export type PaymentReturn = 'refunded' | 'dispute_lost' | 'confirmed';

/** Why a release of a completed checkout changed nothing: Stripe reports that the store kept the payment. */
export const PAID_SESSION_REFUSAL = 'Stripe reports this checkout session as paid, and its payment as neither refunded in full '
  + 'nor lost to a dispute, so nothing was released. Refund the payment in full in Stripe first, or retry once the cause '
  + 'of the mismatch is fixed.';

/** Why a release of a completed checkout that Stripe names no payment for changed nothing. */
export const UNCHECKED_PAYMENT_REFUSAL = 'Stripe reports this checkout session as complete but names no payment the store '
  + 'can check for a refund, so nothing was released. If the payment was returned to the shopper, confirm that and '
  + 'release it again.';

/**
 * Establishes, before an administrator releases a completed checkout, that its payment went back to the
 * shopper, so the store never cancels a checkout whose money it kept. A refund leaves the session itself
 * complete and paid, so the payment is asked about: refunded in full, or lost to a dispute. Only when
 * the provider names no payment to check does the administrator's confirmation stand in for that. Anything
 * else throws a refusal, and nothing is released.
 */
export async function completedCheckoutReturn(adapter: Pick<PaymentProviderAdapter, 'getRefundStatus' | 'getDisputeStatus'>,
  session: { paymentIntentId?: string | null }, confirmed = false): Promise<PaymentReturn> {
  const paymentIntentId = session.paymentIntentId;
  if (paymentIntentId && adapter.getRefundStatus) {
    if (await adapter.getRefundStatus(paymentIntentId) === 'full') return 'refunded';
    if (await adapter.getDisputeStatus?.(paymentIntentId) === 'lost') return 'dispute_lost';
    throw new Error(PAID_SESSION_REFUSAL);
  }
  if (confirmed) return 'confirmed';
  throw new Error(UNCHECKED_PAYMENT_REFUSAL);
}

/**
 * The statement that records an administrator's `action` on the order or gift card purchase
 * `decision.recordId` while `condition` holds for it, with the failure it was parked with and, for a
 * release of a completed checkout, how the payment's return was established.
 */
export function decisionInsert(kind: ReconcileKind, action: 'retry' | 'release', condition: SQL, decision: {
  id: string; paymentReturned: PaymentReturn | null; actor: string; reason: string; at: number; recordId: string;
}): SQL {
  const [orderId, purchaseId] = kind === 'order' ? ['id', 'NULL'] : ['NULL', 'id'];
  return sql`INSERT INTO _ecommerce_reconcile_decisions
      (id, order_id, purchase_id, action, failure, payment_returned, admin_actor, reason, created_at)
    SELECT ${decision.id}, ${sql.raw(orderId)}, ${sql.raw(purchaseId)}, ${action}, reconcile_last_error, ${decision.paymentReturned},
      ${decision.actor}, ${decision.reason}, ${decision.at}
    FROM ${RECONCILE_TABLES[kind]} WHERE id = ${decision.recordId} AND ${condition}`;
}

/** The longest wait between two attempts on one row. */
export const RECONCILE_MAX_BACKOFF_SECONDS = 6 * 60 * 60;

/**
 * A checkout session Stripe cannot be asked about, of the other mode or one Stripe no longer has, may
 * still be paid until it expires 31 minutes after the checkout started. A release of such a record
 * waits that long, with the margin the stale checkout lock uses; returns the refusal while it waits.
 */
export function uncheckedSessionRefusal(checkoutStartedAt: number, now = Math.floor(Date.now() / 1000)) {
  const releasable = checkoutStartedAt + 35 * 60;
  if (now >= releasable) return null;
  return new Error('Stripe cannot be asked about this checkout session, which may still be paid until it expires. '
    + `Release it after ${new Date(releasable * 1000).toISOString()}, 35 minutes after the checkout started.`);
}

/** The columns a backoff reads: how many attempts a row had and when the last one ran, and what orders rows never tried. */
export type BackoffColumns = { attempts: AnySQLiteColumn; lastAt: AnySQLiteColumn; createdAt: AnySQLiteColumn; id: AnySQLiteColumn };

/**
 * The backoff of rows that count their attempts in `columns.attempts` and date the last one in
 * `columns.lastAt`, for a query's `where` and `orderBy`. `due`: the row is due at `now`; after an
 * attempt it waits 2^attempts minutes, at most six hours. The shift is capped: from 58 places on it
 * overflows to a negative number or 0, and the row would never wait. `order`: rows never tried first,
 * then those tried longest ago, then the oldest.
 */
export function backoff(columns: BackoffColumns, now: number) {
  return {
    due: sql`(${columns.lastAt} IS NULL
      OR ${columns.lastAt} <= ${now} - MIN(${sql.raw(String(RECONCILE_MAX_BACKOFF_SECONDS))}, 60 << MIN(${columns.attempts}, 9)))`,
    order: [sql`COALESCE(${columns.lastAt}, 0)`, columns.createdAt, columns.id] as const,
  };
}

/** The backoff of a pending order's or gift card purchase's reconciliation, on its `reconcile_*` columns. */
export const reconcileBackoff = (table: ReconcileTable, now: number) => backoff({ attempts: table.reconcileAttempts,
  lastAt: table.reconcileLastAt, createdAt: table.createdAt, id: table.id }, now);

/** A reconciliation result as the scheduled Worker reads it: only `status: 'error'` is a failure. */
export type ReconcileResult = {
  id: string; status: string; error?: string; code?: ReconcileFailureCode;
  /** Set on the one result of the attempt that parked the row for review. */
  parked?: true;
};

/**
 * Records an attempt on a row that was pending and not parked when the run selected it: one more attempt
 * at `now`, with the failure's code or, after a success, none. A permanent failure also parks the row.
 * Nothing is recorded on a row that an overlapping run parked in the meantime, so a late outcome never
 * rewrites why it was parked, nor is a row that left 'pending' parked; such an attempt is 'skipped'.
 */
async function recordAttempt(db: CommerceDb, kind: ReconcileKind, id: string, now: number,
  failure: ReconcileFailure | null): Promise<'recorded' | 'parked' | 'skipped'> {
  const table = RECONCILE_TABLES[kind];
  const attempt = { reconcileAttempts: sql`${table.reconcileAttempts} + 1`, reconcileLastAt: at(now),
    reconcileLastError: failure?.code ?? null };
  if (failure?.permanent) {
    // Only a row that is still pending and not parked yet is parked, so each is parked, and reported, once.
    const parked = await db.update(table).set({ ...attempt, reconcileReviewAt: at(now) })
      .where(and(eq(table.id, id), eq(table.status, 'pending'), isNull(table.reconcileReviewAt))).returning({ id: table.id });
    return parked.length ? 'parked' : 'skipped';
  }
  const recorded = await db.update(table).set(attempt)
    .where(and(eq(table.id, id), isNull(table.reconcileReviewAt))).returning({ id: table.id });
  return recorded.length ? 'recorded' : 'skipped';
}

/**
 * Runs one attempt on a pending order or gift card purchase and records it. The result is the row's
 * status afterwards, or `error` with an admin-safe message and a code; the attempt that parks the row
 * adds `parked: true`. A parked row is not selected again, so it is reported once. When an overlapping
 * run parked the row, or it left 'pending', while this attempt failed, this attempt reports no error:
 * the row's status is returned, and the run that parked it reports it.
 */
export async function reconcileAttempt(env: TalismanEnv, kind: ReconcileKind, id: string, now: number,
  attempt: () => Promise<{ status: string } | null>): Promise<ReconcileResult> {
  let result: ReconcileResult;
  let failure: ReconcileFailure | null = null;
  try {
    result = { id, status: (await attempt())?.status ?? 'unchanged' };
  } catch (error) {
    failure = reconcileFailure(error);
    result = { id, status: 'error', error: failure.message, code: failure.code };
  }
  try {
    const db = commerceDb(env);
    const recorded = await recordAttempt(db, kind, id, now, failure);
    if (recorded === 'parked') result.parked = true;
    if (recorded === 'skipped' && failure) {
      const table = RECONCILE_TABLES[kind];
      const row = await db.select({ status: table.status }).from(table).where(eq(table.id, id)).get();
      return { id, status: row?.status ?? 'unchanged' };
    }
  } catch {
    return { id, status: 'error', error: 'The reconciliation attempt could not be recorded', code: failure?.code ?? 'failed' };
  }
  return result;
}
