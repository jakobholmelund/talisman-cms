import { and, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb, type CommerceDb } from './db';
import { orderConfirmationEmail, shipmentEmail, type OrderConfirmationEmail } from './emails';
import { COMMERCE_EMAIL_LEASE_SECONDS, COMMERCE_EMAIL_MAX_AGE_SECONDS, applyEmailTemplate, bareEmailAddress,
  commerceEmailSetup, missingEmailSettings, runCommerceEmailDelivery, sendCommerceEmailNow, unclaimedAt, waitingEmailsResult,
  type CommerceEmailComposer, type CommerceEmailKind, type CommerceEmailResult } from './email-deliveries';
import { composeGiftCardClaimEmail } from './gift-cards';
import { describeOrderItems, orderAmountColumns, orderAmounts } from './order-items';
import { emailDeliveries, fulfillments, orders } from './schema';

/** A time in Unix seconds as the schema's timestamp columns take it. */
const at = (seconds: number) => new Date(seconds * 1000);
/** The items an order stores, those that name a product: the column is JSON. */
const storedItems = (items: typeof orders.$inferSelect['items']) =>
  Array.isArray(items) ? items.filter((item) => typeof item?.productId === 'string') : [];
/** The order a fulfillment belongs to, for reading the order's fulfillments together. */
const orderOfFulfillment = (db: CommerceDb, fulfillmentId: string) =>
  db.select({ orderId: fulfillments.orderId }).from(fulfillments).where(eq(fulfillments.id, fulfillmentId));

/** How the confirmation words the amounts that the admin queue labels for staff. Other keys keep their label. */
const BUYER_AMOUNT_LABELS: Record<string, string> = {
  charged: 'Amount charged',
  providerRefunded: 'Refunded to your payment method',
  giftCardRefunded: 'Refunded to your gift card',
};

/**
 * Payment statuses in which a confirmation is still sent; a refunded order gets none. A dispute does
 * not undo the sale, so a confirmation still waiting for its retry when one opens is sent.
 */
const CONFIRMABLE_STATUSES = ['paid', 'fulfilled', 'partially_refunded', 'disputed'];

/** The order confirmation: items with their current catalog names, the labelled amounts and the shipping address. */
const composeOrderConfirmation: CommerceEmailComposer = async (env, orderId, setup) => {
  const order = await commerceDb(env).select({ id: orders.id, status: orders.status, paymentProvider: orders.paymentProvider,
    customerEmail: orders.customerEmail, currency: orders.currency, items: orders.items, shippingAddress: orders.shippingAddress,
    ...orderAmountColumns, createdAt: orders.createdAt }).from(orders).where(eq(orders.id, orderId)).get();
  if (!order || (order.paymentProvider ?? 'stripe') === 'admin_test') return { cancel: 'not_found' };
  if (!CONFIRMABLE_STATUSES.includes(order.status)) return { cancel: 'not_due' };
  const to = bareEmailAddress(order.customerEmail);
  if (!to) return { fail: 'invalid_recipient' };
  const items = await describeOrderItems(env, storedItems(order.items));
  const email: OrderConfirmationEmail = {
    store: setup.store,
    order: {
      id: order.id,
      placedAt: order.createdAt,
      currency: order.currency,
      items: items.map((item) => ({
        productId: item.productId, variantId: item.variantId ?? null,
        name: `${item.productName ?? item.productId}${item.variantLabel ? ` (${item.variantLabel})` : ''}`,
        productName: item.productName, variantLabel: item.variantLabel, sku: item.sku, quantity: item.quantity,
        unitCents: item.priceAtPurchase, lineCents: item.priceAtPurchase * item.quantity,
      })),
      amounts: orderAmounts(order).map((amount) => ({ ...amount, label: BUYER_AMOUNT_LABELS[amount.key] ?? amount.label })),
      shippingAddress: order.shippingAddress ?? null,
    },
  };
  return { to, message: await applyEmailTemplate(setup, 'orderConfirmation', email, orderConfirmationEmail(email)) };
};

/**
 * The notice for a shipment, or, for `shipment_update`, for the shipment a correction restates. Either
 * carries the carrier and tracking number in force when it is sent, so a notice sent late already
 * shows a later correction.
 */
function shipmentComposer(update: boolean): CommerceEmailComposer {
  return async (env, fulfillmentId, setup) => {
    const db = commerceDb(env);
    // Fulfillment rows are only ever appended, so rowid is the order they were written in.
    const rows = await db.select({ id: fulfillments.id, orderId: fulfillments.orderId, kind: fulfillments.kind,
      correctsId: fulfillments.correctsId, completesOrder: fulfillments.completesOrder, carrier: fulfillments.carrier,
      trackingNumber: fulfillments.trackingNumber, createdAt: fulfillments.createdAt })
      .from(fulfillments).where(eq(fulfillments.orderId, orderOfFulfillment(db, fulfillmentId))).orderBy(sql`rowid`);
    const subject = rows.find((row) => row.id === fulfillmentId);
    const shipmentId = update ? subject?.correctsId : subject?.id;
    const index = rows.findIndex((row) => row.id === shipmentId && row.kind === 'shipment');
    if (index < 0) return { cancel: 'not_found' };
    const shipment = rows[index];
    const current = rows.filter((row) => row.correctsId === shipment.id).at(-1) ?? shipment;
    const order = await db.select({ id: orders.id, customerEmail: orders.customerEmail,
      paymentProvider: orders.paymentProvider, createdAt: orders.createdAt }).from(orders)
      .where(eq(orders.id, shipment.orderId)).get();
    if (!order || (order.paymentProvider ?? 'stripe') === 'admin_test') return { cancel: 'not_found' };
    const to = bareEmailAddress(order.customerEmail);
    if (!to) return { fail: 'invalid_recipient' };
    const email = {
      store: setup.store,
      order: { id: order.id, placedAt: order.createdAt },
      shipment: {
        id: shipment.id,
        shippedAt: shipment.createdAt,
        // A shipment row may hold an empty string where there is no value.
        carrier: current.carrier || null,
        trackingNumber: current.trackingNumber || null,
        completesOrder: shipment.completesOrder,
        earlierShipments: rows.slice(0, index).filter((row) => row.kind === 'shipment').length,
      },
      update,
    };
    return { to, message: await applyEmailTemplate(setup, 'shipment', email, shipmentEmail(email)) };
  };
}

const COMPOSERS: Record<CommerceEmailKind, CommerceEmailComposer> = {
  order_confirmation: composeOrderConfirmation,
  shipment: shipmentComposer(false),
  shipment_update: shipmentComposer(true),
  gift_card_claim: composeGiftCardClaimEmail,
};

/** Sends the email of this kind and subject now if it is due; see sendCommerceEmailNow. Never throws. */
export function deliverCommerceEmail(env: TalismanEnv, kind: CommerceEmailKind, subjectId: string) {
  return sendCommerceEmailNow(env, kind, subjectId, COMPOSERS[kind]);
}

/**
 * Retries the order confirmations, shipment notices and gift card claim emails that were not sent at
 * once, up to `limit` (default 10, at most 50) per run, oldest due first, and gives up emails that are
 * older than COMMERCE_EMAIL_MAX_AGE_SECONDS. reconcileCommerce runs it, so a site's scheduled Worker
 * retries them. Results carry `<kind>:<subject id>` and error codes, never an address; status 'error'
 * marks what needs an operator: email that is not configured (one result, id `commerce_emails`, for
 * each missing setting), a sender the provider refuses, an email given up after its last attempt or its
 * maximum age. 'email_retry' is retried later, and 'email_undeliverable' (a suppressed or invalid
 * address) and 'email_cancelled' are final.
 */
export async function deliverPendingCommerceEmails(options: { env: TalismanEnv }, { limit = 10, now: givenNow }: {
  limit?: number; now?: number;
} = {}) {
  const { env } = options;
  const count = Math.max(1, Math.min(50, Math.floor(limit)));
  const now = givenNow ?? Math.floor(Date.now() / 1000);
  const results: CommerceEmailResult[] = [];
  const db = commerceDb(env);
  // Stated as a literal, so both reads use the partial index `_ecommerce_email_deliveries_due_idx`.
  const pending = sql`${emailDeliveries.status} = 'pending'`;
  const oldest = db.select({ id: emailDeliveries.id }).from(emailDeliveries)
    .where(and(pending, lt(emailDeliveries.createdAt, at(now - COMMERCE_EMAIL_MAX_AGE_SECONDS)), unclaimedAt(now)))
    .orderBy(emailDeliveries.createdAt).limit(count);
  const expired = await db.update(emailDeliveries).set({ status: 'failed', lastError: 'expired', claimedAt: null })
    .where(inArray(emailDeliveries.id, oldest)).returning({ kind: emailDeliveries.kind, subjectId: emailDeliveries.subjectId });
  for (const row of expired) {
    results.push({ id: `${row.kind}:${row.subjectId}`, status: 'error', error: 'Email was not sent within 7 days and was given up' });
  }
  // Only the kinds this release sends, so rows a later release adds never crowd them out after a rollback.
  // The unary + keeps SQLite on the due index instead of the (kind, subject_id) index over every email.
  const due = (kinds: CommerceEmailKind[]) => db.select({ kind: emailDeliveries.kind, subjectId: emailDeliveries.subjectId })
    .from(emailDeliveries)
    .where(and(pending, lte(emailDeliveries.nextAttemptAt, at(now)), unclaimedAt(now), sql`+${emailDeliveries.kind} IN ${kinds}`))
    .orderBy(emailDeliveries.nextAttemptAt, emailDeliveries.createdAt, sql`${emailDeliveries.kind} <> 'order_confirmation'`, emailDeliveries.id)
    .limit(count);
  const setup = await commerceEmailSetup(env);
  // Kinds that wait for a setting are read apart and reported once for each missing setting, so emails
  // that wait never keep the others from their retries.
  const kinds = Object.keys(COMPOSERS) as CommerceEmailKind[];
  const sendable: CommerceEmailKind[] = [];
  const waiting = new Map<string, { kinds: CommerceEmailKind[]; missing: string[] }>();
  for (const kind of kinds) {
    const missing = missingEmailSettings(setup, kind);
    if (!missing.length) sendable.push(kind);
    else waiting.set(missing.join(', '), { kinds: [...(waiting.get(missing.join(', '))?.kinds ?? []), kind], missing });
  }
  for (const group of waiting.values()) {
    const found = (await due(group.kinds)).length;
    if (found) results.push(waitingEmailsResult(group.kinds.length === kinds.length ? 'all' : group.kinds, group.missing, found, count));
  }
  if (!sendable.length) return results;
  for (const row of await due(sendable)) {
    const result = await runCommerceEmailDelivery(env, row.kind, row.subjectId, COMPOSERS[row.kind], { setup, now });
    if (result) results.push(result);
  }
  return results;
}
