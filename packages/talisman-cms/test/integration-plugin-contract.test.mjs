import assert from 'node:assert/strict';
import test from 'node:test';

const { default: talismanCms } = await import('../dist/integration.js');

/** Run astro:config:setup with stand-ins for Astro's helpers and return what the integration registered. */
function setup(options) {
  const registered = { routes: [], vite: null };
  talismanCms(options).hooks['astro:config:setup']({
    command: 'build',
    config: { server: {} },
    injectRoute(route) { registered.routes.push(route); },
    addMiddleware() {},
    updateConfig(value) { registered.vite = value.vite; },
    addDevToolbarApp() {},
  });
  return registered;
}

/** Load a virtual module as Vite would for the server, and import it. */
async function loadServerModule(registered, name) {
  const plugin = registered.vite.plugins.find((candidate) => candidate?.name === `vite-plugin-talisman-cms-${name}`);
  const source = plugin.load.call({ environment: { config: { consumer: 'server' } } }, plugin.resolveId(`virtual:talisman-cms/${name}`), { ssr: true });
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

const quiet = (t) => t.mock.method(console, 'log', () => {});

test('onInit receives a normalized config: arrays present, adminPath normalized, plugins in order', async (t) => {
  quiet(t);
  const seen = [];
  const first = {
    name: 'first-plugin',
    onInit(config) {
      seen.push({ plugin: 'first', adminPath: config.adminPath, collections: config.collections.map((c) => c.slug), globals: config.globals, plugins: config.plugins.map((p) => p.name) });
      // Mutating the config and returning nothing keeps the change.
      config.collections.push({ name: 'Reviews', slug: 'reviews', fields: [{ name: 'title', label: 'Title', type: 'text' }] });
    },
  };
  const second = {
    name: 'second-plugin',
    onInit: (config) => {
      seen.push({ plugin: 'second', collections: config.collections.map((c) => c.slug) });
      // Returning a new config replaces it for the plugins after this one and for the integration.
      return { ...config, globals: [...config.globals, { name: 'Reviews Settings', slug: 'reviews-settings', fields: [] }] };
    },
  };
  const registered = setup({ adminPath: 'cms/', plugins: [first, second] });

  assert.deepEqual(seen[0], { plugin: 'first', adminPath: '/cms', collections: [], globals: [], plugins: ['first-plugin', 'second-plugin'] });
  assert.deepEqual(seen[1], { plugin: 'second', collections: ['reviews'] });
  const config = await loadServerModule(registered, 'config');
  assert.equal(config.adminPath, '/cms');
  assert.ok(config.collections.some((collection) => collection.slug === 'reviews'));
  assert.ok(config.globals.some((global) => global.slug === 'reviews-settings'));
});

test('a plugin without onInit is accepted', (t) => {
  quiet(t);
  assert.doesNotThrow(() => setup({ plugins: [{ name: 'quiet-plugin', adminSettings: ['REVIEWS_LOCALE'] }] }));
});

test('the options object passed in is not changed by onInit', (t) => {
  quiet(t);
  const options = { collections: [{ name: 'Posts', slug: 'posts', fields: [] }], plugins: [{
    name: 'adder', onInit(config) { config.collections.push({ name: 'Reviews', slug: 'reviews', fields: [] }); },
  }] };
  setup(options);
  assert.deepEqual(options.collections.map((c) => c.slug), ['posts']);
});

const link = (href) => ({ section: 'reviews', label: 'Moderation', description: 'Approve reviews.', href });
const reviewsSection = { id: 'reviews', label: 'Reviews', componentPath: 'reviews-plugin/admin/Workspace' };

test('admin links without a leading slash are resolved under the admin path', async (t) => {
  quiet(t);
  const links = async (adminPath, href) => {
    const registered = setup({ adminPath, plugins: [{ name: 'reviews-plugin', adminSections: [reviewsSection], adminLinks: [link(href)] }] });
    const config = await loadServerModule(registered, 'config');
    return config.adminLinks.map((item) => item.href);
  };
  assert.deepEqual(await links(undefined, 'extensions/reviews'), ['/admin/extensions/reviews']);
  assert.deepEqual(await links('cms', 'extensions/reviews'), ['/cms/extensions/reviews']);
  assert.deepEqual(await links('/', 'extensions/reviews'), ['/extensions/reviews']);
  // A leading slash is used as given, whatever the admin path.
  assert.deepEqual(await links('cms', '/reviews/queue'), ['/reviews/queue']);
});

test('plugin pages without a leading slash are placed under the admin path and need a session', async (t) => {
  quiet(t);
  const registered = setup({ adminPath: 'cms', plugins: [{
    name: 'reviews-plugin',
    routes: [
      { path: 'reviews-preview', entrypoint: '/plugin/preview.astro', prerender: false },
      { path: 'reviews-badge', entrypoint: '/plugin/badge.astro', prerender: false, public: true },
      { path: '/reviews/feed', entrypoint: '/plugin/feed.astro', prerender: false },
    ],
  }] });
  const patterns = registered.routes.map((route) => route.pattern);
  assert.ok(patterns.includes('/cms/reviews-preview'), patterns.join(', '));
  assert.ok(patterns.includes('/cms/reviews-badge'));
  assert.ok(patterns.includes('/reviews/feed'));
  const { protectedRoutes } = await loadServerModule(registered, 'protected-routes');
  assert.equal(protectedRoutes['/cms/reviews-preview'], 'page');
  assert.equal(protectedRoutes['/cms/reviews-badge'], undefined);
  assert.equal(protectedRoutes['/reviews/feed'], undefined);
});

test('a link or page that is not a path on the site fails the build with the plugin name', (t) => {
  quiet(t);
  const refused = (field) => {
    const plugin = { name: 'reviews-plugin', adminSections: [reviewsSection], ...field };
    assert.throws(() => setup({ plugins: [plugin] }), /\[talisman-cms\] reviews-plugin: /);
  };
  for (const href of ['https://evil.example/reviews', '//evil.example/reviews', 'javascript:alert(1)', 'mailto:someone@example.com', '/admin\\evil', '', '   ']) {
    refused({ adminLinks: [link(href)] });
    refused({ routes: [{ path: href, entrypoint: '/plugin/page.astro', prerender: false }] });
  }
});
