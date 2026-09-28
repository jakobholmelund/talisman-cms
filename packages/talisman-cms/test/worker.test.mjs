import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// dist/worker.js reads the job list from the integration's virtual module; serve it from globalThis
// so each test can fill the same array.
globalThis.scheduledJobs = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== 'virtual:talisman-cms/scheduled') return nextResolve(specifier, context);
    const source = 'export const scheduledJobs = globalThis.scheduledJobs;';
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});
const { runScheduledJobs, scheduled } = await import('../dist/worker.js');

const event = () => ({ cron: '*/10 * * * *', scheduledTime: 1_700_000_000_000, env: { DB: 'db' }, waitUntil() {} });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('runScheduledJobs runs the jobs one after another, in order, with the event', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const ran = [];
  const first = event();
  await runScheduledJobs([
    { plugin: 'slow-plugin', job: async (received) => { await wait(20); ran.push(['slow-plugin', received]); } },
    { plugin: 'quick-plugin', job: (received) => { ran.push(['quick-plugin', received]); } },
  ], first);
  assert.deepEqual(ran.map(([plugin]) => plugin), ['slow-plugin', 'quick-plugin']);
  assert.ok(ran.every(([, received]) => received === first));
  assert.equal(errors.mock.callCount(), 0);
});

test('a failing job is logged, never skips the next one, and the run throws once naming the failed plugins', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const ran = [];
  const thrown = new Error('boom');
  await assert.rejects(runScheduledJobs([
    { plugin: 'first-plugin', job: () => { ran.push('first-plugin'); } },
    { plugin: 'throwing-plugin', job: () => { throw thrown; } },
    { plugin: 'rejecting-plugin', job: async () => { ran.push('rejecting-plugin'); throw new TypeError('late'); } },
    { plugin: 'last-plugin', job: async () => { ran.push('last-plugin'); } },
  ], event()), { message: '[talisman-cms] 2 scheduled jobs failed: throwing-plugin, rejecting-plugin' });
  assert.deepEqual(ran, ['first-plugin', 'rejecting-plugin', 'last-plugin']);
  assert.deepEqual(errors.mock.calls.map((call) => call.arguments[0]), [
    '[talisman-cms] throwing-plugin scheduled job failed: boom',
    '[talisman-cms] rejecting-plugin scheduled job failed: late',
  ]);
  // The error itself follows the message, so a log viewer shows its stack.
  assert.equal(errors.mock.calls[0].arguments[1], thrown);
});

test('a job that is not a function counts as a failure with a message that points at exportName', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  await assert.rejects(runScheduledJobs([
    { plugin: 'missing-plugin', job: undefined },
    { plugin: 'object-plugin', job: { run() {} } },
  ], event()), { message: '[talisman-cms] 2 scheduled jobs failed: missing-plugin, object-plugin' });
  assert.match(errors.mock.calls[0].arguments[0], /^\[talisman-cms\] missing-plugin scheduled job failed: the scheduled export is missing; check the plugin's scheduled\.exportName$/);
  assert.match(errors.mock.calls[1].arguments[0], /^\[talisman-cms\] object-plugin scheduled job failed: the scheduled export is not a function but object; check the plugin's scheduled\.exportName$/);
  // One failure names it in the singular.
  await assert.rejects(runScheduledJobs([{ plugin: 'only-plugin', job: () => { throw new Error('no'); } }], event()),
    { message: '[talisman-cms] A scheduled job failed: only-plugin' });
  // A non-Error throw is reported by its text.
  await assert.rejects(runScheduledJobs([{ plugin: 'text-plugin', job: () => { throw 'plain text'; } }], event()));
  assert.equal(errors.mock.calls.at(-1).arguments[0], '[talisman-cms] text-plugin scheduled job failed: plain text');
});

test('scheduled() runs the registered jobs with the cron, the time, the bindings and a working waitUntil', async (t) => {
  t.mock.method(console, 'error', () => {});
  const seen = [];
  const waited = [];
  const task = Promise.resolve('done');
  globalThis.scheduledJobs.push(
    { plugin: 'first-plugin', job: (received) => { seen.push(['first-plugin', received]); received.waitUntil(task); } },
    { plugin: 'second-plugin', job: (received) => { seen.push(['second-plugin', received]); } },
  );
  try {
    const env = { DB: 'db', KV: 'kv' };
    const ctx = { waitUntil(promise) { waited.push(promise); }, passThroughOnException() {} };
    await scheduled({ cron: '0 3 * * *', scheduledTime: 42, noRetry() {} }, env, ctx);
    assert.deepEqual(seen.map(([plugin]) => plugin), ['first-plugin', 'second-plugin']);
    const [, received] = seen[0];
    assert.equal(received.cron, '0 3 * * *');
    assert.equal(received.scheduledTime, 42);
    assert.equal(received.env, env);
    assert.deepEqual(waited, [task]);

    // A failure surfaces the same way as from runScheduledJobs.
    globalThis.scheduledJobs.push({ plugin: 'broken-plugin', job: () => Promise.reject(new Error('down')) });
    await assert.rejects(scheduled({ cron: '0 3 * * *', scheduledTime: 43 }, env, ctx), { message: '[talisman-cms] A scheduled job failed: broken-plugin' });
    assert.equal(seen.length, 4);

    // Bindings that are not an object become an empty record.
    globalThis.scheduledJobs.length = 0;
    globalThis.scheduledJobs.push({ plugin: 'env-plugin', job: (received) => { seen.push(['env-plugin', received]); } });
    await scheduled({ cron: '* * * * *', scheduledTime: 44 }, undefined, ctx);
    assert.deepEqual(seen.at(-1)[1].env, {});
  } finally {
    globalThis.scheduledJobs.length = 0;
  }
});
