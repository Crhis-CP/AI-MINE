CREATE SCHEMA IF NOT EXISTS policy;
CREATE TABLE policy.instruments (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'), identity jsonb NOT NULL
);
CREATE TABLE policy.versions (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  instrument_id text NOT NULL REFERENCES policy.instruments(id), version_key text NOT NULL,
  UNIQUE(instrument_id, version_key)
);
CREATE TABLE policy.expressions (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'), version_id text NOT NULL REFERENCES policy.versions(id),
  language text NOT NULL, kind text NOT NULL CHECK (kind IN ('original', 'official_translation')),
  current_revision_id text, UNIQUE(version_id, language, kind)
);
CREATE TABLE policy.document_revisions (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'), expression_id text NOT NULL REFERENCES policy.expressions(id),
  previous_id text, sequence integer NOT NULL CHECK (sequence > 0),
  source_id text NOT NULL REFERENCES public.sources(id), permission_version bigint NOT NULL,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'), manifest jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(), UNIQUE(expression_id, sequence), UNIQUE(expression_id, id),
  FOREIGN KEY (expression_id, previous_id) REFERENCES policy.document_revisions(expression_id, id),
  FOREIGN KEY (source_id, permission_version) REFERENCES sources.source_policy_versions(source_id, permission_version)
);
ALTER TABLE policy.expressions ADD CONSTRAINT expression_revision_belongs_to_expression
  FOREIGN KEY (id, current_revision_id) REFERENCES policy.document_revisions(expression_id, id);
CREATE TABLE policy.original_resources (
  revision_id text NOT NULL REFERENCES policy.document_revisions(id), ordinal integer NOT NULL CHECK (ordinal >= 0),
  metadata jsonb NOT NULL, body bytea, sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(revision_id, ordinal), CHECK ((body IS NULL) = (sha256 IS NULL))
);
