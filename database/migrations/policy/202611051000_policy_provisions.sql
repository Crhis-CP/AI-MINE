-- Deterministic structure of one acquired revision (法规线重启设计 §3): the provisions a fixed recipe splits from the
-- revision's own extracted text. No model is involved; a new recipe adds rows beside the old ones and never rewrites them.
CREATE TABLE policy.revision_structures (
  revision_id text NOT NULL REFERENCES policy.document_revisions(id),
  recipe text NOT NULL CHECK (recipe <> ''),
  status text NOT NULL CHECK (status IN ('structured', 'no_provisions', 'needs_manual')),
  numbering text CHECK (numbering IN ('zh', 'es', 'en')),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  provisions_hash text NOT NULL CHECK (provisions_hash ~ '^[a-f0-9]{64}$'),
  provision_count integer NOT NULL CHECK (provision_count >= 0),
  gaps jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (revision_id, recipe),
  CHECK ((status = 'structured') = (provision_count > 0)),
  CHECK ((status = 'structured') = (numbering IS NOT NULL))
);
CREATE TABLE policy.revision_provisions (
  revision_id text NOT NULL,
  recipe text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  provision_key text NOT NULL CHECK (provision_key <> ''),
  label text NOT NULL CHECK (label <> ''),
  path jsonb NOT NULL CHECK (jsonb_typeof(path) = 'array'),
  heading text,
  body text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (revision_id, recipe, ordinal),
  UNIQUE (revision_id, recipe, provision_key),
  FOREIGN KEY (revision_id, recipe) REFERENCES policy.revision_structures(revision_id, recipe)
);
