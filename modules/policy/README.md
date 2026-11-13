# 法规阅读扩展

module声明既有法规列表、正文、历史版本、政策脉络及报告页面，保留全部地址和route ID；web提供原位置的桌面/手机入口及按页加载的法规收藏列表。公开页面只经HTTP读取现有内容，保留SSR首批正文、修订/撤回核验和部分完整性提示。

法规列表标题下展示更新说明并链接更新日志，桌面与手机共用：默认是已确认的暂停更新说明；运营方打开下述 `POLICY_PILOT_ENABLED` 后，同一处改为“试点范围更新中”（由 `/api/site/policies/scope` 的 `updates` 决定，不按最近活动猜测）。

## 重启：存档、结构化与逐条对照（DEC-78补充·五项决定 5）

Owner 解除了 DEC-71 的暂停，先做不调用模型的部分（`docs/design/policy-restart-202611/README.md` 第 4、6 节）。解读不设调用上限、靠设计降本（决定台账“正文共享前缀、非高峰与模型选择”）；模型步骤由 `POLICY_MODEL_STAGES_ENABLED` 控制，默认关。

- **两个开关**（`backend/pilot.ts`，每次读取环境变量，只认精确的 `true`）：
  - `POLICY_PILOT_ENABLED=true`：恢复存档（目录扫描 `policy.sources.schedule`、`policy.acquire` 取原件）和结构化（提取正文、切分条款、投影逐条对照）。它叠加在 `COLLECT_ENABLED`、`COLLECT_POLICY_ENABLED` 和后台运行控制之上，不取代它们。法规列表说明随之改为“试点范围更新中”。
  - `POLICY_MODEL_STAGES_ENABLED=true`：法规线全部模型用途（`policy_fulltext`、`policy_vision`、`policy_interpret`、`policy_verify`、`policy_group`）的前提。未设置时，sweep 不排全文、视觉、解读三个阶段；已排队的这类任务执行时改回等待，不购买结果；`provider.ts` 网关对任何法规用途直接拒绝。单独的 `MODEL_CALLS_ENABLED` 不再能启动法规模型阶段。
- **Codex 恢复存档与结构化的步骤**（正式环境）：
  1. 部署包含两份新迁移的版本（`policy/202611051000_policy_provisions.sql`、`publication/202611051010_policy_revision_provisions.sql`，只增表）。
  2. 在 api 与 worker 两个进程的环境里设置 `POLICY_PILOT_ENABLED=true` 和 `POLICY_MODEL_STAGES_ENABLED=true`（Owner 2026-11-05：法规解读不设调用上限，靠设计降本，模型步骤只在非高峰运行，见下文“降本设计”）；不要设置 `POLICY_VISION_ENABLED`；确认 `COLLECT_ENABLED`、`COLLECT_POLICY_ENABLED` 不是 `false`；重启两个进程。
  3. 在后台“运行开关”里恢复法规线的负责人暂停，范围选“采集和新的模型处理”（DEC-71 发布时由 `industry/release-controls.json` 的 `policy-pause-20261015` 写入；该决定按编号只执行一次，以后发布不会重新暂停）。处理开关恢复后，存档、结构化和公开投影随时运行；翻译、解读、复核只在 DeepSeek 非高峰时段发出，高峰时取到的任务排到下一个非高峰时段。
  4. 在 worker 环境回填已有修订：先 `node scripts/policy-provisions-backfill.ts`（只统计，不写入），核对输出后执行 `node scripts/policy-provisions-backfill.ts --apply`。脚本只用已缓存的提取结果，不取页、不调模型、不改公开版本；重复执行不会重复写入。
  5. 回退：只停模型步骤时去掉 `POLICY_MODEL_STAGES_ENABLED` 并重启；全部停止时再去掉 `POLICY_PILOT_ENABLED`，存档与目录扫描停止，说明恢复为暂停文案；已存条款和对照保留。
- **结构化**：`domain/provisions.ts` 是纯函数（中文第X条/之一与编章节、西语 Artículo/Art. N°/bis/序数词/único 与 Título/Capítulo/Sección、英文 Article/Section N 与 Part/Chapter，附件/ANEXO/Annex 另起编号空间；以引号开头的修改文本和小写引用不算新条款）。对齐先按全文相同的条款做锚点（LCS），其余按条号与文字相似度单调配对，分为新增、修改、删除、未变；修改的条款给出中文逐字、拉丁文字逐词的差异（Myers 差异算法，再做语义合并）。`domain/provision-store.ts` 在 `policy.acquire` 取得原件后、公开前，把当前修订的条款按配方 `provisions-1` 存进 `policy.revision_structures` / `policy.revision_provisions`；扫描件没有文字层时记为 `needs_manual`，不送视觉模型。工作流在模型阶段关闭时停在 `acquire / structured`，按来源复查周期继续存档。
- **公开与读取**：`publication/policy-provisions-project.ts` 只在来源允许公开原文全文时，把条款投影到 `publication.policy_provision_sets` / `publication.policy_revision_provisions`（按原生修订）。`compare.ts` 提供 `GET /api/site/policies/{id}/compare?from=&to=`（`from`/`to` 为版本记录里的公开修订 ID，省略时比较当前版本与上一份不同的同语言版本），读取时逐次核对公开资格和原文阅读许可，结果在进程内按两边条款哈希缓存，不落库、不调模型、不写库。网页在法规页加“逐条对照”一节（`web/features/PolicyCompare.tsx`），版本记录页的历史版本带“与当前版本逐条对照”链接。
- 生命周期事件沿用现有 `dates` 与 `legal_state`（公布、施行、截止、废止各带原文证据和已发生/计划），本次不新增 `lifecycle_event` 表；新来源适配器（中国 5 个机关、阿根廷公报与三省）由 Codex 按设计第 6 节第 2、3 步接入。

## 收录门槛：只收正式公布的法律文书，阿根廷先行（TASK-0576，DEC-78补充 2026-11-07）

- **来源**：`industry/policy-sources.json` 每条都写 `publisher_kind`（official_gazette、legislature、government、ministry、regulator、court、official_law_database），`industry/policy-sources.ts` 加载时拒绝缺失或其他值。RU-002 的采集入口是私营法律数据库，改为 `reference_only`、不采集。新闻来源（`industry/sources.json`）与法规来源编号、入口互不重叠，法规来源由种子写进 policy 线（测试锁定）。
- **法律文书判定**（`backend/domain/instrument-gate.ts`，纯函数，不调用模型；词表 `industry/policy-instruments.json`）：`classifyInstrument({title, number, issuer, excerpt, documentType, language})` → `kind`、`final`、`mining`、`change`（amendment/repeal）、`reason`、`publishable`。依次判断：未定稿或预告（proyecto de ley、consulta/audiencia pública、首条为 Convócase…、征求意见、草案、拟、即将、Proposed rule、Bill）→ 公告启事（edicto、licitación、sociedad、批复、名单…）→ 文书种类（来源登记的类型、标题、文号、像文书的正文开头，取最先出现、最具体的名称）→ 人事与个案（Desígnase、首条“Otórgase a la empresa…”、任免、表彰、行政许可决定）→ 矿业相关（矿业机关：标题、发布机关或签署句“EL SECRETARIO DE MINERÍA RESUELVE”；标题矿业词；正文强矿业词或至少两处矿业词；YPF、矿泉水等先剔除）。
- **发布前执行**（`publication/policies-publish.ts`）：判定在写入任何版本（基本事实或完整解读）之前。不通过：不写版本，`publication.policy_documents.automatic_excluded=true`，原因写入私有列 `instrument_gate_hold`（迁移 `publication/202611071300_policy_instrument_gate.sql`，只增列），审计动作 `policy.instrument_gate.hold`；同一答案重试不重写不重审计。之后判定通过只解除判定自己设的隐藏（`policy.instrument_gate.release`）；经核验的模型排除接管时清掉判定记录，人工撤回不受影响。工作流记为 `acquire / not_instrument`，继续按周期存档复查，不进入任何付费阶段。正文取自该修订已缓存的提取结果（`domain/provision-store.ts readCachedPolicyText`），不重新抓取。
- **基本事实的程序信息**（`publication/policies-project.ts withInstrumentFacts`）：通过判定的条目写入法律性质、制定阶段“已公布”（依据写明“程序判定/程序从公报原文抽取”）。阿根廷来源另由 `domain/ar-lifecycle.ts` 从原文抽取：国会通过（Sancionada 或 “Dada en la Sala de Sesiones… a los … días”，西语数字词也能读）、行政颁布（Promulgada、Promulgada de hecho，或随法律刊出的颁布法令“Ciudad de Buenos Aires, 03/11/2026 … Promúlgase”）、签发（文首地点与日期）、公报刊登日期（来源日期，国家公报取单件地址中的日期）、施行（原文写明的“a partir de su publicación / del día siguiente / el 1° de enero de 2027 / a los 30 días”；否则按《民商法典》第 5 条推算为公布日后第 9 日，标“推算”，不标已施行）。对应契约 `PolicyDate.event_kind` 新增 adoption、promulgation、entry_into_force、repeal（只增）。修改/废止对象（Modifícase/Sustitúyese/Derógase… Ley N° X、Decreto N° Y/年；中文“关于修改《X》的决定”）记为 `relationships`，附原文引文作证据（来源允许摘录时显示引文）；阅读时 `relations.ts resolveCitedTargets` 只在同一法域恰好一份现行文书的种类、号码与年份（或中文名称）一致时链接，否则保留文号文字。
- **读者端**：`web/features/lifecycle.ts argentineStages` 给出阿根廷路径：Ley 为 国会通过（Sancionada）→ 行政颁布（Promulgada）→ 公报公布 → 施行；Decreto、Resolución、Disposición 为 签发 → 公报公布 → 施行；之后是已知的修订，废止为终点。每点写日期，推算的施行日标“（推算）”，未来日期标“（计划）”。其他法域仍用原来的阶段条（现在通过判定的文书都标“已公布”）。中英文词条在 `apps/web/app/i18n/phrases.ts`。
- **清理已公开内容**（Codex 上线后在 worker 环境执行）：`node scripts/policy-regate.ts`（只统计：按来源、种类、原因计数，附 10 条样例）→ 核对后 `--apply`（隐藏不通过的，解除现已通过的判定隐藏；不删除版本，跳过人工撤回）→ 需要撤销时 `--restore`（只解除判定设的隐藏）。

## 成本设计（Owner 2026-11-05：解读段不设预算上限，成本靠设计）

原则：能用程序确定的都用程序；模型只说“这次改了什么、影响谁”；引文、条号、数字和日期由程序核对。全部模型调用走 DeepSeek，只在其错峰时段发送（错峰按官方价目半价）。

- **全文翻译：翻译记忆（`domain/translation-memory.ts`）。**请求只含语言和按哈希去重的原文段（`{sourceHash, format, source}`），不带标题、文号、段落编号，同一段文字在任何文书里请求字节完全相同；记忆键是“语言 + 提示词/配方 + 原文段的精确哈希”。新修订、其他文书或同一文书内重复出现的同一段，直接复用已付费且由真实回执证明的译文，复用后仍逐段重跑程序校验；只有新增或改动的段落才发请求。中文原件本身就是阅读文本，全文阶段不调用模型。
- **解读：只解读变化（`domain/interpretation-units.ts`、`interpretation-engine.ts`）。**程序先把各段按条号（第X条 / Artículo N / Article N）归入条款，再与同一文书同一语言上一次已核验的修订逐条对照。修订时，解读请求只含新增和修改的条款（修改的附旧文）、被删除条款的旧文，以及最少的背景（标题、文号、机关、此前的法律状态和导读）；引文全部落在未变条款里的要点和影响直接沿用，证据重新绑定到本修订的原文段。首次解读整篇，但按每次约 16 KB 原文分段发送，后一段接着前一段的结论。条款与上次完全相同的修订不调用模型。
- **核验：程序优先（取代逐组 `policy_verify`）。**程序判定：引文逐字出现在本修订原文（含所属段落）、引用的证据编号存在、日期原值出自引文且解析一致、关系目标的文号逐字出现、要点的条号在本修订中存在（不存在即判失败）、结论里的每个数字都能在所引原文（导读、标题译名则在全文）中找到；上一修订已核验且原样沿用的结论不再核验。只有程序判定不了的才发一次模型核验：数字写法与原文不同（如原文用中文数字或文字表述）、相关性判为“排除”（会把法规隐藏，必须核验）。模型核验否定或限定的单项（要点、影响、日期安排、关系）直接删去，不再花钱改写；标题译名、相关性、法律状态、导读被否定则整份解读不通过。
- **分组：程序决定。**原来的 `policy_group`（逐组核对与归并摘要）由按条号归组取代；文书身份（法域 + 机关 + 文号等）和法规之间的关系目标（文号 + 官方链接）本来就由程序认定，不存在要交给模型的归组，所以 `policy_group` 不再调用（用途名保留以兼容回执）。
- **视觉：默认关闭。**没有文字层的扫描件标为“需人工”（`needs_manual`），不渲染、不发送；只有同时设置 `POLICY_VISION_ENABLED=true` 并配置有视觉能力的模型才会进入视觉阶段。
- **幂等：**原件未变不产生新修订，什么都不跑；所有付费步骤以输入哈希为键，已买过的结果只读不再买。
- **错峰（`packages/backend/src/providers/peak-hours.ts`）：**高峰为工作日 UTC 01:00–04:00 与 06:00–10:00（北京时间 09:00–12:00、14:00–18:00；中国法定节假日不单列，按工作日处理），其余时间（含周末）为错峰。全文、视觉、解读三个法规模型任务若在高峰被取到，不发请求，按原队列机制改为错峰开始时刻再执行；存档、结构化、公开不受影响。

预计调用次数（S = 正文字节数；英文/西文约 2 KB 一次翻译请求，每次最多 12 段）：

| 情形 | 全文翻译 | 解读 | 核验 | 归组/视觉 | 合计（示例） |
|---|---|---|---|---|---|
| 新文书，外文 | ⌈S/2 KB⌉，减去记忆命中 | ⌈S/16 KB⌉（多数为 1） | 0，必要时 1 | 0 | 10 KB 西文法令约 6–7 次（旧设计约 17–23 次） |
| 新文书，中文 | 0 | ⌈S/16 KB⌉ | 0，必要时 1 | 0 | 20 KB 中文法规约 2–3 次 |
| 修订（改动 k 条） | 改动段落数/12，通常 1 | 1 | 0，必要时 1 | 0 | 通常 2–3 次 |
| 重抓未变 / 新修订但条款全同 | 0 | 0 | 0 | 0 | 0 次 |

所有付费请求都在错峰时段发出，按官方价目为高峰价的一半。部署只需在 api 与 worker 中设置 `POLICY_MODEL_STAGES_ENABLED=true`（及已有的 `POLICY_PILOT_ENABLED=true`；`MODEL_CALLS_ENABLED` 默认开启，不要设为 `false`）；不要设置 `POLICY_VISION_ENABLED`。完整公开解读仍需 Owner 按现行配方登记质量放行（`installPolicyQualityRelease`），配方已随本设计更新。

读者端呈现（2026-11-07 线上核查后）：

- **读取层统一清洗**（`backend/reader-copy.ts`，列表、详情、版本记录、对照、报告、RSS、开放接口、MCP 都经 `read.ts` 取卡片和详情，所以只在这里做一次）：标题、原题、文号和机关名里来源遗留的标签与转义字符读作纯文本（`</br>` 在中文之间直接连上）；没有中文标题时投影写的“文书 <文号>”换成官方原题；来源时刻恰为当地零点的读作只有日期；主题名按产品七主题的正式名称；“本站取得修订 N（法定版本标签未核实）”读作“本站存档第 N 版”；“附件清单尚未完整”改为读者能懂的说法；“完整解读尚不可用”不再在待核实事项里重复。已存数据和投影内容哈希不变。
- **主题**：经营主题只随完整解读给出，基本事实文书没有主题。国家页按该国全部文书计主题篇数（每页 50 份读取，超过 1,000 份时退回逐主题计数），没有主题的文书列在网页自有的 `theme=none`“未归入主题”下（不进 API）；没有文书的主题收成一行。
- **详情只读本文书**：详情、版本记录和对照按 `detail` 方式读版本（正文只在数据库里数段数，不把每个版本的全文带出来）；政策脉络和关系只读与本文书有存储关系可达的文书，不再读全部现行文书；相关报道与关系并行读取。找出链接本文书官方地址的报道，`relatedNewsForPolicy` 查报道外链表 `publication.news_links`（发布时写入每篇报道正文里的明确外链，绝对 http(s) 地址、去掉 # 片段；按地址有索引），每次访问都按当前公开状态过滤（撤回立即生效），不再读报道正文，也不再在进程内缓存。外链尚未读取的报道（迁移时已有的报道在后台补读完成前，或正文刚改过）仍直接核对其正文，所以补读期间结果也完整。报道页的“相关法规文书”同样只按报道引用的地址查对应文书（`policyPublicRecordsByOriginalUrl`，按官方地址索引），不再读全部现行文书（TASK-0567）。
- **网页**：日期、语言名、国名、版本标签和标题经 `web/features/reader.ts` 统一取得；站内链接和表单用 `@amp/web/extension` 的 `Link`/`Form`，`/en` 下不会跳回中文页；法规汇总不显示修订号和修订导航，只在当前汇编移除了文书时写一行更正说明，旧的 `edition` 链接仍能打开并提示查看当前内容。

TASK0500：公开说明仅表达正文、附件、解读及资料覆盖的实际可读范围，不显示处理回执、配置、容量或采集失败明细，也不在暂停时承诺自动复查。读取历史公开版本时只转换已知系统诊断模板和匹配附件状态的旧提示；法条、人工自定义说明、历史记录和原始运行证据不改写。法规汇总保留覆盖不足提示与AI标识，既有覆盖数据字段不变，网页不再展示内部回执统计表。

本轮不扩建法规业务、不接新模型。采集与模型处理已按Owner决定暂停，入口和已发布阅读保留。server注册法规公开读取接口、既有处理队列及三个定时任务，队列名/重试/并发/出刊节奏保留；国家地区查询留在通用站点入口，继续服务新闻筛选。模块队列通过统一worker注册器校验名称后安装，运行时仍执行原有暂停/许可/版本校验。read、reports、language与relations拥有法规公开列表/详情/正文/版本/报告、语言选择与关系投影的实际实现，旧publication入口只兼容转发。domain拥有原始资料采集、正文提取、版本、解读、证据与处理状态；provider、jobs和publication拥有既有模型适配、任务及发布/报告实现。处理状态直接从本模块读取，相关新闻经引擎具名只读入口取得；许可、现行修订和公开完整性仍在每次读取时核验。旧核心路径仅保留已登记消费者需要的兼容转发，模型设置、告警和恢复等共享消费者的扩展挂口仍待收敛。

目录新增或变化材料经on.materialDiscovered在同一事务交接，本模块使用实际policy.acquire队列定义与原directory单例键安排后续处理；重复任务视为已接收，无模块接收或入队失败不能提交材料应用结果。定时、手工收集与最终暂停规则保持。

法规工作流轮询按采集、处理、公开三个控制分别筛选到期阶段，并在批次上限前排除暂停阶段，避免其挤占其他允许阶段的名额。采集暂停或采集环境开关关闭时不发现新工作流，成功轮询沿用上次发现游标；明确恢复后从原位置继续。只暂停处理仍可采集，模型调用总开关关闭时不安排全文、视觉和解读阶段；既有已入队任务仍由执行端二次核验暂停、许可与材料版本。该入口不改变资讯线控制。

## 试点信源（2026-11-05 复核）

试点范围按法规线重启设计第 5 节。每个来源的 robots 与许可结论写在 `industry/policy-sources.ts` 的 `POLICY_PILOT`；Owner 156 条清单之外的试点补充来源放在 `industry/policy-sources.json` 的 `pilot_additions`（编号 `CN-P01` 式），与清单一起初始化、启用。下表的 robots 结果来自开发环境的单次礼貌请求，“本环境不可达”只说明开发环境网络，不是网站的答复。

| 来源 | 接口 | 文书身份 | 节奏 | 许可 | 状态 |
|---|---|---|---|---|---|
| CN-002 国务院文件与行政法规（中国政府网“最新政策”） | 官方 JSON（带 ETag/Last-Modified） | 发文字号（国令第851号），无文号退回来源+URL | 列表 6 小时，条件请求；单件页 7 天复查 | 官方文件，可存档；公开按后台许可 | 已核对 |
| CN-004 生态环境部令 | 列表页 `/zcwj/bwj/ling/` | 部令编号（部令 第40号） | 列表 6 小时（无 ETag）；单件 7 天 | 同上 | 待服务器空跑后去掉 hold |
| CN-P01 应急管理部规章（含煤矿安全） | 列表页 `gz11`（带 ETag） | 首次公布的部令编号作文书，最近一次“公布/修订”记录作版本 | 同上 | 同上 | 待服务器空跑后去掉 hold |
| CN-003 自然资源部 | 列表页（已有） | 缺单件页身份配置 | — | 同上 | 本环境不可达，须服务器取样补配置 |
| CN-001 国家法律法规数据库 | 不采集 | — | — | robots 禁止（10-08 记录） | blocked |
| 国家矿山安全监察局、国务院公报 | 未登记 | — | — | — | 规章已由 CN-P01 覆盖；国务院文件已由 CN-002 覆盖 |
| AR-001 阿根廷国家公报第一部分 | 当日列表页（已有） | 单件 ID + 日期 | 列表 6 小时 | 官方规范文本 | 本环境不可达，须服务器空跑 |
| AR-007 萨尔塔省公报 | 当期列表页 | 种类+编号/年（DECRETO N° 719/26） | 列表 6 小时（只列当期）；单件 7 天 | 同上 | 已核对 |
| AR-005 卡塔马卡省公报 | 不采集 | — | — | robots 也是 Cloudflare 验证页，不绕过 | blocked |
| AR-008 胡胡伊省公报（对照） | WordPress REST 目录整轮 | post ID；正文首段编号 | 目录整轮；单件 7 天 | 同上 | 已核对 |
| 国家标准（全国标准信息公共服务平台）、GISTM | 不采集 | 标准号+年代号 / 版本 | 人工登记 | 只存元数据与官方链接 | 本环境不可达 |
| ICMM | 不采集 | 名称+版本年 | 人工登记 | 条款只许链接首页、非商业转载；只存元数据，深链接需 Owner 决定是否申请许可 | reference_only |

- **这次修了什么**：CN-002 原配置只收 `/zhengce/年月/`（党中央文件），漏掉以国务院令公布的行政法规和国务院、国办文件，现改收 `/zhengce/content/`；AR-007、AR-008 原来没有单件页身份配置，取得阶段只会停在“缺少配置”；AR-007 列表会把“AGUAS DEL NORTE”等采购公告当成法令；CN-004 的更正入口配好了；新增应急管理部规章。
- **身份字段**：`policyProfile.fieldPatterns`（可选，title/number/version 各一个带一个捕获组的正则）从较长的官方元素里取出文号或修订记录；元数据记录同时保存原文与取出的值。空白的文号格退回“来源+URL”身份。选择器与正则由 `domain/identity-fields.ts` 统一读取，取得阶段和空跑命令用同一份代码。
- **增量与省钱**：法规线的 `json_list`、单页 `web_list` 列表带上次成功入库响应的 ETag/Last-Modified，304 时不解析、不入库（首次导入不存校验值；配置变化或跳转到别处时重新完整读取）。单件页复查时，若标题、标记、文号、版本、正文文字与链接的指纹和已存档的当前修订一致，就沿用原修订，不存新字节、不取附件、不产生新的提取、条款或公开版本；网页里的生成时间、nonce 等变化不再制造假修订。试点来源单件页复查周期改为 7 天。频率仍由既有礼貌抓取框架控制（robots、同主机至少 2 秒、429/503 退避）。
- **服务器要核对的事（Codex）**：部署后在 worker 环境依次运行下列命令（只读，不连数据库、不写入、不调模型；每个来源先读 robots，单件页之间至少 3 秒）：
  - `node scripts/policy-pilot-discover.ts --source CN-002 --detail 2`
  - `node scripts/policy-pilot-discover.ts --source CN-004 --detail 2`
  - `node scripts/policy-pilot-discover.ts --source CN-P01 --detail 2`
  - `node scripts/policy-pilot-discover.ts --source AR-007 --detail 2`
  - `node scripts/policy-pilot-discover.ts --source AR-008 --detail 2`
  - `node scripts/policy-pilot-discover.ts --source AR-001 --detail 2`
  - `node scripts/policy-pilot-discover.ts --source CN-003 --detail 1`（预期“listing_only_no_policyProfile”，把一份单件页地址交回补配置）
  - 每条应为 `status: "ok"`、`officialDocuments` 大于 0、`details[].status` 为 `identity_ok` 且 `number` 是文号、`provisions` 大于 0。任何 `robots_disallowed`、`identity_failed` 或 `unreachable` 原样贴回协作 Issue，不要改配置绕过。
  - 已在库里的 CN-002、AR-007、AR-008 是旧配置：`node scripts/seed.ts` 只新增 CN-004、CN-P01，不覆盖已有信源。旧配置要在后台“信源 → 配置草稿 → 预览 → 启用”里换成登记表的新配置，之后 `node scripts/policy-sources.ts enable --ids CN-002,AR-007,AR-008 --dry-run` 才不会报“采集配置与核对表不同”。CN-004、CN-P01 的 hold 要在空跑通过后由 Claude 提交去掉。
  - 另在服务器上取 `https://flk.npc.gov.cn/robots.txt`、`https://www.chinamine-safety.gov.cn/robots.txt`、`https://std.samr.gov.cn/robots.txt`、`https://globaltailingsreview.org/robots.txt`、`https://www.boletinoficial.gob.ar/robots.txt`，结果贴回 Issue，用于更新 `POLICY_PILOT`。
