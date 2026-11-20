# 法规线新写入侧（计划 2.13）

这里放法规线重写后的写入侧：取得原件之后的提取、条款、变化与发布前判定。现在只有这份说明，还没有代码；分区见上级 README“代码分区”。

- **可以引用**：`../core/` 里的确定性代码、`../publication/policy-provisions-project.ts`、`../pilot.ts`，以及法规模块已经在用的引擎入口（`@amp/backend/...`）。
- **不引用旧写入侧**：`../domain/**`、`../jobs.ts`、`../provider.ts`。直接引用会被 `scripts/verify/legacy-zones.ts`（遗留区 `policy-write`）拦下。检查只看直接引用：`core/provision-store.ts` 的 `structurePolicyRevision` 目前仍调用旧的正文提取，这处接缝切开之前不要经它取正文。
- **不写旧写入侧的表**：新的提取结果不写 `policy.document_extractions`，条款结果不写 `policy.revision_structures` 和 `policy.revision_provisions`。现行发布读这几张表（`core/provision-store.ts` 的 `readCachedPolicyText`、`readPolicyProvisions`），写进去就会改动读者看到的内容。新写入侧用自己的新表。
- **数据归属**：带 SQL 的新文件在 `scripts/verify/data-ownership-map.json` 的 `fileModules` 里登记归属：写 `policy.*` 表登记 `policy`，写 `publication.policy_*` 表登记 `publication`。
