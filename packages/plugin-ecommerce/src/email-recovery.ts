import { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb, commitBatch } from './db';
import { adminActorNames } from './admin-actors';
import { emailDeliveries, emailRecoveryDecisions } from './schema';

export class CommerceOperationsConflict extends Error {
  override readonly name = 'CommerceOperationsConflict';
}

/** Real order emails; gift card claims have their own recovery tool. Correlated column names must
 * stay qualified: the select builder unqualifies column objects in its fields. */
export const recoverableEmailSubject = sql`(
  (_ecommerce_email_deliveries.kind = 'order_confirmation' AND EXISTS (
    SELECT 1 FROM _ecommerce_orders o WHERE o.id = _ecommerce_email_deliveries.subject_id
      AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'
      AND o.status IN ('paid', 'fulfilled', 'partially_refunded', 'disputed')))
  OR (_ecommerce_email_deliveries.kind IN ('recovery_shipment','recovery_tracking','recovery_received') AND EXISTS(SELECT 1 FROM _ecommerce_recovery_shipments s JOIN _ecommerce_recovery_cases c ON c.id=s.case_id JOIN _ecommerce_orders o ON o.id=c.order_id WHERE s.redacted_at IS NULL AND c.redacted_at IS NULL AND o.customer_email IS NOT NULL AND (s.id=_ecommerce_email_deliveries.subject_id OR EXISTS(SELECT 1 FROM _ecommerce_recovery_events e WHERE e.id=_ecommerce_email_deliveries.subject_id AND e.shipment_id=s.id AND e.kind='tracking' AND e.rowid=(SELECT max(rowid) FROM _ecommerce_recovery_events WHERE shipment_id=s.id AND kind='tracking')) OR EXISTS(SELECT 1 FROM _ecommerce_recovery_receipts r WHERE r.id=_ecommerce_email_deliveries.subject_id AND r.shipment_id=s.id AND r.redacted_at IS NULL))))
  OR (_ecommerce_email_deliveries.kind='return_refund' AND EXISTS(SELECT 1 FROM _ecommerce_return_refund_decisions d JOIN _ecommerce_return_receipts r ON r.id=d.receipt_id JOIN _ecommerce_orders o ON o.id=r.order_id WHERE d.id=_ecommerce_email_deliveries.subject_id AND d.status='settled' AND d.redacted_at IS NULL AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND o.customer_email IS NOT NULL AND NOT EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a WHERE a.account_id=o.user_id AND a.action='anonymize')))
  OR (_ecommerce_email_deliveries.kind='return_received' AND EXISTS(SELECT 1 FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE r.id=_ecommerce_email_deliveries.subject_id AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND o.customer_email IS NOT NULL))
  OR (_ecommerce_email_deliveries.kind='return_decision' AND EXISTS(SELECT 1 FROM _ecommerce_return_request_events e JOIN _ecommerce_return_requests r ON r.id=e.request_id JOIN _ecommerce_orders o ON o.id=r.order_id WHERE e.id=_ecommerce_email_deliveries.subject_id AND e.actor_kind='staff' AND e.redacted_at IS NULL AND r.redacted_at IS NULL AND e.rowid=(SELECT rowid FROM _ecommerce_return_request_events WHERE request_id=r.id ORDER BY rowid DESC LIMIT 1) AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND o.customer_email IS NOT NULL))
  OR (_ecommerce_email_deliveries.kind IN ('shipment', 'shipment_update') AND EXISTS (
    SELECT 1 FROM _ecommerce_fulfillments f JOIN _ecommerce_orders o ON o.id = f.order_id
      WHERE f.id = _ecommerce_email_deliveries.subject_id AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'
      AND ((_ecommerce_email_deliveries.kind = 'shipment' AND f.kind = 'shipment')
        OR (_ecommerce_email_deliveries.kind = 'shipment_update' AND f.kind = 'correction')))))`;

const pageSchema = z.object({ offset: z.coerce.number().int().min(0).max(1000000).default(0) });
export async function listEmailRecovery(env: TalismanEnv, input: unknown = {}) {
  const { offset } = pageSchema.parse(input);
  const db = commerceDb(env);
  const attention = sql`${emailDeliveries.status} = 'failed' OR (${emailDeliveries.status} = 'pending' AND ${emailDeliveries.lastError} IS NOT NULL)`;
  const [rows, counted, history] = await db.batch([
    db.select({ id: emailDeliveries.id, kind: emailDeliveries.kind, subjectId: emailDeliveries.subjectId,
      status: emailDeliveries.status, attempts: emailDeliveries.attempts, lastError: emailDeliveries.lastError,
      nextAttemptAt: emailDeliveries.nextAttemptAt, claimedAt: emailDeliveries.claimedAt,
      retryRequestId: emailDeliveries.retryRequestId, createdAt: emailDeliveries.createdAt,
      eligible: sql<boolean>`CASE WHEN ${recoverableEmailSubject} THEN 1 ELSE 0 END`.mapWith(Boolean) })
      .from(emailDeliveries).where(attention).orderBy(emailDeliveries.createdAt, emailDeliveries.id).limit(50).offset(offset),
    db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(emailDeliveries).where(attention),
    db.select({ id: emailRecoveryDecisions.id, emailId: emailRecoveryDecisions.emailId, actor: emailRecoveryDecisions.actor,
      reason: emailRecoveryDecisions.reason, priorAttempts: emailRecoveryDecisions.priorAttempts,
      priorError: emailRecoveryDecisions.priorError, createdAt: emailRecoveryDecisions.createdAt })
      .from(emailRecoveryDecisions).orderBy(desc(emailRecoveryDecisions.createdAt), desc(emailRecoveryDecisions.id)).limit(50),
  ]);
  const names = await adminActorNames(env, history.map(row => row.actor));
  return { rows: rows.map(row => ({ ...row, retryable: row.status === 'failed' && row.claimedAt === null && row.eligible
      && !['recipient_suppressed', 'invalid_recipient'].includes(row.lastError ?? ''),
    guidance: row.kind === 'gift_card_claim' ? 'Use Gift cards to resend a fresh claim link.'
      : ['recipient_suppressed', 'invalid_recipient'].includes(row.lastError ?? '') ? 'Recipient cannot receive this email. Automatic retries have stopped.'
      : !row.eligible ? 'The order or shipment is no longer eligible for this notice.'
      : row.claimedAt ? 'A delivery lease is present. Wait for the sender to finish.'
      : row.status === 'pending' ? 'The scheduled sender will retry this email automatically.'
      : 'Resolve the recorded error, then request a new delivery attempt.' })),
    total: counted[0]?.count ?? 0, offset,
    history: history.map(row => ({ ...row, actorName: names.get(row.actor) ?? row.actor })) };
}

const retrySchema = z.object({
  requestKey: z.string().uuid().transform(value => value.toLowerCase()),
  emailId: z.string().min(1).max(128),
  reason: z.string().trim().refine(value => [...value].length >= 8 && [...value].length <= 500),
  expectedAttempts: z.number().int().nonnegative(),
  expectedRetryId: z.string().max(128).nullable(),
  expectedError: z.string().max(128).nullable(),
}).strict();
async function hash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Queues a fresh attempt, never sends from the admin request. Replaying a key returns its receipt
 * even after another delivery failure, without resetting the queue a second time. */
export async function retryCommerceEmail(env: TalismanEnv, input: unknown, actor: string) {
  const values = retrySchema.parse(input);
  const identity = z.string().trim().min(1).max(128).parse(actor);
  const { requestKey, ...details } = values;
  const id = await hash(`commerce-email-retry:${requestKey}`);
  const fingerprint = await hash(JSON.stringify(details));
  const db = commerceDb(env);
  async function receipt() {
    const decision = await db.select().from(emailRecoveryDecisions).where(eq(emailRecoveryDecisions.id, id)).get();
    if (!decision) return null;
    if (decision.actor !== identity || decision.fingerprint !== fingerprint) {
      throw new CommerceOperationsConflict('This retry key belongs to different details or another administrator.');
    }
    const delivery = await db.select({ status: emailDeliveries.status, attempts: emailDeliveries.attempts,
      lastError: emailDeliveries.lastError }).from(emailDeliveries).where(eq(emailDeliveries.id, decision.emailId)).get();
    return { decisionId: id, emailId: decision.emailId, requestedAt: decision.createdAt, delivery };
  }
  const previous = await receipt();
  if (previous) return previous;
  const now = new Date();
  // Both statements are atomic. A different key cannot claim a pending email, and an existing
  // receipt prevents its key from resetting even a later failed attempt. The insert selects only
  // the row claimed by this key, so a losing request leaves no audit record.
  await commitBatch(db, [
    db.update(emailDeliveries).set({ status: 'pending', attempts: 0, lastError: null, claimedAt: null,
      nextAttemptAt: now, retryRequestedAt: now, retryRequestId: id }).where(and(
      eq(emailDeliveries.id, values.emailId), eq(emailDeliveries.status, 'failed'), isNull(emailDeliveries.claimedAt),
      eq(emailDeliveries.attempts, values.expectedAttempts),
      values.expectedRetryId === null ? isNull(emailDeliveries.retryRequestId) : eq(emailDeliveries.retryRequestId, values.expectedRetryId),
      values.expectedError === null ? isNull(emailDeliveries.lastError) : eq(emailDeliveries.lastError, values.expectedError),
      sql`COALESCE(${emailDeliveries.lastError}, '') NOT IN ('recipient_suppressed', 'invalid_recipient')`, recoverableEmailSubject,
      sql`NOT EXISTS (SELECT 1 FROM _ecommerce_email_recovery_decisions WHERE id = ${id})`)),
    db.run(sql`INSERT INTO _ecommerce_email_recovery_decisions
      (id, email_id, fingerprint, actor, reason, prior_attempts, prior_error, created_at)
      SELECT ${id}, id, ${fingerprint}, ${identity}, ${values.reason}, ${values.expectedAttempts}, ${values.expectedError}, ${Math.floor(now.getTime() / 1000)}
      FROM _ecommerce_email_deliveries WHERE id = ${values.emailId} AND retry_request_id = ${id}
      ON CONFLICT(id) DO NOTHING`),
  ]);
  const result = await receipt();
  if (!result) throw new CommerceOperationsConflict('This email changed or cannot be retried. Reload its latest status.');
  return result;
}
