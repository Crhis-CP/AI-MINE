-- A returned response becomes usable only after schema, identity and current input checks.
-- Existing decisions stay unconfirmed until their cached response is checked again.
ALTER TABLE ai.model_fallback_resolutions ADD COLUMN accepted_at timestamptz;
CREATE INDEX model_fallback_primary_attempt ON ai.model_fallback_resolutions(primary_receipt_id,primary_attempt_id);
CREATE INDEX model_fallback_backup_attempt ON ai.model_fallback_resolutions(backup_receipt_id,backup_attempt_id);
