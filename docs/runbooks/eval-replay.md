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

1. **一个只读事务**：所有查询都在 `SET TRANSACTION READ ONLY` 的事务里跑，数据库会拒绝任何写入；报告第一行写明“只读事务：是”（事务里实测 `transaction_read_only`）。单条查询最长 120 秒。
2. **只读这些表**：`analyses`、`selectbench_runs`、`selectbench_results`、`receipts`（只数评测回执的条数）、`ai.swipe_cards`、`ai.swipe_answers`、`audit_log`、`grouping_overrides`、`settings`（只读 `events.shadow` 一个键）、`events.shadow_decisions`、`fact_articles`、`facts`、`stories`、`pgboss.job`（只数影子任务）。`tests/eval-replay-db.test.ts` 用一个只能读这些表的临时角色跑一遍，结果和超级用户跑的一模一样；收回其中一张表（测试里收回的是 `ai.swipe_answers`）的读权限，脚本就直接报错，不会悄悄跳过。
3. **不碰模型**：脚本和它的计数文件不直接引用任何模型客户端，也没有调用模型或发网络请求的代码。`tests/eval-replay.test.ts` 检查直接引用，并记录 Node 实际加载的模块图：模型客户端模块只经由脚本复用的两个现成文件（刷卡台 `admin/swipe.ts`、影子对照 `pipeline/events/agreement.ts`）被加载；脚本从这两个文件只用计数函数 `tallySwipe` 和只读对照 `shadowAgreement`。

## 用哪个数据库角色

用 API 容器的身份（`initializeDb("api")`），也就是 **private_ops** 角色。应用角色里只有它能读刷卡两张表（worker 角色读不了），其余各表它也都有读权限（`tests/eval-replay.test.ts` 用角色授权规划器逐表核对）。不需要、也不要为它改授权。

## 怎么跑（Codex，生产，只读）

脚本随镜像发布；**包含它的版本发布之后**才能在服务器上跑。避开发布窗口，选负载低的时段：

```bash
docker compose exec -T api node scripts/eval-replay.ts            # 影子对照看最近 14 天
docker compose exec -T api node scripts/eval-replay.ts --days 30  # 1 到 45 天
```

- 屏幕上只有计数、规则版本名和 SelectBench 运行编号与模型名（金标编号也不印）。
- 完整报告（计数加金标红单的编号）写在容器里的 `/app/.data/eval/replay-<时间>/report.md` 和 `report.json`。容器重建后会消失；需要时用 `docker compose cp api:/app/.data/eval/replay-<时间> .` 取出。`.data/` 不进仓库。
- 报告里没有标题、正文、稿件编号、操作人或理由；只有计数、规则与提示词版本名、SelectBench 运行编号与模型名、金标编号（金标编号本来就在公开的仓库文件里）。

## 回传什么

把屏幕上的输出原样贴到协作看板 #348。不需要贴报告文件。

## 读数时注意

- 刷卡的牌是按“靠近门槛、两次打分分歧、预筛拦下、复查”挑的，比率只代表这批牌，**不能当全站比率**。
- 116 篇是难例，(a) 的一致率也不代表全站。
- 金标按今天仓库里的标注算（含 Owner 同意的 5 处改判），不用 SelectBench 运行当时存的那份。
- 人工纠正以审计记录为准；`grouping_overrides` 只是现状，重新归组时会被删除。
