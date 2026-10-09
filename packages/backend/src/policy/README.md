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

## 全文实际执行（TASK-0121）

`@amp/backend/policy/fulltext` 的 `runPolicyFulltext(expressionId, extractionProfile, {root,maxRequests?})` 将当前原件、完整提取、0119计划、既有网关与0120程序校验接通。每次默认最多尝试2个模型请求，是可续跑的公平参数；所有部分合法才写program_validated，semantic_verified仍为false、runtime_authorization仍为none。requestsAttempted是本轮调用尝试数，实际付费与用量以物理回执为准。

原件资源身份为sha256([expressionId,resourceUrl])，整数修订来自document_revisions.sequence，内容hash为原始资源字节hash；不借新闻修订。计划、处理控制和不可变部分检查点保存在policy schema。提示词仅industry/prompts/policy-fulltext.md；模型沿已配置policy_fulltext。已记录的真实响应可恢复检查点，原文不变的部分可跨取得修订复用；同部分的确认付费尝试在既有网关来源锁内最多两次，不因分组、取得修订或配方改变重置，unknown/busy阻止新付费。

`setPolicyProcessingPaused` 使用控制版本、原因及操作人，并写既有审计。当前原件、来源权限或处理控制变化会阻止候选写回；响应和费用回执仍保留。该内部端口尚未接管理页面/自动生产调度。

后续阶段可用`readPolicyFulltextRun(runId)`取得当前program_validated运行及待重新核对的output；`withCurrentPolicyRun(run, callback(tx))`提供同一原件/许可/控制CAS事务。`readPolicyResponse({receiptId,attemptId})`从既有回执端口读取精确物理响应、请求manifest与knownUsage；`settlePolicyResponse(tx,receipt,accepted)`支持四个policy用途，accepted=null只核对不改变旧结算。后续阶段另用自己的派生检查点表，不混入fulltext_parts。
