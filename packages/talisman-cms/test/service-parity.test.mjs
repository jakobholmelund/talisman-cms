import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL, admin, as, call, database, doc, editor, hourAgo, runtime, seedPost, skip } from './helpers/handler-harness.mjs';

// Every scenario runs twice on identical databases: through the admin API (ALL) and through the
// service with the same user. The rows, the KV keys deleted, the hooks called and the outcome must
// match, which proves the HTTP handler adds nothing but parsing and response shaping. A third run
// through the service as trusted server code (the SDK) must match too, except where a difference
// is documented, and the test names each such difference.

let service;
let config;
let actors;
let httpErrors;
if (!skip) {
  service = await import('../src/service/index.ts');
  config = await import('../src/service/config.ts');
  actors = await import('../src/service/actor.ts');
  httpErrors = await import('../src/api/http-errors.ts');
}

const serviceConfig = () => config.configFromModules({
  config: { collections: runtime.collections, globals: runtime.globals, publishing: { workflowBinding: 'SITE_PUBLISH_WORKFLOW' } },
  nativeSchemas: { nativeSchemas: runtime.nativeSchemas },
  collectionHooks: { collectionHooks: runtime.collectionHooks },
});

function kvStore() {
  const deletes = [];
  return { deletes, async get() { return null; }, async put() {}, async delete(key) { deletes.push(key); } };
}

/** Rows of the touched tables with generated ids and timestamps replaced, so two runs compare. */
function snapshot(sqlite) {
  const ids = new Map();
  const placeholder = (value) => {
    if (typeof value !== 'string' || !/^(entry|rev)_|^[0-9a-f]{8}-[0-9a-f-]{27}$|^\d{13}-[a-z0-9]+$/.test(value)) return value;
    if (!ids.has(value)) ids.set(value, `<id ${ids.size + 1}>`);
    return ids.get(value);
  };
  const normalize = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (/_at$/.test(key)) return [key, value === null ? null : '<time>'];
    if (key === 'data' || key === 'published_data') return [key, value === null ? null : JSON.parse(value)];
    return [key, placeholder(value)];
  }));
  const rows = (table, order) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map(normalize);
  return {
    entries: rows('galaxy_entries', 'created_at, slug'),
    revisions: rows('galaxy_entry_revisions', 'created_at, revision_number, entry_id'),
    parts: rows('test_parts', 'id'),
    media: rows('galaxy_media', 'id'),
    globals: rows('galaxy_globals', 'slug'),
  };
}

const normalizeBody = (body) => JSON.parse(JSON.stringify(body, (key, value) => {
  if (/^(id|entryId|latestRevisionId|publishedRevisionId|collectionId|slug)$/.test(key) && typeof value === 'string' && /^(entry|rev)_|^[0-9a-f-]{36}$|^\d{13}-[a-z0-9]+$/.test(value)) return '<id>';
  if (/(At|_at)$/.test(key) && value !== null) return '<time>';
  return value;
}));

function recordingHooks(log, slugs) {
  const record = (hook) => (args) => { log.push({ hook, operation: args.operation, collection: args.collection.slug, actorKind: args.actor.kind, dataKeys: Object.keys(args.data ?? {}).sort() }); };
  for (const slug of slugs) {
    runtime.collectionHooks[slug] = { beforeValidate: [record('beforeValidate')], beforeChange: [record('beforeChange')], afterChange: [record('afterChange')], beforeDelete: [record('beforeDelete')], afterDelete: [record('afterDelete')] };
  }
}

async function seed(sqlite) {
  await seedPost(sqlite, 'p1', { title: 'Draft', body: doc('Text') }, 'draft');
  await seedPost(sqlite, 'p2', { title: 'Live', body: doc('Text') }, 'published');
  await seedPost(sqlite, 'incomplete', { title: '' }, 'draft');
  sqlite.prepare('INSERT INTO test_parts (id, name, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('frame', 'Frame', 7, hourAgo, hourAgo);
  sqlite.prepare(`INSERT INTO galaxy_media (id, filename, mime_type, size_bytes, url, created_at, updated_at)
    VALUES ('m1', 'a.png', 'image/png', 10, '/api/media/m1', ?, ?)`).run(hourAgo, hourAgo);
  const saved = await call('PUT', '/collections/posts/entries/p2', { data: { title: 'Live', body: doc('Text') }, expectedRevisionId: null });
  assert.equal(saved.status, 200);
  return { revisionId: saved.body.latestRevisionId };
}

/** One run of a scenario: the outcome, the rows, the KV deletes and the hook calls. */
async function run(scenario, mode, user) {
  const sqlite = database();
  const hookLog = [];
  try {
    const ids = await seed(sqlite);
    recordingHooks(hookLog, ['posts', 'parts', 'media', 'ledger']);
    const KV = kvStore();
    runtime.env.KV = KV;
    let outcome;
    if (mode === 'http') {
      const { method, path, body } = scenario.http(ids);
      const response = await as(user, () => call(method, path, body));
      outcome = { status: response.status, body: normalizeBody(response.body) };
    } else {
      const actor = mode === 'service' ? actors.userActor(user, new Request('https://cms.test/admin/api/x', { method: 'POST' })) : actors.systemActor('sdk');
      const api = service.createService(runtime.env, { config: serviceConfig(), actor });
      try {
        const result = await scenario.service(api, ids);
        outcome = result === null && scenario.missing
          ? { status: 404, body: { error: scenario.missing } }
          : { status: scenario.created ? 201 : 200, body: normalizeBody(result ?? { success: true }) };
      } catch (error) {
        const response = httpErrors.toErrorResponse(error, 'parity');
        outcome = { status: response.status, body: normalizeBody(await response.json()) };
      }
    }
    return { outcome, rows: snapshot(sqlite), deletes: [...KV.deletes].sort(), hooks: hookLog.map((entry) => ({ ...entry, actorKind: undefined })) };
  } finally {
    for (const slug of ['posts', 'parts', 'media', 'ledger']) delete runtime.collectionHooks[slug];
    sqlite.close();
  }
}

const post = { title: 'New', body: doc('Text') };
const scenarios = [
  { name: 'create an entry', created: true, http: () => ({ method: 'POST', path: '/collections/posts/entries', body: { data: post, slug: 'new-post' } }),
    service: (api) => api.entries.create('posts', { data: post, slug: 'new-post' }) },
  { name: 'create an entry with a missing required field', http: () => ({ method: 'POST', path: '/collections/posts/entries', body: { data: { title: 'Only' } } }),
    service: (api) => api.entries.create('posts', { data: { title: 'Only' } }) },
  { name: 'create an entry with a taken slug', http: () => ({ method: 'POST', path: '/collections/posts/entries', body: { data: post, slug: 'p2' } }),
    service: (api) => api.entries.create('posts', { data: post, slug: 'p2' }) },
  { name: 'create an entry with a reserved id', http: () => ({ method: 'POST', path: '/collections/posts/entries', body: { data: post, id: 'new' } }),
    service: (api) => api.entries.create('posts', { data: post, id: 'new' }) },
  { name: 'update an entry with its token', http: (ids) => ({ method: 'PUT', path: '/collections/posts/entries/p2', body: { data: { ...post, title: 'Edited' }, expectedRevisionId: ids.revisionId } }),
    service: (api, ids) => api.entries.update('posts', 'p2', { data: { ...post, title: 'Edited' }, expect: { revisionId: ids.revisionId } }) },
  { name: 'update an entry with a stale token', http: () => ({ method: 'PUT', path: '/collections/posts/entries/p2', body: { data: post, expectedRevisionId: 'rev_stale' } }),
    service: (api) => api.entries.update('posts', 'p2', { data: post, expect: { revisionId: 'rev_stale' } }) },
  { name: 'update an entry without its token', asymmetry: 'trusted server code may leave the token out',
    http: () => ({ method: 'PUT', path: '/collections/posts/entries/p2', body: { data: post } }),
    service: (api) => api.entries.update('posts', 'p2', { data: post }) },
  { name: 'rename a draft', http: () => ({ method: 'PUT', path: '/collections/posts/entries/p1', body: { slug: 'renamed', expectedRevisionId: null } }),
    service: (api) => api.entries.update('posts', 'p1', { slug: 'renamed', expect: { revisionId: null } }) },
  { name: 'publish an incomplete draft', http: () => ({ method: 'POST', path: '/collections/posts/entries/incomplete/publish', body: { expectedRevisionId: null } }),
    service: (api) => api.entries.publish('posts', 'incomplete', { expect: { revisionId: null } }), adminOnly: true },
  { name: 'publish a draft', http: () => ({ method: 'POST', path: '/collections/posts/entries/p1/publish', body: { expectedRevisionId: null } }),
    service: (api) => api.entries.publish('posts', 'p1', { expect: { revisionId: null } }), adminOnly: true },
  { name: 'archive a published entry', http: (ids) => ({ method: 'POST', path: '/collections/posts/entries/p2/archive', body: { expectedRevisionId: ids.revisionId } }),
    service: (api, ids) => api.entries.archive('posts', 'p2', { expect: { revisionId: ids.revisionId } }), adminOnly: true },
  { name: 'restore a revision', http: (ids) => ({ method: 'POST', path: `/collections/posts/entries/p2/revisions/${ids.revisionId}/restore`, body: { expectedRevisionId: ids.revisionId } }),
    service: (api, ids) => api.revisions.restore('posts', 'p2', ids.revisionId, { expectedRevisionId: ids.revisionId }), adminOnly: true },
  { name: 'delete an entry', http: () => ({ method: 'DELETE', path: '/collections/posts/entries/p2' }),
    service: (api) => api.entries.remove('posts', 'p2'), adminOnly: true },
  { name: 'delete a missing entry', http: () => ({ method: 'DELETE', path: '/collections/posts/entries/nope' }),
    service: (api) => api.entries.remove('posts', 'nope'), adminOnly: true },
  { name: 'create a native record', created: true, http: () => ({ method: 'POST', path: '/collections/parts/entries', body: { data: { id: 'bolt', name: 'Bolt', quantity: 2 } } }),
    service: (api) => api.entries.create('parts', { data: { id: 'bolt', name: 'Bolt', quantity: 2 } }) },
  { name: 'create a native record with an unconfigured column', asymmetry: 'trusted server code may write any column',
    http: () => ({ method: 'POST', path: '/collections/parts/entries', body: { data: { id: 'bolt', name: 'Bolt', quantity: 2, internalNote: 'x' } } }),
    service: (api) => api.entries.create('parts', { data: { id: 'bolt', name: 'Bolt', quantity: 2, internalNote: 'x' } }), created: true },
  { name: 'update a native record with a stale updatedAt', http: () => ({ method: 'PUT', path: '/collections/parts/entries/frame', body: { data: { name: 'Stale' }, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' } }),
    service: (api) => api.entries.update('parts', 'frame', { data: { name: 'Stale' }, expect: { updatedAt: '2000-01-01T00:00:00.000Z' } }) },
  { name: 'update a native record with a blank optional column', http: () => ({ method: 'PUT', path: '/collections/parts/entries/frame', body: { data: { name: 'Frame 2', quantity: '' } } }),
    service: (api) => api.entries.update('parts', 'frame', { data: { name: 'Frame 2', quantity: '' } }) },
  { name: 'create a media record', asymmetry: 'trusted server code may create media records',
    http: () => ({ method: 'POST', path: '/collections/media/entries', body: { data: { id: 'm2', filename: 'b.png', url: '/api/media/m2', mimeType: 'image/png', sizeBytes: 5 } } }),
    service: (api) => api.entries.create('media', { data: { id: 'm2', filename: 'b.png', url: '/api/media/m2', mimeType: 'image/png', sizeBytes: 5 } }), created: true },
  { name: 'repoint a media record', http: () => ({ method: 'PUT', path: '/collections/media/entries/m1', body: { data: { url: '/api/media/other' } } }),
    service: (api) => api.entries.update('media', 'm1', { data: { url: '/api/media/other' } }), asymmetry: 'trusted server code may repoint media' },
  { name: 'write a read-only collection', asymmetry: 'trusted server code may write read-only collections',
    http: () => ({ method: 'POST', path: '/collections/ledger/entries', body: { data: { note: 'x' } } }),
    service: (api) => api.entries.create('ledger', { data: { note: 'x' } }), created: true },
  { name: 'read an entry', reads: true, http: () => ({ method: 'GET', path: '/collections/posts/entries/p2' }), service: (api) => api.entries.get('posts', 'p2') },
  { name: 'list a native collection', reads: true, http: () => ({ method: 'GET', path: '/collections/parts/entries' }), service: (api) => api.entries.list('parts') },
  { name: 'page entries', reads: true, http: () => ({ method: 'GET', path: '/collections/posts/entries?limit=2' }), service: (api) => api.entries.page('posts', { limit: 2 }) },
  { name: 'list revisions', reads: true, http: () => ({ method: 'GET', path: '/collections/posts/entries/p2/revisions' }), service: (api) => api.revisions.list('posts', 'p2') },
  { name: 'filter and sort entries', reads: true, http: () => ({ method: 'GET', path: '/collections/posts/entries?where[title][in]=Live,Draft&sort=-title' }),
    service: (api) => api.entries.list('posts', { where: { title: { in: ['Live', 'Draft'] } }, sort: '-title' }) },
  { name: 'page entries by offset', reads: true, http: () => ({ method: 'GET', path: '/collections/posts/entries?limit=1&offset=1&sort=title' }),
    service: (api) => api.entries.page('posts', { limit: 1, offset: 1, sort: 'title' }) },
  { name: 'read a missing entry', reads: true, missing: 'Entry not found', http: () => ({ method: 'GET', path: '/collections/posts/entries/nope' }), service: (api) => api.entries.get('posts', 'nope') },
  { name: 'list globals', reads: true, http: () => ({ method: 'GET', path: '/globals' }), service: (api) => api.globals.list() },
  { name: 'read a configured global', reads: true, http: () => ({ method: 'GET', path: '/globals/site' }), service: (api) => api.globals.get('site') },
  { name: 'read a missing global', reads: true, missing: 'Global not found', http: () => ({ method: 'GET', path: '/globals/missing' }), service: (api) => api.globals.get('missing') },
  { name: 'create a global', created: true, adminOnly: true, http: () => ({ method: 'POST', path: '/globals', body: { slug: 'footer', name: 'Footer', data: { note: 'Hi' } } }),
    service: (api) => api.globals.create({ slug: 'footer', name: 'Footer', data: { note: 'Hi' } }) },
  { name: 'create a global without a slug', adminOnly: true, http: () => ({ method: 'POST', path: '/globals', body: { name: 'Footer' } }), service: (api) => api.globals.create({ name: 'Footer' }) },
  { name: 'create a global with non-object data', adminOnly: true, http: () => ({ method: 'POST', path: '/globals', body: { slug: 'footer', data: 'text' } }), service: (api) => api.globals.create({ slug: 'footer', data: 'text' }) },
  { name: 'save a configured global', http: () => ({ method: 'POST', path: '/globals/site', body: { siteName: 'Talisman' } }), service: (api) => api.globals.save('site', { siteName: 'Talisman' }) },
  { name: 'save a configured global with a blank required field', http: () => ({ method: 'POST', path: '/globals/site', body: { siteName: ' ' } }), service: (api) => api.globals.save('site', { siteName: ' ' }) },
  { name: 'save a global that is neither configured nor stored', http: () => ({ method: 'POST', path: '/globals/brand-new', body: { note: 'x' } }), service: (api) => api.globals.save('brand-new', { note: 'x' }) },
  { name: 'save a non-object global', http: () => ({ method: 'POST', path: '/globals/site', body: ['no'] }), service: (api) => api.globals.save('site', ['no']) },
];

runtime.collections.push({ name: 'Ledger', slug: 'ledger', readOnly: true, fields: [{ name: 'note', label: 'Note', type: 'text' }] });

for (const scenario of scenarios) {
  test(`parity: ${scenario.name}`, { skip }, async (t) => {
    t.mock.method(console, 'error', () => {});
    for (const user of scenario.adminOnly ? [admin] : [editor, admin]) {
      const http = await run(scenario, 'http', user);
      const viaService = await run(scenario, 'service', user);
      assert.deepEqual(viaService, http, `${user.role}: the service with the same user matches the admin API`);
      assert.notEqual(http.outcome.status, 500, JSON.stringify(http.outcome.body));
    }
    const http = await run(scenario, 'http', admin);
    const sdk = await run(scenario, 'system', admin);
    if (scenario.reads) {
      // Server code reads through KV: a fill whose rows changed during the read drops its key, so
      // only the rows, hooks and outcome are compared for reads.
      delete http.deletes;
      delete sdk.deletes;
    }
    if (scenario.asymmetry) {
      assert.notDeepEqual(sdk, http, `${scenario.asymmetry}: the documented difference is real`);
      assert.ok(sdk.outcome.status < 400, `${scenario.asymmetry}: server code is not refused (${sdk.outcome.status} ${JSON.stringify(sdk.outcome.body)})`);
    } else {
      assert.deepEqual(sdk, http, 'trusted server code matches the admin API');
    }
  });
}
