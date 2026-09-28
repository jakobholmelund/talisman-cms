import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { hashPassword } from 'better-auth/crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

// Every auth mode against every kind of caller: who gets a CMS user, who may open a protected plugin
// route or an admin-only one, and who can sign in with a password. The auth modules read their
// bindings from `cloudflare:workers`; this test serves them.
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
const { AccessAuthAdapter } = await import('../dist/auth/access.js');
const { DevAuthAdapter } = await import('../dist/auth/dev.js');
const { authorizeCmsRequestWithAdapter } = await import('../dist/auth/authorize.js');

const ORIGIN = 'https://cms.example.test';
const TEAM_DOMAIN = 'https://talisman-test.cloudflareaccess.com';
const AUDIENCE = 'talisman-test-audience';
const ADMIN_EMAIL = 'owner@example.test';
const PASSWORD = 'a-password-of-twelve';

const accessKey = await generateKeyPair('RS256');
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

async function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../drizzle/0007_local_auth.sql', import.meta.url), 'utf8'));
  sqlite.exec(`CREATE TABLE _ecommerce_customer_accounts (
    id text PRIMARY KEY NOT NULL, email text NOT NULL, email_normalized text NOT NULL UNIQUE,
    email_verified_at integer, name text, created_at integer NOT NULL, updated_at integer NOT NULL
  )`);
  for (const sql of readFileSync(new URL('../drizzle/0019_shared_customer_identity.sql', import.meta.url), 'utf8').split('--> statement-breakpoint')) {
    if (sql.trim()) sqlite.exec(sql);
  }
  const now = Math.floor(Date.now() / 1000);
  const hashed = await hashPassword(PASSWORD);
  for (const [id, email, role, banned] of [
    ['shopper', 'shopper@example.test', 'customer', 0],
    ['editor', 'editor@example.test', 'editor', 0],
    ['admin', 'admin@example.test', 'admin', 0],
    ['banned', 'banned@example.test', 'editor', 1],
  ]) {
    sqlite.prepare(`INSERT INTO galaxy_auth_user (id, name, email, email_verified, created_at, updated_at, role, banned)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)`).run(id, email, email, now, now, role, banned);
    sqlite.prepare(`INSERT INTO galaxy_auth_account (id, account_id, provider_id, user_id, password, created_at, updated_at)
      VALUES (?, ?, 'credential', ?, ?, ?, ?)`).run(`${id}-credential`, id, id, hashed, now, now);
  }
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, {
    DB: d1(sqlite),
    TALISMAN_AUTH_SECRET: 'talisman-test-secret-0123456789abcdef',
    TALISMAN_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    TALISMAN_ACCESS_AUDIENCE: AUDIENCE,
    TALISMAN_ACCESS_ADMIN_EMAILS: ADMIN_EMAIL,
    TALISMAN_ACCESS_EDITOR_EMAILS: 'editor@example.test',
  });
  return sqlite;
}

const accessToken = (email) => new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'access-key' })
  .setIssuer(TEAM_DOMAIN).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('5m').sign(accessKey.privateKey);

const cookieOf = (response) => response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');

function signIn(adapter, email) {
  return adapter.handle(new Request(`${ORIGIN}/admin/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify({ email, password: PASSWORD }),
  }));
}

/** Request headers that identify each kind of caller in a mode, or null when that caller cannot exist there. */
const callers = {
  anonymous: async () => ({}),
  shopper: async (mode, adapter) => mode.password ? { signIn: await signIn(adapter, 'shopper@example.test') } : null,
  editor: async (mode, adapter) => mode.password ? { signIn: await signIn(adapter, 'editor@example.test') }
    : mode.jwt ? { 'cf-access-jwt-assertion': await accessToken('editor@example.test') } : null,
  admin: async (mode, adapter) => mode.password ? { signIn: await signIn(adapter, 'admin@example.test') }
    : mode.jwt ? { 'cf-access-jwt-assertion': await accessToken(ADMIN_EMAIL) } : null,
  banned: async (mode, adapter) => mode.password ? { signIn: await signIn(adapter, 'banned@example.test') } : null,
  unlisted: async (mode) => mode.jwt ? { 'cf-access-jwt-assertion': await accessToken('nobody@example.test') } : null,
  sso: async (mode) => mode.sso ? { sso: await signInCloudflareAdmin(new Request(`${ORIGIN}/admin/sso`, { headers: { 'cf-access-jwt-assertion': await accessToken(ADMIN_EMAIL) } }), '/admin') } : null,
  stale: async (mode) => {
    if (!mode.sso) return null;
    const sso = await signInCloudflareAdmin(new Request(`${ORIGIN}/admin/sso`, { headers: { 'cf-access-jwt-assertion': await accessToken(ADMIN_EMAIL) } }), '/admin');
    env.TALISMAN_ACCESS_ADMIN_EMAILS = 'someone-else@example.test';
    return { sso };
  },
};

const modes = {
  local: { make: () => LocalAuthAdapter('/admin', { requireAccess: false }), password: true },
  hybrid: { make: () => HybridAuthAdapter('/admin'), password: true, sso: true },
  access: { make: () => AccessAuthAdapter('/admin'), jwt: true },
  dev: { make: () => DevAuthAdapter() },
};

// mode, caller, the CMS role seen, a protected plugin route, an admin-only route, the password sign-in status
const expectations = [
  ['local', 'anonymous', null, 401, 401, null],
  ['local', 'shopper', null, 401, 401, 401],
  ['local', 'editor', 'editor', 200, 403, 200],
  ['local', 'admin', 'admin', 200, 200, 200],
  ['local', 'banned', null, 401, 401, 401],
  ['hybrid', 'anonymous', null, 401, 401, null],
  ['hybrid', 'shopper', null, 401, 401, 401],
  ['hybrid', 'editor', 'editor', 200, 403, 200],
  ['hybrid', 'admin', null, 401, 401, 401],
  ['hybrid', 'banned', null, 401, 401, 401],
  ['hybrid', 'sso', 'admin', 200, 200, null],
  ['hybrid', 'stale', null, 401, 401, null],
  ['access', 'anonymous', null, 401, 401, null],
  ['access', 'editor', 'editor', 200, 403, null],
  ['access', 'admin', 'admin', 200, 200, null],
  ['access', 'unlisted', null, 401, 401, null],
  ['dev', 'anonymous', null, 401, 401, null],
];

for (const [modeName, callerName, role, pluginStatus, adminStatus, signInStatus] of expectations) {
  test(`${modeName} auth: ${callerName}`, async () => {
    const sqlite = await database();
    try {
      const mode = modes[modeName];
      const adapter = mode.make();
      const identity = await callers[callerName](mode, adapter);
      assert.ok(identity, `${callerName} exists under ${modeName}`);
      const headers = { ...identity };
      delete headers.signIn;
      delete headers.sso;
      if (identity.signIn) {
        assert.equal(identity.signIn.status, signInStatus, 'password sign-in');
        if (identity.signIn.ok) headers.Cookie = cookieOf(identity.signIn);
        else assert.deepEqual(identity.signIn.headers.getSetCookie(), [], 'a refused sign-in sets no cookie');
      }
      if (identity.sso) {
        assert.equal(identity.sso.status, 303);
        headers.Cookie = cookieOf(identity.sso);
      }
      const request = (path) => new Request(`${ORIGIN}${path}`, { headers });
      const user = await adapter.getUser(request('/admin'));
      assert.equal(user?.role ?? null, role, 'the CMS user');

      const plugin = await authorizeCmsRequestWithAdapter(request('/admin/api/reviews/list'), adapter, true);
      assert.equal(plugin.response?.status ?? 200, pluginStatus, 'a protected plugin route');
      const adminOnly = await authorizeCmsRequestWithAdapter(request('/admin/api/reviews/approve'), adapter, true, 'admin');
      assert.equal(adminOnly.response?.status ?? 200, adminStatus, 'an admin-only route');
      if (adminStatus === 200) assert.equal(adminOnly.user.role, 'admin');
      // No caller ever gets a shopper into the CMS.
      assert.notEqual(user?.role, 'customer');
      assert.equal(sqlite.prepare(`SELECT role FROM galaxy_auth_user WHERE id = 'shopper'`).get().role, 'customer');
    } finally { sqlite.close(); }
  });
}

test('the auth proxy only exists for password modes, and Access sign-out leaves through Cloudflare', async () => {
  const sqlite = await database();
  try {
    assert.equal(typeof modes.local.make().handle, 'function');
    assert.equal(typeof modes.hybrid.make().handle, 'function');
    assert.equal(modes.access.make().handle, undefined);
    assert.equal(modes.dev.make().handle, undefined);
    assert.equal((await modes.access.make().signOut(new Request(`${ORIGIN}/admin`))).headers.get('location'), `${ORIGIN}/cdn-cgi/access/logout`);
  } finally { sqlite.close(); }
});
