import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { call, database, runtime, skip } from '../../talisman-cms/test/helpers/handler-harness.mjs';

registerHooks({ resolve(specifier, context, nextResolve) {
  const sources = {
    'virtual:talisman-cms/stripe-config': 'export const stripeConfig = { logs: false };',
  };
  if (sources[specifier]) return { url: `data:text/javascript,${encodeURIComponent(sources[specifier])}`, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { createStripeRuntimeHooks } = await import('../dist/runtime-hooks.js');
const config = { collection: 'members', identityField: 'memberKey', stripeResourceType: 'customers', stripeResourceTypeSingular: 'customer', fields: [{ fieldPath: 'email', stripeProperty: 'email' }] };
runtime.collections.push({ name: 'Members', slug: 'members', fields: [{ name: 'memberKey', type: 'text', required: true }, { name: 'email', type: 'text', required: true }] });

function setup() {
  const sqlite = database();
  const dir = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(dir).sort()) sqlite.exec(readFileSync(new URL(`${name}/migration.sql`, dir), 'utf8'));
  runtime.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  runtime.collectionHooks.members = createStripeRuntimeHooks(config);
  return sqlite;
}
const input = { data: { memberKey: 'immutable-member-1', email: 'member@example.test' } };

test('the editor API reports failed Stripe sync and does not save a CMS entry', { skip }, async t => {
  const sqlite = setup();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { type: 'invalid_request_error', message: 'Invalid email' } }, { status: 400 }));
  const result = await call('POST', '/collections/members/entries', input);
  assert.equal(result.status, 500);
  assert.match(result.body.error, /Stripe sync failed.*CMS save\/delete refused/);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM galaxy_entries').get().n, 0);
  sqlite.close();
});

test('a real CMS database failure after Stripe creation can be retried without another Stripe create', { skip }, async t => {
  const sqlite = setup();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ id: 'cus_recover' }); });
  sqlite.exec("CREATE TRIGGER fail_cms_insert BEFORE INSERT ON galaxy_entries BEGIN SELECT RAISE(ABORT, 'CMS write failed'); END");
  assert.equal((await call('POST', '/collections/members/entries', input)).status, 500);
  assert.equal(sqlite.prepare('SELECT stripe_id FROM _stripe_sync').get().stripe_id, 'cus_recover');
  sqlite.exec('DROP TRIGGER fail_cms_insert');
  const result = await call('POST', '/collections/members/entries', input);
  assert.equal(result.status, 201);
  assert.equal(result.body.data.stripeID, 'cus_recover');
  assert.equal(calls, 1);
  assert.equal(sqlite.prepare('SELECT doc_id FROM _stripe_sync').get().doc_id, result.body.id);
  sqlite.close();
});
