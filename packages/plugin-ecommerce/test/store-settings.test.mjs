import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStoreSettings, shippingOptionsFor, StoreSettingsError } from '../dist/index.js';

test('a store that sets nothing sells in USD, delivers to any country and charges no shipping or tax', () => {
  const tax = (value) => ({ TALISMAN_COMMERCE_TAX: value, TALISMAN_COMMERCE_TAX_CODE: value,
    TALISMAN_COMMERCE_SHIP_FROM_COUNTRY: value });
  for (const env of [{}, { TALISMAN_COMMERCE_CURRENCY: '', TALISMAN_COMMERCE_DELIVERY_COUNTRIES: '',
    TALISMAN_COMMERCE_SHIPPING_RATES: '', ...tax('') }, { TALISMAN_COMMERCE_CURRENCY: '  ',
    TALISMAN_COMMERCE_DELIVERY_COUNTRIES: ' \n ', TALISMAN_COMMERCE_SHIPPING_RATES: ' \n ', ...tax(' \n ') }]) {
    assert.deepEqual(readStoreSettings(env), { currency: 'usd', deliveryCountries: null, shippingRates: [],
      tax: { mode: 'none', taxCode: null, shipFromCountry: null } });
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

const standard = { id: 'standard', label: 'Standard shipping', amount: 700 };

test('shipping rates are read from JSON text or a list, with their countries in uppercase', () => {
  const rates = [
    { id: 'standard', label: ' Standard shipping ', amount: 700, countries: ['us', ' CA', 'US'], freeOver: 10000,
      minDays: 3, maxDays: 5 },
    // A null optional field counts as left out.
    { id: 'express_2-day', label: 'Express', amount: 0, countries: null, freeOver: null },
  ];
  const expected = [
    { id: 'standard', label: 'Standard shipping', amount: 700, countries: ['US', 'CA'], freeOver: 10000,
      minDays: 3, maxDays: 5 },
    { id: 'express_2-day', label: 'Express', amount: 0, countries: null, freeOver: null, minDays: null, maxDays: null },
  ];
  for (const value of [JSON.stringify(rates), rates]) {
    assert.deepEqual(readStoreSettings({ TALISMAN_COMMERCE_SHIPPING_RATES: value }).shippingRates, expected);
  }
  const settings = readStoreSettings({ TALISMAN_COMMERCE_DELIVERY_COUNTRIES: 'US GB',
    TALISMAN_COMMERCE_SHIPPING_RATES: [{ ...standard, countries: ['gb'] }] });
  assert.deepEqual(settings.shippingRates[0].countries, ['GB']);
});

test('invalid shipping rates throw StoreSettingsError naming the setting and the rate', () => {
  const name = 'TALISMAN_COMMERCE_SHIPPING_RATES';
  const cases = [
    ['[{', /^TALISMAN_COMMERCE_SHIPPING_RATES must be valid JSON: /],
    ['{"id":"standard"}', `${name} must be a JSON list of shipping rates`],
    [standard, `${name} must be a JSON list of shipping rates`],
    [700, `${name} must be a JSON list of shipping rates`],
    // A list without rates would otherwise read as "no shipping charge".
    ['[]', `${name} lists no rates; leave it unset to charge no shipping`],
    [[], `${name} lists no rates; leave it unset to charge no shipping`],
    [Array.from({ length: 11 }, (_, index) => ({ ...standard, id: `rate-${index}` })), `${name} must list at most 10 rates, not 11`],
    [[standard, { ...standard, label: 'Again' }], `${name}[1].id: "standard" is used by another rate`],
    [[{ ...standard, id: 'Standard' }], `${name}[0].id: must be 1 to 40 characters from a-z, 0-9, _ and -`],
    [[{ ...standard, id: 'x'.repeat(41) }], /\[0\]\.id: must be 1 to 40 characters/],
    [[{ ...standard, id: '' }], /\[0\]\.id: must be 1 to 40 characters/],
    [[{ ...standard, label: '  ' }], /\[0\]\.label: /],
    [[{ ...standard, label: 'x'.repeat(101) }], /\[0\]\.label: /],
    [[{ id: 'standard', label: 'Standard shipping' }], `${name}[0].amount: Required`],
    [[{ ...standard, amount: -1 }], /\[0\]\.amount: /],
    [[{ ...standard, amount: 7.5 }], /\[0\]\.amount: /],
    [[{ ...standard, amount: '700' }], /\[0\]\.amount: /],
    [[{ ...standard, amount: 2 ** 53 }], /\[0\]\.amount: /],
    [[{ ...standard, countries: ['US', 'UK', 'usa'] }], `${name}[0].countries: must list officially assigned `
      + 'ISO 3166-1 alpha-2 codes such as "US", not "UK", "usa"'],
    [[{ ...standard, countries: [] }], `${name}[0].countries: lists no countries; leave it out to serve every delivery country`],
    [[{ ...standard, countries: 'US' }], /\[0\]\.countries: /],
    [[{ ...standard, freeOver: 0 }], /\[0\]\.freeOver: /],
    [[{ ...standard, minDays: 0 }], /\[0\]\.minDays: /],
    [[{ ...standard, maxDays: 366 }], /\[0\]\.maxDays: /],
    [[{ ...standard, minDays: 10, maxDays: 5 }], `${name}[0].minDays: must not be more than maxDays`],
    // A misspelt field is refused rather than ignored.
    [[{ ...standard, free_over: 10000 }], `${name}[0]: Unrecognized key(s) in object: 'free_over'`],
    [['standard'], /\[0\]: Expected object/],
  ];
  for (const [value, message] of cases) {
    assert.throws(() => readStoreSettings({ TALISMAN_COMMERCE_SHIPPING_RATES: value }), (error) => {
      assert.ok(error instanceof StoreSettingsError, JSON.stringify(value).slice(0, 80));
      if (typeof message === 'string') assert.equal(error.message, message);
      else assert.match(error.message, message);
      return true;
    });
  }
  // A rate cannot serve a country the store does not deliver to.
  assert.throws(() => readStoreSettings({ TALISMAN_COMMERCE_DELIVERY_COUNTRIES: 'US, CA',
    TALISMAN_COMMERCE_SHIPPING_RATES: [{ ...standard, countries: ['us', 'GB', 'fr'] }] }), { name: 'StoreSettingsError',
    message: `${name}[0].countries: must be among TALISMAN_COMMERCE_DELIVERY_COUNTRIES, not "GB", "FR"` });
});

test('shipping options list the rates that serve a country, free once the items reach freeOver', () => {
  const settings = readStoreSettings({ TALISMAN_COMMERCE_DELIVERY_COUNTRIES: 'US CA GB',
    TALISMAN_COMMERCE_SHIPPING_RATES: [
      { id: 'standard', label: 'Standard shipping', amount: 700, countries: ['US', 'CA'], freeOver: 10000,
        minDays: 3, maxDays: 5 },
      { id: 'express', label: 'Express shipping', amount: 2500, minDays: 1, maxDays: 1 },
      { id: 'international', label: 'International shipping', amount: 1500, countries: ['GB'], maxDays: 10 },
      { id: 'freight', label: 'Freight', amount: 9000, countries: ['CA'], minDays: 7 },
      { id: 'pickup', label: 'Courier pickup', amount: 300, countries: ['GB'] },
    ] });
  const options = (country, itemsAmount = 5000) => shippingOptionsFor(settings, country, itemsAmount)
    .map((option) => [option.id, option.amount, option.description]);
  assert.deepEqual(options('US'), [['standard', 700, 'Delivery in 3–5 business days'],
    ['express', 2500, 'Delivery in 1 business day']]);
  // The items total after discounts decides whether a rate is free.
  assert.deepEqual(options(' ca ', 10000), [['standard', 0, 'Delivery in 3–5 business days'],
    ['express', 2500, 'Delivery in 1 business day'], ['freight', 9000, 'Delivery in at least 7 business days']]);
  assert.deepEqual(options('gb', 9999), [['express', 2500, 'Delivery in 1 business day'],
    ['international', 1500, 'Delivery in up to 10 business days'], ['pickup', 300, null]]);
  assert.deepEqual(shippingOptionsFor(settings, 'US', 9999)[0], { id: 'standard', label: 'Standard shipping',
    amount: 700, description: 'Delivery in 3–5 business days', freeOver: 10000, minDays: 3, maxDays: 5 });
  // Outside the delivery countries, not a country code, or a store without rates: nothing to offer.
  for (const country of ['FR', 'UK', '', undefined]) assert.deepEqual(options(country), [], String(country));
  assert.deepEqual(shippingOptionsFor(readStoreSettings({}), 'US', 5000), []);
});

test('the tax mode is case-insensitive, and the tax code and ship-from country are read with it', (t) => {
  t.mock.method(console, 'warn', () => {});
  const cases = [
    [{ TALISMAN_COMMERCE_TAX: 'none' }, { mode: 'none', taxCode: null, shipFromCountry: null }],
    [{ TALISMAN_COMMERCE_TAX: ' Stripe-Inclusive ' }, { mode: 'stripe-inclusive', taxCode: null, shipFromCountry: null }],
    [{ TALISMAN_COMMERCE_TAX: 'stripe-exclusive', TALISMAN_COMMERCE_TAX_CODE: ' txcd_99999999 ',
      TALISMAN_COMMERCE_SHIP_FROM_COUNTRY: ' us ' }, { mode: 'stripe-exclusive', taxCode: 'txcd_99999999', shipFromCountry: 'US' }],
    // Checked and kept even while tax is off, so turning it on meets no wrong value.
    [{ TALISMAN_COMMERCE_TAX_CODE: 'txcd_30011000', TALISMAN_COMMERCE_SHIP_FROM_COUNTRY: 'CA' },
      { mode: 'none', taxCode: 'txcd_30011000', shipFromCountry: 'CA' }],
    [{ GALAXY_COMMERCE_TAX: 'STRIPE-EXCLUSIVE' }, { mode: 'stripe-exclusive', taxCode: null, shipFromCountry: null }],
  ];
  for (const [env, tax] of cases) assert.deepEqual(readStoreSettings(env).tax, tax, JSON.stringify(env));
});

test('invalid tax settings throw StoreSettingsError naming the setting', () => {
  const cases = [
    [{ TALISMAN_COMMERCE_TAX: 'stripe' }, 'TALISMAN_COMMERCE_TAX must be "none", "stripe-inclusive" or '
      + '"stripe-exclusive", not "stripe"'],
    [{ TALISMAN_COMMERCE_TAX: 'automatic' }, /^TALISMAN_COMMERCE_TAX must be /],
    // A list or a boolean is refused rather than read as "none".
    [{ TALISMAN_COMMERCE_TAX: ['stripe-exclusive'] }, 'TALISMAN_COMMERCE_TAX must be text'],
    [{ TALISMAN_COMMERCE_TAX: true }, 'TALISMAN_COMMERCE_TAX must be text'],
    [{ TALISMAN_COMMERCE_TAX_CODE: 'txcd_9999999' }, 'TALISMAN_COMMERCE_TAX_CODE must be a Stripe tax code '
      + 'such as "txcd_99999999", not "txcd_9999999"'],
    [{ TALISMAN_COMMERCE_TAX_CODE: 'TXCD_99999999' }, /^TALISMAN_COMMERCE_TAX_CODE must be /],
    [{ TALISMAN_COMMERCE_TAX_CODE: 'txcd_99999999x' }, /^TALISMAN_COMMERCE_TAX_CODE must be /],
    [{ TALISMAN_COMMERCE_TAX_CODE: 99999999 }, 'TALISMAN_COMMERCE_TAX_CODE must be text'],
    [{ TALISMAN_COMMERCE_SHIP_FROM_COUNTRY: 'UK' }, 'TALISMAN_COMMERCE_SHIP_FROM_COUNTRY must be an officially '
      + 'assigned ISO 3166-1 alpha-2 code such as "US", not "UK"'],
    [{ TALISMAN_COMMERCE_SHIP_FROM_COUNTRY: 'US, CA' }, /^TALISMAN_COMMERCE_SHIP_FROM_COUNTRY must be /],
    [{ TALISMAN_COMMERCE_SHIP_FROM_COUNTRY: ['US'] }, 'TALISMAN_COMMERCE_SHIP_FROM_COUNTRY must be text'],
  ];
  for (const [env, message] of cases) {
    assert.throws(() => readStoreSettings(env), (error) => {
      assert.ok(error instanceof StoreSettingsError, JSON.stringify(env));
      if (typeof message === 'string') assert.equal(error.message, message);
      else assert.match(error.message, message);
      return true;
    });
  }
});
