# 任务卡索引

> 生成文件，不要手改：`node scripts/verify/tasks.ts --write-index`（随任务卡在整合分支生成并提交；规则文件第 6.3 节）。

| 卡 | 任务包 | 关 | 泳道 | 状态 | 标题 | 依赖 |
|---|---|---|---|---|---|---|
| [TASK-0001](TASK-0001.md) | T-0014 | M0 | architect | locally_verified | 建仓：原样导入 AIHOT、登记上游、移植上游修复并记录行为基线 | — |
| [TASK-0002](TASK-0002.md) | T-0001 | M0 | architect | locally_verified | 建立工具链与统一验证入口 make verify（不用 GitHub Actions） | TASK-0001 |
| [TASK-0003](TASK-0003.md) | T-0002 | M0 | architect | locally_verified | 去品牌，并删除模型榜、Codex 重置监控等只对 AI 行业有意义的功能 | TASK-0002 |
| [TASK-0004](TASK-0004.md) | T-0003 | M0 | architect | locally_verified | 落实最小边界：导出白名单、按角色的数据库连接、两个 API 实例与 fetcher 骨架 | TASK-0003 |
| [TASK-0005](TASK-0005.md) | T-0004 | M0 | architect | specified | 建立契约中心：Zod 生成 OpenAPI 3.1 与前端客户端，并检查生成物漂移 | TASK-0004 |
| [TASK-0006](TASK-0006.md) | T-0005 | M0 | architect | specified | 建立数据库基线：PostgreSQL 18.6 + pgvector、按模块的迁移体系与迁移检查 | TASK-0004 |
| [TASK-0007](TASK-0007.md) | T-0006 | M0 | architect | specified | 前端拆出公开与私有路由组，并把品牌色收敛到一份调色板 | TASK-0004 |
| [TASK-0010](TASK-0010.md) | T-0009 | M0 | architect | specified | 矿业行业包 v0：站点文案、分类、36 个法域、种子信源（一律停用）与矿业版提示词草案 | TASK-0003 |
| [TASK-0011](TASK-0011.md) | T-0011 | M0 | architect | specified | PIT 检查库：verify 的 pit-checks 阶段先做 8 项 | TASK-0002 |
| [TASK-0013](TASK-0013.md) | T-0806 | M0 | architect | locally_verified | 旧站过渡期事项：2026-10-13 旧站模型价格表到期，交 Owner 并记录结论 | — |
| [TASK-0014](TASK-0014.md) | T-0002 | M0 | architect | locally_verified | 把根目录 README 写成 AI矿策 的使用手册（Owner 2026-10-03） | TASK-0003 |
| [TASK-0015](TASK-0015.md) | T-0001 | M0 | architect | locally_verified | 在 GitHub Actions 上跑同一个 make verify：多一个执行者，不多一道门（Owner 2026-10-03） | TASK-0002、TASK-0014 |
| [TASK-0016](TASK-0016.md) | T-0233 | M0 | architect | locally_verified | 登记 Owner 2026-10-03 的切换更正：旧站只读不保留、不切回旧站，并把规格逐处改正 | TASK-0014 |
| [TASK-0017](TASK-0017.md) | T-0007 | M0 | architect | locally_verified | 事件测试的随机文本改从汉字区取字，修掉登记的偶发失败（PIT-070） | — |
| [TASK-0018](TASK-0018.md) | T-0009 | M0 | architect | locally_verified | 同步金属矿业范围与煤铀砂石排除的 Owner 更正 | — |
| [TASK-0019](TASK-0019.md) | T-0003 | M0 | architect | locally_verified | 接管增量独立质量复核后的边界、生命周期与范围规范修复 | TASK-0003 |
| [TASK-0020](TASK-0020.md) | T-0134 | M1 | architect | specified | 接通外文待译队列与完整中文后的首次公开门 | TASK-0004 |
| [TASK-0021](TASK-0021.md) | T-0104 | M1 | architect | specified | 九项来源用途与 ProcessingPermit 契约及实际强制接线 | TASK-0004 |
| [TASK-0022](TASK-0022.md) | T-0124 | M1 | architect | specified | 接通可靠来源日期、新闻待补日期与统一公开门 | TASK-0004、TASK-0005、TASK-0006 |
| [TASK-0023](TASK-0023.md) | T-0001 | M0 | architect | locally_verified | 仓库加上 Claude Code 的权限设置：读网页、搜网页不再逐次请 Owner 批准 | — |
| [TASK-0024](TASK-0024.md) | T-0233 | M0 | architect | locally_verified | 补记 Owner 2026-10-03 至 10-05 的原话与答复，改正“上线不再询问”和“认可”两处记录 | — |
| [TASK-0025](TASK-0025.md) | T-0132 | M1 | architect | locally_verified | 规格改回 ADR-0021 的预筛“宽进、只拦明显无关”：UNKNOWN 照常往下走，中文稿不等模型，金属范围不变（证据裁决） | — |
| [TASK-0026](TASK-0026.md) | T-0003 | M0 | architect | specified | 把 data-ownership 检查换成规格要求的简单版：按（模块，别的模块的表）计数，只减不增 | — |
| [TASK-0027](TASK-0027.md) | T-0135 | M1 | architect | locally_verified | 代码改回预筛“宽进”：UNKNOWN 照常往下走，中文稿先以来源摘录上站，只有 BLOCK 撤下，负责人的收录选择优先 | TASK-0025 |
| [TASK-0028](TASK-0028.md) | T-0009 | M1 | architect | implemented | 行业包矿业化：主题、矿种、国家与矿企词表，写作提示词，页脚合规项，正式站评分须经 Owner 确认 | — |
| [TASK-0029](TASK-0029.md) | T-0323 | M2 | architect | specified | 起草矿业版内容类型与评分标准，在真实矿业稿件上试评后交 Owner 审阅；未经确认不在正式站生效 | TASK-0028、TASK-0041 |
| [TASK-0030](TASK-0030.md) | T-0113 | M2 | architect | integrated | 网页列表信源可以从 JSON 响应的某个字段读出列表 HTML，可以读取商务部驻外经商处（认可清单编号 22）的经贸新闻栏目 | — |
| [TASK-0033](TASK-0033.md) | T-0202 | M3 | architect | integrated | 还没有精选时首页先放最新动态，有了精选自动换回，并把 Owner 的这项选择写回规格；侧栏加“金属价格”官方入口页（档 1） | — |
| [TASK-0034](TASK-0034.md) | T-0009 | M2 | architect | integrated | 手机上每个公开页面的页脚显示 ICP 备案号；有公安备案号时显示它的文字和链接（图标由 TASK-0047 做，TASK-0047 合并前不填号） | TASK-0028、TASK-0033 |
| [TASK-0035](TASK-0035.md) | T-0009 | M2 | architect | integrated | 其余提示词与说明文字矿业化：事件综述、归组、防编造规则、身份核验、全文翻译术语，分享图与 llms.txt 的主题说明 | TASK-0028 |
| [TASK-0037](TASK-0037.md) | T-0807 | M5 | architect | integrated | 带 www 的网址永久跳转到主域名，让备案登记的首页地址能打开 | — |
| [TASK-0038](TASK-0038.md) | T-0207 | M3 | architect | integrated | 更新日志保留旧站 9 月 15 日以来的记录并按 AIHOT 的写法重写，加 10 月 3 日致谢和 10 月 6 日正式上线（重大更新 2.0），删掉框架示例；给 Owner 核对的“来历”不上网页 | — |
| [TASK-0039](TASK-0039.md) | T-0007 | M2 | architect | integrated | 选材评测测试不再把执行器自己的代理变量带进子进程，带着代理变量的执行器上也能通过 | — |
| [TASK-0040](TASK-0040.md) | T-0124 | M2 | architect | integrated | 只写日期的来源把那天作为发布时间、网页只显示日期，旧文排回原日期、不进“今天”；纠正已入库的条目 | — |
| [TASK-0041](TASK-0041.md) | T-0009 | M2 | architect | integrated | 两个分类改显示名：“人身与生产安全”改为“矿山安全”，“技术与加工”改为“技术与冶炼”；键与收录范围不变，仍是 9 类 | — |
| [TASK-0042](TASK-0042.md) | T-0132 | M2 | architect | integrated | 预筛补排除规则：与矿业无关的地学、国土与用地、一般机关事务，与金属无关的贸易管制，只有党建公益评比的企业稿，没有金属矿业信息的算范围外；用合并版本重判全部稿件，和 Owner 已同意的清单不一致的部分再交他看 | — |
| [TASK-0043](TASK-0043.md) | T-0124 | M2 | architect | integrated | 时间规格照上游写回：只写日期的取来源时区当天零点作发布时间、网页只显示日期，旧文按首次导入与 48 小时判，“今天”与排序按时间线 | TASK-0040 |
| [TASK-0044](TASK-0044.md) | T-0207 | M3 | architect | integrated | 金属价格表（一）：建价格表与品种登记，带进三个来源的夹具（第一层；国家统计局的解析与检查拆到 TASK-0057，刷新、入库与定时任务拆到 TASK-0069）；只建表，网站上不显示 | — |
| [TASK-0045](TASK-0045.md) | T-0207 | M3 | architect | locally_verified | 金属价格表（二）：照第四版预览加站内接口 GET /api/site/metal-prices 的契约（读者看不到，verify 通过、独立审查没有阻断就合并）；本卡也是整个价格表的设计，登记、读取、接口分别在 TASK-0085、TASK-0086、TASK-0087（前两张读者看不到；接口等 Owner 看过真实页面的截图才合并），页面在 TASK-0060，公开角色的权限在 TASK-0077 | TASK-0044、TASK-0057、TASK-0069、TASK-0046、TASK-0048、TASK-0077 |
| [TASK-0046](TASK-0046.md) | T-0207 | M3 | architect | integrated | 金属价格表（三）：移植上游的解压小工具并加大小上限、按文件原文读 xlsx；刷新改为几个来源两个两个地抓、一个出错不影响别的，按品种扣下照 TASK-0069 的规则实现（不加来源，读者看不到变化，不用等 Owner 看预览） | TASK-0044、TASK-0057、TASK-0069 |
| [TASK-0047](TASK-0047.md) | T-0009 | M2 | architect | specified | 备案号改成一个共用组件：桌面侧栏、“更多”页、手机页脚三处都用它，公安备案号带官方图标、文字和查询链接 | TASK-0034、TASK-0051 |
| [TASK-0048](TASK-0048.md) | T-0207 | M3 | architect | locally_verified | 金属价格表写回规格：价格表（档 2）改为 M3 排期，照 Owner 同意的第四版（按品种分组、频率小标签、脚注、较上期），一次写全四个来源（国家统计局每旬、商务预报每周、世界银行每月、俄罗斯央行每日的金银铂钯换算成美元），Owner 看过真实页面的截图、同意后上线；INV-47、AC-OUT-16 换成新写法 | — |
| [TASK-0049](TASK-0049.md) | T-0207 | M3 | architect | specified | 金属价格表（四）：加 IMF 的钴、钼月度价格（暂停：Owner 2026-10-06 两次选了先不放；IMF 的条款不许未经明确许可用程序批量下载，以后要放先取得书面许可；暂停期间不抓 IMF 的任何东西；钯从第四版起由俄罗斯央行提供，见 TASK-0083） | TASK-0044、TASK-0057、TASK-0069、TASK-0046、TASK-0068 |
| [TASK-0050](TASK-0050.md) | T-0007 | M0 | architect | specified | 依赖安全升级的常设卡：新的高危公告让所有 PR 的依赖审计失败时，用只改锁文件的 PR 单独升级，不夹在功能 PR 里 | — |
| [TASK-0054](TASK-0054.md) | T-0207 | M3 | architect | implemented | 名称检查补上两处口子（JSON 里的转义写法；第 7 类例外和放行原句的文件清单绑在一起），更新日志校验遇到不存在的月份或日子时说清是哪一条 | — |
| [TASK-0055](TASK-0055.md) | T-0124 | M2 | architect | specified | 来源日期照上游多认几种写法（不补零、斜杠、点、年月日），RSS 与 JSON 列表只写日期的也取那天北京零点；纠正脚本在正式镜像里直接能跑，并加检查防止再犯 | — |
| [TASK-0056](TASK-0056.md) | T-0313 | M3 | architect | implemented | 规格照上游和网站写回三处：针对某一事件的解读、点评算这个事件的后续；“页面不存在”页的文案与两个按钮；改了 Caddyfile 的部署要重启 Caddy | — |
| [TASK-0057](TASK-0057.md) | T-0207 | M3 | architect | integrated | 金属价格表（一之二）：国家统计局旬度价格的解析与合理性检查（TASK-0044 第二层的前一半；纯函数，不连库、不入库，网站上不显示） | TASK-0044 |
| [TASK-0058](TASK-0058.md) | T-0124 | M2 | architect | integrated | 后台的来源发布时间只写日期的只显示日期，不再显示“00:00”（文章详情与试抓列表） | — |
| [TASK-0059](TASK-0059.md) | T-0007 | M2 | architect | integrated | 选材评测测试自己设上代理变量，GitHub Actions 上也能发现“把代理变量带进子进程”的回归 | TASK-0039 |
| [TASK-0060](TASK-0060.md) | T-0207 | M3 | architect | locally_verified | 金属价格表（二之二）：/metals 照第四版预览改成价格页（导语、“最新一期”、按品种分组的一张表带频率小标签与脚注号、说明与官方查询入口；有数据、某一类陈旧、某一类没有数据、全都没有、出错几种状态），站点地图和冒烟清单加上 /metals 与价格接口，写整页上线的产品更新片段（从 TASK-0087 的分支叠着做，等 Owner 看过真实页面的截图才合并） | TASK-0087、TASK-0048、TASK-0088、TASK-0090、TASK-0082 |
| [TASK-0062](TASK-0062.md) | T-0192 | M2 | architect | implemented | 飞书运行提醒的接通检查：新增只读检查脚本，列出机器人所在的群和群号，说明提醒群、反馈群填了没有；加 --send 时往提醒群发一条测试消息 | — |
| [TASK-0063](TASK-0063.md) | T-0192 | M2 | architect | implemented | 运行提醒改正后台页面名；“调用额度用完了”改成“调用次数异常，已自动暂停付费调用（不是总额上限）”，按小时的自动暂停也提醒；开关开着却没配群号时记一行警告 | — |
| [TASK-0064](TASK-0064.md) | T-0142 | M2 | architect | locally_verified | 每周一 09:05 往运行提醒群推上周用量周报（按服务、按能力的调用数、token 与金额，比前一周；自动暂停的天数；待核对笔数） | TASK-0063、TASK-0075 |
| [TASK-0067](TASK-0067.md) | T-0181 | M2 | architect | specified | 飞书登录的回调地址改用私有主机名（没设 PRIVATE_HOST 时仍用 SITE_URL），用 passport 桩测完整登录 | — |
| [TASK-0068](TASK-0068.md) | T-0207 | M3 | architect | locally_verified | 金属价格表（三之二）：登记世界银行每月发布的月度价格（金、银、铂，铜、铝、锌、铅、锡、镍的 LME 结算价，铁矿石），品种、报价标题、规格与四条脚注照第四版写，世界银行先停用；本卡也是世界银行这一块的设计，抓取（同一版本 7 天内不重复下载）与启用在 TASK-0088（读者看不到，verify 通过、独立审查没有阻断就合并，不等截图） | TASK-0044、TASK-0057、TASK-0069、TASK-0046、TASK-0085 |
| [TASK-0069](TASK-0069.md) | T-0207 | M3 | architect | integrated | 金属价格表（一之三）：定时抓国家统计局旬度价格，过检查的入库，写运行记录（TASK-0044 第二层的后一半；只入库，网站上不显示） | TASK-0044、TASK-0057 |
| [TASK-0071](TASK-0071.md) | T-0207 | M3 | architect | integrated | 金属价格表（四之二）：某个来源超过 26 小时没抓成功时，在每日系统日报里提醒（读者看不到变化，不用等 Owner 看预览；检查脚本、试跑与强制入库拆到 TASK-0076） | TASK-0044、TASK-0057、TASK-0069 |
| [TASK-0072](TASK-0072.md) | T-0116 | M2 | architect | locally_verified | 采集时对方直接断开连接，同一请求隔几秒再取一次（只限信源列表页与正文抽取的 GET，付费服务不在内），第二次仍失败才算这一轮失败；失败原因写出断开的类型，后台与周报看得出是哪种（合并不等于上线，部署要 Owner 当时同意） | — |
| [TASK-0074](TASK-0074.md) | T-0007 | M2 | architect | integrated | 校验脚本自测里“清理三个子进程”那条用例给子进程的退出时间从 100 毫秒放宽，机器忙时也能稳定通过 | — |
| [TASK-0075](TASK-0075.md) | T-0192 | M2 | architect | implemented | 写回规格：Owner 2026-10-06 的三次选择（运维提醒改用飞书自建应用、只发飞书不做邮件备用；不设总调用次数上限，按服务的调用次数上限照上游自动暂停与恢复，每周一推上周用量），并记入 08-owner-voice 与裁决表 | — |
| [TASK-0076](TASK-0076.md) | T-0207 | M3 | architect | locally_verified | 金属价格表（四之三）：加只读的检查脚本；人看过以后先试跑、再强制入库被扣下的那一期（读者看不到变化，不用等 Owner 看预览；在正式库上跑要 Owner 同意） | TASK-0044、TASK-0057、TASK-0069、TASK-0071 |
| [TASK-0077](TASK-0077.md) | T-0207 | M3 | architect | locally_verified | 金属价格表（二之零）：让公开角色可以读价格表里站内接口要用的 11 列（只开读权限，读者看不到变化，verify 通过、审查没有阻断就合；合并顺序在 TASK-0048 之后、TASK-0045 之前） | TASK-0044 |
| [TASK-0079](TASK-0079.md) | T-0807 | M5 | architect | implemented | 规格写回：后台改回主域名的 /admin（照 AIHOT），旧的 admin 子域 301 到主域名（只改文档；代码在 TASK-0080，同源后的内容安全策略在 TASK-0084，上线要 Owner 当时同意） | — |
| [TASK-0080](TASK-0080.md) | T-0807 | M5 | architect | locally_verified | 后台改回主域名的 /admin：网站按“主机名 + 路径”分读者站与后台，私有构建的文件放 /admin/assets/，转给公开接口的请求去掉 Cookie，旧的 admin 子域 301 到主域名（合并不等于上线，部署要 Owner 当时同意） | TASK-0079 |
| [TASK-0081](TASK-0081.md) | T-0807 | M5 | architect | specified | 境外访客经 EdgeOne 回源后，网站要认出访客的真实地址：只有带着与 EdgeOne 约定的密钥头的请求，Caddy 才采用 EdgeOne 给的访客地址（没配密钥时行为不变），密钥头不进日志；部署规格写明境外线路经 EdgeOne、只缓存 /assets/*，并登记 Owner 的选择（上线要 Owner 当时同意） | — |
| [TASK-0082](TASK-0082.md) | T-0207 | M3 | architect | locally_verified | 金属价格表（五）：加商务部“商务预报”每周的铜、铝、锌全国价格，铜、铝、锌各多一行“周”的国内报价，注明“信息来源：商务预报”（先由集成人安排录夹具；表的检查放宽到周度；合并时读者还看不到，verify 通过、独立审查没有阻断就合并，不等截图） | TASK-0044、TASK-0057、TASK-0069、TASK-0046、TASK-0085、TASK-0088、TASK-0090 |
| [TASK-0083](TASK-0083.md) | T-0207 | M3 | architect | locally_verified | 金属价格表（六）：为俄罗斯银行（俄罗斯央行）每个工作日公布的金、银、铂、钯核算价与它同一天的美元汇率放宽表的检查（日度、卢布），登记来源与品种（俄罗斯央行先停用），刷新改两处（抓取器的说明排在前面，日度被扣下的一天不挡后面的定价日）；本卡也是俄罗斯央行这一块的设计，库里存卢布原数、读者看到的美元/盎司由 TASK-0086 换算，抓取在 TASK-0089，用乌克兰央行的同类价格核对并启用在 TASK-0090（读者看不到，verify 通过、独立审查没有阻断就合并，不等截图） | TASK-0044、TASK-0057、TASK-0069、TASK-0046、TASK-0085、TASK-0088 |
| [TASK-0084](TASK-0084.md) | T-0807 | M5 | architect | locally_verified | 后台与读者页面同源以后加一道内容安全策略（CSP）：网站给每个页面响应发 CSP，脚本只认本次请求的随机值（nonce），别的网站不能把页面嵌进框架；读者页面与后台都带，直接生效；在 TASK-0080 部署之前合并，同一次部署上线（上线要 Owner 当时同意） | — |
| [TASK-0085](TASK-0085.md) | T-0207 | M3 | architect | locally_verified | 金属价格表（二之一）：照第四版改登记文件与它的校验（顶层加页面用的六项，国家统计局四种有色加报价标题与规格，加硫酸，钢材 6 项停用），三个测试里缩小登记的那几行跟着改（读者看不到，verify 通过、独立审查没有阻断就合并；从 TASK-0045 拆出，设计见 TASK-0045） | TASK-0045 |
| [TASK-0086](TASK-0086.md) | T-0207 | M3 | architect | implemented | 金属价格表（二之三）：照第四版写价格的读取 loadMetalPrices（选行、较上期、换算、最新一期、脚注与说明），只读库与登记文件、不接接口（读者看不到，verify 通过、独立审查没有阻断就合并；从 TASK-0045 拆出，设计见 TASK-0045） | TASK-0045、TASK-0085、TASK-0088、TASK-0090、TASK-0082 |
| [TASK-0087](TASK-0087.md) | T-0207 | M3 | architect | locally_verified | 金属价格表（二之四）：接上站内接口 GET /api/site/metal-prices（发出 TASK-0086 读出的价格，带 ETag 与缓存头，出错回 503），公开路由的夹具加这一项；合并后读者看得到，等 Owner 看过真实页面的截图、说可以上线才合并（从 TASK-0045 拆出，设计见 TASK-0045；页面 TASK-0060 从本卡的分支叠着做） | TASK-0086 |
| [TASK-0088](TASK-0088.md) | T-0207 | M3 | architect | locally_verified | 金属价格表（三之三）：抓世界银行每月发布的月度价格（同一版本 7 天内不重复下载，第一次连上一个月一起存），接入定时刷新，并去掉登记里世界银行的停用（读者看不到，verify 通过、独立审查没有阻断就合并，不等截图；从 TASK-0068 拆出，设计见 TASK-0068） | TASK-0068 |
| [TASK-0089](TASK-0089.md) | T-0207 | M3 | architect | locally_verified | 金属价格表（六之二）：抓俄罗斯银行每个工作日公布的金、银、铂、钯核算价与美元汇率（库里存卢布原数，第一次存最新两个定价日，被扣下的一天以后不再取），接入定时刷新，夹具进 Git；俄罗斯央行仍停用（读者看不到，verify 通过、独立审查没有阻断就合并，不等截图；从 TASK-0083 拆出，设计见 TASK-0083） | TASK-0083 |
| [TASK-0090](TASK-0090.md) | T-0207 | M3 | architect | locally_verified | 金属价格表（六之三）：俄罗斯央行的价格逐天和乌克兰央行的同类价格核对（差超过 5% 那一天整期扣下；乌克兰央行的数不存、不显示），并去掉登记里俄罗斯央行的停用（读者看不到，verify 通过、独立审查没有阻断就合并，不等截图；从 TASK-0083 拆出，设计见 TASK-0083） | TASK-0089 |
| [TASK-0092](TASK-0092.md) | T-0602 | M2 | architect | locally_verified | 法规线信源表进行业包——Owner 的 34 国及欧盟 156 条官方信源逐条核对，写明每条怎么采、现在能不能采、属于哪类、条款许不许显示中文全文（这一步还不采集） | — |
| [TASK-0093](TASK-0093.md) | T-0106 | M2 | architect | specified | 信源分资讯、法规两条业务线——信源加 lane，法规信源采到的材料照常存进材料库，但在交给处理的唯一入口就标成“跳过”，不进资讯的预筛、评分、归组、精选与公开；关于页的信源数只数资讯信源（读者看不到变化） | — |
| [TASK-0094](TASK-0094.md) | T-0115 | M2 | architect | locally_verified | 按信源表建法规信源——初始化脚本把信源表里有采集配置的条目建成法规线信源（停用、带负责人声明许可，中文全文许可照条款与 Owner 的选择），另给一个分批启用的脚本：每批限国家与条数，启用前当场试抓（读者看不到变化） | TASK-0092、TASK-0093、TASK-0055 |
| [TASK-0095](TASK-0095.md) | T-0112 | M2 | architect | locally_verified | 信源日期多认几种写法、RSS 修两处——日在前的数字日期，英、西、葡、法、荷、印尼、俄、德文月份名；RSS 的 +03:00 时区与相对链接；Atom 只有 updated 的可以声明用它（读者看到的是这些信源的稿子带上正确日期） | TASK-0055 |
| [TASK-0096](TASK-0096.md) | T-0512 | M1 | architect | locally_verified | 建立法规文书、版本、语言表达与不可变原件登记，重复取得幂等，旧文本恢复仍留新修订 | TASK-0093 |
| [TASK-0098](TASK-0098.md) | T-0512 | M3 | architect | locally_verified | 冻结法规公开读取契约与生成客户端，明确基本事实、完整解读和版本阅读状态 | TASK-0096 |
| [TASK-0099](TASK-0099.md) | T-0512 | M3 | architect | locally_verified | 实现法规列表详情与版本阅读页面，提供明确标注的本地合成状态预览 | TASK-0098 |
| [TASK-0100](TASK-0100.md) | T-0614 | M2 | architect | locally_verified | 让法规全文、归并、解读与核验复用现有模型网关 | TASK-0096 |
| [TASK-0101](TASK-0101.md) | T-0504 | M2 | architect | locally_verified | 接通法规全文后的分组核对、有界归并、联合身份解读与全篇语义核验 | TASK-0098、TASK-0100、TASK-0119、TASK-0120、TASK-0121 |
| [TASK-0107](TASK-0107.md) | T-0116 | M2 | architect | locally_verified | 每域名抓取节流、Crawl-delay 与持久延后 | TASK-0123 |
| [TASK-0110](TASK-0110.md) | T-0612 | M2 | architect | locally_verified | 来源日期核对记录不再每抓一次就重复记一遍——结果和上一条相同就不插新行，最后一次看到的时刻另记一处；已有的重复记录经 Owner 打字同意后一次性清掉（读者看不到变化，硬盘不再被它撑大） | TASK-0055 |
| [TASK-0111](TASK-0111.md) | T-0613 | M2 | architect | locally_verified | 资讯和法规分别领取采集任务，旧排队任务自动接续 | TASK-0093、TASK-0095、TASK-0110 |
| [TASK-0114](TASK-0114.md) | T-0192 | M2 | architect | specified | 记录六小时没有新文章入库的告警，按脱敏只读证据定位原因，再为实际故障单独安排修复与生产验收 | — |
| [TASK-0115](TASK-0115.md) | T-0192 | M2 | architect | locally_verified | 把首次入库静默提醒写成已知事实，只在确认新文章再次入库后报告恢复 | — |
| [TASK-0116](TASK-0116.md) | T-0507 | M1 | architect | locally_verified | 固定 Mozilla PDF.js 依赖，供法规原件在本地按页提取文字与定位 | TASK-0096 |
| [TASK-0117](TASK-0117.md) | T-0512 | M1 | architect | locally_verified | 在许可内取得法规原件与附件，按完整原件提取 HTML/PDF 节点并持久保存定位和缺口 | TASK-0096、TASK-0116 |
| [TASK-0119](TASK-0119.md) | T-0623 | M1 | architect | locally_verified | 从完整法规提取结果建立无损全文处理计划与稳定部分身份 | TASK-0096、TASK-0117 |
| [TASK-0120](TASK-0120.md) | T-0504 | M1 | architect | locally_verified | 校验 AI-17 逐部分事实与完整中文候选，完整覆盖才装配，程序检查不授予语义或运行资格 | TASK-0119 |
| [TASK-0121](TASK-0121.md) | T-0504 | M2 | architect | locally_verified | 连接法规全文计划、模型回执、部分检查点与完整中文装配 | TASK-0100、TASK-0117、TASK-0119、TASK-0120 |
| [TASK-0122](TASK-0122.md) | T-0151 | M3 | architect | implemented | 将法规公开资格和读取接口接到真实只读数据库投影 | TASK-0098、TASK-0100、TASK-0101、TASK-0121 |
| [TASK-0123](TASK-0123.md) | T-0614 | M2 | architect | locally_verified | 接通法规材料取得、全文、核验与可信发布的自动任务 | TASK-0117、TASK-0121、TASK-0101、TASK-0122、TASK-0126 |
| [TASK-0124](TASK-0124.md) | T-0521 | M3 | architect | locally_verified | 自动编制法规自然周月的固定版本汇总与覆盖说明 | TASK-0098、TASK-0122 |
| [TASK-0126](TASK-0126.md) | T-0504 | M2 | architect | locally_verified | 接通许可内PDF逐页渲染、视觉恢复与原页复核 | TASK-0100、TASK-0101、TASK-0116、TASK-0117、TASK-0121 |
| [TASK-0127](TASK-0127.md) | T-0301 | M3 | architect | locally_verified | 同次资讯结构化抽取的可信法域、当前修订公开索引与国家筛选 | — |
| [TASK-0128](TASK-0128.md) | T-0503 | M3 | architect | locally_verified | 将已核原文关系接到政策脉络导航 | TASK-0101、TASK-0122、TASK-0123 |
| [TASK-0129](TASK-0129.md) | T-0614 | M3 | architect | locally_verified | 分线分阶段持有者运行控制 | TASK-0121、TASK-0122 |
| [TASK-0130](TASK-0130.md) | T-0352 | M3 | architect | locally_verified | 补齐公开MCP法规、资讯详情、周月报告和主题工具 | TASK-0122、TASK-0128 |
| [TASK-0134](TASK-0134.md) | T-0511 | M2 | architect | locally_verified | 官方目录分页、持久扫描与结构完整回执 | TASK-0107、TASK-0132、TASK-0123、TASK-0124 |
| [TASK-0135](TASK-0135.md) | T-0704 | M3 | architect | locally_verified | 将事件和资讯报告的在途结果接入独立运行控制 | TASK-0129 |
| [TASK-0136](TASK-0136.md) | T-0704 | M3 | architect | implemented | 模型接入、安全密钥录入及既有网关解析 | TASK-0138 |
| [TASK-0137](TASK-0137.md) | T-0142 | M3 | architect | implemented | 生成月度用量历史与确定性汇总，明确费用及缓存记录缺项 | TASK-0064、TASK-0129 |
| [TASK-0138](TASK-0138.md) | T-0701 | M3 | architect | locally_verified | 具名账号与真实Owner及模型配置能力 | TASK-0129 |
| [TASK-0139](TASK-0139.md) | T-0142 | M3 | architect | locally_verified | 三指标费用熔断、预警、用量提示及Owner配置恢复 | TASK-0136、TASK-0137、TASK-0138 |
| [TASK-0140](TASK-0140.md) | T-0504 | M3 | architect | locally_verified | 法规质量资格绑定实际物理模型配置 | TASK-0139 |
| [TASK-0141](TASK-0141.md) | T-0704 | M3 | architect | locally_verified | 接通模型接入、连接测试和能力指派页面 | TASK-0136、TASK-0138 |
| [TASK-0142](TASK-0142.md) | T-0701 | M3 | architect | locally_verified | 接通新账号与运行控制权限，整理组合契约 | TASK-0129、TASK-0138、TASK-0141 |
| [TASK-0143](TASK-0143.md) | T-0431 | M3 | architect | locally_verified | 私网Owner只读运维MCP与专用脱敏数据连接 | TASK-0138、TASK-0137 |
| [TASK-0144](TASK-0144.md) | T-0511 | M3 | architect | locally_verified | 已登记官方目录的真实分页配置与完整轮次验证 | TASK-0134、TASK-0132 |
| [TASK-0145](TASK-0145.md) | T-0705 | M3 | architect | locally_verified | 网站资料编辑与受保护展示配置只读核对 | TASK-0138 |
| [TASK-0146](TASK-0146.md) | T-0703 | M3 | architect | locally_verified | 精选评分标准只读块与Owner校准协作 | TASK-0138 |
| [TASK-0147](TASK-0147.md) | T-0152 | M3 | architect | locally_verified | 用量报告与只读运维组合费用保护结果 | TASK-0137、TASK-0139、TASK-0143 |
| [TASK-0148](TASK-0148.md) | T-0143 | M3 | architect | implemented | 按环节显式主备模型与有界安全回退 | TASK-0136、TASK-0139、TASK-0140、TASK-0146 |
| [TASK-0149](TASK-0149.md) | T-0154 | M3 | architect | locally_verified | 契约生成直接调用已有格式化器，避免嵌套包运行器等待 | TASK-0145 |
| [TASK-0150](TASK-0150.md) | T-0101 | M3 | architect | locally_verified | 原始信源表只读对账和当前工程证据 | TASK-0134、TASK-0143 |
| [TASK-0152](TASK-0152.md) | T-0101 | M3 | architect | implemented | 已评测备用模型界面和模型页组合 | TASK-0148、TASK-0141、TASK-0146 |
| [TASK-0153](TASK-0153.md) | T-0702 | M3 | architect | locally_verified | 原表覆盖矩阵与有界导出 | TASK-0150、TASK-0144 |
| [TASK-0155](TASK-0155.md) | T-0101 | M3 | architect | locally_verified | 统一页面与既有检查夹具的组合修复 | TASK-0142、TASK-0145、TASK-0146、TASK-0152 |
| [TASK-0158](TASK-0158.md) | T-0101 | M3 | architect | implemented | 审计优化集成与独立功能复核 | — |
| [TASK-0159](TASK-0159.md) | T-0101 | M3 | architect | locally_verified | 登记审计涉及的契约变更 | — |
| [TASK-0170](TASK-0170.md) | T-0101 | M3 | architect | locally_verified | 更新真实新增schema和日期字段验证夹具 | — |
| [TASK-0180](TASK-0180.md) | T-0531 | M3 | architect | locally_verified | 法规中外文逐块对照 | TASK-0159 |
| [TASK-0181](TASK-0181.md) | T-0504 | M3 | architect | locally_verified | 法规自动流程恢复与配方更新 | TASK-0159 |
| [TASK-0182](TASK-0182.md) | T-0531 | M3 | architect | locally_verified | 法规正文语义格式保真 | TASK-0159 |
| [TASK-0183](TASK-0183.md) | T-0512 | M3 | architect | locally_verified | 法规原件结构化标注及XML | TASK-0159 |
| [TASK-0184](TASK-0184.md) | T-0504 | M3 | architect | locally_verified | 长条款安全分段 | TASK-0159 |
| [TASK-0185](TASK-0185.md) | T-0502 | M3 | architect | locally_verified | 独立基本事实日期与缺项 | TASK-0159 |
| [TASK-0186](TASK-0186.md) | T-0521 | M3 | architect | locally_verified | 报告筛选修订与要点影响 | TASK-0159 |
| [TASK-0187](TASK-0187.md) | T-0192 | M3 | architect | locally_verified | 质量资格到期扫描端口 | TASK-0159 |
| [TASK-0188](TASK-0188.md) | T-0602 | M3 | architect | locally_verified | 法规接入事实台账 | — |
| [TASK-0189](TASK-0189.md) | T-0504 | M3 | architect | locally_verified | 机关搜索与排除反证核验 | TASK-0159 |
| [TASK-0190](TASK-0190.md) | T-0502 | M3 | architect | locally_verified | 有证据的日期事件与补录 | TASK-0159 |
| [TASK-0191](TASK-0191.md) | T-0511 | M3 | architect | locally_verified | 当前目录成员公开资格 | TASK-0159 |
| [TASK-0192](TASK-0192.md) | T-0501 | M3 | architect | locally_verified | 合格官方语言切换 | TASK-0159 |
| [TASK-0193](TASK-0193.md) | T-0602 | M3 | architect | locally_verified | 按不同来源计法规报告检查覆盖 | TASK-0159 |
| [TASK-0194](TASK-0194.md) | T-0531 | M3 | architect | locally_verified | 验证法规桌面手机完整阅读与报告导航 | TASK-0180、TASK-0182、TASK-0185、TASK-0186、TASK-0192 |
| [TASK-0195](TASK-0195.md) | T-0115 | M3 | architect | locally_verified | 用真实官方XML核验并修复法规属性及表格保真 | TASK-0183 |
| [TASK-0196](TASK-0196.md) | T-0141 | M3 | architect | locally_verified | 保留法规模型回执后的许可变化错误身份 | TASK-0159 |
| [TASK-0197](TASK-0197.md) | T-0511 | M3 | architect | locally_verified | 将法规批次启用接到当前预览门并返回可操作冲突 | TASK-0159 |
| [TASK-0198](TASK-0198.md) | T-0623 | M3 | architect | locally_verified | 更新来源独立身份与目录读取的法规回归夹具 | TASK-0159 |
| [TASK-0199](TASK-0199.md) | T-0511 | M3 | architect | locally_verified | 核对目录政策日期证据与礼貌抓取续跑断言 | — |
| [TASK-0220](TASK-0220.md) | T-0101 | M3 | architect | locally_verified | 修复具名账号登录入口和权限检查连接互等 | — |
| [TASK-0221](TASK-0221.md) | T-0101 | M3 | architect | locally_verified | 接通新闻公开版本检查、收藏读取与新鲜度水位 | — |
| [TASK-0222](TASK-0222.md) | T-0101 | M3 | architect | implemented | 集成审计修复的公开资料与后台任务 | — |
| [TASK-0223](TASK-0223.md) | T-0101 | M3 | architect | locally_verified | 正式v3公开契约 | — |
| [TASK-0224](TASK-0224.md) | T-0101 | M3 | architect | locally_verified | v3新闻全库与精选同步投影 | — |
| [TASK-0225](TASK-0225.md) | T-0101 | M3 | architect | locally_verified | 获准正文分块与修订绑定 | — |
| [TASK-0226](TASK-0226.md) | T-0101 | M3 | architect | locally_verified | v3事件报告主题与更新出口 | — |
| [TASK-0227](TASK-0227.md) | T-0101 | M3 | architect | locally_verified | v3路由与生成OpenAPI | — |
| [TASK-0228](TASK-0228.md) | T-0101 | M3 | architect | locally_verified | v3公开行为回归 | — |
| [TASK-0229](TASK-0229.md) | T-0101 | M3 | architect | locally_verified | 读者及公开API交付记录 | — |
| [TASK-0230](TASK-0230.md) | T-0101 | M3 | architect | implemented | 接通公开读取限流和模块修复调度 | — |
| [TASK-0240](TASK-0240.md) | T-0101 | M3 | architect | locally_verified | 绑定谓词的SQL可证明性与索引 | — |
| [TASK-0241](TASK-0241.md) | T-0101 | M3 | architect | locally_verified | 公开查询消费固定绑定谓词 | — |
| [TASK-0242](TASK-0242.md) | T-0101 | M3 | architect | locally_verified | 反馈边界与站点法规角色路由补测 | — |
| [TASK-0243](TASK-0243.md) | T-0101 | M3 | architect | locally_verified | 正式v3实际公有角色全路由证据 | — |
| [TASK-0244](TASK-0244.md) | T-0101 | M3 | architect | implemented | 核对单角色数据库权限与模块迁移目录 | — |
| [TASK-0245](TASK-0245.md) | T-0101 | M3 | architect | implemented | 对齐来源日期和运行控制回归 | — |
| [TASK-0246](TASK-0246.md) | T-0101 | M3 | architect | implemented | 核对公开契约闭合路径及来源署名 | — |
| [TASK-0247](TASK-0247.md) | T-0101 | M3 | architect | locally_verified | 修复历史验证夹具与实际生产依赖解析核对 | — |
| [TASK-0248](TASK-0248.md) | T-0101 | M3 | architect | implemented | 干净版本验证的测试边界和格式收尾 | — |
| [TASK-0249](TASK-0249.md) | T-0101 | M3 | architect | locally_verified | 修复完整验证的种子身份核验与失败摘要 | — |
| [TASK-0252](TASK-0252.md) | T-0101 | M3 | architect | locally_verified | 日报RSS撤回与署名标识 | — |
| [TASK-0253](TASK-0253.md) | T-0101 | M3 | architect | locally_verified | RSS撤回复核缓存边界 | — |
| [TASK-0254](TASK-0254.md) | T-0101 | M3 | architect | locally_verified | 详情正文状态和本站首次公开 | — |
| [TASK-0255](TASK-0255.md) | T-0101 | M3 | architect | locally_verified | 相关代表稿与最新进展 | — |
| [TASK-0256](TASK-0256.md) | T-0101 | M3 | architect | locally_verified | 事件展开入口与后续读取状态 | — |
| [TASK-0257](TASK-0257.md) | T-0101 | M3 | architect | locally_verified | SPA反馈当前页来源 | — |
| [TASK-0258](TASK-0258.md) | T-0101 | M3 | architect | locally_verified | 独立复核读者行为验证 | — |
| [TASK-0259](TASK-0259.md) | T-0101 | M3 | architect | locally_verified | 第二轮读者修复证据 | — |
| [TASK-0280](TASK-0280.md) | T-0531 | M3 | architect | locally_verified | 统一法规列表详情与报告默认语言 | — |
| [TASK-0281](TASK-0281.md) | T-0532 | M3 | architect | locally_verified | 检索所有当前合格语言的完整中文 | — |
| [TASK-0282](TASK-0282.md) | T-0521 | M3 | architect | locally_verified | 正式公布日期按原精度参与报告归期 | — |
| [TASK-0283](TASK-0283.md) | T-0521 | M3 | architect | locally_verified | 恢复后补齐已结束的法规报告刊期 | — |
| [TASK-0284](TASK-0284.md) | T-0512 | M3 | architect | locally_verified | 严格识别法规原件编码并拒绝冲突 | — |
| [TASK-0285](TASK-0285.md) | T-0521 | M3 | architect | locally_verified | 政策报告出口接入独立撤回状态 | — |
| [TASK-0286](TASK-0286.md) | T-0101 | M3 | architect | locally_verified | 公开报告更正说明页面与v3出口 | — |
| [TASK-0290](TASK-0290.md) | T-0101 | M3 | architect | implemented | 第二轮功能补齐的共享契约与组合根 | — |
| [TASK-0291](TASK-0291.md) | T-0101 | M3 | architect | implemented | 首次公开证据与第二轮迁移角色集成 | — |
| [TASK-0292](TASK-0292.md) | T-0101 | M3 | architect | locally_verified | 第二轮独立复核的确认遗漏收尾 | — |
| [TASK-0293](TASK-0293.md) | T-0101 | M3 | architect | locally_verified | 公开署名接入现有公共许可证据链接 | — |
| [TASK-0310](TASK-0310.md) | T-0352 | M3 | architect | locally_verified | 机器事件摘要防止继承网站摘录并修正验收夹具 | — |
| [TASK-0313](TASK-0313.md) | T-0101 | M3 | architect | locally_verified | 统一资讯日期筛选的时间线北京日契约 | — |
| [TASK-0315](TASK-0315.md) | T-0101 | M3 | architect | locally_verified | 修复发布检查的可证明SQL识别 | — |
| [TASK-0316](TASK-0316.md) | T-0101 | M3 | architect | locally_verified | 消除新增跨模块数据库访问 | — |
| [TASK-0317](TASK-0317.md) | T-0101 | M3 | architect | locally_verified | 发布后保留正式版与回退版并清理无用文件 | — |
| [TASK-0318](TASK-0318.md) | T-0101 | M3 | architect | specified | 正式网站发布与产品验收 | TASK-0315、TASK-0316、TASK-0317、TASK-0319、TASK-0320、TASK-0321、TASK-0322、TASK-0323、TASK-0324、TASK-0325、TASK-0326、TASK-0327、TASK-0328、TASK-0329、TASK-0330、TASK-0331、TASK-0332、TASK-0333、TASK-0334、TASK-0335、TASK-0336、TASK-0338、TASK-0339 |
| [TASK-0319](TASK-0319.md) | T-0101 | M3 | architect | locally_verified | 预筛与报告读取通过所属模块端口 | — |
| [TASK-0320](TASK-0320.md) | T-0101 | M3 | architect | implemented | 读者反馈完整转发到专用飞书群 | — |
| [TASK-0321](TASK-0321.md) | T-0101 | M3 | architect | implemented | 反馈转发隐私说明与产品规则同步 | — |
| [TASK-0323](TASK-0323.md) | T-0701 | M3 | architect | locally_verified | 修复信源周报错误文本并核验九个失败来源 | — |
| [TASK-0324](TASK-0324.md) | T-0101 | M3 | architect | locally_verified | SQL绑定参数的结构化类型证明与绕过负例 | — |
| [TASK-0325](TASK-0325.md) | T-0101 | M3 | architect | locally_verified | SQL静态证明的恶意输入与类型擦除负例 | — |
| [TASK-0327](TASK-0327.md) | T-0101 | M3 | architect | locally_verified | 为私有查询与事件框架SQL值提供真实输入验证 | — |
| [TASK-0328](TASK-0328.md) | T-0101 | M3 | architect | locally_verified | 扩展纯数据契约的类型证明缓存 | — |
| [TASK-0329](TASK-0329.md) | T-0101 | M3 | architect | locally_verified | 明确反馈与翻译数据结果类型并校验飞书标识 | — |
| [TASK-0330](TASK-0330.md) | T-0101 | M3 | architect | locally_verified | 显式Postgres内建标量与ALL量词识别 | — |
| [TASK-0331](TASK-0331.md) | T-0101 | M3 | architect | locally_verified | 明确处理结果的写入字段和报告更正队列归属 | — |
| [TASK-0332](TASK-0332.md) | T-0101 | M3 | architect | locally_verified | 事件根事实通过公开时间端口判定 | — |
| [TASK-0334](TASK-0334.md) | T-0101 | M3 | architect | locally_verified | 日报无新增精选时发布今日无大事说明 | — |
| [TASK-0335](TASK-0335.md) | T-0101 | M3 | architect | locally_verified | 限定迁移SQL证明正负例与行为回归 | TASK-0339 |
| [TASK-0336](TASK-0336.md) | T-0101 | M3 | architect | locally_verified | 公开投影值与同步游标的确定输入 | — |
| [TASK-0337](TASK-0337.md) | T-0101 | M3 | architect | specified | 登记同次发布的维护与信源修复依赖 | — |
| [TASK-0338](TASK-0338.md) | T-0101 | M3 | architect | locally_verified | 删除已经消除的静态检查旧预算 | — |
| [TASK-0339](TASK-0339.md) | T-0101 | M3 | architect | locally_verified | 从完整函数体证明限定迁移SQL归属 | — |
| [TASK-0340](TASK-0340.md) | T-0101 | M3 | architect | locally_verified | 拒绝计算键和数组展开隐藏的SQL擦除 | — |
| [TASK-0341](TASK-0341.md) | T-0207 | M3 | architect | live_verified | 接入 Cochilco 基础金属日价并保留真实许可状态 | — |
| [TASK-0342](TASK-0342.md) | T-0207 | M3 | architect | live_verified | 确定性读取 Cochilco 日报现金报价并验证公开链路 | TASK-0341 |
| [TASK-0343](TASK-0343.md) | T-0101 | M3 | architect | live_verified | 发布后登记更新日志并隐藏反馈定位字段 | — |
| [TASK-0344](TASK-0344.md) | T-0101 | M3 | architect | live_verified | 修复关系判断回答截断导致重复付费 | — |
| [TASK-0345](TASK-0345.md) | T-0101 | M3 | architect | live_verified | 金属日价海外取件契约与受限免费函数 | — |
| [TASK-0346](TASK-0346.md) | T-0101 | M3 | architect | live_verified | 接通免费取价验证并统一上线验收 | — |
| [TASK-0348](TASK-0348.md) | T-0101 | M3 | architect | locally_verified | 仅澄清日报截稿时间并上线 | — |
| [TASK-0349](TASK-0349.md) | T-0323 | M3 | architect | locally_verified | 评分输入保留空正文材料的有效摘要 | — |
| [TASK-0350](TASK-0350.md) | T-0101 | M3 | architect | implemented | 日报确定性出刊与精选候选安全性修复 | — |
| [TASK-0351](TASK-0351.md) | T-0101 | M3 | architect | specified | 来源分级变化后复用两次分数更新近期精选 | — |
| [TASK-0353](TASK-0353.md) | T-0101 | M3 | architect | implemented | 新增经真实预览核验的矿企官网资讯信源（停用入库）并登记上线与替补 Q 卡片 | — |
| [TASK-0354](TASK-0354.md) | T-0101 | M3 | architect | implemented | 新增经真实预览核验的矿业媒体资讯信源（停用入库） | TASK-0353 |
| [TASK-0355](TASK-0355.md) | T-0101 | M3 | architect | implemented | 新增经真实预览核验的矿业协会、研究机构与技术装备资讯信源（停用入库） | TASK-0354 |
| [TASK-0356](TASK-0356.md) | T-0312 | M3 | architect | implemented | 同一事件多家报道收成一条精选和热点 | — |
| [TASK-0357](TASK-0357.md) | T-0101 | M3 | architect | implemented | 按已核实的采集行为补上日期解析、表单翻页和属性里的列表 | — |
| [TASK-0358](TASK-0358.md) | T-0101 | M3 | architect | implemented | 登记全功能对齐决定、差异矩阵和历史审计 | — |
| [TASK-0359](TASK-0359.md) | T-0101 | M3 | architect | implemented | 对齐服务次数控制、费用记账和未知结果恢复 | — |
| [TASK-0360](TASK-0360.md) | T-0101 | M3 | architect | locally_verified | 归组诊断、报告阅读、来源时间与搜索导航契约 | — |
| [TASK-0361](TASK-0361.md) | T-0101 | M3 | architect | implemented | 对齐资讯公开顺序与精选后全文翻译 | — |
| [TASK-0362](TASK-0362.md) | T-0101 | M3 | architect | specified | 补齐静态脚本与列式数据采集 | — |
| [TASK-0363](TASK-0363.md) | T-0101 | M3 | architect | specified | 对齐规则成刊、选材与半小时补刊 | — |
| [TASK-0364](TASK-0364.md) | T-0101 | M3 | architect | specified | 对齐事件关系、新信息准入与公开出口去重 | — |
| [TASK-0365](TASK-0365.md) | T-0101 | M3 | architect | specified | 对齐读者后台流程并修复审计问题 | — |
| [TASK-0366](TASK-0366.md) | T-0101 | M3 | architect | specified | 完成至少200个真正新增信源及重点矿企核验 | — |
| [TASK-0367](TASK-0367.md) | T-0101 | M3 | architect | implemented | 全站升级、集中验收与统一发布 | — |
| [TASK-0368](TASK-0368.md) | T-0101 | M3 | architect | integrated | 直接数据库连接入口契约 | — |
| [TASK-0369](TASK-0369.md) | T-0101 | M3 | architect | locally_verified | 文章分享图片资源与元数据契约 | — |
| [TASK-0370](TASK-0370.md) | T-0101 | M3 | architect | integrated | 反馈输入与请求次数契约 | — |
| [TASK-0371](TASK-0371.md) | T-0101 | M3 | architect | integrated | 引擎任务载荷与类型化队列契约 | — |
| [TASK-0372](TASK-0372.md) | T-0101 | M3 | architect | integrated | 补齐构建迁移与规则入口的根路径 | — |
| [TASK-0373](TASK-0373.md) | T-0101 | M3 | architect | integrated | 目录材料与模块处理交接契约 | — |
| [TASK-0374](TASK-0374.md) | T-0101 | M3 | architect | integrated | 聚合组未读成员契约 | — |
| [TASK-0375](TASK-0375.md) | T-0101 | M3 | architect | integrated | 手机导航模块声明契约 | — |
| [TASK-0376](TASK-0376.md) | T-0101 | M3 | architect | integrated | Agent答案与关于页动态展示契约 | — |
| [TASK-0377](TASK-0377.md) | T-0101 | M3 | architect | specified | 后台维护与反馈控制契约 | — |
| [TASK-0378](TASK-0378.md) | T-0101 | M3 | architect | integrated | 声明历史报告修订与首次出刊的兼容契约 | — |
| [TASK-0379](TASK-0379.md) | T-0101 | M3 | architect | locally_verified | 记录报告相关公开变化并提供可靠历史日期候选 | TASK-0378 |
| [TASK-0380](TASK-0380.md) | T-0101 | M3 | architect | integrated | 声明后台报告核对结果的有界查询 | TASK-0378 |
| [TASK-0381](TASK-0381.md) | T-0101 | M3 | architect | locally_verified | 持久记录报告修订请求与自然期间依赖 | TASK-0378、TASK-0379 |
| [TASK-0382](TASK-0382.md) | T-0101 | M3 | architect | locally_verified | 从原有巡检自动执行有界历史报告修订 | TASK-0378、TASK-0379、TASK-0381 |
| [TASK-0383](TASK-0383.md) | T-0101 | M3 | architect | locally_verified | 接入报告管理查询及按期核对界面 | TASK-0380、TASK-0381、TASK-0382 |
| [TASK-0384](TASK-0384.md) | T-0101 | M3 | architect | locally_verified | 修复运营权限范围及回执和价格的故障隔离 | TASK-0367 |
| [TASK-0385](TASK-0385.md) | T-0101 | M3 | architect | locally_verified | 恢复深页阅读并统一全部动态代表稿 | TASK-0367 |
| [TASK-0386](TASK-0386.md) | T-0101 | M3 | architect | locally_verified | 启用有容量保护的每日本地备份 | TASK-0367 |
| [TASK-0387](TASK-0387.md) | T-0101 | M3 | architect | locally_verified | 在既有发布锁下压缩重复程序归档和过期构建缓存 | TASK-0367 |
| [TASK-0388](TASK-0388.md) | T-0101 | M3 | architect | locally_verified | 以实际发布记录改进读者更新说明 | TASK-0367 |
| [TASK-0389](TASK-0389.md) | T-0101 | M3 | architect | implemented | 从独立样本修复相关卡片污染及必要信息条件遗漏 | TASK-0367 |
| [TASK-0390](TASK-0390.md) | T-0101 | M3 | architect | implemented | 分开来源属性和新闻类别并提供桌面横向操作 | TASK-0367 |
| [TASK-0391](TASK-0391.md) | T-0101 | M3 | architect | implemented | 限定备用接入的可用性冷却范围到实际模型配置 | TASK-0367 |
| [TASK-0392](TASK-0392.md) | T-0101 | M3 | architect | locally_verified | 证明历史程序覆盖恢复并保留原镜像缺失记录 | TASK-0367、TASK-0387 |
| [TASK-0393](TASK-0393.md) | T-0101 | M3 | architect | locally_verified | 验证恢复配方边界与维护依赖安装中断 | TASK-0392 |
| [TASK-0394](TASK-0394.md) | T-0101 | M3 | architect | locally_verified | 更新命中安全公告的依赖并封住MCP解析输入缺口 | TASK-0367 |
| [TASK-0395](TASK-0395.md) | T-0101 | M3 | architect | integrated | 登记第一阶段四项优先修复与评分审阅任务 | — |
| [TASK-0396](TASK-0396.md) | T-0101 | M3 | architect | locally_verified | 修复国别作用地筛选与全文提及混用 | — |
| [TASK-0397](TASK-0397.md) | T-0101 | M3 | architect | locally_verified | 准备历史摘要更正并验证既有无损路径 | — |
| [TASK-0398](TASK-0398.md) | T-0101 | M3 | architect | locally_verified | 显示采集当前等待并纳入既有运行汇总 | — |
| [TASK-0399](TASK-0399.md) | T-0101 | M3 | architect | locally_verified | 修正周报历史费用回填和估算说明 | — |
| [TASK-0400](TASK-0400.md) | T-0101 | M3 | architect | locally_verified | 整合第一阶段优先修复与评分审阅稿 | TASK-0396、TASK-0397、TASK-0398、TASK-0399 |
| [TASK-0401](TASK-0401.md) | T-0101 | M3 | architect | integrated | 隔离验证评分B与阿根廷国别精选 | TASK-0402 |
| [TASK-0402](TASK-0402.md) | T-0101 | M3 | architect | integrated | 冻结B与AR候选标准及独立样本判定 | — |
| [TASK-0403](TASK-0403.md) | T-0101 | M3 | architect | integrated | 验证隔离评分与国别提名的恢复和边界 | TASK-0401、TASK-0402 |
| [TASK-0404](TASK-0404.md) | T-0101 | M3 | architect | locally_verified | 保留模型后台历史费用原始依据 | — |
| [TASK-0405](TASK-0405.md) | T-0101 | M3 | architect | locally_verified | 阻止法规暂停阶段持续发现和重复入队 | — |
| [TASK-0406](TASK-0406.md) | T-0101 | M3 | architect | locally_verified | 核实第二阶段法规行情品牌与订阅的研究依据 | — |
| [TASK-0407](TASK-0407.md) | T-0101 | M3 | architect | locally_verified | 重发前重新核对当前内容和目标资格 | — |
| [TASK-0408](TASK-0408.md) | T-0101 | M3 | architect | integrated | 声明投递恢复原因和人工放弃的兼容字段 | — |
| [TASK-0409](TASK-0409.md) | T-0101 | M3 | architect | locally_verified | 恢复明确未发和限流拒收的内容投递 | TASK-0408、TASK-0407 |
| [TASK-0410](TASK-0410.md) | T-0101 | M3 | architect | locally_verified | 核对双国地理异常与历史摘要预览绑定 | — |
| [TASK-0411](TASK-0411.md) | T-0101 | M3 | architect | integrated | 声明历史背景候选与故事页兼容契约 | — |
| [TASK-0412](TASK-0412.md) | T-0101 | M3 | architect | locally_verified | 核对阿根廷官方来源三十天覆盖窗口 | — |
| [TASK-0413](TASK-0413.md) | T-0101 | M3 | architect | integrated | 声明缓存命中与绝对时段计价兼容契约 | — |
| [TASK-0414](TASK-0414.md) | T-0101 | M3 | architect | locally_verified | 确认并保存独立历史背景证明 | TASK-0411、TASK-0415、TASK-0422 |
| [TASK-0415](TASK-0415.md) | T-0101 | M3 | architect | locally_verified | 读取已核原文锚点历史候选并保存安全引用 | TASK-0411、TASK-0422 |
| [TASK-0416](TASK-0416.md) | T-0101 | M3 | architect | locally_verified | 按调用前价格快照结算缓存及绝对时段费用 | TASK-0413 |
| [TASK-0417](TASK-0417.md) | T-0101 | M3 | architect | locally_verified | 记录公开访问测量与真实阅读验收条件 | — |
| [TASK-0418](TASK-0418.md) | T-0101 | M3 | architect | locally_verified | 无损编辑缓存命中与绝对时段价格 | TASK-0413 |
| [TASK-0419](TASK-0419.md) | T-0101 | M3 | architect | locally_verified | 展示投递等待与人工核对状态 | TASK-0408 |
| [TASK-0420](TASK-0420.md) | T-0101 | M3 | architect | locally_verified | 接通历史背景持久任务并即时响应人工控制 | TASK-0411、TASK-0415、TASK-0422 |
| [TASK-0421](TASK-0421.md) | T-0101 | M3 | architect | locally_verified | 在事件页独立展示当前有效历史背景 | TASK-0411、TASK-0415 |
| [TASK-0422](TASK-0422.md) | T-0101 | M3 | architect | locally_verified | 声明历史锚点提取器类型 | — |
| [TASK-0423](TASK-0423.md) | T-0101 | M3 | architect | locally_verified | 旧账接管保留历史未知费用 | TASK-0416 |
| [TASK-0424](TASK-0424.md) | T-0101 | M3 | architect | locally_verified | 从项目原文明示括号缩写召回历史别名 | TASK-0411、TASK-0415、TASK-0422 |
| [TASK-0425](TASK-0425.md) | T-0101 | M3 | architect | locally_verified | 阿根廷优化集成及发布观察交接 | TASK-0404、TASK-0405、TASK-0407、TASK-0409、TASK-0414、TASK-0415、TASK-0416、TASK-0418、TASK-0419、TASK-0420、TASK-0421、TASK-0423、TASK-0424、TASK-0426 |
| [TASK-0426](TASK-0426.md) | T-0101 | M3 | architect | locally_verified | 人工决定在同一事务撤销历史背景引用 | TASK-0414、TASK-0415、TASK-0420 |
| [TASK-0427](TASK-0427.md) | T-0101 | M3 | architect | implemented | 第一阶段统一依据与完整迁移承接 | — |
| [TASK-0428](TASK-0428.md) | T-0101 | M3 | architect | locally_verified | 修复资讯报告自动补刊与空期恢复 | — |
| [TASK-0429](TASK-0429.md) | T-0101 | M3 | architect | integrated | 区分价格检查与发布期并合并重复提醒 | — |
| [TASK-0430](TASK-0430.md) | T-0101 | M3 | architect | locally_verified | 补齐固定上游通用模块扩展契约 | — |
| [TASK-0431](TASK-0431.md) | T-0101 | M3 | architect | integrated | 保存来源检查结果并区分报价所属期 | — |
| [TASK-0432](TASK-0432.md) | T-0101 | M3 | architect | locally_verified | 接通通用模块的运行检查与维护 | — |
| [TASK-0433](TASK-0433.md) | T-0101 | M3 | architect | locally_verified | 统一矿业评分核对与国别模块纠偏 | — |
| [TASK-0434](TASK-0434.md) | T-0101 | M3 | architect | locally_verified | 统一国别通知范围契约与事务读取端口 | — |
| [TASK-0436](TASK-0436.md) | T-0101 | M3 | architect | implemented | 修复明确省州名被国家证据校验丢弃 | — |
| [TASK-0437](TASK-0437.md) | T-0101 | M3 | architect | implemented | 价格运行检查归入已安装金属模块 | — |
| [TASK-0439](TASK-0439.md) | T-0101 | M3 | architect | implemented | 阅读返回回归绑定真实点击位置 | — |
| [TASK-0440](TASK-0440.md) | T-0101 | M3 | architect | locally_verified | 核对最新DeepSeek Flash并修复缓存前缀与跨日复用 | — |
| [TASK-0441](TASK-0441.md) | T-0101 | M3 | architect | locally_verified | 接通统一精选的国别投递与重试复核 | — |
| [TASK-0442](TASK-0442.md) | T-0101 | M3 | architect | locally_verified | 后台展示和修改通知国家范围 | — |
| [TASK-0443](TASK-0443.md) | T-0101 | M3 | architect | locally_verified | 接通网页模块的页面部件与常用入口 | — |
| [TASK-0444](TASK-0444.md) | T-0101 | M3 | architect | integrated | 主题部件和后台模块数据的兼容出口契约 | — |
| [TASK-0445](TASK-0445.md) | T-0101 | M3 | architect | implemented | 修复新公告阻断的运行依赖 | — |
| [TASK-0446](TASK-0446.md) | T-0101 | M3 | architect | locally_verified | 国家主题按当前作用地归类并统一计数 | — |
| [TASK-0447](TASK-0447.md) | T-0101 | M3 | architect | live_verified | 公开更新日志只保留读者变化并阻止运营说明混入 | — |
| [TASK-0448](TASK-0448.md) | T-0101 | M3 | architect | locally_verified | 接通内容与报告变更的事务模块事件 | — |
| [TASK-0449](TASK-0449.md) | T-0101 | M3 | architect | integrated | RSS提示和机器阅读扩展的兼容端口 | — |
| [TASK-0450](TASK-0450.md) | T-0101 | M3 | architect | locally_verified | 接通模块Agent能力与请求观察 | — |
| [TASK-0451](TASK-0451.md) | T-0101 | M3 | architect | locally_verified | JSON模块提示与主题标识的兼容契约 | — |
| [TASK-0452](TASK-0452.md) | T-0101 | M3 | architect | locally_verified | 接通RSS提示与机器阅读模块说明 | — |
| [TASK-0453](TASK-0453.md) | T-0101 | M3 | architect | locally_verified | 接通后台模块计数与运行面板 | — |
| [TASK-0454](TASK-0454.md) | T-0101 | M3 | architect | locally_verified | 接通机器JSON出口提示并保持当前资格与缓存隔离 | — |
| [TASK-0455](TASK-0455.md) | T-0101 | M3 | architect | locally_verified | 接通主题页模块索引与当前资格重核 | — |
| [TASK-0456](TASK-0456.md) | T-0101 | M3 | architect | locally_verified | 接通主题网页部件与安全页面摘要 | — |
| [TASK-0457](TASK-0457.md) | T-0101 | M3 | architect | locally_verified | 接通矿企主题文字标识与获准模块资产呈现 | — |
| [TASK-0458](TASK-0458.md) | T-0101 | M3 | architect | locally_verified | 接通反馈模块来源标识的既有封禁查询 | — |
| [TASK-0160](TASK-0160.md) | T-0101 | M3 | content | locally_verified | 隔离来源材料并保留原文恢复修订 | — |
| [TASK-0172](TASK-0172.md) | T-0101 | M3 | content | locally_verified | 提供所有权明确的材料与关系证据读端口 | — |
| [TASK-0161](TASK-0161.md) | T-0101 | M3 | gateway | locally_verified | 强制主模型许可核验 | — |
| [TASK-0162](TASK-0162.md) | T-0101 | M3 | gateway | locally_verified | 跨模型保留未知费用屏障 | — |
| [TASK-0174](TASK-0174.md) | T-0101 | M3 | gateway | locally_verified | 评测只使用当前可授权原材料 | — |
| [TASK-0176](TASK-0176.md) | T-0101 | M3 | gateway | locally_verified | 合成费用与回执回归显式登记 | — |
| [TASK-0251](TASK-0251.md) | T-0101 | M3 | gateway | locally_verified | 补齐备用模型回归的当前材料许可夹具 | — |
| [TASK-0303](TASK-0303.md) | T-0101 | M3 | gateway | locally_verified | Jina预览未知回执跨恢复与新任务保护 | — |
| [TASK-0164](TASK-0164.md) | T-0101 | M3 | news | locally_verified | 校验事件关系原文与置信度 | — |
| [TASK-0165](TASK-0165.md) | T-0101 | M3 | news | locally_verified | 来源修订后重判自动关系 | — |
| [TASK-0173](TASK-0173.md) | T-0101 | M3 | news | locally_verified | 保留原文可核验的公司背景 | — |
| [TASK-0009](TASK-0009.md) | T-0008 | M0 | ops | specified | 搭部署骨架与本地预发：按角色的 Compose、两个主机名、回滚也验收 | TASK-0004、TASK-0006 |
| [TASK-0012](TASK-0012.md) | T-0013 | M0 | ops | specified | 环境与容量基准：境外可达性、对象存储、审计可达性与 Node 26 矩阵，得出部署规格建议 | TASK-0002 |
| [TASK-0322](TASK-0322.md) | T-0008 | M3 | ops | live_verified | 清理历史程序与构建缓存并启用发布后保留机制 | — |
| [TASK-0132](TASK-0132.md) | T-0511 | M3 | policy | locally_verified | 以实际官方页面接通首批法规取得配置并识别缺失附件引用 | TASK-0092、TASK-0094、TASK-0123 |
| [TASK-0167](TASK-0167.md) | T-0101 | M3 | private | locally_verified | 记录处理完成并清除逾期标识 | — |
| [TASK-0263](TASK-0263.md) | T-0101 | M3 | private | locally_verified | 后台来源归档状态和确认 | — |
| [TASK-0264](TASK-0264.md) | T-0101 | M3 | private | locally_verified | 反馈请求持久幂等与载荷冲突 | — |
| [TASK-0265](TASK-0265.md) | T-0101 | M3 | private | locally_verified | 反馈HTTP稳定提交键 | — |
| [TASK-0298](TASK-0298.md) | T-0101 | M3 | private | locally_verified | 反馈实际截图与本站页面校验 | — |
| [TASK-0299](TASK-0299.md) | T-0101 | M3 | private | locally_verified | 反馈持久小时和每日额度 | — |
| [TASK-0131](TASK-0131.md) | T-0353 | M3 | publish | locally_verified | 接通法规摘要订阅、站点地图与公开发现入口 | TASK-0098、TASK-0122、TASK-0124 |
| [TASK-0163](TASK-0163.md) | T-0101 | M3 | publish | locally_verified | 下架与公开审计原子提交 | — |
| [TASK-0166](TASK-0166.md) | T-0101 | M3 | publish | locally_verified | 撤回报告综合内容和目录摘要 | — |
| [TASK-0169](TASK-0169.md) | T-0101 | M3 | publish | locally_verified | 分离人工修订草稿发布和冲突 | — |
| [TASK-0177](TASK-0177.md) | T-0101 | M3 | publish | locally_verified | 保留既有编辑事件与译文回归场景 | — |
| [TASK-0266](TASK-0266.md) | T-0101 | M3 | publish | locally_verified | 撤回记录和成员快照 | — |
| [TASK-0267](TASK-0267.md) | T-0101 | M3 | publish | locally_verified | 多原因撤回的公开投影 | — |
| [TASK-0268](TASK-0268.md) | T-0101 | M3 | publish | locally_verified | 事件发展线报告撤回后台动作 | — |
| [TASK-0269](TASK-0269.md) | T-0101 | M3 | publish | locally_verified | 报告独立撤回覆盖公开出口 | — |
| [TASK-0270](TASK-0270.md) | T-0101 | M3 | publish | locally_verified | 报告更正持久任务和修订说明 | — |
| [TASK-0271](TASK-0271.md) | T-0101 | M3 | publish | locally_verified | 更正报告复用受控worker网关 | — |
| [TASK-0272](TASK-0272.md) | T-0101 | M3 | publish | locally_verified | 报告引用当前事实和综合失效 | — |
| [TASK-0326](TASK-0326.md) | T-0101 | M3 | publish | locally_verified | 公开查询使用静态谓词与数据参数 | — |
| [TASK-0008](TASK-0008.md) | T-0007 | M0 | qa | specified | 搭测试基建：假模型服务、录制信源响应、固定时钟与浏览器冒烟 | TASK-0006 |
| [TASK-0179](TASK-0179.md) | T-0101 | M3 | qa | locally_verified | 所有权开工快照差异与回归证据 | — |
| [TASK-0250](TASK-0250.md) | T-0101 | M3 | qa | locally_verified | 修复端到端登录nonce夹具与键盘就绪时序 | — |
| [TASK-0273](TASK-0273.md) | T-0101 | M3 | qa | locally_verified | 第二轮处理链综合回归 | — |
| [TASK-0274](TASK-0274.md) | T-0101 | M3 | qa | locally_verified | 第二轮处理链证据与边界 | — |
| [TASK-0300](TASK-0300.md) | T-0101 | M3 | qa | locally_verified | 反馈新前置的既有HTTP回归 | — |
| [TASK-0304](TASK-0304.md) | T-0101 | M3 | qa | locally_verified | 自动采集合成预览夹具遵守结束与重复窗口 | — |
| [TASK-0175](TASK-0175.md) | T-0101 | M3 | runtime | locally_verified | 区分停止发送与付费回执写回生命周期 | — |
| [TASK-0168](TASK-0168.md) | T-0101 | M3 | sources | locally_verified | 验证来源启用与配置草稿 | — |
| [TASK-0178](TASK-0178.md) | T-0101 | M3 | sources | locally_verified | 预览启用与完整采集合成闭环 | — |
| [TASK-0260](TASK-0260.md) | T-0101 | M3 | sources | locally_verified | 配置切换保留不受影响检查点 | — |
| [TASK-0261](TASK-0261.md) | T-0101 | M3 | sources | locally_verified | 信源不可逆归档与历史保留 | — |
| [TASK-0262](TASK-0262.md) | T-0101 | M3 | sources | locally_verified | 归档采集和预览提交栅栏 | — |
| [TASK-0296](TASK-0296.md) | T-0101 | M3 | sources | locally_verified | 同配置在途来源预览去重 | — |
| [TASK-0297](TASK-0297.md) | T-0101 | M3 | sources | locally_verified | 采集提交前重核单源暂停 | — |
| [TASK-0301](TASK-0301.md) | T-0101 | M3 | sources | locally_verified | 单连接来源预览与中断恢复 | — |
| [TASK-0302](TASK-0302.md) | T-0101 | M3 | sources | locally_verified | 来源预览执行时限贯穿真实抓取 | — |
| [TASK-0133](TASK-0133.md) | T-0704 | M3 | web | locally_verified | 在既有私有用量页面展示两条业务线的运行暂停与恢复 | TASK-0129 |
| [TASK-0171](TASK-0171.md) | T-0101 | M3 | web | locally_verified | 接通信源异步预览与配置草稿 | — |
| [TASK-0200](TASK-0200.md) | T-0101 | M3 | web | implemented | 收藏只存引用和满额错误 | — |
| [TASK-0201](TASK-0201.md) | T-0101 | M3 | web | implemented | 收藏公开解析与重新核对 | — |
| [TASK-0202](TASK-0202.md) | T-0101 | M3 | web | implemented | 统一法规收藏上限 | — |
| [TASK-0203](TASK-0203.md) | T-0101 | M3 | web | implemented | 资讯内容版本核对 | — |
| [TASK-0204](TASK-0204.md) | T-0101 | M3 | web | implemented | 全库筛选与精确分页 | — |
| [TASK-0205](TASK-0205.md) | T-0101 | M3 | web | implemented | 资讯筛选和跳页入口 | — |
| [TASK-0206](TASK-0206.md) | T-0101 | M3 | web | implemented | 正文目录和核实依据入口 | — |
| [TASK-0207](TASK-0207.md) | T-0101 | M3 | web | implemented | 手机收藏与日期折叠 | — |
| [TASK-0208](TASK-0208.md) | T-0101 | M3 | web | implemented | 五项手机导航 | — |
| [TASK-0209](TASK-0209.md) | T-0101 | M3 | web | implemented | 报告缺期与综合状态 | — |
| [TASK-0210](TASK-0210.md) | T-0101 | M3 | web | implemented | 反馈内容和联系方式 | — |
| [TASK-0211](TASK-0211.md) | T-0101 | M3 | web | implemented | 全部动态事件聚合查询 | — |
| [TASK-0212](TASK-0212.md) | T-0101 | M3 | web | implemented | 法规独立搜索分区 | — |
| [TASK-0213](TASK-0213.md) | T-0101 | M3 | web | implemented | 主题内筛选 | — |
| [TASK-0214](TASK-0214.md) | T-0101 | M3 | web | implemented | 五轴主题显示 | — |
| [TASK-0215](TASK-0215.md) | T-0101 | M3 | web | implemented | 跟随系统实时变化 | — |
| [TASK-0216](TASK-0216.md) | T-0101 | M3 | web | implemented | 更新月份锚点 | — |
| [TASK-0217](TASK-0217.md) | T-0101 | M3 | web | locally_verified | 读者回归行为验证 | — |
| [TASK-0218](TASK-0218.md) | T-0101 | M3 | web | implemented | 公开查询回归验证 | — |
| [TASK-0294](TASK-0294.md) | T-0101 | M3 | web | locally_verified | 事件引用收藏与当前资格解析 | — |
| [TASK-0295](TASK-0295.md) | T-0101 | M3 | web | locally_verified | 事件及报告复制链接与系统分享 | — |
| [TASK-0311](TASK-0311.md) | T-0101 | M3 | web | locally_verified | 读者首次版本基线与浏览器用例清理 | — |
| [TASK-0312](TASK-0312.md) | T-0101 | M3 | web | locally_verified | 流式路由测试等待页面提交而非网络流关闭 | — |
| [TASK-0314](TASK-0314.md) | T-0101 | M3 | web | locally_verified | 统一日期筛选实现与北京日边界回归 | — |
| [TASK-0333](TASK-0333.md) | T-0101 | M3 | web | locally_verified | 分享浏览器测试等待首次公开内容核对 | — |
| [TASK-0347](TASK-0347.md) | T-0101 | M3 | web | locally_verified | 提示反馈最低字数和剩余字数 | — |
