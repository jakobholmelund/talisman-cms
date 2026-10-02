PRAGMA defer_foreign_keys = true;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_credit_ledger_balance`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_credit_reserve_guard`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_discount_credit_release`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_discount_credit_reserve`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_discount_reserve_guard`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_fulfillment_complete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_fulfillment_correction_guard`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_fulfillment_guard`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_gift_card_claim_guard`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_gift_card_issue_guard`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_gift_card_ledger_balance`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_gift_card_redemption_transition`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_gift_card_release`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_gift_card_reserve`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_gift_card_reserve_guard`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_gift_card_partial_refund`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_gift_card_refund_guard`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_variants_stock_nonnegative`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_products_stock_nonnegative`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `_ecommerce_stocks_nonnegative`;
--> statement-breakpoint
CREATE TABLE `_ecommerce_shopper_audits` (
	`id` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_shopper_audits_account_id__ecommerce_customer_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `_ecommerce_customer_accounts`(`id`),
	CONSTRAINT "shopper_audit_action" CHECK("action" IN ('export', 'revoke', 'anonymize')),
	CONSTRAINT "shopper_audit_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "shopper_audit_reason" CHECK(length(trim("reason")) >= 8)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_tax_sync_decisions` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`reversal_id` text,
	`action` text NOT NULL,
	`provider_id` text,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_tax_sync_decisions_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT `fk__ecommerce_tax_sync_decisions_reversal_id__ecommerce_tax_reversals_id_fk` FOREIGN KEY (`reversal_id`) REFERENCES `_ecommerce_tax_reversals`(`id`),
	CONSTRAINT "tax_sync_action" CHECK("action" IN ('retry', 'attach')),
	CONSTRAINT "tax_sync_actor" CHECK(length(trim("actor")) > 0),
	CONSTRAINT "tax_sync_reason" CHECK(length(trim("reason")) >= 8),
	CONSTRAINT "tax_sync_attach_id" CHECK(("action" = 'attach') = ("provider_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE `_ecommerce_fulfillments` ADD `request_key` text;--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD `guest_access_token_hash` text;--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD `referral_terms` text;--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD `tax_sync_review_at` integer;--> statement-breakpoint
ALTER TABLE `_ecommerce_tax_reversals` ADD `tax_sync_review_at` integer;--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE `__new__ecommerce_fulfillments` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`admin_actor` text NOT NULL,
	`carrier` text,
	`tracking_number` text,
	`note` text NOT NULL,
	`created_at` integer NOT NULL,
	`kind` text DEFAULT 'shipment' NOT NULL,
	`request_key` text,
	`corrects_id` text,
	`completes_order` integer DEFAULT true NOT NULL,
	CONSTRAINT `fk__ecommerce_fulfillments_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT `fk__ecommerce_fulfillments_corrects_id__ecommerce_fulfillments_id_fk` FOREIGN KEY (`corrects_id`) REFERENCES `_ecommerce_fulfillments`(`id`),
	CONSTRAINT "fulfillment_actor_filled" CHECK(length(trim("admin_actor")) > 0),
	CONSTRAINT "fulfillment_note_length" CHECK(length(trim("note")) >= 8),
	CONSTRAINT "fulfillment_kind" CHECK("kind" IN ('shipment', 'correction', 'reopen', 'complete')),
	CONSTRAINT "fulfillment_completes_order_flag" CHECK("completes_order" IN (0, 1)),
	CONSTRAINT "fulfillment_correction_names_shipment" CHECK(("kind" = 'correction') = ("corrects_id" IS NOT NULL)),
	CONSTRAINT "fulfillment_only_shipment_completes" CHECK("kind" = 'shipment' OR "completes_order" = 0)
);
--> statement-breakpoint
INSERT INTO `__new__ecommerce_fulfillments`(`id`, `order_id`, `admin_actor`, `carrier`, `tracking_number`, `note`, `created_at`, `kind`, `corrects_id`, `completes_order`) SELECT `id`, `order_id`, `admin_actor`, `carrier`, `tracking_number`, `note`, `created_at`, `kind`, `corrects_id`, `completes_order` FROM `_ecommerce_fulfillments`;--> statement-breakpoint
DROP TABLE `_ecommerce_fulfillments`;--> statement-breakpoint
ALTER TABLE `__new__ecommerce_fulfillments` RENAME TO `_ecommerce_fulfillments`;--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE `__new__ecommerce_orders` (
	`id` text PRIMARY KEY,
	`cart_id` text UNIQUE,
	`guest_access_token_hash` text,
	`user_id` text,
	`checkout_session_id` text,
	`payment_intent_id` text UNIQUE,
	`provider_refunded_cents` integer DEFAULT 0 NOT NULL,
	`payment_provider` text,
	`referral_code` text,
	`referral_reward_cents` integer DEFAULT 0 NOT NULL,
	`referral_terms` text,
	`discount_code` text,
	`discount_amount` integer DEFAULT 0 NOT NULL,
	`gift_card_id` text,
	`gift_card_applied` integer DEFAULT 0 NOT NULL,
	`gift_card_refunded_cents` integer DEFAULT 0 NOT NULL,
	`credit_applied` integer DEFAULT 0 NOT NULL,
	`subtotal_amount` integer DEFAULT 0 NOT NULL,
	`shipping_amount` integer DEFAULT 0 NOT NULL,
	`shipping_rate_id` text,
	`shipping_label` text,
	`tax_amount` integer DEFAULT 0 NOT NULL,
	`tax_behavior` text,
	`tax_calculation_id` text,
	`tax_transaction_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`fulfillment_status` text DEFAULT 'unfulfilled' NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`total_amount` integer NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`customer_email` text,
	`shipping_address` text,
	`billing_address` text,
	`reconcile_attempts` integer DEFAULT 0 NOT NULL,
	`reconcile_last_at` integer,
	`reconcile_last_error` text,
	`reconcile_review_at` integer,
	`tax_sync_attempts` integer DEFAULT 0 NOT NULL,
	`tax_sync_last_at` integer,
	`tax_sync_last_error` text,
	`tax_sync_review_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_orders_cart_id__ecommerce_carts_id_fk` FOREIGN KEY (`cart_id`) REFERENCES `_ecommerce_carts`(`id`),
	CONSTRAINT "orders_total_nonnegative" CHECK("total_amount" >= 0),
	CONSTRAINT "orders_provider_refund_capped" CHECK("provider_refunded_cents" <= "total_amount"),
	CONSTRAINT "orders_totals_balanced" CHECK("subtotal_amount" + "shipping_amount" + CASE WHEN "tax_behavior" = 'exclusive' THEN "tax_amount" ELSE 0 END = "total_amount" + "discount_amount" + "credit_applied" + "gift_card_applied"),
	CONSTRAINT "orders_referral_reward_nonnegative" CHECK("referral_reward_cents" >= 0),
	CONSTRAINT "orders_credit_applied_nonnegative" CHECK("credit_applied" >= 0),
	CONSTRAINT "orders_subtotal_nonnegative" CHECK("subtotal_amount" >= 0),
	CONSTRAINT "orders_provider_refunded_nonnegative" CHECK("provider_refunded_cents" >= 0),
	CONSTRAINT "orders_discount_nonnegative" CHECK("discount_amount" >= 0),
	CONSTRAINT "orders_gift_card_applied_nonnegative" CHECK("gift_card_applied" >= 0),
	CONSTRAINT "orders_gift_card_refunded_within_applied" CHECK("gift_card_refunded_cents" >= 0 AND "gift_card_refunded_cents" <= "gift_card_applied"),
	CONSTRAINT "orders_shipping_nonnegative" CHECK("shipping_amount" >= 0),
	CONSTRAINT "orders_tax_nonnegative" CHECK("tax_amount" >= 0),
	CONSTRAINT "orders_tax_behavior" CHECK("tax_behavior" IS NULL OR "tax_behavior" IN ('inclusive', 'exclusive')),
	CONSTRAINT "orders_fulfillment_status" CHECK("fulfillment_status" IN ('unfulfilled', 'partially_fulfilled', 'fulfilled')),
	CONSTRAINT "orders_reconcile_attempts_nonnegative" CHECK("reconcile_attempts" >= 0),
	CONSTRAINT "orders_tax_sync_attempts_nonnegative" CHECK("tax_sync_attempts" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new__ecommerce_orders`(`id`, `cart_id`, `user_id`, `checkout_session_id`, `payment_intent_id`, `provider_refunded_cents`, `payment_provider`, `referral_code`, `referral_reward_cents`, `discount_code`, `discount_amount`, `gift_card_id`, `gift_card_applied`, `gift_card_refunded_cents`, `credit_applied`, `subtotal_amount`, `shipping_amount`, `shipping_rate_id`, `shipping_label`, `tax_amount`, `tax_behavior`, `tax_calculation_id`, `tax_transaction_id`, `status`, `fulfillment_status`, `items`, `total_amount`, `currency`, `customer_email`, `shipping_address`, `billing_address`, `reconcile_attempts`, `reconcile_last_at`, `reconcile_last_error`, `reconcile_review_at`, `tax_sync_attempts`, `tax_sync_last_at`, `tax_sync_last_error`, `created_at`, `updated_at`) SELECT `id`, `cart_id`, `user_id`, `checkout_session_id`, `payment_intent_id`, `provider_refunded_cents`, `payment_provider`, `referral_code`, `referral_reward_cents`, `discount_code`, `discount_amount`, `gift_card_id`, `gift_card_applied`, `gift_card_refunded_cents`, `credit_applied`, `subtotal_amount`, `shipping_amount`, `shipping_rate_id`, `shipping_label`, `tax_amount`, `tax_behavior`, `tax_calculation_id`, `tax_transaction_id`, `status`, `fulfillment_status`, `items`, `total_amount`, `currency`, `customer_email`, `shipping_address`, `billing_address`, `reconcile_attempts`, `reconcile_last_at`, `reconcile_last_error`, `reconcile_review_at`, `tax_sync_attempts`, `tax_sync_last_at`, `tax_sync_last_error`, `created_at`, `updated_at` FROM `_ecommerce_orders`;--> statement-breakpoint
DROP TABLE `_ecommerce_orders`;--> statement-breakpoint
ALTER TABLE `__new__ecommerce_orders` RENAME TO `_ecommerce_orders`;--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE `__new__ecommerce_product_variant_values` (
	`id` text PRIMARY KEY,
	`product_variant_id` text NOT NULL,
	`value` text NOT NULL,
	`sku` text UNIQUE,
	`image` text,
	`price_override` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_product_variant_values_product_variant_id__ecommerce_product_variants_id_fk` FOREIGN KEY (`product_variant_id`) REFERENCES `_ecommerce_product_variants`(`id`),
	CONSTRAINT "variant_values_price_nonnegative" CHECK("price_override" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new__ecommerce_product_variant_values`(`id`, `product_variant_id`, `value`, `sku`, `image`, `price_override`, `created_at`, `updated_at`) SELECT `id`, `product_variant_id`, `value`, `sku`, `image`, `price_override`, `created_at`, `updated_at` FROM `_ecommerce_product_variant_values`;--> statement-breakpoint
DROP TABLE `_ecommerce_product_variant_values`;--> statement-breakpoint
ALTER TABLE `__new__ecommerce_product_variant_values` RENAME TO `_ecommerce_product_variant_values`;--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE `__new__ecommerce_product_variants` (
	`id` text PRIMARY KEY,
	`product_id` text NOT NULL,
	`variant_id` text,
	`name` text NOT NULL,
	`sku` text UNIQUE,
	`price_override` integer,
	`inventory_quantity` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_product_variants_product_id__ecommerce_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `_ecommerce_products`(`id`),
	CONSTRAINT `fk__ecommerce_product_variants_variant_id__ecommerce_variants_id_fk` FOREIGN KEY (`variant_id`) REFERENCES `_ecommerce_variants`(`id`),
	CONSTRAINT "variants_stock_nonnegative" CHECK("inventory_quantity" >= 0),
	CONSTRAINT "variants_price_nonnegative" CHECK("price_override" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new__ecommerce_product_variants`(`id`, `product_id`, `variant_id`, `name`, `sku`, `price_override`, `inventory_quantity`, `created_at`, `updated_at`) SELECT `id`, `product_id`, `variant_id`, `name`, `sku`, `price_override`, `inventory_quantity`, `created_at`, `updated_at` FROM `_ecommerce_product_variants`;--> statement-breakpoint
DROP TABLE `_ecommerce_product_variants`;--> statement-breakpoint
ALTER TABLE `__new__ecommerce_product_variants` RENAME TO `_ecommerce_product_variants`;--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE `__new__ecommerce_products` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`slug` text NOT NULL UNIQUE,
	`sku` text,
	`description` text,
	`images` text DEFAULT '[]' NOT NULL,
	`category_ids` text DEFAULT '[]' NOT NULL,
	`tag_ids` text DEFAULT '[]' NOT NULL,
	`base_price` integer DEFAULT 0 NOT NULL,
	`is_physical` integer DEFAULT true NOT NULL,
	`inventory_quantity` integer DEFAULT 0 NOT NULL,
	`type` text DEFAULT 'standard' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "products_stock_nonnegative" CHECK("inventory_quantity" >= 0),
	CONSTRAINT "products_price_nonnegative" CHECK("base_price" >= 0),
	CONSTRAINT "products_type" CHECK("type" IN ('standard', 'digital', 'subscription')),
	CONSTRAINT "products_status" CHECK("status" IN ('draft', 'active', 'archived'))
);
--> statement-breakpoint
INSERT INTO `__new__ecommerce_products`(`id`, `name`, `slug`, `sku`, `description`, `images`, `category_ids`, `tag_ids`, `base_price`, `is_physical`, `inventory_quantity`, `type`, `status`, `created_at`, `updated_at`) SELECT `id`, `name`, `slug`, `sku`, `description`, `images`, `category_ids`, `tag_ids`, `base_price`, `is_physical`, `inventory_quantity`, `type`, `status`, `created_at`, `updated_at` FROM `_ecommerce_products`;--> statement-breakpoint
DROP TABLE `_ecommerce_products`;--> statement-breakpoint
ALTER TABLE `__new__ecommerce_products` RENAME TO `_ecommerce_products`;--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE `__new__ecommerce_stocks` (
	`id` text PRIMARY KEY,
	`product_variant_value_id` text NOT NULL UNIQUE,
	`quantity` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_stocks_product_variant_value_id__ecommerce_product_variant_values_id_fk` FOREIGN KEY (`product_variant_value_id`) REFERENCES `_ecommerce_product_variant_values`(`id`),
	CONSTRAINT "stocks_quantity_nonnegative" CHECK("quantity" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new__ecommerce_stocks`(`id`, `product_variant_value_id`, `quantity`, `created_at`, `updated_at`) SELECT `id`, `product_variant_value_id`, `quantity`, `created_at`, `updated_at` FROM `_ecommerce_stocks`;--> statement-breakpoint
DROP TABLE `_ecommerce_stocks`;--> statement-breakpoint
ALTER TABLE `__new__ecommerce_stocks` RENAME TO `_ecommerce_stocks`;--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE `__new__ecommerce_reconcile_decisions` (
	`id` text PRIMARY KEY,
	`order_id` text,
	`purchase_id` text,
	`action` text NOT NULL,
	`failure` text,
	`payment_returned` text,
	`admin_actor` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_reconcile_decisions_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT `fk__ecommerce_reconcile_decisions_purchase_id__ecommerce_gift_card_purchases_id_fk` FOREIGN KEY (`purchase_id`) REFERENCES `_ecommerce_gift_card_purchases`(`id`),
	CONSTRAINT "reconcile_decision_action" CHECK("action" IN ('retry', 'release', 'attach_session')),
	CONSTRAINT "reconcile_decision_payment_returned" CHECK("payment_returned" IS NULL OR "payment_returned" IN ('refunded', 'dispute_lost', 'confirmed')),
	CONSTRAINT "reconcile_decision_admin_actor_filled" CHECK(length(trim("admin_actor")) > 0),
	CONSTRAINT "reconcile_decision_reason_length" CHECK(length(trim("reason")) >= 8),
	CONSTRAINT "reconcile_decision_names_one_subject" CHECK(("order_id" IS NULL) <> ("purchase_id" IS NULL)),
	CONSTRAINT "reconcile_decision_release_returns" CHECK("payment_returned" IS NULL OR "action" = 'release')
);
--> statement-breakpoint
INSERT INTO `__new__ecommerce_reconcile_decisions`(`id`, `order_id`, `purchase_id`, `action`, `failure`, `payment_returned`, `admin_actor`, `reason`, `created_at`) SELECT `id`, `order_id`, `purchase_id`, `action`, `failure`, `payment_returned`, `admin_actor`, `reason`, `created_at` FROM `_ecommerce_reconcile_decisions`;--> statement-breakpoint
DROP TABLE `_ecommerce_reconcile_decisions`;--> statement-breakpoint
ALTER TABLE `__new__ecommerce_reconcile_decisions` RENAME TO `_ecommerce_reconcile_decisions`;--> statement-breakpoint
--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_fulfillments_request_unique` ON `_ecommerce_fulfillments` (`order_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `_ecommerce_fulfillments_order_idx` ON `_ecommerce_fulfillments` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_user_idx` ON `_ecommerce_orders` (`user_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_checkout_session_idx` ON `_ecommerce_orders` (`checkout_session_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_customer_email_idx` ON `_ecommerce_orders` (lower("customer_email"));--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_pending_idx` ON `_ecommerce_orders` (`created_at`) WHERE "_ecommerce_orders"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_awaiting_idx` ON `_ecommerce_orders` (`created_at`,`id`) WHERE "_ecommerce_orders"."status" IN ('paid', 'partially_refunded') AND "_ecommerce_orders"."fulfillment_status" <> 'fulfilled' AND COALESCE("_ecommerce_orders"."payment_provider", 'stripe') <> 'admin_test';--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_recent_idx` ON `_ecommerce_orders` (`created_at`,`id`) WHERE "_ecommerce_orders"."status" NOT IN ('pending', 'cancelled', 'draft') AND COALESCE("_ecommerce_orders"."payment_provider", 'stripe') <> 'admin_test';--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_tax_refunded_idx` ON `_ecommerce_orders` (`created_at`) WHERE "_ecommerce_orders"."status" IN ('partially_refunded', 'refunded') AND "_ecommerce_orders"."tax_transaction_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_tax_transaction_missing_idx` ON `_ecommerce_orders` (`status`,`created_at`) WHERE "_ecommerce_orders"."tax_calculation_id" IS NOT NULL AND "_ecommerce_orders"."tax_transaction_id" IS NULL;--> statement-breakpoint
CREATE INDEX `_ecommerce_reconcile_decisions_order_idx` ON `_ecommerce_reconcile_decisions` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_reconcile_decisions_purchase_idx` ON `_ecommerce_reconcile_decisions` (`purchase_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_credit_ledger_balance` AFTER INSERT ON `_ecommerce_credit_ledger`
BEGIN
  UPDATE `_ecommerce_customer_accounts`
    SET `credit_balance` = `credit_balance` + NEW.`amount_cents`,
        `updated_at` = NEW.`created_at`
    WHERE `id` = NEW.`account_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_credit_reserve_guard` BEFORE INSERT ON `_ecommerce_credit_ledger`
WHEN NEW.`kind` = 'checkout_reserve' AND
  (NEW.`amount_cents` >= 0 OR
   (SELECT `credit_balance` FROM `_ecommerce_customer_accounts` WHERE `id` = NEW.`account_id`) + NEW.`amount_cents` < 0)
BEGIN
  SELECT RAISE(ABORT, 'Insufficient store credit');
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_discount_credit_release` AFTER UPDATE OF `status` ON `_ecommerce_discount_redemptions`
WHEN OLD.status IN ('reserved', 'confirmed') AND NEW.status IN ('cancelled', 'refunded')
  AND (SELECT `type` FROM `_ecommerce_discount_codes` WHERE `code` = NEW.code) = 'credit'
BEGIN
  UPDATE `_ecommerce_discount_codes` SET `remaining_cents` = `remaining_cents` + NEW.amount_cents
    WHERE `code` = NEW.code;
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_discount_credit_reserve` AFTER INSERT ON `_ecommerce_discount_redemptions`
WHEN (SELECT `type` FROM `_ecommerce_discount_codes` WHERE `code` = NEW.code) = 'credit'
BEGIN
  UPDATE `_ecommerce_discount_codes` SET `remaining_cents` = `remaining_cents` - NEW.amount_cents
    WHERE `code` = NEW.code;
END;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_fulfillment_complete` AFTER INSERT ON `_ecommerce_fulfillments`
WHEN NEW.`kind` = 'shipment'
BEGIN
  UPDATE `_ecommerce_orders`
    SET `updated_at` = MAX(`updated_at` + 1, NEW.created_at),
      `fulfillment_status` = CASE WHEN NEW.completes_order = 1 THEN 'fulfilled' ELSE 'partially_fulfilled' END
    WHERE `id` = NEW.order_id AND `fulfillment_status` <> 'fulfilled';
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_fulfillment_correction_guard` BEFORE INSERT ON `_ecommerce_fulfillments`
WHEN NEW.`kind` = 'correction' AND NOT EXISTS (
  SELECT 1 FROM `_ecommerce_fulfillments` s JOIN `_ecommerce_orders` o ON o.id = s.order_id
  WHERE s.id = NEW.corrects_id AND s.kind = 'shipment' AND s.order_id = NEW.order_id
    AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'
    AND length(trim(NEW.admin_actor)) > 0 AND length(trim(NEW.note)) >= 8
    AND (length(trim(COALESCE(NEW.carrier, ''))) > 0 OR length(trim(COALESCE(NEW.tracking_number, ''))) > 0)
)
BEGIN SELECT RAISE(ABORT, 'Shipment cannot be corrected'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_fulfillment_guard` BEFORE INSERT ON `_ecommerce_fulfillments`
WHEN NEW.`kind` = 'shipment' AND NOT EXISTS (
  SELECT 1 FROM `_ecommerce_orders` o WHERE o.id = NEW.order_id
    AND o.status IN ('paid','partially_refunded') AND o.fulfillment_status <> 'fulfilled'
    AND COALESCE(o.payment_provider, 'stripe') <> 'admin_test'
    AND length(trim(NEW.admin_actor)) > 0 AND length(trim(NEW.note)) >= 8
)
BEGIN SELECT RAISE(ABORT, 'Order is not ready for fulfillment'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_claim_guard` BEFORE INSERT ON `_ecommerce_gift_card_claims`
WHEN NOT EXISTS (
  SELECT 1 FROM `_ecommerce_gift_cards` c WHERE c.id = NEW.card_id AND c.status = 'active'
    AND (c.purchase_id = NEW.purchase_id OR c.replaces_purchase_id = NEW.purchase_id)
)
BEGIN SELECT RAISE(ABORT, 'Gift card cannot be claimed'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_issue_guard` BEFORE INSERT ON `_ecommerce_gift_card_ledger`
WHEN NEW.kind = 'issue' AND NOT EXISTS (
  SELECT 1 FROM `_ecommerce_gift_cards` c LEFT JOIN `_ecommerce_gift_card_purchases` p ON p.id = c.purchase_id
  WHERE c.id = NEW.card_id AND NEW.amount_cents = c.initial_cents
    AND NOT EXISTS (SELECT 1 FROM `_ecommerce_gift_card_ledger` l WHERE l.card_id = c.id AND l.kind = 'issue')
    AND ((c.source = 'admin' AND c.admin_actor IS NOT NULL)
      OR (c.source = 'purchase' AND p.status = 'paid' AND p.amount_cents = c.initial_cents
        AND p.payment_intent_id IS NOT NULL))
)
BEGIN SELECT RAISE(ABORT, 'Gift card funding is not confirmed'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_ledger_balance` AFTER INSERT ON `_ecommerce_gift_card_ledger`
BEGIN
  UPDATE `_ecommerce_gift_cards` SET `balance_cents` = `balance_cents` + NEW.amount_cents,
    `updated_at` = NEW.created_at WHERE id = NEW.card_id;
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_redemption_transition` BEFORE UPDATE ON `_ecommerce_gift_card_redemptions`
WHEN NEW.card_id <> OLD.card_id OR NEW.order_id <> OLD.order_id OR NEW.amount_cents <> OLD.amount_cents
  OR NOT ((OLD.status = 'reserved' AND NEW.status IN ('confirmed','cancelled'))
    OR (OLD.status = 'confirmed' AND NEW.status = 'refunded'))
BEGIN SELECT RAISE(ABORT, 'Invalid gift card redemption transition'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_release` AFTER UPDATE OF `status` ON `_ecommerce_gift_card_redemptions`
WHEN NEW.status IN ('cancelled','refunded')
BEGIN
  INSERT INTO `_ecommerce_gift_card_ledger` (`id`,`card_id`,`order_id`,`kind`,`amount_cents`,`created_at`)
    SELECT 'gcl_' || NEW.status || '_' || NEW.order_id,NEW.card_id,NEW.order_id,
      CASE WHEN NEW.status = 'cancelled' THEN 'release' ELSE 'refund_restore' END,
      NEW.amount_cents - (SELECT COALESCE(SUM(amount_cents),0) FROM `_ecommerce_gift_card_refunds` WHERE order_id = NEW.order_id),
      NEW.updated_at
    WHERE NEW.amount_cents > (SELECT COALESCE(SUM(amount_cents),0) FROM `_ecommerce_gift_card_refunds` WHERE order_id = NEW.order_id);
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_reserve` AFTER INSERT ON `_ecommerce_gift_card_redemptions`
BEGIN
  INSERT INTO `_ecommerce_gift_card_ledger` (`id`,`card_id`,`order_id`,`kind`,`amount_cents`,`created_at`)
    VALUES ('gcl_reserve_' || NEW.order_id,NEW.card_id,NEW.order_id,'reserve',-NEW.amount_cents,NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_reserve_guard` BEFORE INSERT ON `_ecommerce_gift_card_redemptions`
WHEN NOT EXISTS (
  SELECT 1 FROM `_ecommerce_gift_cards` c JOIN `_ecommerce_orders` o ON o.id = NEW.order_id
  WHERE c.id = NEW.card_id AND c.status = 'active' AND c.currency = o.currency
    AND c.balance_cents >= NEW.amount_cents AND o.status = 'pending'
    AND o.gift_card_id = c.id AND o.gift_card_applied = NEW.amount_cents
    AND o.subtotal_amount + o.shipping_amount + CASE WHEN o.tax_behavior = 'exclusive' THEN o.tax_amount ELSE 0 END
      = o.discount_amount + o.credit_applied + o.gift_card_applied + o.total_amount
)
BEGIN SELECT RAISE(ABORT, 'Gift card is no longer available'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_partial_refund` AFTER INSERT ON `_ecommerce_gift_card_refunds`
BEGIN
  INSERT INTO `_ecommerce_gift_card_ledger` (`id`,`card_id`,`order_id`,`kind`,`amount_cents`,`created_at`)
    VALUES ('gcl_refund_' || NEW.id,NEW.card_id,NEW.order_id,'refund_restore',NEW.amount_cents,NEW.created_at);
  UPDATE `_ecommerce_orders` SET `gift_card_refunded_cents` = `gift_card_refunded_cents` + NEW.amount_cents,
    `status` = 'partially_refunded',
    `updated_at` = NEW.created_at WHERE id = NEW.order_id;
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_refund_guard` BEFORE INSERT ON `_ecommerce_gift_card_refunds`
WHEN NOT EXISTS (
  SELECT 1 FROM `_ecommerce_gift_card_redemptions` r JOIN `_ecommerce_orders` o ON o.id = r.order_id
  WHERE r.order_id = NEW.order_id AND r.card_id = NEW.card_id AND r.status = 'confirmed'
    AND o.status IN ('paid','fulfilled','partially_refunded')
    AND NEW.amount_cents <= r.amount_cents - o.gift_card_refunded_cents
    AND length(trim(NEW.reason)) >= 8 AND length(trim(NEW.admin_actor)) > 0
)
BEGIN SELECT RAISE(ABORT, 'Gift card refund is unavailable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_variants_stock_nonnegative` BEFORE UPDATE OF `inventory_quantity` ON `_ecommerce_product_variants`
WHEN NEW.`inventory_quantity` < 0 BEGIN SELECT RAISE(ABORT, 'Insufficient variant stock'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_products_stock_nonnegative` BEFORE UPDATE OF `inventory_quantity` ON `_ecommerce_products`
WHEN NEW.`inventory_quantity` < 0 BEGIN SELECT RAISE(ABORT, 'Insufficient product stock'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_stocks_nonnegative` BEFORE UPDATE OF `quantity` ON `_ecommerce_stocks`
WHEN NEW.`quantity` < 0 BEGIN SELECT RAISE(ABORT, 'Insufficient variant value stock'); END;

--> statement-breakpoint
-- DROP/RENAME can leave SQLite's deferred violation counter stale even after references resolve.
-- Check actual references before restoring immediate checks; never disable foreign key enforcement.
-- https://sqlite.org/forum/info/64fb781a226df95c0f4edc474e590214c28ae1b4b5ddeee8f7ec4ad77286796c
SELECT CASE WHEN EXISTS (SELECT 1 FROM pragma_foreign_key_check)
  THEN json('commerce migration foreign key check failed') ELSE 1 END;
--> statement-breakpoint
PRAGMA defer_foreign_keys = false;
