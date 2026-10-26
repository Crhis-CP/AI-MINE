# 数据库升级文件

`loadMigrationInventory`是执行器、数据归属检查共用的清单入口。扫描`database/migrations`和`modules/*/migrations`，以依赖优先、UTC时间及路径次序执行；文件basename在两处必须唯一。Docker沿现有源码复制包含模块目录，不另设发布或手动执行入口。

已有数据库目录的账本名、30份冻结原件和哈希保持不变。新扩展文件用仓库相对身份登记，例如`modules/policy/migrations/202610261000_example.sql`，并以同一名字写入`schema_migrations`；`dependsOn`可引用任一目录的已登记身份。SQL与哈希账本仍在同一事务提交。

每个文件都须登记在`database/migration-inventory.json`。扩展名默认也是数据归属名；两者不同时，扩展条目显式填写既有归属，例如metals条目的`module: "publication"`承接现有价格表。该字段只能用于扩展目录，且必须匹配既定`MODULE_SCHEMAS`；不增加schema或修改表的所有者。数据归属与授权目录继续独立检查SQL，目录发现不授予新权限。

未登记、缺文件、重名、无效日期、未知归属、路径越界、符号链接、缺依赖、循环或已应用哈希不符均拒绝。不能移动、重命名或重写已应用SQL来改变其身份；新增表及授权仍须通过原有完整验证。当前仅接通发现能力，没有增加生产SQL或执行生产迁移。
