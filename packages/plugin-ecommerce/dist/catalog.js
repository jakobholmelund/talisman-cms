import {
  commerceDb
} from "./chunk-HZZSX5TT.js";
import {
  PRODUCT_STATUSES
} from "./chunk-3XLIJPB2.js";

// src/catalog.ts
import { z } from "zod";
import { sql } from "drizzle-orm";
var byCreation = { createdAt: "asc", id: "asc" };
var catalogSchema = z.object({
  status: z.array(z.enum(PRODUCT_STATUSES)).min(1).max(3).optional(),
  ids: z.array(z.string().min(1).max(128)).min(1).max(80).optional(),
  slug: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(1024).optional()
}).strict();
async function readCatalogPage(env, options = {}) {
  const values = catalogSchema.parse(options);
  let position;
  if (values.cursor) {
    try {
      position = z.tuple([z.number().int().nonnegative(), z.string().min(1).max(128)]).parse(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(values.cursor), (char) => char.charCodeAt(0)))));
    } catch {
      throw new Error("Invalid catalog cursor");
    }
  }
  const products = await commerceDb(env).query.products.findMany({
    limit: values.limit + 1,
    where: {
      status: values.status ? { in: values.status } : void 0,
      id: values.ids ? { in: values.ids } : void 0,
      slug: values.slug,
      RAW: position ? (product) => sql`(${product.createdAt}, ${product.id}) > (${position[0]}, ${position[1]})` : void 0
    },
    orderBy: byCreation,
    with: {
      categories: { orderBy: { name: "asc" } },
      tags: { orderBy: { name: "asc" } },
      variants: { orderBy: byCreation, with: {
        variant: true,
        values: { orderBy: byCreation, with: {
          stock: true,
          requirements: { orderBy: { componentId: "asc" }, with: { component: true } }
        } }
      } }
    }
  });
  const page = products.slice(0, values.limit);
  const last = page.at(-1);
  return { products: page, nextCursor: products.length > values.limit && last ? btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify([Math.floor(last.createdAt.getTime() / 1e3), last.id])))) : null };
}
async function readCatalog(env, options = {}) {
  return (await readCatalogPage(env, options)).products;
}
function commerceContentCollection(config) {
  return { ...config, adminSection: "commerce" };
}
var quote = (value) => value === null || value === void 0 ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
var now = "strftime('%s', 'now')";
var json = (value) => quote(JSON.stringify(value));
function insert(table, values) {
  const fields = Object.keys(values);
  return `INSERT OR IGNORE INTO ${table} (${fields.join(", ")}) VALUES (${fields.map((field) => values[field]).join(", ")});`;
}
function createCommerceCatalogSeedSql(seed) {
  const sql2 = [];
  for (const category of seed.categories || []) {
    sql2.push(insert("_ecommerce_categories", {
      id: quote(category.id),
      name: quote(category.name),
      slug: quote(category.slug),
      description: quote(category.description),
      image: quote(category.image),
      parent_id: quote(category.parentId),
      created_at: now,
      updated_at: now
    }));
  }
  for (const variant of seed.variants || []) {
    sql2.push(insert("_ecommerce_variants", {
      id: quote(variant.id),
      name: quote(variant.name),
      created_at: now,
      updated_at: now
    }));
  }
  for (const tag of seed.tags || []) {
    sql2.push(insert("_ecommerce_tags", {
      id: quote(tag.id),
      name: quote(tag.name),
      color: quote(tag.color || "blue"),
      created_at: now,
      updated_at: now
    }));
  }
  for (const product of seed.products || []) {
    sql2.push(insert("_ecommerce_products", {
      id: quote(product.id),
      name: quote(product.name),
      slug: quote(product.slug),
      sku: quote(product.sku),
      description: quote(product.description),
      images: json(product.images || []),
      category_ids: json(product.categoryIds || []),
      tag_ids: json(product.tagIds || []),
      base_price: String(product.basePrice ?? 0),
      inventory_quantity: String(product.inventoryQuantity ?? 0),
      is_physical: product.isPhysical === false ? "0" : "1",
      type: quote(product.type || "standard"),
      status: quote(product.status || "draft"),
      created_at: now,
      updated_at: now
    }));
    for (const categoryId of product.categoryIds || []) {
      sql2.push(insert("_ecommerce_product_categories", { product_id: quote(product.id), category_id: quote(categoryId) }));
    }
    for (const tagId of product.tagIds || []) {
      sql2.push(insert("_ecommerce_product_tags", { product_id: quote(product.id), tag_id: quote(tagId) }));
    }
  }
  for (const group of seed.productVariants || []) {
    sql2.push(insert("_ecommerce_product_variants", {
      id: quote(group.id),
      product_id: quote(group.productId),
      variant_id: quote(group.variantId),
      name: quote(group.name),
      sku: quote(group.sku),
      price_override: quote(group.priceOverride),
      inventory_quantity: String(group.inventoryQuantity ?? 0),
      created_at: now,
      updated_at: now
    }));
  }
  for (const value of seed.variantValues || []) {
    sql2.push(insert("_ecommerce_product_variant_values", {
      id: quote(value.id),
      product_variant_id: quote(value.productVariantId),
      value: quote(value.value),
      sku: quote(value.sku),
      image: quote(value.image),
      price_override: quote(value.priceOverride),
      created_at: now,
      updated_at: now
    }));
  }
  for (const component of seed.components || []) {
    sql2.push(insert("_ecommerce_components", {
      id: quote(component.id),
      sku: quote(component.sku),
      name: quote(component.name),
      quantity: String(component.quantity ?? 0),
      created_at: now,
      updated_at: now
    }));
  }
  for (const mapping of seed.variantComponents || []) {
    sql2.push(insert("_ecommerce_variant_components", {
      id: quote(mapping.id),
      product_variant_value_id: quote(mapping.productVariantValueId),
      component_id: quote(mapping.componentId),
      quantity: String(mapping.quantity ?? 1),
      created_at: now,
      updated_at: now
    }));
  }
  for (const group of seed.content || []) {
    const slug = quote(group.collection.slug);
    sql2.push(`INSERT INTO galaxy_collections (id, name, slug, description, fields, created_at) SELECT ${quote(`commerce-content:${group.collection.slug}`)}, ${quote(group.collection.name)}, ${slug}, ${quote(group.collection.description)}, '[]', ${now} WHERE NOT EXISTS (SELECT 1 FROM galaxy_collections WHERE slug = ${slug});`);
    for (const entry of group.entries) {
      const entryId = quote(entry.id);
      const entrySlug = quote(entry.slug);
      const data = json(entry.data);
      const revisionId = quote(`baseline_rev_${entry.id}`);
      sql2.push(`INSERT INTO galaxy_entries (id, collection_id, slug, status, data, published_data, created_at, updated_at, published_at) SELECT ${entryId}, id, ${entrySlug}, 'published', ${data}, ${data}, ${now}, ${now}, ${now} FROM galaxy_collections WHERE slug = ${slug} AND NOT EXISTS (SELECT 1 FROM galaxy_entries WHERE collection_id = galaxy_collections.id AND slug = ${entrySlug});`);
      sql2.push(`INSERT INTO galaxy_entry_revisions (id, entry_id, collection_id, revision_number, type, status, data, created_at) SELECT ${revisionId}, id, collection_id, 1, 'publish', 'published', COALESCE(published_data, data), updated_at FROM galaxy_entries WHERE id = ${entryId} AND status = 'published' AND NOT EXISTS (SELECT 1 FROM galaxy_entry_revisions WHERE entry_id = ${entryId});`);
      sql2.push(`UPDATE galaxy_entries SET published_revision_id = ${revisionId} WHERE id = ${entryId} AND published_revision_id IS NULL AND EXISTS (SELECT 1 FROM galaxy_entry_revisions WHERE id = ${revisionId});`);
    }
  }
  return `${sql2.join("\n")}
`;
}
export {
  commerceContentCollection,
  createCommerceCatalogSeedSql,
  readCatalog,
  readCatalogPage
};
