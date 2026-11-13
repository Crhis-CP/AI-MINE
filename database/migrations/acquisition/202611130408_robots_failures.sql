-- TASK-0574: robots.txt read failures are stored beside the last good copy instead of over it (RFC 9309 §2.3.1.4).
-- status/body/observed_at keep the last good observation (status 0: none was ever read); failure_since/count/reason
-- describe the current streak of 5xx/429/network failures; final_url records where redirects ended; warning keeps a
-- non-blocking note (HTML soft-404, 4xx "unavailable"). Hosts count consecutive transport failures for backoff.
ALTER TABLE acquisition.robots_observations
  ADD COLUMN final_url text,
  ADD COLUMN warning text,
  ADD COLUMN failure_since timestamptz,
  ADD COLUMN failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN failure_reason text;
-- Existing failure rows replaced their good copy already, so they hold none; they start a streak at their observation.
UPDATE acquisition.robots_observations SET status=0,body='',failure_since=observed_at,failure_count=1,failure_reason='robots_unavailable'
  WHERE error='robots_unavailable';
ALTER TABLE acquisition.crawl_hosts
  ADD COLUMN transport_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN transport_cause text;
