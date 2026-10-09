CREATE TABLE `_ecommerce_purchase_order_events` (
	`id` text PRIMARY KEY,
	`purchase_order_id` text NOT NULL,
	`expected_version` text,
	`status` text NOT NULL,
	`reference` text NOT NULL,
	`expected_date` text NOT NULL,
	`lines` text NOT NULL,
	`supplier` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_purchase_order_events_purchase_order_id__ecommerce_purchase_orders_id_fk` FOREIGN KEY (`purchase_order_id`) REFERENCES `_ecommerce_purchase_orders`(`id`),
	CONSTRAINT "purchase_order_status" CHECK("status" IN ('draft', 'ordered', 'cancelled')),
	CONSTRAINT "purchase_order_reference" CHECK(length(trim("reference")) >= 1),
	CONSTRAINT "purchase_order_reference_length" CHECK(length("reference") <= 200),
	CONSTRAINT "purchase_order_date" CHECK(length("expected_date")=10 AND date("expected_date", '+0 days') IS NOT NULL AND date("expected_date", '+0 days')="expected_date"),
	CONSTRAINT "purchase_order_lines" CHECK(json_valid("lines") AND json_type("lines")='array' AND json_array_length("lines") BETWEEN 1 AND 20),
	CONSTRAINT "purchase_order_supplier" CHECK(json_valid("supplier") AND json_type("supplier")='object'),
	CONSTRAINT "purchase_order_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "purchase_order_reason" CHECK(length(trim("reason")) >= 8)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_purchase_order_lines` (
	`id` text PRIMARY KEY,
	`purchase_order_id` text NOT NULL,
	`line_index` integer NOT NULL,
	`delivery_id` text NOT NULL,
	CONSTRAINT `fk__ecommerce_purchase_order_lines_purchase_order_id__ecommerce_purchase_orders_id_fk` FOREIGN KEY (`purchase_order_id`) REFERENCES `_ecommerce_purchase_orders`(`id`),
	CONSTRAINT `fk__ecommerce_purchase_order_lines_delivery_id__ecommerce_replenishment_deliveries_id_fk` FOREIGN KEY (`delivery_id`) REFERENCES `_ecommerce_replenishment_deliveries`(`id`),
	CONSTRAINT "purchase_order_line_index" CHECK("line_index" BETWEEN 0 AND 19)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_purchase_orders` (
	`id` text PRIMARY KEY,
	`supplier_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_purchase_orders_supplier_id__ecommerce_suppliers_id_fk` FOREIGN KEY (`supplier_id`) REFERENCES `_ecommerce_suppliers`(`id`)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_return_request_reasons` (
	`request_id` text PRIMARY KEY,
	`code` text NOT NULL,
	CONSTRAINT `fk__ecommerce_return_request_reasons_request_id__ecommerce_return_requests_id_fk` FOREIGN KEY (`request_id`) REFERENCES `_ecommerce_return_requests`(`id`),
	CONSTRAINT "return_reason_code" CHECK("code" IN ('size_fit', 'damaged', 'wrong_item', 'changed_mind', 'other', 'unspecified'))
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_supplier_revisions` (
	`id` text PRIMARY KEY,
	`supplier_id` text NOT NULL,
	`expected_version` text,
	`name` text NOT NULL,
	`contact` text NOT NULL,
	`address` text NOT NULL,
	`active` integer NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_supplier_revisions_supplier_id__ecommerce_suppliers_id_fk` FOREIGN KEY (`supplier_id`) REFERENCES `_ecommerce_suppliers`(`id`),
	CONSTRAINT "supplier_name" CHECK(length(trim("name")) >= 1),
	CONSTRAINT "supplier_name_length" CHECK(length("name") <= 200),
	CONSTRAINT "supplier_contact" CHECK(length("contact") <= 500),
	CONSTRAINT "supplier_address" CHECK(length("address") <= 1000),
	CONSTRAINT "supplier_active" CHECK("active" IN (0, 1)),
	CONSTRAINT "supplier_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "supplier_reason" CHECK(length(trim("reason")) >= 8)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_suppliers` (
	`id` text PRIMARY KEY,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new__ecommerce_email_deliveries` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` integer NOT NULL,
	`claimed_at` integer,
	`sent_at` integer,
	`retry_requested_at` integer,
	`retry_request_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "email_delivery_kind" CHECK("kind" IN ('order_confirmation', 'shipment', 'shipment_update', 'gift_card_claim', 'return_decision', 'return_received', 'return_refund')),
	CONSTRAINT "email_delivery_status" CHECK("status" IN ('pending', 'sent', 'failed', 'cancelled')),
	CONSTRAINT "email_delivery_attempts_nonnegative" CHECK("attempts" >= 0),
	CONSTRAINT "email_delivery_sent_has_time" CHECK(("status" = 'sent') = ("sent_at" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new__ecommerce_email_deliveries`(`id`, `kind`, `subject_id`, `status`, `attempts`, `last_error`, `next_attempt_at`, `claimed_at`, `sent_at`, `retry_requested_at`, `retry_request_id`, `created_at`) SELECT `id`, `kind`, `subject_id`, `status`, `attempts`, `last_error`, `next_attempt_at`, `claimed_at`, `sent_at`, `retry_requested_at`, `retry_request_id`, `created_at` FROM `_ecommerce_email_deliveries`;--> statement-breakpoint
DROP TABLE `_ecommerce_email_deliveries`;--> statement-breakpoint
ALTER TABLE `__new__ecommerce_email_deliveries` RENAME TO `_ecommerce_email_deliveries`;--> statement-breakpoint
-- Force any actual dangling reference to fail before clearing SQLite's stale rebuild counter.
SELECT CASE WHEN EXISTS (SELECT 1 FROM pragma_foreign_key_check)
  THEN json('purchasing migration foreign key check failed') ELSE 1 END;
--> statement-breakpoint
PRAGMA defer_foreign_keys = false;--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_email_deliveries_kind_subject_unique` ON `_ecommerce_email_deliveries` (`kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_email_deliveries_attention_idx` ON `_ecommerce_email_deliveries` (`created_at`,`id`) WHERE "_ecommerce_email_deliveries"."status" = 'failed' OR ("_ecommerce_email_deliveries"."status" = 'pending' AND "_ecommerce_email_deliveries"."last_error" IS NOT NULL);--> statement-breakpoint
CREATE INDEX `_ecommerce_email_deliveries_due_idx` ON `_ecommerce_email_deliveries` (`next_attempt_at`) WHERE "_ecommerce_email_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `_ecommerce_purchase_order_event_order_idx` ON `_ecommerce_purchase_order_events` (`purchase_order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_purchase_order_line_unique` ON `_ecommerce_purchase_order_lines` (`purchase_order_id`,`line_index`);--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_purchase_order_delivery_unique` ON `_ecommerce_purchase_order_lines` (`delivery_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_purchase_order_supplier_idx` ON `_ecommerce_purchase_orders` (`supplier_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_supplier_revision_supplier_idx` ON `_ecommerce_supplier_revisions` (`supplier_id`);
