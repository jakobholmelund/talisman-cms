import type { SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { createDbClient, type TalismanEnv } from 'talisman-cms/client';
import { relations } from './schema';

/**
 * The plugin's Drizzle client on the site's `DB` binding: the select builder, and through the
 * schema's relations `db.query.<table>` with `with:` nesting for every commerce table.
 */
export const commerceDb = (env: TalismanEnv) => createDbClient(env, relations);
export type CommerceDb = ReturnType<typeof commerceDb>;

/**
 * Ids per `in` list. D1 binds at most 100 parameters per statement, and a nested read binds a few
 * more than its ids: a `limit` for each `one` relation it nests and the literals of a relation's
 * `where`, nine for the deepest read the plugin makes.
 */
const IN_CHUNK = 80;

/** `values` in lists of at most `size`, for one statement per list. */
export function chunked<T>(values: T[], size = IN_CHUNK) {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += size) chunks.push(values.slice(start, start + size));
  return chunks;
}

/**
 * The message of an error and of each cause under it, one per line: a failed statement arrives as a
 * `DrizzleQueryError` whose cause is D1's own error, and the log should show both.
 */
export function errorText(error: unknown) {
  const messages: string[] = [];
  for (let current: any = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    if (typeof current.message === 'string') messages.push(current.message);
  }
  return messages.join('\n');
}

type Rows<Query> = Query extends { _: { result: infer Result } } ? (Result extends readonly (infer Row)[] ? Row[] : never) : never;

/**
 * Runs named groups of queries as one D1 batch, one round trip and one snapshot, and returns each
 * group's rows flattened under its name with the row type its queries carry. A read that chunks its
 * ids (`chunked`, below D1's limit of bound parameters) is one group; an empty batch runs nothing.
 */
export async function batchGroups<Groups extends Record<string, BatchItem<'sqlite'>[]>>(db: CommerceDb, groups: Groups) {
  const queries = Object.values(groups).flat();
  const results: unknown[] = queries.length ? await db.batch(queries as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]) : [];
  let offset = 0;
  return Object.fromEntries(Object.entries(groups).map(([name, list]) =>
    [name, results.slice(offset, offset += list.length).flat()])) as { [Name in keyof Groups]: Rows<Groups[Name][number]> };
}

/**
 * Runs builder queries and `db.run(sql)` items as one D1 batch, atomic as a whole. Every write batch
 * of the plugin goes through here: a statement the builder expresses is a builder query, and one it
 * does not (`INSERT ... SELECT`, a correlated subquery, a dynamic table) is a `sql` template run with
 * `db.run`, so both sit in one batch. An empty list runs nothing.
 */
export async function commitBatch(db: CommerceDb, items: BatchItem<'sqlite'>[]) {
  if (!items.length) return [];
  return db.batch(items as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
}

/** Runs `sql` statements as one D1 batch. */
export const runStatements = (db: CommerceDb, statements: SQL[]) => commitBatch(db, statements.map((statement) => db.run(statement)));
