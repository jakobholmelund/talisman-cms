// The harness the admin API handler tests share: Node type stripping and `module.registerHooks`
// stand in for the Astro virtual modules and `cloudflare:workers`, an in-memory `node:sqlite`
// database plays D1, and `call()` drives the handler as the stubbed user (`as()` switches users).
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { applyCoreMigrations } from './migrations.mjs';

// The API handler ships as source and imports Astro virtual modules, so this file loads it with
// Node's type stripping and stands in for the virtual modules and `cloudflare:workers`.
export const canLoadSource = Boolean(process.features.typescript) && typeof registerHooks === 'function';
export const skip = canLoadSource ? false : 'needs Node type stripping and module.registerHooks';

export const runtime = globalThis.__talismanHandlerTest = {
  env: {},
  user: { id: 'admin-1', email: 'admin@example.test', role: 'admin' },
  collections: [],
  globals: [],
  nativeSchemas: {},
  collectionHooks: {},
};
const stubs = {
  'cloudflare:workers': 'export const env = new Proxy({}, { get: (_, key) => globalThis.__talismanHandlerTest.env[key] });',
  'virtual:talisman-cms/auth': 'export const authConfigured = true; export const authAdapter = { async getUser() { return globalThis.__talismanHandlerTest.user; } };',
  // A custom Workflow binding name, which both the admin API and getClient must use.
  'virtual:talisman-cms/config': 'const t = globalThis.__talismanHandlerTest; export const adminPath = "/admin"; export const collections = t.collections; export const globals = t.globals; export const uiLibraries = []; export const publishing = { workflowBinding: "SITE_PUBLISH_WORKFLOW" };',
  'virtual:talisman-cms/ui-libraries': 'export const uiLibraries = [];',
  'virtual:talisman-cms/native-schemas': 'export const nativeSchemas = globalThis.__talismanHandlerTest.nativeSchemas; export const nativeSchemaConfig = {};',
  'virtual:talisman-cms/collection-hooks': 'export const collectionHooks = globalThis.__talismanHandlerTest.collectionHooks;',
};
const srcUrl = new URL('../../src/', import.meta.url).href;

export let ALL;
export let types;
export let getClient;
export let schema;
export let versioning;
export let publicClient;
if (canLoadSource) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (Object.hasOwn(stubs, specifier)) {
        return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
      }
      if (context.parentURL?.startsWith(srcUrl) && specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      return nextResolve(specifier, context);
    },
  });
  ({ ALL } = await import('../../src/api/handler.ts'));
  types = await import('../../src/types.ts');
  ({ getClient } = await import('../../src/db/client.ts'));
  schema = await import('../../src/db/schema.ts');
  versioning = await import('../../src/versioning.ts');
  publicClient = await import('../../src/client.ts');
}

export const parts = sqliteTable('test_parts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  quantity: integer('quantity').notNull(),
  // A column the Parts collection leaves out of its fields.
  internalNote: text('internal_note'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

runtime.collections.push(
  {
    name: 'Posts',
    slug: 'posts',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'body', label: 'Body', type: 'richtext', required: true },
      { name: 'summary', label: 'Summary', type: 'textarea' },
      { name: 'tags', label: 'Tags', type: 'relationship', relationTo: 'tags', hasMany: true },
      { name: 'note', label: 'Internal note', type: 'relationship', relationTo: 'notes' },
    ],
  },
  { name: 'Tags', slug: 'tags', fields: [{ name: 'label', label: 'Label', type: 'text' }] },
  { name: 'Notes', slug: 'notes', access: { read: 'admin' }, fields: [{ name: 'text', label: 'Text', type: 'text' }] },
  {
    name: 'Parts',
    slug: 'parts',
    fields: [
      { name: 'id', label: 'ID', type: 'text', required: true },
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'quantity', label: 'Quantity', type: 'number', required: true },
    ],
    nativeSchemaMapping: { schemaPath: 'test', exportName: 'parts', idColumn: 'id' },
  },
  {
    name: 'Media',
    slug: 'media',
    fields: ['id', 'filename', 'url', 'mimeType', 'altText'].map((name) => ({ name, label: name, type: 'text' })),
    nativeSchemaMapping: { schemaPath: 'talisman-cms/db/media', exportName: 'media', idColumn: 'id' },
  },
);
runtime.globals.push({ name: 'Site', slug: 'site', fields: [{ name: 'siteName', label: 'Site name', type: 'text', required: true }] });
runtime.nativeSchemas.parts = parts;
if (schema) runtime.nativeSchemas.media = schema.media;

export const hourAgo = Math.floor(Date.now() / 1000) - 3600;
export const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

export function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  applyCoreMigrations(sqlite);
  sqlite.exec(`CREATE TABLE test_parts (id text PRIMARY KEY NOT NULL, name text NOT NULL, quantity integer NOT NULL,
    internal_note text, created_at integer NOT NULL, updated_at integer NOT NULL)`);
  const statements = [];
  const DB = {
    statements,
    prepare(sql) {
      statements.push(sql);
      const statement = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...params) {
          // D1 refuses statements with more than 100 bound parameters.
          if (params.length > 100) throw new Error('D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR');
          values = params;
          return this;
        },
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
  runtime.env = { DB };
  return sqlite;
}

export async function call(method, path, body, headers = undefined) {
  const request = new Request(`https://cms.test/admin/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const response = await ALL({ request, locals: {} });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

export const admin = { id: 'admin-1', email: 'admin@example.test', role: 'admin' };
export const editor = { id: 'editor-1', email: 'editor@example.test', role: 'editor' };

export async function as(user, run) {
  runtime.user = user;
  try {
    return await run();
  } finally {
    runtime.user = admin;
  }
}

export const liveSlug = (sqlite, id) => sqlite.prepare('SELECT slug, draft_slug FROM galaxy_entries WHERE id = ?').get(id);

export async function seedPost(sqlite, id, data, status = 'published') {
  // Resolving the collection once creates its row, as the admin does on first load.
  await call('GET', '/collections/posts/entries');
  const { id: collectionId } = sqlite.prepare(`SELECT id FROM galaxy_collections WHERE slug = 'posts'`).get();
  sqlite.prepare(`INSERT INTO galaxy_entries (id, collection_id, slug, status, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, collectionId, id, status, JSON.stringify(data), hourAgo, hourAgo);
}

export const revisionCount = (sqlite, entryId) =>
  sqlite.prepare('SELECT COUNT(*) AS total FROM galaxy_entry_revisions WHERE entry_id = ?').get(entryId).total;

