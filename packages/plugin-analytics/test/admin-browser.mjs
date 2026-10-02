// Run explicitly in the sanitized verification clone: node packages/plugin-analytics/test/admin-browser.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { experimental_AstroContainer } from 'astro/container';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const coreRequire = createRequire(new URL('../../talisman-cms/package.json', import.meta.url));
const { build } = await import(pathToFileURL(createRequire(require.resolve('tsup')).resolve('esbuild')).href);
const astroRequire = createRequire(require.resolve('astro/package.json'));
const { transform } = await import(pathToFileURL(astroRequire.resolve('@astrojs/compiler-rs')).href);
const compiled = transform(await readFile(new URL('../src/Beacon.astro', import.meta.url), 'utf8'), {
  internalURL: pathToFileURL(require.resolve('astro/compiler-runtime')).href, resolvePath: value => value,
});
const beaconBuild = await build({ stdin: { contents: compiled.code, loader: 'ts' }, write: false, format: 'esm' });
const beacon = (await import('data:text/javascript,' + encodeURIComponent(beaconBuild.outputFiles[0].text))).default;
const container = await experimental_AstroContainer.create();
const beaconHtml = await container.renderToString(beacon, { props: { token: 'a'.repeat(32) }, request: new Request('https://shop.test/') });
const bundle = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import Analytics from './src/admin/Analytics'; import CommerceAnalytics from './src/admin/CommerceAnalytics';
    import AskAnalytics from './src/admin/AskAnalytics';
    const components={overview:Analytics,commerce:CommerceAnalytics,ask:AskAnalytics};
    createRoot(document.getElementById('root')).render(React.createElement(components[location.pathname.slice(1)]));`,
    resolveDir: new URL('..', import.meta.url).pathname, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
  plugins: [{ name: 'fixture-sdk', setup(build) {
    build.onResolve({ filter: /^react-dom\// }, args => ({ path: coreRequire.resolve(args.path) }));
    build.onResolve({ filter: /^talisman-cms\/ui\/sdk$/ }, () => ({ path: 'sdk', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export async function adminRequest(area, options) {
      const response=await fetch('/fixture/'+area, {method:options?.body?'POST':'GET',signal:options?.signal,body:options?.body?JSON.stringify(options.body):undefined});
      const json=await response.json(); if(!response.ok) throw new Error(json.error); return json; }` }));
  } }],
});
const server = createServer((request, response) => {
  if (request.url === '/bundle.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(bundle.outputFiles[0].text); }
  else if (request.url === '/beacon') { response.setHeader('Content-Type', 'text/html'); response.end(`<!doctype html><html lang="en"><title>Beacon fixture</title>${beaconHtml}</html>`); }
  else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html lang="en"><title>Analytics fixture</title><div id="root"></div><script src="/bundle.js"></script></html>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage(); const failures = [];
page.on('pageerror', error => failures.push(error.message));
const url = `http://127.0.0.1:${server.address().port}`;
let payload = { error: 'Set CLOUDFLARE_ANALYTICS_ACCOUNT_ID, CLOUDFLARE_ANALYTICS_SITE_TAG, and CLOUDFLARE_ANALYTICS_API_TOKEN in Worker bindings.' }, status = 503;
await page.route('**/fixture/**', route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) }));
try {
  await page.route('https://static.cloudflareinsights.com/beacon.min.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.beaconFixtureToken = JSON.parse(document.querySelector('[data-cf-beacon]').getAttribute('data-cf-beacon')).token;` }));
  await page.goto(url + '/beacon');
  await page.waitForFunction(() => window.beaconFixtureToken);
  assert.equal(await page.evaluate(() => window.beaconFixtureToken), 'a'.repeat(32));
  await page.goto(url + '/overview');
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /CLOUDFLARE_ANALYTICS/);
  assert.equal(await page.getByRole('button', { name: '7 days' }).getAttribute('aria-pressed'), 'true');
  await page.goto(url + '/commerce');
  await page.getByRole('alert').waitFor();
  payload = { error: 'A Cloudflare Workers AI binding is required for Ask Analytics.' };
  await page.goto(url + '/ask');
  await page.getByLabel('Your question').fill('Sales last 7 days');
  await page.getByRole('button', { name: 'Create report', exact: true }).click();
  await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').innerText(), /Workers AI binding/);
  status = 200;
  payload = { title: 'Traffic and sales', subject: 'traffic_and_sales', question: 'Traffic and sales last 7 days',
    period: { label: 'Last 7 days', start: '2026-09-18T12:00:00Z', end: '2026-09-25T12:00:00Z' },
    summary: 'There was 1 confirmed order and $10.00 net sales in USD.',
    commerce: { refundBasis: 'refund_date', currencies: [{ currency: 'usd', orders: 1, grossSales: 1000, netSales: 1000, refunds: 0, averageOrderValue: 1000 }],
      daily: [{ date: '2026-09-18', currency: 'usd', orders: 0, netSales: 0 }, { date: '2026-09-19', currency: 'usd', orders: 1, netSales: 1000 }], products: [] },
    notes: ['Traffic is unavailable. Check Cloudflare Analytics setup or try again later. Commerce figures remain available.'] };
  await page.getByRole('button', { name: 'Create report', exact: true }).click();
  await page.getByRole('heading', { name: 'Traffic and sales', exact: true }).waitFor();
  assert.match(await page.getByRole('img').getAttribute('aria-label'), /2026-09-18: \$0.00; 2026-09-19: \$10.00/);
  assert.match(await page.getByRole('status').innerText(), /Commerce figures remain available/);
  await page.getByText('How this report was calculated').click();
  assert.equal(await page.getByRole('button', { name: 'Create report', exact: true }).isEnabled(), true);
  assert.deepEqual(failures, []);
  console.log('PASS: actual Beacon module execution with a stubbed remote script; missing traffic/commerce/AI setup, accessible controls/errors/UTC chart values, and degraded commerce report.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
