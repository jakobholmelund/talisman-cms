CREATE TABLE `_stripe_sync` (
	`id` text PRIMARY KEY,
	`collection` text NOT NULL,
	`resource` text NOT NULL,
	`identity` text NOT NULL,
	`stripe_id` text,
	`doc_id` text,
	`state` text DEFAULT 'ready' NOT NULL,
	`operation` text DEFAULT '' NOT NULL,
	`payload_hash` text DEFAULT '' NOT NULL,
	`started_at` integer,
	`lease_until` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "stripe_sync_state" CHECK("state" IN ('ready', 'pending', 'blocked', 'deleted')),
	CONSTRAINT "stripe_sync_attempts" CHECK("attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_sync_identity` ON `_stripe_sync` (`collection`,`resource`,`identity`);