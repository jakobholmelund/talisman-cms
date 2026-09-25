CREATE INDEX `galaxy_entries_collection_status_created_idx` ON `galaxy_entries` (`collection_id`, `status`, `created_at`);--> statement-breakpoint
CREATE INDEX `galaxy_entries_collection_status_slug_idx` ON `galaxy_entries` (`collection_id`, `status`, `slug`, `created_at`);
