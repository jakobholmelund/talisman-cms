import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyAllMigrations } from './helpers/migrations.mjs';

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
const { hasPurchaseHistory, listCustomerOrders } = await import('../dist/accounts.js');
const { AdminTestPaymentAdapter } = await import('../dist/adapters/admin-test.js');
const { issueAdminGiftCard, refundGiftCardTender } = await import('../dist/gift-cards.js');
const { correctCommerceFulfillment, fulfillCommerceOrder, listCommerceOrdersAdmin } = await import('../dist/fulfillment.js');
const fulfillmentRoute = (await import('../dist/routes/ecommerce-admin-fulfillment.js')).ALL;
const orderRoute = (await import('../dist/routes/ecommerce-order.js')).ALL;

const ORIGIN = 'https://shop.test';

/** An in-memory D1 stand-in. `recorded` collects every statement run, with its parameters. */
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
        async all() { recorded.push([sql, values]); return { results: prepared.all(...values) }; },
        async first() { recorded.push([sql, values]); return prepared.get(...values) ?? null; },
        async raw() {
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
  seedCatalog(sqlite);
  return { sqlite, DB, recorded };
}

const NOW = Math.floor(Date.now() / 1000);

/**
 * A frame sold as lens values of the `Lens` definition, one value with its own SKU and one without;
 * a strap whose value group has no definition and no SKUs; a case without variants; and a scarf
 * with a legacy variant group that has no values.
 */
function seedCatalog(sqlite) {
  const product = sqlite.prepare(`INSERT INTO _ecommerce_products
    (id, name, slug, sku, base_price, inventory_quantity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 50, 'active', ?, ?)`);
  product.run('frame', 'Mycelium frame', 'frame', 'TAL-FRAME', 12000, NOW, NOW);
  product.run('strap', 'Strap', 'strap', 'TAL-STRAP', 1500, NOW, NOW);
  product.run('case', 'Travel case', 'case', 'TAL-CASE', 2000, NOW, NOW);
  product.run('scarf', 'Scarf', 'scarf', null, 3000, NOW, NOW);
  sqlite.prepare(`INSERT INTO _ecommerce_variants (id, name, created_at, updated_at) VALUES ('def-lens', 'Lens', ?, ?)`).run(NOW, NOW);
  const group = sqlite.prepare(`INSERT INTO _ecommerce_product_variants
    (id, product_id, variant_id, name, sku, inventory_quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  group.run('frame-lens', 'frame', 'def-lens', 'Lens choice', 'TAL-FRAME-LENS', 0, NOW, NOW);
  group.run('strap-colour', 'strap', null, 'Colour', null, 0, NOW, NOW);
  group.run('scarf-large', 'scarf', null, 'Large', 'SCARF-L', 40, NOW, NOW);
  const value = sqlite.prepare(`INSERT INTO _ecommerce_product_variant_values
    (id, product_variant_id, value, sku, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
  value.run('frame-amber', 'frame-lens', 'Amber', 'TAL-FRAME-AMB', NOW, NOW);
  value.run('frame-smoke', 'frame-lens', 'Smoke', null, NOW, NOW);
  value.run('strap-black', 'strap-colour', 'Black', null, NOW, NOW);
  for (const id of ['frame-amber', 'frame-smoke', 'strap-black']) {
    sqlite.prepare(`INSERT INTO _ecommerce_stocks (id, product_variant_value_id, quantity, created_at, updated_at)
      VALUES (?, ?, 200, ?, ?)`).run(`${id}-stock`, id, NOW, NOW);
  }
}

const giftEnv = (DB) => ({ DB, TALISMAN_COMMERCE_GIFT_CARD_KEY: 'a'.repeat(64) });
const checkout = { customerEmail: 'Buyer@Example.test',
  shippingAddress: { name: 'Test Buyer', line1: '1 Main St', city: 'Austin', postalCode: '78701', country: 'US' },
  successUrl: `${ORIGIN}/checkout/success?order={ORDER_ID}`, cancelUrl: `${ORIGIN}/checkout/cancel?order={ORDER_ID}` };

/** Stripe as the API sees it: hosted sessions, and webhook events that arrive already verified. */
function stripeApi(DB) {
  return bindCommerceApi({ env: { DB }, paymentAdapters: [{
    providerId: 'stripe',
    async createCheckoutSession({ orderId }) { return { providerSessionId: `cs_test_${orderId}`, url: `https://checkout.example.test/${orderId}` }; },
    async expireCheckoutSession() {},
    async getCheckoutSession() { return { status: 'open', url: 'https://checkout.example.test/open' }; },
    async validateWebhook(payload) { return JSON.parse(payload); },
  }] });
}
const stripeEvent = (api, type, data) => api.webhooks.handleStripe(JSON.stringify({ type, data }), 'signature', 'secret');

async function placeOrder(DB, browser, { items = [{ productId: 'frame', variantId: 'frame-amber', quantity: 1 }], ...options } = {}) {
  const api = stripeApi(DB);
  const cart = await api.carts.getOrCreate(browser);
  await api.carts.updateItems(cart.id, items);
  const { order } = await api.orders.createFromCart(cart.id, { ...checkout, ...options });
  return { api, order };
}

async function paidOrder(DB, browser, options) {
  const { api, order } = await placeOrder(DB, browser, options);
  await stripeEvent(api, 'checkout.session.completed', { id: order.checkoutSessionId, metadata: { orderId: order.id },
    payment_status: 'paid', amount_total: order.totalAmount, currency: 'usd', payment_intent: `pi_${order.id}` });
  return { api, order: await api.orders.find(order.id) };
}

const refund = (api, order, amountRefunded) => stripeEvent(api, 'charge.refunded',
  { payment_intent: order.paymentIntentId, amount: order.totalAmount, amount_refunded: amountRefunded, currency: 'usd' });
const shipment = (orderId, extra = {}) => ({ orderId, carrier: 'UPS', trackingNumber: '1Z999', note: 'Parcel handed to carrier', ...extra });
const state = (sqlite, orderId) => ({ ...sqlite.prepare('SELECT status, fulfillment_status FROM _ecommerce_orders WHERE id = ?').get(orderId) });
const rowOf = (sqlite, sql, ...params) => ({ ...sqlite.prepare(sql).get(...params) });

/** What the Worker released before migration 0026 inserts, column for column. */
const previousWorkerInsert = (sqlite, id, orderId, note = 'Packed and shipped') => sqlite.prepare(`INSERT INTO _ecommerce_fulfillments
  (id, order_id, admin_actor, carrier, tracking_number, note, created_at) VALUES (?, ?, 'admin-1', 'USPS', 'TRACK-OLD', ?, ?)`)
  .run(id, orderId, note, NOW);

test('a partially refunded order can still ship, and shipping leaves its payment status alone', async () => {
  const { sqlite, DB } = database();
  const { api, order } = await paidOrder(DB, 'refund-first');
  await refund(api, order, 1000);
  assert.deepEqual(state(sqlite, order.id), { status: 'partially_refunded', fulfillment_status: 'unfulfilled' });
  const queue = await listCommerceOrdersAdmin({ DB });
  assert.deepEqual(queue.orders.map((item) => [item.id, item.canShip]), [[order.id, true]]);

  const result = await fulfillCommerceOrder({ DB }, 'admin-1', shipment(order.id));
  assert.deepEqual([result.status, result.fulfillmentStatus], ['partially_refunded', 'fulfilled']);
  assert.deepEqual(state(sqlite, order.id), { status: 'partially_refunded', fulfillment_status: 'fulfilled' });
  assert.equal((await listCommerceOrdersAdmin({ DB })).awaitingCount, 0);
  sqlite.close();
});

test('a refund after shipping keeps the shipment visible, whichever tender it returns', async () => {
  const { sqlite, DB } = database();
  const { api, order } = await paidOrder(DB, 'ship-first');
  await fulfillCommerceOrder({ DB }, 'admin-1', shipment(order.id));
  await refund(api, order, 2000);
  assert.deepEqual(state(sqlite, order.id), { status: 'partially_refunded', fulfillment_status: 'fulfilled' });
  const [listed] = (await listCommerceOrdersAdmin({ DB }, { view: 'recent' })).orders;
  assert.deepEqual([listed.status, listed.fulfillmentStatus, listed.canShip, listed.shipments.length],
    ['partially_refunded', 'fulfilled', false, 1]);
  await refund(api, order, order.totalAmount);
  assert.deepEqual(state(sqlite, order.id), { status: 'refunded', fulfillment_status: 'fulfilled' });

  // The gift card refund trigger writes only the payment status too.
  const gift = await issueAdminGiftCard(giftEnv(DB), 'admin-1', { amountCents: 5000, reason: 'Customer service balance' });
  const split = await paidOrder(DB, 'gift-split', { giftCardCode: gift.code });
  assert.equal(split.order.giftCardApplied, 5000);
  await fulfillCommerceOrder({ DB }, 'admin-1', shipment(split.order.id));
  await refundGiftCardTender({ DB }, 'admin-1', { orderId: split.order.id, amountCents: 2000, reason: 'Returned one lens pair' });
  assert.deepEqual(state(sqlite, split.order.id), { status: 'partially_refunded', fulfillment_status: 'fulfilled' });
  sqlite.close();
});

test('a correction is appended and the shipment as first recorded stays unchanged', async () => {
  const { sqlite, DB } = database();
  const { api, order } = await paidOrder(DB, 'correction');
  const shipped = await fulfillCommerceOrder({ DB }, 'admin-1', shipment(order.id, { trackingNumber: '1Z-WRONG' }));
  const original = rowOf(sqlite, 'SELECT * FROM _ecommerce_fulfillments WHERE id = ?', shipped.fulfillmentId);
  const orderBefore = rowOf(sqlite, 'SELECT status, fulfillment_status, updated_at FROM _ecommerce_orders WHERE id = ?', order.id);

  const corrected = await correctCommerceFulfillment({ DB }, 'admin-2', { fulfillmentId: shipped.fulfillmentId,
    carrier: 'UPS', trackingNumber: '1Z-RIGHT', reason: 'The label was reprinted' });
  assert.deepEqual(rowOf(sqlite, 'SELECT * FROM _ecommerce_fulfillments WHERE id = ?', shipped.fulfillmentId), original);
  assert.deepEqual(rowOf(sqlite, `SELECT order_id, kind, corrects_id, completes_order, admin_actor, carrier,
    tracking_number, note FROM _ecommerce_fulfillments WHERE id = ?`, corrected.correctionId), {
    order_id: order.id, kind: 'correction', corrects_id: shipped.fulfillmentId, completes_order: 0,
    admin_actor: 'admin-2', carrier: 'UPS', tracking_number: '1Z-RIGHT', note: 'The label was reprinted',
  });
  assert.deepEqual(rowOf(sqlite, 'SELECT status, fulfillment_status, updated_at FROM _ecommerce_orders WHERE id = ?', order.id), orderBefore);

  // A correction ships nothing, so a refunded order can still be corrected. The latest one is in force,
  // even within the same second.
  await refund(api, order, order.totalAmount);
  await correctCommerceFulfillment({ DB }, 'admin-2', { fulfillmentId: shipped.fulfillmentId,
    carrier: 'DHL', trackingNumber: null, reason: 'Handed to DHL after all' });
  const [listed] = (await listCommerceOrdersAdmin({ DB }, { view: 'recent' })).orders;
  assert.equal(listed.shipments.length, 1);
  const [record] = listed.shipments;
  assert.deepEqual({ carrier: record.carrier, trackingNumber: record.trackingNumber, recorded: record.recorded,
    note: record.note, adminActor: record.adminActor, completesOrder: record.completesOrder }, {
    carrier: 'DHL', trackingNumber: null, recorded: { carrier: 'UPS', trackingNumber: '1Z-WRONG' },
    note: 'Parcel handed to carrier', adminActor: 'admin-1', completesOrder: true,
  });
  assert.deepEqual(record.corrections.map((item) => [item.adminActor, item.carrier, item.trackingNumber, item.reason]), [
    ['admin-2', 'UPS', '1Z-RIGHT', 'The label was reprinted'],
    ['admin-2', 'DHL', null, 'Handed to DHL after all'],
  ]);
  await assert.rejects(correctCommerceFulfillment({ DB }, 'admin-2', { fulfillmentId: shipped.fulfillmentId,
    carrier: ' DHL ', trackingNumber: '', reason: 'Saved the form twice' }), /The correction changes nothing/);
  sqlite.close();
});

/** Runs `write` as a Worker whose clock is `seconds` off. */
async function withClockOffset(seconds, write) {
  const realNow = Date.now;
  Date.now = () => realNow() + seconds * 1000;
  try {
    return await write();
  } finally {
    Date.now = realNow;
  }
}

test('shipments and corrections count in the order they were written, whatever the writing clock said', async () => {
  const { sqlite, DB } = database();
  const { order } = await paidOrder(DB, 'skewed-clock');
  const correct = (trackingNumber, reason = 'The label was reprinted') => correctCommerceFulfillment({ DB }, 'admin-2',
    { fulfillmentId: parcel.fulfillmentId, carrier: 'UPS', trackingNumber, reason });

  // The first parcel is recorded by a Worker whose clock runs ahead; the next one by a correct clock.
  const parcel = await withClockOffset(30, () => fulfillCommerceOrder({ DB }, 'admin-1',
    shipment(order.id, { trackingNumber: '1Z-WRONG', completesOrder: false })));
  await fulfillCommerceOrder({ DB }, 'admin-1', shipment(order.id, { trackingNumber: 'PARCEL-2' }));
  await correct('1Z-RIGHT');
  const listed = async () => (await listCommerceOrdersAdmin({ DB }, { view: 'recent' })).orders[0].shipments;
  assert.deepEqual((await listed()).map((item) => [item.trackingNumber, item.completesOrder, item.corrections.length]),
    [['1Z-RIGHT', false, 1], ['PARCEL-2', true, 0]], 'the correction applies to its shipment, which is listed first');

  // A correction from a clock that runs ahead does not outrank the one written after it.
  await withClockOffset(60, () => correct('1Z-AHEAD', 'Typed the wrong digits'));
  await correct('1Z-LATEST', 'Checked against the label');
  const [first] = await listed();
  assert.equal(first.trackingNumber, '1Z-LATEST');
  assert.deepEqual(first.corrections.map((item) => item.trackingNumber), ['1Z-RIGHT', '1Z-AHEAD', '1Z-LATEST']);
  await assert.rejects(correct('1Z-LATEST', 'Saved the form twice'), /The correction changes nothing/);
  await correct('1Z-AHEAD', 'The first fix was right after all');
  assert.equal((await listed())[0].trackingNumber, '1Z-AHEAD');
  sqlite.close();
});

test('an order can ship in parcels: partial shipments first, then the one that completes it', async () => {
  const { sqlite, DB } = database();
  const { order } = await paidOrder(DB, 'parcels', { items: [
    { productId: 'frame', variantId: 'frame-amber', quantity: 1 }, { productId: 'case', quantity: 2 }] });
  const touched = () => sqlite.prepare('SELECT updated_at FROM _ecommerce_orders WHERE id = ?').get(order.id).updated_at;
  let updatedAt = touched();

  for (const trackingNumber of ['PARCEL-1', 'PARCEL-2']) {
    const result = await fulfillCommerceOrder({ DB }, 'admin-1', shipment(order.id, { trackingNumber, completesOrder: false }));
    assert.deepEqual([result.status, result.fulfillmentStatus], ['paid', 'partially_fulfilled']);
    assert.ok(touched() > updatedAt, 'every shipment moves the order forward');
    updatedAt = touched();
    const [queued] = (await listCommerceOrdersAdmin({ DB })).orders;
    assert.deepEqual([queued.id, queued.canShip], [order.id, true], 'a partly shipped order stays in the queue');
  }
  const last = await fulfillCommerceOrder({ DB }, 'admin-1', shipment(order.id, { trackingNumber: 'PARCEL-3' }));
  assert.deepEqual([last.status, last.fulfillmentStatus], ['paid', 'fulfilled']);
  assert.deepEqual((await listCommerceOrdersAdmin({ DB })).orders, []);
  const [listed] = (await listCommerceOrdersAdmin({ DB }, { view: 'recent' })).orders;
  assert.deepEqual(listed.shipments.map((item) => [item.trackingNumber, item.completesOrder]),
    [['PARCEL-1', false], ['PARCEL-2', false], ['PARCEL-3', true]]);
  await assert.rejects(fulfillCommerceOrder({ DB }, 'admin-1', shipment(order.id, { completesOrder: false })),
    /Order has already shipped in full/);
  sqlite.close();
});

test('shipments are refused for unpaid, cancelled, refunded, disputed, admin test and fully shipped orders', async () => {
  const { sqlite, DB } = database();
  const refusedByTrigger = (orderId, id) => assert.throws(() => previousWorkerInsert(sqlite, id, orderId),
    /Order is not ready for fulfillment/);

  const pending = await placeOrder(DB, 'pending');
  await assert.rejects(fulfillCommerceOrder({ DB }, 'admin-1', shipment(pending.order.id)), /A pending order cannot ship/);
  refusedByTrigger(pending.order.id, 'ful_pending');
  await pending.api.orders.cancel(pending.order.id);
  await assert.rejects(fulfillCommerceOrder({ DB }, 'admin-1', shipment(pending.order.id)), /A cancelled order cannot ship/);
  refusedByTrigger(pending.order.id, 'ful_cancelled');

  const refunded = await paidOrder(DB, 'refunded');
  await refund(refunded.api, refunded.order, refunded.order.totalAmount);
  await assert.rejects(fulfillCommerceOrder({ DB }, 'admin-1', shipment(refunded.order.id)), /A refunded order cannot ship/);
  refusedByTrigger(refunded.order.id, 'ful_refunded');

  // A later group adds the dispute status; the guard refuses it already.
  const disputed = await paidOrder(DB, 'disputed');
  sqlite.prepare(`UPDATE _ecommerce_orders SET status = 'disputed' WHERE id = ?`).run(disputed.order.id);
  await assert.rejects(fulfillCommerceOrder({ DB }, 'admin-1', shipment(disputed.order.id)), /A disputed order cannot ship/);
  refusedByTrigger(disputed.order.id, 'ful_disputed');

  const testApi = bindCommerceApi({ env: { DB }, paymentAdapters: [new AdminTestPaymentAdapter()] });
  const testCart = await testApi.carts.getOrCreate('admin-test');
  await testApi.carts.updateItems(testCart.id, [{ productId: 'case', quantity: 1 }]);
  const { order: testOrder } = await testApi.orders.createFromCart(testCart.id, { ...checkout, providerId: 'admin_test' });
  await testApi.orders.finalizePayment(testOrder.id, { provider: 'admin_test', providerId: testOrder.checkoutSessionId,
    paymentStatus: 'success', amount: testOrder.totalAmount, currency: 'usd' });
  assert.equal(state(sqlite, testOrder.id).status, 'paid');
  await assert.rejects(fulfillCommerceOrder({ DB }, 'admin-1', shipment(testOrder.id)), /Admin test orders cannot be fulfilled/);
  await assert.rejects(testApi.orders.updateStatus(testOrder.id, 'fulfilled'), /Admin test orders cannot be fulfilled/);
  refusedByTrigger(testOrder.id, 'ful_admin_test');

  // orders.updateStatus('fulfilled') records a completing shipment, once.
  const shipped = await paidOrder(DB, 'shipped');
  const updated = await shipped.api.orders.updateStatus(shipped.order.id, 'fulfilled',
    { actor: 'admin-1', carrier: null, trackingNumber: null, note: 'Collected in store' });
  assert.deepEqual([updated.status, updated.fulfillmentStatus], ['paid', 'fulfilled']);
  await assert.rejects(fulfillCommerceOrder({ DB }, 'admin-1', shipment(shipped.order.id)), /Order has already shipped in full/);
  refusedByTrigger(shipped.order.id, 'ful_again');

  await assert.rejects(fulfillCommerceOrder({ DB }, 'admin-1', shipment(shipped.order.id, { note: 'short' })),
    { name: 'FulfillmentInputError', message: /note/ });
  await assert.rejects(fulfillCommerceOrder({ DB }, ' ', shipment(pending.order.id)), /Administrator identity is required/);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM _ecommerce_fulfillments WHERE order_id <> ?`).get(shipped.order.id).n, 0);
  sqlite.close();
});

test('corrections must name a shipment of the same order and give a reason and a carrier or tracking number', async () => {
  const { sqlite, DB } = database();
  const first = await paidOrder(DB, 'first');
  const second = await paidOrder(DB, 'second');
  const { fulfillmentId } = await fulfillCommerceOrder({ DB }, 'admin-1', shipment(first.order.id));
  const correct = (input) => correctCommerceFulfillment({ DB }, 'admin-2', { fulfillmentId, carrier: 'UPS',
    trackingNumber: '1Z-NEW', reason: 'The label was reprinted', ...input });
  const insertCorrection = (values) => sqlite.prepare(`INSERT INTO _ecommerce_fulfillments
    (id, order_id, kind, corrects_id, completes_order, admin_actor, carrier, tracking_number, note, created_at)
    VALUES (?, ?, 'correction', ?, 0, 'admin-2', ?, ?, ?, ?)`).run(...values, NOW);

  // Written straight to the table, a correction that names another order's shipment is refused.
  assert.throws(() => insertCorrection(['ful_other', second.order.id, fulfillmentId, 'UPS', '1Z-NEW', 'Belongs to the other order']),
    /Shipment cannot be corrected/);
  assert.throws(() => insertCorrection(['ful_empty', first.order.id, fulfillmentId, ' ', null, 'Nothing to restate here']),
    /Shipment cannot be corrected/);
  assert.throws(() => insertCorrection(['ful_short', first.order.id, fulfillmentId, 'UPS', '1Z-NEW', 'short']),
    /Shipment cannot be corrected/);
  assert.throws(() => insertCorrection(['ful_missing', first.order.id, 'ful_unknown', 'UPS', '1Z-NEW', 'Names no shipment at all']),
    /Shipment cannot be corrected/);
  // A shipment names nothing, and a correction never completes an order.
  assert.throws(() => sqlite.prepare(`INSERT INTO _ecommerce_fulfillments (id, order_id, corrects_id, admin_actor, note, created_at)
    VALUES ('ful_named', ?, ?, 'admin-1', 'Parcel handed to carrier', ?)`).run(second.order.id, fulfillmentId, NOW), /CHECK constraint failed/);
  assert.throws(() => sqlite.prepare(`INSERT INTO _ecommerce_fulfillments
    (id, order_id, kind, corrects_id, completes_order, admin_actor, carrier, note, created_at)
    VALUES ('ful_completing', ?, 'correction', ?, 1, 'admin-2', 'UPS', 'The label was reprinted', ?)`).run(first.order.id, fulfillmentId, NOW),
  /CHECK constraint failed/);

  await assert.rejects(correct({ carrier: null, trackingNumber: '  ' }), { name: 'FulfillmentInputError', message: /Enter a carrier or a tracking number/ });
  await assert.rejects(correct({ reason: 'short' }), { name: 'FulfillmentInputError', message: /reason/ });
  await assert.rejects(correct({ fulfillmentId: 'ful_unknown' }), /Shipment not found/);
  const { correctionId } = await correct({});
  await assert.rejects(correct({ fulfillmentId: correctionId, trackingNumber: '1Z-OTHER' }), /Shipment not found/);
  await assert.rejects(correct({ orderId: second.order.id }), { name: 'FulfillmentInputError' });

  // An order that turned out to be a test order takes no corrections.
  sqlite.prepare(`UPDATE _ecommerce_orders SET payment_provider = 'admin_test' WHERE id = ?`).run(first.order.id);
  await assert.rejects(correct({ trackingNumber: '1Z-LATER' }), /Admin test orders cannot be fulfilled/);
  assert.throws(() => insertCorrection(['ful_test', first.order.id, fulfillmentId, 'UPS', '1Z-LATER', 'A test order correction']),
    /Shipment cannot be corrected/);
  sqlite.close();
});

test('what the previous Worker inserts still records a completing shipment', async () => {
  const { sqlite, DB } = database();
  const { order } = await paidOrder(DB, 'previous-worker');
  previousWorkerInsert(sqlite, 'ful_previous', order.id);
  assert.deepEqual(rowOf(sqlite, `SELECT kind, corrects_id, completes_order FROM _ecommerce_fulfillments WHERE id = 'ful_previous'`),
    { kind: 'shipment', corrects_id: null, completes_order: 1 });
  assert.deepEqual(state(sqlite, order.id), { status: 'paid', fulfillment_status: 'fulfilled' });
  // The previous Worker's admin list reads these columns, and the previous checks still hold.
  assert.equal(sqlite.prepare(`SELECT id, order_id, admin_actor, carrier, tracking_number, note, created_at
    FROM _ecommerce_fulfillments ORDER BY created_at DESC LIMIT 100`).all().length, 1);
  assert.throws(() => previousWorkerInsert(sqlite, 'ful_previous_again', order.id), /Order is not ready for fulfillment/);
  sqlite.close();
});

/** Orders written directly, as many as a busy store collects: `status`, provider and creation time vary. */
function insertOrder(sqlite, { id = `ord_${crypto.randomUUID()}`, status = 'paid', provider = 'stripe', createdAt = NOW,
  email = 'shopper@example.test', items = [{ productId: 'frame', variantId: 'frame-amber', quantity: 1, priceAtPurchase: 12000 }],
  amounts = {} } = {}) {
  const total = amounts.total ?? items.reduce((sum, item) => sum + item.priceAtPurchase * item.quantity, 0);
  sqlite.prepare(`INSERT INTO _ecommerce_orders (id, status, payment_provider, items, total_amount, subtotal_amount,
      discount_code, discount_amount, credit_applied, gift_card_applied, provider_refunded_cents, gift_card_refunded_cents,
      currency, customer_email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'usd', ?, ?, ?)`)
    .run(id, status, provider, JSON.stringify(items), total, amounts.subtotal ?? total, amounts.discountCode ?? null,
      amounts.discount ?? 0, amounts.credit ?? 0, amounts.giftCard ?? 0, amounts.providerRefunded ?? 0,
      amounts.giftCardRefunded ?? 0, email, createdAt, createdAt);
  return id;
}

const byPosition = (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

test('the queue lists every order awaiting shipment across pages, and the server counts them', async () => {
  const { sqlite, DB } = database();
  // 150 paid orders; every three share a creation second, so pages must break ties by id.
  const paid = Array.from({ length: 150 }, (_, index) => ({ createdAt: NOW - 10_000 + Math.floor(index / 3) }))
    .map((order) => ({ ...order, id: insertOrder(sqlite, { createdAt: order.createdAt }) }));
  const partiallyRefunded = Array.from({ length: 5 }, (_, index) => ({ createdAt: NOW - 20_000 + index }))
    .map((order) => ({ ...order, id: insertOrder(sqlite, { ...order, status: 'partially_refunded', amounts: { providerRefunded: 100 } }) }));
  for (const status of ['pending', 'cancelled', 'refunded', 'draft']) insertOrder(sqlite, { status, createdAt: NOW - 5_000 });
  for (let index = 0; index < 4; index++) insertOrder(sqlite, { provider: 'admin_test', createdAt: NOW - 30_000 });
  const shipped = paid.filter((_, index) => index % 7 === 0);
  const partlyShipped = paid.filter((_, index) => index % 7 === 1).slice(0, 5);
  for (const order of shipped) await fulfillCommerceOrder({ DB }, 'admin-1', shipment(order.id));
  for (const order of partlyShipped) await fulfillCommerceOrder({ DB }, 'admin-1', shipment(order.id, { completesOrder: false }));
  const expected = [...paid.filter((order) => !shipped.includes(order)), ...partiallyRefunded].sort(byPosition).map((order) => order.id);
  assert.equal(expected.length, 150 - shipped.length + 5);

  const listed = [];
  const counts = new Set();
  let cursor = null;
  let pages = 0;
  do {
    const page = await listCommerceOrdersAdmin({ DB }, { cursor, limit: 50 });
    assert.ok(page.orders.length <= 50);
    listed.push(...page.orders.map((order) => order.id));
    counts.add(page.awaitingCount);
    cursor = page.nextCursor;
    pages++;
  } while (cursor);
  assert.deepEqual(listed, expected, 'every awaiting order once, oldest first');
  assert.deepEqual([...counts], [expected.length]);
  assert.equal(pages, Math.ceil(expected.length / 50));
  assert.deepEqual((await listCommerceOrdersAdmin({ DB }, { limit: 100 })).orders.filter((order) => order.fulfillmentStatus === 'partially_fulfilled')
    .map((order) => order.id).sort(), partlyShipped.map((order) => order.id).sort());

  // All recent orders: real orders past checkout, newest first, paged the other way.
  const recent = [];
  cursor = null;
  do {
    const page = await listCommerceOrdersAdmin({ DB }, { view: 'recent', cursor, limit: 100 });
    recent.push(...page.orders);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(recent.length, 150 + 5 + 1);
  const position = (order) => ({ id: order.id, createdAt: Date.parse(order.createdAt) });
  assert.deepEqual(recent.map((order) => order.id),
    [...recent].sort((a, b) => byPosition(position(b), position(a))).map((order) => order.id), 'newest first');
  assert.ok(recent.every((order) => !['pending', 'cancelled', 'draft'].includes(order.status) && order.paymentProvider !== 'admin_test'));
  sqlite.close();
});

test('a page cursor carries any order id and only fits its own view', async () => {
  const { sqlite, DB } = database();
  // Orders written straight to D1, or through orders.create with an id of the caller's choosing, may
  // have ids that are not ASCII or are far longer than the ones checkout writes.
  const ids = ['ord_ä-first', 'ord_ö-second', 'ord_ü-third', `ord_${'x'.repeat(1_000)}`]
    .map((id) => insertOrder(sqlite, { id, createdAt: NOW }));
  const seen = [];
  let cursor = null;
  do {
    const page = await listCommerceOrdersAdmin({ DB }, { cursor, limit: 1 });
    seen.push(...page.orders.map((order) => order.id));
    cursor = page.nextCursor;
    if (cursor) {
      assert.match(cursor, /^[A-Za-z0-9_-]+$/, 'URL-safe');
      await assert.rejects(listCommerceOrdersAdmin({ DB }, { view: 'recent', cursor }), { name: 'FulfillmentInputError' });
    }
  } while (cursor);
  assert.deepEqual(seen, [...ids].sort());
  sqlite.close();
});

test('queue rows carry product names, variant labels, SKUs and labelled amounts', async () => {
  const { sqlite, DB } = database();
  const items = [
    { productId: 'frame', variantId: 'frame-amber', quantity: 1, priceAtPurchase: 12000 },
    { productId: 'frame', variantId: 'frame-smoke', quantity: 1, priceAtPurchase: 3000 },
    { productId: 'strap', variantId: 'strap-black', quantity: 1, priceAtPurchase: 1500 },
    { productId: 'case', quantity: 1, priceAtPurchase: 2000 },
    { productId: 'scarf', variantId: 'scarf-large', quantity: 1, priceAtPurchase: 1000 },
    { productId: 'retired-product', quantity: 1, priceAtPurchase: 500 },
  ];
  const id = insertOrder(sqlite, { items, email: 'Mixed.Case@Example.test', amounts: { subtotal: 20000, discountCode: 'SPRING',
    discount: 2000, credit: 1000, giftCard: 3000, total: 14000, providerRefunded: 500, giftCardRefunded: 1000 } });
  const [order] = (await listCommerceOrdersAdmin({ DB }, { query: 'mixed.case@example.TEST' })).orders;
  assert.equal(order.id, id);
  assert.deepEqual(order.items.map(({ productName, variantLabel, sku, quantity, lineTotal }) =>
    ({ productName, variantLabel, sku, quantity, lineTotal })), [
    { productName: 'Mycelium frame', variantLabel: 'Lens: Amber', sku: 'TAL-FRAME-AMB', quantity: 1, lineTotal: 12000 },
    { productName: 'Mycelium frame', variantLabel: 'Lens: Smoke', sku: 'TAL-FRAME-LENS', quantity: 1, lineTotal: 3000 },
    { productName: 'Strap', variantLabel: 'Colour: Black', sku: 'TAL-STRAP', quantity: 1, lineTotal: 1500 },
    { productName: 'Travel case', variantLabel: null, sku: 'TAL-CASE', quantity: 1, lineTotal: 2000 },
    { productName: 'Scarf', variantLabel: 'Large', sku: 'SCARF-L', quantity: 1, lineTotal: 1000 },
    { productName: null, variantLabel: null, sku: null, quantity: 1, lineTotal: 500 },
  ]);
  assert.deepEqual(order.amounts, [
    { key: 'itemsSubtotal', label: 'Items subtotal', cents: 20000 },
    { key: 'discount', label: 'Discount (SPRING)', cents: -2000 },
    { key: 'storeCredit', label: 'Store credit', cents: -1000 },
    { key: 'giftCard', label: 'Gift card', cents: -3000 },
    { key: 'charged', label: 'Charged by the payment provider', cents: 14000 },
    { key: 'providerRefunded', label: 'Refunded by the payment provider', cents: 500 },
    { key: 'giftCardRefunded', label: 'Refunded to the gift card', cents: 1000 },
  ]);
  assert.equal((await listCommerceOrdersAdmin({ DB }, { query: id })).orders[0].id, id);
  assert.deepEqual((await listCommerceOrdersAdmin({ DB }, { query: 'nobody@example.test' })).orders, []);

  // An order with more distinct products than one statement may bind is read in chunks.
  const many = Array.from({ length: 120 }, (_, index) => ({ productId: `bulk-${index}`, quantity: 1, priceAtPurchase: 100 }));
  for (const item of many) {
    sqlite.prepare(`INSERT INTO _ecommerce_products (id, name, slug, sku, base_price, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 100, 'active', ?, ?)`).run(item.productId, `Bulk ${item.productId}`, item.productId, `SKU-${item.productId}`, NOW, NOW);
  }
  const bulkId = insertOrder(sqlite, { items: many, email: 'bulk@example.test' });
  const [bulk] = (await listCommerceOrdersAdmin({ DB }, { query: bulkId })).orders;
  assert.deepEqual(bulk.items.map((item) => item.sku), many.map((item) => `SKU-${item.productId}`));
  assert.deepEqual(bulk.amounts, [
    { key: 'itemsSubtotal', label: 'Items subtotal', cents: 12000 },
    { key: 'charged', label: 'Charged by the payment provider', cents: 12000 },
  ]);
  sqlite.close();
});

test('the queue queries use the orders and fulfillments indexes', async () => {
  const { sqlite, DB, recorded } = database();
  for (let index = 0; index < 12; index++) insertOrder(sqlite, { createdAt: NOW - index, email: `buyer${index}@example.test` });
  const plans = async (options) => {
    recorded.length = 0;
    await listCommerceOrdersAdmin({ DB }, options);
    return recorded.filter(([sql]) => /FROM _ecommerce_orders|from "_ecommerce_fulfillments"/.test(sql)).map(([sql, values]) => ({
      sql: sql.replace(/\s+/g, ' ').trim().slice(0, 40),
      plan: sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map((step) => step.detail).join(' | '),
    }));
  };
  const first = await listCommerceOrdersAdmin({ DB }, { limit: 5 });
  const firstRecent = await listCommerceOrdersAdmin({ DB }, { view: 'recent', limit: 5 });
  const cases = [
    [{ limit: 5 }, /_ecommerce_orders_awaiting_idx/],
    [{ limit: 5, cursor: first.nextCursor }, /SEARCH _ecommerce_orders USING INDEX _ecommerce_orders_awaiting_idx \(\(created_at,id\)>\(\?,\?\)\)/],
    [{ view: 'recent', limit: 5 }, /_ecommerce_orders_recent_idx/],
    [{ view: 'recent', limit: 5, cursor: firstRecent.nextCursor }, /SEARCH _ecommerce_orders USING INDEX _ecommerce_orders_recent_idx \(\(created_at,id\)<\(\?,\?\)\)/],
    [{ query: 'buyer3@example.test' }, /_ecommerce_orders_customer_email_idx/],
  ];
  for (const [options, index] of cases) {
    const [count, page, ...rest] = await plans(options);
    assert.match(count.plan, /^SCAN _ecommerce_orders USING (COVERING )?INDEX _ecommerce_orders_awaiting_idx$/, `count: ${count.plan}`);
    assert.match(page.plan, index, `${JSON.stringify(options)}: ${page.plan}`);
    if (!options.query) assert.doesNotMatch(page.plan, /TEMP B-TREE/, 'the index gives the page its order');
    for (const shipments of rest) assert.match(shipments.plan, /SEARCH d0 USING INDEX _ecommerce_fulfillments_order_idx \(order_id=\?\)/);
    assert.equal(rest.length, 1, 'shipments are read once per page');
  }
  sqlite.close();
});

async function callRoute(env, { method = 'GET', search = '', body, raw, origin = ORIGIN, user = { id: 'admin-7', role: 'admin' } } = {}) {
  globalThis.workerEnv = env;
  globalThis.cmsUser = user;
  const request = new Request(`${ORIGIN}/admin/api/ecommerce/fulfillment${search}`, {
    method, headers: { ...(origin ? { origin } : {}), 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const response = await fulfillmentRoute({ request });
  return { status: response.status, json: await response.json(), cache: response.headers.get('cache-control') };
}

test('the admin route pages and searches the queue and records shipments and corrections', async () => {
  const { sqlite, DB } = database();
  const env = { DB };
  const ids = Array.from({ length: 3 }, (_, index) => insertOrder(sqlite, { id: `ord_00000000-0000-4000-8000-00000000000${index}`,
    createdAt: NOW - 100 + index, email: `route${index}@example.test` }));

  assert.equal((await callRoute(env, { user: null })).status, 401);
  assert.equal((await callRoute(env, { user: { id: 'editor-1', role: 'editor' } })).status, 403);
  const first = await callRoute(env, { search: '?limit=2' });
  assert.deepEqual([first.status, first.cache, first.json.view, first.json.pageSize, first.json.awaitingCount],
    [200, 'no-store', 'awaiting', 2, 3]);
  assert.deepEqual(first.json.orders.map((order) => order.id), ids.slice(0, 2));
  const next = await callRoute(env, { search: `?limit=2&cursor=${encodeURIComponent(first.json.nextCursor)}` });
  assert.deepEqual([next.json.orders.map((order) => order.id), next.json.nextCursor], [ids.slice(2), null]);
  const recent = await callRoute(env, { search: '?view=recent&limit=1' });
  assert.deepEqual(recent.json.orders.map((order) => order.id), [ids[2]]);
  assert.deepEqual((await callRoute(env, { search: '?query=ROUTE1%40example.test' })).json.orders.map((order) => order.id), [ids[1]]);
  for (const search of ['?view=everything', '?limit=0', '?limit=101', '?limit=ten', '?cursor=not-a-cursor',
    `?view=recent&cursor=${encodeURIComponent(first.json.nextCursor)}`]) {
    const refused = await callRoute(env, { search });
    assert.equal(refused.status, 400, search);
    assert.equal(refused.cache, 'no-store');
    assert.equal(typeof refused.json.error, 'string');
  }

  const post = (body, options = {}) => callRoute(env, { method: 'POST', body, ...options });
  assert.equal((await post({ action: 'ship', ...shipment(ids[0]) }, { origin: 'https://evil.example.test' })).status, 403);

  // The admin screen reads the queue with a POST body, so an email it searches for never appears
  // in a request URL, where request logs would keep it.
  const searched = await post({ action: 'list', view: 'awaiting', limit: 2, query: 'ROUTE1@example.test' });
  assert.deepEqual([searched.status, searched.cache, searched.json.view, searched.json.awaitingCount,
    searched.json.orders.map((order) => order.id)], [200, 'no-store', 'awaiting', 3, [ids[1]]]);
  const posted = await post({ action: 'list', limit: 2, cursor: first.json.nextCursor });
  assert.deepEqual([posted.json.orders.map((order) => order.id), posted.json.nextCursor], [ids.slice(2), null]);
  assert.deepEqual((await post({ action: 'list', view: 'recent', cursor: null, query: null })).json.orders.map((order) => order.id),
    [...ids].reverse());
  for (const body of [{ action: 'list', limit: 0 }, { action: 'list', view: 'everything' }, { action: 'list', orderId: ids[0] }]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await post({ action: 'list', query: 'route1@example.test' }, { origin: 'https://evil.example.test' })).status, 403);
  // A read that fails is a server error, not a refused write.
  const broken = { DB: { prepare() { throw new Error('D1 is unavailable'); }, batch: async () => { throw new Error('D1 is unavailable'); } } };
  assert.equal((await callRoute(broken)).status, 500);
  assert.equal((await callRoute(broken, { method: 'POST', body: { action: 'list' } })).status, 500);
  // A body without an action that names an order records a shipment, as clients sent before actions existed.
  const legacy = await post({ orderId: ids[0], carrier: 'USPS', trackingNumber: 'TRACK-1', note: 'Parcel handed to carrier' });
  assert.deepEqual([legacy.status, legacy.json.result.fulfillmentStatus], [200, 'fulfilled']);
  assert.equal(sqlite.prepare('SELECT admin_actor FROM _ecommerce_fulfillments WHERE id = ?').get(legacy.json.result.fulfillmentId).admin_actor, 'admin-7');
  const again = await post({ action: 'ship', ...shipment(ids[0]) });
  assert.deepEqual([again.status, again.json.error], [409, 'Order has already shipped in full']);
  const partial = await post({ action: 'ship', ...shipment(ids[1], { completesOrder: false }) });
  assert.deepEqual([partial.status, partial.json.result.fulfillmentStatus], [200, 'partially_fulfilled']);
  assert.equal((await post({ action: 'ship', ...shipment('ord_not-an-id') })).status, 400);
  assert.equal((await post({ action: 'ship', ...shipment(ids[2], { completesOrder: 'yes' }) })).status, 400);

  const corrected = await post({ action: 'correct', fulfillmentId: legacy.json.result.fulfillmentId, carrier: 'USPS',
    trackingNumber: 'TRACK-2', reason: 'The label was reprinted' });
  assert.deepEqual([corrected.status, corrected.json.result.trackingNumber], [200, 'TRACK-2']);
  const empty = await post({ action: 'correct', fulfillmentId: legacy.json.result.fulfillmentId, reason: 'Nothing to restate' });
  assert.deepEqual([empty.status, empty.json.error], [400, 'Enter a carrier or a tracking number']);
  assert.equal((await post({ action: 'correct', fulfillmentId: 'ful_unknown', carrier: 'UPS', reason: 'Names no shipment' })).status, 409);
  for (const body of [{ action: 'refund', orderId: ids[2] }, { carrier: 'UPS' }, [], null]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await callRoute(env, { method: 'POST', raw: '{not json' })).status, 400);
  assert.equal((await callRoute(env, { method: 'PUT', body: {} })).status, 405);

  const listed = await callRoute(env, { search: '?view=recent' });
  const shippedOrder = listed.json.orders.find((order) => order.id === ids[0]);
  assert.deepEqual([shippedOrder.shipments[0].trackingNumber, shippedOrder.shipments[0].recorded.trackingNumber,
    shippedOrder.shipments[0].corrections[0].adminActor], ['TRACK-2', 'TRACK-1', 'admin-7']);
  assert.equal(listed.json.awaitingCount, 2);
  sqlite.close();
});

test('shoppers see the fulfillment status, and a legacy fulfilled order still counts as a purchase', async () => {
  const { sqlite, DB } = database();
  const { order } = await paidOrder(DB, 'shopper-browser');
  assert.ok(order.userId);
  assert.deepEqual((await listCustomerOrders({ DB }, order.userId)).map((item) => [item.id, item.status, item.fulfillmentStatus]),
    [[order.id, 'paid', 'unfulfilled']]);
  await fulfillCommerceOrder({ DB }, 'admin-1', shipment(order.id));
  assert.deepEqual((await listCustomerOrders({ DB }, order.userId)).map((item) => [item.status, item.fulfillmentStatus]),
    [['paid', 'fulfilled']]);

  globalThis.workerEnv = { DB };
  const request = new Request(`${ORIGIN}/api/ecommerce/order?order=${order.id}`);
  const cookies = { get: (name) => (name === 'talisman-cart' ? { value: 'shopper-browser' } : undefined) };
  const response = await orderRoute({ request, cookies });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual([body.orderId, body.status, body.fulfillmentStatus], [order.id, 'paid', 'fulfilled']);

  // Rows that still read 'fulfilled' (written straight to D1 after migration 0026, say) count as a purchase.
  const legacy = insertOrder(sqlite, { email: 'legacy@example.test' });
  sqlite.prepare(`UPDATE _ecommerce_orders SET status = 'fulfilled' WHERE id = ?`).run(legacy);
  assert.equal(await hasPurchaseHistory({ DB }, { emails: ['legacy@example.test'] }), true);
  sqlite.close();
});
