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
const { listRefundFollowUp, readRefundCase, recordRefundFollowUp, listReplenishment, readReplenishment, saveReplenishmentPolicy, planReplenishmentDelivery, recordReplenishmentDelivery, readOrderWarehouse, recordParcelContents, receiveOrderReturn, listStockLocations, readStockHistory, recordStockMovement, inspectOrderReturn, recordStocktake, listStocktakes, readStocktakeTargets } = await import('../dist/operations.js');
const { fulfillCommerceOrder, listCommerceOrdersAdmin } = await import('../dist/fulfillment.js');
const { restockOrder, getOrderAdjustmentsAdmin } = await import('../dist/order-adjustments.js');
const { bindCommerceApi } = await import('../dist/api.js');
const { hashOrderAccess } = await import('../dist/cookies.js');
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
const ORDER = 'ord_11111111-1111-4111-8111-111111111111';
function fixture({legacy=false,parts=false,status='paid',units=4}={}) {
  const db=database(), s=db.sqlite;
  s.prepare(`INSERT INTO _ecommerce_products(id,name,slug,base_price,inventory_quantity,status,created_at,updated_at) VALUES ('case','Travel case','case',1000,10,'active',?,?)`).run(NOW,NOW);
  s.prepare(`INSERT INTO _ecommerce_components(id,name,sku,quantity,created_at,updated_at) VALUES ('part','Shared part','PART',20,?,?)`).run(NOW,NOW);
  const line={productId:'case',quantity:units,priceAtPurchase:1000,...(legacy?{}:{stockTargets:[{type:parts?'component':'product',id:parts?'part':'case',units:parts?2:1}]})};
  s.prepare(`INSERT INTO _ecommerce_orders(id,status,payment_provider,items,subtotal_amount,total_amount,customer_email,created_at,updated_at) VALUES (?,?, 'stripe',?,?,?,'buyer@example.test',?,?)`).run(ORDER,status,JSON.stringify([line]),units*1000,units*1000,NOW,NOW);
  if(parts) s.prepare(`INSERT INTO _ecommerce_component_reservations(id,order_id,component_id,quantity) VALUES ('hold',?,'part',?)`).run(ORDER,units*2);
  else s.prepare(`INSERT INTO _ecommerce_inventory_reservations(id,order_id,target_type,target_id,quantity) VALUES ('hold',?,'product','case',?)`).run(ORDER,units);
  return {...db,env:{DB:db.DB}};
}
const parcel=(qty, extra={})=>({orderId:ORDER,note:'Handed parcel to carrier',requestKey:crypto.randomUUID(),items:[{lineIndex:0,quantity:qty}],...extra});
const intake=(qty, extra={})=>({orderId:ORDER,reason:'Goods physically received',requestKey:crypto.randomUUID(),items:[{lineIndex:0,quantity:qty,condition:'sellable',restock:true}],...extra});
const stock=(extra={})=>({requestKey:crypto.randomUUID(),targetType:'product',targetId:'case',kind:'receipt',delta:3,expectedQuantity:10,expectedUpdatedAt:new Date(NOW*1000).toISOString(),reason:'Supplier delivery received',...extra});
const count=(s,t)=>s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
const qty=(s,parts=false)=>s.prepare(parts?'SELECT quantity n FROM _ecommerce_components':'SELECT inventory_quantity n FROM _ecommerce_products').get().n;


const policy=(extra={})=>({requestKey:crypto.randomUUID(),targetType:'product',targetId:'case',minimumQuantity:12,targetQuantity:25,enabled:true,expectedVersion:null,reason:'Maintain warehouse reserve',...extra});
const plan=(extra={})=>({requestKey:crypto.randomUUID(),targetType:'product',targetId:'case',quantity:15,supplier:'Local supplier',reference:'PO-001',expectedDate:'2026-10-01',reason:'Reorder warehouse reserve',...extra});
async function receive(env,id,quantity,extra={}){const d=await readReplenishment(env,{targetType:'product',targetId:'case'});return recordReplenishmentDelivery(env,{requestKey:crypto.randomUUID(),deliveryId:id,expectedVersion:d.deliveries.find(r=>r.id===id).version,kind:'received',quantity,expectedQuantity:d.location.quantity,expectedUpdatedAt:d.location.updatedAt,reason:'Supplier goods inspected',...extra},'staff');}
async function returnCase(env,quantity=1){const w=await readOrderWarehouse(env,{orderId:ORDER});if(!w.parcels.length)await fulfillCommerceOrder(env,'staff',parcel(4));return receiveOrderReturn(env,intake(quantity,{items:[{lineIndex:0,quantity,condition:'damaged',restock:false}]}),'staff');}
const refund=(receiptId,extra={})=>({receiptId,requestKey:crypto.randomUUID(),expectedVersion:receiptId,status:'needed',amountMinor:1000,allocations:[],reason:'Eligible returned purchase',...extra});

test('replenishment suggestions subtract planned incoming but planning never increases sellable stock',async()=>{
 const {env,sqlite:s}=fixture();assert.equal((await listReplenishment(env)).total,0);
 const p=policy();const saved=await saveReplenishmentPolicy(env,p,'staff');assert.equal((await saveReplenishmentPolicy(env,p,'staff')).duplicate,true);
 let rows=(await listReplenishment(env)).rows;assert.equal(rows[0].suggested,15);assert.equal(rows[0].quantity,10);
 const incoming=plan();const d=await planReplenishmentDelivery(env,incoming,'staff');assert.equal((await planReplenishmentDelivery(env,incoming,'staff')).deliveryId,d.deliveryId);
 assert.equal(qty(s),10);assert.equal((await listReplenishment(env)).total,0);rows=(await listReplenishment(env,{filter:'incoming'})).rows;assert.equal(rows[0].incoming,15);
 await assert.rejects(saveReplenishmentPolicy(env,policy(),'staff'),/policy changed/);
 await saveReplenishmentPolicy(env,policy({expectedVersion:saved.policyId,enabled:false}),'staff');assert.equal((await listReplenishment(env)).total,0);
});

test('partial delivery receipts are atomic, versioned, recoverable and cannot exceed planned units',async()=>{
 const {env,sqlite:s}=fixture();const d=await planReplenishmentDelivery(env,plan(),'staff');
 const detail=await readReplenishment(env,{targetType:'product',targetId:'case'});
 const v={requestKey:crypto.randomUUID(),deliveryId:d.deliveryId,expectedVersion:d.deliveryId,kind:'received',quantity:5,expectedQuantity:10,expectedUpdatedAt:detail.location.updatedAt,reason:'Five supplier units inspected'};
 const first=await recordReplenishmentDelivery(env,v,'staff');assert.equal(qty(s),15);assert.equal((await recordReplenishmentDelivery(env,v,'staff')).duplicate,true);assert.equal(qty(s),15);
 await assert.rejects(recordReplenishmentDelivery(env,{...v,quantity:6},'staff'),/other details/);
 await assert.rejects(receive(env,d.deliveryId,11),/changed/);assert.equal(qty(s),15);assert.equal(count(s,'_ecommerce_stock_movements'),1);
 await assert.rejects(receive(env,d.deliveryId,2,{expectedVersion:d.deliveryId}),/changed/);assert.equal(qty(s),15);
 await receive(env,d.deliveryId,10);assert.equal(qty(s),25);assert.equal((await listReplenishment(env,{filter:'incoming'})).total,0);
 await assert.rejects(receive(env,d.deliveryId,1),/changed/);assert.equal(qty(s),25);
});

test('cancellation releases outstanding expected supply without reversing received stock',async()=>{
 const {env,sqlite:s}=fixture();const d=await planReplenishmentDelivery(env,plan(),'staff');await receive(env,d.deliveryId,4);
 const detail=await readReplenishment(env,{targetType:'product',targetId:'case'});await recordReplenishmentDelivery(env,{deliveryId:d.deliveryId,expectedVersion:detail.deliveries[0].version,requestKey:crypto.randomUUID(),kind:'cancelled',reason:'Supplier cancelled remaining units'},'staff');
 assert.equal(qty(s),14);assert.equal((await listReplenishment(env,{filter:'incoming'})).total,0);await assert.rejects(receive(env,d.deliveryId,1),/changed/);assert.equal(qty(s),14);
});

test('shared components plan one physical pool and invalid dates or missing targets are refused',async()=>{
 const {env}=fixture({parts:true});await saveReplenishmentPolicy(env,policy({targetType:'component',targetId:'part',minimumQuantity:20,targetQuantity:40}),'staff');
 const q=await listReplenishment(env);assert.equal(q.total,1);assert.equal(q.rows[0].type,'component');assert.equal(q.rows[0].suggested,20);
 await assert.rejects(planReplenishmentDelivery(env,plan({expectedDate:'2026-02-30'}),'staff'));
 await assert.rejects(planReplenishmentDelivery(env,plan({targetId:'missing'}),'staff'),/unavailable/);
 await assert.rejects(saveReplenishmentPolicy(env,policy({targetQuantity:3}),'staff'));
});

test('deleted targets leave incoming delivery visible and cancellable',async()=>{
 const {env,sqlite:s}=fixture();const d=await planReplenishmentDelivery(env,plan({targetType:'component',targetId:'part'}),'staff');s.exec("DELETE FROM _ecommerce_components WHERE id='part'");
 const q=await listReplenishment(env,{filter:'incoming'});assert.equal(q.total,1);assert.match(q.rows[0].name,/Unavailable/);const r=await readReplenishment(env,{targetType:'component',targetId:'part'});assert.equal(r.location,null);
 await recordReplenishmentDelivery(env,{deliveryId:d.deliveryId,expectedVersion:d.deliveryId,requestKey:crypto.randomUUID(),kind:'cancelled',reason:'Stock pool was retired'},'staff');assert.equal((await listReplenishment(env,{filter:'incoming'})).total,0);
});

test('received returns remain in refund follow-up regardless of inspection or request status',async()=>{
 const {env}=fixture();const r=await returnCase(env);let q=await listRefundFollowUp(env);assert.equal(q.total,1);assert.equal(q.rows[0].status,'review');
 const v=refund(r.receiptId);const d=await recordRefundFollowUp(env,v,'staff');assert.equal((await recordRefundFollowUp(env,v,'staff')).duplicate,true);
 assert.equal((await readRefundCase(env,{receiptId:r.receiptId})).status,'needed');await assert.rejects(recordRefundFollowUp(env,refund(r.receiptId,{status:'not_needed',amountMinor:0}),'staff'),/changed/);
 await recordRefundFollowUp(env,refund(r.receiptId,{expectedVersion:d.decisionId,status:'not_needed',amountMinor:0,reason:'Exchange completed without refund'}),'staff');assert.equal((await listRefundFollowUp(env)).total,0);assert.equal((await listRefundFollowUp(env,{filter:'resolved'})).total,1);
});

test('settlement requires confirmed same-order money and allocations cannot be reused',async()=>{
 const {env,sqlite:s}=fixture();const a=await returnCase(env),b=await returnCase(env);
 s.prepare("INSERT INTO _ecommerce_provider_refunds(id,order_id,provider,amount_cents) VALUES ('refund',?,'stripe',1500)").run(ORDER);
 const allocate={status:'settled',amountMinor:1000,allocations:[{kind:'provider',sourceId:'refund',amountMinor:1000}]};
 await recordRefundFollowUp(env,refund(a.receiptId,allocate),'staff');assert.equal((await readRefundCase(env,{receiptId:b.receiptId})).sources[0].availableMinor,500);
 await assert.rejects(recordRefundFollowUp(env,refund(b.receiptId,allocate),'staff'),/changed/);assert.equal(count(s,'_ecommerce_return_refund_decisions'),1);
 await assert.rejects(recordRefundFollowUp(env,refund(b.receiptId,{...allocate,allocations:[{kind:'provider',sourceId:'missing',amountMinor:1000}]}),'staff'),/changed/);
 await recordRefundFollowUp(env,refund(b.receiptId,{status:'settled',amountMinor:500,allocations:[{kind:'provider',sourceId:'refund',amountMinor:500}]}),'staff');
 const c=await readRefundCase(env,{receiptId:a.receiptId});await assert.rejects(recordRefundFollowUp(env,refund(a.receiptId,{expectedVersion:c.version,status:'not_needed',amountMinor:0}),'staff'),/changed/);
 assert.equal(s.prepare('SELECT provider_refunded_cents FROM _ecommerce_orders').get().provider_refunded_cents,0);assert.equal(count(s,'_ecommerce_provider_refunds'),1);
});

test('refund plans cannot exceed paid tender across cases and missing confirmed funds roll back',async()=>{
 const {env,sqlite:s}=fixture();const a=await returnCase(env),b=await returnCase(env);await recordRefundFollowUp(env,refund(a.receiptId,{amountMinor:3500}),'staff');await assert.rejects(recordRefundFollowUp(env,refund(b.receiptId),'staff'),/changed/);
 await assert.rejects(recordRefundFollowUp(env,refund(b.receiptId,{status:'settled',amountMinor:500,allocations:[{kind:'gift_card',sourceId:'unconfirmed',amountMinor:500}]}),'staff'),/changed/);assert.equal(count(s,'_ecommerce_return_refund_decisions'),1);
});

test('intake queues one receipt notice atomically and duplicate intake never queues a second',async()=>{
 const {env,sqlite:s}=fixture();await fulfillCommerceOrder(env,'staff',parcel(4));const beforeEmails=count(s,'_ecommerce_email_deliveries');const v=intake(1,{items:[{lineIndex:0,quantity:1,condition:'damaged',restock:false}]});const r=await receiveOrderReturn(env,v,'staff');await receiveOrderReturn(env,v,'staff');
 const emails=s.prepare("SELECT kind,subject_id FROM _ecommerce_email_deliveries WHERE kind='return_received'").all();assert.deepEqual(emails.map(r=>({...r})),[{kind:'return_received',subject_id:r.receiptId}]);
 await assert.rejects(receiveOrderReturn(env,intake(5),'staff'));assert.equal(count(s,'_ecommerce_email_deliveries'),beforeEmails+1);
});

test('aftercare routes require admin, same origin and private no-store responses',async()=>{
 const {env}=fixture();globalThis.workerEnv=env;globalThis.cmsUser=null;assert.equal((await route({request:new Request('https://store.test/admin/api/ecommerce/operations?view=refunds')})).status,401);
 globalThis.cmsUser={id:'staff',role:'admin'};const response=await route({request:new Request('https://store.test/admin/api/ecommerce/operations?view=replenishment&filter=all')});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal((await route({request:new Request('https://store.test/admin/api/ecommerce/operations',{method:'POST',headers:{origin:'https://other.test'},body:'{}'})})).status,403);
});

test('return notices send escaped buyer instructions, suppress outdated decisions and retry intake mail',async()=>{
 const {env,sqlite:s}=fixture();const sent=[];let failNext=false;Object.assign(env,{TALISMAN_EMAIL_PROVIDER:'cloudflare',TALISMAN_EMAIL_FROM:'Store <orders@shop.test>',TALISMAN_PUBLIC_ORIGIN:'https://shop.test',EMAIL:{async send(message){if(failNext){failNext=false;throw Object.assign(new Error('temporary failure'),{code:'temporary_failure'});}sent.push(message);return {messageId:'local-test'};}}});
 const {deliverPendingCommerceEmails}=await import('../dist/api.js');const {decideReturnRequest}=await import('../dist/operations.js');
 await fulfillCommerceOrder(env,'staff',parcel(4));sent.length=0;
 s.prepare("INSERT INTO _ecommerce_return_requests(id,order_id,items,reason,fingerprint,created_at) VALUES ('request',?,?,'Customer item unsuitable','local-test',?)").run(ORDER,JSON.stringify([{lineIndex:0,quantity:2}]),NOW);
 const approve={requestId:'request',requestKey:crypto.randomUUID(),expectedVersion:'request',status:'approved',reason:'Internal private audit reason',customerMessage:'Return <script> goods to the staffed desk.'};const a=await decideReturnRequest(env,approve,'staff');await decideReturnRequest(env,approve,'staff');
 assert.equal(s.prepare("SELECT count(*) n FROM _ecommerce_email_deliveries WHERE kind='return_decision'").get().n,1);
 await deliverPendingCommerceEmails({env});const notice=sent.find(m=>m.subject.includes('approved'));assert.ok(notice);assert.match(notice.text,/Return <script>/);assert.doesNotMatch(notice.html,/<script>/);assert.doesNotMatch(JSON.stringify(notice),/Internal private audit/);
 // A newer closure makes a still-pending approval obsolete before any provider call.
 s.prepare("UPDATE _ecommerce_email_deliveries SET status='pending',sent_at=NULL WHERE subject_id=?").run(a.eventId);
 await decideReturnRequest(env,{...approve,requestKey:crypto.randomUUID(),expectedVersion:a.eventId,status:'closed',customerMessage:'This request has now been closed.'},'staff');const before=sent.length;await deliverPendingCommerceEmails({env});assert.equal(sent.length,before+1);assert.equal(s.prepare('SELECT status FROM _ecommerce_email_deliveries WHERE subject_id=?').get(a.eventId).status,'cancelled');
 const receipt=await returnCase(env);failNext=true;await deliverPendingCommerceEmails({env});assert.equal(s.prepare('SELECT status FROM _ecommerce_email_deliveries WHERE subject_id=?').get(receipt.receiptId).status,'pending');s.prepare('UPDATE _ecommerce_email_deliveries SET next_attempt_at=0 WHERE subject_id=?').run(receipt.receiptId);await deliverPendingCommerceEmails({env});assert.equal(s.prepare('SELECT status FROM _ecommerce_email_deliveries WHERE subject_id=?').get(receipt.receiptId).status,'sent');assert.match(sent.at(-1).text,/does not confirm a refund/);
});

test('populated email migration retains delivery and recovery history with foreign keys enforced',async()=>{
 const {migrationFiles}=await import('./helpers/migrations.mjs');const {readFileSync}=await import('node:fs');const s=new DatabaseSync(':memory:');s.exec('PRAGMA foreign_keys=ON');
 for(const file of migrationFiles()){if(file.name.startsWith('20261009095621')){s.exec("INSERT INTO _ecommerce_email_deliveries(id,kind,subject_id,status,next_attempt_at,created_at) VALUES ('mail','order_confirmation','order','failed',1,1)");s.exec("INSERT INTO _ecommerce_email_recovery_decisions(id,email_id,fingerprint,actor,reason,prior_attempts,created_at) VALUES ('audit','mail','hash','staff','Retry recorded email',2,2)");}s.exec('BEGIN');try{s.exec(readFileSync(file.path,'utf8'));s.exec('COMMIT');}catch(error){s.exec('ROLLBACK');throw error;}}
 assert.equal(s.prepare('SELECT id FROM _ecommerce_email_deliveries').get().id,'mail');assert.equal(s.prepare('SELECT email_id FROM _ecommerce_email_recovery_decisions').get().email_id,'mail');assert.deepEqual(s.prepare('PRAGMA foreign_key_check').all(),[]);s.close();
});

test('refund follow-up blocks erasure until resolved and only audited redaction changes its text',async()=>{
 const {env,sqlite:s}=fixture();const {manageShopperData}=await import('../dist/accounts.js');s.exec("INSERT INTO _ecommerce_customer_accounts(id,email,email_normalized,created_at,updated_at) VALUES ('buyer','buyer@example.test','buyer@example.test',1,1)");s.prepare('UPDATE _ecommerce_orders SET user_id=? WHERE id=?').run('buyer',ORDER);await fulfillCommerceOrder(env,'staff',parcel(4));const r=await returnCase(env);
 await assert.rejects(manageShopperData(env,'buyer',{accountId:'buyer',action:'anonymize',reason:'Customer requested erasure'}));await recordRefundFollowUp(env,refund(r.receiptId,{status:'not_needed',amountMinor:0,reason:'Exchange with private customer details'}),'staff');await manageShopperData(env,'buyer',{accountId:'buyer',action:'anonymize',reason:'Customer requested erasure'});
 assert.equal(s.prepare('SELECT reason FROM _ecommerce_return_refund_decisions').get().reason,'[redacted]');assert.throws(()=>s.exec("UPDATE _ecommerce_return_refund_decisions SET amount_minor=1"),/immutable/);assert.throws(()=>s.exec('DELETE FROM _ecommerce_return_refund_decisions'),/immutable/);
 const c=await readRefundCase(env,{receiptId:r.receiptId});await assert.rejects(recordRefundFollowUp(env,refund(r.receiptId,{expectedVersion:c.version}),'staff'),/changed/);
});

test('competing partial receipts commit one stock delta and leave the other draft stale',async()=>{
 const {env,sqlite:s}=fixture();const d=await planReplenishmentDelivery(env,plan(),'staff'),detail=await readReplenishment(env,{targetType:'product',targetId:'case'});
 const common={deliveryId:d.deliveryId,expectedVersion:d.deliveryId,kind:'received',quantity:5,expectedQuantity:10,expectedUpdatedAt:detail.location.updatedAt,reason:'Supplier receipt inspected'};
 const results=await Promise.allSettled([recordReplenishmentDelivery(env,{...common,requestKey:crypto.randomUUID()},'staff-a'),recordReplenishmentDelivery(env,{...common,requestKey:crypto.randomUUID()},'staff-b')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(qty(s),15);assert.equal(count(s,'_ecommerce_replenishment_delivery_events'),1);
});

test('competing refund cases cannot allocate the same confirmed money',async()=>{
 const {env,sqlite:s}=fixture();const a=await returnCase(env),b=await returnCase(env);s.prepare("INSERT INTO _ecommerce_provider_refunds(id,order_id,provider,amount_cents) VALUES ('concurrent-refund',?,'stripe',1000)").run(ORDER);
 const allocation={status:'settled',allocations:[{kind:'provider',sourceId:'concurrent-refund',amountMinor:1000}]};const results=await Promise.allSettled([recordRefundFollowUp(env,refund(a.receiptId,allocation),'staff-a'),recordRefundFollowUp(env,refund(b.receiptId,allocation),'staff-b')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(count(s,'_ecommerce_return_refund_decisions'),1);
});

test('confirmed split tender refunds can settle one return without exposing shopper or card identity',async()=>{
 const {env,sqlite:s}=fixture();const r=await returnCase(env);s.exec("INSERT INTO _ecommerce_customer_accounts(id,email,email_normalized,created_at,updated_at) VALUES ('refund-account','buyer@example.test','buyer@example.test',1,1)");
 s.exec("INSERT INTO _ecommerce_gift_cards(id,code_hash,encrypted_code,code_suffix,source,admin_actor,admin_reason,initial_cents,balance_cents,created_at,updated_at) VALUES ('refund-card','refund-card-hash','local-encrypted-test','1234','admin','staff','Issued local test card',500,0,1,1)");
 s.prepare("INSERT INTO _ecommerce_provider_refunds(id,order_id,provider,amount_cents) VALUES ('split-provider',?,'stripe',500)").run(ORDER);
 s.prepare("INSERT INTO _ecommerce_gift_card_ledger(id,card_id,order_id,kind,amount_cents,created_at) VALUES ('split-gift','refund-card',?,'refund_restore',250,1)").run(ORDER);
 s.prepare("INSERT INTO _ecommerce_credit_ledger(id,account_id,order_id,kind,amount_cents,created_at) VALUES ('split-credit','refund-account',?,'purchase_credit_refund',250,1)").run(ORDER);
 const detail=await readRefundCase(env,{receiptId:r.receiptId});assert.equal(detail.sources.length,3);assert.doesNotMatch(JSON.stringify(detail),/refund-account|refund-card|buyer@example/);
 await recordRefundFollowUp(env,refund(r.receiptId,{status:'settled',allocations:[{kind:'provider',sourceId:'split-provider',amountMinor:500},{kind:'gift_card',sourceId:'split-gift',amountMinor:250},{kind:'store_credit',sourceId:'split-credit',amountMinor:250}]}),'staff');assert.ok((await readRefundCase(env,{receiptId:r.receiptId})).sources.every(s=>s.availableMinor===0));
});

test('legacy erased shoppers retain read-only return history without impossible refund tasks',async()=>{
 const {env,sqlite:s}=fixture();const r=await returnCase(env);s.exec("INSERT INTO _ecommerce_customer_accounts(id,email,email_normalized,created_at,updated_at) VALUES ('erased-buyer','erased@example.test','erased@example.test',1,1)");s.prepare('UPDATE _ecommerce_orders SET user_id=? WHERE id=?').run('erased-buyer',ORDER);
 s.exec("INSERT INTO _ecommerce_shopper_audits(id,account_id,action,actor,reason,created_at) VALUES ('legacy-erasure','erased-buyer','anonymize','staff','Historical erasure before follow-up',1)");
 assert.equal((await listRefundFollowUp(env)).total,0);assert.equal((await listRefundFollowUp(env,{filter:'all'})).rows[0].status,'unavailable');assert.equal((await readRefundCase(env,{receiptId:r.receiptId})).status,'unavailable');
 const {readCommerceAttention}=await import('../dist/operations.js');assert.equal((await readCommerceAttention(env)).counts.refund??0,0);await assert.rejects(recordRefundFollowUp(env,refund(r.receiptId),'staff'),/changed/);
});

test('a valid epoch stock version is not mistaken for a removed stock record',async()=>{
 const {env,sqlite:s}=fixture();s.exec("UPDATE _ecommerce_components SET updated_at=0 WHERE id='part'");const d=await readReplenishment(env,{targetType:'component',targetId:'part'});assert.ok(d.location);assert.equal(d.location.updatedAt,'1970-01-01T00:00:00.000Z');
});
