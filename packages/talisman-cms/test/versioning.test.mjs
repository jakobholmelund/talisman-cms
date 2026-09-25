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
