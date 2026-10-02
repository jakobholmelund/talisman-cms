import assert from 'node:assert/strict';
import test from 'node:test';
import { as, call, database, editor, runtime, seedPost, skip } from './helpers/handler-harness.mjs';

function seedMedia(sqlite, id = 'asset') {
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare('INSERT INTO galaxy_media (id, filename, mime_type, size_bytes, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'photo.png', 'image/png', 10, `/api/media/${id}`, now, now);
}

test('media usage finds nested draft, published, historic, global and native references without prefix false positives', { skip }, async () => {
  const sqlite = database();
  try {
    seedMedia(sqlite);
    await seedPost(sqlite, 'referenced', { title: 'Draft title', layout: [{ image: 'asset' }] });
    sqlite.prepare('UPDATE galaxy_entries SET published_data = ? WHERE id = ?').run(JSON.stringify({ title: 'Live title', src: 'https://cms.test/api/media/asset?width=200' }), 'referenced');
    const { collection_id } = sqlite.prepare('SELECT collection_id FROM galaxy_entries WHERE id = ?').get('referenced');
    sqlite.prepare('INSERT INTO galaxy_entry_revisions (id, entry_id, collection_id, revision_number, type, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('revision', 'referenced', collection_id, 1, 'draft_save', 'draft', JSON.stringify({ title: 'Old title', src: '/api/media/asset#image' }), 1);
    sqlite.prepare('INSERT INTO galaxy_globals (id, name, slug, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('global', 'Site settings', 'site', JSON.stringify({ logo: '/api/media/asset' }), 1, 1);
    sqlite.prepare('INSERT INTO test_parts (id, name, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('part', '/api/media/asset', 1, 1, 1);
    await seedPost(sqlite, 'not-referenced', { title: 'False positive', image: '/api/media/asset-other', id: 'asset-other' });
    let cursor = null; const usages = [];
    do {
      const response = await call('GET', `/media/asset/usage${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(response.status, 200);
      usages.push(...response.body.usages); cursor = response.body.nextCursor;
    } while (cursor);
    assert.deepEqual(usages.map(item => item.kind).sort(), ['draft', 'global', 'native', 'published', 'revision']);
    assert.ok(usages.every(item => item.title !== 'False positive'));
    assert.equal(usages.find(item => item.kind === 'revision').entryId, 'referenced');
    assert.ok(usages.every(item => !Object.hasOwn(item, 'data')));
  } finally { sqlite.close(); }
});

test('media usage is admin only, rejects forged cursors and reports unavailable native schemas', { skip }, async () => {
  const sqlite = database();
  const oldParts = runtime.nativeSchemas.parts;
  try {
    seedMedia(sqlite);
    assert.equal((await as(null, () => call('GET', '/media/asset/usage'))).status, 401);
    assert.equal((await as(editor, () => call('GET', '/media/asset/usage'))).status, 403);
    assert.equal((await call('POST', '/media/asset/usage', {})).status, 405);
    assert.equal((await call('GET', '/media/missing/usage')).status, 404);
    for (const cursor of ['not-json', JSON.stringify({ id: 'other', source: 0, offset: 0 }), JSON.stringify({ id: 'asset', source: 0, offset: -1 })]) {
      assert.equal((await call('GET', `/media/asset/usage?cursor=${encodeURIComponent(cursor)}`)).status, 400);
    }
    delete runtime.nativeSchemas.parts;
    const response = await call('GET', '/media/asset/usage');
    assert.equal(response.status, 200);
    assert.ok(response.body.excludedCollections.includes('parts'));
    assert.match(response.headers.get('cache-control'), /no-store/);
  } finally { runtime.nativeSchemas.parts = oldParts; sqlite.close(); }
});

test('media usage pages through more than fifty matches without losing or duplicating records', { skip }, async () => {
  const sqlite = database();
  try {
    seedMedia(sqlite);
    for (let index = 0; index < 65; index++) await seedPost(sqlite, `post-${String(index).padStart(3, '0')}`, { title: `Page ${index}`, image: 'asset' }, 'draft');
    const seen = new Set(); let cursor = null; let pages = 0;
    do {
      const response = await call('GET', `/media/asset/usage${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(response.status, 200);
      assert.ok(response.body.usages.length <= 50);
      for (const usage of response.body.usages) { assert.ok(!seen.has(usage.id)); seen.add(usage.id); }
      cursor = response.body.nextCursor; pages++;
    } while (cursor);
    assert.equal(seen.size, 65); assert.ok(pages >= 2);
  } finally { sqlite.close(); }
});
