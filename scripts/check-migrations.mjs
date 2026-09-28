#!/usr/bin/env node
// Checks that the migrations of talisman-cms and @talisman-cms/plugin-ecommerce build exactly the
// database their Drizzle schema files declare. Run after `pnpm build`: the plugin's schema imports
// the core's auth schema from the core's dist.
//
// 1. drizzle-kit exports the DDL each schema declares. Applied to an empty database, the core's DDL must
//    give the same tables, columns, indexes, foreign keys and CHECK constraints as the core's
//    migrations, and the core's plus the plugin's DDL the same as both packages' migrations; only the
//    plugin's trigger migration may add anything, and only triggers.
// 2. drizzle-kit finds no change between each schema and its last snapshot, so a schema edit that was
//    not followed by `pnpm --filter <package> db:generate` stops here.
// 3. Every migration is a folder drizzle-kit wrote, `<timestamp>_<name>/migration.sql`, and none relies
//    on `PRAGMA foreign_keys`, which D1 ignores inside a migration.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const kit = join(dirname(require.resolve('drizzle-kit')), 'bin.cjs');
if (!existsSync(kit)) throw new Error(`drizzle-kit's command line entry is not at ${kit}`);

// Each package's schema files, as its drizzle.config.ts lists them; drizzle-kit's command line takes them as one glob.
const core = { name: 'talisman-cms', dir: join(root, 'packages/talisman-cms'), schema: ['./src/db/schema.ts', './src/auth/local-schema.ts'], glob: './src/{db/schema,auth/local-schema}.ts' };
const plugin = { name: '@talisman-cms/plugin-ecommerce', dir: join(root, 'packages/plugin-ecommerce'), schema: ['./src/schema.ts'], glob: './src/schema.ts' };
const MIGRATION_FOLDER = /^\d{14}_[a-z0-9_]+$/;
const problems = [];

function runKit(cwd, args) {
  const result = spawnSync(process.execPath, [kit, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CI: 'true' } });
  if (result.status !== 0) throw new Error(`drizzle-kit ${args.join(' ')} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/** The DDL drizzle-kit derives from a package's schema files. */
function declaredDdl(pkg) {
  return runKit(pkg.dir, ['export']).split('\n').filter((line) => !/^(Reading config file|No config path)/.test(line)).join('\n');
}

/** The migration folders of a package, checked for drizzle-kit's layout and the D1 rule, in wrangler's order. */
function migrations(pkg) {
  const dir = join(pkg.dir, 'drizzle');
  const folders = readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
  for (const entry of folders) {
    const sql = join(dir, entry.name, 'migration.sql');
    if (!entry.isDirectory() || !MIGRATION_FOLDER.test(entry.name) || !existsSync(sql)) {
      problems.push(`${pkg.name}: drizzle/${entry.name} is not a migration folder drizzle-kit wrote (<timestamp>_<name>/migration.sql)`);
      continue;
    }
    if (/PRAGMA\s+foreign_keys\b/i.test(readFileSync(sql, 'utf8'))) {
      problems.push(`${pkg.name}: drizzle/${entry.name}/migration.sql uses PRAGMA foreign_keys, which D1 ignores inside a migration; use PRAGMA defer_foreign_keys = true`);
    }
  }
  return folders.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name, 'migration.sql'));
}

const leading = (path) => parseInt(basename(join(path, '..')).split('_')[0], 10);
const inOrder = (paths) => [...paths].sort((a, b) => leading(a) - leading(b) || (a < b ? -1 : 1));

function database(statements) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of statements) db.exec(sql);
  return db;
}

const rows = (db, sql, ...params) => db.prepare(sql).all(...params);

/** Tables with their columns, indexes, foreign keys and CHECK count, and the trigger names, as text lines. */
function outline(db) {
  const lines = [];
  const tables = rows(db, `SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  for (const { name, sql } of tables) {
    for (const column of rows(db, 'SELECT * FROM pragma_table_info(?)', name)) {
      lines.push(`${name}.${column.name} ${column.type}${column.notnull ? ' NOT NULL' : ''}${column.dflt_value === null ? '' : ` DEFAULT ${column.dflt_value}`}${column.pk ? ' PK' : ''}`);
    }
    for (const index of rows(db, 'SELECT name, "unique", origin, partial FROM pragma_index_list(?)', name)) {
      if (index.origin === 'pk') continue;
      const keys = rows(db, 'SELECT name FROM pragma_index_info(?) ORDER BY seqno', index.name).map((key) => key.name ?? '<expression>').join(', ');
      lines.push(`${name} ${index.origin === 'u' ? 'UNIQUE' : `INDEX ${index.name}`} (${keys})${index.origin === 'c' && index.unique ? ' UNIQUE' : ''}${index.partial ? ' PARTIAL' : ''}`);
    }
    for (const key of rows(db, 'SELECT "from", "table", "to", on_delete FROM pragma_foreign_key_list(?)', name)) {
      lines.push(`${name}.${key.from} -> ${key.table}.${key.to} ON DELETE ${key.on_delete}`);
    }
    lines.push(`${name} CHECKs: ${(sql.match(/\bCHECK\s*\(/gi) ?? []).length}`);
  }
  return { objects: lines.sort(), triggers: rows(db, `SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name`).map((row) => row.name) };
}

function compare(label, declared, migrated) {
  const missing = declared.objects.filter((line) => !migrated.objects.includes(line));
  const extra = migrated.objects.filter((line) => !declared.objects.includes(line));
  for (const line of missing) problems.push(`${label}: the schema declares "${line}" but the migrations do not create it`);
  for (const line of extra) problems.push(`${label}: the migrations create "${line}" but the schema does not declare it`);
  if (declared.triggers.length) problems.push(`${label}: drizzle-kit exported triggers, which it does not model: ${declared.triggers.join(', ')}`);
}

/** drizzle-kit's own view: does the schema differ from the last snapshot? Runs against a copy of the folder. */
function snapshotCurrent(pkg) {
  const config = readFileSync(join(pkg.dir, 'drizzle.config.ts'), 'utf8');
  for (const schema of pkg.schema) {
    if (!config.includes(`'${schema}'`)) problems.push(`${pkg.name}: drizzle.config.ts does not list ${schema}; this check and the config must name the same schema files`);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'talisman-migrations-check-'));
  try {
    cpSync(join(pkg.dir, 'drizzle'), scratch, { recursive: true });
    // Command-line options replace the config file, so the schema and dialect are given again here.
    const output = runKit(pkg.dir, ['generate', '--dialect', 'sqlite', '--schema', pkg.glob, '--out', scratch, '--name', 'drift_check']);
    if (!/No schema changes/.test(output)) {
      problems.push(`${pkg.name}: the schema changed since its last migration was generated; run \`pnpm --filter ${pkg.name} db:generate\` (drizzle-kit said: ${output.trim().split('\n').at(-1)})`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const coreDdl = declaredDdl(core);
const pluginDdl = declaredDdl(plugin);
const coreMigrations = inOrder(migrations(core));
const pluginMigrations = inOrder(migrations(plugin));
const read = (paths) => paths.map((path) => readFileSync(path, 'utf8'));

const coreDeclared = outline(database([coreDdl]));
const coreMigrated = outline(database(read(coreMigrations)));
compare(core.name, coreDeclared, coreMigrated);
if (coreMigrated.triggers.length) problems.push(`${core.name}: the core's migrations create triggers: ${coreMigrated.triggers.join(', ')}`);

const bothDeclared = outline(database([coreDdl, pluginDdl]));
const bothMigrated = outline(database(read(inOrder([...coreMigrations, ...pluginMigrations]))));
compare(plugin.name, bothDeclared, bothMigrated);
if (!bothMigrated.triggers.length) problems.push(`${plugin.name}: the commerce triggers are missing from the migrations`);

snapshotCurrent(core);
snapshotCurrent(plugin);

if (problems.length) {
  console.error(`Migrations check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`${core.name}: ${coreMigrations.length} migration(s) build the ${coreDeclared.objects.filter((line) => line.endsWith(' PK')).length} declared tables' schema exactly.`);
console.log(`${plugin.name}: ${pluginMigrations.length} migration(s) add the commerce tables and ${bothMigrated.triggers.length} triggers; the schema and its snapshot agree.`);
