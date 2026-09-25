CREATE TABLE `_ecommerce_customer_accounts` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL,
  `email_normalized` text NOT NULL UNIQUE,
  `email_verified_at` integer,
  `name` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `_ecommerce_customer_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `account_id` text NOT NULL REFERENCES `_ecommerce_customer_accounts`(`id`) ON DELETE CASCADE,
  `order_id` text UNIQUE,
  `token_hash` text NOT NULL UNIQUE,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `revoked_at` integer
);--> statement-breakpoint
CREATE INDEX `_ecommerce_customer_sessions_account_idx` ON `_ecommerce_customer_sessions` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_carts_user_open_unique` ON `_ecommerce_carts` (`user_id`)
  WHERE `closed` = 0 AND `user_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_user_idx` ON `_ecommerce_orders` (`user_id`);
