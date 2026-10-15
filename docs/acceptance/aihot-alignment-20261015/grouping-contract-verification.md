# 归组诊断契约本地验证

范围：TASK-0360 的私有归组诊断、队列概览、兼容运行响应和生成客户端。

本地 `pnpm check` 已通过，原始日志位于执行工作区 `.verify/grouping-contract-review-check.log`。契约单元验证覆盖旧响应没有 grouping 字段仍兼容、未知状态不推定完成、完成必须绑定当前材料修订及明确价值判断、列表计数边界。审查补充要求按回执恢复的项目必须携带回执编号，相应回归记录在 `.verify/grouping-contract-review-tests.log`。

状态为 locally_verified：不表示完整验证、合并或上线。最终提交完整 make verify 回执以 PR 的独立执行器记录为准；消费者随后接入统一版本，集中验收后才部署。
