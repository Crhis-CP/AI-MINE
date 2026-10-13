-- Existing rows remain NULL: enabling delivery must not forward historical feedback.
ALTER TABLE public.feedback ADD COLUMN forward_status text
  CHECK (forward_status IN ('pending','sending','retry','sent','unknown','cancelled'));
ALTER TABLE public.feedback ADD COLUMN forward_attempted_at timestamptz;
ALTER TABLE public.feedback ADD COLUMN forwarded_at timestamptz;
ALTER TABLE public.feedback ADD COLUMN forward_message_id text;
ALTER TABLE public.feedback ADD COLUMN forward_image_key text;
ALTER TABLE public.feedback ADD COLUMN forward_error text;
CREATE INDEX feedback_forward_pending ON public.feedback(id)
  WHERE forward_status IN ('pending','retry','sending');
