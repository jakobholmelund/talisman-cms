-- A draft save used to rename a published entry's live URL. `slug` now stays the live slug of a
-- published entry, and a rename waits in `draft_slug` until the entry is published again.
ALTER TABLE `galaxy_entries` ADD `draft_slug` text;
