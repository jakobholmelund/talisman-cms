import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

export function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(dir).sort()) sqlite.exec(readFileSync(new URL(`${name}/migration.sql`, dir), 'utf8'));
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async all() { return { results: statement.all(...values) }; },
        async first() { return statement.get(...values) ?? null; },
        async raw() { const raw = sqlite.prepare(sql); raw.setReturnArrays(true); return raw.all(...values); },
        async run() { return { meta: statement.run(...values) }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { sqlite, DB };
}
