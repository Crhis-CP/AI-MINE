# 附录 A：旧项目证据索引（v2.0）

> **结论先看**：本索引把旧仓库证据统一锚定到两个固定版本，并回答三件事：某条规则的旧证据在哪个文件、旧决定现在是否仍然有效、B 包引用的旧文件行号还能不能信。只用于核对“某条规则从哪里来”，**不作为新项目的工程参考**；新项目 Agent 不需要读旧代码，只有规格表述不清、需要确认旧行为时，由架构 Agent 或质量 Agent 按本索引查阅。
> 旧仓库 `Crhis-CP/global-mining-policy-intelligence`，**只在线读取，严禁克隆，严禁把内容写入磁盘**（裁决表 DEC-42）。路径均相对旧仓库根目录。
> 引用写法见 `README.md`“引用规范”：`路径:行号@main`、`路径:行号@policy`，文件级引用写 `路径@main`；旧 ADR 写“旧ADR-00nn”；整改需求写“REM-Rnn”；法规分支的 T/R/D 编号写 POL-T/POL-R/POL-D。本包**不再使用** B 包的证据代号 L01～L26（对照见第 10 节），也不使用指向包外蒸馏报告的 `B2·`、`A2·`、`INT-` 一类编号（处置见第 11 节）。

## 0. 两个基线版本

| 代号 | 版本 | 状态 | 规模（2026-09-30 在线核对） |
|---|---|---|---|
| `@main` | 远端 main `65d362407226da856f66477807c5437acf1af27b`（PR #179，2026-09-21 合并；tree `05973a5f005ab3c4734cc348c86fd8fca29e2276`） | **现网生产版本**；含旧ADR-0001～0036 | 1,161 个文件；36 份 ADR；`services/` 下 20 个目录；迁移 0001～0028 |
| `@policy` | 分支 `codex/policy-upgrade-v2` `6d37df802b7b7ff14ed9b34436166c7eb60a9b76`（2026-09-27；tree `188bc252e228898f5e6d5cdfd24ff5d9e27e668c`） | **草稿 PR #180（open，draft，27 个提交，195 个变更文件）**：Owner 已于 2026-09-26 批准实施（旧ADR-0037、旧ADR-0038）；**旧分支部分实现，未合并，未部署，0 次真实模型调用**（`docs/policy-upgrade/status.md:131,136,291@policy`）；生产仍是 `65d3624` | 1,325 个文件：比 main 多 165 个（`services/policy_intelligence/` 37、`tests/policy/` 36、`docs/policy-upgrade/` 30、迁移 0029～0038 共 20、`config/policy/` 9 等），少 1 个（`apps/web/next-env.d.ts`）；38 份 ADR；`services/` 下 21 个目录 |

- **统计口径（2026-09-30 统计，2026-10-01 在线复核无变化）**：旧仓库编号 #1～#180 共 123 个 PR 和 57 个 Issue。PR：119 个已合并、2 个关闭未合并（#53、#63）、2 个仍开放的草稿（#40 `docs(governance): audit vNext knowledge conflicts`，#180 即法规分支）；Issue：6 个开放（#41、#50、#67、#103、#131、#138）。本包所有“约 N 个 PR”的说法以此为准。（v1.0 起草时曾把 #40 记为已关闭；复核为开放草稿，已更正。）
- **其他分支**：旧仓库另有 8 个早期分支（`codex/docs-runtime-truth-sync`、`codex/repo-foundation`、`codex/repository-foundation`、`codex/source-ar-official-bulletin-html-canary`、`cursor/oidc-sts-param-alignment`、`cursor/oidc-tat-harmless`、`cursor/tat-host-tools-retry`、`cursor/vnext-governance-3d93`）：领先 main 0～4 个提交、落后 47～118 个提交，内容是仓库基础文件、文档对账、部署演练和治理审计，**不作为依据**；其中 `cursor/oidc-sts-param-alignment`、`cursor/tat-host-tools-retry`、`cursor/vnext-governance-3d93` 分别是 PR #53、#63、#40 的分支。
- **不再使用的基线**：B 包曾以本地工作区 main `1990cf5` 为证据基线，该工作区与远端分叉（远端独有 24 个提交，B 自己在 `coverage-and-baseline.md` 写明），**不作依据**。
- 分支一旦清理即永久丢失：该分支的研究数据不导入，也不从旧仓库导出任何文件（Owner 2026-10-01“都不要了，重做”，DEC-42）；本索引只记录“某条规则出自哪里”，不构成数据导入。

## 1. 基线核对结果（为什么重新锚定）

| 核对项 | 结果 | 处理 |
|---|---|---|
| v1.0 索引引用的旧仓库路径 | 逐项对照 main 与 policy 的完整文件树：**全部存在于 @main**，唯一例外是 `docs/policy-upgrade/*`，它**只在 @policy**；`data/…` 是本包路径；“只读 MCP”一行指向的 `gmpi-readonly-mcp` 是**不在旧仓库内的独立项目**（旧仓库只在 `infra/tencent-cloud/scripts/validate_live_topology.py:20@main` 引用其网关容器名） | 法规分支路径一律标 `@policy`；独立项目单独标注 |
| v1.0 索引引用的 PR、迁移号 | PR #130～#180 与迁移 0006～0028 全部存在；PR 类型核对无误。`05-quality/02-pitfalls.md` 的 PIT-060 引用的 `#103` 是**开放的 Issue 而不是 PR**，须写“Issue #103” | 其余保持；#103 已列入第 11 节处置 |
| v1.0 索引遗漏的区域 | 遗漏 `db/`（67）、`tests/`（349）、`infra/`（67）、`prototypes/`（32）、`.github/`（19）等目录和 ADR 0033～0036 的具体文件名 | 第 2～5 节补入；第 9 节列迁移号对照 |
| B 包的旧仓库基线 | B 的 `legacy-file-manifest.json` 只有本地 main 的 821 个文件哈希，比 `@main` 少 340 个（含 ADR 0033～0036），且不含 `@policy` 的任何文件；B 的 `validate_package` 只校验 AIHOT 的 502 个文件，**不校验旧仓库基线** | 本包不随包带该清单（Owner 要求不落地旧仓库副本，DEC-42）；基线由本索引承担：本索引引用的每个旧仓库路径与行号范围都已在线逐项核对（第 12 节）。脚本化的基线核对（只登记所引路径的 ref、git blob 与行数，不含内容）列为对 `tools/validate_package.py` 的请求，见变更日志 |
| B 的 L01～L26 引用的 main 侧文件（不含 ADR 0034～0036）共 32 个 | **11 个内容与 B 的清单一致，19 个已变，2 个不在 B 的清单**（`README.md` 现只有 72 行，B 引用的 51～103 行已不存在；ADR 0033 是 B 之后新增）；政策分支侧 11 个文件的引用行号均在文件行数范围内，提交相同 | 第 10 节逐条给出“行号是否仍可靠”；行号已变的只按主题和测试名定位 |

## 2. 产品定义与决策

| 主题 | 旧证据 | 旧状态（2026-09-30 核对） | 本包落点 |
|---|---|---|---|
| 批准的目标任务书（运营后台化、极简添加信源、AI 扩源、模型路由、成本分层、收录四类、REJECTED≠LOW、影响五维、政策阶段、政策线、可发布门、异常式人工审核、数据分区与生命周期、黄金集） | `docs/architecture/vnext/approved-target-brief.md`@main（2,651 行） | Owner 批准的设计输入，多数未实现；运营台/管理员章节被旧ADR-0037:21-22@policy 限缩；“增量演进不推倒重写”被 2026-09-29 重建决定取代 | 各 `F-`/`BR-`/`OP-` 规格；`04-architecture/03-module-map.md` §10 末行 |
| 自动情报流程、纯密码具名账号、下架持久 | 旧ADR-0031：`docs/architecture/decisions/0031-automatic-live-intelligence.md:65-78@main` | 已上线；自动公开、月度预算、下架持久沿用；独立管理域名与账号机制被旧ADR-0037 取消（第 7 节） | ADR-0006、ADR-0011、`02-rules/05-cost-and-budget.md`、DEC-05 |
| 综合矿业资讯完整改版 | 旧ADR-0032：`docs/architecture/decisions/0032-mining-news-product-overhaul.md@main`；`docs/designs/mining-product-overhaul.md`@main（123 行：R01～R15 在 `:9-29`，“不能缩减的验收”在 `:41-55`，并行接口约定自 `:57` 起） | 部分上线；阶段顺序被旧ADR-0033 取代，18 国上限被旧ADR-0037 取代 | `01-product/03-reader-pages.md`、DEC-61 |
| 连续中文阅读、宽收录、精选延后 | 旧ADR-0033：`docs/architecture/decisions/0033-reader-recovery-and-stage-one.md:13-21@main` | 已上线；精选/聚簇延期被旧ADR-0034 取代 | DEC-13、DEC-35 |
| 新闻生产链路整改 REM-R01～R15 | 旧ADR-0034：`docs/architecture/decisions/0034-event-production-remediation.md:3-24@main`；`docs/designs/mining-product-overhaul.md:9-29@main` | Owner 2026-09-20 批准实施；部分实现 | 逐条映射见第 8 节 |
| 读取容量（整站快照 12MiB 上限） | 旧ADR-0035：`docs/architecture/decisions/0035-measured-reader-capacity.md:8-26@main` | 已上线（**反面教材**：7.7MB 整站快照冷读 12.0 秒） | ADR-0004、PIT-037、PIT-057 |
| Hermes 受控内容处理与审稿台 | 旧ADR-0036：`docs/architecture/decisions/0036-hermes-reviewed-content.md:13,24,30,34@main`；PR #176、#177 | 已上线接线，试验未形成可用结果；Hermes 与人工审稿依赖被旧ADR-0037 取消；准入边界、精选权重待初稿、系统盘 <20GB 沿用 | DEC-10、DEC-12、DEC-14 |
| 统一法规阅读与全目标法域 | 旧ADR-0037：`docs/architecture/decisions/0037-policy-intelligence-all-jurisdictions.md:3-7,16-24,28-39,44-45@policy`；`docs/policy-upgrade/requirements.md:7-21@policy` | **Owner 2026-09-26 批准实施；旧分支部分实现、未合并、未部署**；现行最新口径 | ADR-0016、ADR-0018、DEC-01～DEC-04；`01-product/10-policy-service.md` |
| 不依赖 GitHub Actions 的验证与交付 | 旧ADR-0038：`docs/architecture/decisions/0038-provider-independent-delivery.md:3-13,19-29,45@policy`；`docs/policy-upgrade/actions-transition.md@policy` | **Owner 2026-09-26 批准实施**；旧仓库 Actions 已于 2026-09-26 停用（`:15`）；旧生产服务器仍只接受历史 Actions 签发身份（`:38-40`），与新仓库无关 | ADR-0017、ADR-0014、DEC-17 |
| 报告按北京时间周期 | 旧ADR-0011：`docs/architecture/decisions/0011-beijing-reporting-time.md@main` | 已上线；现行口径 | ADR-0010、`02-rules/04-time-semantics.md` |
| 可插拔采集与 Agent 边界 | 旧ADR-0012：`docs/architecture/decisions/0012-pluggable-acquisition-agent-boundary.md@main` | 部分有效（Hermes 禁令几经变更，最终生产不依赖 Agent） | DEC-16、ADR-0019 |
| 信源处理台账（321 条） | 旧ADR-0029：`docs/architecture/decisions/0029-source-onboarding-ledger.md@main`；`config/sources/onboarding-ledger.json@main` | 台账存在；数字是 2026-08-27 快照 | F-SRC-06、BR-SRC-01 |
| 四层内容权限 | 旧ADR-0030：`docs/architecture/decisions/0030-p4-content-processing-boundary.md@main` | 仍有效；对经审定来源的公开口径已被旧ADR-0031～0033 放宽 | ADR-0009 |
| 中国大陆部署与合规门禁 | 旧ADR-0006：`docs/architecture/decisions/0006-mainland-tencent-cloud.md:10,19-25@main`；`docs/runbooks/production-deployment.md:558-559@main` | 合规门禁仍有效（ICP 备案、公安联网备案、页脚展示）；云产品映射已缩减 | ADR-0012、DEC-18、DEC-39 |
| **其余 ADR 的现行性** | 旧ADR-0001～0038 全部 | 现行/部分有效/已被取代/仅教训，逐条见 **`04-architecture/03-module-map.md` §10**（旧 `docs/architecture/README.md` 索引只到 0030 且状态列误导，不作依据） | 同左 |

## 3. 信源与采集

| 主题 | 旧证据 | 本包落点 |
|---|---|---|
| 原始信源表目录与进度 | `config/live/source-intake-catalog.json@main`（SHA-256 `7859cdb2…`）、`config/live/source-integration-progress.json@main`（本包 `data/source-targets-320.*`、`data/source-records-321.csv` 由此在线核对后重建） | `data/README.md` §2 |
| 18 国范围与候选 | `config/live/country-coverage.json@main`、`docs/source-policy.md@main`（旧 18 国是**历史子集**，不再是覆盖上限） | `data/jurisdictions-36.json`、`data/countries-18.json`（历史子集）；DEC-03 |
| 已审定的许可范围与升级规则（38 项配置、8 项范围升级、2 项草稿修复） | `config/live/reviewed-initial-sources.json`、`config/live/source-scope-upgrades.json`、`config/live/source-draft-repairs.json`@main | 只登记出处；配置不导入（Owner 2026-10-01：全重做，DEC-42），仅作经验参考；说明见 `03-data/04-legacy-migration.md` |
| 第一代官方注册表与候选（31 个已核身份的官方来源、6 个采集画像、48 个候选） | `config/sources/registry.json`、`config/sources/acquisition-profiles.json`、`config/live/country-coverage.json`、`config/sources/candidate-observations.json`、`config/sources/onboarding-ledger.json`@main | 只登记出处；不导入（Owner 2026-10-01：全重做，DEC-42），仅作经验参考 |
| 配置保存、预览门、启用条件、暂停后恢复 | 迁移 0010、0028；PR #178（预览改走采集 worker；曾启用的来源预览失败后可恢复，首次启用仍须成功预览） | DEC-57 |
| 自动接入不覆盖人工设置（控制令牌） | 迁移 `db/migrations/0014_source_intake_directory.up.sql:98-114@main`、`db/migrations/0018_reviewed_source_scope.up.sql:75-125@main`；PR #146 | BR-SRC、INV-05 |
| 网络安全（同主机重定向、公网地址校验、大小上限、gzip） | `services/ingestion/network.py@main`；PR #130（同主机重定向）、#143（有界 gzip 解码） | `04-architecture/06-security-and-access.md`、ADR-0019 |
| 调度、追赶、回填窗口 | `services/live_pipeline/worker.py@main`、`services/live_pipeline/source_ingestion.py@main`；PR #161 | `01-product/07-sources-and-coverage.md` 调度与回填；DEC-61 |
| 中国政府网站分页与正文判定 | `services/live_pipeline/cn_provincial.py@main`、`services/live_pipeline/central_ministries.py@main`、`services/live_pipeline/provincial_reading_scope.py@main`；PR #155、#165、#166 | F-SRC-07、F-MAT-03 |
| 澳大利亚立法版本规则 | `services/live_pipeline/au_legislation.py@main`；PR #154 | BR-MAT-17 |
| 终态结果保留 | PR #152 | BR-SRC |
| 法规线来源研究（36 个对象、114 个研究来源、三份运行契约） | `config/policy/*@policy`（见第 6 节） | 只登记出处；研究数据不导入、从空台账重做（DEC-42）；`01-product/10-policy-service.md` §3 |

## 4. 内容加工、事件与报告

| 主题 | 旧证据 | 本包落点 |
|---|---|---|
| 宽收录与黑名单准入 | `services/live_pipeline/relevance.py@main`；PR #153、#168、#173；旧ADR-0036:13@main（纯获奖/参会/空预告不因发布方准入） | BR-ENR-01、DEC-12 |
| 单次中文整理提示词 | `services/live_pipeline/translation_model.py@main` | AI-04、AI-05 |
| 分段翻译与续接、完整性判定 | `services/live_pipeline/translation.py@main`、`services/live_pipeline/processing.py@main`；PR #156、#165 | F-ENR-04、DR-30/DR-31 |
| 坏译文剔除 | PR #167、#168 | DR-35 |
| 原生中文直出 | PR #160、#162 | F-ENR-03、INV-13 |
| 公司中文名词表 | `config/live/company-reference.v1.json@main`（只有 2 家） | `data/legacy-editorial/company-reference.v1.json`；DEC-37 |
| 事件召回与裁决 | `services/live_pipeline/event_association.py@main`、`services/live_pipeline/store.py@main`；迁移 0025 | F-EVT-02、INV-23 |
| 精选规则演变（旧 55/75 公式只作离线基线） | PR #132、#140、#156、#158；旧ADR-0036:13@main | DEC-10；F-SEL-01～03 |
| 报告汇总与 AI 综合 | `services/live_pipeline/reader.py@main`、`services/live_pipeline/report_synthesis.py@main`；迁移 0020；PR #164 | F-RPT-01～03 |
| 离线校准的编辑规则包（九类、预筛处置、Q/I/E/H、硬门） | `config/v2/editorial/*@main`（11 个文件；24 例金标 `tests/fixtures/v2/editorial/gold-v1.json@main`）；状态 `OFFLINE_REPLAY`/`OFFLINE_CALIBRATION`，**未上线、从未用真实样本校准** | `data/legacy-editorial/`（5 个文件随包，历史参考、不导入新系统；其余 8 个文件不取回）；使用边界 `data/README.md` §4.2 |

## 5. 成本、发布、运营与安全

| 主题 | 旧证据 | 本包落点 |
|---|---|---|
| 月度预算、预留、未知费用 | `db/migrations/0008_live_pipeline.up.sql:89-184@main`（`monthly_budget`、预留函数）；`services/live_pipeline/model.py@main`、`services/live_pipeline/model_policy.py@main` | BR-COST-01～05、INV-14/15 |
| 回执先落库再结算、有界重试 | 迁移 0024；PR #167、#177 | BR-COST-03/04 |
| 整站快照发布与下架闭包（反面教材） | 迁移 0008、0013、0026；旧ADR-0035 | ADR-0004、PIT-037/057 |
| 读取缓存与冷读问题 | PR #174、#175；`docs/reviews/reader-capacity-benchmark-20260920.json@main` | `04-architecture/07-deployment-and-ops.md` §7 |
| 产品更新登记 | 迁移 `db/migrations/0017_product_release_notes.up.sql@main`、`services/live_pipeline/release_notes.py@main`；`config/live/product-update.json@main`；PR #153（建立登记）、#157（后续条目） | F-RDR-14、INV-28、DR-90 |
| 失败与人工审核分离 | `services/live_pipeline/operations.py@main`；PR #157（运营台把处理失败与人工审核分开） | BR-EDT-02 |
| 管理员账号与会话 | 迁移 0006、0009（纯密码账号）；PR #94/#96/#98/#101/#102/#136；**Issue #103 仍开放**（原子二次验证与会话轮换，未做） | DEC-05、`04-architecture/06-security-and-access.md` |
| 公开站隔离（私有路径 404、剥离 Cookie） | 旧ADR-0028；`infra/tencent-cloud/caddy/Caddyfile.live@main` | INV-25 |
| 生产审计与存储审计（2026-09-20） | `docs/reviews/product-production-audit-20260920.md`、`docs/reviews/storage-retention-20260920.md`@main（停更 5 天无人察觉，见 DEC-06） | DEC-06、F-OPS-03 |
| 服务器与系统交接说明（小白版 + 专业版、Owner 操作清单、不含值的凭据清单） | `docs/runbooks/AI矿策服务器与系统交接说明.md:15-20,22-154,303-345,347-449@main`；`CHANGELOG.md:91-101@main`（Issue #119 已关闭） | `01-product/04-private-operations.md` §8.1、`04-architecture/07-deployment-and-ops.md` §8 |
| 旧 E2E 规格（13 份 Playwright） | `apps/web/e2e/*.spec.ts@main`（`public-web-v2`、`public-web`、`reader-mobile`、`reader-attribution`、`reader-featured`、`reader-translation`、`feed-time`、`report-generation`、`product-updates` 为读者站；`admin-live`、`model-config`、`source-intake`、`content-review` 面向旧运营台，只迁必要私有操作的断言）；版本 `apps/web/package.json:36-37@main` | `04-architecture/02-tech-stack.md`“旧 E2E 规格迁移” |
| 只读 MCP | **独立项目 `gmpi-readonly-mcp`，不在旧仓库内**；旧仓库仅在部署脚本里引用其网关容器名 | `F-OPS-04`、`F-PUB-04` |
| 部署与交付工具 | `infra/tencent-cloud/*`（65 个文件）、`.github/workflows/*`（17 个，Actions 已停用）、`scripts/*`@main | `04-architecture/07-deployment-and-ops.md`；只作旧拓扑参考，不继承 |
| 设计原型 | `prototypes/public-web-v2/*@main`（32 个文件） | 不作依据；视觉以 `01-product/03-reader-pages.md` 为准 |

## 6. 法规分支专表（全部 `@policy`，提交 `6d37df8`）

**事实边界先说清**：分支上的设计与实现是“旧分支部分实现（【已实现未验证】）”，不是已上线行为；真实质量资格、全范围取得数量、真实模型语义验收均为空（`docs/policy-upgrade/status.md:131,136@policy`）。研究文件自述不保存第三方法规全文，仅保存自写研究摘要、身份与链接（合计约 1.1 MB）。

| 资产 | 路径（@policy） | 能证明什么 / 不能证明什么 | 本包落点 |
|---|---|---|---|
| 13 条决定（POL-D01～D13） | `docs/policy-upgrade/requirements.md:7-21` | 证明 Owner 2026-09-26 批准的需求；不证明已实现 | 第 7 节；`01-product/10-policy-service.md` §0.2 |
| 范围底表（36 个对象）与三份 V2.0 方案的哈希 | `config/policy/scope.json:5-18`（文件名与 SHA-256）；`config/policy/jurisdictions.json`（36 对象 + 321 条 `legacy_mappings` + 257 条证据） | 证明范围与映射；**三份 V2.0 原文不在旧仓库也不在本包**（`08-open-questions.md` 输入卡） | `data/jurisdiction-scope.json`、`data/jurisdictions-36.json` |
| 发布体系研究与研究来源 | `config/policy/sources.json`（114 条，全部 `research_only`）、`config/policy/research-americas.json`、`config/policy/research-asia.json`、`config/policy/research-africa-europe.json`（各 12 个对象）、`docs/policy-upgrade/source-research.md`、`docs/policy-upgrade/research/*.md` | 研究起点；来源 HTTP 成功不授予使用权限 | 只登记出处（研究数据不导入、从空台账重做，DEC-42）；`01-product/10-policy-service.md` §3 |
| 三份运行契约（默认禁用） | `config/policy/runtime-contracts.json` | 格式契约起步值；US-FR 仍无运行契约 | `01-product/10-policy-service.md` 附录 A.4 |
| 材料处理、解读、调度、周月汇总、历史阅读 | `docs/policy-upgrade/material-processing.md`、`docs/policy-upgrade/interpretation-runtime.md`、`docs/policy-upgrade/service-scheduling.md`、`docs/policy-upgrade/period-reports.md`、`docs/policy-upgrade/historical-reading.md`、`docs/policy-upgrade/publication-runtime.md`、`docs/policy-upgrade/reader-runtime.md`、`docs/policy-upgrade/language-reading.md`、`docs/policy-upgrade/official-identities.md`、`docs/policy-upgrade/paged-catalogues.md`、`docs/policy-upgrade/catalogue-runtime.md`、`docs/policy-upgrade/content-runtime.md`、`docs/policy-upgrade/runtime-materials.md` | 设计与实现说明；其中旧限额与分段大小是实现值，不继承 | `01-product/10-policy-service.md` §5～§8 |
| 退出运营台 | `docs/policy-upgrade/operations-exit.md:1-45` | 保来源配置/人改/账单/反馈/服务身份/恢复；不把删页面当作消除人工依赖；不用共享新闻暂停控制法规 | DEC-04、DEC-34；`01-product/04-private-operations.md` |
| 已验收用例与验收材料 | `docs/policy-upgrade/acceptance/cases.json`、`docs/policy-upgrade/acceptance/material-audit.json:1-8,300-302`（预期 17 份、取得 16 份、F17 缺失） | 历史核对记录；不证明已读全部原件 | DEC-41；`01-product/10-policy-service.md` 附录 B |
| 真实取得实验 | `docs/policy-upgrade/status.md:129-136`（真实 HTTPS 取得官方原件：加拿大英法 2 份结构完整材料；美国 Title 30 保存原件但有 86 项未决、不晋升材料；0 次模型调用、0 次公开）、`docs/policy-upgrade/federal-register-originals.md:10-19`（联邦公报 2024-06920：3,903 节点、1,479,755 文本字节、118 处图件引用；官方 PDF 268 页 12,093,983 字节） | 只证明格式与容量实测；本机 OCR 漏单元格，不接为合格附件 | `01-product/10-policy-service.md` 附录 A；PIT-（容量） |
| 法规服务实现 | `services/policy_intelligence/*`（37 个文件）、`tests/policy/*`（36）、迁移 0029～0038 | 旧分支实现；344 项法规回归通过是自编数据上的软件验证，不是真实模型质量结论（`docs/policy-upgrade/status.md:289-291@policy`） | 只作参考，不继承代码 |
| 交付与验证 | `docs/policy-upgrade/actions-transition.md`、`docs/policy-upgrade/delivery-audit.md`；`scripts/release_signature.py`、`scripts/verify_revision.py`、`scripts/verify_supply_chain.py`；`tests/delivery/*` | 旧仓库脱离 Actions 的验证与签名实现 | ADR-0017；旧ADR-0038 |
| 入口与阅读器现状 | `apps/web/components/reader/shell.tsx:29-30@policy`（侧栏紧随“矿业日报”的“法规政策动态”）；`docs/policy-upgrade/reader-runtime.md` | 证明旧分支入口位置，支持 DEC-02 | PG-19 |

## 7. 旧 Owner 决定条款沿用表

“沿用”= 原样纳入；“改写后沿用”= 保留意图、改变载体或数值；“失效”= 已被取代，不得再引用为依据。本包落点一栏只给入口，细则以落点文件和裁决表为准。

### 7.1 POL-D01～POL-D13（`docs/policy-upgrade/requirements.md:7-21@policy`；Owner 2026-09-26 批准，D13 于 09-27 补充）

| 编号 | 决定 | 沿用情况 | 本包落点 |
|---|---|---|---|
| POL-D01 | 公开行业服务：不用内部项目、谈判或特定企业事实 | 沿用 | `01-product/10-policy-service.md` §1.1；DEC-11 |
| POL-D02 | 条件明确：地区、主体、活动、条件、例外、直接/间接作用 | 沿用 | BR-POL-13 |
| POL-D03 | 不设运营台：正常供稿无逐条选稿、审批、翻译、重试、发布操作 | 沿用；必要私有操作以“最小私有页面”承载，不设总览、审稿关卡、审计页 | DEC-04、ADR-0018 |
| POL-D04 | 先官方体系研究：每个目标执行 POL-R01～R07，POL-R08 另证真实运行 | 沿用 | `01-product/10-policy-service.md` §3 |
| POL-D05 | 法规政策动态：沿用现有 UI，在矿业日报下提供独立栏目 | 沿用 | DEC-02、PG-19 |
| POL-D06 | 一份事实多种阅读：动态与条款解读共用文书，周月汇总绑定合格版本 | 沿用 | BR-POL-14 |
| POL-D07 | 法规业务优先：与新闻准入/暂停/优先级隔离 | 沿用；预算调剂顺序为“法规 > 官方一手 > 其他” | DEC-01、DEC-08、DEC-34 |
| POL-D08 | 原文、完整中文、解读：全文含必要附件；官方中文与 AI 辅助译文区分；摘要不计全文 | 沿用，并同样适用于资讯线外文新稿 | DEC-35、BR-POL-12、DR-95 |
| POL-D09 | 系统自动供稿：持久任务、幂等、租约、回扫、变化检测 | 沿用 | INV-29、BR-POL-16 |
| POL-D10 | 质量、成本、稳定性：权限、证据、范围不因预算或积压被削减 | 沿用；预算不足只排队不降级 | DEC-08、DEC-09 |
| POL-D11 | 全部目标国家：33 国底表合并已有目标，数量不是上限，阻断不移出分母 | 沿用；法域字典 36 个对象，5 国标为背景层 | DEC-03 |
| POL-D12 | 按发布职责覆盖：必要独立部门/地方来源加入，完整覆盖的重复渠道保留映射 | 沿用 | BR-POL-25 |
| POL-D13 | 模型承担正文理解：服务器自动取得原文，项目现有模型完成理解、中文、解读及核验 | 沿用；“项目现有模型”即 DeepSeek（DEC-29）；开发 Agent 不替代生产 | DEC-16、DEC-29 |

### 7.2 旧ADR-0031／0036／0037／0038 的关键条款

| 旧条款（位置） | 沿用情况 | 说明与落点 |
|---|---|---|
| 旧ADR-0031:12-17@main：自动公开，不要求逐条人工批准；软件发布授权与日常内容发布是两件事（Owner 2026-09-05 批准，`:3`） | 沿用 | `02-rules/02-core-flows.md`；INV-29 |
| 旧ADR-0031:44-55@main：DeepSeek V4 Flash、机器检查不得称为人工审核；月度 100 元硬限/80 元提醒（北京自然月）、先预留最坏成本、未知结果不自动重发 | 部分沿用：先预留、未知结果不自动重发沿用；**月度 100 元硬限与 80 元提醒被 Owner 2026-10-01 答复取代**（不设月度金额上限，改为不浪费纪律 + 用量报告 + 预警与异常熔断，DEC-08）；具体模型版本以新系统的模型路由配置为准（DEC-29） | ADR-0006、BR-COST-02～05、BR-COST-17～20 |
| 旧ADR-0031:65-71@main：纯密码具名账号、服务端会话；初始开通无公共 HTTP 端点 | 沿用 | DEC-05、DEC-43 |
| 旧ADR-0031：独立管理域名 `admin.*` 与独立管理应用 | **失效**（旧ADR-0037 取消运营台） | 改为私有主机名下的最小私有页面，DEC-30 |
| 旧ADR-0031:75-78@main：下架对未来采集/发布/升级持久有效，恢复须显式操作 | 沿用 | INV-03、ADR-0011 |
| 旧ADR-0036:13@main：B 类准入（具体普通矿业事项准入；纯获奖/参会/空预告/泛宣传不因发布方身份准入） | 沿用 | BR-ENR-01、DEC-12 |
| 旧ADR-0036:13@main：正式精选权重待 Owner 初稿，旧分数不得升格为新规则 | 沿用 | DEC-10 |
| 旧ADR-0036:23-24@main：审稿只记录人明确勾选的维度，语言更正不是事实认证；审核意见不自动修改全站规则或恢复已下架材料 | 改写后沿用：审稿台默认关闭，仅建设期抽样与标注；决定为四选 + 五维基线 | DEC-14、DEC-54 |
| 旧ADR-0036:34@main：系统盘已用须 <20GB | 沿用 | `04-architecture/07-deployment-and-ops.md` §3.4、AC-M1-14 |
| 旧ADR-0036：Hermes 容器、有界 Agent 工具循环用于内容生产 | **失效**（旧ADR-0037:24 不新增常驻智能体；生产为固定分段核验链） | DEC-16 |
| 旧ADR-0036：三阶段的第三阶段“特定主体的有证据影响分析” | **失效**（POL-D01：不做特定企业结论） | DEC-11 |
| 旧ADR-0037:16-19：全部目标法域，33 国非上限，EU/UN/OECD 单列 | 沿用 | DEC-03 |
| 旧ADR-0037:21-22：不设运营台，不以其他名称恢复逐条审稿；建设阶段样本核验不冒充日常运营 | 沿用 | DEC-04、DEC-14、DEC-15 |
| 旧ADR-0037:23-24：法规业务独立准入与资源调度；不新增模型、常驻智能体、向量库或另一套数据库 | 沿用 | DEC-01、DEC-16、DEC-29、DEC-34 |
| 旧ADR-0037:35：入口“法规政策动态”在矿业日报下 | 沿用 | DEC-02 |
| 旧ADR-0037:37-39：取消运营台须先导出迁移有效配置，保留服务身份、费用回执、审计与持久下架 | 改写后沿用：在新系统里落为迁移清单与“退出检查表” | `03-data/04-legacy-migration.md`、DEC-20 |
| 旧ADR-0037:41-45：复用工作项 #138、不修改旧迁移、不直接改 main | **不适用于新仓库**（只约束旧仓库的本轮实施） | — |
| 旧ADR-0037:44：不扩大月度 100 元硬限、80 元提醒 | **被 Owner 2026-10-01 答复取代**：“预算无上限，但是不要浪费”——不设月度金额上限 | DEC-08、BR-COST-17～20 |
| 旧ADR-0037:49：T01～T63 均保留验收归属 | 改写后沿用：写作 POL-T01～POL-T63，承接表在法规分册 | `01-product/10-policy-service.md` 附录 B |
| 旧ADR-0038:19-29：验证由受跟踪的 Makefile 入口绑定完整 SHA 执行；首尾检查 HEAD/tree 与 tracked/untracked 状态；回执不含环境变量与个人路径；无签名回执不构成生产信任 | 沿用精神，改写后沿用：新仓库用 `make verify`，执行器可替换 | ADR-0017、ADR-0014、DEC-17 |
| 旧ADR-0038:19-29：PR-only、线性历史、版本绑定、可信制品、回退；ARM 本地验证与 AMD64 制品核验分开 | 沿用 | ADR-0017 |
| 旧ADR-0038:38-40：旧生产服务器只接受历史 Actions 签发身份 | 与新仓库无关（新系统自建信任根） | `04-architecture/07-deployment-and-ops.md` §3.1 |

## 8. 旧 Owner 现行需求 REM-R01～REM-R15 映射表

来源：`docs/designs/mining-product-overhaul.md:9-29@main`，旧ADR-0034:13-17@main 称其为“当前要求”；Owner 2026-09-20 批准实施（旧状态：部分实现）。**编号与 B 包的证据代号 R01～R04、法规分支的 POL-R01～R08 不是一回事**，本包一律写 REM-Rnn。“验收证据”列为旧文原文。

| 编号 | 要求 | 验收证据（旧文原文） | 本包落点 | 与旧ADR-0037／0038 的关系 |
|---|---|---|---|---|
| REM-R01 | 保留 18 国、321 原始记录与 320 唯一目标，逐源推进 | 目标、配置、独立发布方、接通、连续产出分别计数 | F-SRC-06、BR-SRC-01、DEC-59（一张口径表）；`data/README.md` §2 | “保留 18 国”的上限被旧ADR-0037:5-6 取代：资讯线 18 国起步，法域字典 36 个对象（DEC-03）；321/320 不重编号仍有效 |
| REM-R02 | 服务器自动发现、处理和公开，不依赖 Codex 代生产 | 近期真实任务链、两批自动公开、重启恢复及无人干预观察 | INV-29、AC-M1-03 | 沿用；旧ADR-0037:22（Codex 不进入生产调度依赖）、POL-D09 同向 |
| REM-R03 | 干净完整且有许可的正文，保留表格和尾段条件 | 按源正文质量及失败原因，HTTP 成功不能冒充全文 | F-MAT-02、F-MAT-03、DR-30 | 沿用；法规附件另有 BR-POL-12 |
| REM-R04 | 完整中文阅读，摘要例外明确，旧闻不改新日期 | 源文与译文结构、数字、否定和末尾条件对照 | F-ENR-04、INV-11、INV-12、DR-31；DEC-35 | 沿用并加严（POL-D08：摘要不计全文） |
| REM-R05 | 公司、项目、机关、文书实体有稳定身份及证据 | 多语言金标、别名来源、实体误判与漏判 | F-ENT-01、BR-ENT-01；`05-quality/05-evaluation-sets.md` | 沿用；未核实译名公开页只写原名（DEC-37） |
| REM-R06 | 跨来源和跨语言同事件聚簇 | 有界候选、留出集召回和合并精确率，严重误并单列 | F-EVT-02、F-EVT-03、BR-EVT-09、INV-23、AC-M2-01 | 沿用；embedding 召回按新增付费依赖处理（DEC-29；旧ADR-0037:24） |
| REM-R07 | 区分转载、同事件及实质进展，支持纠错 | 多事件文章、进展关系、稳定旧链接及可撤销合并 | F-EVT-01、F-EVT-04、F-EVT-07、INV-18 | 沿用 |
| REM-R08 | 自动精选采用事件级规则漏斗，复用语义结果 | 稳定决定、重大事件召回、Top-N 认可率与实际调用成本 | F-SEL-01～03、INV-19、DEC-10 | 改写（Owner 2026-10-01，DEC-10）：精选与热点沿用 AIHOT 的评分机制、评分规则与显示并矿业化，切换前完成；旧 55/75 公式作废；矿业版评分标准生效前须 Owner 审阅确认（BR-SEL-09、T-160）；验收补上旧文这三项 |
| REM-R09 | 搜索、筛选、来源追溯和返回阅读可用 | 全库和多条件浏览器验收，桌面与窄屏同路径 | F-RDR-03、F-RDR-07、PG-09；DEC-23（页码 + 游标双通道） | 沿用；法规分区 DEC-62 |
| REM-R10 | 日周月报复用已公开事件，保留更正和下架传播 | 事件去重、引用、期间边界与历史版本一致性 | F-RPT-01～03、BR-RPT-01～05、INV-21；DEC-22 | 沿用；法规周月汇总独立（POL-D06、BR-POL-14） |
| REM-R11 | 北京月度 100 元硬上限、80 元提醒；未知收费不重付 | 缓存、真实请求、已确认费用、预留及供应商账单分开 | F-AI-02、BR-COST-01～05、BR-COST-11、INV-14、INV-15；DEC-08 | 部分沿用：“未知收费不重付”与各类费用分开沿用；**金额上限被 Owner 2026-10-01 答复取代**（不设上限，预警与异常熔断，DEC-08、BR-COST-17～20） |
| REM-R12 | 人工修订、下架及既有接口兼容 | 重采集、补齐、升级后不复活或覆盖人工成果 | F-EDT-02、F-EDT-03、INV-03、INV-04；F-PUB-06（DEC-21） | 部分沿用：人工修订与下架不被重采集、补齐、升级复活或覆盖，沿用；**“既有接口兼容”作废**——新站不做任何旧链接、旧 RSS、旧接口的兼容或重定向（Owner 2026-10-01，DEC-21） |
| REM-R13 | 新闻生产和运维恢复独立于软件发布平台 | CI 不可用时持续生产；替代发布仍绑定可信版本和测试 | INV-29、ADR-0017、DEC-17 | 沿用，并被旧ADR-0038 进一步落实（Actions 停用） |
| REM-R14 | 成功软件发布才记录真实产品说明 | 更新日志与已部署功能一致，测试日志不作产品公告 | F-RDR-14、PG-13、INV-28、DR-90 | 沿用 |
| REM-R15 | 资源和单位成本可测，扩源容量可复算 | 内存/磁盘分开；峰值、查询行数、积压和质量共同评估 | `04-architecture/07-deployment-and-ops.md` §7、AC-M1-10、AC-M1-14；PIT-037、PIT-057 | 沿用；旧ADR-0035 是反面教材 |

旧文另有两句约束，本包同样沿用：“600 篇金标和 100/300/500 容量档位是评估计划，不是已有成绩”；“全部动态保持宽收录，精选门槛不能拦截合格普通资讯；旧的六发布方联通指标只作为烟雾测试，不代表全部需求完成”（`docs/designs/mining-product-overhaul.md:29@main`；落点 DEC-61、INV-19）。

## 9. 迁移号对照（便于按迁移号核对旧数据模型）

`db/migrations/`@main（0001～0028，`.up.sql`/`.down.sql`；0009 无 down）：

| 号 | 主题 | 号 | 主题 |
|---|---|---|---|
| 0001～0005 | 领域、采集、情报、发布、运维（第一代数据模型） | 0017 | 产品更新登记 |
| 0006 | 管理员身份 | 0018 | 已审来源范围（控制令牌） |
| 0007 | v2 生产数据控制 | 0019 | 模型运营配置 |
| 0008 | live 流水线（月度预算、预留、下架） | 0020 | 报告综合 |
| 0009 | 纯密码管理员账号 | 0021 | 阅读恢复 |
| 0010 | 信源运营（配置保存、预览门） | 0022 | 来源材料就绪 |
| 0011 | 编辑运营 | 0023 | 来源草稿配置修复 |
| 0012 | 读者元数据 | 0024 | 模型响应回执 |
| 0013 | 持久下架成员 | 0025 | 关联召回索引 |
| 0014 | 信源目录导入（控制令牌） | 0026 | 实测快照容量 |
| 0015 | 读者国家排除 | 0027 | 内容审稿（Hermes） |
| 0016 | 翻译阅读元数据 | 0028 | 来源预览队列 |

`@policy` 另有 0029～0038：法规材料运行、内容运行、解读运行、发布、目录发现、语言发布、发布历史、报告、分页目录、服务调度。

## 10. B 包证据代号 L01～L26 对照

B 的 `evidence/legacy-product-sources.md`（本包位于 `appendix/B-package-evidence/legacy-product-sources.md`）用 L01～L26 标记证据，引用的是**本地工作区 main `1990cf5`（B 称 MAIN-LOCAL）与法规工作树 `6d37df8`（POLICY-WORKTREE）**的行号。本地 main 已确认与远端分叉，**行号可能对不上**：下表“远端核对”一列是 2026-09-30 逐文件取 `@main` 内容、与 B 的清单哈希比对的结果。B 文件里的 L 号、`MAIN-LOCAL`/`POLICY-WORKTREE` 等代号仅在本节保留作对照，**其他文件不得再引用**。

| B 代号 | B 引用的证据对象 | 远端核对（行号是否仍可靠） | 能证明 / 不能证明（B 的限制，保留） | 本包落点 |
|---|---|---|---|---|
| L01 | `README.md:1-5,51-103` | **失效**：`README.md@main` 现为 72 行，51～103 行已不存在 | 只证明早期品牌与定位；“只参考 AIHOT、只元数据、固定技术栈”已被重建决定覆盖 | `00-overview.md`、ADR-0001 |
| L02 | `docs/designs/mining-product-overhaul.md:3-91` | **已变**（现 123 行；R01～R15 在 `:9-29`） | 18 国历史范围、六发布方烟测、存量补齐、下架保护；旧后台/LME 仅外链已被后续决定覆盖 | 第 2、8 节；DEC-07、DEC-61 |
| L03 | `docs/source-policy.md:5-159` | 可靠（与 B 清单一致，183 行） | 候选/运行分开、原始记录不改、权限分层、适配优先级；“31 enabled”不是当前运行数量 | `01-product/07-sources-and-coverage.md` |
| L04 | `docs/architecture/vnext/approved-target-brief.md:112-1656` | 可靠（2,651 行） | 目标设计输入；旧后台范围与“增量演进”已被取代 | 第 2 节首行 |
| L05 | `config/v2/editorial/annotation-manual.md`、`config/v2/editorial/taxonomy.v1.json`、`config/v2/editorial/review-gates.v1.json`、`config/v2/editorial/reason-codes.v1.json` | 可靠（4 个文件与 B 清单一致） | 离线校准；不是全动态发布硬门，不是已完成的真实评分 | 第 4 节末行；`data/legacy-editorial/` |
| L06 | `docs/designs/frontend/decision.md:1-60`、`docs/public-web.md:7-50` | 可靠 | 公共/私有边界、版本一致、空状态；旧视觉已被覆盖 | `01-product/03-reader-pages.md` |
| L07 | `docs/runbooks/automatic-live-intelligence.md:8-112` | **已变**（现 628 行） | 持续工作、单源失败隔离、未知调用不重试；当时 provider 阶段不是固定模型要求 | `02-rules/02-core-flows.md`、`04-architecture/07-deployment-and-ops.md` |
| L08 | `apps/web/lib/reader/types.ts`、`apps/web/components/reader/pages.tsx`、`apps/web/e2e/reader-mobile.spec.ts` | **已变**（三个文件均不同） | 静态存在，不证明线上通过 | `01-product/03-reader-pages.md`、`03-data/02-public-api-contract.md` |
| L09 | `tests/live_pipeline/test_reader.py` | **已变**；B 列出的测试名仍存在（抽查 2 个），按测试名定位 | 静态回归意图，未运行 | `05-quality/` |
| L10 | `services/live_pipeline/event_association.py:138-175`、`tests/live_pipeline/test_event_association.py` | **已变** | 有界候选、不误并、进展；不证明跨语言准确率达标 | F-EVT-02、BR-EVT |
| L11 | `tests/live_pipeline/test_source_operations.py` | **已变**，按测试名定位 | 坏兄弟隔离、date-only、预览绑定、CAS 断点、保人改 | BR-SRC、INV-05 |
| L12 | `services/live_pipeline/processing.py:52-216`、`tests/live_pipeline/test_processing.py` | **已变** | 旧精选硬编码数值只存在于旧实现，不作新评分依据 | DEC-10 |
| L13 | `tests/live_pipeline/test_operations.py` | 可靠（与 B 清单一致；抽查 2 个测试名存在） | 人改/抑制/反馈/并发版本/重试的可复用行为测试；不要求复制旧运营台 | BR-EDT |
| L14 | `tests/live_pipeline/test_scrapling_extract.py`、`services/live_pipeline/translation.py:28-34` | **已变** | Scrapling 是历史实现，非新技术强制选择 | `04-architecture/02-tech-stack.md` |
| L15 | `services/live_pipeline/translation.py:37-117`、`tests/live_pipeline/test_translation_model.py`、`tests/live_pipeline/test_reader_translation.py`、`tests/live_pipeline/test_translation_store.py` | **已变**（四个文件均不同） | 全文/权限/材料身份、完整分段、中文复用、未知费用复用 | DR-30/31、F-ENR-04 |
| L16 | `tests/live_pipeline/test_country_display.py`、`services/live_pipeline/source_registry.py` | 测试文件可靠；`services/live_pipeline/source_registry.py` **已变** | 地理歧义；不能据字符串规则声称完整实体识别 | INV-31 |
| L17 | `tests/live_pipeline/test_model_config.py` | **已变** | 密钥不回显、未知价格不启动、能力资格 | F-AI-01、BR-COST |
| L18 | B 的 `evidence/discussion-distillation.md` | 包内文件，已改名位置 | 协作者实际读取的讨论；未独立重读全部聊天 | `appendix/B-package-evidence/discussion-distillation.md`；`01-product/08-owner-voice.md` |
| L19 | `tests/live_pipeline/test_release_notes.py`、`tests/live_pipeline/test_release_notes_routes.py`、`apps/web/lib/reader/types.ts:139-154` | `tests/live_pipeline/test_release_notes_routes.py` 可靠；其余**已变** | 产品更新类型、真实成功后登记、同版本幂等 | F-RDR-14、INV-28 |
| L20 | `docs/policy-upgrade/requirements.md:3-61`、`config/policy/scope.json`（@policy） | 可靠（提交相同；文件 61 行） | 13 条决定、33 国 + 3 组织、七主题；scope 保存三份原始方案的历史哈希，本轮未取得原文 | 第 6、7 节 |
| L21 | `docs/policy-upgrade/source-research.md`、`config/policy/jurisdictions.json:17-115`、`services/policy_intelligence/coverage.py:48-54`（@policy） | 可靠（行号均在文件范围内） | R01～R07 研究、各主题缺口、历史 FR 容量反例；文件自述 partial，不算来源完成 | `01-product/10-policy-service.md` §3、附录 A |
| L22 | `docs/policy-upgrade/material-processing.md:7-58`（@policy） | 可靠 | 文书身份、节点/附件目录、缓存定向失效；旧限额与分段大小不继承 | `01-product/10-policy-service.md` §5 |
| L23 | `docs/policy-upgrade/acceptance/material-audit.json:1-8,300-302`、`config/policy/scope.json` 末尾（@policy） | 可靠 | 预期 17/取得 16/F17 缺失；不证明已读全部原件 | DEC-41 |
| L24 | `docs/policy-upgrade/interpretation-runtime.md:7-66`（@policy） | 可靠 | 全文分组核对、旧法比较需原件；真实语义记录仍为空，不迁移为已完成 | `01-product/10-policy-service.md` §5 |
| L25 | `docs/policy-upgrade/operations-exit.md:1-45`（@policy） | 可靠 | 退出运营台依赖；不把删页面当消除人工依赖 | DEC-04、DEC-34 |
| L26 | 旧ADR-0033:13-21、0034:18-24,42-59、0035:8-26、0036:11-30（@main）；`apps/web/components/admin-live/content-review.tsx:44-67`、`services/live_pipeline/content_review.py:173-226`（@policy） | ADR 行号可靠（读自 `65d3624`）；两个审稿文件在 main 与 policy 均存在，按 @policy 行号 | 新外文稿需完整可取得中文；四选分维度人审；Hermes 只是受控试验，结构测试不算真实质量 | 第 2、7 节 |

## 11. 包外蒸馏编号的处置

v1.0 的正文大量引用指向**两份包外蒸馏报告**的证据编号（`旧证 B2·…`、`A2·…`、`INT-nn`、`REQ-nn`、`ED-nn`、`F·REQ-nnn`、`C:PIT-…`、`AH-B…` 等，v1.0 共 315 处、228 个不同编号；v1.0 的 06 号文件称“统一见附录 A”，但附录 A 从未有过映射）。这些报告不在任何一个交接包里，**无法在包内解析，也无法指向旧仓库文件**。v2.0 的处置规则：

1. **不再把这类编号当作证据**。凡能对应到旧仓库 PR、Issue、ADR、文件路径、`01-product/08-owner-voice.md` 的 OWN/DEC/ACC/ANTI 编号、或 B 包原件的，一律改写成这些可解析的指针。
2. 对应不到的，保留规则正文，依据写“仅 v1.0 转述，未核对”，**不得据此把状态标成【已验证】**。
3. `ANTI-nn`、`OWN-nn`、`ACC-nn` 是 `01-product/08-owner-voice.md` 自己的编号，可解析，保留。
4. `05-quality/02-pitfalls.md` 的 PIT-060 写“Issue #103”，不写“PR #103”。
5. 校验器（`tools/validate_package.py`）应检查包内不再出现上述前缀的裸编号；残留由各文件维护者继续替换（变更日志已向对应文件提出请求）。

## 12. 本索引的核验记录

| 日期 | 核验内容 | 结果 |
|---|---|---|
| 2026-09-30 | 在线读取 main 与 policy 的完整文件树，逐项核对 v1.0 索引的全部路径、迁移号 | 全部存在，仅 `docs/policy-upgrade/*` 只在 @policy |
| 2026-09-30 | 在线读取 PR/Issue 清单（180 项）核对编号与类型 | 123 个 PR（119 已合并）、57 个 Issue；#103 是 Issue；#180 为开放草稿 |
| 2026-09-30 | 取 B 的 L 表引用的 main 侧 32 个文件，算 sha256 与 B 的清单比对；政策侧 11 个文件核对行号范围 | 见第 1、10 节 |
| 2026-09-30 | 精读复核：`docs/designs/mining-product-overhaul.md:1-70@main`、旧ADR-0031:1-94、0034:1-26、0036 全文、0037 全文、0038 全文（以上 `docs/architecture/decisions/` 下，0031/0034/0036 读自 @main，0037/0038 读自 @policy）、`docs/policy-upgrade/requirements.md` 全文、`docs/policy-upgrade/federal-register-originals.md`、`docs/policy-upgrade/status.md:126-140,282-292`（均 @policy） | 第 2、6、7、8 节的锚点均据此写成 |
| 2026-09-30 | 两个提交的 tree SHA 与文件数 | 第 0 节 |
| 2026-10-01 | 重新在线读取两棵文件树（main 1,161 个、policy 1,325 个文件），把本索引中缩写目录的写法全部展开为仓库根相对的完整路径，再对每个旧仓库路径引用核对存在性；对其中 53 处带行号范围的引用逐个取文件，核对行号不超出文件行数 | 全部路径在所标提交存在；行号全部在范围内，唯一例外是第 10 节 L01 行有意记录的 B 的失效行号（B 引用根目录 README.md 的第 51～103 行，该文件现 72 行）；`docs/policy-upgrade/status.md` 的 `278-295` 已改为 `278-292`（文件共 292 行） |
| 2026-10-01 | 重新统计 PR、Issue 与分支；对比 B 的 `legacy-file-manifest.json`（821 个路径）与 main 的文件树 | #40 是开放草稿（此前误记为关闭未合并），已更正；PR #180 仍为 open draft、27 个提交、195 个变更文件；B 清单的 821 个路径全部在 main 存在，main 另有 340 个文件不在清单内（`tests/` 77、`db/` 67、`infra/` 67、`prototypes/` 32、`services/` 29、`.github/` 19、`apps/` 16、`docs/` 16 等，含旧ADR-0033～0036 与根目录 `README.md`） |
| 2026-10-01 | 抽查 PR 与主题的对应：取 #143、#153、#157、#130、#173 的变更文件清单 | #143 确含 `services/ingestion/network.py` 与 `tests/ingestion/test_gzip_network.py`（有界 gzip）；产品更新登记的 PR 由 #157 更正为 #153（建立：迁移 0017、`services/live_pipeline/release_notes.py`、`config/live/product-update.json`）与 #157（后续条目）；#130（同主机重定向）、#173（`services/live_pipeline/relevance.py`）对应无误 |
| 2026-10-01 | 精读复核 REM-R01～R15 表与 POL-D01～D13 表 | 第 8 节的“要求”与“验收证据”两列与 `docs/designs/mining-product-overhaul.md:13-27@main` 内容一致（仅在中文与英文、数字之间补了空格）；第 7.1 节与 `docs/policy-upgrade/requirements.md:9-21@policy` 一致（POL-D08 补“官方中文与 AI 辅助译文区分”、POL-D12 补“完整覆盖的重复渠道保留映射”） |

**已知局限**：行号是 2026-09-30 与 2026-10-01 的读数；旧仓库若继续提交，`@main` 以固定提交 `65d3624` 为准，不随分支头移动。没有运行旧项目的测试，也没有访问生产数据库；凡写“部分实现”“已实现”的只是代码存在，不等于验收通过（状态标签见 `README.md`）。

## 13. 本交接包的蒸馏过程

v1.0（A 包）由以下独立调研汇总：旧项目产品与页面、信源与采集、情报加工与发布、数据模型与接口、坑点与运维、Owner 历史消息（2026-07-19 至 09-29，约 360 条手写消息与 5 份批准计划）、AIHOT 后端与前端审查、2026-09 技术现状调研。B 包（2026-09-29）独立读取了旧仓库本地工作区、法规工作树与 6 个相关聊天。v2.0 在此基础上做了第一轮三方对照（A 包、B 包、旧仓库，24 个维度、412 条发现）和本轮合并，逐条处理记录见 `appendix/C-merge-findings.md`，裁决见 `00-decision-ledger.md`；B 包的证据文档原样保留在 `appendix/B-package-evidence/`（说明见该目录 `README.md`）。
