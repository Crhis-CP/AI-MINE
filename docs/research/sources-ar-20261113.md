# 阿根廷来源普查（2026-11-13）

任务：[TASK-0641](../../tasks/TASK-0641.md)。交接：[Claude 6842866126](https://github.com/Crhis-CP/AI-MINE/issues/348#issuecomment-6842866126)。本清单供 Claude 圈选与后续逐源预览，不启用来源。

共记录 **305 个去重候选入口**：主清单 **248 个**（165 个归一主机），另有 **57 个阻碍/未定位入口**。主清单分组：A 16；B 45；C 21；D 42；E 31；F 64；G 29。

主清单中，`industry/sources.json` 同栏目已有 **23** 个，法规目录同用途已有 **6** 个，#485 在途 **5** 个（四个转正式、门多萨停用）；三类分开统计，不当生产启用数。统计单位是列表/数据/规范入口，不是独立发布者家数；同发布者不同栏目或语言分别保留并注明，后续登记须继续去重。

## 核验口径与覆盖

先用公开网络检索发现候选，再以项目 `AIMiningPolicyBot` 只读 robots 与列表。每个实际 URL 只 GET 一次，robots 缓存复用，完成请求后间隔至少 2 秒；更长 Crawl-delay 与单主机一次 robots 为执行口径，实际偏差见末尾检查记录。RSS 只记录列表的声明/链接，不另取 feed；“未见声明”不等于不存在。未登录、未绕验证、未执行来源脚本、未抓文章全文/整期 PDF、未调用模型或付费服务。
主清单表示列表/目录实际打开且 robots 准入明确；静态无条目、检索表单、目录页和动态加载逐行注明，尚需 Claude 圈选后逐源预览。纯空白、非列表、登录入口、robots 未知/禁止、验证页和连接失败放附录，不记可抓。404 robots按既有 RFC 9309 口径无规则；门多萨仅复用 #480 明确裁定的非规则响应，不推广到别的主机。
日期只用内容卡片、时间字段、期次或 URL 的明示值；月份、相对时间、缺年保持原粒度，注明日期依据；顶栏当天、页脚年份、未来活动日期和搜索引擎时间不替代内容日期。RIGI 静态零值为加载占位，不据此填写真实项目数。
去重快照：main `7c49b7bf94e68b031182e00e7a82d461f8d50812` 的资讯、法规与目标三目录；另叠 [#485](https://github.com/Crhis-CP/AI-MINE/pull/485) `28e5fada7276eff36003910426a4d0993aa4c40e` 五源。归一 www、HTTPS/HTTP、尾斜线及声明的 feed 形式，再按栏目比较；同域异栏不按整站排除，原表目标也不冒充已配置来源。
复用 [TASK-0635 七源实测](https://github.com/Crhis-CP/AI-MINE/pull/480#issuecomment-6840741449) 的当天 robots/列表证据，没有重抓；圣胡安矿业部 iframe 禁止和卡塔马卡门户验证仍保留，圣胡安 SI 新闻站及卡塔马卡其他官方子域独立核验。两圣克鲁斯入口同一政府发布体系；同域新闻库和不同语言转载不能作为独立来源背书。
省代码：AR-J 圣胡安；AR-A 萨尔塔；AR-Y 胡胡伊；AR-K 卡塔马卡；AR-M 门多萨；AR-Z 圣克鲁斯；AR-U 丘布特；AR-Q 内乌肯；AR-R 里奥内格罗；AR-F 拉里奥哈；AR-X 科尔多瓦。联邦/全国写 AR；拉美区域媒体也写 AR，并在备注标明区域范围，不当阿根廷本土媒体。
覆盖了交接 A–G 全部组别、十一省的政府/矿业环境/公报及省报，并保留紫金、赣锋、青山、天齐、央行、INDEC、CNV、海关和 RIGI 例子。天齐仅留合作线索，未确认当前阿根廷自有矿；青山的阿根廷合作与退股分开。未声称穷尽互联网；搜索未发现、闭源、登录及本轮受阻部分仍可能有遗漏。

## 主清单

### A 联邦官方（16）

| 编号/名称 | 省 | 列表页 URL | 类型/语言 | RSS | robots 准入 | 最新明示内容日期 | 目录去重 | 备注 |
|---|---|---|---|---|---|---|---|---|
| A001 ANPYN港口与航运局·新闻 | AR | [列表](https://www.argentina.gob.ar/economia/agencia-nacional-de-puertos-y-navegacion/noticias) | 新闻/es | 未见声明 | 允许 | 2026-10-26 | 资讯已有 sa5-ar-anpyn-news | — |
| A002 ARCA·巴拉那水道通关更新 | AR | [列表](https://www.arca.gob.ar/hidrovia-parana/novedades/) | 新闻/es | 未见声明 | 404无规则 | 未明示 | 目录未见 | 通关更新列表，不含明确日历日期 |
| A003 ARCA·机构纪事 | AR | [列表](https://www.arca.gob.ar/transparencia/bitacora/2026.asp) | 新闻/es | 未见声明 | 404无规则 | 2026-11-02 | 目录未见 | 含税收和海关政策，非纯矿业 |
| A004 BCRA·规范通讯检索 | AR | [列表](https://www.bcra.gob.ar/buscador-de-comunicaciones/) | 法规/es | 未见声明 | 允许 | 2026-10（月汇总） | 法规已有 AR-003（新版入口） | 通讯明细动态加载；月汇总可见 |
| A005 BCRA央行·新闻 | AR | [列表](https://www.bcra.gob.ar/noticias/) | 新闻/es | 未见声明 | 允许 | 2026-10-29 | 同域异栏 AR-003 | — |
| A006 CNV证券委员会·新闻 | AR | [列表](https://www.argentina.gob.ar/cnv/noticias) | 新闻/es | 未见声明 | 允许 | 2026-11-11 | 资讯已有 sa5-ar-cnv-news | — |
| A007 InfoLEG/国家规范检索 | AR | [列表](https://www.argentina.gob.ar/normativa) | 法规/es | 未见声明 | 允许 | 未明示 | 法规已有 AR-002 | 检索入口；未提交表单，不把表单年份当最新法规日期 |
| A008 SEGEMAR·新闻 | AR | [列表](https://www.argentina.gob.ar/economia/segemar/noticias) | 新闻/es | 未见声明 | 允许 | 2026-11-10 | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | — |
| A009 SIACAM·全国矿业规范目录 | AR | [列表](https://www.argentina.gob.ar/economia/mineria/siacam/normativa-nacional) | 法规/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | 分类规范目录，含RIGI；未把法规旧日期当栏目更新 |
| A010 国家矿业秘书处·新闻 | AR | [列表](https://www.argentina.gob.ar/economia/mineria/noticias) | 新闻/es | 未见声明 | 允许 | 2026-09-01 | 资讯已有 sa5-ar-mineria | — |
| A011 经济部·新闻 | AR | [列表](https://www.argentina.gob.ar/economia/noticias) | 新闻/es | 未见声明 | 允许 | 2026-11-11 | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | — |
| A012 联邦官方公报·第一部分 | AR | [列表](https://www.boletinoficial.gob.ar/seccion/primera) | 法规/es | 未见声明 | 允许 | 2026-11-13 | 法规已有 AR-001；原表目标 S16-R018 | 当天版次；与公报首页为同一发行目录 |
| A013 联邦政府综合新闻 | AR | [列表](https://www.argentina.gob.ar/noticias) | 新闻/es | 未见声明 | 允许 | 2026-11-12 | 资讯已有 ar-presidencia-noticias | 含综合非矿业新闻，留Claude圈选 |
| A014 联邦环境主管部门·新闻 | AR | [列表](https://www.argentina.gob.ar/jefatura/turismo-ambiente-y-deportes/ambiente/noticias) | 新闻/es | 未见声明 | 允许 | 2026-11-04 | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | 旧 turismo-y-ambiente 路径本轮404，使用当前栏目 |
| A015 能源秘书处·新闻 | AR | [列表](https://www.argentina.gob.ar/economia/energia/noticias) | 新闻/es | 未见声明 | 允许 | 2026-11-04 | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | — |
| A016 财政金融秘书处·新闻 | AR | [列表](https://www.argentina.gob.ar/economia/finanzas/noticias) | 新闻/es | 未见声明 | 允许 | 2026-11-11 | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | 国债发行、融资与投资，非矿业专栏 |

### B 十一省官方（45）

| 编号/名称 | 省 | 列表页 URL | 类型/语言 | RSS | robots 准入 | 最新明示内容日期 | 目录去重 | 备注 |
|---|---|---|---|---|---|---|---|---|
| B001 Catamarca · Digesto 最新法规 | AR-K | [列表](https://digesto.catamarca.gob.ar/) | 法规/es | 未见声明 | 404无规则 | 2026-09-25 | 法规已有 AR-006（新列表入口） | — |
| B002 Catamarca · 矿业部新闻 | AR-K | [列表](https://legislacionminera.catamarca.gob.ar/prensa/noticias/) | 新闻/es | 未见声明 | 404无规则 | 2021-08-16 | 目录未见 | 栏目明显停旧；另有矿业警察控制新闻同页；保留供判断。 |
| B003 Catamarca · 矿业部法规目录 | AR-K | [列表](https://legislacionminera.catamarca.gob.ar/legislacion/) | 法规/es | 未见声明 | 404无规则 | 列表未明示 | 目录未见 | 官方分级法规目录；未下载正文。 |
| B004 Chubut · 环境部门新闻 | AR-U | [列表](https://ambiente.chubut.gov.ar/noticias) | 新闻/es | 未见声明 | 404无规则 | 2026-11-04 | 目录未见 | — |
| B005 Chubut · 矿业部门矿产数据 | AR-U | [列表](https://www.hidrocarburos.chubut.gov.ar/?page_id=3172) | 数据/es | [声明](https://www.hidrocarburos.chubut.gov.ar/?feed=rss2) | 允许 | 列表未明示 | 目录未见 | 官方矿产产量概览；未明示统计期与发布日期，不用页脚2023替代。 |
| B006 Chubut · 碳氢化合物/矿业部数据入口 | AR-U | [列表](https://www.hidrocarburos.chubut.gov.ar/) | 数据/es | [声明1](https://www.hidrocarburos.chubut.gov.ar/?feed=rss2)、[声明2](https://www.hidrocarburos.chubut.gov.ar/?feed=rss2&page_id=1064) | 允许 | 列表未明示 | 目录未见 | 官方资源目录，含矿产资源图、矿业数据和生产者名单；非新闻流，未登录/下载。 |
| B007 Córdoba · IDECOR官方地理信息培训更新 | AR-X | [列表](https://www.idecor.gob.ar/novedades-de-capacitaciones/) | 数据/es | [声明](https://www.idecor.gob.ar/feed/) | 允许 | 列表未明示 | 目录未见 | 官方地理信息机构列表；该入口由/novedades/正常302转入，需另圈选其矿权/地质相关栏目。 |
| B008 Córdoba · IDECOR官方地理信息更新 | AR-X | [列表](https://www.idecor.gob.ar/category/novedades/) | 数据/es | [声明1](https://www.idecor.gob.ar/feed/)、[声明2](https://www.idecor.gob.ar/category/novedades/feed/) | 允许 | 2026-11-11 | 目录未见 | 官方地理数据发布与研究更新，包含地质、矿权地图相关资源；可见日期明确。 |
| B009 Jujuy · 官方公报 Minas 矿业公告分类 | AR-Y | [列表](https://boletinoficial.jujuy.gob.ar/?cat=119) | 公告/es | [声明1](https://boletinoficial.jujuy.gob.ar/?feed=rss2)、[声明2](https://boletinoficial.jujuy.gob.ar/?feed=rss2&cat=119) | 404无规则 | 2026-11-11 | 同域异栏 AR-008 | — |
| B010 Jujuy · 官方公报日历 | AR-Y | [列表](https://boletinoficial.jujuy.gob.ar/?page_id=2017) | 法规/es | [声明](https://boletinoficial.jujuy.gob.ar/?feed=rss2) | 404无规则 | 列表未明示 | 法规已有 AR-008 | 公开日历与期次列表；未下载整期PDF。 |
| B011 Jujuy · 环境与气候变化新闻 | AR-Y | [列表](https://prensa.jujuy.gob.ar/ambiente) | 新闻/es | [声明](https://prensa.jujuy.gob.ar/contenidos/rss.html) | 允许 | 列表未明示 | 目录未见 | 列表有条目；当前HTML未明示各条日期。 |
| B012 Jujuy · 环境部规范/听证首页 | AR-Y | [列表](https://ambientejujuy.gob.ar/) | 公告/es | [声明](https://ambientejujuy.gob.ar/feed/) | 允许 | 列表未明示 | 目录未见 | 可见听证及决议PDF链接，未下载；日期未标；www robots正常301至apex，按canonical独立核robots。 |
| B013 Jujuy · 省政府新闻 | AR-Y | [列表](https://prensa.jujuy.gob.ar/) | 新闻/es | [声明](https://prensa.jujuy.gob.ar/contenidos/rss.html) | 允许 | 列表未明示 | 目录未见 | 列表有条目；当前HTML未明示各条日期。RSS锚指向官方RSS说明页。 |
| B014 Jujuy · 省政府矿业主题 | AR-Y | [列表](https://prensa.jujuy.gob.ar/mineria-a254/1) | 新闻/es | [声明](https://prensa.jujuy.gob.ar/contenidos/rss.html) | 允许 | 列表未明示 | 目录未见 | 列表有条目；当前HTML未明示各条日期。 |
| B015 Jujuy · 矿业部门新闻 | AR-Y | [列表](https://www.mineriajujuy.gob.ar/site/noticias.php) | 新闻/es | 未见声明 | 允许（404无规则，Claude明确裁定） | 2026-11-12 | #485在途 exp-20261113-ar-jujuy-mining-news | — |
| B016 Jujuy · 经济与生产新闻 | AR-Y | [列表](https://prensa.jujuy.gob.ar/economia-y-produccion) | 新闻/es | [声明](https://prensa.jujuy.gob.ar/contenidos/rss.html) | 允许 | 列表未明示 | 目录未见 | 保留财经/综合候选，交Claude圈选。 |
| B017 La Rioja · 官方公报2026年度 | AR-F | [列表](https://www.boletinoflarioja.com.ar/boletines_completos.php?anio=2026) | 法规/es | 未见声明 | 404无规则 | 2026-11-06 | 目录未见 | 页面按日期升序排列；取可见期次日期最大值，未下载整期PDF。 |
| B018 La Rioja · 环境部门新闻 | AR-F | [列表](https://ambiente.larioja.gob.ar/index.php?pagina=noticias) | 新闻/es | 未见声明 | 404无规则 | 2026-10-26 | 目录未见 | — |
| B019 Mendoza · 环境旧栏目 | AR-M | [列表](https://www.mendoza.gov.ar/prensa/energia-y-ambiente/ambiente/) | 新闻/es | 未见声明 | 允许（200非规则正文；Claude #480 comment6841197957裁定） | 2025-09-03 | 目录未见 | 沿用0635 robots200非规则正文的Claude明确准入裁定；与能源环境栏目有相同条目。 |
| B020 Mendoza · 省政府矿业旧栏目 | AR-M | [列表](https://www.mendoza.gov.ar/prensa/energia-y-ambiente/energia-y-mineria/mineria/) | 新闻/es | 未见声明 | 允许（200非规则，Claude明确裁定） | 2025-09-01 | #485在途 exp-20261113-ar-mendoza-mining-news | robots非规则正文按Claude0635裁定无规则；日期原文1 DE SEPTIEMBRE, 2025；栏目过旧。 |
| B021 Mendoza · 能源与环境旧栏目 | AR-M | [列表](https://www.mendoza.gov.ar/prensa/energia-y-ambiente/) | 新闻/es | 未见声明 | 允许（200非规则正文；Claude #480 comment6841197957裁定） | 2025-09-03 | 目录未见 | 沿用0635 robots200非规则正文的Claude明确准入裁定；栏目明显停旧。 |
| B022 Neuquén · 官方新闻通讯社 | AR-Q | [列表](https://www.neuqueninforma.gob.ar/) | 新闻/es | [声明](https://www.neuqueninforma.gob.ar/rss) | 允许 | 2026-11-12（首条URL） | 目录未见 | — |
| B023 Neuquén · 环境与自然资源部新闻 | AR-Q | [列表](https://ambiente.neuquen.gov.ar/noticias/) | 新闻/es | [声明](https://ambiente.neuquen.gov.ar/feed/) | 允许 | 2026-11-05 | 目录未见 | 首条为固定置顶的2026-05-26听证；其后最新正常条目2026-11-05。 |
| B024 Neuquén · 矿业部门出版资料 | AR-Q | [列表](https://ambiente.neuquen.gov.ar/mineria/publicaciones/) | 数据/es | [声明](https://ambiente.neuquen.gov.ar/feed/) | 允许 | 列表未明示 | 目录未见 | 地质/矿业报告目录；含Estadística Provincial Minera 2025；未下载报告，未把年份补成日期。 |
| B025 Neuquén · 矿业部门表格与通告 | AR-Q | [列表](https://ambiente.neuquen.gov.ar/mineria/formularios-y-comunicados/) | 公告/es | [声明](https://ambiente.neuquen.gov.ar/feed/) | 允许 | 列表未明示 | 目录未见 | 公开表格与面向矿权人的通告目录；未下载正文。 |
| B026 Río Negro · 官方公报 | AR-R | [列表](https://boletinoficial.rionegro.gov.ar/?catID=31) | 法规/es | 未见声明 | 允许 | 2026-11-12 | 目录未见 | — |
| B027 Río Negro · 环境与气候变化新闻 | AR-R | [列表](https://ambiente.rionegro.gov.ar/) | 新闻/es | 未见声明 | 允许 | 2026-11-12 | 目录未见 | 与能源/省政府共用新闻库，后续登记须内容去重。 |
| B028 Río Negro · 省政府新闻 | AR-R | [列表](https://rionegro.gov.ar/) | 新闻/es | 未见声明 | 允许 | 2026-11-12 | 目录未见 | — |
| B029 Río Negro · 矿业门户 | AR-R | [列表](https://energia.rionegro.gov.ar/mineriarionegrina) | 数据/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | 官方数据/资源索引：矿业项目、矿权地图、通行单、矿业规范；不是新闻流。 |
| B030 Río Negro · 能源与环境新闻 | AR-R | [列表](https://energia.rionegro.gov.ar/) | 新闻/es | 未见声明 | 允许 | 2026-11-12 | 目录未见 | — |
| B031 Río Negro · 能源与矿业规范 | AR-R | [列表](https://energia.rionegro.gov.ar/normativa) | 法规/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | 法律/法令/决议目录；含2026年6月的更新说明，但未明示最新单条发布日期。 |
| B032 Salta · 官方公报期次检索 | AR-A | [列表](https://boletinoficialsalta.gob.ar/edicionesanteriores.php) | 法规/es | 未见声明 | 404无规则 | 列表未明示 | 同域异栏 AR-007 | 公开按日期/期次/年度检索入口；当前HTML未直接列最新期次。 |
| B033 Salta · 生产与矿业部新闻 | AR-A | [列表](https://produccionsalta.gob.ar/noticias-ministerio-de-la-produccion/) | 新闻/es | [声明](https://produccionsalta.gob.ar/feed/) | 允许 | 2026-11-12 | 目录未见 | 含生产、农业、工业、矿业，未自行筛掉非矿业栏目。 |
| B034 Salta · 省政府全部新闻 | AR-A | [列表](https://www.salta.gob.ar/prensa/noticias) | 新闻/es | 未见声明 | 允许 | 2026-11-12 | 目录未见 | — |
| B035 Salta · 省政府环境主题 | AR-A | [列表](https://www.salta.gob.ar/prensa/noticias/tema-ambiente-13/pagina-1) | 新闻/es | 未见声明 | 允许 | 2026-11-11 | 目录未见 | — |
| B036 Salta · 省政府矿业主题 | AR-A | [列表](https://www.salta.gob.ar/prensa/noticias/tema-mineria-32/pagina-1) | 新闻/es | 未见声明 | 允许 | 2026-11-04 | #485在途 exp-20261113-ar-salta-news | — |
| B037 San Juan · SI San Juan 全部新闻 | AR-J | [列表](https://sisanjuan.gob.ar/) | 新闻/es | 未见声明 | 允许 | 2026-11-12（条目URL） | 目录未见 | 官方门户；矿业与环境栏目另列。；日期依据：列表首屏条目URL路径含2026-11-12 |
| B038 San Juan · SI San Juan 环境与可持续发展 | AR-J | [列表](https://sisanjuan.gob.ar/23-secciones/ambiente) | 新闻/es | [声明1](https://sisanjuan.gob.ar/23-secciones/ambiente?format=feed)、[声明2](https://sisanjuan.gob.ar/23-secciones/ambiente?format=feed&type=rss)、[声明3](https://sisanjuan.gob.ar/23-secciones/ambiente?format=feed&type=atom) | 允许 | 2026-11-12（首条URL） | 目录未见 | — |
| B039 San Juan · SI San Juan 矿业 | AR-J | [列表](https://sisanjuan.gob.ar/23-secciones/mineria) | 新闻/es | [声明1](https://sisanjuan.gob.ar/23-secciones/mineria?format=feed)、[声明2](https://sisanjuan.gob.ar/23-secciones/mineria?format=feed&type=rss)、[声明3](https://sisanjuan.gob.ar/23-secciones/mineria?format=feed&type=atom) | 允许 | 2026-11-11（首条URL） | 目录未见 | — |
| B040 San Juan · 官方公报 | AR-J | [列表](https://boletinoficial.sanjuan.gob.ar/) | 法规/es | 未见声明 | 允许 | 列表未明示 | 法规已有 AR-009（新版入口） | HTTP200；官方JS应用壳；本轮未执行脚本，原始HTML没有期次日期或文章链接。 |
| B041 Santa Cruz · 健康与环境新闻 | AR-Z | [列表](https://noticias.santacruz.gob.ar/organismos/salud) | 新闻/es | [声明1](https://noticias.santacruz.gob.ar/organismos/salud?format=feed&type=rss)、[声明2](https://noticias.santacruz.gob.ar/organismos/salud?format=feed&type=atom) | 允许 | 2026-11-12 | 目录未见 | — |
| B042 Santa Cruz · 官方公报目录 | AR-Z | [列表](https://boletinoficial.santacruz.gob.ar/boletin/) | 法规/es | 未见声明 | 允许 | 列表未明示 | 同域异栏 AR-010 | 公开年度目录；2026子目录返回200空白；主入口有年度导航，本轮未得到最新期次日期、未下载PDF。 |
| B043 Santa Cruz · 政府矿业新闻 | AR-Z | [列表](https://noticias.santacruz.gob.ar/organismos/energia/mineria) | 新闻/es | [声明](https://noticias.santacruz.gob.ar/organismos/energia/mineria?format=feed&type=rss（0635实现线已识别）) | 允许 | 2026-10-30 | #485在途 exp-20261113-ar-santacruz-government-mining | 与能源矿业部同属省政府，不能视为两个独立发布者。 |
| B044 Santa Cruz · 省政府全部新闻 | AR-Z | [列表](https://noticias.santacruz.gob.ar/) | 新闻/es | [声明1](https://noticias.santacruz.gob.ar/?format=feed&type=rss)、[声明2](https://noticias.santacruz.gob.ar/?format=feed&type=atom) | 允许 | 2026-11-12 | 目录未见 | — |
| B045 Santa Cruz · 能源与矿业部 | AR-Z | [列表](https://enermin.gob.ar/) | 新闻/es | [声明](https://enermin.gob.ar/feed/（列表head声明）) | 允许 | 2026-11-12 | #485在途 exp-20261113-ar-santacruz-energy-news | 与政府矿业栏目同一政府发布体系；首页还含能源、水资源。 |

### C 行业协会、大学、研究与智库（21）

| 编号/名称 | 省 | 列表页 URL | 类型/语言 | RSS | robots 准入 | 最新明示内容日期 | 目录去重 | 备注 |
|---|---|---|---|---|---|---|---|---|
| C001 Asociación Geológica Argentina·Novedades | AR | [列表](https://geologica.org.ar/) | 新闻/es | [声明1](https://geologica.org.ar/feed/)、[声明2](https://geologica.org.ar/comments/feed/) | 允许 | 列表未明示 | 目录未见 | 地质协会主页含Novedades；[项目/关系依据](https://geologica.org.ar/segundas-jornadas-argentinas-de-geoturismo/) |
| C002 CAEM·行业报告 | AR | [列表](https://caem.com.ar/sustentabilidad/informes/) | 数据/es | 未见声明 | 允许 | 列表未明示 | 同域异栏 exp-20261014-caem | 跳转至可读行业报告页 |
| C003 CAEM·通信新闻 | AR | [列表](https://caem.com.ar/comunicacion/) | 新闻/es | 未见声明 | 允许 | 2026-10-29 | 同域异栏 exp-20261014-caem | 矿业商会综合新闻；[项目/关系依据](https://caem.com.ar/transparencia-eiti-argentina-amplia-su-reporte-para-reflejar-la-contribucion-de-los-proyectos-mineros-antes-de-producir/) |
| C004 CAPEMISA·矿业供应商新闻 | AR-A | [列表](https://capemisa.com.ar/noticias/) | 新闻/es | [声明1](https://capemisa.com.ar/feed/)、[声明2](https://capemisa.com.ar/comments/feed/) | 允许 | 2026-10-19 | 目录未见 | Salta供应商协会；[项目/关系依据](https://capemisa.com.ar/capemisa-fortalecio-su-presencia-y-el-protagonismo-de-los-proveedores-saltenos-en-argentina-mining-norte-2026/) |
| C005 CAPMIN·机构公告 | AR | [列表](https://www.capmin.com.ar/) | 公告/es | [声明1](https://www.capmin.com.ar/feed/)、[声明2](https://www.capmin.com.ar/comments/feed/) | 允许 | 2026-10-21 | 目录未见 | 主页按机构公告列出，非供应商栏目；[项目/关系依据](https://www.capmin.com.ar/comunicado-50-competitividad-integracion-y-desarrollo-2-2/) |
| C006 CAPPROSEMBEL·Belén供应商协会 | AR-K | [列表](https://capprosembel.com/noticias) | 新闻/es | 未见声明 | 404无规则 | 发布日期未明示 | 目录未见 | 新闻/活动目录；首项活动时间2026-11-06，不当发布日期 |
| C007 CARI·全部出版物 | AR | [列表](https://cari.org.ar/views/releases/index.php) | 数据/es | 未见声明 | 404无规则 | 2026-11-03 | 目录未见 | 列表页顶部有未来活动日期，最新出版物日期需按卡片独立提取；[项目/关系依据](https://cari.org.ar/views/releases/?theme_id=21) |
| C008 CASEMI Jujuy·供应商协会 | AR-Y | [列表](https://casemijujuy.com.ar/noticias/) | 新闻/es | [声明1](https://casemijujuy.com.ar/feed/)、[声明2](https://casemijujuy.com.ar/comments/feed/) | 允许 | 列表未明示 | 目录未见 | 矿业服务协会新闻目录；部分旧文有日期，首项未明示 |
| C009 CENIT/UNSAM·研究动态 | AR | [列表](https://cenit.unsam.edu.ar/novedades/) | 新闻/es | [声明1](https://cenit.unsam.edu.ar/feed/)、[声明2](https://cenit.unsam.edu.ar/comments/feed/)、[声明3](https://cenit.unsam.edu.ar/novedades/feed/) | 允许 | 2026-11-02 | 目录未见 | 研究中心动态，首项11月2日明示；不只矿业；登记前需既有预览确认条目，当前未做采集预览；[项目/关系依据](https://cenit.unsam.edu.ar/nueva-publicacion-reprocannes-regulaciones-provinciales-de-cannabis-en-argentina/) |
| C010 CIPPEC·出版物 | AR | [列表](https://www.cippec.org/publicaciones/) | 数据/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | 公共政策研究，跨行业；[项目/关系依据](https://www.helpargentina.org/es/ong/dt/id/14/cippec---centro-de-implementacion-de-politicas-publicas-para-la-equidad-y-el-crecimiento) |
| C011 CMSJ·圣胡安矿业商会新闻 | AR-J | [列表](https://camaraminerasj.com.ar/) | 新闻/es | [声明](https://camaraminerasj.com.ar/comments/feed/) | 允许 | 2026-11-06 | 目录未见 | 首项time字段明示2026-11-06；标题2027-02-01是未来开工日期；[项目/关系依据](https://vicuna.com/) |
| C012 CONICET Salta-Jujuy·新闻 | AR-A/AR-Y | [列表](https://salta-jujuy.conicet.gov.ar/categoria/noticias/) | 新闻/es | [声明1](https://salta-jujuy.conicet.gov.ar/feed/)、[声明2](https://salta-jujuy.conicet.gov.ar/comments/feed/)、[声明3](https://salta-jujuy.conicet.gov.ar/categoria/noticias/feed/) | 允许 | 2026-11-06 | 目录未见 | NOA科研机构；含铜矿成矿与锂研究；[项目/关系依据](https://salta-jujuy.conicet.gov.ar/maimara-fue-sede-del-ix-congreso-nacional-de-ecologia-y-biologia-de-suelos-un-encuentro-que-fortalecio-el-dialogo-entre-ciencia-y-territorio/) |
| C013 CONICET·机构新闻 | AR | [列表](https://www.conicet.gov.ar/noticias-conicet/) | 新闻/es | [声明1](https://www.conicet.gov.ar/feed/)、[声明2](https://www.conicet.gov.ar/comments/feed/) | 允许 | 2026-11-12 | 目录未见 | 综合科研，含矿业材料研究；[项目/关系依据](https://www.conicet.gov.ar/quince-investigadores-del-conicet-fueron-distinguidos-con-los-premios-konex-de-platino-2026/) |
| C014 CaMEM·门多萨矿业商会新闻 | AR-M | [列表](https://www.camemargentina.com.ar/noticias) | 新闻/es | 未见声明 | 404无规则 | 列表未明示 | 目录未见 | 省企业商会新闻目录；[项目/关系依据](https://www.camemargentina.com.ar/camem) |
| C015 FARN·研究文献 | AR | [列表](https://farn.org.ar/documentos/) | 数据/es | [声明1](https://farn.org.ar/feed/)、[声明2](https://farn.org.ar/comments/feed/)、[声明3](https://farn.org.ar/documentos/feed/) | 允许 | 列表未明示 | 目录未见 | 环境与自然资源基金会；研究目录含矿业/气候/环境治理；[项目/关系依据](https://www.facebook.com/farnargentina) |
| C016 Fundar·锂研究系列 | AR | [列表](https://fund.ar/litio/) | 数据/es | [声明1](https://fund.ar/feed/)、[声明2](https://fund.ar/comments/feed/) | 允许 | 列表未明示 | 目录未见 | 锂产业政策研究目录；固定专题，非每日新闻；[项目/关系依据](https://fund.ar/sobre-la-argentina/) |
| C017 UNSAM·大学新闻 | AR | [列表](https://noticias.unsam.edu.ar/) | 新闻/es | [声明1](https://noticias.unsam.edu.ar/feed/)、[声明2](https://noticias.unsam.edu.ar/comments/feed/) | 允许 | 列表未明示 | 目录未见 | 综合大学新闻，有锂产业链研究；日期须逐卡核，不取活动日期；[项目/关系依据](https://noticias.unsam.edu.ar/2026/11/10/se-publico-el-nuevo-libro-de-nerina-visacovsky-los-sentidos-de-educar-en-la-argentina/) |
| C018 UNSJ Exactas·矿业标签 | AR-J | [列表](https://exactas.unsj.edu.ar/tag/mineria/) | 新闻/es | 未见声明 | 允许 | 2026-06-16 | 目录未见 | 官方大学矿业专栏 |
| C019 UNSa·大学新闻 | AR-A | [列表](https://www.unsa.edu.ar/) | 新闻/es | [声明1](https://www.unsa.edu.ar/feed/)、[声明2](https://www.unsa.edu.ar/comments/feed/) | 允许 | 2026-11-12 | 目录未见 | 大学主页含新闻列表 |
| C020 WIM Argentina·新闻 | AR | [列表](https://www.wim.ar/blog) | 新闻/es | 未见声明 | 允许 | 2026-10-15 | 目录未见 | 正式新闻目录，未用首页重复计数；[项目/关系依据](https://www.wim.ar/blog#main-content) |
| C021 WIM Argentina·研究文档 | AR | [列表](https://www.wim.ar/publications) | 数据/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | 研究报告目录；部分文档“Solicitar”需向机构申请，本轮未申请、未下载；[项目/关系依据](https://www.wim.ar/publications#main-content) |

### D 企业、项目与交易所公告（42）

| 编号/名称 | 省 | 列表页 URL | 类型/语言 | RSS | robots 准入 | 最新明示内容日期 | 目录去重 | 备注 |
|---|---|---|---|---|---|---|---|---|
| D001 CNV·上市主体重大事项 | AR | [列表](https://www.cnv.gov.ar/SitioWeb/HechosRelevantes) | 公告/es | 未见声明 | 404无规则 | 2026-11-12 | 目录未见 | 由国家CNV页面链接到此公开列表；覆盖全发行人，后续需限定企业，不提交查询 |
| D002 ASX·Argosy公司公告检索 | AR-A | [列表](https://www.asx.com.au/asx/v2/statistics/announcements.do?asxCode=AGY&by=asxCode&period=M6&timeframe=D) | 公告/en | 未见声明 | 允许 | 2026-10-30 | 目录未见 | 真实公开交易所列表；13/11/2026是检索范围上界，未当公告日期；[项目/关系依据](https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03157364) |
| D003 AbraSilver·新闻稿 | AR-A/AR-K | [列表](https://www.abrasilver.com/news-releases/) | 公告/en | 未见声明 | 允许 | 2026-11-09 | 资讯已有 exp-20261014-abrasilver | Diablillos银金项目；[项目/关系依据](https://www.abrasilver.com/projects/diablillos/) |
| D004 Aldebaran·2026新闻稿 | AR-J | [列表](https://aldebaranresources.com/2026/) | 公告/en | 未见声明 | 允许 | 2026-10-05 | 资讯已有 research-20261015-aldebaranresources-com | Altar铜金项目；旧/news跳到2024档案，采用导航2026入口；[项目/关系依据](https://aldebaranresources.com/projects/altar-copper-gold/) |
| D005 AngloGold Ashanti·公司公告 | AR-Z | [列表](https://www.anglogoldashanti.com/investors/media/) | 公告/en | 未见声明 | 允许 | 2026-09-25 | 目录未见 | Cerro Vanguardia，官方集团最新公告目录；[项目/关系依据](https://www.anglogoldashanti.com/portfolio/americas/) |
| D006 Argentina Lithium & Energy·新闻 | AR-A | [列表](https://argentinalithium.com/news/) | 公告/en | [声明](https://argentinalithium.com/rss) | 404无规则 | 2026-06-22 | 目录未见 | 阿根廷锂项目组合；[项目/关系依据](https://argentinalithium.com/) |
| D007 Argosy Minerals·ASX公告 | AR-A | [列表](https://www.argosyminerals.com.au/announcements/) | 公告/en | [声明](https://www.argosyminerals.com.au/feed/) | 允许 | 2026-10-30 | 目录未见 | Rincón项目；[项目/关系依据](https://www.argosyminerals.com.au/rincon-lithium-project-argentina/) |
| D008 Austral Gold·新闻 | AR-J | [列表](https://australgold.com) | 公告/en | 未见声明 | 允许 | 列表仅月日27 Oct（未给年） | 目录未见 | 重定向主页，主页有Q3 2026公告标题，日期只显示月日；Casposo；[项目/关系依据](https://australgold.com/projects/operations/argentina-casposo-manantiales-mine-complex/) |
| D009 BYMA·公告及重要事项 | AR | [列表](https://www.byma.com.ar/relacion-con-inversores/noticias-y-hechos-relevantes) | 公告/es | 未见声明 | 允许 | 2026-10-30 | 目录未见 | 此栏目是BYMA自身IR公告，不是全部上市公司公告库；[项目/关系依据](https://www.byma.com.ar/newsroom/galicia-asset-management-y-byma-inicio-cotizacion-primer-etf-local-de-argentina) |
| D010 Barrick·新闻 | AR-J | [列表](https://www.barrick.com/English/news/default.aspx) | 公告/en | 未见声明 | 允许 | 静态列表未明示 | 目录未见 | 网页可打开但新闻条目动态加载；Veladero项目；登记前需既有预览确认条目，当前未做采集预览；[项目/关系依据](https://www.barrick.com/operations/veladero/default.aspx) |
| D011 Cerrado Gold·2026新闻 | AR-Z | [列表](https://www.cerradogold.com/news-media/news-2026) | 公告/en | [声明1](https://www.cerradogold.com/news-media/news-2026?format=feed&type=rss)、[声明2](https://www.cerradogold.com/news-media/news-2026?format=feed&type=atom) | 允许 | 2026-10-30 | 目录未见 | Minera Don Nicolás；[项目/关系依据](https://www.cerradogold.com/news-media/news-2026/cerrado-gold-reports-strong-q2-2026-production-results-at-it2026-07-13-030502) |
| D012 Challenger Gold·ASX公告 | AR-J | [列表](https://challengergold.com/investor-centre/asx-announcements/) | 公告/en | [声明1](https://challengergold.com/feed/)、[声明2](https://challengergold.com/comments/feed/) | 允许 | 静态列表未明示 | 目录未见 | 可打开，静态无公告条目；Hualilán/Golden Mining；登记前需既有预览确认条目，当前未做采集预览；[项目/关系依据](https://challengergold.com/investor-centre/asx-announcements/) |
| D013 El Pachón·项目新闻稿 | AR-J | [列表](https://www.elpachon.com.ar/publicaciones/comunicados-de-prensa) | 公告/es | 未见声明 | 允许 | 静态列表未明示 | 目录未见 | Glencore项目站，可打开但列表动态加载；静态条目未返回，需后续采集预览；登记前需既有预览确认条目，当前未做采集预览 |
| D014 Eramet·新闻稿 | AR-A | [列表](https://www.eramet.com/en/media/press-releases/) | 公告/en | [声明1](https://www.eramet.com/en/feed/)、[声明2](https://www.eramet.com/en/comments/feed/) | 允许 | 2026-11-09 | 资讯已有 exp-20261014-eramet | Centenario-Ratones母公司；列表明示10月1日阿根廷RIGI扩建新闻；[项目/关系依据](https://eramine.eramet.com/) |
| D015 Eramine·阿根廷新闻 | AR-A | [列表](https://eramine.eramet.com/es/media/noticias/) | 新闻/es | [声明1](https://eramine.eramet.com/es/feed/)、[声明2](https://eramine.eramet.com/es/comments/feed/) | 允许 | 2026-11-06 | 目录未见 | 阿根廷Centenario-Ratones运营公司；[项目/关系依据](https://eramine.eramet.com/es/media-es/participamos-en-el-argentina-day-de-pdac-2026-y-compartimos-la-experiencia-de-eramine-en-salta/) |
| D016 First Quantum·最新新闻 | AR-A | [列表](https://www.first-quantum.com/latest-news/) | 公告/en | 未见声明 | 允许 | 2026-10-28 | 资讯已有 exp-20261014-first-quantum | Taca Taca项目；[项目/关系依据](https://www.first-quantum.com/operations/taca-taca/) |
| D017 Glencore·集团新闻 | AR-K/AR-J | [列表](https://www.glencore.com/media-and-insights/news/) | 公告/en | 未见声明 | 允许 | 静态列表未明示 | 资讯已有 glencore-news | 可打开但无静态新闻条目；MARA/Alumbrera/El Pachón；静态条目未返回，需后续采集预览；登记前需既有预览确认条目，当前未做采集预览；[项目/关系依据](https://www.glencore.com/media-and-insights/news/glencore-receives-rigi-approval-for-agua-rica--mara) |
| D018 Golden Minerals·2026新闻 | AR-A | [列表](https://www.goldenminerals.com/news/2026) | 公告/en | 未见声明 | 允许 | 2026-11-10 | 目录未见 | 正式2026新闻目录；列表明示Desierto Argentina钻探，旧/investors/news入口404不计独立来源；[项目/关系依据](https://www.goldenminerals.com/news/2026/249) |
| D019 HKEXnews·上市公司标题检索 | AR | [列表](https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=en) | 公告/en/zh | 未见声明 | 404无规则 | 交互检索页未明示 | 目录未见 | 真实可打开，动态检索需后续限定紫金/赣锋/天齐等发行人；本次未提交查询；登记前需既有预览确认条目，当前未做采集预览 |
| D020 Hanaq·官方动态 | AR-A/AR-Y | [列表](https://hanaqgroup.com/es/home-espanol/) | 新闻/es | [声明1](https://hanaqgroup.com/es/feed/)、[声明2](https://hanaqgroup.com/es/comments/feed/) | 允许 | 2026-07-14 | 目录未见 | 公司自述持有阿根廷多类矿业资产；主页有最新新闻 |
| D021 Hochschild·报告及新闻稿 | AR-Z | [列表](https://www.hochschildmining.com/investors/results-reports-presentations/) | 公告/en | 未见声明 | 允许 | 2026-10-21 | 目录未见 | San José/Minera Santa Cruz；[项目/关系依据](https://www.hochschildmining.com/where-we-operate/current-operations/san-jose/) |
| D022 Integra Capital·新闻 | AR-Y/AR-K | [列表](https://integracapital.com/news/) | 新闻/en | [声明1](https://integracapital.com/feed/)、[声明2](https://integracapital.com/comments/feed/) | 允许 | 列表未明示 | 目录未见 | 矿业能源投资组合，含Catamarca锂及Aguilar；站上含转载新闻，日期须逐项提取；[项目/关系依据](https://integracapital.com/competitiveness-energy-and-critical-minerals-a-strategic-perspective-on-argentinas-development/) |
| D023 Lithium Chile·新闻 | AR-A | [列表](https://lithiumchile.ca/all-news/) | 公告/en | [声明1](https://lithiumchile.ca/feed/)、[声明2](https://lithiumchile.ca/comments/feed/) | 允许 | 2026-08-17 | 目录未见 | Arizaro出售交易相关；保留最新股权/交易状态，不当已完成出售；[项目/关系依据](https://lithiumchile.ca/wp-content/uploads/2026/05/MAY-19-2026-LITHIUM-CHILE-PROVIDES-RESULTS-OF-THE-AGM-AND-SPECIAL-MEETING.pdf) |
| D024 Lundin Mining·新闻 | AR-J | [列表](https://www.lundinmining.com/news/) | 公告/en | 未见声明 | 404无规则 | 2026-11-04 | 资讯已有 exp-20261014-lundin-mining | Vicuña项目；列表含RIGI批准公告；[项目/关系依据](https://www.lundinmining.com/our-portfolio/projects/vicuna-district/) |
| D025 McEwen·新闻稿 | AR-J/AR-Z | [列表](https://www.mcewenmining.com/investor-relations/press-releases/default.aspx) | 公告/en | 未见声明 | 允许 | 2026-11-12 | 目录未见 | Los Azules/San José；部分条目动态加载，本次缓存已可见11月12日新项；登记前需既有预览确认条目，当前未做采集预览；[项目/关系依据](https://www.mcewenmining.com/operations/san-jose-mine/default.aspx) |
| D026 Minera Exar·Novedades新闻 | AR-Y | [列表](https://www.exar.com.ar/novedades/) | 新闻/es | [声明1](https://www.exar.com.ar/feed/)、[声明2](https://www.exar.com.ar/comments/feed/) | 允许 | 列表未明示 | 目录未见 | 正式Novedades目录可读；旧/noticias入口404不计独立来源；[项目/关系依据](https://www.exar.com.ar/wwim-argentina-unju-y-exar-impulsan-en-jujuy-el-programa-de-becas-de-cuidado-para-estudiantes/) |
| D027 NGEx Minerals·新闻 | AR-J/AR-K | [列表](https://ngexminerals.com/news/) | 公告/en | 未见声明 | 允许 | 2026-11-05 | 资讯已有 sup-20261014-ngex | Lunahuasi及Valle Ancho拆分动态；登记前需既有预览确认条目，当前未做采集预览 |
| D028 Newmont·新闻稿 | AR-Z | [列表](https://investors.newmont.com/investors/news-release/default.aspx) | 公告/en | 未见声明 | 允许 | 静态列表未明示 | 目录未见 | 网页可打开但条目动态加载；导航明示Cerro Negro Argentina；登记前需既有预览确认条目，当前未做采集预览；[项目/关系依据](https://operations.newmont.com/latac/cerro-negro-argentina) |
| D029 POSCO Argentina·新闻 | AR-A/AR-K | [列表](https://poscoargentina.com/newsroom.php?slug=noticias) | 新闻/es | 未见声明 | 允许 | 2026-03（来源仅月） | 目录未见 | Sal de Oro项目；保留月份精度；[项目/关系依据](https://poscoargentina.com/index.php) |
| D030 Patagonia Gold·新闻稿 | AR-R/AR-Z/AR-U | [列表](https://patagoniagold.com/investors/news-releases/) | 公告/en | [声明1](https://patagoniagold.com/feed/)、[声明2](https://patagoniagold.com/comments/feed/) | 允许 | 静态列表未明示 | 目录未见 | Calcatreu及Patagonia项目，页面可打开但列表未静态返回近期条目；登记前需既有预览确认条目，当前未做采集预览 |
| D031 Power Minerals·ASX公告 | AR-A | [列表](https://powerminerals.com.au/investors/asx-announcements/) | 公告/en | 未见声明 | 允许 | 静态列表未明示 | 目录未见 | 可打开，静态无公告条目；Salta Lithium项目；登记前需既有预览确认条目，当前未做采集预览；[项目/关系依据](https://powerminerals.com.au/projects/salta-lithium-brine-project/) |
| D032 Rio Tinto·全球新闻稿 | AR-K/AR-Y/AR-A | [列表](https://www.riotinto.com/en/news/releases) | 公告/en | 未见声明 | 允许 | 静态列表未明示 | 同域异栏 exp-20261014-rio-tinto | 旗下阿根廷锂项目含Fénix、Sal de Vida、Olaroz、Rincón；需加载新闻列表；登记前需既有预览确认条目，当前未做采集预览；[项目/关系依据](https://www.riotinto.com/en/news/releases/2026/rio-tinto-celebrates-opening-of-1-4-billion-lithium-projects-in-argentina) |
| D033 SSR Mining·首页新闻 | AR-Y | [列表](https://www.ssrmining.com/) | 公告/en | 未见声明 | 允许 | 2026-11-03 | 目录未见 | 公司主页Latest News已列近期公告；原旧IR路径404，不继续旧入口；Puna/Pirquitas |
| D034 TMX·Lundin发行人新闻 | AR-J | [列表](https://money.tmx.com/en/quote/LUN/news) | 公告/en | 未见声明 | 允许 | 动态列表未明示 | 目录未见 | 页面可打开但静态无新闻条目；静态条目未返回，需后续采集预览 |
| D035 Vicuña·阿根廷项目新闻 | AR-J | [列表](https://vicuna.com/tag/noticias/) | 新闻/es | [声明1](https://vicuna.com/feed/)、[声明2](https://vicuna.com/comments/feed/)、[声明3](https://vicuna.com/tag/noticias/feed/) | 允许 | 2026-10-16 | 目录未见 | Josemaría/Filo del Sol项目新闻；列表首项日期在正文摘要明示；[项目/关系依据](https://vicuna.com/tag/noticias/#content) |
| D036 上交所·紫金矿业公告检索 | AR-K | [列表](https://www.sse.com.cn/assortment/stock/list/info/announcement/index.shtml?productId=601899) | 公告/zh | 未见声明 | 404无规则 | 交互列表未明示 | 目录未见 | 真实可打开，动态公告列表，未取API或下载公告；登记前需既有预览确认条目，当前未做采集预览 |
| D037 紫金矿业·Tres Quebradas项目资料 | AR-K | [列表](https://www.zijinmining.com/global/program-detail-71747.htm) | 数据/en | 未见声明 | 404无规则 | 未明示 | 同域异栏 exp-20261014-zijin | 项目介绍，无连续新闻列表；用于项目关系与静态资料，不能当增量新闻源 |
| D038 紫金矿业·英文新闻 | AR-K | [列表](https://www.zijinmining.com/news/news_list.jsp) | 新闻/en | 未见声明 | 404无规则 | 2026-11-11 | 资讯已有 exp-20261014-zijin | Tres Quebradas/LIEX；英文列表；[项目/关系依据](https://www.zijinmining.com/global/program-detail-71747.htm) |
| D039 紫金矿业·西语新闻 | AR-K | [列表](https://es.zijinmining.com/news/news_list.jsp) | 新闻/es | 未见声明 | 404无规则 | 2026-11-12 | 目录未见 | 同集团不同语言栏目，与英文存在转载重叠；[项目/关系依据](https://es.zijinmining.com/global/program-detail-71819.htm) |
| D040 赣锋LATAM·新闻 | AR-Y/AR-A | [列表](https://ganfenglithium-latam.com/noticias/) | 新闻/es | [声明](https://ganfenglithium-latam.com/feed/) | 允许 | 静态列表未明示 | 目录未见 | 官方独立Noticias栏目可打开但本次静态未返回条目；项目导航明示Exar/Mariana/PPG/Incahuasi/Sal de la Puna；登记前需既有预览确认条目，当前未做采集预览；[项目/关系依据](https://ganfenglithium-latam.com/proyecto-mariana/) |
| D041 赣锋锂业·中文新闻 | AR-Y/AR-A | [列表](https://www.ganfenglithium.com/news.html) | 新闻/zh | 未见声明 | 允许 | 2026-03-17 | 资讯已有 exp-20261014-ganfeng | 官方明确Mariana及Cauchari-Olaroz、PPG等阿根廷项目；全集团新闻；[项目/关系依据](https://www.ganfenglithium.com/new_detail/id/172.html) |
| D042 青山控股·企业动态 | AR-A | [列表](https://www.tssgroup.com.cn/ts-news/news1/) | 新闻/zh | 未见声明 | 允许 | 2026-11-12 | 目录未见 | 历史Centenario-Ratones合作；2024-10 Eramet回购其合资股权，需按现时公告判断，不当当前合资股东。tsingshan.net为青山钢管，非本行目标；[项目/关系依据](https://eramine.eramet.com/en/media/eramet-regains-full-ownership-in-its-flagship-lithium-business-in-argentina/) |

### E 矿业媒体（31）

| 编号/名称 | 省 | 列表页 URL | 类型/语言 | RSS | robots 准入 | 最新明示内容日期 | 目录去重 | 备注 |
|---|---|---|---|---|---|---|---|---|
| E001 Acero y Roca | AR-J | [列表](https://aceroyroca.com/) | 新闻/es | [声明](https://aceroyroca.com/feed/) | 允许 | 2026-11-13 | 目录未见 | — |
| E002 Argentina Minera·铜 | AR | [列表](https://argentinaminera.com/category/cobre/) | 新闻/es | [声明1](https://argentinaminera.com/feed/)、[声明2](https://argentinaminera.com/category/cobre/feed/) | 允许 | 2026-03-05 | 目录未见 | — |
| E003 Argentina Minera·锂 | AR | [列表](https://argentinaminera.com/category/litio/) | 新闻/es | [声明1](https://argentinaminera.com/feed/)、[声明2](https://argentinaminera.com/category/litio/feed/) | 允许 | 2025-12-23 | 目录未见 | — |
| E004 Comunidad Minera | AR | [列表](https://www.comunidadminera.com/) | 新闻/es | [声明](https://www.comunidadminera.com/rss/noticias) | 允许 | 列表未明示 | 资讯已有 sa5-ar-comunidad | — |
| E005 EconoJournal·矿业 | AR | [列表](https://econojournal.com.ar/mineria/) | 新闻/es | [声明](https://econojournal.com.ar/feed/) | 允许 | 列表未明示 | 目录未见 | — |
| E006 El Inversor Energético & Minero·矿业 | AR | [列表](https://www.elinversorenergetico.com/noticias/mineria-3/) | 新闻/es | [声明1](https://www.elinversorenergetico.com/feed/)、[声明2](https://www.elinversorenergetico.com/noticias/mineria-3/feed/) | 允许 | 2026-11-11 | 目录未见 | — |
| E007 El Pregón Minero / Editorial RN | AR | [列表](https://editorialrn.com.ar/) | 新闻/es | [声明](https://editorialrn.com.ar/feed/) | 允许 | 2026-11-12 | 目录未见 | — |
| E008 Energiminas | AR | [列表](https://energiminas.com/) | 新闻/es | [声明](https://energiminas.com/feed/) | 允许 | 2026-11-12 | 同域异栏 exp-20261014-energiminas | 拉美区域/国际媒体，栏目可能含非AR内容 |
| E009 Latinominería | AR | [列表](https://www.latinomineria.com/) | 新闻/es | RSS按钮指向index.html，未验证有效feed | 允许 | 2019-03（仅月） | 目录未见 | 拉美区域/国际媒体，栏目可能含非AR内容；列表呈2019年旧内容，导航/正文混博彩外链；未确认现行发布者与维护状态 |
| E010 Latitud Catamarca·新闻 | AR-K | [列表](https://latitudcatamarca.com/noticias) | 新闻/es | 未见声明 | 允许 | 2026-09-17 | 目录未见 | — |
| E011 Litio Argentina（litio.com.ar） | AR | [列表](https://litio.com.ar/) | 新闻/es | [声明](https://litio.com.ar/feed/) | 允许 | 列表未明示 | 目录未见 | 两家不同域名的同名媒体，保持独立候选 |
| E012 Litio Argentina（litioargentina.com） | AR | [列表](https://litioargentina.com/) | 新闻/es | [声明](https://litioargentina.com/feed/) | 允许 | 列表未明示 | 目录未见 | 两家不同域名的同名媒体，保持独立候选 |
| E013 Mejor Energía | AR-Q | [列表](https://www.mejorenergia.com.ar/mineria/) | 新闻/es | [声明](https://www.mejorenergia.com.ar/rss/noticias) | 允许 | 列表未明示 | 目录未见 | — |
| E014 Minería & Desarrollo·矿业 | AR | [列表](https://www.mineriaydesarrollo.com/mineria) | 新闻/es | [声明](https://www.mineriaydesarrollo.com/rss/noticias) | 允许 | 列表未明示 | 同域异栏 exp-20261014-mineria-desarrollo | — |
| E015 Minería Argentina（mineriaargentina.com.ar） | AR | [列表](https://mineriaargentina.com.ar/) | 新闻/es | [声明](https://mineriaargentina.com.ar/feed/) | 允许 | 列表未明示 | 资讯已有 exp-20261108-mineria-argentina | 与argentinaminera.com是不同域名/发布者候选；当前目录为feed，本行只读其新闻首页 |
| E016 Minería Pan-Americana | AR | [列表](https://mineria-pa.com/) | 新闻/es | [声明](https://mineria-pa.com/feed/) | 允许 | 2026-11-12 | 同域异栏 exp-20261014-mineria-panamericana | 拉美区域/国际媒体，栏目可能含非AR内容 |
| E017 Minería Sustentable | AR | [列表](https://mineriasustentable.com.ar/) | 新闻/es | 未见声明 | 允许 | 2026-11-13 | 资讯已有 exp-20261014-mineria-sustentable | — |
| E018 Minería en Línea | AR | [列表](https://mineriaenlinea.com/) | 新闻/es | [声明](https://mineriaenlinea.com/feed/) | 允许 | 2026-11-12 | 资讯已有 exp-20261014-mineria-en-linea | 拉美区域/国际媒体，栏目可能含非AR内容 |
| E019 Minería y Futuro | AR | [列表](https://www.mineriayfuturo.cl/noticias/) | 新闻/es | [声明1](https://www.mineriayfuturo.cl/feed/)、[声明2](https://www.mineriayfuturo.cl/category/noticias/feed/) | 允许 | 2026-11-06 | 目录未见 | 拉美区域/国际媒体，栏目可能含非AR内容 |
| E020 Minería.com.ar | AR | [列表](https://mineria.com.ar/) | 新闻/es | [声明](https://mineria.com.ar/feed/) | 允许 | 列表未明示 | 目录未见 | — |
| E021 Mining Press·全部资讯 | AR | [列表](https://miningpress.com/nota) | 新闻/es | 未见声明 | 404无规则 | 2026-11-12 | 资讯已有 exp-20261014-mining-press | robots404，按RFC9309无规则 |
| E022 NEXO Minero | AR | [列表](https://www.nexodata.com.ar/nexo-minero/) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | — |
| E023 Noticias Mineras | AR | [列表](https://noticiasmineras.com.ar/) | 新闻/es | [声明1](https://noticiasmineras.com.ar/feed/)、[声明2](https://noticiasmineras.com.ar/feed/atom/)、[声明3](https://noticiasmineras.com.ar/feed/) | 允许 | 2026-11-12 | 目录未见 | — |
| E024 Nueva Minería y Energía | AR | [列表](https://www.nuevamineria.com/revista/) | 新闻/es | 未见声明 | 允许 | 2026-11-12 | 同域异栏 rpl-nuevamineria | 拉美区域/国际媒体，栏目可能含非AR内容 |
| E025 Once Diario | AR | [列表](https://www.oncediario.com.ar/) | 新闻/es | 未见声明 | 允许 | 2026-11-12 | 目录未见 | 当前矿业新闻可读，页尾混大量无关博彩与外链，登记前需核来源质量 |
| E026 Panorama Minero | AR | [列表](https://www.panorama-minero.com/es) | 新闻/es | 未见声明 | 允许 | 2026-11-11 | 同域异栏 exp-20261014-panorama-minero | — |
| E027 Panorama Minero·英文新闻 | AR | [列表](https://www.panorama-minero.com/en/news) | 新闻/en | 未见声明 | 允许 | 2026-11-11 | 资讯已有 exp-20261014-panorama-minero | 与/es西语新闻为同一发布者的不同语言栏目，不算独立发布者 |
| E028 Portal Minero·新闻 | AR | [列表](https://www.portalminero.com/noticias) | 新闻/es | 未见声明 | 允许 | 2026-11-12 | 同域异栏 exp-20261014-portal-minero | 拉美区域/国际媒体，栏目可能含非AR内容 |
| E029 Reporte Minero·新闻 | AR | [列表](https://www.reporteminero.cl/noticias/noticias) | 新闻/es | 未见声明 | 允许 | 2026-11-12 | 资讯已有 exp-20261014-reporte-minero | 拉美区域/国际媒体，栏目可能含非AR内容 |
| E030 Salta Mining | AR-A | [列表](https://saltamining.com/) | 新闻/es | 未见声明 | 允许 | 2026-11-12 | 目录未见 | — |
| E031 San Juan Minero | AR-J | [列表](https://sanjuanminero.com.ar/) | 新闻/es | [声明](https://sanjuanminero.com.ar/feed/) | 允许 | 列表未明示 | 目录未见 | 矿业新闻与quiniela抽奖资讯混排；12日日期来自抽奖条目，矿业条目未明示日期 |

### F 财经、综合与省级媒体（64）

| 编号/名称 | 省 | 列表页 URL | 类型/语言 | RSS | robots 准入 | 最新明示内容日期 | 目录去重 | 备注 |
|---|---|---|---|---|---|---|---|---|
| F001 BAE Negocios·经济 | AR | [列表](https://www.baenegocios.com/economia/) | 新闻/es | 未见声明 | 允许 | 2026-11-12 | 目录未见 | — |
| F002 Bloomberg Línea·阿根廷 | AR | [列表](https://www.bloomberglinea.com/latinoamerica/argentina/) | 新闻/es | [声明1](https://www.bloomberglinea.com/arc/outboundfeeds/rss.xml)、[声明2](https://www.bloomberglinea.com/arc/outboundfeeds/rss/latinoamerica/argentina.xml) | 允许 | 2026-11-12 | 目录未见 | — |
| F003 Buenos Aires Herald·产业 | AR | [列表](https://buenosairesherald.com/business/industry) | 新闻/en | [声明1](https://buenosairesherald.com/feed)、[声明2](https://buenosairesherald.com/feed/atom)、[声明3](https://buenosairesherald.com/feed)、[声明4](https://buenosairesherald.com/business/industry/feed) | 允许 | 2026-11-03 | 目录未见 | — |
| F004 Buenos Aires Herald·商业 | AR | [列表](https://buenosairesherald.com/business) | 新闻/en | [声明1](https://buenosairesherald.com/feed)、[声明2](https://buenosairesherald.com/feed/atom)、[声明3](https://buenosairesherald.com/feed)、[声明4](https://buenosairesherald.com/business/feed) | 允许 | 2026-11-11 | 目录未见 | — |
| F005 Buenos Aires Times·商业 | AR | [列表](https://www.batimes.com.ar/topics/business) | 新闻/en | [声明](https://www.batimes.com.ar/feed) | 允许 | 2026-10-20 | 目录未见 | RSS为列表声明/链接，未另取feed |
| F006 Buenos Aires Times·综合首页 | AR | [列表](https://www.batimes.com.ar) | 新闻/en | [声明](https://www.batimes.com.ar/feed) | 允许 | 列表未明示 | 目录未见 | 请求/economy重定向首页；本行是综合首页，business主题另列；RSS为列表声明/链接，未另取feed |
| F007 CBA24N·经济 | AR-X | [列表](https://www.cba24n.com.ar/economia_c5de578e9d91dda4989139d88) | 新闻/es | [声明1](https://www.cba24n.com.ar/atom.xml)、[声明2](https://www.cba24n.com.ar/rss.xml)、[声明3](https://www.cba24n.com.ar/rss.xml?category=5de578e9d91dda4989139d88) | 允许 | 2026-11-12 | 目录未见 | 已定位正确经济栏目，先前短路径404保留在阻碍附录 |
| F008 Clarín | AR | [列表](https://www.clarin.com/economia) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | — |
| F009 Clarín·能源与矿业 | AR | [列表](https://www.clarin.com/energia-mineria) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | — |
| F010 Comercio y Justicia | AR-X | [列表](https://comercioyjusticia.info/economia/) | 新闻/es | [声明1](https://comercioyjusticia.info/feed/)、[声明2](https://comercioyjusticia.info/category/economia/feed/) | 允许 | 2026-11-12 | 目录未见 | — |
| F011 Comercio y Justicia | AR-X | [列表](https://comercioyjusticia.info/) | 新闻/es | [声明](https://comercioyjusticia.info/feed/) | 允许 | 2026-11-12 | 目录未见 | — |
| F012 Diario InfoSalta·经济农业与商业 | AR-A | [列表](https://diarioinfosalta.com/category/economia-agro-y-negocios/) | 新闻/es | [声明1](https://diarioinfosalta.com/feed/)、[声明2](https://diarioinfosalta.com/category/economia-agro-y-negocios/feed/) | 允许 | 2026-10-25 | 目录未见 | — |
| F013 Diario Mendoza·经济 | AR-M | [列表](https://www.diariomendoza.com.ar/economia/) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | — |
| F014 Diario Río Negro | AR-R | [列表](https://www.rionegro.com.ar/economia/) | 新闻/es | [声明1](https://www.rionegro.com.ar/feed/)、[声明2](https://www.rionegro.com.ar/economia/feed/) | 允许 | 列表未明示 | 目录未见 | HTTP200静态仅导航/JS，未见经济条目，列表日期未知；能源栏目可见条目另列；同一媒体也覆盖Neuquén |
| F015 Diario Río Negro | AR-R | [列表](https://www.rionegro.com.ar/energia/) | 新闻/es | [声明1](https://www.rionegro.com.ar/feed/)、[声明2](https://www.rionegro.com.ar/energia/feed/) | 允许 | 列表未明示 | 目录未见 | 同一媒体也覆盖Neuquén |
| F016 Diario UNO·经济 | AR-M | [列表](https://www.diariouno.com.ar/economia) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | — |
| F017 Diario de Cuyo·经济 | AR-J | [列表](https://www.diariodecuyo.com.ar/economia) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | — |
| F018 Diario de Salta·经济 | AR-A | [列表](https://diariosalta.com/economia/) | 新闻/es | [声明1](https://diariosalta.com/feed/)、[声明2](https://diariosalta.com/economia/feed/) | 允许 | 2026-10-14（更新2026-10-19） | 目录未见 | — |
| F019 El Ancasti | AR-K | [列表](https://www.elancasti.com.ar/mineria-a66) | 新闻/es | [声明](https://www.elancasti.com.ar/contenidos/rss.html（未另取目录/feed）) | 允许 | 2026-11-12 | 资讯已有 sa5-ar-ancasti | — |
| F020 El Ancasti | AR-K | [列表](https://www.elancasti.com.ar/economia-a920/1) | 新闻/es | [声明](https://www.elancasti.com.ar/contenidos/rss.html（未另取目录/feed）) | 允许 | 2026-09-06 | 同域异栏 sa5-ar-ancasti | — |
| F021 El Chubut·经济 | AR-U | [列表](https://www.elchubut.com.ar/) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | — |
| F022 El Chubut·经济 | AR-U | [列表](https://www.elchubut.com.ar/seccion/economia) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | — |
| F023 El Cronista·经济与政治 | AR | [列表](https://www.cronista.com/economia-politica/) | 新闻/es | 未见声明 | 允许 | 2026-11-12 | 目录未见 | — |
| F024 El Cronista·金融市场 | AR | [列表](https://www.cronista.com/finanzas-mercados/) | 新闻/es | 未见声明 | 允许 | 2026-11-13 | 目录未见 | — |
| F025 El Destape·经济 | AR | [列表](https://www.eldestapeweb.com/economia) | 新闻/es | [声明](https://www.eldestapeweb.com/adjuntos/177/rss/economia.xml) | 允许 | 列表未明示 | 目录未见 | — |
| F026 El Destape·经济 | AR | [列表](https://www.eldestaperadio.com/economia) | 新闻/es | [声明](https://www.eldestapeweb.com/adjuntos/177/rss/economia.xml) | 允许 | 列表未明示 | 目录未见 | — |
| F027 El Economista | AR | [列表](https://eleconomista.com.ar/economia/) | 新闻/es | [声明1](https://eleconomista.com.ar/feed/)、[声明2](https://eleconomista.com.ar/economia/feed/) | 允许 | 列表未明示 | 目录未见 | — |
| F028 El Economista | AR | [列表](https://eleconomista.com.ar/) | 新闻/es | [声明](https://eleconomista.com.ar/feed/) | 允许 | 列表未明示 | 目录未见 | — |
| F029 El Esquiú·经济 | AR-K | [列表](https://www.elesquiu.com/economia) | 新闻/es | 未见声明 | 允许 | 2026-11-03 | 目录未见 | — |
| F030 El Independiente | AR-F | [列表](https://www.elindependiente.com.ar/) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | — |
| F031 El Independiente·地方综合（含经济） | AR-F | [列表](https://www.elindependiente.com.ar/seccion.php?seccion=1) | 新闻/es | [声明](https://www.elindependiente.com.ar/feed.xml) | 允许 | 2026-11-12 | 目录未见 | 该栏目标题为Locales（地方综合），含经济/投资新闻；编码出现乱码，登记需复核 |
| F032 El Tribuno de Jujuy·经济 | AR-Y | [列表](https://eltribunodejujuy.com/ttag/economia) | 新闻/es | [声明](https://eltribunodejujuy.com/page-rss（未另取目录/feed）) | 允许 | 列表未明示 | 目录未见 | — |
| F033 El Tribuno de Salta | AR-A | [列表](https://www.eltribuno.com/ttag/economia) | 新闻/es | [声明](https://www.eltribuno.com/page-rss（未另取目录/feed）) | 允许 | 列表未明示 | 目录未见 | — |
| F034 El Tribuno de Salta·Jujuy标签 | AR-A | [列表](https://www.eltribuno.com/jujuy) | 新闻/es | [声明](https://www.eltribuno.com/page-rss（未另取目录/feed）) | 允许 | 列表未明示 | 目录未见 | Salta站的Jujuy标签，另列Jujuy独立站 |
| F035 EnerNews·全部资讯 | AR | [列表](https://enernews.com/nota) | 新闻/es | 未见声明 | 404无规则 | 2026-11-12 | 目录未见 | robots404，按RFC9309无规则；能源专业媒体；矿业专栏另列或后续由Claude圈选 |
| F036 Energía Estratégica | AR | [列表](https://www.energiaestrategica.com/strategicenergy/es) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | 能源专业媒体；矿业专栏另列或后续由Claude圈选 |
| F037 Energía Estratégica | AR | [列表](https://www.energiaestrategica.com/energiaestrategica/es) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | 能源专业媒体；矿业专栏另列或后续由Claude圈选 |
| F038 Infobae·经济 | AR | [列表](https://www.infobae.com/economia/) | 新闻/es | [声明](https://www.infobae.com/arc/outboundfeeds/rss/category/economia/) | 允许 | 列表未明示 | 同域异栏 sa5-ar-infobae-mining | — |
| F039 Jornada·经济 | AR-U | [列表](https://www.diariojornada.com.ar/economia) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | — |
| F040 LM +E·能源 | AR-Q | [列表](https://mase.lmneuquen.com/) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | LM Neuquén能源专业子站 |
| F041 LM Neuquén | AR-Q | [列表](https://www.lmneuquen.com/economia-y-petroleo-a420) | 新闻/es | [声明](https://www.lmneuquen.com/contenidos/rss.html（未另取目录/feed）) | 允许 | 列表未明示 | 目录未见 | 标签可读但正文多2018年旧内容，2026页脚不能证明更新；+E子站另列 |
| F042 La Nación·经济 | AR | [列表](https://www.lanacion.com.ar/economia/) | 新闻/es | [声明](https://www.lanacion.com.ar/arc/outboundfeeds/rss/?outputType=xml) | 允许 | 2026-11-12 | 目录未见 | RSS为列表声明/链接，未另取feed |
| F043 La Opinión Austral·政治与经济 | AR-Z | [列表](https://laopinionaustral.com.ar/seccion/politica-y-economia.html) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | — |
| F044 La Voz del Interior | AR-X | [列表](https://www.lavoz.com.ar/negocios/) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | — |
| F045 La Voz del Interior·政治（含宏观经济） | AR-X | [列表](https://www.lavoz.com.ar/politica/) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | — |
| F046 Los Andes·经济 | AR-M | [列表](https://www.losandes.com.ar/economia) | 新闻/es | [声明](https://www.losandes.com.ar/contenidos/rss.html（未另取目录/feed）) | 允许 | 列表未明示 | 目录未见 | — |
| F047 MDZ·经济 | AR-M | [列表](https://www.mdzol.com/economia) | 新闻/es | 未见声明 | 允许 | 2026-11-12 | 目录未见 | — |
| F048 Mejor Energía | AR-Q | [列表](https://www.mejorenergia.com.ar/) | 新闻/es | [声明](https://www.mejorenergia.com.ar/rss/noticias) | 允许 | 列表未明示 | 目录未见 | 能源专业媒体；矿业专栏另列或后续由Claude圈选 |
| F049 Nueva Rioja·经济 | AR-F | [列表](https://www.nuevarioja.com.ar/temas/economia) | 新闻/es | 未见声明 | 允许 | 2026-11-12 | 目录未见 | 已定位正确经济栏目，先前短路径404保留在阻碍附录 |
| F050 Perfil·经济 | AR | [列表](https://www.perfil.com/economia) | 新闻/es | [声明1](https://www.perfil.com/feed)、[声明2](https://www.perfil.com/paginas-estaticas/canales-rss-aRyGO0y2C3cJ) | 允许 | 列表未明示 | 目录未见 | RSS为列表声明/链接，未另取feed |
| F051 Pregón de Jujuy | AR-Y | [列表](https://www.pregon.com.ar/) | 新闻/es | 未见声明 | 允许 | 2026-11-05 | 目录未见 | — |
| F052 Puntal·经济 | AR-X | [列表](https://www.puntal.com.ar/contenidos/economia.html) | 新闻/es | [声明](https://www.puntal.com.ar/contenidos/rss.html（未另取目录/feed）) | 允许 | 列表未明示 | 目录未见 | 已定位正确经济栏目，先前短路径404保留在阻碍附录 |
| F053 Página/12·经济 | AR | [列表](https://www.pagina12.com.ar/economia/) | 新闻/es | [声明](https://www.pagina12.com.ar/rss（未另取目录/feed）) | 允许 | 列表未明示 | 目录未见 | — |
| F054 Sitio Andino·经济 | AR-M | [列表](https://www.sitioandino.com.ar/economia-a743) | 新闻/es | [声明](https://www.sitioandino.com.ar/contenidos/rss.html（未另取目录/feed）) | 允许 | 2026-11-06 | 同域异栏 sa5-ar-sitioandino | 已定位正确经济栏目，先前短路径404保留在阻碍附录 |
| F055 Sitio Andino·能源 | AR-M | [列表](https://www.sitioandino.com.ar/seccion/energia) | 新闻/es | [声明](https://www.sitioandino.com.ar/contenidos/rss.html（未另取目录/feed）) | 允许 | 列表未明示 | 资讯已有 sa5-ar-sitioandino | 列表含矿业/能源/投资条目；头部13日不当条目日期 |
| F056 TN·经济 | AR | [列表](https://tn.com.ar/economia/) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | — |
| F057 Tiempo de San Juan·经济 | AR-J | [列表](https://www.tiempodesanjuan.com/economia-a24360) | 新闻/es | [声明](https://www.tiempodesanjuan.com/contenidos/rss（未另取目录/feed）) | 允许 | 2026-10-02 | 目录未见 | — |
| F058 TiempoSur | AR-Z | [列表](https://www.tiemposur.com.ar/tema/econom%C3%ADa) | 新闻/es | 未见声明 | 允许 | 2026-11-12 | 目录未见 | — |
| F059 TiempoSur·综合首页 | AR-Z | [列表](https://www.tiemposur.com.ar/) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | 请求/economia重定向首页；本行是综合首页，economía主题另列 |
| F060 iProfesional·经济 | AR | [列表](https://www.iprofesional.com/economia) | 新闻/es | [声明](https://www.iprofesional.com/rss/economia) | 允许 | 列表未明示 | 目录未见 | — |
| F061 Ámbito | AR | [列表](https://www.ambito.com/economia) | 新闻/es | [声明](https://www.ambito.com/contenidos/rss.html（未另取目录/feed）) | 允许 | 列表未明示 | 同域异栏 sa5-ar-ambito | — |
| F062 Ámbito·矿业主题 | AR | [列表](https://www.ambito.com/mineria-a5123007/1) | 新闻/es | [声明](https://www.ambito.com/contenidos/rss.html（未另取目录/feed）) | 允许 | 列表未明示 | 资讯已有 sa5-ar-ambito | 列表也含能源采访；保留完整候选范围交Claude圈选 |
| F063 Ámbito·能源 | AR | [列表](https://www.ambito.com/energia) | 新闻/es | [声明](https://www.ambito.com/contenidos/rss.html（未另取目录/feed）) | 允许 | 列表未明示 | 同域异栏 sa5-ar-ambito | — |
| F064 Ámbito·金融 | AR | [列表](https://www.ambito.com/finanzas) | 新闻/es | [声明](https://www.ambito.com/contenidos/rss.html（未另取目录/feed）) | 允许 | 列表未明示 | 同域异栏 sa5-ar-ambito | — |

### G 金融宏观、外贸及 RIGI 官方数据（29）

| 编号/名称 | 省 | 列表页 URL | 类型/语言 | RSS | robots 准入 | 最新明示内容日期 | 目录去重 | 备注 |
|---|---|---|---|---|---|---|---|---|
| G001 ARCA·海关外贸公开数据说明 | AR | [列表](https://arca.gob.ar/operadoresComercioExterior/informacionAgregada/informacion-agregada.asp) | 数据/es | 未见声明 | 404无规则 | 未明示 | 目录未见 | 按年月、海关、运输、NCM、国家等列字段及下载说明；不取企业申报数据 |
| G002 ARCA·税收统计目录 | AR | [列表](https://www.arca.gob.ar/institucional/estudios/) | 数据/es | 未见声明 | 404无规则 | 2026-10（税收月） | 目录未见 | 最新月报期次；未打开明细 |
| G003 BCRA·外国直接投资报告 | AR | [列表](https://www.bcra.gob.ar/informe-de-inversion-extranjera-directa/) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-003 | 含按行业/国家的外资存量及流量序列，报告期次动态加载 |
| G004 BCRA·外汇市场与收支报告 | AR | [列表](https://www.bcra.gob.ar/informe-de-la-evolucion-del-mercado-de-cambios-y-balance-cambiario/) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-003 | 含月度与行业Excel序列下载，报告期次动态加载 |
| G005 BCRA·报告分类目录 | AR | [列表](https://www.bcra.gob.ar/informes/) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-003 | 报告按货币、金融稳定、外部、研究等分组 |
| G006 BCRA·最新报告列表 | AR | [列表](https://www.bcra.gob.ar/ultimos-informes/) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-003 | 200栏目标题可读，但本轮静态无报告行；待动态预览，未用搜索索引日期补值 |
| G007 BCRA·每周资产负债摘要 | AR | [列表](https://www.bcra.gob.ar/estados-resumidos-activos-pasivos-semanales/) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-003 | 有报告栏目/资料链接；静态期次待核，不执行JS |
| G008 BCRA·私人外债报告 | AR | [列表](https://www.bcra.gob.ar/informe-sobre-deuda-externa-privada/) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-003 | 有报告栏目/资料链接；静态期次待核，不执行JS |
| G009 BCRA·统计公报 | AR | [列表](https://www.bcra.gob.ar/boletin-estadistico/) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-003 | 有报告栏目/资料链接；静态期次待核，不执行JS |
| G010 BCRA·货币政策报告 | AR | [列表](https://www.bcra.gob.ar/informe-de-politica-monetaria/) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-003 | 有报告栏目/资料链接；静态期次待核，不执行JS |
| G011 BCRA·货币日报 | AR | [列表](https://www.bcra.gob.ar/informe-monetario-diario/) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-003 | 有报告栏目/资料链接；静态期次待核，不执行JS |
| G012 BCRA·货币月报 | AR | [列表](https://www.bcra.gob.ar/informe-monetario-mensual/) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-003 | 有报告栏目/资料链接；静态期次待核，不执行JS |
| G013 BCRA·货币金融主要指标 | AR | [列表](https://www.bcra.gob.ar/estadisticas-indicadores/) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-003 | 有指标名称/系列链接，静态未加载日期与值；汇率/储备等候选 |
| G014 BCRA·货币金融变量API元数据 | AR | [列表](https://www.bcra.gob.ar/catalogo_de_datos/principales-variables-monetarias-y-financieras/) | 数据/es | 未见声明 | 允许 | 2025-10-28（元数据更新） | 同域异栏 AR-003 | 是页面明示元数据日期，不等于每条金融序列最新期 |
| G015 BCRA·金融稳定报告 | AR | [列表](https://www.bcra.gob.ar/informe-de-estabilidad-financiera/) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-003 | 有报告栏目/资料链接；静态期次待核，不执行JS |
| G016 INDEC·价格/通胀报告 | AR | [列表](https://www.indec.gob.ar/Nivel3/Tema/3/5) | 数据/es | 未见声明 | 允许 | 2026-11-12 | 目录未见 | 含IPC、批发价与建筑成本；旧/indec/web路径只返回通用壳 |
| G017 INDEC·外贸报告 | AR | [列表](https://www.indec.gob.ar/Nivel3/Tema/3/2) | 数据/es | 未见声明 | 允许 | 2026-11-05 | 目录未见 | 含出口总额、出口产业链与省级出口；旧/indec/web路径只返回通用壳 |
| G018 INDEC·矿业工业生产指数 | AR | [列表](https://www.indec.gob.ar/Nivel4/Tema/3/7/172) | 数据/es | 未见声明 | 允许 | 2026-11-06 | 目录未见 | IPI最新报告期2026-09，发布日期06/11/26 |
| G019 RIGI·官方制度说明 | AR | [列表](https://www.argentina.gob.ar/economia/rigi/que-es) | 法规/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | 制度参考入口，非滚动新闻列表；未推断现行法律结论 |
| G020 RIGI·批准项目与投资面板 | AR | [列表](https://www.argentina.gob.ar/economia/rigi) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | 200但项目卡片/金额由JS加载；静态0为占位，不记为真实值或“零项目” |
| G021 SIACAM·指标目录 | AR | [列表](https://www.argentina.gob.ar/economia/mineria/siacam/indicadores) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | 含出口、就业、价格、铜/锂和省级监管；各图表未执行 |
| G022 SIACAM·矿业数据入口 | AR | [列表](https://www.argentina.gob.ar/economia/mineria/siacam) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | 数据、报告、地质图与矿业地籍目录；旧/produccion路径正常转到此页 |
| G023 矿业秘书处·2026月报 | AR | [列表](https://www.argentina.gob.ar/economia/mineria/informes-y-estudios-sobre-mineria/informes-mensuales/2026) | 数据/es | 未见声明 | 允许 | 2026-11（报告月） | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | 列表明示月份；未补日或时分 |
| G024 矿业秘书处·周报 | AR | [列表](https://www.argentina.gob.ar/economia/mineria/informes-y-estudios-sobre-mineria/informes-semanales) | 数据/es | 未见声明 | 允许 | 2026-11-06（报告周） | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | Foco local和价格两个系列 |
| G025 矿业秘书处·矿产品市场报告 | AR | [列表](https://www.argentina.gob.ar/economia/mineria/informes-y-estudios-sobre-mineria/mercados-mineros) | 数据/es | 未见声明 | 允许 | 2026-10（锂报告月） | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | 各矿种更新频率不同；未打开PDF |
| G026 矿业秘书处·研究报告目录 | AR | [列表](https://www.argentina.gob.ar/economia/mineria/informes-y-estudios-sobre-mineria) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | 按周/月/矿种/项目分组，非单一新闻列表 |
| G027 矿业秘书处·项目目录 | AR | [列表](https://www.argentina.gob.ar/economia/mineria/informes-y-estudios-sobre-mineria/catalogos-de-proyectos) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | 铜、金、锂、银、铀等项目目录；列表未明示发布日 |
| G028 经济部·报告总目录 | AR | [列表](https://www.argentina.gob.ar/economia/informes) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | 生产、债务、财政与经济研究目录 |
| G029 经济部·经济数据集目录 | AR | [列表](https://www.argentina.gob.ar/economia/datos) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | 宏观、产业、省级、金融和财政序列下载目录 |

## 阻碍与未定位附录

以下入口保留研究线索，未计入主清单；旧路径与已找到的新入口分别记实际结果，不能把旧路径失败算成整家发布者不可访问。
| 编号/名称 | 省 | 列表页 URL | 类型/语言 | RSS | robots 准入 | 最新明示内容日期 | 目录去重 | 备注 |
|---|---|---|---|---|---|---|---|---|
| X001 ARCA·法规图书馆 | AR | [列表](https://biblioteca.arca.gob.ar/) | 法规/es | 未见声明 | robots未知 HTTP302 | 未明示 | 法规已有 AR-004 | robots未知 HTTP302；robots返回302，当前准入未确认；未请求正文 |
| X002 ARCA·海关首页 | AR | [列表](https://www.arca.gob.ar/aduana/) | 新闻/es | 未见声明 | 404无规则 | 未明示 | 目录未见 | 可读；200仅返回数字字符串，未得到公开列表 |
| X003 ARCA·综合更新旧入口 | AR | [列表](https://servicioscf.arca.gob.ar/publico/sitio/contenido/novedad/) | 新闻/es | 未见声明 | 404无规则 | 未明示 | 目录未见 | 可读；200仅返回数字字符串，未得到公开列表 |
| X004 Catamarca · 官方公报栏目 | AR-K | [列表](https://portal.catamarca.gob.ar/ui/boletin) | 法规/es | 未核 | 主机robots允许；列表因既有challenge未再读 | 未取得 | 同域异栏 AR-005 | 受阻（已知主机challenge）；联邦官方机构名录/公开文件给出此路径；0635同主机已遇challenge，本轮不绕验证、不新增GET。 |
| X005 Catamarca · 环境秘书处门户 | AR-K | [列表](https://portal.catamarca.gob.ar/ui/organismos/secretaria-de-medio-ambiente) | 公告/es | 未核 | 主机robots允许；列表因既有challenge未再读 | 未取得 | 同域异栏 AR-005 | 受阻（已知主机challenge）；联邦官方机构名录/公开文件给出此路径；0635同主机已遇challenge，本轮不绕验证、不新增GET。 |
| X006 Catamarca · 省政府新闻/公报门户 | AR-K | [列表](https://portal.catamarca.gob.ar/) | 新闻/es | 未见声明 | 允许 | 未取得 | 同域异栏 AR-005 | 受阻；0635现行UA遇crawl_challenge；原公报候选路径/ui/boletin同主机，未绕挑战访问。 |
| X007 Chubut · 官方公报 | AR-U | [列表](https://boletin.chubut.gov.ar/) | 法规/es | 未见声明 | robots未知 HTTP403 | 列表未明示 | 目录未见 | robots未知 HTTP403；robots HTTP403，未读列表。 |
| X008 Chubut · 省政府新闻 | AR-U | [列表](https://noticias.chubut.gob.ar/) | 新闻/es | 未见声明 | robots非规则正文 | 列表未明示 | 目录未见 | robots非规则正文；robots返回HTML/非规则正文，本卡准入未知，未读列表。 |
| X009 Córdoba · 官方公报 | AR-X | [列表](https://boletinoficial.cba.gov.ar/) | 法规/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | HTTP403；robots允许，列表HTTP403 Request blocked；停止。 |
| X010 Córdoba · 政府新闻 | AR-X | [列表](https://prensa.cba.gov.ar/) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | HTTP403；robots允许，列表HTTP403 Request blocked；停止。 |
| X011 Córdoba · 环境部门 | AR-X | [列表](https://ambiente.cba.gov.ar/) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | HTTP403；官方环境部门入口（联邦SENASA机构名录所列）；robots允许、正文HTTP403。 |
| X012 Córdoba · 矿业秘书处旧门户 | AR-X | [列表](https://www.cba.gov.ar/reparticion/ministerio-de-industria-comercio-y-mineria/secretaria-de-mineria/) | 公告/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | HTTP403；官方旧路径；robots允许但页面HTTP403，未绕过。 |
| X013 La Rioja · 省政府新闻 | AR-F | [列表](https://larioja.gob.ar/noticias/) | 新闻/es | 未见声明 | 404无规则 | 列表未明示 | 目录未见 | 可读；HTTP200原HTML只有导航，列表依赖前端外部API；未执行JS或读API。 |
| X014 Mendoza · 官方公报信息平台 | AR-M | [列表](https://informacionoficial.mendoza.gob.ar/boletinoficial/) | 法规/es | 未见声明 | robots未知 HTTP403 | 列表未明示 | 目录未见 | robots未知 HTTP403；robots HTTP403，未请求列表。 |
| X015 Mendoza · 官方公报旧入口 | AR-M | [列表](https://boletinoficial.mendoza.gov.ar/boletin-oficial/) | 法规/es | 未见声明 | robots未知 HTTP301 | 列表未明示 | 同域异栏 AR-011 | robots未知 HTTP301；robots返回301；未把重定向规则误记为准入。 |
| X016 Mendoza · 能源与环境/能源矿业旧新闻域名 | AR-M | [列表](https://prensa.mendoza.gob.ar/category/energia-y-ambiente/energia-y-mineria/) | 新闻/es | 未见声明 | robots未知 HTTP403 | 列表未明示 | 目录未见 | robots未知 HTTP403；robots HTTP403，未请求列表。 |
| X017 Neuquén · Infoleg 官方公报列表 | AR-Q | [列表](https://infoleg.neuquen.gob.ar/Boletines/) | 法规/es | 未见声明 | robots未知 HTTP0 | 列表未明示 | 目录未见 | robots未知 HTTP0；robots TLS证书链校验失败；搜索可见列表，但本轮直接读取未通过，未记可抓。 |
| X018 Neuquén · 官方公报旧域名 | AR-Q | [列表](https://boficial.neuquen.gov.ar/) | 法规/es | 未见声明 | robots未知 HTTP0 | 列表未明示 | 目录未见 | robots未知 HTTP0；robots TLS证书链校验失败，未跳过校验。 |
| X019 Salta · 官方公报入口 | AR-A | [列表](https://boletinoficialsalta.gob.ar/) | 法规/es | 未见声明 | 404无规则 | 列表未明示 | 法规已有 AR-007 | 可读；HTTP200但原始HTML仅导航框架，没有期次列表；待定位公开列表。 |
| X020 San Juan · 矿业部新闻iframe | AR-J | [列表](https://mineria.sanjuan.gob.ar/index.html) | 新闻/es | 未见声明 | 首页允许；新闻iframe禁止 | 未取得 | 目录未见 | 受阻；矿业部首页可读但新闻依赖feed.mikle.com iframe；该iframe robots禁止；不重抓。 |
| X021 CALBAMERICA·锂协会候选 | AR | [列表](https://www.calbamerica.org/) | 公告/es | 未见声明 | 404无规则 | 列表未明示 | 目录未见 | 页面可打开但未定位有效更新列表/仅去重线索；机构首页可打开，但未定位带日期更新列表，列待补目录 |
| X022 CASEMI San Juan·供应商协会候选 | AR-J | [列表](https://camaraminerasanjuan.com.ar/) | 新闻/es | 未见声明 | robots未知 HTTP0 | 未取得 | 目录未见 | robots未知 HTTP0；robots连接失败 |
| X023 CIDMEJU·研究新闻候选 | AR-Y | [列表](https://cidmeju.unju.edu.ar/noticias.php) | 新闻/es | 未见声明 | robots未知 HTTP0 | 未取得 | 目录未见 | robots未知 HTTP0；搜索索引存在，robots连接失败；不按可抓处理 |
| X024 CMSalta·萨尔塔矿业商会 | AR-A | [列表](https://cmsalta.com.ar/) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | 页面可打开但未定位有效更新列表/仅去重线索；可打开但Noticias区静态未返回新闻条目；需后续定位可用列表 |
| X025 Cámara Minera de Jujuy·新闻 | AR-Y | [列表](https://camaramineradejujuy.com.ar/) | 新闻/es | 未见声明 | 允许 | 未取得 | 目录未见 | robots允许但Crawl-delay3600秒，未GET列表；robots允许但Crawl-delay为3600秒；未等待1小时、未GET列表，保留附录 |
| X026 UNCA·大学新闻候选 | AR-K | [列表](https://www.unca.edu.ar/) | 新闻/es | 未见声明 | robots未知 HTTP0 | 未取得 | 目录未见 | robots未知 HTTP0；robots访问失败，未GET页面 |
| X027 UNJu工程学院·综合新闻候选 | AR-Y | [列表](https://www.fi.unju.edu.ar/noticias/generales.html) | 新闻/es | 未见声明 | robots未知 HTTP0 | 未取得 | 目录未见 | robots未知 HTTP0；robots访问失败，未GET页面 |
| X028 CNV·AIF入口 | AR | [列表](https://www.cnv.gov.ar/SitioWeb/Home/AIF) | 公告/es | 未见声明 | 404无规则 | 未明示 | 目录未见 | 可读；页面为登录/注册说明，未获得公开公告列表；不登录 |
| X029 BHP·新闻稿候选 | AR-J | [列表](https://www.bhp.com/news/media-centre/releases) | 公告/en | 未见声明 | robots未知 HTTP403 | 未取得 | 目录未见 | robots未知 HTTP403；robots403，未GET列表；Vicuña合资伙伴；[项目/关系依据](https://www.bhp.com/-/media/documents/investors/shareholder-information/2025/251023_bhpagmchairandceoaddress.pdf) |
| X030 Fortuna Mining·新闻候选 | AR-A | [列表](https://fortunamining.com/news/) | 公告/en | 未见声明 | 允许 | 未取得 | 目录未见 | 验证或拒绝页；列表返回验证页，停止；Lindero项目 |
| X031 Galan Lithium·ASX公告候选 | AR-K | [列表](https://relait.galanlithium.com.au) | 公告/en | 未见声明 | robots未知 HTTP307 | 未取得 | 目录未见 | robots未知 HTTP307；跳转relait主机后robots307未知；Hombre Muerto West/Candelas；[项目/关系依据](https://galanlithium.com.au/projects/hombre-muerto-west/) |
| X032 Galan Lithium·西语资源资料 | AR-K | [列表](https://galanlithium.com.au/es/recursos/) | 数据/es | [声明1](https://galanlithium.com.au/es/feed/)、[声明2](https://galanlithium.com.au/es/comments/feed/) | 允许 | 静态列表未明示 | 目录未见 | 页面可打开但未定位有效更新列表/仅去重线索；页面可打开但仅资源/公告区标题与导航，未返回实际目录条目；附录待定位，不算已核有效列表；[项目/关系依据](https://galanlithium.com.au/argentina/) |
| X033 Lake Resources·投资公告候选 | AR-K | [列表](https://investorhub.lakeresources.com.au/announcements) | 公告/en | 未见声明 | robots未知 HTTP429 | 未取得 | 目录未见 | robots未知 HTTP429；robots429；Kachi项目 |
| X034 Lithium Americas·当前新闻 | AR | [列表](https://www.lithiumamericas.com/news/default.aspx) | 公告/en | 未见声明 | 允许 | 静态列表未明示 | 目录未见 | 页面可打开但未定位有效更新列表/仅去重线索；现时北美主体；2023拆分后阿根廷资产属Lithium Argentina，只作旧名去重线索，附录不作现时阿根廷矿企；[项目/关系依据](https://lithiumamericas.com/news/news-details/2023/Lithium-Americas-Closes-Separation-to-Create-Two-Leading-Lithium-Companies/default.aspx) |
| X035 Lithium Argentina·IR新闻候选 | AR-Y/AR-A | [列表](https://investors.lithium-argentina.com/news-events/news-releases) | 公告/en | 未见声明 | robots未知 HTTP403 | 未取得 | 目录未见 | robots未知 HTTP403；robots403，未GET列表；Cauchari-Olaroz/PPG；旧Lithium Americas阿根廷资产已拆分；[项目/关系依据](https://www.lithium-argentina.com/company) |
| X036 Lithium South·新闻候选 | AR-A | [列表](https://www.lithiumsouth.com/news/) | 公告/en | 未见声明 | robots未知 HTTP301 | 未取得 | 目录未见 | robots未知 HTTP301；robots301未知，未GET列表；HMN项目已披露出售给POSCO，历史公司源 |
| X037 Pan American Silver·新闻候选 | AR-Z/AR-U | [列表](https://www.panamericansilver.com/news/) | 公告/en | 未见声明 | robots未知 HTTP301 | 未取得 | 资讯已有 exp-20261014-pan-american-silver | robots未知 HTTP301；robots301未知，未GET列表；Cerro Moro/Navidad等项目 |
| X038 SEDAR+·申报文件入口 | AR | [列表](https://www.sedarplus.ca/home/) | 公告/en/fr | 未见声明 | 允许 | 门户未明示 | 目录未见 | 页面可打开但未定位有效更新列表/仅去重线索；真实申报门户，非限定发行人列表；未登录、未提交交互检索，列待定位目录 |
| X039 天齐锂业·新闻候选 | AR | [列表](https://www.tianqilithium.com/news/) | 新闻/zh | 未见声明 | 禁止 | 未取得 | 目录未见 | 禁止；中文所试新闻路径与英文正式新闻目录均被各自主机robots禁止，未GET列表；官方2022年YPF合作备忘录仅作合作线索，未核得现有阿根廷自有矿山，不把Olaroz竞品介绍当其项目；[项目/关系依据](https://en.tianqilithium.com/content/details17_925.html) |
| X040 深交所·上市公司公告候选 | AR | [列表](https://www.szse.cn/disclosure/listed/bulletin/index.html) | 公告/zh | 未见声明 | robots未知 HTTP0 | 未取得 | 目录未见 | robots未知 HTTP0；robots连接失败，未GET列表；赣锋/天齐/中伟等可由Claude后续圈选 |
| X041 MINING.COM·拉美 | AR | [列表](https://www.mining.com/region/latin-america/) | 新闻/en | 未见声明 | robots未知 HTTP403 | 列表未明示 | 同域异栏 mining-com-news | robots未知 HTTP403；拉美区域/国际媒体，栏目可能含非AR内容 |
| X042 Rumbo Minero | AR | [列表](https://www.rumbominero.com/category/argentina/) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | 验证或拒绝页；拉美区域/国际媒体，栏目可能含非AR内容；两候选在首个挑战结果返回前已排队，观察到挑战后停止该主机 |
| X043 Rumbo Minero | AR | [列表](https://www.rumbominero.com/) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | 验证或拒绝页；拉美区域/国际媒体，栏目可能含非AR内容；两候选在首个挑战结果返回前已排队，观察到挑战后停止该主机 |
| X044 CBA24N·经济 | AR-X | [列表](https://www.cba24n.com.ar/economia) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | HTTP404；该入口受阻/旧路径，正确公开栏目另列 |
| X045 El Ancasti | AR-K | [列表](https://www.elancasti.com.ar/economia) | 新闻/es | [声明](https://www.elancasti.com.ar/contenidos/rss.html（未另取目录/feed）) | 允许 | 列表未明示 | 同域异栏 sa5-ar-ancasti | HTTP404；该入口受阻/旧路径，正确公开栏目另列 |
| X046 LM Neuquén | AR-Q | [列表](https://www.lmneuquen.com/economia) | 新闻/es | [声明](https://www.lmneuquen.com/contenidos/rss.html（未另取目录/feed）) | 允许 | 列表未明示 | 目录未见 | HTTP404；该入口受阻/旧路径，正确公开栏目另列 |
| X047 La Opinión Austral·政治与经济 | AR-Z | [列表](https://www.laopinionaustral.com.ar/) | 新闻/es | 未见声明 | robots未知 HTTP301 | 列表未明示 | 目录未见 | robots未知 HTTP301；该入口受阻/旧路径，正确公开栏目另列 |
| X048 Noticias Argentinas | AR | [列表](https://www.na.com.ar/economia) | 新闻/es | 未见声明 | robots未知 HTTP0 | 列表未明示 | 目录未见 | robots未知 HTTP0； |
| X049 Noticias Argentinas | AR | [列表](https://www.noticiasargentinas.com/economia) | 新闻/es | 未见声明 | robots未知 HTTP301 | 列表未明示 | 目录未见 | robots未知 HTTP301； |
| X050 Nueva Rioja·经济 | AR-F | [列表](https://www.nuevarioja.com.ar/economia/) | 新闻/es | 未见声明 | 允许 | 列表未明示 | 目录未见 | HTTP404；该入口受阻/旧路径，正确公开栏目另列 |
| X051 Puntal·经济 | AR-X | [列表](https://www.puntal.com.ar/economia) | 新闻/es | [声明](https://www.puntal.com.ar/contenidos/rss.html（未另取目录/feed）) | 允许 | 列表未明示 | 目录未见 | HTTP404；该入口受阻/旧路径，正确公开栏目另列 |
| X052 Sitio Andino·经济 | AR-M | [列表](https://www.sitioandino.com.ar/economia) | 新闻/es | [声明](https://www.sitioandino.com.ar/contenidos/rss.html（未另取目录/feed）) | 允许 | 列表未明示 | 同域异栏 sa5-ar-sitioandino | HTTP404；该入口受阻/旧路径，正确公开栏目另列 |
| X053 Datos Argentina·矿业数据集 | AR | [列表](https://datos.gob.ar/dataset/?organization=secretaria-de-mineria) | 数据/es | 未见声明 | robots未知 HTTP500 | 未明示 | 目录未见 | robots未知 HTTP500；robots HTTP500，未请求列表 |
| X054 INDEC·COMEX外贸查询 | AR | [列表](https://comex.indec.gob.ar/) | 数据/es | 未见声明 | 404无规则 | 未明示 | 目录未见 | 可读；200仅应用标题，静态未给查询/数据列表；需浏览器适配 |
| X055 INDEC·技术报告目录 | AR | [列表](https://www.indec.gob.ar/indec/web/Institucional-Indec-InformesTecnicos-37) | 数据/es | 未见声明 | 允许 | 未明示 | 目录未见 | 可读；200仅通用导航壳，未得到报告列表；保留待定位 |
| X056 SEGEMAR·地质矿业知识库 | AR | [列表](https://repositorio.segemar.gov.ar/) | 数据/es | 未见声明 | robots未知 HTTP0 | 未明示 | 目录未见 | robots未知 HTTP0；robots连接失败，未读取知识库列表 |
| X057 矿业秘书处·统计研究系列 | AR | [列表](https://www.argentina.gob.ar/economia/mineria/informes-y-estudios-sobre-mineria/serie-de-estudios-estadisticos) | 数据/es | 未见声明 | 允许 | 未明示 | 同域异栏 AR-002, ar-presidencia-noticias, sa5-ar-anpyn-news 等 | HTTP403；实际HTTP403，错误正文显示500；本轮不重试 |

## 实际检查记录

本轮新核采样：UTC 2026-11-13 03:39:06 至 2026-11-13 03:49:49；0635 复用证据最早为 UTC 2026-11-13 01:07:17。页面可用性和更新日期是该采样时点的记录。
网络核验原始响应缓存、每批 probe、分组元数据、归一结果和汇总保存于临时证据目录 `aimine-task0641-evidence`；0635 原件沿用 `aimine-task0635-candidates-20261112`。每个缓存以 URL 的 SHA256 命名并带 UTC 时间、HTTP 状态、robots 响应、列表声明/链接；本仓库只保存本卡与此清单。
网络纪律偏差：初始 www.argentina.gob.ar 两次相邻列表请求开始间隔为 3 秒与 2 秒，低于该站 10 秒 Crawl-delay；随后修正共享主机锁，后续按 10 秒执行。SSR 旧 IR 正常跳转从 HTTPS 转到 HTTP，辅助探测随 Location 在同一主机两种协议下各读一次 robots，并取到旧列表404；现已停源，不再续读。两处偏差保留，不能写为全程零偏差。
离线复核：全部必填字段、归一 URL 唯一、A–G/十一省覆盖、主清单无 robots 未知/禁止、日期待处理标记为零、分组和总数对账。任务卡、文档 strict 与提交前 quick check 的实际结果见任务卡交付记录；最终完整 CI 仍由 PR 回执确认。
质量异常逐行保留：Once Diario、San Juan Minero、Latinominería 含博彩或无关外链；部分旧栏目停在 2019/2021/2025 年；乱码、动态列表与日期缺失尚需逐源预览处理。财经综合栏目未由本线筛掉，取舍交 Claude；不新建后续任务，不改目录配置或生产。
