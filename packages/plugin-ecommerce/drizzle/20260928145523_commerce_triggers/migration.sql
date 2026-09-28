-- The commerce triggers: the invariants the tables cannot express as constraints. Written by
-- hand, because drizzle-kit does not model triggers, in this custom migration. A later change goes
-- in a new custom migration that drops and recreates the trigger. SQLite drops a table's triggers
-- with the table, so a migration that rebuilds one of these tables recreates its triggers after
-- the rebuild.
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
