# 本模块给 Agent 的补充规则（packages/domains/<name>/AGENTS.md）

> 可选文件，≤ 60 行。只写本模块特有、根 `AGENTS.md` 没覆盖的规则。平台包写在 `packages/platform/<name>/AGENTS.md`。

- 本模块的核心不变量：……（例：人工下架优先于任何自动结果；暂停以（来源档案 × lane）为粒度）
- 本模块的业务线：`news` / `policy` / 两线共用。**两线共用的模块里，任务、事件、回执都带 `lane`，不得用一条线的状态拦截另一条线。**
- 修改 `src/domain/**` 时：纯函数，不做 IO，必须有单元测试。
- 修改 `src/store/**` 时：只访问 schema `<name>`；连接经注入的 `dbFor(role)` 取得；新查询写明使用的索引。
- 修改 `src/jobs.ts`、任务处理器时：保持幂等键不变；新增重试要有上限；外部失败必须隔离到单条 / 单源；队列名是 `<lane>.<stage>`。
- 修改 `src/routes.ts` 时：公开路由与私有路由分在 `publicRoutes` / `privateRoutes` 两组；改契约先走契约 PR。
- 需要其他模块的数据：先看对方 README 的“公开接口”；没有就提契约 PR，不要自己查对方的表。
- 涉及付费调用：只通过 `@amp/ai-gateway`，并声明记账类别与业务线；任务卡 `budget.model_calls` 默认 0，即只用假模型。
- 涉及信源权限：处理前取 `ProcessingPermit`；全部信源按 Owner 声明许可建档（九项允许，`owner_declared`），权限只用于逐源收紧——没有权限版本记录、或该用途已被逐源收紧时不处理（失败关闭）。
- 本模块的评测（若有）：`pnpm eval <capability> --split development`；改提示词或模型必须附评测对比报告链接（由质量泳道按任务卡声明的评测样本生成）。
- 常见坑：PIT-<三位序号>（列出与本模块相关的坑点编号，写进任务卡 `pitfalls_to_avoid`）。
