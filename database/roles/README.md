# PostgreSQL 角色授权（TASK-0004 D4/D5）

`table-grants.json` 分类全部48张 public 表、15个序列及其属表；18张表支撑现有公开读取。目录有未知/缺少的表、序列或错误依赖即拒绝规划，不把未来新表自动授权。

`scripts/db-roles/grants.ts` 的规划器是纯函数：输入目录快照，输出七个前缀登录及SQL语句，自己不连接、不执行。现有角色有额外权限属性/继承成员关系、对象属主或授权来源不明、未知RLS策略、危险默认授权时拒绝。执行器只读取目录元信息，不读取角色口令或业务数据；全部校验完成后才执行授权。

public_read默认连接上限10，与当前默认单池上限一致；规划时可显式给正整数，部署须按实际池和实例数配置。所有新登录无口令、无跨角色成员身份；仅backup有BYPASSRLS。migrate是业务表/序列/public schema/目标数据库属主；后者用于既有0034迁移中的ALTER DATABASE。

公开列与三张RLS表沿用批准范围：articles/translations只要求存在publications行，settings只露selected_ledger_epoch。已处理但摘要、撤下、隔离等正文仍可能被数据库公开登录读取；这是移交M1/T-0151的已知边界，不能称为AC-SEC-02全量达成。

公开来源列额外包含 `site_fulltext` 布尔值，供站内摘录投影检查来源当前许可；这只是列级SELECT，`config`、`cursor`、sources整表SELECT及写入仍禁止，不以缓存的body_mode替代当前许可。

private_ops/worker读写业务表且审计只追加；auth只管账号/会话及追加审计；feedback_write只插入反馈并读取返回id。backup读所有表和序列，不授nextval/setval。worker独占pgboss所有权；private_ops/backup同时获得其现存和worker将来创建对象的精确权限。私有API只发送队列由PR7客户端行为保证，不能把其DML权限说成数据库只允许追加job。

迁移文件保持不变。新增表、序列、公开列或角色权限须先更新此清单与对应正反例。

## 显式执行

先用受控的引导超级用户连接完成现有迁移，再经已有 `DATABASE_URL_MIGRATE` 配置向执行器提供该引导连接。常规 migrate 登录不是超级用户，不能执行此授权步骤。预览不改角色或权限：

```sh
node scripts/db-roles.ts --prefix amp --public-connections 10
node scripts/db-roles.ts --prefix amp --public-connections 10 --apply
```

只有 `--apply` 才在同一事务内建立/复用七个角色、转移已分类对象与数据库所有权、清除旧表级和列级授权、设置RLS及pgboss现存/未来对象权限。已有角色属性或成员关系异常、未知对象/策略、错误pgboss属主都会拒绝；不自动接管单一登录时期的队列。跨数据库复用同前缀角色时，连接上限属于该集群角色，各库授权仍分别执行。

新登录不设口令，部署再经受控渠道发放。本次真实登录测试仅为随机前缀临时角色签发内存中的合成口令，未读取现有秘密；测试失败也先关闭连接、删除自己创建的库，再逐个删除该前缀角色。

`tests/db-role-plan.test.ts` 是无数据库规划检查；`tests/db-role-grants.test.ts` 在full verify的backend-tests中，以七个真实session_user连接测试读写/DDL/继承边界、worker首次安装、私有投递、未来分区和序列权限、默认pg_dump及还原行数。备份不加enable-row-security；去掉BYPASSRLS或序列SELECT的反例必须失败。恢复测试使用no-owner/no-acl检验全部表数据，角色/ACL恢复流程仍属部署任务。PR9再覆盖全部公开路由和完整角色矩阵。

## 模块对象身份准备（TASK-0006 D1）

`relationIdentity` 从唯一迁移目录的既定模块/schema映射验证对象名：旧裸名明确归public，模块对象保留schema-qualified身份，未知schema、歧义名字与重复的裸名/qualified别名拒绝。C核对schema与模块归属，不猜成public。此准备片未改48表授权、元目录查询或SQL规划；非public表的真实目录、逐角色权限和schema授权须在后续接线，不把名字解析当作已授权，也不移除模块迁移执行限制。
