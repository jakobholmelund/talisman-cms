import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { CUSTOMER_SESSION_COOKIE } from '../dist/accounts.js';
import { CART_SESSION_COOKIE } from '../dist/cookies.js';

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
const cartRoute = (await import('../dist/routes/ecommerce-cart.js')).ALL;
const checkoutRoute = (await import('../dist/routes/ecommerce-checkout.js')).POST;
const { ecommerceActions } = await import('../dist/actions.js');

const ORIGIN = 'https://shop.test';
/** The documented limit: new baskets per client network per hour. */
const NEW_BASKETS_PER_HOUR = 20;
const LIMIT_MESSAGE = 'Too many new baskets. Please try again later.';
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
    VALUES ('case', 'Case', 'case', 2000, 50, 'active', ?, ?)`).run(now, now);
  return { sqlite, DB };
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

async function call(route, env, { path, cookies = {}, body, ip } = {}) {
  globalThis.workerEnv = env;
  const jar = cookieJar(cookies);
  const request = new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'Content-Type': 'application/json', ...(ip ? { 'cf-connecting-ip': ip } : {}) },
    body: JSON.stringify(body),
  });
  const response = await route({ request, cookies: jar });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, jar, headers: response.headers };
}

const caseLine = (quantity = 1) => [{ productId: 'case', quantity }];
const postCart = (DB, { ip, cookies, items = caseLine() } = {}) =>
  call(cartRoute, { DB }, { path: '/api/ecommerce/cart', body: { items }, cookies, ip });
const actionContext = (ip, cookies = cookieJar()) => ({
  cookies, url: new URL(`${ORIGIN}/_actions/addToCart`),
  request: new Request(`${ORIGIN}/_actions/addToCart`, { method: 'POST', headers: ip ? { 'cf-connecting-ip': ip } : {} }),
});
const count = (sqlite, table) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const basketCookie = (jar) => jar.values.get(CART_SESSION_COOKIE);

/** Creates `n` baskets from `ip` through the cart route, each in a fresh browser, and returns their cookies. */
async function createBaskets(DB, ip, n) {
  const tokens = [];
  for (let i = 0; i < n; i++) {
    const response = await postCart(DB, { ip });
    assert.equal(response.status, 200);
    tokens.push(basketCookie(response.jar));
  }
  return tokens;
}

function signInShopper(sqlite, accountId, token) {
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT OR IGNORE INTO _ecommerce_customer_accounts
    (id, email, email_normalized, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(accountId, `${accountId}@example.test`, `${accountId}@example.test`, now, now, now);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_sessions (id, account_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(`session-${token}`, accountId, createHash('sha256').update(token).digest('hex'), now + 3600, now);
}

test('the cart route refuses a new basket over the per-network limit with 429, writing no row and no cookie', async () => {
  const { sqlite, DB } = database();
  await createBaskets(DB, '203.0.113.7', NEW_BASKETS_PER_HOUR);
  assert.equal(count(sqlite, '_ecommerce_carts'), NEW_BASKETS_PER_HOUR);

  const refused = await postCart(DB, { ip: '203.0.113.7' });
  assert.deepEqual([refused.status, refused.json], [429, { error: LIMIT_MESSAGE }]);
  // The window is one hour from its first counted request, so an hour is the longest wait.
  assert.equal(refused.headers.get('retry-after'), '3600');
  assert.deepEqual(refused.jar.writes, []);
  assert.equal(count(sqlite, '_ecommerce_carts'), NEW_BASKETS_PER_HOUR);
  // The counter key holds a digest of the network, never the address itself.
  const keys = sqlite.prepare('SELECT key FROM _ecommerce_rate_limits').all().map((row) => row.key);
  assert.equal(keys.length, 1);
  assert.ok(!keys[0].includes('203.0.113'));

  // Another network keeps its own allowance.
  const other = await postCart(DB, { ip: '198.51.100.20' });
  assert.equal(other.status, 200);
  assert.equal(count(sqlite, '_ecommerce_carts'), NEW_BASKETS_PER_HOUR + 1);
  sqlite.close();
});

test('an open basket can still be changed after its network reached the limit', async () => {
  const { sqlite, DB } = database();
  const [first] = await createBaskets(DB, '203.0.113.8', NEW_BASKETS_PER_HOUR);
  assert.equal((await postCart(DB, { ip: '203.0.113.8' })).status, 429);

  const cookies = { [CART_SESSION_COOKIE]: first };
  const updated = await postCart(DB, { ip: '203.0.113.8', cookies, items: caseLine(3) });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.json.items, [{ productId: 'case', quantity: 3 }]);
  const emptied = await postCart(DB, { ip: '203.0.113.8', cookies, items: [] });
  assert.deepEqual([emptied.status, emptied.json.items], [200, []]);

  globalThis.workerEnv = { DB };
  const added = await ecommerceActions.addToCart.handler({ productId: 'case', quantity: 2 },
    actionContext('203.0.113.8', cookieJar(cookies)));
  assert.deepEqual(added.cart.items, [{ productId: 'case', quantity: 2 }]);
  assert.equal(count(sqlite, '_ecommerce_carts'), NEW_BASKETS_PER_HOUR);
  // Changes to an open basket are not counted.
  assert.equal(sqlite.prepare('SELECT count FROM _ecommerce_rate_limits').get().count, NEW_BASKETS_PER_HOUR + 1);
  sqlite.close();
});

test('a signed-in shopper with an open account basket is not refused in a new browser', async () => {
  const { sqlite, DB } = database();
  signInShopper(sqlite, 'acct-limit', 'shopper-token');
  const shopper = { [CUSTOMER_SESSION_COOKIE]: 'shopper-token' };
  const created = await postCart(DB, { ip: '203.0.113.9', cookies: shopper });
  assert.equal(created.status, 200);
  await createBaskets(DB, '203.0.113.9', NEW_BASKETS_PER_HOUR - 1);
  assert.equal((await postCart(DB, { ip: '203.0.113.9' })).status, 429);

  const again = await postCart(DB, { ip: '203.0.113.9', cookies: shopper, items: caseLine(2) });
  assert.equal(again.status, 200);
  assert.equal(again.json.id, created.json.id);
  assert.equal(count(sqlite, '_ecommerce_carts'), NEW_BASKETS_PER_HOUR);
  sqlite.close();
});

test('requests refused by validation are not counted toward the limit, in the cart route and the addToCart action', async () => {
  const { sqlite, DB } = database();
  for (let i = 0; i < NEW_BASKETS_PER_HOUR + 5; i++) {
    const invalid = await postCart(DB, { ip: '203.0.113.10', items: [{ productId: 'invented', quantity: 1 }] });
    assert.equal(invalid.status, 400);
    const empty = await postCart(DB, { ip: '203.0.113.10', items: [] });
    assert.deepEqual([empty.status, empty.jar.writes], [200, []]);
    globalThis.workerEnv = { DB };
    const context = actionContext('203.0.113.10');
    await assert.rejects(ecommerceActions.addToCart.handler({ productId: 'invented', quantity: 1 }, context),
      { code: 'BAD_REQUEST' });
    assert.deepEqual(context.cookies.writes, []);
  }
  assert.equal(count(sqlite, '_ecommerce_rate_limits'), 0);
  await createBaskets(DB, '203.0.113.10', NEW_BASKETS_PER_HOUR);
  assert.equal((await postCart(DB, { ip: '203.0.113.10' })).status, 429);
  sqlite.close();
});

test('the addToCart action refuses a new basket over the limit with TOO_MANY_REQUESTS, writing no row and no cookie', async () => {
  const { sqlite, DB } = database();
  globalThis.workerEnv = { DB };
  for (let i = 0; i < NEW_BASKETS_PER_HOUR; i++) {
    const context = actionContext('192.0.2.44');
    await ecommerceActions.addToCart.handler({ productId: 'case', quantity: 1 }, context);
    assert.ok(basketCookie(context.cookies));
  }
  const refused = actionContext('192.0.2.44');
  await assert.rejects(ecommerceActions.addToCart.handler({ productId: 'case', quantity: 1 }, refused),
    { code: 'TOO_MANY_REQUESTS', message: LIMIT_MESSAGE });
  assert.deepEqual(refused.cookies.writes, []);
  assert.equal(count(sqlite, '_ecommerce_carts'), NEW_BASKETS_PER_HOUR);

  // The cart route and the action share one allowance per network.
  assert.equal((await postCart(DB, { ip: '192.0.2.44' })).status, 429);
  sqlite.close();
});

test('addresses in one IPv6 /64 share the limit and another /64 has its own', async () => {
  const { sqlite, DB } = database();
  for (let i = 0; i < NEW_BASKETS_PER_HOUR; i++) {
    const response = await postCart(DB, { ip: `2001:db8:5:6:${(i + 1).toString(16)}::${i + 2}` });
    assert.equal(response.status, 200);
  }
  for (const ip of ['2001:db8:5:6::1', '2001:DB8:5:6:ffff:ffff:ffff:ffff', '2001:0db8:0005:0006:0:0:0:abcd']) {
    const refused = await postCart(DB, { ip });
    assert.deepEqual([refused.status, refused.jar.writes], [429, []]);
  }
  globalThis.workerEnv = { DB };
  await assert.rejects(ecommerceActions.addToCart.handler({ productId: 'case', quantity: 1 }, actionContext('2001:db8:5:6::99')),
    { code: 'TOO_MANY_REQUESTS' });
  assert.equal((await postCart(DB, { ip: '2001:db8:5:7::1' })).status, 200);
  assert.equal(count(sqlite, '_ecommerce_carts'), NEW_BASKETS_PER_HOUR + 1);
  sqlite.close();
});

test('without a client IP basket creation is not limited', async () => {
  const { sqlite, DB } = database();
  await createBaskets(DB, undefined, NEW_BASKETS_PER_HOUR + 5);
  globalThis.workerEnv = { DB };
  for (let i = 0; i < 5; i++) {
    await ecommerceActions.addToCart.handler({ productId: 'case', quantity: 1 }, actionContext(undefined));
  }
  assert.equal(count(sqlite, '_ecommerce_carts'), NEW_BASKETS_PER_HOUR + 10);
  assert.equal(count(sqlite, '_ecommerce_rate_limits'), 0);
  sqlite.close();
});

test('with checkout enabled, the checkout route and action write nothing when there is no basket', async () => {
  const { sqlite, DB } = database();
  signInShopper(sqlite, 'acct-empty', 'empty-token');
  const env = { DB, TALISMAN_COMMERCE_CHECKOUT_ENABLED: 'true' };
  const details = { customerEmail: 'owner@example.test' };

  for (const cookies of [{ [CART_SESSION_COOKIE]: 'unknown-browser' },
    { [CART_SESSION_COOKIE]: 'unknown-browser', [CUSTOMER_SESSION_COOKIE]: 'empty-token' }]) {
    const response = await call(checkoutRoute, env, { path: '/api/ecommerce/checkout', cookies, body: details, ip: '203.0.113.11' });
    assert.deepEqual([response.status, response.json], [400, { error: 'Cart is empty' }]);
    assert.deepEqual(response.jar.writes, []);
  }

  globalThis.workerEnv = env;
  for (const initial of [{}, { [CART_SESSION_COOKIE]: 'unknown-browser' }, { [CUSTOMER_SESSION_COOKIE]: 'empty-token' }]) {
    const context = actionContext('203.0.113.11', cookieJar(initial));
    await assert.rejects(ecommerceActions.checkout.handler(details, context),
      { code: 'BAD_REQUEST', message: 'Cart is empty or not found' });
    assert.deepEqual(context.cookies.writes, []);
  }
  assert.equal(count(sqlite, '_ecommerce_carts'), 0);
  assert.equal(count(sqlite, '_ecommerce_orders'), 0);
  assert.equal(count(sqlite, '_ecommerce_rate_limits'), 0);
  sqlite.close();
});
