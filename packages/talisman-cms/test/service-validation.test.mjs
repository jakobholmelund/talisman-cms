import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { call, database, doc, editor, hourAgo, parts, runtime, skip } from './helpers/handler-harness.mjs';

let validation;
let errors;
let actors;
if (!skip) {
  validation = await import('../src/service/validation.ts');
  errors = await import('../src/service/errors.ts');
  actors = await import('../src/service/actor.ts');
}

const request = () => new Request('https://cms.test/admin/api/collections/posts/entries', { method: 'POST' });
const user = (role) => actors.userActor({ id: role, email: `${role}@example.test`, role }, request());
const collectionFor = (slug) => {
  const config = runtime.collections.find((collection) => collection.slug === slug);
  const nativeTable = runtime.nativeSchemas[slug] ?? null;
  return { config, slug, activeFields: config.fields, nativeTable, nativeIdCol: config.nativeSchemaMapping?.idColumn || 'id' };
};
const write = (overrides) => validation.prepareWrite({ uiLibraries: [], req: request(), ...overrides });
const rejects = (promise, type, check) => assert.rejects(promise, (error) => {
  assert.ok(error instanceof type, `${error.name}: ${error.message}`);
  if (check) check(error);
  return true;
});

test('entry writes check the data shape, the id and slug formats, the schema and the hook order', { skip }, async () => {
  const posts = collectionFor('posts');
  const valid = { title: 'Title', body: doc('Text') };

  await rejects(write({ collection: posts, operation: 'create', actor: user('editor'), data: '{not json' }), errors.InvalidInputError,
    (error) => assert.equal(error.message, 'Entry data is not valid JSON.'));
  await rejects(write({ collection: posts, operation: 'create', actor: user('editor'), data: ['no'] }), errors.InvalidInputError,
    (error) => assert.equal(error.message, 'Entry data must be a JSON object.'));
  await rejects(write({ collection: posts, operation: 'create', actor: user('editor'), data: valid, id: 'new' }), errors.ValidationError,
    (error) => assert.deepEqual(error.issues, [{ path: [], message: 'Entry id "new" is reserved' }]));
  await rejects(write({ collection: posts, operation: 'create', actor: user('editor'), data: valid, slug: 'a//b' }), errors.ValidationError);
  await rejects(write({ collection: posts, operation: 'create', actor: user('editor'), data: { title: '  ' } }), errors.ValidationError,
    (error) => assert.deepEqual(error.issues.map((issue) => issue.path[0]).sort(), ['body', 'title']));
  // Data left out is an empty record, which the schema then judges.
  await rejects(write({ collection: posts, operation: 'create', actor: user('editor') }), errors.ValidationError);

  // JSON text is accepted; hooks run before validation and after it, each seeing the previous result.
  const seen = [];
  const hooks = {
    beforeValidate: [({ data, actor, collection }) => { seen.push(['validate', data.title, actor.kind, collection.slug]); return { title: `${data.title}!` }; }],
    beforeChange: [({ data }) => { seen.push(['change', data.title]); return { summary: 'Added by hook' }; }],
  };
  const prepared = await write({ collection: posts, operation: 'create', actor: user('editor'), data: JSON.stringify(valid), id: 'chosen', slug: 'chosen-slug', hooks });
  assert.deepEqual(prepared, { data: { ...valid, title: 'Title!', summary: 'Added by hook' }, id: 'chosen', slug: 'chosen-slug' });
  assert.deepEqual(seen, [['validate', 'Title', 'user', 'posts'], ['change', 'Title!']]);

  // An update that only renames runs no hook and checks only a changed slug.
  const stored = { slug: 'legacy slug', draftSlug: null };
  assert.deepEqual(await write({ collection: posts, operation: 'update', actor: user('editor'), slug: 'legacy slug', stored, hooks }), { slug: 'legacy slug' });
  assert.deepEqual(await write({ collection: posts, operation: 'update', actor: user('editor'), stored, hooks }), { slug: undefined });
  await rejects(write({ collection: posts, operation: 'update', actor: user('editor'), slug: 'bad slug', stored }), errors.ValidationError);
  assert.equal(seen.length, 2);
});

test('native writes keep users to the configured columns and let server code write any column', { skip }, async () => {
  const collection = collectionFor('parts');
  const system = actors.systemActor('test');

  await rejects(write({ collection, operation: 'create', actor: user('editor'), data: { id: 'bolt', name: 'Bolt', quantity: 1, internalNote: 'x' } }), errors.ValidationError,
    (error) => assert.deepEqual(error.issues, [{ path: ['internalNote'], message: 'Not a field of this collection, so it cannot be saved here' }]));
  await rejects(write({ collection, operation: 'create', actor: user('editor'), data: { id: 'bad id!', name: 'Bolt', quantity: 1 } }), errors.ValidationError,
    (error) => assert.deepEqual(error.issues[0].path, ['id']));
  await rejects(write({ collection, operation: 'create', actor: user('editor'), data: { name: 'Bolt', quantity: 1 }, id: 1.5 }), errors.ValidationError,
    (error) => assert.deepEqual(error.issues, [{ path: [], message: 'Record id must be a whole number or text' }]));

  const asUser = await write({ collection, operation: 'create', actor: user('editor'), data: { id: 'bolt', name: 'Bolt', quantity: 1, createdAt: 'sent back', updatedAt: '' } });
  assert.deepEqual(Object.keys(asUser.nativePayload).sort(), ['createdAt', 'id', 'name', 'quantity', 'updatedAt']);
  assert.ok(asUser.nativePayload.createdAt instanceof Date, 'users never write the timestamps');
  assert.equal(asUser.nativePayload.id, 'bolt');

  // Server code owns its tables: unconfigured columns and its own timestamps go through.
  const stamp = new Date(1_600_000_000_000);
  const asSystem = await write({ collection, operation: 'create', actor: system, data: { id: 'nut', name: 'Nut', quantity: 2, internalNote: 'kept', createdAt: stamp } });
  assert.equal(asSystem.nativePayload.internalNote, 'kept');
  assert.equal(asSystem.nativePayload.createdAt, stamp);
  assert.ok(asSystem.nativePayload.updatedAt instanceof Date);
  // Unless it asks for the users' rules.
  await rejects(write({ collection, operation: 'create', actor: system, columns: 'configured', data: { id: 'nut', name: 'Nut', quantity: 2, internalNote: 'x' } }), errors.ValidationError);
  // Validation still applies to everyone.
  await rejects(write({ collection, operation: 'create', actor: system, data: { id: 'nut', name: '', quantity: 2 } }), errors.ValidationError,
    (error) => assert.deepEqual(error.issues.map((issue) => issue.path[0]), ['name']));

  // An update writes the columns it sends, moves updatedAt past the stored value, and never the id.
  const stored = { id: 'frame', name: 'Frame', quantity: 7, createdAt: new Date(hourAgo * 1000), updatedAt: new Date(Date.now() + 60_000) };
  const updated = await write({ collection, operation: 'update', actor: user('editor'), data: { id: 'other', name: 'Frame 2', quantity: 7 }, stored });
  assert.deepEqual(Object.keys(updated.nativePayload).sort(), ['name', 'quantity', 'updatedAt']);
  assert.equal(updated.nativePayload.updatedAt.getTime(), stored.updatedAt.getTime() + 1000);
  const partial = await write({ collection, operation: 'update', actor: user('editor'), data: { quantity: 8 }, stored });
  assert.deepEqual(Object.keys(partial.nativePayload).sort(), ['quantity', 'updatedAt'], 'a partial update leaves the other required columns alone');
  const stamped = await write({ collection, operation: 'update', actor: system, data: { updatedAt: stamp }, stored });
  assert.equal(stamped.nativePayload.updatedAt, stamp, 'server code may set updatedAt itself');

  // The media collection's url and type are set by the upload.
  const media = collectionFor('media');
  const storedMedia = { id: 'm1', filename: 'a.png', url: '/api/media/m1', mimeType: 'image/png', altText: null };
  await rejects(write({ collection: media, operation: 'update', actor: user('editor'), data: { url: 'https://elsewhere.test/x.png' }, stored: storedMedia }), errors.ValidationError,
    (error) => assert.deepEqual(error.issues, [{ path: ['url'], message: 'Set by the upload and cannot be changed' }]));
  const relabeled = await write({ collection: media, operation: 'update', actor: user('editor'), data: { url: '/api/media/m1', mimeType: 'image/png', altText: 'Alt' }, stored: storedMedia });
  assert.deepEqual(Object.keys(relabeled.nativePayload).sort(), ['altText', 'updatedAt']);
});

test('native ids and timestamps follow the table: defaults are kept, integer keys and text timestamps are left alone', { skip }, async () => {
  const { prepareNativeWrite } = validation;
  let orderNumber = 0;
  const tables = {
    counters: sqliteTable('test_counters', {
      id: integer('id').primaryKey({ autoIncrement: true }),
      label: text('label').notNull(),
      createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
      updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    }),
    orders: sqliteTable('test_orders', { id: text('id').primaryKey().$defaultFn(() => `ord_${++orderNumber}`), total: integer('total').notNull() }),
    notes: sqliteTable('test_notes', {
      id: text('id').primaryKey(),
      body: text('body').notNull(),
      createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
      updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    }),
  };
  const collection = (slug, fields) => ({ config: { name: slug, slug, fields }, slug, activeFields: fields, nativeTable: tables[slug], nativeIdCol: 'id' });
  const counters = collection('counters', [{ name: 'label', type: 'text' }]);
  const orders = collection('orders', [{ name: 'id', type: 'text' }, { name: 'total', type: 'number' }]);
  const notes = collection('notes', [{ name: 'id', type: 'text' }, { name: 'body', type: 'text' }]);

  for (const trusted of [true, false]) {
    const counter = prepareNativeWrite(counters, { label: 'First' }, { mode: 'create', trusted });
    assert.equal('id' in counter, false, 'an integer key is left to the table');
    assert.ok(counter.createdAt instanceof Date && counter.updatedAt instanceof Date, 'integer timestamps without a default are filled');
    const order = prepareNativeWrite(orders, { total: 5 }, { mode: 'create', trusted });
    assert.equal('id' in order, false, 'a $defaultFn id comes from the table');
    assert.equal(prepareNativeWrite(orders, { id: 'ord_custom', total: 5 }, { mode: 'create', trusted }).id, 'ord_custom');
    const note = prepareNativeWrite(notes, { id: 'n1', body: 'Hello' }, { mode: 'create', trusted });
    assert.deepEqual(note, { id: 'n1', body: 'Hello' }, 'text timestamps keep CURRENT_TIMESTAMP');
    const edited = prepareNativeWrite(notes, { body: 'Edited' }, { mode: 'update', trusted, stored: { id: 'n1', updatedAt: '2026-01-01 00:00:00' } });
    assert.deepEqual(edited, { body: 'Edited' }, 'and are not stamped with a Date on update');
  }
  assert.match(prepareNativeWrite(collectionFor('parts'), { name: 'Bolt' }, { mode: 'create', trusted: false }).id, /^\d+-[a-z0-9]+$/, 'a text key without a default is generated');
  assert.equal(prepareNativeWrite(notes, { id: 'n1', body: 'x', updatedAt: '2026-09-26 12:00:00' }, { mode: 'update', trusted: true, stored: {} }).updatedAt, '2026-09-26 12:00:00');
});

test('through the admin API, a native table whose id has its own default keeps that id', { skip }, async () => {
  const sqlite = database();
  let orderNumber = 0;
  sqlite.exec('CREATE TABLE test_orders (id text PRIMARY KEY NOT NULL, total integer NOT NULL)');
  runtime.nativeSchemas.orders = sqliteTable('test_orders', { id: text('id').primaryKey().$defaultFn(() => `ord_${++orderNumber}`), total: integer('total').notNull() });
  runtime.collections.push({
    name: 'Orders', slug: 'orders',
    fields: [{ name: 'id', label: 'ID', type: 'text' }, { name: 'total', label: 'Total', type: 'number', required: true }],
    nativeSchemaMapping: { schemaPath: 'test', exportName: 'orders', idColumn: 'id' },
  });
  try {
    const created = await call('POST', '/collections/orders/entries', { data: { total: 1200 } });
    assert.equal(created.status, 201);
    assert.equal(created.body.id, 'ord_1');
    assert.equal((await call('POST', '/collections/orders/entries', { data: { id: 'ord_custom', total: 5 } })).body.id, 'ord_custom');
    assert.deepEqual(sqlite.prepare('SELECT id FROM test_orders ORDER BY id').all().map((row) => row.id), ['ord_1', 'ord_custom']);
    // The parts table has no default: the admin still gets a generated text id.
    const part = await call('POST', '/collections/parts/entries', { data: { name: 'Bolt', quantity: 1 } });
    assert.equal(part.status, 201);
    assert.match(part.body.id, /^\d+-[a-z0-9]+$/);
  } finally {
    runtime.collections.pop();
    delete runtime.nativeSchemas.orders;
    sqlite.close();
  }
});
