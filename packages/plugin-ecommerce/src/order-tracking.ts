import type { CommerceContext } from './commerce-context';
import { findOrderForSession } from './orders';
import { describeOrderItems } from './order-items';

/** The same owner/guest credentials as order status, with a deliberately shopper-only projection. */
export async function readOrderTracking(ctx: CommerceContext, orderId: string, sessionToken?: string, customerId?: string, orderAccessToken?: string) {
  const authorized = await findOrderForSession(ctx, orderId, sessionToken, customerId, orderAccessToken);
  if (!authorized || authorized.paymentProvider === 'admin_test') return null;
  const order = await ctx.db.query.orders.findFirst({ where: { id: orderId }, columns: { id: true, items: true }, with: {
    fulfillments: { columns: { id: true, kind: true, correctsId: true, carrier: true, trackingNumber: true, createdAt: true }, orderBy: (_t, { sql }) => sql`rowid`, with: { contents: { columns: { items: true } } } },
    returnReceipts: { columns: { id: true, items: true, createdAt: true }, with: { inspections: { columns: { items: true } } } },
  } });
  if (!order) return null;
  const descriptions = await describeOrderItems(ctx.env, order.items);
  const label = (lineIndex: number) => {
    const line = descriptions[lineIndex];
    return { lineIndex, name: [line?.productName || 'Ordered item', line?.variantLabel].filter(Boolean).join(' / '), sku: line?.sku ?? null };
  };
  const parcels = order.fulfillments.filter(f => f.kind === 'shipment').map(f => {
    const correction = order.fulfillments.filter(c => c.kind === 'correction' && c.correctsId === f.id).at(-1);
    return { id: f.id, shippedAt: f.createdAt.toISOString(), carrier: correction ? correction.carrier : f.carrier,
      trackingNumber: correction ? correction.trackingNumber : f.trackingNumber,
      items: f.contents ? f.contents.items.map(i => ({ ...label(i.lineIndex), quantity: i.quantity })) : null };
  });
  const unknown = parcels.some(p => p.items === null);
  const received = (lineIndex: number) => order.returnReceipts.reduce((n, r) => n + (r.items.find(i => i.lineIndex === lineIndex)?.quantity ?? 0), 0);
  const returns = order.returnReceipts.map(r => ({ receivedAt: r.createdAt.toISOString(), items: r.items.map(i => {
    const reviewed = i.condition === 'inspection' ? r.inspections.reduce((n, d) => n + (d.items.find(j => j.lineIndex === i.lineIndex)?.quantity ?? 0), 0) : i.quantity;
    return { ...label(i.lineIndex), quantity: i.quantity, awaitingInspection: Math.max(0, i.quantity - reviewed) };
  }) }));
  return { orderId, lines: descriptions.map((line, lineIndex) => {
    const shipped = parcels.reduce((n, p) => n + (p.items?.find(i => i.lineIndex === lineIndex)?.quantity ?? 0), 0);
    return { ...label(lineIndex), ordered: line.quantity, shipped, remaining: unknown ? null : Math.max(0, line.quantity - shipped), received: received(lineIndex) };
  }), parcels, returns };
}
export type CustomerOrderTracking = NonNullable<Awaited<ReturnType<typeof readOrderTracking>>>;
