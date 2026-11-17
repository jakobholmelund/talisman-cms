import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb } from './db';
import { categories, productCategories, products } from './schema';
import { readCatalog, type CatalogProduct } from './catalog';

const discoverySchema = z.object({
  query: z.string().trim().max(120).default(''),
  category: z.string().max(128).default(''),
  type: z.enum(['', 'standard', 'digital', 'subscription']).default(''),
  inStock: z.boolean().default(false),
  sort: z.enum(['newest', 'price-asc', 'price-desc', 'name']).default('newest'),
  page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  pageSize: z.number().int().min(1).max(80).default(24),
}).strict();
export type CatalogSearchOptions = z.input<typeof discoverySchema>;

/** The same price hierarchy used at checkout, including legacy groups without values. */
const price = sql<number>`COALESCE((SELECT MIN(NULLIF(COALESCE(v.price_override, g.price_override, ${products.basePrice}), 0))
  FROM _ecommerce_product_variants g LEFT JOIN _ecommerce_product_variant_values v ON v.product_variant_id = g.id
  WHERE g.product_id = ${products.id}), CASE WHEN EXISTS (SELECT 1 FROM _ecommerce_product_variants g WHERE g.product_id = ${products.id}) THEN 0 ELSE ${products.basePrice} END)`;

// A component recipe replaces finished stock. Availability must not add quantities across options:
// two options may draw from the same component, and checkout reserves that component atomically.
const available = sql`((NOT EXISTS (SELECT 1 FROM _ecommerce_product_variants g WHERE g.product_id = ${products.id})
    AND ${products.basePrice} > 0 AND (${products.type} <> 'standard' OR ${products.inventoryQuantity} > 0)) OR
  EXISTS (SELECT 1 FROM _ecommerce_product_variants g
    LEFT JOIN _ecommerce_product_variant_values v ON v.product_variant_id = g.id
    WHERE g.product_id = ${products.id} AND COALESCE(v.price_override, g.price_override, ${products.basePrice}) > 0 AND
    (${products.type} <> 'standard' OR CASE WHEN EXISTS (SELECT 1 FROM _ecommerce_variant_components r WHERE r.product_variant_value_id = v.id)
      THEN NOT EXISTS (SELECT 1 FROM _ecommerce_variant_components r LEFT JOIN _ecommerce_components c ON c.id = r.component_id
        WHERE r.product_variant_value_id = v.id AND (c.id IS NULL OR c.quantity < r.quantity))
      ELSE COALESCE((SELECT s.quantity FROM _ecommerce_stocks s WHERE s.product_variant_value_id = v.id), g.inventory_quantity) > 0 END)))`;

/** Server-side discovery over the complete active catalog. Filtering and sorting happen before
 * pagination; only a bounded page gets its variants, stock and components hydrated. No drafts. */
export async function searchCatalog(env: TalismanEnv, options: CatalogSearchOptions = {}) {
  const values = discoverySchema.parse(options);
  const db = commerceDb(env);
  const conditions = [eq(products.status, 'active')];
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
    db.select({ id: categories.id, name: categories.name, count: count() }).from(categories)
      .innerJoin(productCategories, eq(productCategories.categoryId, categories.id))
      .innerJoin(products, eq(products.id, productCategories.productId)).where(eq(products.status, 'active'))
      .groupBy(categories.id).orderBy(asc(categories.name)).limit(100),
  ]);
  const total = Number(totals[0]?.count ?? 0);
  const pages = Math.max(1, Math.ceil(total / values.pageSize));
  const page = Math.min(values.page, pages);
  const order = values.sort === 'price-asc' ? asc(price) : values.sort === 'price-desc' ? desc(price)
    : values.sort === 'name' ? asc(sql`lower(${products.name})`) : desc(products.createdAt);
  const found = await db.select({ id: products.id }).from(products).where(where)
    .orderBy(order, asc(products.id)).limit(values.pageSize).offset((page - 1) * values.pageSize);
  const hydrated = found.length ? await readCatalog(env, { status: ['active'], ids: found.map(row => row.id), limit: values.pageSize }) : [];
  const byId = new Map(hydrated.map(product => [product.id, product]));
  return { products: found.flatMap(row => { const product = byId.get(row.id); return product ? [product] : []; }),
    total, page, pages, pageSize: values.pageSize, categories: categoryRows, filters: values };
}

/** Public display data, following checkout's stock and price rules. This is a snapshot; checkout
 * remains authoritative when stock changes or different choices share components. */
export function catalogOffer(product: CatalogProduct) {
  const tracksStock = product.type === 'standard';
  const options = product.variants.flatMap(group => group.values.length ? group.values.map(value => {
    const quantity = value.requirements.length
      ? Math.min(...value.requirements.map(part => part.component && part.quantity > 0 ? Math.floor(part.component.quantity / part.quantity) : 0))
      : value.stock?.quantity ?? group.inventoryQuantity;
    return { id: value.id, label: `${group.variant?.name ?? group.name}: ${value.value}`, image: value.image,
      price: value.priceOverride ?? group.priceOverride ?? product.basePrice,
      quantity: tracksStock ? Math.max(0, quantity) : null };
  }) : [{ id: group.id, label: group.name, image: null, price: group.priceOverride ?? product.basePrice,
    quantity: tracksStock ? Math.max(0, group.inventoryQuantity) : null }]);
  const choices = options.length ? options : [{ id: null, label: product.name, image: null, price: product.basePrice,
    quantity: tracksStock ? Math.max(0, product.inventoryQuantity) : null }];
  const prices = choices.map(choice => choice.price).filter(price => price > 0);
  const purchasable = (choice: typeof choices[number]) => product.status === 'active' && choice.price > 0 && (choice.quantity === null || choice.quantity > 0);
  return { options, choices, minPrice: prices.length ? Math.min(...prices) : 0, maxPrice: prices.length ? Math.max(...prices) : 0,
    available: choices.some(purchasable), selected: choices.find(purchasable) ?? choices[0] };
}
