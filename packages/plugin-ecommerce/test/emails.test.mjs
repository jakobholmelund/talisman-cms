import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { applyAllMigrations } from './helpers/migrations.mjs';

// The routes read their bindings from cloudflare:workers and the admin route asks the CMS auth guard.
// A site build provides two virtual modules: the email provider registered with talismanCms({ email })
// and the store's email templates from ecommercePlugin({ emailTemplates }). This test serves them all;
// the templates come from globalThis.commerceEmailTemplates.
const stubs = {
  'cloudflare:workers': 'export const env = new Proxy({}, { get: (_, key) => globalThis.workerEnv?.[key] });',
  'talisman-cms/auth/guard': 'export async function authorizeCmsRequest(request, role) {'
    + ' const user = globalThis.cmsUser;'
    + " if (!user) return { response: Response.json({ error: 'Authentication required' }, { status: 401 }) };"
    + " if (role === 'admin' && user.role !== 'admin') return { response: Response.json({ error: 'Admin required' }, { status: 403 }) };"
    + ' return { user }; }',
  'virtual:talisman-cms/email': 'export const emailProviderFactory = null;',
  'virtual:talisman-cms/ecommerce-emails': 'export const emailTemplates = new Proxy({},'
    + ' { get: (_, key) => globalThis.commerceEmailTemplates?.[key] });',
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!(specifier in stubs)) return nextResolve(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  },
});
const { bindCommerceApi, reconcileCommerce, deliverPendingCommerceEmails } = await import('../dist/api.js');
const { AdminTestPaymentAdapter } = await import('../dist/adapters/admin-test.js');
const { correctCommerceFulfillment, fulfillCommerceOrder } = await import('../dist/fulfillment.js');
const { GIFT_CARD_CLAIMS_PER_NETWORK_PER_HOUR, getGiftCardsAdmin, getPurchasedGiftCard, issueAdminGiftCard,
  reconcileGiftCardPurchase, setGiftCardActive, startGiftCardPurchase } = await import('../dist/gift-cards.js');
const { claimGiftCardCode: claimFromBrowser, readGiftCardClaimToken } = await import('../dist/browser.js');
const { ecommercePlugin } = await import('../dist/index.js');
const schema = await import('../dist/schema.js');
const giftCardsRoute = (await import('../dist/routes/ecommerce-gift-cards.js')).POST;
const adminGiftCardsRoute = (await import('../dist/routes/ecommerce-admin-gift-cards.js')).ALL;

const ORIGIN = 'https://shop.test';

/**
 * An in-memory D1 stand-in. A batch runs without yielding, so concurrent requests interleave between
 * statements and batches but never inside a batch, as on D1. `recorded` collects each statement run.
 */
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(sqlite);
  const recorded = [];
  const DB = {
    prepare(sql) {
      const prepared = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        rows() { recorded.push([sql, values]); return { results: prepared.all(...values) }; },
        async all() { return this.rows(); },
        async first() { recorded.push([sql, values]); return prepared.get(...values) ?? null; },
        async raw() {
          recorded.push([sql, values]);
          const raw = sqlite.prepare(sql);
          raw.setReturnArrays(true);
          return raw.all(...values);
        },
        async run() { recorded.push([sql, values]); return { meta: prepared.run(...values) }; }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map((statement) => statement.rows());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  return { sqlite, DB, recorded };
}

/** A send_email binding that records each message; each code in `failures` fails one send, in order. */
function emailBinding() {
  const binding = {
    sent: [],
    failures: [],
    async send(builder) {
      const code = binding.failures.shift();
      // The binding's own message can hold the address; the plugin must never log it.
      if (code) throw Object.assign(new Error(`${code} for buyer@example.test`), { code });
      binding.sent.push(builder);
      return { messageId: `<m${binding.sent.length}@shop.test>` };
    },
  };
  return binding;
}

const STORE_SETTINGS = {
  TALISMAN_EMAIL_PROVIDER: 'cloudflare',
  TALISMAN_EMAIL_FROM: 'Talisman Vision <no-reply@shop.test>',
  TALISMAN_EMAIL_REPLY_TO: 'hello@shop.test',
  TALISMAN_PUBLIC_ORIGIN: ORIGIN,
  TALISMAN_COMMERCE_GIFT_CARD_KEY: 'a'.repeat(64),
};

const stripeState = () => ({ session: { status: 'open', url: 'https://checkout.stripe.test/open' } });

function stripeAdapter(state) {
  return {
    providerId: 'stripe',
    async createCheckoutSession({ orderId }) {
      return { providerSessionId: `cs_test_${orderId}`, url: `https://checkout.stripe.test/${orderId}` };
    },
    async expireCheckoutSession() {},
    async getCheckoutSession() { return state.session; },
    async validateWebhook(payload) { return JSON.parse(payload); },
  };
}

/** A store with a frame sold in one lens (Amber) and a case, email through a recording binding, and Stripe. */
function shop(settings = {}) {
  const { sqlite, DB, recorded } = database();
  const now = Math.floor(Date.now() / 1000);
  const product = sqlite.prepare(`INSERT INTO _ecommerce_products
    (id, name, slug, sku, base_price, inventory_quantity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 50, 'active', ?, ?)`);
  product.run('frame', 'The Forest Floor', 'frame', 'FFL', 12000, now, now);
  product.run('case', 'Travel case', 'case', 'CASE', 2000, now, now);
  sqlite.prepare(`INSERT INTO _ecommerce_variants (id, name, created_at, updated_at) VALUES ('def-lens', 'Lens', ?, ?)`).run(now, now);
  sqlite.prepare(`INSERT INTO _ecommerce_product_variants (id, product_id, variant_id, name, inventory_quantity, created_at, updated_at)
    VALUES ('frame-lens', 'frame', 'def-lens', 'Lens choice', 0, ?, ?)`).run(now, now);
  sqlite.prepare(`INSERT INTO _ecommerce_product_variant_values (id, product_variant_id, value, sku, created_at, updated_at)
    VALUES ('frame-amber', 'frame-lens', 'Amber', 'FFL-AMB', ?, ?)`).run(now, now);
  sqlite.prepare(`INSERT INTO _ecommerce_stocks (id, product_variant_value_id, quantity, created_at, updated_at)
    VALUES ('frame-amber-stock', 'frame-amber', 50, ?, ?)`).run(now, now);
  const EMAIL = emailBinding();
  const env = { DB, EMAIL, ...STORE_SETTINGS, ...settings };
  const state = stripeState();
  const adapter = stripeAdapter(state);
  return { sqlite, DB, recorded, env, EMAIL, sent: EMAIL.sent, state, adapter, browsers: 0,
    api: bindCommerceApi({ env, paymentAdapters: [adapter] }) };
}

const shippingAddress = { name: 'Test Buyer', line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' };
const checkout = { customerEmail: 'buyer@example.test', shippingAddress,
  successUrl: `${ORIGIN}/checkout/success?order={ORDER_ID}`, cancelUrl: `${ORIGIN}/checkout/cancel?order={ORDER_ID}` };
const TWO_FRAMES_AND_A_CASE = [{ productId: 'frame', variantId: 'frame-amber', quantity: 2 }, { productId: 'case', quantity: 1 }];

async function placeOrder(store, { items = TWO_FRAMES_AND_A_CASE, ...options } = {}) {
  const cart = await store.api.carts.getOrCreate(`browser-${++store.browsers}`);
  await store.api.carts.updateItems(cart.id, items);
  return (await store.api.orders.createFromCart(cart.id, { ...checkout, ...options })).order;
}

const stripeEvent = (store, type, data) => store.api.webhooks.handleStripe(JSON.stringify({ type, data }), 'signature', 'secret');
const orderCompleted = (store, order) => stripeEvent(store, 'checkout.session.completed', { id: order.checkoutSessionId,
  metadata: { orderId: order.id }, payment_status: 'paid', amount_total: order.totalAmount, currency: 'usd',
  payment_intent: `pi_${order.id}`, customer_details: { email: 'buyer@example.test' } });

async function paidOrder(store, options) {
  const order = await placeOrder(store, options);
  await orderCompleted(store, order);
  return order;
}

const purchaseUrls = { successUrl: `${ORIGIN}/gift-cards/success?purchase={PURCHASE_ID}`, cancelUrl: `${ORIGIN}/gift-cards` };
const purchaseCompleted = (store, purchase, amountCents = 5000) => stripeEvent(store, 'checkout.session.completed', {
  id: `cs_test_${purchase.id}`, metadata: { giftCardPurchaseId: purchase.id }, amount_total: amountCents, currency: 'usd',
  payment_status: 'paid', payment_intent: `pi_${purchase.id}` });

async function paidGiftCard(store, amountCents = 5000) {
  const purchase = await startGiftCardPurchase(store.env, store.adapter, { amountCents, buyerEmail: 'buyer@example.test' }, purchaseUrls);
  await purchaseCompleted(store, purchase, amountCents);
  return purchase;
}

const row = (sqlite, sql, ...params) => { const found = sqlite.prepare(sql).get(...params); return found ? { ...found } : found; };
const rows = (sqlite, sql, ...params) => sqlite.prepare(sql).all(...params).map((item) => ({ ...item }));
const delivery = (sqlite, kind, subjectId) => row(sqlite, `SELECT status, attempts, last_error, next_attempt_at, claimed_at,
  sent_at IS NOT NULL AS sent FROM _ecommerce_email_deliveries WHERE kind = ? AND subject_id = ?`, kind, subjectId);
const claimLinkIn = (text) => text.match(/https:\/\/shop\.test\/gift-cards\/claim#token=([0-9a-f]{64})/)?.[1];

/** Captures console output, so tests can check that no address is ever logged. */
function captureLogs(t) {
  const lines = [];
  for (const level of ['log', 'info', 'warn', 'error']) {
    t.mock.method(console, level, (...args) => {
      // Node reports the experimental node:sqlite module through console.error.
      if (String(args[0]).includes('ExperimentalWarning')) return;
      lines.push({ level, text: args.map((arg) => JSON.stringify(arg) ?? String(arg)).join(' '), args });
    });
  }
  return lines;
}
const noAddress = (value) => !JSON.stringify(value).includes('@');

async function post(route, env, body, { ip = '203.0.113.10', user, path = '/api/ecommerce/gift-cards' } = {}) {
  globalThis.workerEnv = env;
  globalThis.cmsUser = user;
  const request = new Request(`${ORIGIN}${path}`, {
    method: 'POST', headers: { origin: ORIGIN, 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(body),
  });
  const response = await route({ request, cookies: { get() {}, set() {}, delete() {} } });
  return { status: response.status, json: await response.json(), headers: response.headers };
}
const claim = (store, token, options) => post(giftCardsRoute, store.env, { action: 'claim', token }, options);
const ADMIN = { id: 'admin-7', role: 'admin' };
const resend = (store, data, user = ADMIN) => post(adminGiftCardsRoute, store.env, { action: 'resendClaimLink', data },
  { user, path: '/admin/api/ecommerce/gift-cards-admin' });
const workingLinks = (sqlite) => rows(sqlite, `SELECT id FROM _ecommerce_gift_card_claims
  WHERE used_at IS NULL AND revoked_at IS NULL ORDER BY rowid`).map((link) => link.id);
/** The lease of a Worker sending an email (COMMERCE_EMAIL_LEASE_SECONDS). */
const LEASE_SECONDS = 5 * 60;

/**
 * Runs `during` once, when the next Worker that builds a claim email has read the purchase and not yet
 * made its link, so a test can act in between.
 */
function whileBuildingClaimEmail(store, during) {
  const prepare = store.DB.prepare.bind(store.DB);
  let pending = during;
  store.DB.prepare = (sql) => {
    const statement = prepare(sql);
    if (pending && sql.includes('LEFT JOIN _ecommerce_gift_cards c ON c.id')) {
      const run = pending;
      pending = null;
      const first = statement.first.bind(statement);
      statement.first = async () => { await run(); return first(); };
    }
    return statement;
  };
}

// --- Order confirmation -------------------------------------------------------------------------

test('duplicate webhooks send one order confirmation, with the items, the amounts and the shipping address', async () => {
  const store = shop();
  const gift = await issueAdminGiftCard(store.env, 'admin-1', { amountCents: 5000, reason: 'Service goodwill card' });
  const order = await placeOrder(store, { giftCardCode: gift.code });
  // Stripe may deliver an event twice, even at the same time.
  await Promise.all([orderCompleted(store, order), orderCompleted(store, order)]);
  await orderCompleted(store, order);
  assert.equal(store.sent.length, 1);
  const [message] = store.sent;
  assert.equal(message.to, 'buyer@example.test');
  assert.deepEqual(message.from, { email: 'no-reply@shop.test', name: 'Talisman Vision' });
  assert.equal(message.replyTo, 'hello@shop.test');
  assert.equal(message.subject, 'Your Talisman Vision order is confirmed');
  assert.equal(message.headers['X-Talisman-Email'], 'order-confirmation');
  for (const line of [`We have received your payment for order ${order.id}`, '2 × The Forest Floor (Lens: Amber): $240.00',
    '1 × Travel case: $20.00', 'Items subtotal: $260.00', 'Gift card: -$50.00', 'Amount charged: $210.00',
    'Shipping to\nTest Buyer\n1 Main St\nAustin, TX, 78701\nUnited States', 'Seller\nTalisman Vision\nEmail: hello@shop.test']) {
    assert.ok(message.text.includes(line), line);
  }
  assert.ok(message.html.includes('The Forest Floor (Lens: Amber)'));
  const { status, attempts, last_error: lastError, claimed_at: claimedAt, sent } = delivery(store.sqlite, 'order_confirmation', order.id);
  assert.deepEqual({ status, attempts, lastError, claimedAt, sent }, { status: 'sent', attempts: 1, lastError: null, claimedAt: null, sent: 1 });
  assert.equal(row(store.sqlite, 'SELECT COUNT(*) AS n FROM _ecommerce_email_deliveries').n, 1);
});

test('the reconciliation path and the order status check confirm once too', async () => {
  const store = shop();
  const order = await placeOrder(store);
  store.state.session = { status: 'complete', paymentStatus: 'paid', amountTotal: order.totalAmount, currency: 'usd',
    paymentIntentId: `pi_${order.id}`, customerEmail: 'buyer@example.test', url: null };
  assert.equal((await store.api.orders.reconcilePending(order.id)).status, 'paid');
  await orderCompleted(store, order);
  assert.equal(store.sent.length, 1);

  // A gift-card-only order is confirmed at checkout, without the payment provider.
  const gift = await issueAdminGiftCard(store.env, 'admin-1', { amountCents: 50000, reason: 'Service goodwill card' });
  const internal = await placeOrder(store, { giftCardCode: gift.code });
  assert.equal(internal.status, 'paid');
  assert.equal(store.sent.length, 2);
  assert.ok(store.sent[1].text.includes('Amount charged: $0.00'));
});

test('a failed send is retried by the scheduled job and logged without the address', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const logs = captureLogs(t);
  const store = shop();
  store.EMAIL.failures.push('E_RATE_LIMIT_EXCEEDED');
  const order = await placeOrder(store);
  const paid = await orderCompleted(store, order);
  assert.equal(paid.status, 'paid', 'a failed email never fails the payment');
  assert.equal(store.sent.length, 0);
  const pending = delivery(store.sqlite, 'order_confirmation', order.id);
  assert.deepEqual([pending.status, pending.attempts, pending.last_error, pending.claimed_at], ['pending', 1, 'rate_limited', null]);
  assert.equal(pending.next_attempt_at, Math.floor(Date.now() / 1000) + 600, 'the first retry waits ten minutes');
  assert.deepEqual(logs.map((line) => [line.level, line.args[0], line.args[1]]), [['warn', '[commerce] Email not sent',
    { kind: 'order_confirmation', subject: order.id, status: 'email_retry', error: 'rate_limited' }]]);

  const reconcile = () => reconcileCommerce({ env: store.env, paymentAdapters: [store.adapter] });
  assert.deepEqual(await reconcile(), [], 'nothing is due before the wait is over');
  t.mock.timers.tick(10 * 60 * 1000);
  const results = await reconcile();
  assert.deepEqual(results, [{ id: `order_confirmation:${order.id}`, status: 'email_sent' }]);
  assert.equal(store.sent.length, 1);
  assert.equal(delivery(store.sqlite, 'order_confirmation', order.id).attempts, 2);
  assert.ok(logs.every(noAddress), 'no log line holds an address');
  assert.deepEqual(await reconcile(), []);
});

test('the scheduled job gives an email up after its last attempt and reports it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.method(console, 'warn', () => {});
  const store = shop();
  store.EMAIL.failures.push(...Array(10).fill('E_INTERNAL_SERVER_ERROR'));
  const order = await paidOrder(store);
  const waits = [];
  let results = [];
  for (let attempt = 2; attempt <= 10; attempt++) {
    const due = delivery(store.sqlite, 'order_confirmation', order.id).next_attempt_at;
    waits.push(due - Math.floor(Date.now() / 1000));
    t.mock.timers.setTime(due * 1000);
    results = await deliverPendingCommerceEmails({ env: store.env });
  }
  // Ten minutes, doubling up to twelve hours: about two days in all.
  assert.deepEqual(waits.map((seconds) => seconds / 60), [10, 20, 40, 80, 160, 320, 640, 720, 720]);
  assert.deepEqual(results, [{ id: `order_confirmation:${order.id}`, status: 'error',
    error: 'Order confirmation email was given up after 10 attempts (temporary)' }]);
  assert.deepEqual(Object.values(delivery(store.sqlite, 'order_confirmation', order.id)).slice(0, 3), ['failed', 10, 'temporary']);
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), []);
  assert.equal(store.sent.length, 0);
});

test('without email settings the confirmation waits, the payment succeeds, and the job reports it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const logs = captureLogs(t);
  const store = shop({ TALISMAN_EMAIL_PROVIDER: 'none' });
  const order = await placeOrder(store);
  assert.equal((await orderCompleted(store, order)).status, 'paid');
  assert.deepEqual(Object.values(delivery(store.sqlite, 'order_confirmation', order.id)).slice(0, 3), ['pending', 0, 'not_configured']);
  assert.deepEqual(logs.map((line) => [line.level, line.args[1]?.error]), [['error',
    'Order confirmation email waits: email needs an email provider']]);
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), [{ id: 'commerce_emails', status: 'error',
    error: 'Email needs an email provider; 1 email is waiting' }]);

  // Once email is configured, the next run sends it.
  store.env.TALISMAN_EMAIL_PROVIDER = 'cloudflare';
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), [{ id: `order_confirmation:${order.id}`, status: 'email_sent' }]);
  assert.equal(store.sent.length, 1);

  // An email that waited for more than seven days is given up and reported once.
  store.env.TALISMAN_EMAIL_PROVIDER = 'none';
  const late = await paidOrder(store);
  t.mock.timers.tick(7 * 24 * 60 * 60 * 1000 + 1000);
  store.env.TALISMAN_EMAIL_PROVIDER = 'cloudflare';
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), [{ id: `order_confirmation:${late.id}`, status: 'error',
    error: 'Email was not sent within 7 days and was given up' }]);
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), []);
  assert.equal(store.sent.length, 1);
  assert.ok(logs.every(noAddress));
});

test('an email a Worker claimed is left alone during its lease and taken over after it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.method(console, 'warn', () => {});
  const store = shop();
  store.EMAIL.failures.push('E_RATE_LIMIT_EXCEEDED');
  const order = await paidOrder(store);
  t.mock.timers.tick(10 * 60 * 1000);
  // A Worker claims the email and stops before it records anything.
  store.sqlite.prepare(`UPDATE _ecommerce_email_deliveries SET claimed_at = ?, attempts = attempts + 1
    WHERE kind = 'order_confirmation' AND subject_id = ?`).run(Math.floor(Date.now() / 1000), order.id);
  t.mock.timers.tick((LEASE_SECONDS - 1) * 1000);
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), [], 'another Worker may still be sending it');
  assert.equal(store.sent.length, 0);
  t.mock.timers.tick(1000);
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), [{ id: `order_confirmation:${order.id}`, status: 'email_sent' }]);
  assert.equal(store.sent.length, 1);
  assert.deepEqual(Object.values(delivery(store.sqlite, 'order_confirmation', order.id)).slice(0, 2), ['sent', 3]);
});

test('a suppressed address is final, and a confirmation for an order refunded before it went out is cancelled', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const logs = captureLogs(t);
  const store = shop();
  store.EMAIL.failures.push('E_RECIPIENT_SUPPRESSED');
  const suppressed = await paidOrder(store);
  assert.deepEqual(Object.values(delivery(store.sqlite, 'order_confirmation', suppressed.id)).slice(0, 3),
    ['failed', 1, 'recipient_suppressed']);
  assert.deepEqual(logs.map((line) => [line.level, line.args[1]]), [['warn',
    { kind: 'order_confirmation', subject: suppressed.id, status: 'email_undeliverable', error: 'recipient_suppressed' }]]);

  store.EMAIL.failures.push('E_RATE_LIMIT_EXCEEDED');
  const refunded = await paidOrder(store);
  // As a full refund leaves it.
  store.sqlite.prepare(`UPDATE _ecommerce_orders SET status = 'refunded' WHERE id = ?`).run(refunded.id);
  t.mock.timers.tick(10 * 60 * 1000);
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }),
    [{ id: `order_confirmation:${refunded.id}`, status: 'email_cancelled', error: 'not_due' }]);
  assert.deepEqual(Object.values(delivery(store.sqlite, 'order_confirmation', refunded.id)).slice(0, 3), ['cancelled', 2, 'not_due']);
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), [], 'neither is tried again');
  assert.equal(store.sent.length, 0);
  assert.ok(logs.every(noAddress));
});

test('emails that wait for a setting never hold back the others', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const logs = captureLogs(t);
  // Claim links need the public origin; the other emails do not.
  const store = shop({ TALISMAN_PUBLIC_ORIGIN: undefined });
  const purchases = [];
  for (let index = 0; index < 6; index++) purchases.push(await paidGiftCard(store, 2500));
  store.EMAIL.failures.push('E_RATE_LIMIT_EXCEEDED');
  const order = await paidOrder(store);
  t.mock.timers.tick(10 * 60 * 1000);
  store.recorded.length = 0;
  assert.deepEqual(await reconcileCommerce({ env: store.env, paymentAdapters: [store.adapter] }), [
    { id: 'commerce_emails', status: 'error',
      error: 'Gift card claim emails need an https public origin (TALISMAN_PUBLIC_ORIGIN); 5 or more emails are waiting' },
    { id: `order_confirmation:${order.id}`, status: 'email_sent' },
  ]);
  const reads = store.recorded.filter(([sql]) => /FROM _ecommerce_email_deliveries\s+WHERE status = 'pending'/.test(sql));
  for (const [sql, values] of reads) {
    const plan = rows(store.sqlite, `EXPLAIN QUERY PLAN ${sql}`, ...values).map((step) => step.detail).join(' | ');
    assert.match(plan, /USING INDEX _ecommerce_email_deliveries_due_idx/, plan);
  }
  // The claim emails go out once the origin is set, five per run.
  store.env.TALISMAN_PUBLIC_ORIGIN = ORIGIN;
  assert.equal((await reconcileCommerce({ env: store.env, paymentAdapters: [store.adapter] })).length, 5);
  assert.equal((await reconcileCommerce({ env: store.env, paymentAdapters: [store.adapter] })).length, 1);
  assert.deepEqual(purchases.map((purchase) => delivery(store.sqlite, 'gift_card_claim', purchase.id).status), Array(6).fill('sent'));
  assert.ok(logs.every(noAddress));
});

test('amounts are in the minor units of the order\'s currency, so a JPY order reads in whole yen', async () => {
  const store = shop({ TALISMAN_COMMERCE_CURRENCY: 'jpy' });
  const order = await placeOrder(store, { items: [{ productId: 'case', quantity: 3 }] });
  assert.deepEqual([order.currency, order.totalAmount], ['jpy', 6000]);
  await stripeEvent(store, 'checkout.session.completed', { id: order.checkoutSessionId, metadata: { orderId: order.id },
    payment_status: 'paid', amount_total: order.totalAmount, currency: 'jpy', payment_intent: `pi_${order.id}`,
    customer_details: { email: 'buyer@example.test' } });
  assert.equal(store.sent.length, 1);
  for (const line of ['3 × Travel case: ¥6,000', 'Items subtotal: ¥6,000', 'Amount charged: ¥6,000']) {
    assert.ok(store.sent[0].text.includes(line), line);
  }
  const { formatMoney } = await import('../dist/emails.js');
  assert.deepEqual([formatMoney(1250, 'usd'), formatMoney(-1250, 'usd'), formatMoney(1250, 'jpy'), formatMoney(1250, 'kwd')],
    ['$12.50', '-$12.50', '¥1,250', 'KWD\u00a01.250']);
});

test('a confirmation that waited with its order\'s shipment notice goes out first', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  captureLogs(t);
  const store = shop({ TALISMAN_EMAIL_PROVIDER: 'none' });
  const order = await paidOrder(store);
  await fulfillCommerceOrder(store.env, 'admin-1', { orderId: order.id, carrier: 'UPS', trackingNumber: '1Z999', note: 'Parcel handed over' });
  // Both became due in the same second, and the shipment's id sorts first.
  const now = Math.floor(Date.now() / 1000);
  store.sqlite.prepare(`UPDATE _ecommerce_email_deliveries SET created_at = ?, next_attempt_at = ?,
    id = CASE kind WHEN 'order_confirmation' THEN 'delivery-b' ELSE 'delivery-a' END`).run(now, now);
  store.env.TALISMAN_EMAIL_PROVIDER = 'cloudflare';
  assert.deepEqual((await deliverPendingCommerceEmails({ env: store.env })).map((result) => result.status), ['email_sent', 'email_sent']);
  assert.deepEqual(store.sent.map((message) => message.headers['X-Talisman-Email']), ['order-confirmation', 'order-shipment']);
});

test('with the console email provider, emails and claim links are written to the Worker log', async (t) => {
  const printed = [];
  t.mock.method(console, 'log', (...args) => printed.push(String(args[0])));
  // The console provider runs only for a localhost origin, where claim links may use http.
  const store = shop({ TALISMAN_EMAIL_PROVIDER: 'console', TALISMAN_PUBLIC_ORIGIN: 'http://localhost:4321' });
  const order = await paidOrder(store);
  const shipped = await fulfillCommerceOrder(store.env, 'admin-1', { orderId: order.id, carrier: 'DHL', trackingNumber: 'JD0001',
    note: 'Parcel handed over' });
  const purchase = await paidGiftCard(store);
  assert.equal(store.sent.length, 0, 'the send_email binding is not used');
  assert.deepEqual(printed.map((text) => text.split('\n').find((line) => line.startsWith('Subject: '))), [
    'Subject: Your Talisman Vision order is confirmed',
    'Subject: Your Talisman Vision order has shipped',
    'Subject: Your Talisman Vision gift card',
  ]);
  assert.ok(printed.every((text) => text.startsWith('[Talisman CMS] Email not sent (console provider)')));
  assert.ok(printed[1].includes('Tracking number: JD0001'));
  const token = printed[2].match(/http:\/\/localhost:4321\/gift-cards\/claim#token=([0-9a-f]{64})/)?.[1];
  assert.ok(token, 'the claim link is printed');
  assert.equal((await claim(store, token)).status, 200);
  assert.deepEqual([delivery(store.sqlite, 'order_confirmation', order.id).status, delivery(store.sqlite, 'shipment', shipped.fulfillmentId).status,
    delivery(store.sqlite, 'gift_card_claim', purchase.id).status], ['sent', 'sent', 'sent']);
});

test('admin test orders send no email', async () => {
  const store = shop();
  const api = bindCommerceApi({ env: store.env, paymentAdapters: [new AdminTestPaymentAdapter()] });
  const cart = await api.carts.getOrCreate('admin-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'case', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, { ...checkout, providerId: 'admin_test' });
  assert.equal((await api.orders.reconcilePending(order.id)).status, 'paid');
  assert.equal((await api.orders.find(order.id)).status, 'paid');
  await assert.rejects(fulfillCommerceOrder(store.env, 'admin-1', { orderId: order.id, note: 'Parcel handed over' }),
    /Admin test orders cannot be fulfilled/);
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), []);
  assert.equal(row(store.sqlite, 'SELECT COUNT(*) AS n FROM _ecommerce_email_deliveries').n, 0);
  assert.equal(store.sent.length, 0);
});

test('the confirmation carries the store details and links the settings name', async (t) => {
  const logs = captureLogs(t);
  const store = shop({
    TALISMAN_COMMERCE_STORE_NAME: 'Talisman Vision Store',
    TALISMAN_COMMERCE_STORE_LEGAL_NAME: 'Example Trading Ltd',
    TALISMAN_COMMERCE_STORE_ADDRESS: 'Unit 1, Example Street\nExample City',
    TALISMAN_COMMERCE_SUPPORT_EMAIL: 'support@shop.test',
    TALISMAN_COMMERCE_TERMS_URL: 'https://shop.test/terms',
    TALISMAN_COMMERCE_RETURNS_URL: '/returns',
    // Not https, so it is left out.
    TALISMAN_COMMERCE_WARRANTY_URL: 'http://shop.test/warranty',
  });
  await paidOrder(store);
  const [message] = store.sent;
  assert.equal(message.subject, 'Your Talisman Vision Store order is confirmed');
  assert.equal(message.replyTo, 'support@shop.test', 'replies go to the support address');
  assert.ok(message.text.includes('Seller\nExample Trading Ltd\nUnit 1, Example Street\nExample City\nEmail: support@shop.test'));
  assert.ok(message.text.includes('Terms and your rights\nTerms of sale: https://shop.test/terms\n'
    + 'Returns and right of withdrawal: https://shop.test/returns'));
  assert.ok(!message.text.includes('Warranty'));
  assert.ok(message.html.includes('href="https://shop.test/terms"'));
  assert.ok(message.html.includes('href="https://shop.test/returns"'));
  assert.ok(message.text.includes('Questions about your order? Please write to support@shop.test'));
  assert.deepEqual(logs.map((line) => line.args[0]),
    ['[commerce] TALISMAN_COMMERCE_WARRANTY_URL must be an https URL or a path on the public origin; emails leave it out']);
});

test('store templates replace subjects and bodies, and a failing template leaves the default', async (t) => {
  const logs = captureLogs(t);
  t.after(() => { globalThis.commerceEmailTemplates = undefined; });
  const seen = [];
  globalThis.commerceEmailTemplates = {
    orderConfirmation(email, defaults) {
      seen.push(email);
      return { ...defaults, subject: `Order ${email.order.id} from ${email.store.name}`, html: undefined };
    },
    shipment() { throw new Error('Template bug for buyer@example.test'); },
    giftCardClaim: () => ({ subject: 'Two\nlines', text: 'Invalid' }),
  };
  const store = shop();
  const order = await paidOrder(store);
  assert.equal(store.sent[0].subject, `Order ${order.id} from Talisman Vision`);
  assert.equal(store.sent[0].html, undefined);
  assert.deepEqual(seen[0].order.amounts.map((amount) => [amount.key, amount.label, amount.cents]),
    [['itemsSubtotal', 'Items subtotal', 26000], ['charged', 'Amount charged', 26000]]);
  assert.deepEqual(seen[0].order.items.map((item) => [item.name, item.sku, item.quantity, item.unitCents, item.lineCents]),
    [['The Forest Floor (Lens: Amber)', 'FFL-AMB', 2, 12000, 24000], ['Travel case', 'CASE', 1, 2000, 2000]]);

  await fulfillCommerceOrder(store.env, 'admin-1', { orderId: order.id, carrier: 'DHL', trackingNumber: 'JD0001', note: 'Parcel handed over' });
  assert.equal(store.sent[1].subject, 'Your Talisman Vision order has shipped');
  await paidGiftCard(store);
  assert.equal(store.sent[2].subject, 'Your Talisman Vision gift card');
  assert.deepEqual(logs.map((line) => [line.args[0], line.args[1]]), [
    ['[commerce] A store email template failed; the default is sent', { template: 'shipment', name: 'Error' }],
    ['[commerce] A store email template returned no valid message; the default is sent', { template: 'giftCardClaim' }],
  ]);
  assert.ok(logs.every(noAddress));
});

// --- Shipment emails ----------------------------------------------------------------------------

test('the shipment email carries the carrier and tracking number and says whether more parcels follow', async () => {
  const store = shop();
  const order = await paidOrder(store);
  const ship = (extra) => fulfillCommerceOrder(store.env, 'admin-1', { orderId: order.id, note: 'Parcel handed over', ...extra });
  const first = await ship({ carrier: 'DHL', trackingNumber: 'JD0001', completesOrder: false });
  const [, parcel] = store.sent;
  assert.equal(parcel.subject, 'Part of your Talisman Vision order has shipped');
  assert.equal(parcel.headers['X-Talisman-Email'], 'order-shipment');
  for (const line of [`We shipped a parcel of your order ${order.id} on`, 'More parcels will follow.', 'Carrier: DHL',
    'Tracking number: JD0001']) assert.ok(parcel.text.includes(line), line);
  assert.equal(delivery(store.sqlite, 'shipment', first.fulfillmentId).status, 'sent');

  await ship({ carrier: 'DHL', trackingNumber: null });
  const last = store.sent[2];
  assert.equal(last.subject, 'The rest of your Talisman Vision order has shipped');
  assert.ok(last.text.includes(`We shipped the last parcel of your order ${order.id}`));
  assert.ok(last.text.includes('This parcel has no tracking number.'));
  assert.ok(!last.text.includes('Tracking number:'));

  const whole = await paidOrder(store);
  await fulfillCommerceOrder(store.env, 'admin-1', { orderId: whole.id, carrier: 'UPS', trackingNumber: '1Z999', note: 'Parcel handed over' });
  assert.equal(store.sent.at(-1).subject, 'Your Talisman Vision order has shipped');
  assert.ok(store.sent.at(-1).text.includes(`We shipped your order ${whole.id} on`));
});

test('a correction sends updated details once the shipment email went out; an unsent email carries them', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.method(console, 'warn', () => {});
  const store = shop();
  const order = await paidOrder(store);
  const shipped = await fulfillCommerceOrder(store.env, 'admin-1', { orderId: order.id, carrier: 'UPS',
    trackingNumber: '1Z-WRONG', note: 'Parcel handed over' });
  const corrected = await correctCommerceFulfillment(store.env, 'admin-2', { fulfillmentId: shipped.fulfillmentId,
    carrier: 'UPS', trackingNumber: '1Z-RIGHT', reason: 'The label was reprinted' });
  const update = store.sent.at(-1);
  assert.equal(update.subject, 'Updated shipping details for your Talisman Vision order');
  assert.equal(update.headers['X-Talisman-Email'], 'order-shipment-update');
  assert.ok(update.text.includes('Tracking number: 1Z-RIGHT'));
  assert.equal(delivery(store.sqlite, 'shipment_update', corrected.correctionId).status, 'sent');

  // The shipment email of another order fails at first; a correction then needs no update of its own.
  const other = await paidOrder(store);
  store.EMAIL.failures.push('E_RATE_LIMIT_EXCEEDED');
  const unsent = await fulfillCommerceOrder(store.env, 'admin-1', { orderId: other.id, carrier: 'UPS',
    trackingNumber: '1Z-TYPO', note: 'Parcel handed over' });
  const typo = await correctCommerceFulfillment(store.env, 'admin-2', { fulfillmentId: unsent.fulfillmentId,
    carrier: 'UPS', trackingNumber: '1Z-FIXED', reason: 'Typed the wrong digits' });
  assert.equal(delivery(store.sqlite, 'shipment_update', typo.correctionId), undefined);
  const before = store.sent.length;
  t.mock.timers.tick(10 * 60 * 1000);
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), [{ id: `shipment:${unsent.fulfillmentId}`, status: 'email_sent' }]);
  assert.equal(store.sent.length, before + 1);
  assert.ok(store.sent.at(-1).text.includes('Tracking number: 1Z-FIXED'));
  assert.ok(!store.sent.at(-1).text.includes('1Z-TYPO'));
});

test('a correction after the lease on the shipment email ran out sends no update first; the notice carries it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.method(console, 'warn', () => {});
  const store = shop();
  const order = await paidOrder(store);
  store.EMAIL.failures.push('E_RATE_LIMIT_EXCEEDED');
  const shipped = await fulfillCommerceOrder(store.env, 'admin-1', { orderId: order.id, carrier: 'UPS',
    trackingNumber: '1Z-TYPO', note: 'Parcel handed over' });
  t.mock.timers.tick(10 * 60 * 1000);
  // A Worker claims the retry and stops before it records anything; then its lease runs out.
  store.sqlite.prepare(`UPDATE _ecommerce_email_deliveries SET claimed_at = ?, attempts = attempts + 1
    WHERE kind = 'shipment' AND subject_id = ?`).run(Math.floor(Date.now() / 1000), shipped.fulfillmentId);
  t.mock.timers.tick(6 * 60 * 1000);
  const before = store.sent.length;
  const typo = await correctCommerceFulfillment(store.env, 'admin-2', { fulfillmentId: shipped.fulfillmentId,
    carrier: 'UPS', trackingNumber: '1Z-FIXED', reason: 'Typed the wrong digits' });
  assert.equal(delivery(store.sqlite, 'shipment_update', typo.correctionId), undefined);
  assert.equal(store.sent.length, before);
  await deliverPendingCommerceEmails({ env: store.env });
  assert.deepEqual(store.sent.slice(before).map((message) => message.subject), ['Your Talisman Vision order has shipped']);
  assert.ok(store.sent.at(-1).text.includes('Tracking number: 1Z-FIXED'));
});

// --- Gift card claim links ----------------------------------------------------------------------

test('the claim link shows the code once and then no longer works', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const store = shop();
  const purchase = await paidGiftCard(store);
  assert.equal(store.sent.length, 1);
  const [message] = store.sent;
  assert.equal(message.to, 'buyer@example.test');
  assert.equal(message.subject, 'Your Talisman Vision gift card');
  assert.equal(message.headers['X-Talisman-Email'], 'gift-card-claim');
  const token = claimLinkIn(message.text);
  assert.ok(token, 'the email carries a claim link with the token in its fragment');
  assert.ok(message.html.includes(`href="${ORIGIN}/gift-cards/claim#token=${token}"`));
  const { code } = await getPurchasedGiftCard(store.env, purchase.id, purchase.accessToken);
  assert.ok(!message.text.includes(code) && !message.html.includes(code), 'the email never holds the code');
  assert.ok(message.text.includes('$50.00 gift card') && message.text.includes('The link works once and expires on'));
  // Only the token's hash is stored.
  const stored = row(store.sqlite, 'SELECT token_hash, created_by, reason, expires_at - created_at AS lifetime FROM _ecommerce_gift_card_claims');
  assert.notEqual(stored.token_hash, token);
  assert.deepEqual([stored.created_by, stored.reason, stored.lifetime], [null, null, 7 * 24 * 60 * 60]);

  const shown = await claim(store, token);
  assert.deepEqual([shown.status, shown.json], [200, { code, balanceCents: 5000, currency: 'usd' }]);
  assert.equal(shown.headers.get('cache-control'), 'no-store');
  const again = await claim(store, token);
  assert.deepEqual([again.status, again.json.error], [400,
    'This gift card link has already been used or has expired. Ask the store to send a new one.']);
  // The cookie of the browser that paid still shows the code.
  assert.equal((await getPurchasedGiftCard(store.env, purchase.id, purchase.accessToken)).code, code);

  // A new link expires after seven days, and works only while its card is active.
  assert.equal((await resend(store, { purchaseId: purchase.id, reason: 'Buyer lost the first email' })).status, 200);
  const fresh = claimLinkIn(store.sent.at(-1).text);
  const card = row(store.sqlite, 'SELECT id FROM _ecommerce_gift_cards WHERE purchase_id = ?', purchase.id);
  await setGiftCardActive(store.env, card.id, false);
  assert.equal((await claim(store, fresh)).status, 400);
  await setGiftCardActive(store.env, card.id, true);
  t.mock.timers.tick(7 * 24 * 60 * 60 * 1000);
  assert.equal((await claim(store, fresh)).status, 400);
  assert.equal((await claim(store, 'not-a-token')).status, 400);
});

test('duplicate webhooks and reconciliation send one claim email', async () => {
  const store = shop();
  const purchase = await startGiftCardPurchase(store.env, store.adapter, { amountCents: 2500, buyerEmail: 'buyer@example.test' }, purchaseUrls);
  store.adapter.getCheckoutSession = async () => ({ status: 'complete', paymentStatus: 'paid', amountTotal: 2500,
    currency: 'usd', paymentIntentId: `pi_${purchase.id}`, url: null });
  assert.deepEqual(await reconcileGiftCardPurchase(store.env, store.adapter, purchase.id), { status: 'paid' });
  await purchaseCompleted(store, purchase, 2500);
  await purchaseCompleted(store, purchase, 2500);
  assert.equal(store.sent.length, 1);
  assert.equal(row(store.sqlite, 'SELECT COUNT(*) AS n FROM _ecommerce_gift_card_claims').n, 1);
  assert.equal(delivery(store.sqlite, 'gift_card_claim', purchase.id).status, 'sent');

  const second = await startGiftCardPurchase(store.env, store.adapter, { amountCents: 2500, buyerEmail: 'buyer@example.test' }, purchaseUrls);
  await purchaseCompleted(store, second, 2500);
  await purchaseCompleted(store, second, 2500);
  assert.equal(await reconcileGiftCardPurchase(store.env, store.adapter, second.id), null);
  assert.equal(store.sent.length, 2);
  assert.equal(row(store.sqlite, 'SELECT COUNT(*) AS n FROM _ecommerce_email_deliveries').n, 2);
});

test('a claim email that fails is retried with a new link, and the failed link never works', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.method(console, 'warn', () => {});
  const store = shop();
  store.EMAIL.failures.push('E_RATE_LIMIT_EXCEEDED');
  const purchase = await paidGiftCard(store);
  assert.equal(store.sent.length, 0);
  assert.deepEqual(rows(store.sqlite, 'SELECT revoked_at IS NOT NULL AS revoked FROM _ecommerce_gift_card_claims'), [{ revoked: 1 }]);
  t.mock.timers.tick(10 * 60 * 1000);
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), [{ id: `gift_card_claim:${purchase.id}`, status: 'email_sent' }]);
  assert.equal((await claim(store, claimLinkIn(store.sent[0].text))).status, 200);
});

test('concurrent duplicate purchase webhooks send one claim email', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const store = shop();
  const purchase = await startGiftCardPurchase(store.env, store.adapter, { amountCents: 5000, buyerEmail: 'buyer@example.test' }, purchaseUrls);
  const outcomes = await Promise.allSettled([purchaseCompleted(store, purchase), purchaseCompleted(store, purchase)]);
  assert.ok(outcomes.some((outcome) => outcome.status === 'fulfilled'));
  assert.equal(row(store.sqlite, 'SELECT status FROM _ecommerce_gift_card_purchases WHERE id = ?', purchase.id).status, 'paid');
  assert.equal(store.sent.length, 1);
  assert.equal(row(store.sqlite, 'SELECT COUNT(*) AS n FROM _ecommerce_email_deliveries').n, 1);
  assert.equal(workingLinks(store.sqlite).length, 1);
});

test('a claim email for a card that is no longer active is cancelled', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.method(console, 'warn', () => {});
  const store = shop();
  store.EMAIL.failures.push('E_RATE_LIMIT_EXCEEDED');
  const purchase = await paidGiftCard(store);
  const card = row(store.sqlite, 'SELECT id FROM _ecommerce_gift_cards WHERE purchase_id = ?', purchase.id);
  await setGiftCardActive(store.env, card.id, false);
  t.mock.timers.tick(10 * 60 * 1000);
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }),
    [{ id: `gift_card_claim:${purchase.id}`, status: 'email_cancelled', error: 'not_claimable' }]);
  assert.equal(store.sent.length, 0);
  assert.deepEqual(workingLinks(store.sqlite), [], 'no link is made for a suspended card');
});

test('a claim email needs an https public origin; without one it waits and the resend says why', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const logs = captureLogs(t);
  const store = shop({ TALISMAN_PUBLIC_ORIGIN: 'http://shop.test' });
  const purchase = await paidGiftCard(store);
  assert.equal(store.sent.length, 0, 'an email whose link would be dropped is not sent');
  assert.deepEqual(Object.values(delivery(store.sqlite, 'gift_card_claim', purchase.id)).slice(0, 3), ['pending', 0, 'not_configured']);
  assert.equal(row(store.sqlite, 'SELECT COUNT(*) AS n FROM _ecommerce_gift_card_claims').n, 0, 'no link is made');
  const refused = await resend(store, { purchaseId: purchase.id, reason: 'Buyer never received the email' });
  assert.deepEqual([refused.status, refused.json.error],
    [400, 'Email needs an https public origin (TALISMAN_PUBLIC_ORIGIN) before a claim link can be sent']);
  // Order emails carry no link to the storefront, so they do not wait for it.
  await paidOrder(store);
  assert.equal(store.sent.length, 1);
  assert.deepEqual(logs.map((line) => [line.level, line.args[1]?.error]), [['error',
    'Gift card claim email waits: email needs an https public origin (TALISMAN_PUBLIC_ORIGIN)']]);

  // http is accepted on localhost, for development.
  store.env.TALISMAN_PUBLIC_ORIGIN = 'http://localhost:4321';
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), [{ id: `gift_card_claim:${purchase.id}`, status: 'email_sent' }]);
  assert.ok(store.sent.at(-1).text.includes('http://localhost:4321/gift-cards/claim#token='));
});

test('a resend that fails leaves the automatic email to its retries and earlier links working', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const logs = captureLogs(t);
  const store = shop();
  // The automatic email fails once and waits for its retry; a resend fails too.
  store.EMAIL.failures.push('E_RATE_LIMIT_EXCEEDED');
  const waiting = await paidGiftCard(store);
  const before = delivery(store.sqlite, 'gift_card_claim', waiting.id);
  store.EMAIL.failures.push('E_RATE_LIMIT_EXCEEDED');
  const failed = await resend(store, { purchaseId: waiting.id, reason: 'Buyer never received the email' });
  assert.deepEqual([failed.status, failed.json.error], [400, 'The claim email could not be sent (rate_limited); earlier links still work. Try again later']);
  assert.deepEqual(delivery(store.sqlite, 'gift_card_claim', waiting.id), before, 'the automatic email keeps its place');
  assert.deepEqual(workingLinks(store.sqlite), []);
  t.mock.timers.tick(10 * 60 * 1000);
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), [{ id: `gift_card_claim:${waiting.id}`, status: 'email_sent' }]);
  assert.equal((await claim(store, claimLinkIn(store.sent.at(-1).text))).status, 200);

  // A buyer who has a link keeps it when a resend fails.
  const purchase = await paidGiftCard(store);
  const first = claimLinkIn(store.sent.at(-1).text);
  store.EMAIL.failures.push('E_RATE_LIMIT_EXCEEDED');
  assert.equal((await resend(store, { purchaseId: purchase.id, reason: 'Buyer asks for another copy' })).status, 400);
  // The admin row shows the link the buyer can still use, not the unsent one the failed resend revoked.
  const adminRow = (await getGiftCardsAdmin(store.env)).find((card) => card.purchaseId === purchase.id);
  assert.deepEqual([adminRow.claimLink.usedAt, adminRow.claimLink.revokedAt, adminRow.claimLink.resent], [null, null, false]);
  assert.equal((await claim(store, first)).status, 200, 'the earlier link still works');

  // A resend that is sent replaces an automatic email still waiting for its retry.
  store.EMAIL.failures.push('E_RATE_LIMIT_EXCEEDED');
  const late = await paidGiftCard(store);
  assert.equal((await resend(store, { purchaseId: late.id, reason: 'Buyer never received the email' })).status, 200);
  const superseded = delivery(store.sqlite, 'gift_card_claim', late.id);
  assert.deepEqual([superseded.status, superseded.attempts, superseded.last_error, superseded.claimed_at],
    ['cancelled', 1, 'superseded', null]);
  t.mock.timers.tick(10 * 60 * 1000);
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), []);
  assert.equal((await claim(store, claimLinkIn(store.sent.at(-1).text))).status, 200);
  assert.ok(logs.every(noAddress));
});

test('a resend waits while the claim email is being sent, and a Worker that lost its lease sends nothing', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.method(console, 'warn', () => {});
  const store = shop();
  store.EMAIL.failures.push('E_RATE_LIMIT_EXCEEDED');
  const purchase = await paidGiftCard(store);
  t.mock.timers.tick(10 * 60 * 1000);
  whileBuildingClaimEmail(store, async () => {
    const refused = await resend(store, { purchaseId: purchase.id, reason: 'Buyer never received the email' });
    assert.deepEqual([refused.status, refused.json.error], [400,
      'The claim email is being sent right now; reload in a few minutes and resend it only if it was not sent']);
  });
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), [{ id: `gift_card_claim:${purchase.id}`, status: 'email_sent' }]);
  assert.equal(store.sent.length, 1);
  assert.equal(workingLinks(store.sqlite).length, 1);

  // A Worker stalls past its lease while it builds the email, and the next run takes the email over.
  store.EMAIL.failures.push('E_RATE_LIMIT_EXCEEDED');
  const slow = await paidGiftCard(store);
  t.mock.timers.tick(10 * 60 * 1000);
  whileBuildingClaimEmail(store, async () => {
    t.mock.timers.tick((LEASE_SECONDS + 1) * 1000);
    assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), [{ id: `gift_card_claim:${slow.id}`, status: 'email_sent' }]);
  });
  assert.deepEqual(await deliverPendingCommerceEmails({ env: store.env }), [], 'the stalled Worker records and reports nothing');
  assert.equal(store.sent.length, 2);
  assert.equal(delivery(store.sqlite, 'gift_card_claim', slow.id).status, 'sent');
  // The link of the failed first send, revoked, and the link of the Worker that sent the email.
  assert.deepEqual(rows(store.sqlite, `SELECT revoked_at IS NOT NULL AS revoked FROM _ecommerce_gift_card_claims
    WHERE purchase_id = ? ORDER BY rowid`, slow.id), [{ revoked: 1 }, { revoked: 0 }], 'the stalled Worker made no link');
});

test('the resend is admin-only, audited, and stops earlier links', async (t) => {
  const logs = captureLogs(t);
  const store = shop();
  const purchase = await paidGiftCard(store);
  const first = claimLinkIn(store.sent[0].text);
  const reason = 'Buyer never received the first email';
  assert.equal((await resend(store, { purchaseId: purchase.id, reason }, null)).status, 401);
  assert.equal((await resend(store, { purchaseId: purchase.id, reason }, { id: 'editor-1', role: 'editor' })).status, 403);
  assert.equal((await resend(store, { purchaseId: purchase.id, reason: 'short' })).status, 400);
  assert.equal(store.sent.length, 1, 'refused requests send nothing');

  const sent = await resend(store, { purchaseId: purchase.id, reason });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.result.purchaseId, purchase.id);
  assert.equal(store.sent.length, 2);
  assert.equal(store.sent[1].to, 'buyer@example.test');
  const second = claimLinkIn(store.sent[1].text);
  assert.equal((await claim(store, first)).status, 400, 'the earlier link was revoked');
  assert.equal((await claim(store, second)).status, 200);
  assert.deepEqual(rows(store.sqlite, `SELECT created_by, reason, revoked_at IS NOT NULL AS revoked, used_at IS NOT NULL AS used
    FROM _ecommerce_gift_card_claims ORDER BY created_at, rowid`), [
    { created_by: null, reason: null, revoked: 1, used: 0 },
    { created_by: 'admin-7', reason, revoked: 0, used: 1 },
  ]);

  // The admin list shows the purchase, its buyer and the newest link.
  const [card] = await getGiftCardsAdmin(store.env);
  assert.deepEqual([card.purchaseId, card.buyerEmail, card.claimLink.resent, Boolean(card.claimLink.usedAt), card.claimEmail.status],
    [purchase.id, 'buyer@example.test', true, true, 'sent']);

  // A send that fails leaves no working link behind, and says why.
  store.EMAIL.failures.push('E_RATE_LIMIT_EXCEEDED');
  const failed = await resend(store, { purchaseId: purchase.id, reason });
  assert.deepEqual([failed.status, failed.json.error], [400, 'The claim email could not be sent (rate_limited); earlier links still work. Try again later']);
  assert.equal(row(store.sqlite, `SELECT COUNT(*) AS n FROM _ecommerce_gift_card_claims WHERE used_at IS NULL AND revoked_at IS NULL`).n, 0);

  // A replacement card voids the purchased one, so its links stop working; a resend reveals the replacement.
  assert.equal((await resend(store, { purchaseId: purchase.id, reason })).status, 200);
  const third = claimLinkIn(store.sent.at(-1).text);
  const replacement = await issueAdminGiftCard(store.env, 'admin-1', { amountCents: 5000,
    reason: 'Buyer lost the code', replacesPurchaseId: purchase.id });
  assert.equal((await claim(store, third)).status, 400);
  assert.equal((await resend(store, { purchaseId: purchase.id, reason: 'Send the replacement code' })).status, 200);
  const shown = await claim(store, claimLinkIn(store.sent.at(-1).text));
  assert.deepEqual([shown.status, shown.json.code], [200, replacement.code]);
  assert.ok(logs.every(noAddress));
});

test('of two resends at the same time, the later link is the one that works', async () => {
  const store = shop();
  const purchase = await paidGiftCard(store);
  // Each send waits for the other, so both links exist before either resend stops the earlier ones.
  const send = store.EMAIL.send;
  let arrived = 0;
  let bothSending;
  const gate = new Promise((resolve) => { bothSending = resolve; });
  store.EMAIL.send = async (message) => {
    if (++arrived === 2) bothSending();
    await gate;
    return send(message);
  };
  const [one, two] = await Promise.all([resend(store, { purchaseId: purchase.id, reason: 'Buyer asked support by phone' }),
    resend(store, { purchaseId: purchase.id, reason: 'Buyer asked support by email' })]);
  assert.deepEqual([one.status, two.status], [200, 200]);
  assert.equal(store.sent.length, 3);
  const newest = rows(store.sqlite, 'SELECT id FROM _ecommerce_gift_card_claims ORDER BY rowid').at(-1).id;
  assert.deepEqual(workingLinks(store.sqlite), [newest]);
});

test('the gift card list reads each card\'s claim links through the purchase index', async () => {
  const store = shop();
  await paidGiftCard(store);
  await issueAdminGiftCard(store.env, 'admin-1', { amountCents: 5000, reason: 'Service goodwill card' });
  store.recorded.length = 0;
  const cards = await getGiftCardsAdmin(store.env);
  assert.deepEqual(cards.map((card) => [card.source, Boolean(card.claimLink)]).sort(), [['admin', false], ['purchase', true]]);
  const [[sql, values]] = store.recorded.filter(([text]) => text.includes('_ecommerce_gift_card_claims'));
  const plan = rows(store.sqlite, `EXPLAIN QUERY PLAN ${sql}`, ...values).map((step) => step.detail).join(' | ');
  assert.match(plan, /SEARCH l USING INDEX _ecommerce_gift_card_claims_purchase_idx/, plan);
  assert.doesNotMatch(plan, /SCAN l\b/, plan);
});

test('claim requests are limited per client network', async () => {
  const store = shop();
  for (let index = 0; index < GIFT_CARD_CLAIMS_PER_NETWORK_PER_HOUR; index++) {
    assert.equal((await claim(store, 'f'.repeat(64), { ip: '2001:db8:5:6::1' })).status, 400);
  }
  const limited = await claim(store, 'f'.repeat(64), { ip: '2001:db8:5:6:ffff::2' });
  assert.deepEqual([limited.status, limited.json.error, limited.headers.get('retry-after')],
    [429, 'Too many requests. Please try again later.', '3600']);
  assert.equal((await claim(store, 'f'.repeat(64), { ip: '198.51.100.9' })).status, 400, 'another network is not limited');
  const keys = rows(store.sqlite, 'SELECT key FROM _ecommerce_rate_limits').map((item) => item.key);
  assert.ok(keys.every((key) => key.startsWith('gift-card-claim:') && !key.includes('2001:db8')));
});

test('the scheduled job reads due emails through the index of pending emails, not the whole log', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.method(console, 'warn', () => {});
  const store = shop();
  for (let index = 0; index < 3; index++) await paidOrder(store);
  store.EMAIL.failures.push('E_RATE_LIMIT_EXCEEDED');
  await paidOrder(store);
  t.mock.timers.tick(10 * 60 * 1000);
  store.recorded.length = 0;
  assert.equal((await deliverPendingCommerceEmails({ env: store.env })).length, 1);
  const reads = store.recorded.filter(([sql]) => /FROM _ecommerce_email_deliveries\s+WHERE status = 'pending'/.test(sql));
  assert.equal(reads.length, 2, 'the expiry pass and the due emails');
  for (const [sql, values] of reads) {
    const plan = rows(store.sqlite, `EXPLAIN QUERY PLAN ${sql}`, ...values).map((step) => step.detail).join(' | ');
    assert.match(plan, /USING INDEX _ecommerce_email_deliveries_due_idx/, plan);
  }
});

// --- Configuration and contracts -----------------------------------------------------------------

test('ecommercePlugin({ emailTemplates }) gives server code the module through a virtual module', () => {
  const load = (plugin) => {
    const vitePlugin = plugin.vite.plugins.find((item) => item.name === 'talisman-cms-ecommerce-email-templates');
    return vitePlugin.load(vitePlugin.resolveId('virtual:talisman-cms/ecommerce-emails'));
  };
  assert.equal(load(ecommercePlugin()), 'export const emailTemplates = null;');
  assert.equal(load(ecommercePlugin({ emailTemplates: '/site/src/lib/commerce-emails.ts' })),
    'export * as emailTemplates from "/site/src/lib/commerce-emails.ts";');
  assert.equal(load(ecommercePlugin({ emailTemplates: '@store/emails' })), 'export * as emailTemplates from "@store/emails";');
  assert.throws(() => ecommercePlugin({ emailTemplates: './src/lib/commerce-emails.ts' }), TypeError);
});

test('readGiftCardClaimToken reads the token from the fragment and removes it from the address bar', () => {
  const replaced = [];
  const history = { state: { page: 1 }, replaceState: (...args) => replaced.push(args) };
  const token = 'a'.repeat(64);
  assert.equal(readGiftCardClaimToken({ pathname: '/gift-cards/claim', search: '', hash: `#token=${token}` }, history), token);
  assert.deepEqual(replaced, [[{ page: 1 }, '', '/gift-cards/claim']]);
  assert.equal(readGiftCardClaimToken({ pathname: '/gift-cards/claim', search: `?token=${token}`, hash: '' }, history), null,
    'a token in the query string is not read: links never put it there');
});

test('claimGiftCardCode in the browser says whether a failed claim left the link usable', async (t) => {
  const token = 'a'.repeat(64);
  const answers = [[200, { code: 'GIFT-A', balanceCents: 5000, currency: 'usd' }], [400, { error: 'Used' }],
    [429, { error: 'Too many' }], [503, { error: 'Later' }], 'offline', [200, 'not json']];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push([url, init.method, JSON.parse(init.body)]);
    const answer = answers.shift();
    // A connection that fails never reaches the server, so the link is still unused.
    if (answer === 'offline') throw new TypeError('Failed to fetch');
    const [status, body] = answer;
    return typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status });
  });
  assert.deepEqual(await claimFromBrowser(token), { code: 'GIFT-A', balanceCents: 5000, currency: 'usd' });
  assert.deepEqual(requests[0], ['/api/ecommerce/gift-cards', 'POST', { action: 'claim', token }]);
  await assert.rejects(claimFromBrowser(token), { message: 'Used', status: 400, retryable: false });
  await assert.rejects(claimFromBrowser(token), { message: 'Too many', status: 429, retryable: true });
  await assert.rejects(claimFromBrowser(token), { message: 'Later', status: 503, retryable: true });
  await assert.rejects(claimFromBrowser(token), { message: 'The connection failed. Please try again.', status: 0, retryable: true });
  // An answer that cannot be read after the server used the link: trying again cannot show the code.
  await assert.rejects(claimFromBrowser(token), { message: 'The gift card code could not be shown.', status: 200, retryable: false });
});

test('the plugin schema only names email and claim link columns the migrations create', () => {
  const { sqlite } = database();
  for (const table of [schema.emailDeliveries, schema.giftCardClaims]) {
    const { name, columns } = getTableConfig(table);
    const created = new Set(sqlite.prepare('SELECT name FROM pragma_table_info(?)').all(name).map((column) => column.name));
    assert.ok(created.size, `${name} exists`);
    for (const column of columns) assert.ok(created.has(column.name), `${name}.${column.name} is declared but no migration creates it`);
  }
  sqlite.close();
});
