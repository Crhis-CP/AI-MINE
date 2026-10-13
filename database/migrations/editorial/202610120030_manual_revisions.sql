CREATE SCHEMA IF NOT EXISTS editorial;
CREATE TABLE editorial.manual_revisions (
  id bigserial PRIMARY KEY, article_id text NOT NULL REFERENCES articles(id),
  source_revision integer NOT NULL, fields jsonb NOT NULL, evidence_quote text,
  source_checked boolean NOT NULL DEFAULT false, facts_checked boolean NOT NULL DEFAULT false,
  actor text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE editorial.manual_revision_events (
  id bigserial PRIMARY KEY, revision_id bigint NOT NULL REFERENCES editorial.manual_revisions(id),
  state text NOT NULL CHECK(state IN ('draft','active','needs_review','conflict','superseded','withdrawn')),
  actor text NOT NULL, note text, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE editorial_overrides ADD COLUMN manual_revision_id bigint REFERENCES editorial.manual_revisions(id);
ALTER TABLE editorial_overrides ADD COLUMN material_revision integer;
UPDATE editorial_overrides o SET material_revision=a.revision FROM articles a WHERE a.id=o.article_id;
