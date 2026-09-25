CREATE TABLE `galaxy_entry_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `galaxy_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `galaxy_collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `galaxy_entries` ADD `published_data` text;--> statement-breakpoint
ALTER TABLE `galaxy_entries` ADD `published_revision_id` text;--> statement-breakpoint
ALTER TABLE `galaxy_entries` ADD `archived_at` integer;
--> statement-breakpoint
UPDATE `galaxy_entries`
SET `published_data` = `data`
WHERE `status` = 'published';
--> statement-breakpoint
INSERT INTO `galaxy_entry_revisions` (
	`id`,
	`entry_id`,
	`collection_id`,
	`revision_number`,
	`type`,
	`status`,
	`data`,
	`created_at`
)
SELECT
	'migrated_rev_' || `id`,
	`id`,
	`collection_id`,
	1,
	CASE
		WHEN `status` = 'published' THEN 'publish'
		WHEN `status` = 'archived' THEN 'archive'
		ELSE 'draft_save'
	END,
	`status`,
	CASE
		WHEN `status` = 'published' THEN COALESCE(`published_data`, `data`)
		ELSE `data`
	END,
	`created_at`
FROM `galaxy_entries`;
--> statement-breakpoint
UPDATE `galaxy_entries`
SET `published_revision_id` = 'migrated_rev_' || `id`
WHERE `status` = 'published';
