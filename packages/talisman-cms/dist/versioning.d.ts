import * as drizzle_orm_d1 from 'drizzle-orm/d1';
import { s as schema, c as collections, e as entries } from './media-Cm407HSH.js';
import { T as TalismanEnv } from './client-DyE8UiZp.js';
export { i as invalidateEntryCache } from './client-DyE8UiZp.js';
import 'drizzle-orm/sqlite-core';
import './actor-Daa_hmny.js';
import './types-C5a-hx5D.js';
import 'astro';

declare const DEFAULT_PUBLISHING_WORKFLOW_BINDING = "TALISMAN_PUBLISH_WORKFLOW";
type EntryStatus = 'draft' | 'published' | 'archived';
type RevisionType = 'draft_save' | 'publish' | 'archive' | 'restore';
type PublishWorkflowAction = 'publish' | 'archive';
interface PublishWorkflowPayload {
    collectionSlug: string;
    entryId: string;
    action: PublishWorkflowAction;
    /** The latest revision the editor loaded, or null for an entry loaded without revisions. */
    expectedRevisionId?: string | null;
}
declare class RevisionConflictError extends Error {
    constructor();
}
declare function isRevisionConflict(error: unknown): boolean;
declare class SlugConflictError extends Error {
    constructor();
}
/** Also matches the message of a publish that failed inside a Workflow instance. */
declare function isSlugConflict(error: unknown): boolean;
declare class EntryNotFoundError extends Error {
    constructor(message: string);
}
declare function isEntryNotFound(error: unknown): boolean;
/**
 * A publish or archive that fails this way fails again on retry: a stale revision, a slug another
 * entry serves, or an entry, collection or action that does not exist.
 */
declare function isPermanentPublishError(error: unknown): boolean;
type CollectionRecord = typeof collections.$inferSelect;
type EntryRecord = typeof entries.$inferSelect;
declare function normalizeEntryDataForRead(entry: any, version?: 'draft' | 'published'): any;
/**
 * The admin's view of an entry: `slug` is the slug being edited, which a published entry only
 * takes live on its next publish, and `publishedSlug` is the slug the site serves it under.
 */
declare function toEditableEntry<T extends {
    slug: string;
    status: string;
    draftSlug?: string | null;
}>(entry: T): T & {
    slug: string;
    publishedSlug: string | null;
};
declare function createVersioningDb(env: TalismanEnv): drizzle_orm_d1.DrizzleD1Database<typeof schema> & {
    $client: D1Database;
};
declare function getCollectionBySlug(db: ReturnType<typeof createVersioningDb>, collectionSlug: string): Promise<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    fields: unknown;
    createdAt: Date;
}>;
declare function getVersionedEntry(db: ReturnType<typeof createVersioningDb>, collectionId: string, entryId: string): Promise<{
    id: string;
    slug: string;
    data: unknown;
    createdAt: Date;
    collectionId: string;
    draftSlug: string | null;
    status: "draft" | "published" | "archived";
    publishedData: unknown;
    publishedRevisionId: string | null;
    updatedAt: Date;
    publishedAt: Date | null;
    archivedAt: Date | null;
}>;
/**
 * Newest first. `includeData: false` returns the metadata the history panel shows without each
 * revision's full snapshot, which grows with every save; getEntryRevision loads one on demand.
 */
declare function listEntryRevisions(db: ReturnType<typeof createVersioningDb>, collectionId: string, entryId: string, opts?: {
    includeData?: boolean;
    limit?: number;
}): Promise<{
    id: string;
    entryId: string;
    collectionId: string;
    revisionNumber: number;
    type: "draft_save" | "publish" | "archive" | "restore";
    status: "draft" | "published" | "archived";
    createdAt: Date;
}[]>;
declare function getEntryRevision(db: ReturnType<typeof createVersioningDb>, collectionId: string, entryId: string, revisionId: string): Promise<{
    id: string;
    data: unknown;
    createdAt: Date;
    collectionId: string;
    status: "draft" | "published" | "archived";
    entryId: string;
    revisionNumber: number;
    type: "draft_save" | "publish" | "archive" | "restore";
}>;
/**
 * Publishing takes the entry's draft slug live, unless another published entry already serves it
 * (slugs written straight to D1 are not checked on save). An unchanged live slug is not re-checked.
 */
declare function assertPublishableSlug(db: ReturnType<typeof createVersioningDb>, entry: Pick<EntryRecord, 'id' | 'collectionId' | 'slug' | 'draftSlug' | 'status'>): Promise<void>;
declare function getLatestRevision(db: ReturnType<typeof createVersioningDb>, entryId: string): Promise<{
    id: string;
    revisionNumber: number;
}>;
declare function createDraftEntry(db: ReturnType<typeof createVersioningDb>, collection: CollectionRecord, data: any, opts?: {
    id?: string;
    slug?: string;
}): Promise<{
    id: string;
    slug: string;
    data: unknown;
    createdAt: Date;
    collectionId: string;
    draftSlug: string | null;
    status: "draft" | "published" | "archived";
    publishedData: unknown;
    publishedRevisionId: string | null;
    updatedAt: Date;
    publishedAt: Date | null;
    archivedAt: Date | null;
}>;
declare function saveDraftEntry(db: ReturnType<typeof createVersioningDb>, collection: CollectionRecord, entryId: string, params: {
    data?: any;
    slug?: string;
    expectedRevisionId?: string | null;
}): Promise<{
    id: string;
    slug: string;
    data: unknown;
    createdAt: Date;
    collectionId: string;
    draftSlug: string | null;
    status: "draft" | "published" | "archived";
    publishedData: unknown;
    publishedRevisionId: string | null;
    updatedAt: Date;
    publishedAt: Date | null;
    archivedAt: Date | null;
}>;
declare function publishEntry(db: ReturnType<typeof createVersioningDb>, collection: CollectionRecord, entryId: string, expectedRevisionId?: string | null): Promise<{
    id: string;
    slug: string;
    data: unknown;
    createdAt: Date;
    collectionId: string;
    draftSlug: string | null;
    status: "draft" | "published" | "archived";
    publishedData: unknown;
    publishedRevisionId: string | null;
    updatedAt: Date;
    publishedAt: Date | null;
    archivedAt: Date | null;
}>;
declare function archiveEntry(db: ReturnType<typeof createVersioningDb>, collection: CollectionRecord, entryId: string, expectedRevisionId?: string | null): Promise<{
    id: string;
    slug: string;
    data: unknown;
    createdAt: Date;
    collectionId: string;
    draftSlug: string | null;
    status: "draft" | "published" | "archived";
    publishedData: unknown;
    publishedRevisionId: string | null;
    updatedAt: Date;
    publishedAt: Date | null;
    archivedAt: Date | null;
}>;
declare function restoreEntryRevision(db: ReturnType<typeof createVersioningDb>, collection: CollectionRecord, entryId: string, revisionId: string, expectedRevisionId?: string | null): Promise<{
    id: string;
    slug: string;
    data: unknown;
    createdAt: Date;
    collectionId: string;
    draftSlug: string | null;
    status: "draft" | "published" | "archived";
    publishedData: unknown;
    publishedRevisionId: string | null;
    updatedAt: Date;
    publishedAt: Date | null;
    archivedAt: Date | null;
}>;
declare function runPublishingTransition(env: TalismanEnv, payload: PublishWorkflowPayload): Promise<{
    id: string;
    slug: string;
    data: unknown;
    createdAt: Date;
    collectionId: string;
    draftSlug: string | null;
    status: "draft" | "published" | "archived";
    publishedData: unknown;
    publishedRevisionId: string | null;
    updatedAt: Date;
    publishedAt: Date | null;
    archivedAt: Date | null;
}>;
/**
 * What TalismanPublishWorkflow returns. A transition that cannot succeed (see isPermanentPublishError)
 * ends the instance as complete with `ok: false` and the error, which the waiting request rethrows.
 */
type PublishWorkflowResult = {
    ok: true;
    entryId: string;
    status: string;
} | {
    ok: false;
    error: {
        name: string;
        message: string;
    };
};
/** A publish or archive Workflow instance that was still running when the request stopped waiting. */
interface PendingPublishWorkflow {
    status: 'pending';
    instanceId: string;
}
declare class PublishWorkflowPendingError extends Error {
    instanceId: string;
    constructor(instanceId: string, timeoutMs: number);
}
/**
 * Polls the instance until it completes, resolving to its status, or fails, throwing its error (also
 * when it completes with a failed transition). An instance still running after `timeoutMs` throws
 * PublishWorkflowPendingError and keeps running on its own.
 */
declare function waitForWorkflowCompletion(instance: WorkflowInstance, timeoutMs?: number): Promise<InstanceStatus>;
/**
 * Runs a publish or archive, through the Workflow binding when there is one. The result is the entry
 * after the transition. When the Workflow instance is still running after the wait, it is the entry as
 * stored before the transition, with `workflow: { status: 'pending', instanceId }`; the instance
 * finishes on its own and clears the cache. Failures throw the same errors in both modes.
 */
declare function triggerPublishingWorkflow(env: TalismanEnv, payload: PublishWorkflowPayload, bindingName?: string): Promise<EntryRecord & {
    workflow?: PendingPublishWorkflow;
}>;

export { DEFAULT_PUBLISHING_WORKFLOW_BINDING, EntryNotFoundError, type EntryStatus, type PendingPublishWorkflow, type PublishWorkflowAction, type PublishWorkflowPayload, PublishWorkflowPendingError, type PublishWorkflowResult, RevisionConflictError, type RevisionType, SlugConflictError, archiveEntry, assertPublishableSlug, createDraftEntry, getCollectionBySlug, getEntryRevision, getLatestRevision, getVersionedEntry, isEntryNotFound, isPermanentPublishError, isRevisionConflict, isSlugConflict, listEntryRevisions, normalizeEntryDataForRead, publishEntry, restoreEntryRevision, runPublishingTransition, saveDraftEntry, toEditableEntry, triggerPublishingWorkflow, waitForWorkflowCompletion };
