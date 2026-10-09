-- Synthetic PR9 material only. Run as fixture owner inside one transaction; never call models.
CREATE TEMP TABLE pr9_cases ON COMMIT DROP AS
SELECT 'pr9-'||mode||'-'||visibility||'-'||body AS id, 'pr9-'||mode AS source_id, mode, visibility, body,
       mode='editorial' AS eligible, mode='editorial' AND visibility='public' AS selected
FROM unnest(ARRAY['editorial','hot_signal','isolated']) mode
CROSS JOIN unnest(ARRAY['public','summary-only','withdrawn']) visibility
CROSS JOIN unnest(ARRAY['full','summary']) body;
INSERT INTO pr9_cases VALUES
('pr9-second-report','pr9-editorial-2','editorial','public','full',true,true),
('pr9-no-license','pr9-no-license','editorial','public','summary',true,false),
('pr9-low-relevance','pr9-editorial','editorial','public','full',false,false),
('pr9-future','pr9-editorial','editorial','public','full',true,true);

INSERT INTO sources (id,name,kind,config,participation_mode,enabled,site_fulltext,syndicate_fulltext,last_ok_at,interval_minutes)
SELECT source_id,'PR9 source '||source_id,'rss','{}',min(mode),true,source_id<>'pr9-no-license',true,now(),30
FROM pr9_cases GROUP BY source_id;
INSERT INTO articles (id,source_id,identity_key,url,title,author,language,published_at,discovered_at,timeline_at,body_text,body_html,body_status,raw)
SELECT id,source_id,id,'https://source.example.test/'||id,'PR9 原稿 '||id,'PR9 fixture author',
       CASE WHEN id='pr9-second-report' THEN 'zh' ELSE 'en' END,
       now()-interval '2 hours',now()-interval '2 hours',now()-interval '2 hours',
       'ORIGINAL_BODY_'||id,'<h2>PR9 original</h2><p>ORIGINAL_BODY_'||id||'</p>','ok','{"private_fixture":true}'
FROM pr9_cases;
INSERT INTO articles (id,source_id,identity_key,url,title,language,discovered_at,timeline_at,body_html,body_text,body_status)
VALUES ('pr9-candidate','pr9-editorial','pr9-candidate','https://source.example.test/candidate','PR9 candidate','en',now(),now(),'<p>CANDIDATE_PRIVATE_BODY</p>','CANDIDATE_PRIVATE_BODY','ok');
INSERT INTO translations (article_id,lang,revision,title,body_html,body_text,complete,origin)
SELECT id,'zh',1,'PR9 译文 '||id,'<h2>合成译文</h2><p>合成中文 TRANSLATED_BODY_'||id||'</p>','TRANSLATED_BODY_'||id,true,'replay'
FROM articles WHERE id LIKE 'pr9-%';
-- SELF_AUTHORED stored-read snapshot, not gateway/translation acceptance evidence.
-- The recipe is filled in when the fixture loads (tests/public-role-fixture.ts: the current translation recipe), so a
-- prompt change needs no edit here; only a change of the manifest 'format' below needs this fixture updated by hand.
UPDATE translations tr SET recipe='__TRANSLATION_RECIPE__',
  source_hash=encode(sha256(convert_to(a.body_html,'UTF8')),'hex'),
  manifest=jsonb_build_object('format','strict-text-context-v2','revision',1,'recipe','__TRANSLATION_RECIPE__',
    'sourceHash',encode(sha256(convert_to(a.body_html,'UTF8')),'hex'),'bodyHash',encode(sha256(convert_to(tr.body_html,'UTF8')),'hex'),
    'replacements','[]'::jsonb,
    'segments',jsonb_build_array(
      jsonb_build_object('index',0,'unitIndex',0,'textLength',char_length('合成译文'),
        'referenceHash',encode(sha256(convert_to('','UTF8')),'hex'),'sourceHash',encode(sha256(convert_to('PR9 original','UTF8')),'hex'),
        'responseHash',encode(sha256(convert_to('合成译文','UTF8')),'hex'),'textHash',encode(sha256(convert_to('合成译文','UTF8')),'hex')),
      jsonb_build_object('index',1,'unitIndex',1,'textLength',char_length('合成中文 TRANSLATED_BODY_'||a.id),
        'referenceHash',encode(sha256(convert_to('PR9 original','UTF8')),'hex'),'sourceHash',encode(sha256(convert_to('ORIGINAL_BODY_'||a.id,'UTF8')),'hex'),
        'responseHash',encode(sha256(convert_to('合成中文 TRANSLATED_BODY_'||a.id,'UTF8')),'hex'),
        'textHash',encode(sha256(convert_to('合成中文 TRANSLATED_BODY_'||a.id,'UTF8')),'hex'))))
FROM articles a WHERE tr.article_id=a.id AND a.id IN (SELECT id FROM pr9_cases);
INSERT INTO publications (article_id,title,original_title,summary,reason,category,tags,score,source_id,channel,url,
                         published_at,discovered_at,timeline_at,sort_at,visibility,eligible,selected,visible_after,body_mode,syndicate,indexable,first_party)
SELECT id,'PR9 已发布 '||id,'PR9 原稿 '||id,'PR9 synthetic summary '||id,'PR9 fixture selection','company_project',ARRAY['PR9','行业动态'],82,
       source_id,'news','https://source.example.test/'||id,now()-interval '2 hours',now()-interval '2 hours',now()-interval '2 hours',now()-interval '2 hours',
       visibility,eligible,selected,CASE WHEN id='pr9-future' THEN now()+interval '1 hour' ELSE now()-interval '1 hour' END,
       body,body='full',visibility='public' AND mode='editorial' AND eligible,source_id='pr9-editorial'
FROM pr9_cases;
UPDATE publications SET search_text=lower(title||' '||summary);
INSERT INTO pool_search (article_id,direct,body)
SELECT id,'pr9 direct '||id,CASE WHEN id='pr9-editorial-public-full' THEN 'uniquebodyneedle pr9 body-only match' ELSE '' END
FROM pr9_cases WHERE eligible;
INSERT INTO settings(key,value) VALUES ('pr9-private-setting','{"private_fixture":true}');

INSERT INTO stories (id,public_id,title,summary,digest,latest,first_report_at,latest_at,origin)
VALUES (9101,'11111111-1111-4111-8111-111111111111','PR9 主线事件','PR9 event summary','PR9 event digest','PR9 new development',now()-interval '3 hours',now()-interval '15 minutes','manual'),
       (9102,'22222222-2222-4222-8222-222222222222','PR9 关联事件','PR9 related summary','PR9 related digest','PR9 related development',now()-interval '4 hours',now()-interval '30 minutes','manual');
INSERT INTO story_aliases(public_id,story_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',9101);
INSERT INTO story_links(story_id,other_id,relation) VALUES (9101,9102,'related');
INSERT INTO facts(id,public_id,story_id,title,occurred_at)
VALUES (9101,'pr9-fact-1',9101,'PR9 首个事实',now()-interval '2 hours'),
       (9102,'pr9-fact-2',9101,'PR9 后续事实',now()-interval '1 hour'),
       (9103,'pr9-fact-3',9102,'PR9 关联事实',now()-interval '2 hours');
INSERT INTO fact_articles(fact_id,article_id,role) VALUES
(9101,'pr9-editorial-public-full','primary'),(9101,'pr9-second-report','report'),
(9102,'pr9-editorial-public-summary','primary'),(9103,'pr9-no-license','primary');
UPDATE publications SET fact_id=9101,story_id=9101 WHERE article_id IN ('pr9-editorial-public-full','pr9-second-report');
UPDATE publications SET fact_id=9102,story_id=9101,sort_at=now()-interval '1 hour' WHERE article_id='pr9-editorial-public-summary';
UPDATE publications SET fact_id=9103,story_id=9102 WHERE article_id='pr9-no-license';
INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at)
SELECT 9101,id,source_id,source_id,CASE WHEN mode='editorial' THEN 'editorial' ELSE 'signal' END,now()-interval '2 hours'
FROM pr9_cases WHERE id IN ('pr9-editorial-public-full','pr9-second-report','pr9-hot_signal-public-full');
INSERT INTO story_heat_hourly(story_id,hour,heat,participants,complete)
VALUES (9101,date_trunc('hour',now())-interval '1 hour',5,2,true),(9101,date_trunc('hour',now()),8,3,true);
INSERT INTO hot_rankings(computed_at,rule_version,entries,evidence,published)
VALUES (now(),'pr9-synthetic-rule',jsonb_build_array(jsonb_build_object(
 'rank',1,'storyId',9101,'storyPublicId','11111111-1111-4111-8111-111111111111','title','PR9 主线事件','heat',8,
 'trend','up','trendPct',10,'badges',jsonb_build_array('rising'),'participantCount',3,'sourceCount',3,'signalCount',1,'reportCount',2,
 'sourceNames',jsonb_build_array('PR9 source pr9-editorial','PR9 source pr9-editorial-2'),'latestAt',now()-interval '15 minutes','firstReportAt',now()-interval '3 hours',
 'representativeItemId','pr9-editorial-public-full','representativeUrl','https://source.example.test/pr9-editorial-public-full','representativeSource','PR9 source pr9-editorial',
 'participants',jsonb_build_array(jsonb_build_object('name','PR9 source pr9-editorial','kind','editorial','tier','T1'))
)), '{"fixture":true}',true);
INSERT INTO topics(slug,name,grp,tags,definition,position)
VALUES ('pr9-mining','PR9 合成专题','field',ARRAY['PR9'],'PR9 topic fixture',1);

CREATE TEMP TABLE pr9_citations ON COMMIT DROP AS
SELECT jsonb_build_object('itemId',article_id,'title',title,'summary','PR9 citation summary '||article_id,
                          'sourceName','PR9 cited source','sourceUrl',url,'sourceId',source_id) AS citation
FROM publications WHERE article_id IN ('pr9-editorial-public-full','pr9-editorial-withdrawn-full');
INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
SELECT kind,key,now()-interval '2 days',now()-interval '1 day',
 CASE WHEN kind='daily' THEN jsonb_build_object(
   'lead',jsonb_build_object('title','PR9 日报导读','leadParagraph','PR9 synthetic daily lead'),
   'sections',jsonb_build_array(jsonb_build_object('label','PR9 行业','items',(SELECT jsonb_agg(citation) FROM pr9_citations))), 'flashes','[]'::jsonb)
 ELSE jsonb_build_object('title','PR9 周期报告','headline','PR9 周期主线','overview','PR9 synthetic overview',
   'themes',jsonb_build_array(jsonb_build_object('heading','PR9 主题','summary','PR9 theme summary','storyRefs',(SELECT jsonb_agg(citation) FROM pr9_citations)))) END,
 now()-interval '10 minutes','manual'
FROM (
 SELECT 'daily' AS kind,to_char((now() AT TIME ZONE 'Asia/Shanghai')::date-d,'YYYY-MM-DD') AS key FROM generate_series(0,2) d
 UNION ALL SELECT 'weekly',to_char((now() AT TIME ZONE 'Asia/Shanghai') - d*interval '1 week','IYYY-"W"IW') FROM generate_series(0,1) d
 UNION ALL SELECT 'monthly',to_char((now() AT TIME ZONE 'Asia/Shanghai') - d*interval '1 month','YYYY-MM') FROM generate_series(0,1) d
) periods;

INSERT INTO selected_ledger(seq,article_id,op,visible_at,payload)
SELECT seq,id,op,CASE WHEN seq=4 THEN now()+interval '1 hour' ELSE now()-interval '1 hour' END,
 CASE WHEN op='remove' THEN NULL ELSE jsonb_build_object('id',id,'title','PR9 ledger '||id,'source',jsonb_build_object('name','PR9 source'),
 'publishedAt',now()-interval '2 hours','discoveredAt',now()-interval '2 hours','category','industry','score',82,'selected',true,'summary','PR9 ledger fixture',
 'links',jsonb_build_object('original','https://source.example.test/'||id),'attribution',jsonb_build_object('name','PR9 fixture','url','https://public-fixture.example.test/items/'||id)) END
FROM (VALUES (1,'pr9-editorial-public-full','upsert'),(2,'pr9-second-report','upsert'),(3,'pr9-editorial-withdrawn-full','remove'),(4,'pr9-future','upsert')) entries(seq,id,op);
INSERT INTO selected_state(article_id,in_set,last_seq)
SELECT article_id,op='upsert',seq FROM selected_ledger;

-- Synthetic site-only prices; never evidence for current market conditions.
INSERT INTO publication.metal_prices(series_key,source,name_zh,benchmark,currency,unit,source_unit,period_type,period_start,period_end,period_label,value,release_label,release_url,released_on,first_fetched_at,fetched_at) VALUES
('nbs.copper','nbs','合成铜','synthetic','CNY','元/吨','吨','ten_day','2026-09-11','2026-09-20','合成价格期',110000.0,'Synthetic release','https://www.stats.gov.cn/synthetic-price','2026-09-21',now(),now()),
('nbs.aluminum','nbs','合成铝','synthetic','CNY','元/吨','吨','ten_day','2026-09-11','2026-09-20','合成价格期',24000.0,'Synthetic release','https://www.stats.gov.cn/synthetic-price','2026-09-21',now(),now());
