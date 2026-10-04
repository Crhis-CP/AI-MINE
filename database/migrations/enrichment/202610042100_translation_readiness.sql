CREATE SCHEMA IF NOT EXISTS enrichment;

CREATE TABLE enrichment.translation_segments (
  article_id       text NOT NULL REFERENCES public.articles(id) ON DELETE CASCADE,
  revision         integer NOT NULL CHECK (revision > 0),
  recipe           text NOT NULL CHECK (recipe <> ''),
  source_hash      text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  segment_index    integer NOT NULL CHECK (segment_index >= 0),
  segment_hash     text NOT NULL CHECK (segment_hash ~ '^[a-f0-9]{64}$'),
  state            text NOT NULL CHECK (state IN ('complete', 'failed', 'unknown')),
  failed_attempts  integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  receipt_id       bigint REFERENCES public.receipts(id),
  response_text    text,
  response_hash    text CHECK (response_hash ~ '^[a-f0-9]{64}$'),
  restored_html    text,
  restored_hash    text CHECK (restored_hash ~ '^[a-f0-9]{64}$'),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, revision, recipe, source_hash, segment_index),
  CHECK (state <> 'complete' OR
    (receipt_id IS NOT NULL AND response_text IS NOT NULL AND response_hash IS NOT NULL
     AND restored_html IS NOT NULL AND restored_hash IS NOT NULL))
);

-- Existing unverified translations keep null identity; this migration does not manufacture proof.
ALTER TABLE public.translations
  ADD COLUMN recipe text,
  ADD COLUMN source_hash text CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN manifest jsonb;
