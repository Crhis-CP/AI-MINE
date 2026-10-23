# 国别异常诊断与摘要预览绑定核对

TASK-0410，代码基线`6d08c14b388f75befd75e297ec17227661527c92`。本次只使用已进入development诊断的指定材料；未读取未揭盲正文、连接生产、访问秘密或调用真实模型。

## 结论

- D04双国官方稿的国别结果缺失仍有原始导出支持，但本地记录不足以复现具体拒绝原因。本次不改地理解析、字典或引文校验，不声称已经修复D04。
- D01/D06两条既有摘要预览与保存原件、回执及历史绑定一致；本次重新计算正文和证据文件哈希全部匹配。没有生成发布请求，未证明当前生产状态仍与旧快照相同。
- 现有国别回归7项通过；有效多国、作用地与总部/背景区分、partial/unknown、过期绑定及公开读取权限均保持。工程回归不是D04原始回答重放，也不证明模型真实识别质量。

## D04证据到哪里为止

有效位置是`.verify/optimization-plan-20261022/details.json`的`official_cases`，快照时间`2026-10-22T22:28:04.336594+00:00`，查询exit=0、error=null。`geo_case`本身查询另一矿山且返回空集合；`case-trace-corrected.json`的case不含D04，不能拿它补出不存在的字段。

| 已公开诊断材料 | 已保存结果 | 仍缺内容 |
| --- | --- | --- |
| `lhymy0xkp58y03qhemoad4z1o`，阿根廷与智利矿业合作官方稿 | unknown / invalid_geography_evidence，jurisdictions与assignments均空，bodyBudget=22000 | 被拒绝前的原始geography回答、结构化回执身份、实际segments |
| `jv4uctsjpht0ml28k1da33qhe`，矿业投资法改革官方稿 | 同上；当时已经精选也未产生有效国别 | 同上 |

仅检查`geo-and-holdout.json`的geo字段是否存在，结果不存在，未输出其他字段或留出集内容。后续通过既有导出脚本确认地理专项查询针对D03，不再扩大查找范围。当前本地计算的geographyRecipe与两条旧结果均为`cb96a6a74fd59e7004f1e439ea51327bc39d6c27d3d1d710248f52a79fef71a4`；不能把本案解释为配方哈希变化。

当前`editorial/geography.ts`先校验候选结构，再分别校验code、role、segment、逐字quote、mention、明确国家别名和边界；只有合法assignment保存到analysis。`invalid_geography_evidence`不是明确的“标准化错误”分类。按这一路径，空assignments与该reason可由全部分配候选被拒绝产生，但无法从已丢弃的候选反推具体字段。现有`editorial/analyze.ts`将实际结构化输入的segments及bodyBudget用于同次校验；标题含两国也不能替代每条作用关系的证据。

最小补证为两条材料各自同一修订的：结构化回执ID及原始响应中geography对象、当次请求segments/complete_material/bodyBudget，以及能对应材料修订、sourceHash、提示/配方版本的绑定。可优先只读提取既有回执，不重跑模型；不能仅凭当前网页重建旧请求。取得后逐条定位被拒绝字段，再决定是否需要红绿修复或后续提示校准。本次没有可证实的确定性代码缺陷，保留unknown，不放宽引文约束。

## D01/D06本地重核

原预览仍为TASK-0397的offline_preview，历史绑定时点`2026-10-22T23:16:49.492438+00:00`。程序只选择D01/D06两个已声明development ID，未将其他原件正文送入模型；对正文只计算哈希、查验既有引文及比较预览，不输出正文。

| 案例 | 材料/分析/公开修订 | 回执 | 本次确认 |
| --- | --- | --- | --- |
| D01 | 材料2、analysis 36675、公开4 | 43369，completed | 正文SHA、content_hash、输入修订、回执归属相符；旧摘要是完整回答前缀，拟摘要逐字等于该回答summaryZh |
| D06 | 材料1、analysis 39812、公开1 | 48812，completed | 正文SHA及绑定相符；原回执已含计数对象误译，拟摘要只替换一次计数对象，其他句子保持 |

两条同时通过：URL与原件导出许可版本匹配、analysis与公开旧摘要一致、拟文逐字依据位于保存正文、只修改summary且不超过2000字、旧快照未撤回且无人工覆盖。预览中`needs_fresh_binding`和独立内容复核要求仍为true，发布核对标志仍为false。

可复核证据文件SHA256：

- summary-binding.json：`67d82514d4874f72d4f0b3a57042cbdbf35f4559d1b8ab8aab728daf0bba8f9a`
- details.json：`9e4ea655d70860c88d57f702cd6de13d999b88f27aadffb35df61411c7d8fa26`
- sample-originals.private.json：`e9cd21e98a9fbca3f3de36ca0f80ead91d06f4d53407ad22f25abce8862e1751`

逐条正文SHA、绑定对照与布尔自检保存于受限`.verify/argentina-service-20261023/TASK-0410-local-binding.json`；不把生产原件或原始回执复制进仓库。

实际应用前仍需重查当前材料hash/修订、analysis、公开版本、人工版本与撤回，进行原文及中文事实独立复核。沿既有人工草稿/发布接口只改summary；当前`finalizeCopy`已经保留完整答案，不新增批量修复器、不重做既有保真。发布后报告失效和事件综述可能产生模型调用，其当前范围及执行依据未取得证据，不能因为摘要来自已有答案就承诺整个应用零费用。

## 本地验证与交付边界

执行`npm test -- tests/news-geography.test.ts`，通过7项、失败0、跳过0；日志`.verify/argentina-service-20261023/TASK-0410-geography.log`。该测试文件包含真实public_read角色读取断言，但整体使用文件级克隆库，不能代替项目完整分角色验证。

本次只新增任务卡和诊断附件；业务代码与测试文件未改。未进行D04原始回答重放、生产修订、真实模型评测或线上验收；最终统一check与准确SHA完整验证由TASK-0367整合。
