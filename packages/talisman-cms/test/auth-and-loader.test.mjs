import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeCmsRequestWithAdapter } from '../dist/auth/authorize.js';
import { DevAuthAdapter } from '../dist/auth/dev.js';
import { LocalAuthAdapter, getAccessEmail } from '../dist/auth/local.js';
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

test('development auth grants access only on local hosts', async () => {
  const adapter = DevAuthAdapter();
  assert.equal((await adapter.getUser(new Request('http://localhost:4321/admin')))?.role, 'admin');
  assert.equal(await adapter.getUser(new Request('https://example.test/admin')), null);
});

test('local auth preserves its runtime path and requires both Access settings', async () => {
  const request = new Request('https://example.test/cms');
  assert.deepEqual(LocalAuthAdapter('/cms/').__talismanAuthRuntime.args, ['/cms']);
  assert.equal(await getAccessEmail(request, {}), undefined);
  assert.equal(await getAccessEmail(request, { GALAXY_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com' }), null);
  assert.equal(await getAccessEmail(request, {
    GALAXY_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
    GALAXY_ACCESS_AUDIENCE: 'audience',
  }), null);
});

test('Cloudflare Access auth fails closed without verified identity and an allowlisted email', async () => {
  const adapter = AccessAuthAdapter('/cms/');
  const request = new Request('https://example.test/cms', {
    headers: { 'cf-access-jwt-assertion': 'not-a-valid-jwt' },
  });
  assert.deepEqual(adapter.__talismanAuthRuntime.args, ['/cms']);
  assert.equal(await adapter.getUser(request), null);

  const previous = {
    team: process.env.GALAXY_ACCESS_TEAM_DOMAIN,
    audience: process.env.GALAXY_ACCESS_AUDIENCE,
    admins: process.env.GALAXY_ACCESS_ADMIN_EMAILS,
  };
  try {
    process.env.GALAXY_ACCESS_TEAM_DOMAIN = 'https://team.cloudflareaccess.com';
    process.env.GALAXY_ACCESS_AUDIENCE = 'test-audience';
    process.env.GALAXY_ACCESS_ADMIN_EMAILS = 'admin@example.test';
    assert.equal(await adapter.getUser(request), null);
    assert.equal(await adapter.getUser(new Request(request.url)), null);
  } finally {
    for (const [key, value] of Object.entries({
      GALAXY_ACCESS_TEAM_DOMAIN: previous.team,
      GALAXY_ACCESS_AUDIENCE: previous.audience,
      GALAXY_ACCESS_ADMIN_EMAILS: previous.admins,
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
