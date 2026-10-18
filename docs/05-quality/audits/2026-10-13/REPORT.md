# AI-MINE 全项目审计与Agent修复报告（安全扫描受阻）

审计日期：2026-10-13（America/Catamarca）。审计/台账任务：TASK-0352。**本次交付是功能、体验和工程保障审计及仓库问题资产；全面安全审计尚未完成，不能据此认定项目没有漏洞。**

本轮登记 **21项当前问题或设计偏差（P1=3、P2=16、P3=2）**、2条待验证线索、1项安全覆盖阻塞，并保留50项旧审计和6项新近修复索引。这里的P级是修复排序，不是CVSS；没有把体验问题包装成可攻击漏洞。F05/F06已有在途任务。

## 基线与结论边界

- 当前结论绑定远端main `154246979cd69a865f9d074c2b9974df7db9a405`，本轮用ls-remote核对。原打开分支`5c922cb`含旧上线补记但缺主干后续实现；所有发现相关文件已对照主干。报告写在独立worktree，没有修改原工作区或产品代码。
- 最新主干内发布摘要记录生产程序`c2568e0...`及21阶段完整回执；本轮只读该历史记录，未重新访问生产，也不把它当本轮main的完整回执。反馈字数提示已入main，专门线上验证仍需按该行为判断。
- `pnpm check`本轮10/10通过，法规4文件22项离线回归通过；四项界面问题本地Chrome源组件+合成API复现，另复现报告依赖/引用schema和无证据live状态。检查通过没有覆盖全部缺陷。
- Quick没有web build，因此未运行全套浏览器测试；未运行数据库角色/并发矩阵、full verify、线上攻击、负载/恢复或真实模型质量评测。覆盖及证据见[coverage.json](coverage.json)、[evidence.json](evidence.json)。
- 安全插件没有启动：`Deep Scan cannot safely start a read-only worker: the parent must provide a managed filesystem permission profile.` 当前会话缺所需受管权限配置；本次未改配置或换扫描器绕过。Daybreak返回not_granted，申请入口[Daybreak](https://chatgpt.com/cyber)；该账号状态不构成产品安全结论。

## 问题索引与执行顺序

当前状态唯一维护于[issues.jsonl](../../issues.jsonl)，本报告是日期快照。每项下面有触发、影响、源代码、修复边界与验收；建议责任泳道不替代任务卡写权。

| ID | 优先级 | 范围 | 状态/证据 | 问题 |
|---|---|---|---|---|
| F01 | P1 | content | confirmed / static_confirmed | 旧修订任务的异常写回未绑定修订，可能阻断新材料处理 |
| F02 | P1 | publish | confirmed / pure_reproduction | 资讯周月报未追踪全部模型输入，撤回传播可能遗漏综述依赖 |
| F03 | P2 | publish | confirmed / pure_reproduction | 资讯周月报空、越界或重复引用仍被接收并标ready |
| F04 | P2 | sources | confirmed / static_confirmed | 详情标题规则让已采URL长期冻结旧标题 |
| F05 | P1 | publish | in_progress / static_confirmed | 报告综合失败发生在落库之前，有精选仍整期缺失 |
| F06 | P2 | publish | in_progress / static_confirmed | 日报快讯未进入近七日同事实去重 |
| G01 | P2 | architect | confirmed / pure_reproduction | 上线或质量验收状态可在没有证据时通过任务校验 |
| G02 | P2 | architect | confirmed / enumerated | 任务索引漏37张卡，部分上线状态停留在旧结论 |
| G03 | P2 | architect | confirmed / static_confirmed | 完整验证阶段通过不等于所有PIT预防控制已接入 |
| G04 | P3 | architect | confirmed / static_confirmed | 历史验收原始证据缺少可跨工作树定位的脱敏清单 |
| G05 | P2 | architect | confirmed / local_command_reproduction | 本地固定版本pnpm普通命令会改写包管理器锁元数据 |
| U01 | P2 | publish | confirmed / static_confirmed | 资讯全文检索遗漏中文译文和原文12000字符后的内容 |
| U02 | P2 | private | confirmed / local_browser_reproduction | 后台修改其他字段会清空已经填写的操作原因 |
| U03 | P2 | private | confirmed / local_browser_reproduction | 后台Field标签指向span，控件缺少正确可访问名称 |
| U04 | P2 | private | confirmed / local_browser_reproduction | 后台确认弹窗的键盘焦点可以进入背景 |
| U05 | P2 | web | confirmed / local_browser_reproduction | 收藏例行核对失败清空已显示列表 |
| U06 | P2 | web | confirmed / static_confirmed | 法规补充搜索缺应用层超时，拖住新闻搜索结果 |
| U07 | P2 | web | confirmed / static_confirmed | 错误日期范围变成服务繁忙，用户无法就地修正筛选 |
| U08 | P2 | web | confirmed / static_confirmed | 法规首批正文完全依赖JS加载，不满足首屏SSR正文要求 |
| U09 | P2 | web | confirmed / static_confirmed | 法规semantic_html表格缺命名且可聚焦的滚动区域 |
| U10 | P3 | web | confirmed / spec_deviation | 手机输入字号小于既定16px下限 |

优先处理F01/F02；F05/F06接续[PR224](https://github.com/Crhis-CP/AI-MINE/pull/224)，不要重复造日报修复。安全扫描是独立必补工作。检索U01、后台输入丢失U02、收藏U05、搜索等待U06随后处理；同文件的U02/U03/U04可共用一个有界任务但分别验收。

## 逐项交接

### F01 · P1 · 旧修订任务的异常写回未绑定修订，可能阻断新材料处理

**影响与触发：** 较旧分析调用的异常可能把新修订的new或已完成状态改成failed/new，错误、重试次数和排队状态失真；安全网只扫new时可能不再自动续处理。未测生产发生率。 r1等待模型时材料推进r2；r1随后不可重试拒绝、unknown或达到坏输出阈值。正常分析提交有revision CAS，但afterFailure、unknown分支及成功清理只按articleId更新。
**依据与边界：** [packages/backend/src/jobs/content.ts:202](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/jobs/content.ts#L202)；[packages/backend/src/jobs/content.ts:217](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/jobs/content.ts#L217)；[packages/backend/src/jobs/content.ts:279](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/jobs/content.ts#L279)；[packages/backend/src/jobs/content.ts:341](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/jobs/content.ts#L341)；[packages/backend/src/editorial/analyze.ts:716](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/editorial/analyze.ts#L716)。规格：BR-MAT-04, BR-PUB-08。验证层级：`static_confirmed`；未取得本次整合/线上/质量验收。
**修复与验收：** 在同一领取/执行身份中传递预期revision，对异常、unknown、成功清理和抽取失败写回统一CAS；旧任务返回stale，不修改当前修订状态。保留真实回执和unknown禁重买。涉及任务载荷变更先开契约卡。 验收：隔离库+gate假模型：挂起r1，产生r2，再分别释放400/503/超时/unknown/坏输出；确认r2的state/error/attempt/retry/queued字段不变且可由真实队列或安全网继续。补r2已完成后r1才失败。

### F02 · P1 · 资讯周月报未追踪全部模型输入，撤回传播可能遗漏综述依赖

**影响与触发：** 某输入可能影响overview/headline，但没有进入主题显式引用时，撤回或更正该输入不会自动使相关综合文字失效；不是已观察到线上内容泄漏。 模型输入top为A+B，主题refs仅选A；storyOrder保存A+B，但reportMemberIds/reportCitations只读取展示引用和未在首版设置的sourceMemberIds。撤回B不命中更正或读时检查。
**依据与边界：** [packages/backend/src/reports/compose.ts:278](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/reports/compose.ts#L278)；[packages/backend/src/reports/compose.ts:309](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/reports/compose.ts#L309)；[packages/backend/src/reports/references.ts:15](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/reports/references.ts#L15)；[packages/backend/src/reports/corrections.ts:42](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/reports/corrections.ts#L42)；[packages/backend/src/publication/reports.ts:182](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/publication/reports.ts#L182)。规格：BR-RPT-04, BR-RPT-05, INV-03。验证层级：`pure_reproduction`；未取得本次整合/线上/质量验收。
**修复与验收：** 完整记录实际模型输入的材料/公开版本身份，后续失效和更正使用此集合；排版引用单列。存量storyOrder可作为缺口线索，不补造历史版本证明。 验收：假模型在overview使用B而theme仅引用A；撤回/更正B后详情、目录、RSS、API立即不再暴露旧综合，生成正确更正任务。补模型在途撤回、许可收紧和版本改变。

### F03 · P2 · 资讯周月报空、越界或重复引用仍被接收并标ready

**影响与触发：** 读者得到没有有效引用的主题或重复条目；机器把不完整综合当ready，统计可能重复。与F02根因不同。 PeriodSchema接受refs=[]、[999]、[1.5]、[1,1]；映射静默丢弃无效编号或重复保留A，随后仅按receiptId标ready。更正路径复用同一逻辑。
**依据与边界：** [packages/backend/src/reports/compose.ts:246](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/reports/compose.ts#L246)；[packages/backend/src/reports/compose.ts:309](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/reports/compose.ts#L309)；[packages/backend/src/reports/correction-compose.ts:62](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/reports/correction-compose.ts#L62)。规格：BR-RPT-02, BR-RPT-04, PG-07。验证层级：`pure_reproduction`；未取得本次整合/线上/质量验收。
**修复与验收：** 在已知输入集合后校验整数、范围、非空和唯一性；按既有坏输出规则处理非法引用，不能过滤后继续ready；首次编排与更正共用校验。 验收：假模型覆盖空数组、负数、0、小数、越界、非数字字符串、同主题/跨主题重复与合法引用；非法内容不公开ready、合法引用与统计一致，不新增未知费用重试。

### F04 · P2 · 详情标题规则让已采URL长期冻结旧标题

**影响与触发：** 已成功采集的同一URL后来更正标题，现行路径可能一直保存旧题，缺少真实修订；正文已ok时也不会靠正文再抓修复。 来源配置detail.titleSelector/titleRegex；storedTitles命中时把新候选标题替换为旧值并continue，不重取详情。避免短列表覆盖长标题的保护同时吞掉真实更正。
**依据与边界：** [packages/backend/src/sources/collect.ts:238](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/sources/collect.ts#L238)；[packages/backend/src/sources/collect.ts:250](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/sources/collect.ts#L250)；[packages/backend/src/content/extract.ts:134](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/content/extract.ts#L134)。规格：BR-MAT-04。验证层级：`static_confirmed`；未取得本次整合/线上/质量验收。
**修复与验收：** 用列表指纹/更新时间/条件请求或有界周期区分重采与真实变化，再核验详情标题；不要简单删除保护造成重复修订。 验收：本地假站三轮：短列表+正式详情题首次采集；不变重采零修订；同URL真实更正恰好一份新修订且ID/旧版保留。补详情失败恢复和人工修订优先。

### F05 · P1 · 报告综合失败发生在落库之前，有精选仍整期缺失

**影响与触发：** 模型故障扩大为读者看不到该期的确定性条目汇总。日报已有在途修复；周月报同类路径仍需纳入明确范围。 writeLead/chatJson因网络、路由、熔断或非法输出抛错，saveReport尚未运行；反复补刊仍遇到相同错误。
**依据与边界：** [packages/backend/src/reports/compose.ts:214](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/reports/compose.ts#L214)；[packages/backend/src/reports/compose.ts:288](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/reports/compose.ts#L288)；[tasks/TASK-0350.md:28](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/tasks/TASK-0350.md#L28)。规格：BR-RPT-03, BR-RPT-04, AI-13。验证层级：`static_confirmed`；未取得本次整合/线上/质量验收。关联：TASK-0348, TASK-0350。
**修复与验收：** 接续TASK-0348/0350及PR224，不另立重复日报实现。先保存版本绑定的确定性刊期，AI只补同一期综合；诚实标状态，unknown不重买。周月报范围补到相应卡。 验收：隔离库假模型失败后本期仍可读汇总且非ready；恢复补综合不换成员、不重复计费；在途暂停/撤回/更正不得复活旧内容。

### F06 · P2 · 日报快讯未进入近七日同事实去重

**影响与触发：** 同一事实第一天作为快讯、第二天另一来源成为精选时可重复占用版面。 recentlyCovered只遍历sections；生成flashes又丢弃factId，因此同事实换itemId可再次入刊。
**依据与边界：** [packages/backend/src/reports/compose.ts:87](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/reports/compose.ts#L87)；[packages/backend/src/reports/compose.ts:191](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/reports/compose.ts#L191)。规格：BR-RPT-02。验证层级：`static_confirmed`；未取得本次整合/线上/质量验收。关联：TASK-0350。
**修复与验收：** 复用TASK-0350/PR224，快讯保留事实身份并参与去重；存量缺身份不能猜测补齐。 验收：构造栏目容量溢出的第一天快讯及第二天同事实另一来源，断言不重复；新事实仍可入选，七日边界不变。

### G01 · P2 · 上线或质量验收状态可在没有证据时通过任务校验

**影响与触发：** 下一位Agent可能把状态文案当成真实验收；本项不证明过去回执伪造。 合法任务frontmatter仅改为live_verified并删掉正文/evidence，checkCard仍返回[]；校验器只检查枚举和可选数组。
**依据与边界：** [scripts/verify/tasks.ts:68](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/scripts/verify/tasks.ts#L68)；[scripts/verify/tasks.ts:72](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/scripts/verify/tasks.ts#L72)。规格：PIT-073。验证层级：`pure_reproduction`；未取得本次整合/线上/质量验收。
**修复与验收：** 仅对live_verified/quality_accepted要求非空有效证据及环境/版本/范围；实现态不增加发布门槛，原始生产数据继续私有。 验收：无证据、空数组、失效引用三负例失败；有脱敏验收摘要的正例通过；不写断言散文措辞的测试。

### G02 · P2 · 任务索引漏37张卡，部分上线状态停留在旧结论

**影响与触发：** 按AGENTS入口续接的Agent会漏看近期任务或重复修已交付能力。审计前main有299卡而索引262行，缺0315至0351。 checkTasks只检查卡，不比对INDEX；TASK0318/0341/0342等仍有待实施/未上线表述，而后续发布记录已确认相应范围。
**依据与边界：** [tasks/INDEX.md:3](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/tasks/INDEX.md#L3)；[scripts/verify/tasks.ts:95](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/scripts/verify/tasks.ts#L95)；[tasks/TASK-0318.md:24](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/tasks/TASK-0318.md#L24)；[docs/acceptance/release-polish-20261014/README.md:3](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/docs/acceptance/release-polish-20261014/README.md#L3)。规格：PIT-073, PIT-079。验证层级：`enumerated`；未取得本次整合/线上/质量验收。
**修复与验收：** 主干用已有生成器更新索引并校验ID/标题/状态/依赖漂移；避免最后提交号形成自引用循环。历史快照保留，补当前证据回链；只按已验收范围升状态。 验收：干净checkout仅凭台账→卡→验收摘要可判断状态；漏卡或状态漂移应被检测；索引重复生成稳定。

### G03 · P2 · 完整验证阶段通过不等于所有PIT预防控制已接入

**影响与触发：** scope:full只表示代码中已实现阶段全跑，容易被误解为107条坑点已有全部自动防线。现有回执仍有效；product-update已接入，不能误列未实现。 main的PENDING_STAGES仍列pit-checks，TASK0011为specified；full条件只比较已实现STAGES。contracts已有实际阶段但pending标签仍未清理。
**依据与边界：** [scripts/verify/run.ts:45](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/scripts/verify/run.ts#L45)；[scripts/verify/run.ts:748](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/scripts/verify/run.ts#L748)；[tasks/TASK-0011.md:1](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/tasks/TASK-0011.md#L1)。规格：PIT-073, PIT-079。验证层级：`static_confirmed`；未取得本次整合/线上/质量验收。关联：TASK-0011。
**修复与验收：** 先映射PIT→现有检查→缺口，复用已有names/roles/ownership/业务回归；清除过时pending并如实列尚未覆盖的控制，不为每个PIT另造门禁。 验收：回执能区别已实现阶段完整运行与文档控制覆盖；每个高影响缺口有承接任务及真实负例。

### G04 · P3 · 历史验收原始证据缺少可跨工作树定位的脱敏清单

**影响与触发：** 换机器或工作树后难以找到原始验收。保留.verify不入库本身正确，不代表没有上线。 发布记录把原始证据定位为发布工作区.verify，旧整改matrix仍是production_verified=false，缺统一稳定回链。
**依据与边界：** [docs/acceptance/release-polish-20261014/README.md:27](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/docs/acceptance/release-polish-20261014/README.md#L27)；[docs/acceptance/audit-remediation-20261011/remediation-matrix.json:1](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/docs/acceptance/audit-remediation-20261011/remediation-matrix.json#L1)；[.gitignore:19](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/.gitignore#L19)。规格：PIT-073。验证层级：`static_confirmed`；未取得本次整合/线上/质量验收。
**修复与验收：** 增加脱敏manifest：版本/tree、run URL、制品摘要、时间/环境/范围、文件hash、受控存储定位及关闭的问题ID；不把生产原始内容复制进Git。 验收：另一个干净worktree可定位验证摘要和受控原始证据；索引不含账号、消息原文或密钥。

### G05 · P2 · 本地固定版本pnpm普通命令会改写包管理器锁元数据

**影响与触发：** 仅检查版本也会使工作区锁文件变脏，其他Agent容易将其误当依赖变更或夹带提交；本轮quick通过不代表整个执行过程保持原锁字节。未修改业务依赖版本。 Node24.19.0调用现有pnpm12.8.1的JS入口；将pnpm-lock.yaml恢复HEAD后仅执行pnpm --version，再次删除25行@pnpm/exe自管理元数据。原工作区和隔离worktree出现相同变动。
**依据与边界：** [package.json:5](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/package.json#L5)；[pnpm-lock.yaml:7](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/pnpm-lock.yaml#L7)；[scripts/verify/toolchain.ts:61](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/scripts/verify/toolchain.ts#L61)。规格：。验证层级：`local_command_reproduction`；未取得本次整合/线上/质量验收。
**修复与验收：** 统一受支持的包管理器启动方式，在现有执行器验证版本/检查命令不改锁；先定位JS入口和独立可执行版本的元数据差异，不把偶发脏锁顺手提交，不放宽frozen约束。本次仅恢复已逐字确认的该25行变化，未覆盖其他变动。 验收：干净checkout在Node24和pnpm12.8.1下分别跑版本查询、quick，比较锁SHA和git状态；不同受支持启动器应得到稳定结果，业务依赖摘要保持。

### U01 · P2 · 资讯全文检索遗漏中文译文和原文12000字符后的内容

**影响与触发：** 读者在详情刚读到的中文短语或长文尾部条款搜不到；与已修复的法规全文检索是两条实现。 公开中文正文中的词未出现在原文/标题/摘要，或独特词仅出现在原文第12001字符之后。pool_search只写原文前12000字符。
**依据与边界：** [packages/backend/src/publication/publish.ts:445](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/publication/publish.ts#L445)；[packages/backend/src/publication/pool.ts:196](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/publication/pool.ts#L196)；[docs/01-product/03-reader-pages.md:649](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/docs/01-product/03-reader-pages.md#L649)。规格：PG-09, F-RDR-03。验证层级：`static_confirmed`；未取得本次整合/线上/质量验收。
**修复与验收：** 从当前获准公开的真实正文生成完整索引，覆盖中文译文与人工正文；译文变化、修正及许可收紧同步刷新或删除，不索引未获准公开原文。 验收：经正式发布函数生成索引：译文独有词、12001字符后词命中；人工更正旧词不命中新词命中；仅导读许可不能用正文命中。禁止直接种pool_search绕过写入链。

### U02 · P2 · 后台修改其他字段会清空已经填写的操作原因

**影响与触发：** 管理员丢失输入，提交失败需重填；重复初始化还会把焦点拉回原因框。 ReasonDialog先填写原因，再改父组件的标题/正文/范围；onClose内联回调身份变化触发effect，执行setReason空字符串。
**依据与边界：** [apps/web/app/features/admin/ui.tsx:323](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/features/admin/ui.tsx#L323)；[apps/web/app/routes/admin/content-item.tsx:1](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/routes/admin/content-item.tsx#L1)。规格：OP-00。验证层级：`local_browser_reproduction`；未取得本次整合/线上/质量验收。
**修复与验收：** 只在关闭转打开或明确切换对象时初始化；回调监听、初始聚焦和字段状态分开，失败保留输入。 验收：先填原因后编辑其他字段、提交400/409/503，原因及焦点不变；关闭重开才初始化。

### U03 · P2 · 后台Field标签指向span，控件缺少正确可访问名称

**影响与触发：** 使用Field且没有额外aria-label的控件无法按可见标签被读屏或辅助导航识别；点击标签不可靠聚焦。 label.htmlFor指向包裹children的span.id，而非input/select/textarea；本地Chrome按标题或原因标签查找textbox均为0。
**依据与边界：** [apps/web/app/features/admin/ui.tsx:190](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/features/admin/ui.tsx#L190)。规格：OP-00。验证层级：`local_browser_reproduction`；未取得本次整合/线上/质量验收。
**修复与验收：** 生成id交给真实控件或使用合法隐式关联，hint/error用aria-describedby；复合字段分别命名。 验收：读屏可访问名称匹配可见标签；点击标签聚焦；提示及错误可读。对共享组件做代表性回归，不重复每个字段。

### U04 · P2 · 后台确认弹窗的键盘焦点可以进入背景

**影响与触发：** aria-modal声明与真实行为不符；键盘可能触发背景动作，关闭后也无焦点恢复，弹窗本身没有可访问名称。 打开ReasonDialog，从输入框连续Tab越过取消/确认，本地Chrome的activeElement进入背景按钮。
**依据与边界：** [apps/web/app/features/admin/ui.tsx:323](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/features/admin/ui.tsx#L323)。规格：OP-00。验证层级：`local_browser_reproduction`；未取得本次整合/线上/质量验收。
**修复与验收：** 使用原生dialog.showModal或已验证模态实现，限制焦点、背景不可交互、关联标题并在关闭时恢复触发点；与U02初始化问题分别验收。 验收：Tab/Shift+Tab留在框内；背景不可触达；Escape关闭后回触发按钮；读屏读出标题与描述。

### U05 · P2 · 收藏例行核对失败清空已显示列表

**影响与触发：** 阅读被闪空或持续错误打断；数据请求失败和确认下架未区分。新闻收藏已复现，法规/事件同类路径为静态确认。 收藏正常显示1条，60秒定时或focus触发核对；请求延迟/503。每次先setItems空数组，失败继续为空，但收藏引用数量仍为1。
**依据与边界：** [apps/web/app/routes/starred.tsx:33](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/routes/starred.tsx#L33)；[apps/web/app/features/policy/PolicySaved.tsx:46](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/features/policy/PolicySaved.tsx#L46)；[apps/web/app/features/story/StorySaved.tsx:50](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/features/story/StorySaved.tsx#L50)。规格：PG-10。验证层级：`local_browser_reproduction`；未取得本次整合/线上/质量验收。
**修复与验收：** 区分首次加载与后台刷新；短暂失败保留前一份已确认可公开内容并提示无法确认最新状态，仅明确404/410/撤回时移除对应对象，不得保留已确认撤回标题。 验收：pending/503/timeout保留内容与位置；恢复正常更新；真实下架只移除对应项。资讯、法规、事件三类均验证。

### U06 · P2 · 法规补充搜索缺应用层超时，拖住新闻搜索结果

**影响与触发：** 新闻查询已经成功，辅助法规查询长期不结束时整页仍不返回；catch只有抛错后才显示部分失败。 /all?q的主请求有15秒timeout，后续await政策查询只带request.signal且客户端没有统一timeout。
**依据与边界：** [apps/web/app/routes/all.tsx:39](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/routes/all.tsx#L39)；[apps/web/app/routes/all.tsx:53](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/routes/all.tsx#L53)；[packages/api-client/src/public.ts:1](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/api-client/src/public.ts#L1)。规格：PG-09。验证层级：`static_confirmed`；未取得本次整合/线上/质量验收。
**修复与验收：** 法规补充查询设独立有限超时，两个查询可并行；辅助查询失败保留新闻结果及提示，导航取消两条请求。 验收：fixture新闻立即成功、法规永不结束，在约定时限内出现新闻与法规失败提示；取消导航取消两请求；恢复后可重试。

### U07 · P2 · 错误日期范围变成服务繁忙，用户无法就地修正筛选

**影响与触发：** 输入错误被误报成网站故障，筛选表单与合法条件消失。 from晚于to；Filters未本地限制，API返回400，loader抛出，根错误边界除404外统一服务繁忙。
**依据与边界：** [apps/web/app/features/feed/Filters.tsx:306](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/features/feed/Filters.tsx#L306)；[apps/api/src/routes/site.ts:89](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/api/src/routes/site.ts#L89)；[apps/web/app/root.tsx:55](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/root.tsx#L55)。规格：PG-01, PG-09。验证层级：`static_confirmed`；未取得本次整合/线上/质量验收。
**修复与验收：** 客户端日期关系提示+服务端校验；可恢复400作为保留表单的字段错误返回，不仅前端拦截，不把503也当输入错。 验收：反向范围、非法日期URL、指定日与范围冲突显示具体错误并保留合法条件，改正可继续查询；真503仍显示服务故障。

### U08 · P2 · 法规首批正文完全依赖JS加载，不满足首屏SSR正文要求

**影响与触发：** 禁用JS、脚本或水合失败时只有标题/解读，正文长期为0节点；未做无脚本端到端实测。 详情API返回blocks空数组与offset0游标；loader只取详情，PolicyReading streams初始空，useEffect才加载正文。
**依据与边界：** [packages/backend/src/publication/policies.ts:309](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/publication/policies.ts#L309)；[apps/web/app/routes/policy.tsx:26](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/routes/policy.tsx#L26)；[apps/web/app/features/policy/PolicyReading.tsx:91](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/features/policy/PolicyReading.tsx#L91)；[apps/web/app/features/policy/PolicyReading.tsx:173](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/features/policy/PolicyReading.tsx#L173)。规格：PG-18。验证层级：`static_confirmed`；未取得本次整合/线上/质量验收。
**修复与验收：** loader经现有公开正文端读取首批并SSR，游标继续绑定版本/许可；渐进续读不混版，不直接读取私有正文。涉及公开契约改变时先开契约卡。 验收：无JS的首份HTML含当前获准首批20节点；有JS不重复；续读版本切换或404/409时停止旧内容。

### U09 · P2 · 法规semantic_html表格缺命名且可聚焦的滚动区域

**影响与触发：** 真实富文本表格路径缺少辅助技术区域名称/键盘焦点语义；部分浏览器滚动操作受限，跨浏览器方向键表现待测。 正文块semantic_html含宽表格，直接注入div；只有备用table_rows分支包裹带aria-label/tabIndex的section。
**依据与边界：** [apps/web/app/features/policy/PolicyReading.tsx:22](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/features/policy/PolicyReading.tsx#L22)；[apps/web/app/features/policy/PolicyReading.tsx:34](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/features/policy/PolicyReading.tsx#L34)；[docs/01-product/03-reader-pages.md:910](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/docs/01-product/03-reader-pages.md#L910)。规格：PG-18。验证层级：`static_confirmed`；未取得本次整合/线上/质量验收。
**修复与验收：** 两种表格输出统一有名称、可聚焦的横向滚动容器；保留rowspan/colspan/删除线等法律结构。 验收：320/390/1440宽两条路径均不撑开整页；Tab可达、方向键滚动、名称读出；结构不损失。

### U10 · P3 · 手机输入字号小于既定16px下限

**影响与触发：** 已确认字号规格偏差；手机聚焦缩放/布局移动仅为待真机验证风险，未宣称已复现。 搜索输入15px、法规fieldClass13px、反馈14.5px，移动端未覆盖为16px。
**依据与边界：** [apps/web/app/features/feed/Filters.tsx:181](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/features/feed/Filters.tsx#L181)；[apps/web/app/features/policy/PolicyUI.tsx:27](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/features/policy/PolicyUI.tsx#L27)；[apps/web/app/routes/feedback.tsx:223](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/apps/web/app/routes/feedback.tsx#L223)；[docs/01-product/03-reader-pages.md:313](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/docs/01-product/03-reader-pages.md#L313)。规格：PG-09。验证层级：`spec_deviation`；未取得本次整合/线上/质量验收。
**修复与验收：** 移动端input/select/textarea至少16px，桌面断点再缩小；不得禁止用户缩放。 验收：320/390宽计算字号不小于16px；Safari真机聚焦与收键盘观察视口，200%缩放仍可阅读提交。

## 待核查线索与明确排除

- **L01 法规工作流一次未分类异常后的自动续跑路径待验证**：policyWorkflowFailed写acquire/failed；相同原件/配置/配方下previousStatus不在runnable恢复集合。 可能使可恢复阶段变成failed后不再自动续跑；尚未确认实际可达异常及管理员恢复语义，不能称历史POL-02复发。 证据：[packages/backend/src/policy/automation.ts:47](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/policy/automation.ts#L47)；[packages/backend/src/policy/automation.ts:87](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/policy/automation.ts#L87)；[packages/backend/src/policy/automation.ts:203](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/policy/automation.ts#L203)。下一步：隔离库在partial阶段假端口只抛一次暂时异常，第二轮相同原件确认能否续fulltext/interpret，保存状态转移。
- **L02 首轮采集可能在核对详情权威日期前裁掉候选**：firstImport先按列表时间截断，之后才清除publishedAtAuthoritative声明为不权威的列表日期。 可能造成首轮漏采或延迟；后续普通轮不套首轮截止，不能据此断言永久丢失。 证据：[packages/backend/src/sources/collect.ts:225](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/sources/collect.ts#L225)；[packages/backend/src/sources/collect.ts:245](https://github.com/Crhis-CP/AI-MINE/blob/154246979cd69a865f9d074c2b9974df7db9a405/packages/backend/src/sources/collect.ts#L245)。下一步：列表日期旧、详情日期新且权威，首轮核对入库；无权威日期和后续轮作对照。
- 不列为BUG：法规切换语言进入该语言当前版本（规格明确）；法规普通列表30/60条有TASK-0094范围决定；资讯只补近7天/上周/上月符合当前规则；unknown回执不会按时间自动解锁；正文抽取worker已间接注册；反馈不足10字提示主干已修。不得通过修复这些“疑点”擅改产品。

## 历史修复复利资产

旧[整改矩阵](../../../acceptance/audit-remediation-20261011/remediation-matrix.json)的50个ID已原样别名导入台账，仍保留原reported_implemented和当时production_verified=false。除以下抽样外，未逐项重新复现，不能批量重新开问题或批量关闭。原[107条PIT](../../02-pitfalls.md)保持不改；它们是历史教训数，不是当前漏洞数。

| 抽样领域 | 可复用实现/回归入口 | 当前判断及局限 |
|---|---|---|
| 日期语义与北京日筛选 | `tests/source-date-automatic.test.ts`；`tests/timeline-date-filter.test.ts` | 实现和针对性断言存在；旧失败日志不能代表当前仍失败。未重跑该数据库回归。 |
| 法规中文全文、非默认语言检索 | `tests/policy-round2-public.test.ts`；`packages/backend/src/publication/policies.ts` | 当前已实现中文末段检索及稳定默认语言，不能继续沿用首轮“没有全文搜索”。资讯U01是不同实现。 |
| 默认中文与当前修订绑定 | `tests/translate.test.ts`；`tests/body-images.test.ts` | 旧译文不冒充当前正文的回归存在；不等于全部真实外文都已完成翻译。 |
| 下架后的报告与RSS派生内容 | `tests/report-withdrawal.test.ts`；`tests/reader-rss-round2.test.ts` | 历史显式引用/快讯撤回已有保护；F02是未被显式引用的模型输入依赖缺口，不能由既有通过推导它也覆盖。 |
| 账号生命周期与单连接权限 | `tests/account-lifecycle.test.ts`；`packages/backend/src/admin/account-access.ts` | 具名登录、强制改密、并发单连接与撤权回归存在；未进行本轮安全扫描或生产身份测试。 |
| 数据归属及完整门禁 | `scripts/verify/data-ownership.ts`；`docs/acceptance/release-polish-20261014/README.md` | 本轮quick ownership通过；历史200项失败不能作为现状。保留UNKNOWN仍未证明，不等于生产角色权限完全落地。 |
| 来源日期冲突、日期精度修复 | `tests/source-date-automatic.test.ts`；`tests/labeled-publication-date.test.ts` | 修复与回归存在；本次只核代码/断言，不追加当前生产供稿证明。 |
| 已评分无精选的安静日报 | `tests/report-quiet.test.ts`；`tasks/TASK-0334.md` | 代码及隔离回归存在；根分支5c922cb的旧发布记录记两期线上验证；主干卡未回链。不是F05模型失败或截稿后归期问题。 |
| 反馈飞书完整转发与防重 | `tests/feedback-forward.test.ts`；`packages/backend/src/operations/feedback-forward.ts` | 实现及合成带图/联系方式/未知结果回归存在；历史真实验收仅纯文字，带图及联系方式线上未验收。 |
| 明确截断响应的已付费结果复用 | `tests/receipt-truncation.test.ts`；`tasks/TASK-0344.md` | 主干有同配置五次尝试一次请求、显式输出预算改变才重发的回归；最新发布记录记自然归组及长文恢复保留。 |
| 反馈最少字数提示 | `apps/web/app/routes/feedback.tsx`；`tasks/TASK-0347.md` | 已合入主干并有本地桌面/手机记录；不把前一轮隐藏关联页面的上线证据当该提示的专门生产验收。 |
| 金属日价与发布更新日志 | `docs/acceptance/release-polish-20261014/README.md`；`scripts/verify/product-update.ts` | 最新发布摘要记录12条真实报价、电脑/390px展示与更新日志；首次手动入库不替代自然定时取价。 |

历史纯文字反馈及安静日报的补记目前位于[原分支已提交发布记录](https://github.com/Crhis-CP/AI-MINE/blob/5c922cb47773804c392538f192dda3b825c2c909/docs/acceptance/release-20261012/live-release-20261014.md)；最新日价/更新日志记录见[主干发布摘要](../../../acceptance/release-polish-20261014/README.md)。这些是过去观察，未以本轮线上实测冒名。

## 验证、恢复资料与后续分工

- 本轮依赖安装使用离线缓存、frozen lock且忽略生命周期脚本，无下载。随后版本/quick调用触发25行包管理器自管理元数据变化，已复现登记G05并精确恢复，未更改业务依赖；不能称全过程锁文件从未变化。Node24.19/pnpm12.8.1；quick原日志在本worktree`.verify/check-logs/main-154246979cd6/`，各文件SHA-256已记录在evidence.json。
- 法规离线命令：`env -i PATH=<Node24路径>:/usr/bin:/bin NODE_ENV=test MODEL_CALLS_ENABLED=false AMP_CREDENTIALS_DIR=/nonexistent-audit-credentials node --test tests/policy-processing-plan.test.ts tests/policy-fulltext-candidate.test.ts tests/policy-encoding.test.ts tests/policy-reading-semantics.test.ts`，22/22。主Agent在固定主干再次执行，未使用数据库。
- 纯函数复现：导入`reports/references.ts`的reportMemberIds，输入`themes=[{storyRefs:[{itemId:"A"}]}],storyOrder=["A","B"]`，返回只有A；PeriodSchema对空、999、小数和重复引用均通过。合法任务仅frontmatter写live_verified且无正文/evidence，checkCard仍返回[]。原结果在evidence.json。
- 本地Chrome实际观察：编辑父字段后原因由非空变空；可见标签对应textbox数量0；Tab进入背景按钮；收藏合成503后标题数量1→0而引用计数保持1。未运行全站浏览器矩阵，法规SSR/表格/iOS项的实机结果待验。
- 任务包建议：A content异常CAS(F01)；B publish报告依赖+引用(F02/F03)；C sources标题变更(F04)；D现有日报PR(F05/F06)；E中文完整搜索(U01)；F后台基础组件(U02—U04)；G读者恢复(U05—U07)；H法规首屏/表格及移动(U08—U10)；I台账证据(G01—G04)。共享文件组顺序实施，其他组可并行；每卡仍遵守≤400行、契约和测试规则。
- 安全部分应在具备受管只读权限的扫描会话完成：认证/授权/会话、CSRF、SSRF/抓取与附件、XSS/HTML、注入、上传与滥用、公开/私有MCP、许可/付费、依赖/镜像/历史秘密。先取正式报告及覆盖，未修漏洞的可攻击细节不直接推送公开仓库。
- 运行补验：隔离库并发/角色矩阵、全站可访问性与手机、压力/长时运行/备份还原、真实法规完整质量、带图/联系方式反馈、自然日价定时。按原授权边界安排；不要为了关闭一条文档问题强行部署或发送测试消息。
- 本次没有修复产品缺陷、修改契约/迁移/模型/信源/生产配置，也没有创建外部漏洞Issue。报告与台账已形成；安全范围未完成，因此不提供虚假的整体漏洞发现百分比或“零漏洞”证明。
