# 阿根廷官方来源30天覆盖核对

窗口为2026-09-23至2026-10-22，含首尾30个阿根廷自然日（UTC−3）；本轮目录取证于2026-10-23当地00:24—00:31。结果来自实际官方目录，不以搜索命中充当全量分母。结构化记录见[argentina-source-window.json](argentina-source-window.json)，每行保留标题、原链接、原始日期及其语义、目录类别、主题候选、排除理由、页面SHA-256和系统状态。

**已完成国家公报第一部分的限定目录窗口：官方日历列21个出版日、9个无出版日，无补刊；逐日声明与实取均为1,460条。** 这里的分母是目录条目，不是1,460个矿业事件、独立规则或生效法律。矿业秘书处新闻栏目窗口内0条；ARCA VUCE页面20行、19个不同主链接，确认1条窗口内矿业执行节点，但该整理页不能证明ARCA全部法规的窗口完整性。[BORA第一部分](https://www.boletinoficial.gob.ar/seccion/primera)、[矿业秘书处新闻](https://www.argentina.gob.ar/economia/mineria/noticias)、[VUCE规范目录](https://www.arca.gob.ar/vuce/ayuda/normativa.asp)

本轮未读取当前生产发现与处理结果，因此全部记录的`system_discovery`、`system_processing`均为`unknown`；不计算当前系统召回率、漏收率或处理成功率。

## 1. 三渠道实际结果与完整性

| 渠道 | 实际取得 | 窗口结论 | 明确边界 |
|---|---:|---|---|
| 国家矿业秘书处新闻 | 前2页共32条，日期逐项降序；第一页最新2026-09-01，第二页最新2025-05-12 | 已越过窗口下界，该新闻栏目窗口内0条 | 不能由此推断国家没有矿业规则或项目进展；没有遍历整站，也没有把旧新闻当新公告 |
| ARCA VUCE规范整理页 | 20行、19个不同主链接，另保留1个附件链接；无分页入口 | RG5909/2026于10月5日公报发布，属于窗口；RG5892/2026公报日期8月31日，排除 | 其余多数行只有链接中的签发日期，不能把它当公报日期；页面没有宣称覆盖全部ARCA规范 |
| BORA第一部分 | 21个日目录，2天另有续页，合计1,460条 | 日期、逐日栏目总数、URL去重及续页终止均已核对 | 只证明本次可见第一部分目录窗口；不覆盖第二至第四部分、省级公报、条文修订沿革或未公开文件 |

矿业栏目32条全部因发布日期早于窗口被排除，作为日期边界证据保留。两页均使用实际目录的`time`字段；显示日期按原日历日保存，未补时区或把抓取时间当发布时间。[第一页](https://www.argentina.gob.ar/economia/mineria/noticias)、[第二页](https://www.argentina.gob.ar/node/293071/noticias?page=1)

VUCE有一处必须阻止自动归一的目录问题：显示“Resolución General N° 5888/2026”的行实际链接`n:5859`，与下面5859/2026行指向同一URL。该行登记为`identity_conflict`，不能按显示标题制造5888材料，也不能把两行算两个法规。5909链接中的`01/10/2026`为签发日，公报日为10月5日；5892对应签发8月27日、公报8月31日。[VUCE目录](https://www.arca.gob.ar/vuce/ayuda/normativa.asp)、[5909官方元数据](https://biblioteca.arca.gob.ar/search/query/norma.aspx?p=t:RAG%7Cn:5909%7Co:9%7Ca:2026%7Cf:01/10/2026)、[5892官方元数据](https://biblioteca.arca.gob.ar/search/query/norma.aspx?p=t:RAG%7Cn:5892%7Co:9%7Ca:2026%7Cf:27/08/2026)

### BORA逐日闭合结果

| 阿根廷日期／官方目录 | 声明数＝实取数 | 续页 |
|---|---:|---|
| [09-23](https://www.boletinoficial.gob.ar/seccion/primera/20260923) | 49 | 首屏齐全 |
| [09-24](https://www.boletinoficial.gob.ar/seccion/primera/20260924) | 75 | 首屏齐全 |
| [09-25](https://www.boletinoficial.gob.ar/seccion/primera/20260925) | 67 | 首屏齐全 |
| [09-28](https://www.boletinoficial.gob.ar/seccion/primera/20260928) | 86 | 首屏齐全 |
| [09-29](https://www.boletinoficial.gob.ar/seccion/primera/20260929) | 51 | 首屏齐全 |
| [09-30](https://www.boletinoficial.gob.ar/seccion/primera/20260930) | 68 | 首屏齐全 |
| [10-01](https://www.boletinoficial.gob.ar/seccion/primera/20261001) | 102 | 首屏100＋续页2；再下一页0、明确结束 |
| [10-02](https://www.boletinoficial.gob.ar/seccion/primera/20261002) | 70 | 首屏齐全 |
| [10-05](https://www.boletinoficial.gob.ar/seccion/primera/20261005) | 73 | 首屏齐全 |
| [10-06](https://www.boletinoficial.gob.ar/seccion/primera/20261006) | 69 | 首屏齐全 |
| [10-07](https://www.boletinoficial.gob.ar/seccion/primera/20261007) | 88 | 首屏齐全 |
| [10-08](https://www.boletinoficial.gob.ar/seccion/primera/20261008) | 60 | 首屏齐全 |
| [10-09](https://www.boletinoficial.gob.ar/seccion/primera/20261009) | 81 | 首屏齐全 |
| [10-13](https://www.boletinoficial.gob.ar/seccion/primera/20261013) | 56 | 首屏齐全 |
| [10-14](https://www.boletinoficial.gob.ar/seccion/primera/20261014) | 78 | 首屏齐全 |
| [10-15](https://www.boletinoficial.gob.ar/seccion/primera/20261015) | 55 | 首屏齐全 |
| [10-16](https://www.boletinoficial.gob.ar/seccion/primera/20261016) | 55 | 首屏齐全 |
| [10-19](https://www.boletinoficial.gob.ar/seccion/primera/20261019) | 106 | 首屏100＋续页6；再下一页0、明确结束 |
| [10-20](https://www.boletinoficial.gob.ar/seccion/primera/20261020) | 61 | 首屏齐全 |
| [10-21](https://www.boletinoficial.gob.ar/seccion/primera/20261021) | 52 | 首屏齐全 |
| [10-22](https://www.boletinoficial.gob.ar/seccion/primera/20261022) | 58 | 首屏齐全 |
| 合计 | **1,460** | 两个首屏之外共补8条 |

无出版日期为09-26、09-27、10-03、10-04、10-10、10-11、10-12、10-17、10-18，依据官网内嵌日历，不按“周末或节假日应该休刊”猜测。续页使用目录公开脚本中的`/seccion/actualizar/primera?pag=…&ult_rubro=…`，保持新建匿名浏览会话的所选日期；重取首页先比较全部100个URL未变化，续页每项再核日期及去重。第二页虽不足100条，接口仍返回`hay_mas_datos=true`，因此两天均继续取到第三页明确为false才结束。匿名会话临时文件已删除。

## 2. 经营主题覆盖矩阵

以下是**目录题名/发布机关的初筛候选数**，不是已经确认与矿业有关的数量，更不是精选标准或人工金标。同一条矿业秘书处81/2026因具体事项未知，同时列入三个待核方向，不能把各列相加当独立事件数。没有关键词的941条仍保留`unknown_from_directory_metadata`，未静默排除。

| 经营主题 | BORA目录实际线索 | 本轮能确认什么 | 仍缺什么 |
|---|---|---|---|
| 矿权与许可 | 1条矿业机关候选：9月25日秘书处81/2026 | 发布机关和文号真实存在；目录没有给出事项 | 不能把81号直接定为矿权许可；省级矿权目录未纳入本轮，覆盖仍有明确空白 |
| 环保与社区 | 1条明确环境主题为9月29日任命环境副国务秘书，排除实质规则样本后0条 | 可依据题名排除这条人事任命 | 0只代表本次目录元数据未确认实质项；环境许可、地方听证、社区及省级原件未核 |
| 劳动与安全 | 256条劳动/工伤机关或栏目候选，其中SRT机关11条 | 可定位SRT第49、50、51、53/2026号决议及第9/2026号处分 | 集体协议适用行业、工伤规则内容及矿业影响须核原件；不能将256条全部推送 |
| 财税、海关与外汇 | 262条候选，其中明确题名涉矿1条：5909/2026；另有央行通讯 | 5909是窗口内真实矿业用途声明节点，BORA与VUCE为同一原件的两处发现入口 | 央行通讯并非一律外汇规则，ARCA机关也包含人事/拍卖；逐件适用性仍未知 |
| 投资与项目 | 1条81/2026待核方向；矿业新闻栏目窗口内0条 | 不能据新闻栏目静默判断项目无进展 | RIGI审批、企业披露及省级项目目录未在此三渠道窗口中形成完整分母 |

具体复核入口：[矿业秘书处81/2026](https://www.boletinoficial.gob.ar/detalleAviso/primera/347966/20260925)、[环境人事任命1119/2026](https://www.boletinoficial.gob.ar/detalleAviso/primera/348110/20260929)、[SRT49/2026](https://www.boletinoficial.gob.ar/detalleAviso/primera/348071/20260928)、[SRT50/2026](https://www.boletinoficial.gob.ar/detalleAviso/primera/348412/20261002)、[SRT51/2026](https://www.boletinoficial.gob.ar/detalleAviso/primera/348573/20261006)、[SRT53/2026](https://www.boletinoficial.gob.ar/detalleAviso/primera/348985/20261015)、[ARCA5909/2026](https://www.boletinoficial.gob.ar/detalleAviso/primera/348497/20261005)、[BCRA通讯A8486/2026](https://www.boletinoficial.gob.ar/detalleAviso/primera/348380/20261001)。链接仅供回到官方原件；本轮分类依据仍限已保存的目录元数据。

## 3. 与现有登记和历史样本对照

Git基线`6d08c14b388f75befd75e297ec17227661527c92`的`industry/sources.json`仅找到`sa5-ar-mineria`这条相关官方资讯入口，登记为`web_list/news/enabled=false`；未找到ARCA或BORA的news配置。这是Git种子，不代表生产现在停用或没有经后台新增的来源。

`industry/policy-sources.json`另有AR-001国家公报、AR-004电子图书馆，静态状态为ready、条款为restricted；AR-003央行与AR-005卡塔马卡公报为blocked。它们属于法规登记，本轮不因该目录可读就恢复暂停中的policy流程，也不把ready当作当前持续产出。

将**Git AR-001原有选择器**离线应用于本轮完整1,460条目录，只选中821条，排除639条。题名/机关初筛中的劳动候选248条、财税/央行候选207条落在排除部分：该选择器在官方公告、集体协议等栏目之前截断。此行为可以解释“复用法规目录配置”为什么不能直接承诺覆盖全部经营主题；不能把639条叫作当前漏收、应精选或应群发。配置没有在本轮改变，离线结果保存在`git-policy-selector-check.json`。

历史[D05](evidence.md)在2026-10-22 22:28:04 UTC查询到5909原件在当时news articles为0条，且当时未发现ARCA/BORA的news入口。本轮重新从官方日目录和VUCE目录确认该节点存在，但**没有重新查询系统是否已发现或处理**。所以当前状态仍为unknown；9月1日官方新闻和10月媒体解读不能替代这份执行文件，但也不能因此重发历史稿或重复记作三个独立事件。

## 4. 可交给开发Agent的来源候选与验证输入

| 候选 | 可直接使用的入口与解析证据 | 接入前必须解决的具体问题 | 固定验收样例 |
|---|---|---|---|
| ARCA VUCE元数据观察 | `https://www.arca.gob.ar/vuce/ayuda/normativa.asp`；行`main article > ul.list-interline > li`，主链接取直属`a[href]`，标题取链接文字；20行 | 链接签发日与公报日分开；文号冲突阻止归一；旧AFIP HTTP链接不自动降级访问；图书馆robots返回不可用HTML，未继续自动抓正文 | 5909发现一次、与BORA348497归同原件；5888→5859冲突保留；5892公报日8月31日排除窗口；1-E/2017附件不是新增法规 |
| BORA第一部分资讯线索 | `https://www.boletinoficial.gob.ar/seccion/primera/YYYYMMDD`；公开出版日历、栏目声明数、`#avisosSeccionDiv`及`a:has(.linea-aviso)`；URL末段为公报日期 | 按匿名会话保持日期并续页到结束，校验每页日期、总数、唯一ID；不能采用首屏100条或复制AR-001栏目截断；发现入口和后续许可分别登记 | 10月1日102、10月19日106、两天第三页空且结束；5909/2026在10月5日；10月12日官网无出版日；不访问robots禁止的第二部分 |
| 现有矿业新闻入口 | 复用`sa5-ar-mineria`现有选择器及源地址；实取两页32条日期降序 | 先核生产是否已经启用，不能根据Git false重复新建；目录0新增不能作为失败或监管内容完整证明 | 最新9月1日不进入本窗口；6月改革和2025年消息保持旧日期；页面无新增时如实返回0 |

三项均为候选或既有配置复核，**未启用、未创建来源、未恢复法规任务、未设置外部模型或全文保存用途**。正式接入以当前许可登记为准：本轮可读只证明取得目录元数据，不能替代外部模型处理、全文保存或全文公开许可。无需新增付费服务来完成这批元数据验证。

BORA第一部分和VUCE适合先形成可审核线索；矿权、环保社区与具体投资项目仍需省级或相应专项原始目录。下一份覆盖任务可复用本窗口格式，但不能在本次结果中把未查省份、央行独立目录或ARCA全部规范标为已覆盖。

## 5. 证据、校验与交付边界

- 结构化成果共1,512行：BORA1,460＋矿业栏目32＋VUCE20。BORA窗口分母为1,460；额外52行用于来源整理页和日期边界，不混入BORA召回分母。
- 原始证据仅在`.verify/argentina-source-20261023/`：30个纳入条目校验的目录响应，另有日历入口响应、请求时间/状态/哈希、官方robots、解析脚本与验证结果。每个结构化条目直接带`page_sha256`，可回查`directory_pages`对应原页；`calendar_evidence`保留官方日历入口hash，`access_checks`保留robots状态。
- `extract-window.mjs`逐页重算SHA-256，断言日历为21天、日期吻合、逐日唯一URL数等于声明数、两次续页终止、两次会话首页成员未变、总数1,460及成果1,512行；结果为通过，记录在`window-validation.json`。只验证目录枚举和记录一致性，不伪装成矿业内容质量验收。
- 通过系统curl执行正常TLS验证；Python本地证书链缺失仅记录为工具环境失败，没有关闭证书检查。Argentina robots的10秒间隔得到遵守；BORA第一部分不在禁爬范围，未进入被禁止的第二部分；ARCA robots为404；图书馆robots转到不可用HTML，其后没有继续自动读取单件全文。没有403绕过、付费、登录、验证码处理或代理切换。
- 本轮没有保存单件新闻/法规全文，没有读取生产、现有秘密或评分留出集，没有模型调用、外发通知或来源启用。正式账本/处理状态和人类质量判断不在此成果中。
