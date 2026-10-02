import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';

// Use the production auth guard; replace only its adapter and runtime bindings.
const stubs = {
  'virtual:talisman-cms/auth': `export const authConfigured = true; export const authAdapter = { getUser: async () => globalThis.cmsUser };`,
  'virtual:talisman-cms/config': 'export const collections = [];',
  'cloudflare:workers': 'export const env = new Proxy({}, { get: (_, key) => globalThis.workerEnv?.[key] });',
};
registerHooks({ resolve(specifier, context, next) {
  if (specifier in stubs) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  return next(specifier, context);
} });
const ask = (await import('../dist/routes/analytics-ask.js')).POST;
const overview = (await import('../dist/routes/analytics-overview.js')).GET;
const commerce = (await import('../dist/routes/analytics-commerce.js')).GET;
const origin = 'https://shop.test';
function fixture() {
  let reads = 0, calls = 0;
  globalThis.cmsUser = { id: 'admin', role: 'admin' };
  globalThis.workerEnv = {
    DB: { prepare() { reads++; return { bind() { return this; }, async all() { return { results: [] }; } }; } },
    AI: { async run() { calls++; return { response: { subject: 'sales', period: 'last_7_days', compare: false } }; } },
  };
  return { get reads() { return reads; }, get calls() { return calls; } };
}
function request(area, body = { question: 'Sales last 7 days' }, headers = {}) {
  return new Request(`${origin}/staff_portal/api/analytics/${area}`, area === 'ask'
    ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }
    : { headers });
}
const post = (body, headers) => ask({ request: request('ask', body, headers) });

test('every analytics route authenticates; commerce and Ask require admin while staff can read traffic', async () => {
  const counts = fixture();
  for (const role of [null, 'editor', 'admin']) {
    globalThis.cmsUser = role && { id: role, role };
    for (const [route, area] of [[overview, 'overview'], [commerce, 'commerce'], [ask, 'ask']]) {
      const response = await route({ request: request(area) });
      const expected = !role ? 401 : role !== 'admin' && area !== 'overview' ? 403 : area === 'overview' ? 503 : 200;
      assert.equal(response.status, expected, `${role}/${area}`);
      assert.match(response.headers.get('Cache-Control'), /no-store/);
    }
  }
  assert.equal(counts.calls, 1);
});

test('Ask enforces origin, real streamed body bytes, JSON media type/object and question bounds before AI/D1', async () => {
  const counts = fixture();
  const cases = [
    [{ question: 'Sales last 7 days' }, { Origin: 'https://other.test' }, 403],
    [{ question: 'Sales last 7 days' }, { 'Sec-Fetch-Site': 'cross-site' }, 403],
    [{ question: 'Sales last 7 days' }, { 'Content-Type': 'text/plain' }, 415],
    [{ question: 'Sales last 7 days' }, { 'Content-Type': 'application/json-malicious' }, 415],
    ['{', {}, 400], [null, {}, 400], [[], {}, 400], [{ question: 42 }, {}, 400], [{ question: 'abc' }, {}, 400],
    [{ question: 'x'.repeat(301) }, {}, 400],
    [' '.repeat(1025), {}, 413], [{ question: '界'.repeat(300), padding: '界'.repeat(80) }, {}, 413],
    [{ question: 'Sales last 7 days' }, { 'Content-Length': '1025' }, 413],
  ];
  for (const [body, headers, status] of cases) {
    const response = await post(body, headers);
    assert.equal(response.status, status);
  }
  assert.equal(counts.calls, 0); assert.equal(counts.reads, 0);
});

test('missing bindings produce useful setup errors and provider/D1 details stay private', async () => {
  fixture(); delete globalThis.workerEnv.AI;
  assert.match((await (await post()).json()).error, /Workers AI binding/);
  fixture(); delete globalThis.workerEnv.DB;
  assert.match((await (await post()).json()).error, /D1 binding DB/);
  assert.equal((await commerce({ request: request('commerce') })).status, 503);
  fixture(); globalThis.workerEnv.AI.run = async () => { throw new Error('secret upstream diagnostic'); };
  const aiFailure = await post(); assert.equal(aiFailure.status, 502);
  assert.equal(JSON.stringify(await aiFailure.json()).includes('secret'), false);
  globalThis.workerEnv.AI.run = async () => { throw new Error('Unsupported period secret upstream diagnostic'); };
  const prefixedFailure = await post(); assert.equal(prefixedFailure.status, 502);
  assert.equal(JSON.stringify(await prefixedFailure.json()).includes('secret'), false);
  globalThis.workerEnv.DB.prepare = () => { throw new Error('secret database diagnostic'); };
  const dbFailure = await commerce({ request: request('commerce') }); assert.equal(dbFailure.status, 502);
  assert.equal(JSON.stringify(await dbFailure.json()).includes('secret'), false);
});

test('Ask rejects unsupported periods, throttles per user, caches short reports and reauthorizes every hit', async () => {
  const counts = fixture();
  assert.equal((await post({ question: 'Sales last 14 days' })).status, 400);
  assert.equal(counts.calls, 0);
  assert.equal((await post()).status, 200);
  const reads = counts.reads;
  assert.equal((await post()).status, 200);
  assert.equal(counts.calls, 1); assert.equal(counts.reads, reads);
  globalThis.cmsUser = { id: 'other-admin', role: 'admin' };
  assert.equal((await post()).status, 200); assert.equal(counts.calls, 2);
  globalThis.cmsUser = { id: 'admin', role: 'editor' };
  assert.equal((await post()).status, 403);
  globalThis.cmsUser.role = 'admin';
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200);
  const limited = await post(); assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '60');
});

test('successful dashboard reports cache safely by bindings/admin path while failures retry', async () => {
  const counts = fixture();
  assert.equal((await commerce({ request: request('commerce') })).status, 200);
  const reads = counts.reads;
  assert.equal((await commerce({ request: request('commerce') })).status, 200); assert.equal(counts.reads, reads);
  await commerce({ request: new Request(`${origin}/other/api/analytics/commerce`) }); assert.ok(counts.reads > reads);
  let queries = 0;
  const originalFetch = globalThis.fetch;
  Object.assign(globalThis.workerEnv, { CLOUDFLARE_ANALYTICS_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_ANALYTICS_SITE_TAG: 'b'.repeat(32), CLOUDFLARE_ANALYTICS_API_TOKEN: 'unused' });
  try {
    globalThis.fetch = async () => { queries++; return Response.json({ errors: [{ message: 'private diagnostic' }] }); };
    for (let i = 0; i < 2; i++) {
      const response = await overview({ request: request('overview') }); assert.equal(response.status, 502);
      assert.equal(JSON.stringify(await response.json()).includes('private diagnostic'), false);
    }
    assert.equal(queries, 2);
    globalThis.fetch = async () => { queries++; return Response.json({ data: { viewer: { accounts: [{ total: [{ count: 5 }] }] } } }); };
    assert.equal((await overview({ request: request('overview') })).status, 200);
    const before = queries;
    assert.equal((await overview({ request: request('overview') })).status, 200); assert.equal(queries, before);
    globalThis.workerEnv.CLOUDFLARE_ANALYTICS_API_TOKEN = 'rotated-fixture';
    await overview({ request: request('overview') }); assert.ok(queries > before);
  } finally { globalThis.fetch = originalFetch; }
});

test('traffic failures preserve commerce at the route and degraded reports retry instead of caching', async () => {
  const counts = fixture();
  globalThis.workerEnv.AI.run = async () => ({ response: { subject: 'traffic_and_sales', period: 'last_7_days', compare: true } });
  for (let i = 0; i < 2; i++) {
    const response = await post({ question: 'Traffic and sales last 7 days compared' });
    assert.equal(response.status, 200);
    const report = await response.json(); assert.ok(report.commerce); assert.ok(report.previousCommerce);
    assert.ok(report.notes.some(note => note.includes('Traffic is unavailable')));
  }
  assert.ok(counts.reads >= 16);
});

test('report caches expire and rejected promises are never retained', async () => {
  const { reportCache } = await import('../src/routes/support.ts');
  const cache = reportCache(); let reads = 0;
  const oldNow = Date.now; let now = oldNow(); Date.now = () => now;
  try {
    const read = async () => ++reads;
    assert.equal(await cache('tenant:user:question', read), 1);
    assert.equal(await cache('tenant:user:question', read), 1);
    now += 120_001;
    assert.equal(await cache('tenant:user:question', read), 2);
    for (let i = 0; i < 2; i++) await assert.rejects(() => cache('failure', async () => { reads++; throw new Error('failed'); }));
    assert.equal(reads, 4);
  } finally { Date.now = oldNow; }
});
