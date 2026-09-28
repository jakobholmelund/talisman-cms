-- The part of a purchase's provider refund already settled on its cards (taken off a reinstated card,
-- or cancelled with void ones), so a later refund is reviewed only for the rest. Earlier releases never
-- recorded this, so every existing row starts at 0, and a Worker that does not know the column keeps 0.
ALTER TABLE `_ecommerce_gift_card_purchases` ADD COLUMN `refund_adjusted_cents` integer NOT NULL DEFAULT 0
  CHECK (`refund_adjusted_cents` >= 0 AND `refund_adjusted_cents` <= `provider_refunded_cents`);--> statement-breakpoint
-- An administrator-issued card that replaces a purchased one names the purchase, so a refund of that
-- purchase holds the replacement too. Existing cards replace nothing.
ALTER TABLE `_ecommerce_gift_cards` ADD COLUMN `replaces_purchase_id` text
  REFERENCES `_ecommerce_gift_card_purchases`(`id`)
  CHECK (`replaces_purchase_id` IS NULL OR `source` = 'admin');--> statement-breakpoint
-- 1 on a card that a purchase's review hold suspended while it was active, so reinstating the purchase
-- reactivates only those; a card an administrator suspended stays suspended. Existing cards start at 0,
-- so a card that an earlier release suspended stays suspended until an administrator reactivates it.
ALTER TABLE `_ecommerce_gift_cards` ADD COLUMN `held_for_review` integer NOT NULL DEFAULT 0
  CHECK (`held_for_review` IN (0,1));--> statement-breakpoint
CREATE INDEX `_ecommerce_gift_cards_replaces_purchase_idx` ON `_ecommerce_gift_cards` (`replaces_purchase_id`)
  WHERE `replaces_purchase_id` IS NOT NULL;--> statement-breakpoint
-- One row per administrator decision on a purchase held for review: the refund total it covered, the
-- card that held the purchase's value and what it took off the purchase's cards (the ledger holds the
-- matching reversal entries).
CREATE TABLE `_ecommerce_gift_card_reviews` (
  `id` text PRIMARY KEY NOT NULL,
  `purchase_id` text NOT NULL REFERENCES `_ecommerce_gift_card_purchases`(`id`),
  `card_id` text NOT NULL REFERENCES `_ecommerce_gift_cards`(`id`),
  `outcome` text NOT NULL CHECK (`outcome` IN ('reinstate','void')),
  `refunded_cents` integer NOT NULL CHECK (`refunded_cents` > 0),
  `adjustment_cents` integer NOT NULL CHECK (`adjustment_cents` >= 0),
  `admin_actor` text NOT NULL CHECK (length(trim(`admin_actor`)) > 0),
  `reason` text NOT NULL CHECK (length(trim(`reason`)) >= 8),
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `_ecommerce_gift_card_reviews_purchase_idx` ON `_ecommerce_gift_card_reviews` (`purchase_id`,`created_at`);
