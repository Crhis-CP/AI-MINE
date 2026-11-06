CREATE TRIGGER article_news_links_unread AFTER UPDATE OF body_html ON public.articles
  FOR EACH ROW EXECUTE FUNCTION publication.queue_news_links();
