-- Package 2 measurements, part L: what one article says (company names, datelines, countries) and what the per-article
-- checks will cost. Read-only: every statement is a single SELECT (or WITH ... SELECT); tests/measure-sql.test.ts holds
-- every file to that and runs each statement inside a READ ONLY transaction on a migrated test database. How to run it
-- on production and what to send back: docs/runbooks/package2-measurements.md. Output is counts, distributions,
-- identifiers and company names only; no statement returns article text. Days are Beijing days.

-- [L1a] Size of the tables the per-article checks and the event shadow read or grow next to.
-- Measures: estimated rows (planner statistics, no scan) and total size including indexes and TOAST.
-- Decides: back-fill run time and whether the new tables (article links, analysis checks, shadow decisions) need pruning
--   from day one on the 4 GB server.
-- Columns: measure, table_name, estimated_rows, total_size, total_bytes
SELECT 'L1a' AS measure,
  t.name AS table_name,
  c.reltuples::bigint AS estimated_rows,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
  pg_total_relation_size(c.oid) AS total_bytes
FROM (VALUES ('public.articles'), ('public.analyses'), ('public.publications'), ('public.embeddings'), ('public.receipts'),
  ('public.receipt_attempts'), ('public.grouping_decisions'), ('public.fact_articles'), ('enrichment.english_copies'),
  ('publication.news_geography'), ('policy.document_extractions'), ('policy.original_resources')) AS t(name)
JOIN pg_class c ON c.oid = to_regclass(t.name)
ORDER BY 5 DESC, 2;

-- [L1b] Articles and their bodies.
-- Measures: all articles, those with a body, the summed and largest body size (read from the stored length, the bodies
--   themselves are not decompressed).
-- Decides: how long a back-fill over every body (entity links, dateline check) runs, page by page.
-- Columns: measure, articles, with_body, body_bytes, largest_body_bytes
SELECT 'L1b' AS measure,
  count(*)::int AS articles,
  count(*) FILTER (WHERE octet_length(body_text) > 0)::int AS with_body,
  coalesce(sum(octet_length(body_text)), 0)::bigint AS body_bytes,
  coalesce(max(octet_length(body_text)), 0)::bigint AS largest_body_bytes
FROM articles;

-- [L1c] Analyses written per day and origin over the last 14 days.
-- Measures: judgements per day (each one would run the per-article checks once).
-- Decides: the daily volume of analysis checks and article links the observe step will write.
-- Columns: measure, day, origin, analyses
SELECT 'L1c' AS measure,
  (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
  coalesce(origin, '?') AS origin,
  count(*)::int AS analyses
FROM analyses
WHERE created_at >= now() - interval '14 days'
GROUP BY 2, 3
ORDER BY 2 DESC, 3;

-- [L2a] How many passed judgements of the last 30 days name a company subject id.
-- Measures: the latest judgement per article (created in the last 30 days, relevance pass) and whether its subjects list
--   holds at least one id.
-- Decides: how much of the entity library the model's subjects can seed, against the text-only linker.
-- Columns: measure, judgements, with_subject
WITH latest AS (
  SELECT DISTINCT ON (an.article_id) an.article_id, an.relevance, an.subjects
  FROM analyses an
  WHERE an.created_at >= now() - interval '30 days'
  ORDER BY an.article_id, an.input_revision DESC, an.id DESC
)
SELECT 'L2a' AS measure,
  count(*)::int AS judgements,
  count(*) FILTER (WHERE cardinality(subjects) > 0)::int AS with_subject
FROM latest
WHERE relevance = 'pass';

-- [L2b] Subject ids on passed judgements of the last 90 days, by id.
-- Measures: per subject id, the number of latest judgements naming it.
-- Decides: which of the 24 tagged companies matter most and the rule for a subject with no model answer.
-- Columns: measure, subject_id, judgements
WITH latest AS (
  SELECT DISTINCT ON (an.article_id) an.article_id, an.relevance, an.subjects
  FROM analyses an
  WHERE an.created_at >= now() - interval '90 days'
  ORDER BY an.article_id, an.input_revision DESC, an.id DESC
)
SELECT 'L2b' AS measure, s.subject_id, count(*)::int AS judgements
FROM latest l
CROSS JOIN LATERAL unnest(l.subjects) AS s(subject_id)
WHERE l.relevance = 'pass'
GROUP BY 2
ORDER BY 3 DESC, 2;

-- [L3a] The 300 most frequent fact subjects of passed judgements in the last 90 days.
-- Measures: the structure step's fact.subject (a company or body name as the model wrote it) with its count.
-- Decides: which companies beyond the seeded ones enter the entity library first.
-- Columns: measure, subject, judgements
WITH latest AS (
  SELECT DISTINCT ON (an.article_id) an.article_id, an.relevance, an.output->'fact'->>'subject' AS subject
  FROM analyses an
  WHERE an.created_at >= now() - interval '90 days'
  ORDER BY an.article_id, an.input_revision DESC, an.id DESC
)
SELECT 'L3a' AS measure, btrim(subject) AS subject, count(*)::int AS judgements
FROM latest
WHERE relevance = 'pass' AND btrim(coalesce(subject, '')) <> ''
GROUP BY 2
ORDER BY 3 DESC, 2
LIMIT 300;

-- [L3b] How many distinct fact subjects there are (same window as L3a).
-- Measures: distinct subjects and the judgements that carry one.
-- Decides: how long the tail behind the top 300 of L3a is.
-- Columns: measure, distinct_subjects, judgements_with_subject
WITH latest AS (
  SELECT DISTINCT ON (an.article_id) an.article_id, an.relevance, an.output->'fact'->>'subject' AS subject
  FROM analyses an
  WHERE an.created_at >= now() - interval '90 days'
  ORDER BY an.article_id, an.input_revision DESC, an.id DESC
)
SELECT 'L3b' AS measure,
  count(DISTINCT btrim(subject))::int AS distinct_subjects,
  count(*)::int AS judgements_with_subject
FROM latest
WHERE relevance = 'pass' AND btrim(coalesce(subject, '')) <> '';

-- [L3c] Owner entities recorded on sources.
-- Measures: every distinct sources.owner_entity_id with the number of sources (and enabled sources) carrying it.
-- Decides: which owner values are entity library ids already and which are free text that must not be linked.
-- Columns: measure, owner_entity_id, sources, enabled_sources
SELECT 'L3c' AS measure, owner_entity_id, count(*)::int AS sources, count(*) FILTER (WHERE enabled)::int AS enabled_sources
FROM sources
WHERE owner_entity_id IS NOT NULL
GROUP BY 2
ORDER BY 3 DESC, 2;

-- [L4a] Company names written as Chinese（Latin） in public titles and summaries of the last 90 days.
-- Measures: every Chinese name followed by a bracketed Latin name, grouped by the Latin name (case folded). The Han run
--   before the bracket can start with the words in front of the name, so one leading preposition or conjunction (与,
--   和, 对, 据 ...) is dropped, and a form that merely ends with another form of the same Latin name (矿商必和必拓 next
--   to 必和必拓) is not counted as a variant. names_with_variants is the size of the "two Chinese names for one
--   company" defect; L4b lists the forms for a person to read.
-- Decides: the variant seed of the entity library and whether names of already published items are rewritten.
-- Columns: measure, latin_names, names_with_variants, items_with_a_pair
WITH texts AS (
  SELECT p.article_id, coalesce(p.title, '') || ' ' || coalesce(p.summary, '') AS t
  FROM publications p
  WHERE p.visibility = 'public' AND p.channel = 'news' AND p.timeline_at >= now() - interval '90 days'
), pairs AS (
  SELECT x.article_id, CASE WHEN m[1] ~ '^[与及和对向将据由被让从把称并在于是].{2,}' THEN substr(m[1], 2) ELSE m[1] END AS zh,
    lower(btrim(m[2])) AS latin
  FROM texts x
  CROSS JOIN LATERAL regexp_matches(x.t, '([一-鿿·]{2,16})\s*[（(]\s*([A-Za-z][A-Za-z0-9&., -]{0,58}[A-Za-z0-9.])\s*[)）]', 'g') AS m
), forms AS (
  SELECT latin, zh, count(DISTINCT article_id) AS items FROM pairs GROUP BY 1, 2
), minimal AS (
  SELECT f.latin, f.zh FROM forms f
  WHERE NOT EXISTS (SELECT 1 FROM forms g WHERE g.latin = f.latin AND length(g.zh) < length(f.zh) AND right(f.zh, length(g.zh)) = g.zh)
), names AS (
  SELECT latin, count(*) AS variants FROM minimal GROUP BY latin
)
SELECT 'L4a' AS measure,
  (SELECT count(*) FROM names)::int AS latin_names,
  (SELECT count(*) FROM names WHERE variants > 1)::int AS names_with_variants,
  (SELECT count(DISTINCT article_id) FROM pairs)::int AS items_with_a_pair;

-- [L4b] The Latin names of L4a that have more than one Chinese form, with the forms (the 200 most used names).
-- Measures: per Latin name, its Chinese forms (most used first, with item counts) and the items carrying any of them.
-- Decides: the variant seed: which Chinese forms the library maps to one company, and which needs a person to pick.
-- Columns: measure, latin, forms, items
WITH texts AS (
  SELECT p.article_id, coalesce(p.title, '') || ' ' || coalesce(p.summary, '') AS t
  FROM publications p
  WHERE p.visibility = 'public' AND p.channel = 'news' AND p.timeline_at >= now() - interval '90 days'
), pairs AS (
  SELECT x.article_id, CASE WHEN m[1] ~ '^[与及和对向将据由被让从把称并在于是].{2,}' THEN substr(m[1], 2) ELSE m[1] END AS zh,
    lower(btrim(m[2])) AS latin
  FROM texts x
  CROSS JOIN LATERAL regexp_matches(x.t, '([一-鿿·]{2,16})\s*[（(]\s*([A-Za-z][A-Za-z0-9&., -]{0,58}[A-Za-z0-9.])\s*[)）]', 'g') AS m
), forms AS (
  SELECT latin, zh, count(DISTINCT article_id) AS items FROM pairs GROUP BY 1, 2
), minimal AS (
  SELECT f.latin, f.zh, f.items FROM forms f
  WHERE NOT EXISTS (SELECT 1 FROM forms g WHERE g.latin = f.latin AND length(g.zh) < length(f.zh) AND right(f.zh, length(g.zh)) = g.zh)
)
SELECT 'L4b' AS measure,
  latin,
  string_agg(zh || ' ' || items, ', ' ORDER BY items DESC, zh) AS forms,
  sum(items)::int AS items
FROM minimal
GROUP BY latin
HAVING count(*) > 1
ORDER BY 4 DESC, 2
LIMIT 200;

-- [L5a] Datelines at the start of public news bodies collected in the last 30 days, by language and kind.
-- Measures: the first 300 characters of each body, classed as a press-release wire dateline (PRNewswire, GLOBE
--   NEWSWIRE, CNW, Business Wire, ACCESSWIRE, Newsfile, EIN Presswire), a news-agency dateline (Reuters, EFE, AFP,
--   AP, Xinhua, Bloomberg and other agencies in brackets), another capitalised place-and-dash opening, or none. This is
--   an approximation of the dateline parser that lands with the per-article checks; it gives the order of magnitude.
-- Decides: whether the dateline rule may demote both kinds alike (an agency dateline is usually the event country, a
--   wire dateline the issuer's office) and DATELINE_RULE_SINCE.
-- Columns: measure, language, kind, articles
WITH recent AS (
  SELECT coalesce(nullif(split_part(lower(a.language), '-', 1), ''), '?') AS language, substr(coalesce(a.body_text, ''), 1, 300) AS head
  FROM articles a
  JOIN publications p ON p.article_id = a.id AND p.visibility = 'public' AND p.channel = 'news'
  WHERE a.discovered_at >= now() - interval '30 days'
)
SELECT 'L5a' AS measure,
  language,
  CASE
    WHEN head ~* '(/\s*PRNewswire\s*/|GLOBE NEWSWIRE|/\s*CNW\s*/|Business\s?Wire|ACCESS\s?(WIRE|Newswire)|Newsfile|EIN\s?Presswire)'
      THEN 'press_release_wire'
    WHEN head ~ '^\s*[^\n]{0,80}\((Reuters|EFE|AFP|AP|Xinhua|Bloomberg|Europa Press|Lusa|ANSA|dpa|Kyodo|TASS|Yonhap|Bernama|Antara|PTI|IANS|Agencia [^)]{1,30}|Agência [^)]{1,30})\)'
      THEN 'news_agency'
    WHEN head ~ '^\s*[A-ZÀ-Ý][A-ZÀ-Ý .''-]{2,40}(,\s*[^,\n]{2,40}){0,3}\s*(--|—|–|-\s)' THEN 'other_dateline'
    ELSE 'none'
  END AS kind,
  count(*)::int AS articles
FROM recent
GROUP BY 2, 3
ORDER BY 2, 3;

-- [L5b] The same articles by dateline kind against their stored geography.
-- Measures: per dateline kind (as L5a), the stored geography state and the number of assigned jurisdictions. An
--   article with a dateline and exactly one jurisdiction is the most an "only the dateline named this country" rule
--   could leave with none.
-- Decides: how many items the dateline rule would leave with no country, and whether the two exceptions are needed.
-- Columns: measure, kind, geography_state, jurisdictions, articles
WITH recent AS (
  SELECT a.id, substr(coalesce(a.body_text, ''), 1, 300) AS head
  FROM articles a
  JOIN publications p ON p.article_id = a.id AND p.visibility = 'public' AND p.channel = 'news'
  WHERE a.discovered_at >= now() - interval '30 days'
), classed AS (
  SELECT id,
    CASE
      WHEN head ~* '(/\s*PRNewswire\s*/|GLOBE NEWSWIRE|/\s*CNW\s*/|Business\s?Wire|ACCESS\s?(WIRE|Newswire)|Newsfile|EIN\s?Presswire)'
        THEN 'press_release_wire'
      WHEN head ~ '^\s*[^\n]{0,80}\((Reuters|EFE|AFP|AP|Xinhua|Bloomberg|Europa Press|Lusa|ANSA|dpa|Kyodo|TASS|Yonhap|Bernama|Antara|PTI|IANS|Agencia [^)]{1,30}|Agência [^)]{1,30})\)'
        THEN 'news_agency'
      WHEN head ~ '^\s*[A-ZÀ-Ý][A-ZÀ-Ý .''-]{2,40}(,\s*[^,\n]{2,40}){0,3}\s*(--|—|–|-\s)' THEN 'other_dateline'
      ELSE 'none'
    END AS kind
  FROM recent
)
SELECT 'L5b' AS measure,
  c.kind,
  coalesce(g.state, 'no row') AS geography_state,
  CASE
    WHEN g.article_id IS NULL THEN '-'
    WHEN cardinality(g.jurisdictions) = 0 THEN '0'
    WHEN cardinality(g.jurisdictions) = 1 THEN '1'
    ELSE '2+'
  END AS jurisdictions,
  count(*)::int AS articles
FROM classed c
LEFT JOIN publication.news_geography g ON g.article_id = c.id
GROUP BY 2, 3, 4
ORDER BY 2, 3, 4;

-- [L5c] Country tags on public news of the last 30 days that the stored geography does not assign.
-- Measures: public items whose tags hold a country's Chinese name (the countries of the jurisdictions dictionary, kept
--   equal to industry/jurisdictions/data.json by tests/measure-sql.test.ts; aliases are not counted), and how many such
--   tags name a country that is not among the item's jurisdictions (a subdivision of it counts as the country).
-- Decides: whether the dateline step must also drop a model-given country tag, since the card and the tag filter read
--   tags, not jurisdictions.
-- Columns: measure, items_with_country_tag, country_tags, tag_not_in_jurisdictions, no_geography_row
WITH countries(code, name_zh) AS (
  VALUES
    ('CN','中国'), ('US','美国'), ('AU','澳大利亚'), ('AR','阿根廷'), ('SR','苏里南'), ('CO','哥伦比亚'), ('GY','圭亚那'), ('GH','加纳'),
    ('ZA','南非'), ('CD','刚果（金）'), ('ZM','赞比亚'), ('MN','蒙古'), ('KG','吉尔吉斯斯坦'), ('TJ','塔吉克斯坦'), ('KZ','哈萨克斯坦'),
    ('RS','塞尔维亚'), ('CL','智利'), ('CA','加拿大'), ('PE','秘鲁'), ('RU','俄罗斯'), ('MZ','莫桑比克'), ('ZW','津巴布韦'),
    ('ID','印度尼西亚'), ('TZ','坦桑尼亚'), ('VE','委内瑞拉'), ('EC','厄瓜多尔'), ('SG','新加坡'), ('UZ','乌兹别克斯坦'), ('GB','英国'),
    ('IR','伊朗'), ('CH','瑞士'), ('BO','玻利维亚'), ('ML','马里'), ('BR','巴西')
), tagged AS (
  SELECT p.article_id, c.code
  FROM publications p
  JOIN countries c ON c.name_zh = ANY(p.tags)
  WHERE p.visibility = 'public' AND p.channel = 'news' AND p.timeline_at >= now() - interval '30 days'
)
SELECT 'L5c' AS measure,
  count(DISTINCT t.article_id)::int AS items_with_country_tag,
  count(*)::int AS country_tags,
  count(*) FILTER (
    WHERE g.article_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM unnest(g.jurisdictions) j WHERE j = t.code OR j LIKE t.code || '-%')
  )::int AS tag_not_in_jurisdictions,
  count(*) FILTER (WHERE g.article_id IS NULL)::int AS no_geography_row
FROM tagged t
LEFT JOIN publication.news_geography g ON g.article_id = t.article_id;

-- [L8a] English copies among items first made public in the last 7, 30 and 90 days.
-- Measures: public news items per window and how many carry an English title (one paid english_copy each).
-- Decides: the price of rewriting names of already published items: each rewritten item drops its English copy.
-- Columns: measure, window_days, items, with_english_copy
SELECT 'L8a' AS measure,
  w.days AS window_days,
  count(p.article_id)::int AS items,
  count(p.article_id) FILTER (WHERE p.title_en IS NOT NULL)::int AS with_english_copy
FROM (VALUES (7), (30), (90)) AS w(days)
LEFT JOIN publications p ON p.visibility = 'public' AND p.channel = 'news' AND p.first_public_at >= now() - make_interval(days => w.days)
GROUP BY 2
ORDER BY 2;

-- [L8b] Geography reasons on passed judgements of the last 30 days.
-- Measures: the reason recorded with each latest judgement's geography, including invalid_geography_evidence (the
--   model named a country its evidence does not support).
-- Decides: whether adding demonyms and provinces to the geography aliases is worth doing.
-- Columns: measure, geography_reason, judgements
WITH latest AS (
  SELECT DISTINCT ON (an.article_id) an.article_id, an.relevance, an.output->'geography'->>'reason' AS reason
  FROM analyses an
  WHERE an.created_at >= now() - interval '30 days'
  ORDER BY an.article_id, an.input_revision DESC, an.id DESC
)
SELECT 'L8b' AS measure, coalesce(reason, '(none)') AS geography_reason, count(*)::int AS judgements
FROM latest
WHERE relevance = 'pass'
GROUP BY 2
ORDER BY 3 DESC, 2;

-- [L9] The oldest stored model response, per purpose.
-- Measures: receipts that still hold a response, and when the oldest of them was created.
-- Decides: how far back "judge the same revision again for free" holds: a re-judgement reuses a receipt only while its
--   response is kept.
-- Columns: measure, purpose, receipts_with_response, oldest_on, oldest_age_days
SELECT 'L9' AS measure,
  purpose,
  count(*)::int AS receipts_with_response,
  (min(created_at) AT TIME ZONE 'Asia/Shanghai')::date AS oldest_on,
  extract(day FROM now() - min(created_at))::int AS oldest_age_days
FROM receipts
WHERE response IS NOT NULL
GROUP BY 2
ORDER BY 2;

-- [L10] Judgements of an already judged revision, per day over the last 30 days.
-- Measures: analyses written each day, and how many of them judge an article revision that already had an analysis
--   (copy rewrites, retries, regrades).
-- Decides: how often names would be rendered again for one revision, which is why names are frozen per revision.
-- Columns: measure, day, analyses, same_revision_again
SELECT 'L10' AS measure,
  (r.created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
  count(*)::int AS analyses,
  count(*) FILTER (
    WHERE EXISTS (SELECT 1 FROM analyses o WHERE o.article_id = r.article_id AND o.input_revision = r.input_revision AND o.id < r.id)
  )::int AS same_revision_again
FROM analyses r
WHERE r.created_at >= now() - interval '30 days'
GROUP BY 2
ORDER BY 2 DESC;
