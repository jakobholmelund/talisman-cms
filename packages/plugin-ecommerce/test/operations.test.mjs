import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyAllMigrations } from './helpers/migrations.mjs';
const stubs = {
  'cloudflare:workers': 'export const env = new Proxy({}, { get: (_, key) => globalThis.workerEnv?.[key] });',
  'talisman-cms/auth/guard': "export async function authorizeCmsRequest() { const user = globalThis.cmsUser; return !user ? { response: new Response(null, {status:401}) } : user.role !== 'admin' ? { response: new Response(null, {status:403}) } : {user}; }",
  'virtual:talisman-cms/email': 'export const emailProviderFactory = null;',
  'virtual:talisman-cms/ecommerce-emails': 'export const emailTemplates = null;',
};
registerHooks({ resolve(specifier, context, next) { return specifier in stubs ? {url:`data:text/javascript,${encodeURIComponent(stubs[specifier])}`,shortCircuit:true} : next(specifier,context); } });
const { readCommerceAttention, readStockOverview, listEmailRecovery, retryCommerceEmail } = await import('../dist/operations.js');
const { deliverPendingCommerceEmails } = await import('../dist/api.js');
const route = (await import('../dist/routes/ecommerce-admin-operations.js')).ALL;
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(sqlite);
  const recorded = [];
  const DB = {
    prepare(sql) {
      const prepared = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        rows() { recorded.push([sql, values]); return { results: prepared.all(...values) }; },
        async all() { return this.rows(); },
        async first() { recorded.push([sql, values]); return prepared.get(...values) ?? null; },
        async raw() {
          recorded.push([sql, values]);
          const raw = sqlite.prepare(sql);
          raw.setReturnArrays(true);
          return raw.all(...values);
        },
        async run() { recorded.push([sql, values]); return { meta: prepared.run(...values) }; }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map((statement) => statement.rows());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  return { sqlite, DB, recorded };
}

const NOW = Math.floor(Date.now() / 1000);
function order(sqlite, id = 'order', status = 'paid', provider = 'stripe', created = NOW - 864000) {
  sqlite.prepare(`INSERT INTO _ecommerce_orders(id,status,payment_provider,subtotal_amount,total_amount,customer_email,shipping_address,created_at,updated_at)
    VALUES (?, ?, ?, 1000, 1000, 'buyer@example.test', '{"line1":"Fixture"}', ?, ?)`).run(id,status,provider,created,created);
}
function email(sqlite, id = 'email', {kind='order_confirmation', subject='order', status='failed', attempts=10, error='expired', claim=null, created=NOW-864000} = {}) {
  sqlite.prepare(`INSERT INTO _ecommerce_email_deliveries(id,kind,subject_id,status,attempts,last_error,claimed_at,next_attempt_at,sent_at,created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id,kind,subject,status,attempts,error,claim,created,status==='sent'?created:null,created);
}
function retry(emailId='email', fields={}) { return {requestKey:crypto.randomUUID(),emailId,reason:'Resolved sender configuration',expectedAttempts:10,expectedRetryId:null,expectedError:'expired',...fields}; }
const count = (sqlite, table) => sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test('email recovery queues atomically, preserves original age and audits one concurrent winner', async () => {
  const {sqlite,DB,recorded} = database(); order(sqlite); email(sqlite);
  const first = retry(), second = retry();
  const outcomes = await Promise.allSettled([retryCommerceEmail({DB},first,'staff'),retryCommerceEmail({DB},second,'staff')]);
  assert.equal(outcomes.filter(outcome=>outcome.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(outcome=>outcome.status==='rejected')[0].reason.name,'CommerceOperationsConflict');
  assert.equal(count(sqlite,'_ecommerce_email_recovery_decisions'),1);
  const row=sqlite.prepare('SELECT * FROM _ecommerce_email_deliveries').get();
  assert.equal(row.status,'pending'); assert.equal(row.attempts,0); assert.equal(row.created_at,NOW-864000);
  assert.ok(row.retry_requested_at>=NOW); assert.equal(row.claimed_at,null); assert.equal(row.last_error,null);
  assert.ok(recorded.every(([,values])=>values.length<=100));
  sqlite.close();
});

test('the same retry key recovers a lost response and never resets a later failure', async () => {
  const {sqlite,DB}=database(); order(sqlite); email(sqlite);
  const data=retry(); const one=await Promise.all([retryCommerceEmail({DB},data,'staff'),retryCommerceEmail({DB},data,'staff')]);
  assert.equal(one[0].decisionId,one[1].decisionId); assert.equal(count(sqlite,'_ecommerce_email_recovery_decisions'),1);
  sqlite.exec("UPDATE _ecommerce_email_deliveries SET status='failed', attempts=10, last_error='sender_rejected'");
  const replay=await retryCommerceEmail({DB},data,'staff');
  assert.equal(replay.delivery.status,'failed'); assert.equal(replay.delivery.attempts,10);
  await assert.rejects(retryCommerceEmail({DB},{...data,reason:'Different retry reason'},'staff'),{name:'CommerceOperationsConflict'});
  await assert.rejects(retryCommerceEmail({DB},data,'someone-else'),{name:'CommerceOperationsConflict'});
  await assert.rejects(retryCommerceEmail({DB},retry(),'staff'),{name:'CommerceOperationsConflict'});
  assert.equal(count(sqlite,'_ecommerce_email_recovery_decisions'),1);
  const again=await retryCommerceEmail({DB},retry('email',{expectedRetryId:one[0].decisionId,expectedError:'sender_rejected'}),'staff');
  assert.notEqual(again.decisionId,one[0].decisionId); assert.equal(count(sqlite,'_ecommerce_email_recovery_decisions'),2);
  sqlite.close();
});

test('a failed audit insert rolls back the queue change and history is append-only', async () => {
  const {sqlite,DB}=database(); order(sqlite); email(sqlite);
  sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON _ecommerce_email_recovery_decisions BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  await assert.rejects(retryCommerceEmail({DB},retry(),'staff'));
  assert.equal(sqlite.prepare('SELECT status,retry_request_id FROM _ecommerce_email_deliveries').get().status,'failed');
  assert.equal(count(sqlite,'_ecommerce_email_recovery_decisions'),0);
  sqlite.exec('DROP TRIGGER fail_audit'); await retryCommerceEmail({DB},retry(),'staff');
  assert.throws(()=>sqlite.exec("UPDATE _ecommerce_email_recovery_decisions SET reason='Changed reason'"),/append-only/);
  assert.throws(()=>sqlite.exec('DELETE FROM _ecommerce_email_recovery_decisions'),/append-only/);
  sqlite.close();
});

test('retries refuse sent, pending, cancelled, suppressed, invalid, leased, test, refunded and gift claim emails', async t => {
  const fixtures=[{status:'sent'},{status:'pending'},{status:'cancelled'},{error:'recipient_suppressed'},
    {error:'invalid_recipient'},{claim:NOW},{provider:'admin_test'},{orderStatus:'refunded'},{kind:'gift_card_claim'}, {subject:'missing'}];
  for(const fixture of fixtures) await t.test(JSON.stringify(fixture),async()=>{
    const {sqlite,DB}=database();order(sqlite,'order',fixture.orderStatus??'paid',fixture.provider??'stripe');email(sqlite,'email',fixture);
    await assert.rejects(retryCommerceEmail({DB},retry('email',{expectedError:fixture.error??'expired'}),'staff'),{name:'CommerceOperationsConflict'});
    assert.equal(count(sqlite,'_ecommerce_email_recovery_decisions'),0);sqlite.close();
  });
});

test('staff retry gives an expired email a fresh seven-day window and the scheduled sender accepts it once', async () => {
  const {sqlite,DB}=database();order(sqlite);email(sqlite);
  let sends=0; const env={DB,EMAIL:{async send(){sends++;return{messageId:'fixture'};}},TALISMAN_EMAIL_PROVIDER:'cloudflare',TALISMAN_EMAIL_FROM:'Shop <sender@example.test>'};
  await retryCommerceEmail(env,retry(),'staff');
  await deliverPendingCommerceEmails({env},{now:NOW+10});
  assert.equal(sqlite.prepare('SELECT status FROM _ecommerce_email_deliveries').get().status,'sent');
  assert.equal(sends,1);await deliverPendingCommerceEmails({env},{now:NOW+20});assert.equal(sends,1);
  sqlite.close();
});

test('shipment and correction recovery use the existing composed notice with current tracking',async()=>{
  const {sqlite,DB}=database();order(sqlite);
  sqlite.exec(`INSERT INTO _ecommerce_fulfillments(id,order_id,admin_actor,kind,completes_order,carrier,tracking_number,note,created_at)
    VALUES ('shipment','order','staff','shipment',1,'Fixture carrier','OLD','Recorded shipment',${NOW});
    INSERT INTO _ecommerce_fulfillments(id,order_id,admin_actor,kind,corrects_id,completes_order,carrier,tracking_number,note,created_at)
    VALUES ('correction','order','staff','correction','shipment',0,'Fixture carrier','NEW','Corrected tracking',${NOW+1});`);
  email(sqlite,'shipment-email',{kind:'shipment',subject:'shipment'});
  email(sqlite,'correction-email',{kind:'shipment_update',subject:'correction'});
  const sent=[];const env={DB,EMAIL:{async send(message){sent.push(message);return{messageId:'fixture'};}},TALISMAN_EMAIL_PROVIDER:'cloudflare',TALISMAN_EMAIL_FROM:'sender@example.test'};
  await retryCommerceEmail(env,retry('shipment-email'),'staff');await retryCommerceEmail(env,retry('correction-email'),'staff');
  await deliverPendingCommerceEmails({env},{now:NOW+10});
  assert.equal(sent.length,2);assert.ok(sent.every(message=>JSON.stringify(message).includes('NEW')));
  sqlite.close();
});

test('email recovery lists exact counts, pending guidance and named staff history without buyer data',async()=>{
  const {sqlite,DB}=database();order(sqlite);email(sqlite);
  sqlite.exec(`INSERT INTO galaxy_auth_user(id,name,email,role,created_at,updated_at) VALUES ('staff','Alex','staff@example.test','admin',${NOW},${NOW})`);
  await retryCommerceEmail({DB},retry(),'staff');
  email(sqlite,'pending',{subject:'missing',status:'pending',error:'not_configured'});
  email(sqlite,'claim',{kind:'gift_card_claim',subject:'purchase',error:'expired'});
  const result=await listEmailRecovery({DB});assert.equal(result.total,2);assert.equal(result.history[0].actorName,'Alex');
  assert.equal(result.rows.find(row=>row.id==='claim').retryable,false);
  assert.equal(JSON.stringify(result).includes('buyer@example.test'),false);
  sqlite.close();
});

function product(sqlite,id,{quantity=50,status='active',type='standard',name=id,sku=id}={}) {
  sqlite.prepare(`INSERT INTO _ecommerce_products(id,name,slug,sku,status,type,inventory_quantity,created_at,updated_at) VALUES (?,?,?,?,?,?,?, ?,?)`).run(id,name,id,sku,status,type,quantity,NOW,NOW);
}
function group(sqlite,id,p,quantity=8) {sqlite.prepare(`INSERT INTO _ecommerce_product_variants(id,product_id,name,inventory_quantity,created_at,updated_at) VALUES (?,?,?, ?,?,?)`).run(id,p,id,quantity,NOW,NOW);}
function value(sqlite,id,g,quantity=null) {
  sqlite.prepare(`INSERT INTO _ecommerce_product_variant_values(id,product_variant_id,value,created_at,updated_at) VALUES (?,?,?, ?,?)`).run(id,g,id,NOW,NOW);
  if(quantity!==null)sqlite.prepare(`INSERT INTO _ecommerce_stocks(id,product_variant_value_id,quantity,created_at,updated_at) VALUES (?,?,?, ?,?)`).run('stock-'+id,id,quantity,NOW,NOW);
}
test('stock overview matches checkout precedence, shared part requirements and group fallback',async()=>{
  const {sqlite,DB}=database();product(sqlite,'base',{quantity:2});product(sqlite,'options',{quantity:0});group(sqlite,'group','options',8);
  value(sqlite,'stock','group',3);value(sqlite,'fallback','group');value(sqlite,'parts','group',100);
  product(sqlite,'legacy',{quantity:0});group(sqlite,'legacy-group','legacy',4);
  product(sqlite,'draft',{quantity:0,status:'draft'});product(sqlite,'digital',{quantity:0,type:'digital'});
  sqlite.exec(`INSERT INTO _ecommerce_components(id,sku,name,quantity,created_at,updated_at) VALUES ('part','PART','Part',5,${NOW},${NOW}),('part2','PART2','Part 2',12,${NOW},${NOW});
    INSERT INTO _ecommerce_variant_components(id,product_variant_value_id,component_id,quantity,created_at,updated_at)
    VALUES ('r','parts','part',2,${NOW},${NOW}),('r2','parts','part2',3,${NOW},${NOW});`);
  const result=await readStockOverview({DB}); assert.equal(result.total,4);
  assert.deepEqual(Object.fromEntries(result.rows.map(row=>[row.id,row.quantity])),{base:2,parts:2,stock:3,'legacy-group':4});
  const all=await readStockOverview({DB},{filter:'all'});assert.equal(all.rows.find(row=>row.id==='fallback').quantity,8);
  assert.ok(!all.rows.some(row=>['options','draft','digital','group','legacy'].includes(row.id)));
  assert.deepEqual(all.rows.map(row=>[row.id,row.targetType,row.targetId]).sort(), [
    ['base','product','base'],['fallback','variant','group'],['legacy-group','variant','legacy-group'],['parts',null,null],['stock','stock','stock-stock']
  ].sort(), 'actions point at the physical count, never at derived shared-component availability');
  const parts=await readStockOverview({DB},{view:'components'});assert.equal(parts.total,1);assert.equal(parts.rows[0].id,'part');
  sqlite.exec("UPDATE _ecommerce_components SET quantity=0 WHERE id='part'");
  assert.equal((await readStockOverview({DB},{filter:'unavailable'})).rows[0].id,'parts');
  sqlite.close();
});

test('stock filtering covers later catalog rows, paginates and treats search wildcard text literally',async()=>{
  const {sqlite,DB}=database();for(let i=0;i<125;i++)product(sqlite,`p${String(i).padStart(3,'0')}`,{quantity:i<65?99:0});
  const first=await readStockOverview({DB});assert.equal(first.total,60);assert.equal(first.rows.length,50);assert.equal(first.rows[0].id,'p065');
  const next=await readStockOverview({DB},{offset:50});assert.equal(next.rows.length,10);assert.equal(next.rows[0].id,'p115');
  product(sqlite,'literal',{quantity:1,name:'100%_\\ remaining'});
  assert.deepEqual((await readStockOverview({DB},{search:'%_\\'})).rows.map(row=>row.id),['literal']);
  assert.equal((await readStockOverview({DB},{search:"' OR 1=1 --"})).total,0);
  await assert.rejects(readStockOverview({DB},{threshold:-1}));sqlite.close();
});

test('attention counts every record, shows ten oldest and excludes test or non-shipping orders',async()=>{
  const {sqlite,DB}=database();for(let i=0;i<14;i++)order(sqlite,`paid${i}`,'paid','stripe',NOW-2000+i);
  order(sqlite,'test','paid','admin_test');order(sqlite,'digital');sqlite.exec("UPDATE _ecommerce_orders SET shipping_address=NULL WHERE id='digital'");
  order(sqlite,'parked','pending');sqlite.exec(`UPDATE _ecommerce_orders SET reconcile_review_at=${NOW-100}, reconcile_last_error='session_missing' WHERE id='parked'`);
  order(sqlite,'old','pending');order(sqlite,'new','pending','stripe',NOW);
  sqlite.exec(`UPDATE _ecommerce_orders SET tax_sync_review_at=${NOW-50} WHERE id='paid0'`);
  email(sqlite,'failed',{subject:'paid1'});email(sqlite,'test-email',{subject:'test'});
  sqlite.exec(`INSERT INTO _ecommerce_gift_cards(id,code_hash,encrypted_code,code_suffix,source,held_for_review,admin_actor,admin_reason,initial_cents,balance_cents,created_at,updated_at)
    VALUES ('card','fixture-hash','fixture-encrypted','1234','admin',1,'staff','Fixture issuance',500,500,${NOW},${NOW});`);
  const result=await readCommerceAttention({DB},NOW);assert.equal(result.counts.shipment,14);assert.equal(result.rows.filter(row=>row.kind==='shipment').length,10);
  assert.equal(result.rows.filter(row=>row.kind==='shipment')[0].id,'paid0');
  assert.equal(result.counts.payment_review,1);assert.equal(result.counts.older_payments,1);assert.equal(result.counts.tax_review,1);
  assert.equal(result.counts.email,1);assert.equal(result.counts.gift_hold,1);
  assert.ok(!JSON.stringify(result).includes('buyer@example.test'));sqlite.close();
});

test('operations route enforces admin, same origin, input validation and no-store without sending mail',async()=>{
  const {sqlite,DB}=database();order(sqlite);email(sqlite);globalThis.workerEnv={DB};
  const request=(method='GET',body,origin='https://shop.test')=>route({request:new Request('https://shop.test/admin/api/ecommerce/operations?view=attention',{method,headers:{origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})});
  globalThis.cmsUser=null;assert.equal((await request()).status,401);
  globalThis.cmsUser={id:'editor',role:'editor'};assert.equal((await request()).status,403);
  globalThis.cmsUser={id:'staff',role:'admin'};
  assert.equal((await request('POST',{action:'retryEmail',data:retry()},'https://other.test')).status,403);
  assert.equal((await request('DELETE')).status,405);
  assert.equal((await request('POST',{action:'retryEmail',data:{}})).status,400);
  const get=await request();assert.equal(get.status,200);assert.equal(get.headers.get('cache-control'),'no-store');
  const post=await request('POST',{action:'retryEmail',data:retry()});assert.equal(post.status,200);
  assert.equal((await request('POST',{action:'retryEmail',data:retry()})).status,409);
  globalThis.workerEnv=null;globalThis.cmsUser=null;sqlite.close();
});

test('attention includes parked purchases, tax reversals and open disputes, excluding closed outcomes',async()=>{
  const {sqlite,DB}=database();order(sqlite);
  sqlite.exec(`INSERT INTO _ecommerce_gift_card_purchases(id,buyer_email,amount_cents,access_token_hash,reconcile_review_at,created_at,updated_at)
    VALUES ('purchase','buyer@example.test',500,'fixture-hash',${NOW-50},${NOW-100},${NOW-100});
    UPDATE _ecommerce_orders SET tax_transaction_id='tax_fixture',provider_refunded_cents=100 WHERE id='order';
    INSERT INTO _ecommerce_tax_reversals(id,order_id,reference,amount,provider_reversal_id,tax_sync_review_at,created_at)
      VALUES ('reversal','order','reversal-fixture',100,'',${NOW-20},${NOW-100});
    INSERT INTO _ecommerce_disputes(id,provider,order_id,amount_cents,currency,status,status_before,created_at,updated_at)
      VALUES ('dispute','stripe','order',100,'usd','needs_response','paid',${NOW-10},${NOW-10});
    INSERT INTO _ecommerce_disputes(id,provider,gift_card_purchase_id,amount_cents,currency,status,status_before,created_at,updated_at,closed_at)
      VALUES ('closed','stripe','purchase',100,'usd','won','paid',${NOW-10},${NOW-10},${NOW});`);
  const result=await readCommerceAttention({DB},NOW);
  assert.equal(result.counts.payment_review,1);assert.equal(result.rows.find(row=>row.kind==='payment_review').id,'purchase');
  assert.equal(result.counts.tax_review,1);assert.equal(result.rows.find(row=>row.kind==='tax_review').id,'reversal');
  assert.equal(result.counts.dispute,1);assert.equal(result.rows.find(row=>row.kind==='dispute').id,'dispute');
  sqlite.close();
});

test('failed-email pages retain exact counts and non-retryable recipient guidance',async()=>{
  const {sqlite,DB}=database();for(let i=0;i<55;i++){const id=`order-${i}`;order(sqlite,id);email(sqlite,`email-${String(i).padStart(2,'0')}`,{subject:id,error:i===0?'recipient_suppressed':'expired'});}
  const first=await listEmailRecovery({DB});const next=await listEmailRecovery({DB},{offset:50});
  assert.equal(first.total,55);assert.equal(first.rows.length,50);assert.equal(next.rows.length,5);
  assert.equal(first.rows[0].retryable,false);assert.match(first.rows[0].guidance,/cannot receive/);
  assert.equal(new Set([...first.rows,...next.rows].map(row=>row.id)).size,55);sqlite.close();
});
