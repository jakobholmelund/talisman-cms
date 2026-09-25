CREATE TABLE `_ecommerce_carts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_token` text,
	`user_id` text,
	`checkout_session_id` text,
	`items` text DEFAULT '[]' NOT NULL,
	`closed` integer DEFAULT false NOT NULL,
	`closed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_carts_session_token_unique` ON `_ecommerce_carts` (`session_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_carts_checkout_session_id_unique` ON `_ecommerce_carts` (`checkout_session_id`);--> statement-breakpoint
CREATE TABLE `_ecommerce_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`image` text,
	`parent_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `_ecommerce_categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_categories_slug_unique` ON `_ecommerce_categories` (`slug`);--> statement-breakpoint
CREATE TABLE `_ecommerce_customers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`email` text,
	`stripe_customer_id` text,
	`user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_customers_stripe_customer_id_unique` ON `_ecommerce_customers` (`stripe_customer_id`);--> statement-breakpoint
CREATE TABLE `_ecommerce_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`cart_id` text,
	`user_id` text,
	`checkout_session_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`total_amount` integer NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`customer_email` text,
	`shipping_address` text,
	`billing_address` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`cart_id`) REFERENCES `_ecommerce_carts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_orders_cart_id_unique` ON `_ecommerce_orders` (`cart_id`);--> statement-breakpoint
CREATE TABLE `_ecommerce_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_id` text NOT NULL,
	`status` text NOT NULL,
	`amount` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_product_categories` (
	`product_id` text NOT NULL,
	`category_id` text NOT NULL,
	PRIMARY KEY(`product_id`, `category_id`),
	FOREIGN KEY (`product_id`) REFERENCES `_ecommerce_products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `_ecommerce_categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_product_tags` (
	`product_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`product_id`, `tag_id`),
	FOREIGN KEY (`product_id`) REFERENCES `_ecommerce_products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tag_id`) REFERENCES `_ecommerce_tags`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_product_variant_values` (
	`id` text PRIMARY KEY NOT NULL,
	`product_variant_id` text NOT NULL,
	`value` text NOT NULL,
	`sku` text,
	`price_override` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`product_variant_id`) REFERENCES `_ecommerce_product_variants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_product_variant_values_sku_unique` ON `_ecommerce_product_variant_values` (`sku`);--> statement-breakpoint
CREATE TABLE `_ecommerce_product_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`name` text NOT NULL,
	`sku` text,
	`price_override` integer,
	`inventory_quantity` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `_ecommerce_products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `_ecommerce_variants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_product_variants_sku_unique` ON `_ecommerce_product_variants` (`sku`);--> statement-breakpoint
CREATE TABLE `_ecommerce_products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`sku` text,
	`description` text,
	`images` text DEFAULT '[]' NOT NULL,
	`category_ids` text DEFAULT '[]' NOT NULL,
	`tag_ids` text DEFAULT '[]' NOT NULL,
	`base_price` integer DEFAULT 0 NOT NULL,
	`is_physical` integer DEFAULT true NOT NULL,
	`inventory_quantity` integer DEFAULT 0 NOT NULL,
	`type` text DEFAULT 'standard' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_products_slug_unique` ON `_ecommerce_products` (`slug`);--> statement-breakpoint
CREATE TABLE `_ecommerce_stocks` (
	`id` text PRIMARY KEY NOT NULL,
	`product_variant_value_id` text NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`product_variant_value_id`) REFERENCES `_ecommerce_product_variant_values`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_stocks_product_variant_value_id_unique` ON `_ecommerce_stocks` (`product_variant_value_id`);--> statement-breakpoint
CREATE TABLE `_ecommerce_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'blue' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_tags_name_unique` ON `_ecommerce_tags` (`name`);--> statement-breakpoint
CREATE TABLE `_ecommerce_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_variants_name_unique` ON `_ecommerce_variants` (`name`);