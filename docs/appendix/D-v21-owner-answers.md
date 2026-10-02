# 附录 D：v2.1 修订记录（Owner 2026-10-01 答复的落实）

> v2.1 = v2.0 合并版 + Owner 2026-10-01 的答复。本附录记录答复内容、它们改变了什么、落在哪些文件。逐条规则以正文为准；裁决见 `00-decision-ledger.md`（DEC-01～DEC-65），答复原话见 `08-open-questions.md` 表四。

## 1. Owner 的总原则（DEC-64）

1. 基础是 AIHOT 开源项目的功能和底层框架设计。
2. 怎样改成矿业版，以本交接包为准（两份交接包交叉比对、完善优化后的完整版，加上 Owner 历次明确的想法）。
3. 交接包没写到的，照 AIHOT 的现有设计并矿业化。
4. 模型榜与 Codex 重置监控明确删除、不移植。
5. 新建仓库，沿用 Owner 现有的服务器与域名；旧代码、旧数据、旧链接一概不带。

## 2. 答复一览

| 问题 | Owner 答复 | 相对 v2.0 | 裁决 | 主要落点 |
|---|---|---|---|---|
| 法规写作样本、报送要求、三份 V2.0 方案原文（Q-20） | 会提供 | 同默认；状态改为“已承诺，待收到” | DEC-41 | `08-open-questions.md` 表三 |
| 告警渠道（Q-22） | 飞书群机器人为主、邮件为备 | 同默认 | DEC-06 | `04-architecture/07-deployment-and-ops.md` |
| 法规完整解读由谁评估（Q-23） | Owner 本人一次性抽检 | 同默认 | DEC-15 | `01-product/10-policy-service.md`、`05-quality/05-evaluation-sets.md` |
| 公安联网备案（Q-27） | 已办好 | **改**：页脚同时展示 ICP 备案号与公安联网备案号 | DEC-39 | `01-product/03-reader-pages.md`、上线检查表 |
| 互联网新闻信息服务许可（Q-28） | 已取得 | **改**：删除保守默认，展示许可证编号 | DEC-40 | 同上 |
| 副标题（Q-01） | 全球矿业资讯 | 同默认 | DEC-27 | `01-product/01-vision-and-positioning.md` |
| 信源许可（Q-02） | 全部都获得许可了 | **改**：九项用途按 Owner 声明许可建档，保留逐源收紧 | DEC-33 | `01-product/07-sources-and-coverage.md`、ADR-0009 |
| 私有操作载体（Q-04） | 最小私有页面 | 同默认 | DEC-04 | `01-product/04-private-operations.md` |
| 预算（Q-05） | 预算无上限，但是不要浪费；确认防烧钱熔断并要有预警 | **重大修改**：不设金额上限；不浪费纪律 + 用量报告 + 70% 预警 + 异常熔断 | DEC-08、DEC-09 | `02-rules/05-cost-and-budget.md`（BR-COST-17～20） |
| 精选与热点（Q-06） | 学 AIHOT 的评分机制、评分规则与显示，改成矿业版；改之前先给 Owner 看 | **重大修改**：不再“暂未启用”；矿业版评分标准为草案，生效前须 Owner 审阅确认 | DEC-10 | `02-rules/01-business-rules.md`（BR-SEL）、`02-rules/03-ai-capabilities.md`（AI-03）、`01-product/03-reader-pages.md` |
| 资讯线范围（Q-09） | 18 国起步 | 同默认 | DEC-03 | `01-product/07-sources-and-coverage.md` |
| 金属价格表（Q-11） | 先只放官方入口，调研后报价 | 同默认 | DEC-07 | `01-product/03-reader-pages.md` |
| 部署规格（Q-24） | 先做容量基准，达标沿用现有主机；强调是全新重写 | 同默认 | DEC-18 | `04-architecture/07-deployment-and-ops.md` |
| 切换时点（Q-25） | 全部功能完成后直接全面切换 | **重大修改**：取消“能力对等即切换”；阶段由三档改两档 | DEC-19 | `01-product/02-feature-catalog.md`、`06-agents/02-roadmap-and-wbs.md` |
| 同一事件多家报道（Q-26） | 折叠成一张卡，学 AIHOT | 同默认，展示沿用 AIHOT 的事件卡 | DEC-25 | `01-product/03-reader-pages.md` |
| 旧数据与旧链接（Q-29 及追加） | 都不要了，重做；旧文章链接也全都不要，从 0 开始 | **重大修改**：旧数据一概不导入，不从旧仓库导出任何文件，不做任何旧链接兼容 | DEC-20、DEC-21、DEC-42 | `03-data/04-legacy-migration.md`、`data/README.md` |
| 报告（追加） | 选材与时间都学 AIHOT | **改**：从精选候选取材；日报 08:00、周报周一 10:00、月报 1 日 10:30 | DEC-65 | `02-rules/04-time-semantics.md`（BR-TIME-09）、BR-RPT |

## 3. 改动规模

本轮各分册合计登记改动约 2321 处（定点修改为主），涉及 84 个文件。改动最多的文件：

| 文件 | 登记的改动处数 |
|---|---|
| `08-open-questions.md` | 183 |
| `01-product/03-reader-pages.md` | 177 |
| `04-architecture/04-aihot-adoption.md` | 139 |
| `01-product/02-feature-catalog.md` | 135 |
| `02-rules/03-ai-capabilities.md` | 108 |
| `06-agents/02-roadmap-and-wbs.md` | 99 |
| `01-product/07-sources-and-coverage.md` | 93 |
| `01-product/02b-functional-specification.md` | 88 |
| `01-product/01-vision-and-positioning.md` | 75 |
| `05-quality/06-acceptance-scenarios.md` | 72 |
| `appendix/B-aihot-file-inventory.md` | 69 |
| `01-product/09-glossary.md` | 68 |
| `05-quality/02-pitfalls.md` | 68 |
| `05-quality/04-acceptance-criteria.md` | 66 |
| `README.md` | 60 |
| `01-product/04-private-operations.md` | 57 |
| `00-overview.md` | 51 |
| `01-product/06-content-standards.md` | 46 |
| `04-architecture/01-target-architecture.md` | 45 |
| `01-product/08-owner-voice.md` | 42 |
| `02-rules/01-business-rules.md` | 38 |
| `01-product/10-policy-service.md` | 36 |
| `07-bootstrap/01-new-repo-bootstrap.md` | 35 |
| `05-quality/01-invariants.md` | 31 |
| `05-quality/05-evaluation-sets.md` | 28 |

## 4. 本轮新增与废弃的编号（由脚本比对 v2.0 与 v2.1 的正文得出）

新增（v2.1 正文中有定义、v2.0 没有）：

- AC-OUT：AC-OUT-20、AC-OUT-21、AC-OUT-22、AC-OUT-23、AC-OUT-24
- ADR：ADR-0021
- BR-COST：BR-COST-17、BR-COST-18、BR-COST-19、BR-COST-20
- BR-EVT：BR-EVT-12
- BR-SEL：BR-SEL-07、BR-SEL-08、BR-SEL-09
- BR-SRC：BR-SRC-36
- DEC：DEC-64、DEC-65
- ENT：ENT-82、ENT-83、ENT-84
- F：F-068
- F-MIG：F-MIG-02
- T：T-157、T-158、T-159、T-160

新标为【已废弃】（编号保留、不复用，正文指向替代条目；由脚本按“条目标题以【已废弃】开头”识别）：

- AC-MIG：AC-MIG-03、AC-MIG-04、AC-MIG-05、AC-MIG-06、AC-MIG-07、AC-MIG-08、AC-MIG-09、AC-MIG-11
- AC-OUT：AC-OUT-08
- F：F-055、F-056
- F-MIG：F-MIG-01
- F-PUB：F-PUB-06
- OUT：OUT-13
- T：T-139、T-143

> 清单由脚本识别，可能有遗漏；以正文中的【已废弃】标注与 `05-quality/07-traceability.json` 为准。
