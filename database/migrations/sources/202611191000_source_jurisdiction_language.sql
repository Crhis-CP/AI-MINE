-- Where a source publishes from and in which language are properties of the source, kept with it. Until now the
-- policy line read both from a catalogue file in the repository at run time (industry/policy-sources.json), so the
-- running system could not start without that file and the database was not the whole truth about its sources.
--   jurisdiction: a code of the jurisdictions dictionary (AR, CN-XJ, EU …); null when not recorded.
--   language: the language the source mainly publishes in, as the catalogue wrote it (es, zh-CN, sr-Cyrl …); it
--   cannot be derived from the jurisdiction (Canada publishes in English and French).
ALTER TABLE public.sources ADD COLUMN jurisdiction text;
ALTER TABLE public.sources ADD COLUMN language text;
-- Policy sources were created with their jurisdiction as their only tag (scripts/seed.ts).
UPDATE public.sources SET jurisdiction = tags[1]
 WHERE lane = 'policy' AND tags[2] IS NULL AND tags[1] ~ '^[A-Z]{2}(-[A-Z0-9]{1,8})?$';
-- Their language, as the catalogue recorded it on 2026-11-19, so that the release needs no manual step: from here on
-- the database row is what the publication step reads. Sources this installation does not have are simply not matched.
UPDATE public.sources s SET language = v.language
  FROM (VALUES
  ('policy-ar-001','es'), ('policy-ar-002','es'), ('policy-ar-003','es'), ('policy-ar-004','es'),
  ('policy-ar-005','es'), ('policy-ar-006','es'), ('policy-ar-007','es'), ('policy-ar-008','es'),
  ('policy-ar-009','es'), ('policy-ar-010','es'), ('policy-ar-011','es'), ('policy-ar-p01','es'),
  ('policy-au-001','en'), ('policy-au-002','en'), ('policy-au-003','en'), ('policy-au-004','en'),
  ('policy-au-005','en'), ('policy-au-006','en'), ('policy-au-007','en'), ('policy-au-008','en'),
  ('policy-au-009','en'), ('policy-au-010','en'), ('policy-au-011','en'), ('policy-au-012','en'),
  ('policy-bo-001','es'), ('policy-bo-002','es'), ('policy-bo-003','es'), ('policy-ca-001','en'),
  ('policy-ca-002','en'), ('policy-ca-003','en'), ('policy-ca-004','en'), ('policy-ca-005','fr'),
  ('policy-ca-006','en'), ('policy-ca-007','fr'), ('policy-ca-008','en'), ('policy-ca-009','en'),
  ('policy-cd-001','fr'), ('policy-cd-002','fr'), ('policy-cd-003','fr'), ('policy-cd-004','fr'),
  ('policy-ch-001','de'), ('policy-ch-002','de'), ('policy-ch-003','de'), ('policy-cl-001','es'),
  ('policy-cl-002','es'), ('policy-cl-003','es'), ('policy-cn-001','zh-CN'), ('policy-cn-002','zh-CN'),
  ('policy-cn-003','zh-CN'), ('policy-cn-004','zh-CN'), ('policy-cn-005','zh-CN'), ('policy-cn-006','zh-CN'),
  ('policy-cn-007','zh-CN'), ('policy-cn-008','zh-CN'), ('policy-cn-009','zh-CN'), ('policy-cn-010','zh-CN'),
  ('policy-cn-p01','zh-CN'), ('policy-co-001','es'), ('policy-co-002','es'), ('policy-co-003','es'),
  ('policy-co-004','es'), ('policy-ec-001','es'), ('policy-ec-002','es'), ('policy-ec-003','es'),
  ('policy-ec-004','es'), ('policy-er-001','en'), ('policy-eu-001','en'), ('policy-eu-002','en'),
  ('policy-eu-003','en'), ('policy-gb-001','en'), ('policy-gb-002','en'), ('policy-gh-001','en'),
  ('policy-gh-002','en'), ('policy-gh-003','en'), ('policy-gh-004','en'), ('policy-gh-005','en'),
  ('policy-gh-006','en'), ('policy-gy-001','en'), ('policy-gy-002','en'), ('policy-gy-003','en'),
  ('policy-id-001','id'), ('policy-id-002','id'), ('policy-id-003','id'), ('policy-id-004','id'),
  ('policy-ir-001','fa'), ('policy-ir-002','fa'), ('policy-ir-003','fa'), ('policy-kg-001','ru'),
  ('policy-kg-002','ru'), ('policy-kg-003','ru'), ('policy-kz-001','ru (also kk)'), ('policy-kz-002','ru (also kk)'),
  ('policy-kz-003','ru'), ('policy-ml-001','fr'), ('policy-ml-002','fr'), ('policy-ml-003','fr'),
  ('policy-mn-001','mn'), ('policy-mn-002','mn'), ('policy-mn-003','mn'), ('policy-mz-001','pt'),
  ('policy-mz-002','pt'), ('policy-mz-003','pt'), ('policy-pe-001','es'), ('policy-pe-002','es'),
  ('policy-pe-003','es'), ('policy-pe-004','es'), ('policy-rs-001','sr-Cyrl'), ('policy-rs-002','sr-Cyrl'),
  ('policy-rs-003','sr-Cyrl'), ('policy-rs-004','sr-Latn'), ('policy-ru-001','ru'), ('policy-ru-002','ru'),
  ('policy-ru-003','ru'), ('policy-ru-004','ru'), ('policy-sg-001','en'), ('policy-sg-002','en'),
  ('policy-sg-003','en'), ('policy-sr-001','nl'), ('policy-sr-002','nl'), ('policy-sr-003','nl'),
  ('policy-tj-001','tg (also ru)'), ('policy-tj-002','tg'), ('policy-tj-003','ru'), ('policy-tz-001','en'),
  ('policy-tz-002','en'), ('policy-tz-003','en'), ('policy-tz-004','en'), ('policy-tz-005','en'),
  ('policy-tz-006','en'), ('policy-us-001','en'), ('policy-us-002','en'), ('policy-us-003','en'),
  ('policy-us-004','en'), ('policy-us-005','en'), ('policy-us-006','en'), ('policy-us-007','en'),
  ('policy-us-008','en'), ('policy-us-009','en'), ('policy-us-010','en'), ('policy-us-011','en'),
  ('policy-uz-001','ru'), ('policy-uz-002','ru'), ('policy-uz-003','ru'), ('policy-ve-001','es'),
  ('policy-ve-002','es'), ('policy-ve-003','es'), ('policy-za-001','en'), ('policy-za-002','en'),
  ('policy-za-003','en'), ('policy-za-004','en'), ('policy-za-005','en'), ('policy-zm-001','en'),
  ('policy-zm-002','en'), ('policy-zm-003','en'), ('policy-zm-004','en'), ('policy-zw-001','en'),
  ('policy-zw-002','en'), ('policy-zw-003','en')
  ) AS v(id, language)
 WHERE s.id = v.id AND s.language IS NULL;
