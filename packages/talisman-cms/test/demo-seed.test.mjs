import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { applyAllMigrations, openDatabase } from '../../plugin-ecommerce/test/helpers/migrations.mjs';

const seed = readFileSync(new URL('../seeds/ecommerce-demo.sql', import.meta.url), 'utf8');
test('published demo seed uses seconds and preserves existing collection definitions on repeat runs', () => {
  const db = openDatabase();
  try {
    applyAllMigrations(db);
    db.exec(seed);
    const now = Math.floor(Date.now() / 1000);
    for (const table of ['galaxy_collections', 'galaxy_entries', '_ecommerce_products', '_ecommerce_categories']) {
      const times = db.prepare(`SELECT created_at FROM ${table}`).all();
      assert.ok(times.length);
      for (const row of times) assert.ok(Math.abs(row.created_at - now) < 30, `${table}: ${row.created_at}`);
    }
    db.exec(`UPDATE galaxy_collections SET name = 'Custom posts', fields = '[{"name":"custom","type":"text"}]' WHERE slug = 'posts'`);
    db.exec(seed);
    assert.deepEqual({ ...db.prepare("SELECT name,fields FROM galaxy_collections WHERE slug = 'posts'").get() }, { name: 'Custom posts', fields: '[{"name":"custom","type":"text"}]' });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM galaxy_entries').get().n, 5);
    assert.equal(db.prepare("SELECT json_extract(data, '$.title') title FROM galaxy_entries WHERE id = 'demo_managed_note'").get().title, 'Server-managed note');
  } finally { db.close(); }
});
