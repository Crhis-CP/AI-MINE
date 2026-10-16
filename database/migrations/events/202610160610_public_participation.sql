-- Worker-qualified, non-secret evidence for public counts and comparable heat charts.
-- Missing legacy proof is unknown, never confirmed by migration.
ALTER TABLE story_signals ADD COLUMN qualified_at timestamptz;
ALTER TABLE story_signals ADD COLUMN qualified_fact_id bigint;
ALTER TABLE story_signals ADD COLUMN material_revision integer;
ALTER TABLE story_signals ADD COLUMN source_date_version bigint;
ALTER TABLE story_signals ADD COLUMN publication_revision integer;
ALTER TABLE story_signals ADD COLUMN source_since timestamptz;
CREATE INDEX story_signals_qualified_time_idx ON story_signals (story_id,observed_at) WHERE qualified_at IS NOT NULL;

CREATE TRIGGER hot_ranking_read_version AFTER INSERT ON public.hot_rankings
  FOR EACH ROW EXECUTE FUNCTION publication.bump_read_version('news');
ALTER TABLE story_signals ADD CONSTRAINT story_signals_complete_public_proof CHECK (
  qualified_at IS NULL OR (material_revision IS NOT NULL AND material_revision>0 AND source_date_version IS NOT NULL AND source_date_version>=0 AND source_since IS NOT NULL
    AND (kind='signal' OR (qualified_fact_id IS NOT NULL AND publication_revision IS NOT NULL)))
);
