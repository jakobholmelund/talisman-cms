// Admin plugins import the core's UI source. Type-check them with the core's real
// virtual-module declarations, the same declarations Astro supplies to site builds.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
for (const name of ['plugin-ecommerce', 'plugin-stripe', 'plugin-ui-daisyui', 'plugin-ui-starwind', 'plugin-analytics']) {
  // Keep the config next to its package so TypeScript resolves that package's type dependencies.
  const work = mkdtempSync(join(root, 'packages', name, '.talisman-plugin-types-'));
  try {
    const config = join(work, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({
      extends: join(root, 'packages', name, 'tsconfig.json'),
      files: [join(root, 'packages/talisman-cms/src/virtual-modules.d.ts')],
    }));
    console.log(`Checking @talisman-cms/${name} with core virtual-module declarations.`);
    const result = spawnSync(pnpm, ['--filter', `@talisman-cms/${name}`, 'exec', 'tsc', '--noEmit', '-p', config], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  } finally { rmSync(work, { recursive: true, force: true }); }
}
