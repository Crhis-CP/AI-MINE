# backend 过渡期数据库接口

本包仍承载待迁往领域模块的现有实现，迁出顺序以 TASK-0004 和模块地图为准。本页说明数据库注入接口，不将过渡期后端视作新架构的长期边界。

## 公开入口

通过 `@amp/backend/db` 使用 `dbOf(module)` 与 `injectDb(bindings)`。包的显式导出清单不变；不要直接导入 module-db.ts。

- `dbOf(module)` 返回稳定句柄；加载模块时可以声明 SQL 片段、标识符或 JSON 辅助对象。
- 只有组合根调用 `injectDb`，给每个模块分配 `@amp/config` 的 dbFor(role) 连接。未注入时执行查询或事务会失败，没有默认连接回退。
- 注册是原子的；重复模块名即拒绝，不允许静默替换。返回的注销函数仅解除本次注册，不关闭连接；组合根退出时再关闭其拥有的连接池。
- 注销后，预先创建但未执行的查询及保存的方法也被拒；换入另一个连接后须重新创建查询，不能把旧查询静默转交另一个身份执行。
- SQL 片段在交给驱动之前解析；事务和 savepoint 的回调也收到包装句柄，能够复用模块加载时声明的片段。事务提交与回滚仍由 postgres 驱动执行。

```ts
const publicationDb = dbOf("publication"); // 模块初始化，可先于组合根注入
const columns = publicationDb`42 AS answer`;
const dispose = injectDb({ publication: access.dbFor("public_read") });
const rows = await publicationDb`SELECT ${columns}`;
dispose();
await access.close();
```

`sql`、withCustomPlans 与 closeDb 的现有调用暂时保持原样，PR3 才替换调用点。本增量不建立 PostgreSQL 登录或授予权限；真实登录矩阵仍归 PR8/PR9。测试在 tests/db-handles.test.ts，包含未注入拒绝、注册原子性、真实 SQL 片段/JSON/事务/savepoint 与回滚。
