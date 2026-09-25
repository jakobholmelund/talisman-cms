ALTER TABLE `galaxy_auth_session` ADD COLUMN `auth_method` text;--> statement-breakpoint
CREATE UNIQUE INDEX `galaxy_auth_user_email_lower_unique` ON `galaxy_auth_user` (lower(`email`));--> statement-breakpoint
UPDATE `galaxy_auth_user` SET `email` = lower(`email`) WHERE `email` <> lower(`email`);--> statement-breakpoint
ALTER TABLE `_ecommerce_customer_accounts` ADD COLUMN `cms_user_id` text
  REFERENCES `galaxy_auth_user`(`id`) ON DELETE SET NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `_ecommerce_customer_accounts_cms_user_idx`
  ON `_ecommerce_customer_accounts` (`cms_user_id`) WHERE `cms_user_id` IS NOT NULL;--> statement-breakpoint
INSERT INTO `galaxy_auth_user` (`id`, `name`, `email`, `email_verified`, `created_at`, `updated_at`, `role`)
  SELECT 'shopper_' || lower(hex(randomblob(16))), COALESCE(NULLIF(trim(c.name), ''), c.email_normalized),
    c.email_normalized, 1, c.created_at, c.updated_at, 'customer'
  FROM `_ecommerce_customer_accounts` c
  WHERE c.email_verified_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM `galaxy_auth_user` u WHERE lower(u.email) = c.email_normalized)
  ON CONFLICT(email) DO NOTHING;--> statement-breakpoint
UPDATE `_ecommerce_customer_accounts`
  SET `cms_user_id` = (SELECT u.id FROM `galaxy_auth_user` u
    WHERE lower(u.email) = `_ecommerce_customer_accounts`.`email_normalized` LIMIT 1)
  WHERE `email_verified_at` IS NOT NULL AND `cms_user_id` IS NULL;
