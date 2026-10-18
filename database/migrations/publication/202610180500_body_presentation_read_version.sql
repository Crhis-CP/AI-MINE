-- Existing public articles may change presentation without changing their semantic revision.
CREATE FUNCTION publication.invalidate_body_presentation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,publication AS $$
DECLARE target text; body_source text; body_lane text;
BEGIN
  IF TG_TABLE_NAME='articles' THEN
    IF (NEW.body_html,NEW.media,NEW.body_status) IS NOT DISTINCT FROM (OLD.body_html,OLD.media,OLD.body_status) THEN RETURN NULL; END IF;
    target:=NEW.id;
  ELSE
    IF (NEW.body_html,NEW.complete,NEW.source_hash,NEW.manifest) IS NOT DISTINCT FROM (OLD.body_html,OLD.complete,OLD.source_hash,OLD.manifest) THEN RETURN NULL; END IF;
    target:=NEW.article_id;
  END IF;
  SELECT source_id INTO body_source FROM public.publications WHERE article_id=target AND visibility='public' AND body_mode='full';
  IF body_source IS NULL THEN RETURN NULL; END IF;
  SELECT lane INTO body_lane FROM public.sources WHERE id=body_source AND site_fulltext;
  IF body_lane='news' THEN
    UPDATE publication.read_watermarks SET version=version+1,withdrawal_version=withdrawal_version+1 WHERE lane='news';
  END IF;
  RETURN NULL;
END;
$$;
