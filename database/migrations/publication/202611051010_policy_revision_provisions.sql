-- Public projection of deterministic provisions, keyed by the native revision a policy edition already names.
-- Written only while the source allows the original full text in public; every read still re-checks the edition's
-- current eligibility. Comparisons between two revisions are computed on read from these rows, not stored.
CREATE TABLE publication.policy_provision_sets (
  native_revision_id text NOT NULL,
  recipe text NOT NULL CHECK (recipe <> ''),
  numbering text NOT NULL CHECK (numbering IN ('zh', 'es', 'en')),
  provisions_hash text NOT NULL CHECK (provisions_hash ~ '^[a-f0-9]{64}$'),
  provision_count integer NOT NULL CHECK (provision_count > 0),
  projected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (native_revision_id, recipe)
);
CREATE TABLE publication.policy_revision_provisions (
  native_revision_id text NOT NULL,
  recipe text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  provision_key text NOT NULL CHECK (provision_key <> ''),
  label text NOT NULL CHECK (label <> ''),
  path jsonb NOT NULL CHECK (jsonb_typeof(path) = 'array'),
  heading text,
  body text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (native_revision_id, recipe, ordinal),
  UNIQUE (native_revision_id, recipe, provision_key),
  FOREIGN KEY (native_revision_id, recipe) REFERENCES publication.policy_provision_sets(native_revision_id, recipe)
);
