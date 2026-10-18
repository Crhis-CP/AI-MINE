-- Verified operator dates survive automatic collection and retain their declared precision.
CREATE TABLE content.publication_date_corrections (
  article_id text PRIMARY KEY REFERENCES public.articles(id) ON DELETE CASCADE,
  material_revision integer NOT NULL CHECK(material_revision > 0),
  source_time jsonb,
  evidence text NOT NULL,
  actor text NOT NULL,
  corrected_at timestamptz NOT NULL DEFAULT now()
);
