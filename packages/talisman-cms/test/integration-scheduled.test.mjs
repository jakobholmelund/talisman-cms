import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const { default: talismanCms } = await import('../dist/integration.js');

/** Run astro:config:setup with stand-ins for Astro's helpers and return the vite config it registered. */
function setup(options, config = { server: {} }) {
  const registered = { vite: null };
  talismanCms(options).hooks['astro:config:setup']({
    command: 'build',
    config,
    injectRoute() {},
    addMiddleware() {},
    updateConfig(value) { registered.vite = value.vite; },
    addDevToolbarApp() {},
  });
  return registered;
}

/** Load the scheduled virtual module as Vite would for the server, and import it. */
async function loadScheduledModule(registered) {
  const plugin = registered.vite.plugins.find((candidate) => candidate?.name === 'vite-plugin-talisman-cms-scheduled');
  const source = plugin.load(plugin.resolveId('virtual:talisman-cms/scheduled'));
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

/** A stand-in for a plugin's server module: `data:` URLs import like any other module id. */
const jobModule = (result, exportName = 'scheduled') =>
  `data:text/javascript,${encodeURIComponent(`export function ${exportName}() { return ${JSON.stringify(result)}; }`)}`;
const quiet = (t) => t.mock.method(console, 'log', () => {});

test('the scheduled virtual module lists the plugin jobs in registration order, with the default and an explicit export name', async (t) => {
  quiet(t);
  const registered = setup({ plugins: [
    { name: 'first-plugin', scheduled: { moduleId: jobModule('first job') } },
    { name: 'quiet-plugin' },
    { name: 'second-plugin', scheduled: { moduleId: jobModule('second job', 'nightly'), exportName: 'nightly' } },
  ] });
  const { scheduledJobs } = await loadScheduledModule(registered);
  assert.deepEqual(scheduledJobs.map(({ plugin, job }) => [plugin, job()]), [['first-plugin', 'first job'], ['second-plugin', 'second job']]);
});

test('without a plugin that declares scheduled, the module exports an empty list', async (t) => {
  quiet(t);
  const { scheduledJobs } = await loadScheduledModule(setup({ plugins: [{ name: 'quiet-plugin' }] }));
  assert.deepEqual(scheduledJobs, []);
});

test('an empty moduleId, or an export name that is not an identifier, fails the build with the plugin name', (t) => {
  quiet(t);
  for (const scheduled of [{}, null, { moduleId: '' }, { moduleId: '   ' }, { moduleId: 42 }]) {
    assert.throws(() => setup({ plugins: [{ name: 'jobs-plugin', scheduled }] }), /^Error: \[talisman-cms\] jobs-plugin: scheduled\.moduleId names the server module/);
  }
  for (const exportName of ['', '  ', 'not valid', 'default-job', 42]) {
    assert.throws(() => setup({ plugins: [{ name: 'jobs-plugin', scheduled: { moduleId: 'jobs-plugin/scheduled', exportName } }] }),
      /^Error: \[talisman-cms\] jobs-plugin: scheduled\.exportName is the name of the export/);
  }
  assert.doesNotThrow(() => setup({ plugins: [{ name: 'jobs-plugin', scheduled: { moduleId: 'jobs-plugin/scheduled', exportName: 'runJobs' } }] }));
});

test('the cron warning fires when no wrangler config names a cron trigger, and stays silent when one does', (t) => {
  quiet(t);
  const warn = t.mock.method(console, 'warn', () => {});
  const work = mkdtempSync(join(tmpdir(), 'talisman-integration-scheduled-'));
  try {
    // The integration also writes the migrations folder into this project, which is fine.
    const project = join(work, 'site');
    mkdirSync(project);
    const warnings = (files, plugins) => {
      for (const name of ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']) rmSync(join(project, name), { force: true });
      for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text);
      warn.mock.resetCalls();
      setup({ plugins }, { server: {}, root: pathToFileURL(`${project}/`) });
      return warn.mock.calls.map((call) => call.arguments[0]);
    };
    const jobs = [{ name: 'jobs-plugin', scheduled: { moduleId: 'jobs-plugin/scheduled' } }];
    const message = '[talisman-cms] jobs-plugin declares scheduled jobs, but no wrangler config has a cron trigger. Add [triggers] crons = ["*/10 * * * *"] and export the handler from talisman-cms/worker in the Worker entry (see the core README).';

    assert.deepEqual(warnings({ 'wrangler.toml': 'name = "site"\n' }, jobs), [message]);
    // A commented-out trigger, or no config file at all, does not count.
    assert.deepEqual(warnings({ 'wrangler.toml': 'name = "site"\n# [triggers]\n# crons = ["*/10 * * * *"]\n' }, jobs), [message]);
    assert.deepEqual(warnings({ 'wrangler.jsonc': '{\n  "name": "site"\n  // "triggers": { "crons": ["*/10 * * * *"] }\n}\n' }, jobs), [message]);
    assert.deepEqual(warnings({}, jobs), [message]);
    // Any of the three files with a trigger keeps it silent, in the table or the inline form.
    assert.deepEqual(warnings({ 'wrangler.toml': 'name = "site"\n\n[triggers]\ncrons = ["*/10 * * * *"]\n' }, jobs), []);
    assert.deepEqual(warnings({ 'wrangler.toml': 'name = "site"\ntriggers = { crons = [\n  "0 3 * * *"\n] }\n' }, jobs), []);
    assert.deepEqual(warnings({ 'wrangler.json': '{ "name": "site", "triggers": { "crons": ["*/10 * * * *"] } }\n' }, jobs), []);
    assert.deepEqual(warnings({ 'wrangler.jsonc': '{\n  // the site\n  "name": "site",\n  "triggers": { "crons": ["0 3 * * *"] }\n}\n' }, jobs), []);
    assert.deepEqual(warnings({ 'wrangler.toml': 'name = "site"\n', 'wrangler.json': '{ "triggers": { "crons": ["0 3 * * *"] } }\n' }, jobs), []);
    // An empty trigger list is no trigger.
    assert.deepEqual(warnings({ 'wrangler.toml': 'name = "site"\n[triggers]\ncrons = []\n' }, jobs), [message]);
    // Plugins without jobs never warn; several plugins with jobs are all named.
    assert.deepEqual(warnings({ 'wrangler.toml': 'name = "site"\n' }, [{ name: 'quiet-plugin' }]), []);
    assert.deepEqual(warnings({ 'wrangler.toml': 'name = "site"\n' }, [...jobs, { name: 'other-plugin', scheduled: { moduleId: 'other-plugin/jobs', exportName: 'jobs' } }]),
      [message.replace('jobs-plugin declares', 'jobs-plugin, other-plugin declare')]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('without a project root there is nothing to read, so no warning', (t) => {
  quiet(t);
  const warn = t.mock.method(console, 'warn', () => {});
  setup({ plugins: [{ name: 'jobs-plugin', scheduled: { moduleId: 'jobs-plugin/scheduled' } }] });
  assert.equal(warn.mock.callCount(), 0);
});
