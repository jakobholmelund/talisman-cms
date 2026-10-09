import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Exercise the real release checker and SQLite comparisons. The small kit fixture supplies DDL
// and a current snapshot without compiling the workspace; drift is in the actual migration SQL.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'talisman-migration-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => {
    const file = join(root, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  };
  write('node_modules/drizzle-kit/package.json', '{"main":"index.cjs"}');
  write('node_modules/drizzle-kit/index.cjs', '');
  write('node_modules/drizzle-kit/bin.cjs', `const fs = require('node:fs');
if (process.argv[2] === 'export') process.stdout.write(fs.readFileSync('declared.sql', 'utf8'));
else if (process.argv[2] === 'generate') console.log('No schema changes');
else process.exit(2);`);
  const core = 'CREATE TABLE galaxy_auth_user (id text PRIMARY KEY);';
  const commerce = 'CREATE TABLE _ecommerce_orders (id text PRIMARY KEY);';
  const stripe = 'CREATE TABLE _stripe_sync (id text PRIMARY KEY);';
  for (const [name, ddl, schemas] of [
    ['talisman-cms', core, "['./src/db/schema.ts', './src/auth/local-schema.ts']"],
    ['plugin-ecommerce', commerce, "'./src/schema.ts'"],
    ['plugin-stripe', stripe, "'./src/schema.ts'"],
  ]) {
    write(`packages/${name}/drizzle.config.ts`, `export default { schema: ${schemas} };`);
    write(`packages/${name}/declared.sql`, ddl);
    write(`packages/${name}/drizzle/20260101000000_baseline/migration.sql`, ddl + (name === 'plugin-ecommerce' ? "\nCREATE TRIGGER commerce_guard BEFORE DELETE ON _ecommerce_orders BEGIN SELECT RAISE(ABORT, 'immutable'); END;" : ''));
  }
  mkdirSync(join(root, 'scripts'));
  copyFileSync(new URL('../check-migrations.mjs', import.meta.url), join(root, 'scripts/check-migrations.mjs'));
  return { write, run: () => spawnSync(process.execPath, ['scripts/check-migrations.mjs'], { cwd: root, encoding: 'utf8' }) };
}

test('release schema gate checks Stripe as well as core and commerce', (t) => {
  const { run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /@talisman-cms\/plugin-stripe: 1 migration/);
});

test('large schema exports survive a CLI that exits before a pipe flushes', (t) => {
  const { write, run } = fixture(t);
  const ddl = `/* ${'schema padding '.repeat(100000)} */\nCREATE TABLE _ecommerce_orders (id text PRIMARY KEY);`;
  write('packages/plugin-ecommerce/declared.sql', ddl);
  write('node_modules/drizzle-kit/bin.cjs', `const fs = require('node:fs');
if (process.argv[2] === 'export') { process.stdout.write(fs.readFileSync('declared.sql', 'utf8')); process.exit(0); }
else if (process.argv[2] === 'generate') console.log('No schema changes');
else process.exit(2);`);
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /plugin-ecommerce: 1 migration/);
});

test('an unmigrated Stripe table fails the release gate instead of passing unnoticed', (t) => {
  const { write, run } = fixture(t);
  write('packages/plugin-stripe/declared.sql', 'CREATE TABLE _stripe_sync (id text PRIMARY KEY); CREATE TABLE _stripe_sync_operations (id text PRIMARY KEY);');
  const result = run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /plugin-stripe: the schema declares.*_stripe_sync_operations/);
});

test('Stripe migrations must obey the same D1 foreign-key rule', (t) => {
  const { write, run } = fixture(t);
  write('packages/plugin-stripe/drizzle/20260101000000_baseline/migration.sql', 'PRAGMA foreign_keys=OFF; CREATE TABLE _stripe_sync (id text PRIMARY KEY);');
  const result = run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /plugin-stripe:.*uses PRAGMA foreign_keys/);
});
