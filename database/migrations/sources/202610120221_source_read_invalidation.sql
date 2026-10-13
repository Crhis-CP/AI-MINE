CREATE TRIGGER source_public_read_invalidation AFTER UPDATE OF participation_mode,site_fulltext,syndicate_fulltext ON public.sources
  FOR EACH ROW EXECUTE FUNCTION publication.invalidate_source_readers();
CREATE TRIGGER source_policy_read_invalidation AFTER INSERT OR UPDATE ON sources.source_policy_current
  FOR EACH ROW EXECUTE FUNCTION publication.invalidate_source_readers();
