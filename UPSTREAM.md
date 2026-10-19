# 上游来源登记（UPSTREAM）

本仓库以开源项目 AIHOT 为工程起点（Owner 2026-09-29 决定、2026-10-01 总原则 DEC-64；ADR-0001、ADR-0021）。本文件与 `NOTICE`、`upstream/aihot.lock.json` 一起构成唯一的来源登记（`docs/04-architecture/04-aihot-adoption.md` 6.1）。

## 1. 来源

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/KKKKhazix/AIHOT |
| 许可 | MIT，版权人“数字生命卡兹克”；许可原文一字不改，保存在 `LICENSES/AIHOT-MIT.txt` |
| 导入提交 | `885b736dc0fd3ef3d4c9c70af2bc3a981a99ff38` |
| 归档 | 交接包 v2.1 `research/aihot/AIHOT-885b736dc0fd3ef3d4c9c70af2bc3a981a99ff38.tar.gz`，8,614,515 字节，SHA-256 `c6872965ae55d8f540c5443ff3cba3e5dc88e1d5182a5f14560ec15314c73057` |
| 校验 | 整包哈希一致；502 个文件逐文件字节数与 SHA-256 与 `aihot-source-manifest.json` 一致（2026-10-02） |
| 导入日期 | 2026-10-02 |
| 导入方式 | 从交接包内的归档解压，不带上游 Git 历史；本仓库第一个提交 `chore: import AIHOT 885b736 (MIT)` 原样导入、不改任何文件 |
| 路径映射 | `docs/appendix/B-aihot-file-inventory.md`（逐文件处置：保留 / 搬移 / 改造 / 关闭 / 删除）；机器可读版 `upstream/aihot.lock.json` |
| 已审阅到的上游提交 | `cf8f8d0`（交接包编制时，2026-09-30）。2026-10-02 建仓时上游又有 6 个新提交（到 `3343fe2`），见第 4 节，尚未审阅完 |

## 2. 许可安排

- 根目录 `LICENSE` 是本仓库所有者的 MIT 许可（Copyright (c) 2026 Chirs Codex）。Owner 2026-10-02 要求在许可里加上自己的署名，按 `04-aihot-adoption.md` 6.1 的做法处理：AIHOT 的 MIT 原文移到 `LICENSES/AIHOT-MIT.txt`，一字不改；`NOTICE` 写明源自 AIHOT 的部分按 MIT 提供。
- AIHOT 的名称与 Logo 不在 MIT 授权内：代码、界面、文档、包名、环境变量、存储键、User-Agent、MCP 工具名里都不使用，只作为来源说明与历史记录出现在 `docs/04-architecture/04-aihot-adoption.md` 4.6 第 1 条列出的路径里：`LICENSE`、`LICENSES/AIHOT-MIT.txt`、`NOTICE`、本文件与 `upstream/aihot.lock.json` 这些来源登记，原样放入 `docs/` 的交接包及其写回，`docs/acceptance/` 的历史证据，与模板逐字节相同的治理文件，以及上游检查流程的原样存档（2026-10-02 勘误；去品牌在 T-0002 完成）。2026-10-05 起另有一处对读者显示的致谢：Owner 要求在更新日志里感谢上游作者开源本项目，名称只出现在 `industry/changelog.json` 的致谢与正式上线两条的三句原句里，也只在 `/changelog` 页及其站内数据（站内接口 `/api/site/changelog`、站内跳转取的 `/changelog.data`）里出现，公开 API、RSS、MCP 与其他页面仍然没有（4.6 第 1 条 ⑦，TASK-0038）；这是写明出处，不当作本站名称或标识，Logo 仍不使用。
- MIT 源码授权不等于新闻、原文全文或第三方标识授权；采集内容的展示范围由信源权限矩阵决定（ADR-0009）。

## 3. 移植记录

导入点之前的上游修复已包含在 `885b736` 中，不需要再移植。导入点之后、交接包 6.5 列为“移植”的缺陷修复，在格式化与任何结构改动之前逐项移植，每项一个独立提交，不计入行为变化，先于行为基线：

| 日期 | 上游提交 | 内容 | 本仓库提交说明 | 测试 |
|---|---|---|---|---|
| 2026-10-02 | `c3ba0ca` | 结果未知的回执放行后，文章从下一个未完成的分析步骤恢复（上游 Fixes #12） | `fix: requeue articles after unknown receipts are released` | 上游新增的两个恢复测试（`tests/receipts.test.ts`），随行为基线运行 |
| 2026-10-02 | `ad4a549`（#25） | 稳定 SelectBench 评测语义 | `fix: stabilize SelectBench evaluation semantics (#25)` | `tests/selection-eval-runtime.test.ts` |
| 2026-10-02 | `a5bd87b`（#19） | 投递重试原子认领 | `fix(notify): atomically claim delivery retries (#19)` | `tests/deliveries.test.ts` |
| 2026-10-02 | `cf8f8d0`（#30） | 固定已修补的 `fflate`（图片依赖的安全版本） | `fix: pin patched fflate for image dependencies (#30)` | 依赖安装 |

这四项在导入后立即移植，当时路径与结构和上游完全相同，所以直接以 `cherry-pick -x` 应用（提交说明里保留上游提交号）；结构改动之后的移植改为手工改写，不再整提交 cherry-pick。

交接包 6.5 里其余提交的处置照旧：`3e36e48` 部分采用（结构保留抽取供法规线参考，随 M2 任务）、`b813579` 与 `17ade63` 在外部推送启用时再移植、`e6604a4` 随公开 MCP 决定参考、`a75140b`、`c41a6cf`、`c38705b`、`eb3779f` 不移植。

## 4. 待审阅的上游新提交（交接包编制之后，2026-10-02 发现）

| 上游提交 | 日期 | 内容 | 初步分类（按 6.4 第 4 点） |
|---|---|---|---|
| `8d5a39b` | 2026-10-01 | 重试间保留已取得的供应商结果、修订与公开撤回守卫、报告、证据、阅读状态、媒体、MCP 的 Markdown 答复 | 大提交，含已继承机制的缺陷修复（回执、撤回）；逐项审阅后按常规任务移植 |
| `035f7b7`（#63） | 2026-10-01 | 社区采集、会话、恢复与跨行业适配修复的合集，含后台会话绑定（迁移 `0041_admin_session_binding.sql`）、`http-fetch`、备份、运行监视 | 含会话与出网相关改动，**优先审阅**（安全修复立即建任务卡） |
| `ddf1c19`（#64） | 2026-10-02 | 向量批次随付费回执一起提交 | 回执机制缺陷修复；是否移植取决于向量功能的去留 |
| `b5e2a09`（#70） | 2026-10-02 | X 搜索回执与覆盖提交 | X 采集随 T-0002 删除；只看 `collect.ts` 里与回执相关的部分 |
| `39281f6`（#66） | 2026-10-02 | 部署文档：先配置公开 `SITE_URL` | 纯文档，忽略 |
| `3343fe2`（#71） | 2026-10-02 | 读者按时间顺序跟读事件进展 | 事件页沿用 AIHOT（DEC-25），审阅后决定是否移植 |

## 5. 同步策略（ADR-0001、`04-aihot-adoption.md` 6.4）

1. `upstream` 远端只读（推送地址设为 `DISABLED`），只用于比对，不自动合并，结构改动后不整提交 cherry-pick。
2. 每周比对一次上游新提交，并关注上游的安全公告；上游 `SECURITY.md` 声明只在最新 `main` 修复安全问题，所以安全修复立即审阅。
3. 分类：安全修复立即建任务卡移植；已继承机制的缺陷修复按常规任务移植并补测试；AI 专属内容与 AIHOT 产品功能（模型榜、监控、AI 示范源、提示词里的 AI 例子）忽略；纯重构与文案忽略。
4. 移植方法：按附录 B 的“AIHOT 路径 → 新位置”手工改写；格式化提交之后，先按同一份 Biome 配置格式化补丁再应用；PR 描述引用上游提交号；合并后更新第 1 节的“已审阅到”与第 3 节的移植记录。
5. 上游的测试自报（例如“153 个后端测试通过”）不作本仓库的证据，以本仓库自己跑出的基线为准（`docs/acceptance/`）。

## 6. 取代说明

Owner 2026-09-29 决定以 AIHOT 源码为工程起点，取代旧项目“AIHOT 只借鉴、不得复制代码”的规则（ADR-0001）。继承来的文档里若仍有那句旧规则，以本条为准。

## 2026-10-15 功能对齐基线

Owner批准固定以`540c47788eb6475c7ad8819d36733eda81dca20d`研究并改造全部重叠功能。此处只登记研究和改造目标，不把未移植文件标为已完成移植。已确认差异和实现进度见功能矩阵与TASK-0358～0367；许可证与原导入文件哈希登记不变。


## 2026-10-15 署名与产品表达

Owner 最新决定：普通产品文案与代码说明使用本站自己的表达；原产品更新日志中的工程来源致谢退出读者展示，取代早期该条展示决定。原作者、MIT 原文与来源登记仍保存在 LICENSES、NOTICE 及本文件，不删除版权声明、不改写 Git 历史。

后台运行与审计页面本轮参考固定版本 `540c47788eb6475c7ad8819d36733eda81dca20d` 的同名页面实现，并接入本站登录、API 客户端、回执版本核对及业务线。金属价格 ZIP 读取器的出处继续见原登记；实现注释仅解释边界与处理行为。此登记不表示这些变更已部署。

## 2026-10-18 对照版本更新

Owner要求最新页面与最新仓库一并纳入，当前对照更新为`4947ad03309c64a4002bd073d690aee50c548063`。此前固定版本记录保留为研究历史；新增研究与移植状态见`docs/acceptance/aihot-alignment-20261015/latest-upstream-delta.md`。本次新闻列表手机排版、日期折叠行及阅读侧栏滚动参考该版本相应组件，接入本站日期精度、署名与阅读权限；许可登记继续保留。本条不表示整份新版本已移植或部署。

手机FeedBar与PhoneBar布局对照4947ad03309c64a4002bd073d690aee50c548063的同名阅读组件，接入本站地区、来源、矿种与日期条件；继续使用本站原生模态框、焦点和鉴权边界。此记录只登记本轮代码来源与范围，不代表整版已部署。

阅读目录的当前位置与页尾章节选择机制参考4947ad03309c64a4002bd073d690aee50c548063的lib/motion.ts，保留本站锚点编码、正文修订隔离和原生模态框；滚动更新经浏览器帧合并，降低重复布局读取。

正文展示与语义修订分离参考4947ad03309c64a4002bd073d690aee50c548063的content/materials.ts与content/presentation.ts；本站通过严格分段manifest和已绑定回执复用原始译文，保留人工状态与公开资格，不沿用无法证明完整性的旧标记。

HTTP成功响应中的错误页和渲染协议警告识别参考4947ad03309c64a4002bd073d690aee50c548063的lib/page-content.ts与providers/jina.ts；本站在详情、列表及正文提取中使用，渲染费用和原回执保留，识别不执行网页脚本。

静态流式正文片段复位、行内可见性归一及figure中SVG文字替代采用4947ad03309c64a4002bd073d690aee50c548063的content/extract.ts相应函数，组织在content/readable-dom.ts；只解释已完成片段标记和页面既有文字，不执行来源脚本，最终继续经本站HTML白名单。

来源请求语言与声明组件保留参考4947ad03309c64a4002bd073d690aee50c548063的lib/http-fetch.ts、content/extract.ts及来源读取器；适配本站配置校验、采集会话与日期许可身份，HTTP配置对象和旧调用保持兼容。

模型HTTP拒绝与临时故障分类参考4947ad03309c64a4002bd073d690aee50c548063的providers/receipts.ts拒绝码逻辑，使用本站共享服务身份匹配；区分新调用收到的明确拒绝与传输结果未知；历史未知账目保留，不据新的分类回写旧账。

共享服务冷却与单一探测取自4947ad03309c64a4002bd073d690aee50c548063的providers/circuit.ts及llm.ts；本站在独立ai表内持久化相同状态和阈值，使用已有服务配额身份，准入与回执事务相连。无主调用的接续独立记录冷却证据，不补造回执；后台只读显示恢复状态。

逻辑请求恢复与备用选择按4947ad03309c64a4002bd073d690aee50c548063的providers/receipts.ts、llm.ts及operations/recover.ts核对：每回执一次自动恢复、不同输入独立记账，备用failed时回到主请求。资讯额外的材料/报告级未知费用屏障退出；保留准确旧键兼容、实际回执证明、当前许可与法规独有边界。

较早精选的60天阅读背景、同事实背景去重及近期跳过信号的任务补排，对照4947ad03309c64a4002bd073d690aee50c548063的events/recall.ts和jobs/events.ts实现；本站通过publication/content所属入口取数，保留既有人工操作与业务线控制。

信源健康的90天自身节奏、至少4个产出日/4倍间隔、7天持续失败比例与问题分类参考AIHOT `4947ad0` 的 `sources/health.ts` 与 `operations/reports.ts`；本站按各表所有者拆分只读证据，保留北京时间、法规独立范围及既有权限。

worker心跳提醒的发送后记状态与事务锁参考AIHOT `4947ad0` 的 `operations/watch.ts`；本站继续使用现有飞书通道，未配置自动运维Agent唤醒。禁用发送不记录为已通知，实际通知失败由下一轮继续。

读者链接按压预加载、独立PrefetchPageLinks、收起区最小列宽及画布外观观察参考AIHOT `4947ad0` 的 IntentLink、Presence 与 local-state；本站保留原生SSR读取、人工刷新和已验证的返回焦点行为。复制共用现有成功确认与焦点恢复，失败不能显示已复制。

关于页流程画布SignalRiver采用AIHOT `4947ad03309c64a4002bd073d690aee50c548063` 的 `apps/web/app/features/about/SignalRiver.tsx`，替换行业与出刊配置入口；遵循原MIT许可，现有NOTICE与许可说明保持。画布由真实来源样本驱动，后台未提供样本时不得声称来源已接入。

Agent共用中文答案参考AIHOT `4947ad0` 的 `publication/agent.ts` 与 `routes/mcp.ts`；本站适配现有归属链接、当前公开资格、报告引用及法规工具，复用现有publication/llms包入口。旧JSON字段和工具身份不变，未转发参考行业示例。

手机页面标题/返回交互与worker退出470秒等待参考AIHOT `4947ad0` 的 PhoneBar、jobs/queue.ts、apps/worker/src/main.ts；本站继续保留原生React Router阅读恢复、数据库根关闭围栏和正式发布锁。

代理侧DNS解析与固定CONNECT地址、HTTP跳转请求约束参考AIHOT `4947ad0` 的lib/egress-proxy.ts、http-fetch.ts及对应测试；保留原MIT登记。本站继续拒绝生产私网与元数据地址，不启用额外私网白名单。后台日期校正、正文展示预览和反馈小时控制参考同版本admin/content.ts、operations/feedback.ts；本站保留原文日期精度、人工操作、角色隔离及180天反馈留存。

## 2026-10-19 固定最新对照

Owner再次要求按最新代码核对原18项目标。本轮固定为AIHOT `6d82afb854e863ba3456d320820a57a8771ea29f`，相对此前4947新增2个提交、5个文件。英文日期中at的读取及跨年Timeline日标题参考该版 `sources/dates.ts`、`packages/contracts/src/time.ts` 和 `apps/web/app/features/feed/Timeline.tsx`，适配本站严格时区证据、日期精度与北京时间。原MIT版权、NOTICE和历史移植记录继续保留。

归组源码在4947至6d82之间没有变化；本次另按同版 `events/recall.ts` 核对并补齐公开修订驱动的单篇向量缓存、候选资格在排名前过滤。本站使用各数据所有者的窄读取接口实现，保留内容许可、人工归属/撤回/暂停和现有代表稿规则。晚发配套解读与历史重复精选的矿业语义修复由本站实现，未复制参考行业示例，也不宣称整库逐字一致。
