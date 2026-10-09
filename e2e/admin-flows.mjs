#!/usr/bin/env node
// Browser checks for the admin SPA. Drives Google Chrome through playwright-core against a running
// playground build (astro preview / wrangler dev) and writes a JSON report. No test runner: every step
// is a function below, steps run in order, a failure does not stop the run, and the process exits
// non-zero when a step that is not a known gap fails.
//
//   node e2e/admin-flows.mjs --base-url http://127.0.0.1:8787 --setup-token <token> \
//     --dist playground/dist --report /tmp/admin-flows.json
//
// Options (flag, or environment variable):
//   --base-url <url>         TALISMAN_E2E_BASE_URL        default http://127.0.0.1:8787
//   --setup-token <token>    TALISMAN_E2E_SETUP_TOKEN     used only while the first admin has to be created
//   --admin-email <email>    TALISMAN_E2E_ADMIN_EMAIL     default e2e-admin@example.com
//   --admin-password <pw>    TALISMAN_E2E_ADMIN_PASSWORD  default: a fixed 23-character test password
//   --report <path>          TALISMAN_E2E_REPORT          JSON report (steps, chunks, startup samples, startedAt, baseUrl)
//   --dist <dir>             TALISMAN_E2E_DIST            playground dist dir: every .js file with its size
//   --artifacts <dir>        TALISMAN_E2E_ARTIFACTS       screenshots of failed steps
//   --only <step,...>                                     run these steps (sign-in always runs first)
//   --auth-mode <mode>       local (default), or hybrid-editor with an existing editor account
//   --headed                                              show the browser, slowed down a little
//   --help
//
// The gift-card workflow needs a fresh throwaway TALISMAN_COMMERCE_GIFT_CARD_KEY (64 hex characters)
// in the local playground bindings. CI creates it alongside the temporary auth secrets.
//
// Steps listed in KNOWN_GAPS are reported with status "fail" and knownGap: true and do not affect
// the exit code; they are printed as GAP.

import { chromium } from 'playwright-core';
import { ordersFlow } from './orders-flow.mjs';
import { giftCardFlow } from './gift-card-flow.mjs';
import { promotionsFlow } from './promotions-flow.mjs';
import { deflateSync } from 'node:zlib';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_ADMIN_EMAIL = 'e2e-admin@example.com';
// Test fixtures only (the repository's tests use example.com addresses the same way).
const DEFAULT_ADMIN_PASSWORD = 'E2E-admin-password-2026';
const EDITOR_PASSWORD = 'E2E-editor-password-2026';
const ADMIN_PATH = '/admin';
const ACTION_TIMEOUT_MS = 15_000;
const STEP_TIMEOUT_MS = 150_000;
// Empty: every flow passes on main. List a step here only while a known gap is open.
const KNOWN_GAPS = new Set();

// ---------------------------------------------------------------------------------------------------
// Options

function readOptions(argv) {
  const options = {
    baseUrl: process.env.TALISMAN_E2E_BASE_URL || DEFAULT_BASE_URL,
    setupToken: process.env.TALISMAN_E2E_SETUP_TOKEN || '',
    adminEmail: process.env.TALISMAN_E2E_ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL,
    adminPassword: process.env.TALISMAN_E2E_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD,
    report: process.env.TALISMAN_E2E_REPORT || '',
    dist: process.env.TALISMAN_E2E_DIST || '',
    artifacts: process.env.TALISMAN_E2E_ARTIFACTS || '',
    only: null,
    authMode: 'local',
    headed: false,
    help: false,
  };
  const valueFlags = {
    '--base-url': 'baseUrl',
    '--setup-token': 'setupToken',
    '--admin-email': 'adminEmail',
    '--admin-password': 'adminPassword',
    '--report': 'report',
    '--dist': 'dist',
    '--artifacts': 'artifacts',
    '--only': 'only',
    '--auth-mode': 'authMode',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inlineValue] = argument.includes('=') ? argument.split(/=(.*)/s) : [argument, undefined];
    if (flag === '--headed') { options.headed = true; continue; }
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (!(flag in valueFlags)) throw new Error(`Unknown option ${flag}. Run with --help for the list.`);
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    options[valueFlags[flag]] = value;
  }
  if (typeof options.only === 'string') {
    options.only = options.only.split(',').map((name) => name.trim()).filter(Boolean);
  }
  if (!['local', 'hybrid-editor'].includes(options.authMode)) throw new Error('--auth-mode must be local or hybrid-editor.');
  if (options.authMode === 'hybrid-editor' && !options.only) options.only = ['hybrid-editor'];
  options.baseUrl = options.baseUrl.replace(/\/+$/, '');
  return options;
}

// The comment block at the top of this file is the help text.
async function printHelp() {
  const text = await fs.readFile(new URL(import.meta.url), 'utf8');
  const lines = [];
  for (const line of text.split('\n').slice(1)) {
    if (!line.startsWith('//')) break;
    lines.push(line.replace(/^\/\/ ?/, ''));
  }
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------------------------------
// Small helpers

class StepError extends Error {}

function fail(message) {
  throw new StepError(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A form control by its label text; the label may end in the required marker "*". */
function labelled(scope, label) {
  return scope.getByLabel(new RegExp(`^${escapeRegExp(label)}\\s*\\*?$`));
}

/** Polls `check` until it returns true; a string it returns is the detail of the last attempt. */
async function waitUntil(describe, check, timeout = ACTION_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let detail = '';
  do {
    let result;
    try {
      result = await check();
    } catch (error) {
      result = firstLine(error);
    }
    if (result === true) return;
    if (typeof result === 'string' && result) detail = result;
    await sleep(150);
  } while (Date.now() < deadline);
  fail(detail ? `${describe} (${detail})` : describe);
}

async function expectVisible(locator, what, timeout = ACTION_TIMEOUT_MS) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
  } catch {
    fail(`${what} did not appear within ${timeout} ms`);
  }
}

async function expectHidden(locator, what, timeout = ACTION_TIMEOUT_MS) {
  await waitUntil(`${what} should not be visible`, async () => {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible()) return 'it is still visible';
    }
    return true;
  }, timeout);
}

async function expectValue(locator, expected, what, timeout = ACTION_TIMEOUT_MS) {
  await waitUntil(`${what} should read "${expected}"`, async () => {
    const value = await locator.inputValue();
    return value === expected ? true : `it reads "${value}"`;
  }, timeout);
}

/** Fails with the alert text when the page shows an error. `ignore` skips alerts whose text matches. */
async function expectNoAlert(page, when, ignore = null) {
  const alerts = page.getByRole('alert');
  const count = await alerts.count();
  const messages = [];
  for (let index = 0; index < count; index += 1) {
    const alert = alerts.nth(index);
    if (!(await alert.isVisible())) continue;
    const text = (await alert.innerText()).replace(/\s+/g, ' ').trim();
    if (ignore && ignore.test(text)) continue;
    if (text) messages.push(text);
  }
  if (messages.length > 0) fail(`${when}: the page shows an error: ${messages.join(' | ')}`);
}

async function visibleText(locator) {
  try {
    return (await locator.first().innerText({ timeout: 1000 })).replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

function firstLine(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n').find((line) => line.trim())?.trim() || 'unknown error';
}

function describeError(error) {
  if (error instanceof StepError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  // Playwright errors carry a multi-line call log; the first line says what timed out.
  const line = firstLine(error);
  const locator = message.match(/waiting for (.+?)(?:\n|$)/)?.[1];
  return locator && !line.includes(locator) ? `${line} (${locator})` : line;
}

function apiPath(pathname) {
  return `${ADMIN_PATH}/api${pathname}`;
}

/** Matches a response to `method` on the admin API path (a string for an exact path, or a RegExp). */
function apiResponse(method, pathname) {
  return (response) => {
    const request = response.request();
    if (request.method() !== method) return false;
    const responsePath = new URL(response.url()).pathname;
    return pathname instanceof RegExp ? pathname.test(responsePath) : responsePath === pathname;
  };
}

/** Clicks and returns the response the click causes; fails when no such request is sent. */
async function clickAndAwaitResponse(page, locator, match, what, timeout = ACTION_TIMEOUT_MS) {
  const responsePromise = page.waitForResponse(match, { timeout }).catch(() => null);
  await locator.click();
  const response = await responsePromise;
  if (!response) fail(`${what}: the page sent no matching request within ${timeout} ms`);
  return response;
}

async function responseSummary(response) {
  const body = await response.text().catch(() => '');
  return `HTTP ${response.status()}${body ? ` ${body.slice(0, 300)}` : ''}`;
}

// A tiny valid PNG (solid colour), built here so the check needs no fixture file.
function makePng(width, height, [r, g, b, a = 255]) {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc32 = (buffer) => {
    let crc = -1;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([length, typeAndData, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) row.set([r, g, b, a], 1 + x * 4);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function collectChunks(dist) {
  const root = path.resolve(dist);
  const files = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const { size } = await fs.stat(full);
        files.push({ path: path.relative(root, full), bytes: size });
      }
    }
  }
  await walk(root);
  files.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  return { dist: root, fileCount: files.length, totalBytes, largest: files[0] || null, files };
}

const formatBytes = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

// ---------------------------------------------------------------------------------------------------
// Admin UI helpers

function dashboardHeading(page) {
  return page.getByRole('heading', { name: 'Overview' });
}

const EDITOR_HEADINGS = { any: /^(Edit:|New (Entry|Record))/, existing: /^Edit:/, new: /^New (Entry|Record)$/ };

/** The entry editor's h1: "New Entry"/"New Record" for a new entry, "Edit: <label>" for a saved one. */
function editorHeading(page, mode = 'any') {
  return page.getByRole('heading', { level: 1, name: EDITOR_HEADINGS[mode] });
}

function saveButton(page) {
  return page.getByRole('button', { name: /^(Save Draft|Save Changes|Working\.\.\.)$/ });
}

/** The status badge next to the "Status" (or "State") label in the entry editor. */
function statusBadge(page) {
  return page.locator('label', { hasText: /^(Status|State)$/ }).locator('xpath=following-sibling::*[1]');
}

function entryPath(collectionSlug, entryId, section = 'collections') {
  return `${ADMIN_PATH}/${section}/${collectionSlug}/${entryId}`;
}

/** Waits until a save or publish has settled: the button is back, nothing is marked unsaved, no error. */
async function waitForEditorIdle(page, when) {
  await waitUntil(`${when}: the editor should finish working`, async () => {
    const button = saveButton(page);
    if ((await button.count()) === 0) return 'no save button on the page';
    const text = (await button.first().innerText()).trim();
    if (text === 'Working...') return 'the button still says "Working..."';
    if (!(await button.first().isEnabled())) return 'the save button is still disabled';
    return true;
  });
  await expectHidden(page.getByText('Unsaved changes', { exact: true }), `${when}: the "Unsaved changes" marker`);
  await expectNoAlert(page, when);
}

async function openEntry(page, collectionSlug, entryId, section = 'collections') {
  await page.goto(entryPath(collectionSlug, entryId, section));
  await expectVisible(editorHeading(page, entryId === 'new' ? 'new' : 'existing'), `the editor for ${collectionSlug}/${entryId}`);
  await expectNoAlert(page, `opening ${collectionSlug}/${entryId}`);
}

/** Saves a draft or record and waits for the write to be answered and the editor to settle. */
async function saveEntry(page, collectionSlug, entryId, when) {
  const response = await clickAndAwaitResponse(
    page,
    saveButton(page),
    apiResponse('PUT', apiPath(`/collections/${collectionSlug}/entries/${entryId}`)),
    when
  );
  if (!response.ok()) fail(`${when}: the save was refused with ${await responseSummary(response)}`);
  await waitForEditorIdle(page, when);
  return response;
}

async function signInOnPage(page, email, password, what) {
  await expectVisible(page.getByRole('heading', { name: 'Sign in to Talisman CMS' }), `${what}: the sign-in form`);
  await labelled(page, 'Email').fill(email);
  await labelled(page, 'Password').fill(password);
  const response = await clickAndAwaitResponse(
    page,
    page.getByRole('button', { name: 'Sign in', exact: true }),
    apiResponse('POST', apiPath('/auth/sign-in/email')),
    `${what}: signing in`
  );
  if (!response.ok()) {
    fail(`${what}: signing in as ${email} was refused with ${await responseSummary(response)}. Pass --admin-email and --admin-password of an existing admin, or reset the local database.`);
  }
  await expectVisible(dashboardHeading(page), `${what}: the dashboard after signing in`);
  await expectVisible(page.getByText(email, { exact: true }), `${what}: the signed-in account (${email}) in the header`);
}

/** A fresh browser context with a page that accepts every dialog (confirms and beforeunload prompts). */
async function newSession(ctx, viewport = { width: 1440, height: 1000 }) {
  const context = await ctx.browser.newContext({ baseURL: ctx.options.baseUrl, viewport });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  context.on('page', (page) => page.on('dialog', (dialog) => dialog.accept().catch(() => {})));
  const page = await context.newPage();
  ctx.sessions.push(context);
  return { context, page };
}

async function signedInSession(ctx, email, password, what) {
  const session = await newSession(ctx);
  await session.page.goto(ADMIN_PATH);
  await signInOnPage(session.page, email, password, what);
  return session;
}

/** The entry the entry steps share; created through the API when the UI step did not run. */
async function ensureEntry(ctx) {
  if (ctx.state.entryId) return ctx.state.entryId;
  const title = `E2E post ${ctx.runId}`;
  const response = await ctx.admin.page.request.post(apiPath('/collections/posts/entries'), {
    data: { slug: '', data: { title, views: 0, isPublished: false } },
  });
  if (!response.ok()) fail(`creating a post through the API for this step failed with ${await responseSummary(response)}`);
  const body = await response.json();
  if (!body?.id) fail('creating a post through the API returned no id');
  ctx.state.entryId = body.id;
  ctx.state.entryTitle = title;
  return body.id;
}

async function ensureProduct(ctx) {
  if (ctx.state.productId) return ctx.state.productId;
  const page = ctx.admin.page;
  await page.goto(`${ADMIN_PATH}/commerce/products`);
  await expectVisible(page.getByRole('heading', { level: 1, name: 'Products' }), 'the products list');
  const firstLink = page.getByRole('table').getByRole('row').nth(1).getByRole('link').first();
  await expectVisible(firstLink, 'the first product in the list (is the ecommerce demo seeded?)');
  const productName = (await firstLink.innerText()).trim();
  await firstLink.click();
  await page.waitForURL((url) => /\/admin\/commerce\/products\/[^/?#]+$/.test(url.pathname));
  const productId = page.url().split('/').pop();
  ctx.state.productId = productId;
  ctx.state.productName = productName;
  return productId;
}

/** The card of one variant group: the innermost element with the group's delete button and its inputs. */
function variantGroupCard(page, groupName) {
  return page
    .locator('div')
    .filter({ has: page.getByRole('button', { name: `Delete variant group ${groupName}`, exact: true }) })
    .filter({ has: page.getByLabel('Group Name') })
    .last();
}

function variantValueCard(scope, page, valueLabel) {
  return scope
    .locator('div')
    .filter({ has: page.getByRole('button', { name: `Delete variant value ${valueLabel}`, exact: true }) })
    .filter({ has: page.getByLabel('Stock Quantity') })
    .last();
}

// ---------------------------------------------------------------------------------------------------
// Steps

const steps = {
  async 'sign-in'(ctx) {
    const { options } = ctx;
    const session = await newSession(ctx);
    ctx.admin = session;
    const { page } = session;
    if (options.authMode === 'hybrid-editor') {
      await page.goto(ADMIN_PATH);
      await signInOnPage(page, options.adminEmail, options.adminPassword, 'hybrid editor');
      return `signed in as hybrid editor ${options.adminEmail}`;
    }

    const setupResponse = await page.request.get(apiPath('/auth/setup'));
    if (!setupResponse.ok()) fail(`GET ${apiPath('/auth/setup')} answered ${await responseSummary(setupResponse)}; is the playground serving at ${options.baseUrl}?`);
    const setup = await setupResponse.json();

    await page.goto(ADMIN_PATH);
    if (setup?.required === true) {
      if (!options.setupToken) fail('the first admin has not been created yet; pass --setup-token (or TALISMAN_E2E_SETUP_TOKEN) to create it');
      await expectVisible(page.getByRole('heading', { name: 'Create the first admin' }), 'the setup form');
      await labelled(page, 'Name').fill('E2E Admin');
      await labelled(page, 'Email').fill(options.adminEmail);
      await labelled(page, 'Password').fill(options.adminPassword);
      await labelled(page, 'Setup token').fill(options.setupToken);
      const response = await clickAndAwaitResponse(
        page,
        page.getByRole('button', { name: 'Create admin', exact: true }),
        apiResponse('POST', apiPath('/auth/setup')),
        'creating the first admin'
      );
      if (!response.ok()) fail(`creating the first admin was refused with ${await responseSummary(response)}`);
      ctx.state.createdAdmin = true;
    }
    await signInOnPage(page, options.adminEmail, options.adminPassword, 'admin');
    return ctx.state.createdAdmin ? `created the first admin (${options.adminEmail}) and signed in` : `signed in as ${options.adminEmail}`;
  },

  async 'hybrid-editor'(ctx) {
    const { page } = ctx.admin;
    const response = await page.request.get(apiPath('/auth/session'));
    const session = await response.json();
    if (!session.isHybridAuth || session.user?.role !== 'editor') fail('hybrid fixture must use HybridAuthAdapter and a local editor account');
    await openEntry(page, 'posts', 'new');
    await labelled(page, 'Title').fill(`Hybrid editor draft ${ctx.runId}`);
    await labelled(page, 'Slug (Optional)').fill(`hybrid-editor-${ctx.runId}`);
    const created = await clickAndAwaitResponse(page, saveButton(page), apiResponse('POST', apiPath('/collections/posts/entries')), 'hybrid editor draft');
    if (!created.ok()) fail(`hybrid editor save: ${await responseSummary(created)}`);
    const entry = await created.json();
    await page.waitForURL((url) => url.pathname.endsWith(`/posts/${entry.id}`));
    await expectVisible(editorHeading(page, 'existing'), 'saved hybrid draft');
    if (await page.getByRole('button', { name: /^(Publish|Archive|Delete entry)$/ }).count()) fail('hybrid editor sees an admin-only action');
    const forbidden = await page.request.delete(apiPath(`/collections/posts/entries/${entry.id}`));
    if (forbidden.status() !== 403) fail(`hybrid editor delete answered ${forbidden.status()} instead of 403`);
    await labelled(page, 'Title').fill(`Hybrid editor updated ${ctx.runId}`);
    await saveEntry(page, 'posts', entry.id, 'hybrid editor second draft save');
    if (await page.getByRole('button', { name: 'Sign out of CMS and Cloudflare' }).count()) fail('local hybrid editor sign-out should not end a Cloudflare session');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expectVisible(page.getByRole('button', { name: 'Sign in', exact: true }), 'hybrid editor sign-out');
    return 'local editor signs into hybrid mode, saves twice, cannot delete/publish/archive, and signs out of the CMS';
  },

  'gift-card-workflow': ctx => giftCardFlow(ctx, { fail, expectVisible, expectHidden, expectValue, expectNoAlert, waitUntil }),

  'promotions-workflow': ctx => promotionsFlow(ctx, { fail, expectVisible, expectHidden, expectValue, expectNoAlert, waitUntil }),

  'orders-workflow': ctx => ordersFlow(ctx, { fail, expectVisible, expectHidden, expectValue, expectNoAlert, waitUntil }),

  async 'startup-payload'(ctx) {
    const samples = [];
    const storageState = await ctx.admin.context.storageState();
    for (let run = 0; run < 3; run += 1) {
      const context = await ctx.browser.newContext({ baseURL: ctx.options.baseUrl, storageState });
      try {
        const page = await context.newPage();
        const network = await context.newCDPSession(page);
        await network.send('Network.enable');
        await network.send('Network.setCacheDisabled', { cacheDisabled: true });
        await page.goto(ADMIN_PATH);
        await expectVisible(dashboardHeading(page), 'Overview during startup measurement');
        const readyMs = await page.evaluate(() => performance.now());
        await page.waitForLoadState('networkidle');
        samples.push(await page.evaluate((readyMs) => {
          const scripts = performance.getEntriesByType('resource')
            .filter((resource) => /\.js$/.test(new URL(resource.name).pathname))
            .map((resource) => ({ path: new URL(resource.name).pathname, bytes: resource.decodedBodySize, transferBytes: resource.transferSize }));
          return {
            readyMs,
            domContentLoadedMs: performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd,
            scriptBytes: scripts.reduce((sum, script) => sum + script.bytes, 0),
            transferBytes: scripts.reduce((sum, script) => sum + script.transferBytes, 0),
            scripts,
          };
        }, readyMs));
      } finally { await context.close(); }
    }
    ctx.state.startup = samples;
    const middle = (key) => samples.map(sample => sample[key]).sort((a, b) => a - b)[1];
    return `three cold Overview loads: ${formatBytes(middle('scriptBytes'))} decoded JavaScript, ${Math.round(middle('readyMs'))} ms until Overview visible (medians; local timing)`;
  },

  async 'overview-guidance'(ctx) {
    const { page } = ctx.admin;
    await page.goto(ADMIN_PATH);
    await expectVisible(dashboardHeading(page), 'Overview');
    if (ctx.options.artifacts) { await fs.mkdir(ctx.options.artifacts, { recursive: true }); await page.screenshot({ path: path.join(ctx.options.artifacts, 'overview.png') }); }
    if ((await page.getByText('Cache Hit Rate (KV)', { exact: true }).count()) || (await page.getByText('--', { exact: true }).count())) fail('Overview still contains placeholder metrics');
    await page.getByRole('link', { name: 'Browse collections', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expectVisible(page.getByText('Collections are configured in code.', { exact: false }), 'collection configuration guidance');
    if (await page.getByRole('button', { name: 'New Collection' }).count()) fail('New Collection is still a disabled dead end');
    return 'actionable Overview and code-configured collection guidance are keyboard accessible';
  },

  async 'catalog-loading'(ctx) {
    const page = await ctx.admin.context.newPage();
    const catalogRequests = [];
    const configRequests = [];
    const deferredRequests = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (/\/ui-libraries\.[^/]+\.js/.test(path)) catalogRequests.push(request.url());
      if (/\/config\.[^/]+\.js/.test(path)) configRequests.push(request.url());
      if (/\/(?:fields|CollectionEntriesPage|CollectionSectionPage)\.[^/]+\.js/.test(path)) deferredRequests.push(request.url());
    });
    try {
      await page.goto(ADMIN_PATH);
      await expectVisible(dashboardHeading(page), 'Overview before catalog load');
      if (catalogRequests.length) fail('Overview eagerly loaded the UI component catalog');
      if (configRequests.length) fail('Overview eagerly loaded full editor configuration');
      await page.waitForLoadState('networkidle');
      if (deferredRequests.length) fail('Overview eagerly loaded validation schemas or collection pages');
      await openEntry(page, 'posts', 'new');
      await expectVisible(page.getByRole('textbox', { name: 'Content', exact: true }), 'ordinary editor before catalog load');
      if (catalogRequests.length) fail('ordinary entry editor eagerly loaded the UI component catalog');
      await openEntry(page, '_ui_component_presets', 'new');
      await expectVisible(labelled(page, 'Library'), 'preset authoring after catalog load');
      if (!catalogRequests.length) fail('preset authoring did not load its component catalog');
    } finally { await page.close(); }
    return 'Overview defers editor configuration, validation schemas and collection pages; ordinary editing defers the component catalog until preset authoring needs it';
  },

  async 'collection-search-filters'(ctx) {
    const { page } = ctx.admin;
    const prefix = `Browsing ${ctx.runId}`;
    const ids = [];
    const requests = [];
    const observe = request => {
      const url = new URL(request.url());
      if (url.pathname === apiPath('/collections/posts/entries')) requests.push(url);
    };
    page.on('request', observe);
    const listRows = () => page.locator('tbody').getByRole('link', { name: new RegExp(escapeRegExp(prefix)) });
    const expectPage = async (number, count) => {
      await expectVisible(page.getByRole('status').filter({ hasText: `Page ${number} · ${count} ${count === 1 ? 'entry' : 'entries'} shown` }), `filtered page ${number}`);
      if (await listRows().count() !== count) fail(`page ${number} did not show ${count} matching entries`);
    };
    const apply = () => page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    try {
      for (let index = 0; index < 54; index++) {
        const response = await page.request.post(apiPath('/collections/posts/entries'), { data: { slug: `browse-${ctx.runId}-${index}`, data: { title: `${prefix} item ${String(index).padStart(2, '0')}` } } });
        if (!response.ok()) fail(`creating list fixture: ${await responseSummary(response)}`);
        const entry = await response.json();
        ids.push(entry.id);
        if (index >= 52) {
          const changed = await page.request.post(apiPath(`/collections/posts/entries/${entry.id}/${index === 52 ? 'publish' : 'archive'}`), { data: { expectedRevisionId: entry.latestRevisionId } });
          if (!changed.ok()) fail(`changing list fixture status: ${await responseSummary(changed)}`);
        }
      }
      await page.goto(`${ADMIN_PATH}/collections/posts`);
      await expectVisible(page.getByRole('form', { name: 'Collection filters' }), 'collection filter controls');
      await labelled(page, 'Search Title').fill(prefix);
      await labelled(page, 'Status').selectOption('draft');
      await labelled(page, 'Sort by').selectOption('name');
      await apply();
      await expectPage(1, 50);
      if ((await listRows().first().innerText()).trim() !== `${prefix} item 00`) fail('title sorting did not run before pagination');
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await expectPage(2, 2);
      if (!(await page.getByRole('status').filter({ hasText: 'Page 2 ·' }).evaluate(node => node === document.activeElement))) fail('pagination did not focus the results summary');
      if ((await listRows().first().innerText()).trim() !== `${prefix} item 50`) fail('second page lost its sort or overlaps page one');
      const query = new URL(page.url()).searchParams;
      if (query.get('q') !== prefix || query.get('status') !== 'draft' || query.get('sort') !== 'name' || query.get('page') !== '2') fail('list state was not written into the URL');
      if ((await page.getByRole('button', { name: 'Next page', exact: true }).getAttribute('aria-disabled')) !== 'true') fail('last page still offers another page');
      if (!requests.some(url => url.searchParams.get('where[title][text]') === prefix && url.searchParams.get('where[status]') === 'draft' && url.searchParams.get('sort') === 'title' && url.searchParams.get('offset') === '50')) fail('combined filters did not reach the server on page two');
      await listRows().first().click();
      await expectVisible(editorHeading(page), 'entry opened from filtered page');
      await page.getByRole('link', { name: 'Back to Posts', exact: true }).click();
      await expectPage(2, 2);
      await expectValue(labelled(page, 'Search Title'), prefix, 'search after returning');
      await page.reload();
      await expectPage(2, 2);
      await page.getByRole('button', { name: 'Previous page', exact: true }).click();
      await expectPage(1, 50);
      await page.goBack();
      await expectPage(2, 2);
      await page.getByRole('link', { name: 'Create entry', exact: true }).click();
      await expectVisible(editorHeading(page, 'new'), 'new entry from filtered view');
      await labelled(page, 'Title').fill(`Created from a filtered view ${ctx.runId}`);
      const saved = await clickAndAwaitResponse(page, saveButton(page), apiResponse('POST', apiPath('/collections/posts/entries')), 'saving from filtered view');
      if (!saved.ok()) fail(`filtered create: ${await responseSummary(saved)}`);
      const newEntry = await saved.json();
      ids.push(newEntry.id);
      await page.waitForURL(url => url.pathname.endsWith(`/${newEntry.id}`));
      await expectVisible(editorHeading(page), 'saved entry from filtered view');
      await page.getByRole('link', { name: 'Back to Posts', exact: true }).click();
      await expectPage(2, 2);
      await labelled(page, 'Status').selectOption('published');
      await apply();
      await expectPage(1, 1);
      await expectVisible(listRows().filter({ hasText: 'item 52' }), 'published filter result');
      await labelled(page, 'Status').selectOption('archived');
      await apply();
      await expectPage(1, 1);
      await expectVisible(listRows().filter({ hasText: 'item 53' }), 'archived filter result');
      await labelled(page, 'Search Title').fill(`No match ${ctx.runId}`);
      await apply();
      await expectVisible(page.getByText('No entries match these filters.', { exact: true }), 'filtered empty state');
      if (await page.getByRole('link', { name: 'Create the first entry', exact: true }).count()) fail('filtered empty result is presented as an empty collection');
      const pattern = '**/api/collections/posts/entries?*';
      await page.route(pattern, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'List temporarily unavailable' }) }));
      try {
        await labelled(page, 'Search Title').fill(prefix);
        await apply();
        await expectVisible(page.getByRole('alert').filter({ hasText: 'List temporarily unavailable' }), 'recoverable list error');
        await expectValue(labelled(page, 'Search Title'), prefix, 'search retained after failed load');
      } finally { await page.unroute(pattern); }
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expectPage(1, 1);
      await expectNoAlert(page, 'successful list retry');
      if (ctx.options.artifacts) await page.screenshot({ path: path.join(ctx.options.artifacts, 'collection-filters.png') });
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await waitUntil('filters should clear from URL', async () => !new URL(page.url()).search);
      await expectValue(labelled(page, 'Search Title'), '', 'cleared search');
      // A registered plugin's native collection must use its business status, not CMS draft states.
      await page.goto(`${ADMIN_PATH}/commerce/_ecommerce_orders`);
      await expectVisible(page.getByRole('form', { name: 'Collection filters' }), 'native plugin list filters');
      const statuses = await labelled(page, 'Status').locator('option').evaluateAll(options => options.map(option => option.value));
      if (!statuses.includes('paid') || !statuses.includes('pending') || statuses.includes('archived')) fail('native list received CMS lifecycle statuses');
      await labelled(page, 'Status').selectOption('paid');
      const nativeResponse = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === apiPath('/collections/_ecommerce_orders/entries') && url.searchParams.get('where[status]') === 'paid';
      });
      await apply();
      const nativeFiltered = await nativeResponse;
      if (!nativeFiltered.ok()) fail(`native status query failed: ${await responseSummary(nativeFiltered)}`);
      await waitUntil('native filtered list should settle', async () => !(await page.getByRole('status').filter({ hasText: 'Loading entries' }).count()));
      await expectNoAlert(page, 'native filtered query');
      if (ctx.options.artifacts) await page.screenshot({ path: path.join(ctx.options.artifacts, 'native-collection-filters.png') });
    } finally {
      page.off('request', observe);
      for (const id of ids) await page.request.delete(apiPath(`/collections/posts/entries/${id}`));
    }
    return 'real server search/status/sort before pagination; URL, editor return, reload/back, empty results, retry and native plugin statuses';
  },

  async 'revision-comparison'(ctx) {
    const { page } = ctx.admin;
    const ids = [];
    let reviewer;
    const oldTitle = `Earlier title ${ctx.runId}`;
    const savedTitle = `Saved title ${ctx.runId}`;
    const draftTitle = `Unsaved title ${ctx.runId}`;
    const hostileText = '<img src=x onerror=alert(1)>';
    const rich = (text, bold = false) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text, ...(bold ? { marks: [{ type: 'bold' }] } : {}) }] }] });
    const create = async (slug, data) => {
      const response = await page.request.post(apiPath(`/collections/${slug}/entries`), { data: { data } });
      if (!response.ok()) fail(`revision fixture: ${await responseSummary(response)}`);
      const entry = await response.json(); ids.push([slug, entry.id]); return entry;
    };
    const update = async (slug, entry, data) => {
      const response = await page.request.put(apiPath(`/collections/${slug}/entries/${entry.id}`), { data: { data, expectedRevisionId: entry.latestRevisionId } });
      if (!response.ok()) fail(`revision fixture update: ${await responseSummary(response)}`);
      return response.json();
    };
    const detailRequests = [];
    const observe = request => { if (/\/revisions\/[^/?]+$/.test(new URL(request.url()).pathname)) detailRequests.push(request.url()); };
    page.on('request', observe);
    try {
      const initial = await create('posts', { title: oldTitle, content: rich(hostileText) });
      const saved = await update('posts', initial, { title: savedTitle, content: rich('Saved content', true) });
      await openEntry(page, 'posts', saved.id);
      if (detailRequests.length) fail('revision snapshots load before comparison is opened');
      await labelled(page, 'Title').fill(draftTitle);
      const opener = page.getByRole('button', { name: 'Compare revision 1', exact: true });
      await opener.click();
      const dialog = page.getByRole('dialog', { name: 'Compare revision #1', exact: true });
      await expectVisible(dialog.getByRole('status').filter({ hasText: '2 fields differ.' }), 'changed field summary');
      const title = dialog.getByRole('region', { name: 'Title', exact: true });
      await expectVisible(title.getByText(oldTitle, { exact: true }), 'earlier title');
      await expectVisible(title.getByText(savedTitle, { exact: true }), 'saved title');
      if (await dialog.getByText(draftTitle, { exact: true }).count()) fail('comparison used unsaved form values');
      await expectVisible(dialog.getByText('Your unsaved edits are excluded and remain in the editor.', { exact: false }), 'unsaved comparison explanation');
      await expectVisible(dialog.getByText(hostileText, { exact: true }), 'literal hostile rich text');
      if (await dialog.locator('img, iframe, [contenteditable="true"], textarea').count()) fail('historical content was rendered as HTML or an editable field');
      if (!detailRequests.some(url => new URL(url).pathname.endsWith(`/revisions/${initial.latestRevisionId}`))) fail('selected snapshot was not loaded on demand');
      for (let count = 0; count < 6; count++) {
        await page.keyboard.press('Tab');
        if (!(await dialog.evaluate(node => node.contains(document.activeElement)))) fail('Tab escaped revision preview');
      }
      if (ctx.options.artifacts) await page.screenshot({ path: path.join(ctx.options.artifacts, 'revision-comparison.png') });
      await page.keyboard.press('Escape');
      await expectHidden(dialog, 'closed revision preview');
      if (!(await opener.evaluate(node => node === document.activeElement))) fail('preview close did not restore focus');
      await expectValue(labelled(page, 'Title'), draftTitle, 'unsaved title after comparison');
      const revisionUrl = apiPath(`/collections/posts/entries/${saved.id}/revisions/${initial.latestRevisionId}`);
      await page.route(`**${revisionUrl}`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Preview temporarily unavailable' }) }));
      try {
        await opener.click();
        await expectVisible(dialog.getByRole('alert'), 'recoverable revision fetch error');
        if (!(await dialog.getByRole('alert').evaluate(node => node === document.activeElement))) fail('preview fetch error did not receive focus');
      } finally { await page.unroute(`**${revisionUrl}`); }
      await dialog.getByRole('button', { name: 'Retry preview', exact: true }).click();
      await expectVisible(dialog.getByRole('status').filter({ hasText: '2 fields differ.' }), 'retried snapshot comparison');
      await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
      await expectValue(labelled(page, 'Title'), draftTitle, 'unsaved title after retry');
      // Closing a loading preview aborts it and cannot later overwrite another comparison.
      let release, arrived;
      const gate = new Promise(resolve => { release = resolve; });
      const requested = new Promise(resolve => { arrived = resolve; });
      await page.route(`**${revisionUrl}`, async route => { arrived(); await gate; await route.continue().catch(() => {}); });
      try {
        await opener.click(); await requested;
        await expectVisible(dialog.getByRole('status').filter({ hasText: 'Loading revision' }), 'loading preview');
        await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
      } finally { release(); await page.unroute(`**${revisionUrl}`, { behavior: 'wait' }); }
      await page.getByRole('button', { name: 'Compare revision 2', exact: true }).click();
      const same = page.getByRole('dialog', { name: 'Compare revision #2', exact: true });
      await expectVisible(same.getByText('No content changes between these versions.', { exact: true }), 'unchanged saved snapshot');
      await same.getByRole('checkbox', { name: 'Show unchanged fields', exact: true }).check();
      await expectVisible(same.getByRole('region', { name: 'Title', exact: true }).getByText(savedTitle, { exact: true }).first(), 'unchanged field preview');
      await same.getByRole('button', { name: 'Close preview', exact: true }).click();
      // Existing restore still asks before replacing unsaved work and sends the loaded revision token.
      await page.evaluate(() => { const original = window.confirm; window.confirm = () => { window.confirm = original; return false; }; });
      const restore = page.getByRole('button', { name: 'Restore revision 1', exact: true });
      await restore.click();
      await expectValue(labelled(page, 'Title'), draftTitle, 'cancelled restore retains draft');
      const restoreResponse = await clickAndAwaitResponse(page, restore, apiResponse('POST', `${revisionUrl}/restore`), 'restoring inspected revision');
      if (!restoreResponse.ok()) fail(`restore after comparison: ${await responseSummary(restoreResponse)}`);
      if (restoreResponse.request().postDataJSON().expectedRevisionId !== saved.latestRevisionId) fail('restore discarded its concurrency guard');
      await expectValue(labelled(page, 'Title'), oldTitle, 'restored revision content');
      const readonlyInitial = await create('submissions', { title: oldTitle });
      const readonlySaved = await update('submissions', readonlyInitial, { title: savedTitle });
      const email = `revision-reviewer-${ctx.runId}@example.com`;
      const user = await page.request.post(apiPath('/auth/admin/create-user'), { data: { name: 'Revision reviewer', email, password: EDITOR_PASSWORD, role: 'editor' }, headers: { Origin: ctx.options.baseUrl } });
      if (!user.ok()) fail('could not create revision reviewer');
      reviewer = await signedInSession(ctx, email, EDITOR_PASSWORD, 'revision reviewer');
      await openEntry(reviewer.page, 'submissions', readonlySaved.id);
      if (await reviewer.page.getByRole('button', { name: /^Restore/ }).count()) fail('editor comparison exposes restore');
      await reviewer.page.getByRole('button', { name: 'Compare revision 1', exact: true }).click();
      const readOnlyDialog = reviewer.page.getByRole('dialog', { name: 'Compare revision #1', exact: true });
      await expectVisible(readOnlyDialog.getByRole('status').filter({ hasText: '1 field differs.' }), 'read-only editor comparison');
      if (await readOnlyDialog.getByRole('button', { name: /^Restore/ }).count()) fail('read-only comparison exposes restore');
      await reviewer.page.keyboard.press('Escape');
      // Structured page-builder content is readable without editable builder controls.
      const structured = await create('pages', { title: 'Structured revision', layout: [{ blockType: 'hero', heading: 'Earlier hero' }] });
      const structuredSaved = await update('pages', structured, { title: 'Structured revision', layout: [{ blockType: 'hero', heading: 'Saved hero' }] });
      await openEntry(page, 'pages', structuredSaved.id);
      await page.getByRole('button', { name: 'Compare revision 1', exact: true }).click();
      const blocks = page.getByRole('dialog', { name: 'Compare revision #1', exact: true });
      await expectVisible(blocks.getByText('Earlier hero', { exact: true }), 'historical structured field');
      await expectVisible(blocks.getByText('Saved hero', { exact: true }), 'saved structured field');
      if (ctx.options.artifacts) await page.screenshot({ path: path.join(ctx.options.artifacts, 'revision-block-comparison.png') });
      await blocks.getByRole('button', { name: 'Close preview', exact: true }).click();
    } finally {
      page.off('request', observe);
      for (const [slug, id] of ids) await page.request.delete(apiPath(`/collections/${slug}/entries/${id}`));
      if (reviewer) { await reviewer.context.close(); ctx.sessions = ctx.sessions.filter(session => session !== reviewer.context); }
    }
    return 'lazy saved-snapshot comparison; unchanged/structured/rich text fields; draft preservation, focus, retry/cancellation, read-only editor access and guarded admin restore';
  },

  async 'confirmed-deletion'(ctx) {
    const { page } = ctx.admin;
    const created = await page.request.post(apiPath('/collections/posts/entries'), { data: { slug: `delete-${ctx.runId}`, data: { title: 'Delete regression fixture' } } });
    if (!created.ok()) fail(`creating deletion fixture: ${await responseSummary(created)}`);
    const entry = await created.json();
    const entryUrl = apiPath(`/collections/posts/entries/${entry.id}`);
    await openEntry(page, 'posts', entry.id);
    await labelled(page, 'Title').fill('Unsaved deletion draft');
    const opener = page.getByRole('button', { name: 'Delete entry', exact: true });
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Delete entry?', exact: true });
    await expectVisible(dialog, 'delete confirmation');
    if (ctx.options.artifacts) await page.screenshot({ path: path.join(ctx.options.artifacts, 'deletion.png') });
    await expectVisible(dialog.getByText('Your unsaved changes will also be discarded.', { exact: false }), 'unsaved changes warning');
    if (!(await dialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate((node) => node === document.activeElement))) fail('deletion did not start on Cancel');
    await page.keyboard.press('Escape');
    await expectHidden(dialog, 'cancelled dialog');
    if (!(await opener.evaluate((node) => node === document.activeElement))) fail('cancel did not return focus');
    await expectValue(labelled(page, 'Title'), 'Unsaved deletion draft', 'draft after cancel');
    const refuse = async (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Deletion refused for this regression test' }) });
    await page.route(`**${entryUrl}`, async (route) => route.request().method() === 'DELETE' ? refuse(route) : route.continue());
    try {
      await opener.click();
      await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click();
      await expectVisible(dialog.getByRole('alert'), 'deletion error');
      if (!(await dialog.getByRole('alert').evaluate((node) => node === document.activeElement))) fail('delete error did not take focus');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expectValue(labelled(page, 'Title'), 'Unsaved deletion draft', 'draft after failed delete');
    } finally { await page.unroute(`**${entryUrl}`); }
    await opener.click();
    const deleted = await clickAndAwaitResponse(page, dialog.getByRole('button', { name: 'Delete permanently', exact: true }), apiResponse('DELETE', entryUrl), 'confirmed deletion');
    if (!deleted.ok()) fail(`delete: ${await responseSummary(deleted)}`);
    await page.waitForURL((url) => /\/collections\/posts\/?$/.test(url.pathname));
    const missing = await page.request.get(entryUrl);
    if (missing.status() !== 404) fail(`deleted entry still answers ${missing.status()}`);
    return 'Cancel/Escape restore focus; failed deletion retains draft; confirmed deletion removes entry and opens list';
  },

  async 'session-expiry-preserves-draft'(ctx) {
    const { page } = ctx.admin;
    const entryId = await ensureEntry(ctx);
    await openEntry(page, 'posts', entryId);
    const draft = `Expired-session draft ${ctx.runId}`;
    await labelled(page, 'Title').fill(draft);
    const url = apiPath(`/collections/posts/entries/${entryId}`);
    await page.route(`**${url}`, (route) => route.request().method() === 'PUT'
      ? route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }) : route.continue());
    try {
      await page.getByRole('button', { name: 'Save Draft', exact: true }).click();
      const error = page.getByRole('alert').filter({ hasText: 'Your session has expired.' });
      await expectVisible(error, 'expired-session recovery message');
      await expectValue(labelled(page, 'Title'), draft, 'draft after session expiry');
      if (!(await error.evaluate((node) => node === document.activeElement))) fail('session error did not take focus');
    } finally { await page.unroute(`**${url}`); }
    await saveEntry(page, 'posts', entryId, 'retrying after session recovery');
    return 'HTTP 401 keeps edits, focuses recovery guidance, and permits a successful retry';
  },

  async 'relationship-search-pagination'(ctx) {
    const { page } = ctx.admin;
    // Fixture API pages deliberately put the selected record outside the first page.
    const all = Array.from({ length: 35 }, (_, index) => ({ id: `relation-${index}`, data: { name: `Author ${String(index).padStart(2, '0')}` } }));
    const requests = [];
    const pattern = '**/api/collections/authors/entries**';
    await page.route(pattern, async (route) => {
      const url = new URL(route.request().url());
      requests.push(url);
      const id = url.pathname.split('/entries/')[1];
      if (id) return route.fulfill({ json: all.find((entry) => entry.id === id) });
      if (url.searchParams.get('limit') !== '30') fail('relationship read is not bounded to 30');
      const text = url.searchParams.get('where[name][text]');
      const docs = text ? all.filter((entry) => entry.data.name.toLowerCase().includes(text.toLowerCase())) : all;
      const offset = url.searchParams.get('cursor') ? 30 : 0;
      return route.fulfill({ json: { docs: docs.slice(offset, offset + 30), nextCursor: docs.length > offset + 30 ? 'next-authors' : null } });
    });
    try {
      await openEntry(page, 'posts', 'new');
      const options = page.getByRole('group', { name: 'Author options', exact: true });
      await expectVisible(options.getByRole('button', { name: /Author 00/ }), 'first relation page');
      if (requests.filter((url) => !url.pathname.includes('/entries/')).length !== 1) fail('relationship picker eagerly read more than one page');
      await page.getByRole('button', { name: 'Load more Author options', exact: true }).focus();
      await page.keyboard.press('Enter');
      const target = options.getByRole('button', { name: /Author 34/ });
      await expectVisible(target, 'second-page option');
      await target.click();
      await labelled(page, 'Search Author').fill('Author 00');
      await waitUntil('relationship query should reach the server', () => requests.some((url) => url.searchParams.get('where[name][text]') === 'Author 00'));
      await expectVisible(options.getByRole('button', { name: /Author 00/ }), 'server search result');
      await expectHidden(options.getByRole('button', { name: /Author 34/ }), 'unmatched option');
      await expectVisible(page.getByRole('button', { name: 'Remove Author 34', exact: true }), 'selected label outside current search page');
      if (!requests.some((url) => url.searchParams.get('where[name][text]') === 'Author 00')) fail('query never reached server');
      await page.getByRole('button', { name: 'Remove Author 34', exact: true }).click();
      if (!(await labelled(page, 'Search Author').evaluate((node) => node === document.activeElement))) fail('removal did not return focus to search');
      // Reset the unsaved test form before the next flow.
      await page.reload();
    } finally { await page.unroute(pattern); }
    return 'one initial page, keyboard pagination, server search, retained selected labels and removal focus';
  },

  async 'relationship-server-search'(ctx) {
    const { page } = ctx.admin;
    const ids = [];
    let postId;
    const name = `Selected author ${ctx.runId}`;
    try {
      for (let index = 0; index < 35; index += 1) {
        const response = await page.request.post(apiPath('/collections/authors/entries'), { data: { slug: `search-${ctx.runId}-${index}`, data: { name: index === 0 ? name : `Unmatched author ${ctx.runId}-${index}` } } });
        if (!response.ok()) fail(`creating search fixture: ${await responseSummary(response)}`);
        ids.push((await response.json()).id);
      }
      const created = await page.request.post(apiPath('/collections/posts/entries'), { data: { slug: `selected-${ctx.runId}`, data: { title: 'Saved relationship search fixture', author: ids[0] } } });
      if (!created.ok()) fail(`creating selected-label fixture: ${await responseSummary(created)}`);
      postId = (await created.json()).id;
      await openEntry(page, 'posts', postId);
      await expectVisible(page.getByRole('button', { name: `Remove ${name}`, exact: true }), 'saved selected label outside the first page');
      await labelled(page, 'Search Author').fill(name);
      const options = page.getByRole('group', { name: 'Author options', exact: true });
      await expectVisible(options.getByRole('button', { name: new RegExp(escapeRegExp(name)) }), 'real server match beyond the initial page');
      await expectNoAlert(page, 'real bounded relationship search');
      if (await options.getByRole('button', { name: /Unmatched author/ }).count()) fail('server search returned unrelated entries');
      if (ctx.options.artifacts) await page.screenshot({ path: path.join(ctx.options.artifacts, 'relationship-search.png') });
    } finally {
      if (postId) await page.request.delete(apiPath(`/collections/posts/entries/${postId}`));
      for (const id of ids) await page.request.delete(apiPath(`/collections/authors/entries/${id}`));
    }
    return 'real server filtering finds a record beyond page one; saved selection labels load independently by ID';
  },

  async 'nested-inspector-error-focus'(ctx) {
    const { page } = ctx.admin;
    const created = await page.request.post(apiPath('/collections/pages/entries'), { data: {
      slug: `inspector-${ctx.runId}`, data: { title: 'Inspector regression fixture', layout: [0, 1].map((index) => ({ blockType: 'sectionLayout', title: `Section ${index}`, content: [{ mode: 'inline', componentType: 'daisyAlertNotice', title: `Notice ${index}`, tone: 'info' }] })) },
    } });
    if (!created.ok()) fail(`creating inspector fixture: ${await responseSummary(created)}`);
    const entry = await created.json();
    const url = apiPath(`/collections/pages/entries/${entry.id}`);
    await openEntry(page, 'pages', entry.id);
    await expectVisible(page.getByRole('button', { name: 'Collapse Section Layout (block 1) in Page Layout', exact: true }), 'uniquely named block control');
    await expectVisible(page.getByRole('button', { name: 'Collapse Alert Notice (Content item 1, block 2)', exact: true }), 'uniquely named nested item control');
    await page.route(`**${url}`, (route) => route.request().method() === 'PUT' ? route.fulfill({ status: 400, json: {
      error: 'Nested fields need attention', fieldErrors: { 'layout[0].title': ['Fix section title'], 'layout[1].content[0].title': ['Fix notice title'] },
    } }) : route.continue());
    try {
      await page.getByRole('button', { name: 'Save Draft', exact: true }).click();
      const summary = page.locator('ul[role="alert"]');
      await expectVisible(summary, 'nested error summary');
      if (!(await summary.evaluate((node) => node === document.activeElement))) fail('nested error summary did not take focus');
      await summary.getByRole('button').first().click();
      let dialog = page.getByRole('dialog', { name: /Inspector/ });
      await expectVisible(dialog, 'block inspector from summary');
      await waitUntil('block title should take focus', () => labelled(dialog, 'Title').evaluate((node) => node === document.activeElement));
      await page.keyboard.press('Escape');
      await summary.getByRole('button').last().click();
      await expectVisible(dialog, 'component inspector from summary');
      await waitUntil('component title should take focus', () => labelled(dialog, 'Title').evaluate((node) => node === document.activeElement));
      await expectValue(labelled(dialog, 'Title'), 'Notice 1', 'nested component value after failed save');
      if (ctx.options.artifacts) await page.screenshot({ path: path.join(ctx.options.artifacts, 'inspector.png') });
      await page.keyboard.press('Escape');
    } finally {
      await page.unroute(`**${url}`);
      await page.request.delete(url);
    }
    return 'error summary focuses itself, opens closed block/component inspectors, and focuses the correct nested control';
  },

  async 'preset-error-focus'(ctx) {
    const { page } = ctx.admin;
    await openEntry(page, '_ui_component_presets', 'new');
    await labelled(page, 'Preset Name').fill('Error focus preset fixture');
    await labelled(page, 'Library').selectOption('daisyui');
    await labelled(page, 'Component').selectOption('daisyAlertNotice');
    await labelled(page, 'Title').fill('Keep this preset title');
    const url = apiPath('/collections/_ui_component_presets/entries');
    await page.route(`**${url}`, (route) => route.request().method() === 'POST' ? route.fulfill({ status: 400, json: {
      error: 'Preset field needs attention', fieldErrors: { 'propsJson.title': ['Fix preset title'] },
    } }) : route.continue());
    try {
      await saveButton(page).click();
      const summary = page.locator('ul[role="alert"]');
      await expectVisible(summary, 'preset error summary');
      await summary.getByRole('button').click();
      if (!(await labelled(page, 'Title').evaluate((node) => node === document.activeElement))) fail('preset summary did not focus its rendered prop');
      await expectValue(labelled(page, 'Title'), 'Keep this preset title', 'preset value after failed save');
      if (ctx.options.artifacts) await page.screenshot({ path: path.join(ctx.options.artifacts, 'preset.png') });
    } finally {
      await page.unroute(`**${url}`);
      await page.reload();
    }
    return 'serialized preset errors map to rendered prop controls and retain unsaved values';
  },

  async 'strict-csp-richtext'(ctx) {
    const { page } = ctx.admin;
    const violations = [];
    const listener = (message) => { if (/Content Security Policy.*style|Refused to apply inline style|Applying inline style violates/i.test(message.text())) violations.push(message.text()); };
    page.on('console', listener);
    try {
      await openEntry(page, 'posts', await ensureEntry(ctx));
      const textbox = page.getByRole('textbox', { name: 'Content', exact: true });
      await expectVisible(textbox, 'rich text under strict CSP');
      await textbox.fill('Strict CSP editor fixture');
      await page.getByRole('button', { name: 'Bold', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      if (!(await page.getByRole('button', { name: 'Italic', exact: true }).evaluate((node) => node === document.activeElement))) fail('rich-text toolbar keyboard navigation failed');
      if (await page.locator('style[data-tiptap-style]').count()) fail('Tiptap still injects inline CSS');
      if (violations.length) fail(`strict CSP rejected styles: ${violations.join(' | ')}`);
      await saveEntry(page, 'posts', ctx.state.entryId, 'saving rich text under CSP');
    } finally { page.off('console', listener); }
    return 'rich text edits and toolbar navigation work without injected styles or CSP style violations';
  },

  async 'new-entry-collapsed-cards'(ctx) {
    const page = await ctx.admin.context.newPage();
    let entryId;
    const draftKey = 'talisman-cms:collapsed:collection:pages:new';
    try {
      await page.goto(entryPath('pages', 'new'));
      await expectVisible(editorHeading(page, 'new'), 'new page editor');
      await page.getByRole('button', { name: 'Switch to Raw JSON', exact: true }).click();
      await page.getByRole('textbox', { name: 'Raw JSON', exact: true }).fill(JSON.stringify({
        title: `Collapsed cards ${ctx.runId}`,
        layout: [0, 1].map(index => ({ blockType: 'sectionLayout', title: `Section ${index}`, content: [
          { mode: 'inline', componentType: 'daisyAlertNotice', title: `Notice ${index}`, tone: 'info' },
        ] })),
      }));
      await page.getByRole('button', { name: 'Switch to Form', exact: true }).click();
      const block = page.getByRole('button', { name: 'Collapse Section Layout (block 1) in Page Layout', exact: true });
      const component = page.getByRole('button', { name: 'Collapse Alert Notice (Content item 1, block 2)', exact: true });
      await component.click(); await block.click();
      await waitUntil('new page preferences should be stored', async () => Boolean(await page.evaluate(key => localStorage.getItem(key), draftKey)));
      const created = await clickAndAwaitResponse(page, saveButton(page), apiResponse('POST', apiPath('/collections/pages/entries')), 'first page save');
      if (!created.ok()) fail(`collapsed page fixture save: ${await responseSummary(created)}`);
      entryId = (await created.json()).id;
      await expectVisible(editorHeading(page, 'existing'), 'saved page editor');
      const expandBlock = page.getByRole('button', { name: 'Expand Section Layout (block 1) in Page Layout', exact: true });
      const expandComponent = page.getByRole('button', { name: 'Expand Alert Notice (Content item 1, block 2)', exact: true });
      await expectVisible(expandBlock, 'block collapsed after first save');
      await expectVisible(expandComponent, 'component collapsed after first save');
      if (await page.evaluate(key => localStorage.getItem(key), draftKey)) fail('first save left collapsed preferences on the next new entry');
      await page.reload();
      await expectVisible(expandBlock, 'saved block collapse after reload');
      await expectVisible(expandComponent, 'saved component collapse after reload');
      await page.goto(entryPath('pages', 'new'));
      await expectVisible(editorHeading(page, 'new'), 'second new page');
      if (await page.evaluate(key => localStorage.getItem(key), draftKey)) fail('fresh new page inherited the previous page card state');
      return 'collapsed block and nested component survive first save and reload; draft storage moves to the saved ID';
    } finally {
      if (entryId) {
        const response = await page.request.delete(apiPath(`/collections/pages/entries/${entryId}`), { headers: { Origin: ctx.options.baseUrl } });
        if (!response.ok() && response.status() !== 404) fail(`collapsed fixture cleanup: ${await responseSummary(response)}`);
      }
      await page.close();
    }
  },

  async 'new-entry-saves-twice'(ctx) {
    const { page } = ctx.admin;
    const title = `E2E post ${ctx.runId}`;
    const secondTitle = `${title} v2`;

    await page.goto(entryPath('posts', 'new'));
    await expectVisible(page.getByRole('heading', { level: 1, name: 'New Entry' }), 'the new post editor');
    const titleInput = labelled(page, 'Title');
    await titleInput.fill(title);
    const created = await clickAndAwaitResponse(
      page,
      saveButton(page),
      apiResponse('POST', apiPath('/collections/posts/entries')),
      'saving the new post'
    );
    if (!created.ok()) fail(`saving the new post was refused with ${await responseSummary(created)}`);

    // The editor opens the saved entry at its own URL.
    try {
      await page.waitForURL((url) => /\/admin\/collections\/posts\/(?!new(?:$|[/?#]))[^/?#]+$/.test(url.pathname), { timeout: ACTION_TIMEOUT_MS });
    } catch {
      fail(`after the first save the URL stayed at ${page.url()} instead of moving to the new entry's id`);
    }
    const entryId = page.url().split('/').pop();
    ctx.state.entryId = entryId;
    ctx.state.entryTitle = title;
    // The route remounts the editor for the saved entry: wait for that instance, not the "New Entry" one,
    // or the next edits land in a form that is about to be replaced.
    await expectVisible(editorHeading(page, 'existing'), 'the editor of the created post');
    await expectHidden(editorHeading(page, 'new'), 'the "New Entry" heading');
    await waitForEditorIdle(page, 'after the first save');
    await expectValue(labelled(page, 'Title'), title, 'the Title after the first save');

    await labelled(page, 'Title').fill(secondTitle);
    await saveEntry(page, 'posts', entryId, 'the second save');
    ctx.state.entryTitle = secondTitle;

    await page.reload();
    await expectVisible(editorHeading(page), 'the editor after reloading');
    await expectValue(labelled(page, 'Title'), secondTitle, 'the Title after reloading');
    await expectVisible(page.getByText('Revision #2', { exact: true }), 'the second revision in the history');
    await expectNoAlert(page, 'after reloading');
    const status = await visibleText(statusBadge(page));
    if (status !== 'Draft') fail(`after two saves the status reads "${status}" instead of "Draft"`);
    return `entry ${entryId}: two saves, URL left "new", both revisions on the record`;
  },

  async 'publish'(ctx) {
    const { page } = ctx.admin;
    const entryId = await ensureEntry(ctx);
    await openEntry(page, 'posts', entryId);

    const publishButton = page.getByRole('button', { name: 'Publish', exact: true });
    await expectVisible(publishButton, 'the Publish button (admin)');
    const response = await clickAndAwaitResponse(
      page,
      publishButton,
      apiResponse('POST', apiPath(`/collections/posts/entries/${entryId}/publish`)),
      'publishing'
    );
    if (!response.ok()) fail(`publishing was refused with ${await responseSummary(response)}`);
    const pending = response.status() === 202;

    await waitUntil('the status badge should read "Published"', async () => {
      const text = await visibleText(statusBadge(page));
      return text === 'Published' ? true : `it reads "${text}"`;
    }, pending ? 45_000 : ACTION_TIMEOUT_MS);
    await expectNoAlert(page, 'after publishing');

    await page.reload();
    await expectVisible(editorHeading(page), 'the editor after reloading');
    const status = await visibleText(statusBadge(page));
    if (status !== 'Published') fail(`after reloading the status reads "${status}" instead of "Published"`);
    return pending ? 'published through a pending workflow (HTTP 202); status Published after reload' : 'published; status Published after reload';
  },

  async 'collection-permissions'(ctx) {
    const page = ctx.admin.page;
    const email = `e2e-permissions-${ctx.runId}@example.com`;
    const createdUser = await page.request.post(apiPath('/auth/admin/create-user'), {
      data: { name: 'Collection permission fixture', email, password: EDITOR_PASSWORD, role: 'editor' },
      headers: { Origin: ctx.options.baseUrl },
    });
    if (!createdUser.ok()) fail(`permission editor account: ${await responseSummary(createdUser)}`);
    const editor = await signedInSession(ctx, email, EDITOR_PASSWORD, 'collection permissions editor');
    const ids = {};
    const assertNoActions = async (target) => {
      if (await target.getByRole('button', { name: /^(Save Draft|Save Changes|Publish|Archive|Delete entry|Restore)/ }).count()) {
        fail('a read-only editor exposes a write action');
      }
      if (!await labelled(target, 'Title').isDisabled()) fail('read-only fields accept keyboard editing');
      const richText = target.getByRole('textbox', { name: 'Content', exact: true });
      if (await richText.count()) {
        await waitUntil('rich text is read-only', async () => await richText.getAttribute('contenteditable') === 'false');
        if (await richText.getAttribute('aria-readonly') !== 'true') fail('rich text is not announced as read-only');
      }
    };
    try {
      for (const slug of ['announcements', 'submissions']) {
        const response = await page.request.post(apiPath(`/collections/${slug}/entries`), { data: { data: { title: `${slug} fixture` } } });
        if (!response.ok()) fail(`permission fixture ${slug}: ${await responseSummary(response)}`);
        ids[slug] = (await response.json()).id;
      }
      await editor.page.goto(`${ADMIN_PATH}/collections/announcements`);
      await expectVisible(editor.page.getByRole('heading', { name: 'Announcements', exact: true }), 'restricted create list');
      if (await editor.page.getByRole('link', { name: /^Create/ }).count()) fail('editor sees restricted Create link');
      await expectVisible(editor.page.getByText('Only administrators can create entries in this collection.', { exact: true }), 'restricted create explanation');
      await openEntry(editor.page, 'announcements', 'new');
      await assertNoActions(editor.page);
      const deniedCreate = await editor.page.request.post(apiPath('/collections/announcements/entries'), { data: { data: { title: 'Forbidden' } } });
      if (deniedCreate.status() !== 403) fail('server allowed restricted editor creation');
      // An editor denied create still has update access to an existing announcement.
      await openEntry(editor.page, 'announcements', ids.announcements);
      await labelled(editor.page, 'Title').fill('Edited announcement');
      await saveEntry(editor.page, 'announcements', ids.announcements, 'permitted announcement update');
      if (await editor.page.getByRole('button', { name: /^(Publish|Archive|Delete entry|Restore)/ }).count()) fail('editor sees admin-only actions');

      await openEntry(editor.page, 'submissions', 'new');
      await labelled(editor.page, 'Title').fill('Editor submission');
      const submitted = await clickAndAwaitResponse(editor.page, saveButton(editor.page), apiResponse('POST', apiPath('/collections/submissions/entries')), 'permitted submission creation');
      if (!submitted.ok()) fail(`editor submission: ${await responseSummary(submitted)}`);
      const submissionId = (await submitted.json()).id;
      ids.editorSubmission = submissionId;
      await editor.page.waitForURL(url => url.pathname.endsWith(`/submissions/${submissionId}`));
      await expectVisible(editorHeading(editor.page, 'existing'), 'created submission becomes read-only');
      await assertNoActions(editor.page);
      await expectVisible(editor.page.getByText('You can view this entry. Only administrators can save changes in this collection.', { exact: true }), 'restricted update explanation');
      const deniedUpdate = await editor.page.request.put(apiPath(`/collections/submissions/entries/${submissionId}`), { data: { data: { title: 'Forbidden' } } });
      if (deniedUpdate.status() !== 403) fail('server allowed restricted editor update');
      // Admins retain the draft, publication and revision actions for these role-restricted collections.
      await openEntry(page, 'submissions', ids.submissions);
      for (const name of ['Save Draft', 'Publish', 'Archive', 'Delete entry']) {
        await expectVisible(page.getByRole('button', { name, exact: true }), `admin ${name}`);
      }
      await expectVisible(page.getByRole('button', { name: /^Restore/ }).first(), 'admin revision restore');
      await labelled(page, 'Title').fill('Admin revised submission');
      await saveEntry(page, 'submissions', ids.submissions, 'admin restricted collection update');
      for (const target of [page, editor.page]) {
        await target.goto(`${ADMIN_PATH}/collections/managed-notes`);
        await expectVisible(target.getByRole('heading', { name: 'Managed Notes', exact: true }), 'managed list');
        if (await target.getByRole('link', { name: /^Create/ }).count()) fail('managed list exposes Create');
        await openEntry(target, 'managed-notes', 'demo_managed_note');
        await assertNoActions(target);
        await expectVisible(target.getByText('This collection is managed by server code and is read-only in the CMS.', { exact: true }), 'managed explanation');
        const denied = await target.request.put(apiPath('/collections/managed-notes/entries/demo_managed_note'), { data: { data: { title: 'Forbidden' } } });
        if (denied.status() !== 403) fail('server allowed staff write to managed collection');
        await openEntry(target, 'managed-notes', 'new');
        await assertNoActions(target);
      }
      await page.goto(entryPath('missing-permission-fixture', 'new'));
      await expectVisible(page.getByText('Collection not found.', { exact: true }), 'unknown collection remains a not-found state');
      await openEntry(page, 'media', 'new');
      await expectVisible(page.getByText('Media records are created by uploading a file to the media library.', { exact: true }), 'upload-only media creation');
      if (await saveButton(page).count()) fail('media new route exposes Save Changes');
      return 'create/update rules enforced independently, allowed editor saves succeed, admin actions remain, and managed content is read-only for both roles';
    } finally {
      for (const [key, id] of Object.entries(ids)) {
        const slug = key === 'editorSubmission' ? 'submissions' : key;
        await page.request.delete(apiPath(`/collections/${slug}/entries/${id}`));
      }
      await editor.context.close();
      ctx.sessions = ctx.sessions.filter(session => session !== editor.context);
    }
  },

  async 'editor-role'(ctx) {
    const { page } = ctx.admin;
    const entryId = await ensureEntry(ctx);
    const editorEmail = `e2e-editor-${ctx.runId}@example.com`;

    await page.goto(`${ADMIN_PATH}/users`);
    await expectVisible(page.getByRole('heading', { level: 1, name: 'Users' }), 'the Users page');
    await labelled(page, 'Name').fill(`E2E Editor ${ctx.runId}`);
    await labelled(page, 'Email').fill(editorEmail);
    await labelled(page, 'Temporary password').fill(EDITOR_PASSWORD);
    const createUserForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create user', exact: true }) });
    await createUserForm.getByRole('combobox').selectOption('editor');
    const created = await clickAndAwaitResponse(
      page,
      page.getByRole('button', { name: 'Create user', exact: true }),
      apiResponse('POST', apiPath('/auth/admin/create-user')),
      'creating the editor account'
    );
    if (!created.ok()) fail(`creating the editor account was refused with ${await responseSummary(created)}`);
    await expectVisible(page.getByRole('status').filter({ hasText: `${editorEmail} can now sign in.` }), 'the "can now sign in" notice');
    await expectNoAlert(page, 'after creating the editor');

    const editor = await signedInSession(ctx, editorEmail, EDITOR_PASSWORD, 'editor');
    const editorPage = editor.page;
    await openEntry(editorPage, 'posts', entryId);
    const publishCount = await editorPage.getByRole('button', { name: /^(Publish|Publishing\.\.\.)$/ }).count();
    if (publishCount > 0) fail('the editor account sees a Publish button on the entry');
    if (await editorPage.getByRole('button', { name: 'Delete entry', exact: true }).count()) fail('the editor account sees entry deletion');
    await editorPage.goto(`${ADMIN_PATH}/media`);
    await expectVisible(editorPage.getByRole('heading', { name: 'Media Library', exact: true }), 'editor media library');
    if (await editorPage.getByRole('button', { name: /^Delete / }).count()) fail('the editor account sees Media Library deletion');
    await openEntry(editorPage, 'posts', entryId);
    const archiveCount = await editorPage.getByRole('button', { name: /^(Archive|Archiving\.\.\.)$/ }).count();
    if (archiveCount > 0) fail('the editor account sees an Archive button on the entry');

    const editorTitle = `${ctx.state.entryTitle || `E2E post ${ctx.runId}`} (editor)`;
    await labelled(editorPage, 'Title').fill(editorTitle);
    await saveEntry(editorPage, 'posts', entryId, "the editor's draft save");
    ctx.state.entryTitle = editorTitle;
    await editorPage.reload();
    await expectVisible(editorHeading(editorPage), 'the editor after reloading');
    await expectValue(labelled(editorPage, 'Title'), editorTitle, "the Title after the editor's save");
    await page.goto(`${ADMIN_PATH}/users`);
    const row = page.getByRole('row').filter({ hasText: editorEmail });
    await row.getByRole('button', { name: /^Profile & sessions for / }).click();
    const panel = page.getByRole('region', { name: `Profile and CMS sessions · ${editorEmail}` });
    await expectVisible(panel, 'the editor profile and sessions');
    const changedName = `Renamed editor ${ctx.runId}`;
    await labelled(panel, 'Profile name').fill(changedName);
    const profileSaved = await clickAndAwaitResponse(page, panel.getByRole('button', { name: 'Save profile name', exact: true }),
      apiResponse('POST', apiPath('/auth/admin/update-user-profile')), 'saving the editor profile name');
    if (!profileSaved.ok()) fail(`profile save refused: ${await responseSummary(profileSaved)}`);
    await expectVisible(row.getByText(changedName, { exact: true }), 'the saved name in the user row');
    await expectVisible(panel.getByRole('button', { name: /^End session/ }).first(), 'individual CMS session control');
    await panel.getByRole('button', { name: /^End session/ }).first().click();
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await panel.getByRole('button', { name: /^End session/ }).first().click();
    const ended = await clickAndAwaitResponse(page, panel.getByRole('button', { name: 'Confirm end session', exact: true }),
      apiResponse('POST', apiPath('/auth/admin/revoke-user-session')), 'ending one editor session');
    if (!ended.ok()) fail(`session end refused: ${await responseSummary(ended)}`);
    await expectVisible(panel.getByText('No active CMS sessions.', { exact: true }), 'the empty active-session list');
    await editorPage.goto(ADMIN_PATH);
    await expectVisible(editorPage.getByRole('heading', { name: 'Sign in to Talisman CMS' }), 'revoked editor session requires sign-in');
    await panel.getByRole('button', { name: 'Close', exact: true }).click();
    await editor.context.close();
    ctx.sessions = ctx.sessions.filter((session) => session !== editor.context);
    return `${editorEmail}: draft saved, profile renamed, individual session revoked and sign-in required`;
  },

  async 'user-email-confirmation'(ctx) {
    const { page } = ctx.admin;
    const email = `email-flow-${ctx.runId}@example.com`;
    const created = await page.request.post(apiPath('/auth/admin/create-user'), { data: { name: 'Email confirmation fixture', email, password: EDITOR_PASSWORD, role: 'editor' }, headers: { Origin: ctx.options.baseUrl } });
    if (!created.ok()) fail(`email fixture creation refused: ${await responseSummary(created)}`);
    await page.goto(`${ADMIN_PATH}/users`);
    await page.getByRole('row').filter({ hasText: email }).getByRole('button', { name: /^Profile & sessions for / }).click();
    const panel = page.getByRole('region', { name: `Profile and CMS sessions · ${email}` });
    // Provider delivery and atomic identity changes are real database tests. Here fixtures exercise
    // the pending-code screen and a recoverable refusal without sending email from browser CI.
    await page.route('**/api/auth/admin/request-email-change', route => route.fulfill({ json: { ok: true, message: 'Confirmation code sent.' } }));
    await page.route('**/api/auth/admin/confirm-email-change', route => route.fulfill({ status: 400, json: { error: 'This code expired or was already used' } }));
    try {
      await labelled(panel, 'New sign-in email').fill('confirmed@example.com');
      await panel.getByRole('button', { name: 'Send confirmation code', exact: true }).click();
      const code = panel.getByRole('textbox', { name: 'Confirmation code from confirmed@example.com', exact: true });
      await expectVisible(code, 'pending-email confirmation input');
      await waitUntil('the confirmation input should receive focus', async () => code.evaluate(node => node === document.activeElement));
      if (!(await panel.getByRole('button', { name: 'Confirm email change', exact: true }).isDisabled())) fail('confirmation was enabled without a code');
      await code.fill('0'.repeat(48));
      await panel.getByRole('button', { name: 'Confirm email change', exact: true }).click();
      await expectVisible(panel.getByRole('alert').filter({ hasText: 'This code expired or was already used' }), 'recoverable confirmation error');
      await expectValue(code, '0'.repeat(48), 'confirmation code retained after refusal');
      await panel.getByRole('button', { name: 'Use another address', exact: true }).click();
      if (await labelled(panel, 'New sign-in email').isDisabled()) fail('another address could not be entered');
    } finally {
      await page.unroute('**/api/auth/admin/request-email-change');
      await page.unroute('**/api/auth/admin/confirm-email-change');
    }
    return 'pending confirmation, focus, empty-code guard and recoverable refusal verified with provider fixtures';
  },

  async 'conflict'(ctx) {
    const entryId = await ensureEntry(ctx);
    const pageA = ctx.admin.page;
    const second = await signedInSession(ctx, ctx.options.adminEmail, ctx.options.adminPassword, 'second admin');
    const pageB = second.page;
    const titleA = `E2E post ${ctx.runId} by A`;
    const viewsB = '42';

    try {
      await openEntry(pageA, 'posts', entryId);
      await openEntry(pageB, 'posts', entryId);

      // A changes the title and saves.
      await labelled(pageA, 'Title').fill(titleA);
      await saveEntry(pageA, 'posts', entryId, "A's save");

      // B, still on the old revision, changes Views and saves: refused as stale.
      await labelled(pageB, 'Views').fill(viewsB);
      const refused = await clickAndAwaitResponse(
        pageB,
        saveButton(pageB),
        apiResponse('PUT', apiPath(`/collections/posts/entries/${entryId}`)),
        "B's save"
      );
      if (refused.status() !== 409) fail(`B's stale save was answered with ${await responseSummary(refused)} instead of HTTP 409`);
      const conflictPanel = pageB.getByRole('alert').filter({ hasText: 'changed after you opened it' });
      await expectVisible(conflictPanel, 'the conflict panel ("This entry changed after you opened it")');
      const loadLatest = pageB.getByRole('button', { name: 'Load latest version', exact: true });
      await expectVisible(loadLatest, 'the "Load latest version" button');
      await loadLatest.click();

      await expectVisible(pageB.getByText('The latest saved version is now in the form'), 'the panel after loading the latest version');
      await expectValue(labelled(pageB, 'Title'), titleA, "the Title (A's value) after loading the latest version");
      const kept = pageB.getByText(/Your changes to .*Views.* are kept below/);
      await expectVisible(kept, 'the note that the change to Views is kept');
      await pageB.getByRole('button', { name: 'Review changes', exact: true }).click();
      const review = pageB.getByRole('dialog', { name: 'Review conflicting changes', exact: true });
      await expectVisible(review, 'the held changes review');
      await review.getByRole('button', { name: 'Apply choices to form', exact: true }).click();
      await expectValue(labelled(pageB, 'Views'), viewsB, 'Views after putting the change back');
      await expectValue(labelled(pageB, 'Title'), titleA, 'the Title after putting the change back');
      await saveEntry(pageB, 'posts', entryId, "B's save after the conflict");

      await pageB.reload();
      await expectVisible(editorHeading(pageB), 'the editor after reloading');
      await expectValue(labelled(pageB, 'Title'), titleA, 'the Title after reloading');
      await expectValue(labelled(pageB, 'Views'), viewsB, 'Views after reloading');
      ctx.state.entryTitle = titleA;
    } finally {
      await second.context.close().catch(() => {});
      ctx.sessions = ctx.sessions.filter((session) => session !== second.context);
    }
    return 'HTTP 409 shown as the conflict panel; latest loaded, change put back, both fields saved';
  },

  async 'conflict-review'(ctx) {
    const { page } = ctx.admin;
    const second = await signedInSession(ctx, ctx.options.adminEmail, ctx.options.adminPassword, 'conflict reviewer');
    const editor = second.page;
    const fixtures = [];
    const rich = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
    const create = async (collection, data, slug) => {
      const response = await page.request.post(apiPath(`/collections/${collection}/entries`), { data: { data, slug } });
      if (!response.ok()) fail(`conflict fixture: ${await responseSummary(response)}`);
      const entry = await response.json(); fixtures.push([collection, entry.id]); return entry;
    };
    const update = async (collection, entry, data, slug) => {
      const response = await page.request.put(apiPath(`/collections/${collection}/entries/${entry.id}`), { data: { data, slug, expectedRevisionId: entry.latestRevisionId } });
      if (!response.ok()) fail(`conflict fixture update: ${await responseSummary(response)}`);
      return response.json();
    };
    const refuseStale = async (collection, id) => {
      const response = await clickAndAwaitResponse(editor, saveButton(editor), apiResponse('PUT', apiPath(`/collections/${collection}/entries/${id}`)), 'stale reviewer save');
      if (response.status() !== 409) fail(`stale review save returned ${await responseSummary(response)}`);
      await expectVisible(editor.getByRole('button', { name: 'Load latest version', exact: true }), 'recoverable conflict');
      return response;
    };
    const dialog = editor.getByRole('dialog', { name: 'Review conflicting changes', exact: true });
    const review = editor.getByRole('button', { name: 'Review changes', exact: true });
    const load = editor.getByRole('button', { name: 'Load latest version', exact: true });
    try {
      const initialTitle = `Originally opened ${ctx.runId}`;
      const savedTitle = `Latest saved ${ctx.runId}`;
      const mineTitle = `My revised draft ${ctx.runId}`;
      const initial = await create('posts', { title: initialTitle, views: 0, content: rich('Original content'), isPublished: false }, `original-${ctx.runId}`);
      await openEntry(editor, 'posts', initial.id);
      const saved = await update('posts', initial, { title: savedTitle, views: 0, content: rich('Saved content'), isPublished: true }, `saved-${ctx.runId}`);
      await labelled(editor, 'Title').fill('My first draft');
      await labelled(editor, 'Views').fill('42');
      await editor.getByRole('textbox', { name: 'Content', exact: true }).fill('<img src=x onerror=alert(1)>');
      await labelled(editor, 'Slug (Optional)').fill(`mine-${ctx.runId}`);
      await refuseStale('posts', initial.id);
      await labelled(editor, 'Title').fill('My edits after the refusal');
      await labelled(editor, 'Views').fill('43');
      const url = apiPath(`/collections/posts/entries/${initial.id}`);
      await editor.route(`**${url}`, route => route.request().method() === 'GET' ? route.fulfill({ status: 503, json: { error: 'Latest temporarily unavailable' } }) : route.continue());
      try {
        await load.click();
        await expectVisible(editor.getByRole('alert').filter({ hasText: 'Latest temporarily unavailable' }), 'recoverable latest read failure');
        await expectValue(labelled(editor, 'Title'), 'My edits after the refusal', 'draft after failed latest read');
      } finally { await editor.unroute(`**${url}`); }
      await load.click();
      await expectVisible(review, 'review after retry');
      await expectValue(labelled(editor, 'Title'), savedTitle, 'loaded latest title');
      await labelled(editor, 'Title').fill(mineTitle);
      const writes = [];
      const observe = request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === url) writes.push(request.postDataJSON()); };
      editor.on('request', observe);
      try {
        await review.click();
        const title = dialog.getByRole('region', { name: 'Title', exact: true });
        await expectVisible(title.getByText(initialTitle, { exact: true }), 'original title');
        await expectVisible(title.getByText(mineTitle, { exact: true }), 'newest local title');
        await expectVisible(title.getByText(savedTitle, { exact: true }), 'latest title');
        await expectVisible(dialog.getByText('3 fields need a choice.', { exact: true }), 'all overlapping fields require choices');
        await expectValue(dialog.getByLabel('Value to keep for Views', { exact: true }), 'mine', 'default for edits only I made');
        await expectVisible(dialog.getByText('<img src=x onerror=alert(1)>', { exact: true }), 'literal rich text preview');
        if (await dialog.locator('img, iframe, [contenteditable="true"], textarea').count()) fail('conflict content is interactive or interpreted as HTML');
        await dialog.getByRole('button', { name: 'Apply choices to form', exact: true }).click({ force: true });
        await expectVisible(dialog, 'unresolved review cannot apply');
        if (writes.length) fail('opening or applying unresolved review sent a write');
        for (let count = 0; count < 9; count++) {
          await editor.keyboard.press('Tab');
          if (!(await dialog.evaluate(node => node.contains(document.activeElement)))) fail('Tab escaped conflict review');
        }
        if (ctx.options.artifacts) {
          await dialog.evaluate(node => { node.scrollTop = 0; });
          await editor.screenshot({ path: path.join(ctx.options.artifacts, 'conflict-review-dialog.png') });
          await editor.setViewportSize({ width: 390, height: 844 });
          await dialog.evaluate(node => { node.scrollTop = 0; });
          await editor.screenshot({ path: path.join(ctx.options.artifacts, 'conflict-review-mobile.png') });
          if (await dialog.evaluate(node => node.scrollWidth > node.clientWidth)) fail('conflict review overflows a mobile viewport');
          await editor.setViewportSize({ width: 1440, height: 1000 });
        }
        await editor.keyboard.press('Escape');
        await expectHidden(dialog, 'cancelled review');
        if (!(await review.evaluate(node => node === document.activeElement))) fail('conflict cancellation lost focus');
        await expectValue(labelled(editor, 'Title'), mineTitle, 'post-load edits after cancellation');
        await review.click();
        await dialog.getByLabel('Value to keep for Title', { exact: true }).selectOption('mine');
        await dialog.getByLabel('Value to keep for Content', { exact: true }).selectOption('latest');
        await dialog.getByLabel('Value to keep for URL slug', { exact: true }).selectOption('latest');
        await dialog.getByRole('button', { name: 'Apply choices to form', exact: true }).click();
        await expectHidden(dialog, 'applied review');
        await expectValue(labelled(editor, 'Title'), mineTitle, 'chosen local title');
        await expectValue(labelled(editor, 'Views'), '43', 'edits after the refused save');
        await expectValue(labelled(editor, 'Slug (Optional)'), `saved-${ctx.runId}`, 'chosen saved slug');
        await expectVisible(editor.getByRole('textbox', { name: 'Content', exact: true }).getByText('Saved content', { exact: true }), 'chosen saved rich text');
        await waitUntil('apply returns focus to Save', () => saveButton(editor).evaluate(node => node === document.activeElement));
        if (writes.length) fail('applying resolved choices saved without an explicit Save');
        // A third writer must still refuse the reviewed, but now stale, draft.
        const third = await update('posts', saved, { title: savedTitle, views: 0, content: rich('Saved content'), isPublished: true, publishedAt: '2026-01-02T00:00:00.000Z' }, `saved-${ctx.runId}`);
        const stale = await refuseStale('posts', initial.id);
        if (stale.request().postDataJSON().expectedRevisionId !== saved.latestRevisionId) fail('review replaced the loaded concurrency token');
        await load.click(); await expectVisible(review, 'second recovery'); await review.click();
        await expectVisible(dialog.getByText('All fields are ready to apply.', { exact: true }), 'non-overlapping retry');
        await dialog.getByRole('button', { name: 'Apply choices to form', exact: true }).click();
        const successful = await saveEntry(editor, 'posts', initial.id, 'saving chosen values');
        if (successful.request().postDataJSON().expectedRevisionId !== third.latestRevisionId) fail('recovery did not use the latest loaded revision');
        await editor.reload();
        await expectValue(labelled(editor, 'Title'), mineTitle, 'persisted chosen title');
        await expectValue(labelled(editor, 'Views'), '43', 'persisted chosen views');
        const final = await (await page.request.get(url)).json();
        const data = typeof final.data === 'string' ? JSON.parse(final.data) : final.data;
        if (data.publishedAt !== '2026-01-02T00:00:00.000Z' || !data.isPublished) fail('review reverted fields changed only by other writers');
      } finally { editor.off('request', observe); }

      // Raw JSON and block arrays are kept as a whole field, never merged by position.
      const structured = await create('pages', { title: 'Original page', layout: [{ blockType: 'hero', heading: 'Original hero' }] });
      await openEntry(editor, 'pages', structured.id);
      await editor.getByRole('button', { name: 'Switch to Raw JSON', exact: true }).click();
      const raw = editor.getByRole('textbox', { name: 'Raw JSON', exact: true });
      await raw.fill(JSON.stringify({ title: 'My page', layout: [{ blockType: 'hero', heading: 'My hero' }, { blockType: 'hero', heading: 'Added by me' }] }));
      await update('pages', structured, { title: 'Original page', layout: [{ blockType: 'hero', heading: 'Saved hero' }] });
      await refuseStale('pages', structured.id);
      await raw.fill('{ broken'); await load.click();
      await expectVisible(editor.getByRole('alert').filter({ hasText: 'Fix the raw JSON' }), 'invalid JSON protects held draft');
      await expectValue(raw, '{ broken', 'invalid JSON retained');
      await raw.fill(JSON.stringify({ title: 'My page', layout: [{ blockType: 'hero', heading: 'My hero' }, { blockType: 'hero', heading: 'Added after refusal' }] }));
      await load.click(); await expectVisible(review, 'raw draft retained'); await review.click();
      await expectVisible(dialog, 'raw conflict review');
      await expectVisible(dialog.getByText('Added after refusal', { exact: true }), 'new raw block retained');
      await dialog.getByLabel('Value to keep for Page Layout', { exact: true }).selectOption('latest');
      await dialog.getByRole('button', { name: 'Apply choices to form', exact: true }).click();
      const resolved = JSON.parse(await raw.inputValue());
      if (resolved.title !== 'My page' || resolved.layout.length !== 1 || resolved.layout[0].heading !== 'Saved hero') fail('raw block choices merged or dropped unrelated fields');
      await saveEntry(editor, 'pages', structured.id, 'saving raw field choices');

      // Native records use timestamp guards, and their data slug is an ordinary field.
      const nativeCollection = '_ecommerce_categories';
      const native = await create(nativeCollection, { id: `review-${ctx.runId}`, name: 'Original category', slug: `category-${ctx.runId}`, description: 'Original description' });
      await openEntry(editor, nativeCollection, native.id, 'commerce');
      const nativeSavedResponse = await page.request.put(apiPath(`/collections/${nativeCollection}/entries/${native.id}`), { data: { data: { name: 'Saved category', slug: `category-${ctx.runId}`, description: 'Original description' }, expectedUpdatedAt: native.updatedAt } });
      if (!nativeSavedResponse.ok()) fail(`native conflict fixture update: ${await responseSummary(nativeSavedResponse)}`);
      const nativeSaved = await nativeSavedResponse.json();
      await labelled(editor, 'Name').fill('My category');
      await labelled(editor, 'Description').fill('My description');
      const nativeStale = await refuseStale(nativeCollection, native.id);
      if ((await nativeStale.json()).code !== 'stale_record') fail('native stale review did not use a timestamp conflict');
      await load.click(); await expectVisible(review, 'native review'); await review.click();
      await dialog.getByLabel('Value to keep for Name', { exact: true }).selectOption('latest');
      if (await dialog.getByRole('region', { name: 'URL slug', exact: true }).count()) fail('native review invented a separate URL slug');
      await dialog.getByRole('button', { name: 'Apply choices to form', exact: true }).click();
      await expectValue(labelled(editor, 'Name'), 'Saved category', 'chosen native name');
      await expectValue(labelled(editor, 'Description'), 'My description', 'chosen native description');
      const nativeSuccessful = await saveEntry(editor, nativeCollection, native.id, 'saving native choices');
      if (nativeSuccessful.request().postDataJSON().expectedUpdatedAt !== nativeSaved.updatedAt) fail('native review dropped its timestamp guard');

      // Preset props live in a virtual form field, but save as propsJson.
      const presetData = { name: 'Original preset', libraryId: 'daisyui', componentSlug: 'daisyAlertNotice', propsJson: JSON.stringify({ title: 'Original notice', tone: 'info' }) };
      const preset = await create('_ui_component_presets', presetData);
      await openEntry(editor, '_ui_component_presets', preset.id);
      await update('_ui_component_presets', preset, { ...presetData, propsJson: JSON.stringify({ title: 'Saved notice', tone: 'info' }) });
      await labelled(editor, 'Preset Name').fill('My preset name');
      await labelled(editor, 'Title').fill('My notice');
      await refuseStale('_ui_component_presets', preset.id);
      await load.click(); await expectVisible(review, 'preset review'); await review.click();
      await expectVisible(dialog.getByText('My notice', { exact: true }), 'held preset prop');
      await dialog.getByLabel('Value to keep for Preset Props', { exact: true }).selectOption('mine');
      await dialog.getByRole('button', { name: 'Apply choices to form', exact: true }).click();
      await expectValue(labelled(editor, 'Title'), 'My notice', 'chosen virtual preset prop');
      await saveEntry(editor, '_ui_component_presets', preset.id, 'saving preset choices');
      await editor.reload();
      await expectValue(labelled(editor, 'Title'), 'My notice', 'serialized preset prop after reload');
      await expectValue(labelled(editor, 'Preset Name'), 'My preset name', 'preset name after reload');

      // Retired fields remain reviewable; unseen overlaps on later pages block applying.
      const retired = value => Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`retired_${index}`, `${value} ${index}`]));
      const many = await create('posts', { title: 'Many fields', ...retired('Original') });
      await openEntry(editor, 'posts', many.id);
      await editor.getByRole('button', { name: 'Switch to Raw JSON', exact: true }).click();
      await editor.getByRole('textbox', { name: 'Raw JSON', exact: true }).fill(JSON.stringify({ title: 'Many fields', ...retired('Mine') }));
      await update('posts', many, { title: 'Many fields', ...retired('Saved') });
      await refuseStale('posts', many.id);
      await load.click(); await expectVisible(review, 'retired field review'); await review.click();
      await expectVisible(dialog.getByText('25 fields need a choice.', { exact: true }), 'all retired fields reviewed');
      let choices = dialog.getByRole('combobox');
      if (await choices.count() !== 20) fail('conflict field pagination exceeded 20 rows');
      for (let index = 0; index < 20; index++) await choices.nth(index).selectOption('mine');
      await expectVisible(dialog.getByText('5 fields need a choice.', { exact: true }), 'unseen overlapping fields block applying');
      await dialog.getByRole('button', { name: 'Apply choices to form', exact: true }).click({ force: true });
      await expectVisible(dialog, 'unseen overlaps cannot apply');
      await dialog.getByRole('button', { name: 'Next fields', exact: true }).click();
      choices = dialog.getByRole('combobox');
      if (await choices.count() !== 5) fail('last conflict page omitted or duplicated fields');
      for (let index = 0; index < 5; index++) await choices.nth(index).selectOption('latest');
      await dialog.getByRole('button', { name: 'Previous fields', exact: true }).click();
      await expectValue(dialog.getByRole('combobox').first(), 'mine', 'choices retained across review pages');
      await dialog.getByRole('button', { name: 'Apply choices to form', exact: true }).click();
      const manyResolved = JSON.parse(await editor.getByRole('textbox', { name: 'Raw JSON', exact: true }).inputValue());
      if (manyResolved.retired_0 !== 'Mine 0' || manyResolved.retired_24 !== 'Saved 24') fail('paginated choices did not retain both pages');
      await saveEntry(editor, 'posts', many.id, 'saving choices from all pages');
    } finally {
      await second.context.close().catch(() => {});
      ctx.sessions = ctx.sessions.filter(session => session !== second.context);
      for (const [collection, id] of fixtures) {
        const response = await page.request.delete(apiPath(`/collections/${collection}/entries/${id}`), { headers: { Origin: ctx.options.baseUrl } });
        if (!response.ok() && response.status() !== 404) fail(`conflict fixture cleanup: ${await responseSummary(response)}`);
      }
    }
    return 'three-way choices, escaped content, focus/cancellation, read retry, post-conflict edits, raw blocks, preset props and revision/timestamp guards';
  },

  async 'media-upload'(ctx) {
    const { page } = ctx.admin;
    const fileName = `e2e-${ctx.runId}.png`;
    const altText = `E2E alt text ${ctx.runId}`;

    await page.goto(`${ADMIN_PATH}/media`);
    await expectVisible(page.getByRole('heading', { level: 1, name: 'Media Library' }), 'the media library');
    const fileInput = page.locator('input[type="file"]');
    if ((await fileInput.count()) === 0) fail('the media library has no file input');
    const uploadPromise = page.waitForResponse(apiResponse('POST', apiPath('/media/upload')), { timeout: ACTION_TIMEOUT_MS }).catch(() => null);
    await fileInput.first().setInputFiles({ name: fileName, mimeType: 'image/png', buffer: makePng(8, 8, [220, 38, 38]) });
    const upload = await uploadPromise;
    if (!upload) fail('choosing a file sent no upload request');
    if (!upload.ok()) fail(`the upload was refused with ${await responseSummary(upload)}`);
    await expectNoAlert(page, 'after uploading');

    const card = page.getByRole('link', { name: new RegExp(escapeRegExp(fileName)) });
    await expectVisible(card, `the uploaded file (${fileName}) in the library`);
    await card.first().click();
    await page.waitForURL((url) => /\/admin\/collections\/media\/[^/?#]+$/.test(url.pathname));
    const mediaId = new URL(page.url()).pathname.split('/').pop();
    await expectVisible(editorHeading(page), 'the media entry editor');
    await labelled(page, 'Alt Text').fill(altText);
    await saveEntry(page, 'media', mediaId, 'saving the alt text');

    await page.reload();
    await expectVisible(editorHeading(page), 'the media editor after reloading');
    await expectValue(labelled(page, 'Alt Text'), altText, 'the Alt Text after reloading');
    ctx.state.mediaId = mediaId;
    ctx.state.mediaFilename = fileName;
    return `${fileName} uploaded, opened, alt text saved`;
  },

  async 'media-search-filters'(ctx) {
    const { page } = ctx.admin;
    const prefix = `media-${ctx.runId}`;
    const ids = [];
    const requests = [];
    let categoryWrites = 0;
    const observe = request => {
      const url = new URL(request.url());
      if (url.pathname === apiPath('/collections/media/entries') && request.method() === 'GET') requests.push(url);
      if (url.pathname.includes('/collections/_ecommerce_categories/entries') && request.method() !== 'GET') categoryWrites++;
    };
    const upload = async (name, mimeType = 'image/png', buffer = makePng(2, 2, [80, 120, 160])) => {
      const response = await page.request.post(apiPath('/media/upload'), { multipart: { file: { name, mimeType, buffer } }, headers: { Origin: ctx.options.baseUrl } });
      if (!response.ok()) fail(`media search fixture: ${await responseSummary(response)}`);
      const record = await response.json(); ids.push(record.id); return record;
    };
    const apply = async (scope, query, type) => {
      await scope.getByRole('searchbox', { name: 'Search filenames', exact: true }).fill(query);
      await scope.getByRole('combobox', { name: 'File type', exact: true }).selectOption(type);
      const response = await clickAndAwaitResponse(page, scope.getByRole('button', { name: 'Apply filters', exact: true }), apiResponse('GET', apiPath('/collections/media/entries')), 'applying media filters');
      if (!response.ok()) fail(`media filtering: ${await responseSummary(response)}`);
      await waitUntil('media filters should settle', async () => (await scope.getByRole('button', { name: 'Apply filters', exact: true }).getAttribute('aria-disabled')) !== 'true');
    };
    page.on('request', observe);
    try {
      const target = await upload(`${prefix}-target_%_older.png`);
      // The target is older than both the library's 60-item and picker's 48-item first page.
      for (let index = 0; index < 64; index++) await upload(`${prefix}-page-${String(index).padStart(3, '0')}.png`);
      const gif = await upload(`${prefix}-type.gif`, 'image/gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
      await page.goto(`${ADMIN_PATH}/media`);
      await expectVisible(page.getByRole('heading', { name: 'Media Library', exact: true }), 'media search library');
      if (await page.getByRole('link', { name: new RegExp(escapeRegExp(target.filename)) }).count()) fail('fixture target should be beyond first media page');
      await apply(page, `${prefix}-target_%_`, 'png');
      const targetCard = page.getByRole('link', { name: new RegExp(escapeRegExp(target.filename)) });
      await expectVisible(targetCard, 'server search finds older upload');
      const last = requests.at(-1).searchParams;
      if (last.get('where[filename][text]') !== `${prefix}-target_%_` || last.get('where[mimeType]') !== 'image/png') fail('media filters were not sent to the server');
      await page.reload();
      await expectVisible(targetCard, 'media filters after reload');
      await targetCard.click();
      await expectVisible(editorHeading(page), 'filtered media entry');
      await labelled(page, 'Alt Text').fill('Search fixture description');
      await saveEntry(page, 'media', target.id, 'saving from filtered media library');
      await page.getByRole('link', { name: 'Back to Media Library', exact: true }).click();
      await expectVisible(targetCard, 'saved asset returns to filtered library');
      if (new URL(page.url()).searchParams.get('q') !== `${prefix}-target_%_` || new URL(page.url()).searchParams.get('type') !== 'png') fail('media return lost URL filters');
      await apply(page, prefix, '');
      await expectVisible(page.getByRole('status').filter({ hasText: '60 media assets shown' }), 'first filtered media page');
      await page.getByRole('button', { name: 'Load more media', exact: true }).click();
      const summary = page.getByRole('status').filter({ hasText: '66 media assets shown' });
      await expectVisible(summary, 'complete filtered media pages');
      if (!(await summary.evaluate(node => node === document.activeElement))) fail('media pagination lost focus');
      const cards = page.getByRole('link', { name: new RegExp(escapeRegExp(prefix)) });
      const hrefs = await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
      if (hrefs.length !== 66 || new Set(hrefs).size !== 66) fail('media cursor pages duplicate or omit uploads');
      const paged = requests.at(-1).searchParams;
      if (!paged.get('cursor') || paged.get('where[filename][text]') !== prefix) fail('next media page lost server filters');
      await apply(page, prefix, 'gif');
      await expectVisible(page.getByRole('link', { name: new RegExp(escapeRegExp(gif.filename)) }), 'GIF filter');
      if (await page.getByRole('link', { name: new RegExp(escapeRegExp(prefix)+'.*png') }).count()) fail('GIF filter included PNGs');
      await page.goBack();
      await expectValue(page.getByRole('searchbox', { name: 'Search filenames', exact: true }), prefix, 'browser back media search');
      await expectValue(page.getByRole('combobox', { name: 'File type', exact: true }), '', 'browser back media type');
      await apply(page, 'no-match-'+ctx.runId, 'avif');
      await expectVisible(page.getByText('No media assets match these filters.', { exact: true }), 'filtered empty library');
      await page.route('**/api/collections/media/entries?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Media temporarily unavailable"}' }));
      try {
        await page.getByRole('searchbox', { name: 'Search filenames', exact: true }).fill(prefix);
        await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
        await expectVisible(page.getByRole('alert').filter({ hasText: 'Media temporarily unavailable' }), 'recoverable media list error');
      } finally { await page.unroute('**/api/collections/media/entries?*'); }
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expectVisible(page.getByText('No media assets match these filters.', { exact: true }), 'retry retains AVIF filter');
      if (!(await page.getByRole('status').filter({ hasText: '0 media assets shown' }).evaluate(node => node === document.activeElement))) fail('media retry did not restore useful focus');
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await expectValue(page.getByRole('searchbox', { name: 'Search filenames', exact: true }), '', 'cleared media search');
      if (!(await page.getByRole('button', { name: 'Clear filters', exact: true }).evaluate(node => node === document.activeElement))) fail('clearing media filters lost focus');
      if (ctx.options.artifacts) await page.screenshot({ path: path.join(ctx.options.artifacts, 'media-search-library.png') });
      await openEntry(page, '_ecommerce_categories', 'demo_cat_boards', 'commerce');
      await labelled(page, 'Name').fill(`Unsaved category ${ctx.runId}`);
      await page.getByRole('button', { name: 'Browse for Category Image URL', exact: true }).click();
      const picker = page.getByRole('region', { name: 'Media library', exact: true });
      await expectVisible(picker.getByRole('status').filter({ hasText: '48 media assets shown' }), 'picker first page');
      await apply(picker, prefix, 'png');
      await picker.getByRole('button', { name: 'Load more media', exact: true }).click();
      await expectVisible(picker.getByRole('status').filter({ hasText: '65 media assets shown' }), 'filtered picker pagination');
      await picker.getByRole('button', { name: new RegExp(escapeRegExp(target.filename)) }).click();
      await expectValue(labelled(page, 'Category Image URL'), target.url, 'chosen older media URL');
      await apply(picker, prefix, 'gif');
      await expectVisible(picker.getByRole('button', { name: new RegExp(escapeRegExp(gif.filename)) }), 'picker GIF result');
      await expectValue(labelled(page, 'Category Image URL'), target.url, 'selection retained outside filtered page');
      await expectVisible(page.getByRole('img', { name: 'Search fixture description', exact: true }), 'selected image description retained');
      await expectVisible(page.getByText(target.filename, { exact: true }), 'selected filename retained');
      await expectValue(labelled(page, 'Name'), `Unsaved category ${ctx.runId}`, 'draft retained while filtering');
      await page.route('**/api/collections/media/entries?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Picker temporarily unavailable"}' }));
      try {
        await picker.getByRole('button', { name: 'Refresh the media library for Category Image URL', exact: true }).click();
        await expectVisible(page.getByRole('alert').filter({ hasText: 'Picker temporarily unavailable' }), 'picker recoverable error');
        await expectValue(labelled(page, 'Category Image URL'), target.url, 'selection retained on failed read');
      } finally { await page.unroute('**/api/collections/media/entries?*'); }
      await page.getByRole('button', { name: 'Retry media', exact: true }).click();
      await expectHidden(page.getByRole('alert').filter({ hasText: 'Picker temporarily unavailable' }), 'retried picker error');
      await expectNoAlert(page, 'retried picker');
      await picker.getByRole('searchbox', { name: 'Search filenames', exact: true }).fill(`${prefix}-target_%_`);
      await picker.getByRole('combobox', { name: 'File type', exact: true }).selectOption('png');
      await picker.getByRole('searchbox', { name: 'Search filenames', exact: true }).press('Enter');
      await expectVisible(picker.getByRole('button', { name: new RegExp(escapeRegExp(target.filename)) }), 'Enter applies picker search');
      if (categoryWrites) fail('media picker search submitted the unsaved entry form');
      if (ctx.options.artifacts) await page.screenshot({ path: path.join(ctx.options.artifacts, 'media-search-picker.png') });
    } finally {
      page.off('request', observe);
      const cleanupErrors = [];
      for (const id of ids) {
        const response = await page.request.delete(apiPath(`/collections/media/entries/${id}`), { headers: { Origin: ctx.options.baseUrl } });
        if (!response.ok() && response.status() !== 404) cleanupErrors.push(await responseSummary(response));
      }
      if (cleanupErrors.length) fail(`media fixture cleanup: ${cleanupErrors[0]}`);
    }
    return 'real server filename/type filtering before cursor pages; URL reload/back/editor return; empty/retry; picker retains selected metadata and draft without saving on Enter';
  },

  async 'media-delete-and-busy-focus'(ctx) {
    const { page } = ctx.admin;
    const finishUsageCheck = async (report) => {
      for (let count = 0; count < 30; count++) {
        await waitUntil('the media usage page should settle', async () => !(await report.getByText('Checking references…', { exact: true }).count()));
        const more = report.getByRole('button', { name: 'Check more content', exact: true });
        if (!(await more.count())) return;
        await more.click();
      }
      fail('the media usage report still has unchecked pages');
    };
    if (!ctx.state.mediaId) await steps['media-upload'](ctx);
    const referenced = await page.request.post(apiPath('/collections/pages/entries'), { data: {
      slug: `media-reference-${ctx.runId}`, data: { title: 'Media usage regression fixture', layout: [{ blockType: 'hero', heading: 'Usage fixture', backgroundImage: ctx.state.mediaId }] },
    } });
    if (!referenced.ok()) fail('could not create media reference fixture');
    await page.goto(`${ADMIN_PATH}/media`);
    await expectVisible(page.getByRole('heading', { name: 'Media Library', exact: true }), 'media library');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/collections/media/entries?*', async (route) => { await gate; await route.continue(); });
    const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
    try {
      await refresh.focus();
      await page.keyboard.press('Enter');
      await waitUntil('Refresh should report busy', async () => (await refresh.getAttribute('aria-busy')) === 'true');
      if (!(await refresh.evaluate((node) => node === document.activeElement))) fail('busy media Refresh lost focus');
      await expectVisible(page.getByRole('link', { name: new RegExp(escapeRegExp(ctx.state.mediaFilename)) }), 'media card during refresh');
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
    await waitUntil('Refresh should settle', async () => (await refresh.getAttribute('aria-busy')) !== 'true');
    const usageButton = page.getByRole('button', { name: `Where used ${ctx.state.mediaFilename}`, exact: true });
    await usageButton.click();
    const usageDialog = page.getByRole('dialog', { name: `Usage of ${ctx.state.mediaFilename}`, exact: true });
    await finishUsageCheck(usageDialog);
    await expectVisible(usageDialog.getByRole('link', { name: 'Media usage regression fixture', exact: true }).first(), 'standalone media usage report');
    if (await usageDialog.getByRole('checkbox').count()) fail('read-only media report asks for deletion acknowledgment');
    await page.keyboard.press('Escape');
    await expectHidden(usageDialog, 'closed media report');
    if (!(await usageButton.evaluate(node => node === document.activeElement))) fail('media report did not restore focus');
    const deleteButton = page.getByRole('button', { name: `Delete ${ctx.state.mediaFilename}`, exact: true });
    await deleteButton.click();
    const dialog = page.getByRole('dialog', { name: `Delete ${ctx.state.mediaFilename}?`, exact: true });
    await expectVisible(dialog.getByText('Pages using its URL may show broken images.', { exact: false }), 'media reference warning');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expectVisible(deleteButton, 'asset after cancel');
    await deleteButton.click();
    await expectVisible(dialog.getByRole('heading', { name: 'Where this asset is used', exact: true }), 'media usage review');
    await finishUsageCheck(dialog);
    await expectVisible(dialog.getByRole('link', { name: 'Media usage regression fixture', exact: true }).first(), 'the draft using this asset');
    const acknowledgment = dialog.getByRole('checkbox');
    if (await acknowledgment.count()) {
      if (!(await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).isDisabled())) fail('media deletion did not wait for reference acknowledgment');
      await acknowledgment.check();
    }
    const response = await clickAndAwaitResponse(page, dialog.getByRole('button', { name: 'Delete permanently', exact: true }), apiResponse('DELETE', apiPath(`/collections/media/entries/${ctx.state.mediaId}`)), 'deleting media');
    if (!response.ok()) fail(`media delete refused: ${await responseSummary(response)}`);
    await expectHidden(deleteButton, 'deleted media card');
    if (!(await refresh.evaluate((node) => node === document.activeElement))) fail('deleted media card did not transfer focus to Refresh');
    return 'busy refresh keeps focus and cards; media warning/cancel work; deletion removes asset and restores useful focus';
  },

  async 'variants'(ctx) {
    const { page } = ctx.admin;
    const productId = await ensureProduct(ctx);
    const groupName = `E2E group ${ctx.runId}`;
    const valueLabel = `E2E value ${ctx.runId}`;
    const stock = '7';

    // The product editor reads only this product's rows: every read of the flow tables carries a
    // where filter, the groups are read by this product's id, and the products table is never listed.
    const scopedSlugs = ['_ecommerce_product_variants', '_ecommerce_product_variant_values', '_ecommerce_stocks', '_ecommerce_variant_components'];
    const unscopedReads = [];
    let groupReads = 0;
    const onRequest = (request) => {
      if (request.method() !== 'GET') return;
      const url = new URL(request.url());
      const slug = url.pathname.match(/\/api\/collections\/([^/]+)\/entries$/)?.[1];
      if (!slug) return;
      const filtered = [...url.searchParams.keys()].some((key) => key.startsWith('where['));
      if (slug === 'products' || (scopedSlugs.includes(slug) && !filtered)) unscopedReads.push(`${slug}?${url.searchParams}`);
      if (slug === '_ecommerce_product_variants') {
        groupReads += 1;
        if (url.searchParams.get('where[productId]') !== productId) unscopedReads.push(`${slug}?${url.searchParams}`);
      }
    };
    page.on('request', onRequest);

    await openEntry(page, 'products', productId, 'commerce');
    const optionsHeading = page.getByRole('heading', { name: 'Options & stock' });
    await expectVisible(optionsHeading, 'the "Options & stock" configurator');

    await page.getByRole('button', { name: 'Add Variant Group', exact: true }).click();
    const groupNameInputs = page.getByLabel('Group Name');
    await expectVisible(groupNameInputs.last(), 'the new variant group card');
    await groupNameInputs.last().fill(groupName);
    const createGroup = page.getByRole('button', { name: 'Create Group', exact: true });
    const groupResponse = await clickAndAwaitResponse(
      page,
      createGroup.last(),
      apiResponse('POST', apiPath('/collections/_ecommerce_product_variants/entries')),
      'creating the variant group'
    );
    if (!groupResponse.ok()) fail(`creating the variant group was refused with ${await responseSummary(groupResponse)}`);
    await expectVisible(page.getByText(`Saved variant group "${groupName}".`), 'the "Saved variant group" notice');
    await expectNoAlert(page, 'after creating the group');

    const groupCard = variantGroupCard(page, groupName);
    await expectVisible(groupCard, `the card of the group "${groupName}"`);
    await groupCard.getByRole('button', { name: 'Add Value', exact: true }).click();
    const valueLabelInputs = groupCard.getByLabel('Value Label');
    await expectVisible(valueLabelInputs.last(), 'the new value card');
    await valueLabelInputs.last().fill(valueLabel);
    await groupCard.getByLabel('Stock Quantity').last().fill(stock);
    const valueResponse = await clickAndAwaitResponse(
      page,
      groupCard.getByRole('button', { name: 'Create Value', exact: true }).last(),
      apiResponse('POST', apiPath('/ecommerce/variants')),
      'creating the variant value'
    );
    if (!valueResponse.ok()) fail(`creating the variant value was refused with ${await responseSummary(valueResponse)}`);
    await expectVisible(page.getByText(`Saved variant value "${valueLabel}".`), 'the "Saved variant value" notice');
    await expectNoAlert(page, 'after creating the value');

    await page.reload();
    await expectVisible(optionsHeading, 'the configurator after reloading');
    const reloadedGroup = variantGroupCard(page, groupName);
    await expectVisible(reloadedGroup, `the group "${groupName}" after reloading`);
    await expectValue(reloadedGroup.getByLabel('Group Name'), groupName, 'the Group Name after reloading');
    const reloadedValue = variantValueCard(reloadedGroup, page, valueLabel);
    await expectVisible(reloadedValue, `the value "${valueLabel}" after reloading`);
    await expectValue(reloadedValue.getByLabel('Value Label'), valueLabel, 'the Value Label after reloading');
    await expectValue(reloadedValue.getByLabel('Stock Quantity'), stock, 'the Stock Quantity after reloading');
    page.off('request', onRequest);
    if (groupReads === 0) fail('the product editor did not read the variant groups');
    if (unscopedReads.length > 0) fail(`the product editor listed whole collections or another product's rows: ${unscopedReads.join(', ')}`);
    return `product ${productId}: group, value and stock ${stock} persisted`;
  },

  async 'preview-follows-typing'(ctx) {
    const { page } = ctx.admin;
    const productId = await ensureProduct(ctx);
    const typed = `E2E preview ${ctx.runId}`;

    await openEntry(page, 'products', productId, 'commerce');
    await expectVisible(page.getByRole('heading', { name: 'Storefront Preview' }), 'the storefront preview');
    const nameInput = labelled(page, 'Name');
    await expectVisible(nameInput, 'the product Name field');
    const previewTitle = page.getByRole('heading', { level: 4 });
    const before = await visibleText(previewTitle);

    await nameInput.fill('');
    await nameInput.pressSequentially(typed, { delay: 15 });
    try {
      await waitUntil(`the preview heading should read "${typed}" while typing`, async () => {
        const text = await visibleText(previewTitle);
        return text === typed ? true : `it reads "${text}"`;
      }, 4000);
    } finally {
      // Leave the product as it was: the reload discards the unsaved name (the leave prompt is accepted).
      await page.reload().catch(() => {});
    }
    return `preview heading followed the typed name (was "${before}")`;
  },

  async 'globals-save'(ctx) {
    const { page } = ctx.admin;
    const siteTitle = `E2E site ${ctx.runId}`;

    await page.goto(`${ADMIN_PATH}/globals/site-settings`);
    await expectVisible(page.getByRole('heading', { level: 1, name: 'Site Settings' }), 'the Site Settings global');
    const titleInput = labelled(page, 'Site Title');
    await titleInput.fill(siteTitle);
    const response = await clickAndAwaitResponse(
      page,
      page.getByRole('button', { name: 'Save', exact: true }),
      apiResponse('POST', apiPath('/globals/site-settings')),
      'saving the global'
    );
    if (!response.ok()) fail(`saving the global was refused with ${await responseSummary(response)}`);
    await expectVisible(page.getByRole('status').filter({ hasText: /^Saved$/ }), 'the "Saved" notice');
    await expectNoAlert(page, 'after saving the global');

    await page.reload();
    await expectVisible(page.getByRole('heading', { level: 1, name: 'Site Settings' }), 'the global after reloading');
    await expectValue(labelled(page, 'Site Title'), siteTitle, 'the Site Title after reloading');
    return `Site Title "${siteTitle}" saved and persisted`;
  },

  async 'globals-conflict'(ctx) {
    const pageA = ctx.admin.page;
    const second = await signedInSession(ctx, ctx.options.adminEmail, ctx.options.adminPassword, 'second admin');
    const pageB = second.page;
    const titleA = `E2E site ${ctx.runId} by A`;
    const titleB = `E2E site ${ctx.runId} by B`;
    const heading = (page) => page.getByRole('heading', { level: 1, name: 'Site Settings' });
    const saveGlobal = (page, what) => clickAndAwaitResponse(
      page,
      page.getByRole('button', { name: 'Save', exact: true }),
      apiResponse('POST', apiPath('/globals/site-settings')),
      what
    );

    try {
      for (const [page, who] of [[pageA, 'A'], [pageB, 'B']]) {
        await page.goto(`${ADMIN_PATH}/globals/site-settings`);
        await expectVisible(heading(page), `the Site Settings global for ${who}`);
      }

      // A saves a new title. B, still on the version both loaded, is refused and keeps its edit.
      await labelled(pageA, 'Site Title').fill(titleA);
      const savedA = await saveGlobal(pageA, "A's save");
      if (!savedA.ok()) fail(`A's save was refused with ${await responseSummary(savedA)}`);
      await expectVisible(pageA.getByRole('status').filter({ hasText: /^Saved$/ }), 'the "Saved" notice for A');

      await labelled(pageB, 'Site Title').fill(titleB);
      const refused = await saveGlobal(pageB, "B's save");
      if (refused.status() !== 409) fail(`B's stale save was answered with ${await responseSummary(refused)} instead of HTTP 409`);
      const body = await refused.json().catch(() => ({}));
      if (body.code !== 'stale_record') fail(`B's refused save carried code ${JSON.stringify(body.code)} instead of "stale_record"`);
      await expectVisible(pageB.getByRole('alert').filter({ hasText: 'changed after you opened it' }), 'the stale alert ("This global changed after you opened it")');
      await expectValue(labelled(pageB, 'Site Title'), titleB, "B's edit, kept in the form after the refusal");

      // The latest version replaces the form while B's edits remain held for explicit review.
      const loadLatest = pageB.getByRole('button', { name: 'Load latest version', exact: true });
      await expectVisible(loadLatest, 'the "Load latest version" button');
      await loadLatest.click();
      await expectValue(labelled(pageB, 'Site Title'), titleA, "the Site Title (A's value) after loading the latest version");
      await expectVisible(pageB.getByRole('status').filter({ hasText: 'The latest saved version is now in the form' }), 'the notice after loading the latest version');
      await expectNoAlert(pageB, 'after loading the latest version');

      await pageB.getByRole('button', { name: 'Review changes', exact: true }).click();
      const review = pageB.getByRole('dialog', { name: 'Review conflicting changes', exact: true });
      await review.getByLabel('Value to keep for Site Title', { exact: true }).selectOption('mine');
      await review.getByRole('button', { name: 'Apply choices to form', exact: true }).click();
      await expectValue(labelled(pageB, 'Site Title'), titleB, 'reviewed global title');
      const savedB = await saveGlobal(pageB, "B's save from the latest version");
      if (!savedB.ok()) fail(`B's save from the latest version was refused with ${await responseSummary(savedB)}`);
      await expectVisible(pageB.getByRole('status').filter({ hasText: /^Saved$/ }), 'the "Saved" notice for B');

      await pageA.reload();
      await expectVisible(heading(pageA), 'the global on A after reloading');
      await expectValue(labelled(pageA, 'Site Title'), titleB, "the Site Title (B's value) on A after reloading");
    } finally {
      await second.context.close().catch(() => {});
      ctx.sessions = ctx.sessions.filter((session) => session !== second.context);
    }
    return 'HTTP 409 stale_record preserves edits; latest loaded, field choice reviewed and saved from the new version';
  },

  async 'globals-draft-recovery'(ctx) {
    const api = ctx.admin.page.request;
    const page = await ctx.admin.context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.removeAllListeners('dialog');
    const prompts = [];
    let dismissPrompts = false;
    page.on('dialog', async dialog => {
      prompts.push({ type: dialog.type(), message: dialog.message() });
      await (dismissPrompts ? dialog.dismiss() : dialog.accept());
    });
    const url = apiPath('/globals/site-settings');
    const save = (slug, label) => clickAndAwaitResponse(page, page.getByRole('button', { name: 'Save', exact: true }), apiResponse('POST', apiPath(`/globals/${slug}`)), label);
    const read = async slug => {
      const response = await api.get(apiPath(`/globals/${slug}`));
      if (!response.ok()) fail(`global fixture read: ${await responseSummary(response)}`);
      return response.json();
    };
    const dataOf = record => typeof record.data === 'string' ? JSON.parse(record.data) : record.data;
    const update = async (record, data) => {
      const response = await api.post(apiPath(`/globals/${record.slug}`), { data, headers: { 'If-Match': `"${record.version}"` } });
      if (!response.ok()) fail(`global fixture update: ${await responseSummary(response)}`);
      return response.json();
    };
    const open = async slug => {
      await page.goto(`${ADMIN_PATH}/globals/${slug}`);
      await expectVisible(page.getByRole('button', { name: 'Save', exact: true }), 'global editor');
      await expectHidden(page.getByText('Unsaved changes', { exact: true }), 'fresh global dirty marker');
    };
    const review = page.getByRole('button', { name: 'Review changes', exact: true });
    const load = page.getByRole('button', { name: 'Load latest version', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Review conflicting changes', exact: true });
    const apply = dialog.getByRole('button', { name: 'Apply choices to form', exact: true });
    const writes = [];
    const observe = request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith(apiPath('/globals/'))) writes.push(request); };
    page.on('request', observe);
    const blockedNavigation = async label => {
      dismissPrompts = true;
      const count = prompts.length;
      await page.getByRole('link', { name: 'Back to Globals', exact: true }).click();
      await waitUntil(`${label}: leave confirmation`, () => prompts.length > count);
      if (!prompts.at(-1).message.includes('unsaved changes')) fail(`${label}: wrong navigation warning`);
      if (!new URL(page.url()).pathname.endsWith('/globals/site-settings')) fail(`${label}: cancellation left the global`);
      dismissPrompts = false;
    };
    try {
      const originalTitle = `Original global ${ctx.runId}`;
      const initial = await update(await read('site-settings'), { title: originalTitle, theme: 'system', showBanner: true, announcement: 'Original copy', seo: { metaTitle: 'Original SEO', metaDescription: 'Original description' } });
      await open('site-settings');
      await labelled(page, 'Site Title').fill('My first title');
      await labelled(page, 'Announcement Copy').fill('My copy');
      await expectVisible(page.getByText('Unsaved changes', { exact: true }), 'edited global dirty marker');
      await blockedNavigation('form edits');
      await expectValue(labelled(page, 'Site Title'), 'My first title', 'draft after cancelled navigation');
      dismissPrompts = true;
      let count = prompts.length;
      await page.reload({ timeout: 3000 }).catch(() => {});
      await waitUntil('reload warning', () => prompts.length > count);
      if (prompts.at(-1).type !== 'beforeunload') fail('global reload did not warn before unloading');
      await expectValue(labelled(page, 'Site Title'), 'My first title', 'draft after cancelled reload');
      dismissPrompts = false;
      const savedTitle = `Saved global ${ctx.runId}`;
      const saved = await update(initial, { ...dataOf(initial), title: savedTitle, theme: 'dark', seo: { metaTitle: 'Saved SEO', metaDescription: 'Saved description' } });
      const refused = await save('site-settings', 'stale global draft');
      if (refused.status() !== 409 || refused.request().headers()['if-match'] !== `"${initial.version}"`) fail('global stale save lost its version guard');
      await labelled(page, 'Site Title').fill('Edits after refusal');
      await labelled(page, 'Announcement Copy').fill('Copy after refusal');
      await page.route(`**${url}`, route => route.request().method() === 'GET' ? route.fulfill({ status: 503, json: { error: 'Latest unavailable' } }) : route.continue());
      try {
        await load.click();
        const error = page.getByRole('alert').filter({ hasText: 'Failed to load the latest version' });
        await expectVisible(error, 'latest read failure');
        if (!(await error.evaluate(node => node === document.activeElement))) fail('global latest read error lost focus');
        await expectValue(labelled(page, 'Site Title'), 'Edits after refusal', 'draft after failed latest read');
      } finally { await page.unroute(`**${url}`); }
      await load.click(); await expectVisible(review, 'held global review');
      await expectValue(labelled(page, 'Site Title'), savedTitle, 'latest title in form');
      await expectVisible(page.getByText('Unsaved changes', { exact: true }), 'held edits count as unsaved');
      await blockedNavigation('held edits');
      // Dismiss and Save cannot silently discard changes held outside the latest form.
      dismissPrompts = true;
      count = prompts.length;
      await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
      await waitUntil('held edits dismiss confirmation', () => prompts.length > count);
      await expectVisible(review, 'dismiss cancellation preserves held edits');
      const beforeSave = writes.length;
      count = prompts.length;
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await waitUntil('held edits save confirmation', () => prompts.length > count);
      if (writes.length !== beforeSave) fail('cancelled discard saved the latest form');
      dismissPrompts = false;
      // Reverting a field to the original value after reload is still an intentional new edit.
      await labelled(page, 'Site Title').fill(originalTitle);
      await review.click();
      await expectVisible(dialog.getByText('Copy after refusal', { exact: true }), 'held copy after failed save');
      await expectVisible(dialog.getByText(savedTitle, { exact: true }), 'latest title in review');
      await expectValue(dialog.getByLabel('Value to keep for Site Title', { exact: true }), '', 'post-load original value needs a choice');
      await apply.click({ force: true }); await expectVisible(dialog, 'unresolved global cannot apply');
      for (let index = 0; index < 6; index++) {
        await page.keyboard.press('Tab');
        if (!(await dialog.evaluate(node => node.contains(document.activeElement)))) fail('global review lost keyboard containment');
      }
      if (ctx.options.artifacts) {
        await dialog.evaluate(node => { node.scrollTop = 0; });
        await page.screenshot({ path: path.join(ctx.options.artifacts, 'globals-conflict-review.png') });
      }
      await page.keyboard.press('Escape'); await expectHidden(dialog, 'cancelled global review');
      if (!(await review.evaluate(node => node === document.activeElement))) fail('global review cancellation lost focus');
      await expectValue(labelled(page, 'Site Title'), originalTitle, 'new edits after cancelled review');
      await review.click();
      await dialog.getByLabel('Value to keep for Site Title', { exact: true }).selectOption('mine');
      await dialog.getByLabel('Value to keep for Announcement Copy', { exact: true }).selectOption('latest');
      count = writes.length;
      await apply.click(); await expectHidden(dialog, 'applied global choices');
      if (writes.length !== count) fail('applying global choices saved automatically');
      await waitUntil('global apply returns focus to Save', () => page.getByRole('button', { name: 'Save', exact: true }).evaluate(node => node === document.activeElement));
      await expectValue(labelled(page, 'Announcement Copy'), 'Original copy', 'chosen latest announcement');
      await expectValue(labelled(page, 'Theme'), 'dark', 'server-only theme retained');
      const third = await update(saved, { ...dataOf(saved), seo: { metaTitle: 'Saved SEO', metaDescription: 'Third writer description' } });
      const staleAgain = await save('site-settings', 'reviewed but stale global');
      if (staleAgain.status() !== 409 || staleAgain.request().headers()['if-match'] !== `"${saved.version}"`) fail('review bypassed a later writer');
      await load.click(); await expectVisible(review, 'second global recovery'); await review.click();
      await expectVisible(dialog.getByText('All fields are ready to apply.', { exact: true }), 'non-overlapping second review');
      await apply.click();
      const successful = await save('site-settings', 'save global choices');
      if (!successful.ok() || successful.request().headers()['if-match'] !== `"${third.version}"`) fail('global recovery used the wrong loaded version');
      await expectHidden(page.getByText('Unsaved changes', { exact: true }), 'successful global save clears dirty marker');
      const final = dataOf(await read('site-settings'));
      if (final.title !== originalTitle || final.seo.metaDescription !== 'Third writer description' || final.announcement !== 'Original copy') fail('global choices reverted another writer or lost edits');
      count = prompts.length;
      await page.reload();
      await expectValue(labelled(page, 'Site Title'), originalTitle, 'saved global after reload');
      if (prompts.length !== count) fail('clean global reload warned about unsaved work');

      // An unconfigured global exercises arbitrary JSON fields, removals and whole nested choices.
      const rawSlug = `draft-recovery-${ctx.runId}`;
      const rawData = { title: 'Raw original', group: { note: 'Original group' }, layout: [{ heading: 'Original block' }], remove: 'Remove me', nullable: null, slug: 'Original data slug' };
      const created = await api.post(apiPath('/globals'), { data: { name: 'Raw recovery fixture', slug: rawSlug, data: rawData } });
      if (!created.ok()) fail(`raw global fixture: ${await responseSummary(created)}`);
      const rawInitial = await created.json();
      await open(rawSlug);
      const raw = page.getByRole('textbox', { name: 'Global JSON document', exact: true });
      const mine = { title: 'Raw mine', group: { note: 'My group' }, layout: [{ heading: 'My block' }, { heading: 'Added block' }], nullable: '', slug: 'My data slug' };
      await raw.fill(JSON.stringify(mine));
      const rawSaved = await update(rawInitial, { ...rawData, title: 'Raw saved', group: { note: 'Saved group' }, layout: [{ heading: 'Saved block' }], slug: 'Saved data slug', serverOnly: true });
      const rawRefused = await save(rawSlug, 'stale raw global');
      if (rawRefused.status() !== 409) fail('raw global stale save was not refused');
      await raw.fill('{ broken'); await load.click();
      await expectVisible(page.getByRole('alert').filter({ hasText: 'Invalid JSON' }), 'invalid raw JSON blocks latest reload');
      await expectValue(raw, '{ broken', 'invalid raw draft retained');
      await raw.fill('[]'); await load.click();
      await expectVisible(page.getByRole('alert').filter({ hasText: 'must be an object' }), 'raw array cannot replace the document');
      await raw.fill(JSON.stringify({ ...mine, group: { note: 'Group after refusal' } }));
      let releaseRead;
      const readGate = new Promise(resolve => { releaseRead = resolve; });
      let reading = false;
      const rawUrl = apiPath(`/globals/${rawSlug}`);
      await page.route(`**${rawUrl}`, async route => {
        if (route.request().method() !== 'GET') return route.continue();
        reading = true; await readGate; await route.fulfill({ status: 200, json: rawSaved });
      });
      try {
        await load.click(); await waitUntil('pending latest read', () => reading);
        if (!(await raw.isDisabled())) fail('raw document accepts edits while loading its replacement');
        dismissPrompts = true;
        count = prompts.length;
        await page.getByRole('link', { name: 'Back to Globals', exact: true }).click();
        await waitUntil('pending read leave warning', () => prompts.length > count);
        if (!new URL(page.url()).pathname.endsWith(`/globals/${rawSlug}`)) fail('cancelled pending-read navigation left the draft');
        dismissPrompts = false;
        releaseRead(); await expectVisible(review, 'held raw JSON review');
      } finally { releaseRead(); await page.unroute(`**${rawUrl}`); }
      await raw.fill('{ still broken'); await review.click();
      await expectVisible(page.getByRole('alert').filter({ hasText: 'Invalid JSON' }), 'invalid raw JSON blocks review');
      await expectValue(raw, '{ still broken', 'invalid post-load raw draft retained');
      await raw.fill(JSON.stringify(dataOf(rawSaved), null, 2));
      await review.click();
      await expectVisible(dialog.getByText('Group after refusal', { exact: true }), 'raw edits after refusal held');
      if (await dialog.getByRole('region', { name: 'URL slug', exact: true }).count()) fail('global data slug became an entry URL slug');
      await dialog.getByLabel('Value to keep for Title', { exact: true }).selectOption('latest');
      await dialog.getByLabel('Value to keep for Group', { exact: true }).selectOption('mine');
      await dialog.getByLabel('Value to keep for Layout', { exact: true }).selectOption('latest');
      await dialog.getByLabel('Value to keep for Slug', { exact: true }).selectOption('mine');
      await apply.click();
      const resolved = JSON.parse(await raw.inputValue());
      if ('remove' in resolved || resolved.nullable !== '' || !resolved.serverOnly || resolved.group.note !== 'Group after refusal' || resolved.layout.length !== 1 || resolved.layout[0].heading !== 'Saved block') fail('raw global choices lost removals or merged nested fields');
      const rawSuccessful = await save(rawSlug, 'save raw choices');
      if (!rawSuccessful.ok() || rawSuccessful.request().headers()['if-match'] !== `"${rawSaved.version}"`) fail('raw recovery lost its loaded version guard');
      await expectHidden(page.getByText('Unsaved changes', { exact: true }), 'saved raw document clears dirty marker');
      // A new edit can remove a field first introduced by another writer.
      await raw.fill(JSON.stringify({ ...resolved, serverOnly: undefined }));
      const rawNext = await read(rawSlug);
      await update(rawNext, { ...dataOf(rawNext), title: 'Another raw title', introducedAfterSave: 'New field' });
      const removedStale = await save(rawSlug, 'raw removal stale save');
      if (removedStale.status() !== 409) fail('raw removal stale save was not refused');
      await load.click(); await expectVisible(review, 'raw removal recovery');
      const newest = JSON.parse(await raw.inputValue()); delete newest.title; delete newest.introducedAfterSave;
      await raw.fill(JSON.stringify(newest)); await review.click();
      await dialog.getByLabel('Value to keep for Title', { exact: true }).selectOption('mine');
      await dialog.getByLabel('Value to keep for Introduced After Save', { exact: true }).selectOption('mine');
      await apply.click();
      const removed = JSON.parse(await raw.inputValue());
      if ('title' in removed || 'introducedAfterSave' in removed) fail('post-load removal was dropped from review');
      const removalSaved = await save(rawSlug, 'save explicit raw removals');
      if (!removalSaved.ok()) fail(`raw removal save: ${await responseSummary(removalSaved)}`);
      await raw.fill('{ unsaved');
      count = prompts.length;
      await page.getByRole('link', { name: 'Back to Globals', exact: true }).click();
      await expectVisible(page.getByRole('heading', { name: 'Globals', exact: true }), 'accepted raw discard navigates');
      if (prompts.length !== count + 1) fail('raw navigation did not ask exactly once before discard');
    } finally { page.off('request', observe); await page.close().catch(() => {}); }
    return 'form/raw drafts and held edits protected on leave/reload; read failures and invalid JSON recover; explicit choices retain post-load edits and other writers; repeated If-Match saves';
  },

  async 'mobile-nav'(ctx) {
    const page = await ctx.admin.context.newPage();
    try {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(ADMIN_PATH);
      await expectVisible(dashboardHeading(page), 'the dashboard at 375x812');
      const dashboardLink = page.getByRole('link', { name: 'Dashboard', exact: true });

      // The toggle: a visible button that controls the navigation, or one named for it.
      const candidates = [
        page.locator('button[aria-controls]'),
        page.getByRole('button', { name: /menu|navigation/i }),
      ];
      let toggle = null;
      for (const candidate of candidates) {
        const count = await candidate.count();
        for (let index = 0; index < count && !toggle; index += 1) {
          if (await candidate.nth(index).isVisible()) toggle = candidate.nth(index);
        }
        if (toggle) break;
      }
      if (!toggle) {
        const linkVisible = await dashboardLink.isVisible();
        fail(linkVisible
          ? 'no header button toggles the navigation at 375x812 (the sidebar is always shown)'
          : 'no header button opens the navigation at 375x812 (the sidebar is hidden and there is no toggle)');
      }
      await toggle.click();
      await expectVisible(dashboardLink, 'the Dashboard link in the opened navigation');
      const expanded = await toggle.getAttribute('aria-expanded');
      if (expanded !== null && expanded !== 'true') fail(`the toggle's aria-expanded is "${expanded}" while the navigation is open`);
      await page.keyboard.press('Escape');
      await expectHidden(dashboardLink, 'the navigation after pressing Escape');
      const collapsed = await toggle.getAttribute('aria-expanded');
      if (collapsed !== null && collapsed !== 'false') fail(`the toggle's aria-expanded is "${collapsed}" after Escape closed the navigation`);
      return 'a header button opens the drawer with the Dashboard link; Escape closes it';
    } finally {
      await page.close().catch(() => {});
    }
  },
};

// ---------------------------------------------------------------------------------------------------
// Runner

async function runStep(ctx, name) {
  const startedAt = Date.now();
  let status = 'pass';
  let message = '';
  try {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new StepError(`the step did not finish within ${STEP_TIMEOUT_MS / 1000} s`)), STEP_TIMEOUT_MS);
    });
    try {
      message = (await Promise.race([steps[name](ctx), timeout])) || '';
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    status = 'fail';
    message = describeError(error);
    await saveScreenshot(ctx, name).catch(() => {});
  }
  const result = { name, status, ms: Date.now() - startedAt, message };
  if (KNOWN_GAPS.has(name)) result.knownGap = true;
  return result;
}

async function saveScreenshot(ctx, name) {
  if (!ctx.options.artifacts || !ctx.admin?.page || ctx.admin.page.isClosed()) return;
  await fs.mkdir(ctx.options.artifacts, { recursive: true });
  await ctx.admin.page.screenshot({ path: path.join(ctx.options.artifacts, `${name}.png`), fullPage: true });
}

function printStep(result) {
  const tag = result.status === 'pass' ? 'PASS' : result.status === 'skip' ? 'SKIP' : result.knownGap ? 'GAP ' : 'FAIL';
  console.log(`${tag}  ${result.name} (${result.ms} ms)${result.message ? `: ${result.message}` : ''}`);
}

async function main() {
  const options = readOptions(process.argv.slice(2));
  if (options.help) {
    await printHelp();
    return 0;
  }
  const allNames = Object.keys(steps);
  if (options.only) {
    const unknown = options.only.filter((name) => !allNames.includes(name));
    if (unknown.length > 0) throw new Error(`Unknown step(s) ${unknown.join(', ')}. Steps: ${allNames.join(', ')}`);
  }
  const selected = new Set(options.only ? ['sign-in', ...options.only] : allNames.filter((name) => name !== 'hybrid-editor'));

  const report = { startedAt: new Date().toISOString(), baseUrl: options.baseUrl, steps: [], chunks: null };
  if (options.dist) {
    try {
      report.chunks = await collectChunks(options.dist);
    } catch (error) {
      report.chunks = { dist: options.dist, error: firstLine(error), files: [] };
    }
  }

  const ctx = {
    options,
    runId: Math.random().toString(36).slice(2, 8),
    browser: await chromium.launch({ channel: 'chrome', headless: !options.headed, slowMo: options.headed ? 150 : 0 }),
    sessions: [],
    admin: null,
    state: {},
  };
  console.log(`admin flows against ${options.baseUrl} (run ${ctx.runId})`);

  try {
    for (const name of allNames) {
      if (!selected.has(name)) {
        const result = { name, status: 'skip', ms: 0, message: 'not selected with --only' };
        if (KNOWN_GAPS.has(name)) result.knownGap = true;
        report.steps.push(result);
        printStep(result);
        continue;
      }
      if (name !== 'sign-in' && !ctx.admin) {
        const result = { name, status: 'skip', ms: 0, message: 'sign-in failed' };
        if (KNOWN_GAPS.has(name)) result.knownGap = true;
        report.steps.push(result);
        printStep(result);
        continue;
      }
      const result = await runStep(ctx, name);
      if (name === 'sign-in' && result.status !== 'pass') ctx.admin = null;
      report.steps.push(result);
      printStep(result);
    }
  } finally {
    for (const session of ctx.sessions) await session.close().catch(() => {});
    await ctx.browser.close().catch(() => {});
  }

  const failures = report.steps.filter((step) => step.status === 'fail' && !step.knownGap);
  report.startup = ctx.state.startup || null;
  const gaps = report.steps.filter((step) => step.status === 'fail' && step.knownGap);
  report.exitCode = failures.length > 0 ? 1 : 0;

  if (report.chunks?.files?.length) {
    const { files, totalBytes, largest } = report.chunks;
    console.log(`chunks: ${files.length} .js files, ${formatBytes(totalBytes)} total; largest ${largest.path} (${formatBytes(largest.bytes)})`);
  } else if (report.chunks?.error) {
    console.log(`chunks: could not read ${report.chunks.dist}: ${report.chunks.error}`);
  }
  if (options.report) {
    await fs.mkdir(path.dirname(path.resolve(options.report)), { recursive: true });
    await fs.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report: ${path.resolve(options.report)}`);
  }
  console.log(`${report.steps.filter((step) => step.status === 'pass').length} passed, ${failures.length} failed, ${gaps.length} known gap(s), ${report.steps.filter((step) => step.status === 'skip').length} skipped`);
  return report.exitCode;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
);
