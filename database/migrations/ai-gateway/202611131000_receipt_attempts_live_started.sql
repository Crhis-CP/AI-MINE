-- usage-protection.ts (base 98d7838c:297,464-468): index live attempt time scans instead of the full history.
-- Large databases: prebuild this index CONCURRENTLY and confirm it is valid before the release transaction.
CREATE INDEX IF NOT EXISTS receipt_attempts_live_started_idx ON public.receipt_attempts (started_at) WHERE origin = 'live';
