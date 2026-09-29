import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import { batchGroups, chunked, commerceDb } from './db';
import { STOCK_COLUMNS } from './inventory';
import { componentReservations, inventoryReservations, orders as ordersTable, restocks } from './schema';

/** A time in Unix seconds as the schema's timestamp columns take it. */
const at = (seconds: number) => new Date(seconds * 1000);

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
export function fullRefundStatements(orderId: string, now: number): SQL[] {
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
      ON CONFLICT(order_id, kind) DO NOTHING`,
  ];
}

type ReservationType = 'inventory' | 'component';
type TargetType = 'product' | 'variant' | 'stock' | 'component';
type RestockedRow = { reservation_type: ReservationType; reservation_id: string; target_type: TargetType;
  target_id: string; quantity: number };

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

type Reservation = OrderReservation & { orderId: string };
type Restock = { adminActor: string; reason: string; createdAt: Date } | null;
const restockView = (restock: Restock) => restock && { adminActor: restock.adminActor, reason: restock.reason, createdAt: restock.createdAt.toISOString() };

type InventoryTarget = {
  targetType: 'product' | 'variant' | 'stock';
  product: { name: string; sku: string | null } | null;
  productVariant: { name: string; sku: string | null; product: { name: string; sku: string | null } } | null;
  stock: { productVariantValue: { value: string; sku: string | null;
    productVariant: { name: string; sku: string | null; variant: { name: string } | null; product: { name: string; sku: string | null } } } } | null;
};

/**
 * The catalog's current name and SKU for the stock an inventory reservation holds, or null when the
 * record is gone. Labels follow the checkout line: the product, then the variant definition (or
 * group) and the value. The SKU is the most specific one set.
 */
function inventoryTarget(row: InventoryTarget): { label: string; sku: string | null } | null {
  if (row.targetType === 'product') return row.product && { label: row.product.name, sku: row.product.sku };
  if (row.targetType === 'variant') {
    return row.productVariant && { label: `${row.productVariant.product.name} - ${row.productVariant.name}`,
      sku: row.productVariant.sku ?? row.productVariant.product.sku };
  }
  const value = row.stock?.productVariantValue;
  if (!value) return null;
  const group = value.productVariant;
  return { label: `${group.product.name} - ${group.variant?.name ?? group.name}: ${value.value}`,
    sku: value.sku ?? group.sku ?? group.product.sku };
}

/**
 * The reservation rows of these orders, inventory rows then component rows, each in the order
 * written, with the catalog's current name for the stock and the restock that returned it.
 */
async function loadReservations(env: TalismanEnv, orderIds: string[]): Promise<Reservation[]> {
  const db = commerceDb(env);
  const catalogNames = { columns: { name: true, sku: true } } as const;
  const restock = { columns: { adminActor: true, reason: true, createdAt: true } } as const;
  const rows = await batchGroups(db, {
    inventory: chunked(orderIds).map((ids) => db.query.inventoryReservations.findMany({
      where: { orderId: { in: ids } }, orderBy: (table, { sql }) => [table.orderId, sql`rowid`],
      with: {
        product: catalogNames,
        productVariant: { ...catalogNames, with: { product: catalogNames } },
        stock: { columns: { id: true }, with: { productVariantValue: { columns: { value: true, sku: true },
          with: { productVariant: { ...catalogNames, with: { variant: { columns: { name: true } }, product: catalogNames } } } } } },
        restock,
      },
    })),
    component: chunked(orderIds).map((ids) => db.query.componentReservations.findMany({
      where: { orderId: { in: ids } }, orderBy: (table, { sql }) => [table.orderId, sql`rowid`],
      with: { component: catalogNames, restock },
    })),
  });
  return [
    ...rows.inventory.map((row): Reservation => {
      const target = inventoryTarget(row);
      return { type: 'inventory', id: row.id, orderId: row.orderId, targetType: row.targetType, targetId: row.targetId,
        label: target?.label ?? null, sku: target?.sku ?? null, quantity: row.quantity,
        returnedAt: row.releasedAt?.toISOString() ?? null, restock: restockView(row.restock), available: target !== null };
    }),
    // A component cannot be deleted while a reservation names it, so its record is always there.
    ...rows.component.map((row): Reservation => ({
      type: 'component', id: row.id, orderId: row.orderId, targetType: 'component', targetId: row.componentId,
      label: row.component.name, sku: row.component.sku, quantity: row.quantity,
      returnedAt: row.releasedAt?.toISOString() ?? null, restock: restockView(row.restock), available: true,
    })),
  ];
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
  const db = commerceDb(env);
  const { orders } = await batchGroups(db, {
    orders: chunked([...new Set(orderIds)]).map((ids) => db.query.orders.findMany({
      columns: { id: true, status: true, paymentProvider: true, fulfillmentStatus: true },
      where: { id: { in: ids } },
      with: { disputes: { columns: { id: true, amountCents: true, currency: true, reason: true, status: true, statusBefore: true,
        createdAt: true, closedAt: true }, orderBy: { createdAt: 'asc', id: 'asc' } } },
    })),
  });
  const reservations = await loadReservations(env, orders.map((order) => order.id));
  return {
    orders: Object.fromEntries(orders.map((order) => [order.id, {
      orderId: order.id,
      status: order.status,
      fulfillmentStatus: order.fulfillmentStatus,
      restock: restockMode(order),
      disputes: order.disputes.map((dispute): OrderDispute => ({
        id: dispute.id, status: dispute.status, open: dispute.closedAt === null, reason: dispute.reason,
        amountCents: dispute.amountCents, currency: dispute.currency, statusBefore: dispute.statusBefore,
        createdAt: dispute.createdAt.toISOString(), closedAt: dispute.closedAt?.toISOString() ?? null,
      })),
      reservations: reservations.filter((row) => row.orderId === order.id).map(({ orderId: _orderId, ...row }): OrderReservation => row),
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
  const order = await commerceDb(env).select({ status: ordersTable.status, paymentProvider: ordersTable.paymentProvider })
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
      if (row.returnedAt !== null) throw new OrderAdjustmentRefusedError(`${row.label ?? row.targetId} is already back in stock`);
      if (!row.available) {
        throw new OrderAdjustmentRefusedError(`${row.targetId} is no longer in the catalog, so its stock cannot be returned`);
      }
      return row;
    })
    : rows.filter((row) => row.returnedAt === null && row.available);
  if (!chosen.length) throw new OrderAdjustmentRefusedError('Nothing of this order is left to return to stock');
  if (new Set(chosen.map((row) => `${row.type}:${row.id}`)).size !== chosen.length) {
    throw new OrderAdjustmentInputError('Each item can be chosen once');
  }

  const db = commerceDb(env);
  const now = Math.floor(Date.now() / 1000);
  const list = JSON.stringify(chosen.map((row) => ({ id: `rstk_${crypto.randomUUID()}`, type: row.type, reservation: row.id })));
  /** The ids of the audit rows this restock writes, read back from `list`. */
  const written = sql`(SELECT json_extract(value, '$.id') FROM json_each(${list}))`;
  // The audit rows come first, and only for rows of this order that no restock or cancellation returned
  // yet, while the order may be restocked; the unique key stops a second restock of the same row.
  const allowed = sql`EXISTS (SELECT 1 FROM _ecommerce_orders o WHERE o.id = ${values.orderId}
    AND o.status IN ('refunded','partially_refunded') AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test')`;
  const picked = (type: ReservationType) => sql`SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.reservation') AS reservation
    FROM json_each(${list}) WHERE json_extract(value, '$.type') = ${type}`;
  const returning = sql`RETURNING reservation_type, reservation_id, target_type, target_id, quantity`;
  const inventoryRestocks = db.all<RestockedRow>(sql`INSERT INTO _ecommerce_restocks
    (id, order_id, reservation_type, reservation_id, target_type, target_id, quantity, admin_actor, reason, created_at)
    SELECT c.id, r.order_id, 'inventory', r.id, r.target_type, r.target_id, r.quantity, ${actor}, ${values.reason}, ${now}
    FROM (${picked('inventory')}) AS c JOIN _ecommerce_inventory_reservations r ON r.id = c.reservation
    WHERE r.order_id = ${values.orderId} AND r.released_at IS NULL AND ${allowed}
      AND CASE r.target_type
        WHEN 'product' THEN EXISTS (SELECT 1 FROM _ecommerce_products WHERE id = r.target_id)
        WHEN 'variant' THEN EXISTS (SELECT 1 FROM _ecommerce_product_variants WHERE id = r.target_id)
        ELSE EXISTS (SELECT 1 FROM _ecommerce_stocks WHERE id = r.target_id) END
    ON CONFLICT DO NOTHING ${returning}`);
  const componentRestocks = db.all<RestockedRow>(sql`INSERT INTO _ecommerce_restocks
    (id, order_id, reservation_type, reservation_id, target_type, target_id, quantity, admin_actor, reason, created_at)
    SELECT c.id, r.order_id, 'component', r.id, 'component', r.component_id, r.quantity, ${actor}, ${values.reason}, ${now}
    FROM (${picked('component')}) AS c JOIN _ecommerce_component_reservations r ON r.id = c.reservation
    WHERE r.order_id = ${values.orderId} AND r.released_at IS NULL AND ${allowed}
    ON CONFLICT DO NOTHING ${returning}`);
  // Stock goes back once for each audit row written above, added to the current value. Like checkout,
  // the write moves updated_at by at least a second, so an admin save of stock loaded before is refused.
  const stockUpdates = Object.entries(STOCK_COLUMNS).map(([type, { table, quantity }]) => db.run(sql`UPDATE ${table}
    SET ${sql.identifier(quantity.name)} = ${sql.identifier(quantity.name)} + returned.amount, updated_at = MAX(updated_at + 1, ${now})
    FROM (SELECT target_id, SUM(quantity) AS amount FROM _ecommerce_restocks
      WHERE order_id = ${values.orderId} AND target_type = ${type} AND id IN ${written} GROUP BY target_id) AS returned
    WHERE ${table}.id = returned.target_id`));
  // Each reservation row restocked above is marked released, so it never goes back twice.
  const restockedReservations = (type: ReservationType) => db.select({ id: restocks.reservationId }).from(restocks)
    .where(and(eq(restocks.orderId, values.orderId), eq(restocks.reservationType, type), inArray(restocks.id, written)));
  const releases = [
    db.update(inventoryReservations).set({ releasedAt: at(now) })
      .where(and(isNull(inventoryReservations.releasedAt), inArray(inventoryReservations.id, restockedReservations('inventory')))),
    db.update(componentReservations).set({ releasedAt: at(now) })
      .where(and(isNull(componentReservations.releasedAt), inArray(componentReservations.id, restockedReservations('component')))),
  ];
  const [inventory, component] = await db.batch([inventoryRestocks, componentRestocks, ...stockUpdates, ...releases]);
  const restocked = [...inventory, ...component].map((row) => ({ type: row.reservation_type,
    reservationId: row.reservation_id, targetType: row.target_type, targetId: row.target_id, quantity: row.quantity }));
  if (!restocked.length) {
    throw new OrderAdjustmentRefusedError('The order or its items changed while they were being restocked; reload and try again');
  }
  return { orderId: values.orderId, restocked };
}
