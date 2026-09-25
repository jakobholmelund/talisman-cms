import test from 'node:test';
import assert from 'node:assert/strict';
import { ecommercePlugin } from '../dist/index.js';

const adminOptions = async (plugin) => {
  const [vitePlugin] = plugin.vite.plugins;
  const id = vitePlugin.resolveId('virtual:talisman-cms/ecommerce-admin');
  return vitePlugin.load(id);
};

test('commerce tools render inside the CMS by default and reject external link overrides', () => {
  const defaults = ecommercePlugin();
  assert.deepEqual(defaults.adminLinks?.map(link => link.href), [
    '/admin/extensions/commerce-orders',
    '/admin/extensions/commerce-promotions',
    '/admin/extensions/commerce-gift-cards'
  ]);
  assert.deepEqual(defaults.adminUi?.map(page => [page.path, page.section]), [
    ['commerce-orders', 'commerce'], ['commerce-promotions', 'commerce'],
    ['commerce-gift-cards', 'commerce']
  ]);

  const plugin = ecommercePlugin({
    adminTestCheckout: true,
    adminPages: {
      orders: '/admin/orders',
      promotions: '/admin/promotions',
      giftCards: 'https://external.example/cards',
      testCheckout: '//external.example/checkout'
    }
  });

  assert.deepEqual(plugin.adminLinks?.map(link => [link.section, link.label, link.href]), [
    ['commerce', 'Orders & fulfillment', '/admin/orders'],
    ['commerce', 'Promotions & referrals', '/admin/promotions']
  ]);
});

test('the admin test checkout is opt-in: no screen, route or simulated provider by default', async () => {
  const endpointPaths = (plugin) => plugin.endpoints.map(endpoint => endpoint.path);
  for (const plugin of [ecommercePlugin(), ecommercePlugin({ adminTestCheckout: false })]) {
    assert.ok(!endpointPaths(plugin).includes('/ecommerce/test-checkout'));
    assert.ok(!plugin.adminUi.some(page => page.path === 'commerce-test-checkout'));
    assert.ok(!plugin.adminLinks.some(link => link.href.endsWith('commerce-test-checkout')));
    assert.equal(await adminOptions(plugin), 'export const adminTestCheckout = false;');
  }
  // Cart, checkout, order and webhook routes stay registered either way.
  assert.ok(['/ecommerce/cart', '/ecommerce/checkout', '/ecommerce/order', '/ecommerce/webhooks/stripe']
    .every(path => endpointPaths(ecommercePlugin()).includes(path)));

  const enabled = ecommercePlugin({ adminTestCheckout: true });
  const testCheckout = enabled.endpoints.find(endpoint => endpoint.path === '/ecommerce/test-checkout');
  assert.ok(testCheckout, 'the admin route is injected when enabled');
  assert.notEqual(testCheckout.public, true, 'the admin route stays under the admin path');
  assert.match(testCheckout.entrypoint, /ecommerce-admin-test-checkout\.(js|ts)$/);
  assert.deepEqual(enabled.adminUi.at(-1), { path: 'commerce-test-checkout', label: 'Test checkout',
    section: 'commerce', componentPath: '@talisman-cms/plugin-ecommerce/admin/TestCheckout' });
  assert.equal(enabled.adminLinks.at(-1).href, '/admin/extensions/commerce-test-checkout');
  assert.equal(await adminOptions(enabled), 'export const adminTestCheckout = true;');
});

test('the unfinished Durable Object inventory stub is not part of the API', async () => {
  const plugin = await import('../dist/index.js');
  const { bindCommerceApi } = await import('../dist/api.js');
  assert.equal('InventoryDO' in plugin, false);
  assert.equal('inventory' in bindCommerceApi({ env: { DB: {} } }), false);
});

test('native commerce tables are restricted to administrators and operational rows are read only', () => {
  const collections = ecommercePlugin().onInit({ collections: [] }).collections;
  for (const collection of collections.filter(item => item.nativeSchemaMapping?.schemaPath === '@talisman-cms/plugin-ecommerce/schema')) {
    assert.deepEqual(collection.access, { read: 'admin', create: 'admin', update: 'admin', delete: 'admin' });
  }
  assert.equal(collections.find(item => item.slug === '_ecommerce_carts').readOnly, true);
  assert.equal(collections.find(item => item.slug === '_ecommerce_customers').readOnly, true);
});
