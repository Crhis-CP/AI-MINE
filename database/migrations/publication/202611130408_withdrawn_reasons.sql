-- TASK-0574: why an automatically published news item is not public. Written by publishArticleTx in the same transaction
-- as the publication row: one row while visibility is 'withdrawn', removed when it becomes public again. Rows appear as
-- publications are republished; older withdrawn items without a row read as "not recorded". Operators only: readers
-- never see it (no public columns), and it decides nothing.
CREATE TABLE publication.withdrawn_reasons (
  article_id text PRIMARY KEY REFERENCES public.publications(article_id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('manual','original_post_not_admitted','non_editorial','blocked','no_material','language_unknown','not_ready')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX withdrawn_reasons_reason ON publication.withdrawn_reasons(reason, updated_at DESC);
