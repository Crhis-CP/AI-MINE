CREATE SCHEMA IF NOT EXISTS ai;

-- Observations do not partition the paid cache. The gateway verifies opaque attempt ownership.
CREATE TABLE ai.translation_receipt_observations (
  scope text NOT NULL CHECK (scope ~ '^article:[a-zA-Z0-9_-]+@[1-9][0-9]*$'),
  receipt_id bigint NOT NULL,
  -- Counter snapshot is not proof of an attempt; unproved historic observations retain null below.
  receipt_version integer NOT NULL CHECK (receipt_version >= 0),
  attempt_id text CHECK (attempt_id ~ '^[1-9][0-9]*$'),
  known_unbilled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (scope, receipt_id, receipt_version)
);
