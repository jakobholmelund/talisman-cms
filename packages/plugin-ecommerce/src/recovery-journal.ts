import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb } from './db';
import { adminActorNames } from './admin-actors';
import { CommerceOperationsConflict } from './email-recovery';
/** Parents precede their consequences when D1's second-resolution timestamps tie. */
export const recoveryKindOrder=(kind:SQL)=>sql`CASE ${kind} WHEN 'exchange_requested' THEN 0 WHEN 'exchange_request_decision' THEN 1 WHEN 'case_created' THEN 2 WHEN 'upgrade_payment' THEN 3 WHEN 'exchange_refund_decision' THEN 3 WHEN 'replacement_shipment' THEN 4 WHEN 'replacement_receipt' THEN 5 WHEN 'replacement_inspection' THEN 6 ELSE 7 END`;
/** One flat audit row per committed record. Refund-event amounts are unknown, never inferred. */
export function recoveryJournal(caseScope:SQL=sql`1=1`,requestScope:SQL=sql`1=1`){return sql`WITH cases AS (
 SELECT c.*,o.currency FROM _ecommerce_recovery_cases c JOIN _ecommerce_orders o ON o.id=c.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND ${caseScope}
), case_work AS (
SELECT c.id AS record_id,
 'case_created' AS kind,
 c.order_id AS order_id,
 c.id AS case_id,
 NULL AS request_id,
 NULL AS shipment_id,
 NULL AS receipt_id,
 NULL AS verification_id,
 c.created_at AS created_at_utc,
 json_extract(c.target,'$.name') AS target_name,
 json_extract(c.target,'$.sku') AS target_sku,
 c.currency AS currency,
 c.quantity AS quantity,
 CASE WHEN c.kind='exchange' THEN COALESCE(json_extract(c.target,'$.adjustmentMinor'),0) END AS adjustment_minor,
 NULL AS amount_minor,
 NULL AS disposition,
 NULL AS restock,
 NULL AS carrier,
 NULL AS tracking_number,
 'open' AS recorded_status,
 c.actor AS actor,
 c.reason AS reason
 FROM cases c
 UNION ALL
SELECT e.id AS record_id,
 CASE WHEN p.id IS NOT NULL THEN 'upgrade_payment' WHEN e.kind='shipment' THEN 'replacement_shipment' ELSE 'case_'||e.kind END AS kind,
 c.order_id AS order_id,
 c.id AS case_id,
 NULL AS request_id,
 e.shipment_id AS shipment_id,
 NULL AS receipt_id,
 p.id AS verification_id,
 e.created_at AS created_at_utc,
 json_extract(c.target,'$.name') AS target_name,
 json_extract(c.target,'$.sku') AS target_sku,
 c.currency AS currency,
 CASE WHEN e.kind='shipment' THEN s.quantity END AS quantity,
 NULL AS adjustment_minor,
 p.amount_minor AS amount_minor,
 NULL AS disposition,
 NULL AS restock,
 e.carrier AS carrier,
 e.tracking_number AS tracking_number,
 e.status AS recorded_status,
 e.actor AS actor,
 e.reason AS reason
 FROM cases c JOIN _ecommerce_recovery_events e ON e.case_id=c.id LEFT JOIN _ecommerce_recovery_shipments s ON s.id=e.shipment_id LEFT JOIN _ecommerce_recovery_payments p ON p.id=e.id WHERE e.actor<>'payment_provider'
 UNION ALL
SELECT d.id AS record_id,
 'exchange_refund_decision' AS kind,
 c.order_id AS order_id,
 c.id AS case_id,
 NULL AS request_id,
 NULL AS shipment_id,
 d.receipt_id AS receipt_id,
 NULL AS verification_id,
 d.created_at AS created_at_utc,
 json_extract(c.target,'$.name') AS target_name,
 json_extract(c.target,'$.sku') AS target_sku,
 c.currency AS currency,
 NULL AS quantity,
 NULL AS adjustment_minor,
 d.amount_minor AS amount_minor,
 NULL AS disposition,
 NULL AS restock,
 NULL AS carrier,
 NULL AS tracking_number,
 d.status AS recorded_status,
 d.actor AS actor,
 d.reason AS reason
 FROM cases c JOIN _ecommerce_return_refund_decisions d ON d.receipt_id=c.receipt_id WHERE c.kind='exchange' AND COALESCE(json_extract(c.target,'$.adjustmentMinor'),0)<0
), goods AS (
SELECT r.id AS record_id,
 'replacement_receipt' AS kind,
 c.order_id AS order_id,
 c.id AS case_id,
 NULL AS request_id,
 s.id AS shipment_id,
 r.id AS receipt_id,
 NULL AS verification_id,
 r.created_at AS created_at_utc,
 json_extract(c.target,'$.name') AS target_name,
 json_extract(c.target,'$.sku') AS target_sku,
 c.currency AS currency,
 r.quantity AS quantity,
 NULL AS adjustment_minor,
 NULL AS amount_minor,
 NULL AS disposition,
 NULL AS restock,
 NULL AS carrier,
 NULL AS tracking_number,
 NULL AS recorded_status,
 r.actor AS actor,
 r.reason AS reason
 FROM cases c JOIN _ecommerce_recovery_shipments s ON s.case_id=c.id JOIN _ecommerce_recovery_receipts r ON r.shipment_id=s.id
 UNION ALL
SELECT i.id AS record_id,
 'replacement_inspection' AS kind,
 c.order_id AS order_id,
 c.id AS case_id,
 NULL AS request_id,
 s.id AS shipment_id,
 r.id AS receipt_id,
 NULL AS verification_id,
 i.created_at AS created_at_utc,
 json_extract(c.target,'$.name') AS target_name,
 json_extract(c.target,'$.sku') AS target_sku,
 c.currency AS currency,
 i.quantity AS quantity,
 NULL AS adjustment_minor,
 NULL AS amount_minor,
 i.disposition AS disposition,
 i.restock AS restock,
 NULL AS carrier,
 NULL AS tracking_number,
 NULL AS recorded_status,
 i.actor AS actor,
 i.reason AS reason
 FROM cases c JOIN _ecommerce_recovery_shipments s ON s.case_id=c.id JOIN _ecommerce_recovery_receipts r ON r.shipment_id=s.id JOIN _ecommerce_recovery_inspections i ON i.receipt_id=r.id
), provider_work AS (
SELECT e.id AS record_id,
 'upgrade_'||e.kind AS kind,
 c.order_id AS order_id,
 c.id AS case_id,
 NULL AS request_id,
 NULL AS shipment_id,
 NULL AS receipt_id,
 p.id AS verification_id,
 e.created_at AS created_at_utc,
 json_extract(c.target,'$.name') AS target_name,
 json_extract(c.target,'$.sku') AS target_sku,
 c.currency AS currency,
 NULL AS quantity,
 NULL AS adjustment_minor,
 NULL AS amount_minor,
 NULL AS disposition,
 NULL AS restock,
 NULL AS carrier,
 NULL AS tracking_number,
 NULL AS recorded_status,
 'payment_provider' AS actor,
 'Exchange payment review required' AS reason
 FROM cases c JOIN _ecommerce_recovery_payments p ON p.case_id=c.id JOIN _ecommerce_recovery_payment_events e ON e.payment_id=p.id
), request_work AS (
SELECT r.id AS record_id,
 'exchange_requested' AS kind,
 r.order_id AS order_id,
 NULL AS case_id,
 r.id AS request_id,
 NULL AS shipment_id,
 NULL AS receipt_id,
 NULL AS verification_id,
 r.created_at AS created_at_utc,
 json_extract(p.target,'$.name') AS target_name,
 json_extract(p.target,'$.sku') AS target_sku,
 o.currency AS currency,
 json_extract(r.items,'$[0].quantity') AS quantity,
 NULL AS adjustment_minor,
 NULL AS amount_minor,
 NULL AS disposition,
 NULL AS restock,
 NULL AS carrier,
 NULL AS tracking_number,
 'pending' AS recorded_status,
 'customer' AS actor,
 r.reason AS reason
 FROM _ecommerce_return_requests r JOIN _ecommerce_return_exchange_preferences p ON p.request_id=r.id JOIN _ecommerce_orders o ON o.id=r.order_id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND ${requestScope}
 UNION ALL
SELECT e.id AS record_id,
 'exchange_request_decision' AS kind,
 r.order_id AS order_id,
 NULL AS case_id,
 r.id AS request_id,
 NULL AS shipment_id,
 NULL AS receipt_id,
 NULL AS verification_id,
 e.created_at AS created_at_utc,
 json_extract(p.target,'$.name') AS target_name,
 json_extract(p.target,'$.sku') AS target_sku,
 o.currency AS currency,
 NULL AS quantity,
 NULL AS adjustment_minor,
 NULL AS amount_minor,
 NULL AS disposition,
 NULL AS restock,
 NULL AS carrier,
 NULL AS tracking_number,
 e.status AS recorded_status,
 e.actor AS actor,
 e.reason AS reason
 FROM _ecommerce_return_requests r JOIN _ecommerce_return_exchange_preferences p ON p.request_id=r.id JOIN _ecommerce_orders o ON o.id=r.order_id JOIN _ecommerce_return_request_events e ON e.request_id=r.id WHERE COALESCE(o.payment_provider,'stripe')<>'admin_test' AND ${requestScope}
), journal AS (SELECT * FROM case_work UNION ALL SELECT * FROM goods UNION ALL SELECT * FROM provider_work UNION ALL SELECT * FROM request_work)`;}
export interface RecoveryJournalRow {
 record_id:string;kind:string;order_id:string;case_id:string|null;request_id:string|null;shipment_id:string|null;receipt_id:string|null;verification_id:string|null;
 created_at_utc:number;target_name:string;target_sku:string|null;currency:string;quantity:number|null;adjustment_minor:number|null;amount_minor:number|null;
 disposition:string|null;restock:number|null;carrier:string|null;tracking_number:string|null;recorded_status:string|null;actor:string|null;reason:string;
}
/** The order detail loads a bounded chronological page only when staff open its history. */
export async function readOrderRecoveryHistory(env:TalismanEnv,input:unknown){
 const v=z.object({orderId:z.string().trim().min(1).max(128),offset:z.number().int().min(0).max(1000000).default(0)}).strict().parse(input),db=commerceDb(env);
 const order=await db.query.orders.findFirst({where:{id:v.orderId},columns:{id:true,paymentProvider:true}});if(!order||order.paymentProvider==='admin_test')throw new CommerceOperationsConflict('Order history is unavailable.');
 const journal=recoveryJournal(sql`c.order_id=${v.orderId}`,sql`r.order_id=${v.orderId}`);
 const [rows,count]=await db.batch([db.all<RecoveryJournalRow&{emailStatus:string|null;emailAttempts:number|null;emailError:string|null;emailNext:number|null}>(sql`${journal} SELECT j.*,m.status AS emailStatus,m.attempts AS emailAttempts,m.last_error AS emailError,CASE WHEN m.status='pending' THEN m.next_attempt_at END AS emailNext FROM journal j LEFT JOIN _ecommerce_email_deliveries m ON m.subject_id=j.record_id AND m.kind=CASE j.kind WHEN 'replacement_shipment' THEN 'recovery_shipment' WHEN 'case_tracking' THEN 'recovery_tracking' WHEN 'replacement_receipt' THEN 'recovery_received' WHEN 'exchange_request_decision' THEN 'return_decision' WHEN 'exchange_refund_decision' THEN 'return_refund' END ORDER BY j.created_at_utc,${recoveryKindOrder(sql`j.kind`)},j.record_id LIMIT 50 OFFSET ${v.offset}`),db.all<{n:number}>(sql`${journal} SELECT count(*) n FROM journal`)]);
 const names=await adminActorNames(env,rows.map(r=>r.actor??'').filter(a=>a&&a!=='customer'&&a!=='payment_provider'));
 return {...v,total:count[0]?.n??0,rows:rows.map(r=>({...r,created_at_utc:new Date(r.created_at_utc*1000).toISOString(),actorName:r.actor==='payment_provider'?'Payment provider':r.actor==='customer'?'Customer':names.get(r.actor??'')??r.actor,emailNext:r.emailNext===null?null:new Date(r.emailNext*1000).toISOString()}))};
}
