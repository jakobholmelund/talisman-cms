-- A version on every global, so a save can name the version it loaded and be refused when another
-- editor saved in between. Every save adds one; existing rows start at 1.
ALTER TABLE galaxy_globals ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
