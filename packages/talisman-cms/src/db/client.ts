import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';
import type { Actor } from '../service/actor';
import type { CacheContext } from '../service/cache';
import { loadServiceConfig } from '../service/config';
import type { EntryStatusTarget, SiteReadOptions } from '../service/entries';
import type { SaveGlobalOptions } from '../service/globals';
import type { EntryQuery } from '../service/query';
import { createService } from '../service/index';
import type { VersionMode } from '../service/relations';

export type TalismanEnv = {
  DB: D1Database;
  STORAGE?: R2Bucket;
  IMAGES?: ImagesBinding;
  KV?: KVNamespace;
  [key: string]: unknown;
};

export function createDbClient(env: TalismanEnv) {
  if (!env.DB) {
    throw new Error('Talisman CMS requires a D1 database bound to the "DB" environment variable.');
  }
  return drizzle(env.DB, { schema });
}

export interface ClientOptions {
  /**
   * Who is calling; trusted server code when left out. A plugin route that holds a CMS session
   * passes `userActor(user, request)` and gets the admin API's rules.
   */
  actor?: Actor;
}

export interface UpdateOptions {
  slug?: string;
  status?: string;
  /** The latest revision the caller loaded; a user actor must send it when the entry has revisions. */
  expectedRevisionId?: string | null;
  /** The updatedAt a native row was loaded with, to refuse a save over a newer one. */
  expectedUpdatedAt?: unknown;
}

/** A create or update may publish or archive straight away; any other value is ignored, as before. */
const statusTarget = (status: string | undefined): EntryStatusTarget | undefined =>
  status === 'published' || status === 'archived' ? status : undefined;

/**
 * The SDK for server code. Every call goes through the same service as the admin API, so hooks,
 * validation, the collection rules that apply to the actor and cache invalidation are the same.
 * Pass the request's execution context (Workers `ctx`, Astro `locals.cfContext`) so KV cache
 * fills run after the response; inside Workers it is otherwise taken from `cloudflare:workers`.
 */
export function getClient(env: TalismanEnv, ctx?: CacheContext, options: ClientOptions = {}) {
  const service = async () => createService(env, { config: await loadServiceConfig(), ctx, actor: options.actor });

  return {
    collections: {
      findMany: async (opts?: { cache?: boolean }) => (await service()).collections.list({ cache: opts?.cache }),
    },
    globals: {
      findMany: async (opts?: { cache?: boolean }) => (await service()).globals.list({ cache: opts?.cache }),
      find: async (slug: string, opts?: { cache?: boolean }) => (await service()).globals.get(slug, { cache: opts?.cache }),
      create: async (input: { slug: string; name?: string; description?: string | null; data?: any }) => (await service()).globals.create(input),
      /**
       * Saves a global's data. `expectedVersion`, the `version` a read returned, makes the save fail
       * with a `stale_record` ConflictError when another save came first; without it the save wins.
       */
      save: async (slug: string, data: Record<string, any>, opts?: SaveGlobalOptions) => (await service()).globals.save(slug, data, opts),
      /** The same as `save`, under the name earlier releases used. */
      update: async (slug: string, data: Record<string, any>, opts?: SaveGlobalOptions) => (await service()).globals.save(slug, data, opts),
    },
    entries: {
      findMany: async (collectionSlug: string, opts?: SiteReadOptions & EntryQuery & { limit?: number }) =>
        (await service()).entries.findMany(collectionSlug, opts),
      findBySlug: async (collectionSlug: string, slug: string, opts?: { depth?: number; version?: VersionMode }) =>
        (await service()).entries.findBySlug(collectionSlug, slug, opts),
      find: async (collectionSlug: string, id: string | number, opts?: SiteReadOptions) =>
        (await (await service()).entries.find(collectionSlug, String(id), opts)) ?? undefined,
      create: async (collectionSlug: string, data: any, opts?: { slug?: string; status?: string }) =>
        (await service()).entries.create(collectionSlug, { data, slug: opts?.slug, status: statusTarget(opts?.status) }),
      update: async (collectionSlug: string, id: string | number, data?: any, opts?: UpdateOptions) =>
        (await service()).entries.update(collectionSlug, String(id), {
          data,
          slug: opts?.slug,
          status: statusTarget(opts?.status),
          expect: { revisionId: opts?.expectedRevisionId, updatedAt: opts?.expectedUpdatedAt },
        }),
      delete: async (collectionSlug: string, id: string | number) => {
        await (await service()).entries.remove(collectionSlug, String(id));
        return true;
      },
    }
  };
}
