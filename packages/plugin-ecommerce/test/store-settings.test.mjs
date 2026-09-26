import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStoreSettings, StoreSettingsError } from '../dist/index.js';

test('a store that sets nothing sells in USD and delivers to any country', () => {
  for (const env of [{}, { TALISMAN_COMMERCE_CURRENCY: '', TALISMAN_COMMERCE_DELIVERY_COUNTRIES: '' },
    { TALISMAN_COMMERCE_CURRENCY: '  ', TALISMAN_COMMERCE_DELIVERY_COUNTRIES: ' \n ' }]) {
    assert.deepEqual(readStoreSettings(env), { currency: 'usd', deliveryCountries: null });
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

test('delivery countries are read from text or a list, in uppercase and without duplicates', () => {
  const cases = [
    ['US, ca  GB', ['US', 'CA', 'GB']],
    ['us,US ,\tCa,', ['US', 'CA']],
    [['nz', ' AU ', 'NZ'], ['NZ', 'AU']],
  ];
  for (const [value, countries] of cases) {
    assert.deepEqual(readStoreSettings({ TALISMAN_COMMERCE_DELIVERY_COUNTRIES: value }).deliveryCountries, countries);
  }
});

test('invalid delivery countries throw StoreSettingsError naming the setting', () => {
  // Codes that are not officially assigned, other types, and values that name no country at all, which
  // would otherwise read as "deliver anywhere".
  for (const value of ['UK', 'USA', 'US, UK', 'XK', 'EU', 'U5', ',', [], [' '], ['US', 840], 840, { US: true }]) {
    assert.throws(() => readStoreSettings({ TALISMAN_COMMERCE_DELIVERY_COUNTRIES: value }), (error) => {
      assert.ok(error instanceof StoreSettingsError, JSON.stringify(value));
      assert.match(error.message, /^TALISMAN_COMMERCE_DELIVERY_COUNTRIES /);
      return true;
    });
  }
  assert.throws(() => readStoreSettings({ TALISMAN_COMMERCE_DELIVERY_COUNTRIES: 'US uk USA' }), {
    message: 'TALISMAN_COMMERCE_DELIVERY_COUNTRIES must list officially assigned ISO 3166-1 alpha-2 codes'
      + ' such as "US", not "uk", "USA"' });
});
