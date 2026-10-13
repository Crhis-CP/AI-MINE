CREATE TABLE publication.policy_relations (
  source_edition_id text NOT NULL REFERENCES publication.policy_editions(id),
  source_policy_id text NOT NULL REFERENCES publication.policy_documents(id),
  target_edition_id text NOT NULL REFERENCES publication.policy_editions(id),
  target_policy_id text NOT NULL REFERENCES publication.policy_documents(id),
  target_original_key text NOT NULL,
  relation text NOT NULL CHECK(relation IN ('updates','corrects','repeals','implements','related')),
  target_citation text NOT NULL, evidence_ids text[] NOT NULL CHECK(evidence_ids<>'{}'::text[]),
  PRIMARY KEY(source_edition_id,target_policy_id,relation,target_citation),
  CHECK(source_policy_id<>target_policy_id)
);
CREATE TABLE publication.policy_threads (
  id text PRIMARY KEY, anchor_policy_id text NOT NULL UNIQUE REFERENCES publication.policy_documents(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
