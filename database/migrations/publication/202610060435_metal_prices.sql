CREATE SCHEMA IF NOT EXISTS publication;

-- Prices exactly as the registered free official sources publish them: no conversion, rounding or change columns.
-- Rows are never deleted; a later release revising an earlier period is a new row beside the old one.
CREATE TABLE publication.metal_prices (
  series_key text NOT NULL CHECK (series_key ~ '^(nbs|wb|imf)\.[a-z0-9_]+$'),
  source text NOT NULL CHECK (source IN ('nbs', 'worldbank', 'imf')),
  name_zh text NOT NULL CHECK (name_zh ~ '\S'),
  grade text CHECK (grade ~ '\S'),
  benchmark text NOT NULL CHECK (benchmark ~ '\S'),
  delivery_basis text CHECK (delivery_basis ~ '\S'),
  currency text NOT NULL CHECK (currency IN ('CNY', 'USD')),
  unit text NOT NULL CHECK (unit ~ '\S'),
  source_unit text NOT NULL CHECK (source_unit ~ '\S'),
  period_type text NOT NULL CHECK (period_type IN ('ten_day', 'month')),
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end >= period_start),
  period_label text NOT NULL CHECK (period_label ~ '\S'),
  -- The source's own figure; NaN and Infinity sort above every number, so they are excluded explicitly.
  value numeric NOT NULL CHECK (value > 0 AND value < 'Infinity'),
  release_label text NOT NULL CHECK (release_label ~ '\S'),
  release_url text NOT NULL CHECK (release_url ~ '^https://'),
  -- A date only, null when the source names no release day; never padded with a time of day.
  released_on date,
  first_fetched_at timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (series_key, period_start, release_label),
  CHECK (split_part(series_key, '.', 1) = CASE source WHEN 'worldbank' THEN 'wb' ELSE source END),
  CHECK ((source = 'nbs') = (period_type = 'ten_day'))
);
