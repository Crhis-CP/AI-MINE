ALTER TABLE public.sources ADD COLUMN archived_at timestamptz;
ALTER TABLE public.sources ADD CONSTRAINT source_archive_disabled CHECK (archived_at IS NULL OR NOT enabled);
CREATE FUNCTION sources.retain_archive_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    RAISE EXCEPTION 'Source archive is terminal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_archive_is_terminal BEFORE UPDATE ON public.sources
FOR EACH ROW EXECUTE FUNCTION sources.retain_archive_state();
