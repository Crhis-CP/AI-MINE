-- TASK-0572: add the RMB central parity (国家外汇管理局, daily) as a registered rate source; prior rows are kept as they are.
ALTER TABLE publication.metal_prices
  DROP CONSTRAINT metal_prices_series_key_check,
  ADD CONSTRAINT metal_prices_series_key_check CHECK (series_key ~ '^(nbs|wb|imf|cbr|mofcom|cochilco|safe)\.[a-z0-9_]+$'),
  DROP CONSTRAINT metal_prices_source_check,
  ADD CONSTRAINT metal_prices_source_check CHECK (source IN ('nbs', 'worldbank', 'imf', 'cbr', 'mofcom', 'cochilco', 'safe')),
  DROP CONSTRAINT metal_prices_cbr_day_check,
  ADD CONSTRAINT metal_prices_cbr_day_check CHECK ((source IN ('cbr', 'cochilco', 'safe')) = (period_type = 'day'));
