import assert from 'node:assert/strict';
import test from 'node:test';
import { as, call, database, doc, editor, hourAgo, runtime, seedPost, skip } from './helpers/handler-harness.mjs';

let talismanLiveLoader;
if (!skip) ({ talismanLiveLoader } = await import('../src/loader.ts'));
const request = () => new Request('https://cms.test/preview');
const loader = (options = {}) => talismanLiveLoader({ collection: 'posts', ...options });
const collection = (instance, filter) => instance.loadCollection({ collection: 'posts', filter });
const entry = (instance, filter) => instance.loadEntry({ collection: 'posts', filter });
const ids = (result) => result.entries.map(item => item.id);

async function seed(sqlite) {
  await seedPost(sqlite, 'a', { title: 'Alpha draft', body: doc('A'), tags: ['tag'] });
  await seedPost(sqlite, 'b', { title: 'Beta', body: doc('B') });
  await seedPost(sqlite, 'c', { title: 'Gamma', body: doc('C') }, 'draft');
  sqlite.prepare("UPDATE galaxy_entries SET published_data = ?, draft_slug = 'next-alpha' WHERE id = 'a'")
    .run(JSON.stringify({ title: 'Alpha live', body: doc('A'), tags: ['tag'] }));
  await call('GET', '/collections/tags/entries');
  const tags = sqlite.prepare("SELECT id FROM galaxy_collections WHERE slug = 'tags'").get();
  sqlite.prepare('INSERT INTO galaxy_entries (id, collection_id, slug, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('tag', tags.id, 'tag', 'published', JSON.stringify({ label: 'Featured' }), hourAgo, hourAgo);
}

test('live queries filter the published snapshot, sort and page before returning Astro entries', { skip }, async () => {
  const sqlite = database();
  try {
    await seed(sqlite);
    const instance = loader();
    assert.deepEqual(ids(await collection(instance)), ['b', 'a']);
    const filtered = await collection(instance, { where: { title: { text: 'ALPHA' } }, limit: 10 });
    assert.deepEqual(ids(filtered), ['a']);
    assert.equal(filtered.entries[0].data.title, 'Alpha live');
    assert.equal(filtered.entries[0].data.slug, 'a');
    assert.equal(filtered.entries[0].data.status, 'published');
    assert.ok(filtered.entries[0].data.createdAt instanceof Date);
    assert.deepEqual(ids(await collection(instance, { sort: 'title', limit: 1, offset: 1 })), ['b']);
    assert.deepEqual(ids(await collection(instance, { where: { status: 'draft' } })), []);
    assert.deepEqual(ids(await collection(instance, { where: { title: "x' OR 1=1 --" } })), []);
  } finally { sqlite.close(); }
});

test('live entry reads distinguish ids, live slugs and draft slugs and return undefined for missing entries', { skip }, async () => {
  const sqlite = database();
  try {
    await seed(sqlite);
    sqlite.prepare("UPDATE galaxy_entries SET slug = 'live-alpha' WHERE id = 'a'").run();
    const instance = loader();
    assert.equal((await entry(instance, { id: 'a' })).data.title, 'Alpha live');
    assert.equal((await entry(instance, { slug: 'live-alpha' })).id, 'a');
    assert.equal(await entry(instance, { slug: 'next-alpha' }), undefined);
    assert.equal(await entry(instance, { id: 'missing' }), undefined);
    assert.equal(await entry(instance, { id: 'c' }), undefined);
    const preview = await entry(instance, { slug: 'next-alpha', version: 'draft', request: request() });
    assert.equal(preview.data.title, 'Alpha draft');
    assert.equal(preview.data.slug, 'next-alpha');
  } finally { sqlite.close(); }
});

test('live reads leave relationships as ids by default and allow bounded depth overrides', { skip }, async () => {
  const sqlite = database();
  const tags = runtime.collections.find(item => item.slug === 'tags');
  tags.fields.push({ name: 'post', type: 'relationship', relationTo: 'posts' });
  try {
    await seed(sqlite);
    sqlite.prepare("UPDATE galaxy_entries SET data = ? WHERE id = 'tag'").run(JSON.stringify({ label: 'Featured', post: 'b' }));
    assert.deepEqual((await entry(loader(), { id: 'a' })).data.tags, ['tag']);
    assert.equal((await entry(loader(), { id: 'a', depth: 1 })).data.tags[0].data.label, 'Featured');
    assert.equal((await collection(loader({ depth: 1 }), { where: { id: 'a' } })).entries[0].data.tags[0].id, 'tag');
    assert.deepEqual((await entry(loader({ depth: 1 }), { id: 'a', depth: 0 })).data.tags, ['tag']);
    assert.equal((await entry(loader(), { id: 'a', depth: 1 })).data.tags[0].data.post, 'b');
    assert.equal((await entry(loader(), { id: 'a', depth: 2 })).data.tags[0].data.post.data.title, 'Beta');
  } finally { tags.fields.pop(); sqlite.close(); }
});

test('live collection reads have a default bound and support configured and per-query page sizes', { skip }, async () => {
  const sqlite = database();
  try {
    for (let i = 0; i < 55; i++) await seedPost(sqlite, `post-${i}`, { title: `Post ${i}`, body: doc('P') });
    assert.equal((await collection(loader())).entries.length, 50);
    assert.equal((await collection(loader({ limit: 7 }))).entries.length, 7);
    assert.equal((await collection(loader({ limit: 7 }), { limit: 200 })).entries.length, 55);
    assert.equal((await collection(loader(), { offset: 50 })).entries.length, 5);
  } finally { sqlite.close(); }
});

test('draft preview requires a verified CMS role, enforces collection rules and bypasses shared caches', { skip }, async () => {
  const sqlite = database();
  try {
    await seed(sqlite);
    const instance = loader({ version: 'draft' });
    assert.equal((await collection(instance)).error.code, 'forbidden');
    assert.equal((await entry(instance, { id: 'c' })).error.code, 'forbidden');
    for (const user of [null, { id: 'shopper', role: 'customer' }]) {
      await as(user, async () => {
        assert.equal((await collection(instance, { request: request() })).error.code, 'forbidden');
        assert.equal((await entry(instance, { id: 'c', request: request() })).error.code, 'forbidden');
      });
    }
    const cacheCalls = [];
    runtime.env.KV = {
      async get(key) { cacheCalls.push(key); return null; },
      async put(key) { cacheCalls.push(key); },
      async delete() {},
    };
    await as(editor, async () => {
      assert.deepEqual(ids(await collection(instance, { request: request() })), ['c', 'b', 'a']);
      assert.equal((await entry(instance, { id: 'c', request: request() })).data.title, 'Gamma');
      const privateLoader = talismanLiveLoader({ collection: 'notes', version: 'draft' });
      assert.equal((await entry(privateLoader, { id: 'missing', request: request() })).error.code, 'forbidden');
      assert.equal((await collection(privateLoader, { request: request() })).error.code, 'forbidden');
    });
    assert.deepEqual(cacheCalls, []);
    assert.deepEqual(ids(await collection(instance, { version: 'published' })), ['b', 'a']);
  } finally { sqlite.close(); }
});

test('native live collections retain their rows in published mode and filter by configured columns', { skip }, async () => {
  const sqlite = database();
  try {
    sqlite.prepare('INSERT INTO test_parts (id, name, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('frame', 'Frame', 7, hourAgo, hourAgo);
    const native = talismanLiveLoader({ collection: 'parts' });
    const result = await collection(native, { where: { quantity: { gte: 5 } }, sort: '-quantity' });
    assert.deepEqual(ids(result), ['frame']);
    assert.equal(result.entries[0].data.name, 'Frame');
    assert.equal((await entry(native, { slug: 'frame' })).id, 'frame', 'native tables without a slug match their id');
    assert.deepEqual(ids(await collection(native, { where: { quantity: { lt: 5 } } })), []);
  } finally { sqlite.close(); }
});

test('live loader reports invalid filters and bounds as Astro error results', { skip }, async () => {
  const sqlite = database();
  try {
    await seed(sqlite);
    for (const filter of [null, [], { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { depth: -1 }, { depth: 6 }, { depth: '1' }, { version: 'other' }, { offset: -1 }, { offset: 10001 }, { where: { nope: 1 } }, { sort: 'nope' }, { title: 'Alpha' }]) {
      const result = await collection(loader(), filter);
      assert.ok(result.error instanceof Error, JSON.stringify(filter));
      assert.equal(result.entries, undefined);
    }
    for (const filter of [undefined, {}, { id: '' }, { slug: ' ' }, { id: 'a', slug: 'a' }, { id: 1 }, { id: 'a', limit: 2 }]) {
      assert.equal((await entry(loader(), filter)).error.code, 'invalid_input');
    }
    assert.equal((await collection(loader({ limit: 500 }))).error.code, 'invalid_input');
    assert.equal((await entry(loader({ depth: 6 }), { id: 'a' })).error.code, 'invalid_input');
  } finally { sqlite.close(); }
});
