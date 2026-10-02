import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serveRenderedSite, browserOptions } from './render-runtime.mjs';
import { chromium } from 'playwright-core';
import { checkBrowser, checkRenderedHtml } from './render-checks.mjs';

const packageRoot = path.resolve(import.meta.dirname, '..');
const workspaceRoot = path.resolve(packageRoot, '../..');
const require = createRequire(path.join(packageRoot, 'package.json'));

test('real Astro render and browser: four custom compositions, saved preset slots, safe content and keyboard use', { timeout: 120_000 }, async () => {
  const project = mkdtempSync(path.join(tmpdir(), 'starwind-render-'));
  let server;
  let browser;
  try {
    cpSync(path.join(import.meta.dirname, 'fixtures/consumer'), project, { recursive: true });
    symlinkSync(path.join(workspaceRoot, 'playground/node_modules'), path.join(project, 'node_modules'), 'dir');
    execFileSync(process.execPath, [path.join(path.dirname(require.resolve('astro/package.json')), 'bin/astro.mjs'), 'build'], { cwd: project, stdio: 'pipe', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' } });
    const html = readFileSync(path.join(project, 'dist/index.html'), 'utf8');
    checkRenderedHtml(html);
    server = await serveRenderedSite(project);
    browser = await chromium.launch(browserOptions());
    await checkBrowser(browser, `http://127.0.0.1:${server.address().port}`);
  } finally {
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(project, { recursive: true, force: true });
  }
});
