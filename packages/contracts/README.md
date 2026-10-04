# @amp/contracts

`http/public` 是首批公开统计契约，`http/private` 是私有登录方式契约，`http/common` 保存现行错误体。Zod 定义传输形状，类型由其推导；site.ts 保留同名类型入口。其余 DTO 随 TASK-0005 后续响应族迁移。

taxonomy 保存现行分类/栏目 keys 与顺序，mcp 保存5个固定工具名；显示标签从 `@amp/industry/taxonomy` 读取。contracts 不依赖 industry，industry 也不反向导入 contracts；两侧身份一致性由集成测试守护。矿业九类的契约变更另行交付。

Fastify 和 tooling 使用同一 `routes`/`schemas` 导出。修改字段须遵守任务卡契约边界；生成命令见 tooling/README.md。不要在契约模块注册 globalRegistry 或引用 backend。
