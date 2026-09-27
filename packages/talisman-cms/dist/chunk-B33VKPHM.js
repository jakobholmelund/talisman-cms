import {
  entries,
  entryRevisions,
  schema_exports
} from "./chunk-NSKY6EIU.js";
import {
  readBinding
} from "./chunk-R6EGKTST.js";

// src/versioning.ts
import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
var DEFAULT_PUBLISHING_WORKFLOW_BINDING = "TALISMAN_PUBLISH_WORKFLOW";
var REVISION_CONFLICT_MESSAGE = "This entry changed since it was opened. Reload it before saving.";
var RevisionConflictError = class extends Error {
  constructor() {
    super(REVISION_CONFLICT_MESSAGE);
    this.name = "RevisionConflictError";
  }
};
function isRevisionConflict(error) {
  return error instanceof RevisionConflictError || error instanceof Error && error.message.includes(REVISION_CONFLICT_MESSAGE);
}
var SLUG_CONFLICT_MESSAGE = "Another entry in this collection already uses this slug.";
var SlugConflictError = class extends Error {
  constructor() {
    super(SLUG_CONFLICT_MESSAGE);
    this.name = "SlugConflictError";
  }
};
function isSlugConflict(error) {
  return error instanceof SlugConflictError || error instanceof Error && error.message.includes(SLUG_CONFLICT_MESSAGE);
}
var EntryNotFoundError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "EntryNotFoundError";
  }
};
function isEntryNotFound(error) {
  return error instanceof EntryNotFoundError || error instanceof Error && /^(Entry|Revision) .+ not found/.test(error.message);
}
function isPermanentPublishError(error) {
  return isRevisionConflict(error) || isSlugConflict(error) || isEntryNotFound(error) || error instanceof Error && /^(Collection .+ not found|Unsupported publish workflow action)/.test(error.message);
}
function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
function normalizeEntryDataForRead(entry, version = "published") {
  if (!entry) return entry;
  if (version === "draft") {
    return entry.draftSlug ? { ...entry, slug: entry.draftSlug } : entry;
  }
  const { draftSlug: _draftSlug, ...published } = entry;
  if (entry.status === "published" && entry.publishedData !== void 0 && entry.publishedData !== null) {
    return { ...published, data: entry.publishedData };
  }
  return published;
}
function toEditableEntry(entry) {
  return {
    ...entry,
    slug: entry.draftSlug || entry.slug,
    publishedSlug: entry.status === "published" ? entry.slug : null
  };
}
function createVersioningDb(env) {
  return drizzle(env.DB, { schema: schema_exports });
}
async function getCollectionBySlug(db, collectionSlug) {
  const collection = await db.query.collections.findFirst({
    // @ts-ignore
    where: (c, { eq: eq2 }) => eq2(c.slug, collectionSlug)
  });
  if (!collection) {
    throw new Error(`Collection ${collectionSlug} not found`);
  }
  return collection;
}
async function getVersionedEntry(db, collectionId, entryId) {
  const entry = await db.query.entries.findFirst({
    // @ts-ignore
    where: (e, { and: and2, eq: eq2 }) => and2(eq2(e.collectionId, collectionId), eq2(e.id, entryId))
  });
  if (!entry) {
    throw new EntryNotFoundError(`Entry ${entryId} not found`);
  }
  return entry;
}
async function listEntryRevisions(db, collectionId, entryId, opts = {}) {
  const revisions = entryRevisions;
  if (opts.includeData === false) {
    const query = db.select({
      id: revisions.id,
      entryId: revisions.entryId,
      collectionId: revisions.collectionId,
      revisionNumber: revisions.revisionNumber,
      type: revisions.type,
      status: revisions.status,
      createdAt: revisions.createdAt
    }).from(revisions).where(and(eq(revisions.collectionId, collectionId), eq(revisions.entryId, entryId))).orderBy(desc(revisions.revisionNumber), desc(revisions.createdAt));
    return opts.limit === void 0 ? query : query.limit(opts.limit);
  }
  return db.query.entryRevisions.findMany({
    // @ts-ignore
    where: (r, { and: and2, eq: eq2 }) => and2(eq2(r.collectionId, collectionId), eq2(r.entryId, entryId)),
    // @ts-ignore
    orderBy: (r, { desc: desc2 }) => [desc2(r.revisionNumber), desc2(r.createdAt)],
    ...opts.limit === void 0 ? {} : { limit: opts.limit }
  });
}
async function getEntryRevision(db, collectionId, entryId, revisionId) {
  const revision = await db.query.entryRevisions.findFirst({
    // @ts-ignore
    where: (r, { and: and2, eq: eq2 }) => and2(eq2(r.collectionId, collectionId), eq2(r.entryId, entryId), eq2(r.id, revisionId))
  });
  if (!revision) {
    throw new EntryNotFoundError(`Revision ${revisionId} not found for entry ${entryId}`);
  }
  return revision;
}
function editableSlug(entry) {
  return entry.draftSlug || entry.slug;
}
async function assertDraftSlugAvailable(db, collectionId, entryId, slug) {
  const entries2 = entries;
  const [holder] = await db.select({ id: entries2.id }).from(entries2).where(and(
    eq(entries2.collectionId, collectionId),
    ne(entries2.id, entryId),
    or(eq(entries2.slug, slug), eq(entries2.draftSlug, slug))
  )).limit(1);
  if (holder) throw new SlugConflictError();
}
async function assertPublishableSlug(db, entry) {
  const slug = editableSlug(entry);
  if (entry.status === "published" && slug === entry.slug) return;
  const entries2 = entries;
  const [holder] = await db.select({ id: entries2.id }).from(entries2).where(and(
    eq(entries2.collectionId, entry.collectionId),
    ne(entries2.id, entry.id),
    eq(entries2.status, "published"),
    eq(entries2.slug, slug)
  )).limit(1);
  if (holder) throw new SlugConflictError();
}
async function getLatestRevision(db, entryId) {
  const [row] = await db.select({ id: entryRevisions.id, revisionNumber: entryRevisions.revisionNumber }).from(entryRevisions).where(eq(entryRevisions.entryId, entryId)).orderBy(desc(entryRevisions.revisionNumber)).limit(1);
  return row ?? null;
}
function assertExpectedRevision(latest, expectedRevisionId) {
  if (expectedRevisionId !== void 0 && (latest?.id ?? null) !== expectedRevisionId) {
    throw new RevisionConflictError();
  }
}
function revisionTypeForStatus(status) {
  if (status === "published") return "publish";
  if (status === "archived") return "archive";
  return "draft_save";
}
function buildBaselineRevision(db, entry) {
  const id = createId("rev");
  const status = entry.status;
  const publishedData = entry.publishedData ?? entry.data;
  const queries = [db.insert(entryRevisions).values({
    id,
    entryId: entry.id,
    collectionId: entry.collectionId,
    revisionNumber: 1,
    type: revisionTypeForStatus(status),
    status,
    data: status === "published" ? publishedData : entry.data,
    createdAt: entry.updatedAt ?? /* @__PURE__ */ new Date()
  })];
  if (status === "published" && !entry.publishedRevisionId) {
    queries.push(db.update(entries).set({ publishedData, publishedRevisionId: id }).where(and(eq(entries.id, entry.id), isNull(entries.publishedRevisionId))));
  }
  return queries;
}
function errorMessages(error) {
  const messages = [];
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    if (typeof current.message === "string") messages.push(current.message);
  }
  return messages.join("\n");
}
async function writeRevisionBatch(db, queries) {
  try {
    await db.batch(queries);
  } catch (error) {
    const messages = errorMessages(error);
    if (/UNIQUE constraint failed.*(entry_id|revision_number)|galaxy_entry_revisions_entry_number_unique/i.test(messages)) {
      throw new RevisionConflictError();
    }
    if (/UNIQUE constraint failed: galaxy_entries\.collection_id, galaxy_entries\.slug|galaxy_entries_published_slug_unique/i.test(messages)) {
      throw new SlugConflictError();
    }
    throw error;
  }
}
async function buildRevisionInsert(db, params) {
  const latest = await getLatestRevision(db, params.entry.id);
  assertExpectedRevision(latest, params.expectedRevisionId);
  const baseline = !latest && params.existing ? buildBaselineRevision(db, params.existing) : [];
  const revisionNumber = latest ? latest.revisionNumber + 1 : baseline.length > 0 ? 2 : 1;
  const revisionId = createId("rev");
  const query = db.insert(entryRevisions).values({
    id: revisionId,
    entryId: params.entry.id,
    collectionId: params.entry.collectionId,
    revisionNumber,
    type: params.type,
    status: params.status,
    data: params.snapshotData,
    createdAt: /* @__PURE__ */ new Date()
  });
  return { id: revisionId, queries: [...baseline, query] };
}
async function createDraftEntry(db, collection, data, opts) {
  const now = /* @__PURE__ */ new Date();
  const id = opts?.id || createId("entry");
  const slug = opts?.slug?.trim() || id;
  await assertDraftSlugAvailable(db, collection.id, id, slug);
  const entryInsert = db.insert(entries).values({
    id,
    collectionId: collection.id,
    slug,
    status: "draft",
    data,
    createdAt: now,
    updatedAt: now
  });
  const revision = await buildRevisionInsert(db, {
    entry: { id, collectionId: collection.id },
    snapshotData: data,
    status: "draft",
    type: "draft_save"
  });
  await writeRevisionBatch(db, [entryInsert, ...revision.queries]);
  return getVersionedEntry(db, collection.id, id);
}
async function saveDraftEntry(db, collection, entryId, params) {
  const existing = await getVersionedEntry(db, collection.id, entryId);
  const updates = {
    updatedAt: /* @__PURE__ */ new Date()
  };
  if (params.data !== void 0) updates.data = params.data;
  const slug = params.slug?.trim();
  if (slug) {
    if (slug !== editableSlug(existing)) {
      await assertDraftSlugAvailable(db, collection.id, entryId, slug);
    }
    if (existing.status === "published") {
      updates.draftSlug = slug === existing.slug ? null : slug;
    } else {
      updates.slug = slug;
      updates.draftSlug = null;
    }
  }
  const revision = await buildRevisionInsert(db, {
    entry: existing,
    snapshotData: params.data !== void 0 ? params.data : existing.data,
    status: existing.status,
    type: "draft_save",
    expectedRevisionId: params.expectedRevisionId,
    existing
  });
  await writeRevisionBatch(db, [db.update(entries).set(updates).where(and(eq(entries.collectionId, collection.id), eq(entries.id, entryId))), ...revision.queries]);
  return getVersionedEntry(db, collection.id, entryId);
}
async function publishEntry(db, collection, entryId, expectedRevisionId) {
  const entry = await getVersionedEntry(db, collection.id, entryId);
  const revision = await buildRevisionInsert(db, {
    entry,
    snapshotData: entry.data,
    status: "published",
    type: "publish",
    expectedRevisionId,
    existing: entry
  });
  await assertPublishableSlug(db, entry);
  const now = /* @__PURE__ */ new Date();
  await writeRevisionBatch(db, [...revision.queries, db.update(entries).set({
    status: "published",
    slug: editableSlug(entry),
    draftSlug: null,
    publishedData: entry.data,
    publishedRevisionId: revision.id,
    publishedAt: now,
    archivedAt: null,
    updatedAt: now
  }).where(and(eq(entries.collectionId, collection.id), eq(entries.id, entryId)))]);
  return getVersionedEntry(db, collection.id, entryId);
}
async function archiveEntry(db, collection, entryId, expectedRevisionId) {
  const entry = await getVersionedEntry(db, collection.id, entryId);
  const archiveSnapshot = entry.publishedData ?? entry.data;
  const revision = await buildRevisionInsert(db, {
    entry,
    snapshotData: archiveSnapshot,
    status: "archived",
    type: "archive",
    expectedRevisionId,
    existing: entry
  });
  const now = /* @__PURE__ */ new Date();
  await writeRevisionBatch(db, [...revision.queries, db.update(entries).set({
    status: "archived",
    archivedAt: now,
    updatedAt: now
  }).where(and(eq(entries.collectionId, collection.id), eq(entries.id, entryId)))]);
  return getVersionedEntry(db, collection.id, entryId);
}
async function restoreEntryRevision(db, collection, entryId, revisionId, expectedRevisionId) {
  const entry = await getVersionedEntry(db, collection.id, entryId);
  const revision = await getEntryRevision(db, collection.id, entryId, revisionId);
  const now = /* @__PURE__ */ new Date();
  const restoredRevision = await buildRevisionInsert(db, {
    entry,
    snapshotData: revision.data,
    status: entry.status === "archived" ? "draft" : entry.status,
    type: "restore",
    expectedRevisionId,
    existing: entry
  });
  await writeRevisionBatch(db, [db.update(entries).set({
    data: revision.data,
    updatedAt: now,
    status: entry.status === "archived" ? "draft" : entry.status,
    archivedAt: entry.status === "archived" ? null : entry.archivedAt
  }).where(and(eq(entries.collectionId, collection.id), eq(entries.id, entryId))), ...restoredRevision.queries]);
  return getVersionedEntry(db, collection.id, entryId);
}
async function runPublishingTransition(env, payload) {
  const db = createVersioningDb(env);
  const collection = await getCollectionBySlug(db, payload.collectionSlug);
  if (payload.action === "publish") {
    return publishEntry(db, collection, payload.entryId, payload.expectedRevisionId);
  }
  if (payload.action === "archive") {
    return archiveEntry(db, collection, payload.entryId, payload.expectedRevisionId);
  }
  throw new Error(`Unsupported publish workflow action: ${payload.action}`);
}
var PublishWorkflowPendingError = class extends Error {
  instanceId;
  constructor(instanceId, timeoutMs) {
    super(`Workflow ${instanceId} did not complete within ${timeoutMs}ms`);
    this.name = "PublishWorkflowPendingError";
    this.instanceId = instanceId;
  }
};
function workflowFailure(message) {
  if (isRevisionConflict(new Error(message))) return new RevisionConflictError();
  if (isSlugConflict(new Error(message))) return new SlugConflictError();
  if (isEntryNotFound(new Error(message))) return new EntryNotFoundError(message);
  return new Error(message);
}
async function waitForWorkflowCompletion(instance, timeoutMs = 1e4) {
  const startedAt = Date.now();
  for (let delay = 100; ; delay = Math.min(delay * 2, 1e3)) {
    const status = await instance.status();
    if (status.status === "complete") {
      const output = status.output;
      if (output?.ok === false) {
        throw workflowFailure(output.error?.message || `Workflow ${instance.id} could not apply the transition`);
      }
      return status;
    }
    if (status.status === "errored" || status.status === "terminated") {
      throw workflowFailure(status.error?.message || `Workflow ${instance.id} ended with status ${status.status}`);
    }
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
  }
  throw new PublishWorkflowPendingError(instance.id, timeoutMs);
}
function workflowInstanceId(payload) {
  const target = `${payload.collectionSlug}-${payload.entryId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60);
  return `talisman-${payload.action}-${target}-${Date.now()}`;
}
async function triggerPublishingWorkflow(env, payload, bindingName = DEFAULT_PUBLISHING_WORKFLOW_BINDING) {
  const workflow = bindingName === DEFAULT_PUBLISHING_WORKFLOW_BINDING ? readBinding(env, "PUBLISH_WORKFLOW") : env?.[bindingName];
  if (!workflow) {
    return runPublishingTransition(env, payload);
  }
  const db = createVersioningDb(env);
  const collection = await getCollectionBySlug(db, payload.collectionSlug);
  const entry = await getVersionedEntry(db, collection.id, payload.entryId);
  if (payload.action === "publish") await assertPublishableSlug(db, entry);
  const instance = await workflow.create({
    id: workflowInstanceId(payload),
    params: payload
  });
  try {
    await waitForWorkflowCompletion(instance);
  } catch (error) {
    if (!(error instanceof PublishWorkflowPendingError)) throw error;
    return { ...await getVersionedEntry(db, collection.id, payload.entryId), workflow: { status: "pending", instanceId: instance.id } };
  }
  return getVersionedEntry(db, collection.id, payload.entryId);
}
async function invalidateEntryCache(env, collectionSlug, entryIds) {
  const kv = env.KV;
  if (!kv) return;
  const prefix = `talisman:entries:${collectionSlug}`;
  await Promise.all([`${prefix}:all`, `${prefix}:all:draft`, `${prefix}:all:published`].map((key) => kv.delete(key)));
  const ids = (typeof entryIds === "string" ? [entryIds] : entryIds ?? []).filter(Boolean);
  await Promise.all(ids.flatMap((id) => [`${prefix}:${id}`, `${prefix}:${id}:draft`, `${prefix}:${id}:published`]).map((key) => kv.delete(key)));
}

export {
  DEFAULT_PUBLISHING_WORKFLOW_BINDING,
  RevisionConflictError,
  isRevisionConflict,
  SlugConflictError,
  isSlugConflict,
  EntryNotFoundError,
  isEntryNotFound,
  isPermanentPublishError,
  normalizeEntryDataForRead,
  toEditableEntry,
  getCollectionBySlug,
  getVersionedEntry,
  listEntryRevisions,
  getEntryRevision,
  assertPublishableSlug,
  getLatestRevision,
  createDraftEntry,
  saveDraftEntry,
  publishEntry,
  archiveEntry,
  restoreEntryRevision,
  runPublishingTransition,
  PublishWorkflowPendingError,
  waitForWorkflowCompletion,
  triggerPublishingWorkflow,
  invalidateEntryCache
};
