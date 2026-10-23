# @amp/contracts

TASK-0411历史背景契约沿`site`导出news候选、材料/公开修订及真实日期版本绑定、原文锚点、确认凭据、安全引用Reader及同事务投影口类型；安全引用拒绝quote/receipt/hash。`http/public`声明可选`StoryDetail.background`组件，复用Feed与TimeAssertion，无factId，日期或未知不补造时刻。schema不证明真实原文或对象身份，也不授予许可。当前无消费者、迁移或模型调用，后续TASK-0414/0415接入，详见`docs/03-data/historical-background-contract.md`。

TASK-0422仅追加`HistoricalAnchorExtractor`类型，沿既有site和publication/publish出口转出。后续`extractHistoricalAnchors(text)`与候选Reader复用项目、矿山、文书语境规则，只准备候选输入，不签发许可、不调用模型，也不把提取结果当已确认关系；本片不提供占位实现或修改wire。

`http/public` 是首批公开统计契约，`http/private` 是私有登录方式契约，`http/common` 保存现行错误体。Zod 定义传输形状，类型由其推导；site.ts 保留同名类型入口。其余 DTO 随 TASK-0005 后续响应族迁移。

taxonomy 保存现行分类/栏目 keys 与顺序，mcp 保存5个固定工具名；显示标签从 `@amp/industry/taxonomy` 读取。contracts 不依赖 industry，industry 也不反向导入 contracts；两侧身份一致性由集成测试守护。ADR-0022 的九类已在实际分析、公开投影与客户端联合接入，public OpenAPI 预发布版本为0.2.0。

Fastify 和 scripts/contracts 使用同一 `routes`/`schemas` 导出。修改字段须遵守任务卡契约边界；生成命令见 scripts/contracts/README.md。不要在契约模块注册 globalRegistry 或引用 backend。

`mining-taxonomy` 定义 ADR-0022 的九类键、非空键 schema、nullable 分类 schema 及未知/旧值归 null 的纯助手。CATEGORY_KEYS 使用同一九类键；归一仅用于公开投影，不能据此重写原分析、人工字段或账本。中文定义与报告主题栏在 industry 的同名子路径，二者通过离线测试对齐。

`source-policy` 是 TASK-0021/ADR-0024 的未激活内部契约：九用途权限版本、证据/范围、未受信任的签名封装与独立品牌类型。schema解析不授予许可，不签发/验签，不解释当前范围、版本或时效；HTTP与网关尚未接入。合成共享样例见 tests/permission-fixture.ts，后续真实工厂不能把该样例当授权。

`time-assertion` 是 TASK-0022 未激活的时间契约。`TimeAssertion` 按时间语义 §1.2 / 公开契约 §2.5 保存精度、来源原串、当地日期、可核实 IANA 时区与 UTC、中文标签及北京日期；`SourceDateEvidence` 另保存私有观察/原文定位/日期片段/格式语言/解析结论和 article/source/revision/configHash 绑定，不进入公开 DTO。原串必须经本片严格解析入口建立 `interpretation`，不能把现有 `Date`、字段存在或人工填写 parsed 当作来源日期证明；真实取得与当前观察的持久化仍未接线。

共享纯 `normalizeSourceTime` 与 TimeAssertion 同处 contracts（模块地图§3、采用说明§5.7），parser 不私读 content。日期精度不携带时分或 UTC；分钟/秒精度必须有真实绝对时刻依据，固定偏移不能冒作 IANA 时区。5 分钟边界还比较原 UTC 小数尾数，不因 `Date.parse` 截断微秒而误放行，也不把更细绝对时刻拒作非法。没有注册 HTTP schema、修改现有响应或生成客户端；同一准备交付已定义材料日期更新结果与补取任务，运行消费者尚未接线。

A2 新增未激活 `SourceDateParseInput` / `SourceDateParseResult`，输入实际原串与原文定位，输出已解析证据或明确 unknown 原因，替代由调用方先声称 parsed 的准备接口。`sources/date-extraction.parseSourceDate` 支持日历式 ISO、英文 RFC、显式 epoch 秒/毫秒，以及有格式和语言的七种确定日期布局（可带声明的 HH:mm[:ss]）；不使用 Date.parse 猜未识别原串。ISO/RFC 可按完整语法识别；数字绝不按长度猜 epoch 单位，月日顺序必须声明。

有显式偏移的时刻保留该原始当地值及 UTC，IANA 留 null；时区配置只用于无偏移的当地时间，且必须有依据。IANA 转换会回读校验候选，DST 重复或不存在的时刻都 unknown；没有核实时区则保留日期。相对时间尚无可靠锚点契约，一律 unknown，不借 observedAt。未列语言月份名/布局、闰秒等未支持输入同样保留原串返回 unknown；不宣称通用解析所有 ISO/RFC 变体。条件日期不生成 instant；updated/effective/system 的 meaning/origin 保持，不能替代 published。此片仍无取得调用、数据库、HTTP 或当前公开门接线。

入站 `SourceDateObservationInput` 不含材料ID/修订；content确定真实身份后才组成有绑定的解析输入。`MaterialSourceDateInput`：省略观察是不变更日期，null不清空；给观察就必须带 expectedSourceDateVersion 和 permissionVersion。版本0表示尚无已提交日期观察，初始化也按CAS预期0提交；成功晋升当前证据才在事务内加1，重复相同观察/无变化不刷新版本，stale不得自动改成现读版本重试旧观察。版本参数不是来源处理许可。

`MaterialUpdateResult` 保留原 articleId/created/revised/backfill，所有新建/重复/聚合来源/历史已见/正文修订分支都返回真实 revision/sourceDateVersion，不能拿请求值回填。sourceTimeChanged仅指规范化时间事实或时间公开资格/投影变化；metadataChanged指当前额外元数据或当前日期证据变化，单纯追加抓取观察或刷新observedAt均不算。证据/配置依据变化但时间事实不变时可仅metadataChanged=true；sourceDateOutcome区分unchanged/applied/stale，不把CAS失败伪装成成功。两旗标都不是新付费指令，仍由实际模型输入哈希复用回执，不生成新attemptTag。

`SourceDateTask`固定news并携带材料修订、配置、许可和日期证据的预期版本，可引用已取得的observationId以复用字节；消费者在取回/写入前重新核对当前暂停、用途许可与CAS。任务字段不授权访问、不允许policy混入。这里的类型/样例不证明数据库CAS已经实现；实际返回分支、单调版本、原件保留及失败原子性在后续取得+保存+消费者联合片验收。

TASK0022 取得接线补充（仍未激活公开字段）：`SourceTimeProjection` 单源定义 `sourceTime: TimeAssertion | null`；既有 `publishedAt` 只表示已证明的绝对时刻，date-only 不填午夜、不借 discoveredAt。实际路由、生成客户端、v1/同步出口和页面在运行片联合启用，并更新公开契约版本；本准备差量不修改当前路由或发布半套响应。

`SourceDateObservationInput.alternatives` 可保存同次取得的其他原始日期候选，逐项保留原串、原文位置/片段、含义、格式/语言和时区依据；来源、配置、取得记录与 URL 共用外层身份，候选不能覆盖它们，也不接受 parsed/reliable/冲突结论。缺省表示只有主依据，空数组不合法。content 逐项严格解析、比较同语义的事实，冲突保留全部原件并给 `conflicting_candidates`；未核实时区不能擅自消除差异，元数据更精确不能覆盖指定主依据。updated/effective 等另义候选不代替 published。公开投影只带被采用的 TimeAssertion，不带私有候选集。


TASK-0021私有HTTP 0.3.0（建设期breaking，ADR-0024）：POST sources必需permission_scope与attachments_in_scope，创建动作即负责人加入确认；SourceCreateRequest/Response与SourceDetailResponse由本包唯一定义，既有返回形状保留，详情增加严格permission读回。省略site_fulltext默认true，显式false收紧两个站内全文用途，syndicate默认false。SourceRecord是既有HTTP字段的明确投影，内部日期CAS等新增存储列不自动暴露。公共HTTP及其0.2.0生成物保持原字节。

`source-policy`补充未激活的ProcessingInputManifest与独立CapabilityInputAuthorization：来源分支必须非空、保持材料revision/hash/资源和完整上游artifact四元组；同一材料同一revision不能自称不同来源/hash；历史摘要与当前输入可各自携带该稿不同revision，是否实际可用仍须核验，重复artifact不可伪装另一manifest。非来源分支只声明待核对的登记artifact/hash/caller/lane/model_capability/external_model用途，schema本身不登记、不签发或认可SELF_AUTHORED。请求不能指定签发时刻/有效期；实际工厂核对服务端清单、真实渲染输入与当前根后签发Ed25519封装。权限版本与业务用途记录在每次使用审计，不写入付费缓存身份。此差量不注册HTTP或改变任何生成物，实际消费随后与存储/全部调用方原子接通。


来源时间当前边界（TASK-0360，2026-10-16）：public 0.2.0 的 Feed/Pool/Timeline 别名已兼容增加可选 sourceTime 和 firstPublicAt，并重新生成客户端和 OpenAPI；旧响应仍可省略，既有字段类型、排序和游标不变。TimeAssertion 只表达原文来源时间，firstPublicAt 是本站实际公开时间；旧历史没有证据时保持未知，不为只有日期的原文补造时分。

ADR-0025 / TASK-0022 的 SourceDated* 仍是未注册的历史候选形状。此前“当前别名及生成物字节不变、以后统一切换 public 0.3.0”的准备说明已被本次兼容扩展取代；来源日分组、tl2/it4 游标切换和新增必填字段没有启用，也不作为本轮消费者的前置条件。现行升级按到达、确认与报告窗口安排内容，来源时间的生产与消费在统一版本接通。这里的契约声明不等于生产功能已经启用。

公众号增量只预定义WechatSourceDeclaration/AccountScope/AccountResource/ContentResource，暂未并入SourcePolicy或ProcessingPermit的现行URL分支。加入时明确参考长文章URL，解析唯一规范__biz；ghid可选，不要求填写未知原始ID，不从微信号/昵称或供应商域名推导归属。账号列表无伪造URL，短文链接与附件必须由运行端口核验已取得的账号关系，schema解析不授信。实际启用需SourcePolicy/私有创建读回/生成客户端/两页/采集者联合，私有版本计划升0.4.0（MP建档新增明确身份前提）；原URL wire与公共0.2.0保持，旧配置不自动升级。

TASK-0098 法规公开读取契约位于 `http/policy.ts`，经既有 public registry 生成 OpenAPI 与 api-client；本卡只声明 `/api/site` 和 `/api/v1` 形状，没有注册运行处理器或读取私有法规表，不能据生成物声称法规已公开。站点声明列表、范围、详情、正文、版本记录、周月汇总与政策线；v1 本片声明列表、详情、版本记录，其余机器出口接线仍待后续。错误沿用现有 Problem，不复制一套错误包装。

列表按文书计数；`PolicyListQuery` 是页码，v1 是筛选绑定游标。未知日期使用既有 TimeAssertion 的 unknown/null 成分，不制造 UTC 零点；施行不能由日期推断。详情的状态维度使用 `{value,basis,evidence_ids}`，日期安排独立携带 occurrence/scope/condition；PG-18 的旧 horizon 文字按 §3.7/法规服务 §6 的明确禁止项处理，潜在前提放 condition。语言表达必须引用所属法定版本，选择与阅读修订必须一致；本站版本记录不是法定沿革。

非 complete 不带平台解读；complete 要有非空完整阅读摘要、结构化影响、明确的性质/阶段/公布维度及齐备决定性附件。这里仅校验可见结构，不签发资格：当前原件、用途、真实执行身份、语义核验、Owner 分组质量资格、哈希、有效期和撤回仍由后续领域公开门每次核对。公开对象严格拒绝额外字段，不带 relevance、QualityRelease、模型执行身份、SourceContract、FetchReceipt、CatalogueScan 或 CoverageCell；ai_metadata.provider 只能来自站点服务提供者配置，不能拷贝模型供应商。

阅读摘要不内嵌正文，续读绑定 expression_id/document_revision_id，默认20、最多50节点。复杂合并表格尚需完整原件提取端证明，不由矩阵字段声称保真。私有使用许可与来源契约不公开；attachment_inventory 的 public/restricted/unknown 是读者可见的附件结果，报告 coverage 仅为聚合检查摘要。严格 schema 通过不等于公开资格或覆盖完成。

`tests/fixtures/policy-public/` 全部为显式合成的状态预览，不是尽调资料或真实法规。没有公开投影时必须显示读取失败/未接通，不用合成样本或空模板填生产；基本事实与完整解读、无结果与读取失败、来源尚未接通与没有新规则始终分开。集中全面验证与公开端接线留给后续，不变更模型身份或质量设置。

## 定向金属日价取件

`@amp/contracts/metal-price-relay`定义海外取件服务的独立协议：仅GET固定Cochilco目录或原始日报PDF，Ed25519签名绑定资源、方法与90秒时效。私钥保留在生产worker的专用只读挂载，海外服务只有公钥。响应保留原件字节并附原始地址和SHA-256；目录上限2MiB、PDF上限4MiB，拒绝任意URL、重定向和额外请求字段。该协议不改变站内价格API，不转发数据库、模型或读者凭据。


报告阅读兼容扩展（TASK-0360）：旧站点报告可省略leadItemId及引用的factId/sources/followUp/fillIn/related；缺失不推断为已确认或0个来源。相关报道的available独立核对。v3报告可选reading描述头条与主条目、相关条目的公开引用，头条须在主条目中且主条目不重复；消费者仍须核对实际公开资格和权限，schema不授予内容使用许可。


公开日期兼容补充（TASK-0360，2026-10-16）：当前Feed/Pool/Timeline别名接受可选sourceTime和firstPublicAt；站点详情、报道和报告引用也可携带sourceTime。旧响应不补默认值，unknown不等于日期精度，date不产生utc。这里只提供兼容输入输出，不自动启用旧ADR0025的来源日分组/游标切换；当前升级保留既定到达、确认和报告窗口语义，消费者在统一版本接通。

事件进展的轻量引用同样可选携带sourceTime；timelineAt继续表示既有时间线锚点，不用它推断原文发布时间或精度。旧响应仍可省略该字段，明确null表示未确认。

搜索导航响应只提供主题链接和最多5个当前热点的站内事件链接，不携带正文、密钥或后台诊断。热点未知或没有合格事件时允许空数组；打开搜索不启动采集与模型调用。契约与客户端先行，消费者随统一升级接入。

模块地址声明通过modules入口提供：公开页面、共享布局、后台页面、兼容重定向及API路径匹配。声明只包含受信任仓库配置，不加载业务处理器；后台鉴权、来源权限和公开资格仍由原处理入口执行。现有HTTP接口与链接在本增量中不变。

`jobs`提供引擎队列名与载荷映射JobData/QueueName，以及保留动态队列与载荷关联的JobRequest。此准备片不修改持久队列名、字段、重试或消费者。news/policy来源采集及模型测试分别保留业务线；旧共享sources.fetch由消费者读取真实来源业务线后转交，不凭调用者补造。新发送载荷必须携带lane；只有LegacyJobData消费类型允许历史载荷省略lane，运行端核对材料实际归属和暂停状态，显式错误lane不能被兼容逻辑覆盖。扩展自有作业由扩展的类型化队列定义，不塞入引擎字符串逃生口。

内部生成客户端已退役。历史段落中生成api-client的交付记录保留作当时状态；现行公开和后台页面直接使用共享schemas与HTTP，外部OpenAPI继续生成并校验，使用项目统一编译器。

模块MaterialDiscovered描述已核实目录材料的后续处理交接，字段保持当前业务线、来源、材料和唤醒哈希。它不签发许可或调度任务；事务内发送与模块接收在运行接入中一起完成，公开HTTP不变。

GroupInfo.memberIds可选列出当前公开筛选内的精选成员ID，供聚合组未读判断。它不上传浏览器已读记录，也不放宽公开资格；无字段的旧响应不推断为全组已读。

Agent答案契约在`http/agent`：匿名只读Markdown说明及资讯、检索、热点、事件、日报/周报/月报共11条GET地址，成功类型为text/markdown，错误保留Problem JSON。参数严格、有界、日期真实；这是准备声明，运行处理器随统一版本接入，不改变已有JSON与MCP工具。

关于页SiteStats可选sampleSources/latest分别限180和8，供实际来源流程示意与最近精选；旧响应继续可读，缺字段不推断已采集或公开。

历史报告修订兼容契约（TASK-0378）：ReportDetail可选firstPublishedAt/lastRevisedAt分别表示首次出刊及最近实际修订，原generatedAt、revision、corrections保持。`http/private`声明按真实刊期的reconcileNewsReport：观察到的revision、非空原因、幂等请求键及人工版本/撤回保留状态。`jobs`新增固定news lane的reports.reconcile和按代际确认的ReportPublicationChange；处理器、持久化及页面随后接入，声明不表示已修订。模块职责及消费者验收见[历史报告设计](../../docs/04-architecture/report-revisions.md)。

后台报告列表（TASK-0380）补充同一修订流程的查询：按日报/周报/月报有界分页，返回版本、人工来源、首次出刊/最近修订，以及持久核对状态、实际检查时间、下次尝试和安全说明。排队、运行、等待重试、修订完成、无变化、人工保留与撤回分别表达；查询本身不生成报告或调用模型。

后台列表中的revision=0、origin=null表示已跟踪但尚未出刊；expectedRevision=0只用于此类期次，消费者须有现成跟踪记录或可验证材料，不凭任意日期创造空刊。公开已刊报告的版本语义不变。

## 缓存与绝对时段报价（TASK-0413，消费者尚未接入）

`http/private`的UsagePrice兼容增加可选`cache_hit_input_per_million_micros`与`rate_windows`；旧字段、省略新字段和空时段数组保持旧语义，不自动填默认字段。缓存价null/缺省表示未单列缓存价，不能据此补造供应商缓存折扣。时段含UTC秒精度的starts_at/ends_at及完整输入、缓存命中（可null）、输出单价，最多128段，按起点升序、左闭右开且不重叠；位于observed_on至valid_until的北京时间有效日期范围内，结束日包含全天。无匹配时段使用基础价，不推断循环峰谷或节假日。

新字段仅准备传输形状，不证明供应商支持、历史账单已校正或现有运行结算已经采用。调用前冻结price_id/version、整份价格、报价时间及实际采用时段，缺缓存分解或数量不守恒保持unknown；完整用量按价计算仍为estimated，不伪装账单actual。报价、结算、后台编辑保存和账本依据须在后续消费者交付中一起接通；此准备版本不得在生产登记含新字段的价格。精确兼容与消费者清单见[计价设计](../../docs/04-architecture/usage-price-windows.md)。
投递恢复兼容声明（TASK-0408）：DeliveryIssue可携带retry_reason、retry_at、abandoned_at；旧响应省略表示恢复资格未提供，不能自动重发。明确未发/限流、未知和人工放弃分别处理，处理器及迁移后续接入。见docs/04-architecture/delivery-recovery.md。

TASK-0430：modules入口声明共享的矿业主题/成员、模块标识与导航计数类型，旧ModuleDeclaration/MaterialDiscovered保持。后端及网页扩展可声明固定上游通用插口；运行消费者和HTTP投影不由类型声明自动启用，见docs/03-data/module-extension-contract.md。
