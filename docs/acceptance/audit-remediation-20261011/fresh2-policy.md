# 法规线独立功能对照（fresh2）

法规线固定版本独立对照共 30 项：23 项保留、2 项规格明确改动、1 项真实遗漏、4 项仍需运行证据。

本轮发现的唯一已证实遗漏是：**来源发布日期未知、在前期发现而本期才完成或更新合格解读的文书，会漏出本期周报和月报**。这是归期分支遗漏，不是框架差异。

审查对象固定为新库 `6996788c58347fa2483edc8e7d9e916292b20885`；旧 main 为 `65d362407226da856f66477807c5437acf1af27b`；未合并法规参考分支为 `6d37df802b7b7ff14ed9b34436166c7eb60a9b76`。旧 main 完整文件树没有独立 `policy_intelligence` 服务、`config/policy` 或 `/policies` 页面。本表完整法规功能的旧证据均来自**未合并参考分支**，不能据此声称旧站已上线。

只从固定版本源码和现行规格建立对照；未读取本目录此前的开发/审计结论。旧库仅通过 GitHub API 在线读取并在内存中处理，没有 clone、下载源码文件或迁移数据。没有修改实现、读取生产秘密或调用真实模型。

## 已复现遗漏

**FRESH2-POL-29 · P2 · 日期未知文书的跨期解读更新未入报**

- 场景：2026-09-20 已发现文书，来源发布日期未知，2026-10-10 才完成并公开合格解读。
- 预期：2026-W41 周报及 2026-10 月报均以“解读更新”收录该文书，不将其当作新法。
- 实际：新库 `planPolicyReport` 对两期均返回 `members=[]`；旧参考 `select_members` 返回 `section=reading_updates`。
- 原因：新库 `policy-report-plan.ts:105` 要求 `day !== null`；该文书既不能满足当期首次发现，也不能进入解读更新分支。
- 规格：F-051 要求老资料的新解读标“解读更新”；BR-POL-14 规定仅解读更新不计为新法，没有排除来源日期未知的文书。
- 复现方式：新库源码经 `git show` 取固定 blob，在内存中去除 TypeScript 类型并执行原纯函数；旧参考源经 `gh api` 在线取得，AST 提取原函数在内存执行。没有数据库、生产或付费模型调用。

```json
{
  "preconditions": "已公开合格文书版本；来源日期 unknown；存在真实首次发现时间；本期新公开/更新合格解读。",
  "input": {
    "discoveredAt": "2026-09-20T00:00:00Z",
    "releasedAt": "2026-10-10T00:00:00Z",
    "sourceDate": null,
    "editionId": "unknown-date-complete-oct10",
    "sourceLanguage": "es",
    "versions": [
      {
        "current": true
      }
    ]
  },
  "calls": [
    {
      "kind": "weekly",
      "periodKey": "2026-W41",
      "now": "2026-10-12T02:00:00Z"
    },
    {
      "kind": "monthly",
      "periodKey": "2026-10",
      "now": "2026-11-02T02:00:00Z"
    }
  ],
  "expected": "各返回该文书，label=interpretation_update。",
  "actual_new": "两次 members=[]。",
  "actual_old": "旧参考 select_members 返回 section=reading_updates，available_by_cutoff=true。",
  "method": "Node 从 git show 冻结 blob 读取 policy-report-plan、time、policy-language 和 ids，stripTypeScriptTypes 后用内存 data URL 执行；旧 reports.py 经 gh api 在线读取、AST 提取原 select_members 在内存执行；未写源码、未连接数据库、未调用真实模型。"
}
```

## 逐项结论

`preserved` 只表示静态功能对照成立；标为 `locally_tested_pure_frozen_blobs` 的项目另经本轮冻结源码纯函数检查。所有条目都不代表生产已验收。固定版本内已有测试只用来理解被覆盖的行为，未声称重跑其数据库集成测试。

| 编号 | 行为 | 结论 | 证据层 |
|---|---|---|---|
| FRESH2-POL-01 | 独立法规栏目与旧新闻分类的边界 | intentional_change | static |
| FRESH2-POL-02 | 36 对象及七主题的真实来源覆盖 | uncertain | runtime_not_observed |
| FRESH2-POL-03 | 报告覆盖计数与失败时间线 | preserved | static |
| FRESH2-POL-04 | 整轮目录分页与重启续扫 | preserved | static |
| FRESH2-POL-05 | 目录漂移、跨页重复和首页复核 | preserved | static |
| FRESH2-POL-06 | 目录条目消失与历史保留 | preserved | static |
| FRESH2-POL-07 | 传输等待不破坏扫描和处理断点 | preserved | static |
| FRESH2-POL-08 | 文书身份、原件不可变版本及同 URL 更新 | preserved | static |
| FRESH2-POL-09 | 必要附件完整门和容量阻断 | preserved | static |
| FRESH2-POL-10 | 严格原件解码及字符完整性 | preserved | locally_tested_pure_frozen_blobs |
| FRESH2-POL-11 | XML 表格、条款标注作用范围 | preserved | static |
| FRESH2-POL-12 | 扫描 PDF、图件和跨页表格的真实可用性 | uncertain | runtime_not_observed |
| FRESH2-POL-13 | 完整中文、中文原文不重复翻译 | preserved | static |
| FRESH2-POL-14 | 全文语义和法律经营影响质量 | uncertain | runtime_not_observed |
| FRESH2-POL-15 | 未知付费结果和处理恢复 | preserved | static |
| FRESH2-POL-16 | 逐用途许可和读时撤权 | preserved | static |
| FRESH2-POL-17 | Owner 质量资格及完整公开前提 | preserved | static |
| FRESH2-POL-18 | 基本事实与未完成解读清单 | intentional_change | static |
| FRESH2-POL-19 | 新闻/法规与三个暂停的隔离 | preserved | static |
| FRESH2-POL-20 | 日期精度、事实/计划区分和状态不自动推进 | preserved | static |
| FRESH2-POL-21 | 默认来源语言稳定且一致 | preserved | locally_tested_pure_frozen_blobs |
| FRESH2-POL-22 | 语言切换使用各自当前版本 | preserved | static |
| FRESH2-POL-23 | 正文全文检索与组合筛选 | preserved | static |
| FRESH2-POL-24 | 长文分页、显式历史和版本变化提示 | preserved | static |
| FRESH2-POL-25 | 法定关系、脉络和无依据新旧法比较 | preserved | static |
| FRESH2-POL-26 | 周月报周期、固定版本、稳定语言和幂等 | preserved | locally_tested_pure_frozen_blobs |
| FRESH2-POL-27 | 周月报停跑后的漏期补刊 | preserved | locally_tested_pure_frozen_blobs |
| FRESH2-POL-28 | 报告成员撤回、更正与报告自身撤回 | preserved | static |
| FRESH2-POL-29 | 来源日期未知的跨期解读更新入报 | omission | locally_reproduced_pure_frozen_blobs |
| FRESH2-POL-30 | 无人值守供给、真实公开与持续运行 | uncertain | runtime_not_observed |

### FRESH2-POL-01 · 独立法规栏目与旧新闻分类的边界

预期：旧新闻法规分类不能冒充独立法规文书，独立法规服务按现行规格重新建设。

结论：**intentional_change**。旧 main 没有完整法规服务；本表其余完整法规比较对象均为未合并参考分支，不是旧生产能力。现行规格明确旧 policy_regulation 新闻不迁移、不进入法规栏目。

旧证据：[旧 main · /（文件树缺席证据）](https://api.github.com/repos/Crhis-CP/global-mining-policy-intelligence/git/trees/65d362407226da856f66477807c5437acf1af27b?recursive=1)；[未合并参考 · services/policy_intelligence/public_reader.py:78-89](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/public_reader.py#L78-L89)。

新证据：`6996788:docs/01-product/10-policy-service.md:318-322`；`6996788:packages/backend/src/publication/policies.ts:196-234`。

### FRESH2-POL-02 · 36 对象及七主题的真实来源覆盖

预期：逐法域证明正式发布体系、必要补充渠道、完整取得和运行，不能把已登记或 HTTP 成功视为覆盖完成。

结论：**uncertain**。冻结目录有 156 条来源记录、35 个来源法域、7 个 policyProfile；覆盖展示仍遍历完整既定法域。配置不证明所有来源的实际取得、语义质量或持续供给，本轮未访问生产运行证据。

旧证据：[未合并参考 · services/policy_intelligence/coverage.py:294-348](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/coverage.py#L294-L348)。

新证据：`6996788:industry/policy-sources.ts:3-22`；`6996788:packages/backend/src/sources/policy-coverage.ts:20-45`。

### FRESH2-POL-03 · 报告覆盖计数与失败时间线

预期：成功结构回执、不完整回执、无完整回执分开；失败保留类别和起止时间。

结论：**preserved**。新库按完整目录回执而非普通 fetch 成功计数，并保留未归属来源数量；未取得回执不会被写成没有新法规。

旧证据：[未合并参考 · services/policy_intelligence/report_store.py:16-65](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/report_store.py#L16-L65)。

新证据：`6996788:packages/backend/src/sources/policy-coverage.ts:11-45`。

### FRESH2-POL-04 · 整轮目录分页与重启续扫

预期：每页持久化；有界轮次结束和进程重启从 next_page 续扫；契约变化从新首页重开。

结论：**preserved**。新库复用仍 running 且契约、权限版本一致的扫描，逐页落库，延期保持状态；不以单轮 maxPagesPerTurn 截断总目录。

旧证据：[未合并参考 · services/policy_intelligence/paged_store.py:70-119](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/paged_store.py#L70-L119)；[未合并参考 · services/policy_intelligence/paged_store.py:330-359](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/paged_store.py#L330-L359)。

新证据：`6996788:packages/backend/src/acquisition/directory-runtime.ts:9-27`；`6996788:packages/backend/src/acquisition/directory-store.ts:36-55`。

### FRESH2-POL-05 · 目录漂移、跨页重复和首页复核

预期：完整页序、来源声明总量、跨页唯一 ID、末页后的首页指纹一致才原子发布目标集。

结论：**preserved**。新库拒绝总数漂移和重复 ID；apply 同时验证 next_page、record_count 与首页指纹。失败保留回执并约一分钟后重开，不应用部分页。

旧证据：[未合并参考 · services/policy_intelligence/paged_store.py:253-322](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/paged_store.py#L253-L322)。

新证据：`6996788:packages/backend/src/acquisition/directory-store.ts:98-128`；`6996788:packages/backend/src/acquisition/directory-store.ts:151-172`。

### FRESH2-POL-06 · 目录条目消失与历史保留

预期：仅在完整目录生效后让缺失条目退出当前目标；保留原件与历史，不推断废止。

结论：**preserved**。新库按当前目录成员决定 currentPolicyHeads；不再列出的材料停在 not_current，旧原件仍可作为显式历史读取依据。

旧证据：[未合并参考 · services/policy_intelligence/discovery_store.py:400-415](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/discovery_store.py#L400-L415)。

新证据：`6996788:packages/backend/src/acquisition/directory-store.ts:179-237`；`6996788:packages/backend/src/policy/public-state.ts:5-18`；`6996788:packages/backend/src/policy/automation.ts:73-77`。

### FRESH2-POL-07 · 传输等待不破坏扫描和处理断点

预期：限速和传输延期保留扫描、当前处理阶段与检查点，不当成终局失败。

结论：**preserved**。新库对 CrawlDeferred 单独延期并携带 crawlSessionId 续队列；只改 due 时间，不丢原件或处理检查点。

旧证据：[未合并参考 · services/policy_intelligence/paged_store.py:100-108](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/paged_store.py#L100-L108)；[未合并参考 · services/policy_intelligence/store.py:716-741](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/store.py#L716-L741)。

新证据：`6996788:packages/backend/src/acquisition/directory-runtime.ts:22-27`；`6996788:packages/backend/src/jobs/policy.ts:49-59`；`6996788:packages/backend/src/policy/automation.ts:208-224`。

### FRESH2-POL-08 · 文书身份、原件不可变版本及同 URL 更新

预期：身份基于法域、机关、类型、文号；无文号退化为来源和 URL；内容变化追加修订而非改写旧原件。

结论：**preserved**。新库不使用中文标题计算身份；原件内容/目录哈希、来源与许可版本相同才复用，否则 CAS 追加 sequence 和 previous_id，A→B→A 仍追加。

旧证据：[未合并参考 · services/policy_intelligence/material.py:80-172](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/material.py#L80-L172)。

新证据：`6996788:packages/backend/src/policy/originals.ts:43-64`；`6996788:packages/backend/src/policy/originals.ts:73-109`。

### FRESH2-POL-09 · 必要附件完整门和容量阻断

预期：完整枚举正文与附件；缺项、容量超限或目录未闭合时不能进入完整全文处理。

结论：**preserved**。新库逐附件核许可，正文引用附件标签须被链接覆盖；目录未闭合或任一提取资源不完整使 plan 不可执行，超限不截断成合格正文。

旧证据：[未合并参考 · services/policy_intelligence/material.py:133-140](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/material.py#L133-L140)；[未合并参考 · services/policy_intelligence/acquisition.py:446-495](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/acquisition.py#L446-L495)。

新证据：`6996788:packages/backend/src/policy/acquire.ts:73-128`；`6996788:packages/backend/src/policy/extraction.ts:155-190`；`6996788:packages/backend/src/policy/processing-plan.ts:115-140`。

### FRESH2-POL-10 · 严格原件解码及字符完整性

预期：依据声明/BOM 解码；冲突、非法字节、U+FFFD 或 NUL 都保留为缺口，不生成完整正文。

结论：**preserved**。新库保留并加强旧 XML 入口的失败关闭原则；本轮纯冻结函数已验证 UTF-8 成功、非法 UTF-8、替代字符和冲突声明拒绝。

旧证据：[未合并参考 · services/policy_intelligence/acquisition.py:471-492](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/acquisition.py#L471-L492)；[未合并参考 · services/policy_intelligence/material.py:65-73](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/material.py#L65-L73)。

新证据：`6996788:packages/backend/src/policy/encoding.ts:23-54`；`6996788:packages/backend/src/policy/extraction.ts:165-175`。

### FRESH2-POL-11 · XML 表格、条款标注作用范围

预期：保留表格行列/跨度和条款节点；结构日期标注带定位和 self/ancestor/descendant，不能继承成无依据的施行日。

结论：**preserved**。新库转换 XML/CALS 表格并比较清洗前后文字，标注作为独立定位证据流转，未处理图件、公式和直接文本缺失仍使提取 incomplete。

旧证据：[未合并参考 · services/policy_intelligence/parsers.py:283-363](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/parsers.py#L283-L363)；[未合并参考 · services/policy_intelligence/parsers.py:365-428](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/parsers.py#L365-L428)。

新证据：`6996788:packages/backend/src/policy/xml-structure.ts:5-115`；`6996788:packages/backend/src/policy/annotations.ts:18-51`；`6996788:packages/backend/src/policy/extraction.ts:117-142`。

### FRESH2-POL-12 · 扫描 PDF、图件和跨页表格的真实可用性

预期：所有页、图件、跨页表格及决定性附件被逐位置核验才算完整。

结论：**uncertain**。文字层和视觉双阶段及缺口门已存在；本轮没有真实多法域 PDF、图件、数字和跨页长表的模型语义质量证据，不能把结构实现视为真实能力验收。

旧证据：[未合并参考 · services/policy_intelligence/parsers.py:598-644](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/parsers.py#L598-L644)。

新证据：`6996788:packages/backend/src/policy/extraction.ts:73-108`；`6996788:packages/backend/src/policy/vision-runtime.ts:258-329`。

### FRESH2-POL-13 · 完整中文、中文原文不重复翻译

预期：每个计划部分都有合法候选；中文原文直接保留，外文有完整中文且数字/结构守恒，缺任何部分不能拼成完整正文。

结论：**preserved**。新库拒绝缺项、重复、哈希不符和错误翻译模式；中文候选要求 zh=null，内容回用 source；只有全覆盖时才装配 resources。

旧证据：[未合并参考 · services/policy_intelligence/content.py:90-108](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/content.py#L90-L108)；[未合并参考 · services/policy_intelligence/content.py:268-317](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/content.py#L268-L317)。

新证据：`6996788:packages/backend/src/policy/fulltext-candidate.ts:174-250`。

### FRESH2-POL-14 · 全文语义和法律经营影响质量

预期：文末例外能否决前段结论，主体、may/must、条件、期限和七主题经营影响均经全文核对。

结论：**uncertain**。代码对每个候选结论重查全部组，并拒绝 unsupported/vetoes；这只能证明核验结构。没有真实模型/Owner 多法域样本评审，不证明法律语义质量。

旧证据：[未合并参考 · services/policy_intelligence/analysis_graph.py:242-362](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/analysis_graph.py#L242-L362)；[未合并参考 · services/policy_intelligence/interpretation.py:399-492](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/interpretation.py#L399-L492)。

新证据：`6996788:packages/backend/src/policy/interpretation-engine.ts:160-248`；`6996788:docs/01-product/10-policy-service.md:198-219`。

### FRESH2-POL-15 · 未知付费结果和处理恢复

预期：相同输入先回读真实回执；结果未知不重购；原件或配方变化重新建立检查点，已完成结果不得串用。

结论：**preserved**。新运行器从 receipt/attempt 恢复，unknown/busy 保持阻断状态；workflow 将原件、profile 与 processing_recipe 变化纳入重跑条件，不凭任务次数猜回执。

旧证据：[未合并参考 · services/policy_intelligence/content_store.py:413-500](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/content_store.py#L413-L500)；[未合并参考 · services/policy_intelligence/analysis_worker.py:18-35](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/analysis_worker.py#L18-L35)。

新证据：`6996788:packages/backend/src/policy/fulltext-runtime.ts:116-195`；`6996788:packages/backend/src/policy/automation.ts:104-142`。

### FRESH2-POL-16 · 逐用途许可和读时撤权

预期：取得、保存、处理、公开原文/译文分别核准；当前许可收紧后所有公开入口立即停止相应用途。

结论：**preserved**。新库逐 URL 和 attachment 检查，公开读取再次计算当前许可。失去译文/模型处理资格会退回独立基本事实，不继续暴露完整解读。

旧证据：[未合并参考 · services/policy_intelligence/contracts.py:473-495](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/contracts.py#L473-L495)；[未合并参考 · services/policy_intelligence/publication.py:104-117](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/publication.py#L104-L117)。

新证据：`6996788:packages/backend/src/policy/acquire.ts:23-35`；`6996788:packages/backend/src/policy/originals.ts:14-39`；`6996788:packages/backend/src/publication/policies.ts:62-106`。

### FRESH2-POL-17 · Owner 质量资格及完整公开前提

预期：完整解读必须符合实际来源、语言、配方、模型集合、有效期和法律状态前提。

结论：**preserved**。新库按 Owner 审阅记录、实际模型绑定和配方匹配；DTO 进一步阻止 nature/stage/publication 未知或决定性附件缺失的完整公开；资格失效读时降级。

旧证据：[未合并参考 · services/policy_intelligence/publication.py:39-88](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/publication.py#L39-L88)；[未合并参考 · services/policy_intelligence/publication.py:118-136](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/publication.py#L118-L136)。

新证据：`6996788:packages/backend/src/policy/quality.ts:7-51`；`6996788:packages/backend/src/publication/policies-publish.ts:72-108`；`6996788:packages/contracts/src/http/policy.ts:234-256`。

### FRESH2-POL-18 · 基本事实与未完成解读清单

预期：原件身份已核但全文/质量未完成时提供独立基本事实，报告给待解读文件清单，不借候选导读填充。

结论：**intentional_change**。旧参考分支完整公开失败即不公开，报告明确尚不提供逐项待解读清单；现行 F-047/F-051 明确补齐。新库保存 basic/full 双投影并清空 basic 的 guide/impact。

旧证据：[未合并参考 · services/policy_intelligence/publication.py:118-136](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/publication.py#L118-L136)；[未合并参考 · services/policy_intelligence/reports.py:109-119](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/reports.py#L109-L119)。

新证据：`6996788:docs/01-product/10-policy-service.md:194-200`；`6996788:docs/01-product/10-policy-service.md:232-234`；`6996788:packages/backend/src/publication/policies-publish.ts:283-308`；`6996788:packages/backend/src/publication/policies-reports.ts:62-77`。

### FRESH2-POL-19 · 新闻/法规与三个暂停的隔离

预期：新闻单线暂停不停止法规；采集、处理、公开暂停互相独立，既有公开阅读不因采集暂停消失。

结论：**preserved**。新库队列和控制查询显式 lane=policy，新闻控制不被选入法规快照；当前公开资格不读取采集/处理暂停。部署或系统 all 控制不作为新闻单线暂停。

旧证据：[未合并参考 · services/policy_intelligence/store.py:62-83](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/store.py#L62-L83)；[未合并参考 · services/policy_intelligence/store.py:129-209](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/store.py#L129-L209)。

新证据：`6996788:packages/backend/src/operations/lane-controls.ts:65-85`；`6996788:packages/backend/src/jobs/policy.ts:18-48`；`6996788:packages/backend/src/policy/public-state.ts:4-18`。

### FRESH2-POL-20 · 日期精度、事实/计划区分和状态不自动推进

预期：来源只有日期时不补时分；登记、公布、实质变化、生效及计划/条件分别记录；不按日历自动推断法律状态。

结论：**preserved**。候选日期须与逐字依据及确定性日期解析一致；只取 occurrence=occurred 且无条件的事件参与排序，法律 brief 从已核状态维度拷贝。

旧证据：[未合并参考 · services/policy_intelligence/timing.py:27-59](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/timing.py#L27-L59)；[未合并参考 · services/policy_intelligence/interpretation.py:324-363](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/interpretation.py#L324-L363)。

新证据：`6996788:packages/backend/src/policy/interpretation-schema.ts:89-135`；`6996788:packages/backend/src/policy/interpretation-schema.ts:172-190`；`6996788:packages/backend/src/publication/policies-project.ts:244-275`。

### FRESH2-POL-21 · 默认来源语言稳定且一致

预期：同一文书列表、详情、报告选用稳定合格语言，不随哪种语言最后处理完成而跳变。

结论：**preserved**。统一 policyLanguageOrder 使用有效配置偏好，再按语言码；本轮冻结纯函数验证输入顺序变化不改变默认语言，明确 fr 偏好后稳定选择 fr。

旧证据：[未合并参考 · services/policy_intelligence/public_reader.py:259-265](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/public_reader.py#L259-L265)；[未合并参考 · services/policy_intelligence/reports.py:66-79](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/reports.py#L66-L79)。

新证据：`6996788:packages/backend/src/publication/policy-language.ts:1-12`；`6996788:packages/backend/src/publication/policies.ts:108-145`；`6996788:packages/backend/src/publication/policy-report-plan.ts:86-92`。

### FRESH2-POL-22 · 语言切换使用各自当前版本

预期：切换原文/译文或语言时，文号、原件修订、核对时间与选中语言一致，不能借另一语言版本。

结论：**preserved**。新库先取每种语言当前原件的最新公开投影，再绑定 expression/revision；语言列表以当前资格筛选，过期的新投影不回退成旧译文。

旧证据：[未合并参考 · services/policy_intelligence/public_reader.py:237-282](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/public_reader.py#L237-L282)。

新证据：`6996788:packages/backend/src/publication/policies.ts:108-132`；`6996788:packages/backend/src/publication/policies.ts:275-355`。

### FRESH2-POL-23 · 正文全文检索与组合筛选

预期：检索中文完整正文及元数据，筛选法域/主题/性质/阶段/日期；非默认语言的合格正文也能命中；旧译文及失格内容不命中。

结论：**preserved**。新库在每种当前合格语言上匹配中文 reading blocks，再与其他筛选组合；只读，不触发写入或模型。固定版本测试包含末段词、非默认语言和旧译文反例，本轮未重跑数据库测试。

旧证据：[未合并参考 · services/policy_intelligence/public_reader.py:159-188](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/public_reader.py#L159-L188)。

新证据：`6996788:packages/backend/src/publication/policies.ts:149-233`；`6996788:tests/policy-round2-public.test.ts:138-183`。

### FRESH2-POL-24 · 长文分页、显式历史和版本变化提示

预期：正文游标绑定文书/表达/修订；普通阅读不悄悄落入历史；显式历史仍受当前许可和质量约束。

结论：**preserved**。新库正文令牌带 edition/version/expression/revision 与 historical，当前头变化返回 409；历史列表重核 eligible，并使旧游标在资格变化后失效。

旧证据：[未合并参考 · services/policy_intelligence/public_reader.py:206-246](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/public_reader.py#L206-L246)；[未合并参考 · services/policy_intelligence/public_reader.py:332-366](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/public_reader.py#L332-L366)。

新证据：`6996788:packages/backend/src/publication/policies.ts:361-448`。

### FRESH2-POL-25 · 法定关系、脉络和无依据新旧法比较

预期：仅逐字文号及官方单文书链接、同法域且唯一目标才链接；不猜废止/修订，不用模型记忆作新旧比较。

结论：**preserved**。新库要求 explicitPolicyReference 并核目标元数据，撤权/原件变更使边退出；历史详情不借当前关系，comparisons 仍强制空数组。脉络只作阅读导航。

旧证据：[未合并参考 · services/policy_intelligence/relationships.py:23-50](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/relationships.py#L23-L50)；[未合并参考 · services/policy_intelligence/interpretation.py:492-532](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/interpretation.py#L492-L532)。

新证据：`6996788:packages/backend/src/policy/interpretation-schema.ts:45-45`；`6996788:packages/backend/src/publication/policy-relations.ts:12-52`；`6996788:packages/backend/src/publication/policy-relations.ts:74-149`。

### FRESH2-POL-26 · 周月报周期、固定版本、稳定语言和幂等

预期：北京时间自然周/月；固定合格版本，月报独立归并；同原件多次解读取最新，输入不变不出新修订。

结论：**preserved**。本轮冻结纯函数验证周/月边界、当期/补录/当期发现的未知日期/已知旧日期解读更新四类、输入顺序变化的内容哈希幂等。未知日期的跨期解读更新另列遗漏。

旧证据：[未合并参考 · services/policy_intelligence/timing.py:63-95](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/timing.py#L63-L95)；[未合并参考 · services/policy_intelligence/reports.py:17-105](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/reports.py#L17-L105)；[未合并参考 · services/policy_intelligence/report_store.py:148-204](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/report_store.py#L148-L204)。

新证据：`6996788:packages/backend/src/publication/policy-report-plan.ts:33-138`；`6996788:packages/backend/src/publication/policy-report-store.ts:10-54`。

### FRESH2-POL-27 · 周月报停跑后的漏期补刊

预期：重启后补齐站内发现以来已结束且过出刊时刻的漏期，不能只出最近一期或从古老来源日期回溯。

结论：**preserved**。旧参考只发现最近已关闭期并重查已有期；新库扩大为所有缺失已关闭期的有界批次。本轮冻结函数验证 W40–W44、9/10 月漏期、排除开放期且不回到 1980 年。属于能力增强，不是回归。

旧证据：[未合并参考 · services/policy_intelligence/report_store.py:238-295](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/report_store.py#L238-L295)。

新证据：`6996788:packages/backend/src/publication/policy-report-periods.ts:4-28`；`6996788:packages/backend/src/publication/policy-report-job.ts:22-51`。

### FRESH2-POL-28 · 报告成员撤回、更正与报告自身撤回

预期：被撤回或失格成员立即从报告新旧修订移除；随后产生带原因修订；整份报告撤回不误撤其成员文书。

结论：**preserved**。新库只存成员 ID、每次读时重新取 policyPublicMembers；报告自身撤回返回 410 并从列表移除。暂停公开时仍允许仅减少成员的修订。固定版本含报告撤回与成员仍可读反例。

旧证据：[未合并参考 · services/policy_intelligence/publication_store.py:83-98](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/publication_store.py#L83-L98)；[未合并参考 · services/policy_intelligence/report_reader.py:127-152](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/report_reader.py#L127-L152)；[未合并参考 · services/policy_intelligence/report_store.py:170-204](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/report_store.py#L170-L204)。

新证据：`6996788:packages/backend/src/publication/policies-reports.ts:14-33`；`6996788:packages/backend/src/publication/policy-report-store.ts:20-53`；`6996788:tests/policy-round2-public.test.ts:195-210`。

### FRESH2-POL-29 · 来源日期未知的跨期解读更新入报

预期：前期已发现、来源日期未知的文书，本期才完成或更新合格解读，应作为解读更新纳入本期周/月报，不能静默遗漏。

结论：**omission**。旧参考 reading_updates 接受 day is None；新实现 interpretation_update 强制 day !== null。该文书的 discoveredAt 早于本期，又不能命中 source_date_unknown，因此本期两类报告都不含它。现行 F-051/BR-POL-14 没有授权排除这类更新。

旧证据：[未合并参考 · services/policy_intelligence/reports.py:46-55](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/reports.py#L46-L55)。

新证据：`6996788:packages/backend/src/publication/policy-report-plan.ts:94-106`；`6996788:docs/01-product/10-policy-service.md:228-234`；`6996788:docs/01-product/10-policy-service.md:352-358`。

### FRESH2-POL-30 · 无人值守供给、真实公开与持续运行

预期：同一部署实际持续采集、处理、合格公开并按时出报，重启后不中断；24 小时/7 天分别有证据。

结论：**uncertain**。新库存在分钟级法规处理和小时级报告任务，旧参考报告默认 disabled；这不证明线上启用、实际模型出刊或 24 小时/7 天连续供给。本轮无生产运行或公网验收。

旧证据：[未合并参考 · services/policy_intelligence/service.py:51-193](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/services/policy_intelligence/service.py#L51-L193)；[未合并参考 · config/policy/report-schedule.json:1-8](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/6d37df802b7b7ff14ed9b34436166c7eb60a9b76/config/policy/report-schedule.json#L1-L8)。

新证据：`6996788:apps/worker/src/schedules.ts:40-65`；`6996788:packages/backend/src/jobs/policy.ts:29-65`；`6996788:docs/01-product/10-policy-service.md:231-236`。

## 证据边界

- 除明确标为 locally_tested/locally_reproduced 的纯函数外，preserved 为静态调用链与固定源码行为对照，不代表生产验收。
- 未跑数据库集成测试、未读取生产秘密、未访问线上运行数据、未调用真实模型。
- 本轮未发现其他已被证据证明的实质遗漏；不以 absence of tests 判定功能缺失。
- 运行覆盖、PDF/扫描件真实语义、法律经营影响质量和连续供给分别保留 uncertain。

本轮纯函数检查实际通过：严格编码、默认语言稳定性、北京时间周/月边界、常规报告归类、报告计划幂等、停跑漏期补刊。跨期未知日期解读更新已单独复现为遗漏；该失败未被并入“通过”。

本报告保留冻结版本结论。后续修复或部署须另给修复版本与相应验证，不覆盖本报告以制造已通过记录。
