CREATE SCHEMA IF NOT EXISTS acquisition;
CREATE TABLE acquisition.crawl_hosts (
  host text PRIMARY KEY, next_slot timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  last_finished timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  last_started timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z', cooldown_until timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  lease_token text, lease_until timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z', min_interval_ms integer NOT NULL DEFAULT 2000
);
CREATE TABLE acquisition.robots_observations (
  origin text PRIMARY KEY, status integer NOT NULL, body text NOT NULL, observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL, retry_at timestamptz, error text
);
CREATE TABLE acquisition.crawl_sessions (
  id text PRIMARY KEY, scope text NOT NULL UNIQUE, source_id text NOT NULL, binding text NOT NULL,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE acquisition.crawl_requests (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES acquisition.crawl_sessions(id) ON DELETE CASCADE,
  host text NOT NULL, url text NOT NULL, ready_at timestamptz NOT NULL, state text NOT NULL DEFAULT 'pending',
  lease_token text, fetched_at timestamptz, status integer, headers jsonb, body bytea, error text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE acquisition.crawl_checkpoints (
  session_id text NOT NULL REFERENCES acquisition.crawl_sessions(id) ON DELETE CASCADE,
  name text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(session_id,name)
);
CREATE INDEX crawl_requests_pending ON acquisition.crawl_requests(host,state,ready_at);
