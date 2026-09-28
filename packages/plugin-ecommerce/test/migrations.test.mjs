import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { is } from 'drizzle-orm';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { assembleMigrations, listMigrationSources } from 'talisman-cms/migrations';
import * as pluginSchema from '../dist/schema.js';
import { T, applyMigration, assertIntegrity, fullSchema, migrationFileNames, migrationSources, openDatabase, outline, row, rows,
  seeds, tableNames } from './helpers/migrations.mjs';

// The plugin ships 0025 to 0030 in its drizzle/; the core's drizzle/ holds 0000 to 0024, which also
// created the commerce tables of their time (0019 changes both auth and commerce tables, and a file
// name is fixed once a database has applied it). `wrangler d1 migrations apply` reads one folder per
// binding, so the integration copies both sets into one; this test builds that folder the same way and
// applies it as wrangler does, to a fresh database and to ones that earlier releases migrated.
const pluginDir = new URL('../drizzle/', import.meta.url);
const pluginJournal = JSON.parse(readFileSync(new URL('meta/_journal.json', pluginDir), 'utf8'));
const coreJournal = JSON.parse(readFileSync(new URL('../../talisman-cms/drizzle/meta/_journal.json', import.meta.url), 'utf8'));
const tags = migrationFileNames().map((name) => name.slice(0, -'.sql'.length));
const coreTags = coreJournal.entries.map((entry) => entry.tag);

// The folder a site's `migrations_dir` points at, built as the integration builds it.
const assembled = mkdtempSync(join(tmpdir(), 'talisman-migrations-'));
assembleMigrations({ sources: migrationSources, outDir: assembled });
after(() => rmSync(assembled, { recursive: true, force: true }));

/** Apply the migrations from `from` through `to` (inclusive), running `after[tag]` once each is applied. */
function migrate(db, { from = tags[0], to = tags.at(-1), after: hooks = {} } = {}) {
  for (const tag of tags.slice(tags.indexOf(from), tags.indexOf(to) + 1)) {
    applyMigration(db, tag);
    hooks[tag]?.(db);
  }
}

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

/** The schema a fresh install gets: the assembled folder applied by wrangler to an empty database. */
function freshSchema() {
  const db = openDatabase();
  try {
    applyFolder(db, assembled);
    return fullSchema(db);
  } finally {
    db.close();
  }
}

// The one sequence a database applied before the plugin shipped its own files, and applies today.
const ALL_MIGRATIONS = [
  '0000_skinny_odin.sql',
  '0001_abandoned_shotgun.sql',
  '0002_flowery_midnight.sql',
  '0003_content_versioning.sql',
  '0004_ecommerce_plugin.sql',
  '0005_variant_value_images.sql',
  '0006_media_metadata.sql',
  '0007_local_auth.sql',
  '0008_shared_components.sql',
  '0009_entry_read_indexes.sql',
  '0010_checkout_inventory.sql',
  '0011_order_payment_provider.sql',
  '0012_customer_accounts.sql',
  '0013_referrals_and_credit.sql',
  '0014_promotions.sql',
  '0015_gift_cards.sql',
  '0016_verified_customer_sessions.sql',
  '0017_commerce_fulfillment.sql',
  '0018_entry_revision_integrity.sql',
  '0019_shared_customer_identity.sql',
  '0020_revision_baseline_and_globals.sql',
  '0021_entry_draft_slug.sql',
  '0022_wrap_non_object_globals.sql',
  '0023_published_slug_unique.sql',
  '0024_shopper_sign_in_tokens.sql',
  '0025_order_shipping_and_tax.sql',
  '0026_order_fulfillment_status.sql',
  '0027_gift_card_review.sql',
  '0028_provider_refunds_and_disputes.sql',
  '0029_commerce_reconcile_backoff.sql',
  '0030_commerce_order_emails.sql',
];
const PLUGIN_MIGRATIONS = ALL_MIGRATIONS.slice(25);

test('the core and the plugin together ship the sequence 0000 to 0030, once each, in wrangler order', () => {
  const files = listMigrationSources(migrationSources);
  assert.deepEqual(files.map((file) => file.name), ALL_MIGRATIONS);
  assert.deepEqual(files.map((file) => file.source), [
    ...ALL_MIGRATIONS.slice(0, 25).map(() => 'talisman-cms'),
    ...PLUGIN_MIGRATIONS.map(() => '@talisman-cms/plugin-ecommerce'),
  ]);
  // The assembled folder holds exactly those files, plus the record of who ships each.
  assert.deepEqual(readdirSync(assembled).filter((name) => name.endsWith('.sql')).sort(wranglerOrder), ALL_MIGRATIONS);
  assert.deepEqual(JSON.parse(readFileSync(join(assembled, 'sources.json'), 'utf8')).map(({ name }) => name), ALL_MIGRATIONS);
  for (const name of ALL_MIGRATIONS) {
    const source = files.find((file) => file.name === name);
    assert.equal(readFileSync(join(assembled, name), 'utf8'), readFileSync(source.path, 'utf8'), name);
  }

  // The plugin journal lists its files once, in order, and the core's ends where the plugin's begins.
  assert.deepEqual(readdirSync(pluginDir).filter((name) => name.endsWith('.sql')).sort(), PLUGIN_MIGRATIONS);
  assert.deepEqual(pluginJournal.entries.map((entry) => `${entry.tag}.sql`), PLUGIN_MIGRATIONS);
  pluginJournal.entries.forEach((entry, index) => {
    assert.equal(entry.idx, index, `${entry.tag}: idx`);
    assert.match(entry.tag, /^\d{4}_[a-z0-9_]+$/);
    if (index > 0) assert.ok(entry.when > pluginJournal.entries[index - 1].when, `${entry.tag}: when is not after the previous entry`);
  });
  assert.equal(coreTags.at(-1), '0024_shopper_sign_in_tokens');
  assert.ok(pluginJournal.entries[0].when > coreJournal.entries.at(-1).when);
});

test('a fresh database gets the schema the plugin queries', () => {
  const db = openDatabase();
  try {
    assert.deepEqual(applyFolder(db, assembled), ALL_MIGRATIONS);
    assertIntegrity(db);
    assert.deepEqual(fullSchema(db), freshSchema());

    // The plugin's Drizzle schema must only name columns the migrations create.
    const columns = Object.fromEntries(tableNames(db).map((table) => [table, new Set(rows(db, 'SELECT name FROM pragma_table_info(?)', table).map(({ name }) => name))]));
    const tables = Object.values(pluginSchema).filter((value) => is(value, SQLiteTable));
    assert.ok(tables.length >= 10);
    for (const table of tables) {
      const { name, columns: declared } = getTableConfig(table);
      assert.ok(columns[name], `${name} is declared in src/schema.ts but no migration creates it`);
      for (const column of declared) assert.ok(columns[name].has(column.name), `${name}.${column.name} is declared but no migration creates it`);
    }
  } finally {
    db.close();
  }
});

test('a seeded database at 0024 takes exactly the plugin migrations from the assembled folder', () => {
  const db = openDatabase();
  try {
    // A site on the core chain through 0024, with rows from earlier releases and the demo seed, as
    // wrangler left it: every applied file name recorded.
    db.exec(D1_MIGRATIONS_TABLE);
    for (const tag of coreTags) {
      applyMigration(db, tag);
      seeds[tag]?.(db);
      recordApplied(db, `${tag}.sql`);
    }
    db.exec(readFileSync(new URL('../../talisman-cms/seeds/ecommerce-demo.sql', import.meta.url), 'utf8'));
    assertIntegrity(db);
    const demoProducts = rows(db, `SELECT id FROM _ecommerce_products WHERE id LIKE 'demo_%' ORDER BY id`);
    assert.ok(demoProducts.length >= 2);

    assert.deepEqual(applyFolder(db, assembled), PLUGIN_MIGRATIONS);
    assert.deepEqual(rows(db, 'SELECT name FROM d1_migrations ORDER BY id').map(({ name }) => name), ALL_MIGRATIONS);
    assertIntegrity(db);
    assert.deepEqual(rows(db, `SELECT id FROM _ecommerce_products WHERE id LIKE 'demo_%' ORDER BY id`), demoProducts);

    // 0025: orders from earlier releases carry no shipping or tax.
    assert.deepEqual(row(db, `SELECT shipping_amount, shipping_rate_id, shipping_label, tax_amount, tax_behavior,
      tax_calculation_id, tax_transaction_id FROM _ecommerce_orders WHERE id = 'order-1'`), {
      shipping_amount: 0, shipping_rate_id: null, shipping_label: null, tax_amount: 0, tax_behavior: null,
      tax_calculation_id: null, tax_transaction_id: null,
    });
    // 0026: payment and fulfillment are separate. Shipments recorded before it completed their orders,
    // and a refund no longer hides one. The shipment rows keep their ids and values.
    assert.deepEqual(rows(db, `SELECT id, status, fulfillment_status, updated_at FROM _ecommerce_orders ORDER BY id`), [
      { id: 'order-1', status: 'paid', fulfillment_status: 'unfulfilled', updated_at: T },
      { id: 'order-marked-fulfilled', status: 'paid', fulfillment_status: 'fulfilled', updated_at: T + 30 },
      { id: 'order-pending', status: 'pending', fulfillment_status: 'unfulfilled', updated_at: T + 40 },
      { id: 'order-shipped', status: 'paid', fulfillment_status: 'fulfilled', updated_at: T + 100 },
      { id: 'order-shipped-refunded', status: 'partially_refunded', fulfillment_status: 'fulfilled', updated_at: T + 300 },
    ]);
    assert.deepEqual(rows(db, `SELECT * FROM _ecommerce_fulfillments ORDER BY id`), [
      { id: 'ful-refunded', order_id: 'order-shipped-refunded', admin_actor: 'admin-1', carrier: null, tracking_number: null,
        note: 'Handed to the courier', created_at: T + 200, kind: 'shipment', corrects_id: null, completes_order: 1 },
      { id: 'ful-shipped', order_id: 'order-shipped', admin_actor: 'admin-1', carrier: 'USPS', tracking_number: 'TRACK-1',
        note: 'Packed and shipped', created_at: T + 100, kind: 'shipment', corrects_id: null, completes_order: 1 },
    ]);
    // A migrated shipment takes a correction, a shipped order takes no second shipment, and what the
    // previous Worker inserts for a paid order is a shipment that completes it.
    db.exec(`INSERT INTO _ecommerce_fulfillments
      (id, order_id, kind, corrects_id, completes_order, admin_actor, carrier, tracking_number, note, created_at)
      VALUES ('ful-shipped-fix', 'order-shipped', 'correction', 'ful-shipped', 0, 'admin-1', 'USPS', 'TRACK-2', 'Label was reprinted', ${T + 400})`);
    assert.throws(() => db.exec(`INSERT INTO _ecommerce_fulfillments (id, order_id, admin_actor, note, created_at)
      VALUES ('ful-again', 'order-shipped-refunded', 'admin-1', 'Second parcel sent', ${T + 400})`), /Order is not ready for fulfillment/);
    db.exec(`INSERT INTO _ecommerce_fulfillments (id, order_id, admin_actor, carrier, tracking_number, note, created_at)
      VALUES ('ful-previous-worker', 'order-1', 'admin-1', NULL, NULL, 'Packed and shipped', ${T + 500})`);
    assert.deepEqual(row(db, `SELECT status, fulfillment_status, updated_at FROM _ecommerce_orders WHERE id = 'order-1'`),
      { status: 'paid', fulfillment_status: 'fulfilled', updated_at: T + 500 });
    assertIntegrity(db);
    assertGiftCardRowsKept(db);
    assertReconcileStateUntried(db);
    // 0030: orders paid and gift cards bought before it are sent no email.
    assert.deepEqual([row(db, 'SELECT COUNT(*) AS n FROM _ecommerce_email_deliveries').n,
      row(db, 'SELECT COUNT(*) AS n FROM _ecommerce_gift_card_claims').n], [0, 0]);

    // The upgraded database has the schema of a fresh install, and a second run applies nothing.
    assert.deepEqual(fullSchema(db), freshSchema());
    assert.deepEqual(applyFolder(db, assembled), []);
  } finally {
    db.close();
  }
});

test('a database that applied 0000 to 0030 from the core folder has nothing to apply from the assembled one', () => {
  const db = openDatabase();
  try {
    db.exec(D1_MIGRATIONS_TABLE);
    for (const tag of tags) {
      applyMigration(db, tag);
      recordApplied(db, `${tag}.sql`);
    }
    assert.deepEqual(applyFolder(db, assembled), []);
    assert.deepEqual(fullSchema(db), freshSchema());
  } finally {
    db.close();
  }
});

test('the assembler orders files by number across sources and refuses a shared name or number', () => {
  const work = mkdtempSync(join(tmpdir(), 'talisman-migrations-order-'));
  try {
    const source = (name, files) => {
      const dir = join(work, name);
      mkdirSync(dir);
      for (const file of files) writeFileSync(join(dir, file), `-- ${file}\n`);
      return { name, dir };
    };
    // A plugin file with a lower number runs before a core file with a higher one, whatever the source
    // order; 9 runs before 10, as numbers and not as text.
    const core = source('core', ['0001_a.sql', '0003_c.sql', '0010_ten.sql', 'notes.txt']);
    const plugin = source('plugin', ['0002_b.sql', '0009_nine.sql', '0011_eleven.sql']);
    assert.deepEqual(listMigrationSources([core, plugin]).map(({ name, source: owner }) => `${name} ${owner}`), [
      '0001_a.sql core', '0002_b.sql plugin', '0003_c.sql core', '0009_nine.sql plugin', '0010_ten.sql core', '0011_eleven.sql plugin',
    ]);
    const outDir = join(work, 'out');
    mkdirSync(outDir);
    // A file an earlier run wrote (its sources.json names it) that no source ships any more is removed.
    writeFileSync(join(outDir, '0099_stale.sql'), '-- gone\n');
    writeFileSync(join(outDir, 'sources.json'), JSON.stringify([{ name: '0099_stale.sql', source: 'plugin' }]));
    assembleMigrations({ sources: [core, plugin], outDir });
    assert.deepEqual(readdirSync(outDir).sort(), ['0001_a.sql', '0002_b.sql', '0003_c.sql', '0009_nine.sql', '0010_ten.sql', '0011_eleven.sql', 'sources.json']);
    assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'sources.json'), 'utf8')),
      [['0001_a.sql', 'core'], ['0002_b.sql', 'plugin'], ['0003_c.sql', 'core'], ['0009_nine.sql', 'plugin'], ['0010_ten.sql', 'core'], ['0011_eleven.sql', 'plugin']]
        .map(([name, owner]) => ({ name, source: owner })));

    // A .sql file the assembler did not write is somebody's own migration: refused, never deleted.
    writeFileSync(join(outDir, '0050_site_tables.sql'), '-- the site\n');
    assert.throws(() => assembleMigrations({ sources: [core, plugin], outDir }), /0050_site_tables\.sql was not written by the migrations assembler/);
    assert.ok(readdirSync(outDir).includes('0050_site_tables.sql'));
    rmSync(join(outDir, '0050_site_tables.sql'));

    const sameNumber = source('same-number', ['0003_other.sql']);
    assert.throws(() => listMigrationSources([core, sameNumber]), /0003_c\.sql \(core\) and 0003_other\.sql \(same-number\) share the number 3/);
    const sameName = source('same-name', ['0001_a.sql']);
    assert.throws(() => listMigrationSources([core, sameName]), /0001_a\.sql is shipped by core and same-name/);
    assert.throws(() => listMigrationSources([{ name: 'missing', dir: join(work, 'missing') }]), /missing: migrations folder .* does not exist/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('0025 counts shipping and exclusive tax in the redemption guards and changes nothing else in them', () => {
  const db = openDatabase();
  try {
    migrate(db, { to: '0024_shopper_sign_in_tokens' });
    const guards = ['_ecommerce_discount_reserve_guard', '_ecommerce_gift_card_reserve_guard'];
    const guardSql = () => Object.fromEntries(rows(db, `SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND name IN (?, ?)`, ...guards)
      .map(({ name, sql }) => [name, sql.replace(/\s+/g, ' ')]));
    const before = guardSql();
    applyMigration(db, '0025_order_shipping_and_tax');
    const after = guardSql();
    const oldTotals = 'o.subtotal_amount = o.discount_amount + o.credit_applied + o.gift_card_applied + o.total_amount';
    const newTotals = `o.subtotal_amount + o.shipping_amount + CASE WHEN o.tax_behavior = 'exclusive' THEN o.tax_amount ELSE 0 END`
      + ' = o.discount_amount + o.credit_applied + o.gift_card_applied + o.total_amount';
    for (const guard of guards) {
      assert.equal(before[guard].split(oldTotals).length, 2, `${guard}: the totals line appears once before 0025`);
      assert.equal(after[guard], before[guard].replace(oldTotals, newTotals), guard);
    }

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
  } finally {
    db.close();
  }
});

test('0025 keeps shipping and tax amounts valid, records a tax reversal once per reference and indexes missing tax transactions', () => {
  const db = openDatabase();
  try {
    migrate(db, { to: '0025_order_shipping_and_tax' });
    db.exec(`INSERT INTO _ecommerce_orders (id, status, items, total_amount, created_at, updated_at) VALUES ('order-1', 'paid', '[]', 1000, ${T}, ${T})`);
    for (const assignment of ['shipping_amount = -1', 'tax_amount = -1', `tax_behavior = 'included'`]) {
      assert.throws(() => db.exec(`UPDATE _ecommerce_orders SET ${assignment} WHERE id = 'order-1'`), /CHECK constraint failed/, assignment);
    }

    const reverse = db.prepare(`INSERT INTO _ecommerce_tax_reversals (id, order_id, reference, amount, provider_reversal_id, created_at)
      VALUES (?, ?, ?, ?, ?, ${T})`);
    reverse.run('rev-1', 'order-1', 'order-1:reversal:500', 500, 'reversal-1');
    assert.throws(() => reverse.run('rev-2', 'order-1', 'order-1:reversal:500', 500, 'reversal-2'),
      /UNIQUE constraint failed: _ecommerce_tax_reversals\.reference/);
    assert.throws(() => reverse.run('rev-3', 'order-1', 'order-1:reversal:1000', 0, 'reversal-3'), /CHECK constraint failed/);
    assert.throws(() => reverse.run('rev-4', 'order-2', 'order-2:reversal:500', 500, 'reversal-4'), /FOREIGN KEY constraint failed/);

    // The lookup for paid orders whose tax transaction is missing repeats the partial index's conditions.
    const plan = rows(db, `EXPLAIN QUERY PLAN SELECT id FROM _ecommerce_orders
      WHERE status IN ('paid','fulfilled','partially_refunded','refunded')
        AND tax_calculation_id IS NOT NULL AND tax_transaction_id IS NULL
      ORDER BY created_at LIMIT 10`).map(({ detail }) => detail);
    assert.ok(plan.some((detail) => detail.includes('USING INDEX _ecommerce_orders_tax_transaction_missing_idx')), plan.join('\n'));
  } finally {
    db.close();
  }
});

test('0026 lets an order ship in parcels and take appended corrections, with indexes for the orders queue', () => {
  const db = openDatabase();
  try {
    migrate(db);
    const schema = outline(db);
    assert.equal(schema.columns._ecommerce_fulfillments,
      'id order_id admin_actor carrier tracking_number note created_at kind corrects_id completes_order');
    assert.match(schema.columns._ecommerce_orders, / fulfillment_status( |$)/);
    const touching = (name) => name.includes('_ecommerce_fulfillment') || name.includes('_ecommerce_orders_awaiting')
      || name.includes('_ecommerce_orders_recent');
    assert.deepEqual(schema.indexes.filter(touching), [
      '_ecommerce_fulfillments_order_idx ON _ecommerce_fulfillments (order_id, created_at)',
      '_ecommerce_orders_awaiting_idx ON _ecommerce_orders (created_at, id) WHERE ...',
      '_ecommerce_orders_recent_idx ON _ecommerce_orders (created_at, id) WHERE ...',
    ]);
    assert.deepEqual(schema.foreignKeys.filter(touching), [
      '_ecommerce_fulfillments.corrects_id -> _ecommerce_fulfillments.id',
      '_ecommerce_fulfillments.order_id -> _ecommerce_orders.id',
    ]);
    assert.deepEqual(schema.triggers.filter(touching), [
      '_ecommerce_fulfillment_complete ON _ecommerce_fulfillments',
      '_ecommerce_fulfillment_correction_guard ON _ecommerce_fulfillments',
      '_ecommerce_fulfillment_guard ON _ecommerce_fulfillments',
    ]);

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
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

/**
 * 0027: gift card rows keep their values; no refund was taken off a card, no card replaces a purchase,
 * and no card is marked as suspended by a review hold, so reinstating leaves an earlier suspension alone.
 */
function assertGiftCardRowsKept(db) {
  assert.deepEqual(rows(db, 'SELECT id, status, provider_refunded_cents, refund_adjusted_cents FROM _ecommerce_gift_card_purchases ORDER BY id'), [
    { id: 'gp-held', status: 'review', provider_refunded_cents: 3000, refund_adjusted_cents: 0 },
    { id: 'gp-refunded', status: 'refunded', provider_refunded_cents: 5000, refund_adjusted_cents: 0 },
  ]);
  assert.deepEqual(rows(db, `SELECT c.id, c.status, c.balance_cents, c.replaces_purchase_id, c.held_for_review,
      (SELECT SUM(amount_cents) FROM _ecommerce_gift_card_ledger l WHERE l.card_id = c.id) AS ledger
    FROM _ecommerce_gift_cards c ORDER BY c.id`), [
    { id: 'gift-admin', status: 'active', balance_cents: 2500, replaces_purchase_id: null, held_for_review: 0, ledger: 2500 },
    { id: 'gift-held', status: 'suspended', balance_cents: 10000, replaces_purchase_id: null, held_for_review: 0, ledger: 10000 },
    { id: 'gift-refunded', status: 'void', balance_cents: 0, replaces_purchase_id: null, held_for_review: 0, ledger: 0 },
  ]);
  assert.equal(row(db, 'SELECT COUNT(*) AS n FROM _ecommerce_gift_card_reviews').n, 0);
}

test('0027 keeps gift card rows, enforces its links, and the previous release can still write gift cards', () => {
  const db = openDatabase();
  try {
    const previous = tags[tags.indexOf('0027_gift_card_review') - 1];
    migrate(db, { to: previous, after: { '0015_gift_cards': seeds['0015_gift_cards'] } });
    applyMigration(db, '0027_gift_card_review');
    assertGiftCardRowsKept(db);

    // The previous release's gift card statements, verbatim: issue an administrator's card, start and
    // confirm a purchase, record a refund, and toggle a card.
    db.prepare(`INSERT INTO _ecommerce_gift_cards
      (id,code_hash,code_suffix,encrypted_code,source,admin_actor,admin_reason,initial_cents,balance_cents,currency,status,created_at,updated_at)
      VALUES (?,?,?,?, 'admin',?,?,?,0,'usd','active',?,?)`)
      .run('gift-issued', 'code-issued', 'DDDD', '000000000000000000000000:33', 'admin-1', 'Service goodwill', 3000, T, T);
    db.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,kind,amount_cents,created_at) VALUES (?,?,'issue',?,?)`).run('gcl_issue_gift-issued', 'gift-issued', 3000, T);
    db.prepare(`INSERT INTO _ecommerce_gift_card_purchases
      (id,buyer_email,amount_cents,currency,status,access_token_hash,created_at,updated_at)
      VALUES (?,?,?,'usd','pending',?,?,?)`).run('gp-new', 'buyer@example.com', 8000, 'hash-new', T, T);
    db.prepare(`UPDATE _ecommerce_gift_card_purchases SET provider_session_id = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`).run('cs_new', T, 'gp-new');
    db.prepare(`UPDATE _ecommerce_gift_card_purchases
      SET status = 'paid',payment_intent_id = ?,updated_at = ?
      WHERE id = ? AND status = 'pending' AND provider_session_id = ?`).run('pi_new', T, 'gp-new', 'cs_new');
    db.prepare(`INSERT INTO _ecommerce_gift_cards
      (id,code_hash,code_suffix,encrypted_code,source,purchase_id,initial_cents,balance_cents,currency,status,created_at,updated_at)
      SELECT ?,?,?,?,'purchase',id,amount_cents,0,'usd','active',?,?
      FROM _ecommerce_gift_card_purchases WHERE id = ? AND status = 'paid'
      ON CONFLICT(purchase_id) DO NOTHING`).run('gift-new', 'code-new', 'EEEE', '000000000000000000000000:44', T, T, 'gp-new');
    db.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_issue_' || id,id,purchase_id,'issue',initial_cents,?
      FROM _ecommerce_gift_cards WHERE purchase_id = ? ON CONFLICT(id) DO NOTHING`).run(T, 'gp-new');
    db.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = ?,provider_refunded_cents = ?,updated_at = ?
      WHERE id = ? AND provider_refunded_cents < ?`).run('review', 1000, T + 20, 'gp-new', 1000);
    db.prepare(`UPDATE _ecommerce_gift_cards SET status = ?,updated_at = ? WHERE id = ?`).run('suspended', T + 20, 'gift-new');
    db.prepare(`UPDATE _ecommerce_gift_cards SET status = ?,updated_at = ?
      WHERE id = ? AND status <> 'void' AND (source = 'admin' OR EXISTS (
        SELECT 1 FROM _ecommerce_gift_card_purchases p WHERE p.id = purchase_id AND p.status = 'paid'))
      RETURNING id`).all('suspended', T + 20, 'gift-issued');
    assert.deepEqual(rows(db, `SELECT id, status, balance_cents, replaces_purchase_id, held_for_review FROM _ecommerce_gift_cards
      WHERE id IN ('gift-issued', 'gift-new') ORDER BY id`), [
      { id: 'gift-issued', status: 'suspended', balance_cents: 3000, replaces_purchase_id: null, held_for_review: 0 },
      { id: 'gift-new', status: 'suspended', balance_cents: 8000, replaces_purchase_id: null, held_for_review: 0 },
    ]);
    assert.deepEqual(row(db, `SELECT status, provider_refunded_cents, refund_adjusted_cents FROM _ecommerce_gift_card_purchases WHERE id = 'gp-new'`),
      { status: 'review', provider_refunded_cents: 1000, refund_adjusted_cents: 0 });
    // A card the new release's hold marked can still be voided by the previous release's refund statement.
    db.exec(`UPDATE _ecommerce_gift_cards SET held_for_review = 1 WHERE id = 'gift-new'`);
    db.prepare(`UPDATE _ecommerce_gift_cards SET status = ?,updated_at = ? WHERE id = ?`).run('void', T + 30, 'gift-new');
    assert.equal(row(db, `SELECT status FROM _ecommerce_gift_cards WHERE id = 'gift-new'`).status, 'void');

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

test('0028 adds refund dates, disputes and restocks beside existing rows, and the previous release keeps working', () => {
  const db = openDatabase();
  try {
    const previous = tags[tags.indexOf('0028_provider_refunds_and_disputes') - 1];
    migrate(db, { to: previous, after: { '0004_ecommerce_plugin': seeds['0004_ecommerce_plugin'], '0015_gift_cards': seeds['0015_gift_cards'] } });
    // Rows as the previous release writes them: paid orders with their reservations, one partly refunded
    // by Stripe, and a checkout cancelled with its stock released.
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
    const kept = () => ['_ecommerce_orders', '_ecommerce_payments', '_ecommerce_inventory_reservations',
      '_ecommerce_component_reservations', '_ecommerce_gift_card_purchases', '_ecommerce_gift_cards']
      .map((table) => rows(db, `SELECT * FROM ${table} ORDER BY rowid`));
    const before = kept();
    applyMigration(db, '0028_provider_refunds_and_disputes');
    assert.deepEqual(kept(), before);

    const schema = outline(db);
    assert.equal(schema.columns._ecommerce_provider_refunds, 'id order_id provider provider_refund_id amount_cents created_at');
    assert.equal(schema.columns._ecommerce_disputes,
      'id provider order_id gift_card_purchase_id amount_cents currency reason status status_before created_at updated_at closed_at');
    assert.equal(schema.columns._ecommerce_restocks,
      'id order_id reservation_type reservation_id target_type target_id quantity admin_actor reason created_at');
    const added = (name) => ['_ecommerce_provider_refunds', '_ecommerce_disputes', '_ecommerce_restocks'].some((table) => name.includes(table));
    assert.deepEqual(schema.indexes.filter(added), [
      '_ecommerce_disputes_order_idx ON _ecommerce_disputes (order_id) WHERE ...',
      '_ecommerce_disputes_purchase_idx ON _ecommerce_disputes (gift_card_purchase_id) WHERE ...',
      '_ecommerce_provider_refunds_order_idx ON _ecommerce_provider_refunds (order_id)',
      '_ecommerce_restocks UNIQUE (reservation_type, reservation_id)',
      '_ecommerce_restocks_order_idx ON _ecommerce_restocks (order_id, created_at)',
    ]);
    assert.deepEqual(schema.foreignKeys.filter(added), [
      '_ecommerce_disputes.gift_card_purchase_id -> _ecommerce_gift_card_purchases.id',
      '_ecommerce_disputes.order_id -> _ecommerce_orders.id',
      '_ecommerce_provider_refunds.order_id -> _ecommerce_orders.id',
      '_ecommerce_restocks.order_id -> _ecommerce_orders.id',
    ]);
    assert.deepEqual(schema.triggers.filter(added), []);

    // The previous release's refund and cancellation statements, verbatim, never touch the new tables.
    db.prepare(`UPDATE _ecommerce_orders
        SET provider_refunded_cents = ?, status = ?, updated_at = ?
        WHERE id = ? AND payment_intent_id = ? AND provider_refunded_cents < ?
          AND status IN ('paid', 'fulfilled', 'partially_refunded')`)
      .run(12000, 'refunded', T + 10, 'order-partly', 'pi_partly', 12000);
    db.prepare(`UPDATE _ecommerce_payments
        SET status = (SELECT status FROM _ecommerce_orders WHERE id = ?)
        WHERE order_id = ? AND provider = 'stripe'`).run('order-partly', 'order-partly');
    db.prepare(`UPDATE _ecommerce_orders SET status = 'cancelled', updated_at = ?
        WHERE id = ? AND status NOT IN ('paid', 'fulfilled')`).run(T + 10, 'order-paid');
    assert.deepEqual(rows(db, `SELECT id, status, provider_refunded_cents FROM _ecommerce_orders WHERE id IN ('order-paid', 'order-partly') ORDER BY id`), [
      { id: 'order-paid', status: 'paid', provider_refunded_cents: 0 },
      { id: 'order-partly', status: 'refunded', provider_refunded_cents: 12000 },
    ]);

    // Refund rows are positive amounts of an existing order; a row without a known date is allowed.
    db.exec(`INSERT INTO _ecommerce_provider_refunds (id, order_id, provider, provider_refund_id, amount_cents, created_at)
      VALUES ('prf-partly', 'order-partly', 'stripe', NULL, 9000, NULL)`);
    assert.throws(() => db.exec(`INSERT INTO _ecommerce_provider_refunds (id, order_id, provider, amount_cents, created_at)
      VALUES ('prf-zero', 'order-partly', 'stripe', 0, ${T})`), /CHECK constraint failed/);
    assert.throws(() => db.exec(`INSERT INTO _ecommerce_provider_refunds (id, order_id, provider, amount_cents, created_at)
      VALUES ('prf-missing', 'order-missing', 'stripe', 100, ${T})`), /FOREIGN KEY constraint failed/);

    // A dispute names exactly one order or gift card purchase. 'disputed' needs no schema change, and the
    // fulfillment guard from 0026 refuses it.
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

/** 0029: tax records and reversals written before it start with no failed attempts. */
const taxUntried = { tax_sync_attempts: 0, tax_sync_last_at: null, tax_sync_last_error: null };

/** 0029: orders and gift card purchases written before it keep their values and start untried and unparked. */
function assertReconcileStateUntried(db) {
  for (const table of ['_ecommerce_orders', '_ecommerce_gift_card_purchases']) {
    assert.deepEqual(rows(db, `SELECT DISTINCT reconcile_attempts, reconcile_last_at, reconcile_last_error, reconcile_review_at
      FROM ${table}`), [{ reconcile_attempts: 0, reconcile_last_at: null, reconcile_last_error: null, reconcile_review_at: null }], table);
  }
  assert.deepEqual(rows(db, 'SELECT DISTINCT tax_sync_attempts, tax_sync_last_at, tax_sync_last_error FROM _ecommerce_orders'),
    [taxUntried]);
}

const queryPlan = (db, sql, ...params) => rows(db, `EXPLAIN QUERY PLAN ${sql}`, ...params).map((step) => step.detail).join(' | ');

test('0029 adds reconciliation state and indexes, keeps rows, and the previous release still writes and reads them', () => {
  const db = openDatabase();
  try {
    const tag = '0029_commerce_reconcile_backoff';
    migrate(db, { to: tags[tags.indexOf(tag) - 1], after: { '0004_ecommerce_plugin': seeds['0004_ecommerce_plugin'],
      '0011_order_payment_provider': seeds['0011_order_payment_provider'], '0015_gift_cards': seeds['0015_gift_cards'] } });
    // A gift card purchase left pending, started by the previous release's statements.
    db.prepare(`INSERT INTO _ecommerce_gift_card_purchases
      (id,buyer_email,amount_cents,currency,status,access_token_hash,created_at,updated_at)
      VALUES (?,?,?,'usd','pending',?,?,?)`).run('gp-pending', 'buyer@example.com', 5000, 'hash-pending', T, T);
    db.prepare(`UPDATE _ecommerce_gift_card_purchases SET provider_session_id = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`).run('cs_test_gift', T, 'gp-pending');
    const orders = rows(db, 'SELECT * FROM _ecommerce_orders ORDER BY id');
    const purchases = rows(db, 'SELECT * FROM _ecommerce_gift_card_purchases ORDER BY id');
    applyMigration(db, tag);

    const untried = { reconcile_attempts: 0, reconcile_last_at: null, reconcile_last_error: null, reconcile_review_at: null };
    assert.deepEqual(rows(db, 'SELECT * FROM _ecommerce_orders ORDER BY id'),
      orders.map((order) => ({ ...order, ...untried, ...taxUntried })));
    assert.deepEqual(rows(db, 'SELECT * FROM _ecommerce_gift_card_purchases ORDER BY id'),
      purchases.map((purchase) => ({ ...purchase, ...untried })));
    const added = /^(_ecommerce_orders_pending_idx|_ecommerce_gift_card_purchases_status_created_idx|_ecommerce_payments_order_idx|_ecommerce_orders_checkout_session_idx|galaxy_auth_verification_identifier_idx|_ecommerce_reconcile_decisions_\w+) /;
    const schema = outline(db);
    assert.deepEqual(schema.indexes.filter((index) => added.test(index)), [
      '_ecommerce_gift_card_purchases_status_created_idx ON _ecommerce_gift_card_purchases (status, created_at)',
      '_ecommerce_orders_checkout_session_idx ON _ecommerce_orders (checkout_session_id)',
      '_ecommerce_orders_pending_idx ON _ecommerce_orders (created_at) WHERE ...',
      '_ecommerce_payments_order_idx ON _ecommerce_payments (order_id)',
      '_ecommerce_reconcile_decisions_order_idx ON _ecommerce_reconcile_decisions (order_id, created_at)',
      '_ecommerce_reconcile_decisions_purchase_idx ON _ecommerce_reconcile_decisions (purchase_id, created_at)',
      'galaxy_auth_verification_identifier_idx ON galaxy_auth_verification (identifier, created_at)',
    ]);
    // Administrator decisions on parked records name the order or the purchase they changed.
    assert.equal(schema.columns._ecommerce_reconcile_decisions,
      'id order_id purchase_id action failure payment_returned admin_actor reason created_at');
    assert.deepEqual(schema.foreignKeys.filter((key) => key.startsWith('_ecommerce_reconcile_decisions.')), [
      '_ecommerce_reconcile_decisions.order_id -> _ecommerce_orders.id',
      '_ecommerce_reconcile_decisions.purchase_id -> _ecommerce_gift_card_purchases.id',
    ]);

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
    // The orders queue keeps the partial indexes of 0026, and pages without sorting.
    const awaiting = `status IN ('paid','partially_refunded') AND fulfillment_status <> 'fulfilled'
      AND COALESCE(payment_provider, 'stripe') <> 'admin_test'`;
    assert.match(queryPlan(db, `SELECT COUNT(*) AS count FROM _ecommerce_orders WHERE ${awaiting}`), /_ecommerce_orders_awaiting_idx/);
    assert.equal(queryPlan(db, `SELECT id FROM _ecommerce_orders WHERE ${awaiting} ORDER BY created_at ASC, id ASC LIMIT ?`, 51),
      'SCAN _ecommerce_orders USING INDEX _ecommerce_orders_awaiting_idx');
    assert.equal(queryPlan(db, `SELECT id FROM _ecommerce_orders WHERE status NOT IN ('pending','cancelled','draft')
      AND COALESCE(payment_provider, 'stripe') <> 'admin_test' ORDER BY created_at DESC, id DESC LIMIT ?`, 51),
      'SCAN _ecommerce_orders USING INDEX _ecommerce_orders_recent_idx');

    // The previous release's reconciliation queries, verbatim, still find the pending rows.
    const due = T + 3600;
    assert.deepEqual(rows(db, `SELECT id FROM _ecommerce_orders
      WHERE status = 'pending' AND created_at < ?
        AND (? = 1 OR COALESCE(payment_provider, 'stripe') <> 'admin_test')
      ORDER BY created_at LIMIT ?`, due, 0, 10), [{ id: 'order-pending' }]);
    assert.deepEqual(rows(db, `SELECT id FROM _ecommerce_gift_card_purchases
      WHERE status = 'pending' AND provider_session_id IS NOT NULL AND created_at < ?
      ORDER BY created_at LIMIT ?`, due, 10), [{ id: 'gp-pending' }]);
    assert.deepEqual(rows(db, `SELECT id FROM _ecommerce_carts
      WHERE checkout_session_id LIKE 'preparing:%' AND updated_at < ?
      ORDER BY updated_at LIMIT ?`, due, 10), []);
    // Its checkout inserts a pending order without the new columns, which take their defaults.
    db.prepare(`INSERT INTO _ecommerce_orders
      (id, cart_id, user_id, checkout_session_id, payment_provider, status, items, total_amount, subtotal_amount, credit_applied, discount_code, discount_amount, gift_card_id, gift_card_applied, referral_code, referral_reward_cents, currency,
       customer_email, shipping_address, billing_address, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'usd', ?, ?, ?, ?, ?) `)
      .run('order-new', null, null, 'cs_test_new', 'stripe', '[]', 12000, 12000, 0, null, 0, null, 0, null, 0,
        'new@example.com', null, null, T + 50, T + 50);
    assert.deepEqual(row(db, `SELECT reconcile_attempts, reconcile_last_at, reconcile_last_error, reconcile_review_at
      FROM _ecommerce_orders WHERE id = 'order-new'`), untried);

    // The new release records attempts and parks a row; the previous release, after a rollback, still
    // settles or cancels it, ignoring that state.
    db.prepare(`UPDATE _ecommerce_orders SET reconcile_attempts = reconcile_attempts + 1,
        reconcile_last_at = ?, reconcile_last_error = ?, reconcile_review_at = ?
      WHERE id = ? AND status = 'pending' AND reconcile_review_at IS NULL RETURNING id`).all(T + 60, 'session_missing', T + 60, 'order-pending');
    db.prepare(`UPDATE _ecommerce_gift_card_purchases SET reconcile_attempts = reconcile_attempts + 1, reconcile_last_at = ?,
      reconcile_last_error = ? WHERE id = ?`).run(T + 60, 'provider_unavailable', 'gp-pending');
    db.prepare(`UPDATE _ecommerce_orders SET status = 'paid', updated_at = ?, customer_email = ?, payment_intent_id = ?
      WHERE id = ? AND status = 'pending' AND checkout_session_id = ? AND total_amount = ?`)
      .run(T + 70, 'new@example.com', 'pi_pending', 'order-pending', 'cs_test_pending', 4000);
    db.prepare(`UPDATE _ecommerce_orders SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status NOT IN ('paid', 'fulfilled')`).run(T + 70, 'order-new');
    db.prepare(`UPDATE _ecommerce_gift_card_purchases
      SET status = 'paid',payment_intent_id = ?,updated_at = ?
      WHERE id = ? AND status = 'pending' AND provider_session_id = ?`).run('pi_gift', T + 70, 'gp-pending', 'cs_test_gift');
    assert.deepEqual(rows(db, `SELECT id, status, reconcile_attempts, reconcile_last_error, reconcile_review_at FROM _ecommerce_orders
      WHERE id IN ('order-pending', 'order-new') ORDER BY id`), [
      { id: 'order-new', status: 'cancelled', reconcile_attempts: 0, reconcile_last_error: null, reconcile_review_at: null },
      { id: 'order-pending', status: 'paid', reconcile_attempts: 1, reconcile_last_error: 'session_missing', reconcile_review_at: T + 60 },
    ]);
    assert.deepEqual(row(db, `SELECT status, reconcile_attempts, reconcile_last_error FROM _ecommerce_gift_card_purchases WHERE id = 'gp-pending'`),
      { status: 'paid', reconcile_attempts: 1, reconcile_last_error: 'provider_unavailable' });
    assert.throws(() => db.exec(`UPDATE _ecommerce_orders SET reconcile_attempts = -1 WHERE id = 'order-new'`), /CHECK constraint failed/);
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
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('0029 counts tax attempts on orders and reversals, indexes the tax passes, and the previous release still records and reverses tax', () => {
  const db = openDatabase();
  try {
    const tag = '0029_commerce_reconcile_backoff';
    migrate(db, { to: tags[tags.indexOf(tag) - 1] });
    // As the previous release leaves them: a paid order whose tax transaction is missing, and a partly
    // refunded one with a reversal sent, one whose request failed, and a refund not reversed yet.
    const insertOrder = db.prepare(`INSERT INTO _ecommerce_orders (id, status, items, total_amount, payment_provider,
      tax_amount, tax_behavior, tax_calculation_id, tax_transaction_id, provider_refunded_cents, created_at, updated_at)
      VALUES (?, ?, '[]', 13200, 'stripe', 1200, 'exclusive', ?, ?, ?, ?, ?)`);
    insertOrder.run('order-tax-missing', 'paid', 'taxcalc_1', null, 0, T, T);
    insertOrder.run('order-tax-refunded', 'partially_refunded', 'taxcalc_2', 'tax_2', 8000, T + 10, T + 30);
    // The previous release's statements, verbatim: record a reversal, then store the provider's id for it.
    const recordReversal = db.prepare(`INSERT INTO _ecommerce_tax_reversals
      (id, order_id, reference, amount, provider_reversal_id, created_at)
      SELECT ?, ?, ?, ?, '', ? WHERE (SELECT COALESCE(SUM(amount), 0) FROM _ecommerce_tax_reversals
        WHERE order_id = ?) = ?
      ON CONFLICT(reference) DO NOTHING`);
    const sendReversal = db.prepare(`UPDATE _ecommerce_tax_reversals SET provider_reversal_id = ?
    WHERE reference = ? AND provider_reversal_id = ''`);
    recordReversal.run('taxrev-sent', 'order-tax-refunded', 'order-tax-refunded:reversal:3000', 3000, T + 20, 'order-tax-refunded', 0);
    sendReversal.run('taxrev_1', 'order-tax-refunded:reversal:3000');
    recordReversal.run('taxrev-unsent', 'order-tax-refunded', 'order-tax-refunded:reversal:5000', 2000, T + 30, 'order-tax-refunded', 3000);
    const reversals = rows(db, 'SELECT * FROM _ecommerce_tax_reversals ORDER BY id');
    applyMigration(db, tag);

    // Existing reversals and orders keep their values and start with no failed tax attempts.
    assert.deepEqual(rows(db, 'SELECT * FROM _ecommerce_tax_reversals ORDER BY id'),
      reversals.map((reversal) => ({ ...reversal, ...taxUntried })));
    assert.deepEqual(rows(db, `SELECT id, tax_sync_attempts, tax_sync_last_at, tax_sync_last_error FROM _ecommerce_orders
      ORDER BY id`), [{ id: 'order-tax-missing', ...taxUntried }, { id: 'order-tax-refunded', ...taxUntried }]);
    const schema = outline(db);
    assert.equal(schema.columns._ecommerce_tax_reversals,
      'id order_id reference amount provider_reversal_id created_at tax_sync_attempts tax_sync_last_at tax_sync_last_error');
    assert.deepEqual(schema.indexes.filter((index) => /^_ecommerce_(orders_tax_refunded|tax_reversals_unsent)_idx /.test(index)), [
      '_ecommerce_orders_tax_refunded_idx ON _ecommerce_orders (created_at) WHERE ...',
      '_ecommerce_tax_reversals_unsent_idx ON _ecommerce_tax_reversals (created_at) WHERE ...',
    ]);

    // The tax passes, as the previous release runs them and with this release's backoff: paid orders
    // without a transaction come from the index of 0025, unsent reversals and refunded orders with a
    // transaction from those of 0029.
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
      [`${missing} ORDER BY created_at LIMIT ?`, [10],
        /SEARCH _ecommerce_orders USING INDEX _ecommerce_orders_tax_transaction_missing_idx \(status=\?\)/,
        [{ id: 'order-tax-missing' }]],
      [`${missing} AND ${backoff('').due} ORDER BY ${backoff('').order} LIMIT ?`, [T + 100, 10],
        /SEARCH _ecommerce_orders USING INDEX _ecommerce_orders_tax_transaction_missing_idx \(status=\?\)/,
        [{ id: 'order-tax-missing' }]],
      [`${unsent} ORDER BY r.created_at LIMIT ?`, [T + 100, 10],
        /SEARCH r USING INDEX _ecommerce_tax_reversals_unsent_idx \(created_at<\?\)/,
        [{ order_id: 'order-tax-refunded', reference: 'order-tax-refunded:reversal:5000', amount: 2000,
          payment_provider: 'stripe', tax_transaction_id: 'tax_2' }]],
      [`${unsent} AND ${backoff('r.').due} ORDER BY ${backoff('r.').order} LIMIT ?`, [T + 100, T + 100, 10],
        /SEARCH r USING INDEX _ecommerce_tax_reversals_unsent_idx \(created_at<\?\)/,
        [{ order_id: 'order-tax-refunded', reference: 'order-tax-refunded:reversal:5000', amount: 2000,
          payment_provider: 'stripe', tax_transaction_id: 'tax_2' }]],
      [`${unreversed} ORDER BY o.created_at LIMIT ?`, [10],
        /SCAN o USING INDEX _ecommerce_orders_tax_refunded_idx/, [{ id: 'order-tax-refunded' }]],
      [`${unreversed} AND ${backoff('o.').due} ORDER BY ${backoff('o.').order} LIMIT ?`, [T + 100, 10],
        /SCAN o USING INDEX _ecommerce_orders_tax_refunded_idx/, [{ id: 'order-tax-refunded' }]],
    ];
    for (const [sql, params, plan, found] of passes) {
      assert.match(queryPlan(db, sql, ...params), plan, sql);
      assert.deepEqual(rows(db, sql, ...params), found, sql);
    }

    // This release counts failed attempts and clears them; a count is never negative.
    db.prepare(`UPDATE _ecommerce_orders SET tax_sync_attempts = tax_sync_attempts + 1, tax_sync_last_at = ?,
      tax_sync_last_error = ? WHERE id = ? AND tax_transaction_id IS NULL`).run(T + 100, 'provider_unavailable', 'order-tax-missing');
    db.prepare(`UPDATE _ecommerce_tax_reversals SET tax_sync_attempts = tax_sync_attempts + 1, tax_sync_last_at = ?,
      tax_sync_last_error = ? WHERE reference = ? AND provider_reversal_id = ''`).run(T + 100, 'failed', 'order-tax-refunded:reversal:5000');
    assert.deepEqual(rows(db, `SELECT id, tax_sync_attempts, tax_sync_last_at, tax_sync_last_error FROM _ecommerce_orders
      WHERE id LIKE 'order-tax-%' ORDER BY id`), [
      { id: 'order-tax-missing', tax_sync_attempts: 1, tax_sync_last_at: T + 100, tax_sync_last_error: 'provider_unavailable' },
      { id: 'order-tax-refunded', ...taxUntried },
    ]);
    // A counted failure waits: two minutes after it, the order and the reversal are due again.
    assert.deepEqual(rows(db, `${missing} AND ${backoff('').due}`, T + 219), []);
    assert.deepEqual(rows(db, `${missing} AND ${backoff('').due}`, T + 220), [{ id: 'order-tax-missing' }]);
    assert.deepEqual(rows(db, `${unsent} AND ${backoff('r.').due}`, T + 1000, T + 219), []);
    for (const table of ['_ecommerce_orders', '_ecommerce_tax_reversals']) {
      assert.throws(() => db.exec(`UPDATE ${table} SET tax_sync_attempts = -1`), /CHECK constraint failed/, table);
    }

    // After a rollback, the previous release records the transaction, and sends the reversal and a new
    // one, ignoring the counts; new reversals take the defaults.
    db.prepare(`UPDATE _ecommerce_orders SET tax_transaction_id = ?
    WHERE id = ? AND tax_transaction_id IS NULL`).run('tax_1', 'order-tax-missing');
    sendReversal.run('taxrev_2', 'order-tax-refunded:reversal:5000');
    recordReversal.run('taxrev-new', 'order-tax-refunded', 'order-tax-refunded:reversal:8000', 3000, T + 200, 'order-tax-refunded', 5000);
    sendReversal.run('taxrev_3', 'order-tax-refunded:reversal:8000');
    assert.deepEqual(rows(db, `SELECT reference, provider_reversal_id, tax_sync_attempts, tax_sync_last_error
      FROM _ecommerce_tax_reversals ORDER BY created_at`), [
      { reference: 'order-tax-refunded:reversal:3000', provider_reversal_id: 'taxrev_1', tax_sync_attempts: 0, tax_sync_last_error: null },
      { reference: 'order-tax-refunded:reversal:5000', provider_reversal_id: 'taxrev_2', tax_sync_attempts: 1, tax_sync_last_error: 'failed' },
      { reference: 'order-tax-refunded:reversal:8000', provider_reversal_id: 'taxrev_3', tax_sync_attempts: 0, tax_sync_last_error: null },
    ]);
    // Nothing is left for either release's passes.
    for (const [sql, params] of passes) assert.deepEqual(rows(db, sql, ...params), [], sql);
    assertIntegrity(db);
  } finally {
    db.close();
  }
});

test('0030 adds the email log and gift card claim links, changes no row, and the previous Worker still writes', () => {
  const db = openDatabase();
  try {
    const previous = tags[tags.indexOf('0030_commerce_order_emails') - 1];
    migrate(db, { to: previous, after: seeds });
    const existing = tableNames(db);
    const contents = () => Object.fromEntries(existing.map((table) => [table, rows(db, `SELECT * FROM "${table}" ORDER BY rowid`)]));
    const before = contents();
    applyMigration(db, '0030_commerce_order_emails');
    assert.deepEqual(contents(), before, 'every existing row keeps its values');
    assert.deepEqual(tableNames(db).filter((table) => !existing.includes(table)), ['_ecommerce_email_deliveries', '_ecommerce_gift_card_claims']);
    const schema = outline(db);
    assert.equal(schema.columns._ecommerce_email_deliveries,
      'id kind subject_id status attempts last_error next_attempt_at claimed_at sent_at created_at');
    assert.equal(schema.columns._ecommerce_gift_card_claims,
      'id token_hash purchase_id card_id expires_at used_at revoked_at created_at created_by reason');
    const added = (name) => name.includes('_ecommerce_email_deliveries') || name.includes('_ecommerce_gift_card_claim');
    assert.deepEqual(schema.indexes.filter(added), [
      '_ecommerce_email_deliveries UNIQUE (kind, subject_id)',
      '_ecommerce_email_deliveries_due_idx ON _ecommerce_email_deliveries (next_attempt_at) WHERE ...',
      '_ecommerce_gift_card_claims UNIQUE (token_hash)',
      '_ecommerce_gift_card_claims_purchase_idx ON _ecommerce_gift_card_claims (purchase_id, created_at)',
    ]);
    assert.deepEqual(schema.foreignKeys.filter(added), [
      '_ecommerce_gift_card_claims.card_id -> _ecommerce_gift_cards.id',
      '_ecommerce_gift_card_claims.purchase_id -> _ecommerce_gift_card_purchases.id',
    ]);
    assert.deepEqual(schema.triggers.filter(added), ['_ecommerce_gift_card_claim_guard ON _ecommerce_gift_card_claims']);

    // What the previous Worker writes still works and asks for no email: a paid order's shipment and a
    // gift card purchase, with the statements of that release.
    db.exec(`INSERT INTO _ecommerce_orders (id, status, items, total_amount, payment_provider, customer_email, created_at, updated_at)
      VALUES ('order-paid', 'paid', '[]', 9000, 'stripe', 'buyer@example.com', ${T}, ${T})`);
    db.exec(`INSERT INTO _ecommerce_fulfillments (id, order_id, kind, completes_order, admin_actor, carrier, tracking_number, note, created_at)
      VALUES ('ful-previous-worker', 'order-paid', 'shipment', 1, 'admin-1', 'UPS', '1Z999', 'Parcel handed over', ${T + 10})`);
    db.prepare(`INSERT INTO _ecommerce_gift_card_purchases
      (id,buyer_email,amount_cents,currency,status,access_token_hash,provider_session_id,created_at,updated_at)
      VALUES (?,?,?,'usd','pending',?,?,?,?)`).run('gp-new', 'buyer@example.com', 5000, 'hash-new', 'cs_new', T, T);
    db.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = 'paid',payment_intent_id = ?,updated_at = ?
      WHERE id = ? AND status = 'pending' AND provider_session_id = ?`).run('pi_new', T, 'gp-new', 'cs_new');
    db.prepare(`INSERT INTO _ecommerce_gift_cards
      (id,code_hash,code_suffix,encrypted_code,source,purchase_id,initial_cents,balance_cents,currency,status,created_at,updated_at)
      SELECT ?,?,?,?,'purchase',id,amount_cents,0,'usd','active',?,?
      FROM _ecommerce_gift_card_purchases WHERE id = ? AND status = 'paid'
      ON CONFLICT(purchase_id) DO NOTHING`).run('gift-new', 'code-new', 'EEEE', '000000000000000000000000:44', T, T, 'gp-new');
    db.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_issue_' || id,id,purchase_id,'issue',initial_cents,?
      FROM _ecommerce_gift_cards WHERE purchase_id = ? ON CONFLICT(id) DO NOTHING`).run(T, 'gp-new');
    assert.equal(row(db, `SELECT fulfillment_status FROM _ecommerce_orders WHERE id = 'order-paid'`).fulfillment_status, 'fulfilled');
    assert.equal(row(db, `SELECT balance_cents FROM _ecommerce_gift_cards WHERE id = 'gift-new'`).balance_cents, 5000);
    assert.equal(row(db, 'SELECT COUNT(*) AS n FROM _ecommerce_email_deliveries').n, 0);

    // One email per kind and subject; a sent email has its time, and only known kinds are recorded.
    const deliver = (id, kind = 'order_confirmation', subject = 'order-paid', conflict = '') => db.exec(`INSERT INTO
      _ecommerce_email_deliveries (id, kind, subject_id, next_attempt_at, created_at) VALUES ('${id}', '${kind}', '${subject}', ${T}, ${T})${conflict}`);
    deliver('mail-1');
    assert.throws(() => deliver('mail-2'), /UNIQUE constraint failed/);
    deliver('mail-2', 'order_confirmation', 'order-paid', ' ON CONFLICT (kind, subject_id) DO NOTHING');
    deliver('mail-3', 'shipment', 'ful-previous-worker');
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
