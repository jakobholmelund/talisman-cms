import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb } from './db';
import { findCustomerSession } from './accounts';
import { orders } from './schema';
import { readStoreCurrency } from './store-settings';
import { describeOrderItems } from './order-items';
import { orderReference } from './order-reference';

/** A bounded, owner-only projection. Never return addresses, staff notes or provider identifiers. */
export async function readCustomerHub(env: TalismanEnv, sessionToken?: string | null, requestedPage = 1) {
  const account = await findCustomerSession(env, sessionToken);
  if (!account) return null;
  const db = commerceDb(env);
  const owned = and(eq(orders.userId, account.id), sql`COALESCE(${orders.paymentProvider}, 'stripe') <> 'admin_test'`);
  const totals = await db.select({ count: count() }).from(orders).where(owned).get();
  const total = totals?.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / 12));
  const page = Math.min(pages, Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
  const rows = await db.select({ id: orders.id, status: orders.status, fulfillmentStatus: orders.fulfillmentStatus,
    createdAt: orders.createdAt, currency: orders.currency, items: orders.items,
    totalAmount: orders.totalAmount, giftCardApplied: orders.giftCardApplied, creditApplied: orders.creditApplied,
    providerRefundedCents: orders.providerRefundedCents, giftCardRefundedCents: orders.giftCardRefundedCents,
    paymentUnderReview: sql<boolean>`(${orders.status} = 'pending' AND ${orders.reconcileReviewAt} IS NOT NULL)`.mapWith(Boolean),
    openReturns: sql<number>`(SELECT count(*) FROM _ecommerce_return_requests r WHERE r.order_id = ${orders.id} AND r.redacted_at IS NULL
      AND COALESCE((SELECT e.status FROM _ecommerce_return_request_events e WHERE e.request_id = r.id ORDER BY e.rowid DESC LIMIT 1), 'pending') IN ('pending', 'approved'))`.mapWith(Number),
  }).from(orders).where(owned).orderBy(desc(orders.createdAt), desc(orders.id)).limit(12).offset((page - 1) * 12);
  const descriptions = await describeOrderItems(env, rows.flatMap(order => order.items));
  let offset = 0;
  return { account: { email: account.email, name: account.name, creditBalance: account.creditBalance, currency: readStoreCurrency(env) },
    total, page, pages, orders: rows.map(order => {
      const items = descriptions.slice(offset, offset += order.items.length).map(item => ({
        productId: item.productId, variantId: item.variantId ?? null, quantity: item.quantity,
        productName: item.productName, variantLabel: item.variantLabel, sku: item.sku,
      }));
      return { ...order, items, reference: orderReference(order.id), orderTotal: order.totalAmount + order.giftCardApplied + order.creditApplied };
    }) };
}
