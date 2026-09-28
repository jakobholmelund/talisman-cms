import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { applyCoreMigrations } from './helpers/migrations.mjs';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../dist/db/schema.js';
import { createDraftEntry, getLatestRevision, RevisionConflictError, SlugConflictError } from '../dist/versioning.js';

// The Workflow class extends the Workers runtime's WorkflowEntrypoint; stand in for it.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== 'cloudflare:workers') return nextResolve(specifier, context);
    const source = 'export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});
const { TalismanPublishWorkflow } = await import('../dist/workflows.js');

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  applyCoreMigrations(sqlite);
  sqlite.prepare('INSERT INTO galaxy_collections (id, name, slug, fields, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('posts-id', 'Posts', 'posts', '[]', Math.floor(Date.now() / 1000));
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async all() { return { results: statement.all(...values) }; },
        async first() { return statement.get(...values) ?? null; },
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
        for (const statement of statements) results.push(await statement.all());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const kvDeleted = [];
  const KV = { async get() { return null; }, async put() {}, async delete(key) { kvDeleted.push(key); } };
  return { sqlite, db: drizzle(DB), env: { DB, KV }, kvDeleted };
}

/** Runs each step once, as a first attempt does, and records the step names. */
function stepRecorder() {
  const names = [];
  return { names, step: { async do(name, callback) { names.push(name); return callback(); } } };
}

test('the publish Workflow applies the transition, then clears the cached entries', async () => {
  const { sqlite, db, env, kvDeleted } = setup();
  try {
    const collection = await db.select().from(schema.collections).where(eq(schema.collections.id, 'posts-id')).get();
    await createDraftEntry(db, collection, { title: 'Hello' }, { id: 'hello', slug: 'hello' });
    const expectedRevisionId = (await getLatestRevision(db, 'hello')).id;
    const { names, step } = stepRecorder();

    const result = await new TalismanPublishWorkflow({}, env).run(
      { payload: { collectionSlug: 'posts', entryId: 'hello', action: 'publish', expectedRevisionId } }, step);
    assert.deepEqual(result, { ok: true, entryId: 'hello', status: 'published' });
    assert.deepEqual(names, ['apply publish transition', 'invalidate cached entries']);
    assert.ok(kvDeleted.includes('talisman:entries:posts:all:published'));
    assert.ok(kvDeleted.includes('talisman:entries:posts:hello:published'));
    assert.equal(sqlite.prepare(`SELECT status FROM galaxy_entries WHERE id = 'hello'`).get().status, 'published');
  } finally {
    sqlite.close();
  }
});

test('a transition that cannot succeed ends the Workflow with its error instead of being retried', async () => {
  const { sqlite, db, env, kvDeleted } = setup();
  try {
    const collection = await db.select().from(schema.collections).where(eq(schema.collections.id, 'posts-id')).get();
    await createDraftEntry(db, collection, { title: 'Hello' }, { id: 'hello', slug: 'hello' });

    const stale = stepRecorder();
    const staleResult = await new TalismanPublishWorkflow({}, env).run(
      { payload: { collectionSlug: 'posts', entryId: 'hello', action: 'publish', expectedRevisionId: 'rev-old' } }, stale.step);
    assert.deepEqual(staleResult, { ok: false, error: { name: 'RevisionConflictError', message: new RevisionConflictError().message } });
    assert.deepEqual(stale.names, ['apply publish transition']);
    assert.deepEqual(kvDeleted, []);
    assert.equal(sqlite.prepare(`SELECT status FROM galaxy_entries WHERE id = 'hello'`).get().status, 'draft');

    // A slug another published entry serves.
    sqlite.prepare(`INSERT INTO galaxy_entries (id, collection_id, slug, status, data, created_at, updated_at)
      VALUES ('copy', 'posts-id', 'taken', 'draft', '{}', 1, 1), ('live', 'posts-id', 'taken', 'published', '{}', 1, 1)`).run();
    const taken = await new TalismanPublishWorkflow({}, env).run(
      { payload: { collectionSlug: 'posts', entryId: 'copy', action: 'publish', expectedRevisionId: null } }, stepRecorder().step);
    assert.equal(taken.ok, false);
    assert.equal(taken.error.message, new SlugConflictError().message);

    const missing = await new TalismanPublishWorkflow({}, env).run(
      { payload: { collectionSlug: 'posts', entryId: 'gone', action: 'archive' } }, stepRecorder().step);
    assert.deepEqual(missing, { ok: false, error: { name: 'EntryNotFoundError', message: 'Entry gone not found' } });

    // Other failures are thrown, so the step is retried.
    const broken = { ...env, DB: { prepare() { throw new Error('D1_ERROR: network connection lost'); } } };
    await assert.rejects(new TalismanPublishWorkflow({}, broken).run(
      { payload: { collectionSlug: 'posts', entryId: 'hello', action: 'publish' } }, stepRecorder().step), /network connection lost/);
  } finally {
    sqlite.close();
  }
});
