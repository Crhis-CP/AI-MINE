ALTER TABLE public.publications
  ADD COLUMN is_original_post boolean NOT NULL DEFAULT false,
  ADD COLUMN x_post jsonb,
  ADD COLUMN x_post_revision integer,
  ADD CONSTRAINT publications_x_post_object CHECK (x_post IS NULL OR jsonb_typeof(x_post) = 'object'),
  ADD CONSTRAINT publications_x_post_revision CHECK (x_post_revision IS NULL OR x_post_revision > 0);
