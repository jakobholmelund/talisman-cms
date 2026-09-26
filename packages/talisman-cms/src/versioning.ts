import { and, desc, eq, isNull, ne, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import type { TalismanEnv } from './db/client';
import { readBinding } from './env';

export const DEFAULT_PUBLISHING_WORKFLOW_BINDING = 'TALISMAN_PUBLISH_WORKFLOW';

export type EntryStatus = 'draft' | 'published' | 'archived';
export type RevisionType = 'draft_save' | 'publish' | 'archive' | 'restore';
export type PublishWorkflowAction = 'publish' | 'archive';

export interface PublishWorkflowPayload {
  collectionSlug: string;
  entryId: string;
  action: PublishWorkflowAction;
  /** The latest revision the editor loaded, or null for an entry loaded without revisions. */
  expectedRevisionId?: string | null;
}

const REVISION_CONFLICT_MESSAGE = 'This entry changed since it was opened. Reload it before saving.';

export class RevisionConflictError extends Error {
  constructor() {
    super(REVISION_CONFLICT_MESSAGE);
    this.name = 'RevisionConflictError';
  }
}

export function isRevisionConflict(error: unknown) {
  return error instanceof RevisionConflictError ||
    (error instanceof Error && error.message.includes(REVISION_CONFLICT_MESSAGE));
}

const SLUG_CONFLICT_MESSAGE = 'Another entry in this collection already uses this slug.';

export class SlugConflictError extends Error {
  constructor() {
    super(SLUG_CONFLICT_MESSAGE);
    this.name = 'SlugConflictError';
  }
}

/** Also matches the message of a publish that failed inside a Workflow instance. */
export function isSlugConflict(error: unknown) {
  return error instanceof SlugConflictError ||
    (error instanceof Error && error.message.includes(SLUG_CONFLICT_MESSAGE));
}

export class EntryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntryNotFoundError';
  }
}

export function isEntryNotFound(error: unknown) {
  return error instanceof EntryNotFoundError ||
    (error instanceof Error && /^(Entry|Revision) .+ not found/.test(error.message));
}

/**
 * A publish or archive that fails this way fails again on retry: a stale revision, a slug another
 * entry serves, or an entry, collection or action that does not exist.
 */
export function isPermanentPublishError(error: unknown) {
  return isRevisionConflict(error) || isSlugConflict(error) || isEntryNotFound(error) ||
    (error instanceof Error && /^(Collection .+ not found|Unsupported publish workflow action)/.test(error.message));
}

type CollectionRecord = typeof schema.collections.$inferSelect;
type EntryRecord = typeof schema.entries.$inferSelect;
type RevisionRecord = typeof schema.entryRevisions.$inferSelect;

function createId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeEntryDataForRead(entry: any, version: 'draft' | 'published' = 'published') {
  if (!entry) return entry;

  if (version === 'draft') {
    // A draft read shows the slug the next publish will make live.
    return entry.draftSlug ? { ...entry, slug: entry.draftSlug } : entry;
  }

  // A pending rename is draft state, like the draft data, so the published read leaves it out.
  const { draftSlug: _draftSlug, ...published } = entry;
  if (entry.status === 'published' && entry.publishedData !== undefined && entry.publishedData !== null) {
    return { ...published, data: entry.publishedData };
  }

  return published;
}

/**
 * The admin's view of an entry: `slug` is the slug being edited, which a published entry only
 * takes live on its next publish, and `publishedSlug` is the slug the site serves it under.
 */
export function toEditableEntry<T extends { slug: string; status: string; draftSlug?: string | null }>(entry: T) {
  return {
    ...entry,
    slug: entry.draftSlug || entry.slug,
    publishedSlug: entry.status === 'published' ? entry.slug : null,
  };
}

function createVersioningDb(env: TalismanEnv) {
  return drizzle(env.DB, { schema });
}

export async function getCollectionBySlug(db: ReturnType<typeof createVersioningDb>, collectionSlug: string) {
  const collection = await db.query.collections.findFirst({
    // @ts-ignore
    where: (c, { eq }) => eq(c.slug, collectionSlug)
  });

  if (!collection) {
    throw new Error(`Collection ${collectionSlug} not found`);
  }

  return collection as CollectionRecord;
}

export async function getVersionedEntry(
  db: ReturnType<typeof createVersioningDb>,
  collectionId: string,
  entryId: string
) {
  const entry = await db.query.entries.findFirst({
    // @ts-ignore
    where: (e, { and, eq }) => and(eq(e.collectionId, collectionId), eq(e.id, entryId))
  });

  if (!entry) {
    throw new EntryNotFoundError(`Entry ${entryId} not found`);
  }

  return entry as EntryRecord;
}

/**
 * Newest first. `includeData: false` returns the metadata the history panel shows without each
 * revision's full snapshot, which grows with every save; getEntryRevision loads one on demand.
 */
export async function listEntryRevisions(
  db: ReturnType<typeof createVersioningDb>,
  collectionId: string,
  entryId: string,
  opts: { includeData?: boolean; limit?: number } = {}
) {
  const revisions = schema.entryRevisions;
  if (opts.includeData === false) {
    const query = db.select({
      id: revisions.id,
      entryId: revisions.entryId,
      collectionId: revisions.collectionId,
      revisionNumber: revisions.revisionNumber,
      type: revisions.type,
      status: revisions.status,
      createdAt: revisions.createdAt,
    }).from(revisions)
      .where(and(eq(revisions.collectionId, collectionId), eq(revisions.entryId, entryId)))
      .orderBy(desc(revisions.revisionNumber), desc(revisions.createdAt));
    return opts.limit === undefined ? query : query.limit(opts.limit);
  }

  return db.query.entryRevisions.findMany({
    // @ts-ignore
    where: (r, { and, eq }) => and(eq(r.collectionId, collectionId), eq(r.entryId, entryId)),
    // @ts-ignore
    orderBy: (r, { desc }) => [desc(r.revisionNumber), desc(r.createdAt)],
    ...(opts.limit === undefined ? {} : { limit: opts.limit })
  }) as Promise<RevisionRecord[]>;
}

export async function getEntryRevision(
  db: ReturnType<typeof createVersioningDb>,
  collectionId: string,
  entryId: string,
  revisionId: string
) {
  const revision = await db.query.entryRevisions.findFirst({
    // @ts-ignore
    where: (r, { and, eq }) => and(eq(r.collectionId, collectionId), eq(r.entryId, entryId), eq(r.id, revisionId))
  });

  if (!revision) {
    throw new EntryNotFoundError(`Revision ${revisionId} not found for entry ${entryId}`);
  }

  return revision as RevisionRecord;
}

/** The slug an editor works on: a published entry keeps serving its live slug until it is published again. */
function editableSlug(entry: Pick<EntryRecord, 'slug' | 'draftSlug'>) {
  return entry.draftSlug || entry.slug;
}

/**
 * A slug names one entry per collection. A draft slug may not match another entry's slug or
 * pending rename, so its publish cannot take over a page that is live.
 */
async function assertDraftSlugAvailable(
  db: ReturnType<typeof createVersioningDb>,
  collectionId: string,
  entryId: string,
  slug: string
) {
  const entries = schema.entries;
  const [holder] = await db.select({ id: entries.id }).from(entries).where(and(
    eq(entries.collectionId, collectionId),
    ne(entries.id, entryId),
    or(eq(entries.slug, slug), eq(entries.draftSlug, slug)),
  )).limit(1);

  if (holder) throw new SlugConflictError();
}

/**
 * Publishing takes the entry's draft slug live, unless another published entry already serves it
 * (slugs written straight to D1 are not checked on save). An unchanged live slug is not re-checked.
 */
export async function assertPublishableSlug(
  db: ReturnType<typeof createVersioningDb>,
  entry: Pick<EntryRecord, 'id' | 'collectionId' | 'slug' | 'draftSlug' | 'status'>
) {
  const slug = editableSlug(entry);
  if (entry.status === 'published' && slug === entry.slug) return;

  const entries = schema.entries;
  const [holder] = await db.select({ id: entries.id }).from(entries).where(and(
    eq(entries.collectionId, entry.collectionId),
    ne(entries.id, entry.id),
    eq(entries.status, 'published'),
    eq(entries.slug, slug),
  )).limit(1);

  if (holder) throw new SlugConflictError();
}

export async function getLatestRevision(
  db: ReturnType<typeof createVersioningDb>,
  entryId: string
) {
  const [row] = await db
    .select({ id: schema.entryRevisions.id, revisionNumber: schema.entryRevisions.revisionNumber })
    .from(schema.entryRevisions)
    .where(eq(schema.entryRevisions.entryId, entryId))
    .orderBy(desc(schema.entryRevisions.revisionNumber))
    .limit(1);

  return row ?? null;
}

/**
 * `expectedRevisionId` is the latest revision the editor loaded; any other latest revision is a
 * conflict. `null` means the editor loaded an entry without revisions (one seeded straight into
 * D1, for example), which is accepted only while it still has none. Leave it undefined for
 * trusted server-side writes that skip the check.
 */
function assertExpectedRevision(
  latest: Awaited<ReturnType<typeof getLatestRevision>>,
  expectedRevisionId: string | null | undefined
) {
  if (expectedRevisionId !== undefined && (latest?.id ?? null) !== expectedRevisionId) {
    throw new RevisionConflictError();
  }
}

function revisionTypeForStatus(status: EntryStatus): RevisionType {
  if (status === 'published') return 'publish';
  if (status === 'archived') return 'archive';
  return 'draft_save';
}

/**
 * The first versioned write to an entry without revisions records its stored state as revision 1
 * in the same batch (as migrations 0003 and 0020 do), so that state can be restored. A published
 * entry also gets its published snapshot pinned, so the draft change does not go live.
 */
function buildBaselineRevision(db: ReturnType<typeof createVersioningDb>, entry: EntryRecord) {
  const id = createId('rev');
  const status = entry.status as EntryStatus;
  const publishedData = entry.publishedData ?? entry.data;
  const queries: any[] = [db.insert(schema.entryRevisions).values({
    id,
    entryId: entry.id,
    collectionId: entry.collectionId,
    revisionNumber: 1,
    type: revisionTypeForStatus(status),
    status,
    data: status === 'published' ? publishedData : entry.data,
    createdAt: entry.updatedAt ?? new Date(),
  })];

  if (status === 'published' && !entry.publishedRevisionId) {
    queries.push(db.update(schema.entries)
      .set({ publishedData, publishedRevisionId: id })
      .where(and(eq(schema.entries.id, entry.id), isNull(schema.entries.publishedRevisionId))));
  }

  return queries;
}

/** The messages of an error and its causes, where D1 and Drizzle put the SQLite error. */
function errorMessages(error: unknown) {
  const messages: string[] = [];
  for (let current: any = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    if (typeof current.message === 'string') messages.push(current.message);
  }
  return messages.join('\n');
}

async function writeRevisionBatch(db: ReturnType<typeof createVersioningDb>, queries: any[]) {
  try {
    await db.batch(queries as any);
  } catch (error) {
    const messages = errorMessages(error);
    if (/UNIQUE constraint failed.*(entry_id|revision_number)|galaxy_entry_revisions_entry_number_unique/i.test(messages)) {
      throw new RevisionConflictError();
    }
    // Migration 0023's index on the live slugs of published entries: two publishes of one slug raced.
    if (/UNIQUE constraint failed: galaxy_entries\.collection_id, galaxy_entries\.slug|galaxy_entries_published_slug_unique/i.test(messages)) {
      throw new SlugConflictError();
    }
    throw error;
  }
}

async function buildRevisionInsert(
  db: ReturnType<typeof createVersioningDb>,
  params: {
    entry: Pick<EntryRecord, 'id' | 'collectionId'>;
    snapshotData: any;
    status: EntryStatus;
    type: RevisionType;
    expectedRevisionId?: string | null;
    /** The stored entry, when it already exists: a baseline is recorded if it has no revisions. */
    existing?: EntryRecord;
  }
) {
  const latest = await getLatestRevision(db, params.entry.id);
  assertExpectedRevision(latest, params.expectedRevisionId);
  const baseline = !latest && params.existing ? buildBaselineRevision(db, params.existing) : [];
  const revisionNumber = latest ? latest.revisionNumber + 1 : baseline.length > 0 ? 2 : 1;
  const revisionId = createId('rev');

  const query = db.insert(schema.entryRevisions).values({
    id: revisionId,
    entryId: params.entry.id,
    collectionId: params.entry.collectionId,
    revisionNumber,
    type: params.type,
    status: params.status,
    data: params.snapshotData,
    createdAt: new Date(),
  });

  return { id: revisionId, queries: [...baseline, query] };
}

export async function createDraftEntry(
  db: ReturnType<typeof createVersioningDb>,
  collection: CollectionRecord,
  data: any,
  opts?: { id?: string; slug?: string }
) {
  const now = new Date();
  const id = opts?.id || createId('entry');
  const slug = opts?.slug?.trim() || id;
  await assertDraftSlugAvailable(db, collection.id, id, slug);

  const entryInsert = db.insert(schema.entries).values({
    id,
    collectionId: collection.id,
    slug,
    status: 'draft',
    data,
    createdAt: now,
    updatedAt: now,
  });

  const revision = await buildRevisionInsert(db, {
    entry: { id, collectionId: collection.id },
    snapshotData: data,
    status: 'draft',
    type: 'draft_save'
  });
  await writeRevisionBatch(db, [entryInsert, ...revision.queries]);

  return getVersionedEntry(db, collection.id, id);
}

export async function saveDraftEntry(
  db: ReturnType<typeof createVersioningDb>,
  collection: CollectionRecord,
  entryId: string,
  params: { data?: any; slug?: string; expectedRevisionId?: string | null }
) {
  const existing = await getVersionedEntry(db, collection.id, entryId);
  const updates: Partial<typeof schema.entries.$inferInsert> & { updatedAt: Date } = {
    updatedAt: new Date(),
  };

  if (params.data !== undefined) updates.data = params.data;

  // A blank slug keeps the current one. A published entry's rename is kept as its draft slug, so
  // the live URL only changes when the entry is published again.
  const slug = params.slug?.trim();
  if (slug) {
    if (slug !== editableSlug(existing)) {
      await assertDraftSlugAvailable(db, collection.id, entryId, slug);
    }

    if (existing.status === 'published') {
      updates.draftSlug = slug === existing.slug ? null : slug;
    } else {
      updates.slug = slug;
      updates.draftSlug = null;
    }
  }

  const revision = await buildRevisionInsert(db, {
    entry: existing,
    snapshotData: params.data !== undefined ? params.data : existing.data,
    status: existing.status as EntryStatus,
    type: 'draft_save',
    expectedRevisionId: params.expectedRevisionId,
    existing
  });
  await writeRevisionBatch(db, [db.update(schema.entries)
    .set(updates)
    .where(and(eq(schema.entries.collectionId, collection.id), eq(schema.entries.id, entryId))), ...revision.queries]);

  return getVersionedEntry(db, collection.id, entryId);
}

export async function publishEntry(
  db: ReturnType<typeof createVersioningDb>,
  collection: CollectionRecord,
  entryId: string,
  expectedRevisionId?: string | null
) {
  const entry = await getVersionedEntry(db, collection.id, entryId);

  const revision = await buildRevisionInsert(db, {
    entry,
    snapshotData: entry.data,
    status: 'published',
    type: 'publish',
    expectedRevisionId,
    existing: entry
  });
  await assertPublishableSlug(db, entry);

  const now = new Date();
  await writeRevisionBatch(db, [...revision.queries, db.update(schema.entries)
    .set({
      status: 'published',
      slug: editableSlug(entry),
      draftSlug: null,
      publishedData: entry.data,
      publishedRevisionId: revision.id,
      publishedAt: now,
      archivedAt: null,
      updatedAt: now,
    })
    .where(and(eq(schema.entries.collectionId, collection.id), eq(schema.entries.id, entryId)))]);

  return getVersionedEntry(db, collection.id, entryId);
}

export async function archiveEntry(
  db: ReturnType<typeof createVersioningDb>,
  collection: CollectionRecord,
  entryId: string,
  expectedRevisionId?: string | null
) {
  const entry = await getVersionedEntry(db, collection.id, entryId);
  const archiveSnapshot = entry.publishedData ?? entry.data;

  const revision = await buildRevisionInsert(db, {
    entry,
    snapshotData: archiveSnapshot,
    status: 'archived',
    type: 'archive',
    expectedRevisionId,
    existing: entry
  });

  const now = new Date();
  await writeRevisionBatch(db, [...revision.queries, db.update(schema.entries)
    .set({
      status: 'archived',
      archivedAt: now,
      updatedAt: now,
    })
    .where(and(eq(schema.entries.collectionId, collection.id), eq(schema.entries.id, entryId)))]);

  return getVersionedEntry(db, collection.id, entryId);
}

export async function restoreEntryRevision(
  db: ReturnType<typeof createVersioningDb>,
  collection: CollectionRecord,
  entryId: string,
  revisionId: string,
  expectedRevisionId?: string | null
) {
  const entry = await getVersionedEntry(db, collection.id, entryId);
  const revision = await getEntryRevision(db, collection.id, entryId, revisionId);

  const now = new Date();
  const restoredRevision = await buildRevisionInsert(db, {
    entry,
    snapshotData: revision.data,
    status: entry.status === 'archived' ? 'draft' : entry.status as EntryStatus,
    type: 'restore',
    expectedRevisionId,
    existing: entry
  });
  await writeRevisionBatch(db, [db.update(schema.entries)
    .set({
      data: revision.data,
      updatedAt: now,
      status: entry.status === 'archived' ? 'draft' : entry.status,
      archivedAt: entry.status === 'archived' ? null : entry.archivedAt,
    })
    .where(and(eq(schema.entries.collectionId, collection.id), eq(schema.entries.id, entryId))), ...restoredRevision.queries]);

  return getVersionedEntry(db, collection.id, entryId);
}

export async function runPublishingTransition(
  env: TalismanEnv,
  payload: PublishWorkflowPayload
) {
  const db = createVersioningDb(env);
  const collection = await getCollectionBySlug(db, payload.collectionSlug);

  if (payload.action === 'publish') {
    return publishEntry(db, collection, payload.entryId, payload.expectedRevisionId);
  }

  if (payload.action === 'archive') {
    return archiveEntry(db, collection, payload.entryId, payload.expectedRevisionId);
  }

  throw new Error(`Unsupported publish workflow action: ${payload.action}`);
}

/**
 * What TalismanPublishWorkflow returns. A transition that cannot succeed (see isPermanentPublishError)
 * ends the instance as complete with `ok: false` and the error, which the waiting request rethrows.
 */
export type PublishWorkflowResult =
  | { ok: true; entryId: string; status: string }
  | { ok: false; error: { name: string; message: string } };

/** A publish or archive Workflow instance that was still running when the request stopped waiting. */
export interface PendingPublishWorkflow {
  status: 'pending';
  instanceId: string;
}

export class PublishWorkflowPendingError extends Error {
  instanceId: string;

  constructor(instanceId: string, timeoutMs: number) {
    super(`Workflow ${instanceId} did not complete within ${timeoutMs}ms`);
    this.name = 'PublishWorkflowPendingError';
    this.instanceId = instanceId;
  }
}

/** An instance's failure arrives as a message; known ones become the errors an inline transition throws. */
function workflowFailure(message: string) {
  if (isRevisionConflict(new Error(message))) return new RevisionConflictError();
  if (isSlugConflict(new Error(message))) return new SlugConflictError();
  if (isEntryNotFound(new Error(message))) return new EntryNotFoundError(message);
  return new Error(message);
}

/**
 * Polls the instance until it completes, resolving to its status, or fails, throwing its error (also
 * when it completes with a failed transition). An instance still running after `timeoutMs` throws
 * PublishWorkflowPendingError and keeps running on its own.
 */
export async function waitForWorkflowCompletion(instance: WorkflowInstance, timeoutMs = 10_000) {
  const startedAt = Date.now();
  // Short waits first, since most instances finish quickly, without spending many subrequests.
  for (let delay = 100; ; delay = Math.min(delay * 2, 1000)) {
    const status = await instance.status();

    if (status.status === 'complete') {
      const output = status.output as Partial<Extract<PublishWorkflowResult, { ok: false }>> | undefined;
      if (output?.ok === false) {
        throw workflowFailure(output.error?.message || `Workflow ${instance.id} could not apply the transition`);
      }
      return status;
    }

    if (status.status === 'errored' || status.status === 'terminated') {
      throw workflowFailure(status.error?.message || `Workflow ${instance.id} ended with status ${status.status}`);
    }

    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
  }

  throw new PublishWorkflowPendingError(instance.id, timeoutMs);
}

/** Instance ids allow letters, digits, "-" and "_" (at most 100), while entry ids may also hold ":" or ".". */
function workflowInstanceId(payload: PublishWorkflowPayload) {
  const target = `${payload.collectionSlug}-${payload.entryId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60);
  return `talisman-${payload.action}-${target}-${Date.now()}`;
}

/**
 * Runs a publish or archive, through the Workflow binding when there is one. The result is the entry
 * after the transition. When the Workflow instance is still running after the wait, it is the entry as
 * stored before the transition, with `workflow: { status: 'pending', instanceId }`; the instance
 * finishes on its own and clears the cache. Failures throw the same errors in both modes.
 */
export async function triggerPublishingWorkflow(
  env: TalismanEnv,
  payload: PublishWorkflowPayload,
  bindingName = DEFAULT_PUBLISHING_WORKFLOW_BINDING
): Promise<EntryRecord & { workflow?: PendingPublishWorkflow }> {
  // The default binding also accepts its pre-rename GALAXY_PUBLISH_WORKFLOW name.
  const workflow = (bindingName === DEFAULT_PUBLISHING_WORKFLOW_BINDING
    ? readBinding(env, 'PUBLISH_WORKFLOW')
    : (env as any)?.[bindingName]) as Workflow<PublishWorkflowPayload> | undefined;

  if (!workflow) {
    return runPublishingTransition(env, payload);
  }

  const db = createVersioningDb(env);
  const collection = await getCollectionBySlug(db, payload.collectionSlug);
  const entry = await getVersionedEntry(db, collection.id, payload.entryId);
  // A Workflow reports a failure only once its instance ends, so a slug conflict is caught here first.
  if (payload.action === 'publish') await assertPublishableSlug(db, entry);

  const instance = await workflow.create({
    id: workflowInstanceId(payload),
    params: payload,
  });

  try {
    await waitForWorkflowCompletion(instance);
  } catch (error) {
    if (!(error instanceof PublishWorkflowPendingError)) throw error;
    return { ...await getVersionedEntry(db, collection.id, payload.entryId), workflow: { status: 'pending', instanceId: instance.id } };
  }
  return getVersionedEntry(db, collection.id, payload.entryId);
}

/**
 * Drops the KV copies of a collection's cached lists and of the given entries' cached reads. Code
 * that writes rows without getClient (a D1 batch, for example) calls it once the write has
 * committed, as the admin API and getClient do after theirs.
 */
export async function invalidateEntryCache(
  env: TalismanEnv,
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
