-- Shipping is recorded apart from payment: `status` stays the payment lifecycle, so a refund no
-- longer hides that an order shipped, and a partially refunded order can still ship.
ALTER TABLE `_ecommerce_orders` ADD COLUMN `fulfillment_status` text NOT NULL DEFAULT 'unfulfilled'
  CHECK (`fulfillment_status` IN ('unfulfilled','partially_fulfilled','fulfilled'));--> statement-breakpoint
-- 0017 allowed one shipment record per order, and it completed the order. An order in status
-- 'fulfilled' was paid in full and never refunded (the 0017 guard accepted only 'paid', and every
-- refund moves an order to a refund status), so it returns to 'paid'.
UPDATE `_ecommerce_orders` SET `fulfillment_status` = 'fulfilled'
  WHERE `status` = 'fulfilled' OR `id` IN (SELECT `order_id` FROM `_ecommerce_fulfillments`);--> statement-breakpoint
UPDATE `_ecommerce_orders` SET `status` = 'paid' WHERE `status` = 'fulfilled';--> statement-breakpoint
-- Rebuilt without UNIQUE(order_id), so an order can ship in several parcels and a shipment can be
-- corrected by appending a row that names it; rows are never updated or deleted. `note` holds the
-- shipment note or the correction's reason. Existing rows keep their ids and become shipments that
-- completed their order. The 0017 triggers go with the old table, which nothing else references;
-- `corrects_id` names the new table, and the rename carries that reference over.
CREATE TABLE `_ecommerce_fulfillments_new` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL REFERENCES `_ecommerce_orders`(`id`),
  `admin_actor` text NOT NULL,
  `carrier` text,
  `tracking_number` text,
  `note` text NOT NULL,
  `created_at` integer NOT NULL,
  `kind` text NOT NULL DEFAULT 'shipment' CHECK (`kind` IN ('shipment','correction')),
  `corrects_id` text REFERENCES `_ecommerce_fulfillments_new`(`id`),
  `completes_order` integer NOT NULL DEFAULT 1 CHECK (`completes_order` IN (0,1)),
  CHECK ((`kind` = 'shipment') = (`corrects_id` IS NULL)),
  CHECK (`kind` = 'shipment' OR `completes_order` = 0)
);--> statement-breakpoint
INSERT INTO `_ecommerce_fulfillments_new`
  (`id`, `order_id`, `admin_actor`, `carrier`, `tracking_number`, `note`, `created_at`, `kind`, `corrects_id`, `completes_order`)
  SELECT `id`, `order_id`, `admin_actor`, `carrier`, `tracking_number`, `note`, `created_at`, 'shipment', NULL, 1
  FROM `_ecommerce_fulfillments` ORDER BY `rowid`;--> statement-breakpoint
DROP TABLE `_ecommerce_fulfillments`;--> statement-breakpoint
ALTER TABLE `_ecommerce_fulfillments_new` RENAME TO `_ecommerce_fulfillments`;--> statement-breakpoint
CREATE INDEX `_ecommerce_fulfillments_order_idx` ON `_ecommerce_fulfillments` (`order_id`, `created_at`);--> statement-breakpoint
-- A shipment needs a paid real order that has not shipped in full: pending, cancelled, refunded and
-- disputed orders are refused. What the previous Worker inserts is a completing shipment.
CREATE TRIGGER `_ecommerce_fulfillment_guard` BEFORE INSERT ON `_ecommerce_fulfillments`
WHEN NEW.`kind` = 'shipment' AND NOT EXISTS (
  SELECT 1 FROM `_ecommerce_orders` o WHERE o.id = NEW.order_id
    AND o.status IN ('paid','partially_refunded') AND o.fulfillment_status <> 'fulfilled'
    AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'
    AND length(trim(NEW.admin_actor)) > 0 AND length(trim(NEW.note)) >= 8
)
BEGIN SELECT RAISE(ABORT, 'Order is not ready for fulfillment'); END;--> statement-breakpoint
-- A correction restates the carrier and tracking number of a shipment of the same order, with who
-- made it and why. It ships nothing, so any payment status allows it, but admin test orders do not.
CREATE TRIGGER `_ecommerce_fulfillment_correction_guard` BEFORE INSERT ON `_ecommerce_fulfillments`
WHEN NEW.`kind` = 'correction' AND NOT EXISTS (
  SELECT 1 FROM `_ecommerce_fulfillments` s JOIN `_ecommerce_orders` o ON o.id = s.order_id
  WHERE s.id = NEW.corrects_id AND s.kind = 'shipment' AND s.order_id = NEW.order_id
    AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'
    AND length(trim(NEW.admin_actor)) > 0 AND length(trim(NEW.note)) >= 8
    AND (length(trim(COALESCE(NEW.carrier, ''))) > 0 OR length(trim(COALESCE(NEW.tracking_number, ''))) > 0)
)
BEGIN SELECT RAISE(ABORT, 'Shipment cannot be corrected'); END;--> statement-breakpoint
-- A shipment moves the fulfillment status, never the payment status, so refunds and disputes keep it.
CREATE TRIGGER `_ecommerce_fulfillment_complete` AFTER INSERT ON `_ecommerce_fulfillments`
WHEN NEW.`kind` = 'shipment'
BEGIN
  UPDATE `_ecommerce_orders`
    SET `updated_at` = MAX(`updated_at` + 1, NEW.created_at),
      `fulfillment_status` = CASE WHEN NEW.completes_order = 1 THEN 'fulfilled' ELSE 'partially_fulfilled' END
    WHERE `id` = NEW.order_id AND `fulfillment_status` <> 'fulfilled';
END;--> statement-breakpoint
-- The orders queue: real orders that can still ship, oldest first, and their count. A query uses a
-- partial index only when it repeats these conditions word for word.
CREATE INDEX `_ecommerce_orders_awaiting_idx` ON `_ecommerce_orders` (`created_at`, `id`)
  WHERE `status` IN ('paid','partially_refunded') AND `fulfillment_status` <> 'fulfilled'
    AND COALESCE(`payment_provider`, 'stripe') <> 'admin_test';--> statement-breakpoint
-- Recent real orders past checkout, newest first.
CREATE INDEX `_ecommerce_orders_recent_idx` ON `_ecommerce_orders` (`created_at`, `id`)
  WHERE `status` NOT IN ('pending','cancelled','draft') AND COALESCE(`payment_provider`, 'stripe') <> 'admin_test';
