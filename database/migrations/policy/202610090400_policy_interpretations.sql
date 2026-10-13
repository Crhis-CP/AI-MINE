CREATE TABLE policy.interpretation_runs (
  id text PRIMARY KEY, fulltext_run_id text NOT NULL REFERENCES policy.fulltext_runs(id), recipe_version text NOT NULL,
  status text NOT NULL DEFAULT 'partial', output jsonb, content_hash text,
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(fulltext_run_id,recipe_version),
  CHECK (output IS NULL OR output->>'publication_authorized' = 'false')
);
CREATE TABLE policy.interpretation_stages (
  run_id text NOT NULL REFERENCES policy.interpretation_runs(id), stage_id text NOT NULL, input_hash text NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('policy_group','policy_interpret','policy_verify')),
  status text NOT NULL CHECK(status IN ('accepted','rejected')), result jsonb, receipt_id bigint NOT NULL, attempt_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,stage_id)
);
