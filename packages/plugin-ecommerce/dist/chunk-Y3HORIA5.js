import {
  chunked,
  placeholders
} from "./chunk-WP5KVMJI.js";
import {
  orders
} from "./chunk-SFZBZWCM.js";

// src/order-adjustments.ts
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDbClient } from "talisman-cms/client";

// src/inventory.ts
var INVENTORY_COLUMNS = {
  product: ["_ecommerce_products", "inventory_quantity"],
  variant: ["_ecommerce_product_variants", "inventory_quantity"],
  stock: ["_ecommerce_stocks", "quantity"]
};

// src/order-adjustments.ts
var OrderAdjustmentInputError = class extends Error {
  name = "OrderAdjustmentInputError";
};
var OrderAdjustmentRefusedError = class extends Error {
  name = "OrderAdjustmentRefusedError";
};
function parseInput(schema, input) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  throw new OrderAdjustmentInputError(issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message);
}
function fullRefundStatements(env, orderId, now) {
  const refunded = `EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'refunded')`;
  return [
    env.DB.prepare(`UPDATE _ecommerce_discount_redemptions
      SET status = 'refunded', updated_at = ?
      WHERE order_id = ? AND status = 'confirmed' AND ${refunded}`).bind(now, orderId, orderId),
    env.DB.prepare(`UPDATE _ecommerce_gift_card_redemptions
      SET status = 'refunded', updated_at = ?
      WHERE order_id = ? AND status = 'confirmed' AND ${refunded}`).bind(now, orderId, orderId),
    env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
      (id, account_id, order_id, kind, amount_cents, created_at)
      SELECT ?, user_id, id, 'purchase_credit_refund', credit_applied, ?
      FROM _ecommerce_orders WHERE id = ? AND status = 'refunded'
        AND credit_applied > 0 AND user_id IS NOT NULL
      ON CONFLICT(order_id, kind) DO NOTHING`).bind(`credit_refund_${orderId}`, now, orderId)
  ];
}
var isoTime = (seconds) => new Date(seconds * 1e3).toISOString();
var inventoryRows = (ids) => `SELECT 'inventory' AS type, r.id, r.order_id, r.target_type, r.target_id,
    r.quantity, r.released_at,
    CASE r.target_type WHEN 'product' THEN p.name
      WHEN 'variant' THEN gp.name || ' - ' || g.name
      ELSE vp.name || ' - ' || COALESCE(vd.name, vg.name) || ': ' || v.value END AS label,
    CASE r.target_type WHEN 'product' THEN p.sku
      WHEN 'variant' THEN COALESCE(g.sku, gp.sku)
      ELSE COALESCE(v.sku, vg.sku, vp.sku) END AS sku,
    CASE r.target_type WHEN 'product' THEN p.id WHEN 'variant' THEN g.id ELSE s.id END IS NOT NULL AS available,
    x.admin_actor, x.reason, x.created_at AS restocked_at
  FROM _ecommerce_inventory_reservations r
  LEFT JOIN _ecommerce_products p ON r.target_type = 'product' AND p.id = r.target_id
  LEFT JOIN _ecommerce_product_variants g ON r.target_type = 'variant' AND g.id = r.target_id
  LEFT JOIN _ecommerce_products gp ON gp.id = g.product_id
  LEFT JOIN _ecommerce_stocks s ON r.target_type = 'stock' AND s.id = r.target_id
  LEFT JOIN _ecommerce_product_variant_values v ON v.id = s.product_variant_value_id
  LEFT JOIN _ecommerce_product_variants vg ON vg.id = v.product_variant_id
  LEFT JOIN _ecommerce_variants vd ON vd.id = vg.variant_id
  LEFT JOIN _ecommerce_products vp ON vp.id = vg.product_id
  LEFT JOIN _ecommerce_restocks x ON x.reservation_type = 'inventory' AND x.reservation_id = r.id
  WHERE r.order_id IN (${placeholders(ids)})
  ORDER BY r.order_id, r.rowid`;
var componentRows = (ids) => `SELECT 'component' AS type, r.id, r.order_id, 'component' AS target_type,
    r.component_id AS target_id, r.quantity, r.released_at, c.name AS label, c.sku, c.id IS NOT NULL AS available,
    x.admin_actor, x.reason, x.created_at AS restocked_at
  FROM _ecommerce_component_reservations r
  LEFT JOIN _ecommerce_components c ON c.id = r.component_id
  LEFT JOIN _ecommerce_restocks x ON x.reservation_type = 'component' AND x.reservation_id = r.id
  WHERE r.order_id IN (${placeholders(ids)})
  ORDER BY r.order_id, r.rowid`;
function reservationView(row) {
  return {
    type: row.type,
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    label: row.label,
    sku: row.sku,
    quantity: row.quantity,
    returnedAt: row.released_at === null ? null : isoTime(row.released_at),
    restock: row.admin_actor === null ? null : {
      adminActor: row.admin_actor,
      reason: row.reason ?? "",
      createdAt: isoTime(row.restocked_at ?? 0)
    },
    available: row.available === 1
  };
}
async function loadReservations(env, orderIds) {
  const statements = chunked(orderIds).flatMap((ids) => [
    env.DB.prepare(inventoryRows(ids)).bind(...ids),
    env.DB.prepare(componentRows(ids)).bind(...ids)
  ]);
  const results = statements.length ? await env.DB.batch(statements) : [];
  return results.flatMap((result) => result.results ?? []);
}
function restockMode(order) {
  if ((order.paymentProvider ?? "stripe") === "admin_test") return null;
  return order.status === "refunded" ? "all" : order.status === "partially_refunded" ? "choose" : null;
}
var listSchema = z.object({
  orderIds: z.array(z.string().min(1).max(128)).min(1).max(100)
}).strict();
async function getOrderAdjustmentsAdmin(env, input) {
  const { orderIds } = parseInput(listSchema, input);
  const ids = [...new Set(orderIds)];
  const statements = chunked(ids).flatMap((chunk) => [
    env.DB.prepare(`SELECT id, status, payment_provider, fulfillment_status FROM _ecommerce_orders
      WHERE id IN (${placeholders(chunk)})`).bind(...chunk),
    env.DB.prepare(`SELECT id, order_id, amount_cents, currency, reason, status, status_before, created_at, closed_at
      FROM _ecommerce_disputes WHERE order_id IN (${placeholders(chunk)}) ORDER BY created_at, id`).bind(...chunk)
  ]);
  const results = await env.DB.batch(statements);
  const orders2 = results.filter((_, index) => index % 2 === 0).flatMap((result) => result.results ?? []);
  const disputes = results.filter((_, index) => index % 2 === 1).flatMap((result) => result.results ?? []);
  const reservations = await loadReservations(env, orders2.map((order) => order.id));
  return {
    orders: Object.fromEntries(orders2.map((order) => [order.id, {
      orderId: order.id,
      status: order.status,
      fulfillmentStatus: order.fulfillment_status,
      restock: restockMode({ status: order.status, paymentProvider: order.payment_provider }),
      disputes: disputes.filter((dispute) => dispute.order_id === order.id).map((dispute) => ({
        id: dispute.id,
        status: dispute.status,
        open: dispute.closed_at === null,
        reason: dispute.reason,
        amountCents: dispute.amount_cents,
        currency: dispute.currency,
        statusBefore: dispute.status_before,
        createdAt: isoTime(dispute.created_at),
        closedAt: dispute.closed_at === null ? null : isoTime(dispute.closed_at)
      })),
      reservations: reservations.filter((row) => row.order_id === order.id).map(reservationView)
    }]))
  };
}
var restockSchema = z.object({
  orderId: z.string().regex(/^ord_[0-9a-f-]{36}$/),
  reason: z.string().trim().min(8).max(500),
  // Every row not yet returned when left out, which only a fully refunded order allows.
  reservations: z.array(z.object({
    type: z.enum(["inventory", "component"]),
    id: z.string().min(1).max(128)
  }).strict()).min(1).max(200).optional()
}).strict();
function refusal(status) {
  if (status === "pending") {
    return "A pending order still holds its stock for checkout; it goes back if the checkout is cancelled";
  }
  if (status === "cancelled") return "A cancelled order returned its stock when it was cancelled";
  if (status === "disputed") return "A disputed order can be restocked once the dispute is lost or the order is refunded";
  return "Only a refunded or partially refunded order can be restocked";
}
async function restockOrder(env, actor, input) {
  const values = parseInput(restockSchema, input);
  if (!actor.trim()) throw new Error("Administrator identity is required");
  const order = await createDbClient(env).select({ status: orders.status, paymentProvider: orders.paymentProvider }).from(orders).where(eq(orders.id, values.orderId)).get();
  if (!order) throw new OrderAdjustmentRefusedError("Order not found");
  if ((order.paymentProvider ?? "stripe") === "admin_test") {
    throw new OrderAdjustmentRefusedError("Admin test orders take no stock to return");
  }
  const mode = restockMode(order);
  if (!mode) throw new OrderAdjustmentRefusedError(refusal(order.status));
  if (mode === "choose" && !values.reservations) {
    throw new OrderAdjustmentInputError("Choose the items to return to stock; the order is only partly refunded");
  }
  const rows = await loadReservations(env, [values.orderId]);
  const chosen = values.reservations ? values.reservations.map((wanted) => {
    const row = rows.find((candidate) => candidate.type === wanted.type && candidate.id === wanted.id);
    if (!row) throw new OrderAdjustmentInputError(`No ${wanted.type} reservation ${wanted.id} belongs to this order`);
    if (row.released_at !== null) throw new OrderAdjustmentRefusedError(`${row.label ?? row.target_id} is already back in stock`);
    if (row.available !== 1) {
      throw new OrderAdjustmentRefusedError(`${row.target_id} is no longer in the catalog, so its stock cannot be returned`);
    }
    return row;
  }) : rows.filter((row) => row.released_at === null && row.available === 1);
  if (!chosen.length) throw new OrderAdjustmentRefusedError("Nothing of this order is left to return to stock");
  if (new Set(chosen.map((row) => `${row.type}:${row.id}`)).size !== chosen.length) {
    throw new OrderAdjustmentInputError("Each item can be chosen once");
  }
  const now = Math.floor(Date.now() / 1e3);
  const list = JSON.stringify(chosen.map((row) => ({ id: `rstk_${crypto.randomUUID()}`, type: row.type, reservation: row.id })));
  const allowed = `EXISTS (SELECT 1 FROM _ecommerce_orders o WHERE o.id = ?
    AND o.status IN ('refunded','partially_refunded') AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test')`;
  const picked = `SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.reservation') AS reservation
    FROM json_each(?) WHERE json_extract(value, '$.type') = ?`;
  const returning = "RETURNING reservation_type, reservation_id, target_type, target_id, quantity";
  const statements = [
    env.DB.prepare(`INSERT INTO _ecommerce_restocks
      (id, order_id, reservation_type, reservation_id, target_type, target_id, quantity, admin_actor, reason, created_at)
      SELECT c.id, r.order_id, 'inventory', r.id, r.target_type, r.target_id, r.quantity, ?, ?, ?
      FROM (${picked}) AS c JOIN _ecommerce_inventory_reservations r ON r.id = c.reservation
      WHERE r.order_id = ? AND r.released_at IS NULL AND ${allowed}
        AND CASE r.target_type
          WHEN 'product' THEN EXISTS (SELECT 1 FROM _ecommerce_products WHERE id = r.target_id)
          WHEN 'variant' THEN EXISTS (SELECT 1 FROM _ecommerce_product_variants WHERE id = r.target_id)
          ELSE EXISTS (SELECT 1 FROM _ecommerce_stocks WHERE id = r.target_id) END
      ON CONFLICT DO NOTHING ${returning}`).bind(actor, values.reason, now, list, "inventory", values.orderId, values.orderId),
    env.DB.prepare(`INSERT INTO _ecommerce_restocks
      (id, order_id, reservation_type, reservation_id, target_type, target_id, quantity, admin_actor, reason, created_at)
      SELECT c.id, r.order_id, 'component', r.id, 'component', r.component_id, r.quantity, ?, ?, ?
      FROM (${picked}) AS c JOIN _ecommerce_component_reservations r ON r.id = c.reservation
      WHERE r.order_id = ? AND r.released_at IS NULL AND ${allowed}
      ON CONFLICT DO NOTHING ${returning}`).bind(actor, values.reason, now, list, "component", values.orderId, values.orderId)
  ];
  const written = `SELECT target_id, SUM(quantity) AS amount FROM _ecommerce_restocks
    WHERE order_id = ? AND target_type = ? AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
    GROUP BY target_id`;
  const stockColumns = { ...INVENTORY_COLUMNS, component: ["_ecommerce_components", "quantity"] };
  for (const [type, [table, column]] of Object.entries(stockColumns)) {
    statements.push(env.DB.prepare(`UPDATE ${table}
      SET ${column} = ${column} + returned.amount, updated_at = MAX(updated_at + 1, ?)
      FROM (${written}) AS returned WHERE ${table}.id = returned.target_id`).bind(now, values.orderId, type, list));
  }
  const reservationTables = { inventory: "_ecommerce_inventory_reservations", component: "_ecommerce_component_reservations" };
  for (const [type, table] of Object.entries(reservationTables)) {
    statements.push(env.DB.prepare(`UPDATE ${table} SET released_at = ?
      WHERE released_at IS NULL AND id IN (SELECT reservation_id FROM _ecommerce_restocks
        WHERE order_id = ? AND reservation_type = ? AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?)))`).bind(now, values.orderId, type, list));
  }
  const [inventory, component] = await env.DB.batch(statements);
  const restocked = [...inventory.results ?? [], ...component.results ?? []].map((row) => ({
    type: row.reservation_type,
    reservationId: row.reservation_id,
    targetType: row.target_type,
    targetId: row.target_id,
    quantity: row.quantity
  }));
  if (!restocked.length) {
    throw new OrderAdjustmentRefusedError("The order or its items changed while they were being restocked; reload and try again");
  }
  return { orderId: values.orderId, restocked };
}

export {
  INVENTORY_COLUMNS,
  OrderAdjustmentInputError,
  OrderAdjustmentRefusedError,
  fullRefundStatements,
  getOrderAdjustmentsAdmin,
  restockOrder
};
