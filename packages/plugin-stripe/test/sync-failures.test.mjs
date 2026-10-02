import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import { cmsRequest, mockStripe, resetEnv } from './support.mjs';
import { database } from './database.mjs';
const { createStripeRuntimeHooks } = await import('../dist/runtime-hooks.js');
const { GET, POST } = await import('../dist/routes/sync.js');
const { stripeProxy } = await import('../dist/proxy.js');

const config = { collection: 'members', identityField: 'memberKey', stripeResourceType: 'customers', stripeResourceTypeSingular: 'customer', fields: [{ fieldPath: 'email', stripeProperty: 'email' }] };
const data = { memberKey: 'member-1', email: 'member@example.test' };
const args = (value = data, originalDoc) => ({ data: value, originalDoc, operation: originalDoc ? 'update' : 'create', req: cmsRequest('editor') });
const create = (hooks, value = data, originalDoc) => hooks.beforeChange[0](args(value, originalDoc));
let sqlite;
test.beforeEach(() => { const db = database(); sqlite = db.sqlite; resetEnv({ STRIPE_SECRET_KEY: 'sk_test_worker', DB: db.DB }); });
const errorResponse = (status, type = 'api_error', code) => Response.json({ error: { type, code, message: 'Sensitive upstream data member@example.test' } }, { status });
const row = () => sqlite.prepare('SELECT * FROM _stripe_sync').get();
const request = (body, role = 'admin') => new Request('https://cms.example.test/admin/api/stripe/sync', { method: 'POST', headers: { 'x-test-role': role, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('Stripe rejection refuses the CMS write with actionable feedback and lets corrected fields retry', async (t) => {
  let fail = true;
  const calls = mockStripe(t, () => fail ? errorResponse(400, 'invalid_request_error') : { id: 'cus_fixed' });
  const hooks = createStripeRuntimeHooks(config);
  await assert.rejects(create(hooks), /CMS save\/delete refused.*Correct/);
  assert.equal(row().stripe_id, null);
  assert.doesNotMatch(row().last_error, /member@example/);
  fail = false;
  assert.equal((await create(hooks, { ...data, email: 'correct@example.test' })).stripeID, 'cus_fixed');
  assert.notEqual(calls[0].idempotencyKey, calls[1].idempotencyKey);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM _stripe_sync_operations').get().n, 2);
});

test('transient failures keep the operation key and exact payload across isolates and bound retries', async (t) => {
  let fail = true;
  const calls = mockStripe(t, () => fail ? errorResponse(503) : { id: 'cus_recovered' });
  await assert.rejects(create(createStripeRuntimeHooks(config)), /Retry unchanged fields within 23 hours/);
  assert.equal(calls.length, 2, 'SDK retries only once');
  assert.equal(row().state, 'pending');
  await assert.rejects(create(createStripeRuntimeHooks(config), { ...data, email: 'changed@example.test' }), /Retry the unchanged fields/);
  assert.equal(calls.length, 2);
  fail = false;
  assert.equal((await create(createStripeRuntimeHooks(config))).stripeID, 'cus_recovered');
  assert.equal(new Set(calls.map(c => c.idempotencyKey)).size, 1);
  assert.equal(row().attempts, 2);
});

test('confirmed create survives a failed CMS write and a later save without duplicate Stripe creates', async (t) => {
  const calls = mockStripe(t);
  const saved = await create(createStripeRuntimeHooks(config));
  // Simulate a rejected CMS write by deliberately not running afterChange, then retry days later.
  sqlite.prepare('UPDATE _stripe_sync SET started_at = ?').run(Date.now() - 3 * 86400_000);
  assert.equal((await create(createStripeRuntimeHooks(config))).stripeID, saved.stripeID);
  assert.equal(calls.length, 1);
  assert.ok(row().stripe_id);
  const doc = { id: 'cms-1', data: saved };
  const hooks = createStripeRuntimeHooks(config);
  await hooks.afterChange[0]({ ...args(data), doc });
  await assert.rejects(create(hooks), /another CMS record/);
  await create(hooks, { email: 'updated@example.test' }, doc);
  assert.equal(calls.at(-1).path, `/v1/customers/${saved.stripeID}`);
});

test('a successful Stripe create followed by journal failure reuses its original key after lease expiry', async (t) => {
  const calls = mockStripe(t);
  sqlite.exec("CREATE TRIGGER fail_stripe_result BEFORE UPDATE OF stripe_id ON _stripe_sync WHEN NEW.stripe_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'temporary database failure'); END");
  await assert.rejects(create(createStripeRuntimeHooks(config)), /durable sync journal/);
  assert.equal(row().state, 'pending');
  sqlite.exec('DROP TRIGGER fail_stripe_result');
  sqlite.prepare('UPDATE _stripe_sync SET lease_until = 0').run();
  await create(createStripeRuntimeHooks(config));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
});

test('uncertain creates older than 23 hours fail closed until an admin verifies the resource', async (t) => {
  let failed = true;
  let op;
  const calls = mockStripe(t, c => failed ? errorResponse(500) : { id: 'cus_reconciled', metadata: { talisman_sync_operation: op } });
  await assert.rejects(create(createStripeRuntimeHooks(config)), /sync failed/);
  op = row().operation;
  sqlite.prepare('UPDATE _stripe_sync SET started_at = ?').run(Date.now() - 24 * 3600_000);
  await assert.rejects(create(createStripeRuntimeHooks(config)), /safe retry window/);
  assert.equal(calls.length, 2, 'no new create after retention window');
  failed = false;
  assert.equal((await POST({ request: request({ operation: op, stripeId: 'cus_reconciled' }, 'editor') })).status, 403);
  assert.equal((await POST({ request: request({ operation: op, stripeId: 'cus_reconciled' }) })).status, 200);
  assert.equal((await create(createStripeRuntimeHooks(config))).stripeID, 'cus_reconciled');
  assert.equal(calls.at(-1).method, 'GET');
  assert.equal(sqlite.prepare('SELECT outcome FROM _stripe_sync_operations').get().outcome, 'administrator_reconciled');
});

test('reconciliation rejects IDs without proof of this operation and audit is admin-only', async (t) => {
  let fail = true;
  mockStripe(t, () => fail ? errorResponse(503) : { id: 'cus_other', metadata: {} });
  await assert.rejects(create(createStripeRuntimeHooks(config)), /sync failed/);
  fail = false;
  const response = await POST({ request: request({ operation: row().operation, stripeId: 'cus_other' }) });
  assert.equal(response.status, 409);
  assert.equal(row().stripe_id, null);
  assert.equal((await GET({ request: cmsRequest('editor', 'GET') })).status, 403);
  const audit = await GET({ request: cmsRequest('admin', 'GET') });
  assert.equal((await audit.json()).operations.length, 1);
});

test('concurrent saves are refused while Stripe is in flight and missing identity fails before Stripe', async (t) => {
  let release;
  const calls = mockStripe(t, () => new Promise(resolve => { release = resolve; }));
  await assert.rejects(create(createStripeRuntimeHooks({ ...config, identityField: undefined })), /Set identityField/);
  const first = create(createStripeRuntimeHooks(config));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(create(createStripeRuntimeHooks(config)), /already running/);
  release({ id: 'cus_once' });
  await first;
  assert.equal(calls.length, 1);
});

test('changing the identity is refused even on saves without mapped fields', async (t) => {
  const calls = mockStripe(t);
  await assert.rejects(create(createStripeRuntimeHooks(config), { memberKey: 'other' }, { id: 'cms1', data: { ...data, stripeID: 'cus_1' } }), /cannot be changed/);
  assert.equal(calls.length, 0);
});

test('failed customer deletion refuses the CMS delete; retry treats missing customers as deleted', async (t) => {
  let failed = true;
  const calls = mockStripe(t, () => failed ? errorResponse(503) : errorResponse(404, 'invalid_request_error', 'resource_missing'));
  const hooks = createStripeRuntimeHooks(config);
  const originalDoc = { id: 'cms-1', data: { ...data, stripeID: 'cus_1' } };
  const input = { operation: 'delete', originalDoc, req: cmsRequest('admin', 'DELETE') };
  await assert.rejects(hooks.beforeDelete[0](input), /CMS save\/delete refused/);
  failed = false;
  await hooks.beforeDelete[0](input);
  await hooks.beforeDelete[0](input);
  assert.equal(calls.length, 3);
  assert.equal(row().state, 'deleted');
});

test('product and price updates preserve IDs; price immutable changes are refused instead of replacing the price', async (t) => {
  const calls = mockStripe(t, c => c.params.unit_amount ? errorResponse(400, 'invalid_request_error') : { id: c.path.split('/').at(-1) });
  for (const [resource, id] of [['products', 'prod_1'], ['prices', 'price_1']]) {
    const hooks = createStripeRuntimeHooks({ ...config, collection: resource, stripeResourceType: resource, fields: [{ fieldPath: 'active', stripeProperty: 'active' }, { fieldPath: 'amount', stripeProperty: 'unit_amount' }] });
    const doc = { id: resource, data: { memberKey: resource, stripeID: id } };
    const updated = await create(hooks, { active: false }, doc);
    assert.equal(updated.stripeID, id);
    assert.equal(calls.at(-1).path, `/v1/${resource}/${id}`);
    if (resource === 'prices') await assert.rejects(create(hooks, { amount: 2000 }, doc), /sync failed/);
  }
  assert.ok(calls.every(c => c.version === '2022-08-01'));
  assert.ok(calls.every(c => c.idempotencyKey?.startsWith('talisman-sync-')));
  assert.equal(calls.filter(c => c.path === '/v1/prices').length, 0);
});

test('proxy uses a 10-second network timeout, one retry, and the existing supported API version', async (t) => {
  let timeouts = [];
  const factory = Stripe.createFetchHttpClient;
  t.mock.method(Stripe, 'createFetchHttpClient', () => {
    const client = factory();
    const make = client.makeRequest.bind(client);
    client.makeRequest = (...args) => { timeouts.push(args[7]); return make(...args); };
    return client;
  });
  const calls = mockStripe(t, () => errorResponse(503));
  await stripeProxy({ stripeSecretKey: 'sk_test_worker', stripeMethod: 'customers.create', stripeArgs: [{ email: 'example@example.test' }] });
  assert.equal(calls.length, 2);
  assert.deepEqual(timeouts, [10_000, 10_000]);
  assert.ok(calls.every(c => c.version === '2022-08-01'));
});

test('prices create with their original product, amount and currency; retry reuses the same price', async (t) => {
  const calls = mockStripe(t);
  const price = createStripeRuntimeHooks({ ...config, collection: 'prices', stripeResourceType: 'prices', stripeResourceTypeSingular: 'price', fields: [
    { fieldPath: 'product', stripeProperty: 'product' }, { fieldPath: 'amount', stripeProperty: 'unit_amount' }, { fieldPath: 'currency', stripeProperty: 'currency' }, { fieldPath: 'nickname', stripeProperty: 'nickname' },
  ] });
  const value = { memberKey: 'catalog-price-1', product: 'prod_existing', amount: 1000, currency: 'usd' };
  const created = await create(price, value);
  await create(price, value);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].params.product, calls[0].params.unit_amount, calls[0].params.currency], ['prod_existing', '1000', 'usd']);
  await create(price, { nickname: 'Display name' }, { id: 'cms-price', data: { ...value, stripeID: created.stripeID } });
  assert.equal(calls.at(-1).path, `/v1/prices/${created.stripeID}`);
  assert.equal(calls.at(-1).params.unit_amount, undefined);
});

test('expired customer deletions reconcile only the journal customer confirmed missing in Stripe', async (t) => {
  let fail = true;
  const calls = mockStripe(t, () => fail ? errorResponse(503) : errorResponse(404, 'invalid_request_error', 'resource_missing'));
  const hooks = createStripeRuntimeHooks(config);
  const input = { operation: 'delete', originalDoc: { id: 'cms-1', data: { ...data, stripeID: 'cus_1' } }, req: cmsRequest('admin', 'DELETE') };
  await assert.rejects(hooks.beforeDelete[0](input), /sync failed/);
  sqlite.prepare('UPDATE _stripe_sync SET started_at = ?').run(Date.now() - 24 * 3600_000);
  await assert.rejects(hooks.beforeDelete[0](input), /safe retry window/);
  fail = false;
  assert.equal((await POST({ request: request({ operation: row().operation, stripeId: 'cus_other' }) })).status, 409);
  assert.equal((await POST({ request: request({ operation: row().operation, stripeId: 'cus_1' }) })).status, 200);
  await hooks.beforeDelete[0](input);
  assert.equal(calls.length, 3);
  assert.equal(row().state, 'deleted');
});

test('reconciliation refuses to take over a lease acquired while it was verifying Stripe', async (t) => {
  let failing = true;
  mockStripe(t, () => {
    if (failing) return errorResponse(503);
    sqlite.prepare('UPDATE _stripe_sync SET lease_until = ?').run(Date.now() + 60_000);
    return { id: 'cus_confirmed', metadata: { talisman_sync_operation: row().operation } };
  });
  await assert.rejects(create(createStripeRuntimeHooks(config)), /sync failed/);
  failing = false;
  const response = await POST({ request: request({ operation: row().operation, stripeId: 'cus_confirmed' }) });
  assert.equal(response.status, 409);
  assert.equal(row().state, 'pending');
});
