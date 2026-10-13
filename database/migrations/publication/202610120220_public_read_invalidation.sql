-- A source participation or publication permission change invalidates already open reader pages.
CREATE FUNCTION publication.invalidate_source_readers() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,publication AS $$
DECLARE line text;
BEGIN
  IF TG_TABLE_NAME='sources' THEN
    IF (NEW.participation_mode,NEW.site_fulltext,NEW.syndicate_fulltext) IS NOT DISTINCT FROM (OLD.participation_mode,OLD.site_fulltext,OLD.syndicate_fulltext) THEN RETURN NULL; END IF;
    line:=NEW.lane;
  ELSE SELECT lane INTO line FROM public.sources WHERE id=NEW.source_id;
  END IF;
  UPDATE publication.read_watermarks SET version=version+1,withdrawal_version=withdrawal_version+1 WHERE lane=line;
  RETURN NULL;
END;
$$;
