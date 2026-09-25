import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { CUSTOMER_SESSION_COOKIE, CustomerEmailLimitError, requestCustomerEmailSignIn } from '../dist/accounts.js';
import { readCustomerSignInToken } from '../dist/browser.js';

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

const ORIGIN = 'https://shop.test';
const migrationFiles = ['0004_ecommerce_plugin.sql', '0005_variant_value_images.sql', '0007_local_auth.sql',
  '0008_shared_components.sql', '0010_checkout_inventory.sql', '0011_order_payment_provider.sql',
  '0012_customer_accounts.sql', '0013_referrals_and_credit.sql', '0014_promotions.sql',
  '0015_gift_cards.sql', '0016_verified_customer_sessions.sql', '0017_commerce_fulfillment.sql',
  '0019_shared_customer_identity.sql'];

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

function shop(overrides = {}) {
  const { sqlite, DB } = database();
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
const challengeRevoked = (sqlite) => sqlite.prepare(`SELECT revoked_at FROM _ecommerce_customer_sessions
  WHERE purpose = 'email_challenge'`).all().map((row) => row.revoked_at !== null);

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
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_customer_sessions`).get().count, 2, 'no link was created');
  assert.ok(logs.some((line) => line.level === 'warn' && line.text.includes('Daily sign-in email limit reached')));

  // Requests the per-account limit drops send nothing and do not use the daily budget.
  const second = shop({ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: '3' });
  for (let attempt = 0; attempt < 5; attempt++) await account(second.env, { email: 'same@example.test' });
  assert.equal(second.sent.length, 3);
  assert.equal((await account(second.env, { email: 'other@example.test' })).status, 503);
  second.sqlite.close();

  // The window restarts after 24 hours; an invalid setting falls back to 200.
  sqlite.prepare(`UPDATE galaxy_auth_rate_limit SET last_request = last_request - 86400 WHERE key = 'shopper-email:daily'`).run();
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
