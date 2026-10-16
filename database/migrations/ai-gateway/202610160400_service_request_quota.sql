-- Billing identity and paid-result reuse remain unchanged; requests carry a separate shared service quota.
ALTER TABLE receipt_attempts ADD COLUMN quota_service text;
ALTER TABLE receipt_attempts ADD CONSTRAINT receipt_attempts_quota_service_nonempty CHECK (quota_service IS NULL OR length(quota_service)>0);
CREATE INDEX receipt_attempts_quota_time_idx ON receipt_attempts ((coalesce(quota_service,service)),started_at) WHERE origin='live';
CREATE INDEX receipt_attempts_unattributed_quota_idx ON receipt_attempts (started_at,id) WHERE quota_service IS NULL;
