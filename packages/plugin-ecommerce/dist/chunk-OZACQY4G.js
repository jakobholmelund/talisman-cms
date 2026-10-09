import {
  batchGroups,
  chunked,
  commerceDb,
  commitBatch,
  errorText
} from "./chunk-4WYWYY7J.js";
import {
  emailDeliveries,
  emailRecoveryDecisions,
  inspectionStock,
  orders,
  parcelContents,
  returnInspections,
  returnReceipts,
  returnStock,
  stockMovements,
  stocktakes
} from "./chunk-OMZRKOH6.js";
import {
  hashOrderAccess
} from "./chunk-NQUBOBQT.js";

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

// src/email-recovery.ts
import { z } from "zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

// src/admin-actors.ts
import { inArray } from "drizzle-orm";
import { user } from "talisman-cms/auth/local-schema";
async function adminActorNames(env, actorIds) {
  const db = commerceDb(env);
  const { users } = await batchGroups(db, { users: chunked([...new Set(actorIds)]).map((ids) => db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids))) });
  return new Map(users.map((row) => [row.id, row.name?.trim() || row.id]));
}

// src/email-recovery.ts
var CommerceOperationsConflict = class extends Error {
  name = "CommerceOperationsConflict";
};
var recoverableEmailSubject = sql`(
  (_ecommerce_email_deliveries.kind = 'order_confirmation' AND EXISTS (
    SELECT 1 FROM _ecommerce_orders o WHERE o.id = _ecommerce_email_deliveries.subject_id
      AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'
      AND o.status IN ('paid', 'fulfilled', 'partially_refunded', 'disputed')))
  OR (_ecommerce_email_deliveries.kind IN ('shipment', 'shipment_update') AND EXISTS (
    SELECT 1 FROM _ecommerce_fulfillments f JOIN _ecommerce_orders o ON o.id = f.order_id
      WHERE f.id = _ecommerce_email_deliveries.subject_id AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'
      AND ((_ecommerce_email_deliveries.kind = 'shipment' AND f.kind = 'shipment')
        OR (_ecommerce_email_deliveries.kind = 'shipment_update' AND f.kind = 'correction')))))`;
var pageSchema = z.object({ offset: z.coerce.number().int().min(0).max(1e6).default(0) });
async function listEmailRecovery(env, input = {}) {
  const { offset } = pageSchema.parse(input);
  const db = commerceDb(env);
  const attention = sql`${emailDeliveries.status} = 'failed' OR (${emailDeliveries.status} = 'pending' AND ${emailDeliveries.lastError} IS NOT NULL)`;
  const [rows, counted, history] = await db.batch([
    db.select({
      id: emailDeliveries.id,
      kind: emailDeliveries.kind,
      subjectId: emailDeliveries.subjectId,
      status: emailDeliveries.status,
      attempts: emailDeliveries.attempts,
      lastError: emailDeliveries.lastError,
      nextAttemptAt: emailDeliveries.nextAttemptAt,
      claimedAt: emailDeliveries.claimedAt,
      retryRequestId: emailDeliveries.retryRequestId,
      createdAt: emailDeliveries.createdAt,
      eligible: sql`CASE WHEN ${recoverableEmailSubject} THEN 1 ELSE 0 END`.mapWith(Boolean)
    }).from(emailDeliveries).where(attention).orderBy(emailDeliveries.createdAt, emailDeliveries.id).limit(50).offset(offset),
    db.select({ count: sql`count(*)`.mapWith(Number) }).from(emailDeliveries).where(attention),
    db.select({
      id: emailRecoveryDecisions.id,
      emailId: emailRecoveryDecisions.emailId,
      actor: emailRecoveryDecisions.actor,
      reason: emailRecoveryDecisions.reason,
      priorAttempts: emailRecoveryDecisions.priorAttempts,
      priorError: emailRecoveryDecisions.priorError,
      createdAt: emailRecoveryDecisions.createdAt
    }).from(emailRecoveryDecisions).orderBy(desc(emailRecoveryDecisions.createdAt), desc(emailRecoveryDecisions.id)).limit(50)
  ]);
  const names = await adminActorNames(env, history.map((row) => row.actor));
  return {
    rows: rows.map((row) => ({
      ...row,
      retryable: row.status === "failed" && row.claimedAt === null && row.eligible && !["recipient_suppressed", "invalid_recipient"].includes(row.lastError ?? ""),
      guidance: row.kind === "gift_card_claim" ? "Use Gift cards to resend a fresh claim link." : ["recipient_suppressed", "invalid_recipient"].includes(row.lastError ?? "") ? "Recipient cannot receive this email. Automatic retries have stopped." : !row.eligible ? "The order or shipment is no longer eligible for this notice." : row.claimedAt ? "A delivery lease is present. Wait for the sender to finish." : row.status === "pending" ? "The scheduled sender will retry this email automatically." : "Resolve the recorded error, then request a new delivery attempt."
    })),
    total: counted[0]?.count ?? 0,
    offset,
    history: history.map((row) => ({ ...row, actorName: names.get(row.actor) ?? row.actor }))
  };
}
var retrySchema = z.object({
  requestKey: z.string().uuid().transform((value) => value.toLowerCase()),
  emailId: z.string().min(1).max(128),
  reason: z.string().trim().refine((value) => [...value].length >= 8 && [...value].length <= 500),
  expectedAttempts: z.number().int().nonnegative(),
  expectedRetryId: z.string().max(128).nullable(),
  expectedError: z.string().max(128).nullable()
}).strict();
async function hash(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function retryCommerceEmail(env, input, actor) {
  const values = retrySchema.parse(input);
  const identity = z.string().trim().min(1).max(128).parse(actor);
  const { requestKey, ...details } = values;
  const id2 = await hash(`commerce-email-retry:${requestKey}`);
  const fingerprint = await hash(JSON.stringify(details));
  const db = commerceDb(env);
  async function receipt() {
    const decision = await db.select().from(emailRecoveryDecisions).where(eq(emailRecoveryDecisions.id, id2)).get();
    if (!decision) return null;
    if (decision.actor !== identity || decision.fingerprint !== fingerprint) {
      throw new CommerceOperationsConflict("This retry key belongs to different details or another administrator.");
    }
    const delivery = await db.select({
      status: emailDeliveries.status,
      attempts: emailDeliveries.attempts,
      lastError: emailDeliveries.lastError
    }).from(emailDeliveries).where(eq(emailDeliveries.id, decision.emailId)).get();
    return { decisionId: id2, emailId: decision.emailId, requestedAt: decision.createdAt, delivery };
  }
  const previous = await receipt();
  if (previous) return previous;
  const now = /* @__PURE__ */ new Date();
  await commitBatch(db, [
    db.update(emailDeliveries).set({
      status: "pending",
      attempts: 0,
      lastError: null,
      claimedAt: null,
      nextAttemptAt: now,
      retryRequestedAt: now,
      retryRequestId: id2
    }).where(and(
      eq(emailDeliveries.id, values.emailId),
      eq(emailDeliveries.status, "failed"),
      isNull(emailDeliveries.claimedAt),
      eq(emailDeliveries.attempts, values.expectedAttempts),
      values.expectedRetryId === null ? isNull(emailDeliveries.retryRequestId) : eq(emailDeliveries.retryRequestId, values.expectedRetryId),
      values.expectedError === null ? isNull(emailDeliveries.lastError) : eq(emailDeliveries.lastError, values.expectedError),
      sql`COALESCE(${emailDeliveries.lastError}, '') NOT IN ('recipient_suppressed', 'invalid_recipient')`,
      recoverableEmailSubject,
      sql`NOT EXISTS (SELECT 1 FROM _ecommerce_email_recovery_decisions WHERE id = ${id2})`
    )),
    db.run(sql`INSERT INTO _ecommerce_email_recovery_decisions
      (id, email_id, fingerprint, actor, reason, prior_attempts, prior_error, created_at)
      SELECT ${id2}, id, ${fingerprint}, ${identity}, ${values.reason}, ${values.expectedAttempts}, ${values.expectedError}, ${Math.floor(now.getTime() / 1e3)}
      FROM _ecommerce_email_deliveries WHERE id = ${values.emailId} AND retry_request_id = ${id2}
      ON CONFLICT(id) DO NOTHING`)
  ]);
  const result = await receipt();
  if (!result) throw new CommerceOperationsConflict("This email changed or cannot be retried. Reload its latest status.");
  return result;
}

// src/warehouse.ts
import { eq as eq2, sql as sql2 } from "drizzle-orm";
import { z as z2 } from "zod";
var id = z2.string().trim().min(1).max(128);
var reason = z2.string().trim().min(8).max(500);
var quantity = z2.number().int().min(1).max(1e6);
var stockVersion = z2.string().min(20).max(40).refine((s) => /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.0+)?Z$/.test(s) && Number.isSafeInteger(Date.parse(s)) && Date.parse(s) % 1e3 === 0, "Reload the exact stock version");
var parcelItemsSchema = z2.array(z2.object({ lineIndex: z2.number().int().min(0).max(199), quantity }).strict()).min(1).max(200).refine((items) => new Set(items.map((item) => item.lineIndex)).size === items.length, "Choose each order line once");
var contentsSchema = z2.object({ orderId: id, fulfillmentId: id, items: parcelItemsSchema, reason, requestKey: id.min(8) }).strict();
var intakeSchema = z2.object({ orderId: id, reason, requestKey: id.min(8), items: z2.array(z2.object({
  lineIndex: z2.number().int().min(0).max(199),
  quantity,
  condition: z2.enum(["sellable", "damaged", "inspection"]),
  restock: z2.boolean()
}).strict().refine((item) => !item.restock || item.condition === "sellable", "Only sellable goods can be restocked")).min(1).max(200).refine((items) => new Set(items.map((item) => item.lineIndex)).size === items.length, "Choose each order line once") }).strict();
var actorRequired = (actor) => {
  if (!actor.trim()) throw new CommerceOperationsConflict("Staff identity is required");
};
async function warehouseFingerprint(input, actor) {
  return hashOrderAccess(JSON.stringify({ input, actor }));
}
async function parcelContentsValue(orderId, fulfillmentId, items, actor, note, source = "backfill") {
  const sorted = [...items].sort((a, b) => a.lineIndex - b.lineIndex);
  return {
    id: `pcl_${fulfillmentId}`,
    orderId,
    fulfillmentId,
    items: sorted,
    source,
    actor,
    reason: note,
    fingerprint: await warehouseFingerprint({ orderId, fulfillmentId, items: sorted, reason: note, source }, actor),
    createdAt: /* @__PURE__ */ new Date()
  };
}
async function recordParcelContents(env, input, actor) {
  const values = contentsSchema.parse(input);
  actorRequired(actor);
  const record = await parcelContentsValue(values.orderId, values.fulfillmentId, values.items, actor, values.reason);
  const db = commerceDb(env);
  const replay = async () => {
    const previous2 = await db.select().from(parcelContents).where(eq2(parcelContents.fulfillmentId, values.fulfillmentId)).get();
    if (!previous2) return null;
    if (previous2.fingerprint !== record.fingerprint) throw new CommerceOperationsConflict("Contents already recorded with other details. Reload the order.");
    return { parcelId: previous2.id, orderId: previous2.orderId, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  try {
    await db.insert(parcelContents).values(record);
  } catch (cause) {
    const previous2 = await replay();
    if (previous2) return previous2;
    throw new CommerceOperationsConflict(errorText(cause).includes("Parcel") ? "Parcel quantities exceed this order or the shipment is unavailable. Reload the order." : "Contents could not be recorded. Reload the order.");
  }
  return { parcelId: record.id, orderId: record.orderId };
}
async function receiveOrderReturn(env, input, actor) {
  const parsed = intakeSchema.parse(input);
  actorRequired(actor);
  const values = { ...parsed, items: [...parsed.items].sort((a, b) => a.lineIndex - b.lineIndex) };
  const db = commerceDb(env), receiptId = `ret_${await hashOrderAccess(`${values.orderId}:${values.requestKey}`)}`;
  const fingerprint = await warehouseFingerprint(values, actor);
  const replay = async () => {
    const previous2 = await db.query.returnReceipts.findFirst({ where: { id: receiptId }, with: { stock: true } });
    if (!previous2) return null;
    if (previous2.fingerprint !== fingerprint) throw new CommerceOperationsConflict("This return key was used with other details.");
    return { receiptId, orderId: previous2.orderId, restocked: previous2.stock, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const order = await db.query.orders.findFirst({ where: { id: values.orderId }, with: { inventoryReservations: true, componentReservations: true } });
  if (!order || order.paymentProvider === "admin_test" || !["paid", "partially_refunded", "refunded", "disputed"].includes(order.status)) {
    throw new CommerceOperationsConflict("Only confirmed real purchases can receive returns.");
  }
  const restocked = returnDemand(order, values.items, receiptId).map((row) => ({ ...row, receiptId }));
  try {
    await db.batch([
      db.insert(returnReceipts).values({ id: receiptId, orderId: values.orderId, items: values.items, actor, reason: values.reason, fingerprint, createdAt: /* @__PURE__ */ new Date() }),
      ...restocked.map((row) => db.insert(returnStock).values(row))
    ]);
  } catch (cause) {
    const previous2 = await replay();
    if (previous2) return previous2;
    throw new CommerceOperationsConflict(errorText(cause).includes("Return") ? "Return quantities exceed the goods or stock still available to return. Reload the order." : "Return could not be recorded. Reload the order.");
  }
  return { receiptId, orderId: values.orderId, restocked };
}
function returnDemand(order, items, sourceId) {
  const demand = /* @__PURE__ */ new Map();
  for (const item of items) {
    const line = order.items[item.lineIndex];
    if (!line) throw new CommerceOperationsConflict("The order line is unavailable. Reload the order.");
    if (!item.restock) continue;
    if (!Array.isArray(line.stockTargets)) throw new CommerceOperationsConflict("This older order has no checkout stock mapping. Receive it without restocking, then reconcile its stock explicitly.");
    if (!line.stockTargets.length) throw new CommerceOperationsConflict("This item has no stock to restore. Receive it without restocking.");
    for (const target of line.stockTargets) {
      const key = `${target.type}:${target.id}`, current = demand.get(key);
      demand.set(key, { type: target.type, target: target.id, quantity: (current?.quantity ?? 0) + item.quantity * target.units });
    }
  }
  const restocked = [...demand.values()].map((target) => {
    const reservation = target.type === "component" ? order.componentReservations.find((r) => r.componentId === target.target) : order.inventoryReservations.find((r) => r.targetType === target.type && r.targetId === target.target);
    if (!reservation || reservation.releasedAt) throw new CommerceOperationsConflict("These units have already been restored or their stock hold is unavailable. Receive without restocking and reconcile the stock.");
    return {
      id: `${sourceId}_${reservation.id}`,
      orderId: order.id,
      reservationType: target.type === "component" ? "component" : "inventory",
      reservationId: reservation.id,
      targetType: target.type,
      targetId: target.target,
      quantity: target.quantity
    };
  });
  return restocked;
}
async function readOrderWarehouse(env, input) {
  const { orderId } = z2.object({ orderId: id }).strict().parse(input), db = commerceDb(env);
  const order = await db.query.orders.findFirst({ where: { id: orderId }, with: { parcelContents: true, returnReceipts: { with: { stock: true, inspections: { with: { stock: true } } } }, fulfillments: true } });
  if (!order || order.paymentProvider === "admin_test") throw new CommerceOperationsConflict("Order not found");
  const described = await describeOrderItems(env, order.items);
  const unrecorded = order.fulfillments.filter((row) => row.kind === "shipment" && !order.parcelContents.some((p) => p.fulfillmentId === row.id));
  const lines = described.map((line, lineIndex) => {
    const shipped = order.parcelContents.reduce((n, parcel) => n + (parcel.items.find((i) => i.lineIndex === lineIndex)?.quantity ?? 0), 0);
    const received = order.returnReceipts.reduce((n, receipt) => n + (receipt.items.find((i) => i.lineIndex === lineIndex)?.quantity ?? 0), 0);
    return {
      lineIndex,
      quantity: line.quantity,
      name: [line.productName || line.productId, line.variantLabel].filter(Boolean).join(" / "),
      sku: line.sku,
      shipped,
      received,
      remaining: unrecorded.length ? null : Math.max(0, line.quantity - shipped),
      returnable: Math.max(0, (unrecorded.length ? line.quantity : shipped) - received),
      restockMapped: Array.isArray(order.items[lineIndex].stockTargets) && !!order.items[lineIndex].stockTargets?.length
    };
  });
  const names = await adminActorNames(env, [...order.parcelContents.map((p) => p.actor), ...order.returnReceipts.flatMap((r) => [r.actor, ...r.inspections.map((i) => i.actor)])]);
  return {
    orderId,
    status: order.status,
    fulfillmentStatus: order.fulfillmentStatus,
    lines,
    unrecorded: unrecorded.map((p) => ({ id: p.id, createdAt: p.createdAt.toISOString(), note: p.note })),
    parcels: order.parcelContents.map((p) => ({ ...p, actorName: names.get(p.actor) ?? p.actor, createdAt: p.createdAt.toISOString() })),
    returns: order.returnReceipts.map((r) => ({
      ...r,
      actorName: names.get(r.actor) ?? r.actor,
      createdAt: r.createdAt.toISOString(),
      inspectionPending: r.items.filter((i) => i.condition === "inspection").map((i) => ({ lineIndex: i.lineIndex, quantity: i.quantity - r.inspections.reduce((n, decision) => n + (decision.items.find((j) => j.lineIndex === i.lineIndex)?.quantity ?? 0), 0) })),
      inspections: r.inspections.map((i) => ({ ...i, actorName: names.get(i.actor) ?? i.actor, createdAt: i.createdAt.toISOString() }))
    })),
    shippingAddress: order.shippingAddress,
    canReceive: ["paid", "partially_refunded", "refunded", "disputed"].includes(order.status)
  };
}
var movementSchema = z2.object({
  requestKey: id.min(8),
  targetType: z2.enum(["product", "variant", "stock", "component"]),
  targetId: id,
  kind: z2.enum(["receipt", "correction"]),
  delta: z2.number().int().min(-1e6).max(1e6).refine((n) => n !== 0),
  expectedQuantity: z2.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedUpdatedAt: stockVersion,
  reason
}).strict().refine((v) => v.kind !== "receipt" || v.delta > 0, "Incoming stock must be positive");
async function recordStockMovement(env, input, actor) {
  const values = movementSchema.parse(input);
  actorRequired(actor);
  if (!Number.isSafeInteger(values.expectedQuantity + values.delta) || values.expectedQuantity + values.delta < 0) throw new CommerceOperationsConflict("The change would leave a negative or invalid stock count.");
  const db = commerceDb(env), movementId = `mov_${await hashOrderAccess(values.requestKey)}`, fingerprint = await warehouseFingerprint(values, actor);
  const replay = async () => {
    const previous2 = await db.select().from(stockMovements).where(eq2(stockMovements.id, movementId)).get();
    if (!previous2) return null;
    if (previous2.fingerprint !== fingerprint) throw new CommerceOperationsConflict("This stock request key was used with other details.");
    return { movementId, before: previous2.beforeQuantity, after: previous2.afterQuantity, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  try {
    await db.insert(stockMovements).values({
      id: movementId,
      targetType: values.targetType,
      targetId: values.targetId,
      kind: values.kind,
      delta: values.delta,
      beforeQuantity: values.expectedQuantity,
      afterQuantity: values.expectedQuantity + values.delta,
      expectedUpdatedAt: new Date(values.expectedUpdatedAt),
      actor,
      reason: values.reason,
      fingerprint,
      createdAt: /* @__PURE__ */ new Date()
    });
  } catch {
    const previous2 = await replay();
    if (previous2) return previous2;
    throw new CommerceOperationsConflict("Stock changed or the stock record is unavailable. Reload before recording this change.");
  }
  return { movementId, before: values.expectedQuantity, after: values.expectedQuantity + values.delta };
}
var locations = sql2`WITH locations AS (
 SELECT 'product' AS type, id, name, sku, inventory_quantity AS quantity, updated_at AS updated FROM _ecommerce_products WHERE type = 'standard'
 UNION ALL SELECT 'variant', g.id, p.name || ' / ' || g.name, g.sku, g.inventory_quantity, g.updated_at FROM _ecommerce_product_variants g JOIN _ecommerce_products p ON p.id = g.product_id WHERE p.type = 'standard'
 UNION ALL SELECT 'stock', s.id, p.name || ' / ' || g.name || ' / ' || v.value, v.sku, s.quantity, s.updated_at FROM _ecommerce_stocks s JOIN _ecommerce_product_variant_values v ON v.id = s.product_variant_value_id JOIN _ecommerce_product_variants g ON g.id = v.product_variant_id JOIN _ecommerce_products p ON p.id = g.product_id
 UNION ALL SELECT 'component', id, name, sku, quantity, updated_at FROM _ecommerce_components
)`;
async function listStockLocations(env, input = {}) {
  const v = z2.object({ search: z2.string().trim().max(100).default(""), offset: z2.coerce.number().int().min(0).max(1e6).default(0) }).strict().parse(input);
  const pattern = `%${v.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, db = commerceDb(env);
  const where = sql2`(name LIKE ${pattern} ESCAPE '\\' OR COALESCE(sku, '') LIKE ${pattern} ESCAPE '\\')`;
  const [rows, total] = await db.batch([
    db.all(sql2`${locations} SELECT * FROM locations WHERE ${where} ORDER BY name, type, id LIMIT 50 OFFSET ${v.offset}`),
    db.all(sql2`${locations} SELECT count(*) n FROM locations WHERE ${where}`)
  ]);
  return { ...v, total: total[0]?.n ?? 0, rows: rows.map((row) => ({ ...row, updatedAt: new Date(row.updated * 1e3).toISOString() })) };
}
async function readStockHistory(env, input) {
  const v = z2.object({ targetType: z2.enum(["product", "variant", "stock", "component"]), targetId: id, offset: z2.coerce.number().int().min(0).max(1e6).default(0) }).strict().parse(input);
  const db = commerceDb(env);
  const history = sql2`WITH inventory_events AS (
    SELECT r.id, 'checkout_hold' AS kind, -r.quantity AS delta, NULL AS beforeQuantity, NULL AS afterQuantity, NULL AS actor, 'Checkout stock reservation' AS reason, o.created_at AS createdAt, r.order_id AS orderId FROM _ecommerce_inventory_reservations r JOIN _ecommerce_orders o ON o.id = r.order_id WHERE r.target_type = ${v.targetType} AND r.target_id = ${v.targetId}
    UNION ALL SELECT id || '_release', 'checkout_release', quantity, NULL, NULL, NULL, 'Cancelled checkout stock release', released_at, order_id FROM _ecommerce_inventory_reservations r WHERE target_type = ${v.targetType} AND target_id = ${v.targetId} AND released_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM _ecommerce_restocks s WHERE s.reservation_type = 'inventory' AND s.reservation_id = r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_stock s WHERE s.reservation_type = 'inventory' AND s.reservation_id = r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_inspection_stock s WHERE s.reservation_type = 'inventory' AND s.reservation_id = r.id)
  ), component_events AS (
    SELECT r.id, 'checkout_hold' AS kind, -r.quantity AS delta, NULL AS beforeQuantity, NULL AS afterQuantity, NULL AS actor, 'Checkout component reservation' AS reason, o.created_at AS createdAt, r.order_id AS orderId FROM _ecommerce_component_reservations r JOIN _ecommerce_orders o ON o.id = r.order_id WHERE ${v.targetType} = 'component' AND r.component_id = ${v.targetId}
    UNION ALL SELECT id || '_release', 'checkout_release', quantity, NULL, NULL, NULL, 'Cancelled checkout component release', released_at, order_id FROM _ecommerce_component_reservations r WHERE ${v.targetType} = 'component' AND component_id = ${v.targetId} AND released_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM _ecommerce_restocks s WHERE s.reservation_type = 'component' AND s.reservation_id = r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_stock s WHERE s.reservation_type = 'component' AND s.reservation_id = r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_inspection_stock s WHERE s.reservation_type = 'component' AND s.reservation_id = r.id)
  ), returned_events AS (
    SELECT s.id, 'return' AS kind, s.quantity AS delta, NULL AS beforeQuantity, NULL AS afterQuantity, r.actor, r.reason, r.created_at AS createdAt, s.order_id AS orderId FROM _ecommerce_return_stock s JOIN _ecommerce_return_receipts r ON r.id = s.receipt_id WHERE s.target_type = ${v.targetType} AND s.target_id = ${v.targetId}
    UNION ALL SELECT s.id, 'inspection', s.quantity, NULL, NULL, i.actor, i.reason, i.created_at, s.order_id FROM _ecommerce_inspection_stock s JOIN _ecommerce_return_inspections i ON i.id = s.inspection_id WHERE s.target_type = ${v.targetType} AND s.target_id = ${v.targetId}
  ), history AS (
    SELECT id, kind, delta, before_quantity AS beforeQuantity, after_quantity AS afterQuantity, actor, reason, created_at AS createdAt, NULL AS orderId
      FROM _ecommerce_stock_movements WHERE target_type = ${v.targetType} AND target_id = ${v.targetId}
    UNION ALL SELECT * FROM returned_events
    UNION ALL SELECT id, 'restock', quantity, NULL, NULL, admin_actor, reason, created_at, order_id FROM _ecommerce_restocks WHERE target_type = ${v.targetType} AND target_id = ${v.targetId}
    UNION ALL SELECT * FROM inventory_events
    UNION ALL SELECT * FROM component_events
  )`;
  const [rows, total] = await db.batch([
    db.all(sql2`${history} SELECT * FROM history ORDER BY createdAt DESC, id DESC LIMIT 50 OFFSET ${v.offset}`),
    db.all(sql2`${history} SELECT count(*) n FROM history`)
  ]);
  const names = await adminActorNames(env, rows.flatMap((row) => row.actor ? [row.actor] : []));
  return { ...v, total: total[0]?.n ?? 0, rows: rows.map((row) => ({ ...row, actorName: row.actor ? names.get(row.actor) ?? row.actor : null, createdAt: new Date(row.createdAt * 1e3).toISOString() })) };
}
var inspectionSchema = z2.object({
  orderId: id,
  receiptId: id,
  requestKey: id.min(8),
  reason,
  items: z2.array(z2.object({
    lineIndex: z2.number().int().min(0).max(199),
    quantity,
    disposition: z2.enum(["sellable", "quarantine", "damaged"]),
    restock: z2.boolean()
  }).strict().refine((i) => !i.restock || i.disposition === "sellable", "Only approved sellable units can be restocked")).min(1).max(200).refine((items) => new Set(items.map((i) => i.lineIndex)).size === items.length, "Choose each line once")
}).strict();
async function inspectOrderReturn(env, input, actor) {
  const v = inspectionSchema.parse(input);
  actorRequired(actor);
  const inspectionId = `ins_${await hashOrderAccess(`${v.orderId}:${v.requestKey}`)}`, fingerprint = await warehouseFingerprint(v, actor), db = commerceDb(env);
  const replay = async () => {
    const previous2 = await db.query.returnInspections.findFirst({ where: { id: inspectionId }, with: { stock: true } });
    if (!previous2) return null;
    if (previous2.fingerprint !== fingerprint) throw new CommerceOperationsConflict("This inspection key was used with other details.");
    return { inspectionId, orderId: previous2.orderId, restocked: previous2.stock, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const order = await db.query.orders.findFirst({ where: { id: v.orderId }, with: { inventoryReservations: true, componentReservations: true } });
  if (!order || order.paymentProvider === "admin_test") throw new CommerceOperationsConflict("Order not found");
  const restocked = returnDemand(order, v.items, inspectionId).map((row) => ({ ...row, inspectionId }));
  try {
    await db.batch([
      db.insert(returnInspections).values({ id: inspectionId, receiptId: v.receiptId, orderId: v.orderId, items: v.items, actor, reason: v.reason, fingerprint, createdAt: /* @__PURE__ */ new Date() }),
      ...restocked.map((row) => db.insert(inspectionStock).values(row))
    ]);
  } catch {
    const previous2 = await replay();
    if (previous2) return previous2;
    throw new CommerceOperationsConflict("Inspection quantities or stock changed. Reload the order before reviewing these goods.");
  }
  return { inspectionId, orderId: v.orderId, restocked };
}
var countSchema = z2.number().int().min(0).max(1e6);
var stocktakeSchema = z2.object({ requestKey: id.min(8), reason, lines: z2.array(z2.object({
  targetType: z2.enum(["product", "variant", "stock", "component"]),
  targetId: id,
  expectedQuantity: countSchema,
  expectedUpdatedAt: stockVersion,
  countedQuantity: countSchema
}).strict()).min(1).max(50).refine((lines) => new Set(lines.map((l) => `${l.targetType}:${l.targetId}`)).size === lines.length, "Count each stock record once") }).strict();
async function recordStocktake(env, input, actor) {
  const v = stocktakeSchema.parse(input);
  actorRequired(actor);
  const stocktakeId = `cnt_${await hashOrderAccess(v.requestKey)}`, fingerprint = await warehouseFingerprint(v, actor), db = commerceDb(env);
  const replay = async () => {
    const previous2 = await db.select().from(stocktakes).where(eq2(stocktakes.id, stocktakeId)).get();
    if (!previous2) return null;
    if (previous2.fingerprint !== fingerprint) throw new CommerceOperationsConflict("This stocktake key was used with other details.");
    return { stocktakeId, lines: previous2.lines, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const snapshot = await readStocktakeTargets(env, { targets: v.lines.map((l) => ({ targetType: l.targetType, targetId: l.targetId })) });
  const lines = v.lines.map((l) => {
    const row = snapshot.rows.find((r) => r.type === l.targetType && r.id === l.targetId);
    return { ...l, expectedUpdatedSeconds: Date.parse(l.expectedUpdatedAt) / 1e3, name: row?.name ?? "Unavailable stock record", sku: row?.sku ?? null };
  });
  const now = /* @__PURE__ */ new Date();
  try {
    await db.batch([
      db.insert(stocktakes).values({ id: stocktakeId, lines, actor, reason: v.reason, fingerprint, createdAt: now }),
      ...v.lines.filter((l) => l.countedQuantity !== l.expectedQuantity).map((l, n) => db.insert(stockMovements).values({
        id: `${stocktakeId}_${n}`,
        targetType: l.targetType,
        targetId: l.targetId,
        kind: "correction",
        delta: l.countedQuantity - l.expectedQuantity,
        beforeQuantity: l.expectedQuantity,
        afterQuantity: l.countedQuantity,
        expectedUpdatedAt: new Date(l.expectedUpdatedAt),
        actor,
        reason: `Stocktake: ${v.reason}`,
        fingerprint,
        createdAt: now
      }))
    ]);
  } catch {
    const previous2 = await replay();
    if (previous2) return previous2;
    throw new CommerceOperationsConflict("Stock changed during this count. No counts were applied. Reload and review every discrepancy.");
  }
  return { stocktakeId, lines };
}
async function listStocktakes(env, input = {}) {
  const v = z2.object({ offset: z2.coerce.number().int().min(0).max(1e6).default(0) }).strict().parse(input), db = commerceDb(env);
  const [rows, totals] = await db.batch([
    db.select().from(stocktakes).orderBy(sql2`${stocktakes.createdAt} DESC, ${stocktakes.id} DESC`).limit(20).offset(v.offset),
    db.select({ n: sql2`count(*)` }).from(stocktakes)
  ]);
  const names = await adminActorNames(env, rows.map((r) => r.actor));
  return { ...v, total: totals[0]?.n ?? 0, rows: rows.map((r) => ({ ...r, actorName: names.get(r.actor) ?? r.actor, createdAt: r.createdAt.toISOString() })) };
}
async function readStocktakeTargets(env, input) {
  const v = z2.object({ targets: z2.array(z2.object({ targetType: z2.enum(["product", "variant", "stock", "component"]), targetId: id }).strict()).min(1).max(50).refine((t) => new Set(t.map((i) => `${i.targetType}:${i.targetId}`)).size === t.length, "Choose each record once") }).strict().parse(input);
  const where = sql2.join(v.targets.map((t) => sql2`(type = ${t.targetType} AND id = ${t.targetId})`), sql2` OR `);
  const rows = await commerceDb(env).all(sql2`${locations} SELECT * FROM locations WHERE ${where}`);
  return { rows: rows.map((row) => ({ ...row, updatedAt: new Date(row.updated * 1e3).toISOString() })) };
}

export {
  orderAmountColumns,
  orderAmounts,
  describeOrderItems,
  adminActorNames,
  CommerceOperationsConflict,
  listEmailRecovery,
  retryCommerceEmail,
  parcelItemsSchema,
  parcelContentsValue,
  recordParcelContents,
  receiveOrderReturn,
  readOrderWarehouse,
  recordStockMovement,
  listStockLocations,
  readStockHistory,
  inspectOrderReturn,
  recordStocktake,
  listStocktakes,
  readStocktakeTargets
};
