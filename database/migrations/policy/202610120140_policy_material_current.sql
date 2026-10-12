ALTER TABLE policy.material_discoveries ADD COLUMN is_current boolean NOT NULL DEFAULT true;
UPDATE policy.material_discoveries d SET is_current=false
WHERE EXISTS (
  SELECT 1 FROM (
    SELECT DISTINCT ON (source_id,material_id) source_id,material_id,expression_id
    FROM policy.metadata_observations ORDER BY source_id,material_id,observed_at DESC,id DESC
  ) latest
  WHERE latest.source_id=d.source_id AND latest.material_id=d.material_id AND latest.expression_id<>d.expression_id
);
