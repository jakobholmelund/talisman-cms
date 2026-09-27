import assert from 'node:assert/strict';
import test from 'node:test';
import { as, call, database, doc, editor, hourAgo, runtime, skip } from './helpers/handler-harness.mjs';

let hooksModule;
let errors;
let actorModule;
if (!skip) {
  hooksModule = await import('../src/service/hooks.ts');
  errors = await import('../src/service/errors.ts');
  actorModule = await import('../src/service/actor.ts');
}

test('hooks run in order, before* results merge into the data, and failures name their phase', { skip }, async () => {
  const { runHooks } = hooksModule;
  const actor = actorModule.systemActor('test');
  const base = { actor, collection: { slug: 'posts', native: false }, operation: 'create' };
  const seen = [];
  const hooks = {
    beforeValidate: [
      ({ data }) => { seen.push(['v1', data]); return { a: 1 }; },
      ({ data }) => { seen.push(['v2', data]); },
      async ({ data }) => { seen.push(['v3', data]); return { b: 2, title: 'Set by hook' }; },
    ],
    afterChange: [({ doc }) => { seen.push(['after', doc.id]); return { ignored: true }; }],
  };
  const log = [];
  const merged = await runHooks(hooks, 'beforeValidate', { ...base, data: { title: 'Sent' } }, { log });
  assert.deepEqual(merged, { title: 'Set by hook', a: 1, b: 2 });
  assert.deepEqual(seen, [['v1', { title: 'Sent' }], ['v2', { title: 'Sent', a: 1 }], ['v3', { title: 'Sent', a: 1 }]]);
  assert.equal(await runHooks(hooks, 'afterChange', { ...base, data: merged, doc: { id: 'e1' } }, { log }), undefined);
  assert.deepEqual(log.map((entry) => [entry.hook, entry.actorKind, entry.dataKeys.join(',')]), [
    ['beforeValidate', 'system', 'title'], ['beforeValidate', 'system', 'a,title'], ['beforeValidate', 'system', 'a,title'], ['afterChange', 'system', 'a,b,title'],
  ]);

  // No hooks: the data comes back as it was.
  assert.deepEqual(await runHooks(undefined, 'beforeChange', { ...base, data: { x: 1 } }), { x: 1 });
  assert.deepEqual(await runHooks({}, 'beforeChange', { ...base, data: { x: 1 } }), { x: 1 });

  // A thrown service error is the refusal itself; anything else becomes a HookError for the phase.
  const refusing = { beforeChange: [() => { throw new errors.AccessDeniedError('Not yours'); }] };
  await assert.rejects(runHooks(refusing, 'beforeChange', { ...base, data: {} }), (error) => error instanceof errors.AccessDeniedError && error.message === 'Not yours');
  const failing = { afterDelete: [() => { throw new Error('Webhook failed'); }], beforeDelete: [() => { throw 'no'; }] };
  await assert.rejects(runHooks(failing, 'afterDelete', { ...base, operation: 'delete', originalDoc: {}, doc: {} }),
    (error) => error instanceof errors.HookError && error.phase === 'afterDelete' && error.committed === true && error.message === 'Webhook failed');
  await assert.rejects(runHooks(failing, 'beforeDelete', { ...base, operation: 'delete', originalDoc: {} }),
    (error) => error instanceof errors.HookError && error.phase === 'beforeDelete' && error.committed === false && error.message === 'A collection hook failed');
});

test('the admin API hands every hook its actor, request and collection', { skip }, async () => {
  const sqlite = database();
  const calls = [];
  const record = (name) => (args) => { calls.push({ name, ...args }); };
  try {
    runtime.collectionHooks.posts = { beforeValidate: [record('beforeValidate')], beforeChange: [record('beforeChange')], afterChange: [record('afterChange')], beforeDelete: [record('beforeDelete')], afterDelete: [record('afterDelete')] };
    runtime.collectionHooks.parts = { beforeChange: [record('parts:beforeChange')] };
    const created = await as(editor, () => call('POST', '/collections/posts/entries', { data: { title: 'T', body: doc('B') } }));
    assert.equal(created.status, 201);
    assert.equal((await call('DELETE', `/collections/posts/entries/${created.body.id}`)).status, 200);
    sqlite.prepare('INSERT INTO test_parts (id, name, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('frame', 'Frame', 7, hourAgo, hourAgo);
    assert.equal((await call('PUT', '/collections/parts/entries/frame', { data: { name: 'Frame 2' } })).status, 200);

    assert.deepEqual(calls.map((entry) => entry.name), ['beforeValidate', 'beforeChange', 'afterChange', 'beforeDelete', 'afterDelete', 'parts:beforeChange']);
    for (const entry of calls) {
      assert.equal(entry.actor.kind, 'user', entry.name);
      assert.ok(entry.req instanceof Request, entry.name);
      assert.equal(entry.actor.request, entry.req, entry.name);
    }
    assert.deepEqual(calls.slice(0, 3).map((entry) => [entry.actor.user.role, entry.operation, entry.collection]),
      Array(3).fill(['editor', 'create', { slug: 'posts', native: false }]));
    assert.deepEqual(calls.slice(3, 5).map((entry) => [entry.actor.user.role, entry.operation, entry.originalDoc.id]),
      Array(2).fill(['admin', 'delete', created.body.id]));
    assert.deepEqual([calls[5].operation, calls[5].collection, calls[5].originalDoc.data.name], ['update', { slug: 'parts', native: true }, 'Frame']);
  } finally {
    delete runtime.collectionHooks.posts;
    delete runtime.collectionHooks.parts;
    sqlite.close();
  }
});
