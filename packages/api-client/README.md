# @amp/api-client

`@amp/api-client/public` 和 `@amp/api-client/private` 是两个独立生成入口，没有混合根入口；`src/` 全部由 `pnpm contracts:gen` 管理。每个入口提供类型化 createClient 和相应响应 schemas，消费端必须验证 data；openapi-fetch 的类型本身不验证运行时 JSON。

私有入口只用于私有页面或服务器处理链。首批关于页和登录页保持原有超时、取消、Host 转发及失败空态；完整公开页面依赖扫描随后续接线收口。
