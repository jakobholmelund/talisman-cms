import { sql } from 'drizzle-orm';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb } from './db';

export type AttentionKind = 'payment_review' | 'older_payments' | 'tax_review' | 'email' | 'gift_hold' | 'shipment' | 'dispute';
type AttentionRow = { kind: AttentionKind; id: string; subject: string; createdAt: number; detail: string | null };

/** A read-only snapshot. Exact counts include every matching record; each category shows its ten
 * oldest records. No buyer addresses, provider credentials or gift card codes leave this query. */
export async function readCommerceAttention(env: TalismanEnv, now = Math.floor(Date.now() / 1000)) {
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
    db.all<{ kind: AttentionKind; count: number }>(sql`${queue} SELECT kind, count(*) AS count FROM attention GROUP BY kind`),
    db.all<AttentionRow>(sql`${queue}, ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY kind ORDER BY createdAt, id) AS rank FROM attention)
      SELECT kind, id, subject, createdAt, detail FROM ranked WHERE rank <= 10 ORDER BY kind, createdAt, id`),
  ]);
  return { checkedAt: new Date(now * 1000).toISOString(), counts: Object.fromEntries(counts.map(row => [row.kind, Number(row.count)])) as Partial<Record<AttentionKind, number>>,
    rows: rows.map(row => ({ ...row, createdAt: new Date(row.createdAt * 1000).toISOString() })) };
}
