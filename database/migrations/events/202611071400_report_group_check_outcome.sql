-- TASK-0578: a report-group comparison that retrying cannot change ends with one recorded outcome instead of failing
-- the events.group job; the recovery pass reads it so the same article is not sent back every two minutes.
ALTER TABLE events.report_group_checks
  ADD COLUMN outcome text CHECK (outcome IN ('not_public','unusable_answer','superseded')),
  ADD COLUMN outcome_at timestamptz,
  ADD CONSTRAINT report_group_checks_outcome_time CHECK ((outcome IS NULL)=(outcome_at IS NULL));
