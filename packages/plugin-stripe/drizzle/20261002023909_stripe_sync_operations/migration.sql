CREATE TABLE `_stripe_sync_operations` (
	`id` text PRIMARY KEY,
	`sync_id` text NOT NULL,
	`method` text NOT NULL,
	`stripe_id` text,
	`payload_hash` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk__stripe_sync_operations_sync_id__stripe_sync_id_fk` FOREIGN KEY (`sync_id`) REFERENCES `_stripe_sync`(`id`)
);
