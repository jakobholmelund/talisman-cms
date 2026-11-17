import {
  commerceDb,
  errorText
} from "./chunk-SXQHVX4E.js";
import {
  productVariantValues,
  productVariants,
  products,
  stocks,
  variantComponents
} from "./chunk-PLAJXKV3.js";

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
    priceOverride: z.number({ error: "Price override must be a whole number in the smallest currency unit" }).int("Price override must be a whole number in the smallest currency unit").positive("Price override must be more than zero").max(Number.MAX_SAFE_INTEGER, "Price override is too large").nullable()
  }).strict(),
  // Left out, a saved value's stock is not written: checkout reserves stock in place, so writing back
  // the quantity loaded with the page would undo reservations made since.
  stock: z.object({
    id: recordId.optional(),
    expectedUpdatedAt: loadedToken.optional(),
    quantity: z.number({ error: "Stock must be a whole number" }).int("Stock must be a whole number").nonnegative("Stock cannot be negative").max(Number.MAX_SAFE_INTEGER, "Stock is too large")
  }).strict().optional()
}).strict();
var variantChangeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("createOptionSet"), productId: recordId, requestKey: z.string().uuid(), name: z.string().trim().min(1).max(200), values: z.array(z.string().trim().min(1).max(200)).min(1).max(50).refine((values) => new Set(values.map((v) => v.toLowerCase())).size === values.length, "Each choice needs a different name"), images: z.array(z.string().trim().max(2048).nullable()).max(50).optional() }).strict().refine((v) => !v.images || v.images.length === v.values.length, "Choose one image per variant"),
  z.object({ action: z.literal("addOptionValues"), productId: recordId, groupId: recordId, expectedUpdatedAt: loadedToken, requestKey: z.string().uuid(), values: z.array(z.string().trim().min(1).max(200)).min(1).max(50).refine((values) => new Set(values.map((v) => v.toLowerCase())).size === values.length, "Each choice needs a different name"), images: z.array(z.string().trim().max(2048).nullable()).max(50) }).strict().refine((v) => v.images.length === v.values.length, "Choose one image per variant"),
  z.object({ action: z.literal("setVariantImages"), groupId: recordId, image: optionalText(2048, "Variant image"), values: z.array(z.object({ id: recordId, expectedUpdatedAt: loadedToken }).strict()).min(1).max(50).refine((values) => new Set(values.map((v) => v.id)).size === values.length, "Choose each variant once") }).strict(),
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
  if (change.action === "setVariantImages") {
    const db = commerceDb(env), now = Math.floor(Date.now() / 1e3);
    const current = await db.select().from(productVariantValues).where(and(eq(productVariantValues.productVariantId, change.groupId), inArray(productVariantValues.id, change.values.map((v) => v.id))));
    if (current.length !== change.values.length) throw staleRecord();
    const changed = change.values.filter((value) => current.find((row) => row.id === value.id)?.image !== change.image);
    if (changed.length) await runBatch(db, changed.flatMap((value) => [
      staleGuard(db, notExists(db.select({ one: sql`1` }).from(productVariantValues).where(and(eq(productVariantValues.id, value.id), eq(productVariantValues.productVariantId, change.groupId), eq(productVariantValues.updatedAt, at(storedSeconds(value.expectedUpdatedAt, "variant value"))))))),
      db.update(productVariantValues).set({ image: change.image, updatedAt: movedUpdatedAt(productVariantValues.updatedAt, now) }).where(eq(productVariantValues.id, value.id))
    ]));
    await clearCachedRows(env, { _ecommerce_product_variant_values: change.values.map((v) => v.id) });
    return { groupId: change.groupId, count: change.values.length };
  }
  if (change.action === "addOptionValues") {
    const db = commerceDb(env), prefix = `setup_${change.requestKey}`;
    const ids = change.values.map((_, index) => `${prefix}_${index}`);
    const replay = async () => {
      const rows = await db.select().from(productVariantValues).where(inArray(productVariantValues.id, ids));
      if (!rows.length) return false;
      if (rows.length !== ids.length || change.values.some((label, index) => !rows.some((row) => row.id === ids[index] && row.productVariantId === change.groupId && row.value === label && (row.image || null) === (change.images[index] || null)))) throw new VariantChangeError(409, "These additions were already saved with different details. Refresh the product to review them.");
      return true;
    };
    const group = await db.select().from(productVariants).where(and(eq(productVariants.id, change.groupId), eq(productVariants.productId, change.productId))).get();
    if (!group) throw new VariantChangeError(404, "This option set is no longer available. Refresh the product.");
    if (!await replay()) {
      const existing = await db.select({ value: productVariantValues.value }).from(productVariantValues).where(eq(productVariantValues.productVariantId, change.groupId));
      const names = new Set(existing.map((row) => row.value.toLowerCase()));
      if (change.values.some((value) => names.has(value.toLowerCase()))) throw new VariantChangeError(409, "Some of these variants already exist. Refresh the product to review the missing combinations.");
      const now = Math.floor(Date.now() / 1e3);
      try {
        await runBatch(db, [
          staleGuard(db, notExists(db.select({ one: sql`1` }).from(productVariants).where(and(eq(productVariants.id, change.groupId), eq(productVariants.updatedAt, at(storedSeconds(change.expectedUpdatedAt, "option set"))))))),
          db.update(productVariants).set({ updatedAt: movedUpdatedAt(productVariants.updatedAt, now) }).where(eq(productVariants.id, change.groupId)),
          ...Array.from({ length: Math.ceil(ids.length / 10) }, (_, chunk) => {
            const entries = change.values.slice(chunk * 10, chunk * 10 + 10).map((value, index) => ({ id: ids[chunk * 10 + index], productVariantId: change.groupId, value, image: change.images[chunk * 10 + index] || null, createdAt: at(now), updatedAt: at(now) }));
            return [staleGuard(db, exists(db.select({ one: sql`1` }).from(productVariantValues).where(and(eq(productVariantValues.productVariantId, change.groupId), inArray(sql`lower(${productVariantValues.value})`, entries.map((e) => e.value.toLowerCase())))))), db.insert(productVariantValues).values(entries), db.insert(stocks).values(entries.map((row) => ({ id: `stock_${row.id}`, productVariantValueId: row.id, quantity: 0, createdAt: at(now), updatedAt: at(now) })))];
          }).flat()
        ]);
      } catch (error) {
        if (!await replay()) throw error;
      }
    }
    await clearCachedRows(env, { _ecommerce_product_variants: [change.groupId], _ecommerce_product_variant_values: ids, _ecommerce_stocks: ids.map((id) => `stock_${id}`) });
    return { groupId: change.groupId };
  }
  if (change.action === "createOptionSet") {
    const db = commerceDb(env), groupId = `setup_${change.requestKey}`;
    const replay = async () => {
      const group = await db.select().from(productVariants).where(eq(productVariants.id, groupId)).get();
      if (!group) return false;
      const values = await db.select().from(productVariantValues).where(eq(productVariantValues.productVariantId, groupId));
      if (group.productId !== change.productId || group.name !== change.name || values.length !== change.values.length || change.values.some((value, index) => !values.some((row) => row.id === `${groupId}_${index}` && row.value === value && (row.image || null) === (change.images?.[index] || null)))) throw new VariantChangeError(409, "This setup has already been saved with different details. Refresh the product to review it.");
      return true;
    };
    if (!await replay()) {
      if (!await db.select({ id: products.id }).from(products).where(eq(products.id, change.productId)).get()) throw new VariantChangeError(404, "Save the product before adding choices.");
      const now = /* @__PURE__ */ new Date();
      try {
        await db.batch([
          db.insert(productVariants).values({ id: groupId, productId: change.productId, name: change.name, createdAt: now, updatedAt: now }),
          ...Array.from({ length: Math.ceil(change.values.length / 10) }, (_, chunk) => {
            const rows = change.values.slice(chunk * 10, chunk * 10 + 10).map((value, index) => ({ id: `${groupId}_${chunk * 10 + index}`, productVariantId: groupId, value, image: change.images?.[chunk * 10 + index] || null, createdAt: now, updatedAt: now }));
            return [db.insert(productVariantValues).values(rows), db.insert(stocks).values(rows.map((row) => ({ id: `stock_${row.id}`, productVariantValueId: row.id, quantity: 0, createdAt: now, updatedAt: now })))];
          }).flat()
        ]);
      } catch (error) {
        if (!await replay()) throw error;
      }
    }
    await clearCachedRows(env, { _ecommerce_product_variants: [groupId], _ecommerce_product_variant_values: change.values.map((_, i) => `${groupId}_${i}`), _ecommerce_stocks: change.values.map((_, i) => `stock_${groupId}_${i}`) });
    return { groupId };
  }
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
