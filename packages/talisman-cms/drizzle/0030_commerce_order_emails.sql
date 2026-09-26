-- Order confirmations, shipment notices and gift card claim emails. A row is written in the same batch
-- as the payment, shipment or purchase that calls for its email, and UNIQUE (kind, subject_id) makes a
-- duplicate webhook or the reconciliation path find the row already there, so one email is sent. Rows
-- hold no address: the recipient is read from the order or purchase at send time, and `last_error`
-- holds an error code, never a message. `claimed_at` is the lease of the Worker sending the email.
CREATE TABLE `_ecommerce_email_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('order_confirmation','shipment','shipment_update','gift_card_claim')),
  `subject_id` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending','sent','failed','cancelled')),
  `attempts` integer NOT NULL DEFAULT 0 CHECK (`attempts` >= 0),
  `last_error` text,
  `next_attempt_at` integer NOT NULL,
  `claimed_at` integer,
  `sent_at` integer,
  `created_at` integer NOT NULL,
  UNIQUE (`kind`, `subject_id`),
  CHECK ((`status` = 'sent') = (`sent_at` IS NOT NULL))
);--> statement-breakpoint
-- The scheduled job reads the emails due for another attempt, earliest first.
CREATE INDEX `_ecommerce_email_deliveries_due_idx` ON `_ecommerce_email_deliveries` (`next_attempt_at`)
  WHERE `status` = 'pending';--> statement-breakpoint
-- One-time links that show a purchased gift card's code. Only the SHA-256 hash of the link's token is
-- stored, so a link cannot be sent twice: each email carries a new one. A link shows the code of the
-- card it was made for, once and before it expires, while that card is active. A resend records the
-- administrator and the reason.
CREATE TABLE `_ecommerce_gift_card_claims` (
  `id` text PRIMARY KEY NOT NULL,
  `token_hash` text NOT NULL UNIQUE,
  `purchase_id` text NOT NULL REFERENCES `_ecommerce_gift_card_purchases`(`id`),
  `card_id` text NOT NULL REFERENCES `_ecommerce_gift_cards`(`id`),
  `expires_at` integer NOT NULL,
  `used_at` integer,
  `revoked_at` integer,
  `created_at` integer NOT NULL,
  `created_by` text,
  `reason` text,
  CHECK (`expires_at` > `created_at`),
  -- Spelled out for NULL: a CHECK that evaluates to NULL passes.
  CHECK ((`created_by` IS NULL AND `reason` IS NULL)
    OR (`created_by` IS NOT NULL AND `reason` IS NOT NULL
      AND length(trim(`created_by`)) > 0 AND length(trim(`reason`)) >= 8))
);--> statement-breakpoint
CREATE INDEX `_ecommerce_gift_card_claims_purchase_idx` ON `_ecommerce_gift_card_claims` (`purchase_id`, `created_at`);--> statement-breakpoint
-- A link is made only for an active card of its purchase: the purchased card or a replacement for it.
CREATE TRIGGER `_ecommerce_gift_card_claim_guard` BEFORE INSERT ON `_ecommerce_gift_card_claims`
WHEN NOT EXISTS (
  SELECT 1 FROM `_ecommerce_gift_cards` c WHERE c.id = NEW.card_id AND c.status = 'active'
    AND (c.purchase_id = NEW.purchase_id OR c.replaces_purchase_id = NEW.purchase_id)
)
BEGIN SELECT RAISE(ABORT, 'Gift card cannot be claimed'); END;
