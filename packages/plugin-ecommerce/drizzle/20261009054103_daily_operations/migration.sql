CREATE TABLE `_ecommerce_email_recovery_decisions` (
	`id` text PRIMARY KEY,
	`email_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`prior_attempts` integer NOT NULL,
	`prior_error` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_email_recovery_decisions_email_id__ecommerce_email_deliveries_id_fk` FOREIGN KEY (`email_id`) REFERENCES `_ecommerce_email_deliveries`(`id`),
	CONSTRAINT "email_recovery_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "email_recovery_reason" CHECK(length(trim("reason")) >= 8),
	CONSTRAINT "email_recovery_attempts" CHECK("prior_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE `_ecommerce_email_deliveries` ADD `retry_requested_at` integer;--> statement-breakpoint
ALTER TABLE `_ecommerce_email_deliveries` ADD `retry_request_id` text;--> statement-breakpoint
CREATE INDEX `_ecommerce_email_deliveries_attention_idx` ON `_ecommerce_email_deliveries` (`created_at`,`id`) WHERE "_ecommerce_email_deliveries"."status" = 'failed' OR ("_ecommerce_email_deliveries"."status" = 'pending' AND "_ecommerce_email_deliveries"."last_error" IS NOT NULL);--> statement-breakpoint
CREATE INDEX `_ecommerce_email_recovery_recent_idx` ON `_ecommerce_email_recovery_decisions` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_email_recovery_email_idx` ON `_ecommerce_email_recovery_decisions` (`email_id`,`created_at`);