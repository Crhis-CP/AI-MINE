CREATE TRIGGER article_presentation_read_version AFTER UPDATE OF body_html,media,body_status ON public.articles
  FOR EACH ROW EXECUTE FUNCTION publication.invalidate_body_presentation();
