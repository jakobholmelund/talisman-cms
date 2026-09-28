import { eq } from 'drizzle-orm';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb } from './db';
import { orderConfirmationEmail, shipmentEmail, type OrderConfirmationEmail, type OrderEmailAddress } from './emails';
import { COMMERCE_EMAIL_LEASE_SECONDS, COMMERCE_EMAIL_MAX_AGE_SECONDS, applyEmailTemplate, bareEmailAddress,
  commerceEmailSetup, missingEmailSettings, runCommerceEmailDelivery, sendCommerceEmailNow, waitingEmailsResult,
  type CommerceEmailComposer, type CommerceEmailKind, type CommerceEmailResult } from './email-deliveries';
import { composeGiftCardClaimEmail } from './gift-cards';
import { ORDER_AMOUNT_COLUMNS, describeOrderItems, orderAmounts, type OrderAmountsRow } from './order-items';
import { orders } from './schema';

type OrderRow = OrderAmountsRow & {
  id: string; status: string; payment_provider: string | null; customer_email: string | null; currency: string;
  items: string; shipping_address: string | null; created_at: number;
};
type StoredItem = { productId: string; variantId?: string | null; quantity: number; priceAtPurchase: number };
type FulfillmentRow = { id: string; order_id: string; kind: 'shipment' | 'correction'; corrects_id: string | null;
  completes_order: number; carrier: string | null; tracking_number: string | null; created_at: number };

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

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** The order confirmation: items with their current catalog names, the labelled amounts and the shipping address. */
const composeOrderConfirmation: CommerceEmailComposer = async (env, orderId, setup) => {
  // Raw SQL: reads the column list orderAmounts shares with the orders queue, whose query stays raw.
  const order = await env.DB.prepare(`SELECT id, status, payment_provider, customer_email, currency, items,
      shipping_address, ${ORDER_AMOUNT_COLUMNS}, created_at
    FROM _ecommerce_orders WHERE id = ?`).bind(orderId).first<OrderRow>();
  if (!order || (order.payment_provider ?? 'stripe') === 'admin_test') return { cancel: 'not_found' };
  if (!CONFIRMABLE_STATUSES.includes(order.status)) return { cancel: 'not_due' };
  const to = bareEmailAddress(order.customer_email);
  if (!to) return { fail: 'invalid_recipient' };
  const stored = parseJson<StoredItem[]>(order.items, []);
  const items = await describeOrderItems(env, Array.isArray(stored) ? stored.filter((item) => typeof item?.productId === 'string') : []);
  const email: OrderConfirmationEmail = {
    store: setup.store,
    order: {
      id: order.id,
      placedAt: new Date(order.created_at * 1000),
      currency: order.currency,
      items: items.map((item) => ({
        productId: item.productId, variantId: item.variantId ?? null,
        name: `${item.productName ?? item.productId}${item.variantLabel ? ` (${item.variantLabel})` : ''}`,
        productName: item.productName, variantLabel: item.variantLabel, sku: item.sku, quantity: item.quantity,
        unitCents: item.priceAtPurchase, lineCents: item.priceAtPurchase * item.quantity,
      })),
      amounts: orderAmounts(order).map((amount) => ({ ...amount, label: BUYER_AMOUNT_LABELS[amount.key] ?? amount.label })),
      shippingAddress: parseJson<OrderEmailAddress | null>(order.shipping_address, null),
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
    const { results } = await env.DB.prepare(`SELECT id, order_id, kind, corrects_id, completes_order, carrier,
        tracking_number, created_at
      FROM _ecommerce_fulfillments WHERE order_id = (SELECT order_id FROM _ecommerce_fulfillments WHERE id = ?)
      ORDER BY rowid`).bind(fulfillmentId).all<FulfillmentRow>();
    const rows = results ?? [];
    const subject = rows.find((row) => row.id === fulfillmentId);
    const shipmentId = update ? subject?.corrects_id : subject?.id;
    const index = rows.findIndex((row) => row.id === shipmentId && row.kind === 'shipment');
    if (index < 0) return { cancel: 'not_found' };
    const shipment = rows[index];
    const current = rows.filter((row) => row.corrects_id === shipment.id).at(-1) ?? shipment;
    const order = await commerceDb(env).select({ id: orders.id, customerEmail: orders.customerEmail,
      paymentProvider: orders.paymentProvider, createdAt: orders.createdAt }).from(orders)
      .where(eq(orders.id, shipment.order_id)).get();
    if (!order || (order.paymentProvider ?? 'stripe') === 'admin_test') return { cancel: 'not_found' };
    const to = bareEmailAddress(order.customerEmail);
    if (!to) return { fail: 'invalid_recipient' };
    const email = {
      store: setup.store,
      order: { id: order.id, placedAt: order.createdAt },
      shipment: {
        id: shipment.id,
        shippedAt: new Date(shipment.created_at * 1000),
        // A shipment row may hold an empty string where there is no value.
        carrier: current.carrier || null,
        trackingNumber: current.tracking_number || null,
        completesOrder: shipment.completes_order === 1,
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
export async function deliverPendingCommerceEmails(options: { env: TalismanEnv }, { limit = 10, now: at }: {
  limit?: number; now?: number;
} = {}) {
  const { env } = options;
  const count = Math.max(1, Math.min(50, Math.floor(limit)));
  const now = at ?? Math.floor(Date.now() / 1000);
  const results: CommerceEmailResult[] = [];
  const expired = await env.DB.prepare(`UPDATE _ecommerce_email_deliveries
    SET status = 'failed', last_error = 'expired', claimed_at = NULL
    WHERE id IN (SELECT id FROM _ecommerce_email_deliveries
      WHERE status = 'pending' AND created_at < ? AND (claimed_at IS NULL OR claimed_at <= ?)
      ORDER BY created_at LIMIT ?)
    RETURNING kind, subject_id`)
    .bind(now - COMMERCE_EMAIL_MAX_AGE_SECONDS, now - COMMERCE_EMAIL_LEASE_SECONDS, count)
    .all<{ kind: CommerceEmailKind; subject_id: string }>();
  for (const row of expired.results ?? []) {
    results.push({ id: `${row.kind}:${row.subject_id}`, status: 'error', error: 'Email was not sent within 7 days and was given up' });
  }
  // Only the kinds this release sends, so rows a later release adds never crowd them out after a rollback.
  // The unary + keeps SQLite on the due index instead of the (kind, subject_id) index over every email.
  const due = (kinds: CommerceEmailKind[]) => env.DB.prepare(`SELECT kind, subject_id FROM _ecommerce_email_deliveries
    WHERE status = 'pending' AND next_attempt_at <= ? AND (claimed_at IS NULL OR claimed_at <= ?)
      AND +kind IN (${kinds.map(() => '?').join(', ')})
    ORDER BY next_attempt_at, created_at, kind <> 'order_confirmation', id LIMIT ?`)
    .bind(now, now - COMMERCE_EMAIL_LEASE_SECONDS, ...kinds, count).all<{ kind: CommerceEmailKind; subject_id: string }>();
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
    const found = (await due(group.kinds)).results?.length ?? 0;
    if (found) results.push(waitingEmailsResult(group.kinds.length === kinds.length ? 'all' : group.kinds, group.missing, found, count));
  }
  if (!sendable.length) return results;
  for (const row of (await due(sendable)).results ?? []) {
    const result = await runCommerceEmailDelivery(env, row.kind, row.subject_id, COMPOSERS[row.kind], { setup, now });
    if (result) results.push(result);
  }
  return results;
}
