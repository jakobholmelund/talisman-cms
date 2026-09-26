import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { CUSTOMER_SESSION_COOKIE, CustomerEmailLimitError, requestCustomerEmailSignIn,
  shopperSignInBotCheck } from '../dist/accounts.js';
import { previewCustomerSignIn, readCustomerSignInToken,
  requestCustomerEmailSignIn as requestSignInFromBrowser } from '../dist/browser.js';

// The account route reads its bindings and waitUntil from cloudflare:workers, and the email runtime
// reads the provider registered with talismanCms({ email }) from a virtual module. Both come from
// this test. Work passed to waitUntil is collected, so a test can check what runs after the response.
const stubs = {
  'cloudflare:workers': 'export const env = new Proxy({}, { get: (_, key) => globalThis.workerEnv?.[key] });'
    + ' export const waitUntil = (task) => { globalThis.pendingTasks.push(task); };',
  'virtual:talisman-cms/email': 'export let emailProviderFactory = null;'
    + ' globalThis.setEmailProviderFactory = (factory) => { emailProviderFactory = factory; };',
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!(specifier in stubs)) return nextResolve(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  },
});
const { ALL } = await import('../dist/routes/ecommerce-account.js');
// The CMS's own sign-in, which keeps its rate-limit rows in galaxy_auth_rate_limit.
const { LocalAuthAdapter } = await import('talisman-cms/auth/local');

const ORIGIN = 'https://shop.test';
const migrationFiles = ['0004_ecommerce_plugin.sql', '0005_variant_value_images.sql', '0007_local_auth.sql',
  '0008_shared_components.sql', '0010_checkout_inventory.sql', '0011_order_payment_provider.sql',
  '0012_customer_accounts.sql', '0013_referrals_and_credit.sql', '0014_promotions.sql',
  '0015_gift_cards.sql', '0016_verified_customer_sessions.sql', '0017_commerce_fulfillment.sql',
  '0019_shared_customer_identity.sql', '0024_shopper_sign_in_tokens.sql', '0025_order_shipping_and_tax.sql',
  '0026_order_fulfillment_status.sql'];

function applyMigration(sqlite, migration) {
  const sql = readFileSync(new URL(`../../talisman-cms/drizzle/${migration}`, import.meta.url), 'utf8');
  sqlite.exec(sql.replaceAll('--> statement-breakpoint', ''));
}

function database(migrations = migrationFiles) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of migrations) applyMigration(sqlite, migration);
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

/** A `[[send_email]]` binding that records each MessageBuilder, or throws the given error. */
function emailBinding(error) {
  const sent = [];
  return {
    sent,
    async send(builder) {
      if (error) throw error;
      sent.push(builder);
      return { messageId: `<m${sent.length}@shop.test>` };
    },
  };
}

const bindingError = (code) => Object.assign(new Error(`${code} for shopper@example.test`), { code });

function shop(overrides = {}, migrations = migrationFiles) {
  const { sqlite, DB } = database(migrations);
  const EMAIL = emailBinding();
  const env = {
    DB, EMAIL,
    TALISMAN_EMAIL_PROVIDER: 'cloudflare',
    TALISMAN_EMAIL_FROM: 'Talisman Vision <no-reply@shop.test>',
    TALISMAN_EMAIL_REPLY_TO: 'hello@shop.test',
    TALISMAN_PUBLIC_ORIGIN: ORIGIN,
    ...overrides,
  };
  return { sqlite, env, sent: env.EMAIL?.sent ?? [] };
}

function cookieJar(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get(name) { return values.has(name) ? { value: values.get(name) } : undefined; },
    set(name, value) { values.set(name, value); },
    delete(name) { values.delete(name); },
  };
}

globalThis.pendingTasks = [];

/** Posts to the account route; work it left to waitUntil finishes before this resolves, unless `settle` is false. */
async function account(env, body, { base = ORIGIN, origin = base, ip = '203.0.113.10', cookies = cookieJar(), settle = true } = {}) {
  globalThis.workerEnv = env;
  const request = new Request(`${base}/api/ecommerce/account`, {
    method: 'POST',
    headers: { origin, 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(body),
  });
  const response = await ALL({ request, cookies });
  const json = await response.json();
  if (settle) await Promise.all(globalThis.pendingTasks.splice(0));
  return { status: response.status, json, cookies };
}

/** Captures console output so tests can check that no address, link or token is logged. */
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

const tokenFrom = (link) => new URLSearchParams(new URL(link).hash.slice(1)).get('token');
const linkIn = (text) => text.match(/https:\/\/shop\.test\/account\/verify#token=[0-9a-f-]+/)?.[0];
const challengeRevoked = (sqlite) => sqlite.prepare(`SELECT revoked_at FROM _ecommerce_sign_in_tokens`)
  .all().map((row) => row.revoked_at !== null);
const count = (sqlite, table) => sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;

test('a sign-in request sends a fragment link through the send_email binding', async (t) => {
  const logs = captureLogs(t);
  const { sqlite, env, sent } = shop();
  const requested = await account(env, { email: ' Shopper@Example.test ' });
  assert.deepEqual([requested.status, requested.json], [200, { accepted: true }]);
  assert.equal(sent.length, 1);
  const [message] = sent;
  assert.deepEqual(message.from, { email: 'no-reply@shop.test', name: 'Talisman Vision' });
  assert.equal(message.to, 'shopper@example.test');
  assert.equal(message.replyTo, 'hello@shop.test');
  assert.equal(message.subject, 'Sign in to Talisman Vision');
  assert.deepEqual(message.headers, { 'X-Talisman-Email': 'shopper-sign-in', 'Auto-Submitted': 'auto-generated' });
  const link = linkIn(message.text);
  assert.ok(link, 'the plain-text part carries the link');
  assert.ok(message.html.includes(`href="${link}"`));
  assert.doesNotMatch(message.text, /[?&]token=/);

  const verified = await account(env, { token: tokenFrom(link) });
  assert.equal(verified.status, 200);
  assert.equal(verified.json.account.email, 'shopper@example.test');
  assert.ok(verified.cookies.get(CUSTOMER_SESSION_COOKIE)?.value);
  assert.equal((await account(env, { token: tokenFrom(link) })).status, 400, 'a link works once');
  assert.equal(logs.length, 0);
  sqlite.close();
});

test('commerce-specific and pre-rename settings still configure sign-in email', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { sqlite, env, sent } = shop({
    TALISMAN_EMAIL_PROVIDER: undefined, TALISMAN_EMAIL_FROM: undefined, TALISMAN_PUBLIC_ORIGIN: undefined,
    TALISMAN_COMMERCE_EMAIL_FROM: 'Shop Accounts <accounts@shop.test>',
    GALAXY_COMMERCE_PUBLIC_ORIGIN: `${ORIGIN}/`,
  });
  assert.equal((await account(env, { email: 'shopper@example.test' })).status, 200);
  assert.deepEqual(sent[0].from, { email: 'accounts@shop.test', name: 'Shop Accounts' });
  assert.equal(sent[0].subject, 'Sign in to Shop Accounts');
  assert.ok(linkIn(sent[0].text));
  sqlite.close();
});

test('a provider registered with talismanCms({ email }) sends sign-in links', async (t) => {
  t.after(() => globalThis.setEmailProviderFactory(null));
  const delivered = [];
  globalThis.setEmailProviderFactory((env) => env.POSTMARK_TOKEN ? {
    id: 'postmark',
    async send(message) { delivered.push(message); return { provider: 'postmark' }; },
  } : null);
  const { sqlite, env, sent } = shop({ TALISMAN_EMAIL_PROVIDER: undefined, POSTMARK_TOKEN: 'set-as-a-secret' });
  assert.equal((await account(env, { email: 'shopper@example.test' })).status, 200);
  assert.equal(sent.length, 0, 'the registered provider wins over the EMAIL binding');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].kind, 'shopper-sign-in');
  assert.equal(delivered[0].headers['Auto-Submitted'], 'auto-generated');
  assert.ok(linkIn(delivered[0].text));
  // TALISMAN_EMAIL_PROVIDER=cloudflare still selects the binding.
  assert.equal((await account({ ...env, TALISMAN_EMAIL_PROVIDER: 'cloudflare' }, { email: 'other@example.test' })).status, 200);
  assert.equal(sent.length, 1);
  sqlite.close();
});

test('sign-in email is unavailable until a provider, sender and matching public origin are configured', async (t) => {
  const logs = captureLogs(t);
  const cases = [
    { EMAIL: undefined },
    { TALISMAN_EMAIL_PROVIDER: 'none' },
    { TALISMAN_EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key' },
    { TALISMAN_EMAIL_FROM: undefined },
    { TALISMAN_PUBLIC_ORIGIN: undefined },
    { TALISMAN_PUBLIC_ORIGIN: 'https://attacker.test' },
    { TALISMAN_PUBLIC_ORIGIN: 'not a url' },
  ];
  for (const overrides of cases) {
    const { sqlite, env, sent } = shop(overrides);
    const result = await account(env, { email: 'shopper@example.test' });
    assert.deepEqual([result.status, result.json], [503, { error: 'Email sign-in is unavailable' }], JSON.stringify(overrides));
    assert.equal(sent.length, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_customer_accounts').get().count, 0);
    sqlite.close();
  }
  const configurationErrors = logs.filter((line) => line.text.includes('Email sign-in is not configured'));
  assert.equal(configurationErrors.length, cases.length);
  assert.ok(logs.every((line) => !line.text.includes('shopper@example.test')));
});

test('cross-origin sign-in requests are refused before anything is sent', async () => {
  const { sqlite, env, sent } = shop();
  const result = await account(env, { email: 'shopper@example.test' }, { origin: 'https://attacker.test' });
  assert.equal(result.status, 403);
  assert.equal(sent.length, 0);
  sqlite.close();
});

test('an invalid address is a 400 and sends nothing', async () => {
  const { sqlite, env, sent } = shop();
  for (const email of ['not-an-email', 'a@b', `${'a'.repeat(250)}@example.test`]) {
    const result = await account(env, { email });
    assert.deepEqual([result.status, result.json], [400, { error: 'Valid email required' }]);
  }
  assert.equal(sent.length, 0);
  sqlite.close();
});

test('an address with a display name or a second recipient is refused, so it cannot redirect a link', async () => {
  const { sqlite, env, sent } = shop();
  const wrapped = ['a<victim@example.test>', 'Victim <victim@example.test>', '"a" <victim@example.test>',
    'victim@example.test, other@example.test', 'victim@example.test;other@example.test',
    'vic(comment)tim@example.test', 'vic"tim@example.test', 'victim@example.test>', 'victim@[127.0.0.1]'];
  for (const email of wrapped) {
    const result = await account(env, { email });
    assert.deepEqual([result.status, result.json], [400, { error: 'Valid email required' }], email);
    await assert.rejects(requestCustomerEmailSignIn(env, email, (token) => token, async () => {}), /Valid email required/);
  }
  assert.equal(sent.length, 0);
  for (const table of ['_ecommerce_sign_in_tokens', '_ecommerce_customer_accounts', '_ecommerce_rate_limits']) {
    assert.equal(count(sqlite, table), 0, table);
  }
  // A bare address is sent to exactly that address.
  assert.equal((await account(env, { email: ' Victim@Example.test ' })).status, 200);
  assert.equal(sent[0].to, 'victim@example.test');
  sqlite.close();
});

test('asking for a link creates no account; using it creates a verified one', async () => {
  const { sqlite, env, sent } = shop();
  const requested = await account(env, { email: 'New.Shopper@Example.test' });
  assert.deepEqual([requested.status, requested.json], [200, { accepted: true }]);
  assert.equal(count(sqlite, '_ecommerce_customer_accounts'), 0, 'a request alone creates no account');
  assert.equal(count(sqlite, 'galaxy_auth_user'), 0);
  const token = tokenFrom(linkIn(sent[0].text));
  const rows = sqlite.prepare('SELECT * FROM _ecommerce_sign_in_tokens').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email_normalized, 'new.shopper@example.test');
  assert.equal(rows[0].token_hash, createHash('sha256').update(token).digest('hex'), 'only the hash is stored');
  assert.equal(rows[0].expires_at - rows[0].created_at, 15 * 60);
  assert.equal(rows[0].revoked_at, null);
  assert.ok(!JSON.stringify(rows).includes(token));

  const verified = await account(env, { token });
  assert.equal(verified.status, 200);
  const created = sqlite.prepare('SELECT id, email, email_verified_at, cms_user_id FROM _ecommerce_customer_accounts').get();
  assert.equal(verified.json.account.id, created.id);
  assert.equal(created.email, 'new.shopper@example.test');
  assert.ok(created.email_verified_at, 'the account starts verified');
  assert.equal(sqlite.prepare('SELECT role FROM galaxy_auth_user WHERE id = ?').get(created.cms_user_id).role, 'customer');
  assert.ok(sqlite.prepare('SELECT revoked_at FROM _ecommerce_sign_in_tokens').get().revoked_at, 'the link is used up');

  // A later link for the same address opens the same account.
  await account(env, { email: 'new.shopper@example.test' }, { ip: '203.0.113.11' });
  const again = await account(env, { token: tokenFrom(linkIn(sent[1].text)) });
  assert.equal(again.json.account.id, created.id);
  assert.equal(count(sqlite, '_ecommerce_customer_accounts'), 1);

  // An account an old sign-in request created, never verified, is verified by its first used link.
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts (id, email, email_normalized, created_at, updated_at)
    VALUES ('acct_old', 'old@example.test', 'old@example.test', 1, 1)`).run();
  await account(env, { email: 'old@example.test' }, { ip: '203.0.113.12' });
  const old = await account(env, { token: tokenFrom(linkIn(sent[2].text)) });
  assert.equal(old.json.account.id, 'acct_old');
  assert.ok(sqlite.prepare(`SELECT email_verified_at FROM _ecommerce_customer_accounts WHERE id = 'acct_old'`).get().email_verified_at);
  sqlite.close();
});

test('a preview shows the masked address of an unused link and leaves it usable', async () => {
  const { sqlite, env, sent } = shop();
  await account(env, { email: 'Jakob@Example.test' });
  const token = tokenFrom(linkIn(sent[0].text));
  const cookies = cookieJar();
  const preview = await account(env, { token, preview: true }, { cookies });
  assert.deepEqual([preview.status, preview.json], [200, { email: 'j•••@example.test' }]);
  assert.equal(cookies.values.size, 0, 'a preview sets no cookie');
  // A malformed flag is still a preview: it never spends the link.
  for (const preview of ['true', 1, {}, null]) {
    assert.deepEqual((await account(env, { token, preview })).json, { email: 'j•••@example.test' }, JSON.stringify(preview));
  }
  assert.equal(count(sqlite, '_ecommerce_customer_accounts'), 0);
  assert.equal(count(sqlite, '_ecommerce_customer_sessions'), 0);
  assert.equal(sqlite.prepare('SELECT revoked_at FROM _ecommerce_sign_in_tokens').get().revoked_at, null);

  // `preview: false` is an ordinary sign-in. Afterwards the link previews like any unusable one.
  assert.equal((await account(env, { token, preview: false })).status, 200);
  const used = await account(env, { token, preview: true });
  assert.deepEqual([used.status, used.json], [400, { error: 'This sign-in link is invalid or has expired.' }]);
  sqlite.close();
});

test('unusable links get one answer, and a preview never shows whether an address has an account', async () => {
  const { sqlite, env, sent } = shop();
  await account(env, { email: 'known@example.test' });
  assert.equal((await account(env, { token: tokenFrom(linkIn(sent[0].text)) })).status, 200);
  await account(env, { email: 'known@example.test' });
  await account(env, { email: 'new@example.test' });
  const known = tokenFrom(linkIn(sent[1].text));
  const fresh = tokenFrom(linkIn(sent[2].text));
  const previews = [await account(env, { token: known, preview: true }), await account(env, { token: fresh, preview: true })];
  assert.deepEqual(previews.map(({ status, json }) => [status, Object.keys(json)]), [[200, ['email']], [200, ['email']]]);
  assert.deepEqual(previews.map(({ json }) => json.email), ['k•••@example.test', 'n•••@example.test']);

  sqlite.prepare('UPDATE _ecommerce_sign_in_tokens SET expires_at = created_at - 1').run();
  const invalid = [400, { error: 'This sign-in link is invalid or has expired.' }];
  const flipped = known.replace(/.$/, (last) => last === 'a' ? 'b' : 'a');
  for (const token of [known, fresh, 'not-a-token', '0'.repeat(72), flipped, 42]) {
    for (const body of typeof token === 'string' ? [{ token, preview: true }, { token }] : [{ token, preview: true }]) {
      const result = await account(env, body);
      assert.deepEqual([result.status, result.json], invalid, JSON.stringify(body));
    }
  }
  assert.equal(count(sqlite, '_ecommerce_customer_accounts'), 1, 'an expired link creates no account');
  assert.equal(count(sqlite, '_ecommerce_customer_sessions'), 1);
  sqlite.close();
});

test('previews are limited per IP like sign-in requests, in their own budget', async () => {
  const { sqlite, env, sent } = shop();
  await account(env, { email: 'shopper@example.test' });
  const token = tokenFrom(linkIn(sent[0].text));
  const ip = '2001:db8:5:6::1';
  for (let index = 0; index < 20; index++) {
    // Rotating addresses in one /64, with malformed tokens counting too.
    const body = index % 2 ? { token, preview: true } : { token: `bad-${index}`, preview: true };
    assert.notEqual((await account(env, body, { ip: `2001:db8:5:6::${index + 1}` })).status, 429);
  }
  const limited = await account(env, { token, preview: true }, { ip });
  assert.deepEqual([limited.status, limited.json], [429, { error: 'Too many sign-in requests. Please try again later.' }]);
  assert.equal((await account(env, { token, preview: true }, { ip: '2001:db8:5:7::1' })).status, 200, 'the next /64 has its own limit');
  assert.equal((await account(env, { email: 'other@example.test' }, { ip })).status, 200);
  assert.equal(sent.length, 2, 'previews do not use the sign-in email budget');
  assert.equal((await account(env, { token }, { ip })).status, 200, 'the link still works');
  sqlite.close();
});

test('previewCustomerSignIn asks for a preview and returns the masked address', async (t) => {
  const calls = [];
  let answer = Response.json({ email: 'j•••@example.test' });
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, ...init }); return answer; });
  assert.deepEqual(await previewCustomerSignIn('a-token'), { email: 'j•••@example.test' });
  assert.equal(calls[0].url, '/api/ecommerce/account');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { token: 'a-token', preview: true });
  answer = Response.json({ error: 'This sign-in link is invalid or has expired.' }, { status: 400 });
  await assert.rejects(previewCustomerSignIn('a-token'), { message: 'This sign-in link is invalid or has expired.' });
});

test("better-auth pruning its rate-limit table leaves the shopper counters and the daily cap", async () => {
  const { sqlite, env, sent } = shop({ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '2',
    TALISMAN_AUTH_SECRET: 'talisman-test-secret-0123456789abcdef' });
  for (const [index, ip] of ['203.0.113.1', '203.0.113.2'].entries()) {
    assert.equal((await account(env, { email: `s${index}@example.test` }, { ip })).status, 200);
  }
  assert.equal(count(sqlite, 'galaxy_auth_rate_limit'), 0, "shopper counters stay out of better-auth's table");
  // A CMS sign-in bucket whose 15-minute window has ended, and an older one. The next CMS sign-in from
  // the first IP resets its bucket, and better-auth then deletes every row older than its longest window.
  const bucket = sqlite.prepare('INSERT INTO galaxy_auth_rate_limit (id, key, count, last_request) VALUES (?, ?, ?, ?)');
  bucket.run('current', '198.51.100.7|/sign-in/email', 3, Date.now() - 16 * 60 * 1000);
  bucket.run('expired', '198.51.100.8|/sign-in/email', 1, Date.now() - 60 * 60 * 1000);
  globalThis.workerEnv = env;
  const signIn = await LocalAuthAdapter('/admin', { requireAccess: false }).handle(new Request(`${ORIGIN}/admin/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
    body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong-password-123' }),
  }));
  assert.equal(signIn.status, 401);
  assert.deepEqual(sqlite.prepare('SELECT id, count FROM galaxy_auth_rate_limit').all().map((row) => ({ ...row })),
    [{ id: 'current', count: 1 }], 'better-auth reset the bucket and pruned its table');

  assert.equal(sqlite.prepare(`SELECT count FROM _ecommerce_rate_limits WHERE key = 'shopper-email:daily'`).get().count, 2);
  const limited = await account(env, { email: 'late@example.test' }, { ip: '203.0.113.3' });
  assert.deepEqual([limited.status, limited.json], [200, { accepted: true, limited: true }]);
  assert.equal(sent.length, 2, 'the daily cap still holds');
  sqlite.close();
});

test('links sent before migration 0024 still work, and its counters move out of better-auth\'s table', async () => {
  const upgrade = migrationFiles.indexOf('0024_shopper_sign_in_tokens.sql');
  const { sqlite, env } = shop({}, migrationFiles.slice(0, upgrade));
  const now = Math.floor(Date.now() / 1000);
  // What the previous release wrote: an unverified account per request, a challenge row, and seconds-based counters.
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts (id, email, email_normalized, created_at, updated_at)
    VALUES ('acct_pending', 'pending@example.test', 'pending@example.test', ?, ?)`).run(now - 60, now - 60);
  const challenge = sqlite.prepare(`INSERT INTO _ecommerce_customer_sessions
    (id, account_id, token_hash, expires_at, created_at, purpose) VALUES (?, 'acct_pending', ?, ?, ?, 'email_challenge')`);
  const live = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const expired = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const hash = (token) => createHash('sha256').update(token).digest('hex');
  challenge.run('live', hash(live), now + 600, now - 60);
  challenge.run('expired', hash(expired), now - 60, now - 960);
  const counter = sqlite.prepare('INSERT INTO galaxy_auth_rate_limit (id, key, count, last_request) VALUES (?, ?, ?, ?)');
  counter.run('daily', 'shopper-email:daily', 150, now - 3600);
  counter.run('cms', '198.51.100.7|/sign-in/email', 2, Date.now());
  for (const migration of migrationFiles.slice(upgrade)) applyMigration(sqlite, migration);

  assert.deepEqual(sqlite.prepare('SELECT key FROM galaxy_auth_rate_limit').all().map((row) => row.key), ['198.51.100.7|/sign-in/email']);
  assert.deepEqual({ ...sqlite.prepare('SELECT key, count, window_start FROM _ecommerce_rate_limits').get() },
    { key: 'shopper-email:daily', count: 150, window_start: now - 3600 });
  assert.deepEqual((await account(env, { token: live, preview: true })).json, { email: 'p•••@example.test' });
  const signedIn = await account(env, { token: live });
  assert.equal(signedIn.json.account.id, 'acct_pending');
  assert.equal((await account(env, { token: expired })).status, 400);
  sqlite.close();
});

test('a suppressed recipient gets the normal answer, and the log carries only the code', async (t) => {
  const logs = captureLogs(t);
  const { sqlite, env } = shop({ EMAIL: emailBinding(bindingError('E_RECIPIENT_SUPPRESSED')) });
  const result = await account(env, { email: 'shopper@example.test' });
  assert.deepEqual([result.status, result.json], [200, { accepted: true }]);
  assert.deepEqual(challengeRevoked(sqlite), [true], 'the unsent link cannot be used');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.deepEqual(logs[0].args[1], { provider: 'cloudflare', code: 'recipient_suppressed', providerCode: 'E_RECIPIENT_SUPPRESSED' });
  assert.ok(!logs[0].text.includes('shopper@example.test'));
  sqlite.close();
});

test('provider failures are a readable 503, revoke the link and log codes only', async (t) => {
  const logs = captureLogs(t);
  const expected = {
    E_RECIPIENT_NOT_ALLOWED: 'not_configured',
    E_SENDER_NOT_VERIFIED: 'sender_rejected',
    E_DAILY_LIMIT_EXCEEDED: 'quota_exceeded',
    E_RATE_LIMIT_EXCEEDED: 'rate_limited',
    E_DELIVERY_FAILED: 'delivery_failed',
  };
  for (const [providerCode, code] of Object.entries(expected)) {
    logs.length = 0;
    const { sqlite, env } = shop({ EMAIL: emailBinding(bindingError(providerCode)) });
    const result = await account(env, { email: 'shopper@example.test' });
    assert.deepEqual([result.status, result.json], [503, { error: 'The sign-in email could not be sent. Please try again later.' }]);
    assert.deepEqual(challengeRevoked(sqlite), [true]);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'error');
    assert.deepEqual(logs[0].args[1], { provider: 'cloudflare', code, providerCode });
    assert.ok(!logs[0].text.includes('shopper@example.test'));
    sqlite.close();
  }
  // The local simulator throws plain errors, for example for a sender outside allowed_sender_addresses.
  logs.length = 0;
  const { sqlite, env } = shop({ EMAIL: emailBinding(new Error('email from no-reply@shop.test not allowed')) });
  assert.equal((await account(env, { email: 'shopper@example.test' })).status, 503);
  assert.deepEqual(logs[0].args[1], { provider: 'cloudflare', code: 'unknown', providerCode: null });
  assert.ok(!logs[0].text.includes('@'));
  sqlite.close();
});

test('known, unknown and rate-limited addresses get the same answer', async (t) => {
  const logs = captureLogs(t);
  const { sqlite, env, sent } = shop();
  const answers = [];
  answers.push(await account(env, { email: 'known@example.test' }));
  answers.push(await account(env, { email: 'new@example.test' }));
  for (let attempt = 0; attempt < 3; attempt++) answers.push(await account(env, { email: 'known@example.test' }));
  assert.equal(sent.length, 4, 'an account gets at most three links per ten minutes');
  for (let index = 0; index < 21; index++) answers.push(await account(env, { email: `n${index}@example.test` }, { ip: '198.51.100.7' }));
  assert.equal(sent.length, 24, 'one IP gets at most 20 requests per hour');
  assert.ok(answers.every((answer) => answer.status === 200 && JSON.stringify(answer.json) === '{"accepted":true}'));
  const tokens = sent.map((message) => tokenFrom(linkIn(message.text)));
  assert.ok(logs.every((line) => tokens.every((token) => !line.text.includes(token))));
  sqlite.close();
});

test('a store-wide daily limit stops sign-in emails once it is reached', async (t) => {
  const logs = captureLogs(t);
  const { sqlite, env, sent } = shop({ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '2' });
  for (const [index, ip] of ['203.0.113.1', '203.0.113.2'].entries()) {
    assert.equal((await account(env, { email: `s${index}@example.test` }, { ip })).status, 200);
  }
  const limited = await account(env, { email: 'late@example.test' }, { ip: '203.0.113.3' });
  assert.deepEqual([limited.status, limited.json], [200, { accepted: true, limited: true }]);
  assert.equal(sent.length, 2);
  assert.equal(count(sqlite, '_ecommerce_sign_in_tokens'), 2, 'no link was created');
  assert.ok(logs.some((line) => line.level === 'warn' && line.text.includes('Daily sign-in email limit reached')));

  // Requests the per-account limit drops send nothing and do not use the daily budget.
  const second = shop({ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '3' });
  for (let attempt = 0; attempt < 5; attempt++) await account(second.env, { email: 'same@example.test' });
  assert.equal(second.sent.length, 3);
  assert.deepEqual((await account(second.env, { email: 'other@example.test' })).json, { accepted: true, limited: true });
  assert.equal(second.sent.length, 3);
  second.sqlite.close();

  // The window restarts after 24 hours; an invalid setting falls back to 200.
  sqlite.prepare(`UPDATE _ecommerce_rate_limits SET window_start = window_start - 86400 WHERE key = 'shopper-email:daily'`).run();
  assert.equal((await account(env, { email: 'tomorrow@example.test' }, { ip: '203.0.113.4' })).status, 200);
  const unlimited = shop({ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: 'lots' });
  for (let index = 0; index < 3; index++) {
    assert.equal((await account(unlimited.env, { email: `u${index}@example.test` }, { ip: `203.0.113.${20 + index}` })).status, 200);
  }
  unlimited.sqlite.close();
  sqlite.close();
});

test('requestCustomerEmailSignIn reports a spent daily budget as limited instead of throwing', async () => {
  const { sqlite, env } = shop({ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '1' });
  let sends = 0;
  assert.deepEqual(await requestCustomerEmailSignIn(env, 'a@example.test', (token) => token, async () => { sends++; }), { limited: false });
  assert.deepEqual(await requestCustomerEmailSignIn(env, 'b@example.test', (token) => token, async () => { sends++; }), { limited: true });
  assert.equal(sends, 1);
  // Still exported for code that checks for it.
  assert.equal(new CustomerEmailLimitError().name, 'CustomerEmailLimitError');
  sqlite.close();
});

test('IPv6 sign-in requests are limited per /64 prefix', async () => {
  const { sqlite, env } = shop();
  let sends = 0;
  const send = async () => { sends++; };
  for (let index = 0; index < 21; index++) {
    // Rotating through one /64, including the compressed and expanded spellings of it.
    const ip = index % 2 ? `2001:db8:1:2::${index.toString(16)}` : `2001:0DB8:0001:0002:${index.toString(16)}:0:0:1`;
    await requestCustomerEmailSignIn(env, `v6-${index}@example.test`, (token) => token, send, ip);
  }
  assert.equal(sends, 20);
  await requestCustomerEmailSignIn(env, 'neighbour@example.test', (token) => token, send, '2001:db8:1:3::1');
  assert.equal(sends, 21, 'the next /64 has its own limit');
  // IPv4-mapped IPv6 counts as the IPv4 address.
  for (let index = 0; index < 20; index++) {
    await requestCustomerEmailSignIn(env, `v4-${index}@example.test`, (token) => token, send, '192.0.2.44');
  }
  await requestCustomerEmailSignIn(env, 'mapped@example.test', (token) => token, send, '::ffff:192.0.2.44');
  assert.equal(sends, 41);
  sqlite.close();
});

test('readCustomerSignInToken reads the fragment, accepts legacy query links and strips the token', () => {
  const replaced = [];
  const history = { state: { page: 1 }, replaceState(state, _title, url) { replaced.push([state, url]); } };
  const at = (search, hash) => ({ pathname: '/account/verify', search, hash });

  assert.equal(readCustomerSignInToken(at('', '#token=fragment-token'), history), 'fragment-token');
  assert.deepEqual(replaced.pop(), [{ page: 1 }, '/account/verify']);
  assert.equal(readCustomerSignInToken(at('?token=query-token&utm=mail', '#token=fragment-token&x=1'), history), 'fragment-token');
  assert.deepEqual(replaced.pop(), [{ page: 1 }, '/account/verify?utm=mail#x=1']);
  assert.equal(readCustomerSignInToken(at('?token=legacy-token', ''), history), 'legacy-token');
  assert.deepEqual(replaced.pop(), [{ page: 1 }, '/account/verify']);
  assert.equal(readCustomerSignInToken(at('?utm=mail', '#section'), history), null);
  assert.equal(replaced.length, 0, 'a URL without a token is left alone');
  assert.equal(readCustomerSignInToken(at('', '#token=no-history')), 'no-history');
  assert.equal(readCustomerSignInToken(), null, 'outside a browser there is no token');
});

const TURNSTILE = { TALISMAN_COMMERCE_TURNSTILE_SITE_KEY: '0x4AAAAAAAsite-key', TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY: 'turnstile-secret-value' };
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const siteverifyPass = { success: true, hostname: 'shop.test', action: 'shopper-sign-in', 'error-codes': [] };

/** Replaces fetch with a siteverify stub that records each call and answers with `answer(body)`. */
function stubSiteverify(t, answer) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), init, body });
    const result = await answer(body);
    return result instanceof Response ? result : Response.json(result);
  });
  return calls;
}

const nothingWritten = (sqlite) => ['_ecommerce_sign_in_tokens', '_ecommerce_rate_limits', '_ecommerce_customer_accounts']
  .map((table) => count(sqlite, table));

test('without Turnstile settings sign-in needs no token and siteverify is never called', async (t) => {
  const calls = stubSiteverify(t, () => siteverifyPass);
  for (const overrides of [{}, { TALISMAN_COMMERCE_TURNSTILE_SITE_KEY: '0x4AAAAAAAsite-key' }]) {
    const { sqlite, env, sent } = shop(overrides);
    assert.equal(shopperSignInBotCheck(env), null, JSON.stringify(overrides));
    const result = await account(env, { email: 'shopper@example.test' });
    assert.deepEqual([result.status, result.json], [200, { accepted: true }]);
    assert.equal((await account(env, { email: 'other@example.test', turnstileToken: 'ignored' })).status, 200);
    assert.equal(sent.length, 2);
    sqlite.close();
  }
  assert.equal(calls.length, 0);
});

test('shopperSignInBotCheck gives storefronts the site key and action once both keys are set', () => {
  assert.deepEqual(shopperSignInBotCheck({ ...TURNSTILE }),
    { provider: 'turnstile', siteKey: '0x4AAAAAAAsite-key', action: 'shopper-sign-in' });
  assert.equal(shopperSignInBotCheck({ TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY: 'turnstile-secret-value' }), null);
  assert.equal(shopperSignInBotCheck({ ...TURNSTILE, TALISMAN_COMMERCE_TURNSTILE_SITE_KEY: '  ' }), null);
});

test('with Turnstile configured a request without a valid token is refused before any counter, link or email', async (t) => {
  const logs = captureLogs(t);
  let answer = siteverifyPass;
  const calls = stubSiteverify(t, () => typeof answer === 'function' ? answer() : answer);
  const refused = [403, { error: 'The security check failed. Please try again.' }];
  const cases = [
    ['missing token', {}, null],
    ['empty token', { turnstileToken: '' }, null],
    ['token that is not a string', { turnstileToken: { value: 'x' } }, null],
    ['oversized token', { turnstileToken: 'x'.repeat(2049) }, null],
    ['invalid token', { turnstileToken: 'bad-token' }, { success: false, 'error-codes': ['invalid-input-response'] }],
    ['success that is not true', { turnstileToken: 'odd-token' }, { success: 'true', hostname: 'shop.test' }],
    ['siteverify error status', { turnstileToken: 'valid-token' }, () => new Response('unavailable', { status: 500 })],
    ['siteverify network failure', { turnstileToken: 'valid-token' }, () => { throw new TypeError('fetch failed'); }],
    ['siteverify answer that is not JSON', { turnstileToken: 'valid-token' }, () => new Response('<html>', { status: 200 })],
    ['hostname mismatch', { turnstileToken: 'valid-token' }, { ...siteverifyPass, hostname: 'elsewhere.test' }],
    ['action mismatch', { turnstileToken: 'valid-token' }, { ...siteverifyPass, action: 'newsletter' }],
  ];
  for (const [name, extra, siteverify] of cases) {
    const { sqlite, env, sent } = shop(TURNSTILE);
    answer = siteverify;
    const before = calls.length;
    const result = await account(env, { email: 'shopper@example.test', ...extra });
    assert.deepEqual([result.status, result.json], refused, name);
    assert.equal(calls.length - before, siteverify ? 1 : 0, `${name}: siteverify calls`);
    assert.deepEqual(nothingWritten(sqlite), [0, 0, 0], name);
    assert.equal(sent.length, 0, name);
    sqlite.close();
  }
  const refusals = logs.filter((line) => line.text.includes('bot check refused'));
  assert.deepEqual(refusals.map((line) => line.args[1].code), ['missing_token', 'missing_token', 'missing_token', 'missing_token',
    'rejected', 'rejected', 'unavailable', 'unavailable', 'unavailable', 'hostname_mismatch', 'action_mismatch']);
  assert.deepEqual(refusals[4].args[1].errorCodes, ['invalid-input-response']);
  assert.ok(logs.every((line) => !/shopper@example\.test|bad-token|valid-token|turnstile-secret-value/.test(line.text)));
});

test('a valid Turnstile token lets the request through, and siteverify gets the secret, token and client IP', async (t) => {
  const calls = stubSiteverify(t, () => siteverifyPass);
  const { sqlite, env, sent } = shop(TURNSTILE);
  const result = await account(env, { email: 'shopper@example.test', turnstileToken: 'token-from-widget' }, { ip: '198.51.100.23' });
  assert.deepEqual([result.status, result.json], [200, { accepted: true }]);
  assert.equal(sent.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, SITEVERIFY);
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(calls[0].init.signal instanceof AbortSignal, 'the call has a timeout');
  assert.deepEqual(calls[0].body, { secret: 'turnstile-secret-value', response: 'token-from-widget', remoteip: '198.51.100.23' });
  // Siteverify may leave out the hostname and action; success alone then decides.
  const { sqlite: other, env: otherEnv, sent: otherSent } = shop(TURNSTILE);
  t.mock.restoreAll();
  stubSiteverify(t, () => ({ success: true }));
  assert.equal((await account(otherEnv, { email: 'shopper@example.test', turnstileToken: 'token-2' })).status, 200);
  assert.equal(otherSent.length, 1);
  other.close();
  sqlite.close();
});

test('the bot check runs after the same-origin and address checks, and previews and links need no token', async (t) => {
  const calls = stubSiteverify(t, () => siteverifyPass);
  const { sqlite, env, sent } = shop(TURNSTILE);
  assert.equal((await account(env, { email: 'shopper@example.test', turnstileToken: 't' }, { origin: 'https://attacker.test' })).status, 403);
  assert.deepEqual((await account(env, { email: 'not-an-email', turnstileToken: 't' })).json, { error: 'Valid email required' });
  assert.equal(calls.length, 0);
  await account(env, { email: 'shopper@example.test', turnstileToken: 't' });
  const token = tokenFrom(linkIn(sent[0].text));
  assert.deepEqual((await account(env, { token, preview: true })).json, { email: 's•••@example.test' });
  assert.equal((await account(env, { token })).status, 200);
  assert.equal(calls.length, 1, 'only the email request is checked');
  sqlite.close();
});

test('a Turnstile secret without a site key makes email sign-in unavailable and logs a code', async (t) => {
  const logs = captureLogs(t);
  const calls = stubSiteverify(t, () => siteverifyPass);
  const { sqlite, env, sent } = shop({ TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY: 'turnstile-secret-value' });
  const result = await account(env, { email: 'shopper@example.test', turnstileToken: 't' });
  assert.deepEqual([result.status, result.json], [503, { error: 'Email sign-in is unavailable' }]);
  assert.equal(calls.length, 0);
  assert.equal(sent.length, 0);
  assert.deepEqual(logs.map((line) => line.args[1]), [{ code: 'turnstile_site_key_missing' }]);
  sqlite.close();
});

test("Cloudflare's test secret keys pass whatever hostname and action they report", async (t) => {
  stubSiteverify(t, (body) => body.secret.startsWith('1x')
    ? { success: true, hostname: 'example.com', action: 'test' }
    : { success: false, 'error-codes': ['invalid-input-response'] });
  const pass = shop({ TALISMAN_COMMERCE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' });
  assert.equal((await account(pass.env, { email: 'shopper@example.test', turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' })).status, 200);
  const fail = shop({ TALISMAN_COMMERCE_TURNSTILE_SITE_KEY: '2x00000000000000000000AB',
    TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY: '2x0000000000000000000000000000000AA' });
  t.mock.method(console, 'warn', () => {});
  assert.equal((await account(fail.env, { email: 'shopper@example.test', turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' })).status, 403);
  pass.sqlite.close();
  fail.sqlite.close();
});

test('a Turnstile test secret works only on a local development origin', async (t) => {
  const logs = captureLogs(t);
  const calls = stubSiteverify(t, () => ({ success: true, hostname: 'example.com', action: 'test' }));
  const keys = { TALISMAN_COMMERCE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' };
  for (const base of ['https://shop.example', 'https://talisman.example.com']) {
    const { sqlite, env, sent } = shop({ ...keys, TALISMAN_PUBLIC_ORIGIN: base });
    const result = await account(env, { email: 'shopper@example.test', turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }, { base });
    assert.deepEqual([result.status, result.json], [403, { error: 'The security check failed. Please try again.' }], base);
    assert.deepEqual(nothingWritten(sqlite), [0, 0, 0]);
    assert.equal(sent.length, 0);
    sqlite.close();
  }
  assert.equal(calls.length, 0, 'siteverify is not asked');
  assert.deepEqual(logs.map((line) => line.args[1].code), ['test_key', 'test_key']);
  for (const base of ['http://localhost:4321', 'http://127.0.0.1:8787', 'http://[::1]:8787', 'https://shop.localhost', 'https://shop.test']) {
    const { sqlite, env, sent } = shop({ ...keys, TALISMAN_PUBLIC_ORIGIN: base });
    const result = await account(env, { email: 'shopper@example.test', turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }, { base });
    assert.equal(result.status, 200, base);
    assert.equal(sent.length, 1);
    sqlite.close();
  }
});

test('requestCustomerEmailSignIn in the browser sends the Turnstile token and returns the limited flag', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, ...init }); return Response.json({ accepted: true, limited: true }); });
  assert.deepEqual(await requestSignInFromBrowser('a@example.test', { turnstileToken: 'widget-token' }), { accepted: true, limited: true });
  await requestSignInFromBrowser('a@example.test');
  assert.deepEqual(calls.map((call) => JSON.parse(call.body)),
    [{ email: 'a@example.test', turnstileToken: 'widget-token' }, { email: 'a@example.test' }]);
});

function addCustomers(sqlite) {
  sqlite.prepare(`INSERT INTO _ecommerce_customer_accounts (id, email, email_normalized, email_verified_at, created_at, updated_at)
    VALUES ('acct_verified', 'verified@example.test', 'verified@example.test', 1, 1, 1),
      ('acct_unverified', 'unverified@example.test', 'unverified@example.test', NULL, 1, 1)`).run();
  const order = sqlite.prepare(`INSERT INTO _ecommerce_orders (id, customer_email, status, payment_provider, total_amount, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1000, 1, 1)`);
  order.run('ord_paid', 'Buyer@Example.test', 'paid', 'stripe');
  order.run('ord_pending', 'pending@example.test', 'pending', 'stripe');
  order.run('ord_test', 'tester@example.test', 'paid', 'admin_test');
}

async function spendGeneralPool(env, size) {
  for (let index = 0; index < size; index++) {
    const result = await account(env, { email: `filler-${index}@example.test` }, { ip: `203.0.113.${100 + index}` });
    assert.deepEqual(result.json, { accepted: true });
  }
}

test('with the general budget spent, existing customers still get a link and every address gets the same answer', async (t) => {
  const logs = captureLogs(t);
  const { sqlite, env, sent } = shop({ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '8', TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY: '3' });
  addCustomers(sqlite);
  await spendGeneralPool(env, 5);
  assert.equal(sent.length, 5);
  const answers = [];
  const ask = async (email, ip) => {
    const result = await account(env, { email }, { ip });
    answers.push([result.status, result.json]);
    return sent.at(-1)?.to;
  };
  for (const [index, email] of ['stranger@example.test', 'unverified@example.test', 'pending@example.test', 'tester@example.test'].entries()) {
    await ask(email, `198.51.100.${index + 1}`);
  }
  assert.equal(sent.length, 5, 'unknown addresses, unverified accounts, unpaid and admin test orders get nothing');
  assert.equal(await ask('verified@example.test', '198.51.100.10'), 'verified@example.test');
  assert.equal(await ask('buyer@example.test', '198.51.100.11'), 'buyer@example.test');
  assert.equal(sent.length, 7);
  assert.ok(linkIn(sent[6].text), 'a reserved send carries a working link');
  assert.equal((await account(env, { token: tokenFrom(linkIn(sent[5].text)) })).json.account.id, 'acct_verified');
  assert.ok(answers.every(([status, json]) => status === 200 && JSON.stringify(json) === '{"accepted":true,"limited":true}'));
  // Only customers draw on the reserve.
  assert.equal(sqlite.prepare(`SELECT count FROM _ecommerce_rate_limits WHERE key = 'shopper-email:reserved'`).get().count, 2);
  assert.equal(count(sqlite, '_ecommerce_sign_in_tokens'), 7, 'no link exists for addresses that were not sent one');
  assert.ok(logs.every((line) => !line.text.includes('@example.test')));
  sqlite.close();
});

test('with both budgets spent every address gets the same answer and nothing is sent', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { sqlite, env, sent } = shop({ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '4', TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY: '1' });
  addCustomers(sqlite);
  await spendGeneralPool(env, 3);
  assert.deepEqual((await account(env, { email: 'verified@example.test' }, { ip: '198.51.100.1' })).json, { accepted: true, limited: true });
  assert.equal(sent.length, 4, 'the one reserved email went out');
  const answers = [];
  for (const [index, email] of ['buyer@example.test', 'verified@example.test', 'stranger@example.test'].entries()) {
    const result = await account(env, { email }, { ip: `198.51.100.${index + 2}` });
    answers.push([result.status, result.json]);
  }
  assert.deepEqual(answers, Array(3).fill([200, { accepted: true, limited: true }]));
  assert.equal(sent.length, 4);
  sqlite.close();
});

const spentGeneralPool = (sqlite, count) => sqlite.prepare(`INSERT INTO _ecommerce_rate_limits (key, count, window_start)
  VALUES ('shopper-email:daily', ?, ?)`).run(count, Math.floor(Date.now() / 1000));

test('a request that a per-address or per-IP limit drops gets the same answer as any other', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // Before the general budget is spent, a dropped request answers like an accepted one.
  const open = shop();
  addCustomers(open.sqlite);
  const openAnswers = [];
  for (let attempt = 0; attempt < 4; attempt++) openAnswers.push(await account(open.env, { email: 'verified@example.test' }, { ip: `198.51.100.${attempt + 1}` }));
  for (let index = 0; index < 21; index++) openAnswers.push(await account(open.env, { email: `ip-${index}@example.test` }, { ip: '198.51.100.50' }));
  assert.equal(open.sent.length, 23, 'the fourth link for one address and the 21st request from one IP were dropped');
  assert.ok(openAnswers.every(({ status, json }) => status === 200 && JSON.stringify(json) === '{"accepted":true}'));
  open.sqlite.close();

  // Once it is spent, a dropped request answers limited like every other address.
  const { sqlite, env, sent } = shop({ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '8', TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY: '3' });
  addCustomers(sqlite);
  spentGeneralPool(sqlite, 5);
  const now = Math.floor(Date.now() / 1000);
  const link = sqlite.prepare(`INSERT INTO _ecommerce_sign_in_tokens (token_hash, email_normalized, expires_at, created_at) VALUES (?, ?, ?, ?)`);
  for (let index = 0; index < 3; index++) link.run(`seeded-${index}`, 'verified@example.test', now + 900, now - 60);
  const answers = [];
  answers.push(await account(env, { email: 'verified@example.test' }, { ip: '198.51.100.60' }));
  answers.push(await account(env, { email: 'stranger@example.test' }, { ip: '198.51.100.61' }));
  for (let index = 0; index < 21; index++) answers.push(await account(env, { email: `limited-${index}@example.test` }, { ip: '198.51.100.62' }));
  answers.push(await account(env, { email: 'buyer@example.test' }, { ip: '198.51.100.62' }));
  assert.deepEqual(answers.map(({ status, json }) => [status, json]), Array(answers.length).fill([200, { accepted: true, limited: true }]));
  assert.equal(sent.length, 0, 'the address limit dropped the customer, and the IP limit dropped the buyer');
  sqlite.close();
});

test('one address draws at most two emails a day from the reserve', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { sqlite, env, sent } = shop({ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '40', TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY: '20' });
  addCustomers(sqlite);
  spentGeneralPool(sqlite, 20);
  const answers = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    answers.push(await account(env, { email: 'verified@example.test' }, { ip: `198.51.100.${attempt + 1}` }));
    // Each request comes after the ten-minute per-address window.
    sqlite.prepare('UPDATE _ecommerce_sign_in_tokens SET created_at = created_at - 601').run();
    sqlite.prepare(`UPDATE _ecommerce_rate_limits SET window_start = window_start - 601
      WHERE key NOT IN ('shopper-email:daily', 'shopper-email:reserved')`).run();
  }
  assert.equal(sent.length, 2);
  assert.equal((await account(env, { email: 'buyer@example.test' }, { ip: '198.51.100.30' })).json.limited, true);
  assert.equal(sent.at(-1).to, 'buyer@example.test', 'the reserve still serves other customers');
  assert.equal(sqlite.prepare(`SELECT count FROM _ecommerce_rate_limits WHERE key = 'shopper-email:reserved'`).get().count, 3);
  assert.ok(answers.every(({ json }) => JSON.stringify(json) === '{"accepted":true,"limited":true}'));
  assert.ok(sqlite.prepare('SELECT key FROM _ecommerce_rate_limits').all().every(({ key }) => !key.includes('@')), 'counter keys never hold an address');
  sqlite.close();
});

test('parallel requests for one address stay within its limits', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const burst = (env, email, size) => Promise.all(Array.from({ length: size },
    (_, index) => account(env, { email }, { ip: `198.51.${100 + Math.floor(index / 200)}.${index % 200 + 1}`, settle: false })));

  const open = shop();
  const openAnswers = await burst(open.env, 'same@example.test', 20);
  await Promise.all(globalThis.pendingTasks.splice(0));
  assert.equal(open.sent.length, 3, 'three links per address per ten minutes');
  assert.ok(openAnswers.every(({ json }) => JSON.stringify(json) === '{"accepted":true}'));
  open.sqlite.close();

  const { sqlite, env, sent } = shop({ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '200' });
  addCustomers(sqlite);
  spentGeneralPool(sqlite, 150);
  const answers = await burst(env, 'verified@example.test', 40);
  await Promise.all(globalThis.pendingTasks.splice(0));
  assert.equal(sent.length, 2);
  assert.equal(sqlite.prepare(`SELECT count FROM _ecommerce_rate_limits WHERE key = 'shopper-email:reserved'`).get().count, 2);
  assert.ok(answers.every(({ json }) => JSON.stringify(json) === '{"accepted":true,"limited":true}'));
  sqlite.close();
});

test('a send from the reserve finishes after the response, and its failure never changes the answer', async (t) => {
  const logs = captureLogs(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const delivered = [];
  const EMAIL = { async send(message) { await gate; delivered.push(message); return { messageId: '<m@shop.test>' }; } };
  const { sqlite, env } = shop({ EMAIL, TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '4', TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY: '3' });
  addCustomers(sqlite);
  // The one general email of the day is already spent.
  sqlite.prepare(`INSERT INTO _ecommerce_rate_limits (key, count, window_start) VALUES ('shopper-email:daily', 1, ?)`)
    .run(Math.floor(Date.now() / 1000));
  const customer = await account(env, { email: 'verified@example.test' }, { settle: false });
  assert.deepEqual(customer.json, { accepted: true, limited: true });
  assert.equal(delivered.length, 0, 'the response came before the send');
  assert.equal(globalThis.pendingTasks.length, 1, 'the send was handed to waitUntil');
  release();
  await Promise.all(globalThis.pendingTasks.splice(0));
  assert.equal(delivered.length, 1);

  // A failed reserved send is logged by code, revokes its link and is never reported to the requester.
  env.EMAIL = emailBinding(bindingError('E_DELIVERY_FAILED'));
  const failed = await account(env, { email: 'buyer@example.test' }, { ip: '198.51.100.40' });
  assert.deepEqual([failed.status, failed.json], [200, { accepted: true, limited: true }]);
  const failure = logs.find((line) => line.text.includes('Sign-in email failed'));
  assert.deepEqual(failure.args[1], { provider: 'cloudflare', code: 'delivery_failed', providerCode: 'E_DELIVERY_FAILED' });
  assert.deepEqual(challengeRevoked(sqlite), [false, true]);
  assert.ok(logs.every((line) => !line.text.includes('@example.test')));

  // Called directly without waitUntil, the same work runs before the call returns and still never throws.
  const direct = await requestCustomerEmailSignIn(env, 'verified@example.test', (token) => token,
    async () => { throw new Error('provider down'); }, '198.51.100.41');
  assert.deepEqual(direct, { limited: true });
  assert.deepEqual(challengeRevoked(sqlite), [false, true, true]);
  assert.deepEqual(logs.at(-1).args[1], { name: 'Error' });
  sqlite.close();
});

test('the reserve defaults to a quarter of the daily limit, and an invalid reserve uses that default', async () => {
  const cases = [
    [{}, 150, 'default limit 200 keeps 50'],
    [{ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '8' }, 6, 'limit 8 keeps 2'],
    [{ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '3' }, 3, 'limit 3 keeps 0'],
    [{ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '8', TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY: '0' }, 8, 'a reserve of 0'],
    [{ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '8', TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY: '7' }, 1, 'a reserve just below the limit'],
    ...['8', '9', '-1', '1.5', 'lots', ' '].map((reserved) =>
      [{ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '8', TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY: reserved }, 6, `invalid reserve ${JSON.stringify(reserved)}`]),
  ];
  for (const [overrides, general, name] of cases) {
    const { sqlite, env } = shop(overrides);
    // Starts just below the general pool, so the next request is the last one it serves.
    sqlite.prepare(`INSERT INTO _ecommerce_rate_limits (key, count, window_start) VALUES ('shopper-email:daily', ?, ?)`)
      .run(general - 1, Math.floor(Date.now() / 1000));
    const send = async () => {};
    assert.deepEqual(await requestCustomerEmailSignIn(env, 'a@example.test', (token) => token, send), { limited: false }, name);
    assert.deepEqual(await requestCustomerEmailSignIn(env, 'b@example.test', (token) => token, send), { limited: true }, name);
    sqlite.close();
  }
});
