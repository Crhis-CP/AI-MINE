CREATE TRIGGER translation_presentation_read_version AFTER UPDATE OF body_html,complete,source_hash,manifest ON public.translations
  FOR EACH ROW EXECUTE FUNCTION publication.invalidate_body_presentation();
