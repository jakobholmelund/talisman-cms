import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import ts from 'typescript';

// The admin SDK (ui/sdk.ts) ships as TypeScript source and reads the site's config module and the
// admin's router, so it is compiled here with those imports linked to stubs, the way the plugins'
// admin tests link the modules they load. Type-only imports are erased by the compiler.
const ui = new URL('../ui/', import.meta.url);
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

function compileModule(path, links = {}) {
  let { outputText } = ts.transpileModule(readFileSync(new URL(path, ui), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  for (const [specifier, linked] of Object.entries(links)) {
    outputText = outputText.replaceAll(`from '${specifier}'`, `from '${linked}'`).replaceAll(`from "${specifier}"`, `from "${linked}"`);
  }
  assert.doesNotMatch(outputText, /^(?:import|export)\s.*\bfrom\s+['"](?!data:)/m, `ui/${path} imports a module this test does not link`);
  return dataUrl(outputText);
}

const entryLabelsUrl = compileModule('lib/entry-labels.ts');
// The router stub hands back whatever context a test set.
const routerUrl = dataUrl('export const useRouter = () => ({ options: { context: globalThis.__talismanAdminSdkContext } });');

const sdks = new Map();
/** The SDK as built for a site with this admin path; one module instance per path. */
async function loadSdk(adminPath) {
  if (!sdks.has(adminPath)) {
    sdks.set(adminPath, import(compileModule('sdk.ts', {
      'virtual:talisman-cms/config': dataUrl(`export const adminPath = ${JSON.stringify(adminPath)};`),
      './lib/entry-labels': entryLabelsUrl,
      '@tanstack/react-router': routerUrl,
    })));
  }
  return sdks.get(adminPath);
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.__talismanAdminSdkContext;
});

/** Replaces fetch with a stub that answers `response` and records the request. */
function stubFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response() : response;
  };
  return calls;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('adminUrl and adminApiUrl build paths under the default admin path', async () => {
  const sdk = await loadSdk('/admin');
  assert.equal(sdk.adminPath, '/admin');
  assert.equal(sdk.adminUrl(), '/admin');
  assert.equal(sdk.adminUrl(''), '/admin');
  assert.equal(sdk.adminUrl('extensions/commerce-orders'), '/admin/extensions/commerce-orders');
  // A leading slash on the argument is not doubled.
  assert.equal(sdk.adminUrl('/extensions/commerce-orders'), '/admin/extensions/commerce-orders');
  assert.equal(sdk.adminUrl('daisyui-preview'), '/admin/daisyui-preview');
  assert.equal(sdk.adminApiUrl('ecommerce/orders'), '/admin/api/ecommerce/orders');
  assert.equal(sdk.adminApiUrl('/ecommerce/orders'), '/admin/api/ecommerce/orders');
  assert.equal(sdk.adminApiUrl('analytics/overview?days=7'), '/admin/api/analytics/overview?days=7');
});

test('adminUrl and adminApiUrl serve an admin at the site root without a double slash', async () => {
  const sdk = await loadSdk('/');
  assert.equal(sdk.adminPath, '/');
  assert.equal(sdk.adminUrl(), '/');
  assert.equal(sdk.adminUrl('extensions/commerce-orders'), '/extensions/commerce-orders');
  assert.equal(sdk.adminUrl('/extensions/commerce-orders'), '/extensions/commerce-orders');
  assert.equal(sdk.adminApiUrl('ecommerce/orders'), '/api/ecommerce/orders');
  assert.equal(sdk.adminApiUrl('/daisyui/theme'), '/api/daisyui/theme');
});

test('adminUrl and adminApiUrl follow a custom admin path', async () => {
  const sdk = await loadSdk('/cms');
  assert.equal(sdk.adminPath, '/cms');
  assert.equal(sdk.adminUrl(), '/cms');
  assert.equal(sdk.adminUrl('extensions/commerce-orders'), '/cms/extensions/commerce-orders');
  assert.equal(sdk.adminApiUrl('ecommerce/orders'), '/cms/api/ecommerce/orders');
  assert.equal(sdk.adminApiUrl('/ecommerce/orders'), '/cms/api/ecommerce/orders');
});

test('adminRequest reads without a body and posts JSON with one, with the CMS session', async () => {
  const sdk = await loadSdk('/admin');
  const calls = stubFetch(() => json({ orders: [] }));
  assert.deepEqual(await sdk.adminRequest('ecommerce/gift-cards-admin'), { orders: [] });
  assert.equal(calls[0].url, '/admin/api/ecommerce/gift-cards-admin');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers, undefined);

  const controller = new AbortController();
  await sdk.adminRequest('ecommerce/fulfillment', { body: { action: 'list' }, signal: controller.signal, headers: { 'X-Test': '1' } });
  assert.equal(calls[1].url, '/admin/api/ecommerce/fulfillment');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.body, '{"action":"list"}');
  assert.deepEqual(calls[1].init.headers, { 'Content-Type': 'application/json', 'X-Test': '1' });
  assert.equal(calls[1].init.signal, controller.signal);

  // A method given wins over the default, with or without a body.
  await sdk.adminRequest('daisyui/theme', { method: 'PUT', body: {} });
  assert.equal(calls[2].init.method, 'PUT');
  await sdk.adminRequest('ecommerce/reconcile', { method: 'POST' });
  assert.equal(calls[3].init.method, 'POST');
  assert.equal(calls[3].init.body, undefined);
});

test('adminRequest throws the answer\'s error text, or "Request failed" without a body', async () => {
  const sdk = await loadSdk('/cms');
  stubFetch(() => json({ error: 'Order not found' }, 404));
  await assert.rejects(sdk.adminRequest('ecommerce/orders-admin', { body: { action: 'restock' } }), { message: 'Order not found' });
  stubFetch(() => json({ ok: false }, 500));
  await assert.rejects(sdk.adminRequest('ecommerce/orders-admin'), { message: 'Request failed' });
  stubFetch(() => new Response(null, { status: 502 }));
  await assert.rejects(sdk.adminRequest('ecommerce/orders-admin'), { message: 'Request failed' });
  stubFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
  await assert.rejects(sdk.adminRequest('ecommerce/orders-admin'), { message: 'Request failed' });
  // An ok answer without a JSON body is null rather than a parse error.
  stubFetch(() => new Response(null, { status: 204 }));
  assert.equal(await sdk.adminRequest('ecommerce/orders-admin'), null);
});

test('useAdminUser reads the signed-in user from the router context', async () => {
  const sdk = await loadSdk('/admin');
  globalThis.__talismanAdminSdkContext = { user: { id: 'u1', role: 'admin', email: 'admin@example.com' } };
  assert.deepEqual(sdk.useAdminUser(), { id: 'u1', role: 'admin', email: 'admin@example.com' });
  globalThis.__talismanAdminSdkContext = { user: null };
  assert.equal(sdk.useAdminUser(), null);
  globalThis.__talismanAdminSdkContext = undefined;
  assert.equal(sdk.useAdminUser(), null);
});

test('readAdminSetting comes from the admin\'s own helper', async () => {
  const sdk = await loadSdk('/admin');
  const { readAdminSetting } = await import(entryLabelsUrl);
  assert.equal(sdk.readAdminSetting, readAdminSetting);
});
