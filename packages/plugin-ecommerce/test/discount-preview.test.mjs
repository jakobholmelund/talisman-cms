import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { bindCommerceApi } from '../dist/api.js';
import { CUSTOMER_SESSION_COOKIE } from '../dist/accounts.js';
import { CART_SESSION_COOKIE } from '../dist/cookies.js';
import { DiscountCodeRefusal, evaluateDiscountCode } from '../dist/promotions.js';
import { GiftCardRefusal, evaluateGiftCard } from '../dist/gift-cards.js';

// Routes read their bindings from cloudflare:workers and the actions come from astro:actions.
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
const discountRoute = (await import('../dist/routes/ecommerce-discount.js')).POST;
const checkoutRoute = (await import('../dist/routes/ecommerce-checkout.js')).POST;
const { ecommerceActions } = await import('../dist/actions.js');

const ORIGIN = 'https://shop.test';
const REFUSED = 'This code is not valid for this order.';
// The limits documented in src/code-check-limits.ts, shared by the preview and checkout.
const NETWORK_LIMIT = 30;
const BASKET_LIMIT = 10;
const migrationFiles = ['0004_ecommerce_plugin.sql', '0005_variant_value_images.sql', '0007_local_auth.sql',
  '0008_shared_components.sql', '0010_checkout_inventory.sql', '0011_order_payment_provider.sql',
  '0012_customer_accounts.sql', '0013_referrals_and_credit.sql', '0014_promotions.sql',
  '0015_gift_cards.sql', '0016_verified_customer_sessions.sql', '0017_commerce_fulfillment.sql',
  '0019_shared_customer_identity.sql', '0024_shopper_sign_in_tokens.sql', '0025_order_shipping_and_tax.sql',
  '0026_order_fulfillment_status.sql', '0027_gift_card_review.sql'];

/** An in-memory D1 with two frames ($120 and $90) and a case ($20), recording every statement. */
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of migrationFiles) {
    const sql = readFileSync(new URL(`../../talisman-cms/drizzle/${migration}`, import.meta.url), 'utf8');
    sqlite.exec(sql.replaceAll('--> statement-breakpoint', ''));
  }
  const statements = [];
  const DB = {
    prepare(sql) {
      statements.push(sql);
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
    async batch(list) {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of list) result.push(await statement.all());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  const now = Math.floor(Date.now() / 1000);
  const product = sqlite.prepare(`INSERT INTO _ecommerce_products
    (id, name, slug, base_price, inventory_quantity, status, created_at, updated_at) VALUES (?, ?, ?, ?, 20, 'active', ?, ?)`);
  product.run('frame', 'Frame', 'frame', 12000, now, now);
  product.run('other', 'Other frame', 'other', 9000, now, now);
  product.run('case', 'Case', 'case', 2000, now, now);
  for (const id of ['frame', 'other']) {
    sqlite.prepare(`INSERT INTO _ecommerce_product_variants (id, product_id, name, inventory_quantity, created_at, updated_at)
      VALUES (?, ?, 'Lens', 20, ?, ?)`).run(`${id}-lens`, id, now, now);
    sqlite.prepare(`INSERT INTO _ecommerce_product_variant_values (id, product_variant_id, value, created_at, updated_at)
      VALUES (?, ?, 'Amber', ?, ?)`).run(`${id}-amber`, `${id}-lens`, now, now);
  }
  return { sqlite, DB, statements };
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

async function call(route, env, { path, cookies = {}, body, headers = {} }) {
  globalThis.workerEnv = env;
  const jar = cookieJar(cookies);
  const request = new Request(`${ORIGIN}${path}`, { method: 'POST',
    headers: { origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const response = await route({ request, cookies: jar });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, jar };
}

const enabled = (DB) => ({ DB, TALISMAN_COMMERCE_CHECKOUT_ENABLED: 'true' });
const stripeEnv = (DB) => ({ ...enabled(DB), TALISMAN_COMMERCE_STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: 'sk_test_discount_preview', STRIPE_WEBHOOK_SECRET: 'whsec_discount_preview' });
const preview = (DB, body, { basket, session, ip } = {}) => call(discountRoute, enabled(DB), {
  path: '/api/ecommerce/discount', body,
  cookies: { ...(basket ? { [CART_SESSION_COOKIE]: basket } : {}), ...(session ? { [CUSTOMER_SESSION_COOKIE]: session } : {}) },
  headers: ip ? { 'cf-connecting-ip': ip } : {} });
const shippingAddress = { name: 'Test Shopper', line1: '1 Main St', city: 'Austin', postalCode: '78701', country: 'US' };
const priced = { code: 'SAVE10', type: 'percent', discountAmount: 1200, creditApplied: 0,
  giftCardApplied: 0, giftCardSuffix: null, cardAmount: 10800 };

function addCode(sqlite, code, fields = {}) {
  const now = Math.floor(Date.now() / 1000);
  const row = { code, type: 'percent', value: 1000, active: 1, created_at: now, updated_at: now, ...fields };
  const columns = Object.keys(row);
  sqlite.prepare(`INSERT INTO _ecommerce_discount_codes (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...Object.values(row));
}

async function basket(DB, sessionToken, items = [{ productId: 'frame', variantId: 'frame-amber', quantity: 1 }]) {
  const api = bindCommerceApi({ env: { DB } });
  const cart = await api.carts.getOrCreate(sessionToken);
  await api.carts.updateItems(cart.id, items);
  return cart;
}

/** Stands in for Stripe when an order is placed directly through the API. */
const hostedCheckout = {
  providerId: 'stripe',
  async createCheckoutSession({ orderId }) {
    return { providerSessionId: `cs_test_${orderId}`, url: `https://checkout.stripe.test/${orderId}` };
  },
  async expireCheckoutSession() {},
  async getCheckoutSession() { return { status: 'open', url: 'https://checkout.stripe.test/open' }; },
};

/** Places an order for `customerEmail`, optionally with a code, and settles it when `paid`. */
async function placeOrder(DB, sessionToken, customerEmail, { discountCode, paid = false } = {}) {
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [hostedCheckout] });
  const cart = await basket(DB, sessionToken);
  const { order } = await api.orders.createFromCart(cart.id, { customerEmail, providerId: 'stripe', shippingAddress,
    discountCode, successUrl: `${ORIGIN}/checkout/success?order={ORDER_ID}`, cancelUrl: `${ORIGIN}/checkout/cancel?order={ORDER_ID}` });
  if (paid) {
    await api.orders.finalizePayment(order.id, { provider: 'stripe', providerId: order.checkoutSessionId,
      paymentStatus: 'success', amount: order.totalAmount, currency: 'usd', customerEmail });
  }
  return order;
}

function signIn(sqlite, accountId, token) {
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT OR IGNORE INTO _ecommerce_customer_accounts
    (id, email, email_normalized, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(accountId, `${accountId}@example.test`, `${accountId}@example.test`, now, now, now);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_sessions (id, account_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(`session-${token}`, accountId, createHash('sha256').update(token).digest('hex'), now + 3600, now);
}

/** A buyer with one paid order that used PERONE, signed in under `buyer-token`. */
async function returningBuyer(sqlite, DB) {
  addCode(sqlite, 'FIRST10', { first_order_only: 1 });
  addCode(sqlite, 'PERONE', { max_uses_per_customer: 1 });
  const order = await placeOrder(DB, 'buyer-first-browser', 'buyer@example.test', { discountCode: 'PERONE', paid: true });
  const accountId = sqlite.prepare('SELECT user_id FROM _ecommerce_orders WHERE id = ?').get(order.id).user_id;
  assert.ok(accountId);
  signIn(sqlite, accountId, 'buyer-token');
  return accountId;
}

function addGiftCard(sqlite, code, { balance = 5000, status = 'active' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_gift_cards (id, code_hash, code_suffix, encrypted_code, source,
    admin_actor, admin_reason, initial_cents, balance_cents, currency, status, created_at, updated_at)
    VALUES (?, ?, ?, 'unused', 'admin', 'admin@shop.test', 'Preview test card', 5000, ?, 'usd', ?, ?, ?)`)
    .run(`gift_${crypto.randomUUID()}`, createHash('sha256').update(code).digest('hex'), code.slice(-4), balance, status, now, now);
}

const giftCode = (digit) => `GIFT-${digit.toUpperCase().repeat(32)}`;

// --- Limits --------------------------------------------------------------------------------------

test('the discount preview answers 429 over the per-network limit, before reading a basket or code', async () => {
  const { sqlite, DB, statements } = database();
  addCode(sqlite, 'SAVE10');
  await basket(DB, 'network-browser');
  for (let index = 0; index < NETWORK_LIMIT; index += 1) {
    const response = await preview(DB, { code: 'SAVE10' }, { ip: '203.0.113.7' });
    assert.deepEqual([response.status, response.json], [404, { error: 'Basket not found' }]);
  }
  statements.length = 0;
  const limited = await preview(DB, { code: 'SAVE10' }, { basket: 'network-browser', ip: '203.0.113.7' });
  assert.deepEqual([limited.status, limited.json], [429, { error: 'Too many code checks. Please try again later.' }]);
  assert.deepEqual(statements.filter((sql) => !sql.includes('_ecommerce_rate_limits')), []);

  // IPv6 clients are counted per /64.
  for (let index = 0; index < NETWORK_LIMIT; index += 1) await preview(DB, { code: 'SAVE10' }, { ip: '2001:db8:1:2::1' });
  const sameNetwork = await preview(DB, { code: 'SAVE10' }, { basket: 'network-browser', ip: '2001:db8:1:2:ffff::9' });
  assert.equal(sameNetwork.status, 429);
  const otherNetwork = await preview(DB, { code: 'SAVE10' }, { basket: 'network-browser', ip: '2001:db8:1:3::1' });
  assert.deepEqual([otherNetwork.status, otherNetwork.json], [200, priced]);
  // Counters hold only digests of the client network.
  const keys = sqlite.prepare('SELECT key FROM _ecommerce_rate_limits').all().map((row) => row.key);
  assert.ok(keys.every((key) => !key.includes('203.0.113') && !key.includes('2001:db8')));
  sqlite.close();
});

test('the discount preview answers 429 over the per-basket limit, whatever the code', async () => {
  const { sqlite, DB } = database();
  addCode(sqlite, 'SAVE10');
  await basket(DB, 'busy-browser');
  await basket(DB, 'quiet-browser');
  for (let index = 0; index < BASKET_LIMIT; index += 1) {
    const response = await preview(DB, { code: index % 2 ? 'SAVE10' : 'NOPE10' }, { basket: 'busy-browser' });
    assert.equal(response.status, index % 2 ? 200 : 409);
  }
  for (const body of [{ code: 'SAVE10' }, { code: 'NOPE10' }, { giftCardCode: giftCode('a') }]) {
    const limited = await preview(DB, body, { basket: 'busy-browser' });
    assert.deepEqual([limited.status, limited.json], [429, { error: 'Too many code checks. Please try again later.' }]);
  }
  const other = await preview(DB, { code: 'SAVE10' }, { basket: 'quiet-browser' });
  assert.deepEqual([other.status, other.json], [200, priced]);
  sqlite.close();
});

// --- One refusal ---------------------------------------------------------------------------------

test('every refusal of an entered code gets the same status and body', async () => {
  const { sqlite, DB } = database();
  const now = Math.floor(Date.now() / 1000);
  addCode(sqlite, 'OFF10', { active: 0 });
  addCode(sqlite, 'LATER10', { starts_at: now + 86400 });
  addCode(sqlite, 'OLD10', { expires_at: now - 60 });
  addCode(sqlite, 'ONCE10', { max_uses: 1 });
  addCode(sqlite, 'BIG10', { min_order_cents: 50000 });
  addCode(sqlite, 'CASE10', { eligible_product_ids: '["case"]' });
  await placeOrder(DB, 'once-browser', 'someone@example.test', { discountCode: 'ONCE10' });
  const accountId = await returningBuyer(sqlite, DB);
  // Credit that leaves only the card minimum, so a card with a small balance cannot cover it.
  sqlite.prepare('UPDATE _ecommerce_customer_accounts SET credit_balance = 20000 WHERE id = ?').run(accountId);
  addGiftCard(sqlite, giftCode('b'), { status: 'suspended' });
  addGiftCard(sqlite, giftCode('c'), { balance: 0 });
  addGiftCard(sqlite, giftCode('d'), { balance: 10 });
  await basket(DB, 'guest-browser');
  await basket(DB, 'member-browser');
  const guest = { basket: 'guest-browser' };
  const member = { basket: 'member-browser', session: 'buyer-token' };

  const cases = [
    [{ code: '!!' }, guest, 'code'],
    [{ code: 'NOPE10' }, guest, 'code'],
    [{ code: 'OFF10' }, guest, 'code'],
    [{ code: 'LATER10' }, guest, 'code'],
    [{ code: 'OLD10' }, guest, 'code'],
    [{ code: 'ONCE10' }, guest, 'code'],
    [{ code: 'BIG10' }, guest, 'code'],
    [{ code: 'CASE10' }, guest, 'code'],
    [{ code: 'FIRST10' }, member, 'code'],
    [{ code: 'PERONE' }, member, 'code'],
    [{ giftCardCode: 'GIFT-123' }, guest, 'giftCardCode'],
    [{ giftCardCode: giftCode('a') }, guest, 'giftCardCode'],
    [{ giftCardCode: giftCode('b') }, guest, 'giftCardCode'],
    [{ giftCardCode: giftCode('c') }, guest, 'giftCardCode'],
    [{ giftCardCode: giftCode('d') }, member, 'giftCardCode'],
  ];
  for (const [body, who, field] of cases) {
    // Each reason is checked on its own; the limits have their own tests.
    sqlite.exec('DELETE FROM _ecommerce_rate_limits');
    const response = await preview(DB, body, who);
    assert.deepEqual([response.status, response.json], [409, { error: REFUSED, field }], JSON.stringify(body));
  }

  // Each case above is refused for its own reason, which callers read from the typed error.
  const lines = [{ productId: 'frame', quantity: 1, priceAtPurchase: 12000 }];
  const discountReason = (code, shopper = {}) => evaluateDiscountCode({ DB }, { code, lines, subtotal: 12000,
    customerEmail: '', checkShopperHistory: false, ...shopper }).then(() => 'accepted',
    (error) => (assert.ok(error instanceof DiscountCodeRefusal), error.reason));
  const history = { accountId, checkShopperHistory: true };
  assert.deepEqual(await Promise.all([discountReason('!!'), discountReason('NOPE10'), discountReason('OFF10'),
    discountReason('LATER10'), discountReason('OLD10'), discountReason('ONCE10'), discountReason('BIG10'),
    discountReason('CASE10'), discountReason('FIRST10', history), discountReason('PERONE', history),
    discountReason('FIRST10'), discountReason('PERONE')]),
  ['format', 'unknown', 'inactive', 'dates', 'dates', 'use_limit', 'not_applicable', 'not_applicable',
    'first_order', 'customer_limit', 'accepted', 'accepted']);
  const giftReason = (code, due) => evaluateGiftCard({ DB }, code, due).then(() => 'accepted',
    (error) => (assert.ok(error instanceof GiftCardRefusal), error.reason));
  assert.deepEqual(await Promise.all([giftReason('GIFT-123', 12000), giftReason(giftCode('a'), 12000),
    giftReason(giftCode('b'), 12000), giftReason(giftCode('c'), 12000), giftReason(giftCode('d'), 50)]),
  ['format', 'unavailable', 'unavailable', 'unavailable', 'cannot_cover']);
  // Other callers keep the detailed messages.
  await assert.rejects(evaluateDiscountCode({ DB }, { code: 'OLD10', lines, subtotal: 12000, customerEmail: 'a@example.test' }),
    { message: 'Discount code is outside its active dates' });
  // The same codes still price a basket they apply to.
  sqlite.exec('DELETE FROM _ecommerce_rate_limits');
  addGiftCard(sqlite, giftCode('e'));
  const accepted = await preview(DB, { giftCardCode: giftCode('e') }, guest);
  assert.deepEqual([accepted.status, accepted.json.giftCardApplied, accepted.json.cardAmount], [200, 5000, 7000]);
  sqlite.close();
});

test('basket problems keep their own answers, and the preview never creates a basket', async () => {
  const { sqlite, DB } = database();
  addCode(sqlite, 'SAVE10');
  await basket(DB, 'empty-browser', []);
  signIn(sqlite, 'new-shopper', 'new-token');
  const before = sqlite.prepare('SELECT * FROM _ecommerce_carts').all();

  const noCookie = await preview(DB, { code: 'SAVE10' });
  assert.deepEqual([noCookie.status, noCookie.json], [404, { error: 'Basket not found' }]);
  const empty = await preview(DB, { code: 'SAVE10' }, { basket: 'empty-browser' });
  assert.deepEqual([empty.status, empty.json], [409, { error: 'Basket is not available for discounts' }]);
  for (const who of [{ basket: 'unknown-browser' }, { basket: 'unknown-browser', session: 'new-token' }]) {
    const missing = await preview(DB, { code: 'SAVE10' }, who);
    assert.deepEqual([missing.status, missing.json], [409, { error: 'Basket is not available for discounts' }]);
    assert.deepEqual(missing.jar.writes, []);
  }
  assert.deepEqual(sqlite.prepare('SELECT * FROM _ecommerce_carts').all(), before);
  sqlite.close();
});

// --- Basket and signed-in account only -----------------------------------------------------------

test('an email in the preview body changes nothing', async () => {
  const { sqlite, DB } = database();
  addCode(sqlite, 'SAVE10');
  await returningBuyer(sqlite, DB);
  await basket(DB, 'guest-browser');
  for (const code of ['SAVE10', 'FIRST10', 'PERONE', 'NOPE10']) {
    const answers = [];
    for (const customerEmail of [undefined, 'buyer@example.test', 'fresh@example.test']) {
      sqlite.exec('DELETE FROM _ecommerce_rate_limits');
      const response = await preview(DB, { code, customerEmail }, { basket: 'guest-browser' });
      answers.push([response.status, response.json]);
    }
    assert.deepEqual(answers[1], answers[0], code);
    assert.deepEqual(answers[2], answers[0], code);
  }
  sqlite.close();
});

test('history rules are checked in the preview only for a signed-in shopper, and always at checkout', async () => {
  const { sqlite, DB } = database();
  await returningBuyer(sqlite, DB);
  signIn(sqlite, 'new-shopper', 'new-token');
  await basket(DB, 'guest-browser');
  await basket(DB, 'member-browser');
  await basket(DB, 'new-browser');
  const firstOrderPrice = { code: 'FIRST10', type: 'percent', discountAmount: 1200, creditApplied: 0,
    giftCardApplied: 0, giftCardSuffix: null, cardAmount: 10800 };

  // A guest has no verified address in the preview, so a first-order code is priced.
  const guest = await preview(DB, { code: 'FIRST10', customerEmail: 'buyer@example.test' }, { basket: 'guest-browser' });
  assert.deepEqual([guest.status, guest.json], [200, firstOrderPrice]);
  // A signed-in shopper is checked against their own account.
  const returning = await preview(DB, { code: 'FIRST10' }, { basket: 'member-browser', session: 'buyer-token' });
  assert.deepEqual([returning.status, returning.json], [409, { error: REFUSED, field: 'code' }]);
  const fresh = await preview(DB, { code: 'FIRST10', customerEmail: 'buyer@example.test' },
    { basket: 'new-browser', session: 'new-token' });
  assert.deepEqual([fresh.status, fresh.json], [200, firstOrderPrice]);

  // Checkout checks the rule against the checkout email and answers with the same message.
  const route = await call(checkoutRoute, stripeEnv(DB), { path: '/api/ecommerce/checkout',
    cookies: { [CART_SESSION_COOKIE]: 'guest-browser' },
    body: { customerEmail: 'buyer@example.test', shippingAddress, discountCode: 'FIRST10' } });
  assert.deepEqual([route.status, route.json], [409, { error: REFUSED, field: 'code' }]);
  globalThis.workerEnv = stripeEnv(DB);
  await assert.rejects(ecommerceActions.checkout.handler({ customerEmail: 'buyer@example.test', shippingAddress,
    discountCode: 'FIRST10' }, { cookies: cookieJar({ [CART_SESSION_COOKIE]: 'guest-browser' }),
    url: new URL(`${ORIGIN}/_actions/checkout`) }), { code: 'CONFLICT', message: REFUSED });
  const giftRefusal = await call(checkoutRoute, stripeEnv(DB), { path: '/api/ecommerce/checkout',
    cookies: { [CART_SESSION_COOKIE]: 'guest-browser' },
    body: { customerEmail: 'fresh@example.test', shippingAddress, giftCardCode: giftCode('f') } });
  assert.deepEqual([giftRefusal.status, giftRefusal.json], [409, { error: REFUSED, field: 'giftCardCode' }]);
  // The refused checkouts left the basket open and reserved nothing.
  const cart = sqlite.prepare(`SELECT checkout_session_id FROM _ecommerce_carts WHERE session_token = 'guest-browser'`).get();
  assert.equal(cart.checkout_session_id, null);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM _ecommerce_discount_redemptions WHERE code = 'FIRST10'`).get().n, 0);
  sqlite.close();
});

// --- Checkout shares the limits and the answer ---------------------------------------------------

const checkout = (DB, body, { basket: sessionToken, ip } = {}) => call(checkoutRoute, stripeEnv(DB), {
  path: '/api/ecommerce/checkout', cookies: { [CART_SESSION_COOKIE]: sessionToken },
  body: { customerEmail: 'fresh@example.test', shippingAddress, ...body },
  headers: ip ? { 'cf-connecting-ip': ip } : {} });
const checkoutAction = (DB, body, { basket: sessionToken, ip } = {}) => {
  globalThis.workerEnv = stripeEnv(DB);
  return ecommerceActions.checkout.handler({ customerEmail: 'fresh@example.test', shippingAddress, ...body }, {
    cookies: cookieJar({ [CART_SESSION_COOKIE]: sessionToken }), url: new URL(`${ORIGIN}/_actions/checkout`),
    request: new Request(`${ORIGIN}/_actions/checkout`, { method: 'POST', headers: ip ? { 'cf-connecting-ip': ip } : {} }) });
};
const TOO_MANY = { error: 'Too many code checks. Please try again later.' };

test('checkouts that carry a code count against the preview network limit', async () => {
  const { sqlite, DB, statements } = database();
  addCode(sqlite, 'SAVE10');
  await basket(DB, 'network-browser');
  await basket(DB, 'plain-browser');
  for (let index = 0; index < NETWORK_LIMIT; index += 1) await preview(DB, { code: 'SAVE10' }, { ip: '203.0.113.9' });
  statements.length = 0;
  for (const body of [{ discountCode: 'NOPE10' }, { giftCardCode: giftCode('a') }]) {
    const limited = await checkout(DB, body, { basket: 'network-browser', ip: '203.0.113.9' });
    assert.deepEqual([limited.status, limited.json], [429, TOO_MANY]);
    await assert.rejects(checkoutAction(DB, body, { basket: 'network-browser', ip: '203.0.113.9' }),
      { code: 'TOO_MANY_REQUESTS', message: TOO_MANY.error });
  }
  assert.ok(!statements.some((sql) => sql.includes('_ecommerce_discount_codes') || sql.includes('_ecommerce_gift_cards')));
  // A checkout without a code is not a code check: it goes on to the payment provider check.
  const plain = await call(checkoutRoute, enabled(DB), { path: '/api/ecommerce/checkout',
    cookies: { [CART_SESSION_COOKIE]: 'plain-browser' }, headers: { 'cf-connecting-ip': '203.0.113.9' },
    body: { customerEmail: 'fresh@example.test', shippingAddress } });
  assert.deepEqual([plain.status, plain.json],
    [409, { error: 'A payment provider must be selected and configured before checkout' }]);
  // Another network still has its code checks.
  const other = await checkout(DB, { discountCode: 'NOPE10' }, { basket: 'network-browser', ip: '198.51.100.4' });
  assert.deepEqual([other.status, other.json], [409, { error: REFUSED, field: 'code' }]);
  sqlite.close();
});

test('checkouts that carry a code count against the preview basket limit', async () => {
  const { sqlite, DB } = database();
  addCode(sqlite, 'SAVE10');
  await basket(DB, 'busy-browser');
  await basket(DB, 'action-browser');
  for (let index = 0; index < BASKET_LIMIT; index += 1) {
    const refused = await checkout(DB, { discountCode: `NOPE${index}X` }, { basket: 'busy-browser' });
    assert.deepEqual([refused.status, refused.json], [409, { error: REFUSED, field: 'code' }]);
  }
  const limited = await checkout(DB, { discountCode: 'NOPE10' }, { basket: 'busy-browser' });
  assert.deepEqual([limited.status, limited.json], [429, TOO_MANY]);
  const previewed = await preview(DB, { code: 'SAVE10' }, { basket: 'busy-browser' });
  assert.deepEqual([previewed.status, previewed.json], [429, TOO_MANY]);

  for (let index = 0; index < BASKET_LIMIT; index += 1) {
    await assert.rejects(checkoutAction(DB, { giftCardCode: giftCode('a') }, { basket: 'action-browser' }),
      { code: 'CONFLICT', message: REFUSED });
  }
  await assert.rejects(checkoutAction(DB, { discountCode: 'NOPE10' }, { basket: 'action-browser' }),
    { code: 'TOO_MANY_REQUESTS', message: TOO_MANY.error });
  sqlite.close();
});

test('a code taken between evaluation and reservation gets the same answer at checkout', async () => {
  const { sqlite, DB } = database();
  addCode(sqlite, 'FIRST10', { first_order_only: 1 });
  // The first order holds the first-order reservation for this email; it is not paid, so the code
  // passes evaluation and is refused when the second order reserves it. A gift card pays the rest,
  // so no payment provider is called.
  await placeOrder(DB, 'holder-browser', 'holder@example.test', { discountCode: 'FIRST10' });
  addGiftCard(sqlite, giftCode('e'));
  const caseOnly = [{ productId: 'case', quantity: 1 }];
  await basket(DB, 'route-browser', caseOnly);
  await basket(DB, 'action-browser', caseOnly);
  const body = { customerEmail: 'holder@example.test', discountCode: 'FIRST10', giftCardCode: giftCode('e') };
  const route = await checkout(DB, body, { basket: 'route-browser' });
  assert.deepEqual([route.status, route.json], [409, { error: REFUSED, field: 'code' }]);
  await assert.rejects(checkoutAction(DB, body, { basket: 'action-browser' }), { code: 'CONFLICT', message: REFUSED });
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM _ecommerce_discount_redemptions WHERE code = 'FIRST10'`).get().n, 1);
  sqlite.close();
});

test('the preview answers an overlong code with the same refusal and ignores a malformed email', async () => {
  const { sqlite, DB } = database();
  addCode(sqlite, 'SAVE10');
  await basket(DB, 'guest-browser');
  const long = await preview(DB, { code: 'A'.repeat(40) }, { basket: 'guest-browser' });
  assert.deepEqual([long.status, long.json], [409, { error: REFUSED, field: 'code' }]);
  const longGift = await preview(DB, { giftCardCode: `GIFT-${'A'.repeat(40)}` }, { basket: 'guest-browser' });
  assert.deepEqual([longGift.status, longGift.json], [409, { error: REFUSED, field: 'giftCardCode' }]);
  const email = await preview(DB, { code: 'SAVE10', customerEmail: 'not-an-email' }, { basket: 'guest-browser' });
  assert.deepEqual([email.status, email.json], [200, priced]);
  sqlite.close();
});
