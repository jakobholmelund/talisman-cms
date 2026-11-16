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

test('compiled tracking UI excludes private routes and leaves inspector disabled unless explicitly enabled', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'talisman-tracking-ui-'));
  try {
    const filename = new URL('../src/Tracking.astro', import.meta.url);
    const compiled = await transform(await readFile(filename, 'utf8'), { filename: filename.pathname, internalURL: 'astro/compiler-runtime', resolvePath: value => value });
    const out = join(scratch, 'Tracking.mjs');
    // Styles are compiled by the consumer build; this test exercises the real SSR template.
    const source = compiled.code.replace(/^import ["'][^"']+\?astro&type=style[^"']+["'];?\s*$/gm, '');
    await build({ stdin: { contents: source, loader: 'ts', resolveDir: new URL('..', import.meta.url).pathname }, outfile: out, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
    let code = await readFile(out, 'utf8');
    for (const [specifier, url] of [
      ['astro/compiler-runtime', pathToFileURL(require.resolve('astro/compiler-runtime')).href],
      ['@talisman-cms/plugin-analytics/tracking', new URL('../dist/tracking.js', import.meta.url).href],
      ['@talisman-cms/plugin-analytics/tracking/ga4', new URL('../dist/tracking-ga4.js', import.meta.url).href],
    ]) {
      code = code.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(url)}`);
    }
    await writeFile(out, code);
    const component = (await import(pathToFileURL(out).href)).default;
    const container = await experimental_AstroContainer.create();
    const render = (path, props = {}) => container.renderToString(component, { props: { measurementId: 'G-TEST1234', adminPath: '/staff', ...props }, request: new Request('https://shop.test' + path) });
    const production = await render('/shop?inspect=true');
    assert.match(production, /Allow analytics/); assert.match(production, /Decline analytics/);
    assert.doesNotMatch(production, /Tracking inspector|googletagmanager\.com/);
    assert.match(await render('/shop', { inspect: true, preview: true }), /Tracking inspector/);
    for (const path of ['/staff', '/staff/users', '/admin', '/account/verify?token=private', '/api/cart', '/checkout/success', '/checkout/cancel', '/gift-cards/claim', '/r/private']) {
      assert.doesNotMatch(await render(path, { inspect: true }), /data-talisman-tracking/);
    }
    assert.doesNotMatch(await render('/shop', { measurementId: '' }), /data-talisman-tracking/);
    assert.doesNotMatch(await render('/shop', { measurementId: 'sk_private' }), /sk_private|data-talisman-tracking/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
