import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as coreSchema from '../dist/db/schema.js';
import * as authSchema from '../dist/auth/local-schema.js';
import { assembleMigrations, listMigrationSources } from '../dist/migrations.js';
import { applyCoreMigrations, assertIntegrity, assertMatchesSchema, coreMigrationFiles, coreMigrationsDir, openDatabase, outline } from './helpers/migrations.mjs';

// drizzle-kit generates the core's migrations from src/db/schema.ts and src/auth/local-schema.ts
// (`pnpm db:generate`), one folder per migration in drizzle/. These tests apply them the way
// `wrangler d1 migrations apply` does and check that the database they build is exactly the one
// the schema files declare.

/** drizzle-kit's folder name: the UTC timestamp of generation, then the name given to `db:generate`. */
export const MIGRATION_FOLDER = /^\d{14}_[a-z0-9_]+$/;

const tables = [...Object.values(coreSchema), ...Object.values(authSchema)].filter((value) => is(value, SQLiteTable));

test('drizzle/ holds drizzle-kit migrations named by timestamp, each with its SQL and snapshot', () => {
  const folders = readdirSync(coreMigrationsDir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
  assert.ok(folders.length >= 1);
  for (const entry of folders) {
    assert.ok(entry.isDirectory(), `${entry.name}: every migration is a folder drizzle-kit wrote`);
    assert.match(entry.name, MIGRATION_FOLDER);
    assert.ok(existsSync(join(coreMigrationsDir, entry.name, 'migration.sql')), `${entry.name}/migration.sql`);
    assert.ok(existsSync(join(coreMigrationsDir, entry.name, 'snapshot.json')), `${entry.name}/snapshot.json`);
    // D1 enforces foreign keys during a migration whatever `PRAGMA foreign_keys` says, and a
    // generated table rebuild opens with it: edit such a migration to `PRAGMA defer_foreign_keys = true`.
    assert.doesNotMatch(readFileSync(join(coreMigrationsDir, entry.name, 'migration.sql'), 'utf8'), /PRAGMA\s+foreign_keys\b/i, `${entry.name}: PRAGMA foreign_keys has no effect on D1`);
  }
  assert.deepEqual(coreMigrationFiles().map((file) => file.name), folders.map((entry) => `${entry.name}.sql`).sort());
});

test('an empty database gets exactly the tables, indexes, keys and checks the schema files declare', () => {
  const db = openDatabase();
  try {
    applyCoreMigrations(db);
    assertIntegrity(db);
    assert.ok(tables.length >= 10);
    assertMatchesSchema(db, tables);
    assert.deepEqual(outline(db).triggers, [], 'the core has no triggers');
  } finally {
    db.close();
  }
});

test('the assembler flattens drizzle-kit folders and plain files, orders them by number and refuses a shared name or number', () => {
  const work = mkdtempSync(join(tmpdir(), 'talisman-migrations-order-'));
  try {
    const source = (name, migrations) => {
      const dir = join(work, name);
      mkdirSync(dir);
      for (const migration of migrations) {
        if (migration.endsWith('.sql') || !migration.includes('_')) {
          writeFileSync(join(dir, migration), `-- ${migration}\n`);
        } else {
          mkdirSync(join(dir, migration));
          writeFileSync(join(dir, migration, 'migration.sql'), `-- ${migration}\n`);
          writeFileSync(join(dir, migration, 'snapshot.json'), '{}');
        }
      }
      return { name, dir };
    };
    // A folder as drizzle-kit writes it counts by its name; a plain file by its own. 9 runs before
    // 10 and before any timestamp, as numbers and not as text, whatever the source order.
    const core = source('core', ['20260101000000_a', '20260103000000_c', '0010_ten.sql', 'notes.txt', 'meta']);
    const plugin = source('plugin', ['20260102000000_b', '0009_nine.sql']);
    assert.deepEqual(listMigrationSources([core, plugin]).map(({ name, source: owner }) => `${name} ${owner}`), [
      '0009_nine.sql plugin', '0010_ten.sql core', '20260101000000_a.sql core', '20260102000000_b.sql plugin', '20260103000000_c.sql core',
    ]);
    const outDir = join(work, 'out');
    mkdirSync(outDir);
    // A file an earlier run wrote (its sources.json names it) that no source ships any more is removed.
    writeFileSync(join(outDir, '0099_stale.sql'), '-- gone\n');
    writeFileSync(join(outDir, 'sources.json'), JSON.stringify([{ name: '0099_stale.sql', source: 'plugin' }]));
    assembleMigrations({ sources: [core, plugin], outDir });
    assert.deepEqual(readdirSync(outDir).sort(), ['0009_nine.sql', '0010_ten.sql', '20260101000000_a.sql', '20260102000000_b.sql', '20260103000000_c.sql', 'sources.json']);
    assert.equal(readFileSync(join(outDir, '20260102000000_b.sql'), 'utf8'), '-- 20260102000000_b\n', 'the folder\'s migration.sql is copied under the folder\'s name');
    assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'sources.json'), 'utf8')),
      [['0009_nine.sql', 'plugin'], ['0010_ten.sql', 'core'], ['20260101000000_a.sql', 'core'], ['20260102000000_b.sql', 'plugin'], ['20260103000000_c.sql', 'core']]
        .map(([name, owner]) => ({ name, source: owner })));

    // A .sql file the assembler did not write is somebody's own migration: refused, never deleted.
    writeFileSync(join(outDir, '0050_site_tables.sql'), '-- the site\n');
    assert.throws(() => assembleMigrations({ sources: [core, plugin], outDir }), /0050_site_tables\.sql was not written by the migrations assembler/);
    assert.ok(readdirSync(outDir).includes('0050_site_tables.sql'));
    rmSync(join(outDir, '0050_site_tables.sql'));

    const sameNumber = source('same-number', ['20260101000000_other']);
    assert.throws(() => listMigrationSources([core, sameNumber]), /20260101000000_a\.sql \(core\) and 20260101000000_other\.sql \(same-number\) share the number 20260101000000/);
    const sameName = source('same-name', ['20260101000000_a']);
    assert.throws(() => listMigrationSources([core, sameName]), /20260101000000_a\.sql is shipped by core and same-name/);
    assert.throws(() => listMigrationSources([{ name: 'missing', dir: join(work, 'missing') }]), /missing: migrations folder .* does not exist/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('the integration assembles the core and plugin migrations into the project and checks wrangler.toml', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const { default: talismanCms } = await import('../dist/integration.js');
  const coreNames = coreMigrationFiles().map((file) => file.name);
  const work = mkdtempSync(join(tmpdir(), 'talisman-integration-migrations-'));
  try {
    const project = join(work, 'site');
    mkdirSync(project);
    const pluginDir = join(work, 'plugin-drizzle');
    mkdirSync(join(pluginDir, '20990101000000_plugin_table'), { recursive: true });
    writeFileSync(join(pluginDir, '20990101000000_plugin_table', 'migration.sql'), 'CREATE TABLE plugin_table (id text PRIMARY KEY);\n');
    const plugin = { name: 'test-plugin', onInit: (config) => config, migrations: { dir: pluginDir } };
    const setup = (options, wranglerToml) => {
      writeFileSync(join(project, 'wrangler.toml'), wranglerToml);
      talismanCms(options).hooks['astro:config:setup']({
        command: 'sync', config: { root: pathToFileURL(`${project}/`) },
        injectRoute() {}, updateConfig() {}, addDevToolbarApp() {}, addMiddleware() {},
      });
    };
    const assembled = join(project, 'node_modules', '.talisman-cms', 'migrations');
    const listed = () => readdirSync(assembled).filter((name) => name.endsWith('.sql')).sort();
    const pointed = 'migrations_dir = "node_modules/.talisman-cms/migrations"\n';

    // Without plugins the folder holds the core's files; a plugin's migration joins them as a flat
    // file, and one no source ships any more is removed.
    setup({}, pointed);
    assert.deepEqual(listed(), coreNames);
    assert.deepEqual(JSON.parse(readFileSync(join(assembled, 'sources.json'), 'utf8')).at(-1), { name: coreNames.at(-1), source: 'talisman-cms' });
    setup({ plugins: [plugin] }, pointed);
    assert.deepEqual(listed(), [...coreNames, '20990101000000_plugin_table.sql']);
    assert.deepEqual(JSON.parse(readFileSync(join(assembled, 'sources.json'), 'utf8')).at(-1), { name: '20990101000000_plugin_table.sql', source: 'test-plugin' });
    setup({}, pointed);
    assert.deepEqual(listed(), coreNames);
    assert.equal(warn.mock.callCount(), 0);

    // The core package's own folder holds drizzle-kit folders, not the flat files wrangler reads.
    const coreFolder = `migrations_dir = "${new URL('../drizzle', import.meta.url).pathname}"\n`;
    assert.throws(() => setup({ plugins: [plugin] }, coreFolder), /wrangler\.toml: migrations_dir = ".*" is the core package's own migrations folder.*migrations_dir = "node_modules\/\.talisman-cms\/migrations"/);
    // Another folder, or the core's without plugins, is only warned about; a second binding with its
    // own folder beside the right one is not.
    setup({}, coreFolder);
    setup({ plugins: [plugin] }, 'migrations_dir = "migrations"\n# migrations_dir = "node_modules/.talisman-cms/migrations"\n');
    assert.equal(warn.mock.callCount(), 2);
    assert.match(warn.mock.calls[1].arguments[0], /No D1 binding's migrations_dir points at the assembled migrations folder \(node_modules\/\.talisman-cms\/migrations\); found wrangler\.toml: migrations_dir = "migrations"/);
    setup({ plugins: [plugin] }, `${pointed}migrations_dir = "migrations"\nmigrations_table = "app_migrations"\n`);
    assert.equal(warn.mock.callCount(), 2);

    // The migrationsDir option moves the folder; a config that names it passes.
    setup({ plugins: [plugin], migrationsDir: 'db/migrations' }, 'migrations_dir = "db/migrations"\n');
    assert.equal(readdirSync(join(project, 'db', 'migrations')).filter((name) => name.endsWith('.sql')).length, coreNames.length + 1);
    assert.equal(warn.mock.callCount(), 2);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
