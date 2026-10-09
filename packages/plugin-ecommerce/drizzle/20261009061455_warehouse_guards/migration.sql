CREATE TRIGGER `_ecommerce_parcel_contents_no_update` BEFORE UPDATE ON `_ecommerce_parcel_contents` BEGIN SELECT RAISE(ABORT, 'Warehouse history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_parcel_contents_no_delete` BEFORE DELETE ON `_ecommerce_parcel_contents` BEGIN SELECT RAISE(ABORT, 'Warehouse history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_receipts_no_update` BEFORE UPDATE ON `_ecommerce_return_receipts` BEGIN SELECT RAISE(ABORT, 'Warehouse history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_receipts_no_delete` BEFORE DELETE ON `_ecommerce_return_receipts` BEGIN SELECT RAISE(ABORT, 'Warehouse history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_stock_no_update` BEFORE UPDATE ON `_ecommerce_return_stock` BEGIN SELECT RAISE(ABORT, 'Warehouse history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_stock_no_delete` BEFORE DELETE ON `_ecommerce_return_stock` BEGIN SELECT RAISE(ABORT, 'Warehouse history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_stock_movements_no_update` BEFORE UPDATE ON `_ecommerce_stock_movements` BEGIN SELECT RAISE(ABORT, 'Warehouse history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_stock_movements_no_delete` BEFORE DELETE ON `_ecommerce_stock_movements` BEGIN SELECT RAISE(ABORT, 'Warehouse history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_warehouse_items_immutable` BEFORE UPDATE OF items ON `_ecommerce_orders`
WHEN NEW.items <> OLD.items AND (EXISTS(SELECT 1 FROM _ecommerce_inventory_reservations WHERE order_id = OLD.id)
 OR EXISTS(SELECT 1 FROM _ecommerce_component_reservations WHERE order_id = OLD.id)
 OR EXISTS(SELECT 1 FROM _ecommerce_parcel_contents WHERE order_id = OLD.id)
 OR EXISTS(SELECT 1 FROM _ecommerce_return_receipts WHERE order_id = OLD.id))
BEGIN SELECT RAISE(ABORT, 'Order item stock snapshot is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_parcel_contents_guard` BEFORE INSERT ON `_ecommerce_parcel_contents`
WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_fulfillments f JOIN _ecommerce_orders o ON o.id = f.order_id
 WHERE f.id = NEW.fulfillment_id AND f.order_id = NEW.order_id AND f.kind = 'shipment' AND COALESCE(o.payment_provider,'stripe') <> 'admin_test')
 OR EXISTS(SELECT 1 FROM json_each(NEW.items) i WHERE json_type(i.value, '$.lineIndex') IS NOT 'integer' OR json_extract(i.value, '$.lineIndex') < 0
 OR json_type(i.value, '$.quantity') IS NOT 'integer' OR json_extract(i.value, '$.quantity') <= 0
 OR NOT EXISTS(SELECT 1 FROM json_each((SELECT items FROM _ecommerce_orders WHERE id = NEW.order_id)) l WHERE CAST(l.key AS integer) = json_extract(i.value, '$.lineIndex')) OR COALESCE((SELECT sum(json_extract(a.value, '$.quantity')) FROM _ecommerce_parcel_contents p, json_each(p.items) a
 WHERE p.order_id = NEW.order_id AND json_extract(a.value, '$.lineIndex') = json_extract(i.value, '$.lineIndex')),0) + json_extract(i.value, '$.quantity') > COALESCE(json_extract((SELECT items FROM _ecommerce_orders WHERE id = NEW.order_id), '$[' || json_extract(i.value, '$.lineIndex') || '].quantity'),0))
 OR EXISTS(SELECT json_extract(value, '$.lineIndex') FROM json_each(NEW.items) GROUP BY json_extract(value, '$.lineIndex') HAVING count(*) > 1)
 OR (NEW.source = 'shipment' AND EXISTS(SELECT 1 FROM _ecommerce_fulfillments f WHERE f.order_id = NEW.order_id AND f.kind = 'shipment' AND f.id <> NEW.fulfillment_id AND NOT EXISTS(SELECT 1 FROM _ecommerce_parcel_contents p WHERE p.fulfillment_id = f.id)))
BEGIN SELECT RAISE(ABORT, 'Parcel quantities cannot be recorded'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_parcel_contents_progress` AFTER INSERT ON `_ecommerce_parcel_contents`
WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_fulfillments f WHERE f.order_id = NEW.order_id AND f.kind = 'shipment'
 AND NOT EXISTS(SELECT 1 FROM _ecommerce_parcel_contents p WHERE p.fulfillment_id = f.id))
BEGIN UPDATE _ecommerce_orders SET updated_at = MAX(updated_at + 1, NEW.created_at), fulfillment_status = CASE WHEN EXISTS(
 SELECT 1 FROM json_each(items) l WHERE json_extract(l.value, '$.quantity') > COALESCE((
 SELECT sum(json_extract(i.value, '$.quantity')) FROM _ecommerce_parcel_contents p, json_each(p.items) i
 WHERE p.order_id = NEW.order_id AND json_extract(i.value, '$.lineIndex') = CAST(l.key AS integer)),0))
 THEN 'partially_fulfilled' ELSE 'fulfilled' END WHERE id = NEW.order_id; END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_receipts_guard` BEFORE INSERT ON `_ecommerce_return_receipts`
WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_orders WHERE id = NEW.order_id AND status IN ('paid','partially_refunded','refunded','disputed') AND COALESCE(payment_provider,'stripe') <> 'admin_test')
 OR EXISTS(SELECT 1 FROM json_each(NEW.items) i WHERE json_type(i.value, '$.lineIndex') IS NOT 'integer' OR json_extract(i.value, '$.lineIndex') < 0
 OR json_type(i.value, '$.quantity') IS NOT 'integer' OR json_extract(i.value, '$.quantity') <= 0
 OR NOT EXISTS(SELECT 1 FROM json_each((SELECT items FROM _ecommerce_orders WHERE id = NEW.order_id)) l WHERE CAST(l.key AS integer) = json_extract(i.value, '$.lineIndex'))
 OR json_extract(i.value, '$.condition') NOT IN ('sellable','damaged','inspection') OR json_type(i.value, '$.condition') IS NOT 'text'
 OR json_type(i.value, '$.restock') NOT IN ('true','false') OR json_type(i.value, '$.restock') IS NULL
 OR (json_extract(i.value, '$.restock') = 1 AND (json_extract(i.value, '$.condition') <> 'sellable' OR
 json_type((SELECT items FROM _ecommerce_orders WHERE id = NEW.order_id), '$[' || json_extract(i.value, '$.lineIndex') || '].stockTargets') IS NOT 'array'))
 OR COALESCE((SELECT sum(json_extract(a.value, '$.quantity')) FROM _ecommerce_return_receipts r, json_each(r.items) a
 WHERE r.order_id = NEW.order_id AND json_extract(a.value, '$.lineIndex') = json_extract(i.value, '$.lineIndex')),0) + json_extract(i.value, '$.quantity') > CASE WHEN EXISTS(SELECT 1 FROM _ecommerce_fulfillments f WHERE f.order_id = NEW.order_id AND f.kind = 'shipment'
 AND NOT EXISTS(SELECT 1 FROM _ecommerce_parcel_contents p WHERE p.fulfillment_id = f.id)) THEN COALESCE(json_extract((SELECT items FROM _ecommerce_orders WHERE id = NEW.order_id), '$[' || json_extract(i.value, '$.lineIndex') || '].quantity'),0) ELSE COALESCE((SELECT sum(json_extract(a.value, '$.quantity')) FROM _ecommerce_parcel_contents p, json_each(p.items) a
 WHERE p.order_id = NEW.order_id AND json_extract(a.value, '$.lineIndex') = json_extract(i.value, '$.lineIndex')),0) END)
 OR EXISTS(SELECT json_extract(value, '$.lineIndex') FROM json_each(NEW.items) GROUP BY json_extract(value, '$.lineIndex') HAVING count(*) > 1)
BEGIN SELECT RAISE(ABORT, 'Return quantities cannot be recorded'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_stock_inventory_guard` BEFORE INSERT ON `_ecommerce_return_stock`
 WHEN NEW.reservation_type = 'inventory' AND NOT EXISTS(SELECT 1 FROM _ecommerce_inventory_reservations r WHERE r.id = NEW.reservation_id
 AND r.order_id = NEW.order_id AND r.target_type = NEW.target_type AND r.target_id = NEW.target_id AND r.released_at IS NULL AND r.quantity >= NEW.quantity
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_return_stock WHERE reservation_type = 'inventory' AND reservation_id = r.id),0)
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_restocks WHERE reservation_type = 'inventory' AND reservation_id = r.id),0))
 BEGIN SELECT RAISE(ABORT, 'Return stock exceeds the original reservation'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_stock_component_guard` BEFORE INSERT ON `_ecommerce_return_stock`
 WHEN NEW.reservation_type = 'component' AND NOT EXISTS(SELECT 1 FROM _ecommerce_component_reservations r WHERE r.id = NEW.reservation_id
 AND r.order_id = NEW.order_id AND NEW.target_type = 'component' AND r.component_id = NEW.target_id AND r.released_at IS NULL AND r.quantity >= NEW.quantity
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_return_stock WHERE reservation_type = 'component' AND reservation_id = r.id),0)
 + COALESCE((SELECT sum(quantity) FROM _ecommerce_restocks WHERE reservation_type = 'component' AND reservation_id = r.id),0))
 BEGIN SELECT RAISE(ABORT, 'Return stock exceeds the original reservation'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_stock_received_guard` BEFORE INSERT ON `_ecommerce_return_stock`
WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_return_receipts r WHERE r.id = NEW.receipt_id AND r.order_id = NEW.order_id)
 OR NEW.quantity <> COALESCE((SELECT sum(json_extract(i.value, '$.quantity') * json_extract(t.value, '$.units'))
 FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id = r.order_id, json_each(r.items) i,
 json_each(json_extract(o.items, '$[' || json_extract(i.value, '$.lineIndex') || '].stockTargets')) t
 WHERE r.id = NEW.receipt_id AND json_extract(i.value, '$.restock') = 1 AND json_extract(i.value, '$.condition') = 'sellable'
 AND json_extract(t.value, '$.type') = NEW.target_type AND json_extract(t.value, '$.id') = NEW.target_id),0)
BEGIN SELECT RAISE(ABORT, 'Return stock does not match received sellable goods'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_legacy_restock_return_guard` BEFORE INSERT ON `_ecommerce_restocks`
WHEN NEW.quantity + COALESCE((SELECT sum(quantity) FROM _ecommerce_return_stock WHERE reservation_type = NEW.reservation_type AND reservation_id = NEW.reservation_id),0)
 > CASE WHEN NEW.reservation_type = 'inventory' THEN COALESCE((SELECT quantity FROM _ecommerce_inventory_reservations WHERE id = NEW.reservation_id AND order_id = NEW.order_id AND released_at IS NULL),0)
 ELSE COALESCE((SELECT quantity FROM _ecommerce_component_reservations WHERE id = NEW.reservation_id AND order_id = NEW.order_id AND released_at IS NULL),0) END
BEGIN SELECT RAISE(ABORT, 'Return stock already restored'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_stock_movement_product_guard` BEFORE INSERT ON `_ecommerce_stock_movements`
 WHEN NEW.target_type = 'product' AND NOT EXISTS(SELECT 1 FROM _ecommerce_products WHERE id = NEW.target_id AND inventory_quantity = NEW.before_quantity AND updated_at = NEW.expected_updated_at)
 BEGIN SELECT RAISE(ABORT, 'Stock changed before movement'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_stock_movement_product_apply` AFTER INSERT ON `_ecommerce_stock_movements` WHEN NEW.target_type = 'product'
 BEGIN UPDATE _ecommerce_products SET inventory_quantity = inventory_quantity + NEW.delta, updated_at = MAX(updated_at + 1, NEW.created_at) WHERE id = NEW.target_id; END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_stock_product_apply` AFTER INSERT ON `_ecommerce_return_stock` WHEN NEW.target_type = 'product'
 BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_products WHERE id = NEW.target_id) THEN RAISE(ABORT, 'Return stock record is unavailable') END;
 UPDATE _ecommerce_products SET inventory_quantity = inventory_quantity + NEW.quantity, updated_at = MAX(updated_at + 1, (SELECT created_at FROM _ecommerce_return_receipts WHERE id = NEW.receipt_id)) WHERE id = NEW.target_id;
 END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_stock_movement_variant_guard` BEFORE INSERT ON `_ecommerce_stock_movements`
 WHEN NEW.target_type = 'variant' AND NOT EXISTS(SELECT 1 FROM _ecommerce_product_variants WHERE id = NEW.target_id AND inventory_quantity = NEW.before_quantity AND updated_at = NEW.expected_updated_at)
 BEGIN SELECT RAISE(ABORT, 'Stock changed before movement'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_stock_movement_variant_apply` AFTER INSERT ON `_ecommerce_stock_movements` WHEN NEW.target_type = 'variant'
 BEGIN UPDATE _ecommerce_product_variants SET inventory_quantity = inventory_quantity + NEW.delta, updated_at = MAX(updated_at + 1, NEW.created_at) WHERE id = NEW.target_id; END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_stock_variant_apply` AFTER INSERT ON `_ecommerce_return_stock` WHEN NEW.target_type = 'variant'
 BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_product_variants WHERE id = NEW.target_id) THEN RAISE(ABORT, 'Return stock record is unavailable') END;
 UPDATE _ecommerce_product_variants SET inventory_quantity = inventory_quantity + NEW.quantity, updated_at = MAX(updated_at + 1, (SELECT created_at FROM _ecommerce_return_receipts WHERE id = NEW.receipt_id)) WHERE id = NEW.target_id;
 END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_stock_movement_stock_guard` BEFORE INSERT ON `_ecommerce_stock_movements`
 WHEN NEW.target_type = 'stock' AND NOT EXISTS(SELECT 1 FROM _ecommerce_stocks WHERE id = NEW.target_id AND quantity = NEW.before_quantity AND updated_at = NEW.expected_updated_at)
 BEGIN SELECT RAISE(ABORT, 'Stock changed before movement'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_stock_movement_stock_apply` AFTER INSERT ON `_ecommerce_stock_movements` WHEN NEW.target_type = 'stock'
 BEGIN UPDATE _ecommerce_stocks SET quantity = quantity + NEW.delta, updated_at = MAX(updated_at + 1, NEW.created_at) WHERE id = NEW.target_id; END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_stock_stock_apply` AFTER INSERT ON `_ecommerce_return_stock` WHEN NEW.target_type = 'stock'
 BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_stocks WHERE id = NEW.target_id) THEN RAISE(ABORT, 'Return stock record is unavailable') END;
 UPDATE _ecommerce_stocks SET quantity = quantity + NEW.quantity, updated_at = MAX(updated_at + 1, (SELECT created_at FROM _ecommerce_return_receipts WHERE id = NEW.receipt_id)) WHERE id = NEW.target_id;
 END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_stock_movement_component_guard` BEFORE INSERT ON `_ecommerce_stock_movements`
 WHEN NEW.target_type = 'component' AND NOT EXISTS(SELECT 1 FROM _ecommerce_components WHERE id = NEW.target_id AND quantity = NEW.before_quantity AND updated_at = NEW.expected_updated_at)
 BEGIN SELECT RAISE(ABORT, 'Stock changed before movement'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_stock_movement_component_apply` AFTER INSERT ON `_ecommerce_stock_movements` WHEN NEW.target_type = 'component'
 BEGIN UPDATE _ecommerce_components SET quantity = quantity + NEW.delta, updated_at = MAX(updated_at + 1, NEW.created_at) WHERE id = NEW.target_id; END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_stock_component_apply` AFTER INSERT ON `_ecommerce_return_stock` WHEN NEW.target_type = 'component'
 BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _ecommerce_components WHERE id = NEW.target_id) THEN RAISE(ABORT, 'Return stock record is unavailable') END;
 UPDATE _ecommerce_components SET quantity = quantity + NEW.quantity, updated_at = MAX(updated_at + 1, (SELECT created_at FROM _ecommerce_return_receipts WHERE id = NEW.receipt_id)) WHERE id = NEW.target_id;
 END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_stock_inventory_release` AFTER INSERT ON `_ecommerce_return_stock` WHEN NEW.reservation_type = 'inventory'
 BEGIN UPDATE _ecommerce_inventory_reservations SET released_at = (SELECT created_at FROM _ecommerce_return_receipts WHERE id = NEW.receipt_id)
 WHERE id = NEW.reservation_id AND quantity = (SELECT sum(quantity) FROM _ecommerce_return_stock WHERE reservation_type = 'inventory' AND reservation_id = NEW.reservation_id); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_return_stock_component_release` AFTER INSERT ON `_ecommerce_return_stock` WHEN NEW.reservation_type = 'component'
 BEGIN UPDATE _ecommerce_component_reservations SET released_at = (SELECT created_at FROM _ecommerce_return_receipts WHERE id = NEW.receipt_id)
 WHERE id = NEW.reservation_id AND quantity = (SELECT sum(quantity) FROM _ecommerce_return_stock WHERE reservation_type = 'component' AND reservation_id = NEW.reservation_id); END;
