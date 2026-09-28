import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { buildZodSchemaForFields, decodeGlobalData, isGlobalData, type GlobalConfig } from '../types';
import { cacheKeys, invalidateGlobalCache, readCache, rowsUpdatedSince, writeCache } from './cache';
import { oncePerDatabase } from './collections';
import type { ServiceContext } from './context';
import { AccessDeniedError, ConflictError, InvalidInputError, ValidationError } from './errors';

export type GlobalRecord = typeof schema.globals.$inferSelect;

export interface CreateGlobalInput {
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  data?: unknown;
}

export interface SaveGlobalOptions {
  /**
   * The `version` the caller loaded. A number that no longer matches the stored row refuses the
   * save with a `stale_record` conflict that carries the current version. Null or undefined saves
   * unconditionally, as trusted server code and clients written before versions may.
   */
  expectedVersion?: number | null;
}

const DATA_MESSAGE = 'Global data must be a JSON object';
export const STALE_GLOBAL_MESSAGE = 'This global changed since it was opened. Load the latest version before saving.';
const globalSyncs = new WeakMap<object, Promise<void>>();

const newGlobalId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const trimmed = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Versions start at 1, so anything but a positive whole number is a caller's mistake. */
function readExpectedVersion(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new InvalidInputError('expectedVersion must be a positive whole number');
  }
  return value;
}

/** Global data is stored as an object; a value cached or stored before that rule still reads as one. */
function withDecodedData<T extends { data?: unknown } | null | undefined>(record: T): T {
  return record ? { ...record, data: decodeGlobalData(record.data) } : record;
}

async function findGlobal(ctx: ServiceContext, slug: string) {
  return ctx.db.select().from(schema.globals).where(eq(schema.globals.slug, slug)).get() as Promise<GlobalRecord | undefined>;
}

async function writeConfiguredGlobals(ctx: ServiceContext) {
  for (const globalConfig of ctx.config.globals) {
    const existing = await findGlobal(ctx, globalConfig.slug);
    if (!existing) {
      const now = new Date();
      await ctx.db.insert(schema.globals).values({
        id: newGlobalId(),
        name: globalConfig.name,
        slug: globalConfig.slug,
        description: globalConfig.description || null,
        data: {},
        createdAt: now,
        updatedAt: now,
      });
      continue;
    }
    const nextDescription = globalConfig.description || null;
    if (existing.name !== globalConfig.name || (existing.description || null) !== nextDescription) {
      await ctx.db.update(schema.globals).set({ name: globalConfig.name, description: nextDescription }).where(eq(schema.globals.id, existing.id));
    }
  }
}

/** Creates the configured globals' rows and mirrors their names, once per isolate and database. */
export function syncConfiguredGlobals(ctx: ServiceContext) {
  return oncePerDatabase(globalSyncs, ctx.env.DB, () => writeConfiguredGlobals(ctx));
}

/** A global's configuration and stored row; a configured global's row is created on first use. */
export async function resolveGlobal(ctx: ServiceContext, slug: string): Promise<{ config: GlobalConfig | null; record: GlobalRecord | null }> {
  const globalConfig = ctx.config.globals.find((candidate) => candidate.slug === slug) || null;
  let record = await findGlobal(ctx, slug) ?? null;

  if (!record && globalConfig) {
    const now = new Date();
    await ctx.db.insert(schema.globals).values({
      id: newGlobalId(),
      name: globalConfig.name,
      slug: globalConfig.slug,
      description: globalConfig.description || null,
      data: {},
      createdAt: now,
      updatedAt: now,
    });
    record = await findGlobal(ctx, slug) ?? null;
  } else if (record && globalConfig) {
    const nextDescription = globalConfig.description || null;
    if (record.name !== globalConfig.name || (record.description || null) !== nextDescription) {
      await ctx.db.update(schema.globals).set({ name: globalConfig.name, description: nextDescription }).where(eq(schema.globals.id, record.id));
      record = { ...record, name: globalConfig.name, description: nextDescription };
    }
  }

  return { config: globalConfig, record };
}

/** Configured globals first, in their configured order, then the rest by name. */
function ordered(configured: GlobalConfig[], rows: GlobalRecord[]) {
  const configuredOrder = new Map(configured.map((globalConfig, index) => [globalConfig.slug, index]));
  return rows
    .map((row) => ({ ...row, data: undefined }))
    .sort((left, right) => {
      const leftOrder = configuredOrder.get(left.slug);
      const rightOrder = configuredOrder.get(right.slug);
      if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder;
      if (leftOrder !== undefined) return -1;
      if (rightOrder !== undefined) return 1;
      return left.name.localeCompare(right.name);
    });
}

export function globalsService(ctx: ServiceContext) {
  const { db, env, config, actor } = ctx;
  // Site reads (server code) come from KV unless they opt out; the admin always reads D1.
  const cached = (options: { cache?: boolean }) => (options.cache ?? actor.kind !== 'user') && Boolean(env.KV);

  return {
    /** Every global without its data, configured ones first. */
    async list(options: { cache?: boolean } = {}) {
      const useCache = cached(options);
      if (useCache) {
        const hit = await readCache<Array<any>>(env.KV!, cacheKeys.globals());
        if (hit) return hit;
      }
      const readStartedAt = new Date();
      await syncConfiguredGlobals(ctx);
      const list = ordered(config.globals, await db.select().from(schema.globals));
      if (useCache) {
        await writeCache(env.KV!, cacheKeys.globals(), list, ctx.ctx, { changedSinceRead: rowsUpdatedSince(db, schema.globals, readStartedAt) });
      }
      return list;
    },

    /** One global with its data, or null; a configured global exists from its first read. */
    async get(slug: string, options: { cache?: boolean } = {}) {
      const useCache = cached(options);
      if (useCache) {
        const hit = await readCache<any>(env.KV!, cacheKeys.global(slug));
        if (hit) return withDecodedData(hit);
      }
      const readStartedAt = new Date();
      const { record } = await resolveGlobal(ctx, slug);
      const data = withDecodedData(record);
      if (useCache && data) {
        await writeCache(env.KV!, cacheKeys.global(slug), data, ctx.ctx,
          { changedSinceRead: rowsUpdatedSince(db, schema.globals, readStartedAt, eq(schema.globals.slug, slug)) });
      }
      return data;
    },

    /** A new global outside the configuration; administrators only. */
    async create(input: CreateGlobalInput) {
      if (actor.kind === 'user' && actor.user.role !== 'admin') throw new AccessDeniedError('Admin access required');
      const slug = trimmed(input.slug);
      if (!slug) throw new InvalidInputError('Slug is required');
      if (input.data != null && !isGlobalData(input.data)) throw new ValidationError([{ path: [], message: DATA_MESSAGE }], undefined, DATA_MESSAGE);
      if (await findGlobal(ctx, slug)) throw new ConflictError('A global with this slug already exists');

      const now = new Date();
      const created = {
        id: newGlobalId(),
        name: trimmed(input.name) || slug,
        slug,
        description: trimmed(input.description),
        data: isGlobalData(input.data) ? input.data : {},
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await db.insert(schema.globals).values(created);
      await invalidateGlobalCache(env, slug);
      return created;
    },

    /**
     * Saves a global's data, creating a configured global's row as needed. Saving to a slug that is
     * neither configured nor stored would create a global, which is kept to administrators. Every
     * save adds one to the row's `version`; a caller that passes the version it loaded is refused
     * with a `stale_record` conflict when another save came first.
     */
    async save(slug: string, data: unknown, options: SaveGlobalOptions = {}) {
      if (!isGlobalData(data)) throw new ValidationError([{ path: [], message: DATA_MESSAGE }], undefined, DATA_MESSAGE);
      const expectedVersion = readExpectedVersion(options.expectedVersion);
      const { config: globalConfig, record: existing } = await resolveGlobal(ctx, slug);
      if (!globalConfig && !existing && actor.kind === 'user' && actor.user.role !== 'admin') {
        throw new AccessDeniedError('Only administrators can create globals');
      }

      let saved: Record<string, any> = data;
      if (globalConfig?.fields?.length) {
        const parsed = buildZodSchemaForFields(globalConfig.fields).safeParse(data);
        if (!parsed.success) {
          throw new ValidationError(parsed.error.issues, { details: parsed.error.flatten() }, parsed.error.issues.map((issue) => issue.message).join(', '));
        }
        saved = parsed.data;
      }

      const now = new Date();
      const name = globalConfig?.name || existing?.name || slug;
      const description = globalConfig?.description || existing?.description || null;
      const nextVersion = sql`${schema.globals.version} + 1`;

      // The version check and the increment are one statement, so of two saves that name the same
      // version only one changes a row; the other finds none and is refused with the version stored now.
      let updated: GlobalRecord | undefined;
      if (existing) {
        const stillLoaded = expectedVersion === null ? undefined : eq(schema.globals.version, expectedVersion);
        [updated] = await db.update(schema.globals)
          .set({ name, description, data: saved, updatedAt: now, version: nextVersion })
          .where(and(eq(schema.globals.id, existing.id), stillLoaded))
          .returning();
      }
      if (!updated) {
        if (expectedVersion !== null) {
          const current = await findGlobal(ctx, slug);
          throw new ConflictError(STALE_GLOBAL_MESSAGE, { code: 'stale_record', version: current?.version ?? null });
        }
        // No row to update: the global is new, or its row went away since it was read. A row another
        // save creates at the same moment is updated instead.
        await db.insert(schema.globals).values({
          id: newGlobalId(),
          name,
          slug,
          description,
          data: saved,
          createdAt: now,
          updatedAt: now,
          version: 1,
        }).onConflictDoUpdate({
          target: schema.globals.slug,
          set: { name, description, data: saved, updatedAt: now, version: nextVersion }
        });
        updated = await findGlobal(ctx, slug);
      }
      // The row was just written or updated; only a database failure leaves it unreadable.
      if (!updated) throw new Error(`Global "${slug}" could not be read back after saving`);

      await invalidateGlobalCache(env, slug);
      return withDecodedData(updated);
    },
  };
}
