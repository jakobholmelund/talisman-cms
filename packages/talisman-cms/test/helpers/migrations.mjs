import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { getTableName, is } from 'drizzle-orm';
import { SQLiteColumn, getTableConfig } from 'drizzle-orm/sqlite-core';
import { listMigrationSources } from '../../dist/migrations.js';

// The core ships its migrations in drizzle/, one folder per migration as drizzle-kit writes them.
// These helpers apply them the way `wrangler d1 migrations apply` does, to an in-memory database
// with foreign keys on, as D1 enforces them, and compare a database with the Drizzle schema.
export const coreMigrationsDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));
export const coreMigrationSource = { name: 'talisman-cms', dir: coreMigrationsDir };

/** The core's migrations in wrangler's order: `{ name, source, path }` for each. */
export function coreMigrationFiles() {
  return listMigrationSources([coreMigrationSource]);
}

export function openDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** Apply one migration file atomically, as D1 does: a failing file leaves nothing behind. */
export function applyMigrationFile(db, file) {
  db.exec('BEGIN');
  try {
    db.exec(readFileSync(file.path, 'utf8'));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`${file.name}: ${error.message}`, { cause: error });
  }
}

/** Apply every core migration, in order, and return the names applied. */
export function applyCoreMigrations(db) {
  const files = coreMigrationFiles();
  for (const file of files) applyMigrationFile(db, file);
  return files.map((file) => file.name);
}

export const rows = (db, sql, ...params) => db.prepare(sql).all(...params).map((row) => ({ ...row }));
export const row = (db, sql, ...params) => rows(db, sql, ...params)[0];

/** The tables of the schema, without wrangler's own `d1_migrations`. */
export function tableNames(db) {
  return rows(db, `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY name`).map(({ name }) => name);
}

/**
 * A readable outline of a database: each table's columns with their type, NOT NULL, default and
 * primary key flag, its indexes (unique constraints included, by their columns), its foreign keys
 * and its CHECK constraints, plus the triggers. Two databases with equal outlines enforce the same rules.
 */
export function outline(db) {
  const tables = {};
  for (const table of tableNames(db)) {
    const sql = row(db, 'SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?', 'table', table).sql;
    const columns = Object.fromEntries(rows(db, 'SELECT * FROM pragma_table_info(?)', table).map((column) => [column.name, {
      type: column.type.toLowerCase(), notNull: column.notnull === 1, default: column.dflt_value, primaryKey: column.pk > 0,
    }]));
    const indexes = rows(db, 'SELECT name, "unique", origin, partial FROM pragma_index_list(?)', table)
      .filter((index) => index.origin !== 'pk')
      .map((index) => {
        const keys = rows(db, 'SELECT name FROM pragma_index_info(?) ORDER BY seqno', index.name).map(({ name }) => name ?? '<expression>').join(', ');
        return index.origin === 'u' ? `UNIQUE (${keys})` : `${index.name} (${keys})${index.unique ? ' UNIQUE' : ''}${index.partial ? ' WHERE ...' : ''}`;
      }).sort();
    const foreignKeys = rows(db, 'SELECT "from", "table", "to", on_delete FROM pragma_foreign_key_list(?)', table)
      .map((key) => `${key.from} -> ${key.table}.${key.to}${key.on_delete === 'NO ACTION' ? '' : ` ON DELETE ${key.on_delete}`}`).sort();
    const checks = (sql.match(/\bCHECK\s*\(/gi) ?? []).length;
    tables[table] = { columns, indexes, foreignKeys, checks };
  }
  const triggers = rows(db, `SELECT name, tbl_name FROM sqlite_schema WHERE type = 'trigger'`).map((trigger) => `${trigger.name} ON ${trigger.tbl_name}`).sort();
  return { tables, triggers };
}

/** How SQLite prints a Drizzle column default in `pragma_table_info`, as drizzle-kit writes it. */
function renderDefault(value) {
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `'${JSON.stringify(value)}'`;
}

/** The outline a Drizzle table declares, in the shape `outline()` gives for a database table. */
function declaredOutline(table) {
  const config = getTableConfig(table);
  const primaryKeys = new Set([...config.columns.filter((column) => column.primary), ...config.primaryKeys.flatMap((key) => key.columns)].map((column) => column.name));
  const columns = Object.fromEntries(config.columns.map((column) => [column.name, {
    type: column.getSQLType().toLowerCase(),
    notNull: column.notNull,
    default: column.hasDefault && column.default !== undefined ? renderDefault(column.default) : null,
    primaryKey: primaryKeys.has(column.name),
  }]));
  const indexes = [
    ...config.columns.filter((column) => column.isUnique).map((column) => `UNIQUE (${column.name})`),
    ...config.uniqueConstraints.map((unique) => `UNIQUE (${unique.columns.map((column) => column.name).join(', ')})`),
    ...config.indexes.map((index) => {
      const keys = index.config.columns.map((column) => (is(column, SQLiteColumn) ? column.name : '<expression>')).join(', ');
      return `${index.config.name} (${keys})${index.config.unique ? ' UNIQUE' : ''}${index.config.where ? ' WHERE ...' : ''}`;
    }),
  ].sort();
  const foreignKeys = config.foreignKeys.flatMap((key) => {
    const { columns, foreignColumns, foreignTable } = key.reference();
    const action = key.onDelete && key.onDelete !== 'no action' ? ` ON DELETE ${key.onDelete.toUpperCase()}` : '';
    return columns.map((column, index) => `${column.name} -> ${getTableName(foreignTable)}.${foreignColumns[index].name}${action}`);
  }).sort();
  return { name: config.name, columns, indexes, foreignKeys, checks: config.checks.length };
}

/**
 * Asserts that `db` holds exactly the tables the Drizzle `tables` declare, each with exactly the
 * declared columns (type, NOT NULL, default and primary key), indexes and unique rules, foreign keys
 * with their actions, and number of CHECK constraints. drizzle-kit writes a text primary key without
 * NOT NULL, so a primary key column's NOT NULL is not compared.
 */
export function assertMatchesSchema(db, tables) {
  const declared = tables.map(declaredOutline);
  const actual = outline(db).tables;
  assert.deepEqual(Object.keys(actual).sort(), declared.map((table) => table.name).sort(), 'the database holds exactly the declared tables');
  for (const table of declared) {
    const found = actual[table.name];
    const comparable = (columns) => Object.fromEntries(Object.entries(columns).map(([name, column]) =>
      [name, column.primaryKey ? { ...column, notNull: 'primary key' } : column]));
    assert.deepEqual(comparable(found.columns), comparable(table.columns), `${table.name}: columns`);
    assert.deepEqual(found.indexes, table.indexes, `${table.name}: indexes and unique rules`);
    assert.deepEqual(found.foreignKeys, table.foreignKeys, `${table.name}: foreign keys`);
    assert.equal(found.checks, table.checks, `${table.name}: CHECK constraints`);
  }
}

/** Every schema object with its full SQL and column details, to compare two databases exactly. */
export function fullSchema(db) {
  const objects = rows(db, `SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name`);
  const columns = Object.fromEntries(tableNames(db).map((table) => [table, rows(db, 'SELECT * FROM pragma_table_xinfo(?)', table)]));
  return { objects, columns };
}

export function assertIntegrity(db) {
  assert.deepEqual(rows(db, 'PRAGMA foreign_key_check'), []);
  assert.deepEqual(rows(db, 'PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);
}

/** A fixed Unix time for seeded rows. */
export const T = 1_700_000_000;
