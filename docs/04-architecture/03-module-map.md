# 模块划分与边界

> 本文件定义新仓库的**模块、所有权、数据归属、公开接口形态、依赖方向**，以及从 AIHOT 到目标形态的改造路径。它是多 Agent 并行开发的地基：一条泳道负责 1–3 个模块。
> 模块名是规范名（代码目录、数据库 schema、包名、泳道名都用它），写死、不许别名。本表取代 A 包 16 模块表与 B 包“9 个领域包 + 6 个平台包”表（A/B 对照见 2.3 节）。
> 标注：【Owner 决定】附日期与出处；其余为【设计】工程基线（ADR-0002），M0 结束前由架构 Agent 定稿。
> **v2.1 修订（2026-10-01 按 Owner 答复）**：精选与热点按 AIHOT 机制写入 `enrichment`、`events`、`publication` 的职责（DEC-64、ADR-0021）；`ai-gateway` 改为用量账本与异常熔断、不设月度金额上限（DEC-08）；旧数据导入器作废（DEC-20）；里程碑表按全面切换核对（DEC-19）。**追加（2026-10-01）**：旧站地址一概不做兼容，不存在的地址一律 404（DEC-21）；熔断前加 70% 预警；资讯报告的选材与出刊时间都沿用 AIHOT（取自精选候选，日报 08:00／周报周一 10:00／月报 1 日 10:30，DEC-65）；矿业版评分标准是草案，须经 Owner 审阅确认（ADR-0021）。

---

## 1. 总体分层

```text
┌──────────────────────── 应用层（组合根，不写业务逻辑）─────────────────────────────┐
│ apps/web                 apps/api                  apps/worker          apps/fetcher │
│ （读者站 SSR +            （HTTP 组合根；同一镜像      （任务组合根；         （抓取与解析隔离；│
│   私有路由组）             public/private 两实例）       lane×stage 调度）      无库无模型密钥）│
└───────┬────────────────────────┬──────────────────────────┬───────────────────┬───────┘
   只经 api-client          注册各模块 routes           注册各模块 jobs      只加载 acquisition
        │                  （按实例角色二选一）                 │               的 fetch 运行时
┌──────────────────────────── 业务模块层 packages/domains/* ─────────────────────────────┐
│ 供给侧（两线共用）：sources → acquisition → content                                      │
│ 资讯线：enrichment → entities* → events          法规线：policy（端到端）                  │
│ 人工决定：editorial（两线共用）      模型：ai-gateway（两线共用，按线记账）                    │
│ 出口：publication（唯一公开读取层）→ reports      读者：feedback                           │
│ （* entities 两线共用）                                                                  │
└──────────────────────────────────────────────────────────────────────────────────────┘
┌──────────────── 平台包 packages/platform/*（不依赖任何业务模块）────────────────────────┐
│ identity（账号·会话·服务身份·审计）  ops（告警·心跳·按 lane 指标·备份状态）  queue（pg-boss·lane×stage│
│ 队列·outbox/inbox·长任务执行记录）  storage（对象存储端口：COS/本地目录）  config（按角色配置与密钥│
│ 文件·dbFor(role)）  telemetry（日志·OTel API）                                            │
└──────────────────────────────────────────────────────────────────────────────────────┘
┌──────────────── 共享包 packages/* ─────────────────────────────────────────────────────┐
│ contracts（Zod 契约·事件·任务·端口接口·时间值类型）  api-client（公开/私有两个生成入口）  ui  testkit │
└──────────────────────────────────────────────────────────────────────────────────────┘
tooling/（只放契约生成步骤：读 contracts 输入、写 api-client 输出；固定 TypeScript 5.9.x；不属业务模块，不被任何应用或模块依赖）
industry/（行业包：分类、法域字典 36 个对象、矿种、词表、提示词、门槛初值、品牌文案、种子数据）
database/migrations/<module>/    UPSTREAM.md（AIHOT 固定提交、许可、移植清单）
```

---

## 2. 十二个业务模块与平台包

### 2.1 业务模块（`packages/domains/<module>`，包名 `@amp/<module>`）

| 模块（泳道） | 中文 | 业务线 | 一句话职责 | 主要规格域 | 可独立验收 | 禁止 |
|---|---|---|---|---|---|---|
| `sources` | 信源 | 两线 | 发布方 → 信源 → 按 lane 的采集配置（版本化、启停、健康）；权限矩阵九项（证据、加入信源时一次确认、逐源收紧；`owner_declared` 不设自动到期）；试抓预览与启用门；原始信源表映射；覆盖缺口；离线信源研究；签发 `ProcessingPermit` | F-SRC、BR-SRC、AI-14、AI-15（离线有界工具循环） | 同一信源两条线独立启停；缺失、被收紧或带期限已到期的权限不扩大授权；预览绑定配置与权限版本 | 消费方直接改启停或权限 |
| `acquisition` | 采集 | 两线 | 按 lane×stage 的抓取计划、游标与检查点、分页续抓、回填窗口、单源失败隔离、尝试记录；**fetch 运行时**（在 fetcher 执行）：适配器、SSRF/robots/权限门、HTML 抽取、PDF/OCR | F-ACQ、BR-ACQ | 条件请求、部分失败、每源限流、双 lane 公平；失败不前移游标 | fetch 运行时 import 数据库访问代码或持有发布权限 |
| `content` | 材料与正文 | 两线 | 材料与修订、URL 规范化与精确判重、正文块、附件、时间断言、译文分段存储与续译、许可范围执行、旧文判定；原件对象生命周期（经 `platform/storage`：暂存→引用→到期删除→回收） | F-MAT、BR-MAT、BR-TIME | HTML/PDF/编码/表格/否定与数字保真；缺附件不标完整 | 用译文覆盖原材料修订；对象上传成功即视为提交 |
| `enrichment` | 资讯加工 | 仅资讯 | 预筛（BLOCK / PASS / UNKNOWN，宽进）与矿业关联、结构化抽取、中文标题/导读/推荐理由（分层写作：入选与平均分高于 50 的按完整写法，其余写简版）、公司名注释（读 entities 词表）；**精选漏斗沿用 AIHOT**：同一份评分标准（矿业版是草案，生效前须经 Owner 审阅确认，BR-SEL-09）独立两次评分，两次之和 ≥ 2 × 按信源分级的门槛（T1 60 / T1_5 65 / T2 76 起点，校准后可调）才入选，平均分高于 50 的未入选资料也按精选写法写作；入选资料等事件归组完成（最多 3 分钟）再露出；平均分（向下取整）与推荐理由；人工精选（仅负责人）；首页排序（原 A 的 selection）；Tier 0 规则 | F-ENR、F-SEL、AI-01～AI-06（含 AI-03 评分）、R-26（精选漏斗，程序判定） | 预筛与评分可复现（同输入、同提示词版本、同结果）；两次评分之和不足 2 × 门槛不入选；没有评分的条目不输出分数，绝不输出 0 或占位值；数据不足时诚实空态 | 拦截或改写法规线材料；把旧 55/70/65/75 公式当规则（已作废，DEC-10、ADR-0021）；把未经 Owner 审阅确认的矿业版评分标准用于正式站的精选；在本模块计算热点榜（热点归 `events`） |
| `entities` | 实体 | 两线 | 公司、矿山/项目、政府机构、法域（36 个对象，带 `news_scope`/`policy_scope`）、矿种的稳定身份、多语言别名、证据；实体解析与中文名核实 | F-ENT、AI-07 | 重名、跨语种、中文译名、国家与项目匹配；不凭模型猜 ID；字符串包含不等于提及 | 公开未核实的暂译（DEC-37） |
| `events` | 事件 | 资讯（可读法规） | 候选召回、成对关系判断、事件与发展线、代表条目、时间线、合并/拆分历史、人工归组覆盖、事件综述；**热度与热点榜沿用 AIHOT**：按事件排名，过去 48 小时内被多个独立信源共同讨论的事件取前 10，独立信源按发布方与来源族去重（转载同稿不计）、同一参与者只计一次，榜单带规则版本；事件卡与事件页所需的代表稿与“另有 N 家来源报道”；读取 policy 公开查询把新闻事件挂到政策线 | F-EVT、BR-EVT、AI-08、AI-09（事件综述，随全面切换启用）、热点榜（R-24，程序计算、不调模型）、AI-16（候选，默认不启用） | 同发生/实质进展/相关/不同/不确定；人工锁优先；并发重复不双建；热度按来源时间计、重复采集不加热；榜单带规则版本 | 仅凭同企业/矿种/国家合并；让法规文书进入热点榜（DEC-62） |
| `policy` | 法规政策 | 仅法规 | 法规线端到端：文书识别、法律性质与立法阶段、各类日期分维（DEC-36）、版本与多语言表达、附件、全文事实与完整中文、候选解读与全篇语义核验、定性且条件化的影响、周月汇总素材 | F-POL、BR-POL、AI-17～AI-23（AI-22 默认不启用；AI-23 待选型） | 草案/公布/施行/废止分别；期限、例外、范围有证据；不依赖资讯精选 | 依赖 enrichment 或 events；输出数值影响分或特定企业定向结论（DEC-11） |
| `editorial` | 人工决定 | 两线 | 下架/恢复、人工修订（与自动稿分开）、异常记录、建设期抽样审核记录（默认关闭）；只写自己的表，publication 查询时叠加 | F-EDT、BR-EDT | 人工决定比较交换；恢复不连带；升级/回填不复活下架 | 改写来源材料或账本；成为发布关卡（DEC-14） |
| `publication` | 公开读取层 | 两线 | 逐条增量投影、内容版本、抑制层先行、中文搜索、RSS、站点地图、llms.txt、分享图、公开 API（`/api/v3`；不为旧站接口做兼容，`/api/` 下不存在的路径统一返回错误体 `not_found`）与公开 MCP 查询、精选与热点榜（机器出口只给名次）、事件卡与事件页的读取、收藏解析、AI 生成内容标识；产品更新日志、站点资料与条款（含 ICP 备案号、公安联网备案号与新闻许可证信息的展示）、金属价格官方入口页（原 A 的 site） | F-PUB、F-RDR（数据侧）、F-SITE | 全部出口撤回一致；某条构建失败保留该条旧的合法投影；合法空站与损坏态区分 | 读取任意私有表拼接接口；设全站代次 |
| `reports` | 报告 | 两线 | 资讯日报/周报/月报与法规周月汇总：**资讯报告的选材与出刊时间都沿用 AIHOT**（DEC-65，北京时间）：从精选候选里取材，同一事实去重，受版面容量限制，日报导语与周报、月报综述由模型写；日报每天 08:00 出刊、覆盖前一天 08:00 到当天 08:00，周报每周一 10:00 出上一个 ISO 周，月报每月 1 日 10:30 出上一个自然月，每小时检查并补出缺的刊期，跨过刊期边界才确定精选公开时间的归入下一期、不设“补录”；法规周月汇总按北京时间自然周、自然月（确定性快照，BR-POL-14）；刊期成员与修订、引用、覆盖限制说明；经 publication 查询取材 | F-RPT、BR-RPT、AI-13（日报导语与周月综述，仅资讯线；法规周月汇总首版不调模型） | 同周期同刊期幂等；取材只来自精选候选；撤下成员消隐；跨过刊期边界才确定精选公开时间的进下一期（不设“补录”） | 改写历史刊期（更正与下架除外）；把全部合格内容都放进报告（全量内容在“全部矿业动态”里看）；法规汇总重新解读 |
| `ai-gateway` | 模型网关 | 两线 | 能力注册、路由与准入、提供商适配、回执、用量账本（按业务线、能力、信源记账，不设月度金额上限）、异常熔断（BR-COST-20；指标达阈值 70% 先预警）、用量报告与用量提示（BR-COST-18、19）、缓存、调用记录、有界循环执行器（工具由调用方注入）、评测运行器 | F-AI、BR-COST | 相同键不重复付费；结果未知不清零；并发预留不重复计费；指标达阈值 70% 先预警、不暂停；熔断触发后相关付费调用被拒并告警，已公开内容与不付费环节不受影响 | 自带任何工具（尤其抓取）；业务模块绕过它读密钥或调用厂商 |
| `feedback` | 读者反馈 | — | 公开提交（10–5000 字、可选联系方式、单张截图 ≤2MB、关联页面，DEC-53）、限流、私有收件箱与处理状态、处理完成 180 天后删除联系方式与截图 | F-FBK | 大小/格式/频率限制；结果未知不显示“已收到” | 接受截图 URL 由服务器抓取 |

AI 能力单元的模块归属以 `02-rules/03-ai-capabilities.md` 第 2 节为准：AI-01～AI-06 属 enrichment，AI-07 属 entities，AI-08、AI-09、AI-16 属 events，AI-13 属 reports，AI-14、AI-15 属 sources，AI-17～AI-23 属 policy；AI-10、AI-11、AI-12 已废弃（分别由 AI-18、AI-19～AI-21、AI-20 承接），不属任何模块。policy 只依赖 sources、content、entities、ai-gateway，不依赖 enrichment、events（第 3 节）。

模块粒度原则：**一个模块 = 一组共同变化的业务规则 + 它们拥有的数据**。金属价格按 DEC-07（Owner 2026-10-01 已定）先只放官方入口（归 `publication`）；开发方调研免费或低价官方数据源并报价后，由 Owner 另行批准开通站内价格表，才单列 `market-data` 模块。

### 2.2 平台包（`packages/platform/<name>`）与共享包

| 包 | 职责 | 规格域 |
|---|---|---|
| `platform/identity` | 具名账号（只用密码，DEC-05）、服务端会话、负责人/管理员两类人类角色 + 能力、服务身份（worker、只读 MCP）、审计写入（接受调用方事务句柄，与业务变更同事务） | F-IAM |
| `platform/ops` | 告警推送（飞书自建应用，照上游，只发飞书；含用量提示、熔断前的用量预警（70%）、异常熔断触发、按服务的调用次数上限触达时的自动暂停、每周用量与每月用量报告的推送）、心跳、按 lane 指标计算、备份状态、运行记录汇总；数据保留由各模块自己的定时任务执行，ops 只调度与汇总，不直接删他模块数据 | F-OPS |
| `platform/queue` | pg-boss 适配、`<lane>.<stage>` 队列与份额调度、outbox 分发器、inbox 去重、长任务执行记录（租约、检查点） | — |
| `platform/storage` | 对象存储端口：S3 兼容（首选腾讯云 COS）与本地目录两实现；暂存前缀；临时签名 URL 只在内存生成、不入库 | — |
| `platform/config` | 按进程角色的配置 schema 与启动校验；密钥文件读取（只读挂载，配置只放路径）；按角色的数据库连接 `dbFor(role)`（`public_read`、`feedback_write`、`private_ops`、`auth`、`worker`、`migrate`；备份作业另有专用只读 `backup` 登录，不经模块注入；web、fetcher 没有数据库登录） | — |
| `platform/telemetry` | 结构化日志、OpenTelemetry API 打点、trace 上下文传递（默认不导出） | — |
| `packages/contracts` | Zod 契约（HTTP、事件、任务）、端口接口（`SuppressionQuery`、`FetchPort`、`HealthSource`、`Clock`）、`ProcessingPermit` 类型、时间值类型与纯函数 | — |
| `packages/api-client` | 由 OpenAPI 生成的公开客户端与私有客户端两个入口 | — |
| `packages/ui` | 设计令牌、基础组件、布局组件（读者站与私有页面共用） | — |
| `packages/testkit` | 许可可用的夹具、假模型服务、契约 mock、临时库工具 | — |
| `tooling/`（独立工作区包，不在 `packages/` 下） | 契约生成步骤：读 `packages/contracts` 的 Zod 输入、写 `packages/api-client` 的 OpenAPI 与客户端输出（`pnpm contracts:gen`）；固定 TypeScript 5.9.x，因 openapi-typescript 与 TypeScript 7 不兼容（`02-tech-stack.md` 2.2）。**不属业务模块**，不在第 3 节的层级里，任何应用与模块都不得依赖它 | — |

功能域归属补充：F-ADM（私有页面）→ `apps/web` 私有路由组 + 各模块 `privateRoutes`；F-MIG（旧数据迁移）【已废弃】（Owner 2026-10-01 全重做，不迁移旧数据，DEC-20），原始信源表由 `sources.import-targets` 一次性导入（队列 `offline.import`，T-147）；F-EXT（扩展候选）不排期（DEC-45）。

### 2.3 A 包 / B 包模块名对照（D12 module_map）

| A 包 | B 包 | 最终 |
|---|---|---|
| sources | domains/source-control | `sources` |
| acquisition | domains/acquisition + apps/fetcher | `acquisition`（fetch 运行时在独立进程 `apps/fetcher` 执行，DEC-30） |
| materials | domains/content | `content` |
| enrichment | （B 无归属） | `enrichment`（仅资讯线） |
| selection | domains/editorial 中的精选部分 | 并入 `enrichment` |
| entities / events / policy | domains/intelligence/{entities,events,policy} | `entities`、`events`、`policy`（各自独立 schema） |
| editorial | domains/editorial 中的审核与抑制部分 | `editorial`（两线共用的人工决定） |
| publication | domains/publication/queries | `publication`（吸收 A 的 site 与 B 的 ProductUpdate） |
| reports | domains/publication/reports | `reports`（独立模块） |
| ai-gateway | platform/model-gateway | `ai-gateway` |
| identity | platform/identity + platform/audit | `platform/identity`（含审计） |
| feedback | domains/feedback | `feedback` |
| site | — | 并入 `publication` |
| ops | platform/telemetry（operations 非模块） | `platform/ops` |
| packages/kernel | platform/{queue,storage,telemetry}、config | `platform/{queue,storage,config,telemetry}`；时间值类型与端口接口进 `contracts` |
| packages/testing | packages/testkit | `packages/testkit` |
| apps/reader-web + apps/admin-web | apps/web | `apps/web`（含私有路由组，不设运营台） |
| apps/api（公开/运营两端口） | apps/api（public/admin 角色） | `apps/api`，同一镜像 `public-api`、`private-api` 两实例 |
| apps/worker | apps/worker + apps/fetcher | `apps/worker` + 独立 `apps/fetcher` |

---

## 3. 依赖方向（机器检查）

“A → B”表示 A 可以 import B 的公开入口。未列出的依赖一律禁止。平台包与 contracts 不依赖任何业务模块。

```text
L0  contracts, platform/*                                   ← 所有模块都可依赖
L1  ai-gateway     → L0
L2  sources        → ai-gateway（信源研究）
L3  content        → sources, ai-gateway（翻译；执行前校验许可）
L4  acquisition    → sources, content
L4  entities       → content, ai-gateway
L5  enrichment     → content, entities, sources, ai-gateway
L5  policy         → content, entities, sources, ai-gateway          （不依赖 enrichment、events）
L6  events         → content, enrichment, entities, policy, ai-gateway（只读 policy 公开查询）
L7  editorial      → content, enrichment, events, policy
L8  publication    → sources, content, enrichment, entities, events, policy, editorial
L9  reports        → publication, events, policy, enrichment, ai-gateway
L9  feedback       → publication（校验被反馈条目）
apps/api           → 各模块 routes（public-api 只注册 publicRoutes，private-api 只注册 privateRoutes）+ platform/*
apps/worker        → 各模块 jobs + platform/*
apps/fetcher       → @amp/acquisition/fetch-runtime, platform/storage（暂存写）, platform/config, platform/telemetry, contracts
apps/web           → api-client, ui, contracts（仅类型）
tooling/           → contracts（读输入）；写出 api-client 的生成物。不属业务模块，不在 L0–L9 内，任何应用、模块与平台包都不得依赖它
```

与 A 包原表的修正（D12-architecture-008）：原表 enrichment(L4) 不能用 entities(L5) 的已核实词表、policy(L7) 依赖 events(L6) 而 events 又要“Policy Thread 接口”、ai-gateway 自带抓取工具会绕过 acquisition 的 robots 与权限门——三处都已改正。

### 3.1 关键的“反向”需求如何满足（不破坏方向）

| 需求 | 做法 |
|---|---|
| 业务模块的私有写操作要写审计 | `platform/identity` 提供审计写入函数，接受调用方事务句柄；审计写入失败即回滚该操作 |
| ai-gateway 必须检查信源权限，但不能依赖 sources | `ProcessingPermit` 类型在 contracts；sources 按当前权限版本签发并签名；ai-gateway 只校验签名与版本 |
| 上游模块需要知道对象是否已下架（跳过处理） | contracts 定义 `SuppressionQuery` 端口，editorial 实现，组合根注入；不 import editorial |
| 人工下架必须立即覆盖所有公开出口 | editorial 在自己的事务里写下架记录并发布 `editorial.withdrawn`（恢复为 `editorial.restored`）；publication 查询时按抑制集合过滤（读取失败即关闭），同时异步重建受影响投影——**即时生效不依赖重建** |
| 人工精选选择 | 属于 enrichment 的精选数据（随精选上线、仅负责人可用）；私有页面经 private-api 调 enrichment 的命令 |
| 人工归组覆盖 | 属于 events 自己的数据；自动重归组必须读取并尊重它 |
| 新闻事件关联政策线 | events 读取 policy 的公开查询（方向 events → policy，不反转）；policy 发布 `policy.changed`，events 订阅后更新关联 |
| 官方来源的资讯材料交法规线识别 | policy 订阅任意 lane 的 `material.body_ready`，只对官方来源跑确定性文书识别；命中才记法规线准入 |
| 信源研究需要抓取工具 | contracts 定义 `FetchPort`，acquisition 实现（经 fetcher 执行），组合根注入 sources 的研究任务；ai-gateway 只提供循环执行器与计费 |
| 抓取运行时不能碰数据库 | acquisition 另设 `./fetch-runtime` 导出入口，只含适配器与守卫；边界脚本禁止它 import `store/` |
| 报告要出现在公开出口 | reports 生成刊期后调用 `publication.upsertReportProjection`（reports → publication），publication 不 import reports |
| 报告只用已公开内容 | reports 通过 publication 的查询接口取材，天然排除已下架和不可公开内容；取材范围是精选候选（同一事实去重、受版面容量限制，DEC-65） |
| ops 要看各模块健康 | 每个模块导出 `stats()`/`health()`；apps/worker 组合根把它们注册进 ops 的 `HealthSource` 端口；ops 不 import 业务模块 |

### 3.2 异步协作：领域事件

模块之间的**流水线推进**一律通过领域事件（写事实与投递事件在同一事务，即 outbox），不通过同步调用链。事件名为 `<聚合>.<过去式动作>`（聚合名取词汇表代码名），信封必带 `lane`。下表按发布方汇总 37 个有效事件类型（v2.0 的 33 个，v2.1 新增 6 个、废弃 2 个）的协作关系；**信封、载荷与触发时机的权威目录是 `03-data/03-internal-contracts.md` §2.2**，两处不一致以该目录为准。

| 事件 | 发布方 | 典型订阅方 |
|---|---|---|
| `source.profile_activated` / `source.profile_paused` / `source.profile_archived` / `source.profile_config_changed`（按采集配置，带 lane） | sources | acquisition（纳入或移出调度、按新配置运行）、ops（记录、暂停超时告警） |
| `source.permission_changed` / `source.identity_revoked` | sources | acquisition、content（按新权限处理；逐源收紧或带期限的证据到期触发正文失效）、enrichment、policy、publication（收窄即时隐藏）、ai-gateway（旧权限版本的许可失效）、ops |
| `source.candidate_proposed` | sources | ops（告警“候选信源待加入”） |
| `acquisition.run_finished` | acquisition | ops（运行记录、失败告警）、sources（更新健康态） |
| `acquisition.catalogue_scan_verified`（法规线） | acquisition | policy（新文书目标入取得队列） |
| `material.stored` / `material.body_ready` / `material.revised` | content | acquisition（stored→取详情正文）、enrichment（资讯线）、policy（法规线材料，及任意 lane 的官方来源材料——只做确定性文书识别，命中才记法规线准入）、editorial（revised→人工稿转 needs_review）、publication |
| `translation.completed` | content | enrichment（更新中文阅读状态）、policy（完整中文就绪，推进全文处理） |
| `material.content_expired` | content | publication（移除依赖内容）、enrichment、policy（失效或重审派生物） |
| `material.enriched` / `material.reading_updated` | enrichment | entities（实体解析）、publication |
| `selection.changed`（精选入选或取消，含人工精选；随精选上线；不含热点榜） | enrichment | publication |
| `entity.resolved` | entities | events、publication（**policy 不订阅**：发文机关经 entities 的同步查询 `findByAlias` 取得） |
| `entity.updated` | entities | events（必要时重召回）、policy（仅对“弱身份”文书复核）、publication |
| `hot.ranking_computed`（热点榜重算完成：48 小时、前 10、规则版本） | events | publication（投影热点榜，机器出口只给名次） |
| `event.changed`（成员、关系、热度、代表条目变化） | events | enrichment（放行已入选资料：归组完成或满 3 分钟）、publication、reports |
| `policy.changed`（文书版本、完整中文、解读、影响、资格或撤回变化） | policy | events（更新新闻事件与政策进展线的关联）、publication、reports |
| `editorial.revised` / `editorial.withdrawn` / `editorial.restored` / `editorial.review_concluded`（统称原 `editorial.changed`） | editorial | publication（立即过滤 + 重建投影）、reports（下架传播）、events、enrichment、policy、ops（`needs_review`/`conflict` 异常告警） |
| `report.issued` / `report.revised` | reports | publication（刊期投影）、ops |
| `publication.version_bumped` | publication | ops（缓存预热、IndexNow 等） |
| `usage.notice_raised`（月内累计每跨过 100 元，只提示）/ `usage.report_issued`（每月 1 日用量报告）/ `breaker.warning_raised`（熔断指标达到其阈值的 70%，只提醒、不暂停，先于熔断）/ `breaker.tripped` / `breaker.recovered`（异常熔断开启与恢复）；取代已废弃的 `budget.threshold_reached` | ai-gateway | ops（告警、预警与报告推送）；platform/queue（`breaker.tripped` 使范围内付费任务进入“等待恢复”，读取熔断状态、不写 LaneControl；`breaker.recovered` 后自动继续；不订阅预警，预警不暂停任何处理） |
| `receipt.unknown_recorded` | ai-gateway | ops（告警：结果未知费用累计） |
| `lane.control_changed`（采集/处理/公开/紧急全停开关） | platform/queue | 所有任务开始前读取最新控制；ops（暂停超时未恢复告警） |
| `job.dead_lettered` | platform/queue | ops（告警；不设人工逐条重试页面） |
| `import.batch_finished`【已废弃】 | —（旧数据导入已废弃，Owner 2026-10-01 全重做，DEC-20） | — |

事件载荷只放 ID、版本与 lane，不放大对象；订阅方用发布方的公开查询函数取最新状态。消费方以 inbox `unique(consumer, event_id)` 去重，所有处理器必须幂等（ADR-0005）。

### 3.3 可执行的边界检查（全部在 `make verify` 中）

1. `package.json` exports 白名单 + pnpm 严格依赖：未声明的依赖无法 import；不允许 `./*` 通配导出。
2. 工作区依赖图脚本：只允许本节 L0–L9 与 apps 的边（`tooling/` 只能依赖 contracts，且不被任何包依赖）；web 不得 import 领域、平台、数据库或模型 SDK；只有 `store/` 可 import 数据库驱动，只有 ai-gateway 的提供商适配器可 import 提供商 SDK；跨包不得指向他包 `internal/`、`store/`；`fetch-runtime` 不得 import `store/`。
3. 契约：生成物漂移检查 + 契约示例回放；破坏性变更按“追加/弃用/破坏”三级协议。
4. 数据库角色权限测试（真实登录）：公开只读登录读不到私有正文与模型账本；fetcher 没有数据库登录。
5. 迁移归属：`database/migrations/<module>/` 只能创建本模块 schema 的对象；跨 schema 视图须声明依赖；已合并迁移不可修改。
6. 运行时按角色校验配置：web 出现数据库或模型凭据、fetcher 出现数据库凭据、生产出现出网代理设置即拒绝启动。
7. 夹具冒烟：不连真实外部源、不调用付费服务；缺配置不能回退生产；真实来源验收独立标记。
8. 每模块有最小契约 mock 与本域测试入口，单域修改无需启动全系统；测试用独立临时库（模板克隆），互不干扰。

---

## 4. 数据所有权（ADR-0003、ADR-0005）

- 每个模块一个 PostgreSQL schema，与模块同名（`ai-gateway` 用 `ai`；entities、events、policy 各自独立）；平台包 identity 用 `identity` 与 `audit`，ops 用 `ops`；队列用 `pgboss`。
- 模块只写自己的 schema。跨模块读取只通过对方的公开查询函数；确需以 SQL 视图共享（例如 publication 读取 editorial 的下架集合）时，由拥有方在自己的 schema 里提供**只读视图**，并登记在拥有方 README 的“公开接口”中，边界检查白名单放行。
- 跨模块引用使用稳定 ID（字符串），不建立跨 schema 外键；引用完整性由事件处理与定期对账任务保证。
- 原件与大对象（获准保存的网页、PDF、附件、截图、报告产物）在对象存储，数据库只存键、sha256、大小、媒体类型、权限版本与到期时间；归 content 管理生命周期。
- 迁移放在 `database/migrations/<module>/`，文件名 `<UTC 时间戳 YYYYMMDDHHMM>_<说明>.sql`，只增不破；执行顺序先按声明的依赖拓扑、再按时间戳。多个泳道同时新增迁移不冲突，不设集中编号。
- 过渡期：AIHOT 原表暂留默认 schema，登记在“待迁出清单”，只减不增（第 9 节）。

唯一性与事务规则：
1. 采集配置编辑使用 `expected_version`；预览任务绑定配置与权限版本，旧预览任务不能自动启用新版本；恢复曾启用的配置不需要重新预览（DEC-57）。
2. 新材料修订、解析结果、阶段成功标记与对象引用在一个事务提交；对象先写暂存区，回收器清理未被引用的暂存对象。
3. 模型费用预留使用行锁或可串行化事务：已占用 = 已结算 + 未结预留（含结果未知），用于用量统计、异常熔断判定（单篇、单份、单日阈值）与 70% 预警判定；不存在月度额度余额；相同业务键不能并发重复预留。
4. 下架以当前抑制层覆盖投影与缓存；无法确认当前抑制状态时停止返回可能被撤回的内容。
5. 人工修订使用 `expected_revision`；版本变动返回 409 并保留草稿；幂等键同载荷返回原结果、异载荷返回 409；数据库故障不当成拒绝。

---

## 5. 模块内部结构（统一）

```text
packages/domains/<name>/
├── README.md          # 模板：06-agents/templates/module-README.md（输入、输出、不变量、反例、运行命令）
├── AGENTS.md          # 可选
├── package.json       # name: @amp/<name>；exports 只暴露 ./src/index.ts（acquisition 另有 ./src/fetch-runtime.ts）
├── src/
│   ├── index.ts       # 唯一公开入口：查询函数、命令函数、类型
│   ├── jobs.ts        # 本模块任务与定时器声明（lane、stage、幂等键等；由 apps/worker 注册）
│   ├── routes.ts      # 本模块 HTTP 路由：publicRoutes / privateRoutes 两组（由 apps/api 按实例角色注册）
│   ├── domain/        # 纯业务逻辑，无 IO，单元测试覆盖
│   ├── store/         # 数据访问，只访问本模块 schema；通过注入的 dbFor(role) 取连接
│   └── internal/      # 其余私有实现
└── tests/
    ├── unit/
    └── integration/   # 临时 PostgreSQL、假模型服务、录制响应
```

组合根（apps/api、apps/worker）只做一件事：按字母序列出各模块的 `routes`/`jobs` 并注册，每模块一行。新增模块只追加一行，避免多个 Agent 同时改同一段逻辑。

契约所有权（D12-architecture-015）：模块契约（`packages/contracts/src/<module>`）由模块泳道提交，追加类变更通过漂移与破坏检查即可自行合并；弃用与破坏类须架构角色批准；公共类型（ID、时间、错误体、分页）、根配置与锁文件由单一集成角色维护。

---

## 6. 进程与模块的关系

| 进程 | 加载的模块代码 | 对外 |
|---|---|---|
| `web` | 不加载任何业务模块或平台包 | 主域名：读者站页面与 `/admin` 私有路由组（六组私有页面；`PRIVATE_HOST` 生产即主域名，ADR-0026） |
| `public-api` | 各模块 `publicRoutes` + 其依赖 | 公开域名下的 `/api/v3`、`/feed`、`/mcp`、`/llms.txt`、`/sitemap`（`/api/` 下不存在的路径，含旧站的 `/api/v1`、`/api/v2`，统一返回错误体 `not_found`，不做兼容）；只读 GET 与反馈提交 |
| `private-api` | 各模块与 `platform/identity`、`platform/ops` 的 `privateRoutes` + 其依赖 | 主域名下的 `/api/admin/*`（ADR-0026）（全部需会话与防伪令牌；`03-data/contracts/interface-behavior.md` §2.1）与私网直连的只读 MCP `/mcp-ops`（服务身份；公开 Web 入口始终拒绝该路径，ADR-0026） |
| `worker` | 各模块 `jobs` + 其依赖 | 无对外端口 |
| `fetcher` | `@amp/acquisition/fetch-runtime` | 只在内部网络监听一个端点，供 worker 调用 |

读者打开页面只触发 `publication` 的查询；任何模块的写操作、采集和模型调用都只在 `worker` 中发生（私有页面的写操作经 `private-api` 执行，耗时部分以任务交给 worker）。

**私有路由的模块归属**（ADR-0018 六组页面；没有一个“后台模块”，不存在 `admin-web` 应用）：

| 私有页面（OP 编号） | `privateRoutes` 所在模块 |
|---|---|
| 账号（OP-01/15/16） | `platform/identity`（登录、会话、账号、改密；审计端口） |
| 信源（OP-03/04/05/07） | `sources`（试抓预览经任务交 worker 调 fetcher） |
| 内容（OP-09）：查找、人工修订、下架/恢复 | `editorial` |
| 用量与模型密钥（OP-12/13） | `ai-gateway` |
| 反馈（OP-14） | `feedback` |
| 网站资料（OP-17） | `publication`（原 A 的 site） |
| 告警渠道（OP-20）、只读运维 MCP | `platform/ops` |

---

## 7. 前端的模块化

| 位置 | 组织方式 | 冲突控制 |
|---|---|---|
| `apps/web` 公开路由组 | `app/routes/(public)/*`（每页一个路由文件）+ `app/features/<feature>/*`（feed、item、event、hot、policy、report、topic、search、favorites、agent、changelog、about、feedback） | 每个 feature 一个子泳道；共享外壳（导航、主题、布局）由读者站泳道主 Agent 维护 |
| `apps/web` 私有路由组 | `app/routes/(private)/*` + `app/private/<area>/*`，只有六个区：accounts、sources、content、usage-models（“用量与模型密钥”组，含告警渠道页 OP-20）、feedback、site（网站资料，ADR-0018） | 私有路由按路由拆包；公开路由组禁止 import `app/private/*` 与私有客户端（边界脚本检查）；新增区须 Owner 点名 |
| `packages/ui` | 设计令牌、基础组件、布局组件 | 追加组件自由；修改已有组件需修复所有使用处 |

前端只从 `@amp/api-client`（由 OpenAPI 生成）取数；页面不直接拼 URL、不复制接口类型。

---

## 8. 与 AIHOT 目录的对应关系

| AIHOT 现有位置 | 新位置 | 处理 |
|---|---|---|
| `packages/backend/src/sources/` | `sources` + `acquisition` | 拆分：配置、权限与按 lane 采集配置归 sources，抓取计划与调度归 acquisition；`sources/icons.ts`（来源图标与头像抓取）**删除**，来源标识只留着色首字母（DR-78） |
| `packages/backend/src/content/` | `content` | 保留判重、正文提取、清洗思路；补时间断言、附件、原件对象与许可执行 |
| `packages/backend/src/editorial/`（analyze、input、translate、vocabulary、writing） | `enrichment`；翻译落 `content` | 改名（避免与人工决定混淆）；每个能力拆成独立单元 |
| `packages/backend/src/editorial/models.ts`、`prompts.ts` | `ai-gateway`（路由）；提示词文件进 `industry/prompts/` | 以本行为准（附录 B 汇总版） |
| `packages/backend/src/events/` | `events` | 保留关系判断与热度；补政策线关联（events → policy）、跨语言、误并控制；去掉对 `localConcurrency: 1` 的依赖 |
| `packages/backend/src/publication/` | `publication` | 保留“一个公开读取层”与发布账本单调序号；补抑制层先行、中文搜索、矿业分面、法规文书版本投影 |
| `packages/backend/src/reports/` | `reports` | 保留刊期机制、选材与出刊时间（从精选候选取材、同一事实去重、受版面容量限制，导语与综述由模型写；日报 08:00 出刊取前一天 08:00 到当天 08:00，周报周一 10:00、月报 1 日 10:30，每小时补出缺的刊期，跨界归下一期，DEC-65）；只改引用约束与刊期成员／修订的存放方式，删 `modelsReleased` 等 AI 指标；加法规周月汇总（北京时间自然周、自然月） |
| `packages/backend/src/providers/llm.ts`、`receipts.ts`、`embeddings.ts` | `ai-gateway` | 保留回执与调用次数熔断；补能力注册、许可检查、用量账本（按业务线、能力、信源）与异常熔断；embedding 默认不启用（DEC-29） |
| `packages/backend/src/providers/jina.ts`、`dajiala.ts`、`socialdata.ts` | `acquisition` 适配器（fetcher 执行） | 付费抓取服务默认关闭；启用须 Owner 批准，计费经 ai-gateway |
| `packages/backend/src/admin/` | 各模块 `privateRoutes`（只保留 ADR-0018 六组操作）+ `platform/identity` | 拆分并收缩；`admin/selectbench.ts` → ai-gateway 评测运行器（沿用 AIHOT 的校准办法 `scripts/eval-selection.ts`）；标注与抽检的 SelectBench 页面思路作为默认关闭的建设期工具，不构成日常页面（ADR-0021）；`admin/runs.ts` 的运行记录查询 → `platform/ops` 与只读 MCP（不作页面）；`admin/monitor.ts` 删除 |
| `packages/backend/src/operations/`（alerts、heartbeat、backup、retention、watch、indexnow） | `platform/ops`（保留清理由各模块任务执行）；`indexnow` → `publication` | 合并 |
| `packages/backend/src/operations/feedback.ts`、`admin/feedback.ts` | `feedback` | 合并到一个模块 |
| `packages/backend/src/operations/reports.ts` | `reports` | 归位 |
| `packages/backend/src/notify/`（feishu、deliver、selected） | `platform/ops`（告警推送）；精选内容推送列为不排期候选（DEC-45） | 告警改造复用；精选内容推送（`selected`）保留、默认关闭（Owner 2026-10-02） |
| `packages/backend/src/site/` | `publication` | 保留 |
| `packages/backend/src/media/` | `content`（`images.ts`、`imgproxy.ts`、`renditions.ts`）；分享图渲染（`apps/api/src/og/`）归 `publication` | `images.ts`、`imgproxy.ts`、`renditions.ts` **关闭**：公开页不用，仅保留给视觉理解输入（须 `external_model` 许可）与 Owner 明确授权的来源（DR-78）；`prepare.ts` 的图片预热**删除**（随图片代理按 `04-aihot-adoption.md` 4.7 处理）；其中推送用的分享图预热 `warmShareImage` 随飞书内容推送保留（Owner 2026-10-02）；分享图为候选、首版不注册路由 |
| `packages/backend/src/jobs/` | `apps/worker` 组合根 + 各模块 `jobs.ts` + `platform/queue` | 拆分；队列改为 `<lane>.<stage>` |
| `packages/backend/src/lib/http-fetch.ts`、`url.ts` | `acquisition` 的 fetch 运行时 | 只搬 SSRF、连接时地址校验、总超时、字节上限、字符集解码；删除出网代理分流（`EGRESS_PROXY_URL`） |
| `packages/backend/src/lib/cursor.ts`、`ids.ts`、`text.ts`、`cache.ts` | 使用方模块或 `contracts`（纯函数） | 按使用方归位，不建通用 utils |
| `packages/backend/src/ingest/` | `acquisition`（外部推送入口，默认关闭） | 若保留，移出公开 API |
| `packages/backend/src/config.ts`、`db.ts` | `platform/config`（按角色配置、`dbFor(role)`） | 改为注入，不再 import 全局 `sql` |
| `packages/backend/src/leaderboard/`、`monitor/` | 删除 | 模型榜与 Codex 重置监控：AI 行业专属，Owner 明确不要（2026-10-01，DEC-64），不移植（连同表与页面） |
| `apps/web/app/routes/admin/**`、`admin-login.tsx` | `apps/web` 私有路由组 | 只保留六组私有页面；其余删除；不拆独立应用 |
| `apps/web/app/routes/leaderboard-*.tsx`、`codex-reset.tsx` | 删除 | 模型榜与 Codex 重置监控页面：AI 行业专属，Owner 明确不要（DEC-64），不移植 |
| `apps/web/app/features/about/SignalRiver.tsx`、`features/item/MediaGallery.tsx` 等 | 删除 | 非需求或与产品决定冲突；逐文件处置与理由见 `appendix/B-aihot-file-inventory.md` §B.4.1–§B.4.2 |
| `apps/web/app/components/ui/Score.tsx`（`ScoreLabel` 分数标签）、`features/feed/FeedItem.tsx` 的分数显示；`routes/hot.tsx`、`routes/story.tsx`、`features/hot/*`（`Faces.tsx` 除外）、`features/story/HeatChart.tsx`（热点榜、事件页、热度走势） | 保留并矿业化（`features/hot/Faces.tsx`〔热点榜参与者头像堆叠〕除外，仍删除） | 有评分的条目显示“AI 评分 · NN”小标签（手机只显示数字，85 分及以上暖红、70 分及以上强调色、其余灰色，分数为两次评分的平均值向下取整）、入选另有“精选”标记、推荐理由照常显示；没有评分的条目什么都不显示（绝不显示 0、占位或“暂无评分”）；热点榜与事件页沿用 AIHOT 的页面结构，热点榜的来源行改为文字来源名加“等 N 家独立来源”，不放头像堆叠与封面图（PG-03、DR-78；ADR-0021 第 4、5、7 条；AI 行业专属的模型榜等仍删除） |
| `packages/contracts` | `packages/contracts` | 扩充为契约中心（Zod → OpenAPI、任务、事件、端口） |
| `industry/` | `industry/` | 保留机制与 workspace 身份，内容全部换成矿业（含 36 个法域对象） |
| `database/migrations/` | `database/migrations/<module>/` | 改为按模块分目录、时间戳命名；存量表按第 9 节逐步迁出 |

逐文件处置见 `appendix/B-aihot-file-inventory.md`（502 个文件全覆盖）；改造方案与风险见 `04-aihot-adoption.md`（A 包原 §3.9“待登记差异”已在该文件删除，其内容由本表取代）。

---

## 9. 从 AIHOT 到目标形态的改造路径：按业务线分治【设计】

AIHOT 的 35 个迁移、60 张表全部在默认 schema、37 处外键；公开读取层直接读 8 个模块的表；admin 目录触达 38 张表。M0 一周内“机械拆 16 包 + 保持行为不变”只会得到形式上分包、实质仍共享表的系统。因此：

| 阶段（里程碑骨架 M0–M5，DEC-44） | 做什么 | 不做什么 |
|---|---|---|
| M0 | 建仓与上游登记（T-0014：首个提交原样导入 AIHOT 固定提交，逐文件处置登记）；去品牌；删除 leaderboard/monitor（模型榜与 Codex 重置监控，明确不要）及其表与页面；AIHOT 的飞书内容推送与飞书登录保留、默认关闭（Owner 2026-10-02）；切换 pnpm；统一验证入口 `make verify` 与回执；落最小边界检查（exports 白名单、前端禁止导入后端、付费调用只经网关、按角色配置校验）；连接按角色拆分（`dbFor(role)`，公开 GET 只用 `public_read`）；建立 `public-api`/`private-api` 两实例与 fetcher 进程骨架（单一内部端点，先返回录制响应）；去品牌后的 AIHOT 在本地预发用种子信源跑通“采集 → 中文标题与导读 → 公开”；完成栈兼容基准与环境与容量基准（T-0001、T-0013） | 16 包机械拆分；拆两个前端应用；建独立运营台；**合成纵向链与双 lane 公平基准（属 M1）**——M0 只搭它们所需的骨架与最小边界 |
| M1 | 冻结契约（含 `lane`、事件信封、`ProcessingPermit`、私有契约）；三泳道试点（T-0621）；**两条合成纵向链**：一条合成新闻（T-0622：来源 → 清洗 → 中文标题导读 → 事件 → 发布 → 页面）与一份含必要附件的合成政策文书（T-0623：取得 → 原件/附件/版本不可变保存 → 中文 → 发布 → 页面），均用假模型与录制响应；**双业务线公平基准与回归**（T-0614；T-137）；业务线隔离（“暂停新闻、法规继续”“法规回填、新闻实时流不受阻”） | 真实来源与真实模型调用（M2）；总览、审稿台、审计页 |
| M1 起：资讯线 | 在 AIHOT 代码上原地演进，**绞杀式**拆分：首次改动哪个模块，就把它搬进 `packages/domains/<module>`、建自己的 schema、迁移数据（只指基线表内的开发与预发数据随表搬迁，不涉及旧站数据，DEC-20）、补契约，并从“待迁出清单”删除；`04-aihot-adoption.md` §2 的“必须继承的设计”清单作为回归清单 | 为拆分而拆分；一次改多个模块的表 |
| M1 起：法规线与新能力 | policy、sources 的权限矩阵与按 lane 采集配置、ai-gateway 的用量账本与异常熔断（按业务线、能力、信源记账）、`platform/storage` 对象存储、`platform/queue` 的 lane×stage 调度，按新模块、新 schema、新契约直接建设 | 从 AIHOT 表结构派生 |
| M1 起：私有页面 | 登录与账号（T-0181、T-0701）、内容下架/恢复（T-0703）、信源页骨架（T-0702）、用量与熔断页骨架与模型密钥录入（T-0704）、告警引擎与渠道页骨架（T-0706；告警随首次生产部署上线）、只读运维 MCP 最小版随 M1 交付（否则真实模型与真实信源无法由 Owner 自主操作）；反馈与网站资料（T-0705）随后；真实使用从 M2 起 | 总览、审稿台、审计页 |
| M2–M3 | M2 稳定供给与首次目标环境部署（告警随首次生产部署上线）；M3 产品功能完整：精选与热点沿用 AIHOT 机制并矿业化（评分管线 M2 起跑、先用 AIHOT 原门槛；M3 完成评分标准与提示词矿业化〔评分标准草案须先交 Owner 审阅确认才生效，未经确认不得用于正式站精选〕、门槛校准的开发集迭代、热点榜、分数展示，留出集检查最迟在 M4 完成并留记录，ADR-0021）、事件折叠、报告（选材取自精选候选，出刊时间沿用 AIHOT）、主题、搜索、收藏、对外出口、通用“页面不存在”页（不存在的地址一律 404，不为旧站地址做兼容）、最小私有页面与告警（原“切换后”的功能并入 M3，Owner 2026-10-01） | 迁移旧站数据；旧链接、旧接口的兼容或重定向 |
| M4 | 影子运行与全量验收：新站用自己采集的数据与旧站并行对比，旧站仍是正式站；不导入旧数据；矿业版评分标准草案可在影子运行期试跑并把结果给 Owner 看，经 Owner 审阅确认后才生效；精选门槛的留出集检查最迟在此期完成并留记录（切换前必须有记录） | 导入、对账、向旧站回写 |
| M5 | 全面切换（DEC-19）：全部排期功能验收通过、影子运行通过、恢复演练一次、告警渠道就绪、Owner 在真实公网与手机上逐项看过（含精选：矿业版评分标准经 Owner 审阅确认、门槛留出集检查已留记录）；新站上线当天旧站停止服务，不保留只读、不切回旧站（2026-10-03） | 分批或“对等即切换”；切换后保留旧站只读或切回旧站；新旧两站之间回写数据 |

M0 退出标准以路线图 `06-agents/02-roadmap-and-wbs.md` 为准：AIHOT 归档校验通过并原样导入、逐文件处置登记；`make verify` 在独立执行器上通过并出具回执，故意违规各被拦一次；除 verify 工作流外没有别的工作流，形状由 `toolchain` 阶段核对，不设必过检查（2026-10-03 改，08-owner-voice DEC-25 ③，TASK-0015）；最小边界检查在 `make verify` 中生效，两个 api 实例与 fetcher 进程骨架可启动；去品牌后的 AIHOT 在本地预发用种子信源跑通“采集 → 中文标题与导读 → 公开”；栈兼容基准与容量基准有结论、目标区域对境外目标的可达性基线完成；法规研究轨已启动；旧站过渡期事项（T-0806）已交 Owner。**两条合成纵向链与双业务线公平基准属 M1 退出标准**（T-0614、T-0622、T-0623；`00-overview.md`），M0 不要求它们。删除 A 包“16 个模块目录就位”的退出标准。

---

## 10. 旧仓库 ADR 处置表

> 旧仓库 `docs/architecture/README.md` 的索引只到 0030，且把已被取代的 0015–0030 仍标 Accepted；0037、0038 只在政策分支。以本表为准。现行性：**仍有效** / **部分有效** / **已被取代** / **仅教训**。旧 ADR 正文保持历史原貌，不改写。

| 旧 ADR | 主题 | 现行性 | 取代者 | 本包承接 |
|---|---|---|---|---|
| 旧ADR-0001 | 系统边界与运行归属 | 部分有效：“公开请求只读预计算内容、永不实时抓取或调模型”有效；云厂商部分被取代 | 旧ADR-0006 | INV-01、ADR-0004、目标架构 §3 |
| 旧ADR-0002 | 公共契约与数据边界 | 仍有效（单一事实来源、私有字段不进公共契约、同主版本只做增量）；v1.0 具体形状已演进 | — | INV-10、`03-data/02-public-api-contract.md`、ADR-0013 |
| 旧ADR-0003 | 不可变内容版本与原子发布 | 部分有效：失败时继续服务合法内容、缓存键含内容版本有效；整站快照实现被否定 | 旧ADR-0017 → 0035 | ADR-0004 |
| 旧ADR-0004 | 隔离分支与工作树 | 已被取代 | 旧ADR-0007 | ADR-0017（PR-only） |
| 旧ADR-0005 | 前端设计选型门禁 | 已被取代 | 旧ADR-0032 | `01-product/03-reader-pages.md` |
| 旧ADR-0006 | 中国大陆部署与腾讯云映射 | 仍有效（合规门禁：ICP 备案与公安联网备案均已办好【Owner 2026-10-01，DEC-39】，页脚同时展示两个备案号（取自受保护的运行时配置，生产环境任一未配置公开站不得开放）、域名/账号/备案主体一致、境外采集不绕过合规网络）；云产品映射被旧ADR-0010 缩减 | — | ADR-0012（区域）、ADR-0019 第 6 条、`07-deployment-and-ops.md`、DEC-39 |
| 旧ADR-0007 | 受治理的交付、稳定 CI、知识收口 | 部分有效：唯一聚合检查、失败即失败有效；“Actions 为唯一执行器”被取代 | 旧ADR-0038 | ADR-0014、ADR-0017 |
| 旧ADR-0008 | PostgreSQL 进入 CI 门禁 | 仍有效（迁移与不变量在真实 PostgreSQL 上测试，缺依赖即失败） | — | ADR-0015 测试行、PIT-050 |
| 旧ADR-0009 | 可重放情报流水线与模型路由 | 部分有效：Tier 0–3、成熟度指标（pairwise precision ≥95%、recall ≥85%、关键跨法域误合并 0、公开事实证据覆盖 100%）有效；日预算被月度 100/80 元取代（该月度条款又被 Owner 2026-10-01 的“预算无上限，但是不要浪费”取代，DEC-08）；55/75 公式已作废（DEC-10，ADR-0021） | 旧ADR-0031–0034 | `02-rules/03-ai-capabilities.md`、INV-23、DEC-10 |
| 旧ADR-0010 | 已购 4C4G 精简拓扑 | 部分有效：扩容触发线有效；“保留现有服务器”不再是硬约束，Owner 2026-10-01 已定：先做容量基准，达标沿用 4C4G（DEC-18） | Owner 重建决定（2026-09-29） | ADR-0012、目标架构 §12、DEC-18 |
| 旧ADR-0011 | 北京时间报告窗口与来源当地时间 | 部分有效：北京时间展示与来源当地时间仍有效；报告的“自然日/周/月窗口与 08:00 刊期”被取代 | DEC-65（Owner 2026-10-01：时间也学 AIHOT） | ADR-0010、`02-rules/04-time-semantics.md`、INV-21 |
| 旧ADR-0012 | 可替换采集与生产 Agent 边界 | 部分有效：适配器顺序、外部抓取默认关闭、项目 MCP 只读有效；Hermes 禁令几经变更，最终生产不依赖 Agent | 旧ADR-0036 → 0037 | BR-ACQ-03、BR-ACQ-24、ADR-0019、DEC-16 |
| 旧ADR-0013 | 公共契约 1.1 时间语义 | 仍有效（当地时间、精度、IANA 时区）；字段形状在新契约重定 | — | ADR-0010、DEC-50 |
| 旧ADR-0014 | 可重放的安全采集核心 | 仍有效（只调度启用来源、SSRF/重定向/DNS 重绑定防护、上限、幂等、租约、死信） | — | ADR-0019、ADR-0005、BR-ACQ |
| 旧ADR-0015 | 首版范围与上线后边界 | 已被取代（metadata-only 首版） | 旧ADR-0027、0031–0033 | 仅作历史 |
| 旧ADR-0016 | 确定性 metadata-first 情报 MVP | 部分有效：硬负例优先、Unicode 词边界防子串误判作为 Tier 0 基线；生产流水线被取代 | 旧ADR-0031 | `05-quality/05-evaluation-sets.md` §6.17、BR-ENR-02 |
| 旧ADR-0017 | PostgreSQL 原子发布与版本匹配搜索 | 部分有效：搜索参数化与长度、条数上限有效；整站 JSONB 快照被证伪 | 旧ADR-0035 | ADR-0004 |
| 旧ADR-0018 | Next.js 匿名只读公共 API | 部分有效：匿名只读、错误只含稳定码与请求 ID 有效；限流数值与游标实现不继承 | — | `03-data/02-public-api-contract.md`、PIT-061、目标架构 §9.2、DEC-21 |
| 旧ADR-0019 | 方向 2 桌面公共 Web | 部分有效：永不投影置信度、收藏只存引用有效；桌面限定与视觉限制被取代 | 旧ADR-0032 | `01-product/03-reader-pages.md` |
| 旧ADR-0020 | 真实信源一次性发布 | 仅教训：联邦公报公开阅览时间不冒充正式公布时间；零可发布事件失败关闭 | 旧ADR-0021 | BR-MAT-17、`02-rules/04-time-semantics.md` |
| 旧ADR-0021 | 云优先生产验收 | 仍有效（验收在真实云与域名发生；受控部署不等于正式上线） | — | `01-product/08-owner-voice.md` §5、`05-quality/04-acceptance-criteria.md` |
| 旧ADR-0022 | 私有 loopback 运营台 | 已被取代 | 旧ADR-0026 → 0031 → 0037 | ADR-0018 |
| 旧ADR-0023 | vNext 增量演进与 Phase 0 治理 | 部分有效：“运营即数据、能力即代码”原则有效（运营范围按 0037 收缩）；“增量演进不重写”被重建决定取代 | Owner 重建决定；旧ADR-0037 | 目标架构 §8、附录 A |
| 旧ADR-0024 | 已审 profile 的官方政策安全通道 | 部分有效：文件身份只由文件编号 + 官方 URL 确定，不靠标题；人工复核通道已取消 | 旧ADR-0037 | BR-MAT-17 |
| 旧ADR-0025 | 已审冷启动生产桥 | 仅教训：零可发布时失败关闭；无上一版本时公开入口保持关闭 | 旧ADR-0027、0037 | PIT-044、INV-09、ADR-0012 第 3 条 |
| 旧ADR-0026 | 多人生产控制面信任边界 | 已被取代 | 旧ADR-0031 → 0037 | ADR-0018 |
| 旧ADR-0027 | 公共 Web 先上线 | 仍有效（合法空站、单源失败只影响该源、24 小时观察从首次公开启用后开始） | — | INV-09、PIT-044、ADR-0004 第 6 条 |
| 旧ADR-0028 | 公共 Web 最小权限 | 仍有效（公开只读库角色；主域名以外的主机名访问私有路径 404 并剥离 `Set-Cookie`，ADR-0026） | — | ADR-0018 第 4 条、目标架构 §9、INV-25 |
| 旧ADR-0029 | 321 条观察的生产化处理台账 | 仍有效（台账状态机；媒体不因类型被拒；社交与未核实转载只作线索）；数字是 2026-08-27 快照 | — | F-SRC-06、BR-SRC-09、BR-SRC-10、目标架构 §4.1 |
| 旧ADR-0030 | P4 获取与内容处理边界 | 仍有效（四层权限独立）；对经审定来源的公开口径已放宽；2026-10-01 起按 Owner 声明许可建档、逐源收紧（DEC-33） | 旧ADR-0031–0033（放宽部分） | ADR-0009 |
| 旧ADR-0031 | 自动情报发布与独立管理 | 部分有效：自动公开、先预留、未知不重发、下架持久有效（月度 100 元硬限/80 元提醒已被 Owner 2026-10-01 的“预算无上限，但是不要浪费”取代，DEC-08）；**password-only 具名账号（负责人/管理员）与首个账号服务端一次性开通沿用**（Owner 2026-09-06，DEC-05、DEC-43）；独立 admin 应用与运营台页面被取消 | 旧ADR-0037 | ADR-0006、ADR-0011、ADR-0018、`06-security-and-access.md` 第 3 节、`02-rules/05-cost-and-budget.md` |
| 旧ADR-0032 | 综合矿业资讯产品改版 | 部分有效：阅读交互、统一内容池、时间区分、匿名收藏、反馈私有、首批 6 个独立发布方验收；阶段顺序与 18 国上限被取代 | 旧ADR-0033、0037 | `01-product/03-reader-pages.md`、`01-product/06-content-standards.md`、DEC-61 |
| 旧ADR-0033 | 读者恢复与第一阶段 | 部分有效：外文新稿公开条件、5 分钟调度、报告发行日与覆盖期区分；精选与聚簇延期、全部动态为默认首页（DEC-13，2026-10-05）被取代 | 旧ADR-0034 | DEC-13、DEC-35、目标架构 §6 |
| 旧ADR-0034 | 新闻生产链路整改 | 部分有效：REM-R01～REM-R15（REM-R01 的 18 国上限被 0037 取代）；交付执行器可替换 | 旧ADR-0037、0038 | 附录（REM 映射）、ADR-0017 |
| 旧ADR-0035 | 按实测调整读取与发布容量 | 仅教训（整站快照冷读超时） | — | ADR-0004、PIT-037、PIT-057 |
| 旧ADR-0036 | Hermes 内容试验与分维度审核 | 部分有效：纯获奖/参会/空预告/泛宣传不因发布方身份准入、系统盘已用 <20GB；“正式精选权重待 Owner 初稿”被 Owner 2026-10-01 答复取代（沿用 AIHOT 机制矿业化，ADR-0021）；Hermes 与人工审稿依赖被取消 | 旧ADR-0037；ADR-0021（精选部分） | DEC-10、DEC-12、DEC-14、ADR-0012 第 5 条 |
| 旧ADR-0037（@policy） | 全目标法域的法规政策动态与自动供给 | 仍有效——Owner 2026-09-26 批准，现行最新口径（其中“不扩大月度 100 元硬限、80 元提醒”条款已被 Owner 2026-10-01 答复取代，DEC-08） | — | ADR-0016、ADR-0018、DEC-01～DEC-04；法规验收 POL-T01～POL-T63 |
| 旧ADR-0038（@policy） | 不依赖 GitHub Actions 的验证与交付 | 仍有效——Owner 2026-09-26 批准 | — | ADR-0017、ADR-0014 |
| `docs/architecture/README.md` 索引 | ADR 索引 | 已过时（只到 0030，状态列误导） | 本表 | 本表 |
| vNext 任务书三件（README、approved-target-brief、phase-0-analysis） | 目标设计输入 | 部分有效：收录四类、影响分级、同事件不确定默认分开、人工审核是例外、30–90 天明细窗口等产品规则仍是设计输入；运营台/管理员章节被 0037 限缩；“增量演进”被重建决定取代 | 旧ADR-0037；Owner 重建决定 | 附录 A、BR-POL-07、BR-ENR-02 |
