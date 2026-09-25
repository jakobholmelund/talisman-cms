import { and, desc, eq, isNull } from 'drizzle-orm';
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

type CollectionRecord = typeof schema.collections.$inferSelect;
type EntryRecord = typeof schema.entries.$inferSelect;
type RevisionRecord = typeof schema.entryRevisions.$inferSelect;

function createId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeEntryDataForRead(entry: any, version: 'draft' | 'published' = 'published') {
  if (version === 'published' && entry?.status === 'published' && entry?.publishedData !== undefined && entry?.publishedData !== null) {
    return { ...entry, data: entry.publishedData };
  }

  return entry;
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
    throw new Error(`Entry ${entryId} not found`);
  }

  return entry as EntryRecord;
}

export async function listEntryRevisions(
  db: ReturnType<typeof createVersioningDb>,
  collectionId: string,
  entryId: string
) {
  return db.query.entryRevisions.findMany({
    // @ts-ignore
    where: (r, { and, eq }) => and(eq(r.collectionId, collectionId), eq(r.entryId, entryId)),
    // @ts-ignore
    orderBy: (r, { desc }) => [desc(r.revisionNumber), desc(r.createdAt)]
  }) as Promise<RevisionRecord[]>;
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

async function writeRevisionBatch(db: ReturnType<typeof createVersioningDb>, queries: any[]) {
  try {
    await db.batch(queries as any);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed.*(entry_id|revision_number)|galaxy_entry_revisions_entry_number_unique/i.test(error.message)) {
      throw new RevisionConflictError();
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
  const slug = opts?.slug || id;

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
  if (params.slug !== undefined) updates.slug = params.slug;

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

  const now = new Date();
  await writeRevisionBatch(db, [...revision.queries, db.update(schema.entries)
    .set({
      status: 'published',
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
  const revision = await db.query.entryRevisions.findFirst({
    // @ts-ignore
    where: (r, { and, eq }) => and(eq(r.collectionId, collection.id), eq(r.entryId, entryId), eq(r.id, revisionId))
  });

  if (!revision) {
    throw new Error(`Revision ${revisionId} not found for entry ${entryId}`);
  }

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

export async function waitForWorkflowCompletion(instance: WorkflowInstance, timeoutMs = 5000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const status = await instance.status();

    if (status.status === 'complete') {
      return status;
    }

    if (status.status === 'errored' || status.status === 'terminated') {
      throw new Error(status.error?.message || `Workflow ${instance.id} ended with status ${status.status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Workflow ${instance.id} did not complete within ${timeoutMs}ms`);
}

export async function triggerPublishingWorkflow(
  env: TalismanEnv,
  payload: PublishWorkflowPayload,
  bindingName = DEFAULT_PUBLISHING_WORKFLOW_BINDING
) {
  // The default binding also accepts its pre-rename GALAXY_PUBLISH_WORKFLOW name.
  const workflow = (bindingName === DEFAULT_PUBLISHING_WORKFLOW_BINDING
    ? readBinding(env, 'PUBLISH_WORKFLOW')
    : (env as any)?.[bindingName]) as Workflow<PublishWorkflowPayload> | undefined;

  if (!workflow) {
    return runPublishingTransition(env, payload);
  }

  const instance = await workflow.create({
    id: `talisman-${payload.action}-${payload.collectionSlug}-${payload.entryId}-${Date.now()}`,
    params: payload,
  });

  await waitForWorkflowCompletion(instance);
  const db = createVersioningDb(env);
  const collection = await getCollectionBySlug(db, payload.collectionSlug);
  return getVersionedEntry(db, collection.id, payload.entryId);
}

export async function invalidateEntryCache(
  env: TalismanEnv,
  collectionSlug: string,
  entryId?: string
) {
  if (!env.KV) return;

  await env.KV.delete(`talisman:entries:${collectionSlug}:all`);
  await env.KV.delete(`talisman:entries:${collectionSlug}:all:draft`);
  await env.KV.delete(`talisman:entries:${collectionSlug}:all:published`);
  if (entryId) {
    await env.KV.delete(`talisman:entries:${collectionSlug}:${entryId}`);
    await env.KV.delete(`talisman:entries:${collectionSlug}:${entryId}:draft`);
    await env.KV.delete(`talisman:entries:${collectionSlug}:${entryId}:published`);
  }
}
