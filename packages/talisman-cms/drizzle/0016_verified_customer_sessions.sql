ALTER TABLE `_ecommerce_customer_sessions` ADD COLUMN `purpose` text NOT NULL DEFAULT 'session'
  CHECK (`purpose` IN ('session', 'email_challenge'));--> statement-breakpoint
CREATE INDEX `_ecommerce_customer_sessions_challenge_idx`
  ON `_ecommerce_customer_sessions` (`account_id`, `purpose`, `created_at`);--> statement-breakpoint
UPDATE `_ecommerce_customer_sessions` SET `revoked_at` = CAST(strftime('%s', 'now') AS integer)
  WHERE `purpose` = 'session' AND `revoked_at` IS NULL
    AND `account_id` IN (SELECT `id` FROM `_ecommerce_customer_accounts` WHERE `email_verified_at` IS NULL);
