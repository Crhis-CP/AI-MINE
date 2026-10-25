# 报告补刊等待修复：独立发布准备

对应任务书第四部分第2项、TASK0428、Issue293。公开日志正文与发布清单保持现役；当前只准备可审阅制品，未执行生产部署。

## 版本范围

以当前线上64b2ca18cbec038188b7a90a08c4bdc1ecd63e20为基线，复用codex/reader-changelog-20261024分支，仅移植PR299中相同的composePeriod等待处理。相对现役的应用运行逻辑只改reports/compose.ts：catch-up遇到0合格条目保留缺刊等待；其他写入错误仍失败。

Grok22:12要求收窄独立包：日志模板/规范补正不是报告修复的运行依赖，已由PR297保留在主分支，现从独立包移出。原930c5c2d候选不再发布，其运行40149621429已主动取消，不使用未完成回执或制品；没有生产变化。

相对64b2完整差异仅以下5个文件：

| 文件 | 内容与用途 |
|---|---|
| packages/backend/src/reports/compose.ts | 唯一运行改动：缺资料等待，不抛整轮补刊异常 |
| tests/report-schedule.test.ts | 实际写入失败、恢复、缺刊等待与持久状态回归 |
| packages/backend/README.md | 内部报告行为说明 |
| tasks/TASK-0428.md | 同一卡的移植与交付记录 |
| docs/acceptance/phase-one-migration-20261023/priority-report-followup-release-20261024.md | 本份具体范围与发布准备 |

本包不包含后续主分支的评分/词表/国家主题查询、群启用或其他模块迁移，无数据库迁移、提示词/模型/来源配置变化。国家主题覆盖不足继续阻止该迁移批次上线，不阻塞这份独立报告修复准备。

## 验证与制品

主线实现与PR299一致；旧线上基线尚未接入新事务事件，所以故障回归用隔离测试库的临时CHECK约束制造真实写入失败，测试结束清除。核对当前日报优先、失败回滚、去掉故障后恢复、旧刊仍incomplete、补刊记录retry/result=waiting及次数/退避不变、0新增模型回执。报告schedule/catch-up-recovery/alerts/quiet四组18项通过。

提交前quick、独立审阅、准确发布SHA的完整verify、同一受测镜像与源码包随后分别登记。复用已授权的现有verify workflow_dispatch，未启用新Actions、runner或服务。不会拿PR299的完整回执替代本包回执。

本地提交前quick10阶段已通过，18项定向回归日志为report-priority-backport-focused-20261024.log，quick日志为report-priority-backport-check-20261024.log；上述文件位于受限.verify目录，不提交环境记录。

移出日志规范后，运行改动和故障回归与930c5c2d字节相同；收窄后的quick10通过（report-priority-narrow-check-20261024.log）。完整验证使用已有TASK0428限定范围，制品仍绑定收窄后的准确SHA，不能复用旧候选结果。

## 生产操作准备

正式制品就绪后列出准确SHA、回执、备份、容量、操作窗口及回退依据，交Chris决定。原7e24d59/64b2部署授权不被本文件扩大。正式操作仍使用deploy/production-release.sh，全程持原release.lock，先备份和核对现役、来源/历史记录/人工控制；无迁移，不启用来源/群，不触发手工模型、补刊或通知。

成功切换后先核对站点与数据库健康，再等自然半小时巡检：当日刊正常、catch-up不再因三期旧刊缺料而failed、2025-W05/W31/W44仍未刊且保留等待记录。9月月报保持原首发和revision1。正常巡检未到时单列，不能由本地通过推定已上线生效。

保留现役及必要恢复副本；恢复与质量未接受前不清理。失败按正式入口恢复旧程序，不回灌旧数据库覆盖新内容。原10月25日12:00只读复核保持；若实际部署改变观察窗口，另记录真实起点，不把时间尚不足写成24小时验收。

## 回到主线的核对

报告修复已通过PR299进入main a0ee8ffcfb23dbbe1b93ffd7fc622cfeca566f5c。下一次统一发布必须选择包含该提交及现役64b2的main后代，检查等待分支和原恢复/人工控制未回退，并对那个最终SHA取得full及同一受测制品。不把这个发布分支整体合回main，也不重复移植已经合入的修复；最终main SHA在当次真实发布包准备好时固定，不预填未来提交。国别覆盖、词表和其他原发布前置不因此次独立发布解除。
