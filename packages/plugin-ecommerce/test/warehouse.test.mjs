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
const { readOrderWarehouse, recordParcelContents, receiveOrderReturn, listStockLocations, readStockHistory, recordStockMovement } = await import('../dist/operations.js');
const { fulfillCommerceOrder, listCommerceOrdersAdmin } = await import('../dist/fulfillment.js');
const { restockOrder, getOrderAdjustmentsAdmin } = await import('../dist/order-adjustments.js');
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

test('split parcels track remaining units, finish automatically, print exact contents and replay receipts', async()=>{
 const {sqlite:s,env,recorded}=fixture();
 const first=parcel(1); const receipt=await fulfillCommerceOrder(env,'staff',first);
 assert.equal(receipt.fulfillmentStatus,'partially_fulfilled');
 let warehouse=await readOrderWarehouse(env,{orderId:ORDER}); assert.equal(warehouse.lines[0].remaining,3); assert.equal(warehouse.parcels[0].items[0].quantity,1);
 const replay=await fulfillCommerceOrder(env,'staff',first); assert.equal(replay.fulfillmentId,receipt.fulfillmentId); assert.equal(replay.duplicate,true);
 await assert.rejects(fulfillCommerceOrder(env,'staff',{...first,items:[{lineIndex:0,quantity:2}]}),/other contents/);
 await assert.rejects(fulfillCommerceOrder(env,'staff',{...first,items:undefined,completesOrder:false}),/other contents/);
 await fulfillCommerceOrder(env,'staff',parcel(3));
 warehouse=await readOrderWarehouse(env,{orderId:ORDER});assert.equal(warehouse.lines[0].remaining,0); assert.equal(warehouse.fulfillmentStatus,'fulfilled');
 const listed=await listCommerceOrdersAdmin(env,{view:'recent'}); assert.deepEqual(listed.orders[0].shipments.map(p=>p.completesOrder),[false,true]);
 assert.equal(count(s,'_ecommerce_fulfillments'),2);assert.equal(count(s,'_ecommerce_parcel_contents'),2);assert.equal(count(s,'_ecommerce_email_deliveries'),2);
 assert.ok(recorded.every(([,values])=>values.length<=100));s.close();
});
test('competing parcels cannot over-ship, and a refused parcel rolls back its email and shipment',async()=>{
 const {sqlite:s,env}=fixture();const results=await Promise.allSettled([fulfillCommerceOrder(env,'a',parcel(3)),fulfillCommerceOrder(env,'b',parcel(3))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(count(s,'_ecommerce_fulfillments'),1);assert.equal(count(s,'_ecommerce_email_deliveries'),1);
 await assert.rejects(fulfillCommerceOrder(env,'a',parcel(1,{items:[{lineIndex:10,quantity:1}]})),/Parcel/); assert.equal(count(s,'_ecommerce_parcel_contents'),1);s.close();
});
test('older parcels stay explicitly unknown until an audited contents backfill',async()=>{
 const {sqlite:s,env}=fixture({legacy:true});
 const old=await fulfillCommerceOrder(env,'staff',{orderId:ORDER,note:'Historical parcel shipped',completesOrder:false});
 let data=await readOrderWarehouse(env,{orderId:ORDER});assert.equal(data.lines[0].remaining,null);assert.equal(data.unrecorded.length,1);
 await assert.rejects(fulfillCommerceOrder(env,'staff',parcel(1)),/earlier parcels/);
 const payload={orderId:ORDER,fulfillmentId:old.fulfillmentId,items:[{lineIndex:0,quantity:2}],reason:'Verified archived packing record',requestKey:crypto.randomUUID()};
 await recordParcelContents(env,payload,'staff'); assert.equal((await recordParcelContents(env,payload,'staff')).duplicate,true);
 await assert.rejects(recordParcelContents(env,{...payload,items:[{lineIndex:0,quantity:3}]},'staff'),/already recorded/);
 data=await readOrderWarehouse(env,{orderId:ORDER}); assert.equal(data.lines[0].remaining,2);s.close();
});
test('partial return restores only received sellable quantities, separately from the payment refund',async()=>{
 const {sqlite:s,env}=fixture();await fulfillCommerceOrder(env,'staff',parcel(4));
 const request=intake(1), receipt=await receiveOrderReturn(env,request,'staff'); assert.equal(qty(s),11);assert.equal(receipt.restocked[0].quantity,1);
 assert.equal(s.prepare('SELECT status FROM _ecommerce_orders').get().status,'paid');
 assert.equal(s.prepare('SELECT released_at FROM _ecommerce_inventory_reservations').get().released_at,null);
 assert.equal((await receiveOrderReturn(env,request,'staff')).duplicate,true);assert.equal(qty(s),11);
 await receiveOrderReturn(env,intake(2,{items:[{lineIndex:0,quantity:2,condition:'damaged',restock:false}]}),'staff');assert.equal(qty(s),11);
 const data=await readOrderWarehouse(env,{orderId:ORDER});assert.equal(data.lines[0].received,3);assert.equal(data.lines[0].returnable,1);
 await assert.rejects(receiveOrderReturn(env,intake(2),'staff'),{name:'CommerceOperationsConflict'});
 await assert.rejects(receiveOrderReturn(env,{...request,reason:'Different receipt reason'},'staff'),/key/);assert.equal(count(s,'_ecommerce_return_receipts'),2);s.close();
});
test('return conditions, line identity, duplicates and quantity shape are validated',async()=>{
 const {sqlite:s,env}=fixture();await fulfillCommerceOrder(env,'staff',parcel(4));
 for(const item of [{lineIndex:0,quantity:1,condition:'damaged',restock:true},{lineIndex:0,quantity:0,condition:'sellable',restock:true},{lineIndex:9,quantity:1,condition:'sellable',restock:true}]) await assert.rejects(receiveOrderReturn(env,intake(1,{items:[item]}),'staff'));
 await assert.rejects(receiveOrderReturn(env,intake(1,{items:[intake(1).items[0],intake(1).items[0]]}),'staff'));
 assert.equal(count(s,'_ecommerce_return_receipts'),0);assert.equal(qty(s),10);s.close();
});
test('shared-component return uses frozen checkout units and caps fully restored reservations',async()=>{
 const {sqlite:s,env}=fixture({parts:true});await fulfillCommerceOrder(env,'staff',parcel(4));
 await receiveOrderReturn(env,intake(1),'staff');assert.equal(qty(s,true),22);
 await receiveOrderReturn(env,intake(3),'staff');assert.equal(qty(s,true),28);assert.ok(s.prepare('SELECT released_at FROM _ecommerce_component_reservations').get().released_at);
 await assert.rejects(receiveOrderReturn(env,intake(1),'staff'));assert.equal(qty(s,true),28);s.close();
});
test('the old whole-reservation restock returns only the remainder after item intake',async()=>{
 const {sqlite:s,env}=fixture();await fulfillCommerceOrder(env,'staff',parcel(4));await receiveOrderReturn(env,intake(1),'staff');
 s.exec("UPDATE _ecommerce_orders SET status='refunded'");
 const adjustments=await getOrderAdjustmentsAdmin(env,{orderIds:[ORDER]});assert.equal(adjustments.orders[ORDER].reservations[0].quantity,3);
 const result=await restockOrder(env,'staff',{orderId:ORDER,reason:'Remaining goods physically received'});assert.equal(result.restocked[0].quantity,3);assert.equal(qty(s),14);
 await assert.rejects(receiveOrderReturn(env,intake(1),'staff'),/already been restored/);s.close();
});
test('a missing stock record rolls the entire return intake back',async()=>{
 const {sqlite:s,env}=fixture();await fulfillCommerceOrder(env,'staff',parcel(4));s.exec('DELETE FROM _ecommerce_products');
 await assert.rejects(receiveOrderReturn(env,intake(1),'staff'));assert.equal(count(s,'_ecommerce_return_receipts'),0);assert.equal(count(s,'_ecommerce_return_stock'),0);s.close();
});
test('legacy orders receive returns without guessing component or stock mappings',async()=>{
 const {sqlite:s,env}=fixture({legacy:true});await fulfillCommerceOrder(env,'staff',{orderId:ORDER,note:'Whole historical order shipped'});
 await assert.rejects(receiveOrderReturn(env,intake(1),'staff'),/no checkout stock mapping/);
 await receiveOrderReturn(env,intake(1,{items:[{lineIndex:0,quantity:1,condition:'inspection',restock:false}]}),'staff');assert.equal(qty(s),10);s.close();
});
test('stock receipts and corrections record staff, before/after counts and safe retry receipts',async()=>{
 const {sqlite:s,env}=fixture();const request=stock(), receipt=await recordStockMovement(env,request,'staff');assert.equal(qty(s),13);
 assert.equal((await recordStockMovement(env,request,'staff')).movementId,receipt.movementId);assert.equal(qty(s),13);
 await assert.rejects(recordStockMovement(env,{...request,delta:4},'staff'),/key/);await assert.rejects(recordStockMovement(env,request,'other'),/key/);
 const row=(await listStockLocations(env,{search:'Travel case'})).rows.find(r=>r.type==='product');assert.equal(row.quantity,13);
 await recordStockMovement(env,stock({kind:'correction',delta:-2,expectedQuantity:row.quantity,expectedUpdatedAt:row.updatedAt}),'staff');assert.equal(qty(s),11);
 const history=await readStockHistory(env,{targetType:'product',targetId:'case'});assert.equal(history.rows.filter(r=>r.actor==='staff').length,2);assert.ok(history.rows.some(r=>r.delta===3&&r.beforeQuantity===10&&r.afterQuantity===13));s.close();
});
test('stale stock writes have one concurrent winner and cannot overwrite reserved units',async()=>{
 const {sqlite:s,env}=fixture();const result=await Promise.allSettled([recordStockMovement(env,stock(),'a'),recordStockMovement(env,stock(),'b')]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(qty(s),13);
 assert.equal(count(s,'_ecommerce_stock_movements'),1);await assert.rejects(recordStockMovement(env,stock({kind:'correction',delta:-20}),'a'));s.close();
});
test('immutable parcel, return and movement histories reject direct database edits',async()=>{
 const {sqlite:s,env}=fixture();await fulfillCommerceOrder(env,'staff',parcel(4));await receiveOrderReturn(env,intake(1),'staff');const location=(await listStockLocations(env,{search:'Travel case'})).rows.find(r=>r.type==='product');
 await recordStockMovement(env,stock({expectedQuantity:location.quantity,expectedUpdatedAt:location.updatedAt}),'staff');
 for(const table of ['parcel_contents','return_receipts','return_stock','stock_movements']) {assert.throws(()=>s.exec(`UPDATE _ecommerce_${table} SET id='changed'`),/immutable/);assert.throws(()=>s.exec(`DELETE FROM _ecommerce_${table}`),/immutable/);}
 assert.throws(()=>s.exec("UPDATE _ecommerce_orders SET items='[]'"),/immutable/);s.close();
});
test('stock history pages retain all movements and literal wildcard search does not expand results',async()=>{
 const {sqlite:s,env}=fixture();for(let i=0;i<53;i++){const row=(await listStockLocations(env,{search:'Travel case'})).rows.find(r=>r.type==='product');await recordStockMovement(env,stock({expectedQuantity:row.quantity,expectedUpdatedAt:row.updatedAt}),'staff');}
 const first=await readStockHistory(env,{targetType:'product',targetId:'case'}),second=await readStockHistory(env,{targetType:'product',targetId:'case',offset:50});assert.equal(first.total,54);assert.equal(first.rows.length,50);assert.equal(second.rows.length,4);
 assert.equal((await listStockLocations(env,{search:'%'})).total,0);s.close();
});
test('operations writes require admin authorization and same origin',async()=>{
 const {sqlite:s,env}=fixture();globalThis.workerEnv=env;
 const call=(origin='https://shop.test')=>route({request:new Request('https://shop.test/admin/api/ecommerce/operations',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({action:'stockMovement',data:stock()})})});
 globalThis.cmsUser=null;assert.equal((await call()).status,401);globalThis.cmsUser={id:'editor',role:'editor'};assert.equal((await call()).status,403);globalThis.cmsUser={id:'staff',role:'admin'};assert.equal((await call('https://evil.test')).status,403);assert.equal((await call()).status,200);
 assert.equal((await call()).status,409);assert.equal(count(s,'_ecommerce_stock_movements'),1);s.close();
});

test('competing return intakes cannot receive or restore more units than shipped',async()=>{
 const {sqlite:s,env}=fixture();await fulfillCommerceOrder(env,'staff',parcel(4));
 const outcomes=await Promise.allSettled([receiveOrderReturn(env,intake(3),'a'),receiveOrderReturn(env,intake(3),'b')]);
 assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);assert.equal(qty(s),13);assert.equal(count(s,'_ecommerce_return_receipts'),1);s.close();
});
test('legacy restock racing item intake never restores a hold twice',async()=>{
 const {sqlite:s,env}=fixture();await fulfillCommerceOrder(env,'staff',parcel(4));s.exec("UPDATE _ecommerce_orders SET status='refunded'");
 const outcomes=await Promise.allSettled([receiveOrderReturn(env,intake(1),'a'),restockOrder(env,'b',{orderId:ORDER,reason:'Whole remainder physically received'})]);
 assert.ok(outcomes.some(o=>o.status==='fulfilled'));assert.equal(qty(s),14);
 assert.equal(s.prepare("SELECT sum(quantity) n FROM (SELECT quantity FROM _ecommerce_return_stock UNION ALL SELECT quantity FROM _ecommerce_restocks)").get().n,4);s.close();
});
