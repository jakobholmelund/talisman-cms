import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The core reads and writes through `createDbClient(env)` (src/db/client.ts), the one place that
// holds the D1 binding: the query builder, and `sql` templates run through the client. D1's own
// statement API is never called elsewhere. CLAUDE.md, "Database access", has the rules.

const RAW_D1 = /\bDB\.(prepare|batch|exec|dump)\(|\bD1PreparedStatement\b/;

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) yield* sources(join(dir, entry.name));
    else if (/\.tsx?$/.test(entry.name)) yield join(dir, entry.name);
  }
}

test('the core uses the D1 API through the Drizzle client only', () => {
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const offenders = [...sources(src)].filter((file) => RAW_D1.test(readFileSync(file, 'utf8'))).map((file) => file.slice(src.length));
  assert.deepEqual(offenders, [], 'these files call D1 directly; use createDbClient(env) with the builder or a sql template');
});
