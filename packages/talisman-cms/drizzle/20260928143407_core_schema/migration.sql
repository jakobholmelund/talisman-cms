CREATE TABLE `galaxy_collections` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`slug` text NOT NULL UNIQUE,
	`description` text,
	`fields` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `galaxy_entries` (
	`id` text PRIMARY KEY,
	`collection_id` text NOT NULL,
	`slug` text NOT NULL,
	`draft_slug` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`data` text NOT NULL,
	`published_data` text,
	`published_revision_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`published_at` integer,
	`archived_at` integer,
	CONSTRAINT `fk_galaxy_entries_collection_id_galaxy_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `galaxy_collections`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `galaxy_entry_revisions` (
	`id` text PRIMARY KEY,
	`entry_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_galaxy_entry_revisions_entry_id_galaxy_entries_id_fk` FOREIGN KEY (`entry_id`) REFERENCES `galaxy_entries`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_galaxy_entry_revisions_collection_id_galaxy_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `galaxy_collections`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `galaxy_globals` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`slug` text NOT NULL UNIQUE,
	`description` text,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `galaxy_media` (
	`id` text PRIMARY KEY,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`url` text NOT NULL,
	`alt_text` text,
	`width` integer,
	`height` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `galaxy_auth_account` (
	`id` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_galaxy_auth_account_user_id_galaxy_auth_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `galaxy_auth_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `galaxy_auth_rate_limit` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL UNIQUE,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `galaxy_auth_session` (
	`id` text PRIMARY KEY,
	`auth_method` text,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	CONSTRAINT `fk_galaxy_auth_session_user_id_galaxy_auth_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `galaxy_auth_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `galaxy_auth_user` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`role` text DEFAULT 'editor' NOT NULL,
	`banned` integer DEFAULT false NOT NULL,
	`ban_reason` text,
	`ban_expires` integer
);
--> statement-breakpoint
CREATE TABLE `galaxy_auth_verification` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `galaxy_entries_collection_status_created_idx` ON `galaxy_entries` (`collection_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `galaxy_entries_collection_status_slug_idx` ON `galaxy_entries` (`collection_id`,`status`,`slug`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `galaxy_entries_published_slug_unique` ON `galaxy_entries` (`collection_id`,`slug`) WHERE "galaxy_entries"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX `galaxy_entry_revisions_entry_number_idx` ON `galaxy_entry_revisions` (`entry_id`,`revision_number`);--> statement-breakpoint
CREATE INDEX `galaxy_auth_account_user_idx` ON `galaxy_auth_account` (`user_id`);--> statement-breakpoint
CREATE INDEX `galaxy_auth_session_user_idx` ON `galaxy_auth_session` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `galaxy_auth_user_email_lower_unique` ON `galaxy_auth_user` (lower("email"));--> statement-breakpoint
CREATE INDEX `galaxy_auth_verification_identifier_idx` ON `galaxy_auth_verification` (`identifier`,`created_at`);