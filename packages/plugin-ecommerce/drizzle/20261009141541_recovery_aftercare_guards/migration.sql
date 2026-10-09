DROP TRIGGER `_ecommerce_recovery_case_guard`;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_case_guard` BEFORE INSERT ON `_ecommerce_recovery_cases`
WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_orders o WHERE o.id=NEW.order_id AND o.status IN ('paid','partially_refunded') AND COALESCE(o.payment_provider,'stripe')<>'admin_test'
 AND o.shipping_address IS NOT NULL AND json_type(o.items,'$['||NEW.line_index||']')='object'
 AND NOT EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a WHERE a.account_id=o.user_id AND a.action='anonymize'))
 OR (SELECT count(*) FROM _ecommerce_recovery_cases WHERE order_id=NEW.order_id)>=100
 OR NEW.redacted_at IS NOT NULL
 OR json_type(NEW.target,'$.productId') IS NOT 'text' OR json_type(NEW.target,'$.name') IS NOT 'text'
 OR json_type(NEW.target,'$.priceAtPurchase') IS NOT 'integer' OR json_extract(NEW.target,'$.priceAtPurchase')<=0
 OR EXISTS(SELECT 1 FROM json_each(NEW.target,'$.stockTargets') t WHERE json_extract(t.value,'$.type') NOT IN ('product','variant','stock','component') OR json_type(t.value,'$.id') IS NOT 'text' OR json_type(t.value,'$.units') IS NOT 'integer' OR json_extract(t.value,'$.units') NOT BETWEEN 1 AND 1000000)
 OR (SELECT count(*) FROM json_each(NEW.target,'$.stockTargets'))<>(SELECT count(DISTINCT json_extract(value,'$.type')||':'||json_extract(value,'$.id')) FROM json_each(NEW.target,'$.stockTargets'))
 OR (NEW.source_shipment_id IS NULL AND NEW.quantity+COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_cases WHERE order_id=NEW.order_id AND line_index=NEW.line_index AND source_shipment_id IS NULL),0)>(SELECT json_extract(items,'$['||NEW.line_index||'].quantity') FROM _ecommerce_orders WHERE id=NEW.order_id))
 OR (NEW.fulfillment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM _ecommerce_parcel_contents p,json_each(p.items) i WHERE p.fulfillment_id=NEW.fulfillment_id AND p.order_id=NEW.order_id AND json_extract(i.value,'$.lineIndex')=NEW.line_index
  AND NEW.quantity+COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_cases WHERE fulfillment_id=NEW.fulfillment_id AND line_index=NEW.line_index),0)<=json_extract(i.value,'$.quantity')))
 OR (NEW.source_shipment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_shipments s JOIN _ecommerce_recovery_cases c ON c.id=s.case_id WHERE s.id=NEW.source_shipment_id AND c.order_id=NEW.order_id AND c.line_index=NEW.line_index AND NEW.target=c.target
  AND NEW.quantity+COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_cases WHERE source_shipment_id=NEW.source_shipment_id),0)<=s.quantity))
 OR (NEW.kind='exchange' AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id,json_each(r.items) i
  WHERE r.id=NEW.receipt_id AND r.order_id=NEW.order_id AND json_extract(i.value,'$.lineIndex')=NEW.line_index
  AND (COALESCE(json_extract(NEW.target,'$.adjustmentMinor'),0)<0 OR COALESCE((SELECT status FROM _ecommerce_return_refund_decisions WHERE receipt_id=r.id ORDER BY rowid DESC LIMIT 1),'review')='not_needed')
  AND NEW.quantity+COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_cases WHERE receipt_id=r.id AND line_index=NEW.line_index),0)<=CASE WHEN json_extract(i.value,'$.condition')='inspection' THEN COALESCE((SELECT sum(json_extract(j.value,'$.quantity')) FROM _ecommerce_return_inspections d,json_each(d.items) j WHERE d.receipt_id=r.id AND json_extract(j.value,'$.lineIndex')=NEW.line_index),0) ELSE json_extract(i.value,'$.quantity') END
  AND COALESCE(json_extract(NEW.target,'$.adjustmentMinor'),0)=(json_extract(NEW.target,'$.priceAtPurchase')-json_extract(o.items,'$['||NEW.line_index||'].priceAtPurchase'))*NEW.quantity))
 OR (NEW.kind='exchange' AND NOT EXISTS(SELECT 1 FROM _ecommerce_products p WHERE p.id=json_extract(NEW.target,'$.productId') AND p.status='active' AND p.type='standard' AND p.is_physical=1
  AND json_extract(NEW.target,'$.priceAtPurchase')=CASE WHEN json_extract(NEW.target,'$.variantId') IS NULL THEN CASE WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_product_variants WHERE product_id=p.id) THEN p.base_price END
  ELSE COALESCE((SELECT COALESCE(v.price_override,g.price_override,p.base_price) FROM _ecommerce_product_variant_values v JOIN _ecommerce_product_variants g ON g.id=v.product_variant_id WHERE v.id=json_extract(NEW.target,'$.variantId') AND g.product_id=p.id),
   (SELECT COALESCE(g.price_override,p.base_price) FROM _ecommerce_product_variants g WHERE g.id=json_extract(NEW.target,'$.variantId') AND g.product_id=p.id AND NOT EXISTS(SELECT 1 FROM _ecommerce_product_variant_values WHERE product_variant_id=g.id))) END))
 OR (NEW.kind<>'exchange' AND (SELECT status FROM _ecommerce_orders WHERE id=NEW.order_id)<>'paid')
 OR (NEW.kind='exchange' AND (SELECT status FROM _ecommerce_orders WHERE id=NEW.order_id)='partially_refunded' AND COALESCE(json_extract(NEW.target,'$.adjustmentMinor'),0)>=0)
 OR (NEW.kind='exchange' AND EXISTS(SELECT 1 FROM _ecommerce_recovery_cases c WHERE c.receipt_id=NEW.receipt_id AND (COALESCE(json_extract(NEW.target,'$.adjustmentMinor'),0)<>0 OR COALESCE(json_extract(c.target,'$.adjustmentMinor'),0)<>0)))
BEGIN SELECT RAISE(ABORT,'Recovery source, inspected units, equal price or payment changed'); END;
--> statement-breakpoint
DROP TRIGGER `_ecommerce_recovery_event_guard`;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_event_guard` BEFORE INSERT ON `_ecommerce_recovery_events`
WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_cases WHERE id=NEW.case_id AND redacted_at IS NULL)
 OR NEW.redacted_at IS NOT NULL
 OR (SELECT count(*) FROM _ecommerce_recovery_events WHERE case_id=NEW.case_id)>=1000
 OR NEW.expected_version IS NOT COALESCE((SELECT id FROM _ecommerce_recovery_events WHERE case_id=NEW.case_id ORDER BY rowid DESC LIMIT 1),NEW.case_id)
 OR (NEW.kind='resolve' AND (NEW.status<>'resolved' OR (COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=NEW.case_id ORDER BY rowid DESC LIMIT 1),'open')<>'open' AND NOT (COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=NEW.case_id AND actor='payment_provider'),0)>COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=NEW.case_id AND kind='resolve'),0)))))
 OR (NEW.kind='reopen' AND (NEW.status<>'open' OR COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=NEW.case_id ORDER BY rowid DESC LIMIT 1),'open')<>'resolved'))
 OR (NEW.kind IN ('note','tracking') AND NEW.status IS NOT COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=NEW.case_id ORDER BY rowid DESC LIMIT 1),'open'))
 OR (NEW.kind='shipment' AND NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_shipments WHERE id=NEW.shipment_id AND id=NEW.id AND case_id=NEW.case_id AND NEW.status='open' AND expected_version=NEW.expected_version AND fingerprint=NEW.fingerprint))
 OR (NEW.kind='tracking' AND NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_shipments WHERE id=NEW.shipment_id AND case_id=NEW.case_id))
 OR (NEW.kind='reopen' AND NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_cases c JOIN _ecommerce_orders o ON o.id=c.order_id WHERE c.id=NEW.case_id
  AND (o.status='paid' OR (o.status='partially_refunded' AND c.kind='exchange' AND COALESCE(json_extract(c.target,'$.adjustmentMinor'),0)<0))
  AND (c.kind<>'exchange' OR ((COALESCE(json_extract(c.target,'$.adjustmentMinor'),0)>=0 AND COALESCE((SELECT status FROM _ecommerce_return_refund_decisions WHERE receipt_id=c.receipt_id ORDER BY rowid DESC LIMIT 1),'review')='not_needed') OR (COALESCE(json_extract(c.target,'$.adjustmentMinor'),0)<0 AND COALESCE((SELECT status FROM _ecommerce_return_refund_decisions WHERE receipt_id=c.receipt_id ORDER BY rowid DESC LIMIT 1),'review')='settled' AND COALESCE((SELECT amount_minor FROM _ecommerce_return_refund_decisions WHERE receipt_id=c.receipt_id ORDER BY rowid DESC LIMIT 1),0)=-COALESCE(json_extract(c.target,'$.adjustmentMinor'),0))))))
 OR (NEW.kind='resolve' AND EXISTS(SELECT 1 FROM _ecommerce_recovery_receipts r JOIN _ecommerce_recovery_shipments s ON s.id=r.shipment_id WHERE s.case_id=NEW.case_id AND r.quantity>COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_inspections WHERE receipt_id=r.id),0)))
BEGIN SELECT RAISE(ABORT,'Recovery version or transition changed'); END;
--> statement-breakpoint
DROP TRIGGER `_ecommerce_recovery_shipment_guard`;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_shipment_guard` BEFORE INSERT ON `_ecommerce_recovery_shipments`
WHEN NEW.redacted_at IS NOT NULL OR (SELECT count(*) FROM _ecommerce_recovery_shipments WHERE case_id=NEW.case_id)>=100 OR NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_cases c JOIN _ecommerce_orders o ON o.id=c.order_id WHERE c.id=NEW.case_id AND c.redacted_at IS NULL
 AND (o.status='paid' OR (o.status='partially_refunded' AND c.kind='exchange' AND COALESCE(json_extract(c.target,'$.adjustmentMinor'),0)<0)) AND o.shipping_address IS NOT NULL
 AND COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),'open')='open'
 AND NEW.expected_version=COALESCE((SELECT id FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),c.id)
 AND NEW.quantity+COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_shipments WHERE case_id=c.id),0)<=c.quantity
 AND (c.kind<>'exchange' OR (((COALESCE(json_extract(c.target,'$.adjustmentMinor'),0)>=0 AND COALESCE((SELECT status FROM _ecommerce_return_refund_decisions WHERE receipt_id=c.receipt_id ORDER BY rowid DESC LIMIT 1),'review')='not_needed') OR (COALESCE(json_extract(c.target,'$.adjustmentMinor'),0)<0 AND COALESCE((SELECT status FROM _ecommerce_return_refund_decisions WHERE receipt_id=c.receipt_id ORDER BY rowid DESC LIMIT 1),'review')='settled' AND COALESCE((SELECT amount_minor FROM _ecommerce_return_refund_decisions WHERE receipt_id=c.receipt_id ORDER BY rowid DESC LIMIT 1),0)=-COALESCE(json_extract(c.target,'$.adjustmentMinor'),0))) AND (COALESCE(json_extract(c.target,'$.adjustmentMinor'),0)<=0 OR EXISTS(SELECT 1 FROM _ecommerce_recovery_payments p WHERE p.case_id=c.id AND p.rowid=(SELECT max(rowid) FROM _ecommerce_recovery_payments WHERE case_id=c.id) AND NOT (EXISTS(SELECT 1 FROM _ecommerce_recovery_payment_events e WHERE e.payment_id=p.id AND e.kind IN ('refunded','lost')) OR COALESCE((SELECT kind FROM _ecommerce_recovery_payment_events e WHERE e.payment_id=p.id AND e.kind IN ('disputed','won') ORDER BY rowid DESC LIMIT 1),'won')='disputed')))))
 AND json_array_length(NEW.stock)=json_array_length(c.target,'$.stockTargets')
 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.stock) s WHERE NOT EXISTS(SELECT 1 FROM json_each(c.target,'$.stockTargets') t
   WHERE json_extract(s.value,'$.targetType')=json_extract(t.value,'$.type') AND json_extract(s.value,'$.targetId')=json_extract(t.value,'$.id')
   AND json_type(s.value,'$.units')='integer' AND json_extract(s.value,'$.units')=json_extract(t.value,'$.units')*NEW.quantity AND json_extract(s.value,'$.units') BETWEEN 1 AND 1000000
   AND json_type(s.value,'$.expectedQuantity')='integer' AND json_type(s.value,'$.expectedUpdatedSeconds')='integer'))
 AND json_array_length(NEW.stock)=(SELECT count(DISTINCT json_extract(value,'$.targetType')||':'||json_extract(value,'$.targetId')) FROM json_each(NEW.stock)))
BEGIN SELECT RAISE(ABORT,'Recovery quantity, version, payment or stock mapping changed'); END;
--> statement-breakpoint
DROP TRIGGER `_ecommerce_recovery_refund_guard`;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_refund_guard` BEFORE INSERT ON `_ecommerce_return_refund_decisions`
WHEN EXISTS(SELECT 1 FROM _ecommerce_recovery_cases c WHERE c.receipt_id=NEW.receipt_id
 AND (COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),'open')='open' OR EXISTS(SELECT 1 FROM _ecommerce_recovery_shipments WHERE case_id=c.id))
 AND NOT (COALESCE(json_extract(c.target,'$.adjustmentMinor'),0)<0 AND NEW.status IN ('needed','settled') AND NEW.amount_minor=-COALESCE(json_extract(c.target,'$.adjustmentMinor'),0))
 AND NEW.status<>'not_needed')
 OR (NEW.status='not_needed' AND EXISTS(SELECT 1 FROM _ecommerce_recovery_cases c WHERE c.receipt_id=NEW.receipt_id AND COALESCE(json_extract(c.target,'$.adjustmentMinor'),0)<0 AND EXISTS(SELECT 1 FROM _ecommerce_recovery_shipments WHERE case_id=c.id)))
BEGIN SELECT RAISE(ABORT,'Refund follow-up conflicts with the exchange amount'); END;
--> statement-breakpoint
DROP TRIGGER `_ecommerce_recovery_erasure_guard`;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_erasure_guard` BEFORE INSERT ON `_ecommerce_shopper_audits`
WHEN NEW.action='anonymize' AND EXISTS(SELECT 1 FROM _ecommerce_recovery_cases c JOIN _ecommerce_orders o ON o.id=c.order_id WHERE o.user_id=NEW.account_id AND COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),'open')='open') OR (NEW.action='anonymize' AND EXISTS(SELECT 1 FROM _ecommerce_recovery_receipts r JOIN _ecommerce_recovery_shipments s ON s.id=r.shipment_id JOIN _ecommerce_recovery_cases c ON c.id=s.case_id JOIN _ecommerce_orders o ON o.id=c.order_id WHERE o.user_id=NEW.account_id AND r.quantity>COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_inspections WHERE receipt_id=r.id),0)))
 OR (NEW.action='anonymize' AND EXISTS(SELECT 1 FROM _ecommerce_recovery_cases c JOIN _ecommerce_orders o ON o.id=c.order_id WHERE o.user_id=NEW.account_id AND (COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=c.id AND actor='payment_provider'),0)>COALESCE((SELECT max(rowid) FROM _ecommerce_recovery_events WHERE case_id=c.id AND kind='resolve'),0))))
BEGIN SELECT RAISE(ABORT,'Recovery cases must be resolved before shopper erasure'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_receipt_guard` BEFORE INSERT ON `_ecommerce_recovery_receipts`
WHEN NEW.redacted_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_shipments s JOIN _ecommerce_recovery_cases c ON c.id=s.case_id WHERE s.id=NEW.shipment_id AND s.redacted_at IS NULL AND c.redacted_at IS NULL
 AND NEW.quantity+COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_receipts WHERE shipment_id=s.id),0)<=s.quantity)
 OR (SELECT count(*) FROM _ecommerce_recovery_receipts WHERE shipment_id=NEW.shipment_id)>=100
BEGIN SELECT RAISE(ABORT,'Recovery returned quantity changed'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_inspection_guard` BEFORE INSERT ON `_ecommerce_recovery_inspections`
WHEN NEW.redacted_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_receipts r JOIN _ecommerce_recovery_shipments s ON s.id=r.shipment_id JOIN _ecommerce_recovery_cases c ON c.id=s.case_id WHERE r.id=NEW.receipt_id AND r.redacted_at IS NULL AND c.redacted_at IS NULL
 AND NEW.quantity+COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_inspections WHERE receipt_id=r.id),0)<=r.quantity
 AND (NEW.restock=0 OR (json_array_length(NEW.stock)=json_array_length(c.target,'$.stockTargets')
 AND json_array_length(NEW.stock)=(SELECT count(DISTINCT json_extract(value,'$.targetType')||':'||json_extract(value,'$.targetId')) FROM json_each(NEW.stock))
 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.stock) v WHERE NOT EXISTS(SELECT 1 FROM json_each(c.target,'$.stockTargets') t WHERE json_extract(v.value,'$.targetType')=json_extract(t.value,'$.type') AND json_extract(v.value,'$.targetId')=json_extract(t.value,'$.id')
 AND json_extract(v.value,'$.units')=json_extract(t.value,'$.units')*NEW.quantity AND json_type(v.value,'$.units')='integer' AND json_extract(v.value,'$.units') BETWEEN 1 AND 1000000
 AND json_type(v.value,'$.expectedQuantity')='integer' AND json_type(v.value,'$.expectedUpdatedSeconds')='integer')))))
 OR (SELECT count(*) FROM _ecommerce_recovery_inspections WHERE receipt_id=NEW.receipt_id)>=100
BEGIN SELECT RAISE(ABORT,'Recovery inspection or stock mapping changed'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_inspection_apply` AFTER INSERT ON `_ecommerce_recovery_inspections` WHEN NEW.restock=1 BEGIN
 INSERT INTO _ecommerce_stock_movements (id,target_type,target_id,kind,delta,before_quantity,after_quantity,expected_updated_at,actor,reason,fingerprint,created_at)
 SELECT NEW.id||'_'||s.key,json_extract(s.value,'$.targetType'),json_extract(s.value,'$.targetId'),'receipt',json_extract(s.value,'$.units'),json_extract(s.value,'$.expectedQuantity'),json_extract(s.value,'$.expectedQuantity')+json_extract(s.value,'$.units'),json_extract(s.value,'$.expectedUpdatedSeconds'),NEW.actor,'Replacement inspection '||NEW.id,NEW.fingerprint,NEW.created_at FROM json_each(NEW.stock) s;
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_payment_guard` BEFORE INSERT ON `_ecommerce_recovery_payments`
WHEN NEW.redacted_at IS NOT NULL OR NEW.provider<>'stripe' OR EXISTS(SELECT 1 FROM _ecommerce_orders WHERE payment_intent_id=NEW.payment_id) OR EXISTS(SELECT 1 FROM _ecommerce_gift_card_purchases WHERE payment_intent_id=NEW.payment_id) OR NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_cases c JOIN _ecommerce_orders o ON o.id=c.order_id WHERE c.id=NEW.case_id AND c.redacted_at IS NULL AND c.kind='exchange' AND o.status='paid'
 AND NEW.expected_version=COALESCE((SELECT id FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),c.id)
 AND COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),'open')='open'
 AND COALESCE(json_extract(c.target,'$.adjustmentMinor'),0)>0 AND NEW.amount_minor=COALESCE(json_extract(c.target,'$.adjustmentMinor'),0) AND NEW.currency=o.currency)
 OR (SELECT count(*) FROM _ecommerce_recovery_payments WHERE case_id=NEW.case_id)>=100
BEGIN SELECT RAISE(ABORT,'Recovery payment or version changed'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_payment_apply` AFTER INSERT ON `_ecommerce_recovery_payments` BEGIN
 INSERT INTO _ecommerce_recovery_events(id,case_id,expected_version,kind,status,actor,reason,fingerprint,created_at) VALUES(NEW.id,NEW.case_id,NEW.expected_version,'note','open',NEW.actor,'Exchange upgrade payment verified',NEW.fingerprint,NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_shipment_email` AFTER INSERT ON `_ecommerce_recovery_shipments` BEGIN
 INSERT INTO _ecommerce_email_deliveries(id,kind,subject_id,status,attempts,next_attempt_at,created_at) VALUES('recovery_shipment:'||NEW.id,'recovery_shipment',NEW.id,'pending',0,NEW.created_at,NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_tracking_email` AFTER INSERT ON `_ecommerce_recovery_events` WHEN NEW.kind='tracking' BEGIN
 INSERT INTO _ecommerce_email_deliveries(id,kind,subject_id,status,attempts,next_attempt_at,created_at) VALUES('recovery_tracking:'||NEW.id,'recovery_tracking',NEW.id,'pending',0,NEW.created_at,NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_received_email` AFTER INSERT ON `_ecommerce_recovery_receipts` BEGIN
 INSERT INTO _ecommerce_email_deliveries(id,kind,subject_id,status,attempts,next_attempt_at,created_at) VALUES('recovery_received:'||NEW.id,'recovery_received',NEW.id,'pending',0,NEW.created_at,NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_receipts_immutable_update` BEFORE UPDATE ON `_ecommerce_recovery_receipts` WHEN NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL AND NEW.reason='[redacted]' AND NEW.id IS OLD.id AND NEW.shipment_id IS OLD.shipment_id AND NEW.quantity IS OLD.quantity AND NEW.actor IS OLD.actor AND NEW.fingerprint IS OLD.fingerprint AND NEW.created_at IS OLD.created_at AND EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a JOIN _ecommerce_orders o ON o.user_id=a.account_id WHERE a.action='anonymize' AND o.id=(SELECT c.order_id FROM _ecommerce_recovery_shipments s JOIN _ecommerce_recovery_cases c ON c.id=s.case_id WHERE s.id=OLD.shipment_id))) BEGIN SELECT RAISE(ABORT,'Recovery history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_receipts_immutable_delete` BEFORE DELETE ON `_ecommerce_recovery_receipts` BEGIN SELECT RAISE(ABORT,'Recovery history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_inspections_immutable_update` BEFORE UPDATE ON `_ecommerce_recovery_inspections` WHEN NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL AND NEW.reason='[redacted]' AND NEW.id IS OLD.id AND NEW.receipt_id IS OLD.receipt_id AND NEW.quantity IS OLD.quantity AND NEW.disposition IS OLD.disposition AND NEW.restock IS OLD.restock AND NEW.stock IS OLD.stock AND NEW.actor IS OLD.actor AND NEW.fingerprint IS OLD.fingerprint AND NEW.created_at IS OLD.created_at AND EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a JOIN _ecommerce_orders o ON o.user_id=a.account_id WHERE a.action='anonymize' AND o.id=(SELECT c.order_id FROM _ecommerce_recovery_receipts r JOIN _ecommerce_recovery_shipments s ON s.id=r.shipment_id JOIN _ecommerce_recovery_cases c ON c.id=s.case_id WHERE r.id=OLD.receipt_id))) BEGIN SELECT RAISE(ABORT,'Recovery history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_inspections_immutable_delete` BEFORE DELETE ON `_ecommerce_recovery_inspections` BEGIN SELECT RAISE(ABORT,'Recovery history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_payments_immutable_update` BEFORE UPDATE ON `_ecommerce_recovery_payments` WHEN NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL AND NEW.reason='[redacted]' AND NEW.id IS OLD.id AND NEW.case_id IS OLD.case_id AND NEW.expected_version IS OLD.expected_version AND NEW.provider IS OLD.provider AND NEW.payment_id IS OLD.payment_id AND NEW.amount_minor IS OLD.amount_minor AND NEW.currency IS OLD.currency AND NEW.actor IS OLD.actor AND NEW.fingerprint IS OLD.fingerprint AND NEW.created_at IS OLD.created_at AND EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a JOIN _ecommerce_orders o ON o.user_id=a.account_id WHERE a.action='anonymize' AND o.id=(SELECT order_id FROM _ecommerce_recovery_cases WHERE id=OLD.case_id))) BEGIN SELECT RAISE(ABORT,'Recovery history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_payments_immutable_delete` BEFORE DELETE ON `_ecommerce_recovery_payments` BEGIN SELECT RAISE(ABORT,'Recovery history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_payment_events_immutable_update` BEFORE UPDATE ON `_ecommerce_recovery_payment_events` BEGIN SELECT RAISE(ABORT,'Recovery payment history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_payment_events_immutable_delete` BEFORE DELETE ON `_ecommerce_recovery_payment_events` BEGIN SELECT RAISE(ABORT,'Recovery payment history is immutable'); END;

--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_payment_event_apply` AFTER INSERT ON `_ecommerce_recovery_payment_events` BEGIN
 INSERT INTO _ecommerce_recovery_events(id,case_id,expected_version,kind,status,actor,reason,fingerprint,created_at)
 SELECT 'rcpe_'||NEW.id,c.id,COALESCE((SELECT id FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),c.id),'note',COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),'open'),'payment_provider','Exchange payment review required',NEW.id,NEW.created_at FROM _ecommerce_recovery_payments p JOIN _ecommerce_recovery_cases c ON c.id=p.case_id WHERE p.id=NEW.payment_id AND c.redacted_at IS NULL;
END;
