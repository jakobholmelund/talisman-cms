import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import type { PaymentProviderAdapter } from './payments';
import { runtimePaymentAdapters } from './runtime';
import { commerceDb, errorText } from './db';
import { warehouseFingerprint } from './warehouse';
import { hashOrderAccess } from './cookies';
import { CommerceOperationsConflict } from './email-recovery';
import { recoveryPayments, recoveryPaymentEvents } from './schema';
const id=z.string().trim().min(1).max(128);
export const recoveryPaymentHeld=sql`EXISTS(SELECT 1 FROM _ecommerce_recovery_payment_events e WHERE e.payment_id=p.id AND e.kind IN ('refunded','lost')) OR COALESCE((SELECT kind FROM _ecommerce_recovery_payment_events e WHERE e.payment_id=p.id AND e.kind IN ('disputed','won') ORDER BY rowid DESC LIMIT 1),'won')='disputed'`;
async function verify(env:TalismanEnv,caseId:string,paymentId:string,amountMinor:number,currency:string,adapters?:PaymentProviderAdapter[]){
 const adapter=(adapters??runtimePaymentAdapters(env as unknown as Record<string,unknown>)).find(a=>a.providerId==='stripe');
 if(!adapter?.getExchangePayment)throw new CommerceOperationsConflict('The payment provider is unavailable. No exchange stock was changed.');
 const payment=await adapter.getExchangePayment(paymentId);
 if(!payment||payment.caseId!==caseId||payment.status!=='succeeded'||payment.amountMinor!==amountMinor||payment.currency!==currency||payment.refundedMinor!==0||payment.disputed)
  throw new CommerceOperationsConflict('This payment does not confirm the exact exchange amount, or it has been refunded or disputed.');
 return adapter;
}
/** Provider-verified extra tender. A staff assertion or unrelated payment is never sufficient. */
export async function verifyExchangeCharge(env:TalismanEnv,input:unknown,actor:string,adapters?:PaymentProviderAdapter[]){
 const v=z.object({caseId:id,expectedVersion:id,paymentId:z.string().regex(/^pi_[A-Za-z0-9_]+$/).max(128),reason:z.string().trim().min(8).max(500),requestKey:id.min(8)}).strict().parse(input);
 if(!actor.trim())throw new CommerceOperationsConflict('An authenticated staff member is required.');
 const db=commerceDb(env),decisionId=`rcp_${await hashOrderAccess(`${v.caseId}:${v.requestKey}`)}`,fingerprint=await warehouseFingerprint(v,actor);
 const replay=async()=>{const old=await db.select().from(recoveryPayments).where(eq(recoveryPayments.id,decisionId)).get();if(!old)return null;if(old.fingerprint!==fingerprint)throw new CommerceOperationsConflict('This payment verification key was used with different details.');return {decisionId,duplicate:true};};const previous=await replay();if(previous)return previous;
 const c=await db.query.recoveryCases.findFirst({where:{id:v.caseId},with:{order:{columns:{currency:true}}}}),amountMinor=c?.target.adjustmentMinor??0;
 if(!c||c.kind!=='exchange'||amountMinor<=0)throw new CommerceOperationsConflict('This case does not need an upgrade payment.');
 await verify(env,c.id,v.paymentId,amountMinor,c.order.currency,adapters);
 try{await db.insert(recoveryPayments).values({id:decisionId,caseId:c.id,expectedVersion:v.expectedVersion,provider:'stripe',paymentId:v.paymentId,amountMinor,currency:c.order.currency,actor,reason:v.reason,fingerprint,createdAt:new Date()});}
 catch(e){const old=await replay();if(old)return old;if(!/Recovery|UNIQUE constraint/.test(errorText(e)))throw e;throw new CommerceOperationsConflict('The case or payment allocation changed. Refresh before continuing.');}
 return {decisionId};
}
/** Recheck before every partial dispatch; signed provider events also protect the commit race. */
export async function checkExchangeCharge(env:TalismanEnv,caseId:string,adapters?:PaymentProviderAdapter[]){
 const db=commerceDb(env),c=await db.query.recoveryCases.findFirst({where:{id:caseId},with:{order:{columns:{currency:true}},payments:{orderBy:(_t,{sql})=>sql`rowid DESC`,limit:1}}});
 if(!c||c.kind!=='exchange'||(c.target.adjustmentMinor??0)<=0)return;
 const p=c.payments[0];if(!p||p.redactedAt)throw new CommerceOperationsConflict('Verify the upgrade payment before shipping.');
 await verify(env,c.id,p.paymentId,p.amountMinor,c.order.currency,adapters);
}
/** Refund/dispute events affect only this extra tender, never the original order's payment. */
export async function recordRecoveryPaymentEvent(env:TalismanEnv,paymentIntentId:string,eventId:string,kind:typeof recoveryPaymentEvents.$inferInsert['kind'],createdAt:number){
 const db=commerceDb(env),p=await db.select({id:recoveryPayments.id}).from(recoveryPayments).where(eq(recoveryPayments.paymentId,paymentIntentId)).get();if(!p)return null;
 await db.insert(recoveryPaymentEvents).values({id:eventId,paymentId:p.id,kind,createdAt:new Date(createdAt*1000)}).onConflictDoNothing();return {success:true,recoveryPayment:true};
}
