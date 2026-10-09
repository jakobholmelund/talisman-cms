import {
  commerceDb
} from "./chunk-4WYWYY7J.js";

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

export {
  readCommerceAttention,
  readStockOverview
};
