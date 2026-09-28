import assert from 'node:assert/strict';
import test from 'node:test';

const { default: talismanCms } = await import('../dist/integration.js');
const { DevAuthAdapter } = await import('../dist/auth/dev.js');
const { LocalAuthAdapter } = await import('../dist/auth/local.js');
const { HybridAuthAdapter } = await import('../dist/auth/hybrid.js');

/** Run astro:config:setup with stand-ins for Astro's helpers and return what the integration registered. */
function setup(options, { command = 'dev', host = false } = {}) {
  const registered = { routes: [], middleware: [], vite: null };
  talismanCms(options).hooks['astro:config:setup']({
    command,
    config: { server: { host } },
    injectRoute(route) { registered.routes.push(route); },
    addMiddleware(middleware) { registered.middleware.push(middleware); },
    updateConfig(value) { registered.vite = value.vite; },
    addDevToolbarApp() {},
  });
  return registered;
}

/** Load a virtual module as Vite would for an environment ('client' or 'server'), or with only the legacy ssr flag. */
function loadVirtual(registered, name, { consumer, ssr } = {}) {
  const plugin = registered.vite.plugins.find((candidate) => candidate?.name === `vite-plugin-talisman-cms-${name}`);
  const context = consumer ? { environment: { config: { consumer } } } : undefined;
  return plugin.load.call(context, plugin.resolveId(`virtual:talisman-cms/${name}`), ssr === undefined ? undefined : { ssr });
}

async function importModule(source) {
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

const stripeLikePlugin = {
  name: 'hooks-plugin',
  onInit: (config) => ({
    ...config,
    collections: [...(config.collections || []), {
      name: 'Products',
      slug: 'products',
      access: { read: 'admin' },
      fields: [{ name: 'title', label: 'Title', type: 'text', apiKey: 'leaked', defaultValue: 'sk_live_inline' }],
      runtimeHooks: [{ moduleId: 'hooks-plugin/runtime', exportName: 'createHooks', factory: true, args: { webhookSecret: 'whsec_123', collection: 'products' } }],
      nativeSchemaMapping: { schemaPath: '@talisman-cms/plugin-ecommerce/schema', exportName: 'products', idColumn: 'id' },
    }],
  }),
  adminLinks: [{ section: 'commerce', label: 'Tools', description: 'Store tools', href: '/admin/extensions/tools', token: 'x' }],
};

test('the admin bundle gets a client-safe config while server code keeps the full config', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const registered = setup({
    publishing: { workflowBinding: 'PUBLISH_FLOW' },
    globals: [{ name: 'Site', slug: 'site', fields: [{ name: 'title', label: 'Title', type: 'text' }], serverOnly: true }],
    plugins: [stripeLikePlugin],
  });

  const clientSource = loadVirtual(registered, 'config', { consumer: 'client', ssr: false });
  assert.doesNotMatch(clientSource, /runtimeHooks|createHooks|whsec_|webhookSecret|PUBLISH_FLOW|publishing|sk_live|apiKey|leaked|serverOnly|"token"/);
  const client = await importModule(clientSource);
  const products = client.collections.find((collection) => collection.slug === 'products');
  assert.deepEqual(products, {
    name: 'Products',
    slug: 'products',
    access: { read: 'admin' },
    fields: [{ name: 'title', label: 'Title', type: 'text' }],
    nativeSchemaMapping: { schemaPath: '@talisman-cms/plugin-ecommerce/schema', exportName: 'products', idColumn: 'id' },
  });
  assert.equal(client.adminPath, '/admin');
  assert.deepEqual(client.globals, [{ name: 'Site', slug: 'site', fields: [{ name: 'title', label: 'Title', type: 'text' }] }]);
  assert.deepEqual(client.adminLinks, [{ section: 'commerce', label: 'Tools', description: 'Store tools', href: '/admin/extensions/tools' }]);
  assert.ok(client.collections.some((collection) => collection.slug === 'media'), 'system collections stay visible');
  assert.equal('publishing' in client, false);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /config\.collections\[\d\]\.fields\[0\]\.apiKey.*defaultValue/);

  // Vite passes the environment; without one the ssr flag decides, and a load with neither gets the browser copy.
  assert.equal(loadVirtual(registered, 'config'), clientSource);
  for (const target of [{ consumer: 'server', ssr: true }, { ssr: true }]) {
    const server = await importModule(loadVirtual(registered, 'config', target));
    const serverProducts = server.collections.find((collection) => collection.slug === 'products');
    assert.equal(serverProducts.runtimeHooks[0].args.collection, 'products');
    assert.deepEqual(server.publishing, { workflowBinding: 'PUBLISH_FLOW' });
  }
});

test('plugin endpoints and admin pages require a CMS session unless marked public', async (t) => {
  t.mock.method(console, 'log', () => {});
  const plugin = {
    name: 'tools',
    onInit: (config) => config,
    endpoints: [
      { path: '/tools/export', entrypoint: 'tools/export.ts' },
      { path: 'tools/items/[id]/', entrypoint: 'tools/item.ts' },
      { path: '/tools/webhook', entrypoint: 'tools/webhook.ts', public: true },
    ],
    routes: [
      { path: '/cms/tools-preview', entrypoint: 'tools/preview.astro' },
      { path: '/cms/tools-public', entrypoint: 'tools/public.astro', public: true },
      { path: '/tools-page', entrypoint: 'tools/page.astro', prerender: true },
    ],
  };
  const registered = setup({ adminPath: '/cms/', plugins: [plugin] });
  const patterns = registered.routes.map((route) => route.pattern);
  assert.ok(patterns.includes('/cms/api/tools/export'));
  assert.ok(patterns.includes('/api/tools/webhook'), 'public endpoints stay outside the admin path');

  assert.equal(registered.middleware.length, 1);
  assert.equal(registered.middleware[0].order, 'post');
  assert.match(registered.middleware[0].entrypoint, /src\/routes\/plugin-route-guard\.ts$/);
  const guard = await importModule(loadVirtual(registered, 'protected-routes', { consumer: 'server', ssr: true }));
  assert.equal(guard.adminPath, '/cms');
  assert.deepEqual(guard.protectedRoutes, {
    '/cms/api/tools/export': 'endpoint',
    '/cms/api/tools/items/[id]': 'endpoint',
    '/cms/tools-preview': 'page',
  });

  // Without protected plugin routes no middleware runs on the site's requests.
  const publicOnly = setup({ plugins: [{ name: 'shop', onInit: (config) => config, endpoints: [{ path: '/cart', entrypoint: 'cart.ts', public: true }] }] });
  assert.equal(publicOnly.middleware.length, 0);

  assert.throws(() => talismanCms({ plugins: [{ name: 'static', onInit: (config) => config,
    routes: [{ path: '/admin/report', entrypoint: 'report.astro', prerender: true }] }] }),
  /static: \/admin\/report .*cannot be prerendered/);
});

test('DevAuthAdapter is refused for builds and for a dev server exposed on the network', (t) => {
  t.mock.method(console, 'log', () => {});
  const options = { auth: DevAuthAdapter() };
  for (const command of ['build', 'preview']) {
    assert.throws(() => setup(options, { command }), /DevAuthAdapter .*only runs under `astro dev`/, command);
  }
  for (const host of [true, '0.0.0.0', '192.168.1.20']) {
    assert.throws(() => setup(options, { command: 'dev', host }), /listen on loopback only/, String(host));
  }
  for (const host of [false, 'localhost', '127.0.0.1', '::1']) {
    assert.doesNotThrow(() => setup(options, { command: 'dev', host }), String(host));
  }
  assert.doesNotThrow(() => setup(options, { command: 'sync' }));
  assert.doesNotThrow(() => setup({ auth: LocalAuthAdapter() }, { command: 'build', host: true }));
});

test('the auth virtual module passes the integration admin path to the adapter, and a different argument fails the build', (t) => {
  t.mock.method(console, 'log', () => {});
  const authModule = (options, command) => loadVirtual(setup(options, command ? { command } : {}), 'auth', { ssr: true });

  const hybrid = authModule({ adminPath: 'cms', auth: HybridAuthAdapter() });
  assert.match(hybrid, /import \{ HybridAuthAdapter as __talismanCmsRuntimeAuthAdapter \} from "talisman-cms\/auth\/hybrid"/);
  assert.match(hybrid, /__talismanCmsRuntimeAuthAdapter\(\.\.\.\["\/cms"\]\)/);
  assert.match(authModule({ auth: HybridAuthAdapter() }), /\(\.\.\.\["\/admin"\]\)/);
  assert.match(authModule({ adminPath: '/', auth: HybridAuthAdapter() }), /\(\.\.\.\["\/"\]\)/);
  // The adapter's own options follow the path.
  assert.match(authModule({ adminPath: 'cms', auth: LocalAuthAdapter(undefined, { requireAccess: false }) }), /\(\.\.\.\["\/cms",\{"requireAccess":false\}\]\)/);
  // A path the site still passes to the adapter is accepted when it matches and refused when it does not.
  assert.match(authModule({ adminPath: 'cms', auth: HybridAuthAdapter('cms/') }), /\(\.\.\.\["\/cms"\]\)/);
  assert.match(authModule({ adminPath: '/', auth: HybridAuthAdapter('/') }), /\(\.\.\.\["\/"\]\)/);
  assert.throws(() => setup({ adminPath: 'cms', auth: HybridAuthAdapter('/admin') }),
    /\[talisman-cms\] HybridAuthAdapter\("\/admin"\) does not match adminPath "\/cms"\. Drop the argument/);
  assert.throws(() => setup({ auth: LocalAuthAdapter('/cms') }), /LocalAuthAdapter\("\/cms"\) does not match adminPath "\/admin"/);
  // DevAuthAdapter declares no admin path and is called without one.
  assert.match(authModule({ auth: DevAuthAdapter() }, 'dev'), /__talismanCmsRuntimeAuthAdapter\(\.\.\.\[\]\)/);
});
