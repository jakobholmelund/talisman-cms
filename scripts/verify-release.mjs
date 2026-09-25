import { spawnSync } from 'node:child_process';

const checks = [
  ['build'],
  ['test'],
  ['--filter', 'talisman-cms', 'exec', 'tsc', '--noEmit', '-p', 'tsconfig.json'],
  ['--filter', 'talisman-cms', 'exec', 'tsc', '--noEmit', '-p', 'ui/tsconfig.json'],
  ...[
    '@talisman-cms/plugin-ecommerce',
    '@talisman-cms/plugin-stripe',
    '@talisman-cms/plugin-ui-daisyui',
    '@talisman-cms/plugin-ui-starwind',
    '@talisman-cms/plugin-analytics',
  ].map((name) => ['--filter', name, 'exec', 'tsc', '--noEmit', '-p', 'tsconfig.json']),
  ['--filter', 'playground', 'exec', 'astro', 'check'],
  ['--filter', 'playground', 'build'],
  ['release:check:archives'],
  ['--filter', '@talisman-cms/plugin-ui-daisyui', 'coverage'],
  ['--filter', '@talisman-cms/plugin-ui-starwind', 'coverage'],
];

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

for (const args of checks) {
  process.stdout.write(`\n> pnpm ${args.join(' ')}\n`);
  const result = spawnSync(pnpm, args, { stdio: 'inherit', env: { ...process.env, CI: 'true' } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write('\nRelease verification passed.\n');
