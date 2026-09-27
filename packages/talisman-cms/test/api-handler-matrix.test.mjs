import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL, admin, as, call, database, doc, editor, hourAgo, runtime, seedPost, skip } from './helpers/handler-harness.mjs';

// Every admin API route against an anonymous request, an editor and an administrator, with the
// status each gets today. A refused request must leave every row as it was. The rows also cover
// the variants of the admin-only route patterns (a trailing slash, a longer last segment, an extra
// segment and a prefixed path), which must never let an editor through.

runtime.collections.push({
  name: 'Ledger',
  slug: 'ledger',
  readOnly: true,
  fields: [{ name: 'note', label: 'Note', type: 'text' }],
});

const anonymous = null;
const roles = [['anonymous', anonymous], ['editor', editor], ['admin', admin]];
const invalidJson = '{not json';

/** The rows a refused request must not change. */
function snapshot(sqlite) {
  const rows = (table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  return {
    entries: rows('galaxy_entries'),
    revisions: rows('galaxy_entry_revisions'),
    globals: rows('galaxy_globals'),
    parts: rows('test_parts'),
    media: rows('galaxy_media'),
  };
}

/** A draft post, a published post with one revision, a native part and a media record. */
async function seed(sqlite) {
  await seedPost(sqlite, 'p1', { title: 'Draft', body: doc('Text') }, 'draft');
  await seedPost(sqlite, 'p2', { title: 'Live', body: doc('Text') }, 'published');
  sqlite.prepare('INSERT INTO test_parts (id, name, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('frame', 'Frame', 7, hourAgo, hourAgo);
  sqlite.prepare(`INSERT INTO galaxy_media (id, filename, mime_type, size_bytes, url, created_at, updated_at)
    VALUES ('m1', 'a.png', 'image/png', 10, '/api/media/m1', ?, ?)`).run(hourAgo, hourAgo);
  const saved = await call('PUT', '/collections/posts/entries/p2', { data: { title: 'Live', body: doc('Text') }, expectedRevisionId: null });
  assert.equal(saved.status, 200);
  const latest = await call('GET', '/collections/posts/entries/p2');
  return { revisionId: latest.body.latestRevisionId };
}

/** Like `call`, for a URL outside the admin's API base. */
async function callUrl(method, url, body) {
  const request = new Request(url, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const response = await ALL({ request, locals: {} });
  return { status: response.status, body: await response.json() };
}

const post = { data: { title: 'New', body: doc('Text') } };
const token = { expectedRevisionId: null };

// `expect` gives the status per role; `null` leaves a role unasserted. `path` and `body` may take
// the seed's ids. `check` runs extra assertions on a role's response.
const routes = [
  { method: 'GET', path: '/health', expect: { anonymous: 200, editor: 200, admin: 200 } },
  {
    method: 'GET', path: '/collections', expect: { anonymous: 401, editor: 200, admin: 200 },
    check: (role, res) => role !== 'anonymous' && assert.equal(res.body.some((collection) => collection.slug === 'notes'), role === 'admin', 'admin-only collections are listed for admins'),
  },

  { method: 'GET', path: '/globals', expect: { anonymous: 401, editor: 200, admin: 200 } },
  { method: 'GET', path: '/globals/site', expect: { anonymous: 401, editor: 200, admin: 200 } },
  { method: 'GET', path: '/globals/missing', expect: { anonymous: 401, editor: 404, admin: 404 } },
  {
    method: 'POST', path: '/globals', body: { slug: 'footer', name: 'Footer' }, expect: { anonymous: 401, editor: 403, admin: 201 },
    check: (role, res) => role === 'editor' && assert.equal(res.body.error, 'Admin access required'),
  },
  { method: 'POST', path: '/globals', body: invalidJson, expect: { anonymous: 401, editor: 403, admin: 400 } },
  { method: 'POST', path: '/globals/site', body: { siteName: 'Site' }, expect: { anonymous: 401, editor: 200, admin: 200 } },
  {
    method: 'POST', path: '/globals/brand-new', body: { note: 'x' }, expect: { anonymous: 401, editor: 403, admin: 200 },
    check: (role, res) => role === 'editor' && assert.equal(res.body.error, 'Only administrators can create globals'),
  },
  { method: 'POST', path: '/globals/', body: { slug: 'footer' }, expect: { anonymous: 401, editor: 404, admin: 404 } },
  { method: 'POST', path: '/globalsx', body: { slug: 'footer' }, expect: { anonymous: 401, editor: 404, admin: 404 } },
  { method: 'DELETE', path: '/globals/site', expect: { anonymous: 401, editor: 403, admin: 404 } },

  { method: 'GET', path: '/collections/posts/entries', expect: { anonymous: 401, editor: 200, admin: 200 } },
  {
    method: 'GET', path: '/collections/posts/entries?limit=1', expect: { anonymous: 401, editor: 200, admin: 200 },
    check: (role, res) => role !== 'anonymous' && assert.deepEqual([res.body.docs.length, typeof res.body.nextCursor], [1, 'string']),
  },
  { method: 'POST', path: '/collections/posts/entries', body: post, expect: { anonymous: 401, editor: 201, admin: 201 } },
  { method: 'POST', path: '/collections/posts/entries', body: invalidJson, expect: { anonymous: 401, editor: 400, admin: 400 } },
  {
    method: 'GET', path: '/collections/posts/entries/p2', expect: { anonymous: 401, editor: 200, admin: 200 },
    check: (role, res, sqlite, ids) => role !== 'anonymous' && assert.equal(res.body.latestRevisionId, ids.revisionId),
  },
  { method: 'GET', path: '/collections/posts/entries/missing', expect: { anonymous: 401, editor: 404, admin: 404 } },
  { method: 'PUT', path: '/collections/posts/entries/p1', body: { ...post, ...token }, expect: { anonymous: 401, editor: 200, admin: 200 } },
  { method: 'PUT', path: '/collections/posts/entries/p2', body: post, expect: { anonymous: 401, editor: 428, admin: 428 } },
  { method: 'PUT', path: '/collections/posts/entries', body: { ...post, ...token }, expect: { anonymous: 401, editor: 400, admin: 400 } },
  {
    method: 'DELETE', path: '/collections/posts/entries/p2', expect: { anonymous: 401, editor: 403, admin: 200 },
    check: (role, res) => role === 'editor' && assert.equal(res.body.error, 'Admin access required'),
  },
  { method: 'DELETE', path: '/collections/posts/entries', expect: { anonymous: 401, editor: 403, admin: 400 } },
  { method: 'POST', path: '/collections/posts/entries/p1/publish', body: token, expect: { anonymous: 401, editor: 403, admin: 200 } },
  { method: 'POST', path: '/collections/posts/entries/p2/archive', body: (ids) => ({ expectedRevisionId: ids.revisionId }), expect: { anonymous: 401, editor: 403, admin: 200 } },
  // The guard answers before the body is read.
  { method: 'POST', path: '/collections/posts/entries/p2/archive', body: invalidJson, expect: { anonymous: 401, editor: 403, admin: null } },
  { method: 'POST', path: '/collections/posts/entries/p1/publish/', body: token, expect: { anonymous: 401, editor: 404, admin: 404 } },
  { method: 'POST', path: '/collections/posts/entries/p1/publishx', body: token, expect: { anonymous: 401, editor: 404, admin: 404 } },
  { method: 'POST', path: '/collections/posts/entries/p1/publish/extra', body: token, expect: { anonymous: 401, editor: 404, admin: 404 } },
  { method: 'POST', url: 'https://cms.test/x/admin/api/collections/posts/entries/p1/publish', body: token, expect: { anonymous: 401, editor: 403, admin: null } },
  { method: 'GET', path: '/collections/posts/entries/p1/publish', expect: { anonymous: 401, editor: 405, admin: 405 } },

  { method: 'GET', path: '/collections/posts/entries/p2/revisions', expect: { anonymous: 401, editor: 200, admin: 200 } },
  { method: 'GET', path: (ids) => `/collections/posts/entries/p2/revisions/${ids.revisionId}`, expect: { anonymous: 401, editor: 200, admin: 200 } },
  { method: 'GET', path: '/collections/posts/entries/p2/revisions/missing', expect: { anonymous: 401, editor: 404, admin: 404 } },
  {
    method: 'POST', path: (ids) => `/collections/posts/entries/p2/revisions/${ids.revisionId}/restore`,
    body: (ids) => ({ expectedRevisionId: ids.revisionId }), expect: { anonymous: 401, editor: 403, admin: 200 },
  },
  {
    method: 'POST', path: (ids) => `/collections/posts/entries/p2/revisions/${ids.revisionId}/restore`,
    body: invalidJson, expect: { anonymous: 401, editor: 403, admin: 428 },
  },
  {
    method: 'POST', path: (ids) => `/collections/posts/entries/p2/revisions/${ids.revisionId}/restore/`,
    body: (ids) => ({ expectedRevisionId: ids.revisionId }), expect: { anonymous: 401, editor: 404, admin: 404 },
  },
  { method: 'DELETE', path: '/collections/posts/entries/p2/revisions', expect: { anonymous: 401, editor: 403, admin: 405 } },

  { method: 'GET', path: '/collections/notes/entries', expect: { anonymous: 401, editor: 403, admin: 200 } },
  { method: 'GET', path: '/collections/notes/entries/missing', expect: { anonymous: 401, editor: 403, admin: 404 } },
  // `access.read` alone does not restrict the other operations.
  { method: 'POST', path: '/collections/notes/entries', body: { data: { text: 'Note' } }, expect: { anonymous: 401, editor: 201, admin: 201 } },

  { method: 'GET', path: '/collections/parts/entries', expect: { anonymous: 401, editor: 200, admin: 200 } },
  { method: 'GET', path: '/collections/parts/entries/frame', expect: { anonymous: 401, editor: 200, admin: 200 } },
  { method: 'POST', path: '/collections/parts/entries', body: { data: { id: 'bolt', name: 'Bolt', quantity: 1 } }, expect: { anonymous: 401, editor: 201, admin: 201 } },
  { method: 'PUT', path: '/collections/parts/entries/frame', body: { data: { name: 'Frame 2' } }, expect: { anonymous: 401, editor: 200, admin: 200 } },
  { method: 'DELETE', path: '/collections/parts/entries/frame', expect: { anonymous: 401, editor: 403, admin: 200 } },
  { method: 'POST', path: '/collections/parts/entries/frame/publish', body: {}, expect: { anonymous: 401, editor: 403, admin: 400 } },
  { method: 'GET', path: '/collections/parts/entries/frame/revisions', expect: { anonymous: 401, editor: 400, admin: 400 } },

  { method: 'GET', path: '/collections/media/entries', expect: { anonymous: 401, editor: 200, admin: 200 } },
  { method: 'POST', path: '/collections/media/entries', body: { data: { filename: 'b.png' } }, expect: { anonymous: 401, editor: 403, admin: 403 } },
  { method: 'DELETE', path: '/collections/media/entries/m1', expect: { anonymous: 401, editor: 403, admin: 200 } },

  { method: 'GET', path: '/collections/ledger/entries', expect: { anonymous: 401, editor: 200, admin: 200 } },
  {
    method: 'POST', path: '/collections/ledger/entries', body: { data: { note: 'x' } }, expect: { anonymous: 401, editor: 403, admin: 403 },
    check: (role, res) => role !== 'anonymous' && assert.equal(res.body.error, 'This collection is read-only'),
  },
  { method: 'DELETE', path: '/collections/ledger/entries/x', expect: { anonymous: 401, editor: 403, admin: 403 } },
  { method: 'POST', path: '/collections/ledger/entries/x/publish', body: token, expect: { anonymous: 401, editor: 403, admin: 403 } },

  { method: 'GET', path: '/collections/nope/entries', expect: { anonymous: 401, editor: 404, admin: 404 } },
  { method: 'GET', path: '/nothing', expect: { anonymous: 401, editor: 404, admin: 404 } },
];

for (const route of routes) {
  const label = route.url ?? (typeof route.path === 'function' ? route.path({ revisionId: ':revisionId' }) : route.path);
  const expected = roles.map(([role]) => `${role} ${route.expect[role] ?? '-'}`).join(', ');
  test(`${route.method} ${label}${typeof route.body === 'string' ? ' (invalid JSON)' : ''}: ${expected}`, { skip }, async () => {
    for (const [role, user] of roles) {
      const status = route.expect[role];
      if (status === null) continue;
      const sqlite = database();
      try {
        const ids = await seed(sqlite);
        const path = typeof route.path === 'function' ? route.path(ids) : route.path;
        const body = typeof route.body === 'function' ? route.body(ids) : route.body;
        const before = snapshot(sqlite);
        const response = await as(user, () => route.url ? callUrl(route.method, route.url, body) : call(route.method, path, body));
        assert.equal(response.status, status, `${role}: ${route.method} ${route.url ?? path} answered ${response.status} ${JSON.stringify(response.body)}`);
        if (response.status >= 400) {
          assert.deepEqual(snapshot(sqlite), before, `${role}: a refused ${route.method} ${route.url ?? path} changed a row`);
          assert.equal(typeof response.body.error, 'string', `${role}: a refusal names its reason`);
        }
        if (route.check) route.check(role, response, sqlite, ids);
      } finally {
        sqlite.close();
      }
    }
  });
}

test('a create that loses a unique-constraint race answers 409 without the statement and writes nothing', { skip }, async () => {
  const sqlite = database();
  try {
    await seedPost(sqlite, 'p1', { title: 'Draft', body: doc('Text') }, 'draft');
    const { id: collectionId } = sqlite.prepare(`SELECT id FROM galaxy_collections WHERE slug = 'posts'`).get();
    // Another request commits the same id between validation and the insert; a different slug keeps
    // the slug check out of the way, so the insert itself hits the primary key.
    runtime.collectionHooks.posts = {
      beforeChange: [() => {
        sqlite.prepare(`INSERT INTO galaxy_entries (id, collection_id, slug, status, data, created_at, updated_at)
          VALUES ('dup', ?, 'taken-first', 'draft', '{"title":"First"}', ?, ?)`).run(collectionId, hourAgo, hourAgo);
      }],
    };
    const lost = await call('POST', '/collections/posts/entries', { id: 'dup', slug: 'second', ...post });
    assert.equal(lost.status, 409);
    assert.equal(lost.body.error, 'Another record already uses this id.');
    assert.doesNotMatch(JSON.stringify(lost.body), /INSERT|galaxy_entries|Failed query/i);

    const rows = sqlite.prepare(`SELECT slug, data FROM galaxy_entries WHERE id = 'dup'`).all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [{ slug: 'taken-first', data: '{"title":"First"}' }]);
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS total FROM galaxy_entry_revisions WHERE entry_id = 'dup'`).get().total, 0);
  } finally {
    delete runtime.collectionHooks.posts;
    sqlite.close();
  }
});
