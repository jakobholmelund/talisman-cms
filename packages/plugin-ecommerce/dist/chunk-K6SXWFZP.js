import {
  batchGroups,
  chunked,
  commerceDb
} from "./chunk-ZI5IJOR6.js";
import {
  orders
} from "./chunk-NKJTK7MK.js";

// src/order-adjustments.ts
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

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
function fullRefundStatements(orderId, now) {
  const refunded = sql`EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ${orderId} AND status = 'refunded')`;
  return [
    sql`UPDATE _ecommerce_discount_redemptions
      SET status = 'refunded', updated_at = ${now}
      WHERE order_id = ${orderId} AND status = 'confirmed' AND ${refunded}`,
    sql`UPDATE _ecommerce_gift_card_redemptions
      SET status = 'refunded', updated_at = ${now}
      WHERE order_id = ${orderId} AND status = 'confirmed' AND ${refunded}`,
    sql`INSERT INTO _ecommerce_credit_ledger
      (id, account_id, order_id, kind, amount_cents, created_at)
      SELECT ${`credit_refund_${orderId}`}, user_id, id, 'purchase_credit_refund', credit_applied, ${now}
      FROM _ecommerce_orders WHERE id = ${orderId} AND status = 'refunded'
        AND credit_applied > 0 AND user_id IS NOT NULL
      ON CONFLICT(order_id, kind) DO NOTHING`
  ];
}
var restockView = (restock) => restock && { adminActor: restock.adminActor, reason: restock.reason, createdAt: restock.createdAt.toISOString() };
function inventoryTarget(row) {
  if (row.targetType === "product") return row.product && { label: row.product.name, sku: row.product.sku };
  if (row.targetType === "variant") {
    return row.productVariant && {
      label: `${row.productVariant.product.name} - ${row.productVariant.name}`,
      sku: row.productVariant.sku ?? row.productVariant.product.sku
    };
  }
  const value = row.stock?.productVariantValue;
  if (!value) return null;
  const group = value.productVariant;
  return {
    label: `${group.product.name} - ${group.variant?.name ?? group.name}: ${value.value}`,
    sku: value.sku ?? group.sku ?? group.product.sku
  };
}
async function loadReservations(env, orderIds) {
  const db = commerceDb(env);
  const catalogNames = { columns: { name: true, sku: true } };
  const restock = { columns: { adminActor: true, reason: true, createdAt: true } };
  const rows = await batchGroups(db, {
    inventory: chunked(orderIds).map((ids) => db.query.inventoryReservations.findMany({
      where: { orderId: { in: ids } },
      orderBy: (table, { sql: sql2 }) => [table.orderId, sql2`rowid`],
      with: {
        product: catalogNames,
        productVariant: { ...catalogNames, with: { product: catalogNames } },
        stock: { columns: { id: true }, with: { productVariantValue: {
          columns: { value: true, sku: true },
          with: { productVariant: { ...catalogNames, with: { variant: { columns: { name: true } }, product: catalogNames } } }
        } } },
        restock
      }
    })),
    component: chunked(orderIds).map((ids) => db.query.componentReservations.findMany({
      where: { orderId: { in: ids } },
      orderBy: (table, { sql: sql2 }) => [table.orderId, sql2`rowid`],
      with: { component: catalogNames, restock }
    }))
  });
  return [
    ...rows.inventory.map((row) => {
      const target = inventoryTarget(row);
      return {
        type: "inventory",
        id: row.id,
        orderId: row.orderId,
        targetType: row.targetType,
        targetId: row.targetId,
        label: target?.label ?? null,
        sku: target?.sku ?? null,
        quantity: row.quantity,
        returnedAt: row.releasedAt?.toISOString() ?? null,
        restock: restockView(row.restock),
        available: target !== null
      };
    }),
    // A component cannot be deleted while a reservation names it, so its record is always there.
    ...rows.component.map((row) => ({
      type: "component",
      id: row.id,
      orderId: row.orderId,
      targetType: "component",
      targetId: row.componentId,
      label: row.component.name,
      sku: row.component.sku,
      quantity: row.quantity,
      returnedAt: row.releasedAt?.toISOString() ?? null,
      restock: restockView(row.restock),
      available: true
    }))
  ];
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
  const db = commerceDb(env);
  const { orders: orders2 } = await batchGroups(db, {
    orders: chunked([...new Set(orderIds)]).map((ids) => db.query.orders.findMany({
      columns: { id: true, status: true, paymentProvider: true, fulfillmentStatus: true },
      where: { id: { in: ids } },
      with: { disputes: { columns: {
        id: true,
        amountCents: true,
        currency: true,
        reason: true,
        status: true,
        statusBefore: true,
        createdAt: true,
        closedAt: true
      }, orderBy: { createdAt: "asc", id: "asc" } } }
    }))
  });
  const reservations = await loadReservations(env, orders2.map((order) => order.id));
  return {
    orders: Object.fromEntries(orders2.map((order) => [order.id, {
      orderId: order.id,
      status: order.status,
      fulfillmentStatus: order.fulfillmentStatus,
      restock: restockMode(order),
      disputes: order.disputes.map((dispute) => ({
        id: dispute.id,
        status: dispute.status,
        open: dispute.closedAt === null,
        reason: dispute.reason,
        amountCents: dispute.amountCents,
        currency: dispute.currency,
        statusBefore: dispute.statusBefore,
        createdAt: dispute.createdAt.toISOString(),
        closedAt: dispute.closedAt?.toISOString() ?? null
      })),
      reservations: reservations.filter((row) => row.orderId === order.id).map(({ orderId: _orderId, ...row }) => row)
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
  const order = await commerceDb(env).select({ status: orders.status, paymentProvider: orders.paymentProvider }).from(orders).where(eq(orders.id, values.orderId)).get();
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
    if (row.returnedAt !== null) throw new OrderAdjustmentRefusedError(`${row.label ?? row.targetId} is already back in stock`);
    if (!row.available) {
      throw new OrderAdjustmentRefusedError(`${row.targetId} is no longer in the catalog, so its stock cannot be returned`);
    }
    return row;
  }) : rows.filter((row) => row.returnedAt === null && row.available);
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
