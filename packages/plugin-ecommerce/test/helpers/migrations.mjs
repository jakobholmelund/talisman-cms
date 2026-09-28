import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listMigrationSources } from 'talisman-cms/migrations';

// The plugin ships its migrations in drizzle/, one folder per migration as drizzle-kit writes them,
// and so does the core; a site applies both from one assembled folder. These helpers apply them the
// way `wrangler d1 migrations apply` does. The database helpers are the core's.
export { T, applyMigrationFile, assertIntegrity, assertMatchesSchema, fullSchema, openDatabase, outline, row, rows, tableNames }
  from '../../../talisman-cms/test/helpers/migrations.mjs';

export const pluginMigrationsDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));
export const coreMigrationsDir = fileURLToPath(new URL('../../../talisman-cms/drizzle/', import.meta.url));
export const migrationSources = [
  { name: 'talisman-cms', dir: coreMigrationsDir },
  { name: '@talisman-cms/plugin-ecommerce', dir: pluginMigrationsDir },
];

/** Every migration a site applies, core and plugin, in wrangler's order: `{ name, source, path }` for each. */
export function migrationFiles() {
  return listMigrationSources(migrationSources);
}

/** The file names of `migrationFiles()`. */
export function migrationFileNames() {
  return migrationFiles().map((file) => file.name);
}

/** The SQL of one migration, by its assembled file name (`<timestamp>_<name>.sql`) or that name without `.sql`. */
export function migrationSql(name) {
  const file = name.endsWith('.sql') ? name : `${name}.sql`;
  const found = migrationFiles().find((migration) => migration.name === file);
  if (!found) throw new Error(`${file}: not in the plugin's or the core's drizzle folder`);
  return readFileSync(found.path, 'utf8');
}

/** Apply every migration, the core's and the plugin's, in order, as D1 does; returns the names applied. */
export function applyAllMigrations(db) {
  const files = migrationFiles();
  for (const file of files) {
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(file.path, 'utf8'));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`${file.name}: ${error.message}`, { cause: error });
    }
  }
  return files.map((file) => file.name);
}
