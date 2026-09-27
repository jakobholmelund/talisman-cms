import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  admin,
  as,
  call,
  database,
  doc,
  editor,
  getClient,
  hourAgo,
  liveSlug,
  parts,
  publicClient,
  revisionCount,
  runtime,
  seedPost,
  skip,
  types,
  versioning,
} from './helpers/handler-harness.mjs';

test('entries seeded without revisions can be saved; entries with revisions still need the latest id', { skip }, async () => {
  const sqlite = database();
  try {
    await seedPost(sqlite, 'seeded', { title: 'Seeded', body: doc('Hello') });
    const loaded = await call('GET', '/collections/posts/entries/seeded');
    assert.equal(loaded.body.latestRevisionId, null);

    const saved = await call('PUT', '/collections/posts/entries/seeded', {
      data: { title: 'Edited', body: doc('Hello') }, expectedRevisionId: loaded.body.latestRevisionId,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.publishedData, { title: 'Seeded', body: doc('Hello') });
    assert.equal(revisionCount(sqlite, 'seeded'), 2);

    const missing = await call('PUT', '/collections/posts/entries/seeded', { data: { title: 'No id', body: doc('Hello') } });
    assert.equal(missing.status, 428);
    const staleNull = await call('PUT', '/collections/posts/entries/seeded', { data: { title: 'Stale', body: doc('Hello') }, expectedRevisionId: null });
    assert.equal(staleNull.status, 409);
    assert.equal(staleNull.body.error, 'This entry changed since it was opened. Reload it before saving.');
    const missingPublish = await call('POST', '/collections/posts/entries/seeded/publish', {});
    assert.equal(missingPublish.status, 428);
    assert.equal(revisionCount(sqlite, 'seeded'), 2);

    const latest = await call('GET', '/collections/posts/entries/seeded');
    const published = await call('POST', '/collections/posts/entries/seeded/publish', { expectedRevisionId: latest.body.latestRevisionId });
    assert.equal(published.status, 200);
    assert.deepEqual(published.body.publishedData, { title: 'Edited', body: doc('Hello') });

    // A client that leaves the id out is still accepted while the entry has no revisions.
    await seedPost(sqlite, 'second', { title: 'Second', body: doc('Hi') }, 'draft');
    assert.equal((await call('POST', '/collections/posts/entries/second/publish', {})).status, 200);
    assert.equal(revisionCount(sqlite, 'second'), 2);
  } finally {
    sqlite.close();
  }
});

test('required fields reject blank text and empty rich text, and publishing checks the draft', { skip }, async () => {
  const sqlite = database();
  try {
    const invalid = await call('POST', '/collections/posts/entries', {
      data: { title: '   ', body: { type: 'doc', content: [{ type: 'paragraph' }] } },
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body.fieldErrors, { title: ['Required'], body: ['Required'] });
    assert.equal(typeof invalid.body.error, 'string');
    assert.ok(Array.isArray(invalid.body.issues));

    const missing = await call('POST', '/collections/posts/entries', { data: { title: 'Title', body: null } });
    assert.deepEqual(missing.body.fieldErrors, { body: ['Required'] });

    const created = await call('POST', '/collections/posts/entries', { data: { title: 'Title', body: doc('Text'), summary: '' } });
    assert.equal(created.status, 201);

    const latest = await call('GET', `/collections/posts/entries/${created.body.id}`);
    const cleared = await call('PUT', `/collections/posts/entries/${created.body.id}`, {
      data: { title: 'Title', body: '<p> </p>' }, expectedRevisionId: latest.body.latestRevisionId,
    });
    assert.deepEqual(cleared.body.fieldErrors, { body: ['Required'] });

    // A draft seeded without its required fields cannot go live.
    await seedPost(sqlite, 'incomplete', { title: '' }, 'draft');
    const publish = await call('POST', '/collections/posts/entries/incomplete/publish', { expectedRevisionId: null });
    assert.equal(publish.status, 400);
    assert.deepEqual(publish.body.fieldErrors, { title: ['Required'], body: ['Required'] });
    assert.equal(sqlite.prepare(`SELECT status FROM galaxy_entries WHERE id = 'incomplete'`).get().status, 'draft');
    assert.equal(revisionCount(sqlite, 'incomplete'), 0);
  } finally {
    sqlite.close();
  }
});

test('globals are stored once as JSON objects and read back as objects', { skip }, async () => {
  const sqlite = database();
  try {
    const saved = await call('POST', '/globals/site', { siteName: 'Talisman Vision' });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.data, { siteName: 'Talisman Vision' });
    const row = () => sqlite.prepare(`SELECT data FROM galaxy_globals WHERE slug = 'site'`).get().data;
    assert.equal(row(), '{"siteName":"Talisman Vision"}');

    const blank = await call('POST', '/globals/site', { siteName: ' ' });
    assert.equal(blank.status, 400);
    assert.deepEqual(blank.body.fieldErrors, { siteName: ['Required'] });
    assert.ok(blank.body.details);
    assert.equal((await call('POST', '/globals/site', ['not', 'an', 'object'])).status, 400);
    assert.equal(row(), '{"siteName":"Talisman Vision"}');

    // A row written before the fix holds the JSON text inside a JSON string.
    sqlite.prepare(`UPDATE galaxy_globals SET data = ? WHERE slug = 'site'`).run(JSON.stringify(JSON.stringify({ siteName: 'Legacy' })));
    assert.deepEqual((await call('GET', '/globals/site')).body.data, { siteName: 'Legacy' });

    const created = await call('POST', '/globals', { slug: 'footer', name: 'Footer', data: { note: 'Hi' } });
    assert.equal(created.status, 201);
    assert.equal(sqlite.prepare(`SELECT data FROM galaxy_globals WHERE slug = 'footer'`).get().data, '{"note":"Hi"}');
    assert.deepEqual((await call('GET', '/globals/footer')).body.data, { note: 'Hi' });
  } finally {
    sqlite.close();
  }
});

test('native records refuse a save based on a stale updatedAt and keep columns the editor left out', { skip }, async () => {
  const sqlite = database();
  try {
    sqlite.prepare('INSERT INTO test_parts (id, name, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('frame', 'Frame', 7, hourAgo, hourAgo);
    const stored = () => ({ ...sqlite.prepare(`SELECT name, quantity, updated_at FROM test_parts WHERE id = 'frame'`).get() });
    const loaded = await call('GET', '/collections/parts/entries/frame');
    const openedAt = loaded.body.updatedAt;

    // Stock the editor did not touch is left out, so a checkout decrement in the meantime survives.
    sqlite.prepare(`UPDATE test_parts SET quantity = 6 WHERE id = 'frame'`).run();
    const saved = await call('PUT', '/collections/parts/entries/frame', { data: { name: 'Frame body' }, expectedUpdatedAt: openedAt });
    assert.equal(saved.status, 200);
    assert.equal(stored().name, 'Frame body');
    assert.equal(stored().quantity, 6);
    // The response carries updatedAt as stored, so it works as the next save's expectation.
    assert.equal(Date.parse(saved.body.updatedAt), stored().updated_at * 1000);

    const stale = await call('PUT', '/collections/parts/entries/frame', { data: { name: 'Stale' }, expectedUpdatedAt: openedAt });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'This record changed since it was opened. Reload it before saving.');
    assert.equal(stored().name, 'Frame body');

    const blank = await call('PUT', '/collections/parts/entries/frame', { data: { name: '' }, expectedUpdatedAt: saved.body.updatedAt });
    assert.deepEqual(blank.body.fieldErrors, { name: ['Required'] });

    // A save that lands between the check and the write still loses.
    runtime.collectionHooks.parts = {
      beforeChange: [() => {
        sqlite.prepare(`UPDATE test_parts SET name = 'Concurrent', updated_at = updated_at + 1 WHERE id = 'frame'`).run();
      }],
    };
    const raced = await call('PUT', '/collections/parts/entries/frame', { data: { name: 'Mine' }, expectedUpdatedAt: saved.body.updatedAt });
    delete runtime.collectionHooks.parts;
    assert.equal(raced.status, 409);
    assert.equal(stored().name, 'Concurrent');

    // Clients that do not send expectedUpdatedAt keep the previous behaviour.
    assert.equal((await call('PUT', '/collections/parts/entries/frame', { data: { name: 'Anyway' } })).status, 200);
    assert.equal(stored().name, 'Anyway');
  } finally {
    sqlite.close();
  }
});

test('empty rich text is recognised, and generated native fields with a database default are optional', { skip }, () => {
  const { isEmptyRichText, generateFieldsFromDrizzle } = types;
  assert.equal(isEmptyRichText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '  ' }] }, { type: 'hardBreak' }] }), true);
  assert.equal(isEmptyRichText('<p>&nbsp;</p>'), true);
  assert.equal(isEmptyRichText(doc('Text')), false);
  assert.equal(isEmptyRichText({ type: 'doc', content: [{ type: 'image', attrs: { src: '/a.png' } }] }), false);
  // Other JSON (a native column shown as rich text) is never treated as an empty document.
  assert.equal(isEmptyRichText([]), false);

  const table = sqliteTable('generated', {
    id: text('id').primaryKey(),
    items: text('items', { mode: 'json' }).notNull().default([]),
    note: text('note').notNull(),
    memo: text('memo'),
  });
  assert.deepEqual(Object.fromEntries(generateFieldsFromDrizzle(table).map((field) => [field.name, field.required])),
    { id: true, items: false, note: true, memo: false });
});

test('native writes only reach configured fields, while hooks can still set other columns', { skip }, async () => {
  const sqlite = database();
  try {
    const note = (id) => sqlite.prepare('SELECT internal_note FROM test_parts WHERE id = ?').get(id).internal_note;
    const name = (id) => sqlite.prepare('SELECT name FROM test_parts WHERE id = ?').get(id).name;
    const partCount = () => sqlite.prepare('SELECT COUNT(*) AS total FROM test_parts').get().total;

    // A value for a column outside the fields is refused rather than dropped, so it is not lost silently.
    const refused = await as(editor, () => call('POST', '/collections/parts/entries', {
      data: { id: 'lens', name: 'Lens', quantity: 2, internalNote: 'from client' },
    }));
    assert.equal(refused.status, 400);
    assert.deepEqual(Object.keys(refused.body.fieldErrors), ['internalNote']);
    assert.equal(partCount(), 0);

    // Keys that name no table property (here the SQL column name) never reach the table.
    const created = await as(editor, () => call('POST', '/collections/parts/entries', {
      data: { id: 'lens', name: 'Lens', quantity: 2, internalNote: null, internal_note: 'raw column' },
    }));
    assert.equal(created.status, 201);
    assert.equal(note('lens'), null);

    const changed = await as(editor, () => call('PUT', '/collections/parts/entries/lens', { data: { name: 'Lens 2', internalNote: 'changed' } }));
    assert.equal(changed.status, 400);
    assert.deepEqual(Object.keys(changed.body.fieldErrors), ['internalNote']);
    assert.equal(note('lens'), null);
    assert.equal(name('lens'), 'Lens');

    // Server-side hooks are trusted to set columns outside the fields (plugin-stripe stores its IDs this way).
    runtime.collectionHooks.parts = { beforeChange: [() => ({ internalNote: 'set by hook' })] };
    try {
      assert.equal((await call('PUT', '/collections/parts/entries/lens', { data: { name: 'Lens 3' } })).status, 200);
    } finally {
      delete runtime.collectionHooks.parts;
    }
    assert.equal(note('lens'), 'set by hook');

    // The admin editor sends back every column it loaded, timestamps as JSON; unchanged ones are fine.
    const loaded = await as(editor, () => call('GET', '/collections/parts/entries/lens'));
    assert.equal(loaded.body.data.internalNote, 'set by hook');
    const resaved = await as(editor, () => call('PUT', '/collections/parts/entries/lens', {
      data: { ...loaded.body.data, name: 'Lens 4' }, expectedUpdatedAt: loaded.body.data.updatedAt,
    }));
    assert.equal(resaved.status, 200);
    assert.equal(name('lens'), 'Lens 4');
    assert.equal(note('lens'), 'set by hook');

    const profiles = sqliteTable('profiles', { id: text('id'), displayName: text('display_name'), role: text('role') });
    assert.deepEqual(
      types.pickConfiguredNativeFields([{ name: 'id' }, { name: 'display_name' }], profiles,
        { id: 'p1', displayName: 'By property', display_name: 'By column', role: 'admin', extra: true }),
      { id: 'p1', displayName: 'By property', display_name: 'By column' });
  } finally {
    sqlite.close();
  }
});

test('a variant group saves the SKU, price override and stock the product editor sends', { skip }, async () => {
  const sqlite = database();
  // The columns of plugin-ecommerce's _ecommerce_product_variants table.
  sqlite.exec(`CREATE TABLE test_variant_groups (id text PRIMARY KEY NOT NULL, product_id text NOT NULL, variant_id text,
    name text NOT NULL, sku text, price_override integer, inventory_quantity integer DEFAULT 0 NOT NULL,
    created_at integer NOT NULL, updated_at integer NOT NULL)`);
  runtime.nativeSchemas['variant-groups'] = sqliteTable('test_variant_groups', {
    id: text('id').primaryKey(),
    productId: text('product_id').notNull(),
    variantId: text('variant_id'),
    name: text('name').notNull(),
    sku: text('sku'),
    priceOverride: integer('price_override'),
    inventoryQuantity: integer('inventory_quantity').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  });
  const collection = {
    name: 'Product Variant Groups',
    slug: 'variant-groups',
    fields: [
      { name: 'id', label: 'ID', type: 'text', required: true },
      { name: 'productId', label: 'Product', type: 'relation', relationTo: 'products', required: true },
      { name: 'variantId', label: 'Variant Definition', type: 'relation', relationTo: 'variants' },
      { name: 'name', label: 'Display Name', type: 'text', required: true },
    ],
    nativeSchemaMapping: { schemaPath: 'test', exportName: 'variantGroups', idColumn: 'id' },
  };
  runtime.collections.push(collection);
  try {
    const row = () => ({ ...sqlite.prepare(`SELECT name, sku, price_override, inventory_quantity FROM test_variant_groups`).get() });
    // What ProductVariantConfigurator sends for a new group.
    const group = { productId: 'frame', name: 'Lens', sku: 'SKU-2', priceOverride: 999, inventoryQuantity: 3 };

    // Without those fields configured the save is refused, instead of answering 200 and dropping them.
    const refused = await call('POST', '/collections/variant-groups/entries', { data: group });
    assert.equal(refused.status, 400);
    assert.deepEqual(Object.keys(refused.body.fieldErrors), ['sku', 'priceOverride', 'inventoryQuantity']);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM test_variant_groups').get().total, 0);

    collection.fields.push(
      { name: 'sku', label: 'SKU', type: 'text' },
      { name: 'priceOverride', label: 'Price Override (Cents)', type: 'number' },
      { name: 'inventoryQuantity', label: 'Inventory Quantity', type: 'number', defaultValue: 0 },
    );
    const created = await call('POST', '/collections/variant-groups/entries', { data: { id: 'lens', ...group } });
    assert.equal(created.status, 201);
    assert.deepEqual(row(), { name: 'Lens', sku: 'SKU-2', price_override: 999, inventory_quantity: 3 });

    const saved = await call('PUT', '/collections/variant-groups/entries/lens', {
      data: { ...group, sku: 'SKU-3', priceOverride: 1200, inventoryQuantity: 5 },
      expectedUpdatedAt: created.body.updatedAt,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(row(), { name: 'Lens', sku: 'SKU-3', price_override: 1200, inventory_quantity: 5 });
  } finally {
    runtime.collections.splice(runtime.collections.indexOf(collection), 1);
    delete runtime.nativeSchemas['variant-groups'];
    sqlite.close();
  }
});

test('a draft slug change keeps the live URL until the entry is published', { skip }, async () => {
  const sqlite = database();
  try {
    const client = getClient(runtime.env);
    const created = await call('POST', '/collections/posts/entries', { slug: 'about', data: { title: 'About', body: doc('Hi') } });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const latest = async () => (await call('GET', `/collections/posts/entries/${id}`)).body;
    assert.equal((await call('POST', `/collections/posts/entries/${id}/publish`, { expectedRevisionId: (await latest()).latestRevisionId })).status, 200);

    // An editor renames the page in a draft: the admin shows the new slug, the site keeps the old URL.
    const saved = await as(editor, async () => call('PUT', `/collections/posts/entries/${id}`, {
      slug: 'about-us', data: { title: 'About us', body: doc('Hi') }, expectedRevisionId: (await latest()).latestRevisionId,
    }));
    assert.equal(saved.status, 200);
    assert.equal(saved.body.slug, 'about-us');
    assert.equal(saved.body.publishedSlug, 'about');
    assert.deepEqual({ ...liveSlug(sqlite, id) }, { slug: 'about', draft_slug: 'about-us' });
    assert.equal((await latest()).slug, 'about-us');

    const live = await client.entries.findBySlug('posts', 'about', { depth: 0 });
    assert.equal(live.slug, 'about');
    assert.equal(live.data.title, 'About');
    assert.equal('draftSlug' in live, false);
    assert.equal(await client.entries.findBySlug('posts', 'about-us', { depth: 0 }), null);
    assert.deepEqual((await client.entries.findMany('posts', { depth: 0 })).map((entry) => entry.slug), ['about']);
    assert.equal((await client.entries.findBySlug('posts', 'about-us', { depth: 0, version: 'draft' })).data.title, 'About us');

    // Editors cannot publish; an administrator's publish takes the new slug live.
    const renamed = await latest();
    assert.equal((await as(editor, () => call('POST', `/collections/posts/entries/${id}/publish`, { expectedRevisionId: renamed.latestRevisionId }))).status, 403);
    const published = await call('POST', `/collections/posts/entries/${id}/publish`, { expectedRevisionId: renamed.latestRevisionId });
    assert.equal(published.status, 200);
    assert.equal(published.body.publishedSlug, 'about-us');
    assert.deepEqual({ ...liveSlug(sqlite, id) }, { slug: 'about-us', draft_slug: null });
    assert.equal(await client.entries.findBySlug('posts', 'about', { depth: 0 }), null);
    assert.equal((await client.entries.findBySlug('posts', 'about-us', { depth: 0 })).data.title, 'About us');

    // A blank slug keeps the current one instead of taking the page offline.
    const blank = await call('PUT', `/collections/posts/entries/${id}`, { slug: '', expectedRevisionId: (await latest()).latestRevisionId });
    assert.equal(blank.status, 200);
    assert.equal(blank.body.slug, 'about-us');
  } finally {
    sqlite.close();
  }
});

test('entry ids and slugs are checked for format, and a slug names one entry per collection', { skip }, async () => {
  const sqlite = database();
  try {
    const post = (body) => call('POST', '/collections/posts/entries', { data: { title: 'T', body: doc('B') }, ...body });
    for (const id of ['bad id', 'new', 'all', '-dash', 'x'.repeat(129), { id: 1 }]) {
      const res = await post({ id });
      assert.equal(res.status, 400, JSON.stringify(id));
      assert.match(res.body.error, /Entry id/);
    }
    for (const slug of ['../etc', 'a//b', '/lead', 'trail/', 'with space', 'q?x', 'x'.repeat(201), 42]) {
      const res = await post({ slug });
      assert.equal(res.status, 400, JSON.stringify(slug));
      assert.match(res.body.error, /Slug/);
    }
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM galaxy_entries').get().total, 0);

    const nested = await post({ id: 'talisman-frame:mycelium', slug: 'guides/getting-started' });
    assert.equal(nested.status, 201);
    assert.equal(nested.body.slug, 'guides/getting-started');
    assert.equal((await post({ slug: 'über-uns' })).status, 201);
    assert.equal((await call('GET', '/collections/posts/entries/talisman-frame%3Amycelium')).body.id, 'talisman-frame:mycelium');

    const duplicate = await post({ slug: 'guides/getting-started' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, 'Another entry in this collection already uses this slug.');
    const sameId = await post({ id: 'talisman-frame:mycelium', slug: 'other' });
    assert.equal(sameId.status, 409);
    assert.equal(sameId.body.error, 'Another record already uses this id.');

    // Rows written straight to D1 can share a slug; the second one cannot go live over the first.
    const { id: collectionId } = sqlite.prepare(`SELECT id FROM galaxy_collections WHERE slug = 'posts'`).get();
    const insert = sqlite.prepare(`INSERT INTO galaxy_entries (id, collection_id, slug, status, data, created_at, updated_at)
      VALUES (?, ?, 'contact', ?, ?, ?, ?)`);
    insert.run('contact-live', collectionId, 'published', JSON.stringify({ title: 'Live', body: doc('A') }), hourAgo, hourAgo);
    insert.run('contact-copy', collectionId, 'draft', JSON.stringify({ title: 'Copy', body: doc('B') }), hourAgo + 1, hourAgo + 1);
    const blocked = await call('POST', '/collections/posts/entries/contact-copy/publish', { expectedRevisionId: null });
    assert.equal(blocked.status, 409);
    assert.equal(sqlite.prepare(`SELECT status FROM galaxy_entries WHERE id = 'contact-copy'`).get().status, 'draft');
    assert.equal(revisionCount(sqlite, 'contact-copy'), 0);

    // A live page whose slug predates these rules still saves: the editor sends the slug back
    // unchanged, and only a new slug is checked.
    const page = JSON.stringify({ title: 'Mine', body: doc('A') });
    sqlite.prepare(`INSERT INTO galaxy_entries (id, collection_id, slug, status, data, published_data, created_at, updated_at)
      VALUES ('legacy', ?, 'My Page', 'published', ?, ?, ?, ?)`).run(collectionId, page, page, hourAgo, hourAgo);
    const kept = await as(editor, () => call('PUT', '/collections/posts/entries/legacy', {
      slug: 'My Page', data: { title: 'Edited', body: doc('A') }, expectedRevisionId: null,
    }));
    assert.equal(kept.status, 200);
    assert.deepEqual({ ...liveSlug(sqlite, 'legacy') }, { slug: 'My Page', draft_slug: null });
    const latestLegacy = (await call('GET', '/collections/posts/entries/legacy')).body.latestRevisionId;
    const renamed = await as(editor, () => call('PUT', '/collections/posts/entries/legacy', {
      slug: 'My New Page', data: { title: 'Edited', body: doc('A') }, expectedRevisionId: latestLegacy,
    }));
    assert.equal(renamed.status, 400);
    assert.match(renamed.body.error, /Slug/);
    assert.equal((await as(editor, () => call('PUT', '/collections/posts/entries/legacy', {
      slug: 'my-page', data: { title: 'Edited', body: doc('A') }, expectedRevisionId: latestLegacy,
    }))).status, 200);
    assert.deepEqual({ ...liveSlug(sqlite, 'legacy') }, { slug: 'My Page', draft_slug: 'my-page' });
  } finally {
    sqlite.close();
  }
});

test('editors update existing globals but only administrators create new ones', { skip }, async () => {
  const sqlite = database();
  try {
    const stored = (slug) => sqlite.prepare('SELECT COUNT(*) AS total FROM galaxy_globals WHERE slug = ?').get(slug).total;
    const created = await as(editor, () => call('POST', '/globals/brand-new', { anything: true }));
    assert.equal(created.status, 403);
    assert.equal(stored('brand-new'), 0);

    assert.equal((await as(editor, () => call('POST', '/globals/site', { siteName: 'Edited' }))).status, 200);
    assert.equal((await call('POST', '/globals/footer', { note: 'By an admin' })).status, 200);
    const updated = await as(editor, () => call('POST', '/globals/footer', { note: 'By an editor' }));
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.data, { note: 'By an editor' });
  } finally {
    sqlite.close();
  }
});

test('media records come from uploads, and their url and type cannot be changed', { skip }, async () => {
  const sqlite = database();
  try {
    const record = { id: 'pixel', filename: 'p.png', url: 'https://tracker.example/p.png', mimeType: 'image/png' };
    for (const user of [editor, admin]) {
      assert.equal((await as(user, () => call('POST', '/collections/media/entries', { data: record }))).status, 403);
    }

    sqlite.prepare(`INSERT INTO galaxy_media (id, filename, mime_type, size_bytes, url, created_at, updated_at)
      VALUES ('m1', 'a.png', 'image/png', 10, '/api/media/m1', ?, ?)`).run(hourAgo, hourAgo);
    const stored = () => ({ ...sqlite.prepare(`SELECT url, mime_type, alt_text FROM galaxy_media WHERE id = 'm1'`).get() });
    const repointed = await as(editor, () => call('PUT', '/collections/media/entries/m1', { data: { url: 'https://tracker.example/p.png', altText: 'Alt' } }));
    assert.equal(repointed.status, 400);
    assert.deepEqual(Object.keys(repointed.body.fieldErrors), ['url']);
    const retyped = await as(editor, () => call('PUT', '/collections/media/entries/m1', { data: { mimeType: 'text/html' } }));
    assert.deepEqual(Object.keys(retyped.body.fieldErrors), ['mimeType']);
    assert.deepEqual(stored(), { url: '/api/media/m1', mime_type: 'image/png', alt_text: null });

    // The editor form sends the record back whole; unchanged upload values are fine.
    const saved = await as(editor, () => call('PUT', '/collections/media/entries/m1', {
      data: { id: 'm1', filename: 'a.png', url: '/api/media/m1', mimeType: 'image/png', altText: 'Alt' },
    }));
    assert.equal(saved.status, 200);
    assert.deepEqual(stored(), { url: '/api/media/m1', mime_type: 'image/png', alt_text: 'Alt' });
  } finally {
    sqlite.close();
  }
});

test('the collections list takes a few statements and does not rewrite collection rows', { skip }, async () => {
  const sqlite = database();
  try {
    const { statements } = runtime.env.DB;
    assert.equal((await call('GET', '/collections')).status, 200);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM galaxy_collections').get().total, runtime.collections.length);
    await call('POST', '/collections/parts/entries', { data: { id: 'p1', name: 'P', quantity: 1 } });
    await call('POST', '/collections/posts/entries', { data: { title: 'T', body: doc('B') } });

    statements.length = 0;
    const listed = await call('GET', '/collections');
    assert.equal(listed.status, 200);
    assert.ok(statements.length <= 3, statements.join('\n'));
    assert.equal(statements.some((sql) => /^\s*(insert|update|delete)/i.test(sql)), false);
    const bySlug = Object.fromEntries(listed.body.map((collection) => [collection.slug, collection]));
    assert.equal(bySlug.parts.itemCount, 1);
    assert.equal(bySlug.media.itemCount, 0);
    assert.equal(bySlug.posts.itemCount, 1);
    assert.ok(bySlug.posts.id);
  } finally {
    sqlite.close();
  }
});

test('entry lists page with limit and cursor, and still return an array without them', { skip }, async () => {
  const sqlite = database();
  try {
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await call('POST', '/collections/posts/entries', { id: `post-${index}`, data: { title: `Post ${index}`, body: doc('B') } })).status, 201);
      assert.equal((await call('POST', '/collections/parts/entries', { data: { id: `part-${index}`, name: `Part ${index}`, quantity: index } })).status, 201);
    }
    // Known creation times, with a tie between post-3 and post-4.
    for (let index = 0; index < 5; index += 1) {
      sqlite.prepare('UPDATE galaxy_entries SET created_at = ? WHERE id = ?').run(hourAgo + Math.min(index, 3), `post-${index}`);
    }

    const walk = async (slug) => {
      const ids = [];
      let cursor = null;
      do {
        const res = await call('GET', `/collections/${slug}/entries?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        assert.equal(res.status, 200);
        assert.ok(res.body.docs.length <= 2);
        ids.push(...res.body.docs.map((entry) => entry.id));
        cursor = res.body.nextCursor;
      } while (cursor);
      return ids;
    };
    assert.deepEqual(await walk('posts'), ['post-4', 'post-3', 'post-2', 'post-1', 'post-0']);
    assert.deepEqual(await walk('parts'), ['part-4', 'part-3', 'part-2', 'part-1', 'part-0']);

    const whole = await call('GET', '/collections/posts/entries');
    assert.ok(Array.isArray(whole.body));
    assert.equal(whole.body.length, 5);

    for (const query of ['limit=0', 'limit=201', 'limit=abc', 'limit=2&cursor=not-a-cursor', 'limit=2&cursor=bm9wZQ', 'cursor=abc']) {
      assert.equal((await call('GET', `/collections/posts/entries?${query}`)).status, 400, query);
    }
    assert.equal((await call('GET', '/collections/parts/entries?limit=2&cursor=WyJ4Il0')).status, 400);
  } finally {
    sqlite.close();
  }
});

test('revision history lists metadata and loads one revision on request', { skip }, async () => {
  const sqlite = database();
  try {
    await call('POST', '/collections/posts/entries', { id: 'history', data: { title: 'One', body: doc('B') } });
    const first = (await call('GET', '/collections/posts/entries/history')).body.latestRevisionId;
    await call('PUT', '/collections/posts/entries/history', { data: { title: 'Two', body: doc('B') }, expectedRevisionId: first });

    const list = await call('GET', '/collections/posts/entries/history/revisions');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((revision) => revision.revisionNumber), [2, 1]);
    assert.equal(list.body.some((revision) => 'data' in revision), false);
    assert.equal((await call('GET', '/collections/posts/entries/history/revisions?includeData=true')).body[0].data.title, 'Two');
    assert.equal((await call('GET', '/collections/posts/entries/history/revisions?limit=1')).body.length, 1);

    const one = await call('GET', `/collections/posts/entries/history/revisions/${first}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.data.title, 'One');
    assert.equal((await call('GET', '/collections/posts/entries/history/revisions/missing')).status, 404);
  } finally {
    sqlite.close();
  }
});

test('client mistakes get 4xx answers, and database errors stay out of responses', { skip }, async (t) => {
  t.mock.method(console, 'error', () => {});
  const sqlite = database();
  try {
    assert.equal((await call('POST', '/collections/posts/entries', '{"data":')).status, 400);
    assert.equal((await call('POST', '/collections/posts/entries', '[1, 2]')).status, 400);
    assert.equal((await call('POST', '/collections/posts/entries', { data: 'not json' })).status, 400);
    assert.equal((await call('POST', '/globals', '{oops')).status, 400);
    const unknown = await call('GET', '/collections/unknown/entries');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, 'Collection unknown not found');
    assert.equal((await call('GET', '/collections/posts/entries/%E0%A4%A')).status, 400);

    // A hook's refusal reaches the editor; an error from D1 does not.
    await call('POST', '/collections/parts/entries', { data: { id: 'part', name: 'A', quantity: 1 } });
    runtime.collectionHooks.parts = { beforeChange: [() => { throw new Error('Quantity is locked while an order ships'); }] };
    const refused = await call('PUT', '/collections/parts/entries/part', { data: { quantity: 5 } });
    assert.equal(refused.status, 500);
    assert.equal(refused.body.error, 'Quantity is locked while an order ships');
    runtime.collectionHooks.parts = { beforeChange: [() => { throw new Error('D1_ERROR: no such table: secrets: SQLITE_ERROR'); }] };
    const failedHook = await call('PUT', '/collections/parts/entries/part', { data: { quantity: 5 } });
    assert.equal(failedHook.status, 500);
    assert.doesNotMatch(JSON.stringify(failedHook.body), /secrets|D1_ERROR/);
    delete runtime.collectionHooks.parts;

    sqlite.exec('DROP TABLE test_parts');
    const failed = await call('POST', '/collections/parts/entries', { data: { id: 'secret-id', name: 'Secret name', quantity: 1 } });
    assert.equal(failed.status, 500);
    assert.doesNotMatch(JSON.stringify(failed.body), /insert|params|Secret name|test_parts/i);

    runtime.env = { DB: { prepare() { throw new Error('D1_ERROR: binding talisman-db is not available'); } } };
    const health = await call('GET', '/health');
    assert.equal(health.status, 500);
    assert.deepEqual(health.body, { status: 'error' });
  } finally {
    sqlite.close();
  }
});

test('relations resolve in chunks, within the target collection, and skip collections only admins may read', { skip }, async () => {
  const sqlite = database();
  try {
    await call('GET', '/collections');
    const collectionId = (slug) => sqlite.prepare('SELECT id FROM galaxy_collections WHERE slug = ?').get(slug).id;
    const insert = sqlite.prepare(`INSERT INTO galaxy_entries (id, collection_id, slug, status, data, published_data, created_at, updated_at)
      VALUES (?, ?, ?, 'published', ?, ?, ?, ?)`);
    const add = (id, slug, data) => insert.run(id, collectionId(slug), id, JSON.stringify(data), JSON.stringify(data), hourAgo, hourAgo);

    // More ids than D1 binds in one statement.
    const tagIds = Array.from({ length: 150 }, (_, index) => `tag-${index}`);
    tagIds.forEach((id, index) => add(id, 'tags', { label: `Tag ${index}` }));
    add('note-1', 'notes', { text: 'Admins only' });
    add('tagged', 'posts', { title: 'Tagged', body: doc('B'), tags: [...tagIds, 'note-1'], note: 'note-1' });

    const post = await getClient(runtime.env).entries.find('posts', 'tagged');
    assert.equal(post.data.tags.length, 151);
    assert.deepEqual(post.data.tags.slice(0, 2).map((tag) => tag.data.label), ['Tag 0', 'Tag 1']);
    assert.equal(post.data.tags[149].data.label, 'Tag 149');
    // An entry of another collection is not resolved as a tag, and admin-only notes stay ids.
    assert.equal(post.data.tags[150], 'note-1');
    assert.equal(post.data.note, 'note-1');
  } finally {
    sqlite.close();
  }
});

function kvStub() {
  const deleted = [];
  return { deleted, async get() { return null; }, async put() {}, async delete(key) { deleted.push(key); } };
}

test('a blank optional field is stored as no value on native and entry writes', { skip }, async () => {
  const sqlite = database();
  sqlite.exec(`CREATE TABLE test_lenses (id text PRIMARY KEY NOT NULL, name text NOT NULL, sku text UNIQUE,
    price_override integer, part_id text REFERENCES test_parts(id), stock integer DEFAULT 0 NOT NULL,
    finish text DEFAULT 'matte' NOT NULL, note text DEFAULT 'none' NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)`);
  runtime.nativeSchemas.lenses = sqliteTable('test_lenses', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    sku: text('sku').unique(),
    priceOverride: integer('price_override'),
    partId: text('part_id'),
    stock: integer('stock').notNull().default(0),
    finish: text('finish').notNull().default('matte'),
    note: text('note').notNull().default('none'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  });
  const lenses = {
    name: 'Lenses',
    slug: 'lenses',
    fields: [
      { name: 'id', label: 'ID', type: 'text', required: true },
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'sku', label: 'SKU', type: 'text' },
      { name: 'priceOverride', label: 'Price override', type: 'number' },
      { name: 'partId', label: 'Part', type: 'relation', relationTo: 'parts' },
      { name: 'stock', label: 'Stock', type: 'number' },
      { name: 'finish', label: 'Finish', type: 'select', options: ['matte', 'gloss'] },
      { name: 'note', label: 'Note', type: 'text' },
    ],
    nativeSchemaMapping: { schemaPath: 'test', exportName: 'lenses', idColumn: 'id' },
  };
  const events = {
    name: 'Events',
    slug: 'events',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'seats', label: 'Seats', type: 'number' },
      { name: 'capacity', label: 'Capacity', type: 'number', required: true },
      { name: 'kind', label: 'Kind', type: 'select', options: ['talk', 'workshop'] },
      { name: 'summary', label: 'Summary', type: 'text' },
    ],
  };
  runtime.collections.push(lenses, events);
  try {
    const row = (id) => ({ ...sqlite.prepare(`SELECT sku, price_override, part_id, stock, finish, note FROM test_lenses WHERE id = ?`).get(id) });
    // What the admin's new-record form sends for fields left blank.
    const blank = { sku: '', priceOverride: '', partId: '', stock: '', finish: '', note: '' };
    const first = await call('POST', '/collections/lenses/entries', { data: { id: 'a', name: 'A', ...blank } });
    assert.equal(first.status, 201);
    // NULL for nullable columns, the default for NOT NULL ones, and '' kept for NOT NULL free text.
    assert.deepEqual(row('a'), { sku: null, price_override: null, part_id: null, stock: 0, finish: 'matte', note: '' });
    // A second blank SKU does not collide with the first in the UNIQUE column.
    assert.equal((await call('POST', '/collections/lenses/entries', { data: { id: 'b', name: 'B', ...blank } })).status, 201);

    await call('POST', '/collections/parts/entries', { data: { id: 'frame', name: 'Frame', quantity: 1 } });
    assert.equal((await call('PUT', '/collections/lenses/entries/a', {
      data: { sku: 'SKU-A', priceOverride: 900, partId: 'frame', stock: 4, finish: 'gloss' },
    })).status, 200);
    // Clearing a field removes the value; a NOT NULL number keeps the stored one.
    const cleared = await call('PUT', '/collections/lenses/entries/a', { data: { sku: '', priceOverride: '', partId: '', stock: '', finish: '' } });
    assert.equal(cleared.status, 200);
    assert.deepEqual(row('a'), { sku: null, price_override: null, part_id: null, stock: 4, finish: 'gloss', note: '' });

    // Required fields still need a value.
    const required = await call('PUT', '/collections/lenses/entries/a', { data: { name: '' } });
    assert.deepEqual(required.body.fieldErrors, { name: ['Required'] });

    // Entries store an optional blank number or select as null; a required number reports Required.
    const event = await call('POST', '/collections/events/entries', { data: { title: 'Launch', seats: '', capacity: 20, kind: '', summary: '' } });
    assert.equal(event.status, 201);
    assert.deepEqual(event.body.data, { title: 'Launch', seats: null, capacity: 20, kind: null, summary: '' });
    const missing = await call('POST', '/collections/events/entries', { data: { title: 'Launch', capacity: '' } });
    assert.deepEqual(missing.body.fieldErrors, { capacity: ['Required'] });
    assert.deepEqual((await call('POST', '/collections/events/entries', { data: { title: 'T', capacity: 1, kind: 'panel' } })).body.fieldErrors.kind.length, 1);
  } finally {
    runtime.collections.splice(runtime.collections.indexOf(lenses), 1);
    runtime.collections.splice(runtime.collections.indexOf(events), 1);
    delete runtime.nativeSchemas.lenses;
    sqlite.close();
  }
});

test('deleting a media record deletes its file and evicts its cached copies', { skip }, async (t) => {
  t.mock.method(console, 'error', () => {});
  const sqlite = database();
  const removed = [];
  const evicted = [];
  runtime.env.STORAGE = { async delete(key) { removed.push(key); } };
  globalThis.caches = { default: { async delete(key) { evicted.push(key); return true; } } };
  try {
    const insert = sqlite.prepare(`INSERT INTO galaxy_media (id, filename, mime_type, size_bytes, url, created_at, updated_at)
      VALUES (?, 'a.png', 'image/png', 10, ?, ?, ?)`);
    insert.run('media_abc', '/api/media/media_abc', hourAgo, hourAgo);
    const stored = (id) => sqlite.prepare('SELECT COUNT(*) AS total FROM galaxy_media WHERE id = ?').get(id).total;

    assert.equal((await as(editor, () => call('DELETE', '/collections/media/entries/media_abc'))).status, 403);
    assert.deepEqual(removed, []);

    const deleted = await call('DELETE', '/collections/media/entries/media_abc');
    assert.equal(deleted.status, 200);
    assert.equal(stored('media_abc'), 0);
    assert.deepEqual(removed, ['media_abc']);
    assert.deepEqual(evicted, [
      'https://cms.test/api/media/media_abc?v=2',
      ...[320, 640, 960, 1280, 1920].map((width) => `https://cms.test/api/media/media_abc?v=2&w=${width}`),
    ]);

    // When the file cannot be deleted the record stays, so the delete can be repeated.
    insert.run('media_def', '/api/media/media_def', hourAgo, hourAgo);
    runtime.env.STORAGE = { async delete() { throw new Error('R2 unavailable'); } };
    assert.equal((await call('DELETE', '/collections/media/entries/media_def')).status, 500);
    assert.equal(stored('media_def'), 1);

    // getClient deletes the file too.
    removed.length = 0;
    runtime.env.STORAGE = { async delete(key) { removed.push(key); } };
    await getClient(runtime.env).entries.delete('media', 'media_def');
    assert.deepEqual(removed, ['media_def']);
    assert.equal(stored('media_def'), 0);
  } finally {
    delete globalThis.caches;
    sqlite.close();
  }
});

test('publishing through a Workflow answers 202 while it runs, maps its failures, and checks the slug first', { skip }, async (t) => {
  const sqlite = database();
  const kv = kvStub();
  runtime.env.KV = kv;
  const running = (instances) => ({
    async create({ id, params }) { instances.push(params); return { id, async status() { return { status: 'running' }; } }; },
  });
  // Each Date.now call moves the clock 3 seconds, so the wait for a Workflow ends after a few polls.
  const fastClock = () => {
    let clock = Date.now();
    return t.mock.method(Date, 'now', () => (clock += 3000));
  };
  try {
    await call('POST', '/collections/posts/entries', { id: 'wf', slug: 'workflow', data: { title: 'W', body: doc('B') } });
    const latest = async (id) => (await call('GET', `/collections/posts/entries/${id}`)).body.latestRevisionId;

    const instances = [];
    runtime.env.SITE_PUBLISH_WORKFLOW = running(instances);
    const expected = await latest('wf');
    const clock = fastClock();
    const pending = await call('POST', '/collections/posts/entries/wf/publish', { expectedRevisionId: expected });
    clock.mock.restore();
    assert.equal(pending.status, 202);
    assert.equal(pending.body.status, 'draft');
    assert.equal(pending.body.workflow.status, 'pending');
    assert.match(pending.body.workflow.instanceId, /^talisman-publish-posts-wf-\d+$/);
    assert.match(pending.body.message, /still running/);
    assert.deepEqual(instances.map((params) => params.entryId), ['wf']);
    assert.ok(kv.deleted.includes('talisman:entries:posts:wf:published'));

    // A failure the instance reports keeps its status code.
    runtime.env.SITE_PUBLISH_WORKFLOW = { async create({ id }) {
      return { id, async status() {
        return { status: 'errored', error: { name: 'RevisionConflictError', message: 'This entry changed since it was opened. Reload it before saving.' } };
      } };
    } };
    const stale = await call('POST', '/collections/posts/entries/wf/publish', { expectedRevisionId: await latest('wf') });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'This entry changed since it was opened. Reload it before saving.');
    // TalismanPublishWorkflow itself completes with the error as its output.
    runtime.env.SITE_PUBLISH_WORKFLOW = { async create({ id, params }) {
      const failed = { status: 'complete', output: { ok: false, error: { name: 'RevisionConflictError', message: stale.body.error } } };
      return { id, async status() { return failed; } };
    } };
    assert.equal((await call('POST', '/collections/posts/entries/wf/publish', { expectedRevisionId: 'rev-old' })).status, 409);

    // A finished instance returns the published entry.
    runtime.env.SITE_PUBLISH_WORKFLOW = { async create({ id, params }) {
      await versioning.runPublishingTransition(runtime.env, params);
      return { id, async status() { return { status: 'complete' }; } };
    } };
    const done = await call('POST', '/collections/posts/entries/wf/publish', { expectedRevisionId: await latest('wf') });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'published');

    // A slug another published entry serves is refused before any instance starts, in the API and in getClient.
    const { id: collectionId } = sqlite.prepare(`SELECT id FROM galaxy_collections WHERE slug = 'posts'`).get();
    const insert = sqlite.prepare(`INSERT INTO galaxy_entries (id, collection_id, slug, status, data, created_at, updated_at)
      VALUES (?, ?, 'taken', ?, ?, ?, ?)`);
    insert.run('taken-live', collectionId, 'published', JSON.stringify({ title: 'Live', body: doc('A') }), hourAgo, hourAgo);
    insert.run('taken-copy', collectionId, 'draft', JSON.stringify({ title: 'Copy', body: doc('B') }), hourAgo, hourAgo);
    let started = 0;
    runtime.env.SITE_PUBLISH_WORKFLOW = { async create() { started += 1; throw new Error('not reached'); } };
    const blocked = await call('POST', '/collections/posts/entries/taken-copy/publish', { expectedRevisionId: null });
    assert.equal(blocked.status, 409);
    const client = getClient(runtime.env);
    await assert.rejects(client.entries.update('posts', 'taken-copy', undefined, { status: 'published' }), publicClient.SlugConflictError);
    assert.equal(started, 0);

    // getClient uses the configured binding too, and reports a publish that is still running.
    await call('POST', '/collections/posts/entries', { id: 'wf-sdk', slug: 'workflow-sdk', data: { title: 'S', body: doc('B') } });
    runtime.env.SITE_PUBLISH_WORKFLOW = running(instances);
    const sdkClock = fastClock();
    const viaClient = await client.entries.update('posts', 'wf-sdk', { title: 'S2', body: doc('B') }, { status: 'published' });
    sdkClock.mock.restore();
    assert.equal(viaClient.workflow.status, 'pending');
    assert.equal(viaClient.status, 'draft');
    assert.deepEqual(instances.map((params) => params.entryId), ['wf', 'wf-sdk']);
  } finally {
    delete runtime.env.SITE_PUBLISH_WORKFLOW;
    sqlite.close();
  }
});

test('every native save moves updatedAt forward, so a save in the same second is still detected', { skip }, async () => {
  const sqlite = database();
  try {
    // A stamp in the current second behaves like one a moment ahead: the next save must still change it.
    const ahead = Math.floor(Date.now() / 1000) + 60;
    sqlite.prepare('INSERT INTO test_parts (id, name, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('lens', 'Lens', 5, hourAgo, ahead);
    const stamp = () => sqlite.prepare(`SELECT updated_at FROM test_parts WHERE id = 'lens'`).get().updated_at;
    const put = (data, expectedUpdatedAt) => call('PUT', '/collections/parts/entries/lens', { data, expectedUpdatedAt });

    const loaded = (await call('GET', '/collections/parts/entries/lens')).body.updatedAt;
    const first = await put({ name: 'Lens 2' }, loaded);
    assert.equal(first.status, 200);
    assert.equal(stamp(), ahead + 1);

    // Two tabs hold the same stamp; the first save changes it, so the second tab is refused.
    const tabA = (await call('GET', '/collections/parts/entries/lens')).body.updatedAt;
    const tabB = tabA;
    assert.equal((await put({ name: 'Tab A' }, tabA)).status, 200);
    assert.equal(stamp(), ahead + 2);
    assert.equal((await put({ name: 'Tab B' }, tabB)).status, 409);

    // getClient stamps native rows the same way, and fills the timestamps of a new one.
    const client = getClient(runtime.env);
    await client.entries.update('parts', 'lens', { quantity: 6 });
    assert.equal(stamp(), ahead + 3);
    const created = await client.entries.create('parts', { id: 'filter', name: 'Filter', quantity: 1 });
    assert.equal(created.id, 'filter');
    assert.ok(Math.abs(sqlite.prepare(`SELECT created_at FROM test_parts WHERE id = 'filter'`).get().created_at - Math.floor(Date.now() / 1000)) <= 2);
    // Server code importing rows keeps the times it passes.
    const imported = new Date(1_600_000_000_000);
    await client.entries.create('parts', { id: 'imported', name: 'Imported', quantity: 1, createdAt: imported, updatedAt: imported });
    assert.deepEqual({ ...sqlite.prepare(`SELECT created_at, updated_at FROM test_parts WHERE id = 'imported'`).get() },
      { created_at: 1_600_000_000, updated_at: 1_600_000_000 });

    // A stamp far ahead (a seed that wrote milliseconds) is replaced with the current time.
    sqlite.prepare(`UPDATE test_parts SET updated_at = ? WHERE id = 'lens'`).run(ahead * 1000);
    assert.equal((await put({ name: 'Lens 3' })).status, 200);
    assert.ok(Math.abs(stamp() - Math.floor(Date.now() / 1000)) <= 2);

    assert.equal(types.nextNativeUpdatedAt(null, new Date(5000)).getTime(), 5000);
    assert.equal(types.nextNativeUpdatedAt(new Date(1000), new Date(5000)).getTime(), 5000);
    assert.equal(types.nextNativeUpdatedAt(new Date(5000), new Date(5400)).getTime(), 6000);
    // Bursts of plugin writes can run a stamp minutes ahead; moving it back to now could hand an
    // editor's old stamp out again, so it keeps moving forward. Only an impossible stamp is reset.
    const now = new Date(1_790_000_000_000);
    assert.equal(types.nextNativeUpdatedAt(new Date(now.getTime() + 10 * 60_000), now).getTime(), now.getTime() + 10 * 60_000 + 1000);
    assert.equal(types.nextNativeUpdatedAt(new Date(now.getTime() + 2 * 365 * 24 * 60 * 60_000), now).getTime(), now.getTime());
  } finally {
    sqlite.close();
  }
});

test('getClient writes native rows as given, so table defaults and text timestamps still apply', { skip }, async () => {
  const sqlite = database();
  sqlite.exec(`CREATE TABLE test_counters (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, label text NOT NULL,
    created_at integer NOT NULL, updated_at integer NOT NULL)`);
  sqlite.exec('CREATE TABLE test_orders (id text PRIMARY KEY NOT NULL, total integer NOT NULL)');
  sqlite.exec(`CREATE TABLE test_notes (id text PRIMARY KEY NOT NULL, body text NOT NULL,
    created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
  let orderNumber = 0;
  Object.assign(runtime.nativeSchemas, {
    counters: sqliteTable('test_counters', {
      id: integer('id').primaryKey({ autoIncrement: true }),
      label: text('label').notNull(),
      createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
      updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    }),
    orders: sqliteTable('test_orders', {
      id: text('id').primaryKey().$defaultFn(() => `ord_${++orderNumber}`),
      total: integer('total').notNull(),
    }),
    notes: sqliteTable('test_notes', {
      id: text('id').primaryKey(),
      body: text('body').notNull(),
      createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
      updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    }),
  });
  const native = (name, slug, fields) => ({
    name,
    slug,
    fields: fields.map(([field, type]) => ({ name: field, label: field, type })),
    nativeSchemaMapping: { schemaPath: 'test', exportName: slug, idColumn: 'id' },
  });
  // The counters' fields leave the id out; the orders declare it as text, as generated fields do.
  const added = [
    native('Counters', 'counters', [['label', 'text']]),
    native('Orders', 'orders', [['id', 'text'], ['total', 'number']]),
    native('Notes', 'notes', [['id', 'text'], ['body', 'text']]),
  ];
  runtime.collections.push(...added);
  try {
    const client = getClient(runtime.env);
    const counter = (id) => ({ ...sqlite.prepare('SELECT * FROM test_counters WHERE id = ?').get(id) });

    // An INTEGER AUTOINCREMENT id is left to the table, and integer timestamps without a default are filled.
    const first = await client.entries.create('counters', { label: 'First' });
    assert.equal(first.id, 1);
    assert.equal((await client.entries.create('counters', { label: 'Second' })).id, 2);
    assert.ok(Math.abs(counter(1).created_at - Math.floor(Date.now() / 1000)) <= 2);
    assert.equal(counter(1).updated_at, counter(1).created_at);

    // An update moves updatedAt forward, even within the same second, and keeps the row's id.
    const ahead = Math.floor(Date.now() / 1000) + 60;
    sqlite.prepare('UPDATE test_counters SET updated_at = ? WHERE id = 1').run(ahead);
    const renamed = await client.entries.update('counters', 1, { label: 'Renamed' });
    assert.equal(renamed.id, 1);
    assert.equal(renamed.data.label, 'Renamed');
    assert.deepEqual({ label: counter(1).label, updated_at: counter(1).updated_at }, { label: 'Renamed', updated_at: ahead + 1 });
    await client.entries.update('counters', 1, { ...first.data, id: 2, label: 'Round trip' });
    assert.equal(counter(1).label, 'Round trip');
    assert.equal(counter(2).label, 'Second');
    // An updatedAt the caller passes is stored as given.
    await client.entries.update('counters', 2, { updatedAt: new Date(1_600_000_000_000) });
    assert.equal(counter(2).updated_at, 1_600_000_000);

    // A text id with a $defaultFn comes from the table's function; an id the caller passes is kept.
    const order = await client.entries.create('orders', { total: 1200 });
    assert.equal(order.id, 'ord_1');
    assert.equal((await client.entries.create('orders', { id: 'ord_custom', total: 5 })).id, 'ord_custom');
    assert.equal((await client.entries.update('orders', 'ord_1', { total: 1500 })).data.total, 1500);
    assert.deepEqual(sqlite.prepare('SELECT id, total FROM test_orders ORDER BY id').all().map((row) => ({ ...row })),
      [{ id: 'ord_1', total: 1500 }, { id: 'ord_custom', total: 5 }]);

    // Text timestamps keep their DEFAULT CURRENT_TIMESTAMP on create and are not stamped with a Date on update.
    const sqlTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    const note = () => ({ ...sqlite.prepare(`SELECT body, created_at, updated_at FROM test_notes WHERE id = 'n1'`).get() });
    const created = await client.entries.create('notes', { id: 'n1', body: 'Hello' });
    assert.match(created.data.createdAt, sqlTimestamp);
    assert.match(note().updated_at, sqlTimestamp);
    const stored = note();
    const edited = await client.entries.update('notes', 'n1', { body: 'Edited' });
    assert.equal(edited.data.body, 'Edited');
    assert.deepEqual(note(), { ...stored, body: 'Edited' });
    await client.entries.update('notes', 'n1', { updatedAt: '2026-09-26 12:00:00' });
    assert.equal(note().updated_at, '2026-09-26 12:00:00');
  } finally {
    for (const collection of added) runtime.collections.splice(runtime.collections.indexOf(collection), 1);
    for (const slug of ['counters', 'orders', 'notes']) delete runtime.nativeSchemas[slug];
    sqlite.close();
  }
});

test('global data is a JSON object on every write path', { skip }, async () => {
  const sqlite = database();
  try {
    const listed = await call('POST', '/globals', { slug: 'menu', name: 'Menu', data: [{ label: 'Home' }] });
    assert.equal(listed.status, 400);
    assert.equal(listed.body.error, 'Global data must be a JSON object');
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS total FROM galaxy_globals WHERE slug = 'menu'`).get().total, 0);
    assert.equal((await call('POST', '/globals', { slug: 'menu', name: 'Menu' })).status, 201);

    const client = getClient(runtime.env);
    for (const value of [[{ label: 'Home' }], 'Hello', 42, null]) {
      await assert.rejects(client.globals.update('menu', value), { name: 'ValidationError', message: 'Global data must be a JSON object' });
    }
    await assert.rejects(client.globals.create({ slug: 'banner', data: 'Hello' }), publicClient.ValidationError);
    assert.deepEqual((await client.globals.update('menu', { items: [{ label: 'Home' }] })).data, { items: [{ label: 'Home' }] });
    assert.deepEqual((await client.globals.create({ slug: 'banner' })).data, {});
  } finally {
    sqlite.close();
  }
});

test('getClient exports the errors its entry writes throw', { skip }, () => {
  assert.equal(publicClient.SlugConflictError, versioning.SlugConflictError);
  assert.equal(publicClient.RevisionConflictError, versioning.RevisionConflictError);
  assert.equal(publicClient.EntryNotFoundError, versioning.EntryNotFoundError);
  assert.equal(new publicClient.SlugConflictError().name, 'SlugConflictError');
});
