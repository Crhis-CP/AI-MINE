-- Package 2 measurements, part M: which reports are the same event, new against old news, and what leads.
-- Read-only: every statement is a single SELECT (or WITH ... SELECT); tests/measure-sql.test.ts holds every file to
-- that and runs each statement inside a READ ONLY transaction on a migrated test database. How to run it on
-- production and what to send back: docs/runbooks/package2-measurements.md. Output is counts, distributions and
-- identifiers only; no statement returns article text. Days are Beijing days.

-- [M1a] Grouping decisions per day and verdict over the last 30 days.
-- Measures: how many articles the grouping step decided each day, how many of those decisions came with a paid model
--   receipt, and how many had no candidate at all.
-- Decides: the cost baseline the event shadow's would_call is compared with (rules may only remove model calls).
-- Columns: measure, day, verdict, decisions, with_model_receipt, without_candidates
SELECT 'M1a' AS measure,
  (d.created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
  d.verdict,
  count(*)::int AS decisions,
  count(*) FILTER (WHERE d.receipt_id IS NOT NULL)::int AS with_model_receipt,
  count(*) FILTER (WHERE CASE WHEN jsonb_typeof(d.candidates) = 'array' THEN jsonb_array_length(d.candidates) ELSE 0 END = 0)::int
    AS without_candidates
FROM grouping_decisions d
WHERE d.created_at >= now() - interval '30 days'
GROUP BY 2, 3
ORDER BY 2 DESC, 4 DESC, 3;

-- [M1b] Grouping model receipts per day, purpose and status over the last 30 days.
-- Measures: the paid grouping calls themselves (group_article, group_review, group_signal, group_story ...), with cost.
-- Decides: the same cost baseline as M1a, counted at the receipt instead of the decision (a decision can reuse a receipt).
-- Columns: measure, day, purpose, status, receipts, cost, currencies
SELECT 'M1b' AS measure,
  (r.created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
  r.purpose,
  r.status,
  count(*)::int AS receipts,
  round(sum(r.cost), 4) AS cost,
  string_agg(DISTINCT r.currency, ',') AS currencies
FROM receipts r
WHERE r.purpose LIKE 'group%' AND r.created_at >= now() - interval '30 days'
GROUP BY 2, 3, 4
ORDER BY 2 DESC, 3, 4;

-- [M2a] The 14-day recall pool: its size and how much of it has a stored vector for the text it is compared by.
-- Measures: the reports live recall returns (events/group.ts recallPool and qualifiedReports): a primary or report
--   member of a fact in a live story, discovered in the last 14 days, not taken down (withdrawn, removed by an operator,
--   or an original post still waiting for admission, with that admission switch off as in production) and not a
--   composite report; unless tied by hand, also not waiting for a regroup, tied to the article's current revision and
--   with grouping confirmed for it. Counted per stored vector model and dimension; a row with no model is a report with
--   no vector.
--   The live pool embeds the public title and summary, an arriving report is embedded from its analysis title and
--   summary; both hashes are recomputed here the way the worker computes them (title, a full stop, the first 300
--   characters of the summary, SHA-256), so hash_is_pool_text and hash_is_query_text say which text a stored vector
--   belongs to. Astral characters in a summary can shift the 300-character cut by one; that is noise here.
-- Decides: the size of the event shadow's vector cache (24 MB is planned) and whether it may reuse stored vectors or must
--   prefilter before loading them; whether pool and query texts differ often enough to need two vectors per report.
-- Columns: measure, model, dims, pool_reports, hash_is_pool_text, hash_is_query_text, pool_text_differs_from_query_text
WITH pool AS (
  SELECT DISTINCT fa.article_id
  FROM fact_articles fa
  JOIN facts f ON f.id = fa.fact_id
  JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
  JOIN articles a ON a.id = fa.article_id
  LEFT JOIN publications p ON p.article_id = fa.article_id
  WHERE fa.role IN ('primary', 'report') AND a.discovered_at > now() - interval '14 days'
    AND (fa.manual OR (NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id = fa.article_id)
      AND fa.input_revision = a.revision AND a.grouping_status = 'complete' AND a.grouping_input_revision = a.revision))
    AND NOT coalesce(p.visibility = 'withdrawn' OR p.operator_withdrawn
      OR (p.is_original_post AND p.original_post_admission_required IS DISTINCT FROM false), false)
    AND (SELECT x.output->>'scope' FROM analyses x WHERE x.article_id = fa.article_id ORDER BY x.input_revision DESC, x.id DESC LIMIT 1)
      IS DISTINCT FROM 'composite'
), texts AS (
  SELECT pool.article_id,
    encode(sha256(convert_to(coalesce(p.title, an.title_zh, a.title) || '。' || left(coalesce(p.summary, an.summary_zh, ''), 300), 'UTF8')), 'hex')
      AS pool_hash,
    encode(sha256(convert_to(coalesce(nullif(an.title_zh, ''), a.title) || '。' || left(coalesce(an.summary_zh, ''), 300), 'UTF8')), 'hex')
      AS query_hash
  FROM pool
  JOIN articles a ON a.id = pool.article_id
  LEFT JOIN publications p ON p.article_id = pool.article_id
  LEFT JOIN LATERAL (
    SELECT x.title_zh, x.summary_zh FROM analyses x WHERE x.article_id = pool.article_id ORDER BY x.input_revision DESC, x.id DESC LIMIT 1
  ) an ON true
)
SELECT 'M2a' AS measure,
  e.model,
  array_length(e.vector, 1) AS dims,
  count(*)::int AS pool_reports,
  count(*) FILTER (WHERE e.text_hash = t.pool_hash)::int AS hash_is_pool_text,
  count(*) FILTER (WHERE e.text_hash = t.query_hash)::int AS hash_is_query_text,
  count(*) FILTER (WHERE t.pool_hash <> t.query_hash)::int AS pool_text_differs_from_query_text
FROM texts t
LEFT JOIN embeddings e ON e.kind = 'article' AND e.ref_id = t.article_id
GROUP BY 2, 3
ORDER BY 4 DESC, 2;

-- [M2b] Every stored vector by kind and model.
-- Measures: how many vectors exist, how many were written in the last 14 days and how much space they take; the
--   dimension is read from one vector per kind and model so the vectors themselves are not loaded.
-- Decides: the worker memory budget next to the legacy 30,000-entry cache, and which model the shadow reads.
-- Columns: measure, kind, model, dims, vectors, written_14d, stored_size
SELECT 'M2b' AS measure,
  e.kind,
  e.model,
  (SELECT array_length(x.vector, 1) FROM embeddings x WHERE x.kind = e.kind AND x.model = e.model LIMIT 1) AS dims,
  count(*)::int AS vectors,
  count(*) FILTER (WHERE e.created_at >= now() - interval '14 days')::int AS written_14d,
  pg_size_pretty(sum(pg_column_size(e.vector))) AS stored_size
FROM embeddings e
GROUP BY 2, 3
ORDER BY 5 DESC, 2, 3;

-- [M2c] Paid embedding requests ever made, by service, model and status.
-- Measures: every receipt of an embedding request (providers/embeddings.ts: purpose 'embedding', service 'embedding' with
--   its own key or 'dashscope'), all time; read through the service index, so only those two services' receipts are
--   looked at.
-- Decides: whether live grouping ever ran with vectors (expected: no rows, as M2b), before anyone takes switching
--   embeddings on (EMBEDDINGS_ENABLED=true, an Owner decision under DEC-29) to the Owner.
-- Columns: measure, service, model, status, receipts, first_at, last_at
SELECT 'M2c' AS measure,
  r.service,
  r.model,
  r.status,
  count(*)::int AS receipts,
  min(r.created_at) AS first_at,
  max(r.created_at) AS last_at
FROM receipts r
WHERE r.service IN ('embedding', 'dashscope') AND r.purpose = 'embedding'
GROUP BY 2, 3, 4
ORDER BY 2, 3, 4;

-- [M3a] Recall similarity of judged candidates by the judge's relation, last 60 days.
-- Measures: the similarity score recorded with every candidate the model judged, banded, against the relation the
--   model returned (SAME_OCCURRENCE, SAME_STORY, UNRELATED, ROUNDUP; none when the candidate was not judged). A same-URL
--   candidate is recorded with score 1. While embeddings are off (production so far: M2b returned no rows) the
--   score is the character-pair overlap (events/relate.ts lexicalSimilarity: shared character bigrams over the smaller
--   set, so a short text inside a long one scores 1), not a cosine; the bands keep the cosine bars' edges only so the
--   two kinds can be set side by side.
-- Decides: how the live engine's bars act on the character-pair overlap it actually compares: 0.85 (confirm a merge,
--   CONFIRM_BELOW_COSINE applied to the overlap) and 0.92 (skip the review), above the lexical recall floor 0.25. It
--   says nothing about cosine bars until vectors exist.
-- Columns: measure, relation, score_band, candidates, mean_confidence
SELECT 'M3a' AS measure,
  coalesce(c.value->>'relation', 'none') AS relation,
  CASE
    WHEN (c.value->>'score')::float8 >= 0.92 THEN 'f >=0.92'
    WHEN (c.value->>'score')::float8 >= 0.85 THEN 'e 0.85-0.92'
    WHEN (c.value->>'score')::float8 >= 0.80 THEN 'd 0.80-0.85'
    WHEN (c.value->>'score')::float8 >= 0.70 THEN 'c 0.70-0.80'
    WHEN (c.value->>'score')::float8 >= 0.60 THEN 'b 0.60-0.70'
    WHEN (c.value->>'score')::float8 >= 0 THEN 'a <0.60'
    ELSE 'unknown'
  END AS score_band,
  count(*)::int AS candidates,
  round(avg((c.value->>'confidence')::numeric), 3) AS mean_confidence
FROM grouping_decisions d
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.candidates) = 'array' THEN d.candidates ELSE '[]'::jsonb END) c
WHERE d.created_at >= now() - interval '60 days'
GROUP BY 2, 3
ORDER BY 2, 3;

-- [M3b] Cosine between reports that today share a fact, in the 14-day pool.
-- Measures: every pair of current members of one fact (both in the recall pool of M2a, both with a vector of the same
--   model), banded by cosine, split by whether both came from the same source. The cosine is computed here from
--   the stored vectors; nothing is embedded.
-- Decides: together with M3a, the 0.92 / 0.85 / 0.6 bars: how many live same-fact pairs each bar would keep.
-- Columns: measure, same_source, cosine_band, pairs
WITH members AS (
  SELECT fa.fact_id, fa.article_id, a.source_id
  FROM fact_articles fa
  JOIN facts f ON f.id = fa.fact_id
  JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
  JOIN articles a ON a.id = fa.article_id
  LEFT JOIN publications p ON p.article_id = fa.article_id
  WHERE fa.role IN ('primary', 'report') AND a.discovered_at > now() - interval '14 days'
    AND (fa.manual OR (NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id = fa.article_id)
      AND fa.input_revision = a.revision AND a.grouping_status = 'complete' AND a.grouping_input_revision = a.revision))
    AND NOT coalesce(p.visibility = 'withdrawn' OR p.operator_withdrawn
      OR (p.is_original_post AND p.original_post_admission_required IS DISTINCT FROM false), false)
    AND (SELECT x.output->>'scope' FROM analyses x WHERE x.article_id = fa.article_id ORDER BY x.input_revision DESC, x.id DESC LIMIT 1)
      IS DISTINCT FROM 'composite'
), pairs AS (
  SELECT x.source_id = y.source_id AS same_source,
    (SELECT sum(u::float8 * v::float8) / nullif(sqrt(sum(u::float8 * u::float8)) * sqrt(sum(v::float8 * v::float8)), 0)
     FROM unnest(ex.vector, ey.vector) AS t(u, v)) AS cosine
  FROM members x
  JOIN members y ON y.fact_id = x.fact_id AND y.article_id > x.article_id
  JOIN embeddings ex ON ex.kind = 'article' AND ex.ref_id = x.article_id
  JOIN embeddings ey ON ey.kind = 'article' AND ey.ref_id = y.article_id AND ey.model = ex.model
)
SELECT 'M3b' AS measure,
  same_source,
  CASE
    WHEN cosine >= 0.92 THEN 'f >=0.92'
    WHEN cosine >= 0.85 THEN 'e 0.85-0.92'
    WHEN cosine >= 0.80 THEN 'd 0.80-0.85'
    WHEN cosine >= 0.70 THEN 'c 0.70-0.80'
    WHEN cosine >= 0.60 THEN 'b 0.60-0.70'
    WHEN cosine IS NOT NULL THEN 'a <0.60'
    ELSE 'unknown'
  END AS cosine_band,
  count(*)::int AS pairs
FROM pairs
GROUP BY 2, 3
ORDER BY 2, 3;

-- [M4a] Exact copies: articles with the same content hash, where the newest copy arrived in the last 90 days.
-- Measures: groups of articles whose title, body and excerpt hash alike, split into copies across sources and copies
--   from one source under a different address (re-collection), by the time between the first and the last copy and by
--   the smallest body in the group (a hash over an empty body ties unrelated title-only items).
-- Decides: how often defect 4 (an old article re-collected under a new address shows as new) is an exact copy, and the
--   48-hour re-collection window of the freshness rules.
-- Columns: measure, kind, gap_band, body, groups, articles
WITH twins AS (
  SELECT content_hash
  FROM articles
  WHERE content_hash IS NOT NULL
  GROUP BY content_hash
  HAVING count(*) > 1 AND max(discovered_at) >= now() - interval '90 days'
), groups AS (
  SELECT a.content_hash,
    count(*) AS n,
    count(DISTINCT a.source_id) AS sources,
    count(DISTINCT a.url) AS urls,
    max(a.discovered_at) - min(a.discovered_at) AS gap,
    min(octet_length(coalesce(a.body_text, ''))) AS smallest_body
  FROM articles a
  JOIN twins t ON t.content_hash = a.content_hash
  GROUP BY a.content_hash
)
SELECT 'M4a' AS measure,
  CASE WHEN sources > 1 THEN 'cross_source' WHEN urls > 1 THEN 'same_source_new_url' ELSE 'same_source_same_url' END AS kind,
  CASE
    WHEN gap < interval '1 hour' THEN 'a <1h'
    WHEN gap < interval '48 hours' THEN 'b 1-48h'
    WHEN gap < interval '14 days' THEN 'c 2-14d'
    WHEN gap < interval '90 days' THEN 'd 14-90d'
    ELSE 'e >=90d'
  END AS gap_band,
  CASE WHEN smallest_body = 0 THEN 'no_body' WHEN smallest_body < 500 THEN 'body_under_500B' ELSE 'body_500B_plus' END AS body,
  count(*)::int AS groups,
  sum(n)::int AS articles
FROM groups
GROUP BY 2, 3, 4
ORDER BY 2, 3, 4;

-- [M4b] Near copies an exact hash misses: one source, the same title, a different address and a different hash.
-- Measures: groups of articles discovered in the last 90 days from one source with an equal title (case and outer
--   spaces folded, at least 12 characters) under more than one address and more than one content hash, by the time
--   between the first and the last copy. Recurring column titles land here too; the gap band separates them.
-- Decides: how much of defect 4 needs a near-duplicate fingerprint rather than the exact hash.
-- Columns: measure, gap_band, groups, articles
WITH groups AS (
  SELECT count(*) AS n, max(discovered_at) - min(discovered_at) AS gap
  FROM articles
  WHERE discovered_at >= now() - interval '90 days' AND length(btrim(coalesce(title, ''))) >= 12
  GROUP BY source_id, lower(btrim(title))
  HAVING count(DISTINCT url) > 1 AND count(DISTINCT content_hash) > 1
)
SELECT 'M4b' AS measure,
  CASE
    WHEN gap < interval '1 hour' THEN 'a <1h'
    WHEN gap < interval '48 hours' THEN 'b 1-48h'
    WHEN gap < interval '14 days' THEN 'c 2-14d'
    ELSE 'd >=14d'
  END AS gap_band,
  count(*)::int AS groups,
  sum(n)::int AS articles
FROM groups
GROUP BY 2
ORDER BY 2;

-- [M4c] One address collected from more than one source.
-- Measures: addresses held by articles of two or more sources, by the time between the first and the last arrival.
-- Decides: how often the same-URL shortcut of grouping joins reports across sources.
-- Columns: measure, gap_band, urls, articles
WITH shared AS (
  SELECT count(*) AS n, max(discovered_at) - min(discovered_at) AS gap
  FROM articles
  WHERE url IS NOT NULL
  GROUP BY url
  HAVING count(DISTINCT source_id) > 1
)
SELECT 'M4c' AS measure,
  CASE
    WHEN gap < interval '1 hour' THEN 'a <1h'
    WHEN gap < interval '48 hours' THEN 'b 1-48h'
    WHEN gap < interval '14 days' THEN 'c 2-14d'
    ELSE 'd >=14d'
  END AS gap_band,
  count(*)::int AS urls,
  sum(n)::int AS articles
FROM shared
GROUP BY 2
ORDER BY 2;

-- [M5a] The model's occurrence date (fact.occurredAt) on passed articles analysed in the last 60 days, by category.
-- Measures: how many passed judgements carry a date claim, how many claims are not a valid YYYY-MM-DD, how many name a
--   day the source text also writes (searched in the title, excerpt and the first 20,000 characters of the body, in
--   ISO, Chinese, English, Spanish, Portuguese and numeric day-month forms; an approximation of the dateInText check
--   that lands with the timing rules), and how many fall on the last day of a month or of a quarter (period ends:
--   "quarter ended 30 September" is a period, not an occurrence).
-- Decides: whether a single date claim may ever make a report old on its own (revisit if found_in_text is under half
--   of the valid claims), and whether results-type categories need a period-end exception.
-- Columns: measure, category, passed, with_claim, malformed, found_in_text, month_end, quarter_end
WITH latest AS (
  SELECT DISTINCT ON (an.article_id) an.article_id, an.relevance, an.category, an.output->'fact'->>'occurredAt' AS claim
  FROM analyses an
  WHERE an.created_at >= now() - interval '60 days'
  ORDER BY an.article_id, an.input_revision DESC, an.id DESC
), dated AS (
  SELECT l.article_id, coalesce(l.category, '?') AS category, l.claim,
    CASE WHEN l.claim ~ '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' THEN
      CASE WHEN substr(l.claim, 9, 2)::int
          <= extract(day FROM make_date(substr(l.claim, 1, 4)::int, substr(l.claim, 6, 2)::int, 1) + interval '1 month' - interval '1 day')
        THEN make_date(substr(l.claim, 1, 4)::int, substr(l.claim, 6, 2)::int, substr(l.claim, 9, 2)::int)
      END
    END AS occurred_on
  FROM latest l
  WHERE l.relevance = 'pass'
), checked AS (
  SELECT d.*,
    d.occurred_on IS NOT NULL AND (coalesce(a.title, '') || ' ' || coalesce(a.excerpt, '') || ' ' || substr(coalesce(a.body_text, ''), 1, 20000)) ~* (
      '(^|[^0-9])(' || to_char(d.occurred_on, 'YYYY-MM-DD')
      || '|' || to_char(d.occurred_on, 'FMMM') || '月' || to_char(d.occurred_on, 'FMDD') || '日'
      || '|(' || lower(to_char(d.occurred_on, 'FMMonth')) || '|' || lower(to_char(d.occurred_on, 'Mon')) || ')\.?\s+'
        || to_char(d.occurred_on, 'FMDD') || '(st|nd|rd|th)?'
      || '|' || to_char(d.occurred_on, 'FMDD') || '(st|nd|rd|th)?\s+(of\s+)?('
        || lower(to_char(d.occurred_on, 'FMMonth')) || '|' || lower(to_char(d.occurred_on, 'Mon')) || ')'
      || '|' || to_char(d.occurred_on, 'FMDD') || '\s+de\s+('
        || (ARRAY['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre',
          'diciembre'])[extract(month FROM d.occurred_on)::int] || '|'
        || (ARRAY['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro',
          'dezembro'])[extract(month FROM d.occurred_on)::int] || ')'
      || '|0?' || to_char(d.occurred_on, 'FMDD') || '[/.]0?' || to_char(d.occurred_on, 'FMMM') || '[/.]' || to_char(d.occurred_on, 'YYYY')
      || '|0?' || to_char(d.occurred_on, 'FMMM') || '/0?' || to_char(d.occurred_on, 'FMDD') || '/' || to_char(d.occurred_on, 'YYYY')
      || '|' || to_char(d.occurred_on, 'YYYY') || '[/.]0?' || to_char(d.occurred_on, 'FMMM') || '[/.]0?' || to_char(d.occurred_on, 'FMDD')
      || ')([^0-9]|$)'
    ) AS found_in_text
  FROM dated d
  JOIN articles a ON a.id = d.article_id
)
SELECT 'M5a' AS measure,
  category,
  count(*)::int AS passed,
  count(claim)::int AS with_claim,
  count(*) FILTER (WHERE claim IS NOT NULL AND occurred_on IS NULL)::int AS malformed,
  count(*) FILTER (WHERE found_in_text)::int AS found_in_text,
  count(*) FILTER (WHERE occurred_on = (date_trunc('month', occurred_on) + interval '1 month' - interval '1 day')::date)::int AS month_end,
  count(*) FILTER (
    WHERE occurred_on = (date_trunc('month', occurred_on) + interval '1 month' - interval '1 day')::date
      AND extract(month FROM occurred_on) IN (3, 6, 9, 12)
  )::int AS quarter_end
FROM checked
GROUP BY 2
ORDER BY 3 DESC;

-- [M5b] Publication day minus the claimed occurrence day, by category, on passed articles analysed in the last 60 days.
-- Measures: for every valid claim, the Beijing day of the article's timeline time minus the claimed day, banded.
-- Decides: oldGapDays (start value 4) and lateReportHours (start value 72) of the freshness rules.
-- Columns: measure, category, gap_band, claims
WITH latest AS (
  SELECT DISTINCT ON (an.article_id) an.article_id, an.relevance, an.category, an.output->'fact'->>'occurredAt' AS claim
  FROM analyses an
  WHERE an.created_at >= now() - interval '60 days'
  ORDER BY an.article_id, an.input_revision DESC, an.id DESC
), dated AS (
  SELECT l.article_id, coalesce(l.category, '?') AS category,
    CASE WHEN l.claim ~ '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' THEN
      CASE WHEN substr(l.claim, 9, 2)::int
          <= extract(day FROM make_date(substr(l.claim, 1, 4)::int, substr(l.claim, 6, 2)::int, 1) + interval '1 month' - interval '1 day')
        THEN make_date(substr(l.claim, 1, 4)::int, substr(l.claim, 6, 2)::int, substr(l.claim, 9, 2)::int)
      END
    END AS occurred_on
  FROM latest l
  WHERE l.relevance = 'pass'
), gaps AS (
  SELECT d.category, (a.timeline_at AT TIME ZONE 'Asia/Shanghai')::date - d.occurred_on AS gap
  FROM dated d
  JOIN articles a ON a.id = d.article_id
  WHERE d.occurred_on IS NOT NULL
)
SELECT 'M5b' AS measure,
  category,
  CASE
    WHEN gap < 0 THEN 'a claim after publication'
    WHEN gap = 0 THEN 'b same day'
    WHEN gap = 1 THEN 'c 1 day'
    WHEN gap <= 4 THEN 'd 2-4 days'
    WHEN gap <= 7 THEN 'e 5-7 days'
    WHEN gap <= 30 THEN 'f 8-30 days'
    WHEN gap <= 90 THEN 'g 31-90 days'
    ELSE 'h over 90 days'
  END AS gap_band,
  count(*)::int AS claims
FROM gaps
GROUP BY 2, 3
ORDER BY 2, 3;

-- [M5c] The same gap by source: the 60 sources with the most valid claims.
-- Measures: per source, valid claims and how many lie more than 4 days before publication.
-- Decides: whether the old-news rule needs a per-source exception (a source that always reports late or always dates
--   the period instead of the event).
-- Columns: measure, source_id, claims, over_4_days, over_30_days
WITH latest AS (
  SELECT DISTINCT ON (an.article_id) an.article_id, an.relevance, an.output->'fact'->>'occurredAt' AS claim
  FROM analyses an
  WHERE an.created_at >= now() - interval '60 days'
  ORDER BY an.article_id, an.input_revision DESC, an.id DESC
), dated AS (
  SELECT l.article_id,
    CASE WHEN l.claim ~ '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' THEN
      CASE WHEN substr(l.claim, 9, 2)::int
          <= extract(day FROM make_date(substr(l.claim, 1, 4)::int, substr(l.claim, 6, 2)::int, 1) + interval '1 month' - interval '1 day')
        THEN make_date(substr(l.claim, 1, 4)::int, substr(l.claim, 6, 2)::int, substr(l.claim, 9, 2)::int)
      END
    END AS occurred_on
  FROM latest l
  WHERE l.relevance = 'pass'
), gaps AS (
  SELECT a.source_id, (a.timeline_at AT TIME ZONE 'Asia/Shanghai')::date - d.occurred_on AS gap
  FROM dated d
  JOIN articles a ON a.id = d.article_id
  WHERE d.occurred_on IS NOT NULL
)
SELECT 'M5c' AS measure,
  source_id,
  count(*)::int AS claims,
  count(*) FILTER (WHERE gap > 4)::int AS over_4_days,
  count(*) FILTER (WHERE gap > 30)::int AS over_30_days
FROM gaps
GROUP BY 2
ORDER BY 3 DESC, 2
LIMIT 60;

-- [M5d] 50 articles whose claimed day lies more than 4 days before publication, for a person to read.
-- Measures: identifiers only (no text): a fixed pseudo-random sample, so a rerun returns the same articles. The reader
--   opens each in the admin and labels the claim: the event day, a period end, a background date, or wrong.
-- Decides: together with M5a, whether "old" may ever be decided from the claim alone.
-- Columns: measure, article_id, source_id, category, occurred_on, published_on, gap_days
WITH latest AS (
  SELECT DISTINCT ON (an.article_id) an.article_id, an.relevance, an.category, an.output->'fact'->>'occurredAt' AS claim
  FROM analyses an
  WHERE an.created_at >= now() - interval '60 days'
  ORDER BY an.article_id, an.input_revision DESC, an.id DESC
), dated AS (
  SELECT l.article_id, l.category,
    CASE WHEN l.claim ~ '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' THEN
      CASE WHEN substr(l.claim, 9, 2)::int
          <= extract(day FROM make_date(substr(l.claim, 1, 4)::int, substr(l.claim, 6, 2)::int, 1) + interval '1 month' - interval '1 day')
        THEN make_date(substr(l.claim, 1, 4)::int, substr(l.claim, 6, 2)::int, substr(l.claim, 9, 2)::int)
      END
    END AS occurred_on
  FROM latest l
  WHERE l.relevance = 'pass'
)
SELECT 'M5d' AS measure,
  d.article_id,
  a.source_id,
  d.category,
  d.occurred_on,
  (a.timeline_at AT TIME ZONE 'Asia/Shanghai')::date AS published_on,
  (a.timeline_at AT TIME ZONE 'Asia/Shanghai')::date - d.occurred_on AS gap_days
FROM dated d
JOIN articles a ON a.id = d.article_id
WHERE d.occurred_on IS NOT NULL AND (a.timeline_at AT TIME ZONE 'Asia/Shanghai')::date - d.occurred_on > 4
ORDER BY md5(d.article_id)
LIMIT 50;

-- [M6a] Facts with two or more current members, created in the last 60 days: do their members' date claims agree?
-- Measures: per fact, the members' latest occurrence claims: none, one day claimed by every member, one day with some
--   members silent, or different days (split by whether the valid days lie within 2 days of each other, and apart when
--   one of the claims is not a valid date).
-- Decides: whether a fact's occurrence day may be taken from one member (the claimed / verified / agreed gate) and the
--   7-day "dates far apart" rule.
-- Columns: measure, members_band, agreement, facts
WITH members AS (
  SELECT fa.fact_id, fa.article_id
  FROM fact_articles fa
  JOIN facts f ON f.id = fa.fact_id
  JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
  WHERE fa.role IN ('primary', 'report') AND f.created_at >= now() - interval '60 days'
), claims AS (
  SELECT m.fact_id, l.claim,
    CASE WHEN l.claim ~ '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' THEN
      CASE WHEN substr(l.claim, 9, 2)::int
          <= extract(day FROM make_date(substr(l.claim, 1, 4)::int, substr(l.claim, 6, 2)::int, 1) + interval '1 month' - interval '1 day')
        THEN make_date(substr(l.claim, 1, 4)::int, substr(l.claim, 6, 2)::int, substr(l.claim, 9, 2)::int)
      END
    END AS occurred_on
  FROM members m
  LEFT JOIN LATERAL (
    SELECT x.output->'fact'->>'occurredAt' AS claim FROM analyses x WHERE x.article_id = m.article_id ORDER BY x.input_revision DESC, x.id DESC LIMIT 1
  ) l ON true
), facts_seen AS (
  SELECT fact_id, count(*) AS n, count(claim) AS claimed, count(DISTINCT claim) AS distinct_claims,
    count(*) FILTER (WHERE claim IS NOT NULL AND occurred_on IS NULL) AS unreadable, max(occurred_on) - min(occurred_on) AS spread_days
  FROM claims
  GROUP BY fact_id
  HAVING count(*) >= 2
)
SELECT 'M6a' AS measure,
  CASE WHEN n = 2 THEN 'a 2' WHEN n <= 5 THEN 'b 3-5' WHEN n <= 10 THEN 'c 6-10' ELSE 'd 11+' END AS members_band,
  CASE
    WHEN distinct_claims = 0 THEN 'a no claim'
    WHEN distinct_claims = 1 AND claimed = n THEN 'b all agree'
    WHEN distinct_claims = 1 THEN 'c agree, some silent'
    WHEN unreadable > 0 THEN 'f differ, one claim unreadable'
    WHEN spread_days <= 2 THEN 'd differ within 2 days'
    ELSE 'e differ by more than 2 days'
  END AS agreement,
  count(*)::int AS facts
FROM facts_seen
GROUP BY 2, 3
ORDER BY 2, 3;

-- [M6b] How long after a fact's first report its other members arrive (facts created in the last 60 days).
-- Measures: for every member of a fact with two or more members, its timeline time minus the earliest member's, banded.
-- Decides: lateReportHours (start value 72) and the follow-up penalty: how long a fact keeps gaining reports.
-- Columns: measure, after_first_band, members
WITH members AS (
  SELECT fa.fact_id, a.timeline_at
  FROM fact_articles fa
  JOIN facts f ON f.id = fa.fact_id
  JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
  JOIN articles a ON a.id = fa.article_id
  WHERE fa.role IN ('primary', 'report') AND f.created_at >= now() - interval '60 days'
), timed AS (
  SELECT timeline_at - min(timeline_at) OVER (PARTITION BY fact_id) AS after_first, count(*) OVER (PARTITION BY fact_id) AS n
  FROM members
)
SELECT 'M6b' AS measure,
  CASE
    WHEN after_first = interval '0' THEN 'a first report'
    WHEN after_first < interval '6 hours' THEN 'b <6h'
    WHEN after_first < interval '24 hours' THEN 'c 6-24h'
    WHEN after_first < interval '48 hours' THEN 'd 1-2d'
    WHEN after_first < interval '72 hours' THEN 'e 2-3d'
    WHEN after_first < interval '7 days' THEN 'f 3-7d'
    WHEN after_first < interval '14 days' THEN 'g 7-14d'
    ELSE 'h 14d+'
  END AS after_first_band,
  count(*)::int AS members
FROM timed
WHERE n >= 2
GROUP BY 2
ORDER BY 2;

-- [M7] The leads of the last 30 daily issues.
-- Measures: per issue, the number of main entries and how many carry a story id; the lead's current story (after
--   merges), whether it is the previous issue's lead story again, the lead's outlet count, score and follow-up mark; its
--   rank by score among the main entries; and whether another main entry ranks above it on score alone (score, +5 for an
--   official source, -12 for a follow-up), i.e. a lead that an importance order without outlet counts would change.
-- Decides: defects 2 and 3 (the same story leads three days running; the lead is picked by outlet count): how often each
--   happens, and the size of the follow-up penalty.
-- Columns: measure, issue, main_entries, main_with_story, lead_item, lead_story, repeats_previous_lead, lead_sources, lead_score, lead_follow_up, lead_score_rank, score_order_would_change
WITH issues AS (
  SELECT key, content FROM reports WHERE kind = 'daily' ORDER BY key DESC LIMIT 30
), main AS (
  SELECT i.key, it.value AS item
  FROM issues i
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.content->'sections') = 'array' THEN i.content->'sections' ELSE '[]'::jsonb END) s
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.value->'items') = 'array' THEN s.value->'items' ELSE '[]'::jsonb END) it
), entries AS (
  SELECT m.key,
    m.item->>'itemId' AS item_id,
    m.item->>'storyPublicId' AS stored_story,
    coalesce(merged.public_id, st.public_id)::text AS story_now,
    CASE WHEN jsonb_typeof(m.item->'sources') = 'number' THEN (m.item->>'sources')::int END AS sources,
    CASE WHEN jsonb_typeof(m.item->'score') = 'number' THEN (m.item->>'score')::numeric END AS score,
    m.item ? 'followUp' AS follow_up,
    coalesce(m.item->>'role' = '官方', false) AS official
  FROM main m
  LEFT JOIN publications p ON p.article_id = m.item->>'itemId'
  LEFT JOIN stories st ON st.id = p.story_id
  LEFT JOIN stories merged ON merged.id = st.merged_into
), per_issue AS (
  SELECT i.key AS issue,
    count(e.item_id)::int AS main_entries,
    count(e.stored_story)::int AS main_with_story,
    i.content->>'leadItemId' AS lead_item,
    max(e.story_now) FILTER (WHERE e.item_id = i.content->>'leadItemId') AS lead_story,
    max(e.sources) FILTER (WHERE e.item_id = i.content->>'leadItemId') AS lead_sources,
    max(e.score) FILTER (WHERE e.item_id = i.content->>'leadItemId') AS lead_score,
    bool_or(e.follow_up) FILTER (WHERE e.item_id = i.content->>'leadItemId') AS lead_follow_up,
    max(coalesce(e.score, 50) + CASE WHEN e.official THEN 5 ELSE 0 END - CASE WHEN e.follow_up THEN 12 ELSE 0 END)
      FILTER (WHERE e.item_id = i.content->>'leadItemId') AS lead_importance,
    array_agg(coalesce(e.score, 50) + CASE WHEN e.official THEN 5 ELSE 0 END - CASE WHEN e.follow_up THEN 12 ELSE 0 END)
      FILTER (WHERE e.item_id IS DISTINCT FROM i.content->>'leadItemId') AS other_importance,
    array_agg(e.score) FILTER (WHERE e.item_id IS DISTINCT FROM i.content->>'leadItemId') AS other_scores
  FROM issues i
  LEFT JOIN entries e ON e.key = i.key
  GROUP BY i.key, i.content
)
SELECT 'M7' AS measure,
  issue,
  main_entries,
  main_with_story,
  lead_item,
  lead_story,
  lead_story = lag(lead_story) OVER (ORDER BY issue) AS repeats_previous_lead,
  lead_sources,
  lead_score,
  coalesce(lead_follow_up, false) AS lead_follow_up,
  1 + (SELECT count(*) FROM unnest(other_scores) s WHERE s > lead_score)::int AS lead_score_rank,
  EXISTS (SELECT 1 FROM unnest(other_importance) v WHERE v > lead_importance) AS score_order_would_change
FROM per_issue
ORDER BY issue DESC;

-- [M8] Hot board entries whose leading fact is old, over the stored rankings of the last 30 days.
-- Measures: for every entry of every published ranking, whether the fact its representative report belongs to (the
--   leading fact) was first reported more than 72 hours before the ranking, and whether the story as a whole was.
-- Decides: whether the hot board sinks or only labels stale stories, and how many entries that touches by rank.
-- Columns: measure, rank_band, rankings, entries, leading_fact_older_72h, story_older_72h, leading_fact_unknown
WITH entries AS (
  SELECT h.id, h.computed_at,
    CASE WHEN jsonb_typeof(e.value->'rank') = 'number' THEN (e.value->>'rank')::int END AS rank,
    e.value->>'representativeItemId' AS representative,
    CASE WHEN jsonb_typeof(e.value->'firstReportAt') = 'string' THEN (e.value->>'firstReportAt')::timestamptz END AS story_first
  FROM hot_rankings h
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(h.entries) = 'array' THEN h.entries ELSE '[]'::jsonb END) e
  WHERE h.published AND h.computed_at >= now() - interval '30 days'
), aged AS (
  SELECT en.*,
    (SELECT min(a.timeline_at)
     FROM fact_articles r
     JOIN fact_articles m ON m.fact_id = r.fact_id AND m.role IN ('primary', 'report')
     JOIN articles a ON a.id = m.article_id
     WHERE r.article_id = en.representative AND r.role IN ('primary', 'report')) AS fact_first
  FROM entries en
)
SELECT 'M8' AS measure,
  CASE WHEN rank <= 3 THEN 'a 1-3' WHEN rank <= 10 THEN 'b 4-10' ELSE 'c 11+' END AS rank_band,
  count(DISTINCT id)::int AS rankings,
  count(*)::int AS entries,
  count(*) FILTER (WHERE computed_at - fact_first > interval '72 hours')::int AS leading_fact_older_72h,
  count(*) FILTER (WHERE computed_at - story_first > interval '72 hours')::int AS story_older_72h,
  count(*) FILTER (WHERE fact_first IS NULL)::int AS leading_fact_unknown
FROM aged
GROUP BY 2
ORDER BY 2;

-- [M9] Human corrections of grouping in the last 60 days (the human-labelled set).
-- Measures: "keep standalone" and split overrides by mode, manual detaches, story merges made by a person (not by the
--   grouping step), and manual regroup requests.
-- Decides: whether the agreement report has enough human labels to judge the shadow rules, or needs a labelled sample.
-- Columns: measure, label, actions
SELECT 'M9' AS measure, 'grouping_overrides:' || o.mode AS label, count(*)::int AS actions
FROM grouping_overrides o
WHERE o.created_at >= now() - interval '60 days'
GROUP BY 2
UNION ALL
SELECT 'M9', l.action, count(*)::int
FROM audit_log l
WHERE l.created_at >= now() - interval '60 days'
  AND (l.action IN ('content.detach', 'content.rerun.group') OR (l.action = 'story.merge' AND l.actor <> 'grouping'))
GROUP BY 2
ORDER BY 2;

-- [M10] Indexes on articles, with use counts.
-- Measures: every index of the articles table as production has it, how often each was used, the table's sequential
--   scans and live rows. An equality probe on url or content_hash uses an index only if one listed here starts with
--   that column; otherwise it reads the whole table.
-- Decides: whether a content_hash index (and the url index the migrations create) is in place before the event shadow
--   probes both for every grouped article.
-- Columns: measure, index_name, definition, index_scans, index_size, table_seq_scans, table_live_rows
SELECT 'M10' AS measure,
  i.indexrelname AS index_name,
  pg_get_indexdef(i.indexrelid) AS definition,
  i.idx_scan AS index_scans,
  pg_size_pretty(pg_relation_size(i.indexrelid)) AS index_size,
  t.seq_scan AS table_seq_scans,
  t.n_live_tup AS table_live_rows
FROM pg_stat_user_indexes i
JOIN pg_stat_user_tables t ON t.relid = i.relid
WHERE i.relid = 'public.articles'::regclass
ORDER BY 2;

-- [M11] What re-publishes an article, per day over the last 14 days.
-- Measures: nothing records each publish call, so this counts what triggers one: analyses written, grouping decisions,
--   person-made content and story actions, entries of the selected ledger, and publications whose last change fell on
--   that day (a lower bound: a publication changed twice keeps only its last time).
-- Decides: the load of the event-order projection job that every publish will enqueue (one job per article and call).
-- Columns: measure, day, trigger, events
SELECT 'M11' AS measure, day, trigger, count(*)::int AS events
FROM (
  SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day, 'analysis written' AS trigger
  FROM analyses WHERE created_at >= now() - interval '14 days'
  UNION ALL
  SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date, 'grouping decision'
  FROM grouping_decisions WHERE created_at >= now() - interval '14 days'
  UNION ALL
  SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date, 'content or story action by a person'
  FROM audit_log WHERE created_at >= now() - interval '14 days' AND (action LIKE 'content.%' OR action LIKE 'story.%') AND actor <> 'grouping'
  UNION ALL
  SELECT (changed_at AT TIME ZONE 'Asia/Shanghai')::date, 'selected ledger entry'
  FROM selected_ledger WHERE changed_at >= now() - interval '14 days'
  UNION ALL
  SELECT (updated_at AT TIME ZONE 'Asia/Shanghai')::date, 'publication last changed'
  FROM publications WHERE updated_at >= now() - interval '14 days'
) x
GROUP BY 2, 3
ORDER BY 2 DESC, 3;

-- [M12] Fact sizes: current members of the facts changed in the last 14 days.
-- Measures: facts by their number of current members (primary and report roles), with the largest.
-- Decides: the cost of recomputing a fact's anchor on every publish of one of its members (a 50-member fact merged
--   member by member costs 50 x 50 reads).
-- Columns: measure, members_band, facts, largest
WITH sizes AS (
  SELECT f.id, count(fa.article_id) AS n
  FROM facts f
  LEFT JOIN fact_articles fa ON fa.fact_id = f.id AND fa.role IN ('primary', 'report')
  WHERE f.updated_at >= now() - interval '14 days'
  GROUP BY f.id
)
SELECT 'M12' AS measure,
  CASE
    WHEN n <= 1 THEN 'a 0-1'
    WHEN n = 2 THEN 'b 2'
    WHEN n <= 5 THEN 'c 3-5'
    WHEN n <= 10 THEN 'd 6-10'
    WHEN n <= 20 THEN 'e 11-20'
    WHEN n <= 50 THEN 'f 21-50'
    ELSE 'g 51+'
  END AS members_band,
  count(*)::int AS facts,
  max(n)::int AS largest
FROM sizes
GROUP BY 2
ORDER BY 2;

-- [M13] The same article from different sources left in different stories, last 30 days (a lower bound on duplicates
--   live grouping did not group).
-- Measures: groups of articles with one stored content hash (title, body and excerpt alike) from more than one source,
--   discovered in the last 30 days, every copy with a body of 500 bytes or more (a hash over a short or empty body ties
--   unrelated title-only items). Only copies the live engine placed in a fact count (a primary or report member: it
--   places only editorial reports that passed relevance, so roundups, discussion posts and rejected items stay out;
--   archive history counts where it was attached to a fact), and a group needs two of them. Per group: how many distinct stories its placed copies sit in now.
--   Stories merged by an editor or the engine count once: a merge moves the facts (events/merge.ts). Exact copies only,
--   so reworded duplicates, which character-pair recall can miss, are not counted: split_across_stories is a lower bound.
-- Decides: whether duplicates go ungrouped at a level readers notice, before the embeddings question (option C of
--   the recall review) goes to the Owner.
-- Columns: measure, groups, articles, split_across_stories, one_story
WITH twins AS (
  SELECT content_hash
  FROM articles
  WHERE content_hash IS NOT NULL AND discovered_at > now() - interval '30 days'
  GROUP BY content_hash
  HAVING count(DISTINCT source_id) > 1 AND min(octet_length(coalesce(body_text, ''))) >= 500
), placed AS (
  SELECT a.content_hash, a.source_id, m.story_id
  FROM articles a
  JOIN twins t ON t.content_hash = a.content_hash
  JOIN LATERAL (
    SELECT min(f.story_id) AS story_id
    FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
    WHERE fa.article_id = a.id AND fa.role IN ('primary', 'report')
  ) m ON m.story_id IS NOT NULL
  WHERE a.discovered_at > now() - interval '30 days'
), groups AS (
  SELECT content_hash, count(*) AS n, count(DISTINCT story_id) AS stories
  FROM placed
  GROUP BY content_hash
  HAVING count(*) > 1 AND count(DISTINCT source_id) > 1
)
SELECT 'M13' AS measure,
  count(*)::int AS groups,
  coalesce(sum(n), 0)::int AS articles,
  count(*) FILTER (WHERE stories > 1)::int AS split_across_stories,
  count(*) FILTER (WHERE stories = 1)::int AS one_story
FROM groups;
