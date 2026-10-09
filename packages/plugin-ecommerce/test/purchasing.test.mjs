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
const { listSuppliers, saveSupplier, listPurchaseOrders, readPurchaseOrder, savePurchaseOrder, recordPurchaseOrder, readOperationsReport, listRefundFollowUp, readRefundCase, recordRefundFollowUp, listReplenishment, readReplenishment, saveReplenishmentPolicy, planReplenishmentDelivery, recordReplenishmentDelivery, readOrderWarehouse, recordParcelContents, receiveOrderReturn, listStockLocations, readStockHistory, recordStockMovement, inspectOrderReturn, recordStocktake, listStocktakes, readStocktakeTargets } = await import('../dist/operations.js');
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


const supplierInput=(extra={})=>({supplierId:null,expectedVersion:null,requestKey:crypto.randomUUID(),name:'Fixture supplier',contact:'Warehouse purchasing contact',address:'Example warehouse address',active:true,reason:'Supplier approved for purchasing',...extra});
async function supplier(env){return saveSupplier(env,supplierInput(),'staff');}
async function draft(env,s,extra={}){const result=await savePurchaseOrder(env,{purchaseOrderId:null,expectedVersion:null,requestKey:crypto.randomUUID(),supplierId:s.supplierId,supplierVersion:s.revisionId,reference:'PO-LOCAL',expectedDate:'2026-10-01',lines:[{targetType:'product',targetId:'case',quantity:10},{targetType:'component',targetId:'part',quantity:5}],reason:'Physical replenishment purchase',...extra},'staff');return {...result,supplierVersion:s.revisionId};}
const action=(p,extra={})=>({purchaseOrderId:p.purchaseOrderId,expectedVersion:p.eventId,requestKey:crypto.randomUUID(),action:'order',...(!extra.action||extra.action==='order'?{supplierVersion:p.supplierVersion}:{}),reason:'Supplier purchase order confirmed',...extra});

test('suppliers retain guarded revisions, replay receipts and inactive state',async()=>{
 const {env,sqlite:s}=fixture(),input=supplierInput(),a=await saveSupplier(env,input,'staff');assert.equal((await saveSupplier(env,input,'staff')).duplicate,true);
 await assert.rejects(saveSupplier(env,{...input,name:'Different supplier'},'staff'),/different details/);
 await assert.rejects(saveSupplier(env,supplierInput({supplierId:a.supplierId}),'staff'),/changed/);
 const archived=await saveSupplier(env,supplierInput({supplierId:a.supplierId,expectedVersion:a.revisionId,active:false}),'staff');assert.equal((await listSuppliers(env)).total,0);assert.equal((await listSuppliers(env,{filter:'all'})).rows[0].version,archived.revisionId);
 await assert.rejects(draft(env,archived),/inactive/);
 assert.throws(()=>s.exec("DELETE FROM _ecommerce_supplier_revisions"),/immutable/);
 assert.equal(count(s,'_ecommerce_supplier_revisions'),2);
});

test('drafts create no incoming inventory; confirmation atomically links every physical pool once',async()=>{
 const {env,sqlite:s,recorded}=fixture(),sup=await supplier(env),d=await draft(env,sup);assert.equal(count(s,'_ecommerce_replenishment_deliveries'),0);assert.equal(qty(s),10);
 const v=action(d),p=await recordPurchaseOrder(env,v,'staff');assert.equal((await recordPurchaseOrder(env,v,'staff')).duplicate,true);assert.equal(count(s,'_ecommerce_replenishment_deliveries'),2);assert.equal(qty(s),10);assert.equal((await listReplenishment(env,{filter:'incoming'})).total,2);
 const detail=await readPurchaseOrder(env,{purchaseOrderId:p.purchaseOrderId});assert.equal(detail.status,'ordered');assert.equal(detail.deliveries.length,2);assert.equal(detail.lines[0].name,'Shared part');
 assert.equal((await listPurchaseOrders(env)).rows[0].outstanding,15);
 await assert.rejects(recordPurchaseOrder(env,action(d),'staff'),/changed/);
 assert.ok(recorded.every(([,values])=>values.length<=100));
 assert.throws(()=>s.exec("UPDATE _ecommerce_purchase_order_events SET reference='Changed'"),/immutable/);
});

test('a missing stock target rolls back the complete confirmation including earlier lines',async()=>{
 const {env,sqlite:s}=fixture(),sup=await supplier(env),d=await draft(env,sup);s.exec("DELETE FROM _ecommerce_products WHERE id='case'");
 await assert.rejects(recordPurchaseOrder(env,action(d),'staff'),/changed/);assert.equal(count(s,'_ecommerce_replenishment_deliveries'),0);assert.equal(count(s,'_ecommerce_purchase_order_lines'),0);assert.equal((await readPurchaseOrder(env,{purchaseOrderId:d.purchaseOrderId})).status,'draft');
});

test('draft amendments are versioned; supplier details snapshot on confirmation and history does not follow edits',async()=>{
 const {env}=fixture(),sup=await supplier(env),d=await draft(env,sup);const changed=await draft(env,sup,{purchaseOrderId:d.purchaseOrderId,expectedVersion:d.eventId,reference:'PO-REVISED',lines:[{targetType:'product',targetId:'case',quantity:7}]});
 const sup2=await saveSupplier(env,supplierInput({supplierId:sup.supplierId,expectedVersion:sup.revisionId,name:'Revised supplier'}),'staff');
 const p=await recordPurchaseOrder(env,action(changed,{supplierVersion:sup2.revisionId}),'staff');const detail=await readPurchaseOrder(env,{purchaseOrderId:p.purchaseOrderId});assert.equal(detail.reference,'PO-REVISED');assert.equal(detail.supplier.name,'Revised supplier');assert.equal(detail.lines[0].quantity,7);
 await saveSupplier(env,supplierInput({supplierId:sup.supplierId,expectedVersion:sup2.revisionId,name:'Later supplier'}),'staff');assert.equal((await readPurchaseOrder(env,{purchaseOrderId:p.purchaseOrderId})).supplier.name,'Revised supplier');
 await assert.rejects(draft(env,sup2,{purchaseOrderId:d.purchaseOrderId,expectedVersion:p.eventId}),'supplier stale');
});

test('rescheduling changes effective dates, attention and reporting without rewriting original supply',async()=>{
 const {env,sqlite:s}=fixture(),sup=await supplier(env),d=await draft(env,sup),p=await recordPurchaseOrder(env,action(d),'staff');
 assert.equal((await readOperationsReport(env)).overdueDeliveries.deliveries,2);
 const v=action(p,{action:'reschedule',expectedDate:'2099-01-01'}),changed=await recordPurchaseOrder(env,v,'staff');assert.equal((await recordPurchaseOrder(env,v,'staff')).duplicate,true);
 assert.equal((await readReplenishment(env,{targetType:'product',targetId:'case'})).deliveries[0].expectedDate,'2099-01-01');assert.equal(s.prepare('SELECT expected_date FROM _ecommerce_replenishment_deliveries LIMIT 1').get().expected_date,'2026-10-01');
 assert.equal((await readOperationsReport(env)).overdueDeliveries.deliveries,0);
 const {readCommerceAttention}=await import('../dist/operations.js');assert.equal((await readCommerceAttention(env)).counts.incoming??0,0);
 await assert.rejects(recordPurchaseOrder(env,action(p,{action:'reschedule',expectedDate:'2026-10-01'}),'staff'),/changed/);assert.equal((await readPurchaseOrder(env,{purchaseOrderId:changed.purchaseOrderId})).history.length,3);
});

test('partial receipts reuse stock guards and cancelling a purchase preserves received stock',async()=>{
 const {env,sqlite:s}=fixture(),sup=await supplier(env),d=await draft(env,sup),p=await recordPurchaseOrder(env,action(d),'staff');let detail=await readPurchaseOrder(env,{purchaseOrderId:p.purchaseOrderId});const product=detail.deliveries.find(x=>detail.lines[x.lineIndex].targetId==='case');
 await receive(env,product.deliveryId,3);assert.equal(qty(s),13);assert.equal((await listPurchaseOrders(env)).rows[0].outstanding,12);
 const v=action(p,{action:'cancel'});await recordPurchaseOrder(env,v,'staff');assert.equal((await recordPurchaseOrder(env,v,'staff')).duplicate,true);assert.equal(qty(s),13);assert.equal((await listReplenishment(env,{filter:'incoming'})).total,0);assert.equal((await listPurchaseOrders(env,{filter:'cancelled'})).total,1);
 await assert.rejects(receive(env,product.deliveryId,1),/changed/);
});

test('completed purchases cannot be rescheduled and duplicate pools or invalid dates are refused',async()=>{
 const {env}=fixture(),sup=await supplier(env);await assert.rejects(draft(env,sup,{lines:[{targetType:'product',targetId:'case',quantity:1},{targetType:'product',targetId:'case',quantity:2}]}));
 await assert.rejects(draft(env,sup,{expectedDate:'2026-02-30'}));
 const d=await draft(env,sup,{lines:[{targetType:'product',targetId:'case',quantity:1}]}),p=await recordPurchaseOrder(env,action(d),'staff');const detail=await readPurchaseOrder(env,{purchaseOrderId:p.purchaseOrderId});await receive(env,detail.deliveries[0].deliveryId,1);
 assert.equal((await listPurchaseOrders(env,{filter:'completed'})).total,1);await assert.rejects(recordPurchaseOrder(env,action(p,{action:'reschedule',expectedDate:'2099-01-01'}),'staff'),/changed/);await assert.rejects(recordPurchaseOrder(env,action(p,{action:'cancel'}),'staff'),/outstanding/);
});

test('purchase and operations report routes require administrators and same-origin writes',async()=>{
 const {env}=fixture();globalThis.workerEnv=env;globalThis.cmsUser=null;
 const get=()=>route({request:new Request('https://store.test/admin/api/ecommerce/operations?view=report')});assert.equal((await get()).status,401);globalThis.cmsUser={id:'editor',role:'editor'};assert.equal((await get()).status,403);globalThis.cmsUser={id:'staff',role:'admin'};assert.equal((await get()).status,200);
 assert.equal((await route({request:new Request('https://store.test/admin/api/ecommerce/operations',{method:'POST',headers:{'Content-Type':'application/json',origin:'https://elsewhere.test'},body:JSON.stringify({action:'supplierSave',data:supplierInput()})})})).status,403);
 assert.equal((await route({request:new Request('https://store.test/admin/api/ecommerce/operations?view=report&start=2020-01-01&end=2026-01-01')})).status,400);
});

test('refund settlement queues exactly one buyer confirmation and exposes only owner-visible progress',async()=>{
 const {env,sqlite:s}=fixture(),token='owner-only-token';s.prepare('UPDATE _ecommerce_orders SET guest_access_token_hash=? WHERE id=?').run(await hashOrderAccess(token),ORDER);
 const api=bindCommerceApi({env}),owner={orderAccessToken:token},r=await returnCase(env);
 assert.equal(await api.returns.read(ORDER,{orderAccessToken:'other-owner'}),null);
 let view=await api.returns.read(ORDER,owner);assert.equal(view.refunds[0].status,'review');
 const needed=await recordRefundFollowUp(env,refund(r.receiptId),'staff');view=await api.returns.read(ORDER,owner);assert.equal(view.refunds[0].status,'needed');assert.equal(view.refunds[0].amountMinor,1000);
 assert.equal(count(s,'_ecommerce_return_refund_decisions'),1);assert.equal(s.prepare("SELECT count(*) n FROM _ecommerce_email_deliveries WHERE kind='return_refund'").get().n,0);
 s.prepare("INSERT INTO _ecommerce_provider_refunds(id,order_id,provider,amount_cents) VALUES ('confirmed-source',?,'stripe',1000)").run(ORDER);
 const input=refund(r.receiptId,{expectedVersion:needed.decisionId,status:'settled',allocations:[{kind:'provider',sourceId:'confirmed-source',amountMinor:1000}],reason:'Internal confidential decision reason'}),settled=await recordRefundFollowUp(env,input,'staff');await recordRefundFollowUp(env,input,'staff');
 assert.equal(s.prepare("SELECT count(*) n FROM _ecommerce_email_deliveries WHERE kind='return_refund'").get().n,1);
 view=await api.returns.read(ORDER,owner);assert.equal(view.refunds[0].status,'settled');assert.deepEqual(view.refunds[0].tenders,[{kind:'provider',amountMinor:1000}]);assert.doesNotMatch(JSON.stringify(view),/confirmed-source|Internal confidential|staff|fingerprint|stockTargets/);
 const sent=[];Object.assign(env,{TALISMAN_EMAIL_PROVIDER:'cloudflare',TALISMAN_EMAIL_FROM:'Local Store <orders@shop.test>',TALISMAN_PUBLIC_ORIGIN:'https://shop.test',EMAIL:{async send(message){sent.push(message);return {messageId:'local-test'};}}});
 const {deliverPendingCommerceEmails}=await import('../dist/api.js');await deliverPendingCommerceEmails({env});const email=sent.find(m=>m.headers?.['X-Talisman-Email']==='return-refund'||m.subject.includes('refund is recorded'));assert.ok(email);assert.match(email.text,/\$10\.00/);assert.match(email.text,/Original payment method/);assert.doesNotMatch(JSON.stringify(email),/confirmed-source|Internal confidential|stockTargets/);
 assert.equal(s.prepare('SELECT status FROM _ecommerce_email_deliveries WHERE subject_id=?').get(settled.decisionId).status,'sent');
 const list=await listCommerceOrdersAdmin(env,{view:'recent'});assert.ok(list.orders[0].activity.some(e=>e.kind==='email'&&e.detail==='return refund'));
});

test('refund notice failure retries through the existing outbox without repeating settlement',async()=>{
 const {env,sqlite:s}=fixture(),r=await returnCase(env);s.prepare("INSERT INTO _ecommerce_provider_refunds(id,order_id,provider,amount_cents) VALUES ('source',?,'stripe',1000)").run(ORDER);
 const d=await recordRefundFollowUp(env,refund(r.receiptId,{status:'settled',allocations:[{kind:'provider',sourceId:'source',amountMinor:1000}]}),'staff');let calls=0;Object.assign(env,{TALISMAN_EMAIL_PROVIDER:'cloudflare',TALISMAN_EMAIL_FROM:'orders@shop.test',EMAIL:{async send(message){if(!message.subject.includes('refund is recorded'))return {messageId:'other'};calls++;if(calls===1)throw Object.assign(new Error('temporary'),{code:'temporary_failure'});return {messageId:'local'};}}});
 const {deliverPendingCommerceEmails}=await import('../dist/api.js');await deliverPendingCommerceEmails({env});assert.equal(s.prepare('SELECT status FROM _ecommerce_email_deliveries WHERE subject_id=?').get(d.decisionId).status,'pending');s.prepare('UPDATE _ecommerce_email_deliveries SET next_attempt_at=0 WHERE subject_id=?').run(d.decisionId);await deliverPendingCommerceEmails({env});assert.equal(calls,2);assert.equal(count(s,'_ecommerce_return_refund_decisions'),1);
});

test('operations report separates period cohorts from current backlog and never returns free-text reasons',async()=>{
 const {env,sqlite:s}=fixture();await fulfillCommerceOrder(env,'staff',parcel(4));
 const token='return-owner';s.prepare('UPDATE _ecommerce_orders SET guest_access_token_hash=? WHERE id=?').run(await hashOrderAccess(token),ORDER);const api=bindCommerceApi({env});
 const request=await api.returns.request({orderId:ORDER,requestKey:crypto.randomUUID(),reason:'Private personal explanation',reasonCode:'size_fit',items:[{lineIndex:0,quantity:1}]},{orderAccessToken:token});assert.ok(request.requestId);
 const receipt=await returnCase(env),decision=await recordRefundFollowUp(env,refund(receipt.receiptId,{status:'not_needed',amountMinor:0}),'staff');
 const report=await readOperationsReport(env);assert.deepEqual(report.reasons.map(r=>({...r})),[{code:'size_fit',requests:1}]);assert.equal(report.conditions.find(c=>c.condition==='damaged').units,1);assert.equal(report.resolutions[0].returns,1);assert.equal(report.resolutions[0].status,'not_needed');assert.equal(report.backlog.find(x=>x.kind==='returns').count,1);assert.doesNotMatch(JSON.stringify(report),/Private personal|buyer@example|staff|fingerprint|ord_/);
 const past=await readOperationsReport(env,{start:'2020-01-01',end:'2020-01-01'});assert.equal(past.reasons.length,0);assert.equal(past.conditions.length,0);assert.equal(past.resolutions.length,0);assert.equal(past.backlog.find(x=>x.kind==='returns').count,1);
 assert.equal(past.startAt,'2020-01-01T00:00:00.000Z');assert.equal(past.endBefore,'2020-01-02T00:00:00.000Z');await assert.rejects(readOperationsReport(env,{start:'2026-10-01',end:'2026-09-30'}));await assert.rejects(readOperationsReport(env,{start:'2026-02-30',end:'2026-03-01'}));
});

test('dated shipping and refund turnaround use first dispatch and latest resolved decisions',async()=>{
 const {env,sqlite:s}=fixture();s.prepare("INSERT INTO _ecommerce_payments(id,order_id,provider,provider_id,status,amount,created_at) VALUES ('payment',?,'stripe','fixture-payment','success',4000,?)").run(ORDER,NOW-7200);
 const p=await fulfillCommerceOrder(env,'staff',parcel(4));const r=await returnCase(env);const d=await recordRefundFollowUp(env,refund(r.receiptId,{status:'not_needed',amountMinor:0}),'staff');
 // Frozen histories cannot be rewritten merely to manufacture report samples.
 const report=await readOperationsReport(env);assert.equal(report.firstShipment.orders,1);assert.ok(Math.abs(report.firstShipment.averageHours-2)<0.01);assert.ok(report.resolutions[0].averageHours>=0);
});

test('privacy export includes structured categories and refund facts; erasure suppresses queued confirmations',async()=>{
 const {env,sqlite:s}=fixture();s.exec("INSERT INTO _ecommerce_customer_accounts(id,email,email_normalized,created_at,updated_at) VALUES ('buyer','buyer@example.test','buyer@example.test',1,1)");s.prepare('UPDATE _ecommerce_orders SET user_id=? WHERE id=?').run('buyer',ORDER);
 const r=await returnCase(env),api=bindCommerceApi({env}),request=await api.returns.request({orderId:ORDER,requestKey:crypto.randomUUID(),reason:'Own private return explanation',reasonCode:'wrong_item',items:[{lineIndex:0,quantity:1}]},{customerId:'buyer'});
 const {decideReturnRequest}=await import('../dist/operations.js');await decideReturnRequest(env,{requestId:request.requestId,expectedVersion:request.requestId,requestKey:crypto.randomUUID(),status:'closed',reason:'Internal staff case resolution',customerMessage:'This request was closed as agreed.'},'staff');
 s.prepare("INSERT INTO _ecommerce_provider_refunds(id,order_id,provider,amount_cents) VALUES ('privacy-source',?,'stripe',1000)").run(ORDER);const d=await recordRefundFollowUp(env,refund(r.receiptId,{status:'settled',allocations:[{kind:'provider',sourceId:'privacy-source',amountMinor:1000}]}),'staff');
 const {manageShopperData}=await import('../dist/accounts.js');const exported=await manageShopperData(env,'staff',{accountId:'buyer',action:'export',reason:'Export requested own records'});assert.equal(exported.orders[0].operations.returnRequests[0].reasonCategory.code,'wrong_item');assert.equal(exported.orders[0].operations.returnReceipts[0].refundDecisions[0].status,'settled');assert.doesNotMatch(JSON.stringify(exported),/Internal staff|Eligible returned purchase|privacy-source/);
 await manageShopperData(env,'staff',{accountId:'buyer',action:'anonymize',reason:'Owner requested erasure after resolution'});let calls=0;Object.assign(env,{TALISMAN_EMAIL_PROVIDER:'cloudflare',TALISMAN_EMAIL_FROM:'orders@shop.test',EMAIL:{async send(){calls++;return {messageId:'local'};}}});const {deliverPendingCommerceEmails}=await import('../dist/api.js');await deliverPendingCommerceEmails({env});assert.equal(s.prepare('SELECT status FROM _ecommerce_email_deliveries WHERE subject_id=?').get(d.decisionId).status,'cancelled');assert.equal(calls,0);
});

test('parallel purchase confirmations commit once; cancellation rolls back when a receipt wins the race',async()=>{
 const {env,sqlite:s}=fixture(),sup=await supplier(env),d=await draft(env,sup);const outcomes=await Promise.allSettled([recordPurchaseOrder(env,action(d),'staff'),recordPurchaseOrder(env,action(d),'staff')]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(count(s,'_ecommerce_replenishment_deliveries'),2);
 const purchaseId=d.purchaseOrderId,detail=await readPurchaseOrder(env,{purchaseOrderId:purchaseId}),product=detail.deliveries.find(x=>detail.lines[x.lineIndex].targetId==='case');
 // Interleave a receipt immediately before the cancellation batch to exercise its frozen delivery versions.
 const batch=env.DB.batch;let first=true;env.DB.batch=async statements=>{if(first&&statements.length){first=false;env.DB.batch=batch;await receive(env,product.deliveryId,2);}return batch.call(env.DB,statements);};
 await assert.rejects(recordPurchaseOrder(env,action({purchaseOrderId:purchaseId,eventId:detail.version},{action:'cancel'}),'staff'),/changed/);
 assert.equal(qty(s),12);assert.equal((await readPurchaseOrder(env,{purchaseOrderId:purchaseId})).status,'ordered');assert.equal(s.prepare("SELECT count(*) n FROM _ecommerce_replenishment_delivery_events WHERE kind='cancelled'").get().n,0);
});
