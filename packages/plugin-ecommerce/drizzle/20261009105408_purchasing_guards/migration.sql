CREATE TRIGGER `_ecommerce_suppliers_immutable_update` BEFORE UPDATE ON `_ecommerce_suppliers` BEGIN SELECT RAISE(ABORT,'Purchasing history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_suppliers_immutable_delete` BEFORE DELETE ON `_ecommerce_suppliers` BEGIN SELECT RAISE(ABORT,'Purchasing history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_supplier_revisions_immutable_update` BEFORE UPDATE ON `_ecommerce_supplier_revisions` BEGIN SELECT RAISE(ABORT,'Purchasing history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_supplier_revisions_immutable_delete` BEFORE DELETE ON `_ecommerce_supplier_revisions` BEGIN SELECT RAISE(ABORT,'Purchasing history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_purchase_orders_immutable_update` BEFORE UPDATE ON `_ecommerce_purchase_orders` BEGIN SELECT RAISE(ABORT,'Purchasing history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_purchase_orders_immutable_delete` BEFORE DELETE ON `_ecommerce_purchase_orders` BEGIN SELECT RAISE(ABORT,'Purchasing history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_purchase_order_events_immutable_update` BEFORE UPDATE ON `_ecommerce_purchase_order_events` BEGIN SELECT RAISE(ABORT,'Purchasing history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_purchase_order_events_immutable_delete` BEFORE DELETE ON `_ecommerce_purchase_order_events` BEGIN SELECT RAISE(ABORT,'Purchasing history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_purchase_order_lines_immutable_update` BEFORE UPDATE ON `_ecommerce_purchase_order_lines` BEGIN SELECT RAISE(ABORT,'Purchasing history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_purchase_order_lines_immutable_delete` BEFORE DELETE ON `_ecommerce_purchase_order_lines` BEGIN SELECT RAISE(ABORT,'Purchasing history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_request_reasons_immutable_update` BEFORE UPDATE ON `_ecommerce_return_request_reasons` BEGIN SELECT RAISE(ABORT,'Purchasing history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_request_reasons_immutable_delete` BEFORE DELETE ON `_ecommerce_return_request_reasons` BEGIN SELECT RAISE(ABORT,'Purchasing history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_supplier_revision_guard` BEFORE INSERT ON `_ecommerce_supplier_revisions`
 WHEN NEW.expected_version IS NOT (SELECT id FROM _ecommerce_supplier_revisions WHERE supplier_id=NEW.supplier_id ORDER BY rowid DESC LIMIT 1)
 BEGIN SELECT RAISE(ABORT,'Purchasing supplier changed'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_purchase_order_event_guard` BEFORE INSERT ON `_ecommerce_purchase_order_events`
 WHEN NEW.expected_version IS NOT (SELECT id FROM _ecommerce_purchase_order_events WHERE purchase_order_id=NEW.purchase_order_id ORDER BY rowid DESC LIMIT 1)
 OR COALESCE((SELECT status FROM _ecommerce_purchase_order_events WHERE purchase_order_id=NEW.purchase_order_id ORDER BY rowid DESC LIMIT 1),'draft')='cancelled'
 OR (NEW.expected_version IS NULL AND NEW.status<>'draft')
 OR (NEW.status='draft' AND EXISTS(SELECT 1 FROM _ecommerce_purchase_order_lines WHERE purchase_order_id=NEW.purchase_order_id))
 OR (COALESCE((SELECT status FROM _ecommerce_purchase_order_events WHERE id=NEW.expected_version),'draft')='ordered' AND (
   NEW.status='draft' OR NEW.lines IS NOT (SELECT lines FROM _ecommerce_purchase_order_events WHERE id=NEW.expected_version)
   OR NEW.reference IS NOT (SELECT reference FROM _ecommerce_purchase_order_events WHERE id=NEW.expected_version)
   OR NEW.supplier IS NOT (SELECT supplier FROM _ecommerce_purchase_order_events WHERE id=NEW.expected_version)))
 OR (NEW.status='ordered' AND (SELECT status FROM _ecommerce_purchase_order_events WHERE id=NEW.expected_version)='draft' AND (NEW.lines IS NOT (SELECT lines FROM _ecommerce_purchase_order_events WHERE id=NEW.expected_version) OR NEW.reference IS NOT (SELECT reference FROM _ecommerce_purchase_order_events WHERE id=NEW.expected_version) OR NEW.expected_date IS NOT (SELECT expected_date FROM _ecommerce_purchase_order_events WHERE id=NEW.expected_version)))
 OR (NEW.status='ordered' AND (SELECT count(*) FROM _ecommerce_purchase_order_lines WHERE purchase_order_id=NEW.purchase_order_id)<>json_array_length(NEW.lines))
 OR (NEW.status='ordered' AND COALESCE((SELECT status FROM _ecommerce_purchase_order_events WHERE id=NEW.expected_version),'draft')='ordered' AND NOT EXISTS(
   SELECT 1 FROM _ecommerce_purchase_order_lines l JOIN _ecommerce_replenishment_deliveries d ON d.id=l.delivery_id WHERE l.purchase_order_id=NEW.purchase_order_id
   AND NOT EXISTS(SELECT 1 FROM _ecommerce_replenishment_delivery_events e WHERE e.delivery_id=d.id AND e.kind='cancelled')
   AND d.quantity>COALESCE((SELECT sum(m.delta) FROM _ecommerce_replenishment_delivery_events e JOIN _ecommerce_stock_movements m ON m.id=e.movement_id WHERE e.delivery_id=d.id),0)))
 OR (NEW.status='cancelled' AND EXISTS(SELECT 1 FROM _ecommerce_purchase_order_lines l JOIN _ecommerce_replenishment_deliveries d ON d.id=l.delivery_id WHERE l.purchase_order_id=NEW.purchase_order_id
   AND NOT EXISTS(SELECT 1 FROM _ecommerce_replenishment_delivery_events e WHERE e.delivery_id=d.id AND e.kind='cancelled')
   AND d.quantity>COALESCE((SELECT sum(m.delta) FROM _ecommerce_replenishment_delivery_events e JOIN _ecommerce_stock_movements m ON m.id=e.movement_id WHERE e.delivery_id=d.id),0)))
 OR (NEW.status IN ('draft','ordered') AND COALESCE((SELECT status FROM _ecommerce_purchase_order_events WHERE id=NEW.expected_version),'draft')='draft' AND NOT EXISTS(
   SELECT 1 FROM _ecommerce_purchase_orders p JOIN _ecommerce_supplier_revisions s ON s.supplier_id=p.supplier_id WHERE p.id=NEW.purchase_order_id AND s.active=1
   AND s.rowid=(SELECT rowid FROM _ecommerce_supplier_revisions WHERE supplier_id=s.supplier_id ORDER BY rowid DESC LIMIT 1)
   AND s.id=json_extract(NEW.supplier,'$.version') AND s.name=json_extract(NEW.supplier,'$.name') AND s.contact=json_extract(NEW.supplier,'$.contact') AND s.address=json_extract(NEW.supplier,'$.address')))
 OR EXISTS(SELECT 1 FROM json_each(NEW.lines) WHERE COALESCE(json_type(value,'$.quantity'),'')<>'integer' OR json_extract(value,'$.quantity') NOT BETWEEN 1 AND 1000000
   OR COALESCE(json_extract(value,'$.targetType'),'') NOT IN ('product','variant','stock','component') OR COALESCE(json_type(value,'$.targetId'),'')<>'text' OR COALESCE(json_type(value,'$.name'),'')<>'text')
 OR EXISTS(SELECT 1 FROM json_each(NEW.lines) GROUP BY json_extract(value,'$.targetType'),json_extract(value,'$.targetId') HAVING count(*)>1)
 BEGIN SELECT RAISE(ABORT,'Purchasing order changed or is unavailable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_purchase_order_line_guard` BEFORE INSERT ON `_ecommerce_purchase_order_lines`
 WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_purchase_order_events e JOIN _ecommerce_replenishment_deliveries d ON d.id=NEW.delivery_id
   WHERE e.purchase_order_id=NEW.purchase_order_id AND e.rowid=(SELECT rowid FROM _ecommerce_purchase_order_events WHERE purchase_order_id=NEW.purchase_order_id ORDER BY rowid DESC LIMIT 1) AND e.status='draft'
   AND d.target_type=json_extract(e.lines,'$['||NEW.line_index||'].targetType') AND d.target_id=json_extract(e.lines,'$['||NEW.line_index||'].targetId')
   AND d.quantity=json_extract(e.lines,'$['||NEW.line_index||'].quantity') AND d.reference=e.reference AND d.expected_date=e.expected_date)
 OR EXISTS(SELECT 1 FROM _ecommerce_replenishment_delivery_events WHERE delivery_id=NEW.delivery_id)
 BEGIN SELECT RAISE(ABORT,'Purchasing line differs from draft'); END;
