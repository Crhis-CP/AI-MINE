# 原帖处理迁移核对：两类 verbatim 与直接消费者

对照固定AIHOT `a0d1e75b00ede7e503ca948e71a468db964b2df2` 与AI-MINE `22497e0c7038ba9cc32701d1b3f68c30c4b34aa6`，对应TASK-0367、架构清单A04/A05。先检查已有`upstream-files.json`及受限上游快照：所需editorial/content/publication原帖文件不在该清单，故补读官方GitHub的上述固定SHA；没有换基线。初次代码核对为静态证据，未执行上游、未跑模型或访问生产；文末另列随后补充的只读域名元数据，不代替完整来源或材料盘点。本文未改运行代码。

**结论：真实缺口是“原帖材料→模型步骤→结果保存→许可后的公开呈现”的整段消费者，不是只缺`originalPostCopy`或一个枚举。** 可先建设契约、保存、版本、许可与显示能力；空/纯链接原帖以及极短中文帖获得新的公开资格，确实可能改变当前入选范围，应把这一类条件交Chris统一确认后生效，不能混称纯展示兼容，也不需要Chris逐篇盲标。

## 1. 两类同名结果必须分开

| 分支 | 固定上游的实际触发与作用 | 本站差异及边界 |
|---|---|---|
| **空正文/纯链接原帖** | `originalPostCopy`只处理明确传入的原帖对象；去掉URL后无其他文字时，保留原始链接或以帖子URL作标题，摘要可为空。已有链接长文正文时不走此复制分支。`awaitsMaterial`据此不再按普通空正文等待；预筛、评分、结构化仍执行，只有写作被`verbatim`替代。[U posts:4–11][u-posts]、[U analyze:451–509][u-analysis-original] | 本站无typed原帖输入；普通空正文在付费前等待。若直接加入上游例外，会让“无正文且无中文摘要”的材料有机会成为pass/公开/精选候选，属于需要确认的准入差异。[M analyze:607–655][m-analysis-run]、[M publish:359–385][m-publication-gate] |
| **有正文的中文短帖** | 这是`runSummarize`内部捷径：已进入摘要分支、被判断为短帖且无需翻译时，正文同时成为标题/摘要，writer无回执；不等于所有中文短帖跳过理解。较高评分走`runUnderstand`时仍可能调用理解模型。短帖长度/混合语言判断见writing；预筛、双评分、结构化没有取消。[U writing:26–64][u-short-rule]、[U analyze:416–448][u-summarize]、[U analyze:483–500][u-analysis-original] | 本站摘要统一走文章路径，少于20字符返回none，否则可能调用摘要模型；没有原帖短/长、引用区分。正常中文原文的复用能力可以迁，但极短帖由“无摘要、未公开”变为可公开也不能当作零规则影响。[M analyze:563–600][m-summarize]、[M writing:125–144][m-translate-input] |

**不能扩大识别范围：** 普通新闻只抓到标题、URL或错误页，不因此变成“原帖”。必须来自明确、验证过的原帖材料类型。尤其本站`usableSourceText`把含字母的URL视为有字符，纯链接若被展平成普通`bodyText`，未必会等待，也可能进入模型；不能声称所有纯链接旧稿都必然被拒绝。[M text:8–9][m-usable]、[M writing:92–95][m-missing]

## 2. 直接消费者与最小完整实施范围

| 真实缺口 | 上游证据与本站证据 | 必须一起接通的内容 |
|---|---|---|
| **材料入口和保存** | 上游`XPostData`保存正文、作者、账号、引用、媒体，Candidate提供`xPost`；库中另有`x_post`、链接长文`x_article`。本站`MaterialInput`只有普通正文/media/raw，库表与已检索迁移没有这两个字段。[U materials:21–50][u-material-type]、[U x:15–72][u-source]、[U core:84][u-db-post]、[U long-article migration][u-db-article]；[M materials:36–57][m-material-type]、[M core:76–84][m-db] | 先定义受校验、有限大小的原帖/引用/媒体及长文材料契约，再做增量存储和Candidate→upsert传递。不能从任意`raw`或标题猜原帖，也不能只把原帖展平成bodyText后丢掉媒体/引用身份。保留本站source/lane身份隔离、历史ID和链接，不照搬上游全局`x:tweetId`覆盖既有身份。[M identity:88–92][m-identity] |
| **模型输入和等待** | 上游输入读入原帖，并把已获取长文并入模型材料；评分、结构化、预筛/理解分别识别正文与引用，图像选择包含原帖/引用媒体。本站读入与渲染只含普通正文/media，`waitsForPage`也无原帖区分。[U input:43–65、91–113][u-input]；[M input:43–110][m-input]、[M analyze:252–254][m-wait-page] | 所有模型步骤共用同一个已验证输入，保留引用作者和正文边界；链接长文有内容时走正常处理，不能仍复制裸链接。模型调用前的ProcessingPermit、当前来源许可、输入版本及人工暂停继续校验；原帖图片或被引内容不自动获得额外外送权限。[M news-fallback:29–44][m-permit] |
| **写作结果和保存** | 上游`AnalysisRun.writing.kind`含verbatim，允许该类空摘要正常化为pass；落库仍保存writer类型、原输入修订和实际回执。本站kind只有understand/summarize/none，但已有输出JSON、回执集合、当前修订锁和按模块提交入口。[U analyze:193–212][u-run-type]、[U analyze:553–585][u-analysis-save]；[M analyze:213–246][m-run-type]、[M analyze:753–800][m-analysis-save]、[M materials:264–279][m-commit] | 扩展内部结果契约并实现两类分支；writer零调用不能被写成整个分析零调用。沿现有提交/回执/归组更新保存，不另建分析流程；保留SelectBench的`stages: selection`行为，不能为了照搬上游全量normalizer破坏该既有消费者。 |
| **发布资格和人工优先** | 上游在投影时再次取原帖副本，替换历史模型缺材料回复；`originalPost`允许无摘要进入pool。本站要求真实可用文字、中文标题/导读、当前归组修订及信息增量，并保留人工修改/撤回。[U publish:268–298][u-publication]、[U rules:28–36][u-pool]；[M rules:24–29][m-pool]、[M publish:310–385][m-publication-gate] | 先列清新旧资格差异；获确认后将原帖例外接入同一个投影，人工覆盖和撤回优先。历史模型错误文案可以在投影中被正确原帖呈现替代，不删除旧分析/翻译审计，不把人工正文当错误模型文案覆盖。矿业已确认评分/门槛/国别规则原样接入，不能连带改上游其他入选条件。 |
| **站内接口和网页** | 上游有`XPostView`、卡片媒体/引用、详情媒体/引用及原帖/译文切换。本站站内卡片严格Zod只有news及普通摘要，详情只有HTML正文，前端卡片/ArticleBody没有原帖对象消费。[U site:23–32、60–64、137–145][u-site-types]、[U items:116–187][u-post-view]、[U item route:554–555][u-item-ui]；[M http/public:70–86][m-wire]、[M site:71–89][m-detail-type]、[M FeedItem:25–66][m-card]、[M ArticleBody:4–6][m-body-ui] | 先独立提交站内原帖视图/材料类型及必要枚举契约，再接API投影与电脑/手机显示。不能只在后端返回额外`x`字段让严格消费者报错。是否采用上游公开`x`通道要在契约中明确；`news/policy`业务线不得变成第三条业务线，也不自动导入上游导航、来源或行业示范。 |
| **许可、RSS和机器出口** | 上游原帖正文/媒体按`showsPost`与`body_mode`显示，固定站点`xPostIsFullText=true`；全文RSS另受syndicate控制。本站机器详情与全文RSS有当前转载权限及容量检查，但只处理普通HTML。[U site:111–115][u-policy]、[U items:144–149][u-shows-post]、[U feeds:106–137、170–176][u-feeds]、[U detail:174–208][u-markdown]；[M detail:223–244][m-machine]、[M feeds:148–171、236–241][m-feeds] | 共用许可后的原帖视图，再让详情、卡片、全文RSS、机器读取/Markdown消费。**原帖全文即使放在title/summary字段，也不能借字段名称绕过全文公开许可。** 普通摘要API不必额外输出整份原帖；无许可时保留允许的元数据/原文链接。不能复制上游显示例外来取消本站许可、部分翻译说明或人工修改优先。 |
| **引用/长文及版本、评测** | 上游引用译文按被引帖与文本hash复用，长文到达会形成新材料修订；当前本站只有严格正文翻译，评测指纹明确枚举普通正文/media等字段，没有原帖字段。[U translate:176–195、273–327][u-translate]、[U extract:498–530][u-long-extract]；[M translate:1–55][m-translate]、[M evaluation-input:8–46][m-evaluation] | 如果承接原帖中的引用/长文，必须同步处理翻译归属、许可、文本hash和变版失效；否则不是完整消费者。扩展固定输入指纹、步骤报告和回归，不让变过的原帖沿用旧样本或旧回执。无需重做已有免费复用、费用归属、人工暂停和版本锁。 |

上游原帖入口示例使用SocialData，但**缺输入字段不等于必须现在新增该供应商**。通用材料/处理/显示能力可以先以受校验的内部输入及录制夹具接通；实际信源、账号、服务凭据和采购单独按Chris范围决定。固定上游`ingest/items.ts:20–25、28–52`本身也不是一个通用xPost上传契约，本次不应顺带扩张外部ingest接口。[上游入口范围][u-ingest]

## 3. 可审核的前后例子

下表是**合成边界的静态推演，未运行、非真实模型验收**。需要模型结果的例子显式假定预筛PASS、结构化有效；“可能精选”还须同样通过现行双评分门槛、归组、增量、许可与人工状态，不是代码直接选中。

| 合成材料与条件 | 本站22497e0c等价现有字段 | 固定上游结果 | 影响 |
|---|---|---|---|
| 普通网页，仅标题，无正文/摘要，无原帖类型 | 付费前等待，writer空 | 仍等待 | 已一致；不能为补原帖而放行所有缺正文新闻。 |
| 明确的图片原帖：text为空，含一张图片，许可允许；模型达到门槛、归组已完成 | 本站无原帖契约；展平后正文/摘要空，即使media存在也等待/不公开 | 原帖副本以URL作标题，摘要空；仍跑预筛/评分/结构化，不调用两类writer；可成为pass/公开及精选候选 | 明确改变原有无文字/无中文摘要的资格，须类别级确认后生效。上游有对应测试，但本次未执行。[U test:46–69][u-tests] |
| 明确纯链接原帖，text只有URL | 展平URL含字母，会按普通正文进入处理，后续文案取决于模型；不能断言一定被拒或一定错误 | 保留原始URL，不用writer编一段摘要 | 模型输入/费用及中文呈现资格均可能变化；不把该规则推广到普通文章URL。 |
| 中文短帖“铜矿今日投产。”，分数低于理解分支门槛 | 摘要路径少于20字符返回none，可能因无导读而不公开 | 摘要路径返回verbatim，标题/摘要均为原文，无writer回执 | 极短中文帖可能从未公开变为公开，须明确该类别；不能称完全不影响规则。 |
| 30–60字中文短帖，低于理解分支门槛 | 可能调用普通摘要writer | 摘要路径可原样呈现；预筛/评分/结构化仍执行 | 一般是执行方式变化，但须对照输出与费用；较高评分仍可能走理解，不能无条件跳过writer。 |
| 有实质正文且含链接，或链接长文已取得 | 普通正文处理 | 原帖副本函数返回null，继续理解/摘要 | 不应误走链接副本；上游对应测试要求仍调用正常writer。[U test:105–118][u-tests] |

## 4. 实施顺序与确认边界

1. **现有授权可先做的契约准备**：明确原帖/引用/媒体/长文材料、AnalysisRun.verbatim、站内受限视图、评测指纹；独立契约PR列所有直接消费者。新增字段兼容旧文章，增量迁移不重写历史，不启用新源或供应商。
2. **现有授权可先做的实现与验证**：连接入库、各模型输入、两类writer分支、原有结果提交、许可后投影及上述出口；用假模型/录制夹具验证少付writer费用、回执不丢、引用与长文变化、人工优先、旧数据及多语言。原有普通新闻、矿业评分、国别、时间和严格翻译能力继续复用，已有一致项不重写。
3. **生效前交Chris确认的具体差异**：空/纯链接、仅媒体原帖在无中文导读时是否可公开并参与精选；极短中文原帖原样文案是否构成合格公开内容。这是类别级的统一准入决定，不是逐篇审批或重新要求人工盲标。新供应商/来源启用、凭据与生产部署仍走原边界。若不涉及这些准入变化的普通中文原帖分支可保持现行条件先实现，不以此冒称全部原帖迁移完成。
4. **确认后的同一目标验收**：按已确认条件启用完整原帖消费者，提交固定输入的前后模型/公开结果和费用差异，并检查网页、API/RSS/详情及人工控制。暂未启用的新类型只能记“实现/验证待生效”，不能以永远关闭的字段、空名单或另设保守流程代替上游目标而结题。

最低回归集合应包括：普通空正文仍零付费等待；空/纯链接有媒体与无媒体分开；中文短帖低分/高分两分支；外文/混合语言/引用；长文未到与已到；原帖或媒体变版；已有模型错误文案与人工修订并存；许可撤回/摘要权限与全文权限不同；各出口和手机渲染。真实材料按现有许可取得；现有31篇样本继续保持固定，若原帖覆盖不足，另形成事先固定、标明版本的补充集，不看结果后换样本。

## 5. 明确尚未证明的事项

- 本次没有生产来源/材料盘点，不能断言当前没有真实短帖，也不能推定哪一批原帖已经获得启用或全文许可。
- 上游同正文hash路径只更新展示的HTML/media，而`x_post`写入位于内容修订分支；模型又优先读取`xPost.media`。仅凭静态代码不足以证明编辑媒体、引用或作者信息的全部变版行为正确。迁移时必须实测这些输入变更与哈希/重处理的关系，不把上游有字段当作版本验收完成。[U materials:299–331][u-material-update]
- 本文未证明任何真实原帖选材质量、费用改善、供应商可用性或线上阅读效果；没有对普通矿业新闻追加词表、排除词或手工改判。发布资格冲突必须显式解决，不能在代码里无声放宽。

[u-posts]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/content/posts.ts#L4-L11
[u-analysis-original]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/editorial/analyze.ts#L451-L509
[u-short-rule]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/editorial/writing.ts#L26-L64
[u-summarize]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/editorial/analyze.ts#L416-L448
[u-material-type]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/content/materials.ts#L21-L50
[u-source]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/sources/x.ts#L15-L72
[u-db-post]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/database/migrations/0001_core.sql#L84
[u-db-article]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/database/migrations/0037_x_article.sql#L1-L3
[u-input]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/editorial/input.ts#L43-L113
[u-run-type]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/editorial/analyze.ts#L193-L212
[u-analysis-save]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/editorial/analyze.ts#L553-L585
[u-publication]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/publication/publish.ts#L268-L298
[u-pool]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/publication/rules.ts#L28-L36
[u-site-types]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/contracts/src/site.ts#L23-L145
[u-post-view]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/publication/items.ts#L116-L187
[u-item-ui]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/apps/web/app/routes/item.tsx#L554-L555
[u-policy]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/site/site.ts#L111-L115
[u-shows-post]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/publication/items.ts#L144-L149
[u-feeds]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/publication/feeds.ts#L106-L176
[u-markdown]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/publication/detail.ts#L174-L208
[u-translate]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/editorial/translate.ts#L176-L327
[u-long-extract]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/content/extract.ts#L498-L530
[u-ingest]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/ingest/items.ts#L20-L52
[u-tests]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/tests/x-original-posts.test.ts#L46-L118
[u-material-update]: https://github.com/KKKKhazix/AIHOT/blob/a0d1e75b00ede7e503ca948e71a468db964b2df2/packages/backend/src/content/materials.ts#L299-L331
[m-material-type]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/content/materials.ts#L36-L57
[m-db]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/database/migrations/0001_core.sql#L76-L84
[m-identity]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/content/materials.ts#L88-L92
[m-input]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/editorial/input.ts#L43-L110
[m-wait-page]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/editorial/analyze.ts#L252-L254
[m-permit]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/providers/news-fallback.ts#L29-L44
[m-run-type]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/editorial/analyze.ts#L213-L246
[m-analysis-run]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/editorial/analyze.ts#L607-L655
[m-analysis-save]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/editorial/analyze.ts#L753-L800
[m-commit]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/content/materials.ts#L264-L279
[m-summarize]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/editorial/analyze.ts#L563-L600
[m-translate-input]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/editorial/writing.ts#L125-L144
[m-usable]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/lib/text.ts#L8-L9
[m-missing]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/editorial/writing.ts#L92-L95
[m-pool]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/publication/rules.ts#L24-L29
[m-publication-gate]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/publication/publish.ts#L310-L385
[m-wire]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/contracts/src/http/public.ts#L70-L86
[m-detail-type]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/contracts/src/site.ts#L71-L89
[m-card]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/apps/web/app/features/feed/FeedItem.tsx#L25-L66
[m-body-ui]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/apps/web/app/features/item/ArticleBody.tsx#L4-L6
[m-machine]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/publication/detail.ts#L223-L244
[m-feeds]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/publication/feeds.ts#L148-L241
[m-translate]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/editorial/translate.ts#L1-L55
[m-evaluation]: https://github.com/Crhis-CP/AI-MINE/blob/22497e0c7038ba9cc32701d1b3f68c30c4b34aa6/packages/backend/src/editorial/evaluation-input.ts#L8-L46

2026-10-26 01:06 UTC补充只读元数据：当前文章URL以及来源配置URL中，未检索到匹配X/Twitter域名的记录；未导出正文或配置值。这只是限定域名检索，不能据此断言没有其他平台的短帖，亦不代替真实输入/许可盘点。通用原帖能力继续迁移，实际来源启用或采购不因本研究自动发生。受限记录original-post-presence-metadata-20261026.json留存。
