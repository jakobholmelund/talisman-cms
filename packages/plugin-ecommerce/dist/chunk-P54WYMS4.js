import {
  ORDER_AMOUNT_COLUMNS,
  chunked,
  describeOrderItems,
  orderAmounts,
  placeholders
} from "./chunk-WP5KVMJI.js";
import {
  COMMERCE_EMAIL_LEASE_SECONDS,
  COMMERCE_EMAIL_MAX_AGE_SECONDS,
  applyEmailTemplate,
  bareEmailAddress,
  commerceEmailSetup,
  commerceEmailStatement,
  composeGiftCardClaimEmail,
  missingEmailSettings,
  runCommerceEmailDelivery,
  sendCommerceEmailNow,
  waitingEmailsResult
} from "./chunk-EY3DVH22.js";
import {
  orders
} from "./chunk-K4FWMXR2.js";
import {
  orderConfirmationEmail,
  shipmentEmail
} from "./chunk-NMGICNSV.js";

// src/fulfillment.ts
import { eq as eq2 } from "drizzle-orm";
import { z } from "zod";
import { createDbClient as createDbClient2 } from "talisman-cms/client";

// src/commerce-emails.ts
import { eq } from "drizzle-orm";
import { createDbClient } from "talisman-cms/client";
var BUYER_AMOUNT_LABELS = {
  charged: "Amount charged",
  providerRefunded: "Refunded to your payment method",
  giftCardRefunded: "Refunded to your gift card"
};
var CONFIRMABLE_STATUSES = ["paid", "fulfilled", "partially_refunded", "disputed"];
function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
var composeOrderConfirmation = async (env, orderId, setup) => {
  const order = await env.DB.prepare(`SELECT id, status, payment_provider, customer_email, currency, items,
      shipping_address, ${ORDER_AMOUNT_COLUMNS}, created_at
    FROM _ecommerce_orders WHERE id = ?`).bind(orderId).first();
  if (!order || (order.payment_provider ?? "stripe") === "admin_test") return { cancel: "not_found" };
  if (!CONFIRMABLE_STATUSES.includes(order.status)) return { cancel: "not_due" };
  const to = bareEmailAddress(order.customer_email);
  if (!to) return { fail: "invalid_recipient" };
  const stored = parseJson(order.items, []);
  const items = await describeOrderItems(env, Array.isArray(stored) ? stored.filter((item) => typeof item?.productId === "string") : []);
  const email = {
    store: setup.store,
    order: {
      id: order.id,
      placedAt: new Date(order.created_at * 1e3),
      currency: order.currency,
      items: items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId ?? null,
        name: `${item.productName ?? item.productId}${item.variantLabel ? ` (${item.variantLabel})` : ""}`,
        productName: item.productName,
        variantLabel: item.variantLabel,
        sku: item.sku,
        quantity: item.quantity,
        unitCents: item.priceAtPurchase,
        lineCents: item.priceAtPurchase * item.quantity
      })),
      amounts: orderAmounts(order).map((amount) => ({ ...amount, label: BUYER_AMOUNT_LABELS[amount.key] ?? amount.label })),
      shippingAddress: parseJson(order.shipping_address, null)
    }
  };
  return { to, message: await applyEmailTemplate(setup, "orderConfirmation", email, orderConfirmationEmail(email)) };
};
function shipmentComposer(update) {
  return async (env, fulfillmentId, setup) => {
    const { results } = await env.DB.prepare(`SELECT id, order_id, kind, corrects_id, completes_order, carrier,
        tracking_number, created_at
      FROM _ecommerce_fulfillments WHERE order_id = (SELECT order_id FROM _ecommerce_fulfillments WHERE id = ?)
      ORDER BY rowid`).bind(fulfillmentId).all();
    const rows = results ?? [];
    const subject = rows.find((row) => row.id === fulfillmentId);
    const shipmentId = update ? subject?.corrects_id : subject?.id;
    const index = rows.findIndex((row) => row.id === shipmentId && row.kind === "shipment");
    if (index < 0) return { cancel: "not_found" };
    const shipment = rows[index];
    const current = rows.filter((row) => row.corrects_id === shipment.id).at(-1) ?? shipment;
    const order = await createDbClient(env).select({
      id: orders.id,
      customerEmail: orders.customerEmail,
      paymentProvider: orders.paymentProvider,
      createdAt: orders.createdAt
    }).from(orders).where(eq(orders.id, shipment.order_id)).get();
    if (!order || (order.paymentProvider ?? "stripe") === "admin_test") return { cancel: "not_found" };
    const to = bareEmailAddress(order.customerEmail);
    if (!to) return { fail: "invalid_recipient" };
    const email = {
      store: setup.store,
      order: { id: order.id, placedAt: order.createdAt },
      shipment: {
        id: shipment.id,
        shippedAt: new Date(shipment.created_at * 1e3),
        // Shipments recorded before migration 0026 may hold an empty string where there is no value.
        carrier: current.carrier || null,
        trackingNumber: current.tracking_number || null,
        completesOrder: shipment.completes_order === 1,
        earlierShipments: rows.slice(0, index).filter((row) => row.kind === "shipment").length
      },
      update
    };
    return { to, message: await applyEmailTemplate(setup, "shipment", email, shipmentEmail(email)) };
  };
}
var COMPOSERS = {
  order_confirmation: composeOrderConfirmation,
  shipment: shipmentComposer(false),
  shipment_update: shipmentComposer(true),
  gift_card_claim: composeGiftCardClaimEmail
};
function deliverCommerceEmail(env, kind, subjectId) {
  return sendCommerceEmailNow(env, kind, subjectId, COMPOSERS[kind]);
}
async function deliverPendingCommerceEmails(options, { limit = 10, now: at } = {}) {
  const { env } = options;
  const count = Math.max(1, Math.min(50, Math.floor(limit)));
  const now = at ?? Math.floor(Date.now() / 1e3);
  const results = [];
  const expired = await env.DB.prepare(`UPDATE _ecommerce_email_deliveries
    SET status = 'failed', last_error = 'expired', claimed_at = NULL
    WHERE id IN (SELECT id FROM _ecommerce_email_deliveries
      WHERE status = 'pending' AND created_at < ? AND (claimed_at IS NULL OR claimed_at <= ?)
      ORDER BY created_at LIMIT ?)
    RETURNING kind, subject_id`).bind(now - COMMERCE_EMAIL_MAX_AGE_SECONDS, now - COMMERCE_EMAIL_LEASE_SECONDS, count).all();
  for (const row of expired.results ?? []) {
    results.push({ id: `${row.kind}:${row.subject_id}`, status: "error", error: "Email was not sent within 7 days and was given up" });
  }
  const due = (kinds2) => env.DB.prepare(`SELECT kind, subject_id FROM _ecommerce_email_deliveries
    WHERE status = 'pending' AND next_attempt_at <= ? AND (claimed_at IS NULL OR claimed_at <= ?)
      AND +kind IN (${kinds2.map(() => "?").join(", ")})
    ORDER BY next_attempt_at, created_at, kind <> 'order_confirmation', id LIMIT ?`).bind(now, now - COMMERCE_EMAIL_LEASE_SECONDS, ...kinds2, count).all();
  const setup = await commerceEmailSetup(env);
  const kinds = Object.keys(COMPOSERS);
  const sendable = [];
  const waiting = /* @__PURE__ */ new Map();
  for (const kind of kinds) {
    const missing = missingEmailSettings(setup, kind);
    if (!missing.length) sendable.push(kind);
    else waiting.set(missing.join(", "), { kinds: [...waiting.get(missing.join(", "))?.kinds ?? [], kind], missing });
  }
  for (const group of waiting.values()) {
    const found = (await due(group.kinds)).results?.length ?? 0;
    if (found) results.push(waitingEmailsResult(group.kinds.length === kinds.length ? "all" : group.kinds, group.missing, found, count));
  }
  if (!sendable.length) return results;
  for (const row of (await due(sendable)).results ?? []) {
    const result = await runCommerceEmailDelivery(env, row.kind, row.subject_id, COMPOSERS[row.kind], { setup, now });
    if (result) results.push(result);
  }
  return results;
}

// src/fulfillment.ts
var ORDERS_PAGE_SIZE = 50;
var ORDERS_PAGE_MAX = 100;
var FulfillmentInputError = class extends Error {
  name = "FulfillmentInputError";
};
var SHIPPABLE_STATUSES = ["paid", "partially_refunded"];
var REAL_ORDER = `COALESCE(payment_provider, 'stripe') <> 'admin_test'`;
var VIEWS = {
  // Every real order that can still ship, oldest first.
  awaiting: { where: `status IN ('paid','partially_refunded') AND fulfillment_status <> 'fulfilled' AND ${REAL_ORDER}`, ascending: true },
  // Real orders past checkout, newest first.
  recent: { where: `status NOT IN ('pending','cancelled','draft') AND ${REAL_ORDER}`, ascending: false }
};
var ORDER_COLUMNS = `id, status, fulfillment_status, payment_provider, customer_email, currency, items,
  shipping_address, ${ORDER_AMOUNT_COLUMNS}, created_at`;
var optionalText = (max) => z.string().trim().max(max).nullish().transform((value) => value || null);
var listSchema = z.object({
  view: z.enum(["awaiting", "recent"]).default("awaiting"),
  // Room for an order id of about 3,000 ASCII characters; checkout writes ids of 40.
  cursor: z.string().max(4096).nullish(),
  limit: z.number().int().min(1).max(ORDERS_PAGE_MAX).default(ORDERS_PAGE_SIZE),
  query: z.string().trim().max(254).nullish()
}).strict();
var shipmentSchema = z.object({
  orderId: z.string().regex(/^ord_[0-9a-f-]{36}$/),
  carrier: optionalText(100),
  trackingNumber: optionalText(150),
  note: z.string().trim().min(8).max(500),
  completesOrder: z.boolean().default(true)
}).strict();
var correctionSchema = z.object({
  fulfillmentId: z.string().trim().min(1).max(128),
  carrier: optionalText(100),
  trackingNumber: optionalText(150),
  reason: z.string().trim().min(8).max(500)
}).strict().refine((values) => values.carrier || values.trackingNumber, { message: "Enter a carrier or a tracking number" });
function parseInput(schema, input) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  throw new FulfillmentInputError(issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message);
}
var isoTime = (seconds) => new Date(seconds * 1e3).toISOString();
function parseJson2(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
function encodeCursor(view, row) {
  const bytes = new TextEncoder().encode(JSON.stringify([view, row.created_at, row.id]));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeCursor(view, cursor) {
  try {
    const bytes = Uint8Array.from(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
    const [cursorView, createdAt, id] = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (cursorView === view && Number.isSafeInteger(createdAt) && typeof id === "string") {
      return [createdAt, id];
    }
  } catch {
  }
  throw new FulfillmentInputError("The page cursor is invalid; reload the orders");
}
async function loadShipments(env, orderIds) {
  const statements = chunked(orderIds).map((ids) => env.DB.prepare(`SELECT id, order_id, kind, corrects_id,
      completes_order, admin_actor, carrier, tracking_number, note, created_at
    FROM _ecommerce_fulfillments WHERE order_id IN (${placeholders(ids)})
    ORDER BY rowid`).bind(...ids));
  const rows = (statements.length ? await env.DB.batch(statements) : []).flatMap((result) => result.results ?? []);
  const shipments = /* @__PURE__ */ new Map();
  const byOrder = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (row.kind === "shipment") {
      const shipment2 = {
        id: row.id,
        createdAt: isoTime(row.created_at),
        adminActor: row.admin_actor,
        note: row.note,
        completesOrder: row.completes_order === 1,
        carrier: row.carrier,
        trackingNumber: row.tracking_number,
        recorded: { carrier: row.carrier, trackingNumber: row.tracking_number },
        corrections: []
      };
      shipments.set(row.id, shipment2);
      byOrder.set(row.order_id, [...byOrder.get(row.order_id) ?? [], shipment2]);
      continue;
    }
    const shipment = row.corrects_id ? shipments.get(row.corrects_id) : void 0;
    if (!shipment) continue;
    shipment.corrections.push({
      id: row.id,
      createdAt: isoTime(row.created_at),
      adminActor: row.admin_actor,
      carrier: row.carrier,
      trackingNumber: row.tracking_number,
      reason: row.note
    });
    shipment.carrier = row.carrier;
    shipment.trackingNumber = row.tracking_number;
  }
  return byOrder;
}
async function listCommerceOrdersAdmin(env, options = {}) {
  const values = parseInput(listSchema, options);
  const view = VIEWS[values.view];
  const conditions = [view.where];
  const params = [];
  if (values.query?.includes("@")) {
    conditions.push("lower(customer_email) = ?");
    params.push(values.query.toLowerCase());
  } else if (values.query) {
    conditions.push("id = ?");
    params.push(values.query);
  }
  if (values.cursor) {
    conditions.push(`(created_at, id) ${view.ascending ? ">" : "<"} (?, ?)`);
    params.push(...decodeCursor(values.view, values.cursor));
  }
  const direction = view.ascending ? "ASC" : "DESC";
  const [counted, listed] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_orders WHERE ${VIEWS.awaiting.where}`),
    env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM _ecommerce_orders WHERE ${conditions.join(" AND ")}
      ORDER BY created_at ${direction}, id ${direction} LIMIT ?`).bind(...params, values.limit + 1)
  ]);
  const found = listed.results ?? [];
  const rows = found.slice(0, values.limit);
  const storedItems = rows.map((row) => {
    const items = parseJson2(row.items, []);
    return Array.isArray(items) ? items.filter((item) => typeof item?.productId === "string") : [];
  });
  const described = await describeOrderItems(env, storedItems.flat());
  const shipments = await loadShipments(env, rows.map((row) => row.id));
  let offset = 0;
  const orders2 = rows.map((row, index) => {
    const items = described.slice(offset, offset += storedItems[index].length);
    const provider = row.payment_provider ?? "stripe";
    return {
      id: row.id,
      status: row.status,
      fulfillmentStatus: row.fulfillment_status,
      paymentProvider: provider,
      customerEmail: row.customer_email,
      currency: row.currency,
      createdAt: isoTime(row.created_at),
      shippingAddress: parseJson2(row.shipping_address, null),
      canShip: SHIPPABLE_STATUSES.includes(row.status) && row.fulfillment_status !== "fulfilled" && provider !== "admin_test",
      items: items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        unitAmount: item.priceAtPurchase,
        lineTotal: item.priceAtPurchase * item.quantity,
        productName: item.productName,
        variantLabel: item.variantLabel,
        sku: item.sku
      })),
      amounts: orderAmounts(row),
      shipments: shipments.get(row.id) ?? []
    };
  });
  return {
    view: values.view,
    pageSize: values.limit,
    awaitingCount: Number(counted.results?.[0]?.count ?? 0),
    nextCursor: found.length > values.limit ? encodeCursor(values.view, rows[rows.length - 1]) : null,
    orders: orders2
  };
}
function refusal(cause, message) {
  return cause instanceof Error && cause.message.includes(message) ? new Error(message, { cause }) : cause;
}
async function fulfillCommerceOrder(env, actor, input) {
  const values = parseInput(shipmentSchema, input);
  if (!actor.trim()) throw new Error("Administrator identity is required");
  const db = createDbClient2(env);
  const order = await db.select({
    status: orders.status,
    fulfillmentStatus: orders.fulfillmentStatus,
    paymentProvider: orders.paymentProvider
  }).from(orders).where(eq2(orders.id, values.orderId)).get();
  if (!order) throw new Error("Order not found");
  if ((order.paymentProvider ?? "stripe") === "admin_test") throw new Error("Admin test orders cannot be fulfilled");
  if (order.fulfillmentStatus === "fulfilled") throw new Error("Order has already shipped in full");
  if (!SHIPPABLE_STATUSES.includes(order.status)) {
    throw new Error(`A ${order.status.replaceAll("_", " ")} order cannot ship`);
  }
  const id = `ful_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1e3);
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO _ecommerce_fulfillments
        (id, order_id, kind, completes_order, admin_actor, carrier, tracking_number, note, created_at)
        VALUES (?, ?, 'shipment', ?, ?, ?, ?, ?, ?)`).bind(
        id,
        values.orderId,
        values.completesOrder ? 1 : 0,
        actor,
        values.carrier,
        values.trackingNumber,
        values.note,
        now
      ),
      commerceEmailStatement(env, "shipment", id, now)
    ]);
  } catch (cause) {
    throw refusal(cause, "Order is not ready for fulfillment");
  }
  await deliverCommerceEmail(env, "shipment", id);
  const current = await db.select({ status: orders.status, fulfillmentStatus: orders.fulfillmentStatus }).from(orders).where(eq2(orders.id, values.orderId)).get();
  return {
    fulfillmentId: id,
    orderId: values.orderId,
    status: current?.status,
    fulfillmentStatus: current?.fulfillmentStatus
  };
}
async function correctCommerceFulfillment(env, actor, input) {
  const values = parseInput(correctionSchema, input);
  if (!actor.trim()) throw new Error("Administrator identity is required");
  const { results } = await env.DB.prepare(`SELECT f.id, f.order_id, f.kind, f.corrects_id, f.carrier,
      f.tracking_number, o.payment_provider
    FROM _ecommerce_fulfillments f JOIN _ecommerce_orders o ON o.id = f.order_id
    WHERE f.order_id = (SELECT order_id FROM _ecommerce_fulfillments WHERE id = ?)
    ORDER BY f.rowid`).bind(values.fulfillmentId).all();
  const rows = results ?? [];
  const shipment = rows.find((row) => row.id === values.fulfillmentId);
  if (!shipment || shipment.kind !== "shipment") throw new Error("Shipment not found");
  if ((shipment.payment_provider ?? "stripe") === "admin_test") throw new Error("Admin test orders cannot be fulfilled");
  const current = rows.filter((row) => row.corrects_id === shipment.id).at(-1) ?? shipment;
  if ((current.carrier || null) === values.carrier && (current.tracking_number || null) === values.trackingNumber) {
    throw new Error("The correction changes nothing");
  }
  const id = `ful_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1e3);
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO _ecommerce_fulfillments
        (id, order_id, kind, corrects_id, completes_order, admin_actor, carrier, tracking_number, note, created_at)
        VALUES (?, ?, 'correction', ?, 0, ?, ?, ?, ?, ?)`).bind(id, shipment.order_id, shipment.id, actor, values.carrier, values.trackingNumber, values.reason, now),
      commerceEmailStatement(env, "shipment_update", id, now, {
        sql: `EXISTS (SELECT 1 FROM _ecommerce_email_deliveries WHERE kind = 'shipment' AND subject_id = ?
          AND (status = 'sent' OR (status = 'pending' AND claimed_at > ?)))`,
        // Only a live lease means the notice is being sent; after a stale one the notice carries the correction.
        params: [shipment.id, now - COMMERCE_EMAIL_LEASE_SECONDS]
      })
    ]);
  } catch (cause) {
    throw refusal(cause, "Shipment cannot be corrected");
  }
  await deliverCommerceEmail(env, "shipment_update", id);
  return {
    correctionId: id,
    fulfillmentId: shipment.id,
    orderId: shipment.order_id,
    carrier: values.carrier,
    trackingNumber: values.trackingNumber
  };
}

export {
  deliverCommerceEmail,
  deliverPendingCommerceEmails,
  ORDERS_PAGE_SIZE,
  ORDERS_PAGE_MAX,
  FulfillmentInputError,
  listCommerceOrdersAdmin,
  fulfillCommerceOrder,
  correctCommerceFulfillment
};
