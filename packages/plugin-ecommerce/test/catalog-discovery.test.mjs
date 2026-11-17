import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { applyAllMigrations } from './helpers/migrations.mjs';
import { searchCatalog, readCatalog, catalogOffer, createCommerceCatalogSeedSql } from '../dist/catalog.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON'); applyAllMigrations(sqlite);
  const DB = { prepare(query) {
    const statement = sqlite.prepare(query); let values = [];
    return { bind(...params) { assert.ok(params.length <= 100); values = params; return this; },
      async all() { return { results: statement.all(...values) }; },
      async raw() { const raw = sqlite.prepare(query); raw.setReturnArrays(true); return raw.all(...values); },
      async first() { return statement.get(...values); }, async run() { return { meta: statement.run(...values) }; } };
  }, async batch(statements) { return Promise.all(statements.map(statement => statement.all())); } };
  const products = Array.from({ length: 60 }, (_, index) => ({ id: `p${String(index).padStart(2, '0')}`, name: `Object ${String(index).padStart(2, '0')}`, slug: `object-${index}`, basePrice: 1000 + index, inventoryQuantity: index % 2, status: 'active' }));
  sqlite.exec(createCommerceCatalogSeedSql({ products: [
    ...products,
    { id: 'draft', name: 'Unreleased secret', slug: 'draft', basePrice: 100, status: 'draft', categoryIds: ['private'] },
    { id: 'digital', name: 'Digital guide', slug: 'digital', basePrice: 400, type: 'digital', status: 'active' },
    { id: 'frame', name: "Maker's frame", slug: 'frame', basePrice: 50000, inventoryQuantity: 0, status: 'active', categoryIds: ['frames'] },
    { id: 'legacy', name: 'Legacy choice', slug: 'legacy', basePrice: 10000, status: 'active' },
  ], categories: [{ id: 'frames', name: 'Frames', slug: 'frames' }, { id: 'private', name: 'Unpublished category', slug: 'private' }],
  productVariants: [{ id: 'g', productId: 'frame', name: 'Lens', priceOverride: 2000, inventoryQuantity: 10 }, { id: 'legacy-g', productId: 'legacy', name: 'Small', priceOverride: 700, inventoryQuantity: 3 }],
  variantValues: [{ id: 'v', productVariantId: 'g', value: 'Amber', sku: 'FRAME-UNIQUE', priceOverride: 900 }, { id: 'v2', productVariantId: 'g', value: 'Smoke', priceOverride: 1500 }],
  components: [{ id: 'c', sku: 'COMPONENT', name: 'Frame stock', quantity: 4 }],
  variantComponents: [{ id: 'r', productVariantValueId: 'v', componentId: 'c', quantity: 2 }],
  }));
  sqlite.exec("INSERT INTO _ecommerce_stocks(id,product_variant_value_id,quantity,created_at,updated_at) VALUES ('s','v',0,1,1), ('s2','v2',0,1,1)");
  return { sqlite, env: { DB } };
}

test('catalog search filters the complete catalog before stable pagination and excludes drafts and their facets', async () => {
  const { sqlite, env } = fixture();
  try {
    const first = await searchCatalog(env, { sort: 'name', pageSize: 24 });
    const second = await searchCatalog(env, { sort: 'name', pageSize: 24, page: 2 });
    const third = await searchCatalog(env, { sort: 'name', pageSize: 24, page: 3 });
    assert.equal(first.total, 63); assert.equal(third.products.length, 15);
    assert.equal(new Set([...first.products, ...second.products, ...third.products].map(product => product.id)).size, 63);
    assert.deepEqual(first.categories.map(category => category.id), ['frames']);
    assert.equal((await searchCatalog(env, { query: 'Object 59' })).products[0].id, 'p59');
    assert.equal((await searchCatalog(env, { query: 'frame-unique' })).products[0].id, 'frame');
    assert.equal((await searchCatalog(env, { query: "Maker's" })).total, 1);
    assert.equal((await searchCatalog(env, { query: "%' OR 1=1 --" })).total, 0);
    assert.equal((await searchCatalog(env, { query: '%' })).total, 0, 'wildcard characters are literal');
    assert.equal((await searchCatalog(env, { query: 'secret' })).total, 0);
    assert.equal((await searchCatalog(env, { page: 1001 })).page, 3, 'stale page numbers clamp to the last page without an arbitrary catalog cap');
    await assert.rejects(searchCatalog(env, { page: Infinity }));
    await assert.rejects(searchCatalog(env, { page: Number.MAX_SAFE_INTEGER + 1 }));
    await assert.rejects(searchCatalog(env, { pageSize: 81 }));
    await assert.rejects(searchCatalog(env, { sort: 'unsafe' }));
  } finally { sqlite.close(); }
});

test('price sorting uses purchasable variant prices and handles legacy groups', async () => {
  const { sqlite, env } = fixture();
  try {
    const low = await searchCatalog(env, { sort: 'price-asc' });
    assert.deepEqual(low.products.slice(0, 3).map(product => product.id), ['digital', 'legacy', 'frame']);
    const high = await searchCatalog(env, { sort: 'price-desc' });
    assert.equal(high.products[0].id, 'p59');
    const frame = (await searchCatalog(env, { category: 'frames' })).products[0];
    const offer = catalogOffer(frame);
    assert.deepEqual([offer.minPrice, offer.maxPrice, offer.selected.id, offer.selected.quantity], [900, 1500, 'v', 2]);
    assert.equal(offer.available, true, 'components override zero finished stock');
    assert.equal(offer.options.find(option => option.id === 'v2').quantity, 0, 'explicit zero stock overrides group stock');
    sqlite.exec("UPDATE _ecommerce_product_variant_values SET price_override=0 WHERE id='v2'");
    const updated = catalogOffer((await readCatalog(env, { ids: ['frame'] }))[0]);
    assert.deepEqual([updated.minPrice, updated.maxPrice, updated.available], [900, 900, true]);
  } finally { sqlite.close(); }
});

test('stock facets agree with offer data for shared components, digital, legacy, and zero-price choices', async () => {
  const { sqlite, env } = fixture();
  try {
    const check = async () => {
      const all = await searchCatalog(env, { pageSize: 80 });
      const inStock = await searchCatalog(env, { inStock: true, pageSize: 80 });
      assert.deepEqual(inStock.products.map(product => product.id).sort(), all.products.filter(product => catalogOffer(product).available).map(product => product.id).sort());
    };
    await check();
    sqlite.exec("UPDATE _ecommerce_components SET quantity=1 WHERE id='c'");
    await check();
    assert.equal((await searchCatalog(env, { category: 'frames', inStock: true })).total, 0);
    assert.equal((await searchCatalog(env, { type: 'digital', inStock: true })).total, 1);
    sqlite.exec("UPDATE _ecommerce_product_variant_values SET price_override=0 WHERE id='v'; UPDATE _ecommerce_stocks SET quantity=2 WHERE id='s2'; UPDATE _ecommerce_products SET base_price=0 WHERE id='digital'");
    await check();
    assert.equal((await searchCatalog(env, { category: 'frames', inStock: true })).total, 1);
    assert.equal((await searchCatalog(env, { type: 'digital', inStock: true })).total, 0);
  } finally { sqlite.close(); }
});
