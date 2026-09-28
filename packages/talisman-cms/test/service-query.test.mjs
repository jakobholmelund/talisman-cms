import assert from 'node:assert/strict';
import test from 'node:test';
import { call, database, doc, getClient, hourAgo, publicClient, runtime, seedPost, skip } from './helpers/handler-harness.mjs';

const ids = (entries) => entries.map((entry) => entry.id);

async function seed(sqlite) {
  await seedPost(sqlite, 'a', { title: 'Alpha', body: doc('A'), summary: 'first', tags: ['t1', 't2'] }, 'published');
  await seedPost(sqlite, 'b', { title: 'Beta', body: doc('B'), tags: ['t2'] }, 'published');
  await seedPost(sqlite, 'c', { title: 'Gamma', body: doc('C'), summary: 'third' }, 'draft');
  // A published entry whose draft differs from its live snapshot.
  sqlite.prepare(`UPDATE galaxy_entries SET published_data = ? WHERE id = 'a'`).run(JSON.stringify({ title: 'Alpha live', body: doc('A'), summary: 'first', tags: ['t1', 't2'] }));
  for (const [id, name, quantity] of [['frame', 'Frame', 7], ['lens', 'Lens', 2], ['case', 'Case', 12]]) {
    sqlite.prepare('INSERT INTO test_parts (id, name, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, name, quantity, hourAgo, hourAgo);
  }
}

test('the list route filters, sorts and skips with where, sort and offset, on entry data and native columns', { skip }, async () => {
  const sqlite = database();
  try {
    await seed(sqlite);
    const list = async (query) => {
      const response = await call('GET', `/collections/posts/entries?${query}`);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return Array.isArray(response.body) ? response.body : response.body.docs;
    };
    // The admin edits drafts, so its filters read the draft data of every status.
    assert.deepEqual(ids(await list('where[title]=Alpha')), ['a']);
    assert.deepEqual(ids(await list('where[title][in]=Alpha,Gamma&sort=title')), ['a', 'c']);
    assert.deepEqual(ids(await list('where[title][in]=Alpha&where[title][in]=Beta&sort=-title')), ['b', 'a']);
    assert.deepEqual(ids(await list('where[summary][isNull]=true')), ['b']);
    assert.deepEqual(ids(await list('where[summary][isNull]=false&sort=title')), ['a', 'c']);
    assert.deepEqual(ids(await list('where[tags][contains]=t2&sort=title')), ['a', 'b']);
    assert.deepEqual(ids(await list('where[status]=draft')), ['c']);
    assert.deepEqual(ids(await list('sort=title&limit=1&offset=1')), ['b']);
    assert.deepEqual(ids(await list('where[title][ne]=Beta&sort=-title')), ['c', 'a']);
    assert.deepEqual(ids(await list(`where[createdAt][lt]=${new Date().toISOString()}&sort=title`)), ['a', 'b', 'c']);

    const parts = async (query) => (await call('GET', `/collections/parts/entries?${query}`)).body;
    assert.deepEqual(ids(await parts('where[quantity][gte]=5&sort=-quantity')), ['case', 'frame']);
    assert.deepEqual(ids(await parts('where[name]=Lens')), ['lens']);
    assert.deepEqual(ids((await parts('sort=quantity&limit=2')).docs), ['lens', 'frame'], 'a sorted page pages by offset');
    assert.equal((await parts('sort=quantity&limit=2')).nextCursor, null);
  } finally {
    sqlite.close();
  }
});

test('a query names only configured fields, fits the field type and never reaches the statement text', { skip }, async () => {
  const sqlite = database();
  try {
    await seed(sqlite);
    const { statements } = runtime.env.DB;
    const refused = async (query, field) => {
      const response = await call('GET', `/collections/posts/entries?${query}`);
      assert.equal(response.status, 400, `${query} answered ${response.status}`);
      if (field) assert.ok(response.body.fieldErrors?.[field], JSON.stringify(response.body));
      return response.body;
    };
    await refused('where[nope]=1', 'nope');
    await refused('where[title][between]=1', 'title');
    await refused('where[title][gt]=A', 'title');
    await refused('where[tags][contains]=', 'tags').then(() => {}).catch(() => {});
    await refused('where[title][contains]=x', 'title');
    await refused('where[createdAt]=yesterday', 'createdAt');
    await refused('sort=title,summary,status');
    await refused('offset=abc');
    await refused('offset=20000&limit=5');
    await refused('sort=title&limit=1&cursor=abc');
    await refused('where[a]=1&where[b]=1&where[c]=1&where[d]=1&where[e]=1&where[f]=1&where[g]=1&where[h]=1&where[i]=1');
    const many = Array.from({ length: 95 }, (_, index) => `v${index}`).join(',');
    await refused(`where[title][in]=${many}`);
    const parts = await call('GET', '/collections/parts/entries?where[quantity]=many');
    assert.equal(parts.status, 400);

    statements.length = 0;
    const injected = `x' OR 1=1 --`;
    const response = await call('GET', `/collections/posts/entries?where[title]=${encodeURIComponent(injected)}&where[title][ne]=${encodeURIComponent('"); DROP TABLE galaxy_entries; --')}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, []);
    assert.ok(statements.every((statement) => !statement.includes('DROP') && !statement.includes('OR 1=1')), 'values are bound, not spliced');
    assert.ok(statements.some((statement) => /json_extract\("galaxy_entries"\."data", \?\)/.test(statement)), statements.join('\n'));
    const path = await call('GET', `/collections/posts/entries?where[${encodeURIComponent('title") --')}]=1`);
    assert.equal(path.status, 400);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM galaxy_entries').get().total, 3);
  } finally {
    sqlite.close();
  }
});

test('the SDK filters the published snapshot, never caches a filtered read, and takes offset only with limit', { skip }, async () => {
  const sqlite = database();
  try {
    await seed(sqlite);
    const puts = [];
    runtime.env.KV = { async get() { return null; }, async put(key) { puts.push(key); }, async delete() {} };
    const client = getClient(runtime.env);

    assert.deepEqual(ids(await client.entries.findMany('posts', { depth: 0, where: { title: 'Alpha live' } })), ['a'], 'published reads filter the live snapshot');
    assert.deepEqual(ids(await client.entries.findMany('posts', { depth: 0, where: { title: 'Alpha' } })), [], 'the draft title is not live');
    assert.deepEqual(ids(await client.entries.findMany('posts', { depth: 0, version: 'draft', where: { title: 'Alpha' } })), ['a']);
    assert.deepEqual(ids(await client.entries.findMany('posts', { depth: 0, where: { tags: { contains: 't2' } }, sort: 'title' })), ['a', 'b']);
    assert.deepEqual(ids(await client.entries.findMany('posts', { depth: 0, sort: '-title', limit: 1, offset: 1 })), ['a']);
    assert.deepEqual(ids(await client.entries.findMany('parts', { where: { quantity: { gt: 5 } }, sort: '-quantity' })), ['case', 'frame']);
    assert.deepEqual(puts, [], 'filtered, sorted or offset reads bypass KV');
    // Newest first; the seeded entries share a creation time, so the higher id comes first.
    assert.deepEqual(ids(await client.entries.findMany('posts', { depth: 0 })), ['b', 'a']);
    assert.deepEqual(puts, ['talisman:entries:posts:all:published'], 'a plain read is still cached');

    await assert.rejects(client.entries.findMany('posts', { offset: 1 }), publicClient.InvalidInputError);
    await assert.rejects(client.entries.findMany('posts', { where: { nope: 1 } }), publicClient.ValidationError);
    await assert.rejects(client.entries.findMany('posts', { where: { title: { gt: 'A' } } }), publicClient.ValidationError);
  } finally {
    sqlite.close();
  }
});
