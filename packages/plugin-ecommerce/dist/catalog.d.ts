import * as drizzle_orm_sqlite_core from 'drizzle-orm/sqlite-core';
import { FieldDefinition, CollectionConfig } from 'talisman-cms';
import { TalismanEnv } from 'talisman-cms/client';
import { PRODUCT_STATUSES } from './schema.js';
import 'drizzle-orm';

/**
 * The catalog in one statement, for a storefront: every product with its variant groups, each with
 * its definition, its values, their stock rows and bills of materials, and the product's categories
 * and tags, oldest first; `status` narrows the products. Read from D1 without the KV cache, so a
 * Commerce edit shows on the next request. One call serves every product a page shows.
 */
declare function readCatalog(env: TalismanEnv, options?: {
    status?: ReadonlyArray<typeof PRODUCT_STATUSES[number]>;
}): drizzle_orm_sqlite_core.SQLiteAsyncRelationalQuery<"async", {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    status: "draft" | "active" | "archived";
    name: string;
    slug: string;
    sku: string | null;
    description: string | null;
    images: string[];
    categoryIds: string[];
    tagIds: string[];
    basePrice: number;
    isPhysical: boolean;
    inventoryQuantity: number;
    type: "standard" | "digital" | "subscription";
    variants: {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        name: string;
        sku: string | null;
        inventoryQuantity: number;
        productId: string;
        variantId: string | null;
        priceOverride: number | null;
        variant: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            name: string;
        } | null;
        values: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            sku: string | null;
            priceOverride: number | null;
            productVariantId: string;
            value: string;
            image: string | null;
            stock: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                productVariantValueId: string;
                quantity: number;
            } | null;
            requirements: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                productVariantValueId: string;
                quantity: number;
                componentId: string;
                component: {
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    name: string;
                    sku: string;
                    quantity: number;
                };
            }[];
        }[];
    }[];
    categories: {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        name: string;
        slug: string;
        description: string | null;
        image: string | null;
        parentId: string | null;
    }[];
    tags: {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        name: string;
        color: string;
    }[];
}[]>;
/** A product as `readCatalog` returns it, with its nested groups, values, categories and tags. */
type CatalogProduct = Awaited<ReturnType<typeof readCatalog>>[number];
/** Place site-specific content beside products and variants in the Commerce admin. */
declare function commerceContentCollection(config: {
    name: string;
    slug: string;
    description?: string;
    fields: FieldDefinition[];
}): CollectionConfig;
interface CommerceCatalogSeed {
    products?: Array<{
        id: string;
        name: string;
        slug: string;
        sku?: string;
        description?: string;
        images?: string[];
        categoryIds?: string[];
        tagIds?: string[];
        basePrice?: number;
        inventoryQuantity?: number;
        isPhysical?: boolean;
        type?: 'standard' | 'digital' | 'subscription';
        status?: 'draft' | 'active' | 'archived';
    }>;
    categories?: Array<{
        id: string;
        name: string;
        slug: string;
        description?: string;
        image?: string;
        parentId?: string;
    }>;
    tags?: Array<{
        id: string;
        name: string;
        color?: string;
    }>;
    variants?: Array<{
        id: string;
        name: string;
    }>;
    productVariants?: Array<{
        id: string;
        productId: string;
        variantId?: string;
        name: string;
        sku?: string;
        priceOverride?: number;
        inventoryQuantity?: number;
    }>;
    variantValues?: Array<{
        id: string;
        productVariantId: string;
        value: string;
        sku?: string;
        image?: string;
        priceOverride?: number;
    }>;
    components?: Array<{
        id: string;
        sku: string;
        name: string;
        quantity?: number;
    }>;
    variantComponents?: Array<{
        id: string;
        productVariantValueId: string;
        componentId: string;
        quantity?: number;
    }>;
    content?: Array<{
        collection: {
            name: string;
            slug: string;
            description?: string;
        };
        entries: Array<{
            id: string;
            slug: string;
            data: Record<string, unknown>;
        }>;
    }>;
}
/**
 * Generate an idempotent first-run D1/SQLite catalog import. Every row is inserted
 * only when missing, so editors own subsequent changes in Commerce. Content entries
 * start with a published baseline revision, like entries created in the editor.
 * Apply Talisman CMS migrations before running the generated SQL.
 */
declare function createCommerceCatalogSeedSql(seed: CommerceCatalogSeed): string;

export { type CatalogProduct, type CommerceCatalogSeed, commerceContentCollection, createCommerceCatalogSeedSql, readCatalog };
