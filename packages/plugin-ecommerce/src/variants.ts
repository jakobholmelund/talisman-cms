import { and, eq, exists, inArray, notExists, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { z } from 'zod';
import { invalidateEntryCache, type TalismanEnv } from 'talisman-cms/client';
import { commerceDb, errorText, type CommerceDb } from './db';
import { productVariantValues, productVariants, stocks, variantComponents } from './schema';

/**
 * Changes the product editor's variant configurator makes: save a variant value together with its
 * stock row, delete a value, or delete a group with its values. Each change is one D1 batch, so a
 * failure leaves nothing half-saved and a retry cannot create a second value. The batches write the
 * tables directly, so no collection hooks run; the core's cached reads of the rows are cleared afterwards.
 */

/** A refused change, with the HTTP status and message the admin route answers. */
export class VariantChangeError extends Error {
  status: number;
  /** `stale_record` when a loaded token no longer matches, which the admin recognises. */
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'VariantChangeError';
    this.status = status;
    this.code = code;
  }
}

// The core API's answer to a stale native save, so the editor offers to load the latest rows. The code
// lets the editor recognise the conflict without matching the text.
const staleRecord = () => new VariantChangeError(409,
  'This record changed since it was opened. Reload it before saving.', 'stale_record');

// D1 rolls a batch back only when one of its statements fails, and RAISE() works only in triggers.
// This JSON path is invalid, so json_extract fails, and SQLite evaluates it only when the condition
// holds: the first statement of a batch then aborts the whole batch.
const STALE_MARKER = 'stale_record';
const staleGuard = (db: Db, condition: SQL) =>
  db.get(sql`SELECT CASE WHEN ${condition} THEN ${sql.raw(`json_extract('{}', '$${STALE_MARKER}')`)} END AS conflict`);

type Db = CommerceDb;
type Batch = readonly [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]];
/** A time in Unix seconds as the schema's timestamp columns take it. */
const at = (seconds: number) => new Date(seconds * 1000);
/** The updated_at a write stores: at least one second past the stored value, so a stale save is detected within a second. */
const movedUpdatedAt = (column: AnyColumn, now: number) => sql`MAX(${column} + 1, ${now})`;

const recordId = z.string().min(1).max(128);
// The row's updatedAt as the editor loaded it: an ISO date, or milliseconds.
const loadedToken = z.union([z.string().min(1).max(64), z.number()]);
const optionalText = (max: number, label: string) => z.string().trim()
  .max(max, `${label} must be at most ${max} characters`).nullable().transform((text) => text || null);

const saveValueInput = z.object({
  groupId: recordId,
  value: z.object({
    id: recordId.optional(),
    expectedUpdatedAt: loadedToken.optional(),
    value: z.string().trim().min(1, 'Variant value label is required')
      .max(200, 'Variant value label must be at most 200 characters'),
    sku: optionalText(200, 'SKU'),
    image: optionalText(2048, 'Variant image'),
    priceOverride: z.number({ invalid_type_error: 'Price override must be a whole number in the smallest currency unit' })
      .int('Price override must be a whole number in the smallest currency unit').positive('Price override must be more than zero')
      .max(Number.MAX_SAFE_INTEGER, 'Price override is too large').nullable(),
  }).strict(),
  // Left out, a saved value's stock is not written: checkout reserves stock in place, so writing back
  // the quantity loaded with the page would undo reservations made since.
  stock: z.object({
    id: recordId.optional(),
    expectedUpdatedAt: loadedToken.optional(),
    quantity: z.number({ invalid_type_error: 'Stock must be a whole number' })
      .int('Stock must be a whole number').nonnegative('Stock cannot be negative')
      .max(Number.MAX_SAFE_INTEGER, 'Stock is too large'),
  }).strict().optional(),
}).strict();

/** A request to the admin variants endpoint. */
export const variantChangeSchema = z.discriminatedUnion('action', [
  saveValueInput.extend({ action: z.literal('saveValue') }),
  z.object({ action: z.literal('deleteValue'), valueId: recordId }).strict(),
  z.object({ action: z.literal('deleteGroup'), groupId: recordId }).strict(),
]);

export type SaveVariantValueInput = z.input<typeof saveValueInput>;

/** The input as the schema reads it, or a 400 with the first problem, worded for the admin. */
function parseChange<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new VariantChangeError(400, parsed.error.issues[0]?.message ?? 'Invalid variant change');
  return parsed.data;
}

/** The stored updated_at, in whole seconds, that a loaded token stands for. */
function storedSeconds(token: string | number | undefined, record: string) {
  if (token === undefined) {
    throw new VariantChangeError(428, `expectedUpdatedAt is required to change a saved ${record}`);
  }
  const milliseconds = typeof token === 'number' ? token : Date.parse(token);
  // Stored values are whole seconds, so any other token cannot match: the editor's copy is stale.
  if (!Number.isSafeInteger(milliseconds) || milliseconds % 1000 !== 0) throw staleRecord();
  return milliseconds / 1000;
}

/** The ids a statement's RETURNING clause gave back. */
const returnedIds = (rows: Array<{ id: string }> | undefined) => (rows ?? []).map((row) => row.id);

/**
 * Drop the cached reads of the rows a committed change wrote, keyed by collection slug, as the core
 * API does after its saves: a storefront that opts into caching (`cache: true`) is served depth-0
 * reads of these collections from KV for up to a minute. The change is saved either way, so a
 * failure here is only logged.
 */
async function clearCachedRows(env: TalismanEnv, written: Record<string, string[]>) {
  try {
    await Promise.all(Object.entries(written).filter(([, ids]) => ids.length)
      .map(([collectionSlug, ids]) => invalidateEntryCache(env, collectionSlug, ids)));
  } catch (error) {
    console.warn('[commerce] Cached variant rows could not be cleared', error instanceof Error
      ? { name: error.name, message: error.message } : { name: typeof error });
  }
}

async function runBatch<T extends Batch>(db: Db, statements: T) {
  try {
    return await db.batch(statements);
  } catch (error) {
    const text = errorText(error);
    if (text.includes(STALE_MARKER)) throw staleRecord();
    // Worded like the core API's answer to the same conflict.
    if (/UNIQUE constraint failed: _ecommerce_product_variant_values\.sku/.test(text)) {
      throw new VariantChangeError(409, 'Another record already uses this sku.');
    }
    // A stock row created for the value after the editor loaded it.
    if (/UNIQUE constraint failed: _ecommerce_stocks\.product_variant_value_id/.test(text)) throw staleRecord();
    if (/FOREIGN KEY constraint failed/.test(text)) {
      throw new VariantChangeError(409, 'This change conflicts with a related record.');
    }
    throw error;
  }
}

/**
 * Create a value with its stock row, or update a value and, when the input has `stock`, its stock
 * quantity. A saved value and a saved stock row must come with the updatedAt the editor loaded; if
 * either row changed since, or a stock row appeared that the editor did not know, nothing is written.
 */
export async function saveVariantValue(env: TalismanEnv, input: SaveVariantValueInput) {
  const { groupId, value, stock } = parseChange(saveValueInput, input);
  if (!value.id && stock?.id) throw new VariantChangeError(400, 'A new variant value has no stock row yet');
  const now = Math.floor(Date.now() / 1000);
  const valueId = value.id ?? `value_${crypto.randomUUID()}`;
  const db = commerceDb(env);
  const one = { one: sql`1` };
  const conditions: SQL[] = [];
  if (value.id) {
    conditions.push(notExists(db.select(one).from(productVariantValues).where(and(eq(productVariantValues.id, valueId),
      eq(productVariantValues.productVariantId, groupId),
      eq(productVariantValues.updatedAt, at(storedSeconds(value.expectedUpdatedAt, 'variant value')))))));
  } else {
    conditions.push(notExists(db.select(one).from(productVariants).where(eq(productVariants.id, groupId))));
  }
  if (stock?.id) {
    conditions.push(notExists(db.select(one).from(stocks).where(and(eq(stocks.id, stock.id),
      eq(stocks.productVariantValueId, valueId), eq(stocks.updatedAt, at(storedSeconds(stock.expectedUpdatedAt, 'stock row')))))));
  } else if (stock && value.id) {
    conditions.push(exists(db.select(one).from(stocks).where(eq(stocks.productVariantValueId, valueId))));
  }

  const guard = staleGuard(db, or(...conditions) ?? conditions[0]);
  const valueWrite = value.id
    ? db.update(productVariantValues)
      .set({ value: value.value, sku: value.sku, image: value.image, priceOverride: value.priceOverride,
        updatedAt: movedUpdatedAt(productVariantValues.updatedAt, now) })
      .where(eq(productVariantValues.id, valueId))
      .returning({ id: productVariantValues.id, updatedAt: productVariantValues.updatedAt })
    : db.insert(productVariantValues)
      .values({ id: valueId, productVariantId: groupId, value: value.value, sku: value.sku, image: value.image,
        priceOverride: value.priceOverride, createdAt: at(now), updatedAt: at(now) })
      .returning({ id: productVariantValues.id, updatedAt: productVariantValues.updatedAt });
  // A new value always gets its stock row. Like checkout's reservations, a stock write always moves
  // updated_at, even within one second.
  const stockWrite = stock?.id
    ? db.update(stocks).set({ quantity: stock.quantity, updatedAt: movedUpdatedAt(stocks.updatedAt, now) })
      .where(eq(stocks.id, stock.id)).returning({ id: stocks.id, quantity: stocks.quantity, updatedAt: stocks.updatedAt })
    : stock || !value.id
      ? db.insert(stocks)
        .values({ id: `stock_${crypto.randomUUID()}`, productVariantValueId: valueId, quantity: stock?.quantity ?? 0,
          createdAt: at(now), updatedAt: at(now) })
        .returning({ id: stocks.id, quantity: stocks.quantity, updatedAt: stocks.updatedAt })
      : null;

  const [, savedValues, savedStocks] = stockWrite
    ? await runBatch(db, [guard, valueWrite, stockWrite])
    : [...await runBatch(db, [guard, valueWrite]), undefined];
  const savedValue = savedValues[0];
  const savedStock = savedStocks?.[0];
  if (!savedValue) throw staleRecord();
  await clearCachedRows(env, {
    _ecommerce_product_variant_values: returnedIds(savedValues),
    _ecommerce_stocks: returnedIds(savedStocks),
  });
  return {
    value: { id: savedValue.id, updatedAt: savedValue.updatedAt.toISOString() },
    stock: savedStock ? { id: savedStock.id, quantity: savedStock.quantity, updatedAt: savedStock.updatedAt.toISOString() } : null,
  };
}

/**
 * Delete a value with its stock row and its parts list (the variant component rows that name it).
 * The shared components themselves stay.
 */
export async function deleteVariantValue(env: TalismanEnv, valueId: string) {
  const db = commerceDb(env);
  const [parts, stockRows, values] = await runBatch(db, [
    db.delete(variantComponents).where(eq(variantComponents.productVariantValueId, valueId)).returning({ id: variantComponents.id }),
    db.delete(stocks).where(eq(stocks.productVariantValueId, valueId)).returning({ id: stocks.id }),
    db.delete(productVariantValues).where(eq(productVariantValues.id, valueId)).returning({ id: productVariantValues.id }),
  ]);
  if (!values.length) throw new VariantChangeError(404, 'Variant value not found');
  await clearCachedRows(env, {
    _ecommerce_variant_components: returnedIds(parts),
    _ecommerce_stocks: returnedIds(stockRows),
    _ecommerce_product_variant_values: returnedIds(values),
  });
  return { valueId, deleted: { values: 1, stockRows: stockRows.length, partRows: parts.length } };
}

/** Delete a group with every value it has, their stock rows and their parts lists. */
export async function deleteVariantGroup(env: TalismanEnv, groupId: string) {
  const db = commerceDb(env);
  const groupValues = db.select({ id: productVariantValues.id }).from(productVariantValues)
    .where(eq(productVariantValues.productVariantId, groupId));
  const [parts, stockRows, values, groups] = await runBatch(db, [
    db.delete(variantComponents).where(inArray(variantComponents.productVariantValueId, groupValues)).returning({ id: variantComponents.id }),
    db.delete(stocks).where(inArray(stocks.productVariantValueId, groupValues)).returning({ id: stocks.id }),
    db.delete(productVariantValues).where(eq(productVariantValues.productVariantId, groupId)).returning({ id: productVariantValues.id }),
    db.delete(productVariants).where(eq(productVariants.id, groupId)).returning({ id: productVariants.id }),
  ]);
  if (!groups.length) throw new VariantChangeError(404, 'Variant group not found');
  await clearCachedRows(env, {
    _ecommerce_variant_components: returnedIds(parts),
    _ecommerce_stocks: returnedIds(stockRows),
    _ecommerce_product_variant_values: returnedIds(values),
    _ecommerce_product_variants: returnedIds(groups),
  });
  return { groupId, deleted: { values: values.length, stockRows: stockRows.length, partRows: parts.length } };
}

/** Validate an admin request body and run the change it names. */
export async function runVariantChange(env: TalismanEnv, body: unknown) {
  const change = parseChange(variantChangeSchema, body);
  if (change.action === 'saveValue') {
    const { action: _action, ...input } = change;
    return saveVariantValue(env, input);
  }
  if (change.action === 'deleteValue') return deleteVariantValue(env, change.valueId);
  return deleteVariantGroup(env, change.groupId);
}
