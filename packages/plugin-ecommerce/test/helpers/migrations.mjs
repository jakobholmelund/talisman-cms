import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { listMigrationSources } from 'talisman-cms/migrations';

// The plugin ships its migrations from 0025 in drizzle/; the core's drizzle/ holds the earlier ones,
// which create the commerce tables of their time. A site applies both from one assembled folder.
export const pluginMigrationsDir = new URL('../../drizzle/', import.meta.url);
export const coreMigrationsDir = new URL('../../../talisman-cms/drizzle/', import.meta.url);
export const migrationSources = [
  { name: 'talisman-cms', dir: fileURLToPath(coreMigrationsDir) },
  { name: '@talisman-cms/plugin-ecommerce', dir: fileURLToPath(pluginMigrationsDir) },
];

/** The SQL of one migration, by file name or tag, from the plugin's folder or else the core's. */
export function migrationSql(name) {
  const file = name.endsWith('.sql') ? name : `${name}.sql`;
  for (const dir of [pluginMigrationsDir, coreMigrationsDir]) {
    const url = new URL(file, dir);
    if (existsSync(url)) return readFileSync(url, 'utf8');
  }
  throw new Error(`${file}: not in the plugin's or the core's drizzle folder`);
}

/** Every migration file a site applies, core and plugin, in wrangler's order. */
export function migrationFileNames() {
  return listMigrationSources(migrationSources).map((file) => file.name);
}

export function openDatabase() {
  const db = new DatabaseSync(':memory:');
  // D1 enforces foreign keys, so every migration must apply with them on.
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** Apply one migration atomically, as D1 does: a failing file leaves nothing behind. */
export function applyMigration(db, tag) {
  const sql = migrationSql(tag);
  db.exec('BEGIN');
  try {
    db.exec(sql);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`${tag}: ${error.message}`, { cause: error });
  }
}

export const rows = (db, sql, ...params) => db.prepare(sql).all(...params).map((row) => ({ ...row }));
export const row = (db, sql, ...params) => rows(db, sql, ...params)[0];

export function tableNames(db) {
  return rows(db, `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map(({ name }) => name);
}

/** A readable outline of the schema: columns, indexes and unique constraints, foreign keys and triggers. */
export function outline(db) {
  const columns = {};
  const indexes = [];
  const foreignKeys = [];
  for (const table of tableNames(db)) {
    columns[table] = rows(db, 'SELECT name FROM pragma_table_info(?) ORDER BY cid', table).map(({ name }) => name).join(' ');
    for (const index of rows(db, 'SELECT name, "unique", origin, partial FROM pragma_index_list(?)', table)) {
      if (index.origin === 'pk') continue;
      const keys = rows(db, 'SELECT name FROM pragma_index_info(?) ORDER BY seqno', index.name).map(({ name }) => name ?? '<expression>').join(', ');
      indexes.push(index.origin === 'u'
        ? `${table} UNIQUE (${keys})`
        : `${index.name} ON ${table} (${keys})${index.unique ? ' UNIQUE' : ''}${index.partial ? ' WHERE ...' : ''}`);
    }
    for (const key of rows(db, 'SELECT "from", "table", "to", on_delete FROM pragma_foreign_key_list(?)', table)) {
      foreignKeys.push(`${table}.${key.from} -> ${key.table}.${key.to}${key.on_delete === 'NO ACTION' ? '' : ` ON DELETE ${key.on_delete}`}`);
    }
  }
  const triggers = rows(db, `SELECT name, tbl_name FROM sqlite_schema WHERE type = 'trigger'`).map((trigger) => `${trigger.name} ON ${trigger.tbl_name}`);
  return { columns, indexes: indexes.sort(), foreignKeys: foreignKeys.sort(), triggers: triggers.sort() };
}

/** Every schema object with its full SQL and column details, to compare two databases exactly. */
export function fullSchema(db) {
  const objects = rows(db, `SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name`);
  const columns = Object.fromEntries(tableNames(db).map((table) => [table, rows(db, 'SELECT * FROM pragma_table_xinfo(?)', table)]));
  return { objects, columns };
}

export function assertIntegrity(db) {
  assert.deepEqual(rows(db, 'PRAGMA foreign_key_check'), []);
  assert.deepEqual(rows(db, 'PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);
}

export const T = 1_700_000_000;

// Rows written by earlier releases, added right after the migration that introduced their tables. The
// core's test/migrations.test.mjs keeps its own copy for the chain through 0024.
export const seeds = {
  '0002_flowery_midnight': (db) => db.exec(`
    INSERT INTO galaxy_collections (id, name, slug, fields, created_at) VALUES ('col-posts', 'Posts', 'posts', '[]', ${T});
    INSERT INTO galaxy_entries (id, collection_id, slug, status, data, created_at, updated_at, published_at) VALUES
      ('post-published', 'col-posts', 'hello', 'published', '{"title":"Hello"}', ${T}, ${T + 100}, ${T + 100}),
      ('post-draft', 'col-posts', 'draft', 'draft', '{"title":"Draft"}', ${T}, ${T}, NULL),
      ('post-archived', 'col-posts', 'old', 'archived', '{"title":"Old"}', ${T}, ${T}, NULL);
    INSERT INTO galaxy_globals (id, name, slug, data, created_at, updated_at) VALUES
      ('g-object', 'Site', 'site', '{"title":"Site"}', ${T}, ${T}),
      ('g-wrapped', 'Theme', 'theme', json_quote('{"mode":"dark"}'), ${T}, ${T}),
      ('g-wrapped-array', 'List', 'list', json_quote('[1,2]'), ${T}, ${T}),
      ('g-invalid', 'Broken', 'broken', 'not json', ${T}, ${T});
    INSERT INTO galaxy_media (id, filename, mime_type, size_bytes, url, created_at) VALUES
      ('media-1', 'frame.png', 'image/png', 1024, '/api/media/media-1', ${T});
  `),
  '0004_ecommerce_plugin': (db) => db.exec(`
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
  `),
  '0007_local_auth': (db) => db.exec(`
    INSERT INTO galaxy_auth_user (id, name, email, created_at, updated_at, role) VALUES
      ('admin-1', 'Admin', 'Admin@Example.com', ${T}, ${T}, 'admin'),
      ('editor-1', 'Editor', 'editor@example.com', ${T}, ${T}, 'editor');
    INSERT INTO galaxy_auth_account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES
      ('acc-1', 'admin-1', 'credential', 'admin-1', 'hash', ${T}, ${T});
    INSERT INTO galaxy_auth_session (id, expires_at, token, created_at, updated_at, user_id) VALUES
      ('sess-1', ${T + 86_400}, 'token-1', ${T}, ${T}, 'admin-1');
  `),
  // A checkout left pending, as releases since 0011 wrote it.
  '0011_order_payment_provider': (db) => db.exec(`
    INSERT INTO _ecommerce_orders (id, status, items, total_amount, checkout_session_id, payment_provider, created_at, updated_at) VALUES
      ('order-pending', 'pending', '[]', 4000, 'cs_test_pending', 'stripe', ${T + 40}, ${T + 40});
  `),
  '0012_customer_accounts': (db) => db.exec(`
    INSERT INTO _ecommerce_customer_accounts (id, email, email_normalized, email_verified_at, name, created_at, updated_at) VALUES
      ('shop-admin', 'Admin@Example.com', 'admin@example.com', ${T + 500}, 'Admin shopping', ${T}, ${T}),
      ('shop-new', 'New@Example.com', 'new@example.com', ${T + 500}, '  ', ${T}, ${T}),
      ('shop-unverified', 'x@example.com', 'x@example.com', NULL, 'X', ${T}, ${T});
    INSERT INTO _ecommerce_customer_sessions (id, account_id, token_hash, expires_at, created_at) VALUES
      ('cs-verified', 'shop-new', 'hash-1', ${T + 86_400}, ${T + 600}),
      ('cs-unverified', 'shop-unverified', 'hash-2', ${T + 86_400}, ${T + 600});
  `),
  // 0017 kept one shipment per order and set a shipped order to 'fulfilled'; a refund after that
  // replaced the status. An order could also read 'fulfilled' without a shipment record.
  '0017_commerce_fulfillment': (db) => db.exec(`
    INSERT INTO _ecommerce_orders (id, status, items, total_amount, payment_provider, created_at, updated_at) VALUES
      ('order-shipped', 'paid', '[]', 9000, 'stripe', ${T + 10}, ${T + 10}),
      ('order-shipped-refunded', 'paid', '[]', 9000, 'stripe', ${T + 20}, ${T + 20}),
      ('order-marked-fulfilled', 'fulfilled', '[]', 9000, NULL, ${T + 30}, ${T + 30});
    INSERT INTO _ecommerce_fulfillments (id, order_id, admin_actor, carrier, tracking_number, note, created_at) VALUES
      ('ful-shipped', 'order-shipped', 'admin-1', 'USPS', 'TRACK-1', 'Packed and shipped', ${T + 100}),
      ('ful-refunded', 'order-shipped-refunded', 'admin-1', NULL, NULL, 'Handed to the courier', ${T + 200});
    UPDATE _ecommerce_orders SET status = 'partially_refunded', provider_refunded_cents = 1000, updated_at = ${T + 300}
      WHERE id = 'order-shipped-refunded';
  `),
  // Gift card rows as releases before 0027 wrote them: a partial refund held for review, a full refund
  // of an unspent card voided, and an administrator's card.
  '0015_gift_cards': (db) => db.exec(`
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
  `),
  // Seeds and imports wrote entries straight to D1, without revisions.
  '0019_shared_customer_identity': (db) => db.exec(`
    INSERT INTO galaxy_entries (id, collection_id, slug, status, data, created_at, updated_at) VALUES
      ('seed-published', 'col-posts', 'seeded', 'published', '{"title":"Seeded"}', ${T + 1000}, ${T + 1000}),
      ('seed-draft', 'col-posts', 'seeded-draft', 'draft', '{"title":"Seeded draft"}', ${T + 1000}, ${T + 1000});
  `),
};
