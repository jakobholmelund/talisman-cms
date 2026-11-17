import { FieldDefinition, CollectionConfig } from 'talisman-cms';
import { TalismanEnv } from 'talisman-cms/client';
import { PRODUCT_STATUSES } from './schema.js';
import { z } from 'zod';
import 'drizzle-orm';
import 'drizzle-orm/sqlite-core';

declare const discoverySchema: z.ZodObject<{
    query: z.ZodDefault<z.ZodString>;
    category: z.ZodDefault<z.ZodString>;
    type: z.ZodDefault<z.ZodEnum<{
        "": "";
        standard: "standard";
        digital: "digital";
        subscription: "subscription";
    }>>;
    inStock: z.ZodDefault<z.ZodBoolean>;
    sort: z.ZodDefault<z.ZodEnum<{
        name: "name";
        newest: "newest";
        "price-asc": "price-asc";
        "price-desc": "price-desc";
    }>>;
    page: z.ZodDefault<z.ZodNumber>;
    pageSize: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
type CatalogSearchOptions = z.input<typeof discoverySchema>;
/** Server-side discovery over the complete active catalog. Filtering and sorting happen before
 * pagination; only a bounded page gets its variants, stock and components hydrated. No drafts. */
declare function searchCatalog(env: TalismanEnv, options?: CatalogSearchOptions): Promise<{
    products: {
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
                    quantity: number;
                    productVariantValueId: string;
                } | null;
                requirements: {
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    quantity: number;
                    productVariantValueId: string;
                    componentId: string;
                    component: {
                        id: string;
                        createdAt: Date;
                        updatedAt: Date;
                        name: string;
                        quantity: number;
                        sku: string;
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
    }[];
    total: number;
    page: number;
    pages: number;
    pageSize: number;
    categories: {
        id: string;
        name: string;
        count: number;
    }[];
    filters: {
        query: string;
        category: string;
        type: "" | "standard" | "digital" | "subscription";
        inStock: boolean;
        sort: "name" | "newest" | "price-asc" | "price-desc";
        page: number;
        pageSize: number;
    };
}>;
/** Public display data, following checkout's stock and price rules. This is a snapshot; checkout
 * remains authoritative when stock changes or different choices share components. */
declare function catalogOffer(product: CatalogProduct): {
    options: {
        id: string;
        label: string;
        image: string | null;
        price: number;
        quantity: number | null;
    }[];
    choices: {
        id: string;
        label: string;
        image: string | null;
        price: number;
        quantity: number | null;
    }[] | {
        id: null;
        label: string;
        image: null;
        price: number;
        quantity: number | null;
    }[];
    minPrice: number;
    maxPrice: number;
    available: boolean;
    selected: {
        id: string;
        label: string;
        image: string | null;
        price: number;
        quantity: number | null;
    } | {
        id: null;
        label: string;
        image: null;
        price: number;
        quantity: number | null;
    };
};

type CatalogReadOptions = {
    status?: ReadonlyArray<typeof PRODUCT_STATUSES[number]>;
    ids?: string[];
    slug?: string;
    limit?: number;
    cursor?: string;
};
/** Bounded catalog page: at most 100 products, with stable createdAt/id continuation and optional ids/slug/status. */
declare function readCatalogPage(env: TalismanEnv, options?: CatalogReadOptions): Promise<{
    products: {
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
                    quantity: number;
                    productVariantValueId: string;
                } | null;
                requirements: {
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    quantity: number;
                    productVariantValueId: string;
                    componentId: string;
                    component: {
                        id: string;
                        createdAt: Date;
                        updatedAt: Date;
                        name: string;
                        quantity: number;
                        sku: string;
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
    }[];
    nextCursor: string | null;
}>;
/** Compatibility array API, now bounded to 50 by default/100 at most. Use readCatalogPage for continuation. */
declare function readCatalog(env: TalismanEnv, options?: CatalogReadOptions): Promise<{
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
                quantity: number;
                productVariantValueId: string;
            } | null;
            requirements: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                quantity: number;
                productVariantValueId: string;
                componentId: string;
                component: {
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    name: string;
                    quantity: number;
                    sku: string;
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

export { type CatalogProduct, type CatalogReadOptions, type CatalogSearchOptions, type CommerceCatalogSeed, catalogOffer, commerceContentCollection, createCommerceCatalogSeedSql, readCatalog, readCatalogPage, searchCatalog };
