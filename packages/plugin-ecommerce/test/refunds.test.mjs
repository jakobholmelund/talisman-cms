import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import Stripe from 'stripe';

// The routes read their bindings from cloudflare:workers and the admin route asks the CMS auth
// guard. This test serves both.
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
const { bindCommerceApi } = await import('../dist/api.js');
const { AdminTestPaymentAdapter } = await import('../dist/adapters/admin-test.js');
const { getOrderAdjustmentsAdmin, restockOrder } = await import('../dist/order-adjustments.js');
const webhookRoute = (await import('../dist/routes/ecommerce-webhook.js')).POST;
const adminOrdersRoute = (await import('../dist/routes/ecommerce-admin-orders.js')).ALL;

const ORIGIN = 'https://shop.test';
const WEBHOOK_SECRET = 'whsec_refund_tests';
const migrationFiles = ['0004_ecommerce_plugin.sql', '0005_variant_value_images.sql', '0007_local_auth.sql',
  '0008_shared_components.sql', '0010_checkout_inventory.sql', '0011_order_payment_provider.sql',
  '0012_customer_accounts.sql', '0013_referrals_and_credit.sql', '0014_promotions.sql',
  '0015_gift_cards.sql', '0016_verified_customer_sessions.sql', '0017_commerce_fulfillment.sql',
  '0019_shared_customer_identity.sql', '0024_shopper_sign_in_tokens.sql', '0025_order_shipping_and_tax.sql',
  '0026_order_fulfillment_status.sql', '0027_gift_card_review.sql', '0028_provider_refunds_and_disputes.sql',
  '0029_commerce_reconcile_backoff.sql'];

/** An in-memory D1 stand-in. Like D1, it runs one batch at a time, each in a transaction. */
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of migrationFiles) {
    const sql = readFileSync(new URL(`../../talisman-cms/drizzle/${migration}`, import.meta.url), 'utf8');
    sqlite.exec(sql.replaceAll('--> statement-breakpoint', ''));
  }
  let queue = Promise.resolve();
  async function runBatch(statements) {
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
    batch(statements) {
      const run = queue.then(() => runBatch(statements));
      queue = run.catch(() => undefined);
      return run;
    }
  };
  seedCatalog(sqlite);
  return { sqlite, DB };
}

const NOW = Math.floor(Date.now() / 1000);
const STOCK_UPDATED = NOW - 3600;

/**
 * A frame sold as lens values: Amber is built from two shared components, Smoke has its own stock row.
 * A case sells from product stock and a scarf from a legacy variant group. Every stock row holds 5.
 */
function seedCatalog(sqlite) {
  const product = sqlite.prepare(`INSERT INTO _ecommerce_products
    (id, name, slug, sku, base_price, inventory_quantity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 5, 'active', ?, ?)`);
  product.run('frame', 'Mycelium frame', 'frame', 'TAL-FRAME', 12000, NOW, STOCK_UPDATED);
  product.run('case', 'Travel case', 'case', 'TAL-CASE', 2000, NOW, STOCK_UPDATED);
  product.run('scarf', 'Scarf', 'scarf', null, 3000, NOW, STOCK_UPDATED);
  sqlite.prepare(`INSERT INTO _ecommerce_variants (id, name, created_at, updated_at) VALUES ('def-lens', 'Lens', ?, ?)`).run(NOW, NOW);
  const group = sqlite.prepare(`INSERT INTO _ecommerce_product_variants
    (id, product_id, variant_id, name, sku, inventory_quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 5, ?, ?)`);
  group.run('frame-lens', 'frame', 'def-lens', 'Lens choice', null, NOW, STOCK_UPDATED);
  group.run('scarf-large', 'scarf', null, 'Large', 'SCARF-L', NOW, STOCK_UPDATED);
  const value = sqlite.prepare(`INSERT INTO _ecommerce_product_variant_values
    (id, product_variant_id, value, sku, created_at, updated_at) VALUES (?, 'frame-lens', ?, ?, ?, ?)`);
  value.run('frame-amber', 'Amber', 'TAL-FRAME-AMB', NOW, NOW);
  value.run('frame-smoke', 'Smoke', null, NOW, NOW);
  sqlite.prepare(`INSERT INTO _ecommerce_stocks (id, product_variant_value_id, quantity, created_at, updated_at)
    VALUES ('smoke-stock', 'frame-smoke', 5, ?, ?)`).run(NOW, STOCK_UPDATED);
  for (const [id, sku, name] of [['frame-body', 'BODY-MYC', 'Mycelium body'], ['amber-lens', 'LENS-AMB', 'Amber lens pair']]) {
    sqlite.prepare(`INSERT INTO _ecommerce_components (id, sku, name, quantity, created_at, updated_at)
      VALUES (?, ?, ?, 5, ?, ?)`).run(id, sku, name, NOW, STOCK_UPDATED);
    sqlite.prepare(`INSERT INTO _ecommerce_variant_components
      (id, product_variant_value_id, component_id, quantity, created_at, updated_at) VALUES (?, 'frame-amber', ?, 1, ?, ?)`)
      .run(`bom-${id}`, id, NOW, NOW);
  }
}

function cookieJar() {
  return { get() { return undefined; }, set() {}, delete() {} };
}

async function call(route, env, { method = 'POST', path = '/api/ecommerce/test', body, raw, headers = {}, origin = ORIGIN } = {}) {
  globalThis.workerEnv = env;
  const request = new Request(`${ORIGIN}${path}`, {
    method, headers: { ...(origin ? { origin } : {}), 'Content-Type': 'application/json', ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const response = await route({ request, cookies: cookieJar() });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const shippingAddress = { name: 'Test Shopper', line1: '1 Main St', city: 'Austin', postalCode: '78701', country: 'US' };
const checkoutDetails = { customerEmail: 'shopper@example.test', shippingAddress,
  successUrl: `${ORIGIN}/checkout/success?order={ORDER_ID}`, cancelUrl: `${ORIGIN}/checkout/cancel?order={ORDER_ID}` };
const EVERY_KIND = [{ productId: 'frame', variantId: 'frame-amber', quantity: 1 }, { productId: 'frame', variantId: 'frame-smoke', quantity: 1 },
  { productId: 'case', quantity: 2 }, { productId: 'scarf', variantId: 'scarf-large', quantity: 1 }];

/** Stands in for Stripe when an order is placed through the API; webhook events arrive already verified. */
const hostedCheckout = {
  providerId: 'stripe',
  async createCheckoutSession({ orderId }) {
    return { providerSessionId: `cs_test_${orderId}`, url: `https://checkout.stripe.test/${orderId}` };
  },
  async expireCheckoutSession() {},
  async getCheckoutSession() { return { status: 'open', url: 'https://checkout.stripe.test/open' }; },
  async validateWebhook(payload) { return JSON.parse(payload); },
};

let browsers = 0;
async function placeOrder(DB, items = [{ productId: 'frame', variantId: 'frame-amber', quantity: 1 }], adapter = hostedCheckout) {
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [adapter] });
  const cart = await api.carts.getOrCreate(`browser-${++browsers}`);
  await api.carts.updateItems(cart.id, items);
  const { order } = await api.orders.createFromCart(cart.id, { ...checkoutDetails, providerId: adapter.providerId });
  return { api, order };
}

async function paidOrder(DB, items) {
  const { api, order } = await placeOrder(DB, items);
  await api.orders.finalizePayment(order.id, { provider: 'stripe', providerId: order.checkoutSessionId,
    paymentStatus: 'success', amount: order.totalAmount, currency: 'usd', paymentIntentId: `pi_${order.id}` });
  return { api, order: await api.orders.find(order.id) };
}

/** A charge.refunded event as the API receives it once verified, with Stripe's `created` time. */
const refundEvent = (api, order, amountRefunded, created) => api.webhooks.handleStripe(JSON.stringify({
  id: `evt_refund_${amountRefunded}`, type: 'charge.refunded', created,
  data: { id: `ch_${order.id}`, payment_intent: order.paymentIntentId, amount: order.totalAmount,
    amount_refunded: amountRefunded, currency: 'usd', metadata: { orderId: order.id } },
}), 'signature', 'secret');

const rows = (sqlite, sql, ...params) => sqlite.prepare(sql).all(...params).map((row) => ({ ...row }));
const row = (sqlite, sql, ...params) => rows(sqlite, sql, ...params)[0];
const refundRows = (sqlite, orderId) => rows(sqlite, `SELECT id, provider, provider_refund_id, amount_cents, created_at
  FROM _ecommerce_provider_refunds WHERE order_id = ? ORDER BY rowid`, orderId);
const orderState = (sqlite, orderId) => row(sqlite, `SELECT status, provider_refunded_cents FROM _ecommerce_orders WHERE id = ?`, orderId);

/** Every row a webhook could change. */
function snapshot(sqlite) {
  return Object.fromEntries(['_ecommerce_orders', '_ecommerce_payments', '_ecommerce_provider_refunds', '_ecommerce_disputes',
    '_ecommerce_carts', '_ecommerce_gift_card_purchases', '_ecommerce_components', '_ecommerce_credit_ledger']
    .map((table) => [table, rows(sqlite, `SELECT * FROM ${table} ORDER BY rowid`)]));
}

/** Collects console output of one kind while `task` runs. */
async function captured(kind, task) {
  const original = console[kind];
  const lines = [];
  console[kind] = (...args) => { lines.push(args); };
  try {
    return { result: await task(), lines };
  } finally {
    console[kind] = original;
  }
}

// --- Webhook answers -----------------------------------------------------------------------------

const stripeEnv = (DB) => ({ DB, TALISMAN_COMMERCE_STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: 'sk_test_refund_tests', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
const stripeEvent = (type, object, id = `evt_${type.replaceAll('.', '_')}`) =>
  JSON.stringify({ id, object: 'event', type, created: NOW, data: { object } });
const signed = (payload) => Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET, timestamp: Math.floor(Date.now() / 1000) });
const postWebhook = (env, payload) => call(webhookRoute, env, {
  path: '/api/ecommerce/webhooks/stripe', raw: payload, origin: null, headers: { 'stripe-signature': signed(payload) },
});
const completed = (order, extra = {}) => stripeEvent('checkout.session.completed', { id: order.checkoutSessionId,
  object: 'checkout.session', client_reference_id: order.id, metadata: { orderId: order.id }, payment_status: 'paid',
  amount_total: order.totalAmount, currency: 'usd', payment_intent: `pi_${order.id}`,
  customer_details: { email: 'shopper@example.test' }, ...extra }, `evt_paid_${order.id}`);
const refunded = (order, amountRefunded, extra = {}) => stripeEvent('charge.refunded', { id: `ch_${order.id}`, object: 'charge',
  payment_intent: `pi_${order.id}`, amount: order.totalAmount, amount_refunded: amountRefunded, currency: 'usd',
  metadata: { orderId: order.id }, ...extra }, `evt_refund_${order.id}_${amountRefunded}`);

test('refunds and sessions of another integration are answered 200, logged by type and id, and change nothing', async () => {
  const { sqlite, DB } = database();
  await paidOrder(DB);
  await placeOrder(DB);
  const env = stripeEnv(DB);
  const before = snapshot(sqlite);
  const foreign = [
    stripeEvent('charge.refunded', { id: 'ch_elsewhere', object: 'charge', payment_intent: 'pi_elsewhere', amount: 5000,
      amount_refunded: 5000, currency: 'usd', metadata: { invoice: 'INV-7' } }, 'evt_foreign_refund'),
    // Another integration's reference in the metadata key this store uses matches no order either.
    stripeEvent('charge.refunded', { id: 'ch_other', object: 'charge', payment_intent: 'pi_other', amount: 5000,
      amount_refunded: 1000, currency: 'usd', metadata: { orderId: 'order-1042' } }, 'evt_foreign_order_refund'),
    stripeEvent('checkout.session.completed', { id: 'cs_test_elsewhere', object: 'checkout.session',
      client_reference_id: 'cart-42', metadata: {}, payment_status: 'paid', amount_total: 5000, currency: 'usd',
      payment_intent: 'pi_elsewhere', customer_details: { email: 'someone@example.test' } }, 'evt_foreign_session'),
    stripeEvent('checkout.session.completed', { id: 'cs_test_elsewhere_2', object: 'checkout.session',
      client_reference_id: null, metadata: { orderId: 'order-1042' }, payment_status: 'paid', amount_total: 5000,
      currency: 'usd', payment_intent: 'pi_other' }, 'evt_foreign_order_session'),
    stripeEvent('checkout.session.expired', { id: 'cs_test_elsewhere_3', object: 'checkout.session',
      client_reference_id: 'cart-43', metadata: {} }, 'evt_foreign_expired'),
    stripeEvent('customer.created', { id: 'cus_1', object: 'customer', email: 'someone@example.test' }, 'evt_customer'),
  ];
  const { lines } = await captured('info', async () => {
    for (const payload of foreign) {
      const response = await postWebhook(env, payload);
      assert.deepEqual([response.status, response.json], [200, { success: true, event: JSON.parse(payload).type, ignored: true }]);
    }
  });
  assert.deepEqual(snapshot(sqlite), before);
  // Info level, with the event type and id and nothing from the payload.
  assert.deepEqual(lines, foreign.map((payload) => ['[commerce] Stripe event ignored',
    { type: JSON.parse(payload).type, id: JSON.parse(payload).id }]));
  sqlite.close();
});

test('a refund that arrives before its order is paid is answered 409 and applied once the payment is recorded', async () => {
  const { sqlite, DB } = database();
  const { order } = await placeOrder(DB);
  const env = stripeEnv(DB);
  const early = await postWebhook(env, refunded(order, 2000));
  assert.equal(early.status, 409);
  assert.equal(early.json.retry, true);
  assert.match(early.json.error, /no recorded payment yet/);
  assert.deepEqual(orderState(sqlite, order.id), { status: 'pending', provider_refunded_cents: 0 });
  assert.deepEqual(refundRows(sqlite, order.id), []);

  const paid = await postWebhook(env, completed(order));
  assert.deepEqual([paid.status, paid.json.status], [200, 'paid']);
  // Stripe delivers the refund again.
  const retried = await postWebhook(env, refunded(order, 2000));
  assert.deepEqual([retried.status, retried.json], [200, { success: true, orderId: order.id, status: 'partially_refunded' }]);
  assert.deepEqual(orderState(sqlite, order.id), { status: 'partially_refunded', provider_refunded_cents: 2000 });
  assert.deepEqual(refundRows(sqlite, order.id).map((item) => [item.amount_cents, item.created_at]), [[2000, NOW]]);
  sqlite.close();
});

test('an event the store cannot apply is logged without personal data and answered 200 with its reason', async () => {
  const { sqlite, DB } = database();
  const env = stripeEnv(DB);
  const { order: paid } = await paidOrder(DB);
  const { api, order: pending } = await placeOrder(DB);
  const { order: released } = await placeOrder(DB);
  await api.orders.cancel(released.id);
  const before = snapshot(sqlite);

  const { lines } = await captured('error', async () => {
    const cases = [
      [refunded(paid, 500, { amount: paid.totalAmount + 100 }), 'refund_mismatch'],
      [completed(pending, { amount_total: pending.totalAmount - 1 }), 'amount_mismatch'],
      [completed(pending, { currency: 'eur' }), 'currency_mismatch'],
      // Paid after its checkout was released: an administrator refunds it in Stripe.
      [completed({ ...released, checkoutSessionId: released.checkoutSessionId }), 'order_cancelled'],
    ];
    for (const [payload, reason] of cases) {
      const response = await postWebhook(env, payload);
      assert.deepEqual([response.status, response.json],
        [200, { success: true, event: JSON.parse(payload).type, ignored: true, reason }], reason);
    }
  });
  assert.deepEqual(snapshot(sqlite), before);
  assert.deepEqual(lines.map(([message, details]) => [message, Object.keys(details)]),
    Array(4).fill(['[commerce] Stripe event does not match the store records', ['type', 'id', 'reason']]));
  assert.ok(!JSON.stringify(lines).includes('@'));
  sqlite.close();
});

test('an event that fails unexpectedly is answered 500 and changes nothing, so Stripe delivers it again', async () => {
  const { sqlite, DB } = database();
  const env = stripeEnv(DB);
  const { order } = await paidOrder(DB);
  // A Worker deployed before its migration: the refund cannot be dated, so none of it is recorded.
  sqlite.exec('DROP TABLE _ecommerce_provider_refunds');
  const { lines } = await captured('error', () => postWebhook(env, refunded(order, 2000)).then((response) => {
    assert.deepEqual([response.status, response.json], [500, { error: 'The event could not be processed; Stripe will retry it' }]);
  }));
  assert.equal(lines[0][0], '[commerce] Stripe webhook failed');
  assert.deepEqual(orderState(sqlite, order.id), { status: 'paid', provider_refunded_cents: 0 });
  sqlite.close();
});

// --- Refund dates --------------------------------------------------------------------------------

test('each rise in the refund total is dated when Stripe issued it, and a retried or stale event adds no row', async () => {
  const { sqlite, DB } = database();
  const { api, order } = await paidOrder(DB);
  assert.equal(order.totalAmount, 12000);
  const day = 24 * 60 * 60;
  assert.deepEqual(await refundEvent(api, order, 3000, NOW - 2 * day), { success: true, orderId: order.id, status: 'partially_refunded' });
  assert.deepEqual(await refundEvent(api, order, 3000, NOW - 2 * day), { success: true, orderId: order.id, duplicate: true });
  await refundEvent(api, order, 5000, NOW - day);
  // An older event delivered late.
  assert.deepEqual(await refundEvent(api, order, 3000, NOW - 2 * day), { success: true, orderId: order.id, duplicate: true });
  assert.deepEqual(await refundEvent(api, order, 12000, NOW), { success: true, orderId: order.id, status: 'refunded' });
  assert.deepEqual(refundRows(sqlite, order.id), [
    { id: `prf_${order.id}_3000`, provider: 'stripe', provider_refund_id: null, amount_cents: 3000, created_at: NOW - 2 * day },
    { id: `prf_${order.id}_5000`, provider: 'stripe', provider_refund_id: null, amount_cents: 2000, created_at: NOW - day },
    { id: `prf_${order.id}_12000`, provider: 'stripe', provider_refund_id: null, amount_cents: 7000, created_at: NOW },
  ]);
  assert.deepEqual(orderState(sqlite, order.id), { status: 'refunded', provider_refunded_cents: 12000 });
  assert.equal(row(sqlite, `SELECT status FROM _ecommerce_payments WHERE order_id = ?`, order.id).status, 'refunded');
  sqlite.close();
});

test('a refund event that lists its refunds records the newest one, and one without a time is dated when recorded', async () => {
  const { sqlite, DB } = database();
  const { api, order } = await paidOrder(DB);
  const before = Math.floor(Date.now() / 1000);
  await api.webhooks.handleStripe(JSON.stringify({ type: 'charge.refunded', data: { payment_intent: order.paymentIntentId,
    amount: order.totalAmount, amount_refunded: 4000, currency: 'usd',
    refunds: { data: [{ id: 're_second', created: NOW - 10 }, { id: 're_first', created: NOW - 100 }] } } }), 'signature', 'secret');
  const [recorded] = refundRows(sqlite, order.id);
  assert.equal(recorded.provider_refund_id, 're_second');
  assert.equal(recorded.amount_cents, 4000);
  assert.ok(recorded.created_at >= before && recorded.created_at <= Math.floor(Date.now() / 1000));
  sqlite.close();
});

/**
 * Holds every batch until `count` batches are waiting, then runs them one by one in arrival order, so
 * each handler has read the order before any of them writes.
 */
function staleReads(DB, count = 2) {
  const waiting = [];
  let queue = Promise.resolve();
  return {
    prepare: (sql) => DB.prepare(sql),
    batch(statements) {
      let release;
      const arrived = new Promise((resolve) => { release = resolve; });
      waiting.push(release);
      if (waiting.length === count) waiting.forEach((resolve) => resolve());
      const run = queue.then(() => arrived).then(() => DB.batch(statements));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

test('two refund events that both read a stale order add rows that sum to the refund total', async () => {
  for (const [first, second, expected] of [[3000, 5000, [3000, 2000]], [5000, 3000, [5000]]]) {
    const { sqlite, DB } = database();
    const { order } = await paidOrder(DB);
    const stale = bindCommerceApi({ env: { DB: staleReads(DB) }, paymentAdapters: [hostedCheckout] });
    const results = await Promise.all([refundEvent(stale, order, first, NOW - 60), refundEvent(stale, order, second, NOW)]);
    // Both saw nothing refunded, so each tried to record its total; the stored total decides what each adds.
    assert.deepEqual(results.map((result) => result.status), ['partially_refunded', 'partially_refunded']);
    assert.deepEqual(refundRows(sqlite, order.id).map((item) => item.amount_cents), expected);
    const { total } = row(sqlite, 'SELECT SUM(amount_cents) AS total FROM _ecommerce_provider_refunds WHERE order_id = ?', order.id);
    assert.equal(total, 5000);
    assert.deepEqual(orderState(sqlite, order.id), { status: 'partially_refunded', provider_refunded_cents: 5000 });
    sqlite.close();
  }
});

// --- Restock -------------------------------------------------------------------------------------

const stockLevels = (sqlite) => ({
  frameBody: row(sqlite, `SELECT quantity FROM _ecommerce_components WHERE id = 'frame-body'`).quantity,
  amberLens: row(sqlite, `SELECT quantity FROM _ecommerce_components WHERE id = 'amber-lens'`).quantity,
  smoke: row(sqlite, `SELECT quantity FROM _ecommerce_stocks WHERE id = 'smoke-stock'`).quantity,
  case: row(sqlite, `SELECT inventory_quantity AS quantity FROM _ecommerce_products WHERE id = 'case'`).quantity,
  scarf: row(sqlite, `SELECT inventory_quantity AS quantity FROM _ecommerce_product_variants WHERE id = 'scarf-large'`).quantity,
});
const FULL = { frameBody: 5, amberLens: 5, smoke: 5, case: 5, scarf: 5 };
const SOLD = { frameBody: 4, amberLens: 4, smoke: 4, case: 3, scarf: 4 };
const stockTokens = (sqlite) => rows(sqlite, `SELECT 'component:' || id AS id, updated_at FROM _ecommerce_components
  UNION ALL SELECT 'stock:' || id, updated_at FROM _ecommerce_stocks
  UNION ALL SELECT 'product:' || id, updated_at FROM _ecommerce_products WHERE id = 'case'
  UNION ALL SELECT 'variant:' || id, updated_at FROM _ecommerce_product_variants WHERE id = 'scarf-large' ORDER BY 1`);
const reason = 'Parcel came back unopened';

test('restocking a refunded order returns every kind of stock once, and cannot be repeated', async () => {
  const { sqlite, DB } = database();
  const { api, order } = await paidOrder(DB, EVERY_KIND);
  assert.deepEqual(stockLevels(sqlite), SOLD);
  await refundEvent(api, order, order.totalAmount, NOW);
  // A refund alone leaves the stock where it is.
  assert.deepEqual(stockLevels(sqlite), SOLD);
  const tokensBefore = stockTokens(sqlite);

  const result = await restockOrder({ DB }, 'admin-1', { orderId: order.id, reason });
  assert.deepEqual(result.restocked.map((item) => `${item.targetType}:${item.targetId}:${item.quantity}`).sort(),
    ['component:amber-lens:1', 'component:frame-body:1', 'product:case:2', 'stock:smoke-stock:1', 'variant:scarf-large:1']);
  assert.deepEqual(stockLevels(sqlite), FULL);
  // Every stock write moves updated_at, so an admin save of stock loaded before the restock is refused.
  for (const [index, token] of stockTokens(sqlite).entries()) {
    assert.ok(token.updated_at >= tokensBefore[index].updated_at + 1, token.id);
  }
  assert.deepEqual(rows(sqlite, `SELECT released_at IS NOT NULL AS returned FROM _ecommerce_inventory_reservations WHERE order_id = ?
    UNION ALL SELECT released_at IS NOT NULL FROM _ecommerce_component_reservations WHERE order_id = ?`, order.id, order.id)
    .map((item) => item.returned), [1, 1, 1, 1, 1]);
  assert.deepEqual(rows(sqlite, `SELECT DISTINCT admin_actor, reason FROM _ecommerce_restocks WHERE order_id = ?`, order.id),
    [{ admin_actor: 'admin-1', reason }]);

  await assert.rejects(restockOrder({ DB }, 'admin-1', { orderId: order.id, reason }), /Nothing of this order is left to return to stock/);
  const [returned] = (await getOrderAdjustmentsAdmin({ DB }, { orderIds: [order.id] })).orders[order.id].reservations;
  await assert.rejects(restockOrder({ DB }, 'admin-1', { orderId: order.id, reason,
    reservations: [{ type: returned.type, id: returned.id }] }), /is already back in stock/);
  // A reservation row takes one restock, whatever path writes it.
  assert.throws(() => sqlite.prepare(`INSERT INTO _ecommerce_restocks (id, order_id, reservation_type, reservation_id,
    target_type, target_id, quantity, admin_actor, reason, created_at) VALUES ('again', ?, ?, ?, 'component', 'amber-lens', 1, 'admin-1', ?, ?)`)
    .run(order.id, returned.type, returned.id, reason, NOW), /UNIQUE constraint failed/);
  assert.deepEqual(stockLevels(sqlite), FULL);
  sqlite.close();
});

test('two restocks of the same order at once raise the stock once', async () => {
  const { sqlite, DB } = database();
  const { api, order } = await paidOrder(DB, EVERY_KIND);
  await refundEvent(api, order, order.totalAmount, NOW);
  const results = await Promise.allSettled([restockOrder({ DB }, 'admin-1', { orderId: order.id, reason }),
    restockOrder({ DB }, 'admin-2', { orderId: order.id, reason })]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected']);
  assert.match(results[1].reason.message, /changed while they were being restocked/);
  assert.deepEqual(stockLevels(sqlite), FULL);
  assert.equal(row(sqlite, 'SELECT COUNT(*) AS n FROM _ecommerce_restocks').n, 5);
  sqlite.close();
});

test('a partially refunded order restocks only the items chosen', async () => {
  const { sqlite, DB } = database();
  const { api, order } = await paidOrder(DB, EVERY_KIND);
  await refundEvent(api, order, 2000, NOW);
  assert.equal(orderState(sqlite, order.id).status, 'partially_refunded');
  await assert.rejects(restockOrder({ DB }, 'admin-1', { orderId: order.id, reason }),
    { name: 'OrderAdjustmentInputError', message: /Choose the items/ });
  const { reservations, restock } = (await getOrderAdjustmentsAdmin({ DB }, { orderIds: [order.id] })).orders[order.id];
  assert.equal(restock, 'choose');
  const cases = reservations.find((item) => item.targetId === 'case');
  assert.deepEqual([cases.label, cases.sku, cases.quantity, cases.returnedAt, cases.available], ['Travel case', 'TAL-CASE', 2, null, true]);
  assert.deepEqual(reservations.map((item) => item.label).sort(), ['Amber lens pair', 'Mycelium body',
    'Mycelium frame - Lens: Smoke', 'Scarf - Large', 'Travel case']);
  await restockOrder({ DB }, 'admin-1', { orderId: order.id, reason: 'Returned the travel case',
    reservations: [{ type: cases.type, id: cases.id }] });
  assert.deepEqual(stockLevels(sqlite), { ...SOLD, case: 5 });
  await assert.rejects(restockOrder({ DB }, 'admin-1', { orderId: order.id, reason,
    reservations: [{ type: 'inventory', id: 'not-this-order' }] }), /No inventory reservation not-this-order belongs to this order/);
  const after = (await getOrderAdjustmentsAdmin({ DB }, { orderIds: [order.id] })).orders[order.id].reservations
    .find((item) => item.targetId === 'case');
  assert.equal(after.restock.adminActor, 'admin-1');
  assert.equal(after.restock.reason, 'Returned the travel case');
  assert.ok(after.returnedAt);
  sqlite.close();
});

test('restock is refused for pending, cancelled, paid, disputed and admin test orders', async () => {
  const { sqlite, DB } = database();
  const refused = (message) => ({ name: 'OrderAdjustmentRefusedError', message });
  const { api, order: pending } = await placeOrder(DB, EVERY_KIND);
  await assert.rejects(restockOrder({ DB }, 'admin-1', { orderId: pending.id, reason }), refused(/A pending order still holds its stock/));
  await api.orders.cancel(pending.id);
  // Cancelling released the stock; a restock would count it twice.
  assert.deepEqual(stockLevels(sqlite), FULL);
  await assert.rejects(restockOrder({ DB }, 'admin-1', { orderId: pending.id, reason }), refused(/returned its stock when it was cancelled/));

  const { order: paid } = await paidOrder(DB, EVERY_KIND);
  await assert.rejects(restockOrder({ DB }, 'admin-1', { orderId: paid.id, reason }), refused(/Only a refunded or partially refunded order/));
  sqlite.prepare(`UPDATE _ecommerce_orders SET status = 'disputed' WHERE id = ?`).run(paid.id);
  await assert.rejects(restockOrder({ DB }, 'admin-1', { orderId: paid.id, reason }), refused(/once the dispute is lost or the order is refunded/));

  const testAdapter = new AdminTestPaymentAdapter();
  const { api: testApi, order: testOrder } = await placeOrder(DB, [{ productId: 'case', quantity: 1 }], testAdapter);
  await testApi.orders.finalizePayment(testOrder.id, { provider: 'admin_test', providerId: testOrder.checkoutSessionId,
    paymentStatus: 'success', amount: testOrder.totalAmount, currency: 'usd' });
  sqlite.prepare(`UPDATE _ecommerce_orders SET status = 'refunded' WHERE id = ?`).run(testOrder.id);
  await assert.rejects(restockOrder({ DB }, 'admin-1', { orderId: testOrder.id, reason }), refused(/Admin test orders take no stock to return/));

  await assert.rejects(restockOrder({ DB }, 'admin-1', { orderId: 'ord_00000000-0000-0000-0000-000000000000', reason }), refused(/Order not found/));
  await assert.rejects(restockOrder({ DB }, ' ', { orderId: paid.id, reason }), /Administrator identity is required/);
  await assert.rejects(restockOrder({ DB }, 'admin-1', { orderId: paid.id, reason: 'short' }), { name: 'OrderAdjustmentInputError' });
  // The simulated provider reserves no stock.
  assert.deepEqual(stockLevels(sqlite), SOLD);
  assert.equal(row(sqlite, 'SELECT COUNT(*) AS n FROM _ecommerce_restocks').n, 0);
  sqlite.close();
});

test('the orders admin route is admin-only and same-origin, lists disputes and stock, and restocks', async () => {
  const { sqlite, DB } = database();
  const { api, order } = await paidOrder(DB, EVERY_KIND);
  await refundEvent(api, order, order.totalAmount, NOW);
  const post = (body, options = {}) => call(adminOrdersRoute, { DB }, { path: '/admin/api/ecommerce/orders-admin', body, ...options });

  globalThis.cmsUser = undefined;
  assert.equal((await post({ action: 'list', orderIds: [order.id] })).status, 401);
  globalThis.cmsUser = { id: 'editor-1', role: 'editor' };
  assert.equal((await post({ action: 'list', orderIds: [order.id] })).status, 403);
  globalThis.cmsUser = { id: 'admin-1', role: 'admin' };
  assert.equal((await post(undefined, { method: 'GET' })).status, 405);
  assert.deepEqual(await post({ action: 'restock', orderId: order.id, reason }, { origin: 'https://evil.test' }),
    { status: 403, json: { error: 'Same-origin request required' } });
  assert.deepEqual(await post(undefined, { raw: '{' }), { status: 400, json: { error: 'Invalid order action' } });
  assert.deepEqual(await post({ action: 'delete', orderId: order.id }), { status: 400, json: { error: 'Invalid order action' } });
  assert.equal((await post({ action: 'list', orderIds: [] })).status, 400);

  const listed = await post({ action: 'list', orderIds: [order.id, 'ord_unknown'] });
  assert.equal(listed.status, 200);
  assert.deepEqual(Object.keys(listed.json.orders), [order.id]);
  const { status, fulfillmentStatus, restock, disputes, reservations } = listed.json.orders[order.id];
  assert.deepEqual([status, fulfillmentStatus, restock, disputes, reservations.length], ['refunded', 'unfulfilled', 'all', [], 5]);

  const restocked = await post({ action: 'restock', orderId: order.id, reason });
  assert.equal(restocked.status, 200);
  assert.equal(restocked.json.result.restocked.length, 5);
  assert.deepEqual(rows(sqlite, 'SELECT DISTINCT admin_actor FROM _ecommerce_restocks'), [{ admin_actor: 'admin-1' }]);
  assert.deepEqual(await post({ action: 'restock', orderId: order.id, reason }),
    { status: 409, json: { error: 'Nothing of this order is left to return to stock' } });
  assert.equal((await post({ action: 'restock', orderId: order.id, reason: 'short' })).status, 400);
  assert.deepEqual(stockLevels(sqlite), FULL);
  globalThis.cmsUser = undefined;
  sqlite.close();
});

test('the orders admin route answers a restock that fails for any other reason with 500 and logs it', async () => {
  const { sqlite, DB } = database();
  const { api, order } = await paidOrder(DB, EVERY_KIND);
  await refundEvent(api, order, order.totalAmount, NOW);
  const post = (body) => call(adminOrdersRoute, { DB }, { path: '/admin/api/ecommerce/orders-admin', body });
  const failed = { status: 500, json: { error: 'The restock failed. Check the server logs for details.' } };

  // A session without a user id cannot be recorded as the administrator who restocked.
  globalThis.cmsUser = { role: 'admin' };
  const { result: anonymous, lines: anonymousLines } = await captured('error', () => post({ action: 'restock', orderId: order.id, reason }));
  assert.deepEqual(anonymous, failed);
  assert.deepEqual(anonymousLines, [['[commerce] Restock failed', { name: 'Error', message: 'Administrator identity is required' }]]);

  // A Worker deployed before its migration: the database's own message stays in the log.
  globalThis.cmsUser = { id: 'admin-1', role: 'admin' };
  sqlite.exec('DROP TABLE _ecommerce_restocks');
  const { result, lines } = await captured('error', () => post({ action: 'restock', orderId: order.id, reason }));
  assert.deepEqual(result, failed);
  assert.equal(lines[0][0], '[commerce] Restock failed');
  assert.match(lines[0][1].message, /no such table/);
  assert.deepEqual(stockLevels(sqlite), SOLD);
  globalThis.cmsUser = undefined;
  sqlite.close();
});
