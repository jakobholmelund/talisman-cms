// src/catalog.ts
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
  const sql = [];
  for (const category of seed.categories || []) {
    sql.push(insert("_ecommerce_categories", {
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
    sql.push(insert("_ecommerce_variants", {
      id: quote(variant.id),
      name: quote(variant.name),
      created_at: now,
      updated_at: now
    }));
  }
  for (const tag of seed.tags || []) {
    sql.push(insert("_ecommerce_tags", {
      id: quote(tag.id),
      name: quote(tag.name),
      color: quote(tag.color || "blue"),
      created_at: now,
      updated_at: now
    }));
  }
  for (const product of seed.products || []) {
    sql.push(insert("_ecommerce_products", {
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
      sql.push(insert("_ecommerce_product_categories", { product_id: quote(product.id), category_id: quote(categoryId) }));
    }
    for (const tagId of product.tagIds || []) {
      sql.push(insert("_ecommerce_product_tags", { product_id: quote(product.id), tag_id: quote(tagId) }));
    }
  }
  for (const group of seed.productVariants || []) {
    sql.push(insert("_ecommerce_product_variants", {
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
    sql.push(insert("_ecommerce_product_variant_values", {
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
    sql.push(insert("_ecommerce_components", {
      id: quote(component.id),
      sku: quote(component.sku),
      name: quote(component.name),
      quantity: String(component.quantity ?? 0),
      created_at: now,
      updated_at: now
    }));
  }
  for (const mapping of seed.variantComponents || []) {
    sql.push(insert("_ecommerce_variant_components", {
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
    sql.push(`INSERT INTO galaxy_collections (id, name, slug, description, fields, created_at) SELECT ${quote(`commerce-content:${group.collection.slug}`)}, ${quote(group.collection.name)}, ${slug}, ${quote(group.collection.description)}, '[]', ${now} WHERE NOT EXISTS (SELECT 1 FROM galaxy_collections WHERE slug = ${slug});`);
    for (const entry of group.entries) {
      const entrySlug = quote(entry.slug);
      const data = json(entry.data);
      sql.push(`INSERT INTO galaxy_entries (id, collection_id, slug, status, data, published_data, created_at, updated_at, published_at) SELECT ${quote(entry.id)}, id, ${entrySlug}, 'published', ${data}, ${data}, ${now}, ${now}, ${now} FROM galaxy_collections WHERE slug = ${slug} AND NOT EXISTS (SELECT 1 FROM galaxy_entries WHERE collection_id = galaxy_collections.id AND slug = ${entrySlug});`);
    }
  }
  return `${sql.join("\n")}
`;
}
export {
  commerceContentCollection,
  createCommerceCatalogSeedSql
};
