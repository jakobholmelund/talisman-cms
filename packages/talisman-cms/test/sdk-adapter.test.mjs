import assert from 'node:assert/strict';
import test from 'node:test';
import { call, database, doc, editor, getClient, hourAgo, publicClient, runtime, seedPost, skip } from './helpers/handler-harness.mjs';

const request = () => new Request('https://cms.test/admin/api/x', { method: 'POST' });

test('getClient runs the same validation and hooks as the admin API, and its errors are typed', { skip }, async () => {
  const sqlite = database();
  try {
    const hooked = [];
    runtime.collectionHooks.posts = { beforeChange: [({ data, actor, req }) => { hooked.push([actor.kind, req === undefined]); return { summary: `by ${actor.kind}` }; }] };
    const client = getClient(runtime.env);

    await assert.rejects(client.entries.create('posts', { title: 'No body' }),
      (error) => error instanceof publicClient.ValidationError && error.issues.some((issue) => issue.path[0] === 'body'));
    await assert.rejects(client.entries.create('posts', 'not an object'), publicClient.InvalidInputError);
    await assert.rejects(client.entries.create('posts', { title: 'T', body: doc('B') }, { slug: 'bad slug' }), publicClient.ValidationError);

    const created = await client.entries.create('posts', { title: 'T', body: doc('B') }, { slug: 'sdk-post' });
    assert.deepEqual([created.status, created.slug, created.data.summary], ['draft', 'sdk-post', 'by system']);
    assert.match(created.latestRevisionId, /^rev_/);
    assert.deepEqual(hooked, [['system', true]], 'SDK writes reach hooks as system, without a request');

    // A status publishes straight away, chained from the save's own revision.
    const live = await client.entries.create('posts', { title: 'Live', body: doc('B') }, { slug: 'live', status: 'published' });
    assert.equal(live.status, 'published');
    assert.equal(live.publishedSlug, 'live');
    await assert.rejects(client.entries.create('posts', { title: '' }, { status: 'published' }), publicClient.ValidationError, 'an incomplete draft cannot go live');

    // Server code may leave the revision token out; the same call with a user actor needs it.
    const edited = await client.entries.update('posts', created.id, { title: 'Edited', body: doc('B') });
    assert.equal(edited.data.title, 'Edited');
    const asEditor = getClient(runtime.env, undefined, { actor: publicClient.userActor(editor, request()) });
    await assert.rejects(asEditor.entries.update('posts', created.id, { title: 'Mine', body: doc('B') }), publicClient.PreconditionRequiredError);
    await assert.rejects(asEditor.entries.delete('posts', created.id),
      (error) => error instanceof publicClient.AccessDeniedError && error.message === 'Admin access required');
    await assert.rejects(asEditor.entries.findMany('notes', { cache: false }), publicClient.AccessDeniedError);
    const latest = (await call('GET', `/collections/posts/entries/${created.id}`)).body.latestRevisionId;
    const theirs = await asEditor.entries.update('posts', created.id, { title: 'Theirs', body: doc('B') }, { expectedRevisionId: latest });
    assert.equal(theirs.data.title, 'Theirs');
    assert.deepEqual(hooked.at(-1), ['user', false], 'a user actor from a plugin route reaches hooks with its request');
  } finally {
    delete runtime.collectionHooks.posts;
    sqlite.close();
  }
});

test('getClient saves a global with the version it loaded, and a stale save says which version is stored', { skip }, async () => {
  const sqlite = database();
  try {
    const client = getClient(runtime.env);
    const loaded = await client.globals.find('site');
    assert.equal(loaded.version, 1);
    const saved = await client.globals.save('site', { siteName: 'One' }, { expectedVersion: loaded.version });
    assert.deepEqual([saved.version, saved.data], [2, { siteName: 'One' }]);
    await assert.rejects(client.globals.save('site', { siteName: 'Two' }, { expectedVersion: loaded.version }),
      (error) => error instanceof publicClient.ConflictError && error.code === 'stale_record' && error.version === 2);
    assert.equal(sqlite.prepare(`SELECT data FROM galaxy_globals WHERE slug = 'site'`).get().data, '{"siteName":"One"}');
    // Server code may leave the version out, under either name; a version that cannot exist is refused.
    assert.equal((await client.globals.update('site', { siteName: 'Three' })).version, 3);
    assert.equal((await client.globals.save('site', { siteName: 'Four' })).version, 4);
    await assert.rejects(client.globals.save('site', { siteName: 'Five' }, { expectedVersion: 0 }), publicClient.InvalidInputError);
    await assert.rejects(client.globals.save('site', { siteName: 'Five' }, { expectedVersion: '4' }), publicClient.InvalidInputError);
  } finally {
    sqlite.close();
  }
});

test('getClient reads keep their shapes: undefined for a missing entry, null for a missing slug, drafts on request', { skip }, async () => {
  const sqlite = database();
  try {
    await seedPost(sqlite, 'p1', { title: 'Draft', body: doc('Text') }, 'draft');
    await seedPost(sqlite, 'p2', { title: 'Live', body: doc('Text') }, 'published');
    sqlite.prepare('INSERT INTO test_parts (id, name, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('frame', 'Frame', 7, hourAgo, hourAgo);
    const client = getClient(runtime.env);

    assert.equal(await client.entries.find('posts', 'missing'), undefined);
    assert.equal(await client.entries.find('posts', 'p1'), undefined, 'a draft is not published');
    assert.equal((await client.entries.find('posts', 'p1', { version: 'draft' })).data.title, 'Draft');
    assert.equal(await client.entries.findBySlug('posts', 'missing'), null);
    assert.equal((await client.entries.findBySlug('posts', 'p2')).id, 'p2');
    assert.deepEqual((await client.entries.findMany('posts')).map((entry) => entry.id), ['p2']);
    assert.deepEqual((await client.entries.findMany('posts', { version: 'draft' })).map((entry) => entry.id).sort(), ['p1', 'p2']);
    await assert.rejects(client.entries.findMany('posts', { limit: 0 }), publicClient.InvalidInputError);
    assert.equal((await client.entries.find('parts', 'frame')).data.name, 'Frame');
    assert.equal((await client.entries.findBySlug('parts', 'frame')).id, 'frame', 'a native row without a slug column matches its id');
    assert.equal((await client.collections.findMany()).length, runtime.collections.length);
    assert.ok((await client.globals.findMany()).some((global) => global.slug === 'site'));

    // A missing record can no longer be deleted silently.
    await assert.rejects(client.entries.delete('posts', 'missing'), publicClient.NotFoundError);
    assert.equal(await client.entries.delete('posts', 'p1'), true);
    assert.equal((await call('GET', '/collections/posts/entries/p1')).status, 404);
  } finally {
    sqlite.close();
  }
});
