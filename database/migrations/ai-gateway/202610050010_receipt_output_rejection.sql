-- Bind a stored response to the attempt that actually returned it, never a guessed latest id.
-- Historical rows stay unbound; original response, usage and cost columns retain their meaning.
ALTER TABLE public.receipts ADD COLUMN response_attempt_id bigint;
ALTER TABLE public.receipt_attempts
  ADD COLUMN response jsonb,
  ADD COLUMN output_rejected_at timestamptz;
