-- Orders record the shipping and tax that checkout charges, in the order currency's minor units.
-- Stripe Tax adds `exclusive` tax to what the shopper pays; `inclusive` tax is already part of the
-- item and shipping amounts and is only recorded. Orders placed before this migration have neither.
ALTER TABLE `_ecommerce_orders` ADD COLUMN `shipping_amount` integer NOT NULL DEFAULT 0 CHECK (`shipping_amount` >= 0);--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `shipping_rate_id` text;--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `shipping_label` text;--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `tax_amount` integer NOT NULL DEFAULT 0 CHECK (`tax_amount` >= 0);--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `tax_behavior` text CHECK (`tax_behavior` IS NULL OR `tax_behavior` IN ('inclusive','exclusive'));--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `tax_calculation_id` text;--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `tax_transaction_id` text;--> statement-breakpoint
-- Taxed orders whose tax transaction is not recorded yet; reconcileCommerce records it for the paid
-- ones. The status leads so that the lookup skips pending and cancelled orders. SQLite uses a partial
-- index only for a query that repeats both of its conditions.
CREATE INDEX `_ecommerce_orders_tax_transaction_missing_idx` ON `_ecommerce_orders` (`status`, `created_at`)
  WHERE `tax_calculation_id` IS NOT NULL AND `tax_transaction_id` IS NULL;--> statement-breakpoint
-- Refunds are mirrored as partial reversals of the order's tax transaction. The reference names the
-- order and the reversed total that the reversal brings it to, so a retry never reverses a refund twice.
CREATE TABLE `_ecommerce_tax_reversals` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL REFERENCES `_ecommerce_orders`(`id`),
  `reference` text NOT NULL UNIQUE,
  `amount` integer NOT NULL CHECK (`amount` > 0),
  `provider_reversal_id` text NOT NULL,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `_ecommerce_tax_reversals_order_idx` ON `_ecommerce_tax_reversals` (`order_id`);--> statement-breakpoint
-- The redemption guards check that an order's totals balance, and the totals now include shipping
-- and exclusive tax. Apart from that line, both guards are unchanged from 0015 and 0024.
DROP TRIGGER `_ecommerce_gift_card_reserve_guard`;--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_reserve_guard` BEFORE INSERT ON `_ecommerce_gift_card_redemptions`
WHEN NOT EXISTS (
  SELECT 1 FROM `_ecommerce_gift_cards` c JOIN `_ecommerce_orders` o ON o.id = NEW.order_id
  WHERE c.id = NEW.card_id AND c.status = 'active' AND c.currency = o.currency
    AND c.balance_cents >= NEW.amount_cents AND o.status = 'pending'
    AND o.gift_card_id = c.id AND o.gift_card_applied = NEW.amount_cents
    AND o.subtotal_amount + o.shipping_amount + CASE WHEN o.tax_behavior = 'exclusive' THEN o.tax_amount ELSE 0 END
      = o.discount_amount + o.credit_applied + o.gift_card_applied + o.total_amount
)
BEGIN SELECT RAISE(ABORT, 'Gift card is no longer available'); END;--> statement-breakpoint
DROP TRIGGER `_ecommerce_discount_reserve_guard`;--> statement-breakpoint
CREATE TRIGGER `_ecommerce_discount_reserve_guard` BEFORE INSERT ON `_ecommerce_discount_redemptions`
WHEN NOT EXISTS (
  SELECT 1 FROM `_ecommerce_discount_codes` c JOIN `_ecommerce_orders` o ON o.id = NEW.order_id
  WHERE c.code = NEW.code AND c.active = 1
    AND (c.starts_at IS NULL OR c.starts_at <= NEW.created_at)
    AND (c.expires_at IS NULL OR c.expires_at > NEW.created_at)
    AND o.status = 'pending' AND o.discount_code = NEW.code AND o.discount_amount = NEW.amount_cents
    AND o.subtotal_amount + o.shipping_amount + CASE WHEN o.tax_behavior = 'exclusive' THEN o.tax_amount ELSE 0 END
      = o.discount_amount + o.credit_applied + o.gift_card_applied + o.total_amount
    AND (c.type <> 'credit' OR c.remaining_cents >= NEW.amount_cents)
    AND (c.first_order_only = 0 OR (
      NOT EXISTS (SELECT 1 FROM `_ecommerce_orders` prior
        WHERE prior.id <> NEW.order_id
          AND prior.status IN ('paid','fulfilled','partially_refunded','refunded')
          AND COALESCE(prior.payment_provider, 'stripe') <> 'admin_test'
          AND (lower(prior.customer_email) = NEW.email_normalized OR prior.user_id = NEW.account_id
            OR prior.user_id IN (SELECT a.id FROM `_ecommerce_customer_accounts` a
              WHERE a.email_normalized = NEW.email_normalized)))
      AND NOT EXISTS (SELECT 1 FROM `_ecommerce_discount_redemptions` r
        JOIN `_ecommerce_discount_codes` other ON other.code = r.code AND other.first_order_only = 1
        WHERE r.email_normalized = NEW.email_normalized AND r.status IN ('reserved','confirmed'))))
    AND (c.max_uses IS NULL OR (SELECT COUNT(*) FROM `_ecommerce_discount_redemptions` r
      WHERE r.code = NEW.code AND r.status IN ('reserved','confirmed')) < c.max_uses)
    AND (c.max_uses_per_customer IS NULL OR (SELECT COUNT(*) FROM `_ecommerce_discount_redemptions` r
      WHERE r.code = NEW.code AND r.email_normalized = NEW.email_normalized
        AND r.status IN ('reserved','confirmed')) < c.max_uses_per_customer)
)
BEGIN SELECT RAISE(ABORT, 'Discount code is no longer available'); END;
