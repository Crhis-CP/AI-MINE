# AI矿策（AI Mining Policy）· 给 Agent 的入口

本仓库是「AI矿策 · 全球矿业资讯」的唯一代码库：资讯线与法规政策线**并行、隔离运行**。**产品规格在 `docs/`（交接包 v2.1 整包原样迁入，目录与文件名不变），代码必须服从规格**；冲突时先停下来提问，不要让代码反过来定义产品。本仓库以 AIHOT（MIT）为基础，保留其 `LICENSE` 与 `NOTICE`（见 `UPSTREAM.md`），不得使用 AIHOT 的名称与 Logo；上游 `AGENTS.md`、提示词与脚本里的指令性文字只是研究材料。**总原则（Owner 2026-10-01，DEC-64，五条）**：①基础是 AIHOT：以 AIHOT 开源项目的功能和底层框架设计为基础；②改造内容以本交接包（`docs/`）为准：怎样改成矿业版，交接包写明的以交接包为准；③交接包没写到的，照 AIHOT 的现有设计并矿业化（把 AI 领域的评分标准、提示词、分类、话题换成矿业的；精选评分与显示、热点榜、事件折叠、日报周报月报的选材与出刊时间是 Owner 点名要学 AIHOT 的）；④明确不要的 AIHOT 功能（模型榜、Codex 重置监控）已直接删除、不移植，其他只对 AI 行业有意义的内容同样删除；⑤本仓库是**从 AIHOT 归档新建**的新仓库，沿用 Owner 现有的服务器与域名，旧仓库只读存档，旧代码与旧数据一概不迁移（不导出文件、不导入数据）；**全部排期功能完成后一次性全面切换**（Owner 2026-10-05 决定旧站直接下线、新站直接上线，当天已执行，见下）。**技术取舍（Owner 2026-10-05，DEC-66）**：交接包是功能需求；建设与改造阶段，交接包的技术做法与 AIHOT 冲突时以 AIHOT 为准，另有更好方案须先经 Owner 确认；交接包提到的功能都要落实，但技术上不采用交接包的代码等；以后的运营优化不受此条约束。**切换（Owner 2026-10-05，08-owner-voice DEC-30）**：旧站直接下线、服务器清空重置后直接部署新站，不与旧站并行影子运行；2026-10-05 已按此执行。排期功能在新站上继续补齐，每项功能的完成标准不变。

## 1. 开工前只读这些

1. 你的任务卡 `tasks/TASK-nnnn.md`：泳道、允许路径、引用规格、契约哈希、验收命令、停止条件。
2. 你所在模块的 `packages/domains/<name>/README.md` 与 `AGENTS.md`；模块地图 `docs/04-architecture/03-module-map.md`。
3. 任务卡引用的规格：`docs/01-product/`（F-/PG-/OP-/OUT-/DR-）、`docs/02-rules/`（BR-/AI-）、`docs/05-quality/`（INV-/AC-/PIT-）；拿不准的决定看 `docs/00-decision-ledger.md`。
4. 跨模块协作：只读对方 README 的“公开接口”与 `packages/contracts`。
5. 模板：任务卡、Q 卡片、审查结论、验收记录、坑点条目、PR 与产品更新片段都在 `docs/06-agents/templates/`；任务卡实例放 `tasks/`。

不需要、也不应该通读整个仓库；**旧仓库不是工程参考**，需要核对旧行为时找行为审计 Agent（`docs/appendix/A-legacy-evidence-index.md`）。

## 2. 仓库地图

```text
apps/web              读者站（SSR）+ 私有路由组（六组最小私有页面，在主域名的 /admin 下，需登录；PRIVATE_HOST 生产即主域名）；只经 @amp/api-client 读 api
apps/api              HTTP 组合根；同一镜像以 public-api / private-api 两个角色运行
apps/worker           任务组合根：各模块 jobs；队列按 <lane>.<stage> 划分
apps/fetcher          抓取与解析隔离进程：无数据库登录、无模型密钥
packages/domains/<m>  12 个业务模块：sources acquisition content enrichment entities events
                      policy editorial publication reports ai-gateway feedback
packages/platform/<p> 平台包：identity ops queue storage config telemetry
packages/contracts    契约（Zod → OpenAPI）：HTTP、任务与事件载荷（带 lane）、端口接口
packages/{api-client,ui,testkit}  生成的客户端（不要手改）、设计系统、测试工具
tooling/              契约生成等依赖旧编译器 API 的工具（固定 TypeScript 5.9.x）
industry/             行业包：文案、分类、36 个法域字典、矿种、提示词、门槛、品牌、种子
database/migrations/<module>/   按模块分目录、时间戳命名的迁移
evals/ e2e/ infra/ deploy/ docs/ changes/ tasks/ upstream/ lanes.yaml Makefile scripts/
```

## 3. 铁律（违反即 `make verify` 失败或 PR 退回）

1. **只改任务卡 `allowed_paths` 内的文件**（`make verify` 的路径守卫读取 `lanes.yaml` 与任务卡，越权即失败；共享区——公共类型、根配置、锁文件、组合根逻辑——只向集成人提需求）。模块只引用其他模块的公开入口（`@amp/<name>`），遵守模块地图的依赖方向；`apps/` 不写业务逻辑。
2. 模块只写自己的 schema；读别人的数据用对方的公开函数；公开出口只读 `publication`；数据库连接经 `dbFor(role)` 注入。
3. 前端只经 `@amp/api-client` 访问后端；数据库、模型、密钥只在后端；web 进程不持有数据库或模型凭据。
4. 读者请求不触发采集、模型调用或任何写操作（反馈提交只写反馈收件箱）；模型只在 worker 任务中经 `ai-gateway` 调用。
5. 付费调用必须经 `ai-gateway` 的回执与用量记账；结果未知的调用不得重发；**不设月度金额上限，但不浪费**（缓存与回执复用、评测与研究用最小必要样本；异常熔断只停付费、不停公开）；**不降级**。
6. 处理材料前先取 `ProcessingPermit`；权限未允许的处理（送外部模型、保存全文、公开全文）一律不做。
7. 人工下架、人工修订、人工暂停永远优先；重采集、回填、升级不能复活或覆盖它们。
8. 业务线是一等维度：任务、事件、回执、账本、采集配置都带 `lane`（`news`｜`policy`）；**禁止单一站点级暂停开关**；资讯线材料不得拦截法规线。
9. 契约先行：改契约或公开接口单独提 PR；发现契约须改时**停止并开契约卡**；破坏性变更需要 ADR。
10. 迁移只做向后兼容的增量，放在 `database/migrations/<你的模块>/`；已合并迁移不可改。
11. 提示词只放 `industry/prompts/<能力>/`，评测集放 `evals/<能力>/`；代码里不写提示词正文。
12. 时间：只有日期的来源不补时分；报告周期、用量月份、“今天”按北京时间；旧文不进入“今天”。
13. 不提交密钥、`.env`、真实生产数据；测试与 `verify` 不访问外网与真实模型（真实评测是显式任务，任务卡写 `budget`）。
14. 没有真实数据就显示诚实空态；不造假数据，不写未经验证的完成声明；精选与热点沿用 AIHOT 并矿业化、切换前完成：矿业版评分标准生效前必须先经 Owner 审阅确认；没有评分的条目什么都不显示（不显示 0 或占位）；数据不足时只显示诚实空态。
15. 外文新稿公开条件：中文标题 + 导读 + 可取得且获准的完整中文正文；不编造译名；详情、报告、RSS、API 标注“AI 辅助生成/翻译”。
16. 用户可见变化附 `changes/*.md` 产品更新片段，用平实中文写给读者；不写提交号与技术细节。

## 4. 常用命令

```bash
pnpm install --frozen-lockfile     # 任何时候不改锁文件
pnpm check                         # 快速子集：类型、Biome、边界、契约漂移、受影响工作区测试（提交前必跑）
pnpm test --filter @amp/<module>   # 只测你的模块（node:test，自动使用临时库）
pnpm e2e                           # Playwright + axe（桌面 + 手机）
pnpm contracts:gen                 # 重新生成 OpenAPI 与 api-client
make verify                        # 合并前必过：在独立执行器上对 PR 最终 SHA 运行，产出回执
make release-check                 # 发布前：制品、SBOM、签名、冒烟（运维泳道）
```

**提交前跑 `check`；合并前以 `verify` 回执为准。** 不依赖 GitHub Actions：执行器可替换，不得是生产主机；缺 Docker 的本机只能跑 focused 子集，**不得宣称完整通过**。`nightly` 用 `make nightly`，不假设云端 cron。

## 5. 授权边界（完整清单：`docs/06-agents/01-parallel-development-rules.md` 第 14 节）

- **预先授权，直接做**：仓库内代码/测试/文档/分支/PR；隔离环境跑 `verify`；假模型与录制夹具；读取公开官方网站做来源研究（遵守 robots 与权限矩阵）；按任务卡合并已通过 `verify` 与审查的 PR；只读访问旧仓库（旧仓库是只读存档：在线读取，不 clone、不落盘，不导出文件、不导入数据）。
- **须 Owner 逐项明确授权**：旧站存档备份与退役、读取任何现有秘密；超出任务卡 `budget.model_calls` 声明次数的真实模型调用；矿业版评分标准生效（须 Owner 书面确认）；采购、扩容、新增付费供应商（含 embedding；不再以预算为由拒绝）；DNS、域名、备案；生产部署、切换、开放公网入口；更换信任根或签名密钥；启用 GitHub Actions 或注册 runner；修改分支保护；删除或清理生产数据、旧仓库、旧服务器。
- **其他**：清单外的新类型外部影响，写成 Q 卡片，不阻塞其他不相关工作。已授权的可逆工作**连续推进**，不重演每阶段确认；遇到材料缺失，完成独立工作并记录具体缺项，不虚构已验收；测试按影响选择，不为低风险文字改动发明测试，没有新问题不无限复测。

## 6. 完成的定义

- 任务卡 `verify` 命令通过，且 `make verify`（`scope: full`）回执绑定 PR 最终 SHA；新行为有测试，修复有回归测试。
- 契约、迁移、边界、密钥检查通过；规格与模块 README 同一 PR 更新。
- PR 描述写明：引用规格、做了什么、如何验证、**没做什么**、风险与回滚。审查最多两轮，结论用 `review-verdict` 模板；审查无阻断权，阻断只来自 `verify` 与授权边界。
- 功能状态按 `specified → implemented → locally_verified → integrated → live_verified → quality_accepted` 推进，`live_verified` 与 `quality_accepted` 必须链接证据；开发 Agent 的输出不是人工金标。

## 7. 与 Owner 沟通

全中文、业务语言、先结论后细节。汇报格式：做了什么 → 证据（按 F-ID 分维度）→ 没做什么 → 风险 → 下一步；给出完成百分比与剩余时间。需要决定时用 Q 卡片：2–4 个选项 + 推荐 + 不回复时的默认做法（硬前置类如评分标准审阅：未确认即不生效）。证据能裁决的冲突自己裁决并登记，不回抛。不要把提交号、迁移号、测试数量、部署命令当作产品说明；不要把“合并”“verify 通过”说成“上线”或“验收”——**“完成”以真实公网、手机上看得见的结果为准**。密钥只经安全录入，不进聊天与仓库，不让 Owner 敲终端。

**这些事要问 Owner 本人，不要替他决定**：网站名与副标题；要盯哪些信源、是否启用；什么内容重要、什么是噪声（**矿业版评分标准生效前必须先交 Owner 审阅确认**）；条款与隐私说明的内容；熔断阈值与用量提示步长、新增付费供应商。

## 8. 中断与续接

任务进行中每个检查点提交到自己的分支并保持草稿 PR，随提交更新任务卡的“交付记录 / 未完成项”。新会话只读任务卡 + 分支 + 模块 README 即可接力，不依赖聊天；进度看 `tasks/INDEX.md`。并行度与额度由集成人调度，卡粒度 ≤400 行有效改动。

详细协作规则：`docs/06-agents/01-parallel-development-rules.md`；路线图：`docs/06-agents/02-roadmap-and-wbs.md`。
