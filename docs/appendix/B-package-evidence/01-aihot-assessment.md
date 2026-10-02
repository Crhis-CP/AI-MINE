# AIHOT 固定版本审视与复用地图

> **v2.0 说明（合并时加注，B 原文其余未改）**：本评估已由 `04-architecture/04-aihot-adoption.md` 与 `appendix/B-aihot-file-inventory.md` 取代，仅作证据与对照保留；其遗漏项见 `04-aihot-adoption.md` 1.4、1.5 节。


本次结论：AIHOT 是值得采用的源码起点。它已实现前端、API、后台任务三个进程分离、统一公开读取层、付费回执、公开内容撤回传播，以及比较完整的资讯页面。新 AI矿策应直接保留这些可复用实现和产品交互，同时重新定义矿业领域模型、政策解读、人工审核、成本策略和模块契约。不能把“换行业配置”当作新产品建设完成，也不能把 README 的规模、成本、性能描述当作已验证承诺。

## 1. 基线与本轮证据边界

| 项目 | 核验结果 |
|---|---|
| 上游 | [KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT) |
| 固定 commit | `885b736dc0fd3ef3d4c9c70af2bc3a981a99ff38` |
| 本地源码 | `research/aihot/source/`，只读研究材料，不是新项目目录 |
| 归档 | `research/aihot/AIHOT-885b736dc0fd3ef3d4c9c70af2bc3a981a99ff38.tar.gz` |
| 归档 SHA-256 | `c6872965ae55d8f540c5443ff3cba3e5dc88e1d5182a5f14560ec15314c73057` |
| 下载 | 2026-09-29；8,614,515 bytes；502 个文件 |
| 清单 | [逐文件 SHA-256 清单](../../research/aihot/aihot-source-manifest.json) |
| 行为 | 下载固定 commit 归档；未建立 Git 仓库；未执行上游脚本、安装依赖、构建、启动服务或运行测试 |
| 检查深度 | 全文件清单/目录、依赖、迁移/测试清单扫描；关键前后端、任务、抓取、模型、回执、聚簇、发布、认证路径静态细读；不是每个函数的完整安全证明 |

路径证据均相对于 `research/aihot/source/`。文件名、代码行为和行数只适用于这个固定 commit；后续开发不得无记录地改读上游 `main`。

## 2. 许可与可复制范围

源码 LICENSE（B 包原件，未随包；归档内有同名文件，见 `research/aihot/README.md`）为 MIT；保留版权与许可文本。另有 NOTICE（B 包原件，未随包；同在归档内）：AIHOT 名称和 Logo 不在 MIT 授权范围；新项目用 AI矿策自己的品牌。Noto 字体、模型提供商与榜单来源标识各有独立条款，按原资产目录保留声明；不需要的 AI 品牌图片不导入新项目。MIT 源码授权不等于新闻、原文全文或第三方标识授权。

交接包中的完整快照用于定位复用来源；真正开发仓库只纳入已选择文件及必要许可。导入时建立 `third-party/aihot/NOTICE` 与逐文件来源/改动清单，不依赖页脚文案替代许可文本。没有必要延续 AIHOT 的所有 AI 行业功能。

## 3. 源码证明了什么

- `apps/web/app/lib/api.server.ts:1` 明确通过 HTTP 读取 API；静态扫描 Web 的 `.ts/.tsx` 未见 `@aihot/backend` 导入。React Router 的 SSR 已与数据写入分离，可作为真正前后端分离的起点。
- `apps/api/src/app.ts` 为 Fastify；`apps/api/src/routes/` 区分 site、v1、admin、ingest、media、feeds、MCP 等入口。
- `apps/worker/src/main.ts` 注册内容、信源、事件、通知和发布任务；`apps/worker/src/schedules.ts` 集中管理定时任务、漏跑策略、停用任务反注册。
- `packages/backend/src/publication/` 提供各公开出口共用的数据投影与可见性规则，存在撤回、全文许可变化、事件合并重定向、快照与增量账本实现。
- `packages/backend/src/providers/receipts.ts` 先占用逻辑请求、检查预算、落 attempts，再调用外部服务；响应先存储，再由业务结果消费；付费重试可追溯。
- `packages/backend/src/content/materials.ts` 统一内容身份、版本、来源发现记录及时间规则，避免每个入口各算一套。
- `tests/` 有 35 个后端测试文件，`apps/web/tests/` 有 5 个测试文件；有本地 provider stub、时间/身份/回执/撤回传播/中断恢复相关案例。

源码中存在测试不表示本轮已通过测试；也不证明线上容量、数据质量、可用性或矿业场景准确率。

## 4. 逐能力复用决策

“直接保留”指可作为导入候选并保留原思路/实现，仍须完成新工程的构建、许可和适配验证。“边界改造”指保留实现资产但换依赖方向/契约/配置。“重写”指新业务规则需要独立设计，只提取上游有价值案例。“关闭”指新产品默认不纳入运行与导航。

| 能力 | 决策 | 源码证据 | 新 AI矿策处理 |
|---|---|---|---|
| React Router SSR、HTTP loader、请求取消 | 直接保留 | `apps/web/app/lib/api.server.ts`；`apps/web/server.ts`；`apps/web/tests/request-cancellation.test.ts` | 前端仅依赖 API client；网页进程无数据库、模型和抓取凭据 |
| 桌面侧栏、移动底栏、主题切换、排版 token | 直接保留 | `apps/web/app/components/shell/`；`apps/web/app/app.css`；`apps/web/app/components/ui/` | 用矿业品牌、导航和状态文案；检查键盘、对比度、窄屏和加载状态 |
| 卡片、时间线、过滤、滚动恢复 | 边界改造 | `apps/web/app/features/feed/Timeline.tsx`；`apps/web/app/features/feed/Filters.tsx`；`apps/web/app/routes/home.tsx`；`apps/web/app/routes/all.tsx` | 切换至事件优先卡片和矿业筛选；保留请求取消与滚动/返回行为 |
| 收藏、已读、缓存 | 边界改造 | `apps/web/app/lib/local-state.ts`；`apps/web/tests/local-state.test.ts`；`apps/web/tests/session-cache.test.ts` | 保留匿名本地偏好；绑定内容版本与新品牌 storage namespace，服务端同步如需另立契约 |
| Fastify 与错误/ETag辅助 | 边界改造 | `apps/api/src/app.ts`；`apps/api/src/http/respond.ts` | 每个域单独 plugin；输入与输出均由契约校验；健康探针拆 liveness/readiness |
| 公开 API、RSS、MCP | 边界改造 | `apps/api/src/routes/v1.ts`、`apps/api/src/routes/feeds.ts`、`apps/api/src/routes/mcp.ts`；`packages/backend/src/publication/` | 新契约为准，所有出口只读同一已发布投影；管理能力不得混入公开 MCP |
| 行业配置层 | 边界改造 | `industry/site.ts`、`industry/taxonomy.ts`、`industry/topics.json`、`industry/selection.ts`、`industry/prompts/` | 拆显示配置、领域规则、版本化提示词；分类与国家/矿种/法律生命周期不是文案替换 |
| RSS/网页列表/JSON列表解析 | 边界改造 | `packages/backend/src/sources/rss.ts`、`packages/backend/src/sources/web-list.ts`、`packages/backend/src/sources/json-list.ts`、`packages/backend/src/sources/config-keys.ts` | 解析器与 network port 分开；每源 fixture、策略证据和健康状态；配置不支持必须显式失败 |
| X/公众号与第三方付费采集 | 默认关闭，可适配 | `packages/backend/src/sources/x.ts`、`packages/backend/src/sources/mp.ts`；`packages/backend/src/providers/socialdata.ts`、`packages/backend/src/providers/dajiala.ts` | 仅在产品信源价值、授权与预算明确后启用；不默认导入示范信源 |
| 抓取调度与健康 | 边界改造 | `packages/backend/src/sources/collect.ts`；`packages/backend/src/jobs/sources.ts` | 保留成功后更新 cursor、条件请求、实时优先；失败隔离/限流/回压放源级状态机 |
| SSRF/重定向/超时/体积界限 | 边界改造 | `packages/backend/src/lib/http-fetch.ts`；`packages/backend/src/lib/url.ts`；`tests/url.test.ts` | 保留守卫与恶意样本，放隔离 fetcher；代理出口同样阻断私网；不能把公网地址等同来源许可 |
| HTML 正文提取和清洗 | 边界改造 | `packages/backend/src/content/extract.ts`、`packages/backend/src/content/sanitize.ts` | 复用 Readability/清洗；新增 PDF/附件/扫描件/OCR适配与证据定位；付费fallback策略由内容任务决定 |
| 内容身份、修订与发现入口 | 边界改造 | `packages/backend/src/content/materials.ts`；`tests/materials.test.ts`、`tests/url-identity.test.ts` | 保留一内容多发现；不可把“曾出现过的旧版本”永远忽略：政策撤回/恢复/修订必须识别实际状态变化 |
| 预筛、评分、写作编排 | 重写领域编排，复用调用和测试资产 | `packages/backend/src/editorial/analyze.ts`；`packages/backend/src/editorial/writing.ts`；`industry/prompts/` | 默认规则与缓存优先；矿业价值评分独立于热度；缺正文不生成确定政策结论；双评分不能未经评测全量照搬 |
| 实体与结构化 | 重写领域模型 | `packages/backend/src/editorial/vocabulary.ts`；`packages/backend/src/editorial/analyze.ts` 的 `StructureSchema` | 增加国家/行政区、矿种、矿山项目、公司、机构、法案/法规ID与别名证据，不仅是公司字符串数组 |
| 模型 provider adapter | 边界改造 | `packages/backend/src/providers/llm.ts`；`packages/backend/src/editorial/models.ts`；`packages/backend/src/admin/models.ts` | 能力/输入/输出schema版本与模型分离；不同 provider 的错误/usage/缓存语义由adapter归一；能力升级先评测 |
| 付费回执、attempt与缓存 | 边界改造 | `packages/backend/src/providers/receipts.ts`；`database/migrations/0022_receipt_attempts_budgets.sql` | 保留逻辑请求与attempt分离，增加金额/token预留、全局与任务预算；缺预算拒绝调用；unknown先对账 |
| 事件事实与故事分层 | 边界改造 | `packages/backend/src/events/relate.ts`、`packages/backend/src/events/group.ts`、`packages/backend/src/events/merge.ts`；`database/migrations/0002_events_reports.sql` | 保留同一发生/直接进展/无关/汇总的关系思想；矿业事件加入国家、矿种、项目、文号与时间矛盾约束 |
| embedding召回与聚簇执行 | 重写运行方式、复用关系规则 | `packages/backend/src/events/group.ts:102-238`；`database/migrations/0006_embeddings.sql`；`packages/backend/src/jobs/events.ts` | 避免单进程扫描全窗口；分阶段候选召回/判断/提交，提交有DB级并发不变量；可用pgvector，阈值重标定 |
| 热度/关注度 | 边界改造 | `packages/backend/src/events/hot.ts`、`packages/backend/src/events/hot-read.ts`；`story_signals` | 保留独立参与者和时间衰减思想；“有讨论”与“法律/业务重要”分列；官方单源重大政策不能因热度低被漏掉 |
| 报告、日报周报月报 | 边界改造 | `packages/backend/src/reports/compose.ts`；`packages/backend/src/publication/reports.ts`；`apps/web/app/features/report/ReportPaper.tsx` | 保留刊期边界与引文；新增国家/矿种/政策影响段落，审核状态、迟到材料规则与更正版 |
| 手工覆盖/合并/拆离 | 边界改造 | `packages/backend/src/admin/content.ts`；`packages/backend/src/events/merge.ts`；`grouping_overrides` | 保留版本冲突和人工优先；升级为明确review决策与证据，不把字段override当完整审核流程 |
| 法律法规、效力与影响评估 | 重写/新增 | 上游主要是 `articles/analyses/facts/stories`，未见专用矿业政策有效期和义务模型 | 建独立 policy 域、法源层级、条款证据、发布日期/生效日期/废止/替代关系与影响判断 |
| 审核样本与评测 | 边界改造 | `scripts/eval-selection.ts`、`scripts/eval-relations.ts`；`packages/backend/src/admin/selectbench.ts` | 保留版本化评测；新增真实矿业标注和冻结holdout；示例gold不能当准确率证据 |
| 飞书发送与幂等投递 | 边界改造 | `packages/backend/src/notify/deliver.ts`、`packages/backend/src/notify/feishu.ts`；`packages/backend/src/jobs/notify.ts` | 保留target+dedupe key、unknown不自动重发；改为仅发送通过发布规则的公开版本与明确订阅范围；不要求正常内容逐篇人工批准 |
| 认证、会话与审计 | 重写身份适配，复用部分会话案例 | `packages/backend/src/admin/auth.ts`；`apps/api/src/routes/admin-auth.ts` | 生产仅允许明确immutable身份；不继承email OR union_id准入；审阅人身份与版本写入同一事务审计 |
| 运维、心跳、备份、清理 | 边界改造 | `packages/backend/src/operations/`；`packages/backend/src/admin/runs.ts`；`apps/worker/src/schedules.ts` | 每实例心跳、trace贯穿job/receipt，恢复演练和数据保留；分离管理审计与技术日志 |
| AI模型榜和Codex额度重置监控 | 关闭 | `industry/features.ts`；`packages/backend/src/leaderboard/`；`packages/backend/src/monitor/`；相关页面 | 与矿业核心无关；对应任务、路由、种子、图标、依赖和表全部不纳入新基线 |
| 部署/CI模板 | 重写发布流程、保留可用容器思路 | `Dockerfile`、`docker-compose.yml`、`.github/workflows/check.yml` | 不复制“生产机build+git pull”；独立构建、精确版本、签名/哈希、迁移、回滚；GitHub Actions不是必要条件 |

## 5. 页面资产如何落地

| 页面资产 | 可复用交互 | 新页面必补 |
|---|---|---|
| `apps/web/app/routes/home.tsx` / `apps/web/app/features/feed/` | 精选、主题卡、分类切换、移动布局 | 矿业事件卡；国家/矿种/政策类型；事件新进展；关注理由/来源/证据充分度 |
| `apps/web/app/routes/all.tsx` / `apps/web/app/routes/search-busy.tsx` | 全量池、搜索、请求失败/忙碌状态 | 日期范围、法域、项目/实体、全文可用性；未知时间与检索降级提示 |
| `apps/web/app/routes/hot.tsx` / `apps/web/app/routes/story.tsx` | 热榜、事件时间线、来源报告、关联事件 | 重要度与热度区分；聚簇更正记录；事实冲突；事件对矿业决策的影响 |
| `apps/web/app/routes/item.tsx` / `apps/web/app/routes/item-original.tsx` | 中英文正文、原文跳转、目录、图片 | 页码/段落证据锚点；抓取版本；正文不足；版权模式；法源与解释分离 |
| `apps/web/app/routes/topics.tsx` / `apps/web/app/routes/topic.tsx` | 聚合索引、分页与相关标签 | 国家、矿种、实体、政策主题的稳定ID；空状态不冒充零风险 |
| `apps/web/app/routes/report-latest.tsx` / `apps/web/app/routes/report-detail.tsx` / `apps/web/app/routes/daily-archive.tsx` | 报纸式排版、刊期导航、分享 | 证据覆盖、审核人/时间、更正版、无新增与生成失败区别 |
| `apps/web/app/routes/starred.tsx` / `apps/web/app/lib/local-state.ts` | 无登录收藏与已读 | 新ID/版本兼容策略；撤回项不通过本地缓存再次展示正文 |
| `apps/web/app/routes/admin/content-item.tsx` | 内容全链路、重跑、手工修正 | 审核队列、证据对照、法律/影响草稿批准或退回、版本冲突、真实review记录 |
| `apps/web/app/routes/admin/sources.tsx`、`apps/web/app/routes/admin/source.tsx`、`apps/web/app/routes/admin/source-new.tsx` | 列表、健康、预览、编辑 | 候选/可抓/已接入/持续产出分别计数；许可版本；准入依据；真实连续观测 |
| `apps/web/app/routes/admin/runs.tsx` / `apps/web/app/routes/admin/models.tsx` / `apps/web/app/routes/admin/selectbench.tsx`、`apps/web/app/routes/admin/selectbench-run.tsx` | 任务、模型配置、回执、对比 | 按阶段预算/余额、模型版本与数据集版本、冻结holdout、未知账单对账 |
| `apps/web/app/routes/admin/audit.tsx` / `apps/web/app/routes/admin/settings.tsx` | 变更记录与设置 | 变更范围、精确身份、理由、受影响发布版本；配置schema与回滚 |
| `apps/web/app/routes/about.tsx`、`apps/web/app/routes/feedback.tsx`、条款页 | 产品说明、反馈表单 | 产品事实与实际统计一致；不继承AI行业自述或未经核验的规模承诺 |
| `leaderboard*`、`apps/web/app/routes/codex-reset.tsx` | 不纳入 | 不用无关页面凑功能完整度 |

上述私有页面只是可复用资产候选，不意味着必须重建完整运营台；产品要求正常供稿全自动，必要配置与例外能力可通过受限私有工具或嵌入界面提供。

这些是静态组件与路由审阅结论。尚未运行浏览器确认视觉、键盘可达性、移动实际行为、性能或截图一致性。正式导入应先保留原页面样例，再用新契约mock逐页验收。

## 6. 不能无审查继承的耦合和规模假设

1. **统一backend包的开放内脏**：`packages/backend/package.json` 暴露 `./*`；约70个后端TS文件导入DB标识。前后端进程分离已实现，但领域所有权没有被包导出/数据库角色强制约束。新API不得直接SQL；跨域只走公开port或投影。
2. **行业常量进入契约**：`packages/contracts/package.json` 依赖 `@aihot/industry`。新协议中用稳定ID/schema表达，展示名从配置或taxonomy接口读取；改文案不能改变API含义。
3. **聚簇的全窗口内存和局部串行**：`packages/backend/src/events/group.ts` 保存14天候选与vector cache；`packages/backend/src/jobs/events.ts` 使用 `localConcurrency: 1`，其约束不能直接视为多worker全局串行保证。新设计以DB约束、聚簇提交锁/CAS、幂等账本保 correctness，再做并行。
4. **法规版本不能沿用新闻去抖假设**：`packages/backend/src/content/materials.ts` 对曾出现过的content hash直接视为无变化，并把字符丢失差异当相同。新闻降噪可用，法规恢复旧版本、否定词/数字丢失必须保留修订与待核对状态。
5. **上游精选是文章打分机制**：`packages/backend/src/editorial/analyze.ts` 对每条资料预筛后做两次评分，再写作、结构化；迁移到事件级矿业决策价值时，要避免多篇同事件重复付费。双调用是否提高效果必须实测。
6. **成本不等于次数**：`packages/backend/src/providers/receipts.ts:83-101` 无budget行时放行，窗口预算按attempt数量；`packages/backend/src/admin/runs.ts:116-130` 允许unknown半小时后自动释放一次。新体系必须有金额/token预留与价格版本，unknown先对账、未配置预算不发起付费调用。
7. **身份准入不满足本项目边界**：`packages/backend/src/admin/auth.ts:126-127` 接受union_id或邮箱；另有单密码管理员。新生产权限绑定immutable ID，不能把上游邮箱准入作为默认回退。
8. **API与worker有领域穿透**：`apps/api/src/routes/admin.ts` 直接查询sources、settings等；`packages/backend/src/events/group.ts` 直接调publication；`apps/worker/src/schedules.ts` 引入多个具体业务实现。需拆应用协调器与领域端口。
9. **部署凭据宽于源码调用边界**：`docker-compose.yml` 所有角色继承同一 `.env`、DATABASE_URL和data卷。虽然Web代码不查DB，生产进程仍可能拿到DB/模型密钥。新镜像/环境按角色收窄，Web没有这类凭据。
10. **审计不是自动与业务原子**：例如`packages/backend/src/admin/content.ts`部分命令先更新再调用`audit()`；重建需要业务变化、决策版本和审计在同一事务，投递在事务外但以outbox保证。
11. **代理信任取决于拓扑**：`apps/api/src/app.ts` 配置`trustProxy:true`，上游假设由Web/反代处理可信来源。新系统只信任明确代理网络，不能在API直接公网暴露时照搬。
12. **发布账本有全局锁**：`packages/backend/src/publication/publish.ts:136-141` 用advisory lock保证seq顺序；这有正确性价值，也有吞吐上限。压测再决定批量提交/分区，不应为追求并行先删除锁。

文件长度（快照统计）：`packages/backend/src/events/group.ts` 864行，`packages/backend/src/editorial/analyze.ts`455行，`apps/web/app/routes/admin/content-item.tsx`454行，`apps/web/app/routes/story.tsx`433行，`apps/web/app/features/report/ReportPaper.tsx`421行，`apps/web/app/routes/item.tsx`404行，`packages/contracts/src/site.ts`389行。长度本身不证明低质量；这些文件同时承担召回、判断、SQL、状态提交或大量页面职责，适合作为拆分边界审查点。

## 7. 数据库与运行设计的复用界限

快照含35个SQL迁移文件、60处建表语句，编号存在间隔，最大到0038；不是“38个迁移”。核心实体分为 sources/fetch_runs、articles/revisions/discoveries、analyses/overrides、facts/stories、publications/selected_ledger、reports、receipts/attempts、admin/audit、deliveries。所有业务表集中在同一默认schema，行业专属榜单与监控表混在早期迁移。

新项目重新建初始schema，按领域所有权设计。不导入上游全量历史迁移再逐表删除；保留有价值约束和回归案例，重新实现矿业实体、版本、权限、审核、发布一致性。

Postgres + pg-boss能覆盖初期有界任务。网络抓取、HTML/PDF/OCR解析、AI等待、发布读取的资源和故障性质不同，按进程隔离和连接池预算处理。后台任务之外没有发现必须引入通用Agent Runtime的工程理由。

## 8. 可复用测试和缺口

| 已有测试资产 | 新工程继承的真实不变量 |
|---|---|
| `tests/receipts.test.ts`、`tests/analyze-shutdown.test.ts`、`tests/translate-shutdown.test.ts` | 相同输入重试复用回执；停机等待已发请求落盘；每次付费attempt可计量 |
| `tests/rss-conditional.test.ts`、`tests/web-list-date.test.ts`、`tests/url-identity.test.ts` | 条件请求、真实发布时间、URL身份、不支持配置明确失败 |
| `tests/events.test.ts`、`tests/relation-eval.test.ts`、`tests/relation-eval-runtime.test.ts` | 人工修正优先、关系评测可复现、留出集、模型结果不改变gold |
| `tests/publication.test.ts`、`tests/report-candidates.test.ts` | 撤回传播全部出口、精选门限/报告窗口、快照分页、增量移除 |
| Web `apps/web/tests/cache.test.ts`、`apps/web/tests/request-cancellation.test.ts`、`apps/web/tests/local-state.test.ts` | 页面缓存截止、过期请求取消、匿名偏好状态 |
| `scripts/smoke.ts` | 构建后HTTP与公开页面冒烟的骨架 |

快照没有提供可接受为本项目证据的矿业真实gold、法律条款抽取评测、政策有效期/影响评估正确率、长期抓取产出、百万级查询压测、灾难恢复演练、浏览器端完整关键流程及可访问性验收。本轮未执行上游CI，也未检查其外部线上监控。开发不能写“继承AIHOT成熟性，因此已通过”。

## 9. 后续源码导入步骤

1. 固定以上commit与清单，导入许可和需要的源码；旧AI矿策代码不进入新开发仓库。
2. 原样保存选中的纯UI和HTTP基础资产，另记patch清单；关闭榜单/重置监控/演示源/付费采集默认项。
3. 先建立contracts、生成client、domain exports和依赖边界检测，再移动业务实现；不允许先让所有模块互相导入后补规范。
4. 用新模型建立schema与可重复迁移；所有写入入口经所属域应用层。
5. 从“许可来源→真实正文→证据→事件→自动发布→页面/API”做一条垂直链，并验证可选人工纠错/下架，保留每阶段证据；不是先搬完所有页面再补后台。
6. 通过本包验收后逐能力扩展，记录导入文件、重写文件、关闭文件及对应测试；上游更新按显式diff评估，不能自动pull覆盖业务。

以上是采用建议和开发输入，不是本轮已经执行的新项目实施。
