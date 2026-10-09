-- TASK-0082: add only the weekly source; keep the bureau, daily and monthly source checks.
ALTER TABLE publication.metal_prices
  DROP CONSTRAINT metal_prices_series_key_check,
  ADD CONSTRAINT metal_prices_series_key_check CHECK (series_key ~ '^(nbs|wb|imf|cbr|mofcom)\.[a-z0-9_]+$'),
  DROP CONSTRAINT metal_prices_source_check,
  ADD CONSTRAINT metal_prices_source_check CHECK (source IN ('nbs', 'worldbank', 'imf', 'cbr', 'mofcom')),
  DROP CONSTRAINT metal_prices_period_type_check,
  ADD CONSTRAINT metal_prices_period_type_check CHECK (period_type IN ('ten_day', 'month', 'day', 'week')),
  ADD CONSTRAINT metal_prices_mofcom_week CHECK ((source = 'mofcom') = (period_type = 'week')),
  ADD CONSTRAINT metal_prices_week_same_day CHECK (period_type <> 'week' OR period_end = period_start);
