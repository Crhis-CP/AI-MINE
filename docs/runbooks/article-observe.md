# 单篇核对影子（开关 `observe.articles`）

最后核对：2026-11-20。

包二的“单篇核对”先以影子方式运行：每条资讯的判断落库后，worker 在一个单独的队列里（`news.enrichment.observe`，一次一条）做四件事：认出稿件里的公司（公司库）；预演中文稿的公司名按“一家公司一个中文名”会怎么改；核对中文稿里的数字和日期在原文里有没有依据；读出正文开头的电头，并记下哪些国家只来自电头。结果只写 `entities.article_links` 和 `enrichment.analysis_checks` 两张表。**不调用模型，不改判断（`analyses`）和公开内容（`publications`），读者看不到任何变化。** 代码在 `packages/backend/src/pipeline/understand/observe.ts`。

稿件处理只负责在判断落库、发布投影之后排一个任务；排队失败只记日志，核对任务失败也只影响它自己，稿件照常处理、照常公开。

## 开关

设置键 `observe.articles`（归 enrichment 模块）。**没有这个键就是开着**；值为 `"off"` 时关闭：不再排新任务，已经排着的任务取出后什么也不写。改完一分钟内生效，不用发布，也不用重启。

在生产库执行一条语句即可（例如 `docker exec -it amp-db-1 psql -X -U amp -d amp` 打开会话后执行）：

```sql
-- 关闭
INSERT INTO settings (key, value, updated_by) VALUES ('observe.articles', '"off"', 'ops')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();

-- 重新打开
DELETE FROM settings WHERE key = 'observe.articles';
```

确认：`SELECT value FROM settings WHERE key = 'observe.articles';` 查到 `"off"` 是关着，查不到是开着。关着时 `news.enrichment.observe` 队列不再增加新任务。

## 上线后做一次：导入公司库

公司库的第一批行来自代码里已有的公司清单（目前 38 家公司，连同写法、股票代码和网站共 171 条）。导入只增不改：已有的行不动，以后哪次发布给代码种子加了公司，再跑一次只补新增的。

```bash
docker compose exec -T api node scripts/entities-seed.ts           # 预演：只数，不写
docker compose exec -T api node scripts/entities-seed.ts --apply   # 导入
```

用 api 容器，因为公司库只有后台账号（private_ops）能写，worker 只能读。没导入之前核对照常运行：公司按代码里同一份清单在内存里认，但认出的公司存不下来，每日对账会写“公司库还没导入”。

## 可选：免费回填历史

给已经判断过的稿件补做核对，不花钱、不调模型。只处理每篇稿子最新的那次判断；重复跑安全（同一次判断的核对记录只写一次，公司关联按当时的公司库整组替换）。先导入公司库再回填，否则公司关联存不下来。

```bash
docker compose exec -T worker node scripts/entity-links-backfill.ts --since 2026-11-01           # 预演：跑核对，只出计数
docker compose exec -T worker node scripts/entity-links-backfill.ts --since 2026-11-01 --apply   # 写入
```

日期按北京时间；`--until` 不含当天，默认到现在；`--batch` 每页条数（默认 200，最多 1000）；`--limit N` 本次最多处理 N 条，输出最后给出续跑用的 `--after`。用 worker 容器，因为核对记录表只有 worker 能写。避开出刊时刻，逐条顺序处理，对线上的影响和平时排队的核对一样。

## 每天看什么

每日对账里有三行，只在当天有核对记录时出现：

| 行 | 意思 |
|---|---|
| 单篇核对 | 昨天判断的稿件核对了多少条，其中认出至少一家公司的多少条（回填的历史稿件不算进当天） |
| 数字核对 | 程序拿不准的数字或日期多少处、在几条里。程序判为“多半写错”的那一类只记在表里，不进对账，等人工抽查证明它可靠之后再报 |
| 电头 | 正文开头是企业新闻稿电头、通讯社电头、只写地点和日期的各多少条 |

运行失败：任务失败自动重试两次，仍失败就在队列里记为失败，后台“运行”页的“24 小时内失败的队列任务”按队列列出次数（`news.enrichment.observe`）；worker 日志里是 `article observe failed`（核对失败）或 `article observe not queued`（没排上）。

## 数据与负载

- `entities.article_links`：每篇稿子当前修订认出的公司（正文里的写法、发布方网站、信源所属公司）。同一修订再核对时整组替换，人手加的关联保留。不随保留期清理。
- `enrichment.analysis_checks`：每次判断一行（数字核对的结论与发现、公司名会怎么改、电头和会被降级的国家），保存 180 天，由每日保留期任务清理。
- 负载：单独队列、一次一条、每 5 秒取一次；每条读一次稿件输入和一次公司库（公司库在内存里，只在库变动后重建）；正文最多读 20 万字。

## 现在不做的

不改稿、不扣稿、不改国家归属和标签；认出的公司还不进读者的筛选和搜索；公司库的合并与撤销已有函数，后台页面还没有。这些在后续批次。
