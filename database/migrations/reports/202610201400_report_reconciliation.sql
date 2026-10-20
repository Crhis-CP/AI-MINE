ALTER TABLE public.reports ADD COLUMN first_published_at timestamptz;
ALTER TABLE public.reports ADD COLUMN last_revised_at timestamptz;
UPDATE public.reports r SET first_published_at=least(r.generated_at,
  (SELECT min(v.generated_at) FROM public.report_revisions v WHERE v.report_id=r.id));
UPDATE public.reports SET last_revised_at=greatest(generated_at,updated_at) WHERE revision>1;

CREATE TABLE reports.calendar (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  first_daily text NOT NULL
);
INSERT INTO reports.calendar(first_daily)
  SELECT min(key) FROM public.reports WHERE kind='daily' HAVING min(key) IS NOT NULL;

CREATE TABLE reports.reconciliation_jobs (
  kind text NOT NULL CHECK(kind IN ('daily','weekly','monthly')),
  key text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','retry','done','preserved_manual','withdrawn')),
  reason_code text NOT NULL DEFAULT 'source_change',
  evidence jsonb NOT NULL DEFAULT '[]',
  input_hash text,
  result text CHECK(result IN ('revised','unchanged','waiting')),
  message text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY(kind,key)
);
CREATE INDEX report_reconciliation_due ON reports.reconciliation_jobs(next_attempt_at)
  WHERE state IN ('pending','running','retry');
-- Existing issues receive one bounded check. Later deploys do not rescan history.
INSERT INTO reports.reconciliation_jobs(kind,key,period_start,period_end,reason_code)
  SELECT kind,key,window_start,window_end,'historical_review' FROM public.reports;

CREATE TABLE reports.reconciliation_commands (
  actor text NOT NULL,
  command_key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor,command_key)
);
