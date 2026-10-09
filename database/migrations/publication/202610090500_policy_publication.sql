CREATE TABLE publication.policy_ids (
  kind text NOT NULL, internal_id text NOT NULL, public_id text NOT NULL UNIQUE,
  PRIMARY KEY(kind,internal_id)
);
CREATE TABLE publication.policy_documents (
  id text PRIMARY KEY, withdrawn boolean NOT NULL DEFAULT false,
  publishing_paused boolean NOT NULL DEFAULT false, first_public_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE publication.policy_quality_windows (
  id text PRIMARY KEY, valid_until timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE publication.policy_editions (
  id text PRIMARY KEY, content_hash text NOT NULL, policy_id text NOT NULL REFERENCES publication.policy_documents(id),
  native_expression_id text NOT NULL, native_revision_id text NOT NULL,
  source_id text NOT NULL, permission_version bigint NOT NULL, policy_version_id text NOT NULL,
  source_language text NOT NULL, preferred_source_language text,
  expression_ids text[] NOT NULL, revision_ids text[] NOT NULL,
  public_resources jsonb NOT NULL, basic_card jsonb, basic_detail jsonb,
  complete_card jsonb, complete_detail jsonb, reading jsonb NOT NULL DEFAULT '{}',
  quality_id text REFERENCES publication.policy_quality_windows(id),
  released_at timestamptz NOT NULL DEFAULT now(),
  CHECK((complete_detail IS NULL)=(quality_id IS NULL)),
  UNIQUE(policy_id,native_expression_id,native_revision_id,content_hash)
);
CREATE INDEX policy_editions_document ON publication.policy_editions(policy_id,released_at DESC,id);
