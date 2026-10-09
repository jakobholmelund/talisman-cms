CREATE TABLE `_ecommerce_return_request_events` (
	`id` text PRIMARY KEY,
	`request_id` text NOT NULL,
	`status` text NOT NULL,
	`expected_version` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`customer_message` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`redacted_at` integer,
	CONSTRAINT `fk__ecommerce_return_request_events_request_id__ecommerce_return_requests_id_fk` FOREIGN KEY (`request_id`) REFERENCES `_ecommerce_return_requests`(`id`),
	CONSTRAINT "return_request_event_status" CHECK("status" IN ('pending', 'approved', 'declined', 'cancelled', 'closed')),
	CONSTRAINT "return_request_event_actor_kind" CHECK("actor_kind" IN ('staff', 'customer')),
	CONSTRAINT "return_request_event_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "return_request_event_reason" CHECK(length(trim("reason")) >= 8)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_return_request_receipts` (
	`receipt_id` text PRIMARY KEY,
	`request_id` text NOT NULL,
	CONSTRAINT `fk__ecommerce_return_request_receipts_receipt_id__ecommerce_return_receipts_id_fk` FOREIGN KEY (`receipt_id`) REFERENCES `_ecommerce_return_receipts`(`id`),
	CONSTRAINT `fk__ecommerce_return_request_receipts_request_id__ecommerce_return_requests_id_fk` FOREIGN KEY (`request_id`) REFERENCES `_ecommerce_return_requests`(`id`)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_return_requests` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`items` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`redacted_at` integer,
	CONSTRAINT `fk__ecommerce_return_requests_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT "return_request_items" CHECK(json_valid("items") AND json_type("items") = 'array' AND json_array_length("items") BETWEEN 1 AND 50),
	CONSTRAINT "return_request_reason" CHECK(length(trim("reason")) >= 8)
);
--> statement-breakpoint
CREATE INDEX `_ecommerce_return_request_events_request_idx` ON `_ecommerce_return_request_events` (`request_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_return_request_receipts_request_idx` ON `_ecommerce_return_request_receipts` (`request_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_return_requests_order_idx` ON `_ecommerce_return_requests` (`order_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_return_requests_created_idx` ON `_ecommerce_return_requests` (`created_at`);