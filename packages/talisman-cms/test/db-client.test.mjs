import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineRelations } from 'drizzle-orm';
import { createDbClient } from '../dist/client.js';
import { collections, entries } from '../dist/db/schema.js';
import { T, applyCoreMigrations, openDatabase } from './helpers/migrations.mjs';

/** The D1 interface over an in-memory database, as the D1 driver uses it. */
function database() {
  const sqlite = openDatabase();
  applyCoreMigrations(sqlite);
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
  sqlite.exec(`INSERT INTO galaxy_collections (id, name, slug, fields, created_at) VALUES ('col', 'Posts', 'posts', '[]', ${T});
    INSERT INTO galaxy_entries (id, collection_id, slug, status, data, created_at, updated_at) VALUES ('e1', 'col', 'hello', 'published', '{}', ${T}, ${T})`);
  return { sqlite, DB };
}

test('createDbClient needs the DB binding and gives the select builder without relations', async () => {
  assert.throws(() => createDbClient({}), /D1 database bound to the "DB"/);
  const { DB } = database();
  const db = createDbClient({ DB });
  assert.deepEqual(Object.keys(db.query), [], 'no relational query builder without relations');
  assert.deepEqual(await db.select({ slug: entries.slug }).from(entries).all(), [{ slug: 'hello' }]);
});

test('createDbClient with relations gives db.query for the tables they cover', async () => {
  const { DB } = database();
  const relations = defineRelations({ collections, entries }, (r) => ({
    collections: { entries: r.many.entries() },
    entries: { collection: r.one.collections({ from: r.entries.collectionId, to: r.collections.id, optional: false }) },
  }));
  const db = createDbClient({ DB }, relations);
  assert.deepEqual(Object.keys(db.query), ['collections', 'entries']);
  const [entry] = await db.query.entries.findMany({ columns: { slug: true }, with: { collection: { columns: { slug: true } } } });
  assert.deepEqual(entry, { slug: 'hello', collection: { slug: 'posts' } });
  const [collection] = await db.query.collections.findMany({ columns: { slug: true }, with: { entries: { columns: { id: true } } } });
  assert.deepEqual(collection, { slug: 'posts', entries: [{ id: 'e1' }] });
});
