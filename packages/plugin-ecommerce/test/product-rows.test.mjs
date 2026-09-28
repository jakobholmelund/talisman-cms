import test from 'node:test';
import assert from 'node:assert/strict';
import { compileModule, coreUi, pluginAdmin } from './helpers/admin-source.mjs';

// The product editor's Options & stock panel reads one product's rows through product-rows.ts:
// groups by the product's id, values by the groups' ids, stock and component rows by the values'
// ids, and the definition tables in full. The loader takes a reader, so the queries are checked
// here without a browser; the reader over the entries API is checked with a recorded fetch.
const adminApiUrl = compileModule(new URL('lib/admin-api.ts', coreUi));
const {
  loadProductRows, readProductRowsFromApi, IDS_PER_REQUEST, PRODUCT_DEFINITION_SLUGS, PRODUCT_FLOW_FILTERS, PRODUCT_ROW_SLUGS,
} = await import(compileModule(new URL('product-rows.ts', pluginAdmin), { 'talisman-cms/ui/lib/admin-api': adminApiUrl }));

const row = (id, data = {}) => ({ id, data });

/** A product with two groups, three values, a stock row per value and one component row. */
const product = {
  _ecommerce_variants: [row('d1', { name: 'Size' }), row('d2', { name: 'Color' })],
  _ecommerce_components: [row('c1', { name: 'Blade' })],
  _ecommerce_product_variants: [row('g1', { productId: 'p1', name: 'Sizes' }), row('g2', { productId: 'p1', name: 'Colors' })],
  _ecommerce_product_variant_values: [
    row('v1', { productVariantId: 'g1', value: 'Small' }),
    row('v2', { productVariantId: 'g1', value: 'Large' }),
    row('v3', { productVariantId: 'g2', value: 'Blue' }),
  ],
  _ecommerce_stocks: [row('s1', { productVariantValueId: 'v1', quantity: 4 }), row('s2', { productVariantValueId: 'v2', quantity: 5 }), row('s3', { productVariantValueId: 'v3', quantity: 3 })],
  _ecommerce_variant_components: [row('vc1', { productVariantValueId: 'v3', componentId: 'c1', quantity: 1 })],
};

/** A reader that answers from `tables` and records every query it gets, as [slug, where]. */
function recordingReader(tables, queries) {
  return async (basePath, slug, where) => {
    assert.equal(basePath, '/admin');
    queries.push([slug, where]);
    const rows = tables[slug] || [];
    if (!where) return rows;
    const [[column, match]] = Object.entries(where);
    const wanted = new Set(Array.isArray(match) ? match : [match]);
    return rows.filter((entry) => wanted.has(entry.data[column]));
  };
}

const bySlug = (queries) => Object.fromEntries(queries.map(([slug, where]) => [slug, where]));

test('a product reads its groups by id, then values by group, then stock and components by value, and the definition tables in full', async () => {
  const queries = [];
  const rows = await loadProductRows('/admin', 'p1', recordingReader(product, queries));

  assert.deepEqual(queries.map(([slug]) => slug).sort(), [...PRODUCT_ROW_SLUGS].sort(), 'every collection is read exactly once');
  assert.deepEqual(bySlug(queries), {
    _ecommerce_variants: null,
    _ecommerce_components: null,
    _ecommerce_product_variants: { productId: 'p1' },
    _ecommerce_product_variant_values: { productVariantId: ['g1', 'g2'] },
    _ecommerce_stocks: { productVariantValueId: ['v1', 'v2', 'v3'] },
    _ecommerce_variant_components: { productVariantValueId: ['v1', 'v2', 'v3'] },
  });
  // The chain follows the rows read: values after the groups, stock and components after the values.
  const at = (slug) => queries.findIndex(([name]) => name === slug);
  assert.ok(at('_ecommerce_product_variants') < at('_ecommerce_product_variant_values'));
  assert.ok(at('_ecommerce_product_variant_values') < at('_ecommerce_stocks'));
  assert.ok(at('_ecommerce_product_variant_values') < at('_ecommerce_variant_components'));

  assert.deepEqual(Object.keys(rows).sort(), [...PRODUCT_ROW_SLUGS].sort());
  assert.deepEqual(rows, product);
  assert.deepEqual(Object.keys(PRODUCT_FLOW_FILTERS), ['_ecommerce_product_variants', '_ecommerce_product_variant_values', '_ecommerce_stocks', '_ecommerce_variant_components']);
  assert.deepEqual([...PRODUCT_DEFINITION_SLUGS], ['_ecommerce_variants', '_ecommerce_components']);
});

test('a product without groups, or without values, does not ask for the rows below them', async () => {
  const queries = [];
  const rows = await loadProductRows('/admin', 'p2', recordingReader(product, queries));
  // Nothing below the groups is read: the API refuses an `in` with no values, and there is nothing to find.
  assert.deepEqual(bySlug(queries), { _ecommerce_variants: null, _ecommerce_components: null, _ecommerce_product_variants: { productId: 'p2' } });
  assert.deepEqual(rows, {
    _ecommerce_variants: product._ecommerce_variants,
    _ecommerce_components: product._ecommerce_components,
    _ecommerce_product_variants: [],
    _ecommerce_product_variant_values: [],
    _ecommerce_stocks: [],
    _ecommerce_variant_components: [],
  });

  const onlyGroups = { ...product, _ecommerce_product_variants: [row('g9', { productId: 'p3', name: 'Empty' })] };
  const later = [];
  const emptyGroup = await loadProductRows('/admin', 'p3', recordingReader(onlyGroups, later));
  assert.deepEqual(bySlug(later), {
    _ecommerce_variants: null, _ecommerce_components: null,
    _ecommerce_product_variants: { productId: 'p3' }, _ecommerce_product_variant_values: { productVariantId: ['g9'] },
  });
  assert.deepEqual(emptyGroup._ecommerce_product_variants.map((entry) => entry.id), ['g9']);
  assert.deepEqual([emptyGroup._ecommerce_stocks, emptyGroup._ecommerce_variant_components], [[], []]);
});

test('a new product, without an id, reads only the definition tables', async () => {
  const queries = [];
  const rows = await loadProductRows('/admin', '', recordingReader(product, queries));
  assert.deepEqual(bySlug(queries), { _ecommerce_variants: null, _ecommerce_components: null });
  assert.deepEqual(rows, {
    _ecommerce_variants: product._ecommerce_variants,
    _ecommerce_components: product._ecommerce_components,
    _ecommerce_product_variants: [],
    _ecommerce_product_variant_values: [],
    _ecommerce_stocks: [],
    _ecommerce_variant_components: [],
  });
});

test('a long list of ids is read in several requests, each under the bound-parameter limit', async () => {
  const groups = Array.from({ length: IDS_PER_REQUEST * 2 + 5 }, (_, index) => row(`g${index}`, { productId: 'p1' }));
  const queries = [];
  await loadProductRows('/admin', 'p1', recordingReader({ ...product, _ecommerce_product_variants: groups }, queries));
  const valueReads = queries.filter(([slug]) => slug === '_ecommerce_product_variant_values').map(([, where]) => where.productVariantId);
  assert.equal(valueReads.length, 3);
  assert.deepEqual(valueReads.map((ids) => ids.length), [IDS_PER_REQUEST, IDS_PER_REQUEST, 5]);
  assert.deepEqual(valueReads.flat(), groups.map((group) => group.id), 'every group id is asked for once, in order');
  assert.ok(IDS_PER_REQUEST < 90, 'the API binds at most 90 values, and a page binds its limit and cursor too');
});

test('a refused read rejects instead of giving an empty product, and a later read of the same product works again', async () => {
  const refused = new Error('Your session has expired. Sign in again in another tab, then try again.');
  let refuse = true;
  const queries = [];
  const reader = async (basePath, slug, where) => {
    if (refuse && slug === '_ecommerce_stocks') throw refused;
    return recordingReader(product, queries)(basePath, slug, where);
  };
  await assert.rejects(loadProductRows('/admin', 'p1', reader), (error) => error === refused);
  // A refresh after the session is back reads the same queries again and gives the rows.
  refuse = false;
  queries.length = 0;
  const rows = await loadProductRows('/admin', 'p1', reader);
  assert.deepEqual(rows, product);
  assert.deepEqual(queries.map(([slug]) => slug).sort(), [...PRODUCT_ROW_SLUGS].sort());
});

/** A fetch that answers from `tables`, filtering by the where parameters, and records every request URL. */
function apiFetch(tables, requests, { status = 200, pageSize = 200 } = {}) {
  return async (url) => {
    requests.push(url);
    if (status !== 200) return { ok: false, status, json: async () => ({ error: 'refused' }) };
    const { pathname, searchParams } = new URL(url, 'http://127.0.0.1');
    const slug = pathname.match(/^\/admin\/api\/collections\/([^/]+)\/entries$/)?.[1];
    assert.ok(slug, `${url} is not an entries list request`);
    let rows = tables[slug] || [];
    for (const [key, value] of searchParams) {
      const match = key.match(/^where\[([^\]]+)\](?:\[(in)\])?$/);
      if (!match) continue;
      const wanted = new Set(match[2] ? value.split(',') : [value]);
      rows = rows.filter((entry) => wanted.has(entry.data[match[1]]));
    }
    // The API lists newest first; the tables here are oldest first.
    const newestFirst = [...rows].reverse();
    const offset = Number(searchParams.get('cursor') || 0);
    const docs = newestFirst.slice(offset, offset + pageSize);
    const nextCursor = offset + pageSize < newestFirst.length ? String(offset + pageSize) : null;
    return { ok: true, status: 200, json: async () => ({ docs, nextCursor }) };
  };
}

const withFetch = async (fetchImpl, run) => {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
};

const paramsOf = (url) => Object.fromEntries(new URL(url, 'http://127.0.0.1').searchParams);
const slugOf = (url) => new URL(url, 'http://127.0.0.1').pathname.split('/')[4];

test('the reader over the entries API sends where filters for the flow tables and reads the definition tables in full', async () => {
  const requests = [];
  const rows = await withFetch(apiFetch(product, requests), () => loadProductRows('/admin', 'p1', readProductRowsFromApi));

  const byCollection = {};
  for (const url of requests) (byCollection[slugOf(url)] ??= []).push(paramsOf(url));
  assert.deepEqual(byCollection, {
    _ecommerce_variants: [{ limit: '200' }],
    _ecommerce_components: [{ limit: '200' }],
    _ecommerce_product_variants: [{ 'where[productId]': 'p1', limit: '200' }],
    _ecommerce_product_variant_values: [{ 'where[productVariantId][in]': 'g1,g2', limit: '200' }],
    _ecommerce_stocks: [{ 'where[productVariantValueId][in]': 'v1,v2,v3', limit: '200' }],
    _ecommerce_variant_components: [{ 'where[productVariantValueId][in]': 'v1,v2,v3', limit: '200' }],
  });
  for (const url of requests) {
    const slug = slugOf(url);
    if (slug in PRODUCT_FLOW_FILTERS) assert.match(url, /where%5B/, `${slug} is read without a where filter: ${url}`);
  }
  // The rows come back in table order, oldest first, as the drafts and option lists expect.
  assert.deepEqual(rows, product);
});

test('the reader over the entries API keeps the filter on every page and rejects a refused read', async () => {
  const requests = [];
  const paged = await withFetch(apiFetch(product, requests, { pageSize: 2 }), () => loadProductRows('/admin', 'p1', readProductRowsFromApi));
  const valuePages = requests.filter((url) => slugOf(url) === '_ecommerce_product_variant_values').map(paramsOf);
  assert.equal(valuePages.length, 2);
  for (const page of valuePages) assert.equal(page['where[productVariantId][in]'], 'g1,g2');
  assert.equal(valuePages[1].cursor, '2');
  assert.deepEqual(paged._ecommerce_product_variant_values.map((entry) => entry.id), ['v1', 'v2', 'v3']);

  // A refused first page is an error to show, never an empty product (strict in fetchAllEntries).
  await assert.rejects(
    withFetch(apiFetch(product, [], { status: 401 }), () => loadProductRows('/admin', 'p1', readProductRowsFromApi)),
    /Your session has expired/
  );
  await assert.rejects(
    withFetch(apiFetch(product, [], { status: 403 }), () => loadProductRows('/admin', '', readProductRowsFromApi)),
    /Failed to load _ecommerce_(variants|components) \(HTTP 403\)/
  );
});
