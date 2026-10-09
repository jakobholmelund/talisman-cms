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
import { returnRequests, returnRequestEvents, returnRequestReasons, RETURN_REASON_CODES, REFUND_SOURCE_KINDS, RETURN_REQUEST_STATUSES } from './schema';
import type { CustomerReturns, ReturnRequestReceipt, ReturnDecisionReceipt, AdminReturnRequest, ReturnsQueue } from './return-request-types';
export type { CustomerReturns } from './return-request-types';

const id = z.string().trim().min(1).max(128), key = id.min(8);
const items = z.array(z.object({ lineIndex:z.number().int().min(0).max(199), quantity:z.number().int().min(1).max(1000000) }).strict()).min(1).max(50)
  .refine(rows => new Set(rows.map(r=>r.lineIndex)).size === rows.length, 'Choose each line once');
const createSchema = z.object({ orderId:id, requestKey:key, reason:z.string().trim().min(8).max(1000), reasonCode:z.enum(RETURN_REASON_CODES).default('unspecified'), items }).strict();
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
    reasonCategory:true, events:{orderBy:(_t,{sql})=>sql`rowid`},receipts:{with:{receipt:{columns:{items:true,createdAt:true}}}}
  }});
}
/** Caller supplies verified credentials, exactly as for private order tracking. */
export async function readCustomerReturns(ctx:CommerceContext,orderId:string,owner:ReturnOwner={}):Promise<CustomerReturns|null> {
  if(!await owned(ctx,orderId,owner)) return null;
  const order=await ctx.db.query.orders.findFirst({where:{id:orderId},with:{parcelContents:true,fulfillments:{columns:{id:true,kind:true}},returnReceipts:{with:{refundDecisions:{orderBy:(_t,{sql})=>sql`rowid DESC`,limit:1}}}}});
  if(!order)return null;
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
    id:r.id,reasonCode:r.reasonCategory?.code??'unspecified',status:statusOf(r.events),version:r.events.at(-1)?.id??r.id,reason:r.reason,createdAt:r.createdAt.toISOString(),
    items:r.items.map(i=>({...i,name:lines[i.lineIndex]?.name??'Ordered item',received:receiptQuantity(r,i.lineIndex)})),
    canCancel:['pending','approved'].includes(statusOf(r.events))&&!r.receipts.length,
    updates:r.events.map(e=>({status:e.status,message:e.customerMessage,createdAt:e.createdAt.toISOString()})),
  }))};
}
export async function createCustomerReturn(ctx:CommerceContext,input:unknown,owner:ReturnOwner={}):Promise<ReturnRequestReceipt|null> {
  const v=createSchema.parse(input);if(!await owned(ctx,v.orderId,owner))return null;
  const values={...v,items:[...v.items].sort((a,b)=>a.lineIndex-b.lineIndex)};
  const requestId=`rma_${await hashOrderAccess(`${v.orderId}:${v.requestKey}`)}`,hash=await fingerprint(values,'customer');
  const replay=async()=>{const r=await ctx.db.select().from(returnRequests).where(eq(returnRequests.id,requestId)).get();if(!r)return null;if(r.fingerprint!==hash)throw new CommerceOperationsConflict('This return request key was used with different details.');return {requestId,duplicate:true};};
  const previous=await replay();if(previous)return previous;
  try{await ctx.db.batch([ctx.db.insert(returnRequests).values({id:requestId,orderId:v.orderId,items:values.items,reason:v.reason,fingerprint:hash,createdAt:new Date()}),ctx.db.insert(returnRequestReasons).values({requestId,code:v.reasonCode})]);}
  catch(error){const previous=await replay();if(previous)return previous;if(!errorText(error).includes('Return request exceeds available shipped goods'))throw error;throw new CommerceOperationsConflict('Return quantities changed or parcel details are unavailable. Refresh before requesting a return.');}
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
  const request=await db.query.returnRequests.findFirst({where:{id:v.requestId},with:{order:{columns:{id:true,items:true,status:true}},events:{orderBy:(_t,{sql})=>sql`rowid`},receipts:{with:{receipt:{with:{inspections:true}}}}}});
  if(!request)throw new CommerceOperationsConflict('Return request not found.');
  const names=await adminActorNames(env,request.events.filter(e=>e.actorKind==='staff').map(e=>e.actor));
  const described=await describeOrderItems(env,request.order.items);
  return {id:request.id,orderId:request.orderId,reason:request.reason,status:statusOf(request.events),version:request.events.at(-1)?.id??request.id,createdAt:request.createdAt.toISOString(),
    items:request.items.map(i=>({...i,name:[described[i.lineIndex]?.productName||'Ordered item',described[i.lineIndex]?.variantLabel].filter(Boolean).join(' / '),
      restockMapped:!!request.order.items[i.lineIndex]?.stockTargets?.length,
      received:request.receipts.reduce((n,l)=>n+(l.receipt.items.find(j=>j.lineIndex===i.lineIndex)?.quantity??0),0)})),
    events:request.events.map(e=>({id:e.id,status:e.status,reason:e.reason,actorKind:e.actorKind,actor:e.actor,customerMessage:e.customerMessage,actorName:e.actorKind==='customer'?'Customer':names.get(e.actor)??e.actor,createdAt:e.createdAt.toISOString()})),
    receipts:request.receipts.map(l=>({receiptId:l.receiptId,createdAt:l.receipt.createdAt.toISOString()}))};
}
/** Flat, bounded queue; a pending inspection appears even when intake had no customer request. */
export async function listReturnsQueue(env:TalismanEnv,input:unknown={}):Promise<ReturnsQueue> {
  const v=z.object({filter:z.enum(['active','pending','approved','inspection','all']).default('active'),orderId:z.string().trim().max(128).default(''),offset:z.coerce.number().int().min(0).max(1000000).default(0)}).strict().parse(input);
  const queue=sql`WITH requests AS (
    SELECT 'request' AS kind,r.id,r.order_id AS orderId,COALESCE((SELECT status FROM _ecommerce_return_request_events e WHERE e.request_id=r.id ORDER BY rowid DESC LIMIT 1),'pending') AS status,r.created_at AS createdAt,r.reason,
    MAX(0,(SELECT sum(json_extract(value,'$.quantity')) FROM json_each(r.items))-COALESCE((SELECT sum(json_extract(i.value,'$.quantity')) FROM _ecommerce_return_request_receipts l JOIN _ecommerce_return_receipts x ON x.id=l.receipt_id,json_each(x.items) i WHERE l.request_id=r.id),0)) AS pendingUnits
    FROM _ecommerce_return_requests r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
  ), inspections AS (
    SELECT 'inspection' AS kind,r.id,r.order_id AS orderId,'inspection' AS status,r.created_at AS createdAt,r.reason,
    (SELECT COALESCE(sum(json_extract(value,'$.quantity')),0) FROM json_each(r.items) WHERE json_extract(value,'$.condition')='inspection')-
    COALESCE((SELECT sum(json_extract(i.value,'$.quantity')) FROM _ecommerce_return_inspections d,json_each(d.items) i WHERE d.receipt_id=r.id),0) AS pendingUnits
    FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test'
  ), queue AS (SELECT * FROM requests UNION ALL SELECT * FROM inspections WHERE pendingUnits>0)`;
  const filter=v.filter==='all'?sql`1=1`:v.filter==='active'?sql`(status='pending' OR status='approved' OR kind='inspection')`:sql`status=${v.filter}`;
  const where=sql`${filter} AND (${v.orderId}='' OR orderId=${v.orderId})`,db=commerceDb(env);
  const [rows,total]=await db.batch([db.all<{kind:'request'|'inspection';id:string;orderId:string;status:string;createdAt:number;reason:string;pendingUnits:number}>(sql`${queue} SELECT * FROM queue WHERE ${where} ORDER BY createdAt,id LIMIT 50 OFFSET ${v.offset}`),db.all<{n:number}>(sql`${queue} SELECT count(*) n FROM queue WHERE ${where}`)]);
  return {...v,total:total[0]?.n??0,rows:rows.map(r=>({...r,createdAt:new Date(r.createdAt*1000).toISOString()}))};
}
