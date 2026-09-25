import test from 'node:test';
import assert from 'node:assert/strict';
import { ecommercePlugin } from '../dist/index.js';

test('commerce tools render inside the CMS by default and reject external link overrides', () => {
  const defaults = ecommercePlugin();
  assert.deepEqual(defaults.adminLinks?.map(link => link.href), [
    '/admin/extensions/commerce-orders',
    '/admin/extensions/commerce-promotions',
    '/admin/extensions/commerce-gift-cards',
    '/admin/extensions/commerce-test-checkout'
  ]);
  assert.deepEqual(defaults.adminUi?.map(page => [page.path, page.section]), [
    ['commerce-orders', 'commerce'], ['commerce-promotions', 'commerce'],
    ['commerce-gift-cards', 'commerce'], ['commerce-test-checkout', 'commerce']
  ]);

  const plugin = ecommercePlugin({
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

test('native commerce tables are restricted to administrators and operational rows are read only', () => {
  const collections = ecommercePlugin().onInit({ collections: [] }).collections;
  for (const collection of collections.filter(item => item.nativeSchemaMapping?.schemaPath === '@talisman-cms/plugin-ecommerce/schema')) {
    assert.deepEqual(collection.access, { read: 'admin', create: 'admin', update: 'admin', delete: 'admin' });
  }
  assert.equal(collections.find(item => item.slug === '_ecommerce_carts').readOnly, true);
  assert.equal(collections.find(item => item.slug === '_ecommerce_customers').readOnly, true);
});
