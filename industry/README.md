# 行业包

`industry/` 集中放和“行业”有关的内容：站名与文案、分类与标签、主题、种子信源、提示词、精选门槛、品牌素材、页面文案、更新日志和评测样例。换行业时这里是**主要改动点，但不是唯一的改动点**：页面和报告里另有写死的行业口径（第 3 节），只改这个目录换不完。

站点品牌和出刊时刻由 `site/site.ts` 维护，行业分类、标签、来源与提示词集中在本目录。资讯预筛、评分、归组、综述和翻译采用矿业语义；已确认规则以决定记录及任务卡为准，不把历史草稿当成现行配置。法规自动更新与模型处理随本轮统一发布暂停，已有内容和入口保留。

## 1. 文件

| 文件 | 内容 |
|---|---|
| `site.ts` | 站点品牌的兼容入口，实际配置在 `site/site.ts` |
| `taxonomy.ts` | 分类、内容类型、标签词表、公司与机构名录、身份词典 |
| `topics.json` | 主题目录（`/topics`） |
| `sources.json` | 经核实的矿业采集配置；新导入默认停用，已有运行配置通过增量核对维护 |
| `prompts/` | 各处理步骤的提示词 |
| `selection.ts` | 精选门槛 |
| `brand/` | 站点图标、Logo，以及日报、周报、月报的报头字（`nameplates/`） |
| `pages/` | 使用规则与隐私说明；内容变更经 Owner 确认，修订日期不代表已经上线 |
| `changelog.json` | 更新日志（`/changelog`）：新条目写在 `releases` 最前面；`latestVersion` 写第一条的日期，第一条有时间再加“T时间”（如 `2026-10-06T02:50`）；同一天里只写日期的条目排在有时间的前面；每条只许 `date`、`time`、`kind`、`version`、`title`、`body` 六个字段，读入时整份校验，不合格就报错（TASK-0038） |
| `metal-prices.json` | 金属价格来源与品种：保留sources/items的来源、许可、默认单位与精确sourceName匹配；新增metals品种顺序、intro导语、frequencies频率标签与较上期描述、footnotes脚注、notes说明和officialLinks官方入口。启用报价品种必须有metal/quote，spec/footnote可选；品种可以写convert（换算以后显示：指向同一来源的汇率品种、系数、显示的单位与币种）与rate: true（汇率品种，入库、不显示），现在只有俄罗斯央行用；国家统计局四种有色与硫酸启用、六种钢材停用保留，原数见夹具。整份校验字段、引用、唯一性、HTTPS与占位，链接只供点击，不因此抓取行情（TASK-0085）。品种可写 `sourceId`：仅商务预报的 indexId 用于取数，页面不显示 |
| `gold.example.jsonl`、`relation-gold.example.jsonl` | 精选评测与事件关系评测的样本格式示例（2.6 节） |

## 2. 各文件怎么写

### 2.1 `site.ts`

- `name`：站名。导航、页面标题、分享图、RSS、MCP 与私有页面都用它。
- `subject`：行业词。`withSubject()` 用它拼出“X 日报”“X 动态”这类说法，英文词后面加空格，中文词不加。
- `homeTitle`、`description`、`tagline`：首页完整标题；一句话介绍（搜索引擎、分享卡片、RSS、`llms.txt` 用）；首页与侧边栏的一行小字。
- `locale`：界面语言（HTML `lang`、`og:locale`）。
- `defaultUrl`：只在没设置 `SITE_URL` 时使用。站点地址由部署时的环境变量 `SITE_URL` 决定，不写在这里。
- `mcpPrefix`：MCP 站点前缀，现值 `aiminingpolicy`。11个工具名在 contracts 固定，集成测试保证与此前缀一致；修改站点显示配置不会静默重命名工具。
- `contactEmail`：对外联系邮箱（选填），使用规则、`llms.txt` 与响应头会写。`organization`：结构化数据里的网站运营者。
- `crawlerName`：抓取信源时在 User-Agent 里报的名字，不能冒用别的站名。现在是 `AIMiningPolicyBot`。
- `icp`、`publicSecurity`、`newsLicense`：实际登记后展示的 ICP 备案号、公安联网备案号与互联网新闻信息服务许可证编号，按已确认的备案信息配置（页脚本来就公开显示）；没有的写 `null`，页面不显示。`ABOUT` 是关于页文案（“怎么工作”四个环节各配一个站内实时统计数字）；页脚小字 `footerNote` 已删除。

### 2.2 `taxonomy.ts` 与 `topics.json`

- `CATEGORY_LABELS`、`CHANNEL_LABELS`：显示标签的公开出口；分类/栏目 keys 与顺序在 contracts 固定，离线集成测试逐项对齐，industry 不反向依赖 contracts。
- `CATEGORIES`：首页与“全部动态”的筛选类别，也用于卡片角标和 RSS 分类订阅。`key` 出现在网址与接口里（`/all?category=`、`/feed/category/<key>.xml`），上线后冻结；`label` 是显示名；`section` 是日报里的分节标题，几个类别可以共用一节；`guide` 告诉模型怎么归类。没归上类的资料放进 `key` 为 `industry` 的类别所在的节，没有这个类别就放最后一节。
- `ITEM_TYPES`：内容理解一步判定的内容类型。`prompts/content-understanding.md` 列出这些类型，`prompts/selection-score.md` 按类型给评分维度不同的权重，三处在同一个提交里改。`CATEGORY_BY_ITEM_TYPE`：模型漏了分类标签时，按内容类型补一个。
- `CATEGORY_TAGS`、`TOPIC_TAGS`、`ENTITY_TAGS`：模型打标签时只能从这里选，每篇资料的第一个标签必须是分类标签；`TAG_SYNONYMS` 把模型常写的近义写法统一成词表里的标签（黄金→金、刚果(金)→刚果（金）、澳洲→澳大利亚、矿企别名→显示名等）。
- `ENTITIES`：主要公司与机构，用于公司类主题。`IDENTITY_LEXICON`、`PUBLISHER_DOMAINS`、`IDENTITY_CONTEXT_ALIASES` 防止模型在标题和摘要里写进原文没提到的公司：核验过的身份事实经 `prompts/identity-context.md` 交给模型。
- `topics.json`：主题目录，分三组：`genre`（国家与地区）、`field`（金属）、`company`（矿企）；组的键为固定契约，页面使用相应中文名称。每个主题用 `tags` 或 `entityId` 决定收哪些内容；`slug` 出现在网址里，上线后冻结。

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
| `rules-*.md` | 共用规则：领域术语的翻译与保留（`rules-domain.md`，其中第 3 条“通行中文名”引用 `rules-domain-names.md`）、防幻觉、答案先行的摘要、自洽的标题 |
| `identity-context.md` | 把核验过的公司身份事实交给模型 |
| `structure.md`、`safety.md` | 分类、标签、主体与事实的结构化抽取；资料内容一律当作不可信数据 |
| `group-*.md` | 事件归组：两篇报道的关系（成对与批量判断），以及热度信号挂到哪个事实上；关系定义在 `group-definitions.md` |
| `story-digest.md` | 事件综述 |
| `report-daily-lead.md`、`report-period.md` | 日报导语，周报与月报 |
| `translate-body.md` | 全文翻译；只引用 `rules-domain-names.md`（公司与机构的通行中文名，翻译只用这份名单），术语默认值不进翻译，改术语或写作规则不会让已译的全文重译；改 `translate-body.md` 或 `rules-domain-names.md` 会让已存的外文全文全部重译（后者和摘要规则 `rules-domain.md` 第 3 条共用） |

模板只有两种写法（`packages/backend/src/editorial/prompts.ts`）：`{{名字}}` 是调用方传入的值（另有站名 `siteName`），`{{> 文件名}}` 原样插入另一份提示词。缺值或缺文件直接报错，不会留空。提示词的版本号由名称加它读到的所有文件内容的哈希组成，回执和私有页面的模型页都记着结果出自哪一版；改一个字，版本号就变。

### 2.5 `selection.ts` 与校准

- `thresholds`：按信源分级的入选门槛。每篇资料独立评分两次，两次之和不低于两倍门槛才入选，页面显示两次的平均分。没有门槛的分级不参与精选。当前配置为 T1 60、T1_5 65、T2 76。达到分数条件后仍须确认归组及信息增量，才正式入选。
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

- `logo.svg`、`icon.png`（512）、`icon-192.png`、`apple-icon.png`（180）、`favicon.ico`：站点图标，由 api 在站点根路径提供。图案是站名里的第一个汉字（“矿”）；换站名后用 `node scripts/brand-icons.ts <字体包目录>` 重新生成。品牌配色与当前站点保持一致。
- `nameplates/`：报头字 SVG。换站名或行业词后用 `node scripts/nameplates.ts <字体包目录> [行业词]` 重新生成。现在的报头字是“矿业日报”“矿业周报”“矿业月报”与“日报合订本”：行业词用 PG-06 的报告名“矿业”，先于 `site.ts` 的 `subject`（它由 TASK-0010 改）。
- 两个脚本用同一个字体包，取法写在脚本开头；画出的是 Noto Sans SC Black 的字形轮廓（SIL OFL 1.1，见根目录 `NOTICE`）。
- 网页左上角的站名字标在 `apps/web/app/components/Logo.tsx`：用文字排出站名，前面的拉丁字母用正文色，其余用强调色。

## 3. 包外的硬编码

报告标题、报头、主题分组、热点说明、反馈示例和信源表单均使用矿业语义。日报按规则编排，周月报汇编对应日报；报告窗口与页面时间说明共用站点出刊配置。`modelsReleased` 已不在报告编排中使用。

测试使用合成材料验证分类、归组、翻译与权限行为，不能替代真实矿业样本质量验收。调整词表时同步更新受影响样例，不通过替换样例掩盖业务规则变化。

## 4. 运行机制

1. **构建期配置**：品牌、分类标签、评分配置、提示词、静态页面与素材随版本构建。分类键由契约定义，行业包提供显示名称、说明和提示词。
2. **稳定标识**：分类 `key`、主题 `slug`、MCP 工具名和报告周期键出现在网址及公开接口中，修改须走契约变更流程。
3. **种子与运行配置**：`scripts/seed.ts` 更新同名主题，只插入不存在的来源，新来源默认停用；已有来源及人工权限、启停配置不覆盖。`sources.json` 保存已核实配置，`seed/` 保存研究输入，两者均不能替代生产启用和自然采集证据。运行库中的来源通过后台和受控增量接入维护。
4. **站点信息**：`site/site.ts` 保存品牌、出刊时间、已确认的备案号码和默认说明；可编辑的网站资料由后台维护。公安备案已由Owner提供官方查询证据，页脚展示随统一发布生效。
5. **更新说明**：`changes/*.md` 记录单项用户可见变化；`industry/release-note.json` 汇总本次更新及独立公告，正式发布后按实际健康上线时间登记。历史 `changelog.json` 仍保留兼容读取。隐私和使用规则以Owner已确认正文为准。

## 法域与原始来源输入

`@amp/industry/jurisdictions` 提供 33 国、3 个组织及中国 14 个下级法域的纯数据；资讯起点国家单独导出为 `NEWS_COUNTRIES`。来源、字段与验证见 `jurisdictions/README.md`。`seed/` 保存 321 条原始记录/320 个目标的字节镜像及哈希，属于待接入的业务输入；实际启停、权限和采集结果以运行库为准，镜像不会自动启用或替换已有来源。

## 九类矿业分类

`@amp/industry/mining-taxonomy` 逐项采用现行术语表第3节、DR-100及DR-89：全称、紧凑别名、定义（guide）和三组报告主题栏。CATEGORIES 使用这份定义；它不是国家/矿种/实体/主题词表，也不改 ITEM_TYPES 或评分。未知分类的主题栏为 null，国内/海外另凭国家证据。

结构化与理解调用使用 `configuredPromptVersion(name, values)` 对实际 `promptText` 渲染文本求版本；仅实际使用的注入值会影响版本，参数键序和未使用值不影响。预筛、评分、发布及公开页面共用当前行业口径；外部HTTP契约保留，内部生成客户端已退役。合成样本只验证链路，不代表真实分类质量验收。
