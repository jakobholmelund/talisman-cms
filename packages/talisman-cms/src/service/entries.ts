import { and, desc, eq, getTableColumns, isNull, lt, or, sql } from 'drizzle-orm';
import { deleteStoredMedia, isMediaCollection } from '../db/media-policy';
import * as schema from '../db/schema';
import { buildZodSchemaForCollection } from '../types';
import {
  createDraftEntry,
  getLatestRevision,
  saveDraftEntry,
  toEditableEntry,
  triggerPublishingWorkflow,
  type PublishWorkflowAction
} from '../versioning';
import { assertAllowed } from './actor';
import { invalidateEntryCache } from './cache';
import { resolveCollection, type ResolvedCollection } from './collections';
import type { ServiceContext } from './context';
import {
  InvalidInputError,
  NativeRecordConflictError,
  NotFoundError,
  PreconditionRequiredError,
  UnsupportedOperationError,
  ValidationError
} from './errors';
import { runHooks } from './hooks';
import { prepareWrite, type WritableColumns } from './validation';

export const MAX_PAGE_SIZE = 200;
export type EntryStatusTarget = 'published' | 'archived';

/** The token a write is checked against: the revision an editor loaded, or a native row's updatedAt. */
export interface WriteExpectation {
  /** The latest revision the caller loaded (a string); null for an entry loaded without revisions. */
  revisionId?: unknown;
  /** The updatedAt a native row was loaded with (a Date or its JSON text). */
  updatedAt?: unknown;
}

export interface CreateEntryInput {
  data?: unknown;
  id?: unknown;
  slug?: unknown;
  /** Publish or archive the new entry straight away (server code). */
  status?: EntryStatusTarget;
  columns?: WritableColumns;
}

export interface UpdateEntryInput {
  data?: unknown;
  slug?: unknown;
  expect?: WriteExpectation;
  status?: EntryStatusTarget;
  columns?: WritableColumns;
}

export interface EntriesPage {
  docs: any[];
  nextCursor: string | null;
}

export const NATIVE_PUBLISHING_MESSAGE = 'Publishing workflows are not available for native collections';
export const NATIVE_REVISIONS_MESSAGE = 'Revision history is not available for native collections';

/** A native row in the entry envelope the admin and the SDK read. */
export function mapNativeEntry(row: any, collectionId: string, nativeIdCol: string) {
  const resolvedId = row?.[nativeIdCol] ?? row?.id ?? '';

  return {
    id: resolvedId,
    collectionId,
    slug: row?.slug || resolvedId || '',
    status: typeof row?.status === 'string' ? row.status : 'published',
    data: row,
    createdAt: row?.createdAt || new Date(),
    updatedAt: row?.updatedAt || new Date()
  };
}

/** Compares an updatedAt read from D1 with the JSON value an editor loaded (an ISO string for dates). */
export function timestampKey(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Date.parse(value))) return Date.parse(value);
  return value ?? null;
}

export function encodeCursor(position: unknown[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(position));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(cursor: string): unknown[] {
  try {
    const binary = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const position = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
    if (Array.isArray(position)) return position;
  } catch {
    // Reported below.
  }
  throw new InvalidInputError('The cursor is not valid.');
}

/**
 * An entry with revisions must name the latest one it was loaded with; without one a user's write
 * is refused (428). An entry loaded without revisions (seeded straight into D1) may send null or
 * nothing: its first versioned write records a baseline revision. Trusted server code that sends
 * nothing skips the check, as getClient always has.
 */
async function resolveExpectedRevision(ctx: ServiceContext, entryId: string, value: unknown): Promise<string | null | undefined> {
  if (typeof value === 'string' && value) return value;
  if (value === null) return null;
  if (ctx.actor.kind !== 'user') return undefined;
  if (await getLatestRevision(ctx.db as any, entryId)) throw new PreconditionRequiredError();
  return null;
}

async function latestRevisionId(ctx: ServiceContext, entryId: string) {
  return (await getLatestRevision(ctx.db as any, entryId))?.id ?? null;
}

async function withRevision<T extends object>(ctx: ServiceContext, entry: T & { id: string }) {
  return { ...toEditableEntry(entry as any), latestRevisionId: await latestRevisionId(ctx, entry.id) };
}

function hookContext(ctx: ServiceContext, collection: ResolvedCollection) {
  return {
    actor: ctx.actor,
    req: ctx.actor.request,
    collection: { slug: collection.slug, native: Boolean(collection.nativeTable) },
  };
}

function writeInput(ctx: ServiceContext, collection: ResolvedCollection) {
  return {
    collection,
    actor: ctx.actor,
    req: ctx.actor.request,
    uiLibraries: ctx.config.uiLibraries,
    hooks: collection.hooks,
    log: ctx.log,
  };
}

async function nativeRow(ctx: ServiceContext, collection: ResolvedCollection, id: string) {
  const { nativeTable, nativeIdCol } = collection;
  const rows = await ctx.db.select().from(nativeTable as any).where(eq((nativeTable as any)[nativeIdCol], id) as any);
  return rows[0] as Record<string, any> | undefined;
}

async function entryRow(ctx: ServiceContext, collection: ResolvedCollection, id: string) {
  return ctx.db.query.entries.findFirst({
    // @ts-ignore
    where: (e: any, { eq, and }: any) => and(eq(e.collectionId, collection.record.id), eq(e.id, id))
  });
}

/** Drafts may be incomplete, but required fields must be filled before an entry goes live. */
function assertPublishable(collection: ResolvedCollection, entry: { data: unknown }) {
  const draftData = typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data;
  const parsed = buildZodSchemaForCollection({ ...collection.config, fields: collection.activeFields }).safeParse(draftData ?? {});
  if (!parsed.success) throw new ValidationError(parsed.error.issues);
}

export function entriesService(ctx: ServiceContext) {
  const { db, env } = ctx;

  async function transition(collection: ResolvedCollection, entryId: string, action: PublishWorkflowAction, expect?: WriteExpectation) {
    if (collection.nativeTable) throw new UnsupportedOperationError(NATIVE_PUBLISHING_MESSAGE);
    const entry = await entryRow(ctx, collection, entryId);
    if (!entry) throw new NotFoundError('Entry not found');
    const expectedRevisionId = await resolveExpectedRevision(ctx, entryId, expect?.revisionId);
    if (action === 'publish') assertPublishable(collection, entry);

    const updated = await triggerPublishingWorkflow(env, {
      collectionSlug: collection.slug,
      entryId,
      action,
      expectedRevisionId,
    }, ctx.config.publishingWorkflowBinding);
    await invalidateEntryCache(env, collection.slug, entryId);
    // A Workflow instance that outlives the wait keeps running and clears the cache when it finishes.
    return { ...await withRevision(ctx, updated), workflow: updated.workflow };
  }

  return {
    /** The collection an operation addresses, with its row, fields, native table and hooks. */
    resolve: (slug: string) => resolveCollection(ctx, slug),

    /** Every record of the collection as the admin edits it: all statuses, draft data, newest first. */
    async list(slug: string) {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, 'read');
      if (collection.nativeTable) {
        const rows = await db.select().from(collection.nativeTable as any);
        return rows.map((row: any) => mapNativeEntry(row, collection.record.id, collection.nativeIdCol));
      }
      const entries = await db.query.entries.findMany({
        // @ts-ignore
        where: (e: any, { eq }: any) => eq(e.collectionId, collection.record.id),
        // @ts-ignore
        orderBy: (e: any, { desc }: any) => [desc(e.createdAt)]
      });
      return entries.map(toEditableEntry);
    },

    /** One page of the collection, newest first; `nextCursor` continues after it. */
    async page(slug: string, options: { limit: number; cursor?: string | null }): Promise<EntriesPage> {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, 'read');
      const limit = options.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
        throw new InvalidInputError(`limit must be a whole number from 1 to ${MAX_PAGE_SIZE}.`);
      }
      const cursor = options.cursor || null;

      if (collection.nativeTable) {
        // Native tables differ in their id and timestamp columns, so pages run newest first by rowid.
        const nativeTable = collection.nativeTable as any;
        const rowid = sql<number>`rowid`;
        const after = cursor === null ? undefined : decodeCursor(cursor)[0];
        if (after !== undefined && !Number.isSafeInteger(after)) throw new InvalidInputError('The cursor is not valid.');
        const rows: any[] = await db.select({ ...getTableColumns(nativeTable), __rowid: rowid }).from(nativeTable)
          .where(after === undefined ? undefined : lt(rowid, after as number))
          .orderBy(desc(rowid))
          .limit(limit + 1);
        const pageRows = rows.slice(0, limit);
        const nextCursor = rows.length > limit ? encodeCursor([pageRows[pageRows.length - 1].__rowid]) : null;
        return { docs: pageRows.map(({ __rowid, ...row }) => mapNativeEntry(row, collection.record.id, collection.nativeIdCol)), nextCursor };
      }

      const entries = schema.entries;
      let after;
      if (cursor !== null) {
        const [createdAtMs, afterId] = decodeCursor(cursor);
        if (typeof createdAtMs !== 'number' || !Number.isFinite(createdAtMs) || typeof afterId !== 'string') {
          throw new InvalidInputError('The cursor is not valid.');
        }
        const createdAt = new Date(createdAtMs);
        after = or(lt(entries.createdAt, createdAt), and(eq(entries.createdAt, createdAt), lt(entries.id, afterId)));
      }
      const rows = await db.select().from(entries)
        .where(and(eq(entries.collectionId, collection.record.id), after))
        .orderBy(desc(entries.createdAt), desc(entries.id))
        .limit(limit + 1);
      const pageRows = rows.slice(0, limit);
      const last = pageRows[pageRows.length - 1];
      const nextCursor = rows.length > limit ? encodeCursor([last.createdAt.getTime(), last.id]) : null;
      return { docs: pageRows.map(toEditableEntry), nextCursor };
    },

    /** One record as the admin edits it, with the latest revision an entry must be saved against; null when missing. */
    async get(slug: string, id: string) {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, 'read');
      if (collection.nativeTable) {
        const row = await nativeRow(ctx, collection, id);
        return row ? mapNativeEntry(row, collection.record.id, collection.nativeIdCol) : null;
      }
      const entry = await entryRow(ctx, collection, id);
      return entry ? withRevision(ctx, entry) : null;
    },

    async create(slug: string, input: CreateEntryInput = {}) {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, 'create');
      const hooks = hookContext(ctx, collection);
      const prepared = await prepareWrite({ ...writeInput(ctx, collection), operation: 'create', data: input.data, id: input.id, slug: input.slug, columns: input.columns });
      const validatedData = prepared.data!;

      if (collection.nativeTable) {
        const nativeTable = collection.nativeTable as any;
        const { nativeIdCol } = collection;
        const insertPayload = prepared.nativePayload!;
        const insertedRows = await db.insert(nativeTable).values(insertPayload).returning();
        const insertedRow = (Array.isArray(insertedRows) ? insertedRows[0] : null) || (
          insertPayload[nativeIdCol] !== undefined && insertPayload[nativeIdCol] !== null
            ? await nativeRow(ctx, collection, insertPayload[nativeIdCol])
            : null
        );
        await invalidateEntryCache(env, slug);
        if (!insertedRow) throw new Error(`Failed to load the created record of collection ${slug}`);
        const doc = mapNativeEntry(insertedRow, collection.record.id, nativeIdCol);
        await runHooks(collection.hooks, 'afterChange', { ...hooks, data: validatedData, operation: 'create', doc }, { log: ctx.log });
        return doc;
      }

      const created = await createDraftEntry(db as any, collection.record as any, validatedData, { id: prepared.id, slug: prepared.slug });
      await invalidateEntryCache(env, slug);
      await runHooks(collection.hooks, 'afterChange', { ...hooks, data: validatedData, operation: 'create', doc: created }, { log: ctx.log });
      if (input.status) {
        return transition(collection, created.id, input.status === 'archived' ? 'archive' : 'publish', { revisionId: await latestRevisionId(ctx, created.id) });
      }
      return withRevision(ctx, created);
    },

    async update(slug: string, id: string, input: UpdateEntryInput = {}) {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, 'update');
      const hooks = hookContext(ctx, collection);

      if (collection.nativeTable) {
        const nativeTable = collection.nativeTable as any;
        const { nativeIdCol } = collection;
        const stored = await nativeRow(ctx, collection, id);
        if (!stored) throw new NotFoundError('Entry not found');
        const originalDoc = mapNativeEntry(stored, collection.record.id, nativeIdCol);

        // Native records have no revisions: an editor sends the updatedAt it loaded instead.
        const checksUpdatedAt = input.expect?.updatedAt !== undefined && Boolean(nativeTable.updatedAt);
        if (checksUpdatedAt && timestampKey(stored.updatedAt) !== timestampKey(input.expect?.updatedAt)) {
          throw new NativeRecordConflictError();
        }

        const prepared = await prepareWrite({ ...writeInput(ctx, collection), operation: 'update', data: input.data, stored, originalDoc, columns: input.columns });
        const updatePayload = prepared.nativePayload ?? {};

        let storedRow = stored;
        if (Object.keys(updatePayload).length > 0) {
          // Re-check updatedAt in the write itself, so a save that lands after the check still loses.
          const unchanged = !checksUpdatedAt ? undefined
            : stored.updatedAt == null ? isNull(nativeTable.updatedAt) : eq(nativeTable.updatedAt, stored.updatedAt);
          const updatedRows: any[] = await db.update(nativeTable).set(updatePayload)
            .where(and(eq(nativeTable[nativeIdCol], id), unchanged) as any).returning() as any[];
          const updatedRow = updatedRows[0];
          if (!updatedRow && checksUpdatedAt) throw new NativeRecordConflictError();
          // The stored row carries updatedAt at the column's precision, ready for the next stale check.
          storedRow = updatedRow ?? { ...stored, ...updatePayload };
        }

        await invalidateEntryCache(env, slug, id);
        const doc = {
          ...mapNativeEntry(storedRow, collection.record.id, nativeIdCol),
          slug: (typeof input.slug === 'string' && input.slug) || stored.slug || id,
        };
        await runHooks(collection.hooks, 'afterChange', { ...hooks, data: prepared.data || {}, operation: 'update', originalDoc, doc }, { log: ctx.log });
        return doc;
      }

      const stored = await entryRow(ctx, collection, id);
      if (!stored) throw new NotFoundError('Entry not found');
      const expectedRevisionId = await resolveExpectedRevision(ctx, id, input.expect?.revisionId);
      const prepared = await prepareWrite({ ...writeInput(ctx, collection), operation: 'update', data: input.data, slug: input.slug, stored, originalDoc: stored, columns: input.columns });

      const updated = await saveDraftEntry(db as any, collection.record as any, id, {
        data: prepared.data,
        slug: prepared.slug,
        expectedRevisionId
      });
      await invalidateEntryCache(env, slug, id);
      await runHooks(collection.hooks, 'afterChange', { ...hooks, data: prepared.data ?? {}, operation: 'update', originalDoc: stored, doc: updated }, { log: ctx.log });
      if (input.status) {
        return transition(collection, id, input.status === 'archived' ? 'archive' : 'publish', { revisionId: await latestRevisionId(ctx, id) });
      }
      return withRevision(ctx, updated);
    },

    /** Removes a record; the media collection's file goes first, since media-serve reads R2 without checking the record. */
    async remove(slug: string, id: string, options: { origin?: string } = {}) {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, 'delete');
      const hooks = hookContext(ctx, collection);

      let originalDoc: any;
      if (collection.nativeTable) {
        const stored = await nativeRow(ctx, collection, id);
        if (!stored) throw new NotFoundError('Entry not found');
        originalDoc = mapNativeEntry(stored, collection.record.id, collection.nativeIdCol);
      } else {
        originalDoc = await entryRow(ctx, collection, id);
        if (!originalDoc) throw new NotFoundError('Entry not found');
      }

      await runHooks(collection.hooks, 'beforeDelete', { ...hooks, operation: 'delete', originalDoc }, { log: ctx.log });

      if (collection.nativeTable) {
        // If the record delete then fails, the record is still there to delete again.
        if (isMediaCollection(collection.config)) await deleteStoredMedia(env, id, options.origin);
        await db.delete(collection.nativeTable as any).where(eq((collection.nativeTable as any)[collection.nativeIdCol], id) as any);
      } else {
        await db.delete(schema.entries).where(and(eq(schema.entries.collectionId, collection.record.id), eq(schema.entries.id, id)));
      }

      await invalidateEntryCache(env, slug, id);
      await runHooks(collection.hooks, 'afterDelete', { ...hooks, operation: 'delete', originalDoc, doc: originalDoc }, { log: ctx.log });
    },

    async publish(slug: string, id: string, options: { expect?: WriteExpectation } = {}) {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, 'publish');
      return transition(collection, id, 'publish', options.expect);
    },

    async archive(slug: string, id: string, options: { expect?: WriteExpectation } = {}) {
      const collection = await resolveCollection(ctx, slug);
      assertAllowed(ctx.actor, collection.config, 'archive');
      return transition(collection, id, 'archive', options.expect);
    },
  };
}
