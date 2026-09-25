import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import { mockStripe, resetEnv, stripeConfig } from './support.mjs';

const webhooks = await import('../dist/routes/webhooks.js');
const rest = await import('../dist/routes/rest.js');

const WEBHOOK_SECRET = 'whsec_test_plugin_stripe';

async function signedEvent(secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'product.updated', data: { object: { id: 'prod_1' } } });
  const header = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
  return new Request('https://shop.example.test/api/stripe/webhooks', {
    method: 'POST',
    headers: { 'stripe-signature': header },
    body: payload,
  });
}

function restRequest(role, body) {
  return new Request('https://shop.example.test/admin/api/stripe/rest', {
    method: 'POST',
    headers: role ? { 'x-test-role': role } : {},
    body: JSON.stringify(body),
  });
}

test.beforeEach(() => {
  resetEnv();
  Object.assign(stripeConfig, { rest: false, restMethods: [], logs: false, webhooks: undefined });
});

test('webhooks fail closed until the endpoint signing secret is set in the Worker', async (t) => {
  t.mock.method(console, 'error', () => {});
  const received = [];
  stripeConfig.webhooks = { 'product.updated': (event) => received.push(event.id) };

  assert.equal((await webhooks.POST({ request: await signedEvent() })).status, 503);
  // plugin-ecommerce's endpoint secret belongs to a different Stripe endpoint.
  resetEnv({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  assert.equal((await webhooks.POST({ request: await signedEvent() })).status, 503);
  assert.deepEqual(received, []);
});

test('webhooks verify the Stripe signature with the Worker secret before running handlers', async () => {
  const received = [];
  stripeConfig.webhooks = { 'product.updated': (event) => received.push(event.id) };
  resetEnv({ TALISMAN_STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });

  const forged = await webhooks.POST({ request: await signedEvent('whsec_attacker') });
  assert.equal(forged.status, 400);
  assert.deepEqual(received, []);

  const accepted = await webhooks.POST({ request: await signedEvent() });
  assert.equal(accepted.status, 200);
  assert.deepEqual(received, ['evt_1']);
});

test('the REST proxy is admin-only, allow-listed, and reads the key from the Worker', async (t) => {
  t.mock.method(console, 'error', () => {});
  const calls = mockStripe(t);
  const call = { stripeMethod: 'customers.retrieve', stripeArgs: ['cus_1'] };

  assert.equal((await rest.POST({ request: restRequest(undefined, call) })).status, 401);
  assert.equal((await rest.POST({ request: restRequest('editor', call) })).status, 403);
  assert.equal((await rest.POST({ request: restRequest('admin', call) })).status, 403);

  Object.assign(stripeConfig, { rest: true, restMethods: ['customers.retrieve'] });
  assert.equal((await rest.POST({ request: restRequest('admin', { ...call, stripeMethod: 'customers.del' }) })).status, 403);
  const unconfigured = await rest.POST({ request: restRequest('admin', call) });
  assert.equal(unconfigured.status, 503);
  assert.match((await unconfigured.json()).error, /STRIPE_SECRET_KEY is not set/);
  assert.equal(calls.length, 0);

  resetEnv({ TALISMAN_STRIPE_SECRET_KEY: 'sk_test_worker' });
  const response = await rest.POST({ request: restRequest('admin', call) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.id, 'cus_1');
  assert.deepEqual(calls.map(({ method, path, authorization }) => [method, path, authorization]), [
    ['GET', '/v1/customers/cus_1', 'Bearer sk_test_worker'],
  ]);
});
