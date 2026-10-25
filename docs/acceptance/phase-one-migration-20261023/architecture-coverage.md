# AIHOT 与 AI-MINE 架构差异清单

更新：2026-10-25。Owner最新目标：**以AIHOT为标准，把AI-MINE中所有与AIHOT不一致的底层架构迁移成AIHOT的做法；矿业特有的信源、评分规则、国别分发和历史数据保留并接入新架构。** 本文件是唯一架构迁移清单，进展与Grok意见统一回写[Issue #293](https://github.com/Crhis-CP/AI-MINE/issues/293)。上线结果另记[功能交付清单](delivery-checklist.md)，不另开协作入口。

## 对照口径

- AIHOT固定基线：[a0d1e75b](https://github.com/KKKKhazix/AIHOT/tree/a0d1e75b00ede7e503ca948e71a468db964b2df2)，依据其[架构说明](https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/docs/architecture.md)、[模块插口及消费者](https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/modules.ts)和[模型处理流程](https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/editorial/analyze.ts)。不静默追随新提交。upstream/aihot.lock.json是早期导入登记，不是本轮基线；本轮文件身份见[upstream-files.json](upstream-files.json)。
- AI-MINE已合并代码截至[c733e85c](https://github.com/Crhis-CP/AI-MINE/commit/c733e85cc27fc655b3fc940583b04f7cd1228b32)。P1模型隔离补丁随后已由[PR315](https://github.com/Crhis-CP/AI-MINE/pull/315)完整验证合并为86b6e519；P2契约PR316也已完整验证并合并为fcef889c，材料等待运行消费者已由PR317完整验证合并为b1b5606d；其余P2仍待完成。下表只把有实际消费者和提交证据的部分列为已迁移；部分迁移、尚未逐路径核对均不计为整模块完成。
- 生产现役仍为获准的f48781d4报告修复包。“已合并”不表示该批已上线；统一候选尚未部署或验收。价格/月报继续按[发布与自然运行记录](priority-report-live-20261025.md)观察。

## 逐模块差异

P1—P5是下一节的实施顺序和预计PR主题，不是已创建的PR号。已有成果复用；实际发现公共契约变化时才按仓库规定拆独立契约PR。

| 模块 | AIHOT的做法 | 已迁移部分及证据 | 未迁移/未闭合部分与计划 | 矿业保留项及理由 |
|---|---|---|---|---|
| A01 进程、包与构建 | api/worker/web三进程；backend/contracts；npm工作区 | 统一API、HTTP SSR、npm构建；旧fetcher测试壳、内部生成客户端、UI及独立配置包已收敛。[PR238](https://github.com/Crhis-CP/AI-MINE/pull/238)，468c06e1 | **结构已迁移，兼容层未全退役。P4**核清旧API角色/配置/发布路径消费者，迁走无必要的通用分派 | 保留矿业页面、旧地址和业务线，不以保留功能为由保留旧框架 |
| A02 数据访问与迁移 | 直接SQL、显式事务、引擎和模块增量迁移 | dbOf/injectDb代理已退役；sql/identitySql/feedbackSql及进程连接工厂已接。[PR238](https://github.com/Crhis-CP/AI-MINE/pull/238)，468c06e1 | **主体已迁移。P4**闭合新模块迁移发现、遗留转发与权限消费者；schema名称本身不是待重写架构 | 原表/主键、来源与文章ID、迁移账本、历史版本保持，避免数据及追溯丢失 |
| A03 模块装配与协作 | site三份安装清单；声明HTTP/队列/事件/页面插口，引擎消费 | site/industry/modules拆分，policy/metals/site-admin安装，事务事件与上下文已接。[PR238](https://github.com/Crhis-CP/AI-MINE/pull/238)、[287](https://github.com/Crhis-CP/AI-MINE/pull/287)、[297](https://github.com/Crhis-CP/AI-MINE/pull/297)、[308](https://github.com/Crhis-CP/AI-MINE/pull/308) | **部分迁移。P1/P3/P4**闭合模型坏声明、独立席位及其余声明→消费者；类型声明不算接入完成 | 专有能力通过模块接入；保留许可和news/policy上下文，专有逻辑不回塞组合根 |
| A04 来源与材料 | 读取器→判重入库→正文/原帖→可信日期/材料版本→模型；模块来源回调 | 采集/抽取、登录页过滤、日期等待和模块恢复/手工采集已接。[PR238](https://github.com/Crhis-CP/AI-MINE/pull/238)、[262](https://github.com/Crhis-CP/AI-MINE/pull/262)、[310](https://github.com/Crhis-CP/AI-MINE/pull/310)，221c5d13 | **部分迁移。P2/P4**对齐缺材料等待和原帖处理，逐类核对读取器、正文、日期及附件实际路径 | 保留555矿业来源、解析参数、启停和许可；不以示范来源覆盖，也不自动开付费读取服务 |
| A05 模型选材、结构化、写作与纠错 | 材料齐备再预筛；双评分；结构化与评分并行；理解/摘要及有界措辞修复；结果与回执先存后用 | 双评分、结构化、理解/摘要、措辞修复和提交链已存在。[PR238](https://github.com/Crhis-CP/AI-MINE/pull/238)、[263](https://github.com/Crhis-CP/AI-MINE/pull/263) | **未完整迁移，P2重点。** 原先先预筛再检查材料的差异已由[PR317](https://github.com/Crhis-CP/AI-MINE/pull/317)修复。上游originalPostCopy/verbatim原帖分支仍缺，整体模型结果与重处理链路继续核对。按阶段对齐等待、输出、重处理和保存，不逐条补内容规则 | 已确认矿业提示词语义、评分/门槛及来源等级保留；模型依旧规则更新文章结果，规则/入选条件变化仍需Chris确认 |
| A06 模型目录、调用与费用 | 核心/模块步骤统一配置、调用、回执、用途；请求次数控制与未知结果恢复 | 目录已接后台、网关、质量资格和费用标签。[PR313](https://github.com/Crhis-CP/AI-MINE/pull/313)，3e99d8e0；恢复沿用[PR284](https://github.com/Crhis-CP/AI-MINE/pull/284) | **部分迁移。P1**坏声明隔离、调用拒绝和固定历史用途归属已由[PR315](https://github.com/Crhis-CP/AI-MINE/pull/315)合并；**P2/P5**闭合评测/纠错费用及自然运行；**P4**核销仍保留的可选TaskBudget金额上界兼容入口（当前仓库调用方未设置），保留历史费用字段，不给本轮评测重新加金额上限 | 保留现有模型配置、业务线费用和未知费用；最新DeepSeek Flash，不用Pro。不设周/月固定金额上限 |
| A07 请求复用与模型缓存 | 回执复用；稳定输入前缀；双评分串行利于供应商缓存 | 回执机制已运行；摘要/报告三项输入稳定性修复已合并。[PR290](https://github.com/Crhis-CP/AI-MINE/pull/290)，f83348a2 | **代码已合并，效果未验收。P2/P5**核对全链路前缀，部署后按相同口径读自然缓存/成本；旧58.08%仅基线 | 保留矿业材料、刊期及版本绑定；不靠额外付费预热造命中率，不承诺供应商永久100%命中 |
| A08 事件归组、事实代表与公开层 | 模型关系判断→确认事实/事件→统一publication资格，各出口同源 | 事实/事件分层、确认归组、普通稿背景、v1事件链接已接。[PR238](https://github.com/Crhis-CP/AI-MINE/pull/238)、[263](https://github.com/Crhis-CP/AI-MINE/pull/263)、[284](https://github.com/Crhis-CP/AI-MINE/pull/284)、[309](https://github.com/Crhis-CP/AI-MINE/pull/309) | **部分迁移。P2/P3**核对关系复核/重处理、证据更新与读取，并以固定样本验收；不由Codex手工决定事件关系 | 矿业事件语义、历史报道/原日期、人工归属与撤回保持 |
| A09 独立精选来源插口 | 已合格精选可按指定来源保留独立卡片/席位，不改变入选与事件身份 | [PR287](https://github.com/Crhis-CP/AI-MINE/pull/287)已声明independentSelectedSources | **消费者本地接入，未合并/未上线。P3** TASK0481接rules/scope、卡片/分页、机器席位及账本；详情原精选理由保留，RSS/API/Agent共用投影。6项回归通过，完整验证另取。此插口不是国别分类或另套评分 | 目前无获准矿业名单，默认空；迁通用能力，不擅自设置来源例外 |
| A10 国别主题与分发 | 通用主题、公开读取、通知队列及当前资格检查 | 主题index/read/recheck、国家候选分发和发送前复核已接。[PR291](https://github.com/Crhis-CP/AI-MINE/pull/291)、[305](https://github.com/Crhis-CP/AI-MINE/pull/305)、[312](https://github.com/Crhis-CP/AI-MINE/pull/312)、[314](https://github.com/Crhis-CP/AI-MINE/pull/314)，c733e85c | **已合并，结果兼容与上线未闭合。P2/P3**接同一模型结果/版本证据，验页面与授权渠道一致；旧词表/规则候选不随架构自动发布 | 国别是矿业查阅/分发范围，从本国全部合格候选取稿，不截总榜、不另设阿根廷评分；新群未启用 |
| A11 日周月报告 | 规则日报；周月汇编/模型导读；调度、补扫和恢复 | 报告编排已接；补刊/等待修复见[PR286](https://github.com/Crhis-CP/AI-MINE/pull/286)、[294](https://github.com/Crhis-CP/AI-MINE/pull/294)、[299](https://github.com/Crhis-CP/AI-MINE/pull/299)，受限f487包已上线 | **优先修复已上线，观察中。P5**并行继续24小时/长期观察；9月已补出，缺资料旧刊等待，不强行出空刊 | 矿业内容、历史修订、人工版本及已定出刊规则保持 |
| A12 调度、运行告警与维护 | 引擎/模块队列、调度、告警、跟进、来源健康及维护插口 | 类型化入队及运行消费者已接。[PR238](https://github.com/Crhis-CP/AI-MINE/pull/238)、[290](https://github.com/Crhis-CP/AI-MINE/pull/290)、[302](https://github.com/Crhis-CP/AI-MINE/pull/302)、[310](https://github.com/Crhis-CP/AI-MINE/pull/310) | **部分迁移。P1**模型隔离；**P4**旧队列/兼容入口退役。价格去重继续观察，真实恢复通知尚无验收事件 | 金属来源各自周期、正常等待/异常区分、人工暂停及分业务线控制保持 |
| A13 网页、后台与公开出口 | 模块部件；网页/RSS/API/MCP/Agent/llms/站点地图共用引擎 | 根部件/导航[PR297](https://github.com/Crhis-CP/AI-MINE/pull/297)、后台[302](https://github.com/Crhis-CP/AI-MINE/pull/302)、JSON提示[303](https://github.com/Crhis-CP/AI-MINE/pull/303)、主题[305](https://github.com/Crhis-CP/AI-MINE/pull/305)、标识[306](https://github.com/Crhis-CP/AI-MINE/pull/306)、反馈/地图[307](https://github.com/Crhis-CP/AI-MINE/pull/307)、Agent[309](https://github.com/Crhis-CP/AI-MINE/pull/309)已接 | **所列消费者已合并，整体未验收。P3/P4/P5**核验各出口、权限和电脑/手机流程；默认空扩展不算已启用产品 | 矿业页面/旧链接、账号权限、用户记录、法规公开阅读；公开日志只写读者变化 |
| A14 固定样本与差异报告 | SelectBench/评测复用生产选材步骤，评测与业务写入分离 | 生产步骤复用与评测入口已存在，[PR238](https://github.com/Crhis-CP/AI-MINE/pull/238)；5540篇只读对照留存 | **本轮验收接入未完成，P2。** 原gold导出保持原校准用途；[PR318](https://github.com/Crhis-CP/AI-MINE/pull/318)已提供无需人工标签的清单，[PR319](https://github.com/Crhis-CP/AI-MINE/pull/319)接文章分析候选/辖区比较，正式真实输入、覆盖/参照与模型效果仍未完成。固定案例ID、材料/来源/版本、数量和判定口径；改模型/提示词/选材链路后报告新增入选、移出、国别变化与依据。5540篇审计不等于5540条金标或新模型评测完成 | 复用矿业漏选/误入及易混淆案例；不要求Chris盲标，不把AI意见当人工金标；无可靠参照只报变化，不伪造准确率 |
| A15 发布、数据保持与验收 | 同一代码构建部署，迁移/健康/恢复可核对 | 三进程制品、准确SHA验证、锁/备份/回退/版本保留已运行。[PR266](https://github.com/Crhis-CP/AI-MINE/pull/266)、[284](https://github.com/Crhis-CP/AI-MINE/pull/284)，另见f487发布记录 | **基础流程已有，统一发布未完成。P5**最终数据/人工状态对账、full、同一制品与实际访问通过后，按具体授权部署 | 历史与人工记录、兼容回退保持；Chris保留的授权边界是本轮约束，不因上游不同而取消 |

## 未迁移项的实施顺序与预计PR

| 顺序 | 预计PR主题（开出后回填链接，不预占编号） | 对应项 | 完成判据 |
|---|---|---|---|
| P1 | [PR315已合并](https://github.com/Crhis-CP/AI-MINE/pull/315)：模型目录故障隔离与历史费用归属 | A03/A06/A12 | 坏模块不影响核心/健康模块；无权调用拒绝；历史费用不失归属；最终SHA完整验证 |
| P2 | AIHOT模型处理、恢复与固定样本评测闭环；[PR316契约已合并](https://github.com/Crhis-CP/AI-MINE/pull/316)，[PR317材料等待已合并](https://github.com/Crhis-CP/AI-MINE/pull/317)；[PR318清单](https://github.com/Crhis-CP/AI-MINE/pull/318)和[PR319比较执行](https://github.com/Crhis-CP/AI-MINE/pull/319)已合并；[PR320等待摘要契约已合并](https://github.com/Crhis-CP/AI-MINE/pull/320)，[PR321等待统计已合并](https://github.com/Crhis-CP/AI-MINE/pull/321) | A04—A08/A10/A14 | 按上游接通材料等待、模型判断/写作/纠错、提交及重处理；固定样本前后差异报告；人工状态优先；不夹带评分/词表改动 |
| P3 | 独立精选来源与统一公开出口闭环 | A08—A10/A13 | 插口有实际消费者，各出口读取当前有效结果；默认空名单不改变矿业入选；国别接统一模型结果 |
| P4 | 其余通用架构差异收口及旧兼容层退役 | A01—A04/A12/A13 | 逐项核对启动、迁移、来源、队列、后台/网页消费者；具体差异补到本表同一行；只删确认无消费者/无唯一数据的旧代码 |
| P5 | 统一候选验证、获准发布与交付记录 | 全表 | 前四项闭合，固定样本、权限/数据保持、使用流程、最终full及制品通过；具体范围获准后上线，价格/月报和缓存自然观察分别记录 |

P2—P4若核对表明某路径已一致，记证据后关闭差异，不为凑PR重写；发现公共契约变化按现有规则独立提交。以上是计划，不代表未形成的实现已通过审查或获准上线。

## P2 固定样本与验收口径

2026-10-25 13:19:51阿根廷时间，以只读快照17837334:17837334冻结31篇真实案例的身份和观测基线：从已有5540篇对照中，按“证明恢复/保持 × 当时精选/普通”四层各取按稳定ID排序的前6篇，再纳入先前10篇原文案例，去重后31篇。它是定位问题的固定样本，不是全站误差率的随机代表样本。所请求ID全部取得，当前观测12篇确认精选、19篇非确认精选，人工覆盖0；这些状态不是对错标签。

受限清单fixed-evaluation-manifest-20261025.json保存ID、URL、来源、材料/公开修订、内容哈希、分析ID/结果哈希及许可版本，清单哈希为0dd4bb51dba2fc62f348038ce450767de83286b35c7fbc2629b7113bfb1f7ea8。真实生产行不入Git，未导出全文、未写生产、模型调用0。当前完成的是身份/观测基线冻结，尚未装入评测库、未形成完整模型输入快照、未运行新模型，不能称评测完成。

十篇既有原文锚点来自Mysteel、Silver Institute、Minería en Línea、Miningmx、OceanaGold、Cobalt Institute、Mining.com、AbraSilver、CEEC及Dipromin；具体URL随受限清单保存，其中五篇可从[原文核对记录](country-proof-three-way-20261025.md)直达。后续不得看候选结果再换样本；材料/许可/人工状态变化时记录失效原因并重新建立版本，不静默替换基线。

| 维度 | 口径与通过依据 |
|---|---|
| 固定性 | 对比同一清单、同一有效材料输入、同一已确认矿业规则；记录模型、提示词和流程版本，以及实际许可检查。不同输入不混成改版效果 |
| 选材/国别差异 | 列新增入选、移出、国别变化、等待/失败和对应原文/模型依据；12/19仅为迁移前观测分布，不能当准确答案 |
| 漏选与误入 | 只有存在可追溯且按现行规则形成的固定参照时才计算漏选数、误入精选数及恢复数；另列参照来源和争议项，不把“新增入选”直接叫“漏选修复”，不把AI参照称人工金标 |
| 程序通过线 | 无材料零付费调用；模型结果不漏存/错传；有效材料更新可续接；人工修订/撤回/暂停/归属不被覆盖；各出口读取同一当前结果 |
| 效果通过线 | 按既定矿业评分和入选标准复核已定位案例，争议/未恢复项不能标quality_accepted；不自设新评分门槛或用改变入选条件来通过评测。确需改变规则时列出差异交Chris确认 |
| 费用 | 生产与评测用途、模型、业务线、回执/重试/复用分别可查，不设每周50元上限，不为测命中率做无意义预热 |

模型判断由服务器模型流程承担；取消强制Owner盲标不等于取消效果评测。真实评测的执行范围与调用次数在对应任务登记，使用已有许可和记账机制，不能借本只读清单执行生产重算。

## 保留而不照搬的矿业内容

| 保留对象 | 理由与接入方式 |
|---|---|
| 矿业信源、材料许可和金属行情 | 本站数据与行业能力；来源适配器、期次判断和权限接入通用采集/模块，不换成示范来源 |
| 已确认矿业评分、分类及实体语义 | 行业标准不同，留在industry配置/提示词，由AIHOT模型流程执行；改标准/阈值/入选条件先请Chris确认，模型依旧规则改判文章不逐条审批 |
| 国别页面/授权渠道和法规模块 | 本站特有查阅/分发及保留阅读能力，作为模块接统一模型结果/公开层；法规采集处理仍暂停，历史阅读保留 |
| 历史数据、稳定ID/URL、人工记录与费用审计 | 迁移不能丢失或复活撤回内容；增量保留原记录，模型更新服从人工修订、撤回、暂停和归属 |

费用没有每周50元或其他固定金额上限，保留既有按服务请求次数的运行控制及可追溯回执。部署需Chris授权、评分或入选条件变化需Chris确认，继续执行。效果问题通过迁移后的模型流程和固定样本验收解决，不再拆成Codex逐条补规则、补词表或手工修内容的任务。

2026-10-25补充：等待可见性只读实查命中337条活跃新闻源记录（54源），正文/摘要/HTML均空；这是诊断证据，不是新巡检已经运行，也不等于漏选数。PR320仅合并原巡检结果的兼容摘要类型，PR321统计已接原运行结果，真实生产调度输出仍待发布验证。

原文取得核对（2026-10-25）：337条只读候选全部为body_status=unconfirmed（270 web_list、53 json_list、14 rss），不是尚未进入取材队列。固定上游jobs/content也采用有限失败重试后unconfirmed，不据此新增无限重抓。上游collect的processingNeeded来自reconcileMaterialSource确认发布来源后的处理续接，本站未承接该机制；这是发布来源归属/发现渠道协作差异，须作为P2/P4单独核对，不能直接改成所有缺正文重新调用模型，也不能覆盖矿业来源许可、历史身份或人工归属。

P2最新证据：PR319后的main73a422b8完整40227519819 / job121271952819为21项通过、scope full/exit0、隔离恢复通过，树15847e75与PR319相同。PR320准确7990053c完整40229046567 / job121276623376亦通过并合并main71063d1c；两者均未部署。TASK0480候选统计同口径的20:15:53 UTC只读快照17924630记录count=337、oldest_at=2026-10-18T14:26:02.967125Z；它证明只读统计口径可执行，不能代替生产巡检或用户可见性验收。

P3/TASK0481：独立来源名单保持空，未启用实际来源；新增publication/scope内部片段所有者登记，零新增跨模块债务或UNKNOWN预算。行为红测先证实同一事实中两篇指定来源稿丢失卡片/席位，修后覆盖代表锚点、当前成员、分页、API/RSS/Agent/sync与人工撤回；未改模型或事实成员。

正文失败留证核对：固定上游jobs/content在异常时写processing_error，但analyze最终提交（包括unknown）会清空；extractFromUrl不可读可直接返回null。本站同样执行这条状态清理。历史原因缺失是共同局限，未声称为漏迁的上游持久分类。20:30 UTC只读请求元数据中，305条200响应包含183个HTML和122个PDF，308个会话仍有pending请求，9天Jina/body_fallback回执为0；这些事实不替代密钥/启用状态或逐篇内容可读性证据。固定31篇与337等待交集0，不因此认定31篇效果已验收。

P2等待摘要PR321准确54e52c97完整40230672088 / job121281502989（21项通过/full/exit0/恢复通过）已合并main40bdacc2。前一main71063d1c的40230343988 / job121280505222也已完整通过。未新部署；截至20:37 UTC现役f487运行9.875小时，20次价格、20次补刊均ok，59次告警巡检无新发，9月首版30引用保持；24小时/真实恢复消息未验收。
