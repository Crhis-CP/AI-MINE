CREATE TRIGGER reports_read_version AFTER INSERT OR UPDATE OR DELETE ON public.reports
  FOR EACH ROW EXECUTE FUNCTION publication.bump_read_version('news');
