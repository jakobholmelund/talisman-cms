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
