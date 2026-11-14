-- Near-identical reprints, recognised before analysis (TASK-0661, for growing towards 1000 sources).
-- One row per article revision whose body is long enough: its 64-bit SimHash cut into seven bands, each stored as
-- position × 1024 + value (two texts at most 6 bits apart share at least one band), a normalised title, and the
-- closest earlier article from
-- another source found in the last 14 days. Record only: every article is still analysed as before and grouping is
-- unchanged; scripts/near-duplicate-report.ts measures how often a match later lands in the same event.
CREATE TABLE enrichment.near_duplicates (
  article_id text NOT NULL,
  input_revision integer NOT NULL CHECK (input_revision > 0),
  source_id text NOT NULL,
  simhash bigint NOT NULL,
  bands integer[] NOT NULL,
  title_key text NOT NULL,
  recipe text NOT NULL,
  match_article_id text,
  match_distance smallint CHECK (match_distance BETWEEN 0 AND 64),
  match_title_similarity numeric(4, 3) CHECK (match_title_similarity BETWEEN 0 AND 1),
  computed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (article_id, input_revision),
  CHECK ((match_article_id IS NULL) = (match_distance IS NULL) AND (match_article_id IS NULL) = (match_title_similarity IS NULL))
);
CREATE INDEX near_duplicates_bands_idx ON enrichment.near_duplicates USING gin (bands);
CREATE INDEX near_duplicates_time_idx ON enrichment.near_duplicates (computed_at);
