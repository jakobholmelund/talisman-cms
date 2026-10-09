CREATE INDEX `_ecommerce_gift_card_ledger_order_idx` ON `_ecommerce_gift_card_ledger` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_reconcile_decisions_recent_idx` ON `_ecommerce_reconcile_decisions` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `_ecommerce_tax_sync_decisions_recent_idx` ON `_ecommerce_tax_sync_decisions` (`created_at`,`id`);