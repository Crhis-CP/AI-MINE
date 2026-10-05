ALTER TABLE enrichment.translation_segments
  ADD COLUMN replacement_plan jsonb,
  ADD COLUMN parent_index integer CHECK (parent_index >= 0 AND parent_index <> segment_index),
  ADD FOREIGN KEY (article_id, revision, recipe, source_hash, parent_index)
    REFERENCES enrichment.translation_segments (article_id, revision, recipe, source_hash, segment_index),
  ADD CHECK (replacement_plan IS NULL OR
    (parent_index IS NULL AND state = 'failed' AND receipt_id IS NOT NULL AND attempt_id IS NOT NULL
      AND jsonb_typeof(replacement_plan) = 'object'));
