-- Where a source publishes from and in which language are properties of the source, kept with it. Until now the
-- policy line read both from a catalogue file in the repository at run time (industry/policy-sources.json), so the
-- running system could not start without that file and the database was not the whole truth about its sources.
--   jurisdiction: a code of the jurisdictions dictionary (AR, CN-XJ, EU …); null when not recorded.
--   language: the language the source mainly publishes in, as the catalogue wrote it (es, zh-CN, sr-Cyrl …); it
--   cannot be derived from the jurisdiction (Canada publishes in English and French).
ALTER TABLE public.sources ADD COLUMN jurisdiction text;
ALTER TABLE public.sources ADD COLUMN language text;
-- Both values as the catalogue recorded them on 2026-11-19 (its "sources" and "pilot_additions"; the source id is
-- "policy-" plus the entry id in lower case), so that the release needs no manual step and every source keeps exactly
-- the country and language the run-time lookup gave it, which was by id and never by the row's tags (an operator can
-- edit those). Sources this installation does not have are simply not matched. Only a row that has neither value is
-- filled; at this point that is every row.
UPDATE public.sources s SET jurisdiction = v.jurisdiction, language = v.language
  FROM (VALUES
  ('policy-ar-001','AR','es'), ('policy-ar-002','AR','es'), ('policy-ar-003','AR','es'), ('policy-ar-004','AR','es'),
  ('policy-ar-005','AR','es'), ('policy-ar-006','AR','es'), ('policy-ar-007','AR','es'), ('policy-ar-008','AR','es'),
  ('policy-ar-009','AR','es'), ('policy-ar-010','AR','es'), ('policy-ar-011','AR','es'), ('policy-ar-p01','AR','es'),
  ('policy-au-001','AU','en'), ('policy-au-002','AU','en'), ('policy-au-003','AU','en'), ('policy-au-004','AU','en'),
  ('policy-au-005','AU','en'), ('policy-au-006','AU','en'), ('policy-au-007','AU','en'), ('policy-au-008','AU','en'),
  ('policy-au-009','AU','en'), ('policy-au-010','AU','en'), ('policy-au-011','AU','en'), ('policy-au-012','AU','en'),
  ('policy-bo-001','BO','es'), ('policy-bo-002','BO','es'), ('policy-bo-003','BO','es'), ('policy-ca-001','CA','en'),
  ('policy-ca-002','CA','en'), ('policy-ca-003','CA','en'), ('policy-ca-004','CA','en'), ('policy-ca-005','CA','fr'),
  ('policy-ca-006','CA','en'), ('policy-ca-007','CA','fr'), ('policy-ca-008','CA','en'), ('policy-ca-009','CA','en'),
  ('policy-cd-001','CD','fr'), ('policy-cd-002','CD','fr'), ('policy-cd-003','CD','fr'), ('policy-cd-004','CD','fr'),
  ('policy-ch-001','CH','de'), ('policy-ch-002','CH','de'), ('policy-ch-003','CH','de'), ('policy-cl-001','CL','es'),
  ('policy-cl-002','CL','es'), ('policy-cl-003','CL','es'), ('policy-cn-001','CN','zh-CN'), ('policy-cn-002','CN','zh-CN'),
  ('policy-cn-003','CN','zh-CN'), ('policy-cn-004','CN','zh-CN'), ('policy-cn-005','CN','zh-CN'), ('policy-cn-006','CN','zh-CN'),
  ('policy-cn-007','CN','zh-CN'), ('policy-cn-008','CN','zh-CN'), ('policy-cn-009','CN','zh-CN'), ('policy-cn-010','CN','zh-CN'),
  ('policy-cn-p01','CN','zh-CN'), ('policy-co-001','CO','es'), ('policy-co-002','CO','es'), ('policy-co-003','CO','es'),
  ('policy-co-004','CO','es'), ('policy-ec-001','EC','es'), ('policy-ec-002','EC','es'), ('policy-ec-003','EC','es'),
  ('policy-ec-004','EC','es'), ('policy-er-001','ER','en'), ('policy-eu-001','EU','en'), ('policy-eu-002','EU','en'),
  ('policy-eu-003','EU','en'), ('policy-gb-001','GB','en'), ('policy-gb-002','GB','en'), ('policy-gh-001','GH','en'),
  ('policy-gh-002','GH','en'), ('policy-gh-003','GH','en'), ('policy-gh-004','GH','en'), ('policy-gh-005','GH','en'),
  ('policy-gh-006','GH','en'), ('policy-gy-001','GY','en'), ('policy-gy-002','GY','en'), ('policy-gy-003','GY','en'),
  ('policy-id-001','ID','id'), ('policy-id-002','ID','id'), ('policy-id-003','ID','id'), ('policy-id-004','ID','id'),
  ('policy-ir-001','IR','fa'), ('policy-ir-002','IR','fa'), ('policy-ir-003','IR','fa'), ('policy-kg-001','KG','ru'),
  ('policy-kg-002','KG','ru'), ('policy-kg-003','KG','ru'), ('policy-kz-001','KZ','ru (also kk)'), ('policy-kz-002','KZ','ru (also kk)'),
  ('policy-kz-003','KZ','ru'), ('policy-ml-001','ML','fr'), ('policy-ml-002','ML','fr'), ('policy-ml-003','ML','fr'),
  ('policy-mn-001','MN','mn'), ('policy-mn-002','MN','mn'), ('policy-mn-003','MN','mn'), ('policy-mz-001','MZ','pt'),
  ('policy-mz-002','MZ','pt'), ('policy-mz-003','MZ','pt'), ('policy-pe-001','PE','es'), ('policy-pe-002','PE','es'),
  ('policy-pe-003','PE','es'), ('policy-pe-004','PE','es'), ('policy-rs-001','RS','sr-Cyrl'), ('policy-rs-002','RS','sr-Cyrl'),
  ('policy-rs-003','RS','sr-Cyrl'), ('policy-rs-004','RS','sr-Latn'), ('policy-ru-001','RU','ru'), ('policy-ru-002','RU','ru'),
  ('policy-ru-003','RU','ru'), ('policy-ru-004','RU','ru'), ('policy-sg-001','SG','en'), ('policy-sg-002','SG','en'),
  ('policy-sg-003','SG','en'), ('policy-sr-001','SR','nl'), ('policy-sr-002','SR','nl'), ('policy-sr-003','SR','nl'),
  ('policy-tj-001','TJ','tg (also ru)'), ('policy-tj-002','TJ','tg'), ('policy-tj-003','TJ','ru'), ('policy-tz-001','TZ','en'),
  ('policy-tz-002','TZ','en'), ('policy-tz-003','TZ','en'), ('policy-tz-004','TZ','en'), ('policy-tz-005','TZ','en'),
  ('policy-tz-006','TZ','en'), ('policy-us-001','US','en'), ('policy-us-002','US','en'), ('policy-us-003','US','en'),
  ('policy-us-004','US','en'), ('policy-us-005','US','en'), ('policy-us-006','US','en'), ('policy-us-007','US','en'),
  ('policy-us-008','US','en'), ('policy-us-009','US','en'), ('policy-us-010','US','en'), ('policy-us-011','US','en'),
  ('policy-uz-001','UZ','ru'), ('policy-uz-002','UZ','ru'), ('policy-uz-003','UZ','ru'), ('policy-ve-001','VE','es'),
  ('policy-ve-002','VE','es'), ('policy-ve-003','VE','es'), ('policy-za-001','ZA','en'), ('policy-za-002','ZA','en'),
  ('policy-za-003','ZA','en'), ('policy-za-004','ZA','en'), ('policy-za-005','ZA','en'), ('policy-zm-001','ZM','en'),
  ('policy-zm-002','ZM','en'), ('policy-zm-003','ZM','en'), ('policy-zm-004','ZM','en'), ('policy-zw-001','ZW','en'),
  ('policy-zw-002','ZW','en'), ('policy-zw-003','ZW','en')
  ) AS v(id, jurisdiction, language)
 WHERE s.id = v.id AND s.jurisdiction IS NULL AND s.language IS NULL;
