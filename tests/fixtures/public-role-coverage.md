# TASK-0004 PR9 真实角色与公开路由

夹具只用于随机前缀临时数据库，由引导连接直接写SQL，不调用模型或真实信源。API子进程仅拿自己的public_read/feedback_write登录；七个登录先验证session_user=current_user，随后关闭准备连接。public-role-fixture模块导入不创建进程或连接。

`public-role-data.sql`：三种visibility×三种source participation×两种body_mode共18种组合，另含第二来源报道、无站内正文许可、低相关度、未来出刊条目，以及没有projection的候选正文；还有两个事件、别名与关联、三个事实、热度观测、专题、三类报告、正文独有搜索词和selected ledger。

`db-role-matrix.test.ts`使用独立于授权规划器的D4权限预期，逐个真实登录检查48表的SELECT/INSERT/UPDATE/DELETE、受限列、15序列的SELECT/nextval/setval、跨角色SET ROLE、公开DDL/TEMP。零行写语句只验证ACL；worker/private_ops在三张RLS表另外实际插入、读到和更新行，再回滚，避免把0行当放行成功。

`public-role-routes.json`逐条登记固定输入中实际注册的56条GET、可重放示例、夹具和内容断言；用合成IndexNow key覆盖条件注册。与运行时公开工厂路由表严格集合比较，新增或漏掉路由都会失败。JSON是登记数据，9b的public-role-routes.test.ts通过后才算HTTP覆盖证据。

数据库内容端点检查具体PR9标记、非空数组、图像签名或数值，覆盖三类报告、正文独有搜索、事件别名、真实snapshot分页与changes游标；更新release状态由独立夹具管理员完成。静态品牌/manifest/OpenAPI/规则等、空contactEmail的security.txt404、stateless MCP GET405、v1固定兜底404均写明无业务数据分支，不能计为有数据查询；另做真实只读MCP工具POST。

独立新API进程的模块池延迟连接、空闲保留600秒；在结束进程前按临时库和真实用户名读取pg_stat_activity。GET组要求public_read=1、feedback_write=0；独立feedback组不探测health，提交201并封禁后403，要求public_read=0、feedback_write=1。进程在finally先停，再由fixture关闭连接并清理库/角色。

D4的M0余项保持原样：公开DB登录仍能读到有projection的summary-only、withdrawn、hot_signal、isolated、无正文许可和低相关度材料正文；没有projection的候选不可读。HTTP详情/原文、报告引用和全文RSS按现有输出规则过滤。这里不宣称数据库已经只读公开投影。

运行：`node --test --test-concurrency=1 --test-timeout=120000 tests/db-role-matrix.test.ts tests/public-role-routes.test.ts`，DATABASE_URL须为允许建临时库/角色的隔离测试连接。完整verify的D12分组接线由集成人后续处理；本地通过不代表full verify、PG16.14基线或上线。

TASK-0005九类接线后，分类RSS正例使用company_project及对应当前publication夹具，继续断言有条目和正文；旧industry两个路径明确404。selected ledger仍保留旧industry值，以覆盖旧账本只在公开读取时归null；没有批量改账本或放宽角色断言。
