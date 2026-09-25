CREATE TABLE `_ecommerce_fulfillments` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL UNIQUE REFERENCES `_ecommerce_orders`(`id`),
  `admin_actor` text NOT NULL,
  `carrier` text,
  `tracking_number` text,
  `note` text NOT NULL,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE TRIGGER `_ecommerce_fulfillment_guard` BEFORE INSERT ON `_ecommerce_fulfillments`
WHEN NOT EXISTS (
  SELECT 1 FROM `_ecommerce_orders` o WHERE o.id = NEW.order_id
    AND o.status = 'paid' AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'
    AND length(trim(NEW.admin_actor)) > 0 AND length(trim(NEW.note)) >= 8
)
BEGIN SELECT RAISE(ABORT, 'Order is not ready for fulfillment'); END;--> statement-breakpoint
CREATE TRIGGER `_ecommerce_fulfillment_complete` AFTER INSERT ON `_ecommerce_fulfillments`
BEGIN
  UPDATE `_ecommerce_orders` SET `status` = 'fulfilled', `updated_at` = NEW.created_at
    WHERE `id` = NEW.order_id AND `status` = 'paid';
END;
