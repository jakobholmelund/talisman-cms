import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { ecommercePlugin } from '../dist/index.js';
import { compileModule, coreUi, pluginAdmin } from './helpers/admin-source.mjs';

/** The source of the plugin's admin options module (virtual:talisman-cms/ecommerce-admin) for this site. */
const adminOptions = async (plugin) => {
  const [vitePlugin] = plugin.vite.plugins;
  const id = vitePlugin.resolveId('virtual:talisman-cms/ecommerce-admin');
  return vitePlugin.load(id);
};

// The admin screens ship as TypeScript source (src/admin), so each helper module is compiled and
// loaded from a data URL (helpers/admin-source.mjs), with the core helpers it imports linked the same way.
const entrySaveUrl = compileModule(new URL('lib/entry-save.ts', coreUi));
const currencyUrl = compileModule(new URL('currency.ts', pluginAdmin));
const { getVariantChangeRecovery, describeVariantChangeFailure } =
  await import(compileModule(new URL('variant-recovery.ts', pluginAdmin), { 'talisman-cms/ui/lib/entry-save': entrySaveUrl }));
/** The admin modules as the site's build gives them to a plugin registered with this products slug. */
const adminModulesFor = async (productsCollectionSlug) => {
  const options = { 'virtual:talisman-cms/ecommerce-admin': `data:text/javascript,${encodeURIComponent(await adminOptions(ecommercePlugin({ productsCollectionSlug })))}` };
  return {
    models: await import(compileModule(new URL('commerce-models.ts', pluginAdmin), { './currency': currencyUrl, ...options })),
    workspace: await import(compileModule(new URL('workspace-models.ts', pluginAdmin), options)),
  };
};
const { describeEntry, describeCommerceEntry, formatMoney, getRelationOptionLabel, supportCollections, commerceFlowSlugs } =
  (await adminModulesFor('products')).models;
const { normalizeCurrency, storeCurrency } = await import(currencyUrl);

test('commerce tools link relative to the admin path and pass adminPages overrides through', () => {
  const defaults = ecommercePlugin();
  // The integration resolves these under the site's admin path, so they hold for any adminPath.
  assert.deepEqual(defaults.adminLinks?.map(link => link.href), [
    'extensions/commerce-orders',
    'extensions/commerce-promotions',
    'extensions/commerce-gift-cards'
  ]);
  assert.deepEqual(defaults.adminUi?.map(page => [page.path, page.section]), [
    ['commerce-orders', 'commerce'], ['commerce-promotions', 'commerce'],
    ['commerce-gift-cards', 'commerce']
  ]);

  // An override is given to the integration as written, relative or absolute; it refuses a value
  // that is not a path on the site (a full URL, a host) at config time.
  const plugin = ecommercePlugin({
    adminTestCheckout: true,
    adminPages: { orders: '/orders', promotions: 'extensions/promotions', giftCards: 'https://external.example/cards' }
  });
  assert.deepEqual(plugin.adminLinks?.map(link => [link.section, link.label, link.href]), [
    ['commerce', 'Orders & fulfillment', '/orders'],
    ['commerce', 'Promotions & referrals', 'extensions/promotions'],
    ['commerce', 'Gift cards', 'https://external.example/cards'],
    ['commerce', 'Test checkout', 'extensions/commerce-test-checkout']
  ]);
});

test('the admin test checkout is opt-in: no screen, route or simulated provider by default', async () => {
  const endpointPaths = (plugin) => plugin.endpoints.map(endpoint => endpoint.path);
  for (const plugin of [ecommercePlugin(), ecommercePlugin({ adminTestCheckout: false })]) {
    assert.ok(!endpointPaths(plugin).includes('/ecommerce/test-checkout'));
    assert.ok(!plugin.adminUi.some(page => page.path === 'commerce-test-checkout'));
    assert.ok(!plugin.adminLinks.some(link => link.href.endsWith('commerce-test-checkout')));
    assert.equal(await adminOptions(plugin), 'export const adminTestCheckout = false;\nexport const productsCollectionSlug = "products";');
  }
  // Cart, checkout, order and webhook routes stay registered either way.
  assert.ok(['/ecommerce/cart', '/ecommerce/checkout', '/ecommerce/order', '/ecommerce/webhooks/stripe']
    .every(path => endpointPaths(ecommercePlugin()).includes(path)));

  const enabled = ecommercePlugin({ adminTestCheckout: true });
  const testCheckout = enabled.endpoints.find(endpoint => endpoint.path === '/ecommerce/test-checkout');
  assert.ok(testCheckout, 'the admin route is injected when enabled');
  assert.notEqual(testCheckout.public, true, 'the admin route stays under the admin path');
  assert.match(testCheckout.entrypoint, /ecommerce-admin-test-checkout\.(js|ts)$/);
  assert.deepEqual(enabled.adminUi.at(-1), { path: 'commerce-test-checkout', label: 'Test checkout',
    section: 'commerce', componentPath: '@talisman-cms/plugin-ecommerce/admin/TestCheckout' });
  assert.equal(enabled.adminLinks.at(-1).href, 'extensions/commerce-test-checkout');
  assert.equal(await adminOptions(enabled), 'export const adminTestCheckout = true;\nexport const productsCollectionSlug = "products";');
  // The admin screens read the configured products slug from the same module.
  assert.equal(await adminOptions(ecommercePlugin({ productsCollectionSlug: 'frames' })),
    'export const adminTestCheckout = false;\nexport const productsCollectionSlug = "frames";');
});

test('the plugin registers the Commerce section, the editor panels, the describer and the store currency', () => {
  const plugin = ecommercePlugin();
  assert.deepEqual(plugin.adminSections.map(section => [section.id, section.label, section.icon, section.adminOnly, section.componentPath]), [
    ['commerce', 'Commerce', 'shopping-cart', true, '@talisman-cms/plugin-ecommerce/admin/CommerceWorkspace']
  ]);
  assert.ok(plugin.adminSections[0].emptyState.title && plugin.adminSections[0].description);
  assert.deepEqual(plugin.adminEditorPanels, [
    { id: 'commerce-model-guide', placement: 'before-fields', sections: ['commerce'], componentPath: '@talisman-cms/plugin-ecommerce/admin/CommerceModelGuidePanel' },
    { id: 'commerce-product-options', placement: 'after-form', slugs: ['products'], componentPath: '@talisman-cms/plugin-ecommerce/admin/ProductOptionsPanel' }
  ]);
  // The options panel follows the configured products slug.
  assert.deepEqual(ecommercePlugin({ productsCollectionSlug: 'shop_items' }).adminEditorPanels[1].slugs, ['shop_items']);
  assert.deepEqual(plugin.adminEntryDescribers, [{ modulePath: '@talisman-cms/plugin-ecommerce/admin/commerce-models' }]);
  assert.deepEqual(plugin.adminSettings, ['COMMERCE_CURRENCY']);
  // Tailwind scans the admin sources shipped with the package, so the workspace and panels get their classes.
  assert.equal(plugin.adminStyleSources.length, 1);
  const [styleSource] = plugin.adminStyleSources;
  assert.ok(styleSource.startsWith('/'), 'the style source is absolute');
  assert.ok(statSync(styleSource).isDirectory());
  assert.ok(statSync(new URL('CommerceWorkspace.tsx', pluginAdmin)).isFile());
  assert.equal(styleSource.replace(/\/$/, ''), pluginAdmin.pathname.replace(/\/$/, ''));
});

test('every plugin table is listed under Commerce and stock counts are sent only when changed', () => {
  const site = { name: 'Shop items', slug: 'products', fields: [{ name: 'name', label: 'Name', type: 'text' }, { name: 'inventoryQuantity', label: 'Stock', type: 'number' }],
    nativeSchemaMapping: { schemaPath: '@talisman-cms/plugin-ecommerce/schema', exportName: 'products', idColumn: 'id' } };
  const collections = ecommercePlugin().onInit({ collections: [site] }).collections;
  const plugin = collections.filter(item => item.nativeSchemaMapping?.schemaPath === '@talisman-cms/plugin-ecommerce/schema');
  assert.ok(plugin.length > 10);
  for (const collection of plugin) assert.equal(collection.adminSection, 'commerce', `${collection.slug} is not under Commerce`);
  const saveOnlyIfChanged = (slug) => collections.find(item => item.slug === slug).fields.filter(field => field.saveOnlyIfChanged).map(field => field.name);
  assert.deepEqual(saveOnlyIfChanged('products'), ['inventoryQuantity'], 'also on a site-defined products collection');
  assert.deepEqual(saveOnlyIfChanged('_ecommerce_product_variants'), ['inventoryQuantity']);
  assert.deepEqual(saveOnlyIfChanged('_ecommerce_stocks'), ['quantity']);
  assert.deepEqual(saveOnlyIfChanged('_ecommerce_components'), ['quantity']);
  assert.deepEqual(saveOnlyIfChanged('_ecommerce_variant_components'), [], 'units per item are not a stock count');
  assert.deepEqual(saveOnlyIfChanged('_ecommerce_orders'), []);
});

test('the Options & stock panel keeps edits only after a refusal that wrote nothing, and says what it shows', () => {
  const failure = (status, message, code = null) => ({ status, code, message });
  const lost = failure(0, 'Failed to save the variant value: the server could not be reached. Your edits are still here.');
  const stale = failure(409, 'This record changed since it was opened. Reload it before saving.', 'stale_record');
  const serverError = failure(500, 'The variant change could not be saved. Check the server logs for details.');
  // A refusal wrote nothing: the edits stay, including after an expired session, whose reload would read nothing.
  for (const status of [400, 401, 403, 428]) assert.equal(getVariantChangeRecovery(failure(status, 'Refused')), 'keep');
  assert.equal(getVariantChangeRecovery(failure(409, 'Another record already uses this sku.')), 'keep');
  // Rows that changed or are gone are loaded again.
  assert.equal(getVariantChangeRecovery(stale), 'reload');
  assert.equal(getVariantChangeRecovery(failure(404, 'Variant value not found')), 'reload');
  // Without an answer that says what happened, the change may have been saved.
  for (const unknown of [lost, serverError, failure(502, 'Bad gateway'), failure(200, 'unexpected response')]) {
    assert.equal(getVariantChangeRecovery(unknown), 'unknown');
  }

  // After a lost answer the saved rows replace the edits, so the message must not say they are still here.
  const reloaded = describeVariantChangeFailure(lost, 'Failed to save the variant value', true);
  assert.doesNotMatch(reloaded, /edits are still here/);
  assert.match(reloaded, /^Failed to save the variant value: the server could not be reached\. The saved options and stock are loaded again/);
  // When they could not be loaded either, the edits are still shown, and a new value waits for the rows.
  const kept = describeVariantChangeFailure(serverError, 'Failed to save the variant value', false);
  assert.match(kept, /^The variant change could not be saved\. Check the server logs for details\. The saved options and stock could not be loaded/);
  assert.match(kept, /Your edits are still here; load the latest options and stock before creating a value\.$/);
  assert.match(describeVariantChangeFailure(stale, 'Failed', true), /The latest values are loaded now; make your change again\.$/);
  assert.match(describeVariantChangeFailure(stale, 'Failed', false), /Load the latest values, then make your change again\.$/);
  assert.equal(describeVariantChangeFailure(failure(404, 'Variant value not found'), 'Failed', true),
    'Variant value not found. The latest options and stock are loaded now.');
});

test('commerce records are described with prices in the store currency, scaled by its minor units', () => {
  // The admin formats for the browser's locale, so the expected text comes from the same formatter.
  const text = (major, currency) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(major);
  assert.equal(formatMoney(1250, 'usd'), text(12.5, 'USD'));
  assert.equal(formatMoney(1250, 'jpy'), text(1250, 'JPY'));
  assert.equal(formatMoney(1250, 'kwd'), text(1.25, 'KWD'));
  assert.equal(formatMoney(null, 'usd'), null);
  assert.equal(formatMoney(1250, undefined), null);

  const product = { id: 'p1', data: { name: 'Poster', slug: 'poster', basePrice: 1250 } };
  assert.equal(describeCommerceEntry('products', product, {}, 'jpy').subtitle, `/poster • ${text(1250, 'JPY')}`);
  assert.equal(getRelationOptionLabel('products', product, {}, 'kwd'), `Poster - /poster • ${text(1.25, 'KWD')}`);
  const value = { id: 'v1', data: { value: 'Blue', priceOverride: 990 } };
  assert.deepEqual(describeCommerceEntry('_ecommerce_product_variant_values', value, {}, 'jpy').details, [`Price override ${text(990, 'JPY')}`]);
  // Without a currency a price is left out rather than shown in the wrong one; titles need none.
  assert.equal(describeCommerceEntry('products', product, {}).subtitle, '/poster');
  assert.deepEqual(describeCommerceEntry('_ecommerce_product_variant_values', value, {}).details, []);
  assert.equal(describeCommerceEntry('products', product, {}).title, 'Poster');

  // The describer the core calls: the currency comes from the admin's setting, and records of other
  // collections are left to the core's generic description.
  const context = { readSetting: (name) => (name === 'COMMERCE_CURRENCY' ? 'jpy' : null) };
  assert.equal(describeEntry('products', product, {}, context).subtitle, `/poster • ${text(1250, 'JPY')}`);
  assert.equal(describeEntry('products', product, {}, { readSetting: () => null }).subtitle, `/poster • ${text(12.5, 'USD')}`);
  assert.equal(describeEntry('posts', { id: 'x', data: { title: 'Hello' } }, {}, context), null);
  assert.equal(describeEntry('_ecommerce_orders', { id: 'o1', data: {} }, {}, context), null);
  // A stock row names its value, option and product from the loaded flow.
  const entries = {
    products: [product],
    _ecommerce_variants: [{ id: 'd1', data: { name: 'Size' } }],
    _ecommerce_product_variants: [{ id: 'g1', data: { productId: 'p1', variantId: 'd1', name: 'Sizes' } }],
    _ecommerce_product_variant_values: [{ id: 'v1', data: { productVariantId: 'g1', value: 'Large' } }],
  };
  assert.deepEqual(describeEntry('_ecommerce_stocks', { id: 's1', data: { productVariantValueId: 'v1', quantity: 3 } }, entries, context),
    { title: 'Stock for Large', subtitle: 'Product: Poster • Option: Size • Value: Large', details: ['Quantity 3'] });
  // The editor of a variant group, value, stock or component record loads the whole flow, so the
  // record can name its product, option and group; other editors load only their relation targets.
  assert.deepEqual(supportCollections('_ecommerce_stocks', ['x']), commerceFlowSlugs());
  assert.deepEqual(supportCollections('_ecommerce_product_variants', []), commerceFlowSlugs());
  assert.equal(commerceFlowSlugs()[0], 'products');
  assert.deepEqual(supportCollections('posts', ['authors']), []);
  // The product editor asks for none of the flow tables: its Options & stock panel reads the
  // product's own rows (product-rows.ts), and the core loads its relation targets as before.
  assert.deepEqual(supportCollections('products', ['_ecommerce_categories', '_ecommerce_tags']), []);
});

test('the commerce admin follows a configured products slug in labels, the flow and the workspace', async () => {
  const { models, workspace } = await adminModulesFor('frames');
  const context = { readSetting: () => 'usd' };
  const product = { id: 'p1', data: { name: 'Poster', slug: 'poster', basePrice: 1250 } };
  const entries = {
    frames: [product],
    _ecommerce_variants: [{ id: 'd1', data: { name: 'Size' } }],
    _ecommerce_product_variants: [{ id: 'g1', data: { productId: 'p1', variantId: 'd1', name: 'Sizes' } }],
    _ecommerce_product_variant_values: [{ id: 'v1', data: { productVariantId: 'g1', value: 'Large' } }],
  };
  // The products collection is described under its slug, and 'products' is now an unknown collection.
  assert.equal(models.describeEntry('frames', product, entries, context).title, 'Poster');
  assert.equal(models.describeEntry('products', product, entries, context), null);
  // A variant group, a value and a stock row name their product from the collection under its slug.
  assert.equal(models.describeEntry('_ecommerce_product_variants', entries._ecommerce_product_variants[0], entries, context).subtitle,
    'Product: Poster • Option: Size');
  assert.equal(models.describeEntry('_ecommerce_product_variant_values', entries._ecommerce_product_variant_values[0], entries, context).subtitle,
    'Group: Sizes • Product: Poster • Option: Size');
  assert.deepEqual(models.describeEntry('_ecommerce_stocks', { id: 's1', data: { productVariantValueId: 'v1', quantity: 3 } }, entries, context),
    { title: 'Stock for Large', subtitle: 'Product: Poster • Option: Size • Value: Large', details: ['Quantity 3'] });
  // The flow lists the products collection under the configured slug; the editors of the flow's
  // other records load it, the product editor under that slug asks for none of it, and the guide
  // and flow summary know the slug.
  assert.deepEqual(models.commerceFlowSlugs().slice(0, 2), ['frames', '_ecommerce_variants']);
  assert.deepEqual(models.supportCollections('_ecommerce_product_variant_values'), models.commerceFlowSlugs());
  assert.deepEqual(models.supportCollections('frames'), []);
  assert.deepEqual(models.supportCollections('products'), []);
  assert.equal(models.getCommerceModelGuide('frames').title, 'Variant Flow');
  assert.equal(models.getCommerceModelGuide('products'), null);
  assert.deepEqual(models.getCommerceFlowSummary('_ecommerce_product_variants', { name: 'Sizes', productId: 'p1', variantId: 'd1' }, entries).map(item => [item.label, item.value]),
    [['Product', 'Poster'], ['Option', 'Size'], ['Group', 'Sizes']]);

  // The workspace lists the site's products collection under its slug, as a highlight and not as store content.
  const model = (slug, extra = {}) => ({ slug, name: slug, itemCount: 1, ...extra });
  const site = [model('frames'), model('posts'), model('_ecommerce_orders'), model('_ecommerce_stocks'), model('_ecommerce_payments')];
  const groups = workspace.groupCommerceModels(site);
  assert.equal(groups.products?.slug, 'frames');
  assert.deepEqual(groups.content.map(item => item.slug), ['posts']);
  assert.deepEqual(groups.catalog.map(item => item.slug), ['_ecommerce_stocks']);
  assert.deepEqual(groups.advanced.map(item => item.slug), ['_ecommerce_payments']);
  assert.equal(groups.orders?.slug, '_ecommerce_orders');
  assert.equal(workspace.modelHelp(model('frames')), 'Images, prices, options, and availability');
  assert.equal(workspace.modelHelp(model('posts', { description: 'Stories' })), 'Stories');
  // A collection mapped to the plugin's products table is the products collection whatever its slug.
  const mapped = model('shop_items', { nativeSchemaMapping: { schemaPath: '@talisman-cms/plugin-ecommerce/schema', exportName: 'products', idColumn: 'id' } });
  assert.equal(workspace.groupCommerceModels([model('posts'), mapped]).products, mapped);
  // Under the default slug a 'frames' collection is store content.
  const defaults = (await adminModulesFor('products')).workspace.groupCommerceModels(site);
  assert.equal(defaults.products, undefined);
  assert.deepEqual(defaults.content.map(item => item.slug), ['frames', 'posts']);
  // Tool links resolved under any admin path open the plugin page inside the SPA.
  assert.equal(workspace.extensionPathOf('/console/extensions/commerce-orders'), 'commerce-orders');
  assert.equal(workspace.extensionPathOf('/extensions/commerce-orders'), 'commerce-orders');
  assert.equal(workspace.extensionPathOf('/orders'), undefined);
});

test('the admin reads the store currency from the page meta tag, and USD without a usable one', () => {
  assert.equal(normalizeCurrency(' JPY '), 'jpy');
  for (const value of [null, undefined, '', 'dollars', 'u$d']) assert.equal(normalizeCurrency(value), 'usd');
  const page = (content) => ({
    querySelector: (selector) => selector === 'meta[name="talisman-setting-commerce-currency"]' && content !== null
      ? { getAttribute: (name) => (name === 'content' ? content : null) } : null,
  });
  try {
    globalThis.document = page('jpy');
    assert.equal(storeCurrency(), 'jpy');
    globalThis.document = page(' KWD ');
    assert.equal(storeCurrency(), 'kwd');
    for (const content of [null, '', 'dollars']) {
      globalThis.document = page(content);
      assert.equal(storeCurrency(), 'usd', `content ${JSON.stringify(content)}`);
    }
  } finally {
    delete globalThis.document;
  }
  // Outside a browser there is no page to read.
  assert.equal(storeCurrency(), 'usd');
});

test('the unfinished Durable Object inventory stub is not part of the API', async () => {
  const plugin = await import('../dist/index.js');
  const { bindCommerceApi } = await import('../dist/api.js');
  assert.equal('InventoryDO' in plugin, false);
  assert.equal('inventory' in bindCommerceApi({ env: { DB: {} } }), false);
});

test('native commerce tables are restricted to administrators and operational rows are read only', () => {
  const collections = ecommercePlugin().onInit({ collections: [] }).collections;
  for (const collection of collections.filter(item => item.nativeSchemaMapping?.schemaPath === '@talisman-cms/plugin-ecommerce/schema')) {
    assert.deepEqual(collection.access, { read: 'admin', create: 'admin', update: 'admin', delete: 'admin' });
  }
  assert.equal(collections.find(item => item.slug === '_ecommerce_carts').readOnly, true);
  assert.equal(collections.find(item => item.slug === '_ecommerce_customers').readOnly, true);
});
