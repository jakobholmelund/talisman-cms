import { C as CacheContext, T as TalismanEnv, E as EntryQuery, a as EntriesPage, b as CreateEntryInput, U as UpdateEntryInput, S as SiteReadOptions, W as WriteExpectation } from './client-DyE8UiZp.js';
export { c as ClientOptions, d as EntryStatusTarget, O as Operators, e as UpdateOptions, V as VersionMode, f as WhereClause, g as createDbClient, h as getClient, j as invalidateCollectionCache, i as invalidateEntryCache, k as invalidateGlobalCache } from './client-DyE8UiZp.js';
export { EntryNotFoundError, PendingPublishWorkflow, RevisionConflictError, SlugConflictError } from './versioning.js';
import { C as CollectionConfig, G as GlobalConfig, m as UiLibraryDefinition, e as CollectionHooks, p as FieldValidationIssue, d as CollectionHookArgs, F as FieldDefinition } from './types-FBC1PekQ.js';
import { c as collections } from './media-Cm407HSH.js';
import { A as Actor } from './actor-Daa_hmny.js';
export { s as systemActor, u as userActor } from './actor-Daa_hmny.js';
import 'drizzle-orm/d1';
import 'drizzle-orm/sqlite-core';
import './types-C5a-hx5D.js';
import 'astro';
import './types-CqOBvOgc.js';

/** The site's configuration as the service reads it, the same in the Worker and in Node. */
interface ServiceConfig {
    collections: CollectionConfig[];
    globals: GlobalConfig[];
    /** The UI libraries plugins register, which component preset validation checks against. */
    uiLibraries: UiLibraryDefinition[];
    /** The Drizzle tables of the native collections, by collection slug. */
    nativeSchemas: Record<string, any>;
    /** Hooks compiled from each collection's `runtimeHooks`, by collection slug. */
    collectionHooks: Record<string, CollectionHooks>;
    /** The Workflow binding publishing runs through (`publishing.workflowBinding`). */
    publishingWorkflowBinding: string;
}
/**
 * The configuration for code bundled apart from the route modules: `getClient` in `dist/client.js`
 * reaches the virtual modules through dynamic imports, which Vite resolves inside the Worker bundle
 * and which fail in Node, where the service then runs with no configured collections, globals,
 * hooks or native tables. Loaded once per module instance.
 */
declare function loadServiceConfig(): Promise<ServiceConfig>;

type ServiceErrorCode = 'invalid_input' | 'forbidden' | 'not_found' | 'payload_too_large' | 'precondition_required' | 'conflict' | 'unsupported' | 'hook_failed';
/**
 * A failure the caller can act on, with the status the admin API answers. The SDK throws the same
 * classes, so server code matches them by class or `code`. Anything else the service throws is an
 * internal failure, which the admin API logs and answers with a generic 500.
 */
declare class ServiceError extends Error {
    readonly code: ServiceErrorCode;
    readonly status: number;
    constructor(code: ServiceErrorCode, status: number, message: string, options?: ErrorOptions);
}
/** Input that failed validation; `issues` name the fields, as the admin API's `fieldErrors` do. */
declare class ValidationError extends ServiceError {
    readonly issues: FieldValidationIssue[];
    /** Extra members of the admin API's error body, such as zod's `flatten()` output for globals. */
    readonly details?: Record<string, unknown>;
    constructor(issues: FieldValidationIssue[], details?: Record<string, unknown>, message?: string);
}
/** Input the operation cannot use at all (not an object, invalid JSON), with no field to point at. */
declare class InvalidInputError extends ServiceError {
    constructor(message: string);
}
declare class AccessDeniedError extends ServiceError {
    constructor(message?: string);
}
declare class NotFoundError extends ServiceError {
    constructor(message: string);
}
declare class PayloadTooLargeError extends ServiceError {
    constructor(message?: string);
}
/** The record the write would create already exists. */
declare class ConflictError extends ServiceError {
    constructor(message: string);
}
/** A write on a record that has revisions arrived without the revision the caller loaded. */
declare class PreconditionRequiredError extends ServiceError {
    constructor(message?: string);
}
/** A native row changed since the caller loaded it (its `updatedAt` no longer matches). */
declare class NativeRecordConflictError extends ServiceError {
    constructor();
}
/** An operation the collection does not support, such as publishing a native record. */
declare class UnsupportedOperationError extends ServiceError {
    constructor(message: string);
}
/** A database constraint refused the write; the message names the columns, never the statement. */
declare class ConstraintError extends ServiceError {
    constructor(status: 400 | 409 | 413, message: string, options?: ErrorOptions);
}
type HookPhase = 'beforeValidate' | 'beforeChange' | 'afterChange' | 'beforeDelete' | 'afterDelete';
/**
 * Wraps an error thrown by a collection hook, whose message is written for editors. `committed`
 * says whether the write had already been stored when the hook failed (the after* phases).
 */
declare class HookError extends ServiceError {
    readonly phase: HookPhase;
    readonly committed: boolean;
    constructor(cause: unknown, phase: HookPhase);
}
declare function isServiceError(error: unknown): error is ServiceError;

/** One line per hook call, for tests that prove both callers run the same hooks in the same order. */
interface HookLogEntry {
    hook: HookPhase;
    operation: CollectionHookArgs['operation'];
    collection: string;
    actorKind: CollectionHookArgs['actor']['kind'];
    dataKeys: string[];
}

type CollectionRecord = typeof collections.$inferSelect;
/** A collection as an operation works with it: its configuration, its stored row and its native table. */
interface ResolvedCollection {
    slug: string;
    config: CollectionConfig;
    /** The galaxy_collections row entries reference. */
    record: CollectionRecord;
    /** The fields in force: the configured ones, or those generated from a native table. */
    activeFields: FieldDefinition[];
    nativeTable: Record<string, any> | null;
    nativeIdCol: string;
    hooks?: CollectionHooks;
    /** Whether the collection is configured; a stored collection without configuration is readable by server code. */
    configured: boolean;
}

interface CreateGlobalInput {
    slug?: unknown;
    name?: unknown;
    description?: unknown;
    data?: unknown;
}

interface ServiceOptions {
    /** The site configuration; the admin API passes its static modules, getClient loads it. */
    config: ServiceConfig;
    /** Who is calling; trusted server code when left out. */
    actor?: Actor;
    /** The execution context whose waitUntil defers cache fills past the response. */
    ctx?: CacheContext;
    /** Receives one entry per hook call, for tests. */
    log?: HookLogEntry[];
}
type TalismanService = ReturnType<typeof createService>;
/**
 * The content service both the admin API and getClient are built on: hooks, validation, access
 * rules and cache invalidation run here, once, for every caller.
 */
declare function createService(env: TalismanEnv, options: ServiceOptions): {
    actor: Actor;
    collections: {
        list(options?: {
            cache?: boolean;
        }): Promise<{
            id: string;
            name: string;
            slug: string;
            description: string | null;
            fields: unknown;
            createdAt: Date;
        }[]>;
    };
    entries: {
        resolve: (slug: string) => Promise<ResolvedCollection>;
        list(slug: string, query?: EntryQuery): Promise<{
            id: any;
            collectionId: string;
            slug: any;
            status: any;
            data: any;
            createdAt: any;
            updatedAt: any;
        }[]>;
        page(slug: string, options: {
            limit: number;
            cursor?: string | null;
        } & EntryQuery): Promise<EntriesPage>;
        get(slug: string, id: string): Promise<any>;
        create(slug: string, input?: CreateEntryInput): Promise<any>;
        update(slug: string, id: string, input?: UpdateEntryInput): Promise<any>;
        remove(slug: string, id: string, options?: {
            origin?: string;
        }): Promise<void>;
        findMany(slug: string, options?: SiteReadOptions & EntryQuery & {
            limit?: number;
        }): Promise<any[]>;
        find(slug: string, id: string, options?: SiteReadOptions): Promise<any>;
        findBySlug(slug: string, entrySlug: string, options?: Omit<SiteReadOptions, "cache">): Promise<any>;
        publish(slug: string, id: string, options?: {
            expect?: WriteExpectation;
        }): Promise<any>;
        archive(slug: string, id: string, options?: {
            expect?: WriteExpectation;
        }): Promise<any>;
    };
    globals: {
        list(options?: {
            cache?: boolean;
        }): Promise<any[]>;
        get(slug: string, options?: {
            cache?: boolean;
        }): Promise<any>;
        create(input: CreateGlobalInput): Promise<{
            id: string;
            name: string;
            slug: string;
            description: string | null;
            data: Record<string, any>;
            createdAt: Date;
            updatedAt: Date;
        }>;
        save(slug: string, data: unknown): Promise<{
            id: string;
            name: string;
            slug: string;
            description: string | null;
            data: unknown;
            createdAt: Date;
            updatedAt: Date;
        } | undefined>;
    };
    revisions: {
        list(slug: string, entryId: string, options?: {
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
        get(slug: string, entryId: string, revisionId: string): Promise<{
            id: string;
            data: unknown;
            createdAt: Date;
            collectionId: string;
            status: "draft" | "published" | "archived";
            entryId: string;
            revisionNumber: number;
            type: "draft_save" | "publish" | "archive" | "restore";
        }>;
        restore(slug: string, entryId: string, revisionId: string, options?: {
            expectedRevisionId?: unknown;
        }): Promise<{
            latestRevisionId: string;
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
            publishedSlug: string | null;
        }>;
    };
};

export { AccessDeniedError, Actor, ConflictError, ConstraintError, CreateEntryInput, type CreateGlobalInput, EntriesPage, EntryQuery, HookError, type HookLogEntry, type HookPhase, InvalidInputError, NativeRecordConflictError, NotFoundError, PayloadTooLargeError, PreconditionRequiredError, type ResolvedCollection, type ServiceConfig, ServiceError, type ServiceErrorCode, type ServiceOptions, SiteReadOptions, TalismanEnv, type TalismanService, UnsupportedOperationError, UpdateEntryInput, ValidationError, WriteExpectation, createService, isServiceError, loadServiceConfig };
