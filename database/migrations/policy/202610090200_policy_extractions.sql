CREATE TABLE policy.document_extractions (
  revision_id text NOT NULL REFERENCES policy.document_revisions(id),
  recipe text NOT NULL CHECK (recipe <> ''), profile_hash text NOT NULL CHECK (profile_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(revision_id, recipe, profile_hash),
  CHECK (result ->> 'revisionId' = revision_id)
);
