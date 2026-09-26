import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COUNTRY_CODES, isCountryCode } from '../dist/index.js';

test('the country codes are the 249 officially assigned ISO 3166-1 alpha-2 codes, sorted', () => {
  assert.equal(COUNTRY_CODES.length, 249);
  assert.equal(new Set(COUNTRY_CODES).size, COUNTRY_CODES.length);
  assert.deepEqual([...COUNTRY_CODES].sort(), COUNTRY_CODES);
  assert.ok(Object.isFrozen(COUNTRY_CODES));
  // Every code names a region, which catches a mistyped entry.
  const regions = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
  for (const code of COUNTRY_CODES) {
    assert.match(code, /^[A-Z]{2}$/);
    assert.ok(regions.of(code), code);
  }
});

test('only officially assigned codes, in uppercase, are country codes', () => {
  for (const code of ['US', 'GB', 'CA', 'AX', 'BQ', 'CW', 'SS', 'SX']) assert.equal(isCountryCode(code), true, code);
  // Reserved (UK, EU), user-assigned (XK, ZZ) and withdrawn (AN, YU) codes are not, nor is other input.
  for (const code of ['UK', 'EU', 'XK', 'ZZ', 'AN', 'YU', 'us', ' US', 'USA', 'U5', '', undefined]) {
    assert.equal(isCountryCode(code), false, String(code));
  }
});
