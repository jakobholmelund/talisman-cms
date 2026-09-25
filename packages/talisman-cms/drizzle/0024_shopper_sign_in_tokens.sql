-- A sign-in link keeps the address it was sent to. The shopper account is created only when the
-- link is used, so asking for a link no longer creates an account.
CREATE TABLE `_ecommerce_sign_in_tokens` (
  `token_hash` text PRIMARY KEY NOT NULL,
  `email_normalized` text NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `revoked_at` integer
);--> statement-breakpoint
CREATE INDEX `_ecommerce_sign_in_tokens_email_idx`
  ON `_ecommerce_sign_in_tokens` (`email_normalized`, `created_at`);--> statement-breakpoint
-- Links sent before the upgrade keep working until they expire.
INSERT INTO `_ecommerce_sign_in_tokens` (`token_hash`, `email_normalized`, `expires_at`, `created_at`, `revoked_at`)
  SELECT s.`token_hash`, a.`email_normalized`, s.`expires_at`, s.`created_at`, s.`revoked_at`
  FROM `_ecommerce_customer_sessions` s
  JOIN `_ecommerce_customer_accounts` a ON a.`id` = s.`account_id`
  WHERE s.`purpose` = 'email_challenge' AND s.`expires_at` > CAST(strftime('%s', 'now') AS integer);--> statement-breakpoint
-- Shopper request counters. They shared better-auth's rate-limit table, whose own cleanup deleted
-- them because better-auth stores milliseconds and these counters store seconds.
CREATE TABLE `_ecommerce_rate_limits` (
  `key` text PRIMARY KEY NOT NULL,
  `count` integer NOT NULL,
  `window_start` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `_ecommerce_rate_limits` (`key`, `count`, `window_start`)
  SELECT `key`, `count`, `last_request` FROM `galaxy_auth_rate_limit`
  WHERE `key` LIKE 'shopper-email:%' AND `last_request` < 100000000000;--> statement-breakpoint
DELETE FROM `galaxy_auth_rate_limit`
  WHERE `key` LIKE 'shopper-email:%' AND `last_request` < 100000000000;--> statement-breakpoint
-- A first-order code looks at the shopper's past purchases, not at whether an account row exists.
CREATE INDEX `_ecommerce_orders_customer_email_idx` ON `_ecommerce_orders` (lower(`customer_email`));--> statement-breakpoint
DROP TRIGGER `_ecommerce_discount_reserve_guard`;--> statement-breakpoint
CREATE TRIGGER `_ecommerce_discount_reserve_guard` BEFORE INSERT ON `_ecommerce_discount_redemptions`
WHEN NOT EXISTS (
  SELECT 1 FROM `_ecommerce_discount_codes` c JOIN `_ecommerce_orders` o ON o.id = NEW.order_id
  WHERE c.code = NEW.code AND c.active = 1
    AND (c.starts_at IS NULL OR c.starts_at <= NEW.created_at)
    AND (c.expires_at IS NULL OR c.expires_at > NEW.created_at)
    AND o.status = 'pending' AND o.discount_code = NEW.code AND o.discount_amount = NEW.amount_cents
    AND o.subtotal_amount = o.discount_amount + o.credit_applied + o.gift_card_applied + o.total_amount
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
