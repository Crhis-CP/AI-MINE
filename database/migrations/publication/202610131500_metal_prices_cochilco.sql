-- Add the registered daily source without rewriting prior price observations.
ALTER TABLE publication.metal_prices
  DROP CONSTRAINT metal_prices_series_key_check,
  ADD CONSTRAINT metal_prices_series_key_check CHECK (series_key ~ '^(nbs|wb|imf|cbr|mofcom|cochilco)\.[a-z0-9_]+$'),
  DROP CONSTRAINT metal_prices_source_check,
  ADD CONSTRAINT metal_prices_source_check CHECK (source IN ('nbs', 'worldbank', 'imf', 'cbr', 'mofcom', 'cochilco')),
  DROP CONSTRAINT metal_prices_cbr_day_check,
  ADD CONSTRAINT metal_prices_cbr_day_check CHECK ((source IN ('cbr', 'cochilco')) = (period_type = 'day'));
