// Fails when the committed build output differs from a fresh build, so a change can't ship with a
// stale dist/. Run it after `pnpm build` (release:verify builds) on a checkout whose sources are
// committed; CI does. Checks every package's dist/ and the UI plugins' generated src/generated.ts.
//
// A rebuilt .d.ts file whose members only changed order within one union or one `{ … }` block passes
// (see dist-drift.mjs). The check lists it and puts back its committed copy, so pnpm publish, which
// refuses a working tree with changes, can run next. It does this even when other files fail the
// check, leaving only real differences to commit.
import { findDistDrift, reportDrift, restoreReordered } from './dist-drift.mjs';

const { drift, reordered } = findDistDrift();
restoreReordered(reordered);

if (drift.length) {
  reportDrift(drift);
  process.exit(1);
}
console.log('Committed build output matches the build.');
