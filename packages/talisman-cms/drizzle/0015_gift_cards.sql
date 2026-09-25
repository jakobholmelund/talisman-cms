ALTER TABLE `_ecommerce_orders` ADD COLUMN `gift_card_id` text;--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `gift_card_applied` integer NOT NULL DEFAULT 0 CHECK (`gift_card_applied` >= 0);--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `gift_card_refunded_cents` integer NOT NULL DEFAULT 0 CHECK (`gift_card_refunded_cents` >= 0 AND `gift_card_refunded_cents` <= `gift_card_applied`);--> statement-breakpoint
CREATE TABLE `_ecommerce_gift_card_purchases` (
  `id` text PRIMARY KEY NOT NULL,
  `buyer_email` text NOT NULL,
  `amount_cents` integer NOT NULL CHECK (`amount_cents` BETWEEN 500 AND 100000),
  `currency` text NOT NULL DEFAULT 'usd' CHECK (`currency` = 'usd'),
  `status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending','paid','cancelled','partially_refunded','refunded','review')),
  `provider_session_id` text UNIQUE,
  `payment_intent_id` text UNIQUE,
  `provider_refunded_cents` integer NOT NULL DEFAULT 0 CHECK (`provider_refunded_cents` >= 0),
  `access_token_hash` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `_ecommerce_gift_cards` (
  `id` text PRIMARY KEY NOT NULL,
  `code_hash` text NOT NULL UNIQUE,
  `code_suffix` text NOT NULL,
  `encrypted_code` text NOT NULL,
  `source` text NOT NULL CHECK (`source` IN ('purchase','admin')),
  `purchase_id` text UNIQUE REFERENCES `_ecommerce_gift_card_purchases`(`id`),
  `admin_actor` text,
  `admin_reason` text,
  `initial_cents` integer NOT NULL CHECK (`initial_cents` BETWEEN 500 AND 100000),
  `balance_cents` integer NOT NULL DEFAULT 0 CHECK (`balance_cents` BETWEEN 0 AND `initial_cents`),
  `currency` text NOT NULL DEFAULT 'usd' CHECK (`currency` = 'usd'),
  `status` text NOT NULL DEFAULT 'active' CHECK (`status` IN ('active','suspended','void')),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK ((`source` = 'purchase' AND `purchase_id` IS NOT NULL AND `admin_actor` IS NULL)
    OR (`source` = 'admin' AND `purchase_id` IS NULL AND `admin_actor` IS NOT NULL AND `admin_reason` IS NOT NULL))
);--> statement-breakpoint
CREATE TABLE `_ecommerce_gift_card_ledger` (
  `id` text PRIMARY KEY NOT NULL,
  `card_id` text NOT NULL REFERENCES `_ecommerce_gift_cards`(`id`),
  `order_id` text REFERENCES `_ecommerce_orders`(`id`),
  `purchase_id` text REFERENCES `_ecommerce_gift_card_purchases`(`id`),
  `kind` text NOT NULL CHECK (`kind` IN ('issue','reserve','release','refund_restore','purchase_reversal')),
  `amount_cents` integer NOT NULL CHECK (`amount_cents` != 0),
  `created_at` integer NOT NULL,
  CHECK ((`kind` IN ('issue','release','refund_restore') AND `amount_cents` > 0)
    OR (`kind` IN ('reserve','purchase_reversal') AND `amount_cents` < 0))
);--> statement-breakpoint
CREATE INDEX `_ecommerce_gift_card_ledger_card_idx` ON `_ecommerce_gift_card_ledger` (`card_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `_ecommerce_gift_card_redemptions` (
  `id` text PRIMARY KEY NOT NULL,
  `card_id` text NOT NULL REFERENCES `_ecommerce_gift_cards`(`id`),
  `order_id` text NOT NULL UNIQUE REFERENCES `_ecommerce_orders`(`id`),
  `amount_cents` integer NOT NULL CHECK (`amount_cents` > 0),
  `status` text NOT NULL DEFAULT 'reserved' CHECK (`status` IN ('reserved','confirmed','cancelled','refunded')),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `_ecommerce_gift_card_redemptions_card_idx` ON `_ecommerce_gift_card_redemptions` (`card_id`,`status`);--> statement-breakpoint
CREATE TABLE `_ecommerce_gift_card_refunds` (
  `id` text PRIMARY KEY NOT NULL,
  `card_id` text NOT NULL REFERENCES `_ecommerce_gift_cards`(`id`),
  `order_id` text NOT NULL REFERENCES `_ecommerce_orders`(`id`),
  `amount_cents` integer NOT NULL CHECK (`amount_cents` > 0),
  `admin_actor` text NOT NULL,
  `reason` text NOT NULL,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `_ecommerce_gift_card_refunds_order_idx` ON `_ecommerce_gift_card_refunds` (`order_id`);--> statement-breakpoint
CREATE TABLE `_ecommerce_gift_card_order_refunds` (
  `order_id` text PRIMARY KEY NOT NULL REFERENCES `_ecommerce_orders`(`id`),
  `admin_actor` text NOT NULL,
  `reason` text NOT NULL,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_issue_guard` BEFORE INSERT ON `_ecommerce_gift_card_ledger`
WHEN NEW.kind = 'issue' AND NOT EXISTS (
  SELECT 1 FROM `_ecommerce_gift_cards` c LEFT JOIN `_ecommerce_gift_card_purchases` p ON p.id = c.purchase_id
  WHERE c.id = NEW.card_id AND NEW.amount_cents = c.initial_cents
    AND NOT EXISTS (SELECT 1 FROM `_ecommerce_gift_card_ledger` l WHERE l.card_id = c.id AND l.kind = 'issue')
    AND ((c.source = 'admin' AND c.admin_actor IS NOT NULL)
      OR (c.source = 'purchase' AND p.status = 'paid' AND p.amount_cents = c.initial_cents
        AND p.payment_intent_id IS NOT NULL))
)
BEGIN SELECT RAISE(ABORT, 'Gift card funding is not confirmed'); END;--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_ledger_balance` AFTER INSERT ON `_ecommerce_gift_card_ledger`
BEGIN
  UPDATE `_ecommerce_gift_cards` SET `balance_cents` = `balance_cents` + NEW.amount_cents,
    `updated_at` = NEW.created_at WHERE id = NEW.card_id;
END;--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_reserve_guard` BEFORE INSERT ON `_ecommerce_gift_card_redemptions`
WHEN NOT EXISTS (
  SELECT 1 FROM `_ecommerce_gift_cards` c JOIN `_ecommerce_orders` o ON o.id = NEW.order_id
  WHERE c.id = NEW.card_id AND c.status = 'active' AND c.currency = o.currency
    AND c.balance_cents >= NEW.amount_cents AND o.status = 'pending'
    AND o.gift_card_id = c.id AND o.gift_card_applied = NEW.amount_cents
    AND o.subtotal_amount = o.discount_amount + o.credit_applied + o.gift_card_applied + o.total_amount
)
BEGIN SELECT RAISE(ABORT, 'Gift card is no longer available'); END;--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_reserve` AFTER INSERT ON `_ecommerce_gift_card_redemptions`
BEGIN
  INSERT INTO `_ecommerce_gift_card_ledger` (`id`,`card_id`,`order_id`,`kind`,`amount_cents`,`created_at`)
    VALUES ('gcl_reserve_' || NEW.order_id,NEW.card_id,NEW.order_id,'reserve',-NEW.amount_cents,NEW.created_at);
END;--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_redemption_transition` BEFORE UPDATE ON `_ecommerce_gift_card_redemptions`
WHEN NEW.card_id <> OLD.card_id OR NEW.order_id <> OLD.order_id OR NEW.amount_cents <> OLD.amount_cents
  OR NOT ((OLD.status = 'reserved' AND NEW.status IN ('confirmed','cancelled'))
    OR (OLD.status = 'confirmed' AND NEW.status = 'refunded'))
BEGIN SELECT RAISE(ABORT, 'Invalid gift card redemption transition'); END;--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_release` AFTER UPDATE OF `status` ON `_ecommerce_gift_card_redemptions`
WHEN NEW.status IN ('cancelled','refunded')
BEGIN
  INSERT INTO `_ecommerce_gift_card_ledger` (`id`,`card_id`,`order_id`,`kind`,`amount_cents`,`created_at`)
    SELECT 'gcl_' || NEW.status || '_' || NEW.order_id,NEW.card_id,NEW.order_id,
      CASE WHEN NEW.status = 'cancelled' THEN 'release' ELSE 'refund_restore' END,
      NEW.amount_cents - (SELECT COALESCE(SUM(amount_cents),0) FROM `_ecommerce_gift_card_refunds` WHERE order_id = NEW.order_id),
      NEW.updated_at
    WHERE NEW.amount_cents > (SELECT COALESCE(SUM(amount_cents),0) FROM `_ecommerce_gift_card_refunds` WHERE order_id = NEW.order_id);
END;--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_refund_guard` BEFORE INSERT ON `_ecommerce_gift_card_refunds`
WHEN NOT EXISTS (
  SELECT 1 FROM `_ecommerce_gift_card_redemptions` r JOIN `_ecommerce_orders` o ON o.id = r.order_id
  WHERE r.order_id = NEW.order_id AND r.card_id = NEW.card_id AND r.status = 'confirmed'
    AND o.status IN ('paid','fulfilled','partially_refunded')
    AND NEW.amount_cents <= r.amount_cents - o.gift_card_refunded_cents
    AND length(trim(NEW.reason)) >= 8 AND length(trim(NEW.admin_actor)) > 0
)
BEGIN SELECT RAISE(ABORT, 'Gift card refund is unavailable'); END;--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_partial_refund` AFTER INSERT ON `_ecommerce_gift_card_refunds`
BEGIN
  INSERT INTO `_ecommerce_gift_card_ledger` (`id`,`card_id`,`order_id`,`kind`,`amount_cents`,`created_at`)
    VALUES ('gcl_refund_' || NEW.id,NEW.card_id,NEW.order_id,'refund_restore',NEW.amount_cents,NEW.created_at);
  UPDATE `_ecommerce_orders` SET `gift_card_refunded_cents` = `gift_card_refunded_cents` + NEW.amount_cents,
    `status` = 'partially_refunded',
    `updated_at` = NEW.created_at WHERE id = NEW.order_id;
END;--> statement-breakpoint
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
      NOT EXISTS (SELECT 1 FROM `_ecommerce_customer_accounts` a WHERE a.email_normalized = NEW.email_normalized)
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
