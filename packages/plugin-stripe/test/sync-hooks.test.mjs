import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { cmsRequest, mockStripe, nativeSchemas, resetEnv } from './support.mjs';

const { createStripeRuntimeHooks } = await import('../dist/runtime-hooks.js');
// Native collections map real Drizzle tables; resolve drizzle-orm through the CMS that owns it.
const requireFromCms = createRequire(new URL('../node_modules/talisman-cms/package.json', import.meta.url));
const { sqliteTable, text } = requireFromCms('drizzle-orm/sqlite-core');

const productSync = (overrides = {}) => ({
  collection: 'products',
  stripeResourceType: 'products',
  stripeResourceTypeSingular: 'product',
  fields: [{ fieldPath: 'name', stripeProperty: 'name' }],
  ...overrides,
});

async function change(hooks, args) {
  let data = args.data;
  for (const hook of hooks.beforeChange) data = { ...data, ...await hook({ ...args, data, req: args.req ?? cmsRequest('editor') }) };
  return data;
}

test.beforeEach(() => resetEnv({ STRIPE_SECRET_KEY: 'sk_test_worker' }));

test('the Stripe secret key is read from the Worker per request and fails closed when unset', async (t) => {
  const calls = mockStripe(t);
  const hooks = createStripeRuntimeHooks(productSync());

  resetEnv();
  await assert.rejects(change(hooks, { operation: 'create', data: { name: 'Frame' } }), /STRIPE_SECRET_KEY is not set/);
  assert.equal(calls.length, 0);

  resetEnv({ STRIPE_SECRET_KEY: 'sk_test_plain' });
  await change(hooks, { operation: 'create', data: { name: 'Frame' } });
  resetEnv({ STRIPE_SECRET_KEY: 'sk_test_plain', TALISMAN_STRIPE_SECRET_KEY: 'sk_test_talisman' });
  await change(hooks, { operation: 'create', data: { name: 'Frame' } });
  assert.deepEqual(calls.map((call) => call.authorization), ['Bearer sk_test_plain', 'Bearer sk_test_talisman']);
});

test('records without synced fields are saved without calling Stripe or needing the key', async (t) => {
  const calls = mockStripe(t);
  resetEnv();
  const saved = await change(createStripeRuntimeHooks(productSync()), { operation: 'create', data: { slug: 'frame' } });
  assert.equal(saved.slug, 'frame');
  assert.equal(calls.length, 0);
});

test('client-sent stripeID and skipSync values are replaced by the stored record', async (t) => {
  const calls = mockStripe(t);
  const hooks = createStripeRuntimeHooks(productSync());

  const created = await change(hooks, {
    operation: 'create',
    data: { name: 'Frame', stripeID: 'prod_someone_else', skipSync: true },
  });
  assert.equal(created.stripeID, 'prod_created');
  assert.equal(created.skipSync, undefined);
  assert.deepEqual(calls.map(({ method, path, params }) => [method, path, params]), [['POST', '/v1/products', { name: 'Frame' }]]);

  const originalDoc = { id: 'p1', data: { name: 'Frame', stripeID: 'prod_stored' } };
  const updated = await change(hooks, {
    operation: 'update',
    originalDoc,
    data: { name: 'Frame 2', stripeID: 'prod_someone_else', skipSync: true },
  });
  assert.equal(updated.stripeID, 'prod_stored');
  assert.equal(updated.skipSync, undefined);
  assert.deepEqual(calls.at(-1).path, '/v1/products/prod_stored');
  assert.deepEqual(calls.at(-1).params, { name: 'Frame 2' });

  // The admin form does not send the ID back; saving must keep it.
  const resaved = await change(hooks, { operation: 'update', originalDoc, data: { name: 'Frame 3' } });
  assert.equal(resaved.stripeID, 'prod_stored');
  assert.equal(calls.filter((call) => call.path === '/v1/products').length, 1);
});

test('native tables keep the Stripe ID in a real column, so saves do not create duplicates', async (t) => {
  const calls = mockStripe(t);
  nativeSchemas.products = sqliteTable('products', {
    id: text('id').primaryKey(),
    name: text('name'),
    stripeID: text('stripe_id'),
  });
  const hooks = createStripeRuntimeHooks(productSync());

  const created = await change(hooks, { operation: 'create', data: { name: 'Frame' } });
  assert.equal(created.stripeID, 'prod_created');
  // The native row, as the CMS reads it back for the next save.
  const originalDoc = { id: 'p1', data: { id: 'p1', name: 'Frame', stripeID: created.stripeID } };
  await change(hooks, { operation: 'update', originalDoc, data: { name: 'Frame 2' } });
  await change(hooks, { operation: 'update', originalDoc, data: { name: 'Frame 3' } });

  assert.deepEqual(calls.map(({ path }) => path), ['/v1/products', '/v1/products/prod_created', '/v1/products/prod_created']);
});

test('native tables without a Stripe ID column are refused before Stripe is called', async (t) => {
  const calls = mockStripe(t);
  nativeSchemas.catalog = sqliteTable('catalog', { id: text('id').primaryKey(), name: text('name') });

  const hooks = createStripeRuntimeHooks(productSync({ collection: 'catalog' }));
  await assert.rejects(
    change(hooks, { operation: 'create', data: { name: 'Frame' } }),
    /catalog is a native table without a "stripeID" column/,
  );
  await assert.rejects(
    change(hooks, { operation: 'update', originalDoc: { data: { id: 'c1', name: 'Frame' } }, data: { name: 'Frame 2' } }),
    /without a "stripeID" column/,
  );
  assert.equal(calls.length, 0);

  nativeSchemas.catalog = sqliteTable('catalog', {
    id: text('id').primaryKey(),
    name: text('name'),
    stripeProductId: text('stripe_product_id'),
  });
  const renamed = createStripeRuntimeHooks(productSync({ collection: 'catalog', stripeIdField: 'stripeProductId' }));
  const created = await change(renamed, { operation: 'create', data: { name: 'Frame' } });
  assert.equal(created.stripeProductId, 'prod_created');
  assert.equal(created.stripeID, undefined);
});

test('only admins can remove linked Stripe resources, and not without the key', async (t) => {
  t.mock.method(console, 'error', () => {});
  const calls = mockStripe(t);
  const customers = createStripeRuntimeHooks({
    collection: 'customers',
    stripeResourceType: 'customers',
    stripeResourceTypeSingular: 'customer',
  });
  const products = createStripeRuntimeHooks(productSync());
  const linkedCustomer = { id: 'c1', data: { email: 'a@example.test', stripeID: 'cus_1' } };
  const linkedProduct = { id: 'p1', data: { name: 'Frame', stripeID: 'prod_1' } };

  const editor = cmsRequest('editor', 'DELETE');
  await assert.rejects(customers.beforeDelete[0]({ req: editor, operation: 'delete', originalDoc: linkedCustomer }), /Only CMS admins/);
  await customers.afterDelete[0]({ req: editor, operation: 'delete', originalDoc: linkedCustomer, doc: linkedCustomer });
  assert.equal(calls.length, 0);
  // Records that are not linked to Stripe are unaffected.
  await customers.beforeDelete[0]({ req: editor, operation: 'delete', originalDoc: { id: 'c2', data: {} } });

  resetEnv();
  const admin = () => cmsRequest('admin', 'DELETE');
  await assert.rejects(customers.beforeDelete[0]({ req: admin(), operation: 'delete', originalDoc: linkedCustomer }), /STRIPE_SECRET_KEY is not set/);

  resetEnv({ STRIPE_SECRET_KEY: 'sk_test_worker' });
  for (const [hooks, doc] of [[customers, linkedCustomer], [products, linkedProduct]]) {
    const req = admin();
    await hooks.beforeDelete[0]({ req, operation: 'delete', originalDoc: doc });
    await hooks.afterDelete[0]({ req, operation: 'delete', originalDoc: doc, doc });
  }
  // Stripe cannot delete a product that has prices, so products are archived instead.
  assert.deepEqual(calls.map(({ method, path, params }) => [method, path, params]), [
    ['DELETE', '/v1/customers/cus_1', {}],
    ['POST', '/v1/products/prod_1', { active: 'false' }],
  ]);
});
