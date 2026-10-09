-- Keep source figures unchanged; extend the registered sources and enforce the daily calendar shape.
ALTER TABLE publication.metal_prices
  DROP CONSTRAINT metal_prices_series_key_check,
  ADD CONSTRAINT metal_prices_series_key_check CHECK (series_key ~ '^(nbs|wb|imf|cbr)\.[a-z0-9_]+$'),
  DROP CONSTRAINT metal_prices_source_check,
  ADD CONSTRAINT metal_prices_source_check CHECK (source IN ('nbs', 'worldbank', 'imf', 'cbr')),
  DROP CONSTRAINT metal_prices_currency_check,
  ADD CONSTRAINT metal_prices_currency_check CHECK (currency IN ('CNY', 'USD', 'RUB')),
  DROP CONSTRAINT metal_prices_period_type_check,
  ADD CONSTRAINT metal_prices_period_type_check CHECK (period_type IN ('ten_day', 'month', 'day')),
  ADD CONSTRAINT metal_prices_cbr_day_check CHECK ((source = 'cbr') = (period_type = 'day')),
  ADD CONSTRAINT metal_prices_day_check CHECK (period_type <> 'day' OR period_start = period_end);
