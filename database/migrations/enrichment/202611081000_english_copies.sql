-- English title and summary of a public news item for the English interface (TASK-0595, Owner 2026-11-08).
-- One row per article and exact input (the published Chinese title and summary, the original title and language);
-- a changed input gets a new row, so identical input is never paid for twice. The receipt keeps the paid call.
CREATE TABLE enrichment.english_copies (
  article_id text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  recipe text NOT NULL,
  title_en text NOT NULL CHECK (length(trim(title_en)) > 0),
  summary_en text NOT NULL CHECK (length(trim(summary_en)) > 0),
  title_origin text NOT NULL CHECK (title_origin IN ('source', 'model')),
  input_revision integer NOT NULL CHECK (input_revision > 0),
  receipt_id bigint NOT NULL,
  attempt_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, input_hash)
);
