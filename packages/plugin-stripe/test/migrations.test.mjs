import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { database } from './database.mjs';

const outline = db => db.prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name, sql }) => [name, sql.replace(/[`"\s]/g, '')]);
test('generated migrations match the plugin Drizzle schema with foreign keys enabled', () => {
  const exported = spawnSync('pnpm', ['exec', 'drizzle-kit', 'export'], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
  assert.equal(exported.status, 0, exported.stderr);
  const declared = new DatabaseSync(':memory:');
  const ddl = exported.stdout.split('\n').filter(line => !/^(No config path|Reading config file)/.test(line)).join('\n');
  declared.exec(ddl);
  const migrated = database().sqlite;
  assert.deepEqual(outline(migrated), outline(declared));
  assert.throws(() => migrated.exec("INSERT INTO _stripe_sync_operations(id, sync_id, method, payload_hash, started_at, updated_at) VALUES ('op', 'absent', 'create', 'hash', 0, 0)"), /FOREIGN KEY/);
  declared.close(); migrated.close();
});
