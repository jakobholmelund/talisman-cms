import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStoreSettings, StoreSettingsError } from '../dist/index.js';

test('a store that sets no currency sells in USD', () => {
  for (const env of [{}, { TALISMAN_COMMERCE_CURRENCY: '' }, { TALISMAN_COMMERCE_CURRENCY: '  ' }]) {
    assert.deepEqual(readStoreSettings(env), { currency: 'usd' });
  }
});

test('the currency is case-insensitive and stored in lowercase', (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.equal(readStoreSettings({ TALISMAN_COMMERCE_CURRENCY: 'EUR' }).currency, 'eur');
  assert.equal(readStoreSettings({ TALISMAN_COMMERCE_CURRENCY: ' Gbp ' }).currency, 'gbp');
  assert.equal(readStoreSettings({ GALAXY_COMMERCE_CURRENCY: 'JPY' }).currency, 'jpy');
});

test('an invalid currency throws StoreSettingsError naming the setting', () => {
  // A number or a list is refused rather than ignored, so the store never falls back to USD.
  for (const value of ['US', 'dollars', 'U5D', 'us d', 840, ['eur'], { code: 'eur' }]) {
    assert.throws(() => readStoreSettings({ TALISMAN_COMMERCE_CURRENCY: value }), (error) => {
      assert.ok(error instanceof StoreSettingsError, JSON.stringify(value));
      assert.equal(error.name, 'StoreSettingsError');
      assert.match(error.message, /^TALISMAN_COMMERCE_CURRENCY must be /);
      return true;
    });
  }
});
