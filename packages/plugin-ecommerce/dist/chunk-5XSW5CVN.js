// src/variants.ts
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
var staleGuard = (condition) => `SELECT CASE WHEN ${condition} THEN json_extract('{}', '$${STALE_MARKER}') END AS conflict`;
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
var loadedTimestamp = (seconds) => new Date(seconds * 1e3).toISOString();
function errorText(error) {
  const messages = [];
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    if (typeof current.message === "string") messages.push(current.message);
  }
  return messages.join("\n");
}
var returnedIds = (result) => (result?.results ?? []).map((row) => String(row.id));
async function clearCachedRows(env, written) {
  try {
    await Promise.all(Object.entries(written).filter(([, ids]) => ids.length).map(([collectionSlug, ids]) => invalidateEntryCache(env, collectionSlug, ids)));
  } catch (error) {
    console.warn("[commerce] Cached variant rows could not be cleared", error instanceof Error ? { name: error.name, message: error.message } : { name: typeof error });
  }
}
async function runBatch(env, statements) {
  try {
    return await env.DB.batch(statements);
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
  const conditions = [];
  const params = [];
  if (value.id) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM _ecommerce_product_variant_values
      WHERE id = ? AND product_variant_id = ? AND updated_at = ?)`);
    params.push(valueId, groupId, storedSeconds(value.expectedUpdatedAt, "variant value"));
  } else {
    conditions.push("NOT EXISTS (SELECT 1 FROM _ecommerce_product_variants WHERE id = ?)");
    params.push(groupId);
  }
  if (stock?.id) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM _ecommerce_stocks
      WHERE id = ? AND product_variant_value_id = ? AND updated_at = ?)`);
    params.push(stock.id, valueId, storedSeconds(stock.expectedUpdatedAt, "stock row"));
  } else if (stock && value.id) {
    conditions.push("EXISTS (SELECT 1 FROM _ecommerce_stocks WHERE product_variant_value_id = ?)");
    params.push(valueId);
  }
  const statements = [env.DB.prepare(staleGuard(conditions.join(" OR "))).bind(...params)];
  statements.push(value.id ? env.DB.prepare(`UPDATE _ecommerce_product_variant_values
        SET value = ?, sku = ?, image = ?, price_override = ?, updated_at = MAX(updated_at + 1, ?)
        WHERE id = ? RETURNING id, updated_at`).bind(value.value, value.sku, value.image, value.priceOverride, now, valueId) : env.DB.prepare(`INSERT INTO _ecommerce_product_variant_values
        (id, product_variant_id, value, sku, image, price_override, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, updated_at`).bind(valueId, groupId, value.value, value.sku, value.image, value.priceOverride, now, now));
  if (stock?.id) {
    statements.push(env.DB.prepare(`UPDATE _ecommerce_stocks
      SET quantity = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ? RETURNING id, quantity, updated_at`).bind(stock.quantity, now, stock.id));
  } else if (stock || !value.id) {
    statements.push(env.DB.prepare(`INSERT INTO _ecommerce_stocks
      (id, product_variant_value_id, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      RETURNING id, quantity, updated_at`).bind(`stock_${crypto.randomUUID()}`, valueId, stock?.quantity ?? 0, now, now));
  }
  const results = await runBatch(env, statements);
  const savedValue = results[1]?.results?.[0];
  const savedStock = results[2]?.results?.[0];
  if (!savedValue) throw staleRecord();
  await clearCachedRows(env, {
    _ecommerce_product_variant_values: returnedIds(results[1]),
    _ecommerce_stocks: returnedIds(results[2])
  });
  return {
    value: { id: String(savedValue.id), updatedAt: loadedTimestamp(Number(savedValue.updated_at)) },
    stock: savedStock ? {
      id: String(savedStock.id),
      quantity: Number(savedStock.quantity),
      updatedAt: loadedTimestamp(Number(savedStock.updated_at))
    } : null
  };
}
async function deleteVariantValue(env, valueId) {
  const results = await runBatch(env, [
    env.DB.prepare("DELETE FROM _ecommerce_variant_components WHERE product_variant_value_id = ? RETURNING id").bind(valueId),
    env.DB.prepare("DELETE FROM _ecommerce_stocks WHERE product_variant_value_id = ? RETURNING id").bind(valueId),
    env.DB.prepare("DELETE FROM _ecommerce_product_variant_values WHERE id = ? RETURNING id").bind(valueId)
  ]);
  if (!results[2]?.results?.length) throw new VariantChangeError(404, "Variant value not found");
  await clearCachedRows(env, {
    _ecommerce_variant_components: returnedIds(results[0]),
    _ecommerce_stocks: returnedIds(results[1]),
    _ecommerce_product_variant_values: returnedIds(results[2])
  });
  return { valueId, deleted: {
    values: 1,
    stockRows: results[1]?.results?.length ?? 0,
    partRows: results[0]?.results?.length ?? 0
  } };
}
async function deleteVariantGroup(env, groupId) {
  const groupValues = "SELECT id FROM _ecommerce_product_variant_values WHERE product_variant_id = ?";
  const results = await runBatch(env, [
    env.DB.prepare(`DELETE FROM _ecommerce_variant_components WHERE product_variant_value_id IN (${groupValues})
      RETURNING id`).bind(groupId),
    env.DB.prepare(`DELETE FROM _ecommerce_stocks WHERE product_variant_value_id IN (${groupValues})
      RETURNING id`).bind(groupId),
    env.DB.prepare("DELETE FROM _ecommerce_product_variant_values WHERE product_variant_id = ? RETURNING id").bind(groupId),
    env.DB.prepare("DELETE FROM _ecommerce_product_variants WHERE id = ? RETURNING id").bind(groupId)
  ]);
  if (!results[3]?.results?.length) throw new VariantChangeError(404, "Variant group not found");
  await clearCachedRows(env, {
    _ecommerce_variant_components: returnedIds(results[0]),
    _ecommerce_stocks: returnedIds(results[1]),
    _ecommerce_product_variant_values: returnedIds(results[2]),
    _ecommerce_product_variants: returnedIds(results[3])
  });
  return { groupId, deleted: {
    values: results[2]?.results?.length ?? 0,
    stockRows: results[1]?.results?.length ?? 0,
    partRows: results[0]?.results?.length ?? 0
  } };
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
