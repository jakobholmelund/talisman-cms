import {
  commerceDb
} from "./chunk-SXQHVX4E.js";
import {
  PRODUCT_STATUSES,
  categories,
  productCategories,
  products
} from "./chunk-PLAJXKV3.js";

// src/catalog.ts
import { z as z2 } from "zod";
import { sql as sql2 } from "drizzle-orm";

// src/catalog-discovery.ts
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
var discoverySchema = z.object({
  query: z.string().trim().max(120).default(""),
  category: z.string().max(128).default(""),
  type: z.enum(["", "standard", "digital", "subscription"]).default(""),
  inStock: z.boolean().default(false),
  sort: z.enum(["newest", "price-asc", "price-desc", "name"]).default("newest"),
  page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  pageSize: z.number().int().min(1).max(80).default(24)
}).strict();
var price = sql`COALESCE((SELECT MIN(NULLIF(COALESCE(v.price_override, g.price_override, ${products.basePrice}), 0))
  FROM _ecommerce_product_variants g LEFT JOIN _ecommerce_product_variant_values v ON v.product_variant_id = g.id
  WHERE g.product_id = ${products.id}), CASE WHEN EXISTS (SELECT 1 FROM _ecommerce_product_variants g WHERE g.product_id = ${products.id}) THEN 0 ELSE ${products.basePrice} END)`;
var available = sql`((NOT EXISTS (SELECT 1 FROM _ecommerce_product_variants g WHERE g.product_id = ${products.id})
    AND ${products.basePrice} > 0 AND (${products.type} <> 'standard' OR ${products.inventoryQuantity} > 0)) OR
  EXISTS (SELECT 1 FROM _ecommerce_product_variants g
    LEFT JOIN _ecommerce_product_variant_values v ON v.product_variant_id = g.id
    WHERE g.product_id = ${products.id} AND COALESCE(v.price_override, g.price_override, ${products.basePrice}) > 0 AND
    (${products.type} <> 'standard' OR CASE WHEN EXISTS (SELECT 1 FROM _ecommerce_variant_components r WHERE r.product_variant_value_id = v.id)
      THEN NOT EXISTS (SELECT 1 FROM _ecommerce_variant_components r LEFT JOIN _ecommerce_components c ON c.id = r.component_id
        WHERE r.product_variant_value_id = v.id AND (c.id IS NULL OR c.quantity < r.quantity))
      ELSE COALESCE((SELECT s.quantity FROM _ecommerce_stocks s WHERE s.product_variant_value_id = v.id), g.inventory_quantity) > 0 END)))`;
async function searchCatalog(env, options = {}) {
  const values = discoverySchema.parse(options);
  const db = commerceDb(env);
  const conditions = [eq(products.status, "active")];
  if (values.query) {
    const query = values.query.toLowerCase();
    conditions.push(sql`(instr(lower(${products.name}), ${query}) > 0 OR instr(lower(COALESCE(${products.description}, '')), ${query}) > 0
      OR instr(lower(COALESCE(${products.sku}, '')), ${query}) > 0 OR EXISTS (
        SELECT 1 FROM _ecommerce_product_variants g LEFT JOIN _ecommerce_product_variant_values v ON v.product_variant_id = g.id
        WHERE g.product_id = ${products.id} AND (instr(lower(COALESCE(g.sku, '')), ${query}) > 0 OR instr(lower(COALESCE(v.sku, '')), ${query}) > 0)))`);
  }
  if (values.category) conditions.push(sql`EXISTS (SELECT 1 FROM _ecommerce_product_categories pc WHERE pc.product_id = ${products.id} AND pc.category_id = ${values.category})`);
  if (values.type) conditions.push(eq(products.type, values.type));
  if (values.inStock) conditions.push(available);
  const where = and(...conditions);
  const [totals, categoryRows] = await db.batch([
    db.select({ count: count() }).from(products).where(where),
    db.select({ id: categories.id, name: categories.name, count: count() }).from(categories).innerJoin(productCategories, eq(productCategories.categoryId, categories.id)).innerJoin(products, eq(products.id, productCategories.productId)).where(eq(products.status, "active")).groupBy(categories.id).orderBy(asc(categories.name)).limit(100)
  ]);
  const total = Number(totals[0]?.count ?? 0);
  const pages = Math.max(1, Math.ceil(total / values.pageSize));
  const page = Math.min(values.page, pages);
  const order = values.sort === "price-asc" ? asc(price) : values.sort === "price-desc" ? desc(price) : values.sort === "name" ? asc(sql`lower(${products.name})`) : desc(products.createdAt);
  const found = await db.select({ id: products.id }).from(products).where(where).orderBy(order, asc(products.id)).limit(values.pageSize).offset((page - 1) * values.pageSize);
  const hydrated = found.length ? await readCatalog(env, { status: ["active"], ids: found.map((row) => row.id), limit: values.pageSize }) : [];
  const byId = new Map(hydrated.map((product) => [product.id, product]));
  return {
    products: found.flatMap((row) => {
      const product = byId.get(row.id);
      return product ? [product] : [];
    }),
    total,
    page,
    pages,
    pageSize: values.pageSize,
    categories: categoryRows,
    filters: values
  };
}
function catalogOffer(product) {
  const tracksStock = product.type === "standard";
  const options = product.variants.flatMap((group) => group.values.length ? group.values.map((value) => {
    const quantity = value.requirements.length ? Math.min(...value.requirements.map((part) => part.component && part.quantity > 0 ? Math.floor(part.component.quantity / part.quantity) : 0)) : value.stock?.quantity ?? group.inventoryQuantity;
    return {
      id: value.id,
      label: `${group.variant?.name ?? group.name}: ${value.value}`,
      image: value.image,
      price: value.priceOverride ?? group.priceOverride ?? product.basePrice,
      quantity: tracksStock ? Math.max(0, quantity) : null
    };
  }) : [{
    id: group.id,
    label: group.name,
    image: null,
    price: group.priceOverride ?? product.basePrice,
    quantity: tracksStock ? Math.max(0, group.inventoryQuantity) : null
  }]);
  const choices = options.length ? options : [{
    id: null,
    label: product.name,
    image: null,
    price: product.basePrice,
    quantity: tracksStock ? Math.max(0, product.inventoryQuantity) : null
  }];
  const prices = choices.map((choice) => choice.price).filter((price2) => price2 > 0);
  const purchasable = (choice) => product.status === "active" && choice.price > 0 && (choice.quantity === null || choice.quantity > 0);
  return {
    options,
    choices,
    minPrice: prices.length ? Math.min(...prices) : 0,
    maxPrice: prices.length ? Math.max(...prices) : 0,
    available: choices.some(purchasable),
    selected: choices.find(purchasable) ?? choices[0]
  };
}

// src/catalog.ts
var byCreation = { createdAt: "asc", id: "asc" };
var catalogSchema = z2.object({
  status: z2.array(z2.enum(PRODUCT_STATUSES)).min(1).max(3).optional(),
  ids: z2.array(z2.string().min(1).max(128)).min(1).max(80).optional(),
  slug: z2.string().min(1).max(200).optional(),
  limit: z2.number().int().min(1).max(100).default(50),
  cursor: z2.string().max(1024).optional()
}).strict();
async function readCatalogPage(env, options = {}) {
  const values = catalogSchema.parse(options);
  let position;
  if (values.cursor) {
    try {
      position = z2.tuple([z2.number().int().nonnegative(), z2.string().min(1).max(128)]).parse(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(values.cursor), (char) => char.charCodeAt(0)))));
    } catch {
      throw new Error("Invalid catalog cursor");
    }
  }
  const products2 = await commerceDb(env).query.products.findMany({
    limit: values.limit + 1,
    where: {
      status: values.status ? { in: values.status } : void 0,
      id: values.ids ? { in: values.ids } : void 0,
      slug: values.slug,
      RAW: position ? (product) => sql2`(${product.createdAt}, ${product.id}) > (${position[0]}, ${position[1]})` : void 0
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
  const page = products2.slice(0, values.limit);
  const last = page.at(-1);
  return { products: page, nextCursor: products2.length > values.limit && last ? btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify([Math.floor(last.createdAt.getTime() / 1e3), last.id])))) : null };
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
  const sql3 = [];
  for (const category of seed.categories || []) {
    sql3.push(insert("_ecommerce_categories", {
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
    sql3.push(insert("_ecommerce_variants", {
      id: quote(variant.id),
      name: quote(variant.name),
      created_at: now,
      updated_at: now
    }));
  }
  for (const tag of seed.tags || []) {
    sql3.push(insert("_ecommerce_tags", {
      id: quote(tag.id),
      name: quote(tag.name),
      color: quote(tag.color || "blue"),
      created_at: now,
      updated_at: now
    }));
  }
  for (const product of seed.products || []) {
    sql3.push(insert("_ecommerce_products", {
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
      sql3.push(insert("_ecommerce_product_categories", { product_id: quote(product.id), category_id: quote(categoryId) }));
    }
    for (const tagId of product.tagIds || []) {
      sql3.push(insert("_ecommerce_product_tags", { product_id: quote(product.id), tag_id: quote(tagId) }));
    }
  }
  for (const group of seed.productVariants || []) {
    sql3.push(insert("_ecommerce_product_variants", {
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
    sql3.push(insert("_ecommerce_product_variant_values", {
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
    sql3.push(insert("_ecommerce_components", {
      id: quote(component.id),
      sku: quote(component.sku),
      name: quote(component.name),
      quantity: String(component.quantity ?? 0),
      created_at: now,
      updated_at: now
    }));
  }
  for (const mapping of seed.variantComponents || []) {
    sql3.push(insert("_ecommerce_variant_components", {
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
    sql3.push(`INSERT INTO galaxy_collections (id, name, slug, description, fields, created_at) SELECT ${quote(`commerce-content:${group.collection.slug}`)}, ${quote(group.collection.name)}, ${slug}, ${quote(group.collection.description)}, '[]', ${now} WHERE NOT EXISTS (SELECT 1 FROM galaxy_collections WHERE slug = ${slug});`);
    for (const entry of group.entries) {
      const entryId = quote(entry.id);
      const entrySlug = quote(entry.slug);
      const data = json(entry.data);
      const revisionId = quote(`baseline_rev_${entry.id}`);
      sql3.push(`INSERT INTO galaxy_entries (id, collection_id, slug, status, data, published_data, created_at, updated_at, published_at) SELECT ${entryId}, id, ${entrySlug}, 'published', ${data}, ${data}, ${now}, ${now}, ${now} FROM galaxy_collections WHERE slug = ${slug} AND NOT EXISTS (SELECT 1 FROM galaxy_entries WHERE collection_id = galaxy_collections.id AND slug = ${entrySlug});`);
      sql3.push(`INSERT INTO galaxy_entry_revisions (id, entry_id, collection_id, revision_number, type, status, data, created_at) SELECT ${revisionId}, id, collection_id, 1, 'publish', 'published', COALESCE(published_data, data), updated_at FROM galaxy_entries WHERE id = ${entryId} AND status = 'published' AND NOT EXISTS (SELECT 1 FROM galaxy_entry_revisions WHERE entry_id = ${entryId});`);
      sql3.push(`UPDATE galaxy_entries SET published_revision_id = ${revisionId} WHERE id = ${entryId} AND published_revision_id IS NULL AND EXISTS (SELECT 1 FROM galaxy_entry_revisions WHERE id = ${revisionId});`);
    }
  }
  return `${sql3.join("\n")}
`;
}
export {
  catalogOffer,
  commerceContentCollection,
  createCommerceCatalogSeedSql,
  readCatalog,
  readCatalogPage,
  searchCatalog
};
