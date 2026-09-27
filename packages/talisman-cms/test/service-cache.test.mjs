import assert from 'node:assert/strict';
import test from 'node:test';
import { call, database, doc, getClient, hourAgo, publicClient, runtime, seedPost, skip } from './helpers/handler-harness.mjs';

/** A KV namespace that records its puts (with their options) and deletes. */
function kvStore() {
  const store = new Map();
  const puts = [];
  const deletes = [];
  return {
    store,
    puts,
    deletes,
    async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
    async put(key, value, options) { puts.push({ key, ...options }); store.set(key, value); },
    async delete(key) { deletes.push(key); store.delete(key); },
  };
}

test('native collection reads are cached only on request, briefly, and cleared by writes', { skip }, async () => {
  const sqlite = database();
  try {
    const KV = kvStore();
    runtime.env.KV = KV;
    sqlite.prepare('INSERT INTO test_parts (id, name, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('frame', 'Frame', 7, hourAgo, hourAgo);
    const client = getClient(runtime.env);

    await client.entries.findMany('parts', { depth: 0 });
    await client.entries.find('parts', 'frame', { depth: 0 });
    assert.deepEqual(KV.puts, [], 'a native table is not cached by default');

    assert.equal((await client.entries.findMany('parts', { depth: 0, cache: true })).length, 1);
    assert.equal((await client.entries.find('parts', 'frame', { depth: 0, cache: true })).data.name, 'Frame');
    assert.deepEqual(KV.puts, [
      { key: 'talisman:entries:parts:all:published', expirationTtl: 60 },
      { key: 'talisman:entries:parts:frame:published', expirationTtl: 60 },
    ]);

    // Within the minute a copy is served as is; a write through the service clears it.
    sqlite.prepare(`UPDATE test_parts SET name = 'Renamed by SQL' WHERE id = 'frame'`).run();
    assert.equal((await client.entries.find('parts', 'frame', { depth: 0, cache: true })).data.name, 'Frame');
    await client.entries.update('parts', 'frame', { quantity: 8 });
    assert.ok(KV.deletes.includes('talisman:entries:parts:frame:published'));
    assert.ok(KV.deletes.includes('talisman:entries:parts:all:published'));
    assert.equal((await client.entries.find('parts', 'frame', { depth: 0, cache: true })).data.name, 'Renamed by SQL');

    // Entries keep the hour-long cache with its recheck.
    KV.puts.length = 0;
    await seedPost(sqlite, 'p1', { title: 'Live', body: doc('Text') }, 'published');
    assert.equal((await client.entries.findMany('posts', { depth: 0 })).length, 1);
    assert.deepEqual(KV.puts, [{ key: 'talisman:entries:posts:all:published', expirationTtl: 3600 }]);
  } finally {
    sqlite.close();
  }
});

test('global writes clear the cached list and the global, through the admin API, the SDK and the helper', { skip }, async () => {
  const sqlite = database();
  try {
    const KV = kvStore();
    runtime.env.KV = KV;
    assert.equal((await call('POST', '/globals/site', { siteName: 'Site' })).status, 200);
    assert.deepEqual(KV.deletes, ['talisman:globals:all', 'talisman:globals:site']);
    KV.deletes.length = 0;
    assert.equal((await call('POST', '/globals', { slug: 'footer' })).status, 201);
    assert.deepEqual(KV.deletes, ['talisman:globals:all', 'talisman:globals:footer']);

    const client = getClient(runtime.env);
    KV.deletes.length = 0;
    await client.globals.update('site', { siteName: 'Renamed' });
    assert.deepEqual(KV.deletes, ['talisman:globals:all', 'talisman:globals:site']);
    KV.deletes.length = 0;
    await client.globals.create({ slug: 'legal' });
    assert.deepEqual(KV.deletes, ['talisman:globals:all', 'talisman:globals:legal']);

    KV.deletes.length = 0;
    await publicClient.invalidateGlobalCache(runtime.env, 'site');
    await publicClient.invalidateGlobalCache(runtime.env);
    await publicClient.invalidateCollectionCache(runtime.env);
    assert.deepEqual(KV.deletes, ['talisman:globals:all', 'talisman:globals:site', 'talisman:globals:all', 'talisman:collections:all']);
    await publicClient.invalidateGlobalCache({}, 'site');
  } finally {
    sqlite.close();
  }
});

test('the collection sync clears the cached collection list when it writes rows', { skip }, async () => {
  const sqlite = database();
  try {
    const KV = kvStore();
    KV.store.set('talisman:collections:all', '[]');
    runtime.env.KV = KV;
    assert.equal((await call('GET', '/collections/posts/entries')).status, 200);
    assert.deepEqual(KV.deletes, ['talisman:collections:all']);
    assert.equal((await call('GET', '/collections/parts/entries')).status, 200);
    assert.equal(KV.deletes.length, 1, 'later requests write nothing');

    const listed = await getClient(runtime.env).collections.findMany();
    assert.equal(listed.length, runtime.collections.length);
    assert.equal(KV.puts[0].key, 'talisman:collections:all');
  } finally {
    sqlite.close();
  }
});
