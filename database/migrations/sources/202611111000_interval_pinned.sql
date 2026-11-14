-- TASK-0609: an interval a person set in the admin console is kept. Until now the nightly tuning
-- (sources.adapt-intervals) rewrote interval_minutes for every enabled news source, so an edit lasted until 04:20.
-- Existing rows start unpinned: their current values were written by that tuning, not by a person.
ALTER TABLE sources ADD COLUMN interval_pinned boolean NOT NULL DEFAULT false;
