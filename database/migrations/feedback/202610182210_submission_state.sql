ALTER TABLE public.feedback_bans ADD COLUMN expires_at timestamptz;
CREATE TABLE feedback.submission_state (
  source_hash text PRIMARY KEY,
  attempts jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(attempts) = 'array'),
  submissions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(submissions) = 'array'),
  paused_until timestamptz,
  expires_at timestamptz NOT NULL
);
CREATE INDEX feedback_state_expiry ON feedback.submission_state(expires_at);
