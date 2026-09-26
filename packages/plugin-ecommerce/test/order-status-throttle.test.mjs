import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { bindCommerceApi, reconcileCommerce } from '../dist/api.js';
import { StripePaymentAdapter } from '../dist/adapters/stripe.js';
import { PROVIDER_CHECK_RETRY_MESSAGE } from '../dist/api.js';
import { runtimePaymentAdapters } from '../dist/runtime.js';
import { CART_SESSION_COOKIE } from '../dist/cookies.js';

// The routes read their bindings from cloudflare:workers, and the checkout action comes from astro:actions.
const stubs = {
  'cloudflare:workers': 'export const env = new Proxy({}, { get: (_, key) => globalThis.workerEnv?.[key] });',
  'astro:actions': 'export const defineAction = (definition) => definition;'
    + ' export class ActionError extends Error { constructor({ code, message }) { super(message); this.code = code; } }',
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!(specifier in stubs)) return nextResolve(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  },
});
const orderRoute = (await import('../dist/routes/ecommerce-order.js')).ALL;
const checkoutRoute = (await import('../dist/routes/ecommerce-checkout.js')).POST;
const { ecommerceActions } = await import('../dist/actions.js');

const ORIGIN = 'https://shop.test';
const migrationFiles = ['0004_ecommerce_plugin.sql', '0005_variant_value_images.sql', '0007_local_auth.sql',
  '0008_shared_components.sql', '0010_checkout_inventory.sql', '0011_order_payment_provider.sql',
  '0012_customer_accounts.sql', '0013_referrals_and_credit.sql', '0014_promotions.sql',
  '0015_gift_cards.sql', '0016_verified_customer_sessions.sql', '0017_commerce_fulfillment.sql',
  '0019_shared_customer_identity.sql', '0024_shopper_sign_in_tokens.sql', '0025_order_shipping_and_tax.sql',
  '0026_order_fulfillment_status.sql', '0027_gift_card_review.sql', '0028_provider_refunds_and_disputes.sql'];

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of migrationFiles) {
    const sql = readFileSync(new URL(`../../talisman-cms/drizzle/${migration}`, import.meta.url), 'utf8');
    sqlite.exec(sql.replaceAll('--> statement-breakpoint', ''));
  }
  const DB = {
    prepare(sql) {
      const prepared = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async all() { return { results: prepared.all(...values) }; },
        async first() { return prepared.get(...values) ?? null; },
        async raw() {
          const raw = sqlite.prepare(sql);
          raw.setReturnArrays(true);
          return raw.all(...values);
        },
        async run() { return { meta: prepared.run(...values) }; }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.all());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_products
    (id, name, slug, base_price, inventory_quantity, status, created_at, updated_at) VALUES ('case', 'Case', 'case', 2000, 50, 'active', ?, ?)`)
    .run(now, now);
  return { sqlite, DB };
}

const env = (DB) => ({ DB, TALISMAN_COMMERCE_STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: 'sk_test_order_status', STRIPE_WEBHOOK_SECRET: 'whsec_order_status' });

/** Places a pending Stripe order the way checkout does, without contacting Stripe. */
async function placeOrder(DB, sessionToken) {
  const hostedCheckout = {
    providerId: 'stripe',
    async createCheckoutSession({ orderId }) {
      return { providerSessionId: `cs_test_${orderId}`, url: `https://checkout.stripe.test/${orderId}` };
    },
    async expireCheckoutSession() {},
  };
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [hostedCheckout] });
  const cart = await api.carts.getOrCreate(sessionToken);
  await api.carts.updateItems(cart.id, [{ productId: 'case', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, { customerEmail: 'shopper@example.test',
    shippingAddress: { name: 'Test Shopper', line1: '1 Main St', city: 'Austin', postalCode: '78701', country: 'US' },
    successUrl: `${ORIGIN}/checkout/success?order={ORDER_ID}`, cancelUrl: `${ORIGIN}/checkout/cancel?order={ORDER_ID}`,
    providerId: 'stripe' });
  return order;
}

/**
 * Replaces the Stripe checkout-session lookup for one test and records every call. `session` gives the
 * answer from the session id and the call's number; each call waits a moment, as a network request would.
 */
function stubSessionLookup(t, session = () => ({ status: 'open', url: 'https://checkout.stripe.test/open' })) {
  const calls = [];
  const original = StripePaymentAdapter.prototype.getCheckoutSession;
  StripePaymentAdapter.prototype.getCheckoutSession = async function (sessionId) {
    calls.push(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return session(sessionId, calls.length);
  };
  t.after(() => { StripePaymentAdapter.prototype.getCheckoutSession = original; });
  return calls;
}

async function readStatus(DB, order, sessionToken) {
  globalThis.workerEnv = env(DB);
  const cookies = new Map([[CART_SESSION_COOKIE, sessionToken]]);
  const request = new Request(`${ORIGIN}/api/ecommerce/order?order=${encodeURIComponent(order.id)}`, { method: 'GET' });
  const response = await orderRoute({ request, cookies: {
    get: (name) => cookies.has(name) ? { value: cookies.get(name) } : undefined, set() {}, delete() {} } });
  return { status: response.status, json: await response.json() };
}

const shippingAddress = { name: 'Test Shopper', line1: '1 Main St', city: 'Austin', postalCode: '78701', country: 'US' };
const checkoutEnv = (DB) => ({ ...env(DB), TALISMAN_COMMERCE_CHECKOUT_ENABLED: 'true' });
const RETRY = { error: PROVIDER_CHECK_RETRY_MESSAGE };

function cookieReader(sessionToken) {
  const cookies = new Map([[CART_SESSION_COOKIE, sessionToken]]);
  return { get: (name) => cookies.has(name) ? { value: cookies.get(name) } : undefined, set() {}, delete() {} };
}

/** Checkout again from a basket whose pending order is still open, through the public route. */
async function resumeCheckout(DB, sessionToken) {
  globalThis.workerEnv = checkoutEnv(DB);
  const request = new Request(`${ORIGIN}/api/ecommerce/checkout`, { method: 'POST',
    headers: { origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerEmail: 'shopper@example.test', shippingAddress }) });
  const response = await checkoutRoute({ request, cookies: cookieReader(sessionToken) });
  return { status: response.status, json: await response.json(), retryAfter: response.headers.get('retry-after') };
}

/** Release a pending order's payment session, as the checkout cancel page does. */
async function releaseCheckout(DB, order, sessionToken) {
  globalThis.workerEnv = env(DB);
  const request = new Request(`${ORIGIN}/api/ecommerce/order`, { method: 'POST',
    headers: { origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: order.id }) });
  const response = await orderRoute({ request, cookies: cookieReader(sessionToken) });
  return { status: response.status, json: await response.json(), retryAfter: response.headers.get('retry-after') };
}

/** Records every Stripe session expiry for one test. */
function stubSessionExpiry(t) {
  const expired = [];
  const original = StripePaymentAdapter.prototype.expireCheckoutSession;
  StripePaymentAdapter.prototype.expireCheckoutSession = async function (sessionId) { expired.push(sessionId); };
  t.after(() => { StripePaymentAdapter.prototype.expireCheckoutSession = original; });
  return expired;
}

/** Mocks Date only, so the test decides how much time passes between requests. */
function clock(t) {
  const start = Math.floor(Date.now() / 1000) * 1000;
  t.mock.timers.enable({ apis: ['Date'], now: start });
  return (seconds) => t.mock.timers.setTime(start + seconds * 1000);
}

test('the status route asks the payment provider about an order at most once every 15 seconds', async (t) => {
  const at = clock(t);
  const calls = stubSessionLookup(t);
  const { sqlite, DB } = database();
  const order = await placeOrder(DB, 'status-browser');
  const other = await placeOrder(DB, 'other-browser');

  for (const seconds of [61, 65, 70, 75]) {
    at(seconds);
    const read = await readStatus(DB, order, 'status-browser');
    assert.deepEqual([read.status, read.json.orderId, read.json.status], [200, order.id, 'pending']);
  }
  assert.deepEqual(calls, [order.checkoutSessionId]);

  // Each order has its own interval.
  assert.equal((await readStatus(DB, other, 'other-browser')).json.status, 'pending');
  assert.deepEqual(calls, [order.checkoutSessionId, other.checkoutSessionId]);

  at(76);
  assert.equal((await readStatus(DB, order, 'status-browser')).json.status, 'pending');
  assert.equal(calls.length, 3);
  sqlite.close();
});

test('the status route settles a paid order once its interval allows a provider check', async (t) => {
  const at = clock(t);
  let paid = false;
  const { sqlite, DB } = database();
  const order = await placeOrder(DB, 'paid-browser');
  const calls = stubSessionLookup(t, () => paid
    ? { status: 'complete', paymentStatus: 'paid', amountTotal: order.totalAmount, currency: 'usd',
      paymentIntentId: `pi_${order.id}`, url: null }
    : { status: 'open', url: 'https://checkout.stripe.test/open' });

  at(90);
  assert.equal((await readStatus(DB, order, 'paid-browser')).json.status, 'pending');
  paid = true;
  // Within the interval the stored status is returned.
  at(100);
  assert.equal((await readStatus(DB, order, 'paid-browser')).json.status, 'pending');
  assert.equal(calls.length, 1);
  at(105);
  assert.equal((await readStatus(DB, order, 'paid-browser')).json.status, 'paid');
  // A settled order is not checked again.
  at(200);
  assert.equal((await readStatus(DB, order, 'paid-browser')).json.status, 'paid');
  assert.equal(calls.length, 2);
  sqlite.close();
});

test('an order younger than a minute is not checked with the provider and returns its stored status', async (t) => {
  const at = clock(t);
  const calls = stubSessionLookup(t);
  const { sqlite, DB } = database();
  const order = await placeOrder(DB, 'young-browser');

  for (const seconds of [0, 20, 50, 59]) {
    at(seconds);
    const read = await readStatus(DB, order, 'young-browser');
    assert.deepEqual([read.status, read.json.status, read.json.totalAmount], [200, 'pending', order.totalAmount]);
  }
  assert.equal(calls.length, 0);
  // Requests before the minute do not use up the order's interval.
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_rate_limits').get().n, 0);
  at(60);
  await readStatus(DB, order, 'young-browser');
  assert.equal(calls.length, 1);
  sqlite.close();
});

test('concurrent status requests for one order make one provider call', async (t) => {
  const at = clock(t);
  const calls = stubSessionLookup(t);
  const { sqlite, DB } = database();
  const order = await placeOrder(DB, 'busy-browser');

  at(120);
  const reads = await Promise.all(Array.from({ length: 8 }, () => readStatus(DB, order, 'busy-browser')));
  assert.deepEqual(reads.map((read) => [read.status, read.json.status]), Array(8).fill([200, 'pending']));
  assert.equal(calls.length, 1);
  sqlite.close();
});

test('scheduled reconciliation is not limited by the status route', async (t) => {
  const at = clock(t);
  const { sqlite, DB } = database();
  const order = await placeOrder(DB, 'missed-webhook-browser');
  // The provider reports the session open on the route's check and paid afterwards.
  const calls = stubSessionLookup(t, (_, call) => call === 1 ? { status: 'open', url: 'https://checkout.stripe.test/open' }
    : { status: 'complete', paymentStatus: 'paid', amountTotal: order.totalAmount, currency: 'usd',
      paymentIntentId: `pi_${order.id}`, url: null });

  // Past reconcileCommerce's 15 minute threshold.
  at(20 * 60);
  assert.equal((await readStatus(DB, order, 'missed-webhook-browser')).json.status, 'pending');
  assert.equal(calls.length, 1);

  // The route's interval for this order is taken; the scheduled run still asks the provider.
  const results = await reconcileCommerce({ env: env(DB), paymentAdapters: runtimePaymentAdapters(env(DB)) });
  assert.deepEqual(results.find((result) => result.id === order.id), { id: order.id, status: 'paid' });
  assert.equal(calls.length, 2);
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_orders WHERE id = ?').get(order.id).status, 'paid');
  assert.equal((await readStatus(DB, order, 'missed-webhook-browser')).json.status, 'paid');
  assert.equal(calls.length, 2);
  sqlite.close();
});

test('a pending gift-card order is settled by the status route without a provider check or interval', async (t) => {
  const at = clock(t);
  const calls = stubSessionLookup(t);
  const { sqlite, DB } = database();
  const order = await placeOrder(DB, 'gift-card-browser');
  // A gift card that covers the whole total leaves nothing for a payment provider to collect.
  sqlite.prepare("UPDATE _ecommerce_orders SET payment_provider = 'gift_card', total_amount = 0 WHERE id = ?").run(order.id);

  at(5);
  const read = await readStatus(DB, order, 'gift-card-browser');
  assert.deepEqual([read.status, read.json.status, read.json.paymentProvider], [200, 'paid', 'gift_card']);
  assert.equal(calls.length, 0);
  // Such orders do not take a per-order interval slot.
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_rate_limits').get().n, 0);
  sqlite.close();
});

test('checkout resume asks the provider at most once per order every 15 seconds, sharing the status route\'s slot', async (t) => {
  const at = clock(t);
  const calls = stubSessionLookup(t);
  const { sqlite, DB } = database();
  const order = await placeOrder(DB, 'resume-browser');

  // A shopper back from the payment page right away still resumes: resume has no minimum order age.
  at(1);
  const first = await resumeCheckout(DB, 'resume-browser');
  assert.deepEqual([first.status, first.json], [200,
    { orderId: order.id, redirectUrl: 'https://checkout.stripe.test/open', mode: 'redirect' }]);
  at(5);
  const second = await resumeCheckout(DB, 'resume-browser');
  assert.deepEqual([second.status, second.json, second.retryAfter], [429, RETRY, '15']);
  assert.deepEqual(calls, [order.checkoutSessionId]);
  // The basket stays locked by the pending order, and nothing else changed.
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_orders WHERE id = ?').get(order.id).status, 'pending');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_orders').get().n, 1);

  at(16);
  assert.equal((await resumeCheckout(DB, 'resume-browser')).status, 200);
  assert.equal(calls.length, 2);

  // The order status route takes the same slot, so a resume right after a status check waits too.
  at(61);
  assert.equal((await readStatus(DB, order, 'resume-browser')).json.status, 'pending');
  assert.equal(calls.length, 3);
  at(65);
  assert.deepEqual(await resumeCheckout(DB, 'resume-browser'), { status: 429, json: RETRY, retryAfter: '15' });
  assert.equal(calls.length, 3);
  sqlite.close();
});

test('concurrent checkout resumes for one order make one provider call', async (t) => {
  const at = clock(t);
  const calls = stubSessionLookup(t);
  const { sqlite, DB } = database();
  const order = await placeOrder(DB, 'double-click-browser');

  at(10);
  const answers = await Promise.all(Array.from({ length: 5 }, () => resumeCheckout(DB, 'double-click-browser')));
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 429, 429, 429, 429]);
  assert.deepEqual(calls, [order.checkoutSessionId]);
  sqlite.close();
});

test('the checkout action resumes through the same per-order slot', async (t) => {
  const at = clock(t);
  const calls = stubSessionLookup(t);
  const { sqlite, DB } = database();
  const order = await placeOrder(DB, 'action-browser');
  globalThis.workerEnv = checkoutEnv(DB);
  const context = () => ({ cookies: cookieReader('action-browser'), url: new URL(`${ORIGIN}/checkout`),
    request: new Request(`${ORIGIN}/checkout`, { method: 'POST' }) });
  const input = { customerEmail: 'shopper@example.test', shippingAddress };

  at(1);
  const first = await ecommerceActions.checkout.handler(input, context());
  assert.deepEqual([first.orderId, first.redirectUrl], [order.id, 'https://checkout.stripe.test/open']);
  at(5);
  await assert.rejects(ecommerceActions.checkout.handler(input, context()),
    (error) => error.code === 'TOO_MANY_REQUESTS' && error.message === RETRY.error);
  assert.deepEqual(calls, [order.checkoutSessionId]);
  at(16);
  assert.equal((await ecommerceActions.checkout.handler(input, context())).orderId, order.id);
  assert.equal(calls.length, 2);
  sqlite.close();
});

test('releasing a checkout asks the provider at most once per order every 15 seconds', async (t) => {
  const at = clock(t);
  // A paid session whose confirmation has not arrived keeps the order pending, so every release is refused.
  const calls = stubSessionLookup(t, () => ({ status: 'complete', paymentStatus: 'paid', url: null }));
  const expired = stubSessionExpiry(t);
  const { sqlite, DB } = database();
  const order = await placeOrder(DB, 'release-browser');
  const refused = { error: 'Payment has completed; wait for confirmation before changing the basket' };

  at(1);
  assert.deepEqual((await releaseCheckout(DB, order, 'release-browser')).json, refused);
  at(5);
  assert.deepEqual(await releaseCheckout(DB, order, 'release-browser'), { status: 429, json: RETRY, retryAfter: '15' });
  assert.deepEqual(calls, [order.checkoutSessionId]);
  at(16);
  assert.deepEqual((await releaseCheckout(DB, order, 'release-browser')).json, refused);
  assert.equal(calls.length, 2);
  assert.deepEqual(expired, []);
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_orders WHERE id = ?').get(order.id).status, 'pending');
  sqlite.close();
});

test('concurrent releases of one checkout make one provider lookup and one expiry', async (t) => {
  const at = clock(t);
  const calls = stubSessionLookup(t);
  const expired = stubSessionExpiry(t);
  const { sqlite, DB } = database();
  const order = await placeOrder(DB, 'release-twice-browser');

  at(2);
  const answers = await Promise.all(Array.from({ length: 5 }, () => releaseCheckout(DB, order, 'release-twice-browser')));
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 429, 429, 429, 429]);
  assert.deepEqual(answers.find((answer) => answer.status === 200).json, { orderId: order.id, status: 'cancelled' });
  assert.deepEqual([calls, expired], [[order.checkoutSessionId], [order.checkoutSessionId]]);
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_orders WHERE id = ?').get(order.id).status, 'cancelled');
  sqlite.close();
});

test('a release right after a resume waits for the same slot, then releases the basket', async (t) => {
  const at = clock(t);
  const calls = stubSessionLookup(t);
  const expired = stubSessionExpiry(t);
  const { sqlite, DB } = database();
  const order = await placeOrder(DB, 'resume-release-browser');

  at(1);
  assert.equal((await resumeCheckout(DB, 'resume-release-browser')).status, 200);
  at(5);
  assert.deepEqual(await releaseCheckout(DB, order, 'resume-release-browser'), { status: 429, json: RETRY, retryAfter: '15' });
  assert.equal(sqlite.prepare('SELECT checkout_session_id FROM _ecommerce_carts WHERE id = ?').get(order.cartId).checkout_session_id,
    order.checkoutSessionId);
  at(16);
  assert.deepEqual((await releaseCheckout(DB, order, 'resume-release-browser')).json, { orderId: order.id, status: 'cancelled' });
  assert.deepEqual([calls.length, expired.length], [2, 1]);
  assert.equal(sqlite.prepare('SELECT checkout_session_id FROM _ecommerce_carts WHERE id = ?').get(order.cartId).checkout_session_id, null);
  sqlite.close();
});
