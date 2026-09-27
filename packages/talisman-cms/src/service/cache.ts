import { and, count, gte, lte, type SQL } from 'drizzle-orm';
import type { TalismanEnv, createDbClient } from '../db/client';
import * as schema from '../db/schema';

type Db = ReturnType<typeof createDbClient>;
export type CacheContext = Pick<ExecutionContext, 'waitUntil'>;
export type VersionMode = 'draft' | 'published';

/** Entries and globals: their writes all go through the service or call the helpers below. */
export const ENTRY_CACHE_TTL_SECONDS = 3600;
/** Native tables opt in: plugin SQL writes them without clearing anything, so their copies stay short-lived. */
export const NATIVE_CACHE_TTL_SECONDS = 60;

/** The one place a cache key is spelled. */
export const cacheKeys = {
  collections: () => 'talisman:collections:all',
  globals: () => 'talisman:globals:all',
  global: (slug: string) => `talisman:globals:${slug}`,
  entries: (collectionSlug: string, version: VersionMode) => `talisman:entries:${collectionSlug}:all:${version}`,
  entry: (collectionSlug: string, id: string, version: VersionMode) => `talisman:entries:${collectionSlug}:${id}:${version}`,
};

let workerCacheContext: Promise<CacheContext | null> | null = null;

// Workers expose waitUntil on `cloudflare:workers`, so cache fills can finish after the
// response even when the caller did not pass its execution context.
function getWorkerCacheContext() {
  workerCacheContext ??= import('cloudflare:workers')
    .then(({ waitUntil }) => typeof waitUntil === 'function'
      ? { waitUntil: (promise: Promise<unknown>) => waitUntil(promise) }
      : null)
    .catch(() => null);
  return workerCacheContext;
}

/** KV is only a cache: a failed read is treated as a miss so the request falls through to D1. */
export async function readCache<T>(kv: KVNamespace, key: string): Promise<T | null> {
  try {
    return await kv.get<T>(key, 'json');
  } catch (error) {
    console.warn(`[Talisman] KV cache read failed for ${key}`, error);
    return null;
  }
}

/**
 * Best-effort cache fill that never fails the read, deferred with waitUntil when available.
 * A save or publish can delete the key while this read is in flight, and a put landing after
 * that delete would serve the old value for the whole TTL. `changedSinceRead` re-checks D1 once
 * the put settles and drops the key if the source rows changed after the read began.
 */
export async function writeCache(
  kv: KVNamespace,
  key: string,
  value: unknown,
  ctx: CacheContext | undefined,
  options: { ttl?: number; changedSinceRead?: () => Promise<boolean> } = {}
) {
  const write = (async () => {
    try {
      await kv.put(key, JSON.stringify(value), { expirationTtl: options.ttl ?? ENTRY_CACHE_TTL_SECONDS });
      if (options.changedSinceRead && await options.changedSinceRead()) {
        await kv.delete(key);
      }
    } catch (error) {
      console.warn(`[Talisman] KV cache write failed for ${key}`, error);
    }
  })();

  const context = ctx ?? await getWorkerCacheContext();
  if (context) {
    try {
      context.waitUntil(write);
      return;
    } catch {
      // No request to extend (e.g. prerendering): finish the write inline instead.
    }
  }
  await write;
}

// A concurrent save stamps roughly "now", so the recheck ignores rows stamped further ahead
// (e.g. millisecond values in a seconds column) that would otherwise drop every cache fill.
const CONCURRENT_WRITE_WINDOW_MS = 5 * 60_000;

/** For `writeCache`: whether rows of `table` changed, or went missing, since a read began. */
export function rowsUpdatedSince(
  db: Db,
  table: typeof schema.entries | typeof schema.globals,
  since: Date,
  where?: SQL,
  stillPresent?: { where?: SQL; count: number }
) {
  return async () => {
    const latest = new Date(Date.now() + CONCURRENT_WRITE_WINDOW_MS);
    const rows = await db.select({ id: table.id }).from(table)
      .where(and(gte(table.updatedAt, since), lte(table.updatedAt, latest), where)).limit(1);
    if (rows.length > 0) return true;
    if (!stillPresent) return false;
    // A hard delete leaves no updated row behind, so a read whose rows are no longer all there is stale too.
    const [present] = await db.select({ total: count() }).from(table).where(stillPresent.where);
    return (present?.total ?? 0) !== stillPresent.count;
  };
}

type CacheEnv = Pick<TalismanEnv, 'KV'>;

/**
 * Drops the KV copies of a collection's cached lists and of the given entries' cached reads. Code
 * that writes rows without the service (a D1 batch, for example) calls it once the write has
 * committed, as the admin API and getClient do after theirs.
 */
export async function invalidateEntryCache(
  env: CacheEnv,
  collectionSlug: string,
  entryIds?: string | readonly string[]
) {
  const kv = env.KV;
  if (!kv) return;

  const prefix = `talisman:entries:${collectionSlug}`;
  await Promise.all([`${prefix}:all`, `${prefix}:all:draft`, `${prefix}:all:published`].map((key) => kv.delete(key)));
  const ids = (typeof entryIds === 'string' ? [entryIds] : entryIds ?? []).filter(Boolean);
  await Promise.all(ids.flatMap((id) => [`${prefix}:${id}`, `${prefix}:${id}:draft`, `${prefix}:${id}:published`])
    .map((key) => kv.delete(key)));
}

/** Drops the cached list of globals and, given a slug, that global's cached read. */
export async function invalidateGlobalCache(env: CacheEnv, slug?: string) {
  const kv = env.KV;
  if (!kv) return;
  const keys = [cacheKeys.globals(), ...(slug ? [cacheKeys.global(slug)] : [])];
  await Promise.all(keys.map((key) => kv.delete(key)));
}

/** Drops the cached list of collections, for code that writes galaxy_collections itself. */
export async function invalidateCollectionCache(env: CacheEnv) {
  await env.KV?.delete(cacheKeys.collections());
}
