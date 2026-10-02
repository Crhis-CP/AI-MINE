# ADR-0013：前端只经由生成的类型化客户端访问后端

- 状态：【设计】工程基线提案；契约唯一链路“Zod → OpenAPI 3.1 → api-client / mock”按裁决 DEC-31
- 类别：工程基线
- 关联：`03-data/contracts/`、ADR-0002；对应 B：`B:architecture/03-stack-decisions.md` ADR-N02、ADR-N03（B 的 `openapi.json` 作为首版输入一次性转写为 Zod，此后不再手工维护）

## 决定

1. **唯一链路**：公开与私有接口的 schema 定义在 `packages/contracts`（Zod，唯一事实源），由此生成 OpenAPI 3.1 文档（公开部分对外为 `/openapi-v3.json`，私有部分不对外；均不手写）、两个客户端（公开客户端与私有客户端，`packages/api-client` 下分两个入口）与契约 mock。生成步骤放在独立的 `tooling/` 包（固定 TypeScript 5.9.x，因 openapi-typescript 与 TypeScript 7 不兼容，见 `02-tech-stack.md` 2.2）；生成物提交到仓库。B 包的 `openapi.json` 与 `examples.json` 只作**首版输入**，一次性转写为 Zod（`03-data/contracts/README.md`），此后不再手工维护；不得同时维护手写 OpenAPI、TS interface、Zod 三套不比对的定义。
2. `apps/web` 只能依赖 `api-client`、`ui` 与契约类型；禁止依赖任何业务模块、平台包、数据库、模型 SDK 或服务端内核。SSR loader 同样遵守。
3. 公开路由组只能 import 公开客户端；私有客户端只能在私有路由组中使用（边界脚本检查），保证私有接口类型与代码不进入公开页面包。
4. **漂移与破坏性变更检查不依赖 GitHub Actions**（旧ADR-0038，ADR-0017）：统一验证入口 `make verify` 在干净克隆上一条命令（`pnpm contracts:gen`）生成 OpenAPI 与 `api-client`，要求与已提交版本逐字节一致，并回放契约示例；变更按“追加/弃用/破坏”三级协议审批（ADR-0002 第 4 条）；破坏性变更检测工具（oasdiff）在公开 API 首次对外发布后引入，同样作为 `make verify` 的一个阶段，不绑定任何托管 CI 平台（ADR-0015 触发条件表）。

## 后果

前后端 Agent 可以围绕契约并行开发；接口变化在编译期暴露；私有页面不会把私有接口泄漏到公开包。
