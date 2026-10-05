# 行业包

`industry/` 集中放和“行业”有关的内容：站名与文案、分类与标签、主题、种子信源、提示词、精选门槛、品牌素材、页面文案、更新日志和评测样例。换行业时这里是**主要改动点，但不是唯一的改动点**：页面和报告里另有写死的行业口径（第 3 节），只改这个目录换不完。

站点身份、分类、标签词表、主题与写作提示词已经是矿业的（TASK-0010、TASK-0028）；评分标准 `prompts/selection-score.md` 的矿业版是交 Owner 审阅的草案（TASK-0029），事件综述、归组与全文翻译等提示词还有导入时的 AI 行业写法，另开任务改。行业包的归属与机制以 `docs/04-architecture/04-aihot-adoption.md` 4.4 节为准，逐个文件的去向见附录 B 的 B.8 节。

## 1. 文件

| 文件 | 内容 |
|---|---|
| `site.ts` | 站点身份与读者看得到的文案 |
| `taxonomy.ts` | 分类、内容类型、标签词表、公司与机构名录、身份词典 |
| `topics.json` | 主题目录（`/topics`） |
| `sources.json` | 经核实的采集配置种子；当前为空，AI行业示范来源已移除，新导入一律停用 |
| `prompts/` | 各处理步骤的提示词 |
| `selection.ts` | 精选门槛 |
| `brand/` | 站点图标、Logo，以及日报、周报、月报的报头字（`nameplates/`） |
| `pages/` | 使用规则与隐私说明，是模板，上线前按实际情况改写并经 Owner 确认 |
| `changelog.json` | 更新日志（`/changelog`）：新条目写在 `releases` 最前面，`latestVersion` 写它的日期和时间 |
| `gold.example.jsonl`、`relation-gold.example.jsonl` | 精选评测与事件关系评测的样本格式示例（2.6 节） |

## 2. 各文件怎么写

### 2.1 `site.ts`

- `name`：站名。导航、页面标题、分享图、RSS、MCP 与私有页面都用它。
- `subject`：行业词。`withSubject()` 用它拼出“X 日报”“X 动态”这类说法，英文词后面加空格，中文词不加。
- `homeTitle`、`description`、`tagline`：首页完整标题；一句话介绍（搜索引擎、分享卡片、RSS、`llms.txt` 用）；首页与侧边栏的一行小字。
- `locale`：界面语言（HTML `lang`、`og:locale`）。
- `defaultUrl`：只在没设置 `SITE_URL` 时使用。站点地址由部署时的环境变量 `SITE_URL` 决定，不写在这里。
- `mcpPrefix`：MCP 站点前缀，现值 `aiminingpolicy`。5个工具名在 contracts 固定，集成测试保证与此前缀一致；修改站点显示配置不会静默重命名工具。
- `contactEmail`：对外联系邮箱（选填），使用规则、`llms.txt` 与响应头会写。`organization`：结构化数据里的网站运营者。
- `crawlerName`：抓取信源时在 User-Agent 里报的名字，不能冒用别的站名。现在是 `AIMiningPolicyBot`。
- `icp` 与 `ABOUT`（关于页文案，“怎么工作”四个环节各配一个站内实时统计数字）会按第 4 节拆走；页脚小字 `footerNote` 已删除。

### 2.2 `taxonomy.ts` 与 `topics.json`

- `CATEGORY_LABELS`、`CHANNEL_LABELS`：显示标签的公开出口；分类/栏目 keys 与顺序在 contracts 固定，离线集成测试逐项对齐，industry 不反向依赖 contracts。
- `CATEGORIES`：首页与“全部动态”的筛选类别，也用于卡片角标和 RSS 分类订阅。`key` 出现在网址与接口里（`/all?category=`、`/feed/category/<key>.xml`），上线后冻结；`label` 是显示名；`section` 是日报里的分节标题，几个类别可以共用一节；`guide` 告诉模型怎么归类。没归上类的资料放进 `key` 为 `industry` 的类别所在的节，没有这个类别就放最后一节。
- `ITEM_TYPES`：内容理解一步判定的内容类型，与 `CATEGORIES` 的 9 个 key 同一套、顺序相同（上游的 7 个评分类型也和它自己的网站分类基本一一对应）。`prompts/content-understanding.md` 列出这些类型，`prompts/selection-score.md` 按类型给评分维度不同的权重，三处在同一个提交里改；内容类型只用于评分与写作，网站显示的主类别仍由结构化一步独立判定。
- `CATEGORY_TAGS`、`TOPIC_TAGS`、`ENTITY_TAGS`：模型打标签时只能从这里选，每篇资料的第一个标签必须是分类标签；`TAG_SYNONYMS` 把模型常写的近义写法统一成词表里的标签（黄金→金、刚果(金)→刚果（金）、澳洲→澳大利亚、矿企别名→显示名等）。
- `ENTITIES`：主要公司与机构，用于公司类主题。`IDENTITY_LEXICON`、`PUBLISHER_DOMAINS`、`IDENTITY_CONTEXT_ALIASES` 防止模型在标题和摘要里写进原文没提到的公司：核验过的身份事实经 `prompts/identity-context.md` 交给模型。
- `topics.json`：主题目录，分三组：`genre`（国家与地区）、`field`（金属）、`company`（矿企）；组的键沿用上游，页面只改显示名。每个主题用 `tags` 或 `entityId` 决定收哪些内容；`slug` 出现在网址里，上线后冻结。

### 2.3 `sources.json`

| 字段 | 含义 |
|---|---|
| `kind` | `rss`；`web_list`（网页列表，配选择器）；`json_list`（JSON 接口）；`mp_account`（公众号，经付费的第三方接口，附录 B 定为关闭）；`external`（外部推送，推送入口首版关闭、不注册，F-ACQ-07） |
| `config` | 各采集方式的配置。允许的键在 `packages/backend/src/sources/config-keys.ts`，种子导入和私有页面新建、修改信源时遇到不认识的键都会报错 |
| `tier` | 信源分级，决定入选门槛：`T1` 官方一手，`T1_5` 官方账号与准官方，`T2` 媒体与个人，`EXCLUDE_MP` 不参与精选 |
| `participation_mode` | `editorial` 进精选与全部动态；`hot_signal` 只作热度证据；`isolated` 不进任何公开页面 |
| `first_party`、`owner_entity_id` | 是不是当事方自己发的（官网、官方账号），以及对应 `taxonomy.ts` 里的哪个主体 |
| `interval_minutes`、`tags` | 抓取间隔（分钟）与信源标签 |
| `site_fulltext` | 站内能否展示全文；只有在确认取到正文时才展示，否则只给摘要和原文链接 |
| `syndicate_fulltext` | 全文 RSS 能否再分发正文，只在站内也展示全文时生效 |

`site_fulltext` 的缺省并不统一：种子、私有接口和数据库列都是关（列在迁移 0001 里缺省开，0036 改成关），私有页面的新建信源表单却默认勾选。能不能展示全文以信源权限矩阵为准（ADR-0009），不以哪个缺省为准。

### 2.4 `prompts/`

| 文件 | 用途 |
|---|---|
| `prefilter.md` | 预筛：是不是本行业的事。宽召回，只拦明显无关的 |
| `selection-score.md` | 评分标准：0–100 分，同一份标准独立打两次；含内容类型、评分维度与各类型的权重，以及必须正常评价的价值和必须压住的噪声 |
| `understand.md` | 入选和接近入选的资料怎么写：中文标题、答案先行的摘要、推荐理由、标签。由 `content-understanding.md` 加四份共用规则（`rules-domain.md`、`rules-anti-hallucination.md`、`rules-self-contained-title.md`、`rules-answer-first-summary.md`）组成 |
| `summarize-article.md`、`summarize-article-empty.md` | 其余资料的标题与摘要；后者用于原文为空的资料 |
| `rules-*.md` | 共用规则：领域术语的翻译与保留（`rules-domain.md`）、防幻觉、答案先行的摘要、自洽的标题 |
| `identity-context.md` | 把核验过的公司身份事实交给模型 |
| `structure.md`、`safety.md` | 分类、标签、主体与事实的结构化抽取；资料内容一律当作不可信数据 |
| `group-*.md` | 事件归组：两篇报道的关系（成对与批量判断），以及热度信号挂到哪个事实上；关系定义在 `group-definitions.md` |
| `story-digest.md` | 事件综述 |
| `report-daily-lead.md`、`report-period.md` | 日报导语，周报与月报 |
| `translate-body.md` | 全文翻译 |

模板只有两种写法（`packages/backend/src/editorial/prompts.ts`）：`{{名字}}` 是调用方传入的值（另有站名 `siteName`），`{{> 文件名}}` 原样插入另一份提示词。缺值或缺文件直接报错，不会留空。提示词的版本号由名称加它读到的所有文件内容的哈希组成，回执和私有页面的模型页都记着结果出自哪一版；改一个字，版本号就变。

### 2.5 `selection.ts` 与校准

- `thresholds`：按信源分级的入选门槛。每篇资料独立评分两次，两次之和不低于两倍门槛才入选，页面显示两次的平均分。没有门槛的分级不参与精选。现值 T1 60、T1_5 65、T2 76 是在 AI 领域校准的，矿业版沿用作起点（4.4 节）。
- `understandFloor`：没入选、但平均分高于它的资料也按入选的写法写（50）。

换了行业或评分标准就要重新校准（BR-SEL-08）：

1. 从自己的信源里挑 100–200 条资料，逐条标“该选 / 不该选 / 两可”，存成 `.data/gold.jsonl`（`.data/` 不进 Git，格式见 2.6 节）。多放差一点就该选、差一点就不该选的难例；留一部分作留出集，调提示词只看开发集。
2. 跑 `node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl --split development --label "说明"`（另有 `--models`、`--n`、`--no-import`）。输出准确率、查准率、查全率，门槛从 40 到 90 每隔 2 分的结果，以及判错的条目；完整报告写到 `.data/eval/`，并导入私有页面的 SelectBench。评测会真实调用模型、产生费用，只在任务卡给的额度内跑。
3. 先改评分标准，再动门槛：该选没选上，多半是标准没写清它为什么重要；不该选却选上，多半是噪声没压住；门槛只能整体移动。矿业版评分标准生效前须 Owner 审阅确认（BR-SEL-09）。

### 2.6 评测样例

`gold.example.jsonl`（精选，`scripts/eval-selection.ts`）每行一条：

| 字段 | 说明 |
|---|---|
| `caseId` | 唯一编号 |
| `material` | `title`、`originalTitle`、`publishedAt`、`sourceName`、`bodyZh`、`bodyOriginal`（两种正文有一个就行） |
| `sourceFacts` | `sourceKind`、`sourceTier`（决定用哪个门槛）、`firstParty`、`language` |
| `samplingContext` | 可选：`benchmarkSplit`（如 `development`、`holdout`）与 `samplingStratum`（自己的分组，用来看错在哪一类） |
| `gold.decision` | `select`、`reject` 或 `either`（两可，不计入判定类指标） |

`relation-gold.example.jsonl`（事件关系，`scripts/eval-relations.ts`）每行一对报道：`caseId`；`a`、`b` 各有 `title`、`source`、`firstParty`、`publishedAt`、`summary`，可选 `frame`（`subject`、`action`、`object`、`occurredAt`）；`samplingContext` 同上；`gold.relation` 取 `SAME_OCCURRENCE`、`SAME_STORY`、`UNRELATED`、`ROUNDUP`。它只评测成对判断，用的是生产环境的提示词，不重跑候选召回。

### 2.7 `brand/`

- `logo.svg`、`icon.png`（512）、`icon-192.png`、`apple-icon.png`（180）、`favicon.ico`：站点图标，由 api 在站点根路径提供。图案是站名里的第一个汉字（“矿”）；换站名后用 `node scripts/brand-icons.ts <字体包目录>` 重新生成。底色是中性的临时色，由 T-0006 与 Owner 定配色（Q-67）后重画。
- `nameplates/`：报头字 SVG。换站名或行业词后用 `node scripts/nameplates.ts <字体包目录> [行业词]` 重新生成。现在的报头字是“矿业日报”“矿业周报”“矿业月报”与“日报合订本”：行业词用 PG-06 的报告名“矿业”，先于 `site.ts` 的 `subject`（它由 TASK-0010 改）。
- 两个脚本用同一个字体包，取法写在脚本开头；画出的是 Noto Sans SC Black 的字形轮廓（SIL OFL 1.1，见根目录 `NOTICE`）。
- 网页左上角的站名字标在 `apps/web/app/components/Logo.tsx`，不在这里：用文字排出站名，前面的拉丁字母用正文色，其余用强调色。

## 3. 包外的硬编码

上游写死在页面与报告代码里的 AI 口径已经改成矿业的（TASK-0010、TASK-0028）：报告标题、报头顶行的 `MOTTO`（“金属矿业 · 每日要闻 / 每周综述 / 每月盘点”）、主题页的描述与三组名称（国家与地区、金属、矿企）、热点页说明、反馈页的示例、后台新建信源页的占位文字。还剩几处：`packages/backend/src/reports/compose.ts` 的 `modelsReleased` 指标按“模型发布/更新”分节计数，矿业版没有这一节，恒为 0，`features/report/format.ts` 在为 0 时不显示，随报告指标改造一并删除；`apps/api/src/routes/og.ts` 的主题分享图副标题与 `packages/backend/src/publication/llms.ts` 的说明仍是旧的三组说法，另开任务改。

分析与分类相关测试里的示例分类、标签和公司已换成矿业的（如“铜”“锂”“紫金矿业”）；事件、信号、翻译等测试的夹具里还有 AI 行业的例子，测的规则与行业无关，随相应任务换掉。以后改 `taxonomy.ts` 时，用例失败就把例子换成新词表的对应项，测的规则不变。

## 4. 运行机制与已定的变化

1. **构建期内容随发版生效**：`site.ts`、`taxonomy.ts`、`selection.ts`、`prompts/`、`pages/`、`brand/` 打进镜像，改了要重新构建、发版。契约包现在在构建时 import 本包的分类（`packages/contracts/src/taxonomy.ts`），这个方向要反转：分类键由契约定义，行业包只提供标签、说明与提示词，并按契约的 schema 校验（TASK-0005）。
2. **上线后冻结的标识**：分类 `key`、主题 `slug`、MCP 前缀、报告周期键出现在网址、接口与 RSS 里，改动走契约的破坏性变更流程。
3. **种子语义**：`scripts/seed.ts` 每次运行都用 `topics.json` 覆盖库里同名的主题，信源则只插入库里没有的（`ON CONFLICT DO NOTHING`）。现在 Compose 的 `setup` 容器每次 `up` 都先迁移再跑种子；初始化已改为新信源一律 `enabled=false`、`next_fetch_at` 为空，不接受种子内的启用标记；已有来源不覆盖。AI行业示范来源已移除，当前采集配置种子为空；Owner原始信源表（`industry/seed/`）仍是待研究目标，不能直接变成采集配置。后续逐源核实配置、通过预览和权限确认后经私有页面显式启用；主题改由分面生成（PG-08），取消覆盖式种子；迁移与种子改为发布步骤。
4. **站点信息分三层**：`site.ts` 只留构建期常量；`footerNote` 删除（已随 T-0002 删）；`icp` 删除，ICP 备案号与公安联网备案号改读受保护的运行时配置（生产环境任一未配置则公开站不开放）；`ABOUT` 只留版权类固定声明，关于与联系方式改由私有页面“网站资料”编辑。
5. **其余去向**（附录 B 的 B.8 节）：`sources.json` 由 `industry/seed/` 取代；`changelog.json` 改为产品更新表加 `changes/*.md`；两个评测样例移到 `evals/<能力>/` 并换成矿业样例；`brand/` 换成 AI矿策 的标识，仓库里不得留下与上游品牌素材 SHA-256 相同的文件，报头字按新站名重新生成（已随 T-0002 换）；`pages/` 补上联系方式与截图 180 天后删除的说明，上线前经 Owner 确认；分级 `EXCLUDE_MP` 改名 `EXCLUDE`。

## 法域与原始来源输入

`@amp/industry/jurisdictions` 提供 33 国、3 个组织及中国 14 个下级法域的纯数据；资讯起点国家单独导出为 `NEWS_COUNTRIES`。来源、字段与验证见 `jurisdictions/README.md`。`seed/` 保存 321 条原始记录/320 个目标的字节镜像及哈希，属于待接入的业务输入；当前运行源仍由 `sources.json` 控制，镜像不会自动启用或替换它。

## 九类矿业分类

`@amp/industry/mining-taxonomy` 逐项采用现行术语表第3节、DR-100及DR-89：全称、紧凑别名、定义（guide）和三组报告主题栏。CATEGORIES 使用这份定义；它不是国家/矿种/实体/主题词表，也不改 ITEM_TYPES 或评分。未知分类的主题栏为 null，国内/海外另凭国家证据。

结构化与理解调用使用 `configuredPromptVersion(name, values)` 对实际 `promptText` 渲染文本求版本；仅实际使用的注入值会影响版本，参数键序和未使用值不影响。现行 promptVersion、预筛/评分调用及模板保持；Task5联合接入判定/发布/旧账本出口、现有页面和public生成客户端。合成样本只验证链路，不代表真实分类质量验收。
