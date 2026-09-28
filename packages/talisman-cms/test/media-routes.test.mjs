import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { applyCoreMigrations } from './helpers/migrations.mjs';

// The media routes ship as source and read `cloudflare:workers` and the auth virtual module; this
// file loads them with Node's type stripping and stands in for both.
const canLoadSource = Boolean(process.features.typescript) && typeof registerHooks === 'function';
const skip = canLoadSource ? false : 'needs Node type stripping and module.registerHooks';

const runtime = globalThis.__talismanMediaTest = { env: {} };
const stubs = {
  'cloudflare:workers': 'export const env = new Proxy({}, { get: (_, key) => globalThis.__talismanMediaTest.env[key] });',
  'virtual:talisman-cms/auth': 'export const authConfigured = true; export const authAdapter = { async getUser() { return { id: "editor-1", email: "e@example.test", role: "editor" }; } };',
  'virtual:talisman-cms/config': 'export const collections = [{ name: "Media", slug: "media", fields: [], nativeSchemaMapping: { schemaPath: "talisman-cms/db/media", exportName: "media", idColumn: "id" } }]; export const globals = []; export const publishing = {};',
};
const srcUrl = new URL('../src/', import.meta.url).href;
let serve;
let upload;
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
  serve = (await import('../src/routes/api/media-serve.ts')).GET;
  upload = (await import('../src/routes/api/media-upload.ts')).POST;
}

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function edgeCache() {
  const entries = new Map();
  return {
    entries,
    async match(key) { return entries.get(key)?.clone(); },
    async put(key, response) { entries.set(key, response); },
    async delete(key) { return entries.delete(key); },
  };
}

function bucket(objects) {
  return {
    async get(key) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        body: new Response(bytes).body,
        etag: `etag-${key}`,
        httpEtag: `"etag-${key}"`,
        writeHttpMetadata(headers) { headers.set('Content-Type', 'image/png'); },
      };
    },
    async put(key, value) { objects.set(key, new Uint8Array(value)); },
    async delete(key) { objects.delete(key); },
  };
}

async function get(path, headers = {}) {
  const pending = [];
  const url = new URL(path, 'https://site.test');
  const response = await serve({
    request: new Request(url, { headers }),
    params: { route: url.pathname.split('/').pop() },
    locals: { cfContext: { waitUntil: (promise) => pending.push(promise) } },
  });
  await Promise.all(pending);
  return response;
}

test('media is cached for an hour under versioned keys and revalidated with its ETag', { skip }, async () => {
  const cache = edgeCache();
  globalThis.caches = { default: cache };
  const objects = new Map([['media_abc', PNG]]);
  runtime.env = { STORAGE: bucket(objects) };
  try {
    const first = await get('/api/media/media_abc');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('Cache-Control'), 'public, max-age=3600');
    assert.equal(first.headers.get('ETag'), '"etag-media_abc"');
    assert.equal(first.headers.get('Content-Type'), 'image/png');
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), PNG);
    // Responses cached before this release (marked immutable for a year) sit under the old key and are not read.
    assert.deepEqual([...cache.entries.keys()], ['https://site.test/api/media/media_abc?v=2']);

    const revalidated = await get('/api/media/media_abc', { 'If-None-Match': '"etag-media_abc"' });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.headers.get('ETag'), '"etag-media_abc"');
    assert.equal(await revalidated.text(), '');
    assert.equal((await get('/api/media/media_abc', { 'If-None-Match': '"other"' })).status, 200);

    // A resized copy has its own key and ETag.
    runtime.env.IMAGES = {
      input: () => ({ transform: () => ({ output: async () => ({ response: ({ headers }) => new Response('webp', { headers }) }) }) }),
    };
    const resized = await get('/api/media/media_abc?w=640');
    assert.equal(resized.headers.get('ETag'), 'W/"etag-media_abc-w640"');
    assert.equal(resized.headers.get('Cache-Control'), 'public, max-age=3600');
    assert.ok(cache.entries.has('https://site.test/api/media/media_abc?v=2&w=640'));
    assert.equal((await get('/api/media/media_abc?w=641')).status, 400);

    // Once the file and its cached copies are gone, the URL answers 404.
    const { deleteStoredMedia } = await import('../src/db/media-policy.ts');
    await deleteStoredMedia(runtime.env, 'media_abc', 'https://site.test');
    assert.equal(cache.entries.size, 0);
    assert.equal((await get('/api/media/media_abc')).status, 404);
  } finally {
    delete globalThis.caches;
  }
});

function uploadRequest() {
  const form = new FormData();
  form.append('file', new File([PNG], 'pixel.png', { type: 'image/png' }));
  return new Request('https://site.test/admin/api/media/upload', { method: 'POST', body: form });
}

test('an upload whose record cannot be saved removes its file again', { skip }, async (t) => {
  t.mock.method(console, 'error', () => {});
  const objects = new Map();
  runtime.env = {
    STORAGE: bucket(objects),
    DB: { prepare() { throw new Error('D1_ERROR: no such table: galaxy_media: SQLITE_ERROR'); } },
  };
  const failed = await upload({ request: uploadRequest() });
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /D1_ERROR|galaxy_media/);
  assert.equal(objects.size, 0);

  // With a database the file and its record are both kept.
  const sqlite = new DatabaseSync(':memory:');
  applyCoreMigrations(sqlite);
  runtime.env.DB = {
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async raw() { const raw = sqlite.prepare(sql); raw.setReturnArrays(true); return raw.all(...values); },
        async run() { return { meta: sqlite.prepare(sql).run(...values) }; },
      };
    },
  };
  const deleted = [];
  runtime.env.KV = { async delete(key) { deleted.push(key); } };
  try {
    const saved = await upload({ request: uploadRequest() });
    assert.equal(saved.status, 200);
    const record = await saved.json();
    assert.match(record.id, /^media_[0-9a-f-]+$/);
    assert.equal(record.url, `/api/media/${record.id}`);
    assert.deepEqual([...objects.keys()], [record.id]);
    // The library's cached reads are cleared for the collection the media table backs.
    assert.ok(deleted.includes('talisman:entries:media:all:published'), deleted.join(', '));
    assert.ok(deleted.includes(`talisman:entries:media:${record.id}:published`));
  } finally {
    sqlite.close();
  }
});
