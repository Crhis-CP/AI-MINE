CREATE TABLE policy.material_discoveries (
  expression_id text NOT NULL REFERENCES policy.expressions(id), material_id text NOT NULL,
  source_id text NOT NULL, material_revision integer NOT NULL CHECK(material_revision>0),
  discovered_at timestamptz NOT NULL, linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(expression_id,material_id,source_id),
  FOREIGN KEY(material_id,material_revision) REFERENCES public.article_revisions(article_id,revision)
);
CREATE TABLE policy.metadata_observations (
  id text PRIMARY KEY, expression_id text NOT NULL REFERENCES policy.expressions(id),
  document_revision_id text NOT NULL REFERENCES policy.document_revisions(id), source_id text NOT NULL,
  material_id text NOT NULL, material_revision integer NOT NULL, permission_version bigint NOT NULL,
  observed_at timestamptz NOT NULL, metadata jsonb NOT NULL,
  FOREIGN KEY(material_id,material_revision) REFERENCES public.article_revisions(article_id,revision),
  FOREIGN KEY(source_id,permission_version) REFERENCES sources.source_policy_versions(source_id,permission_version)
);
CREATE INDEX policy_metadata_expression_observed ON policy.metadata_observations(expression_id,observed_at DESC);
CREATE TABLE policy.material_workflows (
  source_id text NOT NULL, material_id text NOT NULL, material_revision integer NOT NULL,
  profile_hash text, expression_id text REFERENCES policy.expressions(id), document_revision_id text,
  fulltext_run_id text, stage text NOT NULL DEFAULT 'acquire', status text NOT NULL DEFAULT 'pending',
  reason text, next_check_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_id,material_id)
);
CREATE INDEX policy_workflow_due ON policy.material_workflows(next_check_at,source_id,material_id);
