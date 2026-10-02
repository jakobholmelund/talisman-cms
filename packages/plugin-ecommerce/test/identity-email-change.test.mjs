import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { hashPassword } = await import(createRequire(import.meta.url).resolve('better-auth/crypto', { paths: [fileURLToPath(new URL('../../talisman-cms/', import.meta.url))] }));
import { applyAllMigrations } from './helpers/migrations.mjs';
import { identityEmailChange } from '../dist/index.js';

const env = {};
globalThis.identityEmailEnv = env;
registerHooks({ resolve(specifier, context, next) {
  const modules = {
    'cloudflare:workers': 'export const env = globalThis.identityEmailEnv;',
    'virtual:talisman-cms/email': 'export const emailProviderFactory = env => env.testProvider;',
    'virtual:talisman-cms/identity-email-change': 'export const identityEmailChangeHooks = [globalThis.identityEmailHook];',
  };
  return specifier in modules ? { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true } : next(specifier, context);
} });
globalThis.identityEmailHook = identityEmailChange;
const { LocalAuthAdapter } = await import('talisman-cms/auth/local');
const ORIGIN = 'https://cms.example.test';
const password = 'identity-email-test-password';

async function setup(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close()); sqlite.exec('PRAGMA foreign_keys = ON'); applyAllMigrations(sqlite);
  const statement = (sql, values = []) => ({
    bind: (...params) => statement(sql, params),
    all: async () => ({ results: sqlite.prepare(sql).all(...values), success: true, meta: {} }),
    raw: async () => { const query = sqlite.prepare(sql); query.setReturnArrays(true); return query.all(...values); },
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    run: async () => ({ meta: sqlite.prepare(sql).run(...values), success: true }),
  });
  const sent = [];
  Object.assign(env, { TALISMAN_AUTH_SECRET: 'identity-email-test-secret-0123456789abcdef',
    TALISMAN_EMAIL_PROVIDER: 'custom', TALISMAN_EMAIL_FROM: 'CMS <cms@example.test>', testProvider: { send: async message => { sent.push(message); return { messageId: 'fixture' }; } },
    DB: { prepare: sql => statement(sql), async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const query of statements) results.push(await query.all()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } },
  });
  const now = Math.floor(Date.now() / 1000);
  for (const [id, role, email] of [['admin', 'admin', 'admin@example.test'], ['staff', 'editor', 'staff@example.test']]) {
    sqlite.prepare('INSERT INTO galaxy_auth_user (id,name,email,email_verified,created_at,updated_at,role) VALUES (?,?,?,1,?,?,?)').run(id,id,email,now,now,role);
    sqlite.prepare("INSERT INTO galaxy_auth_account (id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES (?,?,'credential',?,?,?,?)")
      .run(id,id,id,await hashPassword(password),now,now);
  }
  sqlite.prepare('INSERT INTO _ecommerce_customer_accounts (id,cms_user_id,email,email_normalized,credit_balance,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('shopper','staff','staff@example.test','staff@example.test',500,now,now);
  sqlite.prepare('INSERT INTO _ecommerce_customer_sessions (id,account_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)').run('shop-session','shopper','fixture-hash',now+3600,now);
  for (const email of ['staff@example.test','confirmed@example.test']) sqlite.prepare('INSERT INTO _ecommerce_sign_in_tokens (token_hash,email_normalized,expires_at,created_at) VALUES (?,?,?,?)').run(email,email,now+3600,now);
  sqlite.prepare('INSERT INTO _ecommerce_orders (id,user_id,subtotal_amount,total_amount,customer_email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('order','staff',500,500,'staff@example.test',now,now);
  const adapter = LocalAuthAdapter('/admin');
  const signIn = email => adapter.handle(new Request(`${ORIGIN}/admin/api/auth/sign-in/email`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email,password}) }));
  const signed = await signIn('admin@example.test'); assert.equal(signed.status,200);
  await signIn('staff@example.test');
  const cookie = signed.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const action = async (path, body) => {
    const response = await adapter.handle(new Request(`${ORIGIN}/admin/api/auth/admin/${path}`, {method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN,Cookie:cookie},body:JSON.stringify({userId:'staff',...body})}));
    return {status:response.status,json:await response.json()};
  };
  const profile = await action('get-user-profile',{});
  const requested = await action('request-email-change',{email:'confirmed@example.test',version:profile.json.version});
  assert.equal(requested.status,200,JSON.stringify(requested.json));
  const code = sent[0].text.match(/\b[a-f0-9]{48}\b/)?.[0]; assert.ok(code);
  return {sqlite,action,code};
}

test('confirmed staff email preserves linked account, credit and order snapshots, and ends both session types',async t=>{
  const {sqlite,action,code}=await setup(t);
  const result=await action('confirm-email-change',{code}); assert.equal(result.status,200,JSON.stringify(result.json));
  const account=sqlite.prepare('SELECT * FROM _ecommerce_customer_accounts WHERE id=?').get('shopper');
  assert.equal(account.cms_user_id,'staff'); assert.equal(account.credit_balance,500); assert.equal(account.email,'confirmed@example.test');
  assert.equal(account.session_version,1); assert.ok(account.email_verified_at);
  assert.equal(sqlite.prepare('SELECT email FROM galaxy_auth_user WHERE id=?').get('staff').email,account.email);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM galaxy_auth_session WHERE user_id=?').get('staff').n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM _ecommerce_customer_sessions').get().n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM _ecommerce_sign_in_tokens').get().n,0);
  assert.equal(sqlite.prepare('SELECT customer_email FROM _ecommerce_orders WHERE id=?').get('order').customer_email,'staff@example.test');
  assert.equal((await action('confirm-email-change',{code})).status,400);
});

test('another shopper identity owning the destination rolls back all identity and session changes',async t=>{
  const {sqlite,action,code}=await setup(t); const now=Math.floor(Date.now()/1000);
  sqlite.prepare('INSERT INTO _ecommerce_customer_accounts (id,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('other','confirmed@example.test','confirmed@example.test',now,now);
  t.mock.method(console,'error',()=>{});
  assert.equal((await action('confirm-email-change',{code})).status,409);
  assert.equal(sqlite.prepare('SELECT email FROM galaxy_auth_user WHERE id=?').get('staff').email,'staff@example.test');
  const account=sqlite.prepare('SELECT * FROM _ecommerce_customer_accounts WHERE id=?').get('shopper');
  assert.equal(account.email,'staff@example.test'); assert.equal(account.session_version,0); assert.equal(account.credit_balance,500);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM _ecommerce_customer_sessions').get().n,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM _ecommerce_sign_in_tokens').get().n,2);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM galaxy_auth_session WHERE user_id=?').get('staff').n,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM galaxy_auth_verification').get().n,1);
});
