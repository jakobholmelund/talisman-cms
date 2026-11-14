import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Rebuild both linked packages with maps before collecting V8 data. Run in a disposable clone:
// the normal release build must follow this command before archives or dist-drift checks.
for (const name of ['talisman-cms', '@talisman-cms/plugin-ecommerce']) {
  run(pnpm, ['--filter', name, 'build'], { ...process.env, TALISMAN_COVERAGE: '1' });
}
const tests = ['talisman-cms', 'plugin-ecommerce'].flatMap(name =>
  readdirSync(resolve(root, 'packages', name, 'test')).filter(file => file.endsWith('.test.mjs'))
    .sort().map(file => `packages/${name}/test/${file}`));
run(pnpm, ['exec', 'c8', '--config', 'scripts/coverage.config.json', process.execPath,
  '--experimental-sqlite', '--test', ...tests]);
run(process.execPath, ['scripts/check-coverage.mjs']);
