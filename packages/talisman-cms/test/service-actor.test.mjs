import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
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

if (!skip) {
  const uiUrl = new URL('../ui/', import.meta.url).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(uiUrl) && specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      return nextResolve(specifier, context);
    },
  });
}
const permissionsModule = !skip ? await import('../ui/lib/collection-permissions.ts') : null;

test('editor capabilities follow server user-actor authorization across collection policies', { skip }, () => {
  const operations = ['read', 'create', 'update', 'delete', 'publish', 'archive', 'restore'];
  // Exhaust the independent read/create/update/delete requirements, readOnly, role and mapping.
  for (const role of ['admin', 'editor']) for (let mask = 0; mask < 16; mask++) {
    for (const readOnly of [false, true]) for (const schemaPath of [null, 'example/schema', 'talisman-cms/db/media']) {
      const collection = { name: 'Fixture', slug: 'fixture', readOnly, access: Object.fromEntries(
        ['read', 'create', 'update', 'delete'].map((operation, index) => [operation, mask & (1 << index) ? 'admin' : 'editor'])
      ), ...(schemaPath ? { nativeSchemaMapping: { schemaPath, exportName: 'fixture' } } : {}) };
      const user = { id: 'staff', email: 'staff@example.test', role };
      const actor = actorModule.userActor(user, request());
      const permissions = permissionsModule.getCollectionPermissions(collection, user);
      for (const operation of operations) {
        let serverAllowed = true;
        try { actorModule.assertAllowed(actor, collection, operation); } catch { serverAllowed = false; }
        // The UI must also be able to read an entry, and native records have no revision workflow.
        const expected = serverAllowed && permissions.canRead &&
          (!['publish', 'archive', 'restore'].includes(operation) || !schemaPath);
        assert.equal(permissions[`can${operation[0].toUpperCase()}${operation.slice(1)}`], expected,
          `${role} ${operation} ${JSON.stringify(collection)}`);
      }
      assert.equal(permissions.canUpload, schemaPath === 'talisman-cms/db/media' && permissions.canRead && !readOnly &&
        (role === 'admin' || collection.access.create !== 'admin'));
    }
  }
});

test('missing collections and non-staff users expose no editor capabilities', { skip }, () => {
  for (const collection of [null, undefined, {}]) for (const user of [null, undefined, {}, { role: 'customer' }]) {
    assert.ok(Object.values(permissionsModule.getCollectionPermissions(collection, user)).every(value => value === false));
  }
});

test('write notices distinguish server-managed, upload-only and role-restricted collections', { skip }, () => {
  const { getCollectionWriteNotice } = permissionsModule;
  const editor = { role: 'editor' };
  assert.match(getCollectionWriteNotice({ readOnly: true }, { role: 'admin' }, 'update'), /read-only/);
  assert.match(getCollectionWriteNotice({ nativeSchemaMapping: { schemaPath: 'talisman-cms/db/media' } }, editor, 'create'), /uploading/);
  assert.match(getCollectionWriteNotice({ access: { create: 'admin' } }, editor, 'create'), /administrators can create/);
  assert.match(getCollectionWriteNotice({ access: { update: 'admin' } }, editor, 'update'), /view this entry/);
  assert.equal(getCollectionWriteNotice({}, editor, 'update'), null);
  assert.equal(getCollectionWriteNotice(null, editor, 'create'), null);
  assert.equal(getCollectionWriteNotice(undefined, editor, 'update'), null);
});
