// Fails when the committed build output differs from a fresh build, so a change can't ship with a
// stale dist/. Run it after `pnpm build` (release:verify builds) on a checkout whose sources are
// committed; CI does. Checks every package's dist/ and the UI plugins' generated src/generated.ts.
//
// tsup's declaration build is not deterministic: from one run to the next, TypeScript may print
// union members and object properties of an inferred type in another order. A changed .d.ts file
// therefore only counts when its tokens differ, not just their order. Other files must match exactly.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pathspecs = [':(glob)packages/*/dist/**', ':(glob)packages/*/src/generated.ts'];
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const lines = (text) => text.split('\n').filter(Boolean);

const tokens = (text) => (text.match(/[A-Za-z0-9_$]+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S/g) ?? []).sort().join('\n');

const drift = [];
for (const path of lines(git('ls-files', '--others', '--exclude-standard', '--', ...pathspecs))) {
  drift.push(`${path}: new file, not committed`);
}
for (const path of lines(git('diff', '--name-only', '--diff-filter=D', '--', ...pathspecs))) {
  drift.push(`${path}: committed, but the build no longer creates it`);
}
for (const path of lines(git('diff', '--name-only', '--diff-filter=M', '--', ...pathspecs))) {
  if (path.endsWith('.d.ts') && tokens(git('show', `:${path}`)) === tokens(readFileSync(resolve(root, path), 'utf8'))) continue;
  drift.push(`${path}: differs from the committed file`);
}

if (drift.length) {
  console.error(`The committed build output is stale (${drift.length} file${drift.length === 1 ? '' : 's'}):`);
  for (const line of drift) console.error(`  ${line}`);
  console.error('\nRun `pnpm build` and commit packages/*/dist (and src/generated.ts of the UI plugins).');
  process.exit(1);
}
console.log('Committed build output matches the build.');
