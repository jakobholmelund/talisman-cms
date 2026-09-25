import type { PeriodDays } from './cloudflare';
import { periodBounds } from './cloudflare';

type Database = Pick<D1Database, 'prepare'>;
type OrderRow = {
  order_count: number; currency: string; gross_sales: number; net_sales: number;
  refunds: number; charged: number;
};
type DailyRow = { day: string; currency: string; order_count: number; net_sales: number };
type ProductRow = { product_id: string; name: string | null; currency: string; units: number; item_sales: number };

export type CommerceOverview = {
  periodDays: PeriodDays;
  start: string;
  end: string;
  currencies: Array<{ currency: string; orders: number; grossSales: number; netSales: number; refunds: number; charged: number; averageOrderValue: number }>;
  daily: Array<{ date: string; currency: string; orders: number; netSales: number }>;
  products: Array<{ id: string; name: string; currency: string; units: number; itemSales: number; editHref: string }>;
};
export type CommerceRange = Omit<CommerceOverview, 'periodDays'>;

const paidOrders = `
  WITH paid_orders AS (
    SELECT o.*, MIN(p.created_at) AS paid_at
    FROM _ecommerce_orders o
    JOIN _ecommerce_payments p ON p.order_id = o.id
    WHERE o.status IN ('paid', 'fulfilled', 'partially_refunded', 'refunded')
      AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'
      AND p.status IN ('success', 'partially_refunded', 'refunded')
    GROUP BY o.id
  )`;

const inPeriod = `paid_at >= ? AND paid_at < ?`;
const gross = `MAX(0, subtotal_amount - discount_amount)`;
const refund = `CASE WHEN status = 'refunded' THEN ${gross}
  ELSE MIN(${gross}, provider_refunded_cents + gift_card_refunded_cents) END`;
const net = `(${gross} - ${refund})`;

export const commerceSql = {
  totals: `${paidOrders}
    SELECT LOWER(currency) AS currency, COUNT(*) AS order_count,
      SUM(${gross}) AS gross_sales, SUM(${net}) AS net_sales,
      SUM(${refund}) AS refunds, SUM(total_amount) AS charged
    FROM paid_orders WHERE ${inPeriod} GROUP BY LOWER(currency) ORDER BY LOWER(currency)`,
  daily: `${paidOrders}
    SELECT date(paid_at, 'unixepoch') AS day, LOWER(currency) AS currency,
      COUNT(*) AS order_count, SUM(${net}) AS net_sales
    FROM paid_orders WHERE ${inPeriod}
    GROUP BY day, LOWER(currency) ORDER BY day ASC, currency ASC`,
  products: `${paidOrders}
    SELECT json_extract(line.value, '$.productId') AS product_id,
      MAX(product.name) AS name, LOWER(o.currency) AS currency,
      SUM(CAST(json_extract(line.value, '$.quantity') AS INTEGER)) AS units,
      SUM(CAST(json_extract(line.value, '$.quantity') AS INTEGER) *
          CAST(json_extract(line.value, '$.priceAtPurchase') AS INTEGER)) AS item_sales
    FROM paid_orders o JOIN json_each(o.items) line
      LEFT JOIN _ecommerce_products product ON product.id = json_extract(line.value, '$.productId')
    WHERE ${inPeriod} AND o.status <> 'refunded'
    GROUP BY product_id, LOWER(o.currency)
    ORDER BY item_sales DESC LIMIT 20`,
};

function amount(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export async function fetchCommerceRange(
  db: Database, start: string, end: string, adminBase = '/admin', productCollectionSlug = 'products'
): Promise<CommerceRange> {
  const from = Math.floor(Date.parse(start) / 1000);
  const to = Math.floor(Date.parse(end) / 1000);
  const [totals, daily, products] = await Promise.all([
    db.prepare(commerceSql.totals).bind(from, to).all<OrderRow>(),
    db.prepare(commerceSql.daily).bind(from, to).all<DailyRow>(),
    db.prepare(commerceSql.products).bind(from, to).all<ProductRow>(),
  ]);
  return {
    start, end,
    currencies: (totals.results || []).map(row => ({
      currency: row.currency, orders: amount(row.order_count), grossSales: amount(row.gross_sales),
      netSales: amount(row.net_sales), refunds: amount(row.refunds), charged: amount(row.charged),
      averageOrderValue: row.order_count ? Math.round(amount(row.net_sales) / row.order_count) : 0,
    })),
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
  db: Database, days: PeriodDays, adminBase = '/admin', productCollectionSlug = 'products', now = new Date()
): Promise<CommerceOverview> {
  const { start, end } = periodBounds(days, now);
  return { periodDays: days, ...await fetchCommerceRange(db, start, end, adminBase, productCollectionSlug) };
}
