-- Structured digest parts (key before/after changes and upcoming milestones). Optional: digests written
-- before this column keep a null detail and read as having neither part.
ALTER TABLE stories ADD COLUMN digest_detail jsonb CHECK (digest_detail IS NULL OR jsonb_typeof(digest_detail) = 'object');
ALTER TABLE story_digests ADD COLUMN digest_detail jsonb CHECK (digest_detail IS NULL OR jsonb_typeof(digest_detail) = 'object');
