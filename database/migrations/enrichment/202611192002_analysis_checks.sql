-- Package 2 program-side checks of one judgement (plan step 2.3): entity links, name rewrites, figures and dates
-- against the original, and dateline demotions. observed means nothing in analyses was changed. A flag only:
-- no model call and no reader-visible change come from a row here. Rows are pruned after 180 days by the
-- retention job, hence the worker's DELETE grant.
CREATE TABLE enrichment.analysis_checks (
  analysis_id bigint PRIMARY KEY,
  article_id text NOT NULL,
  input_revision integer NOT NULL CHECK (input_revision > 0),
  lane text NOT NULL CHECK (lane IN ('news', 'policy')),
  -- The versions of the four checks, e.g. 'linker-v1/names-v1/figures-v1/dateline-v1'.
  recipe text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('observed', 'applied')),
  -- Verdict of the figure check; 'hard' stays report-only until a labelled sample shows it is trustworthy.
  verdict text NOT NULL CHECK (verdict IN ('ok', 'soft', 'hard')),
  figures jsonb NOT NULL DEFAULT '[]',
  names jsonb NOT NULL DEFAULT '[]',
  geography jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analysis_checks_recent_idx ON enrichment.analysis_checks (created_at);
CREATE INDEX analysis_checks_article_idx ON enrichment.analysis_checks (article_id);
