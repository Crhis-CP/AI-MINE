# @amp/contracts

`http/public` 是首批公开统计契约，`http/private` 是私有登录方式契约，`http/common` 保存现行错误体。Zod 定义传输形状，类型由其推导；site.ts 保留同名类型入口。尚未迁移的 DTO 与行业依赖将在 TASK-0005 后续响应族中收口。

Fastify 和 tooling 使用同一 `routes`/`schemas` 导出。修改字段须遵守任务卡契约边界；生成命令见 tooling/README.md。不要在契约模块注册 globalRegistry 或引用 backend。
