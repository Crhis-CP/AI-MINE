# 历史背景契约（TASK-0411，未接入）

本契约解决普通历史稿没有fact、不能进入14天事实候选或60天精选阅读背景的问题。保留现行近期归组，增加经原文关系确认的独立背景；本PR只声明形状和边界，不创建数据、不调用模型、不启用网页功能。

## 现有入口与声明

所有共享声明经既有`@amp/contracts/site`导出；公开展示schema经`@amp/contracts/http/public`导出并登记OpenAPI组件。backend从现有`@amp/backend/publication/publish`转出候选Reader与安全投影Projector类型，从`@amp/backend/events/group`转出安全引用Reader类型；后续同出口实现对应函数，不新增package子路径或占位函数。

| 声明 | 输入/输出与责任 |
| --- | --- |
| HistoricalCandidateRequest | news、query的articleId/materialRevision/publicationRevision/sourceDateVersion、1—3个原文锚点、1—10条limit；无默认国别或精选前提 |
| HistoricalAnchorExtractor | `(text: string) => z.infer<typeof HistoricalAnchor>[]`；沿site及publication/publish转出类型，准备候选输入 |
| HistoricalBackgroundReader | `(HistoricalCandidateRequest) => Promise<HistoricalBackgroundCandidate[]>`；只读、无模型、无重评分或公开副作用 |
| HistoricalBackgroundCandidate | binding、item、候选原文anchors；binding.articleId与item.id一致，包含普通稿，不要求factId |
| HistoricalBackgroundConfirmation | 双方材料/公开修订、SAME_OCCURRENCE或SAME_STORY、双方非空原文锚点、回执ID与实际输入hash；仅内部证据，不公开 |
| HistoricalBackgroundReferencesReader | events/group的worker专用readHistoricalBackgroundReferences；按news及storyPublicId只返回story/双方绑定/relation，不含quote、receipt或hash |
| HistoricalBackgroundProjector<Transaction> | publication/publish的replaceHistoricalBackgroundProjection；用调用方同一事务替换指定story的安全引用，不接收私有原文证明；空引用撤销该story投影 |
| StoryDetail.background | 可选数组，每条为relation与item。item复用FeedItemSummary的标题、摘要、来源、精选状态、publishedAt，并带现有sourceTime和originalUrl；无factId或内部证据 |

锚点kind只允许project、mine、document；text须逐字出现在quote中，公司名、矿种或国家名不能独自构成锚点。请求锚点须先在query当前原文核验，候选端口沿现有搜索索引有界检索并生成实际原文摘录；允许使用已核实别名映射检索，但不得从同公司猜测项目身份。双方锚点类型须一致，文字可为有依据的不同语言/别名，模型判定不替代原文与别名依据。无可靠锚点返回空候选，不降级为全历史向量扫描，也不购买新的embedding服务。

TASK-0422追加提取器类型声明：后续在既有`@amp/backend/publication/publish`具名实现`extractHistoricalAnchors(text)`，与候选Reader复用上述项目、矿山、文书语境规则；它只准备候选输入，不签发ProcessingPermit、不调用模型，不将提取本身当作已确认关系。本片不实现函数、不新增package子路径，也不改变HTTP载荷。

公开background的sourceTime使用原有TimeAssertion精度，必须存在或明确null；publishedAt只等于其中已证明的utc。日期精度或未知时publishedAt为null，不能借发现时间、首次公开时间或人为午夜。原文发表日不证明事件发生日，本字段不新增occurredAt。background省略兼容旧生产者；接入后空数组表示没有当前已确认背景，不声称穷尽全部历史。

## 保存与读取约束

sourceTime仅接受published语义，更新日、生效日、发现日不能作为发布时间。query请求双版本变化时拒绝本次读取，不以现读新版本替代；个别候选变更则剔除该条，保持其他合格候选可用。

双方sourceDateVersion复用SourceDateTask的expectedSourceDateVersion schema，与既有MaterialUpdateResult一致。迁移定义为bigint NOT NULL DEFAULT 0，当前连接的int8解析及本地只读探针确认返回number；真实版本0合法，null、缺失或字符串不自动补成0。newsMaterialBindings的静态string注解不能替代驱动实际值。日期版本改变即使材料和公开修订暂未变化，也使旧关系失效。

1. 候选属于当前可读、合格、未撤回的资讯，不限综合精选；普通候选与已精选信息覆盖保持不同语义。检索结果不是确认关系，schema通过也不签发ProcessingPermit。消费者必须核查原文/已核实实体映射确实将锚点识别为项目、矿区或具体文书；把公司名填进project枚举不构成此证明。
2. TASK-0414复用现有pair关系提示、网关、输入许可与版本围栏；当前query须属于一个已确认story。双方实际原文必须在模型处理前取得当前用途许可，不将公开摘要冒充原文。
3. 保存前重读双方材料与公开修订、日期证据、人工控制、撤回及许可；逐字确认双方quote确实在各自当前原文，anchor.text在对应quote。不能只相信`validatedRelation`名字、模型声称或null evidence。不同项目、不同文书、无直接新行动关系、UNRELATED、ROUNDUP及缺证据均不保存。
4. events拥有独立背景关系与输入证明，至少保存story、双方绑定、relation、原文证据、真实回执、输入hash。关系仅作为阅读背景，不创建旧稿fact、不生成story_signals，不改变热度、精选、代表席位、报告选材、旧稿日期或推送资格；同输入重放复用回执和关系。
5. 旧稿或支持其关系的query修订、撤回、人工独立/重归属后，旧绑定立即失效；不得靠重新读取最新版本替换旧证明。重新判断沿受控后台任务，读者请求只读取当前有效投影，不付费、不写入。人工决定优先，暂停不自动解除。
6. TASK-0415经publication读取当前合格关系并投影安全字段，网页独立显示历史背景、关系和原文入口。背景与已有developments/timeline/reportCount/sourceCount/heat分开；按真实来源日期显示，未知单列，不补造因果或日期。相同背景稿只显示一次。

采用events私有证明表与publication安全引用投影表：events只写本模块证明，再调用publication具名投影口，由publication在同一事务写自己的表；失败一起回滚。现有grants虽支持列授权，但仅允许publication及列明例外公开读取新schema表，故不新增events例外、不开放私有proof，也不扩建权限框架。events安全Reader只供worker读取证明的安全子集，不由public_read直读。公开入口仍仅调用publication，pub读模型只返回白名单字段；当前材料/日期版本经content既有publicMaterialVersions窄口核验，不增加跨模块SQL读写位置。迁移及拥有表/角色登记由后续两卡各自维护，必须补public_read无法读取quote/receipt/hash的真实角色回归。

## 验证与后续卡

本卡回归覆盖旧响应省略、无fact普通稿、sourceTime日期精度与未知、绑定身份不一致、policy输入、空/公司锚点、批次越界、null evidence及无效关系。结构校验可以验证text位于quote，却无法验证quote位于未传入的实际原文；测试显式保留这一证据边界。

TASK-0414预留events增量迁移与确认/失效/幂等实现，TASK-0415预留publication候选读取、公开投影及网页展示；两卡在本契约合并后分配实现路径。必须补充跨年普通稿、跨语言别名、同公司多项目、同项目不同事项、更正/撤回、date-only/unknown、并发改版、暂停、重放零新增请求及热度/精选/推送不变的回归。真实历史召回率与关系准确率分别评测；本PR不宣称真实效果或上线。
