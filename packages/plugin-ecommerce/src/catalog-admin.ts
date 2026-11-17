import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";
import { invalidateEntryCache, type TalismanEnv } from "talisman-cms/client";
import { commerceDb, errorText } from "./db";
import { products, categories } from "./schema";
import { CommerceOperationsConflict } from "./email-recovery";

const filtersSchema = z
  .object({
    search: z.string().trim().max(120).default(""),
    status: z.enum(["", "draft", "active", "archived"]).default(""),
    category: z.string().max(128).default(""),
    attention: z.enum(["all", "images", "low", "out", "price"]).default("all"),
    threshold: z.coerce.number().int().min(1).max(1000000).default(5),
    sort: z
      .enum(["name", "updated", "price-asc", "price-desc"])
      .default("updated"),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
  })
  .strict();
export type CatalogueFilters = z.infer<typeof filtersSchema>;
export type CatalogueRow = {
  id: string;
  name: string;
  slug: string;
  sku: string | null;
  image: string | null;
  basePrice: number;
  status: "draft" | "active" | "archived";
  type: string;
  updatedAt: string;
  choiceCount: number;
  variantCount: number;
  inStock: number;
  lowCount: number;
  outCount: number;
  missingPrice: number;
  customPrices: number;
  inheritedPrices: number;
  minCustom: number | null;
  maxCustom: number | null;
  minPrice: number;
  maxPrice: number;
  simpleQuantity: number | null;
};

/** Effective choices follow checkout: component recipes replace stock rows, which replace group
 * stock. Never sum shared stock across choices. Compute attention before paging the catalogue. */
function catalogueQuery(where: SQL, threshold: number) {
  return sql`WITH candidates AS (
 SELECT p.* FROM _ecommerce_products p WHERE ${where}
), choices AS (
 SELECT p.id AS productId, p.base_price AS price, NULL AS customPrice, CASE WHEN p.type='standard' THEN p.inventory_quantity ELSE NULL END AS quantity, 0 AS variant
 FROM candidates p WHERE NOT EXISTS(SELECT 1 FROM _ecommerce_product_variants g WHERE g.product_id=p.id)
 UNION ALL
 SELECT p.id, COALESCE(v.price_override,g.price_override,p.base_price), COALESCE(v.price_override,g.price_override),
 CASE WHEN p.type<>'standard' THEN NULL WHEN EXISTS(SELECT 1 FROM _ecommerce_variant_components r WHERE r.product_variant_value_id=v.id)
 THEN COALESCE((SELECT MIN(CASE WHEN c.id IS NULL OR r.quantity<=0 THEN 0 ELSE CAST(c.quantity/r.quantity AS INTEGER) END) FROM _ecommerce_variant_components r LEFT JOIN _ecommerce_components c ON c.id=r.component_id WHERE r.product_variant_value_id=v.id),0)
 ELSE COALESCE(s.quantity,g.inventory_quantity) END, 1
 FROM candidates p JOIN _ecommerce_product_variants g ON g.product_id=p.id LEFT JOIN _ecommerce_product_variant_values v ON v.product_variant_id=g.id LEFT JOIN _ecommerce_stocks s ON s.product_variant_value_id=v.id
), health AS (
 SELECT productId, COUNT(*) AS choiceCount,SUM(variant) AS variantCount,
 SUM(CASE WHEN price>0 AND (quantity IS NULL OR quantity>0) THEN 1 ELSE 0 END) AS inStock,
 SUM(CASE WHEN quantity>0 AND quantity<=${threshold} THEN 1 ELSE 0 END) AS lowCount,
 SUM(CASE WHEN quantity=0 THEN 1 ELSE 0 END) AS outCount,SUM(CASE WHEN price<=0 THEN 1 ELSE 0 END) AS missingPrice,
 SUM(CASE WHEN customPrice IS NOT NULL THEN 1 ELSE 0 END) AS customPrices,SUM(CASE WHEN customPrice IS NULL THEN 1 ELSE 0 END) AS inheritedPrices,
 MIN(customPrice) AS minCustom,MAX(customPrice) AS maxCustom,MIN(price) AS minPrice,MAX(price) AS maxPrice
 FROM choices GROUP BY productId
), catalogue AS (
 SELECT p.id,p.name,p.slug,p.sku,p.base_price AS basePrice,p.status,p.type,p.updated_at AS updatedSeconds,
 (SELECT CASE WHEN j.type='text' THEN trim(j.value) ELSE trim(json_extract(j.value,'$.url')) END FROM json_each(CASE WHEN json_valid(p.images) THEN p.images ELSE '[]' END) j
 WHERE CASE WHEN j.type='text' THEN length(trim(j.value))>0 WHEN j.type='object' THEN length(trim(COALESCE(json_extract(j.value,'$.url'),'')))>0 ELSE 0 END LIMIT 1) AS image,
 h.*,CASE WHEN h.variantCount=0 AND p.type='standard' THEN p.inventory_quantity ELSE NULL END AS simpleQuantity
 FROM candidates p JOIN health h ON h.productId=p.id
)`;
}
function row<T extends { updatedSeconds: number }>(value: T) {
  const { updatedSeconds, ...rest } = value;
  return { ...rest, updatedAt: new Date(updatedSeconds * 1000).toISOString() };
}
function conditions(v: CatalogueFilters) {
  const parts: SQL[] = [sql`1`];
  if (v.status) parts.push(sql`p.status=${v.status}`);
  if (v.category)
    parts.push(
      sql`EXISTS(SELECT 1 FROM _ecommerce_product_categories pc WHERE pc.product_id=p.id AND pc.category_id=${v.category})`,
    );
  if (v.search) {
    const q = v.search.toLowerCase();
    parts.push(
      sql`(instr(lower(p.name),${q})>0 OR instr(lower(p.slug),${q})>0 OR instr(lower(COALESCE(p.sku,'')),${q})>0 OR instr(lower(p.id),${q})>0 OR EXISTS(SELECT 1 FROM _ecommerce_product_variants g LEFT JOIN _ecommerce_product_variant_values v ON v.product_variant_id=g.id WHERE g.product_id=p.id AND (instr(lower(COALESCE(g.sku,'')),${q})>0 OR instr(lower(COALESCE(v.sku,'')),${q})>0 OR instr(lower(COALESCE(v.value,'')),${q})>0)))`,
    );
  }
  return and(...parts)!;
}
const attentionWhere = {
  all: sql`1`,
  images: sql`image IS NULL`,
  low: sql`lowCount>0`,
  out: sql`outCount>0`,
  price: sql`missingPrice>0`,
};
export async function readAdminCatalogue(
  env: TalismanEnv,
  input: unknown = {},
) {
  const v = filtersSchema.parse(input),
    db = commerceDb(env),
    cte = catalogueQuery(conditions(v), v.threshold),
    where = attentionWhere[v.attention];
  const [totals, categoryRows] = await db.batch([
    db.all<{
      all: number;
      images: number;
      low: number;
      out: number;
      price: number;
      total: number;
    }>(
      sql`${cte} SELECT COUNT(*) AS "all",COALESCE(SUM(image IS NULL),0) AS images,COALESCE(SUM(lowCount>0),0) AS low,COALESCE(SUM(outCount>0),0) AS out,COALESCE(SUM(missingPrice>0),0) AS price,COALESCE(SUM(CASE WHEN ${where} THEN 1 ELSE 0 END),0) AS total FROM catalogue`,
    ),
    db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .orderBy(categories.name)
      .limit(200),
  ]);
  const counts = totals[0],
    total = Number(counts.total),
    pages = Math.max(1, Math.ceil(total / 25)),
    page = Math.min(v.page, pages);
  const order =
    v.sort === "name"
      ? sql`lower(name),id`
      : v.sort === "price-asc"
        ? sql`basePrice,id`
        : v.sort === "price-desc"
          ? sql`basePrice DESC,id`
          : sql`updatedSeconds DESC,id`;
  const found = await db.all<CatalogueRow & { updatedSeconds: number }>(
    sql`${cte} SELECT * FROM catalogue WHERE ${where} ORDER BY ${order} LIMIT 25 OFFSET ${(page - 1) * 25}`,
  );
  return {
    rows: found.map(row),
    counts,
    total,
    page,
    pages,
    pageSize: 25,
    categories: categoryRows,
    filters: { ...v, page },
  };
}
const selectionSchema = z
  .object({
    ids: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export async function readCatalogueSelection(env: TalismanEnv, input: unknown) {
  const { ids } = selectionSchema.parse(input),
    cte = catalogueQuery(inArray(sql`p.id`, ids), 5);
  const found = await commerceDb(env).all<
    CatalogueRow & { updatedSeconds: number }
  >(sql`${cte} SELECT * FROM catalogue ORDER BY lower(name),id`);
  if (found.length !== ids.length)
    throw new CommerceOperationsConflict(
      "Some selected products are no longer available. Refresh the catalogue and review your selection.",
    );
  return { rows: found.map(row) };
}
const editSchema = z
  .object({
    requestKey: z.string().uuid(),
    collectionSlug: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(128)
      .default("products"),
    kind: z.enum(["price", "visibility"]),
    rows: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            expectedUpdatedAt: z.string().min(1).max(64),
            basePrice: z
              .number()
              .int()
              .min(1)
              .max(Number.MAX_SAFE_INTEGER)
              .optional(),
            status: z.enum(["draft", "active", "archived"]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length),
  })
  .strict()
  .refine(
    (v) =>
      v.rows.every((r) =>
        v.kind === "price"
          ? r.basePrice !== undefined && r.status === undefined
          : r.status !== undefined && r.basePrice === undefined,
      ),
    "Choose a price or visibility for every product",
  );
/** Freeze absolute assignments in the reviewed request. Replaying cannot compound a percentage.
 * Each field assignment is idempotent; all actual changes share one optimistic D1 transaction. */
export async function updateCatalogue(
  env: TalismanEnv,
  input: unknown,
  _actor: string,
) {
  const v = editSchema.parse(input),
    db = commerceDb(env),
    now = Math.floor(Date.now() / 1000);
  const current = await db
    .select()
    .from(products)
    .where(
      inArray(
        products.id,
        v.rows.map((r) => r.id),
      ),
    );
  if (current.length !== v.rows.length)
    throw new CommerceOperationsConflict(
      "Some selected products were removed. Refresh the catalogue before saving.",
    );
  const changed = v.rows.filter((r) => {
    const p = current.find((p) => p.id === r.id)!;
    return v.kind === "price"
      ? p.basePrice !== r.basePrice
      : p.status !== r.status;
  });
  const statements: BatchItem<"sqlite">[] = [];
  for (const item of changed) {
    const seconds = Date.parse(item.expectedUpdatedAt) / 1000;
    if (!Number.isSafeInteger(seconds))
      throw new CommerceOperationsConflict(
        "A product version is invalid. Refresh the catalogue before saving.",
      );
    statements.push(
      db.get(
        sql`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_products WHERE id=${item.id} AND updated_at=${seconds}) THEN json_extract('{}','$catalog_stale') END AS conflict`,
      ),
    );
    statements.push(
      db
        .update(products)
        .set({
          ...(v.kind === "price"
            ? { basePrice: item.basePrice! }
            : { status: item.status! }),
          updatedAt: sql`MAX(${products.updatedAt}+1,${now})`,
        })
        .where(eq(products.id, item.id)),
    );
  }
  try {
    if (statements.length)
      await db.batch(
        statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
      );
  } catch (error) {
    if (errorText(error).includes("catalog_stale"))
      throw new CommerceOperationsConflict(
        "Products changed after your review. Reload the selected products and review the changes again.",
      );
    throw error;
  }
  try {
    await invalidateEntryCache(
      env,
      v.collectionSlug,
      v.rows.map((r) => r.id),
    );
  } catch {
    console.warn(
      "[commerce:catalogue] Could not clear product cache after saving.",
    );
  }
  return { batchId: v.requestKey, count: v.rows.length };
}
