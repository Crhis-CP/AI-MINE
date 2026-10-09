# backend 过渡期数据库接口

本包仍承载待迁往领域模块的现有实现，迁出顺序以 TASK-0004 和模块地图为准。本页说明数据库注入接口，不将过渡期后端视作新架构的长期边界。

## 公开入口

通过 `@amp/backend/db` 使用 `dbOf(module)` 与 `injectDb(bindings)`。包的显式导出清单不变；不要直接导入 module-db.ts。

组合根也可以显式 `await initializeDb(processRole)`，按任务卡 D2 将 `DB_MODULES` 分配到正确角色：public-api 的反馈单独写入，private-api 的身份模块单独使用 auth；worker、migrate 和 test 各用自己的连接。它不会在 import 时运行，web/fetcher 不能调用；相同role及同一env引用的重入返回现有根，不同声明仍须先关闭。closeDb 同时撤销这些注册并关闭连接池。该辅助入口属于过渡后端，随模块迁出由相应组合根接收。

- `dbOf(module)` 返回稳定句柄；加载模块时可以声明 SQL 片段、标识符或 JSON 辅助对象。
- 只有组合根调用 `injectDb`，给每个模块分配 `@amp/config` 的 dbFor(role) 连接。未注入时执行查询或事务会失败，没有默认连接回退。
- 注册是原子的；重复模块名即拒绝，不允许静默替换。返回的注销函数仅解除本次注册，不关闭连接；组合根退出时再关闭其拥有的连接池。
- 注销后，预先创建但未执行的查询及保存的方法也被拒；换入另一个连接后须重新创建查询，不能把旧查询静默转交另一个身份执行。
- 只用作插值的 SQL 片段、标识符、JSON/array/unsafe 辅助对象在每个新查询中按当前注册重建，因此 closeDb 后重新 initializeDb 可继续使用模块常量；片段本身不执行查询。访问查询方法或直接执行会固定原生命周期，旧查询不能跨代复用。保存的工厂方法在调用时核对原注册。
- file 查询、reserve 返回的连接与 cursor 返回的迭代器同样受原注册约束，保存的方法也不能绕过；release 会使保留连接失效。已构造查询的 cancel、迭代器 return、保留连接 release 在注销后仍可清理资源，重复 release 安全；尚未完成的 reserve 在注销后返回时会自行释放。
- largeObject 保留原有查询与流功能：返回的方法、待执行查询及读写流的后续数据库操作绑定原注册，close 仍可在注销后结束其原生事务且可重复调用。迟到的创建结果先关闭再拒绝，不泄漏事务；已启动 I/O 可结束，新的流块被拒绝并按流的错误通道报告。
- 事务和 savepoint 的回调也收到包装句柄，能够复用模块加载时声明的片段。事务提交与回滚仍由 postgres 驱动执行。

内容处理通过现有 `@amp/backend/content/materials` 入口的 `commitProcessingResult` 提交结果：content 开启事务并锁定材料修订，调用方在传入的同一个 tx 中写本模块结果和完成回执，content 最后更新当前修订的处理状态。过期修订仍保留结果与回执，但不覆盖新材料状态；回调或状态更新失败会一起回滚。

```ts
const publicationDb = dbOf("publication"); // 模块初始化，可先于组合根注入
const columns = publicationDb`42 AS answer`;
const dispose = injectDb({ publication: access.dbFor("public_read") });
const rows = await publicationDb`SELECT ${columns}`;
dispose();
await access.close();
```

全局 sql 已删除；API/worker、CLI 与测试公共夹具显式初始化。withCustomPlans 使用 publication 的注入连接，closeDb 关闭本组合根拥有的池。85 处归属及机械改写见 scripts/db-injection/mapping.json 与 rewrite.py，可在记录的基点重放。本阶段不建立 PostgreSQL 登录或授予权限；真实登录矩阵仍归 PR8/PR9。

队列接口仍经 `@amp/backend/jobs/queue` 使用。getBoss 返回绑定当前根的句柄，保存的方法和 getDb 的公开数据库操作同样受约束，不暴露原生接收者或连接池。队列存在缓存归属实例，旧异步结果不能写入新实例。停机先 stopBoss、后 closeDb；同根 graceful drain 允许在途 handler 结算和后续投递，内部原始资源负责最终关闭。事务 rollback 和监听 close 保留失效后的清理能力。


翻译的逐段存储准备由enrichment独占：`translation_segments` 区分材料修订、配方、原文hash和段序号，原始模型text与恢复后HTML分别留hash；公开读取不读该明细表。`translations` 新增的recipe/source_hash/manifest保持旧记录为null，不补造完整度或回执依据。严格逐段调用、事务写回与首次公开门已接入实际worker，实际模型语义质量仍需真实样本验收。

TASK-0021生命周期前置：initializeDb返回本根AbortSignal；同role与同env引用重入复用，不同声明仍须先关闭。closeProcessDb先登记共享关闭Promise，再撤销注册和signal，监听器同步重入不能打开新根或使用旧能力；新根独立，未改队列正常drain的时点。signal不包含控制器、连接或URL；生命周期本身不代表许可存储或网关强制已激活。

未激活的sources/permissions与providers/permissions提供显式Ed25519签发/校验工厂：私钥只在sources闭包，验证端固定公钥/issuer/root。当前许可查询、可信完整输入重建、根signal与时钟必须由组合根提供，无默认allow。现有应用尚未调用工厂；合成端口测试不是数据库权限接线，模型/cache/写回仍待原子接通。

### content/source-time（TASK-0022）

共享纯规范化函数 `normalizeSourceTime` 位于 `@amp/contracts/time-assertion`，不猜格式、时区或来源事实；content 的 `sourceDateVerdict(lane, evidence, currentBinding, now)` 显式接收时钟与当前身份，返回日期的 reliable/pending，policy 则仅返回 not_applicable 并交 BR-POL-11。复用 `@amp/contracts/time` 的日历与北京日函数；只有新闻发布依据能通过，官方登记/正式刊发须使用相应证据口径，系统/更新/生效日期不能顶替。这是日期判定，不是总体公开资格；纯函数不访问数据库、网络或模型，当前已供材料日期写回使用，publication 和 HTTP 尚未接入日期门。

来源日期取得/保存通过既有 `@amp/backend/admin/sources` 的当前来源快照、配置锁、用途判定和纯日期 parser 端口衔接；不增加 backend 子路径白名单。`content/materials` 的实际写回先锁当前许可版本，再锁相关来源配置和材料，保存不可变原始观察及多候选依据；迟到观察不提升当前版本，不把它重绑到不存在的新修订。相同事实的重复采集不刷新当前证据版本，也不重新排分析；需要更新投影的元数据变化单独走重新发布队列。公众号观察引用实际取得回执，关闭的外部上报入口不能凭传入 Date 建立来源日期证据。

这一步仅接通取得和材料保存；公共 TimeAssertion、统一新闻日期门与自动补取在后续能力联合启用。现有 fetch/store_metadata/process_locally 判定是该次日期取得/写回的边界，不代表全链 ProcessingPermit/所有付费 provider 强制已经完成。




lockCurrentSourcePolicies在调用方的事务中按source_id顺序取得共享咨询锁并核对版本，编辑使用同key独占锁；锁持有至事务结束。围栏仅接受READ COMMITTED，明确拒绝可能在等待后继续看旧快照的其他隔离级别。正式消费者必须先锁全部许可、再锁材料，并在锁内校验实际用途/资源后写回；该端口只保证版本围栏，不能代替ProcessingPermit或范围判定。当前函数尚未接入模型/内容消费者，不声称已实现完整网关强制。


`readCurrentBody` / `commitBodyResult`是content的正文派生窄端口：读取正文身份，写回时锁定相同revision与HTML；不改变分析状态、错误、次数或重试时间。显式`runBodyTranslation`由已核验准入、来源许可和外文条件的worker调用，网络在事务外，检查点与实际attempt的完成/标坏同事务提交，完整manifest另行晋升。旧revision/recipe迟到停止后续片段；旧attempt不能覆盖新attempt或被当作正常结果交给旧调用者。

Gateway保存每个实际attempt的原响应/用量/成本，receipts只在CAS当前尝试时更新response_attempt_id；缓存沿该指针核验所属回执、尝试与原响应，不猜MAX或给历史记录补造身份。新翻译显式启用同一调用键最多3次坏输出限制，claim前检查，重复结算不重复计数；旧能力默认不启用这个限制。缺usage的坏响应仍received，unknown不重发，明确截断不晋升；stop或空finishReason也须严格text与结构检查。不能证明历史缓存的attempt时保持私有待处理，不重新购买。当前严格text消费者复用这些身份；网关强制ProcessingPermit仍由Task21完成。
TASK-0021存储能力：既有admin/sources入口新增saveSourcePolicy以及当前私有/公开读取、版本锁端口；来源创建/读回已接入私有HTTP；模型调用仍未强制许可。来源编辑在同一事务追加不可变版本、CAS推进当前指针及最小公开投影、记录审计。缺记录返回null；不会在读取或迁移时补造Owner许可。数据库限制应用角色改删历史，管理员仍有管理能力。


TASK-0021来源加入与真实evaluate：来源创建严格要求明确permission_scope/attachments_in_scope，默认九用途Owner声明许可，无自动到期，初始暂停；显式关闭site_fulltext仅收紧原文/译文公开，syndicate默认关闭。来源、初始权限和审计同事务，按采集地址并发判重；旧来源缺记录不补造。既有全文开关关闭会在同事务生成收紧版本；已有deny/unknown或缺记录不能被重新勾选旧开关恢复。

既有admin/sources公开入口的evaluateSourcePolicy(value, now?, db?)按当前版本、用途、资源/证据范围、附件与有效期限读取真实存储，未证明的条件/排除项失败关闭，查询失败不回退allow。默认时钟在查询后读取；日期等调用者在已有事务中传第三参tx，不额外占连接。公开四用途只读受限投影；共享许可锁→sources行锁/材料锁的顺序一致。UI和生成private client使用同一Zod契约；采集/模型/公开消费者的ProcessingPermit强制及正式权限放宽编辑仍待后续原子接通。

网页列表（web_list）的 `htmlJsonPath`（TASK-0030）：栏目页的列表由页面脚本从 JSON 接口填充时（如商务部驻外经商处栏目页里 `unitbuild.js` 声明的 `/api-gateway/jpaas-publish-server/front/page/build/unit`，返回 `{"data":{"html":"…"}}`），`url` 写页面声明的接口地址与参数，`htmlJsonPath` 写取列表 HTML 的字段路径（如 `data.html`），`baseUrl` 必须写栏目页地址，相对链接按它补全；取出的字符串照常用 `itemSelector` 等选择器解析。只用于页面自己声明过的接口，不猜接口。不是 JSON、路径上没有字符串时这次采集失败（不当作空列表）；与 Jina 读取、`parseMode=markdown` 同用，值为空或没有 `baseUrl` 时，按不支持的配置拒绝。改它等于改日期从哪里来，计入日期配置哈希。

RSS/RDF的`dc:date`始终保留原串与定位，默认publicationBasis=other，不自动作为发布时间。需逐源明确`publishedAtField:"dc:date"`，并给sourceDate.meaning/publicationBasis/basis语义依据，才按声明解析和判定；显式字段缺失时不切换依据。默认网页日期只取head页面级元数据或绑定当前URL的Article类itemscope；侧栏、其他文章和无身份的microdata不属于本稿，显式selector规则保持。公众号首次窗口同样先严格解析，不能用Number把未识别的原串提前转成旧日期。


旧`translateArticle`/`translatePending`已切到严格单段`{text}`运行器，提示词与适配同片生效。完整当前配方才结束补漏；部分结果依实际attempt检查点续接，unknown/停机不写终态，整篇操作记录不再充当付费次数上限。现在由逐稿content.translate消费，cron只补投递；不以selected/public作为翻译前置。新外文在当前完整中文就绪前不公开，已公开稿重处理期间正文待补齐，人工撤回仍优先。


详情与全文RSS复检当前修订/配方/原文、完整manifest、段顺序/hash及六类坏段；默认中文阅读不回退英文，原文入口仍受当前全文许可约束。source标签的旧派生中文版尚无真实写入/完整性证明端口，保持未证明；原生中文材料不受此影响。RSS只在当前site与syndication均允许时内联已验证中文，不读取私有段表。当前普通/入选外文都经来源队列、严格逐段调用和公开门；长单元拆分/前文参考及一次截断替代任务仍待后续，不把当前pending截断状态说成已完成。

R-03/R-10最小接线：collectSource支持config.language明确声明，经BCP47/运行时语言注册数据规范化后写既有材料language；没有明确语言时不进入付费处理或公开，不以单个汉字推断。中文主语言zh含繁体变体无需翻译，已知非zh才入队。新正文修订明确language:null会清空旧语言，省略字段才保留。没有实现自动语言检测，也不会改写既有重复材料的语言或对声明变更全量回填；需受控元数据修订的历史材料仍是明确余项。私有建源继续使用SourcePolicy 0.3的显式scope/附件声明，不能用旧0.2请求或测试SQL补造加入依据。

翻译cron按article_id进行有界轮转，覆盖任意日期的缺失当前译文。platform/ops的latestSuccessfulRunResult只读同名最近成功job_runs结果，原recordRun保存每批cursor；失败结果不推进，空批回到起点，已存在的durable singleton也推进扫描而不挡住后批。补漏不调用模型、不改translation_attempts或费用回执；新进程从持久结果续扫。逐稿worker仍重新核对许可、当前修订和人工撤回；unknown回执不得因再次排队而重买。语言自动检测及来源中文版证明仍是Task20余项，真实持续运行尚待验收。

完整中文的段计划按实际受保护HTML限制每段4000个UTF-8字节，保留结构节点、完整表格行/条款；仅在顶层换行或br处无损分开。没有合法断点的超限单元记pending_capacity，零模型调用且不公开。每个模型输入只译text，referenceOnly携带前一源段末两句供参考；缓存绑定实际内容和参考，不以修订号或段号重买。内部v2 manifest记录有序覆盖、每个输出边界和哈希，读者按原单元还原后逐段复检，不把大篇幅的已组装正文当一个模型段判坏。

真实当前attempt若返回length且有合法用量、此前未走坏输出重试，才能在content事务围栏内登记一次二子段替代。父原始response/usage保持received，子段各有实际attempt；子段不得继续派生或叠加坏输出重试。正常坏输出最多三次实际尝试，按实际接收时刻冷却五分钟；同材料修订翻译阶段的pending/unknown或未确认用量的received挡住新付费key，已经收到的同key可免费复用。替代关系、检查点和晋升共用当前revision/recipe检查，迟到或停机均不继续下一次付费。

共享缓存不按原始receipts.subject决定材料归属：gateway在claim/reuse的同一事务和材料环节锁内保存ai.translation_receipt_observations，分别绑定调用方、回执版本和真实attempt。B观察到A的pending/unknown后，即使catch尚未写检查点或B换配方，新付费仍被阻止；缓存键不增加材料ID。老检查点可带入原观察，但无实际尝试依据时只留null，不能猜MAX；有明确未计费状态时仅解除该已观察版本，旧确认不解除新unknown。

升级时若旧进程尚未写任何段检查点或观察，claim事务按原subject精确恢复本材料/修订的观察；pending/unknown只接当前实际ordinal，received/completed须核原response指针与字节。无证明仍留null并阻止新付费，不猜共享材料归属，也不改变付费缓存键。

首次入库静默提醒（TASK-0115）只描述`articles.discovered_at`没有新值，不把成功抓取、首次入库和公开互相推导。`collectFindings`的可选内部观察回调复用本轮已有读数；`checkAlerts`仅在正常检查取得晚于静默起点且不晚于当前时间的新首次入库时报告恢复。采集关闭、来源全暂停或worker启动宽限不构成恢复证据，原提醒状态保留；旧持久停机标题不用于恢复文案。此观察不增加查询、持久字段或公开接口，也不改阈值、重复频率及其他提醒。

### 采集分线调度（TASK-0111）

`news.sources.fetch` 与 `policy.sources.fetch` 分别领取，每线有独立采集开关与并发；定时与手动入队用同一来源单例，旧 `sources.fetch` 在 pg-boss 事务中转投与完成。事务失败不会先确认旧消息。原 `sources.schedule` 仍记录资讯调度，法规使用 `policy.sources.schedule`，新闻静默和真实新增口径不变。每线独立取批次，法规按登记法域交错选最早到期来源；成功与失败继续持久更新 next_fetch_at。环境开关仅为部署配置，不替代带原因、操作人和到期时间的暂停管理，也不改变来源许可。

### 法规模型调用（TASK-0100）

`@amp/backend/providers/policy` 的 `createPolicyGateway({root, resolve})` 返回 `chat({input:{id,version}, purpose, schema})`，purpose 为 policy_fulltext/group/interpret/verify。`resolve` 是可信政策模块端口：从当前原件、完整输入计划与控制修订重建 PreparedPolicyInput（SourceInputManifest、system/user、promptVersion、recipeVersion、controlRevision、processingAllowed），不能照抄调用方声明。网关复核实际输入指纹、逐来源当前用途许可和临时 ProcessingPermit，并调用现有 chatJson/paidRequest。四个新模型能力沿用现有管理员/环境/default 优先级，不改任何既有选择。

回执保存 policy lane、类别、来源集合、输入 manifest 及指纹。一个来源存在 pending/unknown 或未返回明确用量的已收响应时，新付费调用不能通过改变输入或模型绕过；已有原始响应仍可复用。每次尝试的 usage/cost 沿用现有账本，缺少实际费用保持未知，现有价格表估算仍与实际区分。返回后输入/许可/暂停改变时抛 PolicyInputChangedError，携带真实回执与尝试 ID，不返回可晋升候选。调用方应把正常返回的回执与业务结果在同一现有事务中结算，网关不授予发布资格。完整输入门、逐原文部分的付费尝试上限与输出业务校验属于政策处理计划/能力消费者。
