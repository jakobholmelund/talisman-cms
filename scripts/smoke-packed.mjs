// Installs the packed packages into throwaway Astro projects outside the workspace, as a consumer
// would, and checks that they import, dedupe React, build, and serve a working /admin in
// `astro dev`; the projects with plugins also serve plugin-stripe's signed webhook route. The
// workspace hides these failures: it links core as source and hoists shared deps.
// Needs built dist/ folders (release:verify builds first) and the npm registry. npm uses its
// default cache; point npm_config_cache at a writable folder if ~/.npm is not writable. The temp
// projects are kept when a check fails, or always with TALISMAN_SMOKE_KEEP=1.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const fixtures = join(import.meta.dirname, 'smoke-fixtures');
const work = mkdtempSync(join(tmpdir(), 'talisman-smoke-'));
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';
const playwrightVersion = '1.63.0';
const chromePaths = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const projects = [
  { name: 'npm-core', pm: 'npm' },
  { name: 'pnpm-core', pm: 'pnpm' },
  // An existing app on an older React: the admin must use the app's react and react-dom, or
  // react-dom throws React error #527.
  { name: 'npm-full-react-19.2', pm: 'npm', plugins: true, react: '~19.2.0' },
  { name: 'pnpm-full', pm: 'pnpm', plugins: true },
];

// Run package managers as a consumer would, not with the settings of the pnpm script running us.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(npm_(package_|lifecycle_|command$|config_user_agent$|config_verify_deps)|pnpm_)/i.test(key)),
);
Object.assign(childEnv, { ASTRO_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' });

const readme = readFileSync(join(root, 'packages/talisman-cms/README.md'), 'utf8');
function readmeBlock(heading, lang) {
  const section = readme.split(/^#+ /m).find((text) => text.startsWith(`${heading}\n`));
  const block = section?.match(new RegExp('```' + lang + '\\n([\\s\\S]*?)```'))?.[1];
  assert.ok(block, `README: no ${lang} block under "${heading}"`);
  return block;
}

// The core-only projects follow the README quickstart verbatim.
const readmeInstall = readmeBlock('Installation', 'bash').trim().split('\n').map((line) => line.trim().split(/\s+/));
assert.ok(readmeInstall.every(([tool, command]) => tool === 'pnpm' && command === 'add'), 'README: install steps must be `pnpm add` commands');
assert.ok(readmeInstall.some((tokens) => tokens.includes('talisman-cms')), 'README: install steps do not add talisman-cms');
// The one change to the README config: the four dev servers run at once, and each would otherwise
// claim the adapter's default inspector port, 9229.
const noInspector = 'cloudflare({ inspectorPort: false })';
const coreConfig = readmeBlock('Basic Setup', 'ts').replace('cloudflare()', noInspector);
assert.ok(coreConfig.includes(noInspector), 'README: Basic Setup no longer uses `adapter: cloudflare()`');
const wranglerToml = readmeBlock('Worker bindings', 'toml').replace(/<[^>]+>/g, 'local');

// The full project also turns on plugin-stripe's runtime hooks (a synced collection) and its opt-in
// webhook route with a handler module, as the plugin README shows. Stripe secrets are Worker
// settings, never plugin options.
const fullConfig = `import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import talismanCms from 'talisman-cms';
import { LocalAuthAdapter } from 'talisman-cms/auth/local';
import { analyticsPlugin } from '@talisman-cms/plugin-analytics';
import { ecommercePlugin } from '@talisman-cms/plugin-ecommerce';
import { stripePlugin } from '@talisman-cms/plugin-stripe';
import { daisyUiPlugin } from '@talisman-cms/plugin-ui-daisyui';
import { starwindUiPlugin } from '@talisman-cms/plugin-ui-starwind';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: ${noInspector},
  integrations: [
    talismanCms({
      auth: LocalAuthAdapter(),
      collections: [
        { name: 'Members', slug: 'members', fields: [{ name: 'email', label: 'Email', type: 'text', required: true }] },
      ],
      plugins: [
        analyticsPlugin(),
        ecommercePlugin(),
        stripePlugin({
          sync: [{
            collection: 'members',
            stripeResourceType: 'customers',
            stripeResourceTypeSingular: 'customer',
            fields: [{ fieldPath: 'email', stripeProperty: 'email' }],
          }],
          webhooksModule: {
            moduleId: fileURLToPath(new URL('./src/stripe-webhooks.ts', import.meta.url)),
            exportName: 'stripeWebhooks',
          },
        }),
        daisyUiPlugin(),
        starwindUiPlugin(),
      ],
    }),
  ],
});
`;
const stripeWebhooksModule = `export const stripeWebhooks = {
  'smoke.ok': async () => {},
  'smoke.fail': async () => { throw new Error('smoke handler ran'); },
};
`;

const astroRange = JSON.parse(readFileSync(join(root, 'playground/package.json'), 'utf8')).dependencies.astro;
const failures = [];
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const lastLines = (text, count) => stripAnsi(text).trimEnd().split('\n').slice(-count).join('\n');
const seconds = (started) => `${Math.round((Date.now() - started) / 1000)}s`;
const localBin = (dir, name) => join(dir, 'node_modules', '.bin', isWindows ? `${name}.cmd` : name);

function run(command, args, { cwd, log, env = childEnv, timeout = 600_000 }) {
  return new Promise((resolveRun, reject) => {
    const out = createWriteStream(log, { flags: 'a' });
    out.write(`\n$ ${[command, ...args].join(' ')}\n`);
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: isWindows });
    let tail = '';
    const collect = (chunk) => {
      out.write(chunk);
      tail = (tail + chunk).slice(-16_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      out.end();
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      out.end();
      if (code === 0) resolveRun(stripAnsi(tail));
      else reject(new Error(`\`${command} ${args.join(' ')}\` exited with ${code ?? signal}\n${lastLines(tail, 30)}`));
    });
  });
}

function pack() {
  const archiveDir = join(work, 'tarballs');
  mkdirSync(archiveDir);
  const packed = [];
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cwd = join(root, 'packages', entry.name);
    if (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).private) continue;
    const tarball = execFileSync(pnpm, ['pack', '--pack-destination', archiveDir], { cwd, encoding: 'utf8', shell: isWindows })
      .trim().split('\n').at(-1);
    assert.ok(tarball?.endsWith('.tgz'), `${entry.name}: pack did not create an archive`);
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }));
    packed.push({ name: manifest.name, tarball, manifest });
  }
  return packed;
}

// Public entry points Node can import: every export whose import target is built JavaScript.
function entryPoints({ name, manifest }) {
  return Object.entries(manifest.exports ?? { '.': manifest.main })
    .filter(([key]) => !key.includes('*'))
    .filter(([, target]) => /\.m?js$/.test(typeof target === 'string' ? target : target?.import ?? target?.default ?? ''))
    .map(([key]) => (key === '.' ? name : `${name}${key.slice(1)}`));
}

async function launchBrowser() {
  const chrome = chromePaths.find((path) => path && existsSync(path));
  if (!chrome) {
    console.log('No Chrome found; /admin is checked by crawling the served module graph instead of a browser.');
    return null;
  }
  const tools = join(work, 'tools');
  mkdirSync(tools);
  writeFileSync(join(tools, 'package.json'), '{"private":true}\n');
  try {
    await run(npm, ['install', '--no-audit', '--no-fund', `playwright-core@${playwrightVersion}`], { cwd: tools, log: join(tools, 'install.log') });
    const { chromium } = createRequire(join(tools, 'package.json'))('playwright-core');
    return await chromium.launch({ executablePath: chrome, headless: true });
  } catch (error) {
    console.log(`Could not start Chrome with playwright-core (${error.message.split('\n')[0]}); crawling the module graph instead.`);
    return null;
  }
}

async function loadAdminInBrowser(browser, url) {
  const problems = [];
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => problems.push(`page error: ${error.message.split('\n')[0]}`));
  page.on('console', (message) => {
    // Failed responses are reported with their URL below.
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) problems.push(`console error: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`HTTP ${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', (request) => problems.push(`request failed: ${request.url()} (${request.failure()?.errorText})`));
  // A module that fails to link stops the SPA for good; do not wait out the render timeout.
  const crashed = new Promise((_, reject) => page.once('pageerror', reject));
  crashed.catch(() => {});
  try {
    await page.goto(`${url}admin`, { waitUntil: 'load', timeout: 120_000 });
    await Promise.race([
      page.waitForFunction(() => (document.getElementById('talisman-root')?.childElementCount ?? 0) > 0, undefined, { timeout: 60_000 }),
      crashed,
    ]);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  } catch (error) {
    problems.unshift(`the admin SPA did not render into #talisman-root: ${error.message.split('\n')[0]}`);
  } finally {
    await context.close();
  }
  return problems;
}

// Without a browser: walk the module graph /admin serves and flag what a browser cannot link,
// such as a CommonJS file from node_modules that Vite did not pre-bundle.
async function crawlAdminModules(url) {
  const problems = [];
  const response = await fetch(`${url}admin`);
  if (!response.ok) return [`HTTP ${response.status} for /admin`];
  const html = await response.text();
  const queue = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g)].map(([, src]) => new URL(src, url).href);
  if (!queue.length) problems.push('/admin has no module script');
  const seen = new Set(queue);
  while (queue.length && seen.size < 4000) {
    const moduleUrl = queue.shift();
    const moduleResponse = await fetch(moduleUrl);
    const body = await moduleResponse.text();
    const { pathname } = new URL(moduleUrl);
    if (!moduleResponse.ok) {
      problems.push(`HTTP ${moduleResponse.status} ${pathname}`);
      continue;
    }
    // Pre-bundled deps are complete ESM bundles whose text quotes unrelated import examples.
    if (pathname.includes('/.vite/deps/')) continue;
    if (pathname.includes('/node_modules/') && /\bmodule\.exports\b|\bexports\.[\w$]+\s*=/.test(body) && !/^\s*export\s/m.test(body)) {
      problems.push(`CommonJS served to the browser (named imports from it fail): ${pathname}`);
    }
    for (const [, staticSpecifier, dynamicSpecifier] of body.matchAll(/\b(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
      // Vite rewrites every import it serves to a path; bare names are in strings or comments.
      const specifier = staticSpecifier ?? dynamicSpecifier;
      if (!/^\.{0,2}\//.test(specifier)) continue;
      const next = new URL(specifier, moduleUrl);
      if (next.origin === new URL(url).origin && !seen.has(next.href)) {
        seen.add(next.href);
        queue.push(next.href);
      }
    }
  }
  return problems;
}

// POSTs to plugin-stripe's public webhook route: unsigned and forged requests are refused, a
// signed event reaches the project's handler module, and a throwing handler asks Stripe to retry.
async function checkStripeWebhook(url, secret) {
  const endpoint = new URL('api/stripe/webhooks', url);
  const event = (type) => JSON.stringify({ id: `evt_smoke_${type.replace('.', '_')}`, object: 'event', type, data: { object: {} } });
  const sign = (payload) => {
    const timestamp = Math.floor(Date.now() / 1000);
    return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`;
  };
  const post = (payload, signature) => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signature ? { 'Stripe-Signature': signature } : {}) },
    body: payload,
  });
  const expectResponse = async (label, response, status, check) => {
    const text = await response.text();
    assert.equal(response.status, status, `${label}: expected HTTP ${status}, got ${response.status} ${text.slice(0, 300)}`);
    check?.(JSON.parse(text));
  };

  // The first request compiles the route; a cold dev server may answer 5xx while it reloads.
  let unsigned;
  for (const started = Date.now(); Date.now() - started < 60_000;) {
    unsigned = await post(event('smoke.ok'));
    if (unsigned.status < 500 || unsigned.status === 503) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
  }
  await expectResponse('unsigned event', unsigned, 400);
  await expectResponse('event signed for another payload', await post(event('smoke.ok'), sign(event('smoke.other'))), 400);
  await expectResponse('signed event', await post(event('smoke.ok'), sign(event('smoke.ok'))), 200,
    (body) => assert.deepEqual(body, { received: true }));
  await expectResponse('signed event whose handler throws', await post(event('smoke.fail'), sign(event('smoke.fail'))), 500,
    (body) => assert.equal(body.message, 'smoke handler ran'));
}

async function withDevServer(dir, log, port, check) {
  const out = createWriteStream(log, { flags: 'a' });
  // Astro moves `astro dev` into the background when it detects a coding agent; --ignore-lock keeps
  // it in the foreground so this script owns the process.
  const args = ['dev', '--host', '127.0.0.1', '--port', String(port), '--ignore-lock'];
  out.write(`\n$ astro ${args.join(' ')}\n`);
  const child = spawn(localBin(dir, 'astro'), args, {
    cwd: dir, env: childEnv, detached: !isWindows, stdio: ['ignore', 'pipe', 'pipe'], shell: isWindows,
  });
  let output = '';
  const exited = new Promise((resolveExit) => child.on('close', resolveExit));
  try {
    const url = await new Promise((resolveUrl, reject) => {
      const timer = setTimeout(() => reject(new Error(`astro dev did not start within 120s\n${lastLines(output, 30)}`)), 120_000);
      const collect = (chunk) => {
        out.write(chunk);
        output = (output + chunk).slice(-32_000);
        const local = stripAnsi(output).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (local) {
          clearTimeout(timer);
          resolveUrl(`${local}/`);
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      exited.then((code) => {
        clearTimeout(timer);
        reject(new Error(`astro dev exited with ${code}\n${lastLines(output, 30)}`));
      });
    });
    return await check(url, () => output);
  } finally {
    if (child.exitCode === null) {
      const kill = (signal) => {
        try {
          if (isWindows) child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch {}
      };
      kill('SIGTERM');
      const timer = setTimeout(() => kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    }
    out.end();
  }
}

function copies(project, dir, name) {
  if (project.pm === 'npm') {
    const nodes = JSON.parse(execFileSync(npm, ['query', `#${name}`], { cwd: dir, env: childEnv, encoding: 'utf8', shell: isWindows }));
    return [...new Set(nodes.map((node) => `${node.location}@${node.version}`))];
  }
  const prefix = `${name.replace('/', '+')}@`;
  return readdirSync(join(dir, 'node_modules', '.pnpm')).filter((entry) => entry.startsWith(prefix));
}

async function smokeProject(project, port, packages, browserReady) {
  const [core, ...plugins] = packages;
  const dir = join(work, project.name);
  const log = join(dir, 'smoke.log');
  mkdirSync(join(dir, 'src', 'pages'), { recursive: true });
  const report = (line) => console.log(`[${project.name}] ${line}`);
  const step = async (label, fn) => {
    const started = Date.now();
    try {
      await fn();
      report(`${label}: ok (${seconds(started)})`);
      return true;
    } catch (error) {
      failures.push({ project: project.name, check: label, detail: error.message });
      report(`${label}: FAILED (${seconds(started)})`);
      return false;
    }
  };

  const dependencies = { astro: astroRange };
  if (project.react) Object.assign(dependencies, { react: project.react, 'react-dom': project.react });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: `talisman-smoke-${project.name}`, private: true, type: 'module', dependencies }, null, 2)}\n`);
  writeFileSync(join(dir, 'astro.config.mjs'), project.plugins ? fullConfig : coreConfig);
  writeFileSync(join(dir, 'wrangler.toml'), wranglerToml);
  const stripeWebhookSecret = `whsec_${randomBytes(24).toString('hex')}`;
  writeFileSync(join(dir, '.dev.vars'), [
    `TALISMAN_AUTH_SECRET=${randomBytes(32).toString('hex')}`,
    `TALISMAN_AUTH_SETUP_TOKEN=${randomBytes(32).toString('hex')}`,
    ...(project.plugins ? [`TALISMAN_STRIPE_WEBHOOK_SECRET=${stripeWebhookSecret}`] : []),
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'src', 'pages', 'index.astro'), '<h1>Talisman smoke test</h1>\n');
  if (project.plugins) writeFileSync(join(dir, 'src', 'stripe-webhooks.ts'), stripeWebhooksModule);
  for (const file of ['import-entries.mjs', 'stub-virtual-modules.mjs']) copyFileSync(join(fixtures, file), join(dir, file));

  // Keep the pinned React when the README install line also names react or react-dom; a bare
  // name would move the project to the latest release.
  const pin = (arg) => (project.react && (arg === 'react' || arg === 'react-dom') ? `${arg}@${project.react}` : arg);
  const installed = await step(`${project.pm} install`, async () => {
    for (const [, , ...args] of readmeInstall) {
      const packagesToAdd = args.map((arg) => (arg === core.name ? core.tarball : pin(arg)));
      if (project.plugins && args.includes(core.name)) packagesToAdd.push(...plugins.map((plugin) => plugin.tarball));
      const command = project.pm === 'npm' ? ['install', '--no-audit', '--no-fund', ...packagesToAdd] : ['add', ...packagesToAdd];
      await run(project.pm === 'npm' ? npm : pnpm, command, { cwd: dir, log });
    }
  });
  if (!installed) return;

  await step('one copy each of talisman-cms, react and react-dom', async () => {
    const duplicated = ['talisman-cms', 'react', 'react-dom']
      .map((name) => [name, copies(project, dir, name)])
      .filter(([, found]) => found.length !== 1);
    assert.ok(!duplicated.length, duplicated.map(([name, found]) => `${name}: ${found.length} copies ${found.join(', ')}`).join('\n'));
  });

  await step('import public entry points in Node', async () => {
    const specifiers = [core, ...(project.plugins ? plugins : [])].flatMap(entryPoints);
    await run(process.execPath, ['import-entries.mjs', ...specifiers], { cwd: dir, log, timeout: 120_000 });
  });

  // The integration writes the migrations folder that the README's wrangler.toml names on every
  // config setup, so a site runs `astro sync` (or a build) before applying migrations.
  await step('astro sync writes the migrations folder', () => run(localBin(dir, 'astro'), ['sync'], { cwd: dir, log, timeout: 120_000 }));
  await step('wrangler d1 migrations apply DB --local', () =>
    run(localBin(dir, 'wrangler'), ['d1', 'migrations', 'apply', 'DB', '--local'], { cwd: dir, log, env: { ...childEnv, CI: 'true' } }));

  await step('astro dev: /admin loads its client bundle', async () => {
    const browser = await browserReady;
    await withDevServer(dir, log, port, async (url, serverOutput) => {
      const problems = browser ? await loadAdminInBrowser(browser, url) : await crawlAdminModules(url);
      if (project.plugins) {
        await step('astro dev: plugin-stripe webhook route checks signatures and runs handlers', async () => {
          try {
            await checkStripeWebhook(url, stripeWebhookSecret);
          } catch (error) {
            error.message += `\n--- astro dev output ---\n${lastLines(serverOutput(), 20)}`;
            throw error;
          }
        });
      }
      assert.ok(!problems.length, `${[...new Set(problems)].join('\n')}\n--- astro dev output ---\n${lastLines(serverOutput(), 20)}`);
    });
  });

  await step('astro build', () => run(localBin(dir, 'astro'), ['build'], { cwd: dir, log }));
}

const started = Date.now();
let keep = process.env.TALISMAN_SMOKE_KEEP === '1';
let browserReady;
try {
  const packed = pack();
  const core = packed.find((entry) => entry.name === 'talisman-cms');
  assert.ok(core, 'talisman-cms was not packed');
  const plugins = packed.filter((entry) => entry !== core);
  for (const plugin of plugins) {
    assert.ok(fullConfig.includes(`'${plugin.name}'`), `${plugin.name} is not registered in the smoke test's full project`);
  }
  console.log(`Packed ${packed.map((entry) => `${entry.name}@${entry.manifest.version}`).join(', ')}\nSmoke projects: ${work}`);

  browserReady = launchBrowser();
  await Promise.all(projects.map((project, index) => smokeProject(project, 4400 + index * 10, [core, ...plugins], browserReady)));
} catch (error) {
  failures.push({ project: 'setup', check: 'pack and prepare', detail: error.stack ?? String(error) });
} finally {
  await (await browserReady)?.close();
}

if (failures.length) {
  keep = true;
  console.error(`\nPacked consumer smoke test failed (${failures.length} check${failures.length === 1 ? '' : 's'}, ${seconds(started)}):`);
  for (const { project, check, detail } of failures) {
    console.error(`\n[${project}] ${check}\n${detail.replace(/^/gm, '  ')}`);
  }
}
if (keep) console.log(`\nSmoke projects kept in ${work} (see each project's smoke.log).`);
else rmSync(work, { recursive: true, force: true });
if (failures.length) process.exit(1);
console.log(`\nPacked consumer smoke test passed (${seconds(started)}).`);
