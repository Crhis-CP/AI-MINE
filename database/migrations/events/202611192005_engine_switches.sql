-- Package 2 grouping cut-over (plan step 2.9): the instant from which grouping runs use the new engine, per lane.
-- Append-only: a rollback is a new row with engine 'legacy', so every past switch stays on record. Runs started
-- before the latest effective_at keep the engine they started with. The reader's order switch is not kept here: the
-- public API may not read events tables, so that switch will be a publication-owned setting.
CREATE TABLE events.engine_switches (
  id bigserial PRIMARY KEY,
  lane text NOT NULL DEFAULT 'news' CHECK (lane='news'),
  component text NOT NULL CHECK (component IN ('grouping')),
  engine text NOT NULL CHECK (engine IN ('legacy','next')),
  effective_at timestamptz NOT NULL,
  actor text NOT NULL CHECK (length(trim(actor))>0),
  reason text NOT NULL CHECK (length(trim(reason))>0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
