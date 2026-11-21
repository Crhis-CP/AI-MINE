# 评测只读回放（计划 1.10 第二部分）

最后核对：2026-11-20。

## 这是什么

`scripts/eval-replay.ts` 用库里已经存着的标注，给旧实现打一次分，出一份基线和红单。**不调用模型、不写任何一行数据、读者看不到任何变化。** 三种标注各算各的：

| 标注 | 和什么比 | 怎么分组 |
|---|---|---|
| Owner 11 月 5 日标的 116 篇金标（仓库文件 `industry/selection-gold/`） | (a) 标注当天冻结的精选快照；(b) 库里存的分析判定；(c) 库里存的 SelectBench 评测结果 | 按规则版本分开算，从不混在一起 |
| 刷卡回答（`ai.swipe_cards`、`ai.swipe_answers`） | 发牌时系统的判定 | 按卡类、按规则版本 |
| 人工拆分、合并、重新归组（审计记录） | 计数；近 N 天的事件影子对照里，人工纠正对两套引擎的打分 | 按动作 |

现行 `global` 规则在 116 篇上的成绩只从库里已有的数据取（分析判定或 SelectBench 结果）。库里没有时，报告写 `not available, needs budget`：这一步要花模型费，须 Owner 批预算，本脚本不会去调模型。

## 只读怎么保证

1. **一个只读事务**：所有查询都在 `SET TRANSACTION READ ONLY` 的事务里跑，数据库会拒绝任何写入；报告第一行写明“只读事务：是”（事务里实测 `transaction_read_only`）。单条查询最长 120 秒，等锁最长 2 秒，事务在两条查询之间闲置超过 60 秒就被数据库结束。复用的影子对照也拿这个事务去查：`tests/eval-replay-db.test.ts` 把进程共用的数据库连接换成“一用就报错”的假连接再跑一遍，没有一条查询走到事务外。
   - 只算完整的判定：库里还有两种不是判定的分析行（评分前先写下的“只有预筛”行、过期回复的诊断行），它们不算，否则会多出一个“规则版本”并把稿件算成“没选”。
2. **只读这些表**：`analyses`、`selectbench_runs`、`selectbench_results`、`receipts`（只数评测回执的条数）、`ai.swipe_cards`、`ai.swipe_answers`、`audit_log`、`grouping_overrides`、`settings`（只读 `events.shadow` 一个键）、`events.shadow_decisions`、`fact_articles`、`facts`、`stories`、`pgboss.job`（只数影子任务）。`tests/eval-replay-db.test.ts` 用一个只能读这些表的临时角色跑一遍，结果和超级用户跑的一模一样；收回其中一张表（测试里收回的是 `ai.swipe_answers`）的读权限，脚本就直接报错，不会悄悄跳过。
3. **不碰模型**：脚本和它的计数文件不直接引用任何模型客户端，也没有调用模型或发网络请求的代码。`tests/eval-replay.test.ts` 检查直接引用，并记录 Node 实际加载的模块图：模型客户端模块只经由脚本复用的两个现成文件（刷卡台 `admin/swipe.ts`、影子对照 `pipeline/events/agreement.ts`）被加载；脚本从这两个文件只用计数函数 `tallySwipe` 和只读对照 `shadowAgreement`。

## 用哪个数据库角色

脚本按 API 进程连接（`initializeDb("api")`），用的是 API 容器里现有的数据库地址，不需要、也不要为它改授权。

- **按角色分登录时**（容器里设了 `DATABASE_URL_PRIVATE_OPS` 和 `DATABASE_URL_AUTH`）：查询用 **private_ops** 登录。应用角色里只有它能读刷卡两张表（worker 读不了），其余各表它也都能读。`tests/eval-replay.test.ts` 用角色授权规划器逐表核对，并核对 API 进程的查询确实用 private_ops 那个地址。
- **单一登录时**（只有 `DATABASE_URL`，如仓库里的 `docker-compose.yml` 和 `.env.example` 的写法）：用这个共用登录连接，它通常什么都能读写；这时保护只靠上面的只读事务。启动时会在错误输出里多打一行“没有按角色分登录：当前使用单一 DATABASE_URL（过渡配置）”，这是正常提示。

## 怎么跑（Codex，生产，只读）

脚本随镜像发布；**包含它的版本发布之后**才能在服务器上跑。避开发布窗口，选负载低的时段：

```bash
docker compose exec -T api node scripts/eval-replay.ts            # 影子对照看最近 14 天
docker compose exec -T api node scripts/eval-replay.ts --days 30  # 1 到 45 天
```

- 屏幕上只有计数、规则版本名和 SelectBench 运行编号与模型名（金标编号也不印）。大致是这样（数字是示例）：

```text
评测回放（只读事务：是，生成于 2026-11-21T01:00:00.000Z）
金标：可判 116 篇（该选 32、不该选 84），两可 3 篇不计
  (a) 11-05 冻结快照：判定 116/116，一致 62.9%，准确 29.6%（8/27），召回 25%（8/32），漏选 24，错选 19
  (b) 库存分析 classic（prefilter-shared@… | selection-score-shared@…）：判定 …
  (c) SelectBench：没有金标稿件的评测记录
  现行 global 规则：not available, needs budget（库里没有，本脚本不调用模型）
  评测回执（金标标注日之后）：0 条
刷卡：… 天，卡 …，已答 …；按卡类、按规则各一行
归组人工纠正（全部 / 近 14 天）：content.detach …/…，…
  保持独立等现存覆盖：…；影子开关：…；近 14 天影子对照：…
报告：/tmp/aimine-eval/replay-<时间>/report.{md,json}
```

- 完整报告（计数加金标红单的编号）默认写在容器的临时目录 `/tmp/aimine-eval/replay-<时间>/report.md` 和 `report.json`（生产镜像里 `/app` 对 node 用户只读，所以不往那里写；也可以用 `--out <目录>` 指定）。容器重建后会消失；需要时用 `docker compose cp api:/tmp/aimine-eval/replay-<时间> .` 取出。
- 报告里没有标题、正文、稿件编号、操作人或理由；只有计数、规则与提示词版本名、SelectBench 运行编号与模型名、金标编号（金标编号本来就在公开的仓库文件里）。

## 对线上的负担

除按编号、按天取的查询外，有两条是整表顺序扫描，没有可用的索引：按动作数审计记录（`audit_log`），按 `subject LIKE 'evaluation:%'` 数评测回执（`receipts`）。在本机（4 核、数据已在缓存里）各造 200 万行（审计 410 MB、回执 983 MB）实测：审计约 0.08–0.10 秒，回执约 0.10–0.16 秒。生产上第一次读要从磁盘读整张表，会慢一些；每条仍受 120 秒上限约束，超时就整个失败，不会拖住线上。生产两张表实际有多大没有核对过。

## 回传什么

把屏幕上的输出原样贴到协作看板 #348。不需要贴报告文件。

## 读数时注意

- 刷卡的牌是按“靠近门槛、两次打分分歧、预筛拦下、复查”挑的，比率只代表这批牌，**不能当全站比率**。
- 116 篇是难例，(a) 的一致率也不代表全站。
- 金标按今天仓库里的标注算（含 Owner 同意的 5 处改判），不用 SelectBench 运行当时存的那份。
- 人工纠正以审计记录为准；`grouping_overrides` 只是现状，重新归组时会被删除。
