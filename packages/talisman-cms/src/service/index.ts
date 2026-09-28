import { createDbClient, type TalismanEnv } from '../db/client';
import { systemActor, type Actor } from './actor';
import type { CacheContext } from './cache';
import { collectionsService } from './collections';
import type { ServiceConfig } from './config';
import type { ServiceContext } from './context';
import { entriesService } from './entries';
import { globalsService } from './globals';
import type { HookLogEntry } from './hooks';
import { revisionsService } from './transitions';

export interface ServiceOptions {
  /** The site configuration; the admin API passes its static modules, getClient loads it. */
  config: ServiceConfig;
  /** Who is calling; trusted server code when left out. */
  actor?: Actor;
  /** The execution context whose waitUntil defers cache fills past the response. */
  ctx?: CacheContext;
  /** Receives one entry per hook call, for tests. */
  log?: HookLogEntry[];
}

export type TalismanService = ReturnType<typeof createService>;

/**
 * The content service both the admin API and getClient are built on: hooks, validation, access
 * rules and cache invalidation run here, once, for every caller.
 */
export function createService(env: TalismanEnv, options: ServiceOptions) {
  const context: ServiceContext = {
    env,
    db: createDbClient(env),
    config: options.config,
    actor: options.actor ?? systemActor(),
    ctx: options.ctx,
    log: options.log,
  };
  return {
    actor: context.actor,
    collections: collectionsService(context),
    entries: entriesService(context),
    globals: globalsService(context),
    revisions: revisionsService(context),
  };
}

export type { Actor } from './actor';
export { systemActor, userActor } from './actor';
export type { ServiceConfig } from './config';
export type { ServiceContext } from './context';
export type { CreateEntryInput, EntriesPage, EntryStatusTarget, SiteReadOptions, UpdateEntryInput, WriteExpectation } from './entries';
export type { ResolvedCollection } from './collections';
export type { VersionMode } from './relations';
export type { EntryQuery, Operators, Scalar, WhereClause } from './query';
export type { CreateGlobalInput, SaveGlobalOptions } from './globals';
export type { HookLogEntry } from './hooks';
