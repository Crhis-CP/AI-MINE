# 直接数据库入口契约验证

TASK-0368为统一升级的第15项先行增加内部直接连接入口：sql、identitySql、feedbackSql通过ES模块绑定读取当前根的postgres驱动，不包装每条查询。原有dbOf消费者仍沿用现有实现，待契约合并后迁移。

角色分派与连接池仍由原createDatabaseAccess提供。相同URL的三个入口共用驱动；public-api的反馈写入与公开读取、private-api的身份与运维查询继续保持既有角色边界。不存在隐式数据库或凭据初始化。

本地验证：未初始化拒绝、重复初始化、拒绝其他根不破坏当前连接、关闭后旧待发查询不会转投新根、真实事务回滚，以及现有db-bootstrap回归通过；pnpm check通过。日志在本工作树.verify/direct-db-tests.log、direct-db-runtime-final.log、direct-db-check.log。没有迁移业务调用方、修改生产连接权限或上线；独立完整验证仍须绑定最终提交。

最终提交87e780b2a4c7fb6a6f89029151cdf8724e934ce9基于345feb92主线重新通过[完整验证38954680504](https://github.com/Crhis-CP/AI-MINE/actions/runs/38954680504)，scope full、exit_status 0；PR250已正常合入main为394d66c6。原始回执在统一工作区.verify/ci-38954680504.receipt.json。该契约是兼容入口，消费者迁移尚未完成，生产没有因契约合并而切换。
