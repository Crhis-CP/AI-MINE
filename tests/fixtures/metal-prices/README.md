# 金属价格夹具（TASK-0044、0046、0049、0068、0082）

金属价格表的解析测试用这些夹具。它们是从三个官方网站的原件裁出来的。原件在 2026-10-06 由 Owner Mac 上的本地会话在上海服务器（正式站所在的腾讯云主机）上录下，只做了只读请求，请求头的 User-Agent 是 `Mozilla/5.0 (compatible; AIMiningPolicyBot/1.0; +https://aiminingpolicy.com/about)`。原件不进 Git，留在服务器的 `/opt/aimine/.ops/fixtures-raw/2026-10-06/`；裁剪件也留了一份在 `/opt/aimine/.ops/fixtures-cropped/2026-10-06/`。

## 原件

下表就是录制时写下的 `record.tsv`。三个 robots.txt 的 404 是因为这些主机上没有 robots 文件；其余都是 200，没有遇到验证页。

| 保存名 | 地址 | 最终地址 | 抓取时间（UTC） | HTTP 状态 | 大小（字节） | sha256 |
|---|---|---|---|---|---|---|
| `nbs-robots.txt` | https://www.stats.gov.cn/robots.txt | 同左 | 2026-10-06T04:34:29Z | 404 | 153 | `6807c84bf35d67496e020c1528303b87d4759933c09817e514a7159ac689d352` |
| `nbs-terms.html` | https://www.stats.gov.cn/wzgl/202302/t20230217_1912857.html | 同左 | 2026-10-06T04:34:30Z | 200 | 127670 | `fcb330d080046d9700e53c9a6416b3a97ca52a5cea770e7d467c2ea98589b5fe` |
| `nbs-list.html` | https://www.stats.gov.cn/sj/zxfb/index.html | 同左 | 2026-10-06T04:34:30Z | 200 | 73013 | `40064f27414db06a7d2eaf62c5fac94d177ed2707db9827b9a679642fe772fcd` |
| `nbs-release-latest.html` | https://www.stats.gov.cn/sj/zxfb/202609/t20260923_1965403.html | 同左 | 2026-10-06T04:35:18Z | 200 | 435855 | `63282e245e9d232eb2f6498c7e604ec0c8d2f6487d306f0c9c0ce37132aeb189` |
| `nbs-release-previous.html` | https://www.stats.gov.cn/sj/zxfb/202609/t20260914_1965293.html | 同左 | 2026-10-06T04:35:20Z | 200 | 435489 | `0cee7a8696c3ec481f1026c6278ad80ff14b75cf6f73006d86f4ccce24527492` |
| `wb-robots.txt` | https://www.worldbank.org/robots.txt | 同左 | 2026-10-06T04:35:34Z | 200 | 1505 | `5c36a22fe5b1a380eec660d48c98cc850aa242bb0ca9c5a817a4b49ca621f186` |
| `wb-docs-robots.txt` | https://thedocs.worldbank.org/robots.txt | 同左 | 2026-10-06T04:35:36Z | 404 | 100826 | `1c48e2bb0b650b57f50006624c8d3475a4a40c2fa9fcd6b21fb1f2d0c4b65bc1` |
| `wb-commodity-markets.html` | https://www.worldbank.org/en/research/commodity-markets | 同左 | 2026-10-06T04:35:36Z | 200 | 55897 | `6de1e8e897cb061a8cb494b6035186c1d932a50e2ed905289b5872e6d64f7dcd` |
| `wb-monthly.xlsx` | https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/related/CMO-Historical-Data-Monthly.xlsx | 同左 | 2026-10-06T04:35:51Z | 200 | 586099 | `ea1c350827878ea3bbe30e3cda16a13fd3bd5b409b8458940dc94a36b5a33154` |
| `wb-terms.html` | https://data.worldbank.org/summary-terms-of-use | 同左 | 2026-10-06T04:35:52Z | 200 | 207426 | `3b2c7bd6d1614644eef35d7dcd502df66525d662b528f6cdd702ba9d5284f632` |
| `wb-datacatalog.html` | https://datacatalog.worldbank.org/search/dataset/0038238/commodity-prices-history-and-projections | 同左 | 2026-10-06T04:35:53Z | 200 | 49152 | `dc8cba50003ebfb69286f9be4f97870aff717a9fd63b2e30d573a0537dad3d59` |
| `imf-robots.txt` | https://www.imf.org/robots.txt | 同左 | 2026-10-06T04:36:08Z | 404 | 48 | `e5b09412cd805f1a41a70e81599f3387dd00eb2857e76475676df5552dadf021` |
| `imf-commodity-prices.html` | https://www.imf.org/en/research/commodity-prices | 同左 | 2026-10-06T04:36:09Z | 200 | 7843 | `aaa3e012c7445bb5d920e62dabcb95e4b012dbccf56f15952b503aa0c4e79e95` |
| `imf-external-data.xlsx` | https://www.imf.org/-/media/files/research/commodityprices/monthly/external-data.xlsx | 同左 | 2026-10-06T04:36:23Z | 200 | 619264 | `e0bc0cbbd08208e9868fb16e21992ff4b86a7676a2b5f64d32a02bdb8bdcc464` |
| `imf-terms.html` | https://www.imf.org/en/about/copyright-and-terms | 同左 | 2026-10-06T04:36:24Z | 200 | 12908 | `c1d932fb11f68f22c37e576486d5674e1a6edba729e8fae6f24355155dabf0b8` |

## 条款与署名

| 来源 | 署名 | 许可与条款 |
|---|---|---|
| 世界银行 | The World Bank: Commodity Price Data (The Pink Sheet) | CC BY 4.0（数据集页面 https://datacatalog.worldbank.org/search/dataset/0038238/commodity-prices-history-and-projections 写着 “License : Creative Commons Attribution 4.0”）；使用条款 https://data.worldbank.org/summary-terms-of-use |
| IMF | Source: International Monetary Fund, Primary Commodity Prices, https://www.imf.org/en/research/commodity-prices | 仅作非商业使用；条款 https://www.imf.org/en/about/copyright-and-terms |
| 国家统计局 | 转自国家统计局网站 https://www.stats.gov.cn | 服务条款 https://www.stats.gov.cn/wzgl/202302/t20230217_1912857.html |

## 裁法

- 保留的部分逐字节照原件，不改写、不重排，只删不加。
- HTML 外面最多补一层 `<html><head><meta charset=…></head><body>…</body></html>`，`<meta charset>` 照原件那一个标签。
- 只保留目标元素和它所在的列表、表格那几层的开、闭标签。
- 裁剪脚本只用系统自带 `python3` 的标准库，在服务器上运行，原件裁剪前后 sha256 不变。

| 文件 | 留了什么 | 删了什么 |
|---|---|---|
| `nbs/list.html` | 最新列表页的 `<ul>` 那一层，其中第一条无关条目（2026年9月中国采购经理指数运行情况，2026-09-30）和最新两期“旬流通领域重要生产资料市场价格变动情况”（9月中旬 2026-09-24、9月上旬 2026-09-14）各一个 `<li>`，每条里三个尺寸的链接和旁边的日期 `<span>` 都在；条目前后原有的缩进照留 | 页面其余部分和列表里其他条目 |
| `nbs/release-latest.html`、`nbs/release-previous.html` | 页面上的发布标题元素 `<h1>`（里面是原页面写标题的那段脚本），和价格表整张 `<table>`：表头、全部 50 个品种的行、表下的注 | 页面其余部分；页面里同一张价格表的第二份副本（另一尺寸用），以及“监测产品说明”那张表 |
| `worldbank/commodity-markets.html` | 含 `CMO-Historical-Data-Monthly.xlsx` 链接的那个单元格（链接文字 “Monthly prices” 和下面的 “October 2026 (XLS)”），连同它所在的 `<table>`、`<tbody>`、`<tr>` 标签 | 页面其余部分和同一表格里的其他单元格 |
| `worldbank/monthly.xlsx` | 只留 Monthly Prices 与 Description 两张工作表。Monthly Prices 留第 1–4 行（标题与“Updated on October 02, 2026”）、第 5 行（品名）、第 6 行（单位）和最近三个月 2026M07–2026M09（第 805–807 行）；列只留日期列 A 和铝、铁矿石、铜、铅、锡、镍、锌、金、铂、银 10 列（BK–BT）。Description 留第 1–2 行（表头）和这 10 项的整行（第 88、89、90、92、93、99、100、103、104、105 行）。保留单元格的位置、`s`、`t` 属性照原件，`styles.xml` 与主题照原件；`sharedStrings.xml` 只留还被引用的 39 个字符串并按原顺序重新编号 | 另外三张工作表（Mismatch Details、Monthly Indices、Index Weights），其余行列；打印设置（`pageMargins`、`pageSetup`、`headerFooter` 与打印机设置文件），定义名称（打印区域与 `#REF!` 名称），以及工作簿里的图片、表格对象、数据连接、customXml、文档属性（`docProps`：含编辑人姓名与文档标签，解析用不到）；工作簿、关系与内容类型文件去掉了这些部件的条目 |
| `imf/commodity-prices.html` | 含 `external-data.xlsx` 链接的那一个 `<li>`，链接文字 “Excel Database: September 2026 (XLSX)” 就是版本说明，连同它所在的 `<ul>` 标签 | 页面其余部分 |
| `imf/external-data.xlsx` | 唯一的工作表 External 的第 1 行（代码）、第 2 行（说明，含单位）、第 3 行（Data Type）、第 4 行（Frequency）和最近三个月 2026M6–2026M8（第 562–564 行）；列只留日期列 A 和钼（BW，PLMMODY）、钴（BX，PCOBA）、钯（CA，PPALLA）。其余同上一条；`sharedStrings.xml` 留 15 个字符串 | 其余行列；批注（在被删的 D123 单元格上，含编辑人姓名）、批注图形、自定义属性、Web 加载项、customXml、文档属性、定义名称。文件和页面上没有把这三项标为第三方数据的内容（只写着 “LME spot price”）|

裁剪后用标准库打开两个 xlsx，逐个工作表把保留的单元格和原件同一位置比对，值、`s`、`t`、公式都一致，保留的行列里原件的单元格一个不少、也没有多出来的。

## 世界银行核对依据（TASK-0068）

- robots与许可沿用2026-10-06录制记录及TASK-0068背景：`www.worldbank.org/robots.txt`为200，核对未禁止`/en/research/`（原PR162评论6010092753）；`thedocs.worldbank.org/robots.txt`为404。本轮未重新请求网页或连接生产。
- 数据集页记录的许可为CC BY 4.0，使用条款按数据集metadata处理第三方数据；TASK-0068指向的原PR166评论6011274610记录：原件Description的A108/B108解释星号为“denotes forecast series”，不是第三方限制，T列为Sources。裁剪件不含这条表尾说明，不将任务卡的原件核对说成本轮重新读取原件。
- “月平均价”依据是[2026年10月版Pink Sheet](https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/related/CMO-Pink-Sheet-October-2026.pdf)月度栏表头“Monthly Averages”（TASK-0068记录的2026-10-06 13:56Z核对）；不是裁剪XLSX前四行的文字。Excel Description中的六项LME说明写“settlement price”，没有daily；金、铂写“spot average of daily rates”。
- 本轮纯读现有裁剪XLSX核对：第5行名称、第6行单位；A806/A807是2026M08/2026M09；白银9月原数为`64.599999999999994`，不得先转浮点再写回。金的现行说明是“spot average of daily rates, from June 2025”，后段99.5%属于历史说明，不写为现行规格；铁矿石原单位保留`($/dmtu)`，现行说明明确“spot in US dollar/dry ton”和“fines, 62% Fe, c.f.r. China”，不做单位换算。
- 月度页面单元格是“Monthly prices October 2026 (XLS)”，其中br形成空格；单元格没有发布日期，工作表A4的更新时间不得补成发布日期。上述核对不代表来源已部署或持续取数。

## 商务预报原件与请求（TASK-0082）

信息来源：商务预报。2026-10-08/09 UTC 在正式站所在的上海主机只读录制，未改服务、容器、数据库或配置。原件、headers、逐项 metadata 与 `record.tsv` 分别留在 `/opt/aimine/.ops/fixtures-raw/2026-10-08/task0082/`（robots）和 `/opt/aimine/.ops/fixtures-raw/2026-10-09/task0082/`（其余）；集成人保存合并索引。User-Agent 沿用本文件开头。除 robots 为 404，其余均 200、最终 URL 同请求，无跳转、验证页、Cookie 或令牌。

| 保存名 | URL | UTC 抓取时间 | 方法 / 状态 | 字节 | SHA-256 |
|---|---|---|---|---:|---|
| `mofcom-robots.txt` | https://cif.mofcom.gov.cn/robots.txt | 2026-10-08T23:59:38.944087+00:00 | GET / 404 | 72483 | `38618d36517e7205e160509cb2c0a78765946101480c3f5b455446af533b193c` |
| `mofcom-data.html` | https://cif.mofcom.gov.cn/cif/html/dataCenter2021/index.html?jgsczlzdjc_yousejinshu_224011 | 2026-10-09T00:00:27.375345+00:00 | GET / 200 | 25248 | `11410460d63af187f07fdbe451024b481a413d7fe3a284050e9409238c58810b` |
| `mofcom-terms.html` | https://cif.mofcom.gov.cn/cif/html//sczldt_pc/2026/9/1790747534085.html | 2026-10-09T00:00:27.560757+00:00 | GET / 200 | 19077 | `0396a382e32964bb1ac3645ce3485bf0508e3ef76d6874d47a724bcd009f8fb0` |
| `mofcom-zhouduData.js` | https://cif.mofcom.gov.cn/cif/resDataIndex/js/zhouduData.js | 2026-10-09T00:01:23.156492+00:00 | GET / 200 | 4265 | `131b6053b8fb550da461805821dc59da7db128ade2fb33d800374f57794f24b3` |
| `mofcom-dataCenterCtrl.js` | https://cif.mofcom.gov.cn/cif/resDataIndex/js/dataCenterCtrl.js | 2026-10-09T00:01:23.355953+00:00 | GET / 200 | 114902 | `b7ba5631b1818746edc7023c16e30dde41c9289534c80ecd89610f3222161b1e` |
| `mofcom-week-224011.json` | https://cif.mofcom.gov.cn/cif/getWeekLineChart2019.fhtml | 2026-10-09T00:02:20.320090+00:00 | POST / 200 | 3996 | `377c834a051965b0828cf11b2104453f14d9c63121bfb573be87b68bb34bf555` |
| `mofcom-week-224012.json` | https://cif.mofcom.gov.cn/cif/getWeekLineChart2019.fhtml | 2026-10-09T00:02:20.480230+00:00 | POST / 200 | 3959 | `a499dd3fcff68f9f96d047482a48df9987f18831a01cbbc09ea82ad3762d1c7b` |
| `mofcom-week-224014.json` | https://cif.mofcom.gov.cn/cif/getWeekLineChart2019.fhtml | 2026-10-09T00:02:20.661185+00:00 | POST / 200 | 3929 | `6a942f5ade96e4b59b2349bf0a0d0647b92d44b066a66d244b5088afaf83061a` |

- 只静态读取数据页引用的同主机 `zhouduData.js` 与 `dataCenterCtrl.js`，未执行网站脚本。前者列出 224011 铜(1#)、224012 铝(A00)、224014 锌(1#)；后者的生产资料周度请求是 POST `/cif/getWeekLineChart2019.fhtml`，表单体 `indexId=<编号>&startDate=&endDate=&flg=2`。本次三个请求均逐字采用这组参数；`curl --data` 的 Content-Type 为 `application/x-www-form-urlencoded`，无需 Referer。空的日期范围由官网返回过去六个月；运行抓取照录制请求，不猜额外参数。
- 回应为普通 JSON，无回调包装。读取 `datas[].DATADATE / DATA / NAME / UNIT`，分别是完整日历日期、价格原文、品名、单位；顶层 `unit` 同为“元/吨”，`title` 为“全国铜（1#）价格走势”等。`table` 中的变化字段不读取；顶层 `startDate/endDate` 为整次查询范围，不是某一点的周区间。
- 三个 `datas` 都是 25 点，日期集合完全一致，2026-04-10 至 2026-09-25 相邻均 7 天。最新两期为 9 月 18 日、25 日，铜原数 108664 / 111975，铝 24204 / 24340，锌 26085 / 26689。三个 `sourceName` 直接取回应 NAME；没有纯度说明，不搬其他来源的规格。
- 数据页称该栏目为“生产资料 / 周度监测数据”，这一栏目实际署名“数据来源：商务部内贸统计监测平台”。回应只给日期与价格，没有定义每点是哪几天或统计取值方式；保留单日期一期，起止同日。转载说明文章标题的“9月21日-27日”针对文中煤、油、钢材六项，没有铜铝锌，不据此推算三个指数的周区间（集成人确认）。`--force-period` 使用该点的完整日期，如 `2026-09-25`。
- [文章页转载说明](https://cif.mofcom.gov.cn/cif/html//sczldt_pc/2026/9/1790747534085.html)原文：“凡本站及其子站注明"信息来源:商务部市场运行和消费促进司”的所有作品，其版权属于商务预报所有。其他媒体、网站或个人转载使用时不要断章取义，并请同时注明:"信息来源:商务预报”。” 数据页没有另写条款或排除数据；登记依任务卡使用此说明并注明出处，不宣称本站可再授权。
- `mofcom/week-224011.json`、`week-224012.json`、`week-224014.json` 均小于 64 KiB，逐字节复制完整原回应，未裁剪、重排或改写，哈希与上表同编号原件相同。数据页、脚本、文章与 headers 不进 Git，只保留上述地址和哈希。原件在服务器保留。
