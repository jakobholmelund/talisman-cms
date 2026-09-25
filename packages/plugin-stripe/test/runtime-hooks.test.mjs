import assert from 'node:assert/strict';
import test from 'node:test';
import { stripePlugin } from '../dist/index.js';

test('Stripe sync hooks are registered as Worker-loadable modules', () => {
  const plugin = stripePlugin({
    stripeSecretKey: 'sk_test_example',
    sync: [{
      collection: 'products',
      stripeResourceType: 'products',
      stripeResourceTypeSingular: 'product',
      fields: [{ fieldPath: 'name', stripeProperty: 'name' }],
    }],
    rest: true,
  });
  const options = plugin.onInit({ collections: [{ name: 'Products', slug: 'products', fields: [] }] });
  const product = options.collections.find((collection) => collection.slug === 'products');

  assert.equal(product.runtimeHooks?.[0].moduleId, '@talisman-cms/plugin-stripe/runtime-hooks');
  assert.equal(product.runtimeHooks?.[0].exportName, 'createStripeRuntimeHooks');
  assert.equal(plugin.endpoints.some((endpoint) => endpoint.path === '/stripe/rest'), false);
});

test('inline webhook handlers are rejected instead of silently disappearing', () => {
  assert.throws(
    () => stripePlugin({ stripeSecretKey: 'sk_test_example', webhooks: () => {} }),
    /webhooksModule/,
  );
});
