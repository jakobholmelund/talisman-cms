import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../dist/db/schema.js';
import { createDraftEntry, saveDraftEntry, publishEntry, archiveEntry, restoreEntryRevision, getLatestRevision, listEntryRevisions, RevisionConflictError, triggerPublishingWorkflow } from '../dist/versioning.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of ['0000_skinny_odin', '0001_abandoned_shotgun', '0002_flowery_midnight',
    '0003_content_versioning', '0018_entry_revision_integrity']) {
    const sql = readFileSync(new URL(`../drizzle/${migration}.sql`, import.meta.url), 'utf8');
    sqlite.exec(sql.replaceAll('--> statement-breakpoint', ''));
  }
  sqlite.prepare('INSERT INTO galaxy_collections (id, name, slug, fields, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('posts-id', 'Posts', 'posts', '[]', Math.floor(Date.now() / 1000));
  let failBatchAt = 0;
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async all() { return { results: statement.all(...values) }; },
        async raw() {
          const raw = sqlite.prepare(sql);
          raw.setReturnArrays(true);
          return raw.all(...values);
        },
        async run() { return { meta: statement.run(...values) }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const [index, statement] of statements.entries()) {
          if (failBatchAt === index + 1) throw new Error('simulated batch failure');
          results.push(await statement.all());
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      } finally {
        failBatchAt = 0;
      }
    },
  };
  return { sqlite, DB, db: drizzle(DB, { schema }), failNextBatchAt: (index) => { failBatchAt = index; } };
}

test('draft, revision, and publish writes are atomic', async () => {
  const { sqlite, db, failNextBatchAt } = database();
  try {
    const collection = await db.query.collections.findFirst({ where: (table, { eq }) => eq(table.id, 'posts-id') });
    const created = await createDraftEntry(db, collection, { title: 'First' }, { id: 'post-1', slug: 'first' });
    assert.equal(created.status, 'draft');
    assert.equal((await listEntryRevisions(db, collection.id, created.id)).length, 1);

    failNextBatchAt(2);
    await assert.rejects(saveDraftEntry(db, collection, created.id, { data: { title: 'Lost' } }), /simulated batch failure/);
    assert.deepEqual(sqlite.prepare('SELECT data FROM galaxy_entries WHERE id = ?').get(created.id).data, JSON.stringify({ title: 'First' }));
    assert.equal((await listEntryRevisions(db, collection.id, created.id)).length, 1);

    await saveDraftEntry(db, collection, created.id, { data: { title: 'Second' } });
    const published = await publishEntry(db, collection, created.id);
    assert.deepEqual(published.publishedData, { title: 'Second' });
    assert.equal((await listEntryRevisions(db, collection.id, created.id)).length, 3);
    assert.throws(() => sqlite.prepare(`INSERT INTO galaxy_entry_revisions
      (id, entry_id, collection_id, revision_number, type, status, data, created_at)
      VALUES ('duplicate', 'post-1', 'posts-id', 3, 'draft_save', 'draft', '{}', 1)`).run(), /UNIQUE constraint failed/);
  } finally {
    sqlite.close();
  }
});

test('stale editor actions preserve the latest entry and revision', async () => {
  const { sqlite, db } = database();
  try {
    const collection = await db.query.collections.findFirst({ where: (table, { eq }) => eq(table.id, 'posts-id') });
    const entry = await createDraftEntry(db, collection, { title: 'First' }, { id: 'post-2' });
    const openedRevision = await getLatestRevision(db, entry.id);
    await saveDraftEntry(db, collection, entry.id, { data: { title: 'Second' }, expectedRevisionId: openedRevision.id });
    const latestRevision = await getLatestRevision(db, entry.id);

    await assert.rejects(saveDraftEntry(db, collection, entry.id, {
      data: { title: 'Stale' }, expectedRevisionId: openedRevision.id
    }), RevisionConflictError);
    await assert.rejects(publishEntry(db, collection, entry.id, openedRevision.id), RevisionConflictError);
    await assert.rejects(archiveEntry(db, collection, entry.id, openedRevision.id), RevisionConflictError);
    await assert.rejects(restoreEntryRevision(db, collection, entry.id, openedRevision.id, openedRevision.id), RevisionConflictError);

    const stored = sqlite.prepare('SELECT data, status FROM galaxy_entries WHERE id = ?').get(entry.id);
    assert.deepEqual(JSON.parse(stored.data), { title: 'Second' });
    assert.equal(stored.status, 'draft');
    assert.equal((await getLatestRevision(db, entry.id)).id, latestRevision.id);
    assert.equal((await listEntryRevisions(db, collection.id, entry.id)).length, 2);
  } finally {
    sqlite.close();
  }
});

test('the default publishing workflow binding also accepts its pre-rename GALAXY_ name', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { sqlite, DB, db } = database();
  try {
    const collection = await db.query.collections.findFirst({ where: (table, { eq }) => eq(table.id, 'posts-id') });
    await createDraftEntry(db, collection, { title: 'Workflow' }, { id: 'post-3' });
    const started = [];
    const workflow = (name) => ({
      async create() {
        started.push(name);
        return { id: `${name}-instance`, async status() { return { status: 'complete' }; } };
      },
    });
    const payload = { collectionSlug: 'posts', entryId: 'post-3', action: 'publish' };

    await triggerPublishingWorkflow({ DB, TALISMAN_PUBLISH_WORKFLOW: workflow('talisman'), GALAXY_PUBLISH_WORKFLOW: workflow('galaxy') }, payload);
    await triggerPublishingWorkflow({ DB, GALAXY_PUBLISH_WORKFLOW: workflow('galaxy') }, payload);
    await triggerPublishingWorkflow({ DB, CUSTOM_WORKFLOW: workflow('custom'), GALAXY_PUBLISH_WORKFLOW: workflow('galaxy') }, payload, 'CUSTOM_WORKFLOW');
    assert.deepEqual(started, ['talisman', 'galaxy', 'custom']);
    assert.equal(sqlite.prepare('SELECT status FROM galaxy_entries WHERE id = ?').get('post-3').status, 'draft');

    // Without a workflow binding the transition runs in the request.
    assert.equal((await triggerPublishingWorkflow({ DB }, payload)).status, 'published');
  } finally {
    sqlite.close();
  }
});

function insertSeededEntry(sqlite, { id, status = 'published', data, publishedData = null }) {
  const stamp = Math.floor(Date.now() / 1000) - 3600;
  sqlite.prepare(`INSERT INTO galaxy_entries (id, collection_id, slug, status, data, published_data, created_at, updated_at)
    VALUES (?, 'posts-id', ?, ?, ?, ?, ?, ?)`)
    .run(id, id, status, JSON.stringify(data), publishedData === null ? null : JSON.stringify(publishedData), stamp, stamp);
}

test('an entry without revisions accepts a null expected revision once and keeps its stored state as a baseline', async () => {
  const { sqlite, db } = database();
  try {
    const collection = await db.query.collections.findFirst({ where: (table, { eq }) => eq(table.id, 'posts-id') });
    // Seeded straight into D1: published, with no revisions and no published snapshot.
    insertSeededEntry(sqlite, { id: 'seeded', data: { title: 'Seeded' } });

    const saved = await saveDraftEntry(db, collection, 'seeded', { data: { title: 'Edited draft' }, expectedRevisionId: null });
    assert.deepEqual(saved.data, { title: 'Edited draft' });
    // The draft stays off the live site: the stored state was pinned as the published snapshot.
    assert.deepEqual(saved.publishedData, { title: 'Seeded' });

    const revisions = await listEntryRevisions(db, collection.id, 'seeded');
    assert.deepEqual(revisions.map((revision) => [revision.revisionNumber, revision.type, revision.data.title]),
      [[2, 'draft_save', 'Edited draft'], [1, 'publish', 'Seeded']]);
    assert.equal(saved.publishedRevisionId, revisions[1].id);

    // Now that it has revisions, a null expectation is stale.
    await assert.rejects(saveDraftEntry(db, collection, 'seeded', { data: { title: 'Stale' }, expectedRevisionId: null }), RevisionConflictError);
    await assert.rejects(publishEntry(db, collection, 'seeded', null), RevisionConflictError);
    assert.equal((await listEntryRevisions(db, collection.id, 'seeded')).length, 2);

    const published = await publishEntry(db, collection, 'seeded', revisions[0].id);
    assert.deepEqual(published.publishedData, { title: 'Edited draft' });
  } finally {
    sqlite.close();
  }
});

test('publishing an entry without revisions records the baseline in the same batch', async () => {
  const { sqlite, db, failNextBatchAt } = database();
  try {
    const collection = await db.query.collections.findFirst({ where: (table, { eq }) => eq(table.id, 'posts-id') });
    insertSeededEntry(sqlite, { id: 'draft-seed', status: 'draft', data: { title: 'Imported' } });

    failNextBatchAt(2);
    await assert.rejects(publishEntry(db, collection, 'draft-seed', null), /simulated batch failure/);
    assert.equal((await listEntryRevisions(db, collection.id, 'draft-seed')).length, 0);

    const published = await publishEntry(db, collection, 'draft-seed', null);
    assert.equal(published.status, 'published');
    const revisions = await listEntryRevisions(db, collection.id, 'draft-seed');
    assert.deepEqual(revisions.map((revision) => [revision.revisionNumber, revision.type, revision.status]),
      [[2, 'publish', 'published'], [1, 'draft_save', 'draft']]);
    assert.equal(published.publishedRevisionId, revisions[0].id);
  } finally {
    sqlite.close();
  }
});

function applyMigration(sqlite, name) {
  const sql = readFileSync(new URL(`../drizzle/${name}.sql`, import.meta.url), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

test('migration 0020 backfills baseline revisions and unwraps double-encoded globals, and can run again', () => {
  const { sqlite } = database();
  try {
    insertSeededEntry(sqlite, { id: 'published-seed', data: { title: 'Live' } });
    insertSeededEntry(sqlite, { id: 'draft-seed', status: 'draft', data: { title: 'Draft' } });
    insertSeededEntry(sqlite, { id: 'archived-seed', status: 'archived', data: { title: 'Old' }, publishedData: { title: 'Old live' } });
    insertSeededEntry(sqlite, { id: 'edited', data: { title: 'Edited' }, publishedData: { title: 'Edited' } });
    sqlite.prepare(`INSERT INTO galaxy_entry_revisions (id, entry_id, collection_id, revision_number, type, status, data, created_at)
      VALUES ('rev-edited', 'edited', 'posts-id', 4, 'publish', 'published', '{"title":"Edited"}', 1)`).run();

    const insertGlobal = sqlite.prepare(`INSERT INTO galaxy_globals (id, name, slug, data, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)`);
    insertGlobal.run('g1', 'Double', 'double', JSON.stringify(JSON.stringify({ siteName: 'Talisman' })));
    insertGlobal.run('g2', 'Empty default', 'empty', JSON.stringify('{}'));
    insertGlobal.run('g3', 'Object', 'object', JSON.stringify({ siteName: 'Kept' }));
    insertGlobal.run('g4', 'Plain string', 'plain', JSON.stringify('not json'));
    insertGlobal.run('g5', 'Invalid', 'invalid', '{broken');
    insertGlobal.run('g6', 'Encoded number', 'number', JSON.stringify('42'));

    applyMigration(sqlite, '0020_revision_baseline_and_globals');
    const snapshot = () => ({
      revisions: sqlite.prepare('SELECT id, entry_id, revision_number, type, status, data FROM galaxy_entry_revisions ORDER BY id').all()
        .map((row) => ({ ...row })),
      entries: sqlite.prepare('SELECT id, published_data, published_revision_id FROM galaxy_entries ORDER BY id').all()
        .map((row) => ({ ...row })),
      globals: Object.fromEntries(sqlite.prepare('SELECT slug, data FROM galaxy_globals').all().map((row) => [row.slug, row.data])),
    });
    const first = snapshot();

    assert.deepEqual(first.revisions.map((row) => [row.id, row.revision_number, row.type, row.status, JSON.parse(row.data).title]), [
      ['baseline_rev_archived-seed', 1, 'archive', 'archived', 'Old'],
      ['baseline_rev_draft-seed', 1, 'draft_save', 'draft', 'Draft'],
      ['baseline_rev_published-seed', 1, 'publish', 'published', 'Live'],
      ['rev-edited', 4, 'publish', 'published', 'Edited'],
    ]);
    const entries = Object.fromEntries(first.entries.map((row) => [row.id, row]));
    assert.equal(entries['published-seed'].published_revision_id, 'baseline_rev_published-seed');
    assert.deepEqual(JSON.parse(entries['published-seed'].published_data), { title: 'Live' });
    assert.equal(entries['draft-seed'].published_revision_id, null);
    assert.equal(entries['draft-seed'].published_data, null);
    assert.equal(entries.edited.published_revision_id, null);

    assert.deepEqual(JSON.parse(first.globals.double), { siteName: 'Talisman' });
    assert.equal(first.globals.empty, '{}');
    assert.equal(first.globals.object, JSON.stringify({ siteName: 'Kept' }));
    assert.equal(first.globals.plain, JSON.stringify('not json'));
    assert.equal(first.globals.invalid, '{broken');
    assert.equal(first.globals.number, JSON.stringify('42'));

    applyMigration(sqlite, '0020_revision_baseline_and_globals');
    assert.deepEqual(snapshot(), first);
  } finally {
    sqlite.close();
  }
});
