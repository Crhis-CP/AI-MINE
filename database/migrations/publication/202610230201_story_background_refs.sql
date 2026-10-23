CREATE TABLE publication.story_background_refs (
  lane text NOT NULL CHECK (lane='news'),
  story_public_id uuid NOT NULL,
  query_article_id text NOT NULL,
  query_material_revision integer NOT NULL CHECK (query_material_revision>0),
  query_publication_revision integer NOT NULL CHECK (query_publication_revision>0),
  query_source_date_version bigint NOT NULL CHECK (query_source_date_version>=0),
  candidate_article_id text NOT NULL,
  candidate_material_revision integer NOT NULL CHECK (candidate_material_revision>0),
  candidate_publication_revision integer NOT NULL CHECK (candidate_publication_revision>0),
  candidate_source_date_version bigint NOT NULL CHECK (candidate_source_date_version>=0),
  relation text NOT NULL CHECK (relation IN ('SAME_OCCURRENCE','SAME_STORY')),
  PRIMARY KEY (lane,story_public_id,query_article_id,candidate_article_id),
  CHECK (query_article_id<>candidate_article_id)
);
