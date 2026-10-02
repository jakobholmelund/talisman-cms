import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { database, runtime, as, editor, skip } from '../../talisman-cms/test/helpers/handler-harness.mjs';
import { daisyUiPlugin } from '../dist/index.js';

const sourceRoot = new URL('../src/', import.meta.url).href;
const coreRoot = new URL('../../talisman-cms/src/', import.meta.url);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(sourceRoot)) {
    if (specifier === 'talisman-cms/client') return { url: new URL('client.ts', coreRoot).href, shortCircuit: true };
    if (specifier === 'talisman-cms/auth/guard') return { url: new URL('auth/guard.ts', coreRoot).href, shortCircuit: true };
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
} });
const { GET, POST } = await import('../src/routes/api-theme.ts');
runtime.globals.push(...daisyUiPlugin().onInit({ globals: [] }).globals);
const request = (method, body, headers = {}) => new Request('https://cms.example.test/cms/api/daisyui/theme', {
  method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const save = (body, headers) => POST({ request: request('POST', body, headers) });

test('stale theme save answers 409 and preserves the first editor’s settings', { skip }, async () => {
  const sqlite = database();
  try {
    await as(editor, async () => {
      const loaded = await GET({ request: request('GET') });
      assert.equal(loaded.headers.get('cache-control'), 'private, no-store');
      const initial = await loaded.json();
      assert.equal(initial.version, 1);
      const first = await save({ lightTheme: 'cupcake', expectedVersion: initial.version });
      assert.equal(first.status, 200);
      assert.equal((await first.json()).version, 2);
      const stale = await save({ darkTheme: 'business', expectedVersion: initial.version });
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).code, 'stale_record');
      const latest = await (await GET({ request: request('GET') })).json();
      assert.equal(latest.lightTheme, 'cupcake');
      assert.equal(latest.darkTheme, undefined);
      const reapplied = await save({ lightTheme: latest.lightTheme, darkTheme: 'business', expectedVersion: latest.version });
      assert.equal(reapplied.status, 200);
      assert.equal((await reapplied.json()).lightTheme, 'cupcake');
    });
  } finally { sqlite.close(); }
});

test('theme API refuses missing versions, hostile values, cross-origin and unsigned requests', { skip }, async () => {
  const sqlite = database();
  try {
    for (const expectedVersion of [undefined, null, 0, -1, 1.5, '1']) assert.equal((await save({ expectedVersion })).status, 400);
    assert.equal((await save({ expectedVersion: 1, lightTheme: '</style><script>alert(1)</script>' })).status, 400);
    assert.equal((await save({ expectedVersion: 1, lightColors: { primary: 'red; background:url(javascript:alert(1))' } })).status, 400);
    assert.equal((await save({ expectedVersion: 1 }, { Origin: 'https://other.example.test' })).status, 403);
    await as(null, async () => {
      assert.equal((await GET({ request: request('GET') })).status, 401);
      assert.equal((await save({ expectedVersion: 1 })).status, 401);
    });
  } finally { sqlite.close(); }
});
