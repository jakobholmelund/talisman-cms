import { parcelItemsSchema, parcelContentsValue } from './warehouse';
import { loadOrderActivity } from './order-activity';
import { hashOrderAccess } from './cookies';
import { and, asc, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import { batchGroups, chunked, commerceDb, errorText } from './db';
import { describeOrderItems, orderAmountColumns, orderAmounts } from './order-items';
import { deliverCommerceEmail } from './commerce-emails';
import { COMMERCE_EMAIL_LEASE_SECONDS, commerceEmailStatement } from './email-deliveries';
import { fulfillments, parcelContents, orders as ordersTable } from './schema';

/** Orders per page of the admin orders queue unless a request asks for another size. */
export const ORDERS_PAGE_SIZE = 50;
/** The largest page a request may ask for. */
export const ORDERS_PAGE_MAX = 100;

export type OrdersView = 'awaiting' | 'recent' | 'partial' | 'shipped' | 'refunded' | 'disputed';
export type FulfillmentStatus = 'unfulfilled' | 'partially_fulfilled' | 'fulfilled';

/** Invalid input to the orders queue or to a shipment write. The admin route answers it with 400. */
export class FulfillmentInputError extends Error {
  override readonly name = 'FulfillmentInputError';
}

/** Payment statuses in which an order may ship; a disputed, refunded or cancelled order may not. */
const SHIPPABLE_STATUSES = ['paid', 'partially_refunded'];

// Each view repeats the WHERE clause of its partial index in the schema (`_ecommerce_orders_awaiting_idx`,
// `_ecommerce_orders_recent_idx`), literals included: SQLite uses a partial index only for a query that
// states the same conditions, and a bound parameter would not match.
const REAL_ORDER = sql`COALESCE(${ordersTable.paymentProvider}, 'stripe') <> 'admin_test'`;
const VIEWS: Record<OrdersView, { where: SQL; ascending: boolean }> = {
  // Every real order that can still ship, oldest first.
  awaiting: { where: sql`${ordersTable.status} IN ('paid','partially_refunded') AND ${ordersTable.fulfillmentStatus} <> 'fulfilled' AND ${REAL_ORDER}`, ascending: true },
  // Real orders past checkout, newest first.
  recent: { where: sql`${ordersTable.status} NOT IN ('pending','cancelled','draft') AND ${REAL_ORDER}`, ascending: false },
  partial: { where: sql`${ordersTable.status} IN ('paid','partially_refunded') AND ${ordersTable.fulfillmentStatus} = 'partially_fulfilled' AND ${REAL_ORDER}`, ascending: true },
  shipped: { where: sql`${ordersTable.status} NOT IN ('pending','cancelled','draft') AND ${ordersTable.fulfillmentStatus} = 'fulfilled' AND ${REAL_ORDER}`, ascending: false },
  refunded: { where: sql`${ordersTable.status} IN ('refunded','partially_refunded') AND ${REAL_ORDER}`, ascending: false },
  disputed: { where: sql`${ordersTable.status} = 'disputed' AND ${REAL_ORDER}`, ascending: true },
};

/** The order columns the queue lists, with the amounts `orderAmounts` labels. */
const orderColumns = { id: ordersTable.id, status: ordersTable.status, fulfillmentStatus: ordersTable.fulfillmentStatus,
  paymentProvider: ordersTable.paymentProvider, customerEmail: ordersTable.customerEmail, currency: ordersTable.currency,
  items: ordersTable.items, shippingAddress: ordersTable.shippingAddress, ...orderAmountColumns, createdAt: ordersTable.createdAt };
type OrderRow = Pick<typeof ordersTable.$inferSelect, keyof typeof orderColumns>;
type Correction = { id: string; createdAt: string; adminActor: string; carrier: string | null;
  trackingNumber: string | null; reason: string };
/** A shipment with the carrier and tracking number in force, as first recorded, and its corrections. */
type Shipment = { id: string; createdAt: string; adminActor: string; note: string; completesOrder: boolean;
  carrier: string | null; trackingNumber: string | null;
  recorded: { carrier: string | null; trackingNumber: string | null }; corrections: Correction[] };

const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((value) => value || null);

const listSchema = z.object({
  view: z.enum(['awaiting', 'recent', 'partial', 'shipped', 'refunded', 'disputed']).default('awaiting'),
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
  items: parcelItemsSchema.optional(),
  requestKey: z.string().trim().min(8).max(128).optional(),
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

/** The page position after `row` as URL-safe base64, tied to its view so that it is never read in the other direction. */
function encodeCursor(view: OrdersView, row: OrderRow) {
  const bytes = new TextEncoder().encode(JSON.stringify([view, Math.floor(row.createdAt.getTime() / 1000), row.id]));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** The created_at (Unix seconds) and id a cursor names. */
function decodeCursor(view: OrdersView, cursor: string): [number, string] {
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
      where: { orderId: { in: ids } }, with: { contents: true, order: { columns: { items: true } } }, orderBy: (_table, { sql }) => sql`rowid`,
    })),
  });
  const shipments = new Map<string, Shipment>();
  const byOrder = new Map<string, Shipment[]>();
  const counts = new Map<string, Map<number, number>>();
  const unknown = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'shipment') {
      const shipped = counts.get(row.orderId) ?? new Map<number, number>();
      if (!row.contents) unknown.add(row.orderId);
      else for (const item of row.contents.items) shipped.set(item.lineIndex, (shipped.get(item.lineIndex) ?? 0) + item.quantity);
      counts.set(row.orderId, shipped);
      const completes = row.contents && !unknown.has(row.orderId)
        ? row.order.items.every((item, index) => (shipped.get(index) ?? 0) >= item.quantity) : row.completesOrder;
      const shipment: Shipment = { id: row.id, createdAt: row.createdAt.toISOString(), adminActor: row.adminActor,
        note: row.note, completesOrder: completes,
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
  if (values.query?.includes('@')) {
    // Order emails have an index on lower(customer_email), `_ecommerce_orders_customer_email_idx`.
    conditions.push(eq(sql`lower(${ordersTable.customerEmail})`, values.query.toLowerCase()));
  } else if (values.query) {
    const reference = values.query.match(/^TAL-([0-9a-f]{12})$/i)?.[1];
    // References are display/search aids. If two IDs share a suffix, return both for staff to disambiguate.
    conditions.push(reference ? sql`lower(substr(${ordersTable.id}, -13)) = ${`-${reference.toLowerCase()}`}` : eq(ordersTable.id, values.query));
  }
  if (values.cursor) {
    // A row comparison, so the page continues through the index's (created_at, id) order.
    const [createdAt, id] = decodeCursor(values.view, values.cursor);
    conditions.push(view.ascending
      ? sql`(${ordersTable.createdAt}, ${ordersTable.id}) > (${createdAt}, ${id})`
      : sql`(${ordersTable.createdAt}, ${ordersTable.id}) < (${createdAt}, ${id})`);
  }
  const direction = view.ascending ? asc : desc;
  const db = commerceDb(env);
  const [[counted], found] = await db.batch([
    db.select({ count: count() }).from(ordersTable).where(VIEWS.awaiting.where),
    db.select(orderColumns).from(ordersTable).where(and(...conditions))
      .orderBy(direction(ordersTable.createdAt), direction(ordersTable.id)).limit(values.limit + 1),
  ]);
  const rows = found.slice(0, values.limit);
  // The items column is JSON; only items that name a product are described.
  const storedItems = rows.map((row) => Array.isArray(row.items) ? row.items.filter((item) => typeof item?.productId === 'string') : []);
  const described = await describeOrderItems(env, storedItems.flat());
  const shipments = await loadShipments(env, rows.map((row) => row.id));
  const { events } = await batchGroups(db, { events: chunked(rows.map(row => row.id)).map(ids =>
    db.query.fulfillments.findMany({ columns: { id: true, orderId: true, kind: true, note: true, adminActor: true, createdAt: true },
      where: { orderId: { in: ids }, kind: { in: ['reopen', 'complete'] } }, orderBy: (_row, { sql }) => sql`rowid` })) });
  const activity = await loadOrderActivity(env, rows.map(row => row.id));
  let offset = 0;
  const orders = rows.map((row, index) => {
    const items = described.slice(offset, offset += storedItems[index].length);
    const provider = row.paymentProvider ?? 'stripe';
    return {
      id: row.id,
      status: row.status,
      fulfillmentStatus: row.fulfillmentStatus,
      paymentProvider: provider,
      customerEmail: row.customerEmail,
      currency: row.currency,
      createdAt: row.createdAt.toISOString(),
      shippingAddress: row.shippingAddress ?? null,
      canShip: SHIPPABLE_STATUSES.includes(row.status) && row.fulfillmentStatus !== 'fulfilled' && provider !== 'admin_test',
      items: items.map((item) => ({
        productId: item.productId, variantId: item.variantId ?? null, quantity: item.quantity,
        unitAmount: item.priceAtPurchase, lineTotal: item.priceAtPurchase * item.quantity,
        productName: item.productName, variantLabel: item.variantLabel, sku: item.sku,
      })),
      activity: activity.get(row.id) ?? [],
      amounts: orderAmounts(row),
      shipments: shipments.get(row.id) ?? [],
      fulfillmentEvents: events.filter(event => event.orderId === row.id),
    };
  });
  return {
    view: values.view,
    pageSize: values.limit,
    awaitingCount: Number(counted?.count ?? 0),
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
 * Records a shipment of a paid real order that has not shipped in full. With `items`, quantities
 * complete the order automatically and `completesOrder` is ignored. Legacy callers without item
 * allocations retain their manual final-parcel flag. The database
 * trigger enforces the same rules. A later refund or dispute changes only the payment status.
 * The buyer is emailed a shipment notice with the carrier and tracking number; a failed send never
 * fails the shipment, and the scheduled job retries it.
 */
export async function fulfillCommerceOrder(env: TalismanEnv, actor: string, input: unknown) {
  const values = parseInput(shipmentSchema, input);
  if (!actor.trim()) throw new Error('Administrator identity is required');
  const db = commerceDb(env);
  // Old callers deduplicate an identical parcel. New clients provide a stable key per parcel,
  // allowing two intentionally identical parcels while a lost response safely repeats one.
  const requestKey = values.requestKey ?? `legacy_${await hashOrderAccess(JSON.stringify(values))}`;
  const id = `ful_${await hashOrderAccess(`${values.orderId}:${requestKey}`)}`;
  const replay = async () => {
    const previous = await db.select().from(fulfillments).where(eq(fulfillments.id, id)).get();
    if (!previous) return null;
    if (previous.kind !== 'shipment' || previous.note !== values.note || previous.carrier !== values.carrier ||
      previous.trackingNumber !== values.trackingNumber || previous.completesOrder !== (values.items ? false : values.completesOrder)) {
      throw new FulfillmentInputError('The shipment request key was already used with other details');
    }
    {
      const contents = await db.select().from(parcelContents).where(eq(parcelContents.fulfillmentId, id)).get();
      const expected = values.items ? await parcelContentsValue(values.orderId, id, values.items, actor, values.note, 'shipment') : null;
      if (!!contents !== !!expected || (contents && expected && contents.fingerprint !== expected.fingerprint)) throw new FulfillmentInputError('Shipment key already used with other contents');
    }
    const current = await db.select({ status: ordersTable.status, fulfillmentStatus: ordersTable.fulfillmentStatus })
      .from(ordersTable).where(eq(ordersTable.id, values.orderId)).get();
    return { fulfillmentId: previous.id, orderId: values.orderId, ...current, duplicate: true };
  };
  const previous = await replay(); if (previous) return previous;
  const order = await db.select({ status: ordersTable.status, fulfillmentStatus: ordersTable.fulfillmentStatus,
    paymentProvider: ordersTable.paymentProvider }).from(ordersTable).where(eq(ordersTable.id, values.orderId)).get();
  if (!order) throw new Error('Order not found');
  if ((order.paymentProvider ?? 'stripe') === 'admin_test') throw new Error('Admin test orders cannot be fulfilled');
  if (order.fulfillmentStatus === 'fulfilled') throw new Error('Order has already shipped in full');
  if (!SHIPPABLE_STATUSES.includes(order.status)) throw new Error(`A ${order.status.replaceAll('_', ' ')} order cannot ship`);
  const now = Math.floor(Date.now() / 1000);
  const contents = values.items ? await parcelContentsValue(values.orderId, id, values.items, actor, values.note, 'shipment') : null;
  if (contents && await db.select({ id: fulfillments.id }).from(fulfillments).where(sql`${fulfillments.orderId} = ${values.orderId} AND ${fulfillments.kind} = 'shipment' AND NOT EXISTS (SELECT 1 FROM _ecommerce_parcel_contents p WHERE p.fulfillment_id = _ecommerce_fulfillments.id)`).get()) {
    throw new FulfillmentInputError('Record the contents of earlier parcels before shipping more items.');
  }
  try {
    // The notice is recorded with the shipment, so a shipment is never recorded without it.
    await db.batch([
      db.insert(fulfillments).values({ id, requestKey, orderId: values.orderId, kind: 'shipment', completesOrder: contents ? false : values.completesOrder,
        adminActor: actor, carrier: values.carrier, trackingNumber: values.trackingNumber, note: values.note,
        createdAt: new Date(now * 1000) }),
      ...(contents ? [db.insert(parcelContents).values(contents)] : []),
      db.run(commerceEmailStatement('shipment', id, now)),
    ]);
  } catch (cause) {
    const previous = await replay(); if (previous) return previous;
    if (errorText(cause).includes('Parcel')) throw new Error('Parcel quantities exceed the order or earlier parcel contents are missing. Reload the order.');
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
  const db = commerceDb(env);
  // Every fulfillment of the shipment's order, in the order written, with the order's payment provider.
  const rows = await db.select({ id: fulfillments.id, orderId: fulfillments.orderId, kind: fulfillments.kind,
    correctsId: fulfillments.correctsId, carrier: fulfillments.carrier, trackingNumber: fulfillments.trackingNumber,
    paymentProvider: ordersTable.paymentProvider })
    .from(fulfillments).innerJoin(ordersTable, eq(ordersTable.id, fulfillments.orderId))
    .where(eq(fulfillments.orderId, db.select({ orderId: fulfillments.orderId }).from(fulfillments)
      .where(eq(fulfillments.id, values.fulfillmentId))))
    .orderBy(sql`${fulfillments}.rowid`);
  const shipment = rows.find((row) => row.id === values.fulfillmentId);
  if (!shipment || shipment.kind !== 'shipment') throw new Error('Shipment not found');
  if ((shipment.paymentProvider ?? 'stripe') === 'admin_test') throw new Error('Admin test orders cannot be fulfilled');
  const current = rows.filter((row) => row.correctsId === shipment.id).at(-1) ?? shipment;
  // A shipment row may hold an empty string where there is no value.
  if ((current.carrier || null) === values.carrier && (current.trackingNumber || null) === values.trackingNumber) {
    throw new Error('The correction changes nothing');
  }
  const id = `ful_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    await db.batch([
      db.insert(fulfillments).values({ id, orderId: shipment.orderId, kind: 'correction', correctsId: shipment.id,
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
  return { correctionId: id, fulfillmentId: shipment.id, orderId: shipment.orderId,
    carrier: values.carrier, trackingNumber: values.trackingNumber };
}

const progressSchema = z.object({ orderId: z.string().trim().min(1).max(128),
  action: z.enum(['reopen', 'complete']), reason: z.string().trim().min(8).max(500),
  requestKey: z.string().trim().min(8).max(128) }).strict();
/** Audited recovery of an early final parcel, or completion when remaining items were refunded. Ships nothing. */
export async function adjustCommerceFulfillment(env: TalismanEnv, actor: string, input: unknown) {
  const values = parseInput(progressSchema, input);
  if (!actor.trim()) throw new FulfillmentInputError('Administrator identity is required');
  const db = commerceDb(env);
  const id = `ful_${await hashOrderAccess(`${values.orderId}:${values.requestKey}`)}`;
  const replay = async () => {
    const row = await db.select().from(fulfillments).where(eq(fulfillments.id, id)).get();
    if (!row) return null;
    if (row.kind !== values.action || row.note !== values.reason) throw new FulfillmentInputError('Request key already used with other details');
    return { fulfillmentId: row.id, orderId: row.orderId, duplicate: true };
  };
  const previous = await replay(); if (previous) return previous;
  try {
    await db.insert(fulfillments).values({ id, orderId: values.orderId, requestKey: values.requestKey,
      kind: values.action, note: values.reason, adminActor: actor, completesOrder: false, createdAt: new Date() });
  } catch (cause) {
    const previous = await replay(); if (previous) return previous;
    throw refusal(cause, 'Fulfillment progress cannot be changed');
  }
  return { fulfillmentId: id, orderId: values.orderId, action: values.action };
}
