ALTER TABLE `_ecommerce_carts` ADD COLUMN `version` integer NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE TABLE `_ecommerce_inventory_reservations` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL REFERENCES `_ecommerce_orders`(`id`),
  `target_type` text NOT NULL CHECK (`target_type` IN ('product', 'variant', 'stock')),
  `target_id` text NOT NULL,
  `quantity` integer NOT NULL CHECK (`quantity` > 0),
  `released_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_reservation_unique` ON `_ecommerce_inventory_reservations` (`order_id`, `target_type`, `target_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_payments_provider_id_unique` ON `_ecommerce_payments` (`provider`, `provider_id`);--> statement-breakpoint
CREATE TRIGGER `_ecommerce_products_stock_nonnegative` BEFORE UPDATE OF `inventory_quantity` ON `_ecommerce_products`
WHEN NEW.`inventory_quantity` < 0 BEGIN SELECT RAISE(ABORT, 'Insufficient product stock'); END;--> statement-breakpoint
CREATE TRIGGER `_ecommerce_variants_stock_nonnegative` BEFORE UPDATE OF `inventory_quantity` ON `_ecommerce_product_variants`
WHEN NEW.`inventory_quantity` < 0 BEGIN SELECT RAISE(ABORT, 'Insufficient variant stock'); END;--> statement-breakpoint
CREATE TRIGGER `_ecommerce_stocks_nonnegative` BEFORE UPDATE OF `quantity` ON `_ecommerce_stocks`
WHEN NEW.`quantity` < 0 BEGIN SELECT RAISE(ABORT, 'Insufficient variant value stock'); END;
