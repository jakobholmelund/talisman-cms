-- Entries written straight to D1 (seeds, imports) have no revisions, so the editor could not save
-- them. Record the stored state of each as revision 1, as 0003 did, and pin the published snapshot.
-- Every statement only touches rows that still lack a baseline, so a rerun changes nothing.
UPDATE `galaxy_entries`
SET `published_data` = `data`
WHERE `status` = 'published'
	AND `published_data` IS NULL
	AND NOT EXISTS (SELECT 1 FROM `galaxy_entry_revisions` r WHERE r.`entry_id` = `galaxy_entries`.`id`);
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
	'baseline_rev_' || e.`id`,
	e.`id`,
	e.`collection_id`,
	1,
	CASE
		WHEN e.`status` = 'published' THEN 'publish'
		WHEN e.`status` = 'archived' THEN 'archive'
		ELSE 'draft_save'
	END,
	e.`status`,
	CASE
		WHEN e.`status` = 'published' THEN COALESCE(e.`published_data`, e.`data`)
		ELSE e.`data`
	END,
	e.`updated_at`
FROM `galaxy_entries` e
WHERE NOT EXISTS (SELECT 1 FROM `galaxy_entry_revisions` r WHERE r.`entry_id` = e.`id`);
--> statement-breakpoint
UPDATE `galaxy_entries`
SET `published_revision_id` = 'baseline_rev_' || `id`
WHERE `status` = 'published'
	AND `published_revision_id` IS NULL
	AND EXISTS (SELECT 1 FROM `galaxy_entry_revisions` r WHERE r.`id` = 'baseline_rev_' || `galaxy_entries`.`id`);
--> statement-breakpoint
-- Globals were stored as JSON text inside a JSON string. Unwrap only rows whose value is such a
-- string holding a JSON object. The nested CASE keeps json_type away from invalid JSON.
UPDATE `galaxy_globals`
SET `data` = json_extract(`data`, '$')
WHERE CASE
	WHEN json_valid(`data`) THEN
		CASE
			WHEN json_type(`data`) = 'text' THEN
				CASE
					WHEN json_valid(json_extract(`data`, '$')) THEN json_type(json_extract(`data`, '$')) = 'object'
					ELSE 0
				END
			ELSE 0
		END
	ELSE 0
END;
