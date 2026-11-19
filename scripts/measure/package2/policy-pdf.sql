-- Package 2 measurements, part N: how much text the archived policy PDFs carry per page, to fix the threshold at which
-- a page counts as a text page rather than a scan. Read-only: every statement is a single SELECT (or WITH ... SELECT);
-- tests/measure-sql.test.ts holds every file to that and runs each statement inside a READ ONLY transaction on a
-- migrated test database. How to run it on production and what to send back: docs/runbooks/package2-measurements.md.
-- Output is counts and distributions only.
--
-- The page text comes from the text layer the current parser already stored (policy.document_extractions, the newest
-- extraction of each revision): one node per text item with its page number, and a gap "第 N 页无可核验文字层" for a
-- page whose text layer is empty. Nothing is parsed or rendered here. A PDF whose extraction stopped at a capacity
-- limit or failed to parse keeps only some of its pages, or none: past the text-size cap its nodes are dropped but its
-- per-page gaps stay, and a parse failure keeps the pages read before it. Counting those would add them as scans, so N1
-- and N2 skip them and N0 counts them.

-- [N0] Archived policy originals by kind, and how many have a stored extraction.
-- Measures: original resources whose bytes start with %PDF-, HTML or XML (by the first bytes), other, or missing; their
--   sizes; how many of their revisions have a stored extraction, and how many PDFs ended in a capacity limit or a parse
--   failure.
-- Decides: how much of the PDF archive N1 and N2 cover, and whether the page and byte caps of the PDF reader fit.
-- Columns: measure, kind, resources, revisions, with_extraction, median_bytes, largest_bytes, capacity_or_unparsed
WITH latest AS (
  SELECT DISTINCT ON (revision_id) revision_id, result
  FROM policy.document_extractions
  ORDER BY revision_id, created_at DESC
), resources AS (
  SELECT o.revision_id, o.ordinal,
    CASE
      WHEN o.body IS NULL THEN 'missing'
      WHEN substring(o.body FROM 1 FOR 5) = '\x255044462d'::bytea THEN 'pdf'
      WHEN lower(encode(substring(o.body FROM 1 FOR 256), 'escape')) ~ '^(\\357\\273\\277)?\s*<' THEN 'html_or_xml'
      ELSE 'other'
    END AS kind,
    octet_length(o.body) AS bytes,
    l.revision_id IS NOT NULL AS extracted,
    coalesce((l.result->'resources'->o.ordinal->>'state') = 'blocked_capacity'
      OR (l.result->'resources'->o.ordinal->'gaps') ? 'PDF 无法完整解析', false) AS capacity_or_unparsed
  FROM policy.original_resources o
  LEFT JOIN latest l ON l.revision_id = o.revision_id
)
SELECT 'N0' AS measure,
  kind,
  count(*)::int AS resources,
  count(DISTINCT revision_id)::int AS revisions,
  count(*) FILTER (WHERE extracted)::int AS with_extraction,
  (percentile_cont(0.5) WITHIN GROUP (ORDER BY bytes))::bigint AS median_bytes,
  max(bytes)::bigint AS largest_bytes,
  count(*) FILTER (WHERE kind = 'pdf' AND capacity_or_unparsed)::int AS capacity_or_unparsed
FROM resources
GROUP BY 2
ORDER BY 3 DESC, 2;

-- [N1] PDF pages by the number of visible characters on their text layer.
-- Measures: every page of every fully read PDF resource in the newest extraction of each revision (N0 counts the rest),
--   banded by its characters other than white space; how many of those pages hold a replacement character (U+FFFD, a
--   broken font map) and how many paint an image (a seal or letterhead, or a scanned page under a thin text layer).
-- Decides: the text threshold of the PDF page classifier (20 characters is a guess): a page is "text" at or above it
--   with no replacement character, otherwise a scan for a person.
-- Columns: measure, chars_band, pages, with_replacement_char, with_image, documents
WITH latest AS (
  SELECT DISTINCT ON (revision_id) revision_id, result
  FROM policy.document_extractions
  ORDER BY revision_id, created_at DESC
), resources AS (
  SELECT l.revision_id, r.ordinality AS resource_no, r.value AS resource
  FROM latest l
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.result->'resources') = 'array' THEN l.result->'resources' ELSE '[]'::jsonb END)
    WITH ORDINALITY AS r(value, ordinality)
  WHERE r.value->>'state' IS DISTINCT FROM 'blocked_capacity'
    AND NOT coalesce((r.value->'gaps') ? 'PDF 无法完整解析', false)
), text_pages AS (
  SELECT x.revision_id, x.resource_no, (n.value->>'page')::int AS page,
    sum(length(regexp_replace(coalesce(n.value->>'text', ''), '\s', '', 'g'))) AS chars,
    sum(length(coalesce(n.value->>'text', '')) - length(replace(coalesce(n.value->>'text', ''), chr(65533), ''))) AS replacement_chars
  FROM resources x
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x.resource->'nodes') = 'array' THEN x.resource->'nodes' ELSE '[]'::jsonb END) n
  WHERE jsonb_typeof(n.value->'page') = 'number'
  GROUP BY 1, 2, 3
), gap_pages AS (
  SELECT x.revision_id, x.resource_no, (regexp_match(g.value, '^第 ([0-9]+) 页'))[1]::int AS page,
    bool_or(g.value ~ '^第 [0-9]+ 页无可核验文字层') AS empty_layer,
    bool_or(g.value ~ '^第 [0-9]+ 页含未核验图件') AS image
  FROM resources x
  CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(x.resource->'gaps') = 'array' THEN x.resource->'gaps' ELSE '[]'::jsonb END) g
  WHERE g.value ~ '^第 [0-9]+ 页'
  GROUP BY 1, 2, 3
), pages AS (
  SELECT coalesce(t.revision_id, g.revision_id) AS revision_id,
    coalesce(t.chars, 0) AS chars,
    coalesce(t.replacement_chars, 0) AS replacement_chars,
    coalesce(g.image, false) AS image
  FROM text_pages t
  FULL JOIN gap_pages g ON g.revision_id = t.revision_id AND g.resource_no = t.resource_no AND g.page = t.page
)
SELECT 'N1' AS measure,
  CASE
    WHEN chars = 0 THEN 'a 0'
    WHEN chars < 10 THEN 'b 1-9'
    WHEN chars < 20 THEN 'c 10-19'
    WHEN chars < 50 THEN 'd 20-49'
    WHEN chars < 100 THEN 'e 50-99'
    WHEN chars < 200 THEN 'f 100-199'
    WHEN chars < 500 THEN 'g 200-499'
    ELSE 'h 500+'
  END AS chars_band,
  count(*)::int AS pages,
  count(*) FILTER (WHERE replacement_chars > 0)::int AS with_replacement_char,
  count(*) FILTER (WHERE image)::int AS with_image,
  count(DISTINCT revision_id)::int AS documents
FROM pages
GROUP BY 2
ORDER BY 2;

-- [N2] PDF documents as text, scan or mixed under candidate thresholds.
-- Measures: the pages of N1 grouped per PDF resource; a page is "text" when it has at least the threshold of visible
--   characters and no replacement character; a resource is text (all pages text), scan (none) or mixed.
-- Decides: the same threshold as N1, read as its effect: how many documents would go to a person (scan or mixed pages)
--   at 10, 20, 50 and 100 characters.
-- Columns: measure, threshold, text_documents, scan_documents, mixed_documents, scan_pages
WITH latest AS (
  SELECT DISTINCT ON (revision_id) revision_id, result
  FROM policy.document_extractions
  ORDER BY revision_id, created_at DESC
), resources AS (
  SELECT l.revision_id, r.ordinality AS resource_no, r.value AS resource
  FROM latest l
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.result->'resources') = 'array' THEN l.result->'resources' ELSE '[]'::jsonb END)
    WITH ORDINALITY AS r(value, ordinality)
  WHERE r.value->>'state' IS DISTINCT FROM 'blocked_capacity'
    AND NOT coalesce((r.value->'gaps') ? 'PDF 无法完整解析', false)
), text_pages AS (
  SELECT x.revision_id, x.resource_no, (n.value->>'page')::int AS page,
    sum(length(regexp_replace(coalesce(n.value->>'text', ''), '\s', '', 'g'))) AS chars,
    sum(length(coalesce(n.value->>'text', '')) - length(replace(coalesce(n.value->>'text', ''), chr(65533), ''))) AS replacement_chars
  FROM resources x
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x.resource->'nodes') = 'array' THEN x.resource->'nodes' ELSE '[]'::jsonb END) n
  WHERE jsonb_typeof(n.value->'page') = 'number'
  GROUP BY 1, 2, 3
), gap_pages AS (
  SELECT DISTINCT x.revision_id, x.resource_no, (regexp_match(g.value, '^第 ([0-9]+) 页'))[1]::int AS page
  FROM resources x
  CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(x.resource->'gaps') = 'array' THEN x.resource->'gaps' ELSE '[]'::jsonb END) g
  WHERE g.value ~ '^第 [0-9]+ 页无可核验文字层'
), pages AS (
  SELECT coalesce(t.revision_id, g.revision_id) AS revision_id, coalesce(t.resource_no, g.resource_no) AS resource_no,
    coalesce(t.chars, 0) AS chars, coalesce(t.replacement_chars, 0) AS replacement_chars
  FROM text_pages t
  FULL JOIN gap_pages g ON g.revision_id = t.revision_id AND g.resource_no = t.resource_no AND g.page = t.page
), judged AS (
  SELECT th.threshold, p.revision_id, p.resource_no,
    count(*) FILTER (WHERE p.chars >= th.threshold AND p.replacement_chars = 0) AS text_pages,
    count(*) FILTER (WHERE NOT (p.chars >= th.threshold AND p.replacement_chars = 0)) AS scan_pages
  FROM pages p
  CROSS JOIN (VALUES (10), (20), (50), (100)) AS th(threshold)
  GROUP BY 1, 2, 3
)
SELECT 'N2' AS measure,
  threshold,
  count(*) FILTER (WHERE scan_pages = 0)::int AS text_documents,
  count(*) FILTER (WHERE text_pages = 0)::int AS scan_documents,
  count(*) FILTER (WHERE text_pages > 0 AND scan_pages > 0)::int AS mixed_documents,
  sum(scan_pages)::int AS scan_pages
FROM judged
GROUP BY 2
ORDER BY 2;
