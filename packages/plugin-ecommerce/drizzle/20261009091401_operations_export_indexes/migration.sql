CREATE INDEX `_ecommerce_component_reservations_released_idx` ON `_ecommerce_component_reservations` (`released_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_inventory_reservations_released_idx` ON `_ecommerce_inventory_reservations` (`released_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_created_idx` ON `_ecommerce_orders` (`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_restocks_created_idx` ON `_ecommerce_restocks` (`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_return_inspections_created_idx` ON `_ecommerce_return_inspections` (`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_return_receipts_created_idx` ON `_ecommerce_return_receipts` (`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_stock_movements_created_idx` ON `_ecommerce_stock_movements` (`created_at`);