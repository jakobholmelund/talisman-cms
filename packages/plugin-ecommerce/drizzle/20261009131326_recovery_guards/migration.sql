CREATE TRIGGER `_ecommerce_recovery_case_guard` BEFORE INSERT ON `_ecommerce_recovery_cases`
WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_orders o WHERE o.id=NEW.order_id AND o.status='paid' AND COALESCE(o.payment_provider,'stripe')<>'admin_test'
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
  AND COALESCE((SELECT status FROM _ecommerce_return_refund_decisions WHERE receipt_id=r.id ORDER BY rowid DESC LIMIT 1),'review')='not_needed'
  AND NEW.quantity+COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_cases WHERE receipt_id=r.id AND line_index=NEW.line_index),0)<=CASE WHEN json_extract(i.value,'$.condition')='inspection' THEN COALESCE((SELECT sum(json_extract(j.value,'$.quantity')) FROM _ecommerce_return_inspections d,json_each(d.items) j WHERE d.receipt_id=r.id AND json_extract(j.value,'$.lineIndex')=NEW.line_index),0) ELSE json_extract(i.value,'$.quantity') END
  AND json_extract(NEW.target,'$.priceAtPurchase')=json_extract(o.items,'$['||NEW.line_index||'].priceAtPurchase')))
 OR (NEW.kind='exchange' AND NOT EXISTS(SELECT 1 FROM _ecommerce_products p WHERE p.id=json_extract(NEW.target,'$.productId') AND p.status='active' AND p.type='standard' AND p.is_physical=1
  AND json_extract(NEW.target,'$.priceAtPurchase')=CASE WHEN json_extract(NEW.target,'$.variantId') IS NULL THEN CASE WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_product_variants WHERE product_id=p.id) THEN p.base_price END
  ELSE COALESCE((SELECT COALESCE(v.price_override,g.price_override,p.base_price) FROM _ecommerce_product_variant_values v JOIN _ecommerce_product_variants g ON g.id=v.product_variant_id WHERE v.id=json_extract(NEW.target,'$.variantId') AND g.product_id=p.id),
   (SELECT COALESCE(g.price_override,p.base_price) FROM _ecommerce_product_variants g WHERE g.id=json_extract(NEW.target,'$.variantId') AND g.product_id=p.id AND NOT EXISTS(SELECT 1 FROM _ecommerce_product_variant_values WHERE product_variant_id=g.id))) END))
BEGIN SELECT RAISE(ABORT,'Recovery source, inspected units, equal price or payment changed'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_event_guard` BEFORE INSERT ON `_ecommerce_recovery_events`
WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_cases WHERE id=NEW.case_id AND redacted_at IS NULL)
 OR NEW.redacted_at IS NOT NULL
 OR (SELECT count(*) FROM _ecommerce_recovery_events WHERE case_id=NEW.case_id)>=1000
 OR NEW.expected_version IS NOT COALESCE((SELECT id FROM _ecommerce_recovery_events WHERE case_id=NEW.case_id ORDER BY rowid DESC LIMIT 1),NEW.case_id)
 OR (NEW.kind='resolve' AND (NEW.status<>'resolved' OR COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=NEW.case_id ORDER BY rowid DESC LIMIT 1),'open')<>'open'))
 OR (NEW.kind='reopen' AND (NEW.status<>'open' OR COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=NEW.case_id ORDER BY rowid DESC LIMIT 1),'open')<>'resolved'))
 OR (NEW.kind IN ('note','tracking') AND NEW.status IS NOT COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=NEW.case_id ORDER BY rowid DESC LIMIT 1),'open'))
 OR (NEW.kind='shipment' AND NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_shipments WHERE id=NEW.shipment_id AND id=NEW.id AND case_id=NEW.case_id AND NEW.status='open' AND expected_version=NEW.expected_version AND fingerprint=NEW.fingerprint))
 OR (NEW.kind='tracking' AND NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_shipments WHERE id=NEW.shipment_id AND case_id=NEW.case_id))
 OR (NEW.kind='reopen' AND NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_cases c JOIN _ecommerce_orders o ON o.id=c.order_id WHERE c.id=NEW.case_id AND o.status='paid'
  AND (c.kind<>'exchange' OR COALESCE((SELECT status FROM _ecommerce_return_refund_decisions WHERE receipt_id=c.receipt_id ORDER BY rowid DESC LIMIT 1),'review')='not_needed')))
BEGIN SELECT RAISE(ABORT,'Recovery version or transition changed'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_shipment_guard` BEFORE INSERT ON `_ecommerce_recovery_shipments`
WHEN NEW.redacted_at IS NOT NULL OR (SELECT count(*) FROM _ecommerce_recovery_shipments WHERE case_id=NEW.case_id)>=100 OR NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_cases c JOIN _ecommerce_orders o ON o.id=c.order_id WHERE c.id=NEW.case_id AND c.redacted_at IS NULL AND o.status='paid' AND o.shipping_address IS NOT NULL
 AND COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),'open')='open'
 AND NEW.expected_version=COALESCE((SELECT id FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),c.id)
 AND NEW.quantity+COALESCE((SELECT sum(quantity) FROM _ecommerce_recovery_shipments WHERE case_id=c.id),0)<=c.quantity
 AND (c.kind<>'exchange' OR COALESCE((SELECT status FROM _ecommerce_return_refund_decisions WHERE receipt_id=c.receipt_id ORDER BY rowid DESC LIMIT 1),'review')='not_needed')
 AND json_array_length(NEW.stock)=json_array_length(c.target,'$.stockTargets')
 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.stock) s WHERE NOT EXISTS(SELECT 1 FROM json_each(c.target,'$.stockTargets') t
   WHERE json_extract(s.value,'$.targetType')=json_extract(t.value,'$.type') AND json_extract(s.value,'$.targetId')=json_extract(t.value,'$.id')
   AND json_type(s.value,'$.units')='integer' AND json_extract(s.value,'$.units')=json_extract(t.value,'$.units')*NEW.quantity AND json_extract(s.value,'$.units') BETWEEN 1 AND 1000000
   AND json_type(s.value,'$.expectedQuantity')='integer' AND json_type(s.value,'$.expectedUpdatedSeconds')='integer'))
 AND json_array_length(NEW.stock)=(SELECT count(DISTINCT json_extract(value,'$.targetType')||':'||json_extract(value,'$.targetId')) FROM json_each(NEW.stock)))
BEGIN SELECT RAISE(ABORT,'Recovery quantity, version, payment or stock mapping changed'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_shipment_apply` AFTER INSERT ON `_ecommerce_recovery_shipments` BEGIN
 INSERT INTO _ecommerce_stock_movements (id,target_type,target_id,kind,delta,before_quantity,after_quantity,expected_updated_at,actor,reason,fingerprint,created_at)
 SELECT NEW.id||'_'||s.key,json_extract(s.value,'$.targetType'),json_extract(s.value,'$.targetId'),'correction',-json_extract(s.value,'$.units'),json_extract(s.value,'$.expectedQuantity'),json_extract(s.value,'$.expectedQuantity')-json_extract(s.value,'$.units'),json_extract(s.value,'$.expectedUpdatedSeconds'),NEW.actor,'Replacement shipment '||NEW.id,NEW.fingerprint,NEW.created_at FROM json_each(NEW.stock) s;
 INSERT INTO _ecommerce_recovery_events (id,case_id,expected_version,kind,status,shipment_id,carrier,tracking_number,actor,reason,fingerprint,created_at)
 VALUES (NEW.id,NEW.case_id,NEW.expected_version,'shipment','open',NEW.id,NEW.carrier,NEW.tracking_number,NEW.actor,NEW.reason,NEW.fingerprint,NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_refund_guard` BEFORE INSERT ON `_ecommerce_return_refund_decisions`
WHEN NEW.status<>'not_needed' AND EXISTS(SELECT 1 FROM _ecommerce_recovery_cases c WHERE c.receipt_id=NEW.receipt_id AND (COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),'open')='open' OR EXISTS(SELECT 1 FROM _ecommerce_recovery_shipments WHERE case_id=c.id)))
BEGIN SELECT RAISE(ABORT,'Refund follow-up has an active or shipped exchange'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_erasure_guard` BEFORE INSERT ON `_ecommerce_shopper_audits`
WHEN NEW.action='anonymize' AND EXISTS(SELECT 1 FROM _ecommerce_recovery_cases c JOIN _ecommerce_orders o ON o.id=c.order_id WHERE o.user_id=NEW.account_id AND COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),'open')='open')
BEGIN SELECT RAISE(ABORT,'Recovery cases must be resolved before shopper erasure'); END;

--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_cases_immutable_update` BEFORE UPDATE ON `_ecommerce_recovery_cases` WHEN NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL AND NEW.reason='[redacted]' AND NEW.id IS OLD.id AND NEW.order_id IS OLD.order_id AND NEW.kind IS OLD.kind AND NEW.fulfillment_id IS OLD.fulfillment_id AND NEW.source_shipment_id IS OLD.source_shipment_id AND NEW.receipt_id IS OLD.receipt_id AND NEW.line_index IS OLD.line_index AND NEW.quantity IS OLD.quantity AND NEW.target IS OLD.target AND NEW.actor IS OLD.actor AND NEW.fingerprint IS OLD.fingerprint AND NEW.created_at IS OLD.created_at AND EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a JOIN _ecommerce_orders o ON o.user_id=a.account_id WHERE a.action='anonymize' AND o.id=OLD.order_id)) BEGIN SELECT RAISE(ABORT,'Recovery history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_cases_immutable_delete` BEFORE DELETE ON `_ecommerce_recovery_cases` BEGIN SELECT RAISE(ABORT,'Recovery history is immutable'); END;

--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_shipments_immutable_update` BEFORE UPDATE ON `_ecommerce_recovery_shipments` WHEN NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL AND NEW.reason='[redacted]' AND NEW.id IS OLD.id AND NEW.case_id IS OLD.case_id AND NEW.expected_version IS OLD.expected_version AND NEW.quantity IS OLD.quantity AND NEW.stock IS OLD.stock AND NEW.carrier IS OLD.carrier AND NEW.tracking_number IS OLD.tracking_number AND NEW.actor IS OLD.actor AND NEW.fingerprint IS OLD.fingerprint AND NEW.created_at IS OLD.created_at AND EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a JOIN _ecommerce_orders o ON o.user_id=a.account_id WHERE a.action='anonymize' AND o.id=(SELECT order_id FROM _ecommerce_recovery_cases WHERE id=OLD.case_id))) BEGIN SELECT RAISE(ABORT,'Recovery history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_shipments_immutable_delete` BEFORE DELETE ON `_ecommerce_recovery_shipments` BEGIN SELECT RAISE(ABORT,'Recovery history is immutable'); END;

--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_events_immutable_update` BEFORE UPDATE ON `_ecommerce_recovery_events` WHEN NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL AND NEW.reason='[redacted]' AND NEW.id IS OLD.id AND NEW.case_id IS OLD.case_id AND NEW.expected_version IS OLD.expected_version AND NEW.kind IS OLD.kind AND NEW.status IS OLD.status AND NEW.shipment_id IS OLD.shipment_id AND NEW.carrier IS OLD.carrier AND NEW.tracking_number IS OLD.tracking_number AND NEW.actor IS OLD.actor AND NEW.fingerprint IS OLD.fingerprint AND NEW.created_at IS OLD.created_at AND EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a JOIN _ecommerce_orders o ON o.user_id=a.account_id WHERE a.action='anonymize' AND o.id=(SELECT order_id FROM _ecommerce_recovery_cases WHERE id=OLD.case_id))) BEGIN SELECT RAISE(ABORT,'Recovery history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_recovery_events_immutable_delete` BEFORE DELETE ON `_ecommerce_recovery_events` BEGIN SELECT RAISE(ABORT,'Recovery history is immutable'); END;
