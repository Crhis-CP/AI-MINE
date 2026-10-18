CREATE TABLE ai.model_service_circuits (
  service text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- A cooled service has no sent primary request. Retain that fact without manufacturing a receipt.
ALTER TABLE ai.model_fallback_resolutions ADD COLUMN primary_circuit jsonb;
ALTER TABLE ai.model_fallback_resolutions ALTER COLUMN primary_receipt_id DROP NOT NULL;
ALTER TABLE ai.model_fallback_resolutions ALTER COLUMN primary_attempt_id DROP NOT NULL;
ALTER TABLE ai.model_fallback_resolutions ADD CONSTRAINT model_fallback_primary_evidence CHECK (
  (primary_circuit IS NULL AND primary_receipt_id IS NOT NULL AND primary_attempt_id IS NOT NULL)
  OR (primary_circuit IS NOT NULL AND primary_receipt_id IS NULL AND primary_attempt_id IS NULL)
);
