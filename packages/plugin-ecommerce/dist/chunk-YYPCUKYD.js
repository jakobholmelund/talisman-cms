import {
  commerceDb
} from "./chunk-BYV5FZJC.js";
import {
  orders
} from "./chunk-2AZBK7KL.js";

// src/attention.ts
import { sql } from "drizzle-orm";
async function readCommerceAttention(env, now = Math.floor(Date.now() / 1e3)) {
  const db = commerceDb(env);
  const queue = sql`WITH attention_a AS (
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
  ), attention AS (SELECT * FROM attention_a UNION ALL SELECT * FROM attention_b UNION ALL SELECT * FROM return_events)`;
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

// src/stock-overview.ts
import { z } from "zod";
import { sql as sql2 } from "drizzle-orm";
var inputSchema = z.object({
  view: z.enum(["choices", "components"]).default("choices"),
  threshold: z.coerce.number().int().min(0).max(1e6).default(5),
  filter: z.enum(["low", "unavailable", "all"]).default("low"),
  search: z.string().trim().max(100).default(""),
  offset: z.coerce.number().int().min(0).max(1e6).default(0)
});
var choices = sql2`WITH inventory AS (
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
var parts = sql2`WITH inventory AS (SELECT id, 'component' AS kind, NULL AS productId, name, sku, quantity,
  'Shared component' AS source FROM _ecommerce_components)`;
async function readStockOverview(env, input = {}) {
  const values = inputSchema.parse(input);
  const cte = values.view === "components" ? parts : choices;
  const pattern = `%${values.search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  const filtered = sql2`(name LIKE ${pattern} ESCAPE '\\' OR COALESCE(sku, '') LIKE ${pattern} ESCAPE '\\')
    AND ${values.filter === "all" ? sql2`1` : values.filter === "unavailable" ? sql2`quantity = 0` : sql2`quantity <= ${values.threshold}`}`;
  const db = commerceDb(env);
  const [rows, counted] = await db.batch([
    db.all(sql2`${cte} SELECT * FROM inventory WHERE ${filtered}
      ORDER BY quantity, name, kind, id LIMIT 50 OFFSET ${values.offset}`),
    db.all(sql2`${cte} SELECT count(*) AS count FROM inventory WHERE ${filtered}`)
  ]);
  return { rows, total: Number(counted[0]?.count ?? 0), ...values };
}

// src/operations-export.ts
import { and, asc, eq, gte, lt, sql as sql3 } from "drizzle-orm";
import { z as z2 } from "zod";
var day = z2.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && (/* @__PURE__ */ new Date(`${s}T00:00:00Z`)).toISOString().slice(0, 10) === s, "Use a valid calendar date");
var options = z2.object({ kind: z2.enum(["orders", "returns", "stock"]), from: day, to: day, orderId: z2.string().trim().max(128).default(""), status: z2.enum(["all", "draft", "pending", "paid", "fulfilled", "cancelled", "partially_refunded", "refunded", "disputed"]).default("all"), targetType: z2.enum(["all", "product", "variant", "stock", "component"]).default("all"), targetId: z2.string().trim().max(128).default("") }).strict().refine((v) => v.to >= v.from && Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`) < 366 * 864e5, "Choose at most 366 UTC days").refine((v) => (v.kind === "orders" || v.status === "all") && (v.kind === "stock" || v.targetType === "all" && !v.targetId) && (!v.targetId || v.targetType !== "all"), "Filters do not match the selected export");
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
      created_at_utc: sql3`${orders.createdAt}`,
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
      sql3`COALESCE(${orders.paymentProvider},'stripe')<>'admin_test'`,
      v.orderId ? eq(orders.id, v.orderId) : void 0,
      v.status === "all" ? void 0 : eq(orders.status, v.status)
    )).orderBy(asc(orders.createdAt), asc(orders.id)).limit(1001).all();
  } else if (v.kind === "returns") {
    columns = ["receipt_id", "request_id", "order_id", "created_at_utc", "line_index", "quantity", "condition", "restock_selected", "awaiting_inspection", "actor", "reason"];
    rows = await db.all(sql3`SELECT r.id AS receipt_id,l.request_id,r.order_id,r.created_at AS created_at_utc,json_extract(i.value,'$.lineIndex') AS line_index,json_extract(i.value,'$.quantity') AS quantity,json_extract(i.value,'$.condition') AS condition,json_extract(i.value,'$.restock') AS restock_selected,
    CASE WHEN json_extract(i.value,'$.condition')='inspection' THEN json_extract(i.value,'$.quantity')-COALESCE((SELECT sum(json_extract(a.value,'$.quantity')) FROM _ecommerce_return_inspections d,json_each(d.items) a WHERE d.receipt_id=r.id AND json_extract(a.value,'$.lineIndex')=json_extract(i.value,'$.lineIndex')),0) ELSE 0 END AS awaiting_inspection,r.actor,r.reason
    FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id LEFT JOIN _ecommerce_return_request_receipts l ON l.receipt_id=r.id,json_each(r.items) i
    WHERE r.created_at>=${from} AND r.created_at<${to} AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND (${v.orderId}='' OR r.order_id=${v.orderId}) ORDER BY r.created_at,r.id,line_index LIMIT 1001`);
  } else {
    columns = ["movement_id", "created_at_utc", "kind", "target_type", "target_id", "delta", "before_quantity", "after_quantity", "order_id", "actor", "reason"];
    const inventory = sql3`SELECT r.id AS movement_id,o.created_at AS created_at_utc,'checkout_hold' AS kind,r.target_type,r.target_id,-r.quantity AS delta,NULL AS before_quantity,NULL AS after_quantity,r.order_id,NULL AS actor,'Checkout stock reservation' AS reason FROM _ecommerce_inventory_reservations r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
      UNION ALL SELECT r.id||'_release',r.released_at,'checkout_release',r.target_type,r.target_id,r.quantity,NULL,NULL,r.order_id,NULL,'Cancelled checkout stock release' FROM _ecommerce_inventory_reservations r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE r.released_at IS NOT NULL AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND NOT EXISTS(SELECT 1 FROM _ecommerce_restocks x WHERE x.reservation_type='inventory' AND x.reservation_id=r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_stock x WHERE x.reservation_type='inventory' AND x.reservation_id=r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_inspection_stock x WHERE x.reservation_type='inventory' AND x.reservation_id=r.id)`;
    const component = sql3`SELECT r.id AS movement_id,o.created_at AS created_at_utc,'checkout_hold' AS kind,'component' AS target_type,r.component_id AS target_id,-r.quantity AS delta,NULL AS before_quantity,NULL AS after_quantity,r.order_id,NULL AS actor,'Checkout component reservation' AS reason FROM _ecommerce_component_reservations r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
      UNION ALL SELECT r.id||'_release',r.released_at,'checkout_release','component',r.component_id,r.quantity,NULL,NULL,r.order_id,NULL,'Cancelled checkout component release' FROM _ecommerce_component_reservations r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE r.released_at IS NOT NULL AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND NOT EXISTS(SELECT 1 FROM _ecommerce_restocks x WHERE x.reservation_type='component' AND x.reservation_id=r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_stock x WHERE x.reservation_type='component' AND x.reservation_id=r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_inspection_stock x WHERE x.reservation_type='component' AND x.reservation_id=r.id)`;
    const restored = sql3`SELECT s.id AS movement_id,r.created_at AS created_at_utc,'return' AS kind,s.target_type,s.target_id,s.quantity AS delta,NULL AS before_quantity,NULL AS after_quantity,s.order_id,r.actor,r.reason FROM _ecommerce_return_stock s JOIN _ecommerce_return_receipts r ON r.id=s.receipt_id
      UNION ALL SELECT s.id,r.created_at,'inspection',s.target_type,s.target_id,s.quantity,NULL,NULL,s.order_id,r.actor,r.reason FROM _ecommerce_inspection_stock s JOIN _ecommerce_return_inspections r ON r.id=s.inspection_id`;
    rows = await db.all(sql3`WITH inventory AS (${inventory}),component AS (${component}),restored AS (${restored}),events AS (
      SELECT id AS movement_id,created_at AS created_at_utc,kind,target_type,target_id,delta,before_quantity,after_quantity,NULL AS order_id,actor,reason FROM _ecommerce_stock_movements
      UNION ALL SELECT * FROM restored
      UNION ALL SELECT id,created_at,'restock',target_type,target_id,quantity,NULL,NULL,order_id,admin_actor,reason FROM _ecommerce_restocks
      UNION ALL SELECT * FROM inventory UNION ALL SELECT * FROM component)
      SELECT * FROM events WHERE (order_id IS NULL OR EXISTS(SELECT 1 FROM _ecommerce_orders o WHERE o.id=events.order_id AND COALESCE(o.payment_provider,'stripe')<>'admin_test')) AND created_at_utc>=${from} AND created_at_utc<${to} AND (${v.orderId}='' OR order_id=${v.orderId}) AND (${v.targetType}='all' OR target_type=${v.targetType}) AND (${v.targetId}='' OR target_id=${v.targetId}) ORDER BY created_at_utc,movement_id LIMIT 1001`);
  }
  if (rows.length > 1e3) throw new OperationsExportLimit("This selection exceeds 1,000 rows. Narrow the dates or filters; no partial file was created.");
  for (const row of rows) row.created_at_utc = new Date(Number(row.created_at_utc) * 1e3).toISOString();
  return { filename: `commerce-${v.kind}-${v.from}-${v.to}.csv`, rows: rows.length, csv: "\uFEFF" + [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((c) => csvCell(row[c] ?? null)).join(","))].join("\r\n") + "\r\n" };
}

export {
  readCommerceAttention,
  readStockOverview,
  OperationsExportLimit,
  exportCommerceOperations
};
