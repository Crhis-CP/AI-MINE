-- Persist the original task identity when repeated preview requests reuse in-flight work.
ALTER TABLE sources.source_previews ADD COLUMN job_id text;
ALTER TABLE sources.source_previews ADD COLUMN started_at timestamptz;
CREATE INDEX source_previews_inflight_binding ON sources.source_previews(source_id,config_hash,permission_version,draft_id)
  WHERE status IN ('queued','running');
ALTER TABLE sources.source_previews ADD COLUMN execution_token uuid;
ALTER TABLE sources.source_previews ADD COLUMN lease_until timestamptz;
