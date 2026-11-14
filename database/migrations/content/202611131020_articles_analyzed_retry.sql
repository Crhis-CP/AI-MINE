-- jobs/content.ts (base 98d7838c:762-765): index due body rereads while leaving other processing states out.
-- Large databases: prebuild this index CONCURRENTLY and confirm it is valid before the release transaction.
CREATE INDEX IF NOT EXISTS articles_analyzed_retry_idx ON public.articles (processing_retry_at, id) WHERE processing_state = 'analyzed' AND processing_error IS NOT NULL;
