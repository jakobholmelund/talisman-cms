import { effectiveDeliveryDate } from './replenishment';
import { sql } from 'drizzle-orm';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb } from './db';

export type AttentionKind = 'payment_review' | 'older_payments' | 'tax_review' | 'email' | 'gift_hold' | 'shipment' | 'dispute' | 'return_request' | 'inspection' | 'refund' | 'incoming';
type AttentionRow = { kind: AttentionKind; id: string; subject: string; createdAt: number; detail: string | null };

/** A read-only snapshot. Exact counts include every matching record; each category shows its ten
 * oldest records. No buyer addresses, provider credentials or gift card codes leave this query. */
export async function readCommerceAttention(env: TalismanEnv, now = Math.floor(Date.now() / 1000)) {
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
  ), attention AS (SELECT * FROM attention_a UNION ALL SELECT * FROM attention_b UNION ALL SELECT * FROM return_events)`;
  const [counts, rows] = await db.batch([
    db.all<{ kind: AttentionKind; count: number }>(sql`${queue} SELECT kind, count(*) AS count FROM attention GROUP BY kind`),
    db.all<AttentionRow>(sql`${queue}, ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY kind ORDER BY createdAt, id) AS rank FROM attention)
      SELECT kind, id, subject, createdAt, detail FROM ranked WHERE rank <= 10 ORDER BY kind, createdAt, id`),
  ]);
  return { checkedAt: new Date(now * 1000).toISOString(), counts: Object.fromEntries(counts.map(row => [row.kind, Number(row.count)])) as Partial<Record<AttentionKind, number>>,
    rows: rows.map(row => ({ ...row, createdAt: new Date(row.createdAt * 1000).toISOString() })) };
}
