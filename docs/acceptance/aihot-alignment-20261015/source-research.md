# 新增信源与 8 家重点矿企：只读研究

核验开始：2026-10-15T12:35:46Z。研究只访问公开 robots、列表和元数据，不调用模型，不访问生产、不启用来源、不下载大批全文。HTTP 使用 curl 默认 TLS 验证与 AIMiningPolicyBot 身份；系统 Python 的证书错误不能作为网站不可用证据。

## 去重与状态口径

- 基线：本工作区 `industry/sources.json`（147 条）、`docs/data/source-targets-320.json`（320 个既有规划目标）；同时排除 `agent/architect/TASK-0357-collection-capabilities:industry/sources.json`（321 条）已经记录的来源域名。域名归一化合并 www 与子域，同机构不同站仍需人工实体去重。
- 草稿 321 条与当前主分支 147 条相差 174 条配置，不等于 174 个通过自然采集的新来源；其中有交易所入口、既有规划重复等。用户报告的运行库 148 个已启用本次没有读取生产核验。
- `/tmp/aimine-work/final/batch_results.json` 保存上一轮单源样例与预览回执路径；草稿 `docs/acceptance/news-sources-20261014/` 保存同批结论。历史通过不能代替本次或上线后的采集证明。
- 下文“候选”仅表示公开列表可取得标题、链接与日期样例；未经仓库最终配置 preview、生产启用及自然采集，不计入最终 200。

## 重点矿企：当前证据与建议

| 公司 | 实时只读证据 | 下一步适配与边界 |
|---|---|---|
| 天齐锂业 | [官网 robots](https://www.tianqilithium.com/robots.txt) 200，`User-agent: * / Disallow: /`。深交所 robots 200 空文档。 | 不访问官网。历史深交所 `https://www.szse.cn/api/disc/announcement/annList` POST 请求，stock=[002466]、channelCode=[listedNotice_disc]、pageSize=10、pageNum=1，数据路径 data、title、publishTime、attachPath。既有样例有标题与真实 PDF 链接，`2026-10-10 00:00:00` 缺时区；应采用明确 +08:00 与日期精度配置后重新预览，不能泛化为所有缺时区来源自动补北京时间。 |
| 必和必拓 BHP | [官网 robots](https://www.bhp.com/robots.txt) 403 Access Denied；[ASX robots](https://www.asx.com.au/robots.txt) 200，禁止 /search*。本次旧候选 /asx/1/company/BHP/announcements?count=5&market_sensitive=false 为404 URI not found。 | 官网保持 blocked。历史 ASX 曾取得标题日期但无公告URL，当前旧入口失效；必须先验证真实当前API和返回公告地址，不能凭编号拼造 URL，不访问被robots禁止的搜索路径。 |
| 英美资源 Anglo American | [官网 robots](https://www.angloamerican.com/robots.txt) 为 Cloudflare blocked 页面；[LSE robots](https://www.londonstockexchange.com/robots.txt) 200。 | 官网 blocked；LSE公司页历史没有可采新闻列表。尚无当前已验证、能直接配置的入口，不以第三方镜像替代官网。 |
| 嘉能可 Glencore | [robots](https://www.glencore.com/robots.txt)允许目标路径；[新闻列表](https://www.glencore.com/media-and-insights/news)200，`:articles`静态属性含单引号对象数组。 | 静态解析属性，禁止eval/执行脚本。数组字段title、link、date；base URL=https://www.glencore.com，date为DD/MM/YYYY且仅日期精度。首条见下方样例。可立即做解析器fixture与最终配置预览。 |
| 南方铜业 Southern Copper | [官网 robots](https://southerncoppercorp.com/robots.txt)403；[SEC robots](https://data.sec.gov/robots.txt)404；[SEC提交列表](https://data.sec.gov/submissions/CIK0001001838.json)200，name=SOUTHERN COPPER CORP/。 | SEC filings.recent 为等长列数组，应先转行。filingDate保持仅日期，primaryDocument为文件名，accessionNumber为申报编号。只纳入适用报告类型，Form4等股东交易不当作主营新闻。文件URL构造必须按SEC官方规则，并另查www.sec.gov robots及真实可取得性。 |
| 纽蒙特 Newmont | [robots](https://www.newmont.com/robots.txt)200，Crawl-delay:10、Allow:/；[新闻页](https://www.newmont.com/investors/news-release/default.aspx)仍403 Just a moment。 | robots恢复不等于正文恢复，不绕过挑战。SEC CIK0001164727可作官方披露候选，实际样例见后文。 |
| 巴里克 Barrick | [robots](https://www.barrick.com/robots.txt)200，Crawl-delay:10、Allow:/；[新闻页](https://www.barrick.com/English/news/default.aspx)仍403 Just a moment。 | 保持新闻入口blocked；SEC CIK0000756894可作官方披露候选，实际样例见后文。 |
| SQM | [投资者站robots](https://ir.sqm.com/robots.txt)403 Access Denied。 | 不访问IR列表；SEC CIK0000909037作为披露候选，实际样例见后文。主站社区新闻不冒充矿业经营披露。 |

嘉能可样例（2026-10-15T12:36:28Z）：`title=Glencore begins trading on Australian Securities Exchange`，`link=/media-and-insights/news/glencore-begins-trading-on-asx`，`date=14/10/2026`；第二条为 `Glencore receives RIGI approval for Agua Rica (MARA)`，`date=02/10/2026`。需要对完整属性解码后按字符串/布尔/数字/null/对象/数组的静态语法解析，不接受函数或表达式。

南方铜业 SEC 样例：2026-09-25、form=4、accessionNumber=0001284489-26-000040、primaryDocument=xslF345X06/form4-09252026_070953.xml；第二条2026-09-16、form=SD、primaryDocument=scco-20251231xsd.htm。它们证明列数组可读，不代表新闻内容合格。


## 重点矿企追加实时核验（2026-10-15T12:41:19Z）

- 天齐深交所 POST 已实际返回200和3条有效对象。首条 `天齐锂业：H股公告：董事会会议通告`，`publishTime=2026-10-10 00:00:00`，`attachPath=/disc/disk03/finalpage/2026-10-10/de99b02f-3d82-4733-a7b2-67f5b6589dc6.PDF`。这是列表证据；尚未请求PDF正文。
- [ASX 当前BHP公告API](https://asx.api.markitdigital.com/asx-research/1.0/companies/BHP/announcements?count=5&marketSensitive=false)200，`data.displayName=BHP GROUP LIMITED`；其robots为404。首条`Notification of cessation of securities - BHP`、`date=2026-10-14T05:31:59.000Z`、`documentKey=2924-03148341-3A704093`，但 `url` 空字符串；全部5条均无URL。**未解决真实公告链接，不可接入计数**。需要从ASX官方前端实际使用的documentKey解析流程取得可核URL。
- [SEC官方robots](https://www.sec.gov/robots.txt)200，明确允许 `/Archives/edgar/data`，禁止 `/cgi-bin`、`/search`等；不得使用被禁止的旧公司搜索RSS接口。
- [纽蒙特SEC清单](https://data.sec.gov/submissions/CIK0001164727.json)200，`name=NEWMONT Corp /DE/`；样例2026-10-02、Form4、编号0001936354-26-000022。列表可读，但Form4须排除，不作为业务新闻。
- [巴里克SEC清单](https://data.sec.gov/submissions/CIK0000756894.json)200，`name=BARRICK MINING CORP`；可用披露样例2026-08-17、form=6-K、编号0001193125-26-353144、primaryDocument=d182096d6k.htm。
- [SQM SEC清单](https://data.sec.gov/submissions/CIK0000909037.json)200，`name=CHEMICAL & MINING CO OF CHILE INC`；可用披露样例2026-08-26、form=6-K、编号0000909037-26-000036、primaryDocument=a6-ksqmxprapprovalofinteri.htm。
- SEC清单中的 `primaryDocDescription` 常只为“6-K”等表格类型，不应伪造新闻标题。可展示“公司名 + 表格类型 + 申报日期”作为明确标识的披露标题；正文、附件读取和新闻提炼另走已有处理及权限机制。先向集成人确认最终配置支持标题模板/类型过滤，否则只有列式数组转行仍不能完成高质量接入。


## SEC真实文件URL验证

2026-10-15只执行HEAD、未下载正文，以下四条均为HTTP200、Content-Type:text/html：

- [南方铜业8-K，2026-07-22](https://www.sec.gov/Archives/edgar/data/1001838/000110465926085515/scco-20260721x8k.htm)。
- [纽蒙特8-K，2026-08-20](https://www.sec.gov/Archives/edgar/data/1164727/000110465926099237/tm2623668d1_8k.htm)。
- [巴里克6-K，2026-08-17](https://www.sec.gov/Archives/edgar/data/756894/000119312526353144/d182096d6k.htm)。
- [SQM 6-K，2026-08-26](https://www.sec.gov/Archives/edgar/data/909037/000090903726000036/a6-ksqmxprapprovalofinteri.htm)。

对应路径构造已用真实返回值与实际HTTP核对：CIK去前导0、accessionNumber去连字符、primaryDocument原路径。仅把带连字符编号放入现有urlTemplate会错；应在受限静态列转换中明确处理，不引入表达式执行。文件有URL不等于全文权限或解析已通过。


## 新候选：58 个近期入口，另有 2 个更新偏慢入口

本节所有入口均是在检查robots后取得的公开列表/元数据。RSS更适合立即套现有模板预览；HTML容器是调研提示，需要确认CSS选择器及日期精度。**这些是研究候选，不是仓库预览通过、生产启用或自然采集通过的数量。**

采集建议：资讯线、first-party矿企/研究主体、默认全文开关关闭；按既有模型预筛过滤融资/例行披露/招聘等噪声。同一公司多个域名合并owner实体；不将同一矿企RSS和HTML重复计数。当前仅确认域名对主分支、320规划、草稿配置去重，企业并购/母子公司关系需最终实体去重。

| 域名 | 建议入口及类型 | 最新观察到的日期 | 标题摘录及真实条目链接 | UTC核验时间 |
|---|---|---|---|---|
| americanlithiumcorp.com | [RSS](https://americanlithiumcorp.com/feed/) | Wed, 16 Sep 2026 11:15:00 +0000 | [American Lithium’s Falchani Pilot Plant Fully Commissioned and Operating](https://americanlithiumcorp.com/american-lithiums-falchani-pilot-plant-fully-commissioned-and-operating/) | 2026-10-15T12:42:04.547857+00:00 |
| americanpacificmining.com | [RSS](https://americanpacificmining.com/feed/) | Tue, 06 Oct 2026 11:00:00 +0000 | [American Pacific Plans Downhole Surveys to Guide Step-Out Drilling at High-Grade Massive Sulfide Zone at its Madison Copper-Gold](https://americanpacificmining.com/news-releases-2026/american-pacific-plans-downhole-surveys-to-guide-step-out-drilling-at-high-grade-massive-sulfide-zone/) | 2026-10-15T12:43:04.971311+00:00 |
| appiareu.com | [RSS](https://appiareu.com/feed/) | Mon, 05 Oct 2026 19:56:00 +0000 | [Appia Rare Earths & Uranium Corp. To Present at The John Tumazos Very Independent Research Virtual Conference on](https://appiareu.com/appia-rare-earths-uranium-corp-to-present-at-the-john-tumazos-very-independent-research-virtual-conference-on-october-6-2026/) | 2026-10-15T12:48:15.575643+00:00 |
| athaenergy.com | [RSS](https://athaenergy.com/feed/) | Wed, 07 Oct 2026 14:11:59 +0000 | [ATHA Energy Successfully Completes Diamond Drilling at Rib North Discovery, Expanding Strike Length to 3.4 km, and Identifies](https://athaenergy.com/atha-energy-successfully-completes-diamond-drilling-at-rib-north-discovery-expanding-strike-length-to-3-4-km-and-identifies-a-higher-grade-sub-zone-results-include-ribn-dd-023-intersecting-19-5-m-o/) | 2026-10-15T12:50:10.998721+00:00 |
| aurania.com | [RSS](https://aurania.com/feed/) | Tue, 13 Oct 2026 11:58:07 +0000 | [Aurania Completes Drilling at Thormodsdalur Gold Project in Iceland](https://aurania.com/aurania-completes-drilling-at-thormodsdalur-gold-project-in-iceland/) | 2026-10-15T12:48:34.026690+00:00 |
| brixtonmetals.com | [RSS](https://brixtonmetals.com/feed/) | Wed, 14 Oct 2026 11:35:13 +0000 | [Brixton Metals Samples New Vein Grading 195 g/t Gold, 4.11% Copper and 147 g/t Silver At Its Thorn](https://brixtonmetals.com/brixton-metals-samples-new-vein-grading-195-g-t-gold-4-11-copper-and-147-g-t-silver-at-its-thorn-project/) | 2026-10-15T12:48:38.322405+00:00 |
| canalaska.com | [RSS](https://canalaska.com/feed/) | Mon, 21 Sep 2026 11:45:34 +0000 | [CanAlaska Appoints New Vice President Exploration](https://canalaska.com/canalaska-appoints-new-vice-president-exploration-2026/) | 2026-10-15T12:49:58.532904+00:00 |
| chesapeakegold.com | [RSS](https://chesapeakegold.com/feed/) | Tue, 22 Sep 2026 13:00:00 +0000 | [CHESAPEAKE ANNOUNCES PROPRIETARY HEAP OXIDATION TECHNOLOGY UPDATES](https://chesapeakegold.com/2026/09/22/chesapeake-announces-proprietary-heap-oxidation-technology-updates/) | 2026-10-15T12:51:30.010000+00:00 |
| collectivemining.com | [RSS](https://collectivemining.com/feed/) | Tue, 13 Oct 2026 10:30:51 +0000 | [Collective Mining Discovers Shallow High-Grade Silver-Tungsten Mineralization in Northern Apollo, Drilling 5.50m at 1,283 g/t Silver, 0.83% WO₃,](https://collectivemining.com/collective-mining-discovers-shallow-high-grade-silver-tungsten-mineralization-in-northern-apollo-drilling-5-50m-at-1283-g-t-silver-0-83-wo%e2%82%83-0-57-copper-and-0-17-g-t-gold-from-89-15m/) | 2026-10-15T12:42:46.813360+00:00 |
| deepyellow.com.au | [RSS](https://deepyellow.com.au/feed/) | Thu, 24 Sep 2026 22:53:58 +0000 | [Sustainability Report – Year Ended 30 June 2026](https://deepyellow.com.au/sustainability-report-year-ended-30-june-2026/) | 2026-10-15T12:47:54.948574+00:00 |
| f3uranium.com | [RSS](https://f3uranium.com/feed/) | Thu, 24 Sep 2026 10:01:31 +0000 | [F3 Announces the Appointment of Ross McElroy as CEO](https://f3uranium.com/f3-announces-the-appointment-of-ross-mcelroy-as-ceo/) | 2026-10-15T12:49:55.647773+00:00 |
| fireweedmetals.com | [RSS](https://fireweedmetals.com/feed/) | Tue, 15 Sep 2026 22:49:33 +0000 | [Fireweed Intersects 43 m True Width Sub-Interval of 10.53% ZnEq in Tom South Step Out](https://fireweedmetals.com/fireweed-intersects-43-m-true-width-sub-interval-of-10-53-zneq-in-tom-south-step-out/) | 2026-10-15T12:40:38.294034+00:00 |
| fpxnickel.com | [RSS](https://fpxnickel.com/feed/) | Thu, 01 Oct 2026 11:00:32 +0000 | [FPX Nickel Completes Birchy North Drilling and Commences Drilling at Expanded Wolverine Target at Advocate Nickel Property in](https://fpxnickel.com/blog/2026/10/01/fpx-nickel-completes-birchy-north-drilling-and-commences-drilling-at-expanded-wolverine-target-at-advocate-nickel-property-in-newfoundland/) | 2026-10-15T12:41:16.018286+00:00 |
| gigametals.com | [RSS](https://gigametals.com/feed/) | Thu, 08 Oct 2026 21:32:00 +0000 | [Stage 2 Geophysical Program Identifies Multiple Exploration Targets in Attic Zone at Giga Metals’ Turnagain Project](https://gigametals.com/stage-2-geophysical-program-identifies-multiple-exploration-targets-in-attic-zone-at-giga-metals-turnagain-project/) | 2026-10-15T12:41:18.183565+00:00 |
| goliathresourcesltd.com | [RSS](https://goliathresourcesltd.com/feed/) | Wed, 07 Oct 2026 10:07:25 +0000 | [October 7, 2026 – Goliath Reports Several Holes, Up To 9.89 g/t AuEq Over 12.00 Meters From Surebet](https://goliathresourcesltd.com/wp-content/uploads/2026/10/October-7-2026-Goliath-Reports-Several-Holes-Up-To-9.89-gt-AuEq-Over-12.00-Meters-From-Surebet-Zone-24.97-Meters-Of-0.70-gpt-AuEq-From-Big-Bulk-Zone.pdf#new_tab) | 2026-10-15T12:49:08.818434+00:00 |
| graphiteoneinc.com | [RSS](https://www.graphiteoneinc.com/feed/) | Thu, 01 Oct 2026 17:53:03 +0000 | [Graphite One Announces Creation of G1 Advanced Systems Division and Marketing Campaign Update](https://www.graphiteoneinc.com/graphite-one-announces-creation-of-g1-advanced-systems-division-and-marketing-campaign-update/) | 2026-10-15T12:46:27.249671+00:00 |
| magnamining.com | [RSS](https://magnamining.com/feed/) | Thu, 08 Oct 2026 10:45:46 +0000 | [Magna Mining Reports Results of Levack Mine Preliminary Economic Assessment and Approves Restart of Production](https://magnamining.com/magna-mining-reports-results-of-levack-mine-preliminary-economic-assessment-and-approves-restart-of-production/) | 2026-10-15T12:48:11.246006+00:00 |
| northerngraphite.com | [RSS](https://www.northerngraphite.com/feed/) | Mon, 05 Oct 2026 11:50:33 +0000 | [Northern Graphite Engages Germany’s DGWA to Support European Investor & Corporate Activities](https://www.northerngraphite.com/northern-graphite-engages-germanys-dgwa-to-support-european-investor-and-corporate-activities/) | 2026-10-15T12:46:30.798711+00:00 |
| q2metals.com | [RSS](https://q2metals.com/feed/) | Wed, 07 Oct 2026 12:00:48 +0000 | [Q2 Metals Extends Near Surface Mineralization 100 Metres North at the Cisco Lithium Project, Intercepting 134.5 Metres at](https://q2metals.com/q2-metals-extends-near-surface-mineralization-100-metres-north-at-the-cisco-lithium-project/) | 2026-10-15T12:42:00.360387+00:00 |
| rocktechlithium.com | [RSS](https://rocktechlithium.com/en/feed/) | Sat, 10 Oct 2026 08:41:49 +0000 | [Rock Tech Lithium Closes Previously Announced Private Placementat C$6 Million](https://rocktechlithium.com/en/rock-tech-lithium-closes-previously-announced-private-placementat-c6-million/) | 2026-10-15T12:41:53.728526+00:00 |
| silverbulletmines.com | [RSS](https://silverbulletmines.com/feed/) | Tue, 06 Oct 2026 23:18:35 +0000 | [October 6, 2026 – Silver Bullet Mines Corp. Provides Exciting Update on Columbia / Gold Queen Complex](https://silverbulletmines.com/october-6-2026-silver-bullet-mines-corp-provides-exciting-update-on-columbia-gold-queen-complex/) | 2026-10-15T12:49:41.048334+00:00 |
| silverstorm.ca | [RSS](https://silverstorm.ca/feed/) | Tue, 15 Sep 2026 08:03:21 +0000 | [Silver Storm Announces Inclusion into the Benchmark Index Tracked by the GDXJ ETF](https://silverstorm.ca/press-releases/silver-storm-announces-inclusion-into-the-benchmark-index-tracked-by-the-gdxj-etf/) | 2026-10-15T12:48:03.379007+00:00 |
| silverxmining.com | [RSS](https://www.silverxmining.com/feed/) | Thu, 08 Oct 2026 11:39:39 +0000 | [Silver X Grows the AgEq Processed by 42% and Gold 119% YoY as Nueva Recuperada Plant Expansion to](https://www.silverxmining.com/silver-x-grows-the-ageq-processed-by-42-and-gold-119-yoy-as-nueva-recuperada-plant-expansion-to-1000-tpd-advances/?utm_source=rss&utm_medium=rss&utm_campaign=silver-x-grows-the-ageq-processed-by-42-and-gold-119-yoy-as-nueva-recuperada-plant-expansion-to-1000-tpd-advances) | 2026-10-15T12:48:03.595564+00:00 |
| southstarbatterymetals.com | [RSS](https://southstarbatterymetals.com/feed/) | Thu, 01 Oct 2026 21:33:24 +0000 | [South Star Hosts Harvard Students for Potential AI Use at Santa Cruz](https://southstarbatterymetals.com/wp-content/uploads/2026/10/10_STS-Harvard-Student-AI-tour-20261001.pdf#new_tab?utm_source=rss&utm_medium=rss&utm_campaign=south-star-hosts-harvard-students-for-potential-ai-use-at-santa-cruz) | 2026-10-15T12:46:27.040541+00:00 |
| stallionuranium.com | [RSS](https://stallionuranium.com/feed/) | Tue, 29 Sep 2026 13:07:37 +0000 | [Stallion Uranium Recommences Phase II Drilling at Moonlite Project](https://stallionuranium.com/stallion-uranium-recommences-phase-ii-drilling-at-moonlite-project/) | 2026-10-15T12:49:53.530598+00:00 |
| strikepointgold.com | [RSS](https://strikepointgold.com/feed/) | Tue, 13 Oct 2026 13:00:00 +0000 | [StrikePoint Gold Strengthens its Team with Hiring of Keith Wood as Exploration Manager and Appointment of Stephen Quin](https://strikepointgold.com/strikepoint-gold-strengthens-its-team-with-hiring-of-keith-wood-as-exploration-manager-and-appointment-of-stephen-quin-as-a-strategic-advisor/?utm_source=rss&utm_medium=rss&utm_campaign=strikepoint-gold-strengthens-its-team-with-hiring-of-keith-wood-as-exploration-manager-and-appointment-of-stephen-quin-as-a-strategic-advisor) | 2026-10-15T12:49:15.330620+00:00 |
| ucore.com | [RSS](https://ucore.com/feed/) | Mon, 14 Sep 2026 13:29:58 +0000 | [Ucore Secures Additional US$4.6 Million from U.S. Department of War to Advance Samarium and Gadolinium Refining](https://ucore.com/ucore-secures-additional-us4-6-million-from-u-s-department-of-war-to-advance-samarium-and-gadolinium-refining/) | 2026-10-15T12:48:17.471446+00:00 |
| vizslacopper.com | [RSS](https://vizslacopper.com/feed/) | Wed, 07 Oct 2026 12:00:00 +0000 | [Vizsla Copper Intersects 307.5 g/t Silver Equivalent over 21.2 meters at Palmer, Southeast Alaska](https://vizslacopper.com/2026/vizsla-copper-intersects-307-5-g-t-silver-equivalent-over-21-2-meters-at-palmer-southeast-alaska/) | 2026-10-15T12:49:36.732778+00:00 |
| westredlakegold.com | [RSS](https://westredlakegold.com/feed/) | Tue, 22 Sep 2026 10:00:00 +0000 | [West Red Lake Gold Reports 176.04 g/t Au over 5.3m, 128.32 g/t Au over 4.5m and 35.72 g/t](https://westredlakegold.com/west-red-lake-gold-reports-176-04-g-t-au-over-5-3m-128-32-g-t-au-over-4-5m-and-35-72-g-t-au-over-13-35m-from-austin-955-and-904-complexes/) | 2026-10-15T12:49:16.279971+00:00 |
| aldebaranresources.com | [HTML](https://aldebaranresources.com/2026/)；容器`div.post-details` | October 5, 2026 | [Aldebaran Reports 1,728.9 m of 0.45% CuEq (0.41% Cu, 0.03 g/t Au & 1.34 g/t Ag), including 756](https://aldebaranresources.com/aldebaran-reports-1728-9-m-of-0-45-cueq-0-41-cu-0-03-g-t-au-1-34-g-t-ag-including-756-m-of-0-68-cueq-0-61-cu-0-03-g-t-au-2-12-g-t-ag-at-the-altar-copper-gold-project-in-san-juan-a/) | 2026-10-15T12:45:53.994708+00:00 |
| americanbatterytechnology.com | [HTML](https://americanbatterytechnology.com/news/)；容器`li` | August 8, 2026 | [One of the Largest Known Lithium Deposits in US Identified at American Battery Technology Company Tonopah Flats Property](https://americanbatterytechnology.com/one-of-the-largest-known-lithium-deposits-in-us-identified-at-american-battery-technology-company-tonopah-flats-property-inferred-resource-estimated-through-s-k-1300-compliant-study/) | 2026-10-15T12:46:47.751061+00:00 |
| aris-mining.com | [HTML](https://www.aris-mining.com/news)；容器`div.media-body.col-md` | Oct 7, 2026 | [Aris Mining Reports Q3 2026 Production](https://www.aris-mining.com/news/detail/183/aris-mining-reports-q3-2026-production) | 2026-10-15T12:45:23.460776+00:00 |
| astonbayholdings.com | [HTML](https://astonbayholdings.com/news-media/news/) | August 27, 2026 | [Aston Bay Identifies New Near-Surface Copper Targets Through Integrated 3D Modelling at the Epworth Copper-Silver Project, Nunavut, Canada](https://astonbayholdings.com/news/identifies-new-near-surface-copper-targets-through-integrated-3d-modelling/) | 2026-10-15T12:40:50.430276+00:00 |
| denisonmines.com | [HTML](https://denisonmines.com/news/) | August 12, 2026 | [Denison Reports Financial and Operational Results for Q2 2026, Highlighted by Significant Initial Progress from Construction Activities at](https://denisonmines.com/news/denison-reports-financial-and-operational-results-122850/) | 2026-10-15T12:42:33.685976+00:00 |
| e3lithium.ca | [HTML](https://e3lithium.ca/)；容器`a.news-item` | Sep 30, 2026 | [Sep 30, 2026 E3 Lithium Confirms Listing of Warrants in Relation to Recently Closed Equity Offering](https://e3lithium.ca/newsroom/news-releases/e3-lithium-confirms-listing-of-warrants-in-relation-to-recently-closed-equity-offering) | 2026-10-15T12:46:34.949933+00:00 |
| electrabmc.com | [HTML](https://electrabmc.com/news-releases/news/index.php) | Oct 13 2026 | [Electra Signs Term Sheet for Strategic Partnership with Global Commodities Trader WMC](https://electrabmc.com/news-releases/news/electra-signs-term-sheet-for-strategic-partnership-with-global-commodities-trader-wmc) | 2026-10-15T12:41:39.971029+00:00 |
| encoreuranium.com | [HTML](https://encoreuranium.com/news/)；容器`div.elementor-widget-wrap.elementor-element-populated` | October 1, 2026 | [enCore Energy Completes Distribution of Verdera Common Shares to its Shareholders](https://encoreuranium.com/news/encore-energy-completes-distribution-of-verdera-common-shares-to-its-shareholders/) | 2026-10-15T12:47:41.769361+00:00 |
| excellonresources.com | [HTML](https://excellonresources.com/news/) | Sep 21, 2026 | [Excellon Drilling Confirms Grade and Width Below the 4090 Level at Mallay Silver Mine](https://excellonresources.com/news/details/index.php?content_id=436) | 2026-10-15T12:42:56.303626+00:00 |
| fortuneminerals.com | [HTML](https://fortuneMinerals.com/)；容器`a.news-item` | September 18, 2026 | [September 18, 2026 Fortune Minerals Receives Its Northwest Territories Water Licence and Land Use Permit Renewals for the](https://fortuneMinerals.com/news/news-releases/fortune-minerals-receives-its-northwest-territories-water-licence-and-land-use-permit-renewals-for-the-nico-mine) | 2026-10-15T12:46:36.058563+00:00 |
| highlandcopper.com | [HTML](https://www.highlandcopper.com/)；容器`article` | Aug 25, 2026 | [Highland Copper Announces Final Approval of US$50 Million Grant from the State of Michigan for Copperwood Project](https://www.highlandcopper.com/news/highland-copper-announces-final-approval-of-us50-million-grant-from-the-state-of-michigan-for-copperwood-project/) | 2026-10-15T12:45:26.166261+00:00 |
| ivanhoeatlantic.com | [HTML](https://ivanhoeatlantic.com/news-media/) | 1 September 2026 | [Ivanhoe Atlantic strengthens U.S. focused Board](https://ivanhoeatlantic.com/ivanhoe-atlantic-strengthens-u-s-focused-board/) | 2026-10-15T12:43:20.261095+00:00 |
| li-ft.com | [HTML](https://www.li-ft.com/news/)；容器`div.item.news-item` | Oct 5, 2026 | [Release Conditions for Renard Option Satisfied](https://www.li-ft.com/news/release-conditions-for-renard-option-satisfied) | 2026-10-15T12:46:40.631077+00:00 |
| metallic-minerals.com | [HTML](https://metallic-minerals.com/news/2026/) | Jul 27, 2026 | [Metallic Minerals' La Plata Project Selected for U.S. DOE Genesis Mission AI Research Initiative Award Funding](https://metallic-minerals.com/news/2026/metallic-minerals-la-plata-project-selected-for-u.s-doe-genesis-mission-ai-research-initiative-award-funding/) | 2026-10-15T12:43:09.401713+00:00 |
| nextsourcematerials.com | [HTML](https://www.nextsourcematerials.com/)；容器`li.latest-news__post` | September 28, 2026 | [NextSource Materials Secures Binding Agreement for US$30 Million Strategic Investment from Japan’s Hanwa and JOGMEC to Advance its](https://www.nextsourcematerials.com/nextsource-materials-secures-binding-agreement-for-us30-million-strategic-investment-from-japans-hanwa-and-jogmec-to-advance-its-uae-battery-anode-facility/) | 2026-10-15T12:46:27.832242+00:00 |
| northwestcopper.ca | [HTML](https://northwestcopper.ca/news/) | Oct 14, 2026 | [NorthWest Intersects 31.4 Metres of 0.92% Copper and 1.08 g/t Gold (2.11% CuEq) at Kwanika in the Pit](https://northwestcopper.ca/news/northwest-intersects-31-4-metres-of-0-92-copper-a-15504/) | 2026-10-15T12:40:46.606518+00:00 |
| outcropsilver.com | [HTML](https://outcropSilver.com/news/) | Oct 15, 2026 | [OUTCROP SILVER Launches Project Argentum: Technical Work Plan Approved for Santa Ana Pilot Operation, Targeted for Production in](https://outcropSilver.com/news/outcrop-silver-launches-project-argentum-technical-work-plan-approved-for-santa-ana-pilot-operation-targeted-for-production-in/) | 2026-10-15T12:42:47.618257+00:00 |
| seabridgegold.com | [HTML](https://www.seabridgegold.com/)；容器`a.w-inline-block` | October 13, 2026 | [Seabridge Gold To Explore Wyoming for Gold and Critical Minerals October 13, 2026](https://www.seabridgegold.com/press-release/seabridge-gold-to-explore-wyoming-for-gold-and-critical-minerals) | 2026-10-15T12:45:18.191320+00:00 |
| sitkagoldcorp.com | [HTML](https://sitkagoldcorp.com/news/) | October 14, 2026 | [Sitka Drills 236.0 Metres Of 1.15 g/t Gold, Including 71.0 Metres Of 2.79 g/t Gold And 36.3 Metres](https://sitkagoldcorp.com/sitka-drills-236-0-metres-of-1-15-g-t-gold-including-71-0-metres-of-2-79-g-t-gold-and-36-3-metres-of-3-31-g-t-gold-at-the-saddle-zone-and-continues-to-expand-the-eiger-deposit-at-its-rc-gold-project/) | 2026-10-15T12:40:30.748370+00:00 |
| surgebatterymetals.com | [HTML](https://surgebatterymetals.com/news) | Oct 2, 2026 | [Announcement Surge Announces Positive Pre-Feasibility Study at Nevada North: After-Tax NPV8% of US$9.81 Billion, After-Tax IRR of 23.6%](https://surgebatterymetals.com/news/surge-announces-positive-pre-feasibility-study-at-nevada-north-after-tax-npv8-of-us-9.81-billion-after-tax-irr-of-23.6-and-operating-cost-of-us-4-719-tonne-lithium-carbonate) | 2026-10-15T12:41:49.077994+00:00 |
| surgecopper.com | [HTML](https://surgecopper.com/news-releases/2026)；容器`div.flex.flex-wrap.py-3.bg-primary.even:bg-transparent.bg-opacity-10.relative` | Oct 2, 2026 | [Surge Copper Announces AGM Results and Grant of Deferred Share Units](https://surgecopper.com/news-releases/surge-copper-announces-agm-results-and-grant-of-deferred-share-units/) | 2026-10-15T12:45:57.059496+00:00 |
| talonmetals.com | [HTML](https://talonmetals.com/2026-2/)；容器`tr.ee-table__row` | October 6, 2026 | [Talon Metals Discovers Mineralized Magmatic Conduit at Roland Nickel-Copper Target in Michigan](https://talonmetals.com/talon-metals-discovers-mineralized-magmatic-conduit-at-roland-nickel-copper-target-in-michigan/) | 2026-10-15T12:48:42.658273+00:00 |
| ur-energy.com | [HTML](https://www.ur-energy.com/)；容器`article.media` | Aug 20, 2026 | [Ur-Energy Announces First Shipment of Uranium from Shirley Basin Mine, Wyoming](https://www.ur-energy.com/news-media/press-releases/detail/410/ur-energy-announces-first-shipment-of-uranium-from-shirley) | 2026-10-15T12:47:22.711868+00:00 |
| vizslasilvercorp.com | [HTML](https://vizslasilvercorp.com/news/) | October 9, 2026 | [VIZSLA SILVER ANNOUNCES RESULTS OF ANNUAL GENERAL AND SPECIAL MEETING](https://vizslasilvercorp.com/vizsla-silver-announces-results-of-annual-general-and-special-meeting-3/) | 2026-10-15T12:42:49.209745+00:00 |
| westerncopperandgold.com | [HTML](https://www.westerncopperandgold.com/)；容器`div.elementor-element.elementor-element-15eea85.e-con-full.e-flex.e-con.e-parent` | September 14, 2026 | [Western Copper and Gold Announces Casino Project Selected For Canada Investment Summit Prospectus](https://www.westerncopperandgold.com/news-and-resources/news-release/western-copper-and-gold-announces-casino-project-selected-for-canada-investment-summit-prospectus/) | 2026-10-15T12:45:28.519224+00:00 |

| eurobatteryminerals.com | [RSS](https://eurobatteryminerals.com/feed/) | Mon, 28 Sep 2026 14:45:00 +0000 | [Tungsten San Juan inleder administrativt förfarande med anledning av tillfälligt stopp av gruvverksamheten](https://eurobatteryminerals.com/tungsten-san-juan-inleder-administrativt-forfarande-med-anledning-av-tillfalligt-stopp-av-gruvverksamheten/) | 2026-10-15T12:55:53.963586+00:00 |

| beowulfmining.com | [RSS](https://beowulfmining.com/feed/) | Mon, 27 Jul 2026 11:24:09 +0000 | [Beowulf Mining – Corporate Update](https://beowulfmining.com/beowulf-mining-corporate-update-2/) | 2026-10-15T12:59:33.921313+00:00 |
| canadanickel.com | [HTML](https://canadanickel.com/investors/news-releases/)；容器`li.document-type-news-releases .document-card` | October 6, 2026 | [CANADA NICKEL COMPANY RELEASES 2025 ESG REPORT](https://wp-canadanickel-2025.s3.ca-central-1.amazonaws.com/media/2026/10/Canada-Nickel-ESG_Report-Press-Release_VF-1.pdf) | 2026-10-15T12:59:33.921313+00:00 |

| amarcresources.com | [HTML](https://amarcresources.com/news-releases/) | September 15, 2026 | [AMARC Announces Chief Financial Officer Transition](https://amarcresources.com/news-releases/amarc-announces-chief-financial-officer-transition/) | 2026-10-15T13:02:28.040488+00:00 |

## 更新偏慢的 2 个入口（与近期组分列）

这两家有真实标题、链接与日期，但本次观察到的最新样例距核验已超过90天。90天仅用于本报告研究分组，不修改产品采集规则。尚不能证明当前持续供稿，不混入近期可接入组，也不计最终生产达标数。

| 域名 | 入口 | 最新观察到的日期 | 标题与链接 | UTC核验时间 |
|---|---|---|---|---|
| copperfoxmetals.com | [HTML](https://www.copperfoxmetals.com/news)；容器`a.group.block.border.border-brand-gray-200.rounded-xl.p-6.card-hover` | May 7, 2026 | [May 7, 2026 Copper Fox Renews Atrium Research Services Copper Fox Renews Atrium Research Services Calgary, Alberta--(Newsfile Corp.](https://www.copperfoxmetals.com/news/140468) | 2026-10-15T12:46:03.917423+00:00 |
| giyanimetals.com | [RSS](https://giyanimetals.com/feed/) | Fri, 10 Jul 2026 13:13:21 +0000 | [Giyani Metals Announces Filing of Definitive Feasibility Study](https://giyanimetals.com/giyani-metals-announces-filing-of-definitive-feasibility-study/) | 2026-10-15T12:55:53.963586+00:00 |

## 必须排除的假阳性

| 域名 | 排除原因 |
|---|---|
| firefinchltd.com | feed最新样例2026-02，暂未证明持续更新，不计近期候选 |
| renascor.com.au | 默认feed停留2024，不计当前可用 |
| amarcresources.com/feed/ | 默认feed样例是人员简介，排除这个入口；已改用robots404允许且真实带日期的/news-releases/列表。 |
| coppergiant.co | 抽到的news.html是列表网址，未证明独立条目URL；剔除，不能拿首页宣传卡片充数。 |
| atlanticlithium.com.au | HTML抓到年度报告期间结束日，不是已核发表日期 |
| kpmg.com | Leo Lithium入口跳转至KPMG，内容为通用经济新闻，不是目标矿企来源 |
| goldsourcemines.com | 域名当前返回Gold IRA导购工具，无法确认仍是原矿企官网，排除 |
| internationallithium.com | 当前RSS返回POS4D赌博内容，明显非矿企新闻，排除且不要接入 |
| talonmetals.com/feed/ | 默认feed是2019旧材料；上表已改用官方2026年度新闻列表，不用默认feed。 |
| strikepointgold.com/feed/ | 混有标题仅为presentation的附件项；需过滤这种无实质标题的记录，新闻项可单独预览。 |
| goliathresourcesltd.com/feed/ | 链接直接为PDF；列表日期/标题可用，正文解析、权限和下载另验，不能按HTML详情假设。 |

## 未通过或仍待发现的入口（不计入候选）

HTTP404仅说明所试路径不存在，不代表整个公司无来源；robots跳转表示尚需在规范主机另验，不能写成robots禁止；403或挑战不绕过。下表保留最新探测结果。

| 实际尝试入口 | 当前结果 | UTC核验时间 |
|---|---|---|
| https://almonty.com/feed/ | not RSS XML | 2026-10-15T12:51:37.218309+00:00 |
| https://americanrareearths.com.au/feed/ | feed HTTP 404 | 2026-10-15T12:48:18.768022+00:00 |
| https://ascotgold.com/news/ | robots HTTP 301 non-text/denied | 2026-10-15T12:40:27.303669+00:00 |
| https://atalayamining.com/news/ | HTTP 404 | 2026-10-15T12:46:04.892117+00:00 |
| https://athabascaminerals.com/news/ | curl: (6) Could not resolve host: athabascaminerals.com  | 2026-10-15T12:43:16.385256+00:00 |
| https://australianstrategicmaterials.com.au/feed/ | robots 0 | 2026-10-15T12:51:51.946115+00:00 |
| https://azarga.com/feed/ | robots 0 | 2026-10-15T12:50:12.779334+00:00 |
| https://azincourtenergy.com/feed/ | robots 302 | 2026-10-15T12:49:52.005043+00:00 |
| https://bannermanenergy.com/news/ | https://investors.bannermanenergy.com/news | 2026-10-15T12:42:22.971743+00:00 |
| https://baselode.com/feed/ | feed HTTP 404 | 2026-10-15T12:50:03.632749+00:00 |
| https://bentonresources.ca/news | robots unavailable 301 | 2026-10-15T12:48:04.136357+00:00 |
| https://www.berkeleyenergia.com/news/ | HTTP 404 | 2026-10-15T12:47:19.716367+00:00 |
| https://blackrocksilver.com/news | robots unavailable 301 | 2026-10-15T12:47:42.116626+00:00 |
| https://bonterraresources.com/feed/ | robots 0 | 2026-10-15T12:49:15.943749+00:00 |
| https://bonterrresources.com/feed/ | robots 0 | 2026-10-15T12:49:15.852693+00:00 |
| https://bossenergy.com/news/ | HTTP 404 | 2026-10-15T12:47:18.264607+00:00 |
| https://bravomining.com/feed/ | feed HTTP 404 | 2026-10-15T12:48:11.246334+00:00 |
| https://www.canadacarbon.com/news | HTTP 404 | 2026-10-15T12:48:20.363389+00:00 |
| https://canadagoldcorp.com/feed/ | robots 0 | 2026-10-15T12:50:14.567322+00:00 |
| https://chakanaresources.com/news/ | robots HTTP 301 non-text/denied | 2026-10-15T12:40:56.497617+00:00 |
| https://class1nickel.com/feed/ | no current same-domain dated RSS items | 2026-10-15T12:51:43.912265+00:00 |
| https://cleantechlithium.com/feed/ | robots 0 | 2026-10-15T12:50:20.688383+00:00 |
| https://commerceresources.com/feed/ | robots 301 | 2026-10-15T12:51:30.011562+00:00 |
| https://copperex.com/news/ | no current dated metadata | 2026-10-15T12:45:42.365067+00:00 |
| https://coppermountain.com/news/ | curl: (28) Connection timed out after 15006 milliseconds  | 2026-10-15T12:41:03.474282+00:00 |
| https://criticalelements.com/news/ | robots HTTP 200 non-text/denied | 2026-10-15T12:41:51.958093+00:00 |
| https://criticalmetalscorp.com/feed/ | robots 301 | 2026-10-15T12:51:50.234128+00:00 |
| https://www.cygnusmetals.com/news/ | HTTP 404 | 2026-10-15T12:46:42.107147+00:00 |
| https://defensemetals.com/feed/ | feed HTTP 404 | 2026-10-15T12:51:30.011871+00:00 |
| https://dollyvardensilver.com/news/ | robots HTTP 301 non-text/denied | 2026-10-15T12:42:49.237323+00:00 |
| https://www.cygnusmetals.com/ | no current dated metadata | 2026-10-15T12:46:20.155319+00:00 |
| https://drydengold.com/feed/ | feed HTTP 500 | 2026-10-15T12:49:27.765378+00:00 |
| https://ecoprographite.com/news/ | curl: (6) Could not resolve host: ecoprographite.com  | 2026-10-15T12:43:26.890222+00:00 |
| https://endeavoursilver.com/news/ | curl: (28) Connection timed out after 15006 milliseconds  | 2026-10-15T12:42:54.370680+00:00 |
| https://enrg-elements.com/feed/ | robots 0 | 2026-10-15T12:51:49.683073+00:00 |
| https://erocopper.com/news/ | HTTP 404 | 2026-10-15T12:46:04.585353+00:00 |
| https://europeanmet.com/feed/ | robots 301 | 2026-10-15T12:50:18.258650+00:00 |
| https://fabledcoppercorp.com/news/ | HTTP 404 | 2026-10-15T12:46:15.186988+00:00 |
| https://fireflymetals.com.au/news/ | HTTP 404 | 2026-10-15T12:45:49.780080+00:00 |
| https://firstcobalt.com/news/ | HTTP 404 | 2026-10-15T12:46:34.358286+00:00 |
| https://firstmininggold.com/feed/ | feed HTTP 404 | 2026-10-15T12:49:28.641612+00:00 |
| https://foranmining.com/news/ | https://eldoradogold.com/ | 2026-10-15T12:40:35.304829+00:00 |
| https://foundersmetals.com/news/ | curl: (6) Could not resolve host: foundersmetals.com  | 2026-10-15T12:42:44.914034+00:00 |
| https://www.frontierlithium.com/news | no current dated metadata | 2026-10-15T12:46:43.272087+00:00 |
| https://geomet.cz/en/news/ | HTTP 404 | 2026-10-15T12:47:00.482911+00:00 |
| https://globalatomiccorp.com/news/ | HTTP 403 | 2026-10-15T12:42:29.579376+00:00 |
| https://www.gminingventures.com/news/ | HTTP 404 | 2026-10-15T12:45:17.922587+00:00 |
| https://gogoldresources.com/news/ | HTTP 404 | 2026-10-15T12:47:54.324112+00:00 |
| https://goldenpredator.com/feed/ | robots 301 | 2026-10-15T12:48:57.798529+00:00 |
| https://goldgroupmining.com/feed/ | robots 308 | 2026-10-15T12:50:15.183901+00:00 |
| https://goldmining.com/feed/ | feed HTTP 404 | 2026-10-15T12:49:31.423537+00:00 |
| https://goldplaymining.ca/feed/ | feed HTTP 404 | 2026-10-15T12:50:16.354620+00:00 |
| https://goldquestcorp.com/feed/ | robots 308 | 2026-10-15T12:50:15.838162+00:00 |
| https://goldshoreresources.com/feed/ | new domain redirect https://goldx2.com/feed/ | 2026-10-15T12:48:47.282883+00:00 |
| https://goldstormmetals.com/feed/ | feed HTTP 404 | 2026-10-15T12:49:00.725522+00:00 |
| https://goldterracorp.com/feed/ | feed HTTP 404 | 2026-10-15T12:48:49.051197+00:00 |
| https://goviex.com/news/ | HTTP 404 | 2026-10-15T12:47:30.153872+00:00 |
| https://greatsouthernmining.com.au/feed/ | robots 0 | 2026-10-15T12:51:51.784550+00:00 |
| https://grsilvermining.com/feed/ | feed HTTP 403 | 2026-10-15T12:48:24.949631+00:00 |
| https://guardianmetalresources.com/feed/ | no current same-domain dated RSS items | 2026-10-15T12:51:38.997136+00:00 |
| https://gunnisoncopper.com/feed/ | not RSS XML | 2026-10-15T12:48:35.212393+00:00 |
| https://heliostarmetals.com/feed/ | robots 301 | 2026-10-15T12:48:48.109884+00:00 |
| https://hotchilicopper.com/feed/ | robots 0 | 2026-10-15T12:50:14.171074+00:00 |
| https://impactsilver.com/feed/ | feed HTTP 404 | 2026-10-15T12:48:28.021180+00:00 |
| https://infinitylithium.com/news/ | robots HTTP 301 non-text/denied | 2026-10-15T12:42:17.688373+00:00 |
| https://www.inventusmining.com/news/ | no current dated metadata | 2026-10-15T12:48:15.479205+00:00 |
| https://investorhub.lakeresources.com.au/ | robots unavailable 429 | 2026-10-15T12:46:46.373919+00:00 |
| https://investors.bannermanenergy.com/news | robots unavailable 429 | 2026-10-15T12:46:55.431990+00:00 |
| https://www.ioneer.com/investors/announcements/ | HTTP 404 | 2026-10-15T12:47:16.156224+00:00 |
| https://ioniclithium.com/news/ | curl: (28) Connection timed out after 15002 milliseconds  | 2026-10-15T12:41:49.225203+00:00 |
| https://ionicre.com.au/feed/ | robots 301 | 2026-10-15T12:48:23.322929+00:00 |
| https://juggernautexploration.com/feed/ | no current same-domain dated RSS items | 2026-10-15T12:49:12.774368+00:00 |
| https://kincoracopper.com/feed/ | robots 301 | 2026-10-15T12:50:13.869015+00:00 |
| https://kingsmenresources.com/feed/ | feed HTTP 404 | 2026-10-15T12:49:46.149813+00:00 |
| https://kodiakcoppercorp.com/feed/ | feed HTTP 500 | 2026-10-15T12:50:14.634362+00:00 |
| https://kuyasilver.com/news/news-2026/ | no current dated metadata | 2026-10-15T12:48:12.514947+00:00 |
| https://lakeResources.com.au/news/ | https://lakeresources.com.au/investors/newsletters/ | 2026-10-15T12:42:10.206811+00:00 |
| https://lavrasgold.com/feed/ | feed HTTP 500 | 2026-10-15T12:49:05.269205+00:00 |
| https://leadingedgematerials.com/feed/ | feed HTTP 404 | 2026-10-15T12:51:31.172641+00:00 |
| https://lifeminerals.com/news/ | curl: (28) Connection timed out after 15004 milliseconds  | 2026-10-15T12:41:18.495709+00:00 |
| https://lithios.io/feed/ | robots 0 | 2026-10-15T12:50:25.845219+00:00 |
| https://lithiumchile.ca/feed/ | no current same-domain dated RSS items | 2026-10-15T12:50:25.020051+00:00 |
| https://lotusresources.com.au/news | HTTP 404 | 2026-10-15T12:47:10.364911+00:00 |
| https://luminaGold.com/news/ | robots HTTP 200 non-text/denied | 2026-10-15T12:42:40.430131+00:00 |
| https://maxresource.com/feed/ | robots 301 | 2026-10-15T12:50:14.309964+00:00 |
| https://meridianmining.co/news/ | HTTP 404 | 2026-10-15T12:46:10.205655+00:00 |
| https://metallicminerals.com/news/ | curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to metallicminerals.com:443   | 2026-10-15T12:43:14.811852+00:00 |
| https://mineralcommodities.com/feed/ | robots 301 | 2026-10-15T12:51:39.387701+00:00 |
| https://montagegold.com/news/ | no current dated metadata | 2026-10-15T12:47:45.943169+00:00 |
| https://murchisonminerals.com/feed/ | no current same-domain dated RSS items | 2026-10-15T12:51:44.667849+00:00 |
| https://neometals.com.au/feed/ | robots 301 | 2026-10-15T12:51:42.491827+00:00 |
| https://newfoundgold.ca/feed/ | feed HTTP 500 | 2026-10-15T12:48:37.450109+00:00 |
| https://newfoundgoldcorp.com/feed/ | robots 0 | 2026-10-15T12:48:41.469472+00:00 |
| https://northernminerals.com.au/feed/ | no current same-domain dated RSS items | 2026-10-15T12:51:36.575457+00:00 |
| https://novagold.com/investors/news/ | robots HTTP 403 non-text/denied | 2026-10-15T12:40:33.732799+00:00 |
| https://orlamining.com/news/ | robots HTTP 301 non-text/denied | 2026-10-15T12:40:27.298474+00:00 |
| https://palladiumone.com/news/ | robots HTTP 403 non-text/denied | 2026-10-15T12:43:19.009268+00:00 |
| https://patriotbatterymetals.com/news/ | robots HTTP 301 non-text/denied | 2026-10-15T12:41:50.123747+00:00 |
| https://platinex.com/news/ | robots HTTP 200 non-text/denied | 2026-10-15T12:43:20.628122+00:00 |
| https://platinumgroupmetals.net/news/ | HTTP 403 | 2026-10-15T12:43:19.284097+00:00 |
| https://power-metals.com/news/ | curl: (6) Could not resolve host: power-metals.com  | 2026-10-15T12:41:51.810470+00:00 |
| https://powerhousehydrogen.com/feed/ | robots 0 | 2026-10-15T12:50:18.159066+00:00 |
| https://predictivediscovery.com/news/ | HTTP 404 | 2026-10-15T12:47:31.632856+00:00 |
| https://prospectresources.com.au/news/ | curl: (56) Exceeded the maximum allowed file size (900000) with 900000 bytes  | 2026-10-15T12:42:12.933995+00:00 |
| https://quebecnickel.com/news/ | curl: (35) Recv failure: Connection reset by peer  | 2026-10-15T12:41:12.907865+00:00 |
| https://rarex.com.au/feed/ | robots 429 | 2026-10-15T12:48:22.801226+00:00 |
| https://redpineexp.com/feed/ | robots 301 | 2026-10-15T12:48:46.320082+00:00 |
| https://regulusresources.com/feed/ | feed HTTP 404 | 2026-10-15T12:48:28.418330+00:00 |
| https://reuniongold.com/news/ | HTTP 404 | 2026-10-15T12:47:37.931877+00:00 |
| https://reynagold.com/feed/ | no current same-domain dated RSS items | 2026-10-15T12:49:34.713927+00:00 |
| https://reynasilver.com/feed/ | feed HTTP 404 | 2026-10-15T12:49:33.111675+00:00 |
| http://rockhavenresources.com/news | insecure redirect not followed | 2026-10-15T12:47:59.000369+00:00 |
| https://romios.com/feed/ | feed HTTP 404 | 2026-10-15T12:49:50.140245+00:00 |
| https://salazarresources.com/feed/ | robots 301 | 2026-10-15T12:48:34.168036+00:00 |
| https://scottieresources.com/feed/ | feed HTTP 404 | 2026-10-15T12:48:41.544338+00:00 |
| https://searchminerals.ca/feed/ | feed HTTP 404 | 2026-10-15T12:51:44.789122+00:00 |
| https://searchminerals.com/feed/ | feed HTTP 404 | 2026-10-15T12:51:49.679387+00:00 |
| https://serraverde.com/feed/ | robots 301 | 2026-10-15T12:48:23.479090+00:00 |
| https://silver47.com/feed/ | no current same-domain dated RSS items | 2026-10-15T12:49:38.261334+00:00 |
| https://silvercrestmetals.com/news/ | HTTP 404 | 2026-10-15T12:47:54.570656+00:00 |
| https://silveroneresources.com/news/ | curl: (6) Could not resolve host: silveroneresources.com  | 2026-10-15T12:43:04.063824+00:00 |
| https://skeenaresources.com/news/ | https://skeenagoldsilver.com/news-releases/ | 2026-10-15T12:40:28.144907+00:00 |
| https://skyharbourltd.com/feed/ | feed HTTP 404 | 2026-10-15T12:50:06.920010+00:00 |
| https://snowlinegold.com/news | robots unavailable 301 | 2026-10-15T12:45:06.863015+00:00 |
| https://www.south32.net/news-media/latest-news | HTTP 403 | 2026-10-15T12:46:16.761252+00:00 |
| https://southerncrossgold.com.au/feed/ | robots 301 | 2026-10-15T12:50:13.333969+00:00 |
| https://standardlithium.com/news/?press-releases | robots unavailable 301 | 2026-10-15T12:46:35.532164+00:00 |
| https://standarduranium.ca/feed/ | robots 301 | 2026-10-15T12:49:53.880017+00:00 |
| https://strikesminerals.com/feed/ | robots 0 | 2026-10-15T12:49:15.247635+00:00 |
| https://www.syrahresources.com.au/news | no current dated metadata | 2026-10-15T12:48:25.835883+00:00 |
| https://taurigold.ca/feed/ | robots 0 | 2026-10-15T12:48:58.843494+00:00 |
| https://taurigold.com/feed/ | robots 0 | 2026-10-15T12:48:58.765811+00:00 |
| https://tirupatigraphite.co.uk/news/ | HTTP 404 | 2026-10-15T12:48:54.044647+00:00 |
| https://tucanogold.com/feed/ | robots disallow | 2026-10-15T12:49:04.082875+00:00 |
| https://www.uraniumenergy.com/news/ | no current dated metadata | 2026-10-15T12:47:32.564561+00:00 |
| https://viszlasilvercorp.com/news/ | curl: (6) Could not resolve host: viszlasilvercorp.com  | 2026-10-15T12:42:49.113417+00:00 |
| https://voltaicminerals.com/news/ | curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to voltaicminerals.com:443   | 2026-10-15T12:42:04.245178+00:00 |
| https://vulcanenergy.com/news/ | no current dated metadata | 2026-10-15T12:46:46.512683+00:00 |
| https://walkaboutresources.com.au/news/ | curl: (60) SSL: no alternative certificate subject name matches target host name 'walkaboutresources.com.au' More details here: https://curl.se/docs/s | 2026-10-15T12:43:30.353357+00:00 |
| https://westernalaskaMinerals.com/news/ | robots HTTP 302 non-text/denied | 2026-10-15T12:43:04.145356+00:00 |
| https://westerncoppercorp.com/news/ | HTTP 404 | 2026-10-15T12:45:32.737885+00:00 |
| https://westwaterresources.net/news-releases/ | HTTP 403 | 2026-10-15T12:41:38.330030+00:00 |
| https://whitegoldcorp.ca/feed/ | feed HTTP 404 | 2026-10-15T12:48:59.040015+00:00 |
| https://winsomeresources.com.au/news/ | curl: (6) Could not resolve host: winsomeresources.com.au  | 2026-10-15T12:41:50.910555+00:00 |
| https://zinnwaldlithium.com/news/ | robots HTTP 301 non-text/denied | 2026-10-15T12:42:16.307377+00:00 |

## 接入优先级及验证责任

1. 先预览当前RSS候选，保留真实来源标题与日期；对2019/2024旧feed、员工介绍、赌博/导购内容已明确排除。
2. 再适配HTML列表。首页卡片的日期可能是报告期间，应逐项核对；当前已发现的Atlantic误配已排除。HTML选择器提示不作为可直接上线配置。
3. 对天齐、嘉能可、四家SEC分别补日期时区/精度、静态属性、列数组转行与真实文件URL处理后，用最终配置重跑仓库preview；BHP缺文档URL、Anglo缺可采列表继续保持blocked。
4. 最终200目标只计最终配置preview通过、生产启用、自然采集得到有效条目的独立新增来源。本文不读生产、不调用真实模型、不修改源配置。

本轮开始于2026-10-15T12:35:46Z；最后整理时间：2026-10-15T12:54:44.443988+00:00。此前完成272次有界入口探测；上表保留每个域名的最新结论，另补入末批RSS。已取得60个独立域名候选的日期链接样例，其中58个近期入口、2个更新偏慢入口；最终preview与自然采集仍未完成，不能等同60个新增可用来源。

末批补充：Giyani、Eurobattery均robots200且RSS200；前者保留已核日期但更新较慢，后者为瑞典语钨/电池金属来源，应使用language=sv而非英语。Canadian Manganese所试/feed/404不计入。Beowulf robots404、RSS200，已补入；Thesis重定向到www.thesisgoldsilver.com；该规范主机robots404，但/feed/也404，仍未取得新闻列表，不计候选。

## 最小原生配置建议（观察值，未替代preview）

RSS沿用现有 kind=rss、config.url=上表RSS链接；language默认en，Eurobattery=sv。不要填日期时区，RSS自身的日期含时区。site_fulltext=false、syndicate_fulltext=false。最终实际来源字段按当前schema生成。

HTML以下selector来自实际样例所在容器；需要最终preview确认匹配数量、去除导航/重复卡片、标题不夹日期。只含日期的来源不补UTC时分；sourceDate.formatPattern应按sampleRawDate声明，不把年报期末日期当发布日期。允许URL前缀应限制在上表真实新闻条目所在目录。下列记录单行JSON便于复制到配置草稿；不是生产启用授权回执。

```jsonl
{"url": "https://astonbayholdings.com/news-media/news/", "status": "selectors observed; final preview required", "sampleRawDate": "August 27, 2026", "config": {"url": "https://astonbayholdings.com/news-media/news/", "language": "en", "itemSelector": "div.wp-block-group.is-vertical.is-layout-flex", "linkSelector": "a.wp-block-button.wp-elements-5.wp-block-read-more", "titleSelector": "a.wp-block-button.wp-elements-5.wp-block-read-more", "publishedAtSelector": "div.has-link-color.wp-elements-3.wp-block-post-date"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:58:39.274490+00:00"}
{"url": "https://aldebaranresources.com/2026/", "status": "selectors observed; final preview required", "sampleRawDate": "October 5, 2026", "config": {"url": "https://aldebaranresources.com/2026/", "language": "en", "itemSelector": "div.post-details", "linkSelector": "a", "titleSelector": "a", "publishedAtSelector": "span.post-date"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:58:39.525700+00:00"}
{"url": "https://www.aris-mining.com/news", "status": "selectors observed; final preview required", "sampleRawDate": "Oct 7, 2026", "config": {"url": "https://www.aris-mining.com/news", "language": "en", "itemSelector": "div.media-body.col-md", "linkSelector": "a", "titleSelector": "a", "publishedAtSelector": "time"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:58:39.852784+00:00"}
{"url": "https://americanbatterytechnology.com/news/", "status": "selectors observed; final preview required", "sampleRawDate": "August 8, 2026", "config": {"url": "https://americanbatterytechnology.com/news/", "language": "en", "itemSelector": "li", "linkSelector": "a.wp-block-latest-posts__post-title", "titleSelector": "a.wp-block-latest-posts__post-title", "publishedAtSelector": "time.wp-block-latest-posts__post-date"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:58:41.101697+00:00"}
{"url": "https://www.copperfoxmetals.com/news", "status": "selectors observed; final preview required", "sampleRawDate": "May 7, 2026", "config": {"url": "https://www.copperfoxmetals.com/news", "language": "en", "itemSelector": "a.group.block.border", "linkSelector": "a.group.block.border", "titleSelector": "h2.text-base.font-bold.text-brand-gray-800", "publishedAtSelector": "p.text-xs.font-semibold.text-brand-red"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:58:43.959777+00:00"}
{"url": "https://e3lithium.ca/", "status": "selectors observed; final preview required", "sampleRawDate": "Sep 30, 2026", "config": {"url": "https://e3lithium.ca/", "language": "en", "itemSelector": "a.news-item", "linkSelector": "a.news-item", "titleSelector": "a.news-item", "publishedAtSelector": "span.date"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:58:45.973119+00:00"}
{"url": "https://denisonmines.com/news/", "status": "selectors observed; final preview required", "sampleRawDate": "August 12, 2026", "config": {"url": "https://denisonmines.com/news/", "language": "en", "itemSelector": "div.uk-grid-collapse", "linkSelector": "a", "titleSelector": "a", "publishedAtSelector": "div.date"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:58:46.353817+00:00"}
{"url": "https://encoreuranium.com/news/", "status": "selectors observed; final preview required", "sampleRawDate": "October 1, 2026", "config": {"url": "https://encoreuranium.com/news/", "language": "en", "itemSelector": "div.elementor-widget-wrap.elementor-element-populated", "linkSelector": "a", "titleSelector": "a", "publishedAtSelector": "span.elementor-heading-title.elementor-size-default"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:58:48.285741+00:00"}
{"url": "https://electrabmc.com/news-releases/news/index.php", "status": "selectors observed; final preview required", "sampleRawDate": "Oct \n\t\t 13 \n\t\t 2026", "config": {"url": "https://electrabmc.com/news-releases/news/index.php", "language": "en", "itemSelector": "div.list-item", "linkSelector": "a", "titleSelector": "a", "publishedAtSelector": "div.date"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:58:49.871322+00:00"}
{"url": "https://fortuneMinerals.com/", "status": "selectors observed; final preview required", "sampleRawDate": "September 18, 2026", "config": {"url": "https://fortuneMinerals.com/", "language": "en", "itemSelector": "a.news-item", "linkSelector": "a.news-item", "titleSelector": "a.news-item", "publishedAtSelector": "span.date"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:58:51.208330+00:00"}
{"url": "https://www.highlandcopper.com/", "status": "selectors observed; final preview required", "sampleRawDate": "Aug 25, 2026", "config": {"url": "https://www.highlandcopper.com/", "language": "en", "itemSelector": "article", "linkSelector": "a", "titleSelector": "a", "publishedAtSelector": "p.date"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:58:52.540167+00:00"}
{"url": "https://excellonresources.com/news/", "status": "selectors observed; final preview required", "sampleRawDate": "Sep 21, 2026", "config": {"url": "https://excellonresources.com/news/", "language": "en", "itemSelector": "div.news-item", "linkSelector": "a", "titleSelector": "a", "publishedAtSelector": "div.column.small-12.medium-3"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:58:53.839830+00:00"}
{"url": "https://www.li-ft.com/news/", "status": "selectors observed; final preview required", "sampleRawDate": "Oct  5, 2026", "config": {"url": "https://www.li-ft.com/news/", "language": "en", "itemSelector": "div.item.news-item", "linkSelector": "a", "titleSelector": "a", "publishedAtSelector": "div.date"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:58:56.643177+00:00"}
{"url": "https://www.nextsourcematerials.com/", "status": "selectors observed; final preview required", "sampleRawDate": "September 28, 2026", "config": {"url": "https://www.nextsourcematerials.com/", "language": "en", "itemSelector": "li.latest-news__post", "linkSelector": "a", "titleSelector": "a", "publishedAtSelector": "p.post__date"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:58:58.593286+00:00"}
{"url": "https://metallic-minerals.com/news/2026/", "status": "selectors observed; final preview required", "sampleRawDate": "Jul 27, 2026", "config": {"url": "https://metallic-minerals.com/news/2026/", "language": "en", "itemSelector": "div.uk-grid.uk-grid-medium", "linkSelector": "a", "titleSelector": "a", "publishedAtSelector": "div.uk-width-medium-2-10"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:58:59.434658+00:00"}
{"url": "https://ivanhoeatlantic.com/news-media/", "status": "selectors observed; final preview required", "sampleRawDate": "1 September 2026", "config": {"url": "https://ivanhoeatlantic.com/news-media/", "language": "en", "itemSelector": "div.post-card.mix.post-1110", "linkSelector": "a", "titleSelector": "a", "publishedAtSelector": "div.post-card-date"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:59:00.643756+00:00"}
{"url": "https://www.seabridgegold.com/", "status": "selectors observed; final preview required", "sampleRawDate": "October 13, 2026", "config": {"url": "https://www.seabridgegold.com/", "language": "en", "itemSelector": "a.w-inline-block", "linkSelector": "a.w-inline-block", "titleSelector": "h2.h-small.blue", "publishedAtSelector": "div.p-small-s"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:59:02.016264+00:00"}
{"url": "https://northwestcopper.ca/news/", "status": "selectors observed; final preview required", "sampleRawDate": "Oct 14, 2026", "config": {"url": "https://northwestcopper.ca/news/", "language": "en", "itemSelector": "div.flex.flex-wrap.-mx-2", "linkSelector": "a.tooltip-bottom-right", "titleSelector": "a.tooltip-bottom-right", "publishedAtSelector": "div.flex.items-center.font-semibold"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:59:04.960548+00:00"}
{"url": "https://outcropSilver.com/news/", "status": "selectors observed; final preview required", "sampleRawDate": "Oct 15, 2026", "config": {"url": "https://outcropSilver.com/news/", "language": "en", "itemSelector": "div.flex.flex-wrap.items-start", "linkSelector": "a.exception.text-secondary-800", "titleSelector": "a.exception.text-secondary-800", "publishedAtSelector": "div.flex.items-center.font-semibold"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:59:05.203519+00:00"}
{"url": "https://surgebatterymetals.com/news", "status": "selectors observed; final preview required", "sampleRawDate": "Oct 2, 2026", "config": {"url": "https://surgebatterymetals.com/news", "language": "en", "itemSelector": "a.framer-Aurfd.framer-b78e2.framer-hHdWc", "linkSelector": "a.framer-Aurfd.framer-b78e2.framer-hHdWc", "titleSelector": "a.framer-Aurfd.framer-b78e2.framer-hHdWc", "publishedAtSelector": "div.framer-kk3dym"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:59:05.707547+00:00"}
{"url": "https://sitkagoldcorp.com/news/", "status": "selectors observed; final preview required", "sampleRawDate": "October 14, 2026", "config": {"url": "https://sitkagoldcorp.com/news/", "language": "en", "itemSelector": "div.wp-block-group.is-vertical.is-layout-flex", "linkSelector": "a.wp-block-button.wp-elements-5.wp-block-read-more", "titleSelector": "a.wp-block-button.wp-elements-5.wp-block-read-more", "publishedAtSelector": "div.has-link-color.wp-elements-3.wp-block-post-date"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:59:08.531111+00:00"}
{"url": "https://www.ur-energy.com/", "status": "selectors observed; final preview required", "sampleRawDate": "Aug 20, 2026", "config": {"url": "https://www.ur-energy.com/", "language": "en", "itemSelector": "article.media", "linkSelector": "a", "titleSelector": "a", "publishedAtSelector": "p.date"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:59:09.639782+00:00"}
{"url": "https://vizslasilvercorp.com/news/", "status": "selectors observed; final preview required", "sampleRawDate": "October 9, 2026", "config": {"url": "https://vizslasilvercorp.com/news/", "language": "en", "itemSelector": "article.post", "linkSelector": "a.post__title", "titleSelector": "a.post__title", "publishedAtSelector": "div.post__date"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:59:11.670510+00:00"}
{"url": "https://surgecopper.com/news-releases/2026", "status": "selectors observed; final preview required", "sampleRawDate": "Oct 2, 2026", "config": {"url": "https://surgecopper.com/news-releases/2026", "language": "en", "itemSelector": "div.flex.flex-wrap.py-3", "linkSelector": "a", "titleSelector": "a", "publishedAtSelector": "div.w-full.px-2"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:59:11.678196+00:00"}
{"url": "https://www.westerncopperandgold.com/", "status": "selectors observed; final preview required", "sampleRawDate": "September 14, 2026", "config": {"url": "https://www.westerncopperandgold.com/", "language": "en", "itemSelector": "div.elementor-element.elementor-element-15eea85.e-con-full", "linkSelector": "a", "titleSelector": "a", "publishedAtSelector": "h4.elementor-heading-title.elementor-size-default"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:59:14.531373+00:00"}
{"url": "https://talonmetals.com/2026-2/", "status": "selectors observed; final preview required", "sampleRawDate": "October 6, 2026", "config": {"url": "https://talonmetals.com/2026-2/", "language": "en", "itemSelector": "tr.ee-table__row", "linkSelector": "a.ee-table__text", "titleSelector": "a.ee-table__text", "publishedAtSelector": "span.ee-table__text__inner"}, "UTCOffset": "omit: date-only source", "checkedAt": "2026-10-15T12:59:16.386801+00:00"}
```

末批规范入口：Beowulf robots404按现有采集规则允许列表读取；最新RSS样例2026-07-27，更新较慢。Canada Nickel官网robots200，新闻列表200，配置建议：itemSelector=`li.document-type-news-releases .document-card`、linkSelector=`h3 a[href]`、titleSelector=`h3`、publishedAtSelector=`p.date`、sourceDate.formatPattern=`MMMM D, YYYY`、language=en；PDF在公司新闻页直接指向的S3桶，allowUrlPrefixes需限`https://wp-canadanickel-2025.s3.ca-central-1.amazonaws.com/media/`，文件主机robots与许可另验，本文未下载PDF，不增加独立来源计数。

Amarc最终改用新闻列表（2026-10-15T13:02:28.040488+00:00核验）：robots404允许，列表200。最小建议：`kind=web_list`、`config.url=https://amarcresources.com/news-releases/`、`itemSelector=#news-list .year > .uk-grid-small`、`linkSelector=.uk-display-inline-block a[href]`、`titleSelector=div[class~="uk-width-expand@s"]`、`publishedAtSelector=div[class~="uk-width-1-4@s"]`、`sourceDate.format=declared`、`formatPattern=MMMM D, YYYY`、`language=en`，仅日期精度，不填UTC offset。新闻条目URL前缀限定`https://amarcresources.com/news-releases/`。

“最新观察到的日期”是本次列表/Feed中核对的最新样例，不声称检索了该机构全部历史栏目。全站最新需最终preview按配置排序进一步确认。RSS时间按原有时区解析；HTML日期常见模式为`MMM D, YYYY`、`MMMM D, YYYY`、`D MMMM YYYY`、`MMM D YYYY`，按每行sampleRawDate显式选择，不根据服务器时区猜测。
