# backend 过渡期数据库接口

本包仍承载待迁往领域模块的现有实现，迁出顺序以 TASK-0004 和模块地图为准。本页说明数据库注入接口，不将过渡期后端视作新架构的长期边界。

金属价格的 Cochilco 日报适配器经既有 `jobs/publication` 刷新口运行；按官方日期读取六种基础金属美元/吨现金报价，PDF内容hash区分版本，读者请求仍只读publication。来源事实与Owner风险接受决定分开登记，未伪称单独取得自动抽取或历史保存许可；广期所访问未通过，未接入。来源登记可单独停用。

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

`providers/policy.ts` 内部模块的 `createPolicyGateway({root, resolve})` 返回 `chat({input:{id,version}, purpose, schema})`，purpose 为 policy_fulltext/group/interpret/verify。`resolve` 是可信政策模块端口：从当前原件、完整输入计划与控制修订重建 PreparedPolicyInput（SourceInputManifest、system/user、promptVersion、recipeVersion、controlRevision、processingAllowed），不能照抄调用方声明。网关复核实际输入指纹、逐来源当前用途许可和临时 ProcessingPermit，并调用现有 chatJson/paidRequest。四个新模型能力沿用现有管理员/环境/default 优先级，不改任何既有选择。

回执保存 policy lane、类别、来源集合、输入 manifest 及指纹。一个来源存在 pending/unknown 或未返回明确用量的已收响应时，新付费调用不能通过改变输入或模型绕过；已有原始响应仍可复用。每次尝试的 usage/cost 沿用现有账本，缺少实际费用保持未知，现有价格表估算仍与实际区分。返回后输入/许可/暂停改变时抛 PolicyInputChangedError，携带真实回执与尝试 ID，不返回可晋升候选。调用方应把正常返回的回执与业务结果在同一现有事务中结算，网关不授予发布资格。完整输入门、逐原文部分的付费尝试上限与输出业务校验属于政策处理计划/能力消费者。


TASK-0129运行控制：`operations/lane-controls.ts`提供27条分线/阶段/持有者记录与行级revision。runtimeControlSnapshot捕获news/policy及all的全部相关持有者版本；assertRuntimeControl在调用方READ COMMITTED事务持有共享锁，拒绝暂停或期间发生过控制变化的结果升格。部署/系统读取laneControlHolderRevisions并只更新自己；修改返回该事务实际生成的版本供后续释放，不能读到另一部署的新版本后误解锁。期限过期只告警，不能自动恢复。

中央paidRequest先复用既有物理回执，再检查新调用的控制；收到了响应仍先存用量/费用。chatJson可带runtimeControl，只用于claim前围栏，不进入prompt、logical key或传输。确知的lane仅写新request元数据，不推断改写历史。模型处理暂停不关闭普通采集/清洗或已公开读路径。新增原件/材料和采集成功游标、模型分析/翻译/视觉、向量批次及公开晋升分别在相应事务核对控制；向量存储使用events/embedding-store，来源成功游标使用admin/sources的recordSourceCollectionSuccess，不新增跨模块写。

公开暂停不阻止撤回/收紧；延后的来源重投、正文和法规阶段保留待办并延后续跑，不耗尽为终态失败。日常HTTP只能控制owner持有者的processing或collection+processing，all操作显式确认且all自动处理期限最多24小时；真实Owner账号能力另由0138绑定，现有session+CSRF不等于Owner角色。

### TASK-0138 具名账号

既有 `admin/auth` 出口提供 `currentAccount/listAccounts/createAdministrator/changeAdministrator/changeOwnPassword`。HTTP身份只来自当前会话；Owner的账号操作在相同事务重核能力，目标账户的版本与会话撤销用同一锁。create/action接受可选commandKey（HTTP必需），同编号同载荷重放既有结果，载荷不符拒绝；密码只存Argon2id，命令摘要也是独立慢哈希，响应与审计不含密码。

登录要求一次性、同来源、同cookie的nonce；source/account限速在密码派生前执行，全球流量只延迟和脱敏告警。会话最长12小时，后台连续30分钟不活动失效。真实DB不可用返回503且不清cookie。旧admin@local仅保留原有登录资格；具名密码一旦安装，就不能再以环境旧密码登录该账号。Feishu allowlist不会赋予Owner；已明确绑定的union身份继续兼容，其他邮箱不能认领密码账户或Owner。

首位Owner及遗失恢复只在 `scripts/accounts/owner-access.ts` 的受控服务器交互入口执行；没有HTTP自助认领或恢复口。本机没有执行真实开通/恢复，部署时须核对具体Owner身份和安全恢复渠道。

### 网站资料（TASK-0145）

`site/stats`转发`loadSiteInformation(db?)`公开只读口；`admin/settings`转发`readManagedSiteInformation(principal)`、`saveSiteInformation(principal,input,commandKey)`及`protectedSiteInformation(now?)`。新增资料只有关于正文/联系邮箱/联系页面/官方入口，初始值复用当前ABOUT.lead与价格登记清单，不在GET建库。保存先在private_ops事务取得当前Owner能力共享锁，再锁单例资料、验证revision并同事务写公开记录、同一命令不重复执行的记录与前后审计。public_read只读资料表明确列，不可读取命令表或写入。

关于页读取/api/site/information并重新核验缓存；已有价格接口只替换officialLinks，不改变报价来源/字段/采集许可，价格页仍每5分钟与重新可见/聚焦时刷新。联系邮箱同时用于已有security.txt与llms.txt路径，空值不展示、不回退旧值。保护信息仅核程序当前配置存在性及展示策略，不代表已经在线核验资质。当前ICP/公安/新闻许可读取现有构建常量，保留原展示，明确来源；NEWS_LICENSE_VALID_UNTIL是新增受控运行日期（YYYY-MM-DD），缺失/无效分别展示未记录/无法核对，余天按北京时间算。后台不能修改该日期或号码，未自动启用任何新的通知/部署动作。

TASK-0139费用保护：`admin/settings`既有入口转发usageProtectionOverview/changeUsageProtection/changeUsagePrice/recoverUsageBreaker；读取仍为管理员，三个写口在同事务requireOwner并校验版本和记录理由。`providers/usage-protection.ts`内部readUsageProtection(db?)可复用调用方只读事务，提供配置/价格/真实已开范围/缺项，未计价金额不填0。`admin/models`内部规范身份读取modelConfigurationIdentity(key,db?)/currentModelConfiguration(capability,db?)仅返回key/service/requestedModel/configuration_hash，不暴露密钥或质量资格。

paidRequest先免费复用回执，再按已核CNY价格做保守预留；chatJson每次实际attempt绑定非秘密transport配置hash。旧无hash unknown/pending不能因迁移而变新key重复付费，已有received可免费接续。重复输入、单对象、日总异常按明确lane/能力/来源/对象持久熔断；未知费用仍占用，Owner只恢复所选范围，人工/部署/system暂停互不释放。taskBudget={key,limit_micros}是来源研究的可选固定任务上界，同任务已结算+未知+在途+新预留原子比较；任务执行器提供不可变key/限额，不是月度额度。usageProtectionTick与usageMonthly由现有worker调度，HTTP不运行模型、发送通知或补算费用。

### TASK-0148 按环节主备

现有 `admin/models` 出口追加 `modelFallbacks/changeModelFallback`，HTTP 使用模型配置能力、CSRF、revision CAS 与同事务审计。主模型继续由原 `modelFor/settings` 决定；没有种子备用。后台列出所有登记接入并给出不可选原因。备用须为另一当前测试通过的接入，明确限定本业务线来源；主/备配置、测试修订或质量证据变化会立即阻止新回退。正在作为备用的接入同主接入一样不能直接修改运行参数或停用，须先解除指派。

`chatJson` 的内部 `fallbackPermit` 由可信调用者捕获实际原输入及当前重建口产生。每个目标配置独立签发来源许可，运行器不将主供应商的授权回调用到另一供应商。仅真实物理回执证明 `connect_before_send`，或 `content_filter` 响应费用已结清，才有一次备用机会。HTTP 非 2xx 缺少计费证明时保留 unknown；暂停、费用熔断、许可/配置失效、pending/unknown、发送后超时不触发回退。备用决定先持久化；重启先走同一备用回执，成功免费复用，unknown 等待原回执核对，连接失败也不再发送第二次。处理控制在发送前阻止的调用不消耗这次实际发送额度。原失败、备用尝试和各自费用都保留。研究、评测、实验及连接测试不自动回退。

备用实际响应的模型名及供应商版本标记须与其质量物证一致；漂移只保留私有回执，该配置修订进入阻塞，须重新评测与显式指派。等待资格/许可或内容过滤时，资讯/事件任务保留可恢复等待，不耗普通失败次数；法规返回现有 `provider_unavailable` 状态。读者请求不调用模型。

评分复用 `admin/selectbench.readApprovedSelectionCalibration`，主备须同样本集/版本、当前标准/预筛/门槛，来源取已确认覆盖的交集；来源处理许可另核。法规复用现有 Owner 质量发布，按真实物理模型键、原文语言、全文和解读配方核对；视觉需要图像能力，输出仍经过完整法规公开资格。不同配置同名模型、缺少实际响应模型、缺失 Owner 质量发布都不能借主路由资格。

其他环节沿已有 SelectBench 保存 nullable `model_route_approvals`；旧上传 summary 不带资格。先用现有评测/样本流程保存实际完成的回执与金标，再在受控服务器交互终端执行 `node scripts/model-route-qualification.ts approve /安全位置/已审阅.json`。脚本要求负责人具名密码登录，密码不回显、不接收在参数中；安装和撤销均复核真实 Owner 身份并审计，登录会话结束时撤销。它不会发出模型请求；已付且确认为同输入的生产结果也可用于免费评测，不强制另购同一答案。

批准文件字段：`runId`、`capability`（非 score/policy）、`modelKey`、`goldHash`（已存按 case_id 排序的 `[case_id,gold]` 数组之 stableJson SHA-256）、`reviewEvidence`、`validUntil`、`reason`，以及本人真实完成后才填写 true 的 `heldOutReviewed/sealedReviewed/shadowReviewed/canaryReviewed/qualityAccepted`。后端从实际物理回执重建样本/模型配置、提示、输出合同、实际响应白名单和来源范围，文件不能自行扩大来源或模型身份。每次使用重新核验样本及回执哈希；提示变化、到期、撤销即失效。撤销使用 `node scripts/model-route-qualification.ts revoke /安全位置/撤销.json`，字段为 `runId/approvalId/reason`。批准只是资格记录；仍需在模型页主动指定备用和来源。真实金标、质量批准与供应商选择未在本次开发中安装。

TASK-0148新闻备用输入通过内部`providers/news-fallback.ts`在主请求前绑定实际请求、来源材料修订/字节/日期版本与许可版本，备用授权和发送前回读各拥有模块；不在主请求失败后把新材料当成旧输入。`content/materials.newsMaterialBindings`仅返回真实文章来源，`editorial/analyze.analysisMaterialRevisions`与`publication/publish.newsCompositionPublications`提供报告的当前投影/原分析修订依据。缺依据、换版或许可改变时无备用发送；图像、旧分组框架和增量摘要缺原始输入绑定，保持主路由，不能声称这些环节已具安全自动回退。



### 2026-10-11 审计优化：材料、模型、事件、人工稿、反馈与来源预览

普通 URL 身份按来源隔离（保留来源自身既有 ID），恢复历史原文仍建立新修订。新闻主模型、备用、缓存复用均核对当前材料许可；新闻同材料同能力的未知费用跨模型与重试标记保留屏障。分析写回通过来源许可锁后才锁材料，不能将收紧许可前的结果直接晋升。

事件关系要求当前修订、双方逐字原文、共同项目/动作、法域和阶段一致；后续必须更晚并有变化，低置信度保持分开。自动成员记录 input_revision，原材料修订后失效重判；人工关系保留并在诊断返回 needs_review。内容与公开层分别提供所属数据的窄读端口，事件模块不新增跨表读取。

人工正文/标题/导读保存为不可变草稿，明确核对来源与中文事实、提供至少12字原文依据后才能发布。来源修订后保留有依据的人工作品并标需复核；引文消失进入冲突，解决须至少10字说明。下架、人工发布、公开投影、审计、可靠热榜更新投递共用事务。已撤回报告引用使网页、目录、API的综合导语、综述和栏目总结失效。

反馈记录首次处理完成时间，满180天去除联系方式、截图、来源摘要标识，正文中的可识别邮箱/电话号码去标识，保留业务文字与处理历史。周汇总只包含统计及后台链接，按北京时间自然周持久化并对发送成功去重，失败可重试。没有真实完成日期的旧记录不猜测日期。

来源预览在 sources.preview worker 中取得样例，HTTP只入队/读取；成功证据绑定来源配置与许可版本。首次启用必须成功预览；配置改变先存草稿，验证后明确切换并重置本配置检查点，普通名称和频率编辑不清检查点。以上仅完成仓库实现与隔离验证，真实模型质量、部署和线上持续运行另行验收。


## 匿名公开 v3 读取

`@amp/backend/publication/v1` 继续作为既有公开边界，另导出 `v3*` 读取函数；实现分在 publication/v3.ts、v3-reading.ts、v3-collections.ts。v3边界对排序、同步与续读游标做带用途前缀的HMAC封装，客户端篡改被拒绝；新闻列表沿用排序键游标，取消固定7日窗口并复用来源/国家/矿种/日期/主题条件。正文按来源当前再分发开关分块，续读绑定材料修订、表达和正文指纹；旧游标换版返回409，当前撤回对象不可读。公开DTO由 contracts/http/v3.ts白名单定义，OpenAPI从相同注册表生成。

来源时间仅使用匹配当前材料和日期配置的TimeAssertion；缺证据保持unknown。项目主题等待核实词表；不新增空项目。法规机器正文目前仍为Q-47限制状态，提供原文/本站阅读入口，不复用站点全文权限。

## 读者独立复核第二轮

新闻详情的 `readingState` 明确区分可读、整理中、来源许可受限和暂无正文；不通过状态文案放宽 `site_fulltext` 或再分发权限。`firstPublicAt` 只读首次公开证据，历史无记录返回 null，不拿发现或更新时间替代。事件相关报道分别给出第一方优先的代表稿与最新事实代表；同一事实的新转载不改变“最新进展”，当前撤回对象不进入返回结果。

后续列表复用全部合格公开进展，并提供摘要；读者端通过生成客户端读取，失败可重试，空结果与未读取明确区分。RSS 摘要、全文和日报带发布方/AI标识；日报导语复用报告引用资格检查，缓存立即重新验证，XML订阅提示为1分钟。生产部署及真人内容质量验收仍需独立证据。

公开报告的 `corrections` 仅包含 `revision`、`reason`、`at`。ReportPaper 在日报、周报和月报共用更正说明区块，时间按北京时间展示；v3Report 显式投影同一组公开字段，不展开更正对象中的其他属性，不读取私有 report_revisions.reason。

### 审计第二轮后台功能补齐

来源归档为终态，持久检查点只随入口/分页身份变化重置。组级撤回保存独立操作记录及成员投影，后加入成员受到同一hold保护；指定恢复只释放该记录，保留单篇和其他组级限制。报告撤回不连带撤回成员，报告更正通过持久队列和修订快照传播，模型网关逐来源核许可、复用回执、阻止未知费用重购。公开事件及热榜在综述需更新时仅用当前合格代表材料，人工保存内容不因公开撤回而被覆写。反馈以提交键及payload哈希去重，同键异内容冲突。

验证与已知边界见 `docs/acceptance/audit-remediation-20261011/pipeline-round2-status.json`，不代表生产上线。

### 独立复核收尾

来源试抓同绑定复用在途任务，首次请求后一分钟内重复点击复用结果；用于启用或激活的成功预览最多保留24小时效力。暂停后取回的采集结果不入库、不推进检查点或成功水位，涵盖目录、公众号与推送入口。反馈只接受可完整解码的PNG/JPEG/WebP，限2MB、4000万像素及单边16000像素，并移除图片元数据；关联页面限可信本站地址及2048字符。客户端每小时5条、本站北京时间每日500条额度持久并发扣减，同一提交重试不重复收件或扣额度。公开收件角色仅可更新额度计数，不能更改桶身份或删除计数。

事件收藏只存本机引用并复核当前公开资格，事件与各类报告提供复制及系统分享。公开署名仅展示已登记且无歧义的公开许可/规则链接，私有许可依据不进入读者DTO。机器事件成员摘要逐条采用可再分发导读，不继承网站摘录。法规旧材料在来源日期未知但本期完成解读时仍进入解读更新。正式v3规范、接入页与llms说明保持可达一致。

预览执行通过短事务CAS领取带期限的执行令牌；网络不占用数据库事务，90秒中止、120秒租约，每5分钟恢复遗留running任务，failed/succeeded不盲目重开。迟到令牌不得写终态；预览Jina的pending/unknown屏障按业务线与来源绑定，换预览编号不能绕过。


### 资讯日期筛选（TASK-0314 / DEC-67）

`publicationDateCondition` 供资讯列表、搜索、分面、公开条目和事件目录共同使用，按时间线的北京自然日计算左闭右开边界；来源日期未知不单独排除，来源日期字段和公开资格保持原样。显式来源日期排序只改变顺序。带日期条件的条目及事件游标绑定该语义版本，旧口径游标要求重新读取首屏。法规的法律日期筛选不变。


### 数据所属模块的事务端口（TASK-0316 / TASK-0319）

人工拆组由`events/group.detachArticleFromFactTx`接收原编辑事务，成员/独立决定由events保存，材料行锁与归组时间交`content/materials`；公众号正文重试元数据和失败材料复位也只由content写入。回执非计费确认由`providers/receipts.releaseUnknownReceiptUnbilled`在调用方事务内完成原版本CAS与尝试结算，随后仍同事务入队和写审计。来源编辑通过`jobs/publication.queueSourceRepublication`同事务写重投进度与队列。

预筛审计分别读取sources身份名称、content材料、editorial人工排除和enrichment最新判断的窄端口，只在ai自表保存抽样与标注；保留PostgreSQL的既有hashtext种子排序、标注与上一批优先规则，不触发模型或发布。`publication/groups.reportCandidateRows`承载原READ COMMITTED事务、report_candidates咨询锁和选材SQL；机器报告引用经items读取当前公开导读，不继承网站摘录。没有新增公开HTTP字段、表白名单或数据库权限。


TASK-0327补齐SQL值入口验证：审计筛选只接受文本与正整数页码；飞书token/userinfo先核JSON结构，再读白名单或写身份；SelectBench新旧导入形状先核元数据、样例与持久模型数组；事件模型fact按结构化分析同一字段类型读取，损坏框架清空为null，日期仍只接受真实日历日期。有效输入保持原行为，不以类型强转或修改ownership证明器绕过检查。

### 日报无新增精选（TASK-0334）

日报仍只取精选；当期已有公开合格报道完成评分，但没有新鲜精选时，保存零条目的当天日报及“今日无大事发生”说明，不调模型。dailyJudgedReportCount仅计数确认评分已执行，普通资讯不进入报告。没有评分依据的刊期待补刊；补刊只在实际保存后报告成功。零条目刊期同样幂等，历史期不因后来内容变更而重写；周月报规则不变。

本次维护（TASK-0343/0344/0346）：成功发布后的读者更新记录由 `site/meta` 合并静态历史与 `/data/site/release-notes.json`；公开输出不包含内部版本标识。主机共享发布锁串行登记，失败保留待补记，不回滚健康网站。反馈来源仍自动随提交保存，表单不显示内部路径。

模型已明确返回 `finish_reason=length` 时，同一输入与输出配置只复用已付费结果，不再原样重购；长文翻译保留既有拆段恢复，归组和发展线配对使用足够的证据输出空间。熔断阈值、未知结果屏障及人工暂停优先级不变。

Cochilco 可通过 `METAL_PRICE_RELAY_URL` 使用限定来源的 HTTPS 取件服务，worker 只读挂载独立 Ed25519 签名文件；海外只部署公开验证密钥。返回原件须匹配来源地址和 SHA-256，仍走原日期、单位、坏日隔离及去重流程。未配置时沿用原直连。

## 2026-10-15 用量与恢复调整

付费网关沿用按服务的滚动分钟、小时、24小时请求次数控制；金额与重复调用指标只提醒。旧自动费用熔断由用量观察事务带审计恢复，不解除人工或部署暂停。价格缺失、过期与历史账目缺口保留告警但不阻断新请求；未能核算的费用保持未知，不记成实际零费用。明确限额的单次研究任务仍须有可核估价。

未知回执超过30分钟最多自动释放一次；原尝试和未知费用保留，恢复与文章重新入队同事务提交。再次未知由负责人核对；只确认最新尝试未计费时，不清除之前尝试的未知金额。服务次数仍计算每次实际请求，包括重试。
