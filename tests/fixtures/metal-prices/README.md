# 金属价格夹具（TASK-0044、0046、0049、0068）

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
