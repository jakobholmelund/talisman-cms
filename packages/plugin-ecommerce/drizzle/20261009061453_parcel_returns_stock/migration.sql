CREATE TABLE `_ecommerce_parcel_contents` (
	`id` text PRIMARY KEY,
	`fulfillment_id` text NOT NULL,
	`order_id` text NOT NULL,
	`items` text NOT NULL,
	`source` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_parcel_contents_fulfillment_id__ecommerce_fulfillments_id_fk` FOREIGN KEY (`fulfillment_id`) REFERENCES `_ecommerce_fulfillments`(`id`),
	CONSTRAINT `fk__ecommerce_parcel_contents_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT "parcel_items_array" CHECK(json_valid("items") AND json_type("items") = 'array' AND json_array_length("items") > 0),
	CONSTRAINT "parcel_source" CHECK("source" IN ('shipment', 'backfill')),
	CONSTRAINT "parcel_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "parcel_reason" CHECK(length(trim("reason")) >= 8)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_return_receipts` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`items` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_return_receipts_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT "return_items_array" CHECK(json_valid("items") AND json_type("items") = 'array' AND json_array_length("items") > 0),
	CONSTRAINT "return_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "return_reason" CHECK(length(trim("reason")) >= 8)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_return_stock` (
	`id` text PRIMARY KEY,
	`receipt_id` text NOT NULL,
	`order_id` text NOT NULL,
	`reservation_type` text NOT NULL,
	`reservation_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`quantity` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_return_stock_receipt_id__ecommerce_return_receipts_id_fk` FOREIGN KEY (`receipt_id`) REFERENCES `_ecommerce_return_receipts`(`id`),
	CONSTRAINT `fk__ecommerce_return_stock_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT "return_stock_reservation_type" CHECK("reservation_type" IN ('inventory', 'component')),
	CONSTRAINT "return_stock_target_type" CHECK("target_type" IN ('product', 'variant', 'stock', 'component')),
	CONSTRAINT "return_stock_quantity" CHECK("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_stock_movements` (
	`id` text PRIMARY KEY,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`kind` text NOT NULL,
	`delta` integer NOT NULL,
	`before_quantity` integer NOT NULL,
	`after_quantity` integer NOT NULL,
	`expected_updated_at` integer NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "stock_movement_target" CHECK("target_type" IN ('product', 'variant', 'stock', 'component')),
	CONSTRAINT "stock_movement_kind" CHECK("kind" IN ('receipt', 'correction')),
	CONSTRAINT "stock_movement_delta" CHECK("delta" <> 0 AND ("kind" <> 'receipt' OR "delta" > 0)),
	CONSTRAINT "stock_movement_before" CHECK("before_quantity" >= 0),
	CONSTRAINT "stock_movement_after" CHECK("after_quantity" >= 0),
	CONSTRAINT "stock_movement_balance" CHECK("after_quantity" = "before_quantity" + "delta"),
	CONSTRAINT "stock_movement_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "stock_movement_reason" CHECK(length(trim("reason")) >= 8)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_parcel_contents_shipment_unique` ON `_ecommerce_parcel_contents` (`fulfillment_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_parcel_contents_order_idx` ON `_ecommerce_parcel_contents` (`order_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_return_receipts_order_idx` ON `_ecommerce_return_receipts` (`order_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_return_stock_receipt_unique` ON `_ecommerce_return_stock` (`receipt_id`,`reservation_type`,`reservation_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_return_stock_reservation_idx` ON `_ecommerce_return_stock` (`reservation_type`,`reservation_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_stock_movements_target_idx` ON `_ecommerce_stock_movements` (`target_type`,`target_id`,`created_at`);