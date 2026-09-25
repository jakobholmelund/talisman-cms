-- A live slug names one published entry per collection. The CMS checks this before a publish, but
-- two publishes at the same moment (or rows written straight to D1) could both pass the check.
--
-- This migration fails with "UNIQUE constraint failed: galaxy_entries.collection_id,
-- galaxy_entries.slug" while two published entries share a slug. List them before migrating with:
--   SELECT collection_id, slug, COUNT(*) AS copies FROM galaxy_entries
--   WHERE status = 'published' GROUP BY collection_id, slug HAVING COUNT(*) > 1;
-- and give all but one of each a new slug (or unpublish them). The site serves the newest of them.
CREATE UNIQUE INDEX `galaxy_entries_published_slug_unique` ON `galaxy_entries` (`collection_id`, `slug`) WHERE `status` = 'published';
