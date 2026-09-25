import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimePaymentAdapters, runtimeStripeSecrets } from '../dist/runtime.js';

test('local test secrets stay optional and cannot enable live mode', () => {
  const local = {
    GALAXY_COMMERCE_STRIPE_MODE: 'test',
    GALAXY_COMMERCE_LOCAL_STRIPE_SECRET_KEY: 'sk_test_local',
    GALAXY_COMMERCE_LOCAL_STRIPE_WEBHOOK_SECRET: 'whsec_local'
  };
  assert.deepEqual(runtimePaymentAdapters(local).map(adapter => adapter.providerId), ['stripe', 'admin_test']);
  assert.equal(runtimeStripeSecrets(local).secretKey, 'sk_test_local');
  assert.deepEqual(runtimePaymentAdapters({ ...local, GALAXY_COMMERCE_STRIPE_MODE: 'live' }).map(adapter => adapter.providerId), ['admin_test']);
  assert.deepEqual(runtimePaymentAdapters({ ...local, GALAXY_COMMERCE_LOCAL_STRIPE_SECRET_KEY: '' }).map(adapter => adapter.providerId), ['admin_test']);
});

test('deployed Worker secrets take precedence over local test bindings', () => {
  const env = {
    GALAXY_COMMERCE_STRIPE_MODE: 'live',
    GALAXY_COMMERCE_LOCAL_STRIPE_SECRET_KEY: 'sk_test_local',
    GALAXY_COMMERCE_LOCAL_STRIPE_WEBHOOK_SECRET: 'whsec_local',
    STRIPE_SECRET_KEY: 'sk_live_worker',
    STRIPE_WEBHOOK_SECRET: 'whsec_worker'
  };
  assert.deepEqual(runtimeStripeSecrets(env), {
    secretKey: 'sk_live_worker', webhookSecret: 'whsec_worker', mode: 'live'
  });
  assert.deepEqual(runtimePaymentAdapters(env).map(adapter => adapter.providerId), ['stripe', 'admin_test']);
});
