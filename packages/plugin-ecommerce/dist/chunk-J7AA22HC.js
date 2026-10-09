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
} from "./chunk-6OI6C5UV.js";
import {
  batchGroups,
  chunked,
  commerceDb,
  commitBatch,
  errorText
} from "./chunk-7BTUQQDZ.js";
import {
  creditLedger,
  emailDeliveries,
  emailRecoveryDecisions,
  fulfillments,
  giftCardLedger,
  inspectionStock,
  orders,
  parcelContents,
  restocks,
  returnInspections,
  returnReceipts,
  returnRequestReceipts,
  returnStock,
  stockMovements,
  stocktakes
} from "./chunk-KLQ2VU7R.js";
import {
  hashOrderAccess
} from "./chunk-NQUBOBQT.js";
import {
  orderConfirmationEmail,
  returnNoticeEmail,
  returnRefundEmail,
  shipmentEmail
} from "./chunk-QVPX4QWC.js";

// src/warehouse.ts
import { eq as eq2, sql as sql2 } from "drizzle-orm";
import { z as z2 } from "zod";

// src/admin-actors.ts
import { inArray } from "drizzle-orm";
import { user } from "talisman-cms/auth/local-schema";
async function adminActorNames(env, actorIds) {
  const db = commerceDb(env);
  const { users } = await batchGroups(db, { users: chunked([...new Set(actorIds)]).map((ids) => db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids))) });
  return new Map(users.map((row) => [row.id, row.name?.trim() || row.id]));
}

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
var CommerceOperationsConflict = class extends Error {
  name = "CommerceOperationsConflict";
};
var recoverableEmailSubject = sql`(
  (_ecommerce_email_deliveries.kind = 'order_confirmation' AND EXISTS (
    SELECT 1 FROM _ecommerce_orders o WHERE o.id = _ecommerce_email_deliveries.subject_id
      AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'
      AND o.status IN ('paid', 'fulfilled', 'partially_refunded', 'disputed')))
  OR (_ecommerce_email_deliveries.kind='return_refund' AND EXISTS(SELECT 1 FROM _ecommerce_return_refund_decisions d JOIN _ecommerce_return_receipts r ON r.id=d.receipt_id JOIN _ecommerce_orders o ON o.id=r.order_id WHERE d.id=_ecommerce_email_deliveries.subject_id AND d.status='settled' AND d.redacted_at IS NULL AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND o.customer_email IS NOT NULL AND NOT EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a WHERE a.account_id=o.user_id AND a.action='anonymize')))
  OR (_ecommerce_email_deliveries.kind='return_received' AND EXISTS(SELECT 1 FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE r.id=_ecommerce_email_deliveries.subject_id AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND o.customer_email IS NOT NULL))
  OR (_ecommerce_email_deliveries.kind='return_decision' AND EXISTS(SELECT 1 FROM _ecommerce_return_request_events e JOIN _ecommerce_return_requests r ON r.id=e.request_id JOIN _ecommerce_orders o ON o.id=r.order_id WHERE e.id=_ecommerce_email_deliveries.subject_id AND e.actor_kind='staff' AND e.redacted_at IS NULL AND r.redacted_at IS NULL AND e.rowid=(SELECT rowid FROM _ecommerce_return_request_events WHERE request_id=r.id ORDER BY rowid DESC LIMIT 1) AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND o.customer_email IS NOT NULL))
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
var id = z2.string().trim().min(1).max(128);
var reason = z2.string().trim().min(8).max(500);
var quantity = z2.number().int().min(1).max(1e6);
var stockVersion = z2.string().min(20).max(40).refine((s) => /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.0+)?Z$/.test(s) && Number.isSafeInteger(Date.parse(s)) && Date.parse(s) % 1e3 === 0, "Reload the exact stock version");
var parcelItemsSchema = z2.array(z2.object({ lineIndex: z2.number().int().min(0).max(199), quantity }).strict()).min(1).max(200).refine((items) => new Set(items.map((item) => item.lineIndex)).size === items.length, "Choose each order line once");
var contentsSchema = z2.object({ orderId: id, fulfillmentId: id, items: parcelItemsSchema, reason, requestKey: id.min(8) }).strict();
var intakeSchema = z2.object({ orderId: id, returnRequestId: id.optional(), reason, requestKey: id.min(8), items: z2.array(z2.object({
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
      ...restocked.map((row) => db.insert(returnStock).values(row)),
      ...values.returnRequestId ? [db.insert(returnRequestReceipts).values({ receiptId, requestId: values.returnRequestId })] : [],
      db.run(commerceEmailStatement("return_received", receiptId, Math.floor(Date.now() / 1e3)))
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

// src/order-activity.ts
import { and as and2, eq as eq3, inArray as inArray2 } from "drizzle-orm";
async function loadOrderActivity(env, orderIds) {
  const db = commerceDb(env);
  const groups = chunked(orderIds);
  const { stock, gift, credit, parcels, confirmations, contents, returns, inspections, requests, refundCases } = await batchGroups(db, {
    requests: groups.map((ids) => db.query.returnRequests.findMany({ where: { orderId: { in: ids } }, columns: { id: true, orderId: true }, with: { events: { columns: { id: true } } } })),
    refundCases: groups.map((ids) => db.query.returnReceipts.findMany({ where: { orderId: { in: ids } }, columns: { id: true, orderId: true }, with: { refundDecisions: true } })),
    inspections: groups.map((ids) => db.select().from(returnInspections).where(inArray2(returnInspections.orderId, ids))),
    contents: groups.map((ids) => db.select().from(parcelContents).where(inArray2(parcelContents.orderId, ids))),
    returns: groups.map((ids) => db.select().from(returnReceipts).where(inArray2(returnReceipts.orderId, ids))),
    stock: groups.map((ids) => db.select().from(restocks).where(inArray2(restocks.orderId, ids))),
    gift: groups.map((ids) => db.select().from(giftCardLedger).where(and2(inArray2(giftCardLedger.orderId, ids), eq3(giftCardLedger.kind, "refund_restore")))),
    credit: groups.map((ids) => db.select().from(creditLedger).where(and2(inArray2(creditLedger.orderId, ids), eq3(creditLedger.kind, "purchase_credit_refund")))),
    parcels: groups.map((ids) => db.select().from(fulfillments).where(inArray2(fulfillments.orderId, ids))),
    confirmations: groups.map((ids) => db.select().from(emailDeliveries).where(and2(inArray2(emailDeliveries.subjectId, ids), eq3(emailDeliveries.kind, "order_confirmation"))))
  });
  const { notices } = await batchGroups(db, { notices: chunked(parcels.map((row) => row.id)).map((ids) => db.select().from(emailDeliveries).where(and2(inArray2(emailDeliveries.subjectId, ids), inArray2(emailDeliveries.kind, ["shipment", "shipment_update"])))) });
  const { returnNotices } = await batchGroups(db, { returnNotices: chunked([...returns.map((r) => r.id), ...refundCases.flatMap((r) => r.refundDecisions.map((d) => d.id)), ...requests.flatMap((r) => r.events.map((e) => e.id))]).map((ids) => db.select().from(emailDeliveries).where(and2(inArray2(emailDeliveries.subjectId, ids), inArray2(emailDeliveries.kind, ["return_decision", "return_received", "return_refund"])))) });
  const names = await adminActorNames(env, [...stock, ...parcels].map((row) => row.adminActor).concat([...contents, ...returns, ...inspections, ...refundCases.flatMap((r) => r.refundDecisions)].map((row) => row.actor)));
  const parcelOrders = new Map([...parcels, ...returns].map((row) => [row.id, row.orderId]));
  for (const r of refundCases) for (const d of r.refundDecisions) parcelOrders.set(d.id, r.orderId);
  for (const r of requests) for (const e of r.events) parcelOrders.set(e.id, r.orderId);
  const activity = /* @__PURE__ */ new Map();
  function add(orderId, event) {
    activity.set(orderId, [...activity.get(orderId) ?? [], event]);
  }
  const base = (id2, kind, createdAt, detail) => ({
    id: id2,
    kind,
    createdAt: createdAt.toISOString(),
    detail,
    actor: null,
    actorName: null,
    amountCents: null,
    email: null
  });
  for (const r of refundCases) for (const d of r.refundDecisions) add(r.orderId, { ...base(d.id, "return_refund_decision", d.createdAt, `${d.status}: ${d.reason}`), actor: d.actor, actorName: names.get(d.actor) ?? d.actor, amountCents: d.amountMinor });
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
  for (const row of [...confirmations, ...notices, ...returnNotices]) {
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
import { and as and4, asc, count, desc as desc2, eq as eq5, sql as sql4 } from "drizzle-orm";
import { z as z3 } from "zod";

// src/commerce-emails.ts
import { and as and3, eq as eq4, inArray as inArray3, lte, sql as sql3 } from "drizzle-orm";
var at = (seconds) => new Date(seconds * 1e3);
var storedItems = (items) => Array.isArray(items) ? items.filter((item) => typeof item?.productId === "string") : [];
var orderOfFulfillment = (db, fulfillmentId) => db.select({ orderId: fulfillments.orderId }).from(fulfillments).where(eq4(fulfillments.id, fulfillmentId));
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
  }).from(orders).where(eq4(orders.id, orderId)).get();
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
    }).from(fulfillments).where(eq4(fulfillments.orderId, orderOfFulfillment(db, fulfillmentId))).orderBy(sql3`rowid`);
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
    }).from(orders).where(eq4(orders.id, shipment.orderId)).get();
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
function returnComposer(received) {
  return async (env, subjectId, setup) => {
    const db = commerceDb(env);
    const event = received ? null : await db.query.returnRequestEvents.findFirst({ where: { id: subjectId }, with: { request: { with: { order: true, events: { orderBy: (_t, { sql: sql5 }) => sql5`rowid` } } } } });
    const receipt = received ? await db.query.returnReceipts.findFirst({ where: { id: subjectId }, with: { order: true } }) : null;
    const order = receipt?.order ?? event?.request.order;
    if (!order || order.paymentProvider === "admin_test") return { cancel: "not_found" };
    if (event && (event.actorKind !== "staff" || event.redactedAt || event.request.redactedAt || event.request.events.at(-1)?.id !== event.id || !["approved", "declined", "closed"].includes(event.status))) return { cancel: "not_due" };
    const to = bareEmailAddress(order.customerEmail);
    if (!to) return { fail: "invalid_recipient" };
    const lines = receipt?.items ?? event.request.items;
    const described = await describeOrderItems(env, lines.map((i) => ({ ...order.items[i.lineIndex], quantity: i.quantity })));
    const email = {
      store: setup.store,
      orderId: order.id,
      occurredAt: (receipt ?? event).createdAt,
      status: receipt ? "received" : event.status,
      message: receipt ? "We have received the items listed below. Receipt of goods does not confirm a refund. We will review your return separately." : event.customerMessage,
      items: described.map((i) => ({ name: [i.productName || "Ordered item", i.variantLabel].filter(Boolean).join(" / "), quantity: i.quantity }))
    };
    return { to, message: await applyEmailTemplate(setup, "returnNotice", email, returnNoticeEmail(email)) };
  };
}
var composeReturnRefund = async (env, subjectId, setup) => {
  const db = commerceDb(env), decision = await db.query.returnRefundDecisions.findFirst({ where: { id: subjectId }, with: { receipt: { with: { order: true } } } });
  if (!decision || decision.status !== "settled" || decision.redactedAt || decision.receipt.order.paymentProvider === "admin_test") return { cancel: "not_due" };
  const order = decision.receipt.order;
  const erased = await db.get(sql3`SELECT count(*) AS n FROM _ecommerce_shopper_audits WHERE account_id=${order.userId} AND action='anonymize'`);
  if (erased?.n) return { cancel: "not_due" };
  const to = bareEmailAddress(order.customerEmail);
  if (!to) return { cancel: "not_due" };
  const labels = { provider: "Original payment method", gift_card: "Gift card", store_credit: "Store credit" }, sums = /* @__PURE__ */ new Map();
  for (const a of decision.allocations) sums.set(a.kind, (sums.get(a.kind) ?? 0) + a.amountMinor);
  const email = { store: setup.store, orderId: order.id, occurredAt: decision.createdAt, currency: order.currency, amountMinor: decision.amountMinor, tenders: [...sums].map(([kind, amountMinor]) => ({ label: labels[kind], amountMinor })) };
  return { to, message: await applyEmailTemplate(setup, "returnRefund", email, returnRefundEmail(email)) };
};
var COMPOSERS = {
  order_confirmation: composeOrderConfirmation,
  shipment: shipmentComposer(false),
  shipment_update: shipmentComposer(true),
  gift_card_claim: composeGiftCardClaimEmail,
  return_refund: composeReturnRefund,
  return_decision: returnComposer(false),
  return_received: returnComposer(true)
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
  const pending = sql3`${emailDeliveries.status} = 'pending'`;
  const oldest = db.select({ id: emailDeliveries.id }).from(emailDeliveries).where(and3(pending, sql3`COALESCE(${emailDeliveries.retryRequestedAt}, ${emailDeliveries.createdAt}) < ${now - COMMERCE_EMAIL_MAX_AGE_SECONDS}`, unclaimedAt(now))).orderBy(emailDeliveries.createdAt).limit(count2);
  const expired = await db.update(emailDeliveries).set({ status: "failed", lastError: "expired", claimedAt: null }).where(inArray3(emailDeliveries.id, oldest)).returning({ kind: emailDeliveries.kind, subjectId: emailDeliveries.subjectId });
  for (const row of expired) {
    results.push({ id: `${row.kind}:${row.subjectId}`, status: "error", error: "Email was not sent within 7 days and was given up" });
  }
  const due = (kinds2) => db.select({ kind: emailDeliveries.kind, subjectId: emailDeliveries.subjectId }).from(emailDeliveries).where(and3(pending, lte(emailDeliveries.nextAttemptAt, at(now)), unclaimedAt(now), sql3`+${emailDeliveries.kind} IN ${kinds2}`)).orderBy(emailDeliveries.nextAttemptAt, emailDeliveries.createdAt, sql3`${emailDeliveries.kind} <> 'order_confirmation'`, emailDeliveries.id).limit(count2);
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
var REAL_ORDER = sql4`COALESCE(${orders.paymentProvider}, 'stripe') <> 'admin_test'`;
var VIEWS = {
  // Every real order that can still ship, oldest first.
  awaiting: { where: sql4`${orders.status} IN ('paid','partially_refunded') AND ${orders.fulfillmentStatus} <> 'fulfilled' AND ${REAL_ORDER}`, ascending: true },
  // Real orders past checkout, newest first.
  recent: { where: sql4`${orders.status} NOT IN ('pending','cancelled','draft') AND ${REAL_ORDER}`, ascending: false }
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
var optionalText = (max) => z3.string().trim().max(max).nullish().transform((value) => value || null);
var listSchema = z3.object({
  view: z3.enum(["awaiting", "recent"]).default("awaiting"),
  // Room for an order id of about 3,000 ASCII characters; checkout writes ids of 40.
  cursor: z3.string().max(4096).nullish(),
  limit: z3.number().int().min(1).max(ORDERS_PAGE_MAX).default(ORDERS_PAGE_SIZE),
  query: z3.string().trim().max(254).nullish()
}).strict();
var shipmentSchema = z3.object({
  orderId: z3.string().regex(/^ord_[0-9a-f-]{36}$/),
  carrier: optionalText(100),
  trackingNumber: optionalText(150),
  note: z3.string().trim().min(8).max(500),
  completesOrder: z3.boolean().default(true),
  items: parcelItemsSchema.optional(),
  requestKey: z3.string().trim().min(8).max(128).optional()
}).strict();
var correctionSchema = z3.object({
  fulfillmentId: z3.string().trim().min(1).max(128),
  carrier: optionalText(100),
  trackingNumber: optionalText(150),
  reason: z3.string().trim().min(8).max(500)
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
    const [cursorView, createdAt, id2] = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (cursorView === view && Number.isSafeInteger(createdAt) && typeof id2 === "string") {
      return [createdAt, id2];
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
      orderBy: (_table, { sql: sql5 }) => sql5`rowid`
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
    conditions.push(eq5(sql4`lower(${orders.customerEmail})`, values.query.toLowerCase()));
  } else if (values.query) {
    conditions.push(eq5(orders.id, values.query));
  }
  if (values.cursor) {
    const [createdAt, id2] = decodeCursor(values.view, values.cursor);
    conditions.push(view.ascending ? sql4`(${orders.createdAt}, ${orders.id}) > (${createdAt}, ${id2})` : sql4`(${orders.createdAt}, ${orders.id}) < (${createdAt}, ${id2})`);
  }
  const direction = view.ascending ? asc : desc2;
  const db = commerceDb(env);
  const [[counted], found] = await db.batch([
    db.select({ count: count() }).from(orders).where(VIEWS.awaiting.where),
    db.select(orderColumns).from(orders).where(and4(...conditions)).orderBy(direction(orders.createdAt), direction(orders.id)).limit(values.limit + 1)
  ]);
  const rows = found.slice(0, values.limit);
  const storedItems2 = rows.map((row) => Array.isArray(row.items) ? row.items.filter((item) => typeof item?.productId === "string") : []);
  const described = await describeOrderItems(env, storedItems2.flat());
  const shipments = await loadShipments(env, rows.map((row) => row.id));
  const { events } = await batchGroups(db, { events: chunked(rows.map((row) => row.id)).map((ids) => db.query.fulfillments.findMany({
    columns: { id: true, orderId: true, kind: true, note: true, adminActor: true, createdAt: true },
    where: { orderId: { in: ids }, kind: { in: ["reopen", "complete"] } },
    orderBy: (_row, { sql: sql5 }) => sql5`rowid`
  })) });
  const activity = await loadOrderActivity(env, rows.map((row) => row.id));
  let offset = 0;
  const orders3 = rows.map((row, index) => {
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
    orders: orders3
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
  const id2 = `ful_${await hashOrderAccess(`${values.orderId}:${requestKey}`)}`;
  const replay = async () => {
    const previous2 = await db.select().from(fulfillments).where(eq5(fulfillments.id, id2)).get();
    if (!previous2) return null;
    if (previous2.kind !== "shipment" || previous2.note !== values.note || previous2.carrier !== values.carrier || previous2.trackingNumber !== values.trackingNumber || previous2.completesOrder !== (values.items ? false : values.completesOrder)) {
      throw new FulfillmentInputError("The shipment request key was already used with other details");
    }
    {
      const contents2 = await db.select().from(parcelContents).where(eq5(parcelContents.fulfillmentId, id2)).get();
      const expected = values.items ? await parcelContentsValue(values.orderId, id2, values.items, actor, values.note, "shipment") : null;
      if (!!contents2 !== !!expected || contents2 && expected && contents2.fingerprint !== expected.fingerprint) throw new FulfillmentInputError("Shipment key already used with other contents");
    }
    const current2 = await db.select({ status: orders.status, fulfillmentStatus: orders.fulfillmentStatus }).from(orders).where(eq5(orders.id, values.orderId)).get();
    return { fulfillmentId: previous2.id, orderId: values.orderId, ...current2, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const order = await db.select({
    status: orders.status,
    fulfillmentStatus: orders.fulfillmentStatus,
    paymentProvider: orders.paymentProvider
  }).from(orders).where(eq5(orders.id, values.orderId)).get();
  if (!order) throw new Error("Order not found");
  if ((order.paymentProvider ?? "stripe") === "admin_test") throw new Error("Admin test orders cannot be fulfilled");
  if (order.fulfillmentStatus === "fulfilled") throw new Error("Order has already shipped in full");
  if (!SHIPPABLE_STATUSES.includes(order.status)) throw new Error(`A ${order.status.replaceAll("_", " ")} order cannot ship`);
  const now = Math.floor(Date.now() / 1e3);
  const contents = values.items ? await parcelContentsValue(values.orderId, id2, values.items, actor, values.note, "shipment") : null;
  if (contents && await db.select({ id: fulfillments.id }).from(fulfillments).where(sql4`${fulfillments.orderId} = ${values.orderId} AND ${fulfillments.kind} = 'shipment' AND NOT EXISTS (SELECT 1 FROM _ecommerce_parcel_contents p WHERE p.fulfillment_id = _ecommerce_fulfillments.id)`).get()) {
    throw new FulfillmentInputError("Record the contents of earlier parcels before shipping more items.");
  }
  try {
    await db.batch([
      db.insert(fulfillments).values({
        id: id2,
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
      db.run(commerceEmailStatement("shipment", id2, now))
    ]);
  } catch (cause) {
    const previous2 = await replay();
    if (previous2) return previous2;
    if (errorText(cause).includes("Parcel")) throw new Error("Parcel quantities exceed the order or earlier parcel contents are missing. Reload the order.");
    throw refusal(cause, "Order is not ready for fulfillment");
  }
  await deliverCommerceEmail(env, "shipment", id2);
  const current = await db.select({ status: orders.status, fulfillmentStatus: orders.fulfillmentStatus }).from(orders).where(eq5(orders.id, values.orderId)).get();
  return {
    fulfillmentId: id2,
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
  }).from(fulfillments).innerJoin(orders, eq5(orders.id, fulfillments.orderId)).where(eq5(fulfillments.orderId, db.select({ orderId: fulfillments.orderId }).from(fulfillments).where(eq5(fulfillments.id, values.fulfillmentId)))).orderBy(sql4`${fulfillments}.rowid`);
  const shipment = rows.find((row) => row.id === values.fulfillmentId);
  if (!shipment || shipment.kind !== "shipment") throw new Error("Shipment not found");
  if ((shipment.paymentProvider ?? "stripe") === "admin_test") throw new Error("Admin test orders cannot be fulfilled");
  const current = rows.filter((row) => row.correctsId === shipment.id).at(-1) ?? shipment;
  if ((current.carrier || null) === values.carrier && (current.trackingNumber || null) === values.trackingNumber) {
    throw new Error("The correction changes nothing");
  }
  const id2 = `ful_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1e3);
  try {
    await db.batch([
      db.insert(fulfillments).values({
        id: id2,
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
        id2,
        now,
        sql4`EXISTS (SELECT 1 FROM _ecommerce_email_deliveries WHERE kind = 'shipment' AND subject_id = ${shipment.id}
          AND (status = 'sent' OR (status = 'pending' AND claimed_at > ${now - COMMERCE_EMAIL_LEASE_SECONDS})))`
      ))
    ]);
  } catch (cause) {
    throw refusal(cause, "Shipment cannot be corrected");
  }
  await deliverCommerceEmail(env, "shipment_update", id2);
  return {
    correctionId: id2,
    fulfillmentId: shipment.id,
    orderId: shipment.orderId,
    carrier: values.carrier,
    trackingNumber: values.trackingNumber
  };
}
var progressSchema = z3.object({
  orderId: z3.string().trim().min(1).max(128),
  action: z3.enum(["reopen", "complete"]),
  reason: z3.string().trim().min(8).max(500),
  requestKey: z3.string().trim().min(8).max(128)
}).strict();
async function adjustCommerceFulfillment(env, actor, input) {
  const values = parseInput(progressSchema, input);
  if (!actor.trim()) throw new FulfillmentInputError("Administrator identity is required");
  const db = commerceDb(env);
  const id2 = `ful_${await hashOrderAccess(`${values.orderId}:${values.requestKey}`)}`;
  const replay = async () => {
    const row = await db.select().from(fulfillments).where(eq5(fulfillments.id, id2)).get();
    if (!row) return null;
    if (row.kind !== values.action || row.note !== values.reason) throw new FulfillmentInputError("Request key already used with other details");
    return { fulfillmentId: row.id, orderId: row.orderId, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  try {
    await db.insert(fulfillments).values({
      id: id2,
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
  return { fulfillmentId: id2, orderId: values.orderId, action: values.action };
}

export {
  describeOrderItems,
  deliverCommerceEmail,
  deliverPendingCommerceEmails,
  adminActorNames,
  CommerceOperationsConflict,
  listEmailRecovery,
  retryCommerceEmail,
  warehouseFingerprint,
  recordParcelContents,
  receiveOrderReturn,
  readOrderWarehouse,
  recordStockMovement,
  listStockLocations,
  readStockHistory,
  inspectOrderReturn,
  recordStocktake,
  listStocktakes,
  readStocktakeTargets,
  ORDERS_PAGE_SIZE,
  ORDERS_PAGE_MAX,
  FulfillmentInputError,
  listCommerceOrdersAdmin,
  fulfillCommerceOrder,
  correctCommerceFulfillment,
  adjustCommerceFulfillment
};
