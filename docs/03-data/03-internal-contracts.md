# 模块间契约：领域事件、任务与查询接口

> 本文定义 12 个业务模块与平台包之间的**协作契约**（模块划分见 `04-architecture/03-module-map.md`；A 包原 16 模块表与 B 包“9 个领域包 + 6 个平台包”表已被取代）。模块 Agent 只要守住本文的契约，就可以独立实现自己的模块，不必了解其他模块的内部。
> 契约的机器可读版本放在 `packages/contracts/src/<module>/`（Zod schema，契约唯一事实源链路为 Zod → OpenAPI，DEC-31；B 的 `domain-events.schema.json` 只保留“JSON Schema + 合成示例 + 校验脚本”的机器契约写法，按本文 §2 重新生成）。本文是它的规格说明。任何变更遵循 `06-agents/01-parallel-development-rules.md` 的“追加/弃用/破坏”协议。
> 状态标签同 `01-domain-model.md`。实体与枚举以 `03-data/01-domain-model.md` 为准；端口名与 `03-data/contracts/interface-behavior.md` §4 对齐，**冲突以本文为准**。

**v2.1 相对 v2.0 的主要变化（Owner 2026-10-01 答复）**

| # | 变化 | 依据 |
|---|---|---|
| 1 | **用量与熔断事件取代预算事件**：`budget.threshold_reached` 【已废弃】（月度提醒线、额度耗尽、总额触顶均不存在）；新增 `usage.notice_raised`（月内累计每跨过 100 元，只提示、不暂停）、`usage.report_issued`（每月 1 日用量报告）、`breaker.warning_raised`（指标达到熔断阈值的 70%，只提醒、不暂停）、`breaker.tripped` / `breaker.recovered`（异常熔断开启与负责人恢复）；熔断状态是 ENT-82，**不写入 LaneControl**，不产生 `holder=budget` 的暂停 | DEC-08、DEC-09；BR-COST-18～20 |
| 2 | **精选与热点随全面切换上线**：`enrichment.score` 与 `enrichment.evaluate-selection` 由“默认关闭”改为启用（沿用 AIHOT：两次独立评分、分级门槛、等归组再露出；对外服务的正式站只加载经 Owner 审阅确认的矿业版评分标准，BR-SEL-09）；热点榜归 events，新增事件 `hot.ranking_computed`；`selection.changed` 只管精选入选或取消 | DEC-10、DEC-64；BR-SEL-02～09、BR-EVT-11 |
| 3 | **旧数据一概不导入**：`import.batch_finished` 事件与 `import.run-batch` 任务【已废弃】；Owner 原始信源表（321 条记录 / 320 个目标）改由 `sources.import-targets` 一次性导入（它是需求输入，不是旧数据，T-147） | DEC-20、DEC-42 |
| 4 | **许可**：处理许可 `expires_at` 对 `owner_declared` 为空（不设自动到期）；`policy.check-expiry` 只预警质量资格与带期限的补充证据 | DEC-33 |
| 5 | **报告**：`reports.compile` 的资讯线选材取自精选候选（同一事实去重、版面容量限制，BR-RPT-02），出刊时间与时间窗沿用 AIHOT（日报 08:00、周报周一 10:00、月报 1 日 10:30，每小时补出缺的刊期，BR-TIME-09）；`reports.synthesize` 覆盖日报导语（沿用 AIHOT）；日报、周报、月报切换当天必须有 | DEC-64、DEC-65、DEC-19 |

**v2.0 相对 v1.0 的主要变化**

| # | 变化 | 依据 |
|---|---|---|
| 1 | 事件信封与任务载荷都带 **`lane`**（`news`/`policy`；仅全局事件用 `all`）；队列名 `<lane>.<stage>`；暂停以 LaneControl 三开关为准，取代 `site.processing_paused` | ADR-0016、ENT-54、D10-data-001 |
| 2 | 事件信封统一：取 B 的字段名与 outbox/inbox 语义，取 A 的 `producer` 与 `subject.kind`；目录由 A 的 23 个类型扩为 **33 个**，并给出与 B 的 5 个事件的对表 | D10-data-010 |
| 3 | `policy_version` 改名 `permission_version`，`policy_epoch` 改名 `suppression_epoch`，避免与法规实体 PolicyVersion 重名（“policy”一词原有四种含义） | D10-data-010 |
| 4 | `events.recall-and-relate` 改由 `entity.resolved` 触发；法规线不订阅 `material.enriched`，由 `policy.identify` 订阅 `material.body_ready` | D10-data-022、ADR-0016 |
| 5 | 任务契约增加租约围栏与“暂停/权限变化后在途结果不晋升”的比较交换规则；阶段键 `(subject_revision, stage, recipe_version)` | D10-data-023、ADR-0005 |
| 6 | 任务目录按 lane×stage 重排，法规线任务（`policy.identify` / `policy.process-fulltext` / `policy.interpret`）、目录扫描、到期检查、账本对账、反馈清理、导入批次入目录（导入批次 v2.1 已废弃，见上表第 3 行） | `04-architecture/01-target-architecture.md` §4.3、DEC-01 |
| 7 | 端口表加 lane 参数与 B 端口名；处理许可带 lane 与九项用途 | D05、DEC-58 |

---

## 1. 三种协作方式

| 方式 | 用途 | 规则 |
|---|---|---|
| **领域事件**（异步） | 流水线推进、“某事实已变化”的通知 | 与事实写入同一事务（outbox）；信封必带 lane；载荷只放引用、版本与小型决策位；消费方 inbox 去重；可重放；事件是“事实已提交”的通知，**不是授权凭据** |
| **任务**（异步） | 模块内部或受托的耗时工作（抓取、模型调用、投影重建） | 声明 lane、stage、幂等键、并发、重试、超时、记账类别；只由 worker 执行（抓取与解析在 fetcher 执行） |
| **查询/命令函数**（同步） | 读取另一模块的当前状态；少量同步命令（签发处理许可、设置人工精选、下架） | 只通过对方 `src/index.ts` 导出；遵守依赖方向（`04-architecture/03-module-map.md` 第 3 节）；命令可接收调用方事务句柄 |

---

## 2. 领域事件目录

### 2.1 公共信封（所有事件）

```ts
{
  event_id: string,          // evn_<ULID>，全局唯一
  event_type: string,        // "<聚合>.<过去式动作>"，例如 "material.body_ready"
  schema_version: 1,         // 该事件类型的 schema 版本
  occurred_at: string,       // UTC ISO 时间
  producer: string,          // 产生模块名（规范名）
  lane: "news" | "policy" | "all",   // 事件所属业务线；只有本质全局的事件才用 "all"
  subject: { kind: string, id: string, version: number },  // 对象类别、稳定 ID、修订号（≥1）
  correlation_id: string,    // 必填：一条业务链路的追踪 ID（等同 trace）
  causation_id: string | null, // 触发它的上一个事件；根事件为 null
  payload: object            // 只放 ID、版本与小型决策位（≤ 约 2KB），不放正文、秘密或大对象
}
```

- 字段来源：B 的 `event_type`、`schema_version`、`correlation_id`（必填）、`causation_id`（可空）、`aggregate_id/aggregate_version`（在本契约里并入 `subject.id/subject.version`）；A 的 `producer` 与 `subject.kind`；新增 `lane`。ID 与时间的格式同 `01-domain-model.md` §1。
- `lane = "all"` 仅用于：`source.permission_changed`、`source.identity_revoked`、`source.candidate_proposed`、`entity.updated`、`publication.version_bumped`、`usage.notice_raised`、`usage.report_issued`、`breaker.warning_raised`、`breaker.tripped` / `breaker.recovered`（单日总费用异常等跨业务线的熔断范围）、`lane.control_changed`（紧急全停）。材料、文书、事件类事件永远是 `news` 或 `policy`。
- 合成示例（字段齐全，仅作契约测试夹具，不含任何真实数据）：

```json
{
  "event_id": "evn_01J0000000000000000000000X",
  "event_type": "material.body_ready",
  "schema_version": 1,
  "occurred_at": "2026-09-30T00:00:00Z",
  "producer": "content",
  "lane": "news",
  "subject": { "kind": "material_revision", "id": "mrv_01J0000000000000000000000Y", "version": 1 },
  "correlation_id": "trace_demo",
  "causation_id": null,
  "payload": {
    "material_id": "mat_01J0000000000000000000000Z",
    "revision_id": "mrv_01J0000000000000000000000Y",
    "content_hash": "0000000000000000000000000000000000000000000000000000000000000000",
    "permission_version": 1,
    "body_state": "ready"
  }
}
```

### 2.2 事件类型目录（共 37 个有效类型：v2.0 的 33 个，v2.1 新增 6 个、废弃 2 个）

“订阅方与动作”一列中，**未列出的模块不得订阅**。lane 列 N＝`news`，P＝`policy`，A＝`all`，“N/P”表示由载荷所属业务线决定。

| 事件类型 | 发布方 | lane | 触发时机 | subject.kind | payload 要点 | 主要订阅方与动作 |
|---|---|---|---|---|---|---|
| `source.profile_activated` | sources | N/P | 采集配置首次启用或恢复 | profile | `first_activation`、`config_version` | acquisition：纳入调度；ops：记录 |
| `source.profile_paused` | sources | N/P | 采集配置被人工暂停 | profile | `holder`、`expires_at` | acquisition：停止生成任务；ops：记录、暂停超时告警 |
| `source.profile_archived` | sources | N/P | 采集配置归档（终态） | profile | — | acquisition：移出调度；ops |
| `source.profile_config_changed` | sources | N/P | 影响采集身份的配置版本切换生效 | profile | `config_version` | acquisition：按新配置运行 |
| `source.permission_changed` | sources | A | 来源用途契约出新版本 | source | `permission_version`、`narrowed`、`changed_items[]` | content：按新权限处理之后的工作，到期/收窄触发正文失效；enrichment、policy：按新权限处理；publication：重算可见性（资讯线撤销全文展示；法规线公开用途失效整篇移除）；ai-gateway：旧权限版本的许可不再有效 |
| `source.identity_revoked` | sources | A | 来源身份或权限的紧急撤销（整个信源） | source | `reason_code`、`scope` | acquisition、content、publication：停止相应阶段并隐藏依赖内容；ops：告警 |
| `source.candidate_proposed` | sources | A | 离线研究提出候选信源 | candidate | — | ops：告警“候选信源待加入”（私有页面“信源”处理） |
| `acquisition.run_finished` | acquisition | N/P | 一次采集运行结束 | run | `outcome`（五类）、`receipt_id?` | ops：运行记录、失败告警；sources：更新健康态 |
| `acquisition.catalogue_scan_verified` | acquisition | P | 目录整轮扫描校验通过并原子应用 | scan | `scan_id`、四个计数 | policy：新文书目标入取得队列 |
| `material.stored` | content | N/P | 新材料入库（非重复）（A 原名 `material.discovered`） | material | `source_id`、`profile_id`、`is_old` | acquisition：取详情正文（`acquisition.fetch-body`） |
| `material.body_ready` | content | N/P | 正文就绪或确定只能用元数据（≈ B 的 `content.revision.ready`） | material_revision | `material_id`、`revision_id`、`content_hash`、`permission_version`、`body_state` | enrichment（资讯线）：开始加工；policy：`policy.identify`（法规线材料，及任意 lane 的官方来源材料，只做确定性文书识别，命中才记法规线准入）；publication：更新 |
| `material.revised` | content | N/P | 来源内容变化产生新修订 | material_revision | `material_id`、`revision_id`、`previous_revision_id` | enrichment：增量加工；policy：新版本处理；editorial：把基于旧修订的人工稿转 `needs_review`；publication：更新 |
| `translation.completed` | content | N/P | 某 (修订, 语言, recipe) 的全部分段完成 | translation | `revision_id`、`target_language`、`recipe_version`、`coverage` | enrichment：更新 ChineseReading 状态并发 `material.reading_updated`；policy：完整中文就绪，推进全文处理 |
| `material.content_expired` | content | N/P | 来源用途契约被逐源收紧或撤销（带期限的补充证据到期亦然；`owner_declared` 不设自动到期）使已存正文/译文/缓存失效 | material_revision | `reason`（`contract_expired`/`contract_revoked`）、`layers[]` | publication：移除依赖内容；enrichment/policy：失效或重审派生物 |
| `material.enriched` | enrichment | N | 某修订的加工阶段完成（≈ B 的 `intelligence.analysis.ready`） | material_revision | `revision_id`、`analysis_id`、`recipe_version`、`stage`（`screen`/`structure`/`score`/`write_zh`）、`publishability`（`eligible`/`guide_only`/`withheld`） | entities：实体解析；publication：更新投影（selection 与事件归组**不**直接订阅，见下） |
| `material.reading_updated` | enrichment | N | 中文阅读完成度变化 | material_revision | `state`、`reason?` | publication：更新正文可得性与中文阅读状态（读者文案按 DR-82 显示） |
| `entity.resolved` | entities | N | 材料中的实体完成解析（**零提及也必须发出**） | material_revision | `mention_count`、`unresolved_count` | events：`events.recall-and-relate`；publication |
| `entity.updated` | entities | A | 实体资料、别名或核验状态更新 | entity | `entity_id`、`change` | events：必要时重召回；policy：仅对“弱身份”文书复核；publication：更新公开名称 |
| `event.changed` | events | N | 事件成员、关系、代表材料、热度、合并/拆分变化 | event | `change`、`version` | enrichment：`enrichment.evaluate-selection`（放行已入选资料：归组完成或满 3 分钟）；publication；reports |
| `policy.changed` | policy | P | 文书版本、完整中文、解读、影响、资格或撤回变化 | policy_version | `policy_version_id`、`language?`、`change`（`instrument_identified`/`version_acquired`/`basic_facts_ready`/`zh_complete`/`interpretation_verified`/`qualified`/`qualification_expired`/`withdrawn`）、`form`（`basic_facts`/`complete_interpretation`） | events：更新新闻事件与政策进展线的关联；publication：按版本逐条投影；reports |
| `selection.changed` | enrichment | N | 精选入选或取消（含人工精选；随精选上线，v2.1 起不再含热点榜） | event | `featured`、`rule_version`、`visible_after?` | publication |
| `hot.ranking_computed` 【v2.1 新增】 | events | N | 热点榜重算完成（每小时或相关 `event.changed` 触发；沿用 AIHOT：48 小时、半衰期 24 小时、前 10） | hot_ranking | `ranking_id`、`rule_version`、`computed_at`、`entry_count`（不含热度值） | publication：投影热点榜（网页形态含热度值，机器出口只给名次，BR-SEL-05） |
| `editorial.revised` | editorial | N/P | 人工修订保存或状态变化 | target | `target_kind`、`target_id`、`revision_no`、`state`（`effective`/`needs_review`/`conflict`/`superseded`/`withdrawn`） | publication：叠加并重建受影响投影；enrichment；ops：`needs_review`/`conflict` 触发异常告警 |
| `editorial.withdrawn` | editorial | N/P | 下架生效 | target | `target_kind`（条目/事件/发展线/报告/文书版本/语言表达/解读）、`target_id`、`suppression_id`、`suppression_epoch` | publication：**立即过滤** + 重建投影；events：成员与代表稿重算；enrichment；reports：下架传播；policy：重算公开头 |
| `editorial.restored` | editorial | N/P | 下架被显式恢复（法规线公开版本的撤回不可恢复） | target | 同上 | 同 `editorial.withdrawn` |
| `editorial.review_concluded` | editorial | N/P | 建设期抽样审核结论（**默认关闭**） | review | `subject_kind`、`subject_id`、`decision`（`accept`/`correct`/`drop`/`hold`） | publication（`correct` 形成修订）；ops |
| `report.issued` | reports | N/P | 新刊期发行 | report_revision | `report_id`、`period_key` | publication：经命令写入报告投影；ops |
| `report.revised` | reports | N/P | 报告修订 | report_revision | `reason`（`late_content_or_coverage`〔仅法规线周月汇总〕/`correction`/`withdrawal_propagation`）、`synthesis_state` | publication；ops |
| `publication.version_bumped` | publication | A | 发布账本水位推进（≈ B 的 `publication.activated`，**无 generation/manifest**） | ledger | `content_version`（不透明）、`suppression_epoch` | ops：缓存预热、IndexNow（开关控制）、站点地图 |
| `budget.threshold_reached` 【已废弃】 | ai-gateway | — | v2.1 不再存在：不设月度金额上限，没有提醒线、额度耗尽与总额触顶；由 `usage.notice_raised`、`breaker.tripped` 取代 | — | — | —（不得再写入 `holder=budget` 的暂停，该持有者已取消） |
| `usage.notice_raised` 【v2.1 新增】 | ai-gateway | A | 北京时间自然月内累计用量（已确认 + 未知占用）每跨过 100 元的整数倍（只提示，不暂停任何处理；BR-COST-19） | usage_month | `month`、`tier`（档位）、`crossed_tiers[]`、`cumulative_micros` | ops：用量提示推送（飞书群机器人为主、邮件为备）；**无任何订阅方因它暂停处理** |
| `usage.report_issued` 【v2.1 新增】 | ai-gateway | A | 每月 1 日生成上月用量报告（确定性汇总，不调模型；BR-COST-18） | usage_report | `month`、`report_ref` | ops：推送报告；私有“用量与熔断”页留存 |
| `breaker.warning_raised` 【v2.1 追加】 | ai-gateway | N/P/A | 异常熔断指标达到其熔断阈值的 70%（预警线；**只提醒，不暂停任何处理**；BR-COST-20 第 7 点）；同一指标 × 同一范围 × 同一统计窗口只发一次 | breaker | `breaker_id`、`trigger`（`repeated_input`/`object_cost`/`daily_total`）、`scope`、`stage`（`warning`）、`current_value`、`warn_line`、`threshold`、`config_version` | ops：预警推送（哪一项指标、当前数值、预警线与阈值、涉及的能力或来源，一句明示“尚未暂停”）；**无任何订阅方因它暂停处理**（platform/queue 只读取 `open` 阶段，不读取 `warning`） |
| `breaker.tripped` 【v2.1 新增】 | ai-gateway | N/P/A | 异常熔断开启（三个触发条件之一；BR-COST-20；此前已预警的，由 `warning` 转 `open`） | breaker | `breaker_id`、`trigger`（`repeated_input`/`object_cost`/`daily_total`）、`scope`、`stage`（`open`）、`warned_at?`（此前已预警的时间，没有预警则空）、`config_version` | ops：告警（触发条件、范围、数值与阈值、此前是否已预警、建议排查方向）；platform/queue：范围内付费任务进入“等待恢复”（读取熔断状态，**不写 LaneControl**） |
| `breaker.recovered` 【v2.1 新增】 | ai-gateway | N/P/A | 负责人一键恢复熔断 | breaker | `breaker_id`、`scope`、`recovered_by` | ops：恢复通知；platform/queue：范围内“等待恢复”的任务自动继续 |
| `receipt.unknown_recorded` | ai-gateway | N/P | 出现结果未知的付费调用 | receipt | `receipt_id`、`reserved_amount` | ops：告警（结果未知费用积累） |
| `lane.control_changed` | platform/queue | N/P/A | 某业务线的暂停/恢复（替代 A 的 `site.processing_paused/resumed`） | lane_control | `switch`（`collection`/`processing`/`publication`/`emergency`）、`paused`、`holder`、`expires_at`、`revision` | 所有任务开始前读取最新控制；ops：暂停超时未恢复告警 |
| `job.dead_lettered` | platform/queue | N/P | 任务超过重试上限进入死信 | task | `task_type`、`queue`、`failure_class`、`subject_ref` | ops：告警（不设人工逐条重试页面） |
| `import.batch_finished` 【已废弃】 | —（旧数据导入已废弃） | — | v2.1 不再存在：旧数据一概不导入（Owner 2026-10-01 全重做，DEC-20） | — | — | — |

**与 v1.0 的差异说明**

- A 的 23 个类型在 v2.0 的去向：`source.activated`/`paused`/`retired`/`config_changed` → `source.profile_activated`/`profile_paused`/`profile_archived`/`profile_config_changed`（按采集配置，带 lane）；`source.permission_changed`、`source.candidate_proposed`、`acquisition.run_finished` 保留；`material.discovered` → `material.stored`；`material.body_ready`/`revised`/`enriched`/`reading_updated`、`entity.resolved`、`event.changed`、`policy.changed`、`selection.changed`、`report.issued`/`revised`、`publication.version_bumped` 保留（`budget.threshold_reached` v2.1 废弃，见上表）；`editorial.changed` **拆为** `editorial.revised`/`withdrawn`/`restored`/`review_concluded`（B 的 `suppressed` 布尔不足以区分；04-architecture/03-module-map.md §3.2 的 `editorial.changed` 是这组事件的统称）；`site.processing_paused`/`resumed` → `lane.control_changed`。新增：`source.identity_revoked`、`acquisition.catalogue_scan_verified`、`translation.completed`、`material.content_expired`、`entity.updated`、`receipt.unknown_recorded`、`job.dead_lettered`、`import.batch_finished`（v2.1 废弃）。v2.1 另增：`hot.ranking_computed`、`usage.notice_raised`、`usage.report_issued`、`breaker.tripped`、`breaker.recovered`。
- **触发链修正**（D10-data-022）：`material.enriched` 只触发 `entities.resolve` 与 publication 投影；**`events.recall-and-relate` 由 `entity.resolved` 触发**（召回依据含“同实体”，实体未解析就召回会系统性漏召，事件顺序不保证并行触发不可复现）；`selection` 由 `event.changed` 触发，不直接订阅 `material.enriched`。
- **法规线不订阅 `material.enriched`，也不依赖实体解析事件**（ADR-0016、D12-architecture-001）：`policy.identify` 由 `material.body_ready` 触发；发文机关通过 entities 的同步查询 `findByAlias` 取得，避免 policy 依赖 enrichment/events 形成环。A 原流程“政策文书先过资讯预筛”的路径作废。

### 2.3 与 B 的 `domain-events.schema.json` 对表（缺的补、冲突的裁）

B 的文件只有 5 类事件且无目录语义（`$id` 为 `schemas.example.invalid` 的提案稿）；v2.0 以本节为准，`03-data/contracts/domain-events.schema.json` 与 `domain-event.example.json` 按 §2.1–§2.2 **重新生成**（B 的 `additionalProperties:false` + `oneOf` + 合成示例的写法保留）。

| B 的 5 类事件 | 问题 | v2.0 处理 |
|---|---|---|
| `content.revision.ready`（`item_id`、`revision_id`、`content_hash`、`policy_version`、`lane`） | `policy_version` 指“来源权限版本”，与法规实体 PolicyVersion 重名；`item_id` 与 A 的 `mat_` 术语不一致 | → `material.body_ready`；`policy_version` → `permission_version`；`item_id` → `material_id`；`lane` 上移到信封 |
| `intelligence.analysis.ready`（`publishability`：`eligible`/`guide_only`/`withheld`） | 无 lane；A 流程里的预筛/结构化/评分/中文写作阶段无法区分 | → `material.enriched`；`publishability` 保留为 payload 决策位；增加 `stage` |
| `editorial.review.changed`（`subject_id`、`subject_revision`、`decision_id`、`suppressed`） | **没有对象类型**，消费者无法路由（条目/事件/报告/文书）；布尔值区分不了下架/恢复/修订/审核结论 | 拆为 `editorial.revised`/`withdrawn`/`restored`/`review_concluded`，`target_kind` 必填 |
| `publication.activated`（`publication_id`、`generation`、`policy_epoch`） | 发布代次机制不采用（ADR-0004）；`policy_epoch` 与 PolicyVersion 重名 | → `publication.version_bumped`；去掉 generation/manifest；`policy_epoch` → `suppression_epoch`（仅内部，对外只暴露不透明 `content_version`） |
| `source.changed`（`settings_version`、`policy_version`） | 合并事件丢掉“暂停”“权限撤销”的语义差别；不分业务线 | 拆为 `source.profile_*`（带 lane）、`source.permission_changed`（`permission_version`）、`source.identity_revoked` |

补充：B 的信封 `aggregate_id`/`aggregate_version` → `subject.id`/`subject.version`；`correlation_id` 必填、`causation_id` 可空保留；A 的 `producer`、`subject.kind` 保留；`lane` 新增。**ID 与时间的正则**沿用 B 的 `^[A-Za-z0-9_-]+$`（长度 ≤100）与 `date-time`，但 ID 前缀以 `01-domain-model.md` §1 为准（B 示例里的 `item_demo`/`rev_demo`/`ev_demo` 仅为占位，`rev_` 在本包是“人工修订”，不是“内容修订”）。

### 2.4 事件处理的通用规则（A 的四条与 B 的“乱序先查当前 revision”合并）

1. 订阅方收到事件后，用发布方的**查询函数读取最新状态**再处理；不依赖事件里的旧数据。
2. **处理前检查是否仍需处理**：对象已下架、已被合并、修订已过期、所属 lane 对应开关已暂停、权限版本已变化时直接跳过并记录（暂停导致的跳过不是失败，恢复后由调度补处理）。
3. 幂等：同一事件重复投递只产生一次有效工作，幂等键 = 事件 ID + 订阅方（inbox `unique(consumer, event_id)`）。**不得声称网络 exactly-once**。
4. 顺序不保证，只承诺同一 `subject` 内 `version` 单调：乱序消息先查当前 revision，**旧消息不得覆盖新状态**；缺版本时用提供方端口重读。
5. outbox 与事实写入同一事务；分发器可重复投递；payload 只传引用、版本与小型决策，不传大正文与秘密。

---

## 3. 任务目录（首期）

队列名 `<lane>.<stage>`（`04-architecture/01-target-architecture.md` §4.3），任务类型名 `<模块>.<动词>`（前缀取模块的 schema 名：ai-gateway 用 `ai`，platform/ops 用 `ops`），一个任务类型按载荷中的 lane 投入对应队列；lane 为 `all` 的平台任务使用 `platform.<stage>` 队列；离线研究与评测使用 `offline.research` / `offline.eval`。每个 lane×stage 有独立并发上限与保留份额，借用空闲容量须可被所属 lane 收回（ADR-0016）。**历史回填**走独立低优先级队列 `<lane>.backfill`。

| 任务 | 模块 | lane | 队列 | 触发 | 幂等键 | 并发 | 付费 | 说明 |
|---|---|---|---|---|---|---|---|---|
| `acquisition.tick` | acquisition | N/P | `<lane>.fetch` | 每 300 秒 | 时间片 + lane | 每 lane 1 | 否 | 找出到期且未暂停的采集配置，生成采集任务（尊重各配置自己的频率；读取 LaneControl 采集开关） |
| `acquisition.collect-source` | acquisition | N/P | `<lane>.fetch` | tick / 手动“立即运行” | 采集配置 + 计划时间片 | 按域名限流；每 lane 每主机 1 | 否（付费信源类型除外） | 列表抓取、分页、条件请求、检查点推进；经 fetcher 执行；按国家轮转并失败退避（BR-POL-18） |
| `acquisition.fetch-body` | acquisition | N/P | `<lane>.fetch` | `material.stored` | 材料 + 来源修订标识 | 按域名限流 | 否 | 详情页/PDF 正文取得（原 A 的 `materials.fetch-body` 前半） |
| `acquisition.parse` | acquisition（fetcher） | N/P | `<lane>.parse` | 抓取结果 | 取得回执 | 每 lane 1 | 否 | HTML/PDF/XML 抽取、OCR（按源启用）；CPU 预算单列，不挤占公开 API |
| `content.normalize` | content | N/P | `<lane>.normalize` | 取得完成 | 材料 + 来源修订标识 | 可配 | 否 | 判重（仅同一信源内）、清洗、时间断言、原件入对象存储，产生 `material.body_ready`（原 A 的 `materials.fetch-body` 后半） |
| `acquisition.backfill` | acquisition | N/P | `<lane>.backfill` | 采集配置首次启用 | 采集配置 + 窗口 | 低优先级 | 否 | 资讯线 72h → 7d → 30d 有界回填，旧文不进“今天”；法规线另设窗口（不受 30 天上限约束，D08-013） |
| `acquisition.scan-catalogue` | acquisition | P | `policy.fetch` | 目录轮询（优先于首次发现的大批取得） | 采集配置 + 契约版本 + 轮次 | 每配置 1 | 否 | 分页官方目录整轮扫描与原子应用（BR-POL-16） |
| `sources.preview` | sources | N/P | `<lane>.fetch` | 私有页面请求 | 配置版本 | 2 | 否 | 经生产同一获取路径试抓，写预览结果；请求只排队（PIT-001） |
| `sources.research` | sources | —（离线） | `offline.research` | 负责人添加（法域 + 名称 + 网址）或离线批量 | 候选/信源 | 1 | 是（Tier 2；分批、最小必要样本，BR-COST-15） | M1 交付确定性探测 + 平台族识别 + 配置草案 + 预览请求（Tier 0，不依赖强模型）；有界工具循环研究与 AI 扩源放 M2，须 Owner 批准后启用；产物是待准入的候选配置（DEC-16） |
| `sources.discover` | sources | —（离线） | `offline.research` | 负责人发起“AI 检索新信源” | 法域 + 请求 | 1 | 是 | 产出候选信源，不自动加入 |
| `enrichment.prefilter` | enrichment | N | `news.screen` | `material.body_ready` | 修订 + 提示词版本 | 可配 | 是（Tier 1；Tier 0 规则先行） | 资讯预筛与矿业关联；**法规线材料不经此任务** |
| `enrichment.structure` | enrichment | N | `news.enrich` | 预筛收录 | 同上 | 可配 | 是 | 分类、法域、矿种、实体提及、政策用词、日期、主张 |
| `enrichment.score` | enrichment | N | `news.enrich` | 预筛收录或材料不足，且所属信源分级有门槛（AI-03；**沿用 AIHOT，M2 起**，与结构化并行，DEC-10） | 修订 + 评分提示词版本 + 尝试序号（1、2） | 可配 | 是 | **同一份评分标准独立两次评分**（各得一个 0–100 整数，两次各有各的回执）；程序合成平均分（向下取整）与是否入选（两次之和 ≥ 2 × 信源分级门槛）；无门槛的分级不评分；评分失败或被模型拒答 = 无分数、不入选、不显示 0；旧 55/75 公式作废；**对外服务的正式站只加载经 Owner 审阅确认的评分标准版本**（BR-SEL-09），没有已确认版本时不评分、不入选，影子运行与评测环境可加载草案 |
| `enrichment.write-zh` | enrichment | N | `news.enrich` | 结构化完成 | 同上 | 可配 | 是 | 中文标题、导读、推荐理由、公司说明（只用已核实词表） |
| `content.translate-segment` | content | N/P | `news.translate`（法规线由 `policy.process-fulltext` 调用同一分段存储） | 需要全文翻译 | 修订 + 段号 + 提示词版本 | 可配；新稿优先，存量与回填非高峰 | 是 | 分段翻译，逐段保存（ENT-62），长任务租约 + 检查点；完成后发 `translation.completed` |
| `entities.resolve` | entities | N | `news.link` | `material.enriched` | 修订 | 可配 | 可能 | 别名匹配优先，模型只处理歧义；零提及也发 `entity.resolved` |
| `events.recall-and-relate` | events | N | `news.link` | **`entity.resolved`** | 修订 + 规则版本 | 可配 | 是（歧义对） | 确定性召回（链接/文号/实体/时间窗）→ 成对关系判断（三值 + 原因）→ 程序硬校验；强身份只有三种（ENT-16） |
| `events.compute-heat` | events | N | `news.link` | 每小时 / `event.changed` | 事件 + 时间片 | 1 | 否 | 沿用 AIHOT：过去 48 小时、半衰期 24 小时、独立参与者按发布方与来源族去重；写热点榜（前 10，带规则版本，ENT-27）与每小时事件热度快照，发 `hot.ranking_computed`；法规文书不进榜（DEC-10、DEC-62；BR-EVT-11） |
| `enrichment.evaluate-selection` | enrichment | N | `news.enrich` | `event.changed`（归组完成）/ 满 3 分钟 / 规则版本变更 | 事件 + 版本 + 规则版本 | 可配 | 否 | 放行已入选资料：事件归组完成（最多 3 分钟）才露出（写 `visible_after`，发 `selection.changed`）；规则版本变更后对近期窗口（默认 7 天）用已存分值复核（BR-SEL-03）；复用已存分析，不调模型；评分标准版本未经 Owner 确认（无 `approved` 记录，ENT-84）的决定不露出（BR-SEL-09）；**已启用**（原 A 的 `selection.evaluate`；v2.0 的“暂未启用”作废） |
| `policy.identify` | policy | P | `policy.identify` | `material.body_ready`（法规线材料；及任意 lane 的官方来源材料） | 修订 + 规则版本 | 可配 | 规则优先，模型只产候选 | 文书身份（法域 + 机关 + 类型 + 文号）、法律性质、立法阶段与各类日期分维记录（原 A 的 `policy.track-instrument`，触发改为 `material.body_ready`） |
| `policy.process-fulltext` | policy | P | `policy.fulltext` | 文书识别完成且原件结构完整（必要附件齐全） | 文书版本 + 语言 + recipe | 1–2 | 是 | 分组核对、全文事实与完整中文；**长任务租约**（ENT-74）+ 检查点；与 `policy.interpret` 在 lane 内轮转领取，任一积压不得让另一阶段零执行 |
| `policy.interpret` | policy | P | `policy.interpret` | 全文与中文完成 | 文书版本 + 提示词版本 | 1–2 | 是 | 有界归并（≤ 六个子输入逐层）、候选解读与相关性、全篇语义核验；**固定工作图，不是 Agent 循环**（DEC-16）；长任务租约 |
| `policy.check-expiry` | policy | P | `policy.project` | 每日 | 日期 | 1 | 否 | 质量资格与带期限的补充证据到期预警（默认到期前 7 天经告警渠道推送清单；`owner_declared` 许可不设自动到期，DEC-33）；读取层本身已对到期失配失败关闭（F-POL-11） |
| `publication.project` | publication | N/P | `<lane>.project` | 各类 `*.changed` / `material.*` | 对象 + 版本 | 可配 | 否 | 增量投影（单条一个事务），推进水位 `content_version`；法规线逐文书版本投影；某条失败保留该条旧的合法投影 |
| `publication.rebuild` | publication | N/P | `<lane>.project` | 手动 / 每日对账 | 日期 + 范围 | 1 | 否 | 全量重建与对账（投影 vs 事实、抑制集合 vs 投影）；构建失败保留上次可确认版本 |
| `reports.compile` | reports | N/P | `<lane>.report` | 资讯线（沿用 AIHOT，北京时间）：每天 08:00 日报、每周一 10:00 周报、每月 1 日 10:30 月报，另每小时检查并补出缺的刊期（最近 7 天的日报、上一个完整周与完整月）；法规线：自然周/月结束后默认 08:00 生成、每小时复核 | 类型 + 周期键（+ edition） | 1 | 否 | 确定性编制，成员资格见 ENT-38、BR-TIME-09；**资讯线从精选候选取材**（同一事实去重、版面容量限制，BR-RPT-02，DEC-65；窗口为日报 [前一日 08:00, 当日 08:00)、上一个 ISO 周、上一个自然月；取稿时等待在途发布事务；跨过刊期边界的归入下一期候选池，不设补录），法规线为确定性快照（BR-POL-14）；同周期同 edition 幂等 |
| `reports.synthesize` | reports | N | `news.report` | 编制完成（日报、周报、月报） | 报告修订 + 提示词版本 | 1 | 是（Tier 3） | 日报导语与今日看点、周报与月报的总述与分节综合（沿用 AIHOT 的两份报告提示词并矿业化，AI-13）；失败或异常熔断暂停期间回退到确定性版本；**法规周月汇总不调用模型**（F-051） |
| `editorial.reassess-revisions` | editorial | N/P | `<lane>.project` | `material.revised` | 材料修订 | 可配 | 否 | 把基于旧修订的人工稿转 `needs_review`，引文核验不过转 `conflict`，生成异常记录 |
| `ai.reconcile-unknown` | ai-gateway | N/P | `platform.ai` | 每小时 | 回执 | 1 | 否 | 按供应商请求编号自动对账结果未知的回执；**永不重发**；无法自动的进入人工逐笔核对（DEC-55） |
| `ai.expire-reservations` | ai-gateway | N/P | `platform.ai` | 每 5 分钟 | 时间片 | 1 | 否 | 预留超过 10 分钟仍未出结果的转 `unknown`（预留不释放） |
| `ai.evaluate-usage` 【v2.1 新增】 | ai-gateway | A | `platform.ai` | 每 5 分钟（另在每笔结算后增量评估） | 时间片 | 1 | 否 | 评估用量提示（月内累计每跨过 100 元的整数倍推送一次，幂等，发 `usage.notice_raised`）与异常熔断指标③单日总费用（先评估 70% 预警线，达到预警线发 `breaker.warning_raised`，达到阈值发 `breaker.tripped`）；指标①②在网关调用前与结算后增量评估预警线与阈值（BR-COST-18～20）；检查本身不调模型、不产生费用 |
| `ai.usage-report` 【v2.1 新增】 | ai-gateway | A | `platform.ai` | 每月 1 日 09:00（北京时间） | 用量月 | 1 | 否 | 确定性汇总上月用量报告（费用、调用数、缓存命中率、单篇成本、最贵的 10 个任务），同月幂等，发 `usage.report_issued`（BR-COST-18） |
| `content.reap-objects` | content | A | `platform.storage` | 每日 | 日期 | 1 | 否 | 回收未被引用的暂存对象；按来源用途契约到期删除获准保存的原件与派生物 |
| `feedback.purge-expired` | feedback | A | `platform.ops` | 每日 | 日期 | 1 | 否 | 处理完成满 180 天的联系方式与截图自动删除，保留去标识正文与处理记录（DEC-46） |
| `ops.aggregate-daily` | platform/ops | A | `platform.ops` | 每日 | 日期 | 1 | 否 | 明细汇总为日聚合（指标全部带 lane） |
| `ops.retention` | platform/ops | A | `platform.ops` | 每日 | 日期 | 1 | 否 | 调度各模块导出的保留清理命令并汇总；**ops 不直接删除他模块数据** |
| `ops.backup` | platform/ops | A | `platform.ops` | 每日 | 日期 | 1 | 否 | 数据库备份到对象存储（与原件分桶、分权限）；失败即告警 |
| `ops.evaluate-alerts` | platform/ops | A | `platform.ops` | 每 5 分钟 | 时间片 | 1 | 否 | 按 lane 计算新鲜度、暂停超时、最老任务年龄、死信、质量资格到期等告警；含各业务线内容停更（用量提示、异常熔断预警与触发告警由 ai-gateway 的 `usage.notice_raised` / `breaker.warning_raised` / `breaker.tripped` 事件触发，不在此轮询） |
| `ops.notify` | platform/ops | A | `platform.ops` | 新告警 / 重试 | 告警 + 渠道 | 1 | 否 | 推送、去重、恢复通知；失败下个周期重试并走第二渠道，仍失败在私有页面显示“告警未送达” |
| `ops.health` | platform/ops | A | `platform.ops` | 每 5 分钟 | 时间片 | 1 | 否 | 各模块 `health()` 汇总与心跳（心跳不等于内容持续更新） |
| `sources.import-targets` 【v2.1 新增】 | sources | —（离线） | `offline.import`（一次性） | 手动（部署方，M1） | 工作簿版本 | 1 | 否 | 导入 Owner 原始信源表（321 条记录、320 个目标，ENT-57 / ENT-06）：幂等、保留 321 / 320、不做部分导入、按口径表分层计数；**它是需求输入，不是旧数据**（T-147） |
| `import.run-batch` 【已废弃】 | — | — | — | — | — | — | — | 旧数据导入与增量追平**作废**（Owner 2026-10-01 全重做，DEC-20）；队列 `offline.import` 只留给 `sources.import-targets`；任务类型名不复用；见 `04-legacy-migration.md` |

共 **41 个有效任务类型**（v1.0 为 26 个，v2.0 为 39 个；v2.1 新增 3 个：`ai.evaluate-usage`、`ai.usage-report`、`sources.import-targets`，废弃 1 个：`import.run-batch`）。任务通用规则：

1. **声明**：每类任务声明名称、载荷 schema（含 `lane`）、队列（`<lane>.<stage>`）、幂等键、并发上限、重试次数与退避、超时、是否可能产生费用与记账类别；重试、退避与租约数值以“重试、退避与租约参数表”为准（调度节拍 300 秒、任务最多 3 次尝试、模型已知无效输出 2 次 / 5 分钟、在途预留 10 分钟过期转未知等，D09-rules-011；表在 `02-rules/` 维护），本文不重复数值。
2. **开始前检查**：读取对应 lane 的 LaneControl 开关（采集 / 处理 / 公开）与 `ProcessingPermit`；已暂停或权限版本不匹配的任务**不开始**并记录（不是失败）；异常熔断只暂停被点名范围内的付费阶段（BR-COST-20，不写 LaneControl，范围内任务“等待恢复”；预警只提醒，不暂停任何范围）；全局只保留“紧急全停”。
3. **阶段成功以各模块结果表上的唯一键为准**：`(subject_revision, stage, recipe_version)`，同键只有一个成功结果；recipe 含解析/规则/提示词/输出 schema 版本，**不含运行时间**；pg-boss 归档或删除任务不影响该标记；短任务不另建通用执行账本，队列只作投递器。
4. **租约围栏**（长任务：全文翻译、法规全文处理与解读，B §3 + 旧分支 `runtime-materials.md:27-28@policy`）：租约必须同时匹配任务、worker、令牌、尝试次数与到期时间；长任务定期 checkpoint，续接只处理未完成片段；旧 worker 恢复后不能覆盖新 worker 的结果（pg-boss 过期重投会让两个 worker 各自完成付费调用并提交，旧库 `tasks.lease_token`/`lease_expires_at` 已有同类设计，`0008_live_pipeline.up.sql:24-43@main`）。
5. **在途结果不晋升**（旧分支 `content-runtime.md:28-29@policy`）：结果写回是对 `(task_id, lease_token, attempt, 来源权限版本, lane 控制修订)` 的**比较交换**；外部调用期间来源权限收窄、当前原件指针变化或该 lane 被暂停，则**费用仍结算、结果只留档，不晋升为当前材料**，避免发布已撤销许可下的内容。
6. **失败与死信**：按参数表自动重试；超过上限进入死信并推送告警（对象、失败类别、最近成功时间、恢复建议）；**不设人工逐条重试页面**，缺陷修复随代码发布后由受控服务身份按批重放并写审计（ADR-0005、ADR-0018）；不批量重跑全部 failed。
7. **付费任务**在开始前向 sources 取处理许可，向 ai-gateway 走回执与熔断检查（**不设月度金额上限**，不再有 lane×类别额度与月度总闸；被异常熔断的范围内任务“等待恢复”，恢复后自动继续）；不降级、不把不合格内容降成摘要，积压只按“法规 > 官方一手 > 其他”调整先后（BR-COST-12）；同一来源内存在结果未知调用时，后续付费调用等待；某付费调用结果未知时，本轮不再向同一 lane 的其他阶段分配付费机会。
8. **需要全局串行**的步骤（如同一事件的归组合并）用数据库锁或唯一约束保证，不依赖某进程的 `localConcurrency: 1`；唯一冲突在确定性提交阶段重试，不重买模型结果。
9. **公平**：每个 lane×stage 独立并发与保留份额；同一 lane 内模型阶段轮转；新闻突发不得无限推迟法规任务，法规回填不得堵住新闻实时流（双 lane 公平基准，ADR-0016）。

---

## 4. 查询与命令接口（每个模块的最小公开面）

> 这里只列跨模块真正需要的接口；模块可以有更多内部函数，但不得导出给别人用。所有涉及业务线的接口**显式带 `lane`**；“端口名”列对应 `03-data/contracts/interface-behavior.md` §4。

| 模块 | 导出 | 类型 | 调用方 | 端口名 |
|---|---|---|---|---|
| sources | `getSource(id)`、`getProfile(id)`、`getSourceConfig(profileId, version?)` | 查询 | acquisition、publication、ops | SourceCatalogPort |
| sources | `listDueProfiles(lane, now, limit)`、`resolveTarget(rowId)` | 查询 | acquisition | SourceCatalogPort（`due`、`resolveTarget`） |
| sources | `evaluate(sourceId, revision, action, resource)`（`resource` 取九项用途，另预留第十项 `syndicate_fulltext`、默认未知，仅站外再分发出口使用；`interface-behavior.md` §4 合称“权限十项”）→ 允许/禁止/未知 + 范围 + `permission_version` + `expires_at` | 查询 | content、enrichment、policy、publication | SourcePolicyPort |
| sources | `issueProcessingPermit(sourceId, lane, capability)` → `ProcessingPermit`（品牌类型，携带权限版本；不允许时返回拒绝原因） | 命令 | content、enrichment、entities、events、policy、reports、ai-gateway | SourcePolicyPort |
| sources | `recordFetchHealth(profileId, result)` | 命令 | acquisition | — |
| acquisition | `fetch(profileVersion, url, limits, conditionalHeaders)` → 回执 + 允许的字节/对象 + 时间（在 fetcher 执行；每跳重新校验；拒绝 HTTPS→HTTP 降级） | 命令 | sources（信源研究与预览）、content | FetchPort |
| content | `ingestDiscovered(tx, lane, items[])` → 新建/重复/更新 | 命令 | acquisition | ContentRevisionPort |
| content | `getMaterial(id)`、`getRevision(id, rev)`、`getBody(id, rev, permit)` | 查询 | enrichment、events、policy、publication | ContentRevisionPort |
| content | `ensureTranslation(revision, locale, recipe)`、`translationProgress(id)` → 完整/部分/受限 + 块级检查点 | 命令/查询 | enrichment、policy | TranslationPort |
| enrichment | `getAnalysis(materialId, rev)`、`getReading(materialId, rev, language?)` | 查询 | entities、events、publication、reports | — |
| enrichment | `setManualFeatured(tx, eventId, selected, actor, reason)`（随精选上线，仅负责人） | 命令 | editorial（经私有接口） | — |
| entities | `getEntity(id)`、`findByAlias(text, context)`、`resolve(mentions, evidence, context)` → 精确/候选/未解析；`getJurisdiction(code)`、`listJurisdictions(scope)` | 查询 | events、policy、publication | EntityPort |
| events | `getEvent(id)`、`getEventForMaterial(materialId)`、`listMembers(eventId)`、`getStory(id)`、`resolveAlias(oldId)` | 查询 | selection（enrichment）、editorial、publication、reports | — |
| events | `propose(revision, candidateLimit)`、`decide(proposal)` → 成对判断 + 成员角色 + 证据（类型化边另产 EventRelation） | 命令 | events 内部、editorial | EventPort |
| events | `applyGroupingOverride(tx, override)` | 命令 | editorial（经私有接口） | — |
| events | `getLatestHotRanking()`、`getEventHeatSeries(eventId)`（v2.1：热点榜与事件热度走势；法规文书不在榜内） | 查询 | publication、只读 MCP | — |
| policy | `getInstrument(id)`、`getVersion(id)`、`getInterpretation(id)`、`getPublicHead(instrumentId, language)` | 查询 | events（政策进展线）、publication、reports | — |
| policy | `analyze(instrumentRevision, inventory)` → `basic_facts`/`partial`/`complete`/`withheld` + 分维法律状态 + `PolicyImpact[]` + 条件/例外/证据 | 命令 | policy 内部 | PolicyPort |
| policy | `publicQualification(versionId, language, form)` → `{qualified, failed_conditions[], expires_at}`（单一判定函数，见 `01-domain-model.md` §3.7） | 查询 | publication（读取层视图与命令两处同源） | — |
| editorial | `listActiveSuppressions(sinceEpoch?)`、`getActiveRevision(target)` | 查询（或只读视图） | publication、events、enrichment、policy | SuppressionQuery（在 contracts，editorial 实现，组合根注入） |
| editorial | `suppress(subject, reason, expectedVersion)`、`restore(suppressionId)`、`applyReview(command)`、`assess(subject, ruleset)` | 命令 | 私有接口（内容页） | EditorialPort |
| publication | `queryFeed(filters)`、`getItem(id)`、`getPolicy(id, language?)`、`getSaved(ids)`、`search(q, filters)`、`getVersion()` 等 | 查询 | public-api 路由、reports、只读 MCP | PublicQueryPort |
| publication | `apply(changeSet, expectedWatermark?)` → 新水位（增量投影，单条一个事务；**无发布代次与清单指针 CAS**）；`rebuild(scope)` | 命令 | 各模块事件处理器、publication 内部 | PublicationPort |
| publication | `upsertReportProjection(tx, report, revision, members)` | 命令 | reports | ReportPort |
| publication | `getSiteSettings()`、`recordProductUpdate(release)` | 查询/命令 | 部署流程、私有接口 | —（A 的 site 已并入 publication） |
| reports | `ensure(type, lane, period, edition)` | 命令 | worker | ReportPort |
| ai-gateway | `invoke(capabilityId, input, permit, options{lane, purpose})` → 结果或结构化失败；`reconcile(receiptId)` | 命令 | enrichment、entities、events、policy、reports、sources、content | ModelGatewayPort（`execute`、`reconcile`） |
| ai-gateway | `getUsageSummary(month?, filters{lane, capability, source, purpose})`（已确认 / 已预留 / 未知占用 / 本地复用 / 供应商缓存；v2.1 取代 `getBudgetStatus`，无上限、无剩余额度）、`getBreakerStatus(scope?)`、`getUsageControlConfig()` | 查询 | ops、私有接口、只读运维 MCP | — |
| ai-gateway | `recoverBreaker(tx, breakerId, actor, note)`（只有负责人；写审计）、`setUsageControlConfig(tx, patch, actor, reason, expectedVersion)`（只有负责人；写审计与配置版本；无上限字段） | 命令 | 私有接口（用量与熔断页） | — |
| platform/queue | `getLaneControl(lane)`、`setLaneControl(tx, lane, switch, pause｜resume, holder, reason, expiresAt, expectedRevision)` | 查询/命令 | 各模块任务开始前、私有接口、部署保护（仅 `holder=deploy`） | — |
| platform/identity | `authenticate(req)`、`requireRole/Capability`、`login/logout`、`createAccount`、`resetPassword`、`setCapabilities`（口令 Argon2id、不回读哈希；登录限流；能力变化使旧会话失效；首个负责人仅经服务器侧一次性命令）；审计端口 `append(actor, action, target, before, after, reason, tx)`（端口定义在 contracts，由组合根注入各模块私有路由；审计写入失败回滚） | 命令/中间件 | private-api、各模块（经端口） | IdentityPort、AuditPort |
| platform/ops | `notify(alert)` → 两条独立渠道、失败重试并走第二渠道；内容不含密钥与正文 | 命令 | 各模块、ops 任务 | AlertPort |
| 所有模块 | `stats()`、`health()` | 查询 | ops（经 `HealthSource` 端口） | — |

---

## 5. 处理许可（ProcessingPermit）

```ts
type ProcessingPermit = {
  readonly __brand: "ProcessingPermit";   // 只能由 sources 构造并签名
  source_id: string;
  lane: "news" | "policy";                // 许可按业务线签发
  capability: "fetch" | "store_metadata" | "process_locally" | "store_fulltext"
            | "external_model" | "public_excerpt" | "public_summary"
            | "public_original_fulltext" | "public_translation";   // 九项（DEC-58）；第十项 syndicate_fulltext 预留，默认 unknown
  permission_version: number;
  expires_at: string | null;              // 取自带期限的补充证据；owner_declared 为 null（不设自动到期，DEC-33）
  issued_at: string;
};
```

- 需要把内容送外部模型的调用必须携带 `external_model` 许可；ai-gateway 校验签名、用途、版本与到期，缺失即拒绝并记录；许可收紧后即使缓存命中也重判使用权限（D07-ai-012）。
- 许可只证明“当时允许”；权限变更后已签发的许可在新任务中不再有效（许可版本不匹配即拒绝）；在途任务的结果写回再次核对权限版本（§3 规则 5）。
- 未知（第十项与缺少契约记录）、已被逐源收紧、带期限证据已到期、范围外用途均不可执行；只关闭该用途所在的一层。

---

## 6. 契约的版本与测试

- 每个事件与任务载荷在 `packages/contracts` 中有 Zod schema 与示例（fixture，全部为合成数据）；发布方和订阅方的测试都使用同一份 fixture。
- schema 只做追加：增加可选字段为兼容 minor；删除字段、改变含义、收紧枚举或改必填为 major，并以新事件类型或新版本并行一段时间后移除旧类型（例如 `material.enriched.v2`）。公共 DTO、内部事件、数据库迁移分别版本化，不用同一个“v2”暗示三者一致。
- 契约所有权：模块契约由模块泳道提交，追加类变更通过漂移与破坏检查即可自行合并；弃用与破坏类须架构角色批准；公共类型（ID、时间、错误体、分页）、根配置与锁文件由单一集成角色维护（D12-architecture-015）。
- CI 对契约做快照比对：删除字段、改变类型、收紧枚举会被识别为破坏性变更并要求 ADR；另有**事件目录一致性检查**：本文 §2.2 的 37 个有效类型（含 v2.1 新增，不含已废弃的两个）与 `domain-events.schema.json` 逐一对表，信封必填字段（含 `lane`、`correlation_id`）缺失即失败。
- 契约改动先入主干，provider / mock / consumer 再各自验证；可以继续独立工作，不因一个跨模块契约待定暂停全部任务。
