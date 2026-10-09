import {
  adminActorNames
} from "./chunk-HQYYNOMX.js";
import {
  commerceDb,
  commitBatch
} from "./chunk-S5M56U3H.js";
import {
  emailDeliveries,
  emailRecoveryDecisions
} from "./chunk-7YP7VGC3.js";

// src/attention.ts
import { sql } from "drizzle-orm";
async function readCommerceAttention(env, now = Math.floor(Date.now() / 1e3)) {
  const db = commerceDb(env);
  const queue = sql`WITH attention AS (
    SELECT 'payment_review' AS kind, id, 'Order' AS subject, reconcile_review_at AS createdAt, reconcile_last_error AS detail
      FROM _ecommerce_orders WHERE status = 'pending' AND reconcile_review_at IS NOT NULL
        AND COALESCE(payment_provider, 'stripe') <> 'admin_test'
    UNION ALL SELECT 'payment_review', id, 'Gift card purchase', reconcile_review_at, reconcile_last_error
      FROM _ecommerce_gift_card_purchases WHERE status = 'pending' AND reconcile_review_at IS NOT NULL
    UNION ALL SELECT 'older_payments', id, 'Order', created_at, reconcile_last_error
      FROM _ecommerce_orders WHERE status = 'pending' AND reconcile_review_at IS NULL
        AND COALESCE(payment_provider, 'stripe') <> 'admin_test' AND created_at <= ${now - 86400}
    UNION ALL SELECT 'older_payments', id, 'Gift card purchase', created_at, reconcile_last_error
      FROM _ecommerce_gift_card_purchases WHERE status = 'pending' AND reconcile_review_at IS NULL AND created_at <= ${now - 86400}
    UNION ALL SELECT 'tax_review', id, 'Order tax', tax_sync_review_at, tax_sync_last_error
      FROM _ecommerce_orders WHERE tax_sync_review_at IS NOT NULL AND COALESCE(payment_provider, 'stripe') <> 'admin_test'
    UNION ALL SELECT 'tax_review', r.id, 'Tax reversal', r.tax_sync_review_at, r.tax_sync_last_error
      FROM _ecommerce_tax_reversals r JOIN _ecommerce_orders o ON o.id = r.order_id
      WHERE r.tax_sync_review_at IS NOT NULL AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'
    UNION ALL SELECT 'email', e.id, e.kind, e.created_at, e.last_error FROM _ecommerce_email_deliveries e
      WHERE (e.status = 'failed' OR (e.status = 'pending' AND e.last_error IS NOT NULL))
        AND (e.kind = 'gift_card_claim' OR EXISTS (SELECT 1 FROM _ecommerce_orders o
          WHERE o.id = e.subject_id AND e.kind = 'order_confirmation' AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test')
          OR EXISTS (SELECT 1 FROM _ecommerce_fulfillments f JOIN _ecommerce_orders o ON o.id = f.order_id
            WHERE f.id = e.subject_id AND e.kind IN ('shipment', 'shipment_update') AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'))
    UNION ALL SELECT 'gift_hold', id, 'Gift card', updated_at, status FROM _ecommerce_gift_cards WHERE held_for_review = 1
    UNION ALL SELECT 'shipment', id, 'Order', created_at, fulfillment_status FROM _ecommerce_orders
      WHERE status IN ('paid', 'partially_refunded') AND fulfillment_status <> 'fulfilled' AND COALESCE(payment_provider, 'stripe') <> 'admin_test'
        AND shipping_address IS NOT NULL
    UNION ALL SELECT 'dispute', d.id, 'Payment dispute', d.created_at, d.status FROM _ecommerce_disputes d
      WHERE d.closed_at IS NULL AND (d.gift_card_purchase_id IS NOT NULL OR EXISTS (SELECT 1 FROM _ecommerce_orders o
        WHERE o.id = d.order_id AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'))
  )`;
  const [counts, rows] = await db.batch([
    db.all(sql`${queue} SELECT kind, count(*) AS count FROM attention GROUP BY kind`),
    db.all(sql`${queue}, ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY kind ORDER BY createdAt, id) AS rank FROM attention)
      SELECT kind, id, subject, createdAt, detail FROM ranked WHERE rank <= 10 ORDER BY kind, createdAt, id`)
  ]);
  return {
    checkedAt: new Date(now * 1e3).toISOString(),
    counts: Object.fromEntries(counts.map((row) => [row.kind, Number(row.count)])),
    rows: rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt * 1e3).toISOString() }))
  };
}

// src/email-recovery.ts
import { z } from "zod";
import { and, desc, eq, isNull, sql as sql2 } from "drizzle-orm";
var CommerceOperationsConflict = class extends Error {
  name = "CommerceOperationsConflict";
};
var recoverableEmailSubject = sql2`(
  (_ecommerce_email_deliveries.kind = 'order_confirmation' AND EXISTS (
    SELECT 1 FROM _ecommerce_orders o WHERE o.id = _ecommerce_email_deliveries.subject_id
      AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'
      AND o.status IN ('paid', 'fulfilled', 'partially_refunded', 'disputed')))
  OR (_ecommerce_email_deliveries.kind IN ('shipment', 'shipment_update') AND EXISTS (
    SELECT 1 FROM _ecommerce_fulfillments f JOIN _ecommerce_orders o ON o.id = f.order_id
      WHERE f.id = _ecommerce_email_deliveries.subject_id AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'
      AND ((_ecommerce_email_deliveries.kind = 'shipment' AND f.kind = 'shipment')
        OR (_ecommerce_email_deliveries.kind = 'shipment_update' AND f.kind = 'correction')))))`;
var pageSchema = z.object({ offset: z.coerce.number().int().min(0).max(1e6).default(0) });
async function listEmailRecovery(env, input = {}) {
  const { offset } = pageSchema.parse(input);
  const db = commerceDb(env);
  const attention = sql2`${emailDeliveries.status} = 'failed' OR (${emailDeliveries.status} = 'pending' AND ${emailDeliveries.lastError} IS NOT NULL)`;
  const [rows, counted, history] = await db.batch([
    db.select({
      id: emailDeliveries.id,
      kind: emailDeliveries.kind,
      subjectId: emailDeliveries.subjectId,
      status: emailDeliveries.status,
      attempts: emailDeliveries.attempts,
      lastError: emailDeliveries.lastError,
      nextAttemptAt: emailDeliveries.nextAttemptAt,
      claimedAt: emailDeliveries.claimedAt,
      retryRequestId: emailDeliveries.retryRequestId,
      createdAt: emailDeliveries.createdAt,
      eligible: sql2`CASE WHEN ${recoverableEmailSubject} THEN 1 ELSE 0 END`.mapWith(Boolean)
    }).from(emailDeliveries).where(attention).orderBy(emailDeliveries.createdAt, emailDeliveries.id).limit(50).offset(offset),
    db.select({ count: sql2`count(*)`.mapWith(Number) }).from(emailDeliveries).where(attention),
    db.select({
      id: emailRecoveryDecisions.id,
      emailId: emailRecoveryDecisions.emailId,
      actor: emailRecoveryDecisions.actor,
      reason: emailRecoveryDecisions.reason,
      priorAttempts: emailRecoveryDecisions.priorAttempts,
      priorError: emailRecoveryDecisions.priorError,
      createdAt: emailRecoveryDecisions.createdAt
    }).from(emailRecoveryDecisions).orderBy(desc(emailRecoveryDecisions.createdAt), desc(emailRecoveryDecisions.id)).limit(50)
  ]);
  const names = await adminActorNames(env, history.map((row) => row.actor));
  return {
    rows: rows.map((row) => ({
      ...row,
      retryable: row.status === "failed" && row.claimedAt === null && row.eligible && !["recipient_suppressed", "invalid_recipient"].includes(row.lastError ?? ""),
      guidance: row.kind === "gift_card_claim" ? "Use Gift cards to resend a fresh claim link." : ["recipient_suppressed", "invalid_recipient"].includes(row.lastError ?? "") ? "Recipient cannot receive this email. Automatic retries have stopped." : !row.eligible ? "The order or shipment is no longer eligible for this notice." : row.claimedAt ? "A delivery lease is present. Wait for the sender to finish." : row.status === "pending" ? "The scheduled sender will retry this email automatically." : "Resolve the recorded error, then request a new delivery attempt."
    })),
    total: counted[0]?.count ?? 0,
    offset,
    history: history.map((row) => ({ ...row, actorName: names.get(row.actor) ?? row.actor }))
  };
}
var retrySchema = z.object({
  requestKey: z.string().uuid().transform((value) => value.toLowerCase()),
  emailId: z.string().min(1).max(128),
  reason: z.string().trim().refine((value) => [...value].length >= 8 && [...value].length <= 500),
  expectedAttempts: z.number().int().nonnegative(),
  expectedRetryId: z.string().max(128).nullable(),
  expectedError: z.string().max(128).nullable()
}).strict();
async function hash(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function retryCommerceEmail(env, input, actor) {
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
      throw new CommerceOperationsConflict("This retry key belongs to different details or another administrator.");
    }
    const delivery = await db.select({
      status: emailDeliveries.status,
      attempts: emailDeliveries.attempts,
      lastError: emailDeliveries.lastError
    }).from(emailDeliveries).where(eq(emailDeliveries.id, decision.emailId)).get();
    return { decisionId: id, emailId: decision.emailId, requestedAt: decision.createdAt, delivery };
  }
  const previous = await receipt();
  if (previous) return previous;
  const now = /* @__PURE__ */ new Date();
  await commitBatch(db, [
    db.update(emailDeliveries).set({
      status: "pending",
      attempts: 0,
      lastError: null,
      claimedAt: null,
      nextAttemptAt: now,
      retryRequestedAt: now,
      retryRequestId: id
    }).where(and(
      eq(emailDeliveries.id, values.emailId),
      eq(emailDeliveries.status, "failed"),
      isNull(emailDeliveries.claimedAt),
      eq(emailDeliveries.attempts, values.expectedAttempts),
      values.expectedRetryId === null ? isNull(emailDeliveries.retryRequestId) : eq(emailDeliveries.retryRequestId, values.expectedRetryId),
      values.expectedError === null ? isNull(emailDeliveries.lastError) : eq(emailDeliveries.lastError, values.expectedError),
      sql2`COALESCE(${emailDeliveries.lastError}, '') NOT IN ('recipient_suppressed', 'invalid_recipient')`,
      recoverableEmailSubject,
      sql2`NOT EXISTS (SELECT 1 FROM _ecommerce_email_recovery_decisions WHERE id = ${id})`
    )),
    db.run(sql2`INSERT INTO _ecommerce_email_recovery_decisions
      (id, email_id, fingerprint, actor, reason, prior_attempts, prior_error, created_at)
      SELECT ${id}, id, ${fingerprint}, ${identity}, ${values.reason}, ${values.expectedAttempts}, ${values.expectedError}, ${Math.floor(now.getTime() / 1e3)}
      FROM _ecommerce_email_deliveries WHERE id = ${values.emailId} AND retry_request_id = ${id}
      ON CONFLICT(id) DO NOTHING`)
  ]);
  const result = await receipt();
  if (!result) throw new CommerceOperationsConflict("This email changed or cannot be retried. Reload its latest status.");
  return result;
}

// src/stock-overview.ts
import { z as z2 } from "zod";
import { sql as sql3 } from "drizzle-orm";
var inputSchema = z2.object({
  view: z2.enum(["choices", "components"]).default("choices"),
  threshold: z2.coerce.number().int().min(0).max(1e6).default(5),
  filter: z2.enum(["low", "unavailable", "all"]).default("low"),
  search: z2.string().trim().max(100).default(""),
  offset: z2.coerce.number().int().min(0).max(1e6).default(0)
});
var choices = sql3`WITH inventory AS (
  SELECT p.id, 'product' AS kind, p.id AS productId, p.name, p.sku, p.inventory_quantity AS quantity, 'Product' AS source
    FROM _ecommerce_products p WHERE p.status = 'active' AND p.type = 'standard'
      AND NOT EXISTS (SELECT 1 FROM _ecommerce_product_variants g WHERE g.product_id = p.id)
  UNION ALL
  SELECT g.id, 'variant', p.id, p.name || ' / ' || g.name, g.sku, g.inventory_quantity, 'Option group'
    FROM _ecommerce_product_variants g JOIN _ecommerce_products p ON p.id = g.product_id
    WHERE p.status = 'active' AND p.type = 'standard'
      AND NOT EXISTS (SELECT 1 FROM _ecommerce_product_variant_values v WHERE v.product_variant_id = g.id)
  UNION ALL
  SELECT v.id, 'value', p.id, p.name || ' / ' || g.name || ' / ' || v.value, v.sku,
    CASE WHEN EXISTS (SELECT 1 FROM _ecommerce_variant_components r WHERE r.product_variant_value_id = v.id)
      THEN (SELECT min(c.quantity / r.quantity) FROM _ecommerce_variant_components r
        JOIN _ecommerce_components c ON c.id = r.component_id WHERE r.product_variant_value_id = v.id)
      ELSE COALESCE(s.quantity, g.inventory_quantity) END,
    CASE WHEN EXISTS (SELECT 1 FROM _ecommerce_variant_components r WHERE r.product_variant_value_id = v.id)
      THEN 'Shared components' WHEN s.id IS NOT NULL THEN 'Choice stock' ELSE 'Option group' END
    FROM _ecommerce_product_variant_values v JOIN _ecommerce_product_variants g ON g.id = v.product_variant_id
      JOIN _ecommerce_products p ON p.id = g.product_id
      LEFT JOIN _ecommerce_stocks s ON s.product_variant_value_id = v.id
    WHERE p.status = 'active' AND p.type = 'standard'
)`;
var parts = sql3`WITH inventory AS (SELECT id, 'component' AS kind, NULL AS productId, name, sku, quantity,
  'Shared component' AS source FROM _ecommerce_components)`;
async function readStockOverview(env, input = {}) {
  const values = inputSchema.parse(input);
  const cte = values.view === "components" ? parts : choices;
  const pattern = `%${values.search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  const filtered = sql3`(name LIKE ${pattern} ESCAPE '\\' OR COALESCE(sku, '') LIKE ${pattern} ESCAPE '\\')
    AND ${values.filter === "all" ? sql3`1` : values.filter === "unavailable" ? sql3`quantity = 0` : sql3`quantity <= ${values.threshold}`}`;
  const db = commerceDb(env);
  const [rows, counted] = await db.batch([
    db.all(sql3`${cte} SELECT * FROM inventory WHERE ${filtered}
      ORDER BY quantity, name, kind, id LIMIT 50 OFFSET ${values.offset}`),
    db.all(sql3`${cte} SELECT count(*) AS count FROM inventory WHERE ${filtered}`)
  ]);
  return { rows, total: Number(counted[0]?.count ?? 0), ...values };
}

export {
  readCommerceAttention,
  CommerceOperationsConflict,
  listEmailRecovery,
  retryCommerceEmail,
  readStockOverview
};
