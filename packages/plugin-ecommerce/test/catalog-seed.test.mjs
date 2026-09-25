import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { commerceContentCollection, createCommerceCatalogSeedSql } from '../dist/catalog.js';

test('catalog import exposes content in Commerce and preserves later edits', () => {
  const collection = commerceContentCollection({
    name: 'Frame Stories', slug: 'frame-stories', fields: [{ name: 'story', label: 'Story', type: 'textarea' }]
  });
  assert.equal(collection.adminSection, 'commerce');

  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE _ecommerce_products (id TEXT PRIMARY KEY, name TEXT, slug TEXT, sku TEXT, description TEXT, images TEXT, category_ids TEXT, tag_ids TEXT, base_price INTEGER, inventory_quantity INTEGER, is_physical INTEGER, type TEXT, status TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE galaxy_collections (id TEXT PRIMARY KEY, name TEXT, slug TEXT UNIQUE, description TEXT, fields TEXT, created_at INTEGER);
    CREATE TABLE galaxy_entries (id TEXT PRIMARY KEY, collection_id TEXT, slug TEXT, status TEXT, data TEXT, published_data TEXT, created_at INTEGER, updated_at INTEGER, published_at INTEGER);
  `);
  const sql = createCommerceCatalogSeedSql({
    products: [{ id: 'frame-01', name: "Maker's frame", slug: 'frame-01', images: ['/frame.jpg'] }],
    content: [{
      collection: { name: collection.name, slug: collection.slug },
      entries: [{ id: 'story-01', slug: 'frame-01', data: { slug: 'frame-01', story: "Maker's story" } }]
    }]
  });
  db.exec(sql);
  assert.equal(db.prepare('SELECT name FROM _ecommerce_products').get().name, "Maker's frame");
  assert.equal(JSON.parse(db.prepare('SELECT data FROM galaxy_entries').get().data).story, "Maker's story");

  db.exec("UPDATE _ecommerce_products SET name = 'Edited in admin'");
  db.exec("UPDATE galaxy_entries SET data = '{\"slug\":\"frame-01\",\"story\":\"Edited in admin\"}'");
  db.exec(sql);
  assert.equal(db.prepare('SELECT name FROM _ecommerce_products').get().name, 'Edited in admin');
  assert.equal(JSON.parse(db.prepare('SELECT data FROM galaxy_entries').get().data).story, 'Edited in admin');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM galaxy_entries').get().count, 1);
  db.close();
});
