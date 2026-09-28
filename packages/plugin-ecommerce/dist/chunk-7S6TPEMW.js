import {
  commerceDb,
  errorText
} from "./chunk-DUYAQ7V4.js";
import {
  productVariantValues,
  productVariants,
  stocks,
  variantComponents
} from "./chunk-NKJTK7MK.js";

// src/variants.ts
import { and, eq, exists, inArray, notExists, or, sql } from "drizzle-orm";
import { z } from "zod";
import { invalidateEntryCache } from "talisman-cms/client";
var VariantChangeError = class extends Error {
  status;
  /** `stale_record` when a loaded token no longer matches, which the admin recognises. */
  code;
  constructor(status, message, code) {
    super(message);
    this.name = "VariantChangeError";
    this.status = status;
    this.code = code;
  }
};
var staleRecord = () => new VariantChangeError(
  409,
  "This record changed since it was opened. Reload it before saving.",
  "stale_record"
);
var STALE_MARKER = "stale_record";
var staleGuard = (db, condition) => db.get(sql`SELECT CASE WHEN ${condition} THEN ${sql.raw(`json_extract('{}', '$${STALE_MARKER}')`)} END AS conflict`);
var at = (seconds) => new Date(seconds * 1e3);
var movedUpdatedAt = (column, now) => sql`MAX(${column} + 1, ${now})`;
var recordId = z.string().min(1).max(128);
var loadedToken = z.union([z.string().min(1).max(64), z.number()]);
var optionalText = (max, label) => z.string().trim().max(max, `${label} must be at most ${max} characters`).nullable().transform((text) => text || null);
var saveValueInput = z.object({
  groupId: recordId,
  value: z.object({
    id: recordId.optional(),
    expectedUpdatedAt: loadedToken.optional(),
    value: z.string().trim().min(1, "Variant value label is required").max(200, "Variant value label must be at most 200 characters"),
    sku: optionalText(200, "SKU"),
    image: optionalText(2048, "Variant image"),
    priceOverride: z.number({ invalid_type_error: "Price override must be a whole number in the smallest currency unit" }).int("Price override must be a whole number in the smallest currency unit").positive("Price override must be more than zero").max(Number.MAX_SAFE_INTEGER, "Price override is too large").nullable()
  }).strict(),
  // Left out, a saved value's stock is not written: checkout reserves stock in place, so writing back
  // the quantity loaded with the page would undo reservations made since.
  stock: z.object({
    id: recordId.optional(),
    expectedUpdatedAt: loadedToken.optional(),
    quantity: z.number({ invalid_type_error: "Stock must be a whole number" }).int("Stock must be a whole number").nonnegative("Stock cannot be negative").max(Number.MAX_SAFE_INTEGER, "Stock is too large")
  }).strict().optional()
}).strict();
var variantChangeSchema = z.discriminatedUnion("action", [
  saveValueInput.extend({ action: z.literal("saveValue") }),
  z.object({ action: z.literal("deleteValue"), valueId: recordId }).strict(),
  z.object({ action: z.literal("deleteGroup"), groupId: recordId }).strict()
]);
function parseChange(schema, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new VariantChangeError(400, parsed.error.issues[0]?.message ?? "Invalid variant change");
  return parsed.data;
}
function storedSeconds(token, record) {
  if (token === void 0) {
    throw new VariantChangeError(428, `expectedUpdatedAt is required to change a saved ${record}`);
  }
  const milliseconds = typeof token === "number" ? token : Date.parse(token);
  if (!Number.isSafeInteger(milliseconds) || milliseconds % 1e3 !== 0) throw staleRecord();
  return milliseconds / 1e3;
}
var returnedIds = (rows) => (rows ?? []).map((row) => row.id);
async function clearCachedRows(env, written) {
  try {
    await Promise.all(Object.entries(written).filter(([, ids]) => ids.length).map(([collectionSlug, ids]) => invalidateEntryCache(env, collectionSlug, ids)));
  } catch (error) {
    console.warn("[commerce] Cached variant rows could not be cleared", error instanceof Error ? { name: error.name, message: error.message } : { name: typeof error });
  }
}
async function runBatch(db, statements) {
  try {
    return await db.batch(statements);
  } catch (error) {
    const text = errorText(error);
    if (text.includes(STALE_MARKER)) throw staleRecord();
    if (/UNIQUE constraint failed: _ecommerce_product_variant_values\.sku/.test(text)) {
      throw new VariantChangeError(409, "Another record already uses this sku.");
    }
    if (/UNIQUE constraint failed: _ecommerce_stocks\.product_variant_value_id/.test(text)) throw staleRecord();
    if (/FOREIGN KEY constraint failed/.test(text)) {
      throw new VariantChangeError(409, "This change conflicts with a related record.");
    }
    throw error;
  }
}
async function saveVariantValue(env, input) {
  const { groupId, value, stock } = parseChange(saveValueInput, input);
  if (!value.id && stock?.id) throw new VariantChangeError(400, "A new variant value has no stock row yet");
  const now = Math.floor(Date.now() / 1e3);
  const valueId = value.id ?? `value_${crypto.randomUUID()}`;
  const db = commerceDb(env);
  const one = { one: sql`1` };
  const conditions = [];
  if (value.id) {
    conditions.push(notExists(db.select(one).from(productVariantValues).where(and(
      eq(productVariantValues.id, valueId),
      eq(productVariantValues.productVariantId, groupId),
      eq(productVariantValues.updatedAt, at(storedSeconds(value.expectedUpdatedAt, "variant value")))
    ))));
  } else {
    conditions.push(notExists(db.select(one).from(productVariants).where(eq(productVariants.id, groupId))));
  }
  if (stock?.id) {
    conditions.push(notExists(db.select(one).from(stocks).where(and(
      eq(stocks.id, stock.id),
      eq(stocks.productVariantValueId, valueId),
      eq(stocks.updatedAt, at(storedSeconds(stock.expectedUpdatedAt, "stock row")))
    ))));
  } else if (stock && value.id) {
    conditions.push(exists(db.select(one).from(stocks).where(eq(stocks.productVariantValueId, valueId))));
  }
  const guard = staleGuard(db, or(...conditions) ?? conditions[0]);
  const valueWrite = value.id ? db.update(productVariantValues).set({
    value: value.value,
    sku: value.sku,
    image: value.image,
    priceOverride: value.priceOverride,
    updatedAt: movedUpdatedAt(productVariantValues.updatedAt, now)
  }).where(eq(productVariantValues.id, valueId)).returning({ id: productVariantValues.id, updatedAt: productVariantValues.updatedAt }) : db.insert(productVariantValues).values({
    id: valueId,
    productVariantId: groupId,
    value: value.value,
    sku: value.sku,
    image: value.image,
    priceOverride: value.priceOverride,
    createdAt: at(now),
    updatedAt: at(now)
  }).returning({ id: productVariantValues.id, updatedAt: productVariantValues.updatedAt });
  const stockWrite = stock?.id ? db.update(stocks).set({ quantity: stock.quantity, updatedAt: movedUpdatedAt(stocks.updatedAt, now) }).where(eq(stocks.id, stock.id)).returning({ id: stocks.id, quantity: stocks.quantity, updatedAt: stocks.updatedAt }) : stock || !value.id ? db.insert(stocks).values({
    id: `stock_${crypto.randomUUID()}`,
    productVariantValueId: valueId,
    quantity: stock?.quantity ?? 0,
    createdAt: at(now),
    updatedAt: at(now)
  }).returning({ id: stocks.id, quantity: stocks.quantity, updatedAt: stocks.updatedAt }) : null;
  const [, savedValues, savedStocks] = stockWrite ? await runBatch(db, [guard, valueWrite, stockWrite]) : [...await runBatch(db, [guard, valueWrite]), void 0];
  const savedValue = savedValues[0];
  const savedStock = savedStocks?.[0];
  if (!savedValue) throw staleRecord();
  await clearCachedRows(env, {
    _ecommerce_product_variant_values: returnedIds(savedValues),
    _ecommerce_stocks: returnedIds(savedStocks)
  });
  return {
    value: { id: savedValue.id, updatedAt: savedValue.updatedAt.toISOString() },
    stock: savedStock ? { id: savedStock.id, quantity: savedStock.quantity, updatedAt: savedStock.updatedAt.toISOString() } : null
  };
}
async function deleteVariantValue(env, valueId) {
  const db = commerceDb(env);
  const [parts, stockRows, values] = await runBatch(db, [
    db.delete(variantComponents).where(eq(variantComponents.productVariantValueId, valueId)).returning({ id: variantComponents.id }),
    db.delete(stocks).where(eq(stocks.productVariantValueId, valueId)).returning({ id: stocks.id }),
    db.delete(productVariantValues).where(eq(productVariantValues.id, valueId)).returning({ id: productVariantValues.id })
  ]);
  if (!values.length) throw new VariantChangeError(404, "Variant value not found");
  await clearCachedRows(env, {
    _ecommerce_variant_components: returnedIds(parts),
    _ecommerce_stocks: returnedIds(stockRows),
    _ecommerce_product_variant_values: returnedIds(values)
  });
  return { valueId, deleted: { values: 1, stockRows: stockRows.length, partRows: parts.length } };
}
async function deleteVariantGroup(env, groupId) {
  const db = commerceDb(env);
  const groupValues = db.select({ id: productVariantValues.id }).from(productVariantValues).where(eq(productVariantValues.productVariantId, groupId));
  const [parts, stockRows, values, groups] = await runBatch(db, [
    db.delete(variantComponents).where(inArray(variantComponents.productVariantValueId, groupValues)).returning({ id: variantComponents.id }),
    db.delete(stocks).where(inArray(stocks.productVariantValueId, groupValues)).returning({ id: stocks.id }),
    db.delete(productVariantValues).where(eq(productVariantValues.productVariantId, groupId)).returning({ id: productVariantValues.id }),
    db.delete(productVariants).where(eq(productVariants.id, groupId)).returning({ id: productVariants.id })
  ]);
  if (!groups.length) throw new VariantChangeError(404, "Variant group not found");
  await clearCachedRows(env, {
    _ecommerce_variant_components: returnedIds(parts),
    _ecommerce_stocks: returnedIds(stockRows),
    _ecommerce_product_variant_values: returnedIds(values),
    _ecommerce_product_variants: returnedIds(groups)
  });
  return { groupId, deleted: { values: values.length, stockRows: stockRows.length, partRows: parts.length } };
}
async function runVariantChange(env, body) {
  const change = parseChange(variantChangeSchema, body);
  if (change.action === "saveValue") {
    const { action: _action, ...input } = change;
    return saveVariantValue(env, input);
  }
  if (change.action === "deleteValue") return deleteVariantValue(env, change.valueId);
  return deleteVariantGroup(env, change.groupId);
}

export {
  VariantChangeError,
  variantChangeSchema,
  saveVariantValue,
  deleteVariantValue,
  deleteVariantGroup,
  runVariantChange
};
