-- Package 2 event rules in shadow (plan step 2.4): what the new rules say about one revision of one article, next to a
-- snapshot of what the live grouping engine did. Nothing reads these rows to change a membership; they exist to
-- measure agreement and the model calls the rules would save before any switch.
CREATE TABLE events.shadow_decisions (
  lane text NOT NULL DEFAULT 'news' CHECK (lane='news'),
  article_id text NOT NULL,
  article_revision integer NOT NULL CHECK (article_revision>0),
  ruleset text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('same_fact','new_event','undecided','not_judged')),
  rule text NOT NULL CHECK (rule IN ('same_url','content_hash','fingerprint','certain_duplicate','no_candidate',
    'date_apart','similar_unsure','vector_missing','composite','not_passed','manual','historical')),
  target_fact_id bigint,
  target_story_id bigint,
  similarity real,
  -- At most five candidates with the evidence each rule looked at.
  candidates jsonb NOT NULL,
  -- Model calls the live path would still need for this article.
  would_call smallint NOT NULL DEFAULT 0 CHECK (would_call BETWEEN 0 AND 6),
  -- Snapshot of the latest live grouping decision of the article.
  live_verdict text,
  live_fact_id bigint,
  live_story_id bigint,
  live_called boolean,
  live_candidates jsonb,
  decided_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (article_id, article_revision, ruleset),
  CHECK ((verdict='same_fact')=(target_fact_id IS NOT NULL)),
  -- Only "no candidate at all" may found a new event without the model. Two trusted dates far apart (date_apart)
  -- say "not the same fact" but leave the story open, so that row is undecided: a development of an old story must
  -- still reach the relation step instead of splitting the story.
  CHECK (verdict<>'new_event' OR rule='no_candidate')
);
CREATE INDEX shadow_decisions_decided_idx ON events.shadow_decisions(decided_at);
