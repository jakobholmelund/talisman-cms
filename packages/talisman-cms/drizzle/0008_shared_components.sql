CREATE TABLE `_ecommerce_components` (
  `id` text PRIMARY KEY NOT NULL,
  `sku` text NOT NULL UNIQUE,
  `name` text NOT NULL,
  `quantity` integer NOT NULL DEFAULT 0 CHECK (`quantity` >= 0),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `_ecommerce_variant_components` (
  `id` text PRIMARY KEY NOT NULL,
  `product_variant_value_id` text NOT NULL REFERENCES `_ecommerce_product_variant_values`(`id`),
  `component_id` text NOT NULL REFERENCES `_ecommerce_components`(`id`),
  `quantity` integer NOT NULL DEFAULT 1 CHECK (`quantity` > 0),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `variant_component_unique` ON `_ecommerce_variant_components` (`product_variant_value_id`, `component_id`);--> statement-breakpoint
CREATE TABLE `_ecommerce_component_reservations` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL REFERENCES `_ecommerce_orders`(`id`),
  `component_id` text NOT NULL REFERENCES `_ecommerce_components`(`id`),
  `quantity` integer NOT NULL CHECK (`quantity` > 0),
  `released_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `component_reservation_unique` ON `_ecommerce_component_reservations` (`order_id`, `component_id`);
