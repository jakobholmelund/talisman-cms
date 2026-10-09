import { readOrderTracking } from './order-tracking';
import { recoveryProgressQuery, type RecoveryProgressRow, type RecoveryNextAction } from './recovery-progress';
import { listExchangeChoices } from './recoveries';
import { loadBasketCatalog, requireVariantChoice, resolveSelectedVariant } from './basket';
import { readStoreCurrency } from './store-settings';
import type { ReturnExchangePreference } from './schema';
import { commerceEmailStatement } from './email-deliveries';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import type { CommerceContext } from './commerce-context';
import { commerceDb, errorText } from './db';
import { findOrderForSession } from './orders';
import { describeOrderItems } from './order-items';
import { hashOrderAccess } from './cookies';
import { adminActorNames } from './admin-actors';
import { CommerceOperationsConflict } from './email-recovery';
import { returnRequests, returnRequestEvents, returnRequestReasons, returnExchangePreferences, RETURN_REASON_CODES, REFUND_SOURCE_KINDS, RETURN_REQUEST_STATUSES } from './schema';
import type { CustomerReturns, ReturnRequestReceipt, ReturnDecisionReceipt, AdminReturnRequest, ReturnsQueue, CustomerExchangeProgress } from './return-request-types';
export type { CustomerReturns } from './return-request-types';

const id = z.string().trim().min(1).max(128), key = id.min(8);
const items = z.array(z.object({ lineIndex:z.number().int().min(0).max(199), quantity:z.number().int().min(1).max(1000000) }).strict()).min(1).max(50)
  .refine(rows => new Set(rows.map(r=>r.lineIndex)).size === rows.length, 'Choose each line once');
const createSchema = z.object({ orderId:id, requestKey:key, reason:z.string().trim().min(8).max(1000), reasonCode:z.enum(RETURN_REASON_CODES).default('unspecified'), items, exchange:z.object({productId:id,variantId:id.nullable().default(null)}).strict().optional() }).strict().refine(v=>!v.exchange||v.items.length===1,'Request one original item per exchange');
const decisionSchema = z.object({ requestId:id, requestKey:key, expectedVersion:id, status:z.enum(['approved','declined','closed']),
  reason:z.string().trim().min(8).max(500), customerMessage:z.string().trim().min(8).max(1000) }).strict();
const cancelSchema = z.object({ orderId:id, requestId:id, requestKey:key, expectedVersion:id }).strict();
export type ReturnOwner = { sessionToken?:string; customerId?:string; orderAccessToken?:string };
const fingerprint = (input:unknown,actor:string) => hashOrderAccess(JSON.stringify({input,actor}));
const statusOf = (events:Array<{status:typeof RETURN_REQUEST_STATUSES[number]}>) => events.at(-1)?.status ?? 'pending';
async function owned(ctx:CommerceContext,orderId:string,owner:ReturnOwner) {
  const order=await findOrderForSession(ctx,orderId,owner.sessionToken,owner.customerId,owner.orderAccessToken);
  if(!order || order.paymentProvider==='admin_test') return null;
  return order;
}
async function requestsForOrder(env:TalismanEnv,orderId:string) {
  return commerceDb(env).query.returnRequests.findMany({where:{orderId},orderBy:{createdAt:'asc'},with:{
    exchangePreference:true, reasonCategory:true, events:{orderBy:(_t,{sql})=>sql`rowid`},receipts:{with:{receipt:{columns:{items:true,createdAt:true},with:{inspections:true}}}}
  }});
}
/** Caller supplies verified credentials, exactly as for private order tracking. */
export async function readCustomerReturns(ctx:CommerceContext,orderId:string,owner:ReturnOwner={}):Promise<CustomerReturns|null> {
  if(!await owned(ctx,orderId,owner)) return null;
  const order=await ctx.db.query.orders.findFirst({where:{id:orderId},with:{parcelContents:true,fulfillments:{columns:{id:true,kind:true}},returnReceipts:{with:{refundDecisions:{orderBy:(_t,{sql})=>sql`rowid DESC`,limit:1}}}}});
  if(!order)return null;
  const progress=await ctx.db.all<Pick<RecoveryProgressRow,'id'|'receiptId'|'lineIndex'|'nextAction'>>(sql`${recoveryProgressQuery} SELECT id,receiptId,lineIndex,nextAction FROM cases WHERE orderId=${orderId} AND kind='exchange'`);
  const tracking=progress.length?await readOrderTracking(ctx,orderId,owner.sessionToken,owner.customerId,owner.orderAccessToken):null;
  const requests=await requestsForOrder(ctx.env,orderId), described=await describeOrderItems(ctx.env,order.items);
  const unknown=order.fulfillments.some(f=>f.kind==='shipment'&&!order.parcelContents.some(p=>p.fulfillmentId===f.id));
  const confirmed=['paid','partially_refunded','refunded','disputed'].includes(order.status);
  const receiptQuantity=(r:typeof requests[number],lineIndex:number)=>r.receipts.reduce((n,l)=>n+(l.receipt.items.find(i=>i.lineIndex===lineIndex)?.quantity??0),0);
  const lines=described.map((l,lineIndex)=>{
    const shipped=order.parcelContents.reduce((n,p)=>n+(p.items.find(i=>i.lineIndex===lineIndex)?.quantity??0),0);
    const received=order.returnReceipts.reduce((n,r)=>n+(r.items.find(i=>i.lineIndex===lineIndex)?.quantity??0),0);
    const held=requests.filter(r=>['pending','approved'].includes(statusOf(r.events))).reduce((n,r)=>n+Math.max(0,(r.items.find(i=>i.lineIndex===lineIndex)?.quantity??0)-receiptQuantity(r,lineIndex)),0);
    return {lineIndex,name:[l.productName||'Ordered item',l.variantLabel].filter(Boolean).join(' / '),sku:l.sku,available:confirmed&&!unknown?Math.max(0,shipped-received-held):0};
  });
  return {orderId,unknownParcelContents:unknown,lines,refunds:order.returnReceipts.map(r=>{
    const d=r.refundDecisions[0],sums=new Map<typeof REFUND_SOURCE_KINDS[number],number>();
    if(d?.status==='settled')for(const a of d.allocations)sums.set(a.kind,(sums.get(a.kind)??0)+a.amountMinor);
    return {receiptId:r.id,receivedAt:r.createdAt.toISOString(),status:d?.status??'review',amountMinor:d?.amountMinor??0,currency:order.currency,updatedAt:(d?.createdAt??r.createdAt).toISOString(),tenders:[...sums].map(([kind,amountMinor])=>({kind,amountMinor}))};
  }),requests:requests.map(r=>({
    exchangeProgress:(()=>{
      const linked=progress.filter(c=>r.receipts.some(l=>l.receiptId===c.receiptId)), cases=linked.flatMap(c=>{const t=tracking?.recoveries.find(t=>t.id===c.id);return t?[{id:t.id,name:t.name,quantity:t.quantity,shipped:t.shipments.reduce((n,s)=>n+s.quantity,0),...customerRecoveryAction(c.nextAction),parcels:t.shipments.map(s=>({quantity:s.quantity,returned:s.returned,awaitingInspection:s.awaitingInspection,carrier:s.carrier,trackingNumber:s.trackingNumber,createdAt:s.shippedAt}))}]:[];});
      if(!r.exchangePreference&&!cases.length)return null;
      const lineIndices=new Set(r.exchangePreference?[r.exchangePreference.lineIndex]:linked.map(c=>c.lineIndex));
      const requested=r.items.reduce((n,i)=>n+(lineIndices.has(i.lineIndex)?i.quantity:0),0),received=[...lineIndices].reduce((n,i)=>n+receiptQuantity(r,i),0);
      const inspected=r.receipts.reduce((n,l)=>n+l.receipt.items.filter(i=>lineIndices.has(i.lineIndex)).reduce((n,i)=>n+(i.condition==='inspection'?l.receipt.inspections.reduce((n,d)=>n+(d.items.find(j=>j.lineIndex===i.lineIndex)?.quantity??0),0):i.quantity),0),0);
      const stages:CustomerExchangeProgress['stages']=[],status=statusOf(r.events);
      if(status==='pending')stages.push({label:'Awaiting exchange review',quantity:requested,nextAction:'Wait for the store’s approval and return instructions.'});
      if(['declined','cancelled'].includes(status))stages.push({label:status==='declined'?'Exchange request declined':'Exchange request cancelled',quantity:requested,nextAction:'Contact the store if you need help with this decision.'});
      if(status==='approved'&&requested>received)stages.push({label:'Waiting for your returned goods',quantity:requested-received,nextAction:'Follow the store’s return instructions below.'});
      if(received>inspected)stages.push({label:'Returned goods awaiting inspection',quantity:received-inspected,nextAction:'The store will inspect these goods. No action is needed from you.'});
      const arranged=cases.reduce((n,c)=>n+c.quantity,0);
      if(inspected>arranged)stages.push({label:'Exchange being arranged',quantity:inspected-arranged,nextAction:'The store will confirm replacement goods and any price adjustment with you.'});
      const add=(label:string,quantity:number,nextAction:string)=>{if(!quantity)return;const found=stages.find(s=>s.label===label);if(found)found.quantity+=quantity;else stages.push({label,quantity,nextAction});};
      for(const c of cases){const stage=linked.find(l=>l.id===c.id)!.nextAction;
        const quantity=stage==='inspection'?c.parcels.reduce((n,p)=>n+p.awaitingInspection,0):stage==='complete'||stage==='review'?c.quantity:stage==='follow_up'?c.shipped:Math.max(0,c.quantity-c.shipped);
        add(c.label,quantity,c.nextAction);
        if(c.shipped&&stage!=='follow_up'&&stage!=='complete')add('Replacement dispatched',c.shipped,'Use the parcel details below. Contact the store if there is a delivery problem.');
      }
      if(!stages.length)stages.push({label:'Request closed',quantity:received,nextAction:'Contact the store if you need further help.'});
      return {stages,cases};
    })(),
    exchangePreference:r.exchangePreference?{lineIndex:r.exchangePreference.lineIndex,...r.exchangePreference.target}:null,
    id:r.id,reasonCode:r.reasonCategory?.code??'unspecified',status:statusOf(r.events),version:r.events.at(-1)?.id??r.id,reason:r.reason,createdAt:r.createdAt.toISOString(),
    items:r.items.map(i=>({...i,name:lines[i.lineIndex]?.name??'Ordered item',received:receiptQuantity(r,i.lineIndex)})),
    canCancel:['pending','approved'].includes(statusOf(r.events))&&!r.receipts.length,
    updates:r.events.map(e=>({status:e.status,message:e.customerMessage,createdAt:e.createdAt.toISOString()})),
  }))};
}
export async function createCustomerReturn(ctx:CommerceContext,input:unknown,owner:ReturnOwner={}):Promise<ReturnRequestReceipt|null> {
  const v=createSchema.parse(input);const order=await owned(ctx,v.orderId,owner);if(!order)return null;
  const values={...v,items:[...v.items].sort((a,b)=>a.lineIndex-b.lineIndex)};
  const requestId=`rma_${await hashOrderAccess(`${v.orderId}:${v.requestKey}`)}`,hash=await fingerprint(values,'customer');
  const replay=async()=>{const r=await ctx.db.select().from(returnRequests).where(eq(returnRequests.id,requestId)).get();if(!r)return null;if(r.fingerprint!==hash)throw new CommerceOperationsConflict('This return request key was used with different details.');return {requestId,duplicate:true};};
  const previous=await replay();if(previous)return previous;
  let preference:ReturnExchangePreference|undefined;
  if(v.exchange){
   if(!['paid','partially_refunded'].includes(order.status)||order.currency!==readStoreCurrency(ctx.env))throw new CommerceOperationsConflict('Exchange requests require a confirmed purchase in the current store currency.');
   const catalog=await loadBasketCatalog(ctx,[v.exchange]),product=catalog.products.get(v.exchange.productId);
   if(!product||product.status!=='active'||product.type!=='standard'||!product.isPhysical)throw new CommerceOperationsConflict('Choose an active physical replacement item.');
   requireVariantChoice(catalog,product,v.exchange.variantId??undefined);const selected=v.exchange.variantId?resolveSelectedVariant(catalog,product,v.exchange.variantId):null,description=(await describeOrderItems(ctx.env,[v.exchange]))[0];
   preference={productId:product.id,variantId:v.exchange.variantId,name:selected?.name??product.name,sku:description.sku,priceMinor:selected?.price??product.basePrice,currency:order.currency};
   if(!Number.isSafeInteger(preference.priceMinor)||preference.priceMinor<1||preference.priceMinor>1000000000)throw new CommerceOperationsConflict('Choose a replacement with a valid current price.');
  }
  const now=new Date();
  try{await ctx.db.batch([ctx.db.insert(returnRequests).values({id:requestId,orderId:v.orderId,items:values.items,reason:v.reason,fingerprint:hash,createdAt:now}),ctx.db.insert(returnRequestReasons).values({requestId,code:v.reasonCode}),...(preference?[ctx.db.insert(returnExchangePreferences).values({requestId,lineIndex:v.items[0].lineIndex,target:preference})]:[])]);}
  catch(error){const previous=await replay();if(previous)return previous;if(!/Return request exceeds available shipped goods|Exchange preference changed/.test(errorText(error)))throw error;throw new CommerceOperationsConflict('Return quantities changed or parcel details are unavailable. Refresh before requesting a return.');}
  return {requestId};
}
async function appendDecision(env:TalismanEnv,v:z.output<typeof decisionSchema>|(z.output<typeof cancelSchema>&{status:'cancelled';reason:string;customerMessage:string}),actor:string,actorKind:'staff'|'customer'):Promise<ReturnDecisionReceipt> {
  const db=commerceDb(env),eventId=`rme_${await hashOrderAccess(`${v.requestId}:${v.requestKey}`)}`,hash=await fingerprint(v,`${actorKind}:${actor}`);
  const replay=async()=>{const e=await db.select().from(returnRequestEvents).where(eq(returnRequestEvents.id,eventId)).get();if(!e)return null;if(e.fingerprint!==hash)throw new CommerceOperationsConflict('This decision key was used with different details.');return {eventId,requestId:e.requestId,duplicate:true};};
  const previous=await replay();if(previous)return previous;
  try{await db.batch([db.insert(returnRequestEvents).values({id:eventId,requestId:v.requestId,status:v.status,expectedVersion:v.expectedVersion,actor,actorKind,reason:v.reason,customerMessage:v.customerMessage,fingerprint:hash,createdAt:new Date()}), ...(actorKind==='staff' ? [db.run(commerceEmailStatement('return_decision',eventId,Math.floor(Date.now()/1000)))] : [])]);}
  catch(error){const previous=await replay();if(previous)return previous;if(!/Return request decision is stale or unavailable|Requested goods were already received/.test(errorText(error)))throw error;throw new CommerceOperationsConflict('This return request changed or cannot take that decision. Refresh before continuing.');}
  return {eventId,requestId:v.requestId};
}
export async function decideReturnRequest(env:TalismanEnv,input:unknown,actor:string) {
  if(!actor.trim())throw new CommerceOperationsConflict('An authenticated staff member is required.');
  return appendDecision(env,decisionSchema.parse(input),actor,'staff');
}
export async function cancelCustomerReturn(ctx:CommerceContext,input:unknown,owner:ReturnOwner={}) {
  const v=cancelSchema.parse(input);if(!await owned(ctx,v.orderId,owner))return null;
  const request=await ctx.db.select({orderId:returnRequests.orderId}).from(returnRequests).where(eq(returnRequests.id,v.requestId)).get();if(request?.orderId!==v.orderId)return null;
  return appendDecision(ctx.env,{...v,status:'cancelled',reason:'Customer cancelled the return request',customerMessage:'You cancelled this return request.'},'customer','customer');
}
export async function readReturnRequestAdmin(env:TalismanEnv,input:unknown):Promise<AdminReturnRequest> {
  const v=z.object({requestId:id}).strict().parse(input),db=commerceDb(env);
  const request=await db.query.returnRequests.findFirst({where:{id:v.requestId},with:{exchangePreference:true,order:{columns:{id:true,items:true,status:true}},events:{orderBy:(_t,{sql})=>sql`rowid`},receipts:{with:{receipt:{with:{inspections:true}}}}}});
  if(!request)throw new CommerceOperationsConflict('Return request not found.');
  const names=await adminActorNames(env,request.events.filter(e=>e.actorKind==='staff').map(e=>e.actor));
  const described=await describeOrderItems(env,request.order.items);
  return {exchangePreference:request.exchangePreference?{lineIndex:request.exchangePreference.lineIndex,...request.exchangePreference.target}:null,id:request.id,orderId:request.orderId,reason:request.reason,status:statusOf(request.events),version:request.events.at(-1)?.id??request.id,createdAt:request.createdAt.toISOString(),
    items:request.items.map(i=>({...i,name:[described[i.lineIndex]?.productName||'Ordered item',described[i.lineIndex]?.variantLabel].filter(Boolean).join(' / '),
      restockMapped:!!request.order.items[i.lineIndex]?.stockTargets?.length,
      received:request.receipts.reduce((n,l)=>n+(l.receipt.items.find(j=>j.lineIndex===i.lineIndex)?.quantity??0),0)})),
    events:request.events.map(e=>({id:e.id,status:e.status,reason:e.reason,actorKind:e.actorKind,actor:e.actor,customerMessage:e.customerMessage,actorName:e.actorKind==='customer'?'Customer':names.get(e.actor)??e.actor,createdAt:e.createdAt.toISOString()})),
    receipts:request.receipts.map(l=>({receiptId:l.receiptId,createdAt:l.receipt.createdAt.toISOString()}))};
}
/** Flat, bounded queue; a pending inspection appears even when intake had no customer request. */
export async function listReturnsQueue(env:TalismanEnv,input:unknown={}):Promise<ReturnsQueue> {
  const v=z.object({filter:z.enum(['active','pending','approved','inspection','waiting_goods','arrange_exchange','all']).default('active'),orderId:z.string().trim().max(128).default(''),offset:z.coerce.number().int().min(0).max(1000000).default(0)}).strict().parse(input);
  const queue=sql`WITH requests AS (
    SELECT 'request' AS kind,r.id,r.order_id AS orderId,COALESCE((SELECT status FROM _ecommerce_return_request_events e WHERE e.request_id=r.id ORDER BY rowid DESC LIMIT 1),'pending') AS status,r.created_at AS createdAt,r.reason,
    MAX(0,(SELECT sum(json_extract(value,'$.quantity')) FROM json_each(r.items))-COALESCE((SELECT sum(json_extract(i.value,'$.quantity')) FROM _ecommerce_return_request_receipts l JOIN _ecommerce_return_receipts x ON x.id=l.receipt_id,json_each(x.items) i WHERE l.request_id=r.id),0)) AS pendingUnits
    ,EXISTS(SELECT 1 FROM _ecommerce_return_exchange_preferences p JOIN _ecommerce_return_request_receipts l ON l.request_id=p.request_id JOIN _ecommerce_return_receipts x ON x.id=l.receipt_id,json_each(x.items) i
      WHERE p.request_id=r.id AND json_extract(i.value,'$.lineIndex')=p.line_index AND
      (CASE WHEN json_extract(i.value,'$.condition')='inspection' THEN COALESCE((SELECT sum(json_extract(j.value,'$.quantity')) FROM _ecommerce_return_inspections d,json_each(d.items) j WHERE d.receipt_id=x.id AND json_extract(j.value,'$.lineIndex')=p.line_index),0) ELSE json_extract(i.value,'$.quantity') END)>
      COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_cases c WHERE c.receipt_id=x.id AND c.line_index=p.line_index),0)) AS arrangeExchange
    FROM _ecommerce_return_requests r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
  ), inspections AS (
    SELECT 'inspection' AS kind,r.id,r.order_id AS orderId,'inspection' AS status,r.created_at AS createdAt,r.reason,
    (SELECT COALESCE(sum(json_extract(value,'$.quantity')),0) FROM json_each(r.items) WHERE json_extract(value,'$.condition')='inspection')-
    COALESCE((SELECT sum(json_extract(i.value,'$.quantity')) FROM _ecommerce_return_inspections d,json_each(d.items) i WHERE d.receipt_id=r.id),0) AS pendingUnits
    ,0 AS arrangeExchange
    FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
  ), queue AS (SELECT * FROM requests UNION ALL SELECT * FROM inspections WHERE pendingUnits>0)`;
  const filter=v.filter==='waiting_goods'?sql`kind='request' AND status='approved' AND pendingUnits>0`:v.filter==='arrange_exchange'?sql`kind='request' AND status IN ('approved','closed') AND arrangeExchange=1`:v.filter==='all'?sql`1=1`:v.filter==='active'?sql`(status='pending' OR status='approved' OR kind='inspection')`:sql`status=${v.filter}`;
  const where=sql`${filter} AND (${v.orderId}='' OR orderId=${v.orderId})`,db=commerceDb(env);
  const [rows,total]=await db.batch([db.all<{kind:'request'|'inspection';id:string;orderId:string;status:string;createdAt:number;reason:string;pendingUnits:number}>(sql`${queue} SELECT * FROM queue WHERE ${where} ORDER BY createdAt,id LIMIT 50 OFFSET ${v.offset}`),db.all<{n:number}>(sql`${queue} SELECT count(*) n FROM queue WHERE ${where}`)]);
  return {...v,total:total[0]?.n??0,rows:rows.map(r=>({...r,createdAt:new Date(r.createdAt*1000).toISOString()}))};
}

/** Catalog preferences stay private to the verified order owner and never promise stock. */
export async function readCustomerExchangeChoices(ctx:CommerceContext,input:unknown,owner:ReturnOwner={}){
 const v=z.object({orderId:id,lineIndex:z.number().int().min(0).max(199),search:z.string().trim().max(100).default(''),offset:z.number().int().min(0).max(1000000).default(0)}).strict().parse(input);
 const returns=await readCustomerReturns(ctx,v.orderId,owner);if(!returns)return null;
 if(!returns.lines.some(l=>l.lineIndex===v.lineIndex&&l.available>0))throw new CommerceOperationsConflict('No received quantities are available for this exchange request.');
 const choices=await listExchangeChoices(ctx.env,{...v,allowPriceDifference:true});
 return {rows:choices.rows,total:choices.total,offset:choices.offset,currency:choices.currency,originalUnitPrice:choices.price};
}

function customerRecoveryAction(stage:RecoveryNextAction):{label:string;nextAction:string}{
 const labels:Record<RecoveryNextAction,string>={inspection:'Returned replacement awaiting inspection',review:'Exchange needs store review',refund:'Exchange refund being reviewed',payment:'Upgrade payment to confirm',stock:'Waiting for replacement stock',dispatch:'Replacement ready to pack',follow_up:'Replacement dispatched — follow-up open',complete:'Exchange case resolved'};
 const actions:Partial<Record<RecoveryNextAction,string>>={payment:'Contact the store to agree and confirm the price difference. This page does not collect payment.',follow_up:'Use the parcel details below. Contact the store if there is a delivery problem.',complete:'The store recorded the agreed outcome. This does not confirm delivery.'};
 return {label:labels[stage],nextAction:actions[stage]??'The store is handling this stage. No action is needed from you unless they contact you.'};
}
