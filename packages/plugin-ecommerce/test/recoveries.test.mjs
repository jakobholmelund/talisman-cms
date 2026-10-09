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
const { readOrderWarehouse, recordParcelContents, receiveOrderReturn, listStockLocations, readStockHistory, recordStockMovement, inspectOrderReturn, recordStocktake, listStocktakes, readStocktakeTargets } = await import('../dist/operations.js');
const { fulfillCommerceOrder, listCommerceOrdersAdmin } = await import('../dist/fulfillment.js');
const { createRecoveryCase, recordRecoveryEvent, shipRecoveryCase, listRecoveryCases, readRecoveryCase, readRecoveryOrder, listExchangeChoices, recordRefundFollowUp, readCommerceAttention, readOperationsReport } = await import('../dist/operations.js');
const { manageShopperData } = await import('../dist/accounts.js');
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


const key=()=>crypto.randomUUID(), reason='Warehouse checked the parcel and agreed the remedy';
function fixture({quantity=4,parts=false,legacy=false}={}){
 const {sqlite:s,DB,recorded}=database();
 s.exec("INSERT INTO _ecommerce_products(id,name,slug,base_price,inventory_quantity,is_physical,status,created_at,updated_at) VALUES ('original','Original item','original',1000,15,1,'active',1,1),('replacement','Replacement item','replacement',1000,20,1,'active',1,1),('expensive','Expensive item','expensive',1500,20,1,'active',1,1)");
 s.exec("INSERT INTO _ecommerce_components(id,name,sku,quantity,created_at,updated_at) VALUES ('part-a','Shared A','A',20,1,1),('part-b','Shared B','B',10,1,1)");
 const item={productId:'original',quantity,priceAtPurchase:1000,...(!legacy?{stockTargets:parts?[{type:'component',id:'part-a',units:2},{type:'component',id:'part-b',units:1}]:[{type:'product',id:'original',units:1}]}:{})};
 s.prepare("INSERT INTO _ecommerce_orders(id,status,payment_provider,items,subtotal_amount,total_amount,shipping_address,customer_email,created_at,updated_at) VALUES ('order','paid','stripe',?,?,?,'{\"name\":\"Local buyer\",\"line1\":\"Test street\",\"city\":\"City\",\"postalCode\":\"000\",\"country\":\"US\"}','buyer@example.test',1,1)").run(JSON.stringify([item]),1000*quantity,1000*quantity);
 s.exec("INSERT INTO _ecommerce_fulfillments(id,order_id,kind,completes_order,admin_actor,note,created_at) VALUES ('parcel','order','shipment',1,'staff','Fixture shipment',1)");
 s.prepare("INSERT INTO _ecommerce_parcel_contents(id,fulfillment_id,order_id,items,source,actor,reason,fingerprint,created_at) VALUES ('contents','parcel','order',?,'shipment','staff','Original parcel recorded','fixture',1)").run(JSON.stringify([{lineIndex:0,quantity}]));
 return {s,env:{DB},recorded};
}
const issue=(extra={})=>({orderId:'order',kind:'lost',fulfillmentId:'parcel',lineIndex:0,quantity:2,requestKey:key(),reason,...extra});
const follow=(c,extra={})=>({caseId:c.id,expectedVersion:c.version,kind:'note',reason,requestKey:key(),...extra});
const dispatch=(c,extra={})=>({caseId:c.id,expectedVersion:c.version,quantity:c.remaining,carrier:'Local carrier',trackingNumber:'LOCAL-REPLACEMENT',reason,requestKey:key(),stock:c.stock.map(t=>({targetType:t.type,targetId:t.id,expectedQuantity:t.quantity,expectedUpdatedAt:t.updatedAt})),...extra});
const n=(s,t)=>s.prepare(`SELECT count(*) n FROM ${t}`).get().n;
const stock=(s,id='original')=>s.prepare('SELECT inventory_quantity n FROM _ecommerce_products WHERE id=?').get(id)?.n;
async function open(env,input=issue()){const r=await createRecoveryCase(env,input,'staff');return readRecoveryCase(env,{caseId:r.caseId});}
async function returned(env,quantity=2,condition='inspection'){
 const r=await receiveOrderReturn(env,{orderId:'order',items:[{lineIndex:0,quantity,condition,restock:false}],requestKey:key(),reason},'staff');return r.receiptId;
}
async function noRefund(env,receiptId){return recordRefundFollowUp(env,{receiptId,expectedVersion:receiptId,status:'not_needed',amountMinor:0,requestKey:key(),reason:'Equal-price exchange agreed instead of a refund'},'staff');}
const exchange=(receiptId,extra={})=>issue({kind:'exchange',fulfillmentId:null,receiptId,productId:'replacement',quantity:1,...extra});

test('lost and damaged cases preserve the original purchase and claim source quantities once',async()=>{
 const {s,env,recorded}=fixture();const input=issue(),c=await open(env,input);assert.equal((await createRecoveryCase(env,input,'staff')).caseId,c.id);await assert.rejects(createRecoveryCase(env,{...input,quantity:1},'staff'),/different/);await assert.rejects(createRecoveryCase(env,input,'another-staff'),/different/);
 await open(env,issue({kind:'damaged'}));await assert.rejects(createRecoveryCase(env,issue({quantity:1}),'staff'),/changed/);assert.equal(stock(s),15);assert.equal(n(s,'_ecommerce_stock_movements'),0);assert.equal(n(s,'_ecommerce_email_deliveries'),0);
 assert.equal((await readOrderWarehouse(env,{orderId:'order'})).lines[0].shipped,4);assert.equal((await readCommerceAttention(env)).counts.parcel_recovery,2);assert.equal((await readOperationsReport(env,{start:'2020-01-01',end:'2020-01-01'})).backlog.find(r=>r.kind==='recovery').count,2);assert.ok(recorded.every(([,params])=>params.length<=100));
});
test('partial replacements debit frozen physical stock once and recover committed receipts',async()=>{
 const {s,env}=fixture(),c=await open(env),input=dispatch(c,{quantity:1}),r=await shipRecoveryCase(env,input,'staff');assert.equal(stock(s),14);assert.equal((await shipRecoveryCase(env,input,'staff')).shipmentId,r.shipmentId);assert.equal(n(s,'_ecommerce_stock_movements'),1);
 await assert.rejects(shipRecoveryCase(env,{...input,quantity:2},'staff'),/other/);await assert.rejects(shipRecoveryCase(env,dispatch(c,{quantity:1}),'staff'),/changed/);const fresh=await readRecoveryCase(env,{caseId:c.id});assert.equal(fresh.remaining,1);assert.equal(fresh.version,r.shipmentId);await shipRecoveryCase(env,dispatch(fresh),'staff');assert.equal(stock(s),13);assert.equal((await readRecoveryCase(env,{caseId:c.id})).remaining,0);assert.equal(n(s,'_ecommerce_fulfillments'),1);assert.equal((await readOrderWarehouse(env,{orderId:'order'})).lines[0].shipped,4);assert.equal(s.prepare("SELECT total_amount,status FROM _ecommerce_orders").get().total_amount,4000);
});
test('shared-component replacements atomically roll back every stock deduction when a pool is stale or short',async()=>{
 for(const outcome of ['stale','short','deleted']){const {s,env}=fixture({parts:true}),c=await open(env);s.exec(outcome==='stale'?"UPDATE _ecommerce_components SET updated_at=2 WHERE id='part-b'":outcome==='short'?"UPDATE _ecommerce_components SET quantity=0 WHERE id='part-b'":"DELETE FROM _ecommerce_components WHERE id='part-b'");await assert.rejects(shipRecoveryCase(env,dispatch(c),'staff'));assert.equal(s.prepare("SELECT quantity FROM _ecommerce_components WHERE id='part-a'").get().quantity,20);assert.equal(n(s,'_ecommerce_recovery_shipments'),0);assert.equal(n(s,'_ecommerce_recovery_events'),0);assert.equal(n(s,'_ecommerce_stock_movements'),0);}
});
test('competing reports and dispatches serialize source caps, versions and stock',async()=>{
 const {env,s}=fixture(),reports=await Promise.allSettled([createRecoveryCase(env,issue({quantity:3}),'staff'),createRecoveryCase(env,issue({quantity:3}),'staff')]);assert.equal(reports.filter(r=>r.status==='fulfilled').length,1);
 const c=await readRecoveryCase(env,{caseId:reports.find(r=>r.status==='fulfilled').value.caseId}),input=dispatch(c,{quantity:2});const duplicate=await Promise.all([shipRecoveryCase(env,input,'staff'),shipRecoveryCase(env,input,'staff')]);assert.equal(duplicate[0].shipmentId,duplicate[1].shipmentId);assert.equal(stock(s),13);assert.equal(n(s,'_ecommerce_stock_movements'),1);
 const fresh=await readRecoveryCase(env,{caseId:c.id});const race=await Promise.allSettled([shipRecoveryCase(env,dispatch(fresh),'staff'),shipRecoveryCase(env,dispatch(fresh),'staff')]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(stock(s),12);
});
test('a failed replacement can have its own capped incident and additional shipment',async()=>{
 const {env,s}=fixture(),c=await open(env),r=await shipRecoveryCase(env,dispatch(c),'staff'),next=await open(env,issue({fulfillmentId:null,sourceShipmentId:r.shipmentId,quantity:1,kind:'damaged'}));await shipRecoveryCase(env,dispatch(next),'staff');assert.equal(stock(s),12);await assert.rejects(createRecoveryCase(env,issue({fulfillmentId:null,sourceShipmentId:r.shipmentId,quantity:2}),'staff'),/changed/);assert.equal(n(s,'_ecommerce_recovery_cases'),2);
});
test('case resolution ships nothing, permits controlled reopening and preserves tracking corrections',async()=>{
 const {env,s}=fixture(),c=await open(env);await recordRecoveryEvent(env,follow(c,{kind:'resolve'}),'staff');assert.equal(stock(s),15);await assert.rejects(shipRecoveryCase(env,dispatch(c),'staff'),/changed/);let fresh=await readRecoveryCase(env,{caseId:c.id});await recordRecoveryEvent(env,follow(fresh,{kind:'reopen'}),'staff');fresh=await readRecoveryCase(env,{caseId:c.id});const shipped=await shipRecoveryCase(env,dispatch(fresh),'staff');fresh=await readRecoveryCase(env,{caseId:c.id});const correction=follow(fresh,{kind:'tracking',shipmentId:shipped.shipmentId,carrier:'New carrier',trackingNumber:'NEW'});const r=await recordRecoveryEvent(env,correction,'staff');assert.equal((await recordRecoveryEvent(env,correction,'staff')).eventId,r.eventId);assert.equal((await readRecoveryCase(env,{caseId:c.id})).shipments[0].trackingNumber,'NEW');assert.equal(stock(s),13);
 assert.throws(()=>s.exec("UPDATE _ecommerce_recovery_cases SET quantity=1"),/immutable/);assert.throws(()=>s.exec("DELETE FROM _ecommerce_recovery_shipments"),/immutable/);assert.throws(()=>s.exec("UPDATE _ecommerce_recovery_events SET reason='Changed history'"),/immutable/);
});
test('refunds, disputes, missing sources and legacy mappings refuse new or outgoing replacements',async()=>{
 for(const state of ['refunded','partially_refunded','disputed','cancelled']){const {env,s}=fixture(),c=await open(env);s.prepare("UPDATE _ecommerce_orders SET status=?").run(state);await assert.rejects(shipRecoveryCase(env,dispatch(c),'staff'),/changed/);await assert.rejects(createRecoveryCase(env,issue({quantity:1}),'staff'),/paid/);assert.equal(stock(s),15);}
 const {env}=fixture({legacy:true});await assert.rejects(createRecoveryCase(env,issue(),'staff'),/older/);const f=fixture();await assert.rejects(createRecoveryCase(f.env,issue({fulfillmentId:'missing'}),'staff'),/changed/);await assert.rejects(createRecoveryCase(f.env,issue(),''),/staff/);
});
test('same-price exchanges require inspected return quantities and a no-refund decision',async()=>{
 const {env,s}=fixture(),receipt=await returned(env);await assert.rejects(createRecoveryCase(env,exchange(receipt),'staff'),/changed/);await noRefund(env,receipt);await assert.rejects(createRecoveryCase(env,exchange(receipt),'staff'),/changed/);
 await inspectOrderReturn(env,{orderId:'order',receiptId:receipt,items:[{lineIndex:0,quantity:2,disposition:'sellable',restock:false}],reason,requestKey:key()},'staff');const c=await open(env,exchange(receipt,{quantity:2}));assert.equal(stock(s,'replacement'),20);await shipRecoveryCase(env,dispatch(c),'staff');assert.equal(stock(s,'replacement'),18);assert.equal(stock(s),15);assert.equal(n(s,'_ecommerce_return_receipts'),1);assert.equal(s.prepare("SELECT total_amount FROM _ecommerce_orders").get().total_amount,4000);await assert.rejects(createRecoveryCase(env,exchange(receipt),'staff'),/changed/);
});
test('equal-price choices reject changed prices, inactive products, wrong variants and currency mismatch',async()=>{
 const {env,s}=fixture(),receipt=await returned(env,2,'damaged');await noRefund(env,receipt);const choices=await listExchangeChoices(env,{orderId:'order',lineIndex:0});assert.equal(choices.total,2);assert.ok(choices.rows.every(r=>r.price===1000));await assert.rejects(createRecoveryCase(env,exchange(receipt,{productId:'expensive'}),'staff'),/price/);await assert.rejects(createRecoveryCase(env,exchange(receipt,{variantId:'missing'}),'staff'));
 s.exec("UPDATE _ecommerce_products SET status='draft' WHERE id='replacement'");await assert.rejects(createRecoveryCase(env,exchange(receipt),'staff'),/active/);s.exec("UPDATE _ecommerce_products SET status='active' WHERE id='replacement'");await assert.rejects(createRecoveryCase({...env,TALISMAN_COMMERCE_CURRENCY:'eur'},exchange(receipt),'staff'),/currency/);
});
test('exchange and parcel remedies cannot double-claim the same original units or return refund',async()=>{
 const {env,s}=fixture(),receipt=await returned(env,2,'damaged'),decision=await noRefund(env,receipt),c=await open(env,exchange(receipt,{quantity:2}));await open(env,issue({quantity:2}));await assert.rejects(createRecoveryCase(env,issue({quantity:1}),'staff'),/changed/);
 await assert.rejects(recordRefundFollowUp(env,{receiptId:receipt,expectedVersion:decision.decisionId,status:'needed',amountMinor:1000,reason,requestKey:key()},'staff'),/changed/);await recordRecoveryEvent(env,follow(c,{kind:'resolve'}),'staff');await recordRefundFollowUp(env,{receiptId:receipt,expectedVersion:decision.decisionId,status:'needed',amountMinor:1000,reason,requestKey:key()},'staff');const fresh=await readRecoveryCase(env,{caseId:c.id});await assert.rejects(recordRecoveryEvent(env,follow(fresh,{kind:'reopen'}),'staff'),/changed/);assert.equal(stock(s),15);
});
test('paid and refunded races are checked within the shipment transaction',async()=>{
 const {env,s}=fixture(),c=await open(env),original=env.DB.prepare;let first=true;env.DB.prepare=sql=>{if(first&&/insert into "_ecommerce_recovery_shipments"/i.test(sql)){first=false;s.exec("UPDATE _ecommerce_orders SET status='disputed'");}return original.call(env.DB,sql);};await assert.rejects(shipRecoveryCase(env,dispatch(c),'staff'),/changed/);assert.equal(stock(s),15);assert.equal(n(s,'_ecommerce_recovery_shipments'),0);
});
test('queue totals, history bounds and authoritative versions remain exact',async()=>{
 const {env}=fixture({quantity:100});for(let i=0;i<51;i++)await open(env,issue({quantity:1}));const queue=await listRecoveryCases(env);assert.equal(queue.total,51);assert.equal(queue.rows.length,50);assert.equal((await listRecoveryCases(env,{offset:50})).rows.length,1);assert.equal((await listRecoveryCases(env,{orderId:'unknown'})).total,0);let c=await readRecoveryCase(env,{caseId:queue.rows[0].id});for(let i=0;i<201;i++){const r=await recordRecoveryEvent(env,follow(c),'staff');c={...c,version:r.eventId};}const fresh=await readRecoveryCase(env,{caseId:c.id});assert.equal(fresh.history.length,200);assert.equal(fresh.historyTruncated,true);assert.equal(fresh.version,c.version);
});
test('owner-only replacement tracking excludes staff reasons and original item counts remain unchanged',async()=>{
 const {env,s}=fixture(),c=await open(env,issue({reason:'Private carrier claim and compensation information'})),r=await shipRecoveryCase(env,dispatch(c),'staff');let fresh=await readRecoveryCase(env,{caseId:c.id});await recordRecoveryEvent(env,follow(fresh,{kind:'tracking',shipmentId:r.shipmentId,carrier:'Carrier',trackingNumber:'CORRECTED'}),'staff');s.prepare('UPDATE _ecommerce_orders SET guest_access_token_hash=?').run(await hashOrderAccess('guest-test'));const api=bindCommerceApi({env});assert.equal(await api.orders.tracking('order',undefined,undefined,'wrong'),null);const t=await api.orders.tracking('order',undefined,undefined,'guest-test');assert.equal(t.lines[0].shipped,4);assert.equal(t.recoveries[0].shipments[0].trackingNumber,'CORRECTED');assert.doesNotMatch(JSON.stringify(t),/Private|fingerprint|actor|stockTargets|shippingAddress/);
});
test('route boundaries enforce staff role, same origin, strict bodies and recovery receipts',async()=>{
 const {env}=fixture();globalThis.workerEnv=env;const req=(method='GET',origin='https://shop.test',body)=>new Request('https://shop.test/admin/api/ecommerce/operations?view=recoveries',{method,...(method==='POST'?{headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});globalThis.cmsUser=null;assert.equal((await route({request:req()})).status,401);globalThis.cmsUser={id:'editor',role:'editor'};assert.equal((await route({request:req()})).status,403);globalThis.cmsUser={id:'staff',role:'admin'};assert.equal((await route({request:req('POST','https://other.test',{action:'recoveryCreate',data:issue()})})).status,403);const response=await route({request:req('POST','https://shop.test',{action:'recoveryCreate',data:issue()})});assert.equal(response.status,200);assert.ok((await response.json()).result.caseId);assert.equal((await route({request:req('POST','https://shop.test',{action:'recoveryCreate',data:issue({quantity:0})})})).status,400);await assert.rejects(createRecoveryCase(env,issue({unknown:1}),'staff'));delete globalThis.workerEnv;delete globalThis.cmsUser;
});
test('open recovery obligations prevent erasure; resolved histories redact notes through the audited path',async()=>{
 const {env,s}=fixture();s.exec("INSERT INTO _ecommerce_customer_accounts(id,email,email_normalized,credit_balance,created_at,updated_at) VALUES ('owner','buyer@example.test','buyer@example.test',0,1,1); UPDATE _ecommerce_orders SET user_id='owner'");const c=await open(env);await assert.rejects(manageShopperData(env,'staff',{accountId:'owner',action:'anonymize',reason:'Shopper erasure request checked'}),/Resolve/);await shipRecoveryCase(env,dispatch(c),'staff');const fresh=await readRecoveryCase(env,{caseId:c.id});await recordRecoveryEvent(env,follow(fresh,{kind:'resolve'}),'staff');const exported=await manageShopperData(env,'staff',{accountId:'owner',action:'export',reason:'Shopper export request checked'});assert.equal(exported.orders[0].operations.recoveryCases.length,1);assert.doesNotMatch(JSON.stringify(exported.orders[0].operations.recoveryCases),/fingerprint|stockTargets|staff/);await manageShopperData(env,'staff',{accountId:'owner',action:'anonymize',reason:'Shopper erasure request checked'});const erased=await readRecoveryCase(env,{caseId:c.id});assert.equal(erased.reason,'[redacted]');assert.ok(s.prepare('SELECT reason FROM _ecommerce_stock_movements').all().every(r=>r.reason.startsWith('Replacement shipment rcs_')));assert.ok(erased.history.every(e=>e.reason==='[redacted]'));await assert.rejects(recordRecoveryEvent(env,follow(erased),'staff'),/unavailable/);assert.equal(n(s,'_ecommerce_recovery_shipments'),1);assert.equal(stock(s),13);
});
test('an exchange price changing between catalog read and commit refuses the whole case',async()=>{
 const {env,s}=fixture(),receipt=await returned(env,2,'damaged');await noRefund(env,receipt);const prepare=env.DB.prepare;let race=true;env.DB.prepare=sql=>{if(race&&/insert into "_ecommerce_recovery_cases"/i.test(sql)){race=false;s.exec("UPDATE _ecommerce_products SET base_price=1200 WHERE id='replacement'");}return prepare.call(env.DB,sql);};await assert.rejects(createRecoveryCase(env,exchange(receipt),'staff'),/changed/);assert.equal(n(s,'_ecommerce_recovery_cases'),0);assert.equal(stock(s,'replacement'),20);
});
test('exchanged variant values use their own shared-component recipe and exact aggregate deductions',async()=>{
 const {env,s}=fixture(),receipt=await returned(env,2,'damaged');await noRefund(env,receipt);
 s.exec("INSERT INTO _ecommerce_variants(id,name,created_at,updated_at) VALUES ('size','Size',1,1); INSERT INTO _ecommerce_product_variants(id,product_id,variant_id,name,inventory_quantity,created_at,updated_at) VALUES ('group','replacement','size','Size',0,1,1); INSERT INTO _ecommerce_product_variant_values(id,product_variant_id,value,created_at,updated_at) VALUES ('value','group','Large',1,1); INSERT INTO _ecommerce_variant_components(id,product_variant_value_id,component_id,quantity,created_at,updated_at) VALUES ('bom-a','value','part-a',2,1,1),('bom-b','value','part-b',1,1,1)");
 const choices=await listExchangeChoices(env,{orderId:'order',lineIndex:0});assert.ok(choices.rows.some(c=>c.variantId==='value'));assert.ok(!choices.rows.some(c=>c.productId==='replacement'&&c.variantId===null));const c=await open(env,exchange(receipt,{quantity:2,variantId:'value'}));await shipRecoveryCase(env,dispatch(c),'staff');assert.equal(s.prepare("SELECT quantity FROM _ecommerce_components WHERE id='part-a'").get().quantity,16);assert.equal(s.prepare("SELECT quantity FROM _ecommerce_components WHERE id='part-b'").get().quantity,8);assert.equal(stock(s,'replacement'),20);
});
test('shipment mapping refuses duplicate or missing pools and follow-up versions reject competing resolutions',async()=>{
 const {env,s}=fixture({parts:true}),c=await open(env),input=dispatch(c);await assert.rejects(shipRecoveryCase(env,{...input,stock:[input.stock[0],input.stock[0]]},'staff'),/Reload/);await assert.rejects(shipRecoveryCase(env,{...input,stock:[]},'staff'),/Reload/);const results=await Promise.allSettled([recordRecoveryEvent(env,follow(c,{kind:'resolve'}),'staff'),recordRecoveryEvent(env,follow(c,{kind:'resolve'}),'staff')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(n(s,'_ecommerce_recovery_shipments'),0);assert.equal(n(s,'_ecommerce_stock_movements'),0);
});
