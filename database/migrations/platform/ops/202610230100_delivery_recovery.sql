ALTER TABLE public.deliveries
  ADD COLUMN retry_reason text CHECK (retry_reason IN ('not_sent', 'rate_limited')),
  ADD COLUMN retry_at timestamptz,
  ADD COLUMN abandoned_at timestamptz;
CREATE INDEX deliveries_retry_at_idx ON public.deliveries (retry_at, id)
  WHERE status='failed' AND retry_reason IS NOT NULL AND abandoned_at IS NULL;
