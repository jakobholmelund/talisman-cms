CREATE TABLE `_ecommerce_supplier_issue_events` (
	`id` text PRIMARY KEY,
	`issue_id` text NOT NULL,
	`expected_version` text NOT NULL,
	`status` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_supplier_issue_events_issue_id__ecommerce_supplier_issues_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `_ecommerce_supplier_issues`(`id`),
	CONSTRAINT "supplier_issue_event_status" CHECK("status" IN ('open', 'resolved')),
	CONSTRAINT "supplier_issue_event_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "supplier_issue_event_reason" CHECK(length(trim("reason")) >= 8),
	CONSTRAINT "supplier_issue_event_reason_length" CHECK(length("reason") <= 500)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_supplier_issues` (
	`id` text PRIMARY KEY,
	`purchase_line_id` text NOT NULL,
	`kind` text NOT NULL,
	`quantity` integer NOT NULL,
	`expected_purchase_version` text NOT NULL,
	`expected_delivery_version` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_supplier_issues_purchase_line_id__ecommerce_purchase_order_lines_id_fk` FOREIGN KEY (`purchase_line_id`) REFERENCES `_ecommerce_purchase_order_lines`(`id`),
	CONSTRAINT "supplier_issue_kind" CHECK("kind" IN ('short', 'damaged', 'incorrect')),
	CONSTRAINT "supplier_issue_quantity" CHECK("quantity" BETWEEN 1 AND 1000000),
	CONSTRAINT "supplier_issue_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "supplier_issue_reason" CHECK(length(trim("reason")) >= 8),
	CONSTRAINT "supplier_issue_reason_length" CHECK(length("reason") <= 500)
);
--> statement-breakpoint
CREATE INDEX `_ecommerce_supplier_issue_event_issue_idx` ON `_ecommerce_supplier_issue_events` (`issue_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_supplier_issue_line_idx` ON `_ecommerce_supplier_issues` (`purchase_line_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_supplier_issue_date_idx` ON `_ecommerce_supplier_issues` (`created_at`,`id`);