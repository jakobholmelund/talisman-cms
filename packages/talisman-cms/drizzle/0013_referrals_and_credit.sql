ALTER TABLE `_ecommerce_orders` ADD COLUMN `referral_code` text;--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `referral_reward_cents` integer NOT NULL DEFAULT 0 CHECK (`referral_reward_cents` >= 0);--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `credit_applied` integer NOT NULL DEFAULT 0 CHECK (`credit_applied` >= 0);--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `subtotal_amount` integer NOT NULL DEFAULT 0 CHECK (`subtotal_amount` >= 0);--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `payment_intent_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_orders_payment_intent_unique` ON `_ecommerce_orders` (`payment_intent_id`);--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `provider_refunded_cents` integer NOT NULL DEFAULT 0 CHECK (`provider_refunded_cents` >= 0);--> statement-breakpoint
ALTER TABLE `_ecommerce_customer_accounts` ADD COLUMN `credit_balance` integer NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE TABLE `_ecommerce_referral_codes` (
  `code` text PRIMARY KEY NOT NULL,
  `account_id` text NOT NULL UNIQUE REFERENCES `_ecommerce_customer_accounts`(`id`) ON DELETE CASCADE,
  `active` integer NOT NULL DEFAULT 1,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `_ecommerce_referrals` (
  `id` text PRIMARY KEY NOT NULL,
  `code` text NOT NULL REFERENCES `_ecommerce_referral_codes`(`code`),
  `referrer_account_id` text NOT NULL REFERENCES `_ecommerce_customer_accounts`(`id`),
  `referred_account_id` text NOT NULL UNIQUE REFERENCES `_ecommerce_customer_accounts`(`id`),
  `order_id` text NOT NULL UNIQUE REFERENCES `_ecommerce_orders`(`id`),
  `reward_cents` integer NOT NULL CHECK (`reward_cents` >= 0),
  `currency` text NOT NULL DEFAULT 'usd',
  `status` text NOT NULL DEFAULT 'approved' CHECK (`status` IN ('approved', 'void')),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `_ecommerce_referrals_referrer_idx` ON `_ecommerce_referrals` (`referrer_account_id`, `created_at`);--> statement-breakpoint
CREATE TABLE `_ecommerce_credit_ledger` (
  `id` text PRIMARY KEY NOT NULL,
  `account_id` text NOT NULL REFERENCES `_ecommerce_customer_accounts`(`id`),
  `order_id` text NOT NULL REFERENCES `_ecommerce_orders`(`id`),
  `kind` text NOT NULL CHECK (`kind` IN ('referral_award', 'welcome_award', 'checkout_reserve', 'checkout_release', 'purchase_credit_refund', 'referral_reversal', 'welcome_reversal')),
  `amount_cents` integer NOT NULL CHECK (`amount_cents` != 0),
  `created_at` integer NOT NULL,
  UNIQUE (`order_id`, `kind`)
);--> statement-breakpoint
CREATE INDEX `_ecommerce_credit_ledger_account_idx` ON `_ecommerce_credit_ledger` (`account_id`, `created_at`);
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_credit_reserve_guard` BEFORE INSERT ON `_ecommerce_credit_ledger`
WHEN NEW.`kind` = 'checkout_reserve' AND
  (NEW.`amount_cents` >= 0 OR
   (SELECT `credit_balance` FROM `_ecommerce_customer_accounts` WHERE `id` = NEW.`account_id`) + NEW.`amount_cents` < 0)
BEGIN
  SELECT RAISE(ABORT, 'Insufficient store credit');
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_credit_ledger_balance` AFTER INSERT ON `_ecommerce_credit_ledger`
BEGIN
  UPDATE `_ecommerce_customer_accounts`
    SET `credit_balance` = `credit_balance` + NEW.`amount_cents`,
        `updated_at` = NEW.`created_at`
    WHERE `id` = NEW.`account_id`;
END;
