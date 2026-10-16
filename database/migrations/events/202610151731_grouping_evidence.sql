-- Prior decisions remain readable; absent manifests never become synthetic current evidence.
ALTER TABLE grouping_decisions ADD COLUMN input_revision integer;
ALTER TABLE grouping_decisions ADD COLUMN input_manifest jsonb;
