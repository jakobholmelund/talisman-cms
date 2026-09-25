import {
  entries,
  entryRevisions,
  schema_exports
} from "./chunk-QDILJIDR.js";
import {
  readBinding
} from "./chunk-XG3TKNL6.js";

// src/versioning.ts
import { and, desc, eq, isNull } from "drizzle-orm";
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
function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
function normalizeEntryDataForRead(entry, version = "published") {
  if (version === "published" && entry?.status === "published" && entry?.publishedData !== void 0 && entry?.publishedData !== null) {
    return { ...entry, data: entry.publishedData };
  }
  return entry;
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
    throw new Error(`Entry ${entryId} not found`);
  }
  return entry;
}
async function listEntryRevisions(db, collectionId, entryId) {
  return db.query.entryRevisions.findMany({
    // @ts-ignore
    where: (r, { and: and2, eq: eq2 }) => and2(eq2(r.collectionId, collectionId), eq2(r.entryId, entryId)),
    // @ts-ignore
    orderBy: (r, { desc: desc2 }) => [desc2(r.revisionNumber), desc2(r.createdAt)]
  });
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
async function writeRevisionBatch(db, queries) {
  try {
    await db.batch(queries);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed.*(entry_id|revision_number)|galaxy_entry_revisions_entry_number_unique/i.test(error.message)) {
      throw new RevisionConflictError();
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
  const slug = opts?.slug || id;
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
  if (params.slug !== void 0) updates.slug = params.slug;
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
  const now = /* @__PURE__ */ new Date();
  await writeRevisionBatch(db, [...revision.queries, db.update(entries).set({
    status: "published",
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
  const revision = await db.query.entryRevisions.findFirst({
    // @ts-ignore
    where: (r, { and: and2, eq: eq2 }) => and2(eq2(r.collectionId, collection.id), eq2(r.entryId, entryId), eq2(r.id, revisionId))
  });
  if (!revision) {
    throw new Error(`Revision ${revisionId} not found for entry ${entryId}`);
  }
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
async function waitForWorkflowCompletion(instance, timeoutMs = 5e3) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await instance.status();
    if (status.status === "complete") {
      return status;
    }
    if (status.status === "errored" || status.status === "terminated") {
      throw new Error(status.error?.message || `Workflow ${instance.id} ended with status ${status.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Workflow ${instance.id} did not complete within ${timeoutMs}ms`);
}
async function triggerPublishingWorkflow(env, payload, bindingName = DEFAULT_PUBLISHING_WORKFLOW_BINDING) {
  const workflow = bindingName === DEFAULT_PUBLISHING_WORKFLOW_BINDING ? readBinding(env, "PUBLISH_WORKFLOW") : env?.[bindingName];
  if (!workflow) {
    return runPublishingTransition(env, payload);
  }
  const instance = await workflow.create({
    id: `talisman-${payload.action}-${payload.collectionSlug}-${payload.entryId}-${Date.now()}`,
    params: payload
  });
  await waitForWorkflowCompletion(instance);
  const db = createVersioningDb(env);
  const collection = await getCollectionBySlug(db, payload.collectionSlug);
  return getVersionedEntry(db, collection.id, payload.entryId);
}
async function invalidateEntryCache(env, collectionSlug, entryId) {
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

export {
  DEFAULT_PUBLISHING_WORKFLOW_BINDING,
  RevisionConflictError,
  isRevisionConflict,
  normalizeEntryDataForRead,
  getCollectionBySlug,
  getVersionedEntry,
  listEntryRevisions,
  getLatestRevision,
  createDraftEntry,
  saveDraftEntry,
  publishEntry,
  archiveEntry,
  restoreEntryRevision,
  runPublishingTransition,
  waitForWorkflowCompletion,
  triggerPublishingWorkflow,
  invalidateEntryCache
};
