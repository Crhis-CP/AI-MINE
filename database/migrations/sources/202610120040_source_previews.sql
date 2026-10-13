CREATE SCHEMA IF NOT EXISTS sources;
CREATE TABLE sources.source_config_drafts (
  id bigserial PRIMARY KEY, source_id text NOT NULL REFERENCES sources(id), kind text NOT NULL,
  config jsonb NOT NULL, config_hash text NOT NULL, actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sources.source_previews (
  id bigserial PRIMARY KEY, source_id text NOT NULL REFERENCES sources(id), draft_id bigint REFERENCES sources.source_config_drafts(id),
  config_hash text NOT NULL, permission_version integer NOT NULL, status text NOT NULL DEFAULT 'queued',
  result jsonb, error text, actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE sources.source_config_activations (
  id bigserial PRIMARY KEY, source_id text NOT NULL REFERENCES sources(id), draft_id bigint REFERENCES sources.source_config_drafts(id),
  preview_id bigint NOT NULL REFERENCES sources.source_previews(id), config jsonb NOT NULL, actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
