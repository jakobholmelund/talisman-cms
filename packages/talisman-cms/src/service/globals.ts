import { eq } from 'drizzle-orm';
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

const DATA_MESSAGE = 'Global data must be a JSON object';
const globalSyncs = new WeakMap<object, Promise<void>>();

const newGlobalId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const trimmed = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Global data is stored as an object; a value cached or stored before that rule still reads as one. */
function withDecodedData<T extends { data?: unknown } | null | undefined>(record: T): T {
  return record ? { ...record, data: decodeGlobalData(record.data) } : record;
}

async function findGlobal(ctx: ServiceContext, slug: string) {
  return ctx.db.query.globals.findFirst({
    // @ts-ignore
    where: (g: any, { eq }: any) => eq(g.slug, slug)
  }) as Promise<GlobalRecord | undefined>;
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
      const list = ordered(config.globals, await db.query.globals.findMany());
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
      };
      await db.insert(schema.globals).values(created);
      await invalidateGlobalCache(env, slug);
      return created;
    },

    /**
     * Saves a global's data, creating a configured global's row as needed. Saving to a slug that is
     * neither configured nor stored would create a global, which is kept to administrators.
     */
    async save(slug: string, data: unknown) {
      if (!isGlobalData(data)) throw new ValidationError([{ path: [], message: DATA_MESSAGE }], undefined, DATA_MESSAGE);
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

      const id = existing?.id || newGlobalId();
      const now = new Date();
      const name = globalConfig?.name || existing?.name || slug;
      const description = globalConfig?.description || existing?.description || null;
      await db.insert(schema.globals).values({
        id,
        name,
        slug,
        description,
        data: saved,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: schema.globals.slug,
        set: { name, description, data: saved, updatedAt: now }
      });

      const updated = await findGlobal(ctx, slug);
      await invalidateGlobalCache(env, slug);
      return withDecodedData(updated);
    },
  };
}
