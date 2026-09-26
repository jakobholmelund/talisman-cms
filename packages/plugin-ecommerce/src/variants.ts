import { z } from 'zod';
import { invalidateEntryCache, type TalismanEnv } from 'talisman-cms/client';

/**
 * Changes the product editor's variant configurator makes: save a variant value together with its
 * stock row, delete a value, or delete a group with its values. Each change is one D1 batch, so a
 * failure leaves nothing half-saved and a retry cannot create a second value. The batches write D1
 * directly, so no collection hooks run; the core's cached reads of the rows are cleared afterwards.
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
const staleGuard = (condition: string) =>
  `SELECT CASE WHEN ${condition} THEN json_extract('{}', '$${STALE_MARKER}') END AS conflict`;

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

const loadedTimestamp = (seconds: number) => new Date(seconds * 1000).toISOString();

function errorText(error: unknown) {
  const messages: string[] = [];
  for (let current: any = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    if (typeof current.message === 'string') messages.push(current.message);
  }
  return messages.join('\n');
}

/** The ids a statement's RETURNING clause gave back. */
const returnedIds = (result: D1Result<Record<string, any>> | undefined) =>
  (result?.results ?? []).map((row) => String(row.id));

/**
 * Drop the cached reads of the rows a committed change wrote, keyed by collection slug, as the core
 * API does after its saves: getClient() serves depth-0 reads of these collections from KV for up to
 * an hour. The change is saved either way, so a failure here is only logged.
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

async function runBatch(env: TalismanEnv, statements: D1PreparedStatement[]) {
  try {
    return await env.DB.batch<Record<string, any>>(statements);
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
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (value.id) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM _ecommerce_product_variant_values
      WHERE id = ? AND product_variant_id = ? AND updated_at = ?)`);
    params.push(valueId, groupId, storedSeconds(value.expectedUpdatedAt, 'variant value'));
  } else {
    conditions.push('NOT EXISTS (SELECT 1 FROM _ecommerce_product_variants WHERE id = ?)');
    params.push(groupId);
  }
  if (stock?.id) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM _ecommerce_stocks
      WHERE id = ? AND product_variant_value_id = ? AND updated_at = ?)`);
    params.push(stock.id, valueId, storedSeconds(stock.expectedUpdatedAt, 'stock row'));
  } else if (stock && value.id) {
    conditions.push('EXISTS (SELECT 1 FROM _ecommerce_stocks WHERE product_variant_value_id = ?)');
    params.push(valueId);
  }

  const statements = [env.DB.prepare(staleGuard(conditions.join(' OR '))).bind(...params)];
  statements.push(value.id
    ? env.DB.prepare(`UPDATE _ecommerce_product_variant_values
        SET value = ?, sku = ?, image = ?, price_override = ?, updated_at = MAX(updated_at + 1, ?)
        WHERE id = ? RETURNING id, updated_at`)
      .bind(value.value, value.sku, value.image, value.priceOverride, now, valueId)
    : env.DB.prepare(`INSERT INTO _ecommerce_product_variant_values
        (id, product_variant_id, value, sku, image, price_override, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, updated_at`)
      .bind(valueId, groupId, value.value, value.sku, value.image, value.priceOverride, now, now));
  // A new value always gets its stock row.
  if (stock?.id) {
    // Like checkout's reservations, a stock write always moves updated_at, even within one second.
    statements.push(env.DB.prepare(`UPDATE _ecommerce_stocks
      SET quantity = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ? RETURNING id, quantity, updated_at`)
      .bind(stock.quantity, now, stock.id));
  } else if (stock || !value.id) {
    statements.push(env.DB.prepare(`INSERT INTO _ecommerce_stocks
      (id, product_variant_value_id, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      RETURNING id, quantity, updated_at`)
      .bind(`stock_${crypto.randomUUID()}`, valueId, stock?.quantity ?? 0, now, now));
  }

  const results = await runBatch(env, statements);
  const savedValue = results[1]?.results?.[0];
  const savedStock = results[2]?.results?.[0];
  if (!savedValue) throw staleRecord();
  await clearCachedRows(env, {
    _ecommerce_product_variant_values: returnedIds(results[1]),
    _ecommerce_stocks: returnedIds(results[2]),
  });
  return {
    value: { id: String(savedValue.id), updatedAt: loadedTimestamp(Number(savedValue.updated_at)) },
    stock: savedStock ? { id: String(savedStock.id), quantity: Number(savedStock.quantity),
      updatedAt: loadedTimestamp(Number(savedStock.updated_at)) } : null,
  };
}

/**
 * Delete a value with its stock row and its parts list (the variant component rows that name it).
 * The shared components themselves stay.
 */
export async function deleteVariantValue(env: TalismanEnv, valueId: string) {
  const results = await runBatch(env, [
    env.DB.prepare('DELETE FROM _ecommerce_variant_components WHERE product_variant_value_id = ? RETURNING id').bind(valueId),
    env.DB.prepare('DELETE FROM _ecommerce_stocks WHERE product_variant_value_id = ? RETURNING id').bind(valueId),
    env.DB.prepare('DELETE FROM _ecommerce_product_variant_values WHERE id = ? RETURNING id').bind(valueId),
  ]);
  if (!results[2]?.results?.length) throw new VariantChangeError(404, 'Variant value not found');
  await clearCachedRows(env, {
    _ecommerce_variant_components: returnedIds(results[0]),
    _ecommerce_stocks: returnedIds(results[1]),
    _ecommerce_product_variant_values: returnedIds(results[2]),
  });
  return { valueId, deleted: { values: 1, stockRows: results[1]?.results?.length ?? 0,
    partRows: results[0]?.results?.length ?? 0 } };
}

/** Delete a group with every value it has, their stock rows and their parts lists. */
export async function deleteVariantGroup(env: TalismanEnv, groupId: string) {
  const groupValues = 'SELECT id FROM _ecommerce_product_variant_values WHERE product_variant_id = ?';
  const results = await runBatch(env, [
    env.DB.prepare(`DELETE FROM _ecommerce_variant_components WHERE product_variant_value_id IN (${groupValues})
      RETURNING id`).bind(groupId),
    env.DB.prepare(`DELETE FROM _ecommerce_stocks WHERE product_variant_value_id IN (${groupValues})
      RETURNING id`).bind(groupId),
    env.DB.prepare('DELETE FROM _ecommerce_product_variant_values WHERE product_variant_id = ? RETURNING id').bind(groupId),
    env.DB.prepare('DELETE FROM _ecommerce_product_variants WHERE id = ? RETURNING id').bind(groupId),
  ]);
  if (!results[3]?.results?.length) throw new VariantChangeError(404, 'Variant group not found');
  await clearCachedRows(env, {
    _ecommerce_variant_components: returnedIds(results[0]),
    _ecommerce_stocks: returnedIds(results[1]),
    _ecommerce_product_variant_values: returnedIds(results[2]),
    _ecommerce_product_variants: returnedIds(results[3]),
  });
  return { groupId, deleted: { values: results[2]?.results?.length ?? 0,
    stockRows: results[1]?.results?.length ?? 0, partRows: results[0]?.results?.length ?? 0 } };
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
