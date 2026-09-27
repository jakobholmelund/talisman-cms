import assert from 'node:assert/strict';
import test from 'node:test';
import { call, database, doc, getClient, hourAgo, runtime, skip } from './helpers/handler-harness.mjs';

let errors;
if (!skip) errors = await import('../src/service/errors.ts');

const collectionStatements = () => runtime.env.DB.statements.filter((sql) => /galaxy_collections/i.test(sql));

test('collection rows are synced once per database and never looked up again', { skip }, async () => {
  const sqlite = database();
  try {
    const { statements } = runtime.env.DB;
    // The first request reads the table once and creates the configured rows in one batch.
    assert.equal((await call('GET', '/collections/posts/entries')).status, 200);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM galaxy_collections').get().total, runtime.collections.length);
    assert.equal(collectionStatements().filter((sql) => /^\s*select/i.test(sql)).length, 2, 'one read before the writes, one after');

    // Every later request, on any collection and for either caller, takes its row from the memo.
    statements.length = 0;
    assert.equal((await call('GET', '/collections/parts/entries')).status, 200);
    assert.equal((await call('POST', '/collections/posts/entries', { data: { title: 'T', body: doc('B') } })).status, 201);
    assert.equal((await call('GET', '/collections/tags/entries/missing')).status, 404);
    assert.equal((await call('GET', '/collections')).status, 200);
    const client = getClient(runtime.env);
    assert.equal((await client.entries.findMany('posts', { depth: 0, cache: false, version: 'draft' })).length, 1);
    assert.equal((await client.collections.findMany({ cache: false })).length, runtime.collections.length);
    assert.deepEqual(collectionStatements().filter((sql) => !/^\s*select .* from "galaxy_collections"( "collections")?\s*$/i.test(sql)), [],
      'only the list route reads the whole table, and nothing writes it');
    assert.equal(statements.filter((sql) => /^\s*select/i.test(sql) && /galaxy_collections/i.test(sql) && /where/i.test(sql)).length, 0,
      'no request looks one row up');
  } finally {
    sqlite.close();
  }
});

test('a collection stored without being configured is looked up once, and an unknown one is refused', { skip }, async () => {
  const sqlite = database();
  try {
    assert.equal((await call('GET', '/collections')).status, 200);
    sqlite.prepare(`INSERT INTO galaxy_collections (id, name, slug, fields, created_at) VALUES ('archive-id', 'Archive', 'archive', '[]', ?)`).run(hourAgo);
    sqlite.prepare(`INSERT INTO galaxy_entries (id, collection_id, slug, status, data, published_data, created_at, updated_at)
      VALUES ('old', 'archive-id', 'old', 'published', '{"title":"Old"}', '{"title":"Old"}', ?, ?)`).run(hourAgo, hourAgo);
    const { statements } = runtime.env.DB;
    const client = getClient(runtime.env);

    statements.length = 0;
    assert.deepEqual((await client.entries.findMany('archive', { depth: 0, cache: false })).map((entry) => entry.id), ['old']);
    assert.equal(collectionStatements().length, 1, 'the miss is looked up once');
    statements.length = 0;
    assert.equal((await client.entries.find('archive', 'old', { depth: 0, cache: false })).data.title, 'Old');
    assert.deepEqual(collectionStatements(), [], 'and then remembered');

    await assert.rejects(client.entries.findMany('nope', { cache: false }), (error) =>
      error instanceof errors.NotFoundError && error.message === 'Collection nope not found');
    // The admin API only serves configured collections, stored or not.
    assert.equal((await call('GET', '/collections/archive/entries')).status, 404);
    assert.equal((await call('GET', '/collections/nope/entries')).status, 404);
  } finally {
    sqlite.close();
  }
});

test('reads of a native collection without configured fields leave the memoized row alone', { skip }, async () => {
  const sqlite = database();
  try {
    runtime.collections.push({
      name: 'Bare parts', slug: 'bare-parts', fields: [],
      nativeSchemaMapping: { schemaPath: 'test', exportName: 'parts', idColumn: 'id' },
    });
    runtime.nativeSchemas['bare-parts'] = runtime.nativeSchemas.parts;
    sqlite.prepare('INSERT INTO test_parts (id, name, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('bolt', 'Bolt', 3, hourAgo, hourAgo);
    const client = getClient(runtime.env);
    const [part] = await client.entries.findMany('bare-parts', { cache: false });
    assert.equal(part.data.name, 'Bolt');
    // The sync stored the generated fields, and the read did not replace them on the shared row.
    const stored = JSON.parse(sqlite.prepare(`SELECT fields FROM galaxy_collections WHERE slug = 'bare-parts'`).get().fields);
    assert.ok(stored.some((field) => field.name === 'quantity'));
    const listed = await call('GET', '/collections');
    assert.ok(listed.body.find((collection) => collection.slug === 'bare-parts').fields.some((field) => field.name === 'quantity'));
  } finally {
    runtime.collections.pop();
    delete runtime.nativeSchemas['bare-parts'];
    sqlite.close();
  }
});
