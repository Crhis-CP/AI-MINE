CREATE TABLE publication.read_watermarks (
  lane text PRIMARY KEY CHECK(lane IN ('news','policy')),
  version bigint NOT NULL DEFAULT 0,
  withdrawal_version bigint NOT NULL DEFAULT 0,
  last_public_at timestamptz,
  last_scheduled_check_ok_at timestamptz
);
INSERT INTO publication.read_watermarks(lane) VALUES ('news'),('policy');
-- Watermarks change inside the transaction that changes reader-visible data.
CREATE FUNCTION publication.bump_read_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, publication AS $$
DECLARE line text := TG_ARGV[0];
BEGIN
  IF TG_OP='UPDATE' AND (pg_catalog.to_jsonb(NEW)-'updated_at') IS NOT DISTINCT FROM (pg_catalog.to_jsonb(OLD)-'updated_at') THEN RETURN NULL; END IF;
  UPDATE publication.read_watermarks SET version=version+1,
    withdrawal_version=withdrawal_version + CASE WHEN TG_OP='INSERT' THEN 0 ELSE 1 END
    WHERE lane=line;
  RETURN NULL;
END;
$$;
CREATE TRIGGER publication_read_version AFTER INSERT OR UPDATE OR DELETE ON public.publications
  FOR EACH ROW EXECUTE FUNCTION publication.bump_read_version('news');
CREATE TRIGGER policy_read_version AFTER INSERT OR UPDATE OR DELETE ON publication.policy_documents
  FOR EACH ROW EXECUTE FUNCTION publication.bump_read_version('policy');
CREATE TRIGGER policy_edition_read_version AFTER INSERT OR UPDATE OR DELETE ON publication.policy_editions
  FOR EACH ROW EXECUTE FUNCTION publication.bump_read_version('policy');
CREATE FUNCTION publication.record_news_public_time() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, publication AS $$
BEGIN
  IF NEW.visibility='public' AND NEW.eligible AND (NOT NEW.selected OR NEW.visible_after<=pg_catalog.now()) THEN
    UPDATE publication.read_watermarks SET last_public_at=pg_catalog.now() WHERE lane='news';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER news_public_time AFTER INSERT OR UPDATE ON public.publications
  FOR EACH ROW EXECUTE FUNCTION publication.record_news_public_time();
CREATE FUNCTION publication.record_policy_public_time() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, publication AS $$
BEGIN
  UPDATE publication.read_watermarks SET last_public_at=NEW.released_at WHERE lane='policy';
  RETURN NULL;
END;
$$;
CREATE TRIGGER policy_public_time AFTER INSERT ON publication.policy_editions
  FOR EACH ROW EXECUTE FUNCTION publication.record_policy_public_time();
