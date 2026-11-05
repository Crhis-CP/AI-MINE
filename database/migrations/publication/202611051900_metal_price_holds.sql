-- A metal price held back alone after a jump (DEC-78补充·五项决定 item 4): the value is kept here, not in
-- publication.metal_prices, so the site keeps showing the last value that went in. The next period of the source decides
-- it: released (the held row is then added to metal_prices) or discarded. Every hold and decision stays as a row with
-- who, when and why; rows are never deleted. At most one hold per series is open.
CREATE TABLE publication.metal_price_holds (
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]*$'),
  series_key text NOT NULL CHECK (series_key ~ '^[a-z]+\.[a-z0-9_]+$'),
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end >= period_start),
  period_label text NOT NULL CHECK (period_label ~ '\S'),
  release_label text NOT NULL CHECK (release_label ~ '\S'),
  release_url text NOT NULL CHECK (release_url ~ '^https://'),
  released_on date,
  value numeric NOT NULL CHECK (value > 0 AND value < 'Infinity'),
  -- The value it was compared with (the previous period's, or the last one that went in) and why it was held.
  compared_value numeric NOT NULL CHECK (compared_value > 0 AND compared_value < 'Infinity'),
  reason text NOT NULL CHECK (reason ~ '\S'),
  held_at timestamptz NOT NULL,
  held_by text NOT NULL CHECK (held_by ~ '\S'),
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'released', 'discarded')),
  decided_at timestamptz,
  decided_by text CHECK (decided_by ~ '\S'),
  decision text CHECK (decision ~ '\S'),
  -- The period whose value decided it, as the source names it.
  decided_period text CHECK (decided_period ~ '\S'),
  PRIMARY KEY (series_key, period_start, release_label, held_at),
  CHECK ((status = 'held') = (decided_at IS NULL)),
  CHECK ((decided_at IS NULL) = (decided_by IS NULL) AND (decided_at IS NULL) = (decision IS NULL) AND (decided_at IS NULL) = (decided_period IS NULL)),
  CHECK (decided_at IS NULL OR decided_at >= held_at)
);
CREATE UNIQUE INDEX metal_price_holds_open ON publication.metal_price_holds (series_key) WHERE status = 'held';
CREATE INDEX metal_price_holds_source ON publication.metal_price_holds (source, held_at);
