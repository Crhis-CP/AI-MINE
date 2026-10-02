# 契约目录（v2.1）

> **【先读】这些 JSON 是 B 包原件、与 v2.1 正文冲突处以 `../02-public-api-contract.md` 与本文改造清单为准**（例如前缀 `/api/v3`、分页双通道、`TimeAssertion` 加 `label`、`jurisdictions`、金属价格接口移出首版、反馈字段）。
>
> 说明：本目录里的四个机器文件 `openapi.json`、`examples.json`、`domain-events.schema.json`、`domain-event.example.json` 来自 B 包，按裁决 DEC-31 只作为首版“一次性转写”的输入，本包不直接改写它们；改造清单见第 2–7 节，其他文件提来的字段级请求在第 11 节逐条登记。几处最容易踩的差异：公开路径前缀是 `/api/v3`（原件是 `/api/v1`）；站点接口用页码、公开 API 用游标（原件只有游标）；`TimeAssertion` 增中文 `label` 与北京日期；管辖字段是 `jurisdictions` 对象（原件是字符串路径）；`/metal-prices` 不进首版（原件有）；反馈请求是 `message`、`page_url`、`contact`、`screenshot`（原件是 `text` 加附件令牌）。直接照原件生成客户端或服务，会与已裁决事项冲突。

> **定位**：本目录是新项目契约的**首版输入与契约测试样例**，不是规范源，也不是已经部署的接口。规范源是新仓库 `packages/contracts` 中的 Zod schema，由它生成 OpenAPI 3.1、`/openapi-v3.json`、api-client 与 mock（DEC-31）。业务语义以 `../02-public-api-contract.md` 为准；优先级单向：业务契约文档 → 契约源码 → 生成物。
> **本轮只改文字，不改 `openapi.json` 与各 schema 文件**：它们保持 B 包原样（31 个 HTTP 操作、46 个封闭 DTO、5 类领域事件），下面第 1–8 节把 v2.1 对它们的改造逐项列清，第 11 节把其他文件提来的字段级请求逐条登记，新仓库按清单一次性转写。
> 状态标签：【设计】本包提出；【已实现未验证】旧仓库有代码无验收；旧仓库证据写 `路径:行号@main` / `@policy`，B 包写 B:文件。下文表格里“B 路径”“B 原件”一类列是 B 原件的写法，仅供转写对照，**不是 v2.1 的规范路径**；v2.1 的公开路径一律是 `/api/v3/*`、站点路径 `/api/site/*`、私有路径 `/api/admin/*`。

**v2.1 相对 v2.0 的主要变化（Owner 2026-10-01 答复；JSON 原件仍不改，下面的改造清单登记）**

| # | 变化 | 落点 |
|---|---|---|
| 1 | **私有接口：预算改为用量与熔断**：`/budget*` 取消，改为 `/usage`、`/usage/reports`、`/usage/unknown-receipts/{id}`、`/breakers`、`/usage-config` 与 `/lane-controls`；`CostSummary` 改名 `UsageSummary`（去 `limit`、`warning_threshold`、`remaining` 与保底额）；新增 `BreakerState`、`UsageControlConfig`；LaneControl 持有者去掉 `budget`；含熔断指标预警（达到阈值 70%）状态 | G-25、§3 第 20 行、§4、§5.2、X-07、X-19、X-20、X-27 |
| 2 | **精选、热点与条目评分沿用 AIHOT**：`ItemCard.score`；`HotRanking`（公开只给名次）与 `SiteHotRanking`（网页含热度值）；`featured/snapshot`、`featured/changes`；`availability` 与 `not_enabled` 废弃；错误码增 `snapshot_required` | G-22、§4、§5.1、§9、X-28 |
| 3 | **旧站地址一概不兼容**：删除 `/rss.xml` 与旧 RSS 的 301、旧站 ID 别名 308、适配层与迁移响应头；不存在的地址一律 404；`first_public_basis` 去 `legacy_snapshot_min` | G-23、G-18、§3、§9 |
| 4 | **许可**：新建信源九项一律“允许”（`owner_declared`），删“权限待审定”批量确认端点，权限修改只剩逐源收紧与放宽；`guide_only_reason` 释义改写；第十项仍默认关闭 | §4 `SourcePermission`、§5.2 信源、X-13、X-29 |
| 5 | **合规展示**：`Settings` 增公安联网备案号与新闻许可证信息 | G-24、§4 `Settings` |
| 6 | **事件目录**：37 个有效类型（新增 `hot.ranking_computed`、`usage.notice_raised`、`usage.report_issued`、`breaker.warning_raised`、`breaker.tripped`、`breaker.recovered`；废弃 `budget.threshold_reached`、`import.batch_finished`），`domain-events.schema.json` 与示例转写时按 `../03-internal-contracts.md` §2.2 重新生成 | E-02、E-03、E-08、X-22、X-30 |
| 7 | **待决措辞**：金属价格、事件折叠默认、告警渠道、私有页面载体等改为“Owner 2026-10-01 已定” | §5.2、§2 G-21、X-26 |

## 0. 结论

| 序号 | 结论 |
|---|---|
| 1 | B 的 31 个操作中 **29 个保留**（全部改路径前缀，多数改字段），**2 个移出**：`getMetalLinks` 并入站点设置，`listMetalPrices` 按 DEC-07 移出首版；46 个 DTO 中 **3 个移出、1 个拆分、2 个改名（`PolicyScope`→`SourcePermission`、`CostSummary`→`UsageSummary`）、其余改造或保留**（§3、§4） |
| 2 | B 的 OpenAPI 缺的资源清单见 §5：事件列表、热点、精选同步、主题详情、发展线、政策线、法规范围与周月汇总、法域字典、更新日志分页，以及站点接口、账号、下架/恢复、模型、用量与熔断、反馈处理、站点设置、告警渠道、审计等私有资源；非 JSON 出口（RSS 多路、站点地图、robots、`llms.txt`、分享图、MCP）另有 `non-json-outputs.md` |
| 3 | 转写时必须落实的全局改造 25 项见 §2，核心是：`/api/v3` 前缀、去掉 `content_version` 钉住读取、双通道分页、统一错误体、`TimeAssertion` 加中文 `label`、`jurisdictions` 对象、http 链接放宽、署名与 AI 标识及再分发、缓存头、金额整数微元、公开新鲜度探针、条目评分与热点只给名次、旧站地址一概不兼容、用量与熔断资源；其他文件提来的字段级请求在 §11 逐条登记 |
| 4 | `examples.json` 只覆盖 46 个 DTO 中的 15 个，必须补齐到每个操作至少 1 个成功响应样例、每个请求体至少 1 个样例，并把“schema 覆盖率 100%”纳入自检（§6） |
| 5 | B 包的 `tools/build_contracts.py`、`tools/validate_package.py` 与 `requirements-validation.txt` 不进入新仓库；本包自带的 `tools/validate_package.py`（仅标准库）做包内自检，契约检查项需补“schema 覆盖率”与“operation 响应样例覆盖”两条；新仓库用 Zod 生成链路的漂移检查（§6、§8） |

## 1. 本目录文件来自 B 包，v2.1 的改造清单如下（逐项）

### 1.1 文件清单

| 文件 | 来源 | v2.1 状态 | 使用方式 |
|---|---|---|---|
| [openapi.json](openapi.json) | B | **首版输入，本轮不改**；按 §2–§5 改造后一次性转写为 Zod | 转写对照；不得直接当作规范源维护 |
| [examples.json](examples.json) | B | 首版契约测试样例，**需补齐**（§6）；随改造调整字段名 | 合成样例（空、单条、受限导读、未知费用等），不是真实内容或质量金标 |
| [domain-events.schema.json](domain-events.schema.json) | B | 本轮不改；事件信封与目录由 `../03-internal-contracts.md` §2 统一后再转写（§7） | 出站事件与消费端校验；不含正文与密钥 |
| [domain-event.example.json](domain-event.example.json) | B | 同上 | 合成事件，消费者幂等测试输入 |
| [interface-behavior.md](interface-behavior.md) | B，**已改写** | v2.1 行为规范：分页与游标、缓存与下架、私有最小控制接口、模块端口、事件协议 | 实现与评审依据 |
| [non-json-outputs.md](non-json-outputs.md) | **新增** | RSS、站点地图、robots、`llms.txt`、分享图、公开 MCP 的路径、内容类型、缓存与内容规则 | 补 B 的 OpenAPI 没有的出口（D05-api-009） |

### 1.2 为什么不直接沿用 B 的 `openapi.json`

B 的 README 称它“覆盖核心浏览”，但照它生成客户端，读者站做不出跳页、热点页、主题详情页、发展线页；它还与已裁决事项冲突（飞书身份、版本钉住、单一 `https`、附件上传、价格接口等）。所以 v2.0 起把它降为“输入”（v2.1 沿用），并在本文固定转写前必须修订的内容。

## 2. 全局改造项

| 编号 | 改造 | 依据 |
|---|---|---|
| G-01 | **前缀与版本**：公开路径 `/api/v1/*` → `/api/v3/*`；新增站点接口 `/api/site/*`；私有 `/private/v1/*` → `/api/admin/*`；`/feedback/v1/messages` → `POST /api/site/feedback`；`info.title` 改为“AI矿策 公共、站点与私有接口”，`info.version` 改为 `3.0.0`；`servers` 按环境配置 | DEC-21；契约 §1 |
| G-02 | **版本号语义**：删除所有 GET 的 `content_version` 查询参数；响应保留 `content_version`（不透明）与 `generated_at`，**删除 `policy_epoch`**；`Version` 保留 `state` | DEC-47 |
| G-03 | **分页双通道**：`Feed` 拆成站点的 `SiteItemPage`（`page`/`page_size`/`total`/`has_more`/`facets`/`day_counts`）与公开的 `ItemList`（`cursor`/`limit` 1–100/`next_cursor`，不承诺 `total`）；游标错误用 `invalid_cursor`；阅读游标换版用 `revision_changed` | DEC-23、DEC-47 |
| G-04 | **错误体**：`Problem` 改为 `{code, message, request_id, retry_after_seconds?}`，`code` 取 `invalid_request`、`invalid_cursor`、`not_found`（含形态不合法的 ID 与旧站地址）、`revision_changed`（长文阅读与事件卡展开面板分页换版）、`snapshot_required`、`gone`、`rate_limited`、`version_unavailable`、`service_unavailable`，私有另有 `unauthorized`、`forbidden`、`conflict`；200/304/429/503 声明 `ETag`、`Cache-Control`、`Retry-After` 头；新增 304 响应 | DEC-52；契约 §2.7 |
| G-05 | **时间**：`TimeAssertion` 增 `label`、`meaning_label`、`beijing_date`；`meaning` 增 `public_inspection`、`formally_published`、`site_public`、`checked`；约束 `precision=date` 时 `utc`、`local_time` 为 null；各时间字段统一使用它 | DEC-50；契约 §2.5 |
| G-06 | **命名**：`feed`→`items`、`updates`→`changelog`、`kind`→`type`（报告）、`title_zh`→`title`、`summary_zh`→`guide`、`recommendation_reason`→`reason`、`public_at`→`first_public_at`、`Facet.value`→`code`；`saved` 的 `ids` 改逗号分隔字符串（`style=form, explode=false`） | DEC-51；契约 §2.11 |
| G-07 | **管辖**：字符串数组 `jurisdictions`、`jurisdiction_path` → `Jurisdiction` 对象数组（`code`、`label`、`kind`、`parent`）；筛选参数 `jurisdiction` | DEC-03、DEC-51 |
| G-08 | **链接**：所有 `^https://` 约束放宽为 scheme 白名单 `http\|https`（`format=uri`、无凭据）；`SourceCredit` 增 `insecure_transport`；来源入口默认 https，负责人可为单源开 `insecure_transport_exception` | DEC-56 |
| G-09 | **署名与 AI 标识**：`ItemCard`、`Policy`、`Report` 增 `attributions`、`ai_label`；`Reading` 增 `redistribution` | DEC-38；D05-api-017、020 |
| G-10 | **长度上限**：标题 ≤250、导读 ≤2000、推荐理由 ≤1000（存储/契约上限，内容标准另见 `06-content-standards.md` 长度表），取代 B 的 1000/8000 | D06-content-007 |
| G-11 | **枚举带中文标签**：分类、法域、矿种、主题、产品更新类型一律 `{code, label}`，各端不再自带对照表 | D05-api-008 |
| G-12 | **封闭 DTO 与扩展规则保留**：全部 `additionalProperties=false`；消费者须容忍新增的可选字段与枚举值 | B 规则；契约 §5.2 |
| G-13 | **缓存头**：按契约 §2.8 写入各响应头说明，不得出现 `stale-while-revalidate`、`stale-if-error` | DEC-48 |
| G-14 | **安全方案**：保留 `session` Cookie 方案（`__Host-session`），私有写增加 `X-CSRF-Token`、`Idempotency-Key` 头参数；公开与站点接口 `security: []` | `interface-behavior.md` §2.4 |
| G-15 | **operationId**：保留 B 的 camelCase 命名；改路径的操作保持 operationId 不变以利于样例复用，新增操作见 §5；重命名仅限 `listUpdates`→`listChangelog`、`getCosts`→`getUsage`（v2.1：预算改为用量与熔断） | 本包 |
| G-16 | **样例**：`examples.json` 随上述改造调整字段并补齐（§6） | D20-integrity-004 |
| G-17 | **AI 标识的机器可读字段**：公开条目、报告、法规文书的 `ai_label` 只取 `ai_generated` / `ai_assisted_human_edited` 两值（B 原件与旧站的 `ai_assisted`“已人工复核”含义一律不用）；详情类 DTO 另带 `ai_metadata {provider, content_id}`（服务提供者名称或编码、内容编号），与 `ai_label` 共同构成隐式标识；字段位置与措辞实现时对照 GB 45438-2025 核对一次 | DEC-38；DR-87、BR-PUB-10；契约 §2.9 |
| G-18 | **首次公开与时间枚举**：`ItemCard`、`PolicyCard` 的 `first_public_at` 写一次永不改变，并带 `first_public_basis`（`live` / `unknown`；`legacy_snapshot_min` 【已废弃】：仅为迁移旧站数据服务，DEC-20）；`TimeAssertion.meaning` 增 `repealed`（废止日期），与 G-05 新增的四个值一并转写；公开阅览与正式刊发用 `public_inspection`、`formally_published`，不再借用 `uploaded`、`published` 加 `basis` 文字区分 | BR-TIME-11；DEC-36、DEC-50；契约 §2.5 |
| G-19 | **金额整数微元**：`UsageSummary`（原 `CostSummary`）及账本、回执类 DTO 的金额字段由 B 的字符串小数改为整数微元（1 元 = 1,000,000 微元，字段名带 `_micros` 后缀，`currency` 恒为 `CNY`）；显示换算只在页面层；不得用浮点 | BR-COST-14；T-069、T-140 |
| G-20 | **撤回代次**：站点接口 `GET /api/site/version` 增 `suppression_epoch`（不透明字符串，客户端只比较是否相等）；公开 API v3 的 `/version` 与 OpenAPI 公开文档不含该字段；B 的 `policy_epoch` 一律删除 | DEC-48；读者站通则 10；T-129；契约 §2.2 |
| G-21 | **健康与探针**：新增公开新鲜度探针 `GET /api/v3/freshness`（只读、经限流、不触达复杂查询）；约定发布标识响应头（名称 M0 定，旧站为 `X-GMPI-Release`）；`/healthz`、`/readyz` 不属于公网契约，不进 OpenAPI | DEC-06；D15-secops-007；`04-architecture/07-deployment-and-ops.md` §6.2、§6.3；契约 §2.13 |
| G-22 | **精选、热点与条目评分**（沿用 AIHOT，v2.1）：`ItemCard` / `ItemDetail` 增 `score`（integer 0–100 或 null：两次评分的平均值，向下取整；没有评分为 null，不出现 0）；`featured` 为是否入选精选；公开 `GET /hot` 响应 `HotRanking`，其 `HotEntry` 只含名次（无 `heat`、趋势、徽标），网页形态 `SiteHotRanking` 另带 `heat`、`trend`、`trend_pct`、`badges` 等（仅 `/api/site/hot`）；新增 `GET /featured/snapshot`、`GET /featured/changes`；错误码增 `snapshot_required`（409）；**删除** `availability` 字段与 `not_enabled` 取值（数据不足时 200 与空列表）；`ReportCard.item_count`、`coverage_note` 按 DEC-65（取材于精选候选） | DEC-10、DEC-64、DEC-65；契约 §3.2、§3.5、§3.6；BR-SEL-05、BR-SEL-07 |
| G-23 | **旧站地址一概不兼容**：不为旧站任何地址做兼容、重定向或适配；删除一切旧路径别名（`/rss.xml`、旧 RSS 地址）、旧站 ID 别名 308、适配层与迁移响应头（`Deprecation`、`Sunset`）、410 专门响应；不存在的地址一律 404（接口类为统一错误体 `not_found`）；`gone`（410）只用于本站对象已下架或合并后没有去向 | DEC-21；契约 §5.1 |
| G-24 | **页脚合规**：`Settings` 增 `public_security_filing {number, url}`（公安联网备案号）与 `news_license {number, category, valid_until}`（互联网新闻信息服务许可证）；与 `icp_filing` 同取自受保护的运行时配置，不经私有 `settings` 编辑；生产环境备案号任一未配置则公开站不得开放 | DEC-39、DEC-40；契约 §3.6；BR-SITE-03 |
| G-25 | **用量与熔断私有资源**：取消 `GET /budget`、`POST /budget/actions`、`PUT /budget/limits`、`POST /budget/unknown-receipts/{id}`；改为 `GET /usage`（`UsageSummary`）、`GET /usage/reports`、`GET /usage/reports/{month}`、`POST /usage/unknown-receipts/{id}`、`GET /breakers`、`GET /breakers/{id}`、`POST /breakers/{id}/recover`（仅负责人）、`GET/PUT /usage-config`（`UsageControlConfig`，仅负责人，高风险）、`GET /lane-controls`、`POST /lane-controls/actions`；暂停记录 `holder` 取 `owner` / `deploy` / `system`（去 `budget`）；`UsageSummary` 不含 `limit`、`warning_threshold`、`remaining`、保底额与调剂额；熔断指标另有预警（达到阈值 70%）状态 | DEC-08、DEC-09；BR-COST-17～20；ENT-54、ENT-82、ENT-83；`interface-behavior.md` §2.11 |

## 3. 操作逐项改造（B 的 31 个 operation）

“B 原路径”列是 B 原件 `openapi.json` 里的写法（`/api/v1/*`、`/private/v1/*`、`/feedback/v1/*`），**v2.1 已全部作废**，只用于转写时对号入座；v2.1 的新路径写在“v2.1 处置”与“改造要点”列。

| # | operationId | B 原路径（已作废，仅对照） | v2.1 处置 | 改造要点 |
|---|---|---|---|---|
| 1 | `getVersion` | `GET /api/v1/version` | 保留，改路径 `/api/v3/version`；另有站点版 `/api/site/version` | 响应 `Version` 删 `policy_epoch`；站点版另带不透明 `suppression_epoch`（G-20），公开版不带 |
| 2 | `listFeed` | `GET /api/v1/feed` | **改名路径** `/api/v3/items`；站点版 `/api/site/items` | 删 `content_version` 参数；`limit` 1–100；新增 `view=all/featured`（删 `hot`）、`on`、`facets`、`seen_version`（仅站点）、`page`/`page_size`（仅站点）、`fold`（仅站点，事件折叠，默认 `event`，DEC-25）；`jurisdiction` 含下级；`from`/`to`/`on` 北京自然日；响应拆 `ItemList`/`SiteItemPage`；`ItemCard` 增 `score`；不再有 `availability`（G-22） |
| 3 | `getItem` | `GET /api/v1/items/{id}` | 保留 | 删 `content_version`；已下架 410（旧站 ID 不兼容，G-23）；`ItemDetail` 见 §4 |
| 4 | `getEvent` | `GET /api/v1/events/{id}` | 保留 | 删 `content_version`；返回 `Event`（含 `EventCard` 字段、`report_count`）；合并后 308 |
| 5 | `getPolicy` | `GET /api/v1/policies/{id}` | 保留 | 删 `content_version`；保留 `policy_version_id`、`expression_id` 选择；返回分维 `legal_state`、`impacts`、`themes` 等（§4） |
| 6 | `getReport` | `GET /api/v1/reports/{id}` | 保留 | 删 `content_version`；`ReportCard` 增 `status`、`coverage_note`、`period_key` |
| 7 | `listTopics` | `GET /api/v1/topics` | 保留 | 加 `kind` 参数（五维）；删 `content_version` |
| 8 | `listPolicies` | `GET /api/v1/policies` | 保留 | `theme` 改七主题枚举（键：`investment_company`、`mineral_rights`、`land_construction`、`safety_environment`、`labour_community`、`tax_finance`、`trade_transport`，与 `10-policy-service.md` §2 一致，B 自拟的 `mining_rights`、`construction_land`、`labor_community` 作废）；`legal_status` 改为 `nature`（文书性质）、`stage`（制定阶段）、`in_force`；补 `from`/`to`（北京自然日闭区间，对 `sort_time` 生效）；删 `content_version`；站点版用 `page`/`page_size`（默认 20，≤50）、公开版用游标 |
| 9 | `listReports` | `GET /api/v1/reports` | 保留 | `kind` → `type`（仅 `daily/weekly/monthly`）；响应增 `status: available/empty` |
| 10 | `resolveSaved` | `GET /api/v1/saved` | 保留 | `ids` 逗号分隔（≤100）；响应增 `policies` |
| 11 | `getSettings` | `GET /api/v1/settings` | **移入站点接口** `/api/site/settings` | 增 `tagline`、`icp_filing`、`public_security_filing`、`metal_links`；删公开 API 版本 |
| 12 | `listUpdates` | `GET /api/v1/updates` | **改名** `listChangelog`，路径 `/changelog` | 公开游标、站点 `page`/`page_size`（默认 30）；条目增 `highlights`；`type` 改 `{code,label}` 四值 |
| 13 | `getMetalLinks` | `GET /api/v1/metal-links` | **删除** | 并入 `Settings.metal_links` |
| 14 | `submitFeedback` | `POST /feedback/v1/messages` | 保留，**改路径并改请求体** `POST /api/site/feedback` | 请求 `{message 10–5000, page_url?, contact?, screenshot?}`；可选 `Idempotency-Key`；响应 `201 FeedbackReceipt {ok,id}`；删 `attachment_tokens` |
| 15 | `getSession` | `GET /private/v1/session` | 保留，改路径 `/api/admin/session` | 角色改负责人/管理员；返回能力集；新增登录、退出（§5） |
| 16 | `listReviews` | `GET /private/v1/reviews` | 保留（审稿工具默认关闭），改路径 | 随 `ReviewRecord` 调整 |
| 17 | `submitReview` | `POST /private/v1/reviews` | 保留（默认关闭），改路径 | `decision` 改四选；`reviewed_fields` 枚举；下架/恢复移出（§5 `suppressions`） |
| 18 | `listJobs` | `GET /private/v1/jobs` | 保留，改路径 | 任务增 `lane`、恢复建议 |
| 19 | `getJob` | `GET /private/v1/jobs/{id}` | 保留，改路径 | 同上 |
| 20 | `getCosts` | `GET /private/v1/costs` | **改名** `getUsage`，路径 `/api/admin/usage` | `CostSummary` 改名并改造为 `UsageSummary`（§4，G-25） |
| 21 | `getRss` | `GET /rss.xml` | 移出 JSON 契约，归 `non-json-outputs.md` | 新路径 `/feed/all.xml`；不设 `/rss.xml` 别名，也没有任何旧 RSS 地址（不存在的地址一律 404，G-23） |
| 22 | `getLlms` | `GET /llms.txt` | 移出 JSON 契约，归 `non-json-outputs.md` | 文案规则见该文件 |
| 23 | `listSources` | `GET /private/v1/source-profiles` | 保留，改路径 `/api/admin/source-profiles` | `SourceConfig` 调整 |
| 24 | `createSource` | `POST /private/v1/source-profiles` | 保留，改路径 | `SourceWrite` 调整；`expected_version=0` |
| 25 | `getSource` | `GET /private/v1/source-profiles/{id}` | 保留，改路径 | — |
| 26 | `updateSource` | `PUT /private/v1/source-profiles/{id}` | 保留，改路径 | 区分“即时生效字段”与“生成新配置版本字段” |
| 27 | `sourceAction` | `POST …/{id}/actions` | 保留，改路径 | `action` 增 `resume`；`activate` 仅用于首次启用；删“暂停使预览失效” |
| 28 | `getCommandStatus` | `GET /private/v1/commands/{id}` | 保留，改路径 | 不变 |
| 29 | `listMetalPrices` | `GET /api/v1/metal-prices` | **移出首版** | DEC-07；`Quote`/`Quotes` 保留为延后草案（契约 §3.9） |
| 30 | `getItemReading` | `GET /api/v1/items/{id}/reading` | 保留 | 删 `content_version`；游标绑定 `document_revision_id`/`expression_id`；换版 409 `revision_changed`；仅再分发允许的来源返回正文 |
| 31 | `getPolicyReading` | `GET /api/v1/policies/{id}/reading` | 保留 | 同上 |

## 4. DTO 逐项改造（B 的 46 个 schema）

| B schema | 处置 | 改造要点 |
|---|---|---|
| `Problem` | 改造 | 见 G-04；`retry_after_seconds` 改可选 |
| `Version` | 改造 | 删 `policy_epoch`；`content_version` 空站为 null；站点版增 `suppression_epoch`（G-20），公开版不带 |
| `TimeAssertion` | 改造 | 见 G-05、G-18：增 `label`（中文展示文本，字段名定为 `label`，不用 `label_zh`）、`meaning_label`、`beijing_date`；`meaning` 增 `public_inspection`、`formally_published`、`site_public`、`checked`、`repealed`；`precision=date` 时 `utc`、`local_time` 为 null |
| `SourceCredit` | 改造 | `publisher_name`→`publisher {id,name}`；`original_url` 放宽 http/https；增 `insecure_transport` |
| `Evidence` | 改造 | 随 `SourceCredit` |
| `ReadingBlock` | 改造 | `links.href` 放宽 http/https |
| `Reading` | 改造 | 增 `state`（`not_needed` / `pending` / `in_progress` / `complete` / `guide_only` / `failed_terminal`）、`guide_only_reason`（`summary_only_permission`＝逐源收紧后权限只到摘要 / `body_unobtainable` / `over_limit` / `in_attachment`，后三值为技术原因，不含预算；仅 `guide_only` 时出现）、`next_cursor`、`redistribution`；**`mode` 由 B 的五值改为三值**：`original` / `official_translation` / `ai_translation`，无可读正文时为 null，B 的 `guide_only`、`unavailable` 由 `state` 表达（DR-20、DR-82、DR-95）；`completeness` 保留 |
| `ItemCard` | 改造 | 字段裁决见契约 §3.2：`title_zh`（B 上限 1000）→`title`（≤250，只含标题本身，不拼发布方或前缀，DR-11）、`original_title`、`summary_zh`（B 上限 8000）→`guide`（≤2000，不含署名前缀，DR-74）、`recommendation_reason`（上限 1000 保持）→`reason`（≤1000），三项长度取 DR-17 的“存储与契约上限”；另有 `category {code,label}`、`jurisdictions`（对象）、`minerals {code,label}`、`publisher`、`original_url`、`attributions`、`published_time`、`updated_time`（来源更新时间，列表时间栏回退用，DEC-24）、`first_public_at` 与 `first_public_basis`（G-18）、`reading_status`、`independent_source_count`、`featured`、`score`（G-22）、`event_group`（仅站点接口 `fold=event` 的折叠卡带：另有 N 家来源数、最新进展、进展数，契约 §3.2）、`story_id`、`thread_id`、`ai_label`、`license_note` |
| `ItemDetail` | 改造 | 删 `content_version`/`policy_epoch` 之外增 `times`、`sources`（含 `relation`）、`representative_id`、`latest_progress_id`、`related_policies`、`notice`、`ai_metadata`（G-17）；`company_notes` 改 `{name_zh, original_name, abbreviation, description, source_url, evidence}`；`timeline.relation` 四值，成员关系三层映射见契约 §3.3（AI-08） |
| `Facet` | 改造 | `value`→`code` |
| `Feed` | **拆分** | → `ItemList`（公开）与 `SiteItemPage`（站点）；`facets` 的 `jurisdictions` 按 `kind` 分组 |
| `Event` | 改造 | 增 `EventCard` 字段、`report_count`、`status`、`merged_into`；`relations` 保留五值（`updates/corrects/repeals/implements/related`）；新增 `EventCard`、`Story`、`HotRanking` / `HotEntry`（公开形态：只给名次）、`SiteHotRanking`（网页形态：含热度值）、`FeaturedSnapshot`、`FeaturedChanges`（G-22） |
| `InterpretationSection` | 保留 | 作为叙述段落，保留 `basis` 三值 |
| `Policy` | 改造 | `legal_status`/`status_basis` → `legal_state`（分维：`nature`、`legislative_stage`、`publication`、`enforcement`、`applicability`、`deadlines`、`repeal`，每维可为 `unknown` 并带 `basis`、`evidence_ids`，枚举取值与旧分支实现一致，DEC-36）；`jurisdiction_path` → `jurisdictions`；增 `nature`、`themes`（七主题键，由 `impacts` 汇总）、`change_kind`、`impacts`（`PolicyImpact[]`，无 `horizon`、无数值分）、`main_points`（`{text, clause_ref, evidence_ids}`）、`gaps`（待核实事项，≤5 条）、`guide`（法规动态导读，≤2000）、`relationships`、`related_items`、`thread_id`、`attributions`、`ai_label`、`ai_metadata`；`attachment_inventory` 放宽 http 并增 `rights`、`blocked_capacity`；`reading` 改为状态摘要；**相关性判定、质量资格 QualityRelease、解读候选与核验输出不进公开 DTO**（BR-POL-10、BR-POL-11） |
| `PolicyCard` | 改造 | 增 `original_title`、`authority`、`nature`、`themes`、`change_kind`、`sort_time`、`sort_kind`、`first_public_at`、`first_public_basis`、`source_checked_at`、`is_backfill`、`legal_brief`、`summary`（一句摘要）、`applicability_summary`、`thread_id`；`legal_status` 删除 |
| `Topic` | 改造 | `kind` 改 `country/mineral/company/project/policy`；增 `slug` |
| `ReportCard` | 改造 | `kind`→`type`；增 `period_key`、`summary`、`status`、`coverage_note`；`item_count` 为本期实际刊载条数，报告取材于精选候选（DEC-65）；`period_key`：资讯日报 = 出刊日、周报 = 所覆盖的 ISO 周、月报 = 所覆盖的自然月，`period_start` / `period_end` 为带时分的覆盖窗口（日报 [D-1 08:00, D 08:00)，沿用 AIHOT，BR-TIME-09），`issued_at` 为出刊时间 |
| `Report` | 改造 | 删 `content_version`/`policy_epoch` 之外增 `attributions`、`ai_label`；法规周月增 `coverage` |
| `Topics` | 保留 | 随 `Topic` |
| `Reports` | 改造 | 增 `status: available/empty` |
| `Policies` | 改造 | 增站点页码形态 |
| `Saved` | 改造 | 增 `events`、`policies`（收藏引用带类型：条目、事件、法规文书，读者站通则 11）；删 `policy_epoch` |
| `Settings` | 改造 | 见 §3 第 11 项；仅站点接口；增 `public_security_filing`、`news_license`（G-24），`icp_filing` 与二者均取自受保护运行时配置 |
| `ProductUpdates` | 改造 | `category`→`type {code,label}`；增 `highlights`；`published_time` 用 `TimeAssertion`；分页双形态 |
| `MetalLinks` | **删除** | 并入 `Settings.metal_links` |
| `FeedbackRequest` | 改造 | 见 §3 第 14 项 |
| `Accepted` | 保留 | 仅私有写；反馈改用新增 `FeedbackReceipt` |
| `PolicyScope` | **改名** `SourcePermission` | **九项**（DEC-58）：`fetch`、`store_metadata`、`process_locally`、`store_fulltext`、`external_model`、`public_excerpt`、`public_summary`、`public_original_fulltext`、`public_translation`（B 原件七项的 `internal_process`→`process_locally`，`retain` 拆为 `store_metadata` 与 `store_fulltext`，`public_fulltext`→`public_original_fulltext`，另增 `public_summary`）；**另预留第十项 `syndicate_fulltext`**（站外再分发，不在 Owner 2026-10-01 许可声明范围内，仍按 Q-47 默认关闭：默认未知即禁止；在写入契约中为可选字段，缺省按未知）；每项 `allow` / `deny` / `unknown`：**新建信源九项一律 `allow`，证据 `kind=owner_declared`，不设 `expires_at`（不自动到期）**，`deny` 只由逐源收紧产生（证据 `kind` 取 `source_objection` / `owner_instruction` / `legal_requirement`），`unknown` 只用于第十项默认值与缺权限版本记录（失败关闭）；带 `evidence[]`（含 `kind`）、确认人与时间（加入信源时一次确认）、范围条件与署名义务、附件是否在范围内；空出的 `PolicyScope` 名字不再使用，`/policies/scope` 的响应叫 `PolicyScopeList` |
| `SourceConfig` | 改造 | 发布方→信源→profile 三层；`entrypoint` 放宽为 http/https 并增 `insecure_transport_exception`（布尔，仅负责人高风险确认可开，带依据与审计）；B 的 `state` 改名 `admin_state`（`draft` / `active` / `paused` / `archived`，`archived` 为终态，`paused` 后可 `resume`），`health` 保留为独立的健康态（`healthy` / `no_new_content` / `degraded` / `blocked` / `unknown`，系统推导、不可手工设置），两轴分开，与 `01-domain-model.md` ENT-56 一致；`policy`→`SourcePermission` |
| `SourceWrite` | 改造 | 创建只填三项 `jurisdiction`、`name`、`entrypoint`，其余（语言、时区、获取方式、栏目、频率、权限线索、业务线建议）由系统检测，B 的 `publisher_id`、`source_id`、`cadence_seconds`、`policy` 不再是创建必填（OP-05）；编辑区分即时生效字段与新版本字段，`expected_version` 必带 |
| `SourceAction` | 改造 | `action` 增 `resume`（`pause`、`resume`、`activate` 仅首次、`archive`、`preview`）；`reason` 对高风险操作必填；删“暂停使预览失效” |
| `ReviewRequest` | 改造 | `decision` 四选 `accept/correct/drop/hold`；`reviewed_fields` 用枚举 `admission`、`facts`、`language`（可带子项 `title` / `guide` / `translation`）、`entities`、`clustering`、`dates`；法规线另加 `legal_state`、`interpretation`；`selection`、`impact` 作保留值，对应能力上线前界面不出现（取旧站实现键 `services/live_pipeline/content_review.py:16-18@main` 加新增的 `dates`，DR-99）；删 `suppress`/`restore`（下架与恢复另有独立命令） |
| `ReviewRecord` | 改造 | `decision` 四选 |
| `CostSummary` | **改名** `UsageSummary` | 去 `limit`、`warning_threshold`、`remaining`，`paused` 改为熔断状态；增 `manually_paused`（负责人人工暂停）、`breakers[]`（当前 `open` 的熔断，`BreakerState`）、`indicators[]`（三项熔断指标：`{trigger, subject, current, threshold, warning_at, ratio, level}`，`warning_at` = 预警线（阈值 × `warning_ratio`，计数类指标取整数且小于阈值，复合指标的两个分量各按预警比例计，口径同 `../../01-product/04-private-operations.md` OP-13），`level` 取 `normal` / `warning`（达到预警线，默认阈值的 70%，只提醒）/ `tripped`）、`unknown_reserved`、`local_reuse_count`、`provider_cache_hit`、`provider_cache_miss`、`by_stage`、`by_lane`（各业务线的已用、预留、排队中的付费工作数与预计所需金额，**无保底额与调剂额**）、`by_capability`、`by_source`、`by_purpose`（生产 / 研究 / 评测 / 试验）、`notices[]`（本月已推送的用量提示）；全部金额改整数微元（G-19）；已确认、已预留、未确认、本地复用、供应商缓存五项分开；暂停记录 `lane_controls[]` 移到 `GET /lane-controls`（§5.2） |
| `BreakerState` | **新增**（ENT-82） | `{id, lane, scope: {kind: capability_source / object / capability, capability?, source_id?, object_ref?}, trigger: repeated_input / object_cost / daily_total, observed（触发时的次数或整数微元）, threshold, config_version, opened_at, recent_receipt_ids[], state: open / recovered, recovered_by, recovered_at, recovery_note}`，ID 前缀 `brk_`；只有负责人可恢复，自动流程只能开启；`lane` 可为 `all`（跨业务线的单日总费用熔断） |
| `UsageControlConfig` | **新增**（ENT-83） | `{version, effective_at, updated_by, reason, breaker: {repeat_count, repeat_window_seconds, news_object_micros, policy_object_micros, daily_multiple, daily_floor_micros, daily_no_history_micros, lookback_days, warning_ratio（预警比例，默认 0.7）}, usage_notice: {step_micros}, usage_report: {push_time}, rate_limits[], unknown_alert: {amount_micros, oldest_age_seconds}}`；仅负责人可改，带 `expected_version` 与 `reason`，写审计；**没有月上限、提醒线、保底额与调剂额字段** |
| `UsageReport` | **新增**（BR-COST-18） | 月度用量报告（确定性汇总，不调模型）：`{month, covered_from, covered_to, settled_micros, unknown_reserved_micros, calls（按业务线 / 能力 / 信源）, cache_hit_rate, cost_per_item, top_tasks[10], notices[], breakers[], unknown_review_summary, issued_at}` |
| `Job`、`Sources`、`Jobs`、`Reviews` | 保留 | `Job` 增 `lane`、恢复建议 |
| `Session` | 改造 | `roles` 改 `owner/admin`（机器身份另列）；增能力集 |
| `PolicyExpression` | 改造 | 增 `issuing_body`（官方中文译本必填）、`instrument_number`、`checked_at`；`kind` 保持三值（B 原件已是 `original` / `official_translation` / `ai_translation`，与 `Reading.mode` 的三个取值同一套，DR-95）；`reading_state` 保留 |
| `PolicyVersionRef` | 改造 | `legal_status`→`legal_brief` |
| `ReadingPage` | 改造 | 删 `policy_epoch`；游标语义见 G-03 |
| `ResourceRef` | 改造 | `kind` 增 `account`、`suppression`、`breaker`、`usage_config`、`lane_control`、`model`、`feedback`、`settings` 等 |
| `CommandStatus` | 保留 | — |
| `Quote`、`Quotes` | **移出首版** | DEC-07；延后草案见契约 §3.9 |

## 5. 新增资源清单（B 没有的）

### 5.1 公开 API v3 与站点接口

| 资源 | 路径（公开 / 站点） | DTO | 说明 |
|---|---|---|---|
| 事件列表 | `GET /api/v3/events` | `EventCard[]` | 筛选同 `items` |
| 热点 | `GET /api/v3/hot`、`/api/site/hot` | `HotRanking`（公开：只给名次）/ `SiteHotRanking`（站点：含热度值） | 沿用 AIHOT；数据不足时 200 与空 `entries`（DEC-10；G-22） |
| 精选同步 | `GET /api/v3/featured/snapshot`、`/api/v3/featured/changes` | `FeaturedSnapshot`、`FeaturedChanges` | 沿用 AIHOT 的 selected snapshot / changes；水位失效 409 `snapshot_required`（契约 §3.5） |
| 主题详情 | `GET /api/v3/topics/{id}`、`/api/site/topics/{kind}/{slug}` | `Topic` + 条目与事件 | B 只有列表 |
| 发展线 | `GET /api/v3/stories/{id}`、`/api/site/stories/{id}` | `Story` | |
| 政策线 | `GET /api/v3/policy-threads/{id}` | `PolicyThread` | |
| 法规范围 | `GET /api/v3/policies/scope` | `PolicyScopeList` | 33 国与 EU/UN/OECD 分别列出可读篇数 |
| 法规周月汇总 | `GET /api/v3/policies/reports`、`…/{id}` | `ReportCard[]`、`Report` + `coverage` | `type=policy_weekly/policy_monthly` |
| 法规版本记录 | `GET /api/v3/policies/{id}/history`、`/api/site/policies/{id}/history`（两个通道都用游标） | `PolicyHistoryPage` | 本站各次公开版本，只列仍有公开资格者，不等于法定沿革（PG-22、F-POL-08）；`GET /policies/{id}` 另收 `document_revision_id` 读取历史公开快照 |
| 法域字典 | `GET /api/v3/jurisdictions` | `JurisdictionCard[]` | 36 个顶层对象（33 国 + EU/UN/OECD）加中国 14 个省区下级法域，含 `news_scope`/`policy_scope`；字段对照 `data/jurisdictions-36.json` |
| 公开新鲜度探针 | `GET /api/v3/freshness` | `Freshness` | 各业务线最近公开时间、最近一次计划检查成功时间与发布标识；经限流；外部拨测每 5 分钟读取（G-21） |
| 更新日志 | `GET /api/v3/changelog`、`/api/site/changelog` | `ProductUpdates` | 公开游标、站点页码 |
| 站点设置 | `GET /api/site/settings` | `SiteSettings` | 取代 B 的公开 `getSettings` 与 `getMetalLinks`；含 ICP 与公安联网备案号、新闻许可证信息（G-24） |
| 站点版本 | `GET /api/site/version` | `Version` | “有新内容”检查 |
| 站点列表与详情 | `GET /api/site/items`、`…/{id}`、`…/{id}/reading`、`/api/site/saved`、`/api/site/events/{id}`、`/api/site/events/{id}/sources`、`/api/site/stories/{id}/developments`、`/api/site/reports/{type}`、`…/latest`、`…/{period}`、`/api/site/policies…` | 同公开 DTO，分页为页码 | 契约 §4.2 |
| OpenAPI 文档 | `GET /openapi-v3.json` | OpenAPI 3.1 | 由 Zod 生成 |
| MCP、RSS 多路、站点地图、robots、`llms.txt`、分享图 | 见 `non-json-outputs.md` | — | 非 JSON |

### 5.2 私有接口（`/api/admin`，`interface-behavior.md` §2）

按 `01-product/04-private-operations.md` §7.2 的分组补齐；B 原件只有 session、reviews、jobs、costs（只读，v2.1 改为 usage）、source-profiles、commands，其余都是新增。所有写命令带 `Idempotency-Key`、`X-CSRF-Token` 与 `expected_version`，返回 202 的命令须可经 `GET /commands/{id}` 读回（`interface-behavior.md` §2.4）。

| 分组 | 路径与方法 | 说明（依据） |
|---|---|---|
| 身份（六个账号操作） | `POST/DELETE /session`（登录、退出）、`GET /session`、`GET/POST /accounts`（创建管理员）、`PATCH /accounts/{id}`（停用/启用、授予或撤回“模型配置”）、`POST /accounts/{id}/password-reset`、`POST /me/password` | 负责人专属（改自己口令除外）。**没有 `/setup`，也没有设置令牌或链接**：首个负责人由部署方在服务器侧一次性开通，初始密码经安全渠道交付、首次登录强制改密，初始开通无公共 HTTP 端点（DEC-43，OP-01）；原件与第一轮清单里的“首次设置令牌”作废 |
| 信源 | `GET/POST /source-profiles`（创建只填三项，另带一次性许可确认 `permission_confirmed=true`：加入信源时由负责人确认“该信源已获得许可”，系统生成权限版本 1，九项一律允许、证据 `owner_declared`、不设到期）、`GET/PUT /source-profiles/{id}`（配置编辑，分两类）、`POST /source-profiles/{id}/actions`（`activate` 仅首次 / `resume` / `pause` / `archive` / `preview`，只作用于该业务线的 profile）、`PUT /source-profiles/{id}/permissions`（逐源逐项**收紧**（允许→禁止）为普通确认、即时生效并返回受影响的已公开内容数，请求带依据类型 `source_objection` / `owner_instruction` / `legal_requirement` 与依据摘要；**放宽**为高风险，仅负责人；每次形成新权限版本；第十项 `syndicate_fulltext` 默认关闭）、`POST /sources/{id}/identity`（发布方身份：确认为官方 / 按非官方处理 / 放弃该信源）、`GET /source-targets`、`GET /source-targets/export`（原表对账读取与导出） | OP-03、OP-04、OP-05、OP-07；**v2.1 删除 `POST /source-permissions/confirmations`**（“权限待审定”批量确认随三类自动规则与批量确认一并作废，DEC-33）；http 例外是 `PUT /source-profiles/{id}` 中的 `insecure_transport_exception`，高风险确认并写审计（DEC-56）；robots 例外同为该接口中的 `robots_exception {path_prefixes[], basis_note}`，高风险确认、仅负责人、写审计（DEC-33，T-142）；预览只排队、由采集程序执行（DEC-57） |
| 候选信源（M3） | `GET /source-candidates`、`POST /source-candidates/{id}/actions`（`adopt` 加入 / `ignore` 忽略，忽略后 90 天内不再出现）、`POST /source-candidates/research`（发起“AI 检索新信源”，付费，确认框显示预计费用） | OP-03“候选信源”页签；`adopt` 走与创建信源相同的一次许可确认；没有自动启用路径（F-SRC-09、AI-15） |
| 内容 | `GET /content`、`GET /content/{id}`、`POST /content/{id}/revisions`（保存尚未发布的人工修订）、`POST /content/{id}/publish`（确认并发布）、`POST /content/{id}/conflict-checks`（单独核查事实冲突） | OP-09；先保存修订，再走“确认并发布”门 |
| 人工精选（M3） | `PUT /content/{id}/featured`（`{featured, reason, expected_version}`） | OP-09 第 6 项；仅负责人、普通确认、写审计；加入时精选公开时刻为加入时刻，取消时精选同步出现 `remove`（BR-SEL-02 第 7 点） |
| 下架与恢复 | `POST /suppressions`、`POST /suppressions/{id}/restore` | 独立命令，不走审核请求；对象为稳定身份，字段 = 原因码 + 补充说明 + `expected_version`；恢复返回实际恢复的对象与受影响成员数（DEC-54，OP-09） |
| 失败步骤 | `GET /jobs`、`GET /jobs/{id}`、`POST /jobs/{id}/recover` | 三种恢复建议之一；结果未确认的步骤不开放重试；无批量重试（OP-09） |
| 审核（建设期，默认关闭） | `GET/POST /reviews`、`POST /review-batches`（准备一组抽样稿件）、`PUT /review-tool`（开启或关闭，开启须设结束日期） | OP-11；`decision` 四选，`drop` 勾选“准入”时同一事务产生下架（DEC-54） |
| 精选校准与评分标准（M3，仅负责人） | `GET /selection-samples`、`GET/PUT /selection-samples/{id}`（标注 `select` / `reject` / `either`，带样本修订号）、`GET /selection-runs`、`GET /selection-runs/{id}`、`GET /selection-runs/{id}/results`（只读）、`GET/POST /selection-reviews`（Owner 审阅确认：`standard_review` 的 `approved` / `changes_requested` / `rejected`，及留出集检查确认 `holdout_confirm`）、`GET /selection-standards`、`GET /selection-standards/{version}`（OP-12 只读块） | OP-11 第 8 项、OP-12 第 5 项；BR-SEL-08、BR-SEL-09、ENT-84；标注页只显示标题、正文与发布时间；**没有“运行评测”接口**，浏览不触发付费调用；样本与标注是私有数据，不进公开接口 |
| 模型 | `GET/POST /models`、`GET/PUT /models/{id}`、`POST /models/{id}/actions`（`enable` / `disable` / `test`）、`GET/PUT /model-routes`（环节指派）、`PUT /model-credentials` | OP-12；密钥只写不可回读，只返回指纹；每个模型带价格表条目 PriceTable：模型、分时段单价（空闲/高峰两档，输入与输出各自按每百万 token 的整数微元）、币种 `CNY`、`observed_at`、`valid_until`（有效期 ≤45 天）与计费依据链接；价格缺失或过期不得启用，到期前 7 天告警（BR-COST-13、T-140；实体由 `01-domain-model.md` 定义） |
| 用量与熔断 | `GET /usage`（`UsageSummary`，`month` 默认本月）、`GET /usage/reports`、`GET /usage/reports/{month}`（`UsageReport`，月度用量报告历史）、`GET /breakers`（`BreakerState` 列表，含历史）、`GET /breakers/{id}`、`POST /breakers/{id}/recover`（仅负责人，一键恢复被点选的范围）、`GET /usage-config`、`PUT /usage-config`（`UsageControlConfig`，仅负责人，高风险）、`POST /usage/unknown-receipts/{id}`（逐笔核对） | OP-13（页面名“用量与熔断”）；BR-COST-17～20、ENT-82、ENT-83；**不设月度金额上限**，`PUT /usage-config` 没有上限、提醒线、保底额字段；恢复熔断写审计并推送，不解除人工暂停（二者互相独立）；回执与账本分录带 `lane`、能力、信源与 `purpose`（生产 / 研究 / 评测 / 试验）；金额整数微元（G-19）；核对只改该笔回执（DEC-55） |
| 暂停 | `GET /lane-controls`（当前生效的 LaneControl 记录）、`POST /lane-controls/actions`（暂停 / 恢复） | OP-13；LaneControl = `{lane, switch, holder, reason, set_by, expires_at, revision}`，`lane` 为 `news` / `policy` / `all`，`switch` 为 `collection` / `processing` / `publication`，`holder` 为 `owner` / `deploy` / `system`（人工只能写 `owner`；**`budget` 持有者已取消**，异常熔断是独立状态 `BreakerState`，不写 LaneControl），比较交换用 `revision`（ENT-54） |
| 反馈 | `GET /feedback`、`PATCH /feedback/{id}`（状态与内部备注）、`GET /feedback/{id}/screenshot`（短时效）、`GET /feedback/digests`（每周汇总） | OP-14；截图不进模型，联系方式不进汇总；处理完成 180 天自动删除联系方式与截图（DEC-46） |
| 站点 | `GET/PUT /settings` | OP-17；关于、联系方式、官方入口（含金属价格官方入口）；ICP 与公安联网备案号、新闻许可证信息取自受保护的运行时配置，不经此接口编辑（BR-SITE-03）；保存带 `expected_version` |
| 告警 | `GET/PUT /alert-channels`、`POST /alert-channels/test`、`GET /alerts/undelivered` | OP-20；飞书群自定义机器人为主、邮件为备（Owner 2026-10-01 已定，Q-22）；地址只写、回读只显示指纹；未送达列表（DEC-06）；告警类型含用量提示、异常熔断预警（达到熔断阈值 70%，OP-13 读取时称“用量预警”，ENT-51）与异常熔断触发（BR-COST-18～20） |
| 命令与审计 | `GET /commands/{id}`、`GET /audit` | 审计读取有界、脱敏、仅负责人，不设审计页；供只读运维 MCP 使用 |
| 只读运维（服务身份，无页面） | 健康、队列、运行记录、账本、审计读取、来源覆盖导出，经只读运维 MCP 暴露（OUT-11） | 不走浏览器会话，不在 `/api/admin` 之下；`observer` 只作机器只读身份（DEC-32） |

## 6. `examples.json` 补齐

- 现有 9 个样例（`Feed.empty`、`Feed.one`、`ItemDetail.guide`、`Version.empty`、`CostSummary.unknown`、`Reading.foreign`、`TimeAssertion.deadline_date_only`、`ReviewRequest.partial`、`CommandStatus.unknown`）只覆盖 46 个 DTO 中的 15 个（含嵌套引用）；法规主线的 `Policy`、`PolicyCard`、`PolicyScope`、`PolicyExpression`、`PolicyVersionRef`、`InterpretationSection`，以及 `Event`、`Report`、`Reports`、`Session` 等 31 个 DTO 没有任何可执行样例。
- 补齐要求：每个 operation 的成功响应与每个请求体至少 1 个样例；含 `Policy` 的原文、官方译本、AI 译文（以及解读完成与仅基本事实）四种形态，`PolicyScopeList` 的国家与组织，空态与不可用态（精选与热点数据不足、报告无内容、正文仅导读）；另含：有评分与没有评分（`score=null`）的 `ItemCard`、`HotRanking`（只给名次）与 `SiteHotRanking`（含热度值）、`FeaturedSnapshot` 与 `FeaturedChanges`（含 `remove`）、`UsageSummary`（含熔断 `open` 与 `level=warning` 的指标）、`BreakerState`；样例全部合成并在文件内标注，不是真实内容或质量金标。
- 自检增加两条：**schema 覆盖率 = 100%**、**operation 响应样例覆盖**（D20-integrity-004、D20-integrity-009），加入本包 `tools/validate_package.py` 的契约检查项。
- 改造后的旧样例：`Feed.empty`/`Feed.one` → `ItemList.empty`/`ItemList.one`（删 `policy_epoch`、`total`）；`Version.empty` 删 `policy_epoch`；`TimeAssertion.deadline_date_only` 补 `label`、`beijing_date`，并保持 `utc=null`；`CostSummary.unknown` → `UsageSummary.unknown`（去 `limit`、`remaining`，金额改整数微元）。

## 7. 领域事件 schema（B 原件本轮不改，重新生成清单）

`domain-events.schema.json` 只有 5 类事件（`content.revision.ready`、`intelligence.analysis.ready`、`editorial.review.changed`、`publication.activated`、`source.changed`），与 `../03-internal-contracts.md` §2 的事件目录在信封字段、必填项与类型数量上都不同，且 B 的 `ReviewChanged` 缺对象类型、`policy_version` 与法规实体 PolicyVersion 重名。v2.1 以 `../03-internal-contracts.md` §2.1–§2.3 与 §2.2（37 个有效类型）为准，`domain-events.schema.json` 与 `domain-event.example.json` 在转写时按下表**重新生成**（B 的 `additionalProperties:false` + `oneOf` + 合成示例的写法保留）：

| 编号 | 改造 | 依据 |
|---|---|---|
| E-01 | **信封**：`{event_id, event_type, schema_version, occurred_at, producer, lane, subject{kind, id, version}, correlation_id, causation_id, payload}`；`event_id` 为 `evn_<ULID>`，`schema_version` 为整数，`subject.version` ≥1，`correlation_id` 必填，`causation_id` 可空（根事件为 null）；B 的 `aggregate_id`/`aggregate_version` 并入 `subject.id`/`subject.version`，A 的 `producer` 与 `subject.kind` 保留 | D10-data-010；`03-internal-contracts.md` §2.1 |
| E-02 | **`lane` 枚举** `news` / `policy` / `all`：只有本质全局的事件（来源权限变化、身份撤销、候选信源、实体更新、内容版本推进、用量提示与用量报告、异常熔断开启与恢复（按范围也可为 `news` / `policy`）、紧急全停）才用 `all` | ADR-0016；§2.1 |
| E-03 | **事件目录 37 个有效类型**（A 原 23 类扩为 v2.0 的 33 类；v2.1 新增 6 类、废弃 2 类，见 E-08），按 §2.2 逐类列出发布方、lane、subject.kind 与 payload 要点；B 的 5 类事件的去向见 §2.3 对表 | §2.2、§2.3 |
| E-04 | **payload 字段改名**：`policy_version`→`permission_version`，`policy_epoch`→`suppression_epoch`（仅内部事件使用，不对外公开），`item_id`→`material_id`；**去掉** `generation`、`manifest`、`publication_id`（不采用发布代次，ADR-0004）：`publication.activated` → `publication.version_bumped` | D10-data-010；ADR-0004 |
| E-05 | **`editorial.review.changed` 拆为四类** `editorial.revised` / `editorial.withdrawn` / `editorial.restored` / `editorial.review_concluded`，`target_kind` 必填（条目 / 事件 / 发展线 / 报告 / 文书版本 / 语言表达 / 解读），下架与恢复带 `suppression_id` 与 `suppression_epoch` | DEC-54；§2.2 |
| E-06 | **`source.changed` 拆为** `source.profile_activated` / `profile_paused` / `profile_archived` / `profile_config_changed`（按采集配置、带 lane）、`source.permission_changed`（`permission_version`）、`source.identity_revoked` | DEC-34；§2.3 |
| E-07 | **示例与 ID 前缀**：`domain-event.example.json` 按 §2.1 的合成示例重写，ID 前缀取 `../01-domain-model.md` §1（`evn_`、`mat_`、`mrv_`、`pol_`、`pvr_`、`pex_`…）；B 示例里的 `item_demo`、`rev_demo`、`ev_demo` 只是占位，`rev_` 在本包是“人工修订” | `01-domain-model.md` §1；§2.3 补充 |
| E-08 | **v2.1 事件增减**：新增 `hot.ranking_computed`（events；热点榜重算完成，payload 不含热度值）、`usage.notice_raised`（月内累计每跨过 100 元的整数倍，只提示、不暂停）、`usage.report_issued`（每月 1 日用量报告）、`breaker.warning_raised`（指标达到熔断阈值的 70% 的预警，只提醒、不暂停）、`breaker.tripped` / `breaker.recovered`（异常熔断开启 / 负责人恢复）；**废弃** `budget.threshold_reached`（不设月度金额上限）与 `import.batch_finished`（旧数据一概不导入）；`domain-events.schema.json` 与示例转写时一并按 `../03-internal-contracts.md` §2.2 重新生成 | DEC-08、DEC-10、DEC-20；`../03-internal-contracts.md` §2.2 |

落文件由 `../03-internal-contracts.md` 的负责人完成，随后再转写到 Zod；在此之前本目录的 schema 与示例文件保持 B 原样，不得当作 v2.1 事件契约使用。

## 8. 转写到 Zod 的步骤

1. 在新仓库建 `packages/contracts`，按领域分文件（公共类型与时间、条目、事件与主题、报告、法规、站点、私有、错误）；DTO 一律 `strict`（对应封闭 `additionalProperties=false`）。
2. 按 §2–§5 修订后的语义逐 DTO 转写；每个 DTO 的枚举、长度、必填与跨字段约束（例如 `precision=date` 时 `utc` 为 null、完成块数等于应有块数才可标 `complete`）写成 Zod 约束或领域校验，并配契约测试。
3. 生成 OpenAPI 3.1、`/openapi-v3.json`、api-client 与 mock；生成器选型以 `04-architecture/02-tech-stack.md` 为准（注意 Fastify 默认的 JSON Schema Draft 7 与 OAS 3.1 语义不同，不能直接互喂，B:architecture/03-stack-decisions.md；`openapi-typescript` 等依赖旧编译器接口的生成工具，按 `02-tech-stack.md` 的 TypeScript 7 兼容性一节用别名包或独立 tooling 包处理，见 D13-stack-001）。
4. 验收：生成的 OpenAPI 与本文 §3–§5 清单逐操作、逐 DTO 语义等价；样例全部通过；干净克隆上一条命令生成且与已提交版本逐字节一致（AC-OUT-18）；漂移检查与破坏性变更检查由验证命令执行，默认不依赖 GitHub Actions（旧ADR-0038，Owner 2026-09-26 批准）。
5. B 包的 `tools/build_contracts.py` 不进入新仓库；B 包的 `tools/validate_package.py` 与 `requirements-validation.txt` 同样不带入（它依赖第三方库、会改写自己的证据文件）。本包自带的 `tools/validate_package.py` 只用标准库，仅用于交接包自检。
6. 变更流程：业务契约文档 `../02-public-api-contract.md` 先改 → Zod → 生成物；禁止手改生成物，禁止同时维护手写 OpenAPI、TypeScript interface 与 Zod 三套不比对的定义。

## 9. AIHOT 底座改造项（与契约直接相关）

“现状”列写的是 AIHOT 快照里的路径与做法（例如 `/api/v1/*`），**不是 v2.1 路径**；v2.1 一律改为 `/api/v3/*`、`/api/site/*`、`/api/admin/*`，见“改造”列。

| 底座位置 | AIHOT 现状（旧路径，待改造） | 改造 |
|---|---|---|
| `apps/api/src/routes/v1.ts` | `/api/v1/items`、`hot-topics`、`stories/:publicId`、`dailies*`、`selected/snapshot`、`selected/changes`、`codex-resets*` | 改为 `/api/v3` 资源（`items`、`hot`（只给名次，不含热度值）、`stories/{id}`、`reports`…）；`selected/snapshot`、`selected/changes` 沿用并改名 `featured/snapshot`、`featured/changes`（精选随切换前完成；不沿用 `fields=minimal`，它去掉署名与原文链接）；`Item.score` 沿用（无评分为 null）；`codex-resets*` 删除（DEC-64） |
| `apps/api/src/routes/site.ts` | 20 多个站点端点 | 按契约 §4.2 表保留、改造或删除 |
| `packages/contracts/src/http-policy.ts` | `max-age=60~300` 加 `stale-while-revalidate=300~3600`；RSS `max-age=300` 加 SWR | 改为 `max-age=0, must-revalidate`，删除所有 stale 指令；`REDIRECTS` 重定向表不沿用（RSS 别名、leaderboard、管理书签各项全部删除），也不加入任何旧站地址的重定向，不存在的地址一律 404（契约 §5.1） |
| 错误形状 | 驼峰 `Problem`（`type/title/status/detail/code/requestId`） | 改为 `{code, message, request_id, retry_after_seconds?}` |
| `reference/public-v1.openapi.json`、`/openapi-v1.json` | 手工维护的模板文件 | 由 Zod 生成，路径 `/openapi-v3.json`；后端已依赖 zod 4 |
| `apps/api/src/routes/static.ts` | 站点地图只收“已入选或人工标记”；sitemap `s-maxage=300` | 收录策略改读页面类型表；去掉共享缓存时长；`robots.txt` 路径改 v3 |
| `apps/api/src/routes/feedback.ts` | 字段 `content/email/pageUrl/screenshot`，返回 201，`bodyLimit` 12MB | 字段改 `message/contact/page_url/screenshot`；返回 `201 {ok,id}`；加幂等键；体积上限按 2MB 截图加编码余量收紧 |
| `apps/api/src/routes/feeds.ts` | RSS 描述、时间、guid 规则 | 按 `non-json-outputs.md` §2 |
| `apps/api/src/routes/mcp.ts` | 5 个工具、无署名与再分发判断 | 工具扩到法规线；前置署名与 AI 标识；正文只对再分发允许的来源返回；`get_hot` 只返回名次、不返回热度值（沿用 AIHOT） |
| `apps/api/src/app.ts` | `trustProxy: true` | 改为 1 跳或具体代理地址，绝不用 `true`（D15-secops-010，限流键依赖它） |

## 10. 验证方法与边界

- 本目录文件是设计产物：不连接来源、模型或生产。`openapi.json` 本轮未改，**尚未做转写后的生成比对**；转写完成并通过 §8 第 4 步前，不得宣称契约已冻结。
- 包内自检由本包 `tools/validate_package.py` 执行：`$ref` 可解析、`operationId` 唯一；另需补两条检查：schema 覆盖率、operation 响应样例覆盖（§6）。
- 真实内容、质量金标与语义评测不由契约样例证明，见 `05-quality/05-evaluation-sets.md`。

## 11. 其他文件提来的字段级请求登记（第二轮跨文件对齐）

下表把第二轮其他写作者对 `openapi.json`、`examples.json`、`domain-events.schema.json` 提出的字段级请求逐条登记：写清涉及的 schema 或路径、要改成什么、依据的裁决或规则编号，以及本包的处置与落点。**这些 JSON 仍是 B 包原件，本包不直接改写；转写时按本表与 §2–§7 一次性落实。** 与裁决表不一致的请求不采用，并写明原因。

| 登记号 | 请求来源 | 涉及 schema / 路径 | 要改成什么 | 依据 | 处置与落点 |
|---|---|---|---|---|---|
| X-01 | 私有操作（`04-private-operations.md`） | `Session`（`roles`）、`securitySchemes.session`；B 的 `interface-behavior.md` 身份段 | `roles` 的 `owner/editor/observer` 改为人类角色 `owner` / `admin`，`observer` 只作机器只读身份（只读运维 MCP、健康读取），不进浏览器会话；增能力集；`securitySchemes.session` 保留 `__Host-session`。“身份首选飞书 open_id/union_id”“owner allowlist”“第二账号拒绝”的描述与示例一律删除、不得再引入（这些文字在 B 的 `interface-behavior.md`，不在 `openapi.json`，v2.0 的 `interface-behavior.md` 已删） | DEC-05、DEC-32；OP-01、OP-15 | 采用；§4 `Session` 行、§5.2 身份行 |
| X-02 | 私有操作 §7.2 | 私有路径（B 只有 session、reviews、jobs、costs、source-profiles、commands） | 补齐账号、信源、内容、模型、用量与熔断、反馈、站点、告警的命令与查询，路径与方法见 §5.2（v2.1：预算改为用量与熔断）；首个负责人开通没有 HTTP 端点，不增 `/setup` | `04-private-operations.md` §7.2；DEC-43 | 采用；§5.2、`interface-behavior.md` §2.5 |
| X-03 | 私有操作 | `SourceAction.action` | 枚举增 `resume`：`pause` / `resume` / `activate`（仅首次启用）/ `archive` / `preview`；删“暂停使预览失效” | DEC-57 | 采用；§4 `SourceAction` 行 |
| X-04 | 私有操作、信源策略 | `SourceConfig.entrypoint`、`SourceWrite.entrypoint`、`SourceCredit.original_url`、`ReadingBlock.links.href` | `^https://` 约束放宽为 `http` / `https` 的 scheme 白名单；`SourceConfig` 增 `insecure_transport_exception`（负责人高风险确认才可开）；`SourceCredit` 增 `insecure_transport`，页面与 API 据此提示“该来源仅提供非加密访问”。信源策略请求里的 `http_only_approved` 不采用，沿用 `insecure_transport_exception`，与私有页面规格同名 | DEC-56；OP-04 | 部分采用（字段名不同）；G-08、§4 `SourceConfig` 行 |
| X-05 | 私有操作 | `ReviewRequest.decision`、`reviewed_fields`、`ReviewRecord.decision` | `decision` 只留 `accept` / `correct` / `drop` / `hold`；`reviewed_fields` 用枚举（`admission`、`facts`、`language`、`entities`、`clustering`、`dates`，法规线加 `legal_state`、`interpretation`，`selection`、`impact` 作保留值）；删 `suppress` / `restore` | DEC-54；DR-99（旧站键 `content_review.py:16-18@main`） | 采用；§4 `ReviewRequest` 行；键名以 DR-99 与旧站实现为准，不用第一轮自拟的英文名 |
| X-06 | 私有操作 | 新增 `POST /suppressions`、`POST /suppressions/{id}/restore` | 独立命令：对象为稳定身份（材料、事件、发展线、报告刊期、文书版本、语言表达），请求 = `{object_kind, object_id, reason_code, note?, expected_version}`，原因码七类（版权或来源要求、事实错误、与矿业无关、重复内容、质量问题无法阅读、隐私或安全、其他；代码名转写时按 OP-09 定）；恢复响应返回实际恢复的对象与受影响成员数；每条下架记录独立，成组下架保存成员快照 | DEC-54；OP-09；INV-03 | 采用；§5.2 下架与恢复行 |
| X-07 | 私有操作、规则（成本） | `CostSummary`（v2.1 改名 `UsageSummary`） | 去 `limit`、`warning_threshold`、`remaining`，`paused` 改熔断状态；增 `manually_paused`、`breakers[]`、`indicators[]`、`unknown_reserved`、`local_reuse_count`、`provider_cache_hit`、`provider_cache_miss`、`by_stage`、`by_lane`（无保底额）、`by_capability`、`by_source`、`by_purpose`；金额一律整数微元，字段名带 `_micros` 后缀，币种 `CNY` | OP-13；BR-COST-03、BR-COST-14、BR-COST-17～20；DEC-08 | 采用（v2.1 按 G08 请求改写）；§4 `UsageSummary` 行、G-19、G-25 |
| X-08 | 私有操作 | `ProductUpdates.items[]` | 增 `highlights[]`；`category` 改 `type {code,label}` 四值（公告、更新、优化、下线）；`published_time` 用 `TimeAssertion`；站点接口页码、公开接口游标 | OP-17；DEC-23；R16-docs-006 | 采用；§4 `ProductUpdates` 行 |
| X-09 | 内容标准 | `ItemCard.title_zh`、`ItemCard.summary_zh`、`ItemCard.recommendation_reason`（B 上限 1000 / 8000 / 1000）；`Event`、`Policy`、`PolicyCard` 的标题与摘要 | 标题上限 250、导读上限 2000、推荐理由上限 1000（DR-17 的“存储与契约上限”），字段同时改名 `title`、`guide`、`reason`；`title` 只含标题本身、不拼发布方（`publisher` 独立字段，DR-11）；`guide` 不含署名前缀（DR-74） | DR-11、DR-17、DR-74 | 采用；G-10、§4 `ItemCard` 行 |
| X-10 | 内容标准 | `Reading`、`ReadingPage` | 增 `state`（六态）与 `guide_only_reason`（四值）；`mode` 由五值改为 `original` / `official_translation` / `ai_translation` 三值，无可读正文时为 null；`PolicyExpression.kind` 已是同一套三值，保持不变 | DR-20、DR-82、DR-95 | 采用；§4 `Reading`、`PolicyExpression` 行 |
| X-11 | 内容标准、法规服务 | `Policy.legal_state`（B 的 `legal_status` 与 `status_basis`） | 改为分维结构：性质、立法阶段、公布、施行、适用、截止、废止，每维可为 `unknown` 并带依据与证据；枚举取值与旧分支实现一致 | DR-48；DEC-36；`interpretation.py:399-438@policy` | 采用；§4 `Policy` 行 |
| X-12 | 内容标准、功能、AI、规则 | `ItemCard`、`ItemDetail`、`Policy`、`Report` 增 `ai_label` 与 `ai_metadata` | `ai_label` 只取 `ai_generated` / `ai_assisted_human_edited`，删 `ai_assisted`（“已人工复核”）的旧写法；详情类 DTO 另带 `ai_metadata {provider, content_id}`；任何出口不出现“已复核 / 已核实 / 已审核” | DEC-38；DR-87；BR-PUB-10；F-PUB-07 | 采用；G-17 |
| X-13 | 信源策略 | `PolicyScope`（改名 `SourcePermission`）、`SourceConfig.policy`、`SourceWrite.policy` | 取 DEC-58 的九项：`fetch`、`store_metadata`、`process_locally`、`store_fulltext`、`external_model`、`public_excerpt`、`public_summary`、`public_original_fulltext`、`public_translation`；新建信源九项一律 `allow`（证据 `owner_declared`，不设到期，DEC-33），`deny` 只由逐源收紧产生；带证据、确认人、范围条件与署名义务、附件是否在范围内；第十项 `syndicate_fulltext` 只预留，仍按 Q-47 默认关闭 | DEC-58；DEC-33；Q-47 | 采用九项，第十项预留；§4 `PolicyScope` 行（第一轮写作“共十项”，已改；v2.1 按 DEC-33 改写默认值） |
| X-14 | 信源策略 | `jurisdictions[]`（B 的 `jurisdictions` 字符串、`jurisdiction_path`） | `{code, label, kind, parent?}`，`kind` 为 `country`（ISO 3166-1）、`subdivision`（ISO 3166-2，如 `CN-GZ`）、`organization`（`EU` / `UN` / `OECD`）；与 `data/jurisdictions-36.json` 一致（`id`→`code`，`name_zh`→`label`）；`JurisdictionCard` 增 `news_scope`、`policy_scope`；`tier`、`policy_first_batch_required` 不对外 | DEC-03、DEC-51 | 采用；G-07、§5.1 法域字典行 |
| X-15 | 信源策略 | `SourceConfig` 的状态字段 | B 的 `state` 改名 `admin_state`（`draft` / `active` / `paused` / `archived`），`health` 保持为独立健康态；请求里的 `health_state` 不采用，字段名与 `01-domain-model.md` ENT-56 一致 | DEC-34、DEC-57；ENT-56 | 部分采用（健康态沿用 `health`）；§4 `SourceConfig` 行 |
| X-16 | 规则（时间） | `TimeAssertion` | 增中文展示文本与北京日期：字段名定为 `label`（请求写作 `label_zh`，不采用，沿用裁决写法）与 `beijing_date`，另有 `meaning_label`；`meaning` 增 `repealed`（废止日期），以及 `public_inspection`、`formally_published`、`site_public`、`checked` | DEC-50；DEC-36；BR-TIME-12 | 部分采用；G-05、G-18 |
| X-17 | 规则（时间） | `ItemCard.first_public_at`、`PolicyCard.first_public_at` | 写一次永不改变，另带 `first_public_basis`（`live` / `unknown`；`legacy_snapshot_min` 【已废弃】）；数据模型里它是系统事实、不是来源声明，DTO 沿用 `TimeAssertion` 形状（`meaning=site_public`）只为展示一致 | BR-TIME-11；INV-08 | 采用；G-18 |
| X-18 | 规则（成本） | 模型资源（`POST/GET /models`）的价格字段 | 新增价格表条目 PriceTable：模型、分时段单价、币种、`observed_at`、`valid_until`（≤45 天）、依据链接；金额整数微元 | BR-COST-13、BR-COST-14；T-140 | 采用；§5.2 模型行 |
| X-19 | 规则（暂停） | `GET /lane-controls`、`POST /lane-controls/actions`（原 `GET /budget` 的 `lane_controls[]`、`POST /budget/actions`） | 暂停记录 LaneControl：`lane`、`switch`（采集 / 处理 / 公开）、`holder`（`owner` / `deploy` / `system`，人工只能写 `owner`；`budget` 持有者已取消）、原因、操作人、到期时间、`revision`；到期未恢复告警；暂停全部业务线的全部自动处理最长 24 小时 | ENT-54；INV-30；OP-13 | 采用（v2.1 按 G09 请求去掉 `budget`）；§5.2 暂停行 |
| X-20 | 规则（成本） | 回执与账本分录（`usage/unknown-receipts/{id}` 响应，原 `budget/unknown-receipts/{id}`） | 带 `lane`、能力、信源与 `purpose`（生产 / 研究 / 评测 / 试验）；金额整数微元；核对只改该笔回执，结论为未计费须填依据 | DEC-08、DEC-55；BR-COST-14、BR-COST-18 | 采用；§5.2 用量与熔断行 |
| X-21 | 规则（编辑） | `content/{id}/revisions` 响应的 `state` | 人工修订状态取 `effective` / `needs_review` / `conflict` / `superseded` / `withdrawn`；`needs_review`、`conflict` 触发异常告警 | `03-internal-contracts.md` §2.2（`editorial.revised`）；BR-EDT | 采用；转写时作为 `EditorialRevision` 的状态枚举 |
| X-22 | 数据（内部契约） | `domain-events.schema.json`、`domain-event.example.json` | 按 `03-internal-contracts.md` §2.1–§2.3 重新生成：新信封、33 个事件类型、payload 改名、去掉 generation 与 manifest、editorial 拆四类、`lane` 枚举 `news` / `policy` / `all`、示例 ID 前缀改用 `01-domain-model.md` §1 | D10-data-010；ADR-0004 | 采用；§7 的 E-01～E-07 |
| X-23 | 法规服务 | `Policy`、`PolicyCard`、`listPolicies` | 增 `PolicyImpact`、`impacts[]`、`main_points[]`、`themes[]`、`change_kind`、`applicability_summary`、多维 `legal_state`；`theme` 参数改七主题枚举（`investment_company`、`mineral_rights`、`land_construction`、`safety_environment`、`labour_community`、`tax_finance`、`trade_transport`）；相关性判定与质量资格不进公开 DTO | D11-policy-005；BR-POL-10、BR-POL-11、BR-POL-13；DEC-11 | 采用；§3 第 8 项、§4 `Policy`、`PolicyCard` 行 |
| X-24 | 读者页、AI | `Version`（站点版）、`Saved`、`Policy` 的 `guide` 与 `gaps`、`PolicyImpact.horizon` | 站点 `/version` 增不透明 `suppression_epoch`；`Saved` 增 `events`；`Policy` 增 `guide`（AI-20 的 `dynamic_zh`）与 `gaps`；`PolicyImpact` 不含 `horizon`（当前与潜在影响在 `condition` 里写明前提） | 读者站通则 10、通则 11、PG-18；AI-20；BR-POL-13；DEC-11 | 采用；G-20、§4 相应行 |
| X-25 | 本包自身 | `examples.json` | 按 §6 补齐到每个 operation 至少 1 个成功响应样例、每个请求体至少 1 个样例；schema 覆盖率 100% | D20-integrity-004 | 登记；§6 |
| X-26 | 读者站规格（通则 4、通则 7、PG-21）对照 | `ItemCard`、站点 `GET /items`、`GET /policies/reports/{id}` | `ItemCard` 增 `updated_time`（来源更新时间，列表时间栏对仅日期条目按“来源更新 → 本站公开 → —”回退）；站点 `GET /items` 增 `fold`（事件折叠，默认 `event`——Owner 2026-10-01 已定 Q-26；仅无 `q` 与筛选条件时折叠）；法规汇总详情增 `edition`（读取较早快照）、`jurisdiction`、`theme`、`cursor` | DEC-24、DEC-25、DEC-22；Q-26 | 采用；契约 §3.2、§4.1、§4.2 |
| X-27 | 规则（成本）、架构（G08、G09 请求） | 私有路径 `/budget*`、`CostSummary`、LaneControl 持有者 | 取消 `/budget*`，改 `/usage*`、`/breakers*`、`/usage-config`、`/lane-controls*`（G-25）；`CostSummary` 改 `UsageSummary`；`holder` 去 `budget`；`PUT /budget/limits` 的上限、提醒线、保底额删除，阈值进 `UsageControlConfig`（ENT-83）；熔断指标预警（70%）状态进 `UsageSummary.indicators[]` | DEC-08、DEC-09；BR-COST-17～20；ENT-82、ENT-83 | 采用；G-25、§4、§5.2 |
| X-28 | 内容、AI（G06 请求） | `ItemCard.score`、`GET /hot` | `score` = 两次评分的平均值，向下取整；没有评分为 null，任何出口不出现 0；热点榜机器出口只给名次、不含热度值（网页形态才有） | DEC-10；BR-SEL-05、BR-SEL-07 | 采用；G-22、契约 §3.2、§3.5 |
| X-29 | 内容、AI（G06 请求） | `Reading.guide_only_reason` | `summary_only_permission` 取值保留，含义改为“逐源收紧后权限只到摘要”，其余三值为技术原因；“仅导读”只剩技术原因与逐源收紧 | DEC-33；DR-20、DR-82 | 采用；§4 `Reading` 行、契约 §3.4 |
| X-30 | 数据（G08 请求） | `domain-events.schema.json`、`domain-event.example.json` | v2.1 事件目录 37 个有效类型（新增 `hot.ranking_computed`、`usage.notice_raised`、`usage.report_issued`、`breaker.warning_raised`、`breaker.tripped`、`breaker.recovered`；废弃 `budget.threshold_reached`、`import.batch_finished`），转写时按 `../03-internal-contracts.md` §2.2 重新生成 | DEC-08、DEC-10、DEC-20 | 采用；§7 E-02、E-03、E-08 |
| X-31 | 功能（G02 请求） | F-055 旧链接与旧接口处置的页面规格；公开 ID 形态与旧站区分 | 不采用：Owner 2026-10-01 答复“旧文章链接也全都不要”，新站不为旧站任何地址做兼容，也不设“本站已全新改版”（410）说明页，不为旧站 ID 形态设别名；公开 ID 不复用是新站自身的规则（INV-18），前缀以 `../01-domain-model.md` §1 为准 | DEC-21；INV-18 | 不采用；G-23、契约 §5.1 |
