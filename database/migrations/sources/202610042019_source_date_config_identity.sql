-- No timestamp/whole-row identity: only the date profile and parser recipe set this digest.
ALTER TABLE public.sources
  ADD COLUMN source_date_config_hash text
    CHECK (source_date_config_hash ~ '^[a-f0-9]{64}$');
