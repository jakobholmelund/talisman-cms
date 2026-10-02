// Run in a sanitized verification copy. One sequential consumer install; no publishing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { checkBrowser, checkRenderedHtml } from '../test/render-checks.mjs';
import { browserOptions, serveRenderedSite } from '../test/render-runtime.mjs';

const packageRoot = path.resolve(import.meta.dirname, '..');
const workspaceRoot = path.resolve(packageRoot, '../..');
const work = mkdtempSync(path.join(tmpdir(), 'starwind-packed-'));
const project = path.join(work, 'consumer');
const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', npm_config_cache: path.join(work, 'npm-cache') };
const version = (name) => JSON.parse(readFileSync(path.join(workspaceRoot, 'playground/node_modules', name, 'package.json'))).version;
let server;
let browser;
try {
  const archives = path.join(work, 'archives');
  mkdirSync(archives);
  const pack = (cwd) => {
    const output = execFileSync('pnpm', ['pack', '--pack-destination', archives], { cwd, env, encoding: 'utf8' });
    const file = output.trim().split('\n').findLast((line) => line.endsWith('.tgz'));
    assert.ok(file, output);
    return file;
  };
  const core = pack(path.join(workspaceRoot, 'packages/talisman-cms'));
  const plugin = pack(packageRoot);
  cpSync(path.join(packageRoot, 'test/fixtures/consumer'), project, { recursive: true });
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
    'talisman-cms': `file:${core}`,
    '@talisman-cms/plugin-ui-starwind': `file:${plugin}`,
    astro: version('astro'),
    '@tailwindcss/vite': version('@tailwindcss/vite'),
    tailwindcss: version('tailwindcss'),
    'drizzle-orm': version('drizzle-orm'),
    react: version('react'),
    'react-dom': version('react-dom'),
  } }, null, 2));
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: project, env, stdio: 'inherit' });
  assert.equal(realpathSync(path.join(project, 'node_modules/@talisman-cms/plugin-ui-starwind')), path.join(realpathSync(project), 'node_modules/@talisman-cms/plugin-ui-starwind'), 'consumer uses the archive, not a workspace symlink');
  execFileSync(process.execPath, [path.join(project, 'node_modules/astro/bin/astro.mjs'), 'build'], { cwd: project, env, stdio: 'inherit' });
  checkRenderedHtml(readFileSync(path.join(project, 'dist/index.html'), 'utf8'));
  server = await serveRenderedSite(project);
  browser = await chromium.launch(browserOptions());
  await checkBrowser(browser, `http://127.0.0.1:${server.address().port}`);
  console.log('Packed npm consumer: Astro render, stored presets, slots, repeated instances, safe editor values, keyboard, responsive CSS and explicit Tailwind source scanning passed.');
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  rmSync(work, { recursive: true, force: true });
}
