import * as drizzle_orm_d1 from 'drizzle-orm/d1';
import { s as schema } from './media-Cm407HSH.js';
import 'drizzle-orm/sqlite-core';

type TalismanEnv = {
    DB: D1Database;
    STORAGE?: R2Bucket;
    IMAGES?: ImagesBinding;
    KV?: KVNamespace;
    [key: string]: unknown;
};
declare function createDbClient(env: TalismanEnv): drizzle_orm_d1.DrizzleD1Database<typeof schema> & {
    $client: D1Database;
};
type CacheContext = Pick<ExecutionContext, 'waitUntil'>;
/**
 * Pass the request's execution context (Workers `ctx`, Astro `locals.cfContext`) so KV cache
 * fills run after the response; inside Workers it is otherwise taken from `cloudflare:workers`.
 */
declare function getClient(env: TalismanEnv, ctx?: CacheContext): {
    collections: {
        findMany(opts?: {
            cache?: boolean;
        }): Promise<any[]>;
    };
    globals: {
        findMany(opts?: {
            cache?: boolean;
        }): Promise<any[]>;
        find(slug: string, opts?: {
            cache?: boolean;
        }): Promise<any>;
        create(input: {
            slug: string;
            name?: string;
            description?: string | null;
            data?: any;
        }): Promise<{
            id: string;
            name: string;
            slug: string;
            description: string | null;
            data: Record<string, any>;
            createdAt: Date;
            updatedAt: Date;
        }>;
        update(slug: string, data: any): Promise<{
            id: string;
            name: string;
            slug: string;
            description: string | null;
            data: unknown;
            createdAt: Date;
            updatedAt: Date;
        } | undefined>;
    };
    entries: {
        findMany(collectionSlug: string, opts?: {
            cache?: boolean;
            depth?: number;
            version?: "draft" | "published";
            limit?: number;
        }): Promise<any[]>;
        findBySlug(collectionSlug: string, slug: string, opts?: {
            depth?: number;
            version?: "draft" | "published";
        }): Promise<any>;
        find(collectionSlug: string, id: string, opts?: {
            cache?: boolean;
            depth?: number;
            version?: "draft" | "published";
        }): Promise<any>;
        create(collectionSlug: string, data: any, opts?: {
            slug?: string;
            status?: string;
        }): Promise<{
            id: any;
            collectionId: string;
            slug: any;
            status: any;
            data: any;
            createdAt: any;
            updatedAt: any;
        } | undefined>;
        update(collectionSlug: string, id: string, data?: any, opts?: {
            slug?: string;
            status?: string;
        }): Promise<{
            id: any;
            collectionId: string;
            slug: any;
            status: any;
            data: any;
            createdAt: any;
            updatedAt: any;
        }>;
        delete(collectionSlug: string, id: string): Promise<boolean>;
    };
};

export { type TalismanEnv, createDbClient, getClient };
