import { sql } from 'drizzle-orm';
import { physicalStockLocations } from './replenishment';

export const RECOVERY_NEXT_ACTIONS = ['inspection','review','refund','payment','stock','dispatch','follow_up','complete'] as const;
export type RecoveryNextAction = typeof RECOVERY_NEXT_ACTIONS[number];
export const recoveryActionLabels: Record<RecoveryNextAction,string> = {
 inspection:'Inspect returned replacement goods',review:'Review the case',refund:'Review or confirm the refund',payment:'Confirm upgrade payment',stock:'Replenish replacement stock',dispatch:'Pack and dispatch',follow_up:'Confirm the agreed outcome',complete:'Resolved',
};
/** A queue snapshot, never permission to ship. Dispatch repeats provider, version and stock checks. */
export const recoveryProgressQuery = sql`WITH physical AS (${physicalStockLocations}), facts AS (
 SELECT c.id,c.order_id AS orderId,c.receipt_id AS receiptId,c.line_index AS lineIndex,c.kind,c.quantity,c.created_at AS createdAt,json_extract(c.target,'$.name') AS name,
 COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),'open') AS status,
 (COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=c.id AND actor='payment_provider'),0)>COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=c.id AND kind='resolve'),0)) AS awaitingPaymentReview,
 EXISTS(SELECT 1 FROM _ecommerce_recovery_receipts r JOIN _ecommerce_recovery_shipments s ON s.id=r.shipment_id WHERE s.case_id=c.id AND r.quantity>COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_inspections WHERE receipt_id=r.id),0)) AS awaitingInspection,
 COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_shipments WHERE case_id=c.id),0) AS shipped,
 COALESCE(json_extract(c.target,'$.adjustmentMinor'),0) AS adjustment,
 COALESCE((SELECT status FROM _ecommerce_return_refund_decisions WHERE receipt_id=c.receipt_id ORDER BY rowid DESC LIMIT 1),'review') AS refundStatus,
 COALESCE((SELECT amount_minor FROM _ecommerce_return_refund_decisions WHERE receipt_id=c.receipt_id ORDER BY rowid DESC LIMIT 1),0) AS refundAmount,
 EXISTS(SELECT 1 FROM _ecommerce_recovery_payments p WHERE p.case_id=c.id AND p.rowid=(SELECT max(rowid) FROM _ecommerce_recovery_payments WHERE case_id=c.id)
 AND NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_payment_events e WHERE e.payment_id=p.id AND e.kind IN ('refunded','lost'))
 AND COALESCE((SELECT kind FROM _ecommerce_recovery_payment_events e WHERE e.payment_id=p.id AND e.kind IN ('disputed','won') ORDER BY rowid DESC LIMIT 1),'won')<>'disputed') AS paid,
 EXISTS(SELECT 1 FROM json_each(c.target,'$.stockTargets') t WHERE NOT EXISTS(SELECT 1 FROM physical p WHERE p.type=json_extract(t.value,'$.type') AND p.id=json_extract(t.value,'$.id') AND p.quantity>=json_extract(t.value,'$.units'))) AS stockShort,
 o.status AS paymentStatus,o.shipping_address AS address,c.redacted_at AS redacted
 FROM _ecommerce_recovery_cases c JOIN _ecommerce_orders o ON o.id=c.order_id
 ), cases AS (SELECT *,CASE
 WHEN awaitingInspection=1 THEN 'inspection'
 WHEN awaitingPaymentReview=1 OR redacted IS NOT NULL THEN 'review'
 WHEN status='resolved' THEN 'complete'
 WHEN paymentStatus NOT IN ('paid','partially_refunded') OR (paymentStatus='partially_refunded' AND (kind<>'exchange' OR adjustment>=0)) THEN 'review'
 WHEN shipped>=quantity THEN 'follow_up'
 WHEN kind='exchange' AND ((adjustment<0 AND (refundStatus<>'settled' OR refundAmount<>-adjustment)) OR (adjustment>=0 AND refundStatus<>'not_needed')) THEN 'refund'
 WHEN kind='exchange' AND adjustment>0 AND paid=0 THEN 'payment'
 WHEN address IS NULL THEN 'review'
 WHEN stockShort=1 THEN 'stock'
 ELSE 'dispatch' END AS nextAction FROM facts)`;

export interface RecoveryProgressRow {
 id:string; lineIndex:number; orderId:string; receiptId:string|null; kind:'lost'|'damaged'|'exchange'; quantity:number; shipped:number;
 awaitingInspection:number; awaitingPaymentReview:number; name:string; status:'open'|'resolved'; createdAt:number; nextAction:RecoveryNextAction;
}
