import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { authorizeCmsRequestWithAdapter } from '../dist/auth/authorize.js';
import { DevAuthAdapter } from '../dist/auth/dev.js';
import { LocalAuthAdapter, getAccessEmail, signInCloudflareAdmin } from '../dist/auth/local.js';
import { HybridAuthAdapter } from '../dist/auth/hybrid.js';
import { AccessAuthAdapter } from '../dist/auth/access.js';
import { talismanLoader } from '../dist/loader.js';

const editorAdapter = {
  async getUser() { return { id: 'editor', email: 'editor@example.test', role: 'editor' }; },
};

test('private CMS requests fail closed and reject cross-origin changes', async () => {
  const request = new Request('https://example.test/admin/api/collections', { method: 'POST' });
  assert.equal((await authorizeCmsRequestWithAdapter(request, null, false)).response.status, 503);
  assert.equal((await authorizeCmsRequestWithAdapter(request, null, true)).response.status, 500);
  assert.equal((await authorizeCmsRequestWithAdapter(request, { async getUser() { return null; } }, true)).response.status, 401);

  const crossOrigin = new Request(request.url, {
    method: 'POST',
    headers: { origin: 'https://other.test' },
  });
  assert.equal((await authorizeCmsRequestWithAdapter(crossOrigin, editorAdapter, true)).response.status, 403);
  assert.equal((await authorizeCmsRequestWithAdapter(request, editorAdapter, true, 'admin')).response.status, 403);
  assert.equal((await authorizeCmsRequestWithAdapter(request, editorAdapter, true)).user.role, 'editor');
});

test('development auth grants access only under the Vite dev server and on local hosts', async () => {
  // Outside Vite, as in a build where Vite replaced import.meta.env.DEV with false, nobody is signed in.
  assert.equal(await DevAuthAdapter().getUser(new Request('http://localhost:4321/admin')), null);

  // Stand in for Vite's replacement of import.meta.env.DEV. The copy loads from a data: URL, so its
  // relative chunk imports are pointed at dist.
  const moduleUrl = new URL('../dist/auth/dev.js', import.meta.url);
  const source = readFileSync(moduleUrl, 'utf8')
    .replace(/(["'])(\.\.?\/[^"']+)\1/g, (_, quote, specifier) => `${quote}${new URL(specifier, moduleUrl).href}${quote}`);
  assert.match(source, /import\.meta\.env\.DEV/);
  const underVite = async (dev) => (await import(`data:text/javascript,${encodeURIComponent(
    source.replaceAll('import.meta.env.DEV', String(dev)))}`)).DevAuthAdapter();
  const devServer = await underVite(true);
  assert.equal((await devServer.getUser(new Request('http://localhost:4321/admin')))?.role, 'admin');
  assert.equal((await devServer.getUser(new Request('http://[::1]:4321/admin')))?.role, 'admin');
  assert.equal(await devServer.getUser(new Request('https://example.test/admin')), null);
  assert.equal(await (await underVite(false)).getUser(new Request('http://localhost:4321/admin')), null);
});

test('local auth preserves its runtime path and requires both Access settings', async () => {
  const request = new Request('https://example.test/cms');
  // The integration passes its admin path at runtime; a path given here is only recorded for the mismatch check.
  assert.deepEqual(LocalAuthAdapter('/cms/').__talismanAuthRuntime, { moduleId: 'talisman-cms/auth/local', exportName: 'LocalAuthAdapter', type: 'factory', args: [], adminPath: true, configuredAdminPath: '/cms' });
  assert.deepEqual(LocalAuthAdapter(undefined, { requireAccess: false }).__talismanAuthRuntime.args, [{ requireAccess: false }]);
  assert.equal(LocalAuthAdapter().__talismanAuthRuntime.configuredAdminPath, undefined);
  assert.equal(await getAccessEmail(request, {}), undefined);
  assert.equal(await getAccessEmail(request, { TALISMAN_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com' }), null);
  // Pre-rename GALAXY_* names are still read, and blank values count as unset.
  assert.equal(await getAccessEmail(request, { GALAXY_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com' }), null);
  assert.equal(await getAccessEmail(request, { TALISMAN_ACCESS_TEAM_DOMAIN: ' ', TALISMAN_ACCESS_AUDIENCE: '' }), undefined);
  assert.equal(await getAccessEmail(request, {
    TALISMAN_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
    TALISMAN_ACCESS_AUDIENCE: 'audience',
  }), null);
});

test('hybrid auth exposes its reusable adapter and Cloudflare SSO fails closed without a verified token', async () => {
  const adapter = HybridAuthAdapter('/cms/');
  assert.deepEqual(adapter.__talismanAuthRuntime, { moduleId: 'talisman-cms/auth/hybrid', exportName: 'HybridAuthAdapter', type: 'factory', args: [], adminPath: true, configuredAdminPath: '/cms' });
  assert.equal(HybridAuthAdapter().__talismanAuthRuntime.configuredAdminPath, undefined);
  const response = await signInCloudflareAdmin(new Request('https://example.test/cms/sso'), '/cms');
  assert.equal(response.status, 403);
});

test('Cloudflare Access auth fails closed without verified identity and an allowlisted email', async () => {
  const adapter = AccessAuthAdapter('/cms/');
  const request = new Request('https://example.test/cms', {
    headers: { 'cf-access-jwt-assertion': 'not-a-valid-jwt' },
  });
  assert.deepEqual(adapter.__talismanAuthRuntime, { moduleId: 'talisman-cms/auth/access', exportName: 'AccessAuthAdapter', type: 'factory', args: [], adminPath: true, configuredAdminPath: '/cms' });
  assert.equal(await adapter.getUser(request), null);

  const previous = {
    team: process.env.TALISMAN_ACCESS_TEAM_DOMAIN,
    audience: process.env.TALISMAN_ACCESS_AUDIENCE,
    admins: process.env.TALISMAN_ACCESS_ADMIN_EMAILS,
  };
  try {
    process.env.TALISMAN_ACCESS_TEAM_DOMAIN = 'https://team.cloudflareaccess.com';
    process.env.TALISMAN_ACCESS_AUDIENCE = 'test-audience';
    process.env.TALISMAN_ACCESS_ADMIN_EMAILS = 'admin@example.test';
    assert.equal(await adapter.getUser(request), null);
    assert.equal(await adapter.getUser(new Request(request.url)), null);
  } finally {
    for (const [key, value] of Object.entries({
      TALISMAN_ACCESS_TEAM_DOMAIN: previous.team,
      TALISMAN_ACCESS_AUDIENCE: previous.audience,
      TALISMAN_ACCESS_ADMIN_EMAILS: previous.admins,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal((await adapter.signOut(request)).headers.get('location'), 'https://example.test/cdn-cgi/access/logout');
});

test('content sync requires an explicit build source and propagates failures', async () => {
  const stored = new Map();
  const context = {
    store: {
      clear: () => stored.clear(),
      set: (entry) => stored.set(entry.id, entry),
    },
    generateDigest: (data) => JSON.stringify(data),
  };

  await assert.rejects(talismanLoader({ collection: 'posts' }).load(context), /needs buildEntries/);
  await assert.rejects(talismanLoader({ collection: 'posts', buildEntries: async () => { throw new Error('source unavailable'); } }).load(context), /source unavailable/);

  await talismanLoader({
    collection: 'posts',
    buildEntries: async () => [{ id: 'one', data: { title: 'First' } }],
  }).load(context);
  assert.deepEqual(stored.get('one'), {
    id: 'one',
    data: { title: 'First' },
    digest: '{"title":"First"}',
  });
});
