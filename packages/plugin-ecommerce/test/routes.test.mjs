import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import Stripe from 'stripe';
import { bindCommerceApi, reconcileCommerce, CART_MAX_LINES, CART_MAX_LINE_QUANTITY } from '../dist/api.js';
import { AdminTestPaymentAdapter } from '../dist/adapters/admin-test.js';
import { StripePaymentAdapter } from '../dist/adapters/stripe.js';
import { CUSTOMER_SESSION_COOKIE } from '../dist/accounts.js';
import { CART_SESSION_COOKIE } from '../dist/cookies.js';
import { TaxAddressError } from '../dist/index.js';

// Routes read their bindings from cloudflare:workers, the actions come from astro:actions, and the
// admin route asks the CMS auth guard. This test serves all three.
const stubs = {
  'cloudflare:workers': 'export const env = new Proxy({}, { get: (_, key) => globalThis.workerEnv?.[key] });',
  'astro:actions': 'export const defineAction = (definition) => definition;'
    + ' export class ActionError extends Error { constructor({ code, message }) { super(message); this.code = code; } }',
  'talisman-cms/auth/guard': 'export async function authorizeCmsRequest(request, role) {'
    + ' const user = globalThis.cmsUser;'
    + " if (!user) return { response: Response.json({ error: 'Authentication required' }, { status: 401 }) };"
    + " if (role === 'admin' && user.role !== 'admin') return { response: Response.json({ error: 'Admin required' }, { status: 403 }) };"
    + ' return { user }; }',
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!(specifier in stubs)) return nextResolve(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  },
});
const cartRoute = (await import('../dist/routes/ecommerce-cart.js')).ALL;
const checkoutRoute = (await import('../dist/routes/ecommerce-checkout.js')).POST;
const orderRoute = (await import('../dist/routes/ecommerce-order.js')).ALL;
const webhookRoute = (await import('../dist/routes/ecommerce-webhook.js')).POST;
const giftCardsRoute = (await import('../dist/routes/ecommerce-gift-cards.js')).POST;
const discountRoute = (await import('../dist/routes/ecommerce-discount.js')).POST;
const adminTestCheckoutRoute = (await import('../dist/routes/ecommerce-admin-test-checkout.js')).ALL;
const adminGiftCardsRoute = (await import('../dist/routes/ecommerce-admin-gift-cards.js')).ALL;
const { ecommerceActions } = await import('../dist/actions.js');

const ORIGIN = 'https://shop.test';
const WEBHOOK_SECRET = 'whsec_route_tests';
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
  seed(sqlite);
  return { sqlite, DB };
}

/**
 * Two active frames sold as one lens value each, with stock on the lens group, a draft concept, an
 * archived product and an active case without variants.
 */
function seed(sqlite) {
  const now = Math.floor(Date.now() / 1000);
  const product = sqlite.prepare(`INSERT INTO _ecommerce_products
    (id, name, slug, base_price, inventory_quantity, status, created_at, updated_at) VALUES (?, ?, ?, ?, 5, ?, ?, ?)`);
  product.run('frame', 'Frame', 'frame', 12000, 'active', now, now);
  product.run('other', 'Other frame', 'other', 9000, 'active', now, now);
  product.run('concept', 'Concept', 'concept', 0, 'draft', now, now);
  product.run('retired', 'Retired', 'retired', 12000, 'archived', now, now);
  product.run('case', 'Case', 'case', 2000, 'active', now, now);
  for (const id of ['frame', 'other']) {
    sqlite.prepare(`INSERT INTO _ecommerce_product_variants (id, product_id, name, inventory_quantity, created_at, updated_at)
      VALUES (?, ?, 'Lens', 5, ?, ?)`).run(`${id}-lens`, id, now, now);
    sqlite.prepare(`INSERT INTO _ecommerce_product_variant_values (id, product_variant_id, value, created_at, updated_at)
      VALUES (?, ?, 'Amber', ?, ?)`).run(`${id}-amber`, `${id}-lens`, now, now);
  }
}

function cookieJar(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    get(name) { return values.has(name) ? { value: values.get(name) } : undefined; },
    set(name, value, options) { values.set(name, value); writes.push(['set', name, value, options]); },
    delete(name, options) { values.delete(name); writes.push(['delete', name, options]); },
  };
}

async function call(route, env, { method = 'POST', path = '/api/ecommerce/test', cookies = {}, body, raw,
  headers = {}, origin = ORIGIN } = {}) {
  globalThis.workerEnv = env;
  const jar = cookieJar(cookies);
  const request = new Request(`${ORIGIN}${path}`, {
    method, headers: { ...(origin ? { origin } : {}), 'Content-Type': 'application/json', ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const response = await route({ request, cookies: jar });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, jar };
}

const postCart = (DB, body, cookies = {}) => call(cartRoute, { DB }, { path: '/api/ecommerce/cart', body, cookies });
const count = (sqlite, table) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const shippingAddress = { name: 'Test Shopper', line1: '1 Main St', city: 'Austin', postalCode: '78701', country: 'US' };
const checkoutDetails = { customerEmail: 'owner@example.test', shippingAddress,
  successUrl: `${ORIGIN}/checkout/success?order={ORDER_ID}`, cancelUrl: `${ORIGIN}/checkout/cancel?order={ORDER_ID}` };

/** Stands in for Stripe when an order is placed directly through the API. */
const hostedCheckout = {
  providerId: 'stripe',
  async createCheckoutSession({ orderId }) {
    return { providerSessionId: `cs_test_${orderId}`, url: `https://checkout.stripe.test/${orderId}` };
  },
  async expireCheckoutSession() {},
  async getCheckoutSession() { return { status: 'open', url: 'https://checkout.stripe.test/open' }; },
};

async function placeOrder(DB, sessionToken, adapter = hostedCheckout) {
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [adapter] });
  const cart = await api.carts.getOrCreate(sessionToken);
  await api.carts.updateItems(cart.id, [{ productId: 'frame', variantId: 'frame-amber', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, { ...checkoutDetails, providerId: adapter.providerId });
  return { api, cart, order };
}

function signInShopper(sqlite, accountId, token) {
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT OR IGNORE INTO _ecommerce_customer_accounts
    (id, email, email_normalized, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(accountId, `${accountId}@example.test`, `${accountId}@example.test`, now, now, now);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_sessions (id, account_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(`session-${token}`, accountId, createHash('sha256').update(token).digest('hex'), now + 3600, now);
}

// --- Stripe webhook signatures -----------------------------------------------------------------

const stripeEnv = (DB) => ({ DB, TALISMAN_COMMERCE_STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: 'sk_test_route_tests', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });

function completedEvent(order, currency = 'usd') {
  return JSON.stringify({ id: `evt_${order.id}`, object: 'event', type: 'checkout.session.completed', data: { object: {
    id: order.checkoutSessionId, object: 'checkout.session', client_reference_id: order.id,
    metadata: { orderId: order.id }, payment_status: 'paid', amount_total: order.totalAmount,
    currency, payment_intent: `pi_${order.id}`, customer_details: { email: 'owner@example.test' },
  } } });
}

const signed = (payload, { secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) =>
  Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });

const postWebhook = (env, payload, signature) => call(webhookRoute, env, {
  path: '/api/ecommerce/webhooks/stripe', raw: payload, origin: null,
  headers: signature ? { 'stripe-signature': signature } : {},
});

test('a webhook signed with the endpoint secret settles the order once, even when replayed', async () => {
  const { sqlite, DB } = database();
  const { order } = await placeOrder(DB, 'webhook-browser');
  const env = stripeEnv(DB);
  const payload = completedEvent(order);
  const signature = signed(payload);

  const first = await postWebhook(env, payload, signature);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { success: true, orderId: order.id, status: 'paid' });
  const stored = sqlite.prepare('SELECT status, payment_intent_id FROM _ecommerce_orders WHERE id = ?').get(order.id);
  assert.deepEqual({ ...stored }, { status: 'paid', payment_intent_id: `pi_${order.id}` });

  // Stripe retries and an attacker replaying a captured delivery inside the tolerance get the same answer.
  const replay = await postWebhook(env, payload, signature);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.duplicate, true);
  assert.equal(count(sqlite, '_ecommerce_payments'), 1);
  sqlite.close();
});

test('webhooks with a wrong secret, a stale timestamp, a changed payload or no signature are rejected', async () => {
  const { sqlite, DB } = database();
  const { order } = await placeOrder(DB, 'forged-browser');
  const env = stripeEnv(DB);
  const payload = completedEvent(order);

  const wrongSecret = await postWebhook(env, payload, signed(payload, { secret: 'whsec_someone_else' }));
  assert.equal(wrongSecret.status, 400);
  assert.match(wrongSecret.json.error, /^Webhook Error: No signatures found/);

  // A captured delivery replayed after Stripe's five-minute tolerance.
  const stale = await postWebhook(env, payload, signed(payload, { timestamp: Math.floor(Date.now() / 1000) - 10 * 60 }));
  assert.equal(stale.status, 400);
  assert.match(stale.json.error, /Timestamp outside the tolerance zone/);

  const tampered = await postWebhook(env, payload.replace('"amount_total":12000', '"amount_total":1'), signed(payload));
  assert.equal(tampered.status, 400);
  assert.match(tampered.json.error, /^Webhook Error:/);

  const unsigned = await postWebhook(env, payload);
  assert.deepEqual([unsigned.status, unsigned.json], [400, { error: 'Missing stripe-signature header' }]);

  const unconfigured = await postWebhook({ DB }, payload, signed(payload));
  assert.deepEqual([unconfigured.status, unconfigured.json], [400, { error: 'Stripe is not configured' }]);

  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_orders WHERE id = ?').get(order.id).status, 'pending');
  assert.equal(count(sqlite, '_ecommerce_payments'), 0);
  sqlite.close();
});

test('a store that sells in EUR records its orders in EUR and confirms only a payment in EUR', async () => {
  const { sqlite, DB } = database();
  const settings = { TALISMAN_COMMERCE_CURRENCY: 'EUR' };
  const sessions = [];
  const adapter = { ...hostedCheckout, async createCheckoutSession(input) {
    sessions.push(input);
    return hostedCheckout.createCheckoutSession(input);
  } };
  const api = bindCommerceApi({ env: { DB, ...settings }, paymentAdapters: [adapter] });
  const cart = await api.carts.getOrCreate('euro-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'frame', variantId: 'frame-amber', quantity: 1 }]);
  assert.equal((await api.carts.quote(cart.id)).currency, 'eur');
  const { order } = await api.orders.createFromCart(cart.id, { ...checkoutDetails, providerId: 'stripe' });
  assert.equal(order.currency, 'eur');
  assert.equal(sessions[0].currency, 'eur');
  assert.equal((await api.orders.create({ totalAmount: 100, items: [] })).currency, 'eur');

  // Stripe reports the currency it charged; a payment in another currency never confirms the order.
  const env = { ...stripeEnv(DB), ...settings };
  const inDollars = completedEvent(order);
  const refused = await postWebhook(env, inDollars, signed(inDollars));
  // A mismatch no retry can fix is answered 200, so Stripe keeps the endpoint, and changes nothing.
  assert.deepEqual([refused.status, refused.json], [200, { success: true, event: 'checkout.session.completed', ignored: true, reason: 'currency_mismatch' }]);
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_orders WHERE id = ?').get(order.id).status, 'pending');
  assert.equal(count(sqlite, '_ecommerce_payments'), 0);
  const inEuros = completedEvent(order, 'eur');
  const confirmed = await postWebhook(env, inEuros, signed(inEuros));
  assert.deepEqual([confirmed.status, confirmed.json], [200, { success: true, orderId: order.id, status: 'paid' }]);
  sqlite.close();
});

// --- Checkout-disabled gate ----------------------------------------------------------------------

const disabledSettings = [{}, { TALISMAN_COMMERCE_CHECKOUT_ENABLED: 'false' }, { TALISMAN_COMMERCE_CHECKOUT_ENABLED: ' ' }];

test('the checkout route answers 503 before reading or writing anything while checkout is disabled', async () => {
  const { sqlite, DB } = database();
  const api = bindCommerceApi({ env: { DB } });
  const cart = await api.carts.getOrCreate('gated-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'frame', variantId: 'frame-amber', quantity: 1 }]);
  const before = sqlite.prepare('SELECT * FROM _ecommerce_carts').all();

  for (const settings of disabledSettings) {
    for (const cookies of [{ [CART_SESSION_COOKIE]: 'gated-browser' }, {}]) {
      const response = await call(checkoutRoute, { DB, ...stripeEnv(DB), ...settings }, {
        path: '/api/ecommerce/checkout', cookies, body: { customerEmail: 'owner@example.test', shippingAddress } });
      assert.deepEqual([response.status, response.json], [503, { error: 'Checkout is disabled' }]);
      assert.deepEqual(response.jar.writes, []);
    }
  }
  // Even a cross-site or malformed request gets the same answer.
  const crossSite = await call(checkoutRoute, { DB }, { path: '/api/ecommerce/checkout', origin: 'https://evil.test', raw: '{' });
  assert.equal(crossSite.status, 503);
  assert.deepEqual(sqlite.prepare('SELECT * FROM _ecommerce_carts').all(), before);
  assert.equal(count(sqlite, '_ecommerce_orders'), 0);
  sqlite.close();
});

test('with checkout enabled but Stripe unconfigured, the route never falls back to a simulated payment', async () => {
  const { sqlite, DB } = database();
  const api = bindCommerceApi({ env: { DB } });
  const cart = await api.carts.getOrCreate('enabled-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'frame', variantId: 'frame-amber', quantity: 1 }]);
  const response = await call(checkoutRoute, { DB, TALISMAN_COMMERCE_CHECKOUT_ENABLED: 'true' }, {
    path: '/api/ecommerce/checkout', cookies: { [CART_SESSION_COOKIE]: 'enabled-browser' },
    body: { customerEmail: 'owner@example.test', shippingAddress } });
  assert.deepEqual([response.status, response.json],
    [409, { error: 'A payment provider must be selected and configured before checkout' }]);
  assert.equal(count(sqlite, '_ecommerce_orders'), 0);
  assert.equal(sqlite.prepare('SELECT checkout_session_id FROM _ecommerce_carts').get().checkout_session_id, null);
  sqlite.close();
});

test('the checkout action is refused while checkout is disabled, without setting a basket cookie', async () => {
  const { sqlite, DB } = database();
  for (const settings of disabledSettings) {
    globalThis.workerEnv = { DB, ...settings };
    const cookies = cookieJar();
    await assert.rejects(ecommerceActions.checkout.handler({ customerEmail: 'owner@example.test', shippingAddress },
      { cookies, url: new URL(`${ORIGIN}/_actions/checkout`) }), { code: 'FORBIDDEN', message: 'Checkout is disabled' });
    assert.deepEqual(cookies.writes, []);
  }
  assert.equal(count(sqlite, '_ecommerce_carts'), 0);
  sqlite.close();
});

test('gift card purchases are refused unless both checkout and gift card sales are enabled', async () => {
  const { sqlite, DB } = database();
  const purchase = { amountCents: 5000, buyerEmail: 'buyer@example.test' };
  for (const settings of [...disabledSettings, { TALISMAN_COMMERCE_CHECKOUT_ENABLED: 'true' },
    { TALISMAN_COMMERCE_GIFT_CARDS_ENABLED: 'true' }]) {
    const response = await call(giftCardsRoute, { ...stripeEnv(DB), ...settings }, { path: '/api/ecommerce/gift-cards', body: purchase });
    assert.deepEqual([response.status, response.json], [503, { error: 'Gift card purchases are unavailable' }]);
    assert.deepEqual(response.jar.writes, []);
  }
  assert.equal(count(sqlite, '_ecommerce_gift_card_purchases'), 0);
  sqlite.close();
});

/** A basket with one frame ($120) and an active 10% code, for the discount preview. */
async function discountFixture() {
  const { sqlite, DB } = database();
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_discount_codes (code, type, value, created_at, updated_at)
    VALUES ('SAVE10', 'percent', 1000, ?, ?)`).run(now, now);
  const api = bindCommerceApi({ env: { DB } });
  const cart = await api.carts.getOrCreate('discount-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'frame', variantId: 'frame-amber', quantity: 1 }]);
  return { sqlite, DB };
}

test('the discount preview answers 503 before reading anything while checkout is disabled', async () => {
  const { sqlite, DB } = await discountFixture();
  signInShopper(sqlite, 'preview-shopper', 'preview-token');
  let statements = 0;
  const countingDB = { prepare(sql) { statements += 1; return DB.prepare(sql); }, batch: (list) => DB.batch(list) };
  const cookieSets = [{ [CART_SESSION_COOKIE]: 'discount-browser' },
    { [CART_SESSION_COOKIE]: 'discount-browser', [CUSTOMER_SESSION_COOKIE]: 'preview-token' }, {}];
  for (const settings of disabledSettings) {
    for (const cookies of cookieSets) {
      const response = await call(discountRoute, { DB: countingDB, ...settings }, { path: '/api/ecommerce/discount',
        cookies, body: { code: 'SAVE10', customerEmail: 'someone@example.test' } });
      assert.deepEqual([response.status, response.json], [503, { error: 'Checkout is disabled' }]);
      assert.deepEqual(response.jar.writes, []);
    }
  }
  // A cross-site, malformed or empty request gets the same answer.
  for (const request of [{ origin: 'https://evil.test', raw: '{' }, { raw: '{' }, { body: {} }]) {
    const response = await call(discountRoute, { DB: countingDB }, { path: '/api/ecommerce/discount', ...request });
    assert.deepEqual([response.status, response.json], [503, { error: 'Checkout is disabled' }]);
  }
  assert.equal(statements, 0);
  sqlite.close();
});

test('with checkout enabled, the discount preview keeps its checks and prices the basket', async () => {
  const { sqlite, DB } = await discountFixture();
  const env = { DB, TALISMAN_COMMERCE_CHECKOUT_ENABLED: 'true' };
  const preview = (body, cookies = { [CART_SESSION_COOKIE]: 'discount-browser' }, options = {}) =>
    call(discountRoute, env, { path: '/api/ecommerce/discount', cookies, body, ...options });

  const crossSite = await preview({ code: 'SAVE10' }, undefined, { origin: 'https://evil.test' });
  assert.deepEqual([crossSite.status, crossSite.json], [403, { error: 'Same-origin request required' }]);
  const empty = await preview({});
  assert.deepEqual([empty.status, empty.json], [400, { error: 'Enter a discount or gift card code' }]);
  const noBasket = await preview({ code: 'SAVE10' }, {});
  assert.deepEqual([noBasket.status, noBasket.json], [404, { error: 'Basket not found' }]);
  const unknown = await preview({ code: 'NOPE10', customerEmail: 'guest@example.test' });
  assert.deepEqual([unknown.status, unknown.json], [409, { error: 'This code is not valid for this order.', field: 'code' }]);

  const priced = { code: 'SAVE10', type: 'percent', discountAmount: 1200, creditApplied: 0,
    giftCardApplied: 0, giftCardSuffix: null, cardAmount: 10800 };
  const guest = await preview({ code: 'save10', customerEmail: 'guest@example.test' });
  assert.deepEqual([guest.status, guest.json], [200, priced]);
  // A signed-in shopper is checked against their own account's address.
  signInShopper(sqlite, 'preview-shopper', 'preview-token');
  const shopper = await preview({ code: 'SAVE10' },
    { [CART_SESSION_COOKIE]: 'discount-browser', [CUSTOMER_SESSION_COOKIE]: 'preview-token' });
  assert.deepEqual([shopper.status, shopper.json], [200, priced]);
  assert.deepEqual(shopper.jar.writes, []);
  // A preview reserves nothing.
  assert.equal(count(sqlite, '_ecommerce_discount_redemptions'), 0);
  assert.equal(count(sqlite, '_ecommerce_orders'), 0);
  sqlite.close();
});

test('the discount preview leaves the minimum charge of the store currency on the card', async () => {
  const { sqlite, DB } = await discountFixture();
  signInShopper(sqlite, 'pound-shopper', 'pound-token');
  sqlite.prepare("UPDATE _ecommerce_customer_accounts SET credit_balance = 20000 WHERE id = 'pound-shopper'").run();
  const env = { DB, TALISMAN_COMMERCE_CHECKOUT_ENABLED: 'true', TALISMAN_COMMERCE_CURRENCY: 'gbp' };
  const response = await call(discountRoute, env, { path: '/api/ecommerce/discount', body: { code: 'SAVE10' },
    cookies: { [CART_SESSION_COOKIE]: 'discount-browser', [CUSTOMER_SESSION_COOKIE]: 'pound-token' } });
  // Stripe's minimum is 30 pence, where a USD store keeps 50 cents.
  assert.deepEqual([response.status, response.json], [200, { code: 'SAVE10', type: 'percent', discountAmount: 1200,
    creditApplied: 10770, giftCardApplied: 0, giftCardSuffix: null, cardAmount: 30 }]);
  sqlite.close();
});

test('invalid store settings close checkout with a generic 503 and log the setting for the operator', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (message) => { logged.push(message); });
  t.after(() => { delete globalThis.cmsUser; });
  const { sqlite, DB } = database();
  const { order } = await placeOrder(DB, 'earlier-browser');
  const api = bindCommerceApi({ env: { DB } });
  const cart = await api.carts.getOrCreate('misconfigured-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'frame', variantId: 'frame-amber', quantity: 1 }]);
  const before = sqlite.prepare('SELECT * FROM _ecommerce_carts').all();
  const env = { ...stripeEnv(DB), TALISMAN_COMMERCE_CHECKOUT_ENABLED: 'true', TALISMAN_COMMERCE_GIFT_CARDS_ENABLED: 'true',
    TALISMAN_COMMERCE_GIFT_CARD_KEY: 'a'.repeat(64), TALISMAN_COMMERCE_CURRENCY: 'dollars' };
  const cookies = { [CART_SESSION_COOKIE]: 'misconfigured-browser' };
  globalThis.cmsUser = { id: 'admin-1', email: 'admin@shop.test', role: 'admin' };

  const requests = [
    [checkoutRoute, { path: '/api/ecommerce/checkout', cookies, body: { customerEmail: 'owner@example.test', shippingAddress } }],
    [discountRoute, { path: '/api/ecommerce/discount', cookies, body: { code: 'SAVE10', customerEmail: 'owner@example.test' } }],
    [giftCardsRoute, { path: '/api/ecommerce/gift-cards', body: { amountCents: 5000, buyerEmail: 'buyer@example.test' } }],
    [adminGiftCardsRoute, { path: '/admin/api/ecommerce/gift-cards-admin',
      body: { action: 'issue', data: { amountCents: 5000, reason: 'Customer service goodwill' } } }],
    [adminTestCheckoutRoute, { method: 'GET', path: '/admin/api/ecommerce/test-checkout', cookies }],
    [adminTestCheckoutRoute, { path: '/admin/api/ecommerce/test-checkout', cookies,
      body: { customerEmail: 'admin@shop.test', shippingAddress } }],
  ];
  for (const [route, request] of requests) {
    const response = await call(route, env, request);
    assert.deepEqual([response.status, response.json], [503, { error: 'Checkout is temporarily unavailable.' }],
      `${request.method ?? 'POST'} ${request.path}`);
    assert.deepEqual(response.jar.writes, []);
  }
  globalThis.workerEnv = env;
  const jar = cookieJar();
  await assert.rejects(ecommerceActions.checkout.handler({ customerEmail: 'owner@example.test', shippingAddress },
    { cookies: jar, url: new URL(`${ORIGIN}/_actions/checkout`) }),
    { code: 'SERVICE_UNAVAILABLE', message: 'Checkout is temporarily unavailable.' });
  assert.deepEqual(jar.writes, []);

  // The details reach the Worker log only, once per refusal.
  assert.equal(logged.length, requests.length + 1);
  for (const message of logged) {
    assert.match(message, /^\[Commerce\] Store settings are invalid: TALISMAN_COMMERCE_CURRENCY must be /);
  }
  assert.deepEqual(sqlite.prepare('SELECT * FROM _ecommerce_carts').all(), before);
  assert.equal(count(sqlite, '_ecommerce_orders'), 1);
  assert.equal(count(sqlite, '_ecommerce_gift_card_purchases'), 0);
  assert.equal(count(sqlite, '_ecommerce_gift_cards'), 0);

  // A payment for an order placed earlier is still recorded against the order's own currency.
  const payload = completedEvent(order);
  const settled = await postWebhook(env, payload, signed(payload));
  assert.deepEqual([settled.status, settled.json], [200, { success: true, orderId: order.id, status: 'paid' }]);
  sqlite.close();
});

// --- Delivery countries --------------------------------------------------------------------------

const addressIn = (country) => ({ ...shippingAddress, country });

/** Orders a frame from a basket of its own, with the given addresses. */
async function orderTo(env, sessionToken, addresses, adapter = hostedCheckout) {
  const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const cart = await api.carts.getOrCreate(sessionToken);
  await api.carts.updateItems(cart.id, [{ productId: 'frame', variantId: 'frame-amber', quantity: 1 }]);
  return api.orders.createFromCart(cart.id, { ...checkoutDetails, ...addresses, providerId: adapter.providerId });
}

/** The stored [shipping, billing] countries of an order. */
function storedCountries(sqlite, orderId) {
  const order = sqlite.prepare('SELECT shipping_address, billing_address FROM _ecommerce_orders WHERE id = ?')
    .get(orderId);
  return [order.shipping_address, order.billing_address].map((address) => address && JSON.parse(address).country);
}

test('checkout ships only to the delivery countries, for every provider, and stores codes in uppercase', async () => {
  const { sqlite, DB } = database();
  const env = { DB, TALISMAN_COMMERCE_DELIVERY_COUNTRIES: 'CA, us' };
  // Any case is accepted. The billing country must be a country code but may be outside the list.
  const { order } = await orderTo(env, 'canada-browser',
    { shippingAddress: addressIn(' ca '), billingAddress: addressIn('gb') });
  assert.deepEqual(storedCountries(sqlite, order.id), ['CA', 'GB']);

  const refusals = [
    [{ shippingAddress: addressIn('GB') }, 'We do not deliver to this country'],
    [{ shippingAddress: addressIn('XX') }, 'Enter a valid country code'],
    [{ shippingAddress: addressIn('uk') }, 'Enter a valid country code'],
    [{ shippingAddress: addressIn('US'), billingAddress: addressIn('USA') }, 'Enter a valid country code'],
  ];
  for (const adapter of [hostedCheckout, new AdminTestPaymentAdapter()]) {
    for (const [addresses, message] of refusals) {
      await assert.rejects(orderTo(env, 'refused-browser', addresses, adapter), { message },
        `${adapter.providerId} ${JSON.stringify(addresses)}`);
    }
  }
  // Refused before anything was reserved: the basket is still open and only the first order holds stock.
  assert.equal(count(sqlite, '_ecommerce_orders'), 1);
  assert.equal(sqlite.prepare("SELECT checkout_session_id FROM _ecommerce_carts WHERE session_token = 'refused-browser'")
    .get().checkout_session_id, null);
  assert.equal(sqlite.prepare("SELECT inventory_quantity FROM _ecommerce_product_variants WHERE id = 'frame-lens'")
    .get().inventory_quantity, 4);
  sqlite.close();
});

test('without delivery countries, checkout accepts any assigned country code and refuses others', async () => {
  const { sqlite, DB } = database();
  const { order } = await orderTo({ DB }, 'anywhere-browser', { shippingAddress: addressIn('nz') });
  assert.deepEqual(storedCountries(sqlite, order.id), ['NZ', null]);
  await assert.rejects(orderTo({ DB }, 'nowhere-browser', { shippingAddress: addressIn('UK') }),
    { message: 'Enter a valid country code' });
  sqlite.close();
});

test('a basket with nothing to ship is not held to the delivery countries', async () => {
  const { sqlite, DB } = database();
  sqlite.exec("UPDATE _ecommerce_products SET is_physical = 0 WHERE id = 'case'");
  const env = { DB, TALISMAN_COMMERCE_DELIVERY_COUNTRIES: 'CA' };
  const api = bindCommerceApi({ env, paymentAdapters: [hostedCheckout] });
  const cart = await api.carts.getOrCreate('digital-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'case', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, { ...checkoutDetails, providerId: 'stripe',
    shippingAddress: undefined, billingAddress: addressIn('fr') });
  assert.deepEqual(storedCountries(sqlite, order.id), [null, 'FR']);
  sqlite.close();
});

test('the checkout routes and action answer an unknown or undeliverable country as a bad request', async (t) => {
  t.after(() => { delete globalThis.cmsUser; });
  const { sqlite, DB } = database();
  const api = bindCommerceApi({ env: { DB } });
  const cart = await api.carts.getOrCreate('abroad-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'frame', variantId: 'frame-amber', quantity: 1 }]);
  const env = { ...stripeEnv(DB), TALISMAN_COMMERCE_CHECKOUT_ENABLED: 'true',
    TALISMAN_COMMERCE_DELIVERY_COUNTRIES: 'CA' };
  const cookies = { [CART_SESSION_COOKIE]: 'abroad-browser' };

  const cases = [
    [{ shippingAddress }, 'We do not deliver to this country'],
    [{ shippingAddress: addressIn('uk') }, 'Enter a valid country code'],
    [{ shippingAddress: addressIn('CA'), billingAddress: addressIn('XX') }, 'Enter a valid country code'],
    [{ shippingAddress: addressIn('CA'), customerEmail: 'not an email' }, 'Invalid checkout details'],
  ];
  for (const [details, error] of cases) {
    const response = await call(checkoutRoute, env, { path: '/api/ecommerce/checkout', cookies,
      body: { customerEmail: 'owner@example.test', ...details } });
    assert.deepEqual([response.status, response.json], [400, { error }], JSON.stringify(details));
  }

  globalThis.workerEnv = env;
  const refusals = [[shippingAddress, 'We do not deliver to this country'], [addressIn('xx'), 'Enter a valid country code']];
  for (const [address, message] of refusals) {
    await assert.rejects(ecommerceActions.checkout.handler({ customerEmail: 'owner@example.test', shippingAddress: address },
      { cookies: cookieJar(cookies), url: new URL(`${ORIGIN}/_actions/checkout`) }), { code: 'BAD_REQUEST', message });
  }

  globalThis.cmsUser = { id: 'admin-1', email: 'admin@shop.test', role: 'admin' };
  const adminCheckout = (address) => call(adminTestCheckoutRoute, env, { path: '/admin/api/ecommerce/test-checkout',
    cookies, body: { customerEmail: 'admin@shop.test', shippingAddress: address } });
  for (const [address, error] of refusals) {
    const refused = await adminCheckout(address);
    assert.deepEqual([refused.status, refused.json], [400, { error }]);
  }
  assert.equal(count(sqlite, '_ecommerce_orders'), 0);
  assert.equal(sqlite.prepare('SELECT checkout_session_id FROM _ecommerce_carts').get().checkout_session_id, null);
  const placed = await adminCheckout(addressIn('ca'));
  assert.deepEqual([placed.status, placed.json.status], [200, 'paid']);
  assert.deepEqual(storedCountries(sqlite, placed.json.orderId), ['CA', null]);
  sqlite.close();
});

// --- Shipping rates ------------------------------------------------------------------------------

const shippingRates = [
  { id: 'standard', label: 'Standard shipping', amount: 700, countries: ['US', 'CA'], freeOver: 20000,
    minDays: 3, maxDays: 5 },
  { id: 'express', label: 'Express shipping', amount: 2500, countries: ['US'], maxDays: 2 },
  { id: 'international', label: 'International shipping', amount: 1500, countries: ['GB'] },
];
const withShipping = { TALISMAN_COMMERCE_SHIPPING_RATES: JSON.stringify(shippingRates) };
const unavailableOption = 'This shipping option is not available for your country';

/** The stored [rate id, label, shipping amount, total] of an order. */
function storedShipping(sqlite, orderId) {
  const order = sqlite.prepare(`SELECT shipping_rate_id, shipping_label, shipping_amount, total_amount
    FROM _ecommerce_orders WHERE id = ?`).get(orderId);
  return [order.shipping_rate_id, order.shipping_label, order.shipping_amount, order.total_amount];
}

/** The hosted checkout, recording what each session is asked to charge. */
function recordingCheckout(sessions) {
  return { ...hostedCheckout, async createCheckoutSession(input) {
    sessions.push(input);
    return hostedCheckout.createCheckoutSession(input);
  } };
}

test('checkout charges the chosen shipping rate, or else the first that serves the country', async () => {
  const { sqlite, DB } = database();
  sqlite.exec('UPDATE _ecommerce_product_variants SET inventory_quantity = 20');
  const sessions = [];
  const cases = [
    [{ shippingAddress: addressIn('us') }, ['standard', 'Standard shipping', 700, 12700]],
    [{ shippingAddress: addressIn('US'), shippingRateId: 'express' }, ['express', 'Express shipping', 2500, 14500]],
    [{ shippingAddress: addressIn('CA'), shippingRateId: ' standard ' }, ['standard', 'Standard shipping', 700, 12700]],
    [{ shippingAddress: addressIn('gb'), shippingRateId: '' }, ['international', 'International shipping', 1500, 13500]],
  ];
  for (const [index, [details, stored]] of cases.entries()) {
    const { order } = await orderTo({ DB, ...withShipping }, `shipping-browser-${index}`, details,
      recordingCheckout(sessions));
    assert.deepEqual(storedShipping(sqlite, order.id), stored, JSON.stringify(details));
    assert.deepEqual([order.subtotalAmount, order.shippingAmount, order.totalAmount], [12000, stored[2], stored[3]]);
  }
  // The provider is given the rate and its delivery estimate, to charge as a line of its own.
  assert.deepEqual(sessions.map((session) => session.shipping), [
    { label: 'Standard shipping', amount: 700, description: 'Delivery in 3–5 business days' },
    { label: 'Express shipping', amount: 2500, description: 'Delivery in up to 2 business days' },
    { label: 'Standard shipping', amount: 700, description: 'Delivery in 3–5 business days' },
    { label: 'International shipping', amount: 1500, description: undefined },
  ]);

  // A store without rates charges no shipping, as before, and ignores a requested option.
  const { order } = await orderTo({ DB }, 'no-rates-browser', { shippingRateId: 'express' }, recordingCheckout(sessions));
  assert.deepEqual(storedShipping(sqlite, order.id), [null, null, 0, 12000]);
  assert.equal(sessions.at(-1).shipping, undefined);
  sqlite.close();
});

test('a shipping rate is free once the items after discounts reach its freeOver', async () => {
  const { sqlite, DB } = database();
  sqlite.exec('UPDATE _ecommerce_product_variants SET inventory_quantity = 20');
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_discount_codes (code, type, value, created_at, updated_at)
    VALUES ('SAVE50', 'amount', 5000, ?, ?)`).run(now, now);
  const api = bindCommerceApi({ env: { DB, ...withShipping }, paymentAdapters: [hostedCheckout] });
  const twoFrames = async (sessionToken, details = {}) => {
    const cart = await api.carts.getOrCreate(sessionToken);
    await api.carts.updateItems(cart.id, [{ productId: 'frame', variantId: 'frame-amber', quantity: 2 }]);
    return (await api.orders.createFromCart(cart.id, { ...checkoutDetails, providerId: 'stripe', ...details })).order;
  };
  // $240 of items reach the $200 of the standard rate; the express rate is never free.
  const free = await twoFrames('free-shipping-browser');
  assert.deepEqual(storedShipping(sqlite, free.id), ['standard', 'Standard shipping', 0, 24000]);
  const express = await twoFrames('express-browser', { shippingRateId: 'express' });
  assert.deepEqual(storedShipping(sqlite, express.id), ['express', 'Express shipping', 2500, 26500]);
  // A discount that takes the items below it brings the charge back. The discount redemption guard
  // accepted the order, whose totals now include the shipping.
  const discounted = await twoFrames('discounted-browser', { discountCode: 'SAVE50' });
  assert.deepEqual([discounted.discountAmount, ...storedShipping(sqlite, discounted.id)],
    [5000, 'standard', 'Standard shipping', 700, 19700]);
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_discount_redemptions WHERE order_id = ?')
    .get(discounted.id).status, 'reserved');
  sqlite.close();
});

test('checkout refuses an option that does not serve the country, and a country no rate serves', async () => {
  const { sqlite, DB } = database();
  const refusals = [
    [{ shippingAddress: addressIn('GB'), shippingRateId: 'standard' }, unavailableOption],
    [{ shippingAddress: addressIn('CA'), shippingRateId: 'express' }, unavailableOption],
    [{ shippingAddress: addressIn('US'), shippingRateId: 'overnight' }, unavailableOption],
    // No rate serves France, whichever option is asked for.
    [{ shippingAddress: addressIn('FR') }, 'We do not deliver to this country'],
    [{ shippingAddress: addressIn('FR'), shippingRateId: 'express' }, 'We do not deliver to this country'],
  ];
  for (const adapter of [hostedCheckout, new AdminTestPaymentAdapter()]) {
    for (const [details, message] of refusals) {
      await assert.rejects(orderTo({ DB, ...withShipping }, 'refused-browser', details, adapter), { message },
        `${adapter.providerId} ${JSON.stringify(details)}`);
    }
  }
  // Refused before anything was reserved.
  assert.equal(count(sqlite, '_ecommerce_orders'), 0);
  assert.equal(sqlite.prepare('SELECT checkout_session_id FROM _ecommerce_carts').get().checkout_session_id, null);
  assert.equal(sqlite.prepare("SELECT inventory_quantity FROM _ecommerce_product_variants WHERE id = 'frame-lens'")
    .get().inventory_quantity, 5);
  sqlite.close();
});

test('an order with nothing to ship is charged no shipping, whatever option is sent', async () => {
  const { sqlite, DB } = database();
  sqlite.exec("UPDATE _ecommerce_products SET is_physical = 0 WHERE id = 'case'");
  const sessions = [];
  const api = bindCommerceApi({ env: { DB, ...withShipping }, paymentAdapters: [recordingCheckout(sessions)] });
  const cart = await api.carts.getOrCreate('digital-shipping-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'case', quantity: 1 }]);
  // No rate serves France, and nothing ships there.
  const { order } = await api.orders.createFromCart(cart.id, { ...checkoutDetails, providerId: 'stripe',
    shippingAddress: undefined, billingAddress: addressIn('FR'), shippingRateId: 'express' });
  assert.deepEqual(storedShipping(sqlite, order.id), [null, null, 0, 2000]);
  assert.equal(sessions[0].shipping, undefined);
  sqlite.close();
});

test('the Stripe session charges the items and the shipping line less the coupon, which is the order total', async () => {
  const { sqlite, DB } = database();
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_discount_codes (code, type, value, created_at, updated_at)
    VALUES ('SAVE10', 'percent', 1000, ?, ?)`).run(now, now);
  const stripe = new StripePaymentAdapter({ secretKey: 'sk_test_route_tests' });
  const calls = {};
  stripe.stripe = {
    coupons: { async create(input) { calls.coupon = input; return { id: 'coupon_route_tests' }; } },
    checkout: { sessions: { async create(input) {
      calls.session = input;
      return { id: 'cs_test_shipped', url: 'https://checkout.stripe.test/shipped' };
    } } },
  };
  const { order } = await orderTo({ DB, ...withShipping }, 'stripe-shipping-browser',
    { shippingRateId: 'express', discountCode: 'SAVE10' }, stripe);
  assert.deepEqual(calls.session.line_items.map(({ price_data: price, quantity }) =>
    [price.product_data.name, price.product_data.description, price.unit_amount, quantity]),
    [['Frame - Lens: Amber', undefined, 12000, 1], ['Express shipping', 'Delivery in up to 2 business days', 2500, 1]]);
  const lines = calls.session.line_items.reduce((sum, line) => sum + line.price_data.unit_amount * line.quantity, 0);
  assert.deepEqual([calls.coupon.amount_off, lines - calls.coupon.amount_off], [1200, order.totalAmount]);
  assert.deepEqual([order.discountAmount, order.shippingAmount, order.totalAmount], [1200, 2500, 13300]);
  sqlite.close();
});

test('a Stripe payment of the total with shipping confirms the order, and one of the items alone does not', async () => {
  const { sqlite, DB } = database();
  const { order } = await orderTo({ DB, ...withShipping }, 'shipped-browser', { shippingAddress: addressIn('GB') });
  assert.deepEqual([order.subtotalAmount, order.shippingAmount, order.totalAmount], [12000, 1500, 13500]);
  const env = { ...stripeEnv(DB), ...withShipping };
  const itemsOnly = completedEvent({ ...order, totalAmount: order.subtotalAmount });
  const refused = await postWebhook(env, itemsOnly, signed(itemsOnly));
  assert.deepEqual([refused.status, refused.json], [200, { success: true, event: 'checkout.session.completed', ignored: true, reason: 'amount_mismatch' }]);
  const payload = completedEvent(order);
  const settled = await postWebhook(env, payload, signed(payload));
  assert.deepEqual([settled.status, settled.json], [200, { success: true, orderId: order.id, status: 'paid' }]);
  assert.equal(sqlite.prepare('SELECT amount FROM _ecommerce_payments WHERE order_id = ?').get(order.id).amount, 13500);

  // The order status lists the shipping with the other totals.
  const status = await call(orderRoute, { DB }, { method: 'GET', path: `/api/ecommerce/order?order=${order.id}`,
    cookies: { [CART_SESSION_COOKIE]: 'shipped-browser' } });
  assert.deepEqual([status.status, status.json.shippingAmount, status.json.shippingLabel, status.json.totalAmount],
    [200, 1500, 'International shipping', 13500]);
  sqlite.close();
});

test('the checkout routes and action pass the shipping option on and answer a refused one as a bad request', async (t) => {
  t.after(() => { delete globalThis.cmsUser; });
  const { sqlite, DB } = database();
  const api = bindCommerceApi({ env: { DB } });
  const cart = await api.carts.getOrCreate('option-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'frame', variantId: 'frame-amber', quantity: 1 }]);
  const env = { ...stripeEnv(DB), TALISMAN_COMMERCE_CHECKOUT_ENABLED: 'true', ...withShipping };
  const cookies = { [CART_SESSION_COOKIE]: 'option-browser' };
  const refused = { shippingAddress: addressIn('GB'), shippingRateId: 'express' };

  const response = await call(checkoutRoute, env, { path: '/api/ecommerce/checkout', cookies,
    body: { customerEmail: 'owner@example.test', ...refused } });
  assert.deepEqual([response.status, response.json], [400, { error: unavailableOption }]);
  globalThis.workerEnv = env;
  await assert.rejects(ecommerceActions.checkout.handler({ customerEmail: 'owner@example.test', ...refused },
    { cookies: cookieJar(cookies), url: new URL(`${ORIGIN}/_actions/checkout`) }),
    { code: 'BAD_REQUEST', message: unavailableOption });

  globalThis.cmsUser = { id: 'admin-1', email: 'admin@shop.test', role: 'admin' };
  const adminCheckout = (details) => call(adminTestCheckoutRoute, env, { path: '/admin/api/ecommerce/test-checkout',
    cookies, body: { customerEmail: 'admin@shop.test', ...details } });
  const adminRefused = await adminCheckout(refused);
  assert.deepEqual([adminRefused.status, adminRefused.json], [400, { error: unavailableOption }]);
  assert.equal(count(sqlite, '_ecommerce_orders'), 0);
  const placed = await adminCheckout({ shippingAddress, shippingRateId: 'express' });
  assert.deepEqual([placed.status, placed.json.status], [200, 'paid']);
  assert.deepEqual(storedShipping(sqlite, placed.json.orderId), ['express', 'Express shipping', 2500, 14500]);
  sqlite.close();
});

test('invalid shipping rates close checkout with the generic 503 and log the rate for the operator', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (message) => { logged.push(message); });
  const { sqlite, DB } = database();
  const api = bindCommerceApi({ env: { DB } });
  const cart = await api.carts.getOrCreate('misrated-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'frame', variantId: 'frame-amber', quantity: 1 }]);
  const env = { ...stripeEnv(DB), TALISMAN_COMMERCE_CHECKOUT_ENABLED: 'true',
    TALISMAN_COMMERCE_SHIPPING_RATES: '[{"id":"standard","label":"Standard shipping"}]' };
  const response = await call(checkoutRoute, env, { path: '/api/ecommerce/checkout',
    cookies: { [CART_SESSION_COOKIE]: 'misrated-browser' }, body: { customerEmail: 'owner@example.test', shippingAddress } });
  assert.deepEqual([response.status, response.json], [503, { error: 'Checkout is temporarily unavailable.' }]);
  assert.deepEqual(logged, ['[Commerce] Store settings are invalid: TALISMAN_COMMERCE_SHIPPING_RATES[0].amount: Required']);
  assert.equal(count(sqlite, '_ecommerce_orders'), 0);
  sqlite.close();
});

// --- Stripe Tax ----------------------------------------------------------------------------------

/**
 * Replaces the Stripe adapter's tax calculation for one test, so no request reaches Stripe. The
 * returned function sets what the calculation does next.
 */
function stubTaxCalculation(t) {
  const original = StripePaymentAdapter.prototype.calculateTax;
  let calculate = () => { throw new Error('No tax calculation was expected'); };
  StripePaymentAdapter.prototype.calculateTax = async function (params) { return calculate(params); };
  t.after(() => { StripePaymentAdapter.prototype.calculateTax = original; });
  return (next) => { calculate = next; };
}

test('the checkout route and action answer a missing tax address as a bad request and a failed calculation with 503', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (message) => { logged.push(message); });
  const calculateNext = stubTaxCalculation(t);
  const { sqlite, DB } = database();
  sqlite.exec("UPDATE _ecommerce_products SET is_physical = 0 WHERE id = 'case'");
  const api = bindCommerceApi({ env: { DB } });
  const cart = await api.carts.getOrCreate('taxed-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'case', quantity: 1 }]);
  const env = { ...stripeEnv(DB), TALISMAN_COMMERCE_CHECKOUT_ENABLED: 'true', TALISMAN_COMMERCE_TAX: 'stripe-exclusive' };
  const cookies = { [CART_SESSION_COOKIE]: 'taxed-browser' };
  const checkout = async (details) => {
    const response = await call(checkoutRoute, env, { path: '/api/ecommerce/checkout', cookies,
      body: { customerEmail: 'owner@example.test', ...details } });
    return [response.status, response.json];
  };
  const action = (details) => {
    globalThis.workerEnv = env;
    return ecommerceActions.checkout.handler({ customerEmail: 'owner@example.test', ...details },
      { cookies: cookieJar(cookies), url: new URL(`${ORIGIN}/_actions/checkout`) });
  };
  const billed = { billingAddress: { country: 'US', postalCode: '78701' } };

  // Nothing ships, so tax needs the billing address.
  const required = 'A billing address is required to calculate tax';
  assert.deepEqual(await checkout({}), [400, { error: required }]);
  await assert.rejects(action({}), { code: 'BAD_REQUEST', message: required });

  calculateNext(() => { throw new TaxAddressError(); });
  const unusable = 'Tax cannot be calculated for this address. Check it and try again.';
  assert.deepEqual(await checkout(billed), [400, { error: unusable }]);
  await assert.rejects(action(billed), { code: 'BAD_REQUEST', message: unusable });
  assert.deepEqual(logged, []);

  calculateNext(() => { throw new Error('Stripe Tax is not active'); });
  const unavailable = 'Tax could not be calculated. Please try again.';
  assert.deepEqual(await checkout(billed), [503, { error: unavailable }]);
  await assert.rejects(action(billed), { code: 'SERVICE_UNAVAILABLE', message: unavailable });
  // The cause reaches the Worker log only.
  assert.deepEqual(logged, Array(2).fill(`[Commerce] Tax could not be calculated for basket ${cart.id}: Stripe Tax is not active`));

  assert.equal(count(sqlite, '_ecommerce_orders'), 0);
  assert.equal(sqlite.prepare('SELECT checkout_session_id FROM _ecommerce_carts').get().checkout_session_id, null);
  sqlite.close();
});

test('the order status lists the tax and how it was charged with the other totals', async () => {
  const { sqlite, DB } = database();
  const taxing = { ...hostedCheckout,
    async calculateTax(params) {
      const base = params.lines.reduce((sum, line) => sum + line.amount, 0) + params.shippingAmount;
      return { id: 'taxcalc_status', amountTotal: base + 990, taxAmountExclusive: 990, taxAmountInclusive: 0 };
    },
    async recordTaxTransaction({ orderId }) { return { transactionId: `tax_${orderId}` }; },
    async reverseTaxTransaction({ reference }) { return { reversalId: reference }; } };
  const readStatus = async (env, sessionToken) => {
    const { order } = await orderTo(env, sessionToken, { shippingAddress: addressIn('GB') }, taxing);
    await bindCommerceApi({ env, paymentAdapters: [taxing] }).orders.finalizePayment(order.id, { provider: 'stripe',
      providerId: order.checkoutSessionId, paymentStatus: 'success', amount: order.totalAmount, currency: 'usd' });
    const status = await call(orderRoute, { DB }, { method: 'GET', path: `/api/ecommerce/order?order=${order.id}`,
      cookies: { [CART_SESSION_COOKIE]: sessionToken } });
    return [status.status, status.json.taxAmount, status.json.taxBehavior, status.json.shippingAmount,
      status.json.totalAmount];
  };
  assert.deepEqual(await readStatus({ DB, ...withShipping, TALISMAN_COMMERCE_TAX: 'stripe-exclusive' }, 'taxed-status-browser'),
    [200, 990, 'exclusive', 1500, 14490]);
  // An order without tax says so.
  assert.deepEqual(await readStatus({ DB, ...withShipping }, 'untaxed-status-browser'), [200, 0, null, 1500, 13500]);
  sqlite.close();
});

// --- Order status ownership ----------------------------------------------------------------------

test('only the basket or signed-in account that placed an order can read or cancel it', async () => {
  const { sqlite, DB } = database();
  const { api, order } = await placeOrder(DB, 'owner-browser');
  // A second shopper with a basket of their own.
  const stranger = await api.carts.getOrCreate('stranger-browser');
  await api.carts.updateItems(stranger.id, [{ productId: 'other', variantId: 'other-amber', quantity: 1 }]);
  const env = { DB };
  const read = (cookies) => call(orderRoute, env, { method: 'GET', path: `/api/ecommerce/order?order=${order.id}`, cookies });

  for (const cookies of [{}, { [CART_SESSION_COOKIE]: 'stranger-browser' }, { [CART_SESSION_COOKIE]: 'owner-browser-guess' }]) {
    const denied = await read(cookies);
    assert.deepEqual([denied.status, denied.json], [404, { error: 'Order not found' }]);
  }
  const cancelled = await call(orderRoute, env, { path: '/api/ecommerce/order',
    cookies: { [CART_SESSION_COOKIE]: 'stranger-browser' }, body: { orderId: order.id } });
  assert.equal(cancelled.status, 404);
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_orders WHERE id = ?').get(order.id).status, 'pending');

  await api.orders.finalizePayment(order.id, { provider: 'stripe', providerId: order.checkoutSessionId,
    paymentStatus: 'success', amount: order.totalAmount, currency: 'usd', customerEmail: 'owner@example.test' });
  const owner = await read({ [CART_SESSION_COOKIE]: 'owner-browser' });
  assert.equal(owner.status, 200);
  assert.deepEqual([owner.json.orderId, owner.json.status, owner.json.totalAmount], [order.id, 'paid', 12000]);

  // The paid order now belongs to the account created for its email; only that shopper sees it.
  const accountId = sqlite.prepare('SELECT user_id FROM _ecommerce_orders WHERE id = ?').get(order.id).user_id;
  signInShopper(sqlite, accountId, 'owner-token');
  signInShopper(sqlite, 'someone-else', 'other-token');
  assert.equal((await read({ [CUSTOMER_SESSION_COOKIE]: 'owner-token' })).status, 200);
  assert.equal((await read({ [CUSTOMER_SESSION_COOKIE]: 'other-token' })).status, 404);
  assert.equal((await read({ [CUSTOMER_SESSION_COOKIE]: 'other-token', [CART_SESSION_COOKIE]: 'stranger-browser' })).status, 404);
  sqlite.close();
});

// --- Admin test checkout (opt-in) ----------------------------------------------------------------

test('the admin test route settles a simulated order for an admin; public routes never settle one', async (t) => {
  t.after(() => { delete globalThis.cmsUser; });
  const { sqlite, DB } = database();
  const api = bindCommerceApi({ env: { DB } });
  const cart = await api.carts.getOrCreate('admin-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'frame', variantId: 'frame-amber', quantity: 1 }]);
  const request = { path: '/admin/api/ecommerce/test-checkout', cookies: { [CART_SESSION_COOKIE]: 'admin-browser' },
    body: { customerEmail: 'admin@shop.test', shippingAddress } };

  globalThis.cmsUser = { id: 'editor-1', email: 'editor@shop.test', role: 'editor' };
  assert.equal((await call(adminTestCheckoutRoute, { DB }, request)).status, 403);
  delete globalThis.cmsUser;
  assert.equal((await call(adminTestCheckoutRoute, { DB }, request)).status, 401);
  assert.equal(count(sqlite, '_ecommerce_orders'), 0);

  // Checkout disabled and Stripe unconfigured: the admin route still registers its own simulated provider.
  globalThis.cmsUser = { id: 'admin-1', email: 'admin@shop.test', role: 'admin' };
  const placed = await call(adminTestCheckoutRoute, { DB }, request);
  assert.equal(placed.status, 200);
  assert.deepEqual([placed.json.status, placed.json.paymentProvider], ['paid', 'admin_test']);

  // A pending simulated order, as left by an interrupted admin request, stays pending on the public route.
  const pending = await placeOrder(DB, 'interrupted-browser', new AdminTestPaymentAdapter());
  const status = await call(orderRoute, { DB }, { method: 'GET', path: `/api/ecommerce/order?order=${pending.order.id}`,
    cookies: { [CART_SESSION_COOKIE]: 'interrupted-browser' } });
  assert.deepEqual([status.status, status.json.status, status.json.paymentProvider], [200, 'pending', 'admin_test']);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM _ecommerce_payments WHERE order_id = ?").get(pending.order.id).n, 0);
  sqlite.close();
});

test('the basket owner can cancel a pending simulated order, which unlocks the basket', async () => {
  const { sqlite, DB } = database();
  const { order } = await placeOrder(DB, 'interrupted-browser', new AdminTestPaymentAdapter());
  const cookies = { [CART_SESSION_COOKIE]: 'interrupted-browser' };
  const locked = await postCart(DB, { items: [{ productId: 'other', variantId: 'other-amber', quantity: 1 }] }, cookies);
  assert.deepEqual([locked.status, locked.json], [409, { error: 'Checkout already started for this cart' }]);

  // The public order route has no simulated provider, and needs none: there is no external session to expire.
  const cancelled = await call(orderRoute, { DB }, { path: '/api/ecommerce/order', cookies, body: { orderId: order.id } });
  assert.deepEqual([cancelled.status, cancelled.json], [200, { orderId: order.id, status: 'cancelled' }]);
  const edited = await postCart(DB, { items: [{ productId: 'other', variantId: 'other-amber', quantity: 1 }] }, cookies);
  assert.deepEqual([edited.status, edited.json.items], [200, [{ productId: 'other', variantId: 'other-amber', quantity: 1 }]]);
  sqlite.close();
});

test('reconciliation releases stale simulated orders and still reaches the real orders behind them', async () => {
  const { sqlite, DB } = database();
  const simulated = [];
  for (let index = 0; index < 10; index++) {
    simulated.push((await placeOrder(DB, `stuck-browser-${index}`, new AdminTestPaymentAdapter())).order);
  }
  const { order: missed } = await placeOrder(DB, 'missed-webhook-browser');
  const fresh = (await placeOrder(DB, 'fresh-browser', new AdminTestPaymentAdapter())).order;
  // All but the fresh one are past the 15 minute window, the simulated ones oldest.
  const now = Math.floor(Date.now() / 1000);
  const age = sqlite.prepare('UPDATE _ecommerce_orders SET created_at = ? WHERE id = ?');
  simulated.forEach((order, index) => age.run(now - 60 * 60 + index, order.id));
  age.run(now - 30 * 60, missed.id);

  // The scheduled Worker registers only the real provider. Stripe completed this session; its webhook never arrived.
  const stripe = { ...hostedCheckout, async getCheckoutSession() {
    return { status: 'complete', paymentStatus: 'paid', amountTotal: missed.totalAmount, currency: 'usd',
      paymentIntentId: `pi_${missed.id}`, url: null };
  } };
  const results = await reconcileCommerce({ env: { DB }, paymentAdapters: [stripe] });
  assert.deepEqual(results.find((result) => result.id === missed.id), { id: missed.id, status: 'paid' });
  assert.deepEqual(results.filter((result) => result.status === 'cancelled').map((result) => result.id).sort(),
    simulated.map((order) => order.id).sort());
  const status = (id) => sqlite.prepare('SELECT status FROM _ecommerce_orders WHERE id = ?').get(id).status;
  assert.equal(status(missed.id), 'paid');
  assert.equal(status(fresh.id), 'pending');
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM _ecommerce_carts
    WHERE checkout_session_id LIKE 'admin_test:%'`).get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM _ecommerce_payments WHERE provider = 'admin_test'").get().n, 0);
  sqlite.close();
});

// --- Cart limits ---------------------------------------------------------------------------------

test('the cart API refuses too many lines, out-of-range quantities and unknown catalog ids without writing', async () => {
  const { sqlite, DB } = database();
  const lines = Array.from({ length: CART_MAX_LINES + 1 }, (_, index) => ({ productId: `product-${index}`, quantity: 1 }));
  const cases = [
    [{ items: lines }, `Cart items must not exceed ${CART_MAX_LINES} lines`],
    [{ items: [{ productId: 'frame', quantity: CART_MAX_LINE_QUANTITY + 1 }] }, /quantity from 1 to 99/],
    [{ items: [{ productId: 'frame', quantity: 0 }] }, /quantity from 1 to 99/],
    [{ items: [{ productId: 'frame', quantity: 1.5 }] }, /quantity from 1 to 99/],
    [{ items: [{ productId: 'x'.repeat(129), quantity: 1 }] }, /quantity from 1 to 99/],
    [{ items: [{ productId: 'frame', quantity: 1 }, { productId: 'frame', quantity: 2 }] }, 'Duplicate cart items are not allowed'],
    [{ items: [{ productId: 'invented', quantity: 1 }] }, 'Cart items must be catalog products; invented is not available'],
    [{ items: [{ productId: 'retired', quantity: 1 }] }, 'Cart items must be catalog products; retired is not available'],
    [{ items: [{ productId: 'frame', variantId: 'invented', quantity: 1 }] }, /must use a variant of their product; invented/],
    [{ items: [{ productId: 'frame', variantId: 'other-amber', quantity: 1 }] }, /must use a variant of their product; other-amber/],
    // A product with variant groups is sold only as one of its variants.
    [{ items: [{ productId: 'frame', quantity: 1 }] }, 'Cart items must choose one of the variants of frame'],
    [{ items: [{ productId: 'case', quantity: 1 }, { productId: 'other', variantId: '', quantity: 1 }] },
      'Cart items must choose one of the variants of other'],
  ];
  for (const [body, error] of cases) {
    const response = await postCart(DB, body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    if (typeof error === 'string') assert.equal(response.json.error, error);
    else assert.match(response.json.error, error);
    assert.deepEqual(response.jar.writes, []);
  }
  assert.equal(count(sqlite, '_ecommerce_carts'), 0);
  sqlite.close();
});

test('the cart API stores catalog lines, including draft concepts, with only the known fields', async () => {
  const { sqlite, DB } = database();
  const created = await postCart(DB, { items: [
    { productId: 'frame', variantId: 'frame-amber', quantity: CART_MAX_LINE_QUANTITY, note: 'x'.repeat(4000) },
    { productId: 'concept', quantity: 1 },
  ] });
  assert.equal(created.status, 200);
  assert.deepEqual(created.json.items, [
    { productId: 'frame', variantId: 'frame-amber', quantity: CART_MAX_LINE_QUANTITY },
    { productId: 'concept', quantity: 1 },
  ]);
  assert.doesNotMatch(sqlite.prepare('SELECT items FROM _ecommerce_carts').get().items, /note/);
  const token = created.jar.writes.find(([kind, name]) => kind === 'set' && name === CART_SESSION_COOKIE)[2];

  // A line already in the basket stays editable after its product is archived; adding it anew is refused.
  sqlite.prepare("UPDATE _ecommerce_products SET status = 'archived' WHERE id = 'concept'").run();
  const edited = await postCart(DB, { items: [{ productId: 'concept', quantity: 2 }] }, { [CART_SESSION_COOKIE]: token });
  assert.deepEqual([edited.status, edited.json.items], [200, [{ productId: 'concept', quantity: 2 }]]);
  const readded = await postCart(DB, { items: [{ productId: 'case', quantity: 1 }, { productId: 'concept', quantity: 2 }] },
    { [CART_SESSION_COOKIE]: token });
  assert.equal(readded.status, 200);
  const emptied = await postCart(DB, { items: [] }, { [CART_SESSION_COOKIE]: token });
  assert.equal(emptied.status, 200);
  const refused = await postCart(DB, { items: [{ productId: 'concept', quantity: 1 }] }, { [CART_SESSION_COOKIE]: token });
  assert.equal(refused.status, 400);

  // The line limit is inclusive.
  const insert = sqlite.prepare(`INSERT INTO _ecommerce_products (id, name, slug, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', 0, 0)`);
  for (let index = 0; index < CART_MAX_LINES; index++) insert.run(`bulk-${index}`, `Bulk ${index}`, `bulk-${index}`);
  const full = await postCart(DB, { items: Array.from({ length: CART_MAX_LINES }, (_, index) => ({ productId: `bulk-${index}`, quantity: 1 })) },
    { [CART_SESSION_COOKIE]: token });
  assert.equal(full.status, 200);
  assert.equal(full.json.items.length, CART_MAX_LINES);
  assert.equal(count(sqlite, '_ecommerce_carts'), 1);
  sqlite.close();
});

test('the cart actions refuse unknown products before creating a basket and never create one to read', async () => {
  const { sqlite, DB } = database();
  globalThis.workerEnv = { DB };
  const context = (cookies = cookieJar()) => ({ cookies, url: new URL(`${ORIGIN}/_actions/cart`) });

  const reading = context();
  assert.deepEqual(await ecommerceActions.getCart.handler(undefined, reading), { success: true, cart: null });
  assert.deepEqual(await ecommerceActions.clearCart.handler(undefined, reading), { success: true, cart: null });
  assert.deepEqual(reading.cookies.writes, []);

  const unknown = context();
  await assert.rejects(ecommerceActions.addToCart.handler({ productId: 'invented', quantity: 1 }, unknown),
    { code: 'BAD_REQUEST', message: 'Cart items must be catalog products; invented is not available' });
  assert.deepEqual(unknown.cookies.writes, []);
  assert.equal(count(sqlite, '_ecommerce_carts'), 0);

  const adding = context();
  const added = await ecommerceActions.addToCart.handler({ productId: 'frame', variantId: 'frame-amber', quantity: 2 }, adding);
  assert.deepEqual(added.cart.items, [{ productId: 'frame', variantId: 'frame-amber', quantity: 2 }]);
  const again = context(cookieJar(Object.fromEntries(adding.cookies.values)));
  await assert.rejects(ecommerceActions.addToCart.handler({ productId: 'frame', variantId: 'frame-amber', quantity: 98 }, again),
    { code: 'BAD_REQUEST', message: /quantity from 1 to 99/ });
  assert.equal((await ecommerceActions.getCart.handler(undefined, again)).cart.items[0].quantity, 2);
  assert.equal(count(sqlite, '_ecommerce_carts'), 1);
  sqlite.close();
});

test('checkout refuses a stored line without a variant for a product sold in variants', async () => {
  const { sqlite, DB } = database();
  // Stock on the product itself, which checkout used to sell at the base price instead of a variant.
  sqlite.exec(`UPDATE _ecommerce_products SET inventory_quantity = 5 WHERE id = 'frame'`);
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_carts (id, session_token, items, created_at, updated_at)
    VALUES ('legacy', 'legacy-browser', '[{"productId":"frame","quantity":1}]', ?, ?)`).run(now, now);
  const response = await call(checkoutRoute, { ...stripeEnv(DB), TALISMAN_COMMERCE_CHECKOUT_ENABLED: 'true' }, {
    path: '/api/ecommerce/checkout', cookies: { [CART_SESSION_COOKIE]: 'legacy-browser' },
    body: { customerEmail: 'owner@example.test', shippingAddress } });
  assert.deepEqual([response.status, response.json], [409, { error: 'Select an option for Frame' }]);
  assert.equal(count(sqlite, '_ecommerce_orders'), 0);
  assert.equal(sqlite.prepare("SELECT inventory_quantity FROM _ecommerce_products WHERE id = 'frame'").get().inventory_quantity, 5);
  assert.equal(sqlite.prepare("SELECT checkout_session_id FROM _ecommerce_carts WHERE id = 'legacy'").get().checkout_session_id, null);

  globalThis.workerEnv = { DB };
  const cookies = cookieJar();
  await assert.rejects(ecommerceActions.addToCart.handler({ productId: 'frame', quantity: 1 },
    { cookies, url: new URL(`${ORIGIN}/_actions/cart`) }),
    { code: 'BAD_REQUEST', message: 'Cart items must choose one of the variants of frame' });
  assert.deepEqual(cookies.writes, []);
  sqlite.close();
});
