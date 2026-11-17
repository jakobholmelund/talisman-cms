import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb } from './db';

const inputSchema = z.object({
  view: z.enum(['choices', 'components']).default('choices'),
  threshold: z.coerce.number().int().min(0).max(1000000).default(5),
  filter: z.enum(['low', 'unavailable', 'all']).default('low'),
  search: z.string().trim().max(100).default(''),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
export type StockOverviewRow = { id: string; kind: 'product' | 'variant' | 'value' | 'component';
  productId: string | null; name: string; sku: string | null; quantity: number; source: string; targetType: 'product' | 'variant' | 'stock' | 'component' | null; targetId: string | null };

/** Sellable stock matches basket.ts: parts take precedence; a value without a stock row falls back
 * to its group's quantity. Digital/subscription products do not consume stock. Held checkout units
 * have already been deducted. Each component-backed choice is a maximum, not independent supply. */
const choices = sql`WITH inventory AS (
  SELECT p.id, 'product' AS kind, p.id AS productId, p.name, p.sku, p.inventory_quantity AS quantity, 'Product' AS source, 'product' AS targetType, p.id AS targetId
    FROM _ecommerce_products p WHERE p.status = 'active' AND p.type = 'standard'
      AND NOT EXISTS (SELECT 1 FROM _ecommerce_product_variants g WHERE g.product_id = p.id)
  UNION ALL
  SELECT g.id, 'variant', p.id, p.name || ' / ' || g.name, g.sku, g.inventory_quantity, 'Option group', 'variant', g.id
    FROM _ecommerce_product_variants g JOIN _ecommerce_products p ON p.id = g.product_id
    WHERE p.status = 'active' AND p.type = 'standard'
      AND NOT EXISTS (SELECT 1 FROM _ecommerce_product_variant_values v WHERE v.product_variant_id = g.id)
  UNION ALL
  SELECT v.id, 'value', p.id, p.name || ' / ' || g.name || ' / ' || v.value, v.sku,
    CASE WHEN EXISTS (SELECT 1 FROM _ecommerce_variant_components r WHERE r.product_variant_value_id = v.id)
      THEN (SELECT min(c.quantity / r.quantity) FROM _ecommerce_variant_components r
        JOIN _ecommerce_components c ON c.id = r.component_id WHERE r.product_variant_value_id = v.id)
      ELSE COALESCE(s.quantity, g.inventory_quantity) END,
    CASE WHEN EXISTS (SELECT 1 FROM _ecommerce_variant_components r WHERE r.product_variant_value_id = v.id)
      THEN 'Shared components' WHEN s.id IS NOT NULL THEN 'Choice stock' ELSE 'Option group' END,
    CASE WHEN EXISTS (SELECT 1 FROM _ecommerce_variant_components r WHERE r.product_variant_value_id = v.id) THEN NULL WHEN s.id IS NOT NULL THEN 'stock' ELSE 'variant' END,
    CASE WHEN EXISTS (SELECT 1 FROM _ecommerce_variant_components r WHERE r.product_variant_value_id = v.id) THEN NULL ELSE COALESCE(s.id, g.id) END
    FROM _ecommerce_product_variant_values v JOIN _ecommerce_product_variants g ON g.id = v.product_variant_id
      JOIN _ecommerce_products p ON p.id = g.product_id
      LEFT JOIN _ecommerce_stocks s ON s.product_variant_value_id = v.id
    WHERE p.status = 'active' AND p.type = 'standard'
)`;
const parts = sql`WITH inventory AS (SELECT id, 'component' AS kind, NULL AS productId, name, sku, quantity,
  'Shared component' AS source, 'component' AS targetType, id AS targetId FROM _ecommerce_components)`;

/** Filtering and pagination happen after effective quantities are computed, so low stock beyond
 * the first catalog page remains discoverable. Bound search treats SQL wildcard characters literally. */
export async function readStockOverview(env: TalismanEnv, input: unknown = {}) {
  const values = inputSchema.parse(input);
  const cte = values.view === 'components' ? parts : choices;
  const pattern = `%${values.search.replace(/[\\%_]/g, character => `\\${character}`)}%`;
  const filtered = sql`(name LIKE ${pattern} ESCAPE '\\' OR COALESCE(sku, '') LIKE ${pattern} ESCAPE '\\')
    AND ${values.filter === 'all' ? sql`1` : values.filter === 'unavailable' ? sql`quantity = 0` : sql`quantity <= ${values.threshold}`}`;
  const db = commerceDb(env);
  const [rows, counted] = await db.batch([
    db.all<StockOverviewRow>(sql`${cte} SELECT * FROM inventory WHERE ${filtered}
      ORDER BY quantity, name, kind, id LIMIT 50 OFFSET ${values.offset}`),
    db.all<{ count: number }>(sql`${cte} SELECT count(*) AS count FROM inventory WHERE ${filtered}`),
  ]);
  return { rows, total: Number(counted[0]?.count ?? 0), ...values };
}
