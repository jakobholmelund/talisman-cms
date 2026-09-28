CREATE TABLE `_ecommerce_carts` (
	`id` text PRIMARY KEY,
	`session_token` text UNIQUE,
	`user_id` text,
	`checkout_session_id` text,
	`version` integer DEFAULT 0 NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`closed` integer DEFAULT false NOT NULL,
	`closed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_categories` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`slug` text NOT NULL UNIQUE,
	`description` text,
	`image` text,
	`parent_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_categories_parent_id__ecommerce_categories_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `_ecommerce_categories`(`id`)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_component_reservations` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`component_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`released_at` integer,
	CONSTRAINT `fk__ecommerce_component_reservations_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT `fk__ecommerce_component_reservations_component_id__ecommerce_components_id_fk` FOREIGN KEY (`component_id`) REFERENCES `_ecommerce_components`(`id`),
	CONSTRAINT "component_reservation_quantity_positive" CHECK("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_components` (
	`id` text PRIMARY KEY,
	`sku` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "component_quantity_nonnegative" CHECK("quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_credit_ledger` (
	`id` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`order_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_credit_ledger_account_id__ecommerce_customer_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `_ecommerce_customer_accounts`(`id`),
	CONSTRAINT `fk__ecommerce_credit_ledger_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT "credit_ledger_kind" CHECK("kind" IN ('referral_award', 'welcome_award', 'checkout_reserve', 'checkout_release', 'purchase_credit_refund', 'referral_reversal', 'welcome_reversal')),
	CONSTRAINT "credit_ledger_amount_nonzero" CHECK("amount_cents" != 0)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_customer_accounts` (
	`id` text PRIMARY KEY,
	`cms_user_id` text,
	`email` text NOT NULL,
	`email_normalized` text NOT NULL UNIQUE,
	`email_verified_at` integer,
	`name` text,
	`credit_balance` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_customer_accounts_cms_user_id_galaxy_auth_user_id_fk` FOREIGN KEY (`cms_user_id`) REFERENCES `galaxy_auth_user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_customer_sessions` (
	`id` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`order_id` text UNIQUE,
	`token_hash` text NOT NULL UNIQUE,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`purpose` text DEFAULT 'session' NOT NULL,
	CONSTRAINT `fk__ecommerce_customer_sessions_account_id__ecommerce_customer_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `_ecommerce_customer_accounts`(`id`) ON DELETE CASCADE,
	CONSTRAINT "customer_session_purpose" CHECK("purpose" IN ('session', 'email_challenge'))
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_customers` (
	`id` text PRIMARY KEY,
	`name` text,
	`email` text,
	`stripe_customer_id` text UNIQUE,
	`user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_discount_codes` (
	`code` text PRIMARY KEY,
	`description` text,
	`type` text NOT NULL,
	`value` integer NOT NULL,
	`remaining_cents` integer,
	`max_discount_cents` integer,
	`min_order_cents` integer DEFAULT 0 NOT NULL,
	`eligible_product_ids` text DEFAULT '[]' NOT NULL,
	`max_uses` integer,
	`max_uses_per_customer` integer,
	`first_order_only` integer DEFAULT false NOT NULL,
	`starts_at` integer,
	`expires_at` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "discount_code_type" CHECK("type" IN ('credit', 'amount', 'percent')),
	CONSTRAINT "discount_code_value_positive" CHECK("value" > 0),
	CONSTRAINT "discount_code_remaining_nonnegative" CHECK("remaining_cents" >= 0),
	CONSTRAINT "discount_code_max_discount_positive" CHECK("max_discount_cents" > 0),
	CONSTRAINT "discount_code_min_order_nonnegative" CHECK("min_order_cents" >= 0),
	CONSTRAINT "discount_code_max_uses_positive" CHECK("max_uses" > 0),
	CONSTRAINT "discount_code_max_uses_per_customer_positive" CHECK("max_uses_per_customer" > 0),
	CONSTRAINT "discount_code_first_order_only_flag" CHECK("first_order_only" IN (0, 1)),
	CONSTRAINT "discount_code_active_flag" CHECK("active" IN (0, 1)),
	CONSTRAINT "discount_code_type_shape" CHECK(("type" = 'credit' AND "remaining_cents" IS NOT NULL AND "remaining_cents" <= "value" AND "max_discount_cents" IS NULL)
    OR ("type" = 'amount' AND "remaining_cents" IS NULL AND "max_discount_cents" IS NULL)
    OR ("type" = 'percent' AND "value" BETWEEN 1 AND 10000 AND "remaining_cents" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_discount_redemptions` (
	`id` text PRIMARY KEY,
	`code` text NOT NULL,
	`order_id` text NOT NULL UNIQUE,
	`account_id` text,
	`email_normalized` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_discount_redemptions_code__ecommerce_discount_codes_code_fk` FOREIGN KEY (`code`) REFERENCES `_ecommerce_discount_codes`(`code`),
	CONSTRAINT `fk__ecommerce_discount_redemptions_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT `fk__ecommerce_discount_redemptions_account_id__ecommerce_customer_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `_ecommerce_customer_accounts`(`id`),
	CONSTRAINT "discount_redemption_amount_positive" CHECK("amount_cents" > 0),
	CONSTRAINT "discount_redemption_status" CHECK("status" IN ('reserved', 'confirmed', 'cancelled', 'refunded'))
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_disputes` (
	`id` text PRIMARY KEY,
	`provider` text NOT NULL,
	`order_id` text,
	`gift_card_purchase_id` text,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`reason` text,
	`status` text NOT NULL,
	`status_before` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	CONSTRAINT `fk__ecommerce_disputes_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT `fk__ecommerce_disputes_gift_card_purchase_id__ecommerce_gift_card_purchases_id_fk` FOREIGN KEY (`gift_card_purchase_id`) REFERENCES `_ecommerce_gift_card_purchases`(`id`),
	CONSTRAINT "dispute_amount_nonnegative" CHECK("amount_cents" >= 0),
	CONSTRAINT "dispute_names_one_subject" CHECK(("order_id" IS NULL) <> ("gift_card_purchase_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_email_deliveries` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` integer NOT NULL,
	`claimed_at` integer,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "email_delivery_kind" CHECK("kind" IN ('order_confirmation', 'shipment', 'shipment_update', 'gift_card_claim')),
	CONSTRAINT "email_delivery_status" CHECK("status" IN ('pending', 'sent', 'failed', 'cancelled')),
	CONSTRAINT "email_delivery_attempts_nonnegative" CHECK("attempts" >= 0),
	CONSTRAINT "email_delivery_sent_has_time" CHECK(("status" = 'sent') = ("sent_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_fulfillments` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`admin_actor` text NOT NULL,
	`carrier` text,
	`tracking_number` text,
	`note` text NOT NULL,
	`created_at` integer NOT NULL,
	`kind` text DEFAULT 'shipment' NOT NULL,
	`corrects_id` text,
	`completes_order` integer DEFAULT true NOT NULL,
	CONSTRAINT `fk__ecommerce_fulfillments_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT `fk__ecommerce_fulfillments_corrects_id__ecommerce_fulfillments_id_fk` FOREIGN KEY (`corrects_id`) REFERENCES `_ecommerce_fulfillments`(`id`),
	CONSTRAINT "fulfillment_kind" CHECK("kind" IN ('shipment', 'correction')),
	CONSTRAINT "fulfillment_completes_order_flag" CHECK("completes_order" IN (0, 1)),
	CONSTRAINT "fulfillment_correction_names_shipment" CHECK(("kind" = 'shipment') = ("corrects_id" IS NULL)),
	CONSTRAINT "fulfillment_only_shipment_completes" CHECK("kind" = 'shipment' OR "completes_order" = 0)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_gift_card_claims` (
	`id` text PRIMARY KEY,
	`token_hash` text NOT NULL UNIQUE,
	`purchase_id` text NOT NULL,
	`card_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`created_by` text,
	`reason` text,
	CONSTRAINT `fk__ecommerce_gift_card_claims_purchase_id__ecommerce_gift_card_purchases_id_fk` FOREIGN KEY (`purchase_id`) REFERENCES `_ecommerce_gift_card_purchases`(`id`),
	CONSTRAINT `fk__ecommerce_gift_card_claims_card_id__ecommerce_gift_cards_id_fk` FOREIGN KEY (`card_id`) REFERENCES `_ecommerce_gift_cards`(`id`),
	CONSTRAINT "gift_card_claim_expires_after_creation" CHECK("expires_at" > "created_at"),
	CONSTRAINT "gift_card_claim_resend_shape" CHECK(("created_by" IS NULL AND "reason" IS NULL)
    OR ("created_by" IS NOT NULL AND "reason" IS NOT NULL AND length(trim("created_by")) > 0 AND length(trim("reason")) >= 8))
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_gift_card_ledger` (
	`id` text PRIMARY KEY,
	`card_id` text NOT NULL,
	`order_id` text,
	`purchase_id` text,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_gift_card_ledger_card_id__ecommerce_gift_cards_id_fk` FOREIGN KEY (`card_id`) REFERENCES `_ecommerce_gift_cards`(`id`),
	CONSTRAINT `fk__ecommerce_gift_card_ledger_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT `fk__ecommerce_gift_card_ledger_purchase_id__ecommerce_gift_card_purchases_id_fk` FOREIGN KEY (`purchase_id`) REFERENCES `_ecommerce_gift_card_purchases`(`id`),
	CONSTRAINT "gift_card_ledger_kind" CHECK("kind" IN ('issue', 'reserve', 'release', 'refund_restore', 'purchase_reversal')),
	CONSTRAINT "gift_card_ledger_amount_nonzero" CHECK("amount_cents" != 0),
	CONSTRAINT "gift_card_ledger_amount_sign" CHECK(("kind" IN ('issue', 'release', 'refund_restore') AND "amount_cents" > 0)
    OR ("kind" IN ('reserve', 'purchase_reversal') AND "amount_cents" < 0))
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_gift_card_order_refunds` (
	`order_id` text PRIMARY KEY,
	`admin_actor` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_gift_card_order_refunds_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_gift_card_purchases` (
	`id` text PRIMARY KEY,
	`buyer_email` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider_session_id` text UNIQUE,
	`payment_intent_id` text UNIQUE,
	`provider_refunded_cents` integer DEFAULT 0 NOT NULL,
	`refund_adjusted_cents` integer DEFAULT 0 NOT NULL,
	`access_token_hash` text NOT NULL,
	`reconcile_attempts` integer DEFAULT 0 NOT NULL,
	`reconcile_last_at` integer,
	`reconcile_last_error` text,
	`reconcile_review_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "gift_card_purchase_amount_range" CHECK("amount_cents" BETWEEN 500 AND 100000),
	CONSTRAINT "gift_card_purchase_currency_usd" CHECK("currency" = 'usd'),
	CONSTRAINT "gift_card_purchase_status" CHECK("status" IN ('pending', 'paid', 'cancelled', 'partially_refunded', 'refunded', 'review')),
	CONSTRAINT "gift_card_purchase_provider_refunded_nonnegative" CHECK("provider_refunded_cents" >= 0),
	CONSTRAINT "gift_card_purchase_refund_adjusted_within_refunded" CHECK("refund_adjusted_cents" >= 0 AND "refund_adjusted_cents" <= "provider_refunded_cents"),
	CONSTRAINT "gift_card_purchase_reconcile_attempts_nonnegative" CHECK("reconcile_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_gift_card_redemptions` (
	`id` text PRIMARY KEY,
	`card_id` text NOT NULL,
	`order_id` text NOT NULL UNIQUE,
	`amount_cents` integer NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_gift_card_redemptions_card_id__ecommerce_gift_cards_id_fk` FOREIGN KEY (`card_id`) REFERENCES `_ecommerce_gift_cards`(`id`),
	CONSTRAINT `fk__ecommerce_gift_card_redemptions_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT "gift_card_redemption_amount_positive" CHECK("amount_cents" > 0),
	CONSTRAINT "gift_card_redemption_status" CHECK("status" IN ('reserved', 'confirmed', 'cancelled', 'refunded'))
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_gift_card_refunds` (
	`id` text PRIMARY KEY,
	`card_id` text NOT NULL,
	`order_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`admin_actor` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_gift_card_refunds_card_id__ecommerce_gift_cards_id_fk` FOREIGN KEY (`card_id`) REFERENCES `_ecommerce_gift_cards`(`id`),
	CONSTRAINT `fk__ecommerce_gift_card_refunds_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT "gift_card_refund_amount_positive" CHECK("amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_gift_card_reviews` (
	`id` text PRIMARY KEY,
	`purchase_id` text NOT NULL,
	`card_id` text NOT NULL,
	`outcome` text NOT NULL,
	`refunded_cents` integer NOT NULL,
	`adjustment_cents` integer NOT NULL,
	`admin_actor` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_gift_card_reviews_purchase_id__ecommerce_gift_card_purchases_id_fk` FOREIGN KEY (`purchase_id`) REFERENCES `_ecommerce_gift_card_purchases`(`id`),
	CONSTRAINT `fk__ecommerce_gift_card_reviews_card_id__ecommerce_gift_cards_id_fk` FOREIGN KEY (`card_id`) REFERENCES `_ecommerce_gift_cards`(`id`),
	CONSTRAINT "gift_card_review_outcome" CHECK("outcome" IN ('reinstate', 'void')),
	CONSTRAINT "gift_card_review_refunded_positive" CHECK("refunded_cents" > 0),
	CONSTRAINT "gift_card_review_adjustment_nonnegative" CHECK("adjustment_cents" >= 0),
	CONSTRAINT "gift_card_review_admin_actor_filled" CHECK(length(trim("admin_actor")) > 0),
	CONSTRAINT "gift_card_review_reason_length" CHECK(length(trim("reason")) >= 8)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_gift_cards` (
	`id` text PRIMARY KEY,
	`code_hash` text NOT NULL UNIQUE,
	`code_suffix` text NOT NULL,
	`encrypted_code` text NOT NULL,
	`source` text NOT NULL,
	`purchase_id` text UNIQUE,
	`replaces_purchase_id` text,
	`held_for_review` integer DEFAULT false NOT NULL,
	`admin_actor` text,
	`admin_reason` text,
	`initial_cents` integer NOT NULL,
	`balance_cents` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_gift_cards_purchase_id__ecommerce_gift_card_purchases_id_fk` FOREIGN KEY (`purchase_id`) REFERENCES `_ecommerce_gift_card_purchases`(`id`),
	CONSTRAINT `fk__ecommerce_gift_cards_replaces_purchase_id__ecommerce_gift_card_purchases_id_fk` FOREIGN KEY (`replaces_purchase_id`) REFERENCES `_ecommerce_gift_card_purchases`(`id`),
	CONSTRAINT "gift_card_source" CHECK("source" IN ('purchase', 'admin')),
	CONSTRAINT "gift_card_initial_range" CHECK("initial_cents" BETWEEN 500 AND 100000),
	CONSTRAINT "gift_card_balance_within_initial" CHECK("balance_cents" BETWEEN 0 AND "initial_cents"),
	CONSTRAINT "gift_card_currency_usd" CHECK("currency" = 'usd'),
	CONSTRAINT "gift_card_status" CHECK("status" IN ('active', 'suspended', 'void')),
	CONSTRAINT "gift_card_replacement_by_admin" CHECK("replaces_purchase_id" IS NULL OR "source" = 'admin'),
	CONSTRAINT "gift_card_held_for_review_flag" CHECK("held_for_review" IN (0, 1)),
	CONSTRAINT "gift_card_source_shape" CHECK(("source" = 'purchase' AND "purchase_id" IS NOT NULL AND "admin_actor" IS NULL)
    OR ("source" = 'admin' AND "purchase_id" IS NULL AND "admin_actor" IS NOT NULL AND "admin_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_inventory_reservations` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`released_at` integer,
	CONSTRAINT `fk__ecommerce_inventory_reservations_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT "inventory_reservation_target_type" CHECK("target_type" IN ('product', 'variant', 'stock')),
	CONSTRAINT "inventory_reservation_quantity_positive" CHECK("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_orders` (
	`id` text PRIMARY KEY,
	`cart_id` text UNIQUE,
	`user_id` text,
	`checkout_session_id` text,
	`payment_intent_id` text UNIQUE,
	`provider_refunded_cents` integer DEFAULT 0 NOT NULL,
	`payment_provider` text,
	`referral_code` text,
	`referral_reward_cents` integer DEFAULT 0 NOT NULL,
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
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_orders_cart_id__ecommerce_carts_id_fk` FOREIGN KEY (`cart_id`) REFERENCES `_ecommerce_carts`(`id`),
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
CREATE TABLE `_ecommerce_payments` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_id` text NOT NULL,
	`status` text NOT NULL,
	`amount` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_payments_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_product_categories` (
	`product_id` text NOT NULL,
	`category_id` text NOT NULL,
	CONSTRAINT `_ecommerce_product_categories_pk` PRIMARY KEY(`product_id`, `category_id`),
	CONSTRAINT `fk__ecommerce_product_categories_product_id__ecommerce_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `_ecommerce_products`(`id`),
	CONSTRAINT `fk__ecommerce_product_categories_category_id__ecommerce_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `_ecommerce_categories`(`id`)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_product_tags` (
	`product_id` text NOT NULL,
	`tag_id` text NOT NULL,
	CONSTRAINT `_ecommerce_product_tags_pk` PRIMARY KEY(`product_id`, `tag_id`),
	CONSTRAINT `fk__ecommerce_product_tags_product_id__ecommerce_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `_ecommerce_products`(`id`),
	CONSTRAINT `fk__ecommerce_product_tags_tag_id__ecommerce_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `_ecommerce_tags`(`id`)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_product_variant_values` (
	`id` text PRIMARY KEY,
	`product_variant_id` text NOT NULL,
	`value` text NOT NULL,
	`sku` text UNIQUE,
	`image` text,
	`price_override` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_product_variant_values_product_variant_id__ecommerce_product_variants_id_fk` FOREIGN KEY (`product_variant_id`) REFERENCES `_ecommerce_product_variants`(`id`)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_product_variants` (
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
	CONSTRAINT `fk__ecommerce_product_variants_variant_id__ecommerce_variants_id_fk` FOREIGN KEY (`variant_id`) REFERENCES `_ecommerce_variants`(`id`)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_products` (
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
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_provider_refunds` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_refund_id` text,
	`amount_cents` integer NOT NULL,
	`created_at` integer,
	CONSTRAINT `fk__ecommerce_provider_refunds_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT "provider_refund_amount_positive" CHECK("amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_rate_limits` (
	`key` text PRIMARY KEY,
	`count` integer NOT NULL,
	`window_start` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_reconcile_decisions` (
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
	CONSTRAINT "reconcile_decision_action" CHECK("action" IN ('retry', 'release')),
	CONSTRAINT "reconcile_decision_payment_returned" CHECK("payment_returned" IS NULL OR "payment_returned" IN ('refunded', 'dispute_lost', 'confirmed')),
	CONSTRAINT "reconcile_decision_admin_actor_filled" CHECK(length(trim("admin_actor")) > 0),
	CONSTRAINT "reconcile_decision_reason_length" CHECK(length(trim("reason")) >= 8),
	CONSTRAINT "reconcile_decision_names_one_subject" CHECK(("order_id" IS NULL) <> ("purchase_id" IS NULL)),
	CONSTRAINT "reconcile_decision_release_returns" CHECK("payment_returned" IS NULL OR "action" = 'release')
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_referral_codes` (
	`code` text PRIMARY KEY,
	`account_id` text NOT NULL UNIQUE,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_referral_codes_account_id__ecommerce_customer_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `_ecommerce_customer_accounts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_referral_settings` (
	`id` text PRIMARY KEY,
	`enabled` integer DEFAULT true NOT NULL,
	`reward_cents` integer DEFAULT 1000 NOT NULL,
	`min_order_cents` integer DEFAULT 5000 NOT NULL,
	`attribution_days` integer DEFAULT 30 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "referral_settings_singleton" CHECK("id" = 'default'),
	CONSTRAINT "referral_settings_enabled_flag" CHECK("enabled" IN (0, 1)),
	CONSTRAINT "referral_settings_reward_range" CHECK("reward_cents" BETWEEN 1 AND 100000),
	CONSTRAINT "referral_settings_min_order_range" CHECK("min_order_cents" BETWEEN 1 AND 10000000),
	CONSTRAINT "referral_settings_attribution_range" CHECK("attribution_days" BETWEEN 1 AND 90)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_referrals` (
	`id` text PRIMARY KEY,
	`code` text NOT NULL,
	`referrer_account_id` text NOT NULL,
	`referred_account_id` text NOT NULL UNIQUE,
	`order_id` text NOT NULL UNIQUE,
	`reward_cents` integer NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`status` text DEFAULT 'approved' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_referrals_code__ecommerce_referral_codes_code_fk` FOREIGN KEY (`code`) REFERENCES `_ecommerce_referral_codes`(`code`),
	CONSTRAINT `fk__ecommerce_referrals_referrer_account_id__ecommerce_customer_accounts_id_fk` FOREIGN KEY (`referrer_account_id`) REFERENCES `_ecommerce_customer_accounts`(`id`),
	CONSTRAINT `fk__ecommerce_referrals_referred_account_id__ecommerce_customer_accounts_id_fk` FOREIGN KEY (`referred_account_id`) REFERENCES `_ecommerce_customer_accounts`(`id`),
	CONSTRAINT `fk__ecommerce_referrals_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT "referral_reward_nonnegative" CHECK("reward_cents" >= 0),
	CONSTRAINT "referral_status" CHECK("status" IN ('approved', 'void'))
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_restocks` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`reservation_type` text NOT NULL,
	`reservation_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`admin_actor` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_restocks_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT "restock_reservation_type" CHECK("reservation_type" IN ('inventory', 'component')),
	CONSTRAINT "restock_target_type" CHECK("target_type" IN ('product', 'variant', 'stock', 'component')),
	CONSTRAINT "restock_quantity_positive" CHECK("quantity" > 0),
	CONSTRAINT "restock_admin_actor_filled" CHECK(length(trim("admin_actor")) > 0),
	CONSTRAINT "restock_reason_length" CHECK(length(trim("reason")) >= 8)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_sign_in_tokens` (
	`token_hash` text PRIMARY KEY,
	`email_normalized` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_stocks` (
	`id` text PRIMARY KEY,
	`product_variant_value_id` text NOT NULL UNIQUE,
	`quantity` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_stocks_product_variant_value_id__ecommerce_product_variant_values_id_fk` FOREIGN KEY (`product_variant_value_id`) REFERENCES `_ecommerce_product_variant_values`(`id`)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_tags` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL UNIQUE,
	`color` text DEFAULT 'blue' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_tax_reversals` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`reference` text NOT NULL UNIQUE,
	`amount` integer NOT NULL,
	`provider_reversal_id` text NOT NULL,
	`tax_sync_attempts` integer DEFAULT 0 NOT NULL,
	`tax_sync_last_at` integer,
	`tax_sync_last_error` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_tax_reversals_order_id__ecommerce_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `_ecommerce_orders`(`id`),
	CONSTRAINT "tax_reversal_amount_positive" CHECK("amount" > 0),
	CONSTRAINT "tax_reversal_tax_sync_attempts_nonnegative" CHECK("tax_sync_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_variant_components` (
	`id` text PRIMARY KEY,
	`product_variant_value_id` text NOT NULL,
	`component_id` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk__ecommerce_variant_components_product_variant_value_id__ecommerce_product_variant_values_id_fk` FOREIGN KEY (`product_variant_value_id`) REFERENCES `_ecommerce_product_variant_values`(`id`),
	CONSTRAINT `fk__ecommerce_variant_components_component_id__ecommerce_components_id_fk` FOREIGN KEY (`component_id`) REFERENCES `_ecommerce_components`(`id`),
	CONSTRAINT "variant_component_quantity_positive" CHECK("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE `_ecommerce_variants` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_carts_checkout_session_id_unique` ON `_ecommerce_carts` (`checkout_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_carts_user_open_unique` ON `_ecommerce_carts` (`user_id`) WHERE "_ecommerce_carts"."closed" = 0 AND "_ecommerce_carts"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `component_reservation_unique` ON `_ecommerce_component_reservations` (`order_id`,`component_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `credit_ledger_order_kind_unique` ON `_ecommerce_credit_ledger` (`order_id`,`kind`);--> statement-breakpoint
CREATE INDEX `_ecommerce_credit_ledger_account_idx` ON `_ecommerce_credit_ledger` (`account_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_customer_accounts_cms_user_idx` ON `_ecommerce_customer_accounts` (`cms_user_id`) WHERE "_ecommerce_customer_accounts"."cms_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `_ecommerce_customer_sessions_account_idx` ON `_ecommerce_customer_sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_customer_sessions_challenge_idx` ON `_ecommerce_customer_sessions` (`account_id`,`purpose`,`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_discount_redemptions_code_status_idx` ON `_ecommerce_discount_redemptions` (`code`,`status`);--> statement-breakpoint
CREATE INDEX `_ecommerce_discount_redemptions_email_idx` ON `_ecommerce_discount_redemptions` (`code`,`email_normalized`,`status`);--> statement-breakpoint
CREATE INDEX `_ecommerce_disputes_order_idx` ON `_ecommerce_disputes` (`order_id`) WHERE "_ecommerce_disputes"."order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `_ecommerce_disputes_purchase_idx` ON `_ecommerce_disputes` (`gift_card_purchase_id`) WHERE "_ecommerce_disputes"."gift_card_purchase_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_email_deliveries_kind_subject_unique` ON `_ecommerce_email_deliveries` (`kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_email_deliveries_due_idx` ON `_ecommerce_email_deliveries` (`next_attempt_at`) WHERE "_ecommerce_email_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `_ecommerce_fulfillments_order_idx` ON `_ecommerce_fulfillments` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_gift_card_claims_purchase_idx` ON `_ecommerce_gift_card_claims` (`purchase_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_gift_card_ledger_card_idx` ON `_ecommerce_gift_card_ledger` (`card_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_gift_card_purchases_status_created_idx` ON `_ecommerce_gift_card_purchases` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_gift_card_redemptions_card_idx` ON `_ecommerce_gift_card_redemptions` (`card_id`,`status`);--> statement-breakpoint
CREATE INDEX `_ecommerce_gift_card_refunds_order_idx` ON `_ecommerce_gift_card_refunds` (`order_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_gift_card_reviews_purchase_idx` ON `_ecommerce_gift_card_reviews` (`purchase_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_gift_cards_replaces_purchase_idx` ON `_ecommerce_gift_cards` (`replaces_purchase_id`) WHERE "_ecommerce_gift_cards"."replaces_purchase_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_reservation_unique` ON `_ecommerce_inventory_reservations` (`order_id`,`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_user_idx` ON `_ecommerce_orders` (`user_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_checkout_session_idx` ON `_ecommerce_orders` (`checkout_session_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_customer_email_idx` ON `_ecommerce_orders` (lower("customer_email"));--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_pending_idx` ON `_ecommerce_orders` (`created_at`) WHERE "_ecommerce_orders"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_awaiting_idx` ON `_ecommerce_orders` (`created_at`,`id`) WHERE "_ecommerce_orders"."status" IN ('paid', 'partially_refunded') AND "_ecommerce_orders"."fulfillment_status" <> 'fulfilled' AND COALESCE("_ecommerce_orders"."payment_provider", 'stripe') <> 'admin_test';--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_recent_idx` ON `_ecommerce_orders` (`created_at`,`id`) WHERE "_ecommerce_orders"."status" NOT IN ('pending', 'cancelled', 'draft') AND COALESCE("_ecommerce_orders"."payment_provider", 'stripe') <> 'admin_test';--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_tax_refunded_idx` ON `_ecommerce_orders` (`created_at`) WHERE "_ecommerce_orders"."status" IN ('partially_refunded', 'refunded') AND "_ecommerce_orders"."tax_transaction_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `_ecommerce_orders_tax_transaction_missing_idx` ON `_ecommerce_orders` (`status`,`created_at`) WHERE "_ecommerce_orders"."tax_calculation_id" IS NOT NULL AND "_ecommerce_orders"."tax_transaction_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_payments_provider_id_unique` ON `_ecommerce_payments` (`provider`,`provider_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_payments_order_idx` ON `_ecommerce_payments` (`order_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_provider_refunds_order_idx` ON `_ecommerce_provider_refunds` (`order_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_reconcile_decisions_order_idx` ON `_ecommerce_reconcile_decisions` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_reconcile_decisions_purchase_idx` ON `_ecommerce_reconcile_decisions` (`purchase_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_referrals_referrer_idx` ON `_ecommerce_referrals` (`referrer_account_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_restocks_reservation_unique` ON `_ecommerce_restocks` (`reservation_type`,`reservation_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_restocks_order_idx` ON `_ecommerce_restocks` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_sign_in_tokens_email_idx` ON `_ecommerce_sign_in_tokens` (`email_normalized`,`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_tax_reversals_order_idx` ON `_ecommerce_tax_reversals` (`order_id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_tax_reversals_unsent_idx` ON `_ecommerce_tax_reversals` (`created_at`) WHERE "_ecommerce_tax_reversals"."provider_reversal_id" = '';--> statement-breakpoint
CREATE UNIQUE INDEX `variant_component_unique` ON `_ecommerce_variant_components` (`product_variant_value_id`,`component_id`);