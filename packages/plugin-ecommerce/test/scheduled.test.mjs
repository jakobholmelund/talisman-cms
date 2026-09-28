import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrationSql } from './helpers/migrations.mjs';

// Server modules read their bindings from cloudflare:workers; serve them from globalThis.workerEnv.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== 'cloudflare:workers') return nextResolve(specifier, context);
    const source = 'export const env = new Proxy({}, { get: (_, key) => globalThis.workerEnv?.[key] });';
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});
const { scheduled } = await import('../dist/scheduled.js');

const migrationFiles = ['0004_ecommerce_plugin.sql', '0005_variant_value_images.sql', '0007_local_auth.sql',
  '0008_shared_components.sql', '0010_checkout_inventory.sql', '0011_order_payment_provider.sql',
  '0012_customer_accounts.sql', '0013_referrals_and_credit.sql', '0014_promotions.sql',
  '0015_gift_cards.sql', '0016_verified_customer_sessions.sql', '0017_commerce_fulfillment.sql',
  '0019_shared_customer_identity.sql', '0024_shopper_sign_in_tokens.sql', '0025_order_shipping_and_tax.sql',
  '0026_order_fulfillment_status.sql', '0027_gift_card_review.sql', '0028_provider_refunds_and_disputes.sql',
  '0029_commerce_reconcile_backoff.sql', '0030_commerce_order_emails.sql'];

/** An in-memory D1 stand-in that records every statement and refuses the ones matching `refused`. */
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of migrationFiles) {
    sqlite.exec(migrationSql(migration).replaceAll('--> statement-breakpoint', ''));
  }
  const statements = [];
  const state = { refused: null };
  const DB = {
    prepare(sql) {
      statements.push(sql);
      if (state.refused?.test(sql)) throw new Error(`D1 is unavailable for: ${sql.trim().slice(0, 40)}`);
      const prepared = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async all() { return { results: prepared.all(...values) }; },
        async first() { return prepared.get(...values) ?? null; },
        async raw() {
          const raw = sqlite.prepare(sql);
          raw.setReturnArrays(true);
          return raw.all(...values);
        },
        async run() { return { meta: prepared.run(...values) }; },
      };
    },
    async batch(list) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of list) results.push(await statement.all());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { sqlite, DB, statements, refuse: (pattern) => { state.refused = pattern; } };
}

const day = 24 * 60 * 60;
const tick = (DB) => ({ cron: '*/10 * * * *', scheduledTime: Date.now(), env: { DB }, waitUntil() {} });
// Reconciliation also removes expired shopper sessions, so the purge is recognised by a table only it touches.
const reconciledStatement = (sql) => /FROM _ecommerce_orders/.test(sql) && /status = 'pending'/.test(sql);
const purgeStatement = (sql) => /DELETE FROM _ecommerce_rate_limits/.test(sql);
const reconciled = (statements) => statements.some(reconciledStatement);
const purged = (statements) => statements.some(purgeStatement);

test('one tick reconciles checkouts and then purges stale data, and passes without failures', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { sqlite, DB, statements } = database();
  const old = Math.floor(Date.now() / 1000) - 31 * day;
  sqlite.prepare(`INSERT INTO _ecommerce_carts (id, session_token, items, created_at, updated_at) VALUES ('cart-idle', 'anon_idle', '[]', ?, ?)`).run(old, old);

  await scheduled(tick(DB));

  assert.ok(reconciled(statements), 'reconciliation looked for pending orders');
  assert.ok(purged(statements), 'the purge ran');
  assert.ok(statements.findIndex(reconciledStatement) < statements.findIndex(purgeStatement), 'reconciliation ran first');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _ecommerce_carts').get().count, 0);
  assert.equal(errors.mock.callCount(), 0);
  sqlite.close();
});

test('a failing purge is logged and fails the tick, after reconciliation ran', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { sqlite, DB, statements, refuse } = database();
  // The auth rate-limit rows are the purge's last step; every other step still runs.
  refuse(/DELETE FROM galaxy_auth_rate_limit/);

  await assert.rejects(scheduled(tick(DB)), { message: 'Data retention cleanup failed' });

  assert.ok(reconciled(statements));
  assert.ok(purged(statements));
  assert.deepEqual(errors.mock.calls.map((call) => call.arguments[0]), ['[Commerce] Data retention cleanup failed']);
  assert.match(errors.mock.calls[0].arguments[1].message, /Commerce data cleanup failed/);
  sqlite.close();
});

test('a failing reconciliation never skips the purge, and the thrown error names both failures', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { sqlite, DB, statements, refuse } = database();
  // Reconciliation opens with the orphaned checkout locks; the purge opens with the idle baskets.
  refuse(/checkout_session_id >= 'preparing:'|DELETE FROM _ecommerce_carts/);

  await assert.rejects(scheduled(tick(DB)), { message: 'Checkout reconciliation failed; Data retention cleanup failed' });

  assert.ok(!reconciled(statements), 'reconciliation stopped at its first statement');
  assert.ok(purged(statements), 'the purge still ran');
  assert.deepEqual(errors.mock.calls.map((call) => call.arguments[0]), [
    '[Commerce] Checkout reconciliation failed',
    '[Commerce] Data retention cleanup failed',
  ]);
  assert.match(errors.mock.calls[0].arguments[1].message, /D1 is unavailable/);
  sqlite.close();
});
