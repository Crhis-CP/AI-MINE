# 数据资产说明（`data/`）

> **先看结论**
> 1. **能直接导入新系统的数据**：原始信源表（320 个目标、321 条记录，Owner 的业务输入）和法域字典（36 个对象 + 中国 14 个省区）。其余是对照文件、历史子集和历史参考（`legacy-editorial/`，**不导入新系统**）。
> 2. **哪个是权威版**：信源表以 `source-targets-320.json` 为准（两个 CSV 是它的表格版）；法域以 `jurisdictions-36.json` 为准，`jurisdiction-scope.json`（范围底表）的 36 个对象与它的 tier、`news_scope`、`policy_scope` 必须逐项一致（已脚本核对）；`countries-18.json` 只是旧站资讯线的 18 国历史子集，与前两者中 `existing18` 层的 18 国相同。
> 3. **旧仓库的数据一概不导入，也不从旧仓库导出任何文件**（Owner 2026-10-01：“都不要了，重做”；裁决表 DEC-20、DEC-42）：本目录里来自旧仓库的内容只有两类——按字段蒸馏的信源表（320 个目标是 Owner 的原始信源表，是业务输入；其中 `old_*` 字段是旧项目的历史观察，只作经验参考）和旧离线编辑规则包的 5 个原文副本（`legacy-editorial/`，历史参考）。法规线研究成果、38 项许可审定、第一代官方注册表与候选、规则包漏带的 8 个文件、矿种字典与识别词来源，共 34 个旧仓库文件，**既不随包，也不登记导出指针**（v2.0 的 `legacy-export-pointers.json` 已删除）；新系统从空库起步，由新系统按信源表重新采集、研究与核验（第 1.2、6 节）。
> 4. **旧项目的状态都是历史**：所有 `old_*` 字段和“旧状态”是旧项目 **2026-09-13～15** 的记录，只作经验参考（排优先级、提示研究的第一步），**不代表新系统状态，不导入、不继承**；新系统的所有计数与状态从空库起算。
> 5. **数字口径**：本说明里的数量（320 个目标与 321 条记录、CSV 38 列与 29 列、带“非站点根路径”审查提示的 91 个目标、境外 67 个目标 = 15 个国家 + 9 个跨国/未限定、36 + 14 个法域等）都由数据文件直接统计，2026-10-01 核对一致；数据一改，必须同步改本说明。
>
> 来源：AI矿策 旧项目 `origin/main@65d3624` 的 `config/live/` 下的信源目录、接入进度、国家覆盖、公司参考，以及 v2 编辑规则离线包；B 包的 `jurisdiction-scope.json`；编制于 2026-09-29/30，信源部分于 2026-09-30 逐项在线核对后重建（v1.0（A 包）的信源数据在 v2.0 经过重建与修正，见 2.1）。这些旧文件只在编制时读取，不随包、不导入。
> 安全：不含密钥、口令、服务器 IP、账号或个人信息；文件中的网址均为公开网址。
> 使用规则见 `01-product/07-sources-and-coverage.md`（信源）、`03-data/01-domain-model.md`（实体）、`03-data/04-legacy-migration.md`（旧站数据处置：不迁移，全重做）。

---

## 1. 文件一览

### 1.1 随包文件（13 个：数据 6 个、规则包目录 6 个、本说明 1 个）

| 文件 | 内容 | 数量 | 导入到 |
|---|---|---|---|
| `source-targets-320.json` | **权威版**：原表 320 个目标（`targets` 层）与 321 条记录（`records` 层），另含旧项目留下的表外补充来源 8 与待定的范围升级 8（旧项目历史信息，只作经验参考，不导入）、v2.0 修正清单 | 320 + 321 + 8 + 8 | sources：原始信源表（ENT-06）；`old_*` 字段不导入为状态 |
| `source-targets-320.csv` | `targets` 层的表格版（便于人工查看）；多值字段用 `;` 连接 JSON 数组 | 320 行、38 列 | 与 JSON 相同，二选一导入 |
| `source-records-321.csv` | `records` 层的表格版（原表逐行事实，含 `observation_id`、超链接目标） | 321 行、29 列 | 与 JSON 的 `records` 层相同；不再与旧政策分支的映射对接 |
| `jurisdictions-36.json` | **法域字典（权威）**：36 个对象（33 国 + 欧盟/联合国/OECD）+ 中国 14 个省区，带 `news_scope` / `policy_scope` / `tier` | 36 + 14 | sources：覆盖范围字典 |
| `jurisdiction-scope.json` | B 包的范围底表（36 个对象）+ 三份 V2.0 方案哈希；v2.0 补了 `tier` 与两个标志 | 36 | 对照，与字典必须一致 |
| `countries-18.json` | A 包的 18 国覆盖文件，**历史子集**（旧站资讯线起步清单） | 18 | 历史对照，不再作导入字典 |
| `legacy-editorial/taxonomy.v1.json` | 九类编辑分类、预筛处置、来源角色、来源关系、内容类型、四轴不变量 | 9 类 | **历史参考，不导入新系统**：九类、来源角色、来源关系、内容类型可作枚举起点的参考（新系统以 `06-content-standards.md` 等本包文件为准）；**预筛处置的 `public_eligible` 语义不继承**（§4.2） |
| `legacy-editorial/reason-codes.v1.json` | 编辑原因码 | 72 个 | **历史参考，不导入新系统**：原因码的中文含义可参考用于推荐理由与评测；英文代码不上公开页（§4.3） |
| `legacy-editorial/review-gates.v1.json` | 九类二审硬门 | 9 类 | **历史参考，不导入新系统**：只作写作禁区、评测集和精选资格的参考，**不作发布前校验**（§4.2） |
| `legacy-editorial/annotation-manual.md` | 标注手册（Gold v1 校准版） | — | **历史参考，不导入新系统**：评测集建设的方法参考（`05-quality/05-evaluation-sets.md`） |
| `legacy-editorial/company-reference.v1.json` | 公司中文名与简介参考 | **只有 2 家** | **历史参考，不导入新系统**：实体别名词表的参考 |
| `legacy-editorial/README.md` | 规则包目录的阅读说明：历史参考、不继承的语义、旧规则包漏带的文件（不取回） | — | 阅读说明，不导入 |

`legacy-editorial/` 下的全部文件是**离线校准设计资产，标为“历史参考，不导入新系统”**（Owner 2026-10-01：全重做）：规则包状态 `OFFLINE_REPLAY`、策略文件状态 `OFFLINE_CALIBRATION`，旧项目从未把它们接入生产，也没有用真实样本校准。使用边界见 §4.2；旧规则包没有带全的文件**不取回**（§4.4）。

### 1.2 不导入的旧仓库数据（Owner 2026-10-01：全重做；不登记指针，不从旧仓库导出任何文件）

v2.0 曾为 34 个旧仓库文件登记导出指针（`legacy-export-pointers.json`，建仓时由 Agent 在线导出）；**v2.1 起整体删除**：新项目不导入旧站任何生产数据，不导入旧仓库的研究与审定快照，也不在建仓时从旧仓库取回任何文件（裁决表 DEC-20、DEC-42）。下表只说明“原先打算取回的东西，现在怎么办”：

| 旧仓库数据组 | 内容 | 新项目怎么办 |
|---|---|---|
| 法规分支研究成果 | 范围底表、法域与 321 条映射、114 条研究来源、三份分区研究、运行契约、研究摘要（`@policy`，草稿 PR #180） | 不导入；36 个法域的来源研究（POL-R01～R08）从空台账重做（07 第 9 节）；旧研究的事实边界只作经验参考 |
| 资讯线逐源许可审定 | 38 项配置、8 项范围升级、2 项草稿修复 | 不导入；所有信源按 Owner 声明许可建档（九项允许，`owner_declared`，07 第 3 节） |
| 第一代官方注册表与候选 | 31 个已核身份的官方来源、6 个采集画像、48 个候选，另有候选观察与处理台账各 321 条 | 不导入；候选信源由新系统的研究与“AI 检索新信源”重新发现，负责人确认后加入 |
| 原表目录与接入进度 | 本包第 2 节的数据由此在线核对后生成 | 已并入本包第 2 节（原始信源表是 Owner 的业务输入）；`old_*` 字段只作经验参考 |
| 旧离线编辑规则包漏带的 8 个文件 | 清单、6 个结构 schema、24 例金标夹具 | 不取回；评测集与金标由新项目按 AIHOT 的校准办法用 100–200 条矿业样本重做（`05-quality/05-evaluation-sets.md`） |
| 矿种字典与识别词表的来源 | 读者层显示名字典、18 个矿种的多语言识别词、矿业词与硬负例词 | 不导出；矿种字典与多语言识别词由新项目自建，审定见 Q-37（`08-open-questions.md`） |

本包里**没有**这些数据的任何副本，也不会新建 `minerals.v1.json`、`configured-sources-38.json`、`legacy-configured-sources-38.json` 之类的蒸馏副本。

---

## 2. 原始信源表：`source-targets-320.json` / `source-targets-320.csv` / `source-records-321.csv`

### 2.1 来源、口径与两层结构

> **v2.1 说明**：原始信源表是 Owner 的业务输入，直接导入新系统；表里旧项目留下的 `old_*` 字段、候选入口、表外补充来源 8 与待定的范围升级 8，是旧项目的历史观察，**只作经验参考，不导入为新系统的状态、配置或权限**（Owner 2026-10-01：全重做）。

- 原始材料：Owner 的《境内外网站收集汇总》工作簿，**321 条记录**（中国 253、境外 68）。旧项目把它固定为字节级目录（`source-intake-catalog.json`，SHA-256 `7859cdb2e6aa32eab31940e78ef3603d70b223df5e919e625e7ba3d23354f1be`，由工作簿 SHA-256 `7e30fe19fdbf55b870be1fab917fad396ff1c26be926a82ee264ea9b53e820d3` 导出），再与接入进度清单 `source-integration-progress.json`（2026-09-15 更新）合并成本文件。v2.0 已在线核对这两份旧文件的全部 321 条记录与 320 个目标。
- 321 条记录按规范化网址归并为 **320 个唯一目标**：只有 `S16-R054`（蒙古财务协调委员会）与 `S16-R062`（原表标为哈萨克斯坦国会）指向同一网址 `https://www.frc.mn/#/home`，合成一个目标并标身份冲突。
- 结构：中国 253（部委 17 + 14 个省区 236；山西 18、西藏 14、其余各 17）；境外 67 个目标（**15 个国家** + 9 个跨国/未限定；加中国即 Owner 原表的 16 国）。
- **两层**：`records`（321 行）是原表逐行事实，每行恰好属于一个目标，原始字段只读；`targets`（320 行）是按规范化网址归并的对账对象，带完整 64 位 `target_id` 与记录编号列表。JSON 是权威版，含两层；CSV 各一份：`source-targets-320.csv` 是 `targets` 层，`source-records-321.csv` 是 `records` 层。JSON 的数组字段在 CSV 里用半角 `;` 连接（一致性校验：CSV 单元格 = `';'.join(JSON 数组)`，v2.0 已核对一致）。
- JSON 另有 `schema_version`、`generated_from`、`semantics`、`v2_fixes`、`counts`、`sheet_codes` 说明字段，以及 `supplementary_sources_outside_workbook`（8）和 `pending_scope_upgrades`（8）两个列表（见 2.4、2.5）。

**v2.0 相对 v1.0 的修正**（逐条写在 JSON 的 `v2_fixes`）：

| 修正 | 内容 |
|---|---|
| `frc.mn` 多记录目标 | v1.0 把 `country` 写成“KZ;MN”、`institution` 写成“哈萨克斯坦国会网站;蒙古财务协调委员会网站”（字母序），与 `record_ids`“S16-R054;S16-R062”顺序相反，还丢了 S16-R062 的主题“综合或未明确”与批次 `A_基础信息修正`。现在所有对齐字段按记录顺序一一对应（MN 在前、KZ 在后），新增 `primary_country`（MN） |
| 编号 | `target_id` 恢复为旧目录完整 64 位（`target_` + SHA-256(规范化网址)），v1.0 的 16 位前缀另存为 `target_id_short16` 仅作对照；每条记录补回 `observation_id`（`obs_` 编号；v2.0 曾用它与旧政策分支的 321 条 `legacy_mappings` 对上，旧政策分支数据不导入后，它只作记录的稳定编号） |
| 补回的字段 | 超链接目标 `hyperlink_target_original`、原表序号与单元格位置、`normalization_notes`、重复指向 `url_duplicate_of`；目标层补回 `old_last_discovery_error_code`、候选入口类型（html / rss）、`old_last_evidence_at`、`old_body_completion_status`、`old_continuous_supply_status`、`old_source_id`（已配置目标的旧信源 ID，仅作历史对照，旧配置不导入）、`old_latest_state_20260913`（均为旧项目历史观察，只作经验参考） |
| 补协议说明 | 改正：17 条缺协议记录中，**16 条依据同单元格超链接补协议**（超链接均为 `http://`，联网未验证），**1 条（`S16-R031` minambiente.gov.co）无超链接、补 `https://` 作为待验证候选**；79 个 HTTP 目标里这 16 条的 http 来自表格超链接，不代表站点只支持明文 HTTP。v1.0 写反了依据关系 |
| 统计 | 非站点根路径的目标是 **91** 个（v1.0 写 83）；境外 67 个目标 = 15 个国家 + 9 个跨国/未限定（v1.0 写“16 国”） |

### 2.2 `targets` 层字段（JSON 数组字段在 CSV 里用 `;` 连接，顺序与 `record_ids` 一致）

> 下表里的 `old_*`、`candidate_entry_*`、`body_scope_note`、`unfinished_reason`、`next_action`、`permissions_*` 等字段是旧项目遗留的历史观察，**只作经验参考，不导入为新系统的状态、配置或权限**（见 2.1 说明）；其余字段（原表位置、网址、国家、机构、规范化网址、审查提示等）是原始信源表本身。

| 字段 | 含义 | 取值与注意 |
|---|---|---|
| `target_id` | 原表目标编号 = `target_` + 规范化网址 SHA-256（64 位十六进制，可由网址复算） | **不是新系统 ID**；新系统另生成 `tgt_` ID，此值保留为原表目标编号，用于对账 |
| `target_id_short16` | v1.0 的 16 位前缀 | 仅作对照 |
| `record_ids` | 原表记录编号 `S<表页>-R<行号>`；行号是工作簿原始行号（第 1 行为表头） | 多条按记录顺序；表页 S01 部委、S02 黑龙江、S03 吉林、S04 内蒙古、S05 山西、S06 河南、S07 安徽、S08 福建、S09 湖南、S10 贵州、S11 甘肃、S12 青海、S13 新疆、S14 西藏、S15 云南、S16 境外 |
| `observation_ids` | 观察编号（`obs_…`），与 `record_ids` 一一对应 | 记录的稳定编号；不再与旧政策分支 `legacy_mappings`、旧 `candidate-observations.json` 对接（旧数据不导入） |
| `primary_country` | 第一条记录的国家代码，用于按国家统计 | 跨国/未限定为空；`frc.mn` 目标为 `MN` |
| `country` / `country_name` | 各记录的 ISO 国家代码 / 中文国名，与 `record_ids` 对齐 | 跨国记录为空；`frc.mn` 目标为 `MN;KZ` / “蒙古;哈萨克斯坦”；`country_name` 与 `original_category` 一样是原表写法，逐字保留（如“刚果金”），读者页的国家显示名以法域字典 `name_zh` 为准（“刚果（金）”，DQ-07 已裁定） |
| `subnational` | 中国省区 | 部委与境外为空 |
| `workbook_sheet` / `original_category` | 原表页名 / 原表分类列 | 中国为省区名，境外为国家名 |
| `institution` | 原表机构名，逐字照录 | 可能含【】注释或前导空格（如“ 黑龙江省自然资源厅”），`records` 层另存去空格的 `institution_display`，原值不改 |
| `source_type` | 旧项目对原表来源类型的归类 | 13 种（按记录）；只作研究起点；机构类型以新系统研究为准（07 第 1.4 节） |
| `topic` | 主题 | 19 种组合，单个记录内多个值用**全角“；”**分隔 |
| `suggested_batch` | 旧项目建议批次（按记录） | `A_基础信息修正` 1、`B1_矿业能源法律核心` 50、`B2_政府配套政策` 247、`C_媒体与行业动态` 18、`D_许可及主体专项核实` 5 |
| `original_url` / `hyperlink_target_original` | 原表显示网址 / 同单元格超链接目标，逐字照录 | 可能缺协议、是 HTTP、带 `#`；永不改写 |
| `normalized_url` | 规范化网址（唯一） | 仅补协议、主机小写与空路径补斜杠；共 79 个 HTTP、2 个带 `#` 片段 |
| `old_configuration_status_20260915` | 旧仓库是否有对应配置 | `configured` 30 / `unconfigured` 290 |
| `old_source_id` | 已配置目标的旧信源 ID | 仅作历史对照（旧配置不导入）；未配置为空 |
| `old_current_entry_url` | 旧配置的当前采集入口 | 只有已配置目标才有；研究线索 |
| `old_fetch_method` | 旧采集方式 | `html` 28、`au_legislation` 1、`rss` 1、`unresolved` 290 |
| `old_discovery_status` | 旧发现状态（10 种，含义见 2.3） | 用于排优先级，不是结论 |
| `old_last_discovery_error_code` | 旧探测最近一次失败的原因码 | 如 `source_adapter_required`（98 个未配置的待重试目标）、`source_network_failure`（49）、`source_robots_unavailable`（11）、`source_robots_denied`（1，农业农村部）；07 第 5.2 节按它分列下一步 |
| `candidate_entry_urls` / `candidate_entry_kinds` | 旧项目首轮只读探测留下的候选入口及其类型 | `;` 分隔；共 639 个（html 636、rss 3），分布在 132 个目标上；可能含具体文章页 |
| `old_runtime_status` | 旧运行状态 | `enabled` 13（有只读回执证明当时启用）/ `runtime_unverified` 307；**不证明持续供稿** |
| `old_latest_state_20260913` | 2026-09-13 22:42（14:42Z）来源状态回执里该目标对应来源 ID 的状态 | `active` 20、`draft` 4、`none` 6（仅对 30 个已配置目标有值）；按来源 ID 统计，**未核配置身份**；与 8 个表外来源合计 active 28、draft 4 |
| `old_public_articles_observed_20260913` | 2026-09-13 旧公开站快照中观察到的该目标文章数（整数） | 合计 256，11 个目标大于 0；是快照计数，不是运行状态 |
| `old_last_evidence_at` / `old_body_completion_status` / `old_continuous_supply_status` | 旧清单中的最近证据时间 / 正文完成状态 / 持续供稿状态 | 只作参考；持续供稿核实全部为 0 |
| `body_scope_note` | 旧项目对正文取得与再利用范围的说明 | 权限研究线索，**不是权限结论** |
| `unfinished_reason` / `next_action` | 未完成原因 / 建议的下一步（中文） | 部分含旧实现术语，只作参考 |
| `identity_conflict` / `identity_conflict_detail` | 身份冲突 | 只有 `frc.mn` 目标为 `true`，并说明 S16-R062 的错配 |
| `review_reasons` | 审查提示（`;` 分隔） | 如“非站点根路径_需确认栏目适用性”（91）、“原显示网址缺协议…”（17）、“疑似同机构不同域名_待核实合并” |
| `permissions_fetch/model/public_reuse` | 旧的三项权限（抓取 / 模型 / 公开再利用） | 320 个全部是 `unverified/unverified/unverified`；**已被 Owner 2026-10-01 的许可声明取代，新系统不使用**：权限不挂在目标上，信源建档时九项全部“允许”（`owner_declared`，07 第 3 节） |

### 2.2a `records` 层字段（321 行）

| 字段 | 含义 |
|---|---|
| `record_id`、`sheet_code`、`workbook_sheet`、`original_row`、`original_serial`、`original_url_cell` | 原表位置：记录编号、表页代码与页名、原始行号、原表序号、网址所在单元格 |
| `category_inherited_from_cell` | 原表分类列是否继承自合并单元格（如 `B53`） |
| `original_category`、`country`、`country_name`、`subnational` | 原表分类、国家、省区 |
| `institution_original`、`institution_display` | 机构原名（逐字）/ 去前导空格后的显示名 |
| `source_type`、`topic`、`suggested_batch`、`batch_reason` | 旧项目的归类、主题、建议批次与理由 |
| `original_url`、`hyperlink_target_original`、`normalized_url`、`normalization_notes` | 显示网址、超链接目标、规范化网址、规范化说明（补协议依据、主机小写等） |
| `review_reasons`、`invalid_or_review_flags`、`url_duplicate_of` | 审查提示、旧标记、与哪条记录的网址重复（如 S16-R062 → S16-R054） |
| `same_publisher_group`、`publisher_group_basis` | 旧项目的同发布方分组与依据（身份未核实，只作线索） |
| `observation_id`、`target_id`、`reviewed_runtime_source_ids` | 旧观察编号、所属目标（64 位）、旧项目已映射的来源 ID（2 条记录有） |

### 2.3 旧发现状态的含义

旧发现状态只用来排研究优先级、提示研究的第一步，**不导入、不继承**（Owner 2026-10-01：全重做）：新系统里 320 个目标的初始状态一律是“待处理”（07 第 4.1 节）。

| 值 | 目标数 | 含义 | 新系统初始状态 | 研究的第一步（经验参考） |
|---|---:|---|---|---|
| `retry` | 195 | 此前访问或解析没有完成，需要重新研究 | 待处理 | 先识别平台族 |
| `discovered` | 43 | 找到候选入口，发布方或栏目身份未核实 | 待处理 | 从候选入口里选持续更新的栏目 |
| `access_failed` | 28 | 访问失败（网络、DNS、TLS 证书链、超时等） | 待处理 | 用新客户端有界复核一次，确认不可达后改“无法访问” |
| `adapter_required` | 26 | 能访问，但分页、动态页面或接口需要适配 | 待处理 | 先试已有平台族，不行再立开发任务（确认后改“需要适配”） |
| `native_acquisition_passed` | 10 | 旧项目的自有客户端取到过真实条目 | 待处理 | 批 0 优先研究 |
| `scope_review_required` | 9 | 需要审查使用范围（条款、版权声明） | 待处理 | 复核条款，记下异议线索；负责人决定是否收紧（07 BR-SRC-16） |
| `blocked` | 5 | 被挡住：跳转到其他主机待核实 3、访问被拒 1（美联社）、robots 禁止该路径 1（农业农村部） | 待处理 | 不绕过；寻找同一发布方的替代官方入口 |
| `native_adapter_verified_private` | 2 | 本机私有适配器验证通过，未上线 | 待处理 | 批 0 优先研究 |
| `actual_items_observed` | 1 | 观察到真实条目，未启用 | 待处理 | 批 0 优先研究 |
| `scope_restricted` | 1 | 有明确的使用限制（GhaLII 的 `ai-input=no`） | 待处理 | 记下异议线索；是否收紧由负责人决定 |

旧项目已配置的 30 个目标：**配置不导入**；它们在新系统同样从“待处理”起步，但作为 M2 首批基线（07 第 8.2 节批 0）优先研究——这些站点曾被抓通过，用来先验证新系统的采集链路。

### 2.4 `supplementary_sources_outside_workbook`：表外补充来源（仅 JSON）

旧项目曾另外配置并启用的 8 个来源，不对应原表任何记录（**旧项目历史信息，只作经验参考，不导入**）：International Mining、African Mining Market、North American Mining（媒体 RSS）；Ivanhoe Mines、Codelco、紫金矿业（企业官网）；美国联邦公报（官方接口）；Geoscience Australia（政府网页）。

| 字段 | 含义 |
|---|---|
| `source_id` | 旧信源 ID（`src_` + 旧规则哈希），仅作历史对照，不导入、不作新系统的 ID |
| `publisher` / `entry_url` / `method` / `adapter` / `interval_minutes` | 发布方、入口、采集方式（`rss`/`html`/`federal_register`）、适配器、采集间隔（分钟） |
| `processing_scope` / `full_text_configured` | 旧处理范围（`publisher_summary` 或 `licensed_text`）/ 是否配置了全文 |
| `body_scope_note` / `scope_evidence_urls` / `scope_reviewed_at` | 旧许可说明、证据链接、审定日期 |
| `configuration_status` / `runtime_status` | 旧配置状态 / 2026-09-12～13 只读回执中的启用状态 |
| `old_latest_state_20260913` / `old_public_articles_observed_20260913` / `old_runtime_evidence_observed_at` | 2026-09-13 22:42 状态回执（8 个均为 `active`）/ 公开快照文章数 / 启用身份回执时刻 |

注意：
- 这些来源**不导入**（旧站数据处置：不迁移，全重做，`03-data/04-legacy-migration.md`）：它们在新系统里是候选信源，由负责人确认加入（加入时一次确认，九项允许，证据 `owner_declared`，07 第 3 节）；本列表只是候选线索，**不计入 320 目标的分母和分子**（BR-SRC-27）。
- `processing_scope` 取自旧的“已审候选配置”，不一定是当时的生产状态：Geoscience Australia 在这里是 `licensed_text`，但 2026-09-13 的生产状态仍是 `publisher_summary`，升级待上线（见 2.5）。
- 逐源的许可说明、证据链接、可否送模型与公开全文、时区等完整记录在旧 `reviewed-initial-sources.json`（38 项），**不复制进本包，也不从旧仓库导出**（第 1.2 节）；新系统按 Owner 声明许可建档，不再逐源审定。

### 2.5 `pending_scope_upgrades`：旧项目未完成的升级（仅 JSON）

旧项目接入进度“下一批”（`next_batch`）中代码已就绪、但未完成线上资格验证的 8 项（旧项目历史信息，只作经验参考，不导入）：

- **Geoscience Australia 正文范围升级**：`publisher_summary` → `licensed_text`（CC BY 4.0，证据 `ga.gov.au/copyright`）；
- **7 个适配器与配置准入**：黑龙江、吉林、福建自然资源厅，新疆人社厅，西藏自然资源厅，福建住建厅，南非政府媒体声明。

字段：`source_id`、`publisher`、`change_type`、`status`（均为 `code_ready_runtime_qualification_pending`）、`current_scope` / `proposed_scope`、`sample_url`、`scope_note`、`scope_evidence_url`、`blockers`（未完成的条件：专用正文选择器与清洗回归、保留 Owner 设置的同源升级、生产环境全文翻译资格、不限于 30 天窗口的存量正文回填、真实文章身份/日期/范围核实、中文阅读资格、启用后至少两批产出）。

用法：作为“批 0 首批基线”（07 第 8.2 节）的经验参考；`blockers` 说明旧项目缺了哪些证据，新系统要重新拿到这些证据，不能直接视为已完成；其中“正文范围升级”类条目在新系统里不再有审定环节（所有信源建档即九项允许）。

**与另一份清单不同**：旧 `config/live/source-scope-upgrades.json` 另有 8 项“范围升级前后对照”（应急管理部、澳大利亚立法、Geoscience Australia、贵州、黑龙江、吉林、福建、美国联邦公报，每项带 `from_permissions` / `to_permissions`、许可说明与证据链接）。两份清单互相重叠但不是同一份；后者不随包、不从旧仓库导出（第 1.2 节）。

### 2.6 如何导入新系统

1. **校验**（任何一项不符即中止，不做部分导入）：目标 320 个、记录 321 条；64 位 `target_id`、`normalized_url`、记录编号、`observation_id` 各自唯一；每条记录恰好属于一个目标；`records` 层与 `targets` 层一致；CSV 与 JSON 一致。
2. **建目标**：每个目标生成新的 `tgt_` ID；`target_id` 保留为原表目标编号（规范化网址的哈希），只用于对账。**每条记录单独保存**表页、行号、原网址、超链接目标、国家、省区、机构原名；多记录目标（`frc.mn`）的两条记录分别保留各自的国家（MN、KZ）与机构名，目标整体标“身份冲突”，KZ 那条记为“无效或错配”的候选并等待核实（`jurisdictions-36.json` 的 `known_misidentifications` 也登记了这一条）；统计一律用 `primary_country`，不让 KZ 那条进入哈萨克斯坦的任何计数（07 BR-SRC-33）。
3. **初始状态与权限**：所有目标的初始状态一律是“待处理”（2.3）；**权限不挂在目标上**——由目标产生的信源在加入时由负责人一次确认，九项全部“允许”（证据 `owner_declared`，07 第 3.4 节）。
4. **旧观察可选另存、只读**：所有 `old_*` 字段、候选入口、旧说明、旧原因与下一步，可以放在带日期的“旧项目观察”只读记录里（也可以不导入），不写进新系统的状态字段，只在目标详情中作为研究线索展示。
5. **不从目标自动建信源**：所有信源由信源研究产生（07 第 4 节），加入时由负责人一次确认许可；旧项目已配置的来源**不导入**——`old_source_id`、记录编号与入口网址只用来把它们当作优先研究的线索（07 第 8.2 节批 0）。
6. **幂等与预演**：导入可重复执行，不产生重复数据；已导入目标的原始字段有冲突时拒绝覆盖并报告；先在临时库预演，输出对账报告（条数、失败项与原因）。

### 2.7 注意事项

- CSV 为 UTF-8 编码、没有 BOM、逗号分隔；用 Excel 直接双击打开时中文可能乱码，请用“导入 UTF-8 文本”方式打开，或直接使用 JSON。
- 多值字段：JSON 里是数组，CSV 里用半角 `;` 连接（`topic` 内部的多个值仍是全角 `；`，因为它是单个记录的取值）。对齐字段的顺序与 `record_ids` 一致，不再按字母序拼接。
- `normalized_url` 只用于判重，不保证能访问；79 个 HTTP 网址不要自动改成 HTTPS 写回（07 BR-SRC-02）；其中 16 条的 `http://` 来自表格超链接，1 条 `https://`（S16-R031）是无依据的待验证候选。
- 候选入口里有具体文章页（网址带日期），不能当作持续更新的栏目入口。
- 已知需要核实的记录：甘肃林草局网址指向新华网甘肃频道（`gs.news.cn`）；`miming.com` 与 `mining.com` 拼写不一致；哥伦比亚 minminas 与 minenergia 的关系；内蒙古金融监管局网址为 `jrj.nmg.gov.cn`，主体对应关系待核；另有 24 条记录的超链接目标与显示网址写法不同（其中 16 条只是缺协议），只用显示网址分类。
- 数字口径：`old_runtime_status = enabled` 的 13 个目标加上表外 8 个，就是旧项目“核实启用 21”；按来源 ID 启用且解析通过是 28（20 + 8）、草稿 4、正式版本内配置 32、有公开内容的来源 25（2026-09-15 回读）、持续供稿核实 0。各口径的日期与依据以 07 第 0.2 节的口径表为准，本文件不再另列。

---

## 3. 法域字典：`jurisdictions-36.json`（另见 `jurisdiction-scope.json`、`countries-18.json`）

### 3.1 三个文件的关系

| 文件 | 角色 | 说明 |
|---|---|---|
| `jurisdictions-36.json` | **运行用字典（权威）** | 36 个对象（33 国 + 欧盟/联合国/OECD）+ 中国 14 个省区下级法域；并入 A 的 `scope_basis` 两类、`qualification_requirements`、`known_misidentifications`，B 的范围依据，英文名，原表记录与目标数，跨国/未限定规则 |
| `jurisdiction-scope.json` | B 包的范围底表 | 36 个对象与旧分支 `config/policy/scope.json@6d37df8` 逐项一致（已脚本核对；这只是编制时的核对来源，旧文件不导入）；含三份 2026-09-24 V2.0 方案的文件名与 SHA-256；v2.0 补了 `tier` / `news_scope` / `policy_scope`；两个文件的 tier 与标志必须一致 |
| `countries-18.json` | A 包的 18 国覆盖文件，**历史子集** | 旧站资讯线起步清单；不再作导入字典，仅保留原始记录供对照；显示名已统一为“刚果（金）” |

范围依据：旧ADR-0037:5,16-19@policy（Owner 2026-09-26 批准，取代“18 国范围上限”）、裁决表 DEC-03。**数量不是上限**（`country_count_is_cap=false`），新增法域只能由负责人操作（07 BR-SRC-03）。

### 3.2 `jurisdictions-36.json` 字段

| 字段 | 含义 | 口径 |
|---|---|---|
| `id` | 法域代码 | 国家用 ISO 3166-1 alpha-2；省区用 ISO 3166-2（如 `CN-GZ`）；组织用保留代码 `EU`、`UN`、`OECD` |
| `kind` / `parent` | `country` / `organization` / `subdivision`；省区的 `parent` 为 `CN` | 组织不计入国家数 |
| `name_zh` / `name_en` | 中英文名 | 国家显示名统一，如“刚果（金）” |
| `tier` | `existing18`（18）/ `country_content`（10）/ `background`（5）/ `organization`（3）/ `subdivision`（14） | 背景层 = 英国、伊朗、瑞士、玻利维亚、马里（随 Q-09 答复沿用的默认做法，Owner 可改；DEC-03） |
| `news_scope` | 资讯线范围 | 18 国与 14 个省区为 true；**Owner 2026-10-01 已定（Q-09 已答复）**：资讯线 18 国起步、按实测逐步扩，不自动随法规线扩到 33 国 |
| `policy_scope` | 法规线范围 | 36 个对象全部为 true（阻断不移出分母）；省区为 false，其地方来源按发布职责纳入（BR-POL-25） |
| `policy_first_batch_required` | 首批取得/内容/持续运行验收是否必达 | 只有背景层为 false；研究（POL-R01～R07）分母仍含全部 36 个 |
| `scope_basis` / `news_scope_basis` | B 包的范围依据原文 / A 包的资讯线依据（`owner_original_country_scope`、`owner_additional_approved_country_scope`，仅 18 国） | 智利、加拿大原表无记录 |
| `workbook_records` / `workbook_targets` | 原表记录数 / 目标数（目标按 `primary_country` 计） | 蒙古 2 个目标（含 `frc.mn`）、哈萨克斯坦 5 个目标 + 1 条错标记录；合计 321 / 320 |
| `policy_local_sources` | 下级法域的法规线口径 | `by_publication_duty`：有独立发布权、且中央或正式汇编来源没有完整收录时才纳入 |
| 顶层 `tier_definitions`、`scope_flags`、`rules` | 三层定义、标志含义、字典规则 | — |
| 顶层 `qualification_requirements` | 5 步资格要求：核对身份与别名 → 当前服务器真实取得文章身份与日期 → 核实材料范围与处理依据（许可依据按 `owner_declared`） → 真实中文处理与事实核查 → 验证持续自动公开与来源隔离（费用按信源记账，不设月度金额上限） | 仍然适用，可作为每个来源的资格核对清单（v2.1 去掉了“在月度预算内”） |
| 顶层 `minimum_initial_publishers_by_type` | 首批烟测门的历史门槛：媒体 2、矿企 2、政府 2（合计 6 个独立发布方） | 旧文档记录 Owner 当时明确“六个合格独立发布方只是首批最低门槛，不能取代后续扩展”；与 72 小时 10 条 / 3 发布方 / 两批自动公开一起构成第一道验收门（07 第 8.4 节，DEC-61） |
| 顶层 `known_misidentifications` | 已知错配：原表境外第 62 行（`S16-R062`，`obs_e70f256b505d8c3ddafe3d3d8e`）的哈萨克斯坦条目指向蒙古 `frc.mn` | 保留原记录，不计入哈萨克斯坦 |
| 顶层 `unqualified_bucket` | 跨国/未限定：原表 `country` 为空的 9 条记录 | 独立取值，不计入任何国家的分子与分母，不按总部或域名推断国家（07 BR-SRC-33） |

### 3.3 分母口径（研究、取得、内容、运行分别计）

| 层 | 对象数 | POL-R01～R07 研究分母 | 取得 / 内容 / 持续运行首批验收 |
|---|---:|---|---|
| `existing18` | 18 | 是 | 必达 |
| `country_content` | 10 | 是 | 必达 |
| `organization` | 3 | 是 | 必达 |
| `background` | 5 | 是 | 排在其余 28 国和 3 个组织之后（随 Q-09 答复沿用的默认做法，Owner 可改） |
| `subdivision` | 14 | 否（资讯线按原表 236 个目标接入） | 不适用 |

### 3.4 导入

建立法域字典（代码、中文名、英文名、层级、范围标志、依据、加入人与时间）；各法域的覆盖情况一律由真实数据计算（07 第 4.7 节口径表），**不使用** `countries-18.json` 里的 `old_candidate_count`（跨国媒体在多个国家重复计数，各国相加不等于独立发布方数，也不是启用数）。新增法域只能由负责人操作并写审计（BR-SRC-03）。

---

## 4. `legacy-editorial/`：旧项目离线编辑规则包（历史参考，不导入新系统）

### 4.1 版本与状态

来源：旧仓库 main = 65d3624 的 `config/v2/editorial/` 离线编辑规则包。它只在离线规范、人工标注和确定性回放中使用过，**从未上线，也没有用真实样本校准**。新项目**不导入**它（Owner 2026-10-01：全重做）：精选与内容加工规则以 AIHOT 的矿业化改造为准（DEC-10、DEC-64），九类等定义以本包 `06-content-standards.md` 等文件为准，任何规则进入生产前必须经评测（`05-quality/05-evaluation-sets.md`）；这个规则包只作历史参考，可以读，不得作为运行配置或准入门加载。

| 项 | 取值 | 依据（@main） |
|---|---|---|
| 规则包 | `mining-editorial-v2-gold-v1-rc1` | `config/v2/editorial/ruleset-manifest.v1.json:2` |
| 规则包清单的版本与状态 | 版本 2.0.0-rc1；状态 `OFFLINE_REPLAY`（只做离线金标回放；`external_model_use=DISABLED`；`production_connected=false`；`approved_at`、`activated_at` 均为空） | 同上 :3-4,17-19,37-38 |
| 策略文件（taxonomy、reason-codes、review-gates） | 版本 1.0.0-rc1；状态 `OFFLINE_CALIBRATION` | 各文件的头字段 |
| 金标集 | `gold-v1-calibration` 0.1.0；状态 `CALIBRATION_NOT_SCORED`（**校准集，不计成绩**）；24 例，全部 `SELF_AUTHORED`（项目自写合成短事实，无版权障碍） | `tests/fixtures/v2/editorial/gold-v1.json:1-7`；清单 :15-16 |

### 4.2 使用边界：历史参考，不作为新项目的准入门

旧规则包里有几处语义与 Owner 2026-09-08 的宽收录、“不进人工队列”相反，新系统**不继承**：

| 旧规则包的语义 | 新系统怎么处理 | 依据 |
|---|---|---|
| `taxonomy.v1.json` 预筛处置里 `REFERENCE_ROUTE`、`VERIFY_HOLD` 的 `public_eligible=false`（参考类不公开、存疑进私有核验队列）；`EVENT_REVIEW`“不自动发布” | **不继承**。新系统的预筛处置以 AI-01 的“收录 / 拒绝 / 材料不足”为准；矿业相关的报告、数据、观点材料只要含具体矿业事项，就进入全部动态 | 旧ADR-0033:15,18@main；`docs/designs/mining-product-overhaul.md:89@main`；线上 `relevance.py:65-90@main` 已重写这三处定义（见下表） |
| `review-gates.v1.json` 的“二审硬门”（BLOCK / HOLD） | **只用于写作禁区（`06-content-standards.md` DR-57～DR-68）、评测集和精选资格**；不拦截真实矿业材料进入全部动态，不作为发布前校验 | B:evidence/legacy-product-sources.md L05、§3 |
| 五分类、二审、旧阈值（55、75、65/55/70） | 不是全动态发布硬门；宽收录，低重要性不拒绝；**旧阈值（55、75、65/55/70）与旧公式作废，只作历史记录**——Owner 2026-10-01 已定精选与热点沿用 AIHOT 并矿业化：两次评分之和 ≥ 2 × 门槛（T1 60、T1_5 65、T2 76 为起点，须用矿业样本校准）；矿业版评分标准是草案，生效前须 Owner 审阅确认（`02-rules/03-ai-capabilities.md` AI-03、BR-SEL-09） | 同上；旧ADR-0036:13,30@main；裁决表 DEC-10 |

线上（旧仓库 main）**另有放宽覆盖**，离线包里没有，两包也没带；它们是 AI-01 预筛提示的示例来源（`services/live_pipeline/relevance.py:31-90@main`）：

| 线上覆盖 | 线上的定义 | 与离线包的差异 |
|---|---|---|
| `company_project` | 具名矿业企业、矿山、冶炼加工资产或项目的可核实具体公告、经营事项和变化；纳入：项目审批、建设、投产、扩产、停产和复产，以及具名矿企普通经营公告和具体项目更新预告（不要求已形成重大成果） | 放宽：普通公告与预告照收 |
| `exploration_resource` | 矿产勘查、钻探、资源储量、技术研究的具体披露及具名项目披露预告；纳入：钻探结果、勘探目标、资源量和储量披露，具体勘探项目的更新或投资者说明会预告（必须保持未来时态，不写成已取得成果） | 放宽 |
| `esg_community_labor` | 具名矿业主体的环境、社区、劳工、治理事项和可核实的相关公司公告；纳入：社区、工会、企业和机关的具体主张、协议、争议及治理公告，具名矿企的具体环保或治理奖项公告（获奖事实不能推定环境实绩或项目影响） | 放宽；与下面的准入边界相关 |
| 预筛 `REFERENCE_ROUTE` | 纯导航、目录、空日历或无具体矿业对象及事项的背景索引不进入资讯；具名矿企公告、具体项目更新或说明会预告不因属预告而排除；报告或数据若含可核实的具体矿业事项，不能仅凭内容形式排除 | 重写：离线版是“报告、数据点、背景、解释、日历或观点一律不进事件流” |
| 预筛 `VERIFY_HOLD` | 主体、来源身份、处理许可或具体事实证据不足时保留私有，不能补写事实 | 收窄；不是人工核验队列 |
| 预筛 `DROP` | 明确非矿业、垃圾、仿冒、无具体对象事项的泛宣传、非矿业同形词或禁止材料，停止处理 | 近似 |

准入边界（裁决表 DEC-12）：纯一般获奖、参会、空预告和泛宣传不因发布方身份准入（旧ADR-0036:13@main）；含具体项目或经营信息的照收。油气、下游是否算矿业仍是可改的默认项（线上默认“纯油气事项且没有固体矿业对象先保留私有”，`relevance.py:99@main`，即 AIQ-02）。

### 4.3 包内五个文件怎么用

全部是旧仓库原文的**逐字副本**（SHA-256 与旧仓库清单 `ruleset-manifest.v1.json` 的记录一致；`company-reference.v1.json` 来自 `config/live/`），不修改。它们是 A 包 v1.0 随包带入的副本，v2.0 沿用；v2.1 起标为“历史参考，不导入新系统”（DEC-42，Owner 2026-10-01），不再新增旧仓库副本，规则包漏带的 8 个文件也不取回（4.4）。下表“怎么用”描述的是**参考方式**：这些文件不作为运行配置加载，新系统的分类、原因与推荐理由写法以本包 `06-content-standards.md` 与 AIHOT 矿业化后的提示词为准。

| 文件 | 内容 | 怎么用 | SHA-256（git blob 前 8 位） |
|---|---|---|---|
| `taxonomy.v1.json` | 九类编辑分类（代码、中文名、别名、定义、纳入与排除示例、二审引用）；预筛五种处置（`EVENT_REVIEW`、`REFERENCE_ROUTE`、`CLUSTER_ATTACH`、`VERIFY_HOLD`、`DROP`）；七种来源角色；九种来源关系（与术语表的事件成员关系一致）；十一种内容类型；四轴不变量（材料价值、事件重要性、证据、热度互不推导，不允许综合总分，精选是独立决定） | 九类分类对应术语表第 3 节，显示名见 `06-content-standards.md` DR-100；来源角色、来源关系、内容类型、四轴不变量作枚举起点；预筛处置只取定义文字，`public_eligible` 与处置语义不继承（§4.2） | `f74cacf26256c108c6a036617c038317ad0cd6a95ebc7fe0dae0ea7463a30447`（eb231bc5） |
| `reason-codes.v1.json` | 72 个原因码，分 10 个范围（二审 22、事件重要性 12、精选 8、预筛 7、证据 6、材料价值 5、来源关系 4、更正 3、热度 3、权限 2）；每个码有严重度、中文名、定义、允许出现的位置、能否公开（可公开 46、不可公开 26） | `public_exposable` 为真的码，**其中文名称或据此写成的中文说明**可以出现在公开的推荐理由或限制说明中；**任何码的英文代码都不出现在公开页面**（`06-content-standards.md` DR-80） | `ab078d1f5be3dcea08d69f4aa0c2ae38eb16bd3d27b5556de015a4aeb850be47`（faf4cda6） |
| `review-gates.v1.json` | 九类二审硬门：每类的必备事实、受控用词、硬门及触发的原因码（例如政策监管必须区分草案、征求意见、通过、刊宪、生效与执法） | **只作写作禁区（DR-57～DR-68）、评测集与精选资格，不拦截全部动态，不作发布前校验**（§4.2）；与 BR-ENR-12 一起使用 | `f35c6cb903817f8d7845af49bbcaace0f4031c41d1deb32b452b545026c22332`（ab5de4ee） |
| `annotation-manual.md` | Gold v1 标注手册：标注单位与顺序、五种预筛、九类主分类原则、四轴定义、九类硬门、推荐理由要求、转载/更新/更正/跨语言规则、双人标注与仲裁、24 → 240 → 2400 例的扩展计划、回放与变更治理 | 建设评测集的方法依据；是 md 文本，随阅读版收录（合订本由脚本生成，不手工维护） | `54679b4a81e6b3a5b4a6f3712eb46be790e45326bd8b6907ae6ce8887512b190`（31e080d1） |
| `company-reference.v1.json` | 公司中文名与一句话简介，2026-09-08 审定 | 实体别名词表的种子；**只有 2 家公司**（KGHM 波兰铜业集团、BHP 必和必拓），用途是核对公司中文名与简介，**不是新闻来源**，不计入信源数，也不能作为原稿事实依据（`06-content-standards.md` DR-40～DR-42） | `4abaf38d6a99fa561b6e394a0d47ade6ec40277dfe118cbca8b379d9eb9f9678`（78694142） |

### 4.4 旧规则包漏带的文件：不取回

旧仓库 `config/v2/editorial/` 共 11 个文件，另有夹具 `tests/fixtures/v2/editorial/gold-v1.json`；本包只带了其中 4 个（taxonomy、reason-codes、review-gates、annotation-manual，外加来自 `config/live/` 的 company-reference）。另外 8 个文件——规则包清单及其 schema、金标案例 / 分类 / 原因码 / 二审硬门 4 个结构 schema、推荐理由合同 schema、24 例金标夹具——**没有带，也不取回**（Owner 2026-10-01：不从旧仓库导出任何文件；v2.0 的取回路径与 SHA-256 清单已删除）。

- 手册中依赖这些结构的章节只作背景理解。
- 新项目的评测集与金标按 AIHOT 的校准办法重做：准备 100–200 条矿业样本（开发集与留出集，难例为主），由 Owner 标注，用 AIHOT 的 `scripts/eval-selection.ts` 跑准确率、查准率、查全率与门槛扫描（`05-quality/05-evaluation-sets.md`）。
- 旧“推荐理由合同”（`recommendation-reason.schema.json`）的要点——`what_changed` / `why_it_matters` / `status_clause` 各绑定主张、`caveats` ≤5、热度单列且 `not_evidence` 恒为真——体现在 `06-content-standards.md` DR-23、DR-24，新系统以后者为准。
- 决定类型里的“快讯（`QUICK_ALERT`）”在两包产品功能中都没有对应，列为**未采用的旧设计**。

### 4.5 注意

- 手册（历史参考）里的数据边界只作参考：它要求评测样本只能是项目自写的合成短事实或逐项确认允许保存的短事实、不得把第三方全文放进评测集或仓库、示例域名统一用 `example.invalid`；新项目的评测样本边界以 `05-quality/05-evaluation-sets.md` 为准。
- 手册里“第二波 13/15/16”是旧项目的任务编号，可忽略。
- 用于离线回放的规则不能证明任何真实来源拥有相同权限（夹具能力不等于来源权限）。

---

## 5. 维护规则

- 本目录是交接包 v2.1 的**冻结基线**（v2.1 按 Owner 2026-10-01 答复更新了说明与数据文件里的措辞）：导入后以新系统数据库为运行事实，本目录文件不再修改。
- 目标、信源、法域的后续变更在最小私有页面完成并写审计；需要仓库存档时，从新系统导出确定性快照（07 BR-SRC-28），不回写本目录。
- Owner 若提供新版信源工作簿，作为新的导入批次处理，保留本批的记录编号与对账关系，不覆盖旧记录（07 BR-SRC-01）。
- `legacy-editorial/` 的 JSON 文件是旧仓库原文的逐字副本，不修改；它们是历史参考，**不进入新项目、不按规则包版本管理**。合订本（阅读用）由脚本生成、不手工维护；`annotation-manual.md` 纳入阅读版，“分册 → 合订”的一致性由校验器检查。

---

## 6. 旧仓库数据一概不导入（Owner 2026-10-01：全重做）

### 6.1 决定与依据（裁决表 DEC-20、DEC-21、DEC-42）

- Owner 2026-10-01 原话：“都不要了，重做。”“也不要这些，我的意思是全重做。”——**不迁移旧站任何生产数据**（已公开的文章与译文、事件、报告、下架与人工修订记录、读者反馈、费用账本、信源配置与检查点、账号、产品更新日志），**不导入旧仓库法规分支的研究数据**，也**不从旧仓库导出任何文件**。新站从空库开始，由新系统按信源表重新采集、处理、公开；历史内容靠新系统自己的回填窗口取得（资讯线按回填规则，法规线按现行有效文本）。
- v2.0 的 `data/legacy-export-pointers.json`（34 个旧仓库文件的导出指针）、路线图任务 T-0012（建仓时按指针在线导出旧仓库数据资产）以及一切“建仓时从旧仓库导出 / 取回”的步骤，**已删除**；本节原有的逐文件指针表（P、R、O、T、E、M 六组）一并删除。
- **保留的是需求输入，不是旧数据**：包内随带的 320 个信源目标（Owner 的原始信源表）、法域字典、分类与写作规则等，是新项目的业务输入；`appendix/A-legacy-evidence-index.md` 只说明“某条规则出自哪里”，不构成数据导入；`legacy-editorial/` 下的旧离线规则包文件是历史参考，不导入新系统。
- **旧链接、旧 RSS、旧接口：新站不做任何兼容**（Owner 2026-10-01：“旧文章链接也全都不要，相当于从 0 开始做文章内容”，DEC-21）：没有旧链接对照表、301 映射、说明页或旧接口适配期；访问新站不存在的地址（含旧站的文章、栏目、RSS 与旧接口地址）一律走新站通用的“页面不存在”（404，带首页与搜索入口）；说明见 `03-data/04-legacy-migration.md`（旧站数据处置：不迁移，全重做）。

### 6.2 不导入的数据组

六组旧仓库数据与新项目的做法，见第 1.2 节的对照表。补充两点：

- 旧项目的研究与审定结果只在“经验参考”的意义上出现在本包的文字里（`07-sources-and-coverage.md` 第 9.6 节的制度与接口差异、第 3.2 节的收紧示例），其中每个事实在新系统里都要重新取证后才能成为结论；
- 旧文件之间的数字不一致（例如旧三份研究文件的用途键与状态词不统一，旧 `source-integration-progress.json` 的 `mapping_correction_note` 与 `summary` 对 38 项的拆分不同，以 `summary` 的 38 = 30 + 8 为准）不再需要归一或对账——这些文件不导入。
