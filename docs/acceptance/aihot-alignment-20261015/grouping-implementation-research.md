# 事件归组、精选价值与席位：精确实施接入研究

研究日期：2026-10-15；当前统一分支 `codex/site-major-upgrade`，读取基线 `de50f4293596986cb799f45083fdcdeae24f267e`。上游固定 `540c47788eb6475c7ad8819d36733eda81dca20d`，来源 `.cache/aihot-540c477`。仅研究代码及测试，本轮未运行测试、调用真实模型、访问生产或修改产品代码。

## 1. 当前确实没有完成的行为

| 当前接入点 | 已确认事实 | 必须替换的行为 |
|---|---|---|
| `packages/backend/src/events/group.ts::decide`，关系判断catch | 仍执行 `markGrouped(articleId)`、`publishArticle(articleId)` 后throw；markGrouped只写grouped_at，不绑定revision | 身份失败只能pending/failed，不能把失败当完成；普通动态可读不代表精选可入 |
| `group.ts::decide`，looksLikeRoundup之后 | 只把verdict改为roundup，后面仍统一createStory/createFact、primary/report membership、热度信号 | 综合稿只mention已知事实，不创建自己的单事实，不据它合并事件 |
| `editorial/analyze.ts::StructureSchema/runStructure/normalizeAnalysis/analyzeArticle` | 结构输出没有scope；保存analysis.output也没有scope | 先接入single/composite/unknown，才有可信综合稿分支；缺字段保持unknown，不能推定single |
| `events/relate.ts::BatchSchema/verdictsByFact` | schema没有selection；数组可catch为空；漏候选默认为UNRELATED，重复ID被忽略 | 新输出要求精确覆盖每个C候选一次+selection明确布尔/理由；坏输出必须失败，不可创造新事实 |
| `publication/publish.ts::publishArticleTx` | selected直接来自eligible+评分；未归组等180秒也可入选；没有selection_candidate/seat | 评分只提名；当前修订归组和值判断完成才精选；同事实机器出口只一席 |
| `group.ts::replayStoredRelations/moveOntoStoredFact` | 旧回执只有response被读；不核subject revision/输入manifest；移动全部非manual membership；缺正常归组的许可/暂停/撤回锁 | 先加严格证据与正常事务边界，再回放；不能把这个现成函数直接在生产批量执行 |
| `admin/runs.ts::autoReleaseUnknownReceipts` | 已有unknown满30分钟一次放行，但ARTICLE_STEPS不含group_article/group_review等；归组回执可能释放而requeued=false | 按purpose定向重排归组及其任务，不重走评分；增加pending归组安全网和后台等待状态 |

**不要直接搬上游旧数据迁移。** 上游 `database/migrations/0046_grouping_reliability.sql` 把grouped_at不空、已有selected或membership的旧稿统一标complete，再从失败队列修部分；本站grouped_at曾在失败路径填写，因此这条启发式不可靠，也违背本轮“不把旧数据默认当确认”。上游selected还允许 `selection_adds_value !== false` 的历史null；本站新行为须把“未做价值判断”明确留在待补队列，不能因null通行。

## 2. 最小字段与公开契约

新增迁移采用本仓库新的唯一文件名；既有迁移不改。新字段只增量，回填独立于DDL，以有界批次执行。

| 对象 | 字段 | 含义与初值 |
|---|---|---|
| articles | `grouping_status text`，pending/complete/failed，NOT NULL DEFAULT pending | 只描述当前修订的完整身份+价值流程。旧grouped_at不自动证明complete |
| articles | `grouping_receipt_id bigint nullable`、`grouping_error text nullable` | 最后阻塞的回执与诊断；失败不能覆写已完成的新决定 |
| articles | `selection_adds_value boolean nullable`、`selection_value_reason text nullable` | null=未知；false=没有新增阅读价值；true=完成判断或明确可核的规则决策 |
| articles | `grouping_input_revision integer nullable` | 本次完成/失败对应材料revision；显式消除grouped_at跨修订沿用歧义 |
| publications | `selection_candidate boolean NOT NULL DEFAULT false` | 仅当前可公开分析和人工字段满足评分条件，不等同selected |
| publications | `seat boolean NOT NULL DEFAULT false` | 迁移期不默认所有旧稿拥有席位；统一重建后单稿/独立稿可true，同事实普通报道仅代表true |
| grouping_decisions | `input_revision integer nullable`、`input_manifest jsonb nullable` | 新判断保存query/candidate/reading的材料revision、content hash、候选顺序、公开背景publication revision、prompt版本及回执ID。旧记录缺失即未知，不补造 |

`regroup_pending`已有 `requested_at`。开始时读取其精确值，提交时比较同一个值（或同时仍不存在），完成时只删除自己观察到的那条请求；不能无条件 `DELETE WHERE article_id` 消掉模型调用期间新增的人工重组请求。这样复用已有列，不必另造通用generation框架。

后台运行契约增量加入 `grouping: {waiting, needsAttention, items}`，item包含articleId、title、since、failed、receiptId、error、recovery（automatic/receipt/manual）。后台详情输出candidate、当前归组状态和价值理由。公开文章响应的selected原字段保留；seat为内部公开集合规则，除确有客户端需求不暴露新内部状态。生成API客户端之前先完成相应契约卡。

**对范围字段的选择：** scope属于analysis.output的结构化结果，不必新增articles.scope第二真源；StructureSchema引入枚举single/composite/unknown，normalize和detail保存同一个值，提示词与版本同步。已有structure回执缺scope的旧稿保持unknown。不要为取得scope重跑prefilter、两次score、understand整套；仅对有明确需求的候选补结构/归组步骤，已有付费结果保持。

## 3. 在线归组流程的接入顺序

### 3.1 关系与价值答案分开兼容

在 `events/relate.ts` 保留矿业 `validatedRelation` 的不同国家、不同项目、相反阶段约束；引入上游 `SelectionValue`、`ReadingContext`、CandidateView.selected/selectedReport。把group-batch的prompt版本单独命名，使只改价值提示不会无故改变group-pair/group-signal的复用身份。

新 `BatchSchema`：decisions的id必须C1…Cn形式、relation为枚举、confidence为真实0–1数字、selection.addsValue为真正boolean，reason非空且最多400字符。`completeDecisions`检查候选数量、无重复、无缺号、无越界；不允许`.catch([])`把坏答案归类为新事实。无事实候选但有阅读背景时，合法decisions=[]且仍要求selection。

**旧回执解析另设LegacyIdentityAnswerSchema。** 当前 `storedModelDecisions`复用在线BatchSchema，若直接加必填selection，旧回执将全部失效。Legacy parser只解析当时实际保存的关系，明确返回`selection: unknown`；不可用默认true补齐。旧格式的可接受ID映射只限实际候选长度，不接收C0/负数/小数/越界/重复对应不同事实。

### 3.2 召回和输入许可

当前group.ts把recall、candidateViews、批判定混在同文件。先按上游 `events/recall.ts` 切出纯召回/读取模块，保留现有单连接事务用法和矿业地理证据。

- 身份候选仍来自有效primary/report，排除过期自动membership、regroup_pending、当前综合稿、明确撤回与已合并事件。
- candidateViews同时读取**身份代表**和**当前真正公开精选的代表稿**，两者不能混为一篇；价值比较针对后者。
- 另召回最近14天的已公开精选、fact_id为空的综合/独立稿，最多3条作为R阅读背景，只判断覆盖，不能当C事实候选。
- 新稿与阅读背景正文只取已存材料，不为比较发起网页采集；按上游上限有界取原文（GROUP_BODY_CHARS=10000）。全部实际发送材料进入`relationInput`/ProcessingPermit与最终CAS：不能只对query+C核许可而遗漏新增R背景。
- 无任何已精选覆盖时采用上游规则 `NO_SELECTED_COVERAGE={addsValue:true,...}`；未精选/撤回/未到公开时间的候选不能充当“读者已看过”。这是本次查询得出的当前事实，不可由旧日志缺字段推导。

### 3.3 领取、成功、失败

1. `groupArticle`先在事务中锁article，读取revision、status、value、regroup_requested_at；对真正未完成/新修订/显式重组设pending并清当前错误。若旧精选需撤出，pending与publication重投影同一事务提交。
2. 已complete且同revision、无新请求的普通重复运行复用完成结果，不短暂移除席位、不重复调用。
3. manualDecision始终先查且提交前再查；人工独立/人工归属可写明规则理由，但并不替代source许可、人工下架和当前材料公开条件。
4. 成功事务沿用既有顺序：`withdrawal-membership`锁 → runtime control核对 → 许可锁 → 有序材料锁 → query revision/所有C与R材料revision及当前公开背景核对 → manualDecision再查 → 写membership/decision/value/status → 完成真实回执 → publication/席位更新。避免在持有单连接事务时调用使用外部sql池的辅助函数。
5. 失败catch删除原来的`markGrouped+publish`成功语义。预算/暂停/关停/暂时占用保持pending；坏输出或终止失败为failed；unknown保留对应receipt。更新条件含query revision、同一regroup请求和status非complete；过时任务不修改新状态。再重投影只能使其仍普通可读、不能精选。
6. 已完成主要身份事务后的可选consolidate/rematch/digest失败只记录该续任务错误，不能将已完成归组回滚为failed；现有EVENT_CONTINUATIONS队列继续承接。主事务未提交的回执不得假称业务完成。

### 3.4 综合稿与复用归属

显式`scope=composite`在createStory/createFact之前单独分支：只给关系非UNRELATED且达到上游TIE_MIN_CONFIDENCE的现有候选写mention；保存roundup decision（fact_id/story_id均null）；保存独立价值判断；不加自身事实热度、不进入consolidate、不把空旧story重定向到某个随机被提及事件。旧事件若失去有效报道，仅重建/撤下派生综述，保留历史ID与人工标题。

当前`looksLikeRoundup`是“全部候选关系ROUNDUP”，它不能代替结构scope：关系ROUNDUP可能说的是候选一侧。新分类显式scope决定query是否综合，模型关系只决定提及哪些已有事实。未知scope不等于single；可保持普通稿未知分类，但不能从历史缺字段猜综合或随意补fact。

同一修订kept且有已确认value时直接复用；材料修订保留人工归属，自动归属按当前revision重新核验并将value置null。未审新修订不沿用旧value。same-url可确定身份，但只有目标事实**已有公开精选**时才可规则标“同一新闻代表稿候选”；未精选事实的同URL重复仍须尊重已有低增量拒绝/新的价值判断。

## 4. 发布、席位和全出口

`publishArticleTx`改为：

```text
selection_candidate = existing eligibility + score/manual nomination
identityCurrent = grouping_status == complete && grouping_input_revision == article.revision
selected = selection_candidate && identityCurrent
           && (active explicit manual selected OR selection_adds_value == true)
```

这里用`==true`而不是上游历史兼容`!=false`，原因是本站旧grouped_at不可靠且用户明确禁止默认确认。没有通过新价值判断的旧稿仍可保留普通动态与详情，不能冒充新精选。

- `selected_ready_at`表示成为候选的时间，用于等待诊断；`visible_after`只在真正确认时设为锁等待后的当前时刻。去掉180秒兜底。报告截稿依旧通过report_candidates锁，确认晚于cutoff只能进下一期。
- 已被证据确认且历史确实公开的稿在离线回放重投影时保留原真实release时间；缺历史公开证据不回填虚构时间。原first_public_at/first_publication_observed语义继续保留。
- 引入上游`publication/representative.ts`，顺序为T1→核实属主组织→核实属主个人→其他，再全文/分数/最早时间/id。owner_entity_id已有列；publisherRole须经过来源配置schema准入，不能只添加SQL读取却永远无值。矿业entityIdentity复用当前词典。没有经用户定义的独立精选来源时名单为空，不照抄AI示例源。
- 加`settleSeats(tx, oldFact/newFact, self)`和`syncLedger`；对旧/新fact按数字排序取锁，同事务移旧席位remove、加新代表upsert。保持selected_state和selected_ledger真实同步，不能只改p.seat让现有客户端永久留旧代表。
- 条目级`selected`仍表示报道被选中，**网站把同事实多报道折为一张卡**；机器selected出口使用seat。不要给所有网页selectedCondition无差别加seat，否则“另有来源”和事实成员展开被削掉。
- `items.ts`分离selectedCondition与seatedCondition；`v1Items`/selected snapshot/changes、RSS精选、MCP精选及v3对应路径统一席位；all出口按其全动态契约处理，不因为加seat丢普通动态。`feeds.ts::visiblePredicate`目前自拼SQL，必须一起改。
- `notify/selected.ts`应在发送前再次确认当前selected+seat，且保留现有fact dedupe/人工silent/非历史限制。当前publish用`!previous.selected_ready_at`触发通知；候选阶段写ready_at后这个条件会漏发，应改为首次真正确认精选且未发的路径。历史修复必须silent，不能补发旧新闻通知。
- translation已按精选触发的路径需要在确认后入队；不能因为先候选已建publication而漏后续翻译。费用回执依旧复用。

## 5. 不重新评分的近期历史修复

现有`replayStoredRelations`只能作为入口草稿，不能直接运行。建议分成**只读计划、受控应用、验收**三个函数/脚本模式，默认只读；它不调用analyzeArticle/runScores/ensureEmbeddings/chatJson，也不通过伪造receipt响应绕过证据。

### 可复用证据的层级

1. **完整当前证据**：新格式grouping_decision的input_revision/manifest匹配当前材料；receipt实际已received/completed且purpose/subject/attempt/响应指针匹配；候选次序可复核。可复用身份与当时真正存在的selection结果。
2. **旧身份证据可证明，但无价值结果**：receipt.subject明确`article:<id>@<revision>`且与当前revision一致；候选原稿/修订可从当时manifest或未变更的revision历史确认，候选索引映射完整；无后续人工/撤回/归属变化。仅允许修复same-occurrence归属，value仍未知，不标完整精选确认。
3. **只有grouped_at、p.selected、membership或无revision的旧receipt**：不足以证明当前判断。列`needs_review`，保留普通可读状态；后续仅补必要归组/结构，不重新评分。不得靠created_at先后猜回执对应哪个材料版本。

当前receipt.request通常保留systemHash/userHash/userChars，**哈希无法倒推当时候选文本**；fallback的manifest也不保证所有历史主调用都有存储。读不到候选材料身份必须记录证据不足，不把今天的candidate representative代入当时C1。上游0046的批量complete逻辑在本站禁止使用。

### 安全回放的具体约束

- 计划按最近14天`grouping_decisions.id`稳定分页，记录articleId、当前revision、decisionId、receiptId/attempt、原fact/story、目标fact/story、所有输入证据、是否manual/withdrawn、预期影响和跳过原因；不是在每次worker内存变量重置后偷偷再跑一遍。
- 只有明确SAME_OCCURRENCE且矿业validatedRelation不冲突才move；SAME_STORY只是新进展，不能强并到同fact；ROUNDUP只mentions。置信度低于上游需要复核的合并，必须能找到对应成功pair复核证据，否则跳过，不以“有batch回执”免掉复核。
- 应用复用在线事务锁顺序和ProcessingPermit的process_locally/公开许可检查；不送外部模型。再次核query/候选revision、regroup_pending、人工独立/人工归属、目标story未合并，以及原事件撤回继承。不能清除既有manual修订/withdrawal holding。
- 只移动预期的当前primary/report行，保留mention/历史记录；若目标已有同稿记录，确定性合并角色和证据，不能全表UPDATE撞`(fact_id,article_id)`唯一键。`input_revision`绑定当前版本。
- 保存一条新的replay审计及原decision/receipt引用，不修改旧决定或旧模型response；更新旧新story信号、版本和digest，再重投影所有受影响成员/席位。空旧事件的跳转只在确实同事件且保留人工标题条件下进行，综合稿不能据此做跳转。
- 幂等键以articleId+currentRevision+decisionId+targetFactId，重复应用无额外账本/信号/通知；每批checkpoint持久化，停止后可续。report/selected修复按已批准规则，不让历史重组带出新推送或今日新稿。

**发布顺序：** DDL→离线计划与dry-run统计→有证据回填/身份回放→正常重投影→开启新selected条件。不能在DDL中把全部pending直接complete；也不能切新读条件后不补后台等待/恢复通路。证据不足清单明确保留，不宣称历史全部已收成一条。

## 6. 自动恢复和后台接入

现状已经有 `providers/unknown-recovery.ts::recoverUnknownOnce`，保留一次自动放行和不确定费用原记录。需要新增的是 **恢复哪个工作**：

- `admin/runs.ts`中的自动及人工release共享purpose dispatcher。group_article/group_review/group_signal对应当前article revision的group队列；embedding需由原作业/manifest恢复归组（不可拿没有articleId的embedding subject猜）；group_story/group_story_review恢复已有consolidate续任务；story_digest恢复digest。
- 用解析后的`article:<id>@<revision>`验证当前revision和人工状态；不要把group失败改成processing_state=new再走评分。
- 加上游`sweepUngrouped`语义：pending+当前analysis pass+无created/active/retry作业，3分钟后有界SKIP LOCKED扫描100条。failed不因定时扫描无限重买；由回执放行或明确人工rerun恢复。任务不可用时保留pending并暴露原因。
- 现在 `jobs/events.ts::isWaiting` 会把ReceiptUnknown也60秒重排，通常因回执保护不会重买，但会制造等待作业；有独立unknown恢复后让unknown等待receipt，不循环制造无意义group作业。
- `operations/grouping.ts`按上游计算waitingSelectedNews/groupingOverview：candidate尚未complete、等待起点取候选/当前revision/手工重组请求较晚者；超过10分钟计needsAttention，区分automatic/receipt/manual。
- 后台`runsOverview`、运行页、内容诊断页、alerts共用上述函数，避免一个显示自动恢复另一个显示永久失败。显示value=false为“不新增精选价值”，而非“处理失败”。

## 7. 现有测试要调整的位置及新增验收

| 当前文件/入口 | 需要的具体调整 |
|---|---|
| `tests/events.test.ts` provider、report helper | 当前batch缺selection且默认只回C1；改成完整候选输出并可配置value，保留专门缺号/重复ID负例。report helper需显式source时间/scope。原“same revision kept不追加模型”保留；加r1在途→r2、manual detach、pause/resume覆盖新status |
| `tests/group-evidence-runtime.test.ts` stub | 增selection和scope但保留原文/法域/阶段证据；不因新schema删掉矿业真实同事实回归 |
| `tests/event-reprint-fold.test.ts` provider及第300行后replay案例 | batch新增selection；`UPDATE receipts SET response=...`只能作为历史合成夹具，必须同时构造可验证revision/candidate manifest；新增旧revision、错candidate次序、没有pair复核、人工归属/撤回在途、目标重复行等拒绝案例；不得只测“回放能并” |
| `tests/group-revision.test.ts` | 修改材料后要求pending/value=null/currentRevision不匹配旧完成；人工membership仍保留，旧自动membership不当证据。grouped_at不单独证明完成 |
| `tests/group-withdrawal.test.ts` | 在pending、历史replay、代表替换三条路径检查事件/故事/单稿hold叠加，离开被撤事件后不复活 |
| `tests/publication.test.ts` released()与grouped_at直接UPDATE案例 | 删180秒自动公开期待；建立显式“已确认当前修订”的合成helper，别为所有article默认complete。重写early release/watermark案例为待确认不入账，确认后有序upsert；withdraw立即remove |
| `tests/publication-first-time.test.ts` | 保留first_public_at事实，不因候选转selected改成第一次可读；无历史证据不补时间 |
| `tests/automatic-feed-fixture.ts`、`foreign-automatic-fixture.ts` | structure答scope；增加group-batch/pair识别和完整答案；高分自动链需注册event workers，不能仅注册content后依赖180秒入选；非精选翻译仍零付费 |
| `tests/events-single-connection.test.ts` | 新candidate selectedReport/R背景/席位提交须单连接可完成，事务内部读取必须用同tx，防嵌套池死锁 |
| `tests/reader-rss-round2.test.ts`、`public-v3.test.ts` | 同fact多选稿网页一组、机器一席；代表变更旧remove新upsert；详情/全部保留其他报道；分页总数和游标一致 |
| `tests/home-hot-board.test.ts` | composite不建fact/热度；人工/撤回/来源同属主不重复；热点不能用pending稿补齐 |

可直接参照的上游测试：`tests/selected-news-gate.test.ts`、`news-value.test.ts`、`seats.test.ts`、`composite-scope.test.ts`、`processing-recovery.test.ts`。只迁移行为断言，替换AI行业合成例子，并接上本站权限/日期/模型fixture；上游`seats` helper将value=null视为可选的历史便利写法不能原样带入。

新增最少验收组：①归组失败超过旧180秒仍无精选/账本/推送；②无增量但普通可读；③只有未精选候选不当已读覆盖；④综合稿只mention、能独立判断阅读价值；⑤同fact更好代表替换与并发撤回；⑥新修订/新重组请求使旧模型结果失效；⑦回执一次释放后实际续group且不调score；⑧旧回执只修身份、不捏造value；⑨历史回放重复执行幂等且不通知；⑩单连接/许可收紧/暂停后恢复完整回归。

完成声明必须区分：代码实现、离线回归、最终提交full verify、正式发布、自然归组及历史修复读回。本文仅完成实施研究。
