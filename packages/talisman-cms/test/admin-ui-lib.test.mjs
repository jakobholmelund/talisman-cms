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
} =
  await loadAdminModule('lib/entry-save.ts');
const { fetchAllEntries, fetchCollectionConfigs, fetchEntriesBySlug, fetchEntriesPage } = await loadAdminModule('lib/admin-api.ts');
const { describeEntryWith, describeEntryGeneric, getEntryOptionLabel, getSupportCollectionSlugsWith, readAdminSetting } =
  await loadAdminModule('lib/entry-labels.ts');
const { COLLAPSED_STATE_INDEX_KEY, COLLAPSED_STATE_MAX_ENTRIES, pruneCollapsedState, readCollapsedCards, writeCollapsedCards } =
  await loadAdminModule('lib/collapsed-state.ts');
const { validateCollectionListSearch, normalizeCollectionListSearch, getCollectionListOptions, collectionListParams } =
  await loadAdminModule('lib/collection-list.ts');
const { revisionData, equalRevisionValues, compareRevisionFields, revisionRichText, compareConflictFields, applyConflictChoices, withFieldChanges, conflictSnapshotData, conflictFieldChanges } =
  await loadAdminModule('lib/revision-comparison.ts');

const { validateMediaSearch, mediaSearchParams, mediaEntrySearch, validateMediaReturnSearch } =
  await loadAdminModule('lib/media-search.ts');

test('media search bounds filenames and accepts only supported type filters', () => {
  assert.deepEqual(validateMediaSearch({ q: '  photo_%  ', type: 'png', cursor: 'untrusted' }), { q: 'photo_%', type: 'png' });
  assert.deepEqual(validateMediaSearch({ q: ['bad'], type: 'image/anything' }), {});
  assert.equal(validateMediaSearch({ q: 'x'.repeat(201) }).q.length, 200);
});

test('media queries keep server filters on every cursor page', () => {
  const params = mediaSearchParams({ q: 'sample_%', type: 'jpeg' }, 48, 'page-two');
  assert.deepEqual(Object.fromEntries(params), { limit: '48', 'where[filename][text]': 'sample_%', 'where[mimeType]': 'image/jpeg', cursor: 'page-two' });
  assert.deepEqual(Object.fromEntries(mediaSearchParams({}, 60)), { limit: '60' });
});

test('media editor return state is bounded and cannot redirect to another destination', () => {
  assert.deepEqual(mediaEntrySearch({ q: 'photo', type: 'webp' }), { from: 'media', mediaQ: 'photo', mediaType: 'webp' });
  assert.deepEqual(validateMediaReturnSearch({ from: '//external.example', mediaQ: 'ignored' }), {});
  assert.deepEqual(validateMediaReturnSearch({ from: 'media', mediaQ: '  photo  ', mediaType: 'unknown' }), { from: 'media', mediaQ: 'photo' });
});

test('conflict review distinguishes overlapping, private and already-saved changes', () => {
  const original = { data: { title: 'Opened', views: 0, subtitle: 'Original', serverOnly: 'Old' } };
  const mine = { data: { title: 'Mine', views: 5, subtitle: 'Same', serverOnly: 'Old' } };
  const latest = { data: { title: 'Latest', views: 0, subtitle: 'Same', serverOnly: 'New' } };
  const rows = compareConflictFields([{ name: 'title', label: 'Page title' }], original, mine, latest);
  assert.deepEqual(rows.map(({ key, label, kind }) => ({ key, label, kind })), [
    { key: 'data:title', label: 'Page title', kind: 'overlap' },
    { key: 'data:views', label: 'Views', kind: 'mine-only' },
    { key: 'data:subtitle', label: 'Subtitle', kind: 'already-saved' },
  ]);
  assert.throws(() => applyConflictChoices(latest, mine, rows, {}), /Choose a value for Page title/);
  assert.deepEqual(applyConflictChoices(latest, mine, rows, { 'data:title': 'latest' }), { data: { title: 'Latest', views: 5, subtitle: 'Same', serverOnly: 'New' } });
  assert.equal(applyConflictChoices(latest, mine, rows, { 'data:title': 'mine' }).data.title, 'Mine');
  assert.equal(latest.data.views, 0);
});

test('conflict choices handle additions, deletions and null without merging array positions', () => {
  const original = { data: { removed: 'Old', empty: null, layout: [{ heading: 'Opened' }] } };
  const mine = { data: { empty: '', added: null, layout: [{ heading: 'Mine' }] } };
  const latest = { data: { removed: 'Old', empty: null, layout: [{ heading: 'Latest' }], extra: true } };
  const rows = compareConflictFields([], original, mine, latest);
  assert.equal(rows.find(row => row.name === 'layout').kind, 'overlap');
  assert.deepEqual(applyConflictChoices(latest, mine, rows, { 'data:layout': 'mine' }), { data: { empty: '', layout: [{ heading: 'Mine' }], extra: true, added: null } });
});

test('URL slug and a data field named slug have independent conflict choices', () => {
  const original = { data: { slug: 'Data opened' }, slug: 'opened' };
  const mine = { data: { slug: 'Data mine' }, slug: 'mine' };
  const latest = { data: { slug: 'Data latest' }, slug: 'latest' };
  const rows = compareConflictFields([], original, mine, latest);
  assert.deepEqual(rows.map(row => row.key), ['entry-slug', 'data:slug']);
  assert.deepEqual(applyConflictChoices(latest, mine, rows, { 'entry-slug': 'latest', 'data:slug': 'mine' }), { data: { slug: 'Data mine' }, slug: 'latest' });
});

test('conflict review compares rich-text structure and ignores object member order', () => {
  const content = { type: 'text', text: 'Same' };
  const original = { data: { content, settings: { a: 1, b: 2 } } };
  const mine = { data: { content: { ...content, marks: [{ type: 'bold' }] }, settings: { b: 2, a: 1 } } };
  const latest = { data: { content: { ...content, marks: [{ type: 'italic' }] }, settings: { a: 1, b: 2 } } };
  assert.deepEqual(compareConflictFields([], original, mine, latest).map(row => [row.name, row.kind]), [['content', 'overlap']]);
});

test('conflict field changes keep prototype names as values and preserve explicit removals', () => {
  const mine = JSON.parse('{"__proto__":{"text":"Mine"}}');
  const rows = compareConflictFields([], { data: {} }, { data: mine }, { data: {} });
  const result = applyConflictChoices({ data: { untouched: true } }, { data: mine }, rows, {});
  assert.equal(Object.hasOwn(result.data, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(result.data), Object.prototype);
  assert.deepEqual(withFieldChanges({ removed: 'Old', keep: 1 }, { removed: undefined, fresh: null }), { keep: 1, fresh: null });
});

test('empty nested editor settings do not replace a held draft with the loaded version', () => {
  const saved = { layout: [{ blockType: 'hero', heading: 'Saved' }], removed: 'Opened' };
  const form = { layout: [{ blockType: 'hero', heading: 'Saved', presentation: undefined }], removed: undefined };
  const snapshot = conflictSnapshotData(form);
  assert.equal(equalRevisionValues(snapshot.layout, saved.layout), true);
  assert.equal(Object.hasOwn(snapshot, 'removed'), false);
  const held = { layout: [{ blockType: 'hero', heading: 'Mine' }] };
  const newer = Object.fromEntries(Object.keys(saved).filter(name => !equalRevisionValues(snapshot[name], saved[name])).map(name => [name, snapshot[name]]));
  assert.deepEqual(withFieldChanges(saved, { ...held, ...newer }), held);
  assert.equal(Object.hasOwn(form.layout[0], 'presentation'), true);
});

test('post-reload edits returning to the original value remain explicit conflict choices', () => {
  const original = { data: { title: 'Original', views: 0 } };
  const latest = { data: { title: 'Saved', views: 0 } };
  const newer = conflictFieldChanges(latest.data, { title: 'Original', views: 0 });
  const mine = { data: withFieldChanges(original.data, newer) };
  const rows = compareConflictFields([], original, mine, latest, Object.keys(newer));
  assert.deepEqual(rows.map(row => [row.name, row.kind]), [['title', 'overlap']]);
  assert.throws(() => applyConflictChoices(latest, mine, rows, {}), /Choose a value/);
  assert.equal(applyConflictChoices(latest, mine, rows, { 'data:title': 'mine' }).data.title, 'Original');
});

test('capturing field changes preserves removals, key ordering and optional editor settings', () => {
  const baseline = { remove: 'Old', group: { a: 1, b: 2 }, added: null };
  const draft = { group: { b: 2, a: 1, empty: undefined }, added: 'New', list: [1, 2] };
  assert.deepEqual(conflictFieldChanges(baseline, draft), { remove: undefined, added: 'New', list: [1, 2] });
  assert.deepEqual(withFieldChanges(baseline, conflictFieldChanges(baseline, draft)), { group: { a: 1, b: 2 }, added: 'New', list: [1, 2] });
});

test('post-load removal of a field another writer added remains reviewable', () => {
  const original = { data: { title: 'Same' } };
  const latest = { data: { title: 'Same', serverAdded: 'Saved' } };
  const newer = conflictFieldChanges(latest.data, original.data);
  const rows = compareConflictFields([], original, original, latest, Object.keys(newer));
  assert.deepEqual(rows.map(row => [row.name, row.kind]), [['serverAdded', 'overlap']]);
  assert.deepEqual(applyConflictChoices(latest, original, rows, { 'data:serverAdded': 'mine' }), original);
});

test('revision comparison ignores object key ordering but preserves array order', () => {
  assert.equal(equalRevisionValues({ settings: { a: 1, b: 2 } }, { settings: { b: 2, a: 1 } }), true);
  assert.equal(equalRevisionValues([1, 2], [2, 1]), false);
  assert.equal(equalRevisionValues([], {}), false);
  assert.equal(equalRevisionValues(false, 0), false);
});

test('revision comparison describes added, removed and changed fields using schema labels', () => {
  const rows = compareRevisionFields([{ name: 'title', label: 'Page title' }], { title: 'Old', retired_copy: 'Removed', empty: null }, { title: 'New', fresh: 'Added', empty: null });
  assert.deepEqual(rows.map(({ name, label, change }) => ({ name, label, change })), [
    { name: 'title', label: 'Page title', change: 'changed' },
    { name: 'retired_copy', label: 'Retired copy', change: 'removed' },
    { name: 'empty', label: 'Empty', change: 'unchanged' },
    { name: 'fresh', label: 'Fresh', change: 'added' },
  ]);
  assert.equal(compareRevisionFields([], {}, { empty: null })[0].change, 'added');
});

test('revision comparison retains nested block, rich text formatting and schema-removed changes', () => {
  const before = { layout: [{ blockType: 'hero', heading: 'A' }], content: { type: 'text', text: 'Same words' }, legacy: 'Old schema' };
  const after = { layout: [{ blockType: 'hero', heading: 'B' }], content: { type: 'text', text: 'Same words', marks: [{ type: 'bold' }] } };
  assert.deepEqual(compareRevisionFields([], before, after).map(row => row.change), ['changed', 'changed', 'removed']);
  assert.equal(revisionRichText(before.content), revisionRichText(after.content));
});

test('revision comparison never treats inherited properties as saved content', () => {
  const before = JSON.parse('{"__proto__":{"text":"Old"}}');
  assert.equal(compareRevisionFields([], before, {})[0].change, 'removed');
  assert.equal(equalRevisionValues(before, {}), false);
});

test('revision data accepts serialized snapshots and refuses unreadable content', () => {
  assert.deepEqual(revisionData({ data: '{"title":"Old"}' }), { title: 'Old' });
  for (const data of [null, [], 3, 'invalid']) assert.throws(() => revisionData({ data }));
});

test('rich text revision previews preserve paragraph boundaries and literal hostile text', () => {
  const value = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph' }] }] };
  assert.equal(revisionRichText(value), '<img src=x onerror=alert(1)>\nSecond paragraph');
});

test('deeply nested stored JSON compares without consuming a recursive call stack', () => {
  let before = { value: 1 }, after = { value: 1 };
  for (let index = 0; index < 10000; index++) { before = { nested: before }; after = { nested: after }; }
  assert.equal(equalRevisionValues(before, after), true);
});

test('collection list URLs bound query/page input and discard arbitrary sort keys', () => {
  assert.deepEqual(validateCollectionListSearch({ q: '  %_needle  ', status: 'draft', sort: 'name', page: '2' }), { q: '%_needle', status: 'draft', sort: 'name', page: 2 });
  for (const page of [-1, 0, 1.5, 202, Infinity, 'invalid']) {
    assert.deepEqual(validateCollectionListSearch({ q: {}, sort: 'privateField', page }), {});
  }
  assert.equal(validateCollectionListSearch({ q: 'x'.repeat(300) }).q.length, 200);
});

test('collection list search/status/sort apply before offset pagination', () => {
  const collection = { fields: [{ name: 'title', label: 'Title', type: 'text' }, { name: 'name', type: 'text' }] };
  const params = collectionListParams(collection, { q: 'needle', status: 'published', sort: 'name-desc', page: 2 });
  assert.equal(params.get('where[title][text]'), 'needle');
  assert.equal(params.get('where[status]'), 'published');
  assert.equal(params.get('sort'), '-title');
  assert.equal(params.get('limit'), '51');
  assert.equal(params.get('offset'), '50');
  assert.equal(params.has('cursor'), false);
  assert.equal(collectionListParams(collection, { page: 201 }).get('offset'), '10000');
});

test('native lists use configured business statuses and a stable ID sort', () => {
  const collection = { nativeSchemaMapping: { idColumn: 'recordId' }, fields: [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'status', type: 'select', options: ['active', { label: 'On hold', value: 'on_hold' }] },
  ] };
  const options = getCollectionListOptions(collection);
  assert.deepEqual(options.statuses, [{ label: 'active', value: 'active' }, { label: 'On hold', value: 'on_hold' }]);
  assert.deepEqual(normalizeCollectionListSearch(collection, { q: 'A', status: 'draft', sort: 'updated' }), { q: 'A' });
  const params = collectionListParams(collection, { q: 'A', status: 'active', sort: 'name' });
  assert.equal(params.get('where[name][text]'), 'A');
  assert.equal(params.get('where[status]'), 'active');
  assert.equal(params.get('sort'), 'name,recordId');
});

test('lists without searchable text or native status fields do not issue unsupported filters', () => {
  const collection = { nativeSchemaMapping: {}, fields: [{ name: 'price', type: 'number' }] };
  assert.deepEqual(normalizeCollectionListSearch(collection, { q: 'needle', status: 'draft', sort: 'name' }), {});
  assert.deepEqual(getCollectionListOptions(collection).sorts, [{ value: '', label: 'Newest first' }]);
  assert.equal(collectionListParams(collection, {}).toString(), 'limit=51&offset=0');
});

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

test('a native update leaves out an unchanged field with saveOnlyIfChanged, and sends it once changed', () => {
  const stockFields = [
    { name: 'name', type: 'text', required: true },
    { name: 'quantity', type: 'number', saveOnlyIfChanged: true },
    { name: 'note', type: 'text' },
  ];
  const baseline = { name: 'Poster', quantity: 4, note: '' };
  // Untouched: the count is left out, so a checkout that reserved stock meanwhile is not undone.
  assert.deepEqual(prepareFieldValuesForSave(stockFields, { name: 'Poster', quantity: 4, note: 'x' }, { native: true, mode: 'update', baseline }),
    { name: 'Poster', note: 'x' });
  // Changed: the new count is written.
  assert.deepEqual(prepareFieldValuesForSave(stockFields, { name: 'Poster', quantity: 9, note: '' }, { native: true, mode: 'update', baseline }),
    { name: 'Poster', quantity: 9, note: '' });
  // A new row and a stored-JSON entry always send the field: there is nothing to preserve.
  assert.deepEqual(prepareFieldValuesForSave(stockFields, { name: 'Poster', quantity: 4, note: '' }, { native: true, mode: 'create', baseline }),
    { name: 'Poster', quantity: 4, note: '' });
  assert.deepEqual(prepareFieldValuesForSave(stockFields, { name: 'Poster', quantity: 4, note: '' }),
    { name: 'Poster', quantity: 4, note: '' });
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

test('a record is described by the first describer that knows it, else from its own fields', () => {
  const product = { id: 'p1', slug: 'poster-entry', data: { name: 'Poster', slug: 'poster', sku: 'PST-1' } };
  const bare = { id: 'abcdef12', data: {} };
  assert.deepEqual(describeEntryGeneric(product), { title: 'Poster', subtitle: '/poster • SKU PST-1', details: [] });
  assert.deepEqual(describeEntryGeneric({ id: 'v1', data: { value: 'Blue' } }), { title: 'Blue', subtitle: '', details: [] });
  assert.deepEqual(describeEntryGeneric(bare), { title: 'abcdef12', subtitle: '', details: [] });
  assert.deepEqual(describeEntryGeneric(null), { title: 'Unknown record', subtitle: '', details: [] });

  const calls = [];
  const silent = { describeEntry: (slug) => { calls.push(['silent', slug]); return null; } };
  const products = {
    describeEntry: (slug, entry, entriesBySlug, context) => {
      calls.push(['products', slug, context.readSetting('COMMERCE_CURRENCY')]);
      return slug === 'products' ? { title: `${entry.data.name} (${entriesBySlug.products.length} loaded)`, subtitle: '', details: ['Type: poster'] } : null;
    },
  };
  const context = { readSetting: (name) => (name === 'COMMERCE_CURRENCY' ? 'jpy' : null) };
  const entries = { products: [product] };
  assert.deepEqual(describeEntryWith([silent, products], 'products', product, entries, context),
    { title: 'Poster (1 loaded)', subtitle: '', details: ['Type: poster'] });
  assert.deepEqual(calls, [['silent', 'products'], ['products', 'products', 'jpy']]);
  // A record no describer knows falls back to the generic description; a missing record needs no describer.
  assert.equal(describeEntryWith([silent, products], 'authors', { id: 'a1', data: { name: 'Ada' } }, {}, context).title, 'Ada');
  assert.equal(describeEntryWith([products], 'products', null, entries, context).title, 'Unknown record');
  // A describer that answers with blanks still yields a usable label.
  assert.deepEqual(describeEntryWith([{ describeEntry: () => ({ title: '', subtitle: null, details: null }) }], 'x', bare, {}, context),
    { title: 'abcdef12', subtitle: '', details: [] });
  assert.equal(getEntryOptionLabel({ title: 'Poster', subtitle: '/poster', details: [] }), 'Poster - /poster');
  assert.equal(getEntryOptionLabel({ title: 'Poster', subtitle: '', details: [] }), 'Poster');
});

test('the editor loads the relation targets plus what every describer asks for, once each', () => {
  const describers = [
    { supportCollections: (slug, targets) => (slug === 'products' ? ['_options', ...targets] : null) },
    { supportCollections: () => ['_options', 'presets', ''] },
    {},
  ];
  assert.deepEqual(getSupportCollectionSlugsWith(describers, 'products', ['categories']), ['categories', '_options', 'presets']);
  assert.deepEqual(getSupportCollectionSlugsWith(describers, 'posts', ['authors']), ['authors', '_options', 'presets']);
  assert.deepEqual(getSupportCollectionSlugsWith([], 'posts', ['authors']), ['authors']);
});

test('a plugin setting is read from the page meta tag the admin renders for it', () => {
  const page = (tags) => ({
    querySelector: (selector) => {
      const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1];
      return name && name in tags ? { getAttribute: (attribute) => (attribute === 'content' ? tags[name] : null) } : null;
    },
  });
  try {
    globalThis.document = page({ 'talisman-setting-commerce-currency': ' JPY ', 'talisman-setting-store-name': '' });
    assert.equal(readAdminSetting('COMMERCE_CURRENCY'), 'JPY');
    assert.equal(readAdminSetting('STORE_NAME'), null, 'an empty tag reads as unset');
    assert.equal(readAdminSetting('OTHER'), null, 'a missing tag reads as unset');
  } finally {
    delete globalThis.document;
  }
  // Outside a browser there is no page to read.
  assert.equal(readAdminSetting('COMMERCE_CURRENCY'), null);
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


test('relationship search reads one bounded page and exposes the cursor without eager continuation', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return Response.json({ docs: [{ id: 'match-on-page-two', data: { title: 'Needle' } }], nextCursor: 'opaque-next' });
  };
  try {
    const page = await fetchEntriesPage('/admin', 'authors', { search: '  Needle  ', searchField: 'name', cursor: 'opaque-first' });
    assert.equal(calls.length, 1);
    const url = new URL(calls[0], 'https://example.com');
    assert.equal(url.searchParams.get('limit'), '30');
    assert.equal(url.searchParams.get('where[name][text]'), 'Needle');
    assert.equal(url.searchParams.get('cursor'), 'opaque-first');
    assert.equal(page.docs[0].id, 'match-on-page-two');
    assert.equal(page.nextCursor, 'opaque-next');
  } finally { globalThis.fetch = original; }
});

test('relationship search errors distinguish an expired session and refuse malformed pages', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    await assert.rejects(fetchEntriesPage('/admin', 'authors'), /session has expired.*selections are still here/);
    globalThis.fetch = async () => Response.json([]);
    await assert.rejects(fetchEntriesPage('/admin', 'authors'), /unexpected page/);
  } finally { globalThis.fetch = original; }
});
