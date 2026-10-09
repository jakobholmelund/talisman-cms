import {
  effectiveDeliveryDate,
  openRecoveryCase,
  physicalStockLocations
} from "./chunk-PYEHVINE.js";
import {
  CommerceOperationsConflict,
  adminActorNames,
  describeOrderItems,
  warehouseFingerprint
} from "./chunk-3SF7AMPH.js";
import {
  commerceEmailStatement
} from "./chunk-L63XGUKQ.js";
import {
  commerceDb,
  commitBatch,
  errorText
} from "./chunk-SXQHVX4E.js";
import {
  RECOVERY_DISPOSITIONS,
  REFUND_SOURCE_KINDS,
  RESTOCK_TARGET_TYPES,
  RETURN_REFUND_STATUSES,
  SUPPLIER_ISSUE_KINDS,
  SUPPLIER_ISSUE_STATUSES,
  orders,
  purchaseOrderEvents,
  purchaseOrderLines,
  purchaseOrders,
  recoveryInspections,
  recoveryReceipts,
  replenishmentDeliveries,
  replenishmentDeliveryEvents,
  returnRefundDecisions,
  shopperAudits,
  supplierIssueEvents,
  supplierIssues,
  supplierRevisions,
  suppliers
} from "./chunk-PLAJXKV3.js";
import {
  hashOrderAccess
} from "./chunk-NQUBOBQT.js";

// src/supplier-issues.ts
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
var id = z.string().trim().min(1).max(128);
var reason = z.string().trim().min(8).max(500);
var openSupplierIssue = sql`COALESCE((SELECT status FROM _ecommerce_supplier_issue_events WHERE issue_id=i.id ORDER BY rowid DESC LIMIT 1),'open')='open'`;
async function identity(input, actor, prefix) {
  if (!actor.trim()) throw new CommerceOperationsConflict("An authenticated staff member is required.");
  return { id: `${prefix}_${await hashOrderAccess(input.requestKey)}`, fingerprint: await hashOrderAccess(JSON.stringify({ input, actor })) };
}
async function guarded(write, replay) {
  try {
    await write();
  } catch (error) {
    const previous = await replay();
    if (previous) return previous;
    if (!/Supplier issue|UNIQUE constraint/.test(errorText(error))) throw error;
    throw new CommerceOperationsConflict("The purchase, delivery or supplier issue changed. Refresh before continuing.");
  }
  return null;
}
async function reportSupplierIssue(env, input, actor) {
  const v = z.object({
    purchaseLineId: id,
    expectedPurchaseVersion: id,
    expectedDeliveryVersion: id,
    kind: z.enum(SUPPLIER_ISSUE_KINDS),
    quantity: z.number().int().min(1).max(1e6),
    reason,
    requestKey: id.min(8)
  }).strict().parse(input);
  const db = commerceDb(env), ident = await identity(v, actor, "supissue");
  const replay = async () => {
    const row = await db.select().from(supplierIssues).where(eq(supplierIssues.id, ident.id)).get();
    if (!row) return null;
    if (row.fingerprint !== ident.fingerprint) throw new CommerceOperationsConflict("This supplier issue key was used with different details.");
    return { issueId: row.id, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const { requestKey, ...fields } = v;
  const result = await guarded(() => commitBatch(db, [db.insert(supplierIssues).values({ ...fields, ...ident, actor, createdAt: /* @__PURE__ */ new Date() })]), replay);
  return result ?? { issueId: ident.id };
}
async function recordSupplierIssue(env, input, actor) {
  const v = z.object({ issueId: id, expectedVersion: id, status: z.enum(SUPPLIER_ISSUE_STATUSES), reason, requestKey: id.min(8) }).strict().parse(input);
  const db = commerceDb(env), ident = await identity(v, actor, "supissueevent");
  const replay = async () => {
    const row = await db.select().from(supplierIssueEvents).where(eq(supplierIssueEvents.id, ident.id)).get();
    if (!row) return null;
    if (row.fingerprint !== ident.fingerprint) throw new CommerceOperationsConflict("This supplier follow-up key was used with different details.");
    return { issueId: row.issueId, eventId: row.id, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const { requestKey, ...fields } = v;
  const result = await guarded(() => commitBatch(db, [db.insert(supplierIssueEvents).values({ ...fields, ...ident, actor, createdAt: /* @__PURE__ */ new Date() })]), replay);
  return result ?? { issueId: v.issueId, eventId: ident.id };
}
var queue = sql`WITH issues AS (SELECT i.id,i.purchase_line_id AS purchaseLineId,i.kind,i.quantity,i.created_at AS createdAt,
 COALESCE((SELECT id FROM _ecommerce_supplier_issue_events WHERE issue_id=i.id ORDER BY rowid DESC LIMIT 1),i.id) AS version,
 COALESCE((SELECT status FROM _ecommerce_supplier_issue_events WHERE issue_id=i.id ORDER BY rowid DESC LIMIT 1),'open') AS status,
 l.purchase_order_id AS purchaseOrderId,l.delivery_id AS deliveryId,l.line_index AS lineIndex,e.reference,
 json_extract(e.supplier,'$.name') AS supplier,json_extract(e.lines,'$['||l.line_index||'].name') AS name
 FROM _ecommerce_supplier_issues i JOIN _ecommerce_purchase_order_lines l ON l.id=i.purchase_line_id
 JOIN _ecommerce_purchase_order_events e ON e.id=(SELECT id FROM _ecommerce_purchase_order_events WHERE purchase_order_id=l.purchase_order_id ORDER BY rowid DESC LIMIT 1))`;
async function listSupplierIssues(env, input = {}) {
  const v = z.object({
    purchaseOrderId: id.optional(),
    offset: z.coerce.number().int().min(0).max(1e6).default(0),
    filter: z.enum(["open", "resolved", "all"]).default("open")
  }).strict().parse(input), db = commerceDb(env);
  const where = sql`(${v.purchaseOrderId ?? null} IS NULL OR purchaseOrderId=${v.purchaseOrderId ?? null}) AND (${v.filter}='all' OR status=${v.filter})`;
  const [rows, count] = await db.batch([
    db.all(sql`${queue} SELECT * FROM issues WHERE ${where} ORDER BY createdAt,id LIMIT 50 OFFSET ${v.offset}`),
    db.all(sql`${queue} SELECT count(*) AS n FROM issues WHERE ${where}`)
  ]);
  return { ...v, total: count[0]?.n ?? 0, rows: rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt * 1e3).toISOString() })) };
}
async function readSupplierIssue(env, input) {
  const { issueId } = z.object({ issueId: id }).strict().parse(input), db = commerceDb(env);
  const issue = await db.query.supplierIssues.findFirst({ where: { id: issueId }, with: {
    events: { orderBy: (_t, { sql: sql10 }) => sql10`rowid DESC`, limit: 100 },
    line: { with: { purchaseOrder: { with: { events: { orderBy: (_t, { sql: sql10 }) => sql10`rowid DESC`, limit: 1 } } } } }
  } });
  if (!issue) throw new CommerceOperationsConflict("Supplier issue not found.");
  const latest = issue.events[0], purchase = issue.line.purchaseOrder.events[0];
  const actors = await adminActorNames(env, [issue.actor, ...issue.events.map((e) => e.actor)]);
  return {
    id: issue.id,
    purchaseLineId: issue.purchaseLineId,
    purchaseOrderId: issue.line.purchaseOrderId,
    kind: issue.kind,
    quantity: issue.quantity,
    reason: issue.reason,
    createdAt: issue.createdAt.toISOString(),
    actorName: actors.get(issue.actor) ?? issue.actor,
    version: latest?.id ?? issue.id,
    status: latest?.status ?? "open",
    reference: purchase.reference,
    name: purchase.lines[issue.line.lineIndex].name,
    supplier: purchase.supplier.name,
    historyTruncated: issue.events.length === 100,
    history: [...issue.events].reverse().map((e) => ({ id: e.id, status: e.status, reason: e.reason, actorName: actors.get(e.actor) ?? e.actor, createdAt: e.createdAt.toISOString() }))
  };
}

// src/attention.ts
import { sql as sql2 } from "drizzle-orm";
async function readCommerceAttention(env, now = Math.floor(Date.now() / 1e3)) {
  const db = commerceDb(env);
  const queue2 = sql2`WITH attention_a AS (
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
  ), attention_b AS (
    SELECT 'tax_review' AS kind, r.id AS id, 'Tax reversal' AS subject, r.tax_sync_review_at AS createdAt, r.tax_sync_last_error AS detail
      FROM _ecommerce_tax_reversals r JOIN _ecommerce_orders o ON o.id = r.order_id
      WHERE r.tax_sync_review_at IS NOT NULL AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'
    UNION ALL SELECT 'email', e.id, e.kind, e.created_at, e.last_error FROM _ecommerce_email_deliveries e
      WHERE (e.status = 'failed' OR (e.status = 'pending' AND e.last_error IS NOT NULL))
        AND (e.kind = 'gift_card_claim' OR EXISTS (SELECT 1 FROM _ecommerce_orders o
          WHERE o.id = e.subject_id AND e.kind = 'order_confirmation' AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test')
          OR EXISTS (SELECT 1 FROM _ecommerce_return_refund_decisions d JOIN _ecommerce_return_receipts r ON r.id=d.receipt_id JOIN _ecommerce_orders o ON o.id=r.order_id WHERE e.kind='return_refund' AND d.id=e.subject_id AND d.status='settled' AND d.redacted_at IS NULL AND o.customer_email IS NOT NULL AND COALESCE(o.payment_provider,'stripe')<>'admin_test')
          OR EXISTS (SELECT 1 FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE e.kind='return_received' AND r.id=e.subject_id AND COALESCE(o.payment_provider,'stripe')<>'admin_test')
          OR EXISTS (SELECT 1 FROM _ecommerce_return_request_events d JOIN _ecommerce_return_requests r ON r.id=d.request_id JOIN _ecommerce_orders o ON o.id=r.order_id WHERE e.kind='return_decision' AND d.id=e.subject_id AND d.redacted_at IS NULL AND d.rowid=(SELECT rowid FROM _ecommerce_return_request_events WHERE request_id=r.id ORDER BY rowid DESC LIMIT 1) AND COALESCE(o.payment_provider,'stripe')<>'admin_test')
          OR EXISTS (SELECT 1 FROM _ecommerce_fulfillments f JOIN _ecommerce_orders o ON o.id = f.order_id
            WHERE f.id = e.subject_id AND e.kind IN ('shipment', 'shipment_update') AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'))
    UNION ALL SELECT 'gift_hold', id, 'Gift card', updated_at, status FROM _ecommerce_gift_cards WHERE held_for_review = 1
    UNION ALL SELECT 'shipment', id, 'Order', created_at, fulfillment_status FROM _ecommerce_orders
      WHERE status IN ('paid', 'partially_refunded') AND fulfillment_status <> 'fulfilled' AND COALESCE(payment_provider, 'stripe') <> 'admin_test'
        AND shipping_address IS NOT NULL
    UNION ALL SELECT 'dispute', d.id, 'Payment dispute', d.created_at, d.status FROM _ecommerce_disputes d
      WHERE d.closed_at IS NULL AND (d.gift_card_purchase_id IS NOT NULL OR EXISTS (SELECT 1 FROM _ecommerce_orders o
        WHERE o.id = d.order_id AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'))
  ), return_events AS (
    SELECT 'return_request' AS kind,r.id,'Return request' AS subject,r.created_at AS createdAt,r.order_id AS detail FROM _ecommerce_return_requests r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_request_events e WHERE e.request_id=r.id)
    UNION ALL SELECT 'inspection',r.id,'Received return',r.created_at,r.order_id FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
      AND (SELECT COALESCE(sum(json_extract(value,'$.quantity')),0) FROM json_each(r.items) WHERE json_extract(value,'$.condition')='inspection')>COALESCE((SELECT sum(json_extract(i.value,'$.quantity')) FROM _ecommerce_return_inspections d,json_each(d.items) i WHERE d.receipt_id=r.id),0)
    UNION ALL SELECT 'refund',r.id,'Return refund',r.created_at,r.order_id FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND NOT EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a WHERE a.account_id=o.user_id AND a.action='anonymize') AND COALESCE((SELECT status FROM _ecommerce_return_refund_decisions d WHERE d.receipt_id=r.id ORDER BY rowid DESC LIMIT 1),'review') IN ('review','needed')
    UNION ALL SELECT 'incoming',d.id,'Overdue delivery',d.created_at,d.supplier FROM _ecommerce_replenishment_deliveries d WHERE ${effectiveDeliveryDate} < date(${now},'unixepoch') AND NOT EXISTS(SELECT 1 FROM _ecommerce_replenishment_delivery_events e WHERE e.delivery_id=d.id AND e.kind='cancelled') AND d.quantity>COALESCE((SELECT sum(m.delta) FROM _ecommerce_replenishment_delivery_events e JOIN _ecommerce_stock_movements m ON m.id=e.movement_id WHERE e.delivery_id=d.id),0)
    UNION ALL SELECT 'supplier_issue',i.id,'Supplier delivery issue',i.created_at,i.kind||' · '||i.quantity||' units' FROM _ecommerce_supplier_issues i WHERE ${openSupplierIssue}
  ), recovery_work AS (SELECT 'parcel_recovery' AS kind,c.id,'Parcel or exchange' AS subject,c.created_at AS createdAt,c.kind||' · '||c.quantity||' units' AS detail FROM _ecommerce_recovery_cases c WHERE ${openRecoveryCase}), attention AS (SELECT * FROM attention_a UNION ALL SELECT * FROM attention_b UNION ALL SELECT * FROM return_events UNION ALL SELECT * FROM recovery_work)`;
  const [counts, rows] = await db.batch([
    db.all(sql2`${queue2} SELECT kind, count(*) AS count FROM attention GROUP BY kind`),
    db.all(sql2`${queue2}, ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY kind ORDER BY createdAt, id) AS rank FROM attention)
      SELECT kind, id, subject, createdAt, detail FROM ranked WHERE rank <= 10 ORDER BY kind, createdAt, id`)
  ]);
  return {
    checkedAt: new Date(now * 1e3).toISOString(),
    counts: Object.fromEntries(counts.map((row) => [row.kind, Number(row.count)])),
    rows: rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt * 1e3).toISOString() }))
  };
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

// src/recovery-journal.ts
import { sql as sql4 } from "drizzle-orm";
import { z as z3 } from "zod";
var recoveryKindOrder = (kind) => sql4`CASE ${kind} WHEN 'exchange_requested' THEN 0 WHEN 'exchange_request_decision' THEN 1 WHEN 'case_created' THEN 2 WHEN 'upgrade_payment' THEN 3 WHEN 'exchange_refund_decision' THEN 3 WHEN 'replacement_shipment' THEN 4 WHEN 'replacement_receipt' THEN 5 WHEN 'replacement_inspection' THEN 6 ELSE 7 END`;
function recoveryJournal(caseScope = sql4`1=1`, requestScope = sql4`1=1`) {
  return sql4`WITH cases AS (
 SELECT c.*,o.currency FROM _ecommerce_recovery_cases c JOIN _ecommerce_orders o ON o.id=c.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND ${caseScope}
), case_work AS (
SELECT c.id AS record_id,
 'case_created' AS kind,
 c.order_id AS order_id,
 c.id AS case_id,
 NULL AS request_id,
 NULL AS shipment_id,
 NULL AS receipt_id,
 NULL AS verification_id,
 c.created_at AS created_at_utc,
 json_extract(c.target,'$.name') AS target_name,
 json_extract(c.target,'$.sku') AS target_sku,
 c.currency AS currency,
 c.quantity AS quantity,
 CASE WHEN c.kind='exchange' THEN COALESCE(json_extract(c.target,'$.adjustmentMinor'),0) END AS adjustment_minor,
 NULL AS amount_minor,
 NULL AS disposition,
 NULL AS restock,
 NULL AS carrier,
 NULL AS tracking_number,
 'open' AS recorded_status,
 c.actor AS actor,
 c.reason AS reason
 FROM cases c
 UNION ALL
SELECT e.id AS record_id,
 CASE WHEN p.id IS NOT NULL THEN 'upgrade_payment' WHEN e.kind='shipment' THEN 'replacement_shipment' ELSE 'case_'||e.kind END AS kind,
 c.order_id AS order_id,
 c.id AS case_id,
 NULL AS request_id,
 e.shipment_id AS shipment_id,
 NULL AS receipt_id,
 p.id AS verification_id,
 e.created_at AS created_at_utc,
 json_extract(c.target,'$.name') AS target_name,
 json_extract(c.target,'$.sku') AS target_sku,
 c.currency AS currency,
 CASE WHEN e.kind='shipment' THEN s.quantity END AS quantity,
 NULL AS adjustment_minor,
 p.amount_minor AS amount_minor,
 NULL AS disposition,
 NULL AS restock,
 e.carrier AS carrier,
 e.tracking_number AS tracking_number,
 e.status AS recorded_status,
 e.actor AS actor,
 e.reason AS reason
 FROM cases c JOIN _ecommerce_recovery_events e ON e.case_id=c.id LEFT JOIN _ecommerce_recovery_shipments s ON s.id=e.shipment_id LEFT JOIN _ecommerce_recovery_payments p ON p.id=e.id WHERE e.actor<>'payment_provider'
 UNION ALL
SELECT d.id AS record_id,
 'exchange_refund_decision' AS kind,
 c.order_id AS order_id,
 c.id AS case_id,
 NULL AS request_id,
 NULL AS shipment_id,
 d.receipt_id AS receipt_id,
 NULL AS verification_id,
 d.created_at AS created_at_utc,
 json_extract(c.target,'$.name') AS target_name,
 json_extract(c.target,'$.sku') AS target_sku,
 c.currency AS currency,
 NULL AS quantity,
 NULL AS adjustment_minor,
 d.amount_minor AS amount_minor,
 NULL AS disposition,
 NULL AS restock,
 NULL AS carrier,
 NULL AS tracking_number,
 d.status AS recorded_status,
 d.actor AS actor,
 d.reason AS reason
 FROM cases c JOIN _ecommerce_return_refund_decisions d ON d.receipt_id=c.receipt_id WHERE c.kind='exchange' AND COALESCE(json_extract(c.target,'$.adjustmentMinor'),0)<0
), goods AS (
SELECT r.id AS record_id,
 'replacement_receipt' AS kind,
 c.order_id AS order_id,
 c.id AS case_id,
 NULL AS request_id,
 s.id AS shipment_id,
 r.id AS receipt_id,
 NULL AS verification_id,
 r.created_at AS created_at_utc,
 json_extract(c.target,'$.name') AS target_name,
 json_extract(c.target,'$.sku') AS target_sku,
 c.currency AS currency,
 r.quantity AS quantity,
 NULL AS adjustment_minor,
 NULL AS amount_minor,
 NULL AS disposition,
 NULL AS restock,
 NULL AS carrier,
 NULL AS tracking_number,
 NULL AS recorded_status,
 r.actor AS actor,
 r.reason AS reason
 FROM cases c JOIN _ecommerce_recovery_shipments s ON s.case_id=c.id JOIN _ecommerce_recovery_receipts r ON r.shipment_id=s.id
 UNION ALL
SELECT i.id AS record_id,
 'replacement_inspection' AS kind,
 c.order_id AS order_id,
 c.id AS case_id,
 NULL AS request_id,
 s.id AS shipment_id,
 r.id AS receipt_id,
 NULL AS verification_id,
 i.created_at AS created_at_utc,
 json_extract(c.target,'$.name') AS target_name,
 json_extract(c.target,'$.sku') AS target_sku,
 c.currency AS currency,
 i.quantity AS quantity,
 NULL AS adjustment_minor,
 NULL AS amount_minor,
 i.disposition AS disposition,
 i.restock AS restock,
 NULL AS carrier,
 NULL AS tracking_number,
 NULL AS recorded_status,
 i.actor AS actor,
 i.reason AS reason
 FROM cases c JOIN _ecommerce_recovery_shipments s ON s.case_id=c.id JOIN _ecommerce_recovery_receipts r ON r.shipment_id=s.id JOIN _ecommerce_recovery_inspections i ON i.receipt_id=r.id
), provider_work AS (
SELECT e.id AS record_id,
 'upgrade_'||e.kind AS kind,
 c.order_id AS order_id,
 c.id AS case_id,
 NULL AS request_id,
 NULL AS shipment_id,
 NULL AS receipt_id,
 p.id AS verification_id,
 e.created_at AS created_at_utc,
 json_extract(c.target,'$.name') AS target_name,
 json_extract(c.target,'$.sku') AS target_sku,
 c.currency AS currency,
 NULL AS quantity,
 NULL AS adjustment_minor,
 NULL AS amount_minor,
 NULL AS disposition,
 NULL AS restock,
 NULL AS carrier,
 NULL AS tracking_number,
 NULL AS recorded_status,
 'payment_provider' AS actor,
 'Exchange payment review required' AS reason
 FROM cases c JOIN _ecommerce_recovery_payments p ON p.case_id=c.id JOIN _ecommerce_recovery_payment_events e ON e.payment_id=p.id
), request_work AS (
SELECT r.id AS record_id,
 'exchange_requested' AS kind,
 r.order_id AS order_id,
 NULL AS case_id,
 r.id AS request_id,
 NULL AS shipment_id,
 NULL AS receipt_id,
 NULL AS verification_id,
 r.created_at AS created_at_utc,
 json_extract(p.target,'$.name') AS target_name,
 json_extract(p.target,'$.sku') AS target_sku,
 o.currency AS currency,
 json_extract(r.items,'$[0].quantity') AS quantity,
 NULL AS adjustment_minor,
 NULL AS amount_minor,
 NULL AS disposition,
 NULL AS restock,
 NULL AS carrier,
 NULL AS tracking_number,
 'pending' AS recorded_status,
 'customer' AS actor,
 r.reason AS reason
 FROM _ecommerce_return_requests r JOIN _ecommerce_return_exchange_preferences p ON p.request_id=r.id JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND ${requestScope}
 UNION ALL
SELECT e.id AS record_id,
 'exchange_request_decision' AS kind,
 r.order_id AS order_id,
 NULL AS case_id,
 r.id AS request_id,
 NULL AS shipment_id,
 NULL AS receipt_id,
 NULL AS verification_id,
 e.created_at AS created_at_utc,
 json_extract(p.target,'$.name') AS target_name,
 json_extract(p.target,'$.sku') AS target_sku,
 o.currency AS currency,
 NULL AS quantity,
 NULL AS adjustment_minor,
 NULL AS amount_minor,
 NULL AS disposition,
 NULL AS restock,
 NULL AS carrier,
 NULL AS tracking_number,
 e.status AS recorded_status,
 e.actor AS actor,
 e.reason AS reason
 FROM _ecommerce_return_requests r JOIN _ecommerce_return_exchange_preferences p ON p.request_id=r.id JOIN _ecommerce_orders o ON o.id=r.order_id JOIN _ecommerce_return_request_events e ON e.request_id=r.id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND ${requestScope}
), journal AS (SELECT * FROM case_work UNION ALL SELECT * FROM goods UNION ALL SELECT * FROM provider_work UNION ALL SELECT * FROM request_work)`;
}
async function readOrderRecoveryHistory(env, input) {
  const v = z3.object({ orderId: z3.string().trim().min(1).max(128), offset: z3.number().int().min(0).max(1e6).default(0) }).strict().parse(input), db = commerceDb(env);
  const order = await db.query.orders.findFirst({ where: { id: v.orderId }, columns: { id: true, paymentProvider: true } });
  if (!order || order.paymentProvider === "admin_test") throw new CommerceOperationsConflict("Order history is unavailable.");
  const journal = recoveryJournal(sql4`c.order_id=${v.orderId}`, sql4`r.order_id=${v.orderId}`);
  const [rows, count] = await db.batch([db.all(sql4`${journal} SELECT j.*,m.status AS emailStatus,m.attempts AS emailAttempts,m.last_error AS emailError,CASE WHEN m.status='pending' THEN m.next_attempt_at END AS emailNext FROM journal j LEFT JOIN _ecommerce_email_deliveries m ON m.subject_id=j.record_id AND m.kind=CASE j.kind WHEN 'replacement_shipment' THEN 'recovery_shipment' WHEN 'case_tracking' THEN 'recovery_tracking' WHEN 'replacement_receipt' THEN 'recovery_received' WHEN 'exchange_request_decision' THEN 'return_decision' WHEN 'exchange_refund_decision' THEN 'return_refund' END ORDER BY j.created_at_utc,${recoveryKindOrder(sql4`j.kind`)},j.record_id LIMIT 50 OFFSET ${v.offset}`), db.all(sql4`${journal} SELECT count(*) n FROM journal`)]);
  const names = await adminActorNames(env, rows.map((r) => r.actor ?? "").filter((a) => a && a !== "customer" && a !== "payment_provider"));
  return { ...v, total: count[0]?.n ?? 0, rows: rows.map((r) => ({ ...r, created_at_utc: new Date(r.created_at_utc * 1e3).toISOString(), actorName: r.actor === "payment_provider" ? "Payment provider" : r.actor === "customer" ? "Customer" : names.get(r.actor ?? "") ?? r.actor, emailNext: r.emailNext === null ? null : new Date(r.emailNext * 1e3).toISOString() })) };
}

// src/operations-export.ts
import { and, asc, eq as eq2, gte, lt, sql as sql5 } from "drizzle-orm";
import { z as z4 } from "zod";
var day = z4.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && (/* @__PURE__ */ new Date(`${s}T00:00:00Z`)).toISOString().slice(0, 10) === s, "Use a valid calendar date");
var options = z4.object({ kind: z4.enum(["orders", "returns", "stock", "recoveries"]), from: day, to: day, orderId: z4.string().trim().max(128).default(""), status: z4.enum(["all", "draft", "pending", "paid", "fulfilled", "cancelled", "partially_refunded", "refunded", "disputed"]).default("all"), targetType: z4.enum(["all", "product", "variant", "stock", "component"]).default("all"), targetId: z4.string().trim().max(128).default("") }).strict().refine((v) => v.to >= v.from && Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`) < 366 * 864e5, "Choose at most 366 UTC days").refine((v) => (v.kind === "orders" || v.status === "all") && (v.kind === "stock" || v.targetType === "all" && !v.targetId) && (!v.targetId || v.targetType !== "all"), "Filters do not match the selected export");
var OperationsExportLimit = class extends Error {
};
function csvCell(value) {
  if (value === null) return '""';
  let s = String(value);
  if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}
async function exportCommerceOperations(env, input) {
  const v = options.parse(input), db = commerceDb(env), from = Date.parse(`${v.from}T00:00:00Z`) / 1e3, to = Date.parse(`${v.to}T00:00:00Z`) / 1e3 + 86400;
  let rows, columns;
  if (v.kind === "orders") {
    columns = ["order_id", "created_at_utc", "payment_status", "fulfillment_status", "currency", "subtotal_minor", "shipping_minor", "tax_minor", "discount_minor", "credit_minor", "gift_card_minor", "total_minor", "provider_refunded_minor", "gift_card_refunded_minor", "customer_email"];
    rows = await db.select({
      order_id: orders.id,
      created_at_utc: sql5`${orders.createdAt}`,
      payment_status: orders.status,
      fulfillment_status: orders.fulfillmentStatus,
      currency: orders.currency,
      subtotal_minor: orders.subtotalAmount,
      shipping_minor: orders.shippingAmount,
      tax_minor: orders.taxAmount,
      discount_minor: orders.discountAmount,
      credit_minor: orders.creditApplied,
      gift_card_minor: orders.giftCardApplied,
      total_minor: orders.totalAmount,
      provider_refunded_minor: orders.providerRefundedCents,
      gift_card_refunded_minor: orders.giftCardRefundedCents,
      customer_email: orders.customerEmail
    }).from(orders).where(and(
      gte(orders.createdAt, new Date(from * 1e3)),
      lt(orders.createdAt, new Date(to * 1e3)),
      sql5`COALESCE(${orders.paymentProvider},'stripe')<>'admin_test'`,
      v.orderId ? eq2(orders.id, v.orderId) : void 0,
      v.status === "all" ? void 0 : eq2(orders.status, v.status)
    )).orderBy(asc(orders.createdAt), asc(orders.id)).limit(1001).all();
  } else if (v.kind === "recoveries") {
    columns = ["record_id", "kind", "order_id", "case_id", "request_id", "shipment_id", "receipt_id", "verification_id", "created_at_utc", "target_name", "target_sku", "currency", "quantity", "adjustment_minor", "amount_minor", "disposition", "restock", "carrier", "tracking_number", "recorded_status", "actor", "reason"];
    rows = await db.all(sql5`${recoveryJournal(sql5`(${v.orderId}='' OR c.order_id=${v.orderId})`, sql5`(${v.orderId}='' OR r.order_id=${v.orderId})`)} SELECT * FROM journal WHERE created_at_utc>=${from} AND created_at_utc<${to} ORDER BY created_at_utc,${recoveryKindOrder(sql5`kind`)},record_id LIMIT 1001`);
  } else if (v.kind === "returns") {
    columns = ["receipt_id", "request_id", "order_id", "created_at_utc", "line_index", "quantity", "condition", "restock_selected", "awaiting_inspection", "actor", "reason"];
    rows = await db.all(sql5`SELECT r.id AS receipt_id,l.request_id,r.order_id,r.created_at AS created_at_utc,json_extract(i.value,'$.lineIndex') AS line_index,json_extract(i.value,'$.quantity') AS quantity,json_extract(i.value,'$.condition') AS condition,json_extract(i.value,'$.restock') AS restock_selected,
    CASE WHEN json_extract(i.value,'$.condition')='inspection' THEN json_extract(i.value,'$.quantity')-COALESCE((SELECT sum(json_extract(a.value,'$.quantity')) FROM _ecommerce_return_inspections d,json_each(d.items) a WHERE d.receipt_id=r.id AND json_extract(a.value,'$.lineIndex')=json_extract(i.value,'$.lineIndex')),0) ELSE 0 END AS awaiting_inspection,r.actor,r.reason
    FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id LEFT JOIN _ecommerce_return_request_receipts l ON l.receipt_id=r.id,json_each(r.items) i
    WHERE r.created_at>=${from} AND r.created_at<${to} AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND (${v.orderId}='' OR r.order_id=${v.orderId}) ORDER BY r.created_at,r.id,line_index LIMIT 1001`);
  } else {
    columns = ["movement_id", "created_at_utc", "kind", "target_type", "target_id", "delta", "before_quantity", "after_quantity", "order_id", "actor", "reason"];
    const inventory = sql5`SELECT r.id AS movement_id,o.created_at AS created_at_utc,'checkout_hold' AS kind,r.target_type,r.target_id,-r.quantity AS delta,NULL AS before_quantity,NULL AS after_quantity,r.order_id,NULL AS actor,'Checkout stock reservation' AS reason FROM _ecommerce_inventory_reservations r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
      UNION ALL SELECT r.id||'_release',r.released_at,'checkout_release',r.target_type,r.target_id,r.quantity,NULL,NULL,r.order_id,NULL,'Cancelled checkout stock release' FROM _ecommerce_inventory_reservations r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE r.released_at IS NOT NULL AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND NOT EXISTS(SELECT 1 FROM _ecommerce_restocks x WHERE x.reservation_type='inventory' AND x.reservation_id=r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_stock x WHERE x.reservation_type='inventory' AND x.reservation_id=r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_inspection_stock x WHERE x.reservation_type='inventory' AND x.reservation_id=r.id)`;
    const component = sql5`SELECT r.id AS movement_id,o.created_at AS created_at_utc,'checkout_hold' AS kind,'component' AS target_type,r.component_id AS target_id,-r.quantity AS delta,NULL AS before_quantity,NULL AS after_quantity,r.order_id,NULL AS actor,'Checkout component reservation' AS reason FROM _ecommerce_component_reservations r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
      UNION ALL SELECT r.id||'_release',r.released_at,'checkout_release','component',r.component_id,r.quantity,NULL,NULL,r.order_id,NULL,'Cancelled checkout component release' FROM _ecommerce_component_reservations r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE r.released_at IS NOT NULL AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND NOT EXISTS(SELECT 1 FROM _ecommerce_restocks x WHERE x.reservation_type='component' AND x.reservation_id=r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_stock x WHERE x.reservation_type='component' AND x.reservation_id=r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_inspection_stock x WHERE x.reservation_type='component' AND x.reservation_id=r.id)`;
    const restored = sql5`SELECT s.id AS movement_id,r.created_at AS created_at_utc,'return' AS kind,s.target_type,s.target_id,s.quantity AS delta,NULL AS before_quantity,NULL AS after_quantity,s.order_id,r.actor,r.reason FROM _ecommerce_return_stock s JOIN _ecommerce_return_receipts r ON r.id=s.receipt_id
      UNION ALL SELECT s.id,r.created_at,'inspection',s.target_type,s.target_id,s.quantity,NULL,NULL,s.order_id,r.actor,r.reason FROM _ecommerce_inspection_stock s JOIN _ecommerce_return_inspections r ON r.id=s.inspection_id`;
    rows = await db.all(sql5`WITH inventory AS (${inventory}),component AS (${component}),restored AS (${restored}),events AS (
      SELECT m.id AS movement_id,m.created_at AS created_at_utc,m.kind,m.target_type,m.target_id,m.delta,m.before_quantity,m.after_quantity,COALESCE((SELECT c.order_id FROM _ecommerce_recovery_shipments s JOIN _ecommerce_recovery_cases c ON c.id=s.case_id,json_each(s.stock) t WHERE m.id=s.id||'_'||t.key),(SELECT c.order_id FROM _ecommerce_recovery_inspections i JOIN _ecommerce_recovery_receipts r ON r.id=i.receipt_id JOIN _ecommerce_recovery_shipments s ON s.id=r.shipment_id JOIN _ecommerce_recovery_cases c ON c.id=s.case_id,json_each(i.stock) t WHERE m.id=i.id||'_'||t.key)) AS order_id,m.actor,m.reason FROM _ecommerce_stock_movements m
      UNION ALL SELECT * FROM restored
      UNION ALL SELECT id,created_at,'restock',target_type,target_id,quantity,NULL,NULL,order_id,admin_actor,reason FROM _ecommerce_restocks
      UNION ALL SELECT * FROM inventory UNION ALL SELECT * FROM component)
      SELECT * FROM events WHERE (order_id IS NULL OR EXISTS(SELECT 1 FROM _ecommerce_orders o WHERE o.id=events.order_id AND COALESCE(o.payment_provider,'stripe')<>'admin_test')) AND created_at_utc>=${from} AND created_at_utc<${to} AND (${v.orderId}='' OR order_id=${v.orderId}) AND (${v.targetType}='all' OR target_type=${v.targetType}) AND (${v.targetId}='' OR target_id=${v.targetId}) ORDER BY created_at_utc,movement_id LIMIT 1001`);
  }
  if (rows.length > 1e3) throw new OperationsExportLimit("This selection exceeds 1,000 rows. Narrow the dates or filters; no partial file was created.");
  for (const row of rows) row.created_at_utc = new Date(Number(row.created_at_utc) * 1e3).toISOString();
  return { filename: `commerce-${v.kind}-${v.from}-${v.to}.csv`, rows: rows.length, csv: "\uFEFF" + [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((c) => csvCell(row[c] ?? null)).join(","))].join("\r\n") + "\r\n" };
}

// src/refund-follow-up.ts
import { eq as eq3, sql as sql6 } from "drizzle-orm";
import { z as z5 } from "zod";
var id2 = z5.string().trim().min(1).max(128);
var reason2 = z5.string().trim().min(8).max(500);
var sourceRows = sql6`SELECT 'provider' AS kind,id,order_id,amount_cents,created_at FROM _ecommerce_provider_refunds
 UNION ALL SELECT 'gift_card',id,order_id,amount_cents,created_at FROM _ecommerce_gift_card_ledger WHERE kind='refund_restore'
 UNION ALL SELECT 'store_credit',id,order_id,amount_cents,created_at FROM _ecommerce_credit_ledger WHERE kind='purchase_credit_refund'`;
async function listRefundFollowUp(env, input = {}) {
  const v = z5.object({ offset: z5.coerce.number().int().min(0).max(1e6).default(0), filter: z5.enum(["active", "review", "needed", "resolved", "all"]).default("active"), orderId: z5.string().trim().max(128).default("") }).strict().parse(input), db = commerceDb(env);
  const cte = sql6`WITH cases AS (SELECT r.id,r.order_id AS orderId,o.currency,r.created_at AS createdAt,
 CASE WHEN EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a WHERE a.account_id=o.user_id AND a.action='anonymize') THEN 'unavailable' ELSE COALESCE((SELECT status FROM _ecommerce_return_refund_decisions d WHERE d.receipt_id=r.id ORDER BY rowid DESC LIMIT 1),'review') END AS status,
 COALESCE((SELECT amount_minor FROM _ecommerce_return_refund_decisions d WHERE d.receipt_id=r.id ORDER BY rowid DESC LIMIT 1),0) AS amountMinor
 FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test')`;
  const where = sql6`(${v.orderId}='' OR orderId=${v.orderId}) AND (${v.filter}='all' OR (${v.filter}='active' AND status IN ('review','needed')) OR (${v.filter}='resolved' AND status IN ('settled','not_needed','unavailable')) OR status=${v.filter})`;
  const [rows, count] = await db.batch([db.all(sql6`${cte} SELECT * FROM cases WHERE ${where} ORDER BY createdAt,id LIMIT 50 OFFSET ${v.offset}`), db.all(sql6`${cte} SELECT count(*) n FROM cases WHERE ${where}`)]);
  return { ...v, total: count[0]?.n ?? 0, rows: rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt * 1e3).toISOString() })) };
}
async function readRefundCase(env, input) {
  const v = z5.object({ receiptId: id2 }).strict().parse(input), db = commerceDb(env);
  const r = await db.query.returnReceipts.findFirst({ where: { id: v.receiptId }, with: { order: { columns: { id: true, items: true, currency: true, paymentProvider: true, userId: true } }, refundDecisions: { orderBy: (_t, { sql: sql10 }) => sql10`rowid` } } });
  if (!r || r.order.paymentProvider === "admin_test") throw new CommerceOperationsConflict("Received return is unavailable.");
  const [sources, names, items] = await Promise.all([db.all(sql6`WITH sources AS (${sourceRows}) SELECT kind,id,amount_cents AS amountMinor,created_at AS createdAt,
 amount_cents-COALESCE((SELECT sum(json_extract(a.value,'$.amountMinor')) FROM _ecommerce_return_refund_decisions d,json_each(d.allocations) a WHERE d.status='settled' AND json_extract(a.value,'$.kind')=sources.kind AND json_extract(a.value,'$.sourceId')=sources.id),0) AS availableMinor FROM sources WHERE order_id=${r.orderId} ORDER BY created_at,id`), adminActorNames(env, r.refundDecisions.map((d) => d.actor)), describeOrderItems(env, r.items.map((i) => ({ ...r.order.items[i.lineIndex], quantity: i.quantity })))]);
  const latest = r.refundDecisions.at(-1), erased = r.order.userId ? await db.select({ id: shopperAudits.id }).from(shopperAudits).where(sql6`${shopperAudits.accountId}=${r.order.userId} AND ${shopperAudits.action}='anonymize'`).limit(1).get() : null;
  return {
    receiptId: r.id,
    orderId: r.orderId,
    currency: r.order.currency,
    version: latest?.id ?? r.id,
    status: erased ? "unavailable" : latest?.status ?? "review",
    amountMinor: latest?.amountMinor ?? 0,
    items: items.map((i) => ({ name: [i.productName || "Ordered item", i.variantLabel].filter(Boolean).join(" / "), quantity: i.quantity })),
    history: r.refundDecisions.map((d) => ({ id: d.id, status: d.status, amountMinor: d.amountMinor, allocations: d.allocations, reason: d.reason, actor: d.actor, actorName: names.get(d.actor) ?? d.actor, createdAt: d.createdAt.toISOString() })),
    sources: sources.map((s) => ({ ...s, createdAt: s.createdAt === null ? null : new Date(s.createdAt * 1e3).toISOString() }))
  };
}
var decision = z5.object({
  receiptId: id2,
  requestKey: id2.min(8),
  expectedVersion: id2,
  status: z5.enum(RETURN_REFUND_STATUSES),
  amountMinor: z5.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  allocations: z5.array(z5.object({ kind: z5.enum(REFUND_SOURCE_KINDS), sourceId: id2, amountMinor: z5.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict()).max(20).default([]),
  reason: reason2
}).strict().refine((v) => v.status === "not_needed" ? v.amountMinor === 0 && !v.allocations.length : v.amountMinor > 0 && (v.status === "settled" ? v.allocations.length > 0 && v.allocations.reduce((n, a) => n + a.amountMinor, 0) === v.amountMinor : !v.allocations.length), "Choose an amount and matching confirmed refund allocations");
async function recordRefundFollowUp(env, input, actor) {
  const v = decision.parse(input);
  if (!actor.trim()) throw new CommerceOperationsConflict("An authenticated staff member is required.");
  const allocations = [...v.allocations].sort((a, b) => `${a.kind}:${a.sourceId}`.localeCompare(`${b.kind}:${b.sourceId}`));
  const db = commerceDb(env), decisionId = `rrf_${await hashOrderAccess(`${v.receiptId}:${v.requestKey}`)}`, fingerprint = await hashOrderAccess(JSON.stringify({ ...v, allocations, actor }));
  const replay = async () => {
    const d = await db.select().from(returnRefundDecisions).where(eq3(returnRefundDecisions.id, decisionId)).get();
    if (!d) return null;
    if (d.fingerprint !== fingerprint) throw new CommerceOperationsConflict("This refund decision key was used with other details.");
    return { decisionId, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  try {
    await db.batch([db.insert(returnRefundDecisions).values({ id: decisionId, receiptId: v.receiptId, expectedVersion: v.expectedVersion, status: v.status, amountMinor: v.amountMinor, allocations, actor, reason: v.reason, fingerprint, createdAt: /* @__PURE__ */ new Date() }), ...v.status === "settled" ? [db.run(commerceEmailStatement("return_refund", decisionId, Math.floor(Date.now() / 1e3)))] : []]);
  } catch (error) {
    const previous2 = await replay();
    if (previous2) return previous2;
    if (!/Refund follow-up|Confirmed refunds/.test(errorText(error))) throw error;
    throw new CommerceOperationsConflict("This return or confirmed refund balance changed. Refresh before recording a decision.");
  }
  return { decisionId };
}

// src/purchasing.ts
import { eq as eq4, sql as sql7 } from "drizzle-orm";
import { z as z6 } from "zod";
var id3 = z6.string().trim().min(1).max(128);
var key = id3.min(8);
var reason3 = z6.string().trim().min(8).max(500);
var date = z6.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && (/* @__PURE__ */ new Date(`${v}T00:00:00Z`)).toISOString().slice(0, 10) === v);
var lineInput = z6.object({ targetType: z6.enum(RESTOCK_TARGET_TYPES), targetId: id3, quantity: z6.number().int().min(1).max(1e6) }).strict();
var linesInput = z6.array(lineInput).min(1).max(20).refine((rows) => new Set(rows.map((r) => `${r.targetType}:${r.targetId}`)).size === rows.length, "Choose each stock pool once");
var supplierInput = z6.object({ supplierId: id3.nullable(), expectedVersion: id3.nullable(), requestKey: key, name: z6.string().trim().min(1).max(200), contact: z6.string().trim().max(500), address: z6.string().trim().max(1e3), active: z6.boolean(), reason: reason3 }).strict();
var draftInput = z6.object({ purchaseOrderId: id3.nullable(), expectedVersion: id3.nullable(), requestKey: key, supplierId: id3, supplierVersion: id3, reference: z6.string().trim().min(1).max(200), expectedDate: date, lines: linesInput, reason: reason3 }).strict();
var actionInput = z6.object({ purchaseOrderId: id3, expectedVersion: id3, requestKey: key, action: z6.enum(["order", "reschedule", "cancel"]), supplierVersion: id3.optional(), expectedDate: date.optional(), reason: reason3 }).strict().refine((v) => v.action === "reschedule" === (v.expectedDate !== void 0) && v.action === "order" === (v.supplierVersion !== void 0));
async function identity2(input, actor, prefix) {
  if (!actor.trim()) throw new CommerceOperationsConflict("An authenticated staff member is required.");
  return { id: `${prefix}_${await hashOrderAccess(input.requestKey)}`, fingerprint: await hashOrderAccess(JSON.stringify({ input, actor })) };
}
async function conflict(write, replay) {
  try {
    await write();
  } catch (error) {
    const previous = await replay();
    if (previous) return previous;
    if (!/Purchasing|Replenishment|UNIQUE constraint/.test(errorText(error))) throw error;
    throw new CommerceOperationsConflict("The supplier, purchase order or delivery changed. Refresh before continuing.");
  }
  return null;
}
async function listSuppliers(env, input = {}) {
  const v = z6.object({ offset: z6.coerce.number().int().min(0).max(1e6).default(0), filter: z6.enum(["active", "all"]).default("active"), search: z6.string().trim().max(100).default("") }).strict().parse(input), db = commerceDb(env);
  const pattern = `%${v.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const where = sql7`r.rowid=(SELECT rowid FROM _ecommerce_supplier_revisions WHERE supplier_id=r.supplier_id ORDER BY rowid DESC LIMIT 1) AND (${v.filter}='all' OR r.active=1) AND r.name LIKE ${pattern} ESCAPE '\\'`;
  const [rows, count] = await db.batch([db.all(sql7`SELECT r.supplier_id AS id,r.id AS version,r.name,r.contact,r.address,r.active FROM _ecommerce_supplier_revisions r WHERE ${where} ORDER BY r.name,r.supplier_id LIMIT 50 OFFSET ${v.offset}`), db.all(sql7`SELECT count(*) n FROM _ecommerce_supplier_revisions r WHERE ${where}`)]);
  return { ...v, total: count[0]?.n ?? 0, rows: rows.map((r) => ({ ...r, active: !!r.active })) };
}
async function saveSupplier(env, input, actor) {
  const v = supplierInput.parse(input), db = commerceDb(env), ident = await identity2(v, actor, "suprev"), supplierId = v.supplierId ?? `sup_${await hashOrderAccess(v.requestKey)}`;
  const replay = async () => {
    const r = await db.select().from(supplierRevisions).where(eq4(supplierRevisions.id, ident.id)).get();
    if (!r) return null;
    if (r.fingerprint !== ident.fingerprint) throw new CommerceOperationsConflict("This supplier key was used with different details.");
    return { supplierId: r.supplierId, revisionId: r.id, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const failure = await conflict(() => commitBatch(db, [...!v.supplierId ? [db.insert(suppliers).values({ id: supplierId, createdAt: /* @__PURE__ */ new Date() })] : [], db.insert(supplierRevisions).values({ ...ident, supplierId, expectedVersion: v.expectedVersion, name: v.name, contact: v.contact, address: v.address, active: v.active, actor, reason: v.reason, createdAt: /* @__PURE__ */ new Date() })]), replay);
  return failure ?? { supplierId, revisionId: ident.id };
}
var latestSupplier = (env, supplierId) => commerceDb(env).query.supplierRevisions.findFirst({ where: { supplierId }, orderBy: (_t, { sql: sql10 }) => sql10`rowid DESC` });
var supplierSnapshot = (s) => ({ version: s.id, name: s.name, contact: s.contact, address: s.address });
async function savePurchaseOrder(env, input, actor) {
  const v = draftInput.parse(input), db = commerceDb(env), ident = await identity2(v, actor, "poe"), purchaseOrderId = v.purchaseOrderId ?? `po_${await hashOrderAccess(v.requestKey)}`;
  const replay = eventReplay(db, ident);
  const previous = await replay();
  if (previous) return previous;
  const supplier = await latestSupplier(env, v.supplierId);
  if (!supplier?.active || supplier.id !== v.supplierVersion) throw new CommerceOperationsConflict("Supplier changed or is inactive. Refresh before continuing.");
  const lines = [];
  for (const l of [...v.lines].sort((a, b) => `${a.targetType}:${a.targetId}`.localeCompare(`${b.targetType}:${b.targetId}`))) {
    const stock2 = await db.get(sql7`WITH physical AS (${physicalStockLocations}) SELECT name,sku FROM physical WHERE type=${l.targetType} AND id=${l.targetId}`);
    if (!stock2) throw new CommerceOperationsConflict("A stock pool is unavailable. Refresh before continuing.");
    lines.push({ ...l, ...stock2 });
  }
  if (v.purchaseOrderId) {
    const order = await db.select().from(purchaseOrders).where(eq4(purchaseOrders.id, v.purchaseOrderId)).get();
    if (order?.supplierId !== v.supplierId) throw new CommerceOperationsConflict("The purchase order supplier cannot be changed.");
  }
  const failure = await conflict(() => commitBatch(db, [...!v.purchaseOrderId ? [db.insert(purchaseOrders).values({ id: purchaseOrderId, supplierId: v.supplierId, createdAt: /* @__PURE__ */ new Date() })] : [], db.insert(purchaseOrderEvents).values({ ...ident, purchaseOrderId, expectedVersion: v.expectedVersion, status: "draft", reference: v.reference, expectedDate: v.expectedDate, lines, supplier: supplierSnapshot(supplier), actor, reason: v.reason, createdAt: /* @__PURE__ */ new Date() })]), replay);
  return failure ?? { purchaseOrderId, eventId: ident.id };
}
function eventReplay(db, ident) {
  return async () => {
    const r = await db.select().from(purchaseOrderEvents).where(eq4(purchaseOrderEvents.id, ident.id)).get();
    if (!r) return null;
    if (r.fingerprint !== ident.fingerprint) throw new CommerceOperationsConflict("This purchase order key was used with different details.");
    return { purchaseOrderId: r.purchaseOrderId, eventId: r.id, duplicate: true };
  };
}
async function recordPurchaseOrder(env, input, actor) {
  const v = actionInput.parse(input), db = commerceDb(env), ident = await identity2(v, actor, "poe"), replay = eventReplay(db, ident), previous = await replay();
  if (previous) return previous;
  const order = await db.query.purchaseOrders.findFirst({ where: { id: v.purchaseOrderId }, with: { events: { orderBy: (_t, { sql: sql10 }) => sql10`rowid` }, lines: { with: { delivery: { with: { events: { orderBy: (_t, { sql: sql10 }) => sql10`rowid`, with: { movement: { columns: { delta: true } } } } } } } } } });
  const last = order?.events.at(-1);
  if (!order || !last || last.id !== v.expectedVersion || last.status === "cancelled") throw new CommerceOperationsConflict("Purchase order changed. Refresh before continuing.");
  const statements = [], now = /* @__PURE__ */ new Date();
  let supplier = last.supplier;
  if (v.action === "order") {
    if (last.status !== "draft") throw new CommerceOperationsConflict("This purchase order has already been confirmed.");
    const current = await latestSupplier(env, order.supplierId);
    if (!current?.active || current.id !== v.supplierVersion) throw new CommerceOperationsConflict("Supplier changed or is inactive. Refresh before continuing.");
    supplier = supplierSnapshot(current);
    for (const [index, line] of last.lines.entries()) {
      const deliveryId = `pod_${await hashOrderAccess(`${order.id}:${index}`)}`;
      statements.push(db.insert(replenishmentDeliveries).values({ id: deliveryId, targetType: line.targetType, targetId: line.targetId, quantity: line.quantity, supplier: supplier.name, reference: last.reference, expectedDate: last.expectedDate, actor, reason: v.reason, fingerprint: ident.fingerprint, createdAt: now }), db.insert(purchaseOrderLines).values({ id: deliveryId, purchaseOrderId: order.id, lineIndex: index, deliveryId }));
    }
  } else if (v.action === "reschedule" && last.status !== "ordered") throw new CommerceOperationsConflict("Only confirmed purchase orders can be rescheduled.");
  if (v.action === "cancel" && last.status === "ordered") {
    for (const l of order.lines) {
      const received = l.delivery.events.reduce((n, e) => n + (e.movement?.delta ?? 0), 0);
      if (l.delivery.events.some((e) => e.kind === "cancelled") || received >= l.delivery.quantity) continue;
      statements.push(db.insert(replenishmentDeliveryEvents).values({ id: `poc_${await hashOrderAccess(`${ident.id}:${l.id}`)}`, deliveryId: l.deliveryId, kind: "cancelled", movementId: null, expectedVersion: l.delivery.events.at(-1)?.id ?? l.deliveryId, actor, reason: v.reason, fingerprint: ident.fingerprint, createdAt: now }));
    }
    if (!statements.length) throw new CommerceOperationsConflict("There are no outstanding units to cancel.");
  }
  statements.push(db.insert(purchaseOrderEvents).values({ ...ident, purchaseOrderId: order.id, expectedVersion: last.id, status: v.action === "cancel" ? "cancelled" : "ordered", reference: last.reference, expectedDate: v.expectedDate ?? last.expectedDate, lines: last.lines, supplier, actor, reason: v.reason, createdAt: now }));
  const failure = await conflict(() => commitBatch(db, statements), replay);
  return failure ?? { purchaseOrderId: order.id, eventId: ident.id };
}
var queueCte = sql7`WITH latest AS (SELECT p.id,p.supplier_id AS supplierId,p.created_at AS createdAt,e.id AS version,e.status,e.reference,e.expected_date AS expectedDate,json_extract(e.supplier,'$.name') AS supplier,
 (SELECT count(*) FROM _ecommerce_supplier_issues i JOIN _ecommerce_purchase_order_lines l ON l.id=i.purchase_line_id WHERE l.purchase_order_id=p.id AND ${openSupplierIssue}) AS openIssues,
 COALESCE((SELECT sum(MAX(0,d.quantity-COALESCE((SELECT sum(m.delta) FROM _ecommerce_replenishment_delivery_events x JOIN _ecommerce_stock_movements m ON m.id=x.movement_id WHERE x.delivery_id=d.id),0))) FROM _ecommerce_purchase_order_lines l JOIN _ecommerce_replenishment_deliveries d ON d.id=l.delivery_id WHERE l.purchase_order_id=p.id AND NOT EXISTS(SELECT 1 FROM _ecommerce_replenishment_delivery_events x WHERE x.delivery_id=d.id AND x.kind='cancelled')),0) AS outstanding
 FROM _ecommerce_purchase_orders p JOIN _ecommerce_purchase_order_events e ON e.id=(SELECT id FROM _ecommerce_purchase_order_events WHERE purchase_order_id=p.id ORDER BY rowid DESC LIMIT 1))`;
async function listPurchaseOrders(env, input = {}) {
  const v = z6.object({ offset: z6.coerce.number().int().min(0).max(1e6).default(0), filter: z6.enum(["open", "draft", "ordered", "completed", "cancelled", "all"]).default("open"), search: z6.string().trim().max(100).default("") }).strict().parse(input), db = commerceDb(env);
  const pattern = `%${v.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, where = sql7`(reference LIKE ${pattern} ESCAPE '\\' OR supplier LIKE ${pattern} ESCAPE '\\') AND (${v.filter}='all' OR (${v.filter}='open' AND (status='draft' OR (status='ordered' AND outstanding>0) OR openIssues>0)) OR (${v.filter}='completed' AND status='ordered' AND outstanding=0) OR (${v.filter} IN ('draft','ordered','cancelled') AND status=${v.filter}))`;
  const [rows, count] = await db.batch([db.all(sql7`${queueCte} SELECT * FROM latest WHERE ${where} ORDER BY createdAt DESC,id LIMIT 50 OFFSET ${v.offset}`), db.all(sql7`${queueCte} SELECT count(*) n FROM latest WHERE ${where}`)]);
  return { ...v, total: count[0]?.n ?? 0, rows: rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt * 1e3).toISOString() })) };
}
async function readPurchaseOrder(env, input) {
  const { purchaseOrderId } = z6.object({ purchaseOrderId: id3 }).strict().parse(input), db = commerceDb(env);
  const order = await db.query.purchaseOrders.findFirst({ where: { id: purchaseOrderId }, with: { events: { orderBy: (_t, { sql: sql10 }) => sql10`rowid DESC`, limit: 200 }, lines: { with: { delivery: { with: { events: { orderBy: (_t, { sql: sql10 }) => sql10`rowid`, with: { movement: { columns: { delta: true } } } } } } } } } });
  const latest = order?.events[0];
  if (!order || !latest) throw new CommerceOperationsConflict("Purchase order not found.");
  const names = await adminActorNames(env, order.events.map((e) => e.actor)), current = await latestSupplier(env, order.supplierId);
  const deliveries = await Promise.all(order.lines.map(async (l) => {
    const d = l.delivery, stock2 = await db.get(sql7`WITH physical AS (${physicalStockLocations}) SELECT * FROM physical WHERE type=${d.targetType} AND id=${d.targetId}`), received = d.events.reduce((n, e) => n + (e.movement?.delta ?? 0), 0), cancelled = d.events.some((e) => e.kind === "cancelled");
    const activeIssues = await db.get(sql7`SELECT COALESCE(sum(quantity),0) AS units FROM _ecommerce_supplier_issues i WHERE purchase_line_id=${l.id} AND ${openSupplierIssue}`);
    return { purchaseLineId: l.id, issueAllowance: cancelled ? 0 : Math.max(0, d.quantity - received - (activeIssues?.units ?? 0)), lineIndex: l.lineIndex, deliveryId: d.id, version: d.events.at(-1)?.id ?? d.id, received, remaining: cancelled ? 0 : d.quantity - received, cancelled, location: stock2 ? { type: stock2.type, id: stock2.id, name: stock2.name, sku: stock2.sku, quantity: stock2.quantity, updatedAt: new Date(stock2.updated * 1e3).toISOString() } : null };
  }));
  return {
    id: order.id,
    supplierId: order.supplierId,
    currentSupplier: current ? { ...supplierSnapshot(current), active: current.active } : null,
    version: latest.id,
    status: latest.status,
    reference: latest.reference,
    expectedDate: latest.expectedDate,
    supplier: latest.supplier,
    lines: latest.lines,
    deliveries,
    history: [...order.events].reverse().map((e) => ({ id: e.id, status: e.status, reference: e.reference, expectedDate: e.expectedDate, lines: e.lines, actorName: names.get(e.actor) ?? e.actor, reason: e.reason, createdAt: e.createdAt.toISOString() })),
    historyTruncated: order.events.length === 200
  };
}

// src/operations-report.ts
import { sql as sql8 } from "drizzle-orm";
import { z as z7 } from "zod";
var day2 = z7.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && (/* @__PURE__ */ new Date(`${v}T00:00:00Z`)).toISOString().slice(0, 10) === v);
async function readOperationsReport(env, input = {}) {
  const now = Math.floor(Date.now() / 1e3), today = new Date(now * 1e3).toISOString().slice(0, 10);
  const v = z7.object({ start: day2.default(new Date((now - 29 * 86400) * 1e3).toISOString().slice(0, 10)), end: day2.default(today) }).strict().refine((v2) => v2.start <= v2.end && (Date.parse(v2.end) - Date.parse(v2.start)) / 864e5 < 366, "Choose at most 366 UTC days").parse(input);
  const start = Date.parse(v.start) / 1e3, end = Date.parse(v.end) / 1e3 + 86400, db = commerceDb(env), period = (column) => sql8`${column}>=${start} AND ${column}<${end}`;
  const [reasons, conditions, resolved, shipping, incoming, backlog, recoveryActivity, exchangeMoney, recoveryWork] = await db.batch([
    db.all(sql8`SELECT COALESCE(c.code,'unspecified') AS code,count(*) AS requests FROM _ecommerce_return_requests r JOIN _ecommerce_orders o ON o.id=r.order_id LEFT JOIN _ecommerce_return_request_reasons c ON c.request_id=r.id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND ${period(sql8`r.created_at`)} GROUP BY COALESCE(c.code,'unspecified')`),
    db.all(sql8`SELECT json_extract(i.value,'$.condition') AS condition,sum(json_extract(i.value,'$.quantity')) AS units,count(DISTINCT r.id) AS receipts FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id,json_each(r.items) i WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND ${period(sql8`r.created_at`)} GROUP BY json_extract(i.value,'$.condition')`),
    db.all(sql8`SELECT d.status,count(*) AS returns,avg(MAX(0,d.created_at-r.created_at)) AS averageSeconds FROM _ecommerce_return_refund_decisions d JOIN _ecommerce_return_receipts r ON r.id=d.receipt_id JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND d.status IN ('settled','not_needed') AND d.rowid=(SELECT rowid FROM _ecommerce_return_refund_decisions WHERE receipt_id=d.receipt_id ORDER BY rowid DESC LIMIT 1) AND ${period(sql8`d.created_at`)} GROUP BY d.status`),
    db.all(sql8`WITH dispatched AS (SELECT f.order_id,min(f.created_at) AS shippedAt,(SELECT min(created_at) FROM _ecommerce_payments p WHERE p.order_id=f.order_id AND p.status IN ('success','partially_refunded','refunded')) AS paidAt FROM _ecommerce_fulfillments f JOIN _ecommerce_orders o ON o.id=f.order_id WHERE f.kind='shipment' AND COALESCE(o.payment_provider,'stripe')<>'admin_test' GROUP BY f.order_id) SELECT count(*) AS orders,avg(MAX(0,shippedAt-paidAt)) AS averageSeconds FROM dispatched WHERE paidAt IS NOT NULL AND ${period(sql8`shippedAt`)} AND shippedAt>=paidAt`),
    db.all(sql8`WITH incoming AS (SELECT d.id,${effectiveDeliveryDate} AS due,MAX(0,d.quantity-COALESCE((SELECT sum(m.delta) FROM _ecommerce_replenishment_delivery_events e JOIN _ecommerce_stock_movements m ON m.id=e.movement_id WHERE e.delivery_id=d.id),0)) AS remaining FROM _ecommerce_replenishment_deliveries d WHERE NOT EXISTS(SELECT 1 FROM _ecommerce_replenishment_delivery_events e WHERE e.delivery_id=d.id AND e.kind='cancelled')) SELECT count(*) AS deliveries,COALESCE(sum(remaining),0) AS units,min(due) AS oldestDate FROM incoming WHERE remaining>0 AND due<${today}`),
    db.all(sql8`WITH work AS (
   SELECT 'shipping' AS kind,o.id,COALESCE((SELECT min(created_at) FROM _ecommerce_payments p WHERE p.order_id=o.id AND p.status IN ('success','partially_refunded','refunded')),o.created_at) AS since FROM _ecommerce_orders o WHERE o.status IN ('paid','partially_refunded') AND o.fulfillment_status<>'fulfilled' AND COALESCE(o.payment_provider,'stripe')<>'admin_test'
   UNION ALL SELECT 'refund',r.id,r.created_at FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND NOT EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a WHERE a.account_id=o.user_id AND a.action='anonymize') AND COALESCE((SELECT status FROM _ecommerce_return_refund_decisions d WHERE d.receipt_id=r.id ORDER BY rowid DESC LIMIT 1),'review') IN ('review','needed')
   UNION ALL SELECT 'returns',r.id,r.created_at FROM _ecommerce_return_requests r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE r.redacted_at IS NULL AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND COALESCE((SELECT status FROM _ecommerce_return_request_events e WHERE e.request_id=r.id ORDER BY rowid DESC LIMIT 1),'pending') IN ('pending','approved')
   UNION ALL SELECT 'supplier',i.id,i.created_at FROM _ecommerce_supplier_issues i WHERE ${openSupplierIssue}
   UNION ALL SELECT 'recovery',c.id,c.created_at FROM _ecommerce_recovery_cases c WHERE ${openRecoveryCase}) SELECT kind,count(*) AS count,min(since) AS oldestAt FROM work GROUP BY kind`),
    db.all(sql8`${recoveryJournal()} SELECT kind,currency,disposition,restock,count(*) AS records,COALESCE(sum(quantity),0) AS units FROM journal WHERE ${period(sql8`created_at_utc`)} GROUP BY kind,currency,disposition,restock ORDER BY kind,currency,disposition,restock`),
    db.all(sql8`WITH money AS (
   SELECT 'upgrade_verified' AS kind,p.currency,p.amount_minor AS amount,p.created_at FROM _ecommerce_recovery_payments p JOIN _ecommerce_recovery_cases c ON c.id=p.case_id JOIN _ecommerce_orders o ON o.id=c.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
   UNION ALL SELECT 'cheaper_refund_confirmed',o.currency,d.amount_minor,d.created_at FROM _ecommerce_return_refund_decisions d JOIN _ecommerce_recovery_cases c ON c.receipt_id=d.receipt_id JOIN _ecommerce_orders o ON o.id=c.order_id WHERE c.kind='exchange' AND COALESCE(json_extract(c.target,'$.adjustmentMinor'),0)<0 AND d.status='settled' AND d.rowid=(SELECT max(rowid) FROM _ecommerce_return_refund_decisions WHERE receipt_id=d.receipt_id) AND COALESCE(o.payment_provider,'stripe')<>'admin_test'
   UNION ALL SELECT 'upgrade_'||e.kind,p.currency,NULL,e.created_at FROM _ecommerce_recovery_payment_events e JOIN _ecommerce_recovery_payments p ON p.id=e.payment_id JOIN _ecommerce_recovery_cases c ON c.id=p.case_id JOIN _ecommerce_orders o ON o.id=c.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test') SELECT kind,currency,count(*) AS records,sum(amount) AS amountMinor FROM money WHERE ${period(sql8`created_at`)} GROUP BY kind,currency ORDER BY kind,currency`),
    db.all(sql8`SELECT
   (SELECT COALESCE(sum(r.quantity-COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_inspections WHERE receipt_id=r.id),0)),0) FROM _ecommerce_recovery_receipts r JOIN _ecommerce_recovery_shipments s ON s.id=r.shipment_id JOIN _ecommerce_recovery_cases c ON c.id=s.case_id JOIN _ecommerce_orders o ON o.id=c.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test') AS inspectionUnits,
   (SELECT count(*) FROM _ecommerce_recovery_cases c JOIN _ecommerce_orders o ON o.id=c.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=c.id AND actor='payment_provider'),0)>COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=c.id AND kind='resolve'),0)) AS paymentReviews`)
  ]);
  return {
    ...v,
    recoveryActivity,
    exchangeMoney,
    recoveryWork: recoveryWork[0] ?? { inspectionUnits: 0, paymentReviews: 0 },
    startAt: new Date(start * 1e3).toISOString(),
    endBefore: new Date(end * 1e3).toISOString(),
    asOf: new Date(now * 1e3).toISOString(),
    reasons,
    conditions,
    resolutions: resolved.map((r) => ({ ...r, averageHours: r.averageSeconds / 3600 })),
    firstShipment: { orders: shipping[0]?.orders ?? 0, averageHours: shipping[0]?.averageSeconds == null ? null : shipping[0].averageSeconds / 3600 },
    overdueDeliveries: incoming[0] ?? { deliveries: 0, units: 0, oldestDate: null },
    backlog: backlog.map((r) => ({ kind: r.kind, count: r.count, oldestAt: r.oldestAt === null ? null : new Date(r.oldestAt * 1e3).toISOString(), oldestHours: r.oldestAt === null ? null : Math.max(0, now - r.oldestAt) / 3600 }))
  };
}

// src/replacement-returns.ts
import { eq as eq5 } from "drizzle-orm";
import { z as z8 } from "zod";
var id4 = z8.string().trim().min(1).max(128);
var quantity = z8.number().int().min(1).max(1e6);
var reason4 = z8.string().trim().min(8).max(500);
var stock = z8.array(z8.object({
  targetType: z8.enum(RESTOCK_TARGET_TYPES),
  targetId: id4,
  expectedQuantity: z8.number().int().min(0).max(1e6),
  expectedUpdatedAt: z8.string().refine((s) => Number.isSafeInteger(Date.parse(s)) && Date.parse(s) % 1e3 === 0)
}).strict()).max(50);
async function commit(insert, receipt) {
  try {
    await insert();
  } catch (e) {
    const old = await receipt();
    if (old) return old;
    if (!/Recovery|Stock |stock_movement|UNIQUE constraint/.test(errorText(e))) throw e;
    throw new CommerceOperationsConflict("Returned quantities, the case or stock changed. Refresh before continuing.");
  }
  return null;
}
async function receiveReplacementReturn(env, input, actor) {
  const v = z8.object({ shipmentId: id4, quantity, reason: reason4, requestKey: id4.min(8) }).strict().parse(input);
  if (!actor.trim()) throw new CommerceOperationsConflict("An authenticated staff member is required.");
  const db = commerceDb(env), receiptId = `rcr_${await hashOrderAccess(`${v.shipmentId}:${v.requestKey}`)}`, fingerprint = await warehouseFingerprint(v, actor);
  const replay = async () => {
    const old2 = await db.select().from(recoveryReceipts).where(eq5(recoveryReceipts.id, receiptId)).get();
    if (!old2) return null;
    if (old2.fingerprint !== fingerprint) throw new CommerceOperationsConflict("This return key was used with different details.");
    return { receiptId, duplicate: true };
  };
  const old = await replay();
  if (old) return old;
  return await commit(() => db.insert(recoveryReceipts).values({ id: receiptId, shipmentId: v.shipmentId, quantity: v.quantity, actor, reason: v.reason, fingerprint, createdAt: /* @__PURE__ */ new Date() }), replay) ?? { receiptId };
}
async function inspectReplacementReturn(env, input, actor) {
  const v = z8.object({ receiptId: id4, quantity, disposition: z8.enum(RECOVERY_DISPOSITIONS), restock: z8.boolean(), stock: stock.default([]), reason: reason4, requestKey: id4.min(8) }).strict().refine((v2) => v2.restock ? v2.disposition === "sellable" : v2.stock.length === 0, "Only sellable goods may restore stock").parse(input);
  if (!actor.trim()) throw new CommerceOperationsConflict("An authenticated staff member is required.");
  const db = commerceDb(env), inspectionId = `rci_${await hashOrderAccess(`${v.receiptId}:${v.requestKey}`)}`, fingerprint = await warehouseFingerprint(v, actor);
  const replay = async () => {
    const old2 = await db.select().from(recoveryInspections).where(eq5(recoveryInspections.id, inspectionId)).get();
    if (!old2) return null;
    if (old2.fingerprint !== fingerprint) throw new CommerceOperationsConflict("This inspection key was used with different details.");
    return { inspectionId, duplicate: true };
  };
  const old = await replay();
  if (old) return old;
  const receipt = await db.query.recoveryReceipts.findFirst({ where: { id: v.receiptId }, with: { shipment: { with: { case: true } } } });
  if (!receipt) throw new CommerceOperationsConflict("Replacement return not found.");
  const targets = receipt.shipment.case.target.stockTargets;
  if (v.restock && (v.stock.length !== targets.length || new Set(v.stock.map((s) => `${s.targetType}:${s.targetId}`)).size !== v.stock.length)) throw new CommerceOperationsConflict("Reload every replacement stock pool.");
  const pools = v.stock.map((s) => {
    const target = targets.find((t) => t.type === s.targetType && t.id === s.targetId), units = (target?.units ?? 0) * v.quantity;
    if (!target || !Number.isSafeInteger(units) || units < 1 || units > 1e6) throw new CommerceOperationsConflict("The replacement stock mapping is unavailable.");
    return { targetType: s.targetType, targetId: s.targetId, expectedQuantity: s.expectedQuantity, expectedUpdatedSeconds: Date.parse(s.expectedUpdatedAt) / 1e3, units };
  });
  return await commit(() => db.insert(recoveryInspections).values({ id: inspectionId, receiptId: v.receiptId, quantity: v.quantity, disposition: v.disposition, restock: v.restock, stock: pools, actor, reason: v.reason, fingerprint, createdAt: /* @__PURE__ */ new Date() }), replay) ?? { inspectionId };
}

export {
  reportSupplierIssue,
  recordSupplierIssue,
  listSupplierIssues,
  readSupplierIssue,
  readCommerceAttention,
  readStockOverview,
  readOrderRecoveryHistory,
  OperationsExportLimit,
  exportCommerceOperations,
  listRefundFollowUp,
  readRefundCase,
  recordRefundFollowUp,
  listSuppliers,
  saveSupplier,
  savePurchaseOrder,
  recordPurchaseOrder,
  listPurchaseOrders,
  readPurchaseOrder,
  readOperationsReport,
  receiveReplacementReturn,
  inspectReplacementReturn
};
