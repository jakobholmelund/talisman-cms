import * as drizzle_orm_d1 from 'drizzle-orm/d1';
import { s as schema, c as collections } from './media-Cfo_aHOS.js';
import { TalismanEnv } from './client.js';
import 'drizzle-orm/sqlite-core';

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
type CollectionRecord = typeof collections.$inferSelect;
declare function normalizeEntryDataForRead(entry: any, version?: 'draft' | 'published'): any;
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
    status: "draft" | "published" | "archived";
    publishedData: unknown;
    publishedRevisionId: string | null;
    updatedAt: Date;
    publishedAt: Date | null;
    archivedAt: Date | null;
}>;
declare function listEntryRevisions(db: ReturnType<typeof createVersioningDb>, collectionId: string, entryId: string): Promise<{
    id: string;
    data: unknown;
    createdAt: Date;
    collectionId: string;
    status: "draft" | "published" | "archived";
    entryId: string;
    revisionNumber: number;
    type: "draft_save" | "publish" | "archive" | "restore";
}[]>;
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
    status: "draft" | "published" | "archived";
    publishedData: unknown;
    publishedRevisionId: string | null;
    updatedAt: Date;
    publishedAt: Date | null;
    archivedAt: Date | null;
}>;
declare function waitForWorkflowCompletion(instance: WorkflowInstance, timeoutMs?: number): Promise<InstanceStatus>;
declare function triggerPublishingWorkflow(env: TalismanEnv, payload: PublishWorkflowPayload, bindingName?: string): Promise<{
    id: string;
    slug: string;
    data: unknown;
    createdAt: Date;
    collectionId: string;
    status: "draft" | "published" | "archived";
    publishedData: unknown;
    publishedRevisionId: string | null;
    updatedAt: Date;
    publishedAt: Date | null;
    archivedAt: Date | null;
}>;
declare function invalidateEntryCache(env: TalismanEnv, collectionSlug: string, entryId?: string): Promise<void>;

export { DEFAULT_PUBLISHING_WORKFLOW_BINDING, type EntryStatus, type PublishWorkflowAction, type PublishWorkflowPayload, RevisionConflictError, type RevisionType, archiveEntry, createDraftEntry, getCollectionBySlug, getLatestRevision, getVersionedEntry, invalidateEntryCache, isRevisionConflict, listEntryRevisions, normalizeEntryDataForRead, publishEntry, restoreEntryRevision, runPublishingTransition, saveDraftEntry, triggerPublishingWorkflow, waitForWorkflowCompletion };
