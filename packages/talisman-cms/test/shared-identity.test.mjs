import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { applyCoreMigrations } from './helpers/migrations.mjs';
import { ensureVerifiedEmailIdentity } from '../dist/auth/identity.js';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyCoreMigrations(db);
  return db;
}

function d1(db) {
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        bind(...values) {
          return {
            run: async () => statement.run(...values),
            first: async () => statement.get(...values) ?? null,
            all: async () => ({ results: statement.all(...values) }),
            raw: async () => { const raw = db.prepare(sql); raw.setReturnArrays(true); return raw.all(...values); },
          };
        },
      };
    },
  };
}


test('verified email identity helper reuses existing users and creates customer identities', async () => {
  const db = database();
  try {
    const env = { DB: d1(db) };
    const shopperId = await ensureVerifiedEmailIdentity(env, 'New@Example.Test', 'New Shopper');
    assert.equal(await ensureVerifiedEmailIdentity(env, 'new@example.test', 'Another Name'), shopperId);
    const user = db.prepare(`SELECT email, email_verified, role FROM galaxy_auth_user WHERE id = ?`).get(shopperId);
    assert.deepEqual({ ...user }, { email: 'new@example.test', email_verified: 1, role: 'customer' });
    await assert.rejects(ensureVerifiedEmailIdentity(env, 'invalid', null), /Valid verified email/);
  } finally { db.close(); }
});

test('verified identity accepts bare addresses only and refuses malformed local/domain parts before writing', async () => {
  const db = database();
  try {
    for (const email of ['Name <a@example.test>', '<a@example.test>', 'a@example.test>', 'a@-example.test', 'a@example-.test', 'a..b@example.test', '.a@example.test', 'a.@example.test', 'a@example.test,other@example.test', 'a@example.test\nBcc: x@example.test']) {
      await assert.rejects(ensureVerifiedEmailIdentity({ DB: d1(db) }, email), /Valid verified email/, email);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM galaxy_auth_user').get().n, 0);
    assert.ok(await ensureVerifiedEmailIdentity({ DB: d1(db) }, 'User+tag@Example.Test'));
  } finally { db.close(); }
});

test('SQL-created identities default to customer while explicit admin and editor roles remain intact', () => {
  const db = database();
  try {
    db.exec("INSERT INTO galaxy_auth_user(id,name,email,created_at,updated_at) VALUES ('customer','Customer','customer@example.test',1,1)");
    for (const role of ['admin', 'editor']) db.prepare('INSERT INTO galaxy_auth_user(id,name,email,created_at,updated_at,role) VALUES (?,?,?,1,1,?)').run(role, role, `${role}@example.test`, role);
    assert.deepEqual(db.prepare('SELECT role FROM galaxy_auth_user ORDER BY id').all().map(x => x.role), ['admin', 'customer', 'editor']);
  } finally { db.close(); }
});
