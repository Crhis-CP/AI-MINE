CREATE TABLE enrichment.quote_translations (
  source_id text NOT NULL,
  quote_url text NOT NULL,
  text_hash text NOT NULL CHECK (text_hash ~ '^[a-f0-9]{64}$'),
  recipe text NOT NULL,
  text_zh text NOT NULL CHECK (length(trim(text_zh)) > 0),
  input_article_id text NOT NULL,
  input_revision integer NOT NULL CHECK (input_revision > 0),
  receipt_id bigint NOT NULL,
  attempt_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, quote_url, text_hash, recipe)
);
