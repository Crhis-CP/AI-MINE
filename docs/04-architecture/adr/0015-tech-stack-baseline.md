# ADR-0015：技术栈基线——沿用 AIHOT 主干，只补最小工具集，其余按触发条件引入

- 状态：【设计】工程基线提案（M0 结束前按“栈兼容基准”定稿；精确补丁版本与镜像 digest 在 T-0001 锁定）
- 修订：2026-10-01 按 Owner 答复修订——测试行中“旧仓库 13 份 E2E 规格迁移”改为“按验收场景重新编写，旧规格只作断言参考、不复制”（不从旧仓库导出任何文件，DEC-42）；M1 双 lane 公平基准的“预算耗尽”改“异常熔断或积压”（DEC-08）。
- 类别：工程基线
- 关联：`02-tech-stack.md`（版本表以其为准）、ADR-0014、ADR-0017；对应 B：`B:architecture/03-stack-decisions.md` ADR-N11、ADR-N12、§3“不默认引入的基础设施”、§4“骨架冻结前必须完成的基准”

## 背景

A 包原方案在 M0 一周内引入 pnpm+Turborepo、Biome、dependency-cruiser、Knip、oasdiff、squawk、testcontainers、Playwright+axe、Renovate、lefthook 等 11 项新工具和 14 类门禁；B 包主张“一个包管理器、一份锁文件、确有收益再引编排器”。在不依赖 Actions、由独立执行器逐次运行验证的前提下（ADR-0017），每多一项工具就多一份配置、升级与排障成本，也与 Owner“轻量、不要过度优化”的表达冲突（08-owner-voice OWN-11、OWN-13、ANTI-16）。另外 TypeScript 7.0.2 根入口不再提供旧编译器 API，而 openapi-typescript 7.13.0（最新版）的 peer 依赖仍是 TypeScript ^5.x，不能直接使用；dependency-cruiser 与 TS 7 是否兼容未实测，不作必需（核查日 2026-09-30，见 `02-tech-stack.md` 2.2 与附表 A）。

## 决定

1. **保留 AIHOT 主干**：Node.js 24 LTS（最新补丁，2026-09-30 为 24.21.0）、TypeScript 7（7.0.2，`tsc`）、React 19.3 + React Router 8.4（SSR）、Vite 8、Tailwind 4、Fastify 5.12、Zod 4.6、postgres.js 3.4.9、pg-boss 12、MCP 官方 SDK 2.x、undici + 出网守卫（删去代理分流）、`node:test`、Docker Compose、Caddy 2.11。版本表与核查来源见 `02-tech-stack.md` 附表 A，锁定以 lockfile 为准。
2. **升级与对齐**：PostgreSQL 17 → 18.6；`@types/node` 对齐运行时主版本（24.x，AIHOT 现为 26.6.3 类型跑在 Node 24 上）。Node 24 于 2026-10-20 转入维护期、Node 26 于 2026-10-28 进入 LTS（Node 发布计划，2026-09-30 读取）：首次生产部署前（M1 之前）决定是否直接上 Node 26，若上则在首次部署前完成，T-0001 加 Node 26 全套检查的非阻塞矩阵任务；`engines.node` 写 `>=24.12 <25`（24.12.0 起 TypeScript 类型剥离为稳定特性），`engines`、`.node-version`、Docker 基础镜像（补丁版 + 摘要）、验证回执里的工具版本四处同一版本。
3. **包管理器**：pnpm 12（严格依赖图直接实现模块边界）；一份锁文件，不与 npm 锁文件并存。`package.json` 写 `packageManager`，`pnpm-workspace.yaml` 写 `minimumReleaseAge`（与 Renovate 设置一致）并保持 `allowBuilds` 为空（AIHOT 锁文件里只有仅限 macOS 的 `fsevents` 带安装脚本，首次安装应零放行）；Dockerfile 用“整仓复制 + `pnpm install --prod --frozen-lockfile`”，工作区包保持符号链接，**不用 `pnpm deploy`**（它把包放进 `node_modules/.pnpm`，Node 对该路径下的 `.ts` 拒绝类型剥离；pnpm/pnpm#10602 已于 2026-09-26 关闭但不是已修复，nodejs/node#63853 未合并）；保留 AIHOT 的 `NPM_REGISTRY` 构建参数。Node 26 文档站没有 corepack 页，若上 Node 26，镜像改为显式安装固定版本的 pnpm（未实测）。Turborepo 缓办（触发条件见下表），此前用 `pnpm -r --filter "...[origin/main]"` 做受影响过滤。**回退条件**：T-0001 栈兼容基准里 pnpm 12 与类型剥离或镜像装依赖冲突且无法绕过，退回 npm workspaces + 边界脚本（两份锁文件不并存）。
4. **M0 最小工具集**（全部由 `make verify` 调用）：
   | 项 | 选择 |
   |---|---|
   | 类型检查 | `tsc`（TS 7.0.2）；必须调用旧编译器 API 的工具（openapi-typescript 等）放入独立 `tooling/` 包并固定 TypeScript 5.9.x（满足其 peer 范围）；备选为 `@typescript/typescript6` 别名（`02-tech-stack.md` 2.2） |
   | 格式化与 lint | Biome 2.5 一个工具（不同时引入第二套 lint/格式工具）；配置 `css.parser.tailwindDirectives: true`、`lineWidth` 取 140–160（T-0001 实测）；首次全仓格式化单独成一个提交 |
   | 模块边界 | `package.json` exports 白名单 + pnpm 严格依赖 + 约 50 行的工作区依赖图脚本（只允许 `03-module-map.md` 第 3 节的边）+ Biome `noRestrictedImports` 禁止跨包深路径；dependency-cruiser 不采用 |
   | 契约 | Zod → OpenAPI 3.1 → 客户端生成（生成步骤在 `tooling/` 包），生成物漂移检查；干净克隆上一条命令生成且与已提交版本逐字节一致 |
   | 测试 | Node 内置 `node:test`；集成测试连临时 PostgreSQL（`DATABASE_URL` 必须指向 `*_test` / `*_ci` 库；每个测试文件从已迁移模板库克隆），假模型服务，录制的信源响应；关键读者旅程用 Playwright 1.63 + axe 4.13（M1 起，按验收场景重新编写；旧仓库 13 份 E2E 规格只作断言参考，不复制文件，见 `02-tech-stack.md` 7.4） |
   | 数据库访问类型 | 每个 repository 为对外查询声明 Zod 行 schema 并在边界解析；集成测试断言表列集合与行 schema 一致（改列名必须使对应 repository 测试失败）；**不设 numeric/int8 的全局 Number 解析**：numeric 保持字符串、金额用整数最小单位（微元），int8 用 bigint / 字符串（`02-tech-stack.md` 4.3；AIHOT `db.ts` 的全局 Number 解析不沿用） |
   | 密钥扫描 | trufflehog（沿用旧仓库已用的工具，备选 gitleaks，T-0001 二选一并锁版本）；范围为 PR 差异，`make release-check` 时整棵树 + 镜像层与前端产物，另加项目自定义规则；结果写入验证回执 |
   | 依赖审计 | `pnpm audit --audit-level=high`，高危及以上阻断，允许“仅依赖升级”的 PR 通道；审计接口在执行器网络的可达性 T-0001 实测，不可达改用 osv-scanner |
   | 镜像与 SBOM | 所有基础镜像写“补丁版 + sha256 摘要”（AIHOT 的浮动标签不沿用）；syft 生成 SBOM 写入发布 manifest；镜像基础层用 trivy 或 osv-scanner 扫描（均在 `make release-check`） |
5. **按触发条件再引入**（写明触发条件，未触发不引入）：
   | 工具 | 触发条件 |
   |---|---|
   | Turborepo | 全量 `make verify` 超过 10 分钟 |
   | oasdiff（契约破坏检测） | 公开 API 首次对外发布后 |
   | squawk（迁移静态检查） | 出现第一次 contract 阶段（删除/改名）迁移前 |
   | Knip（死代码） | 资讯线绞杀式拆分完成过半、存量代码开始大量删除时 |
   | Renovate | 首次生产部署后；配置 `minimumReleaseAge`，与 pnpm 设置一致 |
   | lefthook | 可选的本地便利，不作为门禁 |
   | testcontainers | 可选便利层；主路径是指向临时库（它要求 Docker 守护进程） |
   | Playwright 视觉对比 | 读者站视觉回归出现两次以上漏检 |
   | Vitest | 不引入（与 `node:test` 重复）；确需 Vite 插件环境时仅限 `apps/web` 并另立 ADR |
   | MSW | 不引入；沿用 AIHOT 的本地假服务（`tests/setup.ts`） |
   | Vercel AI SDK | M1 不引入：回执与“结果未知”语义依赖对原始请求的完全控制，AIHOT 直接用 `fetch`；触发：基准证明自写适配样板成为维护负担且 SDK 能让出回执层控制，另立 ADR |
   | OpenTelemetry SDK / trace 后端 | 跨进程排障连续两次依赖手工拼日志（ADR-0020）；此前只用 `@opentelemetry/api` 打点、默认不导出 |
6. **pgvector 与嵌入**：M0/M1 镜像为官方 `postgres:18.6-trixie`（补丁版 + 摘要）+ PGDG 的 pgvector（下限 0.8.4——0.8.3、0.8.4 修复 HNSW vacuum 的索引损坏，当前 0.8.6；装上但不建向量索引）；事件召回先用确定性候选 + 有界窗口精确比较 + DeepSeek 判定；是否建 HNSW 由聚簇基准（exact vs ANN）决定。任何嵌入模型供应商都按新付费订阅处理，须基准证明必要并经 Owner 同意（DEC-29）；AIHOT 现有的 DashScope 嵌入默认不启用。备份用的 `pg_dump` 客户端同升 18。
7. **PDF 与扫描件**：PDF 文字层与表格、扫描件 OCR 的选型 spike 放在法规纵向骨架（M0/M1），判据为正文完整、页码与条款号不丢、日期正确、资源可控，**且须与 4GB 主机、20GB 系统盘预算相容**（依赖镜像、模型文件与临时文件都计入磁盘预算，07 §3.4）；默认候选 pdfjs-dist 6.3 / unpdf 1.8（TypeScript 侧）与旧仓库 pypdf 6.19（Python 侧车，基线）对比，mupdf（AGPL）未经法务确认不作默认；回归输入为美国联邦公报 268 页官方 PDF 与旧分支已取得的真实样本；docling / MinerU 只作候选，须通过资源门（不得与 PostgreSQL 同机常驻）；旧分支已实测本机 Tesseract 不合格，不作唯一 OCR 路线；需渲染页面的浏览器默认关闭、按源开启，4GB 主机不常驻 Chromium（细节与证据见 `02-tech-stack.md` 4.6）。
8. **不引入**：Redis、Kafka、Elasticsearch/OpenSearch、独立向量库、图数据库、Kubernetes、Temporal 等独立工作流引擎、独立 LLM 网关服务、生产路径上的 Agent 框架、常驻 OTel collector 与重型监控栈（观测见 ADR-0020）、出网代理与境外采集节点（ADR-0019）。新增组件必须说明解决的已观察问题、替代接口、失效与回退、运维负担。B 包“明确不默认引入的基础设施”及其“重新考虑的证据”见 `02-tech-stack.md` 8.4。
9. 中文检索首期沿用 AIHOT 的 pg_trgm 窄表方案；M2 用真实查询评测 pg_bigm 与 pg_search（后者需确认 AGPL 义务）。

## 必须完成的基准（按里程碑；方法与产物照搬 B:architecture/03-stack-decisions.md §4）

| 里程碑 | 基准 | 任务与验收 |
|---|---|---|
| M0 | **栈兼容基准**：干净环境装锁文件 → 类型检查 → 生成客户端且与已提交版本逐字节一致 → 迁移 → 跑 AIHOT 原测试；同时跑 Node 26 非阻塞矩阵、在实际执行器网络上试 `pnpm audit` | T-0001；基准结论决定本 ADR 的最终版本与回退条件 |
| M0 | **环境与容量基准**：数据增长、查询、用 COS 试前缀级权限与 S3 兼容客户端、目标区域对境外目标的可达性基线 | T-0013；结论写入 ADR-0012（决定部署规格，DEC-18）；AC-OPS-13 |
| M1 | **双 lane 公平基准**：新闻突发 + 法规回填 + 慢 90 秒抓取 + 大 PDF + 供应商 429 同时存在时，每个 lane×stage 的最大等待与保留并发是否有效；单一业务线的异常熔断或积压不阻塞另一条 | T-0614（M1 验收项）；验收场景 T-137；基准结论补入本 ADR；M0 只搭它所需的骨架（两个 api 实例、fetcher 进程、按角色连接） |
| M1 | **Agent 独立开发试点**（三泳道试点：`web` 拿 mock、`sources` 拿来源端口、`policy` 拿文书契约） | T-0621 |
| 随能力实现 | 聚簇（exact vs ANN）、付费恢复、发布/撤回 | 在对应能力的任务中完成，结论补入本 ADR；路线图未单列，不阻塞 M0 退出 |

## 备选方案

| 方案 | 为什么没选 |
|---|---|
| 换成 Next.js / TanStack Start | AIHOT 的页面与交互基于 React Router，换框架没有业务收益 |
| 换成 Drizzle / Prisma | Drizzle 1.0 未 GA；Prisma 处于 7→8 换代；AIHOT 的 SQL 优先写法已经足够透明 |
| 继续用 npm workspaces | 可行，但不能把模块边界落到依赖图上；pnpm 一次切换即可获得严格依赖 |
| A 包原方案：M0 引入 11 项工具 | 配置与排障成本集中在最不产生产品价值的阶段，违背“轻量” |
| dependency-cruiser 做边界检查（A 包原方案） | TS 7 下是否可用未实测，且被 exports 白名单 + pnpm 严格依赖 + 依赖图脚本取代；等 TS 7.1 或改 swc 解析器后可重评（未实测） |
| testcontainers + Vitest 作为测试主路径（A 包原方案） | 绑定 Docker 守护进程并造成双测试运行器；AIHOT 已在用的 `DATABASE_URL` 临时库 + `node:test` 在 Mac、服务容器、独立执行器上都能跑 |
| 用 Vercel AI SDK 做协议适配 | 回执与“结果未知”语义需要对原始请求的完全控制，AIHOT 直接用 `fetch`；只省少量样板，增加依赖与升级面 |
| 依赖 GitHub Actions 构建镜像、跑检查（A 包原方案） | 【Owner 决定】旧ADR-0038 已停用并不默认重开；改为 ADR-0017 的统一验证入口与可替换执行器 |
