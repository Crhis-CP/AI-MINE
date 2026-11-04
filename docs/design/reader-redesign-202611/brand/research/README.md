# 第 1 阶段：研究资料

| 文件 | 内容 |
|---|---|
| [facts.md](facts.md) | 事实链：USGS、IEA 原文摘录，“矿”“策”的字义，以及《天工开物》、《矿冶全书》、铜绿山的考证 |
| [metaphors.md](metaphors.md) | 9 个候选隐喻，以及排除的方向 |
| [whitespace-colour.svg](whitespace-colour.svg)、[whitespace-colour.md](whitespace-colour.md) | 颜色白地图：同行已用的颜色（色值读自 CSS 或 SVG），按 OKLCH 色相和明度排布 |
| [whitespace-form.svg](whitespace-form.svg) | 形状白地图：字标还是图形，几何还是有机曲线 |
| [interview-guide.md](interview-guide.md) | 读者访谈提纲，由 Owner 进行 |
| [data-request.md](data-request.md) | 请 Codex 导出网站统计数据的说明，由 Owner 转交 |

## 原始素材索引

研究时在本地查看过下列图片。仓库只记录链接和许可，**不存放图片本身**，以免带入署名或相同方式共享的义务。

| 素材 | 来源 | 许可 |
|---|---|---|
| 《矿冶全书》木刻：竖井绞车（卷六）、竖井·平巷·坑道剖面（卷五）、交叉矿脉（卷三） | [Gutenberg #38015 插图](https://www.gutenberg.org/cache/epub/38015/pg38015-images.html)：fig161、fig105、fig64b | 公有领域 |
| 《天工开物》木刻：五金卷炼铁炉、冶铸卷铸鼎 | [Commons 分类](https://commons.wikimedia.org/wiki/Category:Images_from_Tiangong_Kaiwu) | 公有领域 |
| 钻探岩芯箱（加拿大安大略省 Potter 矿） | [Commons](https://commons.wikimedia.org/wiki/File:Exploration_drill_cores_(Potter_Mine,_east_of_Timmins,_Ontario,_Canada)_(32928527137).jpg)，James St. John | CC BY 2.0 |
| 黄铜矿标本 | [Commons](https://commons.wikimedia.org/wiki/File:Chalcopyrite-199453.jpg)，Rob Lavinsky / iRocks.com | CC BY-SA 3.0 |
| 孔雀石（广东石碌矿） | [Commons](https://commons.wikimedia.org/wiki/File:Malachite-40323.jpg)，Rob Lavinsky / iRocks.com | CC BY-SA 3.0 |
| 锡石 | [Commons](https://commons.wikimedia.org/wiki/File:CassiteriteUSGOV.jpg)，USGS | 公有领域 |
| 硅晶圆 | [Commons](https://commons.wikimedia.org/wiki/File:Silicon_wafer_researcher.jpg)，美国能源部 | 公有领域；使用时要裁去人物 |
| 地质图符号：矿脉、平硐、竖井、镐与锤 | [FGDC-STD-013-2006 第 19 节](https://ngmdb.usgs.gov/fgdc_gds/geolsymstd/fgdc-geolsym-sec19.pdf) | 美国联邦政府作品 |

孔雀石和锡石的图片下载时，Wikimedia 返回 429（限流），所以只核对了链接和许可，没有在本地看过图。

## 本环境无法访问的站点

- iea.org：改读欧盟 BUILD UP 平台托管的 IEA 原版 PDF。
- zdic.net、ctext.org、香港中文大学汉语多功能字库：无法访问，《说文》转引自 Dong Chinese。
- www.usgs.gov 的媒体页：被 CDN 拦截。pubs.usgs.gov 和 ngmdb.usgs.gov 可以访问。
- 国家文物局、铜绿山博物馆：没有找到官方页面。

相似图形和商标检索（中国商标网、WIPO 全球品牌数据库、TinEye、Google Lens）都需要浏览器上传图片，本环境做不了，在[读者测试包](../tests/README.md)里交给 Owner 完成。
