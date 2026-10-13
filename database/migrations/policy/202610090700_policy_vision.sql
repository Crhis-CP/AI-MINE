CREATE TABLE policy.vision_runs (
  id text PRIMARY KEY, expression_id text NOT NULL REFERENCES policy.expressions(id), revision_id text NOT NULL REFERENCES policy.document_revisions(id),
  control_version integer NOT NULL, permission_version integer NOT NULL, recipe text NOT NULL, profile_hash text NOT NULL, profile jsonb NOT NULL,
  render_manifest jsonb NOT NULL, render_hash text NOT NULL, status text NOT NULL DEFAULT 'partial', output jsonb, content_hash text,
  updated_at timestamptz NOT NULL DEFAULT now(), CHECK(output IS NULL OR output->>'semantic_verified'='false')
);
CREATE TABLE policy.vision_pages (
  run_id text NOT NULL REFERENCES policy.vision_runs(id), location_id text NOT NULL, image_hash text NOT NULL,
  image_bytes bytea NOT NULL, PRIMARY KEY(run_id,location_id)
);
CREATE TABLE policy.vision_stages (
  run_id text NOT NULL REFERENCES policy.vision_runs(id), stage_id text NOT NULL, input_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('accepted','rejected')), result jsonb, receipt_id bigint NOT NULL, attempt_id text NOT NULL,
  PRIMARY KEY(run_id,stage_id)
);
