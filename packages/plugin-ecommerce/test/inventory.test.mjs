import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyAllMigrations } from './helpers/migrations.mjs';

// The admin variants route and the core's API handler read their bindings from cloudflare:workers and
// ask the CMS auth adapter for the user. The handler ships as source and imports Astro virtual modules,
// so it is loaded with Node's type stripping, as the core's own tests do.
const canLoadCoreSource = Boolean(process.features.typescript) && typeof registerHooks === 'function';
const needsCoreSource = canLoadCoreSource ? false : 'needs Node type stripping and module.registerHooks';

const runtime = globalThis.__inventoryTest = { env: {}, user: null, collections: [], nativeSchemas: {} };
const stubs = {
  'cloudflare:workers': 'export const env = new Proxy({}, { get: (_, key) => globalThis.__inventoryTest.env[key] });',
  'virtual:talisman-cms/auth': 'export const authConfigured = true;'
    + ' export const authAdapter = { async getUser() { return globalThis.__inventoryTest.user; } };',
  'virtual:talisman-cms/config': 'const t = globalThis.__inventoryTest; export const adminPath = "/admin";'
    + ' export const collections = t.collections; export const globals = []; export const uiLibraries = [];'
    + ' export const publishing = {};',
  'virtual:talisman-cms/ui-libraries': 'export const uiLibraries = [];',
  'virtual:talisman-cms/native-schemas': 'export const nativeSchemas = globalThis.__inventoryTest.nativeSchemas;'
    + ' export const nativeSchemaConfig = {};',
  'virtual:talisman-cms/collection-hooks': 'export const collectionHooks = {};',
};
const coreSource = new URL('../../talisman-cms/src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(stubs, specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    }
    if (context.parentURL?.startsWith(coreSource) && specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { bindCommerceApi } = await import('../dist/api.js');
const { deleteVariantGroup, deleteVariantValue, saveVariantValue } = await import('../dist/variants.js');
const variantsRoute = (await import('../dist/routes/ecommerce-admin-variants.js')).ALL;
const { ecommercePlugin } = await import('../dist/index.js');
const schema = await import('../dist/schema.js');
const { getClient } = await import('talisman-cms/client');
const cmsApi = canLoadCoreSource ? (await import('../../talisman-cms/src/api/handler.ts')).ALL : null;

// The core's admin API serves the plugin's commerce collections as native records.
for (const collection of ecommercePlugin().onInit({ collections: [] }).collections) {
  if (collection.nativeSchemaMapping?.schemaPath !== '@talisman-cms/plugin-ecommerce/schema') continue;
  runtime.collections.push(collection);
  runtime.nativeSchemas[collection.slug] = schema[collection.nativeSchemaMapping.exportName];
}

const ORIGIN = 'https://shop.test';
const STALE_MESSAGE = 'This record changed since it was opened. Reload it before saving.';
const admin = { id: 'admin-1', email: 'admin@example.test', role: 'admin' };
const editor = { id: 'editor-1', email: 'editor@example.test', role: 'editor' };

/** Every migration, as a site applies them, behind a D1 stand-in that counts statements and parameters. */
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(sqlite);
  const usage = { statements: 0, maxParams: 0 };
  const DB = {
    prepare(sql) {
      usage.statements += 1;
      const prepared = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...params) {
          // D1 refuses a statement with more than 100 bound parameters.
          if (params.length > 100) throw new Error('D1_ERROR: too many SQL variables: SQLITE_ERROR');
          usage.maxParams = Math.max(usage.maxParams, params.length);
          values = params;
          return this;
        },
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
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { sqlite, DB, usage };
}

const second = () => Math.floor(Date.now() / 1000);
const value = (sqlite, sql, ...params) => Object.values(sqlite.prepare(sql).get(...params) ?? {})[0];
const count = (sqlite, table) => value(sqlite, `SELECT COUNT(*) FROM ${table}`);
const address = { customerEmail: 'shopper@example.test', successUrl: `${ORIGIN}/checkout/success?order={ORDER_ID}`,
  cancelUrl: `${ORIGIN}/checkout/cancel?order={ORDER_ID}`,
  shippingAddress: { name: 'Test Shopper', line1: '1 Main St', city: 'Austin', postalCode: '78701', country: 'US' } };

function shop(DB) {
  return bindCommerceApi({ env: { DB }, paymentAdapters: [{
    providerId: 'test',
    async createCheckoutSession({ orderId }) {
      return { providerSessionId: `session-${orderId}`, url: `${ORIGIN}/pay/${orderId}` };
    },
    async expireCheckoutSession() {},
  }] });
}

const LINE_KINDS = ['parts', 'stock', 'legacy', 'plain'];

/**
 * `count` active products, sold in turn as a value with a bill of materials (a frame of its own and a
 * lens pair every such value shares), a value with its own stock row, a legacy group without values,
 * and a plain product. Every stock row is stamped `stamp`. Returns one basket line per product.
 */
function seedCatalog(sqlite, count, stamp = second()) {
  sqlite.prepare(`INSERT INTO _ecommerce_components (id, sku, name, quantity, created_at, updated_at)
    VALUES ('lens', 'LENS', 'Lens pair', 1000, ?, ?)`).run(stamp, stamp);
  sqlite.prepare(`INSERT INTO _ecommerce_variants (id, name, created_at, updated_at) VALUES ('tint', 'Tint', ?, ?)`)
    .run(stamp, stamp);
  const lines = [];
  for (let index = 0; index < count; index++) {
    const kind = LINE_KINDS[index % LINE_KINDS.length];
    const id = `p${index}`;
    sqlite.prepare(`INSERT INTO _ecommerce_products (id, name, slug, base_price, inventory_quantity, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 100, 'active', ?, ?)`).run(id, `Product ${index}`, id, 1000 + index, stamp, stamp);
    if (kind === 'plain') {
      lines.push({ productId: id, quantity: 1 });
      continue;
    }
    sqlite.prepare(`INSERT INTO _ecommerce_product_variants (id, product_id, variant_id, name, inventory_quantity, created_at, updated_at)
      VALUES (?, ?, ?, 'Option', 100, ?, ?)`).run(`${id}-group`, id, kind === 'parts' ? 'tint' : null, stamp, stamp);
    if (kind === 'legacy') {
      lines.push({ productId: id, variantId: `${id}-group`, quantity: 1 });
      continue;
    }
    sqlite.prepare(`INSERT INTO _ecommerce_product_variant_values (id, product_variant_id, value, created_at, updated_at)
      VALUES (?, ?, 'Amber', ?, ?)`).run(`${id}-value`, `${id}-group`, stamp, stamp);
    if (kind === 'stock') {
      sqlite.prepare(`INSERT INTO _ecommerce_stocks (id, product_variant_value_id, quantity, created_at, updated_at)
        VALUES (?, ?, 100, ?, ?)`).run(`${id}-stock`, `${id}-value`, stamp, stamp);
    } else {
      sqlite.prepare(`INSERT INTO _ecommerce_components (id, sku, name, quantity, created_at, updated_at)
        VALUES (?, ?, ?, 100, ?, ?)`).run(`${id}-frame`, `FRAME-${index}`, `Frame ${index}`, stamp, stamp);
      for (const component of [`${id}-frame`, 'lens']) {
        sqlite.prepare(`INSERT INTO _ecommerce_variant_components
          (id, product_variant_value_id, component_id, quantity, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`)
          .run(`${id}-${component}`, `${id}-value`, component, stamp, stamp);
      }
    }
    lines.push({ productId: id, variantId: `${id}-value`, quantity: 1 });
  }
  return lines;
}

/** The statements a quote and a checkout of a basket of `lineCount` lines run. */
async function checkoutStatements(lineCount) {
  const { sqlite, DB, usage } = database();
  const lines = seedCatalog(sqlite, lineCount);
  const api = shop(DB);
  const cart = await api.carts.getOrCreate(`basket-${lineCount}`);
  await api.carts.updateItems(cart.id, lines);
  usage.statements = 0;
  const quote = await api.carts.quote(cart.id);
  const quoteStatements = usage.statements;
  usage.statements = 0;
  const { order } = await api.orders.createFromCart(cart.id, address);
  const checkout = { quote, order, quoteStatements, checkoutStatements: usage.statements, maxParams: usage.maxParams };
  const stock = {
    lens: value(sqlite, `SELECT quantity FROM _ecommerce_components WHERE id = 'lens'`),
    reservedComponents: count(sqlite, '_ecommerce_component_reservations'),
    reservedTargets: count(sqlite, '_ecommerce_inventory_reservations'),
    // Every held row goes from 100 to 99.
    notHeldOnce: value(sqlite, `SELECT COUNT(*) FROM (
      SELECT quantity FROM _ecommerce_components WHERE id <> 'lens'
      UNION ALL SELECT quantity FROM _ecommerce_stocks
      UNION ALL SELECT inventory_quantity FROM _ecommerce_product_variants WHERE id IN (
        SELECT target_id FROM _ecommerce_inventory_reservations WHERE target_type = 'variant')
      UNION ALL SELECT inventory_quantity FROM _ecommerce_products WHERE id IN (
        SELECT target_id FROM _ecommerce_inventory_reservations WHERE target_type = 'product')) WHERE quantity <> 99`),
  };
  sqlite.close();
  return { ...checkout, stock };
}

test('a quote and a checkout run the same statements for a 50-line basket as for a 4-line one', async () => {
  const small = await checkoutStatements(LINE_KINDS.length);
  const large = await checkoutStatements(50);

  assert.equal(large.quote.lines.length, 50);
  assert.equal(large.quote.totalAmount, Array.from({ length: 50 }, (_, index) => 1000 + index).reduce((a, b) => a + b));
  assert.equal(large.quote.lines[0].name, 'Product 0 - Tint: Amber');
  assert.equal(large.quote.lines[1].name, 'Product 1 - Option: Amber');
  assert.equal(large.quote.lines[2].name, 'Product 2 - Option');
  assert.equal(large.order.totalAmount, large.quote.totalAmount);

  // The cart read and one batch of three catalog reads (products with their groups, values with their
  // stock and parts, groups with values), whatever the number of lines.
  assert.equal(small.quoteStatements, 4);
  assert.equal(large.quoteStatements, small.quoteStatements);
  // Checkout adds the referral settings, the basket lock, one write batch with a statement per stock
  // table, and the order read.
  assert.equal(large.checkoutStatements, small.checkoutStatements);
  assert.ok(large.checkoutStatements <= 17, `checkout ran ${large.checkoutStatements} statements`);
  assert.ok(large.maxParams <= 90, `a statement bound ${large.maxParams} parameters`);

  // 13 values use a frame of their own and the shared lens pair; 13 stock rows, 12 legacy groups and
  // 12 plain products are each held once.
  assert.equal(large.stock.lens, 1000 - 13);
  assert.equal(large.stock.reservedComponents, 13 + 1);
  assert.equal(large.stock.reservedTargets, 13 + 12 + 12);
  assert.equal(large.stock.notHeldOnce, 0);
});

test('a basket stored with more lines than one statement can bind is still quoted in chunks', async () => {
  const { sqlite, DB, usage } = database();
  const lines = seedCatalog(sqlite, 240).filter((line, index) => ['stock', 'plain'].includes(LINE_KINDS[index % 4]));
  assert.equal(lines.length, 120);
  // Written directly, as a basket saved before the line limit would be.
  const stamp = second();
  sqlite.prepare(`INSERT INTO _ecommerce_carts (id, session_token, items, created_at, updated_at) VALUES ('legacy', 'legacy', ?, ?, ?)`)
    .run(JSON.stringify(lines), stamp, stamp);
  usage.statements = 0;
  const quote = await shop(DB).carts.quote('legacy');
  assert.equal(quote.lines.length, 120);
  assert.equal(quote.totalAmount, lines.reduce((total, line) => total + 1000 + Number(line.productId.slice(1)), 0));
  assert.ok(usage.maxParams <= 90, `a statement bound ${usage.maxParams} parameters`);
  // Products with their groups in two chunks of 80 ids, the 60 values and the groups among them in one each.
  assert.equal(usage.statements, 1 + 2 + 1 + 1);
  sqlite.close();
});

test('the batched quote keeps the checks and messages of the line-by-line one', async () => {
  const { sqlite, DB } = database();
  const lines = seedCatalog(sqlite, 4);
  const api = shop(DB);
  const cart = await api.carts.getOrCreate('checks');
  const quoteWith = async (items) => {
    sqlite.prepare('UPDATE _ecommerce_carts SET items = ? WHERE id = ?').run(JSON.stringify(items), cart.id);
    return api.carts.quote(cart.id);
  };
  const checkoutWith = async (items) => {
    sqlite.prepare('UPDATE _ecommerce_carts SET items = ? WHERE id = ?').run(JSON.stringify(items), cart.id);
    return api.orders.createFromCart(cart.id, address);
  };

  await assert.rejects(quoteWith([{ productId: 'missing', quantity: 1 }]), /^Error: Product is not available: missing$/);
  await assert.rejects(checkoutWith([{ productId: 'missing', quantity: 1 }]), /^Error: Product not found: missing$/);
  // A value or a legacy group of another product is not found, whether or not that product is in the basket.
  await assert.rejects(quoteWith([{ productId: 'p0', variantId: 'p1-value', quantity: 1 }]),
    /Variant value not found or mismatch: p1-value/);
  await assert.rejects(quoteWith([lines[1], { productId: 'p0', variantId: 'p1-value', quantity: 1 }]),
    /Variant value not found or mismatch: p1-value/);
  await assert.rejects(quoteWith([{ productId: 'p0', variantId: 'p2-group', quantity: 1 }]),
    /Variant not found or mismatch: p2-group/);
  // A group with values is no choice, and neither is a missing variant.
  await assert.rejects(quoteWith([{ productId: 'p0', variantId: 'p0-group', quantity: 1 }]), /Select an option for Product 0/);
  await assert.rejects(quoteWith([{ productId: 'p1', quantity: 1 }]), /Select an option for Product 1/);
  // The first failing line in basket order decides the message.
  await assert.rejects(quoteWith([lines[3], { productId: 'p1', quantity: 1 }, { productId: 'missing', quantity: 1 }]),
    /Select an option for Product 1/);
  // Demand for a shared component is summed across lines.
  sqlite.exec(`UPDATE _ecommerce_components SET quantity = 1 WHERE id = 'lens'`);
  sqlite.prepare(`INSERT INTO _ecommerce_products (id, name, slug, base_price, status, created_at, updated_at)
    VALUES ('p4', 'Product 4', 'p4', 1004, 'active', 0, 0)`).run();
  sqlite.prepare(`INSERT INTO _ecommerce_product_variants (id, product_id, name, created_at, updated_at) VALUES ('p4-group', 'p4', 'Option', 0, 0)`).run();
  sqlite.prepare(`INSERT INTO _ecommerce_product_variant_values (id, product_variant_id, value, created_at, updated_at) VALUES ('p4-value', 'p4-group', 'Amber', 0, 0)`).run();
  sqlite.prepare(`INSERT INTO _ecommerce_variant_components (id, product_variant_value_id, component_id, quantity, created_at, updated_at)
    VALUES ('p4-lens', 'p4-value', 'lens', 1, 0, 0)`).run();
  await assert.rejects(quoteWith([lines[0], { productId: 'p4', variantId: 'p4-value', quantity: 1 }]),
    /Insufficient stock for component Lens pair/);
  await assert.rejects(checkoutWith([lines[0], { productId: 'p4', variantId: 'p4-value', quantity: 1 }]),
    /Insufficient stock for component Lens pair/);
  await assert.rejects(quoteWith([{ productId: 'p1', variantId: 'p1-value', quantity: 101 }]), /Insufficient stock for Product 1 - Option: Amber/);
  assert.equal(count(sqlite, '_ecommerce_orders'), 0);
  sqlite.close();
});

test('checkout reservations and releases move every stock row\'s updated_at, even within one second', async (t) => {
  const stamp = second();
  t.mock.timers.enable({ apis: ['Date'], now: stamp * 1000 + 500 });
  const { sqlite, DB } = database();
  const lines = seedCatalog(sqlite, 4, stamp);
  // A row last written earlier moves to the current second.
  sqlite.prepare(`UPDATE _ecommerce_products SET updated_at = ? WHERE id = 'p3'`).run(stamp - 100);
  const api = shop(DB);
  const cart = await api.carts.getOrCreate('tokens');
  await api.carts.updateItems(cart.id, lines);
  const stamps = () => ({
    lens: value(sqlite, `SELECT updated_at FROM _ecommerce_components WHERE id = 'lens'`),
    frame: value(sqlite, `SELECT updated_at FROM _ecommerce_components WHERE id = 'p0-frame'`),
    stock: value(sqlite, `SELECT updated_at FROM _ecommerce_stocks WHERE id = 'p1-stock'`),
    group: value(sqlite, `SELECT updated_at FROM _ecommerce_product_variants WHERE id = 'p2-group'`),
    product: value(sqlite, `SELECT updated_at FROM _ecommerce_products WHERE id = 'p3'`),
  });

  const { order } = await api.orders.createFromCart(cart.id, address);
  assert.deepEqual(stamps(), { lens: stamp + 1, frame: stamp + 1, stock: stamp + 1, group: stamp + 1, product: stamp });
  await api.orders.cancel(order.id);
  assert.deepEqual(stamps(), { lens: stamp + 2, frame: stamp + 2, stock: stamp + 2, group: stamp + 2, product: stamp + 1 });
  assert.equal(value(sqlite, `SELECT quantity FROM _ecommerce_stocks WHERE id = 'p1-stock'`), 100);
  assert.equal(value(sqlite, `SELECT quantity FROM _ecommerce_components WHERE id = 'lens'`), 1000);
  sqlite.close();
});

test('a checkout aborts whole when a stock row runs out between its quote and its reservation', async () => {
  const { sqlite, DB } = database();
  const lines = seedCatalog(sqlite, 4);
  const api = bindCommerceApi({ env: { DB }, paymentAdapters: [{
    providerId: 'test',
    async createCheckoutSession({ orderId }) {
      // Another checkout takes the last units of p1's stock row while this one waits for the provider.
      sqlite.exec(`UPDATE _ecommerce_stocks SET quantity = 0 WHERE id = 'p1-stock'`);
      return { providerSessionId: `session-${orderId}`, url: `${ORIGIN}/pay/${orderId}` };
    },
    async expireCheckoutSession() {},
  }] });
  const cart = await api.carts.getOrCreate('race');
  await api.carts.updateItems(cart.id, lines);
  await assert.rejects(api.orders.createFromCart(cart.id, address), /^Error: Insufficient stock or checkout already started$/);
  // The stock trigger stops the whole batch: no order, no reservation, and every other row keeps its stock.
  assert.deepEqual([count(sqlite, '_ecommerce_orders'), count(sqlite, '_ecommerce_inventory_reservations'),
    count(sqlite, '_ecommerce_component_reservations')], [0, 0, 0]);
  assert.equal(value(sqlite, `SELECT quantity FROM _ecommerce_components WHERE id = 'lens'`), 1000);
  assert.equal(value(sqlite, `SELECT inventory_quantity FROM _ecommerce_products WHERE id = 'p3'`), 100);
  assert.equal(value(sqlite, 'SELECT checkout_session_id FROM _ecommerce_carts WHERE id = ?', cart.id), null);
  sqlite.close();
});

async function cms(method, path, body) {
  const request = new Request(`https://cms.test/admin/api${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await cmsApi({ request, locals: {} });
  return { status: response.status, body: await response.json() };
}

test('an admin save of stock loaded before a reservation in the same second gets 409', { skip: needsCoreSource }, async (t) => {
  const stamp = second();
  t.mock.timers.enable({ apis: ['Date'], now: stamp * 1000 + 200 });
  const { sqlite, DB } = database();
  const lines = seedCatalog(sqlite, 2, stamp);
  runtime.env = { DB };
  runtime.user = admin;

  // The admin opens the stock row of p1's value.
  const loaded = await cms('GET', '/collections/_ecommerce_stocks/entries/p1-stock');
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.data.quantity, 100);

  // In the same second, a shopper checks out one unit.
  const api = shop(DB);
  const cart = await api.carts.getOrCreate('same-second');
  await api.carts.updateItems(cart.id, [lines[1]]);
  await api.orders.createFromCart(cart.id, address);
  assert.equal(value(sqlite, `SELECT quantity FROM _ecommerce_stocks WHERE id = 'p1-stock'`), 99);

  // The admin's save still carries the quantity loaded before the reservation.
  const staleSave = { data: { productVariantValueId: 'p1-value', quantity: 100 }, expectedUpdatedAt: loaded.body.data.updatedAt };
  const refused = await cms('PUT', '/collections/_ecommerce_stocks/entries/p1-stock', staleSave);
  assert.deepEqual([refused.status, refused.body.error], [409, STALE_MESSAGE]);
  assert.equal(value(sqlite, `SELECT quantity FROM _ecommerce_stocks WHERE id = 'p1-stock'`), 99);

  // With updated_at left at the second the admin loaded, as reservations used to leave it, the same
  // save would have gone through and undone the reservation.
  sqlite.prepare(`UPDATE _ecommerce_stocks SET updated_at = ? WHERE id = 'p1-stock'`).run(stamp);
  assert.equal((await cms('PUT', '/collections/_ecommerce_stocks/entries/p1-stock', staleSave)).status, 200);
  assert.equal(value(sqlite, `SELECT quantity FROM _ecommerce_stocks WHERE id = 'p1-stock'`), 100);
  sqlite.close();
});

test('a stock token run minutes ahead by a burst of checkouts never moves back to one an admin holds', { skip: needsCoreSource }, async (t) => {
  const stamp = second();
  t.mock.timers.enable({ apis: ['Date'], now: stamp * 1000 + 200 });
  const { sqlite, DB } = database();
  const lines = seedCatalog(sqlite, 2, stamp);
  runtime.env = { DB };
  runtime.user = admin;
  const path = '/collections/_ecommerce_stocks/entries/p1-stock';
  const stockStamp = () => value(sqlite, `SELECT updated_at FROM _ecommerce_stocks WHERE id = 'p1-stock'`);

  // Admin A opens the stock row and leaves the tab open.
  const loadedByA = await cms('GET', path);
  assert.equal(loadedByA.status, 200);

  // Within the same second, 160 checkouts reserve and release the row. Each write moves updated_at
  // by a second, which runs it more than five minutes ahead of the clock.
  const api = shop(DB);
  const cart = await api.carts.getOrCreate('burst');
  await api.carts.updateItems(cart.id, [lines[1]]);
  for (let index = 0; index < 160; index += 1) {
    const { order } = await api.orders.createFromCart(cart.id, address);
    await api.orders.cancel(order.id);
  }
  assert.equal(stockStamp(), stamp + 320);

  // Admin B loads the row and saves a recount: the token moves on from the stamp B loaded.
  const loadedByB = await cms('GET', path);
  const recount = await cms('PUT', path, { data: { productVariantValueId: 'p1-value', quantity: 500 },
    expectedUpdatedAt: loadedByB.body.data.updatedAt });
  assert.equal(recount.status, 200);
  assert.equal(stockStamp(), stamp + 321);

  // A's save from before the burst is still stale, so it cannot overwrite B's recount.
  const staleSave = await cms('PUT', path, { data: { productVariantValueId: 'p1-value', quantity: 7 },
    expectedUpdatedAt: loadedByA.body.data.updatedAt });
  assert.deepEqual([staleSave.status, staleSave.body.error], [409, STALE_MESSAGE]);
  assert.equal(value(sqlite, `SELECT quantity FROM _ecommerce_stocks WHERE id = 'p1-stock'`), 500);
  sqlite.close();
});

// --- The variant configurator's endpoint ---------------------------------------------------------

/**
 * Frame, sold in two lens values: Amber with a stock row and a variant component row for a shared
 * lens pair, Smoke with a stock row only. Other has a lens group of its own. Every row is stamped `stamp`.
 */
function seedVariants(sqlite, stamp = second()) {
  for (const id of ['frame', 'other']) {
    sqlite.prepare(`INSERT INTO _ecommerce_products (id, name, slug, base_price, status, created_at, updated_at)
      VALUES (?, ?, ?, 12000, 'active', ?, ?)`).run(id, id === 'frame' ? 'Frame' : 'Other', id, stamp, stamp);
    sqlite.prepare(`INSERT INTO _ecommerce_product_variants (id, product_id, name, created_at, updated_at)
      VALUES (?, ?, 'Lens', ?, ?)`).run(`${id}-lens`, id, stamp, stamp);
  }
  for (const [id, group, label, sku, quantity] of [['frame-amber', 'frame-lens', 'Amber', 'FRAME-AMB', 5],
    ['frame-smoke', 'frame-lens', 'Smoke', 'FRAME-SMK', 3], ['other-amber', 'other-lens', 'Amber', 'OTHER-AMB', 2]]) {
    sqlite.prepare(`INSERT INTO _ecommerce_product_variant_values (id, product_variant_id, value, sku, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, group, label, sku, stamp, stamp);
    sqlite.prepare(`INSERT INTO _ecommerce_stocks (id, product_variant_value_id, quantity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(`${id}-stock`, id, quantity, stamp, stamp);
  }
  sqlite.prepare(`INSERT INTO _ecommerce_components (id, sku, name, quantity, created_at, updated_at)
    VALUES ('amber-lens', 'LENS-AMB', 'Amber lens pair', 10, ?, ?)`).run(stamp, stamp);
  for (const valueId of ['frame-amber', 'other-amber']) {
    sqlite.prepare(`INSERT INTO _ecommerce_variant_components
      (id, product_variant_value_id, component_id, quantity, created_at, updated_at) VALUES (?, ?, 'amber-lens', 1, ?, ?)`)
      .run(`${valueId}-lens`, valueId, stamp, stamp);
  }
}

/** The updatedAt an editor loads from the core API: the row's timestamp as JSON. */
const loadedAt = (seconds) => new Date(seconds * 1000).toISOString();
const valueRow = (sqlite, id) => ({ ...sqlite.prepare(`SELECT value, sku, image, price_override, updated_at
  FROM _ecommerce_product_variant_values WHERE id = ?`).get(id) });
const stockRow = (sqlite, id) => ({ ...sqlite.prepare(`SELECT id, quantity, updated_at FROM _ecommerce_stocks
  WHERE product_variant_value_id = ?`).get(id) });
const amber = { value: 'Amber', sku: 'FRAME-AMB', image: null, priceOverride: null };

async function postVariants(env, body, { user = admin, origin = ORIGIN, method = 'POST', raw } = {}) {
  runtime.env = env;
  runtime.user = user;
  const request = new Request(`${ORIGIN}/admin/api/ecommerce/variants`, {
    method, headers: { ...(origin ? { origin } : {}), 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : raw ?? JSON.stringify(body),
  });
  const response = await variantsRoute({ request });
  return { status: response.status, json: await response.json(), cacheControl: response.headers.get('cache-control') };
}

test('a new variant value is saved together with its stock row', async () => {
  const { sqlite, DB } = database();
  seedVariants(sqlite);
  const created = await saveVariantValue({ DB }, { groupId: 'frame-lens',
    value: { value: ' Rose ', sku: ' FRAME-ROS ', image: '', priceOverride: 13000 }, stock: { quantity: 4 } });
  assert.match(created.value.id, /^value_[0-9a-f-]{36}$/);
  assert.match(created.stock.id, /^stock_[0-9a-f-]{36}$/);
  assert.equal(created.stock.quantity, 4);
  const { updated_at: stamp, ...row } = valueRow(sqlite, created.value.id);
  assert.deepEqual(row, { value: 'Rose', sku: 'FRAME-ROS', image: null, price_override: 13000 });
  assert.equal(created.value.updatedAt, loadedAt(stamp));
  assert.deepEqual(stockRow(sqlite, created.value.id), { id: created.stock.id, quantity: 4, updated_at: stamp });

  // Without a quantity a new value still gets its stock row, empty.
  const bare = await saveVariantValue({ DB }, { groupId: 'frame-lens',
    value: { value: 'Clear', sku: null, image: null, priceOverride: null } });
  assert.equal(stockRow(sqlite, bare.value.id).quantity, 0);
  sqlite.close();
});

test('a failed stock write leaves no half-saved value, and a retry creates no duplicate', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const { sqlite, DB } = database();
  seedVariants(sqlite);
  sqlite.exec(`CREATE TRIGGER fail_stock_insert BEFORE INSERT ON _ecommerce_stocks
    BEGIN SELECT RAISE(ABORT, 'stock write failed'); END`);
  const change = { action: 'saveValue', groupId: 'frame-lens',
    value: { value: 'Rose', sku: 'FRAME-ROS', image: null, priceOverride: null }, stock: { quantity: 4 } };
  const failed = await postVariants({ DB }, change);
  assert.equal(failed.status, 500);
  assert.doesNotMatch(failed.json.error, /stock write failed|INSERT|_ecommerce/);
  assert.equal(logged.mock.calls[0].arguments[0], '[commerce] Variant change failed');
  assert.equal(value(sqlite, `SELECT COUNT(*) FROM _ecommerce_product_variant_values WHERE value = 'Rose'`), 0);

  sqlite.exec('DROP TRIGGER fail_stock_insert');
  const saved = await postVariants({ DB }, change);
  assert.equal(saved.status, 200);
  assert.equal(value(sqlite, `SELECT COUNT(*) FROM _ecommerce_product_variant_values WHERE value = 'Rose'`), 1);
  assert.equal(stockRow(sqlite, saved.json.result.value.id).quantity, 4);
  sqlite.close();
});

test('a value save checks both loaded tokens in its batch and writes nothing when one is stale', async (t) => {
  const stamp = second();
  t.mock.timers.enable({ apis: ['Date'], now: stamp * 1000 + 100 });
  const { sqlite, DB } = database();
  seedVariants(sqlite, stamp);
  const before = { value: valueRow(sqlite, 'frame-amber'), stock: stockRow(sqlite, 'frame-amber') };
  const unchanged = () => assert.deepEqual({ value: valueRow(sqlite, 'frame-amber'), stock: stockRow(sqlite, 'frame-amber') }, before);
  const save = (valueToken, stock) => saveVariantValue({ DB }, { groupId: 'frame-lens',
    value: { id: 'frame-amber', ...(valueToken === undefined ? {} : { expectedUpdatedAt: valueToken }), ...amber, value: 'Amber gold' },
    ...(stock ? { stock } : {}) });
  const stale = { status: 409, code: 'stale_record', message: STALE_MESSAGE };

  await assert.rejects(save(loadedAt(stamp - 1), { id: 'frame-amber-stock', expectedUpdatedAt: loadedAt(stamp), quantity: 9 }), stale);
  unchanged();
  // The value's token matches, so only the stock guard stops the batch, and the value keeps its label.
  await assert.rejects(save(loadedAt(stamp), { id: 'frame-amber-stock', expectedUpdatedAt: loadedAt(stamp - 1), quantity: 9 }), stale);
  unchanged();
  // The editor saw no stock row for the value, but one exists now.
  await assert.rejects(save(loadedAt(stamp), { quantity: 9 }), stale);
  unchanged();
  await assert.rejects(save(stamp * 1000 + 1), stale);
  await assert.rejects(save('not a date'), stale);
  await assert.rejects(save(undefined), { status: 428 });
  await assert.rejects(save(loadedAt(stamp), { id: 'frame-amber-stock', quantity: 9 }), { status: 428 });
  unchanged();

  // Fresh tokens save both, and both tokens move although the rows were written this second.
  const saved = await save(loadedAt(stamp), { id: 'frame-amber-stock', expectedUpdatedAt: stamp * 1000, quantity: 9 });
  assert.deepEqual(saved, { value: { id: 'frame-amber', updatedAt: loadedAt(stamp + 1) },
    stock: { id: 'frame-amber-stock', quantity: 9, updatedAt: loadedAt(stamp + 1) } });
  assert.equal(valueRow(sqlite, 'frame-amber').value, 'Amber gold');
  assert.equal(stockRow(sqlite, 'frame-amber').quantity, 9);

  // Without `stock` the quantity is not written, so a reservation made since the page loaded stays.
  sqlite.exec(`UPDATE _ecommerce_stocks SET quantity = quantity - 1 WHERE id = 'frame-amber-stock'`);
  await saveVariantValue({ DB }, { groupId: 'frame-lens',
    value: { id: 'frame-amber', expectedUpdatedAt: saved.value.updatedAt, ...amber } });
  assert.equal(stockRow(sqlite, 'frame-amber').quantity, 8);
  assert.equal(valueRow(sqlite, 'frame-amber').value, 'Amber');

  // A value that has no stock row yet gets one with the quantity sent.
  sqlite.exec(`DELETE FROM _ecommerce_stocks WHERE id = 'frame-smoke-stock'`);
  const smoke = await saveVariantValue({ DB }, { groupId: 'frame-lens', value: { id: 'frame-smoke',
    expectedUpdatedAt: loadedAt(stamp), value: 'Smoke', sku: 'FRAME-SMK', image: null, priceOverride: null }, stock: { quantity: 6 } });
  assert.equal(stockRow(sqlite, 'frame-smoke').quantity, 6);
  assert.equal(smoke.stock.quantity, 6);
  sqlite.close();
});

test('a value and stock row stamped in milliseconds by an older seed can still be saved', async () => {
  const { sqlite, DB } = database();
  seedVariants(sqlite);
  // The demo seed stores updated_at in milliseconds, which the core API serves as a far-future date.
  const legacy = 1_790_000_000_000;
  sqlite.prepare(`UPDATE _ecommerce_product_variant_values SET updated_at = ? WHERE id = 'frame-amber'`).run(legacy);
  sqlite.prepare(`UPDATE _ecommerce_stocks SET updated_at = ? WHERE id = 'frame-amber-stock'`).run(legacy);
  const change = { groupId: 'frame-lens', value: { id: 'frame-amber', expectedUpdatedAt: loadedAt(legacy), ...amber },
    stock: { id: 'frame-amber-stock', expectedUpdatedAt: loadedAt(legacy), quantity: 2 } };
  const saved = await saveVariantValue({ DB }, change);
  assert.deepEqual([saved.stock.quantity, valueRow(sqlite, 'frame-amber').updated_at, stockRow(sqlite, 'frame-amber').updated_at],
    [2, legacy + 1, legacy + 1]);
  await assert.rejects(saveVariantValue({ DB }, change), { status: 409, code: 'stale_record' });
  sqlite.close();
});

test('a value save refused by the database writes nothing', async () => {
  const { sqlite, DB } = database();
  seedVariants(sqlite);
  const values = count(sqlite, '_ecommerce_product_variant_values');
  const stocks = count(sqlite, '_ecommerce_stocks');
  await assert.rejects(saveVariantValue({ DB }, { groupId: 'frame-lens',
    value: { value: 'Rose', sku: 'FRAME-SMK', image: null, priceOverride: null }, stock: { quantity: 1 } }),
  { status: 409, message: 'Another record already uses this sku.' });
  // The group was deleted after the page loaded.
  await assert.rejects(saveVariantValue({ DB }, { groupId: 'gone',
    value: { value: 'Rose', sku: null, image: null, priceOverride: null }, stock: { quantity: 1 } }), { status: 409, code: 'stale_record' });
  await assert.rejects(saveVariantValue({ DB }, { groupId: 'frame-lens',
    value: { value: 'Rose', sku: null, image: null, priceOverride: 12.5 } }), /Price override must be a whole number in the smallest currency unit/);
  await assert.rejects(saveVariantValue({ DB }, { groupId: 'frame-lens',
    value: { value: 'Rose', sku: null, image: null, priceOverride: null }, stock: { quantity: -1 } }), /Stock cannot be negative/);
  assert.deepEqual([count(sqlite, '_ecommerce_product_variant_values'), count(sqlite, '_ecommerce_stocks')], [values, stocks]);
  sqlite.close();
});

test('deleting a value removes its stock row and variant component rows together', async () => {
  const { sqlite, DB } = database();
  seedVariants(sqlite);
  assert.deepEqual(await deleteVariantValue({ DB }, 'frame-amber'),
    { valueId: 'frame-amber', deleted: { values: 1, stockRows: 1, partRows: 1 } });
  assert.equal(value(sqlite, `SELECT COUNT(*) FROM _ecommerce_product_variant_values WHERE id = 'frame-amber'`), 0);
  assert.equal(value(sqlite, `SELECT COUNT(*) FROM _ecommerce_stocks WHERE id = 'frame-amber-stock'`), 0);
  assert.equal(value(sqlite, `SELECT COUNT(*) FROM _ecommerce_variant_components WHERE product_variant_value_id = 'frame-amber'`), 0);
  // The shared component and the other product's use of it stay.
  assert.equal(value(sqlite, `SELECT quantity FROM _ecommerce_components WHERE id = 'amber-lens'`), 10);
  assert.equal(count(sqlite, '_ecommerce_variant_components'), 1);
  await assert.rejects(deleteVariantValue({ DB }, 'frame-amber'), { status: 404 });
  sqlite.close();
});

test('deleting a group removes its values, their stock and variant component rows atomically', async () => {
  const { sqlite, DB } = database();
  seedVariants(sqlite);
  const snapshot = () => [count(sqlite, '_ecommerce_product_variants'), count(sqlite, '_ecommerce_product_variant_values'),
    count(sqlite, '_ecommerce_stocks'), count(sqlite, '_ecommerce_variant_components')];
  assert.deepEqual(snapshot(), [2, 3, 3, 2]);

  // A failure in the last statement rolls the whole delete back.
  sqlite.exec(`CREATE TRIGGER keep_groups BEFORE DELETE ON _ecommerce_product_variants
    BEGIN SELECT RAISE(ABORT, 'group delete failed'); END`);
  await assert.rejects(deleteVariantGroup({ DB }, 'frame-lens'), /group delete failed/);
  assert.deepEqual(snapshot(), [2, 3, 3, 2]);
  sqlite.exec('DROP TRIGGER keep_groups');

  assert.deepEqual(await deleteVariantGroup({ DB }, 'frame-lens'),
    { groupId: 'frame-lens', deleted: { values: 2, stockRows: 2, partRows: 1 } });
  // Only the other product's group, value, stock row and component row are left.
  assert.deepEqual(snapshot(), [1, 1, 1, 1]);
  assert.equal(value(sqlite, 'SELECT id FROM _ecommerce_product_variants'), 'other-lens');
  await assert.rejects(deleteVariantGroup({ DB }, 'frame-lens'), { status: 404 });
  sqlite.close();
});

test('the variants endpoint is admin-only, same-origin and uncached, and words a stale save like the core', async () => {
  const { sqlite, DB } = database();
  const stamp = second() - 60;
  seedVariants(sqlite, stamp);
  const change = { action: 'saveValue', groupId: 'frame-lens',
    value: { id: 'frame-amber', expectedUpdatedAt: loadedAt(stamp), ...amber, value: 'Amber gold' } };

  assert.equal((await postVariants({ DB }, change, { user: null })).status, 401);
  assert.equal((await postVariants({ DB }, change, { user: editor })).status, 403);
  assert.equal((await postVariants({ DB }, change, { origin: 'https://elsewhere.test' })).status, 403);
  const noOrigin = await postVariants({ DB }, change, { origin: null });
  assert.deepEqual([noOrigin.status, noOrigin.json.error], [403, 'Same-origin request required']);
  const get = await postVariants({ DB }, change, { method: 'GET' });
  assert.deepEqual([get.status, get.cacheControl], [405, 'no-store']);
  assert.deepEqual((await postVariants({ DB }, change, { raw: '{' })).status, 400);
  const unknown = await postVariants({ DB }, { action: 'renameGroup', groupId: 'frame-lens' });
  assert.equal(unknown.status, 400);
  const extraKey = await postVariants({ DB }, { ...change, value: { ...change.value, productVariantId: 'other-lens' } });
  assert.equal(extraKey.status, 400);
  assert.equal(valueRow(sqlite, 'frame-amber').value, 'Amber');

  const saved = await postVariants({ DB }, change);
  assert.deepEqual([saved.status, saved.cacheControl, saved.json.result.value.id], [200, 'no-store', 'frame-amber']);
  assert.equal(valueRow(sqlite, 'frame-amber').value, 'Amber gold');

  // The same save again carries a token that is stale now.
  const stale = await postVariants({ DB }, change);
  assert.deepEqual([stale.status, stale.cacheControl, stale.json], [409, 'no-store', { error: STALE_MESSAGE, code: 'stale_record' }]);

  const deleted = await postVariants({ DB }, { action: 'deleteGroup', groupId: 'frame-lens' });
  assert.deepEqual([deleted.status, deleted.json.result.deleted.values], [200, 2]);
  assert.equal((await postVariants({ DB }, { action: 'deleteValue', valueId: 'frame-amber' })).status, 404);
  sqlite.close();
});

/** A KV namespace in memory, as the core's entry cache uses it. */
function kvStore() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
    async put(key, json) { store.set(key, json); },
    async delete(key) { store.delete(key); },
  };
}

test('a change through the variants endpoint clears the cached reads of the rows it touched', async (t) => {
  const { sqlite, DB } = database();
  const stamp = second() - 60;
  seedVariants(sqlite, stamp);
  const env = { DB, KV: kvStore() };
  // A storefront reading the options through getClient and opting into the short KV cache of native rows.
  const client = getClient(env);
  const ids = async (slug) => (await client.entries.findMany(slug, { depth: 0, cache: true })).map((entry) => entry.id).sort();
  const cachedRow = async (slug, id) => (await client.entries.find(slug, id, { depth: 0, cache: true }))?.data;
  const storefront = async () => ({
    groups: await ids('_ecommerce_product_variants'),
    values: await ids('_ecommerce_product_variant_values'),
    stockRows: await ids('_ecommerce_stocks'),
    partRows: await ids('_ecommerce_variant_components'),
    amber: await cachedRow('_ecommerce_product_variant_values', 'frame-amber')
      .then((row) => row && [row.value, row.priceOverride]),
    amberStock: (await cachedRow('_ecommerce_stocks', 'frame-amber-stock'))?.quantity,
    smoke: (await cachedRow('_ecommerce_product_variant_values', 'frame-smoke'))?.value,
  });
  const loaded = await storefront();
  assert.deepEqual(loaded, {
    groups: ['frame-lens', 'other-lens'],
    values: ['frame-amber', 'frame-smoke', 'other-amber'],
    stockRows: ['frame-amber-stock', 'frame-smoke-stock', 'other-amber-stock'],
    partRows: ['frame-amber-lens', 'other-amber-lens'],
    amber: ['Amber', null], amberStock: 5, smoke: 'Smoke',
  });
  // The reads are cached now: a write that clears nothing stays unseen.
  sqlite.exec(`UPDATE _ecommerce_product_variant_values SET value = 'Unseen' WHERE id = 'frame-amber'`);
  assert.deepEqual(await storefront(), loaded);
  sqlite.exec(`UPDATE _ecommerce_product_variant_values SET value = 'Amber' WHERE id = 'frame-amber'`);

  const saved = await postVariants(env, { action: 'saveValue', groupId: 'frame-lens',
    value: { id: 'frame-amber', expectedUpdatedAt: loadedAt(stamp), ...amber, value: 'Amber gold', priceOverride: 13900 },
    stock: { id: 'frame-amber-stock', expectedUpdatedAt: loadedAt(stamp), quantity: 9 } });
  assert.equal(saved.status, 200);
  const created = await postVariants(env, { action: 'saveValue', groupId: 'frame-lens',
    value: { value: 'Rose', sku: null, image: null, priceOverride: null }, stock: { quantity: 4 } });
  assert.equal(created.status, 200);
  const { value: rose, stock: roseStock } = created.json.result;
  let now = await storefront();
  assert.deepEqual([now.amber, now.amberStock], [['Amber gold', 13900], 9]);
  assert.deepEqual(now.values, ['frame-amber', 'frame-smoke', 'other-amber', rose.id].sort());
  assert.deepEqual(now.stockRows, ['frame-amber-stock', 'frame-smoke-stock', 'other-amber-stock', roseStock.id].sort());

  assert.equal((await postVariants(env, { action: 'deleteValue', valueId: 'frame-smoke' })).status, 200);
  now = await storefront();
  assert.equal(now.smoke, undefined);
  assert.deepEqual(now.values, ['frame-amber', 'other-amber', rose.id].sort());
  assert.deepEqual(now.stockRows, ['frame-amber-stock', 'other-amber-stock', roseStock.id].sort());

  assert.equal((await postVariants(env, { action: 'deleteGroup', groupId: 'frame-lens' })).status, 200);
  assert.deepEqual(await storefront(), { groups: ['other-lens'], values: ['other-amber'], stockRows: ['other-amber-stock'],
    partRows: ['other-amber-lens'], amber: undefined, amberStock: undefined, smoke: undefined });

  // A cache that cannot be cleared does not turn a saved change into an error.
  const warned = t.mock.method(console, 'warn', () => {});
  env.KV.delete = async () => { throw new Error('KV DELETE failed: 503'); };
  const deleted = await postVariants(env, { action: 'deleteValue', valueId: 'other-amber' });
  assert.equal(deleted.status, 200);
  assert.equal(count(sqlite, '_ecommerce_product_variant_values'), 0);
  assert.equal(warned.mock.calls[0].arguments[0], '[commerce] Cached variant rows could not be cleared');
  sqlite.close();
});

test('a stock save through the variants endpoint loaded before a same-second reservation gets 409', async (t) => {
  const stamp = second();
  t.mock.timers.enable({ apis: ['Date'], now: stamp * 1000 + 300 });
  const { sqlite, DB } = database();
  seedVariants(sqlite, stamp);
  // The editor loads Smoke and its stock (3); a shopper then reserves one unit in the same second.
  const api = shop(DB);
  const cart = await api.carts.getOrCreate('configurator');
  await api.carts.updateItems(cart.id, [{ productId: 'frame', variantId: 'frame-smoke', quantity: 1 }]);
  await api.orders.createFromCart(cart.id, address);
  assert.equal(stockRow(sqlite, 'frame-smoke').quantity, 2);

  const refused = await postVariants({ DB }, { action: 'saveValue', groupId: 'frame-lens',
    value: { id: 'frame-smoke', expectedUpdatedAt: loadedAt(stamp), value: 'Smoke', sku: 'FRAME-SMK', image: null, priceOverride: null },
    stock: { id: 'frame-smoke-stock', expectedUpdatedAt: loadedAt(stamp), quantity: 5 } });
  assert.deepEqual([refused.status, refused.json.code], [409, 'stale_record']);
  assert.equal(stockRow(sqlite, 'frame-smoke').quantity, 2);
  sqlite.close();
});
