# 法规阅读扩展

module声明既有法规列表、正文、历史版本、政策脉络及报告页面，保留全部地址和route ID；web提供原位置的桌面/手机入口及按页加载的法规收藏列表。公开页面只经HTTP读取现有内容，保留SSR首批正文、修订/撤回核验和部分完整性提示。

法规列表标题下展示更新说明并链接更新日志，桌面与手机共用：默认是已确认的暂停更新说明；运营方打开下述 `POLICY_PILOT_ENABLED` 后，同一处改为“试点范围更新中”（由 `/api/site/policies/scope` 的 `updates` 决定，不按最近活动猜测）。

## 重启：存档、结构化与逐条对照（DEC-78补充·五项决定 5）

Owner 解除了 DEC-71 的暂停，先做不调用模型的部分（`docs/design/policy-restart-202611/README.md` 第 4、6 节）。解读段预算未定，所以法规线所有模型用途默认关闭。

- **两个开关**（`backend/pilot.ts`，每次读取环境变量，只认精确的 `true`）：
  - `POLICY_PILOT_ENABLED=true`：恢复存档（目录扫描 `policy.sources.schedule`、`policy.acquire` 取原件）和结构化（提取正文、切分条款、投影逐条对照）。它叠加在 `COLLECT_ENABLED`、`COLLECT_POLICY_ENABLED` 和后台运行控制之上，不取代它们。法规列表说明随之改为“试点范围更新中”。
  - `POLICY_MODEL_STAGES_ENABLED=true`：法规线全部模型用途（`policy_fulltext`、`policy_vision`、`policy_interpret`、`policy_verify`、`policy_group`）的前提。未设置时，sweep 不排全文、视觉、解读三个阶段；已排队的这类任务执行时改回等待，不购买结果；`provider.ts` 网关对任何法规用途直接拒绝。单独的 `MODEL_CALLS_ENABLED` 不再能启动法规模型阶段。
- **Codex 恢复存档与结构化的步骤**（正式环境）：
  1. 部署包含两份新迁移的版本（`policy/202611051000_policy_provisions.sql`、`publication/202611051010_policy_revision_provisions.sql`，只增表）。
  2. 在 api 与 worker 两个进程的环境里设置 `POLICY_PILOT_ENABLED=true`，**不要设置** `POLICY_MODEL_STAGES_ENABLED`；确认 `COLLECT_ENABLED`、`COLLECT_POLICY_ENABLED` 不是 `false`；重启两个进程。
  3. 在后台“运行开关”里恢复法规线的负责人暂停，范围选“采集和新的模型处理”（DEC-71 发布时由 `industry/release-controls.json` 的 `policy-pause-20261015` 写入；该决定按编号只执行一次，以后发布不会重新暂停）。处理开关恢复后，因为模型阶段开关未开，只会运行存档、结构化和公开投影。
  4. 在 worker 环境回填已有修订：先 `node scripts/policy-provisions-backfill.ts`（只统计，不写入），核对输出后执行 `node scripts/policy-provisions-backfill.ts --apply`。脚本只用已缓存的提取结果，不取页、不调模型、不改公开版本；重复执行不会重复写入。
  5. 回退：去掉 `POLICY_PILOT_ENABLED` 并重启，存档与目录扫描停止，说明恢复为暂停文案；已存条款和对照保留。
- **结构化**：`domain/provisions.ts` 是纯函数（中文第X条/之一与编章节、西语 Artículo/Art. N°/bis/序数词/único 与 Título/Capítulo/Sección、英文 Article/Section N 与 Part/Chapter，附件/ANEXO/Annex 另起编号空间；以引号开头的修改文本和小写引用不算新条款）。对齐先按全文相同的条款做锚点（LCS），其余按条号与文字相似度单调配对，分为新增、修改、删除、未变；修改的条款给出中文逐字、拉丁文字逐词的差异（Myers 差异算法，再做语义合并）。`domain/provision-store.ts` 在 `policy.acquire` 取得原件后、公开前，把当前修订的条款按配方 `provisions-1` 存进 `policy.revision_structures` / `policy.revision_provisions`；扫描件没有文字层时记为 `needs_manual`，不送视觉模型。工作流在模型阶段关闭时停在 `acquire / structured`，按来源复查周期继续存档。
- **公开与读取**：`publication/policy-provisions-project.ts` 只在来源允许公开原文全文时，把条款投影到 `publication.policy_provision_sets` / `publication.policy_revision_provisions`（按原生修订）。`compare.ts` 提供 `GET /api/site/policies/{id}/compare?from=&to=`（`from`/`to` 为版本记录里的公开修订 ID，省略时比较当前版本与上一份不同的同语言版本），读取时逐次核对公开资格和原文阅读许可，结果在进程内按两边条款哈希缓存，不落库、不调模型、不写库。网页在法规页加“逐条对照”一节（`web/features/PolicyCompare.tsx`），版本记录页的历史版本带“与当前版本逐条对照”链接。
- 生命周期事件沿用现有 `dates` 与 `legal_state`（公布、施行、截止、废止各带原文证据和已发生/计划），本次不新增 `lifecycle_event` 表；新来源适配器（中国 5 个机关、阿根廷公报与三省）由 Codex 按设计第 6 节第 2、3 步接入。

TASK0500：公开说明仅表达正文、附件、解读及资料覆盖的实际可读范围，不显示处理回执、配置、容量或采集失败明细，也不在暂停时承诺自动复查。读取历史公开版本时只转换已知系统诊断模板和匹配附件状态的旧提示；法条、人工自定义说明、历史记录和原始运行证据不改写。法规汇总保留覆盖不足提示与AI标识，既有覆盖数据字段不变，网页不再展示内部回执统计表。

本轮不扩建法规业务、不接新模型。采集与模型处理已按Owner决定暂停，入口和已发布阅读保留。server注册法规公开读取接口、既有处理队列及三个定时任务，队列名/重试/并发/出刊节奏保留；国家地区查询留在通用站点入口，继续服务新闻筛选。模块队列通过统一worker注册器校验名称后安装，运行时仍执行原有暂停/许可/版本校验。read、reports、language与relations拥有法规公开列表/详情/正文/版本/报告、语言选择与关系投影的实际实现，旧publication入口只兼容转发。domain拥有原始资料采集、正文提取、版本、解读、证据与处理状态；provider、jobs和publication拥有既有模型适配、任务及发布/报告实现。处理状态直接从本模块读取，相关新闻经引擎具名只读入口取得；许可、现行修订和公开完整性仍在每次读取时核验。旧核心路径仅保留已登记消费者需要的兼容转发，模型设置、告警和恢复等共享消费者的扩展挂口仍待收敛。

目录新增或变化材料经on.materialDiscovered在同一事务交接，本模块使用实际policy.acquire队列定义与原directory单例键安排后续处理；重复任务视为已接收，无模块接收或入队失败不能提交材料应用结果。定时、手工收集与最终暂停规则保持。

法规工作流轮询按采集、处理、公开三个控制分别筛选到期阶段，并在批次上限前排除暂停阶段，避免其挤占其他允许阶段的名额。采集暂停或采集环境开关关闭时不发现新工作流，成功轮询沿用上次发现游标；明确恢复后从原位置继续。只暂停处理仍可采集，模型调用总开关关闭时不安排全文、视觉和解读阶段；既有已入队任务仍由执行端二次核验暂停、许可与材料版本。该入口不改变资讯线控制。
