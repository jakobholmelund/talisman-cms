CREATE TABLE IF NOT EXISTS `galaxy_auth_user` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `email` text NOT NULL UNIQUE,
  `email_verified` integer NOT NULL DEFAULT 0,
  `image` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `role` text NOT NULL DEFAULT 'editor',
  `banned` integer NOT NULL DEFAULT 0,
  `ban_reason` text,
  `ban_expires` integer
);
CREATE TABLE IF NOT EXISTS `galaxy_auth_session` (
  `id` text PRIMARY KEY NOT NULL,
  `expires_at` integer NOT NULL,
  `token` text NOT NULL UNIQUE,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `ip_address` text,
  `user_agent` text,
  `user_id` text NOT NULL REFERENCES `galaxy_auth_user`(`id`) ON DELETE CASCADE,
  `impersonated_by` text
);
CREATE INDEX IF NOT EXISTS `galaxy_auth_session_user_idx` ON `galaxy_auth_session` (`user_id`);
CREATE TABLE IF NOT EXISTS `galaxy_auth_account` (
  `id` text PRIMARY KEY NOT NULL,
  `account_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `user_id` text NOT NULL REFERENCES `galaxy_auth_user`(`id`) ON DELETE CASCADE,
  `access_token` text,
  `refresh_token` text,
  `id_token` text,
  `access_token_expires_at` integer,
  `refresh_token_expires_at` integer,
  `scope` text,
  `password` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `galaxy_auth_account_user_idx` ON `galaxy_auth_account` (`user_id`);
CREATE TABLE IF NOT EXISTS `galaxy_auth_verification` (
  `id` text PRIMARY KEY NOT NULL,
  `identifier` text NOT NULL,
  `value` text NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS `galaxy_auth_rate_limit` (
  `id` text PRIMARY KEY NOT NULL,
  `key` text NOT NULL UNIQUE,
  `count` integer NOT NULL,
  `last_request` integer NOT NULL
);
