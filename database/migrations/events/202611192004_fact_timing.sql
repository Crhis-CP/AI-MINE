-- Package 2 timing of a fact (plan step 2.5): when it happened, from the members' own date claims checked against
-- their text, and when it was first and last reported. Recomputed on every observation; facts.occurred_at is not
-- written. A fact that loses its last member loses its row.
CREATE TABLE events.fact_timing (
  lane text NOT NULL DEFAULT 'news' CHECK (lane='news'),
  fact_id bigint PRIMARY KEY,
  story_id bigint,
  occurred_on date,
  -- verified: the day is written in a member's original; agreed: two members claim it; claimed: the founder's claim
  -- alone, which never makes a report old on its own.
  occurred_basis text NOT NULL CHECK (occurred_basis IN ('verified','agreed','claimed','none')),
  -- One entry per current member: { "<article_id>": { rev, on, verified, at } }.
  claims jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_reported_at timestamptz NOT NULL,
  first_article_id text NOT NULL,
  last_reported_at timestamptz NOT NULL,
  members integer NOT NULL CHECK (members>0),
  ruleset text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK ((occurred_on IS NULL)=(occurred_basis='none'))
);
CREATE INDEX fact_timing_story_idx ON events.fact_timing(story_id, first_reported_at);
