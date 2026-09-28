import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { migrationSql } from './helpers/migrations.mjs';

// The routes read their bindings from cloudflare:workers and the admin route asks the CMS auth guard.
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
const { bindCommerceApi, reconcileCommerce: reconcileWithEmails, PARKED_CHECKOUT_MESSAGE } = await import('../dist/api.js');
// These tests leave email unconfigured, so the email retry pass reports the confirmations waiting for an
// email provider (see emails.test.mjs). Only that result is dropped; any other email result still counts.
const reconcileCommerce = async (...args) => (await reconcileWithEmails(...args))
  .filter((result) => !(result.id === 'commerce_emails' && /needs? an email provider/.test(result.error ?? '')));
const { StripePaymentAdapter } = await import('../dist/adapters/stripe.js');
const { runtimePaymentAdapters } = await import('../dist/runtime.js');
const { getPurchasedGiftCard, reconcileGiftCardPurchase, startGiftCardPurchase } = await import('../dist/gift-cards.js');
const { createDiscountCode } = await import('../dist/promotions.js');
const { CART_SESSION_COOKIE } = await import('../dist/cookies.js');
const schema = await import('../dist/schema.js');
const reconcileRoute = (await import('../dist/routes/ecommerce-admin-reconcile.js')).ALL;
const orderRoute = (await import('../dist/routes/ecommerce-order.js')).ALL;
const checkoutRoute = (await import('../dist/routes/ecommerce-checkout.js')).POST;

const ORIGIN = 'https://shop.test';
const STOCK = 20;
const migrationFiles = ['0004_ecommerce_plugin.sql', '0005_variant_value_images.sql', '0007_local_auth.sql',
  '0008_shared_components.sql', '0010_checkout_inventory.sql', '0011_order_payment_provider.sql',
  '0012_customer_accounts.sql', '0013_referrals_and_credit.sql', '0014_promotions.sql',
  '0015_gift_cards.sql', '0016_verified_customer_sessions.sql', '0017_commerce_fulfillment.sql',
  '0019_shared_customer_identity.sql', '0024_shopper_sign_in_tokens.sql', '0025_order_shipping_and_tax.sql',
  '0026_order_fulfillment_status.sql', '0027_gift_card_review.sql', '0028_provider_refunds_and_disputes.sql',
  '0029_commerce_reconcile_backoff.sql', '0030_commerce_order_emails.sql'];

/** An in-memory D1 stand-in. `recorded` collects every statement run, with its parameters. */
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of migrationFiles) {
    const sql = migrationSql(migration);
    sqlite.exec(sql.replaceAll('--> statement-breakpoint', ''));
  }
  const recorded = [];
  const DB = {
    prepare(sql) {
      const prepared = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async all() { recorded.push([sql, values]); return { results: prepared.all(...values) }; },
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
    (id, name, slug, base_price, inventory_quantity, status, created_at, updated_at) VALUES ('frame', 'Frame', 'frame', 12000, ?, 'active', ?, ?)`)
    .run(STOCK, now, now);
  return { sqlite, DB, recorded };
}

/** The Worker's settings: Stripe in `mode`, with keys of that mode, and a gift card key. */
const workerEnv = (DB, mode = 'test') => ({ DB, TALISMAN_COMMERCE_STRIPE_MODE: mode,
  STRIPE_SECRET_KEY: `sk_${mode}_reconcile`, STRIPE_WEBHOOK_SECRET: 'whsec_reconcile',
  TALISMAN_COMMERCE_GIFT_CARD_KEY: 'a'.repeat(64) });

const shippingAddress = { name: 'Test Shopper', line1: '1 Main St', city: 'Austin', postalCode: '78701', country: 'US' };

/** Checkout as a Stripe key of `prefix`'s mode creates it: the session id carries the mode. */
const checkoutAdapter = (prefix) => ({
  providerId: 'stripe',
  async createCheckoutSession({ orderId }) {
    return { providerSessionId: `${prefix}${orderId}`, url: `https://checkout.stripe.test/${orderId}` };
  },
  async expireCheckoutSession() {},
});

/** Places a pending Stripe order for one frame from its own basket. */
async function placeOrder(DB, browser, { prefix = 'cs_test_', discountCode } = {}) {
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [checkoutAdapter(prefix)] });
  const cart = await api.carts.getOrCreate(browser);
  await api.carts.updateItems(cart.id, [{ productId: 'frame', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, { customerEmail: 'shopper@example.test', shippingAddress,
    discountCode, providerId: 'stripe',
    successUrl: `${ORIGIN}/checkout/success?order={ORDER_ID}`, cancelUrl: `${ORIGIN}/checkout/cancel?order={ORDER_ID}` });
  return order;
}

/** Starts a pending gift card purchase, as the storefront does. */
async function startPurchase(DB, prefix = 'cs_test_') {
  return startGiftCardPurchase(workerEnv(DB), checkoutAdapter(prefix), { amountCents: 5000, buyerEmail: 'buyer@example.test' },
    { successUrl: `${ORIGIN}/gift-cards/success?purchase={PURCHASE_ID}`, cancelUrl: `${ORIGIN}/gift-cards` });
}

/** Moves a record's creation back, past reconciliation's 15 minute wait. */
function backdate(sqlite, table, id, seconds) {
  sqlite.prepare(`UPDATE ${table} SET created_at = created_at - ? WHERE id = ?`).run(seconds, id);
}

const OPEN = { status: 'open', url: 'https://checkout.stripe.test/open' };
const paid = (amountTotal, paymentIntentId) => ({ status: 'complete', paymentStatus: 'paid', amountTotal,
  currency: 'usd', paymentIntentId, url: null });
// Stripe errors as the SDK throws them.
const missingSession = () => Object.assign(new Error('No such checkout.session'),
  { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
const unreachable = () => Object.assign(new Error('An error occurred with our connection to Stripe.'),
  { type: 'StripeConnectionError' });

/**
 * Replaces the Stripe calls reconciliation and release make, for one test, and records each. `answers`
 * maps a session id to the lookup's answer, or to a function that returns or throws it. `refunds` and
 * `disputes` map a payment intent to how much of it Stripe reports refunded and whether a dispute over
 * it was lost ('none' unless set).
 */
function stubStripe(t, answers = new Map()) {
  const calls = [];
  const refunds = new Map();
  const disputes = new Map();
  const proto = StripePaymentAdapter.prototype;
  const original = { get: proto.getCheckoutSession, expire: proto.expireCheckoutSession,
    discard: proto.discardCheckoutDiscount, refunds: proto.getRefundStatus, disputes: proto.getDisputeStatus };
  proto.getCheckoutSession = async function (id) {
    calls.push(`get ${id}`);
    const answer = answers.get(id) ?? OPEN;
    return typeof answer === 'function' ? answer() : answer;
  };
  proto.expireCheckoutSession = async function (id) { calls.push(`expire ${id}`); };
  proto.discardCheckoutDiscount = async function (orderId) { calls.push(`discard ${orderId}`); };
  proto.getRefundStatus = async function (paymentIntentId) {
    calls.push(`refunds ${paymentIntentId}`);
    return refunds.get(paymentIntentId) ?? 'none';
  };
  proto.getDisputeStatus = async function (paymentIntentId) {
    calls.push(`disputes ${paymentIntentId}`);
    return disputes.get(paymentIntentId) ?? 'none';
  };
  t.after(() => {
    proto.getCheckoutSession = original.get;
    proto.expireCheckoutSession = original.expire;
    proto.discardCheckoutDiscount = original.discard;
    proto.getRefundStatus = original.refunds;
    proto.getDisputeStatus = original.disputes;
  });
  return { calls, answers, refunds, disputes };
}

/** Runs reconciliation the way the scheduled Worker does, with the Worker's own adapters. */
const reconcile = (DB, mode = 'test', limit) => reconcileCommerce(
  { env: workerEnv(DB, mode), paymentAdapters: runtimePaymentAdapters(workerEnv(DB, mode)) }, limit);

const outline = (results) => results.map((result) => [result.id, result.status, result.code ?? null, result.parked ?? false]);
const state = (sqlite, table, id) => ({ ...sqlite.prepare(`SELECT status, reconcile_attempts AS attempts,
  reconcile_last_error AS lastError, reconcile_review_at IS NOT NULL AS parked FROM ${table} WHERE id = ?`).get(id) });
const stock = (sqlite) => sqlite.prepare(`SELECT inventory_quantity FROM _ecommerce_products WHERE id = 'frame'`).get().inventory_quantity;
const sessionOf = (sqlite, purchaseId) => sqlite.prepare('SELECT provider_session_id FROM _ecommerce_gift_card_purchases WHERE id = ?')
  .get(purchaseId).provider_session_id;
/** The administrator decisions recorded so far, oldest first: the record, the action, what it was parked for, who and why. */
const decisions = (sqlite) => sqlite.prepare(`SELECT COALESCE(order_id, purchase_id) AS record, action, failure,
  payment_returned AS paymentReturned, admin_actor AS actor, reason FROM _ecommerce_reconcile_decisions ORDER BY created_at, rowid`)
  .all().map((row) => ({ ...row }));

/** The reason an administrator gives for a retry or release in these tests. */
const REASON = 'Checked the session in the Stripe dashboard';
/** The refusals an administrator sees for a completed checkout whose payment was not shown to be returned. */
const PAID_SESSION_REFUSAL = 'Stripe reports this checkout session as paid, and its payment as neither refunded in full '
  + 'nor lost to a dispute, so nothing was released. Refund the payment in full in Stripe first, or retry once the cause '
  + 'of the mismatch is fixed.';
const UNCHECKED_PAYMENT_REFUSAL = 'Stripe reports this checkout session as complete but names no payment the store '
  + 'can check for a refund, so nothing was released. If the payment was returned to the shopper, confirm that and '
  + 'release it again.';

/** Mocks Date only, so the test decides how much time passes between runs. */
function clock(t) {
  const start = Math.floor(Date.now() / 1000) * 1000;
  t.mock.timers.enable({ apis: ['Date'], now: start });
  return (seconds) => t.mock.timers.setTime(start + seconds * 1000);
}

/** An admin request to the reconciliation route. */
async function admin(DB, body, { mode = 'test', method = body === undefined ? 'GET' : 'POST' } = {}) {
  globalThis.cmsUser = { id: 'admin-1', email: 'admin@shop.test', role: 'admin' };
  globalThis.workerEnv = workerEnv(DB, mode);
  const request = new Request(`${ORIGIN}/admin/api/ecommerce/reconcile`, { method,
    headers: method === 'POST' ? { origin: ORIGIN, 'Content-Type': 'application/json' } : {},
    body: method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined });
  const response = await reconcileRoute({ request });
  return { status: response.status, json: await response.json() };
}

/** A shopper's request to the order route from the basket that placed the order. */
async function shopper(DB, order, browser, { method = 'GET', mode = 'test' } = {}) {
  globalThis.workerEnv = workerEnv(DB, mode);
  const cookies = { get: (name) => (name === CART_SESSION_COOKIE ? { value: browser } : undefined), set() {}, delete() {} };
  const request = method === 'GET'
    ? new Request(`${ORIGIN}/api/ecommerce/order?order=${encodeURIComponent(order.id)}`)
    : new Request(`${ORIGIN}/api/ecommerce/order`, { method, headers: { origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: order.id }) });
  const response = await orderRoute({ request, cookies });
  return { status: response.status, json: await response.json() };
}

/** Checkout again from the basket that placed a pending order, as the storefront's checkout form does. */
async function checkoutAgain(DB, browser, { mode = 'test' } = {}) {
  globalThis.workerEnv = { ...workerEnv(DB, mode), TALISMAN_COMMERCE_CHECKOUT_ENABLED: 'true' };
  const cookies = { get: (name) => (name === CART_SESSION_COOKIE ? { value: browser } : undefined), set() {}, delete() {} };
  const request = new Request(`${ORIGIN}/api/ecommerce/checkout`, { method: 'POST',
    headers: { origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerEmail: 'shopper@example.test', shippingAddress }) });
  const response = await checkoutRoute({ request, cookies });
  return { status: response.status, json: await response.json() };
}

/** Collects console output of one level for one test. */
function capture(t, level) {
  const lines = [];
  const original = console[level];
  console[level] = (...args) => lines.push(args);
  t.after(() => { console[level] = original; });
  return lines;
}

test('ten permanently failing orders do not stop an eleventh from being reconciled', async (t) => {
  const { sqlite, DB } = database();
  const { calls, answers } = stubStripe(t);
  const orders = [];
  for (let index = 0; index < 11; index++) orders.push(await placeOrder(DB, `browser-${index}`));
  // All are past the 15 minute wait, and the ten whose sessions Stripe no longer has are the oldest.
  orders.forEach((order, index) => backdate(sqlite, '_ecommerce_orders', order.id, 60 * 60 - index * 60));
  const stuck = orders.slice(0, 10);
  const missed = orders[10];
  for (const order of stuck) answers.set(order.checkoutSessionId, () => { throw missingSession(); });
  answers.set(missed.checkoutSessionId, paid(missed.totalAmount, `pi_${missed.id}`));

  // The first run reaches only the ten oldest. Each is parked and reported once.
  const first = await reconcile(DB);
  assert.deepEqual(outline(first), stuck.map((order) => [order.id, 'error', 'session_missing', true]));
  assert.ok(first.every((result) => result.error === 'The payment provider has no checkout session with this id'));
  // The next run skips them and settles the eleventh; nothing fails, so a scheduled run passes.
  assert.deepEqual(await reconcile(DB), [{ id: missed.id, status: 'paid' }]);
  assert.equal(state(sqlite, '_ecommerce_orders', missed.id).status, 'paid');
  // Parked orders are neither tried nor reported again, and Stripe is not asked about them.
  const asked = calls.length;
  assert.deepEqual(await reconcile(DB), []);
  assert.equal(calls.length, asked);
  assert.deepEqual(state(sqlite, '_ecommerce_orders', stuck[0].id),
    { status: 'pending', attempts: 1, lastError: 'session_missing', parked: 1 });
  assert.deepEqual(state(sqlite, '_ecommerce_orders', missed.id), { status: 'paid', attempts: 1, lastError: null, parked: 0 });
  // Their stock stays reserved until an administrator decides.
  assert.equal(stock(sqlite), STOCK - 11);
  sqlite.close();
});

test('a transient failure waits 2^attempts minutes, at most six hours, and never holds back other rows', async (t) => {
  const at = clock(t);
  const { sqlite, DB } = database();
  const { answers } = stubStripe(t);
  const flaky = await placeOrder(DB, 'flaky-browser');
  let outage = true;
  answers.set(flaky.checkoutSessionId, () => {
    if (outage) throw unreachable();
    return paid(flaky.totalAmount, `pi_${flaky.id}`);
  });
  const unavailable = [flaky.id, 'error', 'provider_unavailable', false];

  at(20 * 60);
  const [failed] = await reconcile(DB);
  assert.deepEqual(outline([failed]), [unavailable]);
  // Stripe's own message is not reported or stored.
  assert.equal(failed.error, 'The payment provider could not be reached; the check is retried later');
  assert.deepEqual(state(sqlite, '_ecommerce_orders', flaky.id),
    { status: 'pending', attempts: 1, lastError: 'provider_unavailable', parked: 0 });
  // Two minutes after the first attempt, then four after the second.
  at(20 * 60 + 119);
  assert.deepEqual(await reconcile(DB), []);
  at(20 * 60 + 120);
  assert.deepEqual(outline(await reconcile(DB)), [unavailable]);
  at(20 * 60 + 120 + 239);
  assert.deepEqual(await reconcile(DB), []);

  // A row never tried comes before one tried before, even in a batch of one.
  const fresh = await placeOrder(DB, 'fresh-browser');
  backdate(sqlite, '_ecommerce_orders', fresh.id, 30 * 60);
  at(20 * 60 + 120 + 240);
  assert.deepEqual(outline(await reconcile(DB, 'test', 1)), [[fresh.id, 'pending', null, false]]);
  outage = false;
  assert.deepEqual(await reconcile(DB, 'test', 1), [{ id: flaky.id, status: 'paid' }]);
  // A success clears the failure and counts as an attempt.
  assert.deepEqual(state(sqlite, '_ecommerce_orders', flaky.id), { status: 'paid', attempts: 3, lastError: null, parked: 0 });

  // However many attempts failed, a row waits at most six hours.
  sqlite.prepare(`UPDATE _ecommerce_orders SET reconcile_attempts = 70, reconcile_last_at = ? WHERE id = ?`)
    .run(Math.floor(Date.now() / 1000) - 6 * 60 * 60 + 1, fresh.id);
  assert.deepEqual(await reconcile(DB), []);
  sqlite.prepare(`UPDATE _ecommerce_orders SET reconcile_last_at = reconcile_last_at - 1 WHERE id = ?`).run(fresh.id);
  assert.deepEqual(outline(await reconcile(DB)), [[fresh.id, 'pending', null, false]]);
  sqlite.close();
});

test('missing configuration and other provider errors back off, and the provider\'s own text is never reported', async (t) => {
  const { sqlite, DB } = database();
  const { answers } = stubStripe(t);
  const refused = await placeOrder(DB, 'refused-browser');
  const unconfigured = await placeOrder(DB, 'unconfigured-browser');
  const queried = await placeOrder(DB, 'queried-browser');
  backdate(sqlite, '_ecommerce_orders', refused.id, 22 * 60);
  backdate(sqlite, '_ecommerce_orders', unconfigured.id, 21 * 60);
  backdate(sqlite, '_ecommerce_orders', queried.id, 20 * 60);
  answers.set(refused.checkoutSessionId, () => {
    throw Object.assign(new Error('Invalid string: shopper@example.test'),
      { type: 'StripeInvalidRequestError', statusCode: 400, code: 'parameter_invalid_string' });
  });
  // A failed Drizzle query names its parameters in its message; only its cause is reported.
  answers.set(queried.checkoutSessionId, () => {
    throw Object.assign(new Error('Failed query: select id from _ecommerce_customer_accounts where email = ?\nparams: shopper@example.test'),
      { query: 'select id from _ecommerce_customer_accounts where email = ?', params: ['shopper@example.test'],
        cause: new Error('D1_ERROR: database is locked') });
  });

  // A Worker without Stripe keys cannot check anything; the rows wait and are tried again.
  const withoutStripe = await reconcileCommerce({ env: { DB, TALISMAN_COMMERCE_STRIPE_MODE: 'test' }, paymentAdapters: [] });
  assert.deepEqual(outline(withoutStripe), [
    [refused.id, 'error', 'provider_not_configured', false],
    [unconfigured.id, 'error', 'provider_not_configured', false],
    [queried.id, 'error', 'provider_not_configured', false],
  ]);
  sqlite.prepare('UPDATE _ecommerce_orders SET reconcile_last_at = reconcile_last_at - 600').run();
  const results = await reconcile(DB);
  assert.deepEqual(outline(results), [[refused.id, 'error', 'failed', false], [unconfigured.id, 'pending', null, false],
    [queried.id, 'error', 'failed', false]]);
  assert.equal(results[0].error, 'The payment provider returned an error');
  assert.equal(results[2].error, 'D1_ERROR: database is locked');
  assert.equal(JSON.stringify([withoutStripe, results]).includes('@example.test'), false);
  assert.deepEqual(state(sqlite, '_ecommerce_orders', refused.id), { status: 'pending', attempts: 2, lastError: 'failed', parked: 0 });
  assert.deepEqual(state(sqlite, '_ecommerce_orders', unconfigured.id), { status: 'pending', attempts: 2, lastError: null, parked: 0 });
  sqlite.close();
});

test('a completed payment that does not match, and gift card purchases that cannot be settled, are parked once', async (t) => {
  const { sqlite, DB } = database();
  const { calls, answers } = stubStripe(t);
  const order = await placeOrder(DB, 'mismatch-browser');
  const purchase = await startPurchase(DB);
  const mismatched = await startPurchase(DB);
  backdate(sqlite, '_ecommerce_orders', order.id, 20 * 60);
  backdate(sqlite, '_ecommerce_gift_card_purchases', purchase.id, 21 * 60);
  backdate(sqlite, '_ecommerce_gift_card_purchases', mismatched.id, 20 * 60);
  answers.set(order.checkoutSessionId, paid(order.totalAmount - 100, `pi_${order.id}`));
  answers.set(sessionOf(sqlite, purchase.id), () => { throw missingSession(); });
  // Paid in full but without a payment intent: the card could never be refunded against it.
  answers.set(sessionOf(sqlite, mismatched.id), paid(5000, null));

  assert.deepEqual(outline(await reconcile(DB)), [
    [order.id, 'error', 'payment_mismatch', true],
    [purchase.id, 'error', 'session_missing', true],
    [mismatched.id, 'error', 'payment_mismatch', true],
  ]);
  assert.deepEqual(await reconcile(DB), []);
  assert.equal(state(sqlite, '_ecommerce_orders', order.id).status, 'pending');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_gift_cards').get().n, 0);

  // A parked purchase is shown as pending and under review, and its success page asks Stripe nothing.
  const asked = calls.length;
  assert.deepEqual(await reconcileGiftCardPurchase(workerEnv(DB), runtimePaymentAdapters(workerEnv(DB))[0], purchase.id),
    { status: 'pending', review: true });
  assert.equal(calls.length, asked);
  const shown = await getPurchasedGiftCard(workerEnv(DB), purchase.id, purchase.accessToken);
  assert.deepEqual([shown.status, shown.paymentUnderReview, shown.code], ['pending', true, null]);
  sqlite.close();
});

test('a session of the other Stripe mode is parked and released without any call to Stripe', async (t) => {
  t.after(() => { delete globalThis.cmsUser; delete globalThis.workerEnv; });
  const { sqlite, DB } = database();
  const { calls } = stubStripe(t);
  const released = capture(t, 'info');
  await createDiscountCode({ DB }, { code: 'SAVE500', description: null, type: 'amount', value: 500,
    maxDiscountCents: null, minOrderCents: 0, eligibleProductIds: [], maxUses: null, maxUsesPerCustomer: null,
    firstOrderOnly: false, startsAt: null, expiresAt: null, active: true });
  // Test-mode checkouts left pending when the store switched Stripe to live mode.
  const order = await placeOrder(DB, 'test-mode-browser', { discountCode: 'SAVE500' });
  const purchase = await startPurchase(DB);
  backdate(sqlite, '_ecommerce_orders', order.id, 20 * 60);
  backdate(sqlite, '_ecommerce_gift_card_purchases', purchase.id, 20 * 60);
  assert.equal(stock(sqlite), STOCK - 1);

  const results = await reconcile(DB, 'live');
  assert.deepEqual(outline(results), [
    [order.id, 'error', 'session_mode_mismatch', true],
    [purchase.id, 'error', 'session_mode_mismatch', true],
  ]);
  assert.equal(results[0].error, 'The checkout session is from Stripe test mode, and the store runs in live mode');

  const list = await admin(DB, undefined, { mode: 'live' });
  assert.equal(list.status, 200);
  assert.deepEqual([list.json.storeMode, list.json.parkedCount], ['live', 2]);
  // Longest parked first; these were parked in the same run.
  assert.deepEqual(list.json.parked.map((row) => [row.kind, row.id, row.sessionMode, row.otherMode, row.lastError, row.attempts,
    row.amountCents, row.currency]), [
    ['gift_card_purchase', purchase.id, 'test', true, 'session_mode_mismatch', 1, 5000, 'usd'],
    ['order', order.id, 'test', true, 'session_mode_mismatch', 1, order.totalAmount, 'usd'],
  ]);
  // The list names no session, email or address.
  assert.equal(JSON.stringify(list.json).includes('cs_test_'), false);
  assert.equal(JSON.stringify(list.json).includes('@example.test'), false);

  // A Worker without Stripe cannot show that its mode setting is right, so it releases nothing without asking.
  globalThis.workerEnv = { DB, TALISMAN_COMMERCE_STRIPE_MODE: 'live' };
  const release = (body) => reconcileRoute({ request: new Request(`${ORIGIN}/admin/api/ecommerce/reconcile`, { method: 'POST',
    headers: { origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const unconfigured = await release({ action: 'release', kind: 'order', id: order.id, reason: REASON });
  assert.deepEqual([unconfigured.status, (await unconfigured.json()).error],
    [409, 'Payment provider must expire the checkout session before stock can be released']);
  const unconfiguredPurchase = await release({ action: 'release', kind: 'gift_card_purchase', id: purchase.id, reason: REASON });
  assert.deepEqual([unconfiguredPurchase.status, (await unconfiguredPurchase.json()).error],
    [409, 'Stripe must be configured to check this checkout session before the purchase is released']);
  assert.equal(stock(sqlite), STOCK - 1);
  assert.deepEqual(decisions(sqlite), []);

  // This key cannot expire a test-mode session, which may still be paid until it expires 31 minutes after
  // the checkout started; the release waits until 35 minutes have passed.
  for (const [kind, id] of [['order', order.id], ['gift_card_purchase', purchase.id]]) {
    const early = await admin(DB, { action: 'release', kind, id, reason: REASON }, { mode: 'live' });
    assert.equal(early.status, 409);
    assert.match(early.json.error, /^Stripe cannot be asked about this checkout session, which may still be paid until it expires\. Release it after /);
  }
  assert.deepEqual([stock(sqlite), decisions(sqlite)], [STOCK - 1, []]);
  backdate(sqlite, '_ecommerce_orders', order.id, 16 * 60);
  backdate(sqlite, '_ecommerce_gift_card_purchases', purchase.id, 16 * 60);

  assert.deepEqual(await admin(DB, { action: 'release', kind: 'order', id: order.id, reason: REASON }, { mode: 'live' }),
    { status: 200, json: { result: { kind: 'order', id: order.id, status: 'cancelled', otherMode: true, paymentReturned: null } } });
  assert.deepEqual(await admin(DB, { action: 'release', kind: 'gift_card_purchase', id: purchase.id, reason: REASON }, { mode: 'live' }),
    { status: 200, json: { result: { kind: 'gift_card_purchase', id: purchase.id, status: 'cancelled', otherMode: true,
      paymentReturned: null } } });
  // No lookup, no expiry, and no coupon delete: the live key cannot reach test-mode objects.
  assert.deepEqual(calls, []);
  assert.equal(stock(sqlite), STOCK);
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_discount_redemptions WHERE order_id = ?').get(order.id).status, 'cancelled');
  assert.equal(sqlite.prepare('SELECT checkout_session_id FROM _ecommerce_carts WHERE id = ?').get(order.cartId).checkout_session_id, null);
  assert.equal(state(sqlite, '_ecommerce_gift_card_purchases', purchase.id).status, 'cancelled');
  // Each release is kept with the administrator, the reason and the failure it was parked with.
  assert.deepEqual(decisions(sqlite), [
    { record: order.id, action: 'release', failure: 'session_mode_mismatch', paymentReturned: null, actor: 'admin-1', reason: REASON },
    { record: purchase.id, action: 'release', failure: 'session_mode_mismatch', paymentReturned: null, actor: 'admin-1', reason: REASON },
  ]);
  assert.deepEqual(released.map(([message, details]) => [message, details]), [
    ['[commerce] Parked checkout released', { kind: 'order', id: order.id, actor: 'admin-1', otherMode: true }],
    ['[commerce] Parked checkout released', { kind: 'gift_card_purchase', id: purchase.id, actor: 'admin-1', otherMode: true }],
  ]);
  sqlite.close();
});

test('an administrator retries or releases parked records; a paid session is refused and stock returns once', async (t) => {
  t.after(() => { delete globalThis.cmsUser; delete globalThis.workerEnv; });
  const { sqlite, DB } = database();
  const { calls, answers } = stubStripe(t);
  const logged = capture(t, 'info');
  const [gone, charged, reopened] = [await placeOrder(DB, 'gone-browser'), await placeOrder(DB, 'charged-browser'),
    await placeOrder(DB, 'reopened-browser')];
  const purchase = await startPurchase(DB);
  for (const order of [gone, charged, reopened]) backdate(sqlite, '_ecommerce_orders', order.id, 20 * 60);
  backdate(sqlite, '_ecommerce_gift_card_purchases', purchase.id, 20 * 60);
  const purchaseSession = sqlite.prepare('SELECT provider_session_id FROM _ecommerce_gift_card_purchases WHERE id = ?')
    .get(purchase.id).provider_session_id;
  for (const id of [gone.checkoutSessionId, reopened.checkoutSessionId, purchaseSession]) {
    answers.set(id, () => { throw missingSession(); });
  }
  answers.set(charged.checkoutSessionId, paid(charged.totalAmount + 1, `pi_${charged.id}`));
  assert.equal((await reconcile(DB)).filter((result) => result.parked).length, 4);
  assert.equal(stock(sqlite), STOCK - 3);

  // Only an administrator sees or changes the list, and a change needs a same-origin request.
  globalThis.workerEnv = workerEnv(DB);
  delete globalThis.cmsUser;
  assert.equal((await reconcileRoute({ request: new Request(`${ORIGIN}/admin/api/ecommerce/reconcile`) })).status, 401);
  globalThis.cmsUser = { id: 'admin-1', role: 'admin' };
  assert.equal((await reconcileRoute({ request: new Request(`${ORIGIN}/admin/api/ecommerce/reconcile`, { method: 'POST',
    headers: { origin: 'https://elsewhere.test' }, body: JSON.stringify({ action: 'retry', kind: 'order', id: gone.id }) }) })).status, 403);
  const listed = await admin(DB);
  assert.deepEqual(listed.json.parked.map((row) => [row.id, row.lastError, row.problem, row.otherMode]), [
    [gone.id, 'session_missing', 'The payment provider has no checkout session with this id', false],
    [charged.id, 'payment_mismatch', 'The completed payment does not match the amount, currency or payment recorded for it', false],
    [reopened.id, 'session_missing', 'The payment provider has no checkout session with this id', false],
    [purchase.id, 'session_missing', 'The payment provider has no checkout session with this id', false],
  ].sort((a, b) => a[0] < b[0] ? -1 : 1));

  // Retry returns a record to reconciliation with its attempts reset; the next run checks it again.
  const restored = 'Stripe support restored the session';
  assert.deepEqual(await admin(DB, { action: 'retry', kind: 'order', id: gone.id, reason: restored }),
    { status: 200, json: { result: { kind: 'order', id: gone.id, status: 'pending' } } });
  assert.deepEqual(state(sqlite, '_ecommerce_orders', gone.id), { status: 'pending', attempts: 0, lastError: null, parked: 0 });
  // Who returned it is logged by user id, without personal data.
  assert.deepEqual(logged, [['[commerce] Parked checkout returned to reconciliation', { kind: 'order', id: gone.id, actor: 'admin-1' }]]);
  assert.equal((await admin(DB)).json.parkedCount, 3);
  assert.deepEqual((await admin(DB, { action: 'retry', kind: 'order', id: gone.id, reason: REASON })).status, 409);
  // Still missing, so the check parks it again, and reports it again.
  assert.deepEqual(outline(await reconcile(DB)), [[gone.id, 'error', 'session_missing', true]]);

  // A session Stripe no longer has may still be paid, for example in another Stripe account, until it
  // expires; its release waits until 35 minutes after the checkout started.
  const early = await admin(DB, { action: 'release', kind: 'order', id: gone.id, reason: REASON });
  assert.equal(early.status, 409);
  assert.match(early.json.error, /may still be paid until it expires/);
  assert.equal(stock(sqlite), STOCK - 3);
  backdate(sqlite, '_ecommerce_orders', gone.id, 16 * 60);
  backdate(sqlite, '_ecommerce_gift_card_purchases', purchase.id, 16 * 60);

  // Release asks Stripe first. A session Stripe no longer has counts as closed: the order is cancelled
  // and its stock returns, once.
  calls.length = 0;
  assert.equal((await admin(DB, { action: 'release', kind: 'order', id: gone.id, reason: REASON })).json.result.status, 'cancelled');
  assert.deepEqual(calls, [`get ${gone.checkoutSessionId}`]);
  assert.equal(stock(sqlite), STOCK - 2);
  assert.deepEqual(await admin(DB, { action: 'release', kind: 'order', id: gone.id, reason: REASON }),
    { status: 409, json: { error: 'This order is not pending and parked for review; reload the list' } });
  assert.equal(stock(sqlite), STOCK - 2);

  // A session Stripe reports as paid is not released while Stripe reports its payment kept.
  calls.length = 0;
  assert.deepEqual(await admin(DB, { action: 'release', kind: 'order', id: charged.id, reason: REASON }),
    { status: 409, json: { error: PAID_SESSION_REFUSAL } });
  assert.deepEqual(calls, [`get ${charged.checkoutSessionId}`, `refunds pi_${charged.id}`, `disputes pi_${charged.id}`]);
  assert.deepEqual(state(sqlite, '_ecommerce_orders', charged.id), { status: 'pending', attempts: 1, lastError: 'payment_mismatch', parked: 1 });
  assert.equal(stock(sqlite), STOCK - 2);

  // An open session is expired before its order is released.
  answers.set(reopened.checkoutSessionId, OPEN);
  calls.length = 0;
  assert.equal((await admin(DB, { action: 'release', kind: 'order', id: reopened.id, reason: REASON })).json.result.status, 'cancelled');
  assert.deepEqual(calls, [`get ${reopened.checkoutSessionId}`, `expire ${reopened.checkoutSessionId}`]);
  assert.equal(stock(sqlite), STOCK - 1);

  // A gift card purchase is cancelled the same way; Stripe can no longer take payment for it.
  calls.length = 0;
  assert.equal((await admin(DB, { action: 'release', kind: 'gift_card_purchase', id: purchase.id, reason: REASON })).json.result.status,
    'cancelled');
  assert.deepEqual(calls, [`get ${purchaseSession}`]);
  assert.equal(state(sqlite, '_ecommerce_gift_card_purchases', purchase.id).status, 'cancelled');

  // Invalid actions change nothing. Both actions name one record and need a reason; only a release
  // can confirm a returned payment.
  for (const body of [{ action: 'release', kind: 'basket', id: charged.id, reason: REASON },
    { action: 'release', kind: 'order', reason: REASON }, { action: 'retry', kind: 'order', id: charged.id, reason: REASON, extra: 1 },
    { action: 'retry', kind: 'order', id: charged.id }, { action: 'release', kind: 'order', id: charged.id, reason: '  short  ' },
    { action: 'retry', kind: 'order', id: charged.id, reason: REASON, confirmPaymentReturned: true },
    // Counted in characters, as the decision table counts them: four emoji are four characters, not eight.
    { action: 'retry', kind: 'order', id: charged.id, reason: '\u{1F4E6}'.repeat(4) },
    { action: 'retry', kind: 'order', id: charged.id, reason: 'x'.repeat(501) }]) {
    assert.deepEqual(await admin(DB, body), { status: 400, json: {
      error: 'Name the parked record (kind order or gift_card_purchase, and its id) and give a reason of 8 to 500 characters' } });
  }
  assert.deepEqual(await admin(DB, { action: 'archive', kind: 'order', id: charged.id, reason: REASON }),
    { status: 400, json: { error: 'Invalid reconciliation action' } });
  assert.equal(state(sqlite, '_ecommerce_orders', charged.id).parked, 1);
  // Every decision that changed a record is kept with the administrator and the reason; refusals are not.
  assert.deepEqual(decisions(sqlite), [
    { record: gone.id, action: 'retry', failure: 'session_missing', paymentReturned: null, actor: 'admin-1', reason: restored },
    { record: gone.id, action: 'release', failure: 'session_missing', paymentReturned: null, actor: 'admin-1', reason: REASON },
    { record: reopened.id, action: 'release', failure: 'session_missing', paymentReturned: null, actor: 'admin-1', reason: REASON },
    { record: purchase.id, action: 'release', failure: 'session_missing', paymentReturned: null, actor: 'admin-1', reason: REASON },
  ]);
  // A POST without an action still runs reconciliation; there is nothing left to try.
  assert.deepEqual(await admin(DB, {}), { status: 200, json: { results: [] } });
  assert.deepEqual(await admin(DB, undefined, { method: 'POST' }), { status: 200, json: { results: [] } });
  sqlite.close();
});

test('the order status and checkout routes never ask Stripe about a parked order and tell the shopper it is reviewed', async (t) => {
  const at = clock(t);
  t.after(() => { delete globalThis.workerEnv; });
  const { sqlite, DB } = database();
  const { calls, answers } = stubStripe(t);
  const warnings = capture(t, 'warn');
  const parked = await placeOrder(DB, 'parked-browser');
  const otherMode = await placeOrder(DB, 'other-mode-browser', { prefix: 'cs_live_' });
  answers.set(parked.checkoutSessionId, () => { throw missingSession(); });
  backdate(sqlite, '_ecommerce_orders', parked.id, 60);

  at(20 * 60);
  assert.deepEqual(outline(await reconcile(DB)), [
    [parked.id, 'error', 'session_missing', true],
    [otherMode.id, 'error', 'session_mode_mismatch', true],
  ]);
  sqlite.prepare('UPDATE _ecommerce_orders SET reconcile_review_at = NULL WHERE id = ?').run(otherMode.id);
  calls.length = 0;

  for (const seconds of [20 * 60 + 5, 20 * 60 + 30, 20 * 60 + 60]) {
    at(seconds);
    const read = await shopper(DB, parked, 'parked-browser');
    assert.deepEqual([read.status, read.json.status, read.json.paymentUnderReview], [200, 'pending', true]);
  }
  // A shopper cannot release it or check out again from its basket either; the store decides.
  assert.deepEqual(await shopper(DB, parked, 'parked-browser', { method: 'POST' }),
    { status: 409, json: { error: PARKED_CHECKOUT_MESSAGE } });
  assert.deepEqual(await checkoutAgain(DB, 'parked-browser'), { status: 409, json: { error: PARKED_CHECKOUT_MESSAGE } });
  assert.deepEqual(calls, []);
  // A parked order takes no provider-check slot.
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM _ecommerce_rate_limits WHERE key = ?`).get(`order-status:${parked.id}`).n, 0);

  // A check that fails before the order is parked answers with the stored status too, without asking
  // Stripe about a session of the other mode, and logs only the failure's code.
  const read = await shopper(DB, otherMode, 'other-mode-browser');
  assert.deepEqual([read.status, read.json.status, read.json.paymentUnderReview], [200, 'pending', false]);
  assert.deepEqual(calls, []);
  assert.deepEqual(warnings, [['[commerce] Order status check failed', { code: 'session_mode_mismatch' }]]);
  // Checking out again from its basket, once the order's provider-check slot is free, gets the review
  // answer rather than an error, and leaves parking and reporting to scheduled reconciliation.
  at(20 * 60 + 80);
  assert.deepEqual(await checkoutAgain(DB, 'other-mode-browser'), { status: 409, json: { error: PARKED_CHECKOUT_MESSAGE } });
  assert.deepEqual(calls, []);
  assert.deepEqual(state(sqlite, '_ecommerce_orders', otherMode.id),
    { status: 'pending', attempts: 1, lastError: 'session_mode_mismatch', parked: 0 });
  assert.equal(state(sqlite, '_ecommerce_orders', parked.id).status, 'pending');
  sqlite.close();
});

/** The query plan of a recorded statement, one line per step. */
function plan(sqlite, [sql, params]) {
  return sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((step) => step.detail).join('\n');
}

test('reconciliation, the parked list and checkout resume read through indexes', async (t) => {
  t.after(() => { delete globalThis.cmsUser; delete globalThis.workerEnv; });
  const { sqlite, DB, recorded } = database();
  stubStripe(t);
  const order = await placeOrder(DB, 'plan-browser');
  await startPurchase(DB);
  // A basket locked by a checkout that stopped before its order was recorded.
  const api = bindCommerceApi({ env: { DB } });
  const locked = await api.carts.getOrCreate('stopped-browser');
  sqlite.prepare(`UPDATE _ecommerce_carts SET checkout_session_id = 'preparing:ord_stopped', updated_at = ? WHERE id = ?`)
    .run(Math.floor(Date.now() / 1000) - 60 * 60, locked.id);
  recorded.length = 0;
  await reconcile(DB);
  const statement = (start) => {
    const found = recorded.find(([sql]) => sql.replace(/\s+/g, ' ').trim().startsWith(start));
    assert.ok(found, start);
    return found;
  };
  assert.match(plan(sqlite, statement('SELECT id FROM _ecommerce_carts WHERE checkout_session_id >=')),
    /SEARCH _ecommerce_carts USING INDEX _ecommerce_carts_checkout_session_id_unique \(checkout_session_id>\? AND checkout_session_id<\?\)/);
  assert.match(plan(sqlite, statement("SELECT id FROM _ecommerce_orders WHERE status = 'pending' AND created_at < ? AND reconcile_review_at")),
    /SEARCH _ecommerce_orders USING INDEX _ecommerce_orders_pending_idx \(created_at<\?\)/);
  assert.match(plan(sqlite, statement("SELECT id FROM _ecommerce_orders WHERE status = 'pending' AND payment_provider = 'admin_test'")),
    /SEARCH _ecommerce_orders USING INDEX _ecommerce_orders_pending_idx \(created_at<\?\)/);
  assert.match(plan(sqlite, statement('SELECT id FROM _ecommerce_gift_card_purchases')),
    /SEARCH _ecommerce_gift_card_purchases USING INDEX _ecommerce_gift_card_purchases_status_created_idx \(status=\? AND created_at<\?\)/);

  recorded.length = 0;
  await admin(DB);
  const listing = plan(sqlite, statement("SELECT 'order' AS kind"));
  assert.match(listing, /SCAN _ecommerce_orders USING INDEX _ecommerce_orders_pending_idx/);
  assert.match(listing, /SEARCH _ecommerce_gift_card_purchases USING INDEX _ecommerce_gift_card_purchases_status_created_idx \(status=\?\)/);

  // Checkout resume finds the basket's order by its checkout session.
  recorded.length = 0;
  await assert.rejects(bindCommerceApi({ env: { DB } }).orders.resumeFromCart(order.cartId), /Payment provider cannot reconcile checkout/);
  const lookup = recorded.find(([sql]) => /from "_ecommerce_orders" where "_ecommerce_orders"\."checkout_session_id" = \?/.test(sql));
  assert.ok(lookup);
  assert.match(plan(sqlite, lookup), /SEARCH _ecommerce_orders USING INDEX _ecommerce_orders_checkout_session_idx \(checkout_session_id=\?\)/);
  sqlite.close();
});

/** Resolves for every caller once `count` callers have arrived, so overlapping runs ask Stripe before either records an answer. */
function meeting(count) {
  let arrived = 0;
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return () => {
    if (++arrived === count) open();
    return opened;
  };
}

test('overlapping runs report a newly parked row once and never overwrite why it was parked', async (t) => {
  t.after(() => { delete globalThis.cmsUser; delete globalThis.workerEnv; });
  const { sqlite, DB } = database();
  const { answers } = stubStripe(t);
  const gone = await placeOrder(DB, 'overlap-gone-browser');
  const flaky = await placeOrder(DB, 'overlap-flaky-browser');
  backdate(sqlite, '_ecommerce_orders', gone.id, 21 * 60);
  backdate(sqlite, '_ecommerce_orders', flaky.id, 20 * 60);
  // Both runs find the first session missing.
  const goneMet = meeting(2);
  answers.set(gone.checkoutSessionId, async () => {
    await goneMet();
    throw missingSession();
  });
  // The run that asks first finds the second session missing; Stripe fails the other run's request for it.
  const flakyMet = meeting(2);
  let asked = 0;
  answers.set(flaky.checkoutSessionId, async () => {
    const first = ++asked === 1;
    await flakyMet();
    throw first ? missingSession() : unreachable();
  });

  // The scheduled run and an administrator's run overlap.
  const runs = await Promise.all([reconcile(DB), reconcile(DB)]);
  for (const order of [gone, flaky]) {
    const reported = runs.map((results) => outline(results.filter((result) => result.id === order.id))[0]);
    // The run that parks the row reports it; the other returns it as pending, without an error.
    assert.deepEqual(reported.sort(), [[order.id, 'error', 'session_missing', true], [order.id, 'pending', null, false]].sort());
    assert.deepEqual(state(sqlite, '_ecommerce_orders', order.id), { status: 'pending', attempts: 1, lastError: 'session_missing', parked: 1 });
  }
  assert.equal(runs.flat().filter((result) => result.status === 'error').length, 2);
  // The review list shows why each was parked.
  assert.deepEqual((await admin(DB)).json.parked.map((row) => [row.id, row.lastError]).sort(),
    [[gone.id, 'session_missing'], [flaky.id, 'session_missing']].sort());
  sqlite.close();
});

test('a shopper release of a checkout from the other Stripe mode asks Stripe nothing and gets the review answer', async (t) => {
  t.after(() => { delete globalThis.workerEnv; });
  const { sqlite, DB } = database();
  const { calls, answers } = stubStripe(t);
  // A test-mode checkout left pending when the store switched Stripe to live mode, not parked yet.
  const order = await placeOrder(DB, 'switched-browser');
  backdate(sqlite, '_ecommerce_orders', order.id, 5 * 60);
  // A live key cannot read it; Stripe would answer with text the shopper must not see.
  answers.set(order.checkoutSessionId, () => { throw missingSession(); });

  assert.deepEqual(await shopper(DB, order, 'switched-browser', { method: 'POST', mode: 'live' }),
    { status: 409, json: { error: PARKED_CHECKOUT_MESSAGE } });
  assert.deepEqual(calls, []);
  // It takes no provider-check slot, keeps its stock and waits for scheduled reconciliation to park it.
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM _ecommerce_rate_limits WHERE key = ?`).get(`order-status:${order.id}`).n, 0);
  assert.equal(stock(sqlite), STOCK - 1);
  assert.deepEqual(state(sqlite, '_ecommerce_orders', order.id), { status: 'pending', attempts: 0, lastError: null, parked: 0 });
  // In its own mode the shopper's release still asks Stripe and releases the basket.
  answers.set(order.checkoutSessionId, OPEN);
  assert.deepEqual(await shopper(DB, order, 'switched-browser', { method: 'POST' }),
    { status: 200, json: { orderId: order.id, status: 'cancelled' } });
  assert.deepEqual(calls, [`get ${order.checkoutSessionId}`, `expire ${order.checkoutSessionId}`]);
  assert.equal(stock(sqlite), STOCK);
  sqlite.close();
});

test('a Worker whose Stripe mode setting is missing backs off instead of parking checkouts of the other mode', async (t) => {
  const { sqlite, DB } = database();
  const { calls, answers } = stubStripe(t);
  const order = await placeOrder(DB, 'live-browser', { prefix: 'cs_live_' });
  const purchase = await startPurchase(DB, 'cs_live_');
  backdate(sqlite, '_ecommerce_orders', order.id, 21 * 60);
  backdate(sqlite, '_ecommerce_gift_card_purchases', purchase.id, 20 * 60);

  // Live keys are set, but the mode setting is missing: the Worker runs in test mode, without Stripe.
  const unset = { ...workerEnv(DB, 'live'), TALISMAN_COMMERCE_STRIPE_MODE: undefined };
  assert.deepEqual(runtimePaymentAdapters(unset), []);
  assert.deepEqual(outline(await reconcileCommerce({ env: unset, paymentAdapters: runtimePaymentAdapters(unset) })), [
    [order.id, 'error', 'provider_not_configured', false],
    [purchase.id, 'error', 'provider_not_configured', false],
  ]);
  assert.deepEqual(calls, []);

  // Once the setting is back, the next due run settles both.
  answers.set(order.checkoutSessionId, paid(order.totalAmount, `pi_${order.id}`));
  answers.set(sessionOf(sqlite, purchase.id), paid(5000, 'pi_gift_live'));
  sqlite.prepare('UPDATE _ecommerce_orders SET reconcile_last_at = reconcile_last_at - 120').run();
  sqlite.prepare('UPDATE _ecommerce_gift_card_purchases SET reconcile_last_at = reconcile_last_at - 120').run();
  assert.deepEqual(outline(await reconcile(DB, 'live')), [[order.id, 'paid', null, false], [purchase.id, 'paid', null, false]]);
  sqlite.close();
});

test('a paid checkout that does not match is released only once Stripe reports its payment refunded in full or lost to a dispute', async (t) => {
  t.after(() => { delete globalThis.cmsUser; delete globalThis.workerEnv; });
  const { sqlite, DB } = database();
  const { calls, answers, refunds, disputes } = stubStripe(t);
  const order = await placeOrder(DB, 'overcharged-browser');
  const purchase = await startPurchase(DB);
  backdate(sqlite, '_ecommerce_orders', order.id, 21 * 60);
  backdate(sqlite, '_ecommerce_gift_card_purchases', purchase.id, 20 * 60);
  const purchaseSession = sessionOf(sqlite, purchase.id);
  const [orderPayment, purchasePayment] = [`pi_${order.id}`, 'pi_gift_undercharged'];
  answers.set(order.checkoutSessionId, paid(order.totalAmount + 250, orderPayment));
  answers.set(purchaseSession, paid(4000, purchasePayment));
  assert.deepEqual(outline(await reconcile(DB)), [
    [order.id, 'error', 'payment_mismatch', true],
    [purchase.id, 'error', 'payment_mismatch', true],
  ]);
  const release = (kind, id, extra = {}) => admin(DB, { action: 'release', kind, id, reason: 'Refunded the payment in Stripe', ...extra });

  // Not refunded, refunded in part, or disputed without an outcome: Stripe reports the payment kept, so
  // nothing is released, an administrator's confirmation does not change that, and a completed session
  // is never expired.
  for (const [refunded, disputed] of [['none', 'none'], ['partial', 'none'], ['none', 'open']]) {
    for (const payment of [orderPayment, purchasePayment]) {
      refunds.set(payment, refunded);
      disputes.set(payment, disputed);
    }
    calls.length = 0;
    assert.deepEqual(await release('order', order.id), { status: 409, json: { error: PAID_SESSION_REFUSAL } });
    assert.deepEqual(await release('gift_card_purchase', purchase.id, { confirmPaymentReturned: true }),
      { status: 409, json: { error: PAID_SESSION_REFUSAL } });
    assert.deepEqual(calls, [`get ${order.checkoutSessionId}`, `refunds ${orderPayment}`, `disputes ${orderPayment}`,
      `get ${purchaseSession}`, `refunds ${purchasePayment}`, `disputes ${purchasePayment}`]);
  }
  assert.equal(stock(sqlite), STOCK - 1);
  assert.deepEqual(state(sqlite, '_ecommerce_orders', order.id), { status: 'pending', attempts: 1, lastError: 'payment_mismatch', parked: 1 });
  assert.deepEqual(state(sqlite, '_ecommerce_gift_card_purchases', purchase.id),
    { status: 'pending', attempts: 1, lastError: 'payment_mismatch', parked: 1 });
  assert.deepEqual(decisions(sqlite), []);

  // Refunded in full: the shopper has their money back, so the order's stock and basket return, once.
  refunds.set(orderPayment, 'full');
  calls.length = 0;
  assert.deepEqual(await release('order', order.id), { status: 200, json: { result: { kind: 'order', id: order.id,
    status: 'cancelled', otherMode: false, paymentReturned: 'refunded' } } });
  assert.deepEqual(calls, [`get ${order.checkoutSessionId}`, `refunds ${orderPayment}`]);
  assert.equal(stock(sqlite), STOCK);
  assert.equal(sqlite.prepare('SELECT checkout_session_id FROM _ecommerce_carts WHERE id = ?').get(order.cartId).checkout_session_id, null);
  assert.deepEqual(await release('order', order.id),
    { status: 409, json: { error: 'This order is not pending and parked for review; reload the list' } });
  assert.equal(stock(sqlite), STOCK);
  // Lost to a dispute: the card network took the payment back, so the purchase is cancelled and no card issued.
  disputes.set(purchasePayment, 'lost');
  calls.length = 0;
  assert.equal((await release('gift_card_purchase', purchase.id)).json.result.paymentReturned, 'dispute_lost');
  assert.deepEqual(calls, [`get ${purchaseSession}`, `refunds ${purchasePayment}`, `disputes ${purchasePayment}`]);
  assert.equal(state(sqlite, '_ecommerce_gift_card_purchases', purchase.id).status, 'cancelled');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_gift_cards').get().n, 0);
  assert.deepEqual(decisions(sqlite), [
    { record: order.id, action: 'release', failure: 'payment_mismatch', paymentReturned: 'refunded', actor: 'admin-1',
      reason: 'Refunded the payment in Stripe' },
    { record: purchase.id, action: 'release', failure: 'payment_mismatch', paymentReturned: 'dispute_lost', actor: 'admin-1',
      reason: 'Refunded the payment in Stripe' },
  ]);
  sqlite.close();
});

test('payments in another currency or without a payment intent park orders, and a parked gift card purchase is released only as Stripe allows', async (t) => {
  t.after(() => { delete globalThis.cmsUser; delete globalThis.workerEnv; });
  const { sqlite, DB } = database();
  const { calls, answers } = stubStripe(t);
  const foreign = await placeOrder(DB, 'foreign-browser');
  const unlinked = await placeOrder(DB, 'unlinked-browser');
  const opened = await startPurchase(DB);
  const completed = await startPurchase(DB);
  backdate(sqlite, '_ecommerce_orders', foreign.id, 21 * 60);
  backdate(sqlite, '_ecommerce_orders', unlinked.id, 20 * 60);
  backdate(sqlite, '_ecommerce_gift_card_purchases', opened.id, 21 * 60);
  backdate(sqlite, '_ecommerce_gift_card_purchases', completed.id, 20 * 60);
  answers.set(foreign.checkoutSessionId, { ...paid(foreign.totalAmount, `pi_${foreign.id}`), currency: 'eur' });
  answers.set(unlinked.checkoutSessionId, paid(unlinked.totalAmount, null));
  for (const purchase of [opened, completed]) answers.set(sessionOf(sqlite, purchase.id), () => { throw missingSession(); });
  assert.deepEqual(outline(await reconcile(DB)), [
    [foreign.id, 'error', 'payment_mismatch', true],
    [unlinked.id, 'error', 'payment_mismatch', true],
    [opened.id, 'error', 'session_missing', true],
    [completed.id, 'error', 'session_missing', true],
  ]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM _ecommerce_orders WHERE status = 'paid'").get().n, 0);
  const release = (kind, id, extra = {}) => admin(DB, { action: 'release', kind, id, reason: REASON, ...extra });

  // Stripe names no payment for this one, so it cannot report a refund: only the administrator's
  // confirmation that the payment was returned releases it, and that confirmation is recorded.
  calls.length = 0;
  assert.deepEqual(await release('order', unlinked.id), { status: 409, json: { error: UNCHECKED_PAYMENT_REFUSAL } });
  assert.deepEqual(calls, [`get ${unlinked.checkoutSessionId}`]);
  assert.equal((await release('order', unlinked.id, { confirmPaymentReturned: true })).json.result.paymentReturned, 'confirmed');
  assert.equal(stock(sqlite), STOCK - 1);

  // Stripe answers again for the purchases' sessions: a completed one stays pending and is never
  // expired, and an open one is expired before the purchase is cancelled.
  answers.set(sessionOf(sqlite, opened.id), OPEN);
  answers.set(sessionOf(sqlite, completed.id), paid(5000, 'pi_gift_completed'));
  calls.length = 0;
  assert.deepEqual(await release('gift_card_purchase', completed.id), { status: 409, json: { error: PAID_SESSION_REFUSAL } });
  assert.deepEqual(calls, [`get ${sessionOf(sqlite, completed.id)}`, 'refunds pi_gift_completed', 'disputes pi_gift_completed']);
  assert.deepEqual(state(sqlite, '_ecommerce_gift_card_purchases', completed.id),
    { status: 'pending', attempts: 1, lastError: 'session_missing', parked: 1 });
  calls.length = 0;
  assert.equal((await release('gift_card_purchase', opened.id)).json.result.status, 'cancelled');
  assert.deepEqual(calls, [`get ${sessionOf(sqlite, opened.id)}`, `expire ${sessionOf(sqlite, opened.id)}`]);
  assert.equal(state(sqlite, '_ecommerce_gift_card_purchases', opened.id).status, 'cancelled');
  assert.deepEqual(decisions(sqlite).map((decision) => [decision.record, decision.failure, decision.paymentReturned]), [
    [unlinked.id, 'payment_mismatch', 'confirmed'],
    [opened.id, 'session_missing', null],
  ]);
  sqlite.close();
});

test('only the session lookup parks a row as missing: a 404 later in the attempt backs off', async (t) => {
  const { sqlite, DB } = database();
  const { answers } = stubStripe(t);
  const order = await placeOrder(DB, 'later-404-browser');
  backdate(sqlite, '_ecommerce_orders', order.id, 20 * 60);
  answers.set(order.checkoutSessionId, paid(order.totalAmount, `pi_${order.id}`));
  // A provider call made while the payment is recorded, such as a tax record, answers 404 once.
  const batch = DB.batch;
  DB.batch = async () => {
    DB.batch = batch;
    throw Object.assign(new Error('No such tax calculation'), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
  };

  const [failed] = await reconcile(DB);
  assert.deepEqual(outline([failed]), [[order.id, 'error', 'failed', false]]);
  assert.equal(failed.error, 'The payment provider returned an error');
  assert.deepEqual(state(sqlite, '_ecommerce_orders', order.id), { status: 'pending', attempts: 1, lastError: 'failed', parked: 0 });
  // It is tried again once its backoff has passed, and settles.
  sqlite.prepare('UPDATE _ecommerce_orders SET reconcile_last_at = reconcile_last_at - 120 WHERE id = ?').run(order.id);
  assert.deepEqual(await reconcile(DB), [{ id: order.id, status: 'paid' }]);
  sqlite.close();
});

test('the plugin schema names only reconciliation columns the migrations create', () => {
  const { sqlite } = database();
  for (const table of [schema.orders, schema.giftCardPurchases, schema.reconcileDecisions, schema.taxReversals]) {
    const { name, columns } = getTableConfig(table);
    const created = new Set(sqlite.prepare('SELECT name FROM pragma_table_info(?)').all(name).map((column) => column.name));
    for (const column of columns) assert.ok(created.has(column.name), `${name}.${column.name} is declared but no migration creates it`);
  }
  sqlite.close();
});
