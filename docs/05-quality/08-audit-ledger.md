# 审计与问题资产入口

当前问题的唯一机器台账是 [issues.jsonl](issues.jsonl)，一行一个JSON对象，可按编号、模块、任务或根因搜索。最近一次报告：[2026-10-13审计](audits/2026-10-13/REPORT.md)。日期按Owner所在地America/Catamarca；产品刊期仍按北京时间。

## 各类记录的职责

- `record_type=finding`：当前有依据的BUG、体验或协作问题；严重度和可信度分开。
- `record_type=lead`：待核查线索，不得作为已确认漏洞发布或自动修复。
- `record_type=coverage_gap`：未执行的安全扫描、运行验收等，不代表发现了漏洞。
- `record_type=history`：历史发现与修复证据索引。50项旧整改保留原ID别名及原快照链接；未逐项重验的不能批量改为open或closed。
- [PIT目录](02-pitfalls.md)保留历史107条经验，不是当前漏洞数；同根因再次发生时按原模板提炼防复发规则并关联本台账。
- `tasks/TASK-*.md`负责实施范围；`docs/acceptance/`负责验证摘要；日期审计报告是当时快照，台账负责后续状态。不要再维护第二份手写“当前状态总表”。

## Agent使用方式

1. 查同模块、症状、aliases、task，先核本次基线；已有修复或在途任务就关联，不重复立项。
2. `evidence`中的路径、行号绑定`baseline`。变更后重新核验，不能把旧行号或历史结论直接当现状。
3. 实施前创建符合项目写权规则的任务卡；台账的`owner_lane`仅为建议责任，不授予写权，也不替代契约卡、预算或发布授权。
4. 按`acceptance`做最小必要回归，分别填修复提交、离线验证、整合回执、线上行为及质量证据。修好了就更新原记录，保留history事件，不删除编号。
5. 发现误报填排除原因/证据；重复项写`duplicate_of`；接受风险必须引用Owner决定，不能自行关闭。

## 字段与状态

新finding/lead必有：`id,record_type,title,kind,severity,confidence,status,baseline,owner_lane,impact,trigger,evidence,specs,fix,acceptance,related_tasks,verification,history`。`evidence`包含`path,line`；上下文统一在审计coverage中，必要时单项写ref。`verification`分开记录`local,integration,live,quality`，缺失写null，不写pass。

状态通常为`candidate → confirmed → in_progress → fixed → verified → closed`；也可`duplicate / not_reproduced / accepted_risk / reopened`。候选可被排除；严重度P1并不自动表示已经证实。`historical`只用于历史导入，`blocked`只用于覆盖缺口。

`fixed`须有修复SHA；`verified`须有绑定版本的回归证据；用户线上行为的`closed`须有相应线上证据，不能把合并或CI当上线。纯文档/校验器问题写清线上验收不适用的原因，不强行部署。history导入保留`historical_status`，本次抽样只补`current_review`，不改写原事实。

每次更新至少检查：JSON可逐行解析、ID唯一、引用路径存在、状态必要证据非空、报告统计来自台账、已有任务未重复分配。现阶段这些是维护约定；尚未接入强制自动门禁，不宣称已自动执行。

## 证据与公开边界

仓库是公开仓库。仅登记可公开的代码位置、合成复现、脱敏验证摘要、版本、摘要哈希与受控证据定位；不提交秘密、真实用户反馈、个人资料或生产原始记录。未修复安全漏洞的可直接攻击细节保存在受控位置，公开台账只留ID、影响、责任与状态。扫描未启动、未测、无法复现须原样记录；无发现不能推出没有漏洞。

首次建账任务：[TASK-0352](../../tasks/TASK-0352.md)。本次只审计与登记，没有修复台账中的产品问题。
