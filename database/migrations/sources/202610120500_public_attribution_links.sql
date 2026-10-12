-- Repair current public projections only; private authorizations, evidence prose and reviewers never leave sources.
WITH evidence_links AS (
  SELECT c.source_id,c.permission_version,e.value->>'kind' AS kind,e.value->>'url' AS url
  FROM sources.source_policy_current c JOIN sources.source_policy_versions v
    ON v.source_id=c.source_id AND v.permission_version=c.permission_version
  CROSS JOIN LATERAL jsonb_array_elements(v.policy->'evidence') e(value)
  WHERE e.value->>'kind' IN ('open_license','official_policy','robots_terms')
    AND e.value->>'url' ~* '^https?://[^/?#[:space:]@\\]+([/?#][^[:space:]\\]*)?$'
), chosen AS (
  SELECT c.source_id,
    CASE WHEN count(DISTINCT e.url) FILTER(WHERE e.kind='open_license')=1
      THEN min(e.url) FILTER(WHERE e.kind='open_license') END AS licence_url,
    CASE WHEN count(DISTINCT e.url) FILTER(WHERE e.kind='official_policy')>0
      THEN CASE WHEN count(DISTINCT e.url) FILTER(WHERE e.kind='official_policy')=1
        THEN min(e.url) FILTER(WHERE e.kind='official_policy') END
      ELSE CASE WHEN count(DISTINCT e.url) FILTER(WHERE e.kind='robots_terms')=1
        THEN min(e.url) FILTER(WHERE e.kind='robots_terms') END END AS legal_url
  FROM sources.source_policy_current c LEFT JOIN evidence_links e
    ON e.source_id=c.source_id AND e.permission_version=c.permission_version
  GROUP BY c.source_id
)
UPDATE sources.source_policy_current c
SET public_policy=c.public_policy||jsonb_build_object('licence_url',chosen.licence_url,'legal_url',chosen.legal_url)
FROM chosen WHERE c.source_id=chosen.source_id AND (
  c.public_policy->'licence_url' IS DISTINCT FROM coalesce(to_jsonb(chosen.licence_url),'null'::jsonb)
  OR c.public_policy->'legal_url' IS DISTINCT FROM coalesce(to_jsonb(chosen.legal_url),'null'::jsonb)
);
