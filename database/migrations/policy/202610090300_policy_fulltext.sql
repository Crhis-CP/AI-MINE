CREATE TABLE policy.processing_controls (
  expression_id text PRIMARY KEY REFERENCES policy.expressions(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>0), paused boolean NOT NULL DEFAULT false,
  reason text NOT NULL DEFAULT 'initial', actor text NOT NULL DEFAULT 'policy-runtime', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE policy.fulltext_runs (
  id text PRIMARY KEY, expression_id text NOT NULL REFERENCES policy.expressions(id),
  revision_id text NOT NULL REFERENCES policy.document_revisions(id), control_version integer NOT NULL,
  recipe_hash text NOT NULL, plan jsonb NOT NULL, status text NOT NULL DEFAULT 'partial',
  output jsonb, updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(status IN ('partial','program_validated','blocked_capacity'))
);
CREATE TABLE policy.fulltext_parts (
  part_id text NOT NULL, recipe_hash text NOT NULL, source_hash text NOT NULL,
  candidate jsonb NOT NULL, receipt_id bigint NOT NULL, attempt_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(part_id,recipe_hash)
);
