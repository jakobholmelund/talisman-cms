import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { bindCommerceApi, reconcileCommerce } from '../dist/api.js';
import { activateNewCustomer, consumeCustomerEmailSignIn, findCustomerSession,
  listCustomerOrders, requestCustomerEmailSignIn, revokeCustomerSession } from '../dist/accounts.js';
import { AdminTestPaymentAdapter } from '../dist/adapters/admin-test.js';
import { getOrCreateReferralCode, getReferralDashboard, referralPolicy, releaseReferralAwards } from '../dist/referrals.js';
import { createDiscountCode, updateDiscountCode, evaluateDiscountCode,
  saveReferralSettings, setReferralCodeActive, getPromotionsAdmin } from '../dist/promotions.js';
import { issueAdminGiftCard, evaluateGiftCard, getGiftCardBalance, startGiftCardPurchase,
  confirmGiftCardPurchase, getPurchasedGiftCard, recordGiftCardPurchaseRefund,
  refundGiftCardTender, refundGiftCardOnlyOrder, reconcileGiftCardPurchase } from '../dist/gift-cards.js';
import { fulfillCommerceOrder, listCommerceOrdersAdmin } from '../dist/fulfillment.js';

const giftEnv = (DB) => ({ DB, TALISMAN_COMMERCE_GIFT_CARD_KEY: 'a'.repeat(64) });
const migrationFiles = ['0004_ecommerce_plugin.sql', '0005_variant_value_images.sql', '0007_local_auth.sql',
  '0008_shared_components.sql', '0010_checkout_inventory.sql', '0011_order_payment_provider.sql',
  '0012_customer_accounts.sql', '0013_referrals_and_credit.sql', '0014_promotions.sql',
  '0015_gift_cards.sql', '0016_verified_customer_sessions.sql', '0017_commerce_fulfillment.sql',
  '0019_shared_customer_identity.sql', '0024_shopper_sign_in_tokens.sql', '0025_order_shipping_and_tax.sql',
  '0026_order_fulfillment_status.sql', '0027_gift_card_review.sql', '0028_provider_refunds_and_disputes.sql',
  '0029_commerce_reconcile_backoff.sql'];

function database(migrationCount = migrationFiles.length) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of migrationFiles.slice(0, migrationCount)) {
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
  return { sqlite, DB };
}

test('the sign-in migration revokes basket-granted sessions without verified email', () => {
  const { sqlite } = database(migrationFiles.indexOf('0016_verified_customer_sessions.sql'));
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id,email,email_normalized,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run('unverified', 'u@example.test', 'u@example.test', null, now, now);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id,email,email_normalized,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run('verified', 'v@example.test', 'v@example.test', now, now, now);
  for (const account of ['unverified', 'verified']) {
    sqlite.prepare(`INSERT INTO _ecommerce_customer_sessions
      (id,account_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)`)
      .run(account, account, account, now + 3600, now);
  }
  sqlite.exec(readFileSync(new URL('../../talisman-cms/drizzle/0016_verified_customer_sessions.sql', import.meta.url), 'utf8')
    .replaceAll('--> statement-breakpoint', ''));
  assert.ok(sqlite.prepare(`SELECT revoked_at FROM _ecommerce_customer_sessions WHERE id = 'unverified'`).get().revoked_at);
  assert.equal(sqlite.prepare(`SELECT revoked_at FROM _ecommerce_customer_sessions WHERE id = 'verified'`).get().revoked_at, null);
  sqlite.close();
});

/** Referral awards are released by the scheduled job once the hold has passed and no dispute is open. */
function releaseAfterHold(DB) {
  return releaseReferralAwards({ env: { DB }, paymentAdapters: [{ providerId: 'stripe',
    async getDisputeStatus() { return 'none'; } }] }, { now: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000) });
}

function seed(sqlite, lensQuantity = 2) {
  const now = Math.floor(Date.now() / 1000);
  for (const [id, name] of [['mycelium', 'Mycelium'], ['forrest', 'Forrest Floor']]) {
    sqlite.prepare(`INSERT INTO _ecommerce_products
      (id, name, slug, sku, base_price, inventory_quantity, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 12000, 0, 'active', ?, ?)`).run(id, name, id, `TAL-F-${id}`, now, now);
    sqlite.prepare(`INSERT INTO _ecommerce_product_variants
      (id, product_id, name, created_at, updated_at) VALUES (?, ?, 'Lens', ?, ?)`)
      .run(`${id}-group`, id, now, now);
    sqlite.prepare(`INSERT INTO _ecommerce_product_variant_values
      (id, product_variant_id, value, sku, created_at, updated_at)
      VALUES (?, ?, 'Golden Hour', ?, ?, ?)`)
      .run(`${id}-amber`, `${id}-group`, `TAL-${id}-AMB`, now, now);
    sqlite.prepare(`INSERT INTO _ecommerce_components
      (id, sku, name, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`${id}-frame`, `FRAME-${id}`, `${name} frame`, 2, now, now);
  }
  sqlite.prepare(`INSERT INTO _ecommerce_components
    (id, sku, name, quantity, created_at, updated_at) VALUES ('amber-lens', 'LENS-AMB', 'Amber lens pair', ?, ?, ?)`)
    .run(lensQuantity, now, now);
  for (const id of ['mycelium', 'forrest']) {
    for (const component of [`${id}-frame`, 'amber-lens']) {
      sqlite.prepare(`INSERT INTO _ecommerce_variant_components
        (id, product_variant_value_id, component_id, quantity, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)`)
        .run(`${id}-${component}`, `${id}-amber`, component, now, now);
    }
  }
}

function shop(DB) {
  const adapter = {
    providerId: 'test',
    async createCheckoutSession({ orderId }) {
      return { providerSessionId: `session-${orderId}`, url: `https://example.test/${orderId}` };
    },
    async expireCheckoutSession() {}
  };
  return bindCommerceApi({ env: { DB }, paymentAdapters: [adapter] });
}

const address = { shippingAddress: { name: 'Test', line1: '1 Main St', city: 'Austin', postalCode: '78701', country: 'US' }, customerEmail: 'test@example.com', successUrl: 'https://example.test/success?order={ORDER_ID}', cancelUrl: 'https://example.test/cancel?order={ORDER_ID}' };

test('two frame models consume a shared lens pool and release it once on cancellation', async () => {
  const { sqlite, DB } = database();
  seed(sqlite);
  const api = shop(DB);
  const firstCart = await api.carts.getOrCreate('first');
  await api.carts.updateItems(firstCart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const first = await api.orders.createFromCart(firstCart.id, address);
  const secondCart = await api.carts.getOrCreate('second');
  await api.carts.updateItems(secondCart.id, [{ productId: 'forrest', variantId: 'forrest-amber', quantity: 1 }]);
  const second = await api.orders.createFromCart(secondCart.id, address);
  assert.equal(sqlite.prepare(`SELECT quantity FROM _ecommerce_components WHERE id = 'amber-lens'`).get().quantity, 0);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_component_reservations`).get().count, 4);

  const thirdCart = await api.carts.getOrCreate('third');
  await api.carts.updateItems(thirdCart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  await assert.rejects(api.orders.createFromCart(thirdCart.id, address), /Insufficient stock/);
  await api.orders.cancel(first.order.id);
  await api.orders.cancel(first.order.id);
  assert.equal(sqlite.prepare(`SELECT quantity FROM _ecommerce_components WHERE id = 'amber-lens'`).get().quantity, 1);
  const replacementCart = await api.carts.getOrCreate('first');
  assert.equal(replacementCart.id, firstCart.id);

  await api.orders.finalizePayment(second.order.id, {
    provider: 'test', providerId: second.order.checkoutSessionId,
    paymentStatus: 'success', amount: second.order.totalAmount
  });
  await api.orders.finalizePayment(second.order.id, {
    provider: 'test', providerId: second.order.checkoutSessionId,
    paymentStatus: 'success', amount: second.order.totalAmount
  });
  assert.equal(sqlite.prepare(`SELECT quantity FROM _ecommerce_components WHERE id = 'amber-lens'`).get().quantity, 1);
  assert.equal(sqlite.prepare(`SELECT quantity FROM _ecommerce_components WHERE id = 'forrest-frame'`).get().quantity, 1);
  sqlite.close();
});

test('an expired checkout releases its reserved components', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 1);
  let event;
  const adapter = {
    providerId: 'stripe',
    async createCheckoutSession({ orderId }) {
      return { providerSessionId: `session-${orderId}`, url: 'https://example.test/pay' };
    },
    async expireCheckoutSession() {},
    async validateWebhook() { return event; }
  };
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [adapter] });
  const cart = await api.carts.getOrCreate('expiry');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, address);
  event = { type: 'checkout.session.expired', data: { id: order.checkoutSessionId, metadata: { orderId: order.id } } };
  await api.webhooks.handleStripe('', '', 'secret');
  await api.webhooks.handleStripe('', '', 'secret');
  assert.equal(sqlite.prepare(`SELECT quantity FROM _ecommerce_components WHERE id = 'amber-lens'`).get().quantity, 1);
  assert.equal((await api.orders.find(order.id)).status, 'cancelled');
  sqlite.close();
});

test('a stock change between preview and reservation rolls back the order', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 1);
  const adapter = {
    providerId: 'test',
    async createCheckoutSession({ orderId }) {
      sqlite.prepare(`UPDATE _ecommerce_components SET quantity = 0 WHERE id = 'amber-lens'`).run();
      return { providerSessionId: `session-${orderId}`, url: 'https://example.test/pay' };
    },
    async expireCheckoutSession() {}
  };
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [adapter] });
  const cart = await api.carts.getOrCreate('race');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  await assert.rejects(api.orders.createFromCart(cart.id, address), /Insufficient stock/);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_orders`).get().count, 0);
  assert.equal(sqlite.prepare(`SELECT quantity FROM _ecommerce_components WHERE id = 'mycelium-frame'`).get().quantity, 2);
  sqlite.close();
});

test('a mixed cart checks the total demand for a shared component', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 1);
  const api = shop(DB);
  const cart = await api.carts.getOrCreate('mixed');
  await api.carts.updateItems(cart.id, [
    { productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 },
    { productId: 'forrest', variantId: 'forrest-amber', quantity: 1 }
  ]);
  await assert.rejects(api.orders.createFromCart(cart.id, address), /Insufficient stock for component Amber lens pair/);
  assert.equal(sqlite.prepare(`SELECT quantity FROM _ecommerce_components WHERE id = 'amber-lens'`).get().quantity, 1);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_orders`).get().count, 0);
  sqlite.close();
});

test('a variant without a bill of materials retains dedicated stock behavior', async () => {
  const { sqlite, DB } = database();
  seed(sqlite);
  sqlite.prepare(`DELETE FROM _ecommerce_variant_components WHERE product_variant_value_id = 'mycelium-amber'`).run();
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_stocks
    (id, product_variant_value_id, quantity, created_at, updated_at)
    VALUES ('stock-mycelium', 'mycelium-amber', 1, ?, ?)`).run(now, now);
  const api = shop(DB);
  const cart = await api.carts.getOrCreate('legacy');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, address);
  assert.equal(sqlite.prepare(`SELECT quantity FROM _ecommerce_stocks WHERE id = 'stock-mycelium'`).get().quantity, 0);
  await api.orders.finalizePayment(order.id, {
    provider: 'test', providerId: order.checkoutSessionId,
    paymentStatus: 'success', amount: order.totalAmount
  });
  assert.equal(sqlite.prepare(`SELECT quantity FROM _ecommerce_stocks WHERE id = 'stock-mycelium'`).get().quantity, 0);
  assert.equal(sqlite.prepare(`SELECT quantity FROM _ecommerce_components WHERE id = 'amber-lens'`).get().quantity, 2);
  sqlite.close();
});

test('a persisted cart locks before the provider call and can resume its payment session', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 1);
  let releaseProvider;
  const providerStarted = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  let continueProvider;
  const providerWait = new Promise((resolve) => { continueProvider = resolve; });
  const adapter = {
    providerId: 'test',
    async createCheckoutSession({ orderId }) {
      releaseProvider();
      await providerWait;
      return { providerSessionId: `session-${orderId}`, url: `https://example.test/${orderId}` };
    },
    async getCheckoutSession() { return { status: 'open', url: 'https://example.test/resume' }; },
    async expireCheckoutSession() {}
  };
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [adapter] });
  const cart = await api.carts.getOrCreate('returning-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const checkout = api.orders.createFromCart(cart.id, address);
  await providerStarted;
  await assert.rejects(api.carts.updateItems(cart.id, []), /Checkout already started/);
  assert.equal((await api.carts.getOrCreate('returning-browser')).id, cart.id);
  continueProvider();
  const { order } = await checkout;
  assert.equal((await api.orders.resumeFromCart(cart.id)).paymentUrl, 'https://example.test/resume');
  assert.equal((await api.orders.findForSession(order.id, 'returning-browser')).id, order.id);
  assert.equal(await api.orders.findForSession(order.id, 'different-browser'), null);
  await api.orders.cancel(order.id);
  assert.equal((await api.carts.getOrCreate('returning-browser')).id, cart.id);
  assert.equal((await api.carts.find('returning-browser')).items.length, 1);
  sqlite.close();
});

test('provider failure unlocks the persisted cart without creating an order', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 1);
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [{
    providerId: 'test',
    async createCheckoutSession() { throw new Error('Provider unavailable'); },
    async expireCheckoutSession() {}
  }] });
  const cart = await api.carts.getOrCreate('retry-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  await assert.rejects(api.orders.createFromCart(cart.id, address), /Provider unavailable/);
  assert.equal((await api.carts.find('retry-browser')).checkoutSessionId, null);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_orders').get().count, 0);
  assert.equal(sqlite.prepare("SELECT quantity FROM _ecommerce_components WHERE id = 'amber-lens'").get().quantity, 1);
  sqlite.close();
});

test('a stale preparation lock is released only after its possible payment session has expired', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 1);
  const api = shop(DB);
  const cart = await api.carts.getOrCreate('orphan-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  sqlite.prepare(`UPDATE _ecommerce_carts SET checkout_session_id = 'preparing:orphan', updated_at = ? WHERE id = ?`)
    .run(Math.floor(Date.now() / 1000) - 34 * 60, cart.id);
  await api.orders.resumeFromCart(cart.id);
  assert.equal((await api.carts.find('orphan-browser')).checkoutSessionId, 'preparing:orphan');
  sqlite.prepare(`UPDATE _ecommerce_carts SET updated_at = ? WHERE id = ?`)
    .run(Math.floor(Date.now() / 1000) - 36 * 60, cart.id);
  await reconcileCommerce({ env: { DB }, paymentAdapters: [] });
  assert.equal((await api.carts.find('orphan-browser')).checkoutSessionId, null);
  sqlite.close();
});

test('reconciliation records a completed Stripe payment when its webhook was missed', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 1);
  const adapter = {
    providerId: 'stripe',
    async createCheckoutSession({ orderId }) {
      return { providerSessionId: `session-${orderId}`, url: 'https://example.test/pay' };
    },
    async expireCheckoutSession() {},
    async getCheckoutSession() {
      return { status: 'complete', url: null, paymentStatus: 'paid', amountTotal: 12000,
        currency: 'usd', paymentIntentId: 'pi-recovered', customerEmail: address.customerEmail };
    }
  };
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [adapter] });
  const cart = await api.carts.getOrCreate('recovered-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, { ...address, providerId: 'stripe' });
  assert.equal((await api.orders.reconcilePending(order.id)).status, 'paid');
  assert.equal((await api.orders.find(order.id)).paymentIntentId, 'pi-recovered');
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_payments WHERE order_id = ?`).get(order.id).count, 1);
  assert.equal(await api.orders.reconcilePending(order.id), null);
  sqlite.close();
});

test('dedicated stock is held at checkout and returned on cancellation', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 1);
  sqlite.prepare("DELETE FROM _ecommerce_variant_components WHERE product_variant_value_id = 'mycelium-amber'").run();
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_stocks
    (id, product_variant_value_id, quantity, created_at, updated_at)
    VALUES ('mycelium-stock', 'mycelium-amber', 1, ?, ?)`).run(now, now);
  const api = shop(DB);
  const cart = await api.carts.getOrCreate('stock-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, address);
  assert.equal(sqlite.prepare("SELECT quantity FROM _ecommerce_stocks WHERE id = 'mycelium-stock'").get().quantity, 0);
  await api.orders.cancel(order.id);
  await api.orders.cancel(order.id);
  assert.equal(sqlite.prepare("SELECT quantity FROM _ecommerce_stocks WHERE id = 'mycelium-stock'").get().quantity, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_inventory_reservations WHERE released_at IS NOT NULL').get().count, 1);
  sqlite.close();
});

test('duplicate paid webhooks record one payment and retain the reservation', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 1);
  let event;
  const adapter = {
    providerId: 'stripe',
    async createCheckoutSession({ orderId }) { return { providerSessionId: `session-${orderId}`, url: 'https://example.test/pay' }; },
    async expireCheckoutSession() {},
    async validateWebhook() { return event; }
  };
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [adapter] });
  const cart = await api.carts.getOrCreate('paid-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, address);
  event = { type: 'checkout.session.completed', data: {
    id: order.checkoutSessionId, metadata: { orderId: order.id }, payment_status: 'paid',
    amount_total: order.totalAmount, currency: 'usd'
  } };
  await api.webhooks.handleStripe('', '', 'secret');
  await api.webhooks.handleStripe('', '', 'secret');
  assert.equal((await api.orders.find(order.id)).status, 'paid');
  await assert.rejects(api.orders.finalizePayment(order.id, {
    provider: 'stripe', providerId: order.checkoutSessionId,
    paymentStatus: 'success', amount: order.totalAmount + 1, currency: 'usd'
  }), /amount does not match/);
  await api.orders.updateStatus(order.id, 'fulfilled', { actor: 'admin-1', carrier: 'USPS',
    trackingNumber: 'TRACK-1', note: 'Packed and shipped' });
  await api.webhooks.handleStripe('', '', 'secret');
  const shipped = await api.orders.find(order.id);
  assert.deepEqual([shipped.status, shipped.fulfillmentStatus], ['paid', 'fulfilled']);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_payments').get().count, 1);
  assert.equal(sqlite.prepare("SELECT quantity FROM _ecommerce_components WHERE id = 'amber-lens'").get().quantity, 0);
  assert.equal((await api.carts.getOrCreate('paid-browser')).items.length, 0);
  sqlite.close();
});

test('the admin test provider uses the common checkout flow without Stripe or stock consumption', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 1);
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [
    { providerId: 'stripe', async createCheckoutSession() { throw new Error('Stripe must not be called'); }, async expireCheckoutSession() {} },
    new AdminTestPaymentAdapter()
  ] });
  const cart = await api.carts.getOrCreate('admin-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, { ...address, providerId: 'admin_test' });
  assert.equal(order.paymentProvider, 'admin_test');
  assert.equal(sqlite.prepare("SELECT quantity FROM _ecommerce_components WHERE id = 'amber-lens'").get().quantity, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_component_reservations').get().count, 0);
  await assert.rejects(api.orders.finalizePayment(order.id, {
    provider: 'stripe', providerId: order.checkoutSessionId, paymentStatus: 'success', amount: order.totalAmount
  }), /provider or session/);
  await api.orders.finalizePayment(order.id, {
    provider: 'admin_test', providerId: order.checkoutSessionId,
    paymentStatus: 'success', amount: order.totalAmount, currency: order.currency
  });
  assert.equal((await api.orders.find(order.id)).status, 'paid');
  await assert.rejects(api.orders.updateStatus(order.id, 'fulfilled'), /Admin test orders cannot be fulfilled/);
  assert.equal(sqlite.prepare('SELECT provider FROM _ecommerce_payments').get().provider, 'admin_test');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_customer_accounts').get().count, 0);
  assert.equal((await api.carts.getOrCreate('admin-browser')).items.length, 0);
  assert.equal(sqlite.prepare("SELECT quantity FROM _ecommerce_components WHERE id = 'amber-lens'").get().quantity, 1);
  sqlite.close();
});

test('a real paid checkout requires email proof before granting an account session', async () => {
  const { sqlite, DB } = database();
  seed(sqlite);
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [{
    providerId: 'stripe',
    async createCheckoutSession({ orderId }) {
      return { providerSessionId: `session-${orderId}`, url: `https://example.test/${orderId}` };
    },
    async expireCheckoutSession() {}
  }] });
  const cart = await api.carts.getOrCreate('paid-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, { ...address, providerId: 'stripe' });
  await api.orders.finalizePayment(order.id, {
    provider: 'stripe', providerId: order.checkoutSessionId, paymentStatus: 'success',
    amount: order.totalAmount, currency: order.currency, customerEmail: 'invalid-provider-email'
  });
  const paid = await api.orders.find(order.id);
  assert.match(paid.userId, /^acct_ord_/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_customer_accounts').get().count, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_customer_sessions').get().count, 0);
  assert.equal(await activateNewCustomer({ DB }, order.id, 'paid-browser'), null);
  let link;
  await requestCustomerEmailSignIn({ DB }, address.customerEmail,
    token => `https://example.test/account/verify?token=${token}`,
    async (_to, value) => { link = value; });
  const token = new URL(link).searchParams.get('token');
  const activated = await consumeCustomerEmailSignIn({ DB }, token);
  assert.equal(activated.account.email, address.customerEmail);
  const identity = sqlite.prepare(`SELECT u.email, u.role FROM galaxy_auth_user u
    JOIN _ecommerce_customer_accounts c ON c.cms_user_id = u.id WHERE c.id = ?`).get(paid.userId);
  assert.equal(identity.email, address.customerEmail.toLowerCase());
  assert.equal(identity.role, 'customer');
  assert.equal((await findCustomerSession({ DB }, activated.token)).id, paid.userId);
  assert.equal(await consumeCustomerEmailSignIn({ DB }, token), null);
  let registrationLink;
  await requestCustomerEmailSignIn({ DB }, 'unknown@example.test',
    value => `https://example.test/account/verify?token=${value}`,
    async (_to, value) => { registrationLink = value; });
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_customer_accounts
    WHERE email_normalized = 'unknown@example.test'`).get().count, 0, 'the account waits for the link to be used');
  const registered = await consumeCustomerEmailSignIn({ DB }, new URL(registrationLink).searchParams.get('token'));
  assert.equal(registered.account.email, 'unknown@example.test');
  assert.ok(sqlite.prepare(`SELECT email_verified_at FROM _ecommerce_customer_accounts
    WHERE email_normalized = 'unknown@example.test'`).get().email_verified_at);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM galaxy_auth_user WHERE email = 'unknown@example.test'`).get().count, 1);
  assert.equal(await activateNewCustomer({ DB }, order.id, 'another-browser'), null);
  await revokeCustomerSession({ DB }, activated.token);
  assert.equal(await findCustomerSession({ DB }, activated.token), null);

  await api.carts.getOrCreate('paid-browser', activated.account.id);
  assert.equal(await api.orders.findForSession(order.id, 'paid-browser'), null);
  assert.equal((await api.orders.findForSession(order.id, undefined, activated.account.id)).id, order.id);

  const later = await api.carts.getOrCreate('later-browser');
  await api.carts.updateItems(later.id, [{ productId: 'forrest', variantId: 'forrest-amber', quantity: 1 }]);
  const claimed = await api.carts.getOrCreate('later-browser', activated.account.id);
  assert.equal(claimed.id, later.id);
  assert.equal(claimed.userId, activated.account.id);
  assert.equal(claimed.items[0].productId, 'forrest');
  sqlite.close();
});

test('shopper email links allow registration but limit requests from one IP', async () => {
  const { sqlite, DB } = database();
  let sent = 0;
  for (let index = 0; index < 21; index++) {
    await requestCustomerEmailSignIn({ DB }, `new-${index}@example.test`, token => token,
      async () => { sent++; }, '203.0.113.10');
  }
  assert.equal(sent, 20);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_sign_in_tokens`).get().count, 20);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_customer_accounts`).get().count, 0);
  sqlite.close();
});

test('fulfillment is audited once and only accepts confirmed real orders', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 2);
  const api = shop(DB);
  const cart = await api.carts.getOrCreate('fulfillment-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, address);
  const input = { orderId: order.id, carrier: 'USPS', trackingNumber: 'TRACK-1',
    note: 'Parcel handed to carrier' };
  await assert.rejects(fulfillCommerceOrder({ DB }, 'admin-1', input), /A pending order cannot ship/);
  await api.orders.finalizePayment(order.id, { provider: 'test', providerId: order.checkoutSessionId,
    paymentStatus: 'success', amount: order.totalAmount });
  const result = await fulfillCommerceOrder({ DB }, 'admin-1', input);
  assert.deepEqual([result.status, result.fulfillmentStatus], ['paid', 'fulfilled']);
  const [listed] = (await listCommerceOrdersAdmin({ DB }, { view: 'recent' })).orders;
  assert.deepEqual([listed.id, listed.shipments[0].adminActor], [order.id, 'admin-1']);
  assert.deepEqual((await listCommerceOrdersAdmin({ DB })).orders, [], 'a shipped order leaves the queue');
  await assert.rejects(fulfillCommerceOrder({ DB }, 'admin-1', input), /Order has already shipped in full/);
  // The trigger refuses a second completing shipment written straight to the table, too.
  assert.throws(() => sqlite.prepare(`INSERT INTO _ecommerce_fulfillments
    (id, order_id, admin_actor, note, created_at) VALUES ('ful_again', ?, 'admin-1', 'Parcel handed to carrier', 0)`)
    .run(order.id), /Order is not ready for fulfillment/);
  sqlite.close();
});

test('a guest payment joins an existing account without granting a login', async () => {
  const { sqlite, DB } = database();
  seed(sqlite);
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [{
    providerId: 'stripe',
    async createCheckoutSession({ orderId }) {
      return { providerSessionId: `session-${orderId}`, url: `https://example.test/${orderId}` };
    },
    async expireCheckoutSession() {}
  }] });
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run('existing-account', address.customerEmail, address.customerEmail, now, now);
  const cart = await api.carts.getOrCreate('other-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, { ...address, providerId: 'stripe' });
  await api.orders.finalizePayment(order.id, {
    provider: 'stripe', providerId: order.checkoutSessionId, paymentStatus: 'success',
    amount: order.totalAmount, currency: order.currency
  });
  assert.equal((await api.orders.find(order.id)).userId, 'existing-account');
  assert.deepEqual((await listCustomerOrders({ DB }, 'existing-account')).map((item) => item.id), [order.id]);
  assert.equal(await activateNewCustomer({ DB }, order.id, 'other-browser'), null);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_customer_sessions').get().count, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_customer_accounts').get().count, 1);
  sqlite.close();
});

test('a signed-in shopper purchase stays on that account without creating another login', async () => {
  const { sqlite, DB } = database();
  seed(sqlite);
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run('existing-account', address.customerEmail, address.customerEmail, now, now);
  const api = shop(DB);
  const cart = await api.carts.getOrCreate('signed-in-browser', 'existing-account');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, { ...address, customerEmail: 'other@example.com' });
  await api.orders.finalizePayment(order.id, {
    provider: 'test', providerId: order.checkoutSessionId, paymentStatus: 'success',
    amount: order.totalAmount, currency: order.currency
  });
  assert.equal((await api.orders.find(order.id)).userId, 'existing-account');
  assert.deepEqual((await listCustomerOrders({ DB }, 'existing-account')).map((item) => item.id), [order.id]);
  assert.equal(await activateNewCustomer({ DB }, order.id, 'signed-in-browser'), null);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_customer_accounts').get().count, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_customer_sessions').get().count, 0);
  sqlite.close();
});

test('account upgrade preserves both populated baskets when a choice is needed', async () => {
  const { sqlite, DB } = database();
  seed(sqlite);
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run('existing-account', address.customerEmail, address.customerEmail, now, now);
  const api = shop(DB);
  const owned = await api.carts.getOrCreate('older-browser', 'existing-account');
  await api.carts.updateItems(owned.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const guest = await api.carts.getOrCreate('guest-browser');
  await api.carts.updateItems(guest.id, [{ productId: 'forrest', variantId: 'forrest-amber', quantity: 1 }]);
  await assert.rejects(api.carts.getOrCreate('guest-browser', 'existing-account'), /Both baskets have items/);
  assert.equal((await api.carts.find('guest-browser')).items[0].productId, 'forrest');
  assert.equal((await api.carts.find(undefined, 'existing-account')).items[0].productId, 'mycelium');
  const selected = await api.carts.claim('guest-browser', 'existing-account', 'browser');
  assert.equal(selected.id, guest.id);
  assert.equal((await api.carts.find(undefined, 'existing-account')).id, guest.id);
  assert.equal((await api.carts.find('older-browser')).items[0].productId, 'mycelium');
  sqlite.close();
});

test('choosing the account basket preserves its items on the current browser', async () => {
  const { sqlite, DB } = database();
  seed(sqlite);
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run('existing-account', address.customerEmail, address.customerEmail, now, now);
  const api = shop(DB);
  const owned = await api.carts.getOrCreate('older-browser', 'existing-account');
  await api.carts.updateItems(owned.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const guest = await api.carts.getOrCreate('guest-browser');
  await api.carts.updateItems(guest.id, [{ productId: 'forrest', variantId: 'forrest-amber', quantity: 1 }]);
  const selected = await api.carts.claim('guest-browser', 'existing-account', 'account');
  assert.equal(selected.id, owned.id);
  assert.equal(selected.items[0].productId, 'mycelium');
  assert.equal((await api.carts.find(undefined, 'existing-account')).id, owned.id);
  assert.equal(sqlite.prepare('SELECT items FROM _ecommerce_carts WHERE id = ?').get(guest.id).items.includes('forrest'), true);
  sqlite.close();
});

test('an expired shopper session cannot use its browser token to edit the account basket', async () => {
  const { sqlite, DB } = database();
  seed(sqlite);
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run('existing-account', address.customerEmail, address.customerEmail, now, now);
  const api = shop(DB);
  const owned = await api.carts.getOrCreate('old-session-token', 'existing-account');
  await api.carts.updateItems(owned.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  assert.ok(!(await api.carts.find('old-session-token')));
  const fresh = await api.carts.getOrCreate('old-session-token');
  assert.notEqual(fresh.id, owned.id);
  assert.deepEqual(fresh.items, []);
  assert.equal((await api.carts.find(undefined, 'existing-account')).id, owned.id);
  assert.equal(sqlite.prepare('SELECT session_token FROM _ecommerce_carts WHERE id = ?').get(owned.id).session_token, null);
  sqlite.close();
});

test('a released referral awards both shoppers once and store credit reduces only the provider charge', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 10);
  sqlite.exec('UPDATE _ecommerce_components SET quantity = 10');
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, created_at, updated_at) VALUES ('referrer', 'referrer@example.com', 'referrer@example.com', ?, ?)`)
    .run(now, now);
  const code = await getOrCreateReferralCode({ DB }, 'referrer');
  assert.equal(await getOrCreateReferralCode({ DB }, 'referrer'), code);
  const sessions = [];
  const api = bindCommerceApi({ env: { DB, TALISMAN_COMMERCE_REFERRALS_ENABLED: 'true' }, paymentAdapters: [{
    providerId: 'stripe',
    async createCheckoutSession(input) {
      sessions.push(input);
      return { providerSessionId: `session-${input.orderId}`, url: `https://example.test/${input.orderId}` };
    },
    async validateWebhook(payload) { return JSON.parse(payload); },
    async expireCheckoutSession() {}
  }] });
  const guest = await api.carts.getOrCreate('referred-browser');
  await api.carts.updateItems(guest.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const first = (await api.orders.createFromCart(guest.id, {
    ...address, customerEmail: 'friend@example.com', providerId: 'stripe', referralCode: code
  })).order;
  assert.equal(first.referralCode, code);
  await api.orders.finalizePayment(first.id, {
    provider: 'stripe', providerId: first.checkoutSessionId, paymentStatus: 'success',
    amount: 12000, currency: 'usd', paymentIntentId: 'pi_first_referral'
  });
  await api.orders.finalizePayment(first.id, {
    provider: 'stripe', providerId: first.checkoutSessionId, paymentStatus: 'success',
    amount: 12000, currency: 'usd'
  });
  const friend = await api.orders.find(first.id);
  // The awards are pending until the hold has passed.
  assert.equal((await getReferralDashboard({ DB }, 'referrer')).creditBalance, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_credit_ledger').get().count, 0);
  await releaseAfterHold(DB);
  await releaseAfterHold(DB);
  assert.equal((await getReferralDashboard({ DB }, 'referrer')).creditBalance, 1000);
  assert.equal((await getReferralDashboard({ DB }, friend.userId)).creditBalance, 1000);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_referrals').get().count, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_credit_ledger').get().count, 2);

  const referrerCart = await api.carts.getOrCreate('referrer-browser', 'referrer');
  await api.carts.updateItems(referrerCart.id, [{ productId: 'forrest', variantId: 'forrest-amber', quantity: 1 }]);
  const second = (await api.orders.createFromCart(referrerCart.id, {
    ...address, customerEmail: 'referrer@example.com', providerId: 'stripe'
  })).order;
  assert.equal(second.subtotalAmount, 12000);
  assert.equal(second.creditApplied, 1000);
  assert.equal(second.totalAmount, 11000);
  assert.equal(sessions.at(-1).creditApplied, 1000);
  assert.equal((await getReferralDashboard({ DB }, 'referrer')).creditBalance, 0);
  await assert.rejects(api.orders.finalizePayment(second.id, {
    provider: 'stripe', providerId: second.checkoutSessionId, paymentStatus: 'success',
    amount: 12000, currency: 'usd'
  }), /amount does not match/);
  await api.orders.cancel(second.id);
  await api.orders.cancel(second.id);
  assert.equal((await getReferralDashboard({ DB }, 'referrer')).creditBalance, 1000);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_credit_ledger WHERE kind = 'checkout_release'`).get().count, 1);
  const friendCart = await api.carts.getOrCreate('friend-return', friend.userId);
  await api.carts.updateItems(friendCart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const friendPurchase = (await api.orders.createFromCart(friendCart.id, {
    ...address, customerEmail: 'friend@example.com', providerId: 'stripe'
  })).order;
  assert.equal(friendPurchase.creditApplied, 1000);
  await api.orders.finalizePayment(friendPurchase.id, {
    provider: 'stripe', providerId: friendPurchase.checkoutSessionId, paymentStatus: 'success',
    amount: 11000, currency: 'usd', paymentIntentId: 'pi_friend_purchase'
  });
  const refundEvent = (amountRefunded) => JSON.stringify({ type: 'charge.refunded', data: {
    payment_intent: 'pi_first_referral', amount: 12000, amount_refunded: amountRefunded, currency: 'usd'
  } });
  await api.webhooks.handleStripe(refundEvent(3000), 'test-signature', 'test-secret');
  assert.equal((await api.orders.find(first.id)).status, 'partially_refunded');
  assert.equal((await getReferralDashboard({ DB }, 'referrer')).creditBalance, 1000);
  await api.webhooks.handleStripe(refundEvent(12000), 'test-signature', 'test-secret');
  await api.webhooks.handleStripe(refundEvent(12000), 'test-signature', 'test-secret');
  assert.equal((await api.orders.find(first.id)).status, 'refunded');
  assert.equal((await getReferralDashboard({ DB }, 'referrer')).creditBalance, 0);
  assert.equal((await getReferralDashboard({ DB }, friend.userId)).creditBalance, -1000);
  assert.equal(sqlite.prepare(`SELECT status FROM _ecommerce_referrals WHERE order_id = ?`).get(first.id).status, 'void');
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_credit_ledger WHERE kind IN ('referral_reversal', 'welcome_reversal')`).get().count, 2);
  await api.webhooks.handleStripe(JSON.stringify({ type: 'charge.refunded', data: {
    payment_intent: 'pi_friend_purchase', amount: 11000, amount_refunded: 11000, currency: 'usd'
  } }), 'test-signature', 'test-secret');
  assert.equal((await getReferralDashboard({ DB }, friend.userId)).creditBalance, 0);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_credit_ledger WHERE kind = 'purchase_credit_refund'`).get().count, 1);
  const afterRefund = await api.carts.getOrCreate('friend-next', friend.userId);
  await api.carts.updateItems(afterRefund.id, [{ productId: 'forrest', variantId: 'forrest-amber', quantity: 1 }]);
  const noCredit = (await api.orders.createFromCart(afterRefund.id, {
    ...address, customerEmail: 'friend@example.com', providerId: 'stripe'
  })).order;
  assert.equal(noCredit.creditApplied, 0);
  sqlite.close();
});

test('self-referrals and existing shoppers do not earn referral credit', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 10);
  sqlite.exec('UPDATE _ecommerce_components SET quantity = 10');
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, created_at, updated_at) VALUES ('owner', 'owner@example.com', 'owner@example.com', ?, ?)`)
    .run(now, now);
  const code = await getOrCreateReferralCode({ DB }, 'owner');
  const api = bindCommerceApi({ env: { DB, TALISMAN_COMMERCE_REFERRALS_ENABLED: 'true' }, paymentAdapters: [{
    providerId: 'stripe',
    async createCheckoutSession({ orderId }) {
      return { providerSessionId: `session-${orderId}`, url: `https://example.test/${orderId}` };
    },
    async expireCheckoutSession() {}
  }] });
  const cart = await api.carts.getOrCreate('self-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const self = (await api.orders.createFromCart(cart.id, {
    ...address, customerEmail: 'owner@example.com', providerId: 'stripe', referralCode: code
  })).order;
  assert.equal(self.referralCode, null);
  await api.orders.finalizePayment(self.id, {
    provider: 'stripe', providerId: self.checkoutSessionId, paymentStatus: 'success',
    amount: self.totalAmount, currency: 'usd', paymentIntentId: 'pi_self_referral'
  });
  await releaseAfterHold(DB);
  assert.equal((await getReferralDashboard({ DB }, 'owner')).creditBalance, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_referrals').get().count, 0);
  sqlite.close();
});

/** Asks for a sign-in link for `email` and, unless `use` is false, uses it, as a shopper who signs up first. */
async function signUp(DB, email, { use = true } = {}) {
  let link;
  await requestCustomerEmailSignIn({ DB }, email, (token) => `https://example.test/account/verify#token=${token}`,
    async (_to, value) => { link = value; });
  return use ? consumeCustomerEmailSignIn({ DB }, new URL(link).hash.slice('#token='.length)) : null;
}

function referralShop(sqlite, DB) {
  seed(sqlite, 10);
  sqlite.exec('UPDATE _ecommerce_components SET quantity = 10');
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, email_verified_at, created_at, updated_at)
    VALUES ('referrer', 'referrer@example.com', 'referrer@example.com', ?, ?, ?)`).run(now, now, now);
  sqlite.prepare(`INSERT INTO _ecommerce_referral_settings
    (id, enabled, reward_cents, min_order_cents, attribution_days, updated_at)
    VALUES ('default', 1, 1000, 5000, 30, ?)`).run(now);
  return stripeWithRefunds(DB);
}

async function buy(api, browser, details, { accountId, productId = 'mycelium' } = {}) {
  const cart = await api.carts.getOrCreate(browser, accountId);
  await api.carts.updateItems(cart.id, [{ productId, variantId: `${productId}-amber`, quantity: 1 }]);
  const { order } = await api.orders.createFromCart(cart.id, { ...address, providerId: 'stripe', ...details });
  return order;
}

const pay = (api, order) => api.orders.finalizePayment(order.id, { provider: 'stripe',
  providerId: order.checkoutSessionId, paymentStatus: 'success', amount: order.totalAmount, currency: 'usd',
  paymentIntentId: `pi_${order.id}` });
const firstOrderLines = { lines: [{ productId: 'mycelium', quantity: 1, priceAtPurchase: 12000 }], subtotal: 12000 };

test('asking for a sign-in link before a first purchase keeps the first-order code and the referral', async () => {
  const { sqlite, DB } = database();
  const api = referralShop(sqlite, DB);
  const code = await getOrCreateReferralCode({ DB }, 'referrer');
  await createDiscountCode({ DB }, discountInput('WELCOME10', 'amount', 1000, { firstOrderOnly: true }));
  // A simulated admin test order for the address is not a purchase.
  const admin = bindCommerceApi({ env: { DB }, paymentAdapters: [new AdminTestPaymentAdapter()] });
  const testCart = await admin.carts.getOrCreate('admin-browser');
  await admin.carts.updateItems(testCart.id, [{ productId: 'forrest', variantId: 'forrest-amber', quantity: 1 }]);
  const simulated = (await admin.orders.createFromCart(testCart.id, { ...address, customerEmail: 'friend@example.com',
    providerId: 'admin_test' })).order;
  await admin.orders.finalizePayment(simulated.id, { provider: 'admin_test', providerId: simulated.checkoutSessionId,
    paymentStatus: 'success', amount: simulated.totalAmount, currency: 'usd' });

  // The shopper asks for a link on the account page and never uses it.
  await signUp(DB, 'Friend@Example.com', { use: false });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_customer_accounts').get().count, 1, 'only the referrer');
  assert.equal((await evaluateDiscountCode({ DB }, { code: 'WELCOME10', customerEmail: 'friend@example.com',
    ...firstOrderLines })).amount, 1000);

  const order = await buy(api, 'friend-browser', { customerEmail: 'friend@example.com', discountCode: 'WELCOME10', referralCode: code });
  assert.deepEqual([order.discountAmount, order.referralCode], [1000, code]);
  await pay(api, order);
  await releaseAfterHold(DB);
  const friend = (await api.orders.find(order.id)).userId;
  assert.equal((await getReferralDashboard({ DB }, 'referrer')).creditBalance, 1000);
  assert.equal((await getReferralDashboard({ DB }, friend)).creditBalance, 1000);

  // Now the shopper has bought: the code is refused, in any letter case, and a new referral is not attributed.
  await assert.rejects(evaluateDiscountCode({ DB }, { code: 'WELCOME10', customerEmail: 'FRIEND@example.com',
    ...firstOrderLines }), /first purchase only/);
  const repeat = await buy(api, 'friend-again', { customerEmail: 'Friend@Example.com', referralCode: code }, { productId: 'forrest' });
  assert.equal(repeat.referralCode, null);
  sqlite.close();
});

test('a shopper who signs up and buys signed in gets the first-order code and the referral once', async () => {
  const { sqlite, DB } = database();
  const api = referralShop(sqlite, DB);
  const code = await getOrCreateReferralCode({ DB }, 'referrer');
  await createDiscountCode({ DB }, discountInput('WELCOME10', 'amount', 1000, { firstOrderOnly: true }));
  const member = (await signUp(DB, 'member@example.com')).account.id;

  // The database trigger that reserves the code accepts an account without purchases.
  const order = await buy(api, 'member-browser', { customerEmail: 'member@example.com', discountCode: 'WELCOME10',
    referralCode: code }, { accountId: member });
  assert.deepEqual([order.userId, order.discountAmount, order.referralCode], [member, 1000, code]);
  await pay(api, order);
  assert.deepEqual({ ...sqlite.prepare('SELECT referrer_account_id, referred_account_id FROM _ecommerce_referrals').get() },
    { referrer_account_id: 'referrer', referred_account_id: member });
  await releaseAfterHold(DB);
  assert.equal((await getReferralDashboard({ DB }, member)).creditBalance, 1000);

  const cart = await api.carts.getOrCreate('member-browser', member);
  await api.carts.updateItems(cart.id, [{ productId: 'forrest', variantId: 'forrest-amber', quantity: 1 }]);
  await assert.rejects(api.orders.createFromCart(cart.id, { ...address, customerEmail: 'member@example.com',
    discountCode: 'WELCOME10' }), /first purchase only/);
  const repeat = (await api.orders.createFromCart(cart.id, { ...address, customerEmail: 'member@example.com',
    referralCode: code })).order;
  assert.equal(repeat.referralCode, null);
  // The referrer cannot be referred, even signed in with another checkout email.
  const own = await buy(api, 'referrer-browser', { customerEmail: 'someone@example.com', referralCode: code },
    { accountId: 'referrer' });
  assert.equal(own.referralCode, null);
  sqlite.close();
});

test('only the first paid purchase earns a referral when two checkouts overlap', async () => {
  const { sqlite, DB } = database();
  const api = referralShop(sqlite, DB);
  const code = await getOrCreateReferralCode({ DB }, 'referrer');
  const second = (await signUp(DB, 'second@example.com')).account.id;
  // Both checkouts start before either is paid, so both carry the referral.
  const guest = await buy(api, 'guest-browser', { customerEmail: 'buyer@example.com', referralCode: code });
  const signedIn = await buy(api, 'account-browser', { customerEmail: 'Buyer@Example.com', referralCode: code },
    { accountId: second, productId: 'forrest' });
  assert.deepEqual([guest.referralCode, signedIn.referralCode], [code, code]);
  await pay(api, guest);
  // The second order is paid by the same buyer under another account, so it is not a first purchase.
  await pay(api, signedIn);
  assert.deepEqual(sqlite.prepare('SELECT order_id FROM _ecommerce_referrals').all().map((row) => row.order_id), [guest.id]);
  await releaseAfterHold(DB);
  assert.equal((await getReferralDashboard({ DB }, second)).creditBalance, 0);
  assert.equal((await getReferralDashboard({ DB }, 'referrer')).creditBalance, 1000);
  sqlite.close();
});

test('a product with variant groups is never sold without a variant', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 10);
  // Product-level stock on a variant product, which checkout used to sell at the base price.
  sqlite.exec(`UPDATE _ecommerce_products SET inventory_quantity = 5 WHERE id = 'mycelium'`);
  const api = shop(DB);
  const cart = await api.carts.getOrCreate('variantless');
  await assert.rejects(api.carts.updateItems(cart.id, [{ productId: 'mycelium', quantity: 1 }]),
    /Cart items must choose one of the variants of mycelium/);
  await assert.rejects(api.carts.validateItems([{ productId: 'forrest', variantId: '', quantity: 1 }]),
    /Cart items must choose one of the variants of forrest/);

  // A line saved before the product had variants is refused by the quote and at checkout, before any reservation.
  sqlite.prepare('UPDATE _ecommerce_carts SET items = ? WHERE id = ?')
    .run(JSON.stringify([{ productId: 'mycelium', quantity: 1 }]), cart.id);
  await assert.rejects(api.carts.quote(cart.id), /Select an option for Mycelium/);
  await assert.rejects(api.orders.createFromCart(cart.id, address), /Select an option for Mycelium/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_orders').get().count, 0);
  assert.equal(sqlite.prepare(`SELECT inventory_quantity FROM _ecommerce_products WHERE id = 'mycelium'`).get().inventory_quantity, 5);
  assert.equal((await api.carts.find('variantless')).checkoutSessionId, null);

  // Naming the group instead of one of its values is no choice either, even with stock on the group,
  // which would sell the frame at the base price without its lens and without using its components.
  sqlite.exec(`UPDATE _ecommerce_product_variants SET inventory_quantity = 5 WHERE id = 'mycelium-group'`);
  await assert.rejects(api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-group', quantity: 1 }]),
    /Cart items must choose one of the variants of mycelium/);
  await assert.rejects(api.carts.validateItems([{ productId: 'mycelium', variantId: 'forrest-group', quantity: 1 }]),
    /must use a variant of their product; forrest-group/);
  sqlite.prepare('UPDATE _ecommerce_carts SET items = ? WHERE id = ?')
    .run(JSON.stringify([{ productId: 'mycelium', variantId: 'mycelium-group', quantity: 1 }]), cart.id);
  await assert.rejects(api.carts.quote(cart.id), /Select an option for Mycelium/);
  await assert.rejects(api.orders.createFromCart(cart.id, address), /Select an option for Mycelium/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_orders').get().count, 0);
  assert.equal(sqlite.prepare(`SELECT inventory_quantity FROM _ecommerce_product_variants WHERE id = 'mycelium-group'`)
    .get().inventory_quantity, 5);
  assert.equal(sqlite.prepare(`SELECT quantity FROM _ecommerce_components WHERE id = 'mycelium-frame'`).get().quantity, 2);
  assert.equal((await api.carts.find('variantless')).checkoutSessionId, null);

  // The shopper can still swap it for a variant, and a product without variant groups sells on its own.
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  assert.equal((await api.carts.quote(cart.id)).lines[0].variantId, 'mycelium-amber');
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_products (id, name, slug, base_price, inventory_quantity, status, created_at, updated_at)
    VALUES ('case', 'Case', 'case', 2000, 3, 'active', ?, ?)`).run(now, now);
  const plain = await api.carts.getOrCreate('plain');
  await api.carts.updateItems(plain.id, [{ productId: 'case', quantity: 1 }]);
  const { order } = await api.orders.createFromCart(plain.id, address);
  assert.equal(order.totalAmount, 2000);
  assert.equal(sqlite.prepare(`SELECT inventory_quantity FROM _ecommerce_products WHERE id = 'case'`).get().inventory_quantity, 2);

  // A legacy variant, a group with no values, is still sold at its own price and stock.
  sqlite.prepare(`INSERT INTO _ecommerce_products (id, name, slug, base_price, inventory_quantity, status, created_at, updated_at)
    VALUES ('strap', 'Strap', 'strap', 1500, 0, 'active', ?, ?)`).run(now, now);
  sqlite.prepare(`INSERT INTO _ecommerce_product_variants (id, product_id, name, price_override, inventory_quantity, created_at, updated_at)
    VALUES ('strap-black', 'strap', 'Black', 1800, 4, ?, ?)`).run(now, now);
  const legacy = await api.carts.getOrCreate('legacy');
  await assert.rejects(api.carts.updateItems(legacy.id, [{ productId: 'strap', quantity: 1 }]),
    /Cart items must choose one of the variants of strap/);
  await api.carts.updateItems(legacy.id, [{ productId: 'strap', variantId: 'strap-black', quantity: 1 }]);
  const legacyOrder = (await api.orders.createFromCart(legacy.id, address)).order;
  assert.equal(legacyOrder.totalAmount, 1800);
  assert.equal(sqlite.prepare(`SELECT inventory_quantity FROM _ecommerce_product_variants WHERE id = 'strap-black'`)
    .get().inventory_quantity, 3);
  sqlite.close();
});

test('referral terms are validated and snapshotted on the pending order', async () => {
  const limits = { holdDays: 30, maxPerPeriod: 10, periodDays: 30 };
  assert.deepEqual(referralPolicy({ TALISMAN_COMMERCE_REFERRAL_REWARD_CENTS: '-100',
    TALISMAN_COMMERCE_REFERRAL_MIN_ORDER_CENTS: 'not-a-number' }),
    { enabled: false, switchedOn: false, termsError: null, source: 'settings',
      rewardCents: 1000, minOrderCents: 5000, attributionDays: 30, ...limits });
  assert.deepEqual(referralPolicy({ GALAXY_COMMERCE_REFERRAL_REWARD_CENTS: '1200',
    TALISMAN_COMMERCE_REFERRAL_MIN_ORDER_CENTS: ' 2400 ', TALISMAN_COMMERCE_REFERRALS_ENABLED: 'true' }),
    { enabled: true, switchedOn: true, termsError: null, source: 'settings',
      rewardCents: 1200, minOrderCents: 2400, attributionDays: 30, ...limits });
  const { sqlite, DB } = database();
  seed(sqlite);
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, created_at, updated_at) VALUES ('owner', 'owner@example.com', 'owner@example.com', ?, ?)`)
    .run(now, now);
  const code = await getOrCreateReferralCode({ DB }, 'owner');
  const settings = { DB, TALISMAN_COMMERCE_REFERRAL_REWARD_CENTS: '1500',
    TALISMAN_COMMERCE_REFERRAL_MIN_ORDER_CENTS: '10000', TALISMAN_COMMERCE_REFERRALS_ENABLED: 'true' };
  const adapter = { providerId: 'stripe',
    async createCheckoutSession({ orderId }) {
      return { providerSessionId: `session-${orderId}`, url: `https://example.test/${orderId}` };
    }, async expireCheckoutSession() {} };
  const api = bindCommerceApi({ env: settings, paymentAdapters: [adapter] });
  const cart = await api.carts.getOrCreate('terms-browser');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const order = (await api.orders.createFromCart(cart.id, {
    ...address, customerEmail: 'friend@example.com', referralCode: code
  })).order;
  assert.equal(order.referralRewardCents, 1500);
  settings.TALISMAN_COMMERCE_REFERRAL_REWARD_CENTS = '2000';
  await bindCommerceApi({ env: settings, paymentAdapters: [adapter] }).orders.finalizePayment(order.id, {
    provider: 'stripe', providerId: order.checkoutSessionId, paymentStatus: 'success',
    amount: order.totalAmount, currency: 'usd', paymentIntentId: 'pi_terms_snapshot'
  });
  await releaseAfterHold(DB);
  assert.equal((await getReferralDashboard({ DB }, 'owner')).creditBalance, 1500);
  sqlite.close();
});

function discountInput(code, type, value, overrides = {}) {
  return { code, description: null, type, value, maxDiscountCents: null,
    minOrderCents: 0, eligibleProductIds: [], maxUses: null, maxUsesPerCustomer: null,
    firstOrderOnly: false, startsAt: null, expiresAt: null, active: true, ...overrides };
}

function stripeWithRefunds(DB, calls = []) {
  return bindCommerceApi({ env: { DB }, paymentAdapters: [{
    providerId: 'stripe',
    async createCheckoutSession(input) {
      calls.push(input);
      return { providerSessionId: `session-${input.orderId}`, url: `https://example.test/${input.orderId}` };
    },
    async expireCheckoutSession() {},
    async validateWebhook(payload) { return JSON.parse(payload); }
  }] });
}

test('credit voucher balance is reserved, released, confirmed, and restored on full refund', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 10);
  sqlite.exec('UPDATE _ecommerce_components SET quantity = 10');
  const voucher = await createDiscountCode({ DB }, discountInput('', 'credit', 1000));
  assert.match(voucher.code, /^GC-[A-F0-9]{24}$/);
  const calls = [];
  const api = stripeWithRefunds(DB, calls);
  const firstCart = await api.carts.getOrCreate('gift-first');
  await api.carts.updateItems(firstCart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const first = (await api.orders.createFromCart(firstCart.id, { ...address,
    customerEmail: 'gift@example.com', discountCode: voucher.code.toLowerCase() })).order;
  assert.equal(first.subtotalAmount, 12000);
  assert.equal(first.discountCode, voucher.code);
  assert.equal(first.discountAmount, 1000);
  assert.equal(first.totalAmount, 11000);
  assert.equal(calls[0].discountApplied, 1000);
  assert.equal(sqlite.prepare(`SELECT remaining_cents FROM _ecommerce_discount_codes WHERE code = ?`).get(voucher.code).remaining_cents, 0);
  const secondCart = await api.carts.getOrCreate('gift-second');
  await api.carts.updateItems(secondCart.id, [{ productId: 'forrest', variantId: 'forrest-amber', quantity: 1 }]);
  await assert.rejects(api.orders.createFromCart(secondCart.id, { ...address,
    customerEmail: 'other@example.com', discountCode: voucher.code }), /does not apply/);
  await api.orders.cancel(first.id);
  await api.orders.cancel(first.id);
  assert.equal(sqlite.prepare(`SELECT remaining_cents FROM _ecommerce_discount_codes WHERE code = ?`).get(voucher.code).remaining_cents, 1000);
  const second = (await api.orders.createFromCart(secondCart.id, { ...address,
    customerEmail: 'other@example.com', discountCode: voucher.code })).order;
  await api.orders.finalizePayment(second.id, { provider: 'stripe', providerId: second.checkoutSessionId,
    paymentStatus: 'success', amount: 11000, currency: 'usd', paymentIntentId: 'pi_gift' });
  assert.equal(sqlite.prepare(`SELECT status FROM _ecommerce_discount_redemptions WHERE order_id = ?`).get(second.id).status, 'confirmed');
  await api.webhooks.handleStripe(JSON.stringify({ type: 'charge.refunded', data: {
    payment_intent: 'pi_gift', amount: 11000, amount_refunded: 11000, currency: 'usd'
  } }), 'signature', 'secret');
  assert.equal(sqlite.prepare(`SELECT remaining_cents FROM _ecommerce_discount_codes WHERE code = ?`).get(voucher.code).remaining_cents, 1000);
  assert.equal(sqlite.prepare(`SELECT status FROM _ecommerce_discount_redemptions WHERE order_id = ?`).get(second.id).status, 'refunded');
  sqlite.close();
});

test('percentage and fixed codes honor product eligibility, caps, limits, and shopper credit', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 10);
  sqlite.exec('UPDATE _ecommerce_components SET quantity = 10');
  await createDiscountCode({ DB }, discountInput('LENS25', 'percent', 2500, {
    maxDiscountCents: 2000, eligibleProductIds: ['mycelium'], maxUses: 1,
    maxUsesPerCustomer: 1, minOrderCents: 5000
  }));
  await createDiscountCode({ DB }, discountInput('SAVE500', 'amount', 500, {
    eligibleProductIds: ['forrest']
  }));
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, credit_balance, created_at, updated_at)
    VALUES ('shopper', 'shopper@example.com', 'shopper@example.com', 1000, ?, ?)`).run(now, now);
  const calls = [];
  const api = stripeWithRefunds(DB, calls);
  const cart = await api.carts.getOrCreate('percent-browser', 'shopper');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  await assert.rejects(api.orders.createFromCart(cart.id, { ...address,
    customerEmail: 'shopper@example.com', discountCode: 'SAVE500' }), /does not apply/);
  const order = (await api.orders.createFromCart(cart.id, { ...address,
    customerEmail: 'shopper@example.com', discountCode: 'LENS25' })).order;
  assert.equal(order.discountAmount, 2000);
  assert.equal(order.creditApplied, 1000);
  assert.equal(order.totalAmount, 9000);
  assert.equal(calls.at(-1).discountApplied + calls.at(-1).creditApplied, 3000);
  const secondCart = await api.carts.getOrCreate('another-browser');
  await api.carts.updateItems(secondCart.id, [{ productId: 'forrest', variantId: 'forrest-amber', quantity: 1 }]);
  await assert.rejects(api.orders.createFromCart(secondCart.id, { ...address,
    customerEmail: 'another@example.com', discountCode: 'LENS25' }), /use limit|does not apply/);
  await api.orders.cancel(order.id);
  assert.equal(sqlite.prepare(`SELECT status FROM _ecommerce_discount_redemptions WHERE order_id = ?`).get(order.id).status, 'cancelled');
  assert.equal(sqlite.prepare(`SELECT credit_balance FROM _ecommerce_customer_accounts WHERE id = 'shopper'`).get().credit_balance, 1000);
  const fixed = (await api.orders.createFromCart(secondCart.id, { ...address,
    customerEmail: 'another@example.com', discountCode: 'SAVE500' })).order;
  assert.equal(fixed.discountAmount, 500);
  assert.equal(fixed.totalAmount, 11500);
  await assert.rejects(updateDiscountCode({ DB }, 'SAVE500', discountInput('SAVE500', 'amount', 800)),
    /fixed when a code is created/);
  await updateDiscountCode({ DB }, 'SAVE500', discountInput('SAVE500', 'amount', 500, {
    eligibleProductIds: ['forrest'], active: false }));
  await assert.rejects(evaluateDiscountCode({ DB }, { code: 'SAVE500', customerEmail: 'x@example.com',
    subtotal: 12000, lines: [{ productId: 'forrest', quantity: 1, priceAtPurchase: 12000 }] }), /unavailable/);
  sqlite.close();
});

test('admin referral settings override defaults and can disable new attribution', async () => {
  const { sqlite, DB } = database();
  seed(sqlite);
  await saveReferralSettings({ DB }, { enabled: false, rewardCents: 700,
    minOrderCents: 10000, attributionDays: 14 });
  assert.deepEqual((await getPromotionsAdmin({ DB })).referral,
    { enabled: false, switchedOn: false, termsError: null, source: 'saved', rewardCents: 700,
      minOrderCents: 10000, attributionDays: 14, holdDays: 30, maxPerPeriod: 10, periodDays: 30 });
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, created_at, updated_at) VALUES ('owner', 'owner@example.com', 'owner@example.com', ?, ?)`)
    .run(now, now);
  const code = await getOrCreateReferralCode({ DB }, 'owner');
  const api = stripeWithRefunds(DB);
  const cart = await api.carts.getOrCreate('disabled-referral');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const order = (await api.orders.createFromCart(cart.id, { ...address,
    customerEmail: 'friend@example.com', referralCode: code })).order;
  assert.equal(order.referralCode, null);
  assert.equal(order.referralRewardCents, 0);
  await api.orders.cancel(order.id);
  await saveReferralSettings({ DB }, { enabled: true, rewardCents: 700,
    minOrderCents: 10000, attributionDays: 14 });
  await setReferralCodeActive({ DB }, code, false);
  const another = await api.carts.getOrCreate('paused-link');
  await api.carts.updateItems(another.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const withoutLink = (await api.orders.createFromCart(another.id, { ...address,
    customerEmail: 'new@example.com', referralCode: code })).order;
  assert.equal(withoutLink.referralCode, null);
  await api.orders.cancel(withoutLink.id);
  await setReferralCodeActive({ DB }, code, true);
  const third = await api.carts.getOrCreate('active-link');
  await api.carts.updateItems(third.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const qualified = (await api.orders.createFromCart(third.id, { ...address,
    customerEmail: 'third@example.com', referralCode: code })).order;
  assert.equal(qualified.referralCode, code);
  assert.equal(qualified.referralRewardCents, 700);
  sqlite.close();
});

test('stored credit vouchers support partial spending across orders without double spending', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 10);
  sqlite.exec('UPDATE _ecommerce_components SET quantity = 10');
  const voucher = await createDiscountCode({ DB }, discountInput('', 'credit', 20000,
    { maxUses: 2, maxUsesPerCustomer: 1 }));
  const api = stripeWithRefunds(DB);
  const firstCart = await api.carts.getOrCreate('credit-a');
  await api.carts.updateItems(firstCart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const first = (await api.orders.createFromCart(firstCart.id, { ...address,
    customerEmail: 'a@example.com', discountCode: voucher.code })).order;
  assert.equal(first.discountAmount, 11950);
  assert.equal(first.totalAmount, 50);
  assert.equal(sqlite.prepare(`SELECT remaining_cents FROM _ecommerce_discount_codes WHERE code = ?`).get(voucher.code).remaining_cents, 8050);
  const secondCart = await api.carts.getOrCreate('credit-b');
  await api.carts.updateItems(secondCart.id, [{ productId: 'forrest', variantId: 'forrest-amber', quantity: 1 }]);
  const second = (await api.orders.createFromCart(secondCart.id, { ...address,
    customerEmail: 'b@example.com', discountCode: voucher.code })).order;
  assert.equal(second.discountAmount, 8050);
  assert.equal(second.totalAmount, 3950);
  assert.equal(sqlite.prepare(`SELECT remaining_cents FROM _ecommerce_discount_codes WHERE code = ?`).get(voucher.code).remaining_cents, 0);
  const thirdCart = await api.carts.getOrCreate('credit-c');
  await api.carts.updateItems(thirdCart.id, [{ productId: 'forrest', variantId: 'forrest-amber', quantity: 1 }]);
  await assert.rejects(api.orders.createFromCart(thirdCart.id, { ...address,
    customerEmail: 'c@example.com', discountCode: voucher.code }), /use limit|does not apply/);
  await api.orders.cancel(first.id);
  assert.equal(sqlite.prepare(`SELECT remaining_cents FROM _ecommerce_discount_codes WHERE code = ?`).get(voucher.code).remaining_cents, 11950);
  const third = (await api.orders.createFromCart(thirdCart.id, { ...address,
    customerEmail: 'c@example.com', discountCode: voucher.code })).order;
  assert.equal(third.discountAmount, 11950);
  assert.equal(third.totalAmount, 50);
  sqlite.close();
});

test('first-order and date rules reject ineligible checkouts, including concurrent reservations', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 10);
  sqlite.exec('UPDATE _ecommerce_components SET quantity = 10');
  const now = Math.floor(Date.now() / 1000);
  await createDiscountCode({ DB }, discountInput('FIRST10', 'amount', 1000, { firstOrderOnly: true }));
  await createDiscountCode({ DB }, discountInput('FUTURE10', 'amount', 1000,
    { startsAt: now + 3600 }));
  const api = stripeWithRefunds(DB);
  const firstCart = await api.carts.getOrCreate('first-guest');
  await api.carts.updateItems(firstCart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const first = (await api.orders.createFromCart(firstCart.id, { ...address,
    customerEmail: 'first@example.com', discountCode: 'FIRST10' })).order;
  const secondCart = await api.carts.getOrCreate('second-guest');
  await api.carts.updateItems(secondCart.id, [{ productId: 'forrest', variantId: 'forrest-amber', quantity: 1 }]);
  await assert.rejects(api.orders.createFromCart(secondCart.id, { ...address,
    customerEmail: 'first@example.com', discountCode: 'FIRST10' }), /Discount code is no longer available/);
  await assert.rejects(api.orders.createFromCart(secondCart.id, { ...address,
    customerEmail: 'second@example.com', discountCode: 'FUTURE10' }), /active dates/);
  await api.orders.cancel(first.id);
  const second = (await api.orders.createFromCart(secondCart.id, { ...address,
    customerEmail: 'first@example.com', discountCode: 'FIRST10' })).order;
  await api.orders.finalizePayment(second.id, { provider: 'stripe', providerId: second.checkoutSessionId,
    paymentStatus: 'success', amount: second.totalAmount, currency: 'usd' });
  const thirdCart = await api.carts.getOrCreate('third-guest');
  await api.carts.updateItems(thirdCart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  await assert.rejects(api.orders.createFromCart(thirdCart.id, { ...address,
    customerEmail: 'first@example.com', discountCode: 'FIRST10' }), /first purchase only/);
  sqlite.close();
});

test('administrator-issued gift cards reserve independently of discounts and release on cancellation', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 10);
  const gift = await issueAdminGiftCard(giftEnv(DB), 'admin-1', { amountCents: 10000,
    reason: 'Customer service goodwill' });
  assert.match(gift.code, /^GIFT-[A-F0-9]{32}$/);
  assert.equal(sqlite.prepare('SELECT balance_cents FROM _ecommerce_gift_cards WHERE id = ?')
    .get(gift.id).balance_cents, 10000);
  assert.equal((await getGiftCardBalance(giftEnv(DB), gift.code.toLowerCase())).balanceCents, 10000);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_gift_cards WHERE encrypted_code LIKE ?')
    .get(`%${gift.code}%`).n, 0);
  const calls = [];
  const api = stripeWithRefunds(DB, calls);
  const cart = await api.carts.getOrCreate('gift-partial');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const order = (await api.orders.createFromCart(cart.id, { ...address, giftCardCode: gift.code })).order;
  assert.equal(order.giftCardApplied, 10000);
  assert.equal(order.totalAmount, 2000);
  assert.equal(calls[0].giftCardApplied, 10000);
  assert.equal(sqlite.prepare('SELECT balance_cents FROM _ecommerce_gift_cards WHERE id = ?')
    .get(gift.id).balance_cents, 0);
  await api.orders.cancel(order.id);
  await api.orders.cancel(order.id);
  assert.equal(sqlite.prepare('SELECT balance_cents FROM _ecommerce_gift_cards WHERE id = ?')
    .get(gift.id).balance_cents, 10000);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM _ecommerce_gift_card_ledger WHERE kind = 'release'").get().n, 1);
  sqlite.close();
});

test('a gift card can settle an entire order without Stripe and cannot be overspent', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 10);
  const gift = await issueAdminGiftCard(giftEnv(DB), 'admin-1', { amountCents: 15000,
    reason: 'Replacement gift card' });
  const calls = [];
  const api = stripeWithRefunds(DB, calls);
  const firstCart = await api.carts.getOrCreate('gift-full');
  await api.carts.updateItems(firstCart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const { order, paymentUrl } = await api.orders.createFromCart(firstCart.id, { ...address,
    giftCardCode: gift.code });
  assert.equal(order.status, 'paid');
  assert.equal(order.paymentProvider, 'gift_card');
  assert.equal(order.totalAmount, 0);
  assert.equal(order.giftCardApplied, 12000);
  assert.equal(calls.length, 0);
  assert.match(paymentUrl, /success/);
  assert.equal(sqlite.prepare('SELECT balance_cents FROM _ecommerce_gift_cards WHERE id = ?')
    .get(gift.id).balance_cents, 3000);
  const secondCart = await api.carts.getOrCreate('gift-second-basket');
  await api.carts.updateItems(secondCart.id, [{ productId: 'forrest', variantId: 'forrest-amber', quantity: 1 }]);
  const second = (await api.orders.createFromCart(secondCart.id, { ...address,
    customerEmail: 'other@example.com', giftCardCode: gift.code })).order;
  assert.equal(second.totalAmount, 9000);
  await assert.rejects(evaluateGiftCard({ DB }, gift.code, 12000), /unavailable/);
  sqlite.close();
});

test('a paid gift card purchase issues once and a full unspent refund voids its value', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const adapter = { providerId: 'stripe',
    async createCheckoutSession({ orderId }) {
      return { providerSessionId: `session-${orderId}`, url: `https://checkout.stripe.com/${orderId}` };
    }, async expireCheckoutSession() {} };
  const purchase = await startGiftCardPurchase(env, adapter,
    { amountCents: 5000, buyerEmail: 'buyer@example.com' },
    { successUrl: 'https://example.test/gift-cards/success?purchase={PURCHASE_ID}',
      cancelUrl: 'https://example.test/gift-cards' });
  assert.equal(await getPurchasedGiftCard(env, purchase.id, 'incorrect'), null);
  assert.equal((await getPurchasedGiftCard(env, purchase.id, purchase.accessToken)).status, 'pending');
  const session = { id: `session-${purchase.id}`, metadata: { giftCardPurchaseId: purchase.id },
    amount_total: 5000, currency: 'usd', payment_status: 'paid', payment_intent: 'pi_gift_purchase' };
  await assert.rejects(confirmGiftCardPurchase(env, { ...session, amount_total: 4000 }), /does not match/);
  await confirmGiftCardPurchase(env, session);
  await confirmGiftCardPurchase(env, session);
  const delivered = await getPurchasedGiftCard(env, purchase.id, purchase.accessToken);
  assert.match(delivered.code, /^GIFT-[A-F0-9]{32}$/);
  assert.equal(delivered.balanceCents, 5000);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_gift_cards').get().n, 1);
  await recordGiftCardPurchaseRefund(env, { paymentIntentId: 'pi_gift_purchase',
    amount: 5000, amountRefunded: 5000, currency: 'usd' });
  assert.equal(sqlite.prepare('SELECT status,balance_cents FROM _ecommerce_gift_cards').get().status, 'void');
  assert.equal(sqlite.prepare('SELECT balance_cents FROM _ecommerce_gift_cards').get().balance_cents, 0);
  await assert.rejects(evaluateGiftCard(env, delivered.code, 1000), /unavailable/);
  sqlite.close();
});

test('a paid gift card purchase is issued when reconciliation replaces a missed webhook', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const adapter = { providerId: 'stripe',
    async createCheckoutSession({ orderId }) {
      return { providerSessionId: `session-${orderId}`, url: `https://checkout.stripe.com/${orderId}` };
    },
    async getCheckoutSession() {
      return { status: 'complete', url: null, paymentStatus: 'paid', amountTotal: 5000,
        currency: 'usd', paymentIntentId: 'pi_recovered_gift' };
    }
  };
  const purchase = await startGiftCardPurchase(env, adapter,
    { amountCents: 5000, buyerEmail: 'buyer@example.com' },
    { successUrl: 'https://example.test/gift-cards/success?purchase={PURCHASE_ID}',
      cancelUrl: 'https://example.test/gift-cards' });
  assert.equal((await reconcileGiftCardPurchase(env, adapter, purchase.id)).status, 'paid');
  assert.equal((await getPurchasedGiftCard(env, purchase.id, purchase.accessToken)).balanceCents, 5000);
  assert.equal(await reconcileGiftCardPurchase(env, adapter, purchase.id), null);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_gift_cards').get().n, 1);
  sqlite.close();
});

test('gift card tender refunds restore only the remaining amount after a Stripe refund', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 10);
  const gift = await issueAdminGiftCard(giftEnv(DB), 'admin-1', { amountCents: 8000,
    reason: 'Customer service balance' });
  const api = stripeWithRefunds(DB);
  const cart = await api.carts.getOrCreate('gift-refund');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const order = (await api.orders.createFromCart(cart.id, { ...address,
    giftCardCode: gift.code })).order;
  assert.equal(order.totalAmount, 4000);
  await api.orders.finalizePayment(order.id, { provider: 'stripe',
    providerId: order.checkoutSessionId, paymentStatus: 'success', amount: 4000,
    currency: 'usd', paymentIntentId: 'pi_mixed_gift' });
  await refundGiftCardTender({ DB }, 'admin-1', { orderId: order.id,
    amountCents: 3000, reason: 'Returned one item' });
  assert.equal(sqlite.prepare('SELECT balance_cents FROM _ecommerce_gift_cards WHERE id = ?')
    .get(gift.id).balance_cents, 3000);
  assert.equal(sqlite.prepare('SELECT gift_card_refunded_cents FROM _ecommerce_orders WHERE id = ?')
    .get(order.id).gift_card_refunded_cents, 3000);
  await assert.rejects(refundGiftCardTender({ DB }, 'admin-1', { orderId: order.id,
    amountCents: 6000, reason: 'Too much refund' }), /exceeds/);
  await api.webhooks.handleStripe(JSON.stringify({ type: 'charge.refunded', data: {
    payment_intent: 'pi_mixed_gift', amount: 4000, amount_refunded: 4000, currency: 'usd'
  } }), 'signature', 'secret');
  assert.equal(sqlite.prepare('SELECT balance_cents FROM _ecommerce_gift_cards WHERE id = ?')
    .get(gift.id).balance_cents, 8000);
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_gift_card_redemptions WHERE order_id = ?')
    .get(order.id).status, 'refunded');
  sqlite.close();
});

test('an administrator can fully refund a gift-card-only order with an audit reason', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 10);
  const gift = await issueAdminGiftCard(giftEnv(DB), 'admin-1', { amountCents: 12000,
    reason: 'Replacement purchase card' });
  const api = stripeWithRefunds(DB);
  const cart = await api.carts.getOrCreate('gift-only-refund');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const order = (await api.orders.createFromCart(cart.id, { ...address,
    giftCardCode: gift.code })).order;
  const refunded = await refundGiftCardOnlyOrder({ DB }, 'admin-1', { orderId: order.id,
    reason: 'Customer returned order' });
  assert.equal(refunded.status, 'refunded');
  assert.equal(sqlite.prepare('SELECT balance_cents FROM _ecommerce_gift_cards WHERE id = ?')
    .get(gift.id).balance_cents, 12000);
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_orders WHERE id = ?').get(order.id).status, 'refunded');
  assert.equal(sqlite.prepare('SELECT admin_actor FROM _ecommerce_gift_card_order_refunds WHERE order_id = ?')
    .get(order.id).admin_actor, 'admin-1');
  await assert.rejects(refundGiftCardOnlyOrder({ DB }, 'admin-1', { orderId: order.id,
    reason: 'Duplicate refund attempt' }), /Only paid/);
  sqlite.close();
});

test('a discounted zero-card order can combine a gift card with shopper credit and refund both tenders', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 10);
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id,email,email_normalized,credit_balance,created_at,updated_at)
    VALUES ('gift-shopper','gift-shopper@example.com','gift-shopper@example.com',2000,?,?)`).run(now, now);
  await createDiscountCode({ DB }, discountInput('GIFT10', 'amount', 1000));
  const gift = await issueAdminGiftCard(giftEnv(DB), 'admin-1', { amountCents: 10000,
    reason: 'Returning shopper gift' });
  const api = stripeWithRefunds(DB);
  const cart = await api.carts.getOrCreate('stacked-gift', 'gift-shopper');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const order = (await api.orders.createFromCart(cart.id, { ...address,
    customerEmail: 'gift-shopper@example.com', discountCode: 'GIFT10', giftCardCode: gift.code })).order;
  assert.equal(order.discountAmount, 1000);
  assert.equal(order.creditApplied, 2000);
  assert.equal(order.giftCardApplied, 9000);
  assert.equal(order.totalAmount, 0);
  assert.equal(order.status, 'paid');
  await refundGiftCardOnlyOrder({ DB }, 'admin-1', { orderId: order.id,
    reason: 'Entire order returned' });
  assert.equal(sqlite.prepare('SELECT balance_cents FROM _ecommerce_gift_cards WHERE id = ?')
    .get(gift.id).balance_cents, 10000);
  assert.equal(sqlite.prepare('SELECT credit_balance FROM _ecommerce_customer_accounts WHERE id = ?')
    .get('gift-shopper').credit_balance, 2000);
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_discount_redemptions WHERE order_id = ?')
    .get(order.id).status, 'refunded');
  sqlite.close();
});

test('refunding a gift card purchase after spending suspends the remaining balance for review', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 10);
  const env = giftEnv(DB);
  const adapter = { providerId: 'stripe',
    async createCheckoutSession({ orderId }) {
      return { providerSessionId: `session-${orderId}`, url: `https://checkout.stripe.com/${orderId}` };
    }, async expireCheckoutSession() {} };
  const purchase = await startGiftCardPurchase(env, adapter,
    { amountCents: 15000, buyerEmail: 'buyer@example.com' },
    { successUrl: 'https://example.test/gift-cards/success?purchase={PURCHASE_ID}',
      cancelUrl: 'https://example.test/gift-cards' });
  await confirmGiftCardPurchase(env, { id: `session-${purchase.id}`,
    metadata: { giftCardPurchaseId: purchase.id }, amount_total: 15000,
    currency: 'usd', payment_status: 'paid', payment_intent: 'pi_spent_gift' });
  const delivered = await getPurchasedGiftCard(env, purchase.id, purchase.accessToken);
  const api = stripeWithRefunds(DB);
  const cart = await api.carts.getOrCreate('spent-purchase-gift');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  await api.orders.createFromCart(cart.id, { ...address, giftCardCode: delivered.code });
  const result = await recordGiftCardPurchaseRefund(env, { paymentIntentId: 'pi_spent_gift',
    amount: 15000, amountRefunded: 15000, currency: 'usd' });
  assert.equal(result.status, 'review');
  assert.equal(sqlite.prepare('SELECT status,balance_cents FROM _ecommerce_gift_cards').get().status, 'suspended');
  await assert.rejects(evaluateGiftCard(env, delivered.code, 1000), /unavailable/);
  sqlite.close();
});

test('signed Stripe webhook dispatch issues gift cards once and expires unpaid purchases', async () => {
  const { sqlite, DB } = database();
  const env = giftEnv(DB);
  const adapter = { providerId: 'stripe',
    async createCheckoutSession({ orderId }) {
      return { providerSessionId: `session-${orderId}`, url: `https://checkout.stripe.com/${orderId}` };
    }, async expireCheckoutSession() {},
    async validateWebhook(payload) { return JSON.parse(payload); } };
  const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const urls = { successUrl: 'https://example.test/gift-cards/success?purchase={PURCHASE_ID}',
    cancelUrl: 'https://example.test/gift-cards' };
  const purchase = await startGiftCardPurchase(env, adapter,
    { amountCents: 7000, buyerEmail: 'buyer@example.com' }, urls);
  const event = { type: 'checkout.session.completed', data: {
    id: `session-${purchase.id}`, metadata: { giftCardPurchaseId: purchase.id },
    amount_total: 7000, currency: 'usd', payment_status: 'paid', payment_intent: 'pi_webhook_gift'
  } };
  await api.webhooks.handleStripe(JSON.stringify(event), 'signature', 'secret');
  await api.webhooks.handleStripe(JSON.stringify(event), 'signature', 'secret');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_gift_cards').get().n, 1);
  assert.equal(sqlite.prepare('SELECT balance_cents FROM _ecommerce_gift_cards').get().balance_cents, 7000);
  const expired = await startGiftCardPurchase(env, adapter,
    { amountCents: 7000, buyerEmail: 'buyer@example.com' }, urls);
  await api.webhooks.handleStripe(JSON.stringify({ type: 'checkout.session.expired', data: {
    id: `session-${expired.id}`, metadata: { giftCardPurchaseId: expired.id }
  } }), 'signature', 'secret');
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_gift_card_purchases WHERE id = ?')
    .get(expired.id).status, 'cancelled');
  sqlite.close();
});

test('a store that sells in another currency refuses to issue, sell or redeem gift cards', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 10);
  // A card issued while the store still sold in USD.
  const gift = await issueAdminGiftCard(giftEnv(DB), 'admin-1', { amountCents: 10000,
    reason: 'Customer service goodwill' });
  const env = { ...giftEnv(DB), TALISMAN_COMMERCE_CURRENCY: 'eur' };
  // A typed refusal, so checkout and the preview answer it like any other refused code.
  const refusal = { name: 'GiftCardRefusal', reason: 'currency',
    message: 'Gift cards are available only in stores that use USD' };
  const sessions = [];
  const adapter = { providerId: 'stripe',
    async createCheckoutSession(input) {
      sessions.push(input);
      return { providerSessionId: `session-${input.orderId}`, url: `https://checkout.stripe.com/${input.orderId}` };
    }, async expireCheckoutSession() {} };

  await assert.rejects(issueAdminGiftCard(env, 'admin-1', { amountCents: 10000,
    reason: 'Customer service goodwill' }), refusal);
  await assert.rejects(startGiftCardPurchase(env, adapter, { amountCents: 5000, buyerEmail: 'buyer@example.com' },
    { successUrl: 'https://example.test/gift-cards/success?purchase={PURCHASE_ID}',
      cancelUrl: 'https://example.test/gift-cards' }), refusal);
  await assert.rejects(evaluateGiftCard(env, gift.code, 12000), refusal);
  const api = bindCommerceApi({ env, paymentAdapters: [adapter] });
  const cart = await api.carts.getOrCreate('euro-gift');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  await assert.rejects(api.orders.createFromCart(cart.id, { ...address, giftCardCode: gift.code }), refusal);
  assert.equal(sessions.length, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_gift_card_purchases').get().n, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM _ecommerce_gift_cards').get().n, 1);
  assert.equal(sqlite.prepare('SELECT balance_cents FROM _ecommerce_gift_cards WHERE id = ?')
    .get(gift.id).balance_cents, 10000);
  assert.equal((await api.carts.find('euro-gift')).checkoutSessionId, null);

  // Without the card the basket checks out in the store currency.
  const { order } = await api.orders.createFromCart(cart.id, address);
  assert.deepEqual([order.currency, order.giftCardApplied, sessions[0].currency], ['eur', 0, 'eur']);
  sqlite.close();
});

test("store credit and credit vouchers leave Stripe's minimum charge for the store currency", async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 10);
  sqlite.exec('UPDATE _ecommerce_components SET quantity = 10');
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, credit_balance, created_at, updated_at)
    VALUES ('pound-shopper', 'pound-shopper@example.com', 'pound-shopper@example.com', 20000, ?, ?)`).run(now, now);
  const env = { DB, TALISMAN_COMMERCE_CURRENCY: 'GBP' };
  const sessions = [];
  const api = bindCommerceApi({ env, paymentAdapters: [{ providerId: 'stripe',
    async createCheckoutSession(input) {
      sessions.push(input);
      return { providerSessionId: `session-${input.orderId}`, url: `https://example.test/${input.orderId}` };
    }, async expireCheckoutSession() {} }] });

  // Stripe's minimum is 30 pence, where a USD store keeps 50 cents.
  const cart = await api.carts.getOrCreate('pound-browser', 'pound-shopper');
  await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
  const credited = (await api.orders.createFromCart(cart.id, { ...address,
    customerEmail: 'pound-shopper@example.com' })).order;
  assert.deepEqual([credited.currency, credited.creditApplied, credited.totalAmount], ['gbp', 11970, 30]);
  assert.deepEqual([sessions[0].currency, sessions[0].creditApplied], ['gbp', 11970]);

  const voucher = await createDiscountCode(env, discountInput('', 'credit', 20000));
  const guest = await api.carts.getOrCreate('pound-guest');
  await api.carts.updateItems(guest.id, [{ productId: 'forrest', variantId: 'forrest-amber', quantity: 1 }]);
  const discounted = (await api.orders.createFromCart(guest.id, { ...address,
    customerEmail: 'guest@example.com', discountCode: voucher.code })).order;
  assert.deepEqual([discounted.discountAmount, discounted.totalAmount], [11970, 30]);
  sqlite.close();
});

test('shipping is charged with a discount, store credit and a gift card, and the redemption guards accept the order', async () => {
  const { sqlite, DB } = database();
  seed(sqlite, 10);
  sqlite.exec('UPDATE _ecommerce_components SET quantity = 10');
  const now = Math.floor(Date.now() / 1000);
  for (const [id, credit] of [['credit-shopper', 2000], ['rich-shopper', 20000]]) {
    sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
      (id,email,email_normalized,credit_balance,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run(id, `${id}@example.com`, `${id}@example.com`, credit, now, now);
  }
  const env = { ...giftEnv(DB), TALISMAN_COMMERCE_SHIPPING_RATES: JSON.stringify([
    { id: 'standard', label: 'Standard shipping', amount: 1500, countries: ['US'] }]) };
  await createDiscountCode(env, discountInput('SHIP10', 'amount', 1000));
  const sessions = [];
  const api = bindCommerceApi({ env, paymentAdapters: [{ providerId: 'stripe',
    async createCheckoutSession(input) {
      sessions.push(input);
      return { providerSessionId: `session-${input.orderId}`, url: `https://example.test/${input.orderId}` };
    }, async expireCheckoutSession() {} }] });
  const buyWith = async (browser, accountId, details) => {
    const cart = await api.carts.getOrCreate(browser, accountId);
    await api.carts.updateItems(cart.id, [{ productId: 'mycelium', variantId: 'mycelium-amber', quantity: 1 }]);
    return (await api.orders.createFromCart(cart.id, { ...address, customerEmail: `${accountId}@example.com`,
      ...details })).order;
  };
  const totals = (order) => [order.subtotalAmount, order.shippingAmount, order.discountAmount, order.creditApplied,
    order.giftCardApplied, order.totalAmount];

  // $120 of items less the $10 code, $15 of shipping, $20 of credit and a $50 card leave $55 to pay.
  const card = await issueAdminGiftCard(env, 'admin-1', { amountCents: 5000, reason: 'Customer service goodwill' });
  const order = await buyWith('stacked-shipping', 'credit-shopper', { discountCode: 'SHIP10', giftCardCode: card.code });
  assert.deepEqual(totals(order), [12000, 1500, 1000, 2000, 5000, 5500]);
  // Both guards checked the totals, shipping included, when they reserved the code and the card.
  const redemption = (table, id) => sqlite.prepare(`SELECT status FROM ${table} WHERE order_id = ?`).get(id)?.status;
  assert.equal(redemption('_ecommerce_discount_redemptions', order.id), 'reserved');
  assert.equal(redemption('_ecommerce_gift_card_redemptions', order.id), 'reserved');
  assert.deepEqual([sessions[0].shipping, sessions[0].discountApplied, sessions[0].creditApplied,
    sessions[0].giftCardApplied], [{ label: 'Standard shipping', amount: 1500, description: undefined }, 1000, 2000, 5000]);
  await api.orders.finalizePayment(order.id, { provider: 'stripe', providerId: order.checkoutSessionId,
    paymentStatus: 'success', amount: 5500, currency: 'usd' });
  assert.equal(redemption('_ecommerce_gift_card_redemptions', order.id), 'confirmed');

  // Credit pays only for the items, all of them here, because the shipping leaves the minimum charge
  // to pay. A gift card can pay the shipping too, which settles the order without Stripe.
  const covering = await issueAdminGiftCard(env, 'admin-1', { amountCents: 5000, reason: 'Replacement gift card' });
  const settled = await buyWith('covered-shipping', 'rich-shopper', { giftCardCode: covering.code });
  assert.deepEqual(totals(settled), [12000, 1500, 0, 12000, 1500, 0]);
  assert.deepEqual([settled.status, settled.paymentProvider, sessions.length], ['paid', 'gift_card', 1]);
  assert.equal(redemption('_ecommerce_gift_card_redemptions', settled.id), 'confirmed');
  assert.equal(sqlite.prepare('SELECT balance_cents FROM _ecommerce_gift_cards WHERE id = ?').get(covering.id)
    .balance_cents, 3500);
  sqlite.close();
});
