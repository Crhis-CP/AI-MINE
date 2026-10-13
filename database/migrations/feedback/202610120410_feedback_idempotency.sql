CREATE TABLE feedback.submissions (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  feedback_id bigint NOT NULL REFERENCES public.feedback(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
