import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { purgeStaleCommerceData } from '../dist/api.js';
import { CUSTOMER_SESSION_COOKIE } from '../dist/accounts.js';
import { CART_SESSION_COOKIE } from '../dist/cookies.js';
import { migrationSql } from './helpers/migrations.mjs';

// The cart route reads its bindings from cloudflare:workers; serve them from globalThis.workerEnv.
const workerModule = 'export const env = new Proxy({}, { get: (_, key) => globalThis.workerEnv?.[key] });';
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier !== 'cloudflare:workers') return next(specifier, context);
    return { shortCircuit: true, url: 'data:text/javascript,' + ${JSON.stringify(encodeURIComponent(workerModule))} };
  }`)}`);

const migrationFiles = ['0004_ecommerce_plugin.sql', '0005_variant_value_images.sql', '0007_local_auth.sql',
  '0008_shared_components.sql', '0010_checkout_inventory.sql', '0011_order_payment_provider.sql',
  '0012_customer_accounts.sql', '0013_referrals_and_credit.sql', '0014_promotions.sql',
  '0015_gift_cards.sql', '0016_verified_customer_sessions.sql', '0017_commerce_fulfillment.sql',
  '0019_shared_customer_identity.sql', '0024_shopper_sign_in_tokens.sql', '0025_order_shipping_and_tax.sql',
  '0026_order_fulfillment_status.sql', '0027_gift_card_review.sql', '0028_provider_refunds_and_disputes.sql',
  '0029_commerce_reconcile_backoff.sql', '0030_commerce_order_emails.sql'];

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of migrationFiles) {
    const sql = migrationSql(migration);
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
  // Baskets accept catalog products only.
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_products (id, name, slug, base_price, status, created_at, updated_at)
    VALUES ('frame', 'Frame', 'frame', 12000, 'draft', ?, ?)`).run(now, now);
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

async function cartRoute(DB, method, { cookies = {}, body, raw, headers = {}, origin = 'https://shop.test' } = {}) {
  globalThis.workerEnv = { DB };
  const { ALL } = await import('../dist/routes/ecommerce-cart.js');
  const jar = cookieJar(cookies);
  const request = new Request('https://shop.test/api/ecommerce/cart', {
    method, headers: { origin, 'Content-Type': 'application/json', ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    ...(raw instanceof ReadableStream ? { duplex: 'half' } : {})
  });
  const response = await ALL({ request, cookies: jar });
  return { status: response.status, json: await response.json(), jar, response };
}

const cartCount = (sqlite) => sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_carts').get().count;
const day = 24 * 60 * 60;

test('reading the basket without a cookie creates no cart row and sets no cookie', async () => {
  const { sqlite, DB } = database();
  const anonymous = await cartRoute(DB, 'GET');
  assert.equal(anonymous.status, 200);
  assert.deepEqual(anonymous.json, { id: null, items: [], locked: false });
  assert.deepEqual(anonymous.jar.writes, []);
  assert.equal(anonymous.response.headers.get('Cache-Control'), 'no-store');

  const unknown = await cartRoute(DB, 'GET', { cookies: { [CART_SESSION_COOKIE]: 'anon_unknown' } });
  assert.deepEqual(unknown.json, { id: null, items: [], locked: false });
  assert.deepEqual(unknown.jar.writes, []);

  const crossSite = await cartRoute(DB, 'POST', { origin: 'https://evil.test', body: { items: [] } });
  assert.equal(crossSite.status, 403);
  assert.deepEqual(crossSite.jar.writes, []);
  assert.equal(cartCount(sqlite), 0);
  sqlite.close();
});

test('the first POST creates the basket, and responses never carry its token', async () => {
  const { sqlite, DB } = database();
  const created = await cartRoute(DB, 'POST', { body: { items: [{ productId: 'frame', quantity: 2 }] } });
  assert.equal(created.status, 200);
  assert.equal(cartCount(sqlite), 1);
  const [write] = created.jar.writes;
  assert.equal(write[0], 'set');
  assert.equal(write[1], CART_SESSION_COOKIE);
  const token = write[2];
  const row = sqlite.prepare('SELECT id, session_token FROM _ecommerce_carts').get();
  assert.equal(row.session_token, token);
  assert.deepEqual(created.json, { id: row.id, items: [{ productId: 'frame', quantity: 2 }], locked: false });

  const read = await cartRoute(DB, 'GET', { cookies: { [CART_SESSION_COOKIE]: token } });
  assert.deepEqual(read.json, created.json);
  assert.doesNotMatch(JSON.stringify(read.json), new RegExp(token));
  assert.deepEqual(read.jar.writes, []);
  assert.equal(cartCount(sqlite), 1);
  sqlite.close();
});

test('a POST that adds nothing or is invalid creates no cart row and sets no cookie', async () => {
  const { sqlite, DB } = database();
  const empty = await cartRoute(DB, 'POST', { body: { items: [] } });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { id: null, items: [], locked: false });
  assert.deepEqual(empty.jar.writes, []);

  const unknownCookie = await cartRoute(DB, 'POST', { cookies: { [CART_SESSION_COOKIE]: 'anon_unknown' }, body: { items: [] } });
  assert.deepEqual(unknownCookie.json, { id: null, items: [], locked: false });
  assert.deepEqual(unknownCookie.jar.writes, []);

  for (const body of [{}, { items: 'frame' }, null]) {
    const invalid = await cartRoute(DB, 'POST', { body });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.json, { error: 'Cart items must be an array' });
    assert.deepEqual(invalid.jar.writes, []);
  }
  const notJson = await cartRoute(DB, 'POST', { raw: '{"items": [' });
  assert.equal(notJson.status, 400);
  assert.deepEqual(notJson.jar.writes, []);

  const declared = await cartRoute(DB, 'POST', { body: { items: [] }, headers: { 'Content-Length': String(64 * 1024 + 1) } });
  assert.equal(declared.status, 413);
  assert.deepEqual(declared.jar.writes, []);

  // A streamed body without a Content-Length is cut off at the limit instead of being buffered.
  let pulled = 0;
  const streamed = await cartRoute(DB, 'POST', { raw: new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new TextEncoder().encode(pulled === 1 ? '{"items":["' : 'x'.repeat(8 * 1024)));
    }
  }) });
  assert.equal(streamed.status, 413);
  assert.ok(pulled < 20);
  assert.deepEqual(streamed.jar.writes, []);
  assert.equal(cartCount(sqlite), 0);
  sqlite.close();
});

test('an empty item list still clears an existing basket', async () => {
  const { sqlite, DB } = database();
  const created = await cartRoute(DB, 'POST', { body: { items: [{ productId: 'frame', quantity: 1 }] } });
  const token = created.jar.writes[0][2];
  const cleared = await cartRoute(DB, 'POST', { cookies: { [CART_SESSION_COOKIE]: token }, body: { items: [] } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json, { id: created.json.id, items: [], locked: false });
  assert.deepEqual(cleared.jar.writes, []);
  assert.equal(sqlite.prepare('SELECT items FROM _ecommerce_carts').get().items, '[]');
  sqlite.close();
});

test('a signed-in shopper without a basket cookie reads the account basket without writes', async () => {
  const { sqlite, DB } = database();
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('shopper', 'shopper@example.test', 'shopper@example.test', now, now, now);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_sessions
    (id, account_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run('session', 'shopper', createHash('sha256').update('shopper-token').digest('hex'), now + 3600, now);
  sqlite.prepare(`INSERT INTO _ecommerce_carts (id, session_token, user_id, items, created_at, updated_at)
    VALUES ('owned', 'browser', 'shopper', '[{"productId":"frame","quantity":1}]', ?, ?)`).run(now, now);
  const before = sqlite.prepare('SELECT * FROM _ecommerce_carts').all();

  const read = await cartRoute(DB, 'GET', { cookies: { [CUSTOMER_SESSION_COOKIE]: 'shopper-token' } });
  assert.deepEqual(read.json, { id: 'owned', items: [{ productId: 'frame', quantity: 1 }], locked: false });
  assert.deepEqual(read.jar.writes, []);
  assert.deepEqual(sqlite.prepare('SELECT * FROM _ecommerce_carts').all(), before);
  sqlite.close();
});

test('the purge deletes idle guest baskets and keeps account, locked, checked-out and ordered ones', async () => {
  const { sqlite, DB } = database();
  const now = new Date('2026-09-25T12:00:00Z');
  const seconds = now.getTime() / 1000;
  const insert = sqlite.prepare(`INSERT INTO _ecommerce_carts
    (id, session_token, user_id, checkout_session_id, closed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insert.run('stale-guest', 'anon_stale', null, null, 0, seconds - 40 * day, seconds - 31 * day);
  insert.run('recent-guest', 'anon_recent', null, null, 0, seconds - 40 * day, seconds - 29 * day);
  insert.run('stale-account', null, 'acct_1', null, 0, seconds - 40 * day, seconds - 31 * day);
  insert.run('stale-locked', 'anon_locked', null, 'cs_locked', 0, seconds - 40 * day, seconds - 31 * day);
  insert.run('stale-closed', 'anon_closed', null, null, 1, seconds - 40 * day, seconds - 31 * day);
  insert.run('stale-ordered', 'anon_ordered', null, null, 0, seconds - 40 * day, seconds - 31 * day);
  sqlite.prepare(`INSERT INTO _ecommerce_orders (id, cart_id, total_amount, created_at, updated_at)
    VALUES ('ord_draft', 'stale-ordered', 1000, ?, ?)`).run(seconds - 31 * day, seconds - 31 * day);

  const deleted = await purgeStaleCommerceData({ env: { DB }, now });
  assert.deepEqual(deleted, { carts: 1, customerSessions: 0, signInTokens: 0, unverifiedAccounts: 0, rateLimits: 0,
    authSessions: 0, authRateLimits: 0 });
  assert.deepEqual(sqlite.prepare('SELECT id FROM _ecommerce_carts ORDER BY id').all().map((row) => row.id),
    ['recent-guest', 'stale-account', 'stale-closed', 'stale-locked', 'stale-ordered']);
  sqlite.close();
});

test('the purge deletes in bounded batches and finishes a backlog on later runs', async () => {
  const { sqlite, DB } = database();
  const now = new Date('2026-09-25T12:00:00Z');
  const seconds = now.getTime() / 1000;
  const insert = sqlite.prepare(`INSERT INTO _ecommerce_carts (id, session_token, created_at, updated_at)
    VALUES (?, ?, ?, ?)`);
  for (let index = 0; index < 25; index++) {
    insert.run(`cart_${index}`, `anon_${index}`, seconds - 60 * day, seconds - 60 * day);
  }
  assert.equal((await purgeStaleCommerceData({ env: { DB }, now, batchSize: 1 })).carts, 20);
  assert.equal(cartCount(sqlite), 5);
  assert.equal((await purgeStaleCommerceData({ env: { DB }, now, batchSize: 2 })).carts, 5);
  assert.equal(cartCount(sqlite), 0);
  sqlite.close();
});

test('the purge removes shopper sessions and sign-in links a day after they ended', async () => {
  const { sqlite, DB } = database();
  const now = new Date('2026-09-25T12:00:00Z');
  const seconds = now.getTime() / 1000;
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, created_at, updated_at) VALUES ('acct', 'a@example.test', 'a@example.test', ?, ?)`)
    .run(seconds, seconds);
  const insert = sqlite.prepare(`INSERT INTO _ecommerce_customer_sessions
    (id, account_id, token_hash, purpose, expires_at, created_at, revoked_at) VALUES (?, 'acct', ?, ?, ?, ?, ?)`);
  const rows = [
    ['active', 'session', seconds + 3600, seconds - 3600, null],
    ['expired-recently', 'session', seconds - 3600, seconds - 30 * day, null],
    ['expired-long-ago', 'session', seconds - 2 * day, seconds - 32 * day, null],
    ['signed-out-long-ago', 'session', seconds + 20 * day, seconds - 10 * day, seconds - 2 * day],
    ['signed-out-recently', 'session', seconds + 20 * day, seconds - 10 * day, seconds - 3600],
    ['link-fresh', 'email_challenge', seconds + 600, seconds - 300, null],
    ['link-used-recently', 'email_challenge', seconds + 600, seconds - 300, seconds - 200],
    ['link-used-long-ago', 'email_challenge', seconds - 2 * day + 900, seconds - 2 * day, seconds - 2 * day + 60],
    ['link-expired-long-ago', 'email_challenge', seconds - 2 * day + 900, seconds - 2 * day, null],
  ];
  for (const [id, purpose, expiresAt, createdAt, revokedAt] of rows) {
    insert.run(id, `hash-${id}`, purpose, expiresAt, createdAt, revokedAt);
  }

  const deleted = await purgeStaleCommerceData({ env: { DB }, now });
  assert.equal(deleted.customerSessions, 4);
  assert.deepEqual(sqlite.prepare('SELECT id FROM _ecommerce_customer_sessions ORDER BY id').all().map((row) => row.id),
    ['active', 'expired-recently', 'link-fresh', 'link-used-recently', 'signed-out-recently']);
  sqlite.close();
});

test('the purge removes expired CMS sessions and day-old rate-limit rows in either time unit', async () => {
  const { sqlite, DB } = database();
  const now = new Date('2026-09-25T12:00:00Z');
  const seconds = now.getTime() / 1000;
  const millis = now.getTime();
  sqlite.prepare(`INSERT INTO galaxy_auth_user (id, name, email, created_at, updated_at)
    VALUES ('editor', 'Editor', 'editor@example.test', ?, ?)`).run(seconds, seconds);
  const session = sqlite.prepare(`INSERT INTO galaxy_auth_session
    (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, 'editor')`);
  session.run('expired', seconds - 60, 'token-expired', seconds - day, seconds - day);
  session.run('valid', seconds + 3600, 'token-valid', seconds - 3600, seconds - 3600);
  const limit = sqlite.prepare(`INSERT INTO galaxy_auth_rate_limit (id, key, count, last_request) VALUES (?, ?, 1, ?)`);
  // better-auth records milliseconds; shopper counters written before migration 0024 are in seconds.
  limit.run('auth-old', '203.0.113.1/sign-in/email', millis - 25 * 60 * 60 * 1000);
  limit.run('auth-recent', '203.0.113.2/sign-in/email', millis - 60 * 60 * 1000);
  limit.run('shopper-old', 'shopper-email:old', seconds - 25 * 60 * 60);
  limit.run('shopper-recent', 'shopper-email:recent', seconds - 60 * 60);

  const deleted = await purgeStaleCommerceData({ env: { DB }, now });
  assert.deepEqual(deleted, { carts: 0, customerSessions: 0, signInTokens: 0, unverifiedAccounts: 0, rateLimits: 0,
    authSessions: 1, authRateLimits: 2 });
  assert.deepEqual(sqlite.prepare('SELECT id FROM galaxy_auth_session').all().map((row) => row.id), ['valid']);
  assert.deepEqual(sqlite.prepare('SELECT id FROM galaxy_auth_rate_limit ORDER BY id').all().map((row) => row.id),
    ['auth-recent', 'shopper-recent']);
  sqlite.close();
});

test('the purge removes sign-in links, with their address, a day after they expired or were used', async () => {
  const { sqlite, DB } = database();
  const now = new Date('2026-09-25T12:00:00Z');
  const seconds = now.getTime() / 1000;
  const insert = sqlite.prepare(`INSERT INTO _ecommerce_sign_in_tokens
    (token_hash, email_normalized, expires_at, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)`);
  const rows = [
    ['fresh', seconds + 600, seconds - 300, null],
    ['used-recently', seconds + 600, seconds - 300, seconds - 200],
    ['expired-recently', seconds - 3600, seconds - 3600 - 900, null],
    ['used-long-ago', seconds - 2 * day + 900, seconds - 2 * day, seconds - 2 * day + 60],
    ['expired-long-ago', seconds - 2 * day + 900, seconds - 2 * day, null],
  ];
  for (const [hash, expiresAt, createdAt, revokedAt] of rows) insert.run(hash, `${hash}@example.test`, expiresAt, createdAt, revokedAt);

  const deleted = await purgeStaleCommerceData({ env: { DB }, now });
  assert.equal(deleted.signInTokens, 2);
  assert.deepEqual(sqlite.prepare('SELECT token_hash FROM _ecommerce_sign_in_tokens ORDER BY token_hash').all().map((row) => row.token_hash),
    ['expired-recently', 'fresh', 'used-recently']);
  sqlite.close();
});

test('the purge removes day-old shopper counters and keeps current ones', async () => {
  const { sqlite, DB } = database();
  const now = new Date('2026-09-25T12:00:00Z');
  const seconds = now.getTime() / 1000;
  const insert = sqlite.prepare('INSERT INTO _ecommerce_rate_limits (key, count, window_start) VALUES (?, ?, ?)');
  insert.run('shopper-email:daily', 150, seconds - 23 * 60 * 60);
  insert.run('shopper-email:old-ip', 20, seconds - 25 * 60 * 60);
  insert.run('shopper-preview:recent-ip', 3, seconds - 60);
  const deleted = await purgeStaleCommerceData({ env: { DB }, now });
  assert.equal(deleted.rateLimits, 1);
  assert.deepEqual(sqlite.prepare('SELECT key FROM _ecommerce_rate_limits ORDER BY key').all().map((row) => row.key),
    ['shopper-email:daily', 'shopper-preview:recent-ip']);
  sqlite.close();
});

test('the purge deletes accounts that sign-in requests used to create and keeps every account in use', async () => {
  const { sqlite, DB } = database();
  const now = new Date('2026-09-25T12:00:00Z');
  const seconds = now.getTime() / 1000;
  const old = seconds - 3 * day;
  sqlite.prepare(`INSERT INTO galaxy_auth_user (id, name, email, created_at, updated_at, role)
    VALUES ('cms-user', 'Linked', 'linked@example.test', ?, ?, 'customer')`).run(old, old);
  const account = sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts
    (id, email, email_normalized, email_verified_at, cms_user_id, credit_balance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)`);
  const add = (id, { verifiedAt = null, cmsUserId = null, createdAt = old } = {}) =>
    account.run(id, `${id}@example.test`, `${id}@example.test`, verifiedAt, cmsUserId, createdAt, createdAt);
  for (const id of ['requested', 'requested-too', 'with-order', 'with-session', 'with-link', 'with-basket',
    'with-credit', 'referrer', 'with-discount']) add(id);
  add('verified', { verifiedAt: old });
  add('linked', { cmsUserId: 'cms-user' });
  add('brand-new', { createdAt: seconds - 3600 });
  sqlite.prepare(`INSERT INTO _ecommerce_orders (id, user_id, status, total_amount, created_at, updated_at)
    VALUES ('ord_1', 'with-order', 'cancelled', 1000, ?, ?)`).run(old, old);
  sqlite.prepare(`INSERT INTO _ecommerce_orders (id, user_id, status, total_amount, created_at, updated_at)
    VALUES ('ord_2', NULL, 'paid', 1000, ?, ?)`).run(old, old);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_sessions (id, account_id, token_hash, expires_at, created_at, purpose)
    VALUES ('session', 'with-session', 'hash-session', ?, ?, 'session')`).run(seconds + day, old);
  sqlite.prepare(`INSERT INTO _ecommerce_customer_sessions (id, account_id, token_hash, expires_at, created_at, purpose)
    VALUES ('challenge', 'with-link', 'hash-challenge', ?, ?, 'email_challenge')`).run(seconds + 600, seconds - 300);
  sqlite.prepare(`INSERT INTO _ecommerce_carts (id, user_id, items, created_at, updated_at)
    VALUES ('basket', 'with-basket', '[]', ?, ?)`).run(old, old);
  // Credit that was awarded and reversed leaves a zero balance, but the ledger still names the account.
  const ledger = sqlite.prepare(`INSERT INTO _ecommerce_credit_ledger (id, account_id, order_id, kind, amount_cents, created_at)
    VALUES (?, 'with-credit', 'ord_2', ?, ?, ?)`);
  ledger.run('award', 'welcome_award', 500, old);
  ledger.run('reversal', 'welcome_reversal', -500, old);
  sqlite.prepare(`INSERT INTO _ecommerce_referral_codes (code, account_id, created_at)
    VALUES ('REF-00000000000000000001', 'referrer', ?)`).run(old);
  sqlite.prepare(`INSERT INTO _ecommerce_discount_codes (code, type, value, created_at, updated_at)
    VALUES ('SAVE5', 'amount', 500, ?, ?)`).run(old, old);
  sqlite.prepare(`INSERT INTO _ecommerce_orders (id, user_id, status, total_amount, discount_code, discount_amount, subtotal_amount, created_at, updated_at)
    VALUES ('ord_3', NULL, 'pending', 1000, 'SAVE5', 500, 1500, ?, ?)`).run(old, old);
  sqlite.prepare(`INSERT INTO _ecommerce_discount_redemptions (id, code, order_id, account_id, email_normalized, amount_cents, created_at, updated_at)
    VALUES ('dred', 'SAVE5', 'ord_3', 'with-discount', 'with-discount@example.test', 500, ?, ?)`).run(old, old);

  const deleted = await purgeStaleCommerceData({ env: { DB }, now });
  assert.equal(deleted.unverifiedAccounts, 2);
  assert.deepEqual(sqlite.prepare('SELECT id FROM _ecommerce_customer_accounts ORDER BY id').all().map((row) => row.id),
    ['brand-new', 'linked', 'referrer', 'verified', 'with-basket', 'with-credit', 'with-discount', 'with-link',
      'with-order', 'with-session']);
  // Once its expired link has been purged, an unverified account with nothing else goes on a later run.
  sqlite.prepare(`UPDATE _ecommerce_customer_sessions SET expires_at = ? WHERE id = 'challenge'`).run(seconds - 2 * day);
  assert.equal((await purgeStaleCommerceData({ env: { DB }, now })).unverifiedAccounts, 1);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_customer_accounts WHERE id = 'with-link'`).get().count, 0);
  sqlite.close();
});

test('a failing table does not stop the rest of the purge, and the run still fails', async () => {
  const { sqlite, DB } = database();
  const now = new Date('2026-09-25T12:00:00Z');
  const seconds = now.getTime() / 1000;
  sqlite.prepare(`INSERT INTO _ecommerce_carts (id, session_token, created_at, updated_at) VALUES ('stale', 'anon', ?, ?)`)
    .run(seconds - 60 * day, seconds - 60 * day);
  sqlite.prepare(`INSERT INTO galaxy_auth_rate_limit (id, key, count, last_request) VALUES ('old', 'shopper-email:old', 1, ?)`)
    .run(seconds - 2 * day);
  sqlite.exec('DROP TABLE _ecommerce_customer_sessions');
  await assert.rejects(purgeStaleCommerceData({ env: { DB }, now }), /customerSessions/);
  assert.equal(cartCount(sqlite), 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM galaxy_auth_rate_limit').get().count, 0);
  sqlite.close();
});
