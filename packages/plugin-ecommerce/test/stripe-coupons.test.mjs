import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { bindCommerceApi, reconcileCommerce } from '../dist/api.js';
import { StripePaymentAdapter, checkoutCouponId } from '../dist/adapters/stripe.js';
import { createDiscountCode } from '../dist/promotions.js';

const migrationFiles = ['0004_ecommerce_plugin.sql', '0005_variant_value_images.sql', '0007_local_auth.sql',
  '0008_shared_components.sql', '0010_checkout_inventory.sql', '0011_order_payment_provider.sql',
  '0012_customer_accounts.sql', '0013_referrals_and_credit.sql', '0014_promotions.sql',
  '0015_gift_cards.sql', '0016_verified_customer_sessions.sql', '0017_commerce_fulfillment.sql',
  '0019_shared_customer_identity.sql', '0024_shopper_sign_in_tokens.sql', '0025_order_shipping_and_tax.sql',
  '0026_order_fulfillment_status.sql', '0027_gift_card_review.sql'];

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
    (id, name, slug, base_price, inventory_quantity, status, created_at, updated_at)
    VALUES ('frame', 'Frame', 'frame', 12000, 5, 'active', ?, ?)`).run(now, now);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, credit_balance, created_at, updated_at)
    VALUES ('shopper', 'shopper@example.com', 'shopper@example.com', 1000, ?, ?)`).run(now, now);
  return { sqlite, DB };
}

const checkout = { shippingAddress: { name: 'Test', line1: '1 Main St', city: 'Austin', postalCode: '78701', country: 'US' },
  successUrl: 'https://example.test/success?order={ORDER_ID}', cancelUrl: 'https://example.test/cancel?order={ORDER_ID}' };

/** A Stripe adapter whose client records calls; session status and coupon deletes can be scripted per test. */
function fakeStripe(overrides = {}) {
  const adapter = new StripePaymentAdapter({ secretKey: 'sk_test_fake', webhookSecret: 'whsec_fake' });
  const calls = [];
  const state = { sessionStatus: 'open', event: null, deleteError: null, ...overrides };
  adapter.stripe = {
    coupons: {
      async create(input, options) {
        calls.push({ type: 'coupon.create', input, options });
        if (state.onCouponCreate) await state.onCouponCreate(input);
        return { id: input.id };
      },
      async del(id) {
        calls.push({ type: 'coupon.del', id });
        if (state.deleteError) throw state.deleteError;
        return { id, deleted: true };
      },
    },
    checkout: { sessions: {
      async create(input, options) {
        calls.push({ type: 'session.create', input, options, at: Math.floor(Date.now() / 1000) });
        if (state.onSessionCreate) await state.onSessionCreate(input);
        return { id: `cs_${input.client_reference_id}`, url: 'https://checkout.stripe.test/pay' };
      },
      async expire(id) { calls.push({ type: 'session.expire', id }); return { id, status: 'expired' }; },
      async retrieve(id) {
        calls.push({ type: 'session.retrieve', id });
        return { id, status: state.sessionStatus, url: null, payment_status: 'unpaid' };
      },
    } },
    webhooks: { async constructEventAsync() { return state.event; } },
  };
  return { adapter, calls, state };
}

const deletes = (calls) => calls.filter((call) => call.type === 'coupon.del').map((call) => call.id);

async function discountedOrder(DB, adapter, browser = 'credit-browser') {
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [adapter] });
  const cart = await api.carts.getOrCreate(browser, 'shopper');
  await api.carts.updateItems(cart.id, [{ productId: 'frame', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, { ...checkout, customerEmail: 'shopper@example.com' });
  assert.equal(order.creditApplied, 1000);
  return { api, order };
}

test('a discounted Stripe checkout creates a single-use coupon that ends with its session', async () => {
  const { adapter, calls } = fakeStripe();
  await adapter.createCheckoutSession({
    orderId: 'ord_single', currency: 'usd', items: [{ name: 'Frames', priceCents: 12000, quantity: 1 }],
    creditApplied: 1000, discountApplied: 500, successUrl: 'https://example.test/success',
    cancelUrl: 'https://example.test/cancel'
  });
  const coupon = calls.find((call) => call.type === 'coupon.create');
  const session = calls.find((call) => call.type === 'session.create');
  assert.equal(coupon.input.id, 'ord_single_discount');
  assert.equal(coupon.input.id, checkoutCouponId('ord_single'));
  assert.equal(coupon.input.max_redemptions, 1);
  assert.equal(coupon.input.amount_off, 1500);
  assert.equal(coupon.input.duration, 'once');
  assert.equal(coupon.options.idempotencyKey, 'ord_single:discount');
  assert.ok(Number.isInteger(session.input.expires_at));
  assert.equal(coupon.input.redeem_by, session.input.expires_at);
  assert.deepEqual(session.input.discounts, [{ coupon: 'ord_single_discount' }]);

  calls.length = 0;
  await adapter.createCheckoutSession({
    orderId: 'ord_plain', currency: 'usd', items: [{ name: 'Frames', priceCents: 12000, quantity: 1 }],
    successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel'
  });
  assert.equal(calls.some((call) => call.type === 'coupon.create'), false);
  assert.equal(calls.find((call) => call.type === 'session.create').input.discounts, undefined);
});

test('a discounted session still expires at least 30 minutes after it is created when the coupon call is slow', async () => {
  const realNow = Date.now;
  const started = realNow();
  let clock = started;
  Date.now = () => clock;
  try {
    // The coupon request takes 45 seconds, including a retry.
    const { adapter, calls } = fakeStripe({ async onCouponCreate() { clock += 45_000; } });
    await adapter.createCheckoutSession({
      orderId: 'ord_slow', currency: 'usd', items: [{ name: 'Frames', priceCents: 12000, quantity: 1 }],
      creditApplied: 1000, successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel'
    });
    const coupon = calls.find((call) => call.type === 'coupon.create');
    const session = calls.find((call) => call.type === 'session.create');
    assert.ok(session.input.expires_at - session.at >= 30 * 60);
    assert.equal(coupon.input.redeem_by, session.input.expires_at);
    // It still ends well before a stale checkout preparation is released, 35 minutes after it started.
    assert.ok(session.input.expires_at < Math.floor(started / 1000) + 35 * 60);
  } finally {
    Date.now = realNow;
  }
});

test('checkout coupon ids accept only server order ids', () => {
  assert.equal(checkoutCouponId('ord_0f8fad5b-d9cb-469f-a165-70867728950e'),
    'ord_0f8fad5b-d9cb-469f-a165-70867728950e_discount');
  for (const orderId of ['', 'ord/1', 'ord 1', 'x'.repeat(121)]) {
    assert.throws(() => checkoutCouponId(orderId), /cannot name a checkout coupon/);
  }
});

test('discarding a checkout discount deletes its coupon and treats a missing coupon as done', async () => {
  const { adapter, calls, state } = fakeStripe();
  await adapter.discardCheckoutDiscount('ord_expired');
  assert.deepEqual(deletes(calls), ['ord_expired_discount']);
  state.deleteError = Object.assign(new Error('No such coupon'), { code: 'resource_missing', statusCode: 404 });
  await adapter.discardCheckoutDiscount('ord_expired');
  state.deleteError = Object.assign(new Error('Server error'), { statusCode: 500 });
  await assert.rejects(adapter.discardCheckoutDiscount('ord_expired'), /Server error/);
});

test('an expired discounted checkout deletes its coupon once, from the webhook', async () => {
  const { sqlite, DB } = database();
  const { adapter, calls, state } = fakeStripe();
  const { api, order } = await discountedOrder(DB, adapter);
  state.event = { type: 'checkout.session.expired', data: { object: {
    id: order.checkoutSessionId, metadata: { orderId: order.id } } } };
  await api.webhooks.handleStripe('{}', 'signature');
  await api.webhooks.handleStripe('{}', 'signature');
  assert.equal((await api.orders.find(order.id)).status, 'cancelled');
  assert.deepEqual(deletes(calls), [checkoutCouponId(order.id)]);
  sqlite.close();
});

test('reconciling an expired discounted checkout deletes its coupon once', async () => {
  const { sqlite, DB } = database();
  const { adapter, calls, state } = fakeStripe();
  const { api, order } = await discountedOrder(DB, adapter);
  state.sessionStatus = 'expired';
  assert.equal((await api.orders.reconcilePending(order.id)).status, 'cancelled');
  assert.equal(await api.orders.reconcilePending(order.id), null);
  assert.deepEqual(deletes(calls), [checkoutCouponId(order.id)]);
  sqlite.close();
});

test('a cancelled discounted checkout is expired first and then its coupon is deleted', async () => {
  const { sqlite, DB } = database();
  await createDiscountCode({ DB }, { code: 'SAVE500', description: null, type: 'amount', value: 500,
    maxDiscountCents: null, minOrderCents: 0, eligibleProductIds: [], maxUses: null, maxUsesPerCustomer: null,
    firstOrderOnly: false, startsAt: null, expiresAt: null, active: true });
  const { adapter, calls } = fakeStripe();
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [adapter] });
  const cart = await api.carts.getOrCreate('guest-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'frame', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, { ...checkout,
    customerEmail: 'guest@example.com', discountCode: 'SAVE500' });
  assert.equal(order.discountAmount, 500);
  await api.orders.cancel(order.id);
  await api.orders.cancel(order.id);
  const steps = calls.map((call) => call.type).filter((type) => type === 'session.expire' || type === 'coupon.del');
  assert.deepEqual(steps, ['session.expire', 'coupon.del']);
  assert.deepEqual(deletes(calls), [checkoutCouponId(order.id)]);
  sqlite.close();
});

test('an undiscounted checkout never deletes a coupon', async () => {
  const { sqlite, DB } = database();
  const { adapter, calls, state } = fakeStripe();
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [adapter] });
  const cart = await api.carts.getOrCreate('plain-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'frame', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, { ...checkout, customerEmail: 'guest@example.com' });
  state.event = { type: 'checkout.session.expired', data: { object: {
    id: order.checkoutSessionId, metadata: { orderId: order.id } } } };
  await api.webhooks.handleStripe('{}', 'signature');
  assert.equal((await api.orders.find(order.id)).status, 'cancelled');
  assert.deepEqual(deletes(calls), []);
  sqlite.close();
});

test('a failed coupon delete still cancels the order and releases its reservations', async () => {
  const { sqlite, DB } = database();
  const { adapter, calls, state } = fakeStripe();
  const { api, order } = await discountedOrder(DB, adapter);
  state.deleteError = Object.assign(new Error('Stripe is unavailable for shopper@example.com'), {
    type: 'StripeAPIError', statusCode: 500, code: 'api_error' });
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal((await api.orders.cancel(order.id)).status, 'cancelled');
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(deletes(calls), [checkoutCouponId(order.id)]);
  assert.equal(sqlite.prepare(`SELECT inventory_quantity FROM _ecommerce_products WHERE id = 'frame'`).get().inventory_quantity, 5);
  assert.equal(sqlite.prepare(`SELECT credit_balance FROM _ecommerce_customer_accounts WHERE id = 'shopper'`).get().credit_balance, 1000);
  assert.equal(warnings.length, 1);
  // The log carries codes only, never the provider's message.
  assert.deepEqual(warnings[0][1], { provider: 'stripe', name: 'Error', code: 'api_error' });
  assert.equal(JSON.stringify(warnings).includes('shopper@example.com'), false);
  sqlite.close();
});

test('stale discounted checkouts released by reconciliation delete their coupons', async () => {
  const { sqlite, DB } = database();
  const { adapter, calls, state } = fakeStripe();
  const { order } = await discountedOrder(DB, adapter);
  sqlite.prepare('UPDATE _ecommerce_orders SET created_at = created_at - 7200, updated_at = updated_at - 7200 WHERE id = ?').run(order.id);
  state.sessionStatus = 'expired';
  await reconcileCommerce({ env: { DB }, paymentAdapters: [adapter] });
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_orders WHERE id = ?').get(order.id).status, 'cancelled');
  assert.deepEqual(deletes(calls), [checkoutCouponId(order.id)]);
  sqlite.close();
});

test('a checkout that fails before its order is recorded expires the session and deletes the coupon', async () => {
  const { sqlite, DB } = database();
  const { adapter, calls, state } = fakeStripe({
    // Stock changes while the provider session is created, so the reservation batch is refused.
    async onSessionCreate() { sqlite.prepare(`UPDATE _ecommerce_products SET inventory_quantity = 0 WHERE id = 'frame'`).run(); }
  });
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [adapter] });
  const cart = await api.carts.getOrCreate('failing-browser', 'shopper');
  await api.carts.updateItems(cart.id, [{ productId: 'frame', quantity: 1 }]);
  await assert.rejects(api.orders.createFromCart(cart.id, { ...checkout, customerEmail: 'shopper@example.com' }),
    /Insufficient stock/);
  const created = calls.find((call) => call.type === 'coupon.create').input.id;
  const steps = calls.map((call) => call.type).filter((type) => type === 'session.expire' || type === 'coupon.del');
  assert.deepEqual(steps, ['session.expire', 'coupon.del']);
  assert.deepEqual(deletes(calls), [created]);
  assert.equal(sqlite.prepare('SELECT checkout_session_id FROM _ecommerce_carts WHERE id = ?').get(cart.id).checkout_session_id, null);

  // A session that could not be created leaves no open checkout, and its coupon is deleted too.
  sqlite.prepare(`UPDATE _ecommerce_products SET inventory_quantity = 5 WHERE id = 'frame'`).run();
  calls.length = 0;
  state.onSessionCreate = async () => { throw Object.assign(new Error('Session refused'), { statusCode: 400 }); };
  await assert.rejects(api.orders.createFromCart(cart.id, { ...checkout, customerEmail: 'shopper@example.com' }),
    /Session refused/);
  assert.deepEqual(calls.map((call) => call.type), ['coupon.create', 'session.create', 'coupon.del']);
  assert.equal(deletes(calls)[0], calls[0].input.id);

  // An undiscounted checkout that fails deletes nothing.
  sqlite.prepare(`UPDATE _ecommerce_customer_accounts SET credit_balance = 0 WHERE id = 'shopper'`).run();
  calls.length = 0;
  await assert.rejects(api.orders.createFromCart(cart.id, { ...checkout, customerEmail: 'shopper@example.com' }),
    /Session refused/);
  assert.deepEqual(deletes(calls), []);
  sqlite.close();
});

test('an expired checkout whose order was never recorded still deletes its coupon', async () => {
  const { sqlite, DB } = database();
  const { adapter, calls, state } = fakeStripe();
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [adapter] });
  state.event = { type: 'checkout.session.expired', data: { object: {
    id: 'cs_unrecorded', metadata: { orderId: 'ord_unrecorded' } } } };
  const result = await api.webhooks.handleStripe('{}', 'signature');
  assert.equal(result.cancelled, false);
  assert.deepEqual(deletes(calls), [checkoutCouponId('ord_unrecorded')]);
  sqlite.close();
});

test('a checkout whose session cannot be expired still deletes its coupon and keeps the basket locked', async () => {
  const { sqlite, DB } = database();
  const { adapter, calls } = fakeStripe({
    async onSessionCreate() { sqlite.prepare(`UPDATE _ecommerce_products SET inventory_quantity = 0 WHERE id = 'frame'`).run(); }
  });
  adapter.stripe.checkout.sessions.expire = async (id) => {
    calls.push({ type: 'session.expire', id });
    throw Object.assign(new Error('Stripe is unavailable'), { statusCode: 500 });
  };
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [adapter] });
  const cart = await api.carts.getOrCreate('stuck-browser', 'shopper');
  await api.carts.updateItems(cart.id, [{ productId: 'frame', quantity: 1 }]);
  await assert.rejects(api.orders.createFromCart(cart.id, { ...checkout, customerEmail: 'shopper@example.com' }),
    /Stripe is unavailable/);
  const created = calls.find((call) => call.type === 'coupon.create').input.id;
  assert.deepEqual(deletes(calls), [created]);
  // The session may still be open, so the basket stays locked until the preparation goes stale.
  assert.match(sqlite.prepare('SELECT checkout_session_id FROM _ecommerce_carts WHERE id = ?').get(cart.id).checkout_session_id,
    /^preparing:/);
  sqlite.close();
});
