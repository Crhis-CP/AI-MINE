-- One real-world event must not stay split into several stories (TASK-0575, DEC-78补充 2026-11-07).
-- Every judgement of the hourly story merge sweep, and every pair queued for it, is one row: the queue,
-- the memory of judged pairs (no second purchase while neither story changed) and the audit trail.
CREATE TABLE events.story_merge_decisions (
  id uuid PRIMARY KEY,
  lane text NOT NULL DEFAULT 'news' CHECK (lane='news'),
  low_story_id bigint NOT NULL,
  high_story_id bigint NOT NULL,
  earlier_story_id bigint,
  origin text NOT NULL CHECK (origin IN ('intake','related','gate','backfill')),
  outcome text NOT NULL CHECK (outcome IN ('queued','merged','different','skipped')),
  reason text,
  input_key text,
  earlier_fact_id bigint,
  later_fact_id bigint,
  first_relation text,
  first_confidence numeric(4,3),
  second_relation text,
  second_confidence numeric(4,3),
  receipt_ids bigint[] NOT NULL DEFAULT '{}',
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (low_story_id<high_story_id),
  CHECK (earlier_story_id IS NULL OR earlier_story_id IN (low_story_id,high_story_id))
);
CREATE INDEX story_merge_decisions_pair_idx ON events.story_merge_decisions(low_story_id,high_story_id,created_at DESC);
CREATE INDEX story_merge_decisions_time_idx ON events.story_merge_decisions(created_at);

-- The daily duplicate measurement: pairs of live stories that pass the merge candidate gate but are neither merged nor
-- judged different, and report groups visible to readers that belong to no story. ops.alerts reads the latest row.
CREATE TABLE events.story_duplicate_metrics (
  lane text NOT NULL DEFAULT 'news' CHECK (lane='news'),
  day date PRIMARY KEY,
  suspected_pairs integer NOT NULL CHECK (suspected_pairs>=0),
  unattached_report_groups integer NOT NULL CHECK (unattached_report_groups>=0),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  measured_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
