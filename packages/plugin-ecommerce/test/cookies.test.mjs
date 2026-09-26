import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { bindCommerceApi } from '../dist/api.js';
import { CUSTOMER_SESSION_COOKIE } from '../dist/accounts.js';
import { CART_SESSION_COOKIE, CART_SESSION_MAX_AGE, LEGACY_CART_SESSION_COOKIE, ensureCartSession,
  giftCardAccessCookie, legacyGiftCardAccessCookie, readCartSessionToken, readGiftCardAccessToken } from '../dist/cookies.js';

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
    }
  };
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

// Component sources ship as TypeScript; Node can only load them with type stripping.
const needsTypeStripping = process.features.typescript ? false : 'Node type stripping is unavailable';

test('cookie names match what the plugin sets and storefronts read', () => {
  assert.equal(CART_SESSION_COOKIE, 'talisman-cart');
  assert.equal(LEGACY_CART_SESSION_COOKIE, 'galaxy-cart');
  assert.equal(giftCardAccessCookie('gcp_1'), 'talisman-gift-gcp_1');
  assert.equal(legacyGiftCardAccessCookie('gcp_1'), 'galaxy-gift-gcp_1');
});

test('the cart session adopts a legacy basket cookie once', () => {
  const jar = cookieJar({ [LEGACY_CART_SESSION_COOKIE]: 'anon_legacy' });
  assert.equal(ensureCartSession(jar, true), 'anon_legacy');
  assert.deepEqual(jar.writes, [
    ['delete', LEGACY_CART_SESSION_COOKIE, { path: '/' }],
    ['set', CART_SESSION_COOKIE, 'anon_legacy',
      { path: '/', httpOnly: true, sameSite: 'lax', secure: true, maxAge: CART_SESSION_MAX_AGE }],
  ]);
  jar.writes.length = 0;
  assert.equal(ensureCartSession(jar, true), 'anon_legacy');
  assert.deepEqual(jar.writes, []);
});

test('a current basket cookie wins over a legacy one, and a missing one is minted', () => {
  const both = cookieJar({ [CART_SESSION_COOKIE]: 'anon_current', [LEGACY_CART_SESSION_COOKIE]: 'anon_legacy' });
  assert.equal(readCartSessionToken(both), 'anon_current');
  assert.equal(ensureCartSession(both, false), 'anon_current');
  assert.deepEqual(both.writes, [['delete', LEGACY_CART_SESSION_COOKIE, { path: '/' }]]);

  const empty = cookieJar();
  const minted = ensureCartSession(empty, false);
  assert.match(minted, /^anon_[0-9a-f-]{36}$/);
  assert.equal(empty.values.get(CART_SESSION_COOKIE), minted);
  assert.equal(empty.writes[0][3].secure, false);
});

test('cookie readers fall back to legacy names without writing', () => {
  const legacy = cookieJar({ [LEGACY_CART_SESSION_COOKIE]: 'anon_legacy', 'galaxy-gift-gcp_1': 'legacy-gift' });
  assert.equal(readCartSessionToken(legacy), 'anon_legacy');
  assert.equal(readGiftCardAccessToken(legacy, 'gcp_1'), 'legacy-gift');
  assert.deepEqual(legacy.writes, []);

  const current = cookieJar({ 'talisman-gift-gcp_1': 'gift', 'galaxy-gift-gcp_1': 'legacy-gift' });
  assert.equal(readGiftCardAccessToken(current, 'gcp_1'), 'gift');
  assert.equal(readGiftCardAccessToken(current, ''), undefined);
  assert.equal(readCartSessionToken(cookieJar()), undefined);
});

test('cart view state cannot close its script tag', { skip: needsTypeStripping }, async () => {
  const { serializeJsonForScript } = await import('../src/components/json-script.ts');
  const state = {
    items: [{ productName: '</script><img src=x onerror=alert(1)>', variantLabel: 'A & B \u2028\u2029' }],
    locked: false,
  };
  const serialized = serializeJsonForScript(state);
  assert.doesNotMatch(serialized, /[<>&\u2028\u2029]/);
  assert.deepEqual(JSON.parse(serialized), state);
});

test('the cart badge counts a signed-in basket without detaching or creating carts', { skip: needsTypeStripping }, async () => {
  const { readCartItemCount } = await import('../src/components/cart-count.ts');
  const { sqlite, DB } = database();
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('shopper', 'shopper@example.test', 'shopper@example.test', now, now, now);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_sessions
    (id, account_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run('session', 'shopper', createHash('sha256').update('shopper-token').digest('hex'), now + 3600, now);
  for (const id of ['mycelium', 'forrest']) {
    sqlite.prepare(`INSERT INTO _ecommerce_products (id, name, slug, base_price, status, created_at, updated_at)
      VALUES (?, ?, ?, 12000, 'active', ?, ?)`).run(id, id, id, now, now);
  }
  const api = bindCommerceApi({ env: { DB } });
  const owned = await api.carts.getOrCreate('browser', 'shopper');
  await api.carts.updateItems(owned.id, [{ productId: 'mycelium', quantity: 2 }]);
  const carts = () => sqlite.prepare('SELECT id, session_token, user_id, version FROM _ecommerce_carts ORDER BY id').all();
  const before = carts();

  const signedIn = cookieJar({ [CART_SESSION_COOKIE]: 'browser', [CUSTOMER_SESSION_COOKIE]: 'shopper-token' });
  assert.equal(await readCartItemCount({ DB }, signedIn), 2);
  assert.equal(await readCartItemCount({ DB }, cookieJar({ [CUSTOMER_SESSION_COOKIE]: 'shopper-token' })), 2);
  // Without the shopper cookie the account basket stays hidden, and it keeps its browser token.
  assert.equal(await readCartItemCount({ DB }, cookieJar({ [CART_SESSION_COOKIE]: 'browser' })), 0);
  assert.equal(await readCartItemCount({ DB }, cookieJar({ [CART_SESSION_COOKIE]: 'unknown' })), 0);
  assert.deepEqual(carts(), before);
  assert.deepEqual(signedIn.writes, []);

  // As in claim(), a browser basket with items takes precedence over the account basket.
  const guest = await api.carts.getOrCreate('guest-browser');
  await api.carts.updateItems(guest.id, [{ productId: 'forrest', quantity: 1 }]);
  assert.equal(await readCartItemCount({ DB },
    cookieJar({ [CART_SESSION_COOKIE]: 'guest-browser', [CUSTOMER_SESSION_COOKIE]: 'shopper-token' })), 1);
  sqlite.close();
});
