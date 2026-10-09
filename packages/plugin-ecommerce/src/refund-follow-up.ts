import { commerceEmailStatement } from './email-deliveries';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb, errorText } from './db';
import { hashOrderAccess } from './cookies';
import { CommerceOperationsConflict } from './email-recovery';
import { returnRefundDecisions, RETURN_REFUND_STATUSES, REFUND_SOURCE_KINDS, type RefundAllocation, shopperAudits } from './schema';
import { describeOrderItems } from './order-items';
import { adminActorNames } from './admin-actors';
const id=z.string().trim().min(1).max(128), reason=z.string().trim().min(8).max(500);
export type RefundStatus=typeof RETURN_REFUND_STATUSES[number]|'review'|'unavailable';
export type RefundQueue={offset:number;total:number;filter:string;orderId:string;rows:Array<{id:string;orderId:string;status:RefundStatus;amountMinor:number;currency:string;createdAt:string}>};
type Decision=typeof returnRefundDecisions.$inferSelect;
export type RefundCase={receiptId:string;orderId:string;currency:string;version:string;status:RefundStatus;amountMinor:number;
  items:Array<{name:string;quantity:number}>;history:Array<Pick<Decision,'id'|'status'|'amountMinor'|'allocations'|'reason'|'actor'>&{actorName:string;createdAt:string}>;
  sources:Array<{kind:typeof REFUND_SOURCE_KINDS[number];id:string;amountMinor:number;availableMinor:number;createdAt:string|null}>};
const sourceRows=sql`SELECT 'provider' AS kind,id,order_id,amount_cents,created_at FROM _ecommerce_provider_refunds
 UNION ALL SELECT 'gift_card',id,order_id,amount_cents,created_at FROM _ecommerce_gift_card_ledger WHERE kind='refund_restore'
 UNION ALL SELECT 'store_credit',id,order_id,amount_cents,created_at FROM _ecommerce_credit_ledger WHERE kind='purchase_credit_refund'`;
export async function listRefundFollowUp(env:TalismanEnv,input:unknown={}):Promise<RefundQueue>{
 const v=z.object({offset:z.coerce.number().int().min(0).max(1000000).default(0),filter:z.enum(['active','review','needed','resolved','all']).default('active'),orderId:z.string().trim().max(128).default('')}).strict().parse(input),db=commerceDb(env);
 const cte=sql`WITH cases AS (SELECT r.id,r.order_id AS orderId,o.currency,r.created_at AS createdAt,
 CASE WHEN EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a WHERE a.account_id=o.user_id AND a.action='anonymize') THEN 'unavailable' ELSE COALESCE((SELECT status FROM _ecommerce_return_refund_decisions d WHERE d.receipt_id=r.id ORDER BY rowid DESC LIMIT 1),'review') END AS status,
 COALESCE((SELECT amount_minor FROM _ecommerce_return_refund_decisions d WHERE d.receipt_id=r.id ORDER BY rowid DESC LIMIT 1),0) AS amountMinor
 FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test')`;
 const where=sql`(${v.orderId}='' OR orderId=${v.orderId}) AND (${v.filter}='all' OR (${v.filter}='active' AND status IN ('review','needed')) OR (${v.filter}='resolved' AND status IN ('settled','not_needed','unavailable')) OR status=${v.filter})`;
 const [rows,count]=await db.batch([db.all<Omit<RefundQueue['rows'][number],'createdAt'>&{createdAt:number}>(sql`${cte} SELECT * FROM cases WHERE ${where} ORDER BY createdAt,id LIMIT 50 OFFSET ${v.offset}`),db.all<{n:number}>(sql`${cte} SELECT count(*) n FROM cases WHERE ${where}`)]);
 return {...v,total:count[0]?.n??0,rows:rows.map(r=>({...r,createdAt:new Date(r.createdAt*1000).toISOString()}))};
}
export async function readRefundCase(env:TalismanEnv,input:unknown):Promise<RefundCase>{
 const v=z.object({receiptId:id}).strict().parse(input),db=commerceDb(env);
 const r=await db.query.returnReceipts.findFirst({where:{id:v.receiptId},with:{order:{columns:{id:true,items:true,currency:true,paymentProvider:true,userId:true}},refundDecisions:{orderBy:(_t,{sql})=>sql`rowid`}}});
 if(!r||r.order.paymentProvider==='admin_test')throw new CommerceOperationsConflict('Received return is unavailable.');
 const [sources,names,items]=await Promise.all([db.all<{kind:typeof REFUND_SOURCE_KINDS[number];id:string;amountMinor:number;availableMinor:number;createdAt:number|null}>(sql`WITH sources AS (${sourceRows}) SELECT kind,id,amount_cents AS amountMinor,created_at AS createdAt,
 amount_cents-COALESCE((SELECT sum(json_extract(a.value,'$.amountMinor')) FROM _ecommerce_return_refund_decisions d,json_each(d.allocations) a WHERE d.status='settled' AND json_extract(a.value,'$.kind')=sources.kind AND json_extract(a.value,'$.sourceId')=sources.id),0) AS availableMinor FROM sources WHERE order_id=${r.orderId} ORDER BY created_at,id`),adminActorNames(env,r.refundDecisions.map(d=>d.actor)),describeOrderItems(env,r.items.map(i=>({...r.order.items[i.lineIndex],quantity:i.quantity})))]);
 const latest=r.refundDecisions.at(-1),erased=r.order.userId?await db.select({id:shopperAudits.id}).from(shopperAudits).where(sql`${shopperAudits.accountId}=${r.order.userId} AND ${shopperAudits.action}='anonymize'`).limit(1).get():null;
 return {receiptId:r.id,orderId:r.orderId,currency:r.order.currency,version:latest?.id??r.id,status:erased?'unavailable':latest?.status??'review',amountMinor:latest?.amountMinor??0,
 items:items.map(i=>({name:[i.productName||'Ordered item',i.variantLabel].filter(Boolean).join(' / '),quantity:i.quantity})),
 history:r.refundDecisions.map(d=>({id:d.id,status:d.status,amountMinor:d.amountMinor,allocations:d.allocations,reason:d.reason,actor:d.actor,actorName:names.get(d.actor)??d.actor,createdAt:d.createdAt.toISOString()})),
 sources:sources.map(s=>({...s,createdAt:s.createdAt===null?null:new Date(s.createdAt*1000).toISOString()}))};
}
const decision=z.object({receiptId:id,requestKey:id.min(8),expectedVersion:id,status:z.enum(RETURN_REFUND_STATUSES),amountMinor:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
 allocations:z.array(z.object({kind:z.enum(REFUND_SOURCE_KINDS),sourceId:id,amountMinor:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)}).strict()).max(20).default([]),reason}).strict().refine(v=>v.status==='not_needed'?v.amountMinor===0&&!v.allocations.length:v.amountMinor>0&&(v.status==='settled'?v.allocations.length>0&&v.allocations.reduce((n,a)=>n+a.amountMinor,0)===v.amountMinor:!v.allocations.length),'Choose an amount and matching confirmed refund allocations');
export async function recordRefundFollowUp(env:TalismanEnv,input:unknown,actor:string):Promise<{decisionId:string;duplicate?:boolean}>{
 const v=decision.parse(input);if(!actor.trim())throw new CommerceOperationsConflict('An authenticated staff member is required.');
 const allocations:RefundAllocation[]=[...v.allocations].sort((a,b)=>`${a.kind}:${a.sourceId}`.localeCompare(`${b.kind}:${b.sourceId}`));
 const db=commerceDb(env),decisionId=`rrf_${await hashOrderAccess(`${v.receiptId}:${v.requestKey}`)}`,fingerprint=await hashOrderAccess(JSON.stringify({...v,allocations,actor}));
 const replay=async()=>{const d=await db.select().from(returnRefundDecisions).where(eq(returnRefundDecisions.id,decisionId)).get();if(!d)return null;if(d.fingerprint!==fingerprint)throw new CommerceOperationsConflict('This refund decision key was used with other details.');return {decisionId,duplicate:true};};
 const previous=await replay();if(previous)return previous;
 try{await db.batch([db.insert(returnRefundDecisions).values({id:decisionId,receiptId:v.receiptId,expectedVersion:v.expectedVersion,status:v.status,amountMinor:v.amountMinor,allocations,actor,reason:v.reason,fingerprint,createdAt:new Date()}), ...(v.status==='settled'?[db.run(commerceEmailStatement('return_refund',decisionId,Math.floor(Date.now()/1000)))]:[])]);}
 catch(error){const previous=await replay();if(previous)return previous;if(!/Refund follow-up|Confirmed refunds/.test(errorText(error)))throw error;throw new CommerceOperationsConflict('This return or confirmed refund balance changed. Refresh before recording a decision.');}
 return {decisionId};
}
