# 公开接口契约（v2.1）

> 本文是站点接口与公开 API 的**业务契约**，也是契约源码（`packages/contracts` 中的 Zod schema）的验收依据。优先级单向：**业务契约文档 → 契约源码 → 生成物（OpenAPI、api-client、mock）**；生成物与本文不符视为缺陷，改生成物，不改本文迁就它。【设计】（DEC-31）
> 机器可读版本：Zod schema 是唯一事实源，由它生成 OpenAPI 3.1（`/openapi-v3.json`）与 api-client。B 包的 `openapi.json`、`examples.json` 只是首版一次性转写的输入，转写方法与逐项改造清单见 `contracts/README.md`。私有接口（`/api/admin/*`）的行为规范见 `contracts/interface-behavior.md` §2；非 JSON 出口（RSS、站点地图、robots、llms.txt、分享图、MCP）的路径与缓存规则见 `contracts/non-json-outputs.md`。
> 依据：旧站读者接口（`apps/web/lib/reader/*`、`services/live_pipeline/reader.py`@main）、旧公共契约 1.1 的字段白名单（`docs/architecture/decisions/0013-public-contract-v1-1-additive.md`@main）、法规分支只读协议（`packages/contracts/policy/README.md`@policy）、B 包契约（B:contracts/openapi.json、B:contracts/interface-behavior.md）、AIHOT 的“站点接口 + 公开 API + RSS + MCP 同读一个公开读取层”，以及 AIHOT 公开 API 对精选、热点与条目评分的做法（`packages/backend/src/publication/v1.ts`、`events/hot-read.ts`、`reference/public-v1.openapi.json`，DEC-10、DEC-64）。旧站读者接口与旧公共契约只作经验参考，**新站不为旧站的任何地址做兼容**（DEC-21）。取舍见 `00-decision-ledger.md` DEC-10、21、23、31、47–53、64、65。
> 状态标签：【已验证】旧站有验收记录或线上回读；【已实现未验证】旧仓库有代码、无验收；【Owner 决定】附日期；【设计】【新增】本包提出。表格中枚举值用“ / ”分隔。对外对象 ID 的前缀以 `01-domain-model.md` 的 ID 前缀表为准。

**v2.1 相对 v2.0 的主要变化（Owner 2026-10-01 答复）**

| # | 变化 | 依据 |
|---|---|---|
| 1 | **旧站地址一概不兼容**：删除旧公开路径处置表、90 天适配期、`Deprecation`/`Sunset`/`Link` 头、301 映射与 410 专门响应，§5.1 只剩一句规则；连带删去 `first_public_basis` 的 `legacy_snapshot_min`、RSS `guid` 沿用旧 `itm_` ID、旧 ID 别名 308、“迁移来的存量稿”等迁移专用表述 | DEC-20、DEC-21 |
| 2 | **精选与热点沿用 AIHOT，切换前完成**：`ItemCard.score` = 两次评分的平均值（向下取整），没有评分为 null、任何出口不出现 0；`availability` 与 `not_enabled` 取值【已废弃】；`/hot` 的机器形态只给名次，热度值只在站点接口（网页形态）；新增 `featured/snapshot`、`featured/changes`（沿用 AIHOT 的 selected snapshot / changes） | DEC-10、DEC-64；BR-SEL-05、BR-SEL-07 |
| 3 | **报告的选材与出刊时间都沿用 AIHOT**：从精选候选里取材，同一事实去重、受版面容量限制，日报导语与周月综述由模型写；出刊时间与时间窗按 AIHOT（北京时间：日报每天 08:00 出刊、覆盖前一日 08:00 至当日 08:00 并以出刊日为键，周报每周一 10:00 出上一个 ISO 周，月报每月 1 日 10:30 出上一个自然月），跨过刊期边界的归入下一期候选池，不设“补录”，历史期不改写 | DEC-65 |
| 4 | **阶段列**：端点表“切换必备 ●/○”改为“阶段”，统一写“切换前完成（Mx）”或“候选（不排期）”，删去 ★ 与“切换后” | DEC-19 |
| 5 | **许可**：新建信源九项一律“允许”（`owner_declared`），第十项 `syndicate_fulltext` 仍默认关闭（Q-47）；`guide_only_reason` 四值不变，`summary_only_permission` 的含义改为“逐源收紧后权限只到摘要”，其余三值为技术原因 | DEC-33 |
| 6 | **合规展示**：`Settings` 增公安联网备案号与互联网新闻信息服务许可证信息；生产环境备案号任一未配置则公开站不得开放 | DEC-39、DEC-40 |
| 7 | **待决措辞**：金属价格、事件折叠默认（`fold` 默认 `event`）、副标题等改为“Owner 2026-10-01 已定” | DEC-07、DEC-25、DEC-27 |

---

## 0. 结论

| 序号 | 决定 | 依据 |
|---|---|---|
| 1 | 三类接口：站点接口 `/api/site/*`（仅读者站，页码分页）、公开 API `/api/v3/*`（匿名只读，游标分页）、私有接口 `/api/admin/*`（最小私有页面，只在私有主机名可达） | DEC-23、DEC-04、DEC-30 |
| 2 | 新公开 API 前缀用 **`/api/v3`**（只为避免旧客户端打到同名路径拿到形状不同的响应，不承担兼容义务）；**新站不为旧站的任何地址做兼容或重定向，不存在的地址（含旧站地址）一律 404** | DEC-21（Owner 2026-10-01：旧链接、旧 RSS、旧接口全部不要） |
| 3 | `content_version` 是不透明字符串，只用于缓存与“有新内容”判断；**不提供按版本钉住读取**；游标绑定筛选而非全站版本 | DEC-47 |
| 4 | 时间字段以 B 的 `TimeAssertion` 为底，加服务端中文 `label` 与北京日期 `beijing_date`；只有日期的条目不输出时分 | DEC-50 |
| 5 | 管辖范围统一为 `jurisdictions`（含 `kind`），覆盖 36 个法域对象；组织不计入国家数 | DEC-03、DEC-51 |
| 6 | 错误体统一为 `{code, message, request_id, retry_after_seconds?}` | DEC-52 |
| 7 | 每条公开内容带机器可读 `attributions`（发布方署名）与 `ai_label`；全文只对“站外再分发”许可为允许的来源返回 | DEC-38；D05-api-017、020 |
| 8 | 下架后 **60 秒内**所有出口不可见；公开响应不设长缓存、不用 stale-while-revalidate | DEC-48 |
| 9 | 法规接口以 B 的 Policy 系列 DTO 为底，增加分维法律状态、结构化经营影响与七经营主题字段；资讯线与法规线接口同步设计 | DEC-01、DEC-36；D11-policy-005 |
| 10 | 金属价格接口移出首版：页面只放官方入口与说明，不出任何数字；价格数据契约保留为“延后”草案（§3.9）。Owner 2026-10-01 已定（Q-11，A）：开发方先调研免费或低价的官方数据源并报价，Owner 再定是否开通站内价格表 | DEC-07 |
| 11 | 公网只暴露一个经限流的只读“公开新鲜度探针”（`/api/v3/freshness`，§2.13）；所有公开响应带发布标识头；`/healthz`、`/readyz` 不属于公网契约，不进 OpenAPI | `04-architecture/07-deployment-and-ops.md` §6.2、§6.3；DEC-06 |
| 12 | 精选、热点、条目评分沿用 AIHOT，切换前完成：条目卡带 `score`（两次评分的平均值，向下取整；没有评分为 null，不出现 0）；热点榜机器形态只给名次，热度值只在站点接口；精选同步 `featured/snapshot`、`featured/changes` 沿用 AIHOT；`availability` 字段与 `not_enabled` 取值废弃（数据不足时返回空列表，页面显示诚实空态） | DEC-10、DEC-64；BR-SEL-05、BR-SEL-07 |

---

## 1. 三类接口

| 接口 | 前缀 | 使用方 | 分页 | 稳定性 |
|---|---|---|---|---|
| 站点接口 | `/api/site/*` | 仅 `reader-web`（经生成客户端），同源，不开放跨域 | 页码 `page` + `page_size`，支持跳页 | 随页面演进，仍需契约 PR |
| 公开 API | `/api/v3/*` | 外部 Agent、程序、第三方；匿名；跨域 GET 放行 | 不透明游标 `cursor` + `limit` | **稳定**：只追加；破坏性变更发布 `/api/v4` 并与旧版并行至少一个发布周期（ADR-0013） |
| 私有接口 | `/api/admin/*` | 最小私有页面、Owner 的只读运维 MCP | 游标 | 内部，需登录；只在私有主机名可达，公开主机名返回 404 且不带 `Set-Cookie`（INV-25） |

站点接口与公开 API 都只读 `publication`，内容一致（INV-02）；分开是为了页面迭代不影响外部调用方。站点接口的 JSON 形状与公开 API 同源（同一批 DTO），区别只在三点：分页方式、页面需要的聚合字段（§4.2）、正文按“站内展示”许可而非“站外再分发”许可判断（§2.9）。

---

## 2. 通用约定

### 2.1 只读、匿名、限流

- 公开 API 只有 GET、HEAD、OPTIONS；不设账号；响应不设 Cookie（公开缓存不得缓存带 Cookie 的响应）；公开读取不触发采集、模型调用或任何业务写入（INV-01）。公开 MCP 按协议使用 POST，但只暴露只读工具。
- 按客户端限流，超限返回 429 并带 `Retry-After`。限流键与额度不继承旧实现值，在容量基准中定值并写入配置；键为哈希后的可信代理跳数客户端地址；公开读的突发额度须不低于首屏请求数的 2 倍，内部 `/healthz` 探针不进限流也不触达数据库（它不属于公网契约，§2.13；公网的新鲜度探针则经限流）；反馈与登录另设更严的桶（`04-architecture/06-security-and-access.md`，R15-adr-003、D15-secops-010）。【设计】
- 跨域：公开 API 与 `/openapi-v3.json` 允许任意来源的 GET/HEAD/OPTIONS，暴露 `ETag`、`Retry-After`、`Link`、`X-Request-Id` 响应头；站点接口同源专用，不开放跨域。【设计】（取自 `packages/contracts/src/http-policy.ts` 的 AIHOT 做法，去掉 stale 指令）

### 2.2 信封与内容版本（DEC-47）

- 所有 JSON 列表与详情响应含 `content_version` 与 `generated_at`。`content_version` 是**不透明字符串**（实现为单调水位），客户端不得解析、不得比较大小，只比较是否相等；它用于 `ETag` 与前端“有新内容”检查。
- 任何投影变更与下架、恢复都使 `content_version` 变化。**公开契约不提供“按 content_version 钉住读取”的参数**，也不保留多个可读的历史发布版本（ADR-0004 增量投影）。一次请求在一个只读事务内自洽（列表、分面、条数来自同一快照）。
- B 的 `policy_epoch` 并入 `content_version`，公开 API v3 的响应不再出现该字段。内部的撤回代次改名 `suppression_epoch`（每次下架或恢复递增，ENT-29），**只在站点接口 `GET /api/site/version` 中以不透明字符串返回**：读者站（通则 10）用它在“没有新增内容、只有下架”时也能即时发现撤回，值变化即核对当前页显示的对象并移除被下架者；客户端只比较是否相等，不解析、不比较大小。它不进公开 API v3 与 `/openapi-v3.json`。被下架对象的 ID 列表**不随版本检查返回**（避免形成一份可被枚举的下架清单）；读者站用 `GET /api/site/saved` 的 `unavailable_ids` 核对当前页对象（≤100 个，条目、事件、法规文书都可）。【设计】（D03-reader-pages-009；通则 10；T-129）
- `GET /version` 返回 `{content_version, generated_at, state}`（站点接口另含 `suppression_epoch`）；合法空站返回 200、`state=empty`、`content_version=null`；当前公开版本无法确认（指针损坏、快照缺失）返回 503 `version_unavailable`，**不回退旧缓存，不返回假的成功空列表**。
- 反例（旧站已踩过）：整站版本快照冷读 6–12 秒，只能反复调高上限（`docs/architecture/decisions/0035-measured-reader-capacity.md:10-26@main`）；游标绑定整站版本后读者翻页时不断看到“列表已更新，已从第一页重新加载”（`apps/web/components/cursor-restart-notice.tsx:23@main`）。本契约的做法是避免这两类问题。

### 2.3 分页：两个通道（DEC-23）

| | 站点接口（读者站用） | 公开 API（外部程序用） |
|---|---|---|
| 参数 | `page`（≥1，默认 1）+ `page_size`（1–50，默认 20；`/changelog` 默认 30） | `cursor` + `limit`（1–100，默认 20） |
| 响应 | `items`、`total`（精确值，不封顶；AIHOT 现网 `/all` 的 50 页与“2000+”封顶必须去掉）、`page`、`page_size`、`has_more`、`facets`、`day_counts`（当前条件下各北京日的**总**条数，跨页一致，日标题的“N 条”取它） | `items`、`next_cursor`；**不承诺 `total`**；`facets` 仅在请求 `facets=true` 时返回 |
| 越界 | 页码越界返回 200 与空 `items`，不返回 400 | 游标到尾返回空 `items`、`next_cursor=null` |
| 游标 | — | 签名游标 = 归一化筛选 hash + 末条排序键；不绑定全站版本，不因版本变化失效；被篡改或与当前筛选不匹配 → 400 `invalid_cursor`（客户端从首屏重来）；下架在每次查询时过滤 |
| 内容变化 | 请求可带 `seen_version`（上次响应的 `content_version`，只比较不钉住）；不一致时响应 `version_changed=true`，页面显示“内容有更新”提示条，**不隐藏已显示的列表** | 新内容总排在首屏之前，游标按排序键继续，翻页不重复 |
| 排序 | 两个通道读同一读取层、同一排序：来源发布时间可比较键降序、ID 降序（规则见 `02-rules/04-time-semantics.md`） | 同左 |

- 站点接口页码进入地址栏可分享，页面“第 N 页 · 共 M 条”与“跳到第 [ ] 页”读 `total`（输入超过总页数落到末页）；法规政策动态与法规周月汇总的列表同样用页码（通则 8）；打开详情后返回应恢复筛选、页码、滚动与焦点（页面侧规则见 `01-product/03-reader-pages.md`）。【已验证】（旧站 `apps/web/components/reader/feed.tsx:294@main` 的“跳到第 N 页”，Owner 验收点名翻页与跳页；旧实现 `services/live_pipeline/reader.py:736-803@main`）
- 页码分页在内容变化时的可接受口径（改写 B:T-045）：同一响应内不重复、排序不违例；翻页期间有新内容插入或下架时，相邻页可能出现个别重复或被跳过，页面以 `version_changed` 提示并提供回到第一页；外部程序要求不重不漏时使用游标通道。【设计】

### 2.4 筛选、搜索与日期（DEC-49）

- 多个筛选维度 AND；同一维度首期单值（确需多选时升级契约）。**未知参数、同一参数重复出现、超长值一律 400 `invalid_request`**，避免调用方误以为筛选生效。【已实现未验证】（`apps/web/lib/reader/adapter.ts:43-49@main`）。RSS、站点地图、`llms.txt` 忽略未知参数。
- 搜索覆盖全部已公开内容，不能只搜当前页或前 N 条；`facets` 与列表在同一查询、同一快照计算，不凭前端缓存估总数。`q` 最长 200 字符（法规接口 120 字符）。【已实现未验证】（`reader.py:741-742@main`；法规 `packages/contracts/policy/README.md:8@policy`）
- **`from`、`to`、`on` 三个参数均为北京时间自然日**（`YYYY-MM-DD`，闭区间）：分钟及以上精度的条目按 UTC 换算到 Asia/Shanghai 取日期；只有日期精度的条目直接用来源声明的日期，不做时区平移；来源日期未知的条目只在未给日期筛选时出现。`on` 与 `from`/`to` 同时给出且不一致 → 400；`from` 大于 `to` → 400。公开 API 与站点接口都支持 `on`。【已实现未验证】（`reader.py:743-777@main`）；来源日期未知项取自 B。
- 缺精确时间的条目保留 `date` 精度；没有来源日期的条目显示发现时间并标“发现”；**不得把入库时间输出为来源发布时间**（INV-06、BR-TIME-01）。

### 2.5 时间：`TimeAssertion`（DEC-50）

所有“来源上的时间”与“法律日期”用同一个对象；A 的扁平三元组 `published_at / time_precision / time_label` 从公开契约**删除**（旧站的同名 `timestamp_label` 是依据标签，不是显示文本，两套并存会同名异义，`reader.py:78-82,483-485@main`）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `raw` | string \| null | 来源原始时间字符串 |
| `local_date` | `YYYY-MM-DD` \| null | 来源当地日期 |
| `local_time` | `HH:MM` 或 `HH:MM:SS` \| null | 来源当地时刻；`precision=date` 时恒为 null |
| `timezone` | IANA 名称 \| null | 只在可验证时填写，不按国家或服务器位置推断；缩写（如 CST）不接受（旧ADR-0013） |
| `utc` | date-time \| null | UTC 时刻；**`precision=date` 时恒为 null**；时区未知且来源没有给出绝对时刻时为 null |
| `precision` | `unknown` / `date` / `minute` / `second` | 精度缺失时按 `date` 处理，不得默认 `minute`（BR-TIME-01） |
| `meaning` | 枚举，见下表 | 这个时间表示什么 |
| `meaning_label` | string | `meaning` 对应的中文依据标签（见下文枚举；旧站 `timestamp_label` 的等价物） |
| `basis` | string | 取值依据的说明（如“列表页发布日期栏”） |
| `condition_text` | string \| null | 附条件日期的条件原文（如“须经批准后生效”） |
| **`label`** | string | **服务端生成的中文显示文本**，各端不得自行格式化：`date` 精度只显示日期（如“9月29日”，跨年显示年份）；`minute`/`second` 精度按北京时间显示到分钟（如“9月29日 14:05”）；时区未知的分钟精度显示当地值并括注“来源未标明时区”；`unknown` 显示“日期待核实”（BR-TIME-12） |
| **`beijing_date`** | `YYYY-MM-DD` \| null | 列表按日分组与日期筛选用：有 `utc` 的换算到北京日；只有日期或时区未知的，直接取 `local_date`，不平移；`unknown` 为 null |

`meaning` 枚举与中文依据标签：`published` 来源发布、`updated` 来源更新、`registered` 来源登记、`public_inspection` 公开阅览、`formally_published` 正式刊发、`signed` 签署、`effective` 生效、`applicable` 适用、`deadline` 截止、`compiled` 汇编、`expires` 到期、`event` 事件发生、`discovered` 本站发现、`site_public` 本站收录（本站公开）、`uploaded` 上传、`checked` 原文核对、`repealed` 废止。其中 `public_inspection`、`formally_published`、`site_public`、`checked`、`repealed` 是相对 B 新增（B 的枚举表达不了联邦公报的公开阅览与正式刊发，也没有废止日期，`D05-api-006`、DEC-36）：法规日期不再借用 `uploaded`、`published` 加 `basis` 文字去区分。字段名以本表为准：中文展示文本叫 `label`（不叫 `label_zh`），与 `meaning_label`、`beijing_date` 并列。【设计】

`first_public_at`（本站首次公开时间）在数据模型里是系统事实、写一次永不改变（BR-TIME-11、INV-08），**不是来源声明**；DTO 沿用本对象的形状输出（`meaning=site_public`、`precision=second`），只为列表与详情的展示一致（`label`、`meaning_label`、`beijing_date` 由服务端生成），并另带 `first_public_basis`：`live`（新系统实际首次公开）、`unknown`（`legacy_snapshot_min` 【已废弃】：它只为迁移旧站数据服务，新站不迁移旧数据，DEC-20）；`basis` 文本由它生成。写入后重建、更正、翻译、回填、下架恢复都不得修改。【设计】

旧仓库证据：旧读者接口 `published_at + time_precision(date/minute) + timestamp_label`（`apps/web/lib/reader/types.ts:9-13@main`）；旧契约 1.1 的当地值 + IANA 时区 + 精度 `date/minute/second`，时区未知保留当地值且 zone 为 null（旧ADR-0013:14-21@main）；旧实现把只有日期的更新时间存成 UTC 零点而出过问题（`reader.py:43-47@main`）。

### 2.6 管辖范围 `jurisdictions`（DEC-03、DEC-51）

- 结构：`{code, label, kind, parent?}`。`kind` 为 `country`（ISO 3166-1 alpha-2）、`subdivision`（ISO 3166-2，如 `CN-GZ`，`parent` 为所属国家）、`organization`（保留代码 `EU`、`UN`、`OECD`）。运行用的法域字典是 `data/jurisdictions-36.json`：33 国 + 3 个组织共 36 个对象，外加中国 14 个省区下级法域（共 50 条），每个对象带 `news_scope` / `policy_scope` 标志；资讯线以 18 国起步。字段对照：`id`→`code`、`name_zh`→`label`、`kind`、`parent`；`tier`（含 5 个背景层国家）、`policy_first_batch_required`、`scope_basis` 等研究验收字段只在内部使用，**不对外**。`data/jurisdiction-scope.json` 是 B 的范围底表，只作对照。A 的 `countries` 字段删除；参数名只有 `jurisdiction`，旧参数 `country` 不保留（没有旧接口适配层，DEC-21）。
- 筛选参数 `jurisdiction` 取上述代码；选国家时**包含其下级**省/州。分面按 `kind` 分组，**组织不计入国家数**（旧分支同口径，`docs/policy-upgrade/reader-runtime.md:6-7@policy`）。
- 条目的 `jurisdictions` 取材料实际涉及的法域，不按发布方总部或网站域名推断（INV-31）。

### 2.7 错误（DEC-52）

统一体：`{code, message, request_id, retry_after_seconds?}`。`message` 是可直接展示的中文，不泄露对象是否存在、不带内部细节；`retry_after_seconds` 只在 429/503 出现，且响应同时带 `Retry-After` 头。OpenAPI 为 200/304/429/503 声明 `ETag`、`Cache-Control`、`Retry-After` 头。

| code | HTTP | 含义 |
|---|---|---|
| `invalid_request` | 400 | 参数未知、重复、越界或格式错误（含 `on` 与 `from`/`to` 冲突、字段校验失败） |
| `invalid_cursor` | 400 | 游标被篡改或与当前筛选不匹配 |
| `not_found` | 404 | 对象不存在或不可公开（不区分原因）；不属于本契约任何路径的地址（含旧站的任何接口地址）同样返回它，不重定向（§5.1） |
| `revision_changed` | 409 | 长文阅读或事件卡展开面板分页过程中材料 / 事件换版或资格变化：客户端整篇（整个面板）重读 |
| `snapshot_required` | 409 | 精选同步的水位缺失、无法识别或来自重建前的账本：客户端重新取 `featured/snapshot`（§3.5） |
| `gone` | 410 | 对象已下架，或已合并且没有去向 |
| `rate_limited` | 429 | 超过限流 |
| `version_unavailable` | 503 | 当前公开版本无法确认 |
| `service_unavailable` | 503 | 其他暂时不可用 |
| `unauthorized` / `forbidden` / `conflict` | 401 / 403 / 409 | 仅私有接口：未登录或会话失效、无权限、期望版本不符或幂等键冲突 |

**ID 形态校验与 404 的两种页面**：路径里的对象 ID 先按形态校验（`01-domain-model.md` §1：`<前缀>_<26 位大写 Crockford ULID>`；新站 ID 的字符集与旧站的小写十六进制不同，公开 ID 不复用，INV-18）。形态不合法的（含旧站形态 `^[a-z]{3}_[0-9a-f]{26}$`）与任何其他不存在的地址一样：页面类走通用“页面不存在”（404），接口类返回 `not_found`；形态合法但对象不存在、已撤回或已下架的：页面显示“当前不可查看”（HTTP 404，已下架可用 410），接口返回 `not_found`（不区分原因）或 `gone`。两类页面都带首页与搜索入口。路由层不查别名表，也没有任何旧 ID 兜底解析（§5.1）。

沿用旧站的 `invalid_request`、`not_found`、`rate_limited`、`version_unavailable` 名称（`apps/web/lib/public-web-v2/same-origin-adapter.ts:19-33@main`、`apps/web/lib/reader/adapter.ts:71-86@main`）。B 的 `bad_request`、`unavailable`、`version_expired` 与其他近义名一律不用；不可用统一写 `service_unavailable`。AIHOT 的驼峰 `Problem` 对象（`type/title/status/detail/code/requestId`）改造为上述形状，列入底座改造项。旧反馈接口的专用码 `invalid_page` 并入 `invalid_request`，中文提示保留（“相关页面请使用 AI矿策网站地址。”，`operations.py:1210-1212@main`）。【设计】

### 2.8 缓存与下架生效（DEC-48）

写成可测条款：

1. **源站**：下架事务提交后，任何出口的下一次源站响应都不含该对象（页面、搜索、收藏解析、报告、API、RSS、MCP、站点地图、分享图一律如此）。
2. **缓存**：JSON 接口与 RSS 使用 `Cache-Control: public, max-age=0, must-revalidate` 加 `ETag`（由 `content_version` 派生，下架必然改变），允许 304；HTML 页面 `max-age` ≤ 60 秒；**一律不使用 `stale-while-revalidate`、`stale-if-error`**；响应不带 Cookie。将来接 CDN 必须支持主动清除，否则不得缓存详情与列表。
3. **验收口径**：下架后 60 秒内，未带条件请求头的匿名请求在所有出口均不可见（AC-OUT-03）。
4. **已打开的页面**：长文续读、详情重新核对收到 404/410/409 时整篇旧内容退出，不回退缓存（失败关闭）。
5. 对照：旧站读者接口一律 `Cache-Control: no-store`（`apps/web/lib/reader/adapter.ts:62@main`）；AIHOT 默认 `max-age=60~300` 加 `stale-while-revalidate=300~3600`（`packages/contracts/src/http-policy.ts:14-26`，AIHOT），会让已下架内容在中间缓存里多留十几分钟到一小时，必须改造。

### 2.9 署名、AI 标识与再分发

- **署名**（旧站已公布的再利用约定，`apps/web/components/reader/information.tsx:18-22@main`）：公开条目带 `attributions: {name, url}[]`（至少一项，多个发布方按序）。RSS 描述固定为“据〔发布方链接〕原文整理：”加导读首段，只有日期的条目前置“来源发布日期：…（仅提供日期）”；MCP 文本输出同样前置署名。`guide` 字段本身**不含**署名前缀，由展示层与各出口统一添加（`06-content-standards.md` DR-74）。【已实现未验证】（旧实现 `services/live_pipeline/attribution.py:40-59@main`）
- **AI 标识**：详情、报告、RSS、API 显式标注“AI 辅助生成/翻译”，并带机器可读标识 `ai_label`：`ai_generated`（AI 生成）或 `ai_assisted_human_edited`（AI 辅助整理，经人工修订）。**任何出口不出现“已复核 / 已核实 / 已审核”**；只有审稿记录明确勾选“事实”维度时才可另加“事实经人工核对（日期）”，且不由修订动作自动产生。隐式标识（文件或元数据层）逐项对照《人工智能生成合成内容标识办法》与 GB 45438-2025 落地（2025-09-01 施行，显式加隐式）。【设计】（DEC-38，D06-content-012，功能编号 F-PUB-07）
  - **字段**：`ItemCard`、`PolicyCard`、`ReportCard` 及其详情都带 `ai_label`（必填，不得为 null）；详情类 DTO（`ItemDetail`、`Policy`、`Report`）另带 `ai_metadata {provider, content_id}`：`provider` 是服务提供者名称或编码（取站点配置），`content_id` 是内容编号（取对象 ID）；`ai_label` 即“生成合成属性”，三者合起来是 DR-87 要求的隐式标识。“生成还是翻译”由 `Reading.mode`（`ai_translation`）表达，“是否经人工修订”由 `ai_label` 的取值表达，不另设布尔字段。
  - **取值规则**：生成方式未知时按 `ai_generated` 标注，不省略；有人工修订记录的取 `ai_assisted_human_edited`；标识缺失视为发布失败，不激活该版本（F-060）。官方中文文本与官方中文译本在阅读块上标“官方中文”，不标 AI；但同一条目的导读、推荐理由、解读仍是 AI 内容，对象级 `ai_label` 照常带出。页面元数据、RSS（`<category domain="ai-label">`）、MCP 输出各自带出同一组取值（`non-json-outputs.md` §2、§5）。【设计】（DR-87 第 5 点）
- **全文再分发权限**：权限矩阵取 DEC-58 的九项（新建信源一律“允许”，证据 `owner_declared`，不设自动到期，只由逐源收紧关闭，DEC-33）；另**预留**第十项 `syndicate_fulltext`（站外再分发全文/译文：公开 API 正文、全文 RSS、MCP 正文），取值 允许/禁止/未知，**它不在 Owner 2026-10-01 的许可声明范围内，仍按 Q-47 默认关闭：默认“未知”，未知按禁止**；是否启用由 Owner 决定（Q-47，默认不启用）。启用前，公开 API 的 `…/reading`、全文 RSS、MCP 一律只返回导读、原文链接与“请到本站或原文阅读”说明（`Reading.redistribution=restricted`）；启用后，只对 `syndicate_fulltext=允许` 的来源返回正文。站点接口（本站页面）按 `public_original_fulltext` / `public_translation` 判断（来源被逐源收紧后，已公开的全文或译文随之撤回）。【设计】（D05-api-017；旧契约只授权 `web_reading` 渠道，`packages/contracts/v2/README.md:21-23@main`；AIHOT 两个独立开关 `database/migrations/0001_core.sql:23-24`）
- **外文新稿的公开条件**：中文标题 + 导读 + 可取得且获准的完整中文正文；摘要不计全文，`reading_status=summary_only` 不得当作全文。`translating`（补齐中）只出现在已公开稿因来源修订或重译而进入的补齐窗口，不用于新外文稿的首次公开（DEC-35，INV-12）；“仅导读”只剩技术原因与逐源收紧两类（见 §3.4 的 `guide_only_reason`）。
- **公司中文名**：`company_notes[].name_zh` 只有两个来源：已核实词表（带出处）或材料原文自带的中文名；其余为 null，只显示原文名，任何出口不出现“暂译”字样（DEC-37）。

### 2.10 链接与 http 入口（DEC-56）

- `original_url`、附件链接、正文内链接允许 `http` 或 `https`（`format=uri`，scheme 白名单，不带凭据）；原表中有一批省级政府站点只提供 http。对 http 原文链接，`SourceCredit.insecure_transport=true`，页面与 API 据此提示“该来源仅提供非加密访问”。抓取侧仍拒绝 HTTPS 到 HTTP 的降级。
- 来源配置的采集入口（私有接口）默认必须 https，负责人可为单个信源开“仅 http”例外并留审计（`insecure_transport_exception`，见 `contracts/interface-behavior.md` §2）。B 的全部 `^https://` 约束因此放宽。

### 2.11 命名裁决表（DEC-51）

| 概念 | v2.1 采用 | 废弃写法（来源） |
|---|---|---|
| 列表资源 | `items`（`view=all / featured`；热点单独 `/hot`） | `feed`（B）；`view=hot`（旧读者接口） |
| 产品更新 | `/changelog` | `/updates`（B） |
| 报告类型参数 | `type` | `kind`（B） |
| 管辖范围字段 / 参数 | `jurisdictions`（含 `kind`）/ `jurisdiction` | `countries`、`country`（A，不保留别名）；`jurisdiction_path`（B） |
| 收藏解析 `ids` | 逗号分隔字符串，≤100 个 | 重复参数数组（B） |
| 标题、导读 | `title`、`original_title`、`guide`、`reason` | `title_zh`、`summary_zh`、`recommendation_reason`（B） |
| 时间 | `published_time`（`TimeAssertion`）、`first_public_at` | `published_at / time_precision / time_label`（A）；`public_at`（B） |
| 所属事件 | `event_ids[]`，`story_id`、`thread_id` 可空 | `event_id`（A 单值） |
| 枚举型维度 | 一律 `{code, label}` | B 卡片里只有代码的字符串 |
| 分面项 | `{code, label, count}` | `{value, label, count}`（B） |
| 版本号 | `content_version`（不透明） | `policy_epoch`（B，并入） |

### 2.12 永不出现的字段

模型与服务商、提示词、token 与费用与用量、置信度与内部评分细目（两次评分的单次分值、所用门槛、评分提示词版本、五轴分）、审核与操作人身份、凭据、原始抓取正文与快照、队列与调试信息、暂停与熔断状态（INV-10）。**评分只公开一个字段 `score`**：两次评分的平均值（向下取整的 0–100 整数），沿用 AIHOT，没有评分时为 null、不出现 0（Owner 2026-10-01 已定，DEC-10；BR-SEL-07）；旧“阅读价值”“重要性”两个数字与旧 55/75 公式作废（旧ADR-0036 的“暂未启用”已被取代）。**热度值 `heat`** 及其派生的趋势、变化百分比、徽标与热度走势只出现在站点接口（网页形态，§3.5）；公开 API、RSS、MCP 的热点只给名次（BR-SEL-05）。影响分不以数字公开（DEC-11）。

### 2.13 公开新鲜度探针、发布标识头与健康端点

- **公开新鲜度探针** `GET /api/v3/freshness`：公网上唯一的运行探针，供不在同一主机上的外部拨测（每 5 分钟读取公开首页与本探针，`04-architecture/07-deployment-and-ops.md` §6.3）与云监控使用。匿名只读，经限流（额度按拨测频率留足余量，不得因限流误报）。响应 `Freshness` = `{generated_at, release, lanes: [{lane: news / policy, last_public_at, last_scheduled_check_ok_at}]}`：`release` 是发布标识（与响应头同值）；`last_public_at` 是该业务线最近一次有内容进入公开读取层的时间；`last_scheduled_check_ok_at` 是该业务线最近一次**计划采集检查成功**的时间（低频官方源按“检查成功加真实无更新”评估，不因没有新法规就判宕机，ADR-0020）；两者都是 UTC 时刻（系统事实，不是来源声明），没有记录时为 null（写“尚未记录”，不写 0）。不返回计数、队列、用量、熔断与暂停状态、信源名与错误细节（INV-10）；只读预聚合的发布水位与调度结果，**不触达复杂查询**，不扫描列表；`Cache-Control: no-store`，不被任何缓存遮蔽；无法确认时返回 503 `service_unavailable` 并带 `Retry-After`。告警阈值（资讯线 12 小时、法规线 24 小时，初值）与判定规则写在部署文档，不进本契约。【设计】（D15-secops-007；INV-30；旧站停更 5 天无人察觉，`docs/reviews/product-production-audit-20260920.md:16-20@main`）
- **发布标识响应头**：所有公开响应（HTML、JSON、RSS、站点地图，含 304 与错误响应）都带发布标识头，值为本次发布的提交短哈希。头名在 M0 确定并写入本契约；旧站为 `X-GMPI-Release`（`infra/tencent-cloud/caddy/Caddyfile.live:85@main`），新站不沿用项目缩写，暂定 `X-Release`。由入口层统一注入，应用逻辑不得依赖它；“已上线”以从主机之外读回该头等于目标版本为准（`07-deployment-and-ops.md` §3.2）。【设计】
- **`/healthz`、`/readyz` 不属于公网契约**：`/healthz`（进程存活，不碰数据库）只在内部网络可达，`/readyz`（数据库与发布读取可用）不对公网开放；二者不进 `/openapi-v3.json`，公开主机名上返回 404 且不带 `Set-Cookie`。旧站曾公开这两个端点，其中公网 `/readyz` 被当作缺陷（`docs/public-api.md:17-18@main`，`docs/runbooks/production-deployment.md:77,130@main`）。【设计】

---

## 3. 数据形状

### 3.1 公共小型类型

- `Labeled` = `{code, label}`；`Attribution` = `{name, url}`；`Jurisdiction`：见 §2.6；`TimeAssertion`：见 §2.5。
- `SourceCredit` = `{source_id, publisher: {id, name}, title_original, original_url, insecure_transport, published_time: TimeAssertion}`。
- `Evidence` = `{evidence_id, source: SourceCredit, locator, excerpt 或 null, relation: supports / contradicts / context}`（取自 B）。

### 3.2 条目卡片 `ItemCard`（列表用，不含正文）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 材料 ID |
| `revision` | integer | 材料修订号（B） |
| `content_kind` | `news` / `policy` / `reference` | 内容类别（B）：`news` 新闻与报道、`reference` 参考材料、`policy` 官方公告类条目（仍是新闻条目，地址不变；被法规线收录为文书后通过 `related_policies` 链接，不删除原条目）；独立的法规文书是 `PolicyCard`，不作为条目出现在新闻列表（DEC-62） |
| `title` | string（≤250） | 中文标题，**只含标题本身，不拼发布方或任何前缀**；发布方在 `publisher`（DR-11） |
| `original_title` | string | 原标题（原文为中文时与标题相同） |
| `guide` | string（≤2000） | 中文导读；列表显示其第一段；**不含署名前缀**，由展示层与各出口统一添加（DR-74） |
| `reason` | string（≤1000）\| null | 推荐理由（入选或接近入选时才有） |
| `category` | `Labeled` | 一级分类 |
| `jurisdictions` | `Jurisdiction[]` | 涉及的法域 |
| `minerals` | `Labeled[]` | 矿种 |
| `publisher` / `source_id` | `{id, name}` / string | 发布方、信源 |
| `original_url` / `insecure_transport` | string / boolean | 原文链接、是否仅非加密访问 |
| `attributions` | `Attribution[]` | 发布方署名，至少一项 |
| `published_time` | `TimeAssertion` | 来源发布时间（含 `label`、`beijing_date`） |
| `updated_time` | `TimeAssertion` \| null（`meaning=updated`） | 来源更新时间，没有则为 null。**列表时间栏的回退链路用**：来源发布时间只有日期精度时，依次显示来源更新时间（“更新”徽标）→ 本站首次公开时间（“本站公开”徽标）→ 都没有显示“—”（DEC-24，读者站通则 4）；回退时间不是来源时间，不参与排序、日分组与日期筛选 |
| `first_public_at` / `first_public_basis` | `TimeAssertion`（`site_public`，形状说明见 §2.5）/ `live` · `unknown` | 本站首次公开时间，写一次、永不改变（INV-08）；`legacy_snapshot_min` 【已废弃】（仅为迁移旧站数据服务） |
| `reading_status` | `full_translation` / `source_original`（原生中文）/ `summary_only` / `translating` / `guide_only` | 阅读状态，取自 A |
| `event_ids` | string[] | 所属事件（B 的数组形态） |
| `story_id` / `thread_id` | string \| null | 所属发展线、政策线 |
| `featured` | boolean | 是否入选精选（规则入选或负责人人工精选，ENT-26） |
| `score` | integer（0–100）\| null | AI 评分：同一份评分标准独立打两次分的**平均值，向下取整**（沿用 AIHOT；入选依据是两次之和 ≥ 2 × 信源分级门槛，显示的只是平均值）。**没有评分时为 null，不是 0、不是占位值**：预筛拒绝、所属信源分级没有门槛、评分失败或被模型拒答、尚未评分、人工精选而没有分值；有评分的条目（不论是否入选）都带分，页面据此显示小标签“AI 评分 · NN”（BR-SEL-07）。两次分值、门槛、评分提示词版本不公开（INV-10） |
| `independent_source_count` | integer | 所属事件的独立来源数 |
| `event_group` | object \| null | **仅站点接口 `fold=event` 的折叠卡带**（公开 API 不折叠，省略）：`{event_id, story_id, other_source_count（页面“另有 N 家来源报道”的 N，按独立来源计，转载同稿不计）, latest_progress: {item_id, title, time} \| null（“最新进展 · 时间 · 标题”一行）, progress_count（“展开 N 条进展”的 N）}`；与 `score`、`reason`、`featured` 一起供事件卡渲染（BR-EVT-12） |
| `ai_label` | `ai_generated` / `ai_assisted_human_edited` | AI 标识（§2.9） |
| `license_note` | string \| null | 开放许可来源的署名说明 |

字段长度是存储与传输上限，内容标准（标题建议 ≤40 个汉字、导读 150–800 字等）见 `06-content-standards.md` 长度表。A 的 `body_available` 删除，由 `reading_status` 表达；条目卡没有 `heat`（热度值只在热点榜的网页形态，§3.5、§2.12）。

### 3.3 条目详情 `ItemDetail`

`ItemCard` 全部字段，外加：

| 字段 | 说明 |
|---|---|
| `times` | `TimeAssertion[]`：来源更新、正式刊发、登记、公开阅览、签署、法律生效等，缺失不输出（A 的 `times`） |
| `reading_zh` | `Reading`：中文阅读（B 的分层，替代 A 的 `body`） |
| `reading_original` | `Reading` \| null：许可允许展示原文时的原文阅读（用于中文/原文切换） |
| `sources` | 所属事件的全部公开来源：`{material_id, publisher, title, url, published_time, relation}`；`relation`：`original` 原始发布 / `independent_confirmation` 独立确认 / `reprint` 转载 / `update` 更新 / `correction` 更正 / `translation` 翻译 / `commentary` 评论 / `conflict` 冲突 |
| `representative_id` / `latest_progress_id` | 代表稿与最新进展（只有一篇时为 null） |
| `timeline` | 发展线中的真实后续：`{event_id, title, relation: same_event / substantive_update / correction / related, time: TimeAssertion}[]` |
| `company_notes` | `{name_zh \| null, original_name, abbreviation?, description, source_url, evidence[]}[]`（与原稿事实分开展示；名称规则见 §2.9） |
| `related_policies` | 报道涉及的法规文书引用卡（`PolicyCard` 精简字段：`id`、`title`、`jurisdictions`），用于详情页“相关法规文书”块（DEC-62） |
| `evidence` | `Evidence[]`（阅读块引用的证据，取自 B） |
| `notice` | 固定说明文字（如“所示时间为文书公开阅览记录时间”），来源特定说明；不含署名（署名走 `attributions`） |

事件成员关系的**三层取值与映射**（规范表；模型输出层取自 `02-rules/03-ai-capabilities.md` AI-08，存储层取自 `01-domain-model.md` ENT-19，公开层是本契约；三处冲突以本表为准）：

| 模型输出（AI-08） | 存储（ENT-19） | 公开呈现（本契约） |
|---|---|---|
| `same_event` + 成员角色 `reprint` / `independent_confirmation` / `cross_language` / `commentary` / `conflicting` | 同一事件的成员，记角色 | `timeline[].relation = same_event`（角色另在 `sources[].relation`，见下） |
| `same_event` + `substantive_update` | 同一事件的成员 | `timeline[].relation = substantive_update`；`sources[].relation = update` |
| `same_event` + `correction` | 同一事件的成员 | `timeline[].relation = correction`；`sources[].relation = correction` |
| `progress` | 同一发展线上的后续事件 | `Event.relations[].relation = updates`，并以 `story_id` 归入同一发展线 |
| `separate`（含 `uncertain`，汇总稿是 `separate` 的 `reason=roundup`） | 不关联 | 不输出；“相关阅读”由 events 另行生成，公开取值 `related`（`timeline[].relation`、`Event.relations[].relation` 都用它），**不得显示为“后续进展”** |

- **成员角色 → `sources[].relation`**：`reprint→reprint`、`independent_confirmation→independent_confirmation`、`substantive_update→update`、`correction→correction`、`cross_language→translation`、`commentary→commentary`、`conflicting→conflict`；代表稿 `→original`。`uncertain` 视同 `separate` 并记原因，不进入公开关系。
- **类型化边**：`Event.relations[]`（新闻事件之间）只出现 `updates`（来自模型的 `progress`）与 `related`；`corrects` / `repeals` / `implements` 只用于 `Policy.relationships`，由原文明示的文号或引文经程序校验生成（AI-18、BR-POL-04）；B 的五值枚举（`updates` / `corrects` / `repeals` / `implements` / `related`）保持不变，消费者须容忍。

### 3.4 阅读 `Reading`、`ReadingBlock`、`ReadingPage`

| `Reading` 字段 | 说明 |
|---|---|
| `mode` | 正文来源三种，取值与 `PolicyExpression.kind` 同一套（DR-95）：`original`（任意语言原文，配合 `language`；来源机关用中文发布的官方中文文本也取此值）/ `official_translation`（官方中文译本，注明发布机关）/ `ai_translation`（AI 翻译，非官方译文）。没有可读正文时为 null（`state` 为 `pending` / `guide_only` / `failed_terminal`）；B 的 `guide_only`、`unavailable` 两个取值由 `state` 表达，不再进 `mode` |
| `state` | `not_needed`（原生中文，无需翻译）/ `pending` / `in_progress` / `complete` / `guide_only` / `failed_terminal`，对应读者三态：**可读**（`not_needed`、`complete`）、**补齐中**（`pending`、`in_progress`，只适用于已公开稿因来源修订或重译而进入的补齐窗口，新外文稿不在此状态下公开，DR-09）、**暂无**（`guide_only`、`failed_terminal`）；各态的读者文案以 DR-82 为准 |
| `guide_only_reason` | `summary_only_permission`（逐源收紧后权限只到摘要）/ `body_unobtainable`（正文确实取不到或不完整）/ `over_limit`（超过读取上限）/ `in_attachment`（核心内容在附件里）四值，后三个是技术原因，**不含预算**（DR-20；不设月度金额上限，没有“预算不足”这一原因）；“仅导读”只剩技术原因与逐源收紧两类情形（Owner 2026-10-01，DEC-33）；仅 `state=guide_only` 时出现，只用于统计，读者页不展示原因（DR-82） |
| `completeness` | `complete` / `partial` / `excerpt` / `unavailable`，描述材料覆盖，`partial` 不能在界面上改名为全文 |
| `completed_blocks` / `total_blocks` | 已完成块数、应有块数；完成段数等于完整目录应有段数才能标 `complete`（跨字段不变量由领域与契约测试验证） |
| `blocks` / `next_cursor` | 首页块（至多 20 个）与续读游标 |
| `attribution` / `limitation` | 来源与 AI 说明文字 / 限制说明（如“请到本站或原文阅读”） |
| `language` / `document_revision_id` / `expression_id` | BCP 47 语言码 / 材料修订 / 语言表达 |
| `redistribution` | `allowed` / `restricted`：外部再分发是否允许（§2.9）；`restricted` 时 `blocks` 为空 |

`ReadingBlock` = `{block_id, kind: heading / paragraph / list_item / table / quote / footnote, text（纯文本，无可执行 HTML）, table_rows, evidence_ids, links: {label, href}[]}`。复杂合并表格与原件图件需要的精细块协议属于接线工作，须同时冻结样例，不能静默扁平化后宣称保真。

`ReadingPage`（`/items/{id}/reading`、`/policies/{id}/reading` 的响应）= `{content_version, generated_at, subject_id, document_revision_id, expression_id, language, mode, resource_completeness, total_blocks, blocks, next_cursor}`。**阅读游标绑定 `document_revision_id` 与 `expression_id`**，不绑定全站版本；材料修订或资格变化时每次续读重新校验，换版返回 409 `revision_changed`，已撤回返回 404/410，客户端整篇重读。`limit` 1–50，默认 20；一页不足以容纳的迟到旧语言响应不得污染当前阅读（客户端按 `expression_id` 丢弃）。【设计】（B:contracts/interface-behavior.md §1 第 6 段 + 旧分支 `docs/policy-upgrade/reader-runtime.md:11-13,20@policy`）

### 3.5 事件、发展线、热点

- `EventCard` = `{id, revision, title, summary, stage（展示用阶段词）, category, jurisdictions, minerals, occurred_time: TimeAssertion, representative_id, latest_progress_id, member_count, independent_source_count, report_count（转载篇数）, story_id, thread_id, status: active / merged, merged_into?}`。
- `Event` = `EventCard` + `items: ItemCard[]`、`relations: {event_id, relation, evidence_ids}[]`、`evidence: Evidence[]`。
- `Story`（发展线，`GET /stories/{id}`）= `{id, title, summary, events: EventCard[]（按时间）, timeline: {event_id, item_id, title, relation, time}[], sources}`；`PolicyThread`（政策线，`GET /policy-threads/{id}`）见 §3.7。
- **热点榜 `HotRanking`**（`GET /hot`；沿用 AIHOT，切换前完成，Owner 2026-10-01 已定，DEC-10）：按事件排名——过去 48 小时内被多个独立信源共同讨论的事件取前 10，独立信源按发布方与来源族去重、转载同稿不计，法规文书不进榜（BR-SEL-05、BR-EVT-11、DEC-62）。响应 = `{content_version, generated_at, computed_at（榜单计算时间）, rule_version（榜单规则版本）, window: {start, end}, entries: HotEntry[]}`，至多 10 条、名次从 1 起。**公开 API 与 MCP、RSS 的形态只给名次**：`HotEntry` = `{rank, event: EventCard, representative: ItemCard, independent_source_count, report_count}`，**没有 `heat`（热度值）、趋势与变化百分比、徽标、热度走势**（沿用 AIHOT：公开 `hot-topics` 与 MCP `get_hot` 只给名次，`events/hot-read.ts` 注明“网页显示热度值，机器出口只给名次”）。数据不足时（没有被多个独立信源共同讨论的事件）返回 200 与空 `entries`，页面显示诚实空态“暂时没有足够的多来源事件”（DR-85），不凑数、不显示虚假排名。
- **热点榜的网页形态 `SiteHotRanking`**（`GET /api/site/hot`，仅读者站使用，同源，不属于对外出口）：每条在 `HotEntry` 之外另带 `heat`（热度值，保留一位小数）、`trend`（`up` / `down` / `flat` / `new` / `unknown`；与 6 小时前相比，只比较采集进度已赶上的参与者，无可比时为 `unknown`）、`trend_pct`、`badges`（`new` / `rising` / `surge` 的子集）、`participant_count`、`source_names`（至多 8 个）、`latest`（最新进展一句话）、`latest_at`、`first_report_at`、`spark`（过去 24 小时每小时热度，旧→新，没有可比快照的小时为 null；峰值由页面从中取）；事件页（`GET /api/site/events/{id}`）另带每小时热度走势 `heat_series` 与“为什么热”`why_hot`（48 小时参与者数、近 6 小时新参与者数、近 24 小时报道数、观察是否完整、当前名次与热度值）。热度公式、窗口与衰减见 BR-EVT-11（AIHOT 现值：窗口 48 小时、半衰期 24 小时）。这些字段**永不进入**公开 API、RSS、MCP 的任何响应（AC-OUT-22）。
- **精选视图与精选同步**（沿用 AIHOT 的 `selected`，切换前完成）：`GET /items?view=featured` 是普通列表视图，数据不足时返回 200 与空 `items`，页面按 PG-02 与 DR-85 显示（首页不带筛选时先放最新动态）；精选只含已过**露出闸**的条目（入选资料等事件归组完成，最多 3 分钟，`visible_after`），同一事件在精选里只出现一次（择代表稿）。为让 Agent 保持一份完整的本地精选副本，公开 API 另有两个同步端点：`FeaturedSnapshot`（`GET /featured/snapshot`，参数 `limit` 1–1000、默认 500，`page` 为上一页的 `next_page`）= `{as_of, cursor（同步水位，不透明）, count, has_more, next_page, items: ItemCard[]}`，`items` 按 ID 排序；`FeaturedChanges`（`GET /featured/changes`，参数 `cursor` 必填、取自快照或上一次变更的 `cursor`，`limit` 1–100、默认 100）= `{cursor, count, has_more, changes: ({op: upsert, changed_at, item: ItemCard} | {op: remove, changed_at, id})[]}`。用法：先取一次完整快照，再用它的 `cursor` 反复取变更；分页续取沿用首页的水位；水位缺失、无法识别或来自重建前的账本返回 409 `snapshot_required`，客户端重新取快照；下架或取消精选时变更里出现 `remove`，新快照不含该条目（60 秒内，DEC-48）。AIHOT 的 `fields=minimal` 不沿用：它去掉署名与原文链接，与“每条公开内容带署名”冲突（INV-20）。【设计】（AIHOT `publication/v1.ts` 的 `selectedSnapshot` / `selectedChanges` 与 `reference/public-v1.openapi.json`）

### 3.6 报告、主题、产品更新、收藏、设置、分面

- `ReportCard` = `{id, type: daily / weekly / monthly / policy_weekly / policy_monthly, period_key（资讯线沿用 AIHOT：日报 = 出刊日 YYYY-MM-DD，周报 = 所覆盖的 ISO 周 YYYY-Www，月报 = 所覆盖的自然月 YYYY-MM；法规周月汇总按北京时间自然周、自然月）, title, summary, period_start, period_end（覆盖的时间窗，北京时间，左闭右开；资讯日报为出刊日前一日 08:00 至出刊日 08:00，带时分；周报为上一个 ISO 周，月报为上一个自然月）, timezone: "Asia/Shanghai", issued_at（出刊时间，即编制完成的时刻；正常为日报 08:00、周报周一 10:00、月报 1 日 10:30，补出的刊期晚于此；页面把出刊日期与覆盖期间分开显示）, edition, correction_of, item_count, status: compiled / synthesizing / ready / synthesis_failed, coverage_note}`。报告列表响应另有 `status: available / empty`，区分“本期没有内容”与“生成失败”。
- `Report` = `ReportCard` + `sections: {title, paragraphs: {text, evidence_ids, item_ids}[]}[]`、`items`、`evidence`、`withdrawn_item_ids`（阅读时提示“部分原收录内容现已不可公开，阅读时已移除”）。`/reports` 只列新闻线三种类型；法规周/月汇总走 `/policies/reports`（DEC-62）。
- **报告选材（DEC-65，沿用 AIHOT）**：日报、周报、月报从**精选候选**里取材，同一事实去重，受版面容量限制；日报导语、周报与月报综述由模型写（AI-13，矿业化；失败退回确定性标题与要点，由 `status` 表达）；`item_count` 是本期**实际刊载**的条目数，不是本期全部合格内容的条数；`coverage_note` 写明本期取材范围（取材于精选候选，不代表本期全部内容），全量内容在“全部矿业动态”里看。**出刊时间与时间窗也沿用 AIHOT**（北京时间，BR-TIME-09）：日报每天 08:00 出刊，日期为 D 的日报覆盖 [D-1 08:00, D 08:00)；周报每周一 10:00、月报每月 1 日 10:30；每小时检查一次并补出缺的刊期；资料进入站点后跨过刊期边界才确定精选公开时间的，归入下一期候选池，**不设“补录”**，历史期只因更正与下架修订（DEC-65）；法规周月汇总是另一套确定性快照（北京时间自然周、自然月），不受本条影响（`10-policy-service.md`）。
- `Topic` = `{id, kind: country / mineral / company / project / policy, slug, title, summary, count}`；五个维度按 Owner 原话定（国家、金属、矿企、项目、法律监管，DEC-26）；`policy` 类只带指向法规栏目的筛选条件，不重复列条目；`company`、`project` 在实体词表可用后才出现；分类是筛选项，不是主题维度。`GET /topics/{id}` = `Topic` + 条目与事件列表。
- `ProductUpdate` = `{id, type: {code: announcement / update / improvement / retirement, label: 公告 / 更新 / 优化 / 下线}, title, paragraphs[], highlights[], published_time}`。类型固定四值，登记前校验，失败阻断发布并告警（旧站曾因用了枚举外的“修复”而漏记，见 R16-docs-006）；没有新产品说明的软件版本登记一条简短的例行维护记录。站点接口 `page_size` 默认 30、最大 50；公开 API 游标。【已验证】（旧 `apps/web/lib/reader/types.ts:168-180@main`、`services/live_pipeline/release_notes.py:13-14,39-41@main`）
- `Saved`（`GET /saved?ids=a,b`，≤100，条目、事件、法规文书的 ID 可混用，类型由 ID 前缀判定）= `{content_version, generated_at, items: ItemCard[], events: EventCard[], policies: PolicyCard[], unavailable_ids}`（收藏引用带类型：条目、事件、法规文书，通则 11）；已下架与失效只返回 `unavailable_ids`，不泄露下架理由。收藏只存在读者浏览器，接口只做解析；读者站也用它在撤回代次变化时核对当前页对象（§2.2）。
- `Settings`（仅站点接口）= `{site_name, tagline（“全球矿业资讯”，Owner 2026-10-01 已定，Q-01，DEC-27）, description, contact: {email, url}, icp_filing: {number, url} 或 null, public_security_filing: {number, url} 或 null, news_license: {number, category, valid_until} 或 null, metal_links: {name, url, label}[], public_api_base, features: string[]}`。**页脚合规信息**（Owner 2026-10-01 已定，DEC-39、DEC-40）：`icp_filing` 与 `public_security_filing`（公安联网备案号，页脚带公安备案图标，各自的 `url` 指向官方查询页；公安联网备案已办好，Q-27）都取自受保护的运行时配置，由 Owner 经安全方式提供，**生产环境任一未配置则公开站不得开放**，所以生产响应里两者恒非空，只有开发与测试环境可为 null（不写占位、不回退虚构值）；`news_license`（互联网新闻信息服务许可证，Q-28 已取得：`number` 编号、`category` 服务类别、`valid_until` 有效期 `YYYY-MM-DD`）同样取自受保护配置，在关于页与页脚展示，未配置时为 null、不写占位（BR-SITE-03）。这三项不经私有接口 `settings` 编辑。
- `Facets` = `{categories: Facet[], jurisdictions: {country: Facet[], subdivision: Facet[], organization: Facet[]}, minerals: Facet[], sources: Facet[]}`（键名沿用 B，`jurisdictions` 改为按 `kind` 分组），`Facet` = `{code, label, count}`；站点接口另有 `day_counts: {date, count}[]`。

### 3.7 法规文书（以 B 的 Policy 系列 DTO 为底）

列表 `PolicyCard`：

| 字段 | 说明 |
|---|---|
| `id`、`title`、`original_title` | 文书稳定身份与中文/原文标题；中文标题不决定文书身份 |
| `jurisdictions` | `Jurisdiction[]`（取代 B 的 `jurisdiction_path`，层级由 `parent` 表达） |
| `authority` / `instrument_number` | `{id, name}` 发布机关 / 文号（可空） |
| `nature` | `Labeled`：`law` 法律 / `regulation` 法规 / `amendment` 修正 / `draft` 草案 / `notice` 通知 / `guidance` 指引 / `treaty` 条约 / `judgment` 裁决 / `unknown`（取值与旧分支实现一致，`interpretation.py:399-438@policy`；B 与第一轮写作的 `guideline`、`ruling` 作废） |
| `themes` | `Labeled[]`：七经营主题，键为 `investment_company`、`mineral_rights`、`land_construction`、`safety_environment`、`labour_community`、`tax_finance`、`trade_transport`（与 `10-policy-service.md` §2、`07-sources-and-coverage.md` 一致，沿用旧分支的七个键；B 自拟的 `mining_rights`、`construction_land`、`labor_community` 作废，否则与法规服务文档和覆盖矩阵对不上；旧分支研究数据不导入，DEC-42），由 `impacts` 汇总得出 |
| `change_kind` | `Labeled` \| null：首次公布 / 实质修订 / 勘误 / 废止 / 施行 / 登记汇编 / 其他 |
| `published_time` | `TimeAssertion`：已确认发生的原文首次公布日期（法规分支 `publication_date` 同义） |
| `sort_time` / `sort_kind` | 列表排序用时间与种类（`published` / `substantive_change`）；注册、汇编、计划与附条件日期不推进排序，日期未知的单列在后并按本站公开时间排序（`packages/contracts/policy/README.md:8,23-25@policy`） |
| `first_public_at` / `first_public_basis` / `source_checked_at` | 本站公开时间（形状与取值见 §2.5）及其依据、原文最近核对时间（三个时间分开显示；法规线迟到的旧日期资料标“补录”，资讯线报告不设补录） |
| `is_backfill` | boolean（法规线）：迟到的旧日期资料标“补录”（BR-POL-14；资讯线报告不设补录，BR-TIME-09） |
| `legal_brief` | `{stage, in_force, repeal}`：由分维状态直接取值的摘要（`stage` 取 `legal_state.legislative_stage`，`in_force` 取 `yes` / `partial` / `no` / `unknown`，`repeal` 取 `legal_state.repeal`），**不得从日期推断生效** |
| `interpretation_state` | `basic_facts` / `partial` / `complete` / `withheld` |
| `summary` | string \| null：一句摘要，只写已核实的变化或基本事实，不写未核验结论（≤300 字；列表卡片用，PG-19） |
| `applicability_summary` | string \| null：一行适用范围 |
| `thread_id` | string \| null：政策线（A 的 `thread_id` 移植） |

详情 `Policy` = `PolicyCard` 全部字段，外加：

| 字段 | 说明 |
|---|---|
| `legal_state` | **分维法律状态**（取代 B 的单一 `legal_status` 枚举与 A 的 13 值“阶段”，DEC-36）：`nature`（取值同上）、`legislative_stage`（`proposed` 拟议 / `consultation` 征求意见 / `adopted` 已通过 / `published` 已公布 / `unknown`）、`publication`（`published` / `not_published` / `unknown`，加公布日期）、`enforcement`（施行，整体或分项，各带 `text`、`time`、`condition`，取值 `whole` / `partial` / `not_in_force` / `unknown`）、`applicability`（适用期）、`deadlines`（截止事项）、`repeal`（`repealed` / `partly_repealed` / `unknown`）。**每一维都可为 `unknown` 且带 `basis` 与 `evidence_ids`**；未知是合法状态；`in force` 不自动代表所有条款施行，计划或附条件日期不作为已发生。枚举取值与旧分支实现一致（`services/policy_intelligence/interpretation.py:399-438@policy`【已实现未验证】；旧分支字段名 `stage`、`promulgation`、`commencement` 对应本契约的 `legislative_stage`、`publication`、`enforcement`） |
| `dates` | `TimeAssertion[]`：全部日期安排与条件（公布、正式刊发、签署、生效、适用、截止、登记、公开阅览），日期不补时分 |
| `attachment_inventory` | `{title, url, decisive, rights: public / restricted / unknown, status: complete / missing / restricted / not_required / blocked_capacity}[]`；决定性附件缺失时 `interpretation_state` 不得为 `complete`，超限记 `blocked_capacity`，不改成“只留元数据”后算处理完毕 |
| `versions` / `expressions` | `PolicyVersionRef[]`（法定版本）与 `PolicyExpression[]`（语言表达），二者分开；`selected_policy_version_id`、`selected_expression_id` 标明当前选择 |
| `reading` | 所选表达的阅读状态摘要（`blocks` 恒为空，正文走 `/policies/{id}/reading`） |
| `main_points` | `{text, clause_ref, evidence_ids}[]`：主要条款要点，每条一句中文，`clause_ref` 是条款位置（如“第 12 条第 2 款”），≤200 字符的原文短引放在被引用的 `evidence[].excerpt` 里（AI-20；数量上限为工程配置，旧分支 16 条） |
| `guide` | string \| null：法规动态导读（AI-20 的 `dynamic_zh`，建议 300–800 字，存储与契约上限 2000，DR-17），由全文事实归并生成；只在 `interpretation_state=complete` 时有值，否则为 null；不含署名前缀 |
| `gaps` | `string[]`：待核实事项（≤5 条，“尚不明确”的写法；读者页“待核实事项”块，PG-18 第 9 项） |
| `impacts` | **`PolicyImpact[]`**：`{id, theme（七主题键）, region, legal_actor（法定主体）, affected_actor（受影响主体）, activity（活动）, condition, effect_mode: direct / indirect, impact, deadline?, exceptions?, evidence_ids[]}`；**没有数值分、没有影响等级、没有 `horizon` 字段**：当前影响与潜在影响分条写，潜在影响在 `condition` 里写明前提；`relevant` 的文书至少一条；银行等法定主体的义务不得改写为矿企义务，矿企只在明确条件下列为间接受影响（D11-policy-005、DEC-11；BR-POL-13、AI-20） |
| `sections` | `InterpretationSection[]`：`{title, text, basis: source_fact / interpretation / uncertain, evidence_ids, conditions, exceptions}`，作为叙述段落保留 |
| `relationships` | `{relation: updates / corrects / repeals / implements / related, target_policy_id \| null, target_citation, evidence_ids}[]`：目标须同时匹配法域与明确文号，目标当前合格且唯一才给链接，歧义不猜测；不声称完整版本链 |
| `related_items` | 报道该文书的新闻条目引用卡（反向链接，不删除原新闻条目，DEC-62） |
| `evidence` / `attributions` / `ai_label` / `limitation` | 证据、署名、AI 标识、限制说明（外文原件的中文必须标明 AI 辅助译文、非官方译文） |

- `PolicyVersionRef` = `{id, version_label, expression_ids, current, legal_brief}`；`PolicyExpression` = `{id, policy_version_id, document_revision_id, language, kind: original / official_translation / ai_translation, issuing_body（官方中文译本必填）, instrument_number, checked_at, reading_state: complete / partial / restricted / unavailable}`。各语言独立保留中文、原文、文号与核对时间；切换语言不换文书版本；一种表达撤回不影响其他表达；失效的语言不得回退到别的语言显示。
- **完整解读的公开前提**（写在契约里的可见结果）：相关性已判定且至少一条结构化影响；性质、制定阶段、公布状态三维都不为 `unknown`，否则只以 `basic_facts` 公开；本次实际响应的模型在资格范围内；并排阅读须同时有“公开原文”和“公开译文”许可（新建信源九项一律“允许”，被逐源收紧即不具备）；公开条目到期时间 = min(质量资格到期, 带明确期限的补充证据到期)，到期自动下线（D11-policy-002）；`owner_declared` 许可不设自动到期、不参与到期计算（Owner 2026-10-01，DEC-33）。细则在 `10-policy-service.md`。
- **不进公开 DTO 的法规内部字段**：相关性判定 `relevance`（含 `excluded`、`uncertain`，私有保留供覆盖统计）、质量资格 QualityRelease（评测哈希、评判人、到期细节）、解读候选与全篇语义核验的输出、模型执行身份、来源用途契约与证据、取得回执、目录扫描与覆盖单元格；公开端只表现为 `interpretation_state` 与到期自动下线（BR-POL-10、BR-POL-11、`10-policy-service.md` §6；INV-10）。
- **版本记录 `PolicyHistoryPage`**（`GET /policies/{id}/history`，站点接口与公开 API 都用游标 `cursor` + `limit`，页面“继续查看版本记录”；历史游标与当前游标不可混用）= `{content_version, generated_at, policy_id, items: PolicyHistoryEntry[], next_cursor}`；`PolicyHistoryEntry` = `{policy_version_id, expression_id, document_revision_id, language, instrument_number, kind: original / official_translation / ai_translation, current: boolean（“当前可读版本”或“历史公开快照”）, first_public_at（本站公开）, published_time（原文公布）, original_version（原文版本标识）, checked_at（该原件留存时核对）}`。只列仍具备公开资格的版本，已撤回或失效的版本不返回标题与摘要；这是**本站版本记录，不等于法定沿革**，不提供新旧对比。读取某个历史公开快照用 `GET /policies/{id}?policy_version_id=…&expression_id=…&document_revision_id=…`，三者须匹配且仍有资格，否则 404；历史快照页不收录（读者站通则 18）。【设计】（PG-22；F-POL-10、F-066；法规分支 `apps/web/components/policy/pages.tsx:596-659@policy`、`docs/policy-upgrade/historical-reading.md:3-19@policy`；`10-policy-service.md` F-066 卡）
- **身份与 ID**：`Policy.id`、`Item.id` 等对外主键是创建时生成的不可变代理 ID，不从文号、网址、法域或许可派生（INV-18、PIT-021）；文书的天然身份键（法域 + 发布机构稳定 ID + 文书类型 + 原文文号，无文号时退化为来源身份 + 官方 URL 并标记“弱身份”）只用于去重匹配，不对外作标识；文号勘误或机构更名走“旧身份退出 → 原件核对 → 新身份 → 可拆回”，不改代理 ID（D17-pitfalls-018）。
- `PolicyThread` = `{id, title, summary, jurisdictions, stages: {stage_label, policy_id 或 null, event_id 或 null, time: TimeAssertion, relation}[], policies: PolicyCard[]}`，阶段标签用受控词，不作为文书的数据模型。
- `PolicyScopeList`（`GET /policies/scope`）= `{items: {jurisdiction: Jurisdiction, readable_count}[], note}`：33 国与 EU/UN/OECD 分别列出当前可读篇数；篇数不代表信源或法域覆盖完成率，组织不计入国家。
- `JurisdictionCard`（`GET /jurisdictions`，法域字典）= `Jurisdiction` + `{news_scope, policy_scope, news_count, policy_count}`。
- 法规周/月汇总 = `Report`（`type=policy_weekly / policy_monthly`）+ `coverage: {jurisdiction, registered_source_count, receipt_status, available_count}[]`（全部国家与组织逐项列登记来源与回执情况）；成员分区与“补录”见 BR-POL-14（法规线周月汇总按北京时间自然周、自然月，确定性快照）；资讯线报告的选材与出刊时间见 BR-RPT-02、BR-TIME-09（沿用 AIHOT）。
- 依据：B:contracts/openapi.json 的 `Policy`、`PolicyCard`、`PolicyVersionRef`、`PolicyExpression`、`InterpretationSection`、`ReadingPage`；法规分支只读协议（`packages/contracts/policy/README.md:3-39@policy`）。法规分支的列表游标绑定“公开代次”并在变化时返回 409 `policy_publication_changed`；v2.0 改为与资讯线一致的筛选绑定游标（§2.3），资格变化靠每次查询重新过滤，以免外部程序翻页频繁失败。【设计】

### 3.8 法规接口的筛选参数

`q`（≤120，搜索中文名、原文名、文号与发布机构）、`jurisdiction`（选国家时包含其下级）、`theme`（七主题键，枚举见 §3.7 `themes`）、`nature`（文书性质，枚举见 §3.7）、`stage`（制定阶段，即 `legal_state.legislative_stage`：`proposed` / `consultation` / `adopted` / `published` / `unknown`）、`from`、`to`（北京自然日闭区间，对 `sort_time` 生效，只有日期精度的不平移，DEC-49）；分页：站点接口 `page`、`page_size`（默认 20，≤50，返回 `total`、`has_more`，越界 200 空列表），公开 API `cursor`、`limit`（§2.3）。列表与国家计数按文书、不按语言；33 国与 EU/UN/OECD 不混计。页面侧若删减筛选项，以页面规格为准并同步删除契约参数；两边不得不一致（D03-reader-pages-005）。【设计】

### 3.9 延后：金属价格数据（不进首版 OpenAPI）

金属价格表是保留的产品目标。Owner 2026-10-01 已定（Q-11，A）：先只放官方入口，由开发方调研免费或低价的官方数据源并报价，Owner 再定是否开通站内价格表；**数据源、展示许可与费用仍须 Owner 批准后才启用**；开通前页面只放官方入口与说明，不出任何数字，不放空表格框架，该状态不计为价格表完成（DEC-07，Q-11，`apps/web/components/reader/information.tsx:61-85@main` 的旧站现状）。因此 `GET /metal-prices` 不在首版契约中；站点设置的 `metal_links` 承载官方入口。启用时的数据形状沿用 B 的 `Quote`：`{id, commodity, benchmark, venue, grade, delivery_basis, price_decimal（字符串小数）, currency, unit, as_of, delay_label, status: available / stale / unavailable / restricted, source_url, source_name, license_label}`；`available` 必须有真实值与时点，缺数为 `unavailable`/`restricted`，不得填 0 或模型估价，不同基准或单位不混算；换汇与涨跌比较属未确认扩展，不在验收内。启用前置条件：已确定数据源、取得站内展示许可、品种清单经 Owner 确认。

---

## 4. 端点清单

“阶段”列只有两档（Owner 2026-10-01 已定，DEC-19）：**切换前完成**（全部排期端点，写明在哪个里程碑做完，全部完成后在 M5 一次性全面切换）与**候选（不排期）**；v2.1 起删去原“切换必备 ●/○”（即 ★ 与“切换后”）。功能编号：公开读取层 F-PUB-01、RSS F-PUB-02、公开 API F-PUB-03、公开 MCP F-PUB-04、站点地图等 F-PUB-05、AI 标识 F-PUB-07；F-PUB-06（旧链接与旧接口）在本文只剩一句规则（§5.1）。阶段以 `01-product/02-feature-catalog.md` §10 为准。法规线接口与资讯线同步设计、同步建设（DEC-01），随法规线功能与管线计入切换门槛，36 个法域的覆盖度不作门槛，公开时点由质量门决定。

### 4.1 公开 API v3（`/api/v3`）

| 方法 路径 | 参数 | 返回 | 阶段 |
|---|---|---|---|
| `GET /version` | — | `{content_version, generated_at, state}` | 切换前完成（M1） |
| `GET /freshness` | — | `Freshness`（§2.13：各业务线最近公开时间、最近一次计划检查成功时间、发布标识） | 切换前完成（M2，随首次生产部署，外部拨测依赖） |
| `GET /items` | `view=all / featured`、`q`、`category`、`jurisdiction`、`mineral`、`source`、`from`、`to`、`on`、`topic`、`cursor`、`limit`、`facets` | `ItemCard[]`（含 `score`，§3.2）+ `next_cursor` + `facets?` | 切换前完成（M3） |
| `GET /items/{id}` | — | `ItemDetail`；已下架 410 | 切换前完成（M3） |
| `GET /items/{id}/reading` | `expression_id`、`cursor`、`limit` | `ReadingPage`（仅 `syndicate_fulltext` 允许的来源返回正文） | 切换前完成（M3） |
| `GET /saved` | `ids`（逗号分隔，≤100） | `Saved` | 切换前完成（M3） |
| `GET /events`、`GET /events/{id}` | 同 `/items` 的筛选（`/events` 另有 `status`） | `EventCard[]`、`Event`；事件合并后有去向时 308 + `Location`，没有去向 410（本站自己的合并别名，ENT-78） | 切换前完成（M3） |
| `GET /hot` | — | `HotRanking`（只给名次，不含热度值，§3.5） | 切换前完成（M3） |
| `GET /featured/snapshot` | `limit`、`page` | `FeaturedSnapshot`（精选完整快照，§3.5） | 切换前完成（M3） |
| `GET /featured/changes` | `cursor`、`limit` | `FeaturedChanges`（`upsert` / `remove`；水位失效 409 `snapshot_required`，§3.5） | 切换前完成（M3） |
| `GET /stories/{id}` | — | `Story`；合并后有去向时 308 + `Location` | 切换前完成（M3） |
| `GET /topics`、`GET /topics/{id}` | `kind`、`cursor`、`limit` | `Topic[]`、`Topic` + 条目与事件 | 切换前完成（M3） |
| `GET /reports`、`GET /reports/{id}` | `type=daily / weekly / monthly`、`cursor`、`limit` | `ReportCard[]` + `status`、`Report` | 切换前完成（M3；切换当天日报、周报、月报必须已有） |
| `GET /changelog` | `cursor`、`limit` | `ProductUpdate[]` + `next_cursor` | 切换前完成（M3） |
| `GET /jurisdictions` | `kind`、`news_scope`、`policy_scope` | `JurisdictionCard[]` | 切换前完成（M3） |
| `GET /policies` | §3.8 | `PolicyCard[]` + `next_cursor` | 切换前完成（M3，法规线） |
| `GET /policies/{id}` | `policy_version_id`、`expression_id`、`document_revision_id`（读取历史公开快照，三者须匹配，§3.7） | `Policy`；已撤回 410 | 切换前完成（M3，法规线） |
| `GET /policies/{id}/reading` | `policy_version_id`、`expression_id`、`cursor`、`limit` | `ReadingPage` | 切换前完成（M3，法规线） |
| `GET /policies/{id}/history` | `cursor`、`limit` | `PolicyHistoryPage`（本站版本记录，§3.7；历史游标与当前游标不可混用） | 切换前完成（M3，法规线） |
| `GET /policies/scope` | — | `PolicyScopeList` | 切换前完成（M3，法规线） |
| `GET /policies/reports`、`GET /policies/reports/{id}` | 列表：`type=policy_weekly / policy_monthly`、`cursor`、`limit`；详情：`edition`（报告修订号，读取较早快照）、`jurisdiction`、`theme`、`cursor`、`limit`（续读绑定该修订，PG-21） | `ReportCard[]`、`Report` + `coverage` | 切换前完成（M3，法规线） |
| `GET /policy-threads/{id}` | — | `PolicyThread` | 切换前完成（M3，法规线） |

文档：`GET /openapi-v3.json`（由 Zod 生成，不手写）；说明页：读者站“Agent 接入”（PG-12；只写新接口的真实用法，不提及任何旧站接口，不得出现“V1、V2 继续兼容”一类承诺）。MCP、RSS、站点地图、`robots.txt`、`llms.txt`、分享图见 §4.4 与 `contracts/non-json-outputs.md`。

### 4.2 站点接口（`/api/site`）

只供读者站，全部 GET（反馈除外），页码分页；JSON 形状与公开 API 同源，另加页面需要的聚合。下表“AIHOT 对应”列标明底座路由的去留（`apps/api/src/routes/site.ts`）。

| 路径 | 页面用途与聚合 | AIHOT 对应 |
|---|---|---|
| `GET /items` | 全部动态、精选、搜索与筛选：`page`、`page_size`、`view`、`q`、`category`、`jurisdiction`、`mineral`、`source`、`from`、`to`、`on`、`topic`、`seen_version`、`fold`（`event` / `none`：事件折叠只用于无 `q` 与筛选条件的默认浏览，带搜索词或筛选时一律按篇；折叠卡的代表稿带 `independent_source_count`，页面写“另有 N 家来源报道”；默认 `event`——Owner 2026-10-01 已定（Q-26，A）：全部矿业动态里同一事件折叠成一张卡，展示沿用 AIHOT 的事件卡与事件页（代表稿 + “另有 N 家来源报道” + 事件综述），搜索与筛选仍按篇，DEC-25、通则 7；公开 API 不折叠）；返回 `total`、`has_more`、`facets`、`day_counts`；有 `q` 且首页时另含 `policy_matches: {total, items: PolicyCard[≤5]}`（全库搜索的“法规政策”分区，链接到 `/policies/{id}`，DEC-62） | 改造：合并 `timeline`（游标）与 `pool`（页码，上限 50 页）为单一页码接口 |
| `GET /items/{id}` | 详情中文视图；按“站内展示”许可返回正文；含事件摘要与来源列表 | 改造：`items/:id` |
| `GET /items/{id}/reading` | `expression_id` 选中文/原文表达；块游标 | 改造：取代 `items/:id/original` |
| `GET /saved` | 收藏解析（条目、事件与文书）；也供撤回代次变化时核对当前页对象（§2.2） | 改造：`items/availability` |
| `GET /events/{id}`、`GET /stories/{id}` | 事件与发展线详情（合并旧“后续进展”“发展线成员”查询）；事件页另带热度走势 `heat_series`（事件热度的每小时快照）与“为什么热”`why_hot`（网页形态，§3.5），右栏所需的 `official_items`（官方与当事方稿，至多 5 条）、`first_report_at`、`last_updated_at`（“事件记录”）；报道时间线 `items` 按 `tab`（全部 / 官方与当事方 / 精选）、`sort`（默认最早在前 / 最新在前）与 `page` 分页（每页 20 篇） | 改造：`stories/:publicId`、`followups` |
| `GET /events/{id}/sources` | 事件卡“另有 N 家来源报道”展开面板：同一事件的其他来源分页列表（来源名、标题、原文外链、发布时间，不含代表稿自身）；`page`、`page_size`（默认 20，最大 40）；带 `revision`，事件换版时返回 409 `revision_changed`，面板整体重读 | 改造：`groups/:factId/reports` |
| `GET /stories/{id}/developments` | 事件卡“展开 N 条进展”面板与事件页进展时间线：发展线上真实后续事件的分页列表（时间倒序；每项“时间 · N 篇报道 · 进展标题（链到该进展的代表稿）· 来源：标题”）；`page`、`page_size`（默认 10，最大 20）；同样带 `revision` 与 409 `revision_changed` | 改造：`stories/:publicId/developments` |
| `GET /hot` | 最新热点榜与计算时间、规则版本；网页形态带热度值（`SiteHotRanking`，§3.5）；数据不足时空 `entries`，页面显示诚实空态 | 改造：`hot`（保留并矿业化） |
| `GET /topics`、`GET /topics/{kind}/{slug}` | 只含有内容的主题及条数；主题页条目分页 | 改造：`topics`、`topics/:slug` |
| `GET /reports/{type}`、`GET /reports/{type}/latest`、`GET /reports/{type}/{period}` | 各周期最新一期与历史目录、上一期/下一期、按月目录（放在响应的 `nav` 内） | 改造：`reports/:kind`、`latest-page`、`navigation/:key`、`daily/months/:month`、`reports/:kind/:key` |
| `GET /changelog` | 产品更新，`page`、`page_size`（默认 30，最大 50） | 保留改造 |
| `GET /settings` | 站名、副标题、介绍、联系方式、ICP 备案号、公安联网备案号、新闻许可证编号与有效期、官方入口（`metal_links`）、`features`（§3.6） | 改造：`meta`、`contact` |
| `GET /version` | 内容版本检查（“有新内容”）；另返回不透明的 `suppression_epoch`（撤回代次，通则 10 用它在无新增内容时也能即时移除被下架对象，§2.2） | 新增 |
| `GET /jurisdictions` | 法域字典与计数 | 新增 |
| `GET /policies`、`/policies/{id}`、`/policies/{id}/reading`、`/policies/{id}/history`、`/policies/scope`、`/policies/reports`、`/policies/reports/{id}`、`/policy-threads/{id}` | 法规栏目三页、版本记录页与周月汇总；列表用 `page`/`page_size`，版本记录与正文块按游标（正文每页 20 个节点）；返回位置与收藏状态独立于新闻 | 新增 |
| `POST /feedback` | 见 §4.3 | 改造：`feedback.ts` |

不在本契约内的 AIHOT 站点路由（`stats`、`items/:id/markdown`、`img-proxy`、`codex-reset*`）按 `04-architecture/04-aihot-adoption.md` 的差距表处置；`codex-reset*` 属 AI 行业专属模块，删除。

### 4.3 反馈提交（DEC-53）

`POST /api/site/feedback`（站点接口，同源）：`{message（10–5000 字）, page_url?（站内路径或本站地址，≤2048）, contact?（≤254）, screenshot?（单张 PNG/JPEG/WebP，≤2MB，按真实格式校验；multipart 或 base64）}`，可带 `Idempotency-Key`（重复提交返回同一回执）。成功返回 **201 `{ok: true, id}`**（真实收件 ID）；失败或结果未知时页面**不得显示“已收到”**。限流初值沿用旧站：每客户端每小时 5 条、全站每天 500 条，可配置，另设更严的桶。截图私有，不公开、不送模型（INV-27）；处理完成后 180 天自动删除联系方式与截图，保留去标识的正文与处理记录（DEC-46）。B 的多附件令牌上传不进首版契约，列为后续增强（它会引入一个没有契约的匿名上传端点）。【已验证】（字段与限值：`services/live_pipeline/operations.py:23-24,1187-1240@main`；`docs/architecture/decisions/0032-mining-news-product-overhaul.md:55-58@main`）

### 4.4 其他出口（详见 `contracts/non-json-outputs.md`）

| 路径 | 内容 | 阶段 |
|---|---|---|
| `/feed/all.xml` | 全部矿业动态 RSS（最近 50 条） | 切换前完成（M3） |
| `/feed.xml`、`/feed/daily.xml` | 精选 RSS（暂时没有符合条件的精选时为合法空 feed，不输出评分）、日报 RSS | 切换前完成（M3） |
| `/feed/policies.xml` | 法规政策动态 RSS | 切换前完成（M3，法规线） |
| `/feed/full.xml` | 全文 RSS（只含 `syndicate_fulltext` 允许的来源） | 候选（不排期；第十项许可默认关闭，Q-47） |
| `/sitemap.xml`、`/robots.txt` | 公开且有中文导读的条目、报告、主题、法规文书页；下架后移出 | 切换前完成（M3） |
| `/llms.txt`、`/api/mcp` | 大模型说明、公开只读 MCP | 切换前完成（M3） |
| `/og/{id}.png` | 分享图 | 候选（不排期） |
| `/openapi-v3.json` | OpenAPI 文档 | 切换前完成（M3，契约在 M1 冻结） |

RSS 规则见 `non-json-outputs.md`：链接指向本站详情；`guid` 用本站条目 ID（公开 ID 不复用），`isPermaLink=false`；只有日期的条目输出 `dc:date`、不输出 `pubDate`；描述为署名加导读首段；下架后立即消失。

---

## 5. 旧站地址与版本

### 5.1 旧站地址：不做任何兼容（DEC-21，Owner 2026-10-01）

> **新站不为旧站的任何地址做兼容或重定向；不存在的地址（含旧站地址）一律 404；新公开 API 用 `/api/v3` 前缀。**

v2.0 的“旧公开路径处置表”（旧 RSS 与旧页面链接 301、旧机器接口 90 天适配期后 410、`Deprecation` / `Sunset` / `Link` 迁移响应头、调用量记录与退场公告）连同逐字段映射表全部删除（Owner 说“旧文章链接也全都不要，相当于从 0 开始做文章内容”；新站从空库开始，DEC-20）。404 的形态见 §2.7：接口类地址返回统一错误体 `not_found`，页面类地址走通用“页面不存在”页（读者站规格）；不带 `Location`、`Deprecation`、`Sunset` 头，也不设 410 专门响应。

### 5.2 公开 API 版本规则

公开 API 只做追加：新增可选字段、新增端点、新增枚举值对旧调用方无害，**消费者须容忍新增的可选字段与枚举值**；DTO 一律封闭（`additionalProperties=false`）。删除字段、改变含义、收紧必填与枚举删减属破坏性变更，必须发布 `/api/v4` 并与旧版并行至少一个发布周期（ADR-0013）。公共 DTO、内部事件、数据库迁移分别版本化，不用同一个“v2”暗示三者一致。

### 5.3 契约源码与生成链路（DEC-31）

`packages/contracts` 的 Zod schema 是**唯一事实源** → 生成 OpenAPI 3.1（对外文档与 `/openapi-v3.json`）→ 生成 api-client 与 mock。漂移检查与破坏性变更检查由验证命令执行（可替换执行器，默认不依赖 GitHub Actions，旧ADR-0038）。B 的 `openapi.json` 与 `examples.json` 是首版输入与契约测试样例：按本文逐项修订后**一次性转写**为 Zod；`tools/build_contracts.py` 不进入新仓库。禁止同时维护手写 OpenAPI、TypeScript interface 与 Zod 三套不比对的定义。

---

## 6. 相对 A、B 原稿的变化索引

| 项 | A 原稿 | B 原稿 | v2.1 |
|---|---|---|---|
| 公开 API 前缀 | `/api/v1`，旧 `/api/v1/*` 又一律 410 | `/api/v1` | `/api/v3`；不为旧站任何地址做兼容，不存在的地址一律 404（§5.1） |
| 分页 | 站点页码 + 公开游标 | 只有游标 | 保留 A 的双通道（§2.3） |
| 版本与游标 | 单调版本，游标语义缺失 | 钉住读取、游标绑定版本 | 不透明版本，无钉住，游标绑定筛选（§2.2） |
| 时间 | 扁平三元组 | `TimeAssertion` | `TimeAssertion` + `label` + `beijing_date`（§2.5） |
| 管辖 | `countries`（ISO 国家码） | `jurisdictions` 字符串、`jurisdiction_path` | `jurisdictions` 对象含 `kind`（§2.6） |
| 错误 | 6 个码 | 9 个码、`retry_after_seconds` 必填 | 统一体，`retry_after_seconds` 可选（§2.7） |
| 反馈 | 旧站字段 | 多附件令牌、必带幂等键 | 旧站字段 + 可选幂等键 + 201（§4.3） |
| 法规接口 | 扁平 `Instrument` | Policy 系列 | Policy 系列 + 分维状态 + 影响 + 七主题（§3.7） |
| 金属价格 | 无接口 | `/metal-prices` | 移出首版（§3.9） |
| 署名与再分发 | 无结构化字段、全文权限不分渠道 | 无 | `attributions`、`syndicate_fulltext`（§2.9） |
| 缓存 | 允许 5 分钟浏览器缓存 | 不得依赖 TTL | 60 秒可测条款（§2.8） |
| 撤回代次 | 无 | `policy_epoch` 随每个响应与游标 | 内部 `suppression_epoch`，只在站点 `/version` 以不透明字符串返回，公开 API 不含（§2.2） |
| 全文再分发权限 | 无结构化字段、全文权限不分渠道 | 无 | 九项（新建信源一律允许，`owner_declared`）加预留的第十项 `syndicate_fulltext`，仍按 Q-47 默认关闭（§2.9） |
| AI 标识 | 文案含“已人工复核” | 无 | `ai_label` 两值加 `ai_metadata`，任何出口不出现“已复核”（§2.9） |
| 公网探针与发布标识 | 无 | 无 | 经限流的 `/api/v3/freshness`、发布标识响应头；`/healthz`、`/readyz` 不属公网契约（§2.13） |
| 精选、热点、条目评分（v2.1） | 公开页不显示数字分；热点默认 7 天 3 个来源（均为自设规则） | 无正式规则，保留入口并显示“暂未启用” | 沿用 AIHOT，切换前完成：`ItemCard.score`（两次评分平均值向下取整，无评分为 null）；`/hot` 机器形态只给名次；`featured/snapshot`、`featured/changes`（§3.2、§3.5） |
| 报告选材与出刊时间（v2.1） | 报告按价值组织；北京自然日 / 周 / 月，次日 08:00 后出刊 | 覆盖本期全部合格材料 | 沿用 AIHOT：从精选候选取材、同一事实去重、版面容量限制；日报 08:00（[前一日 08:00, 当日 08:00)，以出刊日为键）、周报周一 10:00、月报 1 日 10:30，跨界归入下一期候选池，不设补录（DEC-65，§3.6） |
