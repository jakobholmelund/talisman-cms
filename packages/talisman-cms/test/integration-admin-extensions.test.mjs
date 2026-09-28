import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { default: talismanCms } = await import('../dist/integration.js');
const globalsCss = fileURLToPath(new URL('../ui/globals.css', import.meta.url));

/** Run astro:config:setup with stand-ins for Astro's helpers (no config.root, so no migrations folder is written). */
function setup(options) {
  const registered = { vite: null };
  talismanCms(options).hooks['astro:config:setup']({
    command: 'build',
    config: { server: {} },
    injectRoute() {},
    addMiddleware() {},
    updateConfig(value) { registered.vite = value.vite; },
    addDevToolbarApp() {},
  });
  return registered;
}

const vitePlugin = (registered, name) => registered.vite.plugins.find((candidate) => candidate?.name === `vite-plugin-talisman-cms-${name}`);

/** Load a virtual module as Vite would for a 'client' or 'server' consumer. */
function loadVirtual(registered, name, consumer) {
  const plugin = vitePlugin(registered, name);
  return plugin.load.call({ environment: { config: { consumer } } }, plugin.resolveId(`virtual:talisman-cms/${name}`), { ssr: consumer === 'server' });
}

const reviewsPlugin = (extra = {}) => ({
  name: 'reviews-plugin',
  onInit: (config) => config,
  adminSections: [{ id: 'reviews', label: 'Reviews', icon: 'chart', adminOnly: true, componentPath: 'reviews-plugin/admin/Workspace' }],
  adminEditorPanels: [{ id: 'review-preview', placement: 'after-form', slugs: ['reviews'], componentPath: 'reviews-plugin/admin/Preview' }],
  adminEntryDescribers: [{ modulePath: 'reviews-plugin/admin/describe' }],
  adminSettings: ['REVIEWS_LOCALE'],
  ...extra,
});

test('the admin stylesheet gets an @source line per plugin folder, and only the stylesheet does', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = mkdtempSync(`${tmpdir()}/talisman-admin-styles-`);
  try {
    const registered = setup({ plugins: [reviewsPlugin({ adminStyleSources: [dir] })] });
    const styles = vitePlugin(registered, 'admin-styles');
    const loaded = styles.load(globalsCss);
    assert.match(loaded, /@import "tailwindcss";/);
    assert.ok(loaded.trimEnd().endsWith(`@source ${JSON.stringify(dir)};`));
    assert.equal(styles.load(`${globalsCss}?direct`), loaded);
    assert.equal(styles.load(`${dir}/other.css`), undefined);

    // Without declared sources the stylesheet is left to Vite.
    assert.equal(vitePlugin(setup({ plugins: [reviewsPlugin()] }), 'admin-styles').load(globalsCss), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the admin extension points are checked at config time', async (t) => {
  t.mock.method(console, 'log', () => {});
  const withSection = (section) => ({ plugins: [reviewsPlugin({ adminSections: [{ ...reviewsPlugin().adminSections[0], ...section }] })] });
  assert.throws(() => setup(withSection({ id: 'collections' })), /reviews-plugin: the admin section id "collections" is a built-in admin route/);
  assert.throws(() => setup(withSection({ id: 'Reviews' })), /adminSections ids are lowercase slugs/);
  assert.throws(() => setup(withSection({ label: ' ' })), /needs a label/);
  assert.throws(() => setup({ plugins: [reviewsPlugin(), { ...reviewsPlugin(), name: 'other-plugin' }] }), /other-plugin: the admin section "reviews" is already registered by reviews-plugin/);
  for (const name of ['REVIEWS_SECRET', 'API_KEY', 'GIFT_CARD_KEY', 'ACCESS_CREDENTIALS', 'ADMIN_PASSWD', 'PRIVATE_KEY_ID', 'ACCESS_TOKEN']) {
    assert.throws(() => setup({ plugins: [reviewsPlugin({ adminSettings: [name] })] }), new RegExp(`the setting ${name} looks like a secret`), name);
  }
  assert.throws(() => setup({ plugins: [reviewsPlugin({ adminSettings: ['reviews_locale'] })] }), /adminSettings names are TALISMAN_\* setting names/);
  assert.throws(() => setup({ plugins: [reviewsPlugin({ adminEditorPanels: [{ id: 'x', componentPath: 'p', placement: 'sidebar' }] })] }), /placement "sidebar"; use before-fields or after-form/);
  assert.throws(() => setup({ plugins: [reviewsPlugin({ adminStyleSources: ['relative/dir'] })] }), /adminStyleSources entries are absolute directories/);
  assert.throws(() => setup({ plugins: [reviewsPlugin({ adminStyleSources: ['/no/such/talisman/dir'] })] }), /does not exist/);
  setup({ plugins: [reviewsPlugin()] });
});

test('the admin registry and the config modules carry the sections, panels, describers and settings', async (t) => {
  t.mock.method(console, 'log', () => {});
  const registered = setup({ plugins: [reviewsPlugin()] });
  const extensions = vitePlugin(registered, 'admin-extensions');
  const source = extensions.load(extensions.resolveId('virtual:talisman-cms/admin-extensions'));
  assert.match(source, /id: "reviews",\s+label: "Reviews",\s+description: null,\s+icon: "chart",\s+adminOnly: true,\s+emptyState: null,\s+plugin: "reviews-plugin",\s+workspace: lazy\(\(\) => import\("reviews-plugin\/admin\/Workspace"\)\)/);
  assert.match(source, /id: "review-preview",\s+placement: "after-form",\s+sections: null,\s+slugs: \["reviews"\]/);
  assert.match(source, /import \* as describer_0 from "reviews-plugin\/admin\/describe";/);
  assert.match(source, /adminEntryDescribers = \[\s*\{ plugin: "reviews-plugin", module: describer_0 \}/);

  // The browser gets the section ids (for the dev toolbar and the SPA); only server code gets the settings to render.
  const client = loadVirtual(registered, 'config', 'client');
  assert.match(client, /export const adminSections = \["reviews"\];/);
  assert.doesNotMatch(client, /adminSettings/);
  const server = loadVirtual(registered, 'config', 'server');
  assert.match(server, /export const adminSections = \["reviews"\];/);
  assert.match(server, /export const adminSettings = \["REVIEWS_LOCALE"\];/);
});
