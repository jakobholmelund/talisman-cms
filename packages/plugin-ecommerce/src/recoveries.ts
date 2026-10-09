import { recoveryProgressQuery, RECOVERY_NEXT_ACTIONS, recoveryActionLabels, type RecoveryProgressRow } from './recovery-progress';
import { checkExchangeCharge } from './recovery-payments';
import type { PaymentProviderAdapter } from './payments';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb, errorText } from './db';
import { commerceContext } from './commerce-context';
import { loadBasketCatalog, requireVariantChoice, resolveSelectedVariant } from './basket';
import { readStoreCurrency } from './store-settings';
import { readOrderWarehouse, warehouseFingerprint } from './warehouse';
import { physicalStockLocations } from './replenishment';
import { describeOrderItems } from './order-items';
import { adminActorNames } from './admin-actors';
import { hashOrderAccess } from './cookies';
import { CommerceOperationsConflict } from './email-recovery';
import { recoveryCases, recoveryEvents, recoveryShipments, RECOVERY_KINDS, RESTOCK_TARGET_TYPES, type RecoveryTarget } from './schema';
const id = z.string().trim().min(1).max(128), reason = z.string().trim().min(8).max(500), units = z.number().int().min(1).max(1000000);
const line = z.number().int().min(0).max(199);
const timestamp = z.string().refine(s => Number.isSafeInteger(Date.parse(s)) && Date.parse(s)%1000===0, 'Reload the stock version');
const report = z.object({ orderId:id, kind:z.enum(RECOVERY_KINDS), fulfillmentId:id.nullable().default(null), sourceShipmentId:id.nullable().default(null), receiptId:id.nullable().default(null),
 lineIndex:line, quantity:units, expectedUnitPrice:z.number().int().min(1).max(1000000000).optional(), allowPriceDifference:z.boolean().default(false), productId:id.optional(), variantId:id.nullable().optional(), requestKey:id.min(8), reason }).strict();
export const openRecoveryCase = sql`COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),'open')='open' OR (COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=c.id AND actor='payment_provider'),0)>COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=c.id AND kind='resolve'),0)) OR EXISTS(SELECT 1 FROM _ecommerce_recovery_receipts r JOIN _ecommerce_recovery_shipments s ON s.id=r.shipment_id WHERE s.case_id=c.id AND r.quantity>COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_inspections WHERE receipt_id=r.id),0))`;
const actorRequired = (actor:string) => { if(!actor.trim())throw new CommerceOperationsConflict('An authenticated staff member is required.'); };
function targets(target:RecoveryTarget):RecoveryTarget {
 const totals = new Map<string, RecoveryTarget['stockTargets'][number]>();
 for(const t of target.stockTargets){if(!RESTOCK_TARGET_TYPES.includes(t.type)||!t.id||!Number.isSafeInteger(t.units)||t.units<=0)throw new CommerceOperationsConflict('The frozen stock mapping is unavailable.');const key=`${t.type}:${t.id}`, old=totals.get(key);totals.set(key,{...t,units:t.units+(old?.units??0)});}
 if(!Number.isSafeInteger(target.adjustmentMinor??0)||Math.abs(target.adjustmentMinor??0)>1000000000)throw new CommerceOperationsConflict('This exchange amount is too large.');
 if(totals.size>50)throw new CommerceOperationsConflict('This replacement needs more than 50 stock pools.');
 return {...target,stockTargets:[...totals.values()].sort((a,b)=>`${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`))};
}
async function write<T>(fn:()=>Promise<unknown>, replay:()=>Promise<T|null>){
 try{await fn();}catch(e){const old=await replay();if(old)return old;if(!/Recovery|Stock |stock_movement|UNIQUE constraint|Refund follow-up/.test(errorText(e)))throw e;throw new CommerceOperationsConflict('The case, payment, returned quantities or stock changed. Refresh before continuing.');}return null;
}
/** Immutable incidents and exchange choices; no reservation, payment or original-order mutation. */
export async function createRecoveryCase(env:TalismanEnv,input:unknown,actor:string){
 const v=report.parse(input);actorRequired(actor);const db=commerceDb(env),caseId=`rec_${await hashOrderAccess(`${v.orderId}:${v.requestKey}`)}`,fingerprint=await warehouseFingerprint(v.allowPriceDifference?v:(({allowPriceDifference,...old})=>old)(v),actor);
 const replay=async()=>{const old=await db.select().from(recoveryCases).where(eq(recoveryCases.id,caseId)).get();if(!old)return null;if(old.fingerprint!==fingerprint)throw new CommerceOperationsConflict('This recovery key was used with different details.');return {caseId,duplicate:true};};
 const previous=await replay();if(previous)return previous;
 const order=await db.query.orders.findFirst({where:{id:v.orderId}});const original=order?.items[v.lineIndex];
 if(!order||!original||order.paymentProvider==='admin_test'||!['paid','partially_refunded'].includes(order.status))throw new CommerceOperationsConflict('Only paid real orders with an affected item can create replacements or exchanges.');
 let target:RecoveryTarget;
 if(v.kind==='exchange'){
  if(!v.receiptId||v.fulfillmentId||v.sourceShipmentId||!v.productId)throw new CommerceOperationsConflict('Choose a received return and an equal-price replacement.');
  if(order.currency!==readStoreCurrency(env))throw new CommerceOperationsConflict('This order uses a different currency from the current catalog.');
  const catalog=await loadBasketCatalog(commerceContext({env}),[{productId:v.productId,variantId:v.variantId}]),product=catalog.products.get(v.productId);
  if(!product||product.status!=='active'||!product.isPhysical||product.type!=='standard')throw new CommerceOperationsConflict('Choose an active physical stock item.');
  requireVariantChoice(catalog,product,v.variantId??undefined);const selected=v.variantId?resolveSelectedVariant(catalog,product,v.variantId):null;
  const price=selected?.price??product.basePrice;if(v.expectedUnitPrice!==undefined&&price!==v.expectedUnitPrice)throw new CommerceOperationsConflict('The replacement price changed. Refresh the choice and agree the adjustment before continuing.');if(!v.allowPriceDifference&&price!==original.priceAtPurchase)throw new CommerceOperationsConflict('The replacement must match the original unit price.');
  const described=(await describeOrderItems(env,[{productId:product.id,variantId:v.variantId}]))[0];
  target={adjustmentMinor:(price-original.priceAtPurchase)*v.quantity,productId:product.id,variantId:v.variantId??null,name:selected?.name??product.name,sku:described.sku,priceAtPurchase:price,
   stockTargets:selected?.components.length?selected.components.map(t=>({type:'component',id:t.id,units:t.quantity})):selected?.inventoryTarget?[{...selected.inventoryTarget,units:1}]:[{type:'product',id:product.id,units:1}]};
  if(order.status!=='paid'&&price>=original.priceAtPurchase)throw new CommerceOperationsConflict('Only a cheaper exchange with a recorded refund may use a partially refunded order.');
 }else{
  if(order.status!=='paid'||v.allowPriceDifference||v.expectedUnitPrice!==undefined)throw new CommerceOperationsConflict('Parcel replacements require a paid order.');
  if(v.receiptId||v.productId!==undefined||v.variantId!==undefined||!!v.fulfillmentId===!!v.sourceShipmentId)throw new CommerceOperationsConflict('Choose one recorded original or replacement parcel.');
  if(v.sourceShipmentId){const source=await db.query.recoveryShipments.findFirst({where:{id:v.sourceShipmentId},with:{case:true}});if(!source||source.case.orderId!==v.orderId||source.case.lineIndex!==v.lineIndex)throw new CommerceOperationsConflict('Replacement parcel not found.');target=source.case.target;}
  else{if(!Array.isArray(original.stockTargets))throw new CommerceOperationsConflict('This older order has no frozen stock mapping for a safe replacement.');const d=(await describeOrderItems(env,[original]))[0];target={productId:original.productId,variantId:original.variantId??null,name:[d.productName||'Ordered item',d.variantLabel].filter(Boolean).join(' / '),sku:d.sku,priceAtPurchase:original.priceAtPurchase,stockTargets:original.stockTargets};}
 }
 const result=await write(()=>db.insert(recoveryCases).values({id:caseId,orderId:v.orderId,kind:v.kind,fulfillmentId:v.fulfillmentId,sourceShipmentId:v.sourceShipmentId,receiptId:v.receiptId,lineIndex:v.lineIndex,quantity:v.quantity,target:targets(target),actor,reason:v.reason,fingerprint,createdAt:new Date()}),replay);
 return result??{caseId};
}
const action=z.object({caseId:id,expectedVersion:id,kind:z.enum(['note','resolve','reopen','tracking']),shipmentId:id.optional(),carrier:z.string().trim().max(100).nullable().optional(),trackingNumber:z.string().trim().max(150).nullable().optional(),reason,requestKey:id.min(8)}).strict();
export async function recordRecoveryEvent(env:TalismanEnv,input:unknown,actor:string){
 const v=action.parse(input);actorRequired(actor);const db=commerceDb(env),eventId=`rce_${await hashOrderAccess(`${v.caseId}:${v.requestKey}`)}`,fingerprint=await warehouseFingerprint(v,actor);
 const replay=async()=>{const old=await db.select().from(recoveryEvents).where(eq(recoveryEvents.id,eventId)).get();if(!old)return null;if(old.fingerprint!==fingerprint)throw new CommerceOperationsConflict('This follow-up key was used with other details.');return {eventId,duplicate:true};};const previous=await replay();if(previous)return previous;
 const latest=await db.query.recoveryCases.findFirst({where:{id:v.caseId},with:{events:{orderBy:(_t,{sql})=>sql`rowid DESC`,limit:1}}});if(!latest||latest.redactedAt)throw new CommerceOperationsConflict('Recovery case unavailable.');
 const status=v.kind==='resolve'?'resolved':v.kind==='reopen'?'open':latest.events[0]?.status??'open';
 if(v.kind==='tracking'?!v.shipmentId:v.shipmentId!==undefined||v.carrier!==undefined||v.trackingNumber!==undefined)throw new CommerceOperationsConflict('Choose a replacement parcel only for a tracking correction.');
 const result=await write(()=>db.insert(recoveryEvents).values({id:eventId,caseId:v.caseId,expectedVersion:v.expectedVersion,kind:v.kind,status,shipmentId:v.shipmentId??null,carrier:v.carrier||null,trackingNumber:v.trackingNumber||null,actor,reason:v.reason,fingerprint,createdAt:new Date()}),replay);return result??{eventId};
}
const ship=z.object({caseId:id,expectedVersion:id,quantity:units,requestKey:id.min(8),reason,carrier:z.string().trim().max(100).nullable().default(null),trackingNumber:z.string().trim().max(150).nullable().default(null),
 stock:z.array(z.object({targetType:z.enum(RESTOCK_TARGET_TYPES),targetId:id,expectedQuantity:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),expectedUpdatedAt:timestamp}).strict()).max(50)}).strict();
export async function shipRecoveryCase(env:TalismanEnv,input:unknown,actor:string,adapters?:PaymentProviderAdapter[]){
 const v=ship.parse(input);actorRequired(actor);const db=commerceDb(env),shipmentId=`rcs_${await hashOrderAccess(`${v.caseId}:${v.requestKey}`)}`,fingerprint=await warehouseFingerprint(v,actor);
 const replay=async()=>{const old=await db.select().from(recoveryShipments).where(eq(recoveryShipments.id,shipmentId)).get();if(!old)return null;if(old.fingerprint!==fingerprint)throw new CommerceOperationsConflict('This replacement shipment key was used with other details.');return {shipmentId,duplicate:true};};const previous=await replay();if(previous)return previous;
 const c=await db.query.recoveryCases.findFirst({where:{id:v.caseId}});if(!c)throw new CommerceOperationsConflict('Recovery case unavailable.');
 if(v.stock.length!==c.target.stockTargets.length||new Set(v.stock.map(t=>`${t.targetType}:${t.targetId}`)).size!==v.stock.length)throw new CommerceOperationsConflict('Reload every stock pool for this replacement.');
 await checkExchangeCharge(env,c.id,adapters);
 const stock=v.stock.map(t=>{const target=c.target.stockTargets.find(s=>s.type===t.targetType&&s.id===t.targetId);if(!target)throw new CommerceOperationsConflict('The replacement stock mapping changed.');const required=target.units*v.quantity;if(!Number.isSafeInteger(required)||required>1000000)throw new CommerceOperationsConflict('This stock deduction is too large.');return {...t,units:required,expectedUpdatedSeconds:Date.parse(t.expectedUpdatedAt)/1000};}).map(({expectedUpdatedAt,...t})=>t);
 const result=await write(()=>db.insert(recoveryShipments).values({id:shipmentId,caseId:c.id,expectedVersion:v.expectedVersion,quantity:v.quantity,stock,carrier:v.carrier||null,trackingNumber:v.trackingNumber||null,actor,reason:v.reason,fingerprint,createdAt:new Date()}),replay);return result??{shipmentId};
}
export async function listRecoveryCases(env:TalismanEnv,input:unknown={}){
 const v=z.object({filter:z.enum(['open','resolved','all']).default('open'),kind:z.enum(['all',...RECOVERY_KINDS]).default('all'),nextAction:z.enum(['all',...RECOVERY_NEXT_ACTIONS]).default('all'),offset:z.coerce.number().int().min(0).max(1000000).default(0),orderId:z.string().trim().max(128).default('')}).strict().parse(input),db=commerceDb(env);
 const where=sql`(${v.filter}='all' OR (${v.filter}='open' AND (status='open' OR awaitingInspection=1 OR awaitingPaymentReview=1)) OR (${v.filter}='resolved' AND status='resolved' AND awaitingInspection=0 AND awaitingPaymentReview=0)) AND (${v.kind}='all' OR kind=${v.kind}) AND (${v.orderId}='' OR orderId=${v.orderId}) AND (${v.nextAction}='all' OR nextAction=${v.nextAction})`;
 const [rows,count]=await db.batch([db.all<RecoveryProgressRow>(sql`${recoveryProgressQuery} SELECT id,orderId,receiptId,lineIndex,kind,quantity,shipped,awaitingInspection,awaitingPaymentReview,name,status,createdAt,nextAction FROM cases WHERE ${where} ORDER BY createdAt,id LIMIT 50 OFFSET ${v.offset}`),db.all<{n:number}>(sql`${recoveryProgressQuery} SELECT count(*) n FROM cases WHERE ${where}`)]);
 return {...v,total:count[0]?.n??0,rows:rows.map(r=>({...r,nextActionLabel:recoveryActionLabels[r.nextAction],createdAt:new Date(r.createdAt*1000).toISOString()}))};
}
export async function readRecoveryCase(env:TalismanEnv,input:unknown){
 const {caseId}=z.object({caseId:id}).strict().parse(input),db=commerceDb(env);
 const c=await db.query.recoveryCases.findFirst({where:{id:caseId},with:{payments:{orderBy:(_t,{sql})=>sql`rowid DESC`,limit:1,with:{events:{orderBy:(_t,{sql})=>sql`rowid`}}},events:{orderBy:(_t,{sql})=>sql`rowid DESC`,limit:200},shipments:{orderBy:(_t,{sql})=>sql`rowid DESC`,limit:100,with:{receipts:{with:{inspections:true}}}},order:{columns:{status:true,currency:true,shippingAddress:true}}}});if(!c)throw new CommerceOperationsConflict('Recovery case unavailable.');
 const refund=c.receiptId?await db.query.returnRefundDecisions.findFirst({where:{receiptId:c.receiptId},columns:{status:true,amountMinor:true},orderBy:(_t,{sql})=>sql`rowid DESC`}):null;
 const payment=c.payments[0],held=!!payment&&(payment.events.some(e=>['refunded','lost'].includes(e.kind))||payment.events.filter(e=>['disputed','won'].includes(e.kind)).at(-1)?.kind==='disputed');
 const adjustmentMinor=c.kind==='exchange'?c.target.adjustmentMinor??0:0;
 const adjustment={amountMinor:adjustmentMinor,status:adjustmentMinor>0?(payment&&!held?'paid':'payment_needed'):adjustmentMinor<0?(refund?.status==='settled'&&refund.amountMinor===-adjustmentMinor?'refunded':'refund_needed'):'not_needed',paymentId:payment?.paymentId??null};
 const priceReview=await db.get<{n:number}>(sql`SELECT COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=${caseId} AND actor='payment_provider'),0)>COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=${caseId} AND kind='resolve'),0) n`);
 const shipped=await db.get<{n:number}>(sql`SELECT COALESCE(sum(quantity),0) n FROM _ecommerce_recovery_shipments WHERE case_id=${caseId}`),latest=c.events[0];
 const stock=await Promise.all(c.target.stockTargets.map(async t=>{const row=await db.get<{name:string;sku:string|null;quantity:number;updated:number}>(sql`WITH physical AS (${physicalStockLocations}) SELECT name,sku,quantity,updated FROM physical WHERE type=${t.type} AND id=${t.id}`);return {...t,name:row?.name??'Unavailable stock pool',sku:row?.sku??null,quantity:row?.quantity??null,updatedAt:row?new Date(row.updated*1000).toISOString():null};}));
 const names=await adminActorNames(env,[c.actor,...c.events.map(e=>e.actor)]);
 // Tracking corrections can be older than the displayed history; resolve them independently.
 const corrections=await db.query.recoveryEvents.findMany({where:{caseId,kind:'tracking'},columns:{id:true,shipmentId:true,carrier:true,trackingNumber:true},orderBy:(_t,{sql})=>sql`rowid`});
 return {adjustment,awaitingPaymentReview:!!priceReview?.n,id:c.id,orderId:c.orderId,kind:c.kind,lineIndex:c.lineIndex,quantity:c.quantity,target:{name:c.target.name,sku:c.target.sku,productId:c.target.productId,variantId:c.target.variantId},sourceId:c.fulfillmentId??c.sourceShipmentId??c.receiptId,version:latest?.id??c.id,status:latest?.status??'open',remaining:Math.max(0,c.quantity-(shipped?.n??0)),shipped:shipped?.n??0,reason:c.reason,actorName:names.get(c.actor)??c.actor,createdAt:c.createdAt.toISOString(),redacted:!!c.redactedAt,paymentStatus:c.order.status,currency:c.order.currency,shippingAddress:c.order.shippingAddress,stock,
  historyTruncated:c.events.length===200,shipmentsTruncated:c.shipments.length===100,history:[...c.events].reverse().map(e=>({id:e.id,kind:e.kind,status:e.status,reason:e.reason,actorName:e.actor==='payment_provider'?'Payment provider':names.get(e.actor)??e.actor,createdAt:e.createdAt.toISOString()})),shipments:[...c.shipments].reverse().map(s=>{const correction=corrections.filter(e=>e.shipmentId===s.id).at(-1);return {id:s.id,quantity:s.quantity,returned:s.receipts.reduce((n,r)=>n+r.quantity,0),receipts:s.receipts.map(r=>({id:r.id,quantity:r.quantity,remaining:r.quantity-r.inspections.reduce((n,i)=>n+i.quantity,0),createdAt:r.createdAt.toISOString(),inspections:r.inspections.map(i=>({id:i.id,quantity:i.quantity,disposition:i.disposition,restock:i.restock,createdAt:i.createdAt.toISOString()}))})),carrier:correction?correction.carrier:s.carrier,trackingNumber:correction?correction.trackingNumber:s.trackingNumber,createdAt:s.createdAt.toISOString()};})};
}
export async function readRecoveryOrder(env:TalismanEnv,input:unknown){
 const v=z.object({orderId:id}).strict().parse(input),db=commerceDb(env),warehouse=await readOrderWarehouse(env,v);
 const cases=await db.query.recoveryCases.findMany({where:{orderId:v.orderId},columns:{id:true,lineIndex:true,quantity:true,receiptId:true,fulfillmentId:true,sourceShipmentId:true,kind:true,target:true},with:{shipments:{columns:{id:true,quantity:true,createdAt:true}}}});
 const o=await db.query.orders.findFirst({where:{id:v.orderId},columns:{items:true,currency:true}});
 return {...warehouse,currency:o!.currency,lines:warehouse.lines.map(l=>({...l,priceAtPurchase:o!.items[l.lineIndex].priceAtPurchase})),canCreate:['paid','partially_refunded'].includes(warehouse.status),replacements:cases.flatMap(c=>c.shipments.map(s=>({id:s.id,lineIndex:c.lineIndex,quantity:s.quantity,name:c.target.name,createdAt:s.createdAt.toISOString()}))),
  cases:cases.map(({target,shipments,...c})=>c)};
}
/** Server-filtered equal-price catalog choices. No choice changes a purchase or promises stock. */
export async function listExchangeChoices(env:TalismanEnv,input:unknown){
 const v=z.object({orderId:id,lineIndex:line,search:z.string().trim().max(100).default(''),allowPriceDifference:z.boolean().default(false),offset:z.coerce.number().int().min(0).max(1000000).default(0)}).strict().parse(input),db=commerceDb(env);
 const o=await db.query.orders.findFirst({where:{id:v.orderId},columns:{items:true,currency:true,status:true,paymentProvider:true}}),item=o?.items[v.lineIndex];if(!item||o?.paymentProvider==='admin_test'||!['paid','partially_refunded'].includes(o?.status??'')||o.currency!==readStoreCurrency(env))throw new CommerceOperationsConflict('Equal-price choices are unavailable for this order.');
 const cte=sql`WITH choices AS (
 SELECT p.id AS productId,NULL AS variantId,p.name,p.sku,p.base_price AS price FROM _ecommerce_products p WHERE p.status='active' AND p.is_physical=1 AND p.type='standard' AND NOT EXISTS(SELECT 1 FROM _ecommerce_product_variants g WHERE g.product_id=p.id)
 UNION ALL SELECT p.id,g.id,p.name||' / '||g.name,COALESCE(g.sku,p.sku),COALESCE(g.price_override,p.base_price) FROM _ecommerce_product_variants g JOIN _ecommerce_products p ON p.id=g.product_id WHERE p.status='active' AND p.is_physical=1 AND p.type='standard' AND NOT EXISTS(SELECT 1 FROM _ecommerce_product_variant_values v WHERE v.product_variant_id=g.id)
 UNION ALL SELECT p.id,v.id,p.name||' / '||g.name||': '||v.value,COALESCE(v.sku,g.sku,p.sku),COALESCE(v.price_override,g.price_override,p.base_price) FROM _ecommerce_product_variant_values v JOIN _ecommerce_product_variants g ON g.id=v.product_variant_id JOIN _ecommerce_products p ON p.id=g.product_id WHERE p.status='active' AND p.is_physical=1 AND p.type='standard')`;
 const pattern=`%${v.search.replace(/[\\%_]/g,c=>`\\${c}`)}%`,where=sql`price>0 AND (${v.allowPriceDifference?1:0}=1 OR price=${item.priceAtPurchase}) AND name LIKE ${pattern} ESCAPE '\\'`;
 const [rows,count]=await db.batch([db.all<{productId:string;variantId:string|null;name:string;sku:string|null;price:number}>(sql`${cte} SELECT * FROM choices WHERE ${where} ORDER BY name,productId,variantId LIMIT 50 OFFSET ${v.offset}`),db.all<{n:number}>(sql`${cte} SELECT count(*) n FROM choices WHERE ${where}`)]);return {...v,currency:o.currency,price:item.priceAtPurchase,total:count[0]?.n??0,rows};
}

/** A request's immutable receipt links provide exchange provenance, including older recorded cases. */
export async function readExchangeHandoff(env:TalismanEnv,input:unknown){
 const {requestId}=z.object({requestId:id}).strict().parse(input),db=commerceDb(env);
 const r=await db.query.returnRequests.findFirst({where:{id:requestId},with:{exchangePreference:true,events:{orderBy:(_t,{sql})=>sql`rowid DESC`,limit:1},order:{columns:{items:true,currency:true,status:true,paymentProvider:true,shippingAddress:true}},receipts:{with:{receipt:{with:{inspections:true,refundDecisions:{columns:{status:true},orderBy:(_t,{sql})=>sql`rowid DESC`,limit:1},recoveryCases:{columns:{id:true,lineIndex:true,quantity:true}}}}}}}});
 if(!r||r.redactedAt||!r.exchangePreference||r.order.paymentProvider==='admin_test')throw new CommerceOperationsConflict('This exchange request is unavailable.');
 const preference=r.exchangePreference, lineIndex=preference.lineIndex, status=r.events[0]?.status??'pending';
 let choice:{productId:string;variantId:string|null;name:string;sku:string|null;price:number}|null=null;
 if(r.order.currency===readStoreCurrency(env)){
  const catalog=await loadBasketCatalog(commerceContext({env}),[preference.target]),p=catalog.products.get(preference.target.productId);
  if(p?.status==='active'&&p.type==='standard'&&p.isPhysical){
   let variant:ReturnType<typeof resolveSelectedVariant>|null=null,valid=true;
   try{requireVariantChoice(catalog,p,preference.target.variantId??undefined);variant=preference.target.variantId?resolveSelectedVariant(catalog,p,preference.target.variantId):null;}catch{valid=false;}
   const price=variant?.price??p.basePrice;
   if(valid&&Number.isSafeInteger(price)&&price>0&&price<=1000000000){const d=(await describeOrderItems(env,[preference.target]))[0];choice={productId:p.id,variantId:preference.target.variantId,name:variant?.name??p.name,sku:d.sku,price};}
  }
 }
 const claimed=await db.get<{n:number}>(sql`SELECT COALESCE(sum(quantity),0) n FROM _ecommerce_recovery_cases WHERE order_id=${r.orderId} AND line_index=${lineIndex} AND source_shipment_id IS NULL`);
 const remaining=Math.max(0,(r.order.items[lineIndex]?.quantity??0)-(claimed?.n??0));
 return {requestId,orderId:r.orderId,lineIndex,status,preference:preference.target,choice,currency:r.order.currency,
  canArrange:['approved','closed'].includes(status)&&['paid','partially_refunded'].includes(r.order.status)&&!!r.order.shippingAddress,
  blockedReason:!['approved','closed'].includes(status)?'Approve the request and receive its goods before arranging an exchange.':!r.order.shippingAddress?'The order needs a shipping address before an exchange can be recorded.':!['paid','partially_refunded'].includes(r.order.status)?'Review the order payment before arranging an exchange.':null,
  receipts:r.receipts.map(l=>{const item=l.receipt.items.find(i=>i.lineIndex===lineIndex),received=item?.quantity??0,inspected=item?.condition==='inspection'?l.receipt.inspections.reduce((n,d)=>n+(d.items.find(i=>i.lineIndex===lineIndex)?.quantity??0),0):received;
   const cases=l.receipt.recoveryCases.filter(c=>c.lineIndex===lineIndex),used=cases.reduce((n,c)=>n+c.quantity,0);
   return {receiptId:l.receiptId,received,refundStatus:l.receipt.refundDecisions[0]?.status??'review',awaitingInspection:Math.max(0,received-inspected),available:Math.min(remaining,Math.max(0,inspected-used)),caseIds:cases.map(c=>c.id)};
  })};
}
