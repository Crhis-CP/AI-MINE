# 技术选型（2026 年 9 月）

> **状态**：【设计】工程基线提案（ADR-0015；M0 结束前按“栈兼容基准”定稿，精确补丁版本与镜像摘要在 T-0001 锁定）。下列三项是【Owner 决定】，本文不改：默认模型供应商为 DeepSeek（`01-product/08-owner-voice.md` DEC-10，2026-09-05；裁决 DEC-29）；验证与交付不依赖 GitHub Actions（旧ADR-0038:15-40@policy，Owner 2026-09-26；ADR-0017；裁决 DEC-17）；部署区域为中国大陆（`01-product/08-owner-voice.md` DEC-02，2026-07-22；裁决 DEC-18）。另有两项已由 Owner 2026-10-01 答复：部署规格先做容量基准、达标沿用已购 4C4G（DEC-18），告警渠道已定（DEC-06），2026-10-06 改为飞书自建应用，照上游原样，只发飞书，不做邮件备用（08-owner-voice DEC-33）。
> **修订（2026-10-01 按 Owner 答复）**：费用与额度表述改为“不设月度金额上限、不浪费、异常熔断”（DEC-08；4.3、5.1、5.2 节）；E2E 不复制旧仓库规格文件（DEC-42；7.4 节）；切换前的旧库备份改为“存档、不导入”（DEC-20；8.3 节）；精选与热点沿用 AIHOT（DEC-64；5.3 节）；部署规格与告警渠道措辞改为已定（8.1、8.2 节）；**追加（2026-10-01）**：异常熔断前有 70% 预警（4.3、5.1 节）；矿业版评分标准是草案，须经 Owner 审阅确认（5.3 节）。
> **版本核查**：2026-09-30 重新联网核查（npm registry、PyPI、GitHub Releases、PostgreSQL 官网、Node 发布计划、Docker Hub、DeepSeek 价格页；来源与方式见附表 A）。版本每天前进，本文是快照：**T-0001 用 lockfile 重新解析并以 lockfile 为准，主版本不变、补丁可前进**；pnpm 默认要求依赖发布满 1 天，当日发布的版本装不上时取上一个版本。带 † 的版本沿用 A 包与首轮核查记录，本轮未逐项复核；未能核实的项目明确标“未核实”，汇总在第 10 节。
> **“AIHOT 现用”** 取自固定快照的 `AIHOT:package.json`、`AIHOT:apps/*/package.json`、`AIHOT:packages/*/package.json`、`AIHOT:Dockerfile`、`AIHOT:docker-compose.yml`。
> **选型原则**：以 AIHOT 现有栈为基线（它本身已是 2026 年主流版本），只在有已观察的问题或明确收益时替换或新增；每多一项工具就多一份配置、升级与排障成本（Owner 要求轻量，`01-product/08-owner-voice.md` OWN-11、OWN-13、ANTI-16）；首期必须能在一台 4 核 4GB 的主机上稳定运行；对多 Agent 并行友好（边界可检查、类型可生成、测试可隔离）。

---

## 0. 结论

| # | 结论 | 状态与依据 |
|---|---|---|
| 1 | **主干沿用 AIHOT**：Node 24、TypeScript 7、React 19 + React Router 8（SSR）、Vite 8、Tailwind 4、Fastify 5、Zod 4、postgres.js、pg-boss 12、undici + 出网守卫、`node:test`、Caddy + Docker Compose。不因“2026 年应该有”换栈 | 【设计】ADR-0001、ADR-0015 |
| 2 | **只有三处替换**：PostgreSQL 17 → 18.6；npm workspaces → pnpm 12；`@types/node` 与运行时对齐（AIHOT 现为 26 的类型跑在 Node 24 上）。另有两处改造：迁移脚本（全局编号 → 按模块、时间戳命名）、`db.ts` 的 numeric/int8 解析 | 【设计】第 9 节逐项核算替换成本，成本不值得的已改回沿用 |
| 3 | **新增只保留最小集**：Biome、Zod → OpenAPI → 客户端生成链、Playwright + axe、pgvector（装上不建索引）、对象存储端口、独立 fetcher、密钥扫描 / 依赖审计 / SBOM、Argon2id 密码哈希（Node 内置，无新依赖） | 【设计】第 1 节 |
| 4 | **缓办到触发条件满足**：Turborepo、oasdiff、squawk、Knip、Renovate、lefthook、OpenTelemetry SDK 与 trace 后端、pgBackRest / WAL-G、pg_bigm / pg_search、DBOS | 第 7.1 节触发条件表 |
| 5 | **不采用**：dependency-cruiser、Vitest、MSW、Vercel AI SDK（M1）、生产 Agent 框架、Redis / Kafka / Elasticsearch 等（第 8.4 节）、出网代理与境外采集节点 | 第 9 节 |
| 6 | **TypeScript 7 与 openapi-typescript 不兼容**：TS 7.0.2 根入口没有旧编译器 API，openapi-typescript 最新版仍要求 TypeScript ^5.x。`tsc` 继续用 7.0.2，生成步骤放进独立 `tooling/` 包并固定 TypeScript 5.9.x | 第 2.2 节；T-0004 验收加“一条命令生成，且与已提交版本逐字节一致” |
| 7 | **不依赖 GitHub Actions**：统一验证入口 `make verify` / `make release-check`，执行者可替换，不得是生产主机；镜像按摘要锁定 | 【Owner 决定】ADR-0017；第 7.3、8 节 |
| 8 | **模型供应商只有 DeepSeek**；通义等全部是待评测候选；任何新供应商（含 embedding）按新付费订阅处理，须基准证明必要并经 Owner 同意 | 【Owner 决定】DEC-29；第 5 节 |
| 9 | **PDF 文字层、表格、扫描件、页面渲染原来没人选型**：选型 spike 前移到法规纵向骨架（M0/M1），候选、判据与资源门见第 4.6 节 | 【设计】 |
| 10 | 主机规格已由 Owner 2026-10-01 定（DEC-18：先做容量基准，达标沿用 4C4G）；技术栈层面需要 Owner 知情的只有：腾讯云 COS 备份桶与镜像仓库是否已开通（默认按“没有”）、飞书提醒的应用凭据与群号（告警渠道 2026-10-06 改为飞书自建应用，只发飞书，DEC-06；经安全录入写进服务器设置）、境外采集节点（默认不设） | 第 10 节；`08-open-questions.md` |

---

## 1. 技术栈总表（相对 AIHOT 的处置）

### 1.1 读表说明

| 处置 | 含义 |
|---|---|
| 沿用 | AIHOT 现用，原样保留（补丁版本可升） |
| 升级 | 同一产品换到更新的主版本 |
| 替换 | 换掉 AIHOT 的做法 |
| 改造 | 保留 AIHOT 的代码骨架，改写关键部分 |
| 新增 | AIHOT 没有，首期引入 |
| 缓办 | 暂不引入；写明触发条件，触发后才引入 |
| 不采用 | 评估后不引入，写明理由 |
| 待评估 | 需要真实样本或基准后才能定 |

表中“AIHOT 现用 → 本包起点”一栏，箭头左边是 AIHOT 固定快照里锁定的版本，右边是 2026-09-30 的最新稳定版（T-0001 以 lockfile 为准）。

### 1.2 总表

#### 运行时、语言与工作区

| 层 | 选型 | AIHOT 现用 → 本包起点 | 处置 | 理由 / 触发条件 |
|---|---|---|---|---|
| 运行时 | Node.js 24 | `engines >=24.11`，镜像 `node:24-trixie-slim` → 24.21.0（2026-09-07） | 沿用 | 直接运行 TypeScript，后端无构建步骤。24 于 2026-10-20 转入维护期，26 于 2026-10-28 进入 LTS，首次生产部署前决定是否直接上 26（2.1） |
| 语言 | TypeScript 7 | 7.0.2 → 7.0.2（2026-07-08，最新） | 沿用 | 只给 `tsc`、`react-router typegen`、Vite、Biome 用；要调旧编译器 API 的工具见 2.2 |
| Node 类型 | `@types/node` 24.x | 26.6.3（类型按 26、运行在 24）→ 24.19.0 | 替换（修正） | 类型必须与运行时主版本一致，否则新 API 通过类型检查、到运行时才缺失 |
| 包管理与工作区 | pnpm 12（一份 `pnpm-lock.yaml`） | npm workspaces（`package-lock.json`，约 400 个包）→ 12.8.1 | 替换 | 严格依赖图直接实现模块边界：npm 会把所有工作区包链进根 `node_modules`，未声明的依赖也能 import，pnpm 会直接失败；旧仓库已有 pnpm + corepack 经验（`.tool-versions:2@main` 为 pnpm 10.20.0）。不再以“受影响任务计算”为理由 |
| 任务编排 | Turborepo | 无 → 2.11.5 | 缓办 | 触发：全量 `make verify` 超过 10 分钟。此前用 `pnpm -r --filter "...[origin/main]"` 做受影响过滤 |
| Python | 不作主语言 | 无 | 缓办 | 仅当 PDF spike 选中 Python 侧车时，以独立小容器引入并经 ADR（4.6） |

#### 前端与最小私有页面

| 层 | 选型 | AIHOT 现用 → 本包起点 | 处置 | 理由 / 触发条件 |
|---|---|---|---|---|
| 前端框架 | React 19 + React Router 8（框架模式，SSR） | react / react-dom 19.3.0、react-router / @react-router/node / @react-router/dev 8.4.0 → 同 | 沿用 | 读者站与最小私有页面同属 `apps/web`，私有页面是需登录的路由组（ADR-0018），不另起前端应用 |
| 构建与样式 | Vite 8 + Tailwind CSS 4（`@tailwindcss/vite`） | 8.3.1；4.3.3 → 同 | 沿用 | 设计令牌集中在 `packages/ui` |
| 爬虫识别 | isbot | 5.2.2 → 5.2.2 | 沿用 | SSR 对爬虫的处理 |
| 动画库 | motion | 13.4.4（只有 AIHOT 后台用）→ 不带入 | 不采用 | 读者站与最小私有页面都不用动画库；删除 AIHOT 后台壳时一并移除 |
| 无障碍组件底座 | Base UI（按需） | 无 → 1.8.0 | 新增（按需） | 出现对话框、菜单、组合框时引入，样式自己写；不引入整套组件库 |
| 密码哈希 | Argon2id，Node 内置 `crypto.argon2`（Node ≥24.7.0） | 无哈希库：AIHOT 单管理员口令做 HMAC 比较（`AIHOT:packages/backend/src/admin/auth.ts:144-150`） | 新增 | 具名多账号必须有口令哈希（DEC-05）；用内置实现，不引入需要编译的原生依赖（pnpm 默认会拦下带安装脚本的新依赖） |

#### 服务端与契约

| 层 | 选型 | AIHOT 现用 → 本包起点 | 处置 | 理由 / 触发条件 |
|---|---|---|---|---|
| HTTP 服务 | Fastify 5（内置 pino 日志） | 5.12.5 → 5.12.5；6.0 仍为 alpha（6.0.0-alpha.4） | 沿用 | 不追 alpha；日志用 Fastify 内置 pino（`AIHOT:apps/api/src/app.ts:21`），不另加日志库 |
| Schema 与校验 | Zod 4 | 4.6.5 → 4.6.5 | 沿用并扩大 | 契约、任务载荷、事件、配置文件、模型输出、repository 行 schema 统一用 |
| OpenAPI 生成 | fastify-type-provider-zod 7 + @fastify/swagger 9.9 | 无 → 7.0.0 + 9.9.1 | 新增 | Zod 是唯一源（DEC-31）→ OpenAPI 3.1 → 客户端；7.0.0 要求 zod ≥4.1.5、fastify ^5.5 |
| 前端客户端生成 | openapi-typescript 7 + openapi-fetch | 无 → 7.13.0 + 0.17.0 | 新增 | 只生成类型、运行时极小；前端只能经它取数（ADR-0013）；须按 2.2 处理 TS 7 |
| 契约破坏检测 | oasdiff | 无 → v1.32.1 | 缓办 | 触发：公开 API 首次对外发布（此前没有可比对的基线）。此前靠“生成物提交 + 漂移检查” |
| MCP | 官方 TypeScript SDK（server；client 只给检查脚本） | 2.1.0 → 2.2.0 | 沿用 | AIHOT 已提供公开只读 MCP 出口；另有面向开发 Agent 的只读运维 MCP（`01-target-architecture.md` 第 10 节） |
| 出网 HTTP | undici + 自有守卫 | undici 8.11.2 → 8.11.2 | 沿用（删去代理分流） | 4.6 |

#### 数据

| 层 | 选型 | AIHOT 现用 → 本包起点 | 处置 | 理由 / 触发条件 |
|---|---|---|---|---|
| 数据库 | PostgreSQL 18 | 17（`postgres:17-alpine`）→ 18.6（2026-08-13†；支持到 2030-11-14） | 升级 | 新库从空库开始（旧站数据一概不导入，DEC-20），无迁移成本；PG 19 仍为 beta，不上生产；备份用的 `pg_dump` 客户端必须同升 18（4.2） |
| 向量扩展 | pgvector（装上，不建向量索引） | 无：向量存 `real[]`，在有界窗口内精确比较 → 0.8.6 | 新增（仅安装） | 下限 0.8.4（0.8.3、0.8.4 修复 HNSW vacuum 的索引损坏）；是否建 HNSW 由聚簇基准（精确 vs ANN）决定 |
| 中文检索 | pg_trgm + 窄表 | 同 | 沿用 | M2 用真实中文查询评测 pg_bigm 与 pg_search（4.2） |
| 数据库访问 | postgres.js（SQL 优先）+ Zod 行 schema | 3.4.9 → 3.4.9 | 沿用 + 改造 | 不设 numeric/int8 的全局 Number 解析（4.3） |
| 迁移 | 纯 SQL，按模块目录、UTC 时间戳命名、依赖声明 | `scripts/migrate.ts`，全局编号 | 改造 | ADR-0003 |
| 迁移检查 | squawk | 无 → 2.66.0 | 缓办 | 触发：出现第一次 contract 阶段（删除/改名）迁移之前 |
| 任务队列 | pg-boss 12 | 12.34.0 → 12.35.1 | 沿用 | 队列按 `<lane>.<stage>`；保留同事务入队适配器（`AIHOT:packages/backend/src/jobs/queue.ts:80-88`） |
| 领域事件 | PostgreSQL outbox / inbox | 无 | 新增 | ADR-0005 |
| 缓存 | HTTP 缓存（ETag 用不透明的 `content_version`）+ 进程内有界 LRU | `lib/cache.ts` | 沿用 | 首期不引入 Redis；下架即时生效，公开响应不设长缓存（DEC-48） |
| 对象存储 | 腾讯云 COS（S3 兼容接口），经 `platform/storage` 端口；开发与测试用本地目录 | 本地数据卷 | 新增 | 法规线要按修订保存官方原件与附件（多为 PDF），不能放进数据库（ADR-0005）；COS 在旧仓库没有创建与演练证据，按未就绪处理（4.5） |

#### 抓取与文档解析

| 层 | 选型 | AIHOT 现用 → 本包起点 | 处置 | 理由 / 触发条件 |
|---|---|---|---|---|
| 抓取进程 | 独立 fetcher（同镜像、不同启动命令） | 无：抓取在 worker 内 | 新增 | 网络与恶意输入隔离；无主库凭据、无模型密钥（ADR-0019，DEC-30） |
| HTML / RSS 抽取 | cheerio、linkedom、@mozilla/readability、turndown、sanitize-html、fast-xml-parser | 1.2.0、0.18.13、0.6.0、7.2.4、2.17.7、5.11.1 → 1.2.0、0.18.13、0.6.0、7.2.4、2.18.0、5.11.2 | 沿用 | 纯 DOM 抽取，不新增浏览器依赖 |
| PDF 文字层 | 待评估：pdfjs-dist / unpdf / Python 侧车 pypdf | 无（AIHOT 没有任何 PDF 依赖） | 新增（M0/M1 spike） | 候选、判据、回归输入见 4.6 |
| 表格、版式、扫描件 | docling / MinerU 只作候选，须过资源门 | 无 | 缓办 | 本机 Tesseract 已被旧分支实测判为不合格（4.6） |
| 需渲染的页面 | 浏览器渲染默认关闭，按源开启，受限子进程 | 付费 Jina 阅读器兜底 | 缓办 | 4GB 主机不常驻 Chromium（BR-ACQ-24） |
| 分享图 | sharp、satori、@resvg/resvg-js、uqr | 0.35.4、0.33.5、2.6.2、0.1.3 → 0.35.5、0.33.5、2.6.2、0.1.3 | 沿用 | 中文字体用 AIHOT 自带 Noto Sans SC（OFL） |

#### AI 层

| 层 | 选型 | AIHOT 现用 → 本包起点 | 处置 | 理由 / 触发条件 |
|---|---|---|---|---|
| 模型网关 | 自有 `ai-gateway`（OpenAI 兼容协议，直接 `fetch`） | `providers/llm.ts`、`receipts.ts` | 改造 | 回执、用量账本与熔断、缓存、许可必须自己掌控（ADR-0006） |
| 默认模型 | DeepSeek `deepseek-flash` | AIHOT 与旧项目均在用 | 沿用 | 【Owner 决定】DEC-29；价格见 5.2 |
| 协议适配库 | Vercel AI SDK | 无 → ai 7.0.126 | 不采用（M1） | 回执与“结果未知”语义依赖对原始请求的完全控制；AIHOT 直接用 `fetch`（`AIHOT:packages/backend/src/providers/llm.ts:199`） |
| 嵌入模型 | 不默认启用 | DashScope `text-embedding-v4`，1024 维（`AIHOT:packages/backend/src/providers/embeddings.ts:3,11`） | 缓办 | DEC-29：任何新供应商（含 embedding）按新付费订阅处理，须基准证明必要并经 Owner 同意 |
| Agent 框架 | 生产路径不用 | 无 | 不采用 | DEC-16；5.1 |

#### 测试与质量

| 层 | 选型 | AIHOT 现用 → 本包起点 | 处置 | 理由 / 触发条件 |
|---|---|---|---|---|
| 单元与集成测试 | `node:test` + 一次性临时库（`DATABASE_URL` 指向 `*_test` / `*_ci`）+ 本地假服务 | 同：35 个 `tests/*.test.ts` + `setup.ts`（约 4,100 行，串行） | 沿用 | 每个测试文件从已迁移的模板库克隆，去掉 `--test-concurrency=1`（7.4） |
| 集成测试容器 | testcontainers | 无 → 12.2.0 | 缓办（可选便利层） | 它把“能否跑集成测试”绑在 Docker 守护进程上；主路径是指向临时库的 `DATABASE_URL`，在 Mac、服务容器、独立执行器上都能用 |
| 前端组件测试 | `node:test` + happy-dom，或 Playwright | web 已有 5 个 `node:test` 测试 | 沿用 | 不引入第二套运行器 |
| Vitest | — | 无 → 5.0.3 | 不采用 | 与 `node:test` 重复（B:architecture/03-stack-decisions.md ADR-N12）；确需 Vite 插件环境时仅限 `apps/web`，另立 ADR |
| HTTP 模拟 | AIHOT 本地假服务 | `tests/setup.ts` 起的本地 http stub | 沿用 | MSW 3.0.1 不采用：多一套模拟机制 |
| 端到端 | Playwright + @axe-core/playwright | 无（只有 `scripts/smoke.ts`）→ 1.63.0 + 4.13.0 | 新增 | 桌面与手机双视口、无障碍检查；旧仓库 13 份 Playwright 规格只作断言参考、不复制（7.4） |
| 格式化与 lint | Biome 2 | 无 → 2.5.15 | 新增 | 一个工具完成格式化与 lint，不同时引入第二套（7.1 写明配置） |
| 模块边界 | `package.json` exports 白名单 + pnpm 严格依赖 + 工作区依赖图脚本 + Biome `noRestrictedImports` | 无 | 新增（自有脚本，约 50 行） | 取代 dependency-cruiser（7.1） |
| dependency-cruiser | — | 无 → 18.5.0 | 不采用 | 与 TS 7 是否兼容未实测，且已被上一行取代 |
| 死代码 | Knip | 无 → 6.39.0 | 缓办 | 触发：资讯线绞杀式拆分完成过半、存量代码开始大量删除时 |
| 依赖升级 | Renovate | 无 → 44.126.0 | 缓办 | 触发：首次生产部署后；`minimumReleaseAge` 与 pnpm 设置一致 |
| Git 钩子 | lefthook | 无 → 2.1.15 | 缓办（可选） | 本地便利，不作门禁 |

#### 供应链与安全检查

| 层 | 选型 | AIHOT 现用 → 本包起点 | 处置 | 理由 / 触发条件 |
|---|---|---|---|---|
| 密钥扫描 | trufflehog（备选 gitleaks） | 无 → v3.97.9（旧仓库 v3.90.11） | 新增 | 在 `make verify` 内运行，不是某个平台的 Action 步骤（7.2） |
| 依赖审计 | `pnpm audit --audit-level=high` | 无 | 新增 | 在 `make verify` 内运行；审计接口在执行器网络的可达性待实测（7.2） |
| 镜像扫描 | trivy 或 osv-scanner（T-0001 二选一） | 无 → v0.74.0 / v2.6.0 | 新增 | 在 `make release-check` 内扫镜像基础层 |
| SBOM | syft | 无 → v1.52.0 | 新增 | 产物写入发布 manifest（ADR-0017 第 5 条；旧ADR-0038:33-36@policy） |

#### 部署与运维

| 层 | 选型 | AIHOT 现用 → 本包起点 | 处置 | 理由 / 触发条件 |
|---|---|---|---|---|
| 反向代理 | Caddy 2.11 | `caddy:2-alpine`（浮动标签）→ 2.11.4-alpine，按摘要锁定 | 沿用（改锁摘要） | 所有镜像写“补丁版 + sha256 摘要”（4.2）；旧仓库已这样锁（`infra/tencent-cloud/compose.production.yaml:359@main`，2.11.2） |
| 容器编排 | Docker Compose | 同 | 沿用 | 服务清单见 ADR-0012；没有运营台容器 |
| 镜像构建 | 独立构建执行器；不用 GitHub Actions | `Dockerfile`（`npm ci`） | 改造 | ADR-0017；8 |
| 镜像仓库 | 腾讯云容器镜像服务（TCR） | 无 | 新增 | 国内可稳定拉取；是否已开通由 Owner 确认（10） |
| 备份 | custom dump（`pg_dump` 客户端 18）+ age 客户端加密 → 私有、版本化的 COS 独立桶；默认保留 7 日 + 4 周 | 无（镜像内只带可选的 `pg_dump`） | 新增 | COS 在旧仓库没有创建与演练证据，按未就绪处理（`07-deployment-and-ops.md` 第 1 节、4.5）；时间点恢复（pgBackRest 2.59.2 / WAL-G 3.0.9）只是升级选项，触发条件见 `07-deployment-and-ops.md` 5.1（数据库 >12GB、恢复 >2 小时或 Owner 提高要求） |
| 告警推送 | 飞书自建应用，照上游原样，只发飞书，不做邮件备用（Owner 2026-10-06，08-owner-voice DEC-33） | `notify/feishu.ts`、`notify/deliver.ts` | 照上游 | DEC-06；告警随首次生产部署上线（8.2） |
| 外部拨测 | 腾讯云云监控 + 与生产不同机的拨测 | 无 | 新增 | 应用停摆时内部告警也会停，必须有独立于应用的探针（8.2） |
| 日志与追踪 | 结构化 JSON 日志 + 业务运行记录入库；`@opentelemetry/api` 只打点、默认不导出 | Fastify 内置 pino | 沿用 + 新增打点 | ADR-0020 |
| OTel SDK / collector / trace 后端 | — | 无 | 缓办 | 触发：跨进程排障连续两次依赖手工拼日志（ADR-0020） |
| 错误追踪 | Bugsink 2.6.1† | 无 | 缓办 | 告警 + 死信已覆盖首期；需要时自托管。Sentry SaaS 在大陆可达性不稳定（A 包判断，未核实） |

### 1.3 AIHOT 其余依赖的处置

| 依赖 | AIHOT 用途 | 处置 |
|---|---|---|
| `@paralleldrive/cuid2` 3.3.0 | 文章 ID（`lib/ids.ts`）、模型榜 | 待评估：新 ID 规则见 `05-engineering-conventions.md` 第 6 节（前缀 + 可按时间排序的随机串）；生成方式（PostgreSQL 18 `uuidv7()`，或应用侧 UUIDv7 / ULID 小实现）随数据库基线（T-0005）选定，不强制沿用 cuid2 |
| `highs` 1.15.3、`hyparquet` 1.31.1 | 只有模型榜（共识算法、数据集读取）用 | 随模型榜删除（`04-aihot-adoption.md` 第 4.1 节） |
| `opentype.js` 1.3.4 | 只在 `scripts/nameplates.ts` 生成报头字 | 随该脚本去留；按新站名重新生成报头字时才需要，只留开发依赖 |
| `@types/sanitize-html`、`@types/turndown`、`@types/react`、`@types/react-dom` | 类型 | 沿用 |
| `motion` | 只有 AIHOT 后台用 | 不带入（见前端表） |

---

## 2. 运行时与语言

### 2.1 Node 版本策略

| 日期 | 事件 | 来源 |
|---|---|---|
| 2025-10-28 | Node 24 进入 LTS | Node 发布计划 |
| 2026-10-20 | Node 24 转入维护期；支持到 2028-04-30 | 同上 |
| 2026-10-28 | Node 26 进入 LTS；维护期 2027-10-20；支持到 2029-04-30 | 同上 |

1. **开发与 M0 用 Node 24.x 最新补丁**（2026-09-30 为 24.21.0）。
2. T-0001 加一个**非阻塞矩阵任务**：用 Node 26 跑全套 `make verify`。
3. **第一次生产部署前（M1 之前）决定是否直接上 Node 26**；若上，在首次部署前完成，不留到上线后。决定依据是矩阵结果、依赖的 `engines`（react-router 8.4.0 要求 node ≥22.22，pg-boss 12.35.1 要求 ≥22.12，均满足 24 与 26）和下面第 6 条 corepack 的差异。
4. `engines.node` 写范围 `>=24.12 <25`：Node 24.12.0 起 TypeScript 类型剥离标为稳定（24.3.0 起已不再输出实验性警告），AIHOT 的 `>=24.11` 早于稳定版且允许 25/26；选 Node 26 时改为 `>=26 <27`。
5. **`@types/node` 与运行时主版本一致**（24.x）。**`engines`、`.node-version`、Docker 基础镜像（补丁版 + 摘要）、验证回执里的工具版本四处同一版本。**
6. corepack：Node 24 文档仍有 corepack 页；Node 26 文档站没有该页（2026-09-30 读取返回 404），按“不再随 Node 分发”处理，**未在 Node 26 镜像中实测**。若上 Node 26，镜像里改为显式安装固定版本的 pnpm，并校验 `pnpm --version`（旧仓库写法：`infra/tencent-cloud/images/web.Dockerfile:10-12@main`）。
7. Node 对 `node_modules` 目录下的 `.ts` 文件拒绝类型剥离（Node 24、26 文档均写明；放开的提案 nodejs/node#63853 仍未合并）。后端“直接运行 TypeScript”依赖工作区包以符号链接留在 `node_modules`（pnpm 默认如此），因此镜像不能用 `pnpm deploy`（4.3 第 6 条）。

### 2.2 TypeScript 7 兼容性【设计】

**事实（2026-09-30 核查）**

- `typescript@7.0.2`（2026-07-08）是 npm 上唯一的 7.0 正式版。其包的 `exports["."]` 只指向 `./lib/version.cjs`（版本元数据），旧的 `ts.factory`、`createPrinter` 等编译器 API 不在根入口；新 API 只在 `./unstable/*` 入口。
- `openapi-typescript@7.13.0`（2026-02-11，仍是 latest）的 peer 依赖是 `typescript ^5.x`，早于 TS 7 发布，没有适配发布。上游 PR #2862（2026-09-06，未合并）的文档补丁也承认：未限定版本的 `typescript` 会装到 TS 7，而生成器用到的经典编译器 API 不在其根模块；它建议应用用 TS 7、生成步骤放进独立 tooling 包，并明说这只是绕行办法，不解决根本兼容问题。
- `dependency-cruiser@18.5.0` 没有声明 typescript peer 依赖、自身开发依赖为 TS 6；用 TS 7 解析 `.ts` 未实测。

**决定**

| 用途 | 做法 |
|---|---|
| 直接用 `typescript@7.0.2` | `tsc` 类型检查、`react-router typegen`、Vite 8、Biome。AIHOT 的 `apps/web` 已在 TS 7.0.2 上跑 `react-router typegen && tsc`（`AIHOT:apps/web/package.json`）；是否全部通过由 T-0001 栈兼容基准实测 |
| 必须调旧编译器 API 的工具（openapi-typescript；将来 typescript-eslint、ts-morph 类） | **默认**：放进独立 `tooling/` 包（不属业务模块，不被任何应用依赖），该包固定 TypeScript 5.9.x（5.9.3，满足 openapi-typescript 的 peer 范围，与上游 PR #2862 的写法一致）；pnpm 的严格依赖图保证只有它解析到 TS 5。**备选**：在该包内用别名 `typescript: npm:@typescript/typescript6@^6.0.0`（6.0.2，2026-07-06，命令 `tsc6`），须在 `pnpm-workspace.yaml` 用 `peerDependencyRules` 放行 peer 范围并实测 |
| 边界检查 | 不以 dependency-cruiser 为必需（见 7.1）；若仍要用，标注“等 TS 7.1 或改 swc 解析器，未实测” |
| 验收 | T-0004：干净克隆上**一条命令**（`pnpm contracts:gen`）生成 `api-client`，且与已提交版本逐字节一致；T-0001 栈兼容基准见 7.3 |

### 2.3 其他候选

| 候选 | 状态（2026-09） | 结论 |
|---|---|---|
| Bun 1.4.2† / Deno 2.9.7† | 可用 | 不采用：AIHOT 基于 Node，换运行时没有业务收益 |
| Python | 旧项目主语言 | **不作主语言**。仅当 PDF spike 选中 Python 侧车时，以独立小容器引入（4.6），并经 ADR 批准；docling、MinerU 只是候选，不是默认 |

后端沿用 AIHOT 的“Node 直接运行 TypeScript、后端无构建步骤”，减少构建产物与 Agent 的心智负担。

---

## 3. 前端与最小私有页面

### 3.1 前端候选

| 候选 | 版本 | 结论 |
|---|---|---|
| React Router 8（框架模式） | 8.4.0（2026-09-15；8.0.0 于 2026-06-17†） | **沿用**。默认 Web Streams 服务端入口；读者站与私有路由组都用它 |
| Next.js 16 | 16.3.7† | 不采用：AIHOT 不用，混用两套框架只增加负担 |
| TanStack Start | 1.168.59† | 不采用：没有替换理由 |
| Tailwind 4 | 4.3.3 | **沿用** |
| shadcn（4.21†）/ Radix（1.6.7†）/ Base UI（1.8.0） | — | 以 AIHOT 自带 `components/ui` 为主；复杂可访问组件按需引入 Base UI 底座，样式自己写 |
| React Compiler | babel 插件 1.0.0（2025-10-07†） | 待评估：对列表页性能可能有帮助，非首期必需 |
| 中文字体 | 系统字体栈优先；分享图用 AIHOT 自带 Noto Sans SC（OFL） | 不在读者站加载大体积中文网页字体 |

### 3.2 最小私有页面对技术栈的影响【设计】（ADR-0018）

不设运营台后，私有操作只剩六组最小页面（账号、信源、内容、用量与模型密钥、反馈、网站资料），对技术栈的影响是“少”：

1. **不另起前端应用、构建或子站**：私有页面是 `apps/web` 内需登录的路由组，只在 `PRIVATE_HOST` 响应；没有第二个 Vite 构建、第二套路由与依赖（ADR-0008 已废弃）。
2. **私有接口来自 `private-api` 实例**（与 `public-api` 同镜像）；私有页面只用私有客户端，边界脚本检查私有客户端不进公开路由组；私有路由按路由拆包，代码不进公开页面包。
3. **页面形态**：服务端渲染表单 + 原生提交 + 少量客户端脚本；不引入图表库与动画库；无总览、审稿台、审计页（DEC-04）。
4. **登录**：密码（Argon2id）、服务端会话、CSRF、限流均自有实现，不引入第三方认证服务或框架；AIHOT 的飞书 OAuth 登录保留、默认关闭，不作为具名账号的登录方式（DEC-05；Owner 2026-10-02 要求保留，接入时另立任务）。
5. **告警**：照上游原样用飞书自建应用发送（Owner 2026-10-06 选“自建应用”，08-owner-voice DEC-33）：`notify/feishu.ts` 用应用凭据取令牌、按群号发到提醒群，纯 HTTPS 请求，不引入 SDK；内容群的 Webhook 只给内容推送用。应用凭据与群号写在服务器设置里、经安全录入，不在私有页面录入。只发飞书，不做邮件备用（Owner 2026-10-06 选“只用飞书”，DEC-06）。

---

## 4. 后端、契约与数据

### 4.1 HTTP 与契约

- **Fastify 5 沿用**。每个模块在 `routes.ts` 中声明路由（`publicRoutes` 与 `privateRoutes` 两组，`public-api` 与 `private-api` 实例各注册一组），请求与响应 schema 引用 `@amp/contracts` 中的 Zod 定义。
- **唯一链路**（DEC-31，ADR-0013）：`packages/contracts` 的 Zod schema 是唯一源 → 生成 OpenAPI 3.1（对外文档）→ 生成 `api-client`（公开、私有两个入口）与 mock；生成物提交到仓库，`make verify` 检查无漂移；公开 API 首次对外发布后再加 oasdiff 破坏性变更检测。B 包的 `openapi.json` 与 `examples.json` 只作首版输入，一次性转写为 Zod，此后不再手工维护。
- **三条硬规则**（移植自 B:architecture/03-stack-decisions.md ADR-N03）：不得同时维护手写 OpenAPI、TS interface、Zod 三套不比对的定义；**禁止把用户上传的 schema 作为动态编译输入**；必须验证 `nullable`、`union`、`format`、`additionalProperties` 的兼容子集。Fastify 默认的 JSON Schema 是 Draft 7，OpenAPI 3.1 基于更高版本的 schema 语义，两者不能直接互喂；fastify-type-provider-zod 7 对 OAS 3.1 的 schema 方言处理，T-0004 逐项验证（未核实）。
- **前端客户端**：openapi-typescript 生成类型 + openapi-fetch 调用，生成步骤见 2.2。候选中 @hey-api/openapi-ts（0.99.0，未到 1.0）、orval 8.38†、Kubb 5.4† 功能更多，首期不需要。
- **不采用** tRPC 11† / oRPC 1.15† / ts-rest：它们把契约绑定在 TypeScript 调用上，外部 Agent 与第三方仍需要 OpenAPI，我们需要的是语言无关的公开契约。TypeSpec 1.16† 适合大型 API 设计，但多一门语言，首期不用。

### 4.2 PostgreSQL 与扩展

- **PostgreSQL 18.6**（2026-08-13†；18 系列支持到 2030-11-14；PostgreSQL 官网版本页 2026-09-30 读取）。PG 19 仍为 beta，不上生产；PG 17.11 仅作回退。
- **镜像**：`postgres:18.6-trixie@sha256:<摘要>`，再安装 PGDG 的 `postgresql-18-pgvector`（当前 0.8.6，下限 0.8.4）。**所有基础镜像写“具体补丁版 + sha256 摘要”**（旧仓库写法：`infra/tencent-cloud/images/web.Dockerfile:1,24@main`、`node:24.16.0-bookworm-slim@sha256:…`）；AIHOT 用浮动标签（`node:24-trixie-slim`、`postgres:17-alpine`、`caddy:2-alpine`），会让同一份 Dockerfile 在不同日期构建出不同内容，不沿用。摘要在 T-0001 / T-0005 拉取镜像时写入，本文不写（会漂移）。2026-09-30 已确认 Docker Hub 存在 `postgres:18.6-trixie`、`node:24.21.0-trixie-slim`、`caddy:2.11.4-alpine`。更新节奏：基础镜像摘要随依赖升级批次更新；PostgreSQL 小版本每季度发一次（按惯例推算下一次约在 2026-11，未核实），随发布评估。
- **PostgreSQL 18 的 Docker 注意事项**（A 包核实）：官方镜像把数据目录改为 `/var/lib/postgresql/18/docker`、卷挂载点改为 `/var/lib/postgresql`；Docker 默认 seccomp 屏蔽 io_uring，容器中保持 `io_method=worker`；18 的 initdb 默认开启数据校验和，旧库升级需注意一致性。
- **`pg_dump` 客户端必须同升 18**：AIHOT 的 Dockerfile 用 Debian 自带的 `postgresql-client`（17，与其 PG 17 服务端匹配）；`pg_dump` 不能导出比自己新的主版本，备份与恢复演练用的镜像需从 PGDG 安装 `postgresql-client-18`。
- **pgvector：装上，不建索引**。M0/M1 镜像只安装扩展；事件召回先用确定性候选 + 有界窗口精确比较 + DeepSeek 判定，是否建 HNSW（列类型 `halfvec` 节省内存）由聚簇基准（精确 vs ANN）决定。下限 0.8.4 的依据是 pgvector CHANGELOG（2026-09-30 读取）：0.8.3（2026-06-17）修复 HNSW vacuum 可能造成的索引损坏，0.8.4（2026-06-30）修复 `hnsw graph not repaired`。VectorChord、pgvectorscale 在几十万条规模下没有必要。
- **中文检索路线**：
  1. 首期沿用 AIHOT：公开池的窄表 + pg_trgm 三元组索引；3 个字以上走索引，1–2 个字扫描窄表（数据量几万行时可接受）。
  2. M2 用真实查询日志评测：pg_bigm（2-gram，擅长 1–2 字中文与子串，宽松许可）或 ParadeDB pg_search（BM25，jieba 分词，AGPL-3.0，发版频繁需锁版本，已知并行查询时词典重复加载的性能问题 #4840†）。采用 pg_search 前需确认 AGPL 义务。

### 4.3 数据库访问、迁移与数值约定

1. **查询层沿用 postgres.js 的 SQL 优先写法**（AIHOT 全部查询基于它），并保留 AIHOT `db.ts` 里踩过的坑：prepared statement 保留计划缓存、搜索走强制自定义计划（`withCustomPlans`）、关闭 JIT、空闲连接保持 10 分钟（`AIHOT:packages/backend/src/db.ts:12-16,33-44`）。
2. **行类型（方案 1，已定）**：每个 repository 为每条**对外**查询声明 Zod 行 schema，并在边界 parse——运行时防漂移，同时得到 TS 类型；从数据库生成的类型（kysely-codegen 0.20.0，或自写 `information_schema` 内省）只当类型来源，用在 `sql<Selectable<Table>[]>` 泛型上；集成测试断言“表的列集合 = Zod 行 schema 的字段集合”。模块外禁止拿到 `sql` 对象（B:architecture/03-stack-decisions.md ADR-N04；`05-engineering-conventions.md` 第 7 节）。只“生成行类型文件并与提交版本比对”不够：它只能证明数据库结构与类型文件一致，不能证明每条 SQL 返回的列与使用方的类型一致，而多 Agent 并行改表时出错的正是后者。验收：T-0005 增加“改列名必须使对应 repository 测试失败”。
3. **不采用 Kysely 作为默认**（0.29.6，最接近 SQL 的类型安全构建器）：kysely-codegen 的产物是 Kysely 用的 DB 接口，postgres.js 的模板字符串查询不读这份类型；若方案 1 试点失败，新模块可改用 Kysely（postgres.js 方言），AIHOT 存量查询逐模块迁移。Drizzle 1.0 仍为 RC（latest 0.45.3†）、Prisma 处于 7→8 换代（`latest` 已指向 8.0 RC†），不采用。
4. **数值类型：不设全局 Number 解析**。AIHOT `db.ts` 把 int8（OID 20）与 numeric（OID 1700）全局解析成 JS Number，注释的假设是“数值远小于 2^53”（`AIHOT:packages/backend/src/db.ts:4-9,22-25`）；数据库里费用列是精确小数（`cost numeric(14,6)`，`AIHOT:database/migrations/0001_core.sql:143`），到 JS 就成了双精度。对热榜分数成立，对“预留/确认/未知占用”的用量账本与对账不成立：大量 0.0000xx 元级别的预留与结算累加会有浮点误差，int8 超过 2^53 时静默失真。新库：
   - numeric 默认保持字符串（或 decimal 类型）；金额以“币种 + 最小单位整数”（如微元，bigint 以字符串读取）进入领域层，账本加减用整数或 decimal.js（10.6.0）；
   - int8 默认 bigint / 字符串，仅在读模型分数、计数等明确处局部转换；
   - 验收：用量账本用例——累计 10 万笔微小预留与结算后，与数据库精确求和逐位一致，且异常熔断阈值（单篇 5 元、单份法规文书 100 元、单日 50 元与 7 日均值 3 倍）及其 70% 预警线的判定不因舍入偏差而误判或漏判。
5. **迁移**：文件放 `database/migrations/<module>/YYYYMMDDHHMM_<说明>.sql`，按依赖声明拓扑排序、再按时间戳执行（ADR-0003；改造 AIHOT 的 `scripts/migrate.ts`）；首期检查是“空库全量迁移 + schema 快照比对 + 已合并迁移内容哈希不变”。squawk 2.66.0 缓办，触发条件是出现第一次 contract 阶段迁移。dbmate 2.36.0 不采用（依赖拓扑排序要自写）；Atlas 1.3† 的迁移 lint 属于付费版，graphile-migrate 围绕单一 `current.sql`，都不适合多 Agent 并行。
6. **镜像里怎么装依赖**：整仓复制 + `pnpm install --prod --frozen-lockfile`（工作区包保持符号链接）；**明令禁止 `pnpm deploy`**——它把工作区包放进 `node_modules/.pnpm/…`，Node 对该路径下的 `.ts` 拒绝类型剥离，运行时报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`（pnpm/pnpm#10602，2026-09-26 作为“未实现功能请求”被清理关闭，并非已修复；Node 侧 nodejs/node#63853 仍未合并），除非先给后端加构建步骤。保留 AIHOT 的 `NPM_REGISTRY` 构建参数（`AIHOT:Dockerfile:11,19`，对应 pnpm 的 registry 设置；境内构建用镜像源）。
7. **pnpm 12 配置**（写进 `pnpm-workspace.yaml`，T-0001 验收）：`packageManager` 字段固定版本；`minimumReleaseAge` 写明（pnpm 11 起默认 1 天，与 Renovate 的同名设置一致）；`allowBuilds` 保持为空——AIHOT 的锁文件里只有仅限 macOS 的可选依赖 `fsevents` 带安装脚本（2026-09-30 核对 `AIHOT:package-lock.json`），首次 `pnpm install` 应零放行，以后新增带脚本的依赖（例如 PDF/OCR 工具）逐个评审；pnpm 12 对 `pnpm-workspace.yaml` 里不认识的键会报错而不是忽略。

### 4.4 任务与工作流

| 候选 | 版本 | 结论 |
|---|---|---|
| pg-boss | 12.35.1（2026-09-30；12.35.0 于 2026-09-26） | **沿用**。基于 PostgreSQL，支持定时、单例、重试、死信；队列按 `<lane>.<stage>`，加 outbox/inbox 语义（ADR-0005）。须实测：`short`、`singleton` 等队列策略含义不同，多 worker 下目标键的行为要测；队列的原子领取不等于“外部模型、网页、飞书恰好执行一次”（B:architecture/03-stack-decisions.md ADR-N05）。“同一来源同一时刻最多一个取得任务、按国家/来源轮转”的实现（单例键或数据库锁）同样在 M0 用基准实测 |
| Graphile Worker | 0.18.0† | 同类替代，无替换理由 |
| DBOS Transact | 5.2† | 缓办：若出现需要跨多步持久化编排的复杂流程（例如长文分段翻译的编排）再评估 |
| Temporal 1.32† / Restate 1.7† / Inngest / Hatchet / Trigger.dev 4.6† / Vercel Workflow 4.8† | — | 不采用：需要额外服务或托管平台，4GB 单机与大陆部署都不合适 |

### 4.5 对象存储【设计】（ADR-0005）

| 项 | 决定 |
|---|---|
| 生产 | 腾讯云 COS，经 S3 兼容接口，首选；业务代码只依赖 `platform/storage` 端口，不 import SDK |
| 开发与测试 | 本地目录实现同一端口 |
| 客户端库 | 候选：`@aws-sdk/client-s3`（3.1144.0，走 COS 的 S3 兼容端点）或官方 `cos-nodejs-sdk-v5`（3.0.0）。M0 随 fetcher 骨架用 COS 实测后选定，不假设“S3 兼容”等于完全等价（B:architecture/03-stack-decisions.md §1 对象存储行） |
| 凭据分权 | fetcher 只写暂存前缀；worker 读写；备份专用独立桶、独立权限（ADR-0005、01 第 9.1 节）。COS 的前缀级权限与临时凭据能力在 M0 实测 |
| 数据库里存什么 | 只存对象键、sha256、大小、媒体类型、权限版本、到期时间；不存临时签名 URL |
| 当前状态 | **COS 在旧仓库没有创建与演练证据，按未就绪处理**：旧仓库记录“COS 备份桶 `enable_cos_backup=false`，未创建、未修改”（`docs/runbooks/infrastructure.md:17@main`）；`coscli` “仍待独立备份切片”（`docs/runbooks/production-deployment.md:160@main`）；真实创建与恢复演练“仍需独立批准”（`docs/testing-strategy.md:386@main`）。是否已有桶由 Owner 确认（桶名与密钥不写入交接包）；默认按“没有”处理，M0 前置由 Owner 批准创建私有、版本化、加密的桶。创建桶、开通 `coscli`、创建子账号属于 Owner 逐次批准的云写操作（ADR-0017 第 9 条） |

### 4.6 抓取、解析与出网【设计】

**采集链**：API / RSS → HTTP 抓取 → 本地解析 → 必要时渲染 → 外部服务兜底（`01-product/07-sources-and-coverage.md` 采集链，BR-ACQ-02、BR-ACQ-03 组件可替换）；付费与第三方通道默认关闭（BR-ACQ-24）。所有获取方式遵守权限矩阵（HTTP、浏览器、第三方读取、附件、OCR、外发模型分别受矩阵控制：Owner 声明全部信源已获许可、默认建档为“允许”，可逐源逐项收紧，ADR-0009）；HTML 与 PDF 结果统一为带 locator 的内容块，表格、页码、条款号、附件关系不能丢（B:architecture/03-stack-decisions.md ADR-N08）。

**出网层**（AIHOT `lib/http-fetch.ts`、`lib/url.ts` 搬入 acquisition 的 fetch 运行时，`03-module-map.md` 第 8 节）：

1. 只搬移：SSRF 检查、连接时地址校验、总超时、字节上限、字符集解码、undici 连接池。
2. **删除 `EGRESS_PROXY_URL` 出网代理分流与相关测试**；生产配置出现出网代理设置即拒绝启动（ADR-0019 第 6 条）。
3. **部署文档不写“抓不到就配代理”**（AIHOT `docs/deploy.md:24` 的做法不沿用）。境外信源从大陆不可达时，记录来源健康态 `blocked`、原因码 `blocked_network`（显示“不可达（网络）”），覆盖表与日报如实标注，不伪造实时性。依据：旧ADR-0006 第 7 条【Owner 决定，2026-07-22】——大陆采集全球公开信源不得绕过合规网络，任何境外采集节点属于未来独立的法律与安全决策、不作为默认架构（`docs/architecture/decisions/0006-mainland-tencent-cloud.md:26@main`）；旧仓库的付费调用传输层也刻意没有代理（`services/model_gateway/transport.py:146@main`：“no redirect, proxy, or streaming behavior”）。
4. 法规线 33 个法域底表里除中国外全部在境外，Owner 原始信源表的 320 个唯一目标里也有 67 个境外来源（A:01-product/07-sources-and-coverage.md 第 15、66 行），“不可达”会经常出现，来源健康与覆盖表要为它设计（属 acquisition 验收）。M0 在目标部署区域对全部境外目标做一次可达性基线，不以开发者本机结果代替。
5. 境外采集节点默认不设；是否要单独评估，是 Owner 的独立决定（`08-open-questions.md`）。

**PDF、表格、扫描件与渲染——选型 spike 前移到法规纵向骨架（M0/M1），不留到 M2**

判据（B:architecture/03-stack-decisions.md ADR-N08 与第 4 节基准）：**正文完整、页码与条款号不丢、日期正确、资源可控、成功成本**；不以库自称的“智能”作依据。**资源门**：须与 4GB 主机（当前 4C4G 合计约 2.7GB）和系统盘已用 <20GB 的口径相容——依赖镜像、模型文件、临时目录与回收后的残留都计入磁盘预算（`07-deployment-and-ops.md` 3.4），超出者只能按需临时机器或一次性 job 运行。回归输入：美国联邦公报的官方 PDF（268 页、12,093,983 字节、118 个图像对象，`docs/policy-upgrade/federal-register-originals.md:17-21@policy`）加旧分支已取得的真实样本（首轮对照发现称加拿大、中国、美国各一份，清单在 spike 开始时到旧分支核对）。

| 候选 | 形态 / 许可 | 资源与现状 | 结论 |
|---|---|---|---|
| pdfjs-dist 6.3.289（2026-08-29） | TypeScript 侧，Apache-2.0 | 进程内，随 fetcher | 默认候选之一 |
| unpdf 1.8.1（2026-08-13） | TypeScript 侧，MIT，封装 pdf.js | 同上 | 默认候选之一 |
| pypdf 6.19.0（2026-09-16） | Python 侧车，BSD-3-Clause | 旧仓库锁 6.16.1（`pyproject.toml:9@main`），文字型 PDF 抽取 `PdfReader(strict=True)`、有页数上限（`services/ingestion/normalization.py:431-445@main`）【已实现未验证】；侧车预算上限 256MB（设计值，未实测） | **基线**：作为 Python 侧车 adapter 的第一个版本，与 TS 候选对比 |
| mupdf 1.28.1（2026-09-06） | AGPL-3.0-or-later | — | 未经法务确认不作默认（与 pg_search 同类） |
| docling 2.131.0 / MinerU 4.0.10（均 2026-09-29） | Python；docling 为 MIT，MinerU 为项目自有许可（PyPI 元数据 `LicenseRef-MinerU-Open-Source-License`，条款未读） | MinerU 官方 README（2026-09-30 读取）：`basic` 档（ONNX）最低 2GB 内存、CPU 可跑、模型约 0.8GB；`standard/advanced` 档 8GB 起，PyTorch 档 16GB 且需 GPU（8GB+ 显存）。docling 资源需求**未核实** | 只作候选，须过资源门：与 PostgreSQL 同机（当前 4C4G 合计约 2.7GB）不可行，运行方式只能是按需临时机器 / 一次性 job，或“受来源许可约束的多模态模型读取”（走 ai-gateway 的外部模型许可与预算） |
| 本机 Tesseract | — | 旧分支实测：第 5 页统计表识别丢失大量单元格，“明确不接为合格附件”；本地 OCR 样本漏单元格，保持未完成（`docs/policy-upgrade/federal-register-originals.md:20@policy`、`docs/policy-upgrade/status.md:279@policy`） | 不能作为唯一的 OCR 路线 |
| 需渲染的页面（浏览器） | Playwright 自带浏览器，受限子进程 | 4GB 主机不常驻 Chromium | 默认关闭，按源开启（BR-ACQ-24、ADR-0019 第 4 条） |

**硬门**：决定性附件读不全则不出确定结论（PDF/OCR 置信不足只保留页码、标待处理，不声称完整中文或完整解读，`01-target-architecture.md` 第 14 节）。

---

## 5. AI 层

### 5.1 网关实现

- **自有 `ai-gateway`**，在 AIHOT 的 `providers/`（OpenAI 兼容调用、回执、调用次数熔断、每步换模型）基础上扩展：能力注册表、处理许可检查、北京时间自然月用量账本（预留 / 确认 / 未知分开，按业务线、能力、信源记账）、异常熔断（含熔断前的 70% 预警）、用量报告与用量提示、缓存键（能力 + 环节 + 输入哈希 + 提示词版本 + 路由修订〔含响应模型版本证据〕+ 输出 schema 版本，用途与业务线不进键，ADR-0006 第 2 条）、有界工具循环执行器、评测运行器。
- **用量与熔断按业务线、能力、信源记账**（ADR-0006、ADR-0016、BR-COST-17～20；Owner 2026-10-01：不设月度金额上限，不设保底额与调剂额）：账本、暂停开关与熔断状态都带 lane；异常熔断（同一输入 1 小时内重复付费 ≥3 次；单篇资讯材料超过 5 元或单份法规文书超过 100 元；单日超过过去 7 日日均的 3 倍且超过 50 元，无历史数据时以 200 元为界）只暂停相关能力或来源的付费调用，阈值与预警比例（默认 70%）在受控配置、负责人可调；任一指标达到其熔断阈值的 70% 时先推送预警（只提醒、不暂停），达到阈值才熔断，预警与熔断都走告警渠道；每月 1 日推送用量报告，月内累计每增加 100 元推送用量提示（只提示）；积压时按“法规 > 官方一手 > 其他”处理；法规线的材料不经过资讯预筛，其准入取决于来源职责与文书身份。
- **协议适配库：M1 不引入 Vercel AI SDK**（`ai` 7.0.126、`@ai-sdk/openai-compatible` 3.0.62、`@ai-sdk/deepseek` 3.0.58）。AIHOT 的 `providers/llm.ts` 直接用 `fetch`；回执、用量账本与熔断、缓存、许可、“结果未知”的语义都依赖对原始请求的完全控制，交给 SDK 只省少量结构化输出样板，却增加依赖与升级面。重新考虑的条件：基准证明自写适配样板成为维护负担，且 SDK 能让出回执层控制，另立 ADR。
- **不在生产路径引入 Agent 框架**（LangGraph 1.4†、Mastra 1.72†、OpenAI Agents SDK 0.18†、Claude Agent SDK 0.3† 等）：生产是程序编排的固定工作图（DEC-16，`01-target-architecture.md` 第 7.3 节）；有界工具循环只用于离线信源研究，用提供商原生工具调用实现，`ai-gateway` 不自带工具。旧仓库的时序是旧ADR-0012（禁止）→ 旧ADR-0036（Owner 批准受控试验，首批 3 个真实任务均未产出可审稿）→ 旧ADR-0037（取代其依赖）。这些框架可以在开发期的离线实验中使用。
- LiteLLM 1.103† 等独立网关服务：不采用，多一个进程和一层故障面。
- **M1 新稿加工的 recipe**（`02-rules/03-ai-capabilities.md`）：确定性判重与元数据 → 一次合并结构化调用（相关性、分类、阶段、国家/矿种、实体提及、引文、中文标题与导读，必要时带首段译文）→ 逐段翻译。下面的成本公式按这个 recipe 估算。

### 5.2 模型与价格（DeepSeek 官方价格页，2026-09-30 读取，人民币口径）

【Owner 决定】默认供应商 DeepSeek（DEC-29）。下表价格取自官方中文价格页（`api-docs.deepseek.com/zh-cn/quick_start/pricing`）；页面声明产品价格可能变动，**费用以私有页面“用量与熔断”的实时账本为准，不按本表硬编码**。基线路由的正式记录（带观察日期、有效期与证据指针）在 `02-rules/03-ai-capabilities.md`；本节只列栈层面的事实。

| 用途 | 路由 | 能力与限制 | 价格（元 / 百万 token；空闲时段 / 高峰时段） | 状态 |
|---|---|---|---|---|
| 预筛、结构化、中文标题与导读、翻译 | DeepSeek `deepseek-flash`（服务版本 DeepSeek-V4.1-Flash） | 上下文 1M，最大输出 384K；JSON 输出、工具调用；并发上限 2500 | 输入缓存未命中 1 / 2；缓存命中 0.02 / 0.04；输出 4 / 8 | **基线路由 R0**（旧站现网在用；价格观察日 2026-09-30，旧站价格表有效期至 2026-10-13，新站按 ≤45 天复核；正式记录见 `02-rules/03-ai-capabilities.md` 1.8） |
| 需要更强能力时的候选路由 | DeepSeek `deepseek-v4-pro`（DeepSeek-V4-Pro-0813） | 同上；不支持图像理解；并发上限 500 | 输入缓存未命中 4.5 / 9.0；缓存命中 0.15 / 0.30；输出 13.5 / 27.0 | 待评测候选，经路由准入（评测 → 影子 → 小流量 → 启用）后才启用 |
| 其他候选 | 通义 qwen-flash / qwen-plus / qwen3-max、智谱 GLM-5.3†、Kimi K3† | — | 价格未复核（A 包记录自 2026-09 厂商页），**不作成本估算输入** | 待评测候选；新供应商按新付费订阅处理（DEC-29） |
| 向量（事件召回） | 不默认启用 | AIHOT 现有默认 DashScope `text-embedding-v4`（1024 维）；候选另有通义 `qwen3.7-text-embedding`、智谱 Embedding-3 | 价格**未核实** | 召回先用确定性候选（实体、法域、文号、时间窗、标题相似）+ DeepSeek 判定；基准证明不够时，作为“新付费订阅”请 Owner 批准 |

- **两个会影响成本的细节**：① 官方页写明 `deepseek-flash` 默认是**思考模式**，调用方必须按其“思考模式”文档显式选择非思考（基线路由记录按非思考 JSON 输出，见 `02-rules/03-ai-capabilities.md`），否则成本与延迟都会变；② 旧模型名 `deepseek-v4-flash` 仍可调用，但对应模型已下线，请求由 V4.1-Flash 提供服务并按 Flash 价格计费。
- **高峰与空闲**：北京时间周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00 为高峰，其余时间（含周末与法定节假日全天）为空闲，价格是高峰的一半（官方页同时给出的 UTC 口径为 01:00–04:00 与 06:00–10:00，两者一致）。**批量翻译、回填等非紧急任务调度到空闲时段**，可直接把成本减半。
- **单篇成本公式**：成本（元）= 输入 token × 输入单价 + 输出 token × 输出单价，命中缓存的输入按命中价。示例（token 数是假设，不是实测）：一篇约 3000 词的外文全文翻译按 4K 输入 + 5K 输出、缓存未命中计，高峰价约 0.048 元（4K × 2 + 5K × 8 元/百万 token），空闲价约 0.024 元。**不含**结构化调用、失败重试、结果未知的预留占用；**M1 的第一个验收**是用 100–200 篇真实材料测出每阶段 token 与失败/重试系数，再回填成本表（`02-rules/05-cost-and-budget.md`）。
- **价格复核**：价格记录须带观察日期，过期失败关闭（旧仓库惯例，首轮核查称 ≤45 天复核，未复核原文）。首轮核查引用的旧仓库基线路由记录有效期到 2026-10-13（未复核原文），此前须重新观测；本表的观察日是 2026-09-30。
- 用量规则与不浪费纪律见 `02-rules/05-cost-and-budget.md`：不设月度金额上限，不设保底额与调剂额；积压时按“法规 > 官方一手 > 其他”处理，不降级（DEC-08、DEC-09，Owner 2026-10-01 已定）。本节价格与单位成本只作参考。
- 所有候选都提供 OpenAI 兼容接口，符合“提供商不写死”的原则。

### 5.3 提示词与评测

- 提示词文件在 `industry/prompts/<capability>/`，版本即内容哈希（沿用 AIHOT）。
- 评测沿用 AIHOT 的 SelectBench 与 pairwise relation 评测脚本思路，扩展为每个能力一个评测集（`evals/<capability>/`）；结果写入数据库，开发 Agent 经只读运维 MCP 读取，负责人看评测报告。不设评测页面（ADR-0018 只有六组私有页面）。
- **精选评分的评测与门槛校准沿用 AIHOT 的办法**（ADR-0021，Owner 2026-10-01）：`scripts/eval-selection.ts` 跑准确率、查准率、查全率与 40–90 的门槛扫描；100–200 条矿业样本分开发集与留出集，难例为主，由 Owner 标注；先改评分标准、再动门槛；矿业版评分标准是草案，生效前必须先交 Owner 审阅确认（提交时并排给出 AIHOT 原规则与矿业版改动点），影子运行期可用草案与 AIHOT 原门槛跑并把结果给 Owner 看，全面切换前完成一次留出集检查并留记录、Owner 审阅确认记录齐备。校准用的标注与抽检工具沿用 SelectBench 的思路，是默认关闭的建设期工具，不是日常页面；事件关系评测沿用 `scripts/eval-relations.ts`。评测与研究用最小必要样本，不设月度金额上限（DEC-08）。
- 外部评测平台（promptfoo 0.123†、Langfuse v4.47†、Arize Phoenix 20.16†）缓办：Langfuse 自托管依赖 ClickHouse，4GB 机器放不下；首期用自有表记录调用与评测结果。

---

## 6. MCP 与 Agent 协议

- MCP 规范最新版本 **2026-07-28**†；TypeScript SDK 2.x 拆分为 `@modelcontextprotocol/server` / `client`（2.2.0，2026-09-28；AIHOT 现用 2.1.0）。AIHOT 已提供公开只读 MCP 出口，**沿用**并扩展为矿业工具集（路径以 `01-target-architecture.md` 第 3 节为准）；另有面向开发 Agent 的只读运维 MCP，由 `private-api` 实例经服务身份提供，数据脱敏。
- A2A（v1.0.1†）不采用：没有与其他 Agent 双向协作的业务需求。
- `llms.txt`：沿用（AIHOT 已提供）。
- 开发期可为 Agent 提供 Playwright MCP（0.0.83†）做真实浏览器验收。

---

## 7. 质量、供应链与工程工具

### 7.1 工具集与触发条件

M0 最小工具集（全部由 `make verify` 调用；与 ADR-0015 第 4 条一致）：

| 项 | 选择 | 说明 |
|---|---|---|
| 类型检查 | `tsc`（TS 7.0.2） | 调旧编译器 API 的工具见 2.2 |
| 格式化与 lint | Biome 2.5.15 | 配置写明两项，会直接影响首次全仓格式化提交：`css.parser.tailwindDirectives: true`；`lineWidth` 取 140–160（Biome 默认 80 列会使 AIHOT 约 23% 的行超宽而被重排，实际改动量还含引号、尾逗号等，首轮估计，T-0001 实测）。首次全仓格式化单独成一个提交；此后移植 AIHOT 上游修复时，先按同一 Biome 配置格式化补丁再应用 |
| 模块边界 | `package.json` exports 白名单 + pnpm 严格依赖图（未声明的依赖无法 import）+ 约 50 行的工作区依赖图脚本（只允许 `03-module-map.md` 第 3 节的边）+ Biome `noRestrictedImports` 禁止跨包深路径 | 即 B:architecture/02-target-architecture.md §8 要求的前两条；`noRestrictedImports` 的 glob 支持（首轮核查称 Biome 2.2 起支持）T-0001 实测 |
| 契约 | Zod → OpenAPI 3.1 → 客户端生成，生成物漂移检查 | 4.1 |
| 测试 | `node:test` + 临时库 + 假服务；关键读者旅程用 Playwright + axe（M1 起） | 7.4 |
| 行类型 | Zod 行 schema + 列集合断言 | 4.3 |
| 迁移检查 | 空库全量迁移 + schema 快照比对 + 已合并迁移哈希 | ADR-0003 |
| 密钥扫描、依赖审计 | 见 7.2 | |

**按触发条件再引入**（未触发不引入；触发时在同一 PR 更新 ADR-0015 的触发条件表）：

| 工具 | 触发条件 |
|---|---|
| Turborepo 2.11.5 | 全量 `make verify` 超过 10 分钟 |
| oasdiff v1.32.1 | 公开 API 首次对外发布后；引入时写明安装方式与固定版本（它是 Go 二进制，不在依赖图里） |
| squawk 2.66.0 | 出现第一次 contract 阶段（删除/改名）迁移之前 |
| Knip 6.39.0 | 资讯线绞杀式拆分完成过半、存量代码开始大量删除时 |
| Renovate 44.126.0 | 首次生产部署后；配置 `minimumReleaseAge`，与 pnpm 设置一致。许可为 AGPL-3.0-only，自用运行、不修改不对外提供服务时通常不产生分发义务，启用前仍与 pg_search 一并确认（第 10 节） |
| lefthook 2.1.15 | 可选的本地便利，不作为门禁 |
| testcontainers 12.2.0 | 可选便利层；主路径是指向临时库的 `DATABASE_URL` |
| Playwright 视觉对比 | 读者站视觉回归出现两次以上漏检 |
| Vitest | 不引入；确需 Vite 插件环境时仅限 `apps/web` 并另立 ADR |
| OpenTelemetry SDK / trace 后端 | 跨进程排障连续两次依赖手工拼日志（ADR-0020） |

**规格驱动**：本仓库 `docs/` 即规格；GitHub Spec Kit 1.0.13† / OpenSpec 1.13†【可选】，规格编号体系已在交接包中定义，不强制使用外部框架。可选的契约模糊测试 Schemathesis 4.28†。

### 7.2 供应链与安全检查

旧仓库这三类检查是 GitHub Actions 里的步骤（`.github/workflows/ci.yml:86-98@main`：trufflehog v3.90.11、`pnpm audit --audit-level=high`、`pip-audit`）；停用 Actions 后改写成统一验证入口里的命令，而不是某个平台的 Action 步骤。

| 项 | 工具与版本 | 运行位置与范围 | 失败处理 |
|---|---|---|---|
| 密钥扫描 | trufflehog v3.97.9（沿用旧仓库已用的工具；备选 gitleaks v8.30.1，T-0001 二选一并锁版本） | `make verify`：PR 的 base..head 差异；`make release-check`：整棵树 + 构建出的镜像层与前端产物。除官方“已验证”模式外，再加一轮项目自定义规则：模型供应商密钥、腾讯云 SecretId/AKID、飞书 app secret、私钥头、含账号口令的 URL。预提交钩子只作辅助，不作门禁 | 命中即失败；扫描结果（版本、范围、命中数）写入验证回执，回执缺该项不得视为通过 |
| 依赖审计 | `pnpm audit --audit-level=high`（旧仓库同；Python 侧车存在时加 pip-audit 2.10.1，旧仓库锁 2.9.0） | `make verify`：对锁文件 | 高危及以上阻断。阻断时允许“仅依赖升级”的 PR 通道，避免审计公告与功能 PR 互相阻塞（PIT-072：旧仓库的审计门曾多次阻塞功能 PR）。**审计接口在执行器所在网络的可达性未查证**：镜像站通常不提供审计接口，T-0001 在实际执行器上实测；不可达时改用 osv-scanner v2.6.0 并在回执写明数据源与日期 |
| 镜像基础层扫描 | trivy v0.74.0 或 osv-scanner v2.6.0（T-0001 二选一） | `make release-check` | 高危及以上阻断，例外须登记到期日 |
| SBOM | syft v1.52.0 | `make release-check`，对构建出的镜像 | 产物写入发布 manifest（ADR-0017 第 5 条；旧ADR-0038:33-36@policy 要求继续保留 manifest、镜像摘要与 SBOM） |

另：PR 描述、Issue 评论与 Agent 汇报的对外输出只含白名单字段，汇报前过同一套密钥扫描规则。三类检查的范围、自定义规则与回执要求见 `06-security-and-access.md` 6.1；验收 AC-SEC-14。

### 7.3 验证入口与命令约定

对外唯一入口是仓库受跟踪的 `make verify`（合并前）与 `make release-check`（发布前），规则见 ADR-0017；`pnpm check` 只是其**快速子集**。根 `AGENTS.md` 写明：提交前跑 `check`，合并前以 `verify` 回执为准。

| 命令 | 用途 | 对应验证入口 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 安装依赖，任何时候不改锁文件 | 所有阶段的前置 |
| `pnpm check` | 快速子集：类型检查、Biome、边界脚本、契约漂移、受影响工作区的 `node:test` | `make verify` 的第一阶段 |
| `pnpm test` / `pnpm -r --filter "...[origin/main]" test` | `node:test`；后者只跑受影响工作区 | `make verify` |
| `pnpm e2e` | Playwright + axe，只对生产构建运行 | `make verify`（需浏览器依赖的执行器） |
| `pnpm contracts:gen` | 在 `tooling/` 包内生成 OpenAPI 与 `api-client` | `make verify` 检查无漂移 |
| `make verify` | 不需真实模型的全部门禁：格式、类型、边界、数据归属、契约漂移、迁移、按角色配置校验、密钥扫描、依赖审计、单元与集成测试、产品更新片段、文档链接 | 合并前，在指定完整 SHA 的干净检出上 |
| `make release-check` | 制品构建、镜像扫描、SBOM、签名、容量与冒烟 | 发布前 |

**执行环境规格（M0 交付物）**：Linux（amd64 优先）+ Docker / Compose + 临时 PostgreSQL（经 `DATABASE_URL`）+ 浏览器依赖 + 锁定的 Node 与 pnpm 版本；不含生产凭据与模型密钥；**不得是生产主机**；缺 Docker 的本机只能跑 focused 子集，不得宣称完整通过。ARM 开发机的本地验证与 Linux AMD64 生产制品核验分开，测试数据库镜像与制品镜像都须多架构（linux/amd64 + arm64；旧ADR-0038:27@policy）。nightly 与依赖升级不假设云端 cron：由集成人或本机定时任务显式启动 `make nightly`。

**栈兼容基准（T-0001 验收，移植自 B:architecture/03-stack-decisions.md 第 4 节）**：干净环境装锁文件 → 类型检查 → 生成客户端且与已提交版本逐字节一致 → 迁移 → 跑 AIHOT 原测试；精确的 Node 24、Fastify、React Router、pg-boss、PostgreSQL 18 组合；禁止 `latest` 进入发布配置；失败项要有处置。其余基准（数据增长、查询、聚簇、双 lane 公平、付费恢复、发布/撤回、Agent 独立开发）见 ADR-0015。

### 7.4 测试

- **单一运行器 `node:test`**（沿用 AIHOT：35 个 `tests/*.test.ts` + `setup.ts`，约 4,100 行；web 另有 5 个）。
- **集成测试数据库是接口，不是工具**：通过 `DATABASE_URL` 连接一次性的 `*_test` / `*_ci` 数据库（沿用 AIHOT `tests/setup.ts:1-10` 的防误连守卫：库名不以 `_test` 或 `_ci` 结尾即拒绝运行）；数据库由执行器提供——本机服务、CI 服务容器或 testcontainers 均可。每个测试文件用 `CREATE DATABASE … TEMPLATE` 从已迁移的模板库克隆，以去掉 AIHOT 现有的 `--test-concurrency=1` 串行限制。
- **假服务**：沿用 AIHOT `tests/setup.ts` 起的本地 http stub；假模型服务与录制的信源响应由 `packages/testkit` 提供；测试不访问外网与真实模型。
- **组件级测试**：`node:test` + happy-dom（20.14.5），或 Playwright 的浏览器测试。
- **端到端**：Playwright 1.63.0 + @axe-core/playwright 4.13.0；只对生产构建运行，时间与随机源注入（PIT-070）；桌面与手机双视口；axe 规则设置按验收场景重新配置（旧仓库的设置只作参考，不复制文件）；截图对比的差异须人工审查，不批量更新基线。
- **旧 E2E 规格只作断言参考，不复制、不迁移文件**（Owner 2026-10-01：不从旧仓库导出任何文件，DEC-42）：旧仓库 `apps/web/e2e/` 有 13 份 Playwright 规格（共约 143KB；Playwright 1.62.1、axe 4.12.1，`apps/web/package.json:36-37@main`），是旧站已线上运行的页面行为断言；新项目的 E2E 按验收场景（`05-quality/06-acceptance-scenarios.md`）重新编写，不复制或迁移任何旧规格文件；编写时如需核对旧站已验证的行为，可按下列分类查阅旧规格的断言要点，避免再遗漏一遍：
  - 读者站相关（对照来源，T-0007 的首批 E2E 用例据验收场景重写）：`public-web`、`public-web-v2`、`reader-mobile`、`feed-time`、`reader-translation`、`reader-attribution`、`reader-featured`、`product-updates`、`report-generation`；
  - 面向旧运营台的 `admin-live`、`model-config`、`source-intake`、`content-review` → 按 ADR-0018 只对照必要私有操作（账号、信源、内容、用量与模型密钥、反馈、网站资料）的断言。
  对照清单（旧文件 → 对应页面/功能 → 断言要点 → 新用例）如需建立，放在 `05-quality/`，不再作为“迁移清单”。

---

## 8. 部署与运维

### 8.1 主机、镜像与交付

- **区域**：中国大陆【Owner 决定】（与已通过的 ICP 备案一致）。**规格【Owner 决定】2026-10-01**（DEC-18）：先做容量基准，达标即沿用已购的腾讯云轻量应用服务器（上海，Ubuntu 24.04，4 核 4GB，3Mbps，40GB SSD，300GB/月流量；详见 `07-deployment-and-ops.md`），切换演练临时租用按量机器；Owner 强调这是全新重写的项目。
- **进程**：同一镜像、按角色启动——`caddy`、`web`、`public-api`、`private-api`、`worker`、`fetcher`、`postgres`，迁移为一次性任务容器；没有运营台容器（ADR-0012、`01-target-architecture.md` 第 3 节）。
- **镜像构建与交付**【Owner 决定】：镜像由可信构建执行器按确切提交构建（独立 Linux 构建机，或开发机上的隔离环境；**默认不依赖 GitHub Actions，不在生产主机构建**），绑定完整 SHA 并留存验证回执；附 manifest（镜像摘要清单）、SBOM 与离线签名；生产主机只持镜像仓库的只读拉取令牌，按摘要拉取经受信公钥签名的制品；执行器不可用时换执行器，不跳过检查（ADR-0017；旧ADR-0038:19-40@policy；DEC-17）。
- **镜像仓库**：腾讯云容器镜像服务（TCR，个人版或企业版），国内可稳定拉取；是否已开通由 Owner 确认。
- **发布与回滚**：预检（可用内存 ≥1GiB、可用磁盘 ≥4GiB）→ 只增不破的迁移 → 替换服务 → 健康检查 → 公开读取冒烟 → worker 跑通一轮 → 外部读回发布标识头；失败自动回滚，**回滚也要验收**：回滚后对上一版本重跑同一套检查，失败则非零退出并进入维护态、告警、不登记产品更新（ADR-0012 第 3 条）。

### 8.2 监控与告警

- **应用内业务告警** → Owner 渠道（DEC-06；2026-10-06 改为飞书自建应用，08-owner-voice DEC-33）：照上游原样经飞书自建应用发到提醒群，只发飞书，不做邮件备用；应用凭据与群号经安全录入写进服务器设置；飞书提醒尽快配好（新站 2026-10-05 已上线），配好之前停更与自动暂停只能靠人到后台看。
- **独立于应用的外部检查**：应用停摆时，应用自己的告警也会一起停，所以需要——腾讯云云监控（CPU、内存、磁盘、带宽与流量包、实例到期）+ 外部可用性与新鲜度拨测。**拨测不得跑在生产同一台主机上**；Uptime Kuma 2.5.5† / Gatus 5.37.0† 只有部署在另一台机器上才可选，默认不部署。
- 只有飞书一条路（照上游；Owner 2026-10-06 11:17:09Z 选“只用飞书”，Q-22），推送失败在下个周期重试。
- 指标口径、lane 维度、阈值见 `01-target-architecture.md` 第 10 节与 ADR-0020；扩容触发线沿用旧ADR-0010 的默认值（`01-target-architecture.md` 第 12 节）。

### 8.3 数据与备份

- PostgreSQL 18 数据卷；**每日 custom dump（`pg_dump` 客户端 18）经 age 客户端加密后上传私有、版本化的 COS 独立桶**，与原件分桶、分权限，默认保留 7 日 + 4 周（月备份可选）。加密做法沿用旧仓库：age 加密、短期 STS 凭据或只写子账号（`docs/runbooks/production-deployment.md:509-510@main`；脚本 `infra/tencent-cloud/scripts/backup_postgres.sh`、`restore_postgres.sh`@main，校验项要改成现行 live/public 表）。机制、RPO/RTO 默认值（24 小时 / 2 小时，需 Owner，Q-59）与恢复演练见 `07-deployment-and-ops.md` 第 5 节。
- **切换前的存档备份（不导入）**：旧站数据一概不迁移（DEC-20）；但旧生产库没有经验证的异地备份（COS 未就绪，见 4.5），旧站停用或同机切换前，建议对旧生产库做一次加密全量备份并在隔离库校验，用于存档，兼作切换窗口内中止切换的兜底，不导入新系统，切换完成后不再用于恢复旧站服务；默认至少保留到旧站退役后 30 天，是否保留及保留多久由 Owner 决定（`07-deployment-and-ops.md` 4.2 与 AC-OPS-03）。
- 时间点恢复（pgBackRest 2.59.2 或 WAL-G 3.0.9）是升级选项，不是 M1 验收：触发条件是数据库 >12GB、恢复 >2 小时或 Owner 提高要求（`07-deployment-and-ops.md` 5.1）；不再写“M2 评估”。

### 8.4 明确不默认引入的基础设施（移植自 B:architecture/03-stack-decisions.md 第 3 节）

| 技术 | 初期不引入的原因 | 可重新考虑的证据 |
|---|---|---|
| Kubernetes / service mesh | 部署规模与团队边界尚无必要性证据 | 多部署单元有明确的调度、隔离、运维要求，收益大于平台成本 |
| Redis | 队列、用量账本、幂等已在 PostgreSQL；缓存先用进程内 + HTTP | 可测的跨实例热点缓存或限流需求，且失效规则与容量收益明确 |
| Kafka / NATS | 新闻与法规处理是有限任务，不是已证明的大规模事件流 | 多个独立消费者的长期重放或流处理需求，且有吞吐数据 |
| Temporal 等工作流引擎 | 显式有界状态机可由任务 + 业务账本表达 | 大量长程跨系统补偿/等待/版本升级工作流，自建维护成本更高 |
| Elasticsearch / OpenSearch / 专用搜索 | 多语言真实检索尚未基准 | PostgreSQL 的召回、相关度、延迟无法满足已定查询集合 |
| 独立向量数据库 | 事务数据与候选向量在同一事实域，pgvector 已装 | 向量容量/性能/独立运维需求超过 PostgreSQL 方案，且可重建 |
| 图数据库 | 事件与政策关系可用关联表 + 有界遍历 | 多跳图查询成为核心交互，且关系库方案测量不合格 |
| 通用 Agent Runtime、常驻智能体 | 日常生产可表达为有类型的任务，更多自主权不改善事实性 | 已定义动态研究需求、工具边界、单次费用上限和可验收产物 |
| 全量浏览器渲染 / 全量 OCR / 每稿多模型 | 高成本、额外错误面，没有逐条必需的证据 | 针对某类来源或文档的完整率提升与费用证明 |
| ClickHouse、Langfuse 自托管、Prometheus + Grafana 全家桶、本地大模型、常驻 OTel collector | 4GB 主机放不下也不需要 | 见 ADR-0020 的 trace 后端引入条件 |
| 出网代理、境外采集节点 | 与旧ADR-0006 第 7 条相反；不默认 | Owner 的独立法律与安全决定（ADR-0019） |

这些不是永久禁令。新增组件必须说明它解决的已观察问题、替代接口、失效与回退方式、运维负担（`05-engineering-conventions.md` 第 14 节），不能用“2026 年应该有”作为理由。

---

## 9. 相对 AIHOT 的变更对照（替换成本核算）

| AIHOT 现状 | 本包 | 结论 | 替换成本 | 收益 / 理由 |
|---|---|---|---|---|
| npm workspaces | pnpm 12 | 替换，成立 | 一次性：锁文件转换；`Dockerfile` 的 `npm ci` / `npm prune` 改为 `pnpm install --prod --frozen-lockfile`；配置 `allowBuilds`、`minimumReleaseAge`；不能用 `pnpm deploy` | 严格依赖图使模块边界违规直接失败，是换它最站得住的理由；旧仓库有 pnpm 经验。**回退条件**：T-0001 栈兼容基准里 pnpm 12 与类型剥离或镜像装依赖冲突且无法绕过，则退回 npm workspaces + 边界脚本（二选一，两份锁文件不并存） |
| PostgreSQL 17 | PostgreSQL 18.6 | 升级，成立 | 低：新库无迁移；镜像目录布局变化、`pg_dump` 客户端同升 | 支持期到 2030-11-14（17 到 2029-11-08）；异步 I/O、`uuidv7()`、B-tree skip scan 等 |
| `node --test` + 本机空库 | 沿用 `node:test` + `DATABASE_URL` 临时库 | **改回沿用**（A 原方案换 testcontainers + Vitest） | — | AIHOT 方案在 Mac、服务容器、独立执行器上都能用；换 testcontainers 要求 Docker 守护进程，Vitest 造成双运行器 |
| 无统一 lint/格式化 | Biome 2 | 新增，成立 | 首次全仓格式化提交；配置 `lineWidth`、`tailwindDirectives` 控制改动量 | 多 Agent 协作需要机器可检查的风格 |
| 无边界检查 | exports 白名单 + pnpm + 依赖图脚本 + Biome 禁深路径 | 新增（自有脚本） | 约 50 行脚本 | 取代 dependency-cruiser（TS 7 兼容性未实测，且多一个依赖） |
| 无契约生成 | Zod → OpenAPI → 客户端 | 新增，成立 | 4 个包 + `tooling/` 包固定 TS 5.9 | 公开 API 文档、客户端、mock 同源（ADR-0013） |
| 无 E2E 框架 | Playwright + axe | 新增，成立 | 低：旧仓库 13 份规格只作断言参考，不复制 | 真实浏览器验收是 Owner 的硬要求 |
| 无向量扩展 | pgvector 装上、不建索引 | 新增（仅安装），成立 | 几乎为零：镜像多装一个包 | 为聚簇基准留出 ANN 选项；AIHOT 的有界窗口精确比较先沿用 |
| `packages/backend` 单包 | 12 个业务模块 + 平台包，渐进拆分 | 改造 | 见 `03-module-map.md` 第 9 节（M0 不做机械拆分） | ADR-0002 |
| 全局编号迁移 | 按模块目录 + 时间戳 | 改造 | 改 `scripts/migrate.ts` | ADR-0003 |
| 单一 web 应用含 `/admin`；飞书 OAuth 登录 | `apps/web` 内私有路由组；具名账号 + 密码 | 改造 | 删除 admin 壳；飞书登录保留、默认关闭（Owner 2026-10-02） | ADR-0018；DEC-05 |
| providers（回执 + 调用次数熔断） | `ai-gateway`（加许可、用量账本与异常熔断、能力注册、评测） | 改造 | 中 | ADR-0006、ADR-0007 |
| `EGRESS_PROXY_URL` 出网代理分流 | 删除；生产拒绝启动 | 不搬移 | 删代码与测试 | 旧ADR-0006 第 7 条 |
| 浮动镜像标签；`npm ci` 构建 | 补丁版 + 摘要；独立构建执行器 | 改造 | 摘要维护 | 构建可复现、可回滚 |
| 本地数据卷存原文 | 对象存储端口（COS） | 新增 | 中：端口、暂存/回收、COS 实测 | ADR-0005 |
| 抓取在 worker 内 | 独立 fetcher | 新增 | 一个内部端点 + 暂存对象回收 | ADR-0019 |
| `db.ts` 全局 Number 解析 | 不设全局解析；金额用整数最小单位 | 改造 | 改 `db.ts`，账本按整数 | 用量账本精度（4.3） |
| 已保留 | React Router 8、React 19、Vite 8、Tailwind 4、Fastify 5、Zod 4、postgres.js、pg-boss 12、MCP server SDK、undici 与 HTML 抽取组件、sharp / satori / resvg、Docker Compose、Caddy、pg_trgm 窄表 | 沿用 | — | 已是当前主流版本，且已在 AIHOT 线上运行 |
| 缓办或不采用 | Turborepo、oasdiff、squawk、Knip、Renovate、lefthook、testcontainers（可选）、Vitest、MSW、Vercel AI SDK、通义 embedding 默认、dependency-cruiser | 缓办 / 不采用 | — | 见 1.2 与 7.1：未出现已观察的问题，不预先引入 |

---

## 10. 未核实与风险

**未核实（明确标注，不当事实用）**

| # | 项目 | 处置 |
|---|---|---|
| 1 | 嵌入模型（通义 `qwen3.7-text-embedding`、智谱 Embedding-3）的价格与维度；通义 / 智谱 / Kimi 候选的价格（A 包记录，本轮未复核） | DEC-29：默认不启用；接入前查官方价格页，并经 Owner 同意 |
| 2 | docling 的内存与在联邦公报样本上的效果；MinerU `basic` 档（最低 2GB）在扫描件表格上的质量；MinerU 自有许可条款 | PDF spike 实测；资源门未过不得同机部署 |
| 3 | `pnpm audit` 在执行器所在网络的可达性 | T-0001 在实际执行器上实测；不可达时改用 osv-scanner |
| 4 | Biome `lineWidth` 与 `tailwindDirectives` 对首次全仓格式化提交的实际改动量；`noRestrictedImports` 的 glob 支持 | T-0001 实测 |
| 5 | fastify-type-provider-zod 7 在 OAS 3.1 下的 schema 方言与 `nullable` / `union` / `format` / `additionalProperties` 兼容子集 | T-0004 验证 |
| 6 | TS 7 下 `react-router typegen` 与 Vite、Biome 的完整兼容（AIHOT 在用，无验收记录）；dependency-cruiser 与 TS 7 | T-0001 栈兼容基准；dependency-cruiser 已不采用，重评时等 TS 7.1 或改 swc 解析器 |
| 7 | Node 26：是否直接上；corepack 在 Node 26 的去向；`crypto.argon2` 在 Node 26 的可用性（24.7.0 起可用，26 未单独核实） | M1 前决定；Node 26 矩阵任务实测 |
| 8 | COS 是否已有备份桶、TCR 是否已开通；COS 前缀级权限与临时凭据能力 | Owner 确认；M0 实测 |
| 9 | 备用告警通道（邮件为备，已定）的发送方式选型 | 备用邮箱由 Owner 经安全方式录入；M1 前选定发送方式（SMTP 或云邮件服务）（**2026-10-06 改为飞书自建应用**，只发飞书，这一项不做） |
| 10 | DeepSeek 价格会调整 | 费用以实时账本核算，价格变动由用量报告与异常熔断兜底；基线路由记录到 2026-10-13 前须重新观测 |
| 11 | 带 † 的版本（沿用 A 包与首轮核查） | 引入前复核 |

**风险与法务确认**

- **AGPL**：ParadeDB pg_search（AGPL-3.0）、mupdf（AGPL-3.0-or-later）、Renovate（AGPL-3.0-only）——采用前确认义务；未确认不作默认。
- **MinerU 自有许可**：条款未读，采用前须读。
- Node 24 于 2026-10-20 转维护期：M0 期间即发生，不影响使用，但第一次生产部署前要决定是否上 26（2.1）。
- 版本漂移：本表是 2026-09-30 快照，以 lockfile 为准。

---

## 附表 A　版本核查记录（核查日 2026-09-30）

**来源代号**：[npm] = registry.npmjs.org 包元数据（dist-tags 与发布时间）；[GH] = GitHub Releases / Tags；[PyPI] = pypi.org/pypi/&lt;包&gt;/json；[Node] = raw.githubusercontent.com/nodejs/Release/main/schedule.json 与 nodejs.org/dist/index.json；[PG] = postgresql.org/support/versioning；[DH] = hub.docker.com 镜像标签；[DS] = api-docs.deepseek.com（中英文价格页）；[Docs] = 官方文档页面。**† = 沿用 A 包与首轮核查记录，本轮未逐项复核。** 状态一栏：稳定 = 各通道 latest；预发 = alpha / beta / rc。

| 组件 | 版本 | 发布日期 | 状态 | 来源 | 备注 |
|---|---|---|---|---|---|
| Node.js 24 | 24.21.0 | 2026-09-07 | LTS（Krypton）；2026-10-20 转维护期，支持到 2028-04-30 | [Node] | 镜像 `node:24.21.0-trixie-slim`（[DH] 标签更新于 2026-09-19） |
| Node.js 26 | 26.10.0 | 2026-09-21 | Current；2026-10-28 进入 LTS，支持到 2029-04-30 | [Node] | 文档站无 corepack 页（2026-09-30 读取 404） |
| TypeScript | 7.0.2 | 2026-07-08 | 稳定（7.0.1-rc 为预发） | [npm] | `exports["."]` 只指向 `./lib/version.cjs` |
| TypeScript 5 / 6 | 5.9.3 / 6.0.3 | 2025-09-30 / 2026-04-16 | 稳定（5.x 末版 / 6.x 最新） | [npm] | |
| @typescript/typescript6 | 6.0.2 | 2026-07-06 | 稳定 | [npm] | 命令 `tsc6` |
| @types/node | 24.19.0 / 26.6.3 | 2026-09-25 | 稳定 | [npm] | 取 24.x |
| pnpm | 12.8.1 | 2026-09-28 | 稳定 | [npm]；[Docs] 11.0、12.0 发布说明 | 11 起 `minimumReleaseAge` 默认 1 天、`allowBuilds`、`strictDepBuilds` 默认 true；12 对未知键报错 |
| Turborepo | 2.11.5 | 2026-09-28 | 稳定 | [npm] | 缓办 |
| Biome | 2.5.15 | 2026-09-30 | 稳定 | [npm] | A 包记 2.5.14（09-16） |
| dependency-cruiser | 18.5.0 | 2026-09-30 | 稳定 | [npm] | 不采用；A 包记 18.4.0 |
| Knip | 6.39.0 | 2026-09-30 | 稳定 | [npm] | 缓办；A 包记 6.38.0 |
| React / React DOM | 19.3.0 | 2026-09-09 | 稳定 | [npm] | |
| React Router（含 dev、node） | 8.4.0 | 2026-09-15 | 稳定 | [npm] | 要求 node ≥22.22.0，react ≥19.2.7 |
| Vite | 8.3.1 | 2026-09-24 | 稳定 | [npm] | |
| Tailwind CSS（含 @tailwindcss/vite） | 4.3.3 | 2026-07-16 | 稳定 | [npm] | |
| @base-ui/react | 1.8.0 | 2026-09-04 | 稳定 | [npm] | |
| Fastify | 5.12.5 | 2026-09-16 | 稳定（next 标签 6.0.0-alpha.4 为预发） | [npm] | |
| Zod | 4.6.5 | 2026-09-13 | 稳定 | [npm] | |
| fastify-type-provider-zod | 7.0.0 | 2026-06-24 | 稳定 | [npm] | peer：zod ≥4.1.5、fastify ^5.5.0、@fastify/swagger ≥9.5.1 |
| @fastify/swagger | 9.9.1 | 2026-09-30 | 稳定 | [npm] | A 包记 9.9.0（09-22） |
| openapi-typescript / openapi-fetch | 7.13.0 / 0.17.0 | 2026-02-11 | 稳定 | [npm] | openapi-typescript peer：typescript ^5.x；上游 PR #2862 未合并 |
| oasdiff | v1.32.1 | 2026-09-15 | 稳定 | [GH] | 缓办 |
| postgres.js | 3.4.9 | 2026-04-05 | 稳定 | [npm] | |
| pg-boss | 12.35.1 | 2026-09-30 | 稳定 | [npm] | 12.35.0 于 2026-09-26；要求 node ≥22.12.0 |
| squawk-cli | 2.66.0 | 2026-09-23 | 稳定 | [npm] | 缓办 |
| @modelcontextprotocol/server、client | 2.2.0 | 2026-09-28 | 稳定 | [npm] | AIHOT 现用 2.1.0；MCP 规范 2026-07-28† |
| Playwright / @playwright/test | 1.63.0 | 2026-09-04 | 稳定 | [npm] | 旧仓库 1.62.1（`apps/web/package.json:37@main`） |
| @axe-core/playwright | 4.13.0 | 2026-08-11 | 稳定 | [npm] | 旧仓库 4.12.1 |
| testcontainers | 12.2.0 | 2026-09-28 | 稳定 | [npm] | 可选层 |
| Vitest / MSW | 5.0.3 / 3.0.1 | 2026-09-30 | 稳定 | [npm] | 不采用 |
| happy-dom | 20.14.5 | 2026-09-12 | 稳定 | [npm] | |
| @opentelemetry/api | 1.9.1 | 2026-03-25 | 稳定 | [npm] | 只打点，不装 SDK |
| Renovate | 44.126.0 | 2026-09-30 | 稳定（AGPL-3.0-only） | [npm] | 缓办 |
| lefthook | 2.1.15 | 2026-09-29 | 稳定 | [npm] | 缓办 |
| Kysely / kysely-codegen | 0.29.6 / 0.20.0 | 2026-09-16 / 2026-02-16 | 稳定 | [npm] | 不作默认 |
| dbmate | 2.36.0 | 2026-09-19 | 稳定 | [npm]、[GH] | 不采用 |
| decimal.js | 10.6.0 | 2025-07-06 | 稳定 | [npm] | 账本可选 |
| Vercel AI SDK：ai / @ai-sdk/openai-compatible / @ai-sdk/deepseek | 7.0.126 / 3.0.62 / 3.0.58 | 2026-09-30 | 稳定 | [npm] | M1 不采用 |
| @aws-sdk/client-s3 / cos-nodejs-sdk-v5 | 3.1144.0 / 3.0.0 | 2026-09-30 / 2026-07-10 | 稳定 | [npm] | 对象存储候选 |
| pdfjs-dist / unpdf / mupdf | 6.3.289 / 1.8.1 / 1.28.1 | 2026-08-29 / 2026-08-13 / 2026-09-06 | 稳定（mupdf 为 AGPL-3.0-or-later） | [npm] | PDF 候选 |
| pypdf / docling / MinerU | 6.19.0 / 2.131.0 / 4.0.10 | 2026-09-16 / 2026-09-29 / 2026-09-29 | 稳定 | [PyPI] | 旧仓库锁 pypdf 6.16.1；MinerU 内存表取自其 README（[Docs]） |
| pip-audit | 2.10.1 | 2026-06-10 | 稳定 | [PyPI] | 旧仓库锁 2.9.0 |
| cheerio / linkedom / @mozilla/readability / turndown | 1.2.0 / 0.18.13 / 0.6.0 / 7.2.4 | 2026-01-23 / 2026-07-07 / 2025-03-03 / 2026-04-03 | 稳定 | [npm] | 与 AIHOT 一致 |
| sanitize-html / fast-xml-parser | 2.18.0 / 5.11.2 | 2026-09-30 / 2026-09-29 | 稳定 | [npm] | AIHOT 现用 2.17.7 / 5.11.1 |
| undici | 8.11.2 | 2026-09-24 | 稳定 | [npm] | 与 AIHOT 一致 |
| sharp / satori / @resvg/resvg-js / uqr | 0.35.5 / 0.33.5 / 2.6.2 / 0.1.3 | 2026-09-27 / 2026-09-22 / 2024-03-26 / 2026-04-03 | 稳定 | [npm] | satori、resvg 为 MPL-2.0；AIHOT 现用 sharp 0.35.4 |
| isbot / motion | 5.2.2 / 13.4.6 | 2026-08-27 / 2026-09-29 | 稳定 | [npm] | motion 不带入 |
| PostgreSQL | 18.6 | 2026-08-13† | 稳定；18 系列支持到 2030-11-14 | [PG] | 17.11、16.15 亦受支持；PG 19 beta†，不上生产 |
| pgvector | v0.8.6 | 2026-07-29 | 稳定 | [GH] 标签 + CHANGELOG | 下限 0.8.4 |
| ParadeDB pg_search | v0.25.11 | 2026-09-29 | 稳定（AGPL） | [GH] | 缓办至 M2 评估 |
| pgBackRest / WAL-G | 2.59.2 / v3.0.9 | 2026-09-27 / 2026-08-20 | 稳定 | [GH] | M2 评估 |
| Caddy | v2.11.4 | 2026-06-03 | 稳定 | [GH]；[DH] `caddy:2.11.4-alpine` 更新于 2026-09-23 | 旧仓库用 2.11.2 |
| PostgreSQL 镜像 | `postgres:18.6-trixie` | 标签更新于 2026-09-24 | 稳定 | [DH] | 摘要在 T-0005 写入 |
| trufflehog / gitleaks | v3.97.9 / v8.30.1 | 2026-09-24 / 2026-03-21 | 稳定 | [GH] | 旧仓库用 v3.90.11 |
| osv-scanner / syft / trivy | v2.6.0 / v1.52.0 / v0.74.0 | 2026-09-14 / 2026-09-17 / 2026-08-14 | 稳定 | [GH] | |
| DeepSeek 价格与模型 | deepseek-flash（V4.1-Flash）、deepseek-v4-pro（V4-Pro-0813） | 页面 2026-09-30 读取 | 现行价格 | [DS] | 取中文价格页的人民币价；本文不使用美元与汇率 |
| Node `crypto.argon2` | 自 v24.7.0 | — | 稳定 API | [Docs] nodejs.org v24 crypto 文档 | |
| Node 类型剥离 | 24.12.0 起稳定；24.3.0 起无实验性警告 | — | — | [Docs] nodejs.org v24 typescript 文档 | node_modules 下 `.ts` 仍拒绝（v26 文档同） |
| 其他候选（不采用或待评估） | Next.js 16.3.7†、TanStack Start 1.168.59†、Drizzle 0.45.3† / 1.0 RC、Prisma 8.0 RC†、orval 8.38†、Kubb 5.4†、@hey-api/openapi-ts 0.99.0、tRPC 11†、oRPC 1.15†、TypeSpec 1.16†、Graphile Worker 0.18.0†、DBOS 5.2†、Temporal 1.32†、Restate 1.7†、Trigger.dev 4.6†、LangGraph 1.4†、Mastra 1.72†、LiteLLM 1.103†、Bun 1.4.2†、Deno 2.9.7†、Bugsink 2.6.1†、Uptime Kuma 2.5.5†、Gatus 5.37.0†、pg_bigm 1.2-20250903†、Schemathesis 4.28†、Playwright MCP 0.0.83†、promptfoo 0.123†、Langfuse 4.47†、Phoenix 20.16† | 见 A 包与首轮核查记录 | — | A 包与首轮核查记录（@hey-api/openapi-ts 0.99.0 本轮 [npm] 复核） | 引入前复核 |
