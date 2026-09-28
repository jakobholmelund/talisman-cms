import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getTableName, is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import * as schema from '../dist/schema.js';
import { T, applyAllMigrations, openDatabase } from './helpers/migrations.mjs';

const { readCatalog } = await import('../dist/catalog.js');

// The schema's `relations` (defineRelations) give the relational query builder to the plugin and to
// a site's `createDbClient(env, relations)`. These tests pin that every foreign key is covered and
// that the nested reads the plugin makes come back in shape.

/** The D1 interface over an in-memory database, as the D1 driver and `db.batch()` use it. */
function database() {
  const sqlite = openDatabase();
  applyAllMigrations(sqlite);
  const DB = {
    prepare(sql) {
      const prepared = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async all() { return { results: prepared.all(...values) }; },
        async first() { return prepared.get(...values) ?? null; },
        async raw() { const raw = sqlite.prepare(sql); raw.setReturnArrays(true); return raw.all(...values); },
        async run() { return { meta: prepared.run(...values) }; },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.all());
      return results;
    },
  };
  return { sqlite, DB };
}

/** Two products: a frame with a lens group of two values, one with stock and a bill of materials; and a bare case. */
function seedCatalog(sqlite) {
  sqlite.exec(`
    INSERT INTO _ecommerce_categories (id, name, slug, created_at, updated_at) VALUES ('eyewear', 'Eyewear', 'eyewear', ${T}, ${T});
    INSERT INTO _ecommerce_categories (id, name, slug, parent_id, created_at, updated_at) VALUES ('frames', 'Frames', 'frames', 'eyewear', ${T}, ${T});
    INSERT INTO _ecommerce_tags (id, name, created_at, updated_at) VALUES ('new', 'New', ${T}, ${T});
    INSERT INTO _ecommerce_products (id, name, slug, sku, base_price, status, created_at, updated_at)
      VALUES ('frame', 'Mycelium frame', 'frame', 'TAL-FRAME', 12000, 'active', ${T}, ${T});
    INSERT INTO _ecommerce_products (id, name, slug, sku, base_price, status, created_at, updated_at)
      VALUES ('case', 'Travel case', 'case', 'TAL-CASE', 2000, 'draft', ${T + 1}, ${T + 1});
    INSERT INTO _ecommerce_product_categories (product_id, category_id) VALUES ('frame', 'frames'), ('frame', 'eyewear');
    INSERT INTO _ecommerce_product_tags (product_id, tag_id) VALUES ('frame', 'new');
    INSERT INTO _ecommerce_variants (id, name, created_at, updated_at) VALUES ('def-lens', 'Lens', ${T}, ${T});
    INSERT INTO _ecommerce_product_variants (id, product_id, variant_id, name, sku, created_at, updated_at)
      VALUES ('frame-lens', 'frame', 'def-lens', 'Lens choice', 'TAL-FRAME-LENS', ${T}, ${T});
    INSERT INTO _ecommerce_product_variants (id, product_id, name, created_at, updated_at) VALUES ('frame-legacy', 'frame', 'Legacy group', ${T + 1}, ${T + 1});
    INSERT INTO _ecommerce_product_variant_values (id, product_variant_id, value, sku, image, created_at, updated_at)
      VALUES ('frame-amber', 'frame-lens', 'Amber', 'TAL-FRAME-AMB', '/amber.webp', ${T}, ${T});
    INSERT INTO _ecommerce_product_variant_values (id, product_variant_id, value, created_at, updated_at)
      VALUES ('frame-smoke', 'frame-lens', 'Smoke', ${T + 1}, ${T + 1});
    INSERT INTO _ecommerce_stocks (id, product_variant_value_id, quantity, created_at, updated_at) VALUES ('amber-stock', 'frame-amber', 7, ${T}, ${T});
    INSERT INTO _ecommerce_components (id, sku, name, quantity, created_at, updated_at) VALUES ('hinge', 'C-HINGE', 'Hinge', 20, ${T}, ${T}), ('lens', 'C-LENS', 'Amber lens', 4, ${T}, ${T});
    INSERT INTO _ecommerce_variant_components (id, product_variant_value_id, component_id, quantity, created_at, updated_at)
      VALUES ('vc-lens', 'frame-amber', 'lens', 2, ${T}, ${T}), ('vc-hinge', 'frame-amber', 'hinge', 1, ${T}, ${T});
  `);
}

test('every foreign key of the commerce schema has a relation in the same direction', () => {
  const tables = Object.values(schema).filter((value) => is(value, SQLiteTable));
  assert.equal(Object.keys(schema.relations).length, tables.length + 1, 'every table and the CMS user table are in the relations');
  const missing = [];
  for (const [name, entry] of Object.entries(schema.relations)) {
    for (const key of getTableConfig(entry.table).foreignKeys) {
      const { columns, foreignTable, foreignColumns } = key.reference();
      const covered = Object.values(entry.relations).some((relation) =>
        relation.targetTable === foreignTable && relation.sourceColumns?.length === columns.length
        && relation.sourceColumns.every((column, index) => column === columns[index])
        && relation.targetColumns.every((column, index) => column === foreignColumns[index]));
      if (!covered) missing.push(`${name}.${columns.map((column) => column.name).join(', ')} -> ${getTableName(foreignTable)}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('readCatalog nests each product with its groups, values, stock, bill of materials, categories and tags', async () => {
  const { sqlite, DB } = database();
  seedCatalog(sqlite);
  const [frame, travelCase] = await readCatalog({ DB });
  assert.deepEqual([frame.id, travelCase.id], ['frame', 'case'], 'oldest product first');
  assert.deepEqual(frame.categories.map((category) => category.name), ['Eyewear', 'Frames'], 'categories, not junction rows');
  assert.deepEqual(frame.tags.map((tag) => tag.name), ['New']);
  assert.deepEqual(frame.variants.map((group) => [group.id, group.variant?.name ?? null, group.values.map((value) => value.id)]),
    [['frame-lens', 'Lens', ['frame-amber', 'frame-smoke']], ['frame-legacy', null, []]]);
  const [amber, smoke] = frame.variants[0].values;
  assert.deepEqual([amber.stock?.quantity, smoke.stock], [7, null]);
  assert.deepEqual(amber.requirements.map((requirement) => [requirement.component.name, requirement.quantity]),
    [['Hinge', 1], ['Amber lens', 2]], 'in component id order');
  assert.ok(amber.createdAt instanceof Date, 'timestamps map to Dates as in the select builder');
  assert.deepEqual([travelCase.variants, travelCase.categories, travelCase.tags], [[], [], []]);
  assert.deepEqual((await readCatalog({ DB }, { status: ['active'] })).map((product) => product.id), ['frame']);
});

test('a site gets db.query for the commerce tables from the exported relations', async () => {
  const { sqlite, DB } = database();
  seedCatalog(sqlite);
  const db = drizzle(DB, { relations: schema.relations });
  const groups = await db.query.productVariants.findMany({ columns: { id: true }, where: { values: true } });
  assert.deepEqual(groups, [{ id: 'frame-lens' }], 'a relation in where is an EXISTS filter');
  const [child] = await db.query.categories.findMany({ where: { parentId: { isNotNull: true } }, with: { parent: true, children: true, products: true } });
  assert.deepEqual([child.parent.id, child.children, child.products.map((product) => product.id)], ['eyewear', [], ['frame']]);
  const [first, second] = await db.batch([
    db.query.components.findMany({ columns: { id: true }, with: { requirements: { columns: { quantity: true } } } }),
    db.query.products.findFirst({ columns: { name: true }, where: { id: 'case' } }),
  ]);
  assert.deepEqual(first, [{ id: 'hinge', requirements: [{ quantity: 1 }] }, { id: 'lens', requirements: [{ quantity: 2 }] }]);
  assert.deepEqual(second, { name: 'Travel case' });
});
