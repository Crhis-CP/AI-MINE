# 技术栈决策、替代方案与验证门槛

状态：2026-09-29建议基线。下列推荐结合AIHOT固定源码与当日一手文档核验；不是已经实施的栈，也不宣称没有负载条件的“最佳实践”。主要版本用于明确起点，补丁版本和镜像digest在新工程初始化时重新确认并锁定。

## 1. 推荐组合

| 层 | 首期选择 | 必要性 | 来源和裁定 |
|---|---|---|---|
| 语言与运行时 | TypeScript严格模式、Node.js 24 LTS | 复用AIHOT前后端/worker资产，统一契约与工具链 | 官方当日列Node24为LTS，Node26为Current；生产选择LTS。[Node releases](https://nodejs.org/en/about/previous-releases) |
| 前端 | React + React Router Framework/SSR + Vite；AIHOT现有8.4系列先验证 | 资讯详情、报告、SEO、移动交互和现成组件可复用 | React Router支持SSR、CSR、预渲染；新项目loader只调API。[Rendering strategies](https://reactrouter.com/start/framework/rendering) |
| UI | 复用AIHOT的Tailwind/design tokens/组件，逐页适配 | 避免重造阅读交互；设计系统无业务I/O | 源码`apps/web`提供证据；AIHOT品牌资产按NOTICE替换 |
| API | Fastify 5.x | 明确HTTP层、插件封装、schema输入/输出约束 | Fastify提供encapsulation与schema验证序列化；选它并不自动保证领域边界。[Encapsulation](https://fastify.dev/docs/latest/Reference/Encapsulation/)、[Validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) |
| 主数据库 | PostgreSQL 18，锁定当时最新受支持minor | 修订/证据/审核/费用/发布关系需要事务与约束 | 当日官方18仍受支持；AIHOT用17不是新项目必须保留17的理由。[Versioning policy](https://www.postgresql.org/support/versioning/) |
| SQL与迁移 | SQL-first，保留`postgres`驱动适配候选；每域repository | 关键锁、upsert、账本和投影查询需要清楚SQL语义 | 领域不导出driver；迁移文件与DB实际schema、contracts不是同一份类型文件 |
| 持久任务 | pg-boss 12.x + 自有JobExecution/outbox/inbox | 持久重试、cron、幂等消费、共享Postgres减少初期基础设施 | 官方支持并发claim、重试、dead-letter等；外部副作用仍由应用幂等。[Introduction](https://pgboss.io/introduction)、[Queues](https://pgboss.io/api/queues) |
| 原文/附件 | 对象存储adapter；托管对象存储优先评估 | 网页/PDF/附件/导出不可全塞进热点业务行 | S3式对象key/版本/生命周期可作为接口设计参照；厂商能力需逐项核实，不能把“S3兼容”当完全等价。[S3 overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html) |
| 检索 | PostgreSQL结构索引、FTS、pg_trgm；领域词表 | 先覆盖国家/矿种/实体/日期/文号检索和可解释相关度 | FTS和trigram各有适用范围；中文/多语言质量需真实样本验收。[FTS](https://www.postgresql.org/docs/current/textsearch.html)、[pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html) |
| 向量 | pgvector可选，仅内部有界候选召回 | 若确定性候选不足，避免复制AIHOT全窗口内存扫描 | 可exact/ANN；ANN引入召回权衡。是否建HNSW由benchmark裁定。[pgvector](https://github.com/pgvector/pgvector) |
| 抓取/解析 | 独立fetcher；HTTP优先，Readability/HTML解析；按源启用浏览器与PDF/OCR | 信源失败、恶意页面、慢浏览器与大PDF不拖垮API/模型 | 保留AIHOT守卫；法规附件与扫描件必须有独立完整性评测，不预选“万能爬虫” |
| 模型层 | 自有typed model-gateway + 精确结果缓存/预算账本 | provider可换、可追溯计费、不会因换模型改全域 | 不依赖具体未来型号；高能力模型是adapter实现与评测输入 |
| 可观测性 | 结构化日志 + OpenTelemetry服务端trace/metrics | 必须看见跨队列/模型/发布与双lane饥饿 | 当日JS traces/metrics标Stable，logs标Development；初期日志保留结构化独立通道。[OTel JS](https://opentelemetry.io/docs/languages/js/) |
| 单元/集成测试 | Node test runner；真实临时Postgres；provider stubs | 可复用上游测试思路，不追加第二套相同单测框架 | Node有内置test runner；锁Node24对应API能力，不能直接复制26文档新增API。[Node test](https://nodejs.org/api/test.html) |
| 浏览器验收 | Playwright方案待工程初始化锁版本；契约mock驱动页面 | 覆盖桌面/手机、返回/取消、阅读/下架/异常交互 | 本轮没有浏览器测试执行；AIHOT的5个Web单测不足以替代关键流程验收 |
| 构建与发布 | 锁依赖、隔离构建、OCI镜像、精确manifest与回滚 | 可验证artifact而非生产机现场拼装 | CI平台可替换；默认不要求GitHub Actions；统一脚本可在独立Linux构建环境运行 |

## 2. 决策记录

### ADR-N01：模块化后端优先于按业务拆微服务

选择：首期API/worker组成模块化后端，领域package和schema有唯一owner；fetcher单独隔离。模块之间有typed port、outbox和契约，部署时按资源边界扩缩容。

原因：多Agent需要独立代码所有权、稳定mock、禁止越界和可独立测试，并不天然需要分布式网络。先拆服务会增加消息顺序、跨服务事务、鉴权和故障定位成本，也不能阻止Agent越权改契约。

否决条件：某领域有独立可用性/扩容/发布要求，且进程级隔离仍无法满足；以测量和故障演练证据提取该模块。不是禁止未来微服务。

### ADR-N02：保留React Router SSR，后端彻底API化

选择：AIHOT现有React Router页面/loader模式可复用；loader经生成client调用Fastify。Web和API分别构建/运行，Web无DB/模型凭据。

替代：纯SPA可简化SSR运行，但会新增首屏/SEO/分享元信息处理；Next.js也能实现API边界，但现在替换会消耗已可用页面资产，没有本产品要求证明收益。后续可单独评估，不因框架流行度换栈。

验收：禁用后端实现import；生成契约mock可单独跑Web；API不可用显示明确错误而不是fixture；SSR/客户端导航得到同一publication语义。SSR是渲染职责，不是业务后端。

### ADR-N03：Fastify路由只负责协议

选择：请求和响应schema必须覆盖公开API与私有命令，plugin封装用于身份和域边界；真实规则与SQL在领域应用层/adapter。

OpenAPI 3.1作为HTTP规范源，领域事件/任务使用JSON Schema。Fastify文档示例默认JSON Schema Draft7，而OAS3.1基于更高版本schema语义，工程初始化必须确定兼容子集或显式compiler配置并验证`nullable/union/format/additionalProperties`；不能把两者文件直接互喂就称契约一致。[OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)、[Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)

现有包内schema可作为起草输入，最终类型/validator/client/mock来自同一规范源；禁止维护手写OpenAPI、TS interface和Zod三套不比对定义。严禁接收用户上传schema作为动态可执行编译输入。

### ADR-N04：PostgreSQL是事实源，按领域控制写入

选择：新库用新schema，不拷贝旧表，也不照搬AIHOT35个历史迁移。金额使用NUMERIC，复杂JSON必须有schema版本；源时间精度/法规条件日期独立表达。

原因：材料修订、事件关系、审稿、许可、费用与发布有强关联和事务不变量；关系模型足够清楚。MongoDB/独立向量库不是默认替代，因为当前没有必须牺牲事务和关联查询的证据。

SQL-first并不等于公开全局sql：端口用领域对象，repository映射行类型；DB查询使用参数化和受限角色。若引入query builder，只替换adapter，不从表模型生成公有DTO。

验收：并发预算预留、事件身份、review CAS、发布指针、outbox/inbox、版本约束及恢复演练均由真实Postgres验证。

### ADR-N05：pg-boss负责投递，业务状态自持久化

选择：新闻/政策各lane与各stage分别队列和并发预算，共享pg-boss实例/数据库也不共享一个大任务执行池。源任务、模型等待、CPU解析、发布各有上限；业务成功key和回执不随队列清理而消失。

pg-boss的`send`支持替换DB adapter，使业务事务与入队可统一；官方`short/singleton`等queue policy含义不同，必须测试目标key和多worker下行为。不能把队列的atomic claim解释成“外部模型、网页、飞书恰好执行一次”。[Jobs](https://pgboss.io/api/jobs)、[Queues](https://pgboss.io/api/queues)

替代：BullMQ需要Redis；Temporal擅长持久工作流，但首期的有界步骤和显式状态机不构成必需理由；Kafka提供事件流能力，也不自动解决任务幂等和费用。以后因跨服务长期补偿/规模证明收益，再按端口迁移。

### ADR-N06：缓存与搜索保持可丢弃、可重建

选择：DB索引+进程内有界缓存+HTTP/CDN缓存。缓存key绑定publication和policy epoch；清空缓存不能丢事实或账单。初期不单独引Redis。

对象存储是大材料/附件的事实附件，不是缓存；其备份和访问权限独立管理。进程内缓存不承担跨worker锁、预算扣减、任务身份或人工审稿状态。

PG检索先用词表/别名/结构过滤，避免中文短词全库扫描。内部语义候选必要时用pgvector，先exact建立召回基准，ANN对跨法域/相似法名需分层评测。聚簇模型不能对整个数据库自由扫描。

### ADR-N07：模型调用层不等于生产Agent Runtime

选择：产品模型是有类型、有预算、有最大输入/输出和版本的任务能力。确定性许可、去重、预算、发布和审计由程序完成。法规的正文语义理解由服务端模型处理，不用纯关键词替代；新闻与法规配额分别观测。

复用AIHOT receipt思想，重写金额预留/结算/unknown对账。每个recipe写明何时规则足够、何时缓存命中、何时需要模型；不继承每稿两次评分、全量二审等固定成本。

开发多Agent只参与工程交付，不在新闻与法规日常生产链充当操作员。未来研究型Agent若需要自由计划，应另定义有限工具、权限、最大费用和终止条件，结果仍受同一证据发布规则验证。

### ADR-N08：抓取隔离与解析语言按证据选

选择：TypeScript作为调度与HTML解析主实现；Python只在PDF/OCR/专业抽取库明显需要时引入独立解析adapter，不强迫整套后端改Python。浏览器fallback只对适用source profile启动。

所有获取方式遵守SourcePolicy：HTTP、浏览器、第三方读取、附件、OCR、外发模型分别许可。成功读到文本不自动意味着可公开全文。HTML/PDF结果统一为带locator的ContentBlock；表格、页码、条款号和附件关系不能丢。

新技术验证指标是正文完整、日期正确、资源可控、可续接和成功成本；不以库自称“智能/反反爬”作为选型依据。商业抓取fallback默认关闭，只有明确授权与预算才可用。

### ADR-N09：身份与审计采用本产品的准入边界

选择：immutable owner身份允许列表，明确会话/授权端口；不继承AIHOT email OR union_id、通用密码admin作为生产默认。正常自动生产不依赖登录后台，必要人工修正可由受限私有工具或嵌入界面完成。

不把本包变成新运营台项目；可复用AIHOT后台控件，但只提供产品需要的功能载体。公开API/MCP只读已公开内容，私有生产连接器独立，不暴露SQL/日志/SSH能力。

### ADR-N10：观测证明业务运行，发布证明精确版本

选择：服务端trace/metrics用OTel；结构化日志独立输出。每实例有不同heartbeat key，trace携带lane/stage/item revision/job/receipt/publication。正文、token、个人身份不放高基数metric label或原始日志。

公开SLO与内容生产SLO分别看；HTTP200不能证明33国法规覆盖，也不能证明新闻新鲜。部署验证保留artifact identity、回滚、数据库迁移和真实端点读回；CI绿灯不是部署证明。

### ADR-N11：依赖版本与构建工具服务于可复现

选择：保留一个workspace包管理器和锁文件；首期可沿AIHOT的npm workspaces。确有构建缓存/任务图收益时再引入额外monorepo编排器，不一开始叠npm/pnpm/Bun和多套锁文件。

新工程启动时重新核验Node、React Router、Fastify、pg-boss、Postgres以及解析库兼容性，锁定精确版本与镜像digest；禁止`latest`进入发布配置。升级通过原契约/安全/内容回归，不把上游main变化自动合入。

### ADR-N12：测试成本与风险匹配，产品质量要真实数据

选择：领域纯规则、契约、真实DB事务、provider stub、浏览器关键旅程、内容holdout各司其职。复用AIHOT对撤回传播、回执中断、时间和identity的案例；为法规新增条款/附件/生效日/影响语义与双lane公平场景。

不可用测试数量、覆盖率数字或UI截图替代质量；也不写只重复实现的低价值测试。不同Agent使用独立fixture/schema，相关检查通过且无新疑点即可推进集成，不无限追加主观“完美”轮次。

## 3. 明确不默认引入的基础设施

| 技术 | 初期不引入原因 | 可重新考虑的证据 |
|---|---|---|
| Kubernetes/service mesh | 部署规模与团队边界尚无必要性证据 | 多部署单元有明确调度/隔离/运维要求，收益大于平台成本 |
| Redis | 队列/预算/幂等已在Postgres，缓存可先本地/HTTP | 可测的跨实例热点缓存/限流需求，且失效规则与容量收益明确 |
| Kafka | 新闻/法规处理是有限任务，不是已证明的大规模事件流 | 多独立消费者长期重放/流处理需求与吞吐数据 |
| Temporal | 显式有界状态机可以先由任务+业务账本表达 | 大量长程跨系统补偿/等待/版本升级工作流，使自建维护成本更高 |
| OpenSearch/专用搜索 | 多语言真实检索尚未基准 | PG召回/相关度/延迟无法满足已定查询集合 |
| 独立向量数据库 | 事务数据和候选向量在同一事实域，可先pgvector | 向量容量/性能/独立运维需求超过PG方案，且可重建 |
| Graph database | 事件与政策关系可用关联表和有界遍历 | 多跳图查询成为核心交互且关系库方案测量不合格 |
| 通用Agent Runtime | 日常生产可表达为typed任务，更多自主权不改善事实性 | 已定义动态研究需求、工具边界、预算和可验收产物 |
| 全量浏览器/全量OCR/每稿多模型 | 高成本、额外错误面，无每条必需证据 | 针对source/文档类型的完整率提升与费用证明 |

这些不是永久禁令。新增组件需解释它解决的已观察问题、替代接口、失效与回退、运维负担，不能用“2026应该有”作为理由。

## 4. 骨架冻结前必须完成的基准

这些是后续实施任务，不是本轮已跑出的指标。生产预算/性能目标以产品文档和验收文档为准；不能通过调小输入分母获得通过。

| 基准 | 输入与方法 | 决策产物 |
|---|---|---|
| 栈兼容 | 精确Node24、Fastify、RR、pg-boss、Postgres18组合；干净安装/构建/迁移/fixture smoke | 锁文件、镜像digest、生成client、失败兼容项和处置 |
| 数据增长 | 建议小档10万文稿/中档100万文稿、版本与附件真实分布；不同对象保留策略 | 存储增长、索引写放大、备份恢复时间、projection结构共享效果 |
| 查询 | 真实中文/英文/西语/法语及范围内语言，国家/矿种/文号/实体/短词；冷/热分开 | p50/p95/p99、召回/排序错误集、SQL计划；是否需要专用搜索 |
| 聚簇 | 新闻与法规分层gold，同文号跨法域、草案/通过/实施、相似企业与转载 | exact vs ANN候选召回、pairwise错误、端到端误合并、成本与延迟 |
| 双lane公平 | 新闻突发、法规回填、慢90秒抓取、大PDF、provider429同时存在 | 每lane各stage最大等待、保留并发是否有效、API与模型不饥饿 |
| 付费恢复 | 同key并发、响应已到未提交、超时unknown、跨月账单、余额不足 | 未透支/未重复发起、attempt与金额可对账、无预算fail-closed |
| 发布/撤回 | 连续发布、读跨页、旧缓存、权限收紧、撤下report引用 | 一致版本、全出口抑制、没有旧缓存旁路，故障可回退 |
| Agent独立开发 | 3个Agent分别只读本域README+contracts完成独立mock任务 | 未改他域内部、集成无需重新设计接口、测试资源不冲突 |

只在基准证明有必要时调选型；不因为一次库调用失败就推倒整套架构，也不为了兑现“完美架构”反复换栈。

## 5. 一手来源记录与证据限制

本次访问日期均为2026-09-29；以上链接属于项目官方文档、官方规范或维护者仓库。它们证明工具能力/版本政策，不能替代新AI矿策负载与产品验收。AIHOT实际依赖版本以固定快照的package.json/lockfile为准，外部文档显示的新版本不得默默改写快照。

上游文档中示例调用次数、服务器配置和性能描述只作为风险分析输入，未用于估算本项目成本或作性能承诺。本轮不访问供应商私有账单、不运行付费调用、不承诺未来模型可用性。
