# legacy-editorial：旧项目离线编辑规则包（历史参考，不导入新系统）

**先看结论：本目录只作历史参考，不导入新系统，也不作为新项目的准入门。** Owner 2026-10-01 答复“全重做”（裁决表 DEC-20、DEC-42）：旧站数据与旧仓库文件一概不导入，也不从旧仓库导出任何文件。本目录的 5 个文件与标注手册只说明“某条规则出自哪里”，是写需求与行业包配置时的**参考输入**，不构成数据导入；不要把它们当规则包直接加载进加工或发布链路。

- 这里的 5 个文件是旧仓库 main（65d3624）`config/v2/editorial/` 与 `config/live/` 原文的**逐字副本**，不修改。规则包 `mining-editorial-v2-gold-v1-rc1`，清单版本 2.0.0-rc1，状态 `OFFLINE_REPLAY`；策略文件版本 1.0.0-rc1，状态 `OFFLINE_CALIBRATION`；从未上线，没有用真实样本校准。
- **不继承**：`taxonomy.v1.json` 里预筛处置的 `public_eligible` 与私有核验队列语义（参考类不公开、存疑进核验队列、`EVENT_REVIEW` 不自动发布）；`review-gates.v1.json` 的“二审硬门”不拦截任何真实矿业材料进入全部动态，只用于写作禁区与评测集；精选不再看二审硬门，按预筛、两次评分与分级门槛决定（AI-03，DEC-10；矿业版评分标准是草案，生效前须交 Owner 审阅确认，BR-SEL-09）。新系统的预筛处置以 AI-01 的“收录 / 拒绝 / 材料不足”为准。
- **旧规则包没带全，且不再取回**：共 8 个文件不在本包里——规则包清单及其 schema、金标案例 / 分类 / 原因码 / 二审硬门 4 个结构 schema、推荐理由合同（`recommendation-reason.schema.json`，`01-product/06-content-standards.md` DR-23、DR-24 的依据）、24 例金标夹具 `gold-v1.json`（旧评测集“24 → 240 → 2,400 例”扩展路线的起点）。**v2.1 起新仓库不从旧仓库取回它们，也不再核对其 SHA-256**（Owner 2026-10-01：不从旧仓库导出任何文件，DEC-42；原“建仓时取回”的步骤作废）。依赖这些文件的章节（推荐理由合同的三个必写字段、旧金标案例结构）只作背景理解；新项目的评测样本结构以 AIHOT 的 `industry/gold.example.jsonl`、`industry/relation-gold.example.jsonl` 与 `05-quality/05-evaluation-sets.md` 第 4 节为准，样本由新项目自己采集的内容标注产生。
- 使用边界、线上放宽覆盖对照、文件用法与 SHA-256 见 `../README.md` §4；写作禁区的落点见 `01-product/06-content-standards.md` 第 8 节。
