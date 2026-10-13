# 第二轮独立功能对照：读者与公开出口

冻结新库：`6996788c58347fa2483edc8e7d9e916292b20885`；旧库：`65d362407226da856f66477807c5437acf1af27b`。

共 36 项：保留 20，有据变更 7，遗漏 5，待核实 4。这些是冻结代码的行为判断，不代表线上或手机验收。

## 需要修复的具体缺项

- **F2-RDR-013 · P2 · 开放许可链接与来源官网最新法律信息**：新 readerAttribution 无条件把 license.url 与 legalUrl 设为 null，前端虽保留链接槽位，但公开投影永远不能产生链接。不是框架差异。
  - 影响：读者无法直接核验许可及来源的当前法律说明。
  - 复现场景：给来源登记开放许可名称及 supporting evidence.url，发布一篇允许站内全文的文章；其 item.attribution.license.url 与 legalUrl 固定为 null，正文只显示许可文字，不出现旧站可点的许可/官网法律信息链接。
- **F2-RDR-018 · P2 · 事件对象收藏与收藏列表解析**：旧 story URL 复用条目详情，故旧收藏不是独立事件类型；现行规格明确新增事件收藏。新状态类型声明 story，但事件页无收藏控件，收藏页仅解析 item 并加载 PolicySavedList。
  - 影响：读者无法把关注事件加入稍后阅读清单。
  - 复现场景：打开 /story/{publicId}，无法找到收藏事件按钮。即使本机写入 type='story' 的合法引用，/starred 总数会计入该引用，却无事件行及移除入口。
- **F2-RDR-027 · P2 · 事件与报告详情的复制链接、手机系统分享**：条目页有分享与复制，事件和报告详情渲染树没有相应控件；旧站本身无这些控件，因此属于已要求新增能力缺项。
  - 影响：事件和报告缺少站内分享操作，手机需自行使用浏览器地址栏。
  - 复现场景：打开 /story/{publicId} 或 /daily/{date}，在桌面和手机操作区均找不到复制链接/分享；条目 /items/{id} 的更多菜单则有相应操作，可作为对照。
- **F2-RDR-033 · P2 · 公开v3 OpenAPI文档主域名可达**：API中已注册，但Web的API路径名单仅含openapi-v1。部署全部转Web，v3文档既不转发也无页面路由，因此落入404。已对冻结原函数做纯内存复现：isApiOwned('/openapi-v3.json')=false，v1文档与/api/v3/items为true。
  - 影响：外部调用者无法按公布路径取得v3接口定义；API直连测试可能掩盖该问题。
  - 复现场景：按仓库deploy/Caddyfile部署后请求主域名/openapi-v3.json；Web执行isApiOwned=false，经静态文件检查后进入SSR通用404。API进程直连该路径已注册，体现主入口分流遗漏。
- **F2-RDR-034 · P2 · Agent指南与llms.txt发现v3能力**：v3实现已存在，但指南主资源只列openapi-v1，描述及llms.txt的接口发现均指向v1；没有v3入口/示例，使用文档的客户端难以发现本轮新增接口。
  - 影响：v3已实现能力对从官方接入页开始的使用者不可发现；与文档路径404为两个独立环节。
  - 复现场景：阅读/agent的REST说明和/llms.txt，跟随提供的接口定义与端点只能发现v1；在冻结文件中检索/api/v3和openapi-v3均无命中。

## 方法与边界

- 新库仅git show/git grep/git ls-tree冻结SHA；未读取既有audit-remediation报告、任务交付结论或当前工作区实现。
- 旧库仅gh api固定ref在线只读；源码只进内存/标准输出，未clone、未下载源码落盘、未复制数据。
- 参照本次SHA下读者页、内容标准、时间与出口规格裁决有据变化；不比较框架、架构、代码风格，不用缺测试判断缺功能。
- 纯内存执行冻结http-policy.ts的isApiOwned/resolveRedirect；未启动服务、未访问数据库或生产、未读取秘密、未调用模型、未发送反馈。

- preserved表示所列细节在冻结代码中有对应实现，不等于线上/手机/内容质量验收。
- 未在真实运行环境覆盖所有边界；未知项明确uncertain。
- 事件收藏与事件/报告分享属于现行规格新增未落地，不冒称旧站已有独立同等能力。
- 本轮对公开v3/MCP只核查所列路径和内容门槛，不等于完整协议或所有字段验收。

## 逐项证据

### F2-RDR-001 · 桌面栏目与手机更多导航 · 保留

预期：原有内容与辅助栏目均可到达，法规动态按新规格增加独立入口。

结论：导航数据同时服务桌面与手机；日报高亮兼容周报/月报，更多覆盖法规等栏目。

旧库：[apps/web/components/reader/shell.tsx:24-38](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/shell.tsx#L24-L38)；[apps/web/components/reader/shell.tsx:195-247](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/shell.tsx#L195-L247)。

新库：[apps/web/app/components/shell/nav.ts:14-54](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/components/shell/nav.ts#L14-L54)；[apps/web/app/components/shell/MobileTabBar.tsx:5-32](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/components/shell/MobileTabBar.tsx#L5-L32)。

现行规格：[docs/01-product/03-reader-pages.md:400-414](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/03-reader-pages.md#L400-L414)。

### F2-RDR-002 · 深色、浅色、跟随系统与本机保存 · 保留

预期：三种外观可切换并跨刷新保存，默认跟随系统。

结论：三态、系统变化监听、首帧脚本均存在；未迁移旧键符合现行规则。

旧库：[apps/web/components/reader/shell.tsx:39-93](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/shell.tsx#L39-L93)。

新库：[apps/web/app/components/shell/ThemeSwitch.tsx:7-59](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/components/shell/ThemeSwitch.tsx#L7-L59)；[apps/web/app/lib/local-state.ts:169-195](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/lib/local-state.ts#L169-L195)。

现行规格：[docs/01-product/03-reader-pages.md:288-293](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/03-reader-pages.md#L288-L293)。

### F2-RDR-003 · 首页从全部动态改为精选、首个精选前回退动态 · 有据变更

预期：首页用精选，尚无任何精选时提供最新动态；不再保留旧精选占位页。

结论：旧首页全部动态、精选占位；DEC-13 明确改为首页精选与启动空态回退。

旧库：[apps/web/components/reader/pages.tsx:37-87](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L37-L87)。

新库：[apps/web/app/routes/home.tsx:17-87](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/home.tsx#L17-L87)。

现行规格：[docs/01-product/03-reader-pages.md:451-459](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/03-reader-pages.md#L451-L459)。

### F2-RDR-004 · 标题与摘要搜索、可分享搜索地址 · 保留

预期：搜索词保留在 URL，标题/摘要搜索覆盖全库而非当前页。

结论：默认搜索条件在分页 SQL 前生效；另有正文相关搜索入口，未把旧标题摘要能力丢失。

旧库：[apps/web/components/reader/feed.tsx:419-432](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/feed.tsx#L419-L432)；[services/live_pipeline/reader.py:740-755](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/reader.py#L740-L755)。

新库：[apps/web/app/routes/all.tsx:23-40](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/all.tsx#L23-L40)；[apps/web/app/features/feed/Filters.tsx:141-245](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/feed/Filters.tsx#L141-L245)；[packages/backend/src/publication/pool.ts:71-101](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/pool.ts#L71-L101)。

### F2-RDR-005 · 来源、日期、矿种与国家组合筛选控件 · 保留

预期：来源与日期筛选可用，条件共享 URL，改变条件重置分页；扩展国家/矿种。

结论：旧来源和日期控件保留，新增矿种与国家控件；本条只确认控件/传参，日期取值基准另见 F2-RDR-009。

旧库：[apps/web/components/reader/feed.tsx:444-509](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/feed.tsx#L444-L509)；[services/live_pipeline/reader.py:756-777](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/reader.py#L756-L777)。

新库：[apps/web/app/features/feed/Filters.tsx:263-327](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/feed/Filters.tsx#L263-L327)；[apps/web/app/routes/all.tsx:27-40](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/all.tsx#L27-L40)；[packages/backend/src/publication/pool.ts:159-166](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/pool.ts#L159-L166)。

### F2-RDR-006 · 页码、精确总数、上一页下一页及跳页 · 保留

预期：结果按页读取，地址带页码，越界跳页截到末页，保留筛选条件。

结论：前后页和跳页组件存在，服务端使用精确 count，无 50 页封顶。

旧库：[apps/web/components/reader/feed.tsx:237-309](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/feed.tsx#L237-L309)；[services/live_pipeline/reader.py:794-803](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/reader.py#L794-L803)。

新库：[apps/web/app/features/feed/DayList.tsx:89-146](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/feed/DayList.tsx#L89-L146)；[apps/web/app/routes/all.tsx:178-221](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/all.tsx#L178-L221)；[packages/backend/src/publication/pool.ts:179-191](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/pool.ts#L179-L191)。

### F2-RDR-007 · 北京日分组与会话内折叠 · 保留

预期：资讯按北京日展示，折叠后返回列表仍记住本次会话状态。

结论：新实现以路径和条件作为折叠保存键；按 timelineAt 北京日期分组。没有将日总条数跨页准确性纳入本条结论。

旧库：[apps/web/components/reader/feed.tsx:136-203](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/feed.tsx#L136-L203)。

新库：[apps/web/app/features/feed/DayList.tsx:25-83](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/feed/DayList.tsx#L25-L83)。

### F2-RDR-008 · 仅日期条目与列表时间轨的显示规则 · 有据变更

预期：详情保留只显示日期；列表按新时间线规则显示时刻或破折号，取消旧更新/本站公开徽标。

结论：现行 BR-TIME 明确沿用 AIHOT 时间轨；旧 fallback 徽标不再是保留目标。

旧库：[apps/web/lib/reader/preferences.ts:127-162](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/lib/reader/preferences.ts#L127-L162)；[apps/web/components/reader/pages.tsx:132-148](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L132-L148)。

新库：[apps/web/app/lib/format.ts:38-60](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/lib/format.ts#L38-L60)；[apps/web/app/routes/item.tsx:126-139](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/item.tsx#L126-L139)；[apps/web/app/features/feed/DayList.tsx:48-74](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/feed/DayList.tsx#L48-L74)。

现行规格：[docs/02-rules/04-time-semantics.md:215-225](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/02-rules/04-time-semantics.md#L215-L225)；[docs/02-rules/04-time-semantics.md:234-240](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/02-rules/04-time-semantics.md#L234-L240)。

### F2-RDR-009 · 日期筛选与今天时间线使用同一基准 · 待核实

预期：需先裁决现行规格内的时间线日期与来源日期两种定义；不能只凭今天计数推定日期筛选必须同口径。

结论：冻结代码的日期筛选使用 published_at，今天与列表分组使用 timeline_at，差异客观存在。但规格互相冲突：时间规则 BR-TIME-08 和出口验收 AC-OUT-12 的2026-10-05修订明确接口日期按时间线北京日期；公开API契约 §2.3（第87行）则明确来源日期未知只在无日期筛选时出现，第107行也取来源日期。旧 reader.py 与新筛选均符合后一组规则，尚不能排除有据区分，故不作为确定遗漏。

旧库：[services/live_pipeline/reader.py:774-777](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/reader.py#L774-L777)。

新库：[packages/backend/src/publication/items.ts:255-258](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/items.ts#L255-L258)；[packages/backend/src/publication/pool.ts:159-164](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/pool.ts#L159-L164)；[packages/backend/src/publication/pool.ts:261-261](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/pool.ts#L261-L261)；[apps/web/app/features/feed/Filters.tsx:324-324](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/feed/Filters.tsx#L324-L324)。

现行规格：[docs/02-rules/04-time-semantics.md:150-154](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/02-rules/04-time-semantics.md#L150-L154)；[docs/01-product/05-external-interfaces.md:113-113](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/05-external-interfaces.md#L113-L113)；[docs/03-data/02-public-api-contract.md:87-87](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/03-data/02-public-api-contract.md#L87-L87)；[docs/03-data/02-public-api-contract.md:107-107](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/03-data/02-public-api-contract.md#L107-L107)。

待补：确认两套已提交规格谁代表当前日期筛选意图；尤其来源日期未知、来源日与timelineAt跨北京日两个场景。若沿用来源日期筛选，保留当前实现并校正规格；若时间线日期优先，再修正筛选及说明。

### F2-RDR-010 · 详情中文正文与来源原文切换 · 保留

预期：已取得且获准的中文/原文均可阅读，译文与原文明确标识。

结论：新语言路由返回选定正文，详情页提供中文/原文入口与 AI 翻译标签。

旧库：[apps/web/components/reader/article-body.tsx:117-174](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/article-body.tsx#L117-L174)。

新库：[apps/web/app/routes/item.tsx:118-125](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/item.tsx#L118-L125)；[apps/web/app/routes/item.tsx:408-429](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/item.tsx#L408-L429)；[packages/backend/src/publication/detail.ts:190-203](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/detail.ts#L190-L203)。

### F2-RDR-011 · 正文目录与手机目录 · 保留

预期：文章章节有锚点，手机可展开目录并跳正文、来源与事件进展。

结论：新目录由正文标题生成稳定锚点；手机单独提供折叠菜单。桌面仅至少三节时显示目录属于展示方式差异。

旧库：[apps/web/components/reader/pages.tsx:338-366](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L338-L366)。

新库：[apps/web/app/routes/item.tsx:231-247](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/item.tsx#L231-L247)；[apps/web/app/routes/item.tsx:363-375](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/item.tsx#L363-L375)；[packages/backend/src/publication/detail.ts:37-51](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/detail.ts#L37-L51)。

### F2-RDR-012 · 发布方署名、原文入口与 AI 标识 · 保留

预期：中文内容可追溯发布方，原文可打开，正文/出口有 AI 辅助标识。

结论：页面与 RSS 均有发布方和原文链接；人工修订与 AI 文案区分存在。许可深链接问题另列。

旧库：[apps/web/components/reader/pages.tsx:116-124](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L116-L124)；[apps/web/components/reader/pages.tsx:156-161](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L156-L161)；[apps/web/components/reader/information.tsx:17-22](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/information.tsx#L17-L22)。

新库：[apps/web/app/features/feed/parts.tsx:57-73](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/feed/parts.tsx#L57-L73)；[apps/web/app/routes/item.tsx:432-446](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/item.tsx#L432-L446)；[packages/backend/src/publication/feeds.ts:109-155](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/feeds.ts#L109-L155)。

### F2-RDR-013 · 开放许可链接与来源官网最新法律信息 · 遗漏

预期：有开放许可依据时，在正文末尾显示许可名称链接、来源/改编说明及官网最新法律信息入口。

结论：新 readerAttribution 无条件把 license.url 与 legalUrl 设为 null，前端虽保留链接槽位，但公开投影永远不能产生链接。不是框架差异。

旧库：[apps/web/components/reader/article-body.tsx:176-193](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/article-body.tsx#L176-L193)；[services/live_pipeline/reader.py:108-135](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/reader.py#L108-L135)。

新库：[packages/backend/src/publication/reader-context.ts:8-26](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/reader-context.ts#L8-L26)；[apps/web/app/features/feed/parts.tsx:74-93](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/feed/parts.tsx#L74-L93)。

现行规格：[docs/01-product/06-content-standards.md:799-800](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/06-content-standards.md#L799-L800)；[docs/02-rules/01-business-rules.md:620-620](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/02-rules/01-business-rules.md#L620-L620)。

### F2-RDR-014 · 文中公司与资料依据 · 保留

预期：只展示有依据的公司中文/原名、说明及出处。

结论：独立公司区块与来源链接存在；公开值通过公司词表和原文引文筛选，不凭空补译名。

旧库：[apps/web/components/reader/pages.tsx:166-189](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L166-L189)。

新库：[apps/web/app/routes/item.tsx:448-471](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/item.tsx#L448-L471)；[packages/backend/src/publication/reader-context.ts:28-58](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/reader-context.ts#L28-L58)。

### F2-RDR-015 · 相关报道的代表稿与最新进展分开显示 · 保留

预期：历史稿不被新稿替换，代表稿和最新稿可分别进入并标示正在阅读。

结论：独立区块保留两个角色与当前项标识，并展示官方/当事方标记。

旧库：[apps/web/components/reader/pages.tsx:228-279](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L228-L279)。

新库：[apps/web/app/features/item/RelatedCoverage.tsx:5-30](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/item/RelatedCoverage.tsx#L5-L30)；[apps/web/app/routes/item.tsx:444-444](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/item.tsx#L444-L444)。

### F2-RDR-016 · 详情页事件后续、错误重试与完整事件入口 · 保留

预期：排除当前条目/事实，展示其他进展，无进展和读取失败分开；可进完整事件。

结论：新实现按临近视口懒读，但有手动触发、noscript链接和失败重试；仅比较行为而不把加载方式变化当缺陷。

旧库：[apps/web/components/reader/pages.tsx:304-328](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L304-L328)。

新库：[apps/web/app/features/item/StoryFollowups.tsx:17-107](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/item/StoryFollowups.tsx#L17-L107)；[apps/web/app/routes/item.tsx:500-504](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/item.tsx#L500-L504)。

### F2-RDR-017 · 默认事件折叠卡与可展开来源/进展 · 有据变更

预期：无筛选时同事件折叠，搜索/筛选时按篇显示，卡内能展开其他来源与进展。

结论：旧读者列表逐篇显示；现行规格明确新增事件折叠。新 pool 仅在 unfiltered 时调用归组，展开具备分页与重试。

旧库：[apps/web/components/reader/feed.tsx:136-203](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/feed.tsx#L136-L203)；[apps/web/app/events/[event_id]/page.tsx:1-8](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/app/events/[event_id]/page.tsx#L1-L8)。

新库：[packages/backend/src/publication/pool.ts:265-310](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/pool.ts#L265-L310)；[apps/web/app/features/feed/ReadingGroup.tsx:190-303](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/feed/ReadingGroup.tsx#L190-L303)。

现行规格：[docs/01-product/03-reader-pages.md:430-445](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/03-reader-pages.md#L430-L445)。

### F2-RDR-018 · 事件对象收藏与收藏列表解析 · 遗漏

预期：新独立事件页可收藏事件引用，收藏页可解析显示或移除不可用事件。

结论：旧 story URL 复用条目详情，故旧收藏不是独立事件类型；现行规格明确新增事件收藏。新状态类型声明 story，但事件页无收藏控件，收藏页仅解析 item 并加载 PolicySavedList。

旧库：[apps/web/app/v2/stories/[story_id]/page.tsx:1-8](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/app/v2/stories/[story_id]/page.tsx#L1-L8)；[apps/web/components/reader/pages.tsx:111-126](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L111-L126)。

新库：[apps/web/app/routes/story.tsx:1-57](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/story.tsx#L1-L57)；[apps/web/app/routes/story.tsx:190-238](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/story.tsx#L190-L238)；[apps/web/app/lib/local-state.ts:15-19](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/lib/local-state.ts#L15-L19)；[apps/web/app/routes/starred.tsx:16-19](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/starred.tsx#L16-L19)；[apps/web/app/routes/starred.tsx:131-150](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/starred.tsx#L131-L150)。

现行规格：[docs/01-product/03-reader-pages.md:277-280](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/03-reader-pages.md#L277-L280)。

### F2-RDR-019 · 条目收藏上限、跨标签同步与存储失败提示 · 保留

预期：只存引用，最多100条；点击即时变更，同浏览器其他标签同步，存储失败有提示。

结论：新实现去除正文副本、限制新增上限，事件同步和错误提示均保留。

旧库：[apps/web/components/reader/controls.tsx:15-63](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/controls.tsx#L15-L63)；[apps/web/components/reader/saved.tsx:59-63](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/saved.tsx#L59-L63)。

新库：[apps/web/app/lib/local-state.ts:52-81](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/lib/local-state.ts#L52-L81)；[apps/web/app/lib/local-state.ts:152-167](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/lib/local-state.ts#L152-L167)；[apps/web/app/features/feed/parts.tsx:13-53](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/feed/parts.tsx#L13-L53)。

### F2-RDR-020 · 收藏当前版本重读与移除不可用收藏 · 保留

预期：收藏重读当前公开内容，下架项停止展示，可移除不可用引用，失败可重试。

结论：新实现每60秒及聚焦/可见性变化重查，分批解析引用，不展示本地旧内容副本。

旧库：[apps/web/components/reader/saved.tsx:15-55](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/saved.tsx#L15-L55)；[apps/web/components/reader/saved.tsx:83-115](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/saved.tsx#L83-L115)。

新库：[apps/web/app/routes/starred.tsx:28-78](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/starred.tsx#L28-L78)；[apps/web/app/routes/starred.tsx:100-120](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/starred.tsx#L100-L120)。

### F2-RDR-021 · 反馈字段、截图、校验与提交结果 · 保留

预期：匿名提交10–5000字、选填联系方式和最多一张2MB截图；失败保留内容，不显示成功。

结论：支持原有PNG/JPEG/WebP限制与成功状态，新增草稿和幂等键；只有 HTTP 成功才进入已收到界面。未实际发送反馈。

旧库：[apps/web/components/reader/feedback.tsx:25-83](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/feedback.tsx#L25-L83)；[apps/web/components/reader/feedback.tsx:90-155](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/feedback.tsx#L90-L155)。

新库：[apps/web/app/routes/feedback.tsx:81-158](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/feedback.tsx#L81-L158)；[apps/web/app/routes/feedback.tsx:161-183](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/feedback.tsx#L161-L183)；[apps/api/src/routes/feedback.ts:39-55](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/api/src/routes/feedback.ts#L39-L55)。

### F2-RDR-022 · 反馈关联来源页 · 保留

预期：进入反馈时保留来源页，站内 from 参数可带入关联地址。

结论：新页面读取 from 与本机草稿并提交 pageUrl，详情入口主动附带来源页。仅确认有据入口，不推定每一个独立链接都已覆盖。

旧库：[apps/web/components/reader/shell.tsx:104-112](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/shell.tsx#L104-L112)；[apps/web/components/reader/feedback.tsx:49-55](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/feedback.tsx#L49-L55)。

新库：[apps/web/app/routes/feedback.tsx:84-105](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/feedback.tsx#L84-L105)；[apps/web/app/routes/item.tsx:445-447](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/item.tsx#L445-L447)。

现行规格：[docs/01-product/03-reader-pages.md:408-408](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/03-reader-pages.md#L408-L408)。

### F2-RDR-023 · 日报、周报、月报切换与往期目录 · 保留

预期：可切换三类报告，当前期高亮，桌面和手机能找到往期。

结论：路由改为不同周期地址是规格要求；三类入口、日刊合订本、手机近三期和更早入口均存在。

旧库：[apps/web/components/reader/pages.tsx:383-443](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L383-L443)。

新库：[apps/web/app/routes.ts:10-16](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes.ts#L10-L16)；[apps/web/app/features/report/ReportNav.tsx:9-47](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/report/ReportNav.tsx#L9-L47)；[apps/web/app/features/report/ReportNav.tsx:121-157](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/report/ReportNav.tsx#L121-L157)。

### F2-RDR-024 · 报告综合四态与确定性资料汇总 · 保留

预期：综合完成、处理中、失败和普通资料汇总状态分开，不把失败冒称综合完成。

结论：新 generationStatus 对 ready/pending/failed/其他分别显示，报告同时标示 AI 辅助生成。

旧库：[apps/web/components/reader/pages.tsx:517-543](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L517-L543)。

新库：[apps/web/app/features/report/ReportPaper.tsx:364-378](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/report/ReportPaper.tsx#L364-L378)。

### F2-RDR-025 · 当前期未发布时显示最近一期并声明缺期 · 保留

预期：应出未出的当前期明确提示，下方旧报告不改成今天。

结论：expectedReportKey 与现有期键比较后提示缺期；不存在任何报告则显示诚实空态。

旧库：[apps/web/components/reader/pages.tsx:486-501](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L486-L501)；[apps/web/components/reader/pages.tsx:584-618](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L584-L618)。

新库：[apps/web/app/routes/report-latest.tsx:14-19](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/report-latest.tsx#L14-L19)；[apps/web/app/routes/report-latest.tsx:36-53](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/report-latest.tsx#L36-L53)。

### F2-RDR-026 · 报告引用可回到条目与原始来源 · 保留

预期：读者可沿报告引用继续核对报道和原文。

结论：报告正文引用有站内条目链接与原文链接，头版与快讯提供继续阅读入口；此项不评价报纸版式差异。

旧库：[apps/web/components/reader/pages.tsx:446-467](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L446-L467)；[apps/web/components/reader/pages.tsx:544-578](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L544-L578)。

新库：[apps/web/app/features/report/ReportPaper.tsx:100-144](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/report/ReportPaper.tsx#L100-L144)；[apps/web/app/features/report/ReportPaper.tsx:245-260](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/report/ReportPaper.tsx#L245-L260)；[apps/web/app/features/report/ReportPaper.tsx:415-434](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/report/ReportPaper.tsx#L415-L434)。

### F2-RDR-027 · 事件与报告详情的复制链接、手机系统分享 · 遗漏

预期：现行规格要求条目、事件、报告、法规详情均提供复制链接；手机优先系统分享。

结论：条目页有分享与复制，事件和报告详情渲染树没有相应控件；旧站本身无这些控件，因此属于已要求新增能力缺项。

旧库：[apps/web/components/reader/pages.tsx:111-126](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L111-L126)；[apps/web/components/reader/pages.tsx:620-638](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L620-L638)。

新库：[apps/web/app/routes/story.tsx:190-238](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/story.tsx#L190-L238)；[apps/web/app/routes/report-detail.tsx:45-51](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/report-detail.tsx#L45-L51)；[apps/web/app/features/report/ReportLayout.tsx:23-30](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/report/ReportLayout.tsx#L23-L30)；[apps/web/app/features/report/ReportPaper.tsx:356-449](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/report/ReportPaper.tsx#L356-L449)。

现行规格：[docs/01-product/03-reader-pages.md:282-285](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/03-reader-pages.md#L282-L285)。

### F2-RDR-028 · 新内容提示与撤回版本检查 · 有据变更

预期：仅新增时保留页面并提示主动加载；撤回时重新读取当前内容；网络核对失败可保留已读内容。

结论：旧站对更新/确认失败整体隐藏；现行 DEC-48 明确改变这个行为。新组件区分 version 与 withdrawalVersion 并重新校验。未在线执行真实下架。

旧库：[apps/web/components/reader/controls.tsx:191-273](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/controls.tsx#L191-L273)。

新库：[apps/web/app/features/feed/ContentVersionGuard.tsx:27-121](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/feed/ContentVersionGuard.tsx#L27-L121)；[apps/web/app/routes/public-layout.tsx:55-61](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/public-layout.tsx#L55-L61)。

现行规格：[docs/01-product/03-reader-pages.md:265-275](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/03-reader-pages.md#L265-L275)。

### F2-RDR-029 · 所有列表返回原位并恢复标题焦点 · 待核实

预期：从列表进详情后返回原URL、页码、位置与标题焦点。

结论：框架 ScrollRestoration 保留滚动；精选 Timeline 另有锚点和 focus。全部动态/收藏/报告等列表未看到相同 focus 调用，但未运行浏览器，不能仅按辅助函数使用范围断言实际恢复失败。

旧库：[apps/web/components/reader/controls.tsx:65-141](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/controls.tsx#L65-L141)。

新库：[apps/web/app/root.tsx:35-35](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/root.tsx#L35-L35)；[apps/web/app/features/feed/restore.ts:62-80](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/feed/restore.ts#L62-L80)；[apps/web/app/routes/item.tsx:136-147](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/item.tsx#L136-L147)；[apps/web/app/features/feed/DayList.tsx:25-83](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/feed/DayList.tsx#L25-L83)。

现行规格：[docs/01-product/03-reader-pages.md:258-263](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/03-reader-pages.md#L258-L263)。

待补：需在冻结构建的浏览器上从全部第3页、搜索、收藏、报告逐项往返，记录位置和 activeElement。

### F2-RDR-030 · RSS摘要、GUID、日期与全文权限 · 有据变更

预期：新版RSS保留摘要、站内及原文链接、稳定ID；日期输出按新规则；站外全文须具备额外许可。

结论：旧单一全部动态feed按日期精度使用dc:date；新多feed和pubDate属于明确改动，全文只在 syndicate 时输出。是否应登记全文feed地址受规格候选范围影响，未将该地址存在本身算旧功能缺失。

旧库：[services/live_pipeline/reader.py:917-949](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/reader.py#L917-L949)。

新库：[apps/api/src/routes/feeds.ts:16-68](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/api/src/routes/feeds.ts#L16-L68)；[packages/backend/src/publication/feeds.ts:120-168](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/feeds.ts#L120-L168)。

现行规格：[docs/01-product/05-external-interfaces.md:48-49](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/05-external-interfaces.md#L48-L49)；[docs/01-product/05-external-interfaces.md:106-111](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/05-external-interfaces.md#L106-L111)。

### F2-RDR-031 · 公开v3列表、详情、阅读分块、收藏与报告 · 有据变更

预期：公开端点只读提供当前对象；正文仅按站外再分发权限输出，续读换版返回冲突。

结论：v3 是现行规格新增主版本而非旧接口适配；路由覆盖所查对象，正文块有独立许可、修订与游标绑定。这里只确认代码路径，不宣称公网可用。

旧库：[apps/web/lib/reader/adapter.ts:6-60](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/lib/reader/adapter.ts#L6-L60)；[services/public_api_v2/http.py:54-80](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/public_api_v2/http.py#L54-L80)。

新库：[apps/api/src/routes/v3.ts:114-183](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/api/src/routes/v3.ts#L114-L183)；[packages/backend/src/publication/v3-reading.ts:61-138](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/v3-reading.ts#L61-L138)。

现行规格：[docs/01-product/05-external-interfaces.md:50-50](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/05-external-interfaces.md#L50-L50)。

### F2-RDR-032 · 公开MCP查询能力与只读工具 · 有据变更

预期：远程MCP提供资讯查询、详情、事件、热点、三类报告、主题及法规工具，不触发生成。

结论：旧库有 Agent/MCP-style 读服务，但读者指南没有远程MCP入口；新代码提供远程传输与相关只读工具。未验证特定客户端实际握手。

旧库：[services/distribution_v2/agent.py:38-121](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/distribution_v2/agent.py#L38-L121)；[apps/web/components/reader/information.tsx:3-58](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/information.tsx#L3-L58)。

新库：[apps/api/src/routes/mcp.ts:173-227](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/api/src/routes/mcp.ts#L173-L227)；[apps/api/src/routes/mcp.ts:261-321](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/api/src/routes/mcp.ts#L261-L321)；[apps/api/src/routes/mcp.ts:324-453](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/api/src/routes/mcp.ts#L324-L453)；[apps/api/src/routes/mcp.ts:494-563](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/api/src/routes/mcp.ts#L494-L563)。

现行规格：[docs/01-product/05-external-interfaces.md:51-51](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/05-external-interfaces.md#L51-L51)。

### F2-RDR-033 · 公开v3 OpenAPI文档主域名可达 · 遗漏

预期：主入口 GET /openapi-v3.json 返回已生成的v3接口定义。

结论：API中已注册，但Web的API路径名单仅含openapi-v1。部署全部转Web，v3文档既不转发也无页面路由，因此落入404。已对冻结原函数做纯内存复现：isApiOwned('/openapi-v3.json')=false，v1文档与/api/v3/items为true。

旧库：[apps/web/components/reader/information.tsx:16-53](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/information.tsx#L16-L53)。

新库：[apps/api/src/routes/static.ts:110-114](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/api/src/routes/static.ts#L110-L114)；[packages/contracts/src/http-policy.ts:104-118](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/contracts/src/http-policy.ts#L104-L118)；[apps/web/server.ts:167-191](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/server.ts#L167-L191)；[deploy/Caddyfile:9-11](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/deploy/Caddyfile#L9-L11)。

现行规格：[docs/01-product/05-external-interfaces.md:60-60](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/05-external-interfaces.md#L60-L60)。

### F2-RDR-034 · Agent指南与llms.txt发现v3能力 · 遗漏

预期：接入页与llms.txt说明现行公开v3端点、OpenAPI、正文与报告等可用能力。

结论：v3实现已存在，但指南主资源只列openapi-v1，描述及llms.txt的接口发现均指向v1；没有v3入口/示例，使用文档的客户端难以发现本轮新增接口。

旧库：[apps/web/components/reader/information.tsx:16-56](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/information.tsx#L16-L56)。

新库：[apps/web/app/routes/agent.tsx:20-24](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/agent.tsx#L20-L24)；[apps/web/app/routes/agent.tsx:48-56](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/agent.tsx#L48-L56)；[packages/backend/src/publication/llms.ts:42-55](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/llms.ts#L42-L55)。

现行规格：[docs/01-product/05-external-interfaces.md:50-55](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/05-external-interfaces.md#L50-L55)；[docs/01-product/05-external-interfaces.md:60-60](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/05-external-interfaces.md#L60-L60)。

### F2-RDR-035 · sitemap与robots的公开内容发现 · 待核实

预期：公开可收录对象进入站点地图，下架对象不残留，大容量时分页。

结论：新实现有按资格生成与45,000条拆分页；旧冻结服务/指南未定位到同类出口，不能确认旧功能基线，也未做运行期下架/资格变更验收。不得将代码存在说成旧行为全面保留。

旧库：[services/live_pipeline/server.py:125-149](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/server.py#L125-L149)；[apps/web/components/reader/information.tsx:3-58](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/information.tsx#L3-L58)。

新库：[packages/backend/src/publication/sitemap.ts:19-83](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/sitemap.ts#L19-L83)；[packages/backend/src/publication/sitemap.ts:88-113](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/packages/backend/src/publication/sitemap.ts#L88-L113)；[apps/api/src/routes/static.ts:55-68](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/api/src/routes/static.ts#L55-L68)；[apps/api/src/routes/static.ts:115-134](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/api/src/routes/static.ts#L115-L134)。

现行规格：[docs/01-product/05-external-interfaces.md:53-53](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/05-external-interfaces.md#L53-L53)。

待补：旧库同类出口的路由证据（如存在）；冻结新构建中针对下架、合并及超过单页容量的运行验证。

### F2-RDR-036 · 手机实际阅读、横向溢出及触控完成度 · 待核实

预期：320px及常见手机宽度可完整阅读，触控可用，正文表格不把整页撑宽。

结论：静态代码显示手机底栏、详情工具条、目录与报告导航；没有启动冻结构建/浏览器测量，因此不能据CSS和组件声明认定真实手机验收通过。

旧库：[apps/web/components/reader/shell.tsx:167-212](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/shell.tsx#L167-L212)；[apps/web/components/reader/pages.tsx:190-190](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/pages.tsx#L190-L190)；[apps/web/components/reader/article-body.tsx:64-95](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/apps/web/components/reader/article-body.tsx#L64-L95)。

新库：[apps/web/app/routes/public-layout.tsx:41-50](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/public-layout.tsx#L41-L50)；[apps/web/app/routes/item.tsx:277-294](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/item.tsx#L277-L294)；[apps/web/app/routes/item.tsx:363-375](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/routes/item.tsx#L363-L375)；[apps/web/app/features/report/ReportNav.tsx:121-157](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/apps/web/app/features/report/ReportNav.tsx#L121-L157)。

现行规格：[docs/01-product/03-reader-pages.md:310-310](https://github.com/Crhis-CP/AI-MINE/blob/6996788c58347fa2483edc8e7d9e916292b20885/docs/01-product/03-reader-pages.md#L310-L310)。

待补：冻结构建在320/390px实际页面的布局、长标题/长表格、键盘焦点与触控操作记录。
