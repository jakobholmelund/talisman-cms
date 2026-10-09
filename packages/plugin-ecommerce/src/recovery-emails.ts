import { sql } from 'drizzle-orm';
import { commerceDb } from './db';
import { applyEmailTemplate, bareEmailAddress, type CommerceEmailComposer } from './email-deliveries';
import { recoveryNoticeEmail, type RecoveryNoticeEmail } from './emails';
/** Build only shopper-safe facts from the committed parcel; never pass audit text to a template. */
export function recoveryComposer(kind:'shipment'|'tracking'|'received'):CommerceEmailComposer {
 return async(env,subjectId,setup)=>{
  const db=commerceDb(env);
  const event=kind==='tracking'?await db.query.recoveryEvents.findFirst({where:{id:subjectId},columns:{id:true,kind:true,shipmentId:true,createdAt:true}}):null;
  const receipt=kind==='received'?await db.query.recoveryReceipts.findFirst({where:{id:subjectId},columns:{quantity:true,shipmentId:true,createdAt:true,redactedAt:true}}):null;
  const shipmentId=kind==='tracking'?event?.shipmentId:kind==='received'?receipt?.shipmentId:subjectId;
  if(!shipmentId||(kind==='tracking'&&event?.kind!=='tracking'))return {cancel:'not_due'};
  const s=await db.query.recoveryShipments.findFirst({where:{id:shipmentId},with:{case:{with:{order:{columns:{id:true,customerEmail:true,paymentProvider:true,userId:true}}}}}});
  if(!s||s.redactedAt||s.case.redactedAt||receipt?.redactedAt||s.case.order.paymentProvider==='admin_test')return {cancel:'not_due'};
  const erased=await db.get<{n:number}>(sql`SELECT count(*) n FROM _ecommerce_shopper_audits WHERE account_id=${s.case.order.userId} AND action='anonymize'`);if(erased?.n)return {cancel:'not_due'};
  const correction=await db.query.recoveryEvents.findFirst({where:{caseId:s.caseId,shipmentId:s.id,kind:'tracking'},columns:{id:true,carrier:true,trackingNumber:true},orderBy:(_t,{sql})=>sql`rowid DESC`});
  if(kind==='tracking'&&correction?.id!==event?.id)return {cancel:'superseded'};
  const to=bareEmailAddress(s.case.order.customerEmail);if(!to)return {cancel:'not_due'};
  const email:RecoveryNoticeEmail={store:setup.store,orderId:s.case.order.id,kind,exchange:s.case.kind==='exchange',
   occurredAt:(receipt??event??s).createdAt,name:s.case.target.name,sku:s.case.target.sku,quantity:receipt?.quantity??s.quantity,
   carrier:correction?correction.carrier:s.carrier,trackingNumber:correction?correction.trackingNumber:s.trackingNumber};
  return {to,message:await applyEmailTemplate(setup,'recoveryNotice',email,recoveryNoticeEmail(email))};
 };
}
