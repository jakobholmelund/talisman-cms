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
const { decideReturnRequest, readReturnRequestAdmin, listReturnsQueue, exportCommerceOperations, readOrderWarehouse, recordParcelContents, receiveOrderReturn, listStockLocations, readStockHistory, recordStockMovement, inspectOrderReturn, recordStocktake, listStocktakes, readStocktakeTargets } = await import('../dist/operations.js');
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


const {manageShopperData}=await import('../dist/accounts.js');
const customerRoute=(await import('../dist/routes/ecommerce-returns.js')).ALL;
async function setup(options={}) { const db=fixture(options);const access=await hashOrderAccess('guest-access');db.sqlite.prepare('UPDATE _ecommerce_orders SET guest_access_token_hash=? WHERE id=?').run(access,ORDER);if(!options.unknown)await fulfillCommerceOrder(db.env,'staff',parcel(options.units??4));else await fulfillCommerceOrder(db.env,'staff',{orderId:ORDER,note:'Earlier parcel missing allocations',completesOrder:false});return {...db,api:bindCommerceApi({env:db.env}),owner:{orderAccessToken:'guest-access'}}; }
const request=(quantity=2,extra={})=>({orderId:ORDER,requestKey:crypto.randomUUID(),reason:'The received item did not fit',items:[{lineIndex:0,quantity}],...extra});
const decision=(r,extra={})=>({requestId:r.requestId,requestKey:crypto.randomUUID(),expectedVersion:r.requestId,status:'approved',reason:'Internal approval reason for staff',customerMessage:'Please send these goods to the return desk with this reference.',...extra});
const range=()=>{const date=new Date(NOW*1000).toISOString().slice(0,10);return {from:date,to:date};};
test('customer return quantities need ownership and known shipped contents; overlapping requests cannot exceed outstanding goods',async()=>{
 const {sqlite:s,api,owner,env,recorded}=await setup();
 assert.equal(await api.returns.read(ORDER,{}),null);assert.equal(await api.returns.request(request(),{}),null);
 const payload=request(3),first=await api.returns.request(payload,owner);assert.equal((await api.returns.request(payload,owner)).duplicate,true);
 await assert.rejects(api.returns.request({...payload,reason:'Changed reason with the same key'},owner),/different details/);
 await assert.rejects(api.returns.request(request(2),owner),/quantities changed/);
 let data=await api.returns.read(ORDER,owner);assert.equal(data.lines[0].available,1);assert.equal(data.requests[0].status,'pending');
 const outcomes=await Promise.allSettled([api.returns.request(request(1),owner),api.returns.request(request(1),owner)]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 await api.returns.cancel({orderId:ORDER,requestId:first.requestId,expectedVersion:first.requestId,requestKey:crypto.randomUUID()},owner);data=await api.returns.read(ORDER,owner);assert.equal(data.lines[0].available,3);
 assert.ok(recorded.every(([,values])=>values.length<=100));s.close();
 const old=await setup({unknown:true});assert.equal((await old.api.returns.read(ORDER,old.owner)).unknownParcelContents,true);await assert.rejects(old.api.returns.request(request(1),old.owner),/parcel details/);old.sqlite.close();
});
test('staff decisions use last-written versions, recover the same receipt, and keep internal reasons private',async()=>{
 const {sqlite:s,api,owner,env}=await setup(),r=await api.returns.request(request(),owner),payload=decision(r);
 const approved=await decideReturnRequest(env,payload,'admin-a');assert.equal((await decideReturnRequest(env,payload,'admin-a')).duplicate,true);
 await assert.rejects(decideReturnRequest(env,{...payload,requestKey:crypto.randomUUID()},'admin-b'),/changed/);
 let data=await api.returns.read(ORDER,owner);assert.equal(data.requests[0].status,'approved');assert.equal(data.requests[0].updates[0].message,payload.customerMessage);assert.doesNotMatch(JSON.stringify(data),/Internal approval|admin-a|fingerprint|expectedVersion|stockTargets/);
 const staff=await readReturnRequestAdmin(env,{requestId:r.requestId});assert.equal(staff.events[0].reason,payload.reason);assert.doesNotMatch(JSON.stringify(staff),/fingerprint|expectedVersion|stockTargets/);
 const cancelled=await api.returns.cancel({orderId:ORDER,requestId:r.requestId,expectedVersion:approved.eventId,requestKey:crypto.randomUUID()},owner);assert.ok(cancelled.eventId);assert.equal((await api.returns.read(ORDER,owner)).requests[0].status,'cancelled');
 assert.throws(()=>s.prepare('UPDATE _ecommerce_return_requests SET reason=? WHERE id=?').run('New shopper reason',r.requestId),/immutable/);assert.throws(()=>s.exec('DELETE FROM _ecommerce_return_request_events'),/immutable/);s.close();
});
test('approved intake links partial receipts atomically, caps request quantities, and moves goods into the inspection queue',async()=>{
 const {sqlite:s,api,owner,env}=await setup(),r=await api.returns.request(request(),owner),approved=await decideReturnRequest(env,decision(r),'staff');
 const data=intake(1,{returnRequestId:r.requestId,items:[{lineIndex:0,quantity:1,condition:'inspection',restock:false}]});const receipt=await receiveOrderReturn(env,data,'warehouse');assert.equal((await receiveOrderReturn(env,data,'warehouse')).duplicate,true);
 assert.equal((await api.returns.read(ORDER,owner)).requests[0].items[0].received,1);assert.equal((await api.returns.read(ORDER,owner)).requests[0].canCancel,false);
 await assert.rejects(api.returns.cancel({orderId:ORDER,requestId:r.requestId,expectedVersion:approved.eventId,requestKey:crypto.randomUUID()},owner),/cannot take/);
 const before=qty(s);await assert.rejects(receiveOrderReturn(env,intake(2,{returnRequestId:r.requestId}),'warehouse'),/Return quantities/);assert.equal(qty(s),before);assert.equal(count(s,'_ecommerce_return_receipts'),1);
 let queue=await listReturnsQueue(env,{filter:'inspection'});assert.equal(queue.total,1);assert.equal(queue.rows[0].pendingUnits,1);
 await inspectOrderReturn(env,{orderId:ORDER,receiptId:receipt.receiptId,requestKey:crypto.randomUUID(),reason:'Approved unit after inspection',items:[{lineIndex:0,quantity:1,disposition:'sellable',restock:true}]},'inspector');assert.equal((await listReturnsQueue(env,{filter:'inspection'})).total,0);
 await receiveOrderReturn(env,intake(1,{returnRequestId:r.requestId}),'warehouse');assert.equal((await api.returns.read(ORDER,owner)).requests[0].items[0].received,2);assert.equal((await api.returns.read(ORDER,owner)).lines[0].available,2);
 await decideReturnRequest(env,decision(r,{expectedVersion:approved.eventId,status:'closed',reason:'All received units have been handled',customerMessage:'Your returned goods are received. Contact us about payment status.'}),'staff');assert.equal((await listReturnsQueue(env,{filter:'active'})).total,0);assert.equal((await readReturnRequestAdmin(env,{requestId:r.requestId})).receipts.length,2);s.close();
});
test('unapproved, other-order or unlinked overlapping intake cannot create an invalid request receipt or approval',async()=>{
 const {sqlite:s,api,owner,env}=await setup(),r=await api.returns.request(request(),owner);await assert.rejects(receiveOrderReturn(env,intake(1,{returnRequestId:r.requestId}),'staff'),/Return quantities/);assert.equal(count(s,'_ecommerce_return_receipts'),0);
 await receiveOrderReturn(env,intake(4,{items:[{lineIndex:0,quantity:4,condition:'damaged',restock:false}]}),'staff');await assert.rejects(decideReturnRequest(env,decision(r),'staff'),/changed/);await decideReturnRequest(env,decision(r,{status:'declined',reason:'Already received outside the requested return',customerMessage:'These units have already arrived at our warehouse.'}),'staff');s.close();
});
test('competing request decisions and cancellation/intake serialize without losing history',async()=>{
 const {sqlite:s,api,owner,env}=await setup(),r=await api.returns.request(request(),owner);
 const decisions=await Promise.allSettled([decideReturnRequest(env,decision(r),'a'),decideReturnRequest(env,decision(r,{status:'declined'}),'b')]);assert.equal(decisions.filter(r=>r.status==='fulfilled').length,1);assert.equal(count(s,'_ecommerce_return_request_events'),1);
 const state=await readReturnRequestAdmin(env,{requestId:r.requestId});if(state.status==='approved'){const results=await Promise.allSettled([api.returns.cancel({orderId:ORDER,requestId:r.requestId,expectedVersion:state.version,requestKey:crypto.randomUUID()},owner),receiveOrderReturn(env,intake(1,{returnRequestId:r.requestId,items:[{lineIndex:0,quantity:1,condition:'inspection',restock:false}]}),'staff')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);}s.close();
});
test('returns queue counts and pagination include older requests beyond its first page and standalone inspections',async()=>{
 const {sqlite:s,api,owner,env}=await setup({units:60});
 for(let n=0;n<51;n++)await api.returns.request(request(1),owner);
 await receiveOrderReturn(env,intake(1,{items:[{lineIndex:0,quantity:1,condition:'inspection',restock:false}]}),'warehouse');
 const first=await listReturnsQueue(env),next=await listReturnsQueue(env,{offset:50});assert.equal(first.total,52);assert.equal(first.rows.length,50);assert.equal(next.rows.length,2);assert.equal(new Set([...first.rows,...next.rows].map(r=>r.id)).size,52);
 assert.equal((await listReturnsQueue(env,{orderId:'unknown'})).total,0);assert.equal((await listReturnsQueue(env,{filter:'pending'})).total,51);s.close();
});
test('complete operations CSV exports filter UTC boundaries, neutralize text formulas, and include quantity history',async()=>{
 const {sqlite:s,env,api,owner}=await setup();s.prepare('UPDATE _ecommerce_orders SET customer_email=? WHERE id=?').run(' =SUM(1,1)',ORDER);
 const r=await api.returns.request(request(),owner);await decideReturnRequest(env,decision(r),'staff');const receipt=await receiveOrderReturn(env,intake(1,{returnRequestId:r.requestId,reason:'=SUM(4,4) staff text',items:[{lineIndex:0,quantity:1,condition:'inspection',restock:false}]}),'staff');await inspectOrderReturn(env,{orderId:ORDER,receiptId:receipt.receiptId,requestKey:crypto.randomUUID(),reason:'Restored after inspection',items:[{lineIndex:0,quantity:1,disposition:'sellable',restock:true}]},'staff');
 let result=await exportCommerceOperations(env,{kind:'orders',...range(),status:'paid'});assert.equal(result.rows,1);assert.match(result.csv,/' =SUM\(1,1\)/);assert.ok(result.csv.startsWith('\uFEFF'));assert.match(result.csv,/total_minor/);assert.doesNotMatch(result.csv,/guest_access_token/);
 result=await exportCommerceOperations(env,{kind:'returns',...range(),orderId:ORDER});assert.equal(result.rows,1);assert.match(result.csv,/'=SUM\(4,4\)/);assert.match(result.csv,new RegExp(r.requestId));
 result=await exportCommerceOperations(env,{kind:'stock',...range(),targetType:'product',targetId:'case'});assert.match(result.csv,/"inspection"/);assert.match(result.csv,/"checkout_hold"/);assert.match(result.csv,/"-4"/);assert.doesNotMatch(result.csv,/'-4/);
 const midnight=Date.parse(`${range().to}T00:00:00Z`)/1000+86400,boundary=s.prepare("INSERT INTO _ecommerce_orders(id,status,payment_provider,total_amount,created_at,updated_at) VALUES (?,'paid','stripe',0,?,?)");boundary.run('last-second',midnight-1,midnight-1);boundary.run('next-day',midnight,midnight);
 result=await exportCommerceOperations(env,{kind:'orders',...range()});assert.equal(result.rows,2);assert.match(result.csv,/last-second/);assert.doesNotMatch(result.csv,/next-day/);
 assert.equal((await exportCommerceOperations(env,{kind:'orders',from:'2020-01-01',to:'2020-01-01'})).rows,0);await assert.rejects(exportCommerceOperations(env,{kind:'orders',from:'2026-02-30',to:'2026-03-01'}));await assert.rejects(exportCommerceOperations(env,{kind:'orders',from:'2020-01-01',to:'2026-01-01'}));s.close();
});
test('exports refuse oversized selections rather than returning a truncated file and enforce administrator/origin boundaries',async()=>{
 const {sqlite:s,env}=await setup();const insert=s.prepare("INSERT INTO _ecommerce_orders(id,status,payment_provider,total_amount,created_at,updated_at) VALUES (?,'paid','stripe',0,?,?)");for(let n=0;n<1000;n++)insert.run(`export-${n}`,NOW,NOW);
 await assert.rejects(exportCommerceOperations(env,{kind:'orders',...range()}),/exceeds 1,000/);
 globalThis.workerEnv=env;const send=(origin=true)=>route({request:new Request('https://store.test/admin/api/ecommerce/operations',{method:'POST',headers:origin?{'Content-Type':'application/json',Origin:'https://store.test'}:{},body:JSON.stringify({action:'export',data:{kind:'orders',...range()}})})});
 globalThis.cmsUser=null;assert.equal((await send()).status,401);globalThis.cmsUser={id:'editor',role:'editor'};assert.equal((await send()).status,403);globalThis.cmsUser={id:'admin',role:'admin'};assert.equal((await send(false)).status,403);assert.equal((await send()).status,413);delete globalThis.cmsUser;delete globalThis.workerEnv;s.close();
});
test('customer return route protects ownership, rejects malformed/oversized writes and returns uncached shopper-only responses',async()=>{
 const {sqlite:s,env,owner}=await setup();globalThis.workerEnv=env;const cookies={get(name){return name===`talisman-order-${ORDER}`?{value:owner.orderAccessToken}:undefined;}};
 const get=await customerRoute({request:new Request(`https://store.test/api/ecommerce/returns?order=${ORDER}`),cookies});assert.equal(get.status,200);assert.match(get.headers.get('cache-control'),/no-store/);
 const anonymous=await customerRoute({request:new Request(`https://store.test/api/ecommerce/returns?order=${ORDER}`),cookies:{get(){}}});assert.equal(anonymous.status,404);
 const send=(body,origin='https://store.test')=>customerRoute({request:new Request('https://store.test/api/ecommerce/returns',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body}),cookies});
 assert.equal((await send(JSON.stringify({action:'request',data:request()}),'https://other.test')).status,403);assert.equal((await send('{bad')).status,400);assert.equal((await send('x'.repeat(33000))).status,400);assert.equal((await send(JSON.stringify({action:'request',data:request(1)}))).status,200);delete globalThis.workerEnv;s.close();
});
test('temporary return write failures stay recoverable and last-written decisions win despite older timestamps',async()=>{
 const {sqlite:s,env,api,owner,DB}=await setup();globalThis.workerEnv=env;
 const cookies={get(name){return name===`talisman-order-${ORDER}`?{value:owner.orderAccessToken}:undefined;}};
 const payload=request(1),prepare=DB.prepare;let unavailable=true;
 DB.prepare=function(query){if(unavailable&&/insert into "_ecommerce_return_requests"/i.test(query))throw new Error('Temporary storage failure');return prepare.call(this,query);};
 const send=()=>customerRoute({request:new Request('https://store.test/api/ecommerce/returns',{method:'POST',headers:{Origin:'https://store.test','Content-Type':'application/json'},body:JSON.stringify({action:'request',data:payload})}),cookies});
 assert.equal((await send()).status,503);assert.equal(count(s,'_ecommerce_return_requests'),0);unavailable=false;
 const response=await send();assert.equal(response.status,200);const r=await response.json();assert.equal((await send()).status,200);assert.equal(count(s,'_ecommerce_return_requests'),1);
 const approved=await decideReturnRequest(env,decision(r),'staff');
 s.prepare(`INSERT INTO _ecommerce_return_request_events(id,request_id,status,expected_version,actor_kind,actor,reason,customer_message,fingerprint,created_at) VALUES ('clock-skew',?,'closed',?,'staff','staff','Closed after clock correction','Your return request is closed.','clock-skew-fingerprint',1)`).run(r.requestId,approved.eventId);
 const current=await api.returns.read(ORDER,owner);assert.equal(current.requests[0].status,'closed');assert.equal(current.requests[0].version,'clock-skew');assert.equal((await listReturnsQueue(env,{filter:'active'})).total,0);
 delete globalThis.workerEnv;s.close();
});
test('shopper privacy export includes their return messages; open work blocks erasure and audited redaction preserves quantity history',async()=>{
 const {sqlite:s,env,api,owner}=await setup();s.exec("INSERT INTO _ecommerce_customer_accounts(id,email,email_normalized,created_at,updated_at) VALUES('buyer','buyer@example.test','buyer@example.test',1,1)");s.prepare('UPDATE _ecommerce_orders SET user_id=? WHERE id=?').run('buyer',ORDER);const r=await api.returns.request(request(),{customerId:'buyer'});
 await assert.rejects(manageShopperData(env,'buyer',{accountId:'buyer',action:'anonymize',reason:'Customer requested data removal'}),/open returns/);
 const approved=await decideReturnRequest(env,decision(r),'staff');let exported=await manageShopperData(env,'buyer',{accountId:'buyer',action:'export',reason:'Customer requested their stored data'});const requests=exported.orders[0].operations.returnRequests;assert.equal(requests[0].reason,'The received item did not fit');assert.doesNotMatch(JSON.stringify(requests),/Internal approval|fingerprint|staff/);
 await decideReturnRequest(env,decision(r,{status:'closed',expectedVersion:approved.eventId,reason:'Customer no longer needs this request',customerMessage:'We closed this return at your request.'}),'staff');await manageShopperData(env,'buyer',{accountId:'buyer',action:'anonymize',reason:'Customer requested data removal'});
 assert.equal(s.prepare('SELECT reason FROM _ecommerce_return_requests').get().reason,'[redacted]');assert.equal(s.prepare('SELECT customer_message FROM _ecommerce_return_request_events LIMIT 1').get().customer_message,'');assert.equal(count(s,'_ecommerce_return_request_events'),2);assert.throws(()=>s.exec("UPDATE _ecommerce_return_requests SET items='[]'"),/immutable/);
 // A caller authenticated immediately before erasure cannot reopen work after its audit commits.
 await assert.rejects(api.returns.request(request(1),{customerId:'buyer'}),/quantities changed/);assert.equal(count(s,'_ecommerce_return_requests'),1);s.close();
});
