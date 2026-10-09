CREATE TABLE `_ecommerce_recovery_inspections` (
	`id` text PRIMARY KEY,
	`receipt_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`disposition` text NOT NULL,
	`restock` integer NOT NULL,
	`stock` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`redacted_at` integer,
	CONSTRAINT `fk__ecommerce_recovery_inspections_receipt_id__ecommerce_recovery_receipts_id_fk` FOREIGN KEY (`receipt_id`) REFERENCES `_ecommerce_recovery_receipts`(`id`),
	CONSTRAINT "recovery_inspection_quantity" CHECK("quantity" BETWEEN 1 AND 1000000),
	CONSTRAINT "recovery_inspection_disposition" CHECK("disposition" IN ('sellable', 'quarantine', 'damaged')),
	CONSTRAINT "recovery_inspection_restock" CHECK("restock" IN (0,1) AND ("restock"=0 OR "disposition"='sellable')),
	CONSTRAINT "recovery_inspection_stock" CHECK(json_valid("stock") AND json_type("stock")='array' AND json_array_length("stock")<=50 AND ("restock"=1 OR json_array_length("stock")=0)),
	CONSTRAINT "recovery_inspection_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "recovery_inspection_reason" CHECK(length(trim("reason")) >= 8),
	CONSTRAINT "recovery_inspection_reason_length" CHECK(length("reason")<=500)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_recovery_payment_events` (
	`id` text PRIMARY KEY,
	`payment_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_recovery_payment_events_payment_id__ecommerce_recovery_payments_id_fk` FOREIGN KEY (`payment_id`) REFERENCES `_ecommerce_recovery_payments`(`id`),
	CONSTRAINT "recovery_payment_event_kind" CHECK("kind" IN ('refunded', 'disputed', 'lost', 'won'))
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_recovery_payments` (
	`id` text PRIMARY KEY,
	`case_id` text NOT NULL,
	`expected_version` text NOT NULL,
	`provider` text NOT NULL,
	`payment_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`redacted_at` integer,
	CONSTRAINT `fk__ecommerce_recovery_payments_case_id__ecommerce_recovery_cases_id_fk` FOREIGN KEY (`case_id`) REFERENCES `_ecommerce_recovery_cases`(`id`),
	CONSTRAINT "recovery_payment_amount" CHECK("amount_minor" BETWEEN 1 AND 1000000000),
	CONSTRAINT "recovery_payment_currency" CHECK(length("currency")=3),
	CONSTRAINT "recovery_payment_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "recovery_payment_reason" CHECK(length(trim("reason")) >= 8),
	CONSTRAINT "recovery_payment_reason_length" CHECK(length("reason")<=500)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_recovery_receipts` (
	`id` text PRIMARY KEY,
	`shipment_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`redacted_at` integer,
	CONSTRAINT `fk__ecommerce_recovery_receipts_shipment_id__ecommerce_recovery_shipments_id_fk` FOREIGN KEY (`shipment_id`) REFERENCES `_ecommerce_recovery_shipments`(`id`),
	CONSTRAINT "recovery_receipt_quantity" CHECK("quantity" BETWEEN 1 AND 1000000),
	CONSTRAINT "recovery_receipt_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "recovery_receipt_reason" CHECK(length(trim("reason")) >= 8),
	CONSTRAINT "recovery_receipt_reason_length" CHECK(length("reason")<=500)
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
	CONSTRAINT "email_delivery_kind" CHECK("kind" IN ('order_confirmation', 'shipment', 'shipment_update', 'gift_card_claim', 'return_decision', 'return_received', 'return_refund', 'recovery_shipment', 'recovery_tracking', 'recovery_received')),
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
CREATE INDEX `_ecommerce_recovery_inspection_receipt_idx` ON `_ecommerce_recovery_inspections` (`receipt_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_recovery_payment_event_payment_idx` ON `_ecommerce_recovery_payment_events` (`payment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_recovery_payment_version_unique` ON `_ecommerce_recovery_payments` (`case_id`,`expected_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_recovery_payment_provider_unique` ON `_ecommerce_recovery_payments` (`provider`,`payment_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_recovery_receipt_shipment_idx` ON `_ecommerce_recovery_receipts` (`shipment_id`);
--> statement-breakpoint
SELECT CASE WHEN EXISTS (SELECT 1 FROM pragma_foreign_key_check) THEN json('recovery migration foreign key check failed') ELSE 1 END;
--> statement-breakpoint
PRAGMA defer_foreign_keys = false;
