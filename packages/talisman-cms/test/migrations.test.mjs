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
    migrate(empty);
    assert.deepEqual(fullSchema(db), fullSchema(empty));
  } finally {
    db.close();
    empty.close();
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
