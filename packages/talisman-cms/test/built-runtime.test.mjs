import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { database, runtime, skip } from './helpers/handler-harness.mjs';
import talismanCms from '../dist/integration.js';
import { getClient } from '../dist/client.js';

// Use the route Astro actually injects, then cross into the published SDK in the same isolate.
// Source-injected routes plus built SDK each initialized their own per-database service state.
test('injected routes and published SDK share one service runtime on a custom admin path', { skip }, async () => {
  const routes = [];
  talismanCms({ adminPath: '/cms', collections: runtime.collections }).hooks['astro:config:setup']({
    command: 'build', config: { server: { host: false } },
    injectRoute(route) { routes.push(route); }, updateConfig() {}, addDevToolbarApp() {}, addMiddleware() {},
  });
  const route = routes.find(route => route.pattern === '/cms/api/[...route]');
  assert.ok(route);
  const { ALL } = await import(pathToFileURL(route.entrypoint));
  const sqlite = database();
  try {
    const request = new Request('https://cms.test/cms/api/collections/posts/entries?limit=10');
    assert.equal((await ALL({ request, locals: {} })).status, 200);
    const syncReads = () => runtime.env.DB.statements.filter(sql => /from "galaxy_collections"/i.test(sql)).length;
    const initializedReads = syncReads();
    assert.ok(initializedReads > 0);
    await getClient(runtime.env).entries.findMany('posts', { cache: false, limit: 10 });
    assert.equal(syncReads(), initializedReads, 'SDK reuses the route service collection memo and database initialization');
    assert.ok(routes.filter(route => !route.entrypoint.endsWith('.astro')).every(route => /\/dist\/routes\/.+\.js$/.test(route.entrypoint)));
  } finally { sqlite.close(); }
});
