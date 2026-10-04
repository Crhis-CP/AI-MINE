# PostgreSQL 角色授权（TASK-0004 D4/D5）

`table-grants.json` 分类全部48张 public 表、15个序列及其属表；18张表支撑现有公开读取。目录有未知/缺少的表、序列或错误依赖即拒绝规划，不把未来新表自动授权。

`scripts/db-roles/grants.ts` 的规划器是纯函数：输入目录快照，输出七个前缀登录及SQL语句，自己不连接、不执行。现有角色有额外权限属性/继承成员关系、对象属主或授权来源不明、未知RLS策略、危险默认授权时拒绝。实际执行与真实登录验证由PR8b接入。

public_read默认连接上限10，与当前默认单池上限一致；规划时可显式给正整数，部署须按实际池和实例数配置。所有新登录无口令、无跨角色成员身份；仅backup有BYPASSRLS。migrate是业务表/序列/public schema/目标数据库属主；后者用于既有0034迁移中的ALTER DATABASE。

公开列与三张RLS表沿用批准范围：articles/translations只要求存在publications行，settings只露selected_ledger_epoch。已处理但摘要、撤下、隔离等正文仍可能被数据库公开登录读取；这是移交M1/T-0151的已知边界，不能称为AC-SEC-02全量达成。

private_ops/worker读写业务表且审计只追加；auth只管账号/会话及追加审计；feedback_write只插入反馈并读取返回id。backup读所有表和序列，不授nextval/setval。worker独占pgboss所有权；private_ops/backup同时获得其现存和worker将来创建对象的精确权限。私有API只发送队列由PR7客户端行为保证，不能把其DML权限说成数据库只允许追加job。

迁移文件保持不变。新增表、序列、公开列或角色权限须先更新此清单与对应正反例。
