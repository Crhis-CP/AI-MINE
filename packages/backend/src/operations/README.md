# 运维读取与固定采样

`operations/reports`沿既有出口提供`refreshOperationalSnapshots`和`readOperationalSnapshot`。worker每两分钟顺序读取各模块自有的固定聚合端口，单查询2秒上限；数据经严格的`@amp/contracts/ops-mcp`结构验证后写入ops.operational_snapshots。原始错误不写入快照，采样失败保留最后成功时间并标明失败时间；超过5分钟的样本显示陈旧。

private-api的`POST /mcp-ops`只接受当前具名Owner与既有CSRF，提供`read_operations`一个工具和固定12数据集，每次最多100行。服务最多2个并发读取，每位Owner每分钟30次；不接受订阅、任意查询、任务或命令。专用ops_read仅SELECT快照；缺专用地址不退回private_ops。身份与调用审计仍由auth承担，当前Owner能力锁持有到读取与审计完成；角色被撤销即拒绝后续读取。

数据集包括心跳/备份记录时刻、任务运行、来源、材料处理、采集、月内实际回执汇总、发布投影、脱敏审计动作、账号汇总、反馈汇总、评测数量和队列汇总。返回均带采样时刻、覆盖与排除说明，不能把采样成功解释成服务健康、法规质量合格或全来源完整覆盖。原始正文、提示词、任务载荷、错误原文、密钥、个人信息和审计前后值均不进入投影。

Web入口在所有主机名上拒绝/mcp-ops，public-api不注册它；不会新增公网入口或日常运营总览页面。部署时仅为private-api配置独立只读地址，凭据不进入仓库或聊天；Owner通过私网与现有具名登录通道使用。本次开发未创建真实服务账号或生产连接。
