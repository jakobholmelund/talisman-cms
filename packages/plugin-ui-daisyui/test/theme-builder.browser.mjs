import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = new URL('../.theme-browser.tsx', import.meta.url);

test('Theme Builder preserves edits on conflict, replays only local changes, and guards navigation at a custom admin path', async () => {
  writeFileSync(entry, `import React from 'react';
import { createRoot } from 'react-dom/client';
import { createRouter, createRootRoute, createRoute, RouterProvider, Outlet, Link } from '@tanstack/react-router';
import ThemeBuilder from './src/admin/ThemeBuilder';
const root = createRootRoute({ component: () => <><Link to="/other">Other page</Link><Outlet /></> });
const theme = createRoute({ getParentRoute: () => root, path: '/', component: ThemeBuilder });
const other = createRoute({ getParentRoute: () => root, path: '/other', component: () => <p>Other page loaded</p> });
const router = createRouter({ routeTree: root.addChildren([theme, other]) });
createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);`);
  const server = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 0 },
    resolve: { alias: { 'react-dom/client': fileURLToPath(new URL('../../talisman-cms/node_modules/react-dom/client.js', import.meta.url)) } },
    plugins: [{ name: 'theme-browser', resolveId(id) { if (id === 'virtual:talisman-cms/config') return '\0theme-config'; },
      load(id) { if (id === '\0theme-config') return 'export const adminPath = "/cms";'; },
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/cms/daisyui-preview')) { res.setHeader('Content-Type', 'text/html'); res.end('<html><body>Preview</body></html>'); }
        else if (req.url === '/' || req.url === '/other') { res.setHeader('Content-Type', 'text/html'); res.end('<html><body><div id="root"></div><script type="module" src="/.theme-browser.tsx"></script></body></html>'); }
        else next();
      }); }
    }] });
  let browser;
  try {
    await server.listen();
    const base = server.resolvedUrls.local[0];
    browser = await chromium.launch({ executablePath: process.env.TALISMAN_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let stored = { lightTheme: 'light', darkTheme: 'dark', version: 1 };
    let posts = 0;
    await page.route('**/cms/api/daisyui/theme', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: stored });
      posts++;
      const body = route.request().postDataJSON();
      if (body.expectedVersion !== stored.version) return route.fulfill({ status: 409, json: { code: 'stale_record', error: 'Changed' } });
      stored = { ...body, version: stored.version + 1 };
      return route.fulfill({ json: stored });
    });
    await page.route('**/cms/api/daisyui/layouts', (route) => route.fulfill({ json: { layouts: [] } }));
    await page.goto(base);
    await page.getByLabel('Dark Theme', { exact: true }).selectOption('business');
    stored = { lightTheme: 'cupcake', darkTheme: 'dark', version: 2 };
    await page.getByRole('button', { name: 'Save Theme', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Another editor saved' }).waitFor();
    assert.equal(await page.getByLabel('Dark Theme', { exact: true }).inputValue(), 'business');
    await page.getByRole('button', { name: 'Load latest version (keep my edits)' }).click();
    await page.getByRole('button', { name: 'Reapply my changes', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Light Theme', { exact: true }).inputValue(), 'cupcake');
    assert.equal(await page.getByLabel('Dark Theme', { exact: true }).inputValue(), 'dark');
    await page.getByRole('button', { name: 'Reapply my changes', exact: true }).click();
    assert.equal(await page.getByLabel('Dark Theme', { exact: true }).inputValue(), 'business');
    await page.getByRole('button', { name: 'Save Theme', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Theme saved successfully' }).waitFor();
    assert.equal(stored.lightTheme, 'cupcake');
    assert.equal(stored.darkTheme, 'business');
    assert.equal(posts, 2);
    await page.getByLabel('Light Theme', { exact: true }).selectOption('retro');
    let dialogs = 0;
    page.on('dialog', async (dialog) => { dialogs++; await dialog.dismiss(); });
    await page.getByRole('link', { name: 'Other page', exact: true }).click();
    assert.equal(dialogs, 1);
    assert.equal(new URL(page.url()).pathname, '/');
    await page.reload({ timeout: 2000 }).catch(() => {});
    assert.equal(dialogs, 2);
    assert.equal(await page.getByLabel('Light Theme', { exact: true }).inputValue(), 'retro');
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Open Full Preview' }).click();
    const popup = await popupPromise;
    await popup.waitForURL('**/cms/daisyui-preview?**');
    assert.equal(new URL(popup.url()).pathname, '/cms/daisyui-preview');
    assert.equal(JSON.parse(await popup.evaluate(() => sessionStorage.getItem('daisyui-preview-state'))).lightTheme, 'retro');
    await popup.close();
    await page.route('**/cms/api/daisyui/theme', (route) => route.fulfill({ status: 500, json: { error: 'Save unavailable' } }));
    await page.getByRole('button', { name: 'Save Theme', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Save unavailable' }).waitFor();
    assert.equal(await page.getByLabel('Light Theme', { exact: true }).inputValue(), 'retro');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); rmSync(entry, { force: true }); }
});
