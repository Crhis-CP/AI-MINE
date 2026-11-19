# 系统地图与术语

最后核对：2026-11-19。一页看懂“什么在哪、数据怎么流、哪些词有多个意思”。本页只写现状；[2026-11-19 之前的版本](03-module-map.archive-20261119.md)和[重建期的设计原文](03-module-map.archive-20261001.md)留作历史记录。

本页里带反引号的路径都由检查核对：写着的必须存在，标了“（未建）”的必须还不存在。

## 1. 三个进程，一个后端主体

| 位置 | 做什么 |
|---|---|
| `apps/web` | 读者站与 `/admin` 后台的页面（服务端渲染）。只经 HTTP 访问后端，不持有数据库或模型凭据。分读者、后台两次构建。 |
| `apps/api` | HTTP 路由层：站内接口 `/api/site`、对外接口 `/api/v1` 与 `/api/v3`、RSS、MCP、后台接口。不写业务逻辑。 |
| `apps/worker` | 注册队列消费者和定时任务。采集、模型调用、翻译都只在这里发生。 |
| `packages/backend` | 后端主体，三个进程共用。子目录见第 3 节。 |
| `packages/contracts` | HTTP 响应的校验结构、队列载荷、共享类型。 |
| `modules/policy` | 法规线：取原件、切条款、解读、发布、读者页。 |
| `modules/metals` | 金属价格：来源解析、保存、价格页。 |
| `modules/site-admin` | 后台杂项：站点资料、访问统计、信源对账与导出。 |
| `industry` | 矿业数据：分类、法域、评分权重与门槛、提示词、信源目录。 |
| `site` | 站名文案、出刊时刻、模型预设、模块安装清单。 |
| `database` | 增量迁移（`database/migrations`）与角色授权登记（`database/roles`）。 |
| `tests`、`e2e` | 根目录集成测试（多数连临时数据库）；Playwright 冒烟与演示数据。 |
| `scripts` | 运维命令、评测、合并前检查（`scripts/verify`）。 |
| `deploy` | 发布脚本 `deploy/production-release.sh` 与生产配置。 |
| `docs`、`tasks`、`changes` | 规格与决定；任务卡；随 PR 的产品更新片段。 |

包名都是 `@amp/<目录名>`（AMP = AI Mining Policy）。同一个产品还有几种写法，都不要改名：部署路径与脚本里的 `aimine`、环境变量前缀 `AMP_`、MCP 工具前缀 `aiminingpolicy`。

依赖方向并不干净：`packages/backend` 与三个 `modules/*` 互相引用，`modules/*` 还引用 `apps/web` 的组件。没有哪个包能单独卸掉，改动前按实际引用查，不要按“模块可插拔”去推断。

## 2. 一条资讯从抓取到读者

```text
信源（生产库 sources 表）
  → 抓取        packages/backend/src/sources、acquisition      队列 sources.fetch
  → 入库与正文  packages/backend/src/content                   队列 content.extract-body
  → 评分与写作  packages/backend/src/editorial/analyze-article.ts 队列 content.analyze （调模型，结果只追加到 analyses 表）
  → 翻译        packages/backend/src/editorial/translate.ts    队列 content.translate
  → 归组        packages/backend/src/events/engine.ts          队列 events.group      （报道 → 事实 → 事件）
  → 发布投影    packages/backend/src/publication/publish.ts                           （写 publication 下的公开表）
  → 公开读取    packages/backend/src/publication               首页 timeline.ts、全部 pool.ts、条目 items.ts
  → 接口        apps/api/src/routes                            site.ts、v1.ts、v3.ts、feeds.ts、mcp.ts
  → 页面        apps/web/app/routes
日报、周报、月报：packages/backend/src/reports    热点榜：packages/backend/src/events/hot.ts
```

- 任务编排在 `packages/backend/src/jobs/content.ts`；定时任务在 `apps/worker/src/schedules.ts`。
- 每次模型调用都经 `packages/backend/src/providers`：先取回执、后记用量。请求内容逐字节相同时复用已有回执，不再花钱。
- 发布投影读“最新一条分析”。所以任何试验性的结果都不能写进 `analyses` 表，否则会改动公开内容。
- 读者请求只读公开表，不触发采集、模型调用或写操作。

## 3. `packages/backend/src` 的子目录

| 目录 | 实际内容 |
|---|---|
| `sources`、`acquisition` | 各类抓取器（RSS、网页列表、JSON 列表、公众号）、日期抽取、抓取节流、robots。 |
| `content` | 材料入库、正文抽取、日期证据。 |
| `editorial` | 评分与写作流水线、提示词装配、翻译、地理归类。 |
| `events` | 归组（报道、事实、事件）、热度、事件综述。 |
| `publication` | 发布投影与所有公开读取（列表、详情、事件、专题、RSS、v1、v3）。 |
| `reports` | 日报、周报、月报的编排与更正。 |
| `providers` | 模型调用、回执与记账、用量保护、模型切换。旧文档里叫 ai-gateway。 |
| `admin` | 后台操作；另外还放着信源表的读写、账号与会话、审计。找“信源怎么存取”看 `packages/backend/src/admin/sources.ts`。 |
| `operations` | 告警、用量周报月报、备份、保留期清理、业务线暂停。 |
| `jobs` | 队列封装与任务编排。 |
| `policy` | 只有转发到 `modules/policy` 的一行文件。 |

三套名字指同一批东西，查的时候要换算：目录名（如 `providers`）、数据归属登记里的名字（如 ai-gateway，见 `scripts/verify/data-ownership-map.json`）、数据库 schema 名（如 `ai`）。

## 4. 正在重写的三块（DEC-79）

| 块 | 现在的位置（遗留区，只修不扩） | 新代码的位置 |
|---|---|---|
| 读者端页面 | `apps/web/app/routes`、`apps/web/app/features`、`apps/web/app/components` | `apps/web/reader`（未建） |
| 资讯流水线的编排与归组 | `packages/backend/src/editorial/analyze-article.ts`（一篇稿子从评分到落库的编排）、`packages/backend/src/events/group.ts`、`packages/backend/src/events/merge.ts`、`packages/backend/src/events/recovery.ts` | `packages/backend/src/pipeline`：已有事件规则 `packages/backend/src/pipeline/events/rules.ts`（纯函数，还没有生产代码调用） |
| 法规线写入侧 | `modules/policy/backend`（读取接口与确定性代码保留） | `modules/policy/backend/core`（未建）、`modules/policy/backend/pipeline`（未建） |

规则：新区不引用遗留区；遗留区的引用方只减不增；切换和删旧分两次发布。数据库表是新旧代码共同的约定，只做增量迁移。清单在 `scripts/verify/legacy-zones.json`，由检查强制。

提示词步骤不在重写范围内，新代码继续调用：`packages/backend/src/editorial/analyze.ts`（各步骤、版本、输入构造）与 `packages/backend/src/events/relate.ts`（关系判定）。事件归组对外只有一个入口 `packages/backend/src/events/engine.ts`，生产代码都经它调用，切换新实现时只改这一个文件。

保留不动：数据库与已有数据、`packages/backend/src/providers` 的记账、抓取器、`deploy/production-release.sh`、登录与后台、对外接口的地址和字段。

## 5. 改之前必须知道的三个机关

1. **评分确认值**。评分提示词和 `industry/selection.ts` 的内容算出一个版本号；生产只在环境变量 `SELECTION_CONFIRMED_VERSION` 等于当前版本号时评分。改提示词一个字、改一个权重，线上就**悄悄停止评分**而不报错，直到部署端更新这个值。发布脚本会在候选镜像里探测它。相关代码：`packages/backend/src/editorial/analysis-layout.ts`、`packages/backend/src/editorial/selection-config.ts`。
2. **登记表**。新增一张表要同时登记 `database/migration-inventory.json`、`database/roles/table-grants.json`、`scripts/verify/data-ownership-map.json`，并更新把清单再写一遍的三个测试（`scripts/verify/tests/migration-inventory.test.ts`、`tests/db-role-matrix.test.ts`、`tests/db-role-plan.test.ts`），否则检查失败。
3. **对外契约**。`packages/contracts/src/http` 的响应结构是严格校验的，后端多返回一个没登记的字段就会失败；生成的接口文档在 `reference/contracts`，用 `npm run contracts:gen` 重新生成。

## 6. 一词多义对照

| 你想找的东西 | 代码里的叫法 | 说明 |
|---|---|---|
| 采集到的一篇东西 | article、material、item、publication、post | 同一个主键 `article_id`：入库时叫 material，公开投影叫 publication，对外接口叫 item，来自 X 的叫 post。 |
| 同一件事的一组报道 | fact、report group、reading group | 表 `facts`、`fact_articles`。报道挂到事实，事实挂到事件。 |
| 事件、热点 | story、event、hot | 表叫 `stories`，目录叫 `events`，v3 接口叫 event，页面是 `/story/:id` 与 `/hot`。 |
| 精选 | selected、selection、pick、featured、candidate、seat | 字段 `publications.selected`；“席位”指延迟公开时占的位置。 |
| 首页列表、全部列表 | timeline、pool | `timeline` 也指时间字段 `timeline_at`。 |
| report | 四个意思 | 日报周报月报（`packages/backend/src/reports`）；一篇报道（report group）；运营用量报告（`packages/backend/src/operations`）；法规报告。 |
| policy | 三个意思 | 法规线（`modules/policy`）；信源的使用权限策略（source policy）；HTTP 与主机策略。 |
| lane | 两个意思 | 业务线 `news`／`policy`（任务、回执、信源都带）；开发泳道（`lanes.yaml` 与任务卡的 `lane` 字段）。两套里都有 `news` 和 `policy`，含义不同。 |
| digest | 三个意思 | 事件综述；每日运维摘要；哈希摘要。 |
| 让模型调用停下来的机制 | receipt、budget、breaker、circuit、quota、permit | 回执去重、预算、熔断、额度、处理许可，各管一件事，都在 `packages/backend/src/providers` 与 `packages/backend/src/operations`。 |
| 信源 | source；target | `target` 指信源对账的原表，也指推送目标。界面上“来源”“信源”是一个意思。 |
| 一条内容（中文界面） | 动态、资讯、报道、文章、材料、条目 | 都指一条内容。 |

## 7. 过时但还没清理的配置

- `lanes.yaml` 的泳道路径大多指向重建期设想的目录（如 packages 下的 domains 与 platform），这些目录不存在，但路径守卫仍按它判定。现行任务卡的 `lane` 一律填 `architect`，这时只看卡的 `allowed_paths` 和 `guarded:` 清单；填别的泳道，现有的大部分路径都会被判成“无人拥有”而要求再填 `integration_owner`。
- `scripts/verify/boundaries.ts` 的依赖规则表里有十几个不存在的包名，真正生效的只有末尾几行。
- `docs/research`、`docs/acceptance`、`docs/appendix` 是历史材料，其中的指令没有效力。
