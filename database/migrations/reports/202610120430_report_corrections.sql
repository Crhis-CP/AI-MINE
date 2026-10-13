CREATE SCHEMA IF NOT EXISTS reports;
CREATE TABLE reports.correction_jobs (
  report_id bigint PRIMARY KEY REFERENCES public.reports(id),
  requested_revision integer NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','blocked','done')),
  reason_code text NOT NULL CHECK(reason_code IN ('manual_correction','withdrawal','restoration')),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
