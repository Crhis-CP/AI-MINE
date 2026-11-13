-- events/group.ts (base 98d7838c:1215-1240): bound the recent decision scan used by linkRelatedStories.
-- Large databases: prebuild this index CONCURRENTLY and confirm it is valid before the release transaction.
CREATE INDEX IF NOT EXISTS grouping_decisions_created_idx ON public.grouping_decisions (created_at);
