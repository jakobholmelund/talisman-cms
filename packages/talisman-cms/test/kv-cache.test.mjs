import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { getClient } from '../dist/client.js';

const hourAgo = Math.floor(Date.now() / 1000) - 3600;

function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['0000_skinny_odin', '0001_abandoned_shotgun', '0002_flowery_midnight',
    '0003_content_versioning', '0018_entry_revision_integrity']) {
    const sql = readFileSync(new URL(`../drizzle/${migration}.sql`, import.meta.url), 'utf8');
    sqlite.exec(sql.replaceAll('--> statement-breakpoint', ''));
  }
  sqlite.prepare('INSERT INTO galaxy_collections (id, name, slug, fields, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('pages-id', 'Pages', 'pages', '[]', hourAgo);
  sqlite.prepare(`INSERT INTO galaxy_entries (id, collection_id, slug, status, data, published_data, created_at, updated_at, published_at)
    VALUES (?, ?, ?, 'published', ?, ?, ?, ?, ?)`)
    .run('about', 'pages-id', 'about', '{"title":"About"}', '{"title":"About"}', hourAgo, hourAgo, hourAgo);
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
  };
  return { sqlite, DB };
}

function kvStore({ get, put } = {}) {
  const store = new Map();
  const calls = { put: 0, delete: 0 };
  return {
    store,
    calls,
    async get(key) {
      if (get) return get(key);
      return store.has(key) ? JSON.parse(store.get(key)) : null;
    },
    async put(key, value) {
      calls.put += 1;
      if (put) await put(key, value);
      store.set(key, value);
    },
    async delete(key) {
      calls.delete += 1;
      store.delete(key);
    },
  };
}

const pagesKey = 'talisman:entries:pages:all:published';
const titles = (entries) => entries.map((entry) => entry.data.title);

test('KV read and write failures fall back to the D1 result', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { sqlite, DB } = database();
  try {
    const KV = kvStore({
      get: async () => { throw new Error('KV GET failed: 503'); },
      put: async () => { throw new Error('KV PUT failed: 429 Too Many Requests'); },
    });
    const client = getClient({ DB, KV });

    assert.deepEqual(titles(await client.entries.findMany('pages', { depth: 0 })), ['About']);
    assert.equal((await client.entries.find('pages', 'about', { depth: 0 })).data.title, 'About');
    assert.equal(KV.store.size, 0);
    assert.equal(warn.mock.callCount(), 4);
  } finally {
    sqlite.close();
  }
});

test('cache fills are handed to waitUntil instead of holding up the read', async () => {
  const { sqlite, DB } = database();
  try {
    let releasePut;
    const putGate = new Promise((resolve) => { releasePut = resolve; });
    const KV = kvStore({ put: () => putGate });
    const pending = [];
    const client = getClient({ DB, KV }, { waitUntil: (promise) => pending.push(promise) });

    assert.deepEqual(titles(await client.entries.findMany('pages', { depth: 0 })), ['About']);
    assert.equal(pending.length, 1);
    assert.equal(KV.store.has(pagesKey), false);

    releasePut();
    await Promise.all(pending);
    assert.deepEqual(titles(JSON.parse(KV.store.get(pagesKey))), ['About']);
  } finally {
    sqlite.close();
  }
});

test('a cache fill that lands after a publish invalidation is dropped', async () => {
  const { sqlite, DB } = database();
  try {
    let publishDuringPut = true;
    const KV = kvStore({
      put: async () => {
        if (!publishDuringPut) return;
        publishDuringPut = false;
        // An editor publishes after this read hit D1 but before its put reached KV.
        sqlite.prepare(`UPDATE galaxy_entries SET data = ?, published_data = ?, updated_at = ? WHERE id = 'about'`)
          .run('{"title":"About us"}', '{"title":"About us"}', Math.floor(Date.now() / 1000));
        KV.store.delete(pagesKey);
      },
    });
    const client = getClient({ DB, KV });

    assert.deepEqual(titles(await client.entries.findMany('pages', { depth: 0 })), ['About']);
    assert.equal(KV.store.has(pagesKey), false);
    assert.deepEqual(titles(await client.entries.findMany('pages', { depth: 0 })), ['About us']);
  } finally {
    sqlite.close();
  }
});

test('cache fills for rows unchanged since the read are kept', async () => {
  const { sqlite, DB } = database();
  try {
    const KV = kvStore();
    const client = getClient({ DB, KV });

    assert.deepEqual(titles(await client.entries.findMany('pages', { depth: 0 })), ['About']);
    assert.equal(KV.store.has(pagesKey), true);
    sqlite.prepare(`UPDATE galaxy_entries SET published_data = '{"title":"Not invalidated"}' WHERE id = 'about'`).run();
    assert.deepEqual(titles(await client.entries.findMany('pages', { depth: 0 })), ['About']);
  } finally {
    sqlite.close();
  }
});

test('rows stamped far in the future do not make every cache fill look stale', async () => {
  const { sqlite, DB } = database();
  try {
    // Demo seeds have written milliseconds into the seconds column, which reads as a far-future date.
    sqlite.prepare(`UPDATE galaxy_entries SET updated_at = ? WHERE id = 'about'`).run(Date.now());
    const KV = kvStore();
    const client = getClient({ DB, KV });

    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(titles(await client.entries.findMany('pages', { depth: 0 })), ['About']);
    }
    assert.equal(KV.calls.put, 1);
    assert.equal(KV.calls.delete, 0);
    assert.equal(KV.store.has(pagesKey), true);
  } finally {
    sqlite.close();
  }
});

test('a cache fill that lands after a hard delete is dropped', async () => {
  const { sqlite, DB } = database();
  try {
    const entryKey = 'talisman:entries:pages:about:published';
    const KV = kvStore({
      put: async (key) => {
        // An editor deletes the entry after this read hit D1 but before its put reached KV.
        if (sqlite.prepare(`SELECT 1 FROM galaxy_entries WHERE id = 'about'`).get()) {
          sqlite.prepare(`DELETE FROM galaxy_entries WHERE id = 'about'`).run();
        }
        KV.store.delete(key);
      },
    });
    const client = getClient({ DB, KV });

    assert.equal((await client.entries.find('pages', 'about', { depth: 0 })).data.title, 'About');
    assert.equal(KV.store.has(entryKey), false);
    assert.equal(await client.entries.find('pages', 'about', { depth: 0 }), undefined);

    sqlite.prepare(`INSERT INTO galaxy_entries (id, collection_id, slug, status, data, published_data, created_at, updated_at)
      VALUES ('about', 'pages-id', 'about', 'published', '{"title":"About"}', '{"title":"About"}', ?, ?)`).run(hourAgo, hourAgo);
    assert.deepEqual(titles(await client.entries.findMany('pages', { depth: 0 })), ['About']);
    assert.equal(KV.store.has(pagesKey), false);
    assert.deepEqual(titles(await client.entries.findMany('pages', { depth: 0 })), []);
  } finally {
    sqlite.close();
  }
});

test('globals are stored once as JSON objects and double-encoded rows read as objects', async () => {
  const { sqlite, DB } = database();
  try {
    sqlite.prepare(`INSERT INTO galaxy_globals (id, name, slug, data, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy', ?, ?, ?)`)
      .run(JSON.stringify(JSON.stringify({ siteName: 'Talisman' })), hourAgo, hourAgo);
    const client = getClient({ DB });

    assert.deepEqual((await client.globals.find('legacy', { cache: false })).data, { siteName: 'Talisman' });

    const updated = await client.globals.update('legacy', { siteName: 'Talisman Vision' });
    assert.deepEqual(updated.data, { siteName: 'Talisman Vision' });
    await client.globals.create({ slug: 'fresh', data: { tagline: 'Lenses' } });
    const stored = Object.fromEntries(sqlite.prepare('SELECT slug, data FROM galaxy_globals').all().map((row) => [row.slug, row.data]));
    assert.deepEqual(stored, { legacy: '{"siteName":"Talisman Vision"}', fresh: '{"tagline":"Lenses"}' });

    // A value cached before the fix still reaches readers as an object.
    const KV = kvStore();
    KV.store.set('talisman:globals:legacy', JSON.stringify({ slug: 'legacy', data: '{"siteName":"Cached"}' }));
    assert.deepEqual((await getClient({ DB, KV }).globals.find('legacy')).data, { siteName: 'Cached' });
  } finally {
    sqlite.close();
  }
});
