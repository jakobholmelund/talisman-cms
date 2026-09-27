import type { TalismanEnv, createDbClient } from '../db/client';
import type { Actor } from './actor';
import type { CacheContext } from './cache';
import type { ServiceConfig } from './config';
import type { HookLogEntry } from './hooks';

export type Db = ReturnType<typeof createDbClient>;

/** What every service operation runs with: the bindings, a database client, the configuration and the caller. */
export interface ServiceContext {
  env: TalismanEnv;
  db: Db;
  config: ServiceConfig;
  actor: Actor;
  /** The execution context whose waitUntil defers cache fills past the response. */
  ctx?: CacheContext;
  /** Receives one entry per hook call, for tests. */
  log?: HookLogEntry[];
}
