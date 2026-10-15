# AIHOT 固定版本与 AI-MINE 全功能行为对照

研究时间：2026-10-15。AI-MINE 基线为 `b061c45b19f168242a1eae8bac217d893d7d5ac0`；上游为 `540c47788eb6475c7ad8819d36733eda81dca20d`。主 Agent 正在同一工作区实施，本文描述读取时的基线，不把并行未提交修改当成既成事实。本文是源码研究及实施输入，**不代表测试通过、生产上线、来源启用或质量验收**。矩阵覆盖本轮指定的全部功能组；没有声称对每个代码分支穷尽审计。

证据取自当前源码、固定版本上游源码和测试入口；历史审计只用于寻找问题，已核对对应当前文件。上游本地只读目录为 `.cache/aihot-540c477`；可复核的永久地址为 [AIHOT 固定版本](https://github.com/KKKKhazix/AIHOT/tree/540c47788eb6475c7ad8819d36733eda81dca20d)。没有访问生产数据库、读取凭据、运行真实模型或对外发送消息。本轮未执行产品测试。

## 结论及实施次序

1. #232 一类折叠补丁不足以完成上游对齐。还必须接入**归组完成后才确认精选、新信息判断、同事实统一公开席位、代表稿身份优先级**，并贯穿首页、RSS、API、MCP、报告与推送。
2. **外文先导读公开已经存在**：`publication/publish.ts` 的 `readingReady` 已允许中文标题与导读先公开。实际待改是：全文翻译目前不限精选，且没有上游的 60000 字符边界；不能把现状写成“必须全文译好才公开”。
3. 来源新增之外存在采集丢尾与永不补详情问题：当前普通轮截前 60 条，上游已取消这个截断；当前已知 URL 不再补详情，上游使用详情规则版本续补；当前无日期材料按发现时间成为实时新闻，上游将其视为日期未知的历史材料。
4. 日报与周月报需要替换编排机制，不只是改时钟。上游日报全规则、最多 12 条正文加 10 条快讯、每来源最多 2 条正文；周月报从已刊日报确定性选材，模型只写导读。
5. 还有计划未展开的读者功能差异：已读记录、收藏导入导出、最近搜索、500 条收藏容量、手机搜索层、长文工具栏和同查询请求复用。
6. 旧审计不能全部照单修复：**U01 与上游相同**（原文前 12000 字符检索，不索引译文），按本轮 AIHOT 优先要求应重新分类为旧规格偏差；F04 的同规则下真实标题更正也不是“照搬上游就自然解决”。

建议依赖顺序：契约与存量兼容 → 采集日期/材料身份 → 评分候选与归组价值 → 精选投影/席位与热点 → 翻译 → 报告 → 页面与后台 → 来源自然采集及整体验收。费用/请求计数可以独立推进，公开投影、报告和翻译共享字段须顺序整合。

## 阅读方法

表中 `B/` 表示 `packages/backend/src/`；`W/` 表示 `apps/web/app/`；`T/` 表示 `tests/`；上游同样使用这些相对位置，均指固定提交。表中函数名可直接 `rg` 定位。`相同` 仅表示所列行为已有相同机制；不表示整个模块等价。所有行的**线上证据均待主任务补齐**，不得从本报告升为 `live_verified`。

### 采集、日期与内容处理

| ID / 能力 | AI-MINE 当前实现与事实 | AIHOT 定位与确认差异 | 确定目标 / 实施边界 | 既有测试与待补验收 |
|---|---|---|---|---|
| S01 RSS/网页/JSON 主流程 | `B/sources/collect.ts::collectSource` 按 kind 调用 RSS/Web/JSON，并经来源权限和 crawl 管理 | [collect.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/packages/backend/src/sources/collect.ts) 同类读取器，另有 X/公众号支持 | 复用已有三类读取器与许可；矿业所需源不能因上游没有专用例子而被丢弃；不执行网页脚本 | `T/sources.test.ts`、`source-rules.test.ts`、`web-list-json-html.test.ts`；逐源预览与真实自然采集仍需单独证据 |
| S02 普通轮丢尾 | `B/sources/collect.ts` `MAX_ITEMS_PER_RUN=60`，普通轮 `slice(0,60)`，RSS validator 随后保存 | 上游 `collect.ts` 在首导后不按数量裁剪：避免整个 feed 的 validator 吞掉未处理尾部；先身份去重，老档案以初始化时间减历史窗口过滤 | 移植去重、存量身份保留、新身份时间窗；RSS validator 只能证明整列表已处理。不能简单无限回扫旧档案 | 上游 `T/collection-tail.test.ts`、`collection-publication-window.test.ts`；本站补第 61+ 条新稿、别名占位、304 后无漏采 |
| S03 详情补齐/标题冻结 | `B/sources/collect.ts::storedTitles` 命中 URL 后 `continue`；详情失败或预算用完后已有材料不再补读 | 上游 `storedDetails/detailRules` 保存规则版本与缺字段，预算未完成则不接受 RSS 304；**同规则已有正式标题仍保留旧标题** | 对齐续补与规则版本；F04 真正同 URL 更正需另外用有界重验证，避免短列表反复覆盖正式标题；不宣称上游已解决全部更正 | 本站 `T/source-date-automatic.test.ts`；上游 `collection-detail-recovery.test.ts`、`collection-title-recovery.test.ts`；补失败一轮后恢复、规则改变、真实更正且零重复修订 |
| S04 首导日期顺序 | 当前先按列表时间裁掉旧候选，后清除 `publishedAtAuthoritative` 指定不权威日期 | 上游 `collect.ts` 先清不权威日期再做首导窗口；首导仍默认 30 条/12 个月 | 先判权威来源再裁窗口；日期未知保留待补；不把列表旧日期直接判为过时 | `T/source-date-automatic.test.ts`；补列表旧/详情新、首导与普通轮对照 |
| S05 静态脚本与列式 JSON | `B/sources/json-list.ts::embeddedJson/fetchJsonList` 依赖 JSON 解析；网页读取不执行 JS | 上游 `json-list.ts::embeddedJson` 同样偏 JSON；`web-list.ts::fromMimoHome` 展示了读静态 chunk/路由表的方法，并非通用浏览器执行 | 嘉能可安全解析单引号静态对象、SEC 列式数组归一化；不复制 AI 供应商专属 adapter；不使用 eval/Function | `T/web-list-json-html.test.ts`、`source-rules.test.ts`；补恶意表达式拒绝、转义/括号/空值、列长度不一致、重复页 |
| S06 翻页与身份 | 当前 `web-list.ts::fetchWebList` 基线只读当前列表；JSON `itemsPath` 要求数组；材料以规范 URL/identity key 入库 | 上游 `collect.ts` 支持外部材料 ID 复用、保留 fragment 身份与限流前去重 | 整合 #233 的有界翻页，再复用真实外部 ID；同 URL 多章节只在明确来源配置下保留 fragment，防重复修订和详情重复请求 | `T/materials.test.ts`、`source-rules.test.ts`；补游标循环、相同条目跨页、官方 URL 模板缺字段 |
| S07 日期解析 | `B/sources/published-at.ts::parseLooseDate` 缺显式合法日历检查，英文解析读取主机本地字段；`feedPublishedAt` 无时区时间保持未知 | [dates.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/packages/backend/src/sources/dates.ts) 校验日历、支持 14 位日期、英语时区与 UTC 字段，`articleUtcOffset` 统一详情/list 配置 | 采用解析容错与合法性校验；保留本任务明确的日期精度信息，不向读者编造时分；明确时区配置适用于 feed/JSON | `T/labeled-publication-date.test.ts`、`source-date-automatic.test.ts`；补 2月30日、AM/PM/EST、无年份、跨主机 TZ 一致、日期只有年月日 |
| S08 无日期与发稿时间 | `B/content/materials.ts::decideTimeline` 无日期且非显式 backfill 时 `backfill=false`，时间轴用发现时间；`publishArticleTx` 无上游 undated archive 排除 | [materials.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/packages/backend/src/content/materials.ts) 把无日期标为 `unknown-publication-time`；`correctTimeline` 后续真实日期可纠正；上游 publish 排除无日期 backfill 的新闻池资格 | 无日期材料不冒充今天新闻、不加热；保留详情和真实未知标记；补日期后按原发现时点计算是否历史，不刷成今天 | `T/materials.test.ts`、`timeline-date-filter.test.ts`；补未知→真实日期、未来时间拒绝、日期纠正后的归组/报告影响 |
| S09 重试/频率/代理 | 当前 `collect.ts::adaptIntervals` 15–120 分钟，失败退避最多 360 分钟；`lib/http-fetch.ts` 和 listing 路径已有 egress/Jina | 上游同类退避与 adaptIntervals；差异主要是详情 pending 不是来源失败、配置变化后的续补 | 保留已有代理、权限与双泳道；对齐 pending/失败区分；站点拒绝不以新代理绕过 | `T/http-fetch-retry.test.ts`、`source-health-recovery.test.ts`、`source-preview-jina-timeout.test.ts`；自然恢复不能由 mock 代替 |
| C01 预筛/双评分/并行 | `B/editorial/analyze.ts::finishAnalysis/runScores` 已两次评分、结构并行、近入选用 understand；矿业 `industry/selection.ts` 60/65/76，understandFloor 50 | 上游 `analyze.ts::runAnalysis` 相同核心机制，阈值同值；上游另 `missingEvidence` 阻断仅有残缺证据的后续评分/结构；本站没有同位置短路 | 保留矿业评分语义与两次独立回执，增加证据不足时等待语义；不能为“对齐”无端重评历史稿 | `T/analyze.test.ts`、`selection-gate.test.ts`、`selection-calibration.test.ts`；补只有标题/摘要而未得正文、结构失败时费用回执完整 |
| C02 写作与用词修订 | 本站 `runUnderstand/runSummarize` 后直接保存；无 `wording` capability | 上游 `editorial/wording.ts::wordingProblems`、`analyze.ts::mendWording` 一次修词，失败保留原合格稿；`industry/wording.ts` 为行业词表 | 增加可为空的矿业读者用词规则和独立修词步骤；只对命中词表调用，拒绝/坏输出不阻断已合格稿，不引入 AI 行业词表 | 上游 `editorial/wording.ts` 与 `analyze.ts::mendWording` 是行为依据；补无命中零调用、单次修改、身份保护与已付结果复用 |
| C03 异常写回修订隔离 | `B/jobs/content.ts::processArticle/afterFailure/registerContentJobs` 异常和成功清理只按 articleId 写，正常分析已有 CAS | 上游自身没有本站的完整 ProcessingPermit/双泳道结构，不适合整文件替换 | 修 F01：领取 expectedRevision，unknown/拒绝/成功清理/抽取失败均 CAS，旧任务仅保留回执诊断 | `T/group-revision.test.ts`、`analyze.test.ts` 是相邻覆盖；需挂起 r1→提交 r2→释放 r1 所有失败分支的隔离库回归 |

### 事件、公开资格、翻译、报告与模型

| ID / 能力 | AI-MINE 当前实现与事实 | AIHOT 定位与确认差异 | 确定目标 / 实施边界 | 既有测试与待补验收 |
|---|---|---|---|---|
| E01 归组后精选 | `B/publication/publish.ts::publishArticleTx` 按评分直接 selected；未归组最多等 `selectedVisibleAfterSeconds` 后可公开 | [publish.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/packages/backend/src/publication/publish.ts) `selection_candidate` 与 selected 分离，要求 `grouping_status=complete`；无 180 秒兜底入选 | 评分只提名，归组未完成保持普通动态；重新归组后重核资格与实际确认时间；人工入选仍按明确覆盖处理 | 上游 `T/selected-news-gate.test.ts`；本站补归组迟到/失败/重试跨刊期，无精选账本、推送和报告提前泄漏 |
| E02 新信息判断 | `B/events/group.ts::judgeBatch` 只 verdicts；`relate.ts` 无 SelectionValue/reading context | [group.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/packages/backend/src/events/group.ts) 同时评估 selection addsValue，召回已精选背景；既有精选同事实可作为代表稿替换候选 | 移植“新增内容/已有精选背景”判断与持久理由；同事实替换不能被误判为完全无新增；旧数据不能默认已判断 | 上游 `T/news-value.test.ts`；本站 `events.test.ts`、`group-evidence-runtime.test.ts`；补重复观点、新事实、已精选代表替换、未精选事实重复 |
| E03 统一席位与代表稿 | 当前 timeline `pickRepresentative` 仅 first_party/full/score/time；`publish.ts` 无 seat；网页有组卡但机器出口可能按条目重复 | 上游 `publication/representative.ts` 区分 T1、核实属主组织、核实属主个人，再 full/score/time/id；`publish.ts::settleSeats/syncLedger` 同事实统一席位 | 同事实一席贯通网站与机器出口；保留旧文章链接；更换代表需旧账本 remove + 新 upsert；不能将“first_party”泛化成任意事件权威 | 本站 `T/public-v3.test.ts`、`reader-rss-round2.test.ts`；上游 `seats.test.ts`、`independent-selected.test.ts`；补并发代表替换/撤回/重归组 |
| E04 综合稿和后续进展 | 当前 `group.ts` 有 roundup 和同事件新事实、consolidate，但 publication membership 选择不含上游 latestComposite 排除 | 上游 `publication/scope.ts` 把综合稿排除自身单事实证据、阅读与席位范围统一；reports edition 折叠综合稿和已有事件后续 | 综合稿不能凭自身连接多个事件或重复占席；后续进展保留事实独立身份，按上游阅读与报告规则呈现 | `T/group-evidence-runtime.test.ts`、`group-withdrawal.test.ts`；上游 `composite-scope.test.ts`、`group-evidence.standalone.test.ts` |
| E05 热度独立参与者 | 当前 `group.ts::participantKey` 只有 `source:${id}`；`hot.ts::heatRows` 直接聚合旧 signal；48h 窗与24h半衰期已有 | [hot.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/packages/backend/src/events/hot.ts) 结合 source 的 signal_group_id/作者身份，并核当前证据与可比窗口；新建来源会影响趋势可比性 | 同机构多个入口只加一份热度；缺采与新源加入时显示不可比较，不能当趋势下跌/暴涨；保留新闻泳道 | `T/events.test.ts`；上游 `signals.test.ts`、`hot-card-payload.test.ts`；补重复入口、旧信号修订撤回、首次加入源的趋势 |
| P01 外文先公开 | 本站 `publishArticleTx::readingReady` 明确已允许中文标题+导读；仍核语言/材料/许可/人工撤回 | 上游中文标题摘要完成即可池可读，翻译不阻塞 | 保留已实现顺序，修正文档；先改变精选/翻译门槛，避免重造已有发布逻辑 | `T/foreign-automatic.test.ts`、`reader-detail-round2.test.ts`；本报告未验证生产是否存在对应译文 |
| P02 翻译选择与范围 | 当前 `needsTranslation` 不要求 selected；`translatePending` 扫全部 full 外文，三次非完整后停止；严格 segment manifest 全文处理 | [translate.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/packages/backend/src/editorial/translate.ts) 只 selected/public/full；选择首部块不超过 60000 HTML 字符，未翻块留原文，complete 由全部块判断 | 只翻入选、当前获准公开全文；采用字符边界与部分状态；保留强修订绑定和许可保护；不得把部分/过期译文认作完整 | `T/translate.test.ts`、`translation-checkpoints.test.ts`、`translate-shutdown.test.ts`；补未精选零调用、首块超限零调用、尾部原文、部分失败不无限重买 |
| P03 读者正文/许可 | 当前 `publication/detail.ts`、`v3-reading.ts` 有 summary-only/pending/restricted、当前修订译文和人工版本；读者请求不买模型 | 上游 `publication/detail.ts` 提供翻译/原文、partial 状态，正文同步入口在 worker | 保留许可与撤回；任何翻译变更同步 SSR、API、RSS、MCP 的真实完整性；正文限额不截成“全文” | `T/reader-detail-round2.test.ts`、`body-images.test.ts`、`public-v3.test.ts`；跨出口核相同材料修订与阅读状态 |
| R01 日报编排 | 当前 `reports/compose.ts::composeDaily` 每栏目8条+12快讯；writeLead 模型在 saveReport 前；跨日记忆不含快讯 factId | [edition.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/packages/backend/src/reports/edition.ts) `dailyEdition/arrangeDaily`：12主条、10快讯、每来源2主条；7日记忆；后续需4源或权威支撑才主条；日报不调模型 | 移植确定性编排和覆盖信息；F05日报失败前落库问题随移除模型消除；F06快讯事实身份必须保存 | `T/report-quiet.test.ts`、`report-candidates.test.ts`；上游 `report-outlets.test.ts`；补同源占满、快讯次日重复、后续/综合稿、纯后续日 |
| R02 周月报 | 当前 `composePeriod` 直接当前 candidates 取40/60条，模型决定 themes/refs；refs 无整数/范围/唯一强校验 | 上游 `edition.ts::periodEntries` 从日报汇编；`compose.ts::PeriodSchema/composePeriod` 模型只总述与主题导读，条目归属规则固定 | 不让模型再选择成员；记录所有实际输入依赖；模型失败不能冒充 ready；沿用同刊期确定性内容后补导读 | `T/report-withdrawal.test.ts`、`report-corrections.test.ts`；补非展示模型输入撤回、在途修订、空/越界旧输出兼容 |
| R03 时钟/补刊 | 当前 08:00/周一10:00/月初10:30 已相同；3个独立 cron，catch-up 每小时15分；catchUpReports 一期异常会终止后续循环 | 上游 `site/site.ts::EDITION_TIMES` 与 `composeDueReports` 共用；`apps/worker/src/schedules.ts` 单 `reports.compose` 每0/30分，逐期捕获失败 | 共用时钟，退休旧 cron 队列避免双刊；一刊失败不阻断其他到期刊；跨 cutoff 的确认只进下一刊 | `T/runtime-report-controls.test.ts`、`report-candidates.test.ts`；上游 `report-recovery.test.ts`、`schedule-retirement.test.ts`；停机/多失败刊/重复触发 |
| M01 模型路由 | `editorial/models.ts::modelFor` 后台→env→default 已存在；注册模型、法规专用 capability 与新闻 fallback 为本站扩展 | 上游 `models.ts` 加 site DEFAULTS、wording capability、stepsOnService；`site/models.ts::DEFAULTS={}`，示例不是运行配置 | 现有配置继续；site 默认可为空；不要自动新增供应商；后台显示实际服务与步骤，新增wording只在配置命中时用 | `T/default-model.test.ts`、`model-switch.test.ts`、`model-fallback-news.test.ts`；历史结果不随路由改变被重写 |
| M02 金额/请求次数 | 基线 `operations/usage-protection.ts` 能按累计金额暂停；账本/回执/请求控制已存在 | [receipts.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/packages/backend/src/providers/receipts.ts) 按服务请求额度准入，模型 key 共享服务计数；DeepSeek 100/2000/20000 | 退出金额准入，保留费用审计与提醒；0为停用；请求重试计数、已付结果复用；手工暂停不自动清除 | `T/receipts.test.ts`、`usage-protection-http.test.ts`、`usage-local-reuse.test.ts`；并发/滚动窗口/同服务多模型/旧金额暂停分类 |
| M03 未知结果/恢复 | 基线 unknown 需人工核对；无上游统一 `operations/recover.ts` 定时恢复 | [recover.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/packages/backend/src/operations/recover.ts) 满30分钟一次自动放行并审计“未核对是否计费”，再次未知转人工，重排关联任务 | 按稳定逻辑请求身份限制一次，不靠“当前 receipt 状态”丢掉历史；恢复包括 stale pending/归组滞留/旧队列，不恢复人工暂停 | `T/receipts.test.ts`、`receipt-truncation.test.ts`；上游 `processing-recovery.test.ts`；并发恢复、崩溃续跑、第二次unknown、付费重复不隐瞒 |

### 读者页面、搜索、后台、反馈和运维扩展

| ID / 能力 | AI-MINE 当前实现与事实 | AIHOT 定位与确认差异 | 确定目标 / 实施边界 | 既有测试与待补验收 |
|---|---|---|---|---|
| W01 首页/全部/热点/主题/事件 | 当前同名 routes 与 feed Timeline/DayList/ReadingGroup 已存在；topics 特别含矿种/国家/公司别名；hot 有 Delta/Sparkline | 上游相同页面族，新增 screen/mobile shell、页面复用、热点参与者Faces与可信趋势显示 | 保留矿业专题与法规入口；统一E01–E05的筛选和代表稿；不要用页面存在认定热点有可用数据 | `T/topics.test.ts`、`reader-pool-regression.test.ts`、`timeline-date-filter.test.ts`；桌面/390px筛选、空态、展开、返回位置 |
| W02 收藏/已读/迁移 | `W/lib/local-state.ts` 只保存ID/type/savedAt，STARRED_LIMIT=100；无 markRead/exportBundle/importBundle；starred请求失败清空显示 | [local-state.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/apps/web/app/lib/local-state.ts) 500收藏、5000已读、导入导出、存储不可用保护；上游starred可用本地快照展示 | 添加已读与导入导出、提高上限但保留现有key和 item/story/policy 类型；失败保留最后成功列表，同时继续可靠撤回检查，明确重试 | 本站 `T/reader-static-query.test.ts` 及web e2e入口；补旧格式迁移、跨标签、配额失败、错误文件、撤回、离线恢复 |
| W03 搜索交互 | `W/routes/all.tsx` 有title/summary与相关搜索；法规补查串行且仅request.signal；无最近搜索或search-busy路由 | 上游 `features/search/SearchOverlay`、`routes/search-busy.tsx`、`addRecentSearch`最多10条，忙页保留查询；超过最后页重定向 | 对齐手机搜索层/历史/忙态恢复；法规补查并行且独立有界超时；错误日期就地纠正，保留原查询 | 本站 `T/reader-pool-regression.test.ts`；上游 `search-sharing.test.ts`；补慢法规API、非法日期、503重试、分页超界 |
| W04 搜索范围（U01重分类） | `B/publication/publish.ts` pool_search只索引获准原文前12000字符，未纳入中文译文 | 上游 `publish.ts:406` **同样原文前12000字符**；不是本轮对齐缺口 | 按用户AIHOT优先，重新标为旧规格冲突，不自动扩展全译文索引；“全文相关”须有真实范围说明，不能宣称整篇中文可搜 | `T/reader-pool-regression.test.ts`；验证现有范围和权限收紧清索引；若另做全译文索引须明确其为优化偏离 |
| W05 查询复用/缓存 | 当前 pool有容量保护与总数缓存，但没有上游 identical query sharedSearch；部分读者页 no-store | 上游 `publication/pool.ts::searchPool` 用 `lib/cache.ts::sharedSearch` 在占容量前复用；web `page-reuse/session-cache` 覆盖路由 | 合并相同公开查询的在途请求；缓存key含全部矿业筛选和版本；下架/许可收紧不因复用泄漏；不照搬高TTL覆盖本站撤回保护 | `T/reader-pool-regression.test.ts`、`reader-static-query.test.ts`；上游 `search-sharing.test.ts`、`discovery-cache.test.ts`；并发相同/不同查询、撤回后失效 |
| W06 详情/阅读工具/分享 | 当前 item有分享/复制、阅读进度、粗粒度目录、公司资料/法规关联、正文状态；无上游ReaderToolbar/PosterSheet | 上游 `features/item/ReaderTools.tsx`、`ArticleBody.tsx`、`PosterSheet.tsx` 提供手机底栏、长文目录、分享海报及更完整媒体阅读 | 迁移通用阅读交互与可用分享能力，保持正文许可、矿业关联、旧链接；媒体处理不能因此新增付费供应商 | `T/reader-detail-round2.test.ts`、`body-images.test.ts`；手机滚动/长文目录/复制失败/图片失败/200%缩放 |
| W07 本地偏好/更新 | 当前 local-state有主题、收藏和反馈草稿key；反馈页面已实现本机草稿，已有MajorNotice更新提示 | 上游 local-state含font、changelogSeen、feedbackDraft、recentSearches；more提供本机设置 | 增补字体选择与已读更新提示，保留主题键；保留现有反馈本机草稿，不重造；清除/提交后处理验收 | 补存储拒绝、跨标签偏好、旧主题值兼容、无数据诚实空态 |
| A01 来源后台/覆盖 | `B/admin/sources.ts` 有草稿、预览队列、绑定config hash启用、归档和来源覆盖/目标页面 | 上游 `admin/sources.ts` 即时预览及更简来源设置，没有本站日期证据/许可审批结构 | 对齐可见预览结果、修改/恢复、详情诊断；保留已授权的“配置预览通过才启用”要求与真实新增计数；200目标不能用上游种子数量证明 | `T/source-preview-gate.test.ts`、`source-preview-recovery.test.ts`、`source-seeds.test.ts`；最终配置自然采集有效条目+去重台账 |
| A02 内容后台/重新归组 | 当前 `B/admin/content.ts::contentChain/rerun/detachFromFact/mergeStories` 已有链路诊断、人工稿与撤回；没有价值等待面板 | 上游 `operations/grouping.ts::waitingSelectedNews/groupingOverview` 区分自动等待/回执/人工并显示10分钟等待；后台诊断跟实际归组状态一致 | 增加归组价值/等待/未知恢复说明与真实重排结果，人工归属保持；不要删除本站人工版本冲突处理 | `T/group-revision.test.ts`、`group-withdrawal.test.ts`、`manual-revisions.test.ts`；补手动重组、撤回在途、重试旧revision |
| A03 后台基础交互 | `W/features/admin/ui.tsx::ReasonDialog` effect依赖onClose导致原因清空；Field htmlFor指span；dialog无焦点约束 | 上游 ReasonDialog已拆open重置与Escape监听，可直接借鉴；Field指span和modal缺trap也仍存在 | U02按上游修；U03/U04按已批准整体优化修复共同缺陷，不能称“上游已修”；操作关闭回焦触发按钮 | 旧审计有合成浏览器复现；本轮需重新做父字段变更、label关联、Tab/Shift-Tab/Escape、关闭回焦 |
| A04 模型/运行/告警 | 本站 models+fallbacks+usage保护+reconciliation；费用和运行逻辑分散 | 上游 models/settings/runs/audit 与 recover/grouping 的状态联动；服务故障列出受影响步骤 | 主路由与服务配额、未知一次恢复、实际处理进度统一显示；保留法规能力与费用历史；移除不再生效的金额“暂停”表单含义 | `T/model-switch.test.ts`、`ops-mcp.test.ts`、`usage-protection-http.test.ts`；后台保存读回、无重启应用、错误状态可恢复 |
| F01 反馈输入规则 | `B/operations/feedback.ts` 10–5000 Unicode字符、自由联系方式254；`feedback-validation.ts` 2MB PNG/JPEG/WebP、4000万像素；quota小时/日 | [feedback.ts](https://github.com/KKKKhazix/AIHOT/blob/540c47788eb6475c7ad8819d36733eda81dca20d/packages/backend/src/operations/feedback.ts) 2–5000 JS字符、邮箱200严格校验、8MB含GIF、6000万像素、每分钟5次 | 按本次明确AIHOT优先统一前后端/契约/提示/测试；保留幂等提交，避免用户反馈丢失；接受输入规则变化不等于可绕过文件解码 | `T/feedback.test.ts`、`feedback-validation.test.ts`、`feedback-upload.test.ts`、`feedback-quota.test.ts`；边界字符、GIF/伪图、2–8MB、重复提交 |
| F02 反馈转发/留存 | 当前入库outbox+独立群worker、unknown不重发、截图本地存储、后台处理记录、匿名化留存 | 上游首次异步转发+10分钟重试7日；截图已转发后本地8日清理，无群时长期保留 | 保留本计划明确独立群/后台记录/可靠防重；对齐应以不丢失反馈为准；留存涉及隐私说明，先列实际差异不悄悄改删除期限 | `T/feedback-forward.test.ts`、`feedback-maintenance.test.ts`；真实图片+联系方式仅在主任务明确授权发送样例后验收，本文未发送 |
| O01 调度/恢复/观测 | `apps/worker/src/schedules.ts` 有双泳道、preview recovery、translate、热度、报告、日价/usage/feedback；无统一ops.recover | 上游 retire queue遍历删除未注册cron，recover整合半途任务，run状态与警报联动 | 替换调度同时退休旧timer的排队工作；保留job_runs历史，不误删法规/日价独有队列；向用户显示当前事实 | `T/queue-bootstrap.test.ts`、`queue-quality.test.ts`；上游 `schedule-retirement.test.ts`、`processing-recovery.test.ts`；重启只运行一次、旧队列无双发 |
| O02 备份/保留/发布 | 当前 `operations/backup.ts`、retention、deploy生产脚本与release.lock；完整verify和release-check不是同一证据 | 上游有backup/retention/watchdog，部署拓扑与本站不相同 | 保留本项目已授权发布锁/现役+2历史/非生产独立verify；只迁移可验证的恢复机制，不能用上游测试替代本项目恢复 | `T/db-role-grants.test.ts`、运行脚本；主任务需最终SHA full回执、制品/回退摘要、健康与自然任务记录 |
| X01 法规/矿业扩展 | `B/policy/*`、`publication/policies*.ts`、`policy-report-*`、`metal-prices/*`、`W/features/policy/*`、metals路由为本站特有 | AIHOT无矿业法规版本/效力/附件逐页/法域/金属价的等价实现；不能以不存在为由删掉 | 保留独立法规全文完整性、许可与发布；共用费用/模型/搜索/交互按新机制；修U06/U08/U09；价格来源缺数据时诚实空态 | `T/policy-public-api.test.ts`、`policy-round2-public.test.ts`、`policy-reading-semantics.test.ts`、`policy-reports.test.ts`、`metal-prices-*.test.ts`；自然法规处理/报价须另验 |
| X02 公开API/RSS/MCP/发现 | 当前 publication v1/v3/feeds/llms/sitemap、api-client、公开只读出口；规范接口包含法规/矿业字段 | 上游 publication scope/seat统一筛选，agent/feeds/topics/sitemap都有事件证据限制 | 以本站契约向后兼容落地上游公开条件；不改成上游品牌URL/类型；撤回、精选代表与翻译状态各出口一致 | `T/public-v3.test.ts`、`public-v3-role.test.ts`、`reader-rss-round2.test.ts`、`ops-mcp.test.ts`；导出分页/旧链接/撤回/先公开后补译 |

**测试清单规则：** 上述“上游测试”只作移植行为样例来源，本轮未运行；本站同名测试不自动覆盖新增语义。表中若以模式 `metal-prices-*.test.ts` 表示，执行者须按所改模块选实际文件。下节给出本次实际核实的审计现状；不得把“待补验收”填写成通过。

## #227 的 21 项审计逐项复核

原报告：`docs/05-quality/audits/2026-10-13/REPORT.md`（本地独立审计工作树），原基线 `154246979cd69a865f9d074c2b9974df7db9a405`。执行 `git diff 1542469… HEAD --` 核对 content jobs、reports、sources/collect、verify/tasks、INDEX、verify/run、package/lock、publication/pool、publication/publish 及相应网页文件，所列缺陷相关实现没有已提交改变；同时直接阅读关键分支。以下不冒充重新浏览器/数据库复现。

| 原ID | 当前结论 | 当前源码证据与实施/验收 |
|---|---|---|
| F01 | 仍有源码缺口，P1 | `B/jobs/content.ts::processArticle/afterFailure/registerContentJobs` articleId-only异常和清理；修 C03，测试旧修订失败不能写新修订 |
| F02 | 仍有源码缺口，P1 | `reports/references.ts::reportMemberIds` 不纳入storyOrder；`composePeriod`未设置sourceMemberIds；所有模型输入绑定publication revision并参与撤回，覆盖在途输入变化 |
| F03 | 仍有源码缺口，P2 | `compose.ts::PeriodSchema` refs是普通number数组，映射静默丢越界；改R02后新输出不让模型定成员，存量/更正仍须校验 |
| F04 | 仍有源码缺口；上游只部分改善 | `sources/collect.ts` known URL continue；上游detailRules解决失败/规则更新，**不证明同规则下的更正标题自动刷新**；按S03加有界重验证 |
| F05 | 仍有源码缺口，P1 | `composeDaily/composePeriod` 模型在saveReport前；日报R01移除模型即可解除，周月报先保存确定性条目后补导读并诚实标状态 |
| F06 | 仍有源码缺口，P2 | `recentlyCovered`读sections，flashes无factId；R01保留快讯事实身份并纳入7日记忆 |
| G01 | 仍有源码缺口，P2 | `scripts/verify/tasks.ts::checkCard` status仅枚举/evidence只可选数组；仅live_verified/quality_accepted要求真实可定位摘要，不给实现态加发布门槛 |
| G02 | 仍有缺口且数量已变 | 研究时314张卡、INDEX262项，缺52项（0315–0351、0353–0367）；主Agent新增卡会继续改变数量，合并前用生成器重算；不得重复旧“37项” |
| G03 | 仍有源码缺口，P2 | `scripts/verify/run.ts::PENDING_STAGES`仍contracts/pit-checks，contracts其实有stage；区分已实现阶段全跑与107个PIT全覆盖，映射后清过时pending |
| G04 | 仍待补稳定证据目录，P3 | 历史release摘要指向本地.verify，不能跨工作树复核；本轮建立脱敏manifest和hash/版本/环境，不伪造或覆盖历史记录 |
| G05 | 环境问题未重现，不可关闭 | package.json/lock/toolchain相关基线未改；本轮没有执行pnpm。独立干净环境对真实调用前后锁SHA检查；不要为测试故意污染主工作树 |
| U01 | **上游一致，旧规格被新原则替代** | 本站publish.ts:447与上游publish.ts:406都是body_text前12000；不应按“上游对齐缺陷”修全译文索引。保留范围事实；文案准确性另验 |
| U02 | 仍有源码缺口，可直接对齐上游 | ReasonDialog重置effect依赖onClose；上游重置effect仅open，另effect监听Escape；父字段输入不得清reason |
| U03 | 仍有源码缺口，上游同有 | Field htmlFor指span；这是可访问性缺陷不是业务设计冲突，按已批准整体优化关联真实控件，label点击聚焦/可访问名称测试 |
| U04 | 仍有源码缺口，上游同有 | aria-modal无焦点范围；修Tab循环、关闭回焦与背景不可交互，保留Escape |
| U05 | 仍有源码缺口 | starred每次read先清items，catch也清；保留最后成功列表并显示重试；不能失效时恢复已确认撤回内容 |
| U06 | 仍有源码缺口 | all.loader先await新闻，再法规GET只用request.signal；并行+法规独立超时，失败不拖主结果 |
| U07 | 仍有源码缺口 | all.loader透传from/to→loadOr404，参数错误无就地处理；当前筛选可输入非法日期范围，需明确错误与保留用户输入 |
| U08 | 仍有源码缺口 | PolicyReading stream初始blank，useEffect读取；首批可读正文应在route loader经api-client取并SSR渲染，不绕后台直接查库 |
| U09 | 仍有源码缺口 | PolicyReading semantic_html分支只有overflow table CSS，备用table_rows才有tabIndex/命名容器；统一不破坏rowspan/colspan/删除线 |
| U10 | 字号差异存在，真机风险未验证 | 反馈14.5px/搜索15px/法规13px；属于已批准可用性优化，手机input/select/textarea按16px、允许缩放；不能宣称已复现iOS聚焦缩放 |

F01–F06、U02–U10 需要实际实现后回归；U01重新分类；G01–G04承接可核验交付记录；G05需环境验证。没有把本轮未执行的安全扫描、生产自然采集或真实模型质量填为已通过。

## 迁移与验收必须解决的细节

- 新增 `grouping_status`、selection value/candidate、席位或相应等效字段时，先契约/迁移卡；存量不能默认全部complete/true。复用已存在且绑定当前修订的归组回执；无证据稿保持候选。人工归属与人工撤回优先。
- 请求额度/未知放行按同一逻辑请求持久尝试历史，恢复重排不能因新receipt ID重置“一次”计数。旧费用暂停只解除本次废弃的自动规则，保留人工操作记录。
- 同事实席位需按fact固定顺序锁，代表替换及同步账本原子提交；报告取候选仍与发布锁协调，禁止跨cutoff提交被回填到已出刊。
- 收藏扩容/已读/导入导出保留现有 `amp` 本地键和 item/story/policy类型；不复制AIHOT的品牌存储键。未知外部JSON不能执行或直接信任HTML。
- 200个真正新增来源和8家矿企是**生产来源验收工作**，代码矩阵只能指出通路。需身份去重、最终配置hash、预览记录、启用读回及自然采集有效条目，不能用种子行数/预览数代替。
- 同步更新被取代的规则、读者更新说明与后台字段文案；每批需要最终SHA full verify和正式生产发布证据。本报告不提供虚假的整体验收百分比。
