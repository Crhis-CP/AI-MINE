CREATE TABLE publication.report_group_members (
  lane text NOT NULL CHECK (lane='news'),
  article_id text PRIMARY KEY,
  group_id uuid NOT NULL,
  anchor_article_id text NOT NULL,
  article_binding jsonb NOT NULL,
  anchor_binding jsonb NOT NULL,
  article_publication_revision integer NOT NULL CHECK (article_publication_revision>0),
  anchor_publication_revision integer NOT NULL CHECK (anchor_publication_revision>0),
  recipe text NOT NULL,
  input_fingerprint text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE INDEX report_group_members_group_idx ON publication.report_group_members(group_id,article_id);
CREATE INDEX report_group_members_anchor_idx ON publication.report_group_members(anchor_article_id);
