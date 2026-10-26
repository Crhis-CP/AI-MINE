ALTER TABLE public.articles
  ADD COLUMN x_post jsonb,
  ADD COLUMN x_article jsonb,
  ADD CONSTRAINT articles_x_post_object CHECK (x_post IS NULL OR jsonb_typeof(x_post) = 'object'),
  ADD CONSTRAINT articles_x_article_object CHECK (x_article IS NULL OR jsonb_typeof(x_article) = 'object');

ALTER TABLE public.article_revisions
  ADD COLUMN x_post jsonb,
  ADD COLUMN x_article jsonb;
