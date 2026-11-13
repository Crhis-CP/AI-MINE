-- The English copy the English interface shows, projected from enrichment.english_copies only while it matches the
-- current published Chinese title and summary (TASK-0595). Both are NULL otherwise: the page shows the Chinese copy.
ALTER TABLE public.publications
  ADD COLUMN title_en text,
  ADD COLUMN summary_en text,
  ADD CONSTRAINT publications_english_copy_pair CHECK ((title_en IS NULL) = (summary_en IS NULL));
