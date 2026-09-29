import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The plugin reads and writes only through its Drizzle client (`commerceDb(env)` in src/db.ts): the
// query builder, the relational query builder, and `sql` templates run with `db.run`, `db.all` and
// `db.get`. D1's own statement API is never called, so every statement shares one client, one row
// typing and one error shape. CLAUDE.md, "Database access", has the rules.

const RAW_D1 = /\bDB\.(prepare|batch|exec|dump)\(|\bD1PreparedStatement\b/;

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) yield* sources(join(dir, entry.name));
    else if (/\.tsx?$/.test(entry.name)) yield join(dir, entry.name);
  }
}

test('the plugin uses the D1 API through the Drizzle client only', () => {
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const offenders = [...sources(src)].filter((file) => RAW_D1.test(readFileSync(file, 'utf8'))).map((file) => file.slice(src.length));
  assert.deepEqual(offenders, [], 'these files call D1 directly; use commerceDb(env) with the builder or a sql template');
});
