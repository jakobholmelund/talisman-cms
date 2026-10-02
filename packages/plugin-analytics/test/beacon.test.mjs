import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { experimental_AstroContainer } from 'astro/container';
const require = createRequire(import.meta.url);
const astroRequire = createRequire(require.resolve('astro/package.json'));
const tsupRequire = createRequire(require.resolve('tsup'));
const { transform } = await import(pathToFileURL(astroRequire.resolve('@astrojs/compiler-rs')).href);
const { build } = await import(pathToFileURL(tsupRequire.resolve('esbuild')).href);

test('Beacon renders the supported module script with a token and omits admin/API pages', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'talisman-beacon-test-'));
  try {
    const filename = new URL('../src/Beacon.astro', import.meta.url);
    const compiled = await transform(await readFile(filename, 'utf8'), { filename: filename.pathname, internalURL: 'astro/compiler-runtime', resolvePath: value => value });
    const out = join(scratch, 'Beacon.mjs');
    await build({ stdin: { contents: compiled.code, loader: 'ts', resolveDir: new URL('..', import.meta.url).pathname }, outfile: out, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
    // Keep external Astro resolution in this workspace rather than the system temp folder.
    let code = await readFile(out, 'utf8');
    code = code.replace(/from "astro\/compiler-runtime"/g, `from ${JSON.stringify(pathToFileURL(require.resolve('astro/compiler-runtime')).href)}`);
    await writeFile(out, code);
    const component = (await import(pathToFileURL(out).href)).default;
    const container = await experimental_AstroContainer.create();
    const render = path => container.renderToString(component, { props: { token: 'a'.repeat(32), adminPath: '/staff_portal' }, request: new Request('https://shop.test' + path) });
    const html = await render('/about');
    assert.match(html, /type="module"/);
    assert.match(html, /src="https:\/\/static.cloudflareinsights.com\/beacon.min.js"/);
    assert.match(html, /data-cf-beacon=/);
    assert.ok(html.includes('a'.repeat(32)));
    for (const path of ['/staff_portal', '/staff_portal/login', '/staff_portal/api/analytics/ask', '/api', '/api/cart']) assert.equal((await render(path)).includes('<script'), false);
    assert.ok((await render('/staff_portal-public')).includes('<script'));
    await assert.rejects(() => container.renderToString(component, { props: { token: 'invalid' }, request: new Request('https://shop.test/') }), /32 hexadecimal/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
