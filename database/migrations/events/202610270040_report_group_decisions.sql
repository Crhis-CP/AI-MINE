CREATE TABLE events.report_group_decisions (
  lane text NOT NULL DEFAULT 'news' CHECK (lane='news'),
  input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
  binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  article_id text NOT NULL,
  anchor_article_id text NOT NULL CHECK (anchor_article_id<>article_id),
  article_binding jsonb NOT NULL,
  anchor_binding jsonb NOT NULL,
  recipe text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','waiting','complete')),
  decision jsonb,
  receipt_id bigint,
  attempt_id bigint,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(input_fingerprint,binding_hash),
  CHECK ((state='complete')=(decision IS NOT NULL)),
  CHECK (state<>'complete' OR (receipt_id IS NOT NULL AND receipt_id>0 AND attempt_id IS NOT NULL AND attempt_id>0))
);
CREATE INDEX report_group_decisions_article_idx ON events.report_group_decisions(article_id,updated_at);
CREATE TABLE events.report_group_checks (
  lane text NOT NULL DEFAULT 'news' CHECK (lane='news'),
  article_id text PRIMARY KEY,
  article_binding jsonb NOT NULL,
  recipe text NOT NULL,
  candidate_bindings jsonb NOT NULL,
  publication_versions jsonb NOT NULL,
  group_id uuid,
  state text NOT NULL CHECK (state IN ('complete','waiting')),
  checked_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
