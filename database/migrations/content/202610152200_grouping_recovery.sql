-- Durable bounded continuation, independent of worker process restarts.
ALTER TABLE articles ADD COLUMN grouping_retry_at timestamptz;
CREATE INDEX articles_grouping_retry_idx ON articles(grouping_retry_at NULLS FIRST,created_at,id)
  WHERE grouping_status='pending' AND processing_state IN ('analyzed','blocked');
