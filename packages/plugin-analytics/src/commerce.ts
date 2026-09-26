import type { PeriodDays } from './cloudflare';
import { periodBounds } from './cloudflare';

type Database = Pick<D1Database, 'prepare'>;
type OrderRow = {
  currency: string; order_count: number; gross_sales: number; charged: number;
  refunds: number; refunded_orders: number; undated_refunds: number;
};
type DailyRow = { day: string; currency: string; order_count: number; net_sales: number };
type ProductRow = { product_id: string; name: string | null; currency: string; units: number; item_sales: number };

/**
 * How refunds are dated. `refund_date`: each refund counts on the day it was issued.
 * `payment_date`: refunds count on the payment date of the refunded order, because the store
 * does not record when provider refunds were issued (no `_ecommerce_provider_refunds` table).
 */
export type RefundBasis = 'refund_date' | 'payment_date';

/**
 * The store's Stripe mode: `live` only when the COMMERCE_STRIPE_MODE setting is `live`, as in
 * plugin-ecommerce. A live store's reports exclude Stripe test-mode orders. A store in test mode
 * takes Stripe payments only in test mode, so its reports include them.
 */
export type StripeMode = 'live' | 'test';

export type CommerceOverview = {
  periodDays: PeriodDays;
  start: string;
  end: string;
  refundBasis: RefundBasis;
  /** Stripe test-mode orders are excluded in `live` mode and included in `test` mode. */
  stripeMode: StripeMode;
  /** True when some refunds in the period have no recorded date and were counted on the payment date. */
  undatedRefunds: boolean;
  /**
   * Amounts are in each currency's minor units. `grossSales` is the items after discounts, without
   * the shipping and tax added to the price. `refunds` counts only the items' share of what was
   * refunded, and `netSales` is gross sales less those refunds. `charged` is what payment providers
   * charged, shipping and tax included.
   */
  currencies: Array<{
    currency: string; orders: number; grossSales: number; netSales: number; refunds: number;
    refundedOrders: number; charged: number; averageOrderValue: number;
  }>;
  daily: Array<{ date: string; currency: string; orders: number; netSales: number }>;
  products: Array<{ id: string; name: string; currency: string; units: number; itemSales: number; editHref: string }>;
};
export type CommerceRange = Omit<CommerceOverview, 'periodDays'>;

/**
 * Provider refunds with the time they were issued, one row per refund, written by plugin-ecommerce
 * when available. Per order the rows should add up to provider_refunded_cents; any excess is ignored.
 */
export const providerRefundsTable = '_ecommerce_provider_refunds';

// A Stripe Checkout Session created with a test-mode key has an id starting with cs_test_.
const stripeTestSession = (column: string) => `substr(COALESCE(${column}, ''), 1, 8) = 'cs_test_'`;

// Stripe orders paid with a test-mode key, and gift-card-only orders paid with a gift card bought in test mode.
const excludeTestModeOrders = `
      AND NOT (COALESCE(o.payment_provider, 'stripe') = 'stripe' AND ${stripeTestSession('o.checkout_session_id')})
      AND NOT (o.payment_provider = 'gift_card' AND EXISTS (
        SELECT 1 FROM _ecommerce_gift_cards card
        JOIN _ecommerce_gift_card_purchases purchase ON purchase.id = card.purchase_id
        WHERE card.id = o.gift_card_id AND ${stripeTestSession('purchase.provider_session_id')}))`;

// Admin test orders never count. Stripe test-mode orders count only while the store is in test mode.
const paidOrders = (stripeMode: StripeMode) => `
  paid_orders AS (
    SELECT o.*, MIN(p.created_at) AS paid_at
    FROM _ecommerce_orders o
    JOIN _ecommerce_payments p ON p.order_id = o.id
    WHERE o.status IN ('paid', 'fulfilled', 'partially_refunded', 'refunded')
      AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'${stripeMode === 'test' ? '' : excludeTestModeOrders}
      AND p.status IN ('success', 'partially_refunded', 'refunded')
    GROUP BY o.id
  )`;

const inPeriod = (column: string) => `${column} >= ? AND ${column} < ?`;
const grossOf = (order: string) => `MAX(0, ${order}.subtotal_amount - ${order}.discount_amount)`;
/**
 * Everything paid for an order, in any tender: the items after discounts plus the shipping and the
 * tax added to the price. Inclusive tax is already part of the items and the shipping.
 */
const paidOf = (order: string) => `(${grossOf(order)} + ${order}.shipping_amount
  + CASE WHEN ${order}.tax_behavior = 'exclusive' THEN ${order}.tax_amount ELSE 0 END)`;
/**
 * The items' share of `refunded`, an amount refunded on an order in any tender. A refund does not
 * record what it returned, so it is split in proportion to what was paid for the items, the
 * shipping and the tax, and only the items' share counts against sales. Integer arithmetic, rounded
 * half up. The CAST keeps the share whole if the multiplication overflows 64 bits, where SQLite
 * falls back to floating point.
 */
const itemShareOf = (order: string, refunded: string) => `CASE WHEN ${paidOf(order)} > 0
  THEN MIN(${grossOf(order)}, CAST(((${refunded}) * ${grossOf(order)} + ${paidOf(order)} / 2) / ${paidOf(order)} AS INTEGER))
  ELSE 0 END`;
/** The items' share of everything refunded on an order so far. A full refund returns the whole gross. */
const refundOf = (order: string) => `CASE WHEN ${order}.status = 'refunded' THEN ${grossOf(order)}
  ELSE ${itemShareOf(order, `${order}.provider_refunded_cents + ${order}.gift_card_refunded_cents`)} END`;

// One row per refund: order_id, currency, amount (the items' share of the refund), refunded_at
// (unix seconds) and dated (1 when refunded_at is when the refund was issued, 0 when it falls back
// to the payment date).
const refundsByPaymentDate = `
  refund_events AS (
    SELECT o.id AS order_id, LOWER(o.currency) AS currency, ${refundOf('o')} AS amount,
      o.paid_at AS refunded_at, 0 AS dated
    FROM paid_orders o WHERE ${refundOf('o')} > 0
  )`;

// Provider and gift-card refunds carry their own dates. Provider refunds of an order never count
// for more than its provider_refunded_cents: taken earliest first, a row past that total is
// trimmed, so a refund recorded twice (for example by two webhooks racing) is not counted twice.
// Each refund counts for the items' share of the order's dated refunds up to and including it,
// less the share of those before it, so the shares add up to the share of their total and
// rounding leaves nothing over.
// Whatever is left of an order's refund total has no record of its own: tender returned by a
// full refund (store credit, the rest of a gift card) is dated when the order was fully
// refunded, and refunds recorded before refund dates were stored fall back to the payment date.
const refundsByRefundDate = `
  provider_refunds AS (
    SELECT r.id, r.order_id, r.created_at, MIN(r.amount_cents, o.provider_refunded_cents + r.amount_cents -
      SUM(r.amount_cents) OVER (PARTITION BY r.order_id ORDER BY r.created_at, r.id ROWS UNBOUNDED PRECEDING)) AS amount
    FROM ${providerRefundsTable} r JOIN paid_orders o ON o.id = r.order_id
  ),
  dated_refunds AS (
    SELECT order_id, created_at, amount,
      SUM(amount) OVER (PARTITION BY order_id ORDER BY created_at, id ROWS UNBOUNDED PRECEDING) AS refunded
    FROM (
      SELECT id, order_id, amount, created_at FROM provider_refunds WHERE amount > 0
      UNION ALL
      SELECT id, order_id, amount_cents, created_at FROM _ecommerce_gift_card_refunds
    )
  ),
  dated_shares AS (
    SELECT d.order_id, d.created_at,
      ${itemShareOf('o', 'd.refunded')} - ${itemShareOf('o', 'd.refunded - d.amount')} AS amount
    FROM dated_refunds d JOIN paid_orders o ON o.id = d.order_id
  ),
  dated_totals AS (
    SELECT order_id, SUM(amount) AS amount, MAX(created_at) AS last_at FROM dated_shares GROUP BY order_id
  ),
  refund_events AS (
    SELECT o.id AS order_id, LOWER(o.currency) AS currency, d.amount AS amount,
      COALESCE(d.created_at, o.paid_at) AS refunded_at, d.created_at IS NOT NULL AS dated
    FROM dated_shares d JOIN paid_orders o ON o.id = d.order_id WHERE d.amount > 0
    UNION ALL
    SELECT o.id, LOWER(o.currency), ${refundOf('o')} - COALESCE(t.amount, 0),
      CASE WHEN o.status = 'refunded' THEN COALESCE(full_refund.created_at, t.last_at, o.paid_at) ELSE o.paid_at END,
      o.status = 'refunded' AND COALESCE(full_refund.created_at, t.last_at) IS NOT NULL
    FROM paid_orders o
    LEFT JOIN dated_totals t ON t.order_id = o.id
    LEFT JOIN _ecommerce_gift_card_order_refunds full_refund ON full_refund.order_id = o.id
    WHERE ${refundOf('o')} > COALESCE(t.amount, 0)
  )`;

/**
 * Sales are counted on the payment date. Refunds are counted on their own date (see RefundBasis),
 * and net sales are gross sales less the refunds counted in the same period. Stripe test-mode orders
 * are left out unless `stripeMode` is `test`.
 */
export function commerceSql(refundBasis: RefundBasis, stripeMode: StripeMode = 'live') {
  const ctes = `WITH ${paidOrders(stripeMode)}, ${refundBasis === 'refund_date' ? refundsByRefundDate : refundsByPaymentDate}`;
  return {
    totals: `${ctes}
      SELECT currency, SUM(orders) AS order_count, SUM(gross) AS gross_sales, SUM(charged) AS charged,
        SUM(refund) AS refunds, COUNT(DISTINCT refund_order) AS refunded_orders, SUM(undated) AS undated_refunds
      FROM (
        SELECT LOWER(o.currency) AS currency, 1 AS orders, ${grossOf('o')} AS gross, o.total_amount AS charged,
          0 AS refund, NULL AS refund_order, 0 AS undated
        FROM paid_orders o WHERE ${inPeriod('o.paid_at')}
        UNION ALL
        SELECT currency, 0, 0, 0, amount, order_id, CASE WHEN dated THEN 0 ELSE amount END
        FROM refund_events WHERE ${inPeriod('refunded_at')}
      ) GROUP BY currency ORDER BY currency`,
    daily: `${ctes}
      SELECT day, currency, SUM(orders) AS order_count, SUM(gross) - SUM(refund) AS net_sales
      FROM (
        SELECT date(o.paid_at, 'unixepoch') AS day, LOWER(o.currency) AS currency, 1 AS orders,
          ${grossOf('o')} AS gross, 0 AS refund
        FROM paid_orders o WHERE ${inPeriod('o.paid_at')}
        UNION ALL
        SELECT date(refunded_at, 'unixepoch'), currency, 0, 0, amount
        FROM refund_events WHERE ${inPeriod('refunded_at')}
      ) GROUP BY day, currency ORDER BY day ASC, currency ASC`,
    products: `WITH ${paidOrders(stripeMode)}
      SELECT json_extract(line.value, '$.productId') AS product_id,
        MAX(product.name) AS name, LOWER(o.currency) AS currency,
        SUM(CAST(json_extract(line.value, '$.quantity') AS INTEGER)) AS units,
        SUM(CAST(json_extract(line.value, '$.quantity') AS INTEGER) *
            CAST(json_extract(line.value, '$.priceAtPurchase') AS INTEGER)) AS item_sales
      FROM paid_orders o JOIN json_each(o.items) line
        LEFT JOIN _ecommerce_products product ON product.id = json_extract(line.value, '$.productId')
      WHERE ${inPeriod('o.paid_at')} AND o.status <> 'refunded'
      GROUP BY product_id, LOWER(o.currency)
      ORDER BY item_sales DESC LIMIT 20`,
  };
}

function amount(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Refund dates are available once plugin-ecommerce records provider refunds in their own table. */
export async function detectRefundBasis(db: Database): Promise<RefundBasis> {
  try {
    const result = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .bind(providerRefundsTable).all<{ name: string }>();
    return result.results?.length ? 'refund_date' : 'payment_date';
  } catch {
    return 'payment_date';
  }
}

/** Pass the store's Stripe mode; without one the report treats the store as live and leaves test-mode orders out. */
export async function fetchCommerceRange(
  db: Database, start: string, end: string, adminBase = '/admin', productCollectionSlug = 'products',
  stripeMode: StripeMode = 'live'
): Promise<CommerceRange> {
  const from = Math.floor(Date.parse(start) / 1000);
  const to = Math.floor(Date.parse(end) / 1000);
  const refundBasis = await detectRefundBasis(db);
  const sql = commerceSql(refundBasis, stripeMode);
  const [totals, daily, products] = await Promise.all([
    db.prepare(sql.totals).bind(from, to, from, to).all<OrderRow>(),
    db.prepare(sql.daily).bind(from, to, from, to).all<DailyRow>(),
    db.prepare(sql.products).bind(from, to).all<ProductRow>(),
  ]);
  const totalRows = totals.results || [];
  return {
    start, end, refundBasis, stripeMode: stripeMode === 'test' ? 'test' : 'live',
    undatedRefunds: refundBasis === 'refund_date' && totalRows.some(row => amount(row.undated_refunds) > 0),
    currencies: totalRows.map(row => {
      const orders = amount(row.order_count);
      const grossSales = amount(row.gross_sales);
      const refunds = amount(row.refunds);
      return {
        currency: row.currency, orders, grossSales, netSales: grossSales - refunds, refunds,
        refundedOrders: amount(row.refunded_orders), charged: amount(row.charged),
        averageOrderValue: orders ? Math.round(grossSales / orders) : 0,
      };
    }),
    daily: (daily.results || []).map(row => ({
      date: row.day, currency: row.currency, orders: amount(row.order_count), netSales: amount(row.net_sales),
    })),
    products: (products.results || []).filter(row => row.product_id).map(row => ({
      id: row.product_id, name: row.name || row.product_id, currency: row.currency,
      units: amount(row.units), itemSales: amount(row.item_sales),
      editHref: `${adminBase}/commerce/${encodeURIComponent(productCollectionSlug)}/${encodeURIComponent(row.product_id)}`,
    })),
  };
}

export async function fetchCommerceOverview(
  db: Database, days: PeriodDays, adminBase = '/admin', productCollectionSlug = 'products',
  stripeMode: StripeMode = 'live', now = new Date()
): Promise<CommerceOverview> {
  const { start, end } = periodBounds(days, now);
  return { periodDays: days, ...await fetchCommerceRange(db, start, end, adminBase, productCollectionSlug, stripeMode) };
}
