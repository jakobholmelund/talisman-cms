import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { getViteConfig } from 'astro/config';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { chromium } from 'playwright-core';
import { validateManifest } from '../../talisman-cms/scripts/ui-library-manifest.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'catalog.manifest.json'), 'utf8'));
const hostile = '<script>window.hostile=true</script>';
const values = (fields, unsafe = false) => Object.fromEntries(fields.map((field) => [field.name,
  field.type === 'array' ? [values(field.fields || [], unsafe)] :
  field.type === 'group' ? values(field.fields || [], unsafe) :
  field.type === 'number' ? 3 : field.type === 'checkbox' ? true :
  field.type === 'select' ? field.options?.[0]?.value || field.options?.[0] || '' :
  /href|image|src|url/i.test(field.name) ? (unsafe ? 'javascript:alert(1)' : '/fixture.png') : unsafe ? hostile : 'Example',
]));

test('catalog rejects missing, stub and outside-package mapped renderers', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'daisy-renderer-validator-'));
  try {
    const item = manifest.items.find((item) => item.upstreamItemId === 'button');
    const mutated = (localFilePath) => ({ ...manifest, items: manifest.items.map((entry) => entry === item ? { ...entry, rendererTarget: { ...entry.rendererTarget, localFilePath } } : entry) });
    writeFileSync(path.join(root, 'stub.astro'), '<div data-talisman-ui-stub="button" />');
    for (const local of ['missing.astro', 'stub.astro', '../outside.astro']) {
      assert.ok(validateManifest(mutated(local), manifest.upstreamCatalog, { rendererRoot: root }).errors.some((error) => error.includes('button')), local);
    }
    assert.deepEqual(validateManifest(manifest, manifest.upstreamCatalog, { rendererRoot: packageRoot }).errors, []);
    assert.ok(manifest.items.some((item) => item.coverageStatus === 'partial'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every mapped renderer compiles and renders hostile editor values; repeated radio groups behave independently', async () => {
  const server = await createServer(await getViteConfig({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true }, environments: { client: { dev: { hot: false } }, ssr: { dev: { hot: false } } }, plugins: [{ name: 'test-components', resolveId(id) { if (id === 'virtual:talisman-cms/component-renderers') return '\0test-components'; }, load(id) { if (id === '\0test-components') return 'export const componentRenderers = {};'; } }], appType: 'custom' }, { root: packageRoot, configFile: false })({ mode: 'test', command: 'serve' }));
  const container = await AstroContainer.create();
  let browser;
  try {
    const outputs = new Map();
    for (const item of manifest.items.filter((entry) => entry.adapter && entry.coverageStatus !== 'unsupported')) {
      const { default: component } = await server.ssrLoadModule(item.rendererTarget.modulePath);
      const output = await container.renderToString(component, { props: values(item.adapter.fields) });
      assert.ok(output.trim(), item.upstreamItemId);
      const hostileOutput = await container.renderToString(component, { props: values(item.adapter.fields, true) });
      assert.doesNotMatch(hostileOutput, /data-talisman-ui-stub|(?:href|src)="javascript:/, item.upstreamItemId);
      outputs.set(item.upstreamItemId, { component, output });
    }
    if (process.env.TALISMAN_UI_BROWSER !== '1') return;
    browser = await chromium.launch({ executablePath: process.env.TALISMAN_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage();
    const props = {
      accordion: { items: [{ title: 'One', content: 'One' }, { title: 'Two', content: 'Two', open: true }] },
      radio: { label: 'Choice', options: [{ label: 'One', value: '1' }, { label: 'Two', value: '2' }], value: '1' },
      rating: { value: 3, max: 5 },
      filter: { items: [{ label: 'One', active: true }, { label: 'Two' }] },
    };
    for (const [id, propsValue] of Object.entries(props)) {
      const first = await container.renderToString(outputs.get(id).component, { props: propsValue });
      const second = await container.renderToString(outputs.get(id).component, { props: propsValue });
      await page.setContent(`<form><section id="a">${first}</section><section id="b">${second}</section></form>`);
      const names = await page.locator('input[type=radio]').evaluateAll((inputs) => inputs.map((input) => input.name));
      assert.equal(new Set(names).size, 2, id);
      assert.equal(await page.locator('#a input:checked').count(), 1, id);
      assert.equal(await page.locator('#b input:checked').count(), 1, id);
      const before = await page.locator('#b input:checked').getAttribute('value');
      await page.locator('#a input').first().focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('#a input:checked').count(), 1, id);
      assert.equal(await page.locator('#b input:checked').getAttribute('value'), before, id);
      const data = await page.locator('form').evaluate((form) => [...new FormData(form).entries()]);
      assert.equal(data.length, 2, id);
      assert.equal(new Set(data.map(([name]) => name)).size, 2, id);
    }
    await page.setContent(outputs.get('theme-controller').output);
    assert.equal(await page.locator('.theme-controller').count(), 0);
    assert.equal(await page.locator('html').getAttribute('data-theme'), null);
    assert.equal(await page.locator('[data-theme]').getAttribute('data-theme'), 'light');
  } finally { await browser?.close(); await server.close(); }
});
