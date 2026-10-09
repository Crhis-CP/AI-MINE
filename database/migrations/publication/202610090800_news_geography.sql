CREATE TABLE publication.news_geography (
  article_id text PRIMARY KEY REFERENCES public.articles(id), article_revision integer NOT NULL,
  analysis_id bigint, recipe text NOT NULL, state text NOT NULL CHECK(state IN ('identified','partial','none','unknown')),
  jurisdictions text[] NOT NULL DEFAULT '{}', primary_jurisdiction text, updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((state IN ('none','unknown')) = (jurisdictions='{}'::text[]))
);
CREATE INDEX news_geography_codes ON publication.news_geography USING gin(jurisdictions);
