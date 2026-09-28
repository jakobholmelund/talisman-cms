import type { CollectionConfig, FieldDefinition } from 'talisman-cms';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb } from './db';
import type { PRODUCT_STATUSES } from './schema';

const byCreation = { createdAt: 'asc', id: 'asc' } as const;

/**
 * The catalog in one statement, for a storefront: every product with its variant groups, each with
 * its definition, its values, their stock rows and bills of materials, and the product's categories
 * and tags, oldest first; `status` narrows the products. Read from D1 without the KV cache, so a
 * Commerce edit shows on the next request. One call serves every product a page shows.
 */
export function readCatalog(env: TalismanEnv, options: { status?: ReadonlyArray<typeof PRODUCT_STATUSES[number]> } = {}) {
  return commerceDb(env).query.products.findMany({
    where: options.status ? { status: { in: [...options.status] } } : undefined,
    orderBy: byCreation,
    with: {
      categories: { orderBy: { name: 'asc' } },
      tags: { orderBy: { name: 'asc' } },
      variants: { orderBy: byCreation, with: {
        variant: true,
        values: { orderBy: byCreation, with: {
          stock: true,
          requirements: { orderBy: { componentId: 'asc' }, with: { component: true } },
        } },
      } },
    },
  });
}

/** A product as `readCatalog` returns it, with its nested groups, values, categories and tags. */
export type CatalogProduct = Awaited<ReturnType<typeof readCatalog>>[number];

/** Place site-specific content beside products and variants in the Commerce admin. */
export function commerceContentCollection(config: {
  name: string;
  slug: string;
  description?: string;
  fields: FieldDefinition[];
}): CollectionConfig {
  return { ...config, adminSection: 'commerce' };
}

export interface CommerceCatalogSeed {
  products?: Array<{
    id: string; name: string; slug: string; sku?: string; description?: string;
    images?: string[]; categoryIds?: string[]; tagIds?: string[];
    basePrice?: number; inventoryQuantity?: number; isPhysical?: boolean;
    type?: 'standard' | 'digital' | 'subscription'; status?: 'draft' | 'active' | 'archived';
  }>;
  categories?: Array<{ id: string; name: string; slug: string; description?: string; image?: string; parentId?: string }>;
  tags?: Array<{ id: string; name: string; color?: string }>;
  variants?: Array<{ id: string; name: string }>;
  productVariants?: Array<{
    id: string; productId: string; variantId?: string; name: string;
    sku?: string; priceOverride?: number; inventoryQuantity?: number;
  }>;
  variantValues?: Array<{
    id: string; productVariantId: string; value: string; sku?: string;
    image?: string; priceOverride?: number;
  }>;
  components?: Array<{ id: string; sku: string; name: string; quantity?: number }>;
  variantComponents?: Array<{ id: string; productVariantValueId: string; componentId: string; quantity?: number }>;
  content?: Array<{
    collection: { name: string; slug: string; description?: string };
    entries: Array<{ id: string; slug: string; data: Record<string, unknown> }>;
  }>;
}

const quote = (value: unknown): string => value === null || value === undefined
  ? 'NULL'
  : `'${String(value).replaceAll("'", "''")}'`;
const now = "strftime('%s', 'now')";
const json = (value: unknown) => quote(JSON.stringify(value));

function insert(table: string, values: Record<string, string>): string {
  const fields = Object.keys(values);
  return `INSERT OR IGNORE INTO ${table} (${fields.join(', ')}) VALUES (${fields.map((field) => values[field]).join(', ')});`;
}

/**
 * Generate an idempotent first-run D1/SQLite catalog import. Every row is inserted
 * only when missing, so editors own subsequent changes in Commerce. Content entries
 * start with a published baseline revision, like entries created in the editor.
 * Apply Talisman CMS migrations before running the generated SQL.
 */
export function createCommerceCatalogSeedSql(seed: CommerceCatalogSeed): string {
  const sql: string[] = [];
  for (const category of seed.categories || []) {
    sql.push(insert('_ecommerce_categories', {
      id: quote(category.id), name: quote(category.name), slug: quote(category.slug),
      description: quote(category.description), image: quote(category.image), parent_id: quote(category.parentId),
      created_at: now, updated_at: now
    }));
  }
  for (const variant of seed.variants || []) {
    sql.push(insert('_ecommerce_variants', {
      id: quote(variant.id), name: quote(variant.name), created_at: now, updated_at: now
    }));
  }
  for (const tag of seed.tags || []) {
    sql.push(insert('_ecommerce_tags', {
      id: quote(tag.id), name: quote(tag.name), color: quote(tag.color || 'blue'),
      created_at: now, updated_at: now
    }));
  }
  for (const product of seed.products || []) {
    sql.push(insert('_ecommerce_products', {
      id: quote(product.id), name: quote(product.name), slug: quote(product.slug),
      sku: quote(product.sku), description: quote(product.description), images: json(product.images || []),
      category_ids: json(product.categoryIds || []), tag_ids: json(product.tagIds || []),
      base_price: String(product.basePrice ?? 0), inventory_quantity: String(product.inventoryQuantity ?? 0),
      is_physical: product.isPhysical === false ? '0' : '1', type: quote(product.type || 'standard'),
      status: quote(product.status || 'draft'), created_at: now, updated_at: now
    }));
    for (const categoryId of product.categoryIds || []) {
      sql.push(insert('_ecommerce_product_categories', { product_id: quote(product.id), category_id: quote(categoryId) }));
    }
    for (const tagId of product.tagIds || []) {
      sql.push(insert('_ecommerce_product_tags', { product_id: quote(product.id), tag_id: quote(tagId) }));
    }
  }
  for (const group of seed.productVariants || []) {
    sql.push(insert('_ecommerce_product_variants', {
      id: quote(group.id), product_id: quote(group.productId), variant_id: quote(group.variantId),
      name: quote(group.name), sku: quote(group.sku), price_override: quote(group.priceOverride),
      inventory_quantity: String(group.inventoryQuantity ?? 0), created_at: now, updated_at: now
    }));
  }
  for (const value of seed.variantValues || []) {
    sql.push(insert('_ecommerce_product_variant_values', {
      id: quote(value.id), product_variant_id: quote(value.productVariantId), value: quote(value.value),
      sku: quote(value.sku), image: quote(value.image), price_override: quote(value.priceOverride),
      created_at: now, updated_at: now
    }));
  }
  for (const component of seed.components || []) {
    sql.push(insert('_ecommerce_components', {
      id: quote(component.id), sku: quote(component.sku), name: quote(component.name),
      quantity: String(component.quantity ?? 0), created_at: now, updated_at: now
    }));
  }
  for (const mapping of seed.variantComponents || []) {
    sql.push(insert('_ecommerce_variant_components', {
      id: quote(mapping.id), product_variant_value_id: quote(mapping.productVariantValueId),
      component_id: quote(mapping.componentId), quantity: String(mapping.quantity ?? 1),
      created_at: now, updated_at: now
    }));
  }
  for (const group of seed.content || []) {
    const slug = quote(group.collection.slug);
    sql.push(`INSERT INTO galaxy_collections (id, name, slug, description, fields, created_at) SELECT ${quote(`commerce-content:${group.collection.slug}`)}, ${quote(group.collection.name)}, ${slug}, ${quote(group.collection.description)}, '[]', ${now} WHERE NOT EXISTS (SELECT 1 FROM galaxy_collections WHERE slug = ${slug});`);
    for (const entry of group.entries) {
      const entryId = quote(entry.id);
      const entrySlug = quote(entry.slug);
      const data = json(entry.data);
      const revisionId = quote(`baseline_rev_${entry.id}`);
      sql.push(`INSERT INTO galaxy_entries (id, collection_id, slug, status, data, published_data, created_at, updated_at, published_at) SELECT ${entryId}, id, ${entrySlug}, 'published', ${data}, ${data}, ${now}, ${now}, ${now} FROM galaxy_collections WHERE slug = ${slug} AND NOT EXISTS (SELECT 1 FROM galaxy_entries WHERE collection_id = galaxy_collections.id AND slug = ${entrySlug});`);
      // The editor saves against the latest revision, so an imported entry starts with its published one.
      sql.push(`INSERT INTO galaxy_entry_revisions (id, entry_id, collection_id, revision_number, type, status, data, created_at) SELECT ${revisionId}, id, collection_id, 1, 'publish', 'published', COALESCE(published_data, data), updated_at FROM galaxy_entries WHERE id = ${entryId} AND status = 'published' AND NOT EXISTS (SELECT 1 FROM galaxy_entry_revisions WHERE entry_id = ${entryId});`);
      sql.push(`UPDATE galaxy_entries SET published_revision_id = ${revisionId} WHERE id = ${entryId} AND published_revision_id IS NULL AND EXISTS (SELECT 1 FROM galaxy_entry_revisions WHERE id = ${revisionId});`);
    }
  }
  return `${sql.join('\n')}\n`;
}
