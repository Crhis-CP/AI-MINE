-- Package 2 order of public news by event (plan step 2.5): whether a report is new, a follow-up or old news, the
-- day an old report is filed under, and an importance that leaves outlet counts out. One narrow row per public
-- publication, written only by a worker job (never inside publishArticleTx, never by an admin request). Readers see
-- it only where a request asks for the event order; publications.sort_at and the stored issues are not changed.
CREATE TABLE publication.event_rank (
  lane text NOT NULL DEFAULT 'news' CHECK (lane='news'),
  article_id text PRIMARY KEY,
  article_revision integer NOT NULL CHECK (article_revision>0),
  fact_id bigint,
  story_id bigint,
  reported_at timestamptz NOT NULL,
  freshness text NOT NULL CHECK (freshness IN ('new','follow_up','old')),
  freshness_basis text NOT NULL CHECK (freshness_basis IN ('own_date','fact_date','late_report','recollected','no_evidence')),
  occurred_on date,
  -- Override of the sort time, only for old news; new and follow-up reports keep publications.sort_at.
  anchor_at timestamptz,
  importance numeric(6,2) NOT NULL,
  importance_inputs jsonb NOT NULL,
  genre text NOT NULL CHECK (genre IN ('report','official_release','commentary','roundup','document','post')),
  topic text,
  ruleset text NOT NULL,
  -- Changes only when freshness or anchor_at changes. A reader applies anchor_at only to rows decided at or after
  -- the instant the event order was switched on, so a page readers already saw does not move under them.
  decided_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (anchor_at IS NULL OR freshness='old')
);
CREATE INDEX event_rank_story_idx ON publication.event_rank(story_id, reported_at);
CREATE INDEX event_rank_fact_idx ON publication.event_rank(fact_id);
