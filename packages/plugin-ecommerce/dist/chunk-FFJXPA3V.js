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
} from "./chunk-4LBJN5LU.js";
import {
  batchGroups,
  chunked,
  commerceDb,
  errorText
} from "./chunk-ZI5IJOR6.js";
import {
  emailDeliveries,
  fulfillments,
  orders
} from "./chunk-NKJTK7MK.js";
import {
  orderConfirmationEmail,
  shipmentEmail
} from "./chunk-NMGICNSV.js";

// src/fulfillment.ts
import { and as and2, asc, count, desc, eq as eq2, sql as sql2 } from "drizzle-orm";
import { z } from "zod";

// src/order-items.ts
var orderAmountColumns = {
  subtotalAmount: orders.subtotalAmount,
  discountCode: orders.discountCode,
  discountAmount: orders.discountAmount,
  creditApplied: orders.creditApplied,
  shippingAmount: orders.shippingAmount,
  shippingLabel: orders.shippingLabel,
  taxAmount: orders.taxAmount,
  taxBehavior: orders.taxBehavior,
  giftCardApplied: orders.giftCardApplied,
  totalAmount: orders.totalAmount,
  providerRefundedCents: orders.providerRefundedCents,
  giftCardRefundedCents: orders.giftCardRefundedCents
};
function orderAmounts(row) {
  const amounts = [{ key: "itemsSubtotal", label: "Items subtotal", cents: row.subtotalAmount || row.totalAmount }];
  if (row.discountAmount > 0) {
    amounts.push({ key: "discount", label: row.discountCode ? `Discount (${row.discountCode})` : "Discount", cents: -row.discountAmount });
  }
  if (row.creditApplied > 0) amounts.push({ key: "storeCredit", label: "Store credit", cents: -row.creditApplied });
  if (row.shippingAmount > 0 || row.shippingLabel) {
    amounts.push({ key: "shipping", label: row.shippingLabel ? `Shipping (${row.shippingLabel})` : "Shipping", cents: row.shippingAmount });
  }
  if (row.taxAmount > 0) {
    amounts.push(row.taxBehavior === "inclusive" ? { key: "taxIncluded", label: "Tax included in the prices", cents: row.taxAmount } : { key: "tax", label: "Tax", cents: row.taxAmount });
  }
  if (row.giftCardApplied > 0) amounts.push({ key: "giftCard", label: "Gift card", cents: -row.giftCardApplied });
  amounts.push({ key: "charged", label: "Charged by the payment provider", cents: row.totalAmount });
  if (row.providerRefundedCents > 0) {
    amounts.push({ key: "providerRefunded", label: "Refunded by the payment provider", cents: row.providerRefundedCents });
  }
  if (row.giftCardRefundedCents > 0) {
    amounts.push({ key: "giftCardRefunded", label: "Refunded to the gift card", cents: row.giftCardRefundedCents });
  }
  return amounts;
}
async function describeOrderItems(env, items) {
  const db = commerceDb(env);
  const productIds = [...new Set(items.map((item) => item.productId))];
  const variantIds = [...new Set(items.flatMap((item) => item.variantId ? [item.variantId] : []))];
  const rows = await batchGroups(db, {
    products: chunked(productIds).map((ids) => db.query.products.findMany({
      columns: { id: true, name: true, sku: true },
      where: { id: { in: ids } }
    })),
    values: chunked(variantIds).map((ids) => db.query.productVariantValues.findMany({
      columns: { id: true, value: true, sku: true },
      where: { id: { in: ids } },
      with: { productVariant: { columns: { name: true, sku: true }, with: { variant: { columns: { name: true } } } } }
    })),
    // A variant group without values is sold as itself.
    groups: chunked(variantIds).map((ids) => db.query.productVariants.findMany({
      columns: { id: true, name: true, sku: true },
      where: { id: { in: ids } }
    }))
  });
  const products = new Map(rows.products.map((row) => [row.id, row]));
  const values = new Map(rows.values.map((row) => [row.id, row]));
  const groups = new Map(rows.groups.map((row) => [row.id, row]));
  return items.map((item) => {
    const product = products.get(item.productId);
    const value = item.variantId ? values.get(item.variantId) : void 0;
    const group = item.variantId && !value ? groups.get(item.variantId) : void 0;
    return {
      ...item,
      productName: product?.name ?? null,
      variantLabel: value ? `${value.productVariant.variant?.name ?? value.productVariant.name}: ${value.value}` : group?.name ?? null,
      sku: (value ? value.sku || value.productVariant.sku : group?.sku) || product?.sku || null
    };
  });
}

// src/commerce-emails.ts
import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
var at = (seconds) => new Date(seconds * 1e3);
var storedItems = (items) => Array.isArray(items) ? items.filter((item) => typeof item?.productId === "string") : [];
var orderOfFulfillment = (db, fulfillmentId) => db.select({ orderId: fulfillments.orderId }).from(fulfillments).where(eq(fulfillments.id, fulfillmentId));
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
  }).from(orders).where(eq(orders.id, orderId)).get();
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
    }).from(fulfillments).where(eq(fulfillments.orderId, orderOfFulfillment(db, fulfillmentId))).orderBy(sql`rowid`);
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
      createdAt: orders.createdAt
    }).from(orders).where(eq(orders.id, shipment.orderId)).get();
    if (!order || (order.paymentProvider ?? "stripe") === "admin_test") return { cancel: "not_found" };
    const to = bareEmailAddress(order.customerEmail);
    if (!to) return { fail: "invalid_recipient" };
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
  const oldest = db.select({ id: emailDeliveries.id }).from(emailDeliveries).where(and(pending, lt(emailDeliveries.createdAt, at(now - COMMERCE_EMAIL_MAX_AGE_SECONDS)), unclaimedAt(now))).orderBy(emailDeliveries.createdAt).limit(count2);
  const expired = await db.update(emailDeliveries).set({ status: "failed", lastError: "expired", claimedAt: null }).where(inArray(emailDeliveries.id, oldest)).returning({ kind: emailDeliveries.kind, subjectId: emailDeliveries.subjectId });
  for (const row of expired) {
    results.push({ id: `${row.kind}:${row.subjectId}`, status: "error", error: "Email was not sent within 7 days and was given up" });
  }
  const due = (kinds2) => db.select({ kind: emailDeliveries.kind, subjectId: emailDeliveries.subjectId }).from(emailDeliveries).where(and(pending, lte(emailDeliveries.nextAttemptAt, at(now)), unclaimedAt(now), sql`+${emailDeliveries.kind} IN ${kinds2}`)).orderBy(emailDeliveries.nextAttemptAt, emailDeliveries.createdAt, sql`${emailDeliveries.kind} <> 'order_confirmation'`, emailDeliveries.id).limit(count2);
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
      orderBy: (_table, { sql: sql3 }) => sql3`rowid`
    }))
  });
  const shipments = /* @__PURE__ */ new Map();
  const byOrder = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (row.kind === "shipment") {
      const shipment2 = {
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        adminActor: row.adminActor,
        note: row.note,
        completesOrder: row.completesOrder,
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
    conditions.push(eq2(sql2`lower(${orders.customerEmail})`, values.query.toLowerCase()));
  } else if (values.query) {
    conditions.push(eq2(orders.id, values.query));
  }
  if (values.cursor) {
    const [createdAt, id] = decodeCursor(values.view, values.cursor);
    conditions.push(view.ascending ? sql2`(${orders.createdAt}, ${orders.id}) > (${createdAt}, ${id})` : sql2`(${orders.createdAt}, ${orders.id}) < (${createdAt}, ${id})`);
  }
  const direction = view.ascending ? asc : desc;
  const db = commerceDb(env);
  const [[counted], found] = await db.batch([
    db.select({ count: count() }).from(orders).where(VIEWS.awaiting.where),
    db.select(orderColumns).from(orders).where(and2(...conditions)).orderBy(direction(orders.createdAt), direction(orders.id)).limit(values.limit + 1)
  ]);
  const rows = found.slice(0, values.limit);
  const storedItems2 = rows.map((row) => Array.isArray(row.items) ? row.items.filter((item) => typeof item?.productId === "string") : []);
  const described = await describeOrderItems(env, storedItems2.flat());
  const shipments = await loadShipments(env, rows.map((row) => row.id));
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
      amounts: orderAmounts(row),
      shipments: shipments.get(row.id) ?? []
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
    await db.batch([
      db.insert(fulfillments).values({
        id,
        orderId: values.orderId,
        kind: "shipment",
        completesOrder: values.completesOrder,
        adminActor: actor,
        carrier: values.carrier,
        trackingNumber: values.trackingNumber,
        note: values.note,
        createdAt: new Date(now * 1e3)
      }),
      db.run(commerceEmailStatement("shipment", id, now))
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
  const db = commerceDb(env);
  const rows = await db.select({
    id: fulfillments.id,
    orderId: fulfillments.orderId,
    kind: fulfillments.kind,
    correctsId: fulfillments.correctsId,
    carrier: fulfillments.carrier,
    trackingNumber: fulfillments.trackingNumber,
    paymentProvider: orders.paymentProvider
  }).from(fulfillments).innerJoin(orders, eq2(orders.id, fulfillments.orderId)).where(eq2(fulfillments.orderId, db.select({ orderId: fulfillments.orderId }).from(fulfillments).where(eq2(fulfillments.id, values.fulfillmentId)))).orderBy(sql2`${fulfillments}.rowid`);
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
