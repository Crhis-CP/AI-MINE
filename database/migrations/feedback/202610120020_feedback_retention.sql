CREATE SCHEMA IF NOT EXISTS feedback;
ALTER TABLE feedback ALTER COLUMN source_hash DROP NOT NULL;
ALTER TABLE feedback ADD COLUMN completed_at timestamptz;
ALTER TABLE feedback ADD COLUMN anonymized_at timestamptz;
CREATE TABLE feedback.feedback_private_deletions (screenshot_key text PRIMARY KEY, queued_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE feedback.feedback_weekly_summaries (week_start date PRIMARY KEY, summary jsonb NOT NULL, sent_at timestamptz, generated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE feedback DROP CONSTRAINT feedback_status_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_status_check CHECK(status IN ('new','triaged','replied','resolved','spam','archived'));
