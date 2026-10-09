-- Older uploaded comparison reports have no route qualification. Only the controlled Owner workflow may install this evidence.
ALTER TABLE selectbench_runs ADD COLUMN model_route_approvals jsonb;
-- Structured sender evidence belongs to the real physical attempt, not a guessed error message.
ALTER TABLE receipt_attempts ADD COLUMN failure_kind text;
CREATE TABLE ai.model_fallback_routes (
 capability text PRIMARY KEY, revision integer NOT NULL CHECK(revision>0),
 primary_model text NOT NULL, primary_configuration_hash text,
 backup_model text, backup_configuration_hash text, backup_connection_revision integer,
 approval_kind text CHECK(approval_kind IN ('selection','policy','capability')), approval_id text,
 source_ids text[] NOT NULL DEFAULT '{}', blocked_reason text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((backup_model IS NULL AND backup_configuration_hash IS NULL AND approval_kind IS NULL AND approval_id IS NULL AND source_ids='{}'::text[])
    OR (backup_model IS NOT NULL AND backup_configuration_hash IS NOT NULL AND primary_configuration_hash IS NOT NULL AND backup_connection_revision IS NOT NULL AND backup_configuration_hash~'^[a-f0-9]{64}$' AND primary_configuration_hash~'^[a-f0-9]{64}$' AND backup_connection_revision>0 AND approval_kind IS NOT NULL AND approval_id IS NOT NULL AND source_ids<>'{}'::text[]))
);
CREATE TABLE ai.model_fallback_resolutions (
 primary_key text NOT NULL, route_revision integer NOT NULL,
 capability text NOT NULL, primary_receipt_id bigint NOT NULL REFERENCES receipts(id), primary_attempt_id bigint NOT NULL REFERENCES receipt_attempts(id),
 backup_model text NOT NULL, backup_configuration_hash text NOT NULL,
 source_ids text[] NOT NULL, permit_fingerprint text NOT NULL,
 backup_receipt_id bigint REFERENCES receipts(id), backup_attempt_id bigint REFERENCES receipt_attempts(id),
 blocked_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(primary_key,route_revision)
);
