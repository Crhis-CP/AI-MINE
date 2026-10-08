CREATE TABLE content.source_date_observation_seen (
  article_id text NOT NULL REFERENCES public.articles(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  config_hash text NOT NULL CHECK (config_hash ~ '^[a-f0-9]{64}$'),
  last_observed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, revision, config_hash)
);
