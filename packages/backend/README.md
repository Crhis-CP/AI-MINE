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


翻译的逐段存储准备由enrichment独占：`translation_segments` 区分材料修订、配方、原文hash和段序号，原始模型text与恢复后HTML分别留hash；公开读取不读该明细表。`translations` 新增的recipe/source_hash/manifest保持旧记录为null，不补造完整度或回执依据。本次只交付可执行迁移与权限，严格逐段调用、事务写回及首次公开门另行接通，不能把schema存在当作完整中文验收。

TASK-0021生命周期前置：initializeDb返回本根AbortSignal；同role与同env引用重入复用，不同声明仍须先关闭。closeProcessDb先登记共享关闭Promise，再撤销注册和signal，监听器同步重入不能打开新根或使用旧能力；新根独立，未改队列正常drain的时点。signal不包含控制器、连接或URL；生命周期本身不代表许可存储或网关强制已激活。

未激活的sources/permissions与providers/permissions提供显式Ed25519签发/校验工厂：私钥只在sources闭包，验证端固定公钥/issuer/root。当前许可查询、可信完整输入重建、根signal与时钟必须由组合根提供，无默认allow。现有应用尚未调用工厂；合成端口测试不是数据库权限接线，模型/cache/写回仍待原子接通。

### content/source-time（TASK-0022，未激活）

共享纯规范化函数 `normalizeSourceTime` 位于 `@amp/contracts/time-assertion`，不猜格式、时区或来源事实；content 的待接线 `sourceDateVerdict(lane, evidence, currentBinding, now)` 显式接收时钟与当前身份，返回日期的 reliable/pending，policy 则仅返回 not_applicable 并交 BR-POL-11。复用 `@amp/contracts/time` 的日历与北京日函数；只有新闻发布依据能通过，官方登记/正式刊发须使用相应证据口径，系统/更新/生效日期不能顶替。此结论不是总体公开资格，不访问数据库、网络或模型；现有材料、队列、publication 和 HTTP 尚未调用。



TASK-0021存储能力：既有admin/sources入口新增saveSourcePolicy以及当前私有/公开读取、版本锁端口；不注册HTTP、不启用模型调用。来源编辑在同一事务追加不可变版本、CAS推进当前指针及最小公开投影、记录审计。缺记录返回null；不会在读取或迁移时补造Owner许可。数据库限制应用角色改删历史，管理员仍有管理能力。

lockCurrentSourcePolicies在调用方的事务中按source_id顺序取得共享咨询锁并核对版本，编辑使用同key独占锁；锁持有至事务结束。围栏仅接受READ COMMITTED，明确拒绝可能在等待后继续看旧快照的其他隔离级别。正式消费者必须先锁全部许可、再锁材料，并在锁内校验实际用途/资源后写回；该端口只保证版本围栏，不能代替ProcessingPermit或范围判定。当前函数尚未接入模型/内容消费者，不声称已实现完整网关强制。


`readCurrentBody` / `commitBodyResult`是content的正文派生窄端口：读取正文身份，写回时锁定相同revision与HTML；不改变分析状态、错误、次数或重试时间。显式`runBodyTranslation`由已核验准入、来源许可和外文条件的worker调用，网络在事务外，检查点与实际attempt的完成/标坏同事务提交，完整manifest另行晋升。旧revision/recipe迟到停止后续片段；旧attempt不能覆盖新attempt或被当作正常结果交给旧调用者。

Gateway保存每个实际attempt的原响应/用量/成本，receipts只在CAS当前尝试时更新response_attempt_id；缓存沿该指针核验所属回执、尝试与原响应，不猜MAX或给历史记录补造身份。新翻译显式启用同一调用键最多3次坏输出限制，claim前检查，重复结算不重复计数；旧能力默认不启用这个限制。缺usage的坏响应仍received，unknown不重发，明确截断不晋升；stop或空finishReason也须严格text与结构检查。不能证明历史缓存的attempt时保持私有待处理，不重新购买。旧cron/t提示词与公开门尚未切换，本片不代表自动外文准入完成。
