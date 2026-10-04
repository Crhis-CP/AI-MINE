-- A source quotation is site display material, separate from the authored public summary.
ALTER TABLE publications ADD COLUMN source_excerpt text DEFAULT NULL;
