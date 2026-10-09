import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb, errorText } from './db';
import { hashOrderAccess } from './cookies';
import { warehouseFingerprint } from './warehouse';
import { CommerceOperationsConflict } from './email-recovery';
import { recoveryReceipts, recoveryInspections, RECOVERY_DISPOSITIONS, RESTOCK_TARGET_TYPES } from './schema';
const id=z.string().trim().min(1).max(128), quantity=z.number().int().min(1).max(1000000), reason=z.string().trim().min(8).max(500);
const stock=z.array(z.object({targetType:z.enum(RESTOCK_TARGET_TYPES),targetId:id,expectedQuantity:z.number().int().min(0).max(1000000),
 expectedUpdatedAt:z.string().refine(s=>Number.isSafeInteger(Date.parse(s))&&Date.parse(s)%1000===0)}).strict()).max(50);
async function commit<T>(insert:()=>Promise<unknown>,receipt:()=>Promise<T|null>){
 try{await insert();}catch(e){const old=await receipt();if(old)return old;if(!/Recovery|Stock |stock_movement|UNIQUE constraint/.test(errorText(e)))throw e;throw new CommerceOperationsConflict('Returned quantities, the case or stock changed. Refresh before continuing.');}return null;
}
/** Receipt acknowledges physical goods only; it never promises a refund or restores stock. */
export async function receiveReplacementReturn(env:TalismanEnv,input:unknown,actor:string){
 const v=z.object({shipmentId:id,quantity,reason,requestKey:id.min(8)}).strict().parse(input);if(!actor.trim())throw new CommerceOperationsConflict('An authenticated staff member is required.');
 const db=commerceDb(env),receiptId=`rcr_${await hashOrderAccess(`${v.shipmentId}:${v.requestKey}`)}`,fingerprint=await warehouseFingerprint(v,actor);
 const replay=async()=>{const old=await db.select().from(recoveryReceipts).where(eq(recoveryReceipts.id,receiptId)).get();if(!old)return null;if(old.fingerprint!==fingerprint)throw new CommerceOperationsConflict('This return key was used with different details.');return {receiptId,duplicate:true};};const old=await replay();if(old)return old;
 return await commit(()=>db.insert(recoveryReceipts).values({id:receiptId,shipmentId:v.shipmentId,quantity:v.quantity,actor,reason:v.reason,fingerprint,createdAt:new Date()}),replay)??{receiptId};
}
/** Partial dispositions use the outgoing parcel's frozen recipe, independently of checkout stock. */
export async function inspectReplacementReturn(env:TalismanEnv,input:unknown,actor:string){
 const v=z.object({receiptId:id,quantity,disposition:z.enum(RECOVERY_DISPOSITIONS),restock:z.boolean(),stock:stock.default([]),reason,requestKey:id.min(8)}).strict()
  .refine(v=>v.restock?v.disposition==='sellable':v.stock.length===0,'Only sellable goods may restore stock').parse(input);
 if(!actor.trim())throw new CommerceOperationsConflict('An authenticated staff member is required.');
 const db=commerceDb(env),inspectionId=`rci_${await hashOrderAccess(`${v.receiptId}:${v.requestKey}`)}`,fingerprint=await warehouseFingerprint(v,actor);
 const replay=async()=>{const old=await db.select().from(recoveryInspections).where(eq(recoveryInspections.id,inspectionId)).get();if(!old)return null;if(old.fingerprint!==fingerprint)throw new CommerceOperationsConflict('This inspection key was used with different details.');return {inspectionId,duplicate:true};};const old=await replay();if(old)return old;
 const receipt=await db.query.recoveryReceipts.findFirst({where:{id:v.receiptId},with:{shipment:{with:{case:true}}}});if(!receipt)throw new CommerceOperationsConflict('Replacement return not found.');
 const targets=receipt.shipment.case.target.stockTargets;
 if(v.restock&&(v.stock.length!==targets.length||new Set(v.stock.map(s=>`${s.targetType}:${s.targetId}`)).size!==v.stock.length))throw new CommerceOperationsConflict('Reload every replacement stock pool.');
 const pools=v.stock.map(s=>{const target=targets.find(t=>t.type===s.targetType&&t.id===s.targetId),units=(target?.units??0)*v.quantity;
  if(!target||!Number.isSafeInteger(units)||units<1||units>1000000)throw new CommerceOperationsConflict('The replacement stock mapping is unavailable.');
  return {targetType:s.targetType,targetId:s.targetId,expectedQuantity:s.expectedQuantity,expectedUpdatedSeconds:Date.parse(s.expectedUpdatedAt)/1000,units};});
 return await commit(()=>db.insert(recoveryInspections).values({id:inspectionId,receiptId:v.receiptId,quantity:v.quantity,disposition:v.disposition,restock:v.restock,stock:pools,actor,reason:v.reason,fingerprint,createdAt:new Date()}),replay)??{inspectionId};
}
