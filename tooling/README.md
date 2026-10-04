# 契约生成

运行 `pnpm contracts:gen` 生成，`pnpm contracts:check` 校验受管文件全集、类型和已迁移路由。TypeScript 5.9.3 仅留在本工具包；业务仍用 TS7。生成器只读 contracts，不启动业务、数据库或监听端口。

首批接入 `/api/site/stats` 和私有 `/api/auth/options`，供现有关于页、登录页使用；其余响应和手写 v1 OpenAPI 尚未迁移，不代表 TASK-0005 完成。公共和私有 registry、文档及客户端入口独立。生成物包括 manifest 哈希，不手改；原始 Zod schema、operationId 与路径位于 contracts/http。
