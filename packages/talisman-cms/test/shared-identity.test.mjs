import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ensureVerifiedEmailIdentity } from '../dist/auth/identity.js';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const localAuth = readFileSync(new URL('../drizzle/0007_local_auth.sql', import.meta.url), 'utf8');
  db.exec(localAuth);
  db.exec(`CREATE TABLE _ecommerce_customer_accounts (
    id text PRIMARY KEY NOT NULL, email text NOT NULL, email_normalized text NOT NULL UNIQUE,
    email_verified_at integer, name text, created_at integer NOT NULL, updated_at integer NOT NULL
  )`);
  return db;
}

function applySharedIdentityMigration(db) {
  const sql = readFileSync(new URL('../drizzle/0019_shared_customer_identity.sql', import.meta.url), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement);
  }
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

test('verified shoppers share an existing editor identity; unverified checkout email stays unlinked', () => {
  const db = database();
  try {
    const now = 1789600000;
    db.prepare(`INSERT INTO galaxy_auth_user
      (id, name, email, email_verified, created_at, updated_at, role)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('editor-1', 'Editor', 'editor@example.test', 0, now, now, 'editor');
    const insertShopper = db.prepare(`INSERT INTO _ecommerce_customer_accounts
      (id, email, email_normalized, email_verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    insertShopper.run('shop-1', 'editor@example.test', 'editor@example.test', now, now, now);
    insertShopper.run('shop-2', 'new@example.test', 'new@example.test', now, now, now);
    insertShopper.run('shop-3', 'unverified@example.test', 'unverified@example.test', null, now, now);

    applySharedIdentityMigration(db);
    assert.equal(db.prepare(`SELECT cms_user_id FROM _ecommerce_customer_accounts WHERE id = 'shop-1'`).get().cms_user_id, 'editor-1');
    const newShopper = db.prepare(`SELECT id, role FROM galaxy_auth_user WHERE email = 'new@example.test'`).get();
    assert.equal(newShopper.role, 'customer');
    assert.equal(db.prepare(`SELECT cms_user_id FROM _ecommerce_customer_accounts WHERE id = 'shop-2'`).get().cms_user_id, newShopper.id);
    assert.equal(db.prepare(`SELECT cms_user_id FROM _ecommerce_customer_accounts WHERE id = 'shop-3'`).get().cms_user_id, null);
    assert.equal(db.prepare(`SELECT auth_method FROM galaxy_auth_session LIMIT 1`).get(), undefined);
    assert.throws(() => db.prepare(`INSERT INTO galaxy_auth_user
      (id, name, email, email_verified, created_at, updated_at, role)
      VALUES ('duplicate', 'Duplicate', 'EDITOR@example.test', 1, 1, 1, 'customer')`).run(), /UNIQUE/);
    db.prepare(`DELETE FROM galaxy_auth_user WHERE id = ?`).run('editor-1');
    assert.equal(db.prepare(`SELECT cms_user_id FROM _ecommerce_customer_accounts WHERE id = 'shop-1'`).get().cms_user_id, null);
  } finally { db.close(); }
});

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
