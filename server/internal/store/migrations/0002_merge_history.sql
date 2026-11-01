-- v1.0: offline merge and history retention.

-- Revision and device of each entry's last URL change (open or navigate).
-- Existing rows use updated_revision, which is never older than the true URL
-- change, and an unknown device, so pre-migration changes always count as
-- another device's.
ALTER TABLE entries ADD COLUMN url_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN url_device TEXT NOT NULL DEFAULT '';
UPDATE entries SET url_revision = updated_revision;

-- Oldest retained operation sequence number (1 until something is pruned).
ALTER TABLE session ADD COLUMN min_revision INTEGER NOT NULL DEFAULT 1;

CREATE INDEX operations_created_at ON operations (created_at);
