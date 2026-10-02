# B 包证据文档（`appendix/B-package-evidence/`）

> **先看结论**
> 1. **这是什么**：B 包（2026-09-29，handoff-1）的 10 份证据与设计说明原件——架构 6 份、证据 3 份、历史失败目录 1 份。v2.0 把它们收进本目录，**只作证据与对照，不是工作入口**；开发、测试、写规格一律读 v2.0 正文（第 1 节“在 v2.0 中被哪份文件承接”一列）。
> 2. **冲突以谁为准**：这些文件与 v2.0 正文冲突时，**以 v2.0 正文和 `00-decision-ledger.md` 为准**（根 `README.md` 的事实优先级）。已知的冲突与过期陈述集中列在第 4 节；发现新的，改正文，不改本目录。
> 3. **动过什么**：10 份文件除三类改动外，与 B 包原件逐字节相同：①9 处指向 B 包原目录结构的相对链接已改到 v2.0 的实际位置（第 3 节）；②`legacy-product-sources.md` 的 2 处本机绝对路径改为“路径已略”（卫生清理，D20-integrity-012）；③`historical-failure-catalog.md` 文首由坑点清单的维护者加了一段“v2.0 说明”（H→PIT 对照、证据类型、已知更正），B 原文未动。B 原文的论述与数字没有改。
> 4. **引用写法**：包内引用 B 的文件写 `B:<B 包原路径>`（如 `B:architecture/04-data-model.md`），到第 2 节的对照表里找位置；B 的编号、证据代号和字母证据等级怎么读见第 5 节。
> 5. **没有随包的 B 文件**：B 的旧仓库文件清单、工作树清单、两份校验结果、AIHOT 展开的源码树、B 的两个生成脚本和依赖清单；原因与替代见第 2 节。

---

## 1. 本目录 10 个文件：来源与在 v2.0 中的承接

“B 原件 SHA-256”取自 B 包的 `MANIFEST.sha256`，可用来确认除第 3 节所列外没有别的改动（`historical-failure-catalog.md` 另有文首新增的说明段，见第 3 节末）。

| 本目录文件 | B 包原路径 | 内容 | 在 v2.0 中被哪份文件承接 | B 原件 SHA-256（前 12 位） | 改动 |
|---|---|---|---|---|---|
| `01-aihot-assessment.md` | `architecture/01-aihot-assessment.md` | AIHOT 固定版本（885b736）的审视与复用地图：逐能力保留/改造/重写/关闭、12 条不能无审查继承的耦合、可复用测试 | `04-architecture/04-aihot-adoption.md`（“B 包 12 条耦合在本文的落点”一节逐条对应）；逐文件处置以 `appendix/B-aihot-file-inventory.md`（及 `.csv`）为准 | `b66106bc3d49` | 链接 3 处 |
| `02-target-architecture.md` | `architecture/02-target-architecture.md` | 目标架构：双业务线、运行视图、部署角色与权限、目标仓库结构、模块边界与依赖方向 | `04-architecture/01-target-architecture.md` 与 `04-architecture/03-module-map.md`（12 个业务模块 + 平台包，§2.3 有 A/B 模块名对照）；决定落在 `04-architecture/adr/` | `33ab63452b30` | 无 |
| `03-stack-decisions.md` | `architecture/03-stack-decisions.md` | 技术栈推荐、替代方案、ADR-N01～N12、骨架冻结前的基准 | `04-architecture/02-tech-stack.md`（2026-09-30 重新核查版本，T-0001 以 lockfile 为准）与 `04-architecture/adr/`（`adr/README.md` 有 B:ADR-Nnn 对应列） | `dc3cdb77662c` | 无 |
| `04-data-model.md` | `architecture/04-data-model.md` | 数据模型与写入所有权、核心数据字典、时间/金额/证据定义、唯一性与事务 | `03-data/01-domain-model.md`（ENT-xx 实体、状态机、ID 规则） | `3b6c03431d4e` | 无 |
| `05-workflows-and-state-machines.md` | `architecture/05-workflows-and-state-machines.md` | 任务链路，来源/材料/费用/事件/发布状态机，故障处置矩阵，观测要求 | `02-rules/02-core-flows.md`（流程）与 `03-data/01-domain-model.md`（状态机） | `b5b00a93c395` | 无 |
| `06-ai-and-agent-runtime.md` | `architecture/06-ai-and-agent-runtime.md` | 产品 AI 与开发 Agent 的边界、模型选择与评测原则 | `02-rules/03-ai-capabilities.md`（AI-xx）与 `05-quality/05-evaluation-sets.md`；决定见 ADR-0006、ADR-0007 与裁决表 DEC-16 | `6a73a6359447` | 无 |
| `coverage-and-baseline.md` | `evidence/coverage-and-baseline.md` | B 当时的基线、实际读到的材料、未完成的外部验证 | `appendix/A-legacy-evidence-index.md` 第 0～1 节（现基线 main@65d3624 + policy@6d37df8；B 的本地 main 基线不再使用） | `01ded71a18c9` | 链接 4 处 |
| `discussion-distillation.md` | `evidence/discussion-distillation.md` | 6 个会话与旧文档的讨论蒸馏、证据分级、必须消解的冲突 | `01-product/08-owner-voice.md`（§0 来源标记与原话表）与 `00-decision-ledger.md`（冲突的裁决） | `73694387d63c` | 无 |
| `historical-failure-catalog.md` | `quality/02-historical-failure-catalog.md`（改名） | 42 条历史失败与必须带走的反例（H-001～H-042） | `05-quality/02-pitfalls.md`（PIT-xxx；H→PIT 对照见其 2.16 节，各条“关联”行写 `B:H-nnn`）与 `05-quality/06-acceptance-scenarios.md`（T-nnn） | `78faf4d50068` | 链接 2 处；文首新增“v2.0 说明”段 |
| `legacy-product-sources.md` | `evidence/legacy-product-sources.md` | 旧项目证据索引 L01～L26（引用本地 main 1990cf5 的行号） | `appendix/A-legacy-evidence-index.md` 第 10 节（L01～L26 → 本包落点 → 行号是否仍可靠） | `f5cc7fb990cc` | 本机路径 2 处 |

---

## 2. B 包原路径 → v2.0 位置（B 包全部文件）

关系一栏：**原件在本目录** = 上表 10 个文件；**原样随包** = 与 B 原件逐字节相同；**改写承接** = 内容已按裁决改写进 v2.0 文件；**不随包** = 没有收入 v2.0；**重新生成** = 由 v2.0 的脚本生成。

| B 包原路径 | v2.0 位置 | 关系与说明 |
|---|---|---|
| `README.md` | `README.md`、`00-overview.md` | 改写承接 |
| `index.html` | `index.html` | 重新生成：`tools/build_reader.py`，不手改 |
| `MANIFEST.sha256` | `MANIFEST.sha256` | 重新生成：`tools/build_package.py` |
| `architecture/01～06-*.md`（6 份） | 本目录同名文件 | 原件在本目录；承接见第 1 节 |
| `contracts/README.md` | `03-data/contracts/README.md` | 改写承接：v2.0 对 B 契约的改造清单 |
| `contracts/openapi.json` | `03-data/contracts/openapi.json` | 原样随包，作首版输入；规范源是新仓库 `packages/contracts` 的 Zod（DEC-31） |
| `contracts/domain-events.schema.json`、`domain-event.example.json`、`examples.json` | `03-data/contracts/` 同名文件 | 原样随包 |
| `contracts/interface-behavior.md` | `03-data/contracts/interface-behavior.md` | 改写承接；v2.0 另增 `non-json-outputs.md` |
| `delivery/01-multi-agent-development.md` | `06-agents/01-parallel-development-rules.md` | 改写承接 |
| `delivery/02-implementation-roadmap.md` | `06-agents/02-roadmap-and-wbs.md` | 改写承接（里程碑 M0–M5） |
| `delivery/03-start-here-for-agents.md` | 根 `README.md`“使用方式”、`06-agents/templates/root-AGENTS.md`、`07-bootstrap/01-new-repo-bootstrap.md` | 改写承接 |
| `delivery/decisions-and-open-items.md` | `00-decision-ledger.md`（已裁定）与 `08-open-questions.md`（待 Owner） | 改写承接 |
| `evidence/aihot-source-manifest.json` | `research/aihot/aihot-source-manifest.json` | 原样随包（逐文件 SHA-256） |
| `evidence/coverage-and-baseline.md`、`discussion-distillation.md`、`legacy-product-sources.md` | 本目录同名文件 | 原件在本目录 |
| `evidence/legacy-file-manifest.json` | — | 不随包：只覆盖 B 的本地 main（821 个文件），比远端 main 少 340 个且不含法规分支；基线由 `appendix/A-legacy-evidence-index.md` 第 0～1 节承担，Owner 要求不落地旧仓库副本（DEC-42） |
| `evidence/package-validation.json` | — | 不随包：是 B 对 B 包自己的校验结果；v2.0 的校验结果是另一份文件（根目录 `evidence/package-validation.json`，由 `tools/validate_package.py` 对 v2.0 生成） |
| `evidence/reader-validation.json` | — | 不随包：B 离线阅读版的检查结果；v2.0 阅读版由 `tools/build_reader.py` 重新生成 |
| `evidence/workspace-inventory.json` | — | 不随包：42 个本机工作树的路径、分支与脏状态，含本机用户名和目录结构，不是产品证据（D20-integrity-012） |
| `product/01-product-definition.md` | `01-product/01-vision-and-positioning.md`、`00-overview.md` | 改写承接 |
| `product/02-functional-specification.md` | `01-product/02b-functional-specification.md` | 改写承接（B 的 F-001～F-051 规格卡；与 A 的 F-<域>-nn 对应见 `05-quality/07-traceability.json`） |
| `product/03-page-specification.md` | `01-product/03-reader-pages.md`、`01-product/04-private-operations.md` | 改写承接（P-xx ↔ PG-xx 对照见 `01-product/03-reader-pages.md` 的“对照表”一节） |
| `product/04-business-rules.md` | `02-rules/01-business-rules.md`，另见 `02-rules/04-time-semantics.md`、`02-rules/05-cost-and-budget.md` | 改写承接（B 的 BR-nn 作别名并入 BR-<域>-nn） |
| `product/05-policy-service.md` | `01-product/10-policy-service.md` | 改写承接 |
| `product/jurisdiction-scope.json` | `data/jurisdiction-scope.json`、`data/jurisdictions-36.json` | 改写承接：补 tier 与 news_scope / policy_scope 两个标志；另有运行用的法域字典 |
| `quality/01-acceptance-and-tests.md` | `05-quality/06-acceptance-scenarios.md` | 改写承接（T-001～T-096 编号不变，新增顺延） |
| `quality/02-historical-failure-catalog.md` | 本目录 `historical-failure-catalog.md` | 原件在本目录（改名）；H→PIT 见第 1 节 |
| `quality/03-traceability.json`、`quality/03-traceability.md` | `05-quality/07-traceability.json`、`05-quality/07-traceability.md` | 改写承接（`.json` 为规范源） |
| `research/aihot/README.md` | `research/aihot/README.md` | 改写承接 |
| `research/aihot/AIHOT-885b736….tar.gz`、`static-inventory.json` | `research/aihot/` 同名文件 | 原样随包 |
| `research/aihot/source/`（502 个展开文件，含 `LICENSE`、`NOTICE`、`AGENTS.md`、`CLAUDE.md`、`.claude/`） | — | 不展开：归档内有同名文件（如 `AIHOT-885b736…/LICENSE`）；逐文件处置见 `appendix/B-aihot-file-inventory.md`。不展开是为避免嵌套的上游 AGENTS.md / CLAUDE.md 被 Agent 当成指令加载（D20-integrity-012） |
| `templates/AGENTS.new-project.md` | `06-agents/templates/root-AGENTS.md` | 改写承接 |
| `templates/module-task.md` | `06-agents/templates/task-card.md` | 改写承接 |
| `tools/build_contracts.py`、`build_traceability.py`、`requirements-validation.txt` | — | 不随包：契约链路改为 Zod → OpenAPI（DEC-31）；追踪表以 `.json` 为规范源；校验器不依赖第三方库 |
| `tools/build_reader.py` | `tools/build_reader.py` | 改写（仅标准库） |
| `tools/validate_package.py` | `tools/validate_package.py` | 改写（仅标准库、不联网） |

---

## 3. 本目录文件里改动的链接与路径

这些链接原本指向 B 包的目录结构（`../evidence/`、`../architecture/`、`01-acceptance-and-tests.md` 等），在本目录里全部失效，所以改了。**只改链接，不改正文**；指向本包不存在的文件的，改成纯文本并注明“B 包原件，未随包”。

| 文件:行 | B 原链接目标 | 处理 | 现在指向 |
|---|---|---|---|
| `01-aihot-assessment.md:17` | `../evidence/aihot-source-manifest.json` | 改到 v2.0 位置 | `../../research/aihot/aihot-source-manifest.json` |
| `01-aihot-assessment.md:25` | `../research/aihot/source/LICENSE` | 改纯文本，注“B 包原件，未随包” | v2.0 不展开源码树；归档内有同名文件，见 `research/aihot/README.md` |
| `01-aihot-assessment.md:25` | `../research/aihot/source/NOTICE` | 同上 | 同上 |
| `coverage-and-baseline.md:16` | `workspace-inventory.json` | 改纯文本，注“B 包原件，未随包” | 不收录（含本机路径） |
| `coverage-and-baseline.md:23` | `../architecture/01-aihot-assessment.md` | 改到同目录 | `01-aihot-assessment.md` |
| `coverage-and-baseline.md:24` | `../architecture/03-stack-decisions.md` | 改到同目录 | `03-stack-decisions.md` |
| `coverage-and-baseline.md:36` | `package-validation.json` | 改纯文本，注“B 包原件，未随包” | 不收录（见第 2 节） |
| `historical-failure-catalog.md` 前言（“证据 ID 见……”一句） | `../evidence/discussion-distillation.md` | 改到同目录 | `discussion-distillation.md` |
| `historical-failure-catalog.md` 前言（同一句） | `01-acceptance-and-tests.md` | 改到 v2.0 位置 | `../../05-quality/06-acceptance-scenarios.md` |
| `legacy-product-sources.md:9,11` | 两处本机绝对路径（不是链接） | 改为“本机主工作区（路径已略）”“本机法规工作树（路径已略）” | — |

另有两处新增（不是链接改动）：其一，`01-aihot-assessment.md` 标题之后加了一行“v2.0 说明”，注明该评估已由 `04-architecture/04-aihot-adoption.md` 与 `appendix/B-aihot-file-inventory.md` 取代（上表该文件的行号已按加注后的位置给出）；其二，`historical-failure-catalog.md` 文首（标题之后、前言之前）由 `05-quality/02-pitfalls.md` 的维护者在合并时加了一段“v2.0 说明”——H→PIT 对照、证据类型、已知更正（H-012、H-015、H-031、H-036、H-009、H-013）与新增的 H-043；B 原文一字未动，该文件因此比 B 原件多 16 行，本 README 对它的定位改用文字而不用行号。

同目录内本来就有效的 6 条链接未动：`02-target-architecture.md:3` 的三条（数据模型、状态机、AI 边界）、`coverage-and-baseline.md:20,22`、`legacy-product-sources.md:15`；外部网址同样未动。

---

## 4. 已知与 v2.0 正文冲突或已过期的陈述（速查）

只列已核对的。表中“v2.0 的取值”是现行口径；正文里还有别的写法时，以 `00-decision-ledger.md` 为准。

| 本目录位置 | B 的说法 | v2.0 的取值 | 依据与落点 |
|---|---|---|---|
| `01-aihot-assessment.md:11,25`；`02-target-architecture.md:109` | 源码展开在 `research/aihot/source/`；导入时建立 `third-party/aihot/NOTICE` | 不展开源码，只带归档、清单与哈希；来源登记只用根 `NOTICE` + `UPSTREAM.md` + `upstream/aihot.lock.json`，不另设 third-party 目录 | `research/aihot/README.md`；`04-architecture/04-aihot-adoption.md` 第 6 节（上游同步与许可合规） |
| `01-aihot-assessment.md:70,105`；`03-stack-decisions.md` 的 ADR-N09 | 生产权限绑定 immutable 身份（飞书 open_id/union_id）允许列表 | 只用密码的具名账号（负责人 + 具名管理员），不接飞书登录，不排期动态码 | DEC-05；`04-architecture/04-aihot-adoption.md` 的“负责人 + 具名管理员与审计”一节；ADR-0018 |
| `01-aihot-assessment.md:69` | 飞书发送改为“仅发送通过发布规则的公开版本与明确订阅范围” | 飞书只作运行告警渠道，随首次生产部署上线；内容推送是不排期的扩展候选 | DEC-06、DEC-45 |
| `01-aihot-assessment.md:63`；`02-target-architecture.md:177`；`03-stack-decisions.md:18` | pgvector / embedding 可选 | embedding 按新增付费依赖处理，须基准证明必要并经 Owner 同意；事件召回先用确定性候选 + DeepSeek 判定 | DEC-29 |
| `01-aihot-assessment.md:58` | “预筛、评分、写作编排”重写，未点名具体内容行为 | 摘要压缩、翻译范围、译文截断、公司名规则等内容行为有必改清单 | `01-product/06-content-standards.md` §12.1；`04-architecture/04-aihot-adoption.md` 的“中文全文分段翻译与文本链路硬假设”一节 |
| `01-aihot-assessment.md:86-89` | 私有页面要有审核队列、证据对照、草稿批准或退回 | 不设日常运营台、不设审稿关卡；审稿工具默认关闭，只用于建设期抽样与标注；必要私有操作用最小私有页面 | DEC-04、DEC-14；`01-product/04-private-operations.md` |
| `02-target-architecture.md:117-133`；`04-data-model.md:15-25` | 9 个领域包 + 6 个平台包 | 12 个业务模块 + 平台包 + 独立 fetcher；模块名以模块地图为准 | `04-architecture/03-module-map.md` §2（§2.3 为 A/B 对照）；DEC-30 |
| `03-stack-decisions.md` 的 ADR-N03 | OpenAPI 3.1 作为 HTTP 规范源 | Zod schema 为唯一事实源，生成 OpenAPI 3.1、api-client 与 mock；B 的 openapi.json 只作首版输入 | DEC-31；`03-data/02-public-api-contract.md`；`03-data/contracts/README.md` |
| `03-stack-decisions.md` 的 ADR-N11 | 首期可沿 AIHOT 的 npm workspaces | 换 pnpm 12：严格依赖图直接实现模块边界 | `04-architecture/02-tech-stack.md` §1.2（“包管理与工作区”一行）；ADR-0015 |
| `03-stack-decisions.md:3` 及全文版本号 | 2026-09-29 的版本与链接 | 2026-09-30 重新联网核查；T-0001 以 lockfile 为准 | `04-architecture/02-tech-stack.md` 文首的“版本核查” |
| `04-data-model.md:39`（SourcePolicy） | 七项使用许可 | 九项（取两包并集）加 `attachments_in_scope`，带到期时间、证据与条件码 | DEC-58；ADR-0009；`01-product/07-sources-and-coverage.md` §3 |
| `04-data-model.md:87`；`05-workflows-and-state-machines.md:35` | 暂停、归档或任一变化使预览失效，激活要重验预览 | 首次启用须 24 小时内成功预览；曾启用的来源暂停后可直接恢复，不重新预览；入口或分页规则改过则须新草稿版本预览 | DEC-57；`01-product/07-sources-and-coverage.md` §4.4（明写“B 的……不采用”） |
| `discussion-distillation.md:57` | 保留人工审核，合并为“可选具名审核、异常纠错和撤回” | 无审稿关卡；审稿工具默认关闭，只用于建设期抽样与标注；异常纠错与下架保留 | DEC-14 |
| `coverage-and-baseline.md:9-10,14,20` | 证据基线是本地 main 1990cf5 与 821 个文件的清单；审计 42 个工作树 | 基线只用 main@65d3624 与 policy@6d37df8；本地 main 与远端分叉，不作依据；清单与工作树审计不收录 | `appendix/A-legacy-evidence-index.md` 第 0～1 节 |
| `coverage-and-baseline.md:38` | 校验与阅读版依赖 jsonschema、Markdown 渲染库 | v2.0 校验器与阅读版生成器只用标准库，不联网 | `tools/validate_package.py`、`tools/build_reader.py` |
| `historical-failure-catalog.md` 的 H-015 行 | “1.49 MB 法规需要完整保留”当作真实样本 | 真实样本是联邦公报 2024-06920 规则文本 1,479,755 字节（3,903 节点、118 处图件引用、268 页 PDF、处理计划约 6.36MB 且未含图件）；约 1.49MB 是旧分支自编压力件，只证明存取与重组；2MB 是旧实现的法规上限，不是产品上限 | `01-product/10-policy-service.md` F-047 与附录 A.2；`appendix/A-legacy-evidence-index.md` 第 6 节；该文件文首的“v2.0 说明”已有同样的更正 |
| `historical-failure-catalog.md` 文末“历史 55/75、指定供应商模型……”一段 | “历史 100 元预算……均不自动继承” | 月度 100 元硬限、80 元提醒（北京自然月）是 Owner 已批准并于 2026-09-26 重申的产品决定，不是待定项，也不是“旧系统基线”；只有负责人能在预算配置里明示修改 | `02-rules/05-cost-and-budget.md` BR-COST-01；DEC-08；旧ADR-0037:44@policy |
| `historical-failure-catalog.md` 文末“R04 对应……”一段 | 旧 T01–T63、K00–K20 不是新任务编号 | 法规分支编号写 POL-T01～POL-T63、POL-K00～POL-K20；B 的 T-001～T-096 保持原号 | 根 `README.md`“编号规范” |
| `legacy-product-sources.md` 全文 | 行号对应本地 main 1990cf5；L 号作证据代号 | 行号可能对不上；L01～L26 只在 A 索引第 10 节保留作对照，其他文件不得再引用 | `appendix/A-legacy-evidence-index.md` 第 10 节 |

B 在本目录之外还有 5 处同类的预算措辞（`product/01-product-definition.md`、`product/02-functional-specification.md`、`product/04-business-rules.md` 的 BR-45、`quality/01-acceptance-and-tests.md`、`delivery/decisions-and-open-items.md`），它们的 v2.0 承接文件一律以 BR-COST-01 的口径为准。

---

## 5. B 的编号、证据代号与字母等级怎么读

| B 里的写法 | 含义 | v2.0 怎么读 |
|---|---|---|
| `L01`～`L26` | `legacy-product-sources.md` 的旧项目证据行 | `appendix/A-legacy-evidence-index.md` 第 10 节 |
| `MAIN-LOCAL`、`MAIN-REMOTE-SNAPSHOT`、`POLICY-WORKTREE` | B 的三个旧仓库版本代号 | `MAIN-LOCAL`（本地 main 1990cf5）不再使用；`MAIN-REMOTE-SNAPSHOT` 即 `@main`（65d3624）；`POLICY-WORKTREE` 即 `@policy`（6d37df8） |
| `R01`～`R04`（证据 ID） | R01 = `docs/designs/mining-product-overhaul.md`；R02 = `config/v2/editorial/` 规则包；R03 = `tests/live_pipeline/`、`tests/events_v2/`、`tests/publishing/` 下被引用的测试；R04 = 法规分支 `docs/policy-upgrade/` | 不要与整改需求 `REM-R01～R15`、法规研究步骤 `POL-R01～R08` 混用；路径与行号见 A 索引第 2、6、10 节 |
| `D01`～`D07`、`H01`、`H02` | D01～D07 = B 读取的 6 个会话加本轮请求；H01 = 法规分支的 `acceptance/material-audit.json`（预期 17、取得 16）；H02 = 历史运行复盘线索 | D01～D07 在 `01-product/08-owner-voice.md` §0 写作 `B·Dnn`；H01 见 A 索引第 6 节“已验收用例与验收材料”一行；H02 只作线索，未重读原聊天，不当事实 |
| `U / A / R / H / N`（`discussion-distillation.md` 第 1 节） | 用户直接表达 / 助手归纳或方案 / 仓库文档配置测试 / 历史运行或原件核对回执 / 本包新建议 | U → 【Owner 决定】（带日期与会话来源）；A → 【设计】（助手建议，不得写成 Owner 要求）；R → 写 `路径:行号@main` 或 `@policy`，有代码无验收只能是【已实现未验证】；H → 带日期的历史记录，只有旧仓库有验收记录或线上回读才可标【已验证】；N → 【新增】或【设计】 |
| `A / B / C / D`（`legacy-product-sources.md` 第 1 节） | 本轮用户明确目标 / 历史用户要求或设计 / 静态实现或测试 / 本包新建议 | 与上一行的字母冲突（同一个 A 指“用户”或“助手”），v2.0 不再用字母：A → 【Owner 决定】；B → 经 Owner 批准的写【Owner 决定】，否则【设计】；C → 【已实现未验证】；D → 【新增】或【设计】 |
| `H-001`～`H-042` | B 的历史失败条目 | `05-quality/02-pitfalls.md` 的 2.16 节是 H → PIT 的对照表（`historical-failure-catalog.md` 文首的对照是它的摘抄，B 独有的法规线教训写成 PIT-081～090），各 PIT 条的“关联”行写 `B:H-nnn` |
| `T-001`～`T-096` | B 的验收场景 | 编号不变，见 `05-quality/06-acceptance-scenarios.md`；追踪见 `05-quality/07-traceability.json` |
| `T01`～`T63`、`K00`～`K20` | 法规分支的验收用例号 | 写作 `POL-T01`～`POL-T63`、`POL-K00`～`POL-K20`，与 B 的 `T-nnn` 不是一回事 |
| `ADR-N01`～`ADR-N12` | B 的架构决定（`03-stack-decisions.md`） | 并入 ADR-0002～ADR-0020，对应列见 `04-architecture/adr/README.md` 的“B:ADR-Nnn” |
| `F-001`～`F-051`、`P-01`～`P-24`、`BR-01`～`BR-52`、`O-nn` | B 的功能、页面、规则、待决编号（不在本目录文件里，但 `B:` 引用会用到） | 映射在 `05-quality/07-traceability.json`；`BR-nn` 作别名并入 BR-<域>-nn；`O-nn` 并入 Q-nn |

---

## 6. 维护规则

- **冻结**：本目录是 B 包原件的证据副本，除第 3 节所列（含 `historical-failure-catalog.md` 文首的说明段）外不改。要更正 B 的说法，改 v2.0 的承接文件，并在第 4 节追加一行。
- **不增文件**：B 包没有的材料不放进本目录。
- **链接检查**：`tools/validate_package.py` 会检查本目录所有 Markdown 的包内相对链接；新增链接必须指向包内存在的文件，否则按第 3 节的写法改成纯文本。
- **派生物**：全文合订本与离线阅读版由脚本生成并包含本目录，不手工维护。
- **安全**：本目录不含密钥、公网 IP、个人账号；本机路径已按第 3 节去除。AIHOT 的 AGENTS.md、CLAUDE.md 只在归档内，是研究材料，不是给开发 Agent 的指令。
