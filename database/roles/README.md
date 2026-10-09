# PostgreSQL 角色授权（TASK-0004 D4/D5）

`table-grants.json` 分类全部48张 public 表、1张 enrichment 段检查点表、2张 sources 权限表、15个序列及其属表；19张表支撑现有公开读取。目录有未知/缺少的表、序列或错误依赖即拒绝规划，不把未来新表自动授权。

`scripts/db-roles/grants.ts` 的规划器是纯函数：输入目录快照，输出七个前缀登录及SQL语句，自己不连接、不执行。现有角色有额外权限属性/继承成员关系、对象属主或授权来源不明、未知RLS策略、危险默认授权时拒绝。执行器只读取目录元信息，不读取角色口令或业务数据；全部校验完成后才执行授权。

public_read默认连接上限10，与当前默认单池上限一致；规划时可显式给正整数，部署须按实际池和实例数配置。所有新登录无口令、无跨角色成员身份；仅backup有BYPASSRLS。migrate是业务表/序列/已登记数据schema/目标数据库属主；后者用于既有0034迁移中的ALTER DATABASE。

公开列与三张RLS表沿用批准范围：articles/translations只要求存在publications行，settings只露selected_ledger_epoch。已处理但摘要、撤下、隔离等正文仍可能被数据库公开登录读取；这是移交M1/T-0151的已知边界，不能称为AC-SEC-02全量达成。

公开来源列额外包含 `site_fulltext` 布尔值，供站内摘录投影检查来源当前许可；这只是列级SELECT，`config`、`cursor`、sources整表SELECT及写入仍禁止，不以缓存的body_mode替代当前许可。

private_ops/worker读写历史public业务表且审计只追加；auth只管账号/会话及追加审计；feedback_write只插入反馈并读取返回id。backup读所有表和序列，不授nextval/setval。worker独占pgboss所有权；private_ops/backup同时获得其现存和worker将来创建对象的精确权限。私有API只发送队列由PR7客户端行为保证，不能把其DML权限说成数据库只允许追加job。

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

## Qualified目录与授权接线（TASK-0006 D1）

元目录返回schema-qualified表、序列及策略名，并读取非系统schema；不读取迁移文件。现有裸名JSON只作为public历史身份兼容，内部规范化后规划SQL，48表、15序列、公开列、三张RLS表和pgboss策略保持。未登记schema/表/序列、跨schema序列归属、异常owner、未计划RLS和危险默认ACL仍拒绝。

未来非public表须以qualified键明确登记，module匹配既定schema映射，并提供permissions对象；没有隐式business CRUD回退。对象权限仍受access上限约束：business只给private_ops/worker，identity只给auth，audit只给private_ops/worker/auth的SELECT/INSERT，migration不给应用角色；新identity/audit分类只允许相应的身份模块schema。空permissions表示不授应用角色，不新增feedback_write通用整表通道。migrate为owner，backup只有读取；public_read仍仅由publicColumns授予，非public公开列只允许publication schema。历史public表不能借permissions改权。

每个已登记数据schema只给实际需要的角色USAGE，只有migrate有CREATE。新schema中序列只给有INSERT权限的应用角色USAGE，backup保留SELECT；migrate将来创建的对象默认不向应用或backup自动开放，须登记并重新授权。pgboss的worker所有权、私有DML和备份现存/未来对象规则原样保留。

此前目录准备阶段未增加正式表或授权项；现由下节首个真实模块迁移连同清单、C的模块DDL归属、独立权限oracle及执行器启用执行。非public、非pgboss数据schema中的函数及自定义类型明确拒绝；只按pg_class.reltype/pg_type.typarray身份保留合法表自动生成的行类型及其数组，不按名称或前缀猜测。原public扩展和pgboss专用处理不变。新增RLS及非public反馈表的列级写入通道仍不提供通用支持。测试仅在独占临时制品里增加合成ai目录，真实CLI代码逐字复制，没有生产跳过校验参数。


## 首个模块迁移：翻译段检查点（TASK-0020）

`enrichment.translation_segments` 按材料、修订、配方、全文hash和段序号区分检查点，分别保存原始模型text与按来源占位恢复后的HTML及hash。worker读写；private_ops只读以便诊断；migrate持有对象，backup只读。public_read/auth/feedback_write不获此schema使用权或段表权限，应用角色不能创建未登记对象。

现有public.translations只增加可空recipe/source_hash/manifest三个身份列，公开角色仅多读这三列，不获receipt_id或整表SELECT。旧记录保持null；新列和检查点表本身不能证明译文完整或回执可信，实际逐段写回和公开就绪门仍由后续运行接线验收。此次以真实enrichment迁移连同唯一inventory、模块写入归属检查及执行器解除旧fence，既有30份迁移、顺序、账本名与RLS规则不变。无hash的历史行仅在固定原件核验后补齐；已应用模块行缺hash直接拒绝，不以当前文件补造身份。


## 来源权限版本（TASK-0021）

sources.source_policy_versions由private_ops只追加，worker只读；current指针及public_policy由private_ops插入/CAS更新，worker只读。migrate持有schema/表，backup读取两表；auth/feedback_write无使用权。public_read仅获sources.source_policy_current的source_id、permission_version、public_policy三列；这是准确单表例外，不开放其他sources对象。公开投影只含四用途判定所需的范围/条件/期限和读者许可说明，不含证据正文、URL、actor或来源配置。未来新列、未知表和默认授权继续拒绝。


翻译后续身份迁移只给已登记表增加可空字段：enrichment保存gateway签认的opaque attempt_id文本，不新增跨模块外键；ai-gateway保存response_attempt_id、每次attempt原response及output_rejected_at。历史身份/判坏标记保持NULL，不从最大ID或最新ordinal猜测。表、序列、旧48表oracle和角色权限不变；公开角色不获这些回执/明细字段。结算归属由gateway端口在当前attempt锁内核对，段检查点与完成/判坏同事务，原响应先独立持久化。

来源日期观察归 content，仅 worker 可追加、private_ops/backup 可读；公开登录不能读原始候选或私有依据。公开需要的 articles 日期状态/版本与 sources 相关配置指纹按列授予，仍不能读取 sources.config；publication 的日期投影字段不表示日期门已启用。

公开读时校验只补两项元数据列：translations.origin用于区分模型证明与尚无来源中文版证明的旧记录；sources.syndicate_fulltext用于全文RSS即时核对当前再分发许可。保留site_fulltext与原列白名单，不开放来源config/cursor、回执、段检查点或任何写权限。

翻译的replacement_plan与parent_index仍在私有enrichment.translation_segments内；仅增加同schema父子约束，不增加public_read列或整表权限。原截断回执不因替代变成完成，公开正文只读取已晋升translations的必要身份/完整性列。

ai.translation_receipt_observations仅为gateway私有状态：worker写、private_ops/backup只读、public_read/auth/feedback_write无读取权；不增加跨schema FK，不改付费缓存身份。receipt_version只是观察到的计数版本，actual attempt仍由可空的稳定ID单独核对；known_unbilled仅继承已有明确未计费状态，不产生新的计费判断。

publication.metal_prices（金属价格，TASK-0044）归 publication：worker 读、插、改，没有 DELETE（只增不删，修订另起一行）；private_ops/backup 只读；public_read/auth/feedback_write 没有 publication schema 使用权，读者接口要用的列由 TASK-0045 登记 publicColumns 后才开放。

信源的业务线（sources.lane，TASK-0093）按列授予公开登录：公开读取层只用它把法规线信源排除在资讯热度证据之外；不含采集配置或许可内容。

TASK-0110：日期证据表保持worker只读、只插；新表`content.source_date_observation_seen`仅记录最后观察时刻，worker可读/插/改，private_ops与backup只读，公开角色无权；一次性清理仅用migrate角色。
