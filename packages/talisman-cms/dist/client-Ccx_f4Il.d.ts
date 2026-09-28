import * as drizzle_orm_d1 from 'drizzle-orm/d1';
import * as drizzle_orm from 'drizzle-orm';
import { A as Actor } from './actor-Daa_hmny.js';

type CacheContext = Pick<ExecutionContext, 'waitUntil'>;
type CacheEnv = Pick<TalismanEnv, 'KV'>;
/**
 * Drops the KV copies of a collection's cached lists and of the given entries' cached reads. Code
 * that writes rows without the service (a D1 batch, for example) calls it once the write has
 * committed, as the admin API and getClient do after theirs.
 */
declare function invalidateEntryCache(env: CacheEnv, collectionSlug: string, entryIds?: string | readonly string[]): Promise<void>;
/** Drops the cached list of globals and, given a slug, that global's cached read. */
declare function invalidateGlobalCache(env: CacheEnv, slug?: string): Promise<void>;
/** Drops the cached list of collections, for code that writes galaxy_collections itself. */
declare function invalidateCollectionCache(env: CacheEnv): Promise<void>;

type Scalar = string | number | boolean | null;
/** The comparisons a `where` clause may make; which apply depends on the field's type. */
interface Operators {
    eq?: Scalar;
    ne?: Scalar;
    in?: Scalar[];
    lt?: Scalar;
    lte?: Scalar;
    gt?: Scalar;
    gte?: Scalar;
    /** Whether a relationship or array field holds the value. */
    contains?: Scalar;
    isNull?: boolean;
}
/** `{ field: value }` means equality; `{ field: { op: value } }` names the comparison. */
type WhereClause = Record<string, Scalar | Operators>;
interface EntryQuery {
    where?: WhereClause;
    /** Field names, `-` for descending; at most two. */
    sort?: string | string[];
    /** Rows to skip, with `limit`; at most 10000. */
    offset?: number;
}

type VersionMode = 'draft' | 'published';

/** Which native columns a caller may write: the configured fields, or any column (server code). */
type WritableColumns = 'configured' | 'any';

type EntryStatusTarget = 'published' | 'archived';
/** The token a write is checked against: the revision an editor loaded, or a native row's updatedAt. */
interface WriteExpectation {
    /** The latest revision the caller loaded (a string); null for an entry loaded without revisions. */
    revisionId?: unknown;
    /** The updatedAt a native row was loaded with (a Date or its JSON text). */
    updatedAt?: unknown;
}
interface CreateEntryInput {
    data?: unknown;
    id?: unknown;
    slug?: unknown;
    /** Publish or archive the new entry straight away (server code). */
    status?: EntryStatusTarget;
    columns?: WritableColumns;
}
interface UpdateEntryInput {
    data?: unknown;
    slug?: unknown;
    expect?: WriteExpectation;
    status?: EntryStatusTarget;
    columns?: WritableColumns;
}
interface EntriesPage {
    docs: any[];
    nextCursor: string | null;
}
/** Options of the site-facing reads, as getClient has always taken them. */
interface SiteReadOptions {
    /** Published snapshots (the default) or the drafts being edited. */
    version?: VersionMode;
    /** How many levels of relations to embed; 0 reads from KV when it can. */
    depth?: number;
    /** Entries and globals are cached unless false; native tables only when true. */
    cache?: boolean;
}

interface CreateGlobalInput {
    slug?: unknown;
    name?: unknown;
    description?: unknown;
    data?: unknown;
}
interface SaveGlobalOptions {
    /**
     * The `version` the caller loaded. A number that no longer matches the stored row refuses the
     * save with a `stale_record` conflict that carries the current version. Null or undefined saves
     * unconditionally, as trusted server code and clients written before versions may.
     */
    expectedVersion?: number | null;
}

type TalismanEnv = {
    DB: D1Database;
    STORAGE?: R2Bucket;
    IMAGES?: ImagesBinding;
    KV?: KVNamespace;
    [key: string]: unknown;
};
declare function createDbClient(env: TalismanEnv): drizzle_orm_d1.DrizzleD1Database<drizzle_orm.EmptyRelations> & {
    $client: D1Database;
};
interface ClientOptions {
    /**
     * Who is calling; trusted server code when left out. A plugin route that holds a CMS session
     * passes `userActor(user, request)` and gets the admin API's rules.
     */
    actor?: Actor;
}
interface UpdateOptions {
    slug?: string;
    status?: string;
    /** The latest revision the caller loaded; a user actor must send it when the entry has revisions. */
    expectedRevisionId?: string | null;
    /** The updatedAt a native row was loaded with, to refuse a save over a newer one. */
    expectedUpdatedAt?: unknown;
}
/**
 * The SDK for server code. Every call goes through the same service as the admin API, so hooks,
 * validation, the collection rules that apply to the actor and cache invalidation are the same.
 * Pass the request's execution context (Workers `ctx`, Astro `locals.cfContext`) so KV cache
 * fills run after the response; inside Workers it is otherwise taken from `cloudflare:workers`.
 */
declare function getClient(env: TalismanEnv, ctx?: CacheContext, options?: ClientOptions): {
    collections: {
        findMany: (opts?: {
            cache?: boolean;
        }) => Promise<{
            id: string;
            name: string;
            slug: string;
            description: string | null;
            fields: unknown;
            createdAt: Date;
        }[]>;
    };
    globals: {
        findMany: (opts?: {
            cache?: boolean;
        }) => Promise<any[]>;
        find: (slug: string, opts?: {
            cache?: boolean;
        }) => Promise<any>;
        create: (input: {
            slug: string;
            name?: string;
            description?: string | null;
            data?: any;
        }) => Promise<{
            id: string;
            name: string;
            slug: string;
            description: string | null;
            data: Record<string, any>;
            createdAt: Date;
            updatedAt: Date;
            version: number;
        }>;
        /**
         * Saves a global's data. `expectedVersion`, the `version` a read returned, makes the save fail
         * with a `stale_record` ConflictError when another save came first; without it the save wins.
         */
        save: (slug: string, data: Record<string, any>, opts?: SaveGlobalOptions) => Promise<{
            data: unknown;
            name: string;
            slug: string;
            description: string | null;
            id: string;
            createdAt: Date;
            updatedAt: Date;
            version: number;
        }>;
        /** The same as `save`, under the name earlier releases used. */
        update: (slug: string, data: Record<string, any>, opts?: SaveGlobalOptions) => Promise<{
            data: unknown;
            name: string;
            slug: string;
            description: string | null;
            id: string;
            createdAt: Date;
            updatedAt: Date;
            version: number;
        }>;
    };
    entries: {
        findMany: (collectionSlug: string, opts?: SiteReadOptions & EntryQuery & {
            limit?: number;
        }) => Promise<any[]>;
        findBySlug: (collectionSlug: string, slug: string, opts?: {
            depth?: number;
            version?: VersionMode;
        }) => Promise<any>;
        find: (collectionSlug: string, id: string | number, opts?: SiteReadOptions) => Promise<any>;
        create: (collectionSlug: string, data: any, opts?: {
            slug?: string;
            status?: string;
        }) => Promise<any>;
        update: (collectionSlug: string, id: string | number, data?: any, opts?: UpdateOptions) => Promise<any>;
        delete: (collectionSlug: string, id: string | number) => Promise<boolean>;
    };
};

export { type CacheContext as C, type EntryQuery as E, type Operators as O, type SiteReadOptions as S, type TalismanEnv as T, type UpdateEntryInput as U, type VersionMode as V, type WriteExpectation as W, type EntriesPage as a, type CreateEntryInput as b, type CreateGlobalInput as c, type SaveGlobalOptions as d, type ClientOptions as e, type EntryStatusTarget as f, type UpdateOptions as g, type WhereClause as h, invalidateEntryCache as i, createDbClient as j, getClient as k, invalidateCollectionCache as l, invalidateGlobalCache as m };
