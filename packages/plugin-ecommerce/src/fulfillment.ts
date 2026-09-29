import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import { batchGroups, chunked, commerceDb, errorText } from './db';
import { ORDER_AMOUNT_COLUMNS, describeOrderItems, orderAmounts } from './order-items';
import { deliverCommerceEmail } from './commerce-emails';
import { COMMERCE_EMAIL_LEASE_SECONDS, commerceEmailStatement } from './email-deliveries';
import { fulfillments, orders as ordersTable } from './schema';

/** Orders per page of the admin orders queue unless a request asks for another size. */
export const ORDERS_PAGE_SIZE = 50;
/** The largest page a request may ask for. */
export const ORDERS_PAGE_MAX = 100;

export type OrdersView = 'awaiting' | 'recent';
export type FulfillmentStatus = 'unfulfilled' | 'partially_fulfilled' | 'fulfilled';

/** Invalid input to the orders queue or to a shipment write. The admin route answers it with 400. */
export class FulfillmentInputError extends Error {
  override readonly name = 'FulfillmentInputError';
}

/** Payment statuses in which an order may ship; a disputed, refunded or cancelled order may not. */
const SHIPPABLE_STATUSES = ['paid', 'partially_refunded'];

// Each view repeats the WHERE clause of its partial index in the schema (`_ecommerce_orders_awaiting_idx`,
// `_ecommerce_orders_recent_idx`). SQLite uses a partial
// index only for a query that states the same conditions, with the same literals.
const REAL_ORDER = `COALESCE(payment_provider, 'stripe') <> 'admin_test'`;
const VIEWS: Record<OrdersView, { where: string; ascending: boolean }> = {
  // Every real order that can still ship, oldest first.
  awaiting: { where: `status IN ('paid','partially_refunded') AND fulfillment_status <> 'fulfilled' AND ${REAL_ORDER}`, ascending: true },
  // Real orders past checkout, newest first.
  recent: { where: `status NOT IN ('pending','cancelled','draft') AND ${REAL_ORDER}`, ascending: false },
};

const ORDER_COLUMNS = `id, status, fulfillment_status, payment_provider, customer_email, currency, items,
  shipping_address, ${ORDER_AMOUNT_COLUMNS}, created_at`;

type OrderRow = {
  id: string; status: string; fulfillment_status: FulfillmentStatus; payment_provider: string | null;
  customer_email: string | null; currency: string; items: string; shipping_address: string | null;
  subtotal_amount: number; discount_code: string | null; discount_amount: number; credit_applied: number;
  shipping_amount: number; shipping_label: string | null; tax_amount: number; tax_behavior: 'inclusive' | 'exclusive' | null;
  gift_card_applied: number; total_amount: number; provider_refunded_cents: number;
  gift_card_refunded_cents: number; created_at: number;
};
type StoredItem = { productId: string; variantId?: string; quantity: number; priceAtPurchase: number };
type FulfillmentRow = {
  id: string; order_id: string; kind: 'shipment' | 'correction'; corrects_id: string | null;
  completes_order: number; admin_actor: string; carrier: string | null; tracking_number: string | null;
  note: string; created_at: number;
};
type Correction = { id: string; createdAt: string; adminActor: string; carrier: string | null;
  trackingNumber: string | null; reason: string };
/** A shipment with the carrier and tracking number in force, as first recorded, and its corrections. */
type Shipment = { id: string; createdAt: string; adminActor: string; note: string; completesOrder: boolean;
  carrier: string | null; trackingNumber: string | null;
  recorded: { carrier: string | null; trackingNumber: string | null }; corrections: Correction[] };

const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((value) => value || null);

const listSchema = z.object({
  view: z.enum(['awaiting', 'recent']).default('awaiting'),
  // Room for an order id of about 3,000 ASCII characters; checkout writes ids of 40.
  cursor: z.string().max(4096).nullish(),
  limit: z.number().int().min(1).max(ORDERS_PAGE_MAX).default(ORDERS_PAGE_SIZE),
  query: z.string().trim().max(254).nullish(),
}).strict();

const shipmentSchema = z.object({
  orderId: z.string().regex(/^ord_[0-9a-f-]{36}$/),
  carrier: optionalText(100),
  trackingNumber: optionalText(150),
  note: z.string().trim().min(8).max(500),
  completesOrder: z.boolean().default(true),
}).strict();

const correctionSchema = z.object({
  fulfillmentId: z.string().trim().min(1).max(128),
  carrier: optionalText(100),
  trackingNumber: optionalText(150),
  reason: z.string().trim().min(8).max(500),
}).strict().refine((values) => values.carrier || values.trackingNumber, { message: 'Enter a carrier or a tracking number' });

function parseInput<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  throw new FulfillmentInputError(issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message);
}

const isoTime = (seconds: number) => new Date(seconds * 1000).toISOString();

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** The page position after `row` as URL-safe base64, tied to its view so that it is never read in the other direction. */
function encodeCursor(view: OrdersView, row: OrderRow) {
  const bytes = new TextEncoder().encode(JSON.stringify([view, row.created_at, row.id]));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(view: OrdersView, cursor: string) {
  try {
    const bytes = Uint8Array.from(atob(cursor.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));
    const [cursorView, createdAt, id] = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    // The id is only ever bound as a parameter, so any order id the page ended on is accepted.
    if (cursorView === view && Number.isSafeInteger(createdAt) && typeof id === 'string') {
      return [createdAt as number, id];
    }
  } catch {
    // Reported below.
  }
  throw new FulfillmentInputError('The page cursor is invalid; reload the orders');
}

// Fulfillment rows are only ever appended, so rowid is the order they were written in. `created_at`
// comes from the clock of whichever Worker wrote a row, so it is shown but never decides the order.

/** The shipments of these orders by order id, in the order recorded. The latest correction of a shipment is in force. */
async function loadShipments(env: TalismanEnv, orderIds: string[]) {
  const db = commerceDb(env);
  const { rows } = await batchGroups(db, {
    rows: chunked(orderIds).map((ids) => db.query.fulfillments.findMany({
      where: { orderId: { in: ids } }, orderBy: (_table, { sql }) => sql`rowid`,
    })),
  });
  const shipments = new Map<string, Shipment>();
  const byOrder = new Map<string, Shipment[]>();
  for (const row of rows) {
    if (row.kind === 'shipment') {
      const shipment: Shipment = { id: row.id, createdAt: row.createdAt.toISOString(), adminActor: row.adminActor,
        note: row.note, completesOrder: row.completesOrder,
        carrier: row.carrier, trackingNumber: row.trackingNumber,
        recorded: { carrier: row.carrier, trackingNumber: row.trackingNumber }, corrections: [] };
      shipments.set(row.id, shipment);
      byOrder.set(row.orderId, [...byOrder.get(row.orderId) ?? [], shipment]);
      continue;
    }
    // A correction comes after the shipment it names: the trigger requires that shipment to exist.
    const shipment = row.correctsId ? shipments.get(row.correctsId) : undefined;
    if (!shipment) continue;
    shipment.corrections.push({ id: row.id, createdAt: row.createdAt.toISOString(), adminActor: row.adminActor,
      carrier: row.carrier, trackingNumber: row.trackingNumber, reason: row.note });
    shipment.carrier = row.carrier;
    shipment.trackingNumber = row.trackingNumber;
  }
  return byOrder;
}

/**
 * One page of the admin orders queue. The `awaiting` view (the default) lists every real order that
 * can still ship, oldest first; `recent` lists real orders past checkout, newest first. Neither lists
 * admin test orders. Further pages follow `nextCursor`. `awaitingCount` counts every order awaiting
 * shipment, whatever the view, page or query. `query` is an exact order id or an email address.
 * Items carry the catalog's current names and SKUs, and each amount carries its label.
 */
export async function listCommerceOrdersAdmin(env: TalismanEnv, options: {
  view?: OrdersView; cursor?: string | null; limit?: number; query?: string | null;
} = {}) {
  const values = parseInput(listSchema, options);
  const view = VIEWS[values.view];
  const conditions = [view.where];
  const params: unknown[] = [];
  if (values.query?.includes('@')) {
    // Order emails have an index on lower(customer_email), `_ecommerce_orders_customer_email_idx`.
    conditions.push('lower(customer_email) = ?');
    params.push(values.query.toLowerCase());
  } else if (values.query) {
    conditions.push('id = ?');
    params.push(values.query);
  }
  if (values.cursor) {
    conditions.push(`(created_at, id) ${view.ascending ? '>' : '<'} (?, ?)`);
    params.push(...decodeCursor(values.view, values.cursor));
  }
  const direction = view.ascending ? 'ASC' : 'DESC';
  const [counted, listed] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_orders WHERE ${VIEWS.awaiting.where}`),
    env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM _ecommerce_orders WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ${direction}, id ${direction} LIMIT ?`).bind(...params, values.limit + 1),
  ]);
  const found = (listed.results ?? []) as OrderRow[];
  const rows = found.slice(0, values.limit);
  const storedItems = rows.map((row) => {
    const items = parseJson<StoredItem[]>(row.items, []);
    return Array.isArray(items) ? items.filter((item) => typeof item?.productId === 'string') : [];
  });
  const described = await describeOrderItems(env, storedItems.flat());
  const shipments = await loadShipments(env, rows.map((row) => row.id));
  let offset = 0;
  const orders = rows.map((row, index) => {
    const items = described.slice(offset, offset += storedItems[index].length);
    const provider = row.payment_provider ?? 'stripe';
    return {
      id: row.id,
      status: row.status,
      fulfillmentStatus: row.fulfillment_status,
      paymentProvider: provider,
      customerEmail: row.customer_email,
      currency: row.currency,
      createdAt: isoTime(row.created_at),
      shippingAddress: parseJson<Record<string, string> | null>(row.shipping_address, null),
      canShip: SHIPPABLE_STATUSES.includes(row.status) && row.fulfillment_status !== 'fulfilled' && provider !== 'admin_test',
      items: items.map((item) => ({
        productId: item.productId, variantId: item.variantId ?? null, quantity: item.quantity,
        unitAmount: item.priceAtPurchase, lineTotal: item.priceAtPurchase * item.quantity,
        productName: item.productName, variantLabel: item.variantLabel, sku: item.sku,
      })),
      amounts: orderAmounts(row),
      shipments: shipments.get(row.id) ?? [],
    };
  });
  return {
    view: values.view,
    pageSize: values.limit,
    awaitingCount: Number((counted.results?.[0] as { count?: number } | undefined)?.count ?? 0),
    nextCursor: found.length > values.limit ? encodeCursor(values.view, rows[rows.length - 1]) : null,
    orders,
  };
}

/** The trigger's own message for its refusal; D1 wraps it in driver text. */
/** The database's refusal (a trigger's message) as the error the caller sees, or the failure as it was. */
function refusal(cause: unknown, message: string) {
  return cause instanceof Error && errorText(cause).includes(message) ? new Error(message, { cause }) : cause;
}

/**
 * Records a shipment of a paid real order that has not shipped in full. It completes the order
 * unless `completesOrder` is false, which records one parcel of a split shipment. The database
 * trigger enforces the same rules. A later refund or dispute changes only the payment status.
 * The buyer is emailed a shipment notice with the carrier and tracking number; a failed send never
 * fails the shipment, and the scheduled job retries it.
 */
export async function fulfillCommerceOrder(env: TalismanEnv, actor: string, input: unknown) {
  const values = parseInput(shipmentSchema, input);
  if (!actor.trim()) throw new Error('Administrator identity is required');
  const db = commerceDb(env);
  const order = await db.select({ status: ordersTable.status, fulfillmentStatus: ordersTable.fulfillmentStatus,
    paymentProvider: ordersTable.paymentProvider }).from(ordersTable).where(eq(ordersTable.id, values.orderId)).get();
  if (!order) throw new Error('Order not found');
  if ((order.paymentProvider ?? 'stripe') === 'admin_test') throw new Error('Admin test orders cannot be fulfilled');
  if (order.fulfillmentStatus === 'fulfilled') throw new Error('Order has already shipped in full');
  if (!SHIPPABLE_STATUSES.includes(order.status)) {
    throw new Error(`A ${order.status.replaceAll('_', ' ')} order cannot ship`);
  }
  const id = `ful_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    // The notice is recorded with the shipment, so a shipment is never recorded without it.
    await db.batch([
      db.insert(fulfillments).values({ id, orderId: values.orderId, kind: 'shipment', completesOrder: values.completesOrder,
        adminActor: actor, carrier: values.carrier, trackingNumber: values.trackingNumber, note: values.note,
        createdAt: new Date(now * 1000) }),
      db.run(commerceEmailStatement('shipment', id, now)),
    ]);
  } catch (cause) {
    throw refusal(cause, 'Order is not ready for fulfillment');
  }
  await deliverCommerceEmail(env, 'shipment', id);
  const current = await db.select({ status: ordersTable.status, fulfillmentStatus: ordersTable.fulfillmentStatus })
    .from(ordersTable).where(eq(ordersTable.id, values.orderId)).get();
  return { fulfillmentId: id, orderId: values.orderId, status: current?.status,
    fulfillmentStatus: current?.fulfillmentStatus };
}

/**
 * Appends a correction that restates a shipment's carrier and tracking number, with the reason.
 * The shipment row never changes, so its history stays readable. A correction ships nothing, so any
 * payment status allows it; admin test orders do not. When the shipment's notice already went out (or
 * is being sent), the buyer gets an updated notice with the corrected details; a notice not sent yet
 * carries them anyway, since notices read the details in force when they are sent.
 */
export async function correctCommerceFulfillment(env: TalismanEnv, actor: string, input: unknown) {
  const values = parseInput(correctionSchema, input);
  if (!actor.trim()) throw new Error('Administrator identity is required');
  const { results } = await env.DB.prepare(`SELECT f.id, f.order_id, f.kind, f.corrects_id, f.carrier,
      f.tracking_number, o.payment_provider
    FROM _ecommerce_fulfillments f JOIN _ecommerce_orders o ON o.id = f.order_id
    WHERE f.order_id = (SELECT order_id FROM _ecommerce_fulfillments WHERE id = ?)
    ORDER BY f.rowid`).bind(values.fulfillmentId)
    .all<Pick<FulfillmentRow, 'id' | 'order_id' | 'kind' | 'corrects_id' | 'carrier' | 'tracking_number'>
      & { payment_provider: string | null }>();
  const rows = results ?? [];
  const shipment = rows.find((row) => row.id === values.fulfillmentId);
  if (!shipment || shipment.kind !== 'shipment') throw new Error('Shipment not found');
  if ((shipment.payment_provider ?? 'stripe') === 'admin_test') throw new Error('Admin test orders cannot be fulfilled');
  const current = rows.filter((row) => row.corrects_id === shipment.id).at(-1) ?? shipment;
  // A shipment row may hold an empty string where there is no value.
  if ((current.carrier || null) === values.carrier && (current.tracking_number || null) === values.trackingNumber) {
    throw new Error('The correction changes nothing');
  }
  const id = `ful_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const db = commerceDb(env);
  try {
    await db.batch([
      db.insert(fulfillments).values({ id, orderId: shipment.order_id, kind: 'correction', correctsId: shipment.id,
        completesOrder: false, adminActor: actor, carrier: values.carrier, trackingNumber: values.trackingNumber,
        note: values.reason, createdAt: new Date(now * 1000) }),
      // Only a live lease means the notice is being sent; after a stale one the notice carries the correction.
      db.run(commerceEmailStatement('shipment_update', id, now,
        sql`EXISTS (SELECT 1 FROM _ecommerce_email_deliveries WHERE kind = 'shipment' AND subject_id = ${shipment.id}
          AND (status = 'sent' OR (status = 'pending' AND claimed_at > ${now - COMMERCE_EMAIL_LEASE_SECONDS})))`)),
    ]);
  } catch (cause) {
    throw refusal(cause, 'Shipment cannot be corrected');
  }
  await deliverCommerceEmail(env, 'shipment_update', id);
  return { correctionId: id, fulfillmentId: shipment.id, orderId: shipment.order_id,
    carrier: values.carrier, trackingNumber: values.trackingNumber };
}
