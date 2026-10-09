import { and, eq, inArray } from 'drizzle-orm';
import type { TalismanEnv } from 'talisman-cms/client';
import { batchGroups, chunked, commerceDb } from './db';
import { adminActorNames } from './admin-actors';
import { creditLedger, emailDeliveries, fulfillments, giftCardLedger, restocks } from './schema';

/** Read recorded operational events, without inferring refunds from the order's payment status. */
export async function loadOrderActivity(env: TalismanEnv, orderIds: string[]) {
  const db = commerceDb(env);
  const groups = chunked(orderIds);
  const { stock, gift, credit, parcels, confirmations } = await batchGroups(db, {
    stock: groups.map(ids => db.select().from(restocks).where(inArray(restocks.orderId, ids))),
    gift: groups.map(ids => db.select().from(giftCardLedger).where(and(inArray(giftCardLedger.orderId, ids), eq(giftCardLedger.kind, 'refund_restore')))),
    credit: groups.map(ids => db.select().from(creditLedger).where(and(inArray(creditLedger.orderId, ids), eq(creditLedger.kind, 'purchase_credit_refund')))),
    parcels: groups.map(ids => db.select().from(fulfillments).where(inArray(fulfillments.orderId, ids))),
    confirmations: groups.map(ids => db.select().from(emailDeliveries).where(and(inArray(emailDeliveries.subjectId, ids), eq(emailDeliveries.kind, 'order_confirmation')))),
  });
  const { notices } = await batchGroups(db, { notices: chunked(parcels.map(row => row.id)).map(ids =>
    db.select().from(emailDeliveries).where(and(inArray(emailDeliveries.subjectId, ids), inArray(emailDeliveries.kind, ['shipment', 'shipment_update'])))) });
  const names = await adminActorNames(env, [...stock, ...parcels].map(row => row.adminActor));
  const parcelOrders = new Map(parcels.map(row => [row.id, row.orderId]));
  type Event = { id: string; kind: string; createdAt: string; detail: string; actor: string | null; actorName: string | null;
    amountCents: number | null; email: { status: string; attempts: number; lastError: string | null; sentAt: string | null; nextAttemptAt: string | null } | null };
  const activity = new Map<string, Event[]>();
  function add(orderId: string, event: Event) { activity.set(orderId, [...activity.get(orderId) ?? [], event]); }
  const base = (id: string, kind: string, createdAt: Date, detail: string): Event => ({ id, kind, createdAt: createdAt.toISOString(), detail,
    actor: null, actorName: null, amountCents: null, email: null });
  for (const row of stock) add(row.orderId, { ...base(row.id, 'restock', row.createdAt,
    `${row.quantity} × ${row.targetType} ${row.targetId}: ${row.reason}`), actor: row.adminActor, actorName: names.get(row.adminActor) ?? row.adminActor });
  for (const row of parcels) add(row.orderId, { ...base(row.id, row.kind, row.createdAt,
    [row.note, row.carrier, row.trackingNumber].filter(Boolean).join(' · ')), actor: row.adminActor, actorName: names.get(row.adminActor) ?? row.adminActor });
  for (const row of gift) if (row.orderId) add(row.orderId, { ...base(row.id, 'gift_card_refund', row.createdAt, `Returned to gift card ${row.cardId}`), amountCents: row.amountCents });
  for (const row of credit) add(row.orderId, { ...base(row.id, 'store_credit_refund', row.createdAt, 'Returned to shopper store credit'), amountCents: row.amountCents });
  for (const row of [...confirmations, ...notices]) {
    const orderId = row.kind === 'order_confirmation' ? row.subjectId : parcelOrders.get(row.subjectId);
    if (orderId) add(orderId, { ...base(row.id, 'email', row.createdAt, row.kind.replaceAll('_', ' ')),
      email: { status: row.status, attempts: row.attempts, lastError: row.lastError, sentAt: row.sentAt?.toISOString() ?? null,
        nextAttemptAt: row.status === 'pending' ? row.nextAttemptAt.toISOString() : null } });
  }
  for (const events of activity.values()) events.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return activity;
}
