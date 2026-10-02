PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_galaxy_auth_user` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`role` text DEFAULT 'customer' NOT NULL,
	`banned` integer DEFAULT false NOT NULL,
	`ban_reason` text,
	`ban_expires` integer
);
--> statement-breakpoint
INSERT INTO `__new_galaxy_auth_user`(`id`, `name`, `email`, `email_verified`, `image`, `created_at`, `updated_at`, `role`, `banned`, `ban_reason`, `ban_expires`) SELECT `id`, `name`, `email`, `email_verified`, `image`, `created_at`, `updated_at`, `role`, `banned`, `ban_reason`, `ban_expires` FROM `galaxy_auth_user`;--> statement-breakpoint
DROP TABLE `galaxy_auth_user`;--> statement-breakpoint
ALTER TABLE `__new_galaxy_auth_user` RENAME TO `galaxy_auth_user`;--> statement-breakpoint
CREATE UNIQUE INDEX `galaxy_auth_user_email_lower_unique` ON `galaxy_auth_user` (lower("email"));