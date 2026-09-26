-- One row for each rise in an order's payment provider refund total, dated when the provider issued
-- the refund, so reports count a refund on that date. From this migration on, the rows of an order add
-- up to its provider_refunded_cents; refunds recorded before it have no row and keep being reported on
-- the payment date. `created_at` is NULL when the date is unknown. Nothing writes here before this
-- release, so the previous Worker is unaffected.
CREATE TABLE `_ecommerce_provider_refunds` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL REFERENCES `_ecommerce_orders`(`id`),
  `provider` text NOT NULL,
  `provider_refund_id` text,
  `amount_cents` integer NOT NULL CHECK (`amount_cents` > 0),
  `created_at` integer
);--> statement-breakpoint
CREATE INDEX `_ecommerce_provider_refunds_order_idx` ON `_ecommerce_provider_refunds` (`order_id`);--> statement-breakpoint
-- Payment disputes (chargebacks and inquiries) by the provider's dispute id, each on one order or one
-- gift card purchase. `status_before` is the status the order or purchase had before the dispute, which
-- a won dispute restores; `closed_at` stays NULL while the dispute is open. A disputed order has status
-- 'disputed', which the fulfillment guard from 0026 already refuses; orders.status has no CHECK, so the
-- value needs no schema change.
CREATE TABLE `_ecommerce_disputes` (
  `id` text PRIMARY KEY NOT NULL,
  `provider` text NOT NULL,
  `order_id` text REFERENCES `_ecommerce_orders`(`id`),
  `gift_card_purchase_id` text REFERENCES `_ecommerce_gift_card_purchases`(`id`),
  `amount_cents` integer NOT NULL CHECK (`amount_cents` >= 0),
  `currency` text NOT NULL,
  `reason` text,
  `status` text NOT NULL,
  `status_before` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `closed_at` integer,
  CHECK ((`order_id` IS NULL) <> (`gift_card_purchase_id` IS NULL))
);--> statement-breakpoint
CREATE INDEX `_ecommerce_disputes_order_idx` ON `_ecommerce_disputes` (`order_id`)
  WHERE `order_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `_ecommerce_disputes_purchase_idx` ON `_ecommerce_disputes` (`gift_card_purchase_id`)
  WHERE `gift_card_purchase_id` IS NOT NULL;--> statement-breakpoint
-- An administrator's restock of a refunded order: one row for each reservation row returned to stock,
-- with who returned it and why. The returned reservation row is marked released, and the unique key
-- keeps any reservation row from being returned twice.
CREATE TABLE `_ecommerce_restocks` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL REFERENCES `_ecommerce_orders`(`id`),
  `reservation_type` text NOT NULL CHECK (`reservation_type` IN ('inventory','component')),
  `reservation_id` text NOT NULL,
  `target_type` text NOT NULL CHECK (`target_type` IN ('product','variant','stock','component')),
  `target_id` text NOT NULL,
  `quantity` integer NOT NULL CHECK (`quantity` > 0),
  `admin_actor` text NOT NULL CHECK (length(trim(`admin_actor`)) > 0),
  `reason` text NOT NULL CHECK (length(trim(`reason`)) >= 8),
  `created_at` integer NOT NULL,
  UNIQUE (`reservation_type`, `reservation_id`)
);--> statement-breakpoint
CREATE INDEX `_ecommerce_restocks_order_idx` ON `_ecommerce_restocks` (`order_id`, `created_at`);
