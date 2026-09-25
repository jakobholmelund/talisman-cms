import { FieldDefinition, CollectionConfig } from 'talisman-cms';

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
 * Generate an idempotent first-run D1/SQLite catalog import. Every row uses
 * INSERT OR IGNORE, so editors own subsequent changes in Commerce.
 * Apply Talisman CMS migrations before running the generated SQL.
 */
declare function createCommerceCatalogSeedSql(seed: CommerceCatalogSeed): string;

export { type CommerceCatalogSeed, commerceContentCollection, createCommerceCatalogSeedSql };
