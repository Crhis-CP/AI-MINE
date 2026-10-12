-- Durable counters shared by all feedback writers. Windows use Beijing time in the owning port.
CREATE TABLE feedback.quota_buckets (
  scope text NOT NULL CHECK (scope IN ('client_hour','site_day')),
  bucket_key text NOT NULL,
  window_start timestamptz NOT NULL,
  used integer NOT NULL CHECK (used >= 0),
  PRIMARY KEY(scope,bucket_key,window_start)
);
