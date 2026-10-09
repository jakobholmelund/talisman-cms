CREATE TRIGGER `_ecommerce_supplier_issues_immutable_update` BEFORE UPDATE ON `_ecommerce_supplier_issues` BEGIN SELECT RAISE(ABORT,'Supplier issue history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_supplier_issues_immutable_delete` BEFORE DELETE ON `_ecommerce_supplier_issues` BEGIN SELECT RAISE(ABORT,'Supplier issue history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_supplier_issue_events_immutable_update` BEFORE UPDATE ON `_ecommerce_supplier_issue_events` BEGIN SELECT RAISE(ABORT,'Supplier issue history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_supplier_issue_events_immutable_delete` BEFORE DELETE ON `_ecommerce_supplier_issue_events` BEGIN SELECT RAISE(ABORT,'Supplier issue history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_supplier_issue_report_guard` BEFORE INSERT ON `_ecommerce_supplier_issues`
WHEN NOT EXISTS (
 SELECT 1 FROM _ecommerce_purchase_order_lines l JOIN _ecommerce_replenishment_deliveries d ON d.id=l.delivery_id
 JOIN _ecommerce_purchase_order_events p ON p.id=NEW.expected_purchase_version
 WHERE l.id=NEW.purchase_line_id AND p.purchase_order_id=l.purchase_order_id AND p.status='ordered'
 AND p.rowid=(SELECT rowid FROM _ecommerce_purchase_order_events WHERE purchase_order_id=l.purchase_order_id ORDER BY rowid DESC LIMIT 1)
 AND NEW.expected_delivery_version=COALESCE((SELECT id FROM _ecommerce_replenishment_delivery_events WHERE delivery_id=d.id ORDER BY rowid DESC LIMIT 1),d.id)
 AND NOT EXISTS(SELECT 1 FROM _ecommerce_replenishment_delivery_events WHERE delivery_id=d.id AND kind='cancelled')
 AND NEW.quantity<=d.quantity-COALESCE((SELECT sum(m.delta) FROM _ecommerce_replenishment_delivery_events e JOIN _ecommerce_stock_movements m ON m.id=e.movement_id WHERE e.delivery_id=d.id),0)
   -COALESCE((SELECT sum(i.quantity) FROM _ecommerce_supplier_issues i WHERE i.purchase_line_id=l.id
     AND COALESCE((SELECT status FROM _ecommerce_supplier_issue_events WHERE issue_id=i.id ORDER BY rowid DESC LIMIT 1),'open')='open'),0)
) BEGIN SELECT RAISE(ABORT,'Supplier issue purchase or delivery changed, or reported units exceed outstanding supply'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_supplier_issue_event_guard` BEFORE INSERT ON `_ecommerce_supplier_issue_events`
WHEN NEW.expected_version IS NOT COALESCE((SELECT id FROM _ecommerce_supplier_issue_events WHERE issue_id=NEW.issue_id ORDER BY rowid DESC LIMIT 1),NEW.issue_id)
 OR NOT EXISTS(SELECT 1 FROM _ecommerce_supplier_issues WHERE id=NEW.issue_id)
 OR (NEW.status='resolved' AND COALESCE((SELECT status FROM _ecommerce_supplier_issue_events WHERE issue_id=NEW.issue_id ORDER BY rowid DESC LIMIT 1),'open')='resolved')
BEGIN SELECT RAISE(ABORT,'Supplier issue changed or is already resolved'); END;
