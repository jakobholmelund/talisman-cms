import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';

test('built preview authenticates, follows adminPath, scans plugin CSS and applies unsaved styles under CSP', { skip: !process.env.TALISMAN_DAISYUI_PREVIEW_URL }, async () => {
  const base = process.env.TALISMAN_DAISYUI_PREVIEW_URL;
  const adminPath = process.env.TALISMAN_DAISYUI_ADMIN_PATH || '/cms';
  const browser = await chromium.launch({ executablePath: process.env.TALISMAN_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const violations = [];
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => window.__cspViolations.push(`${event.effectiveDirective}: ${event.blockedURI}`));
    });
    const unsigned = await page.request.get(`${base}${adminPath}/api/daisyui/theme`);
    assert.equal(unsigned.status(), 401);
    const unsignedPreview = await page.request.get(`${base}${adminPath}/daisyui-preview`, { maxRedirects: 0 });
    assert.equal(unsignedPreview.status(), 302);
    assert.equal(unsignedPreview.headers().location, adminPath);
    await page.goto(`${base}${adminPath}`);
    const setup = await (await page.request.get(`${base}${adminPath}/api/auth/setup`)).json();
    if (setup.required) {
      await page.getByLabel('Name', { exact: true }).fill('Preview Admin');
      await page.getByLabel('Email', { exact: true }).fill('daisy-preview@example.test');
      await page.getByLabel('Password', { exact: true }).fill('Daisy-preview-test-2026');
      await page.getByLabel('Setup token', { exact: true }).fill(process.env.TALISMAN_E2E_SETUP_TOKEN);
      await page.getByRole('button', { name: 'Create admin', exact: true }).click();
      await page.getByRole('heading', { name: 'Sign in to Talisman CMS', exact: true }).waitFor();
    }
    await page.getByLabel('Email', { exact: true }).fill('daisy-preview@example.test');
    await page.getByLabel('Password', { exact: true }).fill('Daisy-preview-test-2026');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('link', { name: 'DaisyUI Theme', exact: true }).waitFor();
    const api = `${base}${adminPath}/api/daisyui/theme`;
    const version = (await (await page.request.get(api)).json()).version;
    const save = await page.request.post(api, { data: { expectedVersion: version, lightTheme: 'light', darkTheme: 'dark', lightColors: { primary: '#123456' } } });
    assert.equal(save.status(), 200);
    await page.evaluate(() => sessionStorage.setItem('daisyui-preview-state', JSON.stringify({ lightTheme: 'light', darkTheme: 'dark', lightColors: { primary: '#ff0000' }, darkColors: { primary: '#00ff00' } })));
    const response = await page.goto(`${base}${adminPath}/daisyui-preview?layout=/src/layouts/DaisyPreview.astro&mode=light`);
    assert.match(response.headers()['content-security-policy'], /script-src/);
    assert.equal(response.headers()['cache-control'], 'private, no-store');
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim() === '#ff0000');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await page.getByRole('link', { name: 'Return to Admin' }).getAttribute('href'), adminPath);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.btn-primary')).backgroundColor === 'rgb(255, 0, 0)');
    violations.push(...await page.evaluate(() => window.__cspViolations));
    await page.goto(`${base}${adminPath}/daisyui-preview?layout=/src/layouts/DaisyPreview.astro&mode=dark`);
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim() === '#00ff00');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    violations.push(...await page.evaluate(() => window.__cspViolations));
    assert.deepEqual(violations, []);
    await page.evaluate(() => sessionStorage.removeItem('daisyui-preview-state'));
    await page.goto(`${base}${adminPath}/daisyui-preview?layout=/src/layouts/DaisyPreview.astro&mode=light`);
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim() === '#123456');
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  } finally { await browser.close(); }
});
