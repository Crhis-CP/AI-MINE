# translate_body 未知结果自动放行后的续接研究

基线：统一分支 `codex/site-major-upgrade`，`de50f4293596986cb799f45083fdcdeae24f267e`，2026-10-15。仅阅读当前代码和测试；没有修改产品代码、调用真实模型或访问生产。

## 结论

当前存在三个独立阻断点，必须一起处理：

1. **释放后未定向排翻译任务**：`admin/runs.ts::autoReleaseUnknownReceipts` 的ARTICLE_STEPS不包含translate_body，回执可被释放却`requeued=false`。
2. **同段重试成功后旧attempt仍阻断下一段**：`providers/receipts.ts::translationBlocker` 从observation取历史attempt.status；自动释放故意保留旧attempt为unknown，因此下一段遇到它又报unknown。只改receipt.status或重排任务不能解决。
3. **整篇三次计数可能挡住恢复**：`editorial/translate.ts::bodyTranslationSpent` 和translatePending SQL两处把attempts≥3拒之门外。次数按每次正常返回累计，包括partial/cooldown/capacity，不是实际付费失败次数。unknown抛出本身不会增加该计数，但先前留下的计数会挡恢复。

**原unknown费用必须继续保留unknown。** 自动放行是一次追加尝试授权，不是供应商未计费证明。不能改旧attempt.status为failed、调用settleUsageAttempt(...failed)、把observation.known_unbilled设true或删除旧observation来通路。

## 可逐步复现的现有流程

| 步骤 | 当前函数 | 实际行为 |
|---|---|---|
| 1 开始段0 | `runBodyTranslation`→`beginTranslation` | 创建当前revision+recipe+sourceHash目标；读取有效complete checkpoints；初次请求带继承observations |
| 2 发送后连接断开 | `paidRequest` / runtime catch | receipt R状态unknown，attempt R1状态unknown；`recordTranslationFailure`存segment0 unknown，绑定真实attemptId；异常向上传播，整篇counter不增加 |
| 3 30分钟恢复 | `recoverUnknownOnce` | 在R1.error记录UNKNOWN_AUTO_RELEASE_NOTE，R1.status/费用仍unknown；R.status改failed，audit记录billed:null；当前翻译分派缺失 |
| 4 手动/其他触发再次运行同请求 | `paidRequest`的existing failed分支 | translationBlocker排除当前logicalKey，因此R允许创建R2；R2成功，saveTranslationSegment替换segment0 checkpoint为complete并保留R2指针 |
| 5 请求段1 | `translationBlocker(scope=article:id@revision)` | 段1逻辑key不同；observations仍有R1 unknown。SQL `coalesce(a.status,r.status)`优先取R1，忽略R当前成功，直接返回unknown；段1尚未真正发送 |
| 6 错误传播 | runtime catch | 会把这条阻断错误记到正在处理的segment1，引用R1；因此不能假定segment记录里的receipt.subject必属于该segment。后续运行依旧卡R1 |

`translationObservations(body)`会跨recipe读取该材料修订的segment receipt/attempt；`ai.translation_receipt_observations`还保留已经不在最新segment行里的历史尝试。仅改segment0为complete或清segment1错误无法移除真实阻断源。

## 最小完整修复接点

### A. 按真实物理尝试区分“费用未知”与“运行已获准继续”

修改 `translationBlocker` 的查询，附带observation对应attempt的error、receipt当前状态/attempt序号、response_attempt_id及对应后继物理响应信息；不要只靠current receipt.status做判断。

对历史unknown observation，允许不再阻断下一段的最窄条件为：

- observation确实绑定同receipt的真实旧attempt，不能是attempt_id=null或序号推测；
- 该旧attempt具有准确自动放行标记，且有对应自动release审计；
- **同一receipt**存在序号更大的、当前response_attempt_id绑定的received物理响应，response与receipt.response相等，usage可核，且当前receipt不处于新unknown/pending；
- 当前请求仍是同article+revision的翻译范围。此时只跳过该历史observation的运行阻断，费用与旧attempt原样保存。

同段原logicalKey的第一次授权重试原本通过自身排除，无需把旧unknown改状态。后继再次unknown必须照常阻断，并因同receipt历史已有自动放行标记而不能再自动释放。后继response无usage或历史response未绑定，不满足上述条件。

**不要做以下宽松处理：** 遇到任意R.status=completed就忽略全部旧尝试；忽略所有带自动标记的unknown；跨模型换一个logicalKey以规避原unknown；把旧attempt的费用并入R2当成已知实际费用。改路由/输入导致logicalKey改变时，保留现有未知屏障；若要恢复，需精确复用原不可变请求身份/模型快照，不能自动猜一个新请求。

### B. release和定向任务在同一事务提交

在 `admin/runs.ts` 的自动和人工恢复分派增加 `translate_body`：从真实receipt.subject解析 `article:<id>@<revision>#<segment>`，核材料revision仍匹配，再enqueue `QUEUES.translate`。不修改processing_state，不调用queueProcessing(analyze)，不重新评分。

恢复队列保持article singleton；无当前材料、已新revision、明确人工停用时不发起新翻译。worker仍必须执行`prepareTranslation`，重新核当前selected/public/full、来源许可与人工撤回。许可/状态检查不是在恢复器里跳过的“旧任务特权”。release审计应区分真正排入新任务、已有有效singleton、无需续接，不能把队列拒绝写成恢复成功。

### C. 恢复不能被整篇三次计数吞掉

本轮最小改动建议保留translation_attempts审计行，不清零历史；新增一个共享的**当前修订存在可继续的翻译恢复证明**读取判断，供translateArticle入口和translatePending筛选共同使用。证明必须来自translate_body的精确自动/人工释放记录、真实attempt和当前revision，不是传入一个任意布尔force。

- 对已有合法恢复证明的当前修订，允许穿过整篇attempts≥3门槛，进入检查点/回执层继续；实际是否能付费仍完全由同logicalKey一次释放、maxRejectedOutputs、cooldown、未知屏障决定。
- 没有恢复证明的旧“三次普通失败”行为本轮可以保持，避免扩大范围；对已经complete的段零付费复用，对尚未开始的段正常处理。
- 两处门槛必须共用同一判断：只改translateArticle而不改scanner会丢失崩溃后的自动续接，只改scanner则队列到达后仍返回attempts_exhausted。
- 单纯预算等待、关停、retry_cooldown、text_limit/pending_capacity不应记成新的“翻译失败”并耗尽整篇次数。当前计数若继续保留，需把这些正常等待与实际失败分开；不能再用“调用了3次函数”代替“付费坏输出耗尽”。

后续彻底按上游对齐时，可将整篇次数仅作观测，由每段真实回执控制重试；但这不是修本次未知恢复所必需的新框架，不能为此先重写翻译存储。

### D. checkpoint和worker结尾

`runBodyTranslation`已有正确的原材料CAS、recipe/sourceHash约束、已完成段跳过、精确responseAttempt绑定；保持这些机制。修完A后，同段R2成功将保存complete，随后段1才能真正发送。

`finishTranslation`只有全部必要叶子通过才complete；partial保留真实部分状态。成功后worker执行publishArticle；已选外文恢复正文不重新评分。当前worker将所有partial一律throw；建议至少区分可恢复等待与text_limit终止部分状态，避免恢复成功后仍因容量边界反复消耗整篇次数。本文不要求为未获完整译文伪造complete。

## 复用现有夹具与必要回归

| 文件 | 现成能力 | 本次新增/调整 |
|---|---|---|
| `tests/translation-checkpoints.test.ts` | mode=reset真实本地断连接；两段HTML、mode=stop成功；hits计数；cool辅助；recipe/revision变化 | 主回归：两段，段0首次reset→31分钟release→段0R2成功→段1真实发送→translated；总物理请求应为3，重复运行0新增；旧R1仍unknown/费用unknown/known_unbilled=false |
| 同文件unknown测试 | 未释放的重复运行不得自动再买 | 保留这个断言，并加入“释放前不重发、释放后一次”；不能把测试改成所有unknown立即可重试 |
| `tests/receipts.test.ts` | `unknown paid requests wait 30 minutes...`有并发恢复、第二次unknown、原费用不消失；analysis五步骤定向重排 | 加translate_body真实subject，断言content.translate队列而非content.analyze；同回执并发释放合计一次；第二次unknown跨31天仍不自动释放 |
| `tests/translate.test.ts` | 当前3次耗尽测试、scanner keyset、真实公开判断 | 原普通耗尽保持；新增attempts=3但有精确恢复证明可续、scanner也能发现；伪造/其他文章/其他revision恢复记录不能豁免 |
| `tests/translate-shutdown.test.ts` | SIGTERM在响应到达前后、paid response复用、计数不消耗 | 自动release后R2已保存、段1前关停，重启复用R2再继续；不重新发段0、不丢原unknown费用 |
| `tests/unknown-release-race.test.ts` | 人工版本CAS，旧确认不能释放新unknown | 复用并发模式：release与revision/手工暂停/后继unknown交错，恢复不越权 |
| `tests/news-receipt-barrier.test.ts` | 改模型/attemptTag不能绕未知账 | 增翻译场景：只有旧自动标记但无后继成功response时，新logicalKey不能穿过；成功原key后下一段可以继续 |

还应覆盖：R2成功但usage缺失仍不放下一段；response_attempt_id丢失/指旧尝试仍不放；段1曾因R1屏障记unknown但没真正发送，恢复后只买段1一次；已撤回/不再selected/全文权限收紧时不发翻译；同revision换recipe不伪造新物理尝试；未知费用始终在月度对账中可见。

本研究未执行上述回归；实现后完成针对性测试和正式整合验证，再判断上线恢复是否完成。
