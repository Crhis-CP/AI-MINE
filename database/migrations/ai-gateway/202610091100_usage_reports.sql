CREATE TABLE ai.usage_observation (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  reuse_started_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai.usage_observation(id) VALUES(true);
CREATE TABLE ai.local_reuse_daily (
  day date NOT NULL,
  lane text NOT NULL CHECK(lane IN ('news','policy','unknown')),
  service text NOT NULL,
  model text NOT NULL,
  purpose text NOT NULL,
  count bigint NOT NULL CHECK(count>=0),
  PRIMARY KEY(day,lane,service,model,purpose)
);
CREATE TABLE ai.usage_monthly_reports (
  month text PRIMARY KEY CHECK(month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  content_hash text NOT NULL,
  report jsonb NOT NULL,
  first_created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT '-infinity',
  notification_state text NOT NULL DEFAULT 'pending' CHECK(notification_state IN ('pending','sending','sent','unknown')),
  notification_attempt text,
  notification_at timestamptz
);
