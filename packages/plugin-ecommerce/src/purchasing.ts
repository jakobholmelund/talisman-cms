import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb, commitBatch, errorText } from './db';
import { hashOrderAccess } from './cookies';
import { CommerceOperationsConflict } from './email-recovery';
import { suppliers, supplierRevisions, purchaseOrders, purchaseOrderEvents, purchaseOrderLines, replenishmentDeliveries, replenishmentDeliveryEvents, RESTOCK_TARGET_TYPES, type PurchaseLine } from './schema';
import { physicalStockLocations } from './replenishment';
import { adminActorNames } from './admin-actors';
const id = z.string().trim().min(1).max(128), key = id.min(8), reason = z.string().trim().min(8).max(500);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0,10) === v);
const lineInput = z.object({ targetType: z.enum(RESTOCK_TARGET_TYPES), targetId: id, quantity: z.number().int().min(1).max(1000000) }).strict();
const linesInput = z.array(lineInput).min(1).max(20).refine(rows => new Set(rows.map(r => `${r.targetType}:${r.targetId}`)).size === rows.length, 'Choose each stock pool once');
const supplierInput = z.object({ supplierId: id.nullable(), expectedVersion: id.nullable(), requestKey: key, name: z.string().trim().min(1).max(200), contact: z.string().trim().max(500), address: z.string().trim().max(1000), active: z.boolean(), reason }).strict();
const draftInput = z.object({ purchaseOrderId: id.nullable(), expectedVersion: id.nullable(), requestKey: key, supplierId: id, supplierVersion: id, reference: z.string().trim().min(1).max(200), expectedDate: date, lines: linesInput, reason }).strict();
const actionInput = z.object({ purchaseOrderId: id, expectedVersion: id, requestKey: key, action: z.enum(['order','reschedule','cancel']), supplierVersion: id.optional(), expectedDate: date.optional(), reason }).strict().refine(v => (v.action === 'reschedule') === (v.expectedDate !== undefined) && (v.action === 'order') === (v.supplierVersion !== undefined));
async function identity(input: unknown, actor: string, prefix: string) {
  if (!actor.trim()) throw new CommerceOperationsConflict('An authenticated staff member is required.');
  return { id: `${prefix}_${await hashOrderAccess((input as {requestKey:string}).requestKey)}`, fingerprint: await hashOrderAccess(JSON.stringify({input,actor})) };
}
async function conflict<T>(write: () => Promise<unknown>, replay: () => Promise<T | null>) {
  try { await write(); } catch (error) { const previous = await replay(); if (previous) return previous;
    if (!/Purchasing|Replenishment|UNIQUE constraint/.test(errorText(error))) throw error;
    throw new CommerceOperationsConflict('The supplier, purchase order or delivery changed. Refresh before continuing.'); }
  return null;
}
export async function listSuppliers(env: TalismanEnv, input: unknown = {}) {
  const v = z.object({offset:z.coerce.number().int().min(0).max(1000000).default(0),filter:z.enum(['active','all']).default('active'),search:z.string().trim().max(100).default('')}).strict().parse(input), db = commerceDb(env);
  const pattern = `%${v.search.replace(/[\\%_]/g,c=>`\\${c}`)}%`;
  const where = sql`r.rowid=(SELECT rowid FROM _ecommerce_supplier_revisions WHERE supplier_id=r.supplier_id ORDER BY rowid DESC LIMIT 1) AND (${v.filter}='all' OR r.active=1) AND r.name LIKE ${pattern} ESCAPE '\\'`;
  const [rows,count] = await db.batch([db.all<{id:string;version:string;name:string;contact:string;address:string;active:number}>(sql`SELECT r.supplier_id AS id,r.id AS version,r.name,r.contact,r.address,r.active FROM _ecommerce_supplier_revisions r WHERE ${where} ORDER BY r.name,r.supplier_id LIMIT 50 OFFSET ${v.offset}`),db.all<{n:number}>(sql`SELECT count(*) n FROM _ecommerce_supplier_revisions r WHERE ${where}`)]);
  return {...v,total:count[0]?.n??0,rows:rows.map(r=>({...r,active:!!r.active}))};
}
export async function saveSupplier(env: TalismanEnv, input: unknown, actor: string) {
  const v = supplierInput.parse(input), db = commerceDb(env), ident = await identity(v,actor,'suprev'), supplierId = v.supplierId ?? `sup_${await hashOrderAccess(v.requestKey)}`;
  const replay = async () => { const r = await db.select().from(supplierRevisions).where(eq(supplierRevisions.id,ident.id)).get(); if(!r)return null;
    if(r.fingerprint!==ident.fingerprint)throw new CommerceOperationsConflict('This supplier key was used with different details.'); return {supplierId:r.supplierId,revisionId:r.id,duplicate:true}; };
  const previous = await replay(); if(previous)return previous;
  const failure = await conflict(()=>commitBatch(db,[...(!v.supplierId?[db.insert(suppliers).values({id:supplierId,createdAt:new Date()})]:[]),db.insert(supplierRevisions).values({...ident,supplierId,expectedVersion:v.expectedVersion,name:v.name,contact:v.contact,address:v.address,active:v.active,actor,reason:v.reason,createdAt:new Date()})]),replay);
  return failure ?? {supplierId,revisionId:ident.id};
}
const latestSupplier = (env:TalismanEnv,supplierId:string) => commerceDb(env).query.supplierRevisions.findFirst({where:{supplierId},orderBy:(_t,{sql})=>sql`rowid DESC`});
const supplierSnapshot = (s:NonNullable<Awaited<ReturnType<typeof latestSupplier>>>) => ({version:s.id,name:s.name,contact:s.contact,address:s.address});
export async function savePurchaseOrder(env:TalismanEnv,input:unknown,actor:string) {
  const v=draftInput.parse(input),db=commerceDb(env),ident=await identity(v,actor,'poe'),purchaseOrderId=v.purchaseOrderId??`po_${await hashOrderAccess(v.requestKey)}`;
  const replay=eventReplay(db,ident);const previous=await replay();if(previous)return previous;
  const supplier=await latestSupplier(env,v.supplierId);if(!supplier?.active||supplier.id!==v.supplierVersion)throw new CommerceOperationsConflict('Supplier changed or is inactive. Refresh before continuing.');
  const lines:PurchaseLine[]=[];
  for(const l of [...v.lines].sort((a,b)=>`${a.targetType}:${a.targetId}`.localeCompare(`${b.targetType}:${b.targetId}`))) {
    const stock=await db.get<{name:string;sku:string|null}>(sql`WITH physical AS (${physicalStockLocations}) SELECT name,sku FROM physical WHERE type=${l.targetType} AND id=${l.targetId}`);
    if(!stock)throw new CommerceOperationsConflict('A stock pool is unavailable. Refresh before continuing.'); lines.push({...l,...stock});
  }
  if(v.purchaseOrderId){const order=await db.select().from(purchaseOrders).where(eq(purchaseOrders.id,v.purchaseOrderId)).get();if(order?.supplierId!==v.supplierId)throw new CommerceOperationsConflict('The purchase order supplier cannot be changed.');}
  const failure=await conflict(()=>commitBatch(db,[...(!v.purchaseOrderId?[db.insert(purchaseOrders).values({id:purchaseOrderId,supplierId:v.supplierId,createdAt:new Date()})]:[]),db.insert(purchaseOrderEvents).values({...ident,purchaseOrderId,expectedVersion:v.expectedVersion,status:'draft',reference:v.reference,expectedDate:v.expectedDate,lines,supplier:supplierSnapshot(supplier),actor,reason:v.reason,createdAt:new Date()})]),replay);
  return failure??{purchaseOrderId,eventId:ident.id};
}
function eventReplay(db:ReturnType<typeof commerceDb>,ident:{id:string;fingerprint:string}) {return async()=>{const r=await db.select().from(purchaseOrderEvents).where(eq(purchaseOrderEvents.id,ident.id)).get();if(!r)return null;if(r.fingerprint!==ident.fingerprint)throw new CommerceOperationsConflict('This purchase order key was used with different details.');return {purchaseOrderId:r.purchaseOrderId,eventId:r.id,duplicate:true};};}
export async function recordPurchaseOrder(env:TalismanEnv,input:unknown,actor:string) {
  const v=actionInput.parse(input),db=commerceDb(env),ident=await identity(v,actor,'poe'),replay=eventReplay(db,ident),previous=await replay();if(previous)return previous;
  const order=await db.query.purchaseOrders.findFirst({where:{id:v.purchaseOrderId},with:{events:{orderBy:(_t,{sql})=>sql`rowid`},lines:{with:{delivery:{with:{events:{orderBy:(_t,{sql})=>sql`rowid`,with:{movement:{columns:{delta:true}}}}}}}}}});
  const last=order?.events.at(-1);if(!order||!last||last.id!==v.expectedVersion||last.status==='cancelled')throw new CommerceOperationsConflict('Purchase order changed. Refresh before continuing.');
  const statements:Parameters<typeof commitBatch>[1]=[],now=new Date();let supplier=last.supplier;
  if(v.action==='order') {
    if(last.status!=='draft')throw new CommerceOperationsConflict('This purchase order has already been confirmed.');
    const current=await latestSupplier(env,order.supplierId);if(!current?.active||current.id!==v.supplierVersion)throw new CommerceOperationsConflict('Supplier changed or is inactive. Refresh before continuing.');supplier=supplierSnapshot(current);
    for(const [index,line] of last.lines.entries()) {const deliveryId=`pod_${await hashOrderAccess(`${order.id}:${index}`)}`;
      statements.push(db.insert(replenishmentDeliveries).values({id:deliveryId,targetType:line.targetType,targetId:line.targetId,quantity:line.quantity,supplier:supplier.name,reference:last.reference,expectedDate:last.expectedDate,actor,reason:v.reason,fingerprint:ident.fingerprint,createdAt:now}),db.insert(purchaseOrderLines).values({id:deliveryId,purchaseOrderId:order.id,lineIndex:index,deliveryId}));}
  } else if(v.action==='reschedule'&&last.status!=='ordered')throw new CommerceOperationsConflict('Only confirmed purchase orders can be rescheduled.');
  if(v.action==='cancel'&&last.status==='ordered') {
    for(const l of order.lines) {const received=l.delivery.events.reduce((n,e)=>n+(e.movement?.delta??0),0);if(l.delivery.events.some(e=>e.kind==='cancelled')||received>=l.delivery.quantity)continue;
      statements.push(db.insert(replenishmentDeliveryEvents).values({id:`poc_${await hashOrderAccess(`${ident.id}:${l.id}`)}`,deliveryId:l.deliveryId,kind:'cancelled',movementId:null,expectedVersion:l.delivery.events.at(-1)?.id??l.deliveryId,actor,reason:v.reason,fingerprint:ident.fingerprint,createdAt:now}));}
    if(!statements.length)throw new CommerceOperationsConflict('There are no outstanding units to cancel.');
  }
  statements.push(db.insert(purchaseOrderEvents).values({...ident,purchaseOrderId:order.id,expectedVersion:last.id,status:v.action==='cancel'?'cancelled':'ordered',reference:last.reference,expectedDate:v.expectedDate??last.expectedDate,lines:last.lines,supplier,actor,reason:v.reason,createdAt:now}));
  const failure=await conflict(()=>commitBatch(db,statements),replay);return failure??{purchaseOrderId:order.id,eventId:ident.id};
}
const queueCte=sql`WITH latest AS (SELECT p.id,p.supplier_id AS supplierId,p.created_at AS createdAt,e.id AS version,e.status,e.reference,e.expected_date AS expectedDate,json_extract(e.supplier,'$.name') AS supplier,
 COALESCE((SELECT sum(MAX(0,d.quantity-COALESCE((SELECT sum(m.delta) FROM _ecommerce_replenishment_delivery_events x JOIN _ecommerce_stock_movements m ON m.id=x.movement_id WHERE x.delivery_id=d.id),0))) FROM _ecommerce_purchase_order_lines l JOIN _ecommerce_replenishment_deliveries d ON d.id=l.delivery_id WHERE l.purchase_order_id=p.id AND NOT EXISTS(SELECT 1 FROM _ecommerce_replenishment_delivery_events x WHERE x.delivery_id=d.id AND x.kind='cancelled')),0) AS outstanding
 FROM _ecommerce_purchase_orders p JOIN _ecommerce_purchase_order_events e ON e.id=(SELECT id FROM _ecommerce_purchase_order_events WHERE purchase_order_id=p.id ORDER BY rowid DESC LIMIT 1))`;
export async function listPurchaseOrders(env:TalismanEnv,input:unknown={}) {
  const v=z.object({offset:z.coerce.number().int().min(0).max(1000000).default(0),filter:z.enum(['open','draft','ordered','completed','cancelled','all']).default('open'),search:z.string().trim().max(100).default('')}).strict().parse(input),db=commerceDb(env);
  const pattern=`%${v.search.replace(/[\\%_]/g,c=>`\\${c}`)}%`,where=sql`(reference LIKE ${pattern} ESCAPE '\\' OR supplier LIKE ${pattern} ESCAPE '\\') AND (${v.filter}='all' OR (${v.filter}='open' AND (status='draft' OR (status='ordered' AND outstanding>0))) OR (${v.filter}='completed' AND status='ordered' AND outstanding=0) OR (${v.filter} IN ('draft','ordered','cancelled') AND status=${v.filter}))`;
  const [rows,count]=await db.batch([db.all<{id:string;supplierId:string;createdAt:number;version:string;status:'draft'|'ordered'|'cancelled';reference:string;expectedDate:string;supplier:string;outstanding:number}>(sql`${queueCte} SELECT * FROM latest WHERE ${where} ORDER BY createdAt DESC,id LIMIT 50 OFFSET ${v.offset}`),db.all<{n:number}>(sql`${queueCte} SELECT count(*) n FROM latest WHERE ${where}`)]);
  return {...v,total:count[0]?.n??0,rows:rows.map(r=>({...r,createdAt:new Date(r.createdAt*1000).toISOString()}))};
}
export async function readPurchaseOrder(env:TalismanEnv,input:unknown) {
  const {purchaseOrderId}=z.object({purchaseOrderId:id}).strict().parse(input),db=commerceDb(env);
  const order=await db.query.purchaseOrders.findFirst({where:{id:purchaseOrderId},with:{events:{orderBy:(_t,{sql})=>sql`rowid DESC`,limit:200},lines:{with:{delivery:{with:{events:{orderBy:(_t,{sql})=>sql`rowid`,with:{movement:{columns:{delta:true}}}}}}}}}});
  const latest=order?.events[0];
  if(!order||!latest)throw new CommerceOperationsConflict('Purchase order not found.');
  const names=await adminActorNames(env,order.events.map(e=>e.actor)),current=await latestSupplier(env,order.supplierId);
  const deliveries=await Promise.all(order.lines.map(async l=>{const d=l.delivery,stock=await db.get<{type:typeof RESTOCK_TARGET_TYPES[number];id:string;name:string;sku:string|null;quantity:number;updated:number}>(sql`WITH physical AS (${physicalStockLocations}) SELECT * FROM physical WHERE type=${d.targetType} AND id=${d.targetId}`),received=d.events.reduce((n,e)=>n+(e.movement?.delta??0),0),cancelled=d.events.some(e=>e.kind==='cancelled');
    return {lineIndex:l.lineIndex,deliveryId:d.id,version:d.events.at(-1)?.id??d.id,received,remaining:cancelled?0:d.quantity-received,cancelled,location:stock?{type:stock.type,id:stock.id,name:stock.name,sku:stock.sku,quantity:stock.quantity,updatedAt:new Date(stock.updated*1000).toISOString()}:null};}));
  return {id:order.id,supplierId:order.supplierId,currentSupplier:current?{...supplierSnapshot(current),active:current.active}:null,version:latest.id,status:latest.status,reference:latest.reference,expectedDate:latest.expectedDate,supplier:latest.supplier,lines:latest.lines,deliveries,
    history:[...order.events].reverse().map(e=>({id:e.id,status:e.status,reference:e.reference,expectedDate:e.expectedDate,lines:e.lines,actorName:names.get(e.actor)??e.actor,reason:e.reason,createdAt:e.createdAt.toISOString()})),historyTruncated:order.events.length===200};
}
