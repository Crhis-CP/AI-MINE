-- Explicit outbound links of each published news article (TASK-0567), so a policy page finds the reports that link its
-- official URL, and a report page the policies it cites, by index instead of reading every public article body.
-- One row per publication. urls are the body's absolute http(s) <a href> links without fragment, read by the
-- publication code (explicitLinks) from articles.body_html at article_revision. NULL urls: not read yet (rows added
-- below for existing publications, by the insert trigger, or cleared by a body change); readers check those
-- articles' bodies directly until the publication.news-links repair has read them. Readers apply the public state.
CREATE TABLE publication.news_links (
  article_id text PRIMARY KEY REFERENCES public.publications(article_id) ON DELETE CASCADE,
  article_revision integer,
  urls text[],
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((urls IS NULL) = (article_revision IS NULL))
);
CREATE INDEX news_links_urls ON publication.news_links USING gin(urls);
CREATE INDEX news_links_unread ON publication.news_links(article_id) WHERE urls IS NULL;
-- A new publication gets an unread row; a changed body makes its row unread again (trigger in the content migration).
CREATE FUNCTION publication.queue_news_links() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, publication AS $$
BEGIN
  IF TG_TABLE_NAME='publications' THEN
    INSERT INTO publication.news_links(article_id) VALUES (NEW.article_id) ON CONFLICT DO NOTHING;
  ELSE
    IF NEW.body_html IS DISTINCT FROM OLD.body_html THEN
      UPDATE publication.news_links SET article_revision=NULL,urls=NULL,updated_at=pg_catalog.now() WHERE article_id=NEW.id AND urls IS NOT NULL;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER news_links_queue AFTER INSERT ON public.publications
  FOR EACH ROW EXECUTE FUNCTION publication.queue_news_links();
-- Existing publications start unread: no article body is read here; the repair job reads them in small batches.
INSERT INTO publication.news_links(article_id) SELECT article_id FROM public.publications;
-- Policy documents by their official URL in lower case without fragment, for a report page's cited policies; the reader
-- looks up every spelling of a cited link (looseUrlKeys in news-link-index.ts) and compares the exact canonical link afterwards.
CREATE INDEX policy_editions_basic_url ON publication.policy_editions (lower(split_part(basic_card->>'original_url','#',1)));
CREATE INDEX policy_editions_complete_url ON publication.policy_editions (lower(split_part(complete_card->>'original_url','#',1)));
