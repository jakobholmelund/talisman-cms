import {
  adminActorNames,
  describeOrderItems,
  orderAmountColumns,
  orderAmounts,
  parcelContentsValue,
  parcelItemsSchema
} from "./chunk-OZACQY4G.js";
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
  unclaimedAt,
  waitingEmailsResult
} from "./chunk-IUC5ZIOJ.js";
import {
  batchGroups,
  chunked,
  commerceDb,
  errorText
} from "./chunk-4WYWYY7J.js";
import {
  creditLedger,
  emailDeliveries,
  fulfillments,
  giftCardLedger,
  orders,
  parcelContents,
  restocks,
  returnInspections,
  returnReceipts
} from "./chunk-OMZRKOH6.js";
import {
  hashOrderAccess
} from "./chunk-NQUBOBQT.js";
import {
  orderConfirmationEmail,
  shipmentEmail
} from "./chunk-SPRRFCF5.js";

// src/order-activity.ts
import { and, eq, inArray } from "drizzle-orm";
async function loadOrderActivity(env, orderIds) {
  const db = commerceDb(env);
  const groups = chunked(orderIds);
  const { stock, gift, credit, parcels, confirmations, contents, returns, inspections } = await batchGroups(db, {
    inspections: groups.map((ids) => db.select().from(returnInspections).where(inArray(returnInspections.orderId, ids))),
    contents: groups.map((ids) => db.select().from(parcelContents).where(inArray(parcelContents.orderId, ids))),
    returns: groups.map((ids) => db.select().from(returnReceipts).where(inArray(returnReceipts.orderId, ids))),
    stock: groups.map((ids) => db.select().from(restocks).where(inArray(restocks.orderId, ids))),
    gift: groups.map((ids) => db.select().from(giftCardLedger).where(and(inArray(giftCardLedger.orderId, ids), eq(giftCardLedger.kind, "refund_restore")))),
    credit: groups.map((ids) => db.select().from(creditLedger).where(and(inArray(creditLedger.orderId, ids), eq(creditLedger.kind, "purchase_credit_refund")))),
    parcels: groups.map((ids) => db.select().from(fulfillments).where(inArray(fulfillments.orderId, ids))),
    confirmations: groups.map((ids) => db.select().from(emailDeliveries).where(and(inArray(emailDeliveries.subjectId, ids), eq(emailDeliveries.kind, "order_confirmation"))))
  });
  const { notices } = await batchGroups(db, { notices: chunked(parcels.map((row) => row.id)).map((ids) => db.select().from(emailDeliveries).where(and(inArray(emailDeliveries.subjectId, ids), inArray(emailDeliveries.kind, ["shipment", "shipment_update"])))) });
  const names = await adminActorNames(env, [...stock, ...parcels].map((row) => row.adminActor).concat([...contents, ...returns, ...inspections].map((row) => row.actor)));
  const parcelOrders = new Map(parcels.map((row) => [row.id, row.orderId]));
  const activity = /* @__PURE__ */ new Map();
  function add(orderId, event) {
    activity.set(orderId, [...activity.get(orderId) ?? [], event]);
  }
  const base = (id, kind, createdAt, detail) => ({
    id,
    kind,
    createdAt: createdAt.toISOString(),
    detail,
    actor: null,
    actorName: null,
    amountCents: null,
    email: null
  });
  for (const row of contents) add(row.orderId, { ...base(row.id, "parcel_contents", row.createdAt, `${row.items.reduce((n, i) => n + i.quantity, 0)} units in parcel ${row.fulfillmentId}: ${row.reason}`), actor: row.actor, actorName: names.get(row.actor) ?? row.actor });
  for (const row of inspections) add(row.orderId, { ...base(row.id, "return_inspection", row.createdAt, `${row.items.reduce((n, i) => n + i.quantity, 0)} units inspected: ${row.reason}`), actor: row.actor, actorName: names.get(row.actor) ?? row.actor });
  for (const row of returns) add(row.orderId, { ...base(row.id, "return_intake", row.createdAt, `${row.items.reduce((n, i) => n + i.quantity, 0)} units received: ${row.reason}`), actor: row.actor, actorName: names.get(row.actor) ?? row.actor });
  for (const row of stock) add(row.orderId, { ...base(
    row.id,
    "restock",
    row.createdAt,
    `${row.quantity} \xD7 ${row.targetType} ${row.targetId}: ${row.reason}`
  ), actor: row.adminActor, actorName: names.get(row.adminActor) ?? row.adminActor });
  for (const row of parcels) add(row.orderId, { ...base(
    row.id,
    row.kind,
    row.createdAt,
    [row.note, row.carrier, row.trackingNumber].filter(Boolean).join(" \xB7 ")
  ), actor: row.adminActor, actorName: names.get(row.adminActor) ?? row.adminActor });
  for (const row of gift) if (row.orderId) add(row.orderId, { ...base(row.id, "gift_card_refund", row.createdAt, `Returned to gift card ${row.cardId}`), amountCents: row.amountCents });
  for (const row of credit) add(row.orderId, { ...base(row.id, "store_credit_refund", row.createdAt, "Returned to shopper store credit"), amountCents: row.amountCents });
  for (const row of [...confirmations, ...notices]) {
    const orderId = row.kind === "order_confirmation" ? row.subjectId : parcelOrders.get(row.subjectId);
    if (orderId) add(orderId, {
      ...base(row.id, "email", row.createdAt, row.kind.replaceAll("_", " ")),
      email: {
        status: row.status,
        attempts: row.attempts,
        lastError: row.lastError,
        sentAt: row.sentAt?.toISOString() ?? null,
        nextAttemptAt: row.status === "pending" ? row.nextAttemptAt.toISOString() : null
      }
    });
  }
  for (const events of activity.values()) events.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return activity;
}

// src/fulfillment.ts
import { and as and3, asc, count, desc, eq as eq3, sql as sql2 } from "drizzle-orm";
import { z } from "zod";

// src/commerce-emails.ts
import { and as and2, eq as eq2, inArray as inArray2, lte, sql } from "drizzle-orm";
var at = (seconds) => new Date(seconds * 1e3);
var storedItems = (items) => Array.isArray(items) ? items.filter((item) => typeof item?.productId === "string") : [];
var orderOfFulfillment = (db, fulfillmentId) => db.select({ orderId: fulfillments.orderId }).from(fulfillments).where(eq2(fulfillments.id, fulfillmentId));
var BUYER_AMOUNT_LABELS = {
  charged: "Amount charged",
  providerRefunded: "Refunded to your payment method",
  giftCardRefunded: "Refunded to your gift card"
};
var CONFIRMABLE_STATUSES = ["paid", "fulfilled", "partially_refunded", "disputed"];
var composeOrderConfirmation = async (env, orderId, setup) => {
  const order = await commerceDb(env).select({
    id: orders.id,
    status: orders.status,
    paymentProvider: orders.paymentProvider,
    customerEmail: orders.customerEmail,
    currency: orders.currency,
    items: orders.items,
    shippingAddress: orders.shippingAddress,
    ...orderAmountColumns,
    createdAt: orders.createdAt
  }).from(orders).where(eq2(orders.id, orderId)).get();
  if (!order || (order.paymentProvider ?? "stripe") === "admin_test") return { cancel: "not_found" };
  if (!CONFIRMABLE_STATUSES.includes(order.status)) return { cancel: "not_due" };
  const to = bareEmailAddress(order.customerEmail);
  if (!to) return { fail: "invalid_recipient" };
  const items = await describeOrderItems(env, storedItems(order.items));
  const email = {
    store: setup.store,
    order: {
      id: order.id,
      placedAt: order.createdAt,
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
      shippingAddress: order.shippingAddress ?? null
    }
  };
  return { to, message: await applyEmailTemplate(setup, "orderConfirmation", email, orderConfirmationEmail(email)) };
};
function shipmentComposer(update) {
  return async (env, fulfillmentId, setup) => {
    const db = commerceDb(env);
    const rows = await db.select({
      id: fulfillments.id,
      orderId: fulfillments.orderId,
      kind: fulfillments.kind,
      correctsId: fulfillments.correctsId,
      completesOrder: fulfillments.completesOrder,
      carrier: fulfillments.carrier,
      trackingNumber: fulfillments.trackingNumber,
      createdAt: fulfillments.createdAt
    }).from(fulfillments).where(eq2(fulfillments.orderId, orderOfFulfillment(db, fulfillmentId))).orderBy(sql`rowid`);
    const subject = rows.find((row) => row.id === fulfillmentId);
    const shipmentId = update ? subject?.correctsId : subject?.id;
    const index = rows.findIndex((row) => row.id === shipmentId && row.kind === "shipment");
    if (index < 0) return { cancel: "not_found" };
    const shipment = rows[index];
    const current = rows.filter((row) => row.correctsId === shipment.id).at(-1) ?? shipment;
    const order = await db.select({
      id: orders.id,
      customerEmail: orders.customerEmail,
      paymentProvider: orders.paymentProvider,
      items: orders.items,
      createdAt: orders.createdAt
    }).from(orders).where(eq2(orders.id, shipment.orderId)).get();
    if (!order || (order.paymentProvider ?? "stripe") === "admin_test") return { cancel: "not_found" };
    const to = bareEmailAddress(order.customerEmail);
    if (!to) return { fail: "invalid_recipient" };
    const contents = await db.query.parcelContents.findMany({ where: { orderId: order.id } });
    const parcel = contents.find((p) => p.fulfillmentId === shipment.id);
    const earlierIds = new Set(rows.slice(0, index + 1).filter((p) => p.kind === "shipment").map((p) => p.id));
    const known = contents.filter((p) => earlierIds.has(p.fulfillmentId));
    const allKnown = known.length === earlierIds.size;
    const completesOrder = parcel && allKnown ? order.items.every((line, lineIndex) => known.reduce((n, p) => n + (p.items.find((i) => i.lineIndex === lineIndex)?.quantity ?? 0), 0) >= line.quantity) : shipment.completesOrder;
    const described = parcel ? await describeOrderItems(env, parcel.items.map((i) => ({ ...order.items[i.lineIndex], quantity: i.quantity }))) : [];
    const email = {
      store: setup.store,
      order: { id: order.id, placedAt: order.createdAt },
      shipment: {
        id: shipment.id,
        shippedAt: shipment.createdAt,
        // A shipment row may hold an empty string where there is no value.
        carrier: current.carrier || null,
        trackingNumber: current.trackingNumber || null,
        completesOrder,
        items: described.map((i) => ({ name: [i.productName || i.productId, i.variantLabel].filter(Boolean).join(" / "), sku: i.sku, quantity: i.quantity })),
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
async function deliverPendingCommerceEmails(options, { limit = 10, now: givenNow } = {}) {
  const { env } = options;
  const count2 = Math.max(1, Math.min(50, Math.floor(limit)));
  const now = givenNow ?? Math.floor(Date.now() / 1e3);
  const results = [];
  const db = commerceDb(env);
  const pending = sql`${emailDeliveries.status} = 'pending'`;
  const oldest = db.select({ id: emailDeliveries.id }).from(emailDeliveries).where(and2(pending, sql`COALESCE(${emailDeliveries.retryRequestedAt}, ${emailDeliveries.createdAt}) < ${now - COMMERCE_EMAIL_MAX_AGE_SECONDS}`, unclaimedAt(now))).orderBy(emailDeliveries.createdAt).limit(count2);
  const expired = await db.update(emailDeliveries).set({ status: "failed", lastError: "expired", claimedAt: null }).where(inArray2(emailDeliveries.id, oldest)).returning({ kind: emailDeliveries.kind, subjectId: emailDeliveries.subjectId });
  for (const row of expired) {
    results.push({ id: `${row.kind}:${row.subjectId}`, status: "error", error: "Email was not sent within 7 days and was given up" });
  }
  const due = (kinds2) => db.select({ kind: emailDeliveries.kind, subjectId: emailDeliveries.subjectId }).from(emailDeliveries).where(and2(pending, lte(emailDeliveries.nextAttemptAt, at(now)), unclaimedAt(now), sql`+${emailDeliveries.kind} IN ${kinds2}`)).orderBy(emailDeliveries.nextAttemptAt, emailDeliveries.createdAt, sql`${emailDeliveries.kind} <> 'order_confirmation'`, emailDeliveries.id).limit(count2);
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
    const found = (await due(group.kinds)).length;
    if (found) results.push(waitingEmailsResult(group.kinds.length === kinds.length ? "all" : group.kinds, group.missing, found, count2));
  }
  if (!sendable.length) return results;
  for (const row of await due(sendable)) {
    const result = await runCommerceEmailDelivery(env, row.kind, row.subjectId, COMPOSERS[row.kind], { setup, now });
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
var REAL_ORDER = sql2`COALESCE(${orders.paymentProvider}, 'stripe') <> 'admin_test'`;
var VIEWS = {
  // Every real order that can still ship, oldest first.
  awaiting: { where: sql2`${orders.status} IN ('paid','partially_refunded') AND ${orders.fulfillmentStatus} <> 'fulfilled' AND ${REAL_ORDER}`, ascending: true },
  // Real orders past checkout, newest first.
  recent: { where: sql2`${orders.status} NOT IN ('pending','cancelled','draft') AND ${REAL_ORDER}`, ascending: false }
};
var orderColumns = {
  id: orders.id,
  status: orders.status,
  fulfillmentStatus: orders.fulfillmentStatus,
  paymentProvider: orders.paymentProvider,
  customerEmail: orders.customerEmail,
  currency: orders.currency,
  items: orders.items,
  shippingAddress: orders.shippingAddress,
  ...orderAmountColumns,
  createdAt: orders.createdAt
};
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
  completesOrder: z.boolean().default(true),
  items: parcelItemsSchema.optional(),
  requestKey: z.string().trim().min(8).max(128).optional()
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
function encodeCursor(view, row) {
  const bytes = new TextEncoder().encode(JSON.stringify([view, Math.floor(row.createdAt.getTime() / 1e3), row.id]));
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
  const db = commerceDb(env);
  const { rows } = await batchGroups(db, {
    rows: chunked(orderIds).map((ids) => db.query.fulfillments.findMany({
      where: { orderId: { in: ids } },
      with: { contents: true, order: { columns: { items: true } } },
      orderBy: (_table, { sql: sql3 }) => sql3`rowid`
    }))
  });
  const shipments = /* @__PURE__ */ new Map();
  const byOrder = /* @__PURE__ */ new Map();
  const counts = /* @__PURE__ */ new Map();
  const unknown = /* @__PURE__ */ new Set();
  for (const row of rows) {
    if (row.kind === "shipment") {
      const shipped = counts.get(row.orderId) ?? /* @__PURE__ */ new Map();
      if (!row.contents) unknown.add(row.orderId);
      else for (const item of row.contents.items) shipped.set(item.lineIndex, (shipped.get(item.lineIndex) ?? 0) + item.quantity);
      counts.set(row.orderId, shipped);
      const completes = row.contents && !unknown.has(row.orderId) ? row.order.items.every((item, index) => (shipped.get(index) ?? 0) >= item.quantity) : row.completesOrder;
      const shipment2 = {
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        adminActor: row.adminActor,
        note: row.note,
        completesOrder: completes,
        carrier: row.carrier,
        trackingNumber: row.trackingNumber,
        recorded: { carrier: row.carrier, trackingNumber: row.trackingNumber },
        corrections: []
      };
      shipments.set(row.id, shipment2);
      byOrder.set(row.orderId, [...byOrder.get(row.orderId) ?? [], shipment2]);
      continue;
    }
    const shipment = row.correctsId ? shipments.get(row.correctsId) : void 0;
    if (!shipment) continue;
    shipment.corrections.push({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      adminActor: row.adminActor,
      carrier: row.carrier,
      trackingNumber: row.trackingNumber,
      reason: row.note
    });
    shipment.carrier = row.carrier;
    shipment.trackingNumber = row.trackingNumber;
  }
  return byOrder;
}
async function listCommerceOrdersAdmin(env, options = {}) {
  const values = parseInput(listSchema, options);
  const view = VIEWS[values.view];
  const conditions = [view.where];
  if (values.query?.includes("@")) {
    conditions.push(eq3(sql2`lower(${orders.customerEmail})`, values.query.toLowerCase()));
  } else if (values.query) {
    conditions.push(eq3(orders.id, values.query));
  }
  if (values.cursor) {
    const [createdAt, id] = decodeCursor(values.view, values.cursor);
    conditions.push(view.ascending ? sql2`(${orders.createdAt}, ${orders.id}) > (${createdAt}, ${id})` : sql2`(${orders.createdAt}, ${orders.id}) < (${createdAt}, ${id})`);
  }
  const direction = view.ascending ? asc : desc;
  const db = commerceDb(env);
  const [[counted], found] = await db.batch([
    db.select({ count: count() }).from(orders).where(VIEWS.awaiting.where),
    db.select(orderColumns).from(orders).where(and3(...conditions)).orderBy(direction(orders.createdAt), direction(orders.id)).limit(values.limit + 1)
  ]);
  const rows = found.slice(0, values.limit);
  const storedItems2 = rows.map((row) => Array.isArray(row.items) ? row.items.filter((item) => typeof item?.productId === "string") : []);
  const described = await describeOrderItems(env, storedItems2.flat());
  const shipments = await loadShipments(env, rows.map((row) => row.id));
  const { events } = await batchGroups(db, { events: chunked(rows.map((row) => row.id)).map((ids) => db.query.fulfillments.findMany({
    columns: { id: true, orderId: true, kind: true, note: true, adminActor: true, createdAt: true },
    where: { orderId: { in: ids }, kind: { in: ["reopen", "complete"] } },
    orderBy: (_row, { sql: sql3 }) => sql3`rowid`
  })) });
  const activity = await loadOrderActivity(env, rows.map((row) => row.id));
  let offset = 0;
  const orders2 = rows.map((row, index) => {
    const items = described.slice(offset, offset += storedItems2[index].length);
    const provider = row.paymentProvider ?? "stripe";
    return {
      id: row.id,
      status: row.status,
      fulfillmentStatus: row.fulfillmentStatus,
      paymentProvider: provider,
      customerEmail: row.customerEmail,
      currency: row.currency,
      createdAt: row.createdAt.toISOString(),
      shippingAddress: row.shippingAddress ?? null,
      canShip: SHIPPABLE_STATUSES.includes(row.status) && row.fulfillmentStatus !== "fulfilled" && provider !== "admin_test",
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
      activity: activity.get(row.id) ?? [],
      amounts: orderAmounts(row),
      shipments: shipments.get(row.id) ?? [],
      fulfillmentEvents: events.filter((event) => event.orderId === row.id)
    };
  });
  return {
    view: values.view,
    pageSize: values.limit,
    awaitingCount: Number(counted?.count ?? 0),
    nextCursor: found.length > values.limit ? encodeCursor(values.view, rows[rows.length - 1]) : null,
    orders: orders2
  };
}
function refusal(cause, message) {
  return cause instanceof Error && errorText(cause).includes(message) ? new Error(message, { cause }) : cause;
}
async function fulfillCommerceOrder(env, actor, input) {
  const values = parseInput(shipmentSchema, input);
  if (!actor.trim()) throw new Error("Administrator identity is required");
  const db = commerceDb(env);
  const requestKey = values.requestKey ?? `legacy_${await hashOrderAccess(JSON.stringify(values))}`;
  const id = `ful_${await hashOrderAccess(`${values.orderId}:${requestKey}`)}`;
  const replay = async () => {
    const previous2 = await db.select().from(fulfillments).where(eq3(fulfillments.id, id)).get();
    if (!previous2) return null;
    if (previous2.kind !== "shipment" || previous2.note !== values.note || previous2.carrier !== values.carrier || previous2.trackingNumber !== values.trackingNumber || previous2.completesOrder !== (values.items ? false : values.completesOrder)) {
      throw new FulfillmentInputError("The shipment request key was already used with other details");
    }
    {
      const contents2 = await db.select().from(parcelContents).where(eq3(parcelContents.fulfillmentId, id)).get();
      const expected = values.items ? await parcelContentsValue(values.orderId, id, values.items, actor, values.note, "shipment") : null;
      if (!!contents2 !== !!expected || contents2 && expected && contents2.fingerprint !== expected.fingerprint) throw new FulfillmentInputError("Shipment key already used with other contents");
    }
    const current2 = await db.select({ status: orders.status, fulfillmentStatus: orders.fulfillmentStatus }).from(orders).where(eq3(orders.id, values.orderId)).get();
    return { fulfillmentId: previous2.id, orderId: values.orderId, ...current2, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const order = await db.select({
    status: orders.status,
    fulfillmentStatus: orders.fulfillmentStatus,
    paymentProvider: orders.paymentProvider
  }).from(orders).where(eq3(orders.id, values.orderId)).get();
  if (!order) throw new Error("Order not found");
  if ((order.paymentProvider ?? "stripe") === "admin_test") throw new Error("Admin test orders cannot be fulfilled");
  if (order.fulfillmentStatus === "fulfilled") throw new Error("Order has already shipped in full");
  if (!SHIPPABLE_STATUSES.includes(order.status)) throw new Error(`A ${order.status.replaceAll("_", " ")} order cannot ship`);
  const now = Math.floor(Date.now() / 1e3);
  const contents = values.items ? await parcelContentsValue(values.orderId, id, values.items, actor, values.note, "shipment") : null;
  if (contents && await db.select({ id: fulfillments.id }).from(fulfillments).where(sql2`${fulfillments.orderId} = ${values.orderId} AND ${fulfillments.kind} = 'shipment' AND NOT EXISTS (SELECT 1 FROM _ecommerce_parcel_contents p WHERE p.fulfillment_id = _ecommerce_fulfillments.id)`).get()) {
    throw new FulfillmentInputError("Record the contents of earlier parcels before shipping more items.");
  }
  try {
    await db.batch([
      db.insert(fulfillments).values({
        id,
        requestKey,
        orderId: values.orderId,
        kind: "shipment",
        completesOrder: contents ? false : values.completesOrder,
        adminActor: actor,
        carrier: values.carrier,
        trackingNumber: values.trackingNumber,
        note: values.note,
        createdAt: new Date(now * 1e3)
      }),
      ...contents ? [db.insert(parcelContents).values(contents)] : [],
      db.run(commerceEmailStatement("shipment", id, now))
    ]);
  } catch (cause) {
    const previous2 = await replay();
    if (previous2) return previous2;
    if (errorText(cause).includes("Parcel")) throw new Error("Parcel quantities exceed the order or earlier parcel contents are missing. Reload the order.");
    throw refusal(cause, "Order is not ready for fulfillment");
  }
  await deliverCommerceEmail(env, "shipment", id);
  const current = await db.select({ status: orders.status, fulfillmentStatus: orders.fulfillmentStatus }).from(orders).where(eq3(orders.id, values.orderId)).get();
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
  const db = commerceDb(env);
  const rows = await db.select({
    id: fulfillments.id,
    orderId: fulfillments.orderId,
    kind: fulfillments.kind,
    correctsId: fulfillments.correctsId,
    carrier: fulfillments.carrier,
    trackingNumber: fulfillments.trackingNumber,
    paymentProvider: orders.paymentProvider
  }).from(fulfillments).innerJoin(orders, eq3(orders.id, fulfillments.orderId)).where(eq3(fulfillments.orderId, db.select({ orderId: fulfillments.orderId }).from(fulfillments).where(eq3(fulfillments.id, values.fulfillmentId)))).orderBy(sql2`${fulfillments}.rowid`);
  const shipment = rows.find((row) => row.id === values.fulfillmentId);
  if (!shipment || shipment.kind !== "shipment") throw new Error("Shipment not found");
  if ((shipment.paymentProvider ?? "stripe") === "admin_test") throw new Error("Admin test orders cannot be fulfilled");
  const current = rows.filter((row) => row.correctsId === shipment.id).at(-1) ?? shipment;
  if ((current.carrier || null) === values.carrier && (current.trackingNumber || null) === values.trackingNumber) {
    throw new Error("The correction changes nothing");
  }
  const id = `ful_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1e3);
  try {
    await db.batch([
      db.insert(fulfillments).values({
        id,
        orderId: shipment.orderId,
        kind: "correction",
        correctsId: shipment.id,
        completesOrder: false,
        adminActor: actor,
        carrier: values.carrier,
        trackingNumber: values.trackingNumber,
        note: values.reason,
        createdAt: new Date(now * 1e3)
      }),
      // Only a live lease means the notice is being sent; after a stale one the notice carries the correction.
      db.run(commerceEmailStatement(
        "shipment_update",
        id,
        now,
        sql2`EXISTS (SELECT 1 FROM _ecommerce_email_deliveries WHERE kind = 'shipment' AND subject_id = ${shipment.id}
          AND (status = 'sent' OR (status = 'pending' AND claimed_at > ${now - COMMERCE_EMAIL_LEASE_SECONDS})))`
      ))
    ]);
  } catch (cause) {
    throw refusal(cause, "Shipment cannot be corrected");
  }
  await deliverCommerceEmail(env, "shipment_update", id);
  return {
    correctionId: id,
    fulfillmentId: shipment.id,
    orderId: shipment.orderId,
    carrier: values.carrier,
    trackingNumber: values.trackingNumber
  };
}
var progressSchema = z.object({
  orderId: z.string().trim().min(1).max(128),
  action: z.enum(["reopen", "complete"]),
  reason: z.string().trim().min(8).max(500),
  requestKey: z.string().trim().min(8).max(128)
}).strict();
async function adjustCommerceFulfillment(env, actor, input) {
  const values = parseInput(progressSchema, input);
  if (!actor.trim()) throw new FulfillmentInputError("Administrator identity is required");
  const db = commerceDb(env);
  const id = `ful_${await hashOrderAccess(`${values.orderId}:${values.requestKey}`)}`;
  const replay = async () => {
    const row = await db.select().from(fulfillments).where(eq3(fulfillments.id, id)).get();
    if (!row) return null;
    if (row.kind !== values.action || row.note !== values.reason) throw new FulfillmentInputError("Request key already used with other details");
    return { fulfillmentId: row.id, orderId: row.orderId, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  try {
    await db.insert(fulfillments).values({
      id,
      orderId: values.orderId,
      requestKey: values.requestKey,
      kind: values.action,
      note: values.reason,
      adminActor: actor,
      completesOrder: false,
      createdAt: /* @__PURE__ */ new Date()
    });
  } catch (cause) {
    const previous2 = await replay();
    if (previous2) return previous2;
    throw refusal(cause, "Fulfillment progress cannot be changed");
  }
  return { fulfillmentId: id, orderId: values.orderId, action: values.action };
}

export {
  deliverCommerceEmail,
  deliverPendingCommerceEmails,
  ORDERS_PAGE_SIZE,
  ORDERS_PAGE_MAX,
  FulfillmentInputError,
  listCommerceOrdersAdmin,
  fulfillCommerceOrder,
  correctCommerceFulfillment,
  adjustCommerceFulfillment
};
