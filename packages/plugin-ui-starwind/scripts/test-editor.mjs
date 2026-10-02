// Run only against a built, sanitized local playground with fresh throwaway auth variables.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserOptions } from '../test/render-runtime.mjs';

const base = process.env.STARWIND_E2E_BASE_URL || 'http://127.0.0.1:8793';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Editor regression is local only');
const email = 'starwind-editor@example.com';
const password = 'Starwind-editor-test-2026';
const runId = Date.now().toString(36);
const browser = await chromium.launch(browserOptions());
const page = await browser.newPage({ baseURL: base });
page.setDefaultTimeout(15_000);
page.on('dialog', (dialog) => dialog.accept());
let pageId;
let presetId;
const field = (scope, label) => scope.getByLabel(new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\*?$'));
const write = async (slug, method, click) => {
  const [result] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === method && response.url().includes(`/api/collections/${slug}/entries`)),
    click(),
  ]);
  assert.ok(result.ok(), `${method} ${slug}: ${result.status()} ${await result.text()}`);
  return result.json();
};
const closeInspector = async () => {
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
};
const addBlock = async (name) => {
  await page.getByRole('button', { name: 'Add Block', exact: true }).and(page.locator('[aria-expanded]')).click();
  const picker = page.getByRole('region', { name: 'Block Library' });
  await picker.getByRole('button', { name: new RegExp(name.replace(/[()]/g, '\\$&')) }).click();
  await page.getByRole('dialog').waitFor();
};
const slot = async (name, item) => {
  await page.getByRole('button', { name: `Add to Slot ${name} (block 1)`, exact: true }).click();
  const picker = page.getByRole('region', { name: 'Component Library' });
  await picker.getByRole('button', { name: item }).click();
  await page.getByRole('dialog').waitFor();
};
try {
  await page.goto('/admin');
  const setup = await page.request.get('/admin/api/auth/setup').then((response) => response.json());
  if (setup.required) {
    assert.ok(process.env.STARWIND_E2E_SETUP_TOKEN, 'A fresh playground requires STARWIND_E2E_SETUP_TOKEN');
    await field(page, 'Name').fill('Starwind Test Admin');
    await field(page, 'Email').fill(email);
    await field(page, 'Password').fill(password);
    await field(page, 'Setup token').fill(process.env.STARWIND_E2E_SETUP_TOKEN);
    await page.getByRole('button', { name: 'Create admin', exact: true }).click();
  }
  await page.getByRole('heading', { name: 'Sign in to Talisman CMS' }).waitFor();
  await field(page, 'Email').fill(email);
  await field(page, 'Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();

  await page.goto('/admin/collections/_ui_component_presets/new');
  await field(page, 'Preset Name').fill(`Starwind metric ${runId}`);
  await field(page, 'Library').selectOption({ label: 'Starwind (Talisman compositions)' });
  await field(page, 'Component').selectOption('starwindMetric');
  await field(page, 'Value').fill('73');
  await field(page, 'Label').fill('Reusable metric');
  await field(page, 'Summary').fill('Saved in the editor');
  presetId = (await write('_ui_component_presets', 'POST', () => page.getByRole('button', { name: /^Save(?: Draft)?$/ }).click())).id;
  assert.ok(presetId);
  await page.waitForURL(`**/_ui_component_presets/${presetId}`);

  await page.goto('/admin/collections/pages/new');
  await field(page, 'Page Title').fill(`Starwind page ${runId}`);
  await page.getByRole('button', { name: 'Add Block', exact: true }).and(page.locator('[aria-expanded]')).click();
  const picker = page.getByRole('region', { name: 'Block Library' });
  await picker.getByRole('textbox', { name: 'Search blocks' }).fill('starwind');
  assert.equal(await picker.getByRole('button').count(), 2, 'only the two shipped blocks are offered');
  await picker.getByRole('textbox', { name: 'Search blocks' }).press('Escape');
  assert.equal(await page.locator(':focus').textContent().then((text) => text.trim()), 'Add Block');
  await addBlock('Split Feature (custom)');
  const inspector = page.getByRole('dialog');
  await field(inspector, 'Title').fill('Editor feature');
  await field(inspector, 'Description').fill('Custom compositions are clearly labelled.');
  await field(inspector, 'Media URL').fill('/fixture.svg');
  await field(inspector, 'Image description (leave empty for decorative images)').fill('An editor supplied description');
  await closeInspector();

  await page.getByRole('button', { name: 'Add to Slot Links (block 1)', exact: true }).click();
  const linksPicker = page.getByRole('region', { name: 'Component Library' });
  if (await linksPicker.getByRole('button', { name: new RegExp(`Starwind metric ${runId}`) }).count()) {
    console.log('CORE PICKER ISSUE: the Links slot offers a metric preset; this belongs to the shared core editor workstream.');
  }
  await linksPicker.getByRole('button', { name: /Text Link \(custom\)/ }).click();
  await field(inspector, 'Label').fill('Read more');
  await field(inspector, 'URL').fill('/collection');
  await closeInspector();

  await slot('Metrics', /Metric Stat \(custom\)/);
  await field(inspector, 'Value').fill('24');
  await field(inspector, 'Label').fill('Inline metric');
  await closeInspector();
  await slot('Metrics', new RegExp(`Starwind metric ${runId}`));
  await closeInspector();
  await addBlock('Metrics Band (custom)');
  await field(inspector, 'Title').fill('Editor metrics');
  await closeInspector();

  pageId = (await write('pages', 'POST', () => page.getByRole('button', { name: /^Save(?: Draft)?$/ }).click())).id;
  assert.ok(pageId);
  await page.waitForURL(`**/pages/${pageId}`);
  await page.reload();
  await page.getByRole('button', { name: /Edit Split Feature \(custom\)/ }).waitFor();
  const saved = await page.request.get(`/admin/api/collections/pages/entries/${pageId}`).then((response) => response.json());
  const data = typeof saved.data === 'string' ? JSON.parse(saved.data) : saved.data;
  assert.deepEqual(data.layout.map((block) => block.blockType), ['starwindSplitFeature', 'starwindMetricsBand']);
  assert.equal(data.layout[0].mediaAlt, 'An editor supplied description');
  assert.equal(data.layout[0].links[0].componentType, 'starwindTextLink');
  assert.equal(data.layout[0].metrics[0].value, '24');
  assert.equal(data.layout[0].metrics[1].presetId, presetId);
  console.log('Starwind editor: both blocks, both inline components, labelled image description, saved metric preset, block search, keyboard close and persistence passed.');
} catch (error) {
  console.error((await page.locator('body').innerText()).slice(-2500));
  throw error;
} finally {
  if (pageId) await page.request.delete(`/admin/api/collections/pages/entries/${pageId}`);
  if (presetId) await page.request.delete(`/admin/api/collections/_ui_component_presets/entries/${presetId}`);
  await browser.close();
}
