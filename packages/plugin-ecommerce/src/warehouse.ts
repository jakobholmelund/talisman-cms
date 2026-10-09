import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb, errorText } from './db';
import { adminActorNames } from './admin-actors';
import { hashOrderAccess } from './cookies';
import { describeOrderItems } from './order-items';
import { STOCK_COLUMNS } from './inventory';
import { CommerceOperationsConflict } from './email-recovery';
import { orders, fulfillments, parcelContents, returnReceipts, returnStock, stockMovements } from './schema';

const id = z.string().trim().min(1).max(128);
const reason = z.string().trim().min(8).max(500);
const quantity = z.number().int().min(1).max(1000000);
export const parcelItemsSchema = z.array(z.object({ lineIndex: z.number().int().min(0).max(199), quantity }).strict()).min(1).max(200)
  .refine(items => new Set(items.map(item => item.lineIndex)).size === items.length, 'Choose each order line once');
const contentsSchema = z.object({ orderId: id, fulfillmentId: id, items: parcelItemsSchema, reason, requestKey: id.min(8) }).strict();
const intakeSchema = z.object({ orderId: id, reason, requestKey: id.min(8), items: z.array(z.object({
  lineIndex: z.number().int().min(0).max(199), quantity, condition: z.enum(['sellable', 'damaged', 'inspection']), restock: z.boolean(),
}).strict().refine(item => !item.restock || item.condition === 'sellable', 'Only sellable goods can be restocked')).min(1).max(200)
  .refine(items => new Set(items.map(item => item.lineIndex)).size === items.length, 'Choose each order line once') }).strict();
const actorRequired = (actor: string) => { if (!actor.trim()) throw new CommerceOperationsConflict('Staff identity is required'); };
export async function warehouseFingerprint(input: unknown, actor: string) { return hashOrderAccess(JSON.stringify({ input, actor })); }
export async function parcelContentsValue(orderId: string, fulfillmentId: string, items: z.output<typeof parcelItemsSchema>, actor: string, note: string, source: 'shipment' | 'backfill' = 'backfill') {
  const sorted = [...items].sort((a, b) => a.lineIndex - b.lineIndex);
  return { id: `pcl_${fulfillmentId}`, orderId, fulfillmentId, items: sorted, source, actor, reason: note,
    fingerprint: await warehouseFingerprint({ orderId, fulfillmentId, items: sorted, reason: note, source }, actor), createdAt: new Date() };
}
/** Backfill a historical parcel explicitly; never infer its contents from the whole order. */
export async function recordParcelContents(env: TalismanEnv, input: unknown, actor: string) {
  const values = contentsSchema.parse(input); actorRequired(actor);
  const record = await parcelContentsValue(values.orderId, values.fulfillmentId, values.items, actor, values.reason);
  const db = commerceDb(env);
  const replay = async () => {
    const previous = await db.select().from(parcelContents).where(eq(parcelContents.fulfillmentId, values.fulfillmentId)).get();
    if (!previous) return null;
    if (previous.fingerprint !== record.fingerprint) throw new CommerceOperationsConflict('Contents already recorded with other details. Reload the order.');
    return { parcelId: previous.id, orderId: previous.orderId, duplicate: true };
  };
  const previous = await replay(); if (previous) return previous;
  try { await db.insert(parcelContents).values(record); }
  catch (cause) { const previous = await replay(); if (previous) return previous; throw new CommerceOperationsConflict(errorText(cause).includes('Parcel') ? 'Parcel quantities exceed this order or the shipment is unavailable. Reload the order.' : 'Contents could not be recorded. Reload the order.'); }
  return { parcelId: record.id, orderId: record.orderId };
}

/** Inventory receipt and financial refunds are independent. Stock comes from checkout snapshots,
 * never today's component recipe, and an atomic cap also covers the legacy whole-hold restock. */
export async function receiveOrderReturn(env: TalismanEnv, input: unknown, actor: string) {
  const parsed = intakeSchema.parse(input); actorRequired(actor);
  const values = { ...parsed, items: [...parsed.items].sort((a, b) => a.lineIndex - b.lineIndex) };
  const db = commerceDb(env), receiptId = `ret_${await hashOrderAccess(`${values.orderId}:${values.requestKey}`)}`;
  const fingerprint = await warehouseFingerprint(values, actor);
  const replay = async () => {
    const previous = await db.query.returnReceipts.findFirst({ where: { id: receiptId }, with: { stock: true } });
    if (!previous) return null;
    if (previous.fingerprint !== fingerprint) throw new CommerceOperationsConflict('This return key was used with other details.');
    return { receiptId, orderId: previous.orderId, restocked: previous.stock, duplicate: true };
  };
  const previous = await replay(); if (previous) return previous;
  const order = await db.query.orders.findFirst({ where: { id: values.orderId }, with: { inventoryReservations: true, componentReservations: true } });
  if (!order || order.paymentProvider === 'admin_test' || !['paid', 'partially_refunded', 'refunded', 'disputed'].includes(order.status)) {
    throw new CommerceOperationsConflict('Only confirmed real purchases can receive returns.');
  }
  const demand = new Map<string, { type: keyof typeof STOCK_COLUMNS; target: string; quantity: number }>();
  for (const item of values.items) {
    const line = order.items[item.lineIndex];
    if (!line) throw new CommerceOperationsConflict('The order line is unavailable. Reload the order.');
    if (!item.restock) continue;
    if (!Array.isArray(line.stockTargets)) throw new CommerceOperationsConflict('This older order has no checkout stock mapping. Receive it without restocking, then reconcile its stock explicitly.');
    if (!line.stockTargets.length) throw new CommerceOperationsConflict('This item has no stock to restore. Receive it without restocking.');
    for (const target of line.stockTargets) {
      const key = `${target.type}:${target.id}`, current = demand.get(key);
      demand.set(key, { type: target.type, target: target.id, quantity: (current?.quantity ?? 0) + item.quantity * target.units });
    }
  }
  const restocked = [...demand.values()].map(target => {
    const reservation = target.type === 'component' ? order.componentReservations.find(r => r.componentId === target.target)
      : order.inventoryReservations.find(r => r.targetType === target.type && r.targetId === target.target);
    if (!reservation || reservation.releasedAt) throw new CommerceOperationsConflict('These units have already been restored or their stock hold is unavailable. Receive without restocking and reconcile the stock.');
    return { id: `${receiptId}_${reservation.id}`, receiptId, orderId: values.orderId,
      reservationType: target.type === 'component' ? 'component' as const : 'inventory' as const,
      reservationId: reservation.id, targetType: target.type, targetId: target.target, quantity: target.quantity };
  });
  try {
    await db.batch([
      db.insert(returnReceipts).values({ id: receiptId, orderId: values.orderId, items: values.items, actor, reason: values.reason, fingerprint, createdAt: new Date() }),
      ...restocked.map(row => db.insert(returnStock).values(row)),
    ]);
  } catch (cause) {
    const previous = await replay(); if (previous) return previous;
    throw new CommerceOperationsConflict(errorText(cause).includes('Return') ? 'Return quantities exceed the goods or stock still available to return. Reload the order.' : 'Return could not be recorded. Reload the order.');
  }
  return { receiptId, orderId: values.orderId, restocked };
}

/** One order's quantities, immutable parcel contents and intake history, without catalog recipe reads. */
export async function readOrderWarehouse(env: TalismanEnv, input: unknown) {
  const { orderId } = z.object({ orderId: id }).strict().parse(input), db = commerceDb(env);
  const order = await db.query.orders.findFirst({ where: { id: orderId }, with: { parcelContents: true, returnReceipts: { with: { stock: true } }, fulfillments: true } });
  if (!order || order.paymentProvider === 'admin_test') throw new CommerceOperationsConflict('Order not found');
  const described = await describeOrderItems(env, order.items);
  const unrecorded = order.fulfillments.filter(row => row.kind === 'shipment' && !order.parcelContents.some(p => p.fulfillmentId === row.id));
  const lines = described.map((line, lineIndex) => {
    const shipped = order.parcelContents.reduce((n, parcel) => n + (parcel.items.find(i => i.lineIndex === lineIndex)?.quantity ?? 0), 0);
    const received = order.returnReceipts.reduce((n, receipt) => n + (receipt.items.find(i => i.lineIndex === lineIndex)?.quantity ?? 0), 0);
    return { lineIndex, quantity: line.quantity, name: [line.productName || line.productId, line.variantLabel].filter(Boolean).join(' / '), sku: line.sku,
      shipped, received, remaining: unrecorded.length ? null : Math.max(0, line.quantity - shipped),
      returnable: Math.max(0, (unrecorded.length ? line.quantity : shipped) - received),
      restockMapped: Array.isArray(order.items[lineIndex].stockTargets) && !!order.items[lineIndex].stockTargets?.length };
  });
  const names = await adminActorNames(env, [...order.parcelContents.map(p => p.actor), ...order.returnReceipts.map(r => r.actor)]);
  return { orderId, status: order.status, fulfillmentStatus: order.fulfillmentStatus, lines, unrecorded: unrecorded.map(p => ({ id: p.id, createdAt: p.createdAt.toISOString(), note: p.note })),
    parcels: order.parcelContents.map(p => ({ ...p, actorName: names.get(p.actor) ?? p.actor, createdAt: p.createdAt.toISOString() })),
    returns: order.returnReceipts.map(r => ({ ...r, actorName: names.get(r.actor) ?? r.actor, createdAt: r.createdAt.toISOString() })),
    shippingAddress: order.shippingAddress, canReceive: ['paid', 'partially_refunded', 'refunded', 'disputed'].includes(order.status) };
}

const movementSchema = z.object({ requestKey: id.min(8), targetType: z.enum(['product', 'variant', 'stock', 'component']), targetId: id,
  kind: z.enum(['receipt', 'correction']), delta: z.number().int().min(-1000000).max(1000000).refine(n => n !== 0),
  expectedQuantity: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), expectedUpdatedAt: z.string().datetime(), reason,
}).strict().refine(v => v.kind !== 'receipt' || v.delta > 0, 'Incoming stock must be positive');
export async function recordStockMovement(env: TalismanEnv, input: unknown, actor: string) {
  const values = movementSchema.parse(input); actorRequired(actor);
  if (!Number.isSafeInteger(values.expectedQuantity + values.delta) || values.expectedQuantity + values.delta < 0) throw new CommerceOperationsConflict('The change would leave a negative or invalid stock count.');
  const db = commerceDb(env), movementId = `mov_${await hashOrderAccess(values.requestKey)}`, fingerprint = await warehouseFingerprint(values, actor);
  const replay = async () => {
    const previous = await db.select().from(stockMovements).where(eq(stockMovements.id, movementId)).get();
    if (!previous) return null;
    if (previous.fingerprint !== fingerprint) throw new CommerceOperationsConflict('This stock request key was used with other details.');
    return { movementId, before: previous.beforeQuantity, after: previous.afterQuantity, duplicate: true };
  };
  const previous = await replay(); if (previous) return previous;
  try {
    // The trigger checks the loaded quantity/version and applies the delta in this same transaction.
    await db.insert(stockMovements).values({ id: movementId, targetType: values.targetType, targetId: values.targetId, kind: values.kind,
      delta: values.delta, beforeQuantity: values.expectedQuantity, afterQuantity: values.expectedQuantity + values.delta,
      expectedUpdatedAt: new Date(values.expectedUpdatedAt), actor, reason: values.reason, fingerprint, createdAt: new Date() });
  } catch { const previous = await replay(); if (previous) return previous; throw new CommerceOperationsConflict('Stock changed or the stock record is unavailable. Reload before recording this change.'); }
  return { movementId, before: values.expectedQuantity, after: values.expectedQuantity + values.delta };
}

const locations = sql`WITH locations AS (
 SELECT 'product' AS type, id, name, sku, inventory_quantity AS quantity, updated_at AS updated FROM _ecommerce_products WHERE type = 'standard'
 UNION ALL SELECT 'variant', g.id, p.name || ' / ' || g.name, g.sku, g.inventory_quantity, g.updated_at FROM _ecommerce_product_variants g JOIN _ecommerce_products p ON p.id = g.product_id WHERE p.type = 'standard'
 UNION ALL SELECT 'stock', s.id, p.name || ' / ' || g.name || ' / ' || v.value, v.sku, s.quantity, s.updated_at FROM _ecommerce_stocks s JOIN _ecommerce_product_variant_values v ON v.id = s.product_variant_value_id JOIN _ecommerce_product_variants g ON g.id = v.product_variant_id JOIN _ecommerce_products p ON p.id = g.product_id
 UNION ALL SELECT 'component', id, name, sku, quantity, updated_at FROM _ecommerce_components
)`;
export async function listStockLocations(env: TalismanEnv, input: unknown = {}) {
  const v = z.object({ search: z.string().trim().max(100).default(''), offset: z.coerce.number().int().min(0).max(1000000).default(0) }).strict().parse(input);
  const pattern = `%${v.search.replace(/[\\%_]/g, c => `\\${c}`)}%`, db = commerceDb(env);
  const where = sql`(name LIKE ${pattern} ESCAPE '\\' OR COALESCE(sku, '') LIKE ${pattern} ESCAPE '\\')`;
  const [rows, total] = await db.batch([
    db.all<{ type: keyof typeof STOCK_COLUMNS; id: string; name: string; sku: string | null; quantity: number; updated: number }>(sql`${locations} SELECT * FROM locations WHERE ${where} ORDER BY name, type, id LIMIT 50 OFFSET ${v.offset}`),
    db.all<{ n: number }>(sql`${locations} SELECT count(*) n FROM locations WHERE ${where}`),
  ]);
  return { ...v, total: total[0]?.n ?? 0, rows: rows.map(row => ({ ...row, updatedAt: new Date(row.updated * 1000).toISOString() })) };
}
export async function readStockHistory(env: TalismanEnv, input: unknown) {
  const v = z.object({ targetType: z.enum(['product','variant','stock','component']), targetId: id, offset: z.coerce.number().int().min(0).max(1000000).default(0) }).strict().parse(input);
  const db = commerceDb(env);
  // Reservation events are already durable records. Native catalog edits predate this receipt tool;
  // history labels its sources rather than manufacturing before/after counts for them.
  // Worker's SQLite limits each compound SELECT to five terms. Keep checkout event unions
  // separate, then combine five indexed sources for one globally ordered, paginated snapshot.
  const history = sql`WITH inventory_events AS (
    SELECT r.id, 'checkout_hold' AS kind, -r.quantity AS delta, NULL AS beforeQuantity, NULL AS afterQuantity, NULL AS actor, 'Checkout stock reservation' AS reason, o.created_at AS createdAt, r.order_id AS orderId FROM _ecommerce_inventory_reservations r JOIN _ecommerce_orders o ON o.id = r.order_id WHERE r.target_type = ${v.targetType} AND r.target_id = ${v.targetId}
    UNION ALL SELECT id || '_release', 'checkout_release', quantity, NULL, NULL, NULL, 'Cancelled checkout stock release', released_at, order_id FROM _ecommerce_inventory_reservations r WHERE target_type = ${v.targetType} AND target_id = ${v.targetId} AND released_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM _ecommerce_restocks s WHERE s.reservation_type = 'inventory' AND s.reservation_id = r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_stock s WHERE s.reservation_type = 'inventory' AND s.reservation_id = r.id)
  ), component_events AS (
    SELECT r.id, 'checkout_hold' AS kind, -r.quantity AS delta, NULL AS beforeQuantity, NULL AS afterQuantity, NULL AS actor, 'Checkout component reservation' AS reason, o.created_at AS createdAt, r.order_id AS orderId FROM _ecommerce_component_reservations r JOIN _ecommerce_orders o ON o.id = r.order_id WHERE ${v.targetType} = 'component' AND r.component_id = ${v.targetId}
    UNION ALL SELECT id || '_release', 'checkout_release', quantity, NULL, NULL, NULL, 'Cancelled checkout component release', released_at, order_id FROM _ecommerce_component_reservations r WHERE ${v.targetType} = 'component' AND component_id = ${v.targetId} AND released_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM _ecommerce_restocks s WHERE s.reservation_type = 'component' AND s.reservation_id = r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_stock s WHERE s.reservation_type = 'component' AND s.reservation_id = r.id)
  ), history AS (
    SELECT id, kind, delta, before_quantity AS beforeQuantity, after_quantity AS afterQuantity, actor, reason, created_at AS createdAt, NULL AS orderId
      FROM _ecommerce_stock_movements WHERE target_type = ${v.targetType} AND target_id = ${v.targetId}
    UNION ALL SELECT s.id, 'return', s.quantity, NULL, NULL, r.actor, r.reason, r.created_at, s.order_id FROM _ecommerce_return_stock s JOIN _ecommerce_return_receipts r ON r.id = s.receipt_id WHERE s.target_type = ${v.targetType} AND s.target_id = ${v.targetId}
    UNION ALL SELECT id, 'restock', quantity, NULL, NULL, admin_actor, reason, created_at, order_id FROM _ecommerce_restocks WHERE target_type = ${v.targetType} AND target_id = ${v.targetId}
    UNION ALL SELECT * FROM inventory_events
    UNION ALL SELECT * FROM component_events
  )`;
  const [rows, total] = await db.batch([
    db.all<{ id: string; kind: string; delta: number; beforeQuantity: number | null; afterQuantity: number | null; actor: string | null; reason: string; createdAt: number; orderId: string | null }>(sql`${history} SELECT * FROM history ORDER BY createdAt DESC, id DESC LIMIT 50 OFFSET ${v.offset}`),
    db.all<{ n: number }>(sql`${history} SELECT count(*) n FROM history`),
  ]);
  const names = await adminActorNames(env, rows.flatMap(row => row.actor ? [row.actor] : []));
  return { ...v, total: total[0]?.n ?? 0, rows: rows.map(row => ({ ...row, actorName: row.actor ? names.get(row.actor) ?? row.actor : null, createdAt: new Date(row.createdAt * 1000).toISOString() })) };
}
