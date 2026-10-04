# @amp/contracts

`http/public` 是首批公开统计契约，`http/private` 是私有登录方式契约，`http/common` 保存现行错误体。Zod 定义传输形状，类型由其推导；site.ts 保留同名类型入口。其余 DTO 随 TASK-0005 后续响应族迁移。

taxonomy 保存现行分类/栏目 keys 与顺序，mcp 保存5个固定工具名；显示标签从 `@amp/industry/taxonomy` 读取。contracts 不依赖 industry，industry 也不反向导入 contracts；两侧身份一致性由集成测试守护。ADR-0022 的九类已在实际分析、公开投影与客户端联合接入，public OpenAPI 预发布版本为0.2.0。

Fastify 和 tooling 使用同一 `routes`/`schemas` 导出。修改字段须遵守任务卡契约边界；生成命令见 tooling/README.md。不要在契约模块注册 globalRegistry 或引用 backend。

`mining-taxonomy` 定义 ADR-0022 的九类键、非空键 schema、nullable 分类 schema 及未知/旧值归 null 的纯助手。CATEGORY_KEYS 使用同一九类键；归一仅用于公开投影，不能据此重写原分析、人工字段或账本。中文定义与报告主题栏在 industry 的同名子路径，二者通过离线测试对齐。

`source-policy` 是 TASK-0021/ADR-0024 的未激活内部契约：九用途权限版本、证据/范围、未受信任的签名封装与独立品牌类型。schema解析不授予许可，不签发/验签，不解释当前范围、版本或时效；HTTP与网关尚未接入。合成共享样例见 tests/permission-fixture.ts，后续真实工厂不能把该样例当授权。
