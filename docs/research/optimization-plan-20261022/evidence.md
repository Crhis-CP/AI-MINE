# 证据与真实案例

本附录区分本轮现场事实、当前代码事实、历史证据和未证实判断。生产只读SQL均在READ ONLY事务内，statement_timeout为8秒、lock_timeout为1秒。原始查询、错误和修正结果在 `.verify/optimization-plan-20261022/`，未读取密钥正文、未执行生产写入。公网浏览器证据在 `output/playwright/optimization-plan-readonly/`。文中时间未注明者为UTC；用户当地为UTC−3，站点业务日为UTC+8。

## 1 证据索引

| ID | 资料和位置 | 支持范围 |
|---|---|---|
| E01 | 上传纪要全文；原始文字记录JiDddu28EoLf0PxtIP0cPbfrnPO revision4；`transcript.json` | 讨论原话和时间定位，非技术事实或执行授权 |
| E02 | `repository-version.json`、`public-health.json`、`live-inventory.json`；本地git树 | 远端main、公网、运行容器标签及本地源码树关系；未重做镜像层验证 |
| E03 | `live-baseline.py/json`，2026-10-22 22:25:21 | 24h/7d滚动运行、来源状态、模型、费用、投递、国别及公开时延 |
| E04 | `case-trace-corrected.py/json`，22:26后 | 监管稿各门槛、双评分、成本拆分、法规暂停和来源外查；旧case-trace保留字段探索失败 |
| E05 | `details.py/json`，22:28:04 | 原始模型答案、官方历史稿、未收录URL、持久延期、cache token、unknown、模型环境非秘密字段 |
| E06 | `geo-and-holdout.py/json`，22:29后 | 秘鲁作用地、长时延样本、国别状态分母及24组留出候选元数据；未标注/未评测 |
| E07 | `output/playwright/optimization-plan-readonly/` | HeadlessChrome155、1280×720，22:26—22:30；AR筛选/返回、Lindero事件与原文 |
| E08 | `docs/acceptance/depth-first-20261020/content-and-reading-review.md`；TASK-0367当前记录 | 历史输入污染、截句、日期和返回修复；不能当本轮独立留出集 |
| E09 | AIHOT固定a0d1e75b的docs/grouping.md、publication/stories.ts，GitHub compare到b3998dc6 | 两周召回/事实故事关系/评测与100条限制；当前上游差异。线上实际SHA未知 |
| E12 | `sample-originals-export.py`、`sample-originals.private.json` | 32份受许可检查的材料快照，8诊断/24待复核留出；一份无正文，保留空值；hash与修订校验通过 |
| E11 | `cost-latency.py/json`，22:44:16 | 较晚滚动窗口的live来源检查和物理请求时延，不与22:25窗口加总 |
| E10 | DeepSeek、LME、原始新闻及官方公告链接，详见下文 | 当前官方产品说明和公开材料；价格网页不等于本站账单或正式报价 |

读取错误不算业务零值：首次用不存在的`articles.source_published_at`导致case查询失败，已用schema确认的`published_at/backfill`重查成功；`settings.runtime.controls`空行不是“没有暂停”，已改查`ops.lane_controls`；attempt的成功状态是received，不能把“非completed”统称失败。初次错误接口`/health`返回404，实际`/api/health`成功。上述探索结果保留，主方案仅用修正后的口径。

## 2 真实问题逐项诊断

### D01 阿根廷监管报道未精选且公开摘要丢失新进展

原文：[Panorama Minero 2026-10-19](https://www.panorama-minero.com/en/news/all-the-regulatory-changes-argentina-is-preparing-for-investment-imports-and-suppliers)。系统材料`k8d4djz5prs8nivp1hno4v771` revision2，E04/E05可复算。

- 已取得正文、已分析、预筛PASS、国别AR、归组完成；双评分62/62，T2门槛76，selection_adds_value=true，selection_candidate=false、seat=false。所以抓不到、预筛屏蔽、归组未完成不是此稿不入选的原因；评分门槛是已证实直接条件。它应否精选仍需业务金标，不由此自动得出“门槛应降低”。
- 原模型理解回执43369包含10月新进口流程和预定启用安排；当前公开摘要只留下6月法令的泛化介绍。最早内容差异已定位到原答案之后。当前代码已有取消机械截句修复，但旧公开结果仍存在；旧结果是否应自动重投影还需检查当时分析保存值、人工覆盖和修订传播，不能把已修复逻辑再报成当前新代码错误。
- 事实结构occurredAt为6月23日，而材料讲10月实施进展，需拆分“旧法规背景”和“本次新安排”。仅提高分数会让错误时间锚点继续传播。
- 最小改进：当前版本复用原答案恢复必要新事实、保护人工稿；将此组送标准校准。验收原文→原回执→analysis→publication→卡片/报告逐字段对照，检查时间、文号、条件，无重复付费/发布。

### D02 监管后续进展被阈值挡住 转载增量判断亦需对照

SMM[审计报道](https://news.smm.cn/news/104169266)，材料`cv3m3w5jt3ssy06m7gs456ygi`，68/78平均73，T2门槛76，预筛PASS、正文ok、公开但未选；归组理由明确“两个月内由总审计长出具报告”为此前内部调查之外的新监管行动。相同事实2365内Mining Weekly材料`kpkdkmriimxoj71tnbpba0wqp`为72/68平均70、正文unconfirmed，增量判断为false，两稿均未精选。

这组用于区分“重要进展未过分数”与“同次事实转载没有新增”，并核验两份增量理由所参照的代表稿是否相同。不能把相同fact下两条不同增量判断自动认定为冲突，也不能把媒体两篇算两个独立原始证据。最小补证是冻结两次判定当时的参考稿及官方审计文件；完成后才决定规则修订。验收按事件组整体留在development，不得拆进两套样本。

### D03 国家列表混入仅提及该国的报道 已闭合根因

[Dipromin原文](https://www.dipromin.com/noticias/notiempresas/buenaventura-entre-las-seis-mayores-productoras-de-plata-del-mundo-segun-yhe-silver-institute/)，材料`xa5q01scvytwwo1gssp587rco`：秘鲁Buenaventura的Uchucchacua-Yumpag矿，摘要仅在排名比较时提及阿根廷。E06中模型地理与当前公开投影均仅PE；E07公网`/api/site/pool?jurisdiction=AR`仍返回该稿，浏览器AR列表也出现。

根因在`packages/backend/src/publication/items.ts:201-218`：地理代码、标签、全文国名提及无条件OR；`mentions.ts:291-312`转国名别名，`read-predicates.ts:5-10`匹配search_text，`items.ts:235-236`计数同样合并提及。`pool.ts:192-199`返回实际命中文章，已排除前端旧DOM和分组代表替换。**不是模型错分。**

最小改进：明确“事件发生/规则适用国”与“全文提及”两种查询语义。国家页面及群路由用当前修订、有效作用地证据；全文搜索仍能搜索阿根廷提及。partial中已有合法PE证据应保留，不应整篇丢弃；unknown另给扩展检索/待核提示，不能无条件混入精选。先同步既有规格及契约，避免删除宽召回后暗中改变旧链接含义。

验收此稿作用地PE命中、AR不命中；AR文字搜索仍可命中；同一企业加拿大注册、AR项目、AR/CL跨国、纯背景提及、多国部分证据、旧版本证据失效分别测试。计数、列表、精选和分发共用口径。

### D04 明确双国官方稿没有国家结果

[阿根廷与智利矿业合作，2026-04-14](https://www.argentina.gob.ar/noticias/mineria-argentina-y-chile-fortalecen-la-integracion-estrategica-en-la-region)，材料`lhymy0xkp58y03qhemoad4z1o`；原题明确两国，现有geography为unknown/invalid_geography_evidence、jurisdictions为空。6月矿业投资改革官方稿`jv4uctsjpht0ml28k1da33qhe`同样为空，虽然已精选；9月机械进口稿有有效AR证据。

已证明取得/公开不等于国家字段可用；尚未区分所有引文拒绝的具体原因，需保存结构化原响应与地理segment并逐项重放。可能是mention/quote不一致、截取范围或角色不合法，不能靠放松证据校验补数字。先仅修可复现解析/标准化偏差，模型确实遗漏再校准提示。验收有效原文引文成功、伪引文仍拒绝、多国分别有证据，日期型来源保持日期语义。

### D05 原站存在但资讯系统未发现的监管节点

[ARCA第5909/2026号一般决议官方正文](https://www.boletinoficial.gov.ar/detalleAviso/primera/348497/20261005)，可另核[Argentina规范库](https://www.argentina.gob.ar/normativa/nacional/norma-430865/texto)与[ARCA VUCE目录](https://www.arca.gob.ar/vuce/ayuda/normativa.asp)。公告发布日期10月5日，是矿业用途声明接入VUCEA的执行节点，与9月矿业秘书处公告、10月媒体解读构成同一制度发展组；不是将6月旧法令当10月新颁。

E05以官方URL识别号348497/430865及标题5909在articles中查得0，以news来源配置查BORA/ARCA得0；已收录的9月官方新闻和10月媒体稿不能代替此原始节点。这里证明**资讯articles未收录该原件且无这两个域名的news入口**，不声称所有policy独立表、附件或历史资料全库不存在。

这是原站侧发现覆盖样本。法规线暂停是既有决定，不属于需要自动修复的故障；资讯是否增加ARCA原始监管动态入口须经来源许可与Owner启用选择。方案可先只读建立人工对照和线索候选，不偷偷恢复法规抓取。验收新增观察入口确能发现对应执行节点，亦能排除不涉矿普通税务通知；不重推历史原件、不重复存多个官方镜像。

### D06 普通监管声明的误译 不是所有官方稿都需精选

[GGMC 2026-10-06官方声明](https://www.ggmc.gov.gy/ggmc-statement-on-material-deviations-from-the-legal-and-regulatory-framework-for-the-award-and-transfer-of-extractive-licences/)，材料`l183sv95n93r22xutvad6f3za`为回填，T1双评分38/28平均33，公开未选。原文讲六套成文申请/转让程序；原始summarize回执48812已经写为“6宗…申请与转让流程”，公共摘要沿用。这是计数对象从程序变为宗数的实质误译，不能归因前端截断。

最小行动是定点更正并把计数对象/单位纳入摘要评测；与D01区分为模型层错误。本稿无重大违规的回顾声明可作“官方但不当然重要”的负向边界，价值标签留给独立复核。验收六套程序不被写成六件许可，时间范围2023—2024和石油另审条件保留，历史稿不伪装当日新事件。

### D07 抓取失败既有差异 同一health不能解释当前状态

E03/E05证实Canada Nickel九条S3 PDF一直等待robots，未来队列存在且按5分钟预约；格林美/Polyus按约分钟deferred，来源表可能仍为旧health=ok；中国矿业网旧last_error为HTTP468但最近持久等待原因是robots_unavailable；吉林为403、Arafura为500、Namibia商会为RSS格式错误。这些不能合并成“反爬”。

最小改进先展示最近有效结果、当前等待、累计等待、恢复条件和需人工动作；对持续同主机许可不可用采用合并探测/有限退避，状态转变时告警一次、恢复一次。原始请求状态/内容类型及robots证据未齐时不新造解析器或代理。离线故障回放验证源恢复后无漏项、并发不重复发布，人工暂停始终优先。

### D08 推送尚未启用 自动恢复能力差距属静态确认

E03两个content目标disabled、enabled_at为空、7天deliveries为0；不能提供实际漏推率或群接收时延。`notify/deliver.ts:65-95,131-142`确认目标全发、去重行包含failed/unknown阻止再次自动发送，pending超时转failed、sending转unknown；只有人工resend。`notify/selected.ts:61-85`另有精选席位、12小时、非backfill等条件。

先做dry-run规则矩阵和隔离传输故障回放：发前中断、确定未收、429、5xx、超时未知、重启、人工撤回/暂停、规则变化及旧稿补处理。只有能证明未送达的临时错误自动退避，unknown不盲发。正式群发后再以平台message_id/接收记录对账；发送API成功不等于成员已读。此处不是当前漏推故障修复声明。

### D09 事件脉络缺口与信息首次出现时间

当前Lindero事件[公开页](https://aiminingpolicy.com/story/92cc2a63-259e-4984-a689-2e5ffe300678)有4条报道、0精选；E07完成升序、原文跳转和返回。综述把10月22日转载数字称为“进一步披露”，但10月20日原文已列同一LDH259钻孔数字，这是“报道新增≠事实新增”的实案候选；需核对综述输入版本及来源发布时间后修复，不重排热榜。

代码：`events/group.ts:170,282`14天候选；`:1289-1300,1371-1381`历史非精选退出普通归组；`publication/items.ts:389-396`60天扩展偏向已确认精选背景；`publication/stories.ts:216`最近100报道。`story.tsx:317-336`展示firstReportAt而非已有occurredAt；`events/digest.ts:27-32`用报道24/72h决定活跃状态。均不满足所有长期项目历史和真实项目阶段。

定向补历史背景、时间字段和信息增量；超100条仅在实际需要/夹具证明后加分页。原文0:00与本站20:26差异需进一步核对日期观察与时区，不凭这一次页面读数判为错时。

### D10 18小时公开尾延迟与资源 归因仍有缺口

材料`dlx6op8mvkn6w8kust49ejedm`于10月21日14:35发现、14:41已有analysis，10月22日08:49首次公开，18.24小时。E06未取得完整发布审计和当时门槛，不能判断是人工改变、版本重投影还是任务缺漏；需要文章修订/公开变更日志和当时pause/selection状态。原生模型subject匹配未返回记录不证明未调用，已由analyses证明有处理。

主机一次快照available内存1,578,176,512字节，swap已用949,166,080，磁盘可用2,694,873,088、94%，load1为0.15。此时数据不支持“内存不足导致页面慢”，但磁盘容量需重新核对，不能沿用旧清理后8GB。另于22:45 UTC用本机curl对首页、AR列表和对应API各取2次，6次均200：首页TTFB 2.150/2.372秒、列表1.493/1.413秒、API 1.464/1.360秒；首页完整传输3.098/6.087秒。网络地区/代理路径未核，curl不渲染前端，样本不足以报p95；TTFB包含网络和服务等待，不能直接当服务器耗时。原记录为`http-samples.json`。没有当前IOPS、iowait、目标网络RUM或正式扩容报价；这些列入P11，不虚构预期提速。

## 3 成本复算

E03/E04七天估算258.143562元，两份账对应；报价快照输入2/输出8元每百万token。`providers/usage-pricing.ts:80-107`使用总输入/输出结算估算，没有cache/峰谷拆分。E05仍有766次历史unknown、成本为空，不纳入“零成本”。

同一7天输入114,464,157、输出3,651,906；命中66,068,028、未命中48,396,129，二者和等于输入。按本轮官方价全部空闲的情景为`48.396129×1 + 66.068028×0.02 + 3.651906×4 = 64.32511356`元；全部高峰为两倍。忽略历史价格生效与账户优惠，只能展示敏感性区间，不能称实际账单上下界或审计确认费用。

同期first_public_at窗口内2717条当前可公开稿、938个非空fact，缺独立质量分母且时间归因未闭合。0.095元/稿或0.275元/非空fact只能是粗比值，不能称“每条合格内容成本”。服务器、备份、抓取、推送现金账单仍缺，模型估算不得当全部运行成本。

## 4 当前模型处理时延补充

22:44:16 UTC另取滚动24小时物理尝试，预筛n1341 P50/P95为1.035/1.485秒、评分n1002为0.951/1.407秒、结构化n502为1.820/2.908秒、摘要n321为1.539/1.990秒、内容理解n176为1.984/2.517秒、文章归组n307为2.343/3.809秒。这是回执latency_ms分布，不包括排队/抓取/发布等待，也不证明文本质量。该时刻滚动7日为33,835次live/received、估算257.54元；窗口移出旧请求，不能与22:25的33,926次混成一套分母。

## 5 未补齐的最小证据

| 判断 | 最小补证 | 对结论的影响 |
|---|---|---|
| 总运行费用 | 费用窗口起止时区、模型供应商账单、服务器/存储账单、unknown对账 | 不能确认现金支出和月预算；不妨碍修估算展示 |
| 监管质量/误选率 | 未参与调参者逐事件重要性标签及分歧理由 | 不擅改标准；技术实错可先修 |
| 国家准确率 | 原站和入库两池的独立地理标注，含有效partial/unknown | 493/2276不能称准确率，359AR页面数也不是AR作用地内容量 |
| 抓取失败根因 | 格式错误的状态/响应类型/有限原文、robots成功后行为 | 不把格式错误一律当解析Bug或反爬 |
| 18小时尾延迟 | 当时发布审计、修订、任务/门槛事件 | 不能据平均调用时延责怪模型或服务器 |
| 目标地区体验 | 中国与阿根廷实际网络、手机任务录像/时间指标 | 本地无头浏览器不代替真实用户验收 |
| LME4.5万元 | 供应商、套餐、品种/延迟、币种税费、再分发权、报价有效期 | 不采用该数采购或否定所有延迟数据方案 |
| 真正群发可靠性 | 后续明确群目标与发送授权、平台回执/群内对账 | 当前只能验证模拟路由与故障恢复，实际送达率不适用 |

用户本轮已回复没有可提供的具体监管例子；上述案例为本轮自行检索并追溯，不冒称用户指定样本。
