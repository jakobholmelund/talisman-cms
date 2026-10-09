CREATE TRIGGER `_ecommerce_return_requests_immutable_delete` BEFORE DELETE ON `_ecommerce_return_requests` BEGIN SELECT RAISE(ABORT,'Return request history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_request_events_immutable_delete` BEFORE DELETE ON `_ecommerce_return_request_events` BEGIN SELECT RAISE(ABORT,'Return request history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_request_receipts_immutable_delete` BEFORE DELETE ON `_ecommerce_return_request_receipts` BEGIN SELECT RAISE(ABORT,'Return request history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_request_receipts_immutable_update` BEFORE UPDATE ON `_ecommerce_return_request_receipts` BEGIN SELECT RAISE(ABORT,'Return request history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_requests_immutable_update` BEFORE UPDATE ON `_ecommerce_return_requests`
 WHEN NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL AND NEW.id IS OLD.id AND NEW.order_id IS OLD.order_id AND NEW.items IS OLD.items AND NEW.fingerprint IS OLD.fingerprint AND NEW.created_at IS OLD.created_at AND NEW.reason='[redacted]'
 AND EXISTS (SELECT 1 FROM _ecommerce_shopper_audits a JOIN _ecommerce_orders o ON o.user_id=a.account_id
 WHERE o.id=OLD.order_id AND a.action='anonymize' AND a.created_at=NEW.redacted_at))
 BEGIN SELECT RAISE(ABORT,'Return request history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_request_events_immutable_update` BEFORE UPDATE ON `_ecommerce_return_request_events`
 WHEN NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL AND NEW.id IS OLD.id AND NEW.request_id IS OLD.request_id AND NEW.status IS OLD.status AND NEW.expected_version IS OLD.expected_version AND NEW.actor_kind IS OLD.actor_kind AND NEW.actor IS OLD.actor AND NEW.fingerprint IS OLD.fingerprint AND NEW.created_at IS OLD.created_at AND NEW.reason='[redacted]' AND NEW.customer_message=''
 AND EXISTS (SELECT 1 FROM _ecommerce_shopper_audits a JOIN _ecommerce_orders o ON o.user_id=a.account_id
 WHERE o.id=(SELECT order_id FROM _ecommerce_return_requests WHERE id=OLD.request_id) AND a.action='anonymize' AND a.created_at=NEW.redacted_at))
 BEGIN SELECT RAISE(ABORT,'Return request history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_request_quantities_guard` BEFORE INSERT ON `_ecommerce_return_requests`
 WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_orders WHERE id=NEW.order_id AND status IN ('paid','partially_refunded','refunded','disputed') AND COALESCE(payment_provider,'stripe')<>'admin_test')
 OR EXISTS(SELECT 1 FROM _ecommerce_orders o JOIN _ecommerce_shopper_audits a ON a.account_id=o.user_id WHERE o.id=NEW.order_id AND a.action='anonymize')
 OR (SELECT count(*) FROM _ecommerce_return_requests WHERE order_id=NEW.order_id)>=100
 OR EXISTS(SELECT 1 FROM _ecommerce_fulfillments f WHERE f.order_id=NEW.order_id AND f.kind='shipment' AND NOT EXISTS(SELECT 1 FROM _ecommerce_parcel_contents p WHERE p.fulfillment_id=f.id))
 OR EXISTS(SELECT 1 FROM json_each(NEW.items) i WHERE COALESCE(json_type(i.value,'$.lineIndex'),'')<>'integer' OR json_extract(i.value,'$.lineIndex')<0 OR COALESCE(json_type(i.value,'$.quantity'),'')<>'integer' OR json_extract(i.value,'$.quantity') NOT BETWEEN 1 AND 1000000
 OR json_extract(i.value,'$.quantity')>COALESCE((SELECT sum(json_extract(p.value,'$.quantity')) FROM _ecommerce_parcel_contents x,json_each(x.items) p WHERE x.order_id=NEW.order_id AND json_extract(p.value,'$.lineIndex')=json_extract(i.value,'$.lineIndex')),0)
 -COALESCE((SELECT sum(json_extract(p.value,'$.quantity')) FROM _ecommerce_return_receipts x,json_each(x.items) p WHERE x.order_id=NEW.order_id AND json_extract(p.value,'$.lineIndex')=json_extract(i.value,'$.lineIndex')),0)
 -COALESCE((SELECT sum(MAX(0,json_extract(p.value,'$.quantity')-COALESCE((SELECT sum(json_extract(a.value,'$.quantity')) FROM _ecommerce_return_request_receipts l JOIN _ecommerce_return_receipts y ON y.id=l.receipt_id,json_each(y.items) a WHERE l.request_id=x.id AND json_extract(a.value,'$.lineIndex')=json_extract(p.value,'$.lineIndex')),0)))
 FROM _ecommerce_return_requests x,json_each(x.items) p WHERE x.order_id=NEW.order_id AND x.id<>NEW.id AND COALESCE((SELECT status FROM _ecommerce_return_request_events e WHERE e.request_id=x.id ORDER BY rowid DESC LIMIT 1),'pending') IN ('pending','approved') AND json_extract(p.value,'$.lineIndex')=json_extract(i.value,'$.lineIndex')),0))
 OR EXISTS(SELECT 1 FROM json_each(NEW.items) GROUP BY json_extract(value,'$.lineIndex') HAVING count(*)>1)
 BEGIN SELECT RAISE(ABORT,'Return request exceeds available shipped goods'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_request_decision_guard` BEFORE INSERT ON `_ecommerce_return_request_events`
 WHEN NEW.expected_version<>COALESCE((SELECT id FROM _ecommerce_return_request_events WHERE request_id=NEW.request_id ORDER BY rowid DESC LIMIT 1),NEW.request_id)
 OR NOT EXISTS(SELECT 1 FROM _ecommerce_return_requests WHERE id=NEW.request_id AND redacted_at IS NULL)
 OR NOT (
 (NEW.actor_kind='staff' AND NEW.status IN ('approved','declined') AND length(trim(NEW.customer_message))>=8 AND COALESCE((SELECT status FROM _ecommerce_return_request_events WHERE request_id=NEW.request_id ORDER BY rowid DESC LIMIT 1),'pending')='pending')
 OR (NEW.actor_kind='staff' AND NEW.status='closed' AND length(trim(NEW.customer_message))>=8 AND (SELECT status FROM _ecommerce_return_request_events WHERE request_id=NEW.request_id ORDER BY rowid DESC LIMIT 1)='approved')
 OR (NEW.actor_kind='customer' AND NEW.status='cancelled' AND COALESCE((SELECT status FROM _ecommerce_return_request_events WHERE request_id=NEW.request_id ORDER BY rowid DESC LIMIT 1),'pending') IN ('pending','approved') AND NOT EXISTS(SELECT 1 FROM _ecommerce_return_request_receipts WHERE request_id=NEW.request_id)))
 BEGIN SELECT RAISE(ABORT,'Return request decision is stale or unavailable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_request_approval_guard` BEFORE INSERT ON `_ecommerce_return_request_events`
 WHEN NEW.status='approved' AND EXISTS(SELECT 1 FROM _ecommerce_return_requests r,json_each(r.items) i WHERE r.id=NEW.request_id AND json_extract(i.value,'$.quantity')>COALESCE((SELECT sum(json_extract(p.value,'$.quantity')) FROM _ecommerce_parcel_contents x,json_each(x.items) p WHERE x.order_id=r.order_id AND json_extract(p.value,'$.lineIndex')=json_extract(i.value,'$.lineIndex')),0)
 -COALESCE((SELECT sum(json_extract(p.value,'$.quantity')) FROM _ecommerce_return_receipts x,json_each(x.items) p WHERE x.order_id=r.order_id AND json_extract(p.value,'$.lineIndex')=json_extract(i.value,'$.lineIndex')),0)
 -COALESCE((SELECT sum(MAX(0,json_extract(p.value,'$.quantity')-COALESCE((SELECT sum(json_extract(a.value,'$.quantity')) FROM _ecommerce_return_request_receipts l JOIN _ecommerce_return_receipts y ON y.id=l.receipt_id,json_each(y.items) a WHERE l.request_id=x.id AND json_extract(a.value,'$.lineIndex')=json_extract(p.value,'$.lineIndex')),0)))
 FROM _ecommerce_return_requests x,json_each(x.items) p WHERE x.order_id=r.order_id AND x.id<>r.id AND COALESCE((SELECT status FROM _ecommerce_return_request_events e WHERE e.request_id=x.id ORDER BY rowid DESC LIMIT 1),'pending') IN ('pending','approved') AND json_extract(p.value,'$.lineIndex')=json_extract(i.value,'$.lineIndex')),0))
 BEGIN SELECT RAISE(ABORT,'Requested goods were already received'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_request_receipt_guard` BEFORE INSERT ON `_ecommerce_return_request_receipts`
 WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_return_requests r JOIN _ecommerce_return_receipts x ON x.order_id=r.order_id WHERE r.id=NEW.request_id AND x.id=NEW.receipt_id AND (SELECT status FROM _ecommerce_return_request_events WHERE request_id=r.id ORDER BY rowid DESC LIMIT 1)='approved')
 OR EXISTS(SELECT 1 FROM _ecommerce_return_receipts x,json_each(x.items) i WHERE x.id=NEW.receipt_id AND json_extract(i.value,'$.quantity')+COALESCE((SELECT sum(json_extract(a.value,'$.quantity')) FROM _ecommerce_return_request_receipts l JOIN _ecommerce_return_receipts y ON y.id=l.receipt_id,json_each(y.items) a WHERE l.request_id=NEW.request_id AND json_extract(a.value,'$.lineIndex')=json_extract(i.value,'$.lineIndex')),0)>COALESCE((SELECT json_extract(p.value,'$.quantity') FROM _ecommerce_return_requests r,json_each(r.items) p WHERE r.id=NEW.request_id AND json_extract(p.value,'$.lineIndex')=json_extract(i.value,'$.lineIndex')),0))
 BEGIN SELECT RAISE(ABORT,'Return receipt exceeds approved request'); END;
