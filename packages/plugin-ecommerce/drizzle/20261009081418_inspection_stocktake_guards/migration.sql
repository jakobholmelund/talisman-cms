CREATE TRIGGER `_ecommerce_return_inspections_immutable_update` BEFORE UPDATE ON `_ecommerce_return_inspections` BEGIN SELECT RAISE(ABORT, 'Warehouse history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_inspections_immutable_delete` BEFORE DELETE ON `_ecommerce_return_inspections` BEGIN SELECT RAISE(ABORT, 'Warehouse history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_inspection_stock_immutable_update` BEFORE UPDATE ON `_ecommerce_inspection_stock` BEGIN SELECT RAISE(ABORT, 'Warehouse history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_inspection_stock_immutable_delete` BEFORE DELETE ON `_ecommerce_inspection_stock` BEGIN SELECT RAISE(ABORT, 'Warehouse history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_stocktakes_immutable_update` BEFORE UPDATE ON `_ecommerce_stocktakes` BEGIN SELECT RAISE(ABORT, 'Warehouse history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_stocktakes_immutable_delete` BEFORE DELETE ON `_ecommerce_stocktakes` BEGIN SELECT RAISE(ABORT, 'Warehouse history is immutable'); END;
--> statement-breakpoint
DROP TRIGGER `_ecommerce_return_stock_inventory_guard`;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_stock_inventory_guard` BEFORE INSERT ON `_ecommerce_return_stock`
 WHEN NEW.reservation_type = 'inventory' AND NOT EXISTS(SELECT 1 FROM _ecommerce_inventory_reservations r WHERE r.id = NEW.reservation_id
 AND r.order_id = NEW.order_id AND r.target_type = NEW.target_type AND r.target_id = NEW.target_id AND r.released_at IS NULL AND r.quantity >= NEW.quantity
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_return_stock WHERE reservation_type = 'inventory' AND reservation_id = r.id),0)
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_inspection_stock WHERE reservation_type = 'inventory' AND reservation_id = r.id),0)
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_restocks WHERE reservation_type = 'inventory' AND reservation_id = r.id),0))
 BEGIN SELECT RAISE(ABORT, 'Return stock exceeds the original reservation'); END;
--> statement-breakpoint
DROP TRIGGER `_ecommerce_return_stock_component_guard`;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_stock_component_guard` BEFORE INSERT ON `_ecommerce_return_stock`
 WHEN NEW.reservation_type = 'component' AND NOT EXISTS(SELECT 1 FROM _ecommerce_component_reservations r WHERE r.id = NEW.reservation_id
 AND r.order_id = NEW.order_id AND NEW.target_type = 'component' AND r.component_id = NEW.target_id AND r.released_at IS NULL AND r.quantity >= NEW.quantity
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_return_stock WHERE reservation_type = 'component' AND reservation_id = r.id),0)
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_inspection_stock WHERE reservation_type = 'component' AND reservation_id = r.id),0)
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_restocks WHERE reservation_type = 'component' AND reservation_id = r.id),0))
 BEGIN SELECT RAISE(ABORT, 'Return stock exceeds the original reservation'); END;
--> statement-breakpoint
DROP TRIGGER `_ecommerce_legacy_restock_return_guard`;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_legacy_restock_return_guard` BEFORE INSERT ON `_ecommerce_restocks`
WHEN NEW.quantity + COALESCE((SELECT sum(quantity) FROM _ecommerce_return_stock WHERE reservation_type = NEW.reservation_type AND reservation_id = NEW.reservation_id),0)
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_inspection_stock WHERE reservation_type = NEW.reservation_type AND reservation_id = NEW.reservation_id),0)
 > CASE WHEN NEW.reservation_type = 'inventory' THEN COALESCE((SELECT quantity FROM _ecommerce_inventory_reservations WHERE id = NEW.reservation_id AND order_id = NEW.order_id AND released_at IS NULL),0)
 ELSE COALESCE((SELECT quantity FROM _ecommerce_component_reservations WHERE id = NEW.reservation_id AND order_id = NEW.order_id AND released_at IS NULL),0) END
BEGIN SELECT RAISE(ABORT, 'Return stock already restored'); END;
--> statement-breakpoint
DROP TRIGGER `_ecommerce_return_stock_inventory_release`;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_stock_inventory_release` AFTER INSERT ON `_ecommerce_return_stock` WHEN NEW.reservation_type = 'inventory'
 BEGIN UPDATE _ecommerce_inventory_reservations SET released_at = (SELECT created_at FROM _ecommerce_return_receipts WHERE id = NEW.receipt_id)
 WHERE id = NEW.reservation_id AND quantity = COALESCE((SELECT sum(quantity) FROM _ecommerce_return_stock WHERE reservation_type = 'inventory' AND reservation_id = NEW.reservation_id),0) + COALESCE((SELECT sum(quantity) FROM _ecommerce_inspection_stock WHERE reservation_type = 'inventory' AND reservation_id = NEW.reservation_id),0); END;
--> statement-breakpoint
DROP TRIGGER `_ecommerce_return_stock_component_release`;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_stock_component_release` AFTER INSERT ON `_ecommerce_return_stock` WHEN NEW.reservation_type = 'component'
 BEGIN UPDATE _ecommerce_component_reservations SET released_at = (SELECT created_at FROM _ecommerce_return_receipts WHERE id = NEW.receipt_id)
 WHERE id = NEW.reservation_id AND quantity = COALESCE((SELECT sum(quantity) FROM _ecommerce_return_stock WHERE reservation_type = 'component' AND reservation_id = NEW.reservation_id),0) + COALESCE((SELECT sum(quantity) FROM _ecommerce_inspection_stock WHERE reservation_type = 'component' AND reservation_id = NEW.reservation_id),0); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_inspection_received_guard` BEFORE INSERT ON `_ecommerce_return_inspections`
WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_return_receipts r WHERE r.id = NEW.receipt_id AND r.order_id = NEW.order_id)
 OR EXISTS(SELECT 1 FROM json_each(NEW.items) i WHERE COALESCE(json_type(i.value, '$.lineIndex'),'') <> 'integer'
 OR COALESCE(json_type(i.value, '$.quantity'),'') <> 'integer' OR json_extract(i.value, '$.quantity') < 1
 OR COALESCE(json_type(i.value,'$.disposition'),'') <> 'text'
 OR json_extract(i.value, '$.disposition') NOT IN ('sellable','quarantine','damaged')
 OR COALESCE(json_type(i.value, '$.restock'),'') NOT IN ('true','false')
 OR (json_extract(i.value, '$.restock') = 1 AND json_extract(i.value, '$.disposition') <> 'sellable')
 OR json_extract(i.value, '$.quantity') + COALESCE((SELECT sum(json_extract(a.value,'$.quantity')) FROM _ecommerce_return_inspections d, json_each(d.items) a
 WHERE d.receipt_id = NEW.receipt_id AND json_extract(a.value, '$.lineIndex') = json_extract(i.value, '$.lineIndex')),0)
 > COALESCE((SELECT json_extract(a.value,'$.quantity') FROM _ecommerce_return_receipts r, json_each(r.items) a
 WHERE r.id = NEW.receipt_id AND json_extract(a.value,'$.condition') = 'inspection' AND json_extract(a.value,'$.lineIndex') = json_extract(i.value,'$.lineIndex')),0)
 OR json_type(i.value,'$.lineIndex') IS NULL OR json_type(i.value,'$.quantity') IS NULL OR json_type(i.value,'$.restock') IS NULL OR json_type(i.value,'$.disposition') IS NULL)
 OR EXISTS(SELECT json_extract(value, '$.lineIndex') FROM json_each(NEW.items) GROUP BY json_extract(value, '$.lineIndex') HAVING count(*) > 1)
BEGIN SELECT RAISE(ABORT, 'Inspection exceeds pending received goods'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_inspection_stock_inventory_guard` BEFORE INSERT ON `_ecommerce_inspection_stock`
 WHEN NEW.reservation_type = 'inventory' AND NOT EXISTS(SELECT 1 FROM _ecommerce_inventory_reservations r WHERE r.id = NEW.reservation_id
 AND r.order_id = NEW.order_id AND r.target_type = NEW.target_type AND r.target_id = NEW.target_id AND r.released_at IS NULL AND r.quantity >= NEW.quantity
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_return_stock WHERE reservation_type = 'inventory' AND reservation_id = r.id),0)
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_inspection_stock WHERE reservation_type = 'inventory' AND reservation_id = r.id),0)
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_restocks WHERE reservation_type = 'inventory' AND reservation_id = r.id),0))
 BEGIN SELECT RAISE(ABORT, 'Return stock exceeds the original reservation'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_inspection_stock_component_guard` BEFORE INSERT ON `_ecommerce_inspection_stock`
 WHEN NEW.reservation_type = 'component' AND NOT EXISTS(SELECT 1 FROM _ecommerce_component_reservations r WHERE r.id = NEW.reservation_id
 AND r.order_id = NEW.order_id AND NEW.target_type = 'component' AND r.component_id = NEW.target_id AND r.released_at IS NULL AND r.quantity >= NEW.quantity
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_return_stock WHERE reservation_type = 'component' AND reservation_id = r.id),0)
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_inspection_stock WHERE reservation_type = 'component' AND reservation_id = r.id),0)
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_restocks WHERE reservation_type = 'component' AND reservation_id = r.id),0))
 BEGIN SELECT RAISE(ABORT, 'Return stock exceeds the original reservation'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_inspection_stock_product_apply` AFTER INSERT ON `_ecommerce_inspection_stock` WHEN NEW.target_type = 'product'
 BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_products WHERE id = NEW.target_id) THEN RAISE(ABORT, 'Return stock record is unavailable') END;
 UPDATE _ecommerce_products SET inventory_quantity = inventory_quantity + NEW.quantity, updated_at = MAX(updated_at + 1, (SELECT created_at FROM _ecommerce_return_inspections WHERE id = NEW.inspection_id)) WHERE id = NEW.target_id;
 END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_inspection_stock_variant_apply` AFTER INSERT ON `_ecommerce_inspection_stock` WHEN NEW.target_type = 'variant'
 BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_product_variants WHERE id = NEW.target_id) THEN RAISE(ABORT, 'Return stock record is unavailable') END;
 UPDATE _ecommerce_product_variants SET inventory_quantity = inventory_quantity + NEW.quantity, updated_at = MAX(updated_at + 1, (SELECT created_at FROM _ecommerce_return_inspections WHERE id = NEW.inspection_id)) WHERE id = NEW.target_id;
 END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_inspection_stock_stock_apply` AFTER INSERT ON `_ecommerce_inspection_stock` WHEN NEW.target_type = 'stock'
 BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_stocks WHERE id = NEW.target_id) THEN RAISE(ABORT, 'Return stock record is unavailable') END;
 UPDATE _ecommerce_stocks SET quantity = quantity + NEW.quantity, updated_at = MAX(updated_at + 1, (SELECT created_at FROM _ecommerce_return_inspections WHERE id = NEW.inspection_id)) WHERE id = NEW.target_id;
 END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_inspection_stock_component_apply` AFTER INSERT ON `_ecommerce_inspection_stock` WHEN NEW.target_type = 'component'
 BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_components WHERE id = NEW.target_id) THEN RAISE(ABORT, 'Return stock record is unavailable') END;
 UPDATE _ecommerce_components SET quantity = quantity + NEW.quantity, updated_at = MAX(updated_at + 1, (SELECT created_at FROM _ecommerce_return_inspections WHERE id = NEW.inspection_id)) WHERE id = NEW.target_id;
 END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_inspection_stock_inventory_release` AFTER INSERT ON `_ecommerce_inspection_stock` WHEN NEW.reservation_type = 'inventory'
 BEGIN UPDATE _ecommerce_inventory_reservations SET released_at = (SELECT created_at FROM _ecommerce_return_inspections WHERE id = NEW.inspection_id)
 WHERE id = NEW.reservation_id AND quantity = COALESCE((SELECT sum(quantity) FROM _ecommerce_return_stock WHERE reservation_type = 'inventory' AND reservation_id = NEW.reservation_id),0) + COALESCE((SELECT sum(quantity) FROM _ecommerce_inspection_stock WHERE reservation_type = 'inventory' AND reservation_id = NEW.reservation_id),0); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_inspection_stock_component_release` AFTER INSERT ON `_ecommerce_inspection_stock` WHEN NEW.reservation_type = 'component'
 BEGIN UPDATE _ecommerce_component_reservations SET released_at = (SELECT created_at FROM _ecommerce_return_inspections WHERE id = NEW.inspection_id)
 WHERE id = NEW.reservation_id AND quantity = COALESCE((SELECT sum(quantity) FROM _ecommerce_return_stock WHERE reservation_type = 'component' AND reservation_id = NEW.reservation_id),0) + COALESCE((SELECT sum(quantity) FROM _ecommerce_inspection_stock WHERE reservation_type = 'component' AND reservation_id = NEW.reservation_id),0); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_inspection_stock_received_guard` BEFORE INSERT ON `_ecommerce_inspection_stock`
WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_return_inspections d WHERE d.id = NEW.inspection_id AND d.order_id = NEW.order_id)
 OR NEW.quantity <> COALESCE((SELECT sum(json_extract(i.value,'$.quantity') * json_extract(t.value,'$.units'))
 FROM _ecommerce_return_inspections d JOIN _ecommerce_orders o ON o.id = d.order_id, json_each(d.items) i,
 json_each(json_extract(o.items,'$[' || json_extract(i.value,'$.lineIndex') || '].stockTargets')) t
 WHERE d.id = NEW.inspection_id AND json_extract(i.value,'$.restock') = 1 AND json_extract(i.value,'$.disposition') = 'sellable'
 AND json_extract(t.value,'$.type') = NEW.target_type AND json_extract(t.value,'$.id') = NEW.target_id),0)
BEGIN SELECT RAISE(ABORT, 'Inspection stock does not match approved goods'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_stocktake_versions_guard` BEFORE INSERT ON `_ecommerce_stocktakes`
WHEN EXISTS(SELECT 1 FROM json_each(NEW.lines) l WHERE COALESCE(json_type(l.value,'$.expectedQuantity'),'') <> 'integer'
 OR COALESCE(json_type(l.value,'$.countedQuantity'),'') <> 'integer' OR json_extract(l.value,'$.countedQuantity') NOT BETWEEN 0 AND 1000000
 OR NOT EXISTS(SELECT 1 FROM (
 SELECT 'product' AS type, id, inventory_quantity AS quantity, updated_at FROM _ecommerce_products
 UNION ALL SELECT 'variant', id, inventory_quantity, updated_at FROM _ecommerce_product_variants
 UNION ALL SELECT 'stock', id, quantity, updated_at FROM _ecommerce_stocks
 UNION ALL SELECT 'component', id, quantity, updated_at FROM _ecommerce_components
 ) s WHERE s.type = json_extract(l.value,'$.targetType') AND s.id = json_extract(l.value,'$.targetId')
 AND s.quantity = json_extract(l.value,'$.expectedQuantity') AND s.updated_at = json_extract(l.value,'$.expectedUpdatedSeconds') AND json_type(l.value,'$.expectedUpdatedSeconds') = 'integer'))
 OR EXISTS(SELECT 1 FROM json_each(NEW.lines) GROUP BY json_extract(value,'$.targetType'),json_extract(value,'$.targetId') HAVING count(*) > 1)
BEGIN SELECT RAISE(ABORT, 'Stock changed before stocktake'); END;
