# ADR-0031：按实际文章量重切九类分类，退役代码继续可用

- 状态：【Owner 决定】已接受（Owner，2026-11-05，出处：`docs/00-decision-ledger.md` “DEC-78补充·五项决定与降本原则”第 2 条；方案 `docs/design/taxonomy-scoring-202611/README.md` 第二节）。实现与上线分别验收。
- 类别：Owner 决定 + 工程落地
- 日期：2026-11-05
- 决策者：Owner（分类重切）；Claude（代码、迁移脚本与兼容口径）
- 关联规格：DR-100、DR-89、BR-ENR-14、DEC-78、ADR-0022
- 取代：ADR-0022 第 1 条的九类表（稳定代码与中文名）；ADR-0022 第 3 条“旧键一律归一为 null”对本 ADR 列出的退役代码不再适用。

## 背景

线上 7115 篇资讯里，“企业与项目”占三成，选它等于没筛；贸易、安全两类各约 2%，单独筛出来几乎是空页；15% 的文章没有分类，多是会议、致辞、访谈、行情评论和人事。Owner 同意仍用 9 类、按实际文章量重新切分（方案第二节），新文章由模型按新分类归类，历史文章用脚本重分类：能直接换算的不调模型，需要重分的按脚本预估的调用数执行。分类代码出现在网址、RSS、公开 API 与 MCP 里，已有链接和订阅不能因此失效。

## 决定

1. 新九类按以下代码与顺序公开。含义不变或只扩大、旧稿件全部仍属于该类的，保留原代码（五类），其历史不用处理：

| 代码 | 显示名 | 来自 |
|---|---|---|
| `policy_regulation` | 政策监管 | 政策监管 + 供应链、贸易与制裁 |
| `operations_output` | 生产经营 | 企业与项目（一部分）（新代码） |
| `project_development` | 项目建设 | 企业与项目（一部分）（新代码） |
| `exploration_resource` | 勘探资源 | 勘探与资源 |
| `capital_ma` | 并购融资 | 投资并购（扩大到融资配售、上市、包销） |
| `commodity_market` | 市场价格 | 商品与市场（含行情评论） |
| `technology_processing` | 技术装备 | 技术与冶炼（扩大到装备、数字化） |
| `safety_environment` | 安全环境 | 矿山安全 + ESG、社区与劳工（新代码） |
| `events_opinion` | 会议观点 | 新增：会议论坛、致辞、访谈、研报观点、人事（新代码） |

2. 退役四个代码，映射固定在 `packages/contracts/src/mining-taxonomy.ts`：

| 退役代码 | 作筛选时 | 历史稿件 |
|---|---|---|
| `supply_trade_controls` | `policy_regulation` | 直接换算，不调模型 |
| `esg_community_labor` | `safety_environment` | 直接换算，不调模型 |
| `safety_incident` | `safety_environment` | 直接换算，不调模型 |
| `company_project` | `operations_output` 与 `project_development` 两类合并 | 由结构化步骤按新分类重判 |

3. 网址 `?category=`、`/feed/category/<代码>.xml`、`/feed/full/category/<代码>.xml`、`/api/site/*`、`/api/v1/*`、`/api/v3/*`、`/api/v1/agent/*` 与 MCP 的分类参数继续接受退役代码；一对一的换成新代码（网页 301 跳转），`company_project` 按两类合并筛选。所有回答只用新代码；筛选回显（`filters.category`）保留请求里的 `company_project`。
4. 发布投影（`toPublicApiCategory`）把一对一的退役代码换成新代码，`company_project` 在重判前不显示分类；分析原件里的旧代码由脚本改写，改写前后都留记录（`output.categoryReclassification`：原代码、新代码、方式、结构化配方与回执）。公开标签第一个固定为当前分类的中文名，旧名（含 2026-10-05 的改名）不再出现在公开数据里；人工设置的标签与分类一律不动。
5. 历史稿件由 `scripts/reclassify-categories.ts` 处理：默认只读统计；`--apply-mapped` 只写直接换算、不调模型，并重新发布仍带旧代码或旧名的稿件；`--apply-model --limit N` 只对公开的“企业与项目”和无分类稿件重跑结构化步骤，经同一模型路由、材料许可、处理暂停、请求次数控制与回执，已付费的同输入回执直接复用，可分批反复执行。
6. 评分类型与展示分类仍是同一套代码；权重表覆盖新九类（`industry/selection.ts`）。“会议观点”用 AIHOT 观点类权重 [1, 3, 1, 4, 1]，并标为评论性：日报不把它算作新进展，当天有其他新事实时只在多源报道时进正文。
7. 公开契约按破坏性变更处理：public OpenAPI 0.2.0 → 0.3.0，后台 0.3.0 → 0.4.0，`/api/v3` 文档 3.0.0 → 3.1.0（路径不变：旧筛选值仍被接受，v3 的 `category.code` 本就是字符串），`reference/public-v1.openapi.json` 2.0.0 → 2.1.0（其分类字段已声明“客户端须容忍新值”）。

## 后果

- 好处：最大一类约 21%，最小不低于 8%，不再有大量无分类稿件；旧链接、旧订阅和外部调用不失效。
- 代价：评分与结构化提示词版本随之变化，部署须把 `SELECTION_CONFIRMED_VERSION` 换成新的评分版本；“企业与项目”和无分类的公开稿件要各调一次结构化模型，重判前“企业与项目”稿件公开时不显示分类。
- 需要同步的规格 / 契约 / 检查：`docs/01-product/09-glossary.md` 第 3 节、`06-content-standards.md` DR-100 与 DR-89 栏目表；`reference/contracts/*` 重新生成；`tests/category-recut.test.ts`、`tests/mining-taxonomy.test.ts`、`scripts/verify/tests/mining-taxonomy.test.ts`。

## 推翻条件

无（Owner 决定）。分类口径再变，另立 ADR；本 ADR 的退役代码映射不随之删除，除非确认外部已无调用。

## 备选方案

| 方案 | 为什么没选 |
|---|---|
| 九个代码全部换新 | 含义没变的五类也要改写历史、外部链接全部变成旧值，没有收益 |
| 退役代码直接 404 或归为 null | 旧链接、RSS 订阅和外部代理立即失效 |
| “企业与项目”按关键词拆成两类 | 不可靠，违反“模型负责内容判断，不逐条补规则”（DEC-77） |
| 全量重跑整套分析 | 评分、写作与归组都会重付费，并可能改变已公开的分数与精选 |
