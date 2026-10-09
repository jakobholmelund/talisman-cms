CREATE INDEX `_ecommerce_component_reservations_target_idx` ON `_ecommerce_component_reservations` (`component_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_inventory_reservations_target_idx` ON `_ecommerce_inventory_reservations` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_restocks_target_idx` ON `_ecommerce_restocks` (`target_type`,`target_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_return_stock_order_idx` ON `_ecommerce_return_stock` (`order_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_return_stock_target_idx` ON `_ecommerce_return_stock` (`target_type`,`target_id`);