# AIHOT 底层架构、Git 整合流程与后台整体对齐

日期：2026-10-15。上游固定为 `540c47788eb6475c7ad8819d36733eda81dca20d`，本地只读来源 `.cache/aihot-540c477`。本次读取主工作区已推进至 `a21a4c94572df9aa15d5cfecbeaa1e5da4a42675`，分支 `codex/aihot-selected-translation`；报告描述该阶段读取到的实现，后续合并须核对最终提交。本文只新增研究资料，没有修改产品代码、切换分支、提交、访问生产或执行真实模型。

依据：用户追加的“底层架构、分支与整合流程、整个后台 UI 和交互也以 AIHOT 为基准”。这里的“分支”首先按 **Git 分支治理**理解；`news/policy` 是须保留的业务能力与任务维度，不意味着必须保留现有额外框架层或18个数据库模块名。

## 1. 实际架构及确定的目标

**当前不是纸面上的12领域包架构。** 实际 `packages/domains/` 不存在，全部业务位于 `packages/backend/src/`；`packages/platform/` 只有 `config`。`apps/fetcher/src/server.ts` 明确为本地 `Recording` fixture，默认空记录，只返回 `not_recorded`；当前 `docker-compose.yml` 没有 fetcher 服务。采集与解析实际仍在 worker 调用 backend 的 sources/content/lib 中。不能把删除这个测试壳描述成生产抓取进程迁移。

上游实际采用三进程：`api + worker + web`，一份 backend、一份 contracts，行业知识在 industry，站点配置在 site，站点扩展在 modules。`site/modules/index.ts`、`server.ts`、`web.ts` 在固定版本中都是空列表——这是可插拔框架，不是已经提供了矿业法规实现。依据：[architecture.md](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/docs/architecture.md)、[docker-compose.yml](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/docker-compose.yml)、[ServerModule](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/packages/backend/src/modules.ts)。

目标结构如下，迁移以兼容现有数据库与链接为前提，**不清库、不重导历史内容、不重新运行示范源seed覆盖现役源**：

```text
apps/api                一个 Fastify 进程，公开与后台路由共存；后台逐请求鉴权/CSRF
apps/worker             pg-boss 的引擎任务、模块任务、调度；模型调用只在这里
apps/web                React Router SSR；只通过 HTTP 访问 api，无数据库/模型凭据
packages/backend        采集→材料→筛选/写作→归组→publication 的通用引擎
packages/contracts      HTTP/后台/模块声明共享类型与必要运行时 schema
site                    矿业站名、品牌、站点文案、模型默认、刊期时钟、启用模块清单
industry                矿业分类、实体、信源、提示词、评分规则和词表
modules/policy          法规实体/版本/效力/附件/解读/完整性/公开阅读/报告及其任务
modules/metals          金属价格源、采集、单位/币种、公开阅读及自然取价调度
modules/site-admin      现有账号管理、网站资料、来源目标对账等站点管理页面与专用接口
```

`modules/site-admin` 不接管核心鉴权：现有具名账号、会话撤权、强制改密、owner能力检查仍是引擎 `admin/auth` 的必要兼容能力。该模块只注册专用管理页面/数据，调用引擎提供的鉴权与能力检查。不得通过移到模块就让现有admin获得owner权限。

矿业法规和日价从引擎移出只移动**实现归属**；现有 SQL schema、主键、public ID、migration名称、稿件链接、revision、回执与人工记录先保持不变。`news/policy` 字段可以继续作为账本、许可、暂停、任务的业务范围，无需18个 `dbOf("module")` 代理。

## 2. 架构逐项对照与可收敛层

下表 `B/`=`packages/backend/src/`，`W/`=`apps/web/app/`。上游列均指固定提交同路径；未列代码支持的地方明确为本轮目标，不伪装上游已有能力。

| 领域 | 当前实际实现 | 上游实际实现 | 确定改造与保留边界 |
|---|---|---|---|
| 包与依赖管理 | pnpm workspaces；显式backend exports；api-client、ui、tooling、platform/config；workspace还有不存在domains通配符 | 根package.json用npm workspaces，backend/contracts+apps+industry/site/modules；backend通配出口 | 最终采用npm workspaces形状；迁移锁仅做包管理器转换且逐版本核对，不夹带依赖升级。移除失实domains规则；现有`@amp`品牌命名可保留。依赖入口规则改为实际引擎/模块边界，不保留假领域包图 |
| 进程 | `apps/api/src/runtime.ts::startApi` 分public-api/private-api，端口3001/3002；worker与web | `apps/api/src/main.ts`一次buildApp；worker installModules；web单API_BASE_URL | 最终合成一个api服务，保留后台路由鉴权/CSRF/会话管理与公开匿名。过渡版本可保留原两个服务名但运行同兼容制品；切流后删角色分派和PRIVATE_API_BASE_URL，不能改路由就忘改Caddy/健康探针/回退脚本 |
| fetcher壳 | `apps/fetcher/src/server.ts`仅内存fixture；compose未部署 | 无独立fetcher，sources/http-fetch/content.extract直接在backend | fixture搬到tests/testkit，删除空应用与无消费者环境变量/门禁；不创建新远程抓取服务 |
| 数据库 | `B/module-db.ts`约300行Proxy惰性SQL；`db-bootstrap.ts`18个名字映射process role；`platform/config`可选多角色URL、默认单DATABASE_URL | `B/db.ts`直接postgres sql池，withCustomPlans用于搜索，closeDb生命周期简单 | 收敛为直接sql入口与显式事务；先用兼容`dbOf`适配现有调用，最后逐步删代理和重复生命周期。**当前compose文本单DATABASE_URL不等于生产运行账户已核实**，迁移前只读核对真实role/grant；已有表/权限不因代码简化自动删除 |
| SQL权限与业务许可 | PostgreSQL角色配置与ProcessingPermit混在不同层；来源许可跨模型/存储/公开检查 | 上游site_fulltext/syndicate许可；无本站完整ProcessingPermit模型 | 保留来源的实际授权语义、许可版本与人工操作优先；许可收紧后的在途结果不得写公开。SQL账户边界可合并成api/worker实际需要的权限，但不将所有公开请求赋予任意管理操作；不要把删db代理等同删业务许可 |
| 队列 | `B/jobs/queue.ts`有producer-only、root generation/proxy、表更换/权限不足恢复；`enqueue(name:string,data:object)`较宽；worker手写注册policy/probe等 | [queue.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/packages/backend/src/jobs/queue.ts) 类型化QUEUES/JobData、enqueueOn(ModuleQueue)、workModuleQueues、事务enqueue | 单API无需现有private-only producer生命周期分派；以类型化上游入口收敛。保留事务入队、singleton、在途优雅停止与未知回执恢复；现有队列数据先兼容消费，不能重命名后遗弃旧作业 |
| 调度 | `apps/worker/src/schedules.ts`硬编码新闻、法规、日价、usage、feedback；各类单独导入 | 引擎ENGINE_SCHEDULES+serverModules schedules；移除停用cron队列 | policy/metals schedules注册进各模块；保留独立news/policy暂停的业务效果；不再向全局组合根堆专有任务 |
| 模块声明 | 无site/modules/ServerModule/WebModule机制；专用路由/模型/任务直连app | `contracts/src/modules.ts::ModuleDeclaration`声明pages/adminPages/redirects/apiPaths；server sockets；web sockets | 原样采用三类声明与安装清单。按真实消费者补必要通用插口，不做12模块注册容器，不让engine直接import modules |
| 模块后端 | policy相关直接从jobs/content、publication/timeline、reports/compose re-export，app.ts import registerPolicies等 | `installModules(SERVER_MODULES)`在api/worker启动；http/queues/schedules/models/alerts/retention/on/sitemap/agent | 先把硬编码注册改为模块入口，再移动实现；模块调用引擎公开能力。法规公开投影保持一个受许可/版本检查的读取入口，通过模块http/agent/sitemap输出 |
| 公开读取与关联 | publication是实际共同读取层；detail/sitemap/v3直接import法规，金属放publication/metal-prices | 通用`publication/scope.ts`维护条件；模块能扩展sitemap/topics/agent、事件hook维护派生内容 | 统一精选/席位/事实条件；法规/日价投影移入各模块。新闻详情相关法规需增加实际使用的article-detail part插口（上游没有），web按模块延迟部件呈现，不能把关联功能删掉 |
| 模型/回执 | editorial/models含policy capability；llm/model-fallback/registry/usage-protection等本地扩展；金额逻辑与请求配额并存 | site/models默认+CAPABILITIES+module.models；providers receipts单一付费入口；recover统一恢复 | policy模型步骤由模块声明；引擎保持选模/请求计数/回执复用。注册连接可作为已有配置保留，金额暂停退出准入；重复fallback框架按实际已配置行为收敛，不能删除尚在使用模型路由的回执 |
| 前端数据访问 | 强制api-client；生成public/private TS+OpenAPI；adminGet/action还兼容fetch和openapi-fetch响应 | 同HTTP边界，shared contracts类型+fetch；无独立生成client包与TS5.9 tooling | 最终用上游HTTP helper+共享contracts，减少双响应包装；保留外部OpenAPI与v3接口兼容。先迁移内部调用再删api-client/tooling，不直接删外部契约或所有运行时校验 |
| 配置/站点身份 | `industry/site.ts`混站点与行业；`platform/config`负责进程/DB约束；B/config凭据分域 | `site/site.ts/models.ts/brand/pages/public/changelog`，industry只行业；B/config环境/凭据 | 拆出site保留当前矿业品牌/条款内容/模型选择；把单API后无用角色配置删除；web不导入后端credential逻辑 |
| 鉴权 | `B/admin/auth.ts` + accounts/account-access/account-login；`__Host-amp_admin`、单会话/撤权、owner和models.manage、强制改密；API adminHandler核CSRF | `B/admin/auth.ts`共享密码或飞书允许名单，opaque session，auth_binding使配置变化会话失效；HTTP handler鉴权/CSRF | 使用上游页面登录/返回/后台结构，保留已有具名账号身份和撤权语义；cookie名称及session行保持兼容。单API不取消auth preHandler；显式验证禁用账号/权限变化立即生效 |
| 迁移执行 | `scripts/migrate.ts`模块目录inventory、SHA256校验、每文件事务和advisory lock | [migrate.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/scripts/migrate.ts) engine+module migrations按完整名排序，在线DDL规则/并发索引单独执行，lock/statement超时 | 保留全部历史文件名/hash账本；新增可在线执行规则和concurrent index通路，模块新迁移放自身migrations。不得直接套上游0055编号语义导致本站历史迁移失效；建立显式迁移安全起点 |
| 部署镜像 | Docker构建/生产阶段各pnpm install，当前多个服务共享APP_IMAGE；发布脚本复制程序并绑定旧角色名回退 | 上游npm ci一次→web build→npm prune→复制构建阶段到runtime；api/worker/web统一镜像 | 采用上游镜像构建形状，保留必要pg客户端和现行数据卷；生产release脚本同步新服务拓扑且仍使用同一release.lock/健康/旧制品回退，不把compose up本身当正式发布 |
| 工程校验 | 任务卡allowed_paths/lanes/backend-export snapshot/契约漂移/full verify，部分围绕旧架构 | 上游architecture.test检查真实边界；typecheck、后端隔离库、web build/web tests、smoke、Docker；PR在线迁移检查 | 将真实边界和验收行为保留并映射，移除约束已经删除的假模块/角色层；本轮既定final-SHA full verify仍执行，不以“向上游看齐”为由跳过已经承诺的证据 |

### 可删除/收敛与不能删的清单

**在消费者迁移完成后删除或收敛：** 不存在domains的workspace与文档入口；fixture性质fetcher应用壳；public/private API双路由进程选择和host分流；单API后独有的producer/root代理分支；module-db的18模块名与惰性Proxy；api-client和只为它服务的旧TS tooling；usage-models空Outlet层和逆向redirect；写死在核心组合根的policy/metals/site-admin注册；同一份站点品牌内容在industry与site的重复版本；仅检测这些旧结构的测试。

**迁移中保留到真实替代通过：** 原数据库/卷/角色grant、全部历史迁移与校验记录、原材料与公开ID、人工撤回/修订/暂停/归组、ProcessingPermit的已生效授权、具名账号与权限、回执/费用/尝试历史、反馈处理记录、自然任务记录、旧接口及链接、队列在途任务。旧数据删除不是目录整理的一部分；没有用途的设置可退出读写但保留历史审计，生产清理另按现有授权范围操作。

## 3. 后台完整信息架构与交互

当前 `W/routes/admin/layout.tsx` 使用216px侧栏与手机横向菜单，视觉基础仍来自上游；真正偏离是页面分组/路径/数据展示与新增专用面板。上游是完整的“内容+系统”后台，不是把三个用量页面排成同级就完成对齐。依据：[layout.tsx](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/apps/web/app/routes/admin/layout.tsx)、[ui.tsx](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/apps/web/app/features/admin/ui.tsx)。

目标引擎导航：内容诊断、信源、反馈；运行、模型与评测、SelectBench（矿业界面可显示精选校准）、设置、审计记录。站点专有账号/网站资料/来源对账通过WebModule扩展，法规/日价可添加自己的管理部件。用户权限过滤仍执行。默认 `/admin` 到信源，模块如需landing按上游单入口配置。

| 页面/交互 | 当前偏差与定位 | 对齐目标及兼容行为 | 验收 |
|---|---|---|---|
| 布局与导航数据 | layout先await me再await counts，badge失败/变慢会延迟页面；Counts只feedback/sources | 上游并行请求me/counts，me为硬前置，counts作为Promise用Suspense/Await，每导航新key；保留强制改密、权限菜单过滤、no-store | counts慢/失败不阻断正文；401仍跳登录；模型权限/owner变化立即隐藏入口且API拒绝 |
| 导航位置/状态 | `/admin/usage-models`父层只Outlet，models/settings反向redirect；没有runs/audit route文件 | 恢复 `/admin/models`、`/admin/runs`、`/admin/settings`、`/admin/audit`独立页面；来源/内容/反馈顺序按上游；扩展从module声明注入 | 桌面侧栏/手机菜单一致，sources/new/targets不误高亮父子两处；刷新/后退/书签可用 |
| 运行页 | 当前reconciliation只取runs接口的receipts/deliveries，worker/queue/cron/grouping信息未完整呈现 | 使用上游 `routes/admin/runs.tsx`：worker、积压、失败cron、未知回执、待核投递、等待归组精选、队列/定时任务表、恢复动作；法规/日价通过admin.runs部件 | 源API失败不能显示0健康；恢复前后读回，未知再次失败保留人工状态；长表不撑页 |
| 模型与评测 | 当前models加入连接/fallback/精选规则等，路径usage-models；类型在本地散落 | 上游按capability卡片展示实际模型/来源、时间筛选、成功率/p50/p95/tokens/费用、切换记录、SelectBench入口；保留已有连接管理但作为专用部件 | 保存后下一调用生效、历史不重评；无vision配置不允许视觉步骤；价格未知仍未知 |
| 设置 | 当前settings同时加载settings/runtime/monthly/protection四类，费用暂停与请求次数含义混杂 | 上游主内容为通知目的地、付费服务请求上限、联系二维码；矿业运行范围/费用历史放清晰扩展部件；旧金额规则不再以可恢复准入开关展示 | 分钟/小时/日0停用与使用量正确；保存原因保留；通知不因UI展示自动发送 |
| 审计记录 | 当前后端仍有audit能力但无对应完整route/菜单 | 恢复上游audit页面，按action/subject筛选、时间/操作人/原因/前后值/对象链接、100条分页；沿用既有人工记录 | 筛选分页稳定，撤回/改源/选模/恢复均可追踪；敏感值按已有脱敏要求 |
| 来源列表/详情/新建 | 当前专用preview workflow、target页、归档/许可/日期配置多 | 使用上游sources/source/source-new布局、过滤、编辑/预览/暂停/抓取动作；本站真实必需的许可/预览版本信息做明确定义部件，不删来源校验 | 列表长行/筛选/分页；草稿未生效与现役配置区别清楚；stale preview不能启用；自然采集另验 |
| 内容诊断 | 当前contentChain包含manual修订、group/receipt；上游强调处理状态与公开路径 | 按上游内容诊断页排列材料→判断/写作→归组/新增价值→公开→投递；本地人工版本/许可说明作为扩展部分；操作调用业务函数不直接UPDATE表 | 旧修订/当前修订不混淆；人工撤回跨出口；重组不冒充已成功 |
| 反馈 | 当前独立群outbox/处理状态可靠，输入约束与上游差异见功能矩阵 | 使用上游feedback表格与处理动作，完整正文/图片/联系/相关页面；保留已发送/待核/失败状态与人工记录 | 真实提交和可选发送分别验收；失败不丢反馈、不重复发送未知结果 |
| 表格/卡片 | 当前共享Card/DataTable没有上游scrollable参数完整能力 | 对齐上游Card最高480px、flex min-h-0；DataTable滚动容器可聚焦，sticky表头、横向最小640px；样式保留矿业品牌token | 390px横向表内滚动不撑整页；键盘可达；sticky头不遮行；空态/加载/错误分开 |
| 表单与确认 | 当前ReasonDialog effect依赖onClose，重渲染丢原因；Field label指span；缺焦点约束，上游后两项也有 | reason重置按上游仅open；真实控件label、焦点约束/回焦作为已批准缺陷修复；默认操作原因和CSRF不丢；保持useAdminAction幂等key与成功revalidation | 改模型/字段后原因保留；Tab不进背景；409显示冲突并刷新；错误请求不会假成功 |
| 数据获取/错误 | adminGet有fetch与generated响应兼容层；部分.catch→null会吞认证跳转语义 | 统一上游adminGet/useAdminAction骨架，保留本地onConflict支持；401/403/404/503语义清楚，401 return含pathname+query | 断网、401、403、409、空204、非JSON错误、返回原筛选；后台没有公开缓存 |
| 登录/账号专有页 | 本站具名账号/强制改密/权限真实存在；上游仅共享密码或飞书 | 登录UI按上游简洁结构，但保留具名登录字段和原会话cookie；账号/我的账号作为模块页，不用共享管理员覆盖现有用户身份 | 强制改密不能进入其他页；禁用/撤权同步生效；单API后公开接口仍匿名 |

旧后台地址兼容表：

| 旧地址 | 新规范地址 | 处理 |
|---|---|---|
| `/admin/usage-models` | `/admin/models` | redirect，保留days等查询 |
| `/admin/usage-models/reconciliation` | `/admin/runs` | redirect到回执/投递区域；旧查询映射后保留 |
| `/admin/usage-models/settings` | `/admin/settings` | redirect并保留有效锚点/查询 |
| `/admin/models`、`/admin/settings` | 同路径 | 删除现有反向redirect实现，避免循环 |
| `/admin/accounts`、`/admin/account`、`/admin/site`、`/admin/sources/targets` | 同路径 | 模块注册原路径，旧书签不改 |
| `/api/admin/*`、`/api/auth/*` | 同路径 | API进程合并不改变HTTP地址、CSRF、权限和request body；新接口另按契约发布 |

## 4. Git 分支、整合、测试与发布

上游 [CONTRIBUTING.md](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/CONTRIBUTING.md) 的可核实规则为：从最新main创建短分支；每PR一个清楚问题；开发中草稿；完成后整理为单提交；已推分支更新用force-with-lease；分支包含最新main；check和docker对该提交通过；rebase方式合并保留作者。它没有要求长期agent泳道分支、多级长期集成分支或每个目录独立发布。

当前本地同时有 `agent/architect/TASK-*`、`agent/news/*`、`claude/*`、`codex/*` 多组分支以及10个登记worktree（研究时）；数量不是故障证据，不能直接批量删。已计划PR228–233的现存依赖先按实际提交关系整合，之后每个新问题从最新main拉短`codex/`分支，避免继续叠加新的永久集成链。

具体执行方式：

1. 每批保留一个主交付记录，短PR按能独立验证的迁移切面拆分。任务卡保留必要范围/验收/证据；取消已无实际代码对应的泳道分支命名与框架约束，不能仅删门禁使错误实现通过。
2. PR最终整理成单提交并更新到最新main；仅自己的分支允许force-with-lease。其他工作树在用或有唯一提交的分支不得重置/删除。
3. 使用上游check/docker实际内容：类型检查、隔离库后端测试、web build及web测试、空库smoke/MCP发现、镜像启动、在线迁移安全检查。本站新增法规/账号/权限回归一起跑，不将“上游tests通过”当本站通过。
4. 上游有GitHub Actions的check+docker，不等于本站当前已启用/可用。本站仓库也存在verify.yml，但本轮未查询GitHub运行状态；本轮已批准的**非生产独立执行器、最终SHA full verify**仍是执行要求。不能只复制workflow就宣布CI通过或自行注册runner。
5. rebase合并可能改变SHA；最终发布使用的main提交必须是实际取得验证证据的提交。若合并后树/提交身份改变，按实际需要验证并补绑定，不能把旧分支SHA回执当新main证据。
6. 部署保持正式 `deploy/production-release.sh`，修改其服务清单与回退实现后在隔离Compose练习旧→新→回退。发布锁、现役加两个必要历史版本、必要备份不因采用上游Compose而取消。上游 `setup`默认migrate+seed仅用于空站；现役升级只增量迁移和经过对账的源配置更新。
7. 合并且上线验收后清理已证实无唯一成果的短分支/worktree/tmp目录；保留报告、真实证据与恢复副本。上游贡献规则不能授权丢弃本站未合并稿。

## 5. 逐阶段可实施迁移与完成判据

| 阶段 | 具体操作 | 兼容/验收门槛 |
|---|---|---|
| 0 固定基线 | 核对当前main、未合并PR、worktree、实际容器拓扑/配置变量名称和DB角色，不读取或输出秘密；记录现行路由、迁移ledger名称/hash、队列名和公开ID格式 | 得到变更清单；本报告中的源码事实不能当生产已验证状态 |
| 1 site/modules接缝 | 增加上游ModuleDeclaration/ServerModule/WebModule及3份site清单，先空安装保持行为；搬站点品牌/文案/models/时钟到site，industry只留矿业知识 | 空模块引擎仍可运行；站点meta、旧链接、模型选择、品牌与条款正文不变；包循环检查；此阶段不改进程或数据库布局 |
| 2 抽离扩展 | 先注册policy/metals/site-admin的原HTTP/路由/schedule/model/admin部件，再移动实现，移除核心直接import专有模块；保留原migration文件位置映射和SQL schema | 原路径/API响应等价；法规完整性、人工操作、账号权限、价格空态回归；engine不import模块；模块不可绕publication许可 |
| 3 后台整体替换 | 用上游layout/nav/runs/models/settings/audit/source/content/feedback骨架承载本站能力；恢复规范路径，旧usage路径redirect；共享UI表格/确认/错误处理一次统一 | 所有后台主要动作可走通；counts慢不阻正文；长表/手机/键盘；401/403/409；真实请求状态不显示假成功 |
| 4 数据访问/队列收敛 | 逐模块把dbOf迁到直接sql，删除Proxy之前用跨事务/关闭/重启回归证明替代；加入上游typed enqueue/enqueueOn/workModuleQueues；内部web改HTTP helper+contracts | 数据与权限不变；原队列payload继续消费；成功回执复用、未知一次恢复、并发/优雅停止；无消费者后才删api-client/tooling/platform代理 |
| 5 单API与包构建 | 加入合并API启动方式并保持旧服务过渡兼容，迁移npm workspaces锁和上游Docker分层；部署脚本可启动新api并回退旧public/private-api | 离线/隔离Compose验证旧卷升级，不seed覆盖；web无后端秘密；登录/CSRF/公开匿名/反馈写入/模型仅worker；服务健康必须含实际release |
| 6 正式切流和收尾 | 用已验证制品正式发布三进程拓扑；读取模型/请求计数/归组/报告/自然来源/法规/日价结果；确认旧服务和cron无活跃工作后退休 | 最终main SHA full回执、桌面与手机、跨出口一致性、自然任务证据；回退演练记录；再删除不再使用的代码/测试/配置/文档与已合并临时目录 |

阶段间允许在同一批制品中整合，但不得把结构迁移、数据回填与旧表删除混成不可回退的一步。这里要求的是用上游已有的简洁架构承载既有矿业能力；保留业务能力不等于保留旧额外框架，采用上游架构也不等于丢弃真实记录或权限。
