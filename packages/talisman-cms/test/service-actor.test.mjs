import assert from 'node:assert/strict';
import test from 'node:test';
import { skip } from './helpers/handler-harness.mjs';

let actorModule;
let errors;
if (!skip) {
  actorModule = await import('../src/service/actor.ts');
  errors = await import('../src/service/errors.ts');
}

const request = () => new Request('https://cms.test/admin/api/collections/posts/entries', { method: 'POST' });

test('authorization rules apply to users per operation, with the admin API messages, and never to system code', { skip }, () => {
  const { assertAllowed, canRead, systemActor, userActor, actorRole } = actorModule;
  const editor = userActor({ id: 'e', email: 'editor@example.test', role: 'editor' }, request());
  const admin = userActor({ id: 'a', email: 'admin@example.test', role: 'admin' }, request());
  const system = systemActor('test');
  const plugin = { kind: 'plugin', plugin: 'commerce' };

  const open = { name: 'Posts', slug: 'posts' };
  const adminRead = { name: 'Notes', slug: 'notes', access: { read: 'admin' } };
  const adminWrites = { name: 'Settings', slug: 'settings', access: { create: 'admin', update: 'admin', delete: 'admin' } };
  const readOnly = { name: 'Ledger', slug: 'ledger', readOnly: true };
  const media = { name: 'Media', slug: 'media', nativeSchemaMapping: { schemaPath: 'talisman-cms/db/media', exportName: 'media' } };
  const operations = ['read', 'create', 'update', 'delete', 'publish', 'archive', 'restore'];

  // [actor, collection, operation, refusal message or null]
  const rows = [
    ...operations.map((operation) => [admin, open, operation, null]),
    [editor, open, 'read', null], [editor, open, 'create', null], [editor, open, 'update', null],
    [editor, open, 'delete', 'Admin access required'],
    [editor, open, 'publish', 'Admin access required'], [editor, open, 'archive', 'Admin access required'], [editor, open, 'restore', 'Admin access required'],
    [editor, adminRead, 'read', 'Collection access denied'], [editor, adminRead, 'create', null], [admin, adminRead, 'read', null],
    [editor, adminWrites, 'read', null], [editor, adminWrites, 'create', 'Collection access denied'], [editor, adminWrites, 'update', 'Collection access denied'],
    [admin, adminWrites, 'delete', null],
    [editor, readOnly, 'read', null], [editor, readOnly, 'create', 'This collection is read-only'], [editor, readOnly, 'update', 'This collection is read-only'],
    [admin, readOnly, 'delete', 'This collection is read-only'], [admin, readOnly, 'publish', 'Collection access denied'], [admin, readOnly, 'restore', 'Collection access denied'],
    [editor, media, 'create', 'Media records are created by uploading a file to the media library.'],
    [admin, media, 'create', 'Media records are created by uploading a file to the media library.'],
    [editor, media, 'update', null], [admin, media, 'delete', null],
    ...operations.flatMap((operation) => [[system, readOnly, operation, null], [system, media, operation, null], [system, adminRead, operation, null], [plugin, adminWrites, operation, null]]),
  ];
  for (const [actor, collection, operation, message] of rows) {
    const label = `${actor.kind === 'user' ? actor.user.role : actor.kind} ${operation} ${collection.slug}`;
    if (message === null) {
      assert.doesNotThrow(() => assertAllowed(actor, collection, operation), label);
    } else {
      assert.throws(() => assertAllowed(actor, collection, operation),
        (error) => error instanceof errors.AccessDeniedError && error.status === 403 && error.message === message, label);
    }
  }

  // Relation targets embed what the actor may read; system reads embed what an editor may read.
  assert.equal(canRead(editor, adminRead), false);
  assert.equal(canRead(admin, adminRead), true);
  assert.equal(canRead(system, adminRead), false);
  assert.equal(canRead(system, open), true);
  assert.equal(canRead(plugin, adminRead), false);

  assert.deepEqual([actorRole(editor), actorRole(admin), actorRole(system), actorRole(plugin)], ['editor', 'admin', 'admin', 'admin']);
  assert.deepEqual(systemActor(), { kind: 'system', label: undefined });
});
