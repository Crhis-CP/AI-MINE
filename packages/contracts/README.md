# @amp/contracts

`http/public` 是首批公开统计契约，`http/private` 是私有登录方式契约，`http/common` 保存现行错误体。Zod 定义传输形状，类型由其推导；site.ts 保留同名类型入口。其余 DTO 随 TASK-0005 后续响应族迁移。

taxonomy 保存现行分类/栏目 keys 与顺序，mcp 保存5个固定工具名；显示标签从 `@amp/industry/taxonomy` 读取。contracts 不依赖 industry，industry 也不反向导入 contracts；两侧身份一致性由集成测试守护。ADR-0022 的九类已在实际分析、公开投影与客户端联合接入，public OpenAPI 预发布版本为0.2.0。

Fastify 和 tooling 使用同一 `routes`/`schemas` 导出。修改字段须遵守任务卡契约边界；生成命令见 tooling/README.md。不要在契约模块注册 globalRegistry 或引用 backend。

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


ADR-0025 / TASK-0022 的 `SourceDated*` 是未注册的下一版公开形状，复用现有 schema 的 `extend`：TimeAssertion 仍是来源事实，`firstPublicAt` 是实际公开资格成立时的本站记录，旧历史未知保留 null；TimelineCard.day 是来源日/组内最新来源日，不能用回退时刻分组。现有 Feed/Pool/Timeline 及私有 runs 别名和 HTTP 注册继续保持原形状，生成 public 0.2.0 / private 0.3.0 字节不变。本片不把 nullable 来源日期或新必填字段提前放到旧处理器上。

消费者联合激活时一次切换相应别名、旧手写 DTO 引用、全部读者/机器出口与生成 public 0.3.0；详情报道的 publishedAt 允许 null，日历日不制造 instant。tl2（日+原锚点）和 by=published 的 it4 文本日期游标拒绝旧版本并沿用 Problem/重载语义，其他游标协议保留。`SourceDatedReceiptReconciliationResponse` 同时预告私有待补列表；未配置告警天数时是 null，不暗设期限。具体兼容边界、实际 first-public 时机与联动顺序见 ADR-0025；本片没有日期公开门、任务、数据库或模型调用。
