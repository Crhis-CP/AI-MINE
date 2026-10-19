# 旧分支收敛核验（2026-10-19）

本次以主分支`e75f033d0e1b626c9af3fe274464171d4d6f6806`为固定基线，读取GitHub分支、PR元数据及完整Git历史，在独立bare仓库比对。远端共10条分支：`main`及9条旧分支；8个PR仍为open，另有一条日期提案没有PR。GitHub分支分页已读完，并与公共Git fetch取得的分支集合核对。

结论：6条旧分支没有尚未承接的独有成果，可在统一发布验收后列入清理；日报审计PR #224的两处独有修复已在本轮候选中最小承接并独立审查通过，合入及统一验收前保持打开；项目审计和无PR日期提案的独有说明已准备随本次文档提交归档，归档合入后可纳入清理。本次没有关闭PR、删除远端分支、合并旧代码、改动共享工作树的index/ref，或把归档核验说成上线完成。

## 不能只按祖先关系判断

9条旧分支的头都不是当前`main`的直接祖先，但其中5条已完整进入PR #238的历史。核验链为：

- [PR #238](https://github.com/Crhis-CP/AI-MINE/pull/238)最终头`2c74733b9369923eb92f5fcf695da4a6d42454af`与合并提交`468c06e1b15e0bf69012b0fbed5d7788e4037022`的完整tree同为`cb980d00b2267abe743352681702f2ab21a7b08a`；合并提交是当前main的祖先。
- [PR #261](https://github.com/Crhis-CP/AI-MINE/pull/261)最终头`d7d9fec096356fe0a88ba45a65c1fec624b8e0dc`与合并提交`ff833fbdb90ec64b06d947e9b26a4ab73c7486d1`的完整tree同为`905d85f55a93783ad5b298ad31699e415adc04b8`；合并提交也是当前main的祖先。
- GitHub的PR头与实际取得的`refs/pull/<编号>/head`逐项一致。没有用PR标题、提交数或文件存在与否单独代替内容核验。

## 可在统一验收后清理的6条

| PR与分支 | 已核对的头 | 承接证据 |
|---|---|---|
| [#231](https://github.com/Crhis-CP/AI-MINE/pull/231) `agent/architect/TASK-0355-news-sources-assoc-tech` | `e64af534ffc0fed54769770a4372f3a5d4ec5653` | 是PR #238最终头的祖先；协会、技术来源与原始研究记录已进入统一目录，后续接入采用最终清单及生产来源验收口径。 |
| [#232](https://github.com/Crhis-CP/AI-MINE/pull/232) `agent/news/TASK-0356-event-hotspot` | `dcb2b30e65b3198d92d1c8b8f45af30442d3f6c8` | 是PR #238最终头的祖先；现行确认归组、代表稿、精选席位和热点入口承接并继续演进，PR #261又收紧了公开精选的一致性。 |
| [#233](https://github.com/Crhis-CP/AI-MINE/pull/233) `agent/architect/TASK-0357-collection-capabilities` | `403a9faff6f9b6caca5fd12129253eebbec776cc` | 是PR #238最终头的祖先；声明日期、表单翻页及HTML属性JSON列表的实现和回归已在现树。来源当前状态按接入清单与自然任务核对，不沿用旧PR的启用描述。 |
| [#236](https://github.com/Crhis-CP/AI-MINE/pull/236) `codex/aihot-usage-recovery` | `b1eecee3fddc80fa1706395e7f6b4de087d6690f` | 是PR #238最终头的祖先；当前回执、未知一次恢复与请求次数控制已承接，费用、在途结果及人工暂停保护继续有效。 |
| [#237](https://github.com/Crhis-CP/AI-MINE/pull/237) `codex/aihot-selected-translation` | `bebb0a51313f3317b1348adfbd7fe08a0fdc4bc0` | 是PR #238最终头的祖先；当前发布端只给获准精选排全文翻译，部分译文仍绑定修订、配方与原文块，不能冒充完整译文。 |
| [#198](https://github.com/Crhis-CP/AI-MINE/pull/198) `claude/policy-plan-2` | `2f253c626cfc4dd4a4c59423a3ea49f5034bab1c` | 三张任务卡TASK-0086、0095、0110的计划内容已在main保留；差异是后续状态、契约指纹和实施记录。日期解析、seen观察去重、默认只读清理脚本及价格读取也已存在，未发现独有未来条款。 |

`claude/policy-plan-2`的名称不能作为“未整合的未来法规模块计划”的证据。此次核对的是实际三张卡及其差量，历史数据删除仍遵守独立授权边界；关闭旧计划PR不会授权执行清理脚本。

## PR #224保留与另外2条的归档

### PR #224：两处旧修复已最小承接，待统一合入验收

分支`codex/daily-selection-audit`，头`51dc152c41ea85a45c379467328718616260ad55`，对应[PR #224](https://github.com/Crhis-CP/AI-MINE/pull/224)。日报截稿说明已进入主线，旧整期模型写作及恢复路径已被现行规则日报、确定性成员和周月汇编替代；不能整批合并旧`reports/compose.ts`。但以下两处不能标成已被取代：

| 独有改动 | main的实际调用与缺口 | 保留及承接方式 |
|---|---|---|
| 空白正文仍使用有效摘要评分 | `editorial/analyze.ts::buildScoreInput`先做`(bodyText ?? excerpt ?? "").trim()`，正文为空串或空白时直接回退标题，跳过非空摘要；`runScores`使用该输入。 | 旧实现仅改用现有`usableSourceText(bodyText, excerpt)`再回退标题；对应旧`tests/selection-gate.test.ts`。本轮已最小承接，使用有效摘要且仅在摘要也不可用时回退标题。 |
| 来源分级改变后复用原两次分核对近期精选 | `admin/sources.ts::updateSource`修改tier后只排`queueSourceRepublication`；`jobs/publication.ts`调用`republishSource`，再到`publishArticleTx`直接读取`analysis.selected`，没有重算原两次分。 | 旧`publication/selection-recompute.ts`及`tests/source-tier-selection.test.ts`保留：仅近期7日、确认记录门槛改变、两次合法分，人工决定优先，旧格式不猜。本轮已适配现行归组、精选席位、首次公开/精选时刻和撤回控制；历史稿新获提名仍经普通覆盖确认，不恢复旧超时放行。 |

截至本次只读核验，以上是具体代码差异，不是已经发生的生产事故结论，也没有自动执行评分或重投影。旧发布实现还有已退役的归组超时逻辑，不能连同这两处一起移回。本轮已完成最小承接及两轮以内的独立审查：最终追加补丁SHA-256为`6cb17f72aca6d9fb95f2395d81d09324b3e8d0fe4fc0efff1c2700fd60cace3e`，共7文件，6个不同局部用例通过。可空旧提名与明确否定完成不循环已覆盖；没有改写原分析、回执或旧日报。当前工作区完成不等于main已接收，最终完整验证、合入及统一生产质量通过前仍不关闭PR或删除该分支。

### PR #227：审计资产已承接，两份独有说明先归档

分支`codex/project-audit-20261013`，头`b7fcbe44eb24e85df61a5578cfbf2ff2680b0cde`，对应[PR #227](https://github.com/Crhis-CP/AI-MINE/pull/227)。逐字核验结果：

- 原`REPORT.md`、`coverage.json`、`evidence.json`与main同路径blob完全一致。
- 原80条`issues.jsonl`与main的`docs/05-quality/audits/2026-10-13/issues.snapshot.jsonl`完全一致，blob为`4f63ad31b5df9865585e15683c3730766b4b430f`。
- 当前问题台账仍有这80个ID，没有遗漏原ID；后续状态由`audit-disposition.md`和当前台账承接。这不表示80条问题全部修复，也不把历史安全覆盖阻塞改写成安全结论。
- `docs/05-quality/08-audit-ledger.md`和`tasks/TASK-0352.md`未在main保留，已按原始字节另存；前者SHA-256为`8967d1ae67376fe08f012c779c3812a26423553f6a693946ffa2a534cd17578b`，后者为`4181cada1c4c867633b413c4267ae24a5d68d88966fdfdf32857392e58b94213`。

两份原文已放入下述仓库归档目录，随当前文档一起提交；内容逐字保留，以`.md.txt`存放，避免成为新的任务卡或当前规则入口。归档合入后可关闭草稿，不重新建立第二份当前台账，也不恢复旧AGENTS入口或旧状态规则。本轮尚未关闭或删除。

### 无PR日期提案：独有22行先保留，不移回现行任务范围

分支`codex/source-date-integration-plan`，头`e79a201727df881d455bf5535a256f2bdf2ee4e7`。相对共同基线只有`tasks/TASK-0022.md`新增22行：日期消费者的配套允许路径、受限SQL证明和固定夹具方案，以及当时一次性3000有效行的组织范围；没有业务实现。

main未包含这22行。提案引用的`retained-sql-context`、`source-date-transition`等旧证明文件也不在现树，不把这份历史组织方案当成当前实现缺陷或新的修改授权。独有22行已逐字保留为零上下文patch，SHA-256为`262519cb3ce96d879a8374ab34117a0945ba43d36b877385a495b2266b090259`；已在隔离临时目录应用到确切基底，完整还原原文件字节。归档合入前保留分支，不直接回灌现行TASK-0022。

### 随本次提交保留的最小仓库归档

目录为`docs/acceptance/aihot-alignment-20261015/branch-archive-20261019/`：

- [08-audit-ledger.md.txt](branch-archive-20261019/08-audit-ledger.md.txt)：原台账使用说明，3807字节。
- [TASK-0352.md.txt](branch-archive-20261019/TASK-0352.md.txt)：原始审计任务范围及交付记录，2893字节。
- [source-date-integration-plan.patch](branch-archive-20261019/source-date-integration-plan.patch)：独有22行的零上下文差量，2625字节；未重复保存现有TASK-0022全文，恢复方法及确切基底见manifest。
- [manifest.json](branch-archive-20261019/manifest.json)：来源head、原路径、Git blob、原文及归档文件SHA-256；日期patch另含确切基底及完整原文件SHA-256、字节还原结果。

这三份原文/差量均从已读取的固定Git对象生成。日期原文件完整SHA-256为`ffffef92d2332e60c5c0995c97ff471e6e9d2e21f8d8dd487a8a4cc8d7186feb`；其基底与被审计main中的TASK-0022逐字相同。归档是历史资料，不改变当前任务授权或产品规则，也没有复制已在main保存的报告、80条问题记录或大段旧业务代码。当前归档仍随本次提交待合入，不能把本地文件已写好当成主线已保存。

## 恢复归档与复验

独立审计库为`/tmp/aimine-governance-audit-20261019.git`。2026-10-19 `12:58:27 UTC`已生成完整历史bundle，并在第二个全新bare仓库恢复：

| 项目 | 核验结果 |
|---|---|
| 归档 | `/tmp/aimine-governance-audit-20261019/branches-and-pr-heads.bundle` |
| 大小 | 25,516,718字节 |
| SHA-256 | `516d91eb94bb6a2f4abca07931a91051ba18976dc00706977f80fdb78e6624fe` |
| 范围 | 全部10条当前远端分支、0个标签，以及8个open PR和已合并PR #238/#261的head；共20个refs。没有宣称包含每个历史关闭PR的独立ref。 |
| Git对象 | 12,548个可达对象，包含完整历史及文件模式，无浅克隆或外部前置对象依赖。 |
| 校验 | `git bundle verify`通过；空bare恢复后20个refs与12,548个可达对象逐项相同，`git fsck --full --strict --no-reflogs`通过。 |
| 访问限制 | 归档目录及bare目录0700，bundle和验证元数据0600。 |

同目录的`bundle-verification.json`、`refs.txt`、`SHA256SUMS`、`pr-metadata.json`保留完整头指纹及PR元数据；`unique-materials.json`登记独有说明和patch的来源、头指纹、字节数、SHA-256及保存位置。材料均来自已授权读取的公共仓库，没有打包现有环境配置、凭据、生产原始资料或工作树未提交文件。

这份bundle是已验证的临时恢复副本，不替代独有资料的持久归档。实际清理仍由统一发布验收收尾执行：先确认对应成果已承接或归档，再重新读取远端头并与本记录核对；不能按此快照盲删后来发生变化的分支。旧机器上的工作树和未提交内容不在本次可见范围，本记录不授权清理它们。最终验证、生产验收及真正关闭PR/删除分支的结果由仓库治理主记录续记。
