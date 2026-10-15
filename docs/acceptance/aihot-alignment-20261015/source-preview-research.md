# 信源最终去重、配置与原生解析预览研究

更新：2026-10-15T17:09:10.666070Z。仅更新本报告和同名JSON；未访问/修改生产，未改产品代码、分支或旧研究报告。

**最终研究池为71条真正新增候选：70条近期、Giyani 1条更新偏慢。** 原60条与全部440条生产安全身份记录逐项对照，重复排除0、身份待核0；补充研究得到11条近期候选。所有数量均是研究/解析结果，未宣称生产启用、自然采集或200达标。

录入草案请仅取同名 [JSON](source-preview-research.json) 的 `intake_candidate_ids` 对应 `entries[].source`。`recent_intake_candidate_ids`为70条近期；`stale_intake_candidate_ids`为Giyani。池外9个补充尝试没有纳入，不要直接遍历全部entries建源。全部草案enabled=false、全文公开开关关闭。

## 去重与创建批次结论

- 新安全快照共440条，包含全部69条停用来源，list_host/origin_host全部有值。按主机规范化（大小写、www、末尾点及子域关系）、名称/ID、已有owner_entity_id、明确旧域名别名复核，并对照当前种子和320个原规划目标。
- 原60条：明确重复0，身份待核0，新增候选60；其中国际矿企名称相似者已分开，未把停用的既有来源当新增。补充通过11条与同一基线也无匹配。71条最终池内没有待定身份。
- Goldshore跳转GoldX2的机构/域名迁移仍待核，留在池外；不把换域名或更名自动算新机构。Thesis Gold与Thesis Gold and Silver作为同一候选处理，旧、新域名共同参加去重。
- 按created_at的UTC日期分组：10月14日前270条，10月14日创建170条。以创建字段为准，不能靠exp-20261014等ID前缀判断批次。
- 这170条中，148启用，144同时有条目和last_ok_at；Codelco命中原规划codelco.com，不能计入“真正新增”，因此余量安排采用143这一基础条件代理数。它仍不是最终配置自然采集验收数。
- 143加本次70条近期候选为213，约有13条理论失败余量。200最终验收仍需逐条最终配置预览、生产启用及自然任务回执；Giyani和池外尝试均不计这项余量。
- 安全快照SHA-256：`473968a86ce849af1a0ce959e12ccae9d9635565b2031169b386f26336590f8a`；文件时间：2026-10-15T16:39:38.038311Z。逐条匹配结果、机构名/域名别名、创建批次规则均在JSON。

## 71条最终研究候选

| 独立发布方 | 批次 | 类型 | 唯一/有日期 | 最新观察日期 | 官方入口 |
|---|---|---|---|---|---|
| Abitibi Metals | 补充11 | rss | 10/10 | 2026-09-17 | [入口](https://abitibimetals.com/feed/) |
| Aldebaran Resources | 原60 | web_list | 20/20 | 2026-10-05 | [入口](https://aldebaranresources.com/2026/) |
| Amarc Resources | 原60 | web_list | 192/192 | 2026-09-15 | [入口](https://amarcresources.com/news-releases/) |
| American Battery Technology Company | 原60 | web_list | 5/5 | 2026-08-08 | [入口](https://americanbatterytechnology.com/news/) |
| American Lithium | 原60 | rss | 10/10 | 2026-09-16 | [入口](https://americanlithiumcorp.com/feed/) |
| American Pacific Mining | 原60 | rss | 10/10 | 2026-10-06 | [入口](https://americanpacificmining.com/feed/) |
| Appia Rare Earths & Uranium | 原60 | rss | 9/9 | 2026-10-05 | [入口](https://appiareu.com/feed/) |
| Aris Mining | 原60 | web_list | 10/10 | 2026-10-07 | [入口](https://www.aris-mining.com/news) |
| Aston Bay Holdings | 原60 | web_list | 10/10 | 2026-08-27 | [入口](https://astonbayholdings.com/news-media/news/) |
| ATHA Energy | 原60 | rss | 10/10 | 2026-10-07 | [入口](https://athaenergy.com/feed/) |
| Aurania Resources | 原60 | rss | 10/10 | 2026-10-13 | [入口](https://aurania.com/feed/) |
| Beowulf Mining | 原60 | rss | 10/10 | 2026-07-27 | [入口](https://beowulfmining.com/feed/) |
| Brixton Metals | 原60 | rss | 10/10 | 2026-10-14 | [入口](https://brixtonmetals.com/feed/) |
| Canada Nickel | 原60 | web_list | 9/9 | 2026-10-06 | [入口](https://canadanickel.com/investors/news-releases/) |
| CanAlaska Uranium | 原60 | rss | 10/10 | 2026-09-21 | [入口](https://canalaska.com/feed/) |
| Chesapeake Gold | 原60 | rss | 10/10 | 2026-09-22 | [入口](https://chesapeakegold.com/feed/) |
| Collective Mining | 原60 | rss | 10/10 | 2026-10-13 | [入口](https://collectivemining.com/feed/) |
| Copper Fox Metals | 原60 | web_list | 24/24 | 2026-09-21 | [入口](https://www.copperfoxmetals.com/news) |
| Deep Yellow | 原60 | rss | 10/10 | 2026-09-24 | [入口](https://deepyellow.com.au/feed/) |
| Denison Mines | 原60 | web_list | 10/10 | 2026-08-12 | [入口](https://denisonmines.com/news/) |
| Dryden Gold | 补充11 | web_list | 8/8 | 2026-10-14 | [入口](https://drydengold.com/news/) |
| E3 Lithium | 原60 | web_list | 2/2 | 2026-09-30 | [入口](https://e3lithium.ca/) |
| Electra Battery Materials | 原60 | web_list | 264/264 | 2026-10-13 | [入口](https://electrabmc.com/news-releases/news/index.php) |
| Empress Royalty | 补充11 | web_list | 9/9 | 2026-09-18 | [入口](https://www.empressroyalty.com/news) |
| enCore Energy | 原60 | web_list | 10/10 | 2026-10-01 | [入口](https://encoreuranium.com/news/) |
| Eurobattery Minerals | 原60 | rss | 10/10 | 2026-10-15 | [入口](https://eurobatteryminerals.com/feed/) |
| Excellon Resources | 原60 | web_list | 334/334 | 2026-09-21 | [入口](https://excellonresources.com/news/) |
| F3 Uranium | 原60 | rss | 10/10 | 2026-09-24 | [入口](https://f3uranium.com/feed/) |
| Fireweed Metals | 原60 | rss | 10/10 | 2026-09-15 | [入口](https://fireweedmetals.com/feed/) |
| Fortune Minerals | 原60 | web_list | 4/4 | 2026-09-18 | [入口](https://fortuneminerals.com/) |
| FPX Nickel | 原60 | rss | 5/5 | 2026-10-01 | [入口](https://fpxnickel.com/feed/) |
| Giga Metals | 原60 | rss | 10/10 | 2026-10-08 | [入口](https://gigametals.com/feed/) |
| Giyani Metals（更新偏慢） | 原60 | rss | 10/10 | 2026-07-10 | [入口](https://giyanimetals.com/feed/) |
| Goliath Resources | 原60 | rss | 10/10 | 2026-10-07 | [入口](https://goliathresourcesltd.com/feed/) |
| Graphite One | 原60 | rss | 10/10 | 2026-10-01 | [入口](https://www.graphiteoneinc.com/feed/) |
| Heliostar Metals | 补充11 | web_list | 179/179 | 2026-10-13 | [入口](https://www.heliostarmetals.com/news-media/news-releases/) |
| Highland Copper | 原60 | web_list | 10/10 | 2026-08-25 | [入口](https://www.highlandcopper.com/) |
| Ivanhoe Atlantic | 原60 | web_list | 9/9 | 2026-09-01 | [入口](https://ivanhoeatlantic.com/news-media/) |
| Kenorland Minerals | 补充11 | web_list | 155/155 | 2026-10-07 | [入口](https://www.kenorlandminerals.com/news/) |
| Lavras Gold | 补充11 | web_list | 14/14 | 2026-10-13 | [入口](https://lavrasgold.com/2026/) |
| Li-FT Power | 原60 | web_list | 120/120 | 2026-10-05 | [入口](https://www.li-ft.com/news/) |
| Magna Mining | 原60 | rss | 10/10 | 2026-10-08 | [入口](https://magnamining.com/feed/) |
| Metallic Minerals | 原60 | web_list | 15/15 | 2026-07-27 | [入口](https://metallic-minerals.com/news/2026/) |
| New Found Gold | 补充11 | web_list | 16/16 | 2026-10-15 | [入口](https://newfoundgold.ca/news-releases/) |
| NextSource Materials | 原60 | web_list | 3/3 | 2026-09-28 | [入口](https://www.nextsourcematerials.com/) |
| Northern Graphite | 原60 | rss | 10/10 | 2026-10-05 | [入口](https://www.northerngraphite.com/feed/) |
| NorthWest Copper | 原60 | web_list | 10/10 | 2026-10-14 | [入口](https://northwestcopper.ca/news/) |
| Outcrop Silver | 原60 | web_list | 10/10 | 2026-10-15 | [入口](https://outcropsilver.com/news/) |
| Q2 Metals | 原60 | rss | 10/10 | 2026-10-07 | [入口](https://q2metals.com/feed/) |
| Rock Tech Lithium | 原60 | rss | 10/10 | 2026-10-10 | [入口](https://rocktechlithium.com/en/feed/) |
| Salazar Resources | 补充11 | web_list | 14/14 | 2026-10-08 | [入口](https://www.salazarresources.com/investors/regulatory-news/) |
| Scottie Resources | 补充11 | rss | 6/6 | 2026-10-14 | [入口](https://scottieresources.com/rss/) |
| Seabridge Gold | 原60 | web_list | 3/3 | 2026-10-13 | [入口](https://www.seabridgegold.com/) |
| Silver Bullet Mines | 原60 | rss | 10/10 | 2026-10-06 | [入口](https://silverbulletmines.com/feed/) |
| Silver Storm Mining | 原60 | rss | 12/12 | 2026-09-15 | [入口](https://silverstorm.ca/feed/) |
| Silver X Mining | 原60 | rss | 10/10 | 2026-10-08 | [入口](https://www.silverxmining.com/feed/) |
| Sitka Gold | 原60 | web_list | 200/200 | 2026-10-14 | [入口](https://sitkagoldcorp.com/news/) |
| South Star Battery Metals | 原60 | rss | 7/7 | 2026-10-01 | [入口](https://southstarbatterymetals.com/feed/) |
| Stallion Uranium | 原60 | rss | 10/10 | 2026-09-29 | [入口](https://stallionuranium.com/feed/) |
| StrikePoint Gold | 原60 | rss | 10/10 | 2026-10-13 | [入口](https://strikepointgold.com/feed/) |
| Surge Battery Metals | 原60 | web_list | 8/8 | 2026-10-02 | [入口](https://surgebatterymetals.com/news) |
| Surge Copper | 原60 | web_list | 15/15 | 2026-10-02 | [入口](https://surgecopper.com/news-releases/2026) |
| Talon Metals | 原60 | web_list | 24/24 | 2026-10-06 | [入口](https://talonmetals.com/2026-2/) |
| Thesis Gold and Silver | 补充11 | web_list | 69/69 | 2026-09-28 | [入口](https://www.thesisgoldsilver.com/news-media/news/) |
| Ucore Rare Metals | 原60 | rss | 10/10 | 2026-09-14 | [入口](https://ucore.com/feed/) |
| Ur-Energy | 原60 | web_list | 3/3 | 2026-08-20 | [入口](https://www.ur-energy.com/) |
| Vior Gold Corporation | 补充11 | web_list | 134/134 | 2026-09-01 | [入口](https://www.vior.ca/news/) |
| Vizsla Copper | 原60 | rss | 10/10 | 2026-10-07 | [入口](https://vizslacopper.com/feed/) |
| Vizsla Silver | 原60 | web_list | 19/19 | 2026-10-09 | [入口](https://vizslasilvercorp.com/news/) |
| West Red Lake Gold | 原60 | rss | 10/10 | 2026-09-22 | [入口](https://westredlakegold.com/feed/) |
| Western Copper and Gold | 原60 | web_list | 6/6 | 2026-09-14 | [入口](https://www.westerncopperandgold.com/) |

## 重点矿企与日期修复

- Glencore的`:articles`单引号静态数组已原生解析24条；只解析数据，不执行脚本。
- SEC南铜、纽蒙特、巴里克、SQM的列式列表分别解析286/148/315/653条指定披露类型；使用官方CIK、accessionNumber去连字符、primaryDocument构造并核验文件链接，四个样例HEAD均200。这四视图是矿企覆盖补齐，不是四个新监管机构。
- 天齐上轮真实接口10条中，raw=`2026-10-10 00:00:00`，来源观测仅保留date，utc/local_time为空；旧candidate.publishedAt为空。当前实现修复后，使用已保存的5组真实公开字段重放，5/5得到内部日排序锚点，样例`2026-10-09T16:00:00.000Z`；来源真实UTC和local_time仍为空，precision仍date。**这只证明解析修复，不是新鲜HTTP预览。**
- 本轮天齐新鲜请求在robots阶段停止，汇总记录时间2026-10-15T17:01:10.785783Z。脚本只输出`robots blocked`，未保存该次具体HTTP状态或curl错误，因此不将其写成已证实的403或超时。没有继续请求公告接口；停止指令后没有再访问受阻接口。最终配置预览及生产自然采集仍待验。
- Aris依据官方可见`Oct 7, 2026 5:00 pm EDT`声明时区；对应17:00本地时间解析为21:00Z，不使用默认北京时间。完整来源片段、早期差异和修正结果在JSON。

## 池外补充尝试（不计入71）

| 对象 | 未纳入原因 |
|---|---|
| Orogen Royalties | 本次读取无响应超时，未绕过或认定可用。 |
| Regulus Resources | 官方新闻列表最近样例为2026-07-03；所声明RSS还混入Share Structure/Presentations等页面，不纳入近期余量。 |
| Gunnison Copper | 公开列表可读，但未提取出可复核的日期卡片配置。 |
| Goldshore Resources | 旧域名跳转GoldX2；机构/域名迁移待核，不算新增。 |
| Red Pine Exploration | robots未通过，未继续取列表。 |
| Leading Edge Materials | 本次列表读取超过研究阶段1.5MB上限，未完成最终适配；不是网站永久不可用结论。 |
| Defense Metals | 所试新闻路径404；没有取得本轮可用最终配置，不代表整个公司网站拒绝访问。 |
| Almonty Industries | 自动样例把投资者日标题中的2026-10-19当成发布日期，且/news跳到文章页；明确排除这个错误候选。 |
| Euro Manganese | 未完成可复核的日期/标题/链接配置。 |

## 配置与验证边界

- RSS使用config.feedUrl；HTML/JSON仅使用当前支持字段。Electra按日/月/年三个真实元素组合日期；enCore、Aston、Sitka、E3、Fortune等已校正标题容器；Vior用明确MM/DD/YYYY并与官方英文日期交叉核对。
- Copper Fox完整列表约4.67MB，在产品既有8MB上限内通过，最新日期是9月21日，前期小样本旧日期结论已修正。
- 所有公开读取先经仓库原生robots规则，遵守至少5秒或站点Crawl-delay。RSS用禁网MockAgent重放真实响应且保留官方feedUrl；JSON/HTML使用原生jsonListDocument/fromHtml。
- 最终71份候选配置与6份重点配置共77份通过schema校验；已记录观察的配置哈希无不匹配。HTTP响应哈希、时间、真实样本及解析精度在JSON；没有真实模型调用。
- 仅日期的UTC仍为空；candidatePublishedAt的日排序锚点不能作为来源真实发稿时刻。字段重放与真实HTTP、原生解析与生产preview、启用与自然采集分别标记。
- 日期为列表/Feed观察到的最新值，不宣称覆盖机构全部栏目。历史列表可能返回数百条，不能据此批量重评分或绕开既有首次导入/刊期规则。
- Canada Nickel的官方列表指向S3 PDF；列表有效不代表文件主机许可与正文下载已验收。Giyani更新偏慢，单列等待，不用来凑近期达标数。
- 创建批次快照只是安全身份数据；没有读取全文配置、秘密、原文或写生产。没有改旧研究报告。
