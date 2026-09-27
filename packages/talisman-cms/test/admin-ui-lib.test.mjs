import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import ts from 'typescript';

// The admin SPA ships as TypeScript source (ui/), so its pure helpers are compiled here and loaded
// as modules. They import nothing, which keeps this possible.
async function loadAdminModule(path) {
  const source = readFileSync(new URL(`../ui/${path}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  assert.doesNotMatch(outputText, /^import\s/m, `ui/${path} must stay free of imports so it can be tested alone`);
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

const {
  prepareFieldValuesForSave,
  isStaleRecordConflict,
  isSlugConflict,
  getPendingSlugRename,
  getPagePath,
  readPendingTransition,
  hasEntryMovedOn,
  describeSettledTransition,
  waitForPendingTransition,
  PENDING_TRANSITION_CHECK_DELAYS_MS,
  getVariantChangeRecovery,
  describeVariantChangeFailure,
} =
  await loadAdminModule('lib/entry-save.ts');
const { fetchAllEntries, fetchCollectionConfigs, fetchEntriesBySlug } = await loadAdminModule('lib/admin-api.ts');
const { describeCommerceEntry, formatMoney, getRelationOptionLabel } = await loadAdminModule('lib/commerce-models.ts');
const { readCommerceCurrency } = await loadAdminModule('commerce-currency.ts');
const { COLLAPSED_STATE_INDEX_KEY, COLLAPSED_STATE_MAX_ENTRIES, pruneCollapsedState, readCollapsedCards, writeCollapsedCards } =
  await loadAdminModule('lib/collapsed-state.ts');

const fields = [
  { name: 'title', type: 'text', required: true },
  { name: 'subtitle', type: 'text' },
  { name: 'views', type: 'number' },
  { name: 'rating', type: 'number', required: true },
  { name: 'theme', type: 'select', options: ['light', 'dark'] },
  { name: 'author', type: 'relationship', relationTo: 'authors' },
  { name: 'publishedAt', type: 'date' },
  { name: 'image', type: 'media' },
  { name: 'featured', type: 'boolean' },
];

test('blank optional numbers, selects and relations are saved as null in stored JSON', () => {
  const values = { title: '', subtitle: '', views: '', rating: '', theme: '', author: '', publishedAt: '', image: '', featured: false, extra: '' };
  assert.deepEqual(prepareFieldValuesForSave(fields, values), {
    title: '',
    subtitle: '',
    views: null,
    rating: '',
    theme: null,
    author: null,
    publishedAt: '',
    image: '',
    featured: false,
    extra: '',
  });
  // Filled values and keys the entry does not have are left alone.
  assert.deepEqual(prepareFieldValuesForSave(fields, { views: 0, theme: 'dark', author: 'a1' }), { views: 0, theme: 'dark', author: 'a1' });
  assert.equal(prepareFieldValuesForSave(fields, null), null);
});

test('blanks inside groups, arrays, blocks and inline components are saved as null too', () => {
  const nested = [
    { name: 'seo', type: 'group', fields: [{ name: 'priority', type: 'number' }, { name: 'title', type: 'text' }] },
    { name: 'rows', type: 'array', fields: [{ name: 'count', type: 'number' }] },
    {
      name: 'layout',
      type: 'blocks',
      blocks: [{
        slug: 'hero',
        fields: [{ name: 'columns', type: 'number' }],
        componentSlots: [{ name: 'cta', hasMany: true, components: [{ slug: 'button', fields: [{ name: 'size', type: 'select', options: ['sm', 'lg'] }] }] }],
      }],
    },
  ];
  const values = {
    seo: { priority: '', title: '' },
    rows: [{ count: '' }, { count: 3 }],
    layout: [
      { blockType: 'hero', columns: '', cta: [{ mode: 'inline', componentType: 'button', size: '' }, { mode: 'preset', presetId: 'p1' }] },
      { blockType: 'unknown', columns: '' },
    ],
  };
  assert.deepEqual(prepareFieldValuesForSave(nested, values), {
    seo: { priority: null, title: '' },
    rows: [{ count: null }, { count: 3 }],
    layout: [
      { blockType: 'hero', columns: null, cta: [{ mode: 'inline', componentType: 'button', size: null }, { mode: 'preset', presetId: 'p1' }] },
      { blockType: 'unknown', columns: '' },
    ],
  });
});

test('a new native row leaves blank optional values out so column defaults apply', () => {
  const values = { title: 'T', subtitle: '', views: '', rating: '', theme: '', author: '', publishedAt: '', image: '', featured: false };
  assert.deepEqual(prepareFieldValuesForSave(fields, values, { native: true, mode: 'create' }), {
    title: 'T',
    // Free text is left for the server, which knows whether the column takes NULL.
    subtitle: '',
    rating: '',
    image: '',
    featured: false,
  });

  // A number typed and then cleared holds null. Sending it would refuse a NOT NULL DEFAULT 0 column
  // such as inventory_quantity, so it is left out like any other blank.
  const inventory = [{ name: 'name', type: 'text', required: true }, { name: 'inventoryQuantity', type: 'number' }];
  assert.deepEqual(
    prepareFieldValuesForSave(inventory, { name: 'Shirt', inventoryQuantity: null }, { native: true, mode: 'create' }),
    { name: 'Shirt' },
  );
  assert.deepEqual(
    prepareFieldValuesForSave(fields, { title: 'T', views: null, theme: null, author: null }, { native: true, mode: 'create' }),
    { title: 'T' },
  );
  // A filled zero is a value, not a blank.
  assert.deepEqual(
    prepareFieldValuesForSave(inventory, { name: 'Shirt', inventoryQuantity: 0 }, { native: true, mode: 'create' }),
    { name: 'Shirt', inventoryQuantity: 0 },
  );
});

test('a native update clears blank optional columns with null but sends unchanged values back as loaded', () => {
  const baseline = { views: 4, theme: '', author: 'a1', publishedAt: null, subtitle: 'x' };
  const values = { views: '', theme: '', author: '', publishedAt: undefined, subtitle: '', rating: '' };
  assert.deepEqual(prepareFieldValuesForSave(fields, values, { native: true, mode: 'update', baseline }), {
    views: null,
    // Stored as '' already: sent back unchanged.
    theme: '',
    author: null,
    publishedAt: null,
    subtitle: '',
    rating: '',
  });
  // A cleared number (null) on an update still clears the column.
  assert.deepEqual(
    prepareFieldValuesForSave(fields, { views: null }, { native: true, mode: 'update', baseline: { views: 4 } }),
    { views: null },
  );
});

test('only a stale edit counts as a conflict to reload; slug and unique clashes do not', () => {
  assert.equal(isStaleRecordConflict({ status: 409, code: 'revision_conflict', message: 'x' }), true);
  assert.equal(isStaleRecordConflict({ status: 409, code: 'stale_record', message: 'x' }), true);
  assert.equal(isStaleRecordConflict({ status: 409, code: 'slug_conflict', message: 'This entry changed since it was opened.' }), false);
  assert.equal(isStaleRecordConflict({ status: 409, code: 'constraint', message: 'Another record already uses this sku.' }), false);
  // Without a code, only the stale-edit wording counts.
  assert.equal(isStaleRecordConflict({ status: 409, code: null, message: 'This entry changed since it was opened. Reload it before saving.' }), true);
  assert.equal(isStaleRecordConflict({ status: 409, code: null, message: 'This record changed since it was opened. Reload it before saving.' }), true);
  assert.equal(isStaleRecordConflict({ status: 409, code: null, message: 'Another entry in this collection already uses this slug.' }), false);
  assert.equal(isStaleRecordConflict({ status: 409, code: null, message: 'This change conflicts with a related record.' }), false);
  assert.equal(isStaleRecordConflict({ status: 400, code: 'revision_conflict', message: 'x' }), false);

  assert.equal(isSlugConflict({ status: 409, code: 'slug_conflict', message: 'Taken.' }), true);
  assert.equal(isSlugConflict({ status: 422, code: 'slug_conflict', message: 'Taken.' }), true);
  assert.equal(isSlugConflict({ status: 409, code: null, message: 'Another entry in this collection already uses this slug.' }), true);
  assert.equal(isSlugConflict({ status: 409, code: 'constraint', message: 'Another record already uses this slug.' }), false);
  assert.equal(isSlugConflict({ status: 400, code: null, message: 'Slug is invalid' }), false);
});

test('the variant editor keeps edits only after a refusal that wrote nothing, and says what it shows', () => {
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

test('a published entry with a different draft slug has a pending rename', () => {
  assert.deepEqual(getPendingSlugRename({ slug: 'about-us', publishedSlug: 'about' }), { liveSlug: 'about', nextSlug: 'about-us' });
  assert.equal(getPendingSlugRename({ slug: 'about', publishedSlug: 'about' }), null);
  assert.equal(getPendingSlugRename({ slug: 'about', publishedSlug: null }), null);
  assert.deepEqual(getPendingSlugRename({ slug: 'about', publishedSlug: 'about' }, ' team '), { liveSlug: 'about', nextSlug: 'team' });
  // A blank slug keeps the current one, so it is not a rename.
  assert.equal(getPendingSlugRename({ slug: 'about-us', publishedSlug: 'about' }, ''), null);
  assert.equal(getPagePath('index'), '/');
  assert.equal(getPagePath('about/team'), '/about/team');
});

// The body of a publish answered with HTTP 202 by a Workflow still running it (src/api/handler.ts).
const pendingPublishBody = {
  id: 'e1',
  status: 'draft',
  workflow: { status: 'pending', instanceId: 'talisman-publish-posts-e1-1' },
  message: 'The publish is still running. Reload the entry in a moment to see the result.',
};

test('a 202 publish is read as pending, with the server message or a fallback', () => {
  const pending = readPendingTransition(pendingPublishBody, { action: 'publish', entryId: 'e1', fromRevisionId: 'r1' });
  assert.deepEqual(pending, { action: 'publish', entryId: 'e1', fromRevisionId: 'r1', message: pendingPublishBody.message });

  const withoutMessage = { ...pendingPublishBody, message: undefined };
  assert.equal(
    readPendingTransition({ ...withoutMessage, message: '  ' }, { action: 'archive', entryId: 'e1', recordLabel: 'entry' }).message,
    'The archive is still running. Reload the entry in a moment to see the result.',
  );
  assert.equal(readPendingTransition(withoutMessage, { action: 'publish', entryId: 'e1' }).fromRevisionId, null);
  // A finished transition (HTTP 200) has no workflow field, or one that is not pending.
  assert.equal(readPendingTransition({ id: 'e1', status: 'published' }, { action: 'publish', entryId: 'e1', fromRevisionId: 'r1' }), null);
  assert.equal(readPendingTransition({ ...pendingPublishBody, workflow: { status: 'complete' } }, { action: 'publish', entryId: 'e1' }), null);
  assert.equal(readPendingTransition(null, { action: 'publish', entryId: 'e1' }), null);
});

test('a pending transition has settled once the entry has a newer revision', () => {
  const pending = { action: 'publish', entryId: 'e1', fromRevisionId: 'r1', message: 'm' };
  assert.equal(hasEntryMovedOn({ id: 'e1', status: 'draft', latestRevisionId: 'r1' }, pending), false);
  assert.equal(hasEntryMovedOn({ id: 'e1', status: 'published', latestRevisionId: 'r2' }, pending), true);
  assert.equal(hasEntryMovedOn(null, pending), false);
  // An entry without revisions gets its first one from the transition.
  assert.equal(hasEntryMovedOn({ latestRevisionId: null }, { fromRevisionId: null }), false);
  assert.equal(hasEntryMovedOn({ latestRevisionId: 'r1' }, { fromRevisionId: null }), true);

  assert.equal(describeSettledTransition({ status: 'published', publishedRevisionId: 'r2', latestRevisionId: 'r2' }, pending), 'The entry is published.');
  assert.equal(describeSettledTransition({ status: 'archived', latestRevisionId: 'r2' }, { ...pending, action: 'archive' }), 'The entry is archived.');
  // Someone saved a draft instead, so the publish did not happen (or was followed by another change).
  assert.match(describeSettledTransition({ status: 'published', publishedRevisionId: 'r0', latestRevisionId: 'r2' }, pending), /changed while the publish was running/);
  assert.match(describeSettledTransition({ status: 'draft', latestRevisionId: 'r2' }, { ...pending, action: 'archive' }), /changed while the archive was running/);
});

test('waitForPendingTransition checks the entry after each delay until it moves on', async () => {
  const pending = { fromRevisionId: 'r1' };
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  const answers = [
    { id: 'e1', latestRevisionId: 'r1' },
    new Error('Failed to load this entry: the server could not be reached.'),
    { id: 'e1', status: 'published', latestRevisionId: 'r2' },
  ];
  let loads = 0;
  const loadEntry = async () => {
    const answer = answers[loads++];
    if (answer instanceof Error) throw answer;
    return answer;
  };

  const settled = await waitForPendingTransition(pending, { loadEntry, delays: [10, 20, 30, 40], sleep });
  assert.equal(settled.latestRevisionId, 'r2');
  // A failed check is not the end; the one after it finds the published entry and stops.
  assert.deepEqual(slept, [10, 20, 30]);
  assert.equal(loads, 3);

  // Still running after every check: the editor gets null and offers a manual reload.
  loads = 0;
  const stillRunning = await waitForPendingTransition(pending, { loadEntry: async () => { loads += 1; return { latestRevisionId: 'r1' }; }, delays: [1, 1], sleep });
  assert.equal(stillRunning, null);
  assert.equal(loads, 2);

  // Leaving the editor cancels the wait before the next load.
  let cancelled = false;
  loads = 0;
  const left = await waitForPendingTransition(pending, {
    loadEntry: async () => { loads += 1; cancelled = true; return { latestRevisionId: 'r1' }; },
    delays: [1, 1, 1],
    sleep,
    isCancelled: () => cancelled,
  });
  assert.equal(left, null);
  assert.equal(loads, 1);
  // The editor's own schedule waits a few seconds between checks.
  assert.ok(PENDING_TRANSITION_CHECK_DELAYS_MS.length > 0 && PENDING_TRANSITION_CHECK_DELAYS_MS.every((ms) => ms >= 1000));
});

test('commerce prices show in the store currency, scaled by its minor units', () => {
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
});

test('the admin reads the store currency from the page meta tag, and USD without a usable one', () => {
  const page = (content) => ({
    querySelector: (selector) => selector === 'meta[name="talisman-commerce-currency"]' && content !== null
      ? { getAttribute: (name) => (name === 'content' ? content : null) } : null,
  });
  try {
    globalThis.document = page('jpy');
    assert.equal(readCommerceCurrency(), 'jpy');
    globalThis.document = page(' KWD ');
    assert.equal(readCommerceCurrency(), 'kwd');
    for (const content of [null, '', 'dollars', 'u$d']) {
      globalThis.document = page(content);
      assert.equal(readCommerceCurrency(), 'usd', `content ${JSON.stringify(content)}`);
    }
  } finally {
    delete globalThis.document;
  }
  // Outside a browser there is no page to read.
  assert.equal(readCommerceCurrency(), 'usd');
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('fetchAllEntries reads every page with a bounded limit', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url, 'http://cms.test');
    seen.push(parsed.search);
    const cursor = parsed.searchParams.get('cursor');
    if (!cursor) return jsonResponse({ docs: [{ id: 'c' }, { id: 'b' }], nextCursor: 'p2' });
    return jsonResponse({ docs: [{ id: 'a' }], nextCursor: null });
  };

  assert.deepEqual((await fetchAllEntries('/admin', 'things')).map((entry) => entry.id), ['c', 'b', 'a']);
  assert.deepEqual(seen, ['?limit=200', '?limit=200&cursor=p2']);
  // Native pages come newest first; the old unpaged list was in table order.
  assert.deepEqual((await fetchAllEntries('/admin', 'things', { oldestFirst: true })).map((entry) => entry.id), ['a', 'b', 'c']);
});

test('fetchAllEntries treats a refused first page as empty and a failed later page as an error', async () => {
  globalThis.fetch = async () => jsonResponse({ error: 'Collection access denied' }, 403);
  assert.deepEqual(await fetchAllEntries('/admin', 'secret'), []);

  globalThis.fetch = async (url) => new URL(url, 'http://cms.test').searchParams.get('cursor')
    ? jsonResponse({ error: 'boom' }, 500)
    : jsonResponse({ docs: [{ id: 'a' }], nextCursor: 'p2' });
  await assert.rejects(fetchAllEntries('/admin', 'things'), /Failed to load every things record/);
});

test('a strict read does not take a refused first page for an empty collection', async () => {
  globalThis.fetch = async () => jsonResponse({ error: 'Unauthorized' }, 401);
  await assert.rejects(fetchAllEntries('/admin', 'things', { strict: true }), /^Error: Your session has expired/);
  globalThis.fetch = async () => jsonResponse({ error: 'boom' }, 500);
  await assert.rejects(fetchAllEntries('/admin', 'things', { strict: true }), /^Error: Failed to load things \(HTTP 500\)\.$/);
  assert.deepEqual(await fetchAllEntries('/admin', 'things'), []);

  // One refused list fails the whole strict read, so the variant editor keeps what it shows.
  globalThis.fetch = async (url) => new URL(url, 'http://cms.test').pathname.includes('/refused/')
    ? jsonResponse({ error: 'down' }, 503)
    : jsonResponse({ docs: [{ id: 'a' }], nextCursor: null });
  await assert.rejects(fetchEntriesBySlug('/admin', ['ok', 'refused'], [], { strict: true }), /Failed to load refused \(HTTP 503\)/);
  assert.deepEqual(await fetchEntriesBySlug('/admin', ['ok', 'refused'], []), { ok: [{ id: 'a' }], refused: [] });
});

test('fetchEntriesBySlug loads collections in parallel and restores table order for native ones', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = async (url) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    const slug = new URL(url, 'http://cms.test').pathname.split('/')[4];
    return jsonResponse({ docs: [{ id: `${slug}-2` }, { id: `${slug}-1` }], nextCursor: null });
  };

  const result = await fetchEntriesBySlug('/admin', ['native', 'entries'], [{ slug: 'native', nativeSchemaMapping: {} }, { slug: 'entries' }]);
  assert.equal(maxInFlight, 2);
  assert.deepEqual(result.native.map((entry) => entry.id), ['native-1', 'native-2']);
  assert.deepEqual(result.entries.map((entry) => entry.id), ['entries-2', 'entries-1']);
});

test('fetchCollectionConfigs reuses a recent answer unless asked for a fresh one', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse([{ slug: `c${calls}` }]);
  };

  const first = await fetchCollectionConfigs('/cache-test');
  const second = await fetchCollectionConfigs('/cache-test');
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
  const fresh = await fetchCollectionConfigs('/cache-test', { fresh: true });
  assert.equal(calls, 2);
  assert.deepEqual(fresh, [{ slug: 'c2' }]);

  globalThis.fetch = async () => jsonResponse({ error: 'down' }, 503);
  await assert.rejects(fetchCollectionConfigs('/cache-fail'), /Failed to fetch collections/);
  globalThis.fetch = async () => jsonResponse([{ slug: 'ok' }]);
  // A failed answer is not kept.
  assert.deepEqual(await fetchCollectionConfigs('/cache-fail'), [{ slug: 'ok' }]);
});

// A localStorage stand-in: the collapsed-state module takes its storage as a parameter.
function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    keys: () => [...map.keys()],
  };
}

test('collapsed cards are kept under one key per entry and written only when they change', () => {
  const storage = memoryStorage();
  const entry = 'talisman-cms:collapsed:collection:pages:p1';
  assert.deepEqual(readCollapsedCards(entry, 'layout', storage), {});
  // Mounting a field writes nothing: no collapsed card is also the stored state.
  assert.equal(writeCollapsedCards(entry, 'layout', {}, storage), false);
  assert.equal(writeCollapsedCards(entry, 'layout', { 'layout:0': false }, storage), false);
  assert.deepEqual(storage.keys(), []);

  assert.equal(writeCollapsedCards(entry, 'layout', { 'layout:0': true, 'layout:1': false }, storage), true);
  assert.equal(writeCollapsedCards(entry, 'sidebar', { 'sidebar:2': true }, storage), true);
  // The same cards again, in another order or with expanded cards listed, change nothing.
  assert.equal(writeCollapsedCards(entry, 'layout', { 'layout:1': false, 'layout:0': true }, storage), false);
  assert.deepEqual(storage.keys().sort(), [COLLAPSED_STATE_INDEX_KEY, entry].sort());
  assert.deepEqual(JSON.parse(storage.getItem(entry)), { layout: { 'layout:0': true }, sidebar: { 'sidebar:2': true } });
  assert.deepEqual(readCollapsedCards(entry, 'layout', storage), { 'layout:0': true });
  assert.deepEqual(readCollapsedCards(entry, 'other', storage), {});

  // Expanding the last card of a field drops the field; of the entry, the entry and its index row.
  assert.equal(writeCollapsedCards(entry, 'layout', {}, storage), true);
  assert.deepEqual(JSON.parse(storage.getItem(entry)), { sidebar: { 'sidebar:2': true } });
  assert.equal(writeCollapsedCards(entry, 'sidebar', { 'sidebar:2': false }, storage), true);
  assert.deepEqual(storage.keys(), []);

  // Without a scope key or storage nothing is read or written.
  assert.deepEqual(readCollapsedCards(undefined, 'layout', storage), {});
  assert.equal(writeCollapsedCards(undefined, 'layout', { a: true }, storage), false);
  assert.equal(writeCollapsedCards(entry, 'layout', { a: true }, null), false);
});

test('the collapsed-state index keeps the 50 most recently written entries and evicts the oldest', () => {
  const storage = memoryStorage();
  const key = (n) => `talisman-cms:collapsed:collection:posts:${n}`;
  for (let n = 0; n < COLLAPSED_STATE_MAX_ENTRIES; n += 1) writeCollapsedCards(key(n), 'layout', { 'layout:0': true }, storage);
  assert.equal(storage.length, COLLAPSED_STATE_MAX_ENTRIES + 1);
  // Writing entry 0 again makes it the newest, so entry 1 is the oldest and goes first.
  writeCollapsedCards(key(0), 'layout', { 'layout:0': true, 'layout:1': true }, storage);
  writeCollapsedCards(key(50), 'layout', { 'layout:0': true }, storage);
  assert.equal(storage.getItem(key(1)), null);
  assert.deepEqual(readCollapsedCards(key(0), 'layout', storage), { 'layout:0': true, 'layout:1': true });
  assert.deepEqual(readCollapsedCards(key(50), 'layout', storage), { 'layout:0': true });
  const index = JSON.parse(storage.getItem(COLLAPSED_STATE_INDEX_KEY));
  assert.equal(index.length, COLLAPSED_STATE_MAX_ENTRIES);
  assert.equal(index[0], key(2));
  assert.deepEqual(index.slice(-2), [key(0), key(50)]);
  assert.equal(storage.length, COLLAPSED_STATE_MAX_ENTRIES + 1);
});

test('pruning removes collapsed-state keys the index does not list, such as the old per-field keys', () => {
  const entry = 'talisman-cms:collapsed:collection:pages:p1';
  const storage = memoryStorage({
    [`${entry}:layout`]: JSON.stringify({ 'layout:0': true }),
    'talisman-cms:collapsed:global:site:hero': JSON.stringify({}),
    'talisman-cms:collapsed:collection:posts:orphan': JSON.stringify({ layout: { 'layout:0': true } }),
    'talisman-cms:other': 'kept',
  });
  writeCollapsedCards(entry, 'layout', { 'layout:0': true }, storage);
  assert.deepEqual(pruneCollapsedState(storage).sort(), [
    `${entry}:layout`,
    'talisman-cms:collapsed:collection:posts:orphan',
    'talisman-cms:collapsed:global:site:hero',
  ]);
  assert.deepEqual(storage.keys().sort(), [COLLAPSED_STATE_INDEX_KEY, entry, 'talisman-cms:other'].sort());
  assert.deepEqual(pruneCollapsedState(storage), []);
  assert.deepEqual(pruneCollapsedState(null), []);
});

test('collapsed-state reads and writes survive corrupt values and broken storage', () => {
  const entry = 'talisman-cms:collapsed:collection:pages:p1';
  const corrupt = memoryStorage({ [entry]: 'not json', [COLLAPSED_STATE_INDEX_KEY]: '{"no":"array"}' });
  assert.deepEqual(readCollapsedCards(entry, 'layout', corrupt), {});
  assert.equal(writeCollapsedCards(entry, 'layout', { 'layout:0': true }, corrupt), true);
  assert.deepEqual(JSON.parse(corrupt.getItem(COLLAPSED_STATE_INDEX_KEY)), [entry]);
  // Values that are not card maps are ignored rather than thrown on.
  const odd = memoryStorage({ [entry]: JSON.stringify({ layout: ['x'], sidebar: { a: 'yes', b: true } }) });
  assert.deepEqual(readCollapsedCards(entry, 'layout', odd), {});
  assert.deepEqual(readCollapsedCards(entry, 'sidebar', odd), { b: true });

  const full = memoryStorage();
  full.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(writeCollapsedCards(entry, 'layout', { 'layout:0': true }, full), false);
  const fail = () => { throw new Error('blocked'); };
  const blocked = { get length() { return fail(); }, key: fail, getItem: fail, setItem: fail, removeItem: fail };
  assert.deepEqual(readCollapsedCards(entry, 'layout', blocked), {});
  assert.equal(writeCollapsedCards(entry, 'layout', { 'layout:0': true }, blocked), false);
  assert.deepEqual(pruneCollapsedState(blocked), []);
});
