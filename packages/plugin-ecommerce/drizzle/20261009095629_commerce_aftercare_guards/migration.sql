CREATE TRIGGER `_ecommerce_replenishment_policies_immutable_delete` BEFORE DELETE ON `_ecommerce_replenishment_policies` BEGIN SELECT RAISE(ABORT,'Aftercare history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_replenishment_policies_immutable_update` BEFORE UPDATE ON `_ecommerce_replenishment_policies` BEGIN SELECT RAISE(ABORT,'Aftercare history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_replenishment_deliveries_immutable_delete` BEFORE DELETE ON `_ecommerce_replenishment_deliveries` BEGIN SELECT RAISE(ABORT,'Aftercare history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_replenishment_deliveries_immutable_update` BEFORE UPDATE ON `_ecommerce_replenishment_deliveries` BEGIN SELECT RAISE(ABORT,'Aftercare history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_replenishment_delivery_events_immutable_delete` BEFORE DELETE ON `_ecommerce_replenishment_delivery_events` BEGIN SELECT RAISE(ABORT,'Aftercare history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_replenishment_delivery_events_immutable_update` BEFORE UPDATE ON `_ecommerce_replenishment_delivery_events` BEGIN SELECT RAISE(ABORT,'Aftercare history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_refund_decisions_immutable_delete` BEFORE DELETE ON `_ecommerce_return_refund_decisions` BEGIN SELECT RAISE(ABORT,'Aftercare history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_refund_decisions_immutable_update` BEFORE UPDATE ON `_ecommerce_return_refund_decisions`
 WHEN NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL AND NEW.id IS OLD.id AND NEW.receipt_id IS OLD.receipt_id AND NEW.expected_version IS OLD.expected_version AND NEW.status IS OLD.status AND NEW.amount_minor IS OLD.amount_minor AND NEW.allocations IS OLD.allocations AND NEW.actor IS OLD.actor AND NEW.fingerprint IS OLD.fingerprint AND NEW.created_at IS OLD.created_at AND NEW.reason='[redacted]'
 AND EXISTS(SELECT 1 FROM _ecommerce_shopper_audits a JOIN _ecommerce_orders o ON o.user_id=a.account_id JOIN _ecommerce_return_receipts r ON r.order_id=o.id WHERE r.id=OLD.receipt_id AND a.action='anonymize' AND a.created_at=NEW.redacted_at))
 BEGIN SELECT RAISE(ABORT,'Aftercare history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_refund_decision_guard` BEFORE INSERT ON `_ecommerce_return_refund_decisions`
 WHEN NEW.expected_version<>COALESCE((SELECT id FROM _ecommerce_return_refund_decisions WHERE receipt_id=NEW.receipt_id ORDER BY rowid DESC LIMIT 1),NEW.receipt_id)
 OR COALESCE((SELECT status FROM _ecommerce_return_refund_decisions WHERE receipt_id=NEW.receipt_id ORDER BY rowid DESC LIMIT 1),'review')='settled'
 OR NOT EXISTS(SELECT 1 FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE r.id=NEW.receipt_id AND COALESCE(o.payment_provider,'stripe')<>'admin_test' AND o.status IN ('paid','partially_refunded','refunded','disputed'))
 OR EXISTS(SELECT 1 FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id JOIN _ecommerce_shopper_audits a ON a.account_id=o.user_id WHERE r.id=NEW.receipt_id AND a.action='anonymize')
 OR NEW.amount_minor+COALESCE((SELECT sum(d.amount_minor) FROM _ecommerce_return_refund_decisions d JOIN _ecommerce_return_receipts r ON r.id=d.receipt_id WHERE r.order_id=(SELECT order_id FROM _ecommerce_return_receipts WHERE id=NEW.receipt_id) AND d.receipt_id<>NEW.receipt_id AND d.status IN ('needed','settled') AND d.rowid=(SELECT rowid FROM _ecommerce_return_refund_decisions WHERE receipt_id=d.receipt_id ORDER BY rowid DESC LIMIT 1)),0)>(SELECT o.total_amount+o.gift_card_applied+o.credit_applied FROM _ecommerce_orders o JOIN _ecommerce_return_receipts r ON r.order_id=o.id WHERE r.id=NEW.receipt_id)
 BEGIN SELECT RAISE(ABORT,'Refund follow-up is stale or unavailable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_refund_allocation_guard` BEFORE INSERT ON `_ecommerce_return_refund_decisions`
 WHEN NEW.status='settled' AND (
 COALESCE((SELECT sum(json_extract(value,'$.amountMinor')) FROM json_each(NEW.allocations)),0)<>NEW.amount_minor
 OR EXISTS(SELECT 1 FROM json_each(NEW.allocations) WHERE COALESCE(json_type(value,'$.amountMinor'),'')<>'integer' OR json_extract(value,'$.amountMinor') NOT BETWEEN 1 AND 9007199254740991 OR COALESCE(json_extract(value,'$.kind'),'') NOT IN ('provider','gift_card','store_credit') OR COALESCE(json_type(value,'$.sourceId'),'')<>'text')
 OR EXISTS(SELECT 1 FROM json_each(NEW.allocations) GROUP BY json_extract(value,'$.kind'),json_extract(value,'$.sourceId') HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM json_each(NEW.allocations) a WHERE json_extract(a.value,'$.amountMinor')>COALESCE((SELECT s.amount_cents FROM (SELECT 'provider' AS kind,id,order_id,amount_cents FROM _ecommerce_provider_refunds
 UNION ALL SELECT 'gift_card',id,order_id,amount_cents FROM _ecommerce_gift_card_ledger WHERE kind='refund_restore'
 UNION ALL SELECT 'store_credit',id,order_id,amount_cents FROM _ecommerce_credit_ledger WHERE kind='purchase_credit_refund') s WHERE s.kind=json_extract(a.value,'$.kind') AND s.id=json_extract(a.value,'$.sourceId') AND s.order_id=(SELECT order_id FROM _ecommerce_return_receipts WHERE id=NEW.receipt_id)),0)
 -COALESCE((SELECT sum(json_extract(x.value,'$.amountMinor')) FROM _ecommerce_return_refund_decisions d,json_each(d.allocations) x WHERE d.status='settled' AND json_extract(x.value,'$.kind')=json_extract(a.value,'$.kind') AND json_extract(x.value,'$.sourceId')=json_extract(a.value,'$.sourceId')),0)))
 BEGIN SELECT RAISE(ABORT,'Confirmed refunds are unavailable or already allocated'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_replenishment_policy_guard` BEFORE INSERT ON `_ecommerce_replenishment_policies`
 WHEN NOT ((NEW.target_type='product' AND EXISTS(SELECT 1 FROM _ecommerce_products WHERE id=NEW.target_id AND type='standard')) OR (NEW.target_type='variant' AND EXISTS(SELECT 1 FROM _ecommerce_product_variants v JOIN _ecommerce_products p ON p.id=v.product_id WHERE v.id=NEW.target_id AND p.type='standard')) OR (NEW.target_type='stock' AND EXISTS(SELECT 1 FROM _ecommerce_stocks WHERE id=NEW.target_id)) OR (NEW.target_type='component' AND EXISTS(SELECT 1 FROM _ecommerce_components WHERE id=NEW.target_id))) OR NEW.expected_version IS NOT (SELECT id FROM _ecommerce_replenishment_policies WHERE target_type=NEW.target_type AND target_id=NEW.target_id ORDER BY rowid DESC LIMIT 1)
 BEGIN SELECT RAISE(ABORT,'Replenishment policy is stale or unavailable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_replenishment_delivery_guard` BEFORE INSERT ON `_ecommerce_replenishment_deliveries`
 WHEN NOT ((NEW.target_type='product' AND EXISTS(SELECT 1 FROM _ecommerce_products WHERE id=NEW.target_id AND type='standard')) OR (NEW.target_type='variant' AND EXISTS(SELECT 1 FROM _ecommerce_product_variants v JOIN _ecommerce_products p ON p.id=v.product_id WHERE v.id=NEW.target_id AND p.type='standard')) OR (NEW.target_type='stock' AND EXISTS(SELECT 1 FROM _ecommerce_stocks WHERE id=NEW.target_id)) OR (NEW.target_type='component' AND EXISTS(SELECT 1 FROM _ecommerce_components WHERE id=NEW.target_id)))
 BEGIN SELECT RAISE(ABORT,'Replenishment target is unavailable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_replenishment_event_guard` BEFORE INSERT ON `_ecommerce_replenishment_delivery_events`
 WHEN NEW.expected_version<>COALESCE((SELECT id FROM _ecommerce_replenishment_delivery_events WHERE delivery_id=NEW.delivery_id ORDER BY rowid DESC LIMIT 1),NEW.delivery_id)
 OR EXISTS(SELECT 1 FROM _ecommerce_replenishment_delivery_events WHERE delivery_id=NEW.delivery_id AND kind='cancelled')
 OR NOT EXISTS(SELECT 1 FROM _ecommerce_replenishment_deliveries WHERE id=NEW.delivery_id)
 OR (NEW.kind='received' AND (NOT EXISTS(SELECT 1 FROM _ecommerce_stock_movements m JOIN _ecommerce_replenishment_deliveries d ON d.id=NEW.delivery_id WHERE m.id=NEW.movement_id AND m.kind='receipt' AND m.target_type=d.target_type AND m.target_id=d.target_id AND m.actor=NEW.actor AND m.reason=NEW.reason)
 OR (SELECT delta FROM _ecommerce_stock_movements WHERE id=NEW.movement_id)+COALESCE((SELECT sum(m.delta) FROM _ecommerce_replenishment_delivery_events e JOIN _ecommerce_stock_movements m ON m.id=e.movement_id WHERE e.delivery_id=NEW.delivery_id),0)>(SELECT quantity FROM _ecommerce_replenishment_deliveries WHERE id=NEW.delivery_id)))
 OR (NEW.kind='cancelled' AND COALESCE((SELECT sum(m.delta) FROM _ecommerce_replenishment_delivery_events e JOIN _ecommerce_stock_movements m ON m.id=e.movement_id WHERE e.delivery_id=NEW.delivery_id),0)>=(SELECT quantity FROM _ecommerce_replenishment_deliveries WHERE id=NEW.delivery_id))
 BEGIN SELECT RAISE(ABORT,'Replenishment delivery changed or exceeds outstanding units'); END;

--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_receipt_privacy_guard` BEFORE INSERT ON `_ecommerce_return_receipts`
 WHEN EXISTS(SELECT 1 FROM _ecommerce_orders o JOIN _ecommerce_shopper_audits a ON a.account_id=o.user_id WHERE o.id=NEW.order_id AND a.action='anonymize')
 BEGIN SELECT RAISE(ABORT,'Return is unavailable after shopper erasure'); END;
