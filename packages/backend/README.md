# backend 过渡期数据库接口

本包仍承载待迁往领域模块的现有实现，迁出顺序以 TASK-0004 和模块地图为准。本页说明数据库注入接口，不将过渡期后端视作新架构的长期边界。

## 公开入口

通过 `@amp/backend/db` 使用 `dbOf(module)` 与 `injectDb(bindings)`。包的显式导出清单不变；不要直接导入 module-db.ts。

组合根也可以显式 `await initializeDb(processRole)`，按任务卡 D2 将 `DB_MODULES` 分配到正确角色：public-api 的反馈单独写入，private-api 的身份模块单独使用 auth；worker、migrate 和 test 各用自己的连接。它不会在 import 时运行，web/fetcher 不能调用；重复初始化会失败。closeDb 同时撤销这些注册并关闭连接池。该辅助入口属于过渡后端，随模块迁出由相应组合根接收。

- `dbOf(module)` 返回稳定句柄；加载模块时可以声明 SQL 片段、标识符或 JSON 辅助对象。
- 只有组合根调用 `injectDb`，给每个模块分配 `@amp/config` 的 dbFor(role) 连接。未注入时执行查询或事务会失败，没有默认连接回退。
- 注册是原子的；重复模块名即拒绝，不允许静默替换。返回的注销函数仅解除本次注册，不关闭连接；组合根退出时再关闭其拥有的连接池。
- 注销后，预先创建但未执行的查询及保存的方法也被拒；换入另一个连接后须重新创建查询，不能把旧查询静默转交另一个身份执行。
- 只用作插值的 SQL 片段、标识符、JSON/array/unsafe 辅助对象在每个新查询中按当前注册重建，因此 closeDb 后重新 initializeDb 可继续使用模块常量；片段本身不执行查询。访问查询方法或直接执行会固定原生命周期，旧查询不能跨代复用。保存的工厂方法在调用时核对原注册。
- file 查询、reserve 返回的连接与 cursor 返回的迭代器同样受原注册约束，保存的方法也不能绕过；release 会使保留连接失效。已构造查询的 cancel、迭代器 return、保留连接 release 在注销后仍可清理资源，重复 release 安全；尚未完成的 reserve 在注销后返回时会自行释放。
- largeObject 保留原有查询与流功能：返回的方法、待执行查询及读写流的后续数据库操作绑定原注册，close 仍可在注销后结束其原生事务且可重复调用。迟到的创建结果先关闭再拒绝，不泄漏事务；已启动 I/O 可结束，新的流块被拒绝并按流的错误通道报告。
- 事务和 savepoint 的回调也收到包装句柄，能够复用模块加载时声明的片段。事务提交与回滚仍由 postgres 驱动执行。

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
