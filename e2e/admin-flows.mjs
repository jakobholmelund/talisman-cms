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
//   --report <path>          TALISMAN_E2E_REPORT          JSON report (steps, chunks, startedAt, baseUrl)
//   --dist <dir>             TALISMAN_E2E_DIST            playground dist dir: every .js file with its size
//   --artifacts <dir>        TALISMAN_E2E_ARTIFACTS       screenshots of failed steps
//   --only <step,...>                                     run these steps (sign-in always runs first)
//   --headed                                              show the browser, slowed down a little
//   --help
//
// Steps listed in KNOWN_GAPS are reported with status "fail" and knownGap: true and do not affect
// the exit code; they are printed as GAP.

import { chromium } from 'playwright-core';
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
    const archiveCount = await editorPage.getByRole('button', { name: /^(Archive|Archiving\.\.\.)$/ }).count();
    if (archiveCount > 0) fail('the editor account sees an Archive button on the entry');

    const editorTitle = `${ctx.state.entryTitle || `E2E post ${ctx.runId}`} (editor)`;
    await labelled(editorPage, 'Title').fill(editorTitle);
    await saveEntry(editorPage, 'posts', entryId, "the editor's draft save");
    ctx.state.entryTitle = editorTitle;
    await editorPage.reload();
    await expectVisible(editorHeading(editorPage), 'the editor after reloading');
    await expectValue(labelled(editorPage, 'Title'), editorTitle, "the Title after the editor's save");
    await editor.context.close();
    ctx.sessions = ctx.sessions.filter((session) => session !== editor.context);
    return `${editorEmail}: no Publish or Archive button, draft saved`;
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
      const putBack = pageB.getByRole('button', { name: 'Put my changes back', exact: true });
      await expectVisible(putBack, 'the "Put my changes back" button');
      await putBack.click();
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
    const mediaId = page.url().split('/').pop();
    await expectVisible(editorHeading(page), 'the media entry editor');
    await labelled(page, 'Alt Text').fill(altText);
    await saveEntry(page, 'media', mediaId, 'saving the alt text');

    await page.reload();
    await expectVisible(editorHeading(page), 'the media editor after reloading');
    await expectValue(labelled(page, 'Alt Text'), altText, 'the Alt Text after reloading');
    return `${fileName} uploaded, opened, alt text saved`;
  },

  async 'variants'(ctx) {
    const { page } = ctx.admin;
    const productId = await ensureProduct(ctx);
    const groupName = `E2E group ${ctx.runId}`;
    const valueLabel = `E2E value ${ctx.runId}`;
    const stock = '7';

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
  const selected = new Set(options.only ? ['sign-in', ...options.only] : allNames);

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
