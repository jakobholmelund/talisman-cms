import {
  periodBounds
} from "./chunk-MS4TVUJ4.js";

// src/commerce.ts
var providerRefundsTable = "_ecommerce_provider_refunds";
var stripeTestSession = (column) => `substr(COALESCE(${column}, ''), 1, 8) = 'cs_test_'`;
var excludeTestModeOrders = `
      AND NOT (COALESCE(o.payment_provider, 'stripe') = 'stripe' AND ${stripeTestSession("o.checkout_session_id")})
      AND NOT (o.payment_provider = 'gift_card' AND EXISTS (
        SELECT 1 FROM _ecommerce_gift_cards card
        JOIN _ecommerce_gift_card_purchases purchase ON purchase.id = card.purchase_id
        WHERE card.id = o.gift_card_id AND ${stripeTestSession("purchase.provider_session_id")}))`;
var paidOrders = (stripeMode) => `
  paid_orders AS (
    SELECT o.*, MIN(p.created_at) AS paid_at
    FROM _ecommerce_orders o
    JOIN _ecommerce_payments p ON p.order_id = o.id
    WHERE o.status IN ('paid', 'fulfilled', 'partially_refunded', 'refunded')
      AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'${stripeMode === "test" ? "" : excludeTestModeOrders}
      AND p.status IN ('success', 'partially_refunded', 'refunded')
    GROUP BY o.id
  )`;
var inPeriod = (column) => `${column} >= ? AND ${column} < ?`;
var grossOf = (order) => `MAX(0, ${order}.subtotal_amount - ${order}.discount_amount)`;
var paidOf = (order) => `(${grossOf(order)} + ${order}.shipping_amount
  + CASE WHEN ${order}.tax_behavior = 'exclusive' THEN ${order}.tax_amount ELSE 0 END)`;
var itemShareOf = (order, refunded) => `CASE WHEN ${paidOf(order)} > 0
  THEN MIN(${grossOf(order)}, CAST(((${refunded}) * ${grossOf(order)} + ${paidOf(order)} / 2) / ${paidOf(order)} AS INTEGER))
  ELSE 0 END`;
var refundOf = (order) => `CASE WHEN ${order}.status = 'refunded' THEN ${grossOf(order)}
  ELSE ${itemShareOf(order, `${order}.provider_refunded_cents + ${order}.gift_card_refunded_cents`)} END`;
var refundsByPaymentDate = `
  refund_events AS (
    SELECT o.id AS order_id, LOWER(o.currency) AS currency, ${refundOf("o")} AS amount,
      o.paid_at AS refunded_at, 0 AS dated
    FROM paid_orders o WHERE ${refundOf("o")} > 0
  )`;
var refundsByRefundDate = `
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
      ${itemShareOf("o", "d.refunded")} - ${itemShareOf("o", "d.refunded - d.amount")} AS amount
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
    SELECT o.id, LOWER(o.currency), ${refundOf("o")} - COALESCE(t.amount, 0),
      CASE WHEN o.status = 'refunded' THEN COALESCE(full_refund.created_at, t.last_at, o.paid_at) ELSE o.paid_at END,
      o.status = 'refunded' AND COALESCE(full_refund.created_at, t.last_at) IS NOT NULL
    FROM paid_orders o
    LEFT JOIN dated_totals t ON t.order_id = o.id
    LEFT JOIN _ecommerce_gift_card_order_refunds full_refund ON full_refund.order_id = o.id
    WHERE ${refundOf("o")} > COALESCE(t.amount, 0)
  )`;
function commerceSql(refundBasis, stripeMode = "live") {
  const ctes = `WITH ${paidOrders(stripeMode)}, ${refundBasis === "refund_date" ? refundsByRefundDate : refundsByPaymentDate}`;
  return {
    totals: `${ctes}
      SELECT currency, SUM(orders) AS order_count, SUM(gross) AS gross_sales, SUM(charged) AS charged,
        SUM(refund) AS refunds, COUNT(DISTINCT refund_order) AS refunded_orders, SUM(undated) AS undated_refunds
      FROM (
        SELECT LOWER(o.currency) AS currency, 1 AS orders, ${grossOf("o")} AS gross, o.total_amount AS charged,
          0 AS refund, NULL AS refund_order, 0 AS undated
        FROM paid_orders o WHERE ${inPeriod("o.paid_at")}
        UNION ALL
        SELECT currency, 0, 0, 0, amount, order_id, CASE WHEN dated THEN 0 ELSE amount END
        FROM refund_events WHERE ${inPeriod("refunded_at")}
      ) GROUP BY currency ORDER BY currency`,
    daily: `${ctes}
      SELECT day, currency, SUM(orders) AS order_count, SUM(gross) - SUM(refund) AS net_sales
      FROM (
        SELECT date(o.paid_at, 'unixepoch') AS day, LOWER(o.currency) AS currency, 1 AS orders,
          ${grossOf("o")} AS gross, 0 AS refund
        FROM paid_orders o WHERE ${inPeriod("o.paid_at")}
        UNION ALL
        SELECT date(refunded_at, 'unixepoch'), currency, 0, 0, amount
        FROM refund_events WHERE ${inPeriod("refunded_at")}
      ) GROUP BY day, currency ORDER BY day ASC, currency ASC`,
    products: `WITH ${paidOrders(stripeMode)}
      SELECT json_extract(line.value, '$.productId') AS product_id,
        MAX(product.name) AS name, LOWER(o.currency) AS currency,
        SUM(CAST(json_extract(line.value, '$.quantity') AS INTEGER)) AS units,
        SUM(CAST(json_extract(line.value, '$.quantity') AS INTEGER) *
            CAST(json_extract(line.value, '$.priceAtPurchase') AS INTEGER)) AS item_sales
      FROM paid_orders o JOIN json_each(o.items) line
        LEFT JOIN _ecommerce_products product ON product.id = json_extract(line.value, '$.productId')
      WHERE ${inPeriod("o.paid_at")} AND o.status <> 'refunded'
      GROUP BY product_id, LOWER(o.currency)
      ORDER BY item_sales DESC LIMIT 20`
  };
}
function amount(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
async function detectRefundBasis(db) {
  try {
    const result = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).bind(providerRefundsTable).all();
    return result.results?.length ? "refund_date" : "payment_date";
  } catch {
    return "payment_date";
  }
}
async function fetchCommerceRange(db, start, end, adminBase = "/admin", productCollectionSlug = "products", stripeMode = "live") {
  const from = Math.floor(Date.parse(start) / 1e3);
  const to = Math.floor(Date.parse(end) / 1e3);
  const refundBasis = await detectRefundBasis(db);
  const sql = commerceSql(refundBasis, stripeMode);
  const [totals, daily, products] = await Promise.all([
    db.prepare(sql.totals).bind(from, to, from, to).all(),
    db.prepare(sql.daily).bind(from, to, from, to).all(),
    db.prepare(sql.products).bind(from, to).all()
  ]);
  const totalRows = totals.results || [];
  return {
    start,
    end,
    refundBasis,
    stripeMode: stripeMode === "test" ? "test" : "live",
    undatedRefunds: refundBasis === "refund_date" && totalRows.some((row) => amount(row.undated_refunds) > 0),
    currencies: totalRows.map((row) => {
      const orders = amount(row.order_count);
      const grossSales = amount(row.gross_sales);
      const refunds = amount(row.refunds);
      return {
        currency: row.currency,
        orders,
        grossSales,
        netSales: grossSales - refunds,
        refunds,
        refundedOrders: amount(row.refunded_orders),
        charged: amount(row.charged),
        averageOrderValue: orders ? Math.round(grossSales / orders) : 0
      };
    }),
    daily: (daily.results || []).map((row) => ({
      date: row.day,
      currency: row.currency,
      orders: amount(row.order_count),
      netSales: amount(row.net_sales)
    })),
    products: (products.results || []).filter((row) => row.product_id).map((row) => ({
      id: row.product_id,
      name: row.name || row.product_id,
      currency: row.currency,
      units: amount(row.units),
      itemSales: amount(row.item_sales),
      editHref: `${adminBase}/commerce/${encodeURIComponent(productCollectionSlug)}/${encodeURIComponent(row.product_id)}`
    }))
  };
}
async function fetchCommerceOverview(db, days, adminBase = "/admin", productCollectionSlug = "products", stripeMode = "live", now = /* @__PURE__ */ new Date()) {
  const { start, end } = periodBounds(days, now);
  return { periodDays: days, ...await fetchCommerceRange(db, start, end, adminBase, productCollectionSlug, stripeMode) };
}

export {
  providerRefundsTable,
  commerceSql,
  detectRefundBasis,
  fetchCommerceRange,
  fetchCommerceOverview
};
