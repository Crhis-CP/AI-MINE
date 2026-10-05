CREATE SCHEMA IF NOT EXISTS content;

CREATE TABLE content.source_date_observations (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  article_id text NOT NULL REFERENCES public.articles(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES public.sources(id),
  revision integer NOT NULL CHECK (revision > 0),
  config_hash text NOT NULL CHECK (config_hash ~ '^[a-f0-9]{64}$'),
  permission_version bigint NOT NULL CHECK (permission_version > 0 AND permission_version <= 9007199254740991),
  observation_id text NOT NULL CHECK (observation_id <> ''),
  observed_at timestamptz NOT NULL,
  observation jsonb NOT NULL,
  result jsonb NOT NULL,
  semantic_hash text NOT NULL CHECK (semantic_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_id, permission_version)
    REFERENCES sources.source_policy_versions(source_id, permission_version)
);
CREATE INDEX source_date_observations_article_idx
  ON content.source_date_observations(article_id, revision, observed_at DESC);

ALTER TABLE public.articles
  ADD COLUMN source_date_version bigint NOT NULL DEFAULT 0 CHECK (source_date_version >= 0),
  ADD COLUMN source_date_observation_id text REFERENCES content.source_date_observations(id),
  ADD COLUMN source_date_state text NOT NULL DEFAULT 'pending' CHECK (source_date_state IN ('pending', 'reliable')),
  ADD COLUMN source_date_attempts integer NOT NULL DEFAULT 0 CHECK (source_date_attempts >= 0),
  ADD COLUMN source_date_retry_at timestamptz,
  ADD COLUMN source_date_error text;
