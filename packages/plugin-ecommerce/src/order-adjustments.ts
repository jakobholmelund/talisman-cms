import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createDbClient, type TalismanEnv } from 'talisman-cms/client';
import { INVENTORY_COLUMNS } from './inventory';
import { chunked, placeholders } from './order-items';
import { orders as ordersTable } from './schema';

/** Invalid input to an order adjustment. The admin route answers it with 400. */
export class OrderAdjustmentInputError extends Error {
  override readonly name = 'OrderAdjustmentInputError';
}

/** An adjustment the order's current state does not allow; the message says why. The admin route answers 409. */
export class OrderAdjustmentRefusedError extends Error {
  override readonly name = 'OrderAdjustmentRefusedError';
}

function parseInput<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  throw new OrderAdjustmentInputError(issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message);
}

/**
 * Statements that apply a full refund's effects once the order is 'refunded': its promotion and gift
 * card redemptions become refunded (the database triggers return a credit voucher's balance and the
 * gift card's value) and the store credit it used goes back to the shopper. Each is guarded by the
 * order's status and repeats safely, so add them after the statement that refunds the order. A
 * provider refund of the whole charge and a lost dispute both use them.
 */
export function fullRefundStatements(env: TalismanEnv, orderId: string, now: number): D1PreparedStatement[] {
  const refunded = `EXISTS (SELECT 1 FROM _ecommerce_orders WHERE id = ? AND status = 'refunded')`;
  return [
    env.DB.prepare(`UPDATE _ecommerce_discount_redemptions
      SET status = 'refunded', updated_at = ?
      WHERE order_id = ? AND status = 'confirmed' AND ${refunded}`)
      .bind(now, orderId, orderId),
    env.DB.prepare(`UPDATE _ecommerce_gift_card_redemptions
      SET status = 'refunded', updated_at = ?
      WHERE order_id = ? AND status = 'confirmed' AND ${refunded}`)
      .bind(now, orderId, orderId),
    env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
      (id, account_id, order_id, kind, amount_cents, created_at)
      SELECT ?, user_id, id, 'purchase_credit_refund', credit_applied, ?
      FROM _ecommerce_orders WHERE id = ? AND status = 'refunded'
        AND credit_applied > 0 AND user_id IS NOT NULL
      ON CONFLICT(order_id, kind) DO NOTHING`)
      .bind(`credit_refund_${orderId}`, now, orderId),
  ];
}

type ReservationType = 'inventory' | 'component';
type TargetType = 'product' | 'variant' | 'stock' | 'component';
type RestockedRow = { reservation_type: ReservationType; reservation_id: string; target_type: TargetType;
  target_id: string; quantity: number };

type ReservationRow = {
  type: ReservationType; id: string; order_id: string; target_type: TargetType; target_id: string;
  quantity: number; released_at: number | null; label: string | null; sku: string | null; available: number;
  admin_actor: string | null; reason: string | null; restocked_at: number | null;
};

/** A reservation row of an order: the stock one line of it took, and whether that went back. */
export type OrderReservation = {
  type: ReservationType; id: string; targetType: TargetType; targetId: string;
  /** The catalog's current name for the stock; null when the record no longer exists. */
  label: string | null; sku: string | null; quantity: number;
  /** When the stock went back: by a restock, or by the cancellation of an unpaid checkout. */
  returnedAt: string | null;
  restock: { adminActor: string; reason: string; createdAt: string } | null;
  /** Whether the stock record still exists, so the row can be returned to it. */
  available: boolean;
};

export type OrderDispute = {
  id: string; status: string; open: boolean; reason: string | null; amountCents: number; currency: string;
  statusBefore: string; createdAt: string; closedAt: string | null;
};

const isoTime = (seconds: number) => new Date(seconds * 1000).toISOString();

// Labels follow the checkout line: the product, then the variant definition (or group) and the value.
const inventoryRows = (ids: string[]) => `SELECT 'inventory' AS type, r.id, r.order_id, r.target_type, r.target_id,
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

const componentRows = (ids: string[]) => `SELECT 'component' AS type, r.id, r.order_id, 'component' AS target_type,
    r.component_id AS target_id, r.quantity, r.released_at, c.name AS label, c.sku, c.id IS NOT NULL AS available,
    x.admin_actor, x.reason, x.created_at AS restocked_at
  FROM _ecommerce_component_reservations r
  LEFT JOIN _ecommerce_components c ON c.id = r.component_id
  LEFT JOIN _ecommerce_restocks x ON x.reservation_type = 'component' AND x.reservation_id = r.id
  WHERE r.order_id IN (${placeholders(ids)})
  ORDER BY r.order_id, r.rowid`;

function reservationView(row: ReservationRow): OrderReservation {
  return {
    type: row.type, id: row.id, targetType: row.target_type, targetId: row.target_id,
    label: row.label, sku: row.sku, quantity: row.quantity,
    returnedAt: row.released_at === null ? null : isoTime(row.released_at),
    restock: row.admin_actor === null ? null : { adminActor: row.admin_actor, reason: row.reason ?? '',
      createdAt: isoTime(row.restocked_at ?? 0) },
    available: row.available === 1,
  };
}

async function loadReservations(env: TalismanEnv, orderIds: string[]) {
  const statements = chunked(orderIds).flatMap((ids) => [
    env.DB.prepare(inventoryRows(ids)).bind(...ids),
    env.DB.prepare(componentRows(ids)).bind(...ids),
  ]);
  const results = statements.length ? await env.DB.batch<ReservationRow>(statements) : [];
  return results.flatMap((result) => result.results ?? []);
}

/** Order statuses whose stock can go back: every row of a refunded order, chosen rows of a partly refunded one. */
function restockMode(order: { status: string; paymentProvider: string | null }) {
  if ((order.paymentProvider ?? 'stripe') === 'admin_test') return null;
  return order.status === 'refunded' ? 'all' as const : order.status === 'partially_refunded' ? 'choose' as const : null;
}

const listSchema = z.object({
  orderIds: z.array(z.string().min(1).max(128)).min(1).max(100),
}).strict();

/**
 * Disputes and stock for the admin orders screen, by order id: each order's payment disputes, oldest
 * first; its reservation rows with what went back to stock, when and by whom; whether it can be
 * restocked now ('all' rows of a refunded order, 'choose' rows of a partly refunded one, or null);
 * and how much of it shipped, since shipped goods come back only when the buyer returns them.
 * Order ids that match no order are left out.
 */
export async function getOrderAdjustmentsAdmin(env: TalismanEnv, input: unknown) {
  const { orderIds } = parseInput(listSchema, input);
  const ids = [...new Set(orderIds)];
  const statements = chunked(ids).flatMap((chunk) => [
    env.DB.prepare(`SELECT id, status, payment_provider, fulfillment_status FROM _ecommerce_orders
      WHERE id IN (${placeholders(chunk)})`).bind(...chunk),
    env.DB.prepare(`SELECT id, order_id, amount_cents, currency, reason, status, status_before, created_at, closed_at
      FROM _ecommerce_disputes WHERE order_id IN (${placeholders(chunk)}) ORDER BY created_at, id`).bind(...chunk),
  ]);
  const results = await env.DB.batch<Record<string, any>>(statements);
  const orders = results.filter((_, index) => index % 2 === 0).flatMap((result) => result.results ?? []) as
    Array<{ id: string; status: string; payment_provider: string | null; fulfillment_status: string }>;
  const disputes = results.filter((_, index) => index % 2 === 1).flatMap((result) => result.results ?? []) as
    Array<{ id: string; order_id: string; amount_cents: number; currency: string; reason: string | null; status: string;
      status_before: string; created_at: number; closed_at: number | null }>;
  const reservations = await loadReservations(env, orders.map((order) => order.id));
  return {
    orders: Object.fromEntries(orders.map((order) => [order.id, {
      orderId: order.id,
      status: order.status,
      fulfillmentStatus: order.fulfillment_status,
      restock: restockMode({ status: order.status, paymentProvider: order.payment_provider }),
      disputes: disputes.filter((dispute) => dispute.order_id === order.id).map((dispute): OrderDispute => ({
        id: dispute.id, status: dispute.status, open: dispute.closed_at === null, reason: dispute.reason,
        amountCents: dispute.amount_cents, currency: dispute.currency, statusBefore: dispute.status_before,
        createdAt: isoTime(dispute.created_at), closedAt: dispute.closed_at === null ? null : isoTime(dispute.closed_at),
      })),
      reservations: reservations.filter((row) => row.order_id === order.id).map(reservationView),
    }])),
  };
}

const restockSchema = z.object({
  orderId: z.string().regex(/^ord_[0-9a-f-]{36}$/),
  reason: z.string().trim().min(8).max(500),
  // Every row not yet returned when left out, which only a fully refunded order allows.
  reservations: z.array(z.object({
    type: z.enum(['inventory', 'component']),
    id: z.string().min(1).max(128),
  }).strict()).min(1).max(200).optional(),
}).strict();

function refusal(status: string) {
  if (status === 'pending') {
    return 'A pending order still holds its stock for checkout; it goes back if the checkout is cancelled';
  }
  if (status === 'cancelled') return 'A cancelled order returned its stock when it was cancelled';
  if (status === 'disputed') return 'A disputed order can be restocked once the dispute is lost or the order is refunded';
  return 'Only a refunded or partially refunded order can be restocked';
}

/**
 * Returns stock that a refunded order took, and records who returned it and why in
 * _ecommerce_restocks. Without `reservations`, every row of a refunded order not yet returned goes
 * back; a partially refunded order needs the rows chosen. Stock is added to its current value, and
 * each reservation row is marked released, so no row goes back twice, whether restocked again or
 * cancelled. Pending, cancelled, paid, disputed and admin test orders are refused with
 * OrderAdjustmentRefusedError, invalid input with OrderAdjustmentInputError.
 */
export async function restockOrder(env: TalismanEnv, actor: string, input: unknown) {
  const values = parseInput(restockSchema, input);
  if (!actor.trim()) throw new Error('Administrator identity is required');
  const order = await createDbClient(env).select({ status: ordersTable.status, paymentProvider: ordersTable.paymentProvider })
    .from(ordersTable).where(eq(ordersTable.id, values.orderId)).get();
  if (!order) throw new OrderAdjustmentRefusedError('Order not found');
  if ((order.paymentProvider ?? 'stripe') === 'admin_test') {
    throw new OrderAdjustmentRefusedError('Admin test orders take no stock to return');
  }
  const mode = restockMode(order);
  if (!mode) throw new OrderAdjustmentRefusedError(refusal(order.status));
  if (mode === 'choose' && !values.reservations) {
    throw new OrderAdjustmentInputError('Choose the items to return to stock; the order is only partly refunded');
  }
  const rows = await loadReservations(env, [values.orderId]);
  const chosen = values.reservations
    ? values.reservations.map((wanted) => {
      const row = rows.find((candidate) => candidate.type === wanted.type && candidate.id === wanted.id);
      if (!row) throw new OrderAdjustmentInputError(`No ${wanted.type} reservation ${wanted.id} belongs to this order`);
      if (row.released_at !== null) throw new OrderAdjustmentRefusedError(`${row.label ?? row.target_id} is already back in stock`);
      if (row.available !== 1) {
        throw new OrderAdjustmentRefusedError(`${row.target_id} is no longer in the catalog, so its stock cannot be returned`);
      }
      return row;
    })
    : rows.filter((row) => row.released_at === null && row.available === 1);
  if (!chosen.length) throw new OrderAdjustmentRefusedError('Nothing of this order is left to return to stock');
  if (new Set(chosen.map((row) => `${row.type}:${row.id}`)).size !== chosen.length) {
    throw new OrderAdjustmentInputError('Each item can be chosen once');
  }

  const now = Math.floor(Date.now() / 1000);
  const list = JSON.stringify(chosen.map((row) => ({ id: `rstk_${crypto.randomUUID()}`, type: row.type, reservation: row.id })));
  // The audit rows come first, and only for rows of this order that no restock or cancellation returned
  // yet, while the order may be restocked; the unique key stops a second restock of the same row.
  const allowed = `EXISTS (SELECT 1 FROM _ecommerce_orders o WHERE o.id = ?
    AND o.status IN ('refunded','partially_refunded') AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test')`;
  const picked = `SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.reservation') AS reservation
    FROM json_each(?) WHERE json_extract(value, '$.type') = ?`;
  const returning = 'RETURNING reservation_type, reservation_id, target_type, target_id, quantity';
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO _ecommerce_restocks
      (id, order_id, reservation_type, reservation_id, target_type, target_id, quantity, admin_actor, reason, created_at)
      SELECT c.id, r.order_id, 'inventory', r.id, r.target_type, r.target_id, r.quantity, ?, ?, ?
      FROM (${picked}) AS c JOIN _ecommerce_inventory_reservations r ON r.id = c.reservation
      WHERE r.order_id = ? AND r.released_at IS NULL AND ${allowed}
        AND CASE r.target_type
          WHEN 'product' THEN EXISTS (SELECT 1 FROM _ecommerce_products WHERE id = r.target_id)
          WHEN 'variant' THEN EXISTS (SELECT 1 FROM _ecommerce_product_variants WHERE id = r.target_id)
          ELSE EXISTS (SELECT 1 FROM _ecommerce_stocks WHERE id = r.target_id) END
      ON CONFLICT DO NOTHING ${returning}`)
      .bind(actor, values.reason, now, list, 'inventory', values.orderId, values.orderId),
    env.DB.prepare(`INSERT INTO _ecommerce_restocks
      (id, order_id, reservation_type, reservation_id, target_type, target_id, quantity, admin_actor, reason, created_at)
      SELECT c.id, r.order_id, 'component', r.id, 'component', r.component_id, r.quantity, ?, ?, ?
      FROM (${picked}) AS c JOIN _ecommerce_component_reservations r ON r.id = c.reservation
      WHERE r.order_id = ? AND r.released_at IS NULL AND ${allowed}
      ON CONFLICT DO NOTHING ${returning}`)
      .bind(actor, values.reason, now, list, 'component', values.orderId, values.orderId),
  ];
  // Stock goes back once for each audit row written above, added to the current value. Like checkout,
  // the write moves updated_at by at least a second, so an admin save of stock loaded before is refused.
  const written = `SELECT target_id, SUM(quantity) AS amount FROM _ecommerce_restocks
    WHERE order_id = ? AND target_type = ? AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
    GROUP BY target_id`;
  const stockColumns = { ...INVENTORY_COLUMNS, component: ['_ecommerce_components', 'quantity'] } as const;
  for (const [type, [table, column]] of Object.entries(stockColumns)) {
    statements.push(env.DB.prepare(`UPDATE ${table}
      SET ${column} = ${column} + returned.amount, updated_at = MAX(updated_at + 1, ?)
      FROM (${written}) AS returned WHERE ${table}.id = returned.target_id`)
      .bind(now, values.orderId, type, list));
  }
  const reservationTables = { inventory: '_ecommerce_inventory_reservations', component: '_ecommerce_component_reservations' };
  for (const [type, table] of Object.entries(reservationTables)) {
    statements.push(env.DB.prepare(`UPDATE ${table} SET released_at = ?
      WHERE released_at IS NULL AND id IN (SELECT reservation_id FROM _ecommerce_restocks
        WHERE order_id = ? AND reservation_type = ? AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?)))`)
      .bind(now, values.orderId, type, list));
  }
  const [inventory, component] = await env.DB.batch<RestockedRow>(statements);
  const restocked = [...inventory.results ?? [], ...component.results ?? []].map((row) => ({ type: row.reservation_type,
    reservationId: row.reservation_id, targetType: row.target_type, targetId: row.target_id, quantity: row.quantity }));
  if (!restocked.length) {
    throw new OrderAdjustmentRefusedError('The order or its items changed while they were being restocked; reload and try again');
  }
  return { orderId: values.orderId, restocked };
}
