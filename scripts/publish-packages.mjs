// `pnpm release:publish` publishes every package in packages/ with pnpm, core first. Run it with
// --dry-run first. Other arguments go to `pnpm publish` too, for example --otp=<code>.
//
// Each package rebuilds in prepack, and a rebuild can print the members of some .d.ts files in another
// order. pnpm publish refuses a working tree with changes, so the publish after a dry run would stop.
// This script puts those files back before and after publishing, as check-dist-drift.mjs does. It also
// checks that the build the packages were packed from matches the committed dist/.
import { spawnSync } from 'node:child_process';
import { findDistDrift, reportDrift, restoreReordered, root } from './dist-drift.mjs';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
// `pnpm release:publish -- --dry-run` passes the `--` on, and pnpm reads no options after it.
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = args.includes('--dry-run');

function checkBuildOutput() {
  const { drift, reordered } = findDistDrift();
  restoreReordered(reordered);
  return drift;
}

// An earlier build, such as release:verify or a dry run, may have left reordered declarations behind.
const before = checkBuildOutput();
if (before.length) {
  reportDrift(before);
  console.error('\nNothing was published.');
  process.exit(1);
}

const result = spawnSync(pnpm, ['-r', '--filter', './packages/*', 'publish', ...args], { cwd: root, stdio: 'inherit' });

const after = checkBuildOutput();
if (after.length) {
  reportDrift(after);
  console.error(dryRun
    ? '\nThe dry run packed a fresh build that differs from the committed dist/. Commit and push it, then run the dry run again.'
    : '\nThe packages were packed from a fresh build that differs from the committed dist/. Commit and push it so the repository matches what was published.');
}
if (result.error) throw result.error;
// A null status means pnpm was stopped by a signal.
process.exit(result.status !== 0 ? result.status ?? 1 : after.length ? 1 : 0);
