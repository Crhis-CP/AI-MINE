-- Business line of a source (ADR-0016): material from a policy source is stored like any other, but never enters the news
-- stages (prefilter, scoring, grouping, selection, publication). Set when the source is created; existing sources are news.
ALTER TABLE public.sources
  ADD COLUMN lane text NOT NULL DEFAULT 'news' CHECK (lane IN ('news', 'policy'));
