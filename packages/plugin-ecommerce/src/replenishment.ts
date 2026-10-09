import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb, errorText, commitBatch } from './db';
import { hashOrderAccess } from './cookies';
import { CommerceOperationsConflict } from './email-recovery';
import { replenishmentPolicies, replenishmentDeliveries, replenishmentDeliveryEvents, stockMovements, RESTOCK_TARGET_TYPES } from './schema';
import { adminActorNames } from './admin-actors';
const id=z.string().trim().min(1).max(128),reason=z.string().trim().min(8).max(500),quantity=z.number().int().min(0).max(1000000);
const target={targetType:z.enum(RESTOCK_TARGET_TYPES),targetId:id};
type Policy=typeof replenishmentPolicies.$inferSelect;type Delivery=typeof replenishmentDeliveries.$inferSelect;
export type ReplenishmentLocation={type:typeof RESTOCK_TARGET_TYPES[number];id:string;name:string;sku:string|null;quantity:number;updatedAt:string;minimumQuantity:number|null;targetQuantity:number|null;enabled:boolean;incoming:number;suggested:number;policyVersion:string|null};
export type ReplenishmentQueue={offset:number;total:number;search:string;filter:string;rows:ReplenishmentLocation[]};
export type ReplenishmentDetail={targetType:ReplenishmentLocation['type'];targetId:string;location:ReplenishmentLocation|null;
 deliveryOffset:number;deliveryTotal:number; policies:Array<Omit<Policy,'fingerprint'|'createdAt'>&{createdAt:string;actorName:string}>;
 deliveries:Array<Omit<Delivery,'fingerprint'|'createdAt'>&{createdAt:string;actorName:string;received:number;remaining:number;cancelled:boolean;version:string;events:Array<{id:string;kind:'received'|'cancelled';quantity:number;actorName:string;reason:string;createdAt:string}>}>};
// Physical pools only; component-backed catalog choices never multiply their shared component supply.
export const physicalStockLocations=sql`SELECT 'product' AS type,id,name,sku,inventory_quantity AS quantity,updated_at AS updated FROM _ecommerce_products WHERE type='standard'
 UNION ALL SELECT 'variant',v.id,p.name||' / '||v.name,v.sku,v.inventory_quantity,v.updated_at FROM _ecommerce_product_variants v JOIN _ecommerce_products p ON p.id=v.product_id WHERE p.type='standard'
 UNION ALL SELECT 'stock',s.id,p.name||' / '||v.name||' / '||x.value,x.sku,s.quantity,s.updated_at FROM _ecommerce_stocks s JOIN _ecommerce_product_variant_values x ON x.id=s.product_variant_value_id JOIN _ecommerce_product_variants v ON v.id=x.product_variant_id JOIN _ecommerce_products p ON p.id=v.product_id
 UNION ALL SELECT 'component',id,name,sku,quantity,updated_at FROM _ecommerce_components`;
const cte=sql`WITH physical AS (${physicalStockLocations}), locations AS (SELECT *,1 AS available FROM physical UNION ALL SELECT d.target_type,d.target_id,'Unavailable stock · '||d.target_id,NULL,0,0,0 FROM _ecommerce_replenishment_deliveries d WHERE NOT EXISTS(SELECT 1 FROM physical p WHERE p.type=d.target_type AND p.id=d.target_id) GROUP BY d.target_type,d.target_id), planned AS (SELECT l.*,
 (SELECT id FROM _ecommerce_replenishment_policies p WHERE p.target_type=l.type AND p.target_id=l.id ORDER BY rowid DESC LIMIT 1) AS policyVersion,
 COALESCE((SELECT sum(MAX(0,d.quantity-COALESCE((SELECT sum(m.delta) FROM _ecommerce_replenishment_delivery_events e JOIN _ecommerce_stock_movements m ON m.id=e.movement_id WHERE e.delivery_id=d.id),0))) FROM _ecommerce_replenishment_deliveries d WHERE d.target_type=l.type AND d.target_id=l.id AND NOT EXISTS(SELECT 1 FROM _ecommerce_replenishment_delivery_events e WHERE e.delivery_id=d.id AND e.kind='cancelled')),0) AS incoming FROM locations l),
 plans AS (SELECT l.*,p.minimum_quantity AS minimumQuantity,p.target_quantity AS targetQuantity,COALESCE(p.enabled,0) AS enabled,
 CASE WHEN p.enabled=1 AND l.quantity<=p.minimum_quantity THEN MAX(0,p.target_quantity-l.quantity-l.incoming) ELSE 0 END AS suggested FROM planned l LEFT JOIN _ecommerce_replenishment_policies p ON p.id=l.policyVersion)`;
/** Effective promise date for a delivery aliased as d; original plans stay immutable. */
export const effectiveDeliveryDate=sql`COALESCE((SELECT e.expected_date FROM _ecommerce_purchase_order_lines l JOIN _ecommerce_purchase_order_events e ON e.purchase_order_id=l.purchase_order_id WHERE l.delivery_id=d.id ORDER BY e.rowid DESC LIMIT 1),d.expected_date)`;
type RawLocation=Omit<ReplenishmentLocation,'updatedAt'|'enabled'>&{updated:number;enabled:number;available:number};
const location=(r:RawLocation):ReplenishmentLocation=>({type:r.type,id:r.id,name:r.name,sku:r.sku,quantity:r.quantity,updatedAt:new Date(r.updated*1000).toISOString(),minimumQuantity:r.minimumQuantity,targetQuantity:r.targetQuantity,enabled:!!r.enabled,incoming:r.incoming,suggested:r.suggested,policyVersion:r.policyVersion});
export async function listReplenishment(env:TalismanEnv,input:unknown={}):Promise<ReplenishmentQueue>{
 const v=z.object({offset:z.coerce.number().int().min(0).max(1000000).default(0),search:z.string().trim().max(100).default(''),filter:z.enum(['suggested','configured','incoming','all']).default('suggested')}).strict().parse(input),db=commerceDb(env);
 const pattern=`%${v.search.replace(/[\\%_]/g,c=>`\\${c}`)}%`,where=sql`(name LIKE ${pattern} ESCAPE '\\' OR COALESCE(sku,'') LIKE ${pattern} ESCAPE '\\') AND (${v.filter}='all' OR (${v.filter}='incoming' AND incoming>0) OR (${v.filter}='configured' AND policyVersion IS NOT NULL) OR (${v.filter}='suggested' AND suggested>0))`;
 const [rows,count]=await db.batch([db.all<RawLocation>(sql`${cte} SELECT * FROM plans WHERE ${where} ORDER BY suggested DESC,name,type,id LIMIT 50 OFFSET ${v.offset}`),db.all<{n:number}>(sql`${cte} SELECT count(*) n FROM plans WHERE ${where}`)]);
 return {...v,total:count[0]?.n??0,rows:rows.map(location)};
}
export async function readReplenishment(env:TalismanEnv,input:unknown):Promise<ReplenishmentDetail>{
 const v=z.object({...target,deliveryOffset:z.coerce.number().int().min(0).max(1000000).default(0)}).strict().parse(input),db=commerceDb(env);
 const [row,policies,deliveries,deliveryCount]=await Promise.all([db.get<RawLocation>(sql`${cte} SELECT * FROM plans WHERE type=${v.targetType} AND id=${v.targetId}`),db.query.replenishmentPolicies.findMany({where:{targetType:v.targetType,targetId:v.targetId},orderBy:(_t,{sql})=>sql`rowid DESC`,limit:50}),db.query.replenishmentDeliveries.findMany({where:{targetType:v.targetType,targetId:v.targetId},orderBy:{createdAt:'desc',id:'desc'},limit:50,offset:v.deliveryOffset,with:{events:{orderBy:(_t,{sql})=>sql`rowid`,with:{movement:{columns:{delta:true}}}}}}),db.select({n:sql<number>`count(*)`.mapWith(Number)}).from(replenishmentDeliveries).where(sql`${replenishmentDeliveries.targetType}=${v.targetType} AND ${replenishmentDeliveries.targetId}=${v.targetId}`).get()]);
 const dates=await db.all<{id:string;expectedDate:string}>(sql`SELECT d.id,${effectiveDeliveryDate} AS expectedDate FROM _ecommerce_replenishment_deliveries d WHERE d.target_type=${v.targetType} AND d.target_id=${v.targetId} ORDER BY d.created_at DESC,d.id DESC LIMIT 50 OFFSET ${v.deliveryOffset}`);
 const effectiveDates=new Map(dates.map(d=>[d.id,d.expectedDate]));
 const names=await adminActorNames(env,[...policies.map(p=>p.actor),...deliveries.flatMap(d=>[d.actor,...d.events.map(e=>e.actor)])]);
 return {...v,deliveryTotal:deliveryCount?.n??0,location:row?.available?location(row):null,policies:policies.map(({fingerprint,...p})=>({...p,createdAt:p.createdAt.toISOString(),actorName:names.get(p.actor)??p.actor})),deliveries:deliveries.map(({fingerprint,events,...d})=>{
 const received=events.reduce((n,e)=>n+(e.movement?.delta??0),0),cancelled=events.some(e=>e.kind==='cancelled');return {...d,expectedDate:effectiveDates.get(d.id)??d.expectedDate,createdAt:d.createdAt.toISOString(),actorName:names.get(d.actor)??d.actor,received,remaining:cancelled?0:d.quantity-received,cancelled,version:events.at(-1)?.id??d.id,events:events.map(e=>({id:e.id,kind:e.kind,quantity:e.movement?.delta??0,actorName:names.get(e.actor)??e.actor,reason:e.reason,createdAt:e.createdAt.toISOString()}))};})};
}
const policySchema=z.object({...target,requestKey:id.min(8),expectedVersion:id.nullable(),minimumQuantity:quantity,targetQuantity:quantity,enabled:z.boolean(),reason}).strict().refine(v=>v.targetQuantity>=v.minimumQuantity);
const planSchema=z.object({...target,requestKey:id.min(8),quantity:quantity.min(1),supplier:z.string().trim().min(1).max(200),reference:z.string().trim().max(200),expectedDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v),reason}).strict();
const eventSchema=z.object({deliveryId:id,requestKey:id.min(8),expectedVersion:id,kind:z.enum(['received','cancelled']),quantity:quantity.optional(),expectedQuantity:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),expectedUpdatedAt:z.string().datetime({offset:true}).optional(),reason}).strict().refine(v=>v.kind==='cancelled' ? v.quantity===undefined&&v.expectedQuantity===undefined&&v.expectedUpdatedAt===undefined : !!v.quantity&&v.expectedQuantity!==undefined&&!!v.expectedUpdatedAt);
async function identity(input:unknown,actor:string,prefix:string){if(!actor.trim())throw new CommerceOperationsConflict('An authenticated staff member is required.');const v=input as {requestKey:string};return {id:`${prefix}_${await hashOrderAccess(v.requestKey)}`,fingerprint:await hashOrderAccess(JSON.stringify({input,actor}))};}
export async function saveReplenishmentPolicy(env:TalismanEnv,input:unknown,actor:string):Promise<{policyId:string;duplicate?:boolean}>{
 const v=policySchema.parse(input),db=commerceDb(env),ident=await identity(v,actor,'rpl');
 const replay=async()=>{const row=await db.select().from(replenishmentPolicies).where(eq(replenishmentPolicies.id,ident.id)).get();if(!row)return null;if(row.fingerprint!==ident.fingerprint)throw new CommerceOperationsConflict('This planning key was used with other details.');return {policyId:row.id,duplicate:true};};
 const previous=await replay();if(previous)return previous;
 try{const {requestKey,...fields}=v;await db.insert(replenishmentPolicies).values({...fields,...ident,actor,createdAt:new Date()});}catch(error){const previous=await replay();if(previous)return previous;if(!errorText(error).includes('Replenishment'))throw error;throw new CommerceOperationsConflict('Stock target or policy changed. Refresh before saving.');}return {policyId:ident.id};
}
export async function planReplenishmentDelivery(env:TalismanEnv,input:unknown,actor:string):Promise<{deliveryId:string;duplicate?:boolean}>{
 const v=planSchema.parse(input),db=commerceDb(env),ident=await identity(v,actor,'rpd');
 const replay=async()=>{const row=await db.select().from(replenishmentDeliveries).where(eq(replenishmentDeliveries.id,ident.id)).get();if(!row)return null;if(row.fingerprint!==ident.fingerprint)throw new CommerceOperationsConflict('This delivery key was used with other details.');return {deliveryId:row.id,duplicate:true};};
 const previous=await replay();if(previous)return previous;
 try{const {requestKey,...fields}=v;await db.insert(replenishmentDeliveries).values({...fields,...ident,actor,createdAt:new Date()});}catch(error){const previous=await replay();if(previous)return previous;if(!errorText(error).includes('Replenishment'))throw error;throw new CommerceOperationsConflict('This stock target is unavailable. Refresh before planning.');}return {deliveryId:ident.id};
}
export async function recordReplenishmentDelivery(env:TalismanEnv,input:unknown,actor:string):Promise<{eventId:string;duplicate?:boolean}>{
 const v=eventSchema.parse(input),db=commerceDb(env),ident=await identity(v,actor,'rpe');
 const replay=async()=>{const row=await db.select().from(replenishmentDeliveryEvents).where(eq(replenishmentDeliveryEvents.id,ident.id)).get();if(!row)return null;if(row.fingerprint!==ident.fingerprint)throw new CommerceOperationsConflict('This delivery receipt key was used with other details.');return {eventId:row.id,duplicate:true};};
 const previous=await replay();if(previous)return previous;
 const delivery=await db.select().from(replenishmentDeliveries).where(eq(replenishmentDeliveries.id,v.deliveryId)).get();if(!delivery)throw new CommerceOperationsConflict('Delivery plan not found.');
 const movementId=v.kind==='received'?`mov_${ident.id}`:null,now=new Date();
 if(v.kind==='received'&&!Number.isSafeInteger(v.expectedQuantity!+v.quantity!))throw new CommerceOperationsConflict('Stock quantity would be invalid.');
 try{await commitBatch(db,[
 ...(movementId?[db.insert(stockMovements).values({id:movementId,targetType:delivery.targetType,targetId:delivery.targetId,kind:'receipt',delta:v.quantity!,beforeQuantity:v.expectedQuantity!,afterQuantity:v.expectedQuantity!+v.quantity!,expectedUpdatedAt:new Date(v.expectedUpdatedAt!),actor,reason:v.reason,fingerprint:ident.fingerprint,createdAt:now})]:[]),
 db.insert(replenishmentDeliveryEvents).values({...ident,deliveryId:v.deliveryId,kind:v.kind,movementId,expectedVersion:v.expectedVersion,actor,reason:v.reason,createdAt:now})]);}
 catch(error){const previous=await replay();if(previous)return previous;if(!/Stock|stock|Replenishment/.test(errorText(error)))throw error;throw new CommerceOperationsConflict('Delivery or stock changed. Reload current quantities before receiving or cancelling.');}
 return {eventId:ident.id};
}
