import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { hashPassword } from 'better-auth/crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

// The auth modules read their bindings from `cloudflare:workers`; serve them from this test.
const env = {};
globalThis.__talismanAuthTestEnv = env;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== 'cloudflare:workers') return nextResolve(specifier, context);
    return { url: 'data:text/javascript,export const env = globalThis.__talismanAuthTestEnv;', shortCircuit: true };
  },
});
const { LocalAuthAdapter, signInCloudflareAdmin } = await import('../dist/auth/local.js');
const { HybridAuthAdapter } = await import('../dist/auth/hybrid.js');
const { ensureVerifiedEmailIdentity } = await import('../dist/auth/identity.js');
const { authorizeCmsRequestWithAdapter } = await import('../dist/auth/authorize.js');

const ORIGIN = 'https://cms.example.test';
const TEAM_DOMAIN = 'https://talisman-test.cloudflareaccess.com';
const AUDIENCE = 'talisman-test-audience';
const ADMIN_EMAIL = 'owner@example.test';
const EDITOR_PASSWORD = 'editor-password-123';

const accessKey = await generateKeyPair('RS256');
const otherKey = await generateKeyPair('RS256');
const accessJwk = { ...await exportJWK(accessKey.publicKey), kid: 'access-key', alg: 'RS256', use: 'sig' };
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) return Response.json({ keys: [accessJwk] });
  throw new Error(`Unexpected fetch: ${url}`);
};

function d1(sqlite) {
  const statement = (sql, values = []) => ({
    bind: (...params) => statement(sql, params),
    all: async () => ({ results: sqlite.prepare(sql).all(...values), success: true, meta: {} }),
    raw: async () => {
      const prepared = sqlite.prepare(sql);
      prepared.setReturnArrays(true);
      return prepared.all(...values);
    },
    run: async () => {
      const result = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    },
    first: async (column) => {
      const row = sqlite.prepare(sql).get(...values) ?? null;
      return column && row ? row[column] : row;
    },
  });
  return { prepare: (sql) => statement(sql) };
}

function setup(prefix = 'TALISMAN') {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../drizzle/0007_local_auth.sql', import.meta.url), 'utf8'));
  sqlite.exec(`CREATE TABLE _ecommerce_customer_accounts (
    id text PRIMARY KEY NOT NULL, email text NOT NULL, email_normalized text NOT NULL UNIQUE,
    email_verified_at integer, name text, created_at integer NOT NULL, updated_at integer NOT NULL
  )`);
  const shared = readFileSync(new URL('../drizzle/0019_shared_customer_identity.sql', import.meta.url), 'utf8');
  for (const sql of shared.split('--> statement-breakpoint')) if (sql.trim()) sqlite.exec(sql);
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, {
    DB: d1(sqlite),
    [`${prefix}_AUTH_SECRET`]: 'talisman-test-secret-0123456789abcdef',
    [`${prefix}_ACCESS_TEAM_DOMAIN`]: TEAM_DOMAIN,
    [`${prefix}_ACCESS_AUDIENCE`]: AUDIENCE,
    [`${prefix}_ACCESS_ADMIN_EMAILS`]: ADMIN_EMAIL,
  });
  return sqlite;
}

async function addUser(sqlite, { id, email, role, password }) {
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO galaxy_auth_user (id, name, email, email_verified, created_at, updated_at, role)
    VALUES (?, ?, ?, 1, ?, ?, ?)`).run(id, email, email, now, now, role);
  if (password) {
    sqlite.prepare(`INSERT INTO galaxy_auth_account (id, account_id, provider_id, user_id, password, created_at, updated_at)
      VALUES (?, ?, 'credential', ?, ?, ?, ?)`).run(`${id}-credential`, id, id, await hashPassword(password), now, now);
  }
  return id;
}

function accessToken({ email = ADMIN_EMAIL, key = accessKey.privateKey, issuer = TEAM_DOMAIN, audience = AUDIENCE, expires = '5m' } = {}) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'access-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(key);
}

function sso(token, headers = {}) {
  return signInCloudflareAdmin(new Request(`${ORIGIN}/admin/sso`, {
    headers: { ...(token ? { 'cf-access-jwt-assertion': token } : {}), ...headers },
  }), '/admin');
}

function signIn(adapter, email, password, headers = { 'cf-connecting-ip': '203.0.113.9' }) {
  return adapter.handle(new Request(`${ORIGIN}/admin/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ email, password }),
  }));
}

function adminAction(adapter, cookie, action, body) {
  return adapter.handle(new Request(`${ORIGIN}/admin/api/auth/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie, 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify(body),
  }));
}

function cookieOf(response) {
  return response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
}

function cmsUser(adapter, cookie) {
  return adapter.getUser(new Request(`${ORIGIN}/admin`, { headers: { Cookie: cookie } }));
}

const sessionsOf = (sqlite, userId) => sqlite.prepare(`SELECT token, auth_method, ip_address FROM galaxy_auth_session WHERE user_id = ?`).all(userId);

test('sign-in rate limits are keyed by CF-Connecting-IP and cannot block Cloudflare SSO', async () => {
  const sqlite = setup();
  try {
    const adapter = HybridAuthAdapter('/admin');
    await addUser(sqlite, { id: 'editor-1', email: 'editor@example.test', role: 'editor', password: EDITOR_PASSWORD });
    const attacker = { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '192.0.2.1, 192.0.2.2' };
    for (let attempt = 0; attempt < 10; attempt++) {
      assert.equal((await signIn(adapter, 'nobody@example.test', 'wrong-password-123', attacker)).status, 401);
    }
    assert.equal((await signIn(adapter, 'nobody@example.test', 'wrong-password-123', attacker)).status, 429);
    const keys = sqlite.prepare('SELECT key, count FROM galaxy_auth_rate_limit').all().map(row => ({ ...row }));
    assert.deepEqual(keys, [{ key: '198.51.100.7|/sign-in/email', count: 10 }]);

    // Another client keeps its own bucket, while requests without a client IP share one.
    assert.equal((await signIn(adapter, 'editor@example.test', EDITOR_PASSWORD)).status, 200);
    for (let attempt = 0; attempt < 10; attempt++) await signIn(adapter, 'nobody@example.test', 'wrong-password-123', {});
    assert.equal((await signIn(adapter, 'nobody@example.test', 'wrong-password-123', {})).status, 429);

    // A verified admin is never blocked by exhausted sign-in buckets.
    assert.equal((await sso(await accessToken(), { 'cf-connecting-ip': '198.51.100.7' })).status, 303);
    assert.equal((await sso(await accessToken())).status, 303);
  } finally { sqlite.close(); }
});

test('Cloudflare SSO fails closed without a valid Access JWT and replaces sessions only after success', async () => {
  const sqlite = setup();
  try {
    const adapter = HybridAuthAdapter('/admin');
    const first = await sso(await accessToken(), { 'cf-connecting-ip': '203.0.113.20', 'user-agent': 'talisman-test' });
    assert.equal(first.status, 303);
    assert.equal(first.headers.get('location'), '/admin');
    const firstCookie = cookieOf(first);
    const admin = await cmsUser(adapter, firstCookie);
    assert.equal(admin?.role, 'admin');
    assert.equal(admin?.email, ADMIN_EMAIL);
    assert.deepEqual(sessionsOf(sqlite, admin.id).map(({ auth_method, ip_address }) => ({ auth_method, ip_address })),
      [{ auth_method: 'cloudflare', ip_address: '203.0.113.20' }]);

    const rejected = [
      undefined,
      'not-a-valid-jwt',
      await accessToken({ key: otherKey.privateKey }),
      await accessToken({ audience: 'another-application' }),
      await accessToken({ issuer: 'https://attacker.cloudflareaccess.com' }),
      await accessToken({ expires: Math.floor(Date.now() / 1000) - 60 }),
      await accessToken({ email: 'editor@example.test' }),
    ];
    for (const token of rejected) assert.equal((await sso(token)).status, 403);
    assert.equal(sessionsOf(sqlite, admin.id).length, 1);
    assert.equal((await cmsUser(adapter, firstCookie))?.id, admin.id);

    // A verified sign-in that cannot issue its new session must not sign the admin out elsewhere.
    sqlite.exec(`CREATE TRIGGER block_session BEFORE INSERT ON galaxy_auth_session BEGIN SELECT RAISE(ABORT, 'unavailable'); END`);
    assert.notEqual(await sso(await accessToken()).then(response => response.status, () => 'threw'), 303);
    sqlite.exec('DROP TRIGGER block_session');
    assert.equal((await cmsUser(adapter, firstCookie))?.id, admin.id);

    const credential = () => sqlite.prepare(`SELECT password FROM galaxy_auth_account WHERE user_id = ?`).get(admin.id).password;
    const storedCredential = credential();
    const second = await sso(await accessToken());
    assert.equal(second.status, 303);
    assert.equal(credential(), storedCredential, 'a valid stored SSO credential is reused, not re-hashed');
    assert.equal(await cmsUser(adapter, firstCookie), null, 'older admin sessions are revoked after a new SSO sign-in');
    assert.equal((await cmsUser(adapter, cookieOf(second)))?.id, admin.id);
    assert.equal(sessionsOf(sqlite, admin.id).length, 1);

    sqlite.prepare(`UPDATE galaxy_auth_account SET password = ? WHERE user_id = ?`).run(await hashPassword('password-set-elsewhere'), admin.id);
    const repaired = await sso(await accessToken());
    assert.equal(repaired.status, 303);
    assert.notEqual(credential(), storedCredential);
    assert.equal((await cmsUser(adapter, cookieOf(repaired)))?.role, 'admin');
    assert.equal((await signIn(LocalAuthAdapter('/admin', { requireAccess: false }), ADMIN_EMAIL, 'password-set-elsewhere')).status, 401);
  } finally { sqlite.close(); }
});

test('deployments that still use the GALAXY_* setting names keep working', async () => {
  const sqlite = setup('GALAXY');
  try {
    const adapter = HybridAuthAdapter('/admin');
    const signedIn = await sso(await accessToken());
    assert.equal(signedIn.status, 303);
    assert.equal((await cmsUser(adapter, cookieOf(signedIn)))?.role, 'admin');

    // A TALISMAN_* value takes precedence over its legacy name.
    env.TALISMAN_ACCESS_ADMIN_EMAILS = 'someone-else@example.test';
    assert.equal(await cmsUser(adapter, cookieOf(signedIn)), null);
    assert.equal((await sso(await accessToken())).status, 403);
  } finally { sqlite.close(); }
});

test('hybrid password sign-in never issues a session for an admin row', async () => {
  const sqlite = setup();
  try {
    const adapter = HybridAuthAdapter('/admin');
    const ssoCookie = cookieOf(await sso(await accessToken()));
    const admin = await cmsUser(adapter, ssoCookie);
    await addUser(sqlite, { id: 'legacy-admin', email: 'legacy@example.test', role: 'admin', password: 'legacy-admin-password' });

    const legacy = await signIn(adapter, 'legacy@example.test', 'legacy-admin-password');
    assert.equal(legacy.status, 401);
    assert.deepEqual(legacy.headers.getSetCookie(), []);
    assert.equal(sessionsOf(sqlite, 'legacy-admin').length, 0);
    assert.equal((await signIn(adapter, ADMIN_EMAIL, 'guessed-admin-password')).status, 401);
    assert.equal(sessionsOf(sqlite, admin.id).length, 1);

    // Outside hybrid mode the same row is an ordinary admin account.
    const local = LocalAuthAdapter('/admin', { requireAccess: false });
    const localSignIn = await signIn(local, 'legacy@example.test', 'legacy-admin-password');
    assert.equal(localSignIn.status, 200);
    assert.equal((await cmsUser(local, cookieOf(localSignIn)))?.role, 'admin');
    assert.equal(await cmsUser(adapter, cookieOf(localSignIn)), null, 'hybrid mode rejects admin password sessions');

    sqlite.prepare(`UPDATE galaxy_auth_session SET auth_method = NULL WHERE user_id = ?`).run(admin.id);
    assert.equal(await cmsUser(adapter, ssoCookie), null, 'an allowlisted admin still needs a Cloudflare session');
    sqlite.prepare(`UPDATE galaxy_auth_session SET auth_method = 'cloudflare' WHERE user_id = ?`).run(admin.id);
    assert.equal((await cmsUser(adapter, ssoCookie))?.id, admin.id);
    env.TALISMAN_ACCESS_ADMIN_EMAILS = 'someone-else@example.test';
    assert.equal(await cmsUser(adapter, ssoCookie), null, 'removing an email from the allowlist ends its admin access');
  } finally { sqlite.close(); }
});

test('customer identities are never authorised for the CMS', async () => {
  const sqlite = setup();
  try {
    const hybrid = HybridAuthAdapter('/admin');
    const local = LocalAuthAdapter('/admin', { requireAccess: false });
    const shopperId = await ensureVerifiedEmailIdentity(env, 'shopper@example.test', 'Shopper');
    await addUser(sqlite, { id: 'former-editor', email: 'former@example.test', role: 'customer', password: 'former-editor-password' });

    for (const adapter of [hybrid, local]) {
      assert.equal((await signIn(adapter, 'shopper@example.test', 'any-password-123')).status, 401);
      const former = await signIn(adapter, 'former@example.test', 'former-editor-password');
      assert.equal(former.status, 401);
      assert.deepEqual(former.headers.getSetCookie(), []);
    }
    assert.equal(sessionsOf(sqlite, shopperId).length, 0);
    assert.equal(sessionsOf(sqlite, 'former-editor').length, 0);

    await addUser(sqlite, { id: 'editor-1', email: 'editor@example.test', role: 'editor', password: EDITOR_PASSWORD });
    const cookie = cookieOf(await signIn(hybrid, 'editor@example.test', EDITOR_PASSWORD));
    assert.equal((await cmsUser(hybrid, cookie))?.role, 'editor');
    sqlite.prepare(`UPDATE galaxy_auth_user SET role = 'customer' WHERE id = 'editor-1'`).run();
    for (const adapter of [hybrid, local]) {
      assert.equal(await cmsUser(adapter, cookie), null);
      const request = new Request(`${ORIGIN}/admin/api/collections`, { headers: { Cookie: cookie } });
      assert.equal((await authorizeCmsRequestWithAdapter(request, adapter, true)).response?.status, 401);
    }
  } finally { sqlite.close(); }
});

test('hybrid sign-in answers identically whether or not an email has an account', async () => {
  const sqlite = setup();
  try {
    const adapter = HybridAuthAdapter('/admin');
    assert.equal((await sso(await accessToken())).status, 303);
    await ensureVerifiedEmailIdentity(env, 'shopper@example.test', 'Shopper');
    await addUser(sqlite, { id: 'editor-1', email: 'editor@example.test', role: 'editor', password: EDITOR_PASSWORD });
    await addUser(sqlite, { id: 'legacy-admin', email: 'legacy@example.test', role: 'admin', password: 'legacy-admin-password' });

    const describe = async (response) => ({
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type'),
      cacheControl: response.headers.get('cache-control'),
      cookies: response.headers.getSetCookie(),
      body: await response.text(),
    });
    const unknown = await describe(await signIn(adapter, 'nobody@example.test', 'wrong-password-123'));
    assert.equal(unknown.status, 401);
    for (const [email, password] of [
      ['shopper@example.test', 'wrong-password-123'],
      ['SHOPPER@example.test', 'wrong-password-123'],
      [ADMIN_EMAIL, 'wrong-password-123'],
      ['legacy@example.test', 'wrong-password-123'],
      ['legacy@example.test', 'legacy-admin-password'],
      ['editor@example.test', 'wrong-password-123'],
    ]) {
      assert.deepEqual(await describe(await signIn(adapter, email, password)), unknown, email);
    }
  } finally { sqlite.close(); }
});

test('admin actions reject non-string user ids and roles before their guards', async () => {
  const sqlite = setup();
  try {
    const adapter = HybridAuthAdapter('/admin');
    const adminCookie = cookieOf(await sso(await accessToken()));
    const admin = await cmsUser(adapter, adminCookie);
    await addUser(sqlite, { id: 'editor-1', email: 'editor@example.test', role: 'editor', password: EDITOR_PASSWORD });
    const editorCookie = cookieOf(await signIn(adapter, 'editor@example.test', EDITOR_PASSWORD));
    const newPassword = 'replacement-password-123';

    for (const userId of [['editor-1'], [admin.id], { id: 'editor-1' }, 42, '']) {
      assert.equal((await adminAction(adapter, adminCookie, 'admin/set-user-password', { userId, newPassword })).status, 400);
    }
    assert.equal((await cmsUser(adapter, editorCookie))?.role, 'editor');
    assert.equal((await signIn(adapter, 'editor@example.test', newPassword)).status, 401);
    assert.equal((await adminAction(adapter, adminCookie, 'admin/set-user-password', { userId: admin.id, newPassword })).status, 403);

    assert.equal((await adminAction(adapter, adminCookie, 'admin/set-role', { userId: ['editor-1'], role: 'customer' })).status, 400);
    assert.equal((await adminAction(adapter, adminCookie, 'admin/set-role', { userId: 'editor-1', role: ['customer'] })).status, 400);
    assert.equal((await adminAction(adapter, adminCookie, 'admin/create-user',
      { email: 'new@example.test', name: 'New', password: newPassword, role: ['editor'] })).status, 400);
    assert.equal(sqlite.prepare(`SELECT role FROM galaxy_auth_user WHERE id = 'editor-1'`).get().role, 'editor');

    const reset = await adminAction(adapter, adminCookie, 'admin/set-user-password', { userId: 'editor-1', newPassword });
    assert.equal(reset.status, 200);
    assert.equal(await cmsUser(adapter, editorCookie), null, 'a password reset revokes existing sessions');
    assert.equal((await signIn(adapter, 'editor@example.test', newPassword)).status, 200);
  } finally { sqlite.close(); }
});

test('hybrid admin actions keep SSO accounts in Access and promote shoppers only through Add editor', async () => {
  const sqlite = setup();
  try {
    const adapter = HybridAuthAdapter('/admin');
    const adminCookie = cookieOf(await sso(await accessToken()));
    const admin = await cmsUser(adapter, adminCookie);
    await addUser(sqlite, { id: 'legacy-admin', email: 'legacy@example.test', role: 'admin', password: 'legacy-admin-password' });
    const shopperId = await ensureVerifiedEmailIdentity(env, 'shopper@example.test', 'Shopper');
    const password = 'shopper-editor-password';

    assert.equal((await adminAction(adapter, adminCookie, 'admin/set-role', { userId: admin.id, role: 'editor' })).status, 400);
    assert.equal((await adminAction(adapter, adminCookie, 'admin/set-role', { userId: 'legacy-admin', role: 'editor' })).status, 403);
    assert.equal((await adminAction(adapter, adminCookie, 'admin/set-role', { userId: shopperId, role: 'editor' })).status, 400);
    assert.equal((await adminAction(adapter, adminCookie, 'admin/create-user',
      { email: 'new-admin@example.test', name: 'New admin', password, role: 'admin' })).status, 400);

    const promoted = await adminAction(adapter, adminCookie, 'admin/create-user',
      { email: 'Shopper@Example.test', name: 'Shopper', password, role: 'editor' });
    assert.equal(promoted.status, 200);
    assert.equal((await promoted.json()).user.id, shopperId);
    const editorSignIn = await signIn(adapter, 'shopper@example.test', password);
    assert.equal(editorSignIn.status, 200);
    assert.equal((await cmsUser(adapter, cookieOf(editorSignIn)))?.role, 'editor');
  } finally { sqlite.close(); }
});
