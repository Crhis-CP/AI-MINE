-- Preserve old rows. Every new chat attempt can bind transport configuration, including environment-backed models.
ALTER TABLE ai.model_attempt_snapshots ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE ai.model_attempt_snapshots ALTER COLUMN connection_revision DROP NOT NULL;
ALTER TABLE ai.model_attempt_snapshots ALTER COLUMN key_fingerprint DROP NOT NULL;

CREATE TABLE ai.usage_control_versions (
  version integer PRIMARY KEY,
  config jsonb NOT NULL,
  actor text NOT NULL,
  reason text NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai.usage_prices (
  id text PRIMARY KEY,
  version integer NOT NULL,
  price jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai.usage_attempts (
  attempt_id bigint PRIMARY KEY REFERENCES receipt_attempts(id),
  receipt_id bigint NOT NULL REFERENCES receipts(id),
  logical_key text NOT NULL,
  lane text NOT NULL CHECK(lane IN ('news','policy')),
  capability text NOT NULL,
  source_ids text[] NOT NULL,
  object_kind text,
  object_id text,
  reserved_micros bigint NOT NULL,
  submitted boolean NOT NULL DEFAULT false,
  settled_micros bigint,
  state text NOT NULL CHECK(state IN ('reserved','settled','unknown','failed')),
  quote jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_attempts_object ON ai.usage_attempts(lane,object_kind,object_id);
CREATE INDEX usage_attempts_day ON ai.usage_attempts(occurred_at,lane,capability);
CREATE INDEX usage_attempts_input ON ai.usage_attempts(logical_key,occurred_at);
CREATE TABLE ai.usage_breakers (
  id text PRIMARY KEY,
  revision integer NOT NULL DEFAULT 1,
  scope_key text NOT NULL,
  scope jsonb NOT NULL,
  trigger text NOT NULL CHECK(trigger IN ('repeated_input','object_cost','daily_total')),
  state text NOT NULL CHECK(state IN ('warning','open','recovered')),
  window_key text NOT NULL,
  config_version integer NOT NULL,
  current jsonb NOT NULL,
  threshold jsonb NOT NULL,
  warning_at timestamptz,
  opened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  recovered_at timestamptz,
  recovered_by text,
  recovery_reason text,
  receipt_ids text[] NOT NULL
);
CREATE UNIQUE INDEX usage_breaker_open ON ai.usage_breakers(scope_key,trigger) WHERE state='open';
CREATE TABLE ai.usage_protection_events (
  id text PRIMARY KEY,
  kind text NOT NULL,
  lane text,
  capability text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivery_status text NOT NULL DEFAULT 'pending' CHECK(delivery_status IN ('pending','sent','disabled','unknown')),
  delivery_id text,
  sent_at timestamptz
);
CREATE TABLE ai.usage_notice_progress (
  month text PRIMARY KEY,
  notified_micros bigint NOT NULL,
  last_total_micros bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai.usage_sums (
  kind text NOT NULL,
  key text NOT NULL,
  context jsonb NOT NULL,
  settled_micros bigint NOT NULL DEFAULT 0,
  unknown_micros bigint NOT NULL DEFAULT 0,
  reserved_micros bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(kind,key)
);
