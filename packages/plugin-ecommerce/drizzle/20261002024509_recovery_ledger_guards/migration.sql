DROP TRIGGER `_ecommerce_fulfillment_complete`;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_fulfillment_complete` AFTER INSERT ON `_ecommerce_fulfillments`
WHEN NEW.kind IN ('shipment','reopen','complete')
BEGIN
 UPDATE _ecommerce_orders SET updated_at = MAX(updated_at + 1, NEW.created_at),
   fulfillment_status = CASE WHEN NEW.kind = 'reopen' THEN 'partially_fulfilled'
     WHEN NEW.kind = 'complete' OR NEW.completes_order = 1 THEN 'fulfilled' ELSE 'partially_fulfilled' END
 WHERE id = NEW.order_id;
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_fulfillment_progress_guard` BEFORE INSERT ON `_ecommerce_fulfillments`
WHEN NEW.kind IN ('reopen','complete') AND NOT EXISTS (
 SELECT 1 FROM _ecommerce_orders o WHERE o.id = NEW.order_id AND COALESCE(o.payment_provider,'stripe') <> 'admin_test'
  AND ((NEW.kind = 'reopen' AND o.status IN ('paid','partially_refunded') AND o.fulfillment_status = 'fulfilled')
    OR (NEW.kind = 'complete' AND o.status IN ('paid','partially_refunded','refunded') AND o.fulfillment_status = 'partially_fulfilled')))
BEGIN SELECT RAISE(ABORT, 'Fulfillment progress cannot be changed'); END;
--> statement-breakpoint
DROP TRIGGER `_ecommerce_gift_card_release`;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_release` AFTER UPDATE OF `status` ON `_ecommerce_gift_card_redemptions`
WHEN NEW.status IN ('cancelled','refunded')
BEGIN
  INSERT INTO `_ecommerce_gift_card_ledger` (`id`,`card_id`,`order_id`,`kind`,`amount_cents`,`created_at`)
    SELECT 'gcl_' || NEW.status || '_' || NEW.order_id,COALESCE((SELECT target.id FROM _ecommerce_gift_cards original JOIN _ecommerce_gift_cards target
 ON (target.id = original.id AND original.status <> 'void') OR
    (original.status = 'void' AND COALESCE(original.purchase_id,original.replaces_purchase_id) IS NOT NULL
      AND COALESCE(target.purchase_id,target.replaces_purchase_id) = COALESCE(original.purchase_id,original.replaces_purchase_id))
 WHERE original.id = NEW.card_id AND target.status <> 'void' ORDER BY target.rowid DESC LIMIT 1),
 RAISE(ABORT, 'Gift card refund requires a usable replacement')),NEW.order_id,
      CASE WHEN NEW.status = 'cancelled' THEN 'release' ELSE 'refund_restore' END,
      NEW.amount_cents - (SELECT COALESCE(SUM(amount_cents),0) FROM `_ecommerce_gift_card_refunds` WHERE order_id = NEW.order_id),
      NEW.updated_at
    WHERE NEW.amount_cents > (SELECT COALESCE(SUM(amount_cents),0) FROM `_ecommerce_gift_card_refunds` WHERE order_id = NEW.order_id);
END;
--> statement-breakpoint
DROP TRIGGER `_ecommerce_gift_card_partial_refund`;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_partial_refund` AFTER INSERT ON `_ecommerce_gift_card_refunds`
BEGIN
  INSERT INTO `_ecommerce_gift_card_ledger` (`id`,`card_id`,`order_id`,`kind`,`amount_cents`,`created_at`)
    VALUES ('gcl_refund_' || NEW.id,COALESCE((SELECT target.id FROM _ecommerce_gift_cards original JOIN _ecommerce_gift_cards target
 ON (target.id = original.id AND original.status <> 'void') OR
    (original.status = 'void' AND COALESCE(original.purchase_id,original.replaces_purchase_id) IS NOT NULL
      AND COALESCE(target.purchase_id,target.replaces_purchase_id) = COALESCE(original.purchase_id,original.replaces_purchase_id))
 WHERE original.id = NEW.card_id AND target.status <> 'void' ORDER BY target.rowid DESC LIMIT 1),
 RAISE(ABORT, 'Gift card refund requires a usable replacement')),NEW.order_id,'refund_restore',NEW.amount_cents,NEW.created_at);
  UPDATE `_ecommerce_orders` SET `gift_card_refunded_cents` = `gift_card_refunded_cents` + NEW.amount_cents,
    `status` = 'partially_refunded',
    `updated_at` = NEW.created_at WHERE id = NEW.order_id;
END;
--> statement-breakpoint
DROP TRIGGER `_ecommerce_gift_card_ledger_balance`;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_ledger_balance` AFTER INSERT ON `_ecommerce_gift_card_ledger`
BEGIN
 UPDATE _ecommerce_gift_cards SET restored_cents = restored_cents + NEW.amount_cents
 WHERE id = NEW.card_id AND replaces_purchase_id IS NOT NULL AND NEW.kind = 'refund_restore';
  UPDATE `_ecommerce_gift_cards` SET `balance_cents` = `balance_cents` + NEW.amount_cents,
    `updated_at` = NEW.created_at WHERE id = NEW.card_id;
END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_tax_reversal_cap` BEFORE INSERT ON `_ecommerce_tax_reversals`
WHEN NOT EXISTS (SELECT 1 FROM _ecommerce_orders o WHERE o.id = NEW.order_id AND o.tax_transaction_id IS NOT NULL
 AND NEW.amount + (SELECT COALESCE(SUM(amount),0) FROM _ecommerce_tax_reversals WHERE order_id = NEW.order_id)
 <= CASE WHEN o.status = 'refunded' THEN o.total_amount + o.gift_card_applied ELSE o.provider_refunded_cents + o.gift_card_refunded_cents END)
BEGIN SELECT RAISE(ABORT, 'Tax reversal exceeds refunded tender'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_tax_reversal_immutable` BEFORE UPDATE ON `_ecommerce_tax_reversals`
WHEN NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id OR NEW.reference <> OLD.reference
 OR NEW.amount <> OLD.amount OR NEW.created_at <> OLD.created_at
 OR (OLD.provider_reversal_id <> '' AND NEW.provider_reversal_id <> OLD.provider_reversal_id)
BEGIN SELECT RAISE(ABORT, 'Tax reversal accounting is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_tax_reversal_no_delete` BEFORE DELETE ON `_ecommerce_tax_reversals`
BEGIN SELECT RAISE(ABORT, 'Tax reversal accounting is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_customer_session_account_guard` BEFORE INSERT ON `_ecommerce_customer_sessions`
WHEN NOT EXISTS (SELECT 1 FROM _ecommerce_customer_accounts a WHERE a.id = NEW.account_id
 AND a.anonymized_at IS NULL AND a.session_version = NEW.session_version)
BEGIN SELECT RAISE(ABORT, 'Shopper credentials have been revoked'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_credit_ledger_no_update` BEFORE UPDATE ON `_ecommerce_credit_ledger`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_credit_ledger_no_delete` BEFORE DELETE ON `_ecommerce_credit_ledger`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_ledger_no_update` BEFORE UPDATE ON `_ecommerce_gift_card_ledger`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_ledger_no_delete` BEFORE DELETE ON `_ecommerce_gift_card_ledger`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_provider_refunds_no_update` BEFORE UPDATE ON `_ecommerce_provider_refunds`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_provider_refunds_no_delete` BEFORE DELETE ON `_ecommerce_provider_refunds`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_refunds_no_update` BEFORE UPDATE ON `_ecommerce_gift_card_refunds`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_refunds_no_delete` BEFORE DELETE ON `_ecommerce_gift_card_refunds`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_reviews_no_update` BEFORE UPDATE ON `_ecommerce_gift_card_reviews`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_reviews_no_delete` BEFORE DELETE ON `_ecommerce_gift_card_reviews`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_order_refunds_no_update` BEFORE UPDATE ON `_ecommerce_gift_card_order_refunds`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_gift_card_order_refunds_no_delete` BEFORE DELETE ON `_ecommerce_gift_card_order_refunds`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_restocks_no_update` BEFORE UPDATE ON `_ecommerce_restocks`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_restocks_no_delete` BEFORE DELETE ON `_ecommerce_restocks`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_fulfillments_no_update` BEFORE UPDATE ON `_ecommerce_fulfillments`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_fulfillments_no_delete` BEFORE DELETE ON `_ecommerce_fulfillments`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_reconcile_decisions_no_update` BEFORE UPDATE ON `_ecommerce_reconcile_decisions`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_reconcile_decisions_no_delete` BEFORE DELETE ON `_ecommerce_reconcile_decisions`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_shopper_audits_no_update` BEFORE UPDATE ON `_ecommerce_shopper_audits`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_shopper_audits_no_delete` BEFORE DELETE ON `_ecommerce_shopper_audits`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_tax_sync_decisions_no_update` BEFORE UPDATE ON `_ecommerce_tax_sync_decisions`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `_ecommerce_tax_sync_decisions_no_delete` BEFORE DELETE ON `_ecommerce_tax_sync_decisions`
BEGIN SELECT RAISE(ABORT, 'Commerce accounting is append-only'); END;

--> statement-breakpoint
CREATE TRIGGER `_ecommerce_order_account_guard` BEFORE INSERT ON `_ecommerce_orders`
WHEN NEW.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM _ecommerce_customer_accounts a WHERE a.id = NEW.user_id AND a.anonymized_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Shopper account changed during checkout'); END;
