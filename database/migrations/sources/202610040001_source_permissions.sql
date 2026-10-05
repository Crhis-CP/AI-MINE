CREATE SCHEMA IF NOT EXISTS sources;

CREATE TABLE sources.source_policy_versions (
  source_id text NOT NULL REFERENCES public.sources(id),
  permission_version bigint NOT NULL CHECK (permission_version > 0 AND permission_version <= 9007199254740991),
  policy jsonb NOT NULL,
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (source_id, permission_version),
  CHECK ((jsonb_typeof(policy) = 'object'
    AND jsonb_typeof(policy -> 'source_id') = 'string'
    AND policy ->> 'source_id' = source_id
    AND jsonb_typeof(policy -> 'permission_version') = 'number'
    AND (policy ->> 'permission_version')::numeric = permission_version) IS TRUE)
);

CREATE TABLE sources.source_policy_current (
  source_id text PRIMARY KEY,
  permission_version bigint NOT NULL,
  public_policy jsonb NOT NULL,
  FOREIGN KEY (source_id, permission_version) REFERENCES sources.source_policy_versions(source_id, permission_version),
  CHECK ((jsonb_typeof(public_policy) = 'object'
    AND jsonb_typeof(public_policy -> 'source_id') = 'string'
    AND public_policy ->> 'source_id' = source_id
    AND jsonb_typeof(public_policy -> 'permission_version') = 'number'
    AND (public_policy ->> 'permission_version')::numeric = permission_version) IS TRUE)
);
