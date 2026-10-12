-- Spot-check batches for the prefilter. Labels are append-only and do not change publication.
CREATE TABLE ai.prefilter_audit_draws (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  seed text NOT NULL,
  discarded_count integer NOT NULL,
  kept_count integer NOT NULL
);

CREATE TABLE ai.prefilter_audit_items (
  draw_id text NOT NULL REFERENCES ai.prefilter_audit_draws (id),
  position integer NOT NULL CHECK (position >= 0),
  article_id text NOT NULL,
  pool text NOT NULL CHECK (pool IN ('discarded', 'kept')),
  analysis_id bigint NOT NULL,
  title text NOT NULL,
  preview text NOT NULL,
  source_name text NOT NULL,
  discovered_at timestamptz,
  PRIMARY KEY (draw_id, position)
);

CREATE INDEX prefilter_audit_items_article_idx ON ai.prefilter_audit_items (article_id);

CREATE TABLE ai.prefilter_audit_labels (
  article_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  pool text NOT NULL CHECK (pool IN ('discarded', 'kept')),
  decision text NOT NULL CHECK (decision IN ('should_not_discard', 'should_not_keep', 'agree')),
  note text NOT NULL,
  actor text NOT NULL,
  draw_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, revision)
);
