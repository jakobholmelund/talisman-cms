import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimePaymentAdapters, runtimeStripeSecrets } from '../dist/runtime.js';

test('local test secrets stay optional and cannot enable live mode', () => {
  const local = {
    TALISMAN_COMMERCE_STRIPE_MODE: 'test',
    TALISMAN_COMMERCE_LOCAL_STRIPE_SECRET_KEY: 'sk_test_local',
    TALISMAN_COMMERCE_LOCAL_STRIPE_WEBHOOK_SECRET: 'whsec_local'
  };
  assert.deepEqual(runtimePaymentAdapters(local).map(adapter => adapter.providerId), ['stripe', 'admin_test']);
  assert.equal(runtimeStripeSecrets(local).secretKey, 'sk_test_local');
  assert.deepEqual(runtimePaymentAdapters({ ...local, TALISMAN_COMMERCE_STRIPE_MODE: 'live' }).map(adapter => adapter.providerId), ['admin_test']);
  assert.deepEqual(runtimePaymentAdapters({ ...local, TALISMAN_COMMERCE_LOCAL_STRIPE_SECRET_KEY: '' }).map(adapter => adapter.providerId), ['admin_test']);
});

test('deployed Worker secrets take precedence over local test bindings', () => {
  const env = {
    TALISMAN_COMMERCE_STRIPE_MODE: 'live',
    TALISMAN_COMMERCE_LOCAL_STRIPE_SECRET_KEY: 'sk_test_local',
    TALISMAN_COMMERCE_LOCAL_STRIPE_WEBHOOK_SECRET: 'whsec_local',
    STRIPE_SECRET_KEY: 'sk_live_worker',
    STRIPE_WEBHOOK_SECRET: 'whsec_worker'
  };
  assert.deepEqual(runtimeStripeSecrets(env), {
    secretKey: 'sk_live_worker', webhookSecret: 'whsec_worker', mode: 'live'
  });
  assert.deepEqual(runtimePaymentAdapters(env).map(adapter => adapter.providerId), ['stripe', 'admin_test']);
});

test('pre-rename GALAXY_* settings still apply when no TALISMAN_* value is set', (t) => {
  t.mock.method(console, 'warn', () => {});
  const legacy = {
    GALAXY_COMMERCE_STRIPE_MODE: 'test',
    GALAXY_COMMERCE_LOCAL_STRIPE_SECRET_KEY: 'sk_test_legacy',
    GALAXY_COMMERCE_LOCAL_STRIPE_WEBHOOK_SECRET: 'whsec_legacy'
  };
  assert.deepEqual(runtimeStripeSecrets(legacy), { secretKey: 'sk_test_legacy', webhookSecret: 'whsec_legacy', mode: 'test' });
  // A blank TALISMAN_* value, as in an empty wrangler.toml var, does not hide the legacy value.
  assert.equal(runtimeStripeSecrets({ ...legacy, TALISMAN_COMMERCE_LOCAL_STRIPE_SECRET_KEY: '' }).secretKey, 'sk_test_legacy');
  assert.deepEqual(runtimeStripeSecrets({ ...legacy, TALISMAN_COMMERCE_STRIPE_MODE: 'live' }),
    { secretKey: '', webhookSecret: '', mode: 'live' });
});
