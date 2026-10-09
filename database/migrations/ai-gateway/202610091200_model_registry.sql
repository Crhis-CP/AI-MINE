CREATE TABLE ai.model_connections (
  id uuid PRIMARY KEY,
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  config jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  secret_id uuid NOT NULL,
  sealed_secret jsonb NOT NULL,
  fingerprint text NOT NULL,
  passed_revision integer,
  tested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai.model_connection_tests (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES ai.model_connections(id),
  revision integer NOT NULL,
  lane text NOT NULL CHECK(lane IN ('news','policy')),
  status text NOT NULL CHECK(status IN ('queued','running','passed','failed','unknown','paused')),
  actor text NOT NULL,
  detail text,
  receipt_id bigint REFERENCES receipts(id),
  attempt_id bigint REFERENCES receipt_attempts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX model_connection_tests_latest ON ai.model_connection_tests(connection_id,created_at DESC);
CREATE TABLE ai.model_routes (
  capability text PRIMARY KEY,
  revision integer NOT NULL CHECK(revision > 0),
  model_key text NOT NULL,
  connection_revision integer NOT NULL,
  evaluation_id text,
  unevaluated boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
