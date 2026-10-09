# 法规原件基础

`recordPolicyOriginal` / `readPolicyOriginal` 是内部私有端口，没有 HTTP、公开模型或任务入口。
身份依次为文书、来源法定版本、语言表达、站内取得修订；标题不参与文书身份。未知文号按来源与官方 URL 退化，未知法定版本键明确保留 `unverified`。
原件和附件 bytes 存既有 PostgreSQL 的 policy schema，实际字节与有序清单各自计算 SHA-256；当前头可变，历史只追加，A→B→A 也保留第三个修订。
现仓库没有可用的 storage 保存/读取公开接口；`stored_files` 仅余过期删除且列为删除候选，`media/images` 是可变图片缓存。原件因此复用现有数据库事务与备份能力，避免恢复旧缓存或新造对象存储服务。
写入和读取均复用来源当前权限与共享锁；只在 policy schema 写业务数据，不依赖新闻分析状态。没有公开角色权限。
`pending_extraction` 只证明登记了许可内的原始字节，不证明目录、正文/表格/图件、中文或法律语义完整；决定性缺项和容量状态保持独立，不给予 complete。
取得与 HTML/PDF 提取在 TASK-0117，文书识别在 TASK-0097、公开契约 TASK-0098、基本事实页面 TASK-0099；原件与提取端口不调用模型、不建队列；全文运行器见下，尚未自动启用生产调度或来源。

TASK-0117 的 `acquirePolicyOriginal(input, profile, get?)` 复用受限取页和逐用途许可，保存原 bytes 后返回上述原件标识；显式选择器和工程容量在 profile，不借新闻篇幅/附件规则。`extractPolicyOriginal(expressionId, profile)` 返回并缓存 `{revisionId,state,gaps,resources}`，资源内为有序节点、页码/坐标/HTML与缺口，存入追加式 document_extractions；当前头或许可变化拒绝旧结果写回。
`extracted` 仅表示配置范围内提取出了节点，不是身份、全文中文、语义或公开资格。PDF 文字层保留版面/表格未核验缺口，空文字页和内嵌图件/附件另列；没有闭合目录时总状态始终 incomplete。后续任务必须同时检查原件与提取状态，不能用节点总数代替完整性或模型核验。

TASK-0120 的纯 `validatePolicyFulltextCandidate(plan,candidates)` 消费 0119 的精确计划与扁平逐 part 候选数组；`PolicyPartCandidateSchema` / `PolicyPartCandidate` 是严格候选边界。缺项、重复、错哈希、非逐字引文、字符损坏和确定性不变量变化不给 assembled，独立合法部分保留在 accepted；只在全覆盖时按资源与计划顺序装配块，不假定一个 nodeId 只有一个 part。
校验仅证明相对计划的结构与已识别文字标记一致，不能证明事实含义、否定/情态、完整语义或来源合法身份。输出固定 semantic_verified=false/runtime_authorization=none；运行器必须另核真实回执、当前原件、许可和控制状态，随后仍需 AI-19/21。

TASK-0101 的 内部文件 `policy/interpretation-runtime.ts` 提供 `runPolicyInterpretation(fulltextRunId,{root,maxRequests=2,related?})` 和 `loadPolicyInterpretation(fulltextRunId)`。执行器复用0121当前全文/CAS与0100网关，不注册队列、不切模型。AI19逐原文组核对并最多6子输入归并，AI18/20一次产出候选，AI21每个结论面对所有原文组；限定只改写一次并重新完整核验，反证/缺组/无支持阻止通过。候选日期用现有严格日期解析核对字面组件；不猜日/月歧义、时间或时区，关系目标须唯一且有实际输入依据，comparisons固定为空。
`partial` 表示本轮调用份额已用完，可从实际回执/检查点继续；semantic_verified/semantic_failed/excluded/uncertain为已到达的候选结果；blocked_unknown/waiting_receipt/provider_unavailable/invalid_output/stale/blocked_capacity不当作成功或摘要降级。阶段引用限该次真实parts/children/root-quotes；恢复也核对真实receipt输入与响应，不按序号猜attempt。被拒的同一阶段输入不自动再购买；暂停途中已收到的相同输入可在明确恢复后免费重验。
可信读取返回run、candidate、claims、逐组verification、recipeVersion/contentHash和模型证据。candidate.evidence的part_id经run.plan.parts定位resourceUrl/nodePath；私有modelEvidence含实际receipt/attempt/service/请求模型及provider报告模型，models只取实际报告值，报告缺失则modelEvidenceComplete=false。semantic_verified只表示本链模型核验矩阵完整通过，不是法律权威或Owner质量资格；publication_authorized永远false。0122另行核质量资格并写公开投影，0123复用既有队列接调度。

## 全文实际执行（TASK-0121）

`policy/fulltext-runtime.ts` 内部模块的 `runPolicyFulltext(expressionId, extractionProfile, {root,maxRequests?})` 将当前原件、完整提取、0119计划、既有网关与0120程序校验接通。每次默认最多尝试2个模型请求，是可续跑的公平参数；所有部分合法才写program_validated，semantic_verified仍为false、runtime_authorization仍为none。requestsAttempted是本轮调用尝试数，实际付费与用量以物理回执为准。

原件资源身份为sha256([expressionId,resourceUrl])，整数修订来自document_revisions.sequence，内容hash为原始资源字节hash；不借新闻修订。计划、处理控制和不可变部分检查点保存在policy schema。提示词仅industry/prompts/policy-fulltext.md；模型沿已配置policy_fulltext。已记录的真实响应可恢复检查点，原文不变的部分可跨取得修订复用；同部分的确认付费尝试在既有网关来源锁内最多两次，不因分组、取得修订或配方改变重置，unknown/busy阻止新付费。

`setPolicyProcessingPaused` 使用控制版本、原因及操作人，并写既有审计。当前原件、来源权限或处理控制变化会阻止候选写回；响应和费用回执仍保留。该内部端口尚未接管理页面/自动生产调度。

后续阶段可用`readPolicyFulltextRun(runId)`取得当前program_validated运行及待重新核对的output；`withCurrentPolicyRun(run, callback(tx))`提供同一原件/许可/控制CAS事务。`readPolicyResponse({receiptId,attemptId})`从既有回执端口读取精确物理响应、请求manifest与knownUsage；`settlePolicyResponse(tx,receipt,accepted)`支持法规各阶段用途（含policy_vision），accepted=null只核对不改变旧结算。后续阶段另用自己的派生检查点表，不混入fulltext_parts。

## 自动取得与发现依据（TASK-0123）

`capturePolicyMaterial(sourceId,materialId,get?)` 消费来源显式 policyProfile 与 content 真实材料引用，取得唯一标题/身份标识等字段，再调用原件取得端口。无 profile、普通新闻标识或缺字段不能通过身份门；全文未获准时只登记无正文基本事实。取页时间不能代替首次发现时间。

`readPolicyMetadataObservation(expressionId)` 是内部可信元数据端口，返回当前原件可回读字段依据，以及 material_discoveries 的真实最早 discovered_at；无依据返回 null。其结果供 publication 独立基本事实资格判断，不公开私有源配置、许可或模型字段。两张证据表只追加，workflow 表供独立 policy 队列续跑；HTTP 读取不会调用取得或排队。


`advancePolicyMaterial` 每次推进一个有限阶段，独立 policy 队列经现有 `jobs/content` 组合入口转发。初始取得先尝试独立基本事实发布，完整输出仍只交可信发布端；partial续跑，未知回执与异常停止自动付费，同 URL 按来源显式 recheckMinutes 复查。视觉extracted后须重新通过完整全文计划，不能用视觉结果替代目录完整性。新调度不改新闻成功计数、首次材料入库或公开读取路径。

## PDF视觉候选（TASK-0126）

内部文件`policy/vision-runtime.ts`提供`runPolicyVision(expressionId, extractionProfile, {root,maxRequests=2})`；只在worker明确调用，不注册新队列或新增包出口。`partial`可按既有队列续跑；`extracted`证明全部页面的结构候选与原页复核均齐全；`incomplete`带具体缺口；`needs_configuration`表示缺明确视觉路由。容量、未知用量、busy、暂停、原件/许可变化及拒收分别保留blocked_capacity/blocked_unknown/waiting_receipt/paused/stale/invalid_output，不自动降分辨率、截断或重购拒收答案。

渲染沿固定PDF.js的[官方Node canvasFactory API](https://github.com/mozilla/pdf.js/blob/v6.4.299/examples/node/pdf2png/pdf2png.mjs)，实际锁定canvas版本也进入配方；每页按scale=3输出PNG，页数、文字定位、每次图件出现坐标、链接与内嵌附件来自原bytes。逐页识别后再次发送原页及相邻页核对完整文字、数字、每个单元/合并跨度、图件、阅读顺序和跨页关系。表格矩阵无重叠/无空洞，真实文字层逐项绑定、纯文字页字面字符/数字守恒；跨页条款/表格只有两侧核验通过才连接。重复图件位置不去重，不用总数近似集合。内嵌文件、未定位的图形操作、未知附件地址/页码、复杂图形/公式等无法无损表达的部分保持缺口。

复用`withCurrentPolicyOriginal({snapshot,expressionId,controlVersion},callback)`的原件/许可/人工暂停CAS；全文CAS继续转发此公共内部实现。渲染页和视觉阶段存policy私有表；`policy_vision`仍经同一网关与paidRequest，每张PNG的实际hash/长度/尺寸/配方、原PDF material及完整传输body的hash/字节数绑定物理回执。缓存恢复严格比较实际请求manifest、system/user hashes与实际响应，不按receipt序号推测attempt。图片不进入HTTP公开投影。

`loadPolicyVision` / `loadPolicyVisionProof(runId)`只读重放当前原件与真实回执，零模型调用、零候选写入。0117读取完整视觉产物替换该PDF的未核版面节点，并仅在完整目录证据齐全时关闭直接PDF目录；其他资源缺口仍阻止全文计划。AI17 plan.context的visualRunId/visualContentHash绑定实例，recipeVersion另纳入稳定视觉配方；0101重验视觉结果，并把实际AI23模型证据加入全部调用集合，0122按精确内容配方核Owner资格。此层固定semantic_verified=false/publication_authorized=false，扫描识别不等于全文语义或质量验收。

最后需要部署端明确选择`POLICY_VISION_MODEL`（或已审计`models.policy_vision`设置）为已登记且支持视觉的模型。没有默认文本替代。选择`default`时还须`LLM_VISION=true`且该实际模型/端点确实支持图片；命名预设使用已有对应凭据通道，不读/变更现有秘密。真实样本的数字、表格、扫描图件能力资格仍由Owner最后验收，不因本地假provider通过而授予。没有新增供应商、依赖、真实付费调用或生产启用。

## 公开投影与读取（TASK-0122）

`publication/policies-publish.ts` 的 `publishPolicyPublication({expressionId,fulltextRunId?})` 只消费当前持久物证、全文检查点及可回读的0101语义/实际模型依据。基本事实来自0123取得字段；完整解读须匹配 `policy/quality.ts` 中真实Owner审阅记录的来源、语言、完整配方、模型集合与期限。新安装不附任何资格，测试记录仅存在隔离库。`policyPublicationControl(db?)` 在写事务内锁独立法规公开开关；`setPolicyPublicationPaused` 及逐文书 `setPolicyPublicationState` 要求原因、操作人与既有审计。读请求不看采集/处理/公开暂停，也不写库、排队或调用模型。

公开层为随机代理ID与严格0098 DTO；当前许可、到期、自动排除和人工撤回对列表、详情、正文、历史、搜索与汇总逐次生效。`policyPublicVersions` / `policyPublicMembers(editionIds)` 给报告使用精确仍合格的公开版本及真实首次发现时刻，不以读取时间补齐。正文游标区分表达、修订和明确历史选择；列表游标只绑定筛选及排序锚点。报告继续读固定修订时，成员资格变化或当前报告换版返回409，不留下已撤回成员的标题或摘要。跨文书脉络由下述0128可信关系写口接入，读口不推测关系。

## 可信关系与脉络（TASK-0128）

`publication/policy-relations.ts` 的 `policyRelationshipCandidates(fulltextRunId)` 只给现有0101处理最多5个同法域、原文明示官方单对象URI与逐字文号、当前独立身份物证合格且唯一的候选。实际引文与其同一链接href由`policy/references.ts`统一核对，前缀相似URL、集合页和歧义不接受。发布者仅在语义和当前Owner质量资格通过后写关系；不能由传入qualified标记或模型ID自行公开。

确定性关系校验版本进入`policyInterpretationQualityRecipe(modelRecipe)`，与付费prompt/input hash分离；原模型配置及已有回执不变，资格复核可免费重放。模型没有旧法原文时不生成新旧法对比。

公开导航按仍有效的两端版本和资格即时构图，来源完整解读失格就移除其法定关系；目标如只剩独立基本事实，仅使用其当前基本标题/文号，不沿用旧解读。每个参与文书拥有永不回收的随机锚点ID，连通组件采用最早有效锚点为当前链接，旧锚点URL仍解析其当前组件，失效桥不会继续串联不相连文书。线程只保存阅读关系，没有统一法律状态。

## 物理模型资格（TASK-0140）

`model-evidence.ts`统一从`readPolicyResponse({receiptId,attemptId})`的当前实际响应和对应物理快照读取service、requested/reported model、configuration_hash、connection_id/revision。资格键`pmodel1:<sha256>`绑定前四项；registered服务的ID还须与实际快照ID相同且有正修订，环境接入允许ID/修订为空但不能缺配置hash。任一实际模型证据不完整，候选仍可保存和免费重放，但`modelEvidenceComplete=false`，不能新增完整解读。相同reported名不会跨端点、JSON/视觉能力、额外参数或不同registered ID借用资格。

`models`是上述资格键集合，不再是供应商报告名称的集合；安装工程入口只接受新格式，历史字符串记录不修改或补造。独立`policyInterpretationQualityRecipe`追加`physical-model-1`，不会改变付费prompt、输入或处理配方。视觉输出的内容hash保留原五字段模型身份投影，新增物理配置证据另外核验；因此资格规则升级不改变已绑定的视觉→全文内容身份。

公开质量窗口新增可空`binding_version`，历史为null。所有公开读取与保留complete分支要求当前版本、期限及用途；旧窗口即时只给独立基本事实，旧正文和模型结论停止公开。metadata重试复用同一当前原件已存的独立基本事实，不创建更新的占位版本遮住原内容。新资格安装并免费重验后更新资格引用，首次发现和原公开时间不刷新，历史资格ID不会伪造为新资格。测试中的评审记录仅为隔离合成数据，不是实际Owner批准；没有生产资格迁移或真实模型调用。

部署影响：这里只证明读取规则，不推断生产是否已有旧式完整发布。部署前后可由获准的只读诊断统计仍关联`binding_version IS NULL`且未撤回的complete投影；这些内容在新代码下只显示其独立基本事实。没有按模型名自动推导配置hash的迁移，也不会自动重跑模型以填补证据。
