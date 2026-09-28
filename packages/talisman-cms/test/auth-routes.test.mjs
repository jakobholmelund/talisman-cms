import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { applyCoreMigrations } from './helpers/migrations.mjs';

// The auth routes and the plugin route guard ship as source and import Astro virtual modules, so this
// file loads them with Node's type stripping and stands in for the virtual modules and `cloudflare:workers`.
const canLoadSource = Boolean(process.features.typescript) && typeof registerHooks === 'function';
const skip = canLoadSource ? false : 'needs Node type stripping and module.registerHooks';

const runtime = globalThis.__talismanRouteTest = {
  env: {},
  protectedRoutes: {},
  setAdapter: null,
};
const stubs = {
  'cloudflare:workers': 'export const env = new Proxy({}, { get: (_, key) => globalThis.__talismanRouteTest.env[key] });',
  'virtual:talisman-cms/auth': `export const authConfigured = true;
    export let authAdapter = null;
    globalThis.__talismanRouteTest.setAdapter = (adapter) => { authAdapter = adapter; };`,
  'virtual:talisman-cms/config': 'export const adminPath = "/admin";',
  'virtual:talisman-cms/protected-routes': 'export const adminPath = "/admin"; export const protectedRoutes = globalThis.__talismanRouteTest.protectedRoutes;',
};
const srcUrl = new URL('../src/', import.meta.url).href;

let onRequest;
let setupRoute;
let ssoRoute;
if (canLoadSource) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (Object.hasOwn(stubs, specifier)) {
        return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
      }
      if (context.parentURL?.startsWith(srcUrl) && specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      return nextResolve(specifier, context);
    },
  });
  ({ onRequest } = await import('../src/routes/plugin-route-guard.ts'));
  setupRoute = await import('../src/routes/api/auth/setup.ts');
  ssoRoute = await import('../src/routes/api/auth/sso.ts');
}

const ORIGIN = 'https://cms.example.test';

function context(path, { routePattern = path.split('?')[0], method = 'GET', headers = {} } = {}) {
  return { routePattern, request: new Request(`${ORIGIN}${path}`, { method, headers }) };
}

function nextResponse() {
  const next = async () => {
    next.calls += 1;
    return new Response('route ran');
  };
  next.calls = 0;
  return next;
}

test('the plugin route guard requires a CMS session on protected plugin routes only', { skip }, async () => {
  Object.assign(runtime.protectedRoutes, { '/admin/api/tools/export': 'endpoint', '/admin/api/tools/items/[id]': 'endpoint', '/admin/tools-preview': 'page' });
  let user = null;
  runtime.setAdapter({ getUser: async () => user });

  let next = nextResponse();
  const denied = await onRequest(context('/admin/api/tools/export'), next);
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: 'Unauthorized' });
  assert.equal(next.calls, 0);

  next = nextResponse();
  assert.equal((await onRequest(context('/admin/api/tools/items/42', { routePattern: '/admin/api/tools/items/[id]' }), next)).status, 401);
  assert.equal(next.calls, 0);

  next = nextResponse();
  const redirected = await onRequest(context('/admin/tools-preview?mode=dark'), next);
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get('location'), '/admin');
  assert.equal(redirected.headers.get('cache-control'), 'no-store');
  assert.equal(next.calls, 0);

  // Public plugin endpoints, core routes and site pages are not the guard's concern.
  for (const pattern of ['/api/ecommerce/cart', '/admin/api/[...route]', '/admin/[...route]', '/shop/[slug]']) {
    next = nextResponse();
    assert.equal(await (await onRequest(context(pattern), next)).text(), 'route ran', pattern);
    assert.equal(next.calls, 1);
  }

  user = { id: 'editor-1', email: 'editor@example.test', role: 'editor' };
  for (const path of ['/admin/api/tools/export', '/admin/tools-preview']) {
    next = nextResponse();
    assert.equal(await (await onRequest(context(path), next)).text(), 'route ran', path);
    assert.equal(next.calls, 1);
  }
  next = nextResponse();
  const crossOrigin = await onRequest(context('/admin/api/tools/export', { method: 'POST', headers: { origin: 'https://attacker.test' } }), next);
  assert.equal(crossOrigin.status, 403);
  assert.equal(next.calls, 0);

  runtime.setAdapter(null);
  assert.equal((await onRequest(context('/admin/api/tools/export'), nextResponse())).status, 500, 'fails closed without an adapter');
});

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

const SETUP_TOKEN = 'setup-token-0123456789abcdef0123456789';

function setupDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  applyCoreMigrations(sqlite);
  runtime.env = {
    DB: d1(sqlite),
    TALISMAN_AUTH_SECRET: 'talisman-test-secret-0123456789abcdef',
    TALISMAN_AUTH_SETUP_TOKEN: SETUP_TOKEN,
  };
  runtime.setAdapter({ __talismanAuthRuntime: { moduleId: 'talisman-cms/auth/local', exportName: 'LocalAuthAdapter' } });
  return sqlite;
}

function addAccount(sqlite, id, email, role) {
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO galaxy_auth_user (id, name, email, email_verified, created_at, updated_at, role)
    VALUES (?, ?, ?, 1, ?, ?, ?)`).run(id, email, email, now, now, role);
}

function createFirstAdmin(email) {
  return setupRoute.POST({ request: new Request(`${ORIGIN}/admin/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'x-talisman-setup-token': SETUP_TOKEN },
    body: JSON.stringify({ email, name: 'Owner', password: 'first-admin-password' }),
  }) });
}

const adminCount = (sqlite) => sqlite.prepare(`SELECT count(*) AS total FROM galaxy_auth_user WHERE role = 'admin'`).get().total;

test('first-admin setup refuses an email that already belongs to a shopper or another account', { skip }, async () => {
  const sqlite = setupDatabase();
  try {
    addAccount(sqlite, 'shopper-1', 'shopper@example.test', 'customer');
    addAccount(sqlite, 'editor-1', 'editor@example.test', 'editor');

    const shopper = await createFirstAdmin('Shopper@Example.test');
    assert.equal(shopper.status, 409);
    assert.match((await shopper.json()).error, /belongs to a shopper account.*different email/);
    const editor = await createFirstAdmin('editor@example.test');
    assert.equal(editor.status, 409);
    assert.match((await editor.json()).error, /already has an account/);
    assert.equal(sqlite.prepare(`SELECT role FROM galaxy_auth_user WHERE id = 'shopper-1'`).get().role, 'customer');
    assert.equal(adminCount(sqlite), 0);

    const status = await setupRoute.GET({ request: new Request(`${ORIGIN}/admin/api/auth/setup`) });
    assert.deepEqual(await status.json(), { required: true });

    assert.equal((await createFirstAdmin('owner@example.test')).status, 201);
    assert.equal(adminCount(sqlite), 1);
    assert.equal((await createFirstAdmin('second@example.test')).status, 409, 'setup runs only once');
  } finally { sqlite.close(); }
});

test('the setup check answers plainly, and the SSO route exists, only for the auth mode that has them', { skip }, async () => {
  const setupCheck = () => setupRoute.GET({ request: new Request(`${ORIGIN}/admin/api/auth/setup`) });
  const ssoRequest = () => ssoRoute.GET({ request: new Request(`${ORIGIN}/admin/sso`) });
  for (const moduleId of ['talisman-cms/auth/hybrid', 'talisman-cms/auth/access', 'talisman-cms/auth/dev']) {
    runtime.setAdapter({ __talismanAuthRuntime: { moduleId, exportName: 'Adapter' }, getUser: async () => null });
    const status = await setupCheck();
    assert.equal(status.status, 200, moduleId);
    assert.deepEqual(await status.json(), { required: false });
    assert.equal(status.headers.get('cache-control'), 'no-store');
    // Setup itself stays unavailable outside local auth.
    assert.equal((await setupRoute.POST({ request: new Request(`${ORIGIN}/admin/api/auth/setup`, { method: 'POST', headers: { Origin: ORIGIN } }) })).status, 404);
    assert.equal((await ssoRequest()).status, moduleId === 'talisman-cms/auth/hybrid' ? 403 : 404, `SSO under ${moduleId}`);
  }
  // Under local auth the check reads the database, and the SSO route does not exist.
  const sqlite = setupDatabase();
  try {
    assert.deepEqual(await (await setupCheck()).json(), { required: true });
    assert.equal((await ssoRequest()).status, 404);
  } finally { sqlite.close(); }
  runtime.setAdapter(null);
});
