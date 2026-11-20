# 法规线新写入侧（计划 2.13）

这里放法规线重写后的写入侧：取得原件之后的提取、条款、变化与发布前判定。现在只有这份说明，还没有代码；分区见上级 README“代码分区”。

- **可以引用**：`../core/` 里的确定性代码、`../publication/policy-provisions-project.ts`、`../pilot.ts`，以及法规模块已经在用的引擎入口（`@amp/backend/...`）。其中几个文件会间接带进旧代码，见下一条。
- **不引用旧写入侧**：`../domain/**`、`../jobs.ts`、`../provider.ts`。直接引用会被 `scripts/verify/legacy-zones.ts`（遗留区 `policy-write`）拦下，但检查只看直接引用；一个文件不在遗留区引用方名单上，只说明它不直接引用旧写入侧。间接路线：`core/provision-store.ts` 直接引用旧的正文提取，只为它的配方名 `EXTRACTION_RECIPE`（两个读缓存的函数用），`../publication/policy-provisions-project.ts`、`../publication/policy-regate.ts` 经它碰到；`core/originals.ts`、`core/metadata.ts`、`core/public-state.ts`、`core/automation-profile.ts`、`core/identity-fields.ts` 经引擎里的法规转发 `packages/backend/src/policy/fallback-quality.ts` 间接碰到 `domain/fallback-quality.ts`，读取接口 `../read.ts`、`../relations.ts`、`../reports.ts`、`../compare.ts`、`../http.ts` 经 `core/public-state.ts` 也走这条路，`../publication/policies-project.ts` 经 `core/metadata.ts` 也是。路线明细和开工前要定的事见上级 README“代码分区”。不要经 `structurePolicyRevision`（现在 `../domain/structure.ts`）取正文。
- **不写旧写入侧的表**：新的提取结果不写 `policy.document_extractions`，条款结果不写 `policy.revision_structures` 和 `policy.revision_provisions`。现行发布读这几张表（`core/provision-store.ts` 的 `readCachedPolicyText`、`readPolicyProvisions`），写进去就会改动读者看到的内容。新写入侧用自己的新表。
- **数据归属**：带 SQL 的新文件在 `scripts/verify/data-ownership-map.json` 的 `fileModules` 里登记归属：写 `policy.*` 表登记 `policy`，写 `publication.policy_*` 表登记 `publication`。
