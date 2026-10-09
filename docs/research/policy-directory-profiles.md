# 已登记官方目录分页配置现场记录

TASK0144，2026-10-09，本机正常TLS、项目公开爬虫标识，遵守robots与至少2秒间隔。没有改变登记来源启用状态、模型配置或公开资格。原始响应只存在忽略的`.verify/task0144-recordings/`，仓库不保存官方原文。下表的“可运行”限目录发现，不能解释为原件取得、完整解读、公开资格或全量覆盖已完成。

| 登记源 | 本次真实结构与访问结果 | 配置/自动运行边界 | 完整回执 |
| --- | --- | --- | --- |
| AR-008 胡胡伊省公报三类目录 | robots 404；官方分类接口确认13=Leyes、11=Decretos、21=Resoluciones。联合posts接口明确声明93,166记录、1,864页；实际首页50条、第二页50条、末页16条，独立首页复取指纹一致。三页共116个唯一观察ID，类别越界0 | 已配`directoryProfile`，使用真实响应Link关系验证页码、X-WP总数字段、post ID、modified_gmt。每条记录仍必须属于这三类；不会把全站文章集合当法规目录。该集合包含个别行政行为，后续独立法规资格门仍必需；未配置取得profile不会伪装成可自动解读 | **未完成整轮**，不写complete；只读后续按0134检查点推进 |
| US-009 BLM Instruction Memoranda | robots允许政策路径；首页、第二页、末页及首页复取均200，分页器声明61页，当前页标识与来源URL明确。观察页含Inactive记录，但HTML未声明总记录数 | 保留既有原件取得profile和缺附件引用核对；完整目录profile留空。不能用25×页数或“最后一页13条”代替来源声明总数，也不能把Inactive直接写成法律废止 | 缺结构依据，不授完整 |
| CN-003 自然资源部行政规范性文件 | 当前本机`gk.mnr.gov.cn` DNS解析失败，未取得robots与目录结构 | 不关闭TLS，不换线路绕过；保留既有配置和其他地域历史记录，不把本机失败扩写成全球不可用 | 缺现场回执 |

## 依据与口径

- [胡胡伊公报官方分类接口](https://boletinoficial.jujuy.gob.ar/index.php?rest_route=/wp/v2/categories&include=13,11,21)：现场分类计数为Decretos 53,778、Leyes 6,497、Resoluciones 32,892；相加93,167，联合集合声明93,166，说明分类有交叠。实现按联合集合的真实ID校验，不相加充当法规数。
- [同一三类联合目录](https://boletinoficial.jujuy.gob.ar/index.php?rest_route=/wp/v2/posts&categories=13,11,21&per_page=50&_fields=id,link,date_gmt,modified_gmt,title,excerpt,categories,type&page=1)：最终配方在06:53:12、06:53:16、06:53:19、06:53:22 UTC读取首页、第二页、末页、首页复核。真正recordId为网站post ID；没有独立法律文书ID依据，所以`documentId`不填，文书数保持未知。
- [WordPress官方分页说明](https://developer.wordpress.org/rest-api/using-the-rest-api/pagination/)说明page参数和X-WP-Total/X-WP-TotalPages。现场的Link `prev`/`next`同时提供实际分页关系；本实现不拿请求里的page当服务器已返回正确页的证明。链接须同host、同path、同集合查询参数；CSV分类与WordPress数组参数只作等价规范化，不能改变分类集合。
- [BLM官方目录](https://www.blm.gov/policy/instruction-memorandum)仍是登记的IM/PIM来源。未找到总记录数字段时留缺口，不加入合成常量；原件取得配置与目录覆盖是两个独立边界。

## 实现与本地证据

`pageNumber.kind=link_neighbors`只适用于显式的一起始query页码；验证相邻关系、双向一致性与边界。响应声明0记录/0页时允许一次物理空响应，原始`declaredTotalPages=0`保留在页/轮证据里，不虚构目录记录。`recordScope`是逐条来源分类依据；缺失或越界直接终止整轮，不静默丢弃行后冒称总数一致。

读取配方版本为`directory-v2`，已有扫描遇到解析契约变化从首页重开。X-WP总数、Link等声明字段沿0107持久请求缓存保存，worker恢复仍能验证原响应；模型transport未改。新增字段、重复/矛盾/缺失分页、错目录Link、类别越界、空目录均有小合成用例。既有分页持久化、原子切换与历史边界用例保留。

原始响应及可复核摘要：`profile-validation.json`（AR-008）、`blm-directory-validation.json`（BLM）、`mnr-robots.json`（DNS），均在忽略的`.verify/task0144-recordings/`。本地研究续扫状态保存在`continuation-state.json`，使用独立PG59144与研究ID，不修改登记源，不运行worker、模型或公开API；中断后仍可从现有扫描位置续读。其尚未完成时不得在正式报告中计complete或把材料计成已公开法规。
