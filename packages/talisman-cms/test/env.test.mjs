import assert from 'node:assert/strict';
import test from 'node:test';
import { readBinding, readSetting } from '../dist/env.js';

// Runs first: node --test gives each file its own process, so nothing has warned yet.
test('a legacy GALAXY_* name warns once per process, without its value', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(readSetting({ GALAXY_AUTH_SECRET: 'legacy-secret-value' }, 'AUTH_SECRET'), 'legacy-secret-value');
  assert.equal(readSetting({ GALAXY_COMMERCE_STRIPE_MODE: 'live' }, 'COMMERCE_STRIPE_MODE'), 'live');
  assert.ok(readBinding({ GALAXY_PUBLISH_WORKFLOW: {} }, 'PUBLISH_WORKFLOW'));
  assert.equal(warn.mock.callCount(), 1);
  const message = String(warn.mock.calls[0].arguments[0]);
  assert.match(message, /GALAXY_AUTH_SECRET/);
  assert.match(message, /TALISMAN_AUTH_SECRET/);
  assert.doesNotMatch(message, /legacy-secret-value/);
});

test('readSetting prefers TALISMAN_*, falls back to GALAXY_*, and trims', (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.equal(readSetting({ TALISMAN_AUTH_SECRET: 'new', GALAXY_AUTH_SECRET: 'old' }, 'AUTH_SECRET'), 'new');
  assert.equal(readSetting({ GALAXY_AUTH_SECRET: ' old \n' }, 'AUTH_SECRET'), 'old');
  assert.equal(readSetting({ TALISMAN_AUTH_SECRET: '  new\t' }, 'AUTH_SECRET'), 'new');
  assert.equal(readSetting({ AUTH_SECRET: 'unprefixed' }, 'AUTH_SECRET'), undefined);
  assert.equal(readSetting({}, 'AUTH_SECRET'), undefined);
  assert.equal(readSetting(undefined, 'AUTH_SECRET'), undefined);
  assert.equal(readSetting(null, 'AUTH_SECRET'), undefined);
});

test('readSetting treats blank values as unset', (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.equal(readSetting({ TALISMAN_COMMERCE_CHECKOUT_ENABLED: '', GALAXY_COMMERCE_CHECKOUT_ENABLED: 'true' },
    'COMMERCE_CHECKOUT_ENABLED'), 'true');
  assert.equal(readSetting({ TALISMAN_COMMERCE_CHECKOUT_ENABLED: '   ', GALAXY_COMMERCE_CHECKOUT_ENABLED: ' ' },
    'COMMERCE_CHECKOUT_ENABLED'), undefined);
  assert.equal(readSetting({ TALISMAN_COMMERCE_CHECKOUT_ENABLED: null, GALAXY_COMMERCE_CHECKOUT_ENABLED: 'true' },
    'COMMERCE_CHECKOUT_ENABLED'), 'true');
  // process.env is a valid source outside Workers.
  const previous = process.env.TALISMAN_TEST_ONLY_SETTING;
  try {
    process.env.TALISMAN_TEST_ONLY_SETTING = ' from-process ';
    assert.equal(readSetting(process.env, 'TEST_ONLY_SETTING'), 'from-process');
  } finally {
    if (previous === undefined) delete process.env.TALISMAN_TEST_ONLY_SETTING;
    else process.env.TALISMAN_TEST_ONLY_SETTING = previous;
  }
});

test('readSetting reads TOML numbers and booleans as text, and ignores other types with one warning per name', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  // wrangler.toml `[vars]` keeps a TOML number or boolean as that type.
  assert.equal(readSetting({ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: 500 }, 'COMMERCE_EMAIL_DAILY_LIMIT'), '500');
  assert.equal(readSetting({ TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT: 0 }, 'COMMERCE_EMAIL_DAILY_LIMIT'), '0');
  assert.equal(readSetting({ TALISMAN_COMMERCE_CHECKOUT_ENABLED: true }, 'COMMERCE_CHECKOUT_ENABLED'), 'true');
  assert.equal(readSetting({ TALISMAN_COMMERCE_CHECKOUT_ENABLED: false, GALAXY_COMMERCE_CHECKOUT_ENABLED: 'true' },
    'COMMERCE_CHECKOUT_ENABLED'), 'false');
  assert.equal(warn.mock.callCount(), 0);

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, ['owner@example.test'], { limit: 500 }]) {
    assert.equal(readSetting({ TALISMAN_ACCESS_ADMIN_EMAILS: value }, 'ACCESS_ADMIN_EMAILS'), undefined);
  }
  assert.equal(readSetting({ TALISMAN_ACCESS_ADMIN_EMAILS: ['x'], GALAXY_ACCESS_ADMIN_EMAILS: 'owner@example.test' },
    'ACCESS_ADMIN_EMAILS'), 'owner@example.test');
  const ignored = warn.mock.calls.map((call) => String(call.arguments[0])).filter((message) => /is not text/.test(message));
  assert.equal(ignored.length, 1);
  assert.match(ignored[0], /TALISMAN_ACCESS_ADMIN_EMAILS/);
  assert.doesNotMatch(ignored[0], /owner@example\.test/);
});

test('readBinding prefers TALISMAN_*, falls back to GALAXY_*, and returns the binding itself', (t) => {
  t.mock.method(console, 'warn', () => {});
  const current = { create() {} };
  const legacy = { create() {} };
  assert.equal(readBinding({ TALISMAN_PUBLISH_WORKFLOW: current, GALAXY_PUBLISH_WORKFLOW: legacy }, 'PUBLISH_WORKFLOW'), current);
  assert.equal(readBinding({ GALAXY_PUBLISH_WORKFLOW: legacy }, 'PUBLISH_WORKFLOW'), legacy);
  assert.equal(readBinding({ TALISMAN_PUBLISH_WORKFLOW: null, GALAXY_PUBLISH_WORKFLOW: legacy }, 'PUBLISH_WORKFLOW'), legacy);
  assert.equal(readBinding({ TALISMAN_PUBLISH_WORKFLOW: ' ', GALAXY_PUBLISH_WORKFLOW: legacy }, 'PUBLISH_WORKFLOW'), legacy);
  assert.equal(readBinding({ TALISMAN_PUBLISH_WORKFLOW: undefined }, 'PUBLISH_WORKFLOW'), undefined);
  assert.equal(readBinding({ GALAXY_PUBLISH_WORKFLOW: '' }, 'PUBLISH_WORKFLOW'), undefined);
  assert.equal(readBinding(undefined, 'PUBLISH_WORKFLOW'), undefined);
});
