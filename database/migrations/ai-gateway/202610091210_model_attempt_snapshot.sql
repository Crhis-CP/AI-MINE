-- A logical receipt may have more than one physical attempt. Each keeps its own non-secret configuration and price basis.
CREATE TABLE ai.model_attempt_snapshots (
  attempt_id bigint PRIMARY KEY REFERENCES receipt_attempts(id),
  connection_id uuid NOT NULL REFERENCES ai.model_connections(id),
  connection_revision integer NOT NULL CHECK(connection_revision > 0),
  configuration_hash text NOT NULL CHECK(configuration_hash ~ '^[a-f0-9]{64}$'),
  key_fingerprint text NOT NULL,
  pricing jsonb NOT NULL
);
