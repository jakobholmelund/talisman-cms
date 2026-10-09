CREATE TABLE `_ecommerce_inspection_stock` (
	`id` text PRIMARY KEY,
	`inspection_id` text NOT NULL,
	`order_id` text NOT NULL,
	`reservation_type` text NOT NULL,
	`reservation_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`quantity` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_inspection_stock_inspection_id__ecommerce_return_inspections_id_fk` FOREIGN KEY (`inspection_id`) REFERENCES `_ecommerce_return_inspections`(`id`),
	CONSTRAINT `fk__ecommerce_inspection_stock_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT "inspection_stock_reservation" CHECK("reservation_type" IN ('inventory', 'component')),
	CONSTRAINT "inspection_stock_target" CHECK("target_type" IN ('product', 'variant', 'stock', 'component')),
	CONSTRAINT "inspection_stock_quantity" CHECK("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_return_inspections` (
	`id` text PRIMARY KEY,
	`receipt_id` text NOT NULL,
	`order_id` text NOT NULL,
	`items` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_return_inspections_receipt_id__ecommerce_return_receipts_id_fk` FOREIGN KEY (`receipt_id`) REFERENCES `_ecommerce_return_receipts`(`id`),
	CONSTRAINT `fk__ecommerce_return_inspections_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT "inspection_items_array" CHECK(json_valid("items") AND json_type("items") = 'array' AND json_array_length("items") > 0),
	CONSTRAINT "inspection_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "inspection_reason" CHECK(length(trim("reason")) >= 8)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_stocktakes` (
	`id` text PRIMARY KEY,
	`lines` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "stocktake_lines_array" CHECK(json_valid("lines") AND json_type("lines") = 'array' AND json_array_length("lines") BETWEEN 1 AND 50),
	CONSTRAINT "stocktake_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "stocktake_reason" CHECK(length(trim("reason")) >= 8)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_inspection_stock_decision_unique` ON `_ecommerce_inspection_stock` (`inspection_id`,`reservation_type`,`reservation_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_inspection_stock_reservation_idx` ON `_ecommerce_inspection_stock` (`reservation_type`,`reservation_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_inspection_stock_order_idx` ON `_ecommerce_inspection_stock` (`order_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_inspection_stock_target_idx` ON `_ecommerce_inspection_stock` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_return_inspections_receipt_idx` ON `_ecommerce_return_inspections` (`receipt_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_return_inspections_order_idx` ON `_ecommerce_return_inspections` (`order_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_stocktakes_created_idx` ON `_ecommerce_stocktakes` (`created_at`);