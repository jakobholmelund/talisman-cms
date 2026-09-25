import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The API handler ships as source and imports Astro virtual modules, so this file loads it with
// Node's type stripping and stands in for the virtual modules and `cloudflare:workers`.
const canLoadSource = Boolean(process.features.typescript) && typeof registerHooks === 'function';
const skip = canLoadSource ? false : 'needs Node type stripping and module.registerHooks';

const runtime = globalThis.__talismanHandlerTest = {
  env: {},
  user: { id: 'admin-1', email: 'admin@example.test', role: 'admin' },
  collections: [],
  globals: [],
  nativeSchemas: {},
  collectionHooks: {},
};
const stubs = {
  'cloudflare:workers': 'export const env = new Proxy({}, { get: (_, key) => globalThis.__talismanHandlerTest.env[key] });',
  'virtual:talisman-cms/auth': 'export const authConfigured = true; export const authAdapter = { async getUser() { return globalThis.__talismanHandlerTest.user; } };',
  'virtual:talisman-cms/config': 'const t = globalThis.__talismanHandlerTest; export const adminPath = "/admin"; export const collections = t.collections; export const globals = t.globals; export const uiLibraries = []; export const publishing = { workflowBinding: "TALISMAN_PUBLISH_WORKFLOW" };',
  'virtual:talisman-cms/ui-libraries': 'export const uiLibraries = [];',
  'virtual:talisman-cms/native-schemas': 'export const nativeSchemas = globalThis.__talismanHandlerTest.nativeSchemas; export const nativeSchemaConfig = {};',
  'virtual:talisman-cms/collection-hooks': 'export const collectionHooks = globalThis.__talismanHandlerTest.collectionHooks;',
};
const srcUrl = new URL('../src/', import.meta.url).href;

let ALL;
let types;
if (canLoadSource) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (Object.hasOwn(stubs, specifier)) {
        return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
      }
      if (context.parentURL?.startsWith(srcUrl) && specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      return nextResolve(specifier, context);
    },
  });
  ({ ALL } = await import('../src/api/handler.ts'));
  types = await import('../src/types.ts');
}

const parts = sqliteTable('test_parts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  quantity: integer('quantity').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

runtime.collections.push(
  {
    name: 'Posts',
    slug: 'posts',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'body', label: 'Body', type: 'richtext', required: true },
      { name: 'summary', label: 'Summary', type: 'textarea' },
    ],
  },
  {
    name: 'Parts',
    slug: 'parts',
    fields: [
      { name: 'id', label: 'ID', type: 'text', required: true },
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'quantity', label: 'Quantity', type: 'number', required: true },
    ],
    nativeSchemaMapping: { schemaPath: 'test', exportName: 'parts', idColumn: 'id' },
  },
);
runtime.globals.push({ name: 'Site', slug: 'site', fields: [{ name: 'siteName', label: 'Site name', type: 'text', required: true }] });
runtime.nativeSchemas.parts = parts;

const hourAgo = Math.floor(Date.now() / 1000) - 3600;
const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of ['0000_skinny_odin', '0001_abandoned_shotgun', '0002_flowery_midnight',
    '0003_content_versioning', '0018_entry_revision_integrity', '0020_revision_baseline_and_globals']) {
    const sql = readFileSync(new URL(`../drizzle/${migration}.sql`, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  sqlite.exec(`CREATE TABLE test_parts (id text PRIMARY KEY NOT NULL, name text NOT NULL, quantity integer NOT NULL,
    created_at integer NOT NULL, updated_at integer NOT NULL)`);
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async all() { return { results: statement.all(...values) }; },
        async raw() {
          const raw = sqlite.prepare(sql);
          raw.setReturnArrays(true);
          return raw.all(...values);
        },
        async run() { return { meta: statement.run(...values) }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  runtime.env = { DB };
  return sqlite;
}

async function call(method, path, body) {
  const request = new Request(`https://cms.test/admin/api${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await ALL({ request, locals: {} });
  return { status: response.status, body: await response.json() };
}

async function seedPost(sqlite, id, data, status = 'published') {
  // Resolving the collection once creates its row, as the admin does on first load.
  await call('GET', '/collections/posts/entries');
  const { id: collectionId } = sqlite.prepare(`SELECT id FROM galaxy_collections WHERE slug = 'posts'`).get();
  sqlite.prepare(`INSERT INTO galaxy_entries (id, collection_id, slug, status, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, collectionId, id, status, JSON.stringify(data), hourAgo, hourAgo);
}

const revisionCount = (sqlite, entryId) =>
  sqlite.prepare('SELECT COUNT(*) AS total FROM galaxy_entry_revisions WHERE entry_id = ?').get(entryId).total;

test('entries seeded without revisions can be saved; entries with revisions still need the latest id', { skip }, async () => {
  const sqlite = database();
  try {
    await seedPost(sqlite, 'seeded', { title: 'Seeded', body: doc('Hello') });
    const loaded = await call('GET', '/collections/posts/entries/seeded');
    assert.equal(loaded.body.latestRevisionId, null);

    const saved = await call('PUT', '/collections/posts/entries/seeded', {
      data: { title: 'Edited', body: doc('Hello') }, expectedRevisionId: loaded.body.latestRevisionId,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.publishedData, { title: 'Seeded', body: doc('Hello') });
    assert.equal(revisionCount(sqlite, 'seeded'), 2);

    const missing = await call('PUT', '/collections/posts/entries/seeded', { data: { title: 'No id', body: doc('Hello') } });
    assert.equal(missing.status, 428);
    const staleNull = await call('PUT', '/collections/posts/entries/seeded', { data: { title: 'Stale', body: doc('Hello') }, expectedRevisionId: null });
    assert.equal(staleNull.status, 409);
    assert.equal(staleNull.body.error, 'This entry changed since it was opened. Reload it before saving.');
    const missingPublish = await call('POST', '/collections/posts/entries/seeded/publish', {});
    assert.equal(missingPublish.status, 428);
    assert.equal(revisionCount(sqlite, 'seeded'), 2);

    const latest = await call('GET', '/collections/posts/entries/seeded');
    const published = await call('POST', '/collections/posts/entries/seeded/publish', { expectedRevisionId: latest.body.latestRevisionId });
    assert.equal(published.status, 200);
    assert.deepEqual(published.body.publishedData, { title: 'Edited', body: doc('Hello') });

    // A client that leaves the id out is still accepted while the entry has no revisions.
    await seedPost(sqlite, 'second', { title: 'Second', body: doc('Hi') }, 'draft');
    assert.equal((await call('POST', '/collections/posts/entries/second/publish', {})).status, 200);
    assert.equal(revisionCount(sqlite, 'second'), 2);
  } finally {
    sqlite.close();
  }
});

test('required fields reject blank text and empty rich text, and publishing checks the draft', { skip }, async () => {
  const sqlite = database();
  try {
    const invalid = await call('POST', '/collections/posts/entries', {
      data: { title: '   ', body: { type: 'doc', content: [{ type: 'paragraph' }] } },
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body.fieldErrors, { title: ['Required'], body: ['Required'] });
    assert.equal(typeof invalid.body.error, 'string');
    assert.ok(Array.isArray(invalid.body.issues));

    const missing = await call('POST', '/collections/posts/entries', { data: { title: 'Title', body: null } });
    assert.deepEqual(missing.body.fieldErrors, { body: ['Required'] });

    const created = await call('POST', '/collections/posts/entries', { data: { title: 'Title', body: doc('Text'), summary: '' } });
    assert.equal(created.status, 201);

    const latest = await call('GET', `/collections/posts/entries/${created.body.id}`);
    const cleared = await call('PUT', `/collections/posts/entries/${created.body.id}`, {
      data: { title: 'Title', body: '<p> </p>' }, expectedRevisionId: latest.body.latestRevisionId,
    });
    assert.deepEqual(cleared.body.fieldErrors, { body: ['Required'] });

    // A draft seeded without its required fields cannot go live.
    await seedPost(sqlite, 'incomplete', { title: '' }, 'draft');
    const publish = await call('POST', '/collections/posts/entries/incomplete/publish', { expectedRevisionId: null });
    assert.equal(publish.status, 400);
    assert.deepEqual(publish.body.fieldErrors, { title: ['Required'], body: ['Required'] });
    assert.equal(sqlite.prepare(`SELECT status FROM galaxy_entries WHERE id = 'incomplete'`).get().status, 'draft');
    assert.equal(revisionCount(sqlite, 'incomplete'), 0);
  } finally {
    sqlite.close();
  }
});

test('globals are stored once as JSON objects and read back as objects', { skip }, async () => {
  const sqlite = database();
  try {
    const saved = await call('POST', '/globals/site', { siteName: 'Talisman Vision' });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.data, { siteName: 'Talisman Vision' });
    const row = () => sqlite.prepare(`SELECT data FROM galaxy_globals WHERE slug = 'site'`).get().data;
    assert.equal(row(), '{"siteName":"Talisman Vision"}');

    const blank = await call('POST', '/globals/site', { siteName: ' ' });
    assert.equal(blank.status, 400);
    assert.deepEqual(blank.body.fieldErrors, { siteName: ['Required'] });
    assert.ok(blank.body.details);
    assert.equal((await call('POST', '/globals/site', ['not', 'an', 'object'])).status, 400);
    assert.equal(row(), '{"siteName":"Talisman Vision"}');

    // A row written before the fix holds the JSON text inside a JSON string.
    sqlite.prepare(`UPDATE galaxy_globals SET data = ? WHERE slug = 'site'`).run(JSON.stringify(JSON.stringify({ siteName: 'Legacy' })));
    assert.deepEqual((await call('GET', '/globals/site')).body.data, { siteName: 'Legacy' });

    const created = await call('POST', '/globals', { slug: 'footer', name: 'Footer', data: { note: 'Hi' } });
    assert.equal(created.status, 201);
    assert.equal(sqlite.prepare(`SELECT data FROM galaxy_globals WHERE slug = 'footer'`).get().data, '{"note":"Hi"}');
    assert.deepEqual((await call('GET', '/globals/footer')).body.data, { note: 'Hi' });
  } finally {
    sqlite.close();
  }
});

test('native records refuse a save based on a stale updatedAt and keep columns the editor left out', { skip }, async () => {
  const sqlite = database();
  try {
    sqlite.prepare('INSERT INTO test_parts (id, name, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('frame', 'Frame', 7, hourAgo, hourAgo);
    const stored = () => ({ ...sqlite.prepare(`SELECT name, quantity, updated_at FROM test_parts WHERE id = 'frame'`).get() });
    const loaded = await call('GET', '/collections/parts/entries/frame');
    const openedAt = loaded.body.updatedAt;

    // Stock the editor did not touch is left out, so a checkout decrement in the meantime survives.
    sqlite.prepare(`UPDATE test_parts SET quantity = 6 WHERE id = 'frame'`).run();
    const saved = await call('PUT', '/collections/parts/entries/frame', { data: { name: 'Frame body' }, expectedUpdatedAt: openedAt });
    assert.equal(saved.status, 200);
    assert.equal(stored().name, 'Frame body');
    assert.equal(stored().quantity, 6);
    // The response carries updatedAt as stored, so it works as the next save's expectation.
    assert.equal(Date.parse(saved.body.updatedAt), stored().updated_at * 1000);

    const stale = await call('PUT', '/collections/parts/entries/frame', { data: { name: 'Stale' }, expectedUpdatedAt: openedAt });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'This record changed since it was opened. Reload it before saving.');
    assert.equal(stored().name, 'Frame body');

    const blank = await call('PUT', '/collections/parts/entries/frame', { data: { name: '' }, expectedUpdatedAt: saved.body.updatedAt });
    assert.deepEqual(blank.body.fieldErrors, { name: ['Required'] });

    // A save that lands between the check and the write still loses.
    runtime.collectionHooks.parts = {
      beforeChange: [() => {
        sqlite.prepare(`UPDATE test_parts SET name = 'Concurrent', updated_at = updated_at + 1 WHERE id = 'frame'`).run();
      }],
    };
    const raced = await call('PUT', '/collections/parts/entries/frame', { data: { name: 'Mine' }, expectedUpdatedAt: saved.body.updatedAt });
    delete runtime.collectionHooks.parts;
    assert.equal(raced.status, 409);
    assert.equal(stored().name, 'Concurrent');

    // Clients that do not send expectedUpdatedAt keep the previous behaviour.
    assert.equal((await call('PUT', '/collections/parts/entries/frame', { data: { name: 'Anyway' } })).status, 200);
    assert.equal(stored().name, 'Anyway');
  } finally {
    sqlite.close();
  }
});

test('empty rich text is recognised, and generated native fields with a database default are optional', { skip }, () => {
  const { isEmptyRichText, generateFieldsFromDrizzle } = types;
  assert.equal(isEmptyRichText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '  ' }] }, { type: 'hardBreak' }] }), true);
  assert.equal(isEmptyRichText('<p>&nbsp;</p>'), true);
  assert.equal(isEmptyRichText(doc('Text')), false);
  assert.equal(isEmptyRichText({ type: 'doc', content: [{ type: 'image', attrs: { src: '/a.png' } }] }), false);
  // Other JSON (a native column shown as rich text) is never treated as an empty document.
  assert.equal(isEmptyRichText([]), false);

  const table = sqliteTable('generated', {
    id: text('id').primaryKey(),
    items: text('items', { mode: 'json' }).notNull().default([]),
    note: text('note').notNull(),
    memo: text('memo'),
  });
  assert.deepEqual(Object.fromEntries(generateFieldsFromDrizzle(table).map((field) => [field.name, field.required])),
    { id: true, items: false, note: true, memo: false });
});
