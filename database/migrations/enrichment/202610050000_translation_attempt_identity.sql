-- A gateway-owned opaque identity, verified through its port; no cross-module foreign key.
-- Existing checkpoints keep unknown identity and are not backfilled as proven responses.
ALTER TABLE enrichment.translation_segments
  ADD COLUMN attempt_id text CHECK (attempt_id ~ '^[1-9][0-9]*$');
