CREATE TABLE publication.manual_copies (
  article_id text PRIMARY KEY REFERENCES articles(id), manual_revision_id bigint,
  material_revision integer NOT NULL, body_html text, label text NOT NULL, state text NOT NULL
);
