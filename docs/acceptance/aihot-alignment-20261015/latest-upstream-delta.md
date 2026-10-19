# 最新版本差异与实施接续

## 2026-10-19 固定对照与本轮修复

Owner再次要求按原18项目标检查GitHub和真实站点，并明确只做必要检查、全部收口后统一部署。本轮固定到[AIHOT 6d82afb854e863ba3456d320820a57a8771ea29f](https://github.com/KKKKhazix/AIHOT/commit/6d82afb854e863ba3456d320820a57a8771ea29f)（2026-10-19 10:09:55 UTC）。[相对4947的比较](https://github.com/KKKKhazix/AIHOT/compare/4947ad03309c64a4002bd073d690aee50c548063...6d82afb854e863ba3456d320820a57a8771ea29f)只有2个提交、5个上游文件：英文日期中的at及月份缩写点号、跨年份日期标题。本站保留严格时区/日期精度和北京日界，将必要适配落实到7个文件；月份缩写点号此前已支持。

归组、精选文档、提示词、events及publication在这两个上游提交之间没有变化。本站原有同发生归fact、直接进展归story、综合稿只作背景、独立来源热度和统一代表稿机制已存在。本次结合生产实际记录和固定对照源码补齐以下缺口：

- 同一公告的晚发配套解读不能仅因发布日期或篇幅差异另建事实；新增行动/结果仍单独保留。
- 历史精选提名也比较已公开覆盖；重复稿留在全部动态，保留原日期，不新建事件、不加热、不推送。
- 旧成功配方误拆席位及旧historical席位复用每两分钟恢复任务，合计每轮最多5篇；原评分、回执、人工操作和暂停保留。
- 候选在前10名排序前过滤失效归属和明确撤回；向量缓存按公开修订更新，并继续按相同文本哈希复用。

正式consumer及恢复的28项定向回归、后端类型和数据归属检查通过；真实目录三席位仍须统一部署后由自然任务收敛，不能提前写成线上已修。采集积压、月报告警及后台登录校验的现场问题一并纳入本次候选。全部18项现状见[交付状态](goal-status.md)；固定对照的源码来源登记见根UPSTREAM.md。

## 2026-10-18 历史实施记录

以下长表是2026-10-18的实施记录，当时固定基线为`4947ad03309c64a4002bd073d690aee50c548063`，提交时间2026-10-17 19:33:36 UTC；原`540c47788eb6475c7ad8819d36733eda81dca20d`保留为历史起点。GitHub比较显示19个新增提交，两份源码逐文件SHA-256比较得到282个变化文件；完整原始记录在`.verify/latest-upstream-comparison.json`与`.verify/latest-upstream-file-inventory.json`。研究源码位于`.cache/aihot-4947ad0`，没有运行其安装或部署脚本。

此表是新增工作，不能以旧基线的完成记录抵销。每行归入原18项目标，不另造完成数量；仅复制文件、找到同名函数或通过旧测试不构成完成。保留矿业品牌和语义、独立法规范围、内容权限、人工操作与现有链接。普通产品说明不展示研究来源，许可登记另保留。

| 原目标 | 新版本变化及源码定位 | 本站处理与当前状态 |
|---|---|---|
| 1、2、6 | `events/group.ts`、`recall.ts`、`consolidate.ts`、`jobs/events.ts`：归组补排优先级、服务额度等待、选中背景召回及事件恢复 | 已确认本站timeline按story优先折叠，而新对照按同一次事实fact折叠，避免同一事件的不同新增进展被合成一个精选席位；已修正分组键、最早日期锚点、代表稿范围与旧游标失效处理，相关真实数据库回归通过（fact-timeline-tests.log）；跨出口已核对同一模式的事实席位，MCP复用v1Items，全部模式保持原始公开条目。已补恢复优先级、服务额度等待时长及已有未来作业排除，真实队列回归通过；提供商恢复已随模型行完成；补齐60天较早精选背景、同事实去重与近期信号补排，归组使用已验证日期精度。grouping-latest-final-tests、grouping-time-tests及grouping-time-check通过，保留人工归属及修订围栏。 |
| 3、4、5 | `sources/collect.ts`、`dates.ts`、`json-list.ts`、`web-list.ts`、`health.ts`：日期精度、正文保留与补抓、首次导入折日、按来源自身节奏判断静默 | 已接90天自身节奏、4个产出日门槛、超过4倍中位间隔及历史不足分流；首次导入折日、发现渠道与编辑条目分开。7天至少5次且至少10%的抓取/详情故障进入每日跟进，正文失败须同篇修复才清除。source-rhythm-tests、source-rhythm-bounded-tests及source-rhythm-bounded-check通过，旧周报跨表查询退役。其他日期和首次导入差异继续核对；已通过的202个候选预览记录保留，新增解析行为变化后只重验受影响配置。 |
| 3、15 | `lib/url.ts`、`http-fetch.ts`、`sources/x*.ts`：私有来源主机配置、元数据地址拒绝、分片水位及账号改名 | 已完成代理侧DNS解析及固定CONNECT地址，拒绝私网、元数据和198.18/15；跨源跳转不携带认证、自定义头或请求正文。network-current-focused与network-retry-focused-direct通过。本站SourceKind/site模块未安装X/SocialData，账号改名及分片水位不适用，不引入供应商或生产私网例外。 |
| 6、7 | `content/extract.ts`、`materials.ts`、`presentation.ts`、`page-content.ts`、`editorial/analyze.ts`、`translate.ts`：正文版本、组件保留、语言和错误页判断、图形文字替代 | 已接正文展示与语义修订分离、严格检查点/原回执复用、部分译文保持部分、无法对应时回滚单篇及读者修订通知；本地实际存储和RSS采集回归通过。错误页与渲染协议警告识别已接通，普通正文引用不误拦，失败渲染已付回执保持复用，page-content-check与真实本地HTTP回归通过；静态流式片段、行内可见性及图形文字替代已实现，readable-dom-tests-final与必要代码检查通过；语言协商与来源声明组件preserve已接RSS/网页/JSON/详情及独立补抓，配置校验和日期身份同步，source-page-rules-check与实际HTTP回归通过；其余分析行为随模型路由继续核对；矿业提示词不替换为行业示例。 |
| 8 | `reports/compose.ts`、`operations/reports.ts`、`edition.ts`：已完整处理的安静刊期、恢复及退出 | 已补周月完整安静周期判定、缺刊/撤回失败与停机退出；沿用日报故障区分、已发布刊期不重复写作和重复调度幂等。period-quiet-check与实际数据库回归通过。矿业词表目前仅name/aliases，报告与归属已覆盖全部声明别名，无需添加参考行业示例字段。 |
| 9、10 | `editorial/models.ts`、`providers/circuit.ts`、`llm.ts`、`receipts.ts`、`site/models.ts`：经评估的跨服务备用路由、临时故障恢复探测、回执状态与模型映射 | 已接临时故障/未知资讯主调用的评估备用、不同服务约束及真实请求关联；拒答与账户限制不切换，原未知费用保留，已交备用主请求不自动复活，备用未知仅一次恢复。accepted_at迁移避免将旧决定、拒答或未验证结果当作成功；fallback-outcomes-check及真实worker/回执回归通过。共享故障冷却、唯一恢复探测、30秒默认等待及后台状态已实现，model-circuit-check-final和实际网关/角色回归通过；无主调用的接续留独立证据而不造回执。已补备用failed/未启动时返回主路由、每逻辑回执一次恢复、新输入独立处理、真实备用领用关联与同输入结果复用；logical-scope-final-check及实际网关/角色/法规回归通过。材料级额外费用锁退出，保留准确旧键与不可伪造的回执证明。按最新已批准机制处理，但不凭示例开供应商；首批只有现有DeepSeek配置。后台自由添加和切换保持。 |
| 11 | `admin/content.ts`、`models.ts`、`sources.ts`、`runs.ts`、后台相应页面：诊断、连接、来源、运行显示 | 已补齐日期校正/撤回的预览哈希与实际精度、人工优先、正文展示任务预览/确认及extract/analyze持久防重；不重新购买评分，API只排展示任务、worker复核后执行。实际数据库、角色、worker与手机/桌面后台验证通过，第11项本地关闭。 |
| 11、15 | `operations/feedback.ts`、`admin/feedback.ts`、两项反馈迁移：提交状态、封禁期限与处理 | 已增量迁移为共享小时3份/20次尝试及同内容重放、1小时自动暂停和人工48小时邮箱封禁，后台可读期限并手动解除。跨进程并发、实际反馈角色及HTTP截图回归通过。私有群、180天留存和人工控制保持Owner既定范围。 |
| 12 | `Timeline.tsx`、`FeedItem.tsx`、`ReadingGroup.tsx`：未读筛选、组内未读成员、手机新闻行及日期栏 | 已修改手机时间并入来源行、整行日期折叠与紧凑推荐理由；必要浏览器回归通过。PR257契约完整验证后合入，前后端已接通组内未读与状态显示、返回恢复及有界自动翻页；手机/桌面与数据库回归通过（group-unread-browser.log、group-unread-publication-tests.log）。 |
| 12 | `Page.tsx`、`OutlineSheet.tsx`、`motion.ts`、`IntentLink.tsx`、`item.tsx`、`story.tsx`：长侧栏可滚动、目录定位、减少动态效果偏好、导航反馈 | 已补长侧栏滚动；手机home/all已接统一PhoneBar、精选/全部切换、检索入口和矿业筛选面板，真实浏览器及地区选项迟到场景通过；PR258已合入并接通模块底栏，金属价格独立入口与我的页面可用，既有浏览器回归通过；目录当前位置、页尾短章节选择与不增加返回历史已接通，手机/桌面回归通过（reading-motion-browser.log、reading-motion-desktop-final.log）。按压预加载、离开后解除、复制失败提示、折叠区列宽及报告画布字体/主题更新已补，reader-details-build、reader-details-browser-final和reader-details-check通过。关于页流程画布及真实来源/近期精选已接入，标题每次重查当前席位；手机、桌面、动画/减少动态、主题与实际截图验证通过，PR259已合并；二级手机页面历史返回/直接访问回退、滚动标题与目录定位已补，secondary-navigation-browser及既有网页回归通过，第12项本地关闭。保留已修复的鼠标返回不抢焦点与键盘可见焦点。 |
| 12 | `lib/text.ts`、`publication/pool.ts`：中英文连写分词、英文词首与相关度同分排序 | 已接通中英文连写分词、精选席位/质量同分排序、普通英文正文词首匹配；现有数据库固定样例与新增行为场景通过（search-latest-behavior-tests.log、search-body-prefix-tests.log），矿业实体别名和索引条件保留。 |
| 15、18 | 根package.json、package-lock.json、Dockerfile：npm工作区、单次安装后构建并裁剪 | 已转换本地、CI与镜像命令，共有依赖版本不变；SQL锁迁移证明保持5处原UNKNOWN，无新预算。npm-migration-check-final、npm-runtime-probe、npm-runtime-load-final及旧新程序归档回归通过；Docker完整验证另按最终提交取得。 |
| 15、16、18 | `operations/alerts.ts`、`watch.ts`、`backup.ts`、`modules.ts`、`apps/worker`、部署说明：积压持续时长、退出等待备份、模块生命周期与发布可靠性 | 已修心跳发送成功后才记状态、发送失败继续重试及并发串行，watchdog-delivery-check和真实数据库回归通过。退出等待已统一470/480秒并保留载荷脱敏观察，真实worker及在途付费回执回归通过；原始发送器已有导入边界守卫；模块HTTP/后台/队列/调度/材料交接均已接通，未安装的社交采集与运维唤醒不新增配置；沿用本站正式发布脚本和锁，在非生产完成验证后再统一切换。 |
| 17、18 | `publication/agent.ts`、`routes/mcp.ts`、`scripts/mcp-check.ts`、`notify/agent.ts`：Agent读取与可选运维唤醒 | 接入须验证真实协议、权限和返回结果。已更新mcp-check为当前工具目录核对与实际SDK调用，失败返回非零，缺样本分别标注；public_read真实服务回归通过，未增加收据/采集/法规版本；已新增共用Agent答案编排并接通MCP，真实public_read全工具与关闭回归通过；HTTP的11个地址已接通，真实public_read验证同查询HTTP/MCP文本一致、304、参数/日期拒绝、缺刊、撤回和无付费/采集写入（agent-http-about-final-tests）；正式公网读取仍待部署。可选运维唤醒不同于读者Agent读取；无已配置目的端不伪称投递成功，不擅自向他人发送通知。 |

## 页面观察

2026-10-18已在内置浏览器打开公开首页，观察到手机底部五个导航、热点前三条摘要、日期折叠栏、来源行内时间、紧凑推荐理由及“只看未读”。该观察证明公开页面外观，不证明后台和服务端行为；后者以以上源码、必要本地回归及最终运行证据分别裁决。

## 收口要求

每行补当前行为、最终处理结论与对应证据后才关闭。旧基线和新增差异共同覆盖最终18项；最终提交完整验证、统一部署、更新日志及公网自然任务验收仍在第18项收口，不能拿中间提交通过代替。
