ALTER TABLE `_ecommerce_orders` ADD COLUMN `discount_code` text;--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `discount_amount` integer NOT NULL DEFAULT 0 CHECK (`discount_amount` >= 0);--> statement-breakpoint
CREATE TABLE `_ecommerce_referral_settings` (
  `id` text PRIMARY KEY NOT NULL CHECK (`id` = 'default'),
  `enabled` integer NOT NULL DEFAULT 1 CHECK (`enabled` IN (0, 1)),
  `reward_cents` integer NOT NULL DEFAULT 1000 CHECK (`reward_cents` BETWEEN 1 AND 100000),
  `min_order_cents` integer NOT NULL DEFAULT 5000 CHECK (`min_order_cents` BETWEEN 1 AND 10000000),
  `attribution_days` integer NOT NULL DEFAULT 30 CHECK (`attribution_days` BETWEEN 1 AND 90),
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `_ecommerce_discount_codes` (
  `code` text PRIMARY KEY NOT NULL,
  `description` text,
  `type` text NOT NULL CHECK (`type` IN ('credit', 'amount', 'percent')),
  `value` integer NOT NULL CHECK (`value` > 0),
  `remaining_cents` integer CHECK (`remaining_cents` >= 0),
  `max_discount_cents` integer CHECK (`max_discount_cents` > 0),
  `min_order_cents` integer NOT NULL DEFAULT 0 CHECK (`min_order_cents` >= 0),
  `eligible_product_ids` text NOT NULL DEFAULT '[]',
  `max_uses` integer CHECK (`max_uses` > 0),
  `max_uses_per_customer` integer CHECK (`max_uses_per_customer` > 0),
  `first_order_only` integer NOT NULL DEFAULT 0 CHECK (`first_order_only` IN (0, 1)),
  `starts_at` integer,
  `expires_at` integer,
  `active` integer NOT NULL DEFAULT 1 CHECK (`active` IN (0, 1)),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK ((`type` = 'credit' AND `remaining_cents` IS NOT NULL AND `remaining_cents` <= `value` AND `max_discount_cents` IS NULL)
    OR (`type` = 'amount' AND `remaining_cents` IS NULL AND `max_discount_cents` IS NULL)
    OR (`type` = 'percent' AND `value` BETWEEN 1 AND 10000 AND `remaining_cents` IS NULL))
);--> statement-breakpoint
CREATE TABLE `_ecommerce_discount_redemptions` (
  `id` text PRIMARY KEY NOT NULL,
  `code` text NOT NULL REFERENCES `_ecommerce_discount_codes`(`code`),
  `order_id` text NOT NULL UNIQUE REFERENCES `_ecommerce_orders`(`id`),
  `account_id` text REFERENCES `_ecommerce_customer_accounts`(`id`),
  `email_normalized` text NOT NULL,
  `amount_cents` integer NOT NULL CHECK (`amount_cents` > 0),
  `status` text NOT NULL DEFAULT 'reserved' CHECK (`status` IN ('reserved', 'confirmed', 'cancelled', 'refunded')),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `_ecommerce_discount_redemptions_code_status_idx` ON `_ecommerce_discount_redemptions` (`code`, `status`);--> statement-breakpoint
CREATE INDEX `_ecommerce_discount_redemptions_email_idx` ON `_ecommerce_discount_redemptions` (`code`, `email_normalized`, `status`);--> statement-breakpoint
CREATE TRIGGER `_ecommerce_discount_reserve_guard` BEFORE INSERT ON `_ecommerce_discount_redemptions`
WHEN NOT EXISTS (
  SELECT 1 FROM `_ecommerce_discount_codes` c
  JOIN `_ecommerce_orders` o ON o.id = NEW.order_id
  WHERE c.code = NEW.code AND c.active = 1
    AND (c.starts_at IS NULL OR c.starts_at <= NEW.created_at)
    AND (c.expires_at IS NULL OR c.expires_at > NEW.created_at)
    AND o.status = 'pending' AND o.discount_code = NEW.code
    AND o.discount_amount = NEW.amount_cents
    AND o.subtotal_amount = o.discount_amount + o.credit_applied + o.total_amount
    AND (c.type <> 'credit' OR c.remaining_cents >= NEW.amount_cents)
    AND (c.first_order_only = 0 OR (
      NOT EXISTS (SELECT 1 FROM `_ecommerce_customer_accounts` a WHERE a.email_normalized = NEW.email_normalized)
      AND NOT EXISTS (SELECT 1 FROM `_ecommerce_discount_redemptions` r
        JOIN `_ecommerce_discount_codes` other ON other.code = r.code AND other.first_order_only = 1
        WHERE r.email_normalized = NEW.email_normalized AND r.status IN ('reserved', 'confirmed'))
    ))
    AND (c.max_uses IS NULL OR (SELECT COUNT(*) FROM `_ecommerce_discount_redemptions` r
      WHERE r.code = NEW.code AND r.status IN ('reserved', 'confirmed')) < c.max_uses)
    AND (c.max_uses_per_customer IS NULL OR (SELECT COUNT(*) FROM `_ecommerce_discount_redemptions` r
      WHERE r.code = NEW.code AND r.email_normalized = NEW.email_normalized
        AND r.status IN ('reserved', 'confirmed')) < c.max_uses_per_customer)
)
BEGIN
  SELECT RAISE(ABORT, 'Discount code is no longer available');
END;--> statement-breakpoint
CREATE TRIGGER `_ecommerce_discount_credit_reserve` AFTER INSERT ON `_ecommerce_discount_redemptions`
WHEN (SELECT `type` FROM `_ecommerce_discount_codes` WHERE `code` = NEW.code) = 'credit'
BEGIN
  UPDATE `_ecommerce_discount_codes` SET `remaining_cents` = `remaining_cents` - NEW.amount_cents
    WHERE `code` = NEW.code;
END;--> statement-breakpoint
CREATE TRIGGER `_ecommerce_discount_credit_release` AFTER UPDATE OF `status` ON `_ecommerce_discount_redemptions`
WHEN OLD.status IN ('reserved', 'confirmed') AND NEW.status IN ('cancelled', 'refunded')
  AND (SELECT `type` FROM `_ecommerce_discount_codes` WHERE `code` = NEW.code) = 'credit'
BEGIN
  UPDATE `_ecommerce_discount_codes` SET `remaining_cents` = `remaining_cents` + NEW.amount_cents
    WHERE `code` = NEW.code;
END;
