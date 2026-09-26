import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currencyMinorUnits, formatMoney, fromMinorUnits, minimumChargeAmount, toMinorUnits } from '../dist/money.js';

// Intl separates some symbols with a no-break space, and ICU versions differ in which space they use.
const formatted = (...args) => formatMoney(...args).replace(/\s/g, ' ');

test('amounts are scaled by the minor units of their currency', () => {
  // [currency, minor units, amount in minor units, formatted, amount in major units]
  const cases = [
    ['usd', 2, 1250, '$12.50', 12.5],
    ['EUR', 2, 1250, '€12.50', 12.5],
    ['jpy', 0, 1250, '¥1,250', 1250],
    ['kwd', 3, 1250, 'KWD 1.250', 1.25],
  ];
  for (const [currency, digits, amount, text, major] of cases) {
    assert.equal(currencyMinorUnits(currency), digits, currency);
    assert.equal(formatted(amount, currency), text, currency);
    assert.equal(fromMinorUnits(amount, currency), major, currency);
    assert.equal(toMinorUnits(major, currency), amount, currency);
  }
  assert.equal(formatted(1250, 'eur', 'de-DE'), '12,50 €');
  // Admin inputs are rounded to whole minor units, whatever the floating-point error.
  assert.equal(toMinorUnits(19.99, 'usd'), 1999);
  assert.equal(toMinorUnits(12.345, 'kwd'), 12345);
  assert.equal(toMinorUnits(0.1 + 0.2, 'usd'), 30);
});

test("the minimum charge follows Stripe's table and falls back to 50", () => {
  const cases = [['usd', 50], ['eur', 50], ['gbp', 30], ['GBP', 30], ['jpy', 50], ['aed', 200],
    ['huf', 17500], ['czk', 1500], ['kwd', 50]];
  for (const [currency, minimum] of cases) assert.equal(minimumChargeAmount(currency), minimum, currency);
});
