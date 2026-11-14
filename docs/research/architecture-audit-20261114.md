# 全架构审查 2026-11-14：发现清单（英文工作笔记）

Owner 2026-11-14（原话）：“做一个全架构的审，每一个环节、每一个代码事无巨细的、全方面的……保证质量的情况下优化成本。”五个只读审查代理分别看了模型调用链、采集与信源、读者读取路径与网页、法规线、发布运维与检查流程，读的是 main d6d455a / cef6936。下列编号（C 采集、P 法规、O 运维、M 模型、R 读取）供任务卡引用；“inferred”表示由代码推断、需要线上数字确认。已在 TASK-0658～0666、0680～0709 登记的问题不重复列出。第一批任务卡：TASK-0677～0679、TASK-0710～0716。

## Collection & sources (agent report received)
- C1 Silent sources: `found` counted before filters; fetch_runs keeps only found/new; undated items stored as backfill never public; no alert. → funnel counts per run + all_filtered/undated_only/unchanged states + grouped daily alert. S. (main cause of 174 quiet)
- C2 One bad item (out-of-scope host, blocked detail page) fails the whole run. → skip item, record out_of_scope host. S–M.
- C3 body_unreadable: extract returns null without reason (Readability <200 chars vs 20-char rule; non-200; non-HTML; scan PDF; swallowed errors; Jina w/o key → retries). Re-reads deterministic. → persist failure class; reread only transient; same hash → fail now; per-family fixes (short bodies, attachment links, wp-json, excerpt fallback og:description). M.
- C4 News web/json lists never conditional GET (policy only); unchanged items re-upserted every run (~600k no-op tx/day at 1000 sources). → enable conditional for news, listing hash skip, skip unchanged upserts, throttle "seen". S–M.
- C5 adaptIntervals forces 15–60 min, quiet sources polled hourly, ignores catalogue 180/360 and manual. (TASK-0609 pinned flag now merged — check) → quiet 180–720. S.
- C6 Every crawl body stored as bytea then deleted. → persist only when deferred. S–M.
- C7 3–6 policy evaluations per request. → memoize per session by permission_version. S.
- C8 Each pacing hop restarts collect + new fetch_runs row. S.
- C9 Bodies fetched for every web_list item before relevance. → title/lexicon gate for general sources. M (size with BLOCK rates).
- C10 Same URL across sources = separate articles + analyses. S–M.
- C11 No adapter families (275 distinct selectors / 318 web_list; 116 of 137 RSS are WordPress; 137 gov.cn hosts). → families: rss, wordpress(wp-json), gov-cn-cms, json, generic-html generator. M–L.
- C12 Onboarding ceremony; seed never updates prod; two sources of truth. → DB as truth, export catalogue, bulk manifest + Tier-0 probe + batch preview auto-accept. M.
- C13 No auto repair/park/grouped alert; no error classes. M.
- C14 createSource defaults allow store_fulltext/external_model; intake sets site_fulltext true (per 11-07 DEC) vs "metadata-only default" ruling → needs consistent default. S.
- C15 minor: findJobs per source per minute; crawl_hosts min interval overwritten by latest caller; detail w/o maxFetches.

## Regulation line (agent report received)
- P1 **Blocker**: 10 of 11 pilot profiles have attachmentSelector null → catalogue never closed → every doc stops at needs_manual. No translation/interpretation/reading possible in prod. → profile field `attachments: "none" | {...}` + annex-mention pattern. S. HIGHEST.
- P2 Completeness all-or-nothing; completeness hard-coded "complete"; interpretation waits for full translation though it reads original. → plan over readable subset + coverage; basis full/partial/official_summary/none. M–L (= TASK-0663/0675 core).
- P3 Every text-layer PDF treated as scan; pdf.js items as nodes break linkage; vision sends each page ~6 times. → assemble lines in code, accept text layer; vision only for no-text pages, single image. M.
- P4 Any prompt/recipe edit re-crawls corpus + full re-interpretation (TASK-0663 prompt edits would trigger this). → separate verify recipe; allow older recipe as basis; no auto-reprocess on prompt change. S–M. MUST land before 0663 prompt edits.
- P5 One invalid detail rejects a whole paid reply, then stuck forever. → salvage, normalise whitespace, one repair call, scale maxTokens, relevant-needs-impact only on final. M.
- P6 Summary unlinked; number matching misses es/en/pt month names → extra verify calls; one veto fails doc. → number-word normalisation; summary as sentences with evidence_ids, drop failing sentences. S–M.
- P7 Same instrument from several sources not deduplicated (AR-001 no number selector). → canonical key jurisdiction+kind+number+year, aliases. M.
- P8 Transient provider errors wait recheck interval (up to 7 days). → 15–60 min backoff. S.
- P9 Translation batches tiny (2 KB / 12 parts), hash echo. → 8–12 KB batches, short refs; 4–6x fewer calls. S.
- P10 Long docs silently truncated (16 points/12 impacts) yet "complete"; so_far grows past 26 KB limit. M.
- P11 Rule-based relationship evidence never attached to blocks; dangling ids. → one evidence registry per edition. S.
- P12 State model complex; processingNotice in content hash makes new editions. M, not urgent.
- P13 Peak windows hard-coded DeepSeek for all models; burst release. **Verify DeepSeek pricing page.** S.
- P14 TASK-0664 needs: gate outcome `upcoming`, consultation dates/channel extracted by code, draft→final lineage table. M.
- P15 Chinese originals show no text unless model stages on (free run gated). → build free original reading in structure step. S.
- Design for 0663: one anchor space block:<edition>:<partId>; basis by code; coverage; null/[] normalisation of filler; PolicyReviewLinkage separate DTO + nullable jsonb column; audit script.

## Ops / release / CI (agent report received)
- O1 Cleanup depends on manual "quality accepted" file → disk only grows; stage dirs, bundles, failed attempts never cleaned. → cleanup as step of successful release. S–M. free.
- O2 Single app layer (Dockerfile COPY . . before build; final one layer) → full image every release. → layer restructure + send only missing layers (unregistry/localhost registry). M. free (TCR optional).
- O3 Release backups duplicate image + daily backup (per-role program tars, dump after drain). → drop program tars; dump only with migrations, before drain, into single slot. S–M.
- O4 Verify 25 min sequential, test concurrency 2, no npm cache, npm ci twice, compose-smoke uncached. → parallel jobs/shards, caches → 6–8 min. M.
- O5 Card-only PRs run full 25 min (56/119 commits). → docs/cards fast lane; affected tests for code PRs; full on batch & main. M.
- O6 Plan-PR-first rule doubles PRs. → allow card in same PR within lane paths; batch rule written. S.
- O7 Local backup mode: backup.stale always fires, backup.failed never. S. (alerts broken)
- O8 Backup/release collision; killed backup leaks .partial. S.
- O9 Load gate 2.5 not in repo; disk estimate pessimistic; three floors (4 GiB code / 8 GB brief / 3 GB owner). → no load gate; disk = missing layers + 512 MB (+dump if migrations); one floor. S.
- O10 No memory limits, no heap caps, Postgres defaults (128 MB shared_buffers). → limits from measured sets. S.
- O11 Disk/memory/OOM/Postgres-down/release failure alert nobody. → host timer → Feishu; Tencent basic monitoring. S–M.
- O12 receipts request/response jsonb kept forever (0.5–2 GB/month inferred). → measure, retention design sooner than 2027. M.
- O13 Backups same disk, plaintext; .env copied into each restore point; all roles get all secrets. → COS needs money (owner). M.
- O14 Main re-runs full verify on identical tree. → reuse receipt, build/pack only. M.
- O15 data-ownership 139 s even in quick check. → cache by digests. S.

## Model pipeline (agent report received)
- M1 Translation quota rule keyed on rolling-24h half → 27 h median delay; self-feeding burst. (TASK-0676 in progress: fresh exempt, backlog share 0.75.) Further: purpose-level quota for translation; backlog newest-first, reader-opened first.
- M2 Translation = one request per paragraph/li/tr (~20 requests per article; ~1,800/day). → pack blocks up to 4 KB per request as array, validate per block. 4–6x fewer requests. M. Must ship with M3.
- M3 Any edit to translate prompt or shared names list hides every published translation (recipe hash) and re-buys. → readability by source hash/revision/manifest, not prompt hash. S.
- M4 Shared system prompt hash ties every step's version → any prompt edit (even dictionary, names) turns OFF production scoring (no 精选) until SELECTION_CONFIRMED_VERSION re-entered. → gate on score-standard hash only. S. HIGH reader impact; relevant to TASK-0670 switch.
- M5 Grouping is largest uncached input (~50k chars) and follow-ups re-send query under different system prompts. → shared prefix for relation calls; candidate lead window 3k; eval with 370 labelled pairs. M. Needs spend-by-purpose first.
- M6 Second score fires for first score 47–81, incl. items capped at 55. → measure flip bands from stored scores, narrow. S (scoring rule → measure first).
- M7 Digest refresh on every grouped report incl. no-value reposts; refresh deferred to off-peak = Beijing working hours → stale digests when read. → skip no-value reposts, 10-min debounce, exempt hot/selected stories. S.
- M8 Structure runs on items that score <20 (never grouped/browsed). → start after score-1, skip <20. S.
- M9 Off-peak windows hard-coded DeepSeek for every route. → per-service rate_windows from ai.usage_prices. S. (also P13; verify pricing page)
- M10 English copy separate call (owner choice, TASK-0595 design). skip.
- M11 Output caps far above need (understand 16k; GLM scorer 65k reasoning). S.
- M12 Admin re-evaluation re-pays every step → "rewrite copy only" option. S.
- Key unknown: who fills >10k requests/24h (translation only ~1,800/day) → spend & requests by purpose.

## Read path / web (agent report received)
- R1 Every first page load runs loaders twice (ContentVersionGuard revalidates unconditionally). → seed watermark in HTML, revalidate on mismatch only. −50% read load. S. Prerequisite for 30 s cache.
- R2 Reading-group lists recomputed from whole corpus per request (~26k rows) for /all, country, topic, HomeCountry, home. → step 1 trim joins/ids; step 2 worker projection keyset LIMIT 21. M/L. Likely biggest DB cost.
- R3 v3 events/hot fan out to full item details (~1000 item builds per /api/v3/hot). → card vs detail split, batch builders, parallel. M.
- R4 Story page rebuilds 8 related stories fully for a title (~64 queries). → batched safe-title read. S–M.
- R5 Hot ranking re-validated on every read, several times per request; N+1 withdrawal check. → compute once per request; validated cache keyed by ranking id + versions + 30 s bucket (needs TASK-0701 principle restated). S/M.
- R6 /api/site/jurisdictions full scans uncached on every filtered page. → static labels, 60 s aggregate counts; topic loader static lookup. S.
- R7 app.css 2772 lines global; regulation + About ≈55%; admin and reader share. → per-route CSS. S–M.
- R8 JS: framework 344 KB + shared 334 KB raw on every page; no byte budget. → budget test, lazy SearchOverlay, narrow shared chunk. M.
- R9 Item read ~10 serial round trips, over-wide eventCoverage. → Promise.all, narrow columns. S.
- R10 Double zod validation + double stringify per list response. S.
- R11 Facets/counts computed for callers that don't show them; hot strip on every /all page. S.
- R12 Topic loader wasted & serial reads. S.
- R13 30 s HTML cache prerequisites: .data stays no-store; degraded 200s no-store (ICP filing footer!); exclude /all?q=; releaseBoundCache; CSP nonce shared → hash sources. (feeds TASK-0672)
- R14 Tests: 20 browser files each spawn server+Chromium; backend concurrency 2; 191 files <2 s mostly setup. → shared harness, concurrency 4, unit files in one process. M.
- R15 Hot entries may drop for ≤5 min between runs (hash window mismatch). check. S.
- Simplify: delete legacy non-readingGroups branches (~250 lines); dead code releaseBoundCache/documentHeaders/X-Accel; unify raw fetch in story/agent; v3 batch readers.
