-- TASK-0578: public projections saved before the processing grant was projected (2026-10-13) lack "processing", so
-- readers' permission view denied every report of those sources while the private policy allowed it. Add exactly what
-- the current policy version projects (permission-store.ts publicProjection); versions and private evidence stay put.
UPDATE sources.source_policy_current c
SET public_policy=c.public_policy||jsonb_build_object('processing',jsonb_build_object(
  'decision',coalesce(v.policy->'permissions'->'process_locally','"unknown"'::jsonb),
  'grants',coalesce((
    SELECT jsonb_agg(jsonb_build_object('scope',e.value->'scope','expires_at',e.value->'valid_until') ORDER BY e.ordinality)
    FROM jsonb_array_elements(v.policy->'evidence') WITH ORDINALITY AS e(value,ordinality)
    WHERE e.value->'capabilities' @> '["process_locally"]'::jsonb
      AND e.value->>'kind' NOT IN ('source_objection','owner_instruction','legal_requirement')
  ),'[]'::jsonb)))
FROM sources.source_policy_versions v
WHERE v.source_id=c.source_id AND v.permission_version=c.permission_version AND c.public_policy->'processing' IS NULL;
