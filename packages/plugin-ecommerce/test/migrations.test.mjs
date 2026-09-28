import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { assembleMigrations, compareMigrationNames } from 'talisman-cms/migrations';
import { renderRichText } from 'talisman-cms/richtext';
import * as pluginSchema from '../dist/schema.js';
import * as coreSchema from '../../talisman-cms/dist/db/schema.js';
import * as authSchema from '../../talisman-cms/dist/auth/local-schema.js';
import { T, applyAllMigrations, assertIntegrity, assertMatchesSchema, fullSchema, migrationFiles, migrationSources, openDatabase,
  outline, pluginMigrationsDir, row, rows } from './helpers/migrations.mjs';

// drizzle-kit generates the plugin's migrations from src/schema.ts (`pnpm db:generate`), one folder
// per migration in drizzle/; the commerce triggers, which it cannot model, are a custom migration
// written by hand. `wrangler d1 migrations apply` reads one folder per binding, so the integration
// copies the core's and the plugin's migrations into one; these tests build that folder the same way
// and apply it as wrangler does.
const MIGRATION_FILE = /^\d{14}_[a-z0-9_]+\.sql$/;
const tables = [pluginSchema, coreSchema, authSchema].flatMap((module) => Object.values(module)).filter((value) => is(value, SQLiteTable));

/** The commerce triggers, with the table each one is on. */
const TRIGGERS = [
  '_ecommerce_credit_ledger_balance ON _ecommerce_credit_ledger',
  '_ecommerce_credit_reserve_guard ON _ecommerce_credit_ledger',
  '_ecommerce_discount_credit_release ON _ecommerce_discount_redemptions',
  '_ecommerce_discount_credit_reserve ON _ecommerce_discount_redemptions',
  '_ecommerce_discount_reserve_guard ON _ecommerce_discount_redemptions',
  '_ecommerce_fulfillment_complete ON _ecommerce_fulfillments',
  '_ecommerce_fulfillment_correction_guard ON _ecommerce_fulfillments',
  '_ecommerce_fulfillment_guard ON _ecommerce_fulfillments',
  '_ecommerce_gift_card_claim_guard ON _ecommerce_gift_card_claims',
  '_ecommerce_gift_card_issue_guard ON _ecommerce_gift_card_ledger',
  '_ecommerce_gift_card_ledger_balance ON _ecommerce_gift_card_ledger',
  '_ecommerce_gift_card_partial_refund ON _ecommerce_gift_card_refunds',
  '_ecommerce_gift_card_redemption_transition ON _ecommerce_gift_card_redemptions',
  '_ecommerce_gift_card_refund_guard ON _ecommerce_gift_card_refunds',
  '_ecommerce_gift_card_release ON _ecommerce_gift_card_redemptions',
  '_ecommerce_gift_card_reserve ON _ecommerce_gift_card_redemptions',
  '_ecommerce_gift_card_reserve_guard ON _ecommerce_gift_card_redemptions',
  '_ecommerce_products_stock_nonnegative ON _ecommerce_products',
  '_ecommerce_stocks_nonnegative ON _ecommerce_stocks',
  '_ecommerce_variants_stock_nonnegative ON _ecommerce_product_variants',
].sort();

// The folder a site's `migrations_dir` points at, built as the integration builds it.
const assembled = mkdtempSync(join(tmpdir(), 'talisman-migrations-'));
assembleMigrations({ sources: migrationSources, outDir: assembled });
after(() => rmSync(assembled, { recursive: true, force: true }));

// What `wrangler d1 migrations apply` does, written out independently of talisman-cms/migrations: the
// table it keeps, its order (the number before the first `_`, then the name) and its rule that a file
// whose name is recorded is skipped, whether or not the folder still holds it.
const D1_MIGRATIONS_TABLE = 'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)';
const wranglerOrder = (a, b) => {
  const [an, bn] = [parseInt(a.split('_')[0], 10), parseInt(b.split('_')[0], 10)];
  if (an !== bn && Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return a < b ? -1 : a > b ? 1 : 0;
};
const recordApplied = (db, name) => db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);

/** Applies a folder as wrangler does and returns the file names it applied. */
function applyFolder(db, dir) {
  db.exec(D1_MIGRATIONS_TABLE);
  const applied = new Set(rows(db, 'SELECT name FROM d1_migrations').map(({ name }) => name));
  const done = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.sql')).sort(wranglerOrder)) {
    if (applied.has(name)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(dir, name), 'utf8'));
      recordApplied(db, name);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`${name}: ${error.message}`, { cause: error });
    }
    done.push(name);
  }
  return done;
}

const queryPlan = (db, sql, ...params) => rows(db, `EXPLAIN QUERY PLAN ${sql}`, ...params).map((step) => step.detail).join(' | ');

/** A migrated database with the rows the rule tests below share. */
function seeded() {
  const db = openDatabase();
  applyAllMigrations(db);
  db.exec(`
    INSERT INTO galaxy_auth_user (id, name, email, created_at, updated_at, role) VALUES
      ('admin-1', 'Admin', 'Admin@Example.com', ${T}, ${T}, 'admin'),
      ('editor-1', 'Editor', 'editor@example.com', ${T}, ${T}, 'editor');
    INSERT INTO _ecommerce_products (id, name, slug, base_price, inventory_quantity, created_at, updated_at) VALUES
      ('prod-1', 'Frame', 'frame', 12000, 5, ${T}, ${T});
    INSERT INTO _ecommerce_variants (id, name, created_at, updated_at) VALUES ('var-colour', 'Colour', ${T}, ${T});
    INSERT INTO _ecommerce_product_variants (id, product_id, variant_id, name, inventory_quantity, created_at, updated_at) VALUES
      ('pv-1', 'prod-1', 'var-colour', 'Colour', 3, ${T}, ${T});
    INSERT INTO _ecommerce_product_variant_values (id, product_variant_id, value, sku, created_at, updated_at) VALUES
      ('pvv-1', 'pv-1', 'Black', 'FRAME-BLK', ${T}, ${T});
    INSERT INTO _ecommerce_stocks (id, product_variant_value_id, quantity, created_at, updated_at) VALUES ('stock-1', 'pvv-1', 2, ${T}, ${T});
    INSERT INTO _ecommerce_carts (id, session_token, items, created_at, updated_at) VALUES ('cart-1', 'anon_1', '[]', ${T}, ${T});
    INSERT INTO _ecommerce_orders (id, cart_id, status, items, total_amount, customer_email, created_at, updated_at) VALUES
      ('order-1', 'cart-1', 'paid', '[]', 12000, 'new@example.com', ${T}, ${T});
    INSERT INTO _ecommerce_payments (id, order_id, provider, provider_id, status, amount, created_at) VALUES
      ('pay-1', 'order-1', 'stripe', 'pi_1', 'succeeded', 12000, ${T});
    INSERT INTO _ecommerce_orders (id, status, items, total_amount, checkout_session_id, payment_provider, created_at, updated_at) VALUES
      ('order-pending', 'pending', '[]', 4000, 'cs_test_pending', 'stripe', ${T + 40}, ${T + 40});
    INSERT INTO _ecommerce_customer_accounts (id, email, email_normalized, email_verified_at, name, created_at, updated_at) VALUES
      ('shop-admin', 'Admin@Example.com', 'admin@example.com', ${T + 500}, 'Admin shopping', ${T}, ${T}),
      ('shop-new', 'New@Example.com', 'new@example.com', ${T + 500}, '  ', ${T}, ${T}),
      ('shop-unverified', 'x@example.com', 'x@example.com', NULL, 'X', ${T}, ${T});
    INSERT INTO _ecommerce_gift_card_purchases (id, buyer_email, amount_cents, status, provider_session_id, payment_intent_id, access_token_hash, created_at, updated_at) VALUES
      ('gp-held', 'buyer@example.com', 10000, 'paid', 'cs_held', 'pi_held', 'hash-held', ${T}, ${T}),
      ('gp-refunded', 'buyer@example.com', 5000, 'paid', 'cs_refunded', 'pi_refunded', 'hash-refunded', ${T}, ${T});
    INSERT INTO _ecommerce_gift_cards (id, code_hash, code_suffix, encrypted_code, source, purchase_id, admin_actor, admin_reason, initial_cents, created_at, updated_at) VALUES
      ('gift-held', 'code-held', 'AAAA', '000000000000000000000000:00', 'purchase', 'gp-held', NULL, NULL, 10000, ${T}, ${T}),
      ('gift-refunded', 'code-refunded', 'BBBB', '000000000000000000000000:11', 'purchase', 'gp-refunded', NULL, NULL, 5000, ${T}, ${T}),
      ('gift-admin', 'code-admin', 'CCCC', '000000000000000000000000:22', 'admin', NULL, 'admin-1', 'Customer goodwill', 2500, ${T}, ${T});
    INSERT INTO _ecommerce_gift_card_ledger (id, card_id, purchase_id, kind, amount_cents, created_at) VALUES
      ('gcl_issue_gift-held', 'gift-held', 'gp-held', 'issue', 10000, ${T}),
      ('gcl_issue_gift-refunded', 'gift-refunded', 'gp-refunded', 'issue', 5000, ${T}),
      ('gcl_issue_gift-admin', 'gift-admin', NULL, 'issue', 2500, ${T});
    UPDATE _ecommerce_gift_card_purchases SET status = 'review', provider_refunded_cents = 3000, updated_at = ${T + 10} WHERE id = 'gp-held';
    UPDATE _ecommerce_gift_cards SET status = 'suspended', updated_at = ${T + 10} WHERE id = 'gift-held';
    UPDATE _ecommerce_gift_card_purchases SET status = 'refunded', provider_refunded_cents = 5000, updated_at = ${T + 10} WHERE id = 'gp-refunded';
    UPDATE _ecommerce_gift_cards SET status = 'void', updated_at = ${T + 10} WHERE id = 'gift-refunded';
    INSERT INTO _ecommerce_gift_card_ledger (id, card_id, purchase_id, kind, amount_cents, created_at) VALUES
      ('gcl_purchase_reversal_gift-refunded', 'gift-refunded', 'gp-refunded', 'purchase_reversal', -5000, ${T + 10});
  `);
  return db;
}

/** An administrator's card and a purchased card, funded through the ledger as the plugin does it. */
function issueCards(db) {
  db.exec(`
    INSERT INTO _ecommerce_gift_cards (id, code_hash, code_suffix, encrypted_code, source, admin_actor, admin_reason, initial_cents, created_at, updated_at)
      VALUES ('gift-issued', 'code-issued', 'DDDD', '000000000000000000000000:33', 'admin', 'admin-1', 'Service goodwill', 3000, ${T}, ${T});
    INSERT INTO _ecommerce_gift_card_ledger (id, card_id, kind, amount_cents, created_at) VALUES ('gcl_issue_gift-issued', 'gift-issued', 'issue', 3000, ${T});
    INSERT INTO _ecommerce_gift_card_purchases (id, buyer_email, amount_cents, status, provider_session_id, payment_intent_id, access_token_hash, created_at, updated_at)
      VALUES ('gp-new', 'buyer@example.com', 8000, 'paid', 'cs_new', 'pi_new', 'hash-new', ${T}, ${T});
    INSERT INTO _ecommerce_gift_cards (id, code_hash, code_suffix, encrypted_code, source, purchase_id, initial_cents, created_at, updated_at)
      VALUES ('gift-new', 'code-new', 'EEEE', '000000000000000000000000:44', 'purchase', 'gp-new', 8000, ${T}, ${T});
    INSERT INTO _ecommerce_gift_card_ledger (id, card_id, purchase_id, kind, amount_cents, created_at) VALUES ('gcl_issue_gift-new', 'gift-new', 'gp-new', 'issue', 8000, ${T});
  `);
}

test('the core and the plugin ship timestamped drizzle-kit migrations that assemble into one folder in order', () => {
  const files = migrationFiles();
  assert.ok(files.length >= 3);
  for (const file of files) assert.match(file.name, MIGRATION_FILE);
  assert.deepEqual(files.map((file) => file.name), [...files.map((file) => file.name)].sort(compareMigrationNames));
  assert.equal(new Set(files.map((file) => file.name)).size, files.length, 'no two migrations share a name');
  // The plugin's tables reference the core's user table, so the core's first migration comes first.
  assert.equal(files[0].source, 'talisman-cms');
  assert.deepEqual(files.filter((file) => file.source === '@talisman-cms/plugin-ecommerce').map((file) => file.name),
    readdirSync(pluginMigrationsDir).filter((name) => !name.startsWith('.')).sort().map((name) => `${name}.sql`));

  // The assembled folder holds exactly those files, each a copy of its folder's migration.sql, plus
  // the record of who ships each.
  assert.deepEqual(readdirSync(assembled).filter((name) => name.endsWith('.sql')).sort(wranglerOrder), files.map((file) => file.name));
  assert.deepEqual(JSON.parse(readFileSync(join(assembled, 'sources.json'), 'utf8')), files.map(({ name, source }) => ({ name, source })));
  for (const file of files) assert.equal(readFileSync(join(assembled, file.name), 'utf8'), readFileSync(file.path, 'utf8'), file.name);
});

test('the trigger migration holds only the commerce triggers, and no migration relies on PRAGMA foreign_keys', () => {
  const files = migrationFiles();
  for (const file of files) {
    // D1 enforces foreign keys during a migration whatever `PRAGMA foreign_keys` says, and a generated
    // table rebuild opens with it: edit such a migration to `PRAGMA defer_foreign_keys = true`.
    assert.doesNotMatch(readFileSync(file.path, 'utf8'), /PRAGMA\s+foreign_keys\b/i, `${file.name}: PRAGMA foreign_keys has no effect on D1`);
  }
  const triggers = files.filter((file) => file.name.endsWith('_commerce_triggers.sql'));
  assert.equal(triggers.length, 1);
  const statements = readFileSync(triggers[0].path, 'utf8').split('--> statement-breakpoint')
    .map((statement) => statement.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
  assert.equal(statements.length, TRIGGERS.length);
  for (const statement of statements) assert.match(statement, /^CREATE TRIGGER `_ecommerce_/);
});

test('a fresh database gets exactly the schema the plugin and the core declare, with the commerce triggers', () => {
  const db = openDatabase();
  try {
    assert.deepEqual(applyFolder(db, assembled), migrationFiles().map((file) => file.name));
    assertIntegrity(db);
    assert.ok(tables.length >= 50);
    assertMatchesSchema(db, tables);
    assert.deepEqual(outline(db).triggers, TRIGGERS);

    // Applying the same folder a second time changes nothing, and a database that applied every
    // migration by name has nothing left to apply.
    const schema = fullSchema(db);
    assert.deepEqual(applyFolder(db, assembled), []);
    assert.deepEqual(fullSchema(db), schema);
  } finally {
    db.close();
  }
});

test('a shopper account is unlinked when its CMS user is deleted, and links one account per user', () => {
  const db = seeded();
  try {
    db.exec(`UPDATE _ecommerce_customer_accounts SET cms_user_id = 'editor-1' WHERE id = 'shop-new'`);
    assert.throws(() => db.exec(`UPDATE _ecommerce_customer_accounts SET cms_user_id = 'editor-1' WHERE id = 'shop-admin'`), /UNIQUE constraint failed/);
    assert.throws(() => db.exec(`UPDATE _ecommerce_customer_accounts SET cms_user_id = 'nobody' WHERE id = 'shop-admin'`), /FOREIGN KEY constraint failed/);
    db.exec(`DELETE FROM galaxy_auth_user WHERE id = 'editor-1'`);
    assert.equal(row(db, `SELECT cms_user_id FROM _ecommerce_customer_accounts WHERE id = 'shop-new'`).cms_user_id, null);
    // One user per email regardless of letter case.
    assert.throws(() => db.exec(`INSERT INTO galaxy_auth_user (id, name, email, created_at, updated_at) VALUES ('dup', 'Dup', 'ADMIN@example.com', ${T}, ${T})`), /UNIQUE constraint failed/);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('the ecommerce demo seed applies to the migrated schema and stores post content as Tiptap JSON', () => {
  const db = openDatabase();
  try {
    applyAllMigrations(db);
    db.exec(readFileSync(new URL('../../talisman-cms/seeds/ecommerce-demo.sql', import.meta.url), 'utf8'));
    assertIntegrity(db);
    const posts = rows(db, `SELECT e.slug, e.data, e.published_data FROM galaxy_entries e
      JOIN galaxy_collections c ON c.id = e.collection_id WHERE c.slug = 'posts'`);
    assert.ok(posts.length > 0);
    for (const post of posts) {
      for (const value of [post.data, post.published_data]) {
        // The renderer treats a string as plain text, so seeded HTML would show up as markup.
        const { content } = JSON.parse(value);
        assert.equal(content?.type, 'doc', `${post.slug}: content is not a Tiptap document`);
        assert.match(renderRichText(content), /^<p>[^<&]+<\/p>/, post.slug);
      }
    }
    assert.ok(rows(db, `SELECT id FROM _ecommerce_products WHERE id LIKE 'demo_%'`).length >= 2);
  } finally {
    db.close();
  }
});

test('the redemption guards count shipping and exclusive tax in an order\'s totals', () => {
  const db = openDatabase();
  try {
    applyAllMigrations(db);
    db.exec(`INSERT INTO _ecommerce_discount_codes (code, type, value, created_at, updated_at) VALUES ('TENOFF', 'amount', 1000, ${T}, ${T});
      INSERT INTO _ecommerce_gift_cards (id, code_hash, code_suffix, encrypted_code, source, admin_actor, admin_reason, initial_cents, created_at, updated_at)
        VALUES ('card-1', 'hash-1', 'WXYZ', 'sealed', 'admin', 'admin-1', 'Migration test card', 100000, ${T}, ${T});
      INSERT INTO _ecommerce_gift_card_ledger (id, card_id, kind, amount_cents, created_at) VALUES ('gcl-issue', 'card-1', 'issue', 100000, ${T});`);
    // Each order: a 10000 subtotal less a 1000 discount, 1000 store credit and 2000 from the gift card.
    const insertOrder = db.prepare(`INSERT INTO _ecommerce_orders (id, status, items, total_amount, subtotal_amount, discount_code,
      discount_amount, credit_applied, gift_card_id, gift_card_applied, shipping_amount, tax_amount, tax_behavior, created_at, updated_at)
      VALUES (?, 'pending', '[]', ?, 10000, 'TENOFF', 1000, 1000, 'card-1', 2000, ?, ?, ?, ${T}, ${T})`);
    const redeemDiscount = db.prepare(`INSERT INTO _ecommerce_discount_redemptions (id, code, order_id, email_normalized, amount_cents, created_at, updated_at)
      VALUES (?, 'TENOFF', ?, 'shopper@example.com', 1000, ${T}, ${T})`);
    const redeemGiftCard = db.prepare(`INSERT INTO _ecommerce_gift_card_redemptions (id, card_id, order_id, amount_cents, created_at, updated_at)
      VALUES (?, 'card-1', ?, 2000, ${T}, ${T})`);
    const orders = [
      { id: 'no-shipping-or-tax', shipping: 0, tax: 0, behavior: null, total: 6000, balances: true },
      { id: 'exclusive-tax', shipping: 500, tax: 840, behavior: 'exclusive', total: 7340, balances: true },
      { id: 'inclusive-tax', shipping: 500, tax: 800, behavior: 'inclusive', total: 6500, balances: true },
      { id: 'shipping-left-out', shipping: 500, tax: 0, behavior: null, total: 6000, balances: false },
      { id: 'exclusive-tax-left-out', shipping: 500, tax: 840, behavior: 'exclusive', total: 6500, balances: false },
      { id: 'inclusive-tax-added', shipping: 500, tax: 800, behavior: 'inclusive', total: 7300, balances: false },
    ];
    for (const { id, shipping, tax, behavior, total, balances } of orders) {
      insertOrder.run(id, total, shipping, tax, behavior);
      const redemptions = [
        [() => redeemDiscount.run(`dr-${id}`, id), /Discount code is no longer available/],
        [() => redeemGiftCard.run(`gcr-${id}`, id), /Gift card is no longer available/],
      ];
      for (const [redeem, refusal] of redemptions) {
        if (balances) assert.doesNotThrow(redeem, id);
        else assert.throws(redeem, refusal, id);
      }
    }
    assert.deepEqual(rows(db, 'SELECT order_id FROM _ecommerce_discount_redemptions ORDER BY order_id').map(({ order_id }) => order_id),
      ['exclusive-tax', 'inclusive-tax', 'no-shipping-or-tax']);
    assert.equal(row(db, `SELECT balance_cents FROM _ecommerce_gift_cards WHERE id = 'card-1'`).balance_cents, 100000 - 3 * 2000);
    // A redemption moves forward only: reserved to confirmed or cancelled, confirmed to refunded.
    assert.throws(() => db.exec(`UPDATE _ecommerce_gift_card_redemptions SET status = 'refunded' WHERE id = 'gcr-exclusive-tax'`), /Invalid gift card redemption transition/);
    db.exec(`UPDATE _ecommerce_gift_card_redemptions SET status = 'cancelled', updated_at = ${T + 1} WHERE id = 'gcr-exclusive-tax'`);
    assert.equal(row(db, `SELECT balance_cents FROM _ecommerce_gift_cards WHERE id = 'card-1'`).balance_cents, 100000 - 2 * 2000);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('shipping and tax amounts stay valid, a tax reversal is recorded once per reference, and the tax lookups use their indexes', () => {
  const db = openDatabase();
  try {
    applyAllMigrations(db);
    db.exec(`INSERT INTO _ecommerce_orders (id, status, items, total_amount, created_at, updated_at) VALUES ('order-1', 'paid', '[]', 1000, ${T}, ${T})`);
    for (const assignment of ['shipping_amount = -1', 'tax_amount = -1', `tax_behavior = 'included'`, 'credit_applied = -1', 'gift_card_refunded_cents = 1', `fulfillment_status = 'shipped'`]) {
      assert.throws(() => db.exec(`UPDATE _ecommerce_orders SET ${assignment} WHERE id = 'order-1'`), /CHECK constraint failed/, assignment);
    }

    const reverse = db.prepare(`INSERT INTO _ecommerce_tax_reversals (id, order_id, reference, amount, provider_reversal_id, created_at)
      VALUES (?, ?, ?, ?, ?, ${T})`);
    reverse.run('rev-1', 'order-1', 'order-1:reversal:500', 500, 'reversal-1');
    assert.throws(() => reverse.run('rev-2', 'order-1', 'order-1:reversal:500', 500, 'reversal-2'),
      /UNIQUE constraint failed: _ecommerce_tax_reversals\.reference/);
    assert.throws(() => reverse.run('rev-3', 'order-1', 'order-1:reversal:1000', 0, 'reversal-3'), /CHECK constraint failed/);
    assert.throws(() => reverse.run('rev-4', 'order-2', 'order-2:reversal:500', 500, 'reversal-4'), /FOREIGN KEY constraint failed/);
    assert.throws(() => db.exec(`UPDATE _ecommerce_tax_reversals SET tax_sync_attempts = -1`), /CHECK constraint failed/);

    // The lookup for paid orders whose tax transaction is missing repeats the partial index's conditions.
    assert.match(queryPlan(db, `SELECT id FROM _ecommerce_orders
      WHERE status IN ('paid','fulfilled','partially_refunded','refunded') AND tax_calculation_id IS NOT NULL AND tax_transaction_id IS NULL
      ORDER BY created_at LIMIT 10`), /USING INDEX _ecommerce_orders_tax_transaction_missing_idx/);
    assert.match(queryPlan(db, `SELECT r.order_id, r.reference FROM _ecommerce_tax_reversals r JOIN _ecommerce_orders o ON o.id = r.order_id
      WHERE r.provider_reversal_id = '' AND r.created_at < ? ORDER BY r.created_at LIMIT 10`, T + 100),
      /SEARCH r USING INDEX _ecommerce_tax_reversals_unsent_idx \(created_at<\?\)/);
    assert.match(queryPlan(db, `SELECT o.id FROM _ecommerce_orders o WHERE o.status IN ('partially_refunded', 'refunded')
      AND o.tax_transaction_id IS NOT NULL ORDER BY o.created_at LIMIT 10`), /_ecommerce_orders_tax_refunded_idx/);
  } finally {
    db.close();
  }
});

test('an order ships in parcels, takes appended corrections, and the orders queue pages on its indexes', () => {
  const db = openDatabase();
  try {
    applyAllMigrations(db);
    db.exec(`INSERT INTO _ecommerce_orders (id, status, items, total_amount, payment_provider, created_at, updated_at) VALUES
      ('order-parcels', 'partially_refunded', '[]', 9000, 'stripe', ${T}, ${T}),
      ('order-test', 'paid', '[]', 9000, 'admin_test', ${T}, ${T})`);
    const ship = (id, orderId, completes) => db.exec(`INSERT INTO _ecommerce_fulfillments
      (id, order_id, completes_order, admin_actor, note, created_at) VALUES ('${id}', '${orderId}', ${completes}, 'admin-1', 'Parcel handed over', ${T})`);
    const state = () => row(db, `SELECT status, fulfillment_status, updated_at FROM _ecommerce_orders WHERE id = 'order-parcels'`);
    ship('parcel-1', 'order-parcels', 0);
    assert.deepEqual(state(), { status: 'partially_refunded', fulfillment_status: 'partially_fulfilled', updated_at: T + 1 });
    ship('parcel-2', 'order-parcels', 1);
    assert.deepEqual(state(), { status: 'partially_refunded', fulfillment_status: 'fulfilled', updated_at: T + 2 });
    assert.throws(() => ship('parcel-3', 'order-parcels', 0), /Order is not ready for fulfillment/);
    assert.throws(() => ship('test-parcel', 'order-test', 1), /Order is not ready for fulfillment/);
    // A correction names a shipment of its order and restates the carrier or tracking number with a reason.
    assert.throws(() => db.exec(`INSERT INTO _ecommerce_fulfillments (id, order_id, kind, corrects_id, completes_order, admin_actor, note, created_at)
      VALUES ('fix-1', 'order-parcels', 'correction', 'parcel-1', 0, 'admin-1', 'Label was reprinted', ${T})`), /Shipment cannot be corrected/);
    db.exec(`INSERT INTO _ecommerce_fulfillments (id, order_id, kind, corrects_id, completes_order, admin_actor, carrier, tracking_number, note, created_at)
      VALUES ('fix-1', 'order-parcels', 'correction', 'parcel-1', 0, 'admin-1', 'USPS', 'TRACK-2', 'Label was reprinted', ${T})`);
    // A shipment names no shipment to correct, and only a shipment completes an order.
    db.exec(`INSERT INTO _ecommerce_orders (id, status, items, total_amount, payment_provider, created_at, updated_at) VALUES ('order-more', 'paid', '[]', 9000, 'stripe', ${T}, ${T})`);
    assert.throws(() => db.exec(`INSERT INTO _ecommerce_fulfillments (id, order_id, kind, corrects_id, completes_order, admin_actor, note, created_at)
      VALUES ('bad-1', 'order-more', 'shipment', 'parcel-1', 1, 'admin-1', 'Parcel handed over', ${T})`), /CHECK constraint failed/);
    assert.throws(() => db.exec(`INSERT INTO _ecommerce_fulfillments (id, order_id, kind, corrects_id, completes_order, admin_actor, carrier, tracking_number, note, created_at)
      VALUES ('fix-2', 'order-parcels', 'correction', 'parcel-1', 1, 'admin-1', 'USPS', 'TRACK-3', 'Reprinted label again', ${T})`), /CHECK constraint failed/);

    // The orders queue keeps its partial indexes and pages without sorting.
    const awaiting = `status IN ('paid','partially_refunded') AND fulfillment_status <> 'fulfilled'
      AND COALESCE(payment_provider, 'stripe') <> 'admin_test'`;
    assert.match(queryPlan(db, `SELECT COUNT(*) AS count FROM _ecommerce_orders WHERE ${awaiting}`), /_ecommerce_orders_awaiting_idx/);
    assert.equal(queryPlan(db, `SELECT id FROM _ecommerce_orders WHERE ${awaiting} ORDER BY created_at ASC, id ASC LIMIT ?`, 51),
      'SCAN _ecommerce_orders USING INDEX _ecommerce_orders_awaiting_idx');
    assert.equal(queryPlan(db, `SELECT id FROM _ecommerce_orders WHERE status NOT IN ('pending','cancelled','draft')
      AND COALESCE(payment_provider, 'stripe') <> 'admin_test' ORDER BY created_at DESC, id DESC LIMIT ?`, 51),
      'SCAN _ecommerce_orders USING INDEX _ecommerce_orders_recent_idx');
    assert.match(queryPlan(db, `SELECT id FROM _ecommerce_orders WHERE lower(customer_email) = ?`, 'a@example.com'), /_ecommerce_orders_customer_email_idx/);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('gift cards keep their funding, links and review rules', () => {
  const db = seeded();
  try {
    issueCards(db);
    assert.deepEqual(rows(db, `SELECT c.id, c.status, c.balance_cents, c.replaces_purchase_id, c.held_for_review,
        (SELECT SUM(amount_cents) FROM _ecommerce_gift_card_ledger l WHERE l.card_id = c.id) AS ledger
      FROM _ecommerce_gift_cards c ORDER BY c.id`), [
      { id: 'gift-admin', status: 'active', balance_cents: 2500, replaces_purchase_id: null, held_for_review: 0, ledger: 2500 },
      { id: 'gift-held', status: 'suspended', balance_cents: 10000, replaces_purchase_id: null, held_for_review: 0, ledger: 10000 },
      { id: 'gift-issued', status: 'active', balance_cents: 3000, replaces_purchase_id: null, held_for_review: 0, ledger: 3000 },
      { id: 'gift-new', status: 'active', balance_cents: 8000, replaces_purchase_id: null, held_for_review: 0, ledger: 8000 },
      { id: 'gift-refunded', status: 'void', balance_cents: 0, replaces_purchase_id: null, held_for_review: 0, ledger: 0 },
    ]);
    // A card is funded once, by a confirmed purchase or a named administrator.
    assert.throws(() => db.exec(`INSERT INTO _ecommerce_gift_card_ledger (id, card_id, kind, amount_cents, created_at) VALUES ('gcl-again', 'gift-new', 'issue', 8000, ${T})`),
      /Gift card funding is not confirmed/);
    assert.throws(() => db.exec(`INSERT INTO _ecommerce_gift_card_ledger (id, card_id, kind, amount_cents, created_at) VALUES ('gcl-positive-reserve', 'gift-new', 'reserve', 1, ${T})`),
      /CHECK constraint failed/, 'a reservation takes from the balance');
    assert.throws(() => db.exec(`UPDATE _ecommerce_gift_cards SET balance_cents = initial_cents + 1 WHERE id = 'gift-new'`), /CHECK constraint failed/);

    // A card replaces only an existing purchase, and only an administrator's card replaces one; no
    // more of a refund can be taken off the cards than was refunded.
    assert.throws(() => db.exec(`UPDATE _ecommerce_gift_cards SET replaces_purchase_id = 'gp-held' WHERE id = 'gift-new'`), /CHECK constraint failed/);
    assert.throws(() => db.exec(`UPDATE _ecommerce_gift_cards SET replaces_purchase_id = 'gp-missing' WHERE id = 'gift-issued'`), /FOREIGN KEY constraint failed/);
    db.exec(`UPDATE _ecommerce_gift_cards SET replaces_purchase_id = 'gp-held' WHERE id = 'gift-issued'`);
    assert.throws(() => db.exec(`UPDATE _ecommerce_gift_card_purchases SET refund_adjusted_cents = 3001 WHERE id = 'gp-held'`), /CHECK constraint failed/);
    db.exec(`UPDATE _ecommerce_gift_card_purchases SET refund_adjusted_cents = 3000 WHERE id = 'gp-held'`);
    assert.throws(() => db.exec(`UPDATE _ecommerce_gift_cards SET held_for_review = 2 WHERE id = 'gift-held'`), /CHECK constraint failed/);
    assert.throws(() => db.exec(`INSERT INTO _ecommerce_gift_card_reviews (id, purchase_id, card_id, outcome, refunded_cents, adjustment_cents, admin_actor, reason, created_at)
      VALUES ('review-1', 'gp-held', 'gift-held', 'reinstate', 3000, 3000, ' ', 'Partial refund approved', ${T})`), /CHECK constraint failed/);
    db.exec(`INSERT INTO _ecommerce_gift_card_reviews (id, purchase_id, card_id, outcome, refunded_cents, adjustment_cents, admin_actor, reason, created_at)
      VALUES ('review-1', 'gp-held', 'gift-held', 'reinstate', 3000, 3000, 'admin-1', 'Partial refund approved', ${T})`);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('refund rows, disputes and restocks are checked', () => {
  const db = seeded();
  try {
    db.exec(`
      INSERT INTO _ecommerce_components (id, sku, name, quantity, created_at, updated_at) VALUES ('comp-lens', 'LENS-1', 'Lens pair', 4, ${T}, ${T});
      INSERT INTO _ecommerce_orders (id, status, items, total_amount, subtotal_amount, payment_provider, payment_intent_id, provider_refunded_cents, created_at, updated_at) VALUES
        ('order-paid', 'paid', '[]', 12000, 12000, 'stripe', 'pi_paid', 0, ${T}, ${T}),
        ('order-partly', 'partially_refunded', '[]', 12000, 12000, 'stripe', 'pi_partly', 3000, ${T}, ${T}),
        ('order-cancelled', 'cancelled', '[]', 12000, 12000, 'stripe', NULL, 0, ${T}, ${T});
      INSERT INTO _ecommerce_inventory_reservations (id, order_id, target_type, target_id, quantity, released_at) VALUES
        ('res-paid', 'order-paid', 'stock', 'stock-1', 1, NULL),
        ('res-cancelled', 'order-cancelled', 'product', 'prod-1', 1, ${T + 5});
      INSERT INTO _ecommerce_component_reservations (id, order_id, component_id, quantity, released_at) VALUES
        ('cres-paid', 'order-paid', 'comp-lens', 1, NULL);
    `);
    assert.throws(() => db.exec(`INSERT INTO _ecommerce_inventory_reservations (id, order_id, target_type, target_id, quantity) VALUES ('res-bad', 'order-paid', 'bundle', 'x', 1)`), /CHECK constraint failed/);
    assert.throws(() => db.exec(`UPDATE _ecommerce_components SET quantity = -1 WHERE id = 'comp-lens'`), /CHECK constraint failed/);
    assert.throws(() => db.exec(`UPDATE _ecommerce_stocks SET quantity = -1 WHERE id = 'stock-1'`), /Insufficient variant value stock/);
    assert.throws(() => db.exec(`UPDATE _ecommerce_products SET inventory_quantity = -1 WHERE id = 'prod-1'`), /Insufficient product stock/);

    // Refund rows are positive amounts of an existing order; a row without a known date is allowed.
    db.exec(`INSERT INTO _ecommerce_provider_refunds (id, order_id, provider, provider_refund_id, amount_cents, created_at)
      VALUES ('prf-partly', 'order-partly', 'stripe', NULL, 9000, NULL)`);
    assert.throws(() => db.exec(`INSERT INTO _ecommerce_provider_refunds (id, order_id, provider, amount_cents, created_at)
      VALUES ('prf-zero', 'order-partly', 'stripe', 0, ${T})`), /CHECK constraint failed/);
    assert.throws(() => db.exec(`INSERT INTO _ecommerce_provider_refunds (id, order_id, provider, amount_cents, created_at)
      VALUES ('prf-missing', 'order-missing', 'stripe', 100, ${T})`), /FOREIGN KEY constraint failed/);

    // A dispute names exactly one order or gift card purchase, and the fulfillment guard refuses a disputed order.
    const dispute = (id, orderId, purchaseId) => db.exec(`INSERT INTO _ecommerce_disputes
      (id, provider, order_id, gift_card_purchase_id, amount_cents, currency, reason, status, status_before, created_at, updated_at)
      VALUES ('${id}', 'stripe', ${orderId ? `'${orderId}'` : 'NULL'}, ${purchaseId ? `'${purchaseId}'` : 'NULL'}, 12000, 'usd', 'fraudulent', 'needs_response', 'paid', ${T}, ${T})`);
    dispute('dp-order', 'order-paid', null);
    dispute('dp-purchase', null, 'gp-held');
    assert.throws(() => dispute('dp-neither', null, null), /CHECK constraint failed/);
    assert.throws(() => dispute('dp-both', 'order-paid', 'gp-held'), /CHECK constraint failed/);
    db.exec(`UPDATE _ecommerce_orders SET status = 'disputed' WHERE id = 'order-paid'`);
    assert.throws(() => db.exec(`INSERT INTO _ecommerce_fulfillments (id, order_id, admin_actor, note, created_at)
      VALUES ('ful-disputed', 'order-paid', 'admin-1', 'Packed and shipped', ${T})`), /Order is not ready for fulfillment/);
    assert.match(queryPlan(db, `SELECT id FROM _ecommerce_disputes WHERE order_id = ? AND order_id IS NOT NULL`, 'order-paid'), /_ecommerce_disputes_order_idx/);

    // A reservation row is returned to stock once, by an administrator who gives a reason.
    const restock = (id, reservationId, actor = 'admin-1', reason = 'Parcel came back unopened') => db.exec(`INSERT INTO _ecommerce_restocks
      (id, order_id, reservation_type, reservation_id, target_type, target_id, quantity, admin_actor, reason, created_at)
      VALUES ('${id}', 'order-partly', 'component', '${reservationId}', 'component', 'comp-lens', 1, '${actor}', '${reason}', ${T})`);
    restock('rst-1', 'cres-paid');
    assert.throws(() => restock('rst-2', 'cres-paid'), /UNIQUE constraint failed/);
    assert.throws(() => restock('rst-3', 'cres-other', ' '), /CHECK constraint failed/);
    assert.throws(() => restock('rst-4', 'cres-other', 'admin-1', 'short'), /CHECK constraint failed/);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('reconciliation state is counted and indexed, and a decision names one record, a known action and its administrator', () => {
  const db = seeded();
  try {
    db.exec(`INSERT INTO _ecommerce_gift_card_purchases (id, buyer_email, amount_cents, status, provider_session_id, access_token_hash, created_at, updated_at)
      VALUES ('gp-pending', 'buyer@example.com', 5000, 'pending', 'cs_test_gift', 'hash-pending', ${T}, ${T})`);
    const untried = { reconcile_attempts: 0, reconcile_last_at: null, reconcile_last_error: null, reconcile_review_at: null };
    assert.deepEqual(row(db, `SELECT reconcile_attempts, reconcile_last_at, reconcile_last_error, reconcile_review_at FROM _ecommerce_orders WHERE id = 'order-pending'`), untried);

    // Pending rows by age; a refund's payment rows and revenue reports by order; checkout resume by session;
    // better-auth's newest verification row of an identifier, and its delete.
    assert.match(queryPlan(db, `SELECT id FROM _ecommerce_orders WHERE status = 'pending' AND created_at < ? ORDER BY created_at LIMIT ?`, T, 10),
      /SEARCH _ecommerce_orders USING INDEX _ecommerce_orders_pending_idx \(created_at<\?\)/);
    assert.match(queryPlan(db, `SELECT id FROM _ecommerce_gift_card_purchases WHERE status = 'pending' AND created_at < ?`, T),
      /SEARCH _ecommerce_gift_card_purchases USING (COVERING )?INDEX _ecommerce_gift_card_purchases_status_created_idx \(status=\? AND created_at<\?\)/);
    assert.match(queryPlan(db, `UPDATE _ecommerce_payments SET status = 'refunded' WHERE order_id = ? AND provider = 'stripe'`, 'order-1'),
      /SEARCH _ecommerce_payments USING INDEX _ecommerce_payments_order_idx \(order_id=\?\)/);
    assert.match(queryPlan(db, `SELECT o.id, MIN(p.created_at) AS paid_at FROM _ecommerce_orders o
      JOIN _ecommerce_payments p ON p.order_id = o.id
      WHERE o.status IN ('paid', 'fulfilled', 'partially_refunded', 'refunded') GROUP BY o.id`),
      /SEARCH p USING INDEX _ecommerce_payments_order_idx \(order_id=\?\)/);
    assert.match(queryPlan(db, `SELECT id FROM _ecommerce_orders WHERE checkout_session_id = ?`, 'cs_test_pending'),
      /SEARCH _ecommerce_orders USING INDEX _ecommerce_orders_checkout_session_idx \(checkout_session_id=\?\)/);
    const newest = queryPlan(db, `SELECT id, value FROM galaxy_auth_verification WHERE identifier = ? ORDER BY created_at DESC LIMIT 1`, 'reset:1');
    assert.match(newest, /SEARCH galaxy_auth_verification USING INDEX galaxy_auth_verification_identifier_idx \(identifier=\?\)/);
    assert.doesNotMatch(newest, /TEMP B-TREE/, 'the index gives the newest row first');
    assert.match(queryPlan(db, `DELETE FROM galaxy_auth_verification WHERE identifier = ?`, 'reset:1'),
      /SEARCH galaxy_auth_verification USING INDEX galaxy_auth_verification_identifier_idx \(identifier=\?\)/);
    assert.match(queryPlan(db, `SELECT id FROM _ecommerce_email_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 10`, T),
      /_ecommerce_email_deliveries_due_idx/);

    // The reconciliation queries find the pending rows.
    const due = T + 3600;
    assert.deepEqual(rows(db, `SELECT id FROM _ecommerce_orders
      WHERE status = 'pending' AND created_at < ? AND (? = 1 OR COALESCE(payment_provider, 'stripe') <> 'admin_test')
      ORDER BY created_at LIMIT ?`, due, 0, 10), [{ id: 'order-pending' }]);
    assert.deepEqual(rows(db, `SELECT id FROM _ecommerce_gift_card_purchases
      WHERE status = 'pending' AND provider_session_id IS NOT NULL AND created_at < ? ORDER BY created_at LIMIT ?`, due, 10), [{ id: 'gp-pending' }]);
    db.prepare(`UPDATE _ecommerce_orders SET reconcile_attempts = reconcile_attempts + 1, reconcile_last_at = ?, reconcile_last_error = ?, reconcile_review_at = ?
      WHERE id = ? AND status = 'pending' AND reconcile_review_at IS NULL`).run(T + 60, 'session_missing', T + 60, 'order-pending');
    assert.deepEqual(row(db, `SELECT reconcile_attempts, reconcile_last_error, reconcile_review_at FROM _ecommerce_orders WHERE id = 'order-pending'`),
      { reconcile_attempts: 1, reconcile_last_error: 'session_missing', reconcile_review_at: T + 60 });
    assert.throws(() => db.exec(`UPDATE _ecommerce_orders SET reconcile_attempts = -1 WHERE id = 'order-pending'`), /CHECK constraint failed/);
    assert.throws(() => db.exec(`UPDATE _ecommerce_gift_card_purchases SET reconcile_attempts = -1 WHERE id = 'gp-pending'`), /CHECK constraint failed/);

    // A decision names exactly one existing order or purchase, a known action, the administrator and a
    // reason; only a release records how a completed checkout's payment was returned.
    const decide = db.prepare(`INSERT INTO _ecommerce_reconcile_decisions
      (id, order_id, purchase_id, action, failure, payment_returned, admin_actor, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    decide.run('rcd-retry', 'order-pending', null, 'retry', 'session_missing', null, 'admin-1', 'Stripe restored it', T + 80);
    decide.run('rcd-release', null, 'gp-pending', 'release', 'payment_mismatch', 'refunded', 'admin-1', 'Refunded in Stripe', T + 90);
    for (const [values, error] of [
      [['rcd-both', 'order-pending', 'gp-pending', 'retry', null, null, 'admin-1', 'Two records at once'], /CHECK constraint failed/],
      [['rcd-none', null, null, 'retry', null, null, 'admin-1', 'No record at all'], /CHECK constraint failed/],
      [['rcd-action', 'order-pending', null, 'archive', null, null, 'admin-1', 'Unknown action here'], /CHECK constraint failed/],
      [['rcd-return', 'order-pending', null, 'retry', null, 'refunded', 'admin-1', 'A retry returns nothing'], /CHECK constraint failed/],
      [['rcd-how', 'order-pending', null, 'release', null, 'maybe', 'admin-1', 'An unknown return way'], /CHECK constraint failed/],
      [['rcd-actor', 'order-pending', null, 'retry', null, null, '  ', 'Nobody decided this'], /CHECK constraint failed/],
      [['rcd-reason', 'order-pending', null, 'retry', null, null, 'admin-1', ' short  '], /CHECK constraint failed/],
      [['rcd-missing', 'order-missing', null, 'retry', null, null, 'admin-1', 'No such order exists'], /FOREIGN KEY constraint failed/],
    ]) assert.throws(() => decide.run(...values, T + 95), error, values[0]);
    assert.deepEqual(rows(db, 'SELECT id FROM _ecommerce_reconcile_decisions ORDER BY created_at'), [{ id: 'rcd-retry' }, { id: 'rcd-release' }]);
    assert.match(queryPlan(db, `SELECT id FROM _ecommerce_reconcile_decisions WHERE order_id = ? ORDER BY created_at`, 'order-pending'), /_ecommerce_reconcile_decisions_order_idx/);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('the tax passes read their indexes and count failed attempts with a backoff', () => {
  const db = openDatabase();
  try {
    applyAllMigrations(db);
    // A paid order whose tax transaction is missing, and a partly refunded one with a reversal sent,
    // one whose request failed, and a refund not reversed yet.
    const insertOrder = db.prepare(`INSERT INTO _ecommerce_orders (id, status, items, total_amount, payment_provider,
      tax_amount, tax_behavior, tax_calculation_id, tax_transaction_id, provider_refunded_cents, created_at, updated_at)
      VALUES (?, ?, '[]', 13200, 'stripe', 1200, 'exclusive', ?, ?, ?, ?, ?)`);
    insertOrder.run('order-tax-missing', 'paid', 'taxcalc_1', null, 0, T, T);
    insertOrder.run('order-tax-refunded', 'partially_refunded', 'taxcalc_2', 'tax_2', 8000, T + 10, T + 30);
    const recordReversal = db.prepare(`INSERT INTO _ecommerce_tax_reversals
      (id, order_id, reference, amount, provider_reversal_id, created_at)
      SELECT ?, ?, ?, ?, '', ? WHERE (SELECT COALESCE(SUM(amount), 0) FROM _ecommerce_tax_reversals WHERE order_id = ?) = ?
      ON CONFLICT(reference) DO NOTHING`);
    const sendReversal = db.prepare(`UPDATE _ecommerce_tax_reversals SET provider_reversal_id = ? WHERE reference = ? AND provider_reversal_id = ''`);
    recordReversal.run('taxrev-sent', 'order-tax-refunded', 'order-tax-refunded:reversal:3000', 3000, T + 20, 'order-tax-refunded', 0);
    sendReversal.run('taxrev_1', 'order-tax-refunded:reversal:3000');
    recordReversal.run('taxrev-unsent', 'order-tax-refunded', 'order-tax-refunded:reversal:5000', 2000, T + 30, 'order-tax-refunded', 3000);

    // Paid orders without a transaction, unsent reversals and refunded orders with a transaction each come from an index.
    const target = `CASE WHEN o.status = 'refunded' THEN o.gift_card_applied + o.total_amount
      ELSE MIN(o.gift_card_applied + o.total_amount, o.provider_refunded_cents + o.gift_card_refunded_cents) END`;
    const reversed = '(SELECT COALESCE(SUM(r.amount), 0) FROM _ecommerce_tax_reversals r WHERE r.order_id = o.id)';
    const backoff = (alias) => ({
      due: `(${alias}tax_sync_last_at IS NULL OR ${alias}tax_sync_last_at <= ? - MIN(21600, 60 << MIN(${alias}tax_sync_attempts, 9)))`,
      order: `COALESCE(${alias}tax_sync_last_at, 0), ${alias}created_at, ${alias}id`,
    });
    const missing = `SELECT id FROM _ecommerce_orders WHERE status IN ('paid', 'fulfilled', 'partially_refunded', 'refunded')
      AND tax_calculation_id IS NOT NULL AND tax_transaction_id IS NULL`;
    const unsent = `SELECT r.order_id, r.reference, r.amount, o.payment_provider, o.tax_transaction_id
      FROM _ecommerce_tax_reversals r JOIN _ecommerce_orders o ON o.id = r.order_id WHERE r.provider_reversal_id = '' AND r.created_at < ?`;
    const unreversed = `SELECT o.id FROM _ecommerce_orders o WHERE o.status IN ('partially_refunded', 'refunded')
      AND o.tax_transaction_id IS NOT NULL AND ${target} > ${reversed}`;
    const passes = [
      [`${missing} AND ${backoff('').due} ORDER BY ${backoff('').order} LIMIT ?`, [T + 100, 10],
        /SEARCH _ecommerce_orders USING INDEX _ecommerce_orders_tax_transaction_missing_idx \(status=\?\)/, [{ id: 'order-tax-missing' }]],
      [`${unsent} AND ${backoff('r.').due} ORDER BY ${backoff('r.').order} LIMIT ?`, [T + 100, T + 100, 10],
        /SEARCH r USING INDEX _ecommerce_tax_reversals_unsent_idx \(created_at<\?\)/,
        [{ order_id: 'order-tax-refunded', reference: 'order-tax-refunded:reversal:5000', amount: 2000, payment_provider: 'stripe', tax_transaction_id: 'tax_2' }]],
      [`${unreversed} AND ${backoff('o.').due} ORDER BY ${backoff('o.').order} LIMIT ?`, [T + 100, 10],
        /SCAN o USING INDEX _ecommerce_orders_tax_refunded_idx/, [{ id: 'order-tax-refunded' }]],
    ];
    for (const [sql, params, plan, found] of passes) {
      assert.match(queryPlan(db, sql, ...params), plan, sql);
      assert.deepEqual(rows(db, sql, ...params), found, sql);
    }

    // Failed attempts are counted and cleared; a count is never negative; a counted failure waits.
    db.prepare(`UPDATE _ecommerce_orders SET tax_sync_attempts = tax_sync_attempts + 1, tax_sync_last_at = ?, tax_sync_last_error = ?
      WHERE id = ? AND tax_transaction_id IS NULL`).run(T + 100, 'provider_unavailable', 'order-tax-missing');
    db.prepare(`UPDATE _ecommerce_tax_reversals SET tax_sync_attempts = tax_sync_attempts + 1, tax_sync_last_at = ?, tax_sync_last_error = ?
      WHERE reference = ? AND provider_reversal_id = ''`).run(T + 100, 'failed', 'order-tax-refunded:reversal:5000');
    assert.deepEqual(rows(db, `${missing} AND ${backoff('').due}`, T + 219), []);
    assert.deepEqual(rows(db, `${missing} AND ${backoff('').due}`, T + 220), [{ id: 'order-tax-missing' }]);
    assert.deepEqual(rows(db, `${unsent} AND ${backoff('r.').due}`, T + 1000, T + 219), []);
    for (const table of ['_ecommerce_orders', '_ecommerce_tax_reversals']) {
      assert.throws(() => db.exec(`UPDATE ${table} SET tax_sync_attempts = -1`), /CHECK constraint failed/, table);
    }
    db.prepare(`UPDATE _ecommerce_orders SET tax_transaction_id = ? WHERE id = ? AND tax_transaction_id IS NULL`).run('tax_1', 'order-tax-missing');
    sendReversal.run('taxrev_2', 'order-tax-refunded:reversal:5000');
    recordReversal.run('taxrev-new', 'order-tax-refunded', 'order-tax-refunded:reversal:8000', 3000, T + 200, 'order-tax-refunded', 5000);
    sendReversal.run('taxrev_3', 'order-tax-refunded:reversal:8000');
    for (const [sql, params] of passes) assert.deepEqual(rows(db, sql, ...params), [], sql);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('one email per kind and subject, and claim links only for an active card of their purchase', () => {
  const db = seeded();
  try {
    issueCards(db);
    db.exec(`INSERT INTO _ecommerce_orders (id, status, items, total_amount, payment_provider, customer_email, created_at, updated_at)
      VALUES ('order-paid', 'paid', '[]', 9000, 'stripe', 'buyer@example.com', ${T}, ${T})`);
    db.exec(`INSERT INTO _ecommerce_fulfillments (id, order_id, kind, completes_order, admin_actor, carrier, tracking_number, note, created_at)
      VALUES ('ful-1', 'order-paid', 'shipment', 1, 'admin-1', 'UPS', '1Z999', 'Parcel handed over', ${T + 10})`);
    assert.equal(row(db, `SELECT fulfillment_status FROM _ecommerce_orders WHERE id = 'order-paid'`).fulfillment_status, 'fulfilled');

    // One email per kind and subject; a sent email has its time, and only known kinds are recorded.
    const deliver = (id, kind = 'order_confirmation', subject = 'order-paid', conflict = '') => db.exec(`INSERT INTO
      _ecommerce_email_deliveries (id, kind, subject_id, next_attempt_at, created_at) VALUES ('${id}', '${kind}', '${subject}', ${T}, ${T})${conflict}`);
    deliver('mail-1');
    assert.throws(() => deliver('mail-2'), /UNIQUE constraint failed/);
    deliver('mail-2', 'order_confirmation', 'order-paid', ' ON CONFLICT (kind, subject_id) DO NOTHING');
    deliver('mail-3', 'shipment', 'ful-1');
    assert.throws(() => deliver('mail-4', 'newsletter'), /CHECK constraint failed/);
    assert.deepEqual(row(db, `SELECT status, attempts, last_error, claimed_at, sent_at FROM _ecommerce_email_deliveries WHERE id = 'mail-1'`),
      { status: 'pending', attempts: 0, last_error: null, claimed_at: null, sent_at: null });
    assert.throws(() => db.exec(`UPDATE _ecommerce_email_deliveries SET status = 'sent' WHERE id = 'mail-1'`), /CHECK constraint failed/);
    db.exec(`UPDATE _ecommerce_email_deliveries SET status = 'sent', sent_at = ${T + 20} WHERE id = 'mail-1'`);

    // A claim link is made only for an active card of its own purchase, with an expiry after its
    // creation, and a resend names who and why.
    const link = (id, card, purchase, extra = { created_by: null, reason: null }, expiresAt = T + 604800) => db.prepare(`INSERT INTO
      _ecommerce_gift_card_claims (id, token_hash, purchase_id, card_id, expires_at, created_at, created_by, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, `hash-${id}`, purchase, card, expiresAt, T, extra.created_by, extra.reason);
    assert.throws(() => link('claim-suspended', 'gift-held', 'gp-held'), /Gift card cannot be claimed/);
    assert.throws(() => link('claim-other', 'gift-new', 'gp-held'), /Gift card cannot be claimed/);
    assert.throws(() => link('claim-admin', 'gift-admin', 'gp-new'), /Gift card cannot be claimed/);
    link('claim-1', 'gift-new', 'gp-new');
    assert.throws(() => link('claim-2', 'gift-new', 'gp-new', { created_by: 'admin-1', reason: null }), /CHECK constraint failed/);
    assert.throws(() => link('claim-3', 'gift-new', 'gp-new', { created_by: 'admin-1', reason: 'Lost' }), /CHECK constraint failed/);
    assert.throws(() => link('claim-4', 'gift-new', 'gp-new', undefined, T), /CHECK constraint failed/);
    link('claim-5', 'gift-new', 'gp-new', { created_by: 'admin-1', reason: 'Buyer lost the email' });
    assert.throws(() => db.prepare(`INSERT INTO _ecommerce_gift_card_claims (id, token_hash, purchase_id, card_id, expires_at, created_at)
      VALUES ('claim-6', 'hash-claim-1', 'gp-new', 'gift-new', ${T + 10}, ${T})`).run(), /UNIQUE constraint failed/);
    // A replacement card of the purchase can be claimed too.
    db.exec(`INSERT INTO _ecommerce_gift_cards
      (id,code_hash,code_suffix,encrypted_code,source,admin_actor,admin_reason,replaces_purchase_id,initial_cents,balance_cents,currency,status,created_at,updated_at)
      VALUES ('gift-replacement','code-replacement','FFFF','000000000000000000000000:55','admin','admin-1','Replacement card','gp-new',5000,0,'usd','active',${T},${T})`);
    link('claim-7', 'gift-replacement', 'gp-new');
    assertIntegrity(db);
  } finally {
    db.close();
  }
});
