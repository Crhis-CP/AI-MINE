# 已收到真实模型响应但缺 usage：费用与完整性的边界

2026-10-15，只读研究当前统一分支（读取基线 `de50f4293596986cb799f45083fdcdeae24f267e`）与AIHOT固定版本 `540c47788eb6475c7ad8819d36733eda81dca20d`。未改产品代码、运行真实模型或访问生产。

## 核心裁决

**HTTP响应已保存、真实物理attempt绑定可证、内容通过业务校验，仅usage缺失时，应继续业务；费用按实际已知信息记账，缺项提醒，不能称“调用结果未知”或阻断后续付款。** 这是Owner批准完整采用AIHOT费用机制后的目标。若没有实际金额/可计算单价依据，不补造0元或确定费用。

固定上游的证据：

- `providers/llm.ts` 把 `json.usage ?? null`与response一起交给paidRequest；随后只对模型content做schema校验。合法内容直接返回 `usage:null`，没有usage准入检查。
- `providers/receipts.ts::paidRequest` 收到响应保存为received，usage可以null；已有received/completed免费复用。HTTP已返回但内容不能解析时，llm调用 `rejectReceivedResponse`标failed，后续可按原任务重试，不要求token证明。
- `jobs/content.ts::afterFailure`对ModelOutputError最多3次输出失败，保持有界；并非网关因usage缺失无限自动重发。上游法规完整性业务不存在，不能用其没有法规校验作为删本站法规完整性证明的依据。

永久源码：[上游llm.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/packages/backend/src/providers/llm.ts)、[receipts.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/packages/backend/src/providers/receipts.ts)、[jobs/content.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/packages/backend/src/jobs/content.ts)。

## 本站要退出的旧费用条件

以下函数位于 `packages/backend/src/`。删掉usage条件不等于删掉响应绑定和内容校验。

| 接点 | 当前具体行为 | 确定目标 |
|---|---|---|
| `providers/receipts.ts::newsReceiptBlocker` | 除pending/unknown，还把response存在但usage缺token的其他逻辑key判成ReceiptUnknown | 删除仅由缺usage触发的分支；真实pending/unknown及跨路由绕过未知结果保护保留 |
| `translationBlocker` | observation绑定received attempt只有knownTranslationUsage才不阻断下一段 | 对已证实绑定的received响应不再要求usage；attempt_id缺失/伪造、真实unknown/pending仍阻断。前份recovery研究的“后继成功必须known usage”随本次Owner费用裁决更新为“后继真实绑定response成立”，不能再用token作恢复门槛 |
| `checkPolicyReceipts` | 同来源任一received attempt缺usage，阻断所有下一policy调用 | 只保留真实在途/结果未知屏障及一次释放逻辑；缺usage不得把整个法规来源暂停 |
| `paidRequest`通用bad-output计数 | 同receipt stored response中proven!=stored（usage不足）直接复用坏响应，不许有界重试 | 按真实物理响应/尝试和已有输出失败上限控制，缺usage的坏输出同样计入次数，允许上限内重试；缓存reuse不增加实际请求计数 |
| `settleTranslationResponse` | received坏输出缺usage时保留received，不能启动下一次；`canReplaceTranslationResponse`截断分片要求usage | 坏输出必须仍记录拒绝与次数，但允许有界下一次；长度截断只有真实绑定finish_reason=length、可确定拆分计划才拆，去掉usage条件；保留只拆一次/子段限制 |
| `settlePolicyResponse` | accepted=false仅knownUsage时把逻辑receipt标failed | 真实当前响应被内容校验拒绝时可标failed以承接既有有界重试，物理attempt保持received、原usage/费用缺项不篡改 |
| `policy/interpretation-store.ts::saveInterpretationStage`、`vision-store.ts::saveVisionStage` | settled存在但knownUsage=false时不保存stage | 成功settle证明真实当前attempt即可保存accepted/rejected checkpoint；仍校验inputHash、结果schema、原材料绑定、run当前性 |
| `policy/interpretation-runtime.ts::currentFulltext/call` | currentFulltext读回、已保存stage复用、历史stage响应复用均要求proof.knownUsage | 保留proof存在/attempt一致/purpose/manifest/parts匹配；去掉knownUsage作为blocked_unknown原因 |
| `policy/vision-runtime.ts::call` | saved checkpoint与新响应都因knownUsage=false停止 | 同上；页码、图片hash、PDF资源hash、数字/表格/附件完整性、模型身份不动 |
| `policy/fulltext-store.ts::saveFulltextResponse` | 已把真实accepted parts写库，再返回knownUsage；fulltext-runtime recover忽略该返回值 | 不要误称“缺usage全文一个part也存不了”。单批全部通过可能program_validated；多批下一请求会被checkPolicyReceipts拦、后续interpretation也拦。返回值改成真正保存/当前性结果，账务可另附诊断 |
| `readPolicyResponse`的knownUsage | 同一对象把真实response证明和计费充分性混在一起 | 可保留该属性作计费展示，但不让调用者把它当内容/attempt真实性。更清楚是命名为usageReported/usageComplete，所有业务准入引用逐个迁走 |

`policy/model-evidence.ts::policyModelQualification`本身**不依赖usage**：它校验真实requestedModel/reportedModel、configurationHash、registered connection身份。它是保留边界，不能随本次费用调整删掉。

## PolicyPartLimit不能只删gate不改计数

当前 `checkPolicyPartLimit`查询a.status=received，然后**仅knownTranslationUsage为真才算一次**；缺usage响应不计入2次。去掉来源usage屏障后，这会使没有usage的坏输出不断换批次/重组时绕开每part两次限制。

改为按现有不可变part ID对应的**真实物理发送attempt ID**计数，usage、金额、成功与否不作为是否计数依据：

1. 单次request包含多个part时，每个part记该attempt一次；同一part ID重复出现不能多计，使用DISTINCT attempt.id。跨receipt/model/重组请求仍聚合相同part身份。
2. 已received（包括缺usage、坏输出、截断）必须计入；已发送后unknown也计入；在途已预留的attempt要占位，防并发超买。HTTP明确拒绝但实际发出的请求仍是请求，不能因为未计费就不计数。
3. 只有明确记录为**发送前**拒绝的usage_blocked/input_changed/configuration_changed等不计真实发送；不能从null cost或缺usage推断未发送。无法证明未发送时保守占位。
4. 在现有policy-source锁/claim事务内检查并创建attempt，避免两次并发都看见“只1次”而各自发出第三次；真实新attempt成功建立才消耗额度。缓存复用走现有reuse分支，不新建attempt。
5. 阈值2继续保持为本任务的法规part重试上限，不借本次费用语义研究擅自提高。第一次unknown后允许一次自动重试时，前一次仍占1、恢复次占2；第二次unknown继续人工，不把旧unknown扣掉再买第三次。
6. 若现有数据库尚不能区分attempt创建和真实发送，应在网关现有failure_kind/发送前guard上明确界定；不要为修usage问题制造假的“received”或“未计费”状态。

## 必须保留的法规与回执证据

- response来自receipt.response_attempt_id对应的当前真实attempt，attempt.receipt_id/ordinal/status/response与receipt一致；不存在的attempt、旧序号冒充、只凭调用方flag不可通行。
- immutable input manifest、partId/sourceHash/recipeHash、当前revision、原件/PDF/渲染页hash、所有页和附件覆盖、原文数字/结构/引文一致、semantic verify结果；缺页/错数字/坏JSON仍不完整。
- 当前许可和runtime control在发送前/写回时重核；权限收紧或材料变动不发布旧结果。
- requested/reported model与配置身份、实际模型能力和质量资格；模型身份缺失仍是证据缺口，和usage缺失是两回事。
- 真正未收到结果、placeholder超时、传输后连接断开继续unknown；旧unknown费用保持未知，只按既定30分钟一次自动放行，不利用缺usage改革重复放行。

## 受影响测试与必要新断言

| 测试 | 应改和必须保留的部分 |
|---|---|
| `tests/policy-gateway.test.ts` “missing usage blocks new payments...” | 改为有效response可免费复用、下一合法stage继续；原usage仍null、缺费用提醒可见；pending/unknown、许可撤回和真实attempt证明负例保留 |
| `tests/policy-fulltext-runtime.test.ts` “unknown usage receipt blocks the next part...” | 改为缺usage不阻下一part，已完成part不重复买；新增两个缺usage坏响应也耗尽part上限，重组/重跑不买第三次 |
| `tests/policy-interpretation.test.ts` “unknown usage stops the source and missing provider model identity...” | 拆两项：缺usage可完整跑且checkpoint复用；缺reported model仍modelEvidenceComplete=false，不得误修成通过 |
| `tests/policy-vision.test.ts` “...no usage blocks further payment” | 缺usage部分改继续；缺cells/数字/检查项/页码/附件的完整性负例原样保留 |
| `tests/translation-checkpoints.test.ts` reset/length/no-usage-bad合并测试 | 拆开：真实reset仍unknown等待；无usage坏输出按真实尝试上限重试；真实length只按一次替换规则，不依usage授权；完整合法无usage两段都可完成 |
| `tests/news-receipt-barrier.test.ts` | received+绑定+无usage不阻下一合法请求；真实unknown、改model/attemptTag绕unknown仍必须拒绝 |
| `tests/receipts.test.ts`、`usage-monthly.test.ts` | 次数包含无usage实际请求；未知/未定价费用保留，不凭继续业务推算0费用；自动释放次数和并发CAS不变 |

此结论更新前份 `recovery-research.md` 中依旧使用knownUsage作为后继响应通过条件的建议：现在应以**真实响应绑定+业务有效性**判定运行状态，usage只影响费用信息是否充分。只有本次Owner已明确的费用规则改变这一部分，不能顺带删法规完整性或原未知结果屏障。
