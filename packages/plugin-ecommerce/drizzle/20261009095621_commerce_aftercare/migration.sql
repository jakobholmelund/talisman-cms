CREATE TABLE `_ecommerce_replenishment_deliveries` (
	`id` text PRIMARY KEY,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`supplier` text NOT NULL,
	`reference` text NOT NULL,
	`expected_date` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "replenishment_delivery_target" CHECK("target_type" IN ('product', 'variant', 'stock', 'component')),
	CONSTRAINT "replenishment_delivery_quantity" CHECK("quantity" BETWEEN 1 AND 1000000),
	CONSTRAINT "replenishment_delivery_date" CHECK(length("expected_date") = 10 AND date("expected_date", '+0 days') IS NOT NULL AND date("expected_date", '+0 days') = "expected_date"),
	CONSTRAINT "replenishment_delivery_supplier" CHECK(length(trim("supplier")) > 0),
	CONSTRAINT "replenishment_delivery_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "replenishment_delivery_reason" CHECK(length(trim("reason")) >= 8)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_replenishment_delivery_events` (
	`id` text PRIMARY KEY,
	`delivery_id` text NOT NULL,
	`kind` text NOT NULL,
	`movement_id` text,
	`expected_version` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_replenishment_delivery_events_delivery_id__ecommerce_replenishment_deliveries_id_fk` FOREIGN KEY (`delivery_id`) REFERENCES `_ecommerce_replenishment_deliveries`(`id`),
	CONSTRAINT `fk__ecommerce_replenishment_delivery_events_movement_id__ecommerce_stock_movements_id_fk` FOREIGN KEY (`movement_id`) REFERENCES `_ecommerce_stock_movements`(`id`),
	CONSTRAINT "replenishment_event_kind" CHECK("kind" IN ('received', 'cancelled')),
	CONSTRAINT "replenishment_event_movement" CHECK(("kind" = 'received') = ("movement_id" IS NOT NULL)),
	CONSTRAINT "replenishment_event_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "replenishment_event_reason" CHECK(length(trim("reason")) >= 8)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_replenishment_policies` (
	`id` text PRIMARY KEY,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`minimum_quantity` integer NOT NULL,
	`target_quantity` integer NOT NULL,
	`enabled` integer NOT NULL,
	`expected_version` text,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "replenishment_policy_target" CHECK("target_type" IN ('product', 'variant', 'stock', 'component')),
	CONSTRAINT "replenishment_policy_enabled" CHECK("enabled" IN (0, 1)),
	CONSTRAINT "replenishment_policy_quantities" CHECK("minimum_quantity" BETWEEN 0 AND 1000000 AND "target_quantity" BETWEEN "minimum_quantity" AND 1000000),
	CONSTRAINT "replenishment_policy_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "replenishment_policy_reason" CHECK(length(trim("reason")) >= 8)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_return_refund_decisions` (
	`id` text PRIMARY KEY,
	`receipt_id` text NOT NULL,
	`expected_version` text NOT NULL,
	`status` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`allocations` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`redacted_at` integer,
	CONSTRAINT `fk__ecommerce_return_refund_decisions_receipt_id__ecommerce_return_receipts_id_fk` FOREIGN KEY (`receipt_id`) REFERENCES `_ecommerce_return_receipts`(`id`),
	CONSTRAINT "return_refund_status" CHECK("status" IN ('needed', 'not_needed', 'settled')),
	CONSTRAINT "return_refund_amount" CHECK("amount_minor" BETWEEN 0 AND 9007199254740991 AND (("status" = 'not_needed' AND "amount_minor" = 0) OR ("status" <> 'not_needed' AND "amount_minor" > 0))),
	CONSTRAINT "return_refund_allocations" CHECK(json_valid("allocations") AND json_type("allocations") = 'array' AND json_array_length("allocations") <= 20 AND ("status" = 'settled' OR json_array_length("allocations") = 0)),
	CONSTRAINT "return_refund_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "return_refund_reason" CHECK(length(trim("reason")) >= 8)
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
	CONSTRAINT "email_delivery_kind" CHECK("kind" IN ('order_confirmation', 'shipment', 'shipment_update', 'gift_card_claim', 'return_decision', 'return_received')),
	CONSTRAINT "email_delivery_status" CHECK("status" IN ('pending', 'sent', 'failed', 'cancelled')),
	CONSTRAINT "email_delivery_attempts_nonnegative" CHECK("attempts" >= 0),
	CONSTRAINT "email_delivery_sent_has_time" CHECK(("status" = 'sent') = ("sent_at" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new__ecommerce_email_deliveries`(`id`, `kind`, `subject_id`, `status`, `attempts`, `last_error`, `next_attempt_at`, `claimed_at`, `sent_at`, `retry_requested_at`, `retry_request_id`, `created_at`) SELECT `id`, `kind`, `subject_id`, `status`, `attempts`, `last_error`, `next_attempt_at`, `claimed_at`, `sent_at`, `retry_requested_at`, `retry_request_id`, `created_at` FROM `_ecommerce_email_deliveries`;--> statement-breakpoint
DROP TABLE `_ecommerce_email_deliveries`;--> statement-breakpoint
ALTER TABLE `__new__ecommerce_email_deliveries` RENAME TO `_ecommerce_email_deliveries`;--> statement-breakpoint
--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_email_deliveries_kind_subject_unique` ON `_ecommerce_email_deliveries` (`kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_email_deliveries_attention_idx` ON `_ecommerce_email_deliveries` (`created_at`,`id`) WHERE "_ecommerce_email_deliveries"."status" = 'failed' OR ("_ecommerce_email_deliveries"."status" = 'pending' AND "_ecommerce_email_deliveries"."last_error" IS NOT NULL);--> statement-breakpoint
CREATE INDEX `_ecommerce_email_deliveries_due_idx` ON `_ecommerce_email_deliveries` (`next_attempt_at`) WHERE "_ecommerce_email_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `_ecommerce_replenishment_delivery_target_idx` ON `_ecommerce_replenishment_deliveries` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_replenishment_delivery_date_idx` ON `_ecommerce_replenishment_deliveries` (`expected_date`);--> statement-breakpoint
CREATE INDEX `_ecommerce_replenishment_event_delivery_idx` ON `_ecommerce_replenishment_delivery_events` (`delivery_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_replenishment_event_movement_unique` ON `_ecommerce_replenishment_delivery_events` (`movement_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_replenishment_policy_target_idx` ON `_ecommerce_replenishment_policies` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_return_refunds_receipt_idx` ON `_ecommerce_return_refund_decisions` (`receipt_id`);
--> statement-breakpoint
-- DROP/RENAME can leave SQLite's deferred counter stale after references resolve.
-- Validate actual references before restoring immediate checks, as in the earlier catalog rebuilds.
SELECT CASE WHEN EXISTS (SELECT 1 FROM pragma_foreign_key_check)
  THEN json('commerce migration foreign key check failed') ELSE 1 END;
--> statement-breakpoint
PRAGMA defer_foreign_keys = false;
