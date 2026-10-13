CREATE TABLE publication.policy_reports (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK(kind IN ('weekly','monthly')),
  period_key text NOT NULL,
  current_revision integer NOT NULL DEFAULT 0 CHECK(current_revision>=0),
  checked_at timestamptz NOT NULL DEFAULT '-infinity',
  UNIQUE(kind,period_key)
);
CREATE TABLE publication.policy_report_revisions (
  report_id text NOT NULL REFERENCES publication.policy_reports(id),
  revision integer NOT NULL CHECK(revision>0),
  revision_id text NOT NULL UNIQUE,
  previous_revision integer,
  content_hash text NOT NULL,
  generated_at timestamptz NOT NULL,
  card jsonb NOT NULL,
  coverage jsonb NOT NULL,
  attributions jsonb NOT NULL,
  change jsonb NOT NULL,
  PRIMARY KEY(report_id,revision),
  CHECK(previous_revision IS NULL OR previous_revision=revision-1)
);
CREATE TABLE publication.policy_report_members (
  report_id text NOT NULL,
  report_revision integer NOT NULL,
  edition_id text NOT NULL,
  label text NOT NULL CHECK(label IN ('period_change','source_date_unknown','backfill','interpretation_update')),
  available_by_cutoff boolean NOT NULL,
  position integer NOT NULL CHECK(position>=0),
  PRIMARY KEY(report_id,report_revision,edition_id),
  UNIQUE(report_id,report_revision,position),
  FOREIGN KEY(report_id,report_revision) REFERENCES publication.policy_report_revisions(report_id,revision)
);
