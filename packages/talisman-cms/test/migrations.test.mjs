import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { is } from 'drizzle-orm';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import * as coreSchema from '../dist/db/schema.js';
import { renderRichText } from '../dist/richtext.js';

// The SQL in drizzle/ is hand-written and applied by `wrangler d1 migrations apply`, which runs the
// .sql files in file-name order. meta/_journal.json lists the same files; nothing else reads it.
const drizzleDir = new URL('../drizzle/', import.meta.url);
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', drizzleDir), 'utf8'));
const tags = journal.entries.map((entry) => entry.tag);
const BASELINE = '0020_revision_baseline_and_globals';

function openDatabase() {
  const db = new DatabaseSync(':memory:');
  // D1 enforces foreign keys, so every migration must apply with them on.
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** Apply one migration atomically, as D1 does: a failing file leaves nothing behind. */
function applyMigration(db, tag) {
  const sql = readFileSync(new URL(`${tag}.sql`, drizzleDir), 'utf8');
  db.exec('BEGIN');
  try {
    db.exec(sql);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`${tag}: ${error.message}`, { cause: error });
  }
}

/** Apply the journal's migrations from `from` through `to` (inclusive), running `after[tag]` once each is applied. */
function migrate(db, { from = tags[0], to = tags.at(-1), after = {} } = {}) {
  for (const tag of tags.slice(tags.indexOf(from), tags.indexOf(to) + 1)) {
    applyMigration(db, tag);
    after[tag]?.(db);
  }
}

const rows = (db, sql, ...params) => db.prepare(sql).all(...params).map((row) => ({ ...row }));
const row = (db, sql, ...params) => rows(db, sql, ...params)[0];

function tableNames(db) {
  return rows(db, `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map(({ name }) => name);
}

/** A readable outline of the schema: columns, indexes and unique constraints, foreign keys and triggers. */
function outline(db) {
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
function fullSchema(db) {
  const objects = rows(db, `SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name`);
  const columns = Object.fromEntries(tableNames(db).map((table) => [table, rows(db, 'SELECT * FROM pragma_table_xinfo(?)', table)]));
  return { objects, columns };
}

function assertIntegrity(db) {
  assert.deepEqual(rows(db, 'PRAGMA foreign_key_check'), []);
  assert.deepEqual(rows(db, 'PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);
}

// The schema after 0020, which is the state 0.1.0 ships. Shipped migrations must not change; a new
// migration adds to the state after this one instead.
const expectedAt0020 = {
  columns: {
    _ecommerce_carts: 'id session_token user_id checkout_session_id items closed closed_at created_at updated_at version',
    _ecommerce_categories: 'id name slug description image parent_id created_at updated_at',
    _ecommerce_component_reservations: 'id order_id component_id quantity released_at',
    _ecommerce_components: 'id sku name quantity created_at updated_at',
    _ecommerce_credit_ledger: 'id account_id order_id kind amount_cents created_at',
    _ecommerce_customer_accounts: 'id email email_normalized email_verified_at name created_at updated_at credit_balance cms_user_id',
    _ecommerce_customer_sessions: 'id account_id order_id token_hash expires_at created_at revoked_at purpose',
    _ecommerce_customers: 'id name email stripe_customer_id user_id created_at updated_at',
    _ecommerce_discount_codes: 'code description type value remaining_cents max_discount_cents min_order_cents eligible_product_ids max_uses max_uses_per_customer first_order_only starts_at expires_at active created_at updated_at',
    _ecommerce_discount_redemptions: 'id code order_id account_id email_normalized amount_cents status created_at updated_at',
    _ecommerce_fulfillments: 'id order_id admin_actor carrier tracking_number note created_at',
    _ecommerce_gift_card_ledger: 'id card_id order_id purchase_id kind amount_cents created_at',
    _ecommerce_gift_card_order_refunds: 'order_id admin_actor reason created_at',
    _ecommerce_gift_card_purchases: 'id buyer_email amount_cents currency status provider_session_id payment_intent_id provider_refunded_cents access_token_hash created_at updated_at',
    _ecommerce_gift_card_redemptions: 'id card_id order_id amount_cents status created_at updated_at',
    _ecommerce_gift_card_refunds: 'id card_id order_id amount_cents admin_actor reason created_at',
    _ecommerce_gift_cards: 'id code_hash code_suffix encrypted_code source purchase_id admin_actor admin_reason initial_cents balance_cents currency status created_at updated_at',
    _ecommerce_inventory_reservations: 'id order_id target_type target_id quantity released_at',
    _ecommerce_orders: 'id cart_id user_id checkout_session_id status items total_amount currency customer_email shipping_address billing_address created_at updated_at payment_provider referral_code referral_reward_cents credit_applied subtotal_amount payment_intent_id provider_refunded_cents discount_code discount_amount gift_card_id gift_card_applied gift_card_refunded_cents',
    _ecommerce_payments: 'id order_id provider provider_id status amount created_at',
    _ecommerce_product_categories: 'product_id category_id',
    _ecommerce_product_tags: 'product_id tag_id',
    _ecommerce_product_variant_values: 'id product_variant_id value sku price_override created_at updated_at image',
    _ecommerce_product_variants: 'id product_id variant_id name sku price_override inventory_quantity created_at updated_at',
    _ecommerce_products: 'id name slug sku description images category_ids tag_ids base_price is_physical inventory_quantity type status created_at updated_at',
    _ecommerce_referral_codes: 'code account_id active created_at',
    _ecommerce_referral_settings: 'id enabled reward_cents min_order_cents attribution_days updated_at',
    _ecommerce_referrals: 'id code referrer_account_id referred_account_id order_id reward_cents currency status created_at updated_at',
    _ecommerce_stocks: 'id product_variant_value_id quantity created_at updated_at',
    _ecommerce_tags: 'id name color created_at updated_at',
    _ecommerce_variant_components: 'id product_variant_value_id component_id quantity created_at updated_at',
    _ecommerce_variants: 'id name created_at updated_at',
    galaxy_auth_account: 'id account_id provider_id user_id access_token refresh_token id_token access_token_expires_at refresh_token_expires_at scope password created_at updated_at',
    galaxy_auth_rate_limit: 'id key count last_request',
    galaxy_auth_session: 'id expires_at token created_at updated_at ip_address user_agent user_id impersonated_by auth_method',
    galaxy_auth_user: 'id name email email_verified image created_at updated_at role banned ban_reason ban_expires',
    galaxy_auth_verification: 'id identifier value expires_at created_at updated_at',
    galaxy_collections: 'id name slug description created_at fields',
    galaxy_entries: 'id collection_id slug status data created_at updated_at published_at published_data published_revision_id archived_at',
    galaxy_entry_revisions: 'id entry_id collection_id revision_number type status data created_at',
    galaxy_globals: 'id name slug description data created_at updated_at',
    galaxy_media: 'id filename mime_type size_bytes url created_at alt_text width height updated_at',
  },
  indexes: [
    '_ecommerce_carts_checkout_session_id_unique ON _ecommerce_carts (checkout_session_id) UNIQUE',
    '_ecommerce_carts_session_token_unique ON _ecommerce_carts (session_token) UNIQUE',
    '_ecommerce_carts_user_open_unique ON _ecommerce_carts (user_id) UNIQUE WHERE ...',
    '_ecommerce_categories_slug_unique ON _ecommerce_categories (slug) UNIQUE',
    '_ecommerce_components UNIQUE (sku)',
    '_ecommerce_credit_ledger UNIQUE (order_id, kind)',
    '_ecommerce_credit_ledger_account_idx ON _ecommerce_credit_ledger (account_id, created_at)',
    '_ecommerce_customer_accounts UNIQUE (email_normalized)',
    '_ecommerce_customer_accounts_cms_user_idx ON _ecommerce_customer_accounts (cms_user_id) UNIQUE WHERE ...',
    '_ecommerce_customer_sessions UNIQUE (order_id)',
    '_ecommerce_customer_sessions UNIQUE (token_hash)',
    '_ecommerce_customer_sessions_account_idx ON _ecommerce_customer_sessions (account_id)',
    '_ecommerce_customer_sessions_challenge_idx ON _ecommerce_customer_sessions (account_id, purpose, created_at)',
    '_ecommerce_customers_stripe_customer_id_unique ON _ecommerce_customers (stripe_customer_id) UNIQUE',
    '_ecommerce_discount_redemptions UNIQUE (order_id)',
    '_ecommerce_discount_redemptions_code_status_idx ON _ecommerce_discount_redemptions (code, status)',
    '_ecommerce_discount_redemptions_email_idx ON _ecommerce_discount_redemptions (code, email_normalized, status)',
    '_ecommerce_fulfillments UNIQUE (order_id)',
    '_ecommerce_gift_card_ledger_card_idx ON _ecommerce_gift_card_ledger (card_id, created_at)',
    '_ecommerce_gift_card_purchases UNIQUE (payment_intent_id)',
    '_ecommerce_gift_card_purchases UNIQUE (provider_session_id)',
    '_ecommerce_gift_card_redemptions UNIQUE (order_id)',
    '_ecommerce_gift_card_redemptions_card_idx ON _ecommerce_gift_card_redemptions (card_id, status)',
    '_ecommerce_gift_card_refunds_order_idx ON _ecommerce_gift_card_refunds (order_id)',
    '_ecommerce_gift_cards UNIQUE (code_hash)',
    '_ecommerce_gift_cards UNIQUE (purchase_id)',
    '_ecommerce_orders_cart_id_unique ON _ecommerce_orders (cart_id) UNIQUE',
    '_ecommerce_orders_payment_intent_unique ON _ecommerce_orders (payment_intent_id) UNIQUE',
    '_ecommerce_orders_user_idx ON _ecommerce_orders (user_id)',
    '_ecommerce_payments_provider_id_unique ON _ecommerce_payments (provider, provider_id) UNIQUE',
    '_ecommerce_product_variant_values_sku_unique ON _ecommerce_product_variant_values (sku) UNIQUE',
    '_ecommerce_product_variants_sku_unique ON _ecommerce_product_variants (sku) UNIQUE',
    '_ecommerce_products_slug_unique ON _ecommerce_products (slug) UNIQUE',
    '_ecommerce_referral_codes UNIQUE (account_id)',
    '_ecommerce_referrals UNIQUE (order_id)',
    '_ecommerce_referrals UNIQUE (referred_account_id)',
    '_ecommerce_referrals_referrer_idx ON _ecommerce_referrals (referrer_account_id, created_at)',
    '_ecommerce_stocks_product_variant_value_id_unique ON _ecommerce_stocks (product_variant_value_id) UNIQUE',
    '_ecommerce_tags_name_unique ON _ecommerce_tags (name) UNIQUE',
    '_ecommerce_variants_name_unique ON _ecommerce_variants (name) UNIQUE',
    'component_reservation_unique ON _ecommerce_component_reservations (order_id, component_id) UNIQUE',
    'galaxy_auth_account_user_idx ON galaxy_auth_account (user_id)',
    'galaxy_auth_rate_limit UNIQUE (key)',
    'galaxy_auth_session UNIQUE (token)',
    'galaxy_auth_session_user_idx ON galaxy_auth_session (user_id)',
    'galaxy_auth_user UNIQUE (email)',
    'galaxy_auth_user_email_lower_unique ON galaxy_auth_user (<expression>) UNIQUE',
    'galaxy_collections_slug_unique ON galaxy_collections (slug) UNIQUE',
    'galaxy_entries_collection_status_created_idx ON galaxy_entries (collection_id, status, created_at)',
    'galaxy_entries_collection_status_slug_idx ON galaxy_entries (collection_id, status, slug, created_at)',
    'galaxy_entry_revisions_entry_number_idx ON galaxy_entry_revisions (entry_id, revision_number) UNIQUE',
    'galaxy_globals_slug_unique ON galaxy_globals (slug) UNIQUE',
    'inventory_reservation_unique ON _ecommerce_inventory_reservations (order_id, target_type, target_id) UNIQUE',
    'variant_component_unique ON _ecommerce_variant_components (product_variant_value_id, component_id) UNIQUE',
  ],
  foreignKeys: [
    '_ecommerce_categories.parent_id -> _ecommerce_categories.id',
    '_ecommerce_component_reservations.component_id -> _ecommerce_components.id',
    '_ecommerce_component_reservations.order_id -> _ecommerce_orders.id',
    '_ecommerce_credit_ledger.account_id -> _ecommerce_customer_accounts.id',
    '_ecommerce_credit_ledger.order_id -> _ecommerce_orders.id',
    '_ecommerce_customer_accounts.cms_user_id -> galaxy_auth_user.id ON DELETE SET NULL',
    '_ecommerce_customer_sessions.account_id -> _ecommerce_customer_accounts.id ON DELETE CASCADE',
    '_ecommerce_discount_redemptions.account_id -> _ecommerce_customer_accounts.id',
    '_ecommerce_discount_redemptions.code -> _ecommerce_discount_codes.code',
    '_ecommerce_discount_redemptions.order_id -> _ecommerce_orders.id',
    '_ecommerce_fulfillments.order_id -> _ecommerce_orders.id',
    '_ecommerce_gift_card_ledger.card_id -> _ecommerce_gift_cards.id',
    '_ecommerce_gift_card_ledger.order_id -> _ecommerce_orders.id',
    '_ecommerce_gift_card_ledger.purchase_id -> _ecommerce_gift_card_purchases.id',
    '_ecommerce_gift_card_order_refunds.order_id -> _ecommerce_orders.id',
    '_ecommerce_gift_card_redemptions.card_id -> _ecommerce_gift_cards.id',
    '_ecommerce_gift_card_redemptions.order_id -> _ecommerce_orders.id',
    '_ecommerce_gift_card_refunds.card_id -> _ecommerce_gift_cards.id',
    '_ecommerce_gift_card_refunds.order_id -> _ecommerce_orders.id',
    '_ecommerce_gift_cards.purchase_id -> _ecommerce_gift_card_purchases.id',
    '_ecommerce_inventory_reservations.order_id -> _ecommerce_orders.id',
    '_ecommerce_orders.cart_id -> _ecommerce_carts.id',
    '_ecommerce_payments.order_id -> _ecommerce_orders.id',
    '_ecommerce_product_categories.category_id -> _ecommerce_categories.id',
    '_ecommerce_product_categories.product_id -> _ecommerce_products.id',
    '_ecommerce_product_tags.product_id -> _ecommerce_products.id',
    '_ecommerce_product_tags.tag_id -> _ecommerce_tags.id',
    '_ecommerce_product_variant_values.product_variant_id -> _ecommerce_product_variants.id',
    '_ecommerce_product_variants.product_id -> _ecommerce_products.id',
    '_ecommerce_product_variants.variant_id -> _ecommerce_variants.id',
    '_ecommerce_referral_codes.account_id -> _ecommerce_customer_accounts.id ON DELETE CASCADE',
    '_ecommerce_referrals.code -> _ecommerce_referral_codes.code',
    '_ecommerce_referrals.order_id -> _ecommerce_orders.id',
    '_ecommerce_referrals.referred_account_id -> _ecommerce_customer_accounts.id',
    '_ecommerce_referrals.referrer_account_id -> _ecommerce_customer_accounts.id',
    '_ecommerce_stocks.product_variant_value_id -> _ecommerce_product_variant_values.id',
    '_ecommerce_variant_components.component_id -> _ecommerce_components.id',
    '_ecommerce_variant_components.product_variant_value_id -> _ecommerce_product_variant_values.id',
    'galaxy_auth_account.user_id -> galaxy_auth_user.id ON DELETE CASCADE',
    'galaxy_auth_session.user_id -> galaxy_auth_user.id ON DELETE CASCADE',
    'galaxy_entries.collection_id -> galaxy_collections.id ON DELETE CASCADE',
    'galaxy_entry_revisions.collection_id -> galaxy_collections.id ON DELETE CASCADE',
    'galaxy_entry_revisions.entry_id -> galaxy_entries.id ON DELETE CASCADE',
  ],
  triggers: [
    '_ecommerce_credit_ledger_balance ON _ecommerce_credit_ledger',
    '_ecommerce_credit_reserve_guard ON _ecommerce_credit_ledger',
    '_ecommerce_discount_credit_release ON _ecommerce_discount_redemptions',
    '_ecommerce_discount_credit_reserve ON _ecommerce_discount_redemptions',
    '_ecommerce_discount_reserve_guard ON _ecommerce_discount_redemptions',
    '_ecommerce_fulfillment_complete ON _ecommerce_fulfillments',
    '_ecommerce_fulfillment_guard ON _ecommerce_fulfillments',
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
  ],
};

test('the journal lists every migration file once, in file-name order', () => {
  const files = readdirSync(drizzleDir).filter((name) => name.endsWith('.sql')).sort();
  assert.deepEqual(files, tags.map((tag) => `${tag}.sql`));
  journal.entries.forEach((entry, index) => {
    assert.equal(entry.idx, index, `${entry.tag}: idx`);
    assert.match(entry.tag, /^\d{4}_[a-z0-9_]+$/);
    assert.equal(Number(entry.tag.slice(0, 4)), index, `${entry.tag}: number does not match its position`);
    if (index > 0) assert.ok(entry.when > journal.entries[index - 1].when, `${entry.tag}: when is not after the previous entry`);
  });
  assert.ok(tags.includes(BASELINE));
});

test('an empty database migrates to the expected schema', () => {
  const db = openDatabase();
  try {
    let atBaseline;
    migrate(db, { after: { [BASELINE]: (current) => { atBaseline = outline(current); } } });
    assert.deepEqual(atBaseline, expectedAt0020);
    assertIntegrity(db);

    // The Drizzle schema the runtime queries must only name columns the migrations create.
    const columns = Object.fromEntries(tableNames(db).map((table) => [table, new Set(rows(db, 'SELECT name FROM pragma_table_info(?)', table).map(({ name }) => name))]));
    const tables = Object.values(coreSchema).filter((value) => is(value, SQLiteTable));
    assert.ok(tables.length >= 5);
    for (const table of tables) {
      const { name, columns: declared } = getTableConfig(table);
      assert.ok(columns[name], `${name} is declared in src/db/schema.ts but no migration creates it`);
      for (const column of declared) assert.ok(columns[name].has(column.name), `${name}.${column.name} is declared but no migration creates it`);
    }
  } finally {
    db.close();
  }
});

const T = 1_700_000_000;

// Rows written by earlier releases, added right after the migration that introduced their tables.
const seeds = {
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

test('a database with data from earlier releases upgrades cleanly', () => {
  const db = openDatabase();
  const empty = openDatabase();
  try {
    migrate(db, { to: BASELINE, after: seeds });
    assertIntegrity(db);

    // 0003 and 0020: every entry has revision 1, and published entries point at their snapshot.
    assert.deepEqual(rows(db, `SELECT e.id, e.published_revision_id, e.published_data = e.data AS pinned, r.id AS revision, r.type, r.created_at
      FROM galaxy_entries e JOIN galaxy_entry_revisions r ON r.entry_id = e.id ORDER BY e.id`), [
      { id: 'post-archived', published_revision_id: null, pinned: null, revision: 'migrated_rev_post-archived', type: 'archive', created_at: T },
      { id: 'post-draft', published_revision_id: null, pinned: null, revision: 'migrated_rev_post-draft', type: 'draft_save', created_at: T },
      { id: 'post-published', published_revision_id: 'migrated_rev_post-published', pinned: 1, revision: 'migrated_rev_post-published', type: 'publish', created_at: T },
      { id: 'seed-draft', published_revision_id: null, pinned: null, revision: 'baseline_rev_seed-draft', type: 'draft_save', created_at: T + 1000 },
      { id: 'seed-published', published_revision_id: 'baseline_rev_seed-published', pinned: 1, revision: 'baseline_rev_seed-published', type: 'publish', created_at: T + 1000 },
    ]);
    // 0018: revision numbers are unique per entry.
    assert.throws(() => db.exec(`INSERT INTO galaxy_entry_revisions (id, entry_id, collection_id, revision_number, type, status, data, created_at)
      VALUES ('dup', 'post-draft', 'col-posts', 1, 'draft_save', 'draft', '{}', ${T})`), /UNIQUE constraint failed/);

    // 0020: only globals stored as a JSON string holding an object are unwrapped.
    assert.deepEqual(rows(db, 'SELECT id, data FROM galaxy_globals ORDER BY id'), [
      { id: 'g-invalid', data: 'not json' },
      { id: 'g-object', data: '{"title":"Site"}' },
      { id: 'g-wrapped', data: '{"mode":"dark"}' },
      { id: 'g-wrapped-array', data: '"[1,2]"' },
    ]);
    assert.deepEqual(row(db, `SELECT alt_text, width, height, updated_at FROM galaxy_media WHERE id = 'media-1'`),
      { alt_text: null, width: null, height: null, updated_at: null });

    // 0016: open sessions of unverified shoppers are revoked.
    assert.deepEqual(rows(db, 'SELECT id, purpose, revoked_at IS NOT NULL AS revoked FROM _ecommerce_customer_sessions ORDER BY id'), [
      { id: 'cs-unverified', purpose: 'session', revoked: 1 },
      { id: 'cs-verified', purpose: 'session', revoked: 0 },
    ]);

    // 0019: emails are lowercased and verified shoppers share a CMS identity.
    assert.equal(row(db, `SELECT email FROM galaxy_auth_user WHERE id = 'admin-1'`).email, 'admin@example.com');
    const { id: shopperId, ...shopper } = row(db, `SELECT id, name, email, email_verified, role FROM galaxy_auth_user WHERE email = 'new@example.com'`);
    assert.match(shopperId, /^shopper_[0-9a-f]{32}$/);
    assert.deepEqual(shopper, { name: 'new@example.com', email: 'new@example.com', email_verified: 1, role: 'customer' });
    assert.deepEqual(rows(db, 'SELECT id, cms_user_id FROM _ecommerce_customer_accounts ORDER BY id'), [
      { id: 'shop-admin', cms_user_id: 'admin-1' },
      { id: 'shop-new', cms_user_id: shopperId },
      { id: 'shop-unverified', cms_user_id: null },
    ]);
    assert.equal(row(db, `SELECT auth_method FROM galaxy_auth_session WHERE id = 'sess-1'`).auth_method, null);

    // Commerce rows keep their values and pick up the later columns' defaults.
    assert.deepEqual(row(db, `SELECT status, total_amount, subtotal_amount, discount_amount, gift_card_applied, payment_provider FROM _ecommerce_orders WHERE id = 'order-1'`),
      { status: 'paid', total_amount: 12000, subtotal_amount: 0, discount_amount: 0, gift_card_applied: 0, payment_provider: null });
    assert.equal(row(db, `SELECT version FROM _ecommerce_carts WHERE id = 'cart-1'`).version, 0);

    // Triggers from the migrations run against the migrated rows.
    assert.throws(() => db.exec(`UPDATE _ecommerce_stocks SET quantity = -1 WHERE id = 'stock-1'`), /Insufficient variant value stock/);
    db.exec(`INSERT INTO _ecommerce_credit_ledger (id, account_id, order_id, kind, amount_cents, created_at)
      VALUES ('ledger-1', 'shop-new', 'order-1', 'referral_award', 500, ${T + 2000})`);
    assert.equal(row(db, `SELECT credit_balance FROM _ecommerce_customer_accounts WHERE id = 'shop-new'`).credit_balance, 500);

    // Later migrations apply on top, and the result matches a fresh install.
    if (BASELINE !== tags.at(-1)) migrate(db, { from: tags[tags.indexOf(BASELINE) + 1] });
    assertIntegrity(db);
    // 0022: globals that are not a JSON object keep their value under "value".
    assert.deepEqual(rows(db, 'SELECT id, data FROM galaxy_globals ORDER BY id'), [
      { id: 'g-invalid', data: '{"value":"not json"}' },
      { id: 'g-object', data: '{"title":"Site"}' },
      { id: 'g-wrapped', data: '{"mode":"dark"}' },
      { id: 'g-wrapped-array', data: '{"value":[1,2]}' },
    ]);
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
    migrate(empty);
    assert.deepEqual(fullSchema(db), fullSchema(empty));
  } finally {
    db.close();
    empty.close();
  }
});

test('0026 lets an order ship in parcels and take appended corrections, with indexes for the orders queue', () => {
  const db = openDatabase();
  try {
    migrate(db);
    const schema = outline(db);
    assert.equal(schema.columns._ecommerce_fulfillments,
      'id order_id admin_actor carrier tracking_number note created_at kind corrects_id completes_order');
    assert.match(schema.columns._ecommerce_orders, / fulfillment_status$/);
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

// The pre-upgrade checks in the package README; each must return no rows before the migration.
const duplicateRevisionsCheck = `SELECT entry_id, revision_number, COUNT(*) AS copies FROM galaxy_entry_revisions
  GROUP BY entry_id, revision_number HAVING COUNT(*) > 1`;
const duplicateEmailsCheck = `SELECT lower(email) AS email, COUNT(*) AS copies FROM galaxy_auth_user
  GROUP BY lower(email) HAVING COUNT(*) > 1`;

test('the README pre-upgrade checks find the rows that stop 0018 and 0019, which then change nothing', () => {
  const db = openDatabase();
  try {
    migrate(db, { to: '0017_commerce_fulfillment', after: { '0002_flowery_midnight': seeds['0002_flowery_midnight'] } });
    db.exec(`INSERT INTO galaxy_entry_revisions (id, entry_id, collection_id, revision_number, type, status, data, created_at)
      VALUES ('rev-copy', 'post-draft', 'col-posts', 1, 'draft_save', 'draft', '{}', ${T})`);
    assert.deepEqual(rows(db, duplicateRevisionsCheck), [{ entry_id: 'post-draft', revision_number: 1, copies: 2 }]);
    assert.throws(() => applyMigration(db, '0018_entry_revision_integrity'), /0018_entry_revision_integrity: UNIQUE constraint failed/);
    db.exec(`DELETE FROM galaxy_entry_revisions WHERE id = 'rev-copy'`);
    applyMigration(db, '0018_entry_revision_integrity');

    db.exec(`INSERT INTO galaxy_auth_user (id, name, email, created_at, updated_at) VALUES
      ('u-1', 'One', 'Jakob@Example.com', ${T}, ${T}), ('u-2', 'Two', 'jakob@example.com', ${T}, ${T})`);
    assert.deepEqual(rows(db, duplicateEmailsCheck), [{ email: 'jakob@example.com', copies: 2 }]);
    assert.throws(() => applyMigration(db, '0019_shared_customer_identity'), /0019_shared_customer_identity: UNIQUE constraint failed/);
    assert.ok(!rows(db, 'SELECT name FROM pragma_table_info(?)', 'galaxy_auth_session').some(({ name }) => name === 'auth_method'), '0019 was rolled back');
    db.exec(`DELETE FROM galaxy_auth_user WHERE id = 'u-2'`);
    applyMigration(db, '0019_shared_customer_identity');
    assert.equal(row(db, `SELECT email FROM galaxy_auth_user WHERE id = 'u-1'`).email, 'jakob@example.com');
  } finally {
    db.close();
  }
});

test('0022 keeps globals that are not a JSON object under "value" and leaves ones that read as objects', () => {
  const db = openDatabase();
  try {
    migrate(db, { to: '0021_entry_draft_slug' });
    const globals = {
      object: `'{"a":1}'`,
      'encoded-object': `json_quote('{"a":1}')`,
      'twice-encoded-object': `json_quote(json_quote('{"a":1}'))`,
      array: `'[1,2]'`,
      'encoded-array': `json_quote('[1,2]')`,
      'twice-encoded-array': `json_quote(json_quote('[1,2]'))`,
      number: `'42'`,
      'encoded-number': `json_quote('42')`,
      'null': `'null'`,
      'true': `'true'`,
      text: `json_quote('hello')`,
      'encoded-text': `json_quote(json_quote('hello'))`,
      invalid: `'{broken'`,
    };
    for (const [slug, value] of Object.entries(globals)) {
      db.exec(`INSERT INTO galaxy_globals (id, name, slug, data, created_at, updated_at) VALUES ('${slug}', '${slug}', '${slug}', ${value}, ${T}, ${T})`);
    }
    const before = Object.fromEntries(rows(db, 'SELECT slug, data FROM galaxy_globals').map(({ slug, data }) => [slug, data]));
    // The review query from the migration lists every row that is not stored as an object.
    const reviewed = rows(db, `SELECT slug FROM galaxy_globals WHERE CASE WHEN json_valid(data) THEN json_type(data) <> 'object' ELSE 1 END ORDER BY slug`);
    assert.deepEqual(reviewed.map(({ slug }) => slug), Object.keys(globals).filter((slug) => slug !== 'object').sort());

    applyMigration(db, '0022_wrap_non_object_globals');
    const after = () => Object.fromEntries(rows(db, 'SELECT slug, data FROM galaxy_globals').map(({ slug, data }) => [slug, data]));
    const migrated = after();
    // Rows that the runtime already reads as an object stay as they are.
    for (const slug of ['object', 'encoded-object', 'twice-encoded-object']) assert.equal(migrated[slug], before[slug], slug);
    assert.deepEqual(Object.fromEntries(Object.entries(migrated).filter(([slug]) => !slug.includes('object'))
      .map(([slug, data]) => [slug, JSON.parse(data)])), {
      array: { value: [1, 2] },
      'encoded-array': { value: [1, 2] },
      'twice-encoded-array': { value: [1, 2] },
      number: { value: 42 },
      'encoded-number': { value: 42 },
      'null': { value: null },
      'true': { value: true },
      text: { value: 'hello' },
      'encoded-text': { value: 'hello' },
      invalid: { value: '{broken' },
    });

    applyMigration(db, '0022_wrap_non_object_globals');
    assert.deepEqual(after(), migrated);
  } finally {
    db.close();
  }
});

// The check to run before 0023; it must return no rows.
const duplicatePublishedSlugsCheck = `SELECT collection_id, slug, COUNT(*) AS copies FROM galaxy_entries
  WHERE status = 'published' GROUP BY collection_id, slug HAVING COUNT(*) > 1`;

test('0023 lets one published entry per collection serve a slug, and its check finds the rows that stop it', () => {
  const db = openDatabase();
  try {
    migrate(db, { to: '0022_wrap_non_object_globals', after: { '0002_flowery_midnight': seeds['0002_flowery_midnight'] } });
    db.exec(`INSERT INTO galaxy_collections (id, name, slug, fields, created_at) VALUES ('col-pages', 'Pages', 'pages', '[]', ${T});
      INSERT INTO galaxy_entries (id, collection_id, slug, status, data, created_at, updated_at) VALUES
        ('hello-copy', 'col-posts', 'hello', 'published', '{}', ${T}, ${T}),
        ('hello-draft', 'col-posts', 'hello', 'draft', '{}', ${T}, ${T}),
        ('hello-page', 'col-pages', 'hello', 'published', '{}', ${T}, ${T});`);
    assert.deepEqual(rows(db, duplicatePublishedSlugsCheck), [{ collection_id: 'col-posts', slug: 'hello', copies: 2 }]);
    assert.throws(() => applyMigration(db, '0023_published_slug_unique'),
      /0023_published_slug_unique: UNIQUE constraint failed: galaxy_entries\.collection_id, galaxy_entries\.slug/);

    db.exec(`UPDATE galaxy_entries SET slug = 'hello-2' WHERE id = 'hello-copy'`);
    assert.deepEqual(rows(db, duplicatePublishedSlugsCheck), []);
    applyMigration(db, '0023_published_slug_unique');
    // Drafts, archived entries and other collections may still share the slug; a second live copy may not.
    db.exec(`UPDATE galaxy_entries SET status = 'archived' WHERE id = 'post-published'`);
    db.exec(`UPDATE galaxy_entries SET slug = 'hello', status = 'published' WHERE id = 'hello-copy'`);
    assert.throws(() => db.exec(`UPDATE galaxy_entries SET status = 'published' WHERE id = 'hello-draft'`),
      /UNIQUE constraint failed: galaxy_entries\.collection_id, galaxy_entries\.slug/);
  } finally {
    db.close();
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

test('the ecommerce demo seed applies to the migrated schema and stores post content as Tiptap JSON', () => {
  const db = openDatabase();
  try {
    migrate(db);
    db.exec(readFileSync(new URL('../seeds/ecommerce-demo.sql', import.meta.url), 'utf8'));
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
  } finally {
    db.close();
  }
});
