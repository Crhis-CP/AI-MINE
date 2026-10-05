-- Existing projections receive no fabricated date proof. Read gating is activated with its consumers.
ALTER TABLE public.publications
  ADD COLUMN source_time jsonb,
  ADD COLUMN source_date_version bigint CHECK (source_date_version >= 0),
  ADD COLUMN source_date_config_hash text CHECK (source_date_config_hash ~ '^[a-f0-9]{64}$');
