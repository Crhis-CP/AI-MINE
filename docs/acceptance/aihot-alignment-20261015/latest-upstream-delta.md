# 最新版本差异与实施接续

Owner于2026-10-18要求最新页面和最新仓库一起核对。当前基线为`4947ad03309c64a4002bd073d690aee50c548063`，提交时间2026-10-17 19:33:36 UTC；原`540c47788eb6475c7ad8819d36733eda81dca20d`保留为历史起点。GitHub比较显示19个新增提交，两份源码逐文件SHA-256比较得到282个变化文件；完整原始记录在`.verify/latest-upstream-comparison.json`与`.verify/latest-upstream-file-inventory.json`。研究源码位于`.cache/aihot-4947ad0`，没有运行其安装或部署脚本。

此表是新增工作，不能以旧基线的完成记录抵销。每行归入原18项目标，不另造完成数量；仅复制文件、找到同名函数或通过旧测试不构成完成。保留矿业品牌和语义、独立法规范围、内容权限、人工操作与现有链接。普通产品说明不展示研究来源，许可登记另保留。

| 原目标 | 新版本变化及源码定位 | 本站处理与当前状态 |
|---|---|---|
| 1、2、6 | `events/group.ts`、`recall.ts`、`consolidate.ts`、`jobs/events.ts`：归组补排优先级、服务额度等待、选中背景召回及事件恢复 | 已确认本站timeline按story优先折叠，而新对照按同一次事实fact折叠，避免同一事件的不同新增进展被合成一个精选席位；已修正分组键、最早日期锚点、代表稿范围与旧游标失效处理，相关真实数据库回归通过（fact-timeline-tests.log）；跨出口及新增模型恢复差异继续核验。已补恢复优先级、服务额度等待时长及已有未来作业排除，真实队列回归通过；提供商故障/备用路由仍随模型差异核验，保留人工归属及修订围栏。 |
| 3、4、5 | `sources/collect.ts`、`dates.ts`、`json-list.ts`、`web-list.ts`、`health.ts`：日期精度、正文保留与补抓、首次导入折日、按来源自身节奏判断静默 | 已确认本站周报仍固定7天静默，尚缺来源90天自身节奏与持续问题分类；归入运行机制收口。其他日期和首次导入差异继续核对；已通过的202个候选预览记录保留，新增解析行为变化后只重验受影响配置。 |
| 3、15 | `lib/url.ts`、`http-fetch.ts`、`sources/x*.ts`：私有来源主机配置、元数据地址拒绝、分片水位及账号改名 | 待区分本批已安装能力与未启用社交服务；不为参考配置自动开通新供应商。真实缺口实施，未安装扩展记录适用结论。 |
| 6、7 | `content/extract.ts`、`materials.ts`、`presentation.ts`、`page-content.ts`、`editorial/analyze.ts`、`translate.ts`：正文版本、组件保留、语言和错误页判断、图形文字替代 | 已接正文展示与语义修订分离、严格检查点/原回执复用、部分译文保持部分、无法对应时回滚单篇及读者修订通知；本地实际存储和RSS采集回归通过。错误页与渲染协议警告识别已接通，普通正文引用不误拦，失败渲染已付回执保持复用，page-content-check与真实本地HTTP回归通过；静态流式片段、行内可见性及图形文字替代已实现，readable-dom-tests-final与必要代码检查通过；语言协商与来源声明组件preserve已接RSS/网页/JSON/详情及独立补抓，配置校验和日期身份同步，source-page-rules-check与实际HTTP回归通过；其余分析行为随模型路由继续核对；矿业提示词不替换为行业示例。 |
| 8 | `reports/compose.ts`、`operations/reports.ts`、`edition.ts`：已完整处理的安静刊期、恢复及退出 | 已补周月完整安静周期判定、缺刊/撤回失败与停机退出；沿用日报故障区分、已发布刊期不重复写作和重复调度幂等。period-quiet-check与实际数据库回归通过。矿业词表目前仅name/aliases，报告与归属已覆盖全部声明别名，无需添加参考行业示例字段。 |
| 9、10 | `editorial/models.ts`、`providers/circuit.ts`、`llm.ts`、`receipts.ts`、`site/models.ts`：经评估的跨服务备用路由、临时故障恢复探测、回执状态与模型映射 | 已接临时故障/未知资讯主调用的评估备用、不同服务约束及真实请求关联；拒答与账户限制不切换，原未知费用保留，已交备用主请求不自动复活，备用未知仅一次恢复。accepted_at迁移避免将旧决定、拒答或未验证结果当作成功；fallback-outcomes-check及真实worker/回执回归通过。共享故障冷却、唯一恢复探测、30秒默认等待及后台状态已实现，model-circuit-check-final和实际网关/角色回归通过；无主调用的接续留独立证据而不造回执。备用明确失败后的主路由再选择仍须核对，继续归第15项收口。按最新已批准机制处理，但不凭示例开供应商；首批只有现有DeepSeek配置。后台自由添加和切换保持。 |
| 11 | `admin/content.ts`、`models.ts`、`sources.ts`、`runs.ts`、后台相应页面：诊断、连接、来源、运行显示 | 待按真实行为核对最新差异，已实现的鉴权、密钥不回显和手机版交互保留。 |
| 11、15 | `operations/feedback.ts`、`admin/feedback.ts`、两项反馈迁移：提交状态、封禁期限与处理 | 待核对本站已实施的输入规则、幂等、私有群转发和图片删除，新增差异仅做兼容迁移。 |
| 12 | `Timeline.tsx`、`FeedItem.tsx`、`ReadingGroup.tsx`：未读筛选、组内未读成员、手机新闻行及日期栏 | 已修改手机时间并入来源行、整行日期折叠与紧凑推荐理由；必要浏览器回归通过。PR257契约完整验证后合入，前后端已接通组内未读与状态显示、返回恢复及有界自动翻页；手机/桌面与数据库回归通过（group-unread-browser.log、group-unread-publication-tests.log）。 |
| 12 | `Page.tsx`、`OutlineSheet.tsx`、`motion.ts`、`IntentLink.tsx`、`item.tsx`、`story.tsx`：长侧栏可滚动、目录定位、减少动态效果偏好、导航反馈 | 已补长侧栏滚动；手机home/all已接统一PhoneBar、精选/全部切换、检索入口和矿业筛选面板，真实浏览器及地区选项迟到场景通过；PR258已合入并接通模块底栏，金属价格独立入口与我的页面可用，既有浏览器回归通过；目录当前位置、页尾短章节选择与不增加返回历史已接通，手机/桌面回归通过（reading-motion-browser.log、reading-motion-desktop-final.log）。其他页面与动效继续核对。保留已修复的鼠标返回不抢焦点与键盘可见焦点。 |
| 12 | `lib/text.ts`、`publication/pool.ts`：中英文连写分词、英文词首与相关度同分排序 | 已接通中英文连写分词、精选席位/质量同分排序、普通英文正文词首匹配；现有数据库固定样例与新增行为场景通过（search-latest-behavior-tests.log、search-body-prefix-tests.log），矿业实体别名和索引条件保留。 |
| 15、18 | 根package.json、package-lock.json、Dockerfile：npm工作区、单次安装后构建并裁剪 | 已转换本地、CI与镜像命令，共有依赖版本不变；SQL锁迁移证明保持5处原UNKNOWN，无新预算。npm-migration-check-final、npm-runtime-probe、npm-runtime-load-final及旧新程序归档回归通过；Docker完整验证另按最终提交取得。 |
| 15、16、18 | `operations/alerts.ts`、`watch.ts`、`backup.ts`、`modules.ts`、`apps/worker`、部署说明：积压持续时长、退出等待备份、模块生命周期与发布可靠性 | 待核对本轮原生队列和模块收敛结果；沿用本站正式发布脚本和锁，在非生产完成验证后再统一切换。 |
| 17、18 | `publication/agent.ts`、`routes/mcp.ts`、`scripts/mcp-check.ts`、`notify/agent.ts`：Agent读取与可选运维唤醒 | 接入须验证真实协议、权限和返回结果。已更新mcp-check为当前工具目录核对与实际SDK调用，失败返回非零，缺样本分别标注；public_read真实服务回归通过，未增加收据/采集/法规版本；当前缺独立agent答案公共层，继续核对具名能力与HTTP/MCP一致性。可选运维唤醒不同于读者Agent读取；无已配置目的端不伪称投递成功，不擅自向他人发送通知。 |

## 页面观察

2026-10-18已在内置浏览器打开公开首页，观察到手机底部五个导航、热点前三条摘要、日期折叠栏、来源行内时间、紧凑推荐理由及“只看未读”。该观察证明公开页面外观，不证明后台和服务端行为；后者以以上源码、必要本地回归及最终运行证据分别裁决。

## 收口要求

每行补当前行为、最终处理结论与对应证据后才关闭。旧基线和新增差异共同覆盖最终18项；最终提交完整验证、统一部署、更新日志及公网自然任务验收仍在第18项收口，不能拿中间提交通过代替。
