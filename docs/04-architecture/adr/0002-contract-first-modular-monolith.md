# ADR-0002：契约优先的模块化单体（12 个业务模块 + 平台包，四类应用进程）

- 状态：【设计】工程基线提案（交接包基线；M0 结束前由架构 Agent 按基准结果定稿）。其中“不设运营台应用”为【Owner 决定】（旧ADR-0037:21，2026-09-26，见 ADR-0018）；进程拓扑按裁决 DEC-30。
- 修订：2026-10-01 按 Owner 答复修订——背景中的部署规格措辞同步 DEC-18（规格已定：先做容量基准，达标沿用已购 4C4G）；决定条款不变。
- 类别：工程基线
- 关联：`01-target-architecture.md`、`03-module-map.md`、`06-agents/01-parallel-development-rules.md`；对应 B：`B:architecture/03-stack-decisions.md` ADR-N01（替代方案与推翻条件已并入本文）

## 背景

新项目默认由多个高能力 Agent 并行开发。并行的瓶颈不是算力，而是边界是否清晰、契约是否稳定。首期部署在中国大陆的单台主机（规格【Owner 决定】2026-10-01：先做容量基准，达标沿用已购 4C4G，DEC-18；这是全新重写的项目）与一个 PostgreSQL。A 包原方案的“四进程含独立运营台应用 admin-web、16 个模块”与 Owner 2026-09-26 的“不设运营台”冲突，模块粒度对“1 位 Owner + 按需开 Agent”也偏细。

## 决定

1. 一个仓库、一个数据库、四类应用进程：
   - `web`（`apps/web`，裁决表称 reader-web）：读者站 SSR + 需登录的私有页面路由组（只在 `PRIVATE_HOST` 的私有路径上可达（生产即主域名的 `/admin`，ADR-0026））；
   - `api`（`apps/api`）：同一镜像按角色启动两个实例——`public-api` 只注册公开路由，`private-api` 只注册私有路由；
   - `worker`（`apps/worker`）：全部任务、定时器、资讯线与法规线的 lane×stage 调度（ADR-0016）；
   - `fetcher`（`apps/fetcher`）：独立的抓取与解析隔离进程，无主库凭据、无模型密钥（ADR-0019）。
2. 业务拆成 12 个模块（`packages/domains/*`）：sources、acquisition、content、enrichment、entities、events、policy、editorial、publication、reports、ai-gateway、feedback；平台包（`packages/platform/*`）：identity（含审计）、ops、queue、storage、config、telemetry。模块名是规范名，写死、不许别名。完整表与依赖层级见 `03-module-map.md`。
3. 模块间只通过：公开查询/命令函数、领域事件、任务载荷、HTTP 契约交互；依赖方向按 `03-module-map.md` 第 3 节的层级表，由统一验证入口（`make verify`）强制。
4. 契约集中在 `packages/contracts`（Zod → OpenAPI 3.1、任务与事件 schema；DEC-31，链路见 ADR-0013；生成步骤放在独立的 `tooling/` 包，它不属业务模块、不被任何应用或模块依赖，`03-module-map.md` 第 1、3 节），变更遵循“追加/弃用/破坏”三级协议：模块契约由模块泳道提交，追加类可自行合并；弃用与破坏须架构角色批准；公共类型（ID、时间、错误体、分页）、根配置与锁文件由单一集成角色维护。
5. 这是**目标形态**。到达方式是按业务线分治的渐进拆分（`03-module-map.md` 第 9 节）：M0 不做一次性“16 包机械拆分”。

## 后果

- 每个模块可以由一个 Agent 独立负责，一条泳道可负责 1–3 个模块，不要求一模块一 Agent；
- 模块日后可以独立进程化；
- 边界检查只保留最小集（exports 白名单、pnpm 严格依赖、依赖图脚本、禁止跨包深路径、按角色凭据校验），不维护重型规则工具链。

## 备选方案与推翻条件

| 方案 | 为什么没选 |
|---|---|
| 微服务 | 单机资源与运维成本不允许，收益主要是网络边界，而我们需要的是代码与数据边界 |
| 保持 AIHOT 单一 backend 包 | 边界靠约定，多 Agent 并行时冲突与越界难以阻止 |
| A 包原方案：reader-web + admin-web 双前端、16 模块 | 独立运营台违背 Owner 决定；feedback/site/ops 等小模块单列 schema 与泳道收益有限 |

推翻条件：某模块出现独立可用性/扩容/发布要求，且进程级隔离仍无法满足，并有测量与故障演练证据时，再把它提取为独立服务（B:ADR-N01 的否决条件）。
