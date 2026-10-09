import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyAllMigrations } from './helpers/migrations.mjs';
const stubs = {
 'cloudflare:workers': 'export const env = new Proxy({}, {get:(_,key)=>globalThis.workerEnv?.[key]});',
 'talisman-cms/auth/guard': "export async function authorizeCmsRequest(){const user=globalThis.cmsUser;return !user?{response:new Response(null,{status:401})}:user.role!=='admin'?{response:new Response(null,{status:403})}:{user};}",
};
registerHooks({resolve(specifier,ctx,next){return specifier in stubs?{url:`data:text/javascript,${encodeURIComponent(stubs[specifier])}`,shortCircuit:true}:next(specifier,ctx);}});
const {saveSupplier,savePurchaseOrder,recordPurchaseOrder,readPurchaseOrder,listPurchaseOrders,reportSupplierIssue,recordSupplierIssue,readSupplierIssue,listSupplierIssues,recordReplenishmentDelivery,readReplenishment,readCommerceAttention,readOperationsReport}=await import('../dist/operations.js');
const route=(await import('../dist/routes/ecommerce-admin-operations.js')).ALL;
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');applyAllMigrations(sqlite);const recorded=[];
 const DB={prepare(sql){const s=sqlite.prepare(sql);let v=[];return{bind(...p){v=p;return this;},rows(){recorded.push([sql,v]);return{results:s.all(...v)};},async all(){return this.rows();},async first(){recorded.push([sql,v]);return s.get(...v)??null;},async raw(){recorded.push([sql,v]);const r=sqlite.prepare(sql);r.setReturnArrays(true);return r.all(...v);},async run(){recorded.push([sql,v]);return{meta:s.run(...v)};}};},async batch(q){sqlite.exec('BEGIN');try{const r=q.map(s=>s.rows());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 sqlite.exec("INSERT INTO _ecommerce_components(id,name,sku,quantity,created_at,updated_at) VALUES ('pool','Supplier pool','SUP',5,1,1)");
 return{sqlite,env:{DB},recorded};
}
const key=()=>crypto.randomUUID(),reason='Supplier delivery checked by warehouse staff';
const quantity=s=>s.prepare("SELECT quantity FROM _ecommerce_components WHERE id='pool'").get().quantity;
const count=(s,t)=>s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
async function purchase(env,{quantity:units=10,confirm=true}={}){
 const sup=await saveSupplier(env,{supplierId:null,expectedVersion:null,requestKey:key(),name:'Supply desk',contact:'Purchasing contact',address:'Warehouse',active:true,reason},'staff');
 const draft=await savePurchaseOrder(env,{purchaseOrderId:null,expectedVersion:null,requestKey:key(),supplierId:sup.supplierId,supplierVersion:sup.revisionId,reference:'SUPPLY-TEST',expectedDate:'2099-01-01',lines:[{targetType:'component',targetId:'pool',quantity:units}],reason},'staff');
 if(confirm)await recordPurchaseOrder(env,{purchaseOrderId:draft.purchaseOrderId,expectedVersion:draft.eventId,requestKey:key(),action:'order',supplierVersion:sup.revisionId,reason},'staff');
 return readPurchaseOrder(env,{purchaseOrderId:draft.purchaseOrderId});
}
const report=(p,extra={})=>({purchaseLineId:p.deliveries[0].purchaseLineId,expectedPurchaseVersion:p.version,expectedDeliveryVersion:p.deliveries[0].version,requestKey:key(),kind:'damaged',quantity:2,reason,...extra});
const event=(i,extra={})=>({issueId:i.id,expectedVersion:i.version,status:'open',requestKey:key(),reason:'Supplier contacted about the missing or rejected goods',...extra});
async function receive(env,p,units){const d=p.deliveries[0];return recordReplenishmentDelivery(env,{deliveryId:d.deliveryId,expectedVersion:d.version,requestKey:key(),kind:'received',quantity:units,expectedQuantity:d.location.quantity,expectedUpdatedAt:d.location.updatedAt,reason},'staff');}
async function cancel(env,p){return recordPurchaseOrder(env,{purchaseOrderId:p.id,expectedVersion:p.version,requestKey:key(),action:'cancel',reason},'staff');}

test('all incident categories are immutable reports with stable recovery and no stock/supply change',async()=>{
 const{env,sqlite:s,recorded}=fixture(),p=await purchase(env);const input=report(p);const a=await reportSupplierIssue(env,input,'staff');assert.equal((await reportSupplierIssue(env,input,'staff')).issueId,a.issueId);
 await assert.rejects(reportSupplierIssue(env,{...input,quantity:3},'staff'),/different details/);await assert.rejects(reportSupplierIssue(env,input,'another-staff'),/different details/);
 for(const kind of ['short','incorrect'])await reportSupplierIssue(env,report(p,{kind,quantity:2}),'staff');
 assert.equal(quantity(s),5);const stock=await readReplenishment(env,{targetType:'component',targetId:'pool'});assert.equal(stock.location.incoming,10);assert.equal(stock.deliveries[0].received,0);
 const detail=await readPurchaseOrder(env,{purchaseOrderId:p.id});assert.equal(detail.deliveries[0].issueAllowance,4);assert.equal((await listSupplierIssues(env)).total,3);
 await assert.rejects(reportSupplierIssue(env,report(p,{quantity:5}),'staff'),/changed/);
 assert.throws(()=>s.prepare('UPDATE _ecommerce_supplier_issues SET quantity=1 WHERE id=?').run(a.issueId),/immutable/);assert.throws(()=>s.prepare('DELETE FROM _ecommerce_supplier_issues WHERE id=?').run(a.issueId),/immutable/);
 assert.equal(count(s,'_ecommerce_stock_movements'),0);assert.equal(count(s,'_ecommerce_email_deliveries'),0);assert.ok(recorded.every(([,v])=>v.length<=100));
});

test('reporting uses frozen purchase/delivery versions and rejects quantities already accepted or cancelled',async()=>{
 const{env,sqlite:s}=fixture(),p=await purchase(env);await receive(env,p,3);
 await assert.rejects(reportSupplierIssue(env,report(p),'staff'),/changed/);let fresh=await readPurchaseOrder(env,{purchaseOrderId:p.id});await assert.rejects(reportSupplierIssue(env,report(fresh,{quantity:8}),'staff'),/changed/);
 await recordPurchaseOrder(env,{purchaseOrderId:p.id,expectedVersion:p.version,requestKey:key(),action:'reschedule',expectedDate:'2099-02-01',reason},'staff');await assert.rejects(reportSupplierIssue(env,report(fresh),'staff'),/changed/);
 fresh=await readPurchaseOrder(env,{purchaseOrderId:p.id});await cancel(env,fresh);await assert.rejects(reportSupplierIssue(env,report(fresh),'staff'),/changed/);assert.equal(quantity(s),8);assert.equal(count(s,'_ecommerce_supplier_issues'),0);
});

test('a receipt winning the race refuses the whole discrepancy report',async()=>{
 const{env,sqlite:s}=fixture(),p=await purchase(env),original=env.DB.batch;let first=true;
 env.DB.batch=async q=>{if(first){first=false;env.DB.batch=original;await receive(env,p,3);}return original.call(env.DB,q);};
 await assert.rejects(reportSupplierIssue(env,report(p),'staff'),/changed/);assert.equal(quantity(s),8);assert.equal(count(s,'_ecommerce_supplier_issues'),0);
});

test('concurrent reports cannot overclaim outstanding units and same-key requests recover one report',async()=>{
 const{env,sqlite:s}=fixture(),p=await purchase(env);
 const results=await Promise.allSettled([reportSupplierIssue(env,report(p,{quantity:6}),'staff'),reportSupplierIssue(env,report(p,{quantity:6}),'staff')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const input=report(p,{quantity:4});const same=await Promise.all([reportSupplierIssue(env,input,'staff'),reportSupplierIssue(env,input,'staff')]);assert.equal(same[0].issueId,same[1].issueId);assert.equal(count(s,'_ecommerce_supplier_issues'),2);assert.equal(quantity(s),5);
});

test('completed and cancelled purchases keep issues visible until independently resolved',async()=>{
 for(const outcome of ['received','cancelled']){const{env,sqlite:s}=fixture(),p=await purchase(env),r=await reportSupplierIssue(env,report(p,{reason:'Private supplier settlement explanation'}),'staff');
 if(outcome==='received')await receive(env,p,10);else await cancel(env,p);
 assert.equal((await listPurchaseOrders(env,{filter:'open'})).rows[0].openIssues,1);assert.equal((await readCommerceAttention(env)).counts.supplier_issue,1);
 const aggregate=await readOperationsReport(env,{start:'2020-01-01',end:'2020-01-01'});assert.equal(aggregate.backlog.find(x=>x.kind==='supplier').count,1);assert.doesNotMatch(JSON.stringify(aggregate),/Private supplier|Supply desk|supissue_/);
 const i=await readSupplierIssue(env,{issueId:r.issueId}),input=event(i,{status:'resolved',reason:'Replacement received or remaining supply cancelled as agreed'}),e=await recordSupplierIssue(env,input,'staff');assert.equal((await recordSupplierIssue(env,input,'staff')).eventId,e.eventId);
 assert.equal((await listSupplierIssues(env)).total,0);assert.equal((await listPurchaseOrders(env,{filter:'open'})).total,0);assert.equal((await readCommerceAttention(env)).counts.supplier_issue,undefined);
 assert.equal(quantity(s),outcome==='received'?15:5);const reopened=await readSupplierIssue(env,{issueId:r.issueId});await recordSupplierIssue(env,event(reopened,{status:'open',reason:'Supplier follow-up reopened after new information'}),'staff');assert.equal((await listSupplierIssues(env)).total,1);
 assert.equal((await readPurchaseOrder(env,{purchaseOrderId:p.id})).deliveries[0].remaining,0);
 }
});

test('follow-up versions serialize competing resolutions and protect history',async()=>{
 const{env,sqlite:s}=fixture(),p=await purchase(env),r=await reportSupplierIssue(env,report(p),'staff'),i=await readSupplierIssue(env,{issueId:r.issueId});
 const results=await Promise.allSettled([recordSupplierIssue(env,event(i,{status:'resolved'}),'staff'),recordSupplierIssue(env,event(i,{status:'resolved'}),'staff')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const fresh=await readSupplierIssue(env,{issueId:i.id});await assert.rejects(recordSupplierIssue(env,event(fresh,{status:'resolved'}),'staff'),/changed/);
 assert.throws(()=>s.prepare('UPDATE _ecommerce_supplier_issue_events SET reason=?').run('Changed history'),/immutable/);assert.throws(()=>s.prepare('DELETE FROM _ecommerce_supplier_issue_events').run(),/immutable/);
});

test('pagination and truncated histories never truncate totals or authoritative versions',async()=>{
 const{env,sqlite:s}=fixture(),p=await purchase(env,{quantity:100});for(let n=0;n<51;n++)await reportSupplierIssue(env,report(p,{quantity:1}),'staff');
 const first=await listSupplierIssues(env);assert.equal(first.total,51);assert.equal(first.rows.length,50);assert.equal((await listSupplierIssues(env,{offset:50})).rows.length,1);assert.equal((await listSupplierIssues(env,{purchaseOrderId:'other'})).total,0);
 let detail=await readSupplierIssue(env,{issueId:first.rows[0].id});for(let n=0;n<101;n++){const r=await recordSupplierIssue(env,event(detail),'staff');detail={...detail,version:r.eventId};}
 const read=await readSupplierIssue(env,{issueId:detail.id});assert.equal(read.history.length,100);assert.equal(read.historyTruncated,true);assert.equal(read.version,detail.version);assert.doesNotMatch(JSON.stringify(read),/fingerprint|expectedPurchaseVersion|expectedDeliveryVersion/);
 const closed=await recordSupplierIssue(env,event(read,{status:'resolved'}),'staff');assert.equal((await readSupplierIssue(env,{issueId:detail.id})).version,closed.eventId);
});

test('staff authorization, same origin and strict inputs protect issue reads and writes',async()=>{
 const{env}=fixture(),p=await purchase(env);globalThis.workerEnv=env;const request=(method='GET',origin='https://shop.test',data)=>new Request('https://shop.test/admin/api/ecommerce/operations?view=supplierIssues',{method,...(method==='POST'?{headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(data)}:{})});
 globalThis.cmsUser=null;assert.equal((await route({request:request()})).status,401);globalThis.cmsUser={id:'editor',role:'editor'};assert.equal((await route({request:request()})).status,403);globalThis.cmsUser={id:'staff',role:'admin'};
 assert.equal((await route({request:request('POST','https://wrong.test',{action:'supplierIssueReport',data:report(p)})})).status,403);
 const r=await route({request:request('POST','https://shop.test',{action:'supplierIssueReport',data:report(p)})});assert.equal(r.status,200);const{id:unused,...body}=await r.json();assert.ok(body.result.issueId);
 assert.equal((await route({request:request()})).status,200);const read=await route({request:request('POST','https://shop.test',{action:'supplierIssueRead',data:{issueId:body.result.issueId}})});assert.equal(read.status,200);
 assert.equal((await route({request:request('POST','https://shop.test',{action:'supplierIssueReport',data:report(p,{kind:'invented'})})})).status,400);await assert.rejects(reportSupplierIssue(env,report(p,{quantity:0}),'staff'));await assert.rejects(reportSupplierIssue(env,report(p,{quantity:1.5}),'staff'));await assert.rejects(reportSupplierIssue(env,report(p,{unknown:'field'}),'staff'));await assert.rejects(reportSupplierIssue(env,report(p),''),/staff/);
 delete globalThis.cmsUser;delete globalThis.workerEnv;
});

test('reports and supplier follow-up survive a deleted stock pool without making it sellable',async()=>{
 const{env,sqlite:s}=fixture(),p=await purchase(env);s.exec("DELETE FROM _ecommerce_components WHERE id='pool'");const r=await reportSupplierIssue(env,report(p),'staff');assert.equal((await readSupplierIssue(env,{issueId:r.issueId})).quantity,2);assert.equal((await readPurchaseOrder(env,{purchaseOrderId:p.id})).deliveries[0].location,null);
 await cancel(env,p);const i=await readSupplierIssue(env,{issueId:r.issueId});await recordSupplierIssue(env,event(i,{status:'resolved'}),'staff');assert.equal(count(s,'_ecommerce_components'),0);assert.equal(count(s,'_ecommerce_stock_movements'),0);
});
