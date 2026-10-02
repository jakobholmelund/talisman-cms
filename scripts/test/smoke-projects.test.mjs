import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runSmokeProjects } from '../smoke-projects.mjs';

const projects = ['npm-core', 'pnpm-core', 'npm-full-react-19.2', 'pnpm-full'].map((name) => ({ name }));
function fixture(t) {
  const work = mkdtempSync(join(tmpdir(), 'talisman-smoke-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  return work;
}
function runtime(work, name) {
  const dir = join(work, name);
  for (const child of ['node_modules', 'dist', '.astro', '.wrangler']) mkdirSync(join(dir, child), { recursive: true });
  writeFileSync(join(dir, 'smoke.log'), 'diagnostic');
}

test('four consumers never overlap and each runtime is removed before the next install', async (t) => {
  const work = fixture(t);
  const seen = [];
  let active = 0;
  await runSmokeProjects(projects, work, async (project, index) => {
    assert.equal(active++, 0, 'concurrent consumers exhaust disk');
    assert.equal(index, seen.length);
    for (const previous of seen) assert.equal(existsSync(join(work, previous, 'node_modules')), false);
    runtime(work, project.name);
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(project.name);
    active--;
  });
  assert.deepEqual(seen, projects.map(({ name }) => name));
  for (const name of seen) {
    for (const child of ['node_modules', 'dist', '.astro', '.wrangler']) assert.equal(existsSync(join(work, name, child)), false);
    assert.equal(readFileSync(join(work, name, 'smoke.log'), 'utf8'), 'diagnostic');
  }
});

test('failed consumer releases runtime and preserves diagnostic logs and unrelated directories', async (t) => {
  const work = fixture(t);
  runtime(work, 'unrelated');
  await assert.rejects(runSmokeProjects(projects, work, async (project) => {
    runtime(work, project.name);
    throw new Error('build failed');
  }), /build failed/);
  assert.equal(existsSync(join(work, 'npm-core', 'node_modules')), false);
  assert.equal(existsSync(join(work, 'unrelated', 'node_modules')), true);
  assert.equal(readFileSync(join(work, 'npm-core', 'smoke.log'), 'utf8'), 'diagnostic');
});

test('explicit keep preserves consumer runtimes for reproduction', async (t) => {
  const work = fixture(t);
  await runSmokeProjects(projects, work, async (project) => runtime(work, project.name), { keep: true });
  for (const { name } of projects) assert.equal(existsSync(join(work, name, 'node_modules')), true);
});

test('invalid names cannot clean paths outside the owned consumer directory', async (t) => {
  const work = fixture(t);
  let called = false;
  await assert.rejects(runSmokeProjects([{ name: '../outside' }], work, () => { called = true; }), /Invalid smoke project name/);
  assert.equal(called, false);
});
