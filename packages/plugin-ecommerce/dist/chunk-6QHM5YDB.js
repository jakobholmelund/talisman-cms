import {
  commerceContext,
  loadBasketCatalog,
  requireVariantChoice,
  resolveSelectedVariant
} from "./chunk-NXQCYUOX.js";
import {
  CommerceOperationsConflict,
  adminActorNames,
  describeOrderItems,
  readOrderWarehouse,
  warehouseFingerprint
} from "./chunk-J7AA22HC.js";
import {
  commerceEmailStatement,
  readStoreCurrency
} from "./chunk-6OI6C5UV.js";
import {
  commerceDb,
  commitBatch,
  errorText
} from "./chunk-7BTUQQDZ.js";
import {
  RECOVERY_KINDS,
  REFUND_SOURCE_KINDS,
  RESTOCK_TARGET_TYPES,
  RETURN_REFUND_STATUSES,
  SUPPLIER_ISSUE_KINDS,
  SUPPLIER_ISSUE_STATUSES,
  orders,
  purchaseOrderEvents,
  purchaseOrderLines,
  purchaseOrders,
  recoveryCases,
  recoveryEvents,
  recoveryShipments,
  replenishmentDeliveries,
  replenishmentDeliveryEvents,
  replenishmentPolicies,
  returnRefundDecisions,
  shopperAudits,
  stockMovements,
  supplierIssueEvents,
  supplierIssues,
  supplierRevisions,
  suppliers
} from "./chunk-KLQ2VU7R.js";
import {
  hashOrderAccess
} from "./chunk-NQUBOBQT.js";

// src/recoveries.ts
import { eq as eq2, sql as sql2 } from "drizzle-orm";
import { z as z2 } from "zod";

// src/replenishment.ts
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
var id = z.string().trim().min(1).max(128);
var reason = z.string().trim().min(8).max(500);
var quantity = z.number().int().min(0).max(1e6);
var target = { targetType: z.enum(RESTOCK_TARGET_TYPES), targetId: id };
var physicalStockLocations = sql`SELECT 'product' AS type,id,name,sku,inventory_quantity AS quantity,updated_at AS updated FROM _ecommerce_products WHERE type='standard'
 UNION ALL SELECT 'variant',v.id,p.name||' / '||v.name,v.sku,v.inventory_quantity,v.updated_at FROM _ecommerce_product_variants v JOIN _ecommerce_products p ON p.id=v.product_id WHERE p.type='standard'
 UNION ALL SELECT 'stock',s.id,p.name||' / '||v.name||' / '||x.value,x.sku,s.quantity,s.updated_at FROM _ecommerce_stocks s JOIN _ecommerce_product_variant_values x ON x.id=s.product_variant_value_id JOIN _ecommerce_product_variants v ON v.id=x.product_variant_id JOIN _ecommerce_products p ON p.id=v.product_id
 UNION ALL SELECT 'component',id,name,sku,quantity,updated_at FROM _ecommerce_components`;
var cte = sql`WITH physical AS (${physicalStockLocations}), locations AS (SELECT *,1 AS available FROM physical UNION ALL SELECT d.target_type,d.target_id,'Unavailable stock · '||d.target_id,NULL,0,0,0 FROM _ecommerce_replenishment_deliveries d WHERE NOT EXISTS(SELECT 1 FROM physical p WHERE p.type=d.target_type AND p.id=d.target_id) GROUP BY d.target_type,d.target_id), planned AS (SELECT l.*,
 (SELECT id FROM _ecommerce_replenishment_policies p WHERE p.target_type=l.type AND p.target_id=l.id ORDER BY rowid DESC LIMIT 1) AS policyVersion,
 COALESCE((SELECT sum(MAX(0,d.quantity-COALESCE((SELECT sum(m.delta) FROM _ecommerce_replenishment_delivery_events e JOIN _ecommerce_stock_movements m ON m.id=e.movement_id WHERE e.delivery_id=d.id),0))) FROM _ecommerce_replenishment_deliveries d WHERE d.target_type=l.type AND d.target_id=l.id AND NOT EXISTS(SELECT 1 FROM _ecommerce_replenishment_delivery_events e WHERE e.delivery_id=d.id AND e.kind='cancelled')),0) AS incoming FROM locations l),
 plans AS (SELECT l.*,p.minimum_quantity AS minimumQuantity,p.target_quantity AS targetQuantity,COALESCE(p.enabled,0) AS enabled,
 CASE WHEN p.enabled=1 AND l.quantity<=p.minimum_quantity THEN MAX(0,p.target_quantity-l.quantity-l.incoming) ELSE 0 END AS suggested FROM planned l LEFT JOIN _ecommerce_replenishment_policies p ON p.id=l.policyVersion)`;
var effectiveDeliveryDate = sql`COALESCE((SELECT e.expected_date FROM _ecommerce_purchase_order_lines l JOIN _ecommerce_purchase_order_events e ON e.purchase_order_id=l.purchase_order_id WHERE l.delivery_id=d.id ORDER BY e.rowid DESC LIMIT 1),d.expected_date)`;
var location = (r) => ({ type: r.type, id: r.id, name: r.name, sku: r.sku, quantity: r.quantity, updatedAt: new Date(r.updated * 1e3).toISOString(), minimumQuantity: r.minimumQuantity, targetQuantity: r.targetQuantity, enabled: !!r.enabled, incoming: r.incoming, suggested: r.suggested, policyVersion: r.policyVersion });
async function listReplenishment(env, input = {}) {
  const v = z.object({ offset: z.coerce.number().int().min(0).max(1e6).default(0), search: z.string().trim().max(100).default(""), filter: z.enum(["suggested", "configured", "incoming", "all"]).default("suggested") }).strict().parse(input), db = commerceDb(env);
  const pattern = `%${v.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, where = sql`(name LIKE ${pattern} ESCAPE '\\' OR COALESCE(sku,'') LIKE ${pattern} ESCAPE '\\') AND (${v.filter}='all' OR (${v.filter}='incoming' AND incoming>0) OR (${v.filter}='configured' AND policyVersion IS NOT NULL) OR (${v.filter}='suggested' AND suggested>0))`;
  const [rows, count] = await db.batch([db.all(sql`${cte} SELECT * FROM plans WHERE ${where} ORDER BY suggested DESC,name,type,id LIMIT 50 OFFSET ${v.offset}`), db.all(sql`${cte} SELECT count(*) n FROM plans WHERE ${where}`)]);
  return { ...v, total: count[0]?.n ?? 0, rows: rows.map(location) };
}
async function readReplenishment(env, input) {
  const v = z.object({ ...target, deliveryOffset: z.coerce.number().int().min(0).max(1e6).default(0) }).strict().parse(input), db = commerceDb(env);
  const [row, policies, deliveries, deliveryCount] = await Promise.all([db.get(sql`${cte} SELECT * FROM plans WHERE type=${v.targetType} AND id=${v.targetId}`), db.query.replenishmentPolicies.findMany({ where: { targetType: v.targetType, targetId: v.targetId }, orderBy: (_t, { sql: sql10 }) => sql10`rowid DESC`, limit: 50 }), db.query.replenishmentDeliveries.findMany({ where: { targetType: v.targetType, targetId: v.targetId }, orderBy: { createdAt: "desc", id: "desc" }, limit: 50, offset: v.deliveryOffset, with: { events: { orderBy: (_t, { sql: sql10 }) => sql10`rowid`, with: { movement: { columns: { delta: true } } } } } }), db.select({ n: sql`count(*)`.mapWith(Number) }).from(replenishmentDeliveries).where(sql`${replenishmentDeliveries.targetType}=${v.targetType} AND ${replenishmentDeliveries.targetId}=${v.targetId}`).get()]);
  const dates = await db.all(sql`SELECT d.id,${effectiveDeliveryDate} AS expectedDate FROM _ecommerce_replenishment_deliveries d WHERE d.target_type=${v.targetType} AND d.target_id=${v.targetId} ORDER BY d.created_at DESC,d.id DESC LIMIT 50 OFFSET ${v.deliveryOffset}`);
  const effectiveDates = new Map(dates.map((d) => [d.id, d.expectedDate]));
  const names = await adminActorNames(env, [...policies.map((p) => p.actor), ...deliveries.flatMap((d) => [d.actor, ...d.events.map((e) => e.actor)])]);
  return { ...v, deliveryTotal: deliveryCount?.n ?? 0, location: row?.available ? location(row) : null, policies: policies.map(({ fingerprint, ...p }) => ({ ...p, createdAt: p.createdAt.toISOString(), actorName: names.get(p.actor) ?? p.actor })), deliveries: deliveries.map(({ fingerprint, events, ...d }) => {
    const received = events.reduce((n, e) => n + (e.movement?.delta ?? 0), 0), cancelled = events.some((e) => e.kind === "cancelled");
    return { ...d, expectedDate: effectiveDates.get(d.id) ?? d.expectedDate, createdAt: d.createdAt.toISOString(), actorName: names.get(d.actor) ?? d.actor, received, remaining: cancelled ? 0 : d.quantity - received, cancelled, version: events.at(-1)?.id ?? d.id, events: events.map((e) => ({ id: e.id, kind: e.kind, quantity: e.movement?.delta ?? 0, actorName: names.get(e.actor) ?? e.actor, reason: e.reason, createdAt: e.createdAt.toISOString() })) };
  }) };
}
var policySchema = z.object({ ...target, requestKey: id.min(8), expectedVersion: id.nullable(), minimumQuantity: quantity, targetQuantity: quantity, enabled: z.boolean(), reason }).strict().refine((v) => v.targetQuantity >= v.minimumQuantity);
var planSchema = z.object({ ...target, requestKey: id.min(8), quantity: quantity.min(1), supplier: z.string().trim().min(1).max(200), reference: z.string().trim().max(200), expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && (/* @__PURE__ */ new Date(`${v}T00:00:00Z`)).toISOString().slice(0, 10) === v), reason }).strict();
var eventSchema = z.object({ deliveryId: id, requestKey: id.min(8), expectedVersion: id, kind: z.enum(["received", "cancelled"]), quantity: quantity.optional(), expectedQuantity: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), expectedUpdatedAt: z.string().datetime({ offset: true }).optional(), reason }).strict().refine((v) => v.kind === "cancelled" ? v.quantity === void 0 && v.expectedQuantity === void 0 && v.expectedUpdatedAt === void 0 : !!v.quantity && v.expectedQuantity !== void 0 && !!v.expectedUpdatedAt);
async function identity(input, actor, prefix) {
  if (!actor.trim()) throw new CommerceOperationsConflict("An authenticated staff member is required.");
  const v = input;
  return { id: `${prefix}_${await hashOrderAccess(v.requestKey)}`, fingerprint: await hashOrderAccess(JSON.stringify({ input, actor })) };
}
async function saveReplenishmentPolicy(env, input, actor) {
  const v = policySchema.parse(input), db = commerceDb(env), ident = await identity(v, actor, "rpl");
  const replay = async () => {
    const row = await db.select().from(replenishmentPolicies).where(eq(replenishmentPolicies.id, ident.id)).get();
    if (!row) return null;
    if (row.fingerprint !== ident.fingerprint) throw new CommerceOperationsConflict("This planning key was used with other details.");
    return { policyId: row.id, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  try {
    const { requestKey, ...fields } = v;
    await db.insert(replenishmentPolicies).values({ ...fields, ...ident, actor, createdAt: /* @__PURE__ */ new Date() });
  } catch (error) {
    const previous2 = await replay();
    if (previous2) return previous2;
    if (!errorText(error).includes("Replenishment")) throw error;
    throw new CommerceOperationsConflict("Stock target or policy changed. Refresh before saving.");
  }
  return { policyId: ident.id };
}
async function planReplenishmentDelivery(env, input, actor) {
  const v = planSchema.parse(input), db = commerceDb(env), ident = await identity(v, actor, "rpd");
  const replay = async () => {
    const row = await db.select().from(replenishmentDeliveries).where(eq(replenishmentDeliveries.id, ident.id)).get();
    if (!row) return null;
    if (row.fingerprint !== ident.fingerprint) throw new CommerceOperationsConflict("This delivery key was used with other details.");
    return { deliveryId: row.id, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  try {
    const { requestKey, ...fields } = v;
    await db.insert(replenishmentDeliveries).values({ ...fields, ...ident, actor, createdAt: /* @__PURE__ */ new Date() });
  } catch (error) {
    const previous2 = await replay();
    if (previous2) return previous2;
    if (!errorText(error).includes("Replenishment")) throw error;
    throw new CommerceOperationsConflict("This stock target is unavailable. Refresh before planning.");
  }
  return { deliveryId: ident.id };
}
async function recordReplenishmentDelivery(env, input, actor) {
  const v = eventSchema.parse(input), db = commerceDb(env), ident = await identity(v, actor, "rpe");
  const replay = async () => {
    const row = await db.select().from(replenishmentDeliveryEvents).where(eq(replenishmentDeliveryEvents.id, ident.id)).get();
    if (!row) return null;
    if (row.fingerprint !== ident.fingerprint) throw new CommerceOperationsConflict("This delivery receipt key was used with other details.");
    return { eventId: row.id, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const delivery = await db.select().from(replenishmentDeliveries).where(eq(replenishmentDeliveries.id, v.deliveryId)).get();
  if (!delivery) throw new CommerceOperationsConflict("Delivery plan not found.");
  const movementId = v.kind === "received" ? `mov_${ident.id}` : null, now = /* @__PURE__ */ new Date();
  if (v.kind === "received" && !Number.isSafeInteger(v.expectedQuantity + v.quantity)) throw new CommerceOperationsConflict("Stock quantity would be invalid.");
  try {
    await commitBatch(db, [
      ...movementId ? [db.insert(stockMovements).values({ id: movementId, targetType: delivery.targetType, targetId: delivery.targetId, kind: "receipt", delta: v.quantity, beforeQuantity: v.expectedQuantity, afterQuantity: v.expectedQuantity + v.quantity, expectedUpdatedAt: new Date(v.expectedUpdatedAt), actor, reason: v.reason, fingerprint: ident.fingerprint, createdAt: now })] : [],
      db.insert(replenishmentDeliveryEvents).values({ ...ident, deliveryId: v.deliveryId, kind: v.kind, movementId, expectedVersion: v.expectedVersion, actor, reason: v.reason, createdAt: now })
    ]);
  } catch (error) {
    const previous2 = await replay();
    if (previous2) return previous2;
    if (!/Stock|stock|Replenishment/.test(errorText(error))) throw error;
    throw new CommerceOperationsConflict("Delivery or stock changed. Reload current quantities before receiving or cancelling.");
  }
  return { eventId: ident.id };
}

// src/recoveries.ts
var id2 = z2.string().trim().min(1).max(128);
var reason2 = z2.string().trim().min(8).max(500);
var units = z2.number().int().min(1).max(1e6);
var line = z2.number().int().min(0).max(199);
var timestamp = z2.string().refine((s) => Number.isSafeInteger(Date.parse(s)) && Date.parse(s) % 1e3 === 0, "Reload the stock version");
var report = z2.object({
  orderId: id2,
  kind: z2.enum(RECOVERY_KINDS),
  fulfillmentId: id2.nullable().default(null),
  sourceShipmentId: id2.nullable().default(null),
  receiptId: id2.nullable().default(null),
  lineIndex: line,
  quantity: units,
  productId: id2.optional(),
  variantId: id2.nullable().optional(),
  requestKey: id2.min(8),
  reason: reason2
}).strict();
var openRecoveryCase = sql2`COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),'open')='open'`;
var actorRequired = (actor) => {
  if (!actor.trim()) throw new CommerceOperationsConflict("An authenticated staff member is required.");
};
function targets(target2) {
  const totals = /* @__PURE__ */ new Map();
  for (const t of target2.stockTargets) {
    if (!RESTOCK_TARGET_TYPES.includes(t.type) || !t.id || !Number.isSafeInteger(t.units) || t.units <= 0) throw new CommerceOperationsConflict("The frozen stock mapping is unavailable.");
    const key2 = `${t.type}:${t.id}`, old = totals.get(key2);
    totals.set(key2, { ...t, units: t.units + (old?.units ?? 0) });
  }
  if (totals.size > 50) throw new CommerceOperationsConflict("This replacement needs more than 50 stock pools.");
  return { ...target2, stockTargets: [...totals.values()].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)) };
}
async function write(fn, replay) {
  try {
    await fn();
  } catch (e) {
    const old = await replay();
    if (old) return old;
    if (!/Recovery|Stock |stock_movement|UNIQUE constraint|Refund follow-up/.test(errorText(e))) throw e;
    throw new CommerceOperationsConflict("The case, payment, returned quantities or stock changed. Refresh before continuing.");
  }
  return null;
}
async function createRecoveryCase(env, input, actor) {
  const v = report.parse(input);
  actorRequired(actor);
  const db = commerceDb(env), caseId = `rec_${await hashOrderAccess(`${v.orderId}:${v.requestKey}`)}`, fingerprint = await warehouseFingerprint(v, actor);
  const replay = async () => {
    const old = await db.select().from(recoveryCases).where(eq2(recoveryCases.id, caseId)).get();
    if (!old) return null;
    if (old.fingerprint !== fingerprint) throw new CommerceOperationsConflict("This recovery key was used with different details.");
    return { caseId, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const order = await db.query.orders.findFirst({ where: { id: v.orderId } });
  const original = order?.items[v.lineIndex];
  if (!order || !original || order.paymentProvider === "admin_test" || order.status !== "paid") throw new CommerceOperationsConflict("Only paid real orders with an affected item can create replacements or exchanges.");
  let target2;
  if (v.kind === "exchange") {
    if (!v.receiptId || v.fulfillmentId || v.sourceShipmentId || !v.productId) throw new CommerceOperationsConflict("Choose a received return and an equal-price replacement.");
    if (order.currency !== readStoreCurrency(env)) throw new CommerceOperationsConflict("This order uses a different currency from the current catalog.");
    const catalog = await loadBasketCatalog(commerceContext({ env }), [{ productId: v.productId, variantId: v.variantId }]), product = catalog.products.get(v.productId);
    if (!product || product.status !== "active" || !product.isPhysical || product.type !== "standard") throw new CommerceOperationsConflict("Choose an active physical stock item.");
    requireVariantChoice(catalog, product, v.variantId ?? void 0);
    const selected = v.variantId ? resolveSelectedVariant(catalog, product, v.variantId) : null;
    const price = selected?.price ?? product.basePrice;
    if (price !== original.priceAtPurchase) throw new CommerceOperationsConflict("The replacement must match the original unit price.");
    const described = (await describeOrderItems(env, [{ productId: product.id, variantId: v.variantId }]))[0];
    target2 = {
      productId: product.id,
      variantId: v.variantId ?? null,
      name: selected?.name ?? product.name,
      sku: described.sku,
      priceAtPurchase: price,
      stockTargets: selected?.components.length ? selected.components.map((t) => ({ type: "component", id: t.id, units: t.quantity })) : selected?.inventoryTarget ? [{ ...selected.inventoryTarget, units: 1 }] : [{ type: "product", id: product.id, units: 1 }]
    };
  } else {
    if (v.receiptId || v.productId !== void 0 || v.variantId !== void 0 || !!v.fulfillmentId === !!v.sourceShipmentId) throw new CommerceOperationsConflict("Choose one recorded original or replacement parcel.");
    if (v.sourceShipmentId) {
      const source = await db.query.recoveryShipments.findFirst({ where: { id: v.sourceShipmentId }, with: { case: true } });
      if (!source || source.case.orderId !== v.orderId || source.case.lineIndex !== v.lineIndex) throw new CommerceOperationsConflict("Replacement parcel not found.");
      target2 = source.case.target;
    } else {
      if (!Array.isArray(original.stockTargets)) throw new CommerceOperationsConflict("This older order has no frozen stock mapping for a safe replacement.");
      const d = (await describeOrderItems(env, [original]))[0];
      target2 = { productId: original.productId, variantId: original.variantId ?? null, name: [d.productName || "Ordered item", d.variantLabel].filter(Boolean).join(" / "), sku: d.sku, priceAtPurchase: original.priceAtPurchase, stockTargets: original.stockTargets };
    }
  }
  const result = await write(() => db.insert(recoveryCases).values({ id: caseId, orderId: v.orderId, kind: v.kind, fulfillmentId: v.fulfillmentId, sourceShipmentId: v.sourceShipmentId, receiptId: v.receiptId, lineIndex: v.lineIndex, quantity: v.quantity, target: targets(target2), actor, reason: v.reason, fingerprint, createdAt: /* @__PURE__ */ new Date() }), replay);
  return result ?? { caseId };
}
var action = z2.object({ caseId: id2, expectedVersion: id2, kind: z2.enum(["note", "resolve", "reopen", "tracking"]), shipmentId: id2.optional(), carrier: z2.string().trim().max(100).nullable().optional(), trackingNumber: z2.string().trim().max(150).nullable().optional(), reason: reason2, requestKey: id2.min(8) }).strict();
async function recordRecoveryEvent(env, input, actor) {
  const v = action.parse(input);
  actorRequired(actor);
  const db = commerceDb(env), eventId = `rce_${await hashOrderAccess(`${v.caseId}:${v.requestKey}`)}`, fingerprint = await warehouseFingerprint(v, actor);
  const replay = async () => {
    const old = await db.select().from(recoveryEvents).where(eq2(recoveryEvents.id, eventId)).get();
    if (!old) return null;
    if (old.fingerprint !== fingerprint) throw new CommerceOperationsConflict("This follow-up key was used with other details.");
    return { eventId, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const latest = await db.query.recoveryCases.findFirst({ where: { id: v.caseId }, with: { events: { orderBy: (_t, { sql: sql10 }) => sql10`rowid DESC`, limit: 1 } } });
  if (!latest || latest.redactedAt) throw new CommerceOperationsConflict("Recovery case unavailable.");
  const status = v.kind === "resolve" ? "resolved" : v.kind === "reopen" ? "open" : latest.events[0]?.status ?? "open";
  if (v.kind === "tracking" ? !v.shipmentId : v.shipmentId !== void 0 || v.carrier !== void 0 || v.trackingNumber !== void 0) throw new CommerceOperationsConflict("Choose a replacement parcel only for a tracking correction.");
  const result = await write(() => db.insert(recoveryEvents).values({ id: eventId, caseId: v.caseId, expectedVersion: v.expectedVersion, kind: v.kind, status, shipmentId: v.shipmentId ?? null, carrier: v.carrier || null, trackingNumber: v.trackingNumber || null, actor, reason: v.reason, fingerprint, createdAt: /* @__PURE__ */ new Date() }), replay);
  return result ?? { eventId };
}
var ship = z2.object({
  caseId: id2,
  expectedVersion: id2,
  quantity: units,
  requestKey: id2.min(8),
  reason: reason2,
  carrier: z2.string().trim().max(100).nullable().default(null),
  trackingNumber: z2.string().trim().max(150).nullable().default(null),
  stock: z2.array(z2.object({ targetType: z2.enum(RESTOCK_TARGET_TYPES), targetId: id2, expectedQuantity: z2.number().int().min(0).max(Number.MAX_SAFE_INTEGER), expectedUpdatedAt: timestamp }).strict()).max(50)
}).strict();
async function shipRecoveryCase(env, input, actor) {
  const v = ship.parse(input);
  actorRequired(actor);
  const db = commerceDb(env), shipmentId = `rcs_${await hashOrderAccess(`${v.caseId}:${v.requestKey}`)}`, fingerprint = await warehouseFingerprint(v, actor);
  const replay = async () => {
    const old = await db.select().from(recoveryShipments).where(eq2(recoveryShipments.id, shipmentId)).get();
    if (!old) return null;
    if (old.fingerprint !== fingerprint) throw new CommerceOperationsConflict("This replacement shipment key was used with other details.");
    return { shipmentId, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const c = await db.query.recoveryCases.findFirst({ where: { id: v.caseId } });
  if (!c) throw new CommerceOperationsConflict("Recovery case unavailable.");
  if (v.stock.length !== c.target.stockTargets.length || new Set(v.stock.map((t) => `${t.targetType}:${t.targetId}`)).size !== v.stock.length) throw new CommerceOperationsConflict("Reload every stock pool for this replacement.");
  const stock = v.stock.map((t) => {
    const target2 = c.target.stockTargets.find((s) => s.type === t.targetType && s.id === t.targetId);
    if (!target2) throw new CommerceOperationsConflict("The replacement stock mapping changed.");
    const required = target2.units * v.quantity;
    if (!Number.isSafeInteger(required) || required > 1e6) throw new CommerceOperationsConflict("This stock deduction is too large.");
    return { ...t, units: required, expectedUpdatedSeconds: Date.parse(t.expectedUpdatedAt) / 1e3 };
  }).map(({ expectedUpdatedAt, ...t }) => t);
  const result = await write(() => db.insert(recoveryShipments).values({ id: shipmentId, caseId: c.id, expectedVersion: v.expectedVersion, quantity: v.quantity, stock, carrier: v.carrier || null, trackingNumber: v.trackingNumber || null, actor, reason: v.reason, fingerprint, createdAt: /* @__PURE__ */ new Date() }), replay);
  return result ?? { shipmentId };
}
var queue = sql2`WITH cases AS (SELECT c.id,c.order_id AS orderId,c.kind,c.quantity,c.created_at AS createdAt,json_extract(c.target,'$.name') AS name,
 COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),'open') AS status,
 COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_shipments WHERE case_id=c.id),0) AS shipped FROM _ecommerce_recovery_cases c)`;
async function listRecoveryCases(env, input = {}) {
  const v = z2.object({ filter: z2.enum(["open", "resolved", "all"]).default("open"), kind: z2.enum(["all", ...RECOVERY_KINDS]).default("all"), offset: z2.coerce.number().int().min(0).max(1e6).default(0), orderId: z2.string().trim().max(128).default("") }).strict().parse(input), db = commerceDb(env);
  const where = sql2`(${v.filter}='all' OR status=${v.filter}) AND (${v.kind}='all' OR kind=${v.kind}) AND (${v.orderId}='' OR orderId=${v.orderId})`;
  const [rows, count] = await db.batch([db.all(sql2`${queue} SELECT * FROM cases WHERE ${where} ORDER BY createdAt,id LIMIT 50 OFFSET ${v.offset}`), db.all(sql2`${queue} SELECT count(*) n FROM cases WHERE ${where}`)]);
  return { ...v, total: count[0]?.n ?? 0, rows: rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt * 1e3).toISOString() })) };
}
async function readRecoveryCase(env, input) {
  const { caseId } = z2.object({ caseId: id2 }).strict().parse(input), db = commerceDb(env);
  const c = await db.query.recoveryCases.findFirst({ where: { id: caseId }, with: { events: { orderBy: (_t, { sql: sql10 }) => sql10`rowid DESC`, limit: 200 }, shipments: { orderBy: (_t, { sql: sql10 }) => sql10`rowid DESC`, limit: 100 }, order: { columns: { status: true, currency: true, shippingAddress: true } } } });
  if (!c) throw new CommerceOperationsConflict("Recovery case unavailable.");
  const shipped = await db.get(sql2`SELECT COALESCE(sum(quantity),0) n FROM _ecommerce_recovery_shipments WHERE case_id=${caseId}`), latest = c.events[0];
  const stock = await Promise.all(c.target.stockTargets.map(async (t) => {
    const row = await db.get(sql2`WITH physical AS (${physicalStockLocations}) SELECT name,sku,quantity,updated FROM physical WHERE type=${t.type} AND id=${t.id}`);
    return { ...t, name: row?.name ?? "Unavailable stock pool", sku: row?.sku ?? null, quantity: row?.quantity ?? null, updatedAt: row ? new Date(row.updated * 1e3).toISOString() : null };
  }));
  const names = await adminActorNames(env, [c.actor, ...c.events.map((e) => e.actor)]);
  const corrections = await db.query.recoveryEvents.findMany({ where: { caseId, kind: "tracking" }, columns: { id: true, shipmentId: true, carrier: true, trackingNumber: true }, orderBy: (_t, { sql: sql10 }) => sql10`rowid` });
  return {
    id: c.id,
    orderId: c.orderId,
    kind: c.kind,
    lineIndex: c.lineIndex,
    quantity: c.quantity,
    target: { name: c.target.name, sku: c.target.sku, productId: c.target.productId, variantId: c.target.variantId },
    sourceId: c.fulfillmentId ?? c.sourceShipmentId ?? c.receiptId,
    version: latest?.id ?? c.id,
    status: latest?.status ?? "open",
    remaining: Math.max(0, c.quantity - (shipped?.n ?? 0)),
    shipped: shipped?.n ?? 0,
    reason: c.reason,
    actorName: names.get(c.actor) ?? c.actor,
    createdAt: c.createdAt.toISOString(),
    redacted: !!c.redactedAt,
    paymentStatus: c.order.status,
    currency: c.order.currency,
    shippingAddress: c.order.shippingAddress,
    stock,
    historyTruncated: c.events.length === 200,
    shipmentsTruncated: c.shipments.length === 100,
    history: [...c.events].reverse().map((e) => ({ id: e.id, kind: e.kind, status: e.status, reason: e.reason, actorName: names.get(e.actor) ?? e.actor, createdAt: e.createdAt.toISOString() })),
    shipments: [...c.shipments].reverse().map((s) => {
      const correction = corrections.filter((e) => e.shipmentId === s.id).at(-1);
      return { id: s.id, quantity: s.quantity, carrier: correction ? correction.carrier : s.carrier, trackingNumber: correction ? correction.trackingNumber : s.trackingNumber, createdAt: s.createdAt.toISOString() };
    })
  };
}
async function readRecoveryOrder(env, input) {
  const v = z2.object({ orderId: id2 }).strict().parse(input), db = commerceDb(env), warehouse = await readOrderWarehouse(env, v);
  const cases = await db.query.recoveryCases.findMany({ where: { orderId: v.orderId }, columns: { id: true, lineIndex: true, quantity: true, receiptId: true, fulfillmentId: true, sourceShipmentId: true, kind: true, target: true }, with: { shipments: { columns: { id: true, quantity: true, createdAt: true } } } });
  return {
    ...warehouse,
    canCreate: warehouse.status === "paid",
    replacements: cases.flatMap((c) => c.shipments.map((s) => ({ id: s.id, lineIndex: c.lineIndex, quantity: s.quantity, name: c.target.name, createdAt: s.createdAt.toISOString() }))),
    cases: cases.map(({ target: target2, shipments, ...c }) => c)
  };
}
async function listExchangeChoices(env, input) {
  const v = z2.object({ orderId: id2, lineIndex: line, search: z2.string().trim().max(100).default(""), offset: z2.coerce.number().int().min(0).max(1e6).default(0) }).strict().parse(input), db = commerceDb(env);
  const o = await db.query.orders.findFirst({ where: { id: v.orderId }, columns: { items: true, currency: true, status: true, paymentProvider: true } }), item = o?.items[v.lineIndex];
  if (!item || o?.paymentProvider === "admin_test" || o?.status !== "paid" || o.currency !== readStoreCurrency(env)) throw new CommerceOperationsConflict("Equal-price choices are unavailable for this order.");
  const cte2 = sql2`WITH choices AS (
 SELECT p.id AS productId,NULL AS variantId,p.name,p.sku,p.base_price AS price FROM _ecommerce_products p WHERE p.status='active' AND p.is_physical=1 AND p.type='standard' AND NOT EXISTS(SELECT 1 FROM _ecommerce_product_variants g WHERE g.product_id=p.id)
 UNION ALL SELECT p.id,g.id,p.name||' / '||g.name,COALESCE(g.sku,p.sku),COALESCE(g.price_override,p.base_price) FROM _ecommerce_product_variants g JOIN _ecommerce_products p ON p.id=g.product_id WHERE p.status='active' AND p.is_physical=1 AND p.type='standard' AND NOT EXISTS(SELECT 1 FROM _ecommerce_product_variant_values v WHERE v.product_variant_id=g.id)
 UNION ALL SELECT p.id,v.id,p.name||' / '||g.name||': '||v.value,COALESCE(v.sku,g.sku,p.sku),COALESCE(v.price_override,g.price_override,p.base_price) FROM _ecommerce_product_variant_values v JOIN _ecommerce_product_variants g ON g.id=v.product_variant_id JOIN _ecommerce_products p ON p.id=g.product_id WHERE p.status='active' AND p.is_physical=1 AND p.type='standard')`;
  const pattern = `%${v.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, where = sql2`price=${item.priceAtPurchase} AND name LIKE ${pattern} ESCAPE '\\'`;
  const [rows, count] = await db.batch([db.all(sql2`${cte2} SELECT * FROM choices WHERE ${where} ORDER BY name,productId,variantId LIMIT 50 OFFSET ${v.offset}`), db.all(sql2`${cte2} SELECT count(*) n FROM choices WHERE ${where}`)]);
  return { ...v, currency: o.currency, price: item.priceAtPurchase, total: count[0]?.n ?? 0, rows };
}

// src/supplier-issues.ts
import { eq as eq3, sql as sql3 } from "drizzle-orm";
import { z as z3 } from "zod";
var id3 = z3.string().trim().min(1).max(128);
var reason3 = z3.string().trim().min(8).max(500);
var openSupplierIssue = sql3`COALESCE((SELECT status FROM _ecommerce_supplier_issue_events WHERE issue_id=i.id ORDER BY rowid DESC LIMIT 1),'open')='open'`;
async function identity2(input, actor, prefix) {
  if (!actor.trim()) throw new CommerceOperationsConflict("An authenticated staff member is required.");
  return { id: `${prefix}_${await hashOrderAccess(input.requestKey)}`, fingerprint: await hashOrderAccess(JSON.stringify({ input, actor })) };
}
async function guarded(write2, replay) {
  try {
    await write2();
  } catch (error) {
    const previous = await replay();
    if (previous) return previous;
    if (!/Supplier issue|UNIQUE constraint/.test(errorText(error))) throw error;
    throw new CommerceOperationsConflict("The purchase, delivery or supplier issue changed. Refresh before continuing.");
  }
  return null;
}
async function reportSupplierIssue(env, input, actor) {
  const v = z3.object({
    purchaseLineId: id3,
    expectedPurchaseVersion: id3,
    expectedDeliveryVersion: id3,
    kind: z3.enum(SUPPLIER_ISSUE_KINDS),
    quantity: z3.number().int().min(1).max(1e6),
    reason: reason3,
    requestKey: id3.min(8)
  }).strict().parse(input);
  const db = commerceDb(env), ident = await identity2(v, actor, "supissue");
  const replay = async () => {
    const row = await db.select().from(supplierIssues).where(eq3(supplierIssues.id, ident.id)).get();
    if (!row) return null;
    if (row.fingerprint !== ident.fingerprint) throw new CommerceOperationsConflict("This supplier issue key was used with different details.");
    return { issueId: row.id, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const { requestKey, ...fields } = v;
  const result = await guarded(() => commitBatch(db, [db.insert(supplierIssues).values({ ...fields, ...ident, actor, createdAt: /* @__PURE__ */ new Date() })]), replay);
  return result ?? { issueId: ident.id };
}
async function recordSupplierIssue(env, input, actor) {
  const v = z3.object({ issueId: id3, expectedVersion: id3, status: z3.enum(SUPPLIER_ISSUE_STATUSES), reason: reason3, requestKey: id3.min(8) }).strict().parse(input);
  const db = commerceDb(env), ident = await identity2(v, actor, "supissueevent");
  const replay = async () => {
    const row = await db.select().from(supplierIssueEvents).where(eq3(supplierIssueEvents.id, ident.id)).get();
    if (!row) return null;
    if (row.fingerprint !== ident.fingerprint) throw new CommerceOperationsConflict("This supplier follow-up key was used with different details.");
    return { issueId: row.issueId, eventId: row.id, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const { requestKey, ...fields } = v;
  const result = await guarded(() => commitBatch(db, [db.insert(supplierIssueEvents).values({ ...fields, ...ident, actor, createdAt: /* @__PURE__ */ new Date() })]), replay);
  return result ?? { issueId: v.issueId, eventId: ident.id };
}
var queue2 = sql3`WITH issues AS (SELECT i.id,i.purchase_line_id AS purchaseLineId,i.kind,i.quantity,i.created_at AS createdAt,
 COALESCE((SELECT id FROM _ecommerce_supplier_issue_events WHERE issue_id=i.id ORDER BY rowid DESC LIMIT 1),i.id) AS version,
 COALESCE((SELECT status FROM _ecommerce_supplier_issue_events WHERE issue_id=i.id ORDER BY rowid DESC LIMIT 1),'open') AS status,
 l.purchase_order_id AS purchaseOrderId,l.delivery_id AS deliveryId,l.line_index AS lineIndex,e.reference,
 json_extract(e.supplier,'$.name') AS supplier,json_extract(e.lines,'$['||l.line_index||'].name') AS name
 FROM _ecommerce_supplier_issues i JOIN _ecommerce_purchase_order_lines l ON l.id=i.purchase_line_id
 JOIN _ecommerce_purchase_order_events e ON e.id=(SELECT id FROM _ecommerce_purchase_order_events WHERE purchase_order_id=l.purchase_order_id ORDER BY rowid DESC LIMIT 1))`;
async function listSupplierIssues(env, input = {}) {
  const v = z3.object({
    purchaseOrderId: id3.optional(),
    offset: z3.coerce.number().int().min(0).max(1e6).default(0),
    filter: z3.enum(["open", "resolved", "all"]).default("open")
  }).strict().parse(input), db = commerceDb(env);
  const where = sql3`(${v.purchaseOrderId ?? null} IS NULL OR purchaseOrderId=${v.purchaseOrderId ?? null}) AND (${v.filter}='all' OR status=${v.filter})`;
  const [rows, count] = await db.batch([
    db.all(sql3`${queue2} SELECT * FROM issues WHERE ${where} ORDER BY createdAt,id LIMIT 50 OFFSET ${v.offset}`),
    db.all(sql3`${queue2} SELECT count(*) AS n FROM issues WHERE ${where}`)
  ]);
  return { ...v, total: count[0]?.n ?? 0, rows: rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt * 1e3).toISOString() })) };
}
async function readSupplierIssue(env, input) {
  const { issueId } = z3.object({ issueId: id3 }).strict().parse(input), db = commerceDb(env);
  const issue = await db.query.supplierIssues.findFirst({ where: { id: issueId }, with: {
    events: { orderBy: (_t, { sql: sql10 }) => sql10`rowid DESC`, limit: 100 },
    line: { with: { purchaseOrder: { with: { events: { orderBy: (_t, { sql: sql10 }) => sql10`rowid DESC`, limit: 1 } } } } }
  } });
  if (!issue) throw new CommerceOperationsConflict("Supplier issue not found.");
  const latest = issue.events[0], purchase = issue.line.purchaseOrder.events[0];
  const actors = await adminActorNames(env, [issue.actor, ...issue.events.map((e) => e.actor)]);
  return {
    id: issue.id,
    purchaseLineId: issue.purchaseLineId,
    purchaseOrderId: issue.line.purchaseOrderId,
    kind: issue.kind,
    quantity: issue.quantity,
    reason: issue.reason,
    createdAt: issue.createdAt.toISOString(),
    actorName: actors.get(issue.actor) ?? issue.actor,
    version: latest?.id ?? issue.id,
    status: latest?.status ?? "open",
    reference: purchase.reference,
    name: purchase.lines[issue.line.lineIndex].name,
    supplier: purchase.supplier.name,
    historyTruncated: issue.events.length === 100,
    history: [...issue.events].reverse().map((e) => ({ id: e.id, status: e.status, reason: e.reason, actorName: actors.get(e.actor) ?? e.actor, createdAt: e.createdAt.toISOString() }))
  };
}

// src/attention.ts
import { sql as sql4 } from "drizzle-orm";
async function readCommerceAttention(env, now = Math.floor(Date.now() / 1e3)) {
  const db = commerceDb(env);
  const queue3 = sql4`WITH attention_a AS (
    SELECT 'payment_review' AS kind, id, 'Order' AS subject, reconcile_review_at AS createdAt, reconcile_last_error AS detail
      FROM _ecommerce_orders WHERE status = 'pending' AND reconcile_review_at IS NOT NULL
        AND COALESCE(payment_provider, 'stripe') <> 'admin_test'
    UNION ALL SELECT 'payment_review', id, 'Gift card purchase', reconcile_review_at, reconcile_last_error
      FROM _ecommerce_gift_card_purchases WHERE status = 'pending' AND reconcile_review_at IS NOT NULL
    UNION ALL SELECT 'older_payments', id, 'Order', created_at, reconcile_last_error
      FROM _ecommerce_orders WHERE status = 'pending' AND reconcile_review_at IS NULL
        AND COALESCE(payment_provider, 'stripe') <> 'admin_test' AND created_at <= ${now - 86400}
    UNION ALL SELECT 'older_payments', id, 'Gift card purchase', created_at, reconcile_last_error
      FROM _ecommerce_gift_card_purchases WHERE status = 'pending' AND reconcile_review_at IS NULL AND created_at <= ${now - 86400}
    UNION ALL SELECT 'tax_review', id, 'Order tax', tax_sync_review_at, tax_sync_last_error
      FROM _ecommerce_orders WHERE tax_sync_review_at IS NOT NULL AND COALESCE(payment_provider, 'stripe') <> 'admin_test'
  ), attention_b AS (
    SELECT 'tax_review' AS kind, r.id AS id, 'Tax reversal' AS subject, r.tax_sync_review_at AS createdAt, r.tax_sync_last_error AS detail
      FROM _ecommerce_tax_reversals r JOIN _ecommerce_orders o ON o.id = r.order_id
      WHERE r.tax_sync_review_at IS NOT NULL AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'
    UNION ALL SELECT 'email', e.id, e.kind, e.created_at, e.last_error FROM _ecommerce_email_deliveries e
      WHERE (e.status = 'failed' OR (e.status = 'pending' AND e.last_error IS NOT NULL))
        AND (e.kind = 'gift_card_claim' OR EXISTS (SELECT 1 FROM _ecommerce_orders o
          WHERE o.id = e.subject_id AND e.kind = 'order_confirmation' AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test')
          OR EXISTS (SELECT 1 FROM _ecommerce_return_refund_decisions d JOIN _ecommerce_return_receipts r ON r.id=d.receipt_id JOIN _ecommerce_orders o ON o.id=r.order_id WHERE e.kind='return_refund' AND d.id=e.subject_id AND d.status='settled' AND d.redacted_at IS NULL AND o.customer_email IS NOT NULL AND COALESCE(o.payment_provider,'stripe')<>'admin_test')
          OR EXISTS (SELECT 1 FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE e.kind='return_received' AND r.id=e.subject_id AND COALESCE(o.payment_provider,'stripe')<>'admin_test')
          OR EXISTS (SELECT 1 FROM _ecommerce_return_request_events d JOIN _ecommerce_return_requests r ON r.id=d.request_id JOIN _ecommerce_orders o ON o.id=r.order_id WHERE e.kind='return_decision' AND d.id=e.subject_id AND d.redacted_at IS NULL AND d.rowid=(SELECT rowid FROM _ecommerce_return_request_events WHERE request_id=r.id ORDER BY rowid DESC LIMIT 1) AND COALESCE(o.payment_provider,'stripe')<>'admin_test')
          OR EXISTS (SELECT 1 FROM _ecommerce_fulfillments f JOIN _ecommerce_orders o ON o.id = f.order_id
            WHERE f.id = e.subject_id AND e.kind IN ('shipment', 'shipment_update') AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'))
    UNION ALL SELECT 'gift_hold', id, 'Gift card', updated_at, status FROM _ecommerce_gift_cards WHERE held_for_review = 1
    UNION ALL SELECT 'shipment', id, 'Order', created_at, fulfillment_status FROM _ecommerce_orders
      WHERE status IN ('paid', 'partially_refunded') AND fulfillment_status <> 'fulfilled' AND COALESCE(payment_provider, 'stripe') <> 'admin_test'
        AND shipping_address IS NOT NULL
    UNION ALL SELECT 'dispute', d.id, 'Payment dispute', d.created_at, d.status FROM _ecommerce_disputes d
      WHERE d.closed_at IS NULL AND (d.gift_card_purchase_id IS NOT NULL OR EXISTS (SELECT 1 FROM _ecommerce_orders o
        WHERE o.id = d.order_id AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'))
  ), return_events AS (
    SELECT 'return_request' AS kind,r.id,'Return request' AS subject,r.created_at AS createdAt,r.order_id AS detail FROM _ecommerce_return_requests r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_request_events e WHERE e.request_id=r.id)
    UNION ALL SELECT 'inspection',r.id,'Received return',r.created_at,r.order_id FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
      AND (SELECT COALESCE(sum(json_extract(value,'$.quantity')),0) FROM json_each(r.items) WHERE json_extract(value,'$.condition')='inspection')>COALESCE((SELECT sum(json_extract(i.value,'$.quantity')) FROM _ecommerce_return_inspections d,json_each(d.items) i WHERE d.receipt_id=r.id),0)
    UNION ALL SELECT 'refund',r.id,'Return refund',r.created_at,r.order_id FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND NOT EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a WHERE a.account_id=o.user_id AND a.action='anonymize') AND COALESCE((SELECT status FROM _ecommerce_return_refund_decisions d WHERE d.receipt_id=r.id ORDER BY rowid DESC LIMIT 1),'review') IN ('review','needed')
    UNION ALL SELECT 'incoming',d.id,'Overdue delivery',d.created_at,d.supplier FROM _ecommerce_replenishment_deliveries d WHERE ${effectiveDeliveryDate} < date(${now},'unixepoch') AND NOT EXISTS(SELECT 1 FROM _ecommerce_replenishment_delivery_events e WHERE e.delivery_id=d.id AND e.kind='cancelled') AND d.quantity>COALESCE((SELECT sum(m.delta) FROM _ecommerce_replenishment_delivery_events e JOIN _ecommerce_stock_movements m ON m.id=e.movement_id WHERE e.delivery_id=d.id),0)
    UNION ALL SELECT 'supplier_issue',i.id,'Supplier delivery issue',i.created_at,i.kind||' · '||i.quantity||' units' FROM _ecommerce_supplier_issues i WHERE ${openSupplierIssue}
  ), recovery_work AS (SELECT 'parcel_recovery' AS kind,c.id,'Parcel or exchange' AS subject,c.created_at AS createdAt,c.kind||' · '||c.quantity||' units' AS detail FROM _ecommerce_recovery_cases c WHERE ${openRecoveryCase}), attention AS (SELECT * FROM attention_a UNION ALL SELECT * FROM attention_b UNION ALL SELECT * FROM return_events UNION ALL SELECT * FROM recovery_work)`;
  const [counts, rows] = await db.batch([
    db.all(sql4`${queue3} SELECT kind, count(*) AS count FROM attention GROUP BY kind`),
    db.all(sql4`${queue3}, ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY kind ORDER BY createdAt, id) AS rank FROM attention)
      SELECT kind, id, subject, createdAt, detail FROM ranked WHERE rank <= 10 ORDER BY kind, createdAt, id`)
  ]);
  return {
    checkedAt: new Date(now * 1e3).toISOString(),
    counts: Object.fromEntries(counts.map((row) => [row.kind, Number(row.count)])),
    rows: rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt * 1e3).toISOString() }))
  };
}

// src/stock-overview.ts
import { z as z4 } from "zod";
import { sql as sql5 } from "drizzle-orm";
var inputSchema = z4.object({
  view: z4.enum(["choices", "components"]).default("choices"),
  threshold: z4.coerce.number().int().min(0).max(1e6).default(5),
  filter: z4.enum(["low", "unavailable", "all"]).default("low"),
  search: z4.string().trim().max(100).default(""),
  offset: z4.coerce.number().int().min(0).max(1e6).default(0)
});
var choices = sql5`WITH inventory AS (
  SELECT p.id, 'product' AS kind, p.id AS productId, p.name, p.sku, p.inventory_quantity AS quantity, 'Product' AS source
    FROM _ecommerce_products p WHERE p.status = 'active' AND p.type = 'standard'
      AND NOT EXISTS (SELECT 1 FROM _ecommerce_product_variants g WHERE g.product_id = p.id)
  UNION ALL
  SELECT g.id, 'variant', p.id, p.name || ' / ' || g.name, g.sku, g.inventory_quantity, 'Option group'
    FROM _ecommerce_product_variants g JOIN _ecommerce_products p ON p.id = g.product_id
    WHERE p.status = 'active' AND p.type = 'standard'
      AND NOT EXISTS (SELECT 1 FROM _ecommerce_product_variant_values v WHERE v.product_variant_id = g.id)
  UNION ALL
  SELECT v.id, 'value', p.id, p.name || ' / ' || g.name || ' / ' || v.value, v.sku,
    CASE WHEN EXISTS (SELECT 1 FROM _ecommerce_variant_components r WHERE r.product_variant_value_id = v.id)
      THEN (SELECT min(c.quantity / r.quantity) FROM _ecommerce_variant_components r
        JOIN _ecommerce_components c ON c.id = r.component_id WHERE r.product_variant_value_id = v.id)
      ELSE COALESCE(s.quantity, g.inventory_quantity) END,
    CASE WHEN EXISTS (SELECT 1 FROM _ecommerce_variant_components r WHERE r.product_variant_value_id = v.id)
      THEN 'Shared components' WHEN s.id IS NOT NULL THEN 'Choice stock' ELSE 'Option group' END
    FROM _ecommerce_product_variant_values v JOIN _ecommerce_product_variants g ON g.id = v.product_variant_id
      JOIN _ecommerce_products p ON p.id = g.product_id
      LEFT JOIN _ecommerce_stocks s ON s.product_variant_value_id = v.id
    WHERE p.status = 'active' AND p.type = 'standard'
)`;
var parts = sql5`WITH inventory AS (SELECT id, 'component' AS kind, NULL AS productId, name, sku, quantity,
  'Shared component' AS source FROM _ecommerce_components)`;
async function readStockOverview(env, input = {}) {
  const values = inputSchema.parse(input);
  const cte2 = values.view === "components" ? parts : choices;
  const pattern = `%${values.search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  const filtered = sql5`(name LIKE ${pattern} ESCAPE '\\' OR COALESCE(sku, '') LIKE ${pattern} ESCAPE '\\')
    AND ${values.filter === "all" ? sql5`1` : values.filter === "unavailable" ? sql5`quantity = 0` : sql5`quantity <= ${values.threshold}`}`;
  const db = commerceDb(env);
  const [rows, counted] = await db.batch([
    db.all(sql5`${cte2} SELECT * FROM inventory WHERE ${filtered}
      ORDER BY quantity, name, kind, id LIMIT 50 OFFSET ${values.offset}`),
    db.all(sql5`${cte2} SELECT count(*) AS count FROM inventory WHERE ${filtered}`)
  ]);
  return { rows, total: Number(counted[0]?.count ?? 0), ...values };
}

// src/operations-export.ts
import { and, asc, eq as eq4, gte, lt, sql as sql6 } from "drizzle-orm";
import { z as z5 } from "zod";
var day = z5.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && (/* @__PURE__ */ new Date(`${s}T00:00:00Z`)).toISOString().slice(0, 10) === s, "Use a valid calendar date");
var options = z5.object({ kind: z5.enum(["orders", "returns", "stock"]), from: day, to: day, orderId: z5.string().trim().max(128).default(""), status: z5.enum(["all", "draft", "pending", "paid", "fulfilled", "cancelled", "partially_refunded", "refunded", "disputed"]).default("all"), targetType: z5.enum(["all", "product", "variant", "stock", "component"]).default("all"), targetId: z5.string().trim().max(128).default("") }).strict().refine((v) => v.to >= v.from && Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`) < 366 * 864e5, "Choose at most 366 UTC days").refine((v) => (v.kind === "orders" || v.status === "all") && (v.kind === "stock" || v.targetType === "all" && !v.targetId) && (!v.targetId || v.targetType !== "all"), "Filters do not match the selected export");
var OperationsExportLimit = class extends Error {
};
function csvCell(value) {
  if (value === null) return '""';
  let s = String(value);
  if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}
async function exportCommerceOperations(env, input) {
  const v = options.parse(input), db = commerceDb(env), from = Date.parse(`${v.from}T00:00:00Z`) / 1e3, to = Date.parse(`${v.to}T00:00:00Z`) / 1e3 + 86400;
  let rows, columns;
  if (v.kind === "orders") {
    columns = ["order_id", "created_at_utc", "payment_status", "fulfillment_status", "currency", "subtotal_minor", "shipping_minor", "tax_minor", "discount_minor", "credit_minor", "gift_card_minor", "total_minor", "provider_refunded_minor", "gift_card_refunded_minor", "customer_email"];
    rows = await db.select({
      order_id: orders.id,
      created_at_utc: sql6`${orders.createdAt}`,
      payment_status: orders.status,
      fulfillment_status: orders.fulfillmentStatus,
      currency: orders.currency,
      subtotal_minor: orders.subtotalAmount,
      shipping_minor: orders.shippingAmount,
      tax_minor: orders.taxAmount,
      discount_minor: orders.discountAmount,
      credit_minor: orders.creditApplied,
      gift_card_minor: orders.giftCardApplied,
      total_minor: orders.totalAmount,
      provider_refunded_minor: orders.providerRefundedCents,
      gift_card_refunded_minor: orders.giftCardRefundedCents,
      customer_email: orders.customerEmail
    }).from(orders).where(and(
      gte(orders.createdAt, new Date(from * 1e3)),
      lt(orders.createdAt, new Date(to * 1e3)),
      sql6`COALESCE(${orders.paymentProvider},'stripe')<>'admin_test'`,
      v.orderId ? eq4(orders.id, v.orderId) : void 0,
      v.status === "all" ? void 0 : eq4(orders.status, v.status)
    )).orderBy(asc(orders.createdAt), asc(orders.id)).limit(1001).all();
  } else if (v.kind === "returns") {
    columns = ["receipt_id", "request_id", "order_id", "created_at_utc", "line_index", "quantity", "condition", "restock_selected", "awaiting_inspection", "actor", "reason"];
    rows = await db.all(sql6`SELECT r.id AS receipt_id,l.request_id,r.order_id,r.created_at AS created_at_utc,json_extract(i.value,'$.lineIndex') AS line_index,json_extract(i.value,'$.quantity') AS quantity,json_extract(i.value,'$.condition') AS condition,json_extract(i.value,'$.restock') AS restock_selected,
    CASE WHEN json_extract(i.value,'$.condition')='inspection' THEN json_extract(i.value,'$.quantity')-COALESCE((SELECT sum(json_extract(a.value,'$.quantity')) FROM _ecommerce_return_inspections d,json_each(d.items) a WHERE d.receipt_id=r.id AND json_extract(a.value,'$.lineIndex')=json_extract(i.value,'$.lineIndex')),0) ELSE 0 END AS awaiting_inspection,r.actor,r.reason
    FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id LEFT JOIN _ecommerce_return_request_receipts l ON l.receipt_id=r.id,json_each(r.items) i
    WHERE r.created_at>=${from} AND r.created_at<${to} AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND (${v.orderId}='' OR r.order_id=${v.orderId}) ORDER BY r.created_at,r.id,line_index LIMIT 1001`);
  } else {
    columns = ["movement_id", "created_at_utc", "kind", "target_type", "target_id", "delta", "before_quantity", "after_quantity", "order_id", "actor", "reason"];
    const inventory = sql6`SELECT r.id AS movement_id,o.created_at AS created_at_utc,'checkout_hold' AS kind,r.target_type,r.target_id,-r.quantity AS delta,NULL AS before_quantity,NULL AS after_quantity,r.order_id,NULL AS actor,'Checkout stock reservation' AS reason FROM _ecommerce_inventory_reservations r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
      UNION ALL SELECT r.id||'_release',r.released_at,'checkout_release',r.target_type,r.target_id,r.quantity,NULL,NULL,r.order_id,NULL,'Cancelled checkout stock release' FROM _ecommerce_inventory_reservations r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE r.released_at IS NOT NULL AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND NOT EXISTS(SELECT 1 FROM _ecommerce_restocks x WHERE x.reservation_type='inventory' AND x.reservation_id=r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_stock x WHERE x.reservation_type='inventory' AND x.reservation_id=r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_inspection_stock x WHERE x.reservation_type='inventory' AND x.reservation_id=r.id)`;
    const component = sql6`SELECT r.id AS movement_id,o.created_at AS created_at_utc,'checkout_hold' AS kind,'component' AS target_type,r.component_id AS target_id,-r.quantity AS delta,NULL AS before_quantity,NULL AS after_quantity,r.order_id,NULL AS actor,'Checkout component reservation' AS reason FROM _ecommerce_component_reservations r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
      UNION ALL SELECT r.id||'_release',r.released_at,'checkout_release','component',r.component_id,r.quantity,NULL,NULL,r.order_id,NULL,'Cancelled checkout component release' FROM _ecommerce_component_reservations r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE r.released_at IS NOT NULL AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND NOT EXISTS(SELECT 1 FROM _ecommerce_restocks x WHERE x.reservation_type='component' AND x.reservation_id=r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_stock x WHERE x.reservation_type='component' AND x.reservation_id=r.id) AND NOT EXISTS(SELECT 1 FROM _ecommerce_inspection_stock x WHERE x.reservation_type='component' AND x.reservation_id=r.id)`;
    const restored = sql6`SELECT s.id AS movement_id,r.created_at AS created_at_utc,'return' AS kind,s.target_type,s.target_id,s.quantity AS delta,NULL AS before_quantity,NULL AS after_quantity,s.order_id,r.actor,r.reason FROM _ecommerce_return_stock s JOIN _ecommerce_return_receipts r ON r.id=s.receipt_id
      UNION ALL SELECT s.id,r.created_at,'inspection',s.target_type,s.target_id,s.quantity,NULL,NULL,s.order_id,r.actor,r.reason FROM _ecommerce_inspection_stock s JOIN _ecommerce_return_inspections r ON r.id=s.inspection_id`;
    rows = await db.all(sql6`WITH inventory AS (${inventory}),component AS (${component}),restored AS (${restored}),events AS (
      SELECT id AS movement_id,created_at AS created_at_utc,kind,target_type,target_id,delta,before_quantity,after_quantity,NULL AS order_id,actor,reason FROM _ecommerce_stock_movements
      UNION ALL SELECT * FROM restored
      UNION ALL SELECT id,created_at,'restock',target_type,target_id,quantity,NULL,NULL,order_id,admin_actor,reason FROM _ecommerce_restocks
      UNION ALL SELECT * FROM inventory UNION ALL SELECT * FROM component)
      SELECT * FROM events WHERE (order_id IS NULL OR EXISTS(SELECT 1 FROM _ecommerce_orders o WHERE o.id=events.order_id AND COALESCE(o.payment_provider,'stripe')<>'admin_test')) AND created_at_utc>=${from} AND created_at_utc<${to} AND (${v.orderId}='' OR order_id=${v.orderId}) AND (${v.targetType}='all' OR target_type=${v.targetType}) AND (${v.targetId}='' OR target_id=${v.targetId}) ORDER BY created_at_utc,movement_id LIMIT 1001`);
  }
  if (rows.length > 1e3) throw new OperationsExportLimit("This selection exceeds 1,000 rows. Narrow the dates or filters; no partial file was created.");
  for (const row of rows) row.created_at_utc = new Date(Number(row.created_at_utc) * 1e3).toISOString();
  return { filename: `commerce-${v.kind}-${v.from}-${v.to}.csv`, rows: rows.length, csv: "\uFEFF" + [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((c) => csvCell(row[c] ?? null)).join(","))].join("\r\n") + "\r\n" };
}

// src/refund-follow-up.ts
import { eq as eq5, sql as sql7 } from "drizzle-orm";
import { z as z6 } from "zod";
var id4 = z6.string().trim().min(1).max(128);
var reason4 = z6.string().trim().min(8).max(500);
var sourceRows = sql7`SELECT 'provider' AS kind,id,order_id,amount_cents,created_at FROM _ecommerce_provider_refunds
 UNION ALL SELECT 'gift_card',id,order_id,amount_cents,created_at FROM _ecommerce_gift_card_ledger WHERE kind='refund_restore'
 UNION ALL SELECT 'store_credit',id,order_id,amount_cents,created_at FROM _ecommerce_credit_ledger WHERE kind='purchase_credit_refund'`;
async function listRefundFollowUp(env, input = {}) {
  const v = z6.object({ offset: z6.coerce.number().int().min(0).max(1e6).default(0), filter: z6.enum(["active", "review", "needed", "resolved", "all"]).default("active"), orderId: z6.string().trim().max(128).default("") }).strict().parse(input), db = commerceDb(env);
  const cte2 = sql7`WITH cases AS (SELECT r.id,r.order_id AS orderId,o.currency,r.created_at AS createdAt,
 CASE WHEN EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a WHERE a.account_id=o.user_id AND a.action='anonymize') THEN 'unavailable' ELSE COALESCE((SELECT status FROM _ecommerce_return_refund_decisions d WHERE d.receipt_id=r.id ORDER BY rowid DESC LIMIT 1),'review') END AS status,
 COALESCE((SELECT amount_minor FROM _ecommerce_return_refund_decisions d WHERE d.receipt_id=r.id ORDER BY rowid DESC LIMIT 1),0) AS amountMinor
 FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test')`;
  const where = sql7`(${v.orderId}='' OR orderId=${v.orderId}) AND (${v.filter}='all' OR (${v.filter}='active' AND status IN ('review','needed')) OR (${v.filter}='resolved' AND status IN ('settled','not_needed','unavailable')) OR status=${v.filter})`;
  const [rows, count] = await db.batch([db.all(sql7`${cte2} SELECT * FROM cases WHERE ${where} ORDER BY createdAt,id LIMIT 50 OFFSET ${v.offset}`), db.all(sql7`${cte2} SELECT count(*) n FROM cases WHERE ${where}`)]);
  return { ...v, total: count[0]?.n ?? 0, rows: rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt * 1e3).toISOString() })) };
}
async function readRefundCase(env, input) {
  const v = z6.object({ receiptId: id4 }).strict().parse(input), db = commerceDb(env);
  const r = await db.query.returnReceipts.findFirst({ where: { id: v.receiptId }, with: { order: { columns: { id: true, items: true, currency: true, paymentProvider: true, userId: true } }, refundDecisions: { orderBy: (_t, { sql: sql10 }) => sql10`rowid` } } });
  if (!r || r.order.paymentProvider === "admin_test") throw new CommerceOperationsConflict("Received return is unavailable.");
  const [sources, names, items] = await Promise.all([db.all(sql7`WITH sources AS (${sourceRows}) SELECT kind,id,amount_cents AS amountMinor,created_at AS createdAt,
 amount_cents-COALESCE((SELECT sum(json_extract(a.value,'$.amountMinor')) FROM _ecommerce_return_refund_decisions d,json_each(d.allocations) a WHERE d.status='settled' AND json_extract(a.value,'$.kind')=sources.kind AND json_extract(a.value,'$.sourceId')=sources.id),0) AS availableMinor FROM sources WHERE order_id=${r.orderId} ORDER BY created_at,id`), adminActorNames(env, r.refundDecisions.map((d) => d.actor)), describeOrderItems(env, r.items.map((i) => ({ ...r.order.items[i.lineIndex], quantity: i.quantity })))]);
  const latest = r.refundDecisions.at(-1), erased = r.order.userId ? await db.select({ id: shopperAudits.id }).from(shopperAudits).where(sql7`${shopperAudits.accountId}=${r.order.userId} AND ${shopperAudits.action}='anonymize'`).limit(1).get() : null;
  return {
    receiptId: r.id,
    orderId: r.orderId,
    currency: r.order.currency,
    version: latest?.id ?? r.id,
    status: erased ? "unavailable" : latest?.status ?? "review",
    amountMinor: latest?.amountMinor ?? 0,
    items: items.map((i) => ({ name: [i.productName || "Ordered item", i.variantLabel].filter(Boolean).join(" / "), quantity: i.quantity })),
    history: r.refundDecisions.map((d) => ({ id: d.id, status: d.status, amountMinor: d.amountMinor, allocations: d.allocations, reason: d.reason, actor: d.actor, actorName: names.get(d.actor) ?? d.actor, createdAt: d.createdAt.toISOString() })),
    sources: sources.map((s) => ({ ...s, createdAt: s.createdAt === null ? null : new Date(s.createdAt * 1e3).toISOString() }))
  };
}
var decision = z6.object({
  receiptId: id4,
  requestKey: id4.min(8),
  expectedVersion: id4,
  status: z6.enum(RETURN_REFUND_STATUSES),
  amountMinor: z6.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  allocations: z6.array(z6.object({ kind: z6.enum(REFUND_SOURCE_KINDS), sourceId: id4, amountMinor: z6.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict()).max(20).default([]),
  reason: reason4
}).strict().refine((v) => v.status === "not_needed" ? v.amountMinor === 0 && !v.allocations.length : v.amountMinor > 0 && (v.status === "settled" ? v.allocations.length > 0 && v.allocations.reduce((n, a) => n + a.amountMinor, 0) === v.amountMinor : !v.allocations.length), "Choose an amount and matching confirmed refund allocations");
async function recordRefundFollowUp(env, input, actor) {
  const v = decision.parse(input);
  if (!actor.trim()) throw new CommerceOperationsConflict("An authenticated staff member is required.");
  const allocations = [...v.allocations].sort((a, b) => `${a.kind}:${a.sourceId}`.localeCompare(`${b.kind}:${b.sourceId}`));
  const db = commerceDb(env), decisionId = `rrf_${await hashOrderAccess(`${v.receiptId}:${v.requestKey}`)}`, fingerprint = await hashOrderAccess(JSON.stringify({ ...v, allocations, actor }));
  const replay = async () => {
    const d = await db.select().from(returnRefundDecisions).where(eq5(returnRefundDecisions.id, decisionId)).get();
    if (!d) return null;
    if (d.fingerprint !== fingerprint) throw new CommerceOperationsConflict("This refund decision key was used with other details.");
    return { decisionId, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  try {
    await db.batch([db.insert(returnRefundDecisions).values({ id: decisionId, receiptId: v.receiptId, expectedVersion: v.expectedVersion, status: v.status, amountMinor: v.amountMinor, allocations, actor, reason: v.reason, fingerprint, createdAt: /* @__PURE__ */ new Date() }), ...v.status === "settled" ? [db.run(commerceEmailStatement("return_refund", decisionId, Math.floor(Date.now() / 1e3)))] : []]);
  } catch (error) {
    const previous2 = await replay();
    if (previous2) return previous2;
    if (!/Refund follow-up|Confirmed refunds/.test(errorText(error))) throw error;
    throw new CommerceOperationsConflict("This return or confirmed refund balance changed. Refresh before recording a decision.");
  }
  return { decisionId };
}

// src/purchasing.ts
import { eq as eq6, sql as sql8 } from "drizzle-orm";
import { z as z7 } from "zod";
var id5 = z7.string().trim().min(1).max(128);
var key = id5.min(8);
var reason5 = z7.string().trim().min(8).max(500);
var date = z7.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && (/* @__PURE__ */ new Date(`${v}T00:00:00Z`)).toISOString().slice(0, 10) === v);
var lineInput = z7.object({ targetType: z7.enum(RESTOCK_TARGET_TYPES), targetId: id5, quantity: z7.number().int().min(1).max(1e6) }).strict();
var linesInput = z7.array(lineInput).min(1).max(20).refine((rows) => new Set(rows.map((r) => `${r.targetType}:${r.targetId}`)).size === rows.length, "Choose each stock pool once");
var supplierInput = z7.object({ supplierId: id5.nullable(), expectedVersion: id5.nullable(), requestKey: key, name: z7.string().trim().min(1).max(200), contact: z7.string().trim().max(500), address: z7.string().trim().max(1e3), active: z7.boolean(), reason: reason5 }).strict();
var draftInput = z7.object({ purchaseOrderId: id5.nullable(), expectedVersion: id5.nullable(), requestKey: key, supplierId: id5, supplierVersion: id5, reference: z7.string().trim().min(1).max(200), expectedDate: date, lines: linesInput, reason: reason5 }).strict();
var actionInput = z7.object({ purchaseOrderId: id5, expectedVersion: id5, requestKey: key, action: z7.enum(["order", "reschedule", "cancel"]), supplierVersion: id5.optional(), expectedDate: date.optional(), reason: reason5 }).strict().refine((v) => v.action === "reschedule" === (v.expectedDate !== void 0) && v.action === "order" === (v.supplierVersion !== void 0));
async function identity3(input, actor, prefix) {
  if (!actor.trim()) throw new CommerceOperationsConflict("An authenticated staff member is required.");
  return { id: `${prefix}_${await hashOrderAccess(input.requestKey)}`, fingerprint: await hashOrderAccess(JSON.stringify({ input, actor })) };
}
async function conflict(write2, replay) {
  try {
    await write2();
  } catch (error) {
    const previous = await replay();
    if (previous) return previous;
    if (!/Purchasing|Replenishment|UNIQUE constraint/.test(errorText(error))) throw error;
    throw new CommerceOperationsConflict("The supplier, purchase order or delivery changed. Refresh before continuing.");
  }
  return null;
}
async function listSuppliers(env, input = {}) {
  const v = z7.object({ offset: z7.coerce.number().int().min(0).max(1e6).default(0), filter: z7.enum(["active", "all"]).default("active"), search: z7.string().trim().max(100).default("") }).strict().parse(input), db = commerceDb(env);
  const pattern = `%${v.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const where = sql8`r.rowid=(SELECT rowid FROM _ecommerce_supplier_revisions WHERE supplier_id=r.supplier_id ORDER BY rowid DESC LIMIT 1) AND (${v.filter}='all' OR r.active=1) AND r.name LIKE ${pattern} ESCAPE '\\'`;
  const [rows, count] = await db.batch([db.all(sql8`SELECT r.supplier_id AS id,r.id AS version,r.name,r.contact,r.address,r.active FROM _ecommerce_supplier_revisions r WHERE ${where} ORDER BY r.name,r.supplier_id LIMIT 50 OFFSET ${v.offset}`), db.all(sql8`SELECT count(*) n FROM _ecommerce_supplier_revisions r WHERE ${where}`)]);
  return { ...v, total: count[0]?.n ?? 0, rows: rows.map((r) => ({ ...r, active: !!r.active })) };
}
async function saveSupplier(env, input, actor) {
  const v = supplierInput.parse(input), db = commerceDb(env), ident = await identity3(v, actor, "suprev"), supplierId = v.supplierId ?? `sup_${await hashOrderAccess(v.requestKey)}`;
  const replay = async () => {
    const r = await db.select().from(supplierRevisions).where(eq6(supplierRevisions.id, ident.id)).get();
    if (!r) return null;
    if (r.fingerprint !== ident.fingerprint) throw new CommerceOperationsConflict("This supplier key was used with different details.");
    return { supplierId: r.supplierId, revisionId: r.id, duplicate: true };
  };
  const previous = await replay();
  if (previous) return previous;
  const failure = await conflict(() => commitBatch(db, [...!v.supplierId ? [db.insert(suppliers).values({ id: supplierId, createdAt: /* @__PURE__ */ new Date() })] : [], db.insert(supplierRevisions).values({ ...ident, supplierId, expectedVersion: v.expectedVersion, name: v.name, contact: v.contact, address: v.address, active: v.active, actor, reason: v.reason, createdAt: /* @__PURE__ */ new Date() })]), replay);
  return failure ?? { supplierId, revisionId: ident.id };
}
var latestSupplier = (env, supplierId) => commerceDb(env).query.supplierRevisions.findFirst({ where: { supplierId }, orderBy: (_t, { sql: sql10 }) => sql10`rowid DESC` });
var supplierSnapshot = (s) => ({ version: s.id, name: s.name, contact: s.contact, address: s.address });
async function savePurchaseOrder(env, input, actor) {
  const v = draftInput.parse(input), db = commerceDb(env), ident = await identity3(v, actor, "poe"), purchaseOrderId = v.purchaseOrderId ?? `po_${await hashOrderAccess(v.requestKey)}`;
  const replay = eventReplay(db, ident);
  const previous = await replay();
  if (previous) return previous;
  const supplier = await latestSupplier(env, v.supplierId);
  if (!supplier?.active || supplier.id !== v.supplierVersion) throw new CommerceOperationsConflict("Supplier changed or is inactive. Refresh before continuing.");
  const lines = [];
  for (const l of [...v.lines].sort((a, b) => `${a.targetType}:${a.targetId}`.localeCompare(`${b.targetType}:${b.targetId}`))) {
    const stock = await db.get(sql8`WITH physical AS (${physicalStockLocations}) SELECT name,sku FROM physical WHERE type=${l.targetType} AND id=${l.targetId}`);
    if (!stock) throw new CommerceOperationsConflict("A stock pool is unavailable. Refresh before continuing.");
    lines.push({ ...l, ...stock });
  }
  if (v.purchaseOrderId) {
    const order = await db.select().from(purchaseOrders).where(eq6(purchaseOrders.id, v.purchaseOrderId)).get();
    if (order?.supplierId !== v.supplierId) throw new CommerceOperationsConflict("The purchase order supplier cannot be changed.");
  }
  const failure = await conflict(() => commitBatch(db, [...!v.purchaseOrderId ? [db.insert(purchaseOrders).values({ id: purchaseOrderId, supplierId: v.supplierId, createdAt: /* @__PURE__ */ new Date() })] : [], db.insert(purchaseOrderEvents).values({ ...ident, purchaseOrderId, expectedVersion: v.expectedVersion, status: "draft", reference: v.reference, expectedDate: v.expectedDate, lines, supplier: supplierSnapshot(supplier), actor, reason: v.reason, createdAt: /* @__PURE__ */ new Date() })]), replay);
  return failure ?? { purchaseOrderId, eventId: ident.id };
}
function eventReplay(db, ident) {
  return async () => {
    const r = await db.select().from(purchaseOrderEvents).where(eq6(purchaseOrderEvents.id, ident.id)).get();
    if (!r) return null;
    if (r.fingerprint !== ident.fingerprint) throw new CommerceOperationsConflict("This purchase order key was used with different details.");
    return { purchaseOrderId: r.purchaseOrderId, eventId: r.id, duplicate: true };
  };
}
async function recordPurchaseOrder(env, input, actor) {
  const v = actionInput.parse(input), db = commerceDb(env), ident = await identity3(v, actor, "poe"), replay = eventReplay(db, ident), previous = await replay();
  if (previous) return previous;
  const order = await db.query.purchaseOrders.findFirst({ where: { id: v.purchaseOrderId }, with: { events: { orderBy: (_t, { sql: sql10 }) => sql10`rowid` }, lines: { with: { delivery: { with: { events: { orderBy: (_t, { sql: sql10 }) => sql10`rowid`, with: { movement: { columns: { delta: true } } } } } } } } } });
  const last = order?.events.at(-1);
  if (!order || !last || last.id !== v.expectedVersion || last.status === "cancelled") throw new CommerceOperationsConflict("Purchase order changed. Refresh before continuing.");
  const statements = [], now = /* @__PURE__ */ new Date();
  let supplier = last.supplier;
  if (v.action === "order") {
    if (last.status !== "draft") throw new CommerceOperationsConflict("This purchase order has already been confirmed.");
    const current = await latestSupplier(env, order.supplierId);
    if (!current?.active || current.id !== v.supplierVersion) throw new CommerceOperationsConflict("Supplier changed or is inactive. Refresh before continuing.");
    supplier = supplierSnapshot(current);
    for (const [index, line2] of last.lines.entries()) {
      const deliveryId = `pod_${await hashOrderAccess(`${order.id}:${index}`)}`;
      statements.push(db.insert(replenishmentDeliveries).values({ id: deliveryId, targetType: line2.targetType, targetId: line2.targetId, quantity: line2.quantity, supplier: supplier.name, reference: last.reference, expectedDate: last.expectedDate, actor, reason: v.reason, fingerprint: ident.fingerprint, createdAt: now }), db.insert(purchaseOrderLines).values({ id: deliveryId, purchaseOrderId: order.id, lineIndex: index, deliveryId }));
    }
  } else if (v.action === "reschedule" && last.status !== "ordered") throw new CommerceOperationsConflict("Only confirmed purchase orders can be rescheduled.");
  if (v.action === "cancel" && last.status === "ordered") {
    for (const l of order.lines) {
      const received = l.delivery.events.reduce((n, e) => n + (e.movement?.delta ?? 0), 0);
      if (l.delivery.events.some((e) => e.kind === "cancelled") || received >= l.delivery.quantity) continue;
      statements.push(db.insert(replenishmentDeliveryEvents).values({ id: `poc_${await hashOrderAccess(`${ident.id}:${l.id}`)}`, deliveryId: l.deliveryId, kind: "cancelled", movementId: null, expectedVersion: l.delivery.events.at(-1)?.id ?? l.deliveryId, actor, reason: v.reason, fingerprint: ident.fingerprint, createdAt: now }));
    }
    if (!statements.length) throw new CommerceOperationsConflict("There are no outstanding units to cancel.");
  }
  statements.push(db.insert(purchaseOrderEvents).values({ ...ident, purchaseOrderId: order.id, expectedVersion: last.id, status: v.action === "cancel" ? "cancelled" : "ordered", reference: last.reference, expectedDate: v.expectedDate ?? last.expectedDate, lines: last.lines, supplier, actor, reason: v.reason, createdAt: now }));
  const failure = await conflict(() => commitBatch(db, statements), replay);
  return failure ?? { purchaseOrderId: order.id, eventId: ident.id };
}
var queueCte = sql8`WITH latest AS (SELECT p.id,p.supplier_id AS supplierId,p.created_at AS createdAt,e.id AS version,e.status,e.reference,e.expected_date AS expectedDate,json_extract(e.supplier,'$.name') AS supplier,
 (SELECT count(*) FROM _ecommerce_supplier_issues i JOIN _ecommerce_purchase_order_lines l ON l.id=i.purchase_line_id WHERE l.purchase_order_id=p.id AND ${openSupplierIssue}) AS openIssues,
 COALESCE((SELECT sum(MAX(0,d.quantity-COALESCE((SELECT sum(m.delta) FROM _ecommerce_replenishment_delivery_events x JOIN _ecommerce_stock_movements m ON m.id=x.movement_id WHERE x.delivery_id=d.id),0))) FROM _ecommerce_purchase_order_lines l JOIN _ecommerce_replenishment_deliveries d ON d.id=l.delivery_id WHERE l.purchase_order_id=p.id AND NOT EXISTS(SELECT 1 FROM _ecommerce_replenishment_delivery_events x WHERE x.delivery_id=d.id AND x.kind='cancelled')),0) AS outstanding
 FROM _ecommerce_purchase_orders p JOIN _ecommerce_purchase_order_events e ON e.id=(SELECT id FROM _ecommerce_purchase_order_events WHERE purchase_order_id=p.id ORDER BY rowid DESC LIMIT 1))`;
async function listPurchaseOrders(env, input = {}) {
  const v = z7.object({ offset: z7.coerce.number().int().min(0).max(1e6).default(0), filter: z7.enum(["open", "draft", "ordered", "completed", "cancelled", "all"]).default("open"), search: z7.string().trim().max(100).default("") }).strict().parse(input), db = commerceDb(env);
  const pattern = `%${v.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, where = sql8`(reference LIKE ${pattern} ESCAPE '\\' OR supplier LIKE ${pattern} ESCAPE '\\') AND (${v.filter}='all' OR (${v.filter}='open' AND (status='draft' OR (status='ordered' AND outstanding>0) OR openIssues>0)) OR (${v.filter}='completed' AND status='ordered' AND outstanding=0) OR (${v.filter} IN ('draft','ordered','cancelled') AND status=${v.filter}))`;
  const [rows, count] = await db.batch([db.all(sql8`${queueCte} SELECT * FROM latest WHERE ${where} ORDER BY createdAt DESC,id LIMIT 50 OFFSET ${v.offset}`), db.all(sql8`${queueCte} SELECT count(*) n FROM latest WHERE ${where}`)]);
  return { ...v, total: count[0]?.n ?? 0, rows: rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt * 1e3).toISOString() })) };
}
async function readPurchaseOrder(env, input) {
  const { purchaseOrderId } = z7.object({ purchaseOrderId: id5 }).strict().parse(input), db = commerceDb(env);
  const order = await db.query.purchaseOrders.findFirst({ where: { id: purchaseOrderId }, with: { events: { orderBy: (_t, { sql: sql10 }) => sql10`rowid DESC`, limit: 200 }, lines: { with: { delivery: { with: { events: { orderBy: (_t, { sql: sql10 }) => sql10`rowid`, with: { movement: { columns: { delta: true } } } } } } } } } });
  const latest = order?.events[0];
  if (!order || !latest) throw new CommerceOperationsConflict("Purchase order not found.");
  const names = await adminActorNames(env, order.events.map((e) => e.actor)), current = await latestSupplier(env, order.supplierId);
  const deliveries = await Promise.all(order.lines.map(async (l) => {
    const d = l.delivery, stock = await db.get(sql8`WITH physical AS (${physicalStockLocations}) SELECT * FROM physical WHERE type=${d.targetType} AND id=${d.targetId}`), received = d.events.reduce((n, e) => n + (e.movement?.delta ?? 0), 0), cancelled = d.events.some((e) => e.kind === "cancelled");
    const activeIssues = await db.get(sql8`SELECT COALESCE(sum(quantity),0) AS units FROM _ecommerce_supplier_issues i WHERE purchase_line_id=${l.id} AND ${openSupplierIssue}`);
    return { purchaseLineId: l.id, issueAllowance: cancelled ? 0 : Math.max(0, d.quantity - received - (activeIssues?.units ?? 0)), lineIndex: l.lineIndex, deliveryId: d.id, version: d.events.at(-1)?.id ?? d.id, received, remaining: cancelled ? 0 : d.quantity - received, cancelled, location: stock ? { type: stock.type, id: stock.id, name: stock.name, sku: stock.sku, quantity: stock.quantity, updatedAt: new Date(stock.updated * 1e3).toISOString() } : null };
  }));
  return {
    id: order.id,
    supplierId: order.supplierId,
    currentSupplier: current ? { ...supplierSnapshot(current), active: current.active } : null,
    version: latest.id,
    status: latest.status,
    reference: latest.reference,
    expectedDate: latest.expectedDate,
    supplier: latest.supplier,
    lines: latest.lines,
    deliveries,
    history: [...order.events].reverse().map((e) => ({ id: e.id, status: e.status, reference: e.reference, expectedDate: e.expectedDate, lines: e.lines, actorName: names.get(e.actor) ?? e.actor, reason: e.reason, createdAt: e.createdAt.toISOString() })),
    historyTruncated: order.events.length === 200
  };
}

// src/operations-report.ts
import { sql as sql9 } from "drizzle-orm";
import { z as z8 } from "zod";
var day2 = z8.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && (/* @__PURE__ */ new Date(`${v}T00:00:00Z`)).toISOString().slice(0, 10) === v);
async function readOperationsReport(env, input = {}) {
  const now = Math.floor(Date.now() / 1e3), today = new Date(now * 1e3).toISOString().slice(0, 10);
  const v = z8.object({ start: day2.default(new Date((now - 29 * 86400) * 1e3).toISOString().slice(0, 10)), end: day2.default(today) }).strict().refine((v2) => v2.start <= v2.end && (Date.parse(v2.end) - Date.parse(v2.start)) / 864e5 < 366, "Choose at most 366 UTC days").parse(input);
  const start = Date.parse(v.start) / 1e3, end = Date.parse(v.end) / 1e3 + 86400, db = commerceDb(env), period = (column) => sql9`${column}>=${start} AND ${column}<${end}`;
  const [reasons, conditions, resolved, shipping, incoming, backlog] = await db.batch([
    db.all(sql9`SELECT COALESCE(c.code,'unspecified') AS code,count(*) AS requests FROM _ecommerce_return_requests r JOIN _ecommerce_orders o ON o.id=r.order_id LEFT JOIN _ecommerce_return_request_reasons c ON c.request_id=r.id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND ${period(sql9`r.created_at`)} GROUP BY COALESCE(c.code,'unspecified')`),
    db.all(sql9`SELECT json_extract(i.value,'$.condition') AS condition,sum(json_extract(i.value,'$.quantity')) AS units,count(DISTINCT r.id) AS receipts FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id,json_each(r.items) i WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND ${period(sql9`r.created_at`)} GROUP BY json_extract(i.value,'$.condition')`),
    db.all(sql9`SELECT d.status,count(*) AS returns,avg(MAX(0,d.created_at-r.created_at)) AS averageSeconds FROM _ecommerce_return_refund_decisions d JOIN _ecommerce_return_receipts r ON r.id=d.receipt_id JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND d.status IN ('settled','not_needed') AND d.rowid=(SELECT rowid FROM _ecommerce_return_refund_decisions WHERE receipt_id=d.receipt_id ORDER BY rowid DESC LIMIT 1) AND ${period(sql9`d.created_at`)} GROUP BY d.status`),
    db.all(sql9`WITH dispatched AS (SELECT f.order_id,min(f.created_at) AS shippedAt,(SELECT min(created_at) FROM _ecommerce_payments p WHERE p.order_id=f.order_id AND p.status IN ('success','partially_refunded','refunded')) AS paidAt FROM _ecommerce_fulfillments f JOIN _ecommerce_orders o ON o.id=f.order_id WHERE f.kind='shipment' AND COALESCE(o.payment_provider,'stripe')<>'admin_test' GROUP BY f.order_id) SELECT count(*) AS orders,avg(MAX(0,shippedAt-paidAt)) AS averageSeconds FROM dispatched WHERE paidAt IS NOT NULL AND ${period(sql9`shippedAt`)} AND shippedAt>=paidAt`),
    db.all(sql9`WITH incoming AS (SELECT d.id,${effectiveDeliveryDate} AS due,MAX(0,d.quantity-COALESCE((SELECT sum(m.delta) FROM _ecommerce_replenishment_delivery_events e JOIN _ecommerce_stock_movements m ON m.id=e.movement_id WHERE e.delivery_id=d.id),0)) AS remaining FROM _ecommerce_replenishment_deliveries d WHERE NOT EXISTS(SELECT 1 FROM _ecommerce_replenishment_delivery_events e WHERE e.delivery_id=d.id AND e.kind='cancelled')) SELECT count(*) AS deliveries,COALESCE(sum(remaining),0) AS units,min(due) AS oldestDate FROM incoming WHERE remaining>0 AND due<${today}`),
    db.all(sql9`WITH work AS (
   SELECT 'shipping' AS kind,o.id,COALESCE((SELECT min(created_at) FROM _ecommerce_payments p WHERE p.order_id=o.id AND p.status IN ('success','partially_refunded','refunded')),o.created_at) AS since FROM _ecommerce_orders o WHERE o.status IN ('paid','partially_refunded') AND o.fulfillment_status<>'fulfilled' AND COALESCE(o.payment_provider,'stripe')<>'admin_test'
   UNION ALL SELECT 'refund',r.id,r.created_at FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND NOT EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a WHERE a.account_id=o.user_id AND a.action='anonymize') AND COALESCE((SELECT status FROM _ecommerce_return_refund_decisions d WHERE d.receipt_id=r.id ORDER BY rowid DESC LIMIT 1),'review') IN ('review','needed')
   UNION ALL SELECT 'returns',r.id,r.created_at FROM _ecommerce_return_requests r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE r.redacted_at IS NULL AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND COALESCE((SELECT status FROM _ecommerce_return_request_events e WHERE e.request_id=r.id ORDER BY rowid DESC LIMIT 1),'pending') IN ('pending','approved')
   UNION ALL SELECT 'supplier',i.id,i.created_at FROM _ecommerce_supplier_issues i WHERE ${openSupplierIssue}
   UNION ALL SELECT 'recovery',c.id,c.created_at FROM _ecommerce_recovery_cases c WHERE ${openRecoveryCase}) SELECT kind,count(*) AS count,min(since) AS oldestAt FROM work GROUP BY kind`)
  ]);
  return {
    ...v,
    startAt: new Date(start * 1e3).toISOString(),
    endBefore: new Date(end * 1e3).toISOString(),
    asOf: new Date(now * 1e3).toISOString(),
    reasons,
    conditions,
    resolutions: resolved.map((r) => ({ ...r, averageHours: r.averageSeconds / 3600 })),
    firstShipment: { orders: shipping[0]?.orders ?? 0, averageHours: shipping[0]?.averageSeconds == null ? null : shipping[0].averageSeconds / 3600 },
    overdueDeliveries: incoming[0] ?? { deliveries: 0, units: 0, oldestDate: null },
    backlog: backlog.map((r) => ({ kind: r.kind, count: r.count, oldestAt: r.oldestAt === null ? null : new Date(r.oldestAt * 1e3).toISOString(), oldestHours: r.oldestAt === null ? null : Math.max(0, now - r.oldestAt) / 3600 }))
  };
}

export {
  listReplenishment,
  readReplenishment,
  saveReplenishmentPolicy,
  planReplenishmentDelivery,
  recordReplenishmentDelivery,
  createRecoveryCase,
  recordRecoveryEvent,
  shipRecoveryCase,
  listRecoveryCases,
  readRecoveryCase,
  readRecoveryOrder,
  listExchangeChoices,
  reportSupplierIssue,
  recordSupplierIssue,
  listSupplierIssues,
  readSupplierIssue,
  readCommerceAttention,
  readStockOverview,
  OperationsExportLimit,
  exportCommerceOperations,
  listRefundFollowUp,
  readRefundCase,
  recordRefundFollowUp,
  listSuppliers,
  saveSupplier,
  savePurchaseOrder,
  recordPurchaseOrder,
  listPurchaseOrders,
  readPurchaseOrder,
  readOperationsReport
};
