import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { CUSTOMER_SESSION_COOKIE, CustomerEmailLimitError, requestCustomerEmailSignIn } from '../dist/accounts.js';
import { previewCustomerSignIn, readCustomerSignInToken } from '../dist/browser.js';

// The account route reads its bindings from cloudflare:workers, and the email runtime reads the
// provider registered with talismanCms({ email }) from a virtual module. Both come from this test.
const stubs = {
  'cloudflare:workers': 'export const env = new Proxy({}, { get: (_, key) => globalThis.workerEnv?.[key] });',
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
  '0019_shared_customer_identity.sql', '0024_shopper_sign_in_tokens.sql'];

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

async function account(env, body, { origin = ORIGIN, ip = '203.0.113.10', cookies = cookieJar() } = {}) {
  globalThis.workerEnv = env;
  const request = new Request(`${ORIGIN}/api/ecommerce/account`, {
    method: 'POST',
    headers: { origin, 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(body),
  });
  const response = await ALL({ request, cookies });
  return { status: response.status, json: await response.json(), cookies };
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
  assert.deepEqual([limited.status, limited.json], [503, { error: 'Too many sign-in emails were requested today. Please try again later.' }]);
  assert.equal(sent.length, 2, 'the daily cap still holds');
  sqlite.close();
});

test('links sent before migration 0024 still work, and its counters move out of better-auth\'s table', async () => {
  const before = migrationFiles.filter((migration) => migration !== '0024_shopper_sign_in_tokens.sql');
  const { sqlite, env } = shop({}, before);
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
  applyMigration(sqlite, '0024_shopper_sign_in_tokens.sql');

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
  assert.deepEqual([limited.status, limited.json], [503, { error: 'Too many sign-in emails were requested today. Please try again later.' }]);
  assert.equal(sent.length, 2);
  assert.equal(count(sqlite, '_ecommerce_sign_in_tokens'), 2, 'no link was created');
  assert.ok(logs.some((line) => line.level === 'warn' && line.text.includes('Daily sign-in email limit reached')));

  // Requests the per-account limit drops send nothing and do not use the daily budget.
  const second = shop({ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '3' });
  for (let attempt = 0; attempt < 5; attempt++) await account(second.env, { email: 'same@example.test' });
  assert.equal(second.sent.length, 3);
  assert.equal((await account(second.env, { email: 'other@example.test' })).status, 503);
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

test('requestCustomerEmailSignIn throws CustomerEmailLimitError at the daily limit', async () => {
  const { sqlite, env } = shop({ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '1' });
  let sends = 0;
  await requestCustomerEmailSignIn(env, 'a@example.test', (token) => token, async () => { sends++; });
  await assert.rejects(requestCustomerEmailSignIn(env, 'b@example.test', (token) => token, async () => { sends++; }),
    (error) => error instanceof CustomerEmailLimitError && error.name === 'CustomerEmailLimitError');
  assert.equal(sends, 1);
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
