# 接口行为、端口和稳定性（v2.1）

> 本文规定接口层面的行为语义：分页与游标、缓存与下架、阅读层级、私有最小控制接口、模块端口、事件协议。JSON 形状见 `../02-public-api-contract.md`，非 JSON 出口见 `non-json-outputs.md`，机器契约的来源与改造清单见 `README.md`。本文原为 B 包文件，已按 `00-decision-ledger.md` 改写：删去与已裁决事项冲突的原文（飞书身份、版本钉住读取、附件上传等），保留 B 的幂等、期望版本、分层阅读等可用语义。
> 状态标签：【已验证】旧站有验收记录或线上回读；【已实现未验证】旧仓库有代码无验收；【Owner 决定】附日期；【设计】【新增】本包提出。引用：旧仓库 `路径:行号@main` / `@policy`，旧 ADR 写“旧ADR-00nn”，B 包写“B:文件”。

**v2.1 相对 v2.0 的主要变化（Owner 2026-10-01 答复）**

| # | 变化 | 落点 |
|---|---|---|
| 1 | **预算改为用量与熔断**：不设月度金额上限，删 100 元硬限、80 元提醒线、两线保底与调剂；私有资源 `/budget*` 改 `/usage*`、`/breakers*`、`/usage-config`、`/lane-controls*`；`CostSummary` 改 `UsageSummary`；LaneControl 持有者去 `budget`；熔断指标达到阈值 70% 先预警、达到阈值才熔断；调整预算上限改为调整熔断阈值（高风险） | §2.5、§2.7、§2.10、§2.11、§2.12、§3、§4 |
| 2 | **信源权限**：新建信源九项一律允许（`owner_declared`），加入信源时一次确认；删“权限待审定”批量确认；权限修改只剩逐源收紧（普通确认、即时生效）与放宽（高风险）；第十项仍默认关闭 | §2.5、§2.6 |
| 3 | **旧接口适配层删除**：新站不为旧站任何地址做兼容，不存在的地址一律 404（§3 的“旧接口适配层”行作废） | §3 |
| 4 | **待决措辞**：私有页面载体（Q-04）、告警渠道（Q-22）、金属价格（Q-11）改为“Owner 2026-10-01 已定”；备案号与新闻许可证取自受保护运行时配置，不经私有 `settings` 编辑 | §2.1、§2.5、§2.12、§2.14 |
| 5 | **事件目录**：37 个有效类型（§5 引用 `../03-internal-contracts.md` §2.2） | §5 |

## 0. 结论

| 序号 | 结论 | 依据 |
|---|---|---|
| 1 | 内容版本 `content_version` 不透明，不提供“按版本钉住读取”；列表游标绑定筛选，长文阅读游标绑定材料修订与语言表达 | DEC-47 |
| 2 | 站点接口页码分页、公开 API 游标分页，读同一读取层、同一排序 | DEC-23 |
| 3 | 下架 60 秒内全出口不可见，公开响应不设长缓存 | DEC-48 |
| 4 | 私有侧只用“密码的具名账号”，**不用飞书身份**；不设运营台，必要私有操作由最小私有页面承载，运行状态改为告警推送 | 旧ADR-0031（Owner 2026-09-06 修订）、旧ADR-0037（Owner 2026-09-26 批准）、DEC-04、DEC-05、DEC-06 |
| 5 | 私有写操作保留 B 的幂等键、CSRF、期望版本与命令查询；暂停分资讯、法规、全部三个作用域；下架与恢复是独立命令，不混入审核决定 | DEC-34、DEC-54；D04-admin-009、012 |
| 6 | 信源档案按“发布方 → 信源 → 按业务线的采集配置”三层；曾启用过的信源暂停后恢复不要求重新预览 | DEC-34、DEC-57 |
| 7 | 模块端口与事件统一带业务线 `lane`（`news` / `policy`）；公开读取层采用增量投影，不采用 B 的发布代次与清单指针切换 | D18-delivery-002；D05-api-003；ADR-0004 |
| 8 | 私有侧的费用只有“用量与熔断”：不设月度金额上限；用量如实呈现（月度用量报告、每 100 元用量提示，只提示）；异常熔断只停付费、不停公开，熔断指标达到阈值的 70% 先预警，负责人一键恢复；暂停与熔断互相独立 | DEC-08、DEC-09；BR-COST-17～20 |

---

## 1. 公共 HTTP

### 1.1 进程与边界

公共站、Web SSR、RSS、公开 MCP 均走同一公开查询端口；Web 包无 DB/队列/模型依赖。API 可以与 Web 同域反向代理，进程、依赖和授权仍分离。公开内容 GET 不触发采集、模型、发布或业务写入。反馈 POST 属于独立限流收件服务。

### 1.2 列表、筛选、排序与搜索

| 项 | 规则 |
|---|---|
| 默认与上限 | 默认 `view=all`；站点接口 `page_size` 默认 20、最大 50；公开 API `limit` 默认 20、最大 100（取代 B 的上限 50） |
| 多维筛选 | 多个筛选维度 AND；同一维度首期单值，明确需要多选时升级 schema；未知参数、重复参数、超长值返回 400 |
| 日期 | `from`、`to`、`on` 是**北京时间自然日**，闭区间；只有日期精度的条目按来源日期、不平移；来源日期未知的条目仅在未给日期筛选时纳入（取代 B 的“按来源声明日期范围”，DEC-49） |
| 排序 | 来源发布时间可比较键降序、稳定 ID 降序；缺精确时间保留 `date` 精度；未提供日期的条目显示发现时间并标“发现”；不得把入库时间输出为来源发布时间 |
| 搜索 | 搜索全部已发布内容，不能只搜当前页或前 N 条；`facets` 在相同查询、相同快照计算，不凭前端缓存估总数 |
| 收藏 | 引用最多 100 条，`ids` 为逗号分隔；已下架或失效只返回 `unavailable_ids`，不泄露私有下架理由 |

### 1.3 分页、游标与阅读游标

- **站点接口**：`page`（≥1）加 `page_size`，返回 `total`、`has_more`、`facets`、`day_counts`；页码越界返回 200 与空列表。页码请求可带 `seen_version` 仅作比较，版本变化时响应 `version_changed=true`，页面提示“内容有更新”，不隐藏列表。
- **公开 API 游标**：签名游标 = 归一化筛选 hash + 末条排序键（带签名密钥 ID）。**不绑定全站版本**，不因内容版本变化失效；被篡改或与当前筛选不匹配返回 400 `invalid_cursor`；改变筛选即重新从首屏开始；下架在每次查询时过滤。
- **阅读游标（长文分块）**：绑定 `document_revision_id` 与 `expression_id`；材料修订、语言表达或公开资格变化，每次续读重新校验，换版返回 409 `revision_changed`、撤回返回 404/410，客户端整篇重读；迟到的旧语言响应不得污染当前阅读（客户端按 `expression_id` 丢弃）。法规长文每页 20 个节点，页码绑定不可变版本（`docs/policy-upgrade/reader-runtime.md:11-13@policy`）。
- 取消 B 的规则：“游标绑定 `content_version`、`policy_epoch`”“过期或被回收版本 410”“版本不一致 409”。这些规则要求服务端同时保留多个可读历史版本，与增量投影（ADR-0004）不能并存，也会让外部 Agent 翻页时频繁失败（旧站同类问题见 `apps/web/components/cursor-restart-notice.tsx:23@main`）。【设计】

### 1.4 版本、缓存与下架

- `content_version` 是不透明字符串（实现为单调水位），任何投影变更与下架都使其变化；公开响应含 `content_version` 与 `generated_at`，**不含 `policy_epoch`**；站点接口的版本检查另返回不透明的 `suppression_epoch`（撤回代次，只比较是否相等，公开 API 不含，契约 §2.2）；单次请求在一个只读事务内自洽。
- **没有“钉住读取”**：B 各 GET 的 `content_version` 查询参数删除；“列表到详情携带原版本保持阅读连续”删除，详情一律读当前，下架始终使用最新抑制状态。B 的发布代次与清单指针 CAS 切换不采用，读取层采用增量投影。【设计】（D05-api-003、ADR-0004）
- `ETag` 由 `content_version` 派生，下架必然改变；304 前必须确认最新下架状态；公开缓存不得包含 Cookie 响应；缓存键含查询 hash。
- 合法空站返回 200（`state=empty`）；当前公开版本无法确认返回 503 `version_unavailable`，不回退旧缓存；`not_found`、`gone` 的消息净化，不暴露内部存在性。
- **下架生效时限**：下架事务提交后任何出口的下一次源站响应都不含该对象；JSON 与 RSS 用 `max-age=0, must-revalidate` 加 `ETag`，HTML ≤ 60 秒，不使用 `stale-while-revalidate`/`stale-if-error`；**60 秒内所有出口不可见**；已打开页面的续读与重新核对收到 404/410/409 时整篇退出（失败关闭）。【设计】（DEC-48；对照旧站读者接口一律 `no-store`，`apps/web/lib/reader/adapter.ts:62@main`）

### 1.5 阅读与对象层级

动态按来源稿阅读，事件页展示聚合关系，政策页展示文书版本与解读。完整中文与导读必须在 DTO 的 `mode`、`state`、`completeness` 中区分；`partial` 不能在界面上改名为全文。第三方原文、官方中文、AI 译文、项目解释分层。`Reading.mode=original` 配合 `language` 表示任意语言原文，语言代码采用 BCP 47。中文正文有三种来源并分别标注：来源中文原文、官方中文译本（注明发布机关）、AI 翻译（非官方译文）；存在官方中文文本时不生成 AI 译文。

- **五种不同的对象**：PolicyInstrument（稳定身份）、PolicyVersion（法定版本）、PolicyExpression（语言表达）、DocumentRevision（材料修订）、`content_version`（全站公开内容水位）。政策详情列出 `versions`、`expressions` 及当前选择；可传 `policy_version_id`、`expression_id` 选择历史版本及语言，失效语言不得回退到别的语言显示。
- 长文通过 `/items/{id}/reading` 或 `/policies/{id}/reading` 按块读取；`resource_completeness` 描述整个材料而非本页；完成段数等于完整目录应有段数才能标 `complete`，这个跨字段不变量由领域与契约测试验证，JSON Schema 不独自证明语义完整。
- `ReadingBlock.text` 是纯文本；`table_rows` 表示矩形单元格；复杂合并表格与原件图件还需要实施阅读组件时补充可访问块协议并冻结样例，不能静默扁平化后宣称保真。该精细块协议是明确接线工作，与原件完整性要求同时验收。
- 中文阅读三态由 `Reading.state` 表达（可读 / 正文正在补齐 / 仅导读），`guide_only` 另带原因枚举，见契约 §3.4。

### 1.6 法规列表与解读

法规列表筛选：国家/地区（`jurisdiction`）、七经营主题（`theme`）、文书性质、立法阶段、施行状态、日期范围、关键词（契约 §3.8）。原文或附件不完整时可展示已核验的基本事实，但 `interpretation_state` 不得为 `complete`；决定性附件缺失时不发表确定性结论。**法律状态分维记录**（性质、立法阶段、公布、施行、适用、截止、废止），每一维可为“未知”并带依据；未知是合法状态，不能从日期自动推断生效（DEC-36）。公开影响以结构化 `PolicyImpact` 给出，不输出数值分，不做特定企业定向结论（DEC-11）。

### 1.7 署名、AI 标识与再分发

公开条目带 `attributions`，RSS 与 MCP 文本前置署名；AI 标识 `ai_label` 只有 `ai_generated` 与 `ai_assisted_human_edited` 两种含义，任何出口不出现“已复核/已核实/已审核”（DEC-38）。权限矩阵取 DEC-58 的九项，另预留第十项 `syndicate_fulltext`（站外再分发全文/译文；不在 Owner 2026-10-01 许可声明范围内，仍按 Q-47 默认关闭：默认未知即禁止）；启用前公开 API 阅读分块、全文 RSS、MCP 一律只给导读与原文链接，启用后只对“允许”的来源返回正文，站点接口按站内展示许可判断（契约 §2.9）。

### 1.8 错误

统一体 `{code, message, request_id, retry_after_seconds?}`，错误码表见契约 §2.7。`unauthorized`（401）、`forbidden`（403）、`conflict`（409）仅用于私有接口。429、503 必须带 `Retry-After` 头。

---

## 2. 私有最小控制接口

### 2.1 载体与边界

- **不设日常运营台**，也不另起独立 admin-web 应用与子域（改写 A 的 ADR-0008）。必要的私有操作由“最小私有页面”承载，随 reader-web 与 api 在主域名的 `/admin` 下提供（ADR-0026）；页面分六组，只做：账号、信源（增停与预览，含加入信源时的许可一次确认与逐源收紧）、内容（下架/恢复/修订）、用量与模型密钥（用量与熔断、模型接入与密钥、告警渠道地址的安全录入）、反馈、网站资料。**不做**总览、审稿关卡、审计页。运行状态改为告警推送与只读运维 MCP（§2.12）。【Owner 决定】2026-09-26（旧ADR-0037:21,37-38@policy；`docs/policy-upgrade/operations-exit.md:6-17@policy`；DEC-04、DEC-30）。Owner 2026-10-01 已定（Q-04，A）：载体就是上述最小私有页面，不设日常运营台。
- 私有接口前缀 `/api/admin/*`，只在 `PRIVATE_HOST`（生产即主域名）的私有路径可达；登录接口在 `/api/auth/*`；其他主机名访问私有路径一律 404 且不带 `Set-Cookie`，拒绝名单其余路径在任何主机名都是 404；私有响应 `private, no-store`（ADR-0026）（INV-25）。B 的 `/private/v1/*` 前缀不再使用，其语义（幂等键、CSRF、期望版本、命令查询）整体移植为 §2.4。

### 2.2 身份与会话

| 项 | 规则 | 依据 |
|---|---|---|
| 登录方式 | **只用密码的具名账号**；不设动态码、不预留界面入口；AIHOT 的飞书登录代码保留、默认关闭，不进私有接口契约，接入时另立任务并开契约卡（Owner 2026-10-02）；本契约里飞书只作告警渠道（群自定义机器人为主，Owner 2026-10-01 已定，Q-22）。删除 B 的“身份首选飞书 open_id/union_id 允许列表” | 旧ADR-0031:65-71@main（Owner 2026-09-06 修订选定 password-only）【Owner 决定】；DEC-05 |
| 人类角色 | 负责人（唯一）与管理员（具名）；`observer` 只作机器只读身份（只读 MCP、健康读取），不作为人类必备角色 | DEC-32 |
| 口令 | 至少 12 个字符，Argon2id 存储；不提供邮箱或短信自助找回 | D15-secops-011（沿用 D04-admin-002 定稿值） |
| 会话 | 服务端会话（只存令牌摘要），空闲 30 分钟、最长 12 小时；`__Host-` 前缀 Cookie（Secure、HttpOnly、SameSite=Strict、host-only）；授予或撤回能力、停用账号、重置口令使该账号旧会话失效 | D04-admin-002、013；OP-01 |
| 登录限流 | 同账号 5 次/15 分钟，同来源 20 次/15 分钟，限流在计算口令之前执行；账号不存在与口令错误提示相同、耗时一致；**全站登录总量**超阈值只触发告警与逐步延迟，不直接拒绝已通过账号与来源限流的请求（避免任何人换来源提交 30 次就让负责人登不上） | D04-admin-002、021；OP-01 |
| 首个负责人 | 由部署方在服务器侧**一次性**开通：生成一次性初始密码，经 Owner 本人可见的安全渠道交付，初始密码不写入日志、聊天或仓库，**首次登录强制改密**；系统中已存在负责人时开通动作恒为拒绝；**没有任何公共 HTTP 开通端点，也没有设置令牌或设置链接**；执行开通的部署流程本身没有登录能力；旧站账号不存在于新站（旧数据一概不导入，DEC-20），其余管理员由负责人创建。审计记录首个负责人开通与首次改密 | 旧ADR-0031:71@main（Initial provisioning has no public HTTP endpoint）；DEC-43；OP-01 |
| 负责人口令遗失（break-glass） | 只能由 Owner 本人经受保护通道（云控制台 TAT 会话）触发一次性“重置并强制改密”固定脚本；执行即：写审计、推送告警、撤销该账号全部会话、**清除该账号的登录限流桶**、生成单次有效的临时口令（**15 分钟内未使用即作废**，首次登录强制改密）；临时口令只在 Owner 屏幕显示一次，不经聊天传递；每季度演练一次，记录进入备份/恢复演练同一张表。管理员口令由负责人重置，不做自助找回 | D15-secops-011；`04-architecture/06-security-and-access.md` §3.1 |
| 私有账号操作 | 登录、退出、创建管理员、重置口令、停用/启用、修改自己的口令，共六个 | D04-admin-002 |
| 机器身份 | 服务身份（worker、只读 MCP）不依赖浏览器会话；机器行为与人类行为使用不同 actor；服务身份按 source/content/model/publication 职责分开 | B:contracts/interface-behavior.md §2 保留 |
| 账号数上限 | 可配置默认值 100，不照搬旧后台的固定上限 | D04-admin-013 |

### 2.3 角色与能力

服务端对每个写操作校验能力，路由与领域命令两层都验证。

| 能力 | 负责人 | 管理员 | 说明 |
|---|---|---|---|
| 内容修订与下架/恢复 | ✓ | 默认具备 | 见 §2.8 |
| 异常重试（自动处理失败清单） | ✓ | 默认具备 | 见 §2.5 |
| 反馈处理 | ✓ | 默认具备 | |
| 信源配置（增、停、预览、编辑，含加入信源时的许可确认与逐源收紧） | ✓ | 默认不下放 | DEC-32：信源维护默认负责人专属；是否可授予由 Owner 另定 |
| 用量与熔断、账号、网站资料、审计读取 | ✓ | 不可见 | 账号上限、口令重置、熔断恢复与阈值修改等只限负责人 |
| 模型配置 | ✓ | 负责人可按人授予 | 沿用旧实现；替换密钥只限负责人 |
| 审稿 | ✓ | 随审稿工具（默认关闭，不排期） | DEC-14 |
| 人工精选（加入/取消）、精选评分标准与校准记录读取、精选校准标注与 Owner 审阅确认（M3） | ✓ | 不可见 | 仅负责人（OP-09 第 6 项、OP-11 第 8 项、OP-12 第 5 项；BR-SEL-09）；本组资源见 §2.5 |

### 2.4 写操作约定

所有私有写带幂等键（`Idempotency-Key`）、CSRF（`X-CSRF-Token`）和期望版本（`expected_version`/`expected_revision`）。语义：同键同规范化负载返回原结果；同键异负载 409 `conflict`；超时先查询 `request_id`，不盲目重复。`GET /api/admin/commands/{id}` 按返回的 `request_id` 或调用者原始幂等键查回，查询限定 actor；`result_ref` 给出创建或修改的资源身份。每次操作的数据库效果与审计成对提交；202 只表示已接受，必须读回 `completed` 及 `result_ref` 才能显示完成；已完成可直接 200 返回 `Accepted`；结果 `unknown` 保留未知，不显示失败并重发。RBAC 与 CSRF 失败返回 403，会话失效返回 401（§2.13）。

### 2.5 必须保留的私有操作清单

旧站已上线验证的必要私有操作，B 原稿没有规格，现逐项移植（只搬【已验证】【已实现未验证】【Owner 要求】条目，不搬【新增】【设计】，D04-admin-003），并与 `01-product/04-private-operations.md` §7.2 的私有接口清单逐组对应。接口资源均在 `/api/admin` 之下；页面编号以 `04-private-operations.md` §3 为准（原 OP-10 异常页已废止并入 OP-09）。

| 操作（页面编号） | 要点 | 接口资源 | 状态 |
|---|---|---|---|
| 登录、账号管理、我的账号（OP-01、OP-15、OP-16） | 六个账号操作（§2.2）；账号列表、创建管理员、授予/撤回“模型配置”、停用/启用、重置口令、改自己口令；首个负责人开通不经 HTTP（§2.2） | `session`、`accounts`、`accounts/{id}`、`accounts/{id}/password-reset`、`me/password` | 【已验证】旧站 |
| 信源（OP-03、OP-04、OP-05、OP-07） | 创建只填三项（法域、名称、网址），其余由系统检测；**加入信源时由负责人一次确认“该信源已获得许可”（`permission_confirmed=true`，一次勾选），系统生成权限版本 1：九项一律允许、证据 `owner_declared`、不设到期（DEC-33）**；预览只排队；状态动作 `activate`（仅首次）/ `resume` / `pause` / `archive` / `preview`，按业务线（§2.6）；配置编辑分两类；权限修改（九项逐源逐项：**收紧**为普通确认、即时生效并显示受影响的已公开内容数，须写依据类型 `source_objection` / `owner_instruction` / `legal_requirement` 与依据摘要；**放宽**为高风险，仅负责人）；http 例外（高风险）；发布方身份确认；原表对账读取与导出 | `source-profiles`、`source-profiles/{id}`、`source-profiles/{id}/actions`、`source-profiles/{id}/permissions`、`sources/{id}/identity`、`source-targets`、`source-targets/export` | 【已验证】旧站（启停、预览、编辑）；创建三项与加入时一次确认、逐源收紧与放宽、身份确认、对账导出为【设计】；“权限待审定”批量确认（`source-permissions/confirmations`）v2.1 删除 |
| 内容（OP-09） | 六个状态页签语义、按状态查找、人工修订（字段与发布门：原文事实片段 + 两项确认；修订状态取 `effective` / `needs_review`（基础材料被来源新修订取代，仍按人工优先展示）/ `conflict`（与新自动稿事实冲突，冲突期间人工稿不得作公开依据）/ `superseded` / `withdrawn`）、单独核查事实冲突、下架/恢复确认与原因 | `content`、`content/{id}`、`content/{id}/revisions`、`content/{id}/publish`、`content/{id}/conflict-checks`、`suppressions`（§2.8） | 【已验证】旧站 |
| 失败步骤安全重试（OP-09） | “自动处理失败”清单与三种恢复建议，未知付费调用不自动重发，无批量重试，无需日常人工点按钮 | `jobs`、`jobs/{id}`、`jobs/{id}/recover` | 【已实现未验证】 |
| 模型接入与密钥（OP-12） | 接入字段、密钥指纹（不可回读）、价格表条目（分时段单价、币种、`observed_at`、`valid_until`；未填单价或价格过期不可启用）、连接测试、主备路由（回退延后）、可授予“模型配置”权限 | `models`、`models/{id}`、`models/{id}/actions`（`enable` / `disable` / `test`）、`model-routes`、`model-credentials` | 【已实现未验证】 |
| 用量与熔断（OP-13，原“预算与暂停”） | 本月用量（已确认、已预留、未知占用、本地复用、供应商缓存五类分开，按业务线 / 能力 / 信源 / 用途明细）、月度用量报告历史与每 100 元用量提示记录、熔断状态与指标预警（达到阈值 70%）、熔断一键恢复（仅负责人）、熔断阈值与用量提示步长配置（仅负责人，高风险）、结果未知费用逐笔核对；人工暂停/恢复（§2.7）同页 | `usage`、`usage/reports`、`usage/unknown-receipts/{id}`、`breakers`、`breakers/{id}/recover`、`usage-config`、`lane-controls`、`lane-controls/actions` | 【已验证】旧站账本与暂停（旧站的预算上限与保底不沿用）；熔断、预警、用量报告与按线暂停为【新增】 |
| 读者反馈（OP-14） | 列表、状态与内部备注更新、截图读取（私有，短时效，不送模型）、每周汇总（不含联系方式与截图） | `feedback`、`feedback/{id}`、`feedback/{id}/screenshot`、`feedback/digests` | 【已验证】旧站；周汇总为【设计】 |
| 网站资料（OP-17） | 关于、联系方式、官方入口（含金属价格官方入口）的读取与保存（带版本）；ICP 与公安联网备案号、新闻许可证信息取自受保护的运行时配置，不在此编辑（BR-SITE-03）；产品更新登记由发布流水线幂等重试加告警承担，不设“补记”页面 | `settings` | 【已实现未验证】 |
| 告警渠道（OP-20） | 录入与测试告警地址（只写、回读只显示指纹）；未送达列表 | `alert-channels`、`alert-channels/test`、`alerts/undelivered` | 【新增】DEC-06 |
| 审计读取 | 有界分页、脱敏、无正文无密钥；仅负责人，不设审计页，供只读运维 MCP 使用 | `audit` | 【设计】 |
| 命令查询 | §2.4 | `commands/{id}` | 取自 B |
| 审稿（OP-11，默认关闭） | §2.9 | `reviews`、`review-batches`、`review-tool` | 【设计】 |
| robots 例外（OP-04） | 默认不抓 robots 明确禁止的路径；负责人可凭许可逐源覆盖：在配置里写 `robots_exception {path_prefixes[], basis_note}`，**高风险确认**（§2.10），仅负责人，必填依据，写审计；只对声明的路径前缀生效、不影响其他信源，随配置版本留痕 | `source-profiles/{id}`（`PUT`，字段 `robots_exception`） | 【设计】DEC-33；T-142 |
| 候选信源（OP-03“候选信源”页签，M3） | 系统（AI-15 研究、覆盖缺口）提出的候选；点“加入”才产生采集（走与 `POST /source-profiles` 相同的创建与一次许可确认），点“忽略”后 90 天内不再出现；没有任何自动路径能启用信源或把权限设为“允许”；发起“AI 检索新信源”为付费请求，确认框显示预计费用，受用量记账与异常熔断约束 | `source-candidates`、`source-candidates/{id}/actions`（`adopt` / `ignore`）、`source-candidates/research` | 【设计】F-SRC-09 |
| 人工精选（OP-09 第 6 项，M3） | 仅负责人可手动加入或取消，普通确认；加入时精选公开时刻（`visible_after`）为加入时刻，取消时精选同步（`featured/changes`）出现 `remove`；记录决定人、时间与原因；不依赖评分标准，没有评分的不显示分数 | `content/{id}/featured`（`PUT`，`{featured: true \| false, reason, expected_version}`） | 【设计】BR-SEL-02 第 7 点 |
| 精选评分标准与校准记录（OP-12 第 5 项，只读，M3） | 当前线上生效的评分标准版本（提示词内容哈希）、各版本的审阅状态（草案 / 已通过 / 改后再审 / 不通过）、最近一次留出集检查，以及两者所指版本是否等于线上生效版本（切换门槛核对）；仅负责人 | `selection-standards`、`selection-standards/{version}`（只读） | 【设计】BR-SEL-09；ENT-84 |
| 精选校准（OP-11 第 8 项，M3，默认关闭） | Owner 标注（该选／不该选／两可；只显示标题、正文与发布时间，不显示来源名、信源分级、转载数与旧分数）；校准运行结果读取（只读，**没有“运行评测”接口，浏览不触发付费调用**）；Owner 审阅确认（对评分标准版本点通过／改后再审／不通过，及留出集检查的确认，写审计，每次一条 ENT-84 记录） | `selection-samples`、`selection-samples/{id}`（`PUT` 标注，带样本修订号）、`selection-runs`、`selection-runs/{id}`、`selection-runs/{id}/results`（只读）、`selection-reviews`（`GET` 列表；`POST` 仅负责人：`{kind: standard_review, standard_version, status: approved \| changes_requested \| rejected, note}` 或 `{kind: holdout_confirm, calibration_id}`） | 【设计】BR-SEL-08、BR-SEL-09；ENT-84 |

写操作一律有确认：普通确认（确认框写明后果；下架、归档、切换模型需写原因）与高风险确认（§2.10）。内容页的“人工修订”先保存为**尚未发布的修订**，公开必须经同一个“确认并发布”门（D04-admin-008）。

### 2.6 信源档案语义

- **三层模型**：发布方 → 信源 → 按业务线的采集配置（profile）。`/api/admin/source-profiles` 及 `SourceConfig.id` 指 `profile_id`，`source_id` 单列；`lane`、`entrypoint`、管理态 `admin_state`（`draft` / `active` / `paused` / `archived`，B 原件叫 `state`）与健康态 `health`（`healthy` / `no_new_content` / `degraded` / `blocked` / `unknown`，由采集结果推导、不可手工设置、也不阻止任何管理转移）两轴分开，都归 profile（`01-domain-model.md` ENT-56）。新闻与法规可共享 `source_id`、用不同 `profile_id`；`SourceAction` 只作用于指定 profile；来源身份的全局撤销另用显式 identity/policy 命令，普通暂停不能暗含两个业务线一起停。profile 新建 `expected_version=0`，编辑必须带当前版本。【设计】（DEC-34，`docs/policy-upgrade/operations-exit.md:30-31@policy`）
- **首次启用门**：当前配置版本在 24 小时内预览通过且样例至少 1 条。**曾启用过的信源**：暂停不使其资格失效，恢复（`resume`）不要求重新预览，只重验权限未被收紧、未归档；归档为终态。`SourceAction.action` 取值 `pause`、`resume`、`activate`（仅首次）、`archive`、`preview`。删去 B 的“暂停使预览失效、激活重验预览版本”，它会重现旧站 2026-09-21 修掉的“暂停后无法恢复”缺陷。【设计】（DEC-57，D04-admin-007）
- **编辑分两类**：名称、说明、许可说明等不影响采集的字段保存即生效，不暂停、不清游标、不要求重新预览；入口、获取方式、分页规则等生成新配置版本，新版本预览通过并确认切换前旧版本继续采集。
- **保留 B 的三句**：预览必须走生产同一获取路径，fixture 不计真实预览；运行中任务提交前重验状态（暂停与取回并发不得写入过期结果）；来源变更与运行控制受控。
- **入口协议**：原始网址原样保存；采集入口默认必须 https，系统先尝试同主机 https；确认该站不提供 https 时，负责人可用**高风险确认**为单个信源开“仅 http”例外（`insecure_transport_exception`），记录依据与审计，且此类信源的内容不得作为“官方原文”的唯一完整性依据。【设计】（DEC-56，D04-admin-018）
- **权限矩阵九项加预留的第十项**：`fetch`、`store_metadata`、`process_locally`、`store_fulltext`、`external_model`、`public_excerpt`、`public_summary`、`public_original_fulltext`、`public_translation`（DEC-58 九项）；另**预留**第十项 `syndicate_fulltext`（站外再分发，不在 Owner 2026-10-01 许可声明范围内，仍按 Q-47 默认关闭：默认未知即禁止，写入契约中为可选字段，契约 §2.9）。每项 `allow` / `deny` / `unknown`：**新建信源九项一律 `allow`，证据 `kind=owner_declared`，不设自动到期**（Owner 2026-10-01 已定“全部都获得许可了”，DEC-33）；`deny` 只由逐源收紧产生；`unknown` 只用于第十项默认值与缺少权限版本记录（失败关闭），未知按禁止且只关这一层。每个权限版本带证据（含 `kind`）、确认人与时间、范围条件与署名义务、附件是否在范围内；只有带明确期限的补充证据才有 `expires_at`，该证据所支撑的用途到期后按禁止处理，`owner_declared` 不设到期。**加入信源时一次确认**（负责人，一次勾选，不逐项填写）生成权限版本 1。**收紧**（允许→禁止）为普通确认、即时生效并显示受影响的已公开内容数，已公开的全文或译文随之撤回；**放宽**为高风险，只限负责人，必附依据（异议撤回或指示解除）并写原因，只对之后的处理生效；每次变化形成新权限版本。v2.0 的“权限待审定”批量确认、三类自动规则与“未知按禁止”默认作废（BR-SRC-31 已废弃）。B 的 `PolicyScope`（权限）改名 `SourcePermission`，避免与 `/policies/scope`（法域范围）重名。

### 2.7 暂停作用域

暂停是**带持有者的记录**（LaneControl，`01-domain-model.md` ENT-54），不是站点级单一开关：

- **作用域** `lane`：`news`（资讯线）、`policy`（法规线）、`all`；**开关** `switch`：`collection`（采集）、`processing`（处理，含付费模型调用）、`publication`（公开），三个开关互相独立；页面上的“仅新的模型处理”对应 `processing`，“全部自动处理”对应 `collection` 加 `processing`（暂停期间公开内容照常可读、私有页面照常可用，`publication` 与“紧急全停”不在日常页面上）。
- **每条记录**：`holder`（`owner` / `deploy` / `system`；原 `budget` 持有者随月度金额上限一并取消）、原因、操作人、到期时间、行级 `revision`（比较交换）。人工经 `POST /lane-controls/actions` 只能写 `holder=owner`；部署保护只创建与释放 `holder=deploy` 的暂停，释放时对 `revision` 做比较交换，版本已变则不恢复并推送告警。`GET /lane-controls` 返回当前生效的记录。**异常熔断（§2.11、ENT-82）是独立于暂停记录的另一套状态**，不写入 LaneControl，二者互不覆盖：恢复熔断不解除人工暂停，解除人工暂停也不恢复熔断。
- **规则**：暂停必带原因与到期时间，到期未恢复即告警、不自动恢复（INV-30）；暂停全部业务线的全部自动处理最长 24 小时、可续期；暂停**单条**业务线为普通确认，暂停 `all` 为高风险；**不设月度金额上限，没有预算触发的暂停**（DEC-08）；在途结果写回前核对 lane 控制修订，已暂停的线只结算费用、不晋升结果。数据结构从第一个里程碑起就带业务线字段，不做单一站点级开关（旧站的 `site_settings.processing_paused` 是反例，新站没有这个开关）。
- **验收**：暂停资讯后，法规任务仍被领取、入库并公开（B 旅程 4；D18-delivery-002 的 AC）。【设计】（D04-admin-012；ENT-54）

### 2.8 下架与恢复

下架与恢复是**独立命令**，不混入审核请求：

- 对象为稳定身份：文章、事件、发展线、报告刊期；法规线另有文书版本、语言表达（永久撤回，已撤销的资格不得复活，D10-data-003）。字段为原因码 + 补充说明 + `expected_version`；原因码共七类：版权或来源要求、事实错误、与矿业无关、重复内容、质量问题无法阅读、隐私或安全、其他（可补充说明；代码名转写时按 OP-09 定）。下架分两步确认：先列影响范围（对象、成员数、将停止展示的出口），再选原因并确认；管理员也可操作。
- 恢复命令返回实际恢复的对象与受影响成员数。**每条下架记录独立，恢复一个对象不连带恢复另一条独立下架记录；成组下架保存当时的成员快照**（INV-03）。
- 下架覆盖所有渠道，重采集、回填、重处理、软件升级都不能复活。“下架”专指本站人工撤下；原发布方删除原文称“来源撤稿”，“撤回/废止”只作法律状态值（术语统一，D19-decisions-011）。【设计】（D04-admin-009，旧ADR-0031/0032）

### 2.9 人工审核

- 审稿工具**默认关闭**，不作为发布关卡（DEC-14）；只用于建设期抽样与标注，整体属第三层（不排期）。审稿对象有两种并分别标注：抽样已公开稿（新设计，未验证）与试验稿（旧ADR-0036，已实现未验证）。
- `ReviewRequest`：`subject_type`（`item_revision` / `event_revision` / `policy_version`）、`subject_id`、`expected_revision`、`decision`、`reason`、`corrections`、`clear_fields`、`reviewed_fields`。
- **`decision` 固定四选**：`accept`（通过）、`correct`（改一下）、`drop`（不收录）、`hold`（暂放）；`drop`、`hold` 需要理由；`drop` 且勾选“是否收录”时在同一事务产生抑制；**`suppress`/`restore` 不在 `decision` 内**。
- **`reviewed_fields` 维度枚举**（键取旧站实现，`services/live_pipeline/content_review.py:16-18@main`，界面标签见 `apps/web/components/admin-live/content-review.tsx:44-68@main`；全包唯一维度表见 `06-content-standards.md` DR-99）：`admission`（是否收录）、`facts`（事实）、`language`（中文表达，可带子项 `title` / `guide` / `translation`）、`entities`（名称与主体）、`clustering`（事件关系）；新增第六项 `dates`（日期）；`legal_state`（法律状态）与 `interpretation`（条款解读）随法规线加入；`selection`、`impact` 作保留值，对应能力上线前界面不出现。第一轮写作的 `chinese_expression`、`names_subjects`、`event_relations` 作废，沿用旧站的键名，避免与旧站审核反馈、评测样本的键名不一致。
- 规则：未勾选的维度保持“未审核”；语言更正不等于事实认证；审核意见不自动改规则（旧ADR-0036:23-24@main）；`approve` 不能豁免版权、身份或证据真实性；正常内容无需人工 `accept`。
- `corrections` 只接受显式允许的修订字段，不接受任意 JSON Patch 或 SQL；缺字段表示不修改，`clear_fields` 明确清除允许为空的字段，同一字段既设置又清除返回 400。“改一下”保存为尚未发布的修订（§2.5）。【设计】（D04-admin-008、014）

### 2.10 高风险确认

压成两级以匹配最小载体：**普通确认**（确认框写明后果；下架、归档、切换模型需写原因）与**高风险确认**（仅负责人，先列影响范围再写原因）。高风险操作：批量暂停信源、归档或退役信源、放宽信源使用范围、替换模型密钥、调整异常熔断阈值与用量提示步长（`PUT /usage-config`）、全局暂停、开“仅 http”例外、开 robots 例外。普通运营不做审批，不要求第二人批准；每次高风险操作一发生就推送给 Owner（§2.12）。【设计】（D04-admin-010）

### 2.11 用量、熔断与模型（原“费用、模型与预算”）

- **不设月度金额上限**（Owner 2026-10-01 已定：“预算无上限，但是不要浪费”，DEC-08、DEC-09；BR-COST-17）：付费调用不因累计金额（当日、当月、累计）而停止、排队或降级，“预算不足”不再是任何内容不处理、延后或降级的理由；“不降级”保留（外文稿完整中文、法规全文理解都按规格做）。积压时的处理顺序仍是“法规 > 官方一手 > 其他”，**没有保底额与调剂额**。旧站的 100 元硬限、80 元提醒、两线保底与调剂全部作废（旧站在切换前自行运行，与新站无关）。
- **`UsageSummary`**（`GET /usage`，原 B 的 `CostSummary`；字段语义见 `../../02-rules/05-cost-and-budget.md` BR-COST-03 第 7 点）：`period`、`timezone`、`currency`；已确认 `settled`、已预留 `reserved`、未知占用 `unknown_reserved`（笔数 `unknown_count`）、本地复用 `local_reuse_count`、供应商缓存 `provider_cache_hit` / `provider_cache_miss` 五类分开；`manually_paused`（负责人人工暂停）；`breakers[]`（当前 `open` 的熔断：范围、触发条件、触发数值与阈值、恢复入口）；`indicators[]`（三项熔断指标的当前值、阈值、占比与状态 `level`：`normal` / `warning` / `tripped`）；`by_stage`（按环节的次数、费用、平均耗时、成功率，合计等于已确认）、`by_lane`（各业务线的已用、预留、排队中的付费工作数与预计所需金额，**不含保底额与调剂额**）、`by_capability`、`by_source`、`by_purpose`（生产 / 研究 / 评测 / 试验）；`notices[]`（本月已推送的用量提示）。**不再有** `limit`、`warning_threshold`（提醒线）、`remaining` 与任何保底字段。**全部金额字段用整数微元**（1 元 = 1,000,000 微元，字段名带 `_micros` 后缀，币种 `CNY`），B 原件的字符串小数作废；回执与账本分录带 `lane`、能力、信源与 `purpose`（BR-COST-14、BR-COST-18）。
- **异常熔断与预警**（BR-COST-20、ENT-82、ENT-83；防故障烧钱，不是预算上限）：下列三个触发条件任一满足即开启熔断——①同一输入 1 小时内重复付费调用 ≥3 次；②单篇资讯材料累计费用 >5 元，或单份法规文书累计 >100 元；③单日总费用超过过去 7 日日均的 3 倍且 >50 元（没有历史数据时以单日 200 元为界）；阈值是默认值，放在受控配置里。**预警在熔断之前**（Owner 2026-10-01 确认）：任一指标达到其熔断阈值的 70%（预警比例，默认 70%，在受控配置里可调；计数类指标取整数且小于阈值，例如 ① 的预警线为 2 次，复合指标 ③ 的两个分量各按预警比例计，口径同 `../../01-product/04-private-operations.md` OP-13）时先推送预警，只提醒、不暂停（`indicators[].level=warning`），达到阈值才熔断（`tripped`，`BreakerState.state=open`）；预警与熔断都走告警渠道，写明是哪一项指标、当前数值、涉及的能力或来源。熔断**只停被点名范围内新的付费调用**，不停已公开内容、原生中文直出与不需付费的环节；**不会自动恢复**，由负责人在“用量与熔断”页一键恢复（`POST /breakers/{id}/recover`：仅负责人、只恢复被点选的范围、备注必填、写审计并推送恢复通知，为普通确认；恢复不改变阈值，同一条件再满足会再次熔断）；熔断与人工暂停、部署保护暂停互相独立、互不覆盖（§2.7）。熔断配置缺失或不可读时拒绝发出付费请求并告警（fail-closed）。
- **用量与熔断接口**：`GET /usage`、`GET /usage/reports`、`GET /usage/reports/{month}`（月度用量报告历史：费用、调用数、缓存命中率、单篇成本、最贵的 10 个任务，确定性汇总、不调模型，BR-COST-18）、`GET /breakers`、`GET /breakers/{id}`、`POST /breakers/{id}/recover`、`GET /usage-config`、`PUT /usage-config`（`UsageControlConfig`：熔断阈值与预警比例、用量提示步长（默认每 100 元，只提示、不暂停）、用量报告推送时刻、速率限制、未知占用告警；仅负责人，**高风险确认**，带 `expected_version` 与原因，修改不部署即生效并写审计与配置版本；**没有月上限、提醒线、保底额与调剂额字段**；任务、Agent、默认值不得隐性放宽）、`POST /usage/unknown-receipts/{id}`（逐笔核对）。暂停/恢复见 §2.7（`/lane-controls`）。
- **结果未知的费用**（DEC-55）：人工**逐笔**核对（无批量），优先按供应商请求编号自动对账，无法自动对账的进入人工核对；结论三选一：已计费（填金额，默认等于预留额，计入已确认）、**未计费（必须填依据，该笔回执转 `reconciled_failure`，其预留随回执状态派生释放）**、暂时无法确认（保持占用）。**只改该笔回执，月度用量总额是回执汇总得出的派生值，没有直接修改总额的入口，不得直接抹账**；每笔核对写审计（结论、金额、依据）；核对完成前该调用永不重发。
- **模型接入**：按能力设主/备模型；密钥只写不可回读（只显示指纹）；未填单价不可启用；每个模型带价格表条目 PriceTable（分时段单价、币种、`observed_at`、`valid_until`，有效期 ≤45 天，用官方人民币价，不用美元与汇率换算），到期前 7 天告警，到期后只拒需要价格的新付费调用，已付结果复用与免费路径照常（BR-COST-13）；连接测试经模型网关发一次极小请求，费用计入用量账本；无试跑默认付费；路由配置的生效版本可查。新供应商（含 embedding）按新付费订阅处理，须基准证明必要并经 Owner 同意，仍须 Owner 开通账号并录入密钥，但不再以预算为由拒绝（DEC-29）。

### 2.12 告警、健康与只读运维 MCP

运行告警必须随首次生产部署上线（DEC-06），分三层：

1. **应用内业务告警**：新鲜度、暂停超时、用量提示（月内累计每增加 100 元，只提示）、用量预警（熔断指标达到阈值的 70%，只提醒）、异常熔断触发、备份失败、各业务线最老任务年龄。
2. **独立于应用的外部检查**：云监控（CPU、内存、磁盘、带宽与流量包、实例到期）；外部可用性与新鲜度拨测——**每 5 分钟**探测公开首页与公开新鲜度探针（`GET /api/v3/freshness`，各业务线最近公开时间、最近一次计划检查成功时间与发布标识，契约 §2.13）：首页非 200 连续 2 次，或新鲜度超过阈值（初值：资讯线最近一次公开距今 >12 小时，法规线最近一次计划检查成功距今 >24 小时，写入部署配置）即告警；拨测不得跑在同一台主机上，服务选型与费用由 Owner 批准（Q-63）。`/healthz`、`/readyz` 不对公网开放，不作为外部拨测目标（`04-architecture/07-deployment-and-ops.md` §6.2、§6.3）。
3. **日程型到期预警**：服务器、域名、证书剩余 < 14 天、模型供应商余额或预付额度、对象存储容量，走同一外部渠道。

高风险私有操作（替换模型密钥、调整异常熔断阈值、批量停用信源、创建或重置账号、负责人恢复、修改告警渠道）一发生就推送，作为账号被盗时的第二道发现手段。渠道（Owner 2026-10-01 已定，Q-22，A）：飞书群自定义机器人为主、邮件为备，两条独立路径（AIHOT 已有飞书发送实现）；机器人地址与备用邮箱由 Owner 经安全弹窗录入（Owner 仍需提供），机器人地址未录入前退为邮件；推送失败重试并走第二渠道。内容用业务语言，含最近成功时间与建议动作，不含密钥与正文。

运营台取消后，“系统页”改为单一用途的只读私有健康摘要（或每日推送摘要）加只读运维 MCP（OUT-11）：认证用 Owner 具名账号，不依赖飞书身份；数据来自脱敏视图，不触发采集或重试；主机名与令牌不入交接包。【设计】（D15-secops-007；DEC-06；旧审计 `docs/reviews/product-production-audit-20260920.md:16-20@main`：停更 5 天无人察觉）

### 2.13 会话失效语义

只有 401 才视为会话确定失效并清 Cookie；数据库或身份存储暂时不可用返回 503，不自动清 Cookie。登出撤销服务端会话；账号停用、口令重置、能力授予或撤回使旧会话失效。取自 B，保留。

### 2.14 金属价格

站内`GET /api/site/metal-prices`只读publication价格表，不因读者请求抓取或写入；ETag、缓存300秒，读取错误503且不缓存。各来源分别区分可用、陈旧和无数据，陈旧保留旧数，整体读取故障不冒称无数据；来源、品种与说明按PG-11登记。俄罗斯央行换算和同一报价较上期在库里用十进制计算；不跨来源比较、不估价不补值。公开API、RSS、MCP、llms.txt与分享图不出价格，官方入口与站内价格表分别验收（DEC-07、INV-47）。

---

## 3. 尚需接线的标准能力目录

这些是明确交付项，不是范围外；端点可在模块内决定，但不能影响公共内容 DTO。

| 能力 | 输入 → 输出 / 权限 | 行为验收 |
|---|---|---|
| 登录、退出；首个负责人开通 | 账号 + 口令 → 服务端会话 / 六个私有账号操作；首个负责人由部署方在服务器侧一次性开通（没有 HTTP 端点，没有设置令牌） | 限流、统一提示、旧会话失效；初始密码首次登录强制改密；已存在负责人时开通恒为拒绝；全站不存在公共开通入口 |
| 负责人恢复（break-glass） | Owner 经受保护通道触发固定脚本 → 一次性临时口令 | 写审计、推送告警、撤销全部会话、清除登录限流桶、临时口令 15 分钟内未用即作废、首次登录强制改密、每季度演练 |
| 模型路由与接入 | 路由版本、密钥引用、价格表条目 → 更新回执 / 负责人（可授予） | 密钥不可回读、无试跑默认付费、生效版本可查 |
| 用量与熔断 | 月份、业务线、能力、信源、用途 → `UsageSummary`；熔断恢复、阈值修改（仅负责人） | 不设金额上限；熔断只停付费、不停公开、不自动恢复；熔断阈值缺失时拒绝付费并告警；指标达到阈值 70% 先预警、只提醒；用量提示每 100 元一次、只提示；恢复与阈值修改写审计 |
| 运行健康与告警推送 | 业务线、窗口 → 队列/信源/内容/成本分项；告警 → 两条独立渠道 | 只读、不触发采集或重试；停 worker 与停整个应用外部渠道均在阈值内告警；外部拨测每 5 分钟读公开首页与公开新鲜度探针 |
| 任务恢复 | job id、已知失败类别、期望版本 → 原阶段续接 | 未知付费不自动重发；无需日常人工点按钮 |
| 审计读取 | 目标、时间范围、游标 → 脱敏审计 / 仅负责人 | 有界、私有、无正文无密钥 |
| 公开 MCP | 标准协议只读 tools list/search/get | 与 HTTP 相同投影、版本与下架状态；不授予私有数据 |
| 信源覆盖导出 | 业务线、范围版本 → 国家/机构/信源覆盖 | 候选、研究、接通、持续、全文分别计数 |
| 法规原文读取 | 文书修订、块/页 → 获准原文/附件 | 不暴露签名 URL 或内部 bucket；无权限时导向官方原文 |
| 旧接口适配层【已废弃】 | — | 新站不为旧站任何地址做兼容；不存在的地址一律 404（`../02-public-api-contract.md` §5.1） |
| 契约生成链路 | Zod → OpenAPI → api-client/mock | 干净克隆一条命令生成且逐字节一致（AC-OUT-18） |

B 原稿的“反馈附件上传（多图令牌上传）”不进首版：首版反馈为单请求单截图（≤2MB），多附件令牌上传列为后续增强，因为它引入一个没有契约的匿名上传端点（D05-api-012）。身份提供商回调（OIDC/飞书）不进私有接口契约：AIHOT 的飞书登录代码保留、默认关闭（Owner 2026-10-02），接入时另立任务并开契约卡。

---

## 4. 模块端口契约

首期为 TypeScript typed 接口/事件，可在单进程调用；未来拆进程保持相同语义。每个接口返回明确 `Result<T,ErrorCode>`，不靠异常字符串或 null 猜原因。**所有任务载荷、处理许可、费用回执（用量账本分录）、暂停状态都带业务线 `lane`（`news` / `policy`）**（D18-delivery-002）。本表与 `../03-internal-contracts.md` §4 描述同一组模块端口，命名以后者为准；这里只保留各端口必须满足的不变量，冲突请提契约 PR。

| 端口 / 提供者 | 命令或查询及输入 | 输出与不变量 |
|---|---|---|
| SourcePolicyPort / source-control | `evaluate(source_id, revision, action, resource)`；`resource` 取权限九项（预留的第十项 `syndicate_fulltext` 启用后追加，Q-47） | allow/deny/unknown + scope + `permission_version` + `expires_at`（`owner_declared` 为空，不设自动到期）；仅当前权限可执行 |
| SourceCatalogPort / source-control | `due(lane, now, limit)`、`resolveTarget(row_id)` | 限量 profile 与原始行映射；不把候选当启用 |
| FetchPort / acquisition | `fetch(profile_version, URL, limits, conditional_headers)` | receipt、允许的 bytes/artifact、time；所有跳转重新校验；拒绝 HTTPS 到 HTTP 降级 |
| ArtifactPort / platform-storage | `put/get(ref, policy, checksum)`、`expire(ref)` | private 引用、hash、size；权利到期不能回放正文 |
| ContentRevisionPort / content | `normalize(fetch_receipt)`、`getRevision(id)` | 不可变 blocks/时间/附件清单；不覆盖旧稿 |
| TranslationPort / content | `ensure(revision, locale, recipe)`、`progress(id)` | complete/partial/restricted，块级 checkpoint；中文正文来源区分原文/官方译本/AI 翻译 |
| EntityPort / intelligence/entities | `resolve(mentions, evidence, context)` | exact/candidate/unresolved；不凭模型猜译名；公开名只来自已核实词表或原文自带 |
| EventPort / intelligence/events | `propose(revision, candidate_limit)`、`decide(proposal)` | 成对判断取 `same_event` / `progress` / `separate`（`uncertain` 视同 `separate` 并记原因）+ 成员角色 + 证据；类型化边 `updates`/`corrects`/`repeals`/`implements`/`related` 只由原文明示并经程序校验（契约 §3.3） |
| PolicyPort / intelligence/policy | `analyze(instrument_revision, inventory)` | `basic_facts`/`partial`/`complete`/`withheld` + 分维法律状态 + `PolicyImpact[]` + 条件/例外/证据 |
| EditorialPort / editorial | `assess(subject, ruleset)`、`applyReview(command)`、`suppress(subject, reason, expected_version)`、`restore(suppression_id)` | 评估结果独立、不可篡改 review；`applyReview` 决定为 accept/correct/drop/hold；下架与恢复是独立命令；不把精选门作为宽收录门 |
| ModelGatewayPort / model-gateway | `execute(task, input_fingerprint, usage_scope{lane, purpose})`、`reconcile(id)` | typed result/known_failure/unknown + 不可变回执；不设月度金额上限；每次付费调用前做熔断检查（缓存之后、预留之前，BR-COST-20），回执与分录带 lane、能力、信源与用途 |
| PublicationPort / publication | `apply(change_set, expected_watermark)`、`rebuild(scope)` | 增量投影推进 `content_version` 水位；不返回半完成投影；B 的发布代次与清单指针 CAS 不采用（ADR-0004） |
| PublicQueryPort / publication | `items/item/policy/report/version(request)` | DTO 白名单、当前抑制优先、零请求时 AI；再分发权限按出口判断 |
| ReportPort / publication/reports | `ensure(type, period, edition)` | 资讯线按 AIHOT 的出刊时间与时间窗（北京时间：日报 08:00、覆盖前一日 08:00 至当日 08:00，以出刊日为键；周报周一 10:00 出上一个 ISO 周；月报 1 日 10:30 出上一个自然月）取窗口内的精选候选引用，同一事实去重、受版面容量限制（DEC-65）；资料进入站点后跨过刊期边界才确定精选公开时间的归入下一期候选池，不设“补录”，历史期不改写；每小时补出缺的刊期；日报导语与周月综述由模型写，失败退回确定性版本；法规周月汇总是另一套确定性快照（自然周 / 月，`../../01-product/10-policy-service.md`） |
| IdentityPort / identity | `login/logout`、`createAccount`、`resetPassword`、`setCapabilities` | 口令 Argon2id、不回读哈希；限流；能力变化使旧会话失效；首个负责人仅经服务器侧一次性命令 |
| AlertPort / platform-ops | `notify(alert)` | 两条独立渠道、失败重试并走第二渠道；内容不含密钥与正文 |
| AuditPort / platform-audit | `append(actor, command, target, transaction)` | 原子记录/失败回滚；不冒称防 DB-owner 篡改 |

---

## 5. 事件协议与兼容

事件是“事实已提交”通知，不是授权凭据。写业务状态与 outbox 同事务；dispatcher 可重复投递，consumer inbox 保证同 `event_id` 只产生一次业务效果。不要声称网络 exactly-once。顺序只承诺同 aggregate_version 单调，乱序消息先检查当前 revision，旧消息不得覆盖新状态；缺版本可重读提供方端口。

payload 只传引用、版本与小型决策，不传大正文与秘密。事件信封与类型目录（37 个有效事件类型：v2.0 的 33 个，v2.1 新增 6 个、废弃 2 个）以 `../03-internal-contracts.md` §2 为准（信封取 `event_id`、`event_type`、`schema_version`、`occurred_at`、`producer`、`lane`（`news` / `policy` / `all`）、`subject {kind, id, version}`、`correlation_id`、`causation_id`、`payload`）；B 包 payload 中的 `policy_version` 改名 `permission_version`（避免与法规实体 PolicyVersion 重名），`policy_epoch` 改名 `suppression_epoch`（内部事件使用；对外只在站点接口 `/version` 以不透明字符串出现，契约 §2.2），`item_id` 改名 `material_id`，去掉 `generation` 与 `manifest`；`editorial` 拆为 revised / withdrawn / restored / review_concluded 四类并带必填 `target_kind`。重新生成清单见 `README.md` §7。schema 增加可选字段为兼容 minor；删除字段、改变含义/枚举或必填要求为 major，新旧消费者有明确双读窗口。公共 DTO、内部 event、数据库 migration 分别版本化，禁止用同一个“v2”暗示三者一致。

Contract owner 负责公共 schema，模块 owner 负责自己的事件和端口；消费者提交最小失败样例和修改建议。可以继续独立工作，不能因一个跨模块契约待定暂停全部任务。契约改动先入主干，provider/mock/consumer 再各自验证。
