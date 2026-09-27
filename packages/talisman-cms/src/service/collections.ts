import { eq } from 'drizzle-orm';
import type { TalismanEnv, createDbClient } from '../db/client';
import * as schema from '../db/schema';
import { generateFieldsFromDrizzle, type CollectionConfig, type FieldDefinition } from '../types';
import type { ServiceConfig } from './config';
import type { ServiceContext } from './context';
import { invalidateCollectionCache } from './cache';
import { NotFoundError } from './errors';
import type { CollectionHooks } from '../types';
import { getNativeIdColumn } from '../types';

type Db = ReturnType<typeof createDbClient>;
export type CollectionRecord = typeof schema.collections.$inferSelect;
type CollectionsConfig = Pick<ServiceConfig, 'collections' | 'nativeSchemas'>;
type CollectionsEnv = Pick<TalismanEnv, 'DB' | 'KV'>;

/** Work that should run once per isolate and D1 database, keyed by the binding. */
export function oncePerDatabase(runs: WeakMap<object, Promise<void>>, binding: unknown, run: () => Promise<void>) {
  const key = binding && typeof binding === 'object' ? binding : null;
  if (!key) return run();

  let pending = runs.get(key);
  if (!pending) {
    pending = run();
    runs.set(key, pending);
    // A failed run is retried by the next request.
    pending.catch(() => runs.delete(key));
  }
  return pending;
}

const syncs = new WeakMap<object, Promise<void>>();
const memos = new WeakMap<object, Map<string, CollectionRecord>>();

/** The rows this isolate has resolved for one database; nothing is kept for a binding without identity. */
function memoFor(binding: unknown): Map<string, CollectionRecord> | null {
  if (!binding || typeof binding !== 'object') return null;
  let memo = memos.get(binding);
  if (!memo) {
    memo = new Map();
    memos.set(binding, memo);
  }
  return memo;
}

/** The fields a collection is configured with; a native collection without fields takes them from its table. */
export function configuredCollectionFields(collectionConfig: CollectionConfig, nativeSchemas: Record<string, any>): FieldDefinition[] {
  const fields = collectionConfig.fields || [];
  if (fields.length === 0 && collectionConfig.nativeSchemaMapping && nativeSchemas[collectionConfig.slug]) {
    return generateFieldsFromDrizzle(nativeSchemas[collectionConfig.slug]);
  }
  return fields;
}

/**
 * Entries reference a galaxy_collections row per configured collection, which also mirrors its
 * name and fields. The sync reads every row once per isolate, writes only rows that are missing or
 * changed, in one batch, and fills the memo that reads take their rows from, so no request looks a
 * collection row up again. A write also drops the cached collection list.
 */
export function syncCollectionDefinitions(db: Db, env: CollectionsEnv, config: CollectionsConfig): Promise<void> {
  const binding = env.DB;
  return oncePerDatabase(syncs, binding, async () => {
    const memo = memoFor(binding);
    const stored = await db.select().from(schema.collections);
    const storedBySlug = new Map(stored.map((row) => [row.slug, row]));
    for (const row of stored) memo?.set(row.slug, row);
    const now = new Date();
    const missing: (typeof schema.collections.$inferInsert)[] = [];
    const writes: any[] = [];

    for (const collectionConfig of config.collections) {
      const fields = configuredCollectionFields(collectionConfig, config.nativeSchemas);
      const row = storedBySlug.get(collectionConfig.slug);
      if (!row) {
        missing.push({ id: crypto.randomUUID(), name: collectionConfig.name, slug: collectionConfig.slug, fields, createdAt: now });
      } else if (row.name !== collectionConfig.name || JSON.stringify(row.fields) !== JSON.stringify(fields)) {
        writes.push(db.update(schema.collections).set({ name: collectionConfig.name, fields }).where(eq(schema.collections.id, row.id)));
        memo?.set(row.slug, { ...row, name: collectionConfig.name, fields });
      }
    }

    // Ten rows of five values stay under D1's 100 bound parameters per statement.
    for (let index = 0; index < missing.length; index += 10) {
      writes.push(db.insert(schema.collections).values(missing.slice(index, index + 10))
        .onConflictDoNothing({ target: schema.collections.slug }));
    }

    if (writes.length > 0) {
      await db.batch(writes as [any, ...any[]]);
      await invalidateCollectionCache(env);
    }
    if (missing.length > 0) {
      // Another isolate may have created a missing row first, so the stored rows are read back.
      for (const row of await db.select().from(schema.collections)) memo?.set(row.slug, row);
    }
  });
}

/**
 * The stored row of a collection, from the isolate's memo. A miss (a row seeded straight into D1
 * after the isolate started, or a stored collection that is no longer configured) is looked up
 * once; a configured collection without a row is created.
 */
export async function resolveCollectionRecord(db: Db, env: CollectionsEnv, config: CollectionsConfig, slug: string): Promise<CollectionRecord> {
  await syncCollectionDefinitions(db, env, config);
  const memo = memoFor(env.DB);
  const known = memo?.get(slug);
  if (known) return known;

  const lookup = () => db.select().from(schema.collections).where(eq(schema.collections.slug, slug)).limit(1).then((rows) => rows[0]);
  let row = await lookup();
  if (!row) {
    const collectionConfig = config.collections.find((candidate) => candidate.slug === slug);
    if (!collectionConfig) throw new NotFoundError(`Collection ${slug} not found`);
    await db.insert(schema.collections).values({
      id: crypto.randomUUID(),
      name: collectionConfig.name,
      slug,
      fields: configuredCollectionFields(collectionConfig, config.nativeSchemas),
      createdAt: new Date(),
    }).onConflictDoNothing({ target: schema.collections.slug });
    await invalidateCollectionCache(env);
    row = await lookup();
    if (!row) throw new Error(`Collection ${slug} could not be initialized`);
  }
  memo?.set(slug, row);
  return row;
}

/** Drops memoized rows, for code that writes galaxy_collections itself. */
export function forgetCollectionRecords(binding: unknown, slug?: string) {
  const memo = binding && typeof binding === 'object' ? memos.get(binding) : undefined;
  if (!memo) return;
  if (slug === undefined) memo.clear();
  else memo.delete(slug);
}

/** A collection as an operation works with it: its configuration, its stored row and its native table. */
export interface ResolvedCollection {
  slug: string;
  config: CollectionConfig;
  /** The galaxy_collections row entries reference. */
  record: CollectionRecord;
  /** The fields in force: the configured ones, or those generated from a native table. */
  activeFields: FieldDefinition[];
  nativeTable: Record<string, any> | null;
  nativeIdCol: string;
  hooks?: CollectionHooks;
  /** Whether the collection is configured; a stored collection without configuration is readable by server code. */
  configured: boolean;
}

/**
 * The collection an operation addresses. A configured collection is resolved from the configuration
 * and its memoized row; a stored collection that is no longer configured resolves from its row alone
 * (its stored fields, no hooks, no native table), so server code can still read it. Anything else
 * is a NotFoundError.
 */
export async function resolveCollection(ctx: ServiceContext, slug: string): Promise<ResolvedCollection> {
  const { config } = ctx;
  const collectionConfig = config.collections.find((candidate) => candidate.slug === slug);
  const record = await resolveCollectionRecord(ctx.db, ctx.env, config, slug);
  if (!collectionConfig) {
    const storedFields = Array.isArray(record.fields) ? record.fields as FieldDefinition[] : [];
    return {
      slug,
      config: { name: record.name, slug, fields: storedFields },
      record,
      activeFields: storedFields,
      nativeTable: null,
      nativeIdCol: 'id',
      configured: false,
    };
  }
  const nativeTable = collectionConfig.nativeSchemaMapping && config.nativeSchemas[slug] ? config.nativeSchemas[slug] : null;
  return {
    slug,
    config: collectionConfig,
    record,
    activeFields: configuredCollectionFields(collectionConfig, config.nativeSchemas),
    nativeTable,
    nativeIdCol: getNativeIdColumn(collectionConfig),
    hooks: config.collectionHooks[slug],
    configured: true,
  };
}
