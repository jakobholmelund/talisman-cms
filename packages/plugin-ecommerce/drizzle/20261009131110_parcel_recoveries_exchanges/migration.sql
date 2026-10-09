CREATE TABLE `_ecommerce_recovery_cases` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`kind` text NOT NULL,
	`fulfillment_id` text,
	`source_shipment_id` text,
	`receipt_id` text,
	`line_index` integer NOT NULL,
	`quantity` integer NOT NULL,
	`target` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`redacted_at` integer,
	CONSTRAINT `fk__ecommerce_recovery_cases_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT `fk__ecommerce_recovery_cases_fulfillment_id__ecommerce_fulfillments_id_fk` FOREIGN KEY (`fulfillment_id`) REFERENCES `_ecommerce_fulfillments`(`id`),
	CONSTRAINT `fk__ecommerce_recovery_cases_source_shipment_id__ecommerce_recovery_shipments_id_fk` FOREIGN KEY (`source_shipment_id`) REFERENCES `_ecommerce_recovery_shipments`(`id`),
	CONSTRAINT `fk__ecommerce_recovery_cases_receipt_id__ecommerce_return_receipts_id_fk` FOREIGN KEY (`receipt_id`) REFERENCES `_ecommerce_return_receipts`(`id`),
	CONSTRAINT "recovery_case_kind" CHECK("kind" IN ('lost', 'damaged', 'exchange')),
	CONSTRAINT "recovery_case_line" CHECK("line_index" BETWEEN 0 AND 199),
	CONSTRAINT "recovery_case_quantity" CHECK("quantity" BETWEEN 1 AND 1000000),
	CONSTRAINT "recovery_case_source" CHECK(("kind" = 'exchange' AND "receipt_id" IS NOT NULL AND "fulfillment_id" IS NULL AND "source_shipment_id" IS NULL) OR ("kind" <> 'exchange' AND "receipt_id" IS NULL AND (("fulfillment_id" IS NOT NULL AND "source_shipment_id" IS NULL) OR ("fulfillment_id" IS NULL AND "source_shipment_id" IS NOT NULL)))),
	CONSTRAINT "recovery_case_target" CHECK(json_valid("target") AND json_type("target") = 'object' AND json_type("target", '$.stockTargets') = 'array' AND json_array_length("target", '$.stockTargets') <= 50),
	CONSTRAINT "recovery_case_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "recovery_case_reason" CHECK(length(trim("reason")) >= 8),
	CONSTRAINT "recovery_case_reason_length" CHECK(length("reason") <= 500)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_recovery_events` (
	`id` text PRIMARY KEY,
	`case_id` text NOT NULL,
	`expected_version` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`shipment_id` text,
	`carrier` text,
	`tracking_number` text,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`redacted_at` integer,
	CONSTRAINT `fk__ecommerce_recovery_events_case_id__ecommerce_recovery_cases_id_fk` FOREIGN KEY (`case_id`) REFERENCES `_ecommerce_recovery_cases`(`id`),
	CONSTRAINT `fk__ecommerce_recovery_events_shipment_id__ecommerce_recovery_shipments_id_fk` FOREIGN KEY (`shipment_id`) REFERENCES `_ecommerce_recovery_shipments`(`id`),
	CONSTRAINT "recovery_event_kind" CHECK("kind" IN ('note', 'resolve', 'reopen', 'shipment', 'tracking')),
	CONSTRAINT "recovery_event_status" CHECK("status" IN ('open', 'resolved')),
	CONSTRAINT "recovery_event_shipment" CHECK(("kind" IN ('shipment','tracking') AND "shipment_id" IS NOT NULL) OR ("kind" NOT IN ('shipment','tracking') AND "shipment_id" IS NULL AND "carrier" IS NULL AND "tracking_number" IS NULL)),
	CONSTRAINT "recovery_event_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "recovery_event_reason" CHECK(length(trim("reason")) >= 8),
	CONSTRAINT "recovery_event_reason_length" CHECK(length("reason") <= 500),
	CONSTRAINT "recovery_event_carrier_length" CHECK("carrier" IS NULL OR length("carrier") <= 100),
	CONSTRAINT "recovery_event_tracking_length" CHECK("tracking_number" IS NULL OR length("tracking_number") <= 150)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_recovery_shipments` (
	`id` text PRIMARY KEY,
	`case_id` text NOT NULL,
	`expected_version` text NOT NULL,
	`quantity` integer NOT NULL,
	`stock` text NOT NULL,
	`carrier` text,
	`tracking_number` text,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`redacted_at` integer,
	CONSTRAINT `fk__ecommerce_recovery_shipments_case_id__ecommerce_recovery_cases_id_fk` FOREIGN KEY (`case_id`) REFERENCES `_ecommerce_recovery_cases`(`id`),
	CONSTRAINT "recovery_shipment_quantity" CHECK("quantity" BETWEEN 1 AND 1000000),
	CONSTRAINT "recovery_shipment_stock" CHECK(json_valid("stock") AND json_type("stock") = 'array' AND json_array_length("stock") <= 50),
	CONSTRAINT "recovery_shipment_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "recovery_shipment_reason" CHECK(length(trim("reason")) >= 8),
	CONSTRAINT "recovery_shipment_reason_length" CHECK(length("reason") <= 500),
	CONSTRAINT "recovery_shipment_carrier_length" CHECK("carrier" IS NULL OR length("carrier") <= 100),
	CONSTRAINT "recovery_shipment_tracking_length" CHECK("tracking_number" IS NULL OR length("tracking_number") <= 150)
);
--> statement-breakpoint
CREATE INDEX `_ecommerce_recovery_case_order_idx` ON `_ecommerce_recovery_cases` (`order_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_recovery_case_date_idx` ON `_ecommerce_recovery_cases` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_recovery_case_fulfillment_idx` ON `_ecommerce_recovery_cases` (`fulfillment_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_recovery_case_source_idx` ON `_ecommerce_recovery_cases` (`source_shipment_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_recovery_case_receipt_idx` ON `_ecommerce_recovery_cases` (`receipt_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_recovery_event_case_idx` ON `_ecommerce_recovery_events` (`case_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_recovery_event_shipment_idx` ON `_ecommerce_recovery_events` (`shipment_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_recovery_shipment_case_idx` ON `_ecommerce_recovery_shipments` (`case_id`);