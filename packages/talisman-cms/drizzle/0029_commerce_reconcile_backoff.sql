-- Reconciliation records each attempt on a pending order or gift card purchase: how many were made,
-- when the last one ran, and its failure as a short code (never provider text or personal data). A row
-- that keeps failing waits longer between attempts, so newer rows are reached first. A permanent
-- failure (a session the provider no longer has, a session of the other Stripe mode, a completed
-- payment that does not match) sets `reconcile_review_at`, which parks the row until an administrator
-- retries or releases it; `_ecommerce_reconcile_decisions` records who did and why. Existing rows start
-- untried and unparked, and a Worker that does not know these columns leaves them alone.
ALTER TABLE `_ecommerce_orders` ADD COLUMN `reconcile_attempts` integer NOT NULL DEFAULT 0
  CHECK (`reconcile_attempts` >= 0);--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `reconcile_last_at` integer;--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `reconcile_last_error` text;--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `reconcile_review_at` integer;--> statement-breakpoint
ALTER TABLE `_ecommerce_gift_card_purchases` ADD COLUMN `reconcile_attempts` integer NOT NULL DEFAULT 0
  CHECK (`reconcile_attempts` >= 0);--> statement-breakpoint
ALTER TABLE `_ecommerce_gift_card_purchases` ADD COLUMN `reconcile_last_at` integer;--> statement-breakpoint
ALTER TABLE `_ecommerce_gift_card_purchases` ADD COLUMN `reconcile_last_error` text;--> statement-breakpoint
ALTER TABLE `_ecommerce_gift_card_purchases` ADD COLUMN `reconcile_review_at` integer;--> statement-breakpoint
-- Reconciliation and the parked list read pending rows by age. For orders the index holds pending rows
-- only, and a query uses it when it states `status = 'pending'` word for word. An index on (status,
-- created_at) would draw the orders queue of 0026 away from its partial indexes: without table
-- statistics SQLite reads it by status and sorts every paid order, shipped or not, for each page.
CREATE INDEX `_ecommerce_orders_pending_idx` ON `_ecommerce_orders` (`created_at`)
  WHERE `status` = 'pending';--> statement-breakpoint
CREATE INDEX `_ecommerce_gift_card_purchases_status_created_idx`
  ON `_ecommerce_gift_card_purchases` (`status`, `created_at`);--> statement-breakpoint
-- A refund updates its order's payment rows, and commerce analytics joins payments to their orders.
CREATE INDEX `_ecommerce_payments_order_idx` ON `_ecommerce_payments` (`order_id`);--> statement-breakpoint
-- Checkout resume finds a basket's order by its checkout session. Not unique, so no existing row can
-- stop the migration.
CREATE INDEX `_ecommerce_orders_checkout_session_idx` ON `_ecommerce_orders` (`checkout_session_id`);--> statement-breakpoint
-- better-auth reads the newest verification row of an identifier and deletes an identifier's rows.
CREATE INDEX `galaxy_auth_verification_identifier_idx` ON `galaxy_auth_verification` (`identifier`, `created_at`);--> statement-breakpoint
-- One row per administrator decision on a parked order or gift card purchase, written in the batch that
-- carries it out: who decided, why, and the failure the record was parked with. A release of a
-- completed checkout also records how the return of its payment was established: Stripe reported it
-- refunded in full or lost to a dispute, or, where Stripe named no payment to check, the administrator
-- confirmed it. Rows are only ever added.
CREATE TABLE `_ecommerce_reconcile_decisions` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text REFERENCES `_ecommerce_orders`(`id`),
  `purchase_id` text REFERENCES `_ecommerce_gift_card_purchases`(`id`),
  `action` text NOT NULL CHECK (`action` IN ('retry','release')),
  `failure` text,
  `payment_returned` text CHECK (`payment_returned` IN ('refunded','dispute_lost','confirmed')),
  `admin_actor` text NOT NULL CHECK (length(trim(`admin_actor`)) > 0),
  `reason` text NOT NULL CHECK (length(trim(`reason`)) >= 8),
  `created_at` integer NOT NULL,
  CHECK ((`order_id` IS NULL) <> (`purchase_id` IS NULL)),
  CHECK (`payment_returned` IS NULL OR `action` = 'release')
);--> statement-breakpoint
CREATE INDEX `_ecommerce_reconcile_decisions_order_idx` ON `_ecommerce_reconcile_decisions` (`order_id`, `created_at`);--> statement-breakpoint
CREATE INDEX `_ecommerce_reconcile_decisions_purchase_idx` ON `_ecommerce_reconcile_decisions` (`purchase_id`, `created_at`);--> statement-breakpoint
-- The tax passes count their attempts apart from the payment ones above: they act on paid and refunded
-- orders, and on reversals whose request failed, where payment reconciliation acts on pending rows. An
-- order's count covers recording its tax transaction and later the reversals of its refunds; a
-- reversal's own count covers sending it. A record or reversal that keeps failing, such as one of an
-- expired calculation or one whose reference Stripe's 24-hour idempotency window no longer covers, then
-- waits longer between attempts, so newer ones are reached first. The error is a short code, and a
-- success clears the count. Existing rows start untried, and a Worker that does not know these columns
-- leaves them alone.
ALTER TABLE `_ecommerce_orders` ADD COLUMN `tax_sync_attempts` integer NOT NULL DEFAULT 0
  CHECK (`tax_sync_attempts` >= 0);--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `tax_sync_last_at` integer;--> statement-breakpoint
ALTER TABLE `_ecommerce_orders` ADD COLUMN `tax_sync_last_error` text;--> statement-breakpoint
ALTER TABLE `_ecommerce_tax_reversals` ADD COLUMN `tax_sync_attempts` integer NOT NULL DEFAULT 0
  CHECK (`tax_sync_attempts` >= 0);--> statement-breakpoint
ALTER TABLE `_ecommerce_tax_reversals` ADD COLUMN `tax_sync_last_at` integer;--> statement-breakpoint
ALTER TABLE `_ecommerce_tax_reversals` ADD COLUMN `tax_sync_last_error` text;--> statement-breakpoint
-- The tax passes find their rows through partial indexes, and each query repeats its index's conditions.
-- Paid orders without a transaction keep 0025's index. Reversals not sent yet:
CREATE INDEX `_ecommerce_tax_reversals_unsent_idx` ON `_ecommerce_tax_reversals` (`created_at`)
  WHERE `provider_reversal_id` = '';--> statement-breakpoint
-- Refunded orders with a tax transaction, whose refunds may not all be reversed yet. No other query
-- states these conditions, so the index draws neither the orders queue nor the lookup of 0025 away.
CREATE INDEX `_ecommerce_orders_tax_refunded_idx` ON `_ecommerce_orders` (`created_at`)
  WHERE `status` IN ('partially_refunded','refunded') AND `tax_transaction_id` IS NOT NULL;
