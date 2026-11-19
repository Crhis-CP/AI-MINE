-- Package 2 event rules look for an earlier copy of the same text by content_hash on every grouped article. Without
-- this index each probe scans all articles (articles.url already has articles_url_idx from 0030). On a large existing
-- database, build this same index CONCURRENTLY before updating; IF NOT EXISTS makes the transactional migration a
-- no-op there.
CREATE INDEX IF NOT EXISTS articles_content_hash_idx ON articles (content_hash) WHERE content_hash IS NOT NULL;
